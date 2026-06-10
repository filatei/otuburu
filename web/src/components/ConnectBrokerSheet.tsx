'use client'
import { useEffect, useState, useCallback } from 'react'
import clsx from 'clsx'
import BottomSheet from './BottomSheet'
import {
  listLpLinks,
  createLpLink,
  deleteLpLink,
  type LpLink,
  type LpLinkKind,
} from '@/lib/api'

/**
 * ConnectBrokerSheet — Sprint 5.9e.
 *
 * Self-serve UI for linking an external broker account (Exness MT5 via
 * MetaApi today; cTrader / OANDA stubbed). Replaces the curl-based flow
 * users went through in Sprint 5.8.
 *
 * What this does
 * --------------
 * 1. Lists existing broker links (GET /api/lp-links) with a delete
 *    button per row.
 * 2. Form to add a new link: kind picker, account_id, region, token,
 *    optional label. Submit → POST /api/lp-links → which also auto-
 *    provisions the matching Otuburu broker account (Sprint 5.9b).
 * 3. On successful create, fires onCreated(broker_account_id) so the
 *    parent can refresh /auth/me + auto-switch the picker to the new
 *    broker account.
 *
 * v1 scope
 * --------
 * - Only metaapi is selectable. cTrader / OANDA show as "coming soon"
 *   disabled tiles. The backend already accepts them; we hide the
 *   tiles because the adapters aren't production-ready.
 * - Token field has a show/hide toggle but defaults to hidden. We
 *   deliberately do NOT clear the form on successful create so the
 *   user can re-paste to rotate the token without re-typing the
 *   metaapi UUID + region.
 * - "Where do I find these?" link points at MetaApi's account-token
 *   docs. cTrader / OANDA when enabled will get their own help text.
 */

interface Props {
  open:    boolean
  onClose: () => void
  /** Called after a successful POST. The parent should refresh
   *  /auth/me (so the new broker account appears in the picker) and
   *  optionally onSelect(brokerAccountId) to immediately route to it. */
  onCreated: (brokerAccountId: string) => void
}

const REGION_HINTS: Record<LpLinkKind, string> = {
  metaapi:  'Cluster: london | new-york | singapore | mumbai',
  ctrader:  'Env: demo | live',
  oanda:    'Env: practice | live',
}

const HELP_URLS: Record<LpLinkKind, string> = {
  metaapi:  'https://metaapi.cloud/docs/client/account-token/',
  ctrader:  'https://help.ctrader.com/open-api',
  oanda:    'https://developer.oanda.com/rest-live-v20/account-ep/',
}

export default function ConnectBrokerSheet({ open, onClose, onCreated }: Props) {
  // ── Existing links ──────────────────────────────────────────────
  const [links,        setLinks]        = useState<LpLink[] | null>(null)
  const [loadingLinks, setLoadingLinks] = useState(false)
  const [listErr,      setListErr]      = useState<string | null>(null)

  const reloadLinks = useCallback(async () => {
    setLoadingLinks(true)
    setListErr(null)
    try {
      const data = await listLpLinks()
      setLinks(data)
    } catch (e: any) {
      setListErr(e?.message ?? 'Failed to load broker links')
    } finally {
      setLoadingLinks(false)
    }
  }, [])

  useEffect(() => {
    if (open) reloadLinks()
  }, [open, reloadLinks])

  // ── Add form state ──────────────────────────────────────────────
  const [kind,       setKind]       = useState<LpLinkKind>('metaapi')
  const [brokerId,   setBrokerId]   = useState('')
  const [region,     setRegion]     = useState('london')
  const [token,      setToken]      = useState('')
  const [label,      setLabel]      = useState('')
  const [showToken,  setShowToken]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formErr,    setFormErr]    = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Trim everything — paste-from-MetaApi often carries trailing
    // whitespace, especially on Safari/iOS.
    const cleanedBrokerId = brokerId.trim()
    const cleanedToken    = token.trim()
    const cleanedRegion   = region.trim()
    const cleanedLabel    = label.trim()
    if (!cleanedBrokerId || !cleanedToken) {
      setFormErr('Account ID and token are required')
      return
    }
    setSubmitting(true)
    setFormErr(null)
    try {
      const link = await createLpLink({
        kind,
        account_id: cleanedBrokerId,
        token:      cleanedToken,
        region:     cleanedRegion || undefined,
        label:      cleanedLabel || undefined,
      })
      // Clear token only — keep IDs around so users can re-rotate
      // without re-typing.
      setToken('')
      // Reload list to surface the new entry + drop stale last_used_at.
      await reloadLinks()
      if (link.broker_account_id) {
        onCreated(link.broker_account_id)
      }
    } catch (e: any) {
      setFormErr(e?.message ?? 'Failed to save broker link')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this broker link? The matching Otuburu broker account will stay but stop accepting orders until you re-link.')) {
      return
    }
    try {
      await deleteLpLink(id)
      await reloadLinks()
    } catch (e: any) {
      setListErr(e?.message ?? 'Delete failed')
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Connect Broker">
      <div className="px-5 pb-6 space-y-5 text-sm">

        {/* ── Existing links ─────────────────────────────────────── */}
        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-dim mb-2">
            Linked brokers
          </h3>
          {loadingLinks && (
            <p className="text-dim text-xs">Loading…</p>
          )}
          {listErr && !loadingLinks && (
            <p className="text-down text-xs">{listErr}</p>
          )}
          {links && links.length === 0 && !loadingLinks && (
            <p className="text-dim text-xs">No brokers linked yet. Add one below.</p>
          )}
          {links && links.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {links.map(l => (
                <li key={l.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="text-base shrink-0" aria-hidden>🔗</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-text font-semibold truncate">{l.label}</p>
                    <p className="text-dim text-[11px] truncate">
                      {l.kind}
                      {l.region ? ` · ${l.region}` : ''}
                      {' · '}
                      <span className="font-mono">{l.account_id.slice(0, 8)}…</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(l.id)}
                    className="text-down/80 hover:text-down text-xs px-2 py-1 rounded hover:bg-down/10"
                    title="Delete this broker link"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Add form ───────────────────────────────────────────── */}
        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-dim mb-2">
            Add a broker
          </h3>

          {/* Kind picker — only MetaApi is selectable in v1. MetaApi
              speaks to ANY MT4/MT5 broker (FBS, Pepperstone, IC Markets,
              OctaFX, Exness, etc.), so we label it neutrally rather than
              naming any one broker. cTrader / OANDA tiles are visible
              with a "soon" badge to signal they're planned. */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {(['metaapi', 'ctrader', 'oanda'] as const).map(k => {
              const selectable = k === 'metaapi'
              const selected   = kind === k && selectable
              const labelText = k === 'metaapi' ? 'MT4 / MT5'
                : k === 'ctrader' ? 'cTrader'
                : 'OANDA'
              const subText = k === 'metaapi' ? 'via MetaApi'
                : k === 'ctrader' ? 'Open API'
                : 'REST v20'
              return (
                <button
                  key={k}
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectable && setKind(k)}
                  className={clsx(
                    'p-2.5 rounded-lg border text-left transition-colors',
                    selected
                      ? 'bg-up/10 border-up/50'
                      : 'bg-surface border-border',
                    !selectable && 'opacity-50 cursor-not-allowed',
                    selectable && !selected && 'hover:border-up/30',
                  )}
                >
                  <p className="text-text text-xs font-bold">{labelText}</p>
                  <p className="text-dim text-[9px] mt-0.5">{subText}</p>
                  {!selectable && (
                    <p className="text-[9px] text-brand/80 mt-1 font-bold">soon</p>
                  )}
                </button>
              )
            })}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <Field
              label="Broker account ID"
              hint={kind === 'metaapi' ? 'MetaApi account UUID (find under MT Accounts in metaapi.cloud)' : 'Broker-side account identifier'}
            >
              <input
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={brokerId}
                onChange={e => setBrokerId(e.target.value)}
                placeholder="fd61a468-76ad-442c-87db-…"
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-text text-sm font-mono focus:outline-none focus:border-brand/60"
              />
            </Field>

            <Field label="Region / cluster" hint={REGION_HINTS[kind]}>
              <input
                type="text"
                autoCapitalize="off"
                value={region}
                onChange={e => setRegion(e.target.value)}
                placeholder="london"
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-text text-sm focus:outline-none focus:border-brand/60"
              />
            </Field>

            <Field
              label="Access token"
              hint={
                <>
                  Never displayed once saved.{' '}
                  <a
                    href={HELP_URLS[kind]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline decoration-dotted underline-offset-2"
                  >
                    Where do I find this?
                  </a>
                </>
              }
            >
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  placeholder="paste token"
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 pr-16 text-text text-sm font-mono focus:outline-none focus:border-brand/60"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-dim hover:text-text px-1.5 py-1"
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
            </Field>

            <Field label="Label (optional)" hint="What you'll see in the account picker">
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="My Exness MT5 demo"
                maxLength={40}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-text text-sm focus:outline-none focus:border-brand/60"
              />
            </Field>

            {formErr && <p className="text-down text-xs">{formErr}</p>}

            <button
              type="submit"
              disabled={submitting || !brokerId.trim() || !token.trim()}
              className="w-full py-2.5 rounded-lg text-sm font-bold bg-brand text-black disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving…' : 'Link broker'}
            </button>

            <p className="text-[10px] text-dim/80 leading-snug">
              Your token is encrypted at rest with pgcrypto. We never log
              it and the API surface is write-only — we won't return it
              even if you ask. Re-link to rotate.
            </p>
          </form>
        </section>
      </div>
    </BottomSheet>
  )
}

/** Tiny labelled-field wrapper. Keeps form spacing consistent without
 *  pulling in a heavyweight form library. */
function Field({
  label,
  hint,
  children,
}: {
  label:    string
  hint?:    React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-dim text-[10px] uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-dim/70 mt-1">{hint}</p>}
    </div>
  )
}
