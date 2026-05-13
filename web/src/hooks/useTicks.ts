'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { Tick, Candle } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const WS_URL   = API_BASE.replace(/^http/, 'ws') + '/ws'

const CANDLE_SECONDS = 5  // aggregate ticks into 5-second candles

export function useTicks(symbol: string) {
  const [lastTick,    setLastTick]    = useState<Tick | null>(null)
  const [allTicks,    setAllTicks]    = useState<Record<string, Tick>>({})
  const [candles,     setCandles]     = useState<Candle[]>([])
  const [connected,   setConnected]   = useState(false)

  const wsRef      = useRef<WebSocket | null>(null)
  const candleRef  = useRef<Candle | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildCandle = useCallback((tick: Tick) => {
    const bucket = Math.floor(tick.ts_ms / 1000 / CANDLE_SECONDS) * CANDLE_SECONDS
    setCandles(prev => {
      const last = candleRef.current
      if (last && last.time === bucket) {
        const updated: Candle = {
          time:  bucket,
          open:  last.open,
          high:  Math.max(last.high, tick.mid),
          low:   Math.min(last.low,  tick.mid),
          close: tick.mid,
        }
        candleRef.current = updated
        return [...prev.slice(0, -1), updated]
      } else {
        const fresh: Candle = { time: bucket, open: tick.mid, high: tick.mid, low: tick.mid, close: tick.mid }
        candleRef.current = fresh
        // keep max 500 candles
        return [...prev.slice(-499), fresh]
      }
    })
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
    }

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen  = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      retryTimer.current = setTimeout(connect, 2000)
    }
    ws.onerror = () => ws.close()

    ws.onmessage = (ev) => {
      try {
        const tick: Tick = JSON.parse(ev.data)
        setAllTicks(prev => ({ ...prev, [tick.symbol]: tick }))
        if (tick.symbol === symbol) {
          setLastTick(tick)
          buildCandle(tick)
        }
      } catch { /* ignore malformed */ }
    }
  }, [symbol, buildCandle])

  // reconnect when symbol changes (reset candles)
  useEffect(() => {
    setCandles([])
    candleRef.current = null
    setLastTick(null)
    connect()
    return () => {
      retryTimer.current && clearTimeout(retryTimer.current)
      wsRef.current && wsRef.current.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  return { lastTick, allTicks, candles, connected }
}
