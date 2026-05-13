'use client'
import { useEffect, useState, useCallback } from 'react'
import type { AccountState, Position, BinaryOption } from '@/types'

const API_BASE   = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const ACCOUNT_ID = 'demo'

export interface GameState {
  account:   AccountState | null
  positions: Position[]
  binaries:  BinaryOption[]
  loading:   boolean
  refresh:   () => void
}

export function useAccount(): GameState {
  const [account,   setAccount]   = useState<AccountState | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [binaries,  setBinaries]  = useState<BinaryOption[]>([])
  const [loading,   setLoading]   = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/state?account_id=${ACCOUNT_ID}`)
      const data = await res.json()
      setAccount(data.account   ?? null)
      setPositions(data.positions ?? [])
      setBinaries(data.binaries   ?? [])
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [refresh])

  return { account, positions, binaries, loading, refresh }
}

// ─── Trade actions ────────────────────────────────────────────────────────────

export async function placeCFD(symbol: string, side: 'BUY' | 'SELL', lots: number) {
  const res = await fetch(`${API_BASE}/api/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: ACCOUNT_ID, symbol, side, lots }),
  })
  return res.json()
}

export async function closePosition(positionId: string) {
  const res = await fetch(`${API_BASE}/api/position/${positionId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: ACCOUNT_ID }),
  })
  return res.json()
}

export async function placeBinary(symbol: string, direction: 'UP' | 'DOWN', stake: number, ticks: number) {
  const res = await fetch(`${API_BASE}/api/binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: ACCOUNT_ID, symbol, direction, stake, ticks }),
  })
  return res.json()
}
