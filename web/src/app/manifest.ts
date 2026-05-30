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
    // Icons are .webp output from `@capacitor/assets generate` — supported by
    // every browser we target (Android Chrome 36+, iOS Safari 14+, all of
    // Firefox/Edge). Smaller files than PNG with the same visual quality at
    // these icon sizes. The 'maskable' variants would require a separate
    // padded source to be safe inside Android's circular/squircle masks;
    // skipping until we generate them properly.
    icons: [
      {
        src:     '/icons/icon-192.webp',
        sizes:   '192x192',
        type:    'image/webp',
        purpose: 'any',
      },
      {
        src:     '/icons/icon-512.webp',
        sizes:   '512x512',
        type:    'image/webp',
        purpose: 'any',
      },
    ],
  }
}
