'use client'
import { useEffect, useState } from 'react'
import type { SymbolInfo } from '@/types'
import { useTicks }   from '@/hooks/useTicks'
import { useAccount } from '@/hooks/useAccount'
import Header     from '@/components/Header'
import SymbolBar  from '@/components/SymbolBar'
import Chart      from '@/components/Chart'
import TradePanel from '@/components/TradePanel'
import Positions  from '@/components/Positions'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

export default function TradingPage() {
  const [symbols,  setSymbols]  = useState<SymbolInfo[]>([])
  const [selected, setSelected] = useState('frxEURUSD')

  // Load symbol catalogue once
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
  const { account, positions, binaries, refresh }  = useAccount()

  const selectedInfo = symbols.find(s => s.symbol === selected) ?? null

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface">
      {/* Top bar */}
      <Header account={account} connected={connected} />

      {/* Symbol strip */}
      <SymbolBar
        symbols={symbols}
        ticks={allTicks}
        selected={selected}
        onSelect={setSelected}
      />

      {/* Main trading area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chart */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Chart candles={candles} lastTick={lastTick} symbol={selected} />
          </div>

          {/* Positions strip */}
          <Positions
            positions={positions}
            binaries={binaries}
            ticks={allTicks}
            onRefresh={refresh}
          />
        </div>

        {/* Trade panel */}
        <TradePanel
          symbol={selected}
          info={selectedInfo}
          lastTick={lastTick}
          onTraded={refresh}
        />
      </div>
    </div>
  )
}
