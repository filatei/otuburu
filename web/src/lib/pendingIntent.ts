// Pending trade intent — captured when a user tries to trade with insufficient
// real-account balance. We remember exactly what they wanted, send them to the
// deposit flow, and once the balance covers it (the engine balance updates over
// the existing WebSocket state pump when the deposit credits), we resurface the
// captured action for a one-tap confirm. No auto-execution — the user always
// confirms the leveraged/staked order.

import { placeBinary, placeCFD, placeSpot } from '@/hooks/useAccount'

export type PendingIntent =
  | {
      kind: 'binary'
      accountId: string
      symbol: string
      displaySym: string
      dir: 'UP' | 'DOWN'
      stake: number
      ticks: number
      requiredUSD: number
    }
  | {
      kind: 'cfd'
      accountId: string
      symbol: string
      displaySym: string
      side: 'BUY' | 'SELL'
      lots: number
      tp?: number
      sl?: number
      requiredUSD: number
    }
  | {
      kind: 'spot'
      accountId: string
      symbol: string
      displaySym: string
      side: 'BUY' | 'SELL'
      stake: number
      tp?: number
      sl?: number
      requiredUSD: number
    }

/** Human-readable one-liner for the confirm sheet. */
export function intentSummary(i: PendingIntent): string {
  switch (i.kind) {
    case 'binary':
      return `${i.dir === 'UP' ? 'Rise' : 'Fall'} · ${i.displaySym} · $${i.stake.toFixed(2)} · ${i.ticks} ticks`
    case 'cfd':
      return `${i.side} · ${i.displaySym} · ${i.lots.toFixed(4)} lots`
    case 'spot':
      return `Buy · ${i.displaySym} · $${i.stake.toFixed(2)}`
  }
}

/** Re-runs the captured order against the same trade APIs the panels use. */
export async function executeIntent(i: PendingIntent): Promise<{ error?: string }> {
  switch (i.kind) {
    case 'binary':
      return placeBinary(i.accountId, i.symbol, i.dir, i.stake, i.ticks)
    case 'cfd':
      return placeCFD(i.accountId, i.symbol, i.side, i.lots, i.tp, i.sl)
    case 'spot':
      return placeSpot(i.accountId, i.symbol, i.side, i.stake, i.tp, i.sl)
  }
}
