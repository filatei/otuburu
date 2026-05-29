'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { UserAccount } from '@/types'
import { createAccountApi } from '@/lib/api'
import BottomSheet from './BottomSheet'

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
  const reals = accounts.filter(a => a.type === 'real')

  const [creating, setCreating]   = useState(false)
  const [newLabel, setNewLabel]   = useState('')
  const [busy,     setBusy]       = useState(false)
  const [error,    setError]      = useState<string | null>(null)

  const reset = () => {
    setCreating(false)
    setNewLabel('')
    setBusy(false)
    setError(null)
  }

  const handleCreate = async () => {
    const label = newLabel.trim()
    if (!label) { setError('Give your account a name'); return }
    setBusy(true)
    setError(null)
    try {
      const { account, token } = await createAccountApi(label)
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
        {reals.map(a => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => { onSelect(a.id); onClose() }}
              className="w-full flex items-center gap-3 px-5 py-3 active:bg-surface/70 hover:bg-surface/40 text-left"
            >
              <span className={clsx(
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                a.id === selectedId ? 'bg-brand text-black' : 'bg-surface text-dim border border-border',
              )}>
                {a.id === selectedId ? '✓' : a.label[0]?.toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-text text-sm font-semibold truncate">{a.label}</span>
                <span className="block text-dim text-[11px] num">
                  ${a.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
            </button>
          </li>
        ))}
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
            <p className="text-[10px] text-dim/80">
              New accounts start at $0. Deposit USDT or NGN to fund.
            </p>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
