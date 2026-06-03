'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SymbolInfo, Tick } from '@/types'
import { displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'
import { useSessionHL, type SessionRange } from '@/hooks/useSessionHL'
import { isMarketOpen } from '@/lib/marketHours'

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
  /** Today's net P&L per symbol (realised since UTC midnight + open
   *  floating). Omitted entries render as "no activity"; non-zero entries
   *  render small below bid/ask. */
  dailyPnl?: Record<string, number>
  /** Called when a row is tapped. Parent decides what to do — currently
   *  this opens the SymbolActionsSheet for that symbol. */
  onSelect: (symbol: string) => void
  /** Optional: open the watchlist manager so the user can add hidden
   *  symbols. When set, the header gains a "+ Add" affordance. */
  onManage?: () => void
}

const TYPE_BADGE: Record<string, string> = {
  BOOM_CRASH: 'text-[#f5a623]',
  FX:         'text-up',
  CRYPTO:     'text-[#9b59b6]',
  METAL:      'text-[#d4af37]',
  INDEX:      'text-[#5dade2]',
}

export default function MobileSymbolsTab({ symbols, ticks, selected, dailyPnl, onSelect, onManage }: Props) {
  // Session High/Low per symbol, observed off the live tick stream. Resets
  // at UTC midnight. MT5 shows the same pair under each Quotes row.
  const sessionHL = useSessionHL(ticks)

  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-dim border-b border-border bg-surface/40 sticky top-0 z-10 flex items-center justify-between">
        <span>Quotes · {symbols.length} symbols</span>
        {onManage ? (
          <button
            type="button"
            onClick={onManage}
            className="text-brand font-semibold hover:text-brand/80 transition-colors"
          >
            + Add
          </button>
        ) : (
          <span className="text-dim/70">Tap for actions</span>
        )}
      </div>
      <ul className="divide-y divide-border">
        {symbols.map(info => (
          <SymbolRow
            key={info.symbol}
            info={info}
            tick={ticks[info.symbol] ?? null}
            range={sessionHL[info.symbol] ?? null}
            pnl={dailyPnl?.[info.symbol] ?? null}
            selected={info.symbol === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  )
}

function SymbolRow({ info, tick, range, pnl, selected, onSelect }: {
  info:     SymbolInfo
  tick:     Tick | null
  range:    SessionRange | null
  pnl:      number | null
  selected: boolean
  onSelect: (symbol: string) => void
}) {
  const prevMid = useRef<number | null>(null)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)
  // Closed markets shouldn't visually flash — last-known price is shown but
  // it isn't actually moving. We mirror the engine's market-hours gate via
  // tick-age detection: if the most recent tick is too old for the symbol's
  // class (90s for FX/metals/index, 5min for crypto/synthetic) the market
  // is closed and we suppress the flash + render a CLOSED chip.
  const open = isMarketOpen(info, tick)

  useEffect(() => {
    if (!tick || !open) return
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

        {/* Right: bid/ask + today's P&L. Wrapped in a flex column so the
            tiny P&L line sits flush under the bid/ask block. Hidden when
            the symbol has no P&L activity today (MT5-silent — no zero
            placeholders). */}
        <div className="flex flex-col items-end gap-0.5">
          {!tick ? (
            // No tick ever cached — first-time visitor + closed market.
            // Still show a CLOSED hint instead of bare "—".
            !open ? (
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/40 text-dim">
                Closed
              </span>
            ) : (
              <span className="text-sm text-dim">—</span>
            )
          ) : !open ? (
            // Closed market with a cached last tick (typical case after the
            // first session). Show full-size bid/ask tiles but in a muted
            // tone so they read as historical, not live. Trade buttons in
            // the Trade form are gated independently via is_open.
            <div className="flex items-center gap-3 num opacity-60 grayscale">
              <PriceTile label="Bid" value={formatPrice(info, tick.bid, dp)} flash={null} colour="down" />
              <PriceTile label="Ask" value={formatPrice(info, tick.ask, dp)} flash={null} colour="up" />
            </div>
          ) : (
            <div className="flex items-center gap-3 num">
              <PriceTile label="Bid" value={formatPrice(info, tick.bid, dp)} flash={flash} colour="down" />
              <PriceTile label="Ask" value={formatPrice(info, tick.ask, dp)} flash={flash} colour="up" />
            </div>
          )}
          {typeof pnl === 'number' && Math.abs(pnl) >= 0.005 && (
            <span className={clsx(
              'text-[9px] font-semibold num tracking-tight',
              pnl >= 0 ? 'text-up' : 'text-down',
            )}>
              {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} today
            </span>
          )}
        </div>
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
