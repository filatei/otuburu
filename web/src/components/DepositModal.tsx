'use client'
import { useState, useEffect } from 'react'
import type { AuthUser } from '@/hooks/useAuth'
import { authFetch } from '@/lib/api'
import BottomSheet from './BottomSheet'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

interface Props {
  user:    AuthUser
  onClose: () => void
  /** When false, the sheet is unmounted. Parent controls mount lifecycle so
   *  we can play the close animation cleanly. Defaults to true when omitted
   *  so existing call sites keep working. */
  open?:   boolean
}

type Tab = 'usdt' | 'va' | 'ngn'

export default function DepositModal({ user: _user, onClose, open = true }: Props) {
  const [tab,        setTab]        = useState<Tab>('usdt')
  const [address,    setAddress]    = useState<string | null>(null)
  const [addrLoading, setAddrLoading] = useState(false)
  const [addrErr,    setAddrErr]    = useState<string | null>(null)
  const [copied,     setCopied]     = useState(false)

  // Paystack tab state — primary input is NGN (what Nigerian users actually
  // think in); USD equivalent is shown below + sent to the backend after
  // conversion via the live customer rate from /payments/rates.
  const [amountNGN,    setAmountNGN]    = useState('')
  const [ngnRate,      setNgnRate]      = useState<number | null>(null) // NGN per 1 USD (customer rate, includes 2% spread)
  const [psLoading,    setPsLoading]    = useState(false)
  const [psErr,        setPsErr]        = useState<string | null>(null)

  // Instant NGN bank-transfer tab — a static virtual account (NUBAN) the user
  // funds from any banking app; credited automatically via the Monnify webhook.
  // The number is permanent, so one fetch per modal-open (or cache) is plenty.
  const [va,        setVa]        = useState<{ bank_name: string; account_number: string; account_name: string } | null>(null)
  const [vaLoading, setVaLoading] = useState(false)
  const [vaErr,     setVaErr]     = useState<string | null>(null)
  const [vaCopied,  setVaCopied]  = useState(false)

  // Load deposit address when USDT tab is shown
  useEffect(() => {
    if (tab !== 'usdt' || address) return
    setAddrLoading(true)
    setAddrErr(null)
    authFetch(`${API_BASE}/wallet/deposit-address`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => setAddress(d.address))
      .catch(() => setAddrErr('Could not load deposit address. Please try again.'))
      .finally(() => setAddrLoading(false))
  }, [tab, address])

  // Fetch live NGN customer rate when the NGN tab opens. Refreshed every
  // hour server-side, so a one-shot fetch per modal-open is fine. Public
  // endpoint, no auth needed.
  useEffect(() => {
    if (tab !== 'ngn' || ngnRate !== null) return
    let cancelled = false
    fetch(`${API_BASE}/payments/rates`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => {
        if (cancelled) return
        const rate = d?.currencies?.NGN?.customer
        if (typeof rate === 'number' && rate > 0) setNgnRate(rate)
      })
      .catch(() => { /* silent — UI falls back to 'live rate at checkout' copy */ })
    return () => { cancelled = true }
  }, [tab, ngnRate])

  // Provision / load the user's virtual account when the transfer tab opens.
  // Mirrors the USDT address pattern: foreground fetch with a spinner, then
  // the NUBAN is shown and reusable.
  useEffect(() => {
    if (tab !== 'va' || va) return
    setVaLoading(true)
    setVaErr(null)
    authFetch(`${API_BASE}/wallet/ngn/virtual-account`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => setVa({ bank_name: d.bank_name, account_number: d.account_number, account_name: d.account_name }))
      .catch(() => setVaErr('Could not load your transfer account. Please try again in a moment.'))
      .finally(() => setVaLoading(false))
  }, [tab, va])

  const handleCopy = () => {
    if (!address) return
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleCopyVA = () => {
    if (!va) return
    navigator.clipboard.writeText(va.account_number).then(() => {
      setVaCopied(true)
      setTimeout(() => setVaCopied(false), 2000)
    })
  }

  const handlePaystack = async () => {
    const ngn = parseFloat(amountNGN)
    if (!ngn || ngn < 100) { setPsErr('Enter a valid NGN amount.'); return }
    if (!ngnRate) { setPsErr('Could not load NGN rate — please try again.'); return }
    // Backend validates min $5 USD; we mirror that as NGN equivalent so the
    // user gets the right error message client-side without a round-trip.
    const usd = ngn / ngnRate
    if (usd < 5) {
      const minNGN = Math.ceil(5 * ngnRate / 100) * 100  // round up to next ₦100
      setPsErr(`Minimum deposit is ₦${minNGN.toLocaleString('en-NG')} (~$5).`)
      return
    }
    setPsLoading(true)
    setPsErr(null)
    try {
      const res = await authFetch(`${API_BASE}/payments/paystack/initiate`, {
        method: 'POST',
        // Backend takes USD; we convert from the NGN the user typed using
        // the same customer rate the preview displays. Locked rate at
        // Paystack confirmation may differ by a few naira — fx_quotes
        // audit row captures the exact pair used per deposit.
        body:   JSON.stringify({ amount_usd: usd }),
      })
      // Read as text first so we can give a useful error when the server
      // returns HTML instead of JSON — this happens when Apache fails to
      // proxy /payments/* and falls back to serving the static frontend
      // (returns <!DOCTYPE html>...). Without this guard the user sees
      // "Unexpected token '<'" which doesn't say what to fix.
      const raw = await res.text()
      const isHtml = raw.trimStart().startsWith('<')
      if (isHtml) {
        throw new Error(
          `Server returned HTML (HTTP ${res.status}). The /payments/ ` +
          `route may not be proxied to the wallet service — check Apache.`,
        )
      }
      const data = raw ? JSON.parse(raw) : {}
      if (!res.ok) {
        // 422 with verify_required:true → user hit the KYC tier cap.
        // The error message already includes the available headroom +
        // tier number; surface it raw so the user knows exactly what
        // to do (verify identity).
        if (res.status === 422 && data.verify_required) {
          throw new Error(`${data.error} Tap 'Verify identity' in the menu to raise your cap.`)
        }
        throw new Error(data.error ?? `Payment initiation failed (HTTP ${res.status})`)
      }
      window.location.href = data.authorization_url
    } catch (err: any) {
      setPsErr(err.message ?? 'Payment failed. Please try again.')
    } finally {
      setPsLoading(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Deposit Funds">
      <div>
        {/* Tabs — pinned at the top of the scrollable content area */}
        <div className="flex border-b border-border sticky top-0 bg-panel z-10">
          <TabBtn label="USDT (TRC20)" active={tab === 'usdt'} onClick={() => setTab('usdt')} />
          <TabBtn label="Bank Transfer" active={tab === 'va'}  onClick={() => setTab('va')}  />
          <TabBtn label="Card / USSD"  active={tab === 'ngn'}  onClick={() => setTab('ngn')}  />
        </div>

        {/* Content */}
        <div className="p-5">

          {/* ── USDT tab ─────────────────────────────────────────────────── */}
          {tab === 'usdt' && (
            <div className="space-y-4">
              <p className="text-dim text-sm leading-relaxed">
                Send <span className="text-text font-semibold">USDT (TRC20)</span> to your personal deposit address.
                Balance is credited after 1 confirmation (≈ 1 min).
              </p>

              {addrLoading && (
                <div className="flex items-center justify-center py-8">
                  <span className="animate-spin text-brand text-2xl">⟳</span>
                </div>
              )}

              {addrErr && (
                <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
                  {addrErr}
                </div>
              )}

              {address && !addrLoading && (
                <>
                  {/* QR code via public QR API */}
                  <div className="flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(address)}`}
                      alt="Deposit QR"
                      width={160}
                      height={160}
                      className="rounded-xl border border-border bg-white p-1"
                    />
                  </div>

                  {/* Address display */}
                  <div className="bg-surface rounded-xl px-4 py-3 flex items-center gap-2">
                    <span className="flex-1 font-mono text-xs text-text break-all leading-relaxed">
                      {address}
                    </span>
                    <button
                      onClick={handleCopy}
                      className="shrink-0 px-3 py-1.5 bg-brand/10 hover:bg-brand/20 text-brand text-xs font-semibold rounded-lg border border-brand/30 transition-colors"
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>

                  <div className="text-[11px] text-dim space-y-1">
                    <p>⚠️ Only send <strong>USDT on the TRON (TRC20) network</strong>.</p>
                    <p>⚠️ Sending other tokens or on other networks will result in permanent loss.</p>
                    <p>⚠️ Minimum deposit: <strong>$1 USDT</strong>.</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Instant NGN bank-transfer tab (virtual account) ───────────── */}
          {tab === 'va' && (
            <div className="space-y-4">
              <p className="text-dim text-sm leading-relaxed">
                Transfer <span className="text-text font-semibold">any amount in Naira</span> to your
                personal account below from any bank app. Your balance is credited automatically,
                usually within a minute.
              </p>

              {vaLoading && (
                <div className="flex items-center justify-center py-8">
                  <span className="animate-spin text-brand text-2xl">⟳</span>
                </div>
              )}

              {vaErr && (
                <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
                  {vaErr}
                </div>
              )}

              {va && !vaLoading && (
                <>
                  <div className="bg-surface rounded-xl px-4 py-3 space-y-3">
                    <Row label="Bank" value={va.bank_name} />
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <p className="text-dim text-[11px] uppercase tracking-wider">Account Number</p>
                        <p className="font-mono text-lg text-text tracking-wide">{va.account_number}</p>
                      </div>
                      <button
                        onClick={handleCopyVA}
                        className="shrink-0 px-3 py-1.5 bg-brand/10 hover:bg-brand/20 text-brand text-xs font-semibold rounded-lg border border-brand/30 transition-colors"
                      >
                        {vaCopied ? '✓ Copied' : 'Copy'}
                      </button>
                    </div>
                    <Row label="Account Name" value={va.account_name} />
                  </div>

                  <div className="text-[11px] text-dim space-y-1">
                    <p>✓ Reusable — this account is permanently yours.</p>
                    <p>✓ A 2% spread over the interbank NGN/USD rate is applied on credit.</p>
                    <p>⚠️ Send only Naira bank transfers to this account.</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── NGN / Paystack tab ────────────────────────────────────────── */}
          {tab === 'ngn' && (
            <div className="space-y-4">
              <p className="text-dim text-sm leading-relaxed">
                Pay with <span className="text-text font-semibold">Nigerian Naira (NGN)</span> via bank transfer,
                card, or USSD. Powered by Paystack.
              </p>

              <div>
                <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
                  Amount (NGN)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim font-semibold">₦</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="100"
                    step="100"
                    placeholder="10,000"
                    value={amountNGN}
                    onChange={e => { setAmountNGN(e.target.value); setPsErr(null) }}
                    className="w-full bg-surface border border-border rounded-xl pl-7 pr-4 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
                  />
                </div>
                <div className="flex items-baseline justify-between mt-1">
                  <p className="text-dim text-xs">
                    {ngnRate
                      ? `Minimum ~₦${Math.ceil(5 * ngnRate / 100) * 100} (≈ $5)`
                      : 'Loading current NGN rate…'}
                  </p>
                  {ngnRate && amountNGN && parseFloat(amountNGN) > 0 && (
                    <p className="text-text text-xs font-semibold">
                      ≈ ${(parseFloat(amountNGN) / ngnRate).toFixed(2)}
                    </p>
                  )}
                </div>
              </div>

              {/* Preset quick-select amounts — NGN values keyed to common
                  starting deposits for Nigerian retail. ₦10k ≈ $6, ₦25k ≈ $16,
                  ₦50k ≈ $33, ₦100k ≈ $65 at ~₦1500/USD. */}
              <div className="flex gap-2">
                {[10_000, 25_000, 50_000, 100_000].map(amt => (
                  <button
                    key={amt}
                    onClick={() => { setAmountNGN(String(amt)); setPsErr(null) }}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                      amountNGN === String(amt)
                        ? 'bg-brand/20 border-brand/50 text-brand'
                        : 'bg-surface border-border text-dim hover:text-text hover:border-brand/30'
                    }`}
                  >
                    ₦{(amt / 1000)}k
                  </button>
                ))}
              </div>

              {/* Conversion-fee disclosure. The NGN amount the user pays at
                  Paystack includes a 2% FX spread over the interbank rate.
                  The exact ₦ figure and the locked rate appear on the
                  Paystack page itself; here we surface the fee so users
                  aren't surprised. The audit trail per-deposit lives in
                  the wallet's fx_quotes table. */}
              <div className="bg-surface/60 rounded-xl px-3 py-2.5 border border-border/60">
                <p className="text-[11px] text-dim leading-relaxed">
                  <span className="text-text font-semibold">Conversion fee:</span>{' '}
                  A 2% spread over the interbank NGN/USD rate is included in
                  the amount you pay. The exact ₦ amount and locked rate are
                  shown on the Paystack checkout page before you confirm.
                </p>
              </div>

              {psErr && (
                <div className="bg-down/10 border border-down/30 rounded-xl px-4 py-3 text-down text-sm">
                  {psErr}
                </div>
              )}

              <button
                onClick={handlePaystack}
                disabled={psLoading || !amountNGN || !ngnRate}
                className="w-full py-3 bg-brand hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed text-black text-sm font-bold rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {psLoading ? (
                  <><span className="animate-spin">⟳</span> Redirecting…</>
                ) : (
                  <>Pay with Paystack →</>
                )}
              </button>

              <p className="text-[11px] text-dim text-center">
                You will be redirected to Paystack to complete the payment securely.
              </p>
            </div>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-dim text-[11px] uppercase tracking-wider">{label}</span>
      <span className="text-text text-sm font-semibold text-right">{value}</span>
    </div>
  )
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-xs font-semibold transition-colors border-b-2 ${
        active
          ? 'border-brand text-brand bg-brand/5'
          : 'border-transparent text-dim hover:text-text'
      }`}
    >
      {label}
    </button>
  )
}
