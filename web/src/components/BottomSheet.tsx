'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

/**
 * BottomSheet — slide-up sheet on mobile, centered modal on desktop.
 *
 *   <BottomSheet open={open} onClose={close} title="Deposit Funds">
 *     ...form...
 *   </BottomSheet>
 *
 * Behaviour
 * ─────────
 *  - Mobile (<md): slides up from the bottom, drag-handle on top, swipe-down
 *    past 80px to dismiss, tap backdrop to dismiss, scroll inside if content
 *    overflows. Bottom padding respects iOS home-indicator safe area.
 *  - Desktop (md+): renders as a centered card with the same visual chrome,
 *    so neither audience gets a degraded version. The drag handle is hidden.
 *  - Lock body scroll while open; ESC closes; backdrop click closes.
 *  - Mounted in a portal-style fixed overlay (no portal lib — just `fixed
 *    inset-0`) so it sits above the app shell regardless of where it's used.
 *
 * Animation
 * ─────────
 *  - Enter: backdrop fades in; sheet transitions translateY(100%)→0 over
 *    260ms. Tracked via a small `mounted`/`visible` state machine so the
 *    initial render starts at the off-screen position before the transition
 *    flips on.
 *  - Drag: while the finger is on the sheet, translateY follows directly
 *    (no transition). On release past threshold we set translateY(100%)
 *    and let the transition carry it off-screen before firing onClose.
 */

interface Props {
  open:     boolean
  onClose:  () => void
  /** Optional sheet title — rendered in a sticky header with a close button. */
  title?:   string
  /** Max-height as a viewport % on mobile. Default 92 (leaves a peek of the
   *  app shell so users keep their orientation). */
  maxVh?:   number
  children: React.ReactNode
}

const DRAG_DISMISS_PX = 80      // distance past which release dismisses
const ENTER_MS        = 260      // open/close animation duration
const DRAG_MAX        = 600      // hard cap so transform never overshoots

export default function BottomSheet({ open, onClose, title, maxVh = 92, children }: Props) {
  // Two-state mount: `mounted` keeps the DOM around long enough for the exit
  // animation; `visible` flips translateY between 100% (hidden) and 0 (shown).
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)
  const [drag,    setDrag]    = useState(0)
  const startY    = useRef<number | null>(null)
  const dragRef   = useRef(0)

  // Open/close transitions
  useEffect(() => {
    if (open) {
      setMounted(true)
      // requestAnimationFrame so the initial translateY(100%) lands before
      // we flip visible→true, otherwise React batches the change and the
      // browser sees the sheet at translateY(0) from the start (no slide).
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    } else {
      setVisible(false)
      const t = setTimeout(() => { setMounted(false); setDrag(0); dragRef.current = 0 }, ENTER_MS)
      return () => clearTimeout(t)
    }
  }, [open])

  // ESC + body-scroll-lock while sheet is open
  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [mounted, onClose])

  if (!mounted) return null

  // ─── Drag handlers (mobile only — drag-handle is hidden on md+) ──────
  const onTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null) return
    const dy = e.touches[0].clientY - startY.current
    if (dy <= 0) {
      dragRef.current = 0
      setDrag(0)
      return
    }
    const clamped = Math.min(dy, DRAG_MAX)
    dragRef.current = clamped
    setDrag(clamped)
  }
  const onTouchEnd = () => {
    if (startY.current === null) return
    startY.current = null
    if (dragRef.current >= DRAG_DISMISS_PX) {
      // Sheet has been dragged far enough — commit close. Reset drag so
      // the closing animation runs from translateY(100%), not from drag+%.
      dragRef.current = 0
      setDrag(0)
      onClose()
    } else {
      dragRef.current = 0
      setDrag(0)
    }
  }

  // Compose the sheet transform — combination of the open-state translation
  // (100% off-screen or 0 on-screen) and any in-progress drag.
  const dragging = drag > 0
  const sheetStyle: React.CSSProperties = {
    transform: visible
      ? `translateY(${drag}px)`
      : 'translateY(100%)',
    transition: dragging ? 'none' : `transform ${ENTER_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
    maxHeight: `${maxVh}vh`,
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center md:p-4">
      {/* Backdrop */}
      <div
        className={clsx(
          'absolute inset-0 bg-black/70 transition-opacity',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        style={{ transitionDuration: `${ENTER_MS}ms` }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel
          Mobile: full-width, bottom-anchored, rounded top corners only
          Desktop: centered card, rounded on all corners, max-w-sm */}
      <div
        className={clsx(
          'relative w-full md:max-w-sm bg-panel border border-border shadow-2xl overflow-hidden',
          'rounded-t-2xl md:rounded-2xl',
          'flex flex-col',
        )}
        style={sheetStyle}
        role="dialog"
        aria-modal="true"
      >
        {/* Drag handle — mobile only. Touch listeners live here so the user
            grabs the handle (or header) to drag, not the form fields below. */}
        <div
          className="md:hidden shrink-0 flex flex-col items-center pt-2 pb-1 cursor-grab active:cursor-grabbing"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Header — shown when title is provided. Also draggable. */}
        {title && (
          <div
            className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0 md:cursor-default"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
          >
            <h2 className="text-text font-bold text-base">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 flex items-center justify-center text-dim hover:text-text rounded-lg hover:bg-surface transition-colors"
            >
              ✕
            </button>
          </div>
        )}

        {/* Scrollable content area. safe-bottom adds iOS home-indicator
            padding so the last form field never hides under the bar. */}
        <div className="flex-1 overflow-y-auto safe-bottom">
          {children}
        </div>
      </div>
    </div>
  )
}
