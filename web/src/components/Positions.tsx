'use client'
import clsx from 'clsx'
import type { Position, BinaryOption, Tick } from '@/types'
import { closePosition } from '@/hooks/useAccount'

interface Props {
  positions: Position[]
  binaries:  BinaryOption[]
  ticks:     Record<string, Tick>
  accountId: string
  onRefresh: () => void
}

export default function Positions({ positions, binaries, ticks, accountId, onRefresh }: Props) {
  const hasData = positions.length > 0 || binaries.length > 0

  return (
    <div className="border-t border-border bg-panel shrink-0" style={{ height: '180px' }}>
      <div className="flex items-center h-8 px-4 border-b border-border gap-4">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">Open Positions</span>
        <span className="text-[10px] bg-surface px-1.5 rounded text-dim">
          {positions.length} CFD · {binaries.length} Binary
        </span>
      </div>

      <div className="overflow-y-auto h-[148px]">
        {!hasData && (
          <div className="flex items-center justify-center h-full text-dim text-sm">
            No open trades
          </div>
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
                const tick    = ticks[p.symbol]
                const current = tick ? (p.side === 'BUY' ? tick.bid : tick.ask) : p.entry
                const pnl     = p.unrealised_pnl
                return (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-surface/50">
                    <td className="px-3 py-1.5 font-semibold">{p.symbol}</td>
                    <td className={clsx('px-3 py-1.5 font-semibold', p.side === 'BUY' ? 'text-up' : 'text-down')}>
                      {p.side}
                    </td>
                    <td className="px-3 py-1.5 num">{p.lots.toFixed(2)}</td>
                    <td className="px-3 py-1.5 num">{p.entry.toFixed(5)}</td>
                    <td className="px-3 py-1.5 num">{current.toFixed(5)}</td>
                    <td className={clsx('px-3 py-1.5 num font-semibold', pnl >= 0 ? 'text-up' : 'text-down')}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        onClick={async () => { await closePosition(accountId, p.id); onRefresh() }}
                        className="px-2 py-0.5 text-[10px] rounded border border-down/30 text-down hover:bg-down/10"
                      >
                        Close
                      </button>
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
                {['Symbol','Dir','Stake','Entry','Ticks left',''].map(h => (
                  <th key={h} className="px-3 py-1 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {binaries.map(b => (
                <tr key={b.id} className="border-b border-border/50 hover:bg-surface/50">
                  <td className="px-3 py-1.5 font-semibold">{b.symbol}</td>
                  <td className={clsx('px-3 py-1.5 font-semibold', b.direction === 'UP' ? 'text-up' : 'text-down')}>
                    {b.direction === 'UP' ? '▲ Rise' : '▼ Fall'}
                  </td>
                  <td className="px-3 py-1.5 num">${b.stake.toFixed(2)}</td>
                  <td className="px-3 py-1.5 num">{b.entry_mid.toFixed(5)}</td>
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
                  <td className="px-3 py-1.5 text-dim text-[10px]">Auto-settles</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
