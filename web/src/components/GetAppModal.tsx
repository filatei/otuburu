'use client'
import { useEffect, useState } from 'react'
import BottomSheet from './BottomSheet'

/** Detect rough device class from User-Agent. Browsers don't expose a clean
 *  "isAndroid" API, so we string-match. iPadOS 13+ reports as Mac so we also
 *  check for touch + Apple platform as a tiebreaker. */
type Platform = 'android' | 'ios' | 'desktop'

function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'desktop'
  const ua = window.navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  // iPadOS 13+ — UA looks like macOS but has touch support.
  if (/Mac/i.test(ua) && 'ontouchend' in document) return 'ios'
  return 'desktop'
}

interface Props {
  open:    boolean
  onClose: () => void
}

/** "Get the App" sheet. Reached from the hamburger drawer → Install section.
 *
 *  Android: direct APK download link. The signed APK lives at
 *  /download/otuburu.apk under web/public/, baked into each Next.js static
 *  export. First install on the user's phone prompts for "install apps from
 *  this source" permission, then proceeds normally.
 *
 *  iOS: no native install path until we ship to the App Store / TestFlight,
 *  so we show the Add-to-Home-Screen PWA instructions. iOS Safari uses the
 *  manifest icon and runs the page in standalone mode — ~80% of native UX
 *  without a Developer Program seat.
 *
 *  Desktop: show both cards with a "Open on your phone to install" note. */
export default function GetAppModal({ open, onClose }: Props) {
  const [platform, setPlatform] = useState<Platform>('desktop')

  useEffect(() => {
    if (open) setPlatform(detectPlatform())
  }, [open])

  return (
    <BottomSheet open={open} onClose={onClose} title="Get the Otuburu App">
      <div className="p-4 space-y-4">
        {platform === 'desktop' && (
          <p className="text-dim text-xs leading-relaxed">
            Open this page on your phone to install. Or scan the QR code below
            with your phone&apos;s camera — same URL, no extra step needed.
          </p>
        )}

        {/* Order cards so the user's platform is on top. */}
        {platform === 'ios' ? (
          <>
            <IosCard primary />
            <AndroidCard primary={false} />
          </>
        ) : (
          <>
            <AndroidCard primary={platform === 'android'} />
            <IosCard primary={false} />
          </>
        )}

        <p className="text-center text-[10px] text-dim/70 pt-2">
          Same account, same balance, same markets — just smoother on a
          dedicated app.
        </p>
      </div>
    </BottomSheet>
  )
}

/** Android card. Direct APK link — Android handles the install. We use a
 *  plain anchor so the browser shows its own "download / open" affordance,
 *  which is more familiar than a JS-triggered flow. */
function AndroidCard({ primary }: { primary: boolean }) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        primary
          ? 'border-brand/40 bg-brand/5'
          : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-start gap-3 mb-3">
        <span className="text-2xl">🤖</span>
        <div className="flex-1 min-w-0">
          <p className="text-text text-sm font-semibold">Android</p>
          <p className="text-dim text-xs">Download the APK and install</p>
        </div>
        {primary && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-brand/15 text-brand">
            you
          </span>
        )}
      </div>

      <a
        href="/download/otuburu.apk"
        download
        className={`block w-full text-center px-4 py-3 rounded-xl text-sm font-semibold transition-colors ${
          primary
            ? 'bg-brand text-black hover:bg-brand/90'
            : 'bg-surface border border-border text-text hover:bg-muted'
        }`}
      >
        Download APK
      </a>

      <p className="text-[10px] text-dim mt-3 leading-relaxed">
        First install asks permission to install from this source — tap
        Settings → Allow → Back → Install. Updates come from this same page;
        we don&apos;t auto-update the APK.
      </p>
    </div>
  )
}

/** iOS card. PWA install only — no App Store / TestFlight yet. Step-by-step
 *  Add-to-Home-Screen instructions, since most users don't know Safari can
 *  do this. */
function IosCard({ primary }: { primary: boolean }) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        primary
          ? 'border-brand/40 bg-brand/5'
          : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-start gap-3 mb-3">
        <span className="text-2xl">🍏</span>
        <div className="flex-1 min-w-0">
          <p className="text-text text-sm font-semibold">iPhone / iPad</p>
          <p className="text-dim text-xs">Add to Home Screen via Safari</p>
        </div>
        {primary && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-brand/15 text-brand">
            you
          </span>
        )}
      </div>

      <ol className="text-text text-xs space-y-2 mb-3">
        <Step n={1}>Open this page in <strong>Safari</strong> (Chrome on iOS can&apos;t install).</Step>
        <Step n={2}>Tap the <strong>Share</strong> icon (square with up arrow) at the bottom of the screen.</Step>
        <Step n={3}>Scroll down → tap <strong>Add to Home Screen</strong>.</Step>
        <Step n={4}>Tap <strong>Add</strong>. The Otuburu icon appears on your Home Screen.</Step>
      </ol>

      <p className="text-[10px] text-dim leading-relaxed">
        A native iOS app via the App Store is on the roadmap. The Home Screen
        install gives you the trading view in standalone mode — no browser
        chrome — and works offline for the UI shell.
      </p>
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-muted text-dim text-[10px] font-bold flex items-center justify-center">
        {n}
      </span>
      <span className="flex-1 leading-relaxed">{children}</span>
    </li>
  )
}
