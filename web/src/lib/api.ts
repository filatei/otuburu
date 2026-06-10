/**
 * Authenticated fetch wrapper.
 *
 * Reads the JWT from localStorage and attaches it as an Authorization header.
 * Falls back to a plain fetch if no token is present (unauthenticated calls like
 * /api/symbols or /api/candles don't need a token).
 */

const TOKEN_KEY = 'otuburu_token'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

type FetchOptions = RequestInit & { skipAuth?: boolean }

/**
 * authFetch wraps `fetch` with an optional Bearer token header.
 * Use this for all calls that may require authentication.
 */
export async function authFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { skipAuth = false, ...rest } = options

  const headers = new Headers(rest.headers ?? {})

  if (!skipAuth) {
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }

  // Ensure Content-Type is set for POST/PUT/PATCH
  if (rest.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  return fetch(url, { ...rest, headers })
}

// ─── Account management (Phase 2 multi-account) ──────────────────────────────

import type { UserAccount } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

/** GET /wallet/accounts — list every account the user owns. */
export async function listAccounts(): Promise<UserAccount[]> {
  const res = await authFetch(`${API_BASE}/wallet/accounts`)
  if (!res.ok) throw new Error('Failed to load accounts')
  const data = await res.json() as { accounts?: UserAccount[] }
  return data.accounts ?? []
}

/** POST /wallet/accounts — create a new real account.
 *  Returns the created account plus a refreshed JWT that includes the new
 *  id in its `aids` claim, so the caller can immediately trade against it
 *  without re-authenticating. */
export async function createAccountApi(
  label: string,
  kind: 'real_standard' | 'real_cent' | 'real_micro' = 'real_standard',
): Promise<{ account: UserAccount; token: string }> {
  const res = await authFetch(`${API_BASE}/wallet/accounts`, {
    method: 'POST',
    body:   JSON.stringify({ label, kind }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? 'Failed to create account')
  return { account: data.account, token: data.token }
}

// ─── Broker linking (Sprint 5.9e) ────────────────────────────────────────────
// User-facing API for managing /api/lp-links — the per-user broker
// credentials store backed by pgcrypto. Tokens are write-only from
// the gateway's perspective; we never receive a token back from GET
// even if we sent one on POST.

/** Adapter kinds the user can pick. Must match the backend's CHECK
 *  (kind IN (...)) on user_lp_links. v1 only metaapi is production-
 *  ready — the others are stubbed and will reject orders. */
export type LpLinkKind = 'metaapi' | 'ctrader' | 'oanda'

/** GET /api/lp-links response shape — matches handleLpLinkList in
 *  go-services/gateway/internal/rest/lp_links.go. Token is never
 *  included; engine_mirrored defaults false on GET (the gateway
 *  doesn't currently LEFT JOIN accounts to derive it). */
export interface LpLink {
  id:               string
  kind:             LpLinkKind
  account_id:       string
  region?:          string | null
  label:            string
  created_at:       string
  last_used_at?:    string | null
  /** Only populated on POST response (Sprint 5.9b). The Otuburu-side
   *  broker account UUID that mirrors this link. Frontend uses this to
   *  immediately switch the picker to the new broker. */
  broker_account_id?: string
  /** Sprint 5.9b — true when the gateway successfully called
   *  engine.CreateAccount after persisting the link. False means the
   *  engine missed the create and the reconcile cron (Sprint 5.6)
   *  will sync it on next pass; the user can trade once it does. */
  engine_mirrored?: boolean
}

/** GET /api/lp-links — list every broker link the caller owns. Tokens
 *  are NEVER returned (server-side write-only). */
export async function listLpLinks(): Promise<LpLink[]> {
  const res = await authFetch(`${API_BASE}/api/lp-links`)
  if (!res.ok) throw new Error('Failed to load broker links')
  const data = await res.json() as { links?: LpLink[] }
  return data.links ?? []
}

/** Body for POST /api/lp-links. Token rotation works by re-posting
 *  the same (kind, account_id) — the backend does ON CONFLICT DO
 *  UPDATE and reuses the existing broker account row. */
export interface LpLinkCreateReq {
  kind:       LpLinkKind
  account_id: string
  token:      string
  region?:    string
  label?:     string
}

/** POST /api/lp-links — create or update a broker link. Returns the
 *  link + the auto-provisioned Otuburu broker account UUID (Sprint
 *  5.9b) so the caller can switch into it immediately. */
export async function createLpLink(req: LpLinkCreateReq): Promise<LpLink> {
  const res = await authFetch(`${API_BASE}/api/lp-links`, {
    method: 'POST',
    body:   JSON.stringify(req),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? 'Failed to save broker link')
  return data as LpLink
}

/** DELETE /api/lp-links/:id — remove a broker link. Note: deletes the
 *  user_lp_links row; the matching accounts row (type='broker')
 *  orphans via ON DELETE SET NULL (Sprint 5.9a's weakened CHECK).
 *  The frontend will then see a broker account with no link — engine
 *  routing will reject orders against it (Sprint 5.9c). */
export async function deleteLpLink(id: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/lp-links/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error ?? 'Failed to delete broker link')
  }
}
