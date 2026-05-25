//! In-memory OHLC ring buffers for all chart resolutions.
//!
//! One `OhlcStore` lives on `SharedState`; the tick loop feeds every incoming
//! tick into it. The engine service reads candle slices on demand.
//!
//! Resolutions and retention:
//!   M1  → 1440 candles  (1 day)
//!   M5  → 2016 candles  (~1 week)
//!   M15 → 2016 candles
//!   M30 → 1440 candles
//!   H1  → 8760 candles  (1 year)
//!   H4  → 2190 candles
//!   D1  → 730  candles  (2 years; also flushed to SQLite)

use std::collections::{HashMap, VecDeque};

// ── Candle ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Candle {
    pub ts_s: i64, // unix seconds, floored to resolution boundary
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

// ── Resolution ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Resolution {
    M1,
    M5,
    M15,
    M30,
    H1,
    H4,
    D1,
}

impl Resolution {
    pub fn secs(self) -> i64 {
        match self {
            Resolution::M1 => 60,
            Resolution::M5 => 300,
            Resolution::M15 => 900,
            Resolution::M30 => 1_800,
            Resolution::H1 => 3_600,
            Resolution::H4 => 14_400,
            Resolution::D1 => 86_400,
        }
    }

    pub fn max_candles(self) -> usize {
        match self {
            Resolution::M1 => 1_440,
            Resolution::M5 => 2_016,
            Resolution::M15 => 2_016,
            Resolution::M30 => 1_440,
            Resolution::H1 => 8_760,
            Resolution::H4 => 2_190,
            Resolution::D1 => 730,
        }
    }

    /// Parse a string like "M1", "H4", "D1".
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "M1" => Some(Resolution::M1),
            "M5" => Some(Resolution::M5),
            "M15" => Some(Resolution::M15),
            "M30" => Some(Resolution::M30),
            "H1" => Some(Resolution::H1),
            "H4" => Some(Resolution::H4),
            "D1" => Some(Resolution::D1),
            _ => None,
        }
    }

    pub fn all() -> &'static [Resolution] {
        &[
            Resolution::M1,
            Resolution::M5,
            Resolution::M15,
            Resolution::M30,
            Resolution::H1,
            Resolution::H4,
            Resolution::D1,
        ]
    }
}

// ── OhlcBuffer ────────────────────────────────────────────────────────────────

struct OhlcBuffer {
    res_secs: i64,
    max_len: usize,
    candles: VecDeque<Candle>,
}

impl OhlcBuffer {
    fn new(res: Resolution) -> Self {
        OhlcBuffer {
            res_secs: res.secs(),
            max_len: res.max_candles(),
            candles: VecDeque::with_capacity(res.max_candles()),
        }
    }

    fn on_tick(&mut self, ts_ms: i64, mid: f64) {
        let bucket = (ts_ms / 1000) / self.res_secs * self.res_secs;

        if let Some(last) = self.candles.back_mut() {
            if last.ts_s == bucket {
                if mid > last.high {
                    last.high = mid;
                }
                if mid < last.low {
                    last.low = mid;
                }
                last.close = mid;
                return;
            }
        }

        // Open a new candle.
        let c = Candle {
            ts_s: bucket,
            open: mid,
            high: mid,
            low: mid,
            close: mid,
        };
        self.candles.push_back(c);
        if self.candles.len() > self.max_len {
            self.candles.pop_front();
        }
    }

    fn candles_in_range(&self, from_s: i64, to_s: i64) -> Vec<Candle> {
        self.candles
            .iter()
            .filter(|c| c.ts_s >= from_s && c.ts_s <= to_s)
            .cloned()
            .collect()
    }

    fn last_candle(&self) -> Option<&Candle> {
        self.candles.back()
    }
}

// ── SymbolOhlc ────────────────────────────────────────────────────────────────

struct SymbolOhlc {
    buffers: HashMap<Resolution, OhlcBuffer>,
}

impl SymbolOhlc {
    fn new() -> Self {
        let mut buffers = HashMap::new();
        for &res in Resolution::all() {
            buffers.insert(res, OhlcBuffer::new(res));
        }
        SymbolOhlc { buffers }
    }

    fn on_tick(&mut self, ts_ms: i64, mid: f64) {
        for buf in self.buffers.values_mut() {
            buf.on_tick(ts_ms, mid);
        }
    }
}

// ── OhlcStore (public API) ────────────────────────────────────────────────────

/// Global OHLC store — one `SymbolOhlc` per symbol, all kept in the RwLock.
#[derive(Default)]
pub struct OhlcStore {
    symbols: HashMap<String, SymbolOhlc>,
}

impl OhlcStore {
    /// Feed one tick into every resolution buffer for this symbol.
    pub fn on_tick(&mut self, symbol: &str, ts_ms: i64, mid: f64) {
        self.symbols
            .entry(symbol.to_owned())
            .or_insert_with(SymbolOhlc::new)
            .on_tick(ts_ms, mid);
    }

    /// Return candles for a symbol + resolution in `[from_s, to_s]` (unix seconds).
    pub fn get_candles(
        &self,
        symbol: &str,
        res: Resolution,
        from_s: i64,
        to_s: i64,
    ) -> Vec<Candle> {
        match self.symbols.get(symbol) {
            Some(sym) => match sym.buffers.get(&res) {
                Some(buf) => buf.candles_in_range(from_s, to_s),
                None => vec![],
            },
            None => vec![],
        }
    }

    /// The current (in-progress) D1 candle per symbol — used to flush to SQLite.
    pub fn daily_snapshots(&self) -> Vec<(String, Candle)> {
        self.symbols
            .iter()
            .filter_map(|(sym, so)| {
                so.buffers
                    .get(&Resolution::D1)
                    .and_then(|b| b.last_candle())
                    .map(|c| (sym.clone(), c.clone()))
            })
            .collect()
    }
}
