'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo, AccountState } from '@/types'
import { placeCFD, placeBinary, placeSpot } from '@/hooks/useAccount'
import { displayNameOf, divisorOf, priceDecimals } from '@/lib/symbols'

/**
 * MobileChartTiles — MT5-style Sell/Buy price tiles at top of the Chart screen.
 *
 *   ┌───────────┐ ┌───┐ ┌───────────┐
 *   │ SELL      │ │ v │ │ BUY       │
 *   │ 4408.114  │ │ 2 │ │ 4408.394  │  ← prices have superscript last digits
 *   └───────────┘ │ ^ │ └───────────┘
 *                 └───┘
 *
 * Volume between Sell/Buy. Tap a tile to place an immediate trade at the
 * current bid/ask using the visible volume (in USD for binary/spot, lots
 * for CFD).
 */

interface Props {
  symbol:    string
  info:      SymbolInfo | null
  lastTick:  Tick | null
  account:   AccountState | null
  accountId: string
  onTraded:  () => void
}

type Mode = 'binary' | 'spot' | 'cfd'

const PRESET_STEPS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500]

export default function MobileChartTiles({ symbol, info, lastTick, account, accountId, onTraded }: Props) {
  const [volume, setVolume] = useState(2)
  const [mode,   setMode]   = useState<Mode>('binary')
  const [busy,   setBusy]   = useState(false)
  const [msg,    setMsg]    = useState<{ text: string; ok: boolean } | null>(null)

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

  const stepVolume = (dir: 1 | -1) => {
    const i = PRESET_STEPS.findIndex(v => v >= volume)
    const next = dir > 0
      ? PRESET_STEPS[Math.min(PRESET_STEPS.length - 1, i + 1)] ?? volume
      : PRESET_STEPS[Math.max(0, i - 1)] ?? volume
    setVolume(next)
  }

  const doTrade = async (dir: 'UP' | 'DOWN' | 'BUY' | 'SELL') => {
    if (busy || !lastTick || volume <= 0) return
    if (volume > balance) { notify('Insufficient balance', false); return }
    setBusy(true)
    try {
      let res: { error?: string }
      if (activeMode === 'binary') {
        res = await placeBinary(accountId, symbol, dir as 'UP' | 'DOWN', volume, 5)
      } else if (activeMode === 'cfd') {
        const contractSize = info?.contract_size ?? 1
        const lots = +(volume / (contractSize * lastTick.mid)).toFixed(4)
        res = await placeCFD(accountId, symbol, dir as 'BUY' | 'SELL', lots || 0.01)
      } else {
        // Spot is buy-only opening; map both tiles to BUY in spot mode.
        res = await placeSpot(accountId, symbol, 'BUY', volume)
      }
      if (res.error) notify(res.error, false)
      else { notify('Trade placed ✓', true); onTraded() }
    } catch {
      notify('Request failed', false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-panel border-b border-border shrink-0">
      {/* Mode selector strip */}
      <div className="px-3 pt-2 pb-1.5 flex items-center gap-2 text-[10px]">
        <span className="text-dim uppercase tracking-wider">{displaySym}</span>
        <span className="flex-1" />
        <div className="flex rounded bg-surface/60 p-0.5 font-semibold">
          <Chip label="Rise/Fall" active={activeMode === 'binary'} onClick={() => setMode('binary')} />
          {isSpotSym && (
            <Chip label="Spot" active={activeMode === 'spot'} onClick={() => setMode('spot')} />
          )}
          <Chip label="CFD" active={activeMode === 'cfd'} onClick={() => setMode('cfd')} />
        </div>
      </div>

      {/* Sell / Volume / Buy tiles row */}
      <div className="px-2 pb-2 flex items-stretch gap-1.5">
        {/* SELL tile */}
        <button
          onClick={() => doTrade(activeMode === 'binary' ? 'DOWN' : 'SELL')}
          disabled={busy || !lastTick || activeMode === 'spot'}
          className="flex-1 flex flex-col items-start justify-center px-3 py-2 rounded-md
                     bg-down/20 border border-down/40 disabled:opacity-30
                     active:scale-[0.98] transition-transform"
        >
          <span className="text-[9px] font-bold tracking-wider text-down">
            {activeMode === 'binary' ? 'FALL' : 'SELL'}
          </span>
          <PriceLabel price={lastTick?.bid} decimals={decimals} divisor={divisor} color="down" />
        </button>

        {/* Volume stepper */}
        <div className="w-16 flex flex-col items-center justify-between bg-surface rounded-md border border-border">
          <button
            type="button"
            onClick={() => stepVolume(1)}
            className="w-full py-1 text-text hover:bg-surface/60 active:scale-95"
            aria-label="Increase volume"
          >
            ▴
          </button>
          <span className="num text-base font-semibold text-text">
            {volume < 1 ? volume.toFixed(2) : volume}
          </span>
          <button
            type="button"
            onClick={() => stepVolume(-1)}
            className="w-full py-1 text-text hover:bg-surface/60 active:scale-95"
            aria-label="Decrease volume"
          >
            ▾
          </button>
        </div>

        {/* BUY tile */}
        <button
          onClick={() => doTrade(activeMode === 'binary' ? 'UP' : 'BUY')}
          disabled={busy || !lastTick}
          className="flex-1 flex flex-col items-end justify-center px-3 py-2 rounded-md
                     bg-up/20 border border-up/40 disabled:opacity-30
                     active:scale-[0.98] transition-transform"
        >
          <span className="text-[9px] font-bold tracking-wider text-up">
            {activeMode === 'binary' ? 'RISE' : 'BUY'}
          </span>
          <PriceLabel price={lastTick?.ask} decimals={decimals} divisor={divisor} color="up" />
        </button>
      </div>

      {msg && (
        <div className={clsx(
          'text-[11px] text-center pb-1.5',
          msg.ok ? 'text-up' : 'text-down',
        )}>
          {msg.text}
        </div>
      )}
    </div>
  )
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-2 py-0.5 rounded text-[9px] uppercase tracking-wider transition-colors',
        active ? 'bg-brand text-black' : 'text-dim',
      )}
    >
      {label}
    </button>
  )
}

/** Big price with smaller superscript last digits, MT5-style: 4408.11⁴ */
function PriceLabel({ price, decimals, divisor, color }: {
  price?:    number
  decimals:  number
  divisor:   number
  color:     'up' | 'down'
}) {
  if (price === undefined || !Number.isFinite(price)) {
    return <span className="num text-lg text-dim">—</span>
  }
  const display = price / divisor
  const formatted = display.toFixed(decimals)
  const big   = formatted.slice(0, -1)
  const small = formatted.slice(-1)
  return (
    <span className={clsx('num text-lg font-bold leading-tight', color === 'up' ? 'text-up' : 'text-down')}>
      {big}<span className="text-xs align-super">{small}</span>
    </span>
  )
}
