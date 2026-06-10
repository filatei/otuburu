//! Otuburu Engine — production gRPC server.
//!
//! Wires together:
//!   - `feed-generator`  → tick loop per symbol
//!   - `order-book`      → CFD + binary option book, MTM, stop-out
//!   - `risk-engine`     → pre-trade checks
//!   - `binary-options`  → contract type registry
//!
//! Exposes a tonic gRPC server on `ENGINE_GRPC_ADDR` (default 0.0.0.0:9090)
//! implementing `EngineService` as defined in `proto/engine.proto`.

mod broker_balance;
mod db;
mod engine_service;
mod live_feed;
mod lp_symbols;
mod market_hours;
mod ohlc;
mod persistence;
mod pg_db;
mod reconcile;
mod state;
mod tick_loop;
mod user_lp;

use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::EnvFilter;

/// Generated protobuf / tonic code.
pub mod pb {
    tonic::include_proto!("otuburu.engine.v1");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── Logging ──────────────────────────────────────────────────────────────
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("otuburu_engine=info,warn")),
        )
        .json()
        .init();

    let addr: SocketAddr = std::env::var("ENGINE_GRPC_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:9090".into())
        .parse()?;

    info!("Otuburu engine starting on {}", addr);

    // ── Shared state ─────────────────────────────────────────────────────────
    let shared = state::SharedState::new().await;

    // ── Tick loop (one task per symbol) ──────────────────────────────────────
    tick_loop::start(shared.clone());

    // ── LP reconciliation cron (Sprint 5.6) ──────────────────────────────────
    // Nightly job that compares engine state vs LP state for
    // Passthrough-flagged accounts. Divergences log at ERROR level so
    // monitor.sh errors picks them up. No-op (or near no-op) for
    // engines with zero Passthrough accounts.
    reconcile::start(shared.clone());

    // ── Broker balance poll (Sprint 5.9f) ────────────────────────────────────
    // Every 60s, for each broker-type account, calls the LP adapter's
    // account_summary() and overwrites the engine's in-memory balance +
    // Postgres accounts.balance. This is what makes broker accounts
    // actually tradeable: without it, balance stays at 0 and the engine
    // rejects every order for insufficient margin.
    broker_balance::start(shared.clone());

    // ── gRPC server ──────────────────────────────────────────────────────────
    let svc = engine_service::EngineServiceImpl::new(shared);

    tonic::transport::Server::builder()
        .add_service(pb::engine_service_server::EngineServiceServer::new(svc))
        .serve(addr)
        .await?;

    Ok(())
}
