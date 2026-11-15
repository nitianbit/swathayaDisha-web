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
| Web session | D4 (2026-11-15): access token in memory (15 min); the session is an HttpOnly, first-party `__Host-` cookie the server rotates, so a reload keeps people signed in. Sign-in / refresh / sign-out run under one cross-tab lock; tabs announce identity changes; a renewed token is installed only for the same person. Nothing readable about the session is stored in the browser (only body-less reload markers of unconfirmed once-only requests, in sessionStorage). Native: secure storage (Keychain/Keystore), protocol specified in the backend D4 design. |
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
   devices. W3b (built, approved): book and pay for a doctor consultation (search, 14-day slots, for self or family,
   mode, concern, coupon, wallet; Razorpay Checkout; verify with server-side gateway check as fallback; a keyed,
   resumable create; "Pay now" reuses the open order; booking page checks every payment attempt). Next: lab tests and
   health packages booking, reports, Capacitor shell.
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

- **W-auth:** done as D4 (backend `m0/d4-cookie-sessions`): cookie sessions, refresh, logout, immediate revocation.
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
| `m0/w3b-booking-safety` | 5e94bb7 | booking-level payment reconcile, open-order reuse, recovery sweep (scheduler), keyed create with stored terms, free bookings inserted unpaid | `sync-indexes`: `{userId, createRequestKey}` unique partial on `bookings`; `{context, status, recoveryNextAt, createdAt}` on `paymentrecords` |
| `m0/w3b-payment-reconcile` | bc855da | `POST /payments/reconcile` (settle a captured payment whose verify never arrived) | none |
| `m0/w2c-obligation-fence` | 7eb93c8 | obligation fingerprint; `GET /external-bookings/bookings/:id/obligations`; `POST .../reconcile-cancellation` now REQUIRES `expectedObligations` | any caller of reconcile-cancellation must send the reviewed fingerprint (only the new workspace calls it) |

`m0/w3b-booking-safety` contains all of them (top of the stack). To release, merge it instead of `m0/a2b-external-cancel` in the backend merge plan.

## Owner decisions (2026-11-14, second round)

Build in this order (money/security first):
1. **Lock `/api/static/*`.** Uploaded files need a login; clients read them through the authenticated file route.
2. **Unpaid doctor/package bookings expire after 30 minutes**: the payment is first checked with Razorpay, then the
   booking is cancelled and the slot and wallet money released (like external bookings).
3. **Paid pharmacy order cancel → `pending_cancel`**, approved by a platform admin or by the pharmacy (until staff/owner
   roles exist inside a pharmacy, the pharmacy account can approve its own request; both steps are recorded). On
   approval the customer is refunded as for rejected prescriptions (P2): wallet first, then card/UPI if the customer asks.
4. **Cookie sessions**: an HttpOnly session cookie with a refresh endpoint, so a reload keeps staff and customers signed in.

## D4 decisions (2026-11-15, taken autonomously at the owner's request)

- **Hosting**: each web app's own HTTPS host forwards `/api/*` to the backend (as the dev servers do). Release builds:
  `VITE_API_SAME_ORIGIN=true` (no `VITE_API_BASE_URL`). Backend: `SESSION_ORIGINS_CUSTOMER` / `SESSION_ORIGINS_WORKSPACE`
  list each app's exact origin. A frontend on another site keeps bearer-only (no reload survival).
- **Lifetimes**: customers stay signed in up to 30 days (14 days idle); staff up to 7 days (12 hours idle).
- **Strict rotation**: two tabs presenting the same old cookie end the session (the cross-tab lock prevents it in
  normal use); a refresh answer lost on the network means signing in again.
- **Reload or sign-out during an unconfirmed once-only request** (customer return, supplier return, booking): the same
  person sees a check-only panel; a new request is allowed only once the old key is found, or cancelled on the server
  (`POST /request-keys/abandon`: from then on that request can never be recorded). No time-based guess.

## Remaining items (2026-11-15, taken autonomously at the owner's request)

- **O1 OTP limits** (backend `m0/o1-otp-limits`): 5 checks per code; per phone/email 1 code / 30 s, 5 / hour, 10 / day and
  10 checks / hour, 20 / day, shared by every account, role and purpose; codes stored as HMACs. Sign-in screens show the
  server's wait (`Retry-After`, or the body when cross-origin) per number, and clear a burnt code.
- **Admin order-cancellation queue** (`/admin/order-cancellations`): paid pharmacy orders waiting for a decision;
  approve or keep, naming the request on screen.
- **Customer medicine ordering** (Medicines tab): pharmacies, stock (every page; only active, priced, sellable stock),
  a one-pharmacy cart (one change at a time), pickup/delivery from the pharmacy's options, pay online or at the
  pharmacy/on delivery, orders, D3 cancellation, wallet refund → card/UPI. Known backend limits: prescription medicines
  can't be ordered online yet (blocked with an explanation); no "pay again" endpoint for a pharmacy order (after leaving
  the app: check payment, or cancel and re-order); no idempotency on checkout (the app never retries it on its own).
- **N1 phone sessions** (backend `m0/n1-native-sessions`): inside the Capacitor shell (`window.JansetuNative.secureStore`)
  the apps keep the refresh token only in the OS secure store; customers stay signed in up to 90 days (30 idle); a lost
  refresh answer can be retried within 30 s. Sign-out records its intent first and never resumes until the stored
  token is gone (a plain flag in web storage, no token).
- **S1 SECURITY (live on main)**: customers could list other customers' pharmacy orders with `?userId=`. Fixed on the
  release stack and on `hotfix/s1-pharmacy-orders-customer-scope` (from backend `main`) — ship it first.

## WQ1 partner workspace foundation (2026-11-15, taken autonomously at the owner's request)

Backend: Q1 partners + Q7 partner sign-in (`SwasthaDisha-worktrees/q7-partner-signin`, `src1/modules/partners`, `auth`).

- **Sign-in**: "Lab or clinic staff" on the workspace login (`/auth/partner/*`). A phone with several active memberships
  gets a choice (name, Lab/Clinic, single-doctor practice, Owner/Staff); `POST /auth/partner/select` completes it in the
  same session mode as the verify (cookie, native with `previousRefreshToken`, or bearer). The one-use ticket lives only
  in the login screen's memory; a `SELECTION_EXPIRED` answer sends the person back to request a new code. Nothing is
  stored before the chosen session exists (native: only the select's refresh token reaches the secure store).
- **Who is signed in**: `/auth/profile` gives the member (role, permissions, branchIds, name) and the partner (name,
  kind, solo, verification). Shown as the member's name and "Lab"/"Clinic" · partner name. Home warns when the partner is
  not verified (every workspace route then answers 403 `PARTNER_NOT_VERIFIED`, shown as the server says).
- **Pages**: `WorkspacePage` gained `partnerPermissions` (any-of, owners hold all), `partnerKinds` and `partnerWide`;
  nav and routes are filtered by them (deny by default). Partner: `/partner` (profile), `/partner/staff`
  (`staff.manage`), `/partner/branches` (`branches.manage`), `/partner/audit` (`staff.manage` + partner-wide scope).
  Admin: `/admin/partners` (filters from `partnerQuerySchema`, verify, suspend), `/admin/partners/new`,
  `/admin/partners/:id` (details, tax and invoicing via `PUT /admin/:id`, "Manage as owner" links), and the same four
  partner screens under `/admin/partners/:id/{profile,staff,branches,audit}` using
  `/partner-workspace/admin/:id/workspace/*`. One set of screens; the route picks the scope (`screens/partner/scope.tsx`).
- **Rules mirrored in the UI** (`packages/api/src/partners.ts`, from `partners/services`): only owners add owners and
  edit permissions (owners' permissions are fixed); staff grant only permissions they hold and only a non-empty subset
  of their own branches; nobody removes themselves; the last owner cannot be removed; branch-limited staff cannot add
  branches or read the activity log. Admins act as an owner with every permission and branch. Server messages are shown.
- **Edits send only changed fields** (profile, tax, branches): the schemas cannot clear a field, so emptying a set field
  is refused inline; a branch's holidays/services are sent only when changed (they reshape its slots on the server).
- **Irreversible steps confirm first**: remove member, deactivate branch, verify, suspend.
- Not built: logo upload (`logo` is a stored path; no upload flow yet), branch `geo`, editing a member's branch scope
  (no endpoint).

Backend gaps found (not changed here):
- `PUT /partner-workspace/me` needs no permission: any member, even one with none, can change the partner's name and
  contact details. Probably should be owner-only (or a `profile.manage` permission).
- No endpoint changes a member's branch scope, reactivates a deactivated branch, or reinstates a suspended partner
  (`verifyPartner` accepts only `pending`).
- `GET /branches` needs `branches.manage`, so a member with only `staff.manage` cannot see branch names when giving
  branch access (the screen offers "all branches", or the actor's own branch ids).
- Admin partner create is not idempotent (a lost answer, resent, makes a second partner); the list is unpaginated.
- A pending partner's members can sign in but every workspace route is refused until verification.

## WQ2 partner catalogue and in-house bills (2026-11-15, taken autonomously at the owner's request)

Backend: Q2 catalogue + invoices on Q8 (`SwasthaDisha-worktrees/q8-partner-admin`, `src1/modules/partners`
`{validation,services,controller}/{catalogue,invoice}.ts`). API module `packages/api/src/partnerInvoices.ts`.

- **Pages** (deny by default, `modules.tsx`): `/partner/catalogue` "Price list" (`catalogue.manage` or `invoices.create`;
  only `catalogue.manage` adds, edits, deactivates), `/partner/invoices` "Bills", `/partner/invoices/:id` (any of
  `invoices.create`, `invoices.cancel`, `payments.record`, `finance.view`; pay needs `payments.record`, cancel
  `invoices.cancel`), `/partner/invoices/new` (`invoices.create`). The same screens under `/admin/partners/:id/...` use the
  admin workspace routes; the admin's price list adds Disable/Enable (`/partner-workspace/admin/catalogue/:id/...`).
- **Money is integer paise end to end.** Rupees typed by staff become paise by string arithmetic (`rupeesToPaise`: "0.29"
  is 29, never 28.999…); shown with `formatRupees(paise / 100)`.
- **Live preview = the server's rules** (`previewInvoice` mirrors `computeLines`, `computeTotals`, `classifyDocument`,
  `assertTaxConsistent`, `assertRegistrationCovers`): line amount = price × qty − discount; tax rounded per line;
  totals are sums of rounded lines; the odd paisa of CGST/SGST goes to SGST; IGST only when a customer state is given and
  differs from the branch's. Bill type shown before issuing (tax invoice / bill of supply / invoice without GST). The
  server's numbers are final.
- **GST only where the supplier can charge it**: regular regime with a GSTIN offers 0/5/12/18/28; anyone else only 0%.
  A catalogue item with another rate stays as it is (flagged "Cannot be billed") and is refused on a bill before sending.
- **Catalogue lines** keep the catalogue's name, price and GST (only quantity and discount change); hand-written lines are
  free. Only offered items (active, not disabled by Jansetu) can be picked. Clinics name a doctor from their active
  doctors at the chosen branch (`GET /clinic/doctors`).
- **Once-only issue**: the request key goes in the BODY (`idempotencyKey`; the route reads no header). A submitted bill
  is kept in session memory (body in memory only; the reload marker holds just the key and attempt times). An unknown
  outcome locks it: resend unchanged (the server answers the same key + same request with the bill already issued) or
  look for it in the list by key. Only a refusal of a sole first attempt unlocks the form (also the 503
  `CUSTOMER_LINKING_UNAVAILABLE`, raised before anything is written); a changed bill gets a new key. After a reload the
  marker can only be checked; with no server way to abandon a bill's key, starting again is a decision with a warning
  (a duplicate must then be cancelled).
- **Linked customer**: a phone number links the bill to that number's customer account (created if none; an SMS may be
  sent; existing details never changed); said before issuing and shown on the bill.
- **Confirm first**: issuing a bill, recording a payment (it cannot be removed), cancelling (reason; "cancelled for good,
  number not reused, the recorded payment stays"), deactivating an item, admin disable.
- **PDF** read with the session token into a blob (content checked to be a PDF), shown in a frame and saved under the
  server's file name; current version, and "as issued" (version 0) once the bill has events. No token or file link in a URL.
- Q8 lets every member read branches: WQ1's `branches.manage` gate on `GET /branches` is removed (staff screen too).

Backend gaps found (not changed here):
- The bills list `before` loses its milliseconds (Joi turns it into a Date and the controller re-parses `String(date)`)
  and the cursor is `issuedAt` alone. The workspace pages from the next whole second and drops repeats by id; more than
  50 bills in one second cannot be paged past. No "from" date, search, or count either. A `(issuedAt, _id)` cursor would fix it.
- No request-key kind for partner bills in `POST /request-keys/abandon`, and no lookup by key: after a reload an
  unconfirmed bill can only be searched for in the list.
- `POST /invoices/:id/pay` takes no request key and no amount (always the full total; no part payments); a repeat is
  refused 409 "This bill is paid" (the page then shows the bill as it is).
- The catalogue accepts GST rates the partner cannot bill (create/update do not look at the tax regime).
- The catalogue lists only active items: a deactivated item cannot be listed or reactivated. No server-side search.
- The catalogue is lab-shaped for clinics too (`test`/`package`, visit modes `home`/`lab` required).
- A bill line with a `catalogItemId` may carry any price (the catalogue price is not enforced); the doctor named on a
  clinic bill must only be an active member with a doctor id (branch and doctor status are not checked).
- Cancelling a paid bill records nothing about returning the money.

## Follow-ups

- Backend: the booking-payment recovery scheduler runs every 5 minutes in each app instance (fenced, idempotent).
- Backend: unpaid internal (doctor/package) bookings expire after 30 minutes (decision 2): backend branch
  `m0/d2-booking-payment-timeout` (on top of `m0/w3b-booking-safety`). The sweep checks Razorpay first, backs off while
  the gateway cannot answer, and never expires free bookings; `retry-payment` answers 409 `BOOKING_PAYMENT_EXPIRED`
  after the window. Customer app (branch `d2/payment-expiry`): "pay by" time, Expired status, the 409 handled.
- Workspace screen for paid bookings with an unknown provider attempt that are not being cancelled (backend snapshot exists; a list endpoint for them does not).
- Workspace: D3 cancellation built (order screen: Cancel order → immediate for unpaid / request for paid; Cancellation
  requested panel → approve (wallet-first refund; cash/counter → admin arranges) or keep (reason; refused once the payment
  was returned); the orders filter lists "Cancellation requested"). Still to do: an admin view of cancellation requests
  (done: `/admin/order-cancellations`) and the customer app's pharmacy orders (done: Medicines tab).
- Backend: a customer "pay again" endpoint and checkout idempotency for pharmacy orders; prescription upload/binding for
  online Rx orders.
- The Capacitor shell itself (iOS/Android projects and the secure-storage bridge) is not built yet.

## Verification record

| Date | Packet | Checks |
|---|---|---|
| 2026-11-14 | W1 (first cut) | typecheck clean; Vitest 10/10; Playwright 14/14; release build guards. Codex review: 6 findings (file URL shape, queue scope x2, late 401 across sign-ins, "opened" ≠ readable, body timeout). |
| 2026-11-14 | W1 (fixes) | typecheck clean; Vitest 16/16; Playwright 22/22 (desktop + tablet, mocked API, incl. corrupt image, download-only file, buyer/cancelled read-only, late 401 after re-sign-in); backend P1 integration 16/16 on the local replica set (new queue check). Not yet run against a real backend. |
| 2026-11-14 | W3b approved | Codex approved W3b after 3 re-reviews: backend 5e94bb7 (booking-level reconcile, open-order reuse, fair 5-minute recovery sweep, keyed create with stored validated terms, free bookings inserted unpaid — closes C7b), frontend 8963313. Final: backend w3b-reconcile 17/17, retry-integrity 26/26, A2a 14/14, A2b 18/18, A1 12/12; customer Vitest 37/37, Playwright 46/46. Real hosted Checkout, CSP and devices not yet exercised. |
| 2026-11-14 | W3b-pay approved | Codex approved backend payment reconciliation (41e2081 + bc855da): w3b-reconcile 7/7, retry-integrity 26/26, A2b 18/18, A2a 14/14. |
| 2026-11-14 | W3a approved | Codex approved W3a at 17f491d (customer app core). |
| 2026-11-14 | W3a fixes | Codex W3a: 3 findings (unpaid exemption after time checks; lists capped at 100; family paged before filtering archived). Fixed: unpaid bookings skip every time check (as the backend); wallet, bookings (per provider) and family read real successive pages to the reported total; family asks the server for active members. Vitest 35/35; Playwright customer 24/24. |
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
| 2026-11-14 | D2 (customer) | typecheck clean; Vitest 37/37; Playwright customer 50/50 (new: Pay now after the window → 409, no new order, booking still pending and checked every minute; then either a late capture confirms it or the sweep shows Expired in booking and list), workspace 82/82. Backend D2 integration 8/8. |
| 2026-11-14 | D2 approved | Codex approved D2: backend `m0/d2-booking-payment-timeout` c6d8fda (after 1 re-review: free bookings exempt from the deadline on resume; counted back-off) and customer app 3f98b03 (after 1 re-review: a 409 after the window is not treated as cancellation; the panel keeps checking until the server's final state). |
| 2026-11-15 | D4 (web, rev 2) | Abandon-based resolution (server admission fence) replaces the 5-minute rule; markers kept per person through sign-out. Vitest 40/40; Playwright workspace 94/94, customer 56/56; release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-15 | D4 (web) | typecheck clean; Vitest 40/40 (session header/credentials, renew-and-retry once); Playwright workspace 92/92 (new session.spec: reload keeps sign-in, sign-out ends the server session, cross-tab sign-out, 401 renew + same request resent, other person's renewal refused; reload with an unconfirmed return restores a check-only panel), customer 54/54 (reload keeps sign-in; lost booking answer found by key after reload); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-15 | D4 + D3 UI approved | Codex approved D4 web (bad18bf, after 3 review rounds: cookie sessions, cross-tab lock and identity fences, noRenew admission, server-resolved restored requests, explicit same-origin topology), D3 workspace UI (3dd1742: requestId-keyed decisions, amount-free refund text), and the backend D4 (4b23d20) + business-date fix. |
| 2026-11-15 | O1, admin queue, medicine ordering, N1, S1 approved | Codex approved backend O1 (232e619 + docs), N1 (5f93e7f), S1 (release 997da42, hotfix 5cac856); web admin queue + O1 sign-in (da8b7a4), customer medicine ordering (7930a61, after 3 review rounds) and the N1 client (405a959, after 2 rounds). Backend: all 21 integration suites pass on `m0/n1-native-sessions`. Web: typecheck clean; Vitest 55/55; Playwright customer 110/110, workspace 128/128. |
| 2026-11-15 | WQ1 (partner workspace foundation) | typecheck clean; Vitest 69/69 (+9: workspace/admin path building, id validation before any request, select per session mode, selection shape, delegation/scope/removal rules); Playwright workspace 154/154 (+20 = 10 journeys x 2 devices: single and multi-membership sign-in incl. native and expired ticket, nav by permission and scope, staff add/edit/remove with server refusal, branches add/deactivate with confirm, admin list/filter/create/verify/suspend, admin-as-owner staff via `/partner-workspace/admin/<id>/workspace/members`); release build with VITE_API_BASE_URL=https://api.example.test. Not yet run against a real backend or reviewed. |
| 2026-11-15 | WQ2 (catalogue and bills) | typecheck clean; Vitest 87/87 (+18: paise parsing/formatting, preview rounding incl. half-paisa and odd-paisa SGST, IGST, classification, refusals, member/admin paths, admin item switches, body request key with no header, PDF blob, id checks; app: list cursor and repeats, IST date bound, item and bill builders); Playwright workspace 170/170 (+16 = 8 journeys x 2 devices: catalogue add/edit/deactivate in paise; no-GST supplier offered 0% only, GST item refused on a bill, 503 linking refusal unlocks and a changed bill gets a new key; live totals, lost answer resent with the same key and body, one bill, linked notice, nothing in browser storage; reload with an unconfirmed bill: check by key, forget after warning; pay with confirm, refused pay shows the server and the current bill, cancel with reason, PDF via blob for v2 and v0; finance read-only and biller read-only price list, pages absent without permission; clinic doctor picker and IGST; admin-as-owner bills, catalogue and disable/enable); release build with VITE_API_BASE_URL=https://api.example.test. Playwright ran on a spare port (another worktree's dev server held 5174). Not yet run against a real backend or reviewed. |
| 2026-11-15 | P8 web, N2 phone apps, P9 web approved | Codex approved P8 web (e0add83, after 3 rounds: attempt ownership, keyed recovery result, decision after waits), N2 (f4c3ff8: secure-store start gate, latest-attempt start-up) and P9 web (aab4e01, after 3 rounds: attachments keyed to their pharmacy, functional updates, no order while attaching, expectedPharmacyId recipient fence). vitest 60; Playwright customer 134, workspace 134; Android debug + unsigned iOS builds for both apps. |
