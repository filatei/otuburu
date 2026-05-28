'use client'
import { useEffect, useRef, useState } from 'react'
import type { Candle, Tick, BinaryOption, SettledTrade, Resolution, ApiSettledTrade, SymbolInfo } from '@/types'
import { RESOLUTIONS } from '@/types'
import { useChartHistory } from '@/hooks/useChartHistory'
import { displayNameOf, divisorOf, toDisplayPrice } from '@/lib/symbols'

interface Props {
  candles:          Candle[]
  lastTick:         Tick | null
  symbol:           string
  info?:            SymbolInfo | null  // optional, for display divisor + display name
  accountId?:       string
  binaries?:        BinaryOption[]      // open trades → entry-price dashed lines (LIVE only)
  settledHistory?:  SettledTrade[]      // settled trades → ▲/▼ markers (LIVE only)
}

export default function Chart({
  candles, lastTick, symbol, info = null, accountId = 'demo',
  binaries = [], settledHistory = [],
}: Props) {
  const [resolution, setResolution] = useState<Resolution>('M1')

  const { candles: histCandles, trades: histTrades, loading } =
    useChartHistory(symbol, resolution, accountId)

  // Reset to default (M1) when symbol changes — gives users actual candle
  // history immediately instead of waiting for live ticks to accumulate.
  useEffect(() => {
    setResolution('M1')
  }, [symbol])

  return (
    <div className="flex flex-col w-full h-full">
      {/* Timeframe bar */}
      <TimeframeBar resolution={resolution} onSelect={setResolution} />

      {/* Chart area */}
      {resolution === 'LIVE' ? (
        <LiveChart
          candles={candles}
          lastTick={lastTick}
          symbol={symbol}
          info={info}
          binaries={binaries}
          settledHistory={settledHistory}
        />
      ) : (
        <HistoricalChart
          symbol={symbol}
          info={info}
          resolution={resolution}
          candles={histCandles}
          trades={histTrades}
          loading={loading}
        />
      )}
    </div>
  )
}

// ─── Timeframe bar ────────────────────────────────────────────────────────────

function TimeframeBar({ resolution, onSelect }: {
  resolution: Resolution
  onSelect: (r: Resolution) => void
}) {
  return (
    <div className="shrink-0 flex items-center gap-0.5 px-2 py-1.5 bg-panel border-b border-border overflow-x-auto scrollbar-none">
      {RESOLUTIONS.map(r => (
        <button
          key={r}
          onClick={() => onSelect(r)}
          className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors shrink-0 ${
            resolution === r
              ? 'bg-brand text-black'
              : 'text-dim hover:text-text hover:bg-surface'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  )
}

// ─── Live line chart (existing behaviour) ─────────────────────────────────────

function LiveChart({ candles, lastTick, symbol, info, binaries, settledHistory }: {
  candles:         Candle[]
  lastTick:        Tick | null
  symbol:          string
  info:            SymbolInfo | null
  binaries:        BinaryOption[]
  settledHistory:  SettledTrade[]
}) {
  const divisor = divisorOf(info)
  const containerRef  = useRef<HTMLDivElement>(null)
  const chartRef      = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef     = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null)
  const priceLinesRef = useRef<Map<string, import('lightweight-charts').IPriceLine>>(new Map())

  // Create chart once — candlestick series for visual consistency with the
  // historical timeframes. (Was a line series; line + candles felt jarring
  // when switching between LIVE and M1/M5/etc.)
  useEffect(() => {
    if (!containerRef.current) return
    let chart: import('lightweight-charts').IChartApi

    import('lightweight-charts').then(({ createChart, CrosshairMode }) => {
      if (!containerRef.current) return

      chart = createChart(containerRef.current, {
        layout: { background: { color: '#0d0d0d' }, textColor: '#888' },
        grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#242424' },
        timeScale: {
          borderColor: '#242424',
          timeVisible: true,
          secondsVisible: true,
          // Tighter default density — more candles per screen (MetaTrader-style).
          // Users zoom in via the +/− overlay if they want bigger candles.
          barSpacing: 4,
        },
        handleScroll: true,
        handleScale: true,
      })

      const series = chart.addCandlestickSeries({
        upColor:         '#4bb4b4',
        downColor:       '#cc2e3d',
        borderUpColor:   '#4bb4b4',
        borderDownColor: '#cc2e3d',
        wickUpColor:     '#4bb4b4',
        wickDownColor:   '#cc2e3d',
        priceLineVisible: false,
        lastValueVisible: true,
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
      priceLinesRef.current.clear()
      chart?.remove()
    }
  }, []) // eslint-disable-line

  // Load full series when symbol changes — OHLC divided for display.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map(c => ({
        time:  c.time as import('lightweight-charts').Time,
        open:  c.open  / divisor,
        high:  c.high  / divisor,
        low:   c.low   / divisor,
        close: c.close / divisor,
      }))
    )
    // scrollToRealTime instead of fitContent — keep the fixed barSpacing
    // density and just position the latest candle at the right edge.
    chartRef.current?.timeScale().scrollToRealTime()
  }, [symbol, candles.length === 0, divisor]) // eslint-disable-line

  // Tick-by-tick update — apply divisor to OHLC of the latest bucket.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    const last = candles[candles.length - 1]
    seriesRef.current.update({
      time:  last.time as import('lightweight-charts').Time,
      open:  last.open  / divisor,
      high:  last.high  / divisor,
      low:   last.low   / divisor,
      close: last.close / divisor,
    })
  }, [lastTick]) // eslint-disable-line

  // Entry-price lines for open binary trades
  useEffect(() => {
    if (!seriesRef.current) return
    import('lightweight-charts').then(({ LineStyle }) => {
      const series = seriesRef.current!
      const activeForSymbol = new Set(
        binaries.filter(b => b.symbol === symbol).map(b => b.id)
      )
      priceLinesRef.current.forEach((line, id) => {
        if (!activeForSymbol.has(id)) {
          try { series.removePriceLine(line) } catch { /* chart may have remounted */ }
          priceLinesRef.current.delete(id)
        }
      })
      for (const b of binaries) {
        if (b.symbol !== symbol) continue
        if (priceLinesRef.current.has(b.id)) continue
        const isUp  = b.direction === 'UP'
        const color = isUp ? '#4bb4b4' : '#cc2e3d'
        const line  = series.createPriceLine({
          price:            b.entry_mid / divisor,
          color,
          lineWidth:        1,
          lineStyle:        LineStyle.Dashed,
          axisLabelVisible: true,
          title:            `${isUp ? '▲ RISE' : '▼ FALL'} $${b.stake} · ${b.ticks_left}t`,
        })
        priceLinesRef.current.set(b.id, line)
      }
    })
  }, [binaries, symbol, divisor])

  // Settled trade markers
  useEffect(() => {
    if (!seriesRef.current) return
    const symbolTrades = settledHistory.filter(t => t.symbol === symbol).slice(0, 40)
    const markers = symbolTrades
      .map(t => {
        const isUp = t.direction === 'UP'
        const won  = t.outcome === 'win'
        const net  = won ? t.pnl : -t.stake
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
      .sort((a, b) => (a.time as number) - (b.time as number))
    seriesRef.current.setMarkers(markers)
  }, [settledHistory, symbol])

  const displayName = displayNameOf(info, symbol)
  const displayMid  = lastTick ? toDisplayPrice(info, lastTick.mid) : null

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Symbol + live price overlay */}
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3 pointer-events-none">
        <span className="text-text font-bold text-lg">{displayName}</span>
        {displayMid !== null && (
          <span className="num text-2xl font-semibold text-text">
            {displayMid.toFixed(displayMid < 10 ? 3 : 2)}
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

      <ZoomControls chartRef={chartRef} />

      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-sm">
          Waiting for ticks…
        </div>
      )}
    </div>
  )
}

// ─── Historical candlestick chart ─────────────────────────────────────────────

function HistoricalChart({ symbol, info, resolution, candles, trades, loading }: {
  symbol:     string
  info:       SymbolInfo | null
  resolution: Resolution
  candles:    { ts_s: number; open: number; high: number; low: number; close: number }[]
  trades:     ApiSettledTrade[]
  loading:    boolean
}) {
  const divisor     = divisorOf(info)
  const displayName = displayNameOf(info, symbol)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef    = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null)

  // Create chart once per mount
  useEffect(() => {
    if (!containerRef.current) return
    let chart: import('lightweight-charts').IChartApi

    import('lightweight-charts').then(({ createChart, CrosshairMode }) => {
      if (!containerRef.current) return

      chart = createChart(containerRef.current, {
        layout: { background: { color: '#0d0d0d' }, textColor: '#888' },
        grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#242424' },
        timeScale: {
          borderColor: '#242424',
          timeVisible: true,
          secondsVisible: false,
          // Tighter default density — packs more candles per screen.
          barSpacing: 4,
        },
        handleScroll: true,
        handleScale: true,
      })

      const series = chart.addCandlestickSeries({
        upColor:   '#4bb4b4',
        downColor: '#cc2e3d',
        borderUpColor:   '#4bb4b4',
        borderDownColor: '#cc2e3d',
        wickUpColor:   '#4bb4b4',
        wickDownColor: '#cc2e3d',
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

    return () => { chart?.remove() }
  }, []) // eslint-disable-line

  // Reload candles when data changes — OHLC divided for display.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map(c => ({
        time:  c.ts_s as import('lightweight-charts').Time,
        open:  c.open  / divisor,
        high:  c.high  / divisor,
        low:   c.low   / divisor,
        close: c.close / divisor,
      }))
    )
    // scrollToRealTime instead of fitContent — keep the fixed barSpacing
    // density and just position the latest candle at the right edge.
    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, divisor])

  // Trade markers from API history
  useEffect(() => {
    if (!seriesRef.current) return
    const markers = trades
      .filter(t => t.symbol === symbol)
      .map(t => {
        const isUp = t.direction === 'UP'
        const net  = t.won ? t.payout - t.stake : -t.stake
        return {
          time:     Math.floor(t.settled_at_ms / 1000) as import('lightweight-charts').Time,
          position: (isUp ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          color:    t.won ? '#4bb4b4' : '#cc2e3d',
          shape:    (isUp ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          text:     (net >= 0 ? '+' : '') + net.toFixed(0),
          size:     1,
          id:       t.id,
        }
      })
      .sort((a, b) => (a.time as number) - (b.time as number))
    seriesRef.current.setMarkers(markers)
  }, [trades, symbol])

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Symbol + resolution overlay */}
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2 pointer-events-none">
        <span className="text-text font-bold text-lg">{displayName}</span>
        <span className="text-brand text-xs font-semibold bg-brand/10 px-1.5 py-0.5 rounded">
          {resolution}
        </span>
      </div>

      <div ref={containerRef} className="w-full h-full" />

      <ZoomControls chartRef={chartRef} />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/60 text-dim text-sm">
          Loading {resolution} history…
        </div>
      )}
      {!loading && candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-sm">
          No {resolution} data yet — trade data builds over time.
        </div>
      )}
    </div>
  )
}

// ─── Zoom controls ───────────────────────────────────────────────────────────
//
// Three buttons stacked bottom-right of the chart: zoom in, zoom out, fit.
// Zoom works by scaling barSpacing (pixel width per bar) — bigger means
// fewer candles fit on screen (zoomed in); smaller means more candles fit
// (zoomed out). lightweight-charts also handles wheel/pinch natively, but
// explicit buttons help on mobile where pinch-to-zoom collides with the
// page scroll, and on desktop for users who prefer click over scroll.

const ZOOM_MIN_BAR_SPACING = 2
const ZOOM_MAX_BAR_SPACING = 50
const ZOOM_FACTOR = 1.3

function ZoomControls({ chartRef }: {
  chartRef: React.MutableRefObject<import('lightweight-charts').IChartApi | null>
}) {
  const zoom = (factor: number) => {
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()
    const current = ts.options().barSpacing ?? 6
    const next = Math.max(
      ZOOM_MIN_BAR_SPACING,
      Math.min(ZOOM_MAX_BAR_SPACING, current * factor),
    )
    ts.applyOptions({ barSpacing: next })
  }
  const fit = () => chartRef.current?.timeScale().fitContent()

  const btn =
    'w-8 h-8 flex items-center justify-center rounded ' +
    'bg-panel/90 border border-border text-text text-base font-semibold ' +
    'hover:bg-surface hover:border-brand/60 active:scale-95 transition-all ' +
    'shadow-lg backdrop-blur-sm'

  return (
    <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5 pointer-events-auto">
      <button
        type="button"
        onClick={() => zoom(ZOOM_FACTOR)}
        aria-label="Zoom in"
        title="Zoom in"
        className={btn}
      >
        +
      </button>
      <button
        type="button"
        onClick={() => zoom(1 / ZOOM_FACTOR)}
        aria-label="Zoom out"
        title="Zoom out"
        className={btn}
      >
        −
      </button>
      <button
        type="button"
        onClick={fit}
        aria-label="Fit content"
        title="Fit all candles"
        className={btn + ' text-sm'}
      >
        ⤢
      </button>
    </div>
  )
}
