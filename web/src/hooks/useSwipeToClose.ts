'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * useSwipeToClose — swipe-left gesture on a row element.
 *
 * Tracks horizontal drag. Two outcomes on touchend:
 *   - Drag distance ≥ `closeThreshold` → fire onClose() and snap back.
 *   - Drag distance < `closeThreshold` → snap row back to its rest position.
 *
 * Returns the current x-offset to apply as `transform: translateX(...)` on
 * the row content, plus a flag indicating whether the close-confirm icon
 * should be visible at the right edge.
 *
 * Vertical scroll friendliness: if the first 10px of the gesture is more
 * vertical than horizontal, we abandon the swipe and let scroll proceed.
 * Listeners are passive (no preventDefault) so the touchmove never blocks
 * the compositor or fights iOS bounce.
 */
export function useSwipeToClose(
  rowRef: RefObject<HTMLElement | null>,
  onClose: () => void | Promise<void>,
  opts: { closeThreshold?: number; maxDrag?: number } = {},
) {
  const closeThreshold = opts.closeThreshold ?? 100
  const maxDrag        = opts.maxDrag        ?? 140

  const [offset, setOffset] = useState(0)
  const [armed, setArmed]   = useState(false)

  const startX     = useRef<number | null>(null)
  const startY     = useRef<number | null>(null)
  const direction  = useRef<'none' | 'horizontal' | 'vertical'>('none')
  const offsetRef  = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const el = rowRef.current
    if (!el) return

    const setBoth = (v: number) => { offsetRef.current = v; setOffset(v) }

    const onTouchStart = (e: TouchEvent) => {
      startX.current = e.touches[0].clientX
      startY.current = e.touches[0].clientY
      direction.current = 'none'
    }

    const onTouchMove = (e: TouchEvent) => {
      if (startX.current === null || startY.current === null) return
      const dx = e.touches[0].clientX - startX.current
      const dy = e.touches[0].clientY - startY.current

      // First-frame heuristic: decide once whether this is horizontal or
      // vertical. We need 10px of movement before we lock direction so
      // tiny finger jitter doesn't accidentally activate the swipe.
      if (direction.current === 'none') {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        direction.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      }
      if (direction.current === 'vertical') return // let the page scroll

      // Only left-swipes engage the close gesture. Right-swipe = drag back to 0.
      if (dx >= 0) {
        setBoth(Math.min(0, offsetRef.current))
        setArmed(false)
        return
      }
      const clamped = Math.max(dx, -maxDrag)
      setBoth(clamped)
      setArmed(Math.abs(clamped) >= closeThreshold)
    }

    const onTouchEnd = () => {
      if (offsetRef.current <= -closeThreshold) {
        // Animate row off-screen then fire close
        setBoth(-maxDrag)
        setArmed(false)
        // Small delay so the user perceives the row "leaving" before state changes
        setTimeout(() => {
          onCloseRef.current()
          setBoth(0)
        }, 140)
      } else {
        setBoth(0)
        setArmed(false)
      }
      startX.current = null
      startY.current = null
      direction.current = 'none'
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
  }, [rowRef, closeThreshold, maxDrag])

  return { offset, armed, closeThreshold }
}
