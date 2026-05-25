//! tonic gRPC service implementation for `EngineService`.

use std::pin::Pin;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use order_book::{Direction, Side};

use crate::pb::{
    engine_service_server::EngineService, AccountState, BinaryOption as PbBinary,
    Candle as PbCandle, ClosePositionRequest, ClosePositionResponse, ClosedPosition,
    CloseSpotRequest, CloseSpotResponse, ClosedSpot,
    CreateAccountRequest, CreateAccountResponse, GetCandlesRequest, GetCandlesResponse,
    GetStateRequest, GetSymbolsRequest, GetSymbolsResponse, GetTradeHistoryRequest,
    GetTradeHistoryResponse, HouseStats, ListAccountsRequest, ListAccountsResponse,
    PlaceBinaryRequest, PlaceBinaryResponse, PlaceOrderRequest, PlaceOrderResponse,
    PlaceSpotRequest, PlaceSpotResponse,
    Position as PbPosition, SettledTrade as PbSettledTrade, SpotPosition as PbSpot,
    StateSnapshot, SubscribeTicksRequest, SymbolInfo, Tick as PbTick,
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
        tp_profit: p.tp_profit.unwrap_or(0.0),
        sl_loss: p.sl_loss.unwrap_or(0.0),
    }
}

fn to_pb_spot(p: &order_book::SpotPosition) -> PbSpot {
    PbSpot {
        id: p.id.to_string(),
        account_id: p.account_id.to_string(),
        symbol: p.symbol.clone(),
        side: if p.side == Side::Buy {
            "BUY".into()
        } else {
            "SELL".into()
        },
        stake: p.stake,
        units: p.units,
        entry: p.entry,
        unrealised_pnl: p.unrealised_pnl,
        opened_at_ms: p.opened_at_ms,
        tp_profit: p.tp_profit.unwrap_or(0.0),
        sl_loss: p.sl_loss.unwrap_or(0.0),
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

fn to_pb_account(book: &order_book::Book) -> AccountState {
    AccountState {
        id: book.account.id.to_string(),
        currency: book.account.currency.clone(),
        balance: book.account.balance,
        equity: book.equity(),
        used_margin: book.used_margin(),
        free_margin: book.free_margin(),
        margin_level: book.margin_level(),
        realised_pnl: book.account.realised_pnl,
        label: book.account.label.clone(),
        is_demo: book.account.is_demo,
    }
}

fn to_pb_house(book: &order_book::Book) -> HouseStats {
    let h = &book.house;
    HouseStats {
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
        spot_count: h.spot_count,
    }
}

/// Parse a required account_id field; return gRPC error on bad UUID.
/// `tonic::Status` is intentionally large; boxing here would break `?` propagation at every
/// call-site, so we suppress the lint instead.
#[allow(clippy::result_large_err)]
fn parse_account_id(s: &str) -> Result<Uuid, Status> {
    if s.is_empty() {
        // Legacy: fall back to the canonical demo account UUID.
        Uuid::parse_str("00000000-0000-4000-8000-000000000001")
            .map_err(|_| Status::internal("demo UUID parse failed"))
    } else {
        Uuid::parse_str(s).map_err(|_| Status::invalid_argument("invalid account_id"))
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

        let stream = BroadcastStream::new(rx).filter_map(move |res| match res {
            Ok(tick) => {
                if filter.is_empty() || filter.contains(&tick.symbol) {
                    Some(Ok(to_pb_tick(&tick)))
                } else {
                    None
                }
            }
            Err(_) => None,
        });

        Ok(Response::new(Box::pin(stream)))
    }

    // ── State snapshot ───────────────────────────────────────────────────────
    async fn get_state(
        &self,
        req: Request<GetStateRequest>,
    ) -> Result<Response<StateSnapshot>, Status> {
        let r = req.into_inner();
        let account_id = parse_account_id(&r.account_id)?;

        // Read-lock first (fast path for existing accounts).
        {
            let inner = self.state.inner.read().await;
            if let Some(book) = inner.books.get(&account_id) {
                let account = to_pb_account(book);
                let positions = book.positions().iter().map(|p| to_pb_position(p)).collect();
                let binaries = book.binaries().iter().map(|b| to_pb_binary(b)).collect();
                let spots = book.spots().iter().map(|s| to_pb_spot(s)).collect();
                let quotes = book
                    .quotes()
                    .iter()
                    .map(|(k, v)| (k.clone(), to_pb_tick(v)))
                    .collect();
                let house = to_pb_house(book);
                return Ok(Response::new(StateSnapshot {
                    account: Some(account),
                    positions,
                    binaries,
                    spots,
                    quotes,
                    house: Some(house),
                }));
            }
        }

        // Account not found — auto-create with write lock.
        let mut inner = self.state.inner.write().await;
        let book = inner.get_or_create_book(account_id, "Demo", true, 0.0);
        let account = to_pb_account(book);
        let positions = book.positions().iter().map(|p| to_pb_position(p)).collect();
        let binaries = book.binaries().iter().map(|b| to_pb_binary(b)).collect();
        let spots = book.spots().iter().map(|s| to_pb_spot(s)).collect();
        let quotes = book
            .quotes()
            .iter()
            .map(|(k, v)| (k.clone(), to_pb_tick(v)))
            .collect();
        let house = to_pb_house(book);
        Ok(Response::new(StateSnapshot {
            account: Some(account),
            positions,
            binaries,
            spots,
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
        let account_id = parse_account_id(&r.account_id)?;

        let tp = if r.tp_profit > 0.0 {
            Some(r.tp_profit)
        } else {
            None
        };
        let sl = if r.sl_loss > 0.0 {
            Some(r.sl_loss)
        } else {
            None
        };

        let mut inner = self.state.inner.write().await;
        let book = inner.get_or_create_book(account_id, "Demo", true, 0.0);
        let result = book.open_cfd(account_id, &r.symbol, side, r.lots, tp, sl);

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
        let account_id = parse_account_id(&r.account_id)?;

        let mut inner = self.state.inner.write().await;
        let book = inner
            .books
            .get_mut(&account_id)
            .ok_or_else(|| Status::not_found("account not found"))?;

        let result = book.close_cfd(pos_id);
        let resp = match result {
            Ok((pos, pnl)) => {
                let exit = book
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
        let account_id = parse_account_id(&r.account_id)?;

        let mut inner = self.state.inner.write().await;
        let book = inner.get_or_create_book(account_id, "Demo", true, 0.0);
        let result = book.open_binary(account_id, &r.symbol, direction, r.stake, r.ticks);

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

    // ── Place spot position ──────────────────────────────────────────────────
    async fn place_spot(
        &self,
        req: Request<PlaceSpotRequest>,
    ) -> Result<Response<PlaceSpotResponse>, Status> {
        let r = req.into_inner();
        let side = match r.side.as_str() {
            "BUY" => Side::Buy,
            "SELL" => Side::Sell,
            other => return Err(Status::invalid_argument(format!("invalid side: {other}"))),
        };
        let account_id = parse_account_id(&r.account_id)?;
        let tp = if r.tp_profit > 0.0 {
            Some(r.tp_profit)
        } else {
            None
        };
        let sl = if r.sl_loss > 0.0 {
            Some(r.sl_loss)
        } else {
            None
        };

        let mut inner = self.state.inner.write().await;
        let book = inner.get_or_create_book(account_id, "Demo", true, 0.0);
        let result = book.open_spot(account_id, &r.symbol, side, r.stake, tp, sl);

        let resp = match result {
            Ok(pos) => PlaceSpotResponse {
                result: Some(crate::pb::place_spot_response::Result::Spot(to_pb_spot(
                    &pos,
                ))),
            },
            Err(e) => PlaceSpotResponse {
                result: Some(crate::pb::place_spot_response::Result::Error(e.to_string())),
            },
        };
        Ok(Response::new(resp))
    }

    // ── Close spot position ──────────────────────────────────────────────────
    async fn close_spot(
        &self,
        req: Request<CloseSpotRequest>,
    ) -> Result<Response<CloseSpotResponse>, Status> {
        let r = req.into_inner();
        let spot_id =
            Uuid::parse_str(&r.spot_id).map_err(|_| Status::invalid_argument("invalid spot_id"))?;
        let account_id = parse_account_id(&r.account_id)?;

        let mut inner = self.state.inner.write().await;
        let book = inner
            .books
            .get_mut(&account_id)
            .ok_or_else(|| Status::not_found("account not found"))?;

        let resp = match book.close_spot(spot_id) {
            Ok(closed) => CloseSpotResponse {
                result: Some(crate::pb::close_spot_response::Result::Closed(ClosedSpot {
                    position: Some(to_pb_spot(&closed.position)),
                    exit: closed.exit,
                    pnl: closed.pnl,
                })),
            },
            Err(e) => CloseSpotResponse {
                result: Some(crate::pb::close_spot_response::Result::Error(e.to_string())),
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

    // ── Create account ───────────────────────────────────────────────────────
    async fn create_account(
        &self,
        req: Request<CreateAccountRequest>,
    ) -> Result<Response<CreateAccountResponse>, Status> {
        let r = req.into_inner();
        let account_id = parse_account_id(&r.account_id)?;
        let label = if r.label.is_empty() {
            if r.is_demo {
                "Demo".to_owned()
            } else {
                "Real".to_owned()
            }
        } else {
            r.label.clone()
        };

        let mut inner = self.state.inner.write().await;

        // If the account already exists, sync its balance from the wallet when:
        //   (a) the caller supplied a positive initial_balance, AND
        //   (b) there are no open CFD positions or binary options in-flight.
        // This is the deposit-credit path: wallet credits Postgres then pushes
        // the new balance here so the engine book stays in sync without polling.
        if let Some(book) = inner.books.get_mut(&account_id) {
            if r.initial_balance > 0.0 && book.positions().is_empty() && book.binaries().is_empty()
            {
                book.account.balance = r.initial_balance;
                tracing::info!(
                    %account_id,
                    balance = r.initial_balance,
                    "account balance synced from wallet"
                );
            }
            return Ok(Response::new(CreateAccountResponse {
                account_id: account_id.to_string(),
            }));
        }

        // New account — create with the provided balance (or default demo balance).
        inner.get_or_create_book(account_id, &label, r.is_demo, r.initial_balance);

        tracing::info!(
            %account_id,
            label = %label,
            is_demo = r.is_demo,
            initial_balance = r.initial_balance,
            "account provisioned"
        );

        Ok(Response::new(CreateAccountResponse {
            account_id: account_id.to_string(),
        }))
    }

    // ── List accounts ────────────────────────────────────────────────────────
    async fn list_accounts(
        &self,
        req: Request<ListAccountsRequest>,
    ) -> Result<Response<ListAccountsResponse>, Status> {
        let ids: Vec<Uuid> = req
            .into_inner()
            .account_ids
            .iter()
            .filter_map(|s| Uuid::parse_str(s).ok())
            .collect();

        let inner = self.state.inner.read().await;
        let accounts: Vec<AccountState> = if ids.is_empty() {
            // Return all accounts.
            inner.books.values().map(to_pb_account).collect()
        } else {
            ids.iter()
                .filter_map(|id| inner.books.get(id))
                .map(to_pb_account)
                .collect()
        };

        Ok(Response::new(ListAccountsResponse { accounts }))
    }

    // ── Get OHLC candles ─────────────────────────────────────────────────────
    async fn get_candles(
        &self,
        req: Request<GetCandlesRequest>,
    ) -> Result<Response<GetCandlesResponse>, Status> {
        let r = req.into_inner();
        let res = crate::ohlc::Resolution::from_str(&r.resolution).ok_or_else(|| {
            Status::invalid_argument(format!("unknown resolution: {}", r.resolution))
        })?;

        let from_s = r.from_ms / 1000;
        let to_s = if r.to_ms == 0 {
            chrono::Utc::now().timestamp()
        } else {
            r.to_ms / 1000
        };

        // D1 candles: merge in-memory + SQLite history.
        if res == crate::ohlc::Resolution::D1 {
            let mem_candles = {
                let inner = self.state.inner.read().await;
                inner.ohlc.get_candles(&r.symbol, res, from_s, to_s)
            };

            let db_candles = crate::db::get_daily_candles(&self.state.db, &r.symbol, from_s, to_s)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

            // Merge: prefer in-memory for the current partial day.
            let mem_ts: std::collections::HashSet<i64> =
                mem_candles.iter().map(|c| c.ts_s).collect();
            let mut candles: Vec<PbCandle> = db_candles
                .iter()
                .filter(|c| !mem_ts.contains(&c.ts_s))
                .map(|c| PbCandle {
                    ts_s: c.ts_s,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                })
                .collect();
            candles.extend(mem_candles.iter().map(|c| PbCandle {
                ts_s: c.ts_s,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
            }));
            candles.sort_by_key(|c| c.ts_s);

            return Ok(Response::new(GetCandlesResponse {
                resolution: r.resolution.clone(),
                candles,
            }));
        }

        // All other resolutions: in-memory only.
        let inner = self.state.inner.read().await;
        let candles = inner
            .ohlc
            .get_candles(&r.symbol, res, from_s, to_s)
            .into_iter()
            .map(|c| PbCandle {
                ts_s: c.ts_s,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
            })
            .collect();

        Ok(Response::new(GetCandlesResponse {
            resolution: r.resolution,
            candles,
        }))
    }

    // ── Get trade history ────────────────────────────────────────────────────
    async fn get_trade_history(
        &self,
        req: Request<GetTradeHistoryRequest>,
    ) -> Result<Response<GetTradeHistoryResponse>, Status> {
        let r = req.into_inner();
        if r.account_id.is_empty() {
            return Err(Status::invalid_argument("account_id is required"));
        }

        let from_ms = if r.from_ms == 0 {
            // Default: last 30 days
            chrono::Utc::now().timestamp_millis() - 30 * 24 * 3600 * 1000
        } else {
            r.from_ms
        };
        let to_ms = if r.to_ms == 0 {
            chrono::Utc::now().timestamp_millis()
        } else {
            r.to_ms
        };

        let rows = crate::db::get_trade_history(
            &self.state.db,
            &r.account_id,
            &r.symbol,
            from_ms,
            to_ms,
            r.limit,
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        let trades = rows
            .into_iter()
            .map(|row| PbSettledTrade {
                id: row.id,
                account_id: row.account_id,
                symbol: row.symbol,
                direction: row.direction,
                stake: row.stake,
                payout: row.payout,
                won: row.won,
                entry_mid: row.entry_mid,
                exit_mid: row.exit_mid,
                ticks_total: row.ticks_total as u32,
                opened_at_ms: row.opened_at_ms,
                settled_at_ms: row.settled_at_ms,
            })
            .collect();

        Ok(Response::new(GetTradeHistoryResponse { trades }))
    }
}
