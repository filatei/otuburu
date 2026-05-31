'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { Tick, Candle } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const WS_URL   = API_BASE.replace(/^http/, 'ws') + '/ws'

const CANDLE_SECONDS = 5  // aggregate ticks into 5-second candles

// localStorage key for the last-seen tick map. Hydrated on mount so a page
// reload immediately shows the last known bid/ask for every symbol (greyed
// out by MobileSymbolsTab when isMarketOpen returns false). Without this,
// closed-market symbols show "—" until the engine sends a fresh tick — which
// never happens for venues that are actually closed.
const LAST_TICKS_KEY = 'otuburu.lastTicks.v1'
/** How old a persisted tick can be before we discard it. 7 days covers
 *  weekend gaps for FX/metals and long holiday periods for indices.
 *  Anything older is probably misleading at render time. */
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000

function hydrateTickCache(): Record<string, Tick> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(LAST_TICKS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Tick>
    const cutoff = Date.now() - MAX_STALE_MS
    return Object.fromEntries(
      Object.entries(parsed).filter(([, t]) => t?.ts_ms != null && t.ts_ms > cutoff),
    )
  } catch {
    return {}
  }
}

function persistTickCache(ticks: Record<string, Tick>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LAST_TICKS_KEY, JSON.stringify(ticks))
  } catch {
    /* quota exhausted or storage disabled — silent, this is best-effort */
  }
}

// onState is called whenever the gateway pushes a {"type":"state",...} message.
// useAccount passes its applyState here so it receives engine state via WebSocket
// instead of polling GET /api/state every second.
export function useTicks(
  symbol:    string,
  onState?:  (data: unknown) => void,
  accountId?: string,
) {
  // Hydrate the per-symbol tick cache from localStorage on first render.
  // Closed-market symbols (FX/metals/indices on weekends, indices outside
  // 13:30-20:00 UTC) won't receive ticks from the engine until their
  // session reopens, so without hydration the row reads "—" instead of
  // last known price.
  const [lastTick,  setLastTick]  = useState<Tick | null>(() => hydrateTickCache()[symbol] ?? null)
  const [allTicks,  setAllTicks]  = useState<Record<string, Tick>>(() => hydrateTickCache())
  const [candles,   setCandles]   = useState<Candle[]>([])
  const [connected, setConnected] = useState(false)

  // Persist the latest tick map whenever it grows. We throttle implicitly
  // via the state update batching — each setState triggers at most one
  // localStorage write per render cycle.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => persistTickCache(allTicks), 500)
    return () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current) }
  }, [allTicks])

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

  const connect = useCallback((acctId?: string) => {
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
    }

    const url = acctId ? `${WS_URL}?account_id=${encodeURIComponent(acctId)}` : WS_URL
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen  = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      retryTimer.current = setTimeout(() => connect(acctId), 2000)
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

  // Reconnect when symbol OR accountId changes (accountId change = new state route)
  useEffect(() => {
    setCandles([])
    candleRef.current = null
    // Don't wipe lastTick to null — instead seed from the hydrated cache for
    // the new symbol. If a fresh tick arrives the WS handler will replace
    // it; if the market is closed the user still sees the last known price
    // (greyed by the renderer's wall-clock check) instead of "—".
    setLastTick(allTicks[symbol] ?? null)
    connect(accountId)
    return () => {
      retryTimer.current && clearTimeout(retryTimer.current)
      wsRef.current && wsRef.current.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, accountId])

  return { lastTick, allTicks, candles, connected }
}
