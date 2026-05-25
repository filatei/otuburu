export interface Tick {
  symbol:     string
  ts_ms:      number
  mid:        number
  bid:        number
  ask:        number
  tick_index: number
}

export interface SymbolInfo {
  symbol:        string
  type:          'BOOM_CRASH' | 'FX' | 'CRYPTO'
  leverage:      number
  contract_size: number
  cadence_ms:    number
}

export interface Position {
  id:             string
  account_id:     string
  symbol:         string
  side:           'BUY' | 'SELL'
  lots:           number
  entry:          number
  margin:         number
  notional:       number
  unrealised_pnl: number
  opened_at_ms:   number
}

export interface BinaryOption {
  id:           string
  account_id:   string
  symbol:       string
  direction:    'UP' | 'DOWN'
  stake:        number
  ticks_total:  number
  ticks_left:   number
  entry_mid:    number
  opened_at_ms: number
}

export interface AccountState {
  id:           string
  currency:     string
  balance:      number
  equity:       number
  used_margin:  number
  free_margin:  number
  margin_level: number
  realised_pnl: number
  label?:       string
  is_demo?:     boolean
}

export interface Candle {
  time:  number   // seconds
  open:  number
  high:  number
  low:   number
  close: number
}

/** Candle returned by GET /api/candles (ts_s instead of time) */
export interface ApiCandle {
  ts_s:  number
  open:  number
  high:  number
  low:   number
  close: number
}

export interface SettledTrade {
  id:          string
  symbol:      string
  direction:   'UP' | 'DOWN'
  stake:       number
  ticks_total: number
  entry_mid:   number
  settled_at:  number        // ms timestamp
  outcome:     'win' | 'loss'
  pnl:         number        // net gain/loss (positive = profit, negative = -stake)
}

/** Settled trade returned by GET /api/history */
export interface ApiSettledTrade {
  id:            string
  account_id:    string
  symbol:        string
  direction:     'UP' | 'DOWN'
  stake:         number
  payout:        number
  won:           boolean
  entry_mid:     number
  exit_mid:      number
  ticks_total:   number
  opened_at_ms:  number
  settled_at_ms: number
}

export type Resolution = 'LIVE' | 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1'

export const RESOLUTIONS: Resolution[] = ['LIVE', 'M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']

/** How far back each resolution fetches (ms) */
export const RESOLUTION_WINDOW_MS: Record<Exclude<Resolution, 'LIVE'>, number> = {
  M1:  1 * 24 * 3600 * 1000,          // 1 day
  M5:  7 * 24 * 3600 * 1000,          // 1 week
  M15: 7 * 24 * 3600 * 1000,
  M30: 30 * 24 * 3600 * 1000,         // 1 month
  H1:  365 * 24 * 3600 * 1000,        // 1 year
  H4:  365 * 24 * 3600 * 1000,
  D1:  2 * 365 * 24 * 3600 * 1000,    // 2 years
}
