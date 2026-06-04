/**
 * Type helpers for the i18n system.
 *
 * The interesting type is `TranslationKey` — a typed dotted-path union
 * of every string in en.ts. Call sites use it to get autocomplete +
 * compile-time errors on typos. Renaming a key in en.ts breaks every
 * use site, exactly as it should.
 */

import type { en } from './en'

/** Recursive type that walks an object literal and produces a union
 *  of all dotted paths to string leaves.
 *
 * Given `{ a: { b: 'hi', c: 'lo' }, d: 'go' }` produces
 *   'a.b' | 'a.c' | 'd'
 *
 * Limited to 4 levels deep — extend the conditional if we ever need
 * deeper namespacing, but flatten the schema instead if you can. */
type PathsOf<T, Prefix extends string = ''> = T extends string
  ? Prefix
  : T extends object
    ? {
        [K in keyof T & string]: PathsOf<T[K], `${Prefix}${Prefix extends '' ? '' : '.'}${K}`>
      }[keyof T & string]
    : never

/** Every legal dotted-path key against the en baseline. */
export type TranslationKey = PathsOf<typeof en>

/** Recursive Partial — lets language packs (ha, yo, ...) define only
 *  the keys they translate while keeping structural typing. Widens
 *  leaf strings: `en` uses `as const` so its leaves narrow to literal
 *  types ('Confirm', 'Cancel', ...). Translation packs would never
 *  satisfy that — 'Tabbatar' isn't assignable to literal 'Confirm'.
 *  We collapse string leaves back to `string` here so packs can
 *  supply any text. */
export type DeepPartial<T> = T extends string
  ? string
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Locale identifiers we ship support for. Pack files keyed by these
 *  in the provider's registry. */
export type Locale = 'en' | 'ha' | 'yo' | 'pcm' | 'fr'

export interface LocaleMeta {
  code:    Locale
  /** Native-script name shown in the language switcher. */
  native:  string
  /** English name as a fallback hint for non-native speakers. */
  english: string
}

export const LOCALES: readonly LocaleMeta[] = [
  { code: 'en',  native: 'English',           english: 'English' },
  { code: 'ha',  native: 'Hausa',             english: 'Hausa' },
  { code: 'yo',  native: 'Yorùbá',            english: 'Yoruba' },
  { code: 'pcm', native: 'Naija Pidgin',      english: 'Nigerian Pidgin' },
  { code: 'fr',  native: 'Français',          english: 'French' },
] as const
