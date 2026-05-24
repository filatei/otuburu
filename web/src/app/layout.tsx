import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title:       'Otuburu · Synthetic Trading',
  description: 'Synthetic brokerage — Boom/Crash, FX, Crypto',
  icons: {
    icon:     '/favicon.svg',
    shortcut: '/favicon.svg',
    apple:    '/favicon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      </head>
      <body>{children}</body>
    </html>
  )
}
