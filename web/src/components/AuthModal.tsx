'use client'
import { useEffect, useRef, useState } from 'react'
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

export default function AuthModal({ onSuccess, error: externalError, onClose }: Props) {
  const btnRef                    = useRef<HTMLDivElement>(null)
  const [internalError, setInternalError] = useState<string | null>(null)
  const [loading,       setLoading]       = useState(false)

  const displayError = externalError ?? internalError

  useEffect(() => {
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
        </div>

        {/* Error banner */}
        {displayError && (
          <div className="w-full px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-down text-xs text-center">
            {displayError}
          </div>
        )}

        {/* Google Sign-In button */}
        {CLIENT_ID ? (
          <div className="flex flex-col items-center gap-3 w-full">
            {loading ? (
              <div className="text-dim text-xs">Signing in…</div>
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
