'use client'

/**
 * TranslationProvider — context that holds the active locale and a
 * useT() hook for translating in components.
 *
 * Lookup strategy: walk the dotted path through the active locale's
 * pack first; if the result isn't a string (missing key, untranslated
 * branch), fall back to English. This means a half-translated pack
 * still ships safely — every UI surface always has SOME text.
 *
 * Placeholder substitution: t('key', { value: 'X' }) replaces every
 * occurrence of {value} in the translated string with 'X'. Keep it
 * dead simple — no plurals, no gender, no rich formatting. If we
 * outgrow this we'll move to @formatjs/icu-messageformat.
 *
 * Persistence: locale choice goes to localStorage under
 * `otuburu.locale`. Browser language is the first-visit default if
 * we have a pack for it; otherwise English.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { en } from './en'
import { ha } from './ha'
import type { Locale, TranslationKey } from './types'

const PACKS = {
  en,
  ha,
  // Scaffolded but empty until translators deliver:
  yo:  {},
  pcm: {},
  fr:  {},
} as const

const STORAGE_KEY = 'otuburu.locale'

interface Ctx {
  locale:     Locale
  setLocale:  (l: Locale) => void
  t:          (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const Context = createContext<Ctx | null>(null)

/** lookup walks a dotted path against an arbitrarily-nested object.
 *  Returns the leaf string when found, undefined otherwise.
 *  Pure + reusable across locale + fallback lookups. */
function lookup(pack: unknown, path: string): string | undefined {
  const parts = path.split('.')
  let cur: unknown = pack
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return typeof cur === 'string' ? cur : undefined
}

/** substitute replaces every {key} occurrence with vars[key]. No
 *  escaping — keep translation strings simple. */
function substitute(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

export function TranslationProvider({ children }: { children: ReactNode }) {
  // Initial locale resolution. SSR-safe — first paint uses 'en' until
  // the effect below hydrates from localStorage.
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(STORAGE_KEY) as Locale | null
    if (stored && stored in PACKS) {
      setLocaleState(stored)
      return
    }
    // Heuristic browser-locale detection. We only honour the part
    // before `-` so en-GB falls to en, ha-NG to ha.
    const nav = (navigator.language || 'en').split('-')[0] as Locale
    if (nav in PACKS) setLocaleState(nav)
  }, [])

  const setLocale = (l: Locale) => {
    setLocaleState(l)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, l)
    }
  }

  const value = useMemo<Ctx>(() => ({
    locale,
    setLocale,
    t: (key, vars) => {
      const translated = lookup(PACKS[locale], key) ?? lookup(en, key) ?? key
      return substitute(translated, vars)
    },
  }), [locale])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** useT — primary hook for translating. */
export function useT(): Ctx {
  const ctx = useContext(Context)
  if (!ctx) {
    // Fallback for trees rendered outside the provider (e.g. error
    // boundaries during HMR). Returns the English baseline.
    return {
      locale: 'en',
      setLocale: () => {},
      t: (key, vars) => substitute(lookup(en, key) ?? key, vars),
    }
  }
  return ctx
}
