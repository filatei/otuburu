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
  themeColor:   '#0d0d0d',
  colorScheme:  'dark',
  width:        'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Render under iOS notch / Android navigation bar so PWA feels full-bleed
  viewportFit:  'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <InstallPwa />
      </body>
    </html>
  )
}
