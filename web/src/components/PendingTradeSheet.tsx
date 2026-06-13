'use client'
import { useState } from 'react'
import BottomSheet from './BottomSheet'
import { type PendingIntent, intentSummary, executeIntent } from '@/lib/pendingIntent'

interface Props {
  open: boolean
  intent: PendingIntent | null
  /** Called when the sheet resolves. placed=true when the trade was executed. */
  onDone: (placed: boolean) => void
}

/**
 * Shown once a user's deposit lands while a trade intent is pending. Surfaces
 * the exact action they set up before depositing, for a single-tap confirm.
 * Deliberately NOT auto-executed — placing a leveraged/staked order always
 * needs explicit consent.
 */
export default function PendingTradeSheet({ open, intent, onDone }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!intent) return null

  const confirm = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await executeIntent(intent)
      if (res.error) {
        setErr(res.error)
        setBusy(false)
        return
      }
      setBusy(false)
      onDone(true)
    } catch {
      setErr('Could not place the trade. Please try again.')
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={() => onDone(false)} title="Funds received">
      <div className="p-5 space-y-4">
        <p className="text-dim text-sm leading-relaxed">
          Your deposit has landed. Place the trade you set up?
        </p>

        <div className="bg-surface rounded-xl px-4 py-3 text-text text-sm font-semibold">
          {intentSummary(intent)}
        </div>

        {err && (
          <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
            {err}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => onDone(false)}
            disabled={busy}
            className="flex-1 py-3 rounded-xl border border-border text-dim hover:text-text text-sm font-semibold transition-colors disabled:opacity-50"
          >
            Not now
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            className="flex-1 py-3 rounded-xl bg-brand hover:bg-brand/90 text-black text-sm font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <span className="animate-spin">⟳</span> Placing…
              </>
            ) : (
              'Confirm trade'
            )}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
