'use client'
import { useState, useEffect, useCallback } from 'react'
import type { UserAccount } from '@/types'
import { clearPendingRef, getPendingRef } from '@/lib/affiliate'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'
// Persisted in localStorage (not sessionStorage) so the user stays signed in
// across browser closes — same persistence model as MT5 mobile. Cleared
// only by an explicit Sign out tap (see logout() below) or token expiry.
const TOKEN_KEY = 'otuburu_token'

export interface AuthUser {
  token:      string
  user_id:    string
  email:      string
  name:       string
  picture:    string
  account_id: string  // first real account (legacy field — use accounts[] for multi)
  demo_id:    string
  real_balance: number
  demo_balance: number
  /** Phase 2: every account the user owns (1 demo + N real). May be empty
   *  briefly on first login before /auth/me populates. */
  accounts?:    UserAccount[]
  /** Phase 4: savings wallet balance — the SOLE source for withdrawals.
   *  Users transfer funds from trading accounts into Savings, then withdraw
   *  from there. May be 0 for users who haven't transferred anything yet. */
  savings_balance?: number
}

export function useAuth() {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Restore session from localStorage on mount
  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY)
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
    // Affiliate attribution: include any pending ref from the landing
    // URL. Backend ignores ref for returning users — attribution is
    // one-shot at first signup, so retried sign-ins (different device,
    // forgotten password reset flow, etc.) can't switch IBs.
    const ref = getPendingRef()
    const res  = await fetch(`${API_BASE}/auth/google`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(ref ? { credential, ref } : { credential }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Login failed')

    // Fetch balances
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${data.token}` },
    }).then(r => r.json())

    const authUser: AuthUser = { ...data, ...me }
    localStorage.setItem(TOKEN_KEY, data.token)
    setUser(authUser)
    // Clear the ref once we've successfully signed in so a logout +
    // sign-in cycle can't re-attribute.
    clearPendingRef()
    return authUser
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
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

  /** applyToken — used after POST /wallet/accounts: the backend returns a
   *  fresh JWT that includes the new account in its aids claim, plus the
   *  new account row itself. We persist the token and merge the account so
   *  the user can trade against it immediately. */
  const applyToken = useCallback(async (newToken: string) => {
    localStorage.setItem(TOKEN_KEY, newToken)
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${newToken}` },
    }).then(r => r.json()).catch(() => null)
    if (me) setUser(prev => prev ? { ...prev, ...me, token: newToken } : prev)
  }, [])

  return { user, loading, loginWithGoogle, logout, refreshBalances, applyToken }
}
