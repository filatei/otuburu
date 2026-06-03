'use client'
import { useEffect, useRef, useState } from 'react'
import type { AuthUser } from '@/hooks/useAuth'
import { setFullscreenPref } from '@/hooks/useAutoFullscreen'

interface Props {
  open:          boolean
  onClose:       () => void
  user:          AuthUser | null
  mode:          'demo' | 'real'
  /** Label of the currently active real account — shown in the user card
   *  when mode === 'real'. Phase 2: replaces the implicit "Real" label. */
  activeAccountLabel?: string
  /** Live engine-side balance for the currently selected account+mode.
   *  Overrides the static deposit-total in user.real_balance so the
   *  drawer's balance matches what the header shows after trades settle.
   *  Pass null to fall back to user.{demo,real}_balance. */
  engineBalance?: number | null
  onModeToggle:  () => void
  onLogout:      () => void
  onEditProfile: () => void
  onDeposit:     () => void
  onWithdraw:    () => void
  onHistory:     () => void
  /** Open the multi-account picker sheet (lists real accounts, lets the
   *  user switch or create a new one). Optional — when undefined, the
   *  "Switch account" item is hidden. */
  onSwitchAccount?: () => void
  /** Open the "Get the App" sheet — Android APK + iOS PWA instructions. */
  onGetApp?:      () => void
  /** Open the "Contact support" sheet — message form that emails admin. */
  onContact?:     () => void
}

export default function AppDrawer({
  open, onClose, user, mode, activeAccountLabel, engineBalance, onModeToggle,
  onLogout, onEditProfile, onDeposit, onWithdraw, onHistory, onSwitchAccount,
  onGetApp, onContact,
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

  // Prefer the live engine balance — same source the Header uses, so the
  // two stay in sync after trades settle. Fall back to the static auth
  // figures only when engineBalance hasn't been provided (e.g. before the
  // first state push from the engine).
  const balance = engineBalance !== undefined && engineBalance !== null
    ? engineBalance
    : user ? (mode === 'demo' ? user.demo_balance : user.real_balance) : 0

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
            {/* Balance + mode toggle. When in real mode and an account label
                is known, show it under "Balance" so users know which real
                account is active (Phase 2 multi-account). */}
            <div className="flex items-center justify-between pt-3 border-t border-border">
              <div className="min-w-0">
                <p className="text-[10px] text-dim uppercase tracking-wider mb-0.5">
                  {mode === 'demo'
                    ? 'Demo Balance'
                    : activeAccountLabel
                      ? `Real · ${activeAccountLabel}`
                      : 'Real Balance'}
                </p>
                <p className="num text-lg font-bold text-text">
                  ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <button
                onClick={() => { onModeToggle(); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shrink-0 ${
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
            <Item icon="💳" label="Deposit"             sub="USDT (TRC20) or NGN (Paystack)" badge="live" onClick={() => { onDeposit(); onClose() }} />
            <Item icon="🏦" label="Withdraw"            sub="USDT (TRC20) or NGN bank"    badge="live" onClick={() => { onWithdraw(); onClose() }} />
            <Item icon="📋" label="Transaction History" sub="Deposits & withdrawals"       badge="live" onClick={() => { onHistory(); onClose() }} />
          </Section>

          <Section title="Portfolio">
            <Item icon="📂" label="Open Positions"  sub="Live trades with P&L"       badge="live" onClick={onClose} />
            <Item icon="🗂️" label="Trade History"   sub="Closed trades & results"    badge="new"  onClick={onClose} />
            <Item icon="📉" label="Performance"     sub="Win rate & P&L chart"       badge="soon" />
          </Section>

          <Section title="Account">
            {onSwitchAccount && (
              <Item icon="🔁" label="Switch account" sub="Manage real accounts" badge="live" onClick={() => { onSwitchAccount(); onClose() }} />
            )}
            <Item icon="👤" label="Edit Profile"       sub="Name & preferences"          badge="live" onClick={() => { onEditProfile(); onClose() }} />
            <Item icon="🎁" label="Refer a Friend"     sub="Earn on their trades"        badge="soon" />
            <Item icon="🔔" label="Notifications"      sub="Trade alerts & news"         badge="soon" />
          </Section>

          <Section title="Display">
            <FullscreenItem onClose={onClose} />
          </Section>

          {onGetApp && (
            <Section title="Install">
              <Item
                icon="📱"
                label="Get the App"
                sub="Android APK · iOS Home Screen"
                badge="new"
                onClick={() => { onGetApp(); onClose() }}
              />
            </Section>
          )}

          <Section title="Help">
            {onContact && (
              <Item icon="✉️" label="Contact us" sub="Email support directly" badge="live" onClick={() => { onContact(); onClose() }} />
            )}
            <Item icon="❓" label="Help Center" sub="How contracts work · FAQ" badge="soon" />
            <Item icon="📜" label="Terms & Legal" sub="Risk disclosure · privacy"   badge="soon" />
          </Section>
        </div>

        {/* ── Footer: value-prop tagline + sign out ────────────────────── */}
        {user && (
          <div className="shrink-0 px-3 pb-6 pt-2 border-t border-border mt-2">
            <button
              onClick={() => { onLogout(); onClose() }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-down hover:bg-down/10 border border-transparent hover:border-down/20 transition-colors text-sm font-medium"
            >
              <span className="text-base">🚪</span>
              Sign out
            </button>
            <p className="text-center text-[10px] text-dim/70 mt-3 leading-relaxed">
              Zero commission · Spreads from 5 bps · Real markets, fractional access
            </p>
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

/** FullscreenItem — toggles document fullscreen so the browser URL bar
 *  and tabs hide, giving a near-native trading view. Feature-detected:
 *  iOS Safari doesn't expose the Fullscreen API on the document element
 *  (only on <video>), so the item just doesn't render there — those users
 *  get the same effect by installing the PWA via the Home Screen banner.
 *
 *  We listen for fullscreenchange to keep the label in sync if the user
 *  exits with Esc or a system gesture.
 */
function FullscreenItem({ onClose }: { onClose: () => void }) {
  const [supported, setSupported] = useState(false)
  const [isFs,      setIsFs]      = useState(false)

  useEffect(() => {
    // requestFullscreen is undefined on iOS Safari (mobile + iPad). The
    // double-bang covers prefixed implementations Chrome dropped years
    // ago but doesn't hurt to keep.
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>
    }
    const has = typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
    setSupported(has)
    if (!has) return

    const sync = () => setIsFs(!!document.fullscreenElement)
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  if (!supported) return null

  const toggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        // Remember the user explicitly wants the URL bar back, so the
        // first-gesture auto-fullscreen on next page load doesn't fight them.
        setFullscreenPref(false)
      } else {
        await document.documentElement.requestFullscreen()
        setFullscreenPref(true)
      }
    } catch (err) {
      // Some browsers reject the call if the gesture didn't originate from
      // a "user activation" — uncommon for a tap inside the drawer, but
      // log silently rather than alerting.
      console.warn('fullscreen toggle failed', err)
    } finally {
      onClose()
    }
  }

  return (
    <Item
      icon={isFs ? '⊟' : '⛶'}
      label={isFs ? 'Exit fullscreen' : 'Hide browser URL'}
      sub={isFs ? 'Show browser chrome again' : 'Maximise the trading view'}
      badge="live"
      onClick={toggle}
    />
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
