'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { AccountState, Position, BinaryOption, SettledTrade, SpotPosition } from '@/types'
import { authFetch } from '@/lib/api'

const API_BASE    = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const HISTORY_KEY = 'otuburu_trade_history'
const MAX_HISTORY = 200

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
  } catch { /* storage full */ }
}

// ─── Public interface ─────────────────────────────────────────────────────────
export interface GameState {
  account:        AccountState | null
  positions:      Position[]
  binaries:       BinaryOption[]
  spots:          SpotPosition[]
  settledHistory: SettledTrade[]
  loading:        boolean
  refresh:        () => void       // one-shot HTTP fetch (post-trade fallback)
  applyState:     (data: unknown) => void  // called by useTicks on WS state push
}

export function useAccount(accountId: string): GameState {
  const [account,        setAccount]        = useState<AccountState | null>(null)
  const [positions,      setPositions]      = useState<Position[]>([])
  const [binaries,       setBinaries]       = useState<BinaryOption[]>([])
  const [spots,          setSpots]          = useState<SpotPosition[]>([])
  const [settledHistory, setSettledHistory] = useState<SettledTrade[]>([])
  const [loading,        setLoading]        = useState(true)

  const prevBinariesRef = useRef<Map<string, BinaryOption>>(new Map())
  const prevBalanceRef  = useRef<number | null>(null)
  const historyRef      = useRef<SettledTrade[]>([])
  const inflightRef     = useRef(false)

  // Load persisted history when accountId changes
  useEffect(() => {
    if (!accountId || accountId === 'demo') { setSettledHistory([]); return }
    const stored = loadHistory(accountId)
    historyRef.current = stored
    setSettledHistory(stored)
    prevBinariesRef.current = new Map()
    prevBalanceRef.current  = null
  }, [accountId])

  // ── Core state application — shared by both WebSocket push and HTTP fetch ──
  const applyState = useCallback((data: unknown) => {
    const d = data as Record<string, unknown>
    const newAccount:   AccountState    = (d.account   as AccountState)    ?? null
    const newPositions: Position[]      = (d.positions as Position[])      ?? []
    const newBinaries:  BinaryOption[]  = (d.binaries  as BinaryOption[])  ?? []
    const newSpots:     SpotPosition[]  = (d.spots     as SpotPosition[])  ?? []
    const newBalance = newAccount?.balance ?? null

    // Detect settled binaries (disappeared from live list since last update)
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
          outcome:     pnlEach > 0 ? 'win' : 'loss',
          pnl:         parseFloat(pnlEach.toFixed(2)),
        }))

        const updated = [...newlySettled, ...historyRef.current].slice(0, MAX_HISTORY)
        historyRef.current = updated
        setSettledHistory(updated)
        if (accountId !== 'demo') saveHistory(accountId, updated)
      }
    }

    prevBinariesRef.current = new Map(newBinaries.map(b => [b.id, b]))
    prevBalanceRef.current  = newBalance

    setAccount(newAccount)
    setPositions(newPositions)
    setBinaries(newBinaries)
    setSpots(newSpots)
    setLoading(false)
  }, [accountId])

  // ── HTTP fetch — initial load + explicit post-trade refresh ───────────────
  // No more setInterval — state arrives via WebSocket (RunStatePump in gateway).
  const refresh = useCallback(async () => {
    if (!accountId || inflightRef.current) return
    inflightRef.current = true
    try {
      const res = await authFetch(`${API_BASE}/api/state?account_id=${accountId}`)
      if (!res.ok) return
      applyState(await res.json())
    } catch { /* silent */ } finally {
      inflightRef.current = false
    }
  }, [accountId, applyState])

  // One initial fetch so the UI has data immediately (before first WS push, ~1s)
  useEffect(() => {
    refresh()
  }, [refresh])

  return { account, positions, binaries, spots, settledHistory, loading, refresh, applyState }
}

// ─── Trade actions ────────────────────────────────────────────────────────────

export async function placeCFD(
  accountId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  lots: number,
  tp_profit?: number,
  sl_loss?: number,
) {
  const res = await authFetch(`${API_BASE}/api/order`, {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId, symbol, side, lots, tp_profit, sl_loss }),
  })
  return res.json()
}

export async function placeSpot(
  accountId: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  stake: number,
  tp_profit?: number,
  sl_loss?: number,
) {
  const res = await authFetch(`${API_BASE}/api/spot`, {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId, symbol, side, stake, tp_profit, sl_loss }),
  })
  return res.json()
}

export async function closeSpot(accountId: string, spotId: string) {
  const res = await authFetch(`${API_BASE}/api/spot/${spotId}`, {
    method: 'DELETE',
    body: JSON.stringify({ account_id: accountId }),
  })
  return res.json()
}

export async function closePosition(accountId: string, positionId: string) {
  const res = await authFetch(`${API_BASE}/api/position/${positionId}`, {
    method: 'DELETE',
    body: JSON.stringify({ account_id: accountId }),
  })
  return res.json()
}

export async function placeBinary(
  accountId: string, symbol: string,
  direction: 'UP' | 'DOWN', stake: number, ticks: number,
) {
  const res = await authFetch(`${API_BASE}/api/binary`, {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId, symbol, direction, stake, ticks }),
  })
  return res.json()
}

/**
 * Provision (or sync) an engine account.
 * Called on login and on balance top-up after a deposit.
 */
export async function provisionAccount(
  accountId: string,
  label: string,
  isDemo: boolean,
  initialBalance: number,
) {
  const res = await authFetch(`${API_BASE}/api/account`, {
    method: 'POST',
    body: JSON.stringify({
      account_id:      accountId,
      label,
      is_demo:         isDemo,
      initial_balance: initialBalance,
    }),
  })
  return res.json()
}
