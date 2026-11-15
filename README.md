# Jansetu web

Staff workspace (and, next, the customer app) for the SwasthaDisha backend.

## Run the workspace locally

1. Start the backend (`../SwasthaDisha`, port 4031 by default).
2. `npm install`
3. `npm run dev:workspace` and open http://127.0.0.1:5174. The dev server proxies `/api` to
   `http://localhost:4031`; set `VITE_DEV_BACKEND` to use another backend.

## Release build

```
VITE_API_BASE_URL=https://<api-origin> npm run build --workspace apps/workspace
```

The build refuses a missing or non-HTTPS origin. Add the workspace's origin to the backend's `CORS_ORIGIN`.

**Recommended (D4, sessions survive a reload):** serve each app from its own HTTPS host and forward `/api/*` from that
host to the backend, then build with `VITE_API_SAME_ORIGIN=true` (no `VITE_API_BASE_URL`), and set the backend's
`SESSION_ORIGINS_WORKSPACE` / `SESSION_ORIGINS_CUSTOMER` to the apps' exact origins. A build with `VITE_API_BASE_URL` (separate API origin)
keeps the older memory-only bearer session: it works, but a reload signs the user out.

**Phone apps (N1):** when packaged with Capacitor, the shell must expose the OS secure store (iOS Keychain / Android
Keystore, e.g. through a secure-storage plugin) to the web app before it starts:

```js
window.JansetuNative = { secureStore: { get: async (key) => …, set: async (key, value) => …, remove: async (key) => … } };
```

With it, both apps use native sessions automatically (`session: 'native'` sign-in, refresh token kept only in that store,
`/auth/session/native/refresh|logout`), whatever `VITE_API_BASE_URL` says; build with `VITE_API_BASE_URL` set to the HTTPS
backend and add the WebView origins (`capacitor://localhost`, `https://localhost`) to the backend's `CORS_ORIGIN`. Without
it (a browser) nothing changes.

The phone apps (SwasthayaDisha, SwasthayaDisha Workspace) are in `apps/*/android` and `apps/*/ios`: see
[docs/PHONE_APPS.md](docs/PHONE_APPS.md).

See [AGENTS.md](AGENTS.md) for the rules and checks, and [docs/PLAN.md](docs/PLAN.md) for the plan.
