import type { Metadata, Viewport } from 'next'
import './globals.css'
import InstallPwa from '@/components/InstallPwa'
import { TranslationProvider } from '@/lib/i18n/provider'

export const metadata: Metadata = {
  title:       'Otuburu · Fractional Trading',
  description: 'Real markets, fractional access. Trade BTC, ETH, gold, silver, ' +
               'S&P 500, Dow, Nasdaq for as little as $1.',
  applicationName: 'Otuburu',
  manifest:    '/manifest.webmanifest',
  icons: {
    // Browser tab icons. SVG is the modern primary; PNGs are the raster
    // fallback for older browsers + the iOS Home Screen icon (Safari
    // ignores SVG for apple-touch).
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: '/favicon.svg',
  },
  appleWebApp: {
    capable: true,
    title:   'Otuburu',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
  },
}

export const viewport: Viewport = {
  // Two themeColor entries — browsers pick the matching one based on the OS
  // colour scheme. Affects the address-bar tint on Android Chrome and the
  // PWA status bar on iOS standalone.
  themeColor:   [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)',  color: '#0d0d0d' },
  ],
  // Advertise both schemes so the browser knows we have a light style and
  // doesn't force the dark UA stylesheet on form controls when the OS is
  // in light mode.
  colorScheme:  'light dark',
  width:        'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Render under iOS notch / Android navigation bar so PWA feels full-bleed
  viewportFit:  'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* iOS PWA startup image. iOS Safari shows this while the app is
            launching from a Home Screen icon. A single fallback PNG is
            stretched/scaled to fit — proper per-device sizing is a follow-up. */}
        <link
          rel="apple-touch-startup-image"
          href="/icons/apple-splash.png"
        />
      </head>
      <body>
        {/* TranslationProvider wraps the whole app — hooks called from
            any component below have access to t() + setLocale. SSR-safe;
            first paint uses English, hydration swaps in the stored
            locale before any user input. */}
        <TranslationProvider>
          {children}
          <InstallPwa />
        </TranslationProvider>
      </body>
    </html>
  )
}
