'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { SymbolInfo, Tick } from '@/types'
import { displayNameOf, formatPrice } from '@/lib/symbols'

interface Props {
  symbols:  SymbolInfo[]
  ticks:    Record<string, Tick>
  selected: string
  onSelect: (s: string) => void
}

const TYPE_BADGE: Record<string, string> = {
  BOOM_CRASH: 'text-[#f5a623]',
  FX:         'text-up',
  CRYPTO:     'text-[#9b59b6]',
  METAL:      'text-[#d4af37]',
  INDEX:      'text-[#5dade2]',
}

export default function SymbolBar({ symbols, ticks, selected, onSelect }: Props) {
  return (
    <div className="flex overflow-x-auto border-b border-border bg-panel shrink-0 gap-0">
      {symbols.map(s => (
        <SymbolChip
          key={s.symbol}
          info={s}
          tick={ticks[s.symbol] ?? null}
          active={s.symbol === selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function SymbolChip({
  info, tick, active, onSelect,
}: {
  info: SymbolInfo; tick: Tick | null; active: boolean; onSelect: (s: string) => void
}) {
  const prevMid = useRef<number | null>(null)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (!tick) return
    if (prevMid.current !== null) {
      setFlash(tick.mid > prevMid.current ? 'up' : 'down')
      const t = setTimeout(() => setFlash(null), 300)
      return () => clearTimeout(t)
    }
    prevMid.current = tick.mid
  }, [tick?.ts_ms]) // eslint-disable-line

  return (
    <button
      onClick={() => onSelect(info.symbol)}
      className={clsx(
        'flex flex-col px-4 py-2 border-r border-border min-w-[130px] text-left transition-colors',
        active ? 'bg-surface border-b-2 border-b-brand' : 'hover:bg-surface/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-text truncate">{displayNameOf(info)}</span>
        <span className={clsx('text-[9px] uppercase', TYPE_BADGE[info.type] ?? 'text-dim')}>
          {info.type === 'BOOM_CRASH' ? 'B/C' : info.type}
        </span>
      </div>
      <span
        className={clsx(
          'num text-sm font-semibold mt-0.5',
          flash === 'up'   ? 'flash-up   text-up'   :
          flash === 'down' ? 'flash-down text-down' : 'text-text',
        )}
      >
        {formatPrice(info, tick?.mid)}
      </span>
      {tick && (
        <div className="flex gap-1 text-[10px] text-dim mt-0.5 num">
          <span className="text-down">{formatPrice(info, tick.bid)}</span>
          <span>/</span>
          <span className="text-up">{formatPrice(info, tick.ask)}</span>
        </div>
      )}
    </button>
  )
}
