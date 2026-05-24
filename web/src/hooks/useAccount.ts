'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { AccountState, Position, BinaryOption, SettledTrade } from '@/types'

const API_BASE    = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const HISTORY_KEY = 'otuburu_trade_history'
const MAX_HISTORY = 200   // keep last 200 settled trades per account

// ─── Persist helpers ──────────────────────────────────────────────────────────
function loadHistory(accountId: string): SettledTrade[] {
  try {
    const raw = localStorage.getItem(`${HISTORY_KEY}:${accountId}`)
    return raw ? (JSON.parse(raw) as SettledTrade[]) : []
  } catch { return [] }
}

function saveHistory(accountId: string, history: SettledTrade[]) {
  try {
    localStorage.setItem(
      `${HISTORY_KEY}:${accountId}`,
      JSON.stringify(history.slice(0, MAX_HISTORY)),
    )
  } catch { /* storage full — ignore */ }
}

// ─── Public interface ─────────────────────────────────────────────────────────
export interface GameState {
  account:        AccountState | null
  positions:      Position[]
  binaries:       BinaryOption[]
  settledHistory: SettledTrade[]
  loading:        boolean
  refresh:        () => void
}

export function useAccount(accountId: string): GameState {
  const [account,        setAccount]        = useState<AccountState | null>(null)
  const [positions,      setPositions]      = useState<Position[]>([])
  const [binaries,       setBinaries]       = useState<BinaryOption[]>([])
  const [settledHistory, setSettledHistory] = useState<SettledTrade[]>([])
  const [loading,        setLoading]        = useState(true)

  // Refs — track previous state between polls without triggering re-renders
  const prevBinariesRef = useRef<Map<string, BinaryOption>>(new Map())
  const prevBalanceRef  = useRef<number | null>(null)
  const historyRef      = useRef<SettledTrade[]>([])

  // Load persisted history whenever accountId changes
  useEffect(() => {
    if (!accountId || accountId === 'demo') { setSettledHistory([]); return }
    const stored = loadHistory(accountId)
    historyRef.current = stored
    setSettledHistory(stored)
    prevBinariesRef.current = new Map()
    prevBalanceRef.current  = null
  }, [accountId])

  const refresh = useCallback(async () => {
    if (!accountId) return
    try {
      const res = await fetch(`${API_BASE}/api/state?account_id=${accountId}`)
      if (!res.ok) return
      const data = await res.json()

      const newAccount:   AccountState   = data.account   ?? null
      const newPositions: Position[]     = data.positions ?? []
      const newBinaries:  BinaryOption[] = data.binaries  ?? []
      const newBalance = newAccount?.balance ?? null

      // ── Detect settled binaries ───────────────────────────────────────────
      const prevBinaries = prevBinariesRef.current
      const prevBalance  = prevBalanceRef.current

      if (prevBinaries.size > 0 && newBalance !== null && prevBalance !== null) {
        const settledNow: BinaryOption[] = []
        prevBinaries.forEach((binary, id) => {
          if (!newBinaries.find(b => b.id === id)) settledNow.push(binary)
        })

        if (settledNow.length > 0) {
          const balanceDelta = newBalance - prevBalance
          const pnlEach      = balanceDelta / settledNow.length

          const newlySettled: SettledTrade[] = settledNow.map(b => ({
            id:          b.id,
            symbol:      b.symbol,
            direction:   b.direction,
            stake:       b.stake,
            ticks_total: b.ticks_total,
            entry_mid:   b.entry_mid,
            settled_at:  Date.now(),
            outcome:     pnlEach >= 0 ? 'win' : 'loss',
            pnl:         parseFloat(pnlEach.toFixed(2)),
          }))

          const updated = [...newlySettled, ...historyRef.current].slice(0, MAX_HISTORY)
          historyRef.current = updated
          setSettledHistory(updated)
          if (accountId !== 'demo') saveHistory(accountId, updated)
        }
      }

      // Update refs for next poll
      prevBinariesRef.current = new Map(newBinaries.map(b => [b.id, b]))
      prevBalanceRef.current  = newBalance

      setAccount(newAccount)
      setPositions(newPositions)
      setBinaries(newBinaries)
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    refresh()
    // 1 s polling — short enough to catch 1-tick binary settlements
    const id = setInterval(refresh, 1000)
    return () => clearInterval(id)
  }, [refresh])

  return { account, positions, binaries, settledHistory, loading, refresh }
}

// ─── Trade actions ────────────────────────────────────────────────────────────

export async function placeCFD(accountId: string, symbol: string, side: 'BUY' | 'SELL', lots: number) {
  const res = await fetch(`${API_BASE}/api/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, symbol, side, lots }),
  })
  return res.json()
}

export async function closePosition(accountId: string, positionId: string) {
  const res = await fetch(`${API_BASE}/api/position/${positionId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId }),
  })
  return res.json()
}

export async function placeBinary(
  accountId: string, symbol: string,
  direction: 'UP' | 'DOWN', stake: number, ticks: number,
) {
  const res = await fetch(`${API_BASE}/api/binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, symbol, direction, stake, ticks }),
  })
  return res.json()
}
