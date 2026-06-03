'use client'
import { useEffect, useRef, useState } from 'react'
import type { AuthUser } from '@/hooks/useAuth'

interface Props {
  user: AuthUser
  mode: 'demo' | 'real'
  onModeToggle: () => void
  onLogout: () => void
  onEditProfile: () => void
}

export default function UserMenu({ user, mode, onModeToggle, onLogout, onEditProfile }: Props) {
  const [open, setOpen] = useState(false)
  const ref  = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ?? 0 keeps the avatar+chip rendering even when /auth/me returned a
  // partial payload (e.g. server 500 — fields drop out). Better to flash
  // "$0.00" briefly than crash the whole app shell.
  const balance = (mode === 'demo' ? user.demo_balance : user.real_balance) ?? 0

  return (
    <div ref={ref} className="relative">
      {/* Avatar trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-full px-1 py-0.5 hover:bg-muted/30 transition-colors"
        aria-label="User menu"
      >
        {user.picture ? (
          <img src={user.picture} alt={user.name} className="w-7 h-7 rounded-full border border-border" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs text-text font-semibold">
            {user.name?.[0]?.toUpperCase() ?? '?'}
          </div>
        )}
        <span className="text-text text-xs hidden sm:block max-w-[80px] truncate">{user.name?.split(' ')[0]}</span>
        <svg className="w-3 h-3 text-dim hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={open ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-10 w-64 bg-panel border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* User info header */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center gap-3">
              {user.picture ? (
                <img src={user.picture} alt={user.name} className="w-10 h-10 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm text-text font-semibold">
                  {user.name?.[0]?.toUpperCase() ?? '?'}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-text text-sm font-semibold truncate">{user.name}</p>
                <p className="text-dim text-xs truncate">{user.email}</p>
              </div>
            </div>
          </div>

          {/* Balance */}
          <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
            <div>
              <p className="text-[10px] text-dim uppercase tracking-wider">{mode === 'demo' ? 'Demo Balance' : 'Real Balance'}</p>
              <p className="num text-sm font-semibold text-text">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <button
              onClick={() => { onModeToggle(); setOpen(false) }}
              className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                mode === 'demo'
                  ? 'bg-brand/10 border-brand/30 text-brand hover:bg-brand/20'
                  : 'bg-up/10 border-up/30 text-up hover:bg-up/20'
              }`}
            >
              {mode === 'demo' ? 'Switch to Real' : 'Switch to Demo'}
            </button>
          </div>

          {/* Menu items */}
          <div className="py-1">
            <MenuItem icon="👤" label="Edit Profile" onClick={() => { onEditProfile(); setOpen(false) }} />
            <MenuItem icon="💳" label="Deposit USDT" onClick={() => { setOpen(false) }} />
            <MenuItem icon="📊" label="Transaction History" onClick={() => { setOpen(false) }} />
          </div>

          <div className="border-t border-border py-1">
            <MenuItem icon="🚪" label="Sign out" onClick={() => { onLogout(); setOpen(false) }} danger />
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger }: {
  icon: string; label: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface text-left ${
        danger ? 'text-down' : 'text-text'
      }`}
    >
      <span className="text-base">{icon}</span>
      <span>{label}</span>
    </button>
  )
}
