'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { Tick, Candle } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const WS_URL   = API_BASE.replace(/^http/, 'ws') + '/ws'

const CANDLE_SECONDS = 5  // aggregate ticks into 5-second candles

// onState is called whenever the gateway pushes a {"type":"state",...} message.
// useAccount passes its applyState here so it receives engine state via WebSocket
// instead of polling GET /api/state every second.
export function useTicks(
  symbol:   string,
  onState?: (data: unknown) => void,
) {
  const [lastTick,  setLastTick]  = useState<Tick | null>(null)
  const [allTicks,  setAllTicks]  = useState<Record<string, Tick>>({})
  const [candles,   setCandles]   = useState<Candle[]>([])
  const [connected, setConnected] = useState(false)

  const wsRef      = useRef<WebSocket | null>(null)
  const candleRef  = useRef<Candle | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onStateRef = useRef(onState)
  onStateRef.current = onState  // always call the latest version without recreating connect()

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
        const msg = JSON.parse(ev.data)

        if (msg.type === 'state') {
          // Push engine state to useAccount without any HTTP request
          onStateRef.current?.(msg.data)
          return
        }

        // Tick message: {type:"tick", data:{...}} or raw tick object
        const tick: Tick = msg.type === 'tick' ? msg.data : msg
        if (!tick?.symbol) return

        setAllTicks(prev => ({ ...prev, [tick.symbol]: tick }))
        if (tick.symbol === symbol) {
          setLastTick(tick)
          buildCandle(tick)
        }
      } catch { /* ignore malformed */ }
    }
  }, [symbol, buildCandle])

  // Reconnect when symbol changes (reset candles)
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
