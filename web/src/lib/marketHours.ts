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

/** True if the symbol's latest tick is fresh enough AND the wall-clock
 *  session window for this market type is currently open.
 *
 *  Why both checks: the engine SHOULD stop emitting ticks for closed
 *  venues, but if it ever fails to (synthetic generator regression,
 *  paused live-feed gate, cached-tick re-broadcast), the frontend still
 *  refuses to enable the trade tiles outside session hours. Belt and
 *  braces — the bug that prompted this rewrite was exactly the engine
 *  failing to stop synthetic ticks on weekends for forex pairs. */
export function isMarketOpen(info: SymbolInfo | null, tick: Tick | null | undefined, now: number = Date.now()): boolean {
  if (!info) return false
  // Wall-clock session check first — keeps us honest even if the engine
  // keeps sending ticks for a closed venue.
  if (!isInSession(info.type, new Date(now))) return false
  if (!tick) return false
  const threshold = STALE_THRESHOLDS[info.type] ?? 90_000
  return (now - tick.ts_ms) <= threshold
}

/** Wall-clock session window per market type. Must agree with the engine's
 *  rust-engine/src/market_hours.rs — same boundaries, same UTC, same
 *  rationale. Keep this and the Rust module in lock-step. */
function isInSession(type: SymbolInfo['type'], now: Date): boolean {
  switch (type) {
    case 'CRYPTO':
    case 'BOOM_CRASH':
      return true
    case 'FX':
    case 'METAL':
      return is24x5(now)
    case 'INDEX':
      return isUSCash(now)
    default:
      return true
  }
}

/** FX/metals — Sun 21:00 UTC through Fri 21:00 UTC.
 *
 *  Boundaries match rust-engine `is_open_24_5`. We use the broader 21:00
 *  UTC mark to avoid DST-edge complications; the actual interbank venues
 *  transition between 20:00 and 21:00 UTC depending on the time of year. */
function is24x5(now: Date): boolean {
  const day = now.getUTCDay() // 0 = Sun, 6 = Sat
  const hour = now.getUTCHours()
  if (day === 6) return false                  // Saturday — closed
  if (day === 0) return hour >= 21             // Sunday — closed until 21:00 UTC
  if (day === 5) return hour < 21              // Friday — closes at 21:00 UTC
  return true                                  // Mon-Thu — fully open
}

/** US cash equities — 13:30 UTC through 20:00 UTC, weekdays only.
 *  Matches rust-engine `is_open_us_cash`. Pre/post-market excluded. */
function isUSCash(now: Date): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
  return minuteOfDay >= 13 * 60 + 30 && minuteOfDay < 20 * 60
}
