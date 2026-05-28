'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * usePullToRefresh — touch-events-based pull-to-refresh.
 *
 * Attaches passive touch listeners to a scrollable element. When the user
 * pulls down past `threshold` pixels at scrollTop === 0, fires onRefresh
 * (which can be async). While the gesture is active, returns the current
 * pull distance for visual feedback (a spinner that slides into view).
 *
 * No library dependencies. Mobile Safari + Android Chrome friendly:
 *  - All listeners are passive, so the touchmove never blocks the main
 *    thread or scroll compositor.
 *  - Direction is checked in JS (delta > 0) rather than via preventDefault,
 *    so vertical scroll keeps working when the user isn't at the top.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null)
 *   const { pull, refreshing, threshold } = usePullToRefresh(ref, refresh)
 *   <div ref={ref} className="overflow-y-auto">
 *     <PullIndicator pull={pull} refreshing={refreshing} threshold={threshold} />
 *     ...
 *   </div>
 */
export function usePullToRefresh(
  containerRef: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void,
  opts: { threshold?: number; max?: number; damping?: number } = {},
) {
  const threshold = opts.threshold ?? 80
  const max       = opts.max       ?? 120
  const damping   = opts.damping   ?? 0.5

  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Use refs for values consumed by event handlers so we don't have to
  // re-register listeners on every state change.
  const pullRef       = useRef(0)
  const refreshingRef = useRef(false)
  const startY        = useRef<number | null>(null)
  const onRefreshRef  = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const setPullBoth = (v: number) => { pullRef.current = v; setPull(v) }
    const setRefreshingBoth = (v: boolean) => { refreshingRef.current = v; setRefreshing(v) }

    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop > 0 || refreshingRef.current) return
      startY.current = e.touches[0].clientY
    }

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current === null) return
      const dy = e.touches[0].clientY - startY.current
      if (dy <= 0) {
        // user pushed up — abort gesture, let scroll resume normally
        startY.current = null
        setPullBoth(0)
        return
      }
      setPullBoth(Math.min(dy * damping, max))
    }

    const onTouchEnd = async () => {
      if (startY.current === null) return
      startY.current = null
      if (pullRef.current >= threshold) {
        setRefreshingBoth(true)
        try {
          await onRefreshRef.current()
        } catch {
          /* swallow — caller is responsible for surfacing failures */
        } finally {
          setRefreshingBoth(false)
          setPullBoth(0)
        }
      } else {
        setPullBoth(0)
      }
    }

    el.addEventListener('touchstart',  onTouchStart, { passive: true })
    el.addEventListener('touchmove',   onTouchMove,  { passive: true })
    el.addEventListener('touchend',    onTouchEnd,   { passive: true })
    el.addEventListener('touchcancel', onTouchEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart',  onTouchStart)
      el.removeEventListener('touchmove',   onTouchMove)
      el.removeEventListener('touchend',    onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [containerRef, threshold, max, damping])

  return { pull, refreshing, threshold }
}

/** Visual indicator that grows with the pull distance. Mount as the FIRST
 *  child of the scrollable container, *before* the list content. */
export function PullIndicator({ pull, refreshing, threshold }: {
  pull: number; refreshing: boolean; threshold: number
}) {
  const visible = pull > 0 || refreshing
  if (!visible) return null
  const progress = Math.min(1, pull / threshold)
  return (
    <div
      className="flex items-center justify-center"
      style={{
        height: refreshing ? 44 : Math.min(pull, threshold + 20),
        transition: refreshing ? 'height 200ms ease' : 'none',
      }}
    >
      <span
        className="inline-block text-xs text-dim flex items-center gap-2"
        style={{
          opacity: refreshing ? 1 : progress,
          transform: `rotate(${refreshing ? 0 : progress * 180}deg)`,
          transition: refreshing ? 'transform 300ms linear' : 'none',
        }}
      >
        {refreshing ? (
          <span className="inline-block animate-spin">↻</span>
        ) : (
          <span>↓</span>
        )}
      </span>
    </div>
  )
}
