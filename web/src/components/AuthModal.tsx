'use client'
import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import BottomSheet from './BottomSheet'

interface Props {
  onSuccess: (credential: string) => Promise<void>
  error?:    string | null
  /** Optional close handler. When omitted the sheet renders without a
   *  dismiss affordance — used for the gated auth screen where users must
   *  sign in to use the app. */
  onClose?:  () => void
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ''

/** Distinguishes the two sign-in implementations:
 *  - Web (browser, PWA installed on iOS Home Screen): Google Identity Services
 *    JS library. Renders the official Google button.
 *  - Native (APK installed on Android via Capacitor): the
 *    @codetrix-studio/capacitor-google-auth plugin. GIS refuses to render
 *    inside Android WebViews for security reasons, so we have to use the
 *    native Google Sign-In SDK instead. The plugin returns an ID token
 *    whose audience is the WEB Client ID (configured via server_client_id
 *    in android/app/src/main/res/values/strings.xml), so the existing
 *    backend audience check works unchanged. */
const isNativePlatform =
  typeof window !== 'undefined' && Capacitor.isNativePlatform()

export default function AuthModal({ onSuccess, error: externalError, onClose }: Props) {
  const btnRef                    = useRef<HTMLDivElement>(null)
  const [internalError, setInternalError] = useState<string | null>(null)
  const [loading,       setLoading]       = useState(false)
  /** True once the native plugin has been initialised; gates the button. */
  const [nativeReady,   setNativeReady]   = useState(false)

  const displayError = externalError ?? internalError

  // ── Native (Capacitor) sign-in path ──────────────────────────────────────
  useEffect(() => {
    if (!isNativePlatform) return
    let cancelled = false
    // Dynamic import so the plugin code never ships to web users; only the
    // native bundle has it. Avoids loading the Capacitor bridge polyfills
    // and the plugin runtime when there's no native shell to receive them.
    import('@codetrix-studio/capacitor-google-auth')
      .then(({ GoogleAuth }) =>
        GoogleAuth.initialize({
          clientId: CLIENT_ID,
          scopes:   ['profile', 'email'],
          grantOfflineAccess: false,
        }),
      )
      .then(() => { if (!cancelled) setNativeReady(true) })
      .catch((err: unknown) => {
        if (cancelled) return
        setInternalError('Failed to initialise Google Sign-In on this device.')
        console.error('[AuthModal] GoogleAuth.initialize failed', err)
      })
    return () => { cancelled = true }
  }, [])

  const handleNativeSignIn = async () => {
    setInternalError(null)
    setLoading(true)
    try {
      const { GoogleAuth } = await import('@codetrix-studio/capacitor-google-auth')
      const result = await GoogleAuth.signIn()
      // Plugin types: result.authentication.idToken is the JWT we POST to
      // /auth/google — audience is our Web Client ID per server_client_id
      // config, so the backend's existing audience check accepts it.
      const idToken = result?.authentication?.idToken
      if (!idToken) throw new Error('Google did not return an ID token')
      await onSuccess(idToken)
    } catch (err: any) {
      // Native plugin throws with a code like '12501' on user cancel — show
      // a soft message rather than scary error text.
      const msg = err?.message ?? String(err)
      if (/cancel|12501/i.test(msg)) {
        setInternalError(null)
      } else {
        setInternalError(`Sign-in failed: ${msg}`)
      }
    } finally {
      setLoading(false)
    }
  }

  // ── Web (GIS) sign-in path ───────────────────────────────────────────────
  useEffect(() => {
    if (isNativePlatform) return  // native path handles it
    if (!CLIENT_ID || typeof window === 'undefined') return

    const init = () => {
      const g = (window as any).google
      if (!g) return

      // Always cancel any pending prompt before re-initialising
      try { g.accounts.id.cancel() } catch (_) {}

      g.accounts.id.initialize({
        client_id:   CLIENT_ID,
        callback:    async (res: { credential: string }) => {
          setInternalError(null)
          setLoading(true)
          try {
            await onSuccess(res.credential)
          } catch (err: any) {
            setInternalError(err?.message ?? 'Sign-in failed. Please try again.')
          } finally {
            setLoading(false)
          }
        },
        auto_select: false,
      })

      if (btnRef.current) {
        g.accounts.id.renderButton(btnRef.current, {
          theme:  'filled_black',
          size:   'large',
          text:   'signin_with',
          width:  280,
          shape:  'rectangular',
        })
      }
    }

    if ((window as any).google?.accounts) {
      init()
    } else {
      const script    = document.createElement('script')
      script.src      = 'https://accounts.google.com/gsi/client'
      script.async    = true
      script.defer    = true
      script.onload   = init
      document.head.appendChild(script)
    }
  }, [onSuccess])

  const handlePrompt = () => {
    const g = (window as any).google
    if (g?.accounts?.id) g.accounts.id.prompt()
  }

  // Gate-mode (no onClose) — render a tap-noop so the sheet stays put.
  // The user must sign in; backdrop dismiss would just put them back at a
  // blank screen with no recourse.
  const handleClose = onClose ?? (() => {})

  return (
    <BottomSheet open={true} onClose={handleClose}>
      <div className="p-8 flex flex-col items-center gap-6">

        {/* Logo */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-brand font-bold text-3xl tracking-tight">OTUBURU</span>
          <span className="text-dim text-xs uppercase tracking-widest">Synthetic Trading</span>
        </div>

        <div className="w-full h-px bg-border" />

        <div className="text-center">
          <p className="text-text text-sm font-medium mb-1">Welcome</p>
          <p className="text-dim text-xs">Sign in to access your trading account</p>
          {/* Below the welcome — the headline of the value prop. "Zero
              commission" is industry-standard phrasing for spread-based
              brokers (Robinhood, eToro, Plus500 all use it) and tells
              cross-shoppers the obvious comparison point versus stock
              brokers that charge per-trade fees. */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            <span className="px-2 py-0.5 rounded-full bg-up/10 text-up text-[10px] font-bold uppercase tracking-wider">
              Zero commission
            </span>
            <span className="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-[10px] font-bold uppercase tracking-wider">
              From $1
            </span>
            <span className="px-2 py-0.5 rounded-full bg-surface text-dim text-[10px] font-bold uppercase tracking-wider border border-border">
              24/7 markets
            </span>
          </div>
        </div>

        {/* Error banner */}
        {displayError && (
          <div className="w-full px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-down text-xs text-center">
            {displayError}
          </div>
        )}

        {/* Google Sign-In button — native (Capacitor) and web have totally
            different rendering paths. Native uses our own styled button +
            the @codetrix-studio plugin; web uses the GIS-rendered button. */}
        {CLIENT_ID ? (
          <div className="flex flex-col items-center gap-3 w-full">
            {loading ? (
              <div className="text-dim text-xs">Signing in…</div>
            ) : isNativePlatform ? (
              <button
                onClick={handleNativeSignIn}
                disabled={!nativeReady}
                className="w-[280px] flex items-center justify-center gap-2 px-4 py-3 rounded-md bg-[#1f1f1f] hover:bg-[#2a2a2a] border border-[#3c4043] text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {/* Inline Google "G" SVG — avoids dependency on an icon font
                    or external svg file inside the WebView. */}
                <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                  <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                  <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                  <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                </svg>
                <span>{nativeReady ? 'Sign in with Google' : 'Loading…'}</span>
              </button>
            ) : (
              <>
                <div ref={btnRef} />
                {/* Fallback — shown when the rendered button is stale or hidden */}
                <button
                  onClick={handlePrompt}
                  className="text-dim text-[10px] underline underline-offset-2 hover:text-text transition-colors"
                >
                  Sign in with a different account
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="text-down text-xs text-center">
            NEXT_PUBLIC_GOOGLE_CLIENT_ID not set
          </div>
        )}

        <p className="text-dim text-[10px] text-center leading-relaxed">
          Demo account • $10,000 virtual balance<br />
          Deposit real USDT to trade live
        </p>
      </div>
    </BottomSheet>
  )
}
