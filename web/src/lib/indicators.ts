/**
 * Technical indicator math — pure functions over an array of OHLC candles.
 *
 * Returns time-value pairs ready for Lightweight Charts' addLineSeries +
 * setData. All series are aligned with the source candles' `ts_s`
 * timestamps so they overlay on the same time axis.
 *
 * Kept dependency-free + memoise-friendly (input array reference equality
 * is enough to skip recomputation). For richer indicators (Bollinger,
 * MACD, RSI) we'd reach for a library, but SMA/EMA are 8 lines each and
 * cover the 80% case for retail trading chart overlays.
 */

export interface Candle {
  ts_s:  number
  open:  number
  high:  number
  low:   number
  close: number
}

export interface IndicatorPoint {
  time:  number  // unix seconds
  value: number
}

/**
 * Simple moving average — equally-weighted mean of the last `period`
 * closes at each candle. First `period - 1` candles produce no output
 * (insufficient lookback).
 */
export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  if (period <= 0 || candles.length < period) return []
  const out: IndicatorPoint[] = []
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i >= period) sum -= candles[i - period].close
    if (i >= period - 1) {
      out.push({ time: candles[i].ts_s, value: sum / period })
    }
  }
  return out
}

/**
 * Exponential moving average — weights recent candles more heavily via
 * smoothing factor k = 2 / (period + 1). Seed at the SMA of the first
 * `period` candles, then recursively apply EMA = close * k + prev * (1-k).
 */
export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  if (period <= 0 || candles.length < period) return []
  const k = 2 / (period + 1)
  const out: IndicatorPoint[] = []
  // Seed with SMA over the first `period` closes.
  let prev = 0
  for (let i = 0; i < period; i++) prev += candles[i].close
  prev /= period
  out.push({ time: candles[period - 1].ts_s, value: prev })
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k)
    out.push({ time: candles[i].ts_s, value: prev })
  }
  return out
}

/** Catalog of available indicators, keyed by the id used in the UI toggle. */
export interface IndicatorDef {
  id:     string
  label:  string
  /** Hex colour for the overlay line. */
  color:  string
  /** Apply the math, returning time/value points. */
  compute(candles: Candle[]): IndicatorPoint[]
}

export const INDICATORS: IndicatorDef[] = [
  { id: 'sma20',  label: 'SMA 20',  color: '#fde047', compute: c => sma(c, 20) },
  { id: 'sma50',  label: 'SMA 50',  color: '#60a5fa', compute: c => sma(c, 50) },
  { id: 'sma200', label: 'SMA 200', color: '#a78bfa', compute: c => sma(c, 200) },
  { id: 'ema20',  label: 'EMA 20',  color: '#34d399', compute: c => ema(c, 20) },
  { id: 'ema50',  label: 'EMA 50',  color: '#f472b6', compute: c => ema(c, 50) },
]
