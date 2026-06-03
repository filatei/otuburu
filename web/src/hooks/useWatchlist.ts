'use client'

/**
 * useWatchlist — reactive wrapper around the localStorage-backed watchlist.
 *
 * Returns the current id set + helpers to add/remove/toggle. All mutations
 * persist immediately so a hard refresh keeps the user's choice.
 *
 * Why a Set in state: O(1) membership checks for the ManageSymbolsSheet's
 * toggle list and per-row "is this in the watchlist?" filtering. The on-
 * disk format stays an ordered array so the UI can preserve insertion
 * order (most-recently-added first, MT5-style).
 */

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_WATCHLIST, getWatchlist, setWatchlist } from '@/lib/watchlist'

export function useWatchlist() {
  // Initial state: defaults during SSR (window is undefined). The effect
  // below hydrates with the real localStorage value on mount so the user
  // never sees the wrong list flash on first paint.
  const [ids, setIds] = useState<string[]>(() => [...DEFAULT_WATCHLIST])

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    setIds(getWatchlist())
  }, [])

  // Set used for O(1) membership probes in the rest of the UI.
  const idSet = new Set(ids)

  const persist = useCallback((next: string[]) => {
    setIds(next)
    setWatchlist(next)
  }, [])

  const add = useCallback((symbol: string) => {
    if (idSet.has(symbol)) return
    persist([...ids, symbol])
    // Update closure-captured set so multiple rapid adds in one render
    // don't all see the stale "not present" check.
    idSet.add(symbol)
  }, [ids, idSet, persist])

  const remove = useCallback((symbol: string) => {
    if (!idSet.has(symbol)) return
    persist(ids.filter(id => id !== symbol))
    idSet.delete(symbol)
  }, [ids, idSet, persist])

  const toggle = useCallback((symbol: string) => {
    if (idSet.has(symbol)) {
      persist(ids.filter(id => id !== symbol))
    } else {
      persist([...ids, symbol])
    }
  }, [ids, idSet, persist])

  return { ids, idSet, add, remove, toggle }
}
