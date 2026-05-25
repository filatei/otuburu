'use client'
import { useEffect, useState, useRef } from 'react'
import type { ApiCandle, ApiSettledTrade, Resolution } from '@/types'
import { RESOLUTION_WINDOW_MS } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface HistoryResult {
  candles:  ApiCandle[]
  trades:   ApiSettledTrade[]
  loading:  boolean
  error:    string | null
}

/**
 * Fetches OHLC candles and trade history from the gateway REST API.
 * Returns empty arrays while loading or on LIVE resolution.
 */
export function useChartHistory(
  symbol:     string,
  resolution: Resolution,
  accountId:  string,
): HistoryResult {
  const [candles,  setCandles]  = useState<ApiCandle[]>([])
  const [trades,   setTrades]   = useState<ApiSettledTrade[]>([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (resolution === 'LIVE') {
      setCandles([])
      setTrades([])
      setLoading(false)
      setError(null)
      return
    }

    // Cancel any in-flight request.
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setError(null)

    const toMs   = Date.now()
    const fromMs = toMs - RESOLUTION_WINDOW_MS[resolution]

    const candleUrl = `${API_BASE}/api/candles?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${fromMs}&to=${toMs}`
    const histUrl   = accountId && accountId !== 'demo'
      ? `${API_BASE}/api/history?account_id=${encodeURIComponent(accountId)}&symbol=${encodeURIComponent(symbol)}&from=${fromMs}&to=${toMs}&limit=500`
      : null

    const fetchCandles = fetch(candleUrl, { signal: ac.signal }).then(r => r.json())
    const fetchTrades  = histUrl
      ? fetch(histUrl, { signal: ac.signal }).then(r => r.json())
      : Promise.resolve({ trades: [] })

    Promise.all([fetchCandles, fetchTrades])
      .then(([candleData, histData]) => {
        if (ac.signal.aborted) return

        const rawCandles: ApiCandle[] = (candleData?.candles ?? []).map((c: {ts_s: unknown; open: unknown; high: unknown; low: unknown; close: unknown}) => ({
          ts_s:  Number(c.ts_s),   // protojson sends int64 as string — coerce to number
          open:  Number(c.open),
          high:  Number(c.high),
          low:   Number(c.low),
          close: Number(c.close),
        }))
        rawCandles.sort((a, b) => a.ts_s - b.ts_s)
        setCandles(rawCandles)

        // Normalise protojson int64 strings to numbers
        const rawTrades: ApiSettledTrade[] = (histData?.trades ?? []).map((t: Record<string, unknown>) => ({
          id:            String(t.id ?? ''),
          account_id:    String(t.account_id ?? ''),
          symbol:        String(t.symbol ?? ''),
          direction:     (t.direction as 'UP' | 'DOWN') ?? 'UP',
          stake:         Number(t.stake ?? 0),
          payout:        Number(t.payout ?? 0),
          won:           Boolean(t.won),
          entry_mid:     Number(t.entry_mid ?? 0),
          exit_mid:      Number(t.exit_mid ?? 0),
          ticks_total:   Number(t.ticks_total ?? 0),
          opened_at_ms:  Number(t.opened_at_ms ?? 0),
          settled_at_ms: Number(t.settled_at_ms ?? 0),
        }))
        setTrades(rawTrades)
        setLoading(false)
      })
      .catch(err => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(String(err))
        setLoading(false)
      })

    return () => ac.abort()
  }, [symbol, resolution, accountId])

  return { candles, trades, loading, error }
}
