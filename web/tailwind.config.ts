import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0d0d0d',
        panel:   '#141414',
        border:  '#242424',
        muted:   '#3a3a3a',
        text:    '#f0f0f0',
        dim:     '#888888',
        up:      '#22c55e',   // green  — rise / long
        down:    '#ef4444',   // red    — fall / short
        brand:   '#EAB308',   // yellow — dominant brand accent
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
