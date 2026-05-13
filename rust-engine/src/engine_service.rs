//! tonic gRPC service implementation for `EngineService`.

use std::pin::Pin;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use order_book::{Direction, Side};

use crate::pb::{
    engine_service_server::EngineService, AccountState, BinaryOption as PbBinary,
    ClosePositionRequest, ClosePositionResponse, ClosedPosition, GetStateRequest,
    GetSymbolsRequest, GetSymbolsResponse, HouseStats, PlaceBinaryRequest, PlaceBinaryResponse,
    PlaceOrderRequest, PlaceOrderResponse, Position as PbPosition, StateSnapshot,
    SubscribeTicksRequest, SymbolInfo, Tick as PbTick,
};
use crate::state::SharedState;

// ── Conversion helpers ────────────────────────────────────────────────────────

fn to_pb_tick(t: &feed_generator::Tick) -> PbTick {
    PbTick {
        symbol: t.symbol.clone(),
        ts_ms: t.ts,
        mid: t.mid,
        bid: t.bid,
        ask: t.ask,
        tick_index: t.tick_index,
    }
}

fn to_pb_position(p: &order_book::CfdPosition) -> PbPosition {
    PbPosition {
        id: p.id.to_string(),
        account_id: p.account_id.to_string(),
        symbol: p.symbol.clone(),
        side: if p.side == Side::Buy {
            "BUY".into()
        } else {
            "SELL".into()
        },
        lots: p.lots,
        entry: p.entry,
        margin: p.margin,
        notional: p.notional,
        unrealised_pnl: p.unrealised_pnl,
        opened_at_ms: p.opened_at_ms,
    }
}

fn to_pb_binary(b: &order_book::BinaryOption) -> PbBinary {
    PbBinary {
        id: b.id.to_string(),
        account_id: b.account_id.to_string(),
        symbol: b.symbol.clone(),
        direction: if b.direction == Direction::Up {
            "UP".into()
        } else {
            "DOWN".into()
        },
        stake: b.stake,
        ticks_total: b.ticks_total,
        ticks_left: b.ticks_left,
        entry_mid: b.entry_mid,
        opened_at_ms: b.opened_at_ms,
    }
}

// ── Service implementation ────────────────────────────────────────────────────

pub struct EngineServiceImpl {
    state: SharedState,
}

impl EngineServiceImpl {
    pub fn new(state: SharedState) -> Self {
        Self { state }
    }
}

type TickStream = Pin<Box<dyn tokio_stream::Stream<Item = Result<PbTick, Status>> + Send>>;

#[tonic::async_trait]
impl EngineService for EngineServiceImpl {
    type SubscribeTicksStream = TickStream;

    // ── Stream ticks ─────────────────────────────────────────────────────────
    async fn subscribe_ticks(
        &self,
        req: Request<SubscribeTicksRequest>,
    ) -> Result<Response<Self::SubscribeTicksStream>, Status> {
        let filter: Vec<String> = req.into_inner().symbols;
        let rx = self.state.tick_tx.subscribe();

        let stream = BroadcastStream::new(rx).filter_map(move |res| {
            match res {
                Ok(tick) => {
                    if filter.is_empty() || filter.contains(&tick.symbol) {
                        Some(Ok(to_pb_tick(&tick)))
                    } else {
                        None
                    }
                }
                Err(_) => None, // lagged — skip
            }
        });

        Ok(Response::new(Box::pin(stream)))
    }

    // ── State snapshot ───────────────────────────────────────────────────────
    async fn get_state(
        &self,
        _req: Request<GetStateRequest>,
    ) -> Result<Response<StateSnapshot>, Status> {
        let inner = self.state.inner.read().await;
        let book = &inner.book;

        let account = AccountState {
            id: book.account.id.to_string(),
            currency: book.account.currency.clone(),
            balance: book.account.balance,
            equity: book.equity(),
            used_margin: book.free_margin(), // Note: will fix naming below
            free_margin: book.free_margin(),
            margin_level: book.margin_level(),
            realised_pnl: book.account.realised_pnl,
        };

        let positions = book.positions().iter().map(|p| to_pb_position(p)).collect();
        let binaries = book.binaries().iter().map(|b| to_pb_binary(b)).collect();
        let quotes = book
            .quotes()
            .iter()
            .map(|(k, v)| (k.clone(), to_pb_tick(v)))
            .collect();

        let h = &book.house;
        let house = HouseStats {
            total_spread_captured: h.total_spread_captured,
            total_payout_margin: h.total_payout_margin,
            total_client_pnl: h.total_client_pnl,
            house_net: h.house_net(),
            binary_count: h.binary_count,
            binary_wins: h.binary_wins,
            cfd_count: h.cfd_count,
            binary_win_rate: h.binary_win_rate().unwrap_or(0.0),
            payout_multiplier: order_book::PAYOUT_MULTIPLIER,
            expected_house_edge: order_book::BINARY_HOUSE_EDGE,
        };

        Ok(Response::new(StateSnapshot {
            account: Some(account),
            positions,
            binaries,
            quotes,
            house: Some(house),
        }))
    }

    // ── Place CFD order ──────────────────────────────────────────────────────
    async fn place_order(
        &self,
        req: Request<PlaceOrderRequest>,
    ) -> Result<Response<PlaceOrderResponse>, Status> {
        let r = req.into_inner();
        let side = match r.side.as_str() {
            "BUY" => Side::Buy,
            "SELL" => Side::Sell,
            other => return Err(Status::invalid_argument(format!("invalid side: {other}"))),
        };

        let account_id = Uuid::parse_str(&r.account_id)
            .map_err(|_| Status::invalid_argument("invalid account_id"))?;

        let mut inner = self.state.inner.write().await;
        let result = inner.book.open_cfd(account_id, &r.symbol, side, r.lots);

        let resp = match result {
            Ok(pos) => PlaceOrderResponse {
                result: Some(crate::pb::place_order_response::Result::Position(
                    to_pb_position(&pos),
                )),
            },
            Err(e) => PlaceOrderResponse {
                result: Some(crate::pb::place_order_response::Result::Error(
                    e.to_string(),
                )),
            },
        };
        Ok(Response::new(resp))
    }

    // ── Close CFD position ───────────────────────────────────────────────────
    async fn close_position(
        &self,
        req: Request<ClosePositionRequest>,
    ) -> Result<Response<ClosePositionResponse>, Status> {
        let r = req.into_inner();
        let pos_id = Uuid::parse_str(&r.position_id)
            .map_err(|_| Status::invalid_argument("invalid position_id"))?;

        let mut inner = self.state.inner.write().await;
        let result = inner.book.close_cfd(pos_id);

        let resp = match result {
            Ok((pos, pnl)) => {
                let exit = inner
                    .book
                    .quotes()
                    .get(&pos.symbol)
                    .map(|q| if pos.side == Side::Buy { q.bid } else { q.ask })
                    .unwrap_or(0.0);
                ClosePositionResponse {
                    result: Some(crate::pb::close_position_response::Result::Closed(
                        ClosedPosition {
                            position: Some(to_pb_position(&pos)),
                            exit,
                            pnl,
                        },
                    )),
                }
            }
            Err(e) => ClosePositionResponse {
                result: Some(crate::pb::close_position_response::Result::Error(
                    e.to_string(),
                )),
            },
        };
        Ok(Response::new(resp))
    }

    // ── Place binary option ──────────────────────────────────────────────────
    async fn place_binary(
        &self,
        req: Request<PlaceBinaryRequest>,
    ) -> Result<Response<PlaceBinaryResponse>, Status> {
        let r = req.into_inner();
        let direction = match r.direction.as_str() {
            "UP" => Direction::Up,
            "DOWN" => Direction::Down,
            other => {
                return Err(Status::invalid_argument(format!(
                    "invalid direction: {other}"
                )))
            }
        };

        let account_id = Uuid::parse_str(&r.account_id)
            .map_err(|_| Status::invalid_argument("invalid account_id"))?;

        let mut inner = self.state.inner.write().await;
        let result = inner
            .book
            .open_binary(account_id, &r.symbol, direction, r.stake, r.ticks);

        let resp = match result {
            Ok(opt) => PlaceBinaryResponse {
                result: Some(crate::pb::place_binary_response::Result::Binary(
                    to_pb_binary(&opt),
                )),
            },
            Err(e) => PlaceBinaryResponse {
                result: Some(crate::pb::place_binary_response::Result::Error(
                    e.to_string(),
                )),
            },
        };
        Ok(Response::new(resp))
    }

    // ── Symbol catalogue ─────────────────────────────────────────────────────
    async fn get_symbols(
        &self,
        _req: Request<GetSymbolsRequest>,
    ) -> Result<Response<GetSymbolsResponse>, Status> {
        let inner = self.state.inner.read().await;
        let symbols = inner
            .metas
            .iter()
            .map(|m| SymbolInfo {
                symbol: m.symbol.clone(),
                r#type: m.kind.clone(),
                leverage: m.leverage,
                contract_size: m.contract_size,
                cadence_ms: m.cadence_ms as u32,
            })
            .collect();
        Ok(Response::new(GetSymbolsResponse { symbols }))
    }
}
