'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo, AccountState } from '@/types'
import { placeCFD, placeBinary, placeSpot } from '@/hooks/useAccount'
import { displayNameOf, divisorOf, priceDecimals } from '@/lib/symbols'

/**
 * MobileTradeForm — MT5-style order entry as the entire Trade tab.
 *
 * Layout (top to bottom, no scrolling needed to reach the action):
 *
 *   ┌────────────────────────────────────────────┐
 *   │ XAUUSD  4.4370   ·   Balance $9,813.68    │  slim header
 *   │  Rise/Fall  ·  CFD  ·  Spot                │  mode chips
 *   ├────────────────────────────────────────────┤
 *   │  ┌──────────┐ ┌───┐ ┌──────────┐           │
 *   │  │ SELL     │ │ ▾ │ │ BUY      │           │  TILES = THE ACTION.
 *   │  │ 4.4303³  │ │50 │ │ 4.4437⁷  │           │  Tap to place trade.
 *   │  └──────────┘ │ ▴ │ └──────────┘           │
 *   │               └───┘                         │
 *   ├────────────────────────────────────────────┤
 *   │ Quick:  $10  $50  $100  $500  MAX          │
 *   ├────────────────────────────────────────────┤
 *   │ You'll receive: 11.25 units @ 4.44 each    │
 *   │ +1% move = +$0.50 profit                   │
 *   ├────────────────────────────────────────────┤
 *   │ ▸ Take-profit / Stop-loss                  │  collapsible
 *   └────────────────────────────────────────────┘
 *
 * Replaces the previous AccountStatsPanel + TradePanel combo on mobile Trade.
 * Desktop continues to use the regular TradePanel (split-pane layout).
 */

type Mode = 'binary' | 'spot' | 'cfd'
type Direction = 'UP' | 'DOWN' | 'BUY' | 'SELL'

const QUICK_STAKES = [10, 50, 100, 500]
const VOLUME_STEPS = [1, 5, 10, 25, 50, 100, 250, 500, 1000]

interface Props {
  symbol:      string
  info:        SymbolInfo | null
  lastTick:    Tick | null
  account:     AccountState | null
  accountId:   string
  floatingPnl: number
  onTraded:    () => void
}

export default function MobileTradeForm({
  symbol, info, lastTick, account, accountId, floatingPnl, onTraded,
}: Props) {
  const [stake,    setStake]    = useState(50)
  const [mode,     setMode]     = useState<Mode>('binary')
  const [ticks,    setTicks]    = useState(5)
  const [tp,       setTp]       = useState('')
  const [sl,       setSl]       = useState('')
  const [showTpSl, setShowTpSl] = useState(false)
  const [busy,     setBusy]     = useState(false)
  const [msg,      setMsg]      = useState<{ text: string; ok: boolean } | null>(null)

  const isSpotSym  = info?.type === 'CRYPTO' || info?.type === 'METAL' || info?.type === 'INDEX'
  const decimals   = priceDecimals(info)
  const displaySym = displayNameOf(info, symbol)
  const divisor    = divisorOf(info)
  const balance    = account?.balance ?? 0

  const activeMode: Mode = mode === 'spot' && !isSpotSym ? 'binary' : mode

  const notify = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 2500)
  }

  const stepStake = (dir: 1 | -1) => {
    const i = VOLUME_STEPS.findIndex(v => v >= stake)
    if (dir > 0) {
      setStake(VOLUME_STEPS[Math.min(VOLUME_STEPS.length - 1, i + 1)] ?? stake)
    } else {
      setStake(VOLUME_STEPS[Math.max(0, i - 1)] ?? stake)
    }
  }

  const doTrade = async (dir: Direction) => {
    if (busy || !lastTick || stake <= 0) return
    if (stake > balance) { notify('Insufficient balance', false); return }
    setBusy(true)
    try {
      const tpVal = parseFloat(tp) > 0 ? parseFloat(tp) : undefined
      const slVal = parseFloat(sl) > 0 ? parseFloat(sl) : undefined

      let res: { error?: string }
      if (activeMode === 'binary') {
        res = await placeBinary(accountId, symbol, dir as 'UP' | 'DOWN', stake, ticks)
      } else if (activeMode === 'cfd') {
        const contractSize = info?.contract_size ?? 1
        const lots = +(stake / (contractSize * lastTick.mid)).toFixed(4)
        res = await placeCFD(accountId, symbol, dir as 'BUY' | 'SELL', lots || 0.01, tpVal, slVal)
      } else {
        // Spot is buy-only opening. Either direction → BUY.
        res = await placeSpot(accountId, symbol, 'BUY', stake, tpVal, slVal)
      }
      if (res.error) notify(res.error, false)
      else { notify('Trade placed ✓', true); onTraded() }
    } catch {
      notify('Request failed', false)
    } finally {
      setBusy(false)
    }
  }

  // Direction mapping per mode for the two tiles
  const sellLabel = activeMode === 'binary' ? 'FALL' : 'SELL'
  const buyLabel  = activeMode === 'binary' ? 'RISE' : 'BUY'
  const sellDir: Direction = activeMode === 'binary' ? 'DOWN' : 'SELL'
  const buyDir:  Direction = activeMode === 'binary' ? 'UP'   : 'BUY'

  // Spot is buy-only at open — disable SELL tile in spot mode
  const sellDisabled = activeMode === 'spot' || busy || !lastTick

  // Preview text per mode
  const previewLine: { primary: string; secondary?: string } = (() => {
    if (!lastTick || stake <= 0) return { primary: '—' }
    const ask = lastTick.ask
    if (activeMode === 'binary') {
      const payout = (stake * 1.85).toFixed(2)
      return { primary: `Win pays $${payout}`, secondary: `${ticks} ticks · 85% payout` }
    }
    if (activeMode === 'spot') {
      const units = (stake * divisor) / ask
      return {
        primary: `${units.toFixed(4)} ${displaySym}`,
        secondary: `at ${(ask / divisor).toFixed(decimals)} each`,
      }
    }
    // CFD
    const contractSize = info?.contract_size ?? 1
    const lots = stake / (contractSize * lastTick.mid)
    const lev = info?.leverage ?? 1
    return {
      primary: `${lots.toFixed(4)} lots @ ${lev}× leverage`,
      secondary: `notional ${(lots * contractSize * lastTick.mid).toFixed(2)} USD`,
    }
  })()

  const profitOn1pct = stake * 0.01
  const belowMin = stake > 0 && stake < 1
  const overBalance = stake > balance

  return (
    <div className="flex flex-col">
      {/* ── Slim header — symbol + balance + floating PnL ─────────────────── */}
      <div className="px-3 pt-2 pb-1 flex items-baseline justify-between border-b border-border/60">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold text-text">{displaySym}</span>
          {lastTick && (
            <span className="num text-sm text-dim">
              {(lastTick.mid / divisor).toFixed(decimals)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-dim num">
          Bal ${balance.toFixed(2)}
          <span
            className={clsx('ml-2 font-semibold', floatingPnl >= 0 ? 'text-up' : 'text-down')}
          >
            {floatingPnl >= 0 ? '+' : ''}{floatingPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* ── Mode chips ─────────────────────────────────────────────────────── */}
      <div className="flex border-b border-border">
        <ModeTab label="Rise/Fall" active={activeMode === 'binary'} onClick={() => setMode('binary')} />
        <ModeTab label="CFD"       active={activeMode === 'cfd'}    onClick={() => setMode('cfd')}    />
        {isSpotSym && (
          <ModeTab label="Spot" active={activeMode === 'spot'} onClick={() => setMode('spot')} />
        )}
      </div>

      {/* ── Sell / Volume / Buy tiles (THE ACTION) ─────────────────────────── */}
      <div className="px-2 pt-2 pb-1.5 flex items-stretch gap-1.5">
        <button
          onClick={() => doTrade(sellDir)}
          disabled={sellDisabled}
          className="flex-1 flex flex-col items-start justify-center px-3 py-3 rounded-md
                     bg-down/20 border-2 border-down/40 disabled:opacity-25
                     active:scale-[0.98] transition-transform"
        >
          <span className="text-[10px] font-bold tracking-wider text-down">{sellLabel}</span>
          <PriceLabel price={lastTick?.bid} decimals={decimals} divisor={divisor} colour="down" />
        </button>

        {/* Volume stepper */}
        <div className="w-20 flex flex-col items-center bg-surface rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => stepStake(1)}
            className="w-full flex-1 text-text hover:bg-surface/60 active:scale-95 text-sm"
            aria-label="Increase volume"
          >
            ▴
          </button>
          <input
            type="number"
            value={stake}
            min={1}
            step={1}
            onChange={e => setStake(+e.target.value || 0)}
            className="w-full text-center bg-transparent num text-base font-semibold text-text
                       focus:outline-none border-y border-border py-0.5"
          />
          <button
            type="button"
            onClick={() => stepStake(-1)}
            className="w-full flex-1 text-text hover:bg-surface/60 active:scale-95 text-sm"
            aria-label="Decrease volume"
          >
            ▾
          </button>
        </div>

        <button
          onClick={() => doTrade(buyDir)}
          disabled={busy || !lastTick}
          className="flex-1 flex flex-col items-end justify-center px-3 py-3 rounded-md
                     bg-up/20 border-2 border-up/40 disabled:opacity-25
                     active:scale-[0.98] transition-transform"
        >
          <span className="text-[10px] font-bold tracking-wider text-up">{buyLabel}</span>
          <PriceLabel price={lastTick?.ask} decimals={decimals} divisor={divisor} colour="up" />
        </button>
      </div>

      {/* ── Quick stake chips ──────────────────────────────────────────────── */}
      <div className="px-2 pb-2 flex gap-1.5">
        {QUICK_STAKES.map(v => (
          <button
            key={v}
            type="button"
            onClick={() => setStake(v)}
            disabled={v > Math.floor(balance)}
            className={clsx(
              'flex-1 py-1.5 text-[11px] font-semibold rounded border transition-colors num disabled:opacity-30',
              stake === v
                ? 'border-brand bg-brand/15 text-brand'
                : 'border-border text-dim hover:text-text',
            )}
          >
            ${v}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setStake(Math.floor(balance))}
          className="flex-1 py-1.5 text-[11px] font-semibold rounded border border-border text-dim
                     hover:text-text uppercase"
        >
          Max
        </button>
      </div>

      {/* ── Preview / hints ────────────────────────────────────────────────── */}
      <div className="px-3 py-2 bg-surface/40 border-y border-border/50">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-dim">
            {activeMode === 'binary' ? 'Payout' :
             activeMode === 'spot'   ? "You'll receive" :
             'Position'}
          </span>
          <span className="num text-base font-bold text-text">{previewLine.primary}</span>
        </div>
        {previewLine.secondary && (
          <div className="text-[11px] text-dim mt-0.5 text-right">{previewLine.secondary}</div>
        )}
        {stake > 0 && activeMode !== 'binary' && (
          <div className="text-[11px] text-dim mt-1">
            +1% move on {displaySym} = <span className="text-up font-semibold num">+${profitOn1pct.toFixed(2)}</span> profit
          </div>
        )}
      </div>

      {/* ── Validation warnings ────────────────────────────────────────────── */}
      {belowMin && (
        <div className="mx-2 my-2 text-[11px] text-down/90 bg-down/10 rounded px-2 py-1">
          Minimum stake is $1
        </div>
      )}
      {overBalance && (
        <div className="mx-2 my-2 text-[11px] text-down/90 bg-down/10 rounded px-2 py-1">
          Exceeds available balance
        </div>
      )}

      {/* ── Binary duration slider (only in Rise/Fall mode) ────────────────── */}
      {activeMode === 'binary' && (
        <div className="px-3 py-2 border-t border-border/50">
          <div className="text-[10px] uppercase tracking-wider text-dim mb-1">
            Duration · {ticks} ticks
          </div>
          <input
            type="range"
            min={1} max={10} value={ticks}
            onChange={e => setTicks(+e.target.value)}
            className="w-full accent-brand"
          />
          <div className="flex justify-between text-[10px] text-dim num">
            <span>1</span><span>5</span><span>10</span>
          </div>
        </div>
      )}

      {/* ── TP/SL collapsible ──────────────────────────────────────────────── */}
      {activeMode !== 'binary' && (
        <div className="px-3 py-2 border-t border-border/50">
          <button
            type="button"
            onClick={() => setShowTpSl(v => !v)}
            className="text-[10px] uppercase tracking-wider text-dim hover:text-text transition-colors"
          >
            {showTpSl ? '▾' : '▸'} Take-profit / Stop-loss
          </button>
          {showTpSl && (
            <div className="flex gap-2 mt-2">
              <div className="flex-1">
                <label className="text-[9px] uppercase text-dim">TP (USD)</label>
                <input
                  type="number" value={tp} onChange={e => setTp(e.target.value)} min={0} step={1}
                  placeholder="e.g. 20"
                  className="w-full bg-surface border border-border rounded px-2 py-1 num text-sm text-text
                             focus:outline-none focus:border-brand placeholder:text-dim"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] uppercase text-dim">SL (USD)</label>
                <input
                  type="number" value={sl} onChange={e => setSl(e.target.value)} min={0} step={1}
                  placeholder="e.g. 10"
                  className="w-full bg-surface border border-border rounded px-2 py-1 num text-sm text-text
                             focus:outline-none focus:border-brand placeholder:text-dim"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      {msg && (
        <div className={clsx(
          'mx-2 my-2 text-center py-1.5 rounded text-xs font-semibold',
          msg.ok ? 'text-up bg-up/10' : 'text-down bg-down/10',
        )}>
          {msg.text}
        </div>
      )}
    </div>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex-1 py-2 text-[11px] font-semibold uppercase tracking-wider border-b-2 transition-colors',
        active ? 'border-brand text-brand' : 'border-transparent text-dim hover:text-text',
      )}
    >
      {label}
    </button>
  )
}

function PriceLabel({ price, decimals, divisor, colour }: {
  price?:   number
  decimals: number
  divisor:  number
  colour:   'up' | 'down'
}) {
  if (price === undefined || !Number.isFinite(price)) {
    return <span className="num text-lg text-dim">—</span>
  }
  const display = price / divisor
  const formatted = display.toFixed(decimals)
  const big   = formatted.slice(0, -1)
  const small = formatted.slice(-1)
  return (
    <span className={clsx('num text-xl font-bold leading-tight', colour === 'up' ? 'text-up' : 'text-down')}>
      {big}<span className="text-sm align-super">{small}</span>
    </span>
  )
}
