'use client'
import { useState, useEffect, useCallback } from 'react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
const TOKEN_KEY = 'otuburu_token'

export interface AuthUser {
  token:      string
  user_id:    string
  email:      string
  name:       string
  picture:    string
  account_id: string  // real
  demo_id:    string
  real_balance: number
  demo_balance: number
}

export function useAuth() {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Restore session from sessionStorage on mount
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (!token) { setLoading(false); return }
    fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setUser({ ...data, token })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const loginWithGoogle = useCallback(async (credential: string) => {
    const res  = await fetch(`${API_BASE}/auth/google`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Login failed')

    // Fetch balances
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${data.token}` },
    }).then(r => r.json())

    const authUser: AuthUser = { ...data, ...me }
    sessionStorage.setItem(TOKEN_KEY, data.token)
    setUser(authUser)
    return authUser
  }, [])

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY)
    setUser(null)
    // Sign out from Google too
    if (typeof window !== 'undefined' && (window as any).google) {
      (window as any).google.accounts.id.disableAutoSelect()
    }
  }, [])

  const refreshBalances = useCallback(async () => {
    if (!user) return
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${user.token}` },
    }).then(r => r.json()).catch(() => null)
    if (me) setUser(prev => prev ? { ...prev, ...me } : prev)
  }, [user])

  return { user, loading, loginWithGoogle, logout, refreshBalances }
}
