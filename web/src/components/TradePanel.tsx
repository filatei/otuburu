'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo } from '@/types'
import { placeCFD, placeBinary } from '@/hooks/useAccount'

interface Props {
  symbol:    string
  info:      SymbolInfo | null
  lastTick:  Tick | null
  accountId: string
  onTraded:  () => void
}

type Mode = 'binary' | 'cfd'

const PAYOUT = 0.85  // house pays 85 % on binary wins

export default function TradePanel({ symbol, info, lastTick, accountId, onTraded }: Props) {
  const [mode,      setMode]      = useState<Mode>('binary')
  const [stake,     setStake]     = useState('10')
  const [lots,      setLots]      = useState('0.01')
  const [ticks,     setTicks]     = useState(5)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState<{ text: string; ok: boolean } | null>(null)

  const notify = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 3000)
  }

  const doTrade = async (dir: 'UP' | 'DOWN' | 'BUY' | 'SELL') => {
    if (busy || !lastTick) return
    setBusy(true)
    try {
      let res: { error?: string }
      if (mode === 'binary') {
        res = await placeBinary(accountId, symbol, dir as 'UP' | 'DOWN', parseFloat(stake) || 10, ticks)
      } else {
        res = await placeCFD(accountId, symbol, dir as 'BUY' | 'SELL', parseFloat(lots) || 0.01)
      }
      if (res.error) notify(res.error, false)
      else { notify('Trade placed ✓', true); onTraded() }
    } catch (e) {
      notify('Request failed', false)
    } finally {
      setBusy(false)
    }
  }

  const stakeNum  = parseFloat(stake)  || 0
  const payout    = (stakeNum * PAYOUT).toFixed(2)
  const lotsNum   = parseFloat(lots)   || 0
  const notional  = info ? (lotsNum * info.contract_size * (lastTick?.mid ?? 0)).toFixed(2) : '—'

  return (
    <div className="flex flex-col h-full bg-panel border-l border-border w-64 shrink-0">
      {/* Mode tabs */}
      <div className="flex border-b border-border">
        <Tab label="Rise/Fall" active={mode === 'binary'} onClick={() => setMode('binary')} />
        <Tab label="CFD"       active={mode === 'cfd'}    onClick={() => setMode('cfd')}    />
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Current price */}
        {lastTick && (
          <div className="bg-surface rounded-lg p-3">
            <div className="text-dim text-[10px] uppercase mb-1">{symbol} · Mid price</div>
            <div className="num text-xl font-bold text-text">
              {lastTick.mid.toFixed(info?.type === 'FX' ? 5 : 3)}
            </div>
            <div className="flex gap-3 mt-1 num text-xs">
              <span className="text-down">Bid {lastTick.bid.toFixed(info?.type === 'FX' ? 5 : 3)}</span>
              <span className="text-up">Ask {lastTick.ask.toFixed(info?.type === 'FX' ? 5 : 3)}</span>
            </div>
          </div>
        )}

        {mode === 'binary' ? (
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
              <Row label="Stake"   val={`$${stakeNum.toFixed(2)}`} />
              <Row label="Payout"  val={`$${payout}`} color="text-up" />
              <Row label="House edge" val="15%" color="text-dim" />
            </div>

            <div className="flex gap-2 mt-auto">
              <TradeBtn label="▲ Rise" color="up"   onClick={() => doTrade('UP')}   busy={busy} />
              <TradeBtn label="▼ Fall" color="down" onClick={() => doTrade('DOWN')} busy={busy} />
            </div>
          </>
        ) : (
          <>
            <Field label="Lots">
              <NumberInput value={lots} onChange={setLots} min={0.01} step={0.01} />
            </Field>

            {info && (
              <div className="bg-surface rounded-lg p-3 text-sm">
                <Row label="Lots"       val={lotsNum.toFixed(2)} />
                <Row label="Notional"   val={`$${notional}`} />
                <Row label="Leverage"   val={`1:${info.leverage}`} />
                <Row label="Spread"     val={lastTick ? ((lastTick.ask - lastTick.bid) * (info.type === 'FX' ? 10000 : 100)).toFixed(1) + ' pts' : '—'} />
              </div>
            )}

            <div className="flex gap-2 mt-auto">
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

function NumberInput({ value, onChange, min, step }: {
  value: string; onChange: (v: string) => void; min: number; step: number
}) {
  return (
    <input
      type="number" value={value} min={min} step={step}
      onChange={e => onChange(e.target.value)}
      className="bg-surface border border-border rounded px-3 py-2 num text-sm text-text
                 focus:outline-none focus:border-brand w-full"
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
