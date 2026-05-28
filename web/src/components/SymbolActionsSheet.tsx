'use client'
import { useState } from 'react'
import clsx from 'clsx'
import type { SymbolInfo, Tick, Position, SpotPosition } from '@/types'
import { closePosition, closeSpot } from '@/hooks/useAccount'
import { displayNameOf, formatPrice, priceDecimals } from '@/lib/symbols'
import BottomSheet from './BottomSheet'

/* Properties intentionally lives in its own SymbolPropertiesModal that the
 * parent (page.tsx) mounts/unmounts on demand — see SymbolPropertiesModal.tsx
 * for why that matters. The "Properties" action here just bubbles up. */

/**
 * SymbolActionsSheet — MT5-style context menu shown when a symbol row is
 * tapped on the Quotes screen. Replaces the previous behaviour where tap
 * jumped straight to the Chart tab.
 *
 * Actions (mirrors MT5 mobile):
 *   • Open Chart           → switch to chart tab with this symbol selected
 *   • New Order            → switch to trade tab with this symbol selected
 *   • Close Profitable (N) → close every BUY/SELL/Spot for this symbol
 *                            whose unrealised P&L is currently positive.
 *                            Disabled when N === 0.
 *   • Close Losers (N)     → same for unrealised P&L < 0. Disabled when 0.
 *   • Properties           → expands inline with spec rows (type, leverage,
 *                            contract size, cadence, divisor).
 *
 * Binaries are intentionally excluded from the close actions — they run to
 * the configured tick countdown and cannot be cashed out mid-flight.
 */

interface Props {
  open:             boolean
  onClose:          () => void
  info:             SymbolInfo | null
  tick:             Tick | null
  positions:        Position[]
  spots:            SpotPosition[]
  accountId:        string
  onOpenChart:      () => void
  onNewOrder:       () => void
  /** Open the dedicated Properties modal for this symbol. Parent owns the
   *  Properties lifecycle so each open is a fresh component instance. */
  onOpenProperties: () => void
  /** Called after a successful close-batch so the parent can refresh. */
  onTraded:         () => void
}

export default function SymbolActionsSheet({
  open, onClose, info, tick, positions, spots, accountId,
  onOpenChart, onNewOrder, onOpenProperties, onTraded,
}: Props) {
  const [busy, setBusy] = useState<null | 'profitable' | 'losers'>(null)

  if (!info) {
    // Nothing to render but keep the sheet mountable so the open→null
    // transition doesn't flicker. BottomSheet handles open=false gracefully.
    return <BottomSheet open={false} onClose={onClose}>{null}</BottomSheet>
  }

  // Filter open exposure to this symbol only. Binaries excluded by design.
  const symPositions = positions.filter(p => p.symbol === info.symbol)
  const symSpots     = spots.filter(s => s.symbol === info.symbol)

  const profitable = [
    ...symPositions.filter(p => (p.unrealised_pnl ?? 0) > 0),
    ...symSpots.filter(s => (s.unrealised_pnl ?? 0) > 0),
  ]
  const losers = [
    ...symPositions.filter(p => (p.unrealised_pnl ?? 0) < 0),
    ...symSpots.filter(s => (s.unrealised_pnl ?? 0) < 0),
  ]

  // Bulk-close helper — fires all close calls in parallel via Promise.all,
  // then triggers a single refresh. Errors are swallowed per-item so one
  // failed close doesn't strand the rest.
  const closeBatch = async (kind: 'profitable' | 'losers') => {
    const batch = kind === 'profitable' ? profitable : losers
    if (batch.length === 0) return
    setBusy(kind)
    try {
      await Promise.allSettled(batch.map(item =>
        'lots' in item
          ? closePosition(accountId, item.id)
          : closeSpot(accountId, item.id),
      ))
      onTraded()
      onClose()
    } finally {
      setBusy(null)
    }
  }

  const dp = priceDecimals(info)
  const bid = tick ? formatPrice(info, tick.bid, dp) : '—'
  const ask = tick ? formatPrice(info, tick.ask, dp) : '—'

  return (
    <BottomSheet open={open} onClose={onClose}>
      {/* Symbol header — replaces the standard sheet title because we want
          the live bid/ask under the name, MT5-style. */}
      <div className="px-5 pt-3 pb-3 border-b border-border">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-text font-bold text-lg leading-none truncate">
              {displayNameOf(info)}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-dim shrink-0">
              {info.type === 'BOOM_CRASH' ? 'Synthetic' : info.type}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 -mr-1 flex items-center justify-center text-dim hover:text-text"
          >
            ✕
          </button>
        </div>
        <div className="mt-1.5 flex items-baseline gap-4 text-xs num">
          <span className="text-dim">Bid <span className="text-down font-semibold ml-1">{bid}</span></span>
          <span className="text-dim">Ask <span className="text-up   font-semibold ml-1">{ask}</span></span>
        </div>
      </div>

      {/* Action list */}
      <div className="py-2">
        <ActionRow icon="📈" label="Open Chart"  onClick={() => { onOpenChart(); onClose() }} />
        <ActionRow icon="➕" label="New Order"   onClick={() => { onNewOrder();  onClose() }} />

        <ActionRow
          icon="✓"
          label="Close Profitable"
          count={profitable.length}
          tone="up"
          busy={busy === 'profitable'}
          disabled={profitable.length === 0 || busy !== null}
          onClick={() => closeBatch('profitable')}
        />
        <ActionRow
          icon="✕"
          label="Close Losers"
          count={losers.length}
          tone="down"
          busy={busy === 'losers'}
          disabled={losers.length === 0 || busy !== null}
          onClick={() => closeBatch('losers')}
        />

        <ActionRow
          icon="ⓘ"
          label="Properties"
          onClick={() => { onOpenProperties(); onClose() }}
        />
      </div>
    </BottomSheet>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function ActionRow({ icon, label, count, tone, busy, disabled, onClick }: {
  icon:      string
  label:     string
  count?:    number
  tone?:     'up' | 'down'
  busy?:     boolean
  disabled?: boolean
  onClick:   () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'w-full flex items-center gap-3 px-5 py-3 text-left transition-colors',
        'active:bg-surface/70 hover:bg-surface/40',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      <span className={clsx(
        'w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0',
        tone === 'up'   && 'bg-up/15   text-up',
        tone === 'down' && 'bg-down/15 text-down',
        !tone           && 'bg-surface text-text',
      )}>
        {icon}
      </span>
      <span className="flex-1 text-sm text-text font-medium">{label}</span>
      {typeof count === 'number' && (
        <span className={clsx(
          'text-xs font-semibold num px-2 py-0.5 rounded-full',
          tone === 'up'   ? 'bg-up/10   text-up'   :
          tone === 'down' ? 'bg-down/10 text-down' :
                            'bg-muted/50 text-dim',
        )}>
          {count}
        </span>
      )}
      {busy && <span className="text-dim text-xs">working…</span>}
    </button>
  )
}
