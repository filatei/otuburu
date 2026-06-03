'use client'

/**
 * Transfer modal — moves USD between {Savings, trading accounts}.
 *
 * Flow:
 *   1. Pick From (Savings or one of your real accounts)
 *   2. Pick To   (everything except whatever you picked as From)
 *   3. Enter amount (with Max shortcut + free-margin preview when source is
 *      a trading account)
 *   4. Confirm → POST /wallet/transfers with an idempotency key so a
 *      double-tap or network blip can't double-debit
 *
 * Why no demo accounts in the picker: demo balances aren't real funds, so
 * moving them in/out of Savings would be meaningless. Demo accounts are
 * also excluded server-side via the JWT's account ownership check.
 *
 * Why no account ↔ account UI restriction here: the backend supports it
 * (account-to-account is one of the three explicit transfer paths in
 * transfers.go), and pros with multiple real accounts will want it.
 */

import { useEffect, useMemo, useState } from 'react'
import type { AuthUser } from '@/hooks/useAuth'
import type { UserAccount } from '@/types'
import { kindLabel, kindScale } from '@/types'
import { authFetch } from '@/lib/api'
import BottomSheet from './BottomSheet'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface Props {
  open:    boolean
  onClose: () => void
  user:    AuthUser
  /** Called after a successful transfer so the parent can refresh balances
   *  + close the sheet. Receives the transfer's status so callers can
   *  distinguish "completed" from any future async/pending state. */
  onTransferred?: (status: string) => void
}

/** A picker option — either Savings (synthetic id 'savings') or a real account. */
type Leg = { kind: 'savings' } | { kind: 'account'; account: UserAccount }

/** Map a real-account leg to the engine free_margin we fetched. Savings
 *  doesn't have free_margin (no positions). */
type FreeMarginMap = Record<string, { freeMargin: number; balance: number }>

export default function TransferModal({ open, onClose, user, onTransferred }: Props) {
  // Real accounts only — demo can't transfer to/from anything meaningful.
  const realAccounts = useMemo(
    () => (user.accounts ?? []).filter(a => a.type === 'real'),
    [user.accounts],
  )

  const [from,   setFrom]   = useState<Leg | null>(null)
  const [to,     setTo]     = useState<Leg | null>(null)
  const [amount, setAmount] = useState('')
  const [busy,   setBusy]   = useState(false)
  const [err,    setErr]    = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Free-margin lookups for the real accounts. The transfer endpoint
  // re-checks server-side, but the UI shows a preview so users know what
  // they can move before they hit Confirm.
  const [freeMargin, setFreeMargin] = useState<FreeMarginMap>({})

  // Reset state every time the sheet opens — stale picker state from a
  // prior session is the most common "this looks weird" bug otherwise.
  useEffect(() => {
    if (!open) return
    setFrom(null); setTo(null); setAmount(''); setErr(null); setSuccess(null)

    // Prime free_margin for every real account in one round-trip.
    if (realAccounts.length === 0) return
    const ids = realAccounts.map(a => a.id).join(',')
    authFetch(`${API_BASE}/api/accounts?ids=${ids}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.accounts) return
        const map: FreeMarginMap = {}
        // proto-JSON shape: { accounts: [{ id, balance, freeMargin, ... }] }
        for (const a of data.accounts as Array<{ id: string; balance: number; freeMargin: number }>) {
          map[a.id] = { freeMargin: a.freeMargin ?? 0, balance: a.balance ?? 0 }
        }
        setFreeMargin(map)
      })
      .catch(() => {/* preview is best-effort; server still enforces */})
  }, [open, realAccounts])

  // Source max — what the user can legally move. For savings, the savings
  // balance; for an account, the free margin (= balance − used margin).
  const sourceMax = useMemo(() => {
    if (!from) return 0
    if (from.kind === 'savings') return user.savings_balance ?? 0
    return freeMargin[from.account.id]?.freeMargin ?? from.account.balance
  }, [from, user.savings_balance, freeMargin])

  const amountNum = parseFloat(amount) || 0
  const overMax = amountNum > sourceMax + 1e-6
  const canSubmit = !!from && !!to && amountNum > 0 && !overMax && !busy

  // Cross-kind conversion preview: how much the destination receives
  // given the user's amount in source-units. scale(savings) = 1.
  const sourceScale = from?.kind === 'savings' ? 1 : kindScale(from?.account.kind)
  const destScale   = to?.kind === 'savings'   ? 1 : kindScale(to?.account.kind)
  const destReceives = amountNum * (destScale / sourceScale)
  const isCrossKind = !!from && !!to && sourceScale !== destScale

  const handleSubmit = async () => {
    if (!from || !to) return
    setBusy(true); setErr(null)
    try {
      const body = {
        from: from.kind === 'savings'
          ? { kind: 'savings' as const }
          : { kind: 'account' as const, id: from.account.id },
        to: to.kind === 'savings'
          ? { kind: 'savings' as const }
          : { kind: 'account' as const, id: to.account.id },
        amount: amountNum,
        // crypto.randomUUID is on every browser we target (modern Chrome /
        // Safari ≥15.4 / Firefox ≥95). If a node ever lands without it,
        // fall back to a timestamp+random combo so we still get dedup.
        idempotency_key: typeof crypto?.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }
      const res = await authFetch(`${API_BASE}/wallet/transfers`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(data.error ?? `transfer failed (${res.status})`)
        return
      }
      setSuccess(`Transferred $${amountNum.toFixed(2)}`)
      onTransferred?.(data.status ?? 'completed')
      // Auto-close after a brief success flash so the user sees the
      // confirmation without an extra tap.
      setTimeout(onClose, 900)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'network error')
    } finally {
      setBusy(false)
    }
  }

  const allLegs: Leg[] = useMemo(
    () => [{ kind: 'savings' }, ...realAccounts.map(a => ({ kind: 'account', account: a } as Leg))],
    [realAccounts],
  )

  return (
    <BottomSheet open={open} onClose={onClose} title="Transfer">
      <div className="p-4 space-y-4">
        {/* From picker */}
        <div>
          <p className="text-[10px] text-dim uppercase tracking-wider mb-2">From</p>
          <LegPicker
            legs={allLegs}
            value={from}
            onChange={leg => {
              setFrom(leg)
              // Clear To if it now matches From — keeps the picker valid.
              if (to && legsEqual(leg, to)) setTo(null)
            }}
            getBalance={getLegBalance(user, freeMargin)}
            disabledLeg={null}
          />
        </div>

        {/* To picker — same options minus whatever From is */}
        <div>
          <p className="text-[10px] text-dim uppercase tracking-wider mb-2">To</p>
          <LegPicker
            legs={allLegs}
            value={to}
            onChange={setTo}
            getBalance={getLegBalance(user, freeMargin)}
            disabledLeg={from}
          />
        </div>

        {/* Amount */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-[10px] text-dim uppercase tracking-wider">Amount (USD)</p>
            {from && (
              <button
                type="button"
                onClick={() => setAmount(sourceMax.toFixed(2))}
                className="text-[10px] text-brand hover:text-brand/80 font-semibold"
              >
                Max ${sourceMax.toFixed(2)}
              </button>
            )}
          </div>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="w-full px-3 py-3 bg-surface border border-border rounded-lg text-text text-lg num focus:outline-none focus:border-brand"
          />
          {from?.kind === 'account' && freeMargin[from.account.id] && (
            <p className="text-[10px] text-dim mt-1.5 leading-relaxed">
              Free margin ${freeMargin[from.account.id].freeMargin.toFixed(2)}{' '}
              of ${freeMargin[from.account.id].balance.toFixed(2)} balance.
              Open positions reserve the difference.
            </p>
          )}
          {isCrossKind && amountNum > 0 && (
            <p className="text-[10px] text-brand mt-1.5 leading-relaxed">
              ↳ Destination receives <span className="num font-semibold">${destReceives.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              {to?.kind === 'account' && kindLabel(to.account.kind) && (
                <> {kindLabel(to.account.kind).toLowerCase()}-units</>
              )}
            </p>
          )}
          {overMax && (
            <p className="text-[10px] text-down mt-1.5 font-medium">
              Exceeds available ${sourceMax.toFixed(2)}.
            </p>
          )}
        </div>

        {/* Status + submit */}
        {err && (
          <div className="px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-down text-xs">
            {err}
          </div>
        )}
        {success && (
          <div className="px-3 py-2 rounded-lg bg-up/10 border border-up/30 text-up text-xs">
            ✓ {success}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-3 rounded-lg bg-brand text-black font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Transferring…' : 'Confirm transfer'}
        </button>

        <p className="text-[10px] text-dim leading-relaxed text-center">
          Transfers are instant. Withdrawals must originate from Savings — move
          funds there first, then use Withdraw.
        </p>
      </div>
    </BottomSheet>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function legsEqual(a: Leg | null, b: Leg | null): boolean {
  if (!a || !b) return false
  if (a.kind === 'savings' && b.kind === 'savings') return true
  if (a.kind === 'account' && b.kind === 'account') return a.account.id === b.account.id
  return false
}

/** Closes over user + freeMargin so the LegPicker can render a balance hint
 *  for each option without knowing the data shape itself. */
function getLegBalance(user: AuthUser, freeMargin: FreeMarginMap) {
  return (leg: Leg): number => {
    if (leg.kind === 'savings') return user.savings_balance ?? 0
    return freeMargin[leg.account.id]?.freeMargin ?? leg.account.balance
  }
}

// ── LegPicker ────────────────────────────────────────────────────────────────

interface LegPickerProps {
  legs:        Leg[]
  value:       Leg | null
  onChange:    (leg: Leg) => void
  getBalance:  (leg: Leg) => number
  /** When set, the matching leg is rendered as disabled — used to prevent
   *  picking the same leg for From and To. */
  disabledLeg: Leg | null
}

function LegPicker({ legs, value, onChange, getBalance, disabledLeg }: LegPickerProps) {
  return (
    <div className="space-y-1.5">
      {legs.map(leg => {
        const isSelected = legsEqual(value, leg)
        const isDisabled = legsEqual(disabledLeg, leg)
        const label = leg.kind === 'savings' ? 'Savings' : leg.account.label
        const sub = leg.kind === 'savings'
          ? 'Withdrawals only · no trading'
          : 'Trading account'
        const balance = getBalance(leg)
        return (
          <button
            key={leg.kind === 'savings' ? 'savings' : leg.account.id}
            type="button"
            disabled={isDisabled}
            onClick={() => onChange(leg)}
            className={[
              'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-colors',
              isSelected
                ? 'bg-brand/10 border-brand/40 text-text'
                : 'bg-surface border-border text-text hover:border-brand/30',
              isDisabled ? 'opacity-40 cursor-not-allowed' : '',
            ].join(' ')}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-1.5">
                {leg.kind === 'savings' && <span>🏛️</span>}
                <span className="truncate">{label}</span>
                {leg.kind === 'account' && kindLabel(leg.account.kind) && (
                  <span className="text-[8px] font-bold tracking-wider px-1 py-0.5 rounded bg-brand/15 text-brand shrink-0">
                    {kindLabel(leg.account.kind)}
                  </span>
                )}
              </p>
              <p className="text-[10px] text-dim leading-tight">{sub}</p>
            </div>
            <p className="text-xs text-dim num shrink-0 ml-3">
              ${balance.toFixed(2)}
            </p>
          </button>
        )
      })}
    </div>
  )
}
