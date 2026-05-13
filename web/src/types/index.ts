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
}

export interface Candle {
  time:  number   // seconds
  open:  number
  high:  number
  low:   number
  close: number
}
