'use client'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { AuthUser } from '@/hooks/useAuth'
import type { UserAccount } from '@/types'
import { authFetch } from '@/lib/api'
import { NIGERIAN_BANKS } from '@/lib/nigerianBanks'
import BottomSheet from './BottomSheet'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

const MIN_NGN_WITHDRAW_USD = 10

interface Props {
  open:        boolean
  onClose:     () => void
  user:        AuthUser
  /** Which real account is currently selected — defaults the withdrawal
   *  to this one but the user can switch via a dropdown when they own
   *  more than one. */
  activeAccountId: string | null
  /** Called after a successful withdrawal request so the parent can
   *  refresh balances. */
  onSubmitted: () => void
}

type Channel = 'usdt' | 'ngn'

const MIN_USDT = 10

export default function WithdrawSheet({ open, onClose, user, activeAccountId, onSubmitted }: Props) {
  const [channel, setChannel] = useState<Channel>('usdt')
  const reals = (user.accounts ?? []).filter(a => a.type === 'real')
  const [accountId, setAccountId] = useState<string>(activeAccountId ?? user.account_id ?? '')

  // Whenever the parent's selection or accounts list changes, sync ours so
  // the sheet opens defaulted to the user's current account.
  if (activeAccountId && accountId !== activeAccountId && !reals.some(a => a.id === accountId)) {
    setAccountId(activeAccountId)
  }
  const selected = reals.find(a => a.id === accountId)

  return (
    <BottomSheet open={open} onClose={onClose} title="Withdraw">
      <div className="border-b border-border">
        <ChannelTab label="USDT (TRC20)"  active={channel === 'usdt'} onClick={() => setChannel('usdt')} />
        <ChannelTab label="NGN Bank"      active={channel === 'ngn'}  onClick={() => setChannel('ngn')}  />
      </div>

      {channel === 'usdt' && (
        <UsdtWithdrawForm
          accountId={accountId}
          accounts={reals}
          balance={selected?.balance ?? 0}
          onAccountChange={setAccountId}
          onSubmitted={() => { onSubmitted(); onClose() }}
        />
      )}

      {channel === 'ngn' && (
        <NgnWithdrawForm
          accountId={accountId}
          accounts={reals}
          balance={selected?.balance ?? 0}
          onAccountChange={setAccountId}
          onSubmitted={() => { onSubmitted(); onClose() }}
        />
      )}
    </BottomSheet>
  )
}

// ─── USDT form ────────────────────────────────────────────────────────────────

function UsdtWithdrawForm({ accountId, accounts, balance, onAccountChange, onSubmitted }: {
  accountId:       string
  accounts:        UserAccount[]
  balance:         number
  onAccountChange: (id: string) => void
  onSubmitted:     () => void
}) {
  const [amount,  setAmount]  = useState('')
  const [address, setAddress] = useState('')
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const usd = parseFloat(amount)
  const validAmount = Number.isFinite(usd) && usd >= MIN_USDT && usd <= balance
  // Light client-side TRC20 sanity check. The on-chain broadcast is the real
  // arbiter — we just catch obvious paste-fails here.
  const validAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim())

  const handleSubmit = async () => {
    if (!validAmount || !validAddress) return
    if (!confirm) { setConfirm(true); return }
    setBusy(true)
    setErr(null)
    try {
      const res = await authFetch(`${API_BASE}/wallet/withdraw`, {
        method: 'POST',
        body:   JSON.stringify({
          amount:     usd,
          address:    address.trim(),
          account_id: accountId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Withdrawal request failed')
      onSubmitted()
    } catch (e: any) {
      setErr(e?.message ?? 'Withdrawal failed')
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-5 space-y-4">
      {/* Account picker — only shown when the user has more than one real
          account, otherwise it's noise. */}
      {accounts.length > 1 && (
        <div>
          <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
            From account
          </label>
          <select
            value={accountId}
            onChange={e => onAccountChange(e.target.value)}
            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-text text-sm focus:outline-none focus:border-brand/60"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.label} — ${a.balance.toFixed(2)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Amount */}
      <div>
        <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
          Amount (USDT)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim font-semibold">$</span>
          <input
            type="number"
            min={MIN_USDT}
            step="1"
            placeholder={String(MIN_USDT)}
            value={amount}
            onChange={e => { setAmount(e.target.value); setConfirm(false) }}
            className="w-full bg-surface border border-border rounded-xl pl-7 pr-20 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
          />
          <button
            type="button"
            onClick={() => { setAmount(String(Math.floor(balance * 100) / 100)); setConfirm(false) }}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-bold rounded bg-brand/15 text-brand"
          >
            MAX
          </button>
        </div>
        <p className="text-dim text-xs mt-1">
          Available: ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Min ${MIN_USDT}
        </p>
      </div>

      {/* Address */}
      <div>
        <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
          TRC20 address
        </label>
        <input
          type="text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="T..."
          value={address}
          onChange={e => { setAddress(e.target.value); setConfirm(false) }}
          className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-text text-xs font-mono focus:outline-none focus:border-brand/60"
        />
        {address && !validAddress && (
          <p className="text-down text-xs mt-1">Address doesn&apos;t look like a TRC20 address (must start with T, 34 chars).</p>
        )}
      </div>

      {/* Disclosures */}
      <div className="bg-surface/60 rounded-xl px-3 py-2.5 border border-border/60 space-y-1">
        <p className="text-[11px] text-dim leading-relaxed">
          <span className="text-text font-semibold">Important:</span>{' '}
          Only send to a TRC20 USDT address. Wrong network = permanent loss.
          Withdrawals are reviewed within 24 hours; you&apos;ll get an email when funds leave.
        </p>
      </div>

      {err && (
        <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
          {err}
        </div>
      )}

      {/* Submit (two-step confirm) */}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!validAmount || !validAddress || busy}
        className={clsx(
          'w-full py-3 text-sm font-bold rounded-xl transition-colors',
          confirm
            ? 'bg-down hover:bg-down/90 text-white'
            : 'bg-brand hover:bg-brand/90 text-black',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        {busy
          ? 'Submitting…'
          : confirm
            ? `Confirm: send $${usd.toFixed(2)} to ${address.slice(0, 6)}…${address.slice(-4)}`
            : 'Review withdrawal →'}
      </button>
    </div>
  )
}

// ─── NGN bank-payout form ───────────────────────────────────────────────────
//
// Two-stage UX:
//   1. Pick bank → enter 10-digit account number → auto-resolve fires
//      against /wallet/ngn/resolve and shows the verified holder name. This
//      catches typos and wrong-bank picks BEFORE any money moves.
//   2. Enter USD amount → preview NGN equivalent at current customer rate
//      (from /payments/rates) → two-step confirm matching the USDT form's
//      pattern.
//
// The customer rate displayed is the live snapshot from RateMap; the actual
// debit happens against the rate locked server-side at submit time, so the
// number on screen is "approximate, refreshes every poll". A short
// disclosure makes that explicit.

function NgnWithdrawForm({ accountId, accounts, balance, onAccountChange, onSubmitted }: {
  accountId:       string
  accounts:        UserAccount[]
  balance:         number
  onAccountChange: (id: string) => void
  onSubmitted:     () => void
}) {
  // Form state
  const [bankCode,     setBankCode]     = useState('')
  const [acctNum,      setAcctNum]      = useState('')
  const [holderName,   setHolderName]   = useState<string | null>(null)
  const [resolveBusy,  setResolveBusy]  = useState(false)
  const [resolveErr,   setResolveErr]   = useState<string | null>(null)

  const [amount,    setAmount]    = useState('')
  const [confirm,   setConfirm]   = useState(false)
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  // Live customer NGN/USD rate from /payments/rates. Updates every ~hour
  // on the server; we refetch on mount so the modal is current.
  const [ngnRate, setNgnRate] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/payments/rates`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => {
        if (cancelled) return
        const rate = d?.currencies?.NGN?.customer
        if (typeof rate === 'number' && rate > 0) setNgnRate(rate)
      })
      .catch(() => { /* silent — UI degrades to "rate at submit" copy */ })
    return () => { cancelled = true }
  }, [])

  // Auto-resolve once we have a bank and a 10-digit account number. NUBAN
  // accounts are always exactly 10 digits; anything else is a typo. We
  // debounce by checking length before firing.
  useEffect(() => {
    if (!bankCode || acctNum.length !== 10) {
      setHolderName(null)
      setResolveErr(null)
      return
    }
    let cancelled = false
    setResolveBusy(true)
    setResolveErr(null)
    setHolderName(null)
    setConfirm(false)
    authFetch(`${API_BASE}/wallet/ngn/resolve?bank_code=${bankCode}&account_number=${acctNum}`)
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
      .then(d => { if (!cancelled) setHolderName(d.account_name) })
      .catch((e: { error?: string }) => {
        if (!cancelled) setResolveErr(e?.error ?? 'Could not verify account')
      })
      .finally(() => { if (!cancelled) setResolveBusy(false) })
    return () => { cancelled = true }
  }, [bankCode, acctNum])

  const usd = parseFloat(amount)
  const validAmount = Number.isFinite(usd) && usd >= MIN_NGN_WITHDRAW_USD && usd <= balance
  const ngnAmount = ngnRate && validAmount ? usd * ngnRate : null
  const ready = bankCode && acctNum.length === 10 && holderName && validAmount && !resolveBusy

  const handleSubmit = async () => {
    if (!ready) return
    if (!confirm) { setConfirm(true); return }
    setBusy(true)
    setErr(null)
    try {
      const res = await authFetch(`${API_BASE}/wallet/withdraw/ngn`, {
        method: 'POST',
        body:   JSON.stringify({
          amount:              usd,
          bank_code:           bankCode,
          bank_account_number: acctNum,
          bank_account_name:   holderName,
          account_id:          accountId,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Withdrawal request failed')
      onSubmitted()
    } catch (e: any) {
      setErr(e?.message ?? 'Withdrawal failed')
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-5 space-y-4">
      {/* Account picker — same conditional as USDT form */}
      {accounts.length > 1 && (
        <div>
          <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
            From account
          </label>
          <select
            value={accountId}
            onChange={e => onAccountChange(e.target.value)}
            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-text text-sm focus:outline-none focus:border-brand/60"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.label} — ${a.balance.toFixed(2)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Bank picker */}
      <div>
        <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
          Bank
        </label>
        <select
          value={bankCode}
          onChange={e => { setBankCode(e.target.value); setConfirm(false) }}
          className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
        >
          <option value="">Select your bank…</option>
          {NIGERIAN_BANKS.map(b => (
            <option key={b.code} value={b.code}>{b.name}</option>
          ))}
        </select>
      </div>

      {/* Account number + resolved name */}
      <div>
        <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
          Account number
        </label>
        <input
          type="tel"
          inputMode="numeric"
          maxLength={10}
          placeholder="10-digit NUBAN"
          value={acctNum}
          onChange={e => {
            // Strip non-digits as the user types — NUBAN is always 10 digits.
            const digits = e.target.value.replace(/\D/g, '').slice(0, 10)
            setAcctNum(digits)
            setConfirm(false)
          }}
          className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-text text-sm font-mono tracking-wider focus:outline-none focus:border-brand/60"
        />
        {/* Resolve state row */}
        <div className="mt-2 min-h-[1.25rem]">
          {resolveBusy && (
            <p className="text-dim text-xs">Verifying account…</p>
          )}
          {resolveErr && !resolveBusy && (
            <p className="text-down text-xs">{resolveErr}</p>
          )}
          {holderName && !resolveBusy && (
            <p className="text-up text-xs font-semibold flex items-center gap-1.5">
              <span>✓</span>
              <span className="truncate">{holderName}</span>
            </p>
          )}
        </div>
      </div>

      {/* Amount in USD with NGN equivalent */}
      <div>
        <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
          Amount (USD)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim font-semibold">$</span>
          <input
            type="number"
            min={MIN_NGN_WITHDRAW_USD}
            step="1"
            placeholder={String(MIN_NGN_WITHDRAW_USD)}
            value={amount}
            onChange={e => { setAmount(e.target.value); setConfirm(false) }}
            className="w-full bg-surface border border-border rounded-xl pl-7 pr-20 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
          />
          <button
            type="button"
            onClick={() => { setAmount(String(Math.floor(balance * 100) / 100)); setConfirm(false) }}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-[10px] font-bold rounded bg-brand/15 text-brand"
          >
            MAX
          </button>
        </div>
        <div className="flex items-baseline justify-between mt-1">
          <p className="text-dim text-xs">
            Available: ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Min ${MIN_NGN_WITHDRAW_USD}
          </p>
          {ngnAmount !== null && (
            <p className="text-text text-xs font-semibold">
              ≈ ₦{ngnAmount.toLocaleString('en-NG', { maximumFractionDigits: 0 })}
            </p>
          )}
        </div>
      </div>

      {/* Disclosures */}
      <div className="bg-surface/60 rounded-xl px-3 py-2.5 border border-border/60 space-y-1">
        <p className="text-[11px] text-dim leading-relaxed">
          <span className="text-text font-semibold">Note:</span>{' '}
          NGN payout shown is approximate — the final rate is locked when you
          tap Confirm and includes a {ngnRate ? '~2%' : 'small'} spread.
          Withdrawals are sent to your bank within a few minutes after
          internal review (up to 1 business day for first withdrawals).
        </p>
      </div>

      {err && (
        <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
          {err}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!ready || busy}
        className={clsx(
          'w-full py-3 text-sm font-bold rounded-xl transition-colors',
          confirm
            ? 'bg-down hover:bg-down/90 text-white'
            : 'bg-brand hover:bg-brand/90 text-black',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        {busy
          ? 'Submitting…'
          : confirm
            ? `Confirm: send $${usd.toFixed(2)} to ${holderName}`
            : 'Review withdrawal →'}
      </button>
    </div>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function ChannelTab({ label, active, onClick, disabled }: {
  label: string; active: boolean; onClick: () => void; disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex-1 py-3 text-xs font-semibold transition-colors border-b-2',
        active
          ? 'border-brand text-brand bg-brand/5'
          : disabled
            ? 'border-transparent text-dim/50 cursor-not-allowed'
            : 'border-transparent text-dim hover:text-text',
      )}
      style={{ width: '50%' }}
    >
      {label}
    </button>
  )
}
