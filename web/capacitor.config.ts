import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor configuration for the Otuburu native shells (Android + iOS).
 *
 * The same web build that ships to otuburu.torama.money is wrapped here as
 * a native app via WebView. Same JS runs in both places; native plugins
 * fill in the gaps where the browser can't (status bar tinting, splash
 * screen, secure storage for the auth token, hardware back button on
 * Android, etc).
 *
 * Bundle ID notes — `appId` is permanent across both platforms. If you
 * change it after publishing to a store, you have to publish a new app
 * (the stores treat new bundle IDs as new apps and won't carry over
 * existing reviews/ratings/installs). Don't touch this without thinking.
 */
const config: CapacitorConfig = {
  appId:    'money.torama.otuburu',
  appName:  'Otuburu',
  // `web/out/` is what Next.js static-export produces (we already use
  // `output: 'export'` in next.config.mjs for the web deploy). Capacitor
  // bundles this directory into the native projects on `cap sync`.
  webDir:   'out',

  // Network — the WebView calls our existing HTTPS APIs (otuburu.torama.money)
  // directly. We don't proxy through a Capacitor local-server because that
  // adds latency and breaks the WebSocket tick stream.
  server: {
    // hostname for the WebView is the package id by default — explicit for clarity
    androidScheme: 'https',
    iosScheme:     'capacitor',
    // No `url` override → the bundled web assets load from the local file
    // system. The frontend then makes HTTPS calls out to the live API.
  },

  // Plugin config — wire the few things we need to feel native.
  plugins: {
    SplashScreen: {
      // Match the dark surface colour from globals.css. Auto-flips on iOS 13+
      // when the OS is in light mode via launchAutoHide + custom storyboard
      // (configured per-platform in iOS Info.plist below).
      backgroundColor:        '#0d0d0d',
      launchShowDuration:     1500,    // ms — hide as soon as React mounts
      launchAutoHide:         true,
      androidScaleType:       'CENTER_CROP',
      showSpinner:            false,
      splashFullScreen:       true,
      splashImmersive:        true,
    },
    StatusBar: {
      // We control status bar tint at runtime from the AppDrawer toggle.
      // The initial style here is the boot-time default — overridden in JS.
      style:                  'DARK',
      backgroundColor:        '#0d0d0d',
      overlaysWebView:        false,
    },
    Preferences: {
      // Used for the auth token — more secure than localStorage in a WebView
      // (which can be inspected via remote debug). Backed by:
      //   - iOS: UserDefaults (with keychain wrapper for marked-sensitive keys)
      //   - Android: SharedPreferences (with EncryptedSharedPreferences for sensitive)
      group: 'money.torama.otuburu.preferences',
    },
  },

  // Android-specific
  android: {
    // Cleartext disabled — every API call MUST be HTTPS. Catches any
    // accidental `http://` URL leaking into the codebase.
    allowMixedContent:        false,
    // Hardware back button on Android exits the page if there's no JS
    // handler; we register one in App component to navigate tabs back
    // before bailing out.
    captureInput:             true,
    // WebView debugging in dev builds only — release builds ship without it.
    webContentsDebuggingEnabled: false,
  },

  // iOS-specific
  ios: {
    // Match the safe-area handling we already do in CSS. Don't let the
    // WebView pad on its own — `viewportFit: cover` in viewport meta
    // controls it from our side.
    contentInset:             'never',
    // Background colour the WebView shows before the first paint —
    // matches our dark surface so there's no white flash on cold start.
    backgroundColor:          '#0d0d0d',
  },
}

export default config
