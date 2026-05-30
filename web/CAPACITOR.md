# Capacitor — Otuburu native shells

This directory holds the Next.js web app (`src/`) plus a Capacitor config
(`capacitor.config.ts`) that wraps the same build into installable Android
(`.apk`) and iOS (`.ipa`) shells.

Bundle id: `money.torama.otuburu` — permanent across both stores. Don't
change after the first store submission.

## One-time setup

Run these once on your Mac, in `/Users/user1/TORAMA CLAUDE PROJECTS/TORAMA_BROKERAGE/otuburu_live/web/`:

```bash
# 1. Install Capacitor core + CLI + platform packages
npm install --save \
  @capacitor/core \
  @capacitor/android \
  @capacitor/ios \
  @capacitor/app \
  @capacitor/status-bar \
  @capacitor/splash-screen \
  @capacitor/preferences \
  @capacitor/browser \
  @capacitor/share

npm install --save-dev \
  @capacitor/cli \
  @capacitor/assets

# 2. Build the web app (static export → web/out)
npm run build

# 3. Generate all the platform icon + splash sizes from the SVG sources
npx @capacitor/assets generate --iconBackgroundColor '#0d0d0d' --splashBackgroundColor '#0d0d0d'

# 4. Add the Android platform — creates ./android/
npx cap add android

# 5. Add the iOS platform — creates ./ios/ (requires Xcode installed)
npx cap add ios

# 6. Sync the web build + plugin native code into both platforms
npx cap sync
```

After this you have:

- `web/android/` — full Gradle project, openable in Android Studio
- `web/ios/`     — full Xcode project, openable in Xcode

Both are committed to git so the same builds reproduce on CI.

## Day-to-day workflow

After editing any web code:

```bash
npm run build       # rebuild static export
npx cap copy        # copy web/out into both native projects
                    # (cap sync also re-runs plugin native code; usually
                    # not needed if you didn't change plugin versions)
```

Then open the native project in its IDE to run on a device or simulator:

```bash
npx cap open android   # Android Studio
npx cap open ios       # Xcode
```

## Building a release `.apk` for direct download

```bash
cd android
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release.apk
# Sign with your release keystore (see SIGNING.md — to be added)
```

Host the signed `.apk` at `otuburu.torama.money/download/android` and users
tap to install. Android shows a one-time "install from unknown source"
permission warning, then it's a normal app.

## Building a release `.ipa` for TestFlight / App Store

```bash
cd ios
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -archivePath build/Otuburu.xcarchive archive

xcodebuild -exportArchive -archivePath build/Otuburu.xcarchive \
  -exportPath build/Otuburu.ipa \
  -exportOptionsPlist ExportOptions.plist
```

Upload to App Store Connect via Xcode's Organizer or `xcrun altool`.
TestFlight propagates within ~30 minutes after Apple's automated checks.
Full App Store review takes 1-3 days.

## What the Capacitor config does

See `capacitor.config.ts` — comments explain each setting. Highlights:

- **Bundle id is permanent**. Same on Android (`applicationId` in Gradle)
  and iOS (`PRODUCT_BUNDLE_IDENTIFIER` in Xcode). Both inherited from
  `appId` in `capacitor.config.ts`.
- **Auth token moves to `@capacitor/preferences`** in native, falling back
  to `localStorage` in the web (the existing path). Preferences are
  keychain-backed on iOS and use EncryptedSharedPreferences on Android —
  more secure than a WebView's localStorage which can be inspected via
  remote debugging.
- **Hardware back button** — Android Capacitor exposes this as a JS event
  on `App.addListener('backButton', …)`. We register a handler in page.tsx
  that navigates tabs back before exiting the app, so back doesn't always
  drop the user to the home screen.
- **No cleartext HTTP** — `allowMixedContent: false` makes the WebView
  reject `http://` URLs. Catches accidental missed-`s` typos in API calls.
- **Splash screen** — dark canvas matching the app, no spinner. Auto-hides
  within ~1.5s of React mount; the `@capacitor/splash-screen` plugin's
  `hide()` is called from a `useEffect` in page.tsx on first paint.

## Store submission readiness checklist

Order roughly:

1. ✅ Bundle id chosen and committed (`money.torama.otuburu`)
2. ✅ App name chosen (`Otuburu`)
3. ✅ Icon source SVG (`resources/icon.svg`)
4. ✅ Splash source SVG (`resources/splash.svg`)
5. ⬜ Run `npx @capacitor/assets generate` to materialise all sizes
6. ⬜ Generate signing keystores (Android `.jks`, iOS distribution cert)
7. ⬜ Privacy manifest:
   - iOS: `ios/App/PrivacyInfo.xcprivacy` declaring our API usage
   - Google Play: Data Safety form (in Play Console at submission)
8. ⬜ Privacy policy URL — required for both stores. Publish a stub at
   `otuburu.torama.money/privacy` before first submission.
9. ⬜ App Store Connect listing: screenshots, description, support URL.
10. ⬜ Google Play Console listing: same, plus content rating questionnaire.
11. ⬜ Apple Developer account ($99/yr) for TestFlight + App Store
12. ⬜ Google Play Console account ($25 one-time)

Items 1–4 are committed in this repo. Items 5–6 are local one-time setup.
Items 7–12 are pre-submission paperwork that lives outside the repo.

## What lives in this repo vs what doesn't

- ✅ `capacitor.config.ts` — committed
- ✅ `resources/icon.svg`, `resources/splash.svg` — committed
- ✅ `android/`, `ios/` — committed after `cap add`
- ⬜ `android/app/release.keystore` — **NEVER committed**, store in 1Password
- ⬜ iOS provisioning profiles / certs — managed by Apple's Xcode integration

## When the web app changes, when the native rebuilds

Every web push goes through `cap sync` → new `.apk` and `.ipa`.

But the web code itself is hot-loaded via the WebView from the bundled
assets. So a Capacitor build is effectively "snapshot the web app at this
git SHA, package it into a native binary, sign it, distribute it". When
you publish a new app version, you're publishing a new web snapshot.

For TestFlight / App Store, propagating a new web release means submitting
a new build to the store. For your own download-from-website distribution
on Android, you can either submit a new `.apk` (users re-install) or run a
"check for update at boot" loop in JS that fetches the latest web bundle
from a CDN and hot-swaps it. We'd implement that as a follow-up if the
release cadence justifies it.
