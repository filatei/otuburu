//! Synthetic price-feed generators for Otuburu.
//!
//! Production port of the Node.js proof-of-concept in `../../engine/generators.js`.
//! All generators use a seeded ChaCha20 CSPRNG (§8.1 of the Architecture Plan)
//! so tick sequences are reproducible given the same seed — critical for the
//! seed commit-reveal scheme.
//!
//! # Generators
//! - [`BoomCrashGenerator`] — Bounded random walk with Poisson upward/downward spikes (§8.2)
//! - [`FxGenerator`]        — Heston-lite stochastic-vol GBM (§8.3)
//! - [`CryptoGenerator`]    — GBM with regime-switching volatility (§8.3)

use anyhow::Result;
use chrono::Utc;
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};

// ──────────────────────────────────────────────────────────────
// Tick type
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tick {
    pub symbol:    String,
    pub ts:        i64,   // Unix millis
    pub mid:       f64,
    pub bid:       f64,
    pub ask:       f64,
    pub tick_index: u64,
}

impl Tick {
    fn new(symbol: &str, mid: f64, half_spread: f64, index: u64) -> Self {
        let ts = Utc::now().timestamp_millis();
        Tick {
            symbol: symbol.to_owned(),
            ts,
            mid,
            bid: round6(mid - half_spread),
            ask: round6(mid + half_spread),
            tick_index: index,
        }
    }
}

fn round6(x: f64) -> f64 {
    (x * 1_000_000.0).round() / 1_000_000.0
}

// ──────────────────────────────────────────────────────────────
// RNG helpers  (ChaCha20 — production-grade CSPRNG)
// ──────────────────────────────────────────────────────────────

fn next_f64(rng: &mut ChaCha20Rng) -> f64 {
    use rand::RngCore;
    (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// Box-Muller transform — N(0,1)
fn gaussian(rng: &mut ChaCha20Rng) -> f64 {
    loop {
        let u = next_f64(rng);
        let v = next_f64(rng);
        if u > 0.0 {
            return (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos();
        }
    }
}

/// Bernoulli approximation of a Poisson arrival
fn poisson_event(rng: &mut ChaCha20Rng, lambda_per_tick: f64) -> bool {
    next_f64(rng) < lambda_per_tick
}

// ──────────────────────────────────────────────────────────────
// Boom / Crash generator  (§8.2)
// ──────────────────────────────────────────────────────────────

pub struct BoomCrashConfig {
    pub symbol:           String,
    pub seed:             u64,
    pub start_price:      f64,
    /// Std-dev of the small random walk per tick
    pub sigma_small:      f64,
    /// Mean spike magnitude
    pub spike_mean:       f64,
    /// Std-dev of spike magnitude
    pub spike_std:        f64,
    /// +1 for Boom (upward spikes), -1 for Crash
    pub spike_direction:  f64,
    /// Expected spikes per tick (e.g. 1/1000 for BOOM1000)
    pub lambda_per_tick:  f64,
    /// Fixed half-spread
    pub half_spread:      f64,
}

pub struct BoomCrashGenerator {
    cfg:        BoomCrashConfig,
    rng:        ChaCha20Rng,
    price:      f64,
    tick_index: u64,
}

impl BoomCrashGenerator {
    pub fn new(cfg: BoomCrashConfig) -> Self {
        let rng = ChaCha20Rng::seed_from_u64(cfg.seed);
        let price = cfg.start_price;
        Self { cfg, rng, price, tick_index: 0 }
    }

    pub fn next_tick(&mut self) -> Tick {
        self.tick_index += 1;
        // small random walk
        self.price += self.cfg.sigma_small * gaussian(&mut self.rng);
        // Poisson spike
        if poisson_event(&mut self.rng, self.cfg.lambda_per_tick) {
            let mag = self.cfg.spike_mean
                + self.cfg.spike_std * gaussian(&mut self.rng).abs();
            self.price += self.cfg.spike_direction * mag;
        }
        // soft mean-reversion towards start price
        self.price += 0.0005 * (self.cfg.start_price - self.price);
        self.price = self.price.max(1.0);

        Tick::new(&self.cfg.symbol, self.price, self.cfg.half_spread, self.tick_index)
    }
}

// ──────────────────────────────────────────────────────────────
// FX generator — Heston-lite (§8.3)
// ──────────────────────────────────────────────────────────────

pub struct FxConfig {
    pub symbol:        String,
    pub seed:          u64,
    /// Long-run anchor price (soft pull)
    pub anchor:        f64,
    /// Drift
    pub mu:            f64,
    /// Long-run variance (theta in Heston)
    pub theta:         f64,
    /// Mean-reversion speed of variance
    pub kappa:         f64,
    /// Vol-of-vol
    pub xi:            f64,
    /// Correlation between price and variance innovations
    pub rho:           f64,
    /// Time step in years (e.g. 1/(252*24*3600) for 1-second ticks)
    pub dt:            f64,
    /// Half-spread in price units
    pub half_spread:   f64,
}

pub struct FxGenerator {
    cfg:        FxConfig,
    rng:        ChaCha20Rng,
    s:          f64,
    v:          f64,
    tick_index: u64,
}

impl FxGenerator {
    pub fn new(cfg: FxConfig) -> Self {
        let s = cfg.anchor;
        let v = cfg.theta;
        let rng = ChaCha20Rng::seed_from_u64(cfg.seed);
        Self { cfg, rng, s, v, tick_index: 0 }
    }

    pub fn next_tick(&mut self) -> Tick {
        self.tick_index += 1;
        let z1 = gaussian(&mut self.rng);
        let z2 = self.cfg.rho * z1
            + (1.0 - self.cfg.rho * self.cfg.rho).sqrt() * gaussian(&mut self.rng);

        let v_clamped = self.v.max(1e-8);
        let dt = self.cfg.dt;

        self.s = self.s
            * ((self.cfg.mu - 0.5 * v_clamped) * dt
                + (v_clamped * dt).sqrt() * z1)
                .exp();
        self.v = (self.v
            + self.cfg.kappa * (self.cfg.theta - self.v) * dt
            + self.cfg.xi * (v_clamped * dt).sqrt() * z2)
            .max(0.0);

        // soft anchor pull
        self.s += 0.00002 * (self.cfg.anchor - self.s);

        Tick::new(&self.cfg.symbol, self.s, self.cfg.half_spread, self.tick_index)
    }
}

// ──────────────────────────────────────────────────────────────
// Crypto generator — GBM + regime-switching vol (§8.3)
// ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Regime { Calm, Storm }

pub struct CryptoConfig {
    pub symbol:            String,
    pub seed:              u64,
    pub anchor:            f64,
    pub mu:                f64,
    pub base_vol:          f64,
    pub high_vol:          f64,
    /// Probability per tick of switching regime
    pub regime_flip_prob:  f64,
    pub dt:                f64,
    /// Spread as a fraction of mid price (basis points / 10000)
    pub spread_bps:        f64,
}

pub struct CryptoGenerator {
    cfg:        CryptoConfig,
    rng:        ChaCha20Rng,
    s:          f64,
    regime:     Regime,
    tick_index: u64,
}

impl CryptoGenerator {
    pub fn new(cfg: CryptoConfig) -> Self {
        let s = cfg.anchor;
        let rng = ChaCha20Rng::seed_from_u64(cfg.seed);
        Self { cfg, rng, s, regime: Regime::Calm, tick_index: 0 }
    }

    pub fn next_tick(&mut self) -> Tick {
        self.tick_index += 1;
        if next_f64(&mut self.rng) < self.cfg.regime_flip_prob {
            self.regime = if self.regime == Regime::Calm { Regime::Storm } else { Regime::Calm };
        }
        let sigma = if self.regime == Regime::Calm { self.cfg.base_vol } else { self.cfg.high_vol };
        let z = gaussian(&mut self.rng);
        self.s = self.s
            * ((self.cfg.mu - 0.5 * sigma * sigma) * self.cfg.dt
                + sigma * self.cfg.dt.sqrt() * z)
                .exp();
        self.s += 0.00001 * (self.cfg.anchor - self.s);

        let half_spread = (self.cfg.spread_bps / 10_000.0) * self.s / 2.0;
        Tick::new(&self.cfg.symbol, self.s, half_spread, self.tick_index)
    }
}

// ──────────────────────────────────────────────────────────────
// Default symbol configs (mirrors generators.js Phase-1 symbols)
// ──────────────────────────────────────────────────────────────

pub fn default_generators() -> Vec<Box<dyn FnMut() -> Tick + Send>> {
    vec![
        Box::new(BoomCrashGenerator::new(BoomCrashConfig {
            symbol: "BOOM1000".into(), seed: 11,
            start_price: 1000.0, sigma_small: 0.15,
            spike_mean: 25.0, spike_std: 10.0,
            spike_direction: 1.0, lambda_per_tick: 1.0 / 1000.0,
            half_spread: 0.25,
        })),
        Box::new(BoomCrashGenerator::new(BoomCrashConfig {
            symbol: "CRASH1000".into(), seed: 13,
            start_price: 1000.0, sigma_small: 0.15,
            spike_mean: 25.0, spike_std: 10.0,
            spike_direction: -1.0, lambda_per_tick: 1.0 / 1000.0,
            half_spread: 0.25,
        })),
        Box::new(BoomCrashGenerator::new(BoomCrashConfig {
            symbol: "BOOM500".into(), seed: 17,
            start_price: 1000.0, sigma_small: 0.18,
            spike_mean: 20.0, spike_std: 8.0,
            spike_direction: 1.0, lambda_per_tick: 1.0 / 500.0,
            half_spread: 0.25,
        })),
        Box::new(FxGenerator::new(FxConfig {
            symbol: "frxEURUSD".into(), seed: 23,
            anchor: 1.0850, mu: 0.0,
            theta: 0.06 * 0.06, kappa: 2.0, xi: 0.30, rho: -0.4,
            dt: 1.0 / (252.0 * 24.0 * 3600.0),
            half_spread: 0.00005,
        })),
        Box::new(FxGenerator::new(FxConfig {
            symbol: "frxGBPUSD".into(), seed: 29,
            anchor: 1.2650, mu: 0.0,
            theta: 0.07 * 0.07, kappa: 2.0, xi: 0.32, rho: -0.4,
            dt: 1.0 / (252.0 * 24.0 * 3600.0),
            half_spread: 0.00006,
        })),
        Box::new(CryptoGenerator::new(CryptoConfig {
            symbol: "cryBTCUSD".into(), seed: 31,
            anchor: 63000.0, mu: 0.0,
            base_vol: 0.6, high_vol: 1.2,
            regime_flip_prob: 0.002,
            dt: 1.0 / (365.0 * 24.0 * 3600.0),
            spread_bps: 8.0,
        })),
        Box::new(CryptoGenerator::new(CryptoConfig {
            symbol: "cryETHUSD".into(), seed: 37,
            anchor: 3200.0, mu: 0.0,
            base_vol: 0.7, high_vol: 1.4,
            regime_flip_prob: 0.002,
            dt: 1.0 / (365.0 * 24.0 * 3600.0),
            spread_bps: 10.0,
        })),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boom1000_ticks_are_deterministic() {
        let cfg1 = BoomCrashConfig {
            symbol: "BOOM1000".into(), seed: 11,
            start_price: 1000.0, sigma_small: 0.15,
            spike_mean: 25.0, spike_std: 10.0,
            spike_direction: 1.0, lambda_per_tick: 1.0 / 1000.0,
            half_spread: 0.25,
        };
        let cfg2 = BoomCrashConfig {
            symbol: "BOOM1000".into(), seed: 11,
            start_price: 1000.0, sigma_small: 0.15,
            spike_mean: 25.0, spike_std: 10.0,
            spike_direction: 1.0, lambda_per_tick: 1.0 / 1000.0,
            half_spread: 0.25,
        };
        let mut g1 = BoomCrashGenerator::new(cfg1);
        let mut g2 = BoomCrashGenerator::new(cfg2);
        for _ in 0..100 {
            let t1 = g1.next_tick();
            let t2 = g2.next_tick();
            assert_eq!(t1.mid, t2.mid, "ticks must be deterministic");
        }
    }

    #[test]
    fn crash1000_never_spikes_up() {
        let mut g = BoomCrashGenerator::new(BoomCrashConfig {
            symbol: "CRASH1000".into(), seed: 99,
            start_price: 1000.0, sigma_small: 0.0,  // no noise
            spike_mean: 50.0, spike_std: 0.0,
            spike_direction: -1.0, lambda_per_tick: 0.5, // spike every ~2 ticks
            half_spread: 0.0,
        });
        let mut prev = 1000.0_f64;
        for _ in 0..200 {
            let t = g.next_tick();
            // With sigma_small=0 the only moves are spikes downward or the mean-reversion pull
            assert!(t.mid <= prev + 0.01, "Crash should never spike up by more than mean-reversion rounding");
            prev = t.mid;
        }
    }

    #[test]
    fn fx_spread_is_correct() {
        let mut g = FxGenerator::new(FxConfig {
            symbol: "frxEURUSD".into(), seed: 1,
            anchor: 1.0850, mu: 0.0,
            theta: 0.06 * 0.06, kappa: 2.0, xi: 0.30, rho: -0.4,
            dt: 1.0 / (252.0 * 24.0 * 3600.0),
            half_spread: 0.00005,
        });
        for _ in 0..50 {
            let t = g.next_tick();
            let spread = (t.ask - t.bid).abs();
            assert!((spread - 0.0001).abs() < 1e-6, "spread should be ~0.0001");
        }
    }
}
