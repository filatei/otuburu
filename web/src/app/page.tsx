'use client'
import { useEffect, useState, useCallback } from 'react'
import type { SymbolInfo } from '@/types'
import { useTicks }   from '@/hooks/useTicks'
import { useAccount } from '@/hooks/useAccount'
import { useAuth }    from '@/hooks/useAuth'
import Header            from '@/components/Header'
import SymbolBar         from '@/components/SymbolBar'
import Chart             from '@/components/Chart'
import TradePanel        from '@/components/TradePanel'
import Positions         from '@/components/Positions'
import MobileSymbolsTab  from '@/components/MobileSymbolsTab'
import MobileChartTiles  from '@/components/MobileChartTiles'
import MobilePositions   from '@/components/MobilePositions'
import MobileTradeForm   from '@/components/MobileTradeForm'
import AccountStatsPanel from '@/components/AccountStatsPanel'
import AuthModal           from '@/components/AuthModal'
import ProfileModal        from '@/components/ProfileModal'
import AppDrawer           from '@/components/AppDrawer'
import DepositModal        from '@/components/DepositModal'
import SymbolActionsSheet    from '@/components/SymbolActionsSheet'
import SymbolPropertiesModal from '@/components/SymbolPropertiesModal'
import { provisionAccount } from '@/hooks/useAccount'
import { useAutoFullscreen } from '@/hooks/useAutoFullscreen'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

/**
 * Symbol display priority. Lower index = leftmost on the symbol bar.
 * Anything not in this list is appended after, in API-returned order.
 *
 * Lead with metals (gold first, then silver — the headline retail assets),
 * then majors (BTC, ETH), then indices (SPX/DJI/NDX), then forex (EUR/GBP),
 * then synthetic indices at the end.
 */
const SYMBOL_ORDER: string[] = [
  'cryXAUUSD',  // Gold
  'XAGUSD',     // Silver
  'cryBTCUSD',  // Bitcoin
  'cryETHUSD',  // Ethereum
  'SPX',        // S&P 500
  'DJI',        // Dow Jones
  'NDX',        // Nasdaq-100
  'frxEURUSD',  // EUR/USD
  'frxGBPUSD',  // GBP/USD
  'BOOM500',
  'BOOM1000',
  'CRASH1000',
]
const SYMBOL_RANK = new Map(SYMBOL_ORDER.map((s, i) => [s, i]))

function orderSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const FALLBACK = SYMBOL_ORDER.length
  return [...symbols].sort((a, b) => {
    const ra = SYMBOL_RANK.get(a.symbol) ?? FALLBACK
    const rb = SYMBOL_RANK.get(b.symbol) ?? FALLBACK
    return ra === rb ? a.symbol.localeCompare(b.symbol) : ra - rb
  })
}

type MobileTab = 'symbols' | 'chart' | 'trade' | 'positions'

export default function TradingPage() {
  // Default the experience to fullscreen so the browser URL bar gets out of
  // the way (MT5-like). One-shot — fires on the first user gesture, respects
  // the user's prior explicit opt-out, no-op on iOS Safari.
  useAutoFullscreen()

  const [symbols,       setSymbols]       = useState<SymbolInfo[]>([])
  const [selected,      setSelected]      = useState('frxEURUSD')
  const [mode,          setMode]          = useState<'demo' | 'real'>('demo')
  const [authOpen,      setAuthOpen]      = useState(false)
  const [authError,     setAuthError]     = useState<string | null>(null)
  const [profileOpen,   setProfileOpen]   = useState(false)
  const [drawerOpen,    setDrawerOpen]    = useState(false)
  const [depositOpen,   setDepositOpen]   = useState(false)
  const [mobileTab,     setMobileTab]     = useState<MobileTab>('chart')
  /** Symbol whose MT5-style action sheet is currently open. null = closed. */
  const [actionsFor,    setActionsFor]    = useState<string | null>(null)
  /** Symbol whose Specification/Properties modal is currently open. null = closed.
   *  Tracked separately from `actionsFor` so the modal mounts fresh each time
   *  and unmounts on close — no leaked open-state across symbol selections. */
  const [propertiesFor, setPropertiesFor] = useState<string | null>(null)

  const { user, loading: authLoading, loginWithGoogle, logout, refreshBalances } = useAuth()

  useEffect(() => {
    if (!authLoading && !user) setAuthOpen(true)
    if (user) setAuthOpen(false)
  }, [authLoading, user])

  useEffect(() => {
    fetch(`${API_BASE}/api/symbols`)
      .then(r => r.json())
      .then((d: { symbols: SymbolInfo[] }) => {
        const ordered = orderSymbols(d.symbols ?? [])
        setSymbols(ordered)
        if (ordered.length) setSelected(ordered[0].symbol)
      })
      .catch(() => {})
  }, [])

  const accountId = user
    ? (mode === 'real' ? user.account_id : user.demo_id)
    : 'demo'

  // applyState is passed to useTicks so WebSocket state pushes update account
  // without any HTTP polling — eliminates the mod_evasive rate-limit trigger.
  const { account, positions, binaries, spots, settledHistory, refresh, applyState } = useAccount(accountId)

  const { lastTick, allTicks, candles, connected } = useTicks(selected, applyState, accountId)

  const selectedInfo = symbols.find(s => s.symbol === selected) ?? null

  const handleGoogleLogin = useCallback(async (credential: string) => {
    setAuthError(null)
    try {
      const authUser = await loginWithGoogle(credential)
      // Provision engine accounts immediately after login so the user can trade
      // without a round-trip delay.  Demo always starts at $10 000; real account
      // uses the Postgres balance so it reflects any prior deposits.
      await Promise.allSettled([
        provisionAccount(authUser.demo_id,    'Demo', true,  10_000),
        provisionAccount(authUser.account_id, 'Real', false, authUser.real_balance ?? 0),
      ])
    } catch (err: any) {
      setAuthError(err?.message ?? 'Sign-in failed. Please try again.')
    }
  }, [loginWithGoogle])

  const handleTraded = useCallback(() => {
    refresh()
    refreshBalances()
  }, [refresh, refreshBalances])

  const openCount = positions.length + binaries.length + spots.length

  // Aggregate floating P&L across all open positions and spots — drives the
  // pnl label on the MT5-style AccountStatsPanel header on mobile.
  const floatingPnl =
    positions.reduce((s, p) => s + (p.unrealised_pnl ?? 0), 0) +
    spots.reduce((s, p) => s + (p.unrealised_pnl ?? 0), 0)

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-surface">
      {/* Modals & drawer */}
      {authOpen    && <AuthModal onSuccess={handleGoogleLogin} error={authError} />}
      {profileOpen && user && <ProfileModal user={user} onClose={() => setProfileOpen(false)} />}
      {/* DepositModal stays mounted while `user` is present so BottomSheet
          can play its exit animation when `open` flips back to false. */}
      {user && <DepositModal open={depositOpen} user={user} onClose={() => setDepositOpen(false)} />}

      {/* MT5-style symbol actions sheet — tap a row on Quotes to open. */}
      <SymbolActionsSheet
        open={actionsFor !== null}
        onClose={() => setActionsFor(null)}
        info={actionsFor ? (symbols.find(s => s.symbol === actionsFor) ?? null) : null}
        tick={actionsFor ? (allTicks[actionsFor] ?? null) : null}
        positions={positions}
        spots={spots}
        accountId={accountId}
        onTraded={handleTraded}
        onOpenChart={() => { if (actionsFor) { setSelected(actionsFor); setMobileTab('chart') } }}
        onNewOrder ={() => { if (actionsFor) { setSelected(actionsFor); setMobileTab('trade') } }}
        onOpenProperties={() => { if (actionsFor) setPropertiesFor(actionsFor) }}
      />

      {/* Symbol Specification (Properties) modal — mounted on demand so each
          open is a fresh component instance with no leaked toggle state. */}
      {propertiesFor && (
        <SymbolPropertiesModal
          open={true}
          info={symbols.find(s => s.symbol === propertiesFor) ?? null}
          onClose={() => setPropertiesFor(null)}
        />
      )}
      <AppDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        user={user}
        mode={mode}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onLogout={logout}
        onEditProfile={() => setProfileOpen(true)}
        onDeposit={() => setDepositOpen(true)}
        onWithdraw={() => {}}
        onHistory={() => {}}
      />

      <Header
        user={user}
        connected={connected}
        mode={mode}
        engineBalance={account?.balance ?? null}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onMenuOpen={() => setDrawerOpen(true)}
      />

      {/* SymbolBar — desktop only. Mobile users select symbols via the
          dedicated Symbols tab (MT5-style) to keep the trading screens
          uncluttered. */}
      <div className="hidden md:block">
        <SymbolBar
          symbols={symbols}
          ticks={allTicks}
          selected={selected}
          onSelect={sym => { setSelected(sym); setMobileTab('chart') }}
        />
      </div>

      {/* ── Desktop layout (md+): side-by-side ─────────────────────────────── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Chart
              candles={candles} lastTick={lastTick} symbol={selected}
              info={selectedInfo}
              accountId={accountId}
              binaries={binaries} positions={positions} spots={spots} settledHistory={settledHistory}
            />
          </div>
          <Positions
            positions={positions}
            binaries={binaries}
            spots={spots}
            settledHistory={settledHistory}
            ticks={allTicks}
            symbols={symbols}
            accountId={accountId}
            onRefresh={refresh}
          />
        </div>
        <TradePanel
          symbol={selected}
          info={selectedInfo}
          lastTick={lastTick}
          account={account}
          accountId={accountId}
          onTraded={handleTraded}
        />
      </div>

      {/* ── Mobile layout (<md): tab-switched panels ────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden md:hidden">
        {/* Content area — each tab is a dedicated full-screen view
            (Symbols / Chart / Trade / Positions). MT5-style separation. */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === 'symbols' && (
            <MobileSymbolsTab
              symbols={symbols}
              ticks={allTicks}
              selected={selected}
              // MT5 behaviour: tap a symbol → context sheet appears, user
              // chooses Chart / New Order / Close Profitable / Close Losers
              // / Properties. Direct-jump-to-chart is gone.
              onSelect={(s) => setActionsFor(s)}
            />
          )}
          {mobileTab === 'chart' && (
            <div className="h-full flex flex-col overflow-hidden">
              <MobileChartTiles
                symbol={selected}
                info={selectedInfo}
                lastTick={lastTick}
                account={account}
                accountId={accountId}
                onTraded={handleTraded}
              />
              <div className="flex-1 overflow-hidden">
                <Chart
                  candles={candles} lastTick={lastTick} symbol={selected}
                  info={selectedInfo}
                  accountId={accountId}
                  binaries={binaries} positions={positions} spots={spots} settledHistory={settledHistory}
                />
              </div>
            </div>
          )}
          {mobileTab === 'trade' && (
            <div className="h-full overflow-y-auto bg-panel">
              <MobileTradeForm
                symbol={selected}
                info={selectedInfo}
                lastTick={lastTick}
                account={account}
                accountId={accountId}
                floatingPnl={floatingPnl}
                onTraded={() => { handleTraded(); setMobileTab('positions') }}
              />
            </div>
          )}
          {mobileTab === 'positions' && (
            <div className="h-full overflow-y-auto bg-panel">
              <AccountStatsPanel
                account={account}
                floatingPnl={floatingPnl}
                title="Positions"
              />
              <MobilePositions
                positions={positions}
                binaries={binaries}
                spots={spots}
                settledHistory={settledHistory}
                ticks={allTicks}
                symbols={symbols}
                accountId={accountId}
                onRefresh={refresh}
                onNewTrade={() => setMobileTab('trade')}
              />
            </div>
          )}
        </div>

        {/* Bottom tab bar — MT5-style: Symbols / Chart / Trade / Positions.
            h-16 (64px) for thumb-friendly touch targets (Apple/Material
            both recommend 44–48px minimum; we go bigger for one-handed reach). */}
        <nav className="shrink-0 bg-panel border-t border-border flex items-stretch h-16 safe-bottom">
          <MobileTabBtn
            label="Symbols"
            icon={<SymbolsIcon />}
            active={mobileTab === 'symbols'}
            onClick={() => setMobileTab('symbols')}
          />
          <MobileTabBtn
            label="Chart"
            icon={<ChartIcon />}
            active={mobileTab === 'chart'}
            onClick={() => setMobileTab('chart')}
          />
          <MobileTabBtn
            label="Trade"
            icon={<TradeIcon />}
            active={mobileTab === 'trade'}
            onClick={() => setMobileTab('trade')}
            accent
          />
          <MobileTabBtn
            label="Positions"
            icon={<PositionsIcon />}
            active={mobileTab === 'positions'}
            onClick={() => setMobileTab('positions')}
            badge={openCount > 0 ? openCount : undefined}
          />
        </nav>
      </div>
    </div>
  )
}

// ─── Mobile tab button ────────────────────────────────────────────────────────
function MobileTabBtn({ label, icon, active, onClick, accent, badge }: {
  label: string; icon: React.ReactNode; active: boolean;
  onClick: () => void; accent?: boolean; badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-medium relative transition-colors active:scale-95 ${
        active
          ? accent ? 'text-brand' : 'text-text'
          : 'text-dim hover:text-text'
      }`}
    >
      {active && (
        <span className={`absolute top-0 left-1/2 -translate-x-1/2 w-10 h-[3px] rounded-b ${accent ? 'bg-brand' : 'bg-text'}`} />
      )}
      <span
        className={`text-[22px] leading-none ${active ? (accent ? 'text-brand' : 'text-text') : 'text-dim'}`}
      >
        {icon}
      </span>
      <span className="leading-none">{label}</span>
      {badge !== undefined && (
        <span className="absolute top-1.5 right-[22%] min-w-[18px] h-[18px] bg-brand text-black text-[10px] font-bold rounded-full flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </button>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function SymbolsIcon() {
  // Grid-of-cards icon — represents the symbol watchlist
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function ChartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}
function TradeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  )
}
function PositionsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}
