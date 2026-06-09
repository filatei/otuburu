import type { Metadata } from 'next'
import Link from 'next/link'

/**
 * TORAMA Capital Research — public-facing landing page for the
 * platform's original research output. Sprint 5.10.
 *
 * Why this page exists
 * --------------------
 * Otuburu's product decisions (cent accounts, MVE-aware risk caps,
 * deliberate-undersizing defaults) trace back to two papers
 * published by the founder under TORAMA Capital Research. Hosting
 * them on-platform — instead of just on SSRN or arXiv — signals to
 * sophisticated traders that we know what regime small accounts
 * actually live in, and gives casual users a single page that says
 * "this isn't a casino."
 *
 * Audience
 * --------
 * 1. Sophisticated traders → read full PDF, share with peers
 * 2. Regulators / investors / partners → 30-second skim of titles
 *    + author cred ("Fellow, Nigerian Computer Society" implied via
 *    affiliation; we don't put credentials on the public page —
 *    those live in /CREDENTIALS offline)
 * 3. SEO / referral → "Minimum Viable Edge" is a coined term that
 *    we want to own
 *
 * Static export
 * -------------
 * Server component (no 'use client'). next build emits
 * /research/index.html with both PDFs at /research/*.pdf served
 * directly from web/public/research/. Apache reverse-proxy already
 * serves /research/ → /opt/otuburu/frontend/research/ as a sibling
 * of /. No backend wiring needed.
 */
export const metadata: Metadata = {
  title:       'Research · TORAMA Capital',
  description:
    'Original research from TORAMA Capital on the mathematics of small-account ' +
    'trading: the Minimum Viable Edge and Evaluation-Optimal Trading.',
  openGraph: {
    title:       'TORAMA Capital Research',
    description: 'Original research on the mathematics of small-account trading.',
    type:        'website',
    url:         'https://otuburu.torama.money/research/',
  },
}

interface Paper {
  /** Slug used for the PDF filename in web/public/research/. */
  slug:     string
  title:    string
  subtitle: string
  /** Comma-separated authors. Single name = founder. */
  author:   string
  /** Author affiliation block — institutional credit. */
  affiliation: string
  /** Publication date as displayed (e.g. "June 2026"). */
  date:     string
  /** 2–4 sentence abstract written for non-academics. Should be
   *  shorter than the paper's actual abstract; the goal is to make
   *  someone click "Read full paper". */
  abstract: string
  /** Single most-quotable result. Renders as a callout / pull-quote. */
  keyResult: string
  /** Why this matters for Otuburu's product. One paragraph that
   *  closes the loop between research and the actual trading
   *  surface the reader is using. */
  productTie: string
  /** BibTeX entry shown in a copy-friendly <pre>. */
  bibtex:   string
}

const PAPERS: Paper[] = [
  {
    slug:     'minimum_viable_edge',
    title:    'The Minimum Viable Edge',
    subtitle: 'Why lot quantization, not skill, decides whether a small account can compound',
    author:   'Akpodigha Filatei',
    affiliation: 'TORAMA Capital Research',
    date:     'June 2026',
    abstract:
      'Retail brokers force a minimum lot size on every trade. For a small account, ' +
      'this turns position-sizing into an additive random walk — even a strategy with ' +
      'a real statistical edge is run as a sequence of fixed-size bets where the ' +
      'gambler’s-ruin clock keeps ticking. We define the Minimum Viable Edge (MVE) ' +
      'as the smallest gross edge for which a given account size keeps its ruin ' +
      'probability below tolerance, and show that identical signals run on a $50 and a ' +
      '$1000 account produce ruin rates that differ by an order of magnitude.',
    keyResult:
      'With identical strong edge (μ = 0.35R per trade), a $50 account is blown ' +
      '27% of the time while a $1000 account running the SAME signals is essentially ' +
      'never blown.',
    productTie:
      'Otuburu’s cent and micro account types were designed in direct response to ' +
      'the MVE constraint. By scaling the unit of risk down to fractions of a dollar, ' +
      'we move small accounts back into the multiplicative regime where edge actually ' +
      'compounds — instead of running a $50 trader on lots designed for a $5000 account.',
    bibtex: `@techreport{filatei2026mve,
  author      = {Filatei, Akpodigha},
  title       = {The Minimum Viable Edge: Why Lot Quantization, not Skill,
                 Decides Whether a Small Account Can Compound},
  institution = {TORAMA Capital Research},
  year        = {2026},
  month       = {June},
  url         = {https://otuburu.torama.money/research/minimum_viable_edge.pdf}
}`,
  },
  {
    slug:     'evaluation_optimal_trading',
    title:    'Evaluation-Optimal Trading',
    subtitle: 'Why passing a prop-firm challenge is a first-passage problem, not a growth problem',
    author:   'Akpodigha Filatei',
    affiliation: 'TORAMA Capital Research',
    date:     'June 2026',
    abstract:
      'Prop-firm evaluations (FTMO, FundedNext, et al.) are conventionally attacked ' +
      'with growth-optimal position sizing — Kelly fractions, expected-log-wealth ' +
      'maximization. We show this is the wrong objective. Passing an evaluation is a ' +
      'first-passage problem: hit the profit target before hitting the drawdown limit. ' +
      'We derive the evaluation-optimal risk fraction f_eval that lies far below the ' +
      'Kelly fraction, and demonstrate that aggression which is optimal for growth is ' +
      'catastrophic for evaluations.',
    keyResult:
      'Under μ = 0.35R, evaluations pass 92% of the time at f_eval = 0.79% per ' +
      'trade, but only 44% at the Kelly fraction of 12%. Deliberate under-sizing is ' +
      'the correct discipline.',
    productTie:
      'Otuburu’s risk-engine defaults (per-trade stake cap, daily-loss circuit ' +
      'breaker, lot-step granularity) implement the evaluation-optimal regime by ' +
      'default. Users who want growth-optimal sizing must opt in explicitly — the ' +
      'platform’s out-of-the-box behavior is calibrated for survival, not ' +
      'maximum expected return.',
    bibtex: `@techreport{filatei2026evaluation,
  author      = {Filatei, Akpodigha},
  title       = {Evaluation-Optimal Trading: Why Passing a Prop-Firm Challenge
                 is a First-Passage Problem, not a Growth Problem},
  institution = {TORAMA Capital Research},
  year        = {2026},
  month       = {June},
  url         = {https://otuburu.torama.money/research/evaluation_optimal_trading.pdf}
}`,
  },
]

export default function ResearchPage() {
  return (
    <main className="min-h-screen bg-bg text-fg">
      {/* ── Top bar: back link + brand strip. Intentionally minimal —
          this page should feel like an institutional landing page,
          not a trading screen. ─────────────────────────────────────── */}
      <header className="border-b border-border">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-sm text-muted hover:text-fg transition-colors"
          >
            &larr; Back to trading
          </Link>
          <span className="text-xs uppercase tracking-widest text-muted">
            TORAMA Capital Research
          </span>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-12 pb-8">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mb-4">
          Research
        </h1>
        <p className="text-muted leading-relaxed max-w-2xl">
          Original work from TORAMA Capital on the mathematics that govern
          small-account trading. These papers underpin Otuburu&rsquo;s product
          decisions &mdash; account-kind structure, risk-engine defaults, and the
          deliberate under-sizing that ships out of the box.
        </p>
      </section>

      {/* ── Companion-papers note ─────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-8">
        <div className="rounded-xl border border-border bg-bg/50 px-5 py-4 text-sm text-muted leading-relaxed">
          The two papers below are <em>companion pieces</em>. The first
          (Minimum Viable Edge) establishes the survival regime that lot
          quantization imposes on small accounts. The second
          (Evaluation-Optimal Trading) shows why that regime makes
          conventional growth-optimal sizing the wrong tool for any
          challenge with a hard drawdown cap.
        </div>
      </section>

      {/* ── Paper cards ──────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-16 space-y-8">
        {PAPERS.map((p, i) => (
          <article
            key={p.slug}
            className="rounded-2xl border border-border bg-bg overflow-hidden"
          >
            {/* Title block */}
            <div className="px-5 sm:px-7 pt-6 pb-4 border-b border-border">
              <div className="text-xs uppercase tracking-widest text-muted mb-2">
                Paper {i + 1} of {PAPERS.length} &middot; {p.date}
              </div>
              <h2 className="text-xl sm:text-2xl font-semibold leading-tight mb-1">
                {p.title}
              </h2>
              <p className="text-muted italic leading-snug">
                {p.subtitle}
              </p>
              <div className="mt-3 text-sm">
                <span className="text-fg">{p.author}</span>
                <span className="text-muted"> &middot; {p.affiliation}</span>
              </div>
            </div>

            {/* Abstract */}
            <div className="px-5 sm:px-7 py-5 border-b border-border">
              <div className="text-xs uppercase tracking-widest text-muted mb-2">
                Abstract
              </div>
              <p className="text-sm leading-relaxed">{p.abstract}</p>
            </div>

            {/* Key result — pull quote */}
            <div className="px-5 sm:px-7 py-5 border-b border-border bg-brand/5">
              <div className="text-xs uppercase tracking-widest text-muted mb-2">
                Key result
              </div>
              <p className="text-sm leading-relaxed font-medium">
                {p.keyResult}
              </p>
            </div>

            {/* Product tie-in */}
            <div className="px-5 sm:px-7 py-5 border-b border-border">
              <div className="text-xs uppercase tracking-widest text-muted mb-2">
                What this means for Otuburu
              </div>
              <p className="text-sm leading-relaxed">{p.productTie}</p>
            </div>

            {/* Actions: download + cite */}
            <div className="px-5 sm:px-7 py-5 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <a
                href={`/research/${p.slug}.pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand text-black font-medium text-sm hover:opacity-90 transition-opacity"
              >
                <span aria-hidden>&#128196;</span>
                Read full paper (PDF)
              </a>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted hover:text-fg transition-colors select-none">
                  Cite as &hellip;
                </summary>
                <pre className="mt-3 p-3 rounded-lg border border-border bg-bg/50 overflow-x-auto text-xs leading-relaxed font-mono whitespace-pre">
{p.bibtex}
                </pre>
              </details>
            </div>
          </article>
        ))}
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 text-xs text-muted space-y-2">
          <p>
            Research published by TORAMA Capital. Hosted on Otuburu
            (https://otuburu.torama.money) for unrestricted access.
          </p>
          <p>
            Otuburu is a synthetic trading platform. Past performance and
            mathematical models do not guarantee future results. Trading
            involves risk of loss.
          </p>
        </div>
      </footer>
    </main>
  )
}
