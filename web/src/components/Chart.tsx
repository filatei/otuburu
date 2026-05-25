'use client'
import { useEffect, useRef } from 'react'
import type { Candle, Tick, BinaryOption, SettledTrade } from '@/types'

interface Props {
  candles:          Candle[]
  lastTick:         Tick | null
  symbol:           string
  binaries?:        BinaryOption[]      // open trades → entry-price dashed lines
  settledHistory?:  SettledTrade[]      // settled trades → ▲/▼ markers with P&L
}

export default function Chart({
  candles, lastTick, symbol,
  binaries = [], settledHistory = [],
}: Props) {
  const containerRef  = useRef<HTMLDivElement>(null)
  const chartRef      = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef     = useRef<import('lightweight-charts').ISeriesApi<'Line'> | null>(null)
  // Track price lines by binary id so we can remove stale ones
  const priceLinesRef = useRef<Map<string, import('lightweight-charts').IPriceLine>>(new Map())

  // ── Create chart once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let chart: import('lightweight-charts').IChartApi

    import('lightweight-charts').then(({ createChart, CrosshairMode }) => {
      if (!containerRef.current) return

      chart = createChart(containerRef.current, {
        layout: {
          background: { color: '#0d0d0d' },
          textColor:  '#888',
        },
        grid: {
          vertLines: { color: '#1a1a1a' },
          horzLines: { color: '#1a1a1a' },
        },
        crosshair:       { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#242424' },
        timeScale: {
          borderColor:    '#242424',
          timeVisible:    true,
          secondsVisible: true,
        },
        handleScroll: true,
        handleScale:  true,
      })

      const series = chart.addLineSeries({
        color:                  '#4bb4b4',
        lineWidth:              2,
        priceLineVisible:       false,
        lastValueVisible:       true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius:  4,
      })

      chartRef.current  = chart
      seriesRef.current = series

      const ro = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.applyOptions({
            width:  containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
          })
        }
      })
      ro.observe(containerRef.current)
      return () => ro.disconnect()
    })

    return () => {
      // Wipe price line refs so they aren't applied to a new chart instance
      priceLinesRef.current.clear()
      chart?.remove()
    }
  }, []) // eslint-disable-line

  // ── Load full series when symbol changes ────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map(c => ({
        time:  c.time as import('lightweight-charts').Time,
        value: c.close,
      }))
    )
    chartRef.current?.timeScale().fitContent()
  }, [symbol, candles.length === 0]) // eslint-disable-line

  // ── Tick-by-tick update ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    const last = candles[candles.length - 1]
    seriesRef.current.update({
      time:  last.time as import('lightweight-charts').Time,
      value: last.close,
    })
  }, [lastTick]) // eslint-disable-line

  // ── Entry-price lines for open binary trades ────────────────────────────────
  // Each open trade gets a dashed horizontal line at its entry_mid price.
  // UP trade → cyan line below current price if winning, above if losing.
  // DOWN trade → red line above current price if winning, below if losing.
  // The price line label shows direction, stake, and remaining ticks.
  useEffect(() => {
    if (!seriesRef.current) return

    import('lightweight-charts').then(({ LineStyle }) => {
      const series = seriesRef.current!
      const activeForSymbol = new Set(
        binaries.filter(b => b.symbol === symbol).map(b => b.id)
      )

      // Remove price lines that no longer have a live trade
      priceLinesRef.current.forEach((line, id) => {
        if (!activeForSymbol.has(id)) {
          try { series.removePriceLine(line) } catch { /* chart may have remounted */ }
          priceLinesRef.current.delete(id)
        }
      })

      // Add price lines for new open trades
      for (const b of binaries) {
        if (b.symbol !== symbol) continue
        if (priceLinesRef.current.has(b.id)) continue

        const isUp  = b.direction === 'UP'
        const color = isUp ? '#4bb4b4' : '#cc2e3d'
        const line  = series.createPriceLine({
          price:            b.entry_mid,
          color,
          lineWidth:        1,
          lineStyle:        LineStyle.Dashed,
          axisLabelVisible: true,
          title:            `${isUp ? '▲ RISE' : '▼ FALL'} $${b.stake} · ${b.ticks_left}t`,
        })
        priceLinesRef.current.set(b.id, line)
      }
    })
  }, [binaries, symbol])

  // ── Settled trade markers ───────────────────────────────────────────────────
  // Arrows at the settlement time on the price line.
  // RISE won → green ▲ below bar   RISE lost → red ▲ below bar (faded)
  // FALL won → green ▼ above bar   FALL lost → red ▼ above bar
  // Net P&L shown as text next to the marker.
  useEffect(() => {
    if (!seriesRef.current) return

    const symbolTrades = settledHistory
      .filter(t => t.symbol === symbol)
      .slice(0, 40) // last 40 on this symbol

    const markers = symbolTrades
      .map(t => {
        const isUp   = t.direction === 'UP'
        const won    = t.outcome === 'win'
        const net    = won ? t.pnl - t.stake : -t.stake
        return {
          time:     Math.floor(t.settled_at / 1000) as import('lightweight-charts').Time,
          position: (isUp ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          color:    won ? '#4bb4b4' : '#cc2e3d',
          shape:    (isUp ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          text:     (net >= 0 ? '+' : '') + net.toFixed(0),
          size:     1,
          id:       t.id,
        }
      })
      // lightweight-charts requires markers sorted oldest → newest
      .sort((a, b) => (a.time as number) - (b.time as number))

    seriesRef.current.setMarkers(markers)
  }, [settledHistory, symbol])

  return (
    <div className="relative w-full h-full">
      {/* Symbol + live price overlay */}
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3 pointer-events-none">
        <span className="text-text font-bold text-lg">{symbol}</span>
        {lastTick && (
          <span className="num text-2xl font-semibold text-text">
            {lastTick.mid.toFixed(lastTick.mid < 10 ? 3 : 2)}
          </span>
        )}
      </div>

      {/* Open trades legend */}
      {binaries.filter(b => b.symbol === symbol).length > 0 && (
        <div className="absolute top-3 right-4 z-10 flex flex-col items-end gap-1 pointer-events-none">
          {binaries.filter(b => b.symbol === symbol).map(b => (
            <span
              key={b.id}
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                b.direction === 'UP' ? 'text-up bg-up/10' : 'text-down bg-down/10'
              }`}
            >
              {b.direction === 'UP' ? '▲ RISE' : '▼ FALL'} ${b.stake} · {b.ticks_left}t
            </span>
          ))}
        </div>
      )}

      <div ref={containerRef} className="w-full h-full" />

      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-sm">
          Waiting for ticks…
        </div>
      )}
    </div>
  )
}
