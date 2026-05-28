'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { Tick, SymbolInfo, AccountState } from '@/types'
import { placeCFD, placeBinary, placeSpot } from '@/hooks/useAccount'
import { displayNameOf, divisorOf, formatPrice, priceDecimals } from '@/lib/symbols'

/**
 * MobileQuickTrade — always-visible bottom strip on the Chart view (mobile).
 *
 * Goal: trade in one tap from the chart without switching tabs.
 *
 * Shows:
 *  - Current bid / ask for the selected symbol
 *  - Quick stake input ($1 / $5 / $10 / $50 chips + free input)
 *  - Mode toggle: Rise/Fall (binary) vs Buy/Sell (spot or CFD by symbol class)
 *  - Two big primary action buttons
 *
 * For full controls (TP/SL, lots, custom ticks) users tap the Trade tab.
 */

type QuickMode = 'binary' | 'spot' | 'cfd'

const QUICK_STAKES = [1, 5, 10, 50]

interface Props {
  symbol:    string
  info:      SymbolInfo | null
  lastTick:  Tick | null
  account:   AccountState | null
  accountId: string
  onTraded:  () => void
}

export default function MobileQuickTrade({ symbol, info, lastTick, account, accountId, onTraded }: Props) {
  const [stake,  setStake]  = useState(10)
  const [mode,   setMode]   = useState<QuickMode>('binary')
  const [busy,   setBusy]   = useState(false)
  const [msg,    setMsg]    = useState<{ text: string; ok: boolean } | null>(null)

  const isSpotSym  = info?.type === 'CRYPTO' || info?.type === 'METAL' || info?.type === 'INDEX'
  const decimals   = priceDecimals(info)
  const displaySym = displayNameOf(info, symbol)
  const divisor    = divisorOf(info)
  const balance    = account?.balance ?? 0

  // Auto-shift away from spot mode if symbol doesn't support it
  const activeMode: QuickMode = mode === 'spot' && !isSpotSym ? 'binary' : mode

  const notify = (text: string, ok: boolean) => {
    setMsg({ text, ok })
    setTimeout(() => setMsg(null), 2500)
  }

  const doTrade = async (dir: 'UP' | 'DOWN' | 'BUY' | 'SELL') => {
    if (busy || !lastTick || stake <= 0) return
    if (stake > balance) { notify('Insufficient balance', false); return }
    setBusy(true)
    try {
      let res: { error?: string }
      if (activeMode === 'binary') {
        res = await placeBinary(accountId, symbol, dir as 'UP' | 'DOWN', stake, 5)
      } else if (activeMode === 'cfd') {
        // Convert USD stake → lots = stake / (contract_size × mid)
        const contractSize = info?.contract_size ?? 1
        const mid = lastTick.mid
        const lots = +(stake / (contractSize * mid)).toFixed(4)
        res = await placeCFD(accountId, symbol, dir as 'BUY' | 'SELL', lots || 0.01)
      } else {
        res = await placeSpot(accountId, symbol, 'BUY', stake)
      }
      if (res.error) notify(res.error, false)
      else { notify('Trade placed ✓', true); onTraded() }
    } catch {
      notify('Request failed', false)
    } finally {
      setBusy(false)
    }
  }

  // The two action buttons reshape based on mode
  const leftLabel  = activeMode === 'binary' ? '▲ Rise' : activeMode === 'spot' ? '▲ Buy'  : '▲ Buy'
  const rightLabel = activeMode === 'binary' ? '▼ Fall' : activeMode === 'spot' ? '◀ Sell' : '▼ Sell'
  const leftDir:  'UP' | 'BUY'  = activeMode === 'binary' ? 'UP'   : 'BUY'
  const rightDir: 'DOWN' | 'SELL' = activeMode === 'binary' ? 'DOWN' : 'SELL'
  const spotHidesSell = activeMode === 'spot' // Spot is buy-only (per design)

  return (
    <div className="bg-panel border-t border-border shrink-0">
      {/* Live price strip */}
      {lastTick && (
        <div className="px-3 py-1.5 flex items-center justify-between bg-surface/40 text-[11px] num">
          <span className="text-text font-semibold">{displaySym}</span>
          <div className="flex gap-3">
            <span className="text-down">Bid {formatPrice(info, lastTick.bid, decimals)}</span>
            <span className="text-up">Ask {formatPrice(info, lastTick.ask, decimals)}</span>
          </div>
          <span className="text-dim">Bal ${balance.toFixed(2)}</span>
        </div>
      )}

      {/* Mode toggle + stake controls */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-2">
        <div className="flex rounded bg-surface/60 p-0.5 text-[10px] font-semibold">
          <ModeChip label="Rise/Fall" active={activeMode === 'binary'} onClick={() => setMode('binary')} />
          {isSpotSym && (
            <ModeChip label="Spot"     active={activeMode === 'spot'}   onClick={() => setMode('spot')}   />
          )}
          <ModeChip label="CFD"        active={activeMode === 'cfd'}    onClick={() => setMode('cfd')}    />
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-dim uppercase">Stake</span>
          <input
            type="number" inputMode="decimal" value={stake}
            min={1} step={1}
            onChange={e => setStake(+e.target.value || 0)}
            className="w-16 bg-surface border border-border rounded px-2 py-1 num text-sm text-text
                       focus:outline-none focus:border-brand text-right"
          />
        </div>
      </div>

      {/* Quick-stake chips */}
      <div className="px-3 pb-2 flex gap-1.5">
        {QUICK_STAKES.map(v => (
          <button
            key={v}
            type="button"
            onClick={() => setStake(v)}
            className={clsx(
              'flex-1 py-1 text-[11px] font-semibold rounded border transition-colors num',
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
          className="flex-1 py-1 text-[11px] font-semibold rounded border border-border text-dim
                     hover:text-text uppercase"
        >
          Max
        </button>
      </div>

      {/* Big action buttons */}
      <div className="px-3 pb-3 flex gap-2">
        <button
          onClick={() => doTrade(leftDir as 'UP' | 'BUY')}
          disabled={busy || !lastTick || stake <= 0}
          className="flex-1 py-3 rounded-md border-2 border-up/60 bg-up/15 text-up font-bold text-base
                     disabled:opacity-40 active:scale-95 transition-transform"
        >
          {leftLabel}
        </button>
        {!spotHidesSell && (
          <button
            onClick={() => doTrade(rightDir as 'DOWN' | 'SELL')}
            disabled={busy || !lastTick || stake <= 0}
            className="flex-1 py-3 rounded-md border-2 border-down/60 bg-down/15 text-down font-bold text-base
                       disabled:opacity-40 active:scale-95 transition-transform"
          >
            {rightLabel}
          </button>
        )}
      </div>

      {/* Inline toast (replaces any previous on each tap) */}
      {msg && (
        <div className={clsx(
          'text-[11px] text-center pb-2 -mt-1',
          msg.ok ? 'text-up' : 'text-down',
        )}>
          {msg.text}
        </div>
      )}
    </div>
  )
}

function ModeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 rounded text-[10px] uppercase tracking-wider transition-colors',
        active ? 'bg-brand text-black' : 'text-dim',
      )}
    >
      {label}
    </button>
  )
}
