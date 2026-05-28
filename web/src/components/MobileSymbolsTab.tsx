'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SymbolInfo, Tick } from '@/types'
import { displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'

/**
 * MobileSymbolsTab — vertical scrollable list of all tradeable symbols.
 *
 * Inspired by MT5's "Quotes" screen. Each row shows symbol display name,
 * type badge, mid price with directional flash, and bid/ask. Tap any row
 * to select that symbol and auto-jump to the Chart tab.
 */

interface Props {
  symbols:  SymbolInfo[]
  ticks:    Record<string, Tick>
  selected: string
  onSelect: (symbol: string) => void
}

const TYPE_BADGE: Record<string, string> = {
  BOOM_CRASH: 'text-[#f5a623]',
  FX:         'text-up',
  CRYPTO:     'text-[#9b59b6]',
  METAL:      'text-[#d4af37]',
  INDEX:      'text-[#5dade2]',
}

export default function MobileSymbolsTab({ symbols, ticks, selected, onSelect }: Props) {
  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-dim border-b border-border bg-surface/40 sticky top-0 z-10 flex items-center justify-between">
        <span>Quotes · {symbols.length} symbols</span>
        <span className="text-dim/70">Tap to open chart</span>
      </div>
      <ul className="divide-y divide-border">
        {symbols.map(info => (
          <SymbolRow
            key={info.symbol}
            info={info}
            tick={ticks[info.symbol] ?? null}
            selected={info.symbol === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  )
}

function SymbolRow({ info, tick, selected, onSelect }: {
  info:     SymbolInfo
  tick:     Tick | null
  selected: boolean
  onSelect: (symbol: string) => void
}) {
  const prevMid = useRef<number | null>(null)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (!tick) return
    if (prevMid.current !== null && tick.mid !== prevMid.current) {
      setFlash(tick.mid > prevMid.current ? 'up' : 'down')
      const t = setTimeout(() => setFlash(null), 350)
      prevMid.current = tick.mid
      return () => clearTimeout(t)
    }
    prevMid.current = tick.mid
  }, [tick?.ts_ms]) // eslint-disable-line

  const dp = priceDecimals(info)

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(info.symbol)}
        className={clsx(
          'w-full flex items-center justify-between gap-3 px-4 py-3 transition-colors text-left',
          selected
            ? 'bg-surface/70 border-l-2 border-l-brand'
            : 'hover:bg-surface/30 active:bg-surface/50',
        )}
      >
        {/* Left: symbol identity */}
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-semibold text-text">{displayNameOf(info)}</span>
          <span className={clsx('text-[10px] uppercase tracking-wider', TYPE_BADGE[info.type] ?? 'text-dim')}>
            {info.type === 'BOOM_CRASH' ? 'Synthetic' : info.type}
          </span>
        </div>

        {/* Right: price */}
        <div className="flex flex-col items-end gap-0.5 num">
          {tick ? (
            <>
              <span
                className={clsx(
                  'text-base font-semibold',
                  flash === 'up'   ? 'flash-up text-up'   :
                  flash === 'down' ? 'flash-down text-down' : 'text-text',
                )}
              >
                {formatPrice(info, tick.mid, dp)}
              </span>
              <div className="flex gap-1.5 text-[10px]">
                <span className="text-down">{formatPrice(info, tick.bid, dp)}</span>
                <span className="text-dim">/</span>
                <span className="text-up">{formatPrice(info, tick.ask, dp)}</span>
              </div>
            </>
          ) : (
            <span className="text-sm text-dim">—</span>
          )}
        </div>
      </button>
    </li>
  )
}
