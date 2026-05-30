import type { Tick, SymbolInfo } from '@/types'

/**
 * Per-class staleness thresholds. Once a tick is older than this for a
 * given symbol class, we treat the market as closed and:
 *   - skip the flash animation on Quotes rows
 *   - disable the SELL/BUY tiles in MobileTradeForm
 *   - render a "Closed" badge in place of the bid/ask
 *
 * The engine stops dispatching ticks for symbols whose underlying venue is
 * closed (market_hours.rs gates dispatch), so the staleness check on the
 * frontend is the visible mirror of the backend gate. Both ends agree.
 *
 * Crypto / synthetic — should never go stale. Give them a generous window
 * so a brief WebSocket hiccup doesn't paint the world as "closed".
 */
const STALE_THRESHOLDS: Record<SymbolInfo['type'], number> = {
  CRYPTO:     5 * 60_000,   // 5 min — sanity bound, normally <1s between ticks
  BOOM_CRASH: 5 * 60_000,   // synthetic, always streaming
  FX:         90_000,       // 90s — FX ticks every ~2s when open
  METAL:      90_000,
  INDEX:      90_000,
}

/** True if the symbol's latest tick is fresh enough that the market is
 *  effectively open. */
export function isMarketOpen(info: SymbolInfo | null, tick: Tick | null | undefined, now: number = Date.now()): boolean {
  if (!info || !tick) return false
  const threshold = STALE_THRESHOLDS[info.type] ?? 90_000
  return (now - tick.ts_ms) <= threshold
}
