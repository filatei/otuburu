/**
 * English baseline translations.
 *
 * Adding a new string:
 *   1. Add it here, under the right namespace (auth, trade, account...).
 *   2. Use it in the UI via `useT().t('namespace.key')`.
 *   3. Optionally add it to ha.ts; missing keys fall back to English.
 *
 * Why TypeScript objects vs JSON: nested object literals give us
 * `as const` typing, which means `TranslationKey` (in types.ts) is a
 * fully-typed dotted-path union — typos at call sites are compile
 * errors, not runtime "key not found" warnings.
 *
 * Conventions
 * ───────────
 *  - Namespaces are short (auth, trade, drawer, common). Avoid > 2 levels deep.
 *  - Keys are camelCase.
 *  - Values are display-ready strings. Pluralisation isn't supported yet —
 *    if you need it, build two keys ("itemOne", "itemMany") for now.
 *  - {placeholders} are substituted by t() — pass values as the second arg.
 *
 * Hand-off
 * ────────
 * Translators only need to copy this file's structure and translate
 * the values. We deliberately don't ship a YAML/JSON loader; the
 * lock-step typing catches "you renamed `auth.signIn` and forgot to
 * update ha.ts" at compile time.
 */

export const en = {
  common: {
    confirm:  'Confirm',
    cancel:   'Cancel',
    save:     'Save',
    close:    'Close',
    loading:  'Loading…',
    yes:      'Yes',
    no:       'No',
    error:    'Error',
    retry:    'Retry',
    amount:   'Amount',
    balance:  'Balance',
    // Short forms — what the Header chip and modes show. Kept distinct
    // from drawer.{real,demo}Balance which include the word "Balance".
    real:     'REAL',
    demo:     'DEMO',
  },
  auth: {
    signIn:           'Sign in',
    signOut:          'Sign out',
    signInWithGoogle: 'Sign in with Google',
    signInDifferent:  'Sign in with a different account',
    signInPrompt:     'Sign in to access your trading account',
    welcome:          'Welcome to Otuburu',
    welcomeShort:     'Welcome',
    tagline:          'Synthetic & real markets, zero-commission spreads',
    zeroCommission:   'Zero commission',
  },
  drawer: {
    deposit:        'Deposit',
    withdraw:       'Withdraw',
    transfer:       'Transfer',
    history:        'Transaction history',
    switchAccount:  'Switch account',
    editProfile:    'Edit profile',
    contact:        'Contact us',
    getApp:         'Get the App',
    savings:        'Savings',
    savingsHint:    'Move funds from a trading account into Savings before withdrawing.',
    realBalance:    'Real balance',
    demoBalance:    'Demo balance',
    goReal:         '→ Go Real',
    goDemo:         '→ Go Demo',
    language:       'Language',
  },
  trade: {
    buy:                'Buy',
    sell:               'Sell',
    buyByMarket:        'BUY BY MARKET',
    sellByMarket:       'SELL BY MARKET',
    rise:               'Rise',
    fall:               'Fall',
    bid:                'Bid',
    ask:                'Ask',
    lots:               'Lots',
    stopLoss:           'Stop Loss',
    takeProfit:         'Take Profit',
    fillPolicy:         'Fill policy',
    fillOrKill:         'Fill or Kill',
    marketExecution:    'Market Execution',
    attention:          'Attention! The trade will be executed at market conditions, difference with requested price may be significant.',
    marketClosed:       'Market closed for {symbol} — orders aren’t accepted while the session is shut.',
    insufficientBalance:'Insufficient balance',
  },
  symbols: {
    quotes:       'Quotes',
    add:          '+ Add',
    manage:       'Manage symbols',
    manageHint:   'Tap a symbol to add it to your watchlist. Tap again to remove. Your selection is saved on this device.',
    groupMetal:   'Metals',
    groupCrypto:  'Crypto',
    groupIndex:   'Indices',
    groupSynth:   'Synthetic',
    groupFx:      'Forex',
  },
  transfer: {
    title:          'Transfer',
    from:           'From',
    to:             'To',
    max:            'Max',
    instant:        'Transfers are instant. Withdrawals must originate from Savings — move funds there first, then use Withdraw.',
    destReceives:   'Destination receives',
    overMax:        'Exceeds available {max}.',
    insufficient:   'Insufficient savings — transfer funds into Savings first',
  },
  kyc: {
    title:           'Verify your identity',
    pitch:           'Verify your identity to unlock deposits up to $5,000 and enable withdrawals. Your data is encrypted in transit and only used to match Nigerian government records.',
    instantHint:     'Verification is usually instant. We do not share your data with third parties beyond the verification provider below.',
    // Required vendor disclosure — Smile Identity ToS asks every
    // integrator to surface this in the verification flow.
    providedBy:      'Identity verification is provided by Smile Identity',
    smileSite:       'smileidentity.com',
    verified:        '✓ Verified · Tier 1',
    verifiedSub:     'Your account is fully unlocked. Deposit limit ${cap}.',
    submitCta:       'Submit for verification',
    submitting:      'Verifying…',
    rejected:        'Last attempt rejected',
    correctAndRetry: 'Correct the details below and try again.',
  },
} as const
