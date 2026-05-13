//! Risk engine — pre-trade checks and circuit-breakers.
//!
//! Provides configurable limits that wrap every order before it
//! reaches the order book. In the demo Node.js engine these were
//! implicit (single account, no caps). The production engine needs
//! explicit, auditable risk rails.
//!
//! # Checks implemented
//! - Max single-order notional
//! - Max total open notional per symbol (symbol exposure cap)
//! - Max total net long/short notional (house book exposure)
//! - Client daily loss limit (drawdown circuit-breaker)
//! - Binary max stake per contract

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    /// Maximum notional per single CFD order (USD)
    pub max_order_notional:       f64,
    /// Maximum aggregate open notional per symbol (USD)
    pub max_symbol_exposure:      f64,
    /// Maximum aggregate house net position (USD)
    pub max_house_net_exposure:   f64,
    /// Maximum daily realised loss a client can sustain before trading is suspended
    pub client_daily_loss_limit:  f64,
    /// Maximum stake on a single binary option (USD)
    pub max_binary_stake:         f64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        RiskConfig {
            max_order_notional:      500_000.0,
            max_symbol_exposure:   5_000_000.0,
            max_house_net_exposure: 10_000_000.0,
            client_daily_loss_limit:   5_000.0,
            max_binary_stake:          1_000.0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RiskError {
    #[error("order notional {notional:.2} exceeds max {max:.2}")]
    OrderTooLarge { notional: f64, max: f64 },
    #[error("symbol {symbol} exposure {current:.2} + {order:.2} would exceed cap {cap:.2}")]
    SymbolExposureExceeded { symbol: String, current: f64, order: f64, cap: f64 },
    #[error("house net exposure {current:.2} + {order:.2} would exceed cap {cap:.2}")]
    HouseExposureExceeded { current: f64, order: f64, cap: f64 },
    #[error("client {account_id} daily loss {loss:.2} exceeds limit {limit:.2}")]
    ClientDailyLossExceeded { account_id: Uuid, loss: f64, limit: f64 },
    #[error("binary stake {stake:.2} exceeds max {max:.2}")]
    BinaryStakeTooLarge { stake: f64, max: f64 },
}

pub struct RiskEngine {
    pub cfg: RiskConfig,
}

impl RiskEngine {
    pub fn new(cfg: RiskConfig) -> Self { RiskEngine { cfg } }

    /// Pre-trade check for a CFD order.
    pub fn check_cfd(
        &self,
        notional:           f64,
        symbol:             &str,
        symbol_exposure:    f64,
        house_net_exposure: f64,
        client_daily_loss:  f64,
        account_id:         Uuid,
    ) -> Result<(), RiskError> {
        if notional > self.cfg.max_order_notional {
            return Err(RiskError::OrderTooLarge {
                notional, max: self.cfg.max_order_notional,
            });
        }
        if symbol_exposure + notional > self.cfg.max_symbol_exposure {
            return Err(RiskError::SymbolExposureExceeded {
                symbol: symbol.into(),
                current: symbol_exposure, order: notional,
                cap: self.cfg.max_symbol_exposure,
            });
        }
        if house_net_exposure + notional > self.cfg.max_house_net_exposure {
            return Err(RiskError::HouseExposureExceeded {
                current: house_net_exposure, order: notional,
                cap: self.cfg.max_house_net_exposure,
            });
        }
        if client_daily_loss.abs() > self.cfg.client_daily_loss_limit {
            return Err(RiskError::ClientDailyLossExceeded {
                account_id, loss: client_daily_loss,
                limit: self.cfg.client_daily_loss_limit,
            });
        }
        Ok(())
    }

    /// Pre-trade check for a binary option.
    pub fn check_binary(
        &self,
        stake:             f64,
        client_daily_loss: f64,
        account_id:        Uuid,
    ) -> Result<(), RiskError> {
        if stake > self.cfg.max_binary_stake {
            return Err(RiskError::BinaryStakeTooLarge {
                stake, max: self.cfg.max_binary_stake,
            });
        }
        if client_daily_loss.abs() > self.cfg.client_daily_loss_limit {
            return Err(RiskError::ClientDailyLossExceeded {
                account_id, loss: client_daily_loss,
                limit: self.cfg.client_daily_loss_limit,
            });
        }
        Ok(())
    }
}
