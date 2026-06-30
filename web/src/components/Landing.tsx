'use client'

/**
 * Pre-login landing page.
 *
 * Unauthenticated visitors land here first (instead of straight on the gated
 * sign-in sheet) so the site clearly describes what Otuburu is, who operates
 * it, and the risks of trading — then offers a Sign in / Get started button
 * that opens the AuthModal.
 */
interface Props {
  onGetStarted: () => void
}

const FEATURES: { icon: string; title: string; body: string }[] = [
  {
    icon: '📈',
    title: 'Synthetic indices, 24/7',
    body: 'Trade BOOM, CRASH and volatility indices that run around the clock — weekends included — on simulated, transparent price feeds.',
  },
  {
    icon: '🌍',
    title: 'Forex, crypto & gold CFDs',
    body: 'Go long or short with leverage on live markets: BTC, ETH, XAU/USD and major FX pairs, with tight synthetic spreads.',
  },
  {
    icon: '⏱️',
    title: 'Rise / Fall options',
    body: 'Fixed-duration trades on price direction with a fixed payout — pick a direction, a stake and a time.',
  },
  {
    icon: '💵',
    title: 'Instant deposits',
    body: 'Fund and withdraw in naira via bank transfer/card, or in USDT — start on a free demo account with virtual funds.',
  },
]

export default function Landing({ onGetStarted }: Props) {
  const year = new Date().getFullYear()
  return (
    <div className="h-[100dvh] overflow-y-auto bg-surface text-text">
      {/* Top bar */}
      <header className="flex items-center justify-between px-5 py-4 max-w-5xl mx-auto w-full">
        <div className="flex flex-col leading-none">
          <span className="text-brand font-bold text-2xl tracking-tight">OTUBURU</span>
          <span className="text-dim text-[10px] uppercase tracking-widest">Synthetic Trading</span>
        </div>
        <button
          onClick={onGetStarted}
          className="rounded-full bg-brand text-surface font-bold text-sm px-5 py-2 hover:opacity-90 transition"
        >
          Sign in
        </button>
      </header>

      <main className="max-w-5xl mx-auto w-full px-5 pb-12">
        {/* Hero */}
        <section className="text-center py-12">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight max-w-2xl mx-auto">
            Trade the markets,<br />any time of day.
          </h1>
          <p className="text-dim text-base leading-relaxed max-w-xl mx-auto mt-4">
            Otuburu is an online trading platform for synthetic indices, forex, crypto and
            gold. Practise risk-free on a demo account, then trade live — CFDs, spot and
            Rise/Fall options in one app.
          </p>
          <button
            onClick={onGetStarted}
            className="mt-7 rounded-full bg-brand text-surface font-bold text-base px-8 py-3 hover:opacity-90 transition"
          >
            Get started
          </button>
          <div className="text-dim text-xs mt-3">Free demo account · no deposit to start</div>
        </section>

        {/* Features */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-border bg-panel p-5 text-left">
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="font-bold text-[15px] mb-1">{f.title}</div>
              <div className="text-dim text-sm leading-relaxed">{f.body}</div>
            </div>
          ))}
        </section>

        {/* Risk warning */}
        <section className="mt-8 rounded-2xl border border-down/40 bg-down/5 p-5">
          <div className="font-bold text-sm mb-1 text-down">Risk warning</div>
          <p className="text-dim text-[13px] leading-relaxed">
            Trading leveraged products such as CFDs and options carries a high level of risk
            and can result in the loss of all your capital. These products may not be suitable
            for everyone; trade only with money you can afford to lose and make sure you
            understand the risks involved. Past performance is not a guarantee of future
            results.
          </p>
        </section>

        {/* About / contact */}
        <section className="mt-8 max-w-2xl">
          <h2 className="font-bold text-lg mb-2">About</h2>
          <p className="text-dim text-sm leading-relaxed">
            Otuburu is operated by Torama. Synthetic instruments (BOOM, CRASH, volatility
            indices) are simulated for trading purposes; market instruments reference live
            third-party price feeds. Your account is protected with Google sign-in and a
            transaction PIN.
          </p>
          <p className="text-dim text-sm leading-relaxed mt-3">
            <b className="text-text">Contact:</b>{' '}
            <a href="mailto:support@torama.money" className="text-brand">support@torama.money</a>
            <br />
            <b className="text-text">Web:</b> otuburu.torama.money
          </p>
        </section>

        <footer className="mt-10 pt-6 border-t border-border text-center text-dim text-xs">
          © {year} Otuburu · Operated by Torama · Trading involves risk.
        </footer>
      </main>
    </div>
  )
}
