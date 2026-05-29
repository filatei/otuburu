'use client'
import { useEffect } from 'react'

/**
 * useAutoFullscreen — defaults the app to fullscreen (browser URL bar hidden)
 * so the experience feels closer to MT5 / a native app.
 *
 * Behaviour:
 *  - On first user interaction (pointerdown or keydown), attempt
 *    requestFullscreen() on the document element. Browsers gate the API
 *    behind a "transient activation", which is why we wait for a gesture
 *    instead of firing on mount.
 *  - Re-arms whenever `armKey` changes — important because the Google
 *    Sign-In button is rendered inside an iframe, so clicks on it during
 *    the auth flow never bubble to document. Passing `user?.id` here from
 *    the caller means the first post-login gesture re-fires the trigger.
 *  - Respects an opt-out: if localStorage `otuburu.fullscreen` is `"off"`
 *    we don't auto-enter. The Drawer's FullscreenItem writes that flag
 *    whenever the user explicitly exits, so they aren't re-trapped.
 *  - Silent on iOS Safari (no Fullscreen API on document element) — those
 *    users still install the PWA via the Home Screen banner for the same
 *    effect.
 *
 * Subtle by design: a single one-shot listener per arm, no UI surface.
 * The drawer's Display section is the user's "exit at will" affordance.
 */

const PREF_KEY = 'otuburu.fullscreen'

export function useAutoFullscreen(armKey: unknown = 'initial') {
  useEffect(() => {
    const docEl = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>
    }
    const supported =
      typeof docEl.requestFullscreen === 'function' ||
      typeof docEl.webkitRequestFullscreen === 'function'
    if (!supported) return

    let cancelled = false

    // Earlier this used { once: true }, which meant a single failed attempt
    // (browser rejecting the request because the transient activation came
    // from inside Google's iframe, or because the auth modal's BottomSheet
    // consumed it) permanently unsubscribed the listener. The user would
    // then have to toggle via the drawer to get fullscreen at all.
    //
    // New design: stay armed and retry on every interaction. Cheap because
    // the handler short-circuits when already fullscreen or when the user
    // has opted out — neither path calls requestFullscreen.
    const enter = async () => {
      if (cancelled) return
      if (document.fullscreenElement) return // already in
      if (localStorage.getItem(PREF_KEY) === 'off') return // user opted out

      try {
        await docEl.requestFullscreen()
        // Persist preference so future sessions know the user is happy
        // with fullscreen; the drawer toggle can flip this back to 'off'.
        localStorage.setItem(PREF_KEY, 'on')
      } catch {
        // Browser blocked the call (no transient activation, permission
        // policy, etc.). Silent — next interaction will get another shot.
      }
    }

    // Capture-phase listener so handlers below us can't stopPropagation
    // away from us. Both pointerdown AND click — pointerdown covers the
    // case where a child element handles the click and prevents bubbling,
    // click is the more permissive default.
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    document.addEventListener('pointerdown', enter, opts)
    document.addEventListener('click',       enter, opts)
    document.addEventListener('keydown',     enter, opts)

    return () => {
      cancelled = true
      document.removeEventListener('pointerdown', enter, opts)
      document.removeEventListener('click',       enter, opts)
      document.removeEventListener('keydown',     enter, opts)
    }
  }, [armKey])
}

/**
 * setFullscreenPref — write the user's explicit preference. Called by the
 * drawer's FullscreenItem so an explicit "Exit fullscreen" sticks across
 * sessions (no nagging re-entry on every page load).
 */
export function setFullscreenPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch { /* private-mode storage block — ignore */ }
}
