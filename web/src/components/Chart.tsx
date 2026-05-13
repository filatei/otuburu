'use client'
import { useEffect, useRef } from 'react'
import type { Candle, Tick } from '@/types'

interface Props {
  candles:  Candle[]
  lastTick: Tick | null
  symbol:   string
}

export default function Chart({ candles, lastTick, symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<import('lightweight-charts').IChartApi | null>(null)
  const seriesRef    = useRef<import('lightweight-charts').ISeriesApi<'Candlestick'> | null>(null)

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return
    let chart: import('lightweight-charts').IChartApi

    import('lightweight-charts').then(({ createChart, CrosshairMode }) => {
      chart = createChart(containerRef.current!, {
        layout: {
          background: { color: '#0d0d0d' },
          textColor:  '#888888',
        },
        grid: {
          vertLines:  { color: '#1a1a1a' },
          horzLines:  { color: '#1a1a1a' },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#242424' },
        timeScale: {
          borderColor:       '#242424',
          timeVisible:       true,
          secondsVisible:    true,
        },
        handleScroll:  true,
        handleScale:   true,
      })

      const series = chart.addCandlestickSeries({
        upColor:       '#4bb4b4',
        downColor:     '#cc2e3d',
        borderVisible: false,
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
      ro.observe(containerRef.current!)

      return () => ro.disconnect()
    })

    return () => { chart?.remove() }
  }, [])

  // Reload series data when symbol changes or candles reset
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map(c => ({ time: c.time as import('lightweight-charts').Time, open: c.open, high: c.high, low: c.low, close: c.close }))
    )
    chartRef.current?.timeScale().fitContent()
  }, [symbol, candles.length === 0]) // eslint-disable-line

  // Update last candle on every tick
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    const last = candles[candles.length - 1]
    seriesRef.current.update({ time: last.time as import('lightweight-charts').Time, open: last.open, high: last.high, low: last.low, close: last.close })
  }, [lastTick]) // eslint-disable-line

  return (
    <div className="relative w-full h-full">
      {/* Symbol overlay */}
      <div className="absolute top-3 left-4 z-10 flex items-center gap-3 pointer-events-none">
        <span className="text-text font-bold text-lg">{symbol}</span>
        {lastTick && (
          <span className="num text-2xl font-semibold text-text">
            {lastTick.mid.toFixed(lastTick.mid < 10 ? 3 : lastTick.mid < 1000 ? 2 : 2)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="w-full h-full" />
      {candles.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-dim text-sm">
          Waiting for ticks…
        </div>
      )}
    </div>
  )
}
