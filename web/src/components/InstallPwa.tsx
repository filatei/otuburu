'use client'
import { useEffect, useState } from 'react'

/**
 * InstallPwa — handles two concerns:
 *
 *  1. Service worker registration. Mounted once at the root so it fires
 *     as soon as the app loads. No UI rendered for this part.
 *
 *  2. Optional install prompt. Chrome/Android fires a `beforeinstallprompt`
 *     event when the PWA is installable. We capture it and (if the user
 *     hasn't dismissed it) show a small banner at the bottom of the screen
 *     above the tab nav. The user can tap "Install" or dismiss.
 *
 * iOS Safari does not fire `beforeinstallprompt`. Users on iOS install via
 * the Share menu → "Add to Home Screen". We detect iOS Safari and show a
 * brief one-time hint pointing to that flow.
 */

type DeferredPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'otuburu_install_dismissed_at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export default function InstallPwa() {
  const [deferred, setDeferred] = useState<DeferredPrompt | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // ── Register service worker on mount ────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return
    // Only register in production builds — dev SW often fights HMR.
    if (process.env.NODE_ENV !== 'production') return

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(err => {
        // Non-fatal — installability degrades, but the app still works.
        console.warn('[pwa] service worker registration failed:', err)
      })
  }, [])

  // ── Capture install prompt (Android/Chrome) ─────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return

    // If user dismissed recently, don't show the prompt again yet.
    const dismissedAt = +(localStorage.getItem(DISMISS_KEY) || 0)
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) {
      setDismissed(true)
      return
    }

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as DeferredPrompt)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)

    // iOS detection (Safari does not fire beforeinstallprompt)
    const ua = navigator.userAgent
    const isIos = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window)
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (isIos && !isStandalone) {
      setShowIosHint(true)
    }

    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const handleInstall = async () => {
    if (!deferred) return
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'dismissed') {
      localStorage.setItem(DISMISS_KEY, String(Date.now()))
      setDismissed(true)
    }
  }

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setDismissed(true)
    setDeferred(null)
    setShowIosHint(false)
  }

  if (dismissed) return null

  // Android/Chrome — actionable install banner
  if (deferred) {
    return (
      <Banner>
        <span>📲 Install Otuburu — faster load, full screen.</span>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleInstall}
            className="px-3 py-1 rounded bg-brand text-black text-xs font-bold hover:bg-brand/90"
          >
            Install
          </button>
          <button onClick={handleDismiss} className="text-dim text-xs px-2" aria-label="Dismiss">
            ✕
          </button>
        </div>
      </Banner>
    )
  }

  // iOS — instructional hint
  if (showIosHint) {
    return (
      <Banner>
        <span>📲 Add to Home Screen: tap Share → "Add to Home Screen"</span>
        <button onClick={handleDismiss} className="text-dim text-xs px-2 shrink-0" aria-label="Dismiss">
          ✕
        </button>
      </Banner>
    )
  }

  return null
}

/** Bottom-of-screen banner. Sits above the mobile tab nav via safe-area + z-stack. */
function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label="Install Otuburu"
      className="fixed left-2 right-2 bottom-16 md:left-4 md:right-4 md:bottom-4 z-40
                 flex items-center justify-between gap-3
                 bg-panel border border-brand/40 rounded-lg px-3 py-2
                 text-xs text-text shadow-2xl"
    >
      {children}
    </div>
  )
}
