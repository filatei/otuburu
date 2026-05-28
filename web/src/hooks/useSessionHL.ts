'use client'
import { useEffect, useRef, useState } from 'react'
import type { Tick } from '@/types'

/**
 * useSessionHL — tracks high/low mid price per symbol over the current UTC day.
 *
 * Observes the live ticks map and folds new bid/ask values into a running
 * high/low per symbol. Resets at the next UTC midnight, mirroring how MT5
 * and most retail platforms define the "session" for FX, metals and crypto
 * (24/7 markets). For equity/index symbols that have proper sessions this
 * is an approximation — fine for a Quotes row hint, not for analytics.
 *
 * Returns a stable object reference keyed by symbol → { high, low }. The
 * hook itself triggers a React update only when a new high or low is set,
 * so plain tick churn (mid moves inside the existing range) doesn't cost
 * a re-render in consumers that read off the returned map.
 */

export type SessionRange = { high: number; low: number }

export function useSessionHL(ticks: Record<string, Tick>): Record<string, SessionRange> {
  // The map is held in a ref to avoid re-rendering on every tick — only
  // mutations that actually extend the range trigger setVersion(), which
  // produces a new object reference for consumers to re-render against.
  const mapRef = useRef<Record<string, SessionRange>>({})
  const [, setVersion] = useState(0)

  // Reset at UTC midnight. We schedule one timeout for the next boundary
  // and reschedule on fire. Simpler than a setInterval that races with
  // clock drift on suspended laptops.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleReset = () => {
      const now = new Date()
      const next = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
      ))
      timer = setTimeout(() => {
        mapRef.current = {}
        setVersion(v => v + 1)
        scheduleReset()
      }, Math.max(1000, next.getTime() - now.getTime()))
    }
    scheduleReset()
    return () => { if (timer) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    let changed = false
    for (const [sym, tick] of Object.entries(ticks)) {
      if (!tick) continue
      const mid = tick.mid
      if (!Number.isFinite(mid) || mid <= 0) continue
      const cur = mapRef.current[sym]
      if (!cur) {
        mapRef.current[sym] = { high: mid, low: mid }
        changed = true
        continue
      }
      if (mid > cur.high) { cur.high = mid; changed = true }
      if (mid < cur.low ) { cur.low  = mid; changed = true }
    }
    if (changed) {
      // Bump a version counter to produce a new object reference on next
      // render. The actual map identity is preserved across hooks so the
      // consumer doesn't have to memoize on every read.
      setVersion(v => v + 1)
    }
    // Re-run when the ticks object identity changes — useTicks delivers a
    // new object per WebSocket frame, so this fires on every push.
  }, [ticks])

  return mapRef.current
}
