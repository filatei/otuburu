'use client'
import { useMemo } from 'react'
import type { Position, SpotPosition, SettledTrade } from '@/types'

/**
 * useDailyPnLBySymbol — aggregate today's net P&L per symbol.
 *
 *   today's P&L = sum of net realised on settled trades since UTC midnight
 *               + sum of unrealised on currently-open positions and spots
 *
 * Returned as a Record<symbolId, number>. Symbols without any P&L activity
 * today are omitted (consumers should treat absence as "nothing yet" and
 * render nothing rather than $0.00 — quieter UI, matches MT5).
 *
 * Memoised on (settledHistory, positions, spots) so Quotes rows don't
 * recompute on every tick — only when settled trades or open exposure
 * actually change.
 */
export function useDailyPnLBySymbol(
  settledHistory: SettledTrade[],
  positions:      Position[],
  spots:          SpotPosition[],
): Record<string, number> {
  return useMemo(() => {
    const startOfTodayUTC = (() => {
      const d = new Date()
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    })()

    const out: Record<string, number> = {}

    // Realised today — net = payout (pnl field) minus stake on win, -stake on loss
    for (const t of settledHistory) {
      if (t.settled_at < startOfTodayUTC) continue
      const net = t.outcome === 'win' ? t.pnl - t.stake : -t.stake
      out[t.symbol] = (out[t.symbol] ?? 0) + net
    }

    // Unrealised — floating P&L on open CFD + Spot positions
    for (const p of positions) {
      out[p.symbol] = (out[p.symbol] ?? 0) + (p.unrealised_pnl ?? 0)
    }
    for (const s of spots) {
      out[s.symbol] = (out[s.symbol] ?? 0) + (s.unrealised_pnl ?? 0)
    }

    return out
  }, [settledHistory, positions, spots])
}
