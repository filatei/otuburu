'use client'
import { useEffect, useRef, useState } from 'react'
import type {
  Candle, Tick, BinaryOption, SettledTrade, Resolution, ApiSettledTrade, SymbolInfo,
  Position, SpotPosition,
} from '@/types'
import { RESOLUTIONS } from '@/types'
import { useChartHistory } from '@/hooks/useChartHistory'
import { displayNameOf, divisorOf, toDisplayPrice } from '@/lib/symbols'
import { INDICATORS } from '@/lib/indicators'

interface Props {
  candles:          Candle[]
  lastTick:         Tick | null
  symbol:           string
  info?:            SymbolInfo | null  // optional, for display divisor + display name
  accountId?:       string
  binaries?:        BinaryOption[]      // open binaries  → entry-price dashed lines
  positions?:       Position[]          // open CFDs      → entry-price solid lines (MT5-style)
  spots?:           SpotPosition[]      // open Spots     → entry-price solid lines (MT5-style)
  settledHistory?:  SettledTrade[]      // settled trades → ▲/▼ markers
}

export default function Chart({
  candles, lastTick, symbol, info = null, accountId = 'demo',
  binaries = [], positions = [], spots = [], settledHistory = [],
}: Props) {
  const [resolution, setResolution] = useState<Resolution>('M1')

  const { candles: histCandles, trades: histTrades, loading } =
    useChartHistory(symbol, resolution, accountId)

  // Reset to M1 when symbol changes — but if M1 ends up empty after the
  // fetch settles (typical for closed FX/metal/index markets where M1
  // isn't backfilled), auto-bump to H1 so the user sees something useful
  // instead of "No M1 data yet". The auto-bump only fires once per symbol
  // change, so user-initiated timeframe selections aren't overridden.
  const autoBumpedRef = useRef(false)
  useEffect(() => {
    autoBumpedRef.current = false
    setResolution('M1')
  }, [symbol])
  useEffect(() => {
    if (autoBumpedRef.current || loading) return
    if (resolution === 'M1' && histCandles.length === 0) {
      autoBumpedRef.current = true
      setResolution('H1')
    }
  }, [resolution, loading, histCandles.length])

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
          positions={positions}
          spots={spots}
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
          positions={positions}
          spots={spots}
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

function LiveChart({ candles, lastTick, symbol, info, binaries, positions, spots, settledHistory }: {
  candles:         Candle[]
  lastTick:        Tick | null
  symbol:          string
  info:            SymbolInfo | null
  binaries:        BinaryOption[]
  positions:       Position[]
  spots:           SpotPosition[]
  settledHistory:  SettledTrade[]
}) {
  const divisor = divisorOf(info)
  const containerRef  = useRef<HTMLDivElement>(null)
  const chartRef      = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef     = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null)
  /** Keyed by binary.id — dashed entry lines for open Rise/Fall. */
  const priceLinesRef = useRef<Map<string, import('lightweight-charts').IPriceLine>>(new Map())
  /** Keyed by `pos:${id}` / `spot:${id}` — solid entry lines for CFD + Spot.
   *  Kept separate from binaries so cleanup ownership is unambiguous. */
  const tradeLinesRef = useRef<Map<string, import('lightweight-charts').IPriceLine>>(new Map())

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
      tradeLinesRef.current.clear()
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

  // Entry-price lines for open CFD + Spot positions (MT5-style). Lines are
  // **solid** (binaries use dashed) so direction is encoded by colour and
  // style is encoded by trade type at a glance. Title shows side, size, and
  // current floating P&L — and we re-apply on every change so the P&L
  // updates as ticks come in without remounting the line.
  useEffect(() => {
    if (!seriesRef.current) return
    import('lightweight-charts').then(({ LineStyle }) => {
      const series = seriesRef.current!
      const openForSymbol = buildOpenTradeRows(positions, spots, symbol, divisor)
      reconcileTradeLines(series, tradeLinesRef.current, openForSymbol, LineStyle.Solid)
    })
  }, [positions, spots, symbol, divisor])

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

function HistoricalChart({ symbol, info, resolution, candles, trades, loading, positions, spots }: {
  symbol:     string
  info:       SymbolInfo | null
  resolution: Resolution
  candles:    { ts_s: number; open: number; high: number; low: number; close: number }[]
  trades:     ApiSettledTrade[]
  loading:    boolean
  positions:  Position[]
  spots:      SpotPosition[]
}) {
  const divisor     = divisorOf(info)
  const displayName = displayNameOf(info, symbol)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef    = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null)
  /** Open-trade entry lines — same machinery as LiveChart so users see
   *  their open positions overlaid regardless of the timeframe they pick. */
  const tradeLinesRef = useRef<Map<string, import('lightweight-charts').IPriceLine>>(new Map())
  /** Active indicator overlays. Map from indicator id (e.g. 'sma20') to
   *  the Lightweight Charts line series. Mutates as the user toggles
   *  items in the Indicators menu. */
  const indicatorSeriesRef = useRef<Map<string, import('lightweight-charts').ISeriesApi<'Line'>>>(new Map())

  // ── OHLC hover overlay state ──────────────────────────────────────────────
  // Updated on every crosshair move; null when cursor leaves the chart area.
  // Renders as a small top-right pill so it doesn't overlap the symbol +
  // resolution badge at top-left or the position price lines.
  const [hoverOHLC, setHoverOHLC] = useState<{
    open: number; high: number; low: number; close: number; time: number
  } | null>(null)

  // ── Active indicators — persisted in localStorage ─────────────────────────
  // Off by default; user opts in via the menu. We store as a comma-separated
  // list of indicator ids so the localStorage value is human-readable in
  // DevTools.
  const [activeIndicators, setActiveIndicators] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    const raw = window.localStorage.getItem('otuburu.chart.indicators') ?? ''
    return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('otuburu.chart.indicators', Array.from(activeIndicators).join(','))
  }, [activeIndicators])
  const [indicatorMenuOpen, setIndicatorMenuOpen] = useState(false)

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

      // Crosshair → OHLC overlay. The handler runs on every mouse-move
      // within the chart bounds and receives a param with seriesData
      // keyed by series ref. We pluck the candle under the cursor and
      // push it into hoverOHLC state for the overlay component to render.
      chart.subscribeCrosshairMove(param => {
        if (!param.time || !param.point) {
          setHoverOHLC(null)
          return
        }
        const bar = param.seriesData.get(series) as
          | { open: number; high: number; low: number; close: number }
          | undefined
        if (!bar) {
          setHoverOHLC(null)
          return
        }
        setHoverOHLC({
          open:  bar.open,
          high:  bar.high,
          low:   bar.low,
          close: bar.close,
          time:  typeof param.time === 'number' ? param.time : 0,
        })
      })

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
      tradeLinesRef.current.clear()
      indicatorSeriesRef.current.clear()
      chart?.remove()
    }
  }, []) // eslint-disable-line

  // Open-trade entry lines — same shape and behaviour as LiveChart so users
  // see their CFD/Spot entries on any timeframe. Title updates live on each
  // P&L tick because the parent re-renders with fresh `positions` arrays.
  useEffect(() => {
    if (!seriesRef.current) return
    import('lightweight-charts').then(({ LineStyle }) => {
      const series = seriesRef.current!
      const openForSymbol = buildOpenTradeRows(positions, spots, symbol, divisor)
      reconcileTradeLines(series, tradeLinesRef.current, openForSymbol, LineStyle.Solid)
    })
  }, [positions, spots, symbol, divisor])

  // Reload candles when data changes — OHLC divided for display.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map(c => ({
        time:  c.ts_s as import('lightweight-charts').Time,
        open:  c.open  / divisor,
        high:  c.high  / divisor,
        low:   c.low   / divisor,
        close: c.close /  divisor,
      }))
    )
    // scrollToRealTime instead of fitContent — keep the fixed barSpacing
    // density and just position the latest candle at the right edge.
    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, divisor])

  // Indicator overlays — reconcile the active set against the rendered
  // line series. Removes series for un-toggled indicators, adds new ones
  // for newly toggled ones, and updates each active indicator's data on
  // every candle change. Display values are divided like the candles
  // so the line overlays on the same price scale.
  useEffect(() => {
    if (!chartRef.current) return
    let cancelled = false
    import('lightweight-charts').then(({ LineStyle: _LineStyle }) => {
      if (cancelled || !chartRef.current) return
      const chart = chartRef.current
      const map = indicatorSeriesRef.current

      // Add series for newly-activated indicators
      for (const def of INDICATORS) {
        const isActive = activeIndicators.has(def.id)
        const has = map.has(def.id)
        if (isActive && !has) {
          const s = chart.addLineSeries({
            color:           def.color,
            lineWidth:       2,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          map.set(def.id, s)
        }
        if (!isActive && has) {
          chart.removeSeries(map.get(def.id)!)
          map.delete(def.id)
        }
      }

      // Push fresh data into each active series
      for (const def of INDICATORS) {
        if (!activeIndicators.has(def.id)) continue
        const series = map.get(def.id)
        if (!series) continue
        const points = def.compute(candles)
        series.setData(
          points.map(p => ({
            time:  p.time as import('lightweight-charts').Time,
            value: p.value / divisor,
          })),
        )
      }
    })
    return () => { cancelled = true }
  }, [candles, divisor, activeIndicators])

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
        {/* OHLC hover panel — only renders while the cursor is over the
            chart and lands on a bar. Stays beside the symbol+timeframe
            badge so the eye doesn't need to jump corners. */}
        {hoverOHLC && (
          <span className="text-[10px] text-dim/80 num bg-panel/70 backdrop-blur-sm rounded px-1.5 py-0.5 border border-border/40">
            O <span className="text-text">{hoverOHLC.open.toFixed(4)}</span>{'  '}
            H <span className="text-up">{hoverOHLC.high.toFixed(4)}</span>{'  '}
            L <span className="text-down">{hoverOHLC.low.toFixed(4)}</span>{'  '}
            C <span className="text-text">{hoverOHLC.close.toFixed(4)}</span>
          </span>
        )}
      </div>

      {/* Indicators menu — top-right. Closed by default; click the button
          to expand the toggle list. Choices persist in localStorage so
          the user's preferred set survives a page reload. */}
      <div className="absolute top-3 right-3 z-10 pointer-events-auto">
        <button
          type="button"
          onClick={() => setIndicatorMenuOpen(v => !v)}
          className="flex items-center gap-1 px-2 py-1 rounded bg-panel/70 border border-border/40 hover:border-brand/60 text-[11px] text-dim hover:text-text transition-colors backdrop-blur-sm"
        >
          <span>ƒ</span>
          <span>Indicators</span>
          {activeIndicators.size > 0 && (
            <span className="text-brand font-semibold">· {activeIndicators.size}</span>
          )}
        </button>
        {indicatorMenuOpen && (
          <div className="mt-1 bg-panel border border-border rounded-lg shadow-lg p-1 min-w-[140px]">
            {INDICATORS.map(def => {
              const active = activeIndicators.has(def.id)
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => {
                    setActiveIndicators(prev => {
                      const next = new Set(prev)
                      if (active) next.delete(def.id)
                      else next.add(def.id)
                      return next
                    })
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[11px] hover:bg-surface transition-colors text-left"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ background: active ? def.color : 'transparent', border: `1px solid ${def.color}` }}
                  />
                  <span className={active ? 'text-text' : 'text-dim'}>{def.label}</span>
                </button>
              )
            })}
            {activeIndicators.size > 0 && (
              <button
                type="button"
                onClick={() => setActiveIndicators(new Set())}
                className="w-full px-2 py-1.5 mt-1 border-t border-border/60 text-[10px] text-dim hover:text-down transition-colors text-center"
              >
                Clear all
              </button>
            )}
          </div>
        )}
      </div>

      <div ref={containerRef} className="w-full h-full" />

      <ZoomControls chartRef={chartRef} />

      {/* MT5 ethos: no loading overlay. Chart starts empty and fills in as
          history arrives. Only show the "no data" hint once the fetch is
          done AND nothing came back — never block the canvas with a spinner.
          See: feedback_mt5_silent_ux.md */}
      {!loading && candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-center text-dim text-sm pointer-events-none px-6">
          <div>
            <p>No {resolution} data for {displayName} yet.</p>
            {/* Backfilled timeframes — present these as the next try.
                M1/M5/M15/M30 are tick-built and stay empty for closed-
                session symbols until ticks resume. H1/D1 always have
                Yahoo/Alpaca history. */}
            {(resolution === 'M1' || resolution === 'M5' || resolution === 'M15' || resolution === 'M30') && (
              <p className="text-[11px] text-dim/60 mt-2">
                Try <span className="text-text">H1</span> or <span className="text-text">D1</span> for historical context.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Open-trade entry-line helpers ──────────────────────────────────────────
//
// Both LiveChart and HistoricalChart need to render dashboard-style entry
// lines for the currently-selected symbol's open CFD + Spot positions. The
// two factor out into:
//
//   buildOpenTradeRows()    — derives the renderable rows from props
//   reconcileTradeLines()   — upserts/removes IPriceLines on a series, keyed
//                             by `pos:${id}` / `spot:${id}` so binaries
//                             (which live in priceLinesRef) never collide.
//
// Lines are SOLID; binaries are dashed. Colour is by side: BUY → up green,
// SELL → down red. Title format: "BUY 0.10 +1.23" / "SELL spot $50 -0.45".

type TradeLineRow = {
  key:   string
  price: number
  color: string
  title: string
}

function buildOpenTradeRows(
  positions: Position[],
  spots:     SpotPosition[],
  symbol:    string,
  divisor:   number,
): TradeLineRow[] {
  const fmtPnl = (pnl: number) =>
    (pnl >= 0 ? '+' : '') + pnl.toFixed(2)

  const fromPositions = positions
    .filter(p => p.symbol === symbol)
    .map<TradeLineRow>(p => ({
      key:   `pos:${p.id}`,
      price: p.entry / divisor,
      color: p.side === 'BUY' ? '#4bb4b4' : '#cc2e3d',
      title: `${p.side} ${p.lots.toFixed(2)} ${fmtPnl(p.unrealised_pnl ?? 0)}`,
    }))

  const fromSpots = spots
    .filter(s => s.symbol === symbol)
    .map<TradeLineRow>(s => ({
      key:   `spot:${s.id}`,
      price: s.entry / divisor,
      color: s.side === 'BUY' ? '#4bb4b4' : '#cc2e3d',
      title: `${s.side} spot $${s.stake.toFixed(0)} ${fmtPnl(s.unrealised_pnl ?? 0)}`,
    }))

  return [...fromPositions, ...fromSpots]
}

function reconcileTradeLines(
  series:    import('lightweight-charts').ISeriesApi<'Candlestick'>,
  store:     Map<string, import('lightweight-charts').IPriceLine>,
  rows:      TradeLineRow[],
  lineStyle: import('lightweight-charts').LineStyle,
) {
  const activeKeys = new Set(rows.map(r => r.key))

  // Remove lines for trades that have closed or moved off-symbol
  store.forEach((line, key) => {
    if (!activeKeys.has(key)) {
      try { series.removePriceLine(line) } catch { /* chart may have remounted */ }
      store.delete(key)
    }
  })

  // Upsert active lines — applyOptions on existing so the P&L title can
  // update each tick without dropping and recreating the price line.
  for (const r of rows) {
    const existing = store.get(r.key)
    if (existing) {
      existing.applyOptions({ price: r.price, title: r.title })
    } else {
      const line = series.createPriceLine({
        price:            r.price,
        color:            r.color,
        lineWidth:        1,
        lineStyle,
        axisLabelVisible: true,
        title:            r.title,
      })
      store.set(r.key, line)
    }
  }
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
