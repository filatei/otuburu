'use client'
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { Position, BinaryOption, SpotPosition, Tick, SettledTrade, SymbolInfo } from '@/types'
import { closePosition, closeSpot } from '@/hooks/useAccount'
import { buildSymbolMap, displayNameOf, formatPrice, toDisplayUnits } from '@/lib/symbols'

interface Props {
  positions:      Position[]
  binaries:       BinaryOption[]
  spots:          SpotPosition[]
  settledHistory: SettledTrade[]
  ticks:          Record<string, Tick>
  symbols:        SymbolInfo[]
  accountId:      string
  onRefresh:      () => void
  mobile?:        boolean
}

/** MT5 desktop also uses just Trade + History — Open/Recent was a redundant
 *  earlier shape. Recent was always a window into History. */
type Tab = 'trade' | 'history'

export default function Positions({
  positions, binaries, spots, settledHistory, ticks, symbols, accountId, onRefresh, mobile,
}: Props) {
  const [tab, setTab] = useState<Tab>('trade')

  const symbolMap = useMemo(() => buildSymbolMap(symbols), [symbols])
  const openCount = positions.length + binaries.length + spots.length
  const winCount  = settledHistory.filter(t => t.outcome === 'win').length
  // Net P&L: payout received minus stake paid. Win = payout − stake; Loss = −stake.
  const netPnl       = (t: { outcome: string; pnl: number; stake: number }) =>
    t.outcome === 'win' ? t.pnl - t.stake : -t.stake
  const totalPnl     = settledHistory.reduce((sum, t) => sum + netPnl(t), 0)

  return (
    <div
      className={`border-t border-border bg-panel ${mobile ? 'min-h-full' : 'shrink-0'}`}
      style={mobile ? undefined : { height: '210px' }}
    >
      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center h-8 border-b border-border px-2 gap-1">
        <TabBtn label="Trade"   count={openCount}             active={tab === 'trade'}   onClick={() => setTab('trade')} />
        <TabBtn label="History" count={settledHistory.length} active={tab === 'history'} onClick={() => setTab('history')} />

        {settledHistory.length > 0 && (
          <div className="ml-auto flex items-center gap-3 text-[10px] text-dim pr-2">
            <span>{winCount}W&nbsp;/&nbsp;{settledHistory.length - winCount}L</span>
            <span className={clsx('font-semibold num', totalPnl >= 0 ? 'text-up' : 'text-down')}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className={mobile ? 'overflow-y-auto' : 'overflow-y-auto'} style={mobile ? undefined : { height: '170px' }}>

        {/* TRADE ─────────────────────────────────────────────────────────────── */}
        {tab === 'trade' && (
          <>
            {openCount === 0 && (
              <div className="flex items-center justify-center py-8 text-dim text-sm">No open trades</div>
            )}

            {positions.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-dim border-b border-border">
                    {['Symbol','Side','Lots','Entry','Current','P&L',''].map(h => (
                      <th key={h} className="px-3 py-1 text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => {
                    const info    = symbolMap.get(p.symbol) ?? null
                    const tick    = ticks[p.symbol]
                    const current = tick ? (p.side === 'BUY' ? tick.bid : tick.ask) : p.entry
                    const pnl     = p.unrealised_pnl
                    return (
                      <tr key={p.id} className="border-b border-border/50 hover:bg-surface/50">
                        <td className="px-3 py-1.5 font-semibold">{displayNameOf(info, p.symbol)}</td>
                        <td className={clsx('px-3 py-1.5 font-semibold', p.side === 'BUY' ? 'text-up' : 'text-down')}>{p.side}</td>
                        <td className="px-3 py-1.5 num">{p.lots.toFixed(2)}</td>
                        <td className="px-3 py-1.5 num">{formatPrice(info, p.entry, 5)}</td>
                        <td className="px-3 py-1.5 num">{formatPrice(info, current, 5)}</td>
                        <td className={clsx('px-3 py-1.5 num font-semibold', pnl >= 0 ? 'text-up' : 'text-down')}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            onClick={async () => { await closePosition(accountId, p.id); onRefresh() }}
                            className="px-2 py-0.5 text-[10px] rounded border border-down/30 text-down hover:bg-down/10"
                          >Close</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {binaries.length > 0 && (
              <table className="w-full text-xs mt-1">
                <thead>
                  <tr className="text-dim border-b border-border">
                    {['Symbol','Dir','Stake','Entry','Ticks',''].map(h => (
                      <th key={h} className="px-3 py-1 text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {binaries.map(b => {
                    const info = symbolMap.get(b.symbol) ?? null
                    return (
                    <tr key={b.id} className="border-b border-border/50 hover:bg-surface/50">
                      <td className="px-3 py-1.5 font-semibold">{displayNameOf(info, b.symbol)}</td>
                      <td className={clsx('px-3 py-1.5 font-semibold', b.direction === 'UP' ? 'text-up' : 'text-down')}>
                        {b.direction === 'UP' ? '▲ Rise' : '▼ Fall'}
                      </td>
                      <td className="px-3 py-1.5 num">${b.stake.toFixed(2)}</td>
                      <td className="px-3 py-1.5 num">{formatPrice(info, b.entry_mid, 5)}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-muted rounded-full h-1">
                            <div
                              className="bg-up h-1 rounded-full transition-all"
                              style={{ width: `${(b.ticks_left / b.ticks_total) * 100}%` }}
                            />
                          </div>
                          <span className="num">{b.ticks_left}/{b.ticks_total}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-dim text-[10px]">Settling…</td>
                    </tr>
                  )})}
                </tbody>
              </table>
            )}

            {spots.length > 0 && (
              <table className="w-full text-xs mt-1">
                <thead>
                  <tr className="text-dim border-b border-border">
                    {['Symbol','Side','Stake','Units','Entry','P&L',''].map(h => (
                      <th key={h} className="px-3 py-1 text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {spots.map(s => {
                    const info  = symbolMap.get(s.symbol) ?? null
                    const pnl   = s.unrealised_pnl
                    const units = toDisplayUnits(info, s.units)
                    return (
                      <tr key={s.id} className="border-b border-border/50 hover:bg-surface/50">
                        <td className="px-3 py-1.5 font-semibold">{displayNameOf(info, s.symbol)}</td>
                        <td className={clsx('px-3 py-1.5 font-semibold', s.side === 'BUY' ? 'text-up' : 'text-down')}>{s.side}</td>
                        <td className="px-3 py-1.5 num">${s.stake.toFixed(2)}</td>
                        <td className="px-3 py-1.5 num">{units.toFixed(4)}</td>
                        <td className="px-3 py-1.5 num">{formatPrice(info, s.entry, 2)}</td>
                        <td className={clsx('px-3 py-1.5 num font-semibold', pnl >= 0 ? 'text-up' : 'text-down')}>
                          {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5">
                          <button
                            onClick={async () => { await closeSpot(accountId, s.id); onRefresh() }}
                            className="px-2 py-0.5 text-[10px] rounded border border-down/30 text-down hover:bg-down/10"
                          >Close</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* HISTORY ────────────────────────────────────────────────────────────── */}
        {tab === 'history' && (
          settledHistory.length === 0
            ? <div className="flex items-center justify-center py-8 text-dim text-sm">No trade history yet</div>
            : <HistoryTable trades={settledHistory} symbolMap={symbolMap} />
        )}
      </div>
    </div>
  )
}

// ─── History table (shared by Recent + History tabs) ─────────────────────────
function HistoryTable({ trades, symbolMap }: {
  trades: SettledTrade[]
  symbolMap: Map<string, SymbolInfo>
}) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-dim border-b border-border">
          {['Symbol','Dir','Stake','Entry','Ticks','Result','P&L','Time'].map(h => (
            <th key={h} className="px-3 py-1 text-left font-normal">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trades.map(t => <SettledRow key={t.id} trade={t} info={symbolMap.get(t.symbol) ?? null} />)}
      </tbody>
    </table>
  )
}

function SettledRow({ trade: t, info }: { trade: SettledTrade; info: SymbolInfo | null }) {
  // Net P&L: what the user actually gained or lost on this trade.
  // Win:  payout_received − stake_paid  (e.g. $18.50 − $10 = +$8.50)
  // Loss: −stake_paid                   (e.g. −$10.00)
  const net = t.outcome === 'win' ? t.pnl - t.stake : -t.stake

  return (
    <tr className="border-b border-border/50 hover:bg-surface/50">
      <td className="px-3 py-1.5 font-semibold">{displayNameOf(info, t.symbol)}</td>
      <td className={clsx('px-3 py-1.5 font-semibold', t.direction === 'UP' ? 'text-up' : 'text-down')}>
        {t.direction === 'UP' ? '▲ Rise' : '▼ Fall'}
      </td>
      <td className="px-3 py-1.5 num">${t.stake.toFixed(2)}</td>
      <td className="px-3 py-1.5 num">{formatPrice(info, t.entry_mid, 5)}</td>
      <td className="px-3 py-1.5 num">{t.ticks_total}</td>
      <td className="px-3 py-1.5">
        <span className={clsx(
          'px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide',
          t.outcome === 'win' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
        )}>
          {t.outcome === 'win' ? 'WON' : 'LOST'}
        </span>
      </td>
      <td className={clsx('px-3 py-1.5 num font-semibold', net >= 0 ? 'text-up' : 'text-down')}>
        {net >= 0 ? '+' : ''}{net.toFixed(2)}
      </td>
      <td className="px-3 py-1.5 text-dim text-[10px] whitespace-nowrap">{formatAgo(t.settled_at)}</td>
    </tr>
  )
}

// ─── Tab button ───────────────────────────────────────────────────────────────
function TabBtn({ label, count, active, onClick }: {
  label: string; count?: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1 px-2.5 h-full text-[11px] font-medium border-b-2 transition-colors',
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

function formatAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000)    return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}
