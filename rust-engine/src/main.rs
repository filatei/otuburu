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

mod db;
mod engine_service;
mod live_feed;
mod ohlc;
mod persistence;
mod state;
mod tick_loop;

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

    // ── gRPC server ──────────────────────────────────────────────────────────
    let svc = engine_service::EngineServiceImpl::new(shared);

    tonic::transport::Server::builder()
        .add_service(pb::engine_service_server::EngineServiceServer::new(svc))
        .serve(addr)
        .await?;

    Ok(())
}
