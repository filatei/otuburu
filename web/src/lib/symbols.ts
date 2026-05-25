/**
 * Symbol display helpers.
 *
 * The engine stores true prices and uses internal symbol IDs (e.g.
 * "cryBTCUSD"). For retail UX, prices are divided by a per-symbol divisor
 * and the symbol shows its user-facing name (e.g. "BTCUSD"). This module
 * centralises the conversion so every render site uses the same rules.
 *
 * Rules:
 *  - Prices (bid/ask/mid/entry/mark/candle OHLC) are divided for display.
 *  - PnL is in real USD and is NEVER divided.
 *  - Stake is in real USD and is NEVER divided.
 *  - Units (spot position size) are multiplied by the divisor so the user
 *    sees "0.46 BTC-units" instead of "0.00046 BTC".
 *  - When `info` is null/missing, behaviour falls back to divisor=1 and
 *    the raw symbol id — so partial loads still render without breaking.
 */

import type { SymbolInfo } from '@/types'

/** Returns the display divisor for a symbol, defaulting to 1.0 when unknown. */
export function divisorOf(info: SymbolInfo | null | undefined): number {
  return info?.display_divisor && info.display_divisor > 0 ? info.display_divisor : 1
}

/** Returns the user-facing symbol name, falling back to the internal id. */
export function displayNameOf(info: SymbolInfo | null | undefined, fallbackId?: string): string {
  return info?.display_symbol || fallbackId || info?.symbol || ''
}

/** Divides a true price by the symbol's divisor. Returns NaN unchanged. */
export function toDisplayPrice(info: SymbolInfo | null | undefined, truePrice: number): number {
  if (!Number.isFinite(truePrice)) return truePrice
  return truePrice / divisorOf(info)
}

/**
 * Decimal-place rule for price formatting. Bumps up by log10(divisor) so
 * divided values keep useful precision — but capped so we don't emit retail
 * noise like "77.52699".
 *
 * Type defaults: FX=5, METAL=2, CRYPTO=2, BOOM_CRASH=3. The divisor bump is
 * capped at +2 decimals — enough to show typical bid/ask spreads at the
 * display scale (BTC ÷1000 → 4 dp shows spread of 0.0025; ETH ÷10 → 3 dp).
 * Override with the explicit `decimals` argument when a callsite has
 * stronger preferences.
 */
export function priceDecimals(info: SymbolInfo | null | undefined): number {
  if (!info) return 3
  const base =
    info.type === 'FX'         ? 5 :
    info.type === 'METAL'      ? 2 :
    info.type === 'CRYPTO'     ? 2 :
    info.type === 'INDEX'      ? 1 :  // +2 bump → 3 dp (e.g. SPX 7.473)
    /* BOOM_CRASH */             3
  const divisorBump = Math.min(2, Math.max(0, Math.round(Math.log10(divisorOf(info)))))
  return base + divisorBump
}

/** Minimum stake (USD) for a spot trade. Currently a flat $1 across symbols;
 *  could later vary per symbol if a venue has higher floors. */
export const MIN_SPOT_STAKE_USD = 1

/** Format a true price as a display string with divisor + decimals applied. */
export function formatPrice(
  info: SymbolInfo | null | undefined,
  truePrice: number | null | undefined,
  overrideDecimals?: number,
): string {
  if (truePrice === null || truePrice === undefined || !Number.isFinite(truePrice)) return '—'
  const dp = overrideDecimals ?? priceDecimals(info)
  return toDisplayPrice(info, truePrice).toFixed(dp)
}

/** Convert engine-side true units into display units (multiply by divisor). */
export function toDisplayUnits(info: SymbolInfo | null | undefined, trueUnits: number): number {
  if (!Number.isFinite(trueUnits)) return trueUnits
  return trueUnits * divisorOf(info)
}

/** Build a quick lookup from symbol id → SymbolInfo for use in components
 *  that need to resolve metadata for multiple positions at once. */
export function buildSymbolMap(symbols: SymbolInfo[]): Map<string, SymbolInfo> {
  return new Map(symbols.map(s => [s.symbol, s]))
}
