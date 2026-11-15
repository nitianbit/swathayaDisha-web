import type { CapacitorConfig } from '@capacitor/cli';

/**
 * N2: the SwasthayaDisha phone app. Build the web app first with `VITE_API_BASE_URL` set to the HTTPS backend origin
 * (native sessions; the backend's CORS_ORIGIN must list capacitor://localhost and https://localhost), then
 * `npx cap sync`. See docs/PHONE_APPS.md.
 */
const config: CapacitorConfig = {
  appId: 'com.swasthayadisha.app',
  appName: 'SwasthayaDisha',
  webDir: 'dist',
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: 'automatic', limitsNavigationsToAppBoundDomains: false },
};

export default config;
