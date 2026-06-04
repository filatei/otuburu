/**
 * Hausa (ha) translations.
 *
 * Status: SEED — high-confidence common words only. The full pack needs
 * a translator-of-record review before launching to the Northern
 * Nigerian market. Marked strings are best-guesses; missing keys fall
 * back to English transparently via the provider.
 *
 * Hausa speakers: ~70M (Northern Nigeria + Niger + Diaspora). Most are
 * comfortable with Boko (Latin) script which is what we use here.
 * Tone marks omitted by convention for app UI.
 *
 * Hand-off
 * ────────
 * Mirror en.ts structure. Any key you don't translate falls back to
 * English. Don't translate {placeholder} tokens — they're substituted
 * at runtime by t().
 *
 * Pidgin English ("PCM") and Yoruba ("yo") follow the same pattern;
 * scaffold ready, language packs added when translators deliver.
 */

import type { DeepPartial } from './types'
import type { en } from './en'

export const ha: DeepPartial<typeof en> = {
  common: {
    confirm: 'Tabbatar',
    cancel:  'Soke',
    save:    'Ajiye',
    close:   'Rufe',
    loading: 'Yana ɗauka…',
    yes:     'Ee',
    no:      "A'a",
    error:   'Kuskure',
    retry:   'Sake gwadawa',
    amount:  'Adadi',
    balance: 'Ma’auni',
  },
  auth: {
    signIn:           'Shiga',
    signOut:          'Fita',
    signInWithGoogle: 'Shiga da Google',
    welcome:          'Barka da zuwa Otuburu',
    tagline:          'Kasuwannin gaskiya da na koyo, ba kuɗin kwamishan',
  },
  drawer: {
    deposit:       'Ajiye kuɗi',
    withdraw:      'Cire kuɗi',
    transfer:      'Tura',
    history:       'Tarihin biyan kuɗi',
    switchAccount: 'Canza asusu',
    editProfile:   'Gyara bayanin martaba',
    contact:       'Tuntube mu',
    getApp:        'Sami manhaja',
    savings:       'Tanadi',
    savingsHint:   'Tura kuɗi daga asusun ciniki zuwa Tanadi kafin cirewa.',
    realBalance:   'Ma’aunin gaskiya',
    demoBalance:   'Ma’aunin koyo',
    goReal:        '→ Zuwa gaskiya',
    goDemo:        '→ Zuwa koyo',
    language:      'Harshe',
  },
  trade: {
    buy:             'Saya',
    sell:            'Sayar',
    buyByMarket:     'SAYA NAN TAKE',
    sellByMarket:    'SAYAR NAN TAKE',
    rise:            'Hawa',
    fall:            'Sauka',
    bid:             'Cizo',
    ask:             'Tambaya',
    lots:            'Yawa',
    stopLoss:        'Tsayar da Asara',
    takeProfit:      'Karɓi Riba',
    fillPolicy:      'Manufar cikawa',
    fillOrKill:      'Cika ko soke',
    marketExecution: 'Aiwatarwar Kasuwa',
    // Long-form strings are left in English until translator-of-record review.
  },
  symbols: {
    quotes:      'Farashin',
    add:         '+ Ƙara',
    manage:      'Sarrafa alamomi',
    groupMetal:  'Karafa',
    groupCrypto: 'Crypto',
    groupIndex:  'Manyan kasuwanci',
    groupSynth:  'Na koyo',
    groupFx:     'Forex',
  },
  transfer: {
    title: 'Tura',
    from:  'Daga',
    to:    'Zuwa',
    max:   'Mafi yawa',
  },
}
