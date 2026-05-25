/**
 * Authenticated fetch wrapper.
 *
 * Reads the JWT from sessionStorage and attaches it as an Authorization header.
 * Falls back to a plain fetch if no token is present (unauthenticated calls like
 * /api/symbols or /api/candles don't need a token).
 */

const TOKEN_KEY = 'otuburu_token'

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return sessionStorage.getItem(TOKEN_KEY)
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
