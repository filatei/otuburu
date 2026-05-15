'use client'
import { useEffect, useState, useCallback } from 'react'
import type { SymbolInfo } from '@/types'
import { useTicks }   from '@/hooks/useTicks'
import { useAccount } from '@/hooks/useAccount'
import { useAuth }    from '@/hooks/useAuth'
import Header       from '@/components/Header'
import SymbolBar    from '@/components/SymbolBar'
import Chart        from '@/components/Chart'
import TradePanel   from '@/components/TradePanel'
import Positions    from '@/components/Positions'
import AuthModal    from '@/components/AuthModal'
import ProfileModal from '@/components/ProfileModal'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

type MobileTab = 'chart' | 'trade' | 'positions'

export default function TradingPage() {
  const [symbols,       setSymbols]       = useState<SymbolInfo[]>([])
  const [selected,      setSelected]      = useState('frxEURUSD')
  const [mode,          setMode]          = useState<'demo' | 'real'>('demo')
  const [authOpen,      setAuthOpen]      = useState(false)
  const [profileOpen,   setProfileOpen]   = useState(false)
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
        setSymbols(d.symbols ?? [])
        if (d.symbols?.length) setSelected(d.symbols[0].symbol)
      })
      .catch(() => {})
  }, [])

  const { lastTick, allTicks, candles, connected } = useTicks(selected)

  const accountId = user
    ? (mode === 'real' ? user.account_id : user.demo_id)
    : 'demo'

  const { positions, binaries, refresh } = useAccount(accountId)

  const selectedInfo = symbols.find(s => s.symbol === selected) ?? null

  const handleGoogleLogin = useCallback(async (credential: string) => {
    await loginWithGoogle(credential)
  }, [loginWithGoogle])

  const handleTraded = useCallback(() => {
    refresh()
    refreshBalances()
  }, [refresh, refreshBalances])

  const openCount = positions.length + binaries.length

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface">
      {/* Modals */}
      {authOpen    && <AuthModal onSuccess={handleGoogleLogin} />}
      {profileOpen && user && <ProfileModal user={user} onClose={() => setProfileOpen(false)} />}

      <Header
        user={user}
        connected={connected}
        mode={mode}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onLogout={logout}
        onEditProfile={() => setProfileOpen(true)}
      />

      <SymbolBar
        symbols={symbols}
        ticks={allTicks}
        selected={selected}
        onSelect={sym => { setSelected(sym); setMobileTab('chart') }}
      />

      {/* ── Desktop layout (md+): side-by-side ─────────────────────────────── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Chart candles={candles} lastTick={lastTick} symbol={selected} />
          </div>
          <Positions
            positions={positions}
            binaries={binaries}
            ticks={allTicks}
            accountId={accountId}
            onRefresh={refresh}
          />
        </div>
        <TradePanel
          symbol={selected}
          info={selectedInfo}
          lastTick={lastTick}
          accountId={accountId}
          onTraded={handleTraded}
        />
      </div>

      {/* ── Mobile layout (<md): tab-switched panels ────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden md:hidden">
        {/* Content area */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === 'chart' && (
            <Chart candles={candles} lastTick={lastTick} symbol={selected} />
          )}
          {mobileTab === 'trade' && (
            <div className="h-full overflow-y-auto bg-panel">
              <TradePanel
                symbol={selected}
                info={selectedInfo}
                lastTick={lastTick}
                accountId={accountId}
                onTraded={() => { handleTraded(); setMobileTab('positions') }}
                mobile
              />
            </div>
          )}
          {mobileTab === 'positions' && (
            <div className="h-full overflow-y-auto bg-panel">
              <Positions
                positions={positions}
                binaries={binaries}
                ticks={allTicks}
                accountId={accountId}
                onRefresh={refresh}
                mobile
              />
            </div>
          )}
        </div>

        {/* Bottom tab bar */}
        <nav className="shrink-0 bg-panel border-t border-border flex items-stretch h-14 safe-bottom">
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
            label={`Positions${openCount > 0 ? ` (${openCount})` : ''}`}
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
        <span className="absolute top-2 right-1/4 min-w-[16px] h-4 bg-brand text-white text-[9px] rounded-full flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </button>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────
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
