import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title:       'Otuburu · Synthetic Trading',
  description: 'Synthetic brokerage — Boom/Crash, FX, Crypto',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
