//! cTrader Open API WebSocket connection.
//!
//! Sprint 5.4b — connection primitives only. Higher-level concerns
//! (`clientMsgId` correlation, reconnect-with-backoff, auth handshake)
//! land in `correlator.rs` (same sprint) and `ctrader.rs` (5.4c).
//!
//! Protocol notes
//! --------------
//! - cTrader Open API uses **binary** WebSocket frames. Each frame
//!   carries exactly one serialized `ProtoMessage` (the envelope that
//!   wraps every request/response). No additional length-prefix — the
//!   WS frame header already provides framing.
//! - TLS-required: only `wss://` accepted, plain `ws://` rejected.
//! - Idle timeout ~10 min on both demo and live; we send a heartbeat
//!   (`ProtoHeartbeatEvent`) every ~25 sec from the correlator layer.
//!
//! Hosts
//! -----
//! - demo: `wss://demo.ctraderapi.com:5036`
//! - live: `wss://live.ctraderapi.com:5036`
//!
//! Why split the read/write halves
//! -------------------------------
//! We need to read continuously (server pushes execution events and
//! heartbeats unprompted) while also writing on demand from the
//! request/response layer. `futures_util::StreamExt::split` gives us
//! a `SplitSink` for writes and `SplitStream` for reads that can run
//! on separate tasks.

use anyhow::{anyhow, Context};
use futures_util::{
    stream::{SplitSink, SplitStream, StreamExt},
    SinkExt,
};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

/// Demo hostport — pre-prod / sandbox cluster. All Sprint 5.4 smoke
/// testing routes here; live only flips on once 5.5 + 5.6 are green
/// AND admin explicitly sets `CTRADER_ENV=live` per account.
pub const DEMO_URL: &str = "wss://demo.ctraderapi.com:5036";

/// Live hostport — production cluster. Routes real money. Do not
/// use without admin sign-off + Sprint 5.6 reconcile cron deployed.
pub const LIVE_URL: &str = "wss://live.ctraderapi.com:5036";

/// Type alias for the underlying WS stream after TLS upgrade.
/// `MaybeTlsStream` here is "actually TLS" — we reject plain `ws://`
/// at connect time.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Write half — push messages to the LP.
pub type WsSink = SplitSink<WsStream, Message>;

/// Read half — pull messages from the LP (server-pushed and our own
/// response-to-request both arrive here, distinguished by
/// `clientMsgId` at the correlator layer).
pub type WsSource = SplitStream<WsStream>;

/// Connect to the cTrader Open API WebSocket endpoint.
///
/// Returns a split `(sink, source)` pair so the caller can spawn
/// independent reader/writer tasks.
///
/// `env_label`: "demo" (default) routes to `DEMO_URL`, "live" routes
/// to `LIVE_URL`. Any other value is treated as demo + logged as a
/// warning — better to land in the sandbox than misroute real orders.
pub async fn connect(env_label: &str) -> anyhow::Result<(WsSink, WsSource)> {
    let url = match env_label {
        "live" => LIVE_URL,
        "demo" => DEMO_URL,
        other => {
            tracing::warn!(
                env = %other,
                "ctrader: unknown CTRADER_ENV — defaulting to demo cluster"
            );
            DEMO_URL
        }
    };

    tracing::info!(url = %url, "ctrader: opening WebSocket");
    let (ws_stream, http_resp) = connect_async(url)
        .await
        .with_context(|| format!("ctrader connect to {}", url))?;

    // The cTrader server replies with a normal HTTP 101 Switching
    // Protocols. Anything else means the URL was wrong (typo'd cluster,
    // missing port) or the gateway is down — log it so future
    // outages have a clear breadcrumb.
    if !http_resp.status().is_informational() && http_resp.status() != 101 {
        return Err(anyhow!(
            "ctrader: unexpected HTTP {} from upgrade — gateway may be down",
            http_resp.status()
        ));
    }

    Ok(ws_stream.split())
}

/// Send a single serialized `ProtoMessage` payload as a binary WS
/// frame. The payload is the already-encoded protobuf bytes from the
/// caller (`prost::Message::encode_to_vec`).
///
/// Errors here usually mean the connection died mid-flight; the
/// reconnect loop in `ctrader.rs` rebuilds and re-auths.
pub async fn send_frame(sink: &mut WsSink, payload: Vec<u8>) -> anyhow::Result<()> {
    // tokio-tungstenite 0.24 accepts Vec<u8> directly via the Bytes
    // From impl chain; no explicit .into() needed (clippy::useless_conversion).
    sink.send(Message::Binary(payload))
        .await
        .context("ctrader ws send")
}

/// Read the next binary frame from the source. Returns:
///   - `Ok(Some(bytes))` — a binary frame with the encoded ProtoMessage
///   - `Ok(None)` — peer closed the connection cleanly (e.g. idle
///     timeout); caller should trigger reconnect
///   - `Err(_)` — protocol error or transport error
///
/// Pings/pongs and other control frames are handled transparently by
/// tokio-tungstenite; we only surface binary data frames here.
pub async fn recv_frame(source: &mut WsSource) -> anyhow::Result<Option<Vec<u8>>> {
    while let Some(frame) = source.next().await {
        let frame = frame.context("ctrader ws recv")?;
        match frame {
            Message::Binary(bytes) => return Ok(Some(bytes.to_vec())),
            Message::Close(reason) => {
                tracing::info!(?reason, "ctrader: peer closed WS");
                return Ok(None);
            }
            // Text frames shouldn't happen on cTrader Open API but
            // log and skip rather than error — being permissive on
            // unknown frame types makes us robust to protocol
            // extensions.
            Message::Text(t) => {
                tracing::debug!(text = %t, "ctrader: ignoring text frame");
                continue;
            }
            // tokio-tungstenite handles Ping/Pong automatically; if
            // we see one here it's the Frame variant after auto-pong.
            // No-op.
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        }
    }
    Ok(None)
}
