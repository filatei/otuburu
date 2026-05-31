'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { AuthUser } from '@/hooks/useAuth'
import { authFetch } from '@/lib/api'
import BottomSheet from './BottomSheet'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface Props {
  open:    boolean
  onClose: () => void
  user:    AuthUser
}

/** "Contact us" bottom sheet — POSTs to /wallet/contact which forwards the
 *  message to ADMIN_EMAIL via the existing mailer. Authed-only so the
 *  backend knows who sent it; in-app rate limit (UI button disable + 60s
 *  cooldown) mirrors the server's 1-per-minute throttle. */
export default function ContactModal({ open, onClose, user }: Props) {
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [busy,    setBusy]    = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [sent,    setSent]    = useState(false)

  const reset = () => {
    setSubject('')
    setMessage('')
    setErr(null)
    setSent(false)
  }

  const handleClose = () => {
    if (busy) return
    reset()
    onClose()
  }

  const submit = async () => {
    if (busy) return
    const subj = subject.trim()
    const msg  = message.trim()
    if (subj.length < 3)  { setErr('Subject must be at least 3 characters.');  return }
    if (msg.length < 10)  { setErr('Message must be at least 10 characters.'); return }

    setBusy(true)
    setErr(null)
    try {
      const res  = await authFetch(`${API_BASE}/wallet/contact`, {
        method: 'POST',
        body:   JSON.stringify({ subject: subj, message: msg }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 429) {
          const retry = (data as { retry_after_secs?: number }).retry_after_secs ?? 60
          throw new Error(`Please wait ${retry}s before sending another message.`)
        }
        throw new Error((data as { error?: string }).error ?? 'Could not send. Please try again.')
      }
      setSent(true)
    } catch (e: any) {
      setErr(e?.message ?? 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={handleClose} title="Contact support">
      <div className="p-5 space-y-4">
        {sent ? (
          <div className="text-center py-8 space-y-3">
            <div className="text-4xl">✓</div>
            <h3 className="text-text font-bold text-base">Message sent</h3>
            <p className="text-dim text-sm leading-relaxed">
              We&apos;ll reply to <span className="text-text font-semibold">{user.email}</span> within 24 hours.
            </p>
            <button
              onClick={handleClose}
              className="mt-4 w-full py-3 text-sm font-bold rounded-xl bg-brand text-black hover:bg-brand/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Sender preview — non-editable, makes it explicit who the
                message is sent as. Avoids spoofing concerns and clarifies
                where replies will land. */}
            <div className="bg-surface/60 rounded-xl px-3 py-2.5 border border-border/60 text-xs">
              <div className="text-dim">From</div>
              <div className="text-text font-semibold mt-0.5">{user.name}</div>
              <div className="text-dim/80 font-mono text-[11px]">{user.email}</div>
            </div>

            <div>
              <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
                Subject
              </label>
              <input
                type="text"
                maxLength={200}
                placeholder="What's this about?"
                value={subject}
                onChange={e => { setSubject(e.target.value); setErr(null) }}
                className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
              />
            </div>

            <div>
              <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
                Message
              </label>
              <textarea
                rows={6}
                maxLength={5000}
                placeholder="Tell us what's going on — include any error messages, the symbol/trade involved, and what you expected vs. saw."
                value={message}
                onChange={e => { setMessage(e.target.value); setErr(null) }}
                className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-text text-sm leading-relaxed resize-none focus:outline-none focus:border-brand/60"
              />
              <p className="text-dim text-[10px] mt-1 text-right">
                {message.length} / 5000
              </p>
            </div>

            {err && (
              <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
                {err}
              </div>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={busy || subject.trim().length < 3 || message.trim().length < 10}
              className={clsx(
                'w-full py-3 text-sm font-bold rounded-xl transition-colors',
                'bg-brand text-black hover:bg-brand/90',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {busy ? 'Sending…' : 'Send message'}
            </button>
            <p className="text-center text-[10px] text-dim/70">
              We typically respond within 24 hours.
            </p>
          </>
        )}
      </div>
    </BottomSheet>
  )
}
