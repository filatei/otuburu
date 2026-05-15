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
        text:    '#e0e0e0',
        dim:     '#888888',
        up:      '#4bb4b4',
        down:    '#cc2e3d',
        brand:   '#D97706',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
