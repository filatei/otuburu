'use client'

/**
 * AffiliateSheet — share-your-code panel for the IB / affiliate program.
 *
 * Surfaces the user's auto-generated 6-character code, the share URL
 * built from it, and a single big "Share" button that wraps the native
 * Web Share API on mobile (with a fallback to clipboard copy on desktop /
 * unsupported browsers). The card also shows the running referral
 * count + the configured revenue-share rate, so a serious IB has the
 * basic metrics without leaving the drawer.
 *
 * What's NOT here for v1
 * ──────────────────────
 *  - Per-referral list (who signed up, when) — needs a /wallet/affiliate/list
 *    endpoint; deferred until volume justifies the UI work.
 *  - Earnings ledger — admin handles weekly payouts to savings_wallet
 *    against the existing engine settled-trades data.
 *  - Custom code claim — auto-assigned codes only for v1.
 */

import { useEffect, useState } from 'react'
import { authFetch } from '@/lib/api'
import BottomSheet from './BottomSheet'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface Props {
  open:    boolean
  onClose: () => void
}

interface AffiliateData {
  code:       string
  rate:       number
  introduced: number
}

export default function AffiliateSheet({ open, onClose }: Props) {
  const [data, setData]   = useState<AffiliateData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Fetch the code on first open. Lazy-create happens server-side on
  // first hit so even a brand-new account gets a code immediately.
  useEffect(() => {
    if (!open) return
    setError(null)
    authFetch(`${API_BASE}/wallet/affiliate`)
      .then(r => r.ok ? r.json() : r.json().then((e: { error?: string }) => Promise.reject(e?.error)))
      .then((d: AffiliateData) => setData(d))
      .catch((e: unknown) => setError(typeof e === 'string' ? e : 'Could not load affiliate code'))
  }, [open])

  // Build the share URL from the current origin so it works in PWA +
  // browser + native shells without env-var twiddling.
  const shareUrl = data
    ? (typeof window !== 'undefined'
        ? `${window.location.origin}/?ref=${data.code}`
        : `https://otuburu.torama.money/?ref=${data.code}`)
    : ''

  // Default share message — punchy + leads with the savings angle.
  // Users can edit before sending if their messaging app supports it.
  const shareText = data
    ? `Trade gold, crypto, and indices on Otuburu — Africa-built, NGN deposits, cent accounts. Use my link: ${shareUrl}`
    : ''

  const handleShare = async () => {
    if (!data) return
    // navigator.share exists on every mobile WebView + most desktops now.
    // Falls back to clipboard on the few that don't.
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
          title: 'Otuburu',
          text:  shareText,
          url:   shareUrl,
        })
        return
      } catch {
        // User cancelled — fall through to clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Could not copy — please copy the URL manually.')
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Refer a friend">
      <div className="p-4 space-y-5">

        {/* Headline pitch */}
        <div>
          <p className="text-text text-sm leading-relaxed">
            Earn a share of the spread on every trade your referrals make. They
            sign up with your link; you get credited automatically.
          </p>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-down text-xs">
            {error}
          </div>
        )}

        {/* Code + share URL */}
        {data && (
          <>
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Your code</p>
              <p className="num text-2xl font-bold text-text tracking-widest mb-3">{data.code}</p>
              <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Share link</p>
              <p className="text-xs text-brand break-all font-mono">{shareUrl}</p>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Referrals</p>
                <p className="num text-lg font-bold text-text">{data.introduced}</p>
              </div>
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] text-dim uppercase tracking-wider mb-1">Your rate</p>
                <p className="num text-lg font-bold text-up">{(data.rate * 100).toFixed(0)}%</p>
              </div>
            </div>

            {/* Big share button */}
            <button
              type="button"
              onClick={handleShare}
              className="w-full py-3 rounded-lg bg-brand text-black font-semibold text-sm hover:bg-brand/90 transition-colors"
            >
              {copied ? '✓ Copied to clipboard' : 'Share my link'}
            </button>

            <p className="text-[10px] text-dim leading-relaxed text-center">
              Earnings are credited to your Savings wallet weekly. Withdraw any
              time from there.
            </p>
          </>
        )}

        {!data && !error && (
          <p className="text-dim text-xs text-center py-4">Loading…</p>
        )}
      </div>
    </BottomSheet>
  )
}
