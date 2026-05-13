'use client'
import { useEffect, useState, useCallback } from 'react'
import type { AccountState, Position, BinaryOption } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

export interface GameState {
  account:   AccountState | null
  positions: Position[]
  binaries:  BinaryOption[]
  loading:   boolean
  refresh:   () => void
}

export function useAccount(accountId: string): GameState {
  const [account,   setAccount]   = useState<AccountState | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [binaries,  setBinaries]  = useState<BinaryOption[]>([])
  const [loading,   setLoading]   = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/state?account_id=${accountId}`)
      const data = await res.json()
      setAccount(data.account   ?? null)
      setPositions(data.positions ?? [])
      setBinaries(data.binaries   ?? [])
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [refresh])

  return { account, positions, binaries, loading, refresh }
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

export async function placeBinary(accountId: string, symbol: string, direction: 'UP' | 'DOWN', stake: number, ticks: number) {
  const res = await fetch(`${API_BASE}/api/binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, symbol, direction, stake, ticks }),
  })
  return res.json()
}
