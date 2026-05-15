'use client'
import { useEffect, useRef } from 'react'
import type { AuthUser } from '@/hooks/useAuth'

interface Props {
  open:          boolean
  onClose:       () => void
  user:          AuthUser | null
  mode:          'demo' | 'real'
  onModeToggle:  () => void
  onLogout:      () => void
  onEditProfile: () => void
  onDeposit:     () => void
  onWithdraw:    () => void
  onHistory:     () => void
}

export default function AppDrawer({
  open, onClose, user, mode, onModeToggle,
  onLogout, onEditProfile, onDeposit, onWithdraw, onHistory,
}: Props) {
  const drawerRef = useRef<HTMLDivElement>(null)

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  const balance = user ? (mode === 'demo' ? user.demo_balance : user.real_balance) : 0

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex">
      {/* Backdrop — click to close */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        className="relative w-72 max-w-[85vw] h-full bg-panel border-r border-border flex flex-col overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-brand font-bold text-base tracking-tight">OTUBURU</span>
            <span className="text-dim text-[10px] uppercase tracking-widest">Synthetic</span>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-dim hover:text-text hover:bg-surface transition-colors"
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>

        {/* ── User card ─────────────────────────────────────────────────── */}
        {user && (
          <div className="mx-3 mt-3 mb-1 bg-surface rounded-xl p-4 border border-border shrink-0">
            <div className="flex items-center gap-3 mb-3">
              {user.picture ? (
                <img src={user.picture} alt={user.name} className="w-11 h-11 rounded-full border border-border" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-base font-bold text-text">
                  {user.name?.[0]?.toUpperCase() ?? '?'}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-text text-sm font-semibold truncate">{user.name}</p>
                <p className="text-dim text-xs truncate">{user.email}</p>
              </div>
            </div>
            {/* Balance + mode toggle */}
            <div className="flex items-center justify-between pt-3 border-t border-border">
              <div>
                <p className="text-[10px] text-dim uppercase tracking-wider mb-0.5">
                  {mode === 'demo' ? 'Demo Balance' : 'Real Balance'}
                </p>
                <p className="num text-lg font-bold text-text">
                  ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <button
                onClick={() => { onModeToggle(); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  mode === 'demo'
                    ? 'bg-brand/10 border-brand/30 text-brand hover:bg-brand/20'
                    : 'bg-up/10 border-up/30 text-up hover:bg-up/20'
                }`}
              >
                {mode === 'demo' ? '→ Go Real' : '→ Go Demo'}
              </button>
            </div>
          </div>
        )}

        {/* ── Menu sections ─────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-2 space-y-4">

          <Section title="Trade">
            <Item icon="📈" label="Rise / Fall" sub="Predict direction · fixed payout" badge="live" onClick={onClose} />
            <Item icon="⚡" label="CFD"          sub="Buy or sell with leverage"        badge="live" onClick={onClose} />
            <Item icon="🎯" label="Touch / No Touch" sub="Win if price hits barrier"    badge="soon" />
            <Item icon="🔢" label="Digits"        sub="Last digit prediction"            badge="soon" />
          </Section>

          <Section title="Finance">
            <Item icon="💳" label="Deposit USDT"        sub="Your personal TRC20 address" badge="live" onClick={() => { onDeposit(); onClose() }} />
            <Item icon="🏦" label="Withdraw"            sub="Send USDT to your wallet"    badge="live" onClick={() => { onWithdraw(); onClose() }} />
            <Item icon="📋" label="Transaction History" sub="Deposits & withdrawals"       badge="live" onClick={() => { onHistory(); onClose() }} />
          </Section>

          <Section title="Portfolio">
            <Item icon="📂" label="Open Positions"  sub="Live trades with P&L"       badge="live" onClick={onClose} />
            <Item icon="🗂️" label="Trade History"   sub="Closed trades & results"    badge="new"  onClick={onClose} />
            <Item icon="📉" label="Performance"     sub="Win rate & P&L chart"       badge="soon" />
          </Section>

          <Section title="Account">
            <Item icon="👤" label="Edit Profile"       sub="Name & preferences"          badge="live" onClick={() => { onEditProfile(); onClose() }} />
            <Item icon="🎁" label="Refer a Friend"     sub="Earn on their trades"        badge="soon" />
            <Item icon="🔔" label="Notifications"      sub="Trade alerts & news"         badge="soon" />
          </Section>

          <Section title="Help">
            <Item icon="❓" label="Help Center" sub="How contracts work · FAQ" badge="soon" />
            <Item icon="📜" label="Terms & Legal" sub="Risk disclosure · privacy"   badge="soon" />
          </Section>
        </div>

        {/* ── Footer: sign out ──────────────────────────────────────────── */}
        {user && (
          <div className="shrink-0 px-3 pb-6 pt-2 border-t border-border mt-2">
            <button
              onClick={() => { onLogout(); onClose() }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-down hover:bg-down/10 border border-transparent hover:border-down/20 transition-colors text-sm font-medium"
            >
              <span className="text-base">🚪</span>
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-dim uppercase tracking-widest px-1 mb-1.5">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Item({ icon, label, sub, badge, onClick }: {
  icon: string; label: string; sub: string;
  badge?: 'live' | 'new' | 'soon'; onClick?: () => void
}) {
  const badgeStyle: Record<string, string> = {
    live: 'bg-up/15 text-up',
    new:  'bg-brand/15 text-brand',
    soon: 'bg-muted/50 text-dim',
  }
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface transition-colors text-left disabled:opacity-60 disabled:cursor-default"
    >
      <span className="text-xl w-8 text-center shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-text text-sm font-medium leading-none mb-0.5">{label}</p>
        <p className="text-dim text-xs leading-tight truncate">{sub}</p>
      </div>
      {badge && (
        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${badgeStyle[badge]}`}>
          {badge}
        </span>
      )}
    </button>
  )
}
