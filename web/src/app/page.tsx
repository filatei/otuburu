'use client'
import { useEffect, useState, useCallback } from 'react'
import type { SymbolInfo } from '@/types'
import { useTicks }   from '@/hooks/useTicks'
import { useAccount } from '@/hooks/useAccount'
import { useAuth }    from '@/hooks/useAuth'
import Header     from '@/components/Header'
import SymbolBar  from '@/components/SymbolBar'
import Chart      from '@/components/Chart'
import TradePanel from '@/components/TradePanel'
import Positions  from '@/components/Positions'
import AuthModal  from '@/components/AuthModal'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

export default function TradingPage() {
  const [symbols,  setSymbols]  = useState<SymbolInfo[]>([])
  const [selected, setSelected] = useState('frxEURUSD')
  const [mode,     setMode]     = useState<'demo' | 'real'>('demo')
  const [authOpen, setAuthOpen] = useState(false)

  const { user, loading: authLoading, loginWithGoogle, logout, refreshBalances } = useAuth()

  // Show auth modal if not logged in (after initial load)
  useEffect(() => {
    if (!authLoading && !user) setAuthOpen(true)
    if (user) setAuthOpen(false)
  }, [authLoading, user])

  // Load symbol catalogue
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

  // Use real or demo account_id depending on mode
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

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface">
      {authOpen && <AuthModal onSuccess={handleGoogleLogin} />}

      <Header
        user={user}
        connected={connected}
        mode={mode}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onLogout={logout}
      />

      <SymbolBar
        symbols={symbols}
        ticks={allTicks}
        selected={selected}
        onSelect={setSelected}
      />

      <div className="flex flex-1 overflow-hidden">
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
    </div>
  )
}
