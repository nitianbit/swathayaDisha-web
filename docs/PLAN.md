# Jansetu web: plan

New customer app and staff workspace for the SwasthaDisha backend (`nitianbit/SwasthaDisha`, routes under
`/api/v1`). Web first: everything is a web app unless the web would clearly be worse, in which case the customer app
uses a Capacitor plugin for that one thing (the NIYA employee app model).

## Decisions (2026-11-14)

| Topic | Decision |
|---|---|
| Scope | Completely new apps. Existing references: `admin_panel_template` (live admin panel), `myewacare-mobile-app` (customer RN app), `pharmacy-app` (pharmacy RN app) and `NIYA_EMPLOYEE_APP` (web + Capacitor pattern). Nothing is copied wholesale. |
| Shape | One repo, npm workspaces: `packages/api` (typed client), `packages/ui` (tokens + small components), `apps/workspace` (staff, web only), `apps/customer` (browser + Capacitor iOS/Android). |
| Stack | Vite 8, React 19, TypeScript 6 strict, React Router 8 (hash routes: static hosting and Capacitor need no rewrites), TanStack Query 5, plain CSS tokens, lucide icons. Vitest + Playwright. |
| Staff | Admin and pharmacy staff use the web workspace (desk/counter). HR and doctors join when their modules exist. |
| Brand | Working name Jansetu (the roadmap's product name). The brand lives only in `packages/ui/src/tokens.css`. |
| Web session | Token in memory only; a reload signs out. Nothing about the session is stored in the browser. Native: secure storage (Keychain/Keystore). Cookie sessions are a later backend packet (W-auth). |
| Access | The backend enforces access. The UI declares every page with its roles and denies anything not declared. |

## Native only where the web is worse (customer app)

| Need | Approach |
|---|---|
| Token storage | `@aparajita/capacitor-secure-storage` on native; memory on web |
| Push notifications | `@capacitor/push-notifications` (FCM) on native; in-app list on web |
| App lock (PIN/biometric) | native plugin, native only |
| Prescription photo | `<input type="file" accept="image/*" capture>` (works on web and in the native shell) |
| PDFs and reports | blob download on web; `@capacitor/filesystem` + `file-viewer` on native |
| Payments | Razorpay Checkout.js (web and native web view) |
| Maps and location | Google Maps JS + browser geolocation |
| Dropped at first | voice search, root/jailbreak checks, over-the-air updates |

## Phases

1. **W1 foundations + first staff module (this packet).** Repo, API client, UI tokens, workspace login (OTP,
   admin/pharmacy), role-based navigation, pharmacist prescription review (P1), unit + browser tests.
2. **W2 staff screens for the backend packets on `stage`** (none had a UI):
   - Pharmacy: refunds for rejected orders (P2), refill orders and delivery exceptions (P7), low-stock list (P7c),
     quarantine/release and supplier returns (P3), recall worklist and customer returns (P3b).
   - Admin: prescription refunds needing attention (P2), external cancellations waiting for an admin (A2b
     `reconcile-cancellation`).
3. **W3 customer app core.** OTP login, profile and family, bookings (with the A1/A2 cancellation rules and the
   `cancellation_requested` state), lab tests/diagnostics, wallet, coupons, Razorpay, reports, notifications; English
   and Hindi; Capacitor shell.
4. **W4 pharmacy operations.** Medicines, inventory and Excel import, counter orders, customers, subscriptions;
   customer pharmacy ordering and refills.
5. **W5 admin migration.** Bring over the old admin panel's sections one by one (users, corporates, specialists,
   slots, coupons, content, reports), or keep the old panel for content work.

## Backend items found while planning

- **W1 backend (done, branch `m0/w1-rx-review-queue` on top of A2b):** `GET /pharmacy-orders/prescription-reviews`,
  the pharmacist work queue. It lists only orders the caller's pharmacy sells, whose prescription is pending, in the
  states the review accepts (`placed`, `accepted`), oldest first. The general order list could not express this
  (it mixes in orders the pharmacy buys and cancelled ones). Test: `test/pharmacy-prescription/p1-review.integration.ts`.
- **SECURITY, open: uploaded files are public.** The backend serves `GET /api/static/*` without authentication
  (`src1/routes/index.ts`), and uploads (prescriptions included) are stored as `/api/static/<module>/<id>/<name>`.
  Anyone who learns a URL can download the file. Needs its own backend packet: authenticate and authorize file
  reads, or move clinical files to the private asset routes. The workspace already reads files only through the
  authenticated `GET /file/fetch`.

- **W-auth:** no refresh or logout endpoint; web sessions end on reload until HttpOnly-cookie sessions exist.
- **CORS:** production `CORS_ORIGIN` must list the workspace origin and, for the native app, `capacitor://localhost`
  and `https://localhost`.
- The old customer app calls `/perks`, `/policies`, `/alyve/*` and `/deep-links/resolve`, which `src1` does not
  serve. Do not build on them until they exist.

## Verification record

| Date | Packet | Checks |
|---|---|---|
| 2026-11-14 | W1 (first cut) | typecheck clean; Vitest 10/10; Playwright 14/14; release build guards. Codex review: 6 findings (file URL shape, queue scope x2, late 401 across sign-ins, "opened" ≠ readable, body timeout). |
| 2026-11-14 | W1 (fixes) | typecheck clean; Vitest 16/16; Playwright 22/22 (desktop + tablet, mocked API, incl. corrupt image, download-only file, buyer/cancelled read-only, late 401 after re-sign-in); backend P1 integration 16/16 on the local replica set (new queue check). Not yet run against a real backend. |
