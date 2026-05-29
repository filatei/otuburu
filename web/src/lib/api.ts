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
export async function createAccountApi(label: string): Promise<{ account: UserAccount; token: string }> {
  const res = await authFetch(`${API_BASE}/wallet/accounts`, {
    method: 'POST',
    body:   JSON.stringify({ label }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.error ?? 'Failed to create account')
  return { account: data.account, token: data.token }
}
