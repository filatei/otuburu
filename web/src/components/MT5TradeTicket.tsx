'use client'

/**
 * MT5TradeTicket — full-screen trade ticket modal modelled on the MetaTrader 5
 * mobile order screen. Mounted on tap from a symbol row or the TradePanel
 * "New order" affordance; replaces the inline TradePanel form for any user
 * who taps in via this path.
 *
 * Sections (top to bottom):
 *   1. Header — back chevron, symbol id (big), display name (small).
 *   2. Order type — cosmetic "Market Execution" badge. Pending/limit orders
 *      aren't implemented engine-side, so the dropdown is a no-op for v1.
 *   3. Volume row — quick-step chips (−5 −1 −0.1 [current] +0.1 +1 +5)
 *      driving the lots number in the middle. Long-press would auto-repeat
 *      but plain tap-to-bump covers 99% of usage.
 *   4. Big BID / ASK — large display pair, live-updated from `tick`.
 *      The screenshot's price uses a tiny superscript for the trailing
 *      fractional pip (the "0" after 4465.06⁰). We mirror that by splitting
 *      the price into integer/decimal/pip3 spans.
 *   5. SL / TP — collapsible row with ± steppers. The engine stores these
 *      as USD profit/loss thresholds (Position.tp_profit / sl_loss).
 *   6. Fill policy — cosmetic "Fill or Kill" line; the engine only does
 *      immediate market fills today.
 *   7. Disclaimer — the literal MT5 wording so users feel at home.
 *   8. SELL BY MARKET (red) / BUY BY MARKET (green) buttons.
 *
 * Market hours: when the symbol's session is closed, both action buttons
 * disable and a banner explains why. Mirrors the engine's gate so the
 * user doesn't burn a tap on a rejected order.
 *
 * Why a full-screen modal and not a BottomSheet: BottomSheet is for
 * supplemental flows (deposit, transfer, contact). The trade ticket IS the
 * primary action — it owns the screen and benefits from the lack of
 * surrounding chrome.
 */

import { useEffect, useState } from 'react'
import type { SymbolInfo, Tick } from '@/types'
import { placeCFD } from '@/hooks/useAccount'
import { isMarketOpen } from '@/lib/marketHours'
import { displayNameOf } from '@/lib/symbols'
import { useT } from '@/lib/i18n/provider'

interface Props {
  open:      boolean
  onClose:   () => void
  info:      SymbolInfo
  tick:      Tick | null
  accountId: string
  /** Fired after a successful place_order so the caller can refresh state
   *  + close the ticket. */
  onPlaced?: () => void
}

/** Volume bounds — 0.01 minimum / 100 maximum. Tweak per instrument once
 *  we add per-symbol margin requirements; for now uniform. */
const MIN_LOTS = 0.01
const MAX_LOTS = 100

/** volumeProfile — per-asset-class lot defaults + quick-step chips. The
 *  numbers reflect REAL market prices now that the display divisor is
 *  gone: gold at $4,500, BTC at $77k, SPY at $720. Defaults aim for a
 *  notional in the $50–$1,000 range so cent-account users get something
 *  meaningful without one tap on +5 sending them to $400k notional.
 *
 *  steps: six chips arranged as [−big, −med, −small, +small, +med, +big].
 *  Always proportional to default so each chip "feels" similarly sized
 *  across asset classes. */
function volumeProfile(info: SymbolInfo | null): { default: number; steps: number[] } {
  switch (info?.type) {
    case 'CRYPTO':
    case 'METAL':
      // 0.01 lot on gold at $4,500 = $45 notional. 0.01 lot on BTC at
      // $77k = $770 notional (1 lot = ~1 BTC). Fine baselines.
      return { default: 0.01, steps: [-0.5, -0.1, -0.01, 0.01, 0.1, 0.5] }
    case 'INDEX':
    case 'BOOM_CRASH':
      // SPY at $720, BOOM500 synthetic similar. 0.1 lot ≈ $72 notional.
      return { default: 0.1, steps: [-1, -0.5, -0.1, 0.1, 0.5, 1] }
    case 'FX':
    default:
      // EURUSD-style: 1 lot = 100k base. 1.0 default with ±5/±1/±0.1
      // mirrors the historic MT5 mobile defaults.
      return { default: 1.0, steps: [-5, -1, -0.1, 0.1, 1, 5] }
  }
}

export default function MT5TradeTicket({
  open, onClose, info, tick, accountId, onPlaced,
}: Props) {
  const { t } = useT()
  // Asset-class-aware defaults — see volumeProfile above. Computed once
  // per open so changing symbols requires a fresh ticket (matches MT5
  // mobile, where each ticket binds to one instrument).
  const profile = volumeProfile(info)
  const [lots,   setLots]   = useState(profile.default)
  const [tp,     setTp]     = useState<number | null>(null)
  const [sl,     setSl]     = useState<number | null>(null)
  const [busy,   setBusy]   = useState<'BUY' | 'SELL' | null>(null)
  const [err,    setErr]    = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Reset on every fresh open so a stale prior value doesn't surprise.
  // Re-seed `lots` from the profile so a user who toggled to a different
  // symbol still gets a sensible default for that asset class.
  useEffect(() => {
    if (!open) return
    setLots(profile.default); setTp(null); setSl(null); setBusy(null); setErr(null)
    setAdvancedOpen(false)
    // profile is recomputed every render from `info`; we only want this
    // reset to run on open + symbol change, not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, info?.symbol])

  // Lock body scroll while ticket is up so the underlying page doesn't
  // wobble on iOS rubber-band drags.
  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  const marketOpen = isMarketOpen(info, tick)
  const bid = tick?.bid ?? null
  const ask = tick?.ask ?? null

  const clampLots = (n: number) => Math.max(MIN_LOTS, Math.min(MAX_LOTS, Math.round(n * 100) / 100))

  const bump = (delta: number) => setLots(prev => clampLots(prev + delta))

  const submit = async (side: 'BUY' | 'SELL') => {
    if (!marketOpen || busy) return
    setBusy(side); setErr(null)
    try {
      const res = await placeCFD(accountId, info.symbol, side, lots, tp ?? undefined, sl ?? undefined)
      if (res?.error) {
        setErr(res.error)
        return
      }
      onPlaced?.()
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'order failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] bg-bg flex flex-col safe-top">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="w-9 h-9 -ml-2 flex items-center justify-center text-dim hover:text-text rounded-lg hover:bg-surface transition-colors text-xl"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-text text-lg font-bold leading-tight truncate">
            {info.display_symbol ?? info.symbol}
          </p>
          <p className="text-dim text-xs leading-tight truncate">
            {displayNameOf(info, info.symbol)}
          </p>
        </div>
      </div>

      {/* Body — scrolls on small screens; buttons stay pinned at bottom. */}
      <div className="flex-1 overflow-y-auto">

        {/* Order type — cosmetic dropdown for parity. */}
        <div className="px-4 py-3 border-b border-border">
          <button
            type="button"
            className="w-full text-center text-text text-sm font-medium py-2.5 rounded-lg bg-surface border border-border hover:border-brand/30 transition-colors"
            disabled
          >
            {t('trade.marketExecution')}
          </button>
        </div>

        {/* Volume row — chips around the central number. Step values come
            from the per-asset-class volumeProfile so cent-account users
            don't end up with one-tap-to-$400k-notional defaults. */}
        <div className="px-4 py-4 border-b border-border">
          <div className="grid grid-cols-7 gap-1.5 items-stretch">
            {profile.steps.slice(0, 3).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => bump(d)}
                className="py-2 rounded-md bg-surface border border-border text-down text-xs num font-semibold active:bg-surface/70 hover:border-down/30"
              >{d}</button>
            ))}
            <div className="py-2 rounded-md bg-surface/40 flex items-center justify-center text-text text-base font-bold num">
              {lots.toFixed(lots < 0.1 ? 3 : 2)}
            </div>
            {profile.steps.slice(3).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => bump(d)}
                className="py-2 rounded-md bg-surface border border-border text-up text-xs num font-semibold active:bg-surface/70 hover:border-up/30"
              >+{d}</button>
            ))}
          </div>
          <p className="text-[10px] text-dim mt-2 text-center">Lots — 1 lot = 100,000 base</p>
        </div>

        {/* Big BID / ASK pair. Uses the down/up palette so the cue matches
            the action buttons below: SELL pairs with the BID, BUY with ASK. */}
        <div className="px-4 py-5 border-b border-border grid grid-cols-2 gap-4">
          <div className="text-center">
            <p className="text-[10px] text-dim uppercase tracking-wider mb-1">{t('trade.bid')}</p>
            <PriceBig value={bid} stale={!marketOpen} polarity="down" />
          </div>
          <div className="text-center">
            <p className="text-[10px] text-dim uppercase tracking-wider mb-1">{t('trade.ask')}</p>
            <PriceBig value={ask} stale={!marketOpen} polarity="up" />
          </div>
        </div>

        {/* SL / TP — hidden behind a disclosure to keep the default view
            compact. Power users can expand once and it sticks for the
            session via the local state. */}
        <div className="px-4 py-3 border-b border-border">
          <button
            type="button"
            onClick={() => setAdvancedOpen(v => !v)}
            className="w-full flex items-center justify-between text-left text-dim text-xs font-medium py-1.5"
          >
            <span>{advancedOpen ? '▾' : '▸'} Stop Loss / Take Profit (optional)</span>
            <span className="text-dim">
              {tp != null || sl != null ? `TP ${tp ?? '—'} · SL ${sl ?? '—'}` : ''}
            </span>
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-2 gap-3 mt-3">
              <StepperField
                label="SL ($)"
                value={sl}
                onChange={setSl}
                accent="down"
                hint="Auto-close when loss ≥ this USD"
              />
              <StepperField
                label="TP ($)"
                value={tp}
                onChange={setTp}
                accent="up"
                hint="Auto-close when profit ≥ this USD"
              />
            </div>
          )}
        </div>

        {/* Cosmetic fill policy. */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between text-dim text-xs">
          <span>Fill policy</span>
          <span className="text-text font-medium">Fill or Kill</span>
        </div>

        {/* Closed-market banner */}
        {!marketOpen && (
          <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-down text-xs leading-relaxed">
            Market closed for <span className="font-semibold">{info.display_symbol ?? info.symbol}</span> — orders aren't accepted while the session is shut.
          </div>
        )}

        {/* Disclaimer — verbatim MT5 wording. */}
        <p className="px-6 py-4 text-center text-[10px] text-dim leading-relaxed">
          Attention! The trade will be executed at market conditions, difference
          with requested price may be significant.
        </p>

        {err && (
          <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-down/15 border border-down/40 text-down text-xs">
            {err}
          </div>
        )}
      </div>

      {/* Pinned action row */}
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border shrink-0 safe-bottom">
        <button
          type="button"
          onClick={() => submit('SELL')}
          disabled={!marketOpen || busy !== null}
          className="py-4 bg-down/15 hover:bg-down/25 active:bg-down/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <p className="text-down text-base font-bold tracking-wide">
            {busy === 'SELL' ? `${t('trade.sell')}…` : t('trade.sell').toUpperCase()}
          </p>
          <p className="text-down/70 text-[10px] tracking-wider">BY MARKET</p>
        </button>
        <button
          type="button"
          onClick={() => submit('BUY')}
          disabled={!marketOpen || busy !== null}
          className="py-4 bg-up/15 hover:bg-up/25 active:bg-up/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <p className="text-up text-base font-bold tracking-wide">
            {busy === 'BUY' ? `${t('trade.buy')}…` : t('trade.buy').toUpperCase()}
          </p>
          <p className="text-up/70 text-[10px] tracking-wider">BY MARKET</p>
        </button>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

/** PriceBig — renders a price with the MT5 split styling: large integer +
 *  smaller decimals + tiny superscript for the trailing fractional pip.
 *  When stale=true (market closed), greys out + drops the pulse. */
function PriceBig({ value, stale, polarity }: {
  value:    number | null
  stale:    boolean
  polarity: 'up' | 'down'
}) {
  if (value == null) {
    return <p className="text-dim text-xl num">—</p>
  }
  const fixed = value.toFixed(3)
  const [intPart, decPart] = fixed.split('.')
  const main = decPart.slice(0, 2)
  const pip3 = decPart.slice(2)
  const colour = stale ? 'text-dim' : polarity === 'up' ? 'text-up' : 'text-down'
  return (
    <p className={`num ${colour} text-2xl font-bold leading-none`}>
      {intPart}.<span className="text-xl">{main}</span>
      <sup className="text-xs ml-px">{pip3}</sup>
    </p>
  )
}

/** StepperField — number input with ± buttons. value=null is the "unset"
 *  state which we render as an empty input so users distinguish "no SL"
 *  from "SL = 0". Bumps are $1 increments — coarse enough to be useful
 *  without making the field feel laggy on a touchscreen. */
function StepperField({ label, value, onChange, accent, hint }: {
  label:    string
  value:    number | null
  onChange: (n: number | null) => void
  accent:   'up' | 'down'
  hint?:    string
}) {
  const accentText = accent === 'up' ? 'text-up' : 'text-down'
  const bump = (delta: number) => {
    const next = (value ?? 0) + delta
    onChange(next <= 0 ? null : Math.round(next * 100) / 100)
  }
  return (
    <div>
      <p className={`text-[10px] uppercase tracking-wider mb-1 ${accentText}`}>{label}</p>
      <div className="flex items-stretch bg-surface border border-border rounded-lg overflow-hidden">
        <button type="button" onClick={() => bump(-1)} className="px-3 text-dim hover:text-text">−</button>
        <input
          type="number"
          step="0.5"
          min="0"
          placeholder="—"
          value={value ?? ''}
          onChange={e => {
            const v = parseFloat(e.target.value)
            onChange(isFinite(v) && v > 0 ? v : null)
          }}
          className="flex-1 min-w-0 text-center bg-transparent text-text text-sm num py-1.5 focus:outline-none"
        />
        <button type="button" onClick={() => bump(+1)} className="px-3 text-dim hover:text-text">+</button>
      </div>
      {hint && <p className="text-[9px] text-dim mt-1">{hint}</p>}
    </div>
  )
}
