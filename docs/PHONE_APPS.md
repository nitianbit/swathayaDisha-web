# Phone apps (N2) — SwasthayaDisha and SwasthayaDisha Workspace

Owner decision (15 Nov 2026): both apps, names and IDs below (the IDs can never change once published).

| App | Name | App ID (iOS bundle / Android package) | Folder |
|---|---|---|---|
| Customer | SwasthayaDisha | `com.swasthayadisha.app` | `apps/customer` (`android/`, `ios/`) |
| Staff | SwasthayaDisha Workspace | `com.swasthayadisha.workspace` | `apps/workspace` (`android/`, `ios/`) |

Capacitor 8 shells around the same web apps. Sign-in uses the N1 native session: the refresh token lives only in the OS
secure store (iOS Keychain, Android Keystore) through `@aparajita/capacitor-secure-storage`, set up by
`src/nativeShell.ts` before the app starts: never synced to iCloud, readable on this device only while unlocked
(`whenUnlockedThisDeviceOnly`), under the prefix `swasthayadisha_`. Android backups and device transfer are off
(`allowBackup=false`, `data_extraction_rules.xml`).

## Build

```sh
cd apps/customer            # or apps/workspace
VITE_API_BASE_URL=https://<api-origin> npx vite build
npx cap sync                # copies dist/ into the native projects
npx cap open android        # Android Studio (JDK 21: Android Studio's bundled JBR)
npx cap open ios            # Xcode (Swift Package Manager, no CocoaPods)
```

Command-line checks used here: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew
assembleDebug` in `android/`, and `xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS'
CODE_SIGNING_ALLOWED=NO build` in `ios/App/` — both succeed for both apps (15 Nov 2026). On this Mac the iOS Simulator
runtime is older than Xcode ("CoreSimulator is out of date"), so simulator runs need Xcode's component update first.

## Backend settings for the phone apps

- `CORS_ORIGIN` must list the WebView origins: `capacitor://localhost` (iOS) and `https://localhost` (Android).
- The apps sign in with `session: 'native'` (N1); nothing else changes on the server.

## Still needed from the owner before publishing

- App icons and splash screens (the projects carry Capacitor's defaults).
- Apple: a developer team for signing (set in Xcode), App Store Connect record for `com.swasthayadisha.app` /
  `.workspace`, privacy answers (phone number, health-related orders, payments).
- Google Play: an upload keystore (keep it outside Git), Play Console listing, data-safety form.
- Real-device testing: sign-in survives an app restart; sign-out clears it; Razorpay Checkout opens and returns; file
  downloads (prescriptions in the workspace) open.
