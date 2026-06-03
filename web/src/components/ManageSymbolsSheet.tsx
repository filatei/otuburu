'use client'

/**
 * ManageSymbolsSheet — bottom sheet that lists every engine-supported
 * symbol and lets the user toggle each into/out of their watchlist.
 *
 * Opened from MobileSymbolsTab's "+ Add" header button. Rows in the
 * watchlist render with a filled ✓ chip; others render with an empty +
 * affordance. Tapping anywhere on a row flips the membership, persisted
 * immediately via useWatchlist.
 *
 * Grouped by instrument type so users find what they want without
 * scrolling past unrelated asset classes: Metals, Crypto, Indices,
 * Synthetics, FX. The group header doubles as a quick visual scan.
 */

import { useMemo } from 'react'
import type { SymbolInfo } from '@/types'
import { displayNameOf } from '@/lib/symbols'
import { useWatchlist } from '@/hooks/useWatchlist'
import BottomSheet from './BottomSheet'

interface Props {
  open:    boolean
  onClose: () => void
  /** Full set of symbols the engine exposes — not yet filtered. The sheet
   *  shows everything; the watchlist is what's filtered downstream. */
  symbols: SymbolInfo[]
}

/** Group ordering. Asset classes most-traded by retail come first so the
 *  user lands on what they want without scrolling. */
const GROUP_ORDER = ['METAL', 'CRYPTO', 'INDEX', 'BOOM_CRASH', 'FX'] as const
const GROUP_LABEL: Record<string, string> = {
  METAL:      'Metals',
  CRYPTO:     'Crypto',
  INDEX:      'Indices',
  BOOM_CRASH: 'Synthetic',
  FX:         'Forex',
}

export default function ManageSymbolsSheet({ open, onClose, symbols }: Props) {
  const { idSet, toggle } = useWatchlist()

  // Group symbols by their engine type. Stable order within each group
  // matches the alpha order the rest of the UI uses (orderSymbols in
  // page.tsx) — local sort keeps this self-contained.
  const grouped = useMemo(() => {
    const byGroup: Record<string, SymbolInfo[]> = {}
    for (const s of symbols) {
      const g = s.type ?? 'FX'
      ;(byGroup[g] ??= []).push(s)
    }
    for (const list of Object.values(byGroup)) {
      list.sort((a, b) => (a.display_symbol ?? a.symbol).localeCompare(b.display_symbol ?? b.symbol))
    }
    return byGroup
  }, [symbols])

  return (
    <BottomSheet open={open} onClose={onClose} title="Manage symbols">
      <div className="pb-4">
        <p className="px-4 py-3 text-[11px] text-dim leading-relaxed border-b border-border">
          Tap a symbol to add it to your watchlist. Tap again to remove.
          Your selection is saved on this device.
        </p>

        {GROUP_ORDER.map(group => {
          const list = grouped[group]
          if (!list || list.length === 0) return null
          return (
            <section key={group} className="border-b border-border last:border-b-0">
              <h3 className="px-4 py-2 text-[10px] uppercase tracking-widest text-dim bg-surface/40">
                {GROUP_LABEL[group] ?? group}
              </h3>
              <ul className="divide-y divide-border">
                {list.map(s => {
                  const inList = idSet.has(s.symbol)
                  return (
                    <li key={s.symbol}>
                      <button
                        type="button"
                        onClick={() => toggle(s.symbol)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-surface/60 hover:bg-surface/40"
                      >
                        <span
                          className={[
                            'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 border',
                            inList
                              ? 'bg-brand text-black border-brand'
                              : 'bg-transparent text-dim border-border',
                          ].join(' ')}
                        >
                          {inList ? '✓' : '+'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-text text-sm font-semibold truncate">
                            {s.display_symbol ?? s.symbol}
                          </p>
                          <p className="text-dim text-[11px] truncate">
                            {displayNameOf(s, s.symbol)}
                          </p>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </BottomSheet>
  )
}
