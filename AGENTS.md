# Jansetu web

Customer app and staff workspace for the SwasthaDisha backend (`../SwasthaDisha`, routes under `/api/v1`).

Read before changing:
- [docs/PLAN.md](docs/PLAN.md): decisions, phases, open backend items, verification record.
- [docs/DESIGN.md](docs/DESIGN.md): screen and styling rules (before any UI change).

## Layout

```
packages/api        typed client; one module per backend area (auth.ts, pharmacyOrders.ts, ...)
packages/ui         tokens.css + small components (Button, TextField, Alert, Loading, Empty, ErrorState, ...)
apps/workspace      staff web app: src/modules.tsx declares every page and its roles; screens/<area>/*Screen.tsx
apps/customer       (W3) customer app, browser + Capacitor
```

## Rules

- All HTTP goes through `createApiClient` (`packages/api/src/client.ts`). Add endpoints as functions in a module of
  `packages/api`, typed from the backend's own types/validation in `../SwasthaDisha/src1/modules/<area>`. Cite the
  backend rule you mirror.
- The backend enforces access. A page is declared in `apps/workspace/src/modules.tsx` with its roles; anything not
  declared does not exist (deny by default). Hiding UI is never the security boundary.
- Tokens: memory only on the web; secure storage only on native. Never write a token, OTP or patient data to
  `localStorage`, `sessionStorage`, logs or URLs.
- No mock data in shipped code. Browser tests mock `/api/**` inside the test.
- Keep secrets, `.env` files, patient records and uploaded documents out of Git.

## Checks (report web and native/device checks separately)

```
npm run typecheck
npx vitest run
cd apps/workspace && npx playwright test
VITE_API_BASE_URL=https://<api-origin> npm run build --workspace apps/workspace   # for UI changes
```
