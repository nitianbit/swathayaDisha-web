import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Customer app (browser now; Capacitor shell later). `VITE_API_BASE_URL` is the backend origin (no path); it must be HTTPS except for local
 * development. In development, leave it empty: the dev server proxies `/api` to the local backend (port 4031).
 * A Content-Security-Policy meta tag is injected so the page can only talk to that origin.
 */
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiBase = env.VITE_API_BASE_URL?.trim() || '';
  const development = command === 'serve' || mode === 'development' || mode === 'test';
  let apiOrigin = '';
  if (apiBase) {
    const url = new URL(apiBase);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('VITE_API_BASE_URL must be an origin without credentials or a path.');
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) {
      throw new Error('VITE_API_BASE_URL must use HTTPS outside local development.');
    }
    apiOrigin = url.origin;
  } else if (!development && env.VITE_API_SAME_ORIGIN !== 'true') {
    // D4: cookie sessions need the API on this app's own host (the host forwards /api to the backend); say so
    // explicitly with VITE_API_SAME_ORIGIN=true. Otherwise name the HTTPS backend origin (bearer-only, no reload).
    throw new Error('Set VITE_API_SAME_ORIGIN=true (this host forwards /api) or VITE_API_BASE_URL to the HTTPS backend origin before building for release.');
  }
  const connect = ["'self'", apiOrigin, ...(command === 'serve' ? ['ws://127.0.0.1:*', 'ws://localhost:*'] : [])]
    .filter(Boolean).join(' ');
  const policy = [
    "default-src 'self'",
    // Razorpay Checkout: its script, and its payment page in a frame (the only third parties).
    `script-src 'self' https://checkout.razorpay.com${command === 'serve' ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Prescription files are fetched with the token and shown from blob: URLs.
    "img-src 'self' data: blob:",
    "frame-src blob: https://api.razorpay.com https://checkout.razorpay.com",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    base: './',
    plugins: [react(), {
      name: 'jansetu-customer-csp',
      transformIndexHtml() {
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }];
      },
    }],
    server: {
      host: '127.0.0.1', port: 5175, strictPort: true,
      proxy: { '/api': { target: env.VITE_DEV_BACKEND || 'http://localhost:4031', changeOrigin: true } },
      headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
    },
  };
});
