'use client'
import { useEffect } from 'react'
import type { SymbolInfo } from '@/types'
import { displayNameOf } from '@/lib/symbols'

/**
 * SymbolPropertiesModal — MT5-style "Specification" view.
 *
 * Renders as a full-screen modal on mobile (no rounded corners, X in the
 * top-right) and as a centered card on desktop. **The parent must mount
 * this component only when there is something to show** — `open` toggles
 * the conditional render, so each open is a brand-new React instance and
 * each close fully unmounts it. This is intentional: it prevents the
 * "Properties stays open when the user switches symbols" bug that comes
 * from keeping the modal in a long-lived parent.
 *
 * Tap-outside / X / Esc all close. Backdrop is opaque on mobile so the
 * modal feels like its own screen (MT5 does the same).
 */

interface Props {
  open:    boolean
  onClose: () => void
  info:    SymbolInfo | null
}

export default function SymbolPropertiesModal({ open, onClose, info }: Props) {
  // ESC to close + body-scroll lock while mounted-and-open
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  // Hard early-return so the DOM is genuinely empty when not open.
  // (No exit animation here — Properties is informational, snappy is fine.)
  if (!open || !info) return null

  return (
    <div className="fixed inset-0 z-[210] flex md:items-center md:justify-center md:p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-surface md:bg-black/70" onClick={onClose} aria-hidden="true" />

      {/* Panel — full-screen on mobile, centered card on desktop */}
      <div
        className="relative w-full h-full md:h-auto md:max-w-md md:rounded-2xl bg-panel md:border md:border-border md:shadow-2xl flex flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Header — sticky on mobile because full-screen content scrolls */}
        <div className="safe-top shrink-0 border-b border-border bg-panel">
          <div className="flex items-center px-4 h-14 gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-9 h-9 -ml-2 flex items-center justify-center text-text hover:bg-surface rounded-lg"
            >
              ✕
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-text font-bold text-base leading-tight truncate">
                {displayNameOf(info)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-dim leading-tight">
                Specification
              </div>
            </div>
          </div>
        </div>

        {/* Spec rows */}
        <div className="flex-1 overflow-y-auto safe-bottom">
          <Section title="Identification">
            <Row label="Display name"  value={displayNameOf(info)} />
            <Row label="Symbol ID"     value={info.symbol} mono />
            <Row label="Class"         value={classLabel(info)} />
          </Section>

          <Section title="Contract">
            <Row label="Leverage"      value={`1 : ${info.leverage}`} />
            <Row label="Contract size" value={info.contract_size.toLocaleString()} />
            <Row label="Tick cadence"  value={`${info.cadence_ms} ms`} />
          </Section>

          {info.display_divisor !== 1 && (
            <Section title="Display">
              <Row
                label="Price divisor"
                value={info.display_divisor.toLocaleString()}
                hint="True engine price divided by this for display"
              />
            </Section>
          )}

          <Section title="Trading">
            <Row label="Fractional spot" value="Supported" />
            <Row label="CFD"             value="Supported" />
            <Row label="Binary options"  value="Supported" />
          </Section>

          {/* Footer note — same disclosure copy MT5 puts at the bottom of
              specifications, scoped to our reality. */}
          <p className="px-5 py-4 text-[11px] text-dim leading-relaxed">
            Prices stream from the engine in real time. Symbols marked
            <span className="text-text"> Synthetic</span> are generated
            internally; all others are tracked against live external feeds.
            All trading carries risk of loss.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-5 pt-4 pb-1 text-[10px] uppercase tracking-widest text-dim/80">
        {title}
      </div>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  )
}

function Row({ label, value, mono, hint }: {
  label: string; value: string; mono?: boolean; hint?: string
}) {
  return (
    <div className="px-5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dim text-sm">{label}</span>
        <span className={`text-text text-sm font-semibold text-right truncate ${mono ? 'num' : ''}`}>
          {value}
        </span>
      </div>
      {hint && <p className="text-[10px] text-dim/80 mt-0.5">{hint}</p>}
    </div>
  )
}

function classLabel(info: SymbolInfo): string {
  switch (info.type) {
    case 'BOOM_CRASH': return 'Synthetic'
    case 'FX':         return 'Forex'
    case 'CRYPTO':     return 'Crypto'
    case 'METAL':      return 'Metal'
    case 'INDEX':      return 'Index'
    default:           return info.type
  }
}
