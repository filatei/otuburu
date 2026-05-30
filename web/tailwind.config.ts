import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // All colour tokens reference CSS variables defined in globals.css so
      // the same Tailwind classes (bg-panel, text-text, etc.) automatically
      // pick up the light/dark palette via @media (prefers-color-scheme).
      // No theme switcher logic needed — the OS preference drives it.
      colors: {
        surface: 'var(--c-surface)',
        panel:   'var(--c-panel)',
        border:  'var(--c-border)',
        muted:   'var(--c-muted)',
        text:    'var(--c-text)',
        dim:     'var(--c-dim)',
        up:      'var(--c-up)',      // rise / long
        down:    'var(--c-down)',    // fall / short
        brand:   'var(--c-brand)',   // dominant brand accent
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
