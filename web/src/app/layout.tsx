import type { Metadata, Viewport } from 'next'
import './globals.css'
import InstallPwa from '@/components/InstallPwa'

export const metadata: Metadata = {
  title:       'Otuburu · Fractional Trading',
  description: 'Real markets, fractional access. Trade BTC, ETH, gold, silver, ' +
               'S&P 500, Dow, Nasdaq for as little as $1.',
  applicationName: 'Otuburu',
  manifest:    '/manifest.webmanifest',
  icons: {
    // Browser tab icons. SVG is the modern primary; .webp variants are the
    // raster fallback for ancient browsers that ignore SVG favicons.
    // (@capacitor/assets generates webp only — generate PNG/apple-touch
    // variants when we set up a proper iOS icon set; without them iOS
    // home-screen install falls back to a screenshot of the page, which
    // is ugly but not broken.)
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.webp', sizes: '192x192', type: 'image/webp' },
      { url: '/icons/icon-512.webp', sizes: '512x512', type: 'image/webp' },
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
        {children}
        <InstallPwa />
      </body>
    </html>
  )
}
