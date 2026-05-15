'use client'
import type { AuthUser } from '@/hooks/useAuth'
import UserMenu from './UserMenu'

interface Props {
  user:         AuthUser | null
  connected:    boolean
  mode:         'demo' | 'real'
  onModeToggle: () => void
  onLogout:     () => void
  onEditProfile: () => void
}

export default function Header({ user, connected, mode, onModeToggle, onLogout, onEditProfile }: Props) {
  const balance = user
    ? (mode === 'demo' ? user.demo_balance : user.real_balance)
    : null

  return (
    <header className="h-12 bg-panel border-b border-border flex items-center px-3 sm:px-4 gap-3 shrink-0 z-10">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <span className="text-brand font-bold text-base sm:text-lg tracking-tight">OTUBURU</span>
        <span className="text-dim text-[10px] uppercase tracking-widest hidden sm:block">Synthetic</span>
      </div>

      {/* Connection dot */}
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-up' : 'bg-down'} transition-colors`} />
        <span className="text-dim text-[10px] hidden sm:block">{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      <div className="flex-1" />

      {user ? (
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Balance — hidden on very small screens, shown in dropdown instead */}
          {balance !== null && (
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-dim text-[10px] uppercase tracking-wider">{mode === 'demo' ? 'Demo' : 'Real'}</span>
              <span className="num text-sm font-semibold text-text">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {/* Mobile balance pill */}
          <div className="flex sm:hidden items-center gap-1.5">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${
              mode === 'demo' ? 'text-brand border-brand/30 bg-brand/10' : 'text-up border-up/30 bg-up/10'
            }`}>
              {mode === 'demo' ? 'DEMO' : 'REAL'}
            </span>
            {balance !== null && (
              <span className="num text-xs font-semibold text-text">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </span>
            )}
          </div>

          <UserMenu
            user={user}
            mode={mode}
            onModeToggle={onModeToggle}
            onLogout={onLogout}
            onEditProfile={onEditProfile}
          />
        </div>
      ) : (
        <div className="px-3 py-1 rounded bg-surface border border-border text-dim text-xs">
          Sign in to trade
        </div>
      )}
    </header>
  )
}
