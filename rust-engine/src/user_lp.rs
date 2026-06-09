//! Per-user LP adapter lookup. Sprint 5.8.
//!
//! Given an Otuburu account UUID, resolves the *user* that owns it
//! (via the wallet's `accounts.user_id` FK), looks up the user's
//! linked broker credentials from `user_lp_links`, decrypts the token
//! via pgcrypto's `pgp_sym_decrypt`, and builds a concrete
//! `LpAdapter` to route the order through.
//!
//! Cache
//! -----
//! Adapters are cached per Otuburu account (`HashMap<Uuid, Arc<dyn
//! LpAdapter>>`) for the lifetime of the engine process. First
//! Passthrough order for an account pays a ~50ms Postgres query +
//! adapter build; subsequent orders hit the cache.
//!
//! Cache invalidation
//! ------------------
//! v1 has NO automatic invalidation. If a user rotates their token
//! via POST /api/lp-links, the engine's cached adapter still holds
//! the old token until either (a) engine restart or (b) the
//! `invalidate(account_id)` method is called from an admin endpoint
//! we add in v2. Documented limitation; practical impact is small
//! because token rotations are rare.
//!
//! Kind support
//! ------------
//! v1 supports MetaApi only — that's the only LP adapter currently
//! production-ready. cTrader and OANDA links get logged as warnings
//! and the lookup returns None (place_order then falls back to the
//! engine-wide global adapter).

use liquidity_bridge::{LpAdapter, MetaApi};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Decoded `user_lp_links` row. The token field carries the
/// PLAINTEXT broker API token after pgcrypto decryption — never log
/// or surface this outside the adapter construction path.
#[derive(Debug, Clone)]
pub struct UserLpLink {
    pub kind: String,
    /// Broker-side account id. For MetaApi: account UUID. For
    /// cTrader: ctidTraderAccountId. For OANDA: account number.
    pub broker_account_id: String,
    /// MetaApi: cluster name. cTrader: env (demo/live). OANDA: env.
    pub region: Option<String>,
    pub token: String,
}

/// Per-account adapter cache backed by Postgres lookups against
/// `user_lp_links`. Built once at boot in `SharedState::new` and
/// shared across the engine via `Arc`.
pub struct UserLpCache {
    /// `None` when Postgres is unreachable — every `get_or_build`
    /// call short-circuits to `None` and the caller falls back to
    /// the engine-wide adapter. This is the graceful degradation
    /// path documented in `pg_db.rs`.
    pg: Option<PgPool>,
    /// pgcrypto symmetric key. Same `LP_LINK_KEY` the gateway uses
    /// to encrypt — must match exactly. If empty, lookups return
    /// `None` (fail closed; decrypting with empty key would surface
    /// garbage).
    key: String,
    map: RwLock<HashMap<Uuid, Arc<dyn LpAdapter>>>,
}

impl UserLpCache {
    pub fn new(pg: Option<PgPool>) -> Self {
        let key = std::env::var("LP_LINK_KEY").unwrap_or_default();
        if pg.is_some() && key.is_empty() {
            tracing::warn!(
                "lp-link: pg pool available but LP_LINK_KEY is unset — \
                 per-user routing disabled. Set LP_LINK_KEY on the engine \
                 container (same value as the gateway)."
            );
        }
        Self {
            pg,
            key,
            map: RwLock::new(HashMap::new()),
        }
    }

    /// Return the adapter for this Otuburu account, building it from
    /// the user's linked broker credentials if not cached.
    ///
    /// Returns `None` when:
    ///   - Postgres pool isn't configured
    ///   - LP_LINK_KEY isn't set
    ///   - the account has no linked broker in `user_lp_links`
    ///   - the link kind isn't yet supported (v1: metaapi only)
    ///   - the link's token is non-ascii (HTTP header constraint)
    ///
    /// Callers fall back to the engine-wide adapter in all `None`
    /// cases.
    pub async fn get_or_build(&self, otuburu_account_id: Uuid) -> Option<Arc<dyn LpAdapter>> {
        // Fast path: read-locked cache lookup.
        if let Some(adapter) = self.map.read().await.get(&otuburu_account_id).cloned() {
            return Some(adapter);
        }

        let pg = self.pg.as_ref()?;
        if self.key.is_empty() {
            return None;
        }

        // pgcrypto: pgp_sym_decrypt returns bytea; ::text decodes
        // UTF-8 (broker tokens are always ASCII). The JOIN to accounts
        // uses the wallet's accounts.id (== Otuburu account UUID) →
        // user_id → user_lp_links.user_id. We pick the most-recently-
        // created link if a user has multiple (v2: let users mark a
        // default per Otuburu account).
        let row = sqlx::query_as::<_, (String, String, Option<String>, String)>(
            r#"
            SELECT ull.kind,
                   ull.account_id,
                   ull.region,
                   pgp_sym_decrypt(ull.token_enc, $1)::text AS token
            FROM accounts a
            JOIN user_lp_links ull ON ull.user_id = a.user_id
            WHERE a.id = $2
            ORDER BY ull.created_at DESC
            LIMIT 1
            "#,
        )
        .bind(&self.key)
        .bind(otuburu_account_id)
        .fetch_optional(pg)
        .await
        .map_err(|e| {
            tracing::error!(
                %otuburu_account_id,
                error = %e,
                "lp-link: postgres lookup failed — falling back to engine-wide adapter"
            );
            e
        })
        .ok()
        .flatten()?;

        let (kind, broker_account_id, region, token) = row;
        let link = UserLpLink {
            kind,
            broker_account_id,
            region,
            token,
        };

        let adapter = build_adapter(&link)?;

        // Touch last_used_at — best-effort, ignore errors. Lets the
        // wallet/admin UI find stale links for cleanup.
        if let Err(e) = sqlx::query(
            "UPDATE user_lp_links SET last_used_at = NOW()
             WHERE user_id = (SELECT user_id FROM accounts WHERE id = $1)
               AND kind = $2",
        )
        .bind(otuburu_account_id)
        .bind(&link.kind)
        .execute(pg)
        .await
        {
            tracing::warn!(error = %e, "lp-link: last_used_at update failed (non-fatal)");
        }

        self.map
            .write()
            .await
            .insert(otuburu_account_id, adapter.clone());
        tracing::info!(
            %otuburu_account_id,
            lp = %adapter.name(),
            "lp-link: user adapter built and cached"
        );
        Some(adapter)
    }

    /// Drop the cached adapter for an account. Called after admin
    /// flips routing_mode OFF or user deletes their link, so the
    /// next Passthrough order re-fetches credentials. v1 doesn't
    /// wire this in yet — the engine just runs with the stale
    /// adapter until restart. Documented limitation.
    #[allow(dead_code)] // wired in v2
    pub async fn invalidate(&self, otuburu_account_id: Uuid) {
        self.map.write().await.remove(&otuburu_account_id);
    }
}

/// Build a concrete LpAdapter from a decrypted user link. Returns
/// None for unsupported kinds (cTrader/OANDA in v1). Future
/// extension: dispatch on `link.kind` to instantiate the matching
/// adapter struct from liquidity-bridge.
fn build_adapter(link: &UserLpLink) -> Option<Arc<dyn LpAdapter>> {
    match link.kind.as_str() {
        "metaapi" => {
            // Default region matches liquidity_bridge::from_env's
            // MetaApi default. London is a common Otuburu-user
            // choice; new-york is MetaApi's primary cluster.
            let region = link
                .region
                .clone()
                .unwrap_or_else(|| "new-york".to_string());
            Some(Arc::new(MetaApi::new(
                link.token.clone(),
                link.broker_account_id.clone(),
                region,
            )))
        }
        other => {
            tracing::warn!(
                kind = %other,
                "lp-link: unsupported adapter kind for per-user routing \
                 (only metaapi is supported in v1) — falling back to engine-wide adapter"
            );
            None
        }
    }
}
