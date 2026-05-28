'use client'
import { useState, useMemo } from 'react'
import clsx from 'clsx'
import type {
  Position, BinaryOption, SpotPosition, Tick, SettledTrade, SymbolInfo,
} from '@/types'
import { closePosition, closeSpot } from '@/hooks/useAccount'
import { buildSymbolMap, displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'

/**
 * MobilePositions — MT5-style positions view.
 *
 * Two-line dense rows (no columnar table). Side is encoded as a coloured
 * inline word ("buy" green, "sell" red) — no separate Side column. P&L is
 * right-aligned, coloured by sign. Tap a row to expand close-controls.
 *
 *   XAUUSD, buy 0.01                              -0.60
 *   4.49383 → 4.43044
 *
 * A "+" button in the header opens the Trade tab so users can place
 * new trades from the same screen they monitor positions on.
 */

interface Props {
  positions:      Position[]
  binaries:       BinaryOption[]
  spots:          SpotPosition[]
  settledHistory: SettledTrade[]
  ticks:          Record<string, Tick>
  symbols:        SymbolInfo[]
  accountId:      string
  onRefresh:      () => void
  /** Switch the mobile parent to the Trade tab (called by the "+" button). */
  onNewTrade?:    () => void
}

type Tab = 'open' | 'recent' | 'history'

export default function MobilePositions(props: Props) {
  const {
    positions, binaries, spots, settledHistory, ticks, symbols,
    accountId, onRefresh, onNewTrade,
  } = props

  const [tab, setTab] = useState<Tab>('open')
  const symbolMap = useMemo(() => buildSymbolMap(symbols), [symbols])
  const openCount = positions.length + binaries.length + spots.length

  return (
    <div className="flex flex-col">
      {/* Sticky header — tabs + "+" button */}
      <div className="sticky top-0 z-10 bg-panel border-b border-border">
        <div className="flex items-center">
          <TabBtn label="Open"    count={openCount}              active={tab === 'open'}    onClick={() => setTab('open')} />
          <TabBtn label="Recent"  count={settledHistory.length}  active={tab === 'recent'}  onClick={() => setTab('recent')} />
          <TabBtn label="History"                                active={tab === 'history'} onClick={() => setTab('history')} />
          <div className="flex-1" />
          {onNewTrade && (
            <button
              type="button"
              onClick={onNewTrade}
              aria-label="New trade"
              className="px-3 py-2 mr-1 text-base text-text hover:text-brand active:scale-95 transition-all"
            >
              +
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {tab === 'open' && (
        <>
          {openCount === 0 && (
            <EmptyState text="No open trades" subText="Tap + to place a trade" />
          )}

          {positions.map(p => {
            const info = symbolMap.get(p.symbol) ?? null
            const tick = ticks[p.symbol]
            const current = tick ? (p.side === 'BUY' ? tick.bid : tick.ask) : p.entry
            return (
              <PositionRow
                key={p.id}
                info={info}
                symbolId={p.symbol}
                side={p.side}
                sizeText={`${p.lots.toFixed(2)} lots`}
                entry={p.entry}
                current={current}
                pnl={p.unrealised_pnl}
                onClose={async () => { await closePosition(accountId, p.id); onRefresh() }}
              />
            )
          })}

          {binaries.map(b => {
            const info = symbolMap.get(b.symbol) ?? null
            return (
              <BinaryRow
                key={b.id}
                info={info}
                symbolId={b.symbol}
                direction={b.direction}
                stake={b.stake}
                entry={b.entry_mid}
                ticksLeft={b.ticks_left}
                ticksTotal={b.ticks_total}
              />
            )
          })}

          {spots.map(s => {
            const info = symbolMap.get(s.symbol) ?? null
            return (
              <SpotRow
                key={s.id}
                info={info}
                symbolId={s.symbol}
                side={s.side}
                stake={s.stake}
                units={s.units}
                entry={s.entry}
                pnl={s.unrealised_pnl}
                onClose={async () => { await closeSpot(accountId, s.id); onRefresh() }}
              />
            )
          })}
        </>
      )}

      {tab === 'recent' && (
        settledHistory.slice(0, 20).length === 0
          ? <EmptyState text="No recent trades" />
          : settledHistory.slice(0, 20).map(t => (
              <SettledRow key={t.id} trade={t} info={symbolMap.get(t.symbol) ?? null} />
            ))
      )}

      {tab === 'history' && (
        settledHistory.length === 0
          ? <EmptyState text="No trade history" />
          : settledHistory.map(t => (
              <SettledRow key={t.id} trade={t} info={symbolMap.get(t.symbol) ?? null} />
            ))
      )}
    </div>
  )
}

// ─── Row components ──────────────────────────────────────────────────────────

function PositionRow({ info, symbolId, side, sizeText, entry, current, pnl, onClose }: {
  info: SymbolInfo | null; symbolId: string; side: 'BUY' | 'SELL';
  sizeText: string; entry: number; current: number; pnl: number;
  onClose: () => Promise<void>
}) {
  const dp = priceDecimals(info)
  return (
    <RowFrame onLongHold={onClose}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
          <span>{displayNameOf(info, symbolId)},</span>
          <span className={clsx('font-semibold', side === 'BUY' ? 'text-up' : 'text-down')}>
            {side.toLowerCase()}
          </span>
          <span className="text-text">{sizeText}</span>
        </div>
        <div className="text-[12px] text-dim num mt-0.5">
          {formatPrice(info, entry, dp)} <span className="text-dim/60">→</span> {formatPrice(info, current, dp)}
        </div>
      </div>
      <PnlAndClose pnl={pnl} onClose={onClose} />
    </RowFrame>
  )
}

function SpotRow({ info, symbolId, side, stake, units, entry, pnl, onClose }: {
  info: SymbolInfo | null; symbolId: string; side: 'BUY' | 'SELL';
  stake: number; units: number; entry: number; pnl: number;
  onClose: () => Promise<void>
}) {
  const dp = priceDecimals(info)
  // Display units are TRUE units × divisor (so user sees "22 BTC-units" not "0.022 BTC")
  const displayUnits = units * (info?.display_divisor ?? 1)
  return (
    <RowFrame onLongHold={onClose}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
          <span>{displayNameOf(info, symbolId)},</span>
          <span className={clsx('font-semibold', side === 'BUY' ? 'text-up' : 'text-down')}>
            spot ${stake.toFixed(2)}
          </span>
        </div>
        <div className="text-[12px] text-dim num mt-0.5">
          {displayUnits.toFixed(4)} units @ {formatPrice(info, entry, dp)}
        </div>
      </div>
      <PnlAndClose pnl={pnl} onClose={onClose} />
    </RowFrame>
  )
}

function BinaryRow({ info, symbolId, direction, stake, entry, ticksLeft, ticksTotal }: {
  info: SymbolInfo | null; symbolId: string; direction: 'UP' | 'DOWN';
  stake: number; entry: number; ticksLeft: number; ticksTotal: number
}) {
  const dp = priceDecimals(info)
  const isUp = direction === 'UP'
  return (
    <RowFrame>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
          <span>{displayNameOf(info, symbolId)},</span>
          <span className={clsx('font-semibold', isUp ? 'text-up' : 'text-down')}>
            {isUp ? 'rise' : 'fall'} ${stake.toFixed(0)}
          </span>
        </div>
        <div className="text-[12px] text-dim num mt-0.5 flex items-center gap-2">
          <span>{formatPrice(info, entry, dp)}</span>
          <span className="text-dim/60">·</span>
          <span className="flex items-center gap-1.5">
            <span className="w-12 h-1 bg-muted rounded-full">
              <span
                className={clsx('block h-1 rounded-full', isUp ? 'bg-up' : 'bg-down')}
                style={{ width: `${(ticksLeft / ticksTotal) * 100}%` }}
              />
            </span>
            {ticksLeft}/{ticksTotal}
          </span>
        </div>
      </div>
      <span className="text-[11px] text-dim italic shrink-0 ml-2">settling…</span>
    </RowFrame>
  )
}

function SettledRow({ trade: t, info }: { trade: SettledTrade; info: SymbolInfo | null }) {
  const dp = priceDecimals(info)
  const net = t.outcome === 'win' ? t.pnl - t.stake : -t.stake
  const isUp = t.direction === 'UP'
  return (
    <RowFrame>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
          <span>{displayNameOf(info, t.symbol)},</span>
          <span className={clsx('font-semibold', isUp ? 'text-up' : 'text-down')}>
            {isUp ? 'rise' : 'fall'} ${t.stake.toFixed(0)}
          </span>
        </div>
        <div className="text-[12px] text-dim num mt-0.5">
          {formatPrice(info, t.entry_mid, dp)}
          <span className="text-dim/60 mx-1">·</span>
          {formatAgo(t.settled_at)}
        </div>
      </div>
      <span className={clsx('num text-sm font-bold shrink-0 ml-2', net >= 0 ? 'text-up' : 'text-down')}>
        {net >= 0 ? '+' : ''}{net.toFixed(2)}
      </span>
    </RowFrame>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function RowFrame({ children }: {
  children: React.ReactNode
  onLongHold?: () => void  // reserved — future swipe-to-close
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/60 active:bg-surface/40">
      {children}
    </div>
  )
}

function PnlAndClose({ pnl, onClose }: { pnl: number; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <span className={clsx('num text-sm font-bold', pnl >= 0 ? 'text-up' : 'text-down')}>
        {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="px-2 py-0.5 text-[10px] uppercase tracking-wide rounded
                   border border-down/40 text-down hover:bg-down/10 active:scale-95"
      >
        Close
      </button>
    </div>
  )
}

function TabBtn({ label, count, active, onClick }: {
  label: string; count?: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-semibold border-b-2 transition-colors',
        active ? 'border-brand text-text' : 'border-transparent text-dim hover:text-text',
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="bg-brand/20 text-brand text-[9px] px-1 rounded-full">{count}</span>
      )}
    </button>
  )
}

function EmptyState({ text, subText }: { text: string; subText?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-dim">
      <span className="text-sm">{text}</span>
      {subText && <span className="text-xs mt-1 text-dim/70">{subText}</span>}
    </div>
  )
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}
