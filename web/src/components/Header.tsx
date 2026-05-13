'use client'
import type { AccountState } from '@/types'

interface Props {
  account:   AccountState | null
  connected: boolean
}

export default function Header({ account, connected }: Props) {
  return (
    <header className="h-12 bg-panel border-b border-border flex items-center px-4 gap-4 shrink-0 z-10">
      {/* Logo */}
      <div className="flex items-center gap-2 mr-4">
        <span className="text-brand font-bold text-lg tracking-tight">OTUBURU</span>
        <span className="text-dim text-xs uppercase tracking-widest">Synthetic</span>
      </div>

      {/* Connection badge */}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-up' : 'bg-down'} transition-colors`} />
        <span className="text-dim text-xs">{connected ? 'Live' : 'Reconnecting…'}</span>
      </div>

      <div className="flex-1" />

      {/* Account stats */}
      {account && (
        <div className="flex items-center gap-6">
          <Stat label="Balance"  value={fmt(account.balance)}   />
          <Stat label="Equity"   value={fmt(account.equity)}    color={account.equity >= account.balance ? 'text-up' : 'text-down'} />
          <Stat label="Margin"   value={fmt(account.used_margin)} />
          <Stat label="Free"     value={fmt(account.free_margin)} color="text-up" />
        </div>
      )}

      <div className="ml-4 px-3 py-1 rounded bg-brand/10 border border-brand/30 text-brand text-xs font-semibold">
        DEMO
      </div>
    </header>
  )
}

function Stat({ label, value, color = 'text-text' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-dim text-[10px] uppercase tracking-wider">{label}</span>
      <span className={`num text-sm font-semibold ${color}`}>{value}</span>
    </div>
  )
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
