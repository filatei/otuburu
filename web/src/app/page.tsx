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
import AuthModal        from '@/components/AuthModal'
import ProfileModal     from '@/components/ProfileModal'
import AppDrawer        from '@/components/AppDrawer'
import DepositModal     from '@/components/DepositModal'
import { provisionAccount } from '@/hooks/useAccount'

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
  const [symbols,       setSymbols]       = useState<SymbolInfo[]>([])
  const [selected,      setSelected]      = useState('frxEURUSD')
  const [mode,          setMode]          = useState<'demo' | 'real'>('demo')
  const [authOpen,      setAuthOpen]      = useState(false)
  const [authError,     setAuthError]     = useState<string | null>(null)
  const [profileOpen,   setProfileOpen]   = useState(false)
  const [drawerOpen,    setDrawerOpen]    = useState(false)
  const [depositOpen,   setDepositOpen]   = useState(false)
  const [mobileTab,     setMobileTab]     = useState<MobileTab>('chart')

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
      {depositOpen && user && <DepositModal user={user} onClose={() => setDepositOpen(false)} />}
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
              binaries={binaries} settledHistory={settledHistory}
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
              onSelect={(s) => { setSelected(s); setMobileTab('chart') }}
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
                  binaries={binaries} settledHistory={settledHistory}
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

        {/* Bottom tab bar — MT5-style: Symbols / Chart / Trade / Positions */}
        <nav className="shrink-0 bg-panel border-t border-border flex items-stretch h-14 safe-bottom">
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
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium relative transition-colors ${
        active
          ? accent ? 'text-brand' : 'text-text'
          : 'text-dim'
      }`}
    >
      {active && (
        <span className={`absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-b ${accent ? 'bg-brand' : 'bg-text'}`} />
      )}
      <span className={`text-lg ${active ? (accent ? 'text-brand' : 'text-text') : 'text-dim'}`}>{icon}</span>
      <span>{label}</span>
      {badge !== undefined && (
        <span className="absolute top-2 right-1/4 min-w-[16px] h-4 bg-brand text-black text-[9px] font-bold rounded-full flex items-center justify-center px-1">
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function ChartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}
function TradeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  )
}
function PositionsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}
