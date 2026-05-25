'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo } from '@/types'
import { placeCFD, placeBinary, placeSpot } from '@/hooks/useAccount'

interface Props {
  symbol:    string
  info:      SymbolInfo | null
  lastTick:  Tick | null
  accountId: string
  onTraded:  () => void
  mobile?:   boolean
}

type Mode = 'binary' | 'cfd' | 'spot'

const PAYOUT = 0.85  // house pays 85 % on binary wins

export default function TradePanel({ symbol, info, lastTick, accountId, onTraded, mobile }: Props) {
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
  const priceDecimals = info?.type === 'FX' ? 5 : (info?.type === 'METAL' ? 2 : 3)
  const spotUnits   = lastTick && spotNum > 0
    ? (spotNum / lastTick.ask).toFixed(info?.type === 'FX' ? 4 : 6)
    : '—'

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
            <div className="text-dim text-[10px] uppercase mb-1">{symbol} · Mid price</div>
            <div className="num text-xl font-bold text-text">
              {lastTick.mid.toFixed(priceDecimals)}
            </div>
            <div className="flex gap-3 mt-1 num text-xs">
              <span className="text-down">Bid {lastTick.bid.toFixed(priceDecimals)}</span>
              <span className="text-up">Ask {lastTick.ask.toFixed(priceDecimals)}</span>
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
                <Row label="Spread"   val={lastTick ? ((lastTick.ask - lastTick.bid) * (info.type === 'FX' ? 10000 : 100)).toFixed(1) + ' pts' : '—'} />
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
          /* Spot tab */
          <>
            <Field label="Stake (USD)">
              <NumberInput value={spotStake} onChange={setSpotStake} min={1} step={10} />
            </Field>

            {lastTick && (
              <div className="bg-surface rounded-lg p-3 text-sm">
                <Row label="You pay"  val={`$${spotNum.toFixed(2)}`} />
                <Row label="You get"  val={`${spotUnits} ${symbol.replace('cry','')}`} color="text-up" />
                <Row label="Leverage" val="1:1" color="text-dim" />
                <Row label="Max loss" val={`$${spotNum.toFixed(2)}`} color="text-dim" />
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
                  <NumberInput value={tp} onChange={setTp} min={0} step={1} placeholder="e.g. 10" />
                </Field>
                <Field label="Stop-loss (USD loss)">
                  <NumberInput value={sl} onChange={setSl} min={0} step={1} placeholder="e.g. 20" />
                </Field>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <TradeBtn label="▲ Buy"  color="up"   onClick={() => doTrade('BUY')}  busy={busy} />
              <TradeBtn label="▼ Sell" color="down" onClick={() => doTrade('SELL')} busy={busy} />
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
