'use client'
import { useEffect, useState, useCallback } from 'react'
import type { SymbolInfo } from '@/types'
import { isTradeable } from '@/types'
import { authFetch } from '@/lib/api'
import { useTicks }   from '@/hooks/useTicks'
import { useAccount } from '@/hooks/useAccount'
import { useAuth }    from '@/hooks/useAuth'
import Header            from '@/components/Header'
import SymbolBar         from '@/components/SymbolBar'
import Chart             from '@/components/Chart'
import TradePanel        from '@/components/TradePanel'
import Positions         from '@/components/Positions'
import MobileSymbolsTab  from '@/components/MobileSymbolsTab'
import MobilePositions   from '@/components/MobilePositions'
import MobileTradeForm   from '@/components/MobileTradeForm'
import AccountStatsPanel from '@/components/AccountStatsPanel'
import AuthModal           from '@/components/AuthModal'
import Landing             from '@/components/Landing'
import ProfileModal        from '@/components/ProfileModal'
import AppDrawer           from '@/components/AppDrawer'
import DepositModal        from '@/components/DepositModal'
import PendingTradeSheet    from '@/components/PendingTradeSheet'
import TransferModal       from '@/components/TransferModal'
import MT5TradeTicket      from '@/components/MT5TradeTicket'
import ManageSymbolsSheet  from '@/components/ManageSymbolsSheet'
import AffiliateSheet      from '@/components/AffiliateSheet'
import KycSheet            from '@/components/KycSheet'
import ConnectBrokerSheet  from '@/components/ConnectBrokerSheet'
import GetAppModal         from '@/components/GetAppModal'
import ContactModal        from '@/components/ContactModal'
import SymbolActionsSheet     from '@/components/SymbolActionsSheet'
import SymbolPropertiesModal  from '@/components/SymbolPropertiesModal'
import AccountSwitcherSheet   from '@/components/AccountSwitcherSheet'
import WithdrawSheet          from '@/components/WithdrawSheet'
import { provisionAccount } from '@/hooks/useAccount'
// useAutoFullscreen — removed from auto-trigger. The fullscreen toggle in
// the drawer's Display section still works for manual opt-in. See the
// FullscreenItem in AppDrawer for the user-facing entry point.
//   import { useAutoFullscreen } from '@/hooks/useAutoFullscreen'
import { useDailyPnLBySymbol } from '@/hooks/useDailyPnL'
import { useWatchlist } from '@/hooks/useWatchlist'
import { getWatchlist } from '@/lib/watchlist'
import { captureRefFromUrl } from '@/lib/affiliate'
import type { PendingIntent } from '@/lib/pendingIntent'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://otuburu.torama.money'

/**
 * Symbol display priority. Lower index = leftmost on the symbol bar.
 * Anything not in this list is appended after, in API-returned order.
 *
 * Lead with metals (gold first, then silver — the headline retail assets),
 * then majors (BTC, ETH), then indices (SPX/DJI/NDX), then forex (EUR/GBP),
 * then synthetic indices at the end.
 */
const SYMBOL_ORDER: string[] = [
  'cryXAUUSD',  // Gold
  'XAGUSD',     // Silver
  'cryBTCUSD',  // Bitcoin
  'cryETHUSD',  // Ethereum
  'SPX',        // S&P 500
  'DJI',        // Dow Jones
  'NDX',        // Nasdaq-100
  'frxEURUSD',  // EUR/USD
  'frxGBPUSD',  // GBP/USD
  'BOOM500',
  'BOOM1000',
  'CRASH1000',
]
const SYMBOL_RANK = new Map(SYMBOL_ORDER.map((s, i) => [s, i]))

function orderSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const FALLBACK = SYMBOL_ORDER.length
  return [...symbols].sort((a, b) => {
    const ra = SYMBOL_RANK.get(a.symbol) ?? FALLBACK
    const rb = SYMBOL_RANK.get(b.symbol) ?? FALLBACK
    return ra === rb ? a.symbol.localeCompare(b.symbol) : ra - rb
  })
}

type MobileTab = 'symbols' | 'chart' | 'trade' | 'positions'

export default function TradingPage() {
  const [symbols,       setSymbols]       = useState<SymbolInfo[]>([])
  const [selected,      setSelected]      = useState('frxEURUSD')
  // Mode persists in localStorage so the redirect back from Paystack
  // (or any other navigation that triggers a full page reload) doesn't
  // toss the user back to demo mode after they were actively in real.
  // SSR-safe: useState initialiser only runs on the client.
  const [mode,          setMode]          = useState<'demo' | 'real'>(() => {
    if (typeof window === 'undefined') return 'demo'
    return (window.localStorage.getItem('otuburu.mode') as 'demo' | 'real') ?? 'demo'
  })
  const [authOpen,      setAuthOpen]      = useState(false)
  const [authError,     setAuthError]     = useState<string | null>(null)
  const [profileOpen,   setProfileOpen]   = useState(false)
  const [drawerOpen,    setDrawerOpen]    = useState(false)
  const [depositOpen,   setDepositOpen]   = useState(false)
  const [withdrawOpen,  setWithdrawOpen]  = useState(false)
  const [transferOpen,  setTransferOpen]  = useState(false)
  const [getAppOpen,    setGetAppOpen]    = useState(false)
  const [contactOpen,   setContactOpen]   = useState(false)
  const [mobileTab,     setMobileTab]     = useState<MobileTab>('chart')
  /** Symbol whose MT5-style action sheet is currently open. null = closed. */
  const [actionsFor,    setActionsFor]    = useState<string | null>(null)
  /** Symbol whose Specification/Properties modal is currently open. null = closed.
   *  Tracked separately from `actionsFor` so the modal mounts fresh each time
   *  and unmounts on close — no leaked open-state across symbol selections. */
  const [propertiesFor, setPropertiesFor] = useState<string | null>(null)
  /** Symbol whose MT5-style trade ticket is currently open. null = closed.
   *  Opens via SymbolActionsSheet → New Order. */
  const [ticketFor,     setTicketFor]     = useState<string | null>(null)
  /** Watchlist manager sheet open state. Lets the user toggle hidden
   *  symbols into Quotes. */
  const [manageOpen,    setManageOpen]    = useState(false)
  /** Affiliate / Refer-a-friend sheet open state. */
  const [affiliateOpen, setAffiliateOpen] = useState(false)
  /** KYC / Verify-identity sheet open state. */
  const [kycOpen,       setKycOpen]       = useState(false)
  /** Connect Broker sheet open state (Sprint 5.9e). */
  const [connectBrokerOpen, setConnectBrokerOpen] = useState(false)
  /** Phase 2 multi-account: when in real mode, which real account is active.
   *  Persisted per-user in localStorage so a session restore picks up where
   *  the user left off. Falls back to the first real account on first session. */
  const [selectedRealId,    setSelectedRealId]    = useState<string | null>(null)
  const [accountSheetOpen,  setAccountSheetOpen]  = useState(false)

  const { user, loading: authLoading, loginWithGoogle, logout, refreshBalances, applyToken } = useAuth()

  // Auto-fullscreen removed — was triggering unexpectedly post-sign-in,
  // making the URL bar disappear right as users were trying to read the
  // first-time onboarding. The manual "Hide browser URL" toggle in the
  // drawer's Display section is still wired up via FullscreenItem.

  // Capture ?ref=CODE from the landing URL on first paint. Runs before
  // the Paystack ?reference= verifier below, but they don't conflict
  // (different param names). Persisted to localStorage; the Google
  // sign-in handler picks it up and attributes the referral one-shot
  // at first user creation.
  useEffect(() => { captureRefFromUrl() }, [])

  // Unauthenticated visitors land on the marketing landing page first (rendered
  // below) — they open the sign-in sheet themselves via Get started. Only close
  // the sheet once a user is present.
  useEffect(() => {
    if (user) setAuthOpen(false)
  }, [user])

  // Persist mode changes so a redirect (Paystack callback, OAuth return,
  // etc.) doesn't reset the user to demo. Pair with the localStorage
  // hydration in the useState initialiser above.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('otuburu.mode', mode)
  }, [mode])

  // ── Paystack verify-on-return ────────────────────────────────────────────
  //
  // Paystack redirects to APP_URL?deposit=success&reference=OTU-... after a
  // successful checkout. The webhook is the authoritative credit path, but
  // we can't trust it to fire reliably in every test scenario. Verifying
  // synchronously here gives the user immediate balance feedback AND works
  // as a fallback if the webhook never arrives. Both paths use the same
  // creditPaystack() Postgres flow with a status='pending' guard, so
  // they're safe to race.
  useEffect(() => {
    if (typeof window === 'undefined' || !user) return
    const params = new URLSearchParams(window.location.search)
    const reference = params.get('reference') ?? params.get('trxref')
    if (!reference) return

    // Force real mode — the user just paid; the deposit lands on the real
    // account. Without this they'd land back in demo and wonder where
    // their money went.
    setMode('real')

    // Clean the URL immediately so a refresh / back-button doesn't re-verify
    // (idempotent on the server, but cleaner UX).
    window.history.replaceState({}, '', window.location.pathname)

    authFetch(`${API_BASE}/payments/paystack/verify`, {
      method: 'POST',
      body:   JSON.stringify({ reference }),
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.error ?? `verify failed (${r.status})`)
        return data as { status: string; amount_usd?: number }
      })
      .then(d => {
        refreshBalances()
        // TODO: surface a toast — for now console + balance flash is the cue
        console.info('[paystack] verify', d.status, 'usd', d.amount_usd)
      })
      .catch(err => {
        console.warn('[paystack] verify failed', err)
        // Even on failure, refresh in case the webhook beat us
        refreshBalances()
      })
  }, [user, refreshBalances])

  useEffect(() => {
    fetch(`${API_BASE}/api/symbols`)
      .then(r => r.json())
      .then((d: { symbols: SymbolInfo[] }) => {
        const ordered = orderSymbols(d.symbols ?? [])
        setSymbols(ordered)
        if (!ordered.length) return
        // Land on the first watchlist symbol the engine actually serves —
        // avoids the awkward "chart shows a symbol that's missing from
        // Quotes" state on first paint. Falls back to ordered[0] if the
        // watchlist intersection is empty (user manually cleared it).
        const watchlistIds = new Set(getWatchlist())
        const firstWatched = ordered.find(s => watchlistIds.has(s.symbol))
        setSelected((firstWatched ?? ordered[0]).symbol)
      })
      .catch(() => {})
  }, [])

  // Phase 2: pick the active real account.
  //   1. localStorage preference if the user previously chose one we still own
  //   2. otherwise the first real account in accounts[]
  //   3. fall back to legacy user.account_id (single-account JWTs)
  const realAccountId: string | null = (() => {
    if (!user) return null
    // Sprint 5.9d — broker accounts are tradeable too. The "real account
    // id" name predates broker accounts; semantically this is now
    // "selected non-demo account id" and may resolve to a broker.
    const owned = (user.accounts ?? []).filter(isTradeable).map(a => a.id)
    if (selectedRealId && owned.includes(selectedRealId)) return selectedRealId
    return owned[0] ?? user.account_id ?? null
  })()
  const activeAccount = user?.accounts?.find(a => a.id === realAccountId)
  const activeAccountLabel: string | undefined = activeAccount?.label
  const activeAccountKind = activeAccount?.kind

  // Hydrate selectedRealId from localStorage once the user is known.
  useEffect(() => {
    if (!user) return
    const key = `otuburu.selected_real:${user.user_id}`
    const stored = localStorage.getItem(key)
    // Sprint 5.9d — allow restoring a broker account as the active
    // non-demo selection too, not just synthetic real accounts.
    if (stored && user.accounts?.some(a => a.id === stored && isTradeable(a))) {
      setSelectedRealId(stored)
    }
  }, [user?.user_id, user?.accounts])

  const selectRealAccount = useCallback((id: string) => {
    setSelectedRealId(id)
    if (user) localStorage.setItem(`otuburu.selected_real:${user.user_id}`, id)
    setMode('real') // switching account implies real mode
  }, [user])

  const accountId = user
    ? (mode === 'real' ? (realAccountId ?? user.account_id) : user.demo_id)
    : 'demo'

  // applyState is passed to useTicks so WebSocket state pushes update account
  // without any HTTP polling — eliminates the mod_evasive rate-limit trigger.
  const { account, positions, binaries, spots, settledHistory, refresh, applyState } = useAccount(accountId)

  const { lastTick, allTicks, candles, connected } = useTicks(selected, applyState, accountId)

  const selectedInfo = symbols.find(s => s.symbol === selected) ?? null

  // Watchlist filter — only the user's curated symbols show in SymbolBar +
  // MobileSymbolsTab. Order is preserved from the source list (orderSymbols
  // already sorted by asset class + alpha) for consistent positioning;
  // the watchlist set is a membership filter, not a re-ordering layer.
  const watchlist = useWatchlist()
  const visibleSymbols = symbols.filter(s => watchlist.idSet.has(s.symbol))

  const handleGoogleLogin = useCallback(async (credential: string) => {
    setAuthError(null)
    try {
      // The user state populates after this resolves; engine provisioning
      // happens in the user-keyed useEffect below, so it covers both
      // fresh-login and session-restore paths.
      await loginWithGoogle(credential)
    } catch (err: any) {
      setAuthError(err?.message ?? 'Sign-in failed. Please try again.')
    }
  }, [loginWithGoogle])

  // Sync engine books to Postgres balances whenever the user object changes
  // (fresh login OR session restore on page reload). Engine's CreateAccount
  // is idempotent: it creates if missing or syncs balance down to caller's
  // value when no positions are in flight. Without this, a returning user
  // with a stale engine balance would never see Postgres truth without
  // signing out and back in.
  //
  // Phase 2: provision every real account the user owns, not just the legacy
  // primary, so newly-created accounts get an engine book on first session.
  useEffect(() => {
    if (!user) return
    const calls: Promise<unknown>[] = [
      provisionAccount(user.demo_id, 'Demo', true, 10_000),
    ]
    for (const a of user.accounts ?? []) {
      // Sprint 5.9d — provision broker accounts too. The gateway already
      // calls engine.CreateAccount on POST /api/lp-links, so this is
      // idempotent and mostly belt-and-suspenders for session-restore
      // after an engine restart.
      if (isTradeable(a)) {
        calls.push(provisionAccount(a.id, a.label || 'Real', false, a.balance ?? 0))
      }
    }
    // Fallback for older tokens whose /auth/me didn't return accounts[] yet.
    // Tradeable check kept the same — broker accounts only ever come through
    // the new accounts[] shape, never the legacy single-account_id payload.
    if (!user.accounts?.some(isTradeable) && user.account_id) {
      calls.push(provisionAccount(user.account_id, 'Real', false, user.real_balance ?? 0))
    }
    Promise.allSettled(calls)
  }, [user?.user_id, user?.real_balance, user?.accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Called by AccountSwitcherSheet after a successful POST /wallet/accounts.
  // We swap in the fresh JWT (which now carries the new account id in its
  // aids claim), provision the engine book, and switch into the new account.
  const handleAccountCreated = useCallback(async (newId: string, newToken: string) => {
    await applyToken(newToken)
    // Engine book provisioning for the new account — start at $0; deposit
    // funds will sync up via the wallet's balance-sync path.
    provisionAccount(newId, 'Real', false, 0).catch(() => {})
    selectRealAccount(newId)
  }, [applyToken, selectRealAccount])

  const handleTraded = useCallback(() => {
    refresh()
    refreshBalances()
  }, [refresh, refreshBalances])

  // ── Pending trade intent (deposit → auto-resume) ──────────────────────────
  // When a real-mode trade can't be afforded, the trade panels hand us the
  // captured intent and we open the deposit flow. The engine balance updates
  // over the existing WebSocket state pump when the deposit credits; once it
  // covers the order we close the deposit sheet and surface a one-tap confirm.
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null)
  const handleNeedDeposit = useCallback((intent: PendingIntent) => {
    setPendingIntent(intent)
    setDepositOpen(true)
  }, [])
  const intentFunded =
    !!pendingIntent && !!account && account.balance + 1e-9 >= pendingIntent.requiredUSD
  useEffect(() => {
    if (intentFunded) setDepositOpen(false)
  }, [intentFunded])

  const openCount = positions.length + binaries.length + spots.length

  // Aggregate floating P&L across all open positions and spots — drives the
  // pnl label on the MT5-style AccountStatsPanel header on mobile.
  const floatingPnl =
    positions.reduce((s, p) => s + (p.unrealised_pnl ?? 0), 0) +
    spots.reduce((s, p) => s + (p.unrealised_pnl ?? 0), 0)

  // Today's net P&L per symbol — drives the small "+12.34 today" / "−5.00
  // today" subline under each Quotes row. Realised since UTC midnight plus
  // unrealised on open positions/spots.
  const dailyPnl = useDailyPnLBySymbol(settledHistory, positions, spots)

  // Logged out → show the public landing page (not the gated trading UI). The
  // sign-in sheet opens on top when the visitor taps Get started / Sign in.
  if (!user) {
    return (
      <div className="h-[100dvh] bg-surface">
        {authLoading
          ? <div className="h-full grid place-items-center text-dim text-sm">Loading…</div>
          : <Landing onGetStarted={() => setAuthOpen(true)} />}
        {authOpen && <AuthModal onSuccess={handleGoogleLogin} error={authError} onClose={() => setAuthOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-surface">
      {/* Modals & drawer */}
      {authOpen    && <AuthModal onSuccess={handleGoogleLogin} error={authError} />}
      {profileOpen && user && <ProfileModal user={user} onClose={() => setProfileOpen(false)} />}
      {/* DepositModal stays mounted while `user` is present so BottomSheet
          can play its exit animation when `open` flips back to false. */}
      {user && <DepositModal open={depositOpen} user={user} onClose={() => setDepositOpen(false)} />}
      {/* Deposit → auto-resume: once a pending trade is funded, surface it for
          a one-tap confirm. onDone clears the intent (and places, if confirmed). */}
      {user && (
        <PendingTradeSheet
          open={intentFunded}
          intent={pendingIntent}
          onDone={(placed) => {
            setPendingIntent(null)
            if (placed) { handleTraded(); setMobileTab('positions') }
          }}
        />
      )}
      {/* Transfer between Savings + trading accounts. onTransferred fires
          refreshBalances() so the drawer Savings card + Header balance
          update immediately without a page reload. */}
      {user && (
        <TransferModal
          open={transferOpen}
          user={user}
          onClose={() => setTransferOpen(false)}
          onTransferred={() => { refreshBalances(); refresh() }}
        />
      )}

      {/* MT5-style symbol actions sheet — tap a row on Quotes to open. */}
      <SymbolActionsSheet
        open={actionsFor !== null}
        onClose={() => setActionsFor(null)}
        info={actionsFor ? (symbols.find(s => s.symbol === actionsFor) ?? null) : null}
        tick={actionsFor ? (allTicks[actionsFor] ?? null) : null}
        positions={positions}
        spots={spots}
        accountId={accountId}
        onTraded={handleTraded}
        onOpenChart={() => { if (actionsFor) { setSelected(actionsFor); setMobileTab('chart') } }}
        onNewOrder ={() => { if (actionsFor) setTicketFor(actionsFor) }}
        onOpenProperties={() => { if (actionsFor) setPropertiesFor(actionsFor) }}
      />

      {/* Symbol Specification (Properties) modal — mounted on demand so each
          open is a fresh component instance with no leaked toggle state. */}
      {propertiesFor && (
        <SymbolPropertiesModal
          open={true}
          info={symbols.find(s => s.symbol === propertiesFor) ?? null}
          onClose={() => setPropertiesFor(null)}
        />
      )}

      {/* Watchlist manager — list every engine symbol, toggle in/out of
          the user's local watchlist. Persistence + state lives in
          useWatchlist; this sheet is presentation only. Always-mounted so
          BottomSheet can animate close after toggle. */}
      <ManageSymbolsSheet
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        symbols={symbols}
      />

      {/* Affiliate / Refer-a-friend sheet — shows the user's auto-minted
          6-char code + share URL + intro count. Always-mounted so the
          BottomSheet exit animation runs cleanly. */}
      <AffiliateSheet
        open={affiliateOpen}
        onClose={() => setAffiliateOpen(false)}
      />

      {/* KYC / Verify-identity sheet — Smile Identity backed. Mounted
          while user is present so the form state survives drawer close
          and the BottomSheet exit animation runs cleanly. */}
      {user && (
        <KycSheet
          open={kycOpen}
          onClose={() => setKycOpen(false)}
          onVerified={() => { refreshBalances() }}
        />
      )}

      {/* Connect Broker sheet (Sprint 5.9e) — list + add user_lp_links.
          Authed-only. On successful create, refresh /auth/me so the new
          broker account flows into user.accounts (so the picker sees
          it) and auto-switch to the new broker so the user can trade
          immediately without an extra picker step. */}
      {user && (
        <ConnectBrokerSheet
          open={connectBrokerOpen}
          onClose={() => setConnectBrokerOpen(false)}
          onCreated={(brokerAccountId) => {
            // refreshBalances re-runs /auth/me; the next render's
            // user.accounts will include the broker row.
            refreshBalances()
            // selectRealAccount sets the active non-demo account and
            // flips mode to 'real'. From the user's POV: broker is
            // selected, trade panel is now wired to it.
            selectRealAccount(brokerAccountId)
          }}
        />
      )}

      {/* MT5-style full-screen trade ticket — mounted on demand from
          SymbolActionsSheet → New Order. The ticket subscribes to the
          symbol's live tick via the allTicks map so BID/ASK refresh
          without a separate WS. */}
      {ticketFor && accountId && (
        <MT5TradeTicket
          open={true}
          info={symbols.find(s => s.symbol === ticketFor)!}
          tick={allTicks[ticketFor] ?? null}
          accountId={accountId}
          onPlaced={() => { refresh(); refreshBalances() }}
          onClose={() => setTicketFor(null)}
        />
      )}
      <AppDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        user={user}
        mode={mode}
        activeAccountLabel={activeAccountLabel}
        activeAccountKind={activeAccountKind}
        engineBalance={account?.balance ?? null}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onLogout={logout}
        onEditProfile={() => setProfileOpen(true)}
        onDeposit={() => setDepositOpen(true)}
        onWithdraw={() => setWithdrawOpen(true)}
        onHistory={() => {}}
        onSwitchAccount={
          // Sprint 5.9d — show the switcher whenever the user has any
          // tradeable non-demo account (synthetic real OR broker).
          // Previously a broker-only user (no synthetic real yet) would
          // never see the switcher and couldn't reach their broker.
          (user?.accounts?.filter(isTradeable).length ?? 0) >= 1
            ? () => setAccountSheetOpen(true)
            : undefined
        }
        onTransfer={user ? () => setTransferOpen(true) : undefined}
        onAffiliate={user ? () => setAffiliateOpen(true) : undefined}
        onKyc={user ? () => setKycOpen(true) : undefined}
        onGetApp={() => setGetAppOpen(true)}
        onContact={user ? () => setContactOpen(true) : undefined}
        // Static export → /research/index.html. window.location avoids
        // pulling next/navigation into this already-large component.
        onResearch={() => { window.location.href = '/research/' }}
        // Sprint 5.9e — Connect Broker sheet. Authed-only because
        // /api/lp-links is JWT-gated; unauthed users can't link.
        onConnectBroker={user ? () => setConnectBrokerOpen(true) : undefined}
      />

      {/* "Get the App" sheet — Android APK + iOS PWA card. Always mounted
          (cheap, no API calls) so BottomSheet can animate close cleanly. */}
      <GetAppModal open={getAppOpen} onClose={() => setGetAppOpen(false)} />

      {/* Contact-support sheet — only mounted when user is signed in
          (backend requires auth). Same lifecycle pattern as DepositModal. */}
      {user && (
        <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} user={user} />
      )}

      {/* Phase 2 multi-account picker — list + switch + create. */}
      <AccountSwitcherSheet
        open={accountSheetOpen}
        onClose={() => setAccountSheetOpen(false)}
        accounts={user?.accounts ?? []}
        selectedId={realAccountId}
        onSelect={selectRealAccount}
        onCreated={handleAccountCreated}
      />

      {/* Withdrawal sheet — USDT path live, NGN tab placeholder until
          Phase 3 backend lands. Only mounted when user is signed in so
          we never have to deal with a null AuthUser inside. */}
      {user && (
        <WithdrawSheet
          open={withdrawOpen}
          onClose={() => setWithdrawOpen(false)}
          user={user}
          activeAccountId={realAccountId}
          onSubmitted={handleTraded}
        />
      )}

      <Header
        user={user}
        connected={connected}
        mode={mode}
        engineBalance={account?.balance ?? null}
        routingMode={account?.routing_mode}
        onModeToggle={() => setMode(m => m === 'demo' ? 'real' : 'demo')}
        onMenuOpen={() => setDrawerOpen(true)}
      />

      {/* SymbolBar — desktop only. Mobile users select symbols via the
          dedicated Symbols tab (MT5-style) to keep the trading screens
          uncluttered. */}
      <div className="hidden md:block">
        <SymbolBar
          symbols={visibleSymbols}
          ticks={allTicks}
          selected={selected}
          onSelect={sym => { setSelected(sym); setMobileTab('chart') }}
        />
      </div>

      {/* ── Desktop layout (md+): side-by-side ─────────────────────────────── */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <Chart
              candles={candles} lastTick={lastTick} symbol={selected}
              info={selectedInfo}
              accountId={accountId}
              binaries={binaries} positions={positions} spots={spots} settledHistory={settledHistory}
            />
          </div>
          <Positions
            positions={positions}
            binaries={binaries}
            spots={spots}
            settledHistory={settledHistory}
            ticks={allTicks}
            symbols={symbols}
            accountId={accountId}
            onRefresh={refresh}
          />
        </div>
        <TradePanel
          symbol={selected}
          info={selectedInfo}
          lastTick={lastTick}
          account={account}
          accountId={accountId}
          onTraded={handleTraded}
          onNeedDeposit={mode === 'real' ? handleNeedDeposit : undefined}
        />
      </div>

      {/* ── Mobile layout (<md): tab-switched panels ────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden md:hidden">
        {/* Content area — each tab is a dedicated full-screen view
            (Symbols / Chart / Trade / Positions). MT5-style separation. */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === 'symbols' && (
            <MobileSymbolsTab
              symbols={visibleSymbols}
              ticks={allTicks}
              selected={selected}
              dailyPnl={dailyPnl}
              // MT5 behaviour: tap a symbol → context sheet appears, user
              // chooses Chart / New Order / Close Profitable / Close Losers
              // / Properties. Direct-jump-to-chart is gone.
              onSelect={(s) => setActionsFor(s)}
              onManage={() => setManageOpen(true)}
            />
          )}
          {mobileTab === 'chart' && (
            // Pure-chart tab — no trade controls. MT-style: the chart is
            // for charting; rise/fall/buy/sell live in the dedicated Trade
            // tab (and the per-symbol actions sheet from the Symbols tab).
            // Keeping the chart full-bleed makes timeframe + indicator
            // analysis less cramped on small screens.
            <div className="h-full overflow-hidden">
              <Chart
                candles={candles} lastTick={lastTick} symbol={selected}
                info={selectedInfo}
                accountId={accountId}
                binaries={binaries} positions={positions} spots={spots} settledHistory={settledHistory}
              />
            </div>
          )}
          {mobileTab === 'trade' && (
            <div className="h-full overflow-y-auto bg-panel">
              <MobileTradeForm
                symbol={selected}
                info={selectedInfo}
                lastTick={lastTick}
                account={account}
                accountId={accountId}
                floatingPnl={floatingPnl}
                onTraded={() => { handleTraded(); setMobileTab('positions') }}
                onNeedDeposit={mode === 'real' ? handleNeedDeposit : undefined}
              />
            </div>
          )}
          {mobileTab === 'positions' && (
            <div className="h-full overflow-y-auto bg-panel">
              <AccountStatsPanel
                account={account}
                floatingPnl={floatingPnl}
                title="Positions"
              />
              <MobilePositions
                positions={positions}
                binaries={binaries}
                spots={spots}
                settledHistory={settledHistory}
                ticks={allTicks}
                symbols={symbols}
                accountId={accountId}
                onRefresh={refresh}
                onNewTrade={() => setMobileTab('trade')}
              />
            </div>
          )}
        </div>

        {/* Bottom tab bar — MT5-style: Symbols / Chart / Trade / Positions.
            h-16 (64px) for thumb-friendly touch targets (Apple/Material
            both recommend 44–48px minimum; we go bigger for one-handed reach). */}
        <nav className="shrink-0 bg-panel border-t border-border flex items-stretch h-16 safe-bottom">
          <MobileTabBtn
            label="Symbols"
            icon={<SymbolsIcon />}
            active={mobileTab === 'symbols'}
            onClick={() => setMobileTab('symbols')}
          />
          <MobileTabBtn
            label="Chart"
            icon={<ChartIcon />}
            active={mobileTab === 'chart'}
            onClick={() => setMobileTab('chart')}
          />
          <MobileTabBtn
            label="Trade"
            icon={<TradeIcon />}
            active={mobileTab === 'trade'}
            onClick={() => setMobileTab('trade')}
            accent
          />
          <MobileTabBtn
            label="Positions"
            icon={<PositionsIcon />}
            active={mobileTab === 'positions'}
            onClick={() => setMobileTab('positions')}
            badge={openCount > 0 ? openCount : undefined}
          />
        </nav>
      </div>
    </div>
  )
}

// ─── Mobile tab button ────────────────────────────────────────────────────────
function MobileTabBtn({ label, icon, active, onClick, accent, badge }: {
  label: string; icon: React.ReactNode; active: boolean;
  onClick: () => void; accent?: boolean; badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-medium relative transition-colors active:scale-95 ${
        active
          ? accent ? 'text-brand' : 'text-text'
          : 'text-dim hover:text-text'
      }`}
    >
      {active && (
        <span className={`absolute top-0 left-1/2 -translate-x-1/2 w-10 h-[3px] rounded-b ${accent ? 'bg-brand' : 'bg-text'}`} />
      )}
      <span
        className={`text-[22px] leading-none ${active ? (accent ? 'text-brand' : 'text-text') : 'text-dim'}`}
      >
        {icon}
      </span>
      <span className="leading-none">{label}</span>
      {badge !== undefined && (
        <span className="absolute top-1.5 right-[22%] min-w-[18px] h-[18px] bg-brand text-black text-[10px] font-bold rounded-full flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </button>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function SymbolsIcon() {
  // Grid-of-cards icon — represents the symbol watchlist
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function ChartIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}
function TradeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  )
}
function PositionsIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}
