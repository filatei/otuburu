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

type Tab = 'usdt' | 'ngn'

export default function DepositModal({ user: _user, onClose, open = true }: Props) {
  const [tab,        setTab]        = useState<Tab>('usdt')
  const [address,    setAddress]    = useState<string | null>(null)
  const [addrLoading, setAddrLoading] = useState(false)
  const [addrErr,    setAddrErr]    = useState<string | null>(null)
  const [copied,     setCopied]     = useState(false)

  // Paystack tab state
  const [amountUSD,    setAmountUSD]    = useState('')
  const [psLoading,    setPsLoading]    = useState(false)
  const [psErr,        setPsErr]        = useState<string | null>(null)

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

  const handleCopy = () => {
    if (!address) return
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handlePaystack = async () => {
    const usd = parseFloat(amountUSD)
    if (!usd || usd < 5) { setPsErr('Minimum deposit is $5'); return }
    setPsLoading(true)
    setPsErr(null)
    try {
      const res  = await authFetch(`${API_BASE}/payments/paystack/initiate`, {
        method: 'POST',
        body:   JSON.stringify({ amount_usd: usd }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Payment initiation failed')
      // Redirect to Paystack checkout in same tab
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
          <TabBtn label="NGN (Paystack)" active={tab === 'ngn'}  onClick={() => setTab('ngn')}  />
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

          {/* ── NGN / Paystack tab ────────────────────────────────────────── */}
          {tab === 'ngn' && (
            <div className="space-y-4">
              <p className="text-dim text-sm leading-relaxed">
                Pay with <span className="text-text font-semibold">Nigerian Naira (NGN)</span> via bank transfer,
                card, or USSD. Powered by Paystack.
              </p>

              <div>
                <label className="text-dim text-xs font-semibold uppercase tracking-wider block mb-1.5">
                  Amount (USD)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim font-semibold">$</span>
                  <input
                    type="number"
                    min="5"
                    step="1"
                    placeholder="50"
                    value={amountUSD}
                    onChange={e => setAmountUSD(e.target.value)}
                    className="w-full bg-surface border border-border rounded-xl pl-7 pr-4 py-3 text-text text-sm focus:outline-none focus:border-brand/60"
                  />
                </div>
                <p className="text-dim text-xs mt-1">Minimum $5 · equivalent NGN shown at checkout</p>
              </div>

              {/* Preset quick-select amounts */}
              <div className="flex gap-2">
                {[10, 25, 50, 100].map(amt => (
                  <button
                    key={amt}
                    onClick={() => setAmountUSD(String(amt))}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                      amountUSD === String(amt)
                        ? 'bg-brand/20 border-brand/50 text-brand'
                        : 'bg-surface border-border text-dim hover:text-text hover:border-brand/30'
                    }`}
                  >
                    ${amt}
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
                disabled={psLoading || !amountUSD}
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
