'use client'
import type { AuthUser } from '@/hooks/useAuth'

interface Props {
  user:       AuthUser | null
  connected:  boolean
  mode:       'demo' | 'real'
  onModeToggle: () => void
  onLogout:   () => void
}

export default function Header({ user, connected, mode, onModeToggle, onLogout }: Props) {
  const balance = user
    ? (mode === 'demo' ? user.demo_balance : user.real_balance)
    : null

  return (
    <header className="h-12 bg-panel border-b border-border flex items-center px-4 gap-4 shrink-0 z-10">
      {/* Logo */}
      <div className="flex items-center gap-2 mr-4">
        <span className="text-brand font-bold text-lg tracking-tight">OTUBURU</span>
        <span className="text-dim text-xs uppercase tracking-widest">Synthetic</span>
      </div>

      {/* Connection */}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-up' : 'bg-down'} transition-colors`} />
        <span className="text-dim text-xs">{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      <div className="flex-1" />

      {user ? (
        <>
          {/* Balance */}
          {balance !== null && (
            <div className="flex flex-col items-end">
              <span className="text-dim text-[10px] uppercase tracking-wider">Balance</span>
              <span className="num text-sm font-semibold text-text">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {/* Demo / Real toggle */}
          <button
            onClick={onModeToggle}
            className={`px-3 py-1 rounded text-xs font-semibold border transition-colors ${
              mode === 'demo'
                ? 'bg-brand/10 border-brand/30 text-brand'
                : 'bg-up/10 border-up/30 text-up'
            }`}
          >
            {mode === 'demo' ? 'DEMO' : 'REAL'}
          </button>

          {/* User avatar */}
          <div className="flex items-center gap-2 ml-2">
            {user.picture ? (
              <img
                src={user.picture}
                alt={user.name}
                className="w-7 h-7 rounded-full border border-border"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs text-text">
                {user.name?.[0]?.toUpperCase() ?? '?'}
              </div>
            )}
            <span className="text-text text-xs hidden sm:block">{user.name?.split(' ')[0]}</span>
            <button
              onClick={onLogout}
              className="text-dim text-xs hover:text-text transition-colors ml-1"
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <div className="px-3 py-1 rounded bg-surface border border-border text-dim text-xs">
          Sign in to trade
        </div>
      )}
    </header>
  )
}
