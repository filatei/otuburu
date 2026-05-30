import type { MetadataRoute } from 'next'

/**
 * Web App Manifest — served by Next.js at /manifest.webmanifest.
 *
 * Tells browsers and mobile OSes that this is an installable PWA. Once a
 * user visits otuburu.torama.money, Chrome shows an install prompt, and on
 * iOS Safari they can "Add to Home Screen" → the app launches in a
 * standalone window with no browser chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             'Otuburu — Fractional Trading',
    short_name:       'Otuburu',
    description:      'Real markets, fractional access. Trade BTC, ETH, gold, ' +
                      'silver, S&P 500, Dow, Nasdaq for as little as $1.',
    start_url:        '/',
    scope:            '/',
    display:          'standalone',
    orientation:      'portrait-primary',
    background_color: '#0d0d0d',
    theme_color:      '#0d0d0d',
    categories:       ['finance', 'business'],
    lang:             'en',
    dir:              'ltr',
    // PNG icons served from web/public/icons/. The 'any' purpose variants
    // are the standard rectangular icons; the 'maskable' variants are
    // pre-padded to survive Android's circular / squircle / teardrop
    // adaptive-icon masks (the launcher crops 20 % off each edge).
    //
    // NOTE: web/icons/*.webp is a separate directory — that's the source
    // pool @capacitor/assets reads from when baking icons into the
    // Android/iOS native shells. Those files are NOT served at /icons/*
    // because they live outside web/public/.
    icons: [
      {
        src:     '/icons/icon-192.png',
        sizes:   '192x192',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icons/icon-512.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'any',
      },
      {
        src:     '/icons/icon-192-maskable.png',
        sizes:   '192x192',
        type:    'image/png',
        purpose: 'maskable',
      },
      {
        src:     '/icons/icon-512-maskable.png',
        sizes:   '512x512',
        type:    'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
