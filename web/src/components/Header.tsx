'use client'
import type { AuthUser } from '@/hooks/useAuth'

interface Props {
  user:           AuthUser | null
  connected:      boolean
  mode:           'demo' | 'real'
  engineBalance:  number | null   // live balance from engine, overrides static auth balance
  onModeToggle:   () => void
  onMenuOpen:     () => void
}

export default function Header({ user, connected, mode, engineBalance, onModeToggle, onMenuOpen }: Props) {
  // Prefer the live engine balance (updates as trades settle) over the static wallet balance
  const balance = engineBalance !== null
    ? engineBalance
    : user ? (mode === 'demo' ? user.demo_balance : user.real_balance) : null

  return (
    // Outer wrapper carries safe-top padding so the header content clears
    // the iOS notch in PWA standalone mode (viewportFit: 'cover'). Inner
    // div keeps the fixed 48px header height for the controls.
    <header className="safe-top bg-panel border-b border-border shrink-0 z-10">
    <div className="h-12 flex items-center px-3 gap-3">

      {/* Hamburger — always visible, opens the full drawer */}
      <button
        onClick={onMenuOpen}
        className="w-8 h-8 flex flex-col items-center justify-center gap-1.5 rounded-lg hover:bg-surface transition-colors shrink-0"
        aria-label="Open menu"
      >
        <span className="w-4.5 h-px bg-text block" style={{ width: '18px', height: '2px', borderRadius: '1px' }} />
        <span className="w-4.5 h-px bg-text block" style={{ width: '18px', height: '2px', borderRadius: '1px' }} />
        <span className="w-4.5 h-px bg-text block" style={{ width: '18px', height: '2px', borderRadius: '1px' }} />
      </button>

      {/* Logo */}
      <div className="flex items-center gap-2">
        <span className="text-brand font-bold text-base tracking-tight">OTUBURU</span>
        <span className="text-dim text-[10px] uppercase tracking-widest hidden sm:block">Synthetic</span>
      </div>

      {/* Connection dot */}
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-up' : 'bg-down'} transition-colors`} />
        <span className="text-dim text-[10px] hidden md:block">{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      <div className="flex-1" />

      {user ? (
        <div className="flex items-center gap-2">
          {/* Mode badge */}
          <button
            onClick={onModeToggle}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
              mode === 'demo'
                ? 'bg-brand/10 border-brand/30 text-brand hover:bg-brand/20'
                : 'bg-up/10 border-up/30 text-up hover:bg-up/20'
            }`}
          >
            {mode === 'demo' ? 'DEMO' : 'REAL'}
          </button>

          {/* Balance — desktop only. Mobile sees balance in the drawer's
              user card so the header stays MT5-lean. */}
          {balance !== null && (
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-dim text-[10px] uppercase tracking-wider leading-none">Balance</span>
              <span className="num text-sm font-semibold text-text leading-tight">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {/* Avatar intentionally removed from the header — it was redundant
              with the hamburger (both opened the same drawer) and MT5
              doesn't show a user avatar on its main screens. Profile +
              account info live inside the drawer's user card now. */}
        </div>
      ) : (
        <div className="px-3 py-1 rounded bg-surface border border-border text-dim text-xs">
          Sign in
        </div>
      )}
    </div>
    </header>
  )
}
