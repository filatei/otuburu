'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SymbolInfo, Tick } from '@/types'
import { displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'
import { useSessionHL, type SessionRange } from '@/hooks/useSessionHL'

/**
 * MobileSymbolsTab — vertical scrollable list of all tradeable symbols.
 *
 * Inspired by MT5's "Quotes" screen. Each row shows symbol display name,
 * type badge, and bid/ask with directional flash. Tap any row to open the
 * MT5-style actions sheet (Chart / New Order / Close Profitable / Close
 * Losers / Properties).
 */

interface Props {
  symbols:  SymbolInfo[]
  ticks:    Record<string, Tick>
  selected: string
  /** Called when a row is tapped. Parent decides what to do — currently
   *  this opens the SymbolActionsSheet for that symbol. */
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
  // Session High/Low per symbol, observed off the live tick stream. Resets
  // at UTC midnight. MT5 shows the same pair under each Quotes row.
  const sessionHL = useSessionHL(ticks)

  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-dim border-b border-border bg-surface/40 sticky top-0 z-10 flex items-center justify-between">
        <span>Quotes · {symbols.length} symbols</span>
        <span className="text-dim/70">Tap for actions</span>
      </div>
      <ul className="divide-y divide-border">
        {symbols.map(info => (
          <SymbolRow
            key={info.symbol}
            info={info}
            tick={ticks[info.symbol] ?? null}
            range={sessionHL[info.symbol] ?? null}
            selected={info.symbol === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  )
}

function SymbolRow({ info, tick, range, selected, onSelect }: {
  info:     SymbolInfo
  tick:     Tick | null
  range:    SessionRange | null
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
          'w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left',
          selected
            ? 'bg-surface/70 border-l-2 border-l-brand'
            : 'hover:bg-surface/30 active:bg-surface/50',
        )}
      >
        {/* Left: symbol identity (MT5-style — name big, type small below,
            session H/L underneath when ticks have accumulated). */}
        <div className="flex flex-col gap-0.5 min-w-[5rem]">
          <span className="text-[15px] font-bold text-text leading-tight">
            {displayNameOf(info)}
          </span>
          <span className={clsx('text-[9px] uppercase tracking-wider', TYPE_BADGE[info.type] ?? 'text-dim')}>
            {info.type === 'BOOM_CRASH' ? 'Synthetic' : info.type}
          </span>
          {range && (
            <span className="text-[9px] text-dim/70 num tracking-tight">
              H {formatPrice(info, range.high, dp)} · L {formatPrice(info, range.low, dp)}
            </span>
          )}
        </div>

        <div className="flex-1" />

        {/* Right: bid/ask in two columns, MT5-style big numbers */}
        {tick ? (
          <div className="flex items-center gap-3 num">
            <PriceTile label="Bid" value={formatPrice(info, tick.bid, dp)} flash={flash} colour="down" />
            <PriceTile label="Ask" value={formatPrice(info, tick.ask, dp)} flash={flash} colour="up" />
          </div>
        ) : (
          <span className="text-sm text-dim">—</span>
        )}
      </button>
    </li>
  )
}

/** Single bid or ask tile — split into big main digits and small superscript last digit. */
function PriceTile({ label, value, flash, colour }: {
  label:  'Bid' | 'Ask'
  value:  string
  flash:  'up' | 'down' | null
  colour: 'up' | 'down'
}) {
  const big   = value.slice(0, -1)
  const small = value.slice(-1)
  const flashCls =
    flash === 'up'   ? 'flash-up'   :
    flash === 'down' ? 'flash-down' : ''
  return (
    <div className="flex flex-col items-end">
      <span className="text-[8px] uppercase tracking-wider text-dim">{label}</span>
      <span className={clsx(
        'text-[15px] font-bold leading-tight',
        colour === 'up' ? 'text-up' : 'text-down',
        flashCls,
      )}>
        {big}<span className="text-[10px] align-super">{small}</span>
      </span>
    </div>
  )
}
