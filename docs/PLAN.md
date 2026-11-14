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
   - **W2a (built):** pharmacy orders list and order page: forward status moves with the backend's payment and
     prescription preconditions shown before the click, record payment (counter/COD), delivery exceptions (P7),
     refund status and retry (P2), customer returns (P3b): a submitted return is locked and resent unchanged until
     its outcome is known, survives leaving the page (session memory), and recorded returns are listed before
     another can start. No generic cancel/reject (see MONEY item).
   - **W2b (built):** Stock (search, batches with sellable/reserved units by the backend's rule, batch actions offered
     only in the states the backend accepts: quarantine, release with write-off, return to supplier, recall with
     immediate trace, recall trace), Low stock (P7c, refills due), Quality worklist (orders holding held stock: swap
     to good stock or cancel with refund; batches on hold; recent supplier returns).
   - **W2c (built):** admin: refunds needing attention (P2; retry waiting wallet credits, finance reviews shown as
     such) and external cancellations (A2b): a worklist from the new backend endpoint
     `GET /external-bookings/bookings/cancellations/attention` (branch `m0/w2c-admin-queues`) with every provider
     reference and its cancelled flag; the admin records "cancelled at the provider" or "no provider booking" (each
     offered only when it can apply), which releases the refund.
3. **W3 customer app core.** W3a (built, browser): phone OTP sign-in (account created on first code), home with
   profile-completion prompt and wallet balance, profile (an existing phone/email is shown read-only and never sent;
   a missing email can be added), family members, bookings (doctors/packages and lab tests from both providers, always
   paginated), booking detail with cancellation (paid bookings: IST 24 h / 48 h-Monday window shown before the tap,
   refund to wallet; lab tests: "cancelling" until the lab confirms), wallet history, sign out / sign out on all
   devices. Next: W3b booking flows (search, slots, payment with Razorpay), reports, Capacitor shell.
   Original scope: OTP login, profile and family, bookings (with the A1/A2 cancellation rules and the
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
- **MONEY, open: cancelling or rejecting a paid order does not refund it.** `POST /pharmacy-orders/:id/status`
  (`cancelled`/`rejected`, also `/cancel`) releases stock but never creates a refund (`updateStatus` in
  `pharmacyOrders/services`). Only delivery exceptions, stock-hold cancellation and prescription rejection refund.
  The status update also does not check payment atomically, so hiding the buttons for paid orders is not enough (a
  payment landing while staff confirm would be kept; Codex W2a #1). The workspace therefore offers no generic
  Cancel/Reject at all. Needs a backend packet: a fenced, refund-aware cancellation through the P2 refund ledger.
- **W2b backend (done, branch `m0/w2b-supplier-return-key` on top of W2c):** supplier returns accept an optional
  `requestKey`; a resent request is answered with the first record (unique partial index
  `{pharmacyId, requestKey}` on `pharmacy_supplier_returns`, created by `sync-indexes`). Test: P3 11/11.
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

## Backend branches this work depends on (local, not pushed)

Stacked on `m0/a2b-external-cancel` (284e24c), in the worktree `SwasthaDisha-worktrees/w1-rx-review-queue`:

| Branch | Head | Adds | Deploy note |
|---|---|---|---|
| `m0/w1-rx-review-queue` | f1fbec5 | `GET /pharmacy-orders/prescription-reviews` | none |
| `m0/w2c-admin-queues` | 815f93e | `GET /external-bookings/bookings/cancellations/attention` | none |
| `m0/w2b-supplier-return-key` | 00554f2 | supplier-return `requestKey` replay | `sync-indexes`: unique partial `{pharmacyId, requestKey}` on `pharmacy_supplier_returns` |
| `m0/w2c-obligation-fence` | 7eb93c8 | obligation fingerprint; `GET /external-bookings/bookings/:id/obligations`; `POST .../reconcile-cancellation` now REQUIRES `expectedObligations` | any caller of reconcile-cancellation must send the reviewed fingerprint (only the new workspace calls it) |

`m0/w2c-obligation-fence` contains all four. To release, merge it instead of `m0/a2b-external-cancel` in the backend merge plan.

## Follow-ups

- Workspace screen for paid bookings with an unknown provider attempt that are not being cancelled (backend snapshot exists; a list endpoint for them does not).
- Backend MONEY: fenced, refund-aware order cancellation (then re-enable Cancel/Reject in the workspace).
- Backend SECURITY: authenticate `/api/static/*` uploads.

## Verification record

| Date | Packet | Checks |
|---|---|---|
| 2026-11-14 | W1 (first cut) | typecheck clean; Vitest 10/10; Playwright 14/14; release build guards. Codex review: 6 findings (file URL shape, queue scope x2, late 401 across sign-ins, "opened" ≠ readable, body timeout). |
| 2026-11-14 | W1 (fixes) | typecheck clean; Vitest 16/16; Playwright 22/22 (desktop + tablet, mocked API, incl. corrupt image, download-only file, buyer/cancelled read-only, late 401 after re-sign-in); backend P1 integration 16/16 on the local replica set (new queue check). Not yet run against a real backend. |
| 2026-11-14 | W3a | customer app: typecheck clean; Vitest 34/34 (+ cancellation-window mirror incl. IST and Monday 48 h); Playwright customer 16/16 (desktop + Pixel 7, mocked API); release build refuses non-HTTPS and pins connect-src. Workspace 82/82 unchanged. |
| 2026-11-14 | W2c approved | Codex approved W2c (frontend dc1543d; backend c82c2ff + 7eb93c8: obligation fingerprint and per-booking admin snapshot). W1, W2a, W2b, W2c all approved at their pins (review approval only; nothing pushed or deployed). |
| 2026-11-14 | W2c fix | Codex W2c: HIGH stale provider attestation. Backend c82c2ff (branch m0/w2c-obligation-fence): obligation fingerprint per worklist row, required by reconcile-cancellation and checked in the fenced transaction (409 EXTERNAL_OBLIGATIONS_CHANGED); A2b 18/18. Frontend: sends the reviewed fingerprint, cards keyed by it, a refused stale confirmation locks the card until the admin re-checks. Playwright 82/82. |
| 2026-11-14 | W2a, W2b approved | Codex approved W2a (frontend 904cc4d) and W2b (frontend 904cc4d, backend 00554f2). |
| 2026-11-14 | W2a re-review #3 fix | Codex: previous 2 closed; 1 new (a late success of an older return cleared a newer pending one). Fixed: success and found-record clear only the same request key. Vitest 32/32; Playwright 80/80 (+ overlapping mounts: old K1 answer after K2 started, K2 survives). Backend W2b replay fix 00554f2 (concurrent same-key returns both get the receipt). |
| 2026-11-14 | W2a re-review #2 fixes | Codex: per-session memory and history paging closed; 2 new (discard on non-authoritative absence; restored in-flight first attempt). Fixed: no "not recorded"/discard path at all (resend with the same key is the only way forward; lookup only finds receipts and is reset per attempt); attempts are numbered and stored before sending, only a sole first attempt's refusal unlocks, older answers never overwrite newer attempts. Vitest 31/31; Playwright 78/78. |
| 2026-11-14 | W2a re-review fixes | Codex: 1 closed (HIGH), 3 new (refused retry treated as proof; ended-session memory write; history limited to 50). Fixed: pending operations end only on success or a refused FIRST attempt; otherwise resend unchanged or find the key in the records, discard only when absent after 2 min; memory bound per session; history paging. Same rules for supplier returns. Vitest 30/30; Playwright 76/76. |
| 2026-11-14 | W2b fixes | Codex W2b: 3 findings (supplier DTO shape, refill count shape, non-repeatable supplier return). Fixed: real SupplierDto/number shapes; supplier returns carry a request key (backend replay) and lock to an identical resend until the outcome is known (session memory). Vitest 25/25; Playwright 66/66; backend P3 11/11, P3b 13/13. |
| 2026-11-14 | W2a fixes | Codex W2a: 3 findings (paid-cancel race; edited retry under one key; key lost on leaving). Fixed on top of W2c. Vitest 25/25; Playwright 62/62 (+ committed-then-lost return: locked, identical resend, canonical receipt; survives navigation; listed after reload; definite refusal unlocks with a new key; no generic cancel/reject). |
| 2026-11-14 | W1 approved | Codex approved the W1 fixes (43ab156, backend f1fbec5). |
| 2026-11-14 | W2c | typecheck clean; Vitest 24/24; Playwright 58/58 (+ 4 admin journeys x 2 devices); backend A2b integration 18/18 (+ worklist check: scopes, order, pagination, refs/acked flags, no private fields, admin-only route, query validation). |
| 2026-11-14 | W2b | typecheck clean; Vitest 24/24 (+ sellable rule, expiry format); Playwright 50/50 (+ 6 stock journeys x 2 devices: actions per batch state, quarantine/release validation, supplier return validation, recall with trace, low stock, held-order swap/cancel incl. a non-swappable order). |
| 2026-11-14 | W2a | typecheck clean; Vitest 22/22 (+ status preconditions, rupee parsing, request keys); Playwright 38/38 (+ 8 order journeys x 2 devices: full delivery flow incl. failed/retried delivery, unpaid cannot pack, paid cannot be cancelled, reject with confirmation, COD payment then complete, refund retry, customer return retried after a lost answer sends the same key, buying order read-only). |
