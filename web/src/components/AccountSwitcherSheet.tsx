'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { UserAccount } from '@/types'
import { accountTypeBadge, isTradeable } from '@/types'
import { createAccountApi } from '@/lib/api'
import BottomSheet from './BottomSheet'

/** Kinds the user can pick when creating a real account. Excludes 'demo'
 *  (auto-created by /auth/google, not user-spawned). */
type CreatableKind = 'real_standard' | 'real_cent' | 'real_micro'

/**
 * AccountSwitcherSheet — list the user's real accounts, switch between
 * them, or create a new one. Phase 2 of the multi-account UX.
 *
 * The demo account is intentionally excluded here — switching to demo is
 * done via the header's DEMO/REAL chip. This sheet is exclusively for
 * picking which real account is active or creating another one.
 */

interface Props {
  open:          boolean
  onClose:       () => void
  accounts:      UserAccount[]         // every account the user owns
  selectedId:    string | null         // currently active real account
  onSelect:      (id: string) => void
  onCreated:     (newId: string, token: string) => void  // called after POST /wallet/accounts
}

export default function AccountSwitcherSheet({
  open, onClose, accounts, selectedId, onSelect, onCreated,
}: Props) {
  // Tradeable = synthetic real + broker (Sprint 5.9d). Demo lives behind
  // the header's DEMO/REAL toggle; this sheet is for picking which
  // *non-demo* account is active. Broker accounts appear interleaved with
  // a BROKER badge — for v1 users typically have 0-1 brokers, so a
  // separate "Linked brokers" section would be more chrome than signal.
  // Sort: synthetic real first, then broker, then by creation order
  // (input order). Keeps the most-used accounts at the top while still
  // exposing brokers prominently.
  const tradeable = accounts
    .filter(isTradeable)
    .slice()
    .sort((a, b) => {
      if (a.type === b.type) return 0
      return a.type === 'real' ? -1 : 1
    })
  // 'reals' is preserved as the count for the "n/10" indicator on the
  // create button — broker accounts don't count against the cap because
  // they're external-broker-backed, not synthetic.
  const reals = accounts.filter(a => a.type === 'real')

  const [creating, setCreating]   = useState(false)
  const [newLabel, setNewLabel]   = useState('')
  const [newKind,  setNewKind]    = useState<CreatableKind>('real_standard')
  const [busy,     setBusy]       = useState(false)
  const [error,    setError]      = useState<string | null>(null)

  const reset = () => {
    setCreating(false)
    setNewLabel('')
    setNewKind('real_standard')
    setBusy(false)
    setError(null)
  }

  const handleCreate = async () => {
    const label = newLabel.trim()
    if (!label) { setError('Give your account a name'); return }
    setBusy(true)
    setError(null)
    try {
      const { account, token } = await createAccountApi(label, newKind)
      onCreated(account.id, token)
      reset()
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to create account')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={() => { reset(); onClose() }} title="Accounts">
      <ul className="divide-y divide-border">
        {tradeable.map(a => {
          const isBroker = a.type === 'broker'
          const badge    = accountTypeBadge(a)
          // Broker initial = 🔗 instead of the first letter — instantly
          // distinguishes it in the list even before the user reads the
          // BROKER pill. Selected state still overrides with ✓ as for
          // synthetic accounts. Keeps single-glance scanability.
          const avatar = a.id === selectedId
            ? '✓'
            : isBroker ? '🔗' : a.label[0]?.toUpperCase()
          return (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => { onSelect(a.id); onClose() }}
                className="w-full flex items-center gap-3 px-5 py-3 active:bg-surface/70 hover:bg-surface/40 text-left"
              >
                <span className={clsx(
                  'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                  a.id === selectedId ? 'bg-brand text-black'
                    : isBroker      ? 'bg-up/10 text-up border border-up/30'
                    :                 'bg-surface text-dim border border-border',
                )}>
                  {avatar}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-text text-sm font-semibold truncate">{a.label}</span>
                    {badge && (
                      <span className={clsx(
                        'text-[8px] font-bold tracking-wider px-1 py-0.5 rounded',
                        // BROKER uses up-coloured (green) pill so it reads as
                        // "live broker" not "synthetic scaling". CENT/MICRO
                        // keep the brand-yellow they had pre-5.9d.
                        isBroker ? 'bg-up/15 text-up' : 'bg-brand/15 text-brand',
                      )}>
                        {badge}
                      </span>
                    )}
                  </span>
                  <span className="block text-dim text-[11px] num">
                    ${a.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    {isBroker && a.balance === 0 && (
                      <span className="text-dim/60 ml-1.5 italic">syncing…</span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {/* Create section — collapsed as a single tappable row by default;
          expands to a name input + Create button when the user taps. */}
      <div className="border-t border-border">
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-3 px-5 py-3 active:bg-surface/70 hover:bg-surface/40 text-left"
          >
            <span className="w-8 h-8 rounded-full bg-brand/15 text-brand flex items-center justify-center text-base font-bold shrink-0">
              +
            </span>
            <span className="text-text text-sm font-semibold">New account</span>
            <span className="ml-auto text-dim text-[11px]">{reals.length}/10</span>
          </button>
        ) : (
          <div className="px-5 py-4 space-y-3">
            <label className="block text-dim text-[10px] uppercase tracking-wider">Account name</label>
            <input
              autoFocus
              type="text"
              maxLength={40}
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              placeholder="e.g. Strategy A"
              className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-text text-sm focus:outline-none focus:border-brand/60"
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />

            {/* Kind picker — Standard / Cent / Micro. Three-up tile picker
                so the trade-offs (deposit feel, lot size) are visible at
                a glance. Cent/micro are PSYCHOLOGICAL leverage — same
                broker risk per real-USD as standard. */}
            <label className="block text-dim text-[10px] uppercase tracking-wider pt-1">Account type</label>
            <div className="grid grid-cols-3 gap-2">
              {(['real_standard', 'real_cent', 'real_micro'] as const).map(k => {
                const selected = newKind === k
                const tile = k === 'real_standard'
                  ? { name: 'Standard', sub: '$1 = $1',     mult: '1×' }
                  : k === 'real_cent'
                  ? { name: 'Cent',     sub: '$10 → $1,000', mult: '×100' }
                  : { name: 'Micro',    sub: '$1 → $1,000',  mult: '×1000' }
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setNewKind(k)}
                    className={clsx(
                      'p-2.5 rounded-lg border text-left transition-colors',
                      selected
                        ? 'bg-brand/10 border-brand/50'
                        : 'bg-surface border-border hover:border-brand/30',
                    )}
                  >
                    <p className="text-text text-xs font-bold">{tile.name}</p>
                    <p className="text-dim text-[9px] mt-0.5">{tile.sub}</p>
                    <p className={clsx(
                      'text-[10px] num font-semibold mt-1',
                      selected ? 'text-brand' : 'text-dim/80',
                    )}>{tile.mult}</p>
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-dim/80 leading-snug">
              Cent / Micro multiply your deposit nominally so smaller real
              amounts feel like larger trading accounts. Same broker risk;
              same spreads. You can't change kind after creation.
            </p>

            {error && <p className="text-down text-xs">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="flex-1 py-2 rounded-lg text-xs font-semibold bg-surface border border-border text-dim hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={busy || !newLabel.trim()}
                className="flex-1 py-2 rounded-lg text-xs font-bold bg-brand text-black disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
