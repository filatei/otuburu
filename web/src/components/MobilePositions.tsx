'use client'
import { useState, useMemo, useRef } from 'react'
import clsx from 'clsx'
import type {
  Position, BinaryOption, SpotPosition, Tick, SettledTrade, SymbolInfo,
} from '@/types'
import { closePosition, closeSpot } from '@/hooks/useAccount'
import { buildSymbolMap, displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'
import { useSwipeToClose } from '@/hooks/useSwipeToClose'

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

/** MT5 mobile uses exactly two sub-tabs: Trade (anything currently open) and
 *  History (settled trades, most recent first). The previous Open/Recent/
 *  History triad was a misread — Recent was just the first 20 of History. */
type Tab = 'trade' | 'history'

/** History date-range filter. Preset chips cover the 99% case; Custom opens
 *  a pair of date inputs. Stored as a discriminated union so the rendering
 *  logic can show different controls without juggling nullable fields. */
type HistoryFilter =
  | { kind: 'today' }
  | { kind: '7d' }
  | { kind: '30d' }
  | { kind: 'custom'; from: string; to: string } // yyyy-MM-dd inputs

function filterCutoff(f: HistoryFilter): { fromMs: number; toMs: number } {
  const now = Date.now()
  const startOfTodayUTC = (() => {
    const d = new Date()
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  })()
  switch (f.kind) {
    case 'today': return { fromMs: startOfTodayUTC,            toMs: now }
    case '7d':    return { fromMs: now - 7  * 86_400_000,      toMs: now }
    case '30d':   return { fromMs: now - 30 * 86_400_000,      toMs: now }
    case 'custom': {
      // yyyy-MM-dd → UTC start of `from`, UTC end-of-day of `to`. Empty
      // strings produce NaN which is clamped to a permissive range so the
      // user sees results while they're still picking dates.
      const fromMs = f.from ? Date.parse(f.from + 'T00:00:00Z') : 0
      const toMs   = f.to   ? Date.parse(f.to   + 'T23:59:59Z') : now
      return { fromMs: Number.isFinite(fromMs) ? fromMs : 0,
               toMs:   Number.isFinite(toMs)   ? toMs   : now }
    }
  }
}

/** Net P&L per trade. Win: payout (pnl field) minus stake. Loss: -stake. */
function netPnl(t: SettledTrade): number {
  return t.outcome === 'win' ? t.pnl - t.stake : -t.stake
}

export default function MobilePositions(props: Props) {
  const {
    positions, binaries, spots, settledHistory, ticks, symbols,
    accountId, onRefresh, onNewTrade,
  } = props

  const [tab, setTab] = useState<Tab>('trade')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>({ kind: '7d' })
  /** Single-expand: only one row open at a time (mirrors MT5 mobile). null = none. */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const symbolMap = useMemo(() => buildSymbolMap(symbols), [symbols])
  const openCount = positions.length + binaries.length + spots.length

  const toggleExpand = (id: string) =>
    setExpandedId(prev => (prev === id ? null : id))

  // Filtered settled trades + their aggregate net P&L for the filter chip.
  // Memoised on (history, filter) so chip switching is cheap even with a
  // few thousand settled trades.
  const { filteredHistory, filteredPnl } = useMemo(() => {
    const { fromMs, toMs } = filterCutoff(historyFilter)
    const list = settledHistory.filter(t => t.settled_at >= fromMs && t.settled_at <= toMs)
    const pnl  = list.reduce((sum, t) => sum + netPnl(t), 0)
    return { filteredHistory: list, filteredPnl: pnl }
  }, [settledHistory, historyFilter])

  return (
    <div className="flex flex-col h-full">
      {/* Fixed header — tabs + "+" button (does NOT scroll with the list) */}
      <div className="shrink-0 bg-panel border-b border-border">
        <div className="flex items-center">
          <TabBtn label="Trade"   count={openCount}              active={tab === 'trade'}   onClick={() => setTab('trade')} />
          <TabBtn label="History" count={settledHistory.length}  active={tab === 'history'} onClick={() => setTab('history')} />
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

      {/* Scrollable list area. Engine pushes updates via the tick socket —
          no pull-to-refresh by design (MT5 doesn't have one either). */}
      <div className="flex-1 overflow-y-auto">
      {tab === 'trade' && (
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
                position={p}
                info={info}
                current={current}
                expanded={expandedId === p.id}
                onToggle={() => toggleExpand(p.id)}
                onClose={async () => { await closePosition(accountId, p.id); onRefresh() }}
              />
            )
          })}

          {binaries.map(b => {
            const info = symbolMap.get(b.symbol) ?? null
            return (
              <BinaryRow
                key={b.id}
                binary={b}
                info={info}
                expanded={expandedId === b.id}
                onToggle={() => toggleExpand(b.id)}
              />
            )
          })}

          {spots.map(s => {
            const info = symbolMap.get(s.symbol) ?? null
            return (
              <SpotRow
                key={s.id}
                spot={s}
                info={info}
                expanded={expandedId === s.id}
                onToggle={() => toggleExpand(s.id)}
                onClose={async () => { await closeSpot(accountId, s.id); onRefresh() }}
              />
            )
          })}
        </>
      )}

      {tab === 'history' && (
        <>
          <HistoryFilterBar
            filter={historyFilter}
            onChange={setHistoryFilter}
            totalPnl={filteredPnl}
            count={filteredHistory.length}
          />
          {filteredHistory.length === 0
            ? <EmptyState text="No trades in this range" />
            : filteredHistory.map(t => (
                <SettledRow
                key={t.id}
                trade={t}
                info={symbolMap.get(t.symbol) ?? null}
                expanded={expandedId === t.id}
                onToggle={() => toggleExpand(t.id)}
              />
              ))}
        </>
      )}
      </div>
    </div>
  )
}

// ─── Row components ──────────────────────────────────────────────────────────

function PositionRow({ position: p, info, current, expanded, onToggle, onClose }: {
  position: Position
  info:     SymbolInfo | null
  current:  number
  expanded: boolean
  onToggle: () => void
  onClose:  () => Promise<void>
}) {
  const dp = priceDecimals(info)
  return (
    <>
      <SwipeableRow onClose={onClose} onTap={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
            <span>{displayNameOf(info, p.symbol)},</span>
            <span className={clsx('font-semibold', p.side === 'BUY' ? 'text-up' : 'text-down')}>
              {p.side.toLowerCase()}
            </span>
            <span className="text-text">{p.lots.toFixed(2)} lots</span>
          </div>
          <div className="text-[12px] text-dim num mt-0.5">
            {formatPrice(info, p.entry, dp)} <span className="text-dim/60">→</span> {formatPrice(info, current, dp)}
          </div>
        </div>
        <PnlAndClose pnl={p.unrealised_pnl} onClose={onClose} />
      </SwipeableRow>
      {expanded && (
        <ExpandedDetails
          rows={[
            ['Order',    `#${p.id.slice(0, 8)}`],
            ['Open',     fmtOpenTime(p.opened_at_ms)],
            ['S / L',    p.sl_loss   && p.sl_loss   > 0 ? `$${p.sl_loss.toFixed(2)}`   : '—'],
            ['T / P',    p.tp_profit && p.tp_profit > 0 ? `$${p.tp_profit.toFixed(2)}` : '—'],
            ['Margin',   `$${p.margin.toFixed(2)}`],
            ['Notional', `$${p.notional.toFixed(2)}`],
          ]}
        />
      )}
    </>
  )
}

function SpotRow({ spot: s, info, expanded, onToggle, onClose }: {
  spot:     SpotPosition
  info:     SymbolInfo | null
  expanded: boolean
  onToggle: () => void
  onClose:  () => Promise<void>
}) {
  const dp = priceDecimals(info)
  // Display units are TRUE units × divisor (so user sees "22 BTC-units" not "0.022 BTC")
  const displayUnits = s.units * (info?.display_divisor ?? 1)
  return (
    <>
      <SwipeableRow onClose={onClose} onTap={onToggle}>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
            <span>{displayNameOf(info, s.symbol)},</span>
            <span className={clsx('font-semibold', s.side === 'BUY' ? 'text-up' : 'text-down')}>
              spot ${s.stake.toFixed(2)}
            </span>
          </div>
          <div className="text-[12px] text-dim num mt-0.5">
            {displayUnits.toFixed(4)} units @ {formatPrice(info, s.entry, dp)}
          </div>
        </div>
        <PnlAndClose pnl={s.unrealised_pnl} onClose={onClose} />
      </SwipeableRow>
      {expanded && (
        <ExpandedDetails
          rows={[
            ['Order',  `#${s.id.slice(0, 8)}`],
            ['Open',   fmtOpenTime(s.opened_at_ms)],
            ['S / L',  s.sl_loss   && s.sl_loss   > 0 ? `$${s.sl_loss.toFixed(2)}`   : '—'],
            ['T / P',  s.tp_profit && s.tp_profit > 0 ? `$${s.tp_profit.toFixed(2)}` : '—'],
            ['Stake',  `$${s.stake.toFixed(2)}`],
            ['Units',  displayUnits.toFixed(4)],
          ]}
        />
      )}
    </>
  )
}

function BinaryRow({ binary: b, info, expanded, onToggle }: {
  binary:   BinaryOption
  info:     SymbolInfo | null
  expanded: boolean
  onToggle: () => void
}) {
  const dp = priceDecimals(info)
  const isUp = b.direction === 'UP'
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-border/60 active:bg-surface/40 text-left cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-text flex items-baseline gap-1.5 truncate">
            <span>{displayNameOf(info, b.symbol)},</span>
            <span className={clsx('font-semibold', isUp ? 'text-up' : 'text-down')}>
              {isUp ? 'rise' : 'fall'} ${b.stake.toFixed(0)}
            </span>
          </div>
          <div className="text-[12px] text-dim num mt-0.5 flex items-center gap-2">
            <span>{formatPrice(info, b.entry_mid, dp)}</span>
            <span className="text-dim/60">·</span>
            <span className="flex items-center gap-1.5">
              <span className="w-12 h-1 bg-muted rounded-full">
                <span
                  className={clsx('block h-1 rounded-full', isUp ? 'bg-up' : 'bg-down')}
                  style={{ width: `${(b.ticks_left / b.ticks_total) * 100}%` }}
                />
              </span>
              {b.ticks_left}/{b.ticks_total}
            </span>
          </div>
        </div>
        <span className="text-[11px] text-dim italic shrink-0 ml-2">settling…</span>
      </button>
      {expanded && (
        <ExpandedDetails
          rows={[
            ['Order',     `#${b.id.slice(0, 8)}`],
            ['Opened',    fmtOpenTime(b.opened_at_ms)],
            ['Direction', isUp ? 'RISE / UP' : 'FALL / DOWN'],
            ['Stake',     `$${b.stake.toFixed(2)}`],
            ['Entry',     formatPrice(info, b.entry_mid, dp)],
            ['Ticks',     `${b.ticks_left} of ${b.ticks_total} left`],
          ]}
        />
      )}
    </>
  )
}

function SettledRow({ trade: t, info, expanded, onToggle }: {
  trade:    SettledTrade
  info:     SymbolInfo | null
  expanded: boolean
  onToggle: () => void
}) {
  const dp = priceDecimals(info)
  const net = t.outcome === 'win' ? t.pnl - t.stake : -t.stake
  const isUp = t.direction === 'UP'
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-border/60 active:bg-surface/40 text-left cursor-pointer"
      >
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
      </button>
      {expanded && (
        <ExpandedDetails
          rows={[
            ['Order',     `#${t.id.slice(0, 8)}`],
            // opened_at is optional on legacy localStorage entries.
            ['Opened',    t.opened_at ? fmtOpenTime(t.opened_at) : '—'],
            ['Settled',   fmtOpenTime(t.settled_at)],
            ['Direction', isUp ? 'RISE / UP' : 'FALL / DOWN'],
            ['Stake',     `$${t.stake.toFixed(2)}`],
            ['Entry',     formatPrice(info, t.entry_mid, dp)],
            ['Outcome',   t.outcome === 'win' ? 'WON' : 'LOST'],
            ['Payout',    t.outcome === 'win' ? `$${t.pnl.toFixed(2)}` : '$0.00'],
            ['Net P&L',   `${net >= 0 ? '+' : ''}$${net.toFixed(2)}`],
          ]}
        />
      )}
    </>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function RowFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/60 active:bg-surface/40">
      {children}
    </div>
  )
}

/** SwipeableRow — wraps a row with a left-swipe-to-close gesture AND an
 *  optional tap-to-expand. The two gestures coexist: meaningful horizontal
 *  movement (≥10px) engages the swipe and suppresses the tap; a quick
 *  release without drift fires onTap. Browsers don't dispatch click after
 *  a touch drag with sufficient movement, so onClick on the foreground
 *  div is safe — but we belt-and-braces it with an offset==0 check too. */
function SwipeableRow({ children, onClose, onTap }: {
  children: React.ReactNode
  onClose:  () => void | Promise<void>
  onTap?:   () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { offset, armed } = useSwipeToClose(ref, onClose)
  const swiping = offset !== 0

  // Defence against a click that synthesises after a swipe — only treat
  // it as a tap when the row is at rest. Without this, the offscreen
  // animation triggered by close could race with the synthetic click and
  // toggle expand on the SAME row we just closed.
  const handleClick = () => {
    if (offset === 0 && onTap) onTap()
  }

  return (
    <div className="relative overflow-hidden border-b border-border/60">
      {/* Background revealed under the row as it slides left */}
      {swiping && (
        <div
          className={clsx(
            'absolute inset-0 flex items-center justify-end px-4 transition-colors',
            armed ? 'bg-down/80' : 'bg-down/30',
          )}
        >
          <span className={clsx(
            'text-[11px] font-bold uppercase tracking-wider transition-colors',
            armed ? 'text-white' : 'text-down',
          )}>
            {armed ? 'Release to close' : 'Swipe to close'}
          </span>
        </div>
      )}
      {/* Foreground row that actually translates */}
      <div
        ref={ref}
        onClick={handleClick}
        role={onTap ? 'button' : undefined}
        className={clsx(
          'relative flex items-center gap-3 px-4 py-2.5 bg-panel active:bg-surface/40',
          onTap && 'cursor-pointer',
        )}
        style={{
          transform: `translateX(${offset}px)`,
          transition: offset === 0 ? 'transform 200ms ease' : 'none',
          touchAction: 'pan-y', // hint the browser: vertical scroll OK, horizontal handled by us
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** ExpandedDetails — MT5-style detail panel revealed under a tapped row.
 *  Two-column grid; left labels in dim, right values bold + mono. Used by
 *  PositionRow and SpotRow; pure presentation so it can render any
 *  ordered list of [label, value] tuples. */
function ExpandedDetails({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="bg-surface/40 border-b border-border/60 px-4 py-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <span className="text-dim">{label}:</span>
            <span className="text-text font-semibold num text-right truncate">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** fmtOpenTime — MT5-style local timestamp: "2026.05.28 16:18:39".
 *  Uses local time intentionally; traders relate open times to their own
 *  trading session, not UTC. */
function fmtOpenTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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

// ─── History filter bar ──────────────────────────────────────────────────────
//
// Preset date-range chips + custom range, plus an aggregate net P&L badge
// for the filtered slice. Sticky-top inside the scroll container so the
// user can scroll long histories without losing the totals.
//
// Custom uses native <input type="date"> which Mobile Safari and Chrome
// render as the system date picker — no library needed, no calendar layout
// to maintain. Range applies on the fly as the user picks each date.

function HistoryFilterBar({ filter, onChange, totalPnl, count }: {
  filter:   HistoryFilter
  onChange: (f: HistoryFilter) => void
  totalPnl: number
  count:    number
}) {
  const isToday  = filter.kind === 'today'
  const is7d     = filter.kind === '7d'
  const is30d    = filter.kind === '30d'
  const isCustom = filter.kind === 'custom'

  const today = useMemo(() => {
    const d = new Date()
    return d.toISOString().slice(0, 10)
  }, [])

  return (
    <div className="sticky top-0 z-10 bg-panel border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <FilterChip label="Today" active={isToday}  onClick={() => onChange({ kind: 'today' })} />
        <FilterChip label="7d"    active={is7d}     onClick={() => onChange({ kind: '7d' })} />
        <FilterChip label="30d"   active={is30d}    onClick={() => onChange({ kind: '30d' })} />
        <FilterChip label="Custom" active={isCustom} onClick={() =>
          onChange({ kind: 'custom', from: '', to: today })
        } />
        <div className="flex-1" />
        {/* Total P&L for the filtered slice. Tucked right of the chips so it
            sits next to the time-range the number applies to. */}
        <div className="flex items-baseline gap-1.5">
          <span className="text-[9px] uppercase tracking-wider text-dim">Net</span>
          <span className={clsx(
            'num text-sm font-bold',
            totalPnl >= 0 ? 'text-up' : 'text-down',
          )}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </span>
          <span className="text-[10px] text-dim/70">· {count}</span>
        </div>
      </div>
      {isCustom && (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs">
          <label className="text-dim shrink-0">From</label>
          <input
            type="date"
            value={filter.from}
            max={filter.to || today}
            onChange={e => onChange({ kind: 'custom', from: e.target.value, to: filter.to })}
            className="flex-1 bg-surface border border-border rounded-md px-2 py-1 text-text num"
          />
          <label className="text-dim shrink-0">To</label>
          <input
            type="date"
            value={filter.to}
            min={filter.from}
            max={today}
            onChange={e => onChange({ kind: 'custom', from: filter.from, to: e.target.value })}
            className="flex-1 bg-surface border border-border rounded-md px-2 py-1 text-text num"
          />
        </div>
      )}
    </div>
  )
}

function FilterChip({ label, active, onClick }: {
  label: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors',
        active
          ? 'bg-brand text-black'
          : 'bg-surface/60 text-dim hover:text-text border border-border/60',
      )}
    >
      {label}
    </button>
  )
}
