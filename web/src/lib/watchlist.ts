/**
 * Symbol watchlist — the user's curated set of tradeable symbols.
 *
 * The engine exposes ~15 instruments by default (crypto, metals, indices,
 * synthetic boom/crash). Showing all of them on Quotes makes the list
 * noisy and dilutes the "this is the stuff that matters" signal. Instead
 * we start every user on a curated 8-symbol watchlist covering the three
 * asset classes most retail traders touch (metals, crypto, US indices,
 * a flagship synthetic). Anything else is one tap away via the
 * ManageSymbolsSheet.
 *
 * Storage: localStorage only. The watchlist is a UI preference, not
 * authoritative data. Loss-on-clear is acceptable — defaults rehydrate.
 *
 * Format: comma-separated engine symbol IDs (e.g. "cryBTCUSD,XAGUSD,SPX").
 * Stored as a string so the value is human-readable in devtools.
 */

const STORAGE_KEY = 'otuburu.watchlist'

/** First-run default: 9 instruments balanced across asset classes so the
 *  user lands on something tradeable regardless of session — crypto +
 *  synthetics are always open, metals/indices follow market hours.
 *  Engine IDs match rust-engine's symbol registry (cry* prefix for
 *  crypto, three-letter codes for metals, ticker for indices, name+
 *  number for synthetics). The synthetic IDs are the legacy internal
 *  names (BOOM500); their user-facing labels are remapped to the
 *  Otuburu SURGE/PLUNGE/PULSE brand via the engine's display_symbol. */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'cryXAUUSD',  // Gold
  'XAGUSD',     // Silver
  'cryBTCUSD',  // Bitcoin
  'cryETHUSD',  // Ethereum
  'SPX',        // S&P 500
  'DJI',        // Dow Jones
  'NDX',        // Nasdaq 100
  'BOOM500',    // SURGE-500 (synthetic up-spike)
  'PULSE75',    // PULSE-75 (Volatility 75 — most-traded synthetic class)
]

/** Read the watchlist from localStorage, falling back to DEFAULT_WATCHLIST
 *  on first hit (or when the stored value is corrupt). Always returns a
 *  fresh array so callers can mutate without surprise. SSR-safe via the
 *  typeof guard — Next.js's first server render lands on the default. */
export function getWatchlist(): string[] {
  if (typeof window === 'undefined') return [...DEFAULT_WATCHLIST]
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw == null) return [...DEFAULT_WATCHLIST]
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean)
  // Empty after parse → user manually cleared, honour it (they'll see an
  // empty Quotes list with the "+ Add" affordance prominent).
  return ids
}

/** Persist a watchlist. Pass an empty array to clear (the next read still
 *  honours the empty state rather than rehydrating defaults — explicit
 *  user action wins over the default). */
export function setWatchlist(ids: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, ids.join(','))
}
