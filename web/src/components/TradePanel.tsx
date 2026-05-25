'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo, AccountState } from '@/types'
import { placeCFD, placeBinary, placeSpot } from '@/hooks/useAccount'
import { displayNameOf, divisorOf, formatPrice, priceDecimals, MIN_SPOT_STAKE_USD } from '@/lib/symbols'

interface Props {
  symbol:    string
  info:      SymbolInfo | null
  lastTick:  Tick | null
  account:   AccountState | null
  accountId: string
  onTraded:  () => void
  mobile?:   boolean
}

/** Quick-stake chip values in USD. MAX is computed from balance. */
const QUICK_STAKES = [10, 50, 100, 500]

type Mode = 'binary' | 'cfd' | 'spot'

const PAYOUT = 0.85  // house pays 85 % on binary wins

export default function TradePanel({ symbol, info, lastTick, account, accountId, onTraded, mobile }: Props) {
  const [mode,      setMode]      = useState<Mode>('binary')
  const [stake,     setStake]     = useState('10')
  const [lots,      setLots]      = useState('0.01')
  const [spotStake, setSpotStake] = useState('50')
  const [ticks,     setTicks]     = useState(5)
  // TP/SL — stored as empty string when not set
  const [tp,        setTp]        = useState('')
  const [sl,        setSl]        = useState('')
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState<{ text: string; ok: boolean } | null>(null)
  const [showTpSl,  setShowTpSl]  = useState(false)

  const notify = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 3000)
  }

  const doTrade = async (dir: 'UP' | 'DOWN' | 'BUY' | 'SELL') => {
    if (busy || !lastTick) return
    setBusy(true)
    try {
      let res: { error?: string }
      const tpVal = parseFloat(tp) > 0 ? parseFloat(tp) : undefined
      const slVal = parseFloat(sl) > 0 ? parseFloat(sl) : undefined

      if (mode === 'binary') {
        res = await placeBinary(accountId, symbol, dir as 'UP' | 'DOWN', parseFloat(stake) || 10, ticks)
      } else if (mode === 'cfd') {
        res = await placeCFD(accountId, symbol, dir as 'BUY' | 'SELL', parseFloat(lots) || 0.01, tpVal, slVal)
      } else {
        // spot
        res = await placeSpot(accountId, symbol, dir as 'BUY' | 'SELL', parseFloat(spotStake) || 50, tpVal, slVal)
      }
      if (res.error) notify(res.error, false)
      else { notify('Trade placed ✓', true); onTraded() }
    } catch {
      notify('Request failed', false)
    } finally {
      setBusy(false)
    }
  }

  const stakeNum    = parseFloat(stake)     || 0
  const payout      = (stakeNum * PAYOUT).toFixed(2)
  const lotsNum     = parseFloat(lots)      || 0
  const spotNum     = parseFloat(spotStake) || 0
  const notional    = info ? (lotsNum * info.contract_size * (lastTick?.mid ?? 0)).toFixed(2) : '—'
  const isSpotSym   = info?.type === 'CRYPTO' || info?.type === 'METAL'
  const decimals    = priceDecimals(info)
  const displaySym  = displayNameOf(info, symbol)
  const divisor     = divisorOf(info)

  // Auto-switch away from Spot if symbol doesn't support it
  const activeMode: Mode = mode === 'spot' && !isSpotSym ? 'cfd' : mode

  return (
    <div className={`flex flex-col bg-panel ${mobile ? 'w-full' : 'h-full border-l border-border w-64 shrink-0'}`}>
      {/* Mode tabs */}
      <div className="flex border-b border-border shrink-0">
        <Tab label="Rise/Fall" active={activeMode === 'binary'} onClick={() => setMode('binary')} />
        <Tab label="CFD"       active={activeMode === 'cfd'}    onClick={() => setMode('cfd')}    />
        {isSpotSym && (
          <Tab label="Spot" active={activeMode === 'spot'} onClick={() => setMode('spot')} />
        )}
      </div>

      <div className={`${mobile ? '' : 'flex-1'} overflow-y-auto p-4 flex flex-col gap-4`}>
        {/* Current price */}
        {lastTick && (
          <div className="bg-surface rounded-lg p-3">
            <div className="text-dim text-[10px] uppercase mb-1">{displaySym} · Mid price</div>
            <div className="num text-xl font-bold text-text">
              {formatPrice(info, lastTick.mid, decimals)}
            </div>
            <div className="flex gap-3 mt-1 num text-xs">
              <span className="text-down">Bid {formatPrice(info, lastTick.bid, decimals)}</span>
              <span className="text-up">Ask {formatPrice(info, lastTick.ask, decimals)}</span>
            </div>
          </div>
        )}

        {activeMode === 'binary' ? (
          <>
            <Field label="Stake (USD)">
              <NumberInput value={stake} onChange={setStake} min={1} step={1} />
            </Field>

            <Field label={`Duration · ${ticks} ticks`}>
              <input
                type="range" min={1} max={10} value={ticks}
                onChange={e => setTicks(+e.target.value)}
                className="w-full accent-brand"
              />
              <div className="flex justify-between text-[10px] text-dim mt-1 num">
                <span>1</span><span>5</span><span>10</span>
              </div>
            </Field>

            <div className="bg-surface rounded-lg p-3 text-sm">
              <Row label="Stake"      val={`$${stakeNum.toFixed(2)}`} />
              <Row label="Payout"     val={`$${payout}`} color="text-up" />
              <Row label="House edge" val="15%" color="text-dim" />
            </div>

            <div className="flex gap-2 pt-2">
              <TradeBtn label="▲ Rise" color="up"   onClick={() => doTrade('UP')}   busy={busy} />
              <TradeBtn label="▼ Fall" color="down" onClick={() => doTrade('DOWN')} busy={busy} />
            </div>
          </>

        ) : activeMode === 'cfd' ? (
          <>
            <Field label="Lots">
              <NumberInput value={lots} onChange={setLots} min={0.01} step={0.01} />
            </Field>

            {info && (
              <div className="bg-surface rounded-lg p-3 text-sm">
                <Row label="Lots"     val={lotsNum.toFixed(2)} />
                <Row label="Notional" val={`$${notional}`} />
                <Row label="Leverage" val={`1:${info.leverage}`} />
                <Row
                  label="Spread"
                  val={
                    lastTick
                      ? (((lastTick.ask - lastTick.bid) / divisor) * (info.type === 'FX' ? 10000 : 100)).toFixed(1) + ' pts'
                      : '—'
                  }
                />
              </div>
            )}

            {/* TP / SL toggle */}
            <button
              onClick={() => setShowTpSl(v => !v)}
              className="text-[10px] text-dim uppercase tracking-wider text-left hover:text-text transition-colors"
            >
              {showTpSl ? '▾' : '▸'} Take-profit / Stop-loss
            </button>

            {showTpSl && (
              <div className="flex flex-col gap-2">
                <Field label="Take-profit (USD profit)">
                  <NumberInput value={tp} onChange={setTp} min={0} step={1} placeholder="e.g. 20" />
                </Field>
                <Field label="Stop-loss (USD loss)">
                  <NumberInput value={sl} onChange={setSl} min={0} step={1} placeholder="e.g. 10" />
                </Field>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <TradeBtn label="▲ Buy"  color="up"   onClick={() => doTrade('BUY')}  busy={busy} />
              <TradeBtn label="▼ Sell" color="down" onClick={() => doTrade('SELL')} busy={busy} />
            </div>
          </>

        ) : (
          /* ── Fractional Spot tab ─────────────────────────────────────────────
           * Buy-only opening. Sell happens by closing an existing position from
           * the Positions table. Balance-aware quick chips + prominent fractional
           * preview + +1% profit hint + min-stake warning.
           */
          <>
            <Field label="Investment ($)">
              <NumberInput value={spotStake} onChange={setSpotStake} min={MIN_SPOT_STAKE_USD} step={10} />
              <QuickChips
                value={spotNum}
                balance={account?.balance ?? null}
                onPick={(v) => setSpotStake(String(v))}
              />
            </Field>

            {lastTick && (() => {
              const displayPrice = lastTick.ask / divisor
              const displayUnits = spotNum > 0 ? (spotNum * divisor) / lastTick.ask : 0
              const profitOn1pct = spotNum * 0.01
              const belowMin     = spotNum > 0 && spotNum < MIN_SPOT_STAKE_USD
              const overBalance  = account ? spotNum > account.balance : false

              return (
                <div className="flex flex-col gap-3">
                  {/* Prominent fractional preview */}
                  <div className="bg-surface rounded-lg p-3">
                    <div className="text-dim text-[10px] uppercase tracking-wider mb-1">You'll receive</div>
                    <div className="num text-2xl font-bold text-up">
                      {displayUnits > 0 ? displayUnits.toFixed(4) : '—'} <span className="text-text text-sm font-medium">{displaySym}</span>
                    </div>
                    <div className="text-dim text-[11px] num mt-0.5">
                      at {displayPrice.toFixed(decimals)} each
                    </div>
                  </div>

                  {/* +1% profit hint */}
                  {spotNum > 0 && (
                    <div className="text-[11px] text-dim leading-relaxed">
                      A +1% move in {displaySym} = <span className="text-up font-semibold num">+${profitOn1pct.toFixed(2)}</span> profit
                      {' · '}
                      <span className="text-dim">balance ${account?.balance.toFixed(2) ?? '—'}</span>
                    </div>
                  )}

                  {/* Validation hints */}
                  {belowMin && (
                    <div className="text-[11px] text-down/90 bg-down/10 rounded px-2 py-1">
                      Minimum investment is ${MIN_SPOT_STAKE_USD.toFixed(2)}
                    </div>
                  )}
                  {overBalance && (
                    <div className="text-[11px] text-down/90 bg-down/10 rounded px-2 py-1">
                      Exceeds available balance
                    </div>
                  )}
                </div>
              )
            })()}

            {/* TP / SL toggle */}
            <button
              onClick={() => setShowTpSl(v => !v)}
              className="text-[10px] text-dim uppercase tracking-wider text-left hover:text-text transition-colors"
            >
              {showTpSl ? '▾' : '▸'} Take-profit / Stop-loss
            </button>

            {showTpSl && (
              <div className="flex flex-col gap-2">
                <Field label="Take-profit (USD profit)">
                  <NumberInput value={tp} onChange={setTp} min={0} step={1} placeholder="e.g. 10" />
                </Field>
                <Field label="Stop-loss (USD loss)">
                  <NumberInput value={sl} onChange={setSl} min={0} step={1} placeholder="e.g. 20" />
                </Field>
              </div>
            )}

            {/* Single Buy CTA — Sell is done by closing from Positions */}
            <div className="pt-2">
              <TradeBtn label={`Buy ${displaySym}`} color="up" onClick={() => doTrade('BUY')} busy={busy} />
            </div>
            <div className="text-[10px] text-dim text-center -mt-2 leading-tight">
              To sell, close your position from the Positions tab.
            </div>
          </>
        )}

        {msg && (
          <div className={clsx('text-xs text-center py-2 rounded', msg.ok ? 'text-up' : 'text-down')}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors',
        active ? 'border-brand text-brand' : 'border-transparent text-dim hover:text-text',
      )}
    >
      {label}
    </button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-dim uppercase tracking-wider">{label}</label>
      {children}
    </div>
  )
}

function NumberInput({ value, onChange, min, step, placeholder }: {
  value: string; onChange: (v: string) => void; min: number; step: number; placeholder?: string
}) {
  return (
    <input
      type="number" value={value} min={min} step={step}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="bg-surface border border-border rounded px-3 py-2 num text-sm text-text
                 focus:outline-none focus:border-brand w-full placeholder:text-dim"
    />
  )
}

function TradeBtn({ label, color, onClick, busy }: {
  label: string; color: 'up' | 'down'; onClick: () => void; busy: boolean
}) {
  const cls = color === 'up'
    ? 'bg-up/10 border-up/40 text-up hover:bg-up/20'
    : 'bg-down/10 border-down/40 text-down hover:bg-down/20'
  return (
    <button
      onClick={onClick} disabled={busy}
      className={clsx('flex-1 py-3 rounded border font-semibold text-sm transition-colors disabled:opacity-40', cls)}
    >
      {label}
    </button>
  )
}

function Row({ label, val, color = 'text-text' }: { label: string; val: string; color?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-dim text-xs">{label}</span>
      <span className={clsx('num text-xs font-medium', color)}>{val}</span>
    </div>
  )
}

/** Quick-pick stake chips: $10 / $50 / $100 / $500 / MAX (=balance, floored). */
function QuickChips({ value, balance, onPick }: {
  value:   number
  balance: number | null
  onPick:  (v: number) => void
}) {
  const max = balance !== null && balance > 0 ? Math.floor(balance) : null
  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      {QUICK_STAKES.map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          disabled={max !== null && v > max}
          className={clsx(
            'px-2 py-0.5 text-[10px] num rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
            value === v
              ? 'border-brand text-brand bg-brand/10'
              : 'border-border text-dim hover:text-text hover:border-text/40',
          )}
        >
          ${v}
        </button>
      ))}
      {max !== null && max > 0 && (
        <button
          type="button"
          onClick={() => onPick(max)}
          className={clsx(
            'px-2 py-0.5 text-[10px] uppercase rounded border transition-colors',
            value === max
              ? 'border-brand text-brand bg-brand/10'
              : 'border-border text-dim hover:text-text hover:border-text/40',
          )}
        >
          Max
        </button>
      )}
    </div>
  )
}
