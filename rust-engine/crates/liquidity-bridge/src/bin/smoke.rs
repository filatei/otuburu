//! oanda-smoke — manual sanity check before wiring an LP adapter
//! into the engine. Name is historical; tests whichever adapter
//! `from_env` selects (MetaApi → OANDA → Stub).
//!
//! Usage (MetaApi/Exness):
//!   METAAPI_TOKEN=... METAAPI_ACCOUNT_ID=<uuid> \
//!     cargo run -p liquidity-bridge --bin oanda-smoke
//!
//! Usage (OANDA practice — non-NG jurisdictions):
//!   OANDA_TOKEN=... OANDA_ACCOUNT_ID=001-xxx-xxxxxxx-001 \
//!     cargo run -p liquidity-bridge --bin oanda-smoke
//!
//! Prints the LP-side account summary so you can compare against the
//! broker's web console. If this works against your test account, the
//! token + account-id pair is good and we can flip the engine to
//! route a single passthrough symbol next.

use liquidity_bridge::from_env;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Plain printer — this is a manual tool, not a service.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let adapter = from_env();
    println!("adapter: {}", adapter.name());

    let summary = adapter.account_summary().await?;
    println!("account_id            = {}", summary.account_id);
    println!("currency              = {}", summary.currency);
    println!("balance               = {:.2}", summary.balance);
    println!("unrealised_pl         = {:.2}", summary.unrealised_pl);
    println!("open_position_count   = {}", summary.open_position_count);

    Ok(())
}
