'use client'
import clsx from 'clsx'
import type { AccountState } from '@/types'

/**
 * AccountStatsPanel — MT5-style account summary with dotted-leader rows.
 *
 *   Balance:       ........  487,497.21
 *   Equity:        ........  285,292.91
 *   Margin:        ........    3,101.53
 *   Free margin:   ........  282,191.38
 *   Margin Level:  ........    9,198.46%
 *
 * The dotted leader is rendered with a CSS-only approach so it scales
 * to any width and breaks responsively. Used on the mobile Trade and
 * Positions tabs as the screen header.
 */

interface Props {
  account: AccountState | null
  /** Aggregate floating P&L from all open positions, shown above the rows. */
  floatingPnl?: number
  /** Optional tab label rendered at the very top (e.g. "Trade"). */
  title?: string
}

export default function AccountStatsPanel({ account, floatingPnl, title }: Props) {
  // MT5 ethos: no "Loading…" copy. When the account hasn't arrived from the
  // engine yet, render the rows with em-dashes so the layout is stable and
  // the values just appear when they're ready. See: feedback_mt5_silent_ux.md
  const rows: Array<{ label: string; value: string; color?: string }> = account
    ? [
        { label: 'Balance',         value: fmt(account.balance) },
        { label: 'Equity',          value: fmt(account.equity) },
        { label: 'Margin',          value: fmt(account.used_margin) },
        { label: 'Free margin',     value: fmt(account.free_margin) },
        { label: 'Margin Level (%)', value: account.used_margin > 0
            ? fmt(account.margin_level)
            : '—' },
      ]
    : [
        { label: 'Balance',          value: '—' },
        { label: 'Equity',           value: '—' },
        { label: 'Margin',           value: '—' },
        { label: 'Free margin',      value: '—' },
        { label: 'Margin Level (%)', value: '—' },
      ]

  const pnlValue =
    typeof floatingPnl === 'number' ? floatingPnl : 0
  const pnlColor =
    typeof floatingPnl === 'number'
      ? floatingPnl >= 0 ? 'text-up' : 'text-down'
      : 'text-dim'

  return (
    <div className="bg-panel border-b border-border">
      {title && (
        <div className="px-4 pt-3 pb-1 flex items-baseline justify-between">
          <span className="text-base font-semibold text-text">{title}</span>
          {typeof floatingPnl === 'number' && (
            <span className={clsx('num text-sm font-semibold', pnlColor)}>
              {pnlValue >= 0 ? '+' : ''}{pnlValue.toFixed(2)} USD
            </span>
          )}
        </div>
      )}

      <div className="px-4 py-3 flex flex-col gap-1.5">
        {rows.map(r => (
          <LeaderRow key={r.label} label={r.label} value={r.value} />
        ))}
      </div>
    </div>
  )
}

function LeaderRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-text font-medium whitespace-nowrap">{label}:</span>
      <span
        aria-hidden
        className="flex-1 border-b border-dotted border-dim/40 mb-1"
      />
      <span className="num font-semibold text-text whitespace-nowrap">{value}</span>
    </div>
  )
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
