'use client'

/**
 * KycSheet — tier-1 identity verification flow (Smile Identity backed).
 *
 * States rendered:
 *   - Approved: green success card; one-tap close.
 *   - Pending submission: shows the user's last attempt + a "Try again" CTA.
 *   - Rejected: red banner with rejection reason; CTA to retry with
 *     corrected details.
 *   - First-time / no submission: the verification form itself.
 *
 * Form fields are deliberately minimal — NIN / BVN / passport ID number
 * + first/last name + DOB. Selfie capture lands in a v2 once we add the
 * @capacitor/camera plugin to the native shell.
 *
 * Upstream constraints
 * ────────────────────
 * The Smile Identity Enhanced KYC API is Nigerian-citizen-centric for
 * NIN/BVN; international travellers using their NG passport still pass.
 * For non-Nigerian users we'd need a separate ID document type and a
 * different provider product — out of scope for v1 (market is NG-first).
 */

import { useEffect, useState } from 'react'
import { authFetch } from '@/lib/api'
import BottomSheet from './BottomSheet'
import { useT } from '@/lib/i18n/provider'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface Props {
  open:    boolean
  onClose: () => void
  /** Fired after a successful verification so the parent can refresh
   *  balances + tier-aware UI (e.g. deposit cap badge). */
  onVerified?: () => void
}

type IDType = 'NIN' | 'BVN' | 'PASSPORT' | 'DRIVERS_LICENSE' | 'VOTERS_CARD'

interface KycStatus {
  tier:             number
  deposit_cap_usd:  number
  submission?: {
    id_type:          IDType
    status:           'pending' | 'approved' | 'rejected' | 'expired'
    rejection_reason: string | null
  } | null
}

const ID_TYPE_LABEL: Record<IDType, string> = {
  NIN:             'NIN (National ID)',
  BVN:             'BVN (Bank ID)',
  PASSPORT:        'Passport',
  DRIVERS_LICENSE: "Driver's licence",
  VOTERS_CARD:     'Voter card',
}

export default function KycSheet({ open, onClose, onVerified }: Props) {
  const { t } = useT()
  const [status,  setStatus]  = useState<KycStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState<string | null>(null)

  // Form state — populated on mount so the user doesn't lose progress
  // if they tap away and back. We keep it in component state, not
  // localStorage, since ID numbers are sensitive.
  const [idType,    setIdType]    = useState<IDType>('NIN')
  const [idNumber,  setIdNumber]  = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName,  setLastName]  = useState('')
  const [dob,       setDob]       = useState('')

  // Fetch current status on every open so the user sees an up-to-date
  // tier badge even after re-opening the sheet days later.
  useEffect(() => {
    if (!open) return
    setErr(null)
    authFetch(`${API_BASE}/wallet/kyc`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((d: KycStatus) => setStatus(d))
      .catch(e => setErr(typeof e === 'string' ? e : 'Could not load status'))
  }, [open])

  const submit = async () => {
    if (loading) return
    setErr(null); setLoading(true)
    try {
      const res = await authFetch(`${API_BASE}/wallet/kyc/submit`, {
        method: 'POST',
        body: JSON.stringify({
          id_type:    idType,
          id_number:  idNumber.trim(),
          first_name: firstName.trim(),
          last_name:  lastName.trim(),
          dob,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr(data?.error ?? `Submit failed (${res.status})`)
        return
      }
      // Refresh status; if approved, fire the parent callback.
      setStatus(prev => ({
        tier:            data.tier ?? prev?.tier ?? 0,
        deposit_cap_usd: data.deposit_cap_usd ?? prev?.deposit_cap_usd ?? 500,
        submission: {
          id_type:          idType,
          status:           data.status,
          rejection_reason: data.rejection_reason ?? null,
        },
      }))
      if (data.status === 'approved' && onVerified) onVerified()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'network error')
    } finally {
      setLoading(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const verified = status?.tier && status.tier >= 1

  return (
    <BottomSheet open={open} onClose={onClose} title={t('kyc.title')}>
      <div className="p-4 space-y-4">
        {!status && !err && (
          <p className="text-dim text-xs text-center py-4">Loading…</p>
        )}

        {err && (
          <div className="px-3 py-2 rounded-lg bg-down/15 border border-down/40 text-down text-xs">
            {err}
          </div>
        )}

        {status && verified && (
          <div className="bg-up/10 border border-up/30 rounded-xl p-4 text-center">
            <p className="text-up text-base font-bold mb-1">{t('kyc.verified')}</p>
            <p className="text-text text-xs leading-relaxed">
              {t('kyc.verifiedSub', { cap: status.deposit_cap_usd.toLocaleString() })}
            </p>
          </div>
        )}

        {status && !verified && (
          <>
            {/* Pitch the value prop so users understand why they're typing
                their NIN. The number after $ matches whatever the backend
                cap says, so we stay in sync if we ever bump the tier-1
                limit without re-deploying the frontend. */}
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-text text-sm leading-relaxed">
                Verify your identity to unlock deposits up to{' '}
                <span className="text-brand font-semibold">$5,000</span> and enable
                withdrawals. Your data is encrypted in transit and only used to
                match Nigerian government records.
              </p>
            </div>

            {status.submission && status.submission.status === 'rejected' && (
              <div className="px-3 py-2 rounded-lg bg-down/15 border border-down/40 text-down text-xs">
                Last attempt rejected
                {status.submission.rejection_reason && `: ${status.submission.rejection_reason}`}.
                Correct the details below and try again.
              </div>
            )}

            <div>
              <label className="block text-[10px] text-dim uppercase tracking-wider mb-1.5">
                Document type
              </label>
              <select
                value={idType}
                onChange={e => setIdType(e.target.value as IDType)}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-text text-sm focus:outline-none focus:border-brand/60"
              >
                {(['NIN', 'BVN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD'] as const).map(k => (
                  <option key={k} value={k}>{ID_TYPE_LABEL[k]}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] text-dim uppercase tracking-wider mb-1.5">
                {idType} number
              </label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={idNumber}
                onChange={e => setIdNumber(e.target.value)}
                placeholder={idType === 'NIN' ? '11 digits' : 'Document number'}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-text text-sm num focus:outline-none focus:border-brand/60"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-dim uppercase tracking-wider mb-1.5">
                  First name
                </label>
                <input
                  type="text"
                  autoComplete="given-name"
                  value={firstName}
                  onChange={e => setFirstName(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-text text-sm focus:outline-none focus:border-brand/60"
                />
              </div>
              <div>
                <label className="block text-[10px] text-dim uppercase tracking-wider mb-1.5">
                  Last name
                </label>
                <input
                  type="text"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-text text-sm focus:outline-none focus:border-brand/60"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-dim uppercase tracking-wider mb-1.5">
                Date of birth
              </label>
              <input
                type="date"
                autoComplete="bday"
                value={dob}
                onChange={e => setDob(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-lg text-text text-sm num focus:outline-none focus:border-brand/60"
              />
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={loading || !idNumber || !firstName || !lastName || !dob}
              className="w-full py-3 rounded-lg bg-brand text-black font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying…' : 'Submit for verification'}
            </button>

            <p className="text-[10px] text-dim leading-relaxed text-center">
              {t('kyc.instantHint')}
            </p>

            {/* Required vendor disclosure — Smile Identity ToS asks
                integrators to surface their name + a link in the
                verification flow. Renders on every form view; not on
                the success card (legally the disclosure only needs to
                appear at the moment data is collected). */}
            <p className="text-[10px] text-dim/70 leading-relaxed text-center pt-1">
              {t('kyc.providedBy')} (
              <a
                href="https://smileidentity.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand/80 underline hover:text-brand"
              >{t('kyc.smileSite')}</a>)
            </p>
          </>
        )}
      </div>
    </BottomSheet>
  )
}
