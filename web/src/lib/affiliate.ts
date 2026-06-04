/**
 * Affiliate-code capture + persistence.
 *
 * Landing-page lifecycle:
 *   1. User clicks an introducer's share link: https://otuburu.torama.money/?ref=T4F8K2
 *   2. `captureRefFromUrl()` runs on first paint; if it sees ?ref=, it
 *      stores the code in localStorage and removes the param from the
 *      visible URL (so refresh + bookmark don't repeatedly trigger it).
 *   3. User signs in via Google. `getPendingRef()` returns the code,
 *      which `useAuth.loginWithGoogle()` includes in the POST body.
 *      Backend writes the referrals row only if this is a NEW user —
 *      attribution is one-shot at first signup; returning users with a
 *      different ref are silently ignored.
 *   4. After successful sign-in `clearPendingRef()` runs so a user
 *      logging out + back in doesn't accidentally re-attribute.
 *
 * Why localStorage and not a cookie: the app is a single static export
 * + a same-origin API. We don't need cross-domain cookie persistence;
 * localStorage avoids the cookie-banner complexity for this single
 * piece of data.
 */

const STORAGE_KEY = 'otuburu.pendingRef'

/** Pull `?ref=CODE` out of the current URL, persist it, and clean
 *  the URL bar. Safe to call on every layout render — does nothing if
 *  no ?ref is present. SSR-safe via the typeof guard. */
export function captureRefFromUrl(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const ref = url.searchParams.get('ref')
  if (!ref) return

  // Validate shape: 6 chars from our 32-char alphabet. Rejects junk
  // like ?ref=javascript:alert(1) without round-tripping it.
  const valid = /^[A-Z0-9]{6}$/i.test(ref)
  if (valid) window.localStorage.setItem(STORAGE_KEY, ref.toUpperCase())

  // Strip the param so refreshes don't re-fire, even for invalid codes.
  url.searchParams.delete('ref')
  window.history.replaceState({}, '', url.toString())
}

/** Returns the captured ref or null. Used by the Google sign-in
 *  payload builder. */
export function getPendingRef(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(STORAGE_KEY)
}

/** Wipe the pending ref. Call after a successful sign-up so a user
 *  who signs out + back in isn't re-attributed. */
export function clearPendingRef(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(STORAGE_KEY)
}
