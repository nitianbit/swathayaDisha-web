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
| Staff | Admin, pharmacy, lab/clinic staff (WQ1) and doctors (WQ4) use the web workspace. HR joins when its module exists. |
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
- **Irreversible steps confirm first**: remove member, deactivate branch, verify, suspend (and reopen/reinstate).
- Not built: logo upload (`logo` is a stored path; no upload flow yet), branch `geo`.

Codex review of 6ce851b (REQUEST_CHANGES, 3 MEDIUM), fixed:
1. **One subtree per partner.** Every partner screen (and the admin partner page) is keyed by its scope identity
   (`partner-ws:<partnerId>`), so moving from `/admin/partners/A/...` to `/B/...` discards open forms and confirmations;
   a submission still running belongs to the partner it was made for (its `ctx` never changes) and reports nothing on B.
2. **Edits keep their baseline** (`src/draft.ts`). Only fields changed from the value the edit started from are sent.
   A refetch moves untouched fields along; a field changed here and on the server is reset to the saved value with
   "Someone else changed ... make your change again". Right before sending, the record is read again (`GET /me`,
   `/branches/:id`, `/members/:id`, admin `GET /admin/:id`) and the same check runs, so a full replacement (permissions,
   branch access) never restores a grant someone revoked meanwhile. The schemas cannot clear a field: emptying one is
   refused inline.
3. **Exactly-once partner creation** (backend Q8 `requestKey`). A key per submitted form, kept with the exact request in
   session memory (a body-less marker survives a reload) until the answer is known. After a lost answer the form is
   locked and only "Send again" (same key, same content; the server replays the partner) resolves it. After a reload
   the content is gone: the admin is sent to the list to look for it before starting again. (Replaced after the
   re-review, below: the list is never used to clear it.)

Codex re-review of 5236388 (REQUEST_CHANGES, 2 MEDIUM + 1 LOW), fixed with backend Q10 (`m0/q10-billing-hardening`,
3d6b45d + a6356bf):
1. **An unconfirmed create is settled only by the server.** The create claims its key inside its transaction. After a
   reload the stored key is looked up (`GET /partner-workspace/admin/by-key/:key`): found → "… was created", open it.
   Not found proves nothing (the request may still arrive), so the only way on is "Give up this create"
   (`POST …/by-key/:key/abandon`): `abandoned` (that key can never create) clears it and allows a new create with a
   new key; `used` opens the partner it made. "Give up" is also offered next to "Send again" before a reload.
2. **Inputs freeze while saving.** Every edit form's fields sit in a fieldset disabled while saving; branch access
   sends the scope validated before the wait (an immutable copy, re-compared after the member re-read).
3. **A late answer never moves the admin.** A create success is handled only while its attempt still owns the stored
   state, and navigates only while the page is still on screen (checked again after the list refresh).
4. **Server-side concurrency (Q10 `expectedUpdatedAt`).** Profile, branch, member permissions, member branch access and
   admin partner edits send the `updatedAt` of the record the draft was rebased on (the re-read just before saving). A
   409 `RECORD_CHANGED` re-reads the record and rebases: fields both sides changed are shown for review; otherwise
   "Someone else changed this while you were saving, so nothing was saved".

Adopted from backend Q8 (`m0/q8-partner-admin`, 0fcf0b3): branches readable by every member (names for scoping; the
`branches.manage` workaround is gone); "Change branch access" (`PUT /members/:id/branches`; not owners, not yourself,
delegation ceiling); closed branches with Reopen (`?includeInactive=true`, `POST /branches/:id/reactivate`, partner-wide
branch managers); Reinstate for suspended partners; profile edits for owners only (staff see it read-only); partner
list search (`q`) and paging (20 a page).

Codex review of 4646987 (1 MEDIUM), fixed: a give-up (abandon) answer, and the by-key lookup after a reload, act only
while their page is on screen AND the stored creation is still exactly the one they started from (same key and
attempt count). An answer from a page that was left, or one overtaken by a newer retry of the same key, settles and
opens nothing, so the retry's own answer ends it (test with held answers: A's late `used` arrives while B's resend is
in flight; B still owns its state and its success opens the partner).

Backend items still open:
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
- **WQ1 review rules applied (after the WQ1 Codex fixes were merged):**
  - Every WQ2 screen is keyed by `scopeIdentity(ctx)` (the bill page also by bill id): an admin moving between
    `/admin/partners/A/...` and `/B/...` starts with no draft, review step, payment/cancel confirmation, item form or
    admin-disable confirmation open. A running request keeps its own partner's routes (bound when started) and its late
    answer does not navigate or write into the other partner's screen. The unconfirmed bill's session memory and reload
    marker live under `partner-invoice:new:<scope identity>`, so they appear only for their own partner.
  - Item edits use `draft.ts`: baseline + changed fields only; a refetch moves untouched fields along; the item is re-read
    right before sending, and a field changed both here and on the server is reset with a notice instead of being sent;
    a deactivated item is not saved.
  - Item create: see Q10 below (the WQ1-style "look in the list" lock was replaced by a keyed create).
- **Codex WQ2 review (fa5ef06) and Q10 adoption** (backend `m0/q10-billing-hardening`, worktree `q10-billing-hardening`):
  - **Pay and cancel never go back in time.** One action at a time on a bill (the other is disabled while one is being
    sent, and while a payment's outcome is unknown). Answers are folded into the cached bill by `mergeDetail`: events
    merged by version, the bill replaced only by an equal or newer `lifecycleVersion`; the exact bill is then read again.
  - **Payment replay**: a lost payment answer keeps "Send the same payment again" (same mode and reference); Q10 answers
    a repeat with the payment already recorded (200 `replayed`), treated as success. A different payment is refused 409.
  - **Cancelling a paid bill** asks how the money went back (mode, reference, note → `refund`; 400 REFUND_REQUIRED
    otherwise; none for an unpaid bill); the timeline shows "money returned by …".
  - **Exactly-once item create**: a key per submitted item (`requestKey`), kept with the exact content in session memory
    (reload marker body-less, per partner). A lost answer locks to "Send the same request again" (a replay answers the
    same item; other content under the key is 409 REQUEST_KEY_REUSED). After a reload: looked up in the price list by
    the item's stored `createRequestKey`; not found → a new item only after an explicit possible-duplicate confirmation.
  - **Lost bill after a reload**: `GET /invoices/by-key/:key` (found → opened) and `POST /invoices/by-key/:key/abandon`
    ("Give up this bill": `abandoned` = it can never be issued, the form opens; `used` = the bill is opened). Also
    offered on the same page once a check found nothing. The possible-duplicate path for bills is gone.
  - **Bills list**: the server's exact cursor (`pagination.nextCursor`, `<ms>_<id>`), the total, "from"/"to" IST dates
    and search (bill number, customer name, phone). The whole-second workaround is gone.
  - **Catalogue**: kinds by partner type (labs: test/package with visit modes and report time; clinics:
    consultation/procedure/package/other, no visit modes); deactivated items listed for catalogue managers
    (`includeInactive`) with Reactivate; edits send `expectedUpdatedAt` from the draft baseline (409
    CATALOGUE_ITEM_CHANGED → the form follows the saved item and flags the conflict).
  - **Bill lines**: a 409 CATALOGUE_PRICE_CHANGED re-reads the catalogue; catalogue lines take the current price/GST
    with a notice ("X is now ₹… at …% GST") before the bill is reviewed again; items no longer offered are flagged on
    their line. DOCTOR_NOT_AT_BRANCH is shown as the server says (the picker already offers only active doctors at the branch).
- **Codex WQ2 re-review (d046414)**:
  - **A lost payment is held outside the form.** The exact payment (mode, reference, note) lives in the bill page's
    state and in session memory (per partner and bill), shown as "Unconfirmed payment" above the bill — also while a
    refresh of the bill fails (the last bill read stays on screen with a "Could not refresh" retry). No new payment form
    and no cancellation until it is settled: by the bill's own receipt (paid with that mode and reference → recorded),
    by another payment or a cancellation on the bill (→ not recorded, said so), by a definite refusal, or by resending it
    unchanged (Q10 replay).
  - **Recovery answers act only for their own page and attempt.** On the new bill page (and the item create of the price
    list) every answer — the create's own answer, a by-key lookup, a give-up `used`/`abandoned` — settles or opens the
    pending request only while its page is on screen AND the stored request is still the same key and attempt
    (`owns`). An obsolete answer leaves a newer resend, and its reload marker, intact; resending replays the same bill.
- **Codex WQ2 re-review (e3c6440): payments are owned once-only records.** A payment is stored (session memory per
  partner and bill, body-less reload marker) as a `PendingOp` BEFORE the request goes out, with its attempt count. While
  it exists, every page of that bill shows it ("being sent" / "could not confirm") with "Send the same payment again"
  and "Check the bill" instead of a new payment form, and cancelling stays locked. Its answer settles, replaces or
  deletes the record only while its page is on screen and the record is still that attempt; a late answer of a left
  page (e.g. a 409 after it lost the compare-and-set) leaves the newer attempt intact. A fresh read of the bill (after
  the last attempt) settles it: its receipt → recorded; another payment or a cancellation → not recorded. After a
  reload (no details kept) a payment on the bill settles it; only once a fresh read shows the bill unpaid can a new
  payment be recorded, after a step saying why that is safe (the server records one payment per bill).

Backend gaps found (not changed here). Closed by Q10: the `before` cursor, bill key lookup/abandon, payment replay,
GST rates on the catalogue, inactive items/reactivate, clinic item kinds, catalogue price and doctor checks on bills,
refund on cancelling a paid bill, item create key. Still open:
- `POST /invoices/:id/pay` takes no amount (always the full total; no part payments).
- No server-side search of the catalogue (the price list filters on the device).
- The replay flag of a repeated payment is outside `data` (`replayed` at the top level); the client treats the answer as
  success either way.
- Looking up a lost item create relies on `createRequestKey` being in the list response (stored on the item; not a
  documented field). A `GET /catalogue/by-key/:key` would make it explicit.

## WQ3 partner lab operations: slots, online lab bookings, reports (2026-11-16, taken autonomously at the owner's request)

Backend: Q3 slots + lab bookings (`SwasthaDisha-worktrees/q10-billing-hardening`, `src1/modules/partners`
`{model/slot.ts,model/labBooking.ts,validation/labBooking.ts,services/slots.ts,services/labBookings.ts}`, D1 `file/access.ts`).
API module `packages/api/src/partnerLabs.ts` (member/admin scope like WQ1/WQ2; ids, visit modes, dates and report files checked
before any path).

- **Pages** (deny by default, labs only via `partnerKinds: ['lab']`): `/partner/slots` "Slots" (`slots.manage`, `bookings.view` or
  `bookings.manage` read; only `slots.manage` edits), `/partner/lab-bookings` and `/partner/lab-bookings/:id` (`LAB_READERS`:
  `bookings.view`, `bookings.manage`, `reports.upload`, `reports.release`). Same screens under `/admin/partners/:id/{slots,lab-bookings}`
  (an admin opening a clinic's URL is told these pages are for labs; the admin partner page links them for labs). Admin
  `/admin/lab-bookings`: every lab's bookings (filters lab and status, lab names from the partner list, links to the
  as-owner booking page).
- **Slots**: branch (in the actor's scope, offering a visit type) + visit type + a Monday–Sunday week (India time); per slot
  booked/seats, Open/Full/Started or why it is closed (holiday, no longer in the template, by staff), template or one-off.
  Change seats (0–500, never below booked; the server's 409 is shown and the week reloaded), close and reopen with a
  confirmation. Reopen is offered only for staff closures: the server's reopen clears any closure, but a holiday or template
  closure is put back by the next expansion. Started slots offer no actions.
- **Weekly template**: the server has no route that READS a template, so the editor starts from the slots the template
  generated for the next two weeks (`deriveTemplate`: template-sourced slots still wanted; length and seats the most common
  among unbooked ones; windows = runs of back-to-back starts), else the branch's opening hours, else nothing, and says so.
  It is a `draft.ts` edit: refetches rebase untouched fields, the slots are read again right before saving and a field changed
  both here and there is reset with a notice. Validated as the server does (`slotTemplateSchema`, `validateWindows`), shown
  per day with slot counts, confirmed with a summary of what the expansion will do, then saved whole (every weekday sent; an
  empty day = no slots). The answer's expansion counts are shown. A resend is safe (it sets, not adds).
- **One-off slot**: date/start/end/seats checked like `manualSlotSchema`; no request key on the server, but a second slot at the
  same start is refused (409 SLOT_EXISTS), so after a lost answer the person is told to look at the week before adding again.
- **Lab bookings**: list by branch/status/slot dates (default from a week back; the server sorts oldest slot first, at most 500,
  no paging, so a full page says so). The booking page: patient as the partner view gives it (name, age, gender, self/family),
  slot, visit type, home address, collector, tests with prices, payment, cancellation, and a timeline (lifecycle times, the last
  reschedule, each release with its signer).
- **Steps = `labActions`** (mirror of `services/labBookings.ts`), only for paid bookings and only with the right permission:
  confirmed → assign collector (home), sample collected (home) / visited (lab), no-show (after the slot start), propose a new
  time, reject; collected/visited → processing; processing/report released → upload (`reports.upload`) and release
  (`reports.release`); report released → complete. Collected/visited/no-show are shown disabled with the reason while a new
  time waits for the customer. Confirmed first: no-show ("not refunded"), complete ("no more reports"), reject (reason 3–500;
  "full payment back to the wallet"), new time, release. A step answer replaces the page's booking only if its status version
  is not older; every refusal reloads the booking and shows the server's message.
- **New time**: open slots with a free seat, still ahead, not the booking's own, from the next two weeks of the same branch and
  visit type; reason 3–500; the consequence (seat moves now, customer accepts or cancels for a full refund, collected/visited/
  no-show wait) before sending. A slot taken meanwhile is refused by the server and the list reloaded.
- **Collector**: a member working at the booking's branch (only listable with `staff.manage`; admins always) or a name typed
  by hand; the mobile is typed (a member's sign-in number is never sent on its own). The customer sees both.
- **Reports**: upload PDF/JPEG/PNG/WebP up to 10 MB each (multipart `files` through the client's `form` option; checked first);
  no request key on the server, so after a lost answer the booking is reloaded and the person is told a second upload adds
  copies. Drafts are listed (and openable) only for report staff, as D1 reads them; released files for every reader, each with
  its signer. Release: members sign as themselves (no signer sent; the server refuses another); admins choose from members the
  server would accept (`eligibleSigners`: active, owner or `reports.release`, branch covered, professional registration on
  record). Re-releasing a released file is a no-op on the server, so a lost answer can be retried.
- **Files** are read with the session token through `GET /file/fetch?url=/api/static/partner-lab-reports/<booking>/<file>`
  into in-memory blobs bound to the booking and file asked for (a newer view or leaving aborts the older one), shown only if
  the bytes are a PDF or an image, saved under the file's name. No token or file link in any URL.
- **WQ1/WQ2 review rules applied**: every screen keyed by `scopeIdentity(ctx)` (the booking page also by booking id; the slot
  views by branch + visit type, and by week), so an admin switching partners (or a person switching branch/week/booking) starts
  with nothing open and a late answer writes only its own booking's cache and shows nothing on the page now displayed.
  Nothing about patients is written to browser storage.

Backend gaps found (not changed here):
- No route reads a slot template (only `PUT`): the editor can only infer it from generated slots; the PUT has no version or
  precondition (last write wins).
- No workspace route sets a member's `professional` registration (`addMemberSchema`/permissions/branches only), yet a release
  requires one. Until it can be set, only members already holding one can sign; admins see "nobody can sign" otherwise.
  Members cannot see their own registration (`GET /members` needs `staff.manage`; `/auth/profile` is not read for it).
- Reopen clears any closure (holiday or template too), which the next expansion undoes; the UI offers it for staff closures only.
- Lab-booking steps take no expected status version (the server's CAS uses its own read), so a step answers for the booking as
  it is then, not as the person saw it.
- Report upload and one-off slot create take no request key; report files cannot be deleted from drafts.
- The partner list endpoint has no paging (at most 500, oldest slot first); the admin list has no paging, dates or search
  (latest 200 by creation) and returns stored rows (report paths without `/api/static/`).
- Uploads share the client's 20-second timeout (no per-request timeout); a 10 MB file on a slow line may time out (then the
  booking is reloaded as for any lost answer).
- `assignCollector` is accepted for lab visits too; the UI offers it for home collections only.

Review fixes (Codex WQ3 214e97b: MEDIUM report response ordering, LOW late slot-save draft loss):
- One step at a time per booking, enforced in one place (`perform`, a ref guard), so confirmations that were already open
  are covered too: a second step is refused with "Another step on this booking is still running". Open confirmations
  (`ConfirmAction`, the release step) also disable their final button while another step runs. Uploads keep the status
  version, so equal-version snapshots cannot be ordered; after every step (success or not) the exact booking is re-read.
- Slots: every opened editor (template or one-off slot) gets its own generation. A save or add answered after another
  editor was opened still shows its notice, but closes nothing and does not move the week.

## WQ5 partner earnings and admin settlements/payouts (2026-11-16, taken autonomously at the owner's request)

Backend: Q5 finance (`SwasthaDisha-worktrees/q11-lab-ops`, `src1/modules/partners` `{model/settlement.ts,validation/finance.ts,
services/finance.ts,controller/finance.ts}`, routes in `routes/index.ts`; admin router mounted at `/api/v1/settlements`). API module
`packages/api/src/finance.ts` (member/admin-as-owner workspace scope like WQ1–WQ3, plus `settlementsApi`; ids, dates, the statement
cursor, limits and request keys are checked before any path is built; CSV read into a blob).

- **Pages** (deny by default, `modules.tsx`): `/partner/finance` "Finance" (Billing section) needs `finance.view` AND partner-wide
  scope (`partnerWide`, mirroring `assertPartnerFinanceReader`: a branch-limited member is refused 403 FINANCE_SCOPE_REQUIRED). The
  same screen at `/admin/partners/:partnerId/finance` (admin as owner; linked from the admin partner page and from the settlement
  account). Admin only: `/admin/settlements` "Settlements", `/admin/settlements/:accountId`, `/admin/payouts` "Payouts". Partners
  never see the admin pages (route roles), and the admin router refuses them anyway (`denyRoles('partner')` + `requireAdmin`).
- **Partner finance**: balance and lifetime totals (earned, reversed, paid out, adjustments; last payout), statement newest first
  with the server's running balance ("balance after" is over the whole account, whatever the period), paged by the server's
  `(at, _id)` cursor, India-date period filter, CSV of the same period, payouts (latest 100), finance events (latest 200; "You" /
  "A member" / "Jansetu admin", only the event's own amount, reference, destination or reason). No account yet = "Nothing earned yet".
- **Payout destination**: shown as the server gives it (owners: masked `XXXX1234`; admins: the full number they transfer to). Only
  owners change it (`setPayoutDetails` refuses staff with OWNER_REQUIRED; staff see it read-only); admins as owner and on the account
  page too. The page says first that any change, even to the same values, must be verified again by Jansetu before the next payout.
  Bank (holder, account number typed twice, IFSC, optional bank) or UPI, validated and normalised as `normalizeDetails` does; a
  review step says what happens before the PUT. The masked number is never put back into the form. Draft baseline (`draft.ts`) plus
  the details version the edit started from: a change elsewhere replaces the draft with what is saved (notice), and the account is
  read again right before sending; a different version stops the save.
- **Admin accounts**: filters owner kind, "only with a balance due" (default on: the payout queue view), payout-details state, name
  search; 50 a page by `skip`; the count and the total due over every matching account (`adminListAccounts` aggregate). Filters live in
  the page, never in the URL (account names include doctors' names).
- **Account page**: balance, payout details with **Mark as verified** (confirm; sends the exact version shown; 409
  PAYOUT_DETAILS_CHANGED reloads) and edit, **Record a payout**, **Post an adjustment**, statement + CSV, payouts, earlier history
  (legacy, "not part of the balance"), events. One money action at a time per account (`useOneAtATime`, the WQ3 `perform` gate): a
  second action, also from a confirmation already open, is refused with "Another action on this account is still running".
- **Record a payout**: only to verified details with something due; amount in rupees → paise (`rupeesToPaise`), ≤ the balance shown
  (the server decides on its own balance: 409 INSUFFICIENT_BALANCE), method, UTR 4–64, paid-on India date not in the future, note.
  The review names the details version and the balance before/after; it closes itself if the version or balance changes meanwhile.
  The body carries `detailsVersion` (a destination changed since is refused 409 PAYOUT_DETAILS_CHANGED and the page shows the new
  details) and a `requestKey` (once per admin+key; the server replays the same key and content). A lost answer locks the payout
  (session memory; a body-less reload marker): resend unchanged, or "Check whether it was recorded" in the account's payouts (lists
  never return the key, so it is matched by account + UTR + amount + date; a UTR is unique per account among recorded payouts). Only
  a refusal of a sole first attempt unlocks the form (typed values kept).
- **Post an adjustment**: add to / take from the balance (may go below zero; said in the review), amount, reason 3–500; confirm;
  once-only by `requestKey`; a lost answer is resent unchanged or found in the statement by its key (`sourceId = <admin>:<key>`),
  also after a reload.
- **Void** (Payouts queue; `?account=<id>` from an account page, an id only): reason 3–500 and a confirmation that says the amount
  goes back into the balance and that it cannot be undone. Voiding a voided payout is answered unchanged, so a lost answer is resent
  safely; the list and balances are re-read after every attempt. The queue has filters state (default Recorded), paid-from/to dates,
  and "Show more" up to the server's 500.
- **Review rules applied**: the partner page is keyed by `scopeIdentity(ctx)` and the account page by account id; late answers write
  only their own once-only state (`stillCurrent`, mounted check); CSV/blob downloads are aborted when the period changes or the page
  goes; nothing private in storage or URLs (the reload marker holds only the key and times); four states on every list; money in paise
  shown with `formatRupees`; India dates.

Backend gaps found (not changed here):
- `PUT /finance/payout-details` (partner and admin) takes no expected version: last write wins. The client re-reads right before
  sending, which narrows but does not close the window. It also has no request key: after a lost answer the page reloads and asks the
  person to check the details shown (a resend is harmless but bumps the version again).
- `financeVersion` is never returned; the only fence a client can send is the details version (verify `version`, payout
  `detailsVersion`). A payout is not fenced on the balance the admin looked at (only "≤ current balance"); adjustments carry no
  expected version at all.
- No lookup or abandon by request key for payouts and adjustments (`/request-keys` kinds do not include them), and payout lists strip
  `requestKey`. A lost payout is found by UTR/amount/date; after a reload only its key survives, so the admin must look in the payouts
  list (re-recording the same UTR is refused 409 PAYOUT_REFERENCE_EXISTS; under another UTR it would be a second payout to void).
- The payout queue has no paging beyond `limit` (≤ 500) and its rows carry no account name: names come from the accounts list (first
  200 by balance), others are shown by id.
- The partner workspace has no history route (legacy history only for admins and doctors); partner payouts (100) and events (200)
  have no paging.
- Doctors' own finance (`/specialists/me/finance`) is not part of this packet (no doctor workspace yet).

Review fixes (Codex WQ5 at 1c21528: 2 MEDIUM):
1. **Payout details save sends only what was reviewed, against the version it was reviewed on.** The reviewed version and
   the draft generation (bumped by every keystroke and every rebase) are captured before the re-read. After it, the page
   must still be on screen, the generation unchanged and the server still on the reviewed version; otherwise nothing is
   sent and the saved details are shown. Before, a background refresh during the re-read could move the baseline to the
   newer version, so the re-read "matched" and the older reviewed destination overwrote the newer one.
2. **Once-only payouts and adjustments are settled only by their owner.** Every answer, lookup result and "forget" acts
   only when its page is on screen AND the stored record is still exactly that key and attempt (`stillCurrent`, as WQ2
   3da8f10). A left page's late answer no longer deletes the attempt another page resent (and lost); the record and its
   reload marker stay until the owning page settles it (a resend replays it, a check finds it).

## WQ6 clinic doctors and front desk (2026-11-16, taken autonomously at the owner's request)

Backend: Q6 clinic routes (`SwasthaDisha-worktrees/q12-catalogue-lookup`, `src1/modules/partners/{routes/index.ts,controller,validation,services}/clinic.ts`,
`model/clinicDoctor.ts`, `bookings/holds.ts` for cancel/reschedule). API module `packages/api/src/clinic.ts` (member and admin-as-owner
scope like WQ1–WQ3; ids, mobiles, dates, states and the request key checked before any path).

- **Pages** (deny by default, clinics only via `partnerKinds: ['clinic']`; a lab member gets "Page not found", an admin opening a lab's
  URL is told "Only for clinics", as WQ3 does for labs): `/partner/clinic-doctors` "Doctors" (readers of `GET /clinic/doctors`:
  `staff.manage`, `bookings.view`, `bookings.manage`, `invoices.create`; invitations only with `staff.manage`) and `/partner/desk` "Front desk"
  (`bookings.view` reads, `bookings.manage` acts). Same screens under `/admin/partners/:id/{clinic-doctors,desk}`, linked from the admin
  partner page for clinics. Only `modules.tsx` and the admin partner page's link list were touched among shared/older files.
- **Doctors**: active doctor members with speciality, branches (empty = all), fee and "not bookable" when the doctor's own account is
  inactive or unverified. Invitations (`staff.manage`): by registered mobile (sent in its ten-digit form) or Jansetu doctor id; branches
  offered = active, in-clinic branches in the actor's scope; "every branch" only for partner-wide actors (a restricted manager must name
  branches inside their own, `assertScopeWithin`). A repeat for a doctor with a pending invitation answers that invitation (`created:
  false`), so a lost answer can simply be sent again; the page says which branches the existing invitation has. Revoke after a
  confirmation; one revoke per invitation at a time. The doctor accepts in their own app (WQ4); the page says so.
- **Front desk day view**: branch (active, in-clinic, in scope) + India-time day (previous/today/next) + doctor (all, or one consulting at
  that branch). Appointments of the day (desk and online, with patient, mobile, family relation, source, payment, status, arrival) and the
  chosen doctor's free in-clinic slots (seats left; already-started slots are marked "(started)", the server still books them). Times in
  both stored formats (`HH:mm`, `h:mm AM`) are read as the backend's `parseAppointment` and shown as IST.
- **Booking (once only)**: a slot, the patient's mobile (required; an account is created for a new number), name (optional; saved only
  when the account has none) and notes; mode is fixed in person (the server sets it). Reviewed, then sent with a fresh `requestKey` in the
  body (`deskBookingSchema`; the server keys it per desk member and hashes slot, mobile and notes). The pending booking is stored BEFORE
  sending (session memory per partner `clinic-desk:book:<scope identity>`, with a body-less reload marker), as WQ2 does. A lost answer locks
  the booking: "Send the same booking again" (the server answers the same key with the appointment it made, `replayed`) and "Check the day
  list" (a look-alike — desk appointment, same slot, same mobile — is shown as a hint only; the list carries no key). Only when that check,
  made after the last attempt, finds nothing can the person set the booking aside, after a confirmation that a duplicate would then have
  to be cancelled. After a reload the details are gone and the server cannot look the key up or abandon it, so the person is sent to the
  day list and may set it aside after the same confirmation. Every answer acts only while its page is on screen and its attempt still owns
  the stored state (`stillCurrent`); an obsolete answer leaves a newer resend and its marker intact. A definite refusal of a sole first
  attempt (also 503 `CUSTOMER_LINKING_UNAVAILABLE`, raised before anything is written) unlocks the form; 409 `SLOT_NOT_AVAILABLE` keeps the
  patient's details and reloads the free slots. The receipt names the fee (rupees, paid at the clinic) and whether an account was created.
- **Steps** (`deskActions`, mirror of `services/clinic.ts`, desk appointments only; online bookings are view-only): mark arrived (booked,
  not yet arrived), mark as seen (any time; confirmation), did not come (only after the appointment time; confirmation: "Nothing is
  charged or refunded through Jansetu"), cancel (confirmation with an optional reason, ≤ 500; "No money moves: desk appointments are paid at
  the clinic, so nothing was taken online"; empty = "Cancelled by the clinic", as the server records), move to another time (same doctor,
  a branch the doctor consults at in the actor's scope, any day; confirmation says seats move at once and the check-in is cleared; staff
  are told to inform the patient). One step at a time per appointment through one page-level guard (a set of appointment ids, so it
  survives switching between appointments); open confirmations are disabled while another step on the same appointment runs. A step's
  answer is never written into the cached day (see the review fix below); the day is read again after every step, and a late answer shows
  its notice only if that appointment is still the one open.
- **Bill for the visit**: WQ2's new-bill form starts empty (no prefill without changing it), so desk appointments link to "Make a bill for
  this visit" (`invoices.create`) or to Bills (other bill readers).
- **Review rules applied**: every screen keyed by `scopeIdentity(ctx)`; one action at a time per record; once-only create stored before
  sending with owned recovery state; confirmations for irreversible steps; four states per data view; no patient data in storage, logs or
  URLs (only the request key and attempt times in the reload marker). `draft.ts` baselines do not apply: WQ6 edits no existing record (only
  creates and commands).

Backend gaps found (not changed here):
- No lookup or abandon for a desk booking key (not a `request-keys` kind; no `GET /clinic/appointments/by-key/:key`; list rows carry no key).
  After a reload a lost desk booking can only be checked by eye in the day list.
- The invitation list returns stored rows without the doctor's name or speciality; names show once the doctor accepts (or for invitations
  sent in this session, from the invite answer).
- Clinics cannot search Jansetu doctors; inviting "by doctor id" needs an id the clinic has no way to look up (mobile works).
- Desk appointment fees are the legacy booking `price` in rupees (the specialist's `consultationFee`), not paise like Q2/Q3.
- Desk steps take no expected version; `deskSlots` lists slots that have already started and the booking path does not refuse them.
- No notification to the patient on a desk booking, move or cancellation (deferred in Q6); no invoice ↔ appointment link (deferred in Q6);
  family members cannot be booked at the desk (deferred in Q6).
- The appointment list is capped at 1000 rows with no paging.
- Desk command answers (`deskView`) carry no version, so the client cannot order an answer against a newer read; the page relies on
  re-reading the day instead.

Codex review of 80adab5 (REQUEST_CHANGES, 1 MEDIUM), fixed:
- **A late step answer never overwrites a newer change.** An answer used to be merged into every cached day list before checking the page
  was still live; one from a page the person had left (e.g. "arrived" for 12:00) could put back an old time and check-in over a reschedule
  made since, and if the next read failed the open appointment was shown from that copy with its steps. Now no answer is written into the
  cache at all (it has no version): only the re-read of the day (after every step, from any page) shows state. The open appointment is
  shown only from a successful read: when the re-read fails the list shows the error with "Try again" and no appointment or step is offered;
  while the day is being read again the steps wait.

## WQ7 WQ2/WQ5/WQ6 screens on the Q12/Q13 endpoints (2026-11-16, taken autonomously at the owner's request)

Backend (read-only): `SwasthaDisha-worktrees/q13-doctor-finance` `m0/q13-doctor-finance` 4d877b6 (contains Q12), `src1/modules/partners/{routes/index.ts,
controller,validation,services}/{catalogue,invoice,finance,clinic}.ts`, `bookings/holds.ts`, `requestKeys/index.ts`. Branch `wq/integration` (WQ5 + WQ6 on WQ1–WQ3).
Doctor files (WQ4) were not touched.

- **API modules.** `partnerInvoices.ts`: `catalogue(kind, includeInactive, q)` (server search, trimmed, 1–60 characters), `catalogueItemByKey`,
  `abandonCatalogueKey` (key 8–100, checked before any path), `recordPayment` answers `PaymentAnswer` with `replayed` inside `data`. `finance.ts`:
  `financeVersion` on accounts; `setPayoutDetails(body, expectedDetailsVersion)` (partner and admin); `expectedFinanceVersion` on payouts and
  adjustments; `payoutByKey` / `abandonPayoutKey` / `adjustmentByKey` / `abandonAdjustmentKey`; payouts, events and the queue are cursor pages
  (`PageQuery`, `<ms>_<id>` checked, limit ≤ 500) and queue rows are `QueuePayout` (with `account`). `isPayoutFor` / `isAdjustmentFor` are gone.
  `clinic.ts`: invitations carry `doctor`, desk rows `updatedAt`; every desk step takes the version it was decided on (`expectedUpdatedAt`, an ISO
  date checked first); `appointmentByKey` / `abandonBookingKey`.
- **One recovery shape everywhere** (as WQ2 bills already had): a lost once-only create is shown by `PendingOpPanel` with "Send the same request
  again", "Check whether it was recorded" (an exact by-key lookup, `keyedLookup` in `requests.ts`; a 404 means "not recorded so far", nothing more)
  and, once a check found nothing, "Give up this …" (the server's abandon: `abandoned` = it can never be recorded, then the form opens; `used` = the
  record, which settles it). After a reload the body-less marker's key is enough for both. A resend refused 409 `REQUEST_ABANDONED` (the key was
  given up elsewhere, e.g. another tab after a reload) settles it as "given up, never recorded" for ANY attempt (`wasAbandoned`): the claim and the
  record are written in one transaction, so no attempt with that key can ever commit. Every one of these answers acts only while its page is on
  screen and the stored record is still that key and attempt (`owns` / `stillCurrent`); the pending record is still stored before each send.
- **Price list (WQ2).** Lost item create: by-key lookup and give-up replace the price-list scan by `createRequestKey` and the "possible duplicate"
  path. Search goes to the server (`GET /catalogue?q=`) 300 ms after typing stops; the text is page state only (never the URL); the previous answer
  stays while a new search runs ("Searching…"); "No matching items" names the search. Type and status filters stay on the device. A replayed bill
  payment says "It had already been recorded: nothing was recorded twice" (read from `data.replayed`).
- **Finance (WQ5).** The destination PUT names the version it was reviewed on; 409 PAYOUT_DETAILS_CHANGED (a save landing between the re-read and
  the write) closes the review, re-reads and shows what is saved now (the WQ5 reviewed-version capture before the re-read is kept). Payout and
  adjustment reviews record `financeVersion` and close ("The account changed while you were reviewing…") when the account moves (another payout,
  adjustment, void, destination change or verification); the body carries `expectedFinanceVersion`, so a stale decision is refused 409
  FINANCE_CHANGED and the account is read again (the form keeps what was typed). Lost payout / adjustment: by-key lookup and give-up replace the
  UTR/amount/date match and the statement scan; after a reload the marker + key are resolved definitively ("Forget" is gone). Payout queue: exact
  cursor paging ("N payouts · showing M", "Show older payouts"), newest RECORDED first (the server's new order), names from each row's `account`
  (owner name, else beneficiary): the 200-account name lookup is gone; the single-account view takes its name from a row or the account read.
  Account payouts/events and partner payouts/events page the same way (`PagedSection`, 50 a page, four states, next-page error with retry).
- **Front desk (WQ6).** A lost desk booking uses the same panel: lookup by key and give-up replace the day-list look-alike hint and "set aside",
  also after a reload (the receipt then names the doctor, time and branch from the appointment; the patient's details are not kept). A give-up
  answered `used` without an appointment (moved out of this desk's branches) settles it with that said. Started slots are no longer marked
  "(started)" (the server leaves them out); 409 SLOT_STARTED is handled like a taken slot (details kept, slots read again) for bookings and moves.
  Every step sends the `updatedAt` of the row it was decided on: the appointment panel is keyed by `bookingId:updatedAt`, so an open confirmation
  or move form closes when the appointment changes, and the closure that sends always holds the version the person saw. 409 BOOKING_CHANGED says
  "The appointment changed since you opened it … nothing was done" and the day is read again (as after every step). Invitations show the doctor's
  name and speciality from the list (the in-memory names learnt from invite answers are gone).
- **Review rules kept:** late answers only with `stillCurrent` on a live page; pending records stored before sending and settled only by their
  owner; WQ5's version/generation capture before the re-read; one action at a time (`useOneAtATime`, the desk's per-appointment gate); no
  unversioned answer written over a cache (desk answers still never are; finance and catalogue re-read); nothing private in storage, logs or URLs
  (markers hold the key and times only; search text not in the URL); four states on every list; confirmations unchanged.

Gaps closed (from the WQ2, WQ5 and WQ6 lists): server catalogue search; `replayed` inside `data`; item create lookup by key; payout-details PUT
version (both); `financeVersion` + fenced payouts/adjustments; payout and adjustment key lookup/abandon; queue paging and account names; partner
payouts/events paging; desk key lookup/abandon; invitation doctor names; started slots listed/bookable; desk step versions; desk answers without a
version (steps are now fenced; the page still re-reads rather than overlaying answers).

Still open:
- `POST /invoices/:id/pay` takes no amount (no part payments: deferred in Q12 until an owner asks).
- Payout-details PUT has no request key: a lost answer still reloads and asks the person to check (a resend with the old version is now refused
  instead of overwriting).
- Clinics cannot search Jansetu doctors (deferred in Q13: privacy, owner to decide); desk fees stay legacy rupees; no patient notification for desk
  bookings/moves/cancellations; no invoice ↔ appointment link; family members not bookable at the desk; the day list is still capped at 1000 rows.
- The partner workspace still has no legacy history route; doctors' own finance belongs to WQ4.
- WQ3's lab gaps are untouched by this packet.

Verification: see the 2026-11-16 WQ7 row below. Playwright ran on port 5271 with a temporary config (`reuseExistingServer: false`), not committed:
the planned 5261 was already held by the WQ4 worktree's own dev server.

Review fix (Codex WQ7 236fe6a, LOW): the item being edited is read from the whole price list (an unfiltered query,
enabled only while an edit is open), never from the search results, so searching for something else no longer unmounts
the editor and loses what was typed. Journey: edit CBC, search "thyroid", clear the search, save: the typed price is sent.

## WQ4 doctor tools in the staff workspace (2026-11-16, taken autonomously at the owner's request)

Backend: Q4a schedule, Q4b instant consultations, Q5 earnings, Q6 clinics, with the Q13 doctor gaps closed (`m0/q13-doctor-finance`
approved at 4d877b6, `SwasthaDisha-worktrees/q13-doctor-finance`; first built against Q11 `q11-lab-ops`), routes
`/specialists/me/*` in `specialists/routes/index.ts`; services `doctors/services/{schedule,instant}.ts`, `partners/services/{clinic,finance}.ts`,
`specialistPortal/services`). API module `packages/api/src/doctorTools.ts` (ids, dates, cursors, minutes, presence, practice and payout
details checked before any request; rules mirrored with the backend function cited).

- **Sign-in**: "Doctor" on the workspace login (`/auth/specialist/*`, OTP like other staff; the workspace session audiences already
  allow `specialist`). `StaffRole` gains `specialist`; name and speciality come from the specialist profile `/auth/profile` returns
  ("Doctor · Cardiology"). Pages for the role: Home, Consult now, Appointments, Schedule, Clinics, Earnings (deny by default; doctors see no
  partner/admin/pharmacy page and nobody else sees a doctor page).
- **One subtree and cache per doctor**: every doctor page renders under `key="doctor:<id>"` and reads under `['doctor', <id>, …]`.
- **Home**: verification state (active / waiting / not active, from `GET /me/profile`), "available now" as known in this session, open
  offers (read every 30 s), the next three appointments of the next two weeks.
- **Schedule** (`/doctor/schedule`): weekly windows with types (video, call, chat, in person) and a place: online / own place, or a branch of
  a *verified* clinic the doctor consults at (`GET /me/clinics`; unverified clinics named as not offered; a saved branch no longer allowed
  is shown as such and refused). Mirrors `scheduleTemplateSchema` + `validateTemplate` (5–240 min, ≤12 windows, at least one slot per
  window, no overlap, clinic windows in person only). `draft.ts` edit: refetches rebase untouched days; the schedule is read again right
  before the PUT and a day changed both here and there is reset with a notice; confirmed with a per-day summary; the expansion counts are
  shown; server refusals (e.g. `CLINIC_BRANCH_NOT_ALLOWED`) shown as "Not saved". Leave days: upcoming list, add (today or later) and
  remove, each confirmed; both are idempotent on the server.
- **Consult now** (`/doctor/consult-now`): "available now" with types and fee (rupees typed → paise by string arithmetic; empty = the
  consultation fee). It lives in a provider in the signed-in shell, so the heartbeat (every 60 s) continues on any workspace page while the
  page is visible and stops while it is hidden; becoming visible after more than a minute sends one at once. Going off stops the heartbeat
  locally whatever the answer (the server drops the doctor two minutes later) and resends the types and fee (the server would reset the fee).
  One switch at a time; a heartbeat answer for an older state is ignored; a 403 takes the doctor offline with the reason. Offers are read
  every 15 s while visible, each with a countdown (closed offers cannot be accepted). Accept confirms the patient basics and the fee; every
  refusal has its own words (`INSTANT_REFUSAL`: speciality, coupon, busy, expired, fee above the patient's payment, not available, taken,
  account not active). A lost answer — or "taken", which may be this doctor's own earlier attempt — is checked against today's appointments
  (`instantRequestId`) before anything is said. Answers belong to their attempt and to the page: after leaving, a late answer shows
  nothing. Today's running instant consultations can be extended by 1–60 minutes (a lost answer is not resent: it would add again).
- **Appointments** (`/doctor/appointments`): Today, next 14 days (month views) or one day; kind, type, concern, status, payment, join link.
  Commands only as `appointmentActions` mirrors the server: confirm (waiting and paid), complete (confirmed; ledger bookings only once
  paid), cancel by the doctor with a reason (full refund to the patient's wallet; instant ones through `cancelAccepted`), no-show (paid,
  confirmed, after the start). Each confirmed first; rows keyed by status so a confirmation never outlives the state it was opened for.
- **Clinics** (`/doctor/clinics`): invitations (accept / decline, confirmed), memberships with verification and branches, leave
  (confirmed; owners cannot). Solo practice: form mirroring `soloPracticeSchema`, confirmed, explained (verified by an admin before
  in-clinic hours can be added or booked; managed by signing in as "Lab or clinic staff" with the same mobile, where the Q7 choice handles
  several memberships). No request key on the server, but one practice per doctor: a resend answers the existing practice (content
  ignored), so after a lost answer the page re-reads `GET /me/practice` and a resend is safe.
- **Earnings** (`/doctor/earnings`): balance and totals (paise, `formatRupees`), last payout; statement newest first with the running
  balance, 50 a page via the `before` cursor, an IST period; CSV of the period read with the token into a blob and saved under the server's
  file name (mirrored: the header is not readable); payouts (voided with reason); earlier (legacy) payouts marked as not in the balance;
  account activity. Payout destination shown masked with its verification state, and "any change, even to the same details, needs
  Jansetu's verification before the next payout"; bank or UPI form mirroring `normalizeDetails`, confirmed; the account is read again just
  before saving and a destination version changed since the form opened stops the save with what is there now (this also stops a blind
  resend after a lost answer). Account numbers live only in the form's memory.

Codex review of f740811 (REQUEST_CHANGES, 2 MEDIUM), fixed:
1. **Unacknowledged presence terms are unknown.** A switch whose answer is lost (timeout, network, 5xx) may have been applied:
   the provider then drops its terms (`presence` null, `unconfirmed` keeps what was sent, shown as "Not confirmed" on Consult now
   and Home), stops the heartbeat (an uncertain presence is not kept alive; the server lets it lapse in two minutes) and sends no
   heartbeat while any switch is on its way. Accept is offered only with acknowledged terms (`confirmedOn`: on, no switch on its
   way, nothing unconfirmed), and the confirmation names the acknowledged fee; otherwise the page asks to switch on (or "Send again")
   and wait for the server. A definite refusal changed nothing, so the previous acknowledged terms stay. Independent of the Q13
   `GET /specialists/me/presence` (which will let the page re-read instead of resending).
2. **Call links made after the accept.** `meetingLinkState` mirrors `isInternalMeetApplicable` + `syncBookingMeet` (paid,
   confirmed call/video: ready, preparing, or failed with the server's reason). Wherever a consultation is shown (Consult now's
   running list and accept outcome, which reads the booking from today's list rather than the accept answer; Appointments, all three
   views) a missing link says "The call link is being prepared…" with a Refresh button, and the list is read again every 5 s while an
   instant consultation's link is missing — at most two minutes per consultation (Refresh starts another round), only while the
   page is visible. After that it says the link has not arrived yet; a failed link says why.

Codex re-review of 9d9660c (REQUEST_CHANGES, 1 MEDIUM: an earlier presence write that times out can still run after newer terms
were acknowledged and overwrite them), fixed with the Q13 write fence:
- **Presence is read and written in order.** The shell reads `GET /me/presence` on start (no more "unknown after a reload"): on and still
  checked in → this page keeps it alive; on but no check-in for two minutes → "On, not checked in", not revived on its own. Every change
  sends `expectedPresenceVersion` (the last acknowledged `presenceVersion`); a stale one is refused 409 `PRESENCE_CHANGED` and the page
  reads and shows the server's terms. After a lost answer the only way on is "Check what the server has" (a fresh read, shown with its
  version), then a change against that version. Terms are acknowledged only by a definite answer, a fresh read or a heartbeat answer
  (the heartbeat now returns the same view); accept and heartbeats run only on acknowledged terms (no heartbeat while a read or change is
  on its way). A request lost earlier that reaches the server late names an old version and can never overwrite newer terms.
- **Other Q13 doctor endpoints adopted:** offers show what the patient paid and accept is not offered when the acknowledged fee is above
  it (`quotedAmountMinor`, `feeWithinQuote`); a 200 `replayed` accept is the same success ("your earlier accept had gone through");
  extensions carry a request key, a lost answer is looked for on `GET /me/instant/bookings/:id` and only the same extension (same key and
  minutes, added once) can be sent again; the schedule save sends `expectedUpdatedAt` (409 `SCHEDULE_CHANGED` → the hours are read in and
  rebased); payout details send `expectedDetailsVersion` (409 `PAYOUT_DETAILS_CHANGED` → the current details are shown and become the
  base); payouts and account activity page by the server's exact cursor (`pagination.nextCursor`, 50 a page).

Codex re-review of 7b32cff (REQUEST_CHANGES, 2 MEDIUM + 1 LOW), fixed:
1. **A read does not retire a lost write.** A presence change whose answer is lost may still commit later on the version it named, so
   after it a fresh read only SHOWS the server's terms ("The server last showed … (version N), not yet confirmed"); accept and heartbeats
   stay blocked until "Confirm these terms" (or a changed set of terms) is acknowledged as an ordered write against the version just read.
   Acknowledged, the version has moved past the lost write for good; refused 409 (the lost write, or another device, got there first),
   the terms are read and shown again and the step repeats. The doubt is stored before every write (session memory with a body-less
   marker), so a reload starts uncertain too instead of acknowledging its first read. A read acknowledges only when no write of this
   page is unresolved (start without a marker, heartbeats, the 409 refresh of an ordinary change).
2. **Extensions are owned once-only operations.** Key and minutes are stored in session memory per booking BEFORE the POST (`PendingOp`,
   body-less reload marker); leaving the page, a remount or a query error keeps it. While unresolved only reconciliation is offered: the
   booking read (`instantExtensions` carry the request key; checked again on every return) or the unchanged same-key resend — after a
   reload, whose marker has no minutes, only the check. It settles on a recorded key, a definite refusal of a sole first attempt
   (`afterFailure`), or a booking no longer held (it can never be added); a late answer settles only what its attempt still owns.
3. **Heartbeats are serialised** (one in flight; none while a read or change is on its way) and an answer whose `presenceVersion` is
   older than the adopted one is ignored.
Q13 final eligibility mirrored: `doctorStanding` needs both stored flags true (`isEligibleDoctor`).

Codex re-review of 511eff2 (REQUEST_CHANGES, 1 MEDIUM + 1 LOW), fixed:
1. **An extension is settled only by the attempt that owns it, on its live page.** Success, failure and every reconciliation answer
   change the stored operation only if the page that asked is still mounted and `stillCurrent(stored, captured attempt)` holds (as
   WQ2 3da8f10). An older attempt answering after the doctor left and sent a same-key retry from the returned page leaves the retry's
   state alone; the next check on a mounted page finds the key recorded and settles it once.
2. **One submit for the presence form.** While uncertain, the form's submit (Enter included) does what its primary button does:
   confirm the shown terms, so confirming "Off" never switches the doctor on.

Backend gaps found (not changed here; Q13 closed: presence read and ordering, quote on offers, accept replay, keyed extensions and the
held-interval read, schedule and payout-detail preconditions, paged events and payouts):
- Presence is per account: a change made on another device is seen at the next heartbeat or read (and refuses this page's next change).
- Call links are made after the booking commits, with no event to the workspace: the page polls (bounded) for instant ones.
- Accept recovery after a lost answer still also looks in today's appointments (an accept just before midnight India time and checked
  after it would be missed there), but accepting again is now safe: the server answers the same doctor's booking (`replayed`).
- Appointment lists carry no patient name (`userId`/`dependentId` only); month views are unpaged; `view=all` pages with `meta`, not
  `pagination`. Generic `confirmed` is accepted for unpaid waiting bookings (the UI offers it only for paid ones).
- Legacy history (500) is unpaged; leave accepts past dates (the UI asks for today or later).
- Not built: the prescription route (`POST /me/appointments/:id/prescription`), patient history, and the legacy `/me/slots` editor.

## WC1 customer app: partner labs, bills and Consult now (2026-11-15, taken autonomously)

Backend: Q2 bills, Q3 partner labs, Q4b instant consultations (`m0/q7-partner-signin`). API modules `customerLabs.ts`,
`customerBills.ts`, `instantConsult.ts` (amounts in paise, `fromPaise` for display).

- **Home** gains Consult now, Lab tests (partner labs; the LabStack/Healthians bookings stay as they were) and Bills.
- **Lab tests**: labs by pincode or city → one screen per lab (visit type, branch, tests from the catalogue for that
  visit type, 7-day slots, for self/family, home address checked with the backend's own limits, coupon via
  `/coupons/validate` with the create's context, wallet) → keyed once-only create (same rules as doctor bookings; a
  reloaded unknown request is settled with `/request-keys/abandon` `lab_booking_create`) → Razorpay → booking page:
  status, progress timeline from the lifecycle times, pay again inside the 30-minute window (server reuses the open
  order; a 409 after the window keeps reading the booking), cancel with the 2-hour rule shown first (lifted while a lab
  reschedule is unanswered), accept the lab's new time by its version (a newer proposal is reported, not accepted),
  released reports.
- **Private files** (lab reports, bill PDFs): read with the token through the API client (`/file/fetch`, `/bills/:id/pdf`),
  typed by their first bytes, offered from a `blob:` URL (Open / Save); never a token in a URL, nothing stored.
- **Consult now**: speciality (free text) + mode → doctors online now (always read fresh) or any available → quote
  → pay upfront (keyed create, `instant_request_create`) → waiting screen: presence reported every 2 minutes while
  visible, 5-minute offer countdown, then offer again (any / a doctor within the paid amount and the coupon's doctors)
  or refund to the wallet (two steps). Accepted: the returned difference, Join the call (Meet link when ready), and the
  consultation booking, which shows no Cancel (instant bookings cannot be cancelled by the customer).
- **Bills**: list and detail (lines, discounts, CGST/SGST or IGST, totals, paid by / unpaid / cancelled, supplier and
  GSTIN, doctor name from the public doctor profile), PDF.
- **My bookings** lists Consult now requests and partner lab bookings as their own sections.

**Codex review round 1 (5 MEDIUM) and backend Q9** (`m0/q9-customer-reads`, 78b9efe):
- **Price fences.** Lab bookings send `acceptedPayableMinor` + `acceptedSubtotalMinor`, Consult now sends `acceptedQuoteMinor` +
  `acceptedPayableMinor`: exactly the price on screen. A price is "agreed" per choice (tests / doctor, patient, coupon;
  prices excluded): the first price shown for a choice counts as seen; if it changes for the same choice (server re-read,
  coupon re-check) nothing can be sent until the customer taps "Accept the new price". 409 `PRICE_CHANGED` /
  `QUOTE_CHANGED` re-reads the prices or quote and re-checks the coupon.
- **Coupons belong to their context.** A coupon result counts only for the lab, visit type, tests and prices (or doctor,
  patient and quote) it was checked for; any change re-checks it; late answers for another context are dropped; nothing
  is sent while a check is running.
- **Completions belong to their request and page.** A create's success counts only while its key still owns the slot (an
  ended or replaced intent, or a second answer for the same key, does nothing); Checkout and navigation happen only while
  the page is on screen. Pay-again runs are numbered: an older answer, or one arriving after the page was left, opens
  nothing; the panel is keyed by record + payment attempt.
- **After a reload** a lost create is looked up read-only (`GET /request-keys/lookup`): made → opened; abandoned →
  start again; unknown → check again, or give it up for good only when the customer confirms (abandon).
- **Accepted Consult now** keeps reading the request (15 s) and its consultation until it ends: the Meet link appears when
  it is created, a doctor cancellation shows the refund; Refresh button and error-with-retry.
- **Private files** are keyed by document identity (report file; bill id + lifecycle version) and the bill PDF is
  requested for the version on screen (`?version=`); the bill page always re-reads the bill.
- **Q9 reads adopted:** paged bills / lab bookings / Consult now requests (Show more); `doctorName` on bills; lab and
  branch names on lab bookings; report signers paired by `file`; `GET /partner-labs/:partnerId`; a speciality picker from
  `GET /instant/specialities?mode` (with online counts, always fresh); held refunds read from `refunded`.

**Codex review round 2 (2 MEDIUM):**
- A create's success finishes the operation only for the newest attempt of that request on a page still on screen
  (`stillCurrent` + live page). An older attempt, or a page that was left, never clears a newer attempt's state; the
  newer attempt gets the same record from the server and completes it.
- The price agreement follows the coupon the customer chose (applied or removed by hand), not whether it still checks
  out: a coupon dropped by an automatic re-check raises the price, which must be accepted again (labs and Consult now).
  `INVALID_COUPON` on create (the server checks the coupon before the price) re-reads the price and re-checks the coupon,
  like `PRICE_CHANGED` / `QUOTE_CHANGED`.

Backend gaps still open (not changed):
- Opening an unpaid lab booking/request checks only its latest payment attempt (`/payments/reconcile`); "Pay now"
  reconciles them all on the server.
- Native: Open/Save of `blob:` files needs the planned filesystem/file-viewer plugin inside the Capacitor shell.

## WQ8 owner decisions of 18 Nov 2026 (2026-11-18, taken autonomously at the owner's request)

Backend (read-only): Q14 `SwasthaDisha-worktrees/q14-owner-decisions` `m0/q14-owner-decisions` 85a4ec1 (design doc §11 last rows; `partners/{routes,
validation,controller,services}/{clinic,invoice,labBooking}.ts`, `bookings/{holds.ts,services,utils/noShowView.ts}`, `specialists/routes`). Branch
`wq8/owner-decisions` on `stage` 915a2db. Every endpoint and field below is in `packages/api` (`noShows.ts`, `clinic.ts`, `partnerLabs.ts`,
`partnerInvoices.ts`, `partners.ts`, `doctorTools.ts`, `customer.ts`, `customerLabs.ts`).

- **No-shows (decision 1).** No refund and no earning without the service. A no-show may be moved ONCE to a later slot (same price, nothing paid or
  refunded) by the lab (`bookings.manage`), the clinic desk (its own desk appointments), the doctor (`/specialists/me/bookings/:id/reschedule-no-show`)
  or an admin; never by the customer; instant consultations never. One component (`components/NoShowMove.tsx`) serves the lab booking page, the desk
  appointment panel and the doctor's appointments: "Reschedule no-show" → slot picker (lab: open slots of the branch and visit mode, two weeks; desk:
  free slots of the doctor at the clinic's branches, any day; doctor: the doctor's own open, not-started slots of a day, online or clinic as the
  booking) → confirmation (once only; a second no-show is final) → sent with a request key and the version the move was decided on (lab
  `expectedVersion` = `statusVersion`, desk/doctor `expectedUpdatedAt`), stored with the version BEFORE sending (session memory + body-less marker).
  Resending is the same request; the server replays by key, refuses any second move (409 NO_SHOW_RESCHEDULE_USED → said, settled) and SAME_SLOT /
  SLOT_STARTED / SLOT_NOT_AVAILABLE (→ choose another time, slots read again). An answer settles only while the page is on screen and it owns the
  stored attempt; a read made after the last attempt settles a lost answer (no longer a no-show = moved; still a no-show after the move was used =
  final; a desk no-show that left its day at the same branch/doctor filter = moved). A restored move (after a reload) can only be checked, or
  forgotten once the booking is read still a no-show (safe: a booking moves once). Once used, the step stays visible and disabled (lab and doctor
  from `noShows[]`/`noShowReschedules`; desk rows carry no history, so the server's 409 decides there). History: lab "No-show history" list and
  timeline entries, doctor "Moved after a no-show (missed …)". Copy: lab/doctor no-show confirmations now say nobody earns; the doctor's Earnings
  page says a no-show earns nothing. Cancel is no longer offered on a booking moved after a no-show (doctor; customer consultation and lab) —
  NO_SHOW_NOT_REFUNDABLE (desk rows paid at the clinic excepted). Customer app: a no-show says "not refunded" (and that one new time may be offered);
  a moved one shows the missed and the new time and offers no cancel; no reschedule button anywhere.
- **Desk notifications (decision 7).** Sent by the server. The desk booking confirmation says "The patient and the doctor will be notified", the
  receipt and moves say they are; the old "Jansetu does not notify them" copy is gone.
- **Bill linked to its appointment (decision 8).** Desk rows have a Bill column: the appointment's bill (serial + state, linked to the bill) or, for
  bill makers on a desk appointment without an open bill, "Create bill" — it hands the new-bill form the patient, mobile, doctor, branch and
  appointment through session memory only (never the URL or browser storage), read once. The form shows "For the clinic appointment with …",
  freezes branch and doctor while linked ("Not for this appointment" unlinks) and sends `appointmentId`. Refusals in words:
  APPOINTMENT_ALREADY_BILLED (the desk is read again), APPOINTMENT_BRANCH_MISMATCH, APPOINTMENT_DOCTOR_MISMATCH, APPOINTMENT_CANCELLED,
  APPOINTMENT_NOT_FOUND. The bill shows its appointment with "All bills of this appointment" (bills list filtered by `appointmentId`, an id in page
  state only; "Show all bills" clears it).
- **Family members at the desk (decision 9).** The desk never browses an account's family list (privacy, per Q14). The booking form asks "Who is seen":
  the account holder, or a family member named here (name, relation from `DESK_RELATIONS`, optional gender and past date of birth, checked as
  `deskPatientSchema`); the server reuses an active family member with the same name and relation. Sent as `patient {name, relation, gender?,
  dateOfBirth?}`; the receipt names them (and whether they were added). The day list and the panel show "Mother of Kiran Shah". `patient
  {dependentId}` is typed but not offered (no picker without a family list).
- **Part payments and split methods (decision 5).** Owners (admins as owner) set "Payments at the counter" on the profile (`allowPartPayments`, checked
  against a fresh read, sent with `expectedUpdatedAt`; 409 RECORD_CHANGED re-reads). A payment is one or several methods whose amounts (rupees in
  the UI, paise on the wire, WQ2 helpers) add up to it; off = exactly what is due, on = anything up to it; more than is due is refused before
  sending (`paymentProblem`) and by the server (AMOUNT_EXCEEDS_DUE, PART_PAYMENTS_NOT_ALLOWED, LIFECYCLE_VERSION_CONFLICT in words). Every payment
  is sent as `splits` with the server's request key and `expectedLifecycleVersion`; a lost answer resends the same request (replayed by key). The
  bill as read settles a stored payment: its own receipt (event with its key) = recorded; the bill past the version it named, or cancelled =
  never recorded. After a reload a new payment may be recorded once the bill shows no receipt (both name versions, so only one can land). The bill
  shows Paid x of y / Due, state "Partly paid", each payment's methods and amounts; the list filters partly paid and shows what is due. Cancelling a
  bill with payments records the refund of all that was paid (`refund.amountMinor`; REFUND_AMOUNT_MISMATCH re-reads).
- **Doctor ↔ clinic links (decision 6).** The clinic Doctors screen has no Invite form; it keeps the list and, for the owner (admins as owner),
  "Remove" (`DELETE /clinic/doctors/:doctorId`, confirmation; DOCTOR_IS_OWNER shown). Earlier invitations stay listed (staff.manage) with Revoke.
  Admins (admin-as-owner page) "Add doctor": search verified, active doctors (`GET /specialists?search=&isVerified=true&isActive=true`), choose, pick
  branches (every branch or in-clinic branches), confirm, linked once per request key (stored before sending; a resend answers the same link; a
  doctor already on the list settles it; forgetting is safe because a second link is refused DOCTOR_ALREADY_MEMBER). Doctors: invitations show
  "No longer valid" with Dismiss (decline) only. "Your own clinic": "Create my clinic" (`POST /specialists/me/clinic`, keyed; the same once-only
  shape, a lost answer looked up by key `GET /me/clinic/by-key/:key`; DOCTOR_CLINIC_EXISTS settled with that said; offered only to active, verified
  doctors). The clinic then shows pending verification and how to open its workspace (sign in as clinic staff with the doctor's mobile).

Q14 review follow-ups (announced by the backend, built ahead of its commit): the desk answer's `patient.created` is not used (the receipt no
longer says whether a family member is new); a bill for an appointment is made out to its account holder (prefilled from the appointment, name and
mobile fixed while linked; 409 APPOINTMENT_CUSTOMER_MISMATCH in words); 503 INVOICE_INDEXES_OUTDATED on a payment is shown as the server says and,
on a sole first attempt, ends it (nothing was written); a ₹0 bill is marked paid with a plain `{mode}` (still keyed and version-fenced); a lab
booking moved after a no-show offers neither "Propose a new time" nor "Reject"; customer bill events are read without keys or staff ids, and the
customer bill shows partly paid, each payment's methods and what is due.

Independent review of 915a2db..6b9ce70 (against Q14 d29b72e), fixed:
1. **Payments and cancellations name what was reviewed.** The payment confirmation captures the bill version, the due and the amounts when it
   opens, shows and sends exactly those (`expectedLifecycleVersion` = the reviewed version, never the one on screen at the click); a newer
   version (a background re-read) closes it with "This bill changed — check the amounts again." The cancellation captures the paid amount with
   its version on opening; the refund names that amount; a newer version closes it and asks again. (Two cashiers each recording ₹300 can no
   longer make ₹600 out of one reviewed ₹300.)
2. Doctors are not offered "Reschedule no-show" on desk appointments (`doctorNoShowMove` → 'clinic'): "The clinic can move this appointment";
   409 CLINIC_APPOINTMENT has the same words.
3. A desk receipt's "Make a bill for this visit" is prefilled from the appointment row as the server lists it (account holder's mobile and name),
   never from this device's memory (gone after a reload); until the row is read it points to the row's "Create bill".
4. The part-payment setting's messages live outside the subtree keyed by the partner version, so "someone else changed this" and RECORD_CHANGED
   are shown; a save says "Saved."
5. The bill handover is bound to its navigation: a one-time token in the route state; the form takes the prefill only when its route state names
   the token, and clears it once read; a modified click (new tab) hands nothing over.
6. The doctor's appointments show a move's notice even when the moved booking left an otherwise empty list.
7. Admin doctor search says what it is: whole words of the full name or speciality (no mobile numbers, no partial names).
8. A payment resend refused for good (503 INVOICE_INDEXES_OUTDATED, 409 PART_PAYMENTS_NOT_ALLOWED / AMOUNT_EXCEEDS_DUE / PAYMENT_METHOD_REQUIRED /
   REQUEST_KEY_REQUIRED / INVALID_AMOUNT, any 400/403/404/422) settles it as not recorded on ANY attempt and unlocks the bill: the server looks
   for this key's payment first and these abort. Version and state conflicts, network losses and other 5xx stay unknown.
9. Copy: "Our admin team adds doctors to your clinic"; a missed instant consultation never mentions a new time; the owner-doctor consults at every
   branch of their own clinic (Q14 review 4); a family member's date of birth is checked as the server does (its UTC midnight not after now).
10. Test races fixed (test code only): the lost-UPI journey arms its failures only after the bill is read; the admin partners journey waits for
   the filtered request before asserting the empty row.

Assumed (not in Q14): nothing on the wire. Not shown because the server does not send it: desk rows' no-show history (`deskView`), so the desk's
"used" state comes from the 409. Admin search by mobile depends on the server's text index (rows show each doctor's mobile to check). The admin route
for moving any doctor's no-show is in `doctorAdminApi` but has no screen yet (no admin consultation-bookings page).

Verification: see the 2026-11-18 WQ8 row below. Playwright ran on ports 5291 (workspace) and 5292 (customer) with temporary configs
(`reuseExistingServer: false`), not committed.

## WQ9 sign in with a mobile number or an email (2026-11-19, taken autonomously at the owner's request)

Owner: "we have email OTP too, why aren't we going for email? make either of both as necessary". Every account type signs in with a mobile number
or an email. Backend (read-only): `SwasthaDisha-worktrees/q14-owner-decisions` `m0/q14-owner-decisions` 13e40c5 plus the partner-email change
still uncommitted in that worktree on 19 Nov (field names below checked against it): `auth/validation` (`sendOTPSchema`/`verifyOTPSchema`: `phone`
or `email`; customers exactly one, `selectCustomerLoginContact`, email lower-cased), `auth/services` (partner sign-in by email: memberships found
by the lower-cased email; the Q7 selection ticket carries the proven phone or email, so `POST /auth/partner/select` is unchanged),
`partners/{validation,routes,controller,services}` (member `email`, `PUT /members/:memberId/email`, `EMAIL_IN_USE`).

- **One field on both apps.** "Mobile number or email" (`parseLoginIdentifier` in `packages/api/src/auth.ts`, unit-tested): anything with an `@` is
  an email, trimmed and lower-cased, checked with the same pragmatic pattern as other email fields (the server's Joi check still decides); anything
  else must be 10 digits after dropping spaces and dashes and an optional +91 / 91 prefix. Exactly one of `{ phone }` / `{ email }` is sent (the
  customer xor). The destination the code was sent to is kept in component memory and used for verify, resend and (workspace) the Q7 choice; the
  choice step says "Your number/email belongs to several workspaces". The code step says "We sent a 6-digit code to your phone/email" with the
  destination masked (`maskTarget`: last 4 digits; first character and domain of an email). "Change number or email" goes back with what was typed.
- **Limits and errors unchanged.** The 30-second resend gap and a 429's Retry-After countdown belong to one destination (`targetKey`): another number
  or email can still be used. A burnt code (`OTP_ATTEMPTS_EXCEEDED`) clears the field; `SELECTION_EXPIRED` asks for a new code. Server messages are
  shown as before; nothing new is revealed (no "is this email registered" answer).
- **Privacy.** The phone, email, OTP, ticket and token are never written to localStorage, sessionStorage, logs or URLs (journeys check storage and
  the address bar after an email sign-in on both apps). The admin create-partner request, owner email included, stays in session memory only; its
  reload marker holds only the request key (D4).
- **Staff email (partners).** The staff list has an Email column. Add a staff member takes an optional "Email (optional)" (`addMemberSchema.email`;
  anyone with `staff.manage`, owners and admins as owner included). Changing or removing an existing member's email ("Add email" / "Change email")
  is owner-only (admins act as owner), for any active member including owners, matching `updateMemberEmail` (403 `OWNER_REQUIRED` otherwise). The
  editor uses the member-draft rules of the other member edits: the member is read again right before sending, the save carries its `updatedAt` as
  `expectedUpdatedAt`, 409 RECORD_CHANGED shows the saved value; empty sends `email: null` (removes it); a late answer settles only while the editor
  is open and the save is the latest started there. 409 `EMAIL_IN_USE` (another active member of the same partner signs in with that email) is shown
  on the email field and nothing is added or changed. No request key: neither endpoint takes one (adding twice is refused as MEMBER_ALREADY_EXISTS;
  the email edit is fenced by version).
- **Admin create-partner** takes an optional "Owner email (optional)" (`createPartnerSchema.firstOwner.email`), inside the existing Q8 exactly-once
  request (same key and content on resend). A refused create (`EMAIL_IN_USE` or any other definite refusal of the first attempt) unlocks the form
  with the field marked; a new submission gets a new key.

### WQ9 review fixes (2026-11-19)

Independent review of a7d6284, and the owner's decision that **no new account starts from an email**. Backend: 49c3bdd plus
edits not yet committed in that worktree on 19 Nov, which match the following: `EMAIL_NOT_REGISTERED`, `OWNER_REQUIRED`
on an add with an email, no doctor email copied to clinic memberships, and a changed member email ends that member's sessions.

- **No account from an email.** A customer, doctor or pharmacy sign-in with an email no account uses gets 404
  `EMAIL_NOT_REGISTERED` ("No account uses this email. Sign in with your mobile number, then add this email to your
  profile."). Both apps show it on the identifier field (at send or verify) and go back to that step. The customer hint
  now reads: "New here? Start with your mobile number; an email works once you add it to your profile."
- **Customer profile email.** It is no longer saved through `PUT /users/:id`. It is added by proving it: `POST
  /auth/email-verification/send` then `/verify` (`customerApi.sendEmailCode/verifyEmailCode`). It has its own resend
  wait and a 429 countdown. The long-lived token in the verify answer is dropped. An answer settles only while the
  section is on screen and is the latest request; a verified email still refreshes the profile. Once set, the email is
  read-only ("To change it, contact support").
- **One email form everywhere.** `normalizeEmail` (`packages/api/src/auth.ts`) trims, lower-cases and converts the
  domain to its ASCII (punycode) form with `new URL('http://' + domain).hostname`. It refuses ports, paths, IP literals
  and whitespace. Chromium email inputs already answer punycode while text inputs answer Unicode. It is used by sign-in,
  staff add/edit, the owner email on create-partner and the profile email.
- **Staff.**
  - The Email field on "Add a staff member" is shown only to owners and admins acting as owner (`canGiveEmail`). A 403
    `OWNER_REQUIRED` on an add with an email is shown on the field.
  - An email save that lands after its editor was closed or replaced still refreshes the list; only the editor's
    notice and closing are skipped.
  - The editor says that changing or removing the email signs the member out.
- **Login.**
  - Each destination keeps its own resend/429 wait (`useCooldowns` in `packages/ui`, in memory), so A → B → A keeps A's wait.
  - The workspace role choice is frozen while a code is sent. Verify, resend and the workspace choice use the role
    captured with the destination.
  - `0` + 10 digits is a mobile number.
  - The field uses `inputMode="text"` and `autoComplete="username"`.
  - An email part of 2 characters or fewer is masked as `•••@domain`.
- **Doctor email.** No web copy or journey assumed the doctor's profile email was copied onto a clinic membership.
  Linked doctors sign in to the clinic with their mobile number unless an owner sets a sign-in email.

### WQ9 re-review fixes (2026-11-19)

- **Doctors and pharmacies:** they have no profile email screen. On the workspace, `EMAIL_NOT_REGISTERED` for these
  roles says "No account uses this email. Sign in with your mobile number. To use email sign-in, ask the Jansetu
  team to add it to your account." Other roles get the server's own message; the customer copy is unchanged.
- **Staff email editor:** it warns that changing or removing the email signs the member out only when the member
  already has one. A first email ends no session. That backend rule is in the q14-owner-decisions working tree but not
  yet in a commit (HEAD 14007e8 still ends sessions on any change), so check it again once committed.
- **Customer profile email:** after 422 `EMAIL_CHANGE_ADMIN_ONLY` or 409 `CONTACT_CHANGED`, the profile is read again
  (`['me']`), so an email set elsewhere is shown, together with the server's message.
- **`normalizeEmail`:** also applies Unicode NFC, so composed and decomposed accents give one address. The code step
  still shows the ASCII (punycode) domain. Decoding punycode for display needs a decoder the browser does not provide,
  and there is no dependency for it, so the display is left as it is.
- **Flaky spec:** in `admin-order-cancellations.spec.ts`, the first list request is now awaited with `expect.poll`
  instead of being checked once. It passed 120/120 with `--repeat-each 10`.

## WQ10a pharmacy: add and import stock, suppliers, order cancel, status words (2026-11-20, taken autonomously at the owner's request)

Backend (read-only): Q14 `SwasthaDisha-worktrees/q14-owner-decisions` `m0/q14-owner-decisions` 5ecd4ad: `src1/modules/pharmacyInventory`
(routes, validation `createInventoryItemSchema`, services `saveItems`/`saveItem`, repository `adjustBatchStock` and adjustments),
`pharmacyInventoryImports` (routes, controller, services `validateRow`/`preview`/`commit`/`retry`), `pharmacySuppliers` (routes,
validation, repository) and `pharmacyOrders` (services `updateStatus`, `requestCancel`), `pharmacyMedicines` (routes, validation). Every
endpoint is in `packages/api` (`pharmacyStock.ts`, `pharmacySuppliers.ts`, `pharmacyOrders.ts`). Built alongside WQ10b; shared files
(`packages/api/src/index.ts`, `apps/workspace/src/modules.tsx`) only gained lines in the pharmacy area.

- **Add stock** (`/pharmacy/stock/add`; "Add stock" on Stock, "Add a batch" on each medicine): medicine from `GET /pharmacy-medicines`
  (search, active, page 1 of 20), batch number, expiry (date input → YYYYMMDD, a real date, not before the server's UTC today), units
  (whole, at least 1), optional MRP / selling / purchase price (rupees), rack, reorder level, reason (`purchase`, `return`, `transfer`,
  `correction`, `other`) and note. Checked as `createInventoryItemSchema` and `saveItem` do, then a second step names exactly what is
  added; sent as `POST /pharmacy-inventory {items:[one item]}`. The route takes no supplier and no request key. The entry is stored
  (session memory + body-less marker) before sending; its key travels in `notes` ("<note> · Ref <key>"), which the adjustment it writes
  keeps, so a lost answer is found exactly in `GET /pharmacy-inventory/adjustments`. It is never resent (that would add the units
  twice): "Check whether it was recorded", and after a miss "Forget it and add again" behind a second step. A sole first attempt refused
  (4xx) records nothing and keeps the form.
- **Import stock from a file** (`/pharmacy/stock/import`, `/pharmacy/stock/imports/:id`): the columns `validateRow` reads (exact lower-case
  headers on the first sheet; expiry as text), a blank CSV template made in the browser, the mode (`upsert`, `update_only`,
  `create_only`), and the file (.xlsx/.xls/.csv, at most 10 MB) sent as multipart `file` + `importMode` to `POST /preview` from a Blob.
  The import page shows the counts and every row, problems first, with the medicine match (in the list / new: will be added / several
  match), "Download the rows with problems" (`GET /:id/failed-rows/download`, a Blob), and the confirmation (units, new medicines, rows
  left out) that sends `POST /commit {importId}`. The commit is stored first (key = the import id); a lost answer is settled from
  `GET /:id` (added / partly / not added; "being added" polls every 5 s), and sending again is safe because the server claims an import
  once (409 IMPORT_NOT_RETRYABLE / IMPORT_ALREADY_PROCESSING → the import as saved). "Try the failed rows again" (`POST /:id/retry`;
  one adjustment per row, so never twice) is offered when rows failed while being added. History: `GET /`, newest first. A lost file
  check only says so (a check adds nothing) and is found again in the history by file name.
- **Suppliers** (`/pharmacy/suppliers`, Pharmacy nav "Suppliers"): Active / Archived / All, add (name required; contact, phone
  `^[+0-9(). -]+$`, email, address optional, the server's limits), edit (`PATCH /:id`, only changed fields, emptied ones as null,
  `expectedRevision` = the revision the edit was opened on) and archive (`POST /:id/archive {expectedRevision}`, second step: it cannot be
  undone here). 409 SUPPLIER_CONFLICT keeps what was typed, takes the other person's change in fields not touched here and names fields
  changed in both. One change at a time, stored first; a lost add is found in the list by name (no request key exists), a lost edit or
  archive is resent safely (fenced by revision) or settled from the list. "Return to supplier" says when there is no active supplier and
  links to Suppliers; the list it offers refreshes after any supplier change.
- **Order cancel.** The order page showed "Cancel order" next to "Cancelling or rejecting an order is not available here yet… ask an
  admin". The backend's D3 `requestCancel` cancels Placed / Accepted / Packed orders (unpaid at once; paid, authorised or partly paid as
  a request), and the generic status update now refuses to close an order holding money (ORDER_PAID_USE_CANCEL_REQUEST, checked in the
  write), so the MONEY item above is closed by D3. The stale warning is gone; `cancelRefusal` (`packages/api`) mirrors `requestCancel`:
  Cancel order is shown exactly when it can work; a cancellable-state order whose payment is Refunded (refused by the server) shows one
  message instead and no button.
- **Status words.** `ORDER_STATUS_LABEL` / `PAYMENT_STATUS_LABEL` moved to `packages/api` (`orderStatusLabel`, `paymentStatusLabel`);
  Orders, the order page, Quality and the recall trace use them, and so do the prescription queue and review (they showed "pending").
- **Identity.** Each new screen is keyed by the pharmacy's id, which is also in its query keys and memory slots. Every change goes
  through the screen's one-at-a-time guard (`useOneAtATime`) and the shared `useOwnedOp` (stored before sending; an answer settles only
  while the page is on screen and owns the attempt).

Backend gaps (reported, not faked): `POST /pharmacy-inventory` takes no request key (the web finds a lost entry by the reference in
`notes`, but cannot make a resend safe) and no supplier; `POST /pharmacy-suppliers` takes no request key (a lost add is matched by name
and time); there is no un-archive. The import reads headers case-sensitively and reads a spreadsheet date cell as a number, so the
expiry must be typed as text; it accepts any `importMode` string unchecked (the web sends only the three); the preview answer includes
the server's file path (never shown). A medicine not yet in the list can only be added by import (the medicine create route is not used
here).
## WQ10b admin pharmacies, doctor no-show moves and lab report signers (2026-11-20, taken autonomously at the owner's request)

Backend (read-only): `SwasthaDisha-worktrees/q14-owner-decisions` `m0/q14-owner-decisions` 5ecd4ad ("only admins create pharmacies"). Every
endpoint below was read in its route, validation and service; field names, permissions and error codes are the backend's.

- **Report signer registrations (Q11).** `PUT /partner-workspace[/admin/:id/workspace]/members/:memberId/professional`
  (`memberProfessionalSchema`: `{ professional: { kind: pathologist|pharmacist|doctor, registrationNumber (trimmed, 3-60) } | null,
  expectedUpdatedAt? }`) in `partnerWorkspaceApi.setProfessional`. The route admits `staff.manage`, but `setMemberProfessional` refuses
  anyone but an owner (403 `OWNER_REQUIRED`), so the UI offers it to owners and admins acting as owner (`canEditProfessional`); staff
  with `staff.manage` see the new **Registration** column read-only and are told only an owner changes it. "Add registration" / "Change
  registration" opens an editor (kind and number, checked as the schema does) that follows the WQ9 member-edit rules: the member is read
  again right before sending, the save names that `updatedAt`, 409 RECORD_CHANGED shows the saved value, and an answer settles only while
  the editor is open and the save is the latest started there. A lost answer is settled by reading the member (it holds exactly what was
  sent = saved). "Remove registration" is confirmed first (they can no longer release reports; released reports keep theirs). The lab
  booking's signer picker no longer says registrations "cannot be added in the workspace yet": it links to Staff, and a 409
  `SIGNER_REGISTRATION_MISSING` on release says the same.
- **Admin pharmacies** (`/admin/pharmacies`, `packages/api/src/adminPharmacies.ts`). List (`GET /pharmacies` as admin: full records,
  newest first, `name` = part of the name, `isVerified`, `isActive`, 20 a page); "Add a pharmacy" (`POST /pharmacies`, admin only:
  `createPharmacySchema`, name and mobile required, optional email, owner, short name, address, city, state, PIN, GST, drug licence,
  pickup/delivery); a pharmacy page (`GET /pharmacies/:id`, `PUT /pharmacies/:id` with `updatePharmacySchema`): **Verify**
  (`isVerified: true`), **Deactivate** / **Activate** (`isActive`), each confirmed and under the page's one-at-a-time guard; **Sign-in**
  (mobile number and email: reviewed, then confirmed with what changes: "signs in with …; … no longer works"; PHONE/EMAIL_ALREADY_EXISTS
  on their fields); **Details** (only changed fields, after a re-read: a field someone else changed meanwhile is shown for review, never
  overwritten). `DELETE /pharmacies/:id` (archive) is not offered: deactivating does the same and can be undone.
  - **Exactly once without a request key.** The create takes no key, but the mobile number is unique among pharmacies (unique index on
    `phone`), so no request, resent or late, can make a second pharmacy with the same number. The submission is stored (session memory,
    body-less reload marker) before it is sent and sent under the central guard (`useOneAtATime`): a double click or a second submit
    sends nothing. A definite refusal of the only attempt unlocks the form. A lost answer locks it: "Check by mobile number" reads the
    list newest first (100 a page, back to an hour before the first attempt; there is no filter by number). Found with this name =
    created (open it); found under another name = the number is taken (the form unlocks, said on the field); not found = only now "Send
    again" (the same request) or "Start again" (confirmed: if the earlier request still lands it appears in the list and a new one with
    the number is refused). A resend refused PHONE_ALREADY_EXISTS is checked the same way. After a reload nothing about it is on this
    device (no number, no name): the admin is sent to the list.
- **Admin consultations** (`/admin/consultations`, `packages/api/src/adminConsultations.ts`). `GET /bookings?bookingType=consultation`
  as admin with `status`, `specialistId` (a doctor found with `GET /specialists?name=`, any status), `bookingDateFrom/To` and paging;
  `GET /bookings/:id` (the scrubbed no-show view: when, never who). The booking page shows the no-show history (missed, moved once, a
  final second no-show) and "Reschedule no-show" through the shared `NoShowMove` (request key and `expectedUpdatedAt` stored before
  sending, settled only while live and still current, a read after the last attempt settles a lost answer, NO_SHOW_RESCHEDULE_USED /
  SLOT_* refusals in words) with `doctorAdminApi.rescheduleNoShow` (WQ8, `POST /specialists/admin/bookings/:id/reschedule-no-show`).
  The slot picker reads `GET /slots/available?specialistId=<the booking's doctor>&date&mode=<its consultation type>` (the only route
  that lists a doctor's free slots for an admin) and offers not-started slots with a seat, in-person to clinic slots only. Not offered:
  instant consultations ("never moved"), front-desk appointments ("The clinic moves this appointment"; 409 CLINIC_APPOINTMENT), a booking
  already moved once (disabled, "a second no-show is final").
- Admin pages keep their queries under `['admin', <admin id>, area]` and render under `key="admin:<id>"` (`useAdminScope`); list filters
  live in the address and two quick changes both count (`useListParams`). No number, email or patient detail is put in storage or URLs.

Backend gaps found (reported, not worked around on the wire):
1. `PUT /members/:memberId/professional` is guarded by `staff.manage` but the service is owner-only (OWNER_REQUIRED): the route guard and
   the rule disagree; the UI follows the service.
2. Pharmacies: no request key or by-key lookup on create (the unique mobile number stands in); no filter by mobile number (the check reads
   the list); no version fence on `PUT /pharmacies/:id` (a change landing between the re-read and the save can be overwritten, fields sent
   only); an optional field (email included) can never be cleared (the schema refuses empty strings); changing the sign-in number or email
   does not end the pharmacy's existing sessions; `update` does not lower-case a changed email itself (the model's `lowercase` and the
   client do).
3. Bookings: `bookingQuerySchema.status` refuses `no_show`, so no-shows cannot be listed on their own (the screen says so; they are marked
   in the unfiltered list). Booking rows carry no patient name.
4. `rescheduleNoShow` / `reserveSlot` do not check that the target slot belongs to the booking's doctor (the doctor and admin routes would
   accept another doctor's slot). The picker only offers the booking's own doctor's slots.
5. The admin no-show move notifies the customer only (not the doctor); the copy says the doctor sees it in their appointments.

## WQ10c merged WQ10 screens on the backend Q15 features (2026-11-20, taken autonomously at the owner's request)

Backend (read-only): `SwasthaDisha-worktrees/q14-owner-decisions` 1f1f995 (Q15) and 41e19f4 (Q15 review). Every field and code
below was read in its route, validation, controller and service. Built on `wq10/integration` (the merge of WQ10a and WQ10b).

- **Admin consultations.** "Status" now offers **No-show** (`GET /bookings?status=no_show`); the "cannot be listed" note is gone.
  Rows show **Patient** (`patientName`, admin rows only: the family member's or the account holder's name, null → "—").
  `GET /bookings/:id` does not carry the name, so the booking page reads the list for that doctor and day (`specialistId`,
  `bookingDateFrom/To` = the booking's day, 100 a page, at most 3 pages) and takes the row with its id; unknown → the earlier
  "The account holder" / "A family member…" words. The name is shown only on screen (never in storage, logs or the address).
  409 `SLOT_NOT_THIS_DOCTOR` is a slot refusal in `NO_SHOW_MOVE_REFUSAL` ("That time belongs to another doctor. Pick one of this
  doctor's times."): the picker reopens with the doctor's free times read again (doctor, admin and desk no-show moves share it).
  The move's confirmation now says the doctor is told too (Q15 notifies the doctor of an admin's move).
- **Admin pharmacies, create.** The phone-search lost-answer workaround is replaced by the owned-PendingOp / by-key pattern of
  the lab and clinic create: a `requestKey` per submitted form, stored with the request before sending, under the page's
  one-at-a-time guard. A lost answer locks the form with **Send again** (same key and details; a repeat answers 200
  `replayed: true` with the pharmacy) or **Give up this create** (`POST /pharmacies/by-key/:key/abandon`: `abandoned` = can
  never be created, the form unlocks; `used` = its page opens). After a reload only the key is kept: `GET
  /pharmacies/by-key/:key` (404 PHARMACY_NOT_FOUND = nothing so far) shows it, else Give up first. 409 REQUEST_ABANDONED ends it.
  A taken number (400 PHONE_ALREADY_EXISTS) names the pharmacy holding it, found with `GET /pharmacies?phone=` (exact).
- **Admin pharmacies, list.** "Find by mobile number" (`GET /pharmacies?phone=`, 10 digits) shows which pharmacy signs in with a
  number; the number stays in the page's memory, never in the address.
- **Admin pharmacies, edit (`PUT /pharmacies/:id`).** Every save (verify, activate/deactivate, sign-in, details) sends
  `expectedUpdatedAt` (the version shown, or the re-read right before the save). 409 RECORD_CHANGED → nothing saved, the
  pharmacy is read again: details rebase and name the conflicting fields (or `RECORD_CHANGED_MESSAGE`), sign-in shows what is
  saved, status steps say it changed meanwhile. An emptied optional field is sent as null (clears it); the name and mobile number
  cannot be cleared (said on the field). The email can now be removed. The sign-in confirmation says when the change **signs the
  pharmacy out** (a changed number, or a changed or removed email it had; a first email does not), and that an app signed in long
  ago may stay signed in until the pharmacy is deactivated (Q15: legacy 30-day bearer tokens). EMAIL_ALREADY_EXISTS (400, or 409
  after a race) is shown on the email field. Latitude and longitude are not edited here (the backend clears them together).
- **Pharmacy add stock.** The "Ref <key>" in notes and the adjustment-history search are gone: `POST /pharmacy-inventory
  {items:[one], requestKey}`; the note is sent as typed (up to 500). A lost answer is resent safely with the same key ("Send the
  same entry again"; a repeat answers 200 `replayed: true`, "Already added: … Nothing was added twice.") or checked with `GET
  /pharmacy-inventory/by-key/:key` (404 REQUEST_KEY_NOT_FOUND = not recorded so far). "Forget it and add again" stays behind a
  second step (no abandon exists for this key). No supplier is sent (stock rows have none).
- **Suppliers create.** `POST /pharmacy-suppliers` with `requestKey`; a lost add is resent with the same key or found with `GET
  /pharmacy-suppliers/by-key/:key` (404 SUPPLIER_NOT_FOUND). The name-and-time matching is gone.
- **503 INDEXES_OUTDATED** (keyed pharmacy create, stock save, supplier create, before `sync-indexes` has run): shown in the
  server's words plus "ask the Jansetu team" (`messageOf`); the PendingOp is kept, so the same request is sent again later.
- **Imports.** Guidance: column names in capitals or small letters; the expiry forms the server reads (YYYYMMDD as text or a
  number, YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY day first, MM/YYYY or MM-YYYY = the last day of that month, a real date cell);
  the "type the date as text" advice is gone. The rows show the server's own error ("expiry date must be a valid date: …").
  The screen only sends the three modes; nothing reads `filePath` (Q15 removed it from the answers).
- **Lab staff registration.** The route now refuses non-owners 403 OWNER_REQUIRED; the editor is already owner-only and shows the
  server's words (`messageOf` for 403), as the WQ10b journeys mock.
- `packages/api` gains `client.postKeyed` (returns `{ data, replayed }` from the top-level `replayed` flag).

Backend gaps left at the time (both closed by backend 4343d10 and the review fixes below): no abandon for inventory or supplier
keys; `GET /bookings/:id` had no `patientName` (the page read the doctor's day list).

### WQ10c review fixes (2026-11-20)

Independent review of `4749c76..30b62cd` (no blocking defects; proofs P1–P4 turned into journeys that fail without the fix).
Backend now q14-owner-decisions 36bc35a (4343d10: booking patient name, abandon routes; 36bc35a: import prices).

- **Backend adopted.** The booking page reads `patientName` from `GET /bookings/:id` (the list walk is gone). Add stock and
  supplier add offer **Give this up** (`POST /pharmacy-inventory/by-key/:key/abandon` → `{state:'abandoned'}` or
  `{state:'used', items}`; `POST /pharmacy-suppliers/by-key/:key/abandon` → `abandoned` or `{state:'used', supplier}`):
  abandoned frees the form (a late copy is refused 409 REQUEST_ABANDONED, which also settles a resend), used shows the
  recorded entry. "Forget it and add again" and its double-count warning are gone. EMAIL_ALREADY_EXISTS is 409 (400 still
  handled). Import guidance: grouping commas are fine ("1,000", "10,00,000"); a decimal comma or extra text in a price is
  refused on its row.
- **P1.** A lost entry found by key (or by giving up) clears the form as a success does, so it cannot be added again under a new key.
- **P2.** While a stock entry or an import step is resent, the unconfirmed panel stays, busy (only a first attempt shows
  the review busy); no form or second review opens.
- **P3.** A lost file check matches only an import of the same file name created after it was first sent (30 s for clocks),
  and never opens it: "An import of <file> started at HH:MM. Is this it?" with Open it / Upload again. A body-less marker
  restored after a reload is never matched.
- **P4.** An import in `committing` unchanged for more than 15 minutes shows "Adding stopped" with **Try again…** (`POST
  /:id/retry`, the backend's `staleCommitting`: its ready rows are added, none twice).
- A lost retry is settled only by an outcome written after it was first sent (30 s for clocks).
- Suppliers: a resend refused outright (not a version conflict) settles as not saved and frees the list; a lost edit or
  archive can be forgotten behind a second step.
- By-key lookups treat only their own 404 code (REQUEST_KEY_NOT_FOUND, SUPPLIER_NOT_FOUND, PHARMACY_NOT_FOUND) as "nothing so
  far"; any other 404 stays unknown.
- Admin pharmacies: the name searched is kept in page memory, not in `?name=` (address or history).
- Final review (N1, N2): giving up an entry whose first send is still in flight (after leaving and coming back) keeps the
  unconfirmed panel on screen, busy (add stock and suppliers); a supplier resend is settled as not saved only on
  REQUEST_ABANDONED or a content refusal (400/422): 401, 403 and other answers leave it unconfirmed, as add stock does.

## WQ11a pre-production review: customer app and sign-in on both apps (2026-11-22, taken autonomously at the owner's request)

Base `317f21e` (stage). Backend contract read-only: `SwasthaDisha-worktrees/q14-owner-decisions` (`auth/sessions.ts` logout/refresh,
`requestKeys`, `partners/services/labBookings.ts`, `payment/services` reconcile); Q16b partner-session rule read from
`q16b-identity` (uncommitted there). Scope: `apps/customer/**`, both apps' `LoginScreen` and `session.tsx`, `packages/api`
`auth.ts`/`client.ts`/`webSession.ts`, additive `packages/ui` changes. WQ11b (workspace partner/admin) and WQ11c
(doctor/pharmacy) run in parallel in their own worktrees.

- **1 Web sign-out never fire-and-forget (HIGH).** Before the logout is sent, `markWebSignOutPending(app)` records
  `sd:signout:<app>` = `{pending, at}` (no token, no person) in localStorage (sessionStorage if that refuses). The logout goes
  with `keepalive` and is retried with backoff (1 s … 30 s) while the page is open. Until the server answers, the sign-in
  screen says "You are signed out on this device. The server has not confirmed it yet…", and every start finishes the
  logout BEFORE any refresh (`restore`), never resuming; an unreadable record counts as pending (as N1 on the phone). The
  record clears only on the backend's own answer `data.signedOut === true` (re-review N4: a 200 page from something in
  front of the backend, or any refusal, is retried), when another tab finished it, or when a new sign-in replaced the
  browser's session (the server revokes the
  presented cookie's family on verify). A `signed-in` message from another tab stops this tab's retries.
- **2 Renewal without an answer keeps the session (MEDIUM).** `isTransientSessionError`: no answer, timeout, 408, 429, 5xx (and
  non-HTTP failures such as a busy secure store). Then the session stays, a quiet `Reconnecting…` status shows, the renewal
  is retried (2 s … 60 s, and at once on `online`), and the request that needed it fails with its network error (screens
  offer Try again). Only a definite answer (401/SESSION_ENDED or another 4xx) ends the session. Re-review N3: the same
  holds for the FIRST refresh at start-up: "Reconnecting… We keep trying" with backoff (2 s … 60 s, at once on `online`),
  and "Sign in again" as the way out; only a definite answer shows the sign-in screen. The renewal note is a slim bar
  above the page (in the flow), never covering the page title.
- **3 Lost create + definite refusal (MEDIUM).** A refusal for good of any attempt after an unanswered one is never
  settled locally (re-review N5: doctor bookings answer 400 SLOT_NOT_AVAILABLE / SLOT_FULL after the key lookup while an
  earlier attempt may still be on its way). `settleByAbandon` asks the server's abandon first: `abandoned` = it can never
  be made, the form opens with the refusal; `used` = its record opens; no answer = it stays unconfirmed. The in-memory
  panel also offers "Give it up and start again" on lab bookings, Consult now and doctor bookings.
- **4 Lab coupon and patient (MEDIUM).** Choosing who the tests are for re-checks the applied coupon ("Checking coupon…"),
  so Book never stays off silently. Doctor booking (its coupon is checked per patient) drops it and says so.
- **5 Sign-in accessibility (MEDIUM).** Field errors are `role="alert"` (shared `TextField`/`TextArea`; an outside
  `aria-describedby` is merged first). Focus goes to the code field on the code step, to the identifier on "Change number
  or email" / "Start again" / email-not-registered, and to the field a validation error is about. "We sent a code to …" is
  the code field's description. `Confirm` focuses its first button on opening (the consequence is the group's description)
  and returns focus to its opener on Back or when done (`Button` takes a `ref`, additive). Re-review N2: the initial
  focus is "Back", never the action, so Enter pressed twice cannot carry it out.
- **6 Profile check failing after the code (LOW).** The new session is ended (web: recorded + logout loop; phone: N1 clean-up),
  never left live.
- **7 Pay again after a refused check (LOW).** `paymentCheck`: 400 PAYMENT_FAILED / PAYMENT_REFUNDED = that attempt is over,
  so Pay now stays enabled (the server's `/pay` settles earlier attempts and decides). A capture the server returned to the
  wallet (`paymentRecord.status: 'refunded'`) is never "Payment received".
- **8 Cached data across people (LOW).** The query cache is cleared on every admission (sign-in or restore), not only on
  sign-out; the customer profile is keyed `['me', userId]`.
- **9 `noRenew` on logouts (LOW).** `logoutSession` / `logoutNative` never renew on a 401 (they run under the session lock).
- **10 Money words (LOW).** Lab and Consult-now expiry say any amount taken, including a payment captured after the window,
  is back in the wallet (the server's notification wording). Pay again shows the amount due and, once the server answered
  Pay now, the part held from the wallet and what the payment page asks for.
- **11 Doctor booking guards (LOW).** As `useOnceOnly`: only the newest attempt that still owns the slot, on a page still on
  screen, finishes the booking; payment and navigation never start for a page the customer left.
- **12 Notes.** Reload markers are kept through sign-out (D4; re-review N1 reverted the clear: clearing let a second booking
  be made beside an unanswered first one). They hold ids and times only. The shared-device identifier field is
  `autoComplete="off"` (the code field keeps `one-time-code`).
- **Q16b partner sessions.** Partner verify and select always send `session: 'cookie'` (web) or `'native'` (phone).
  `authApi.verifyOtp('partner', …)` and `selectPartner(…, { kind: 'bearer' })` are refused before sending (400
  SESSION_REQUIRED, as the server). A cross-origin (bearer) workspace build refuses lab/clinic sign-in before any code is
  sent: "Lab and clinic sign-in needs the workspace served from the Jansetu site itself (the same-origin build)…" (no
  cross-origin cookies are configured; stage and production use `VITE_API_SAME_ORIGIN=true`).

Assumptions: the marker's `localStorage` flag is not "patient data" (a boolean and a time); the backend's logout answer is
`{ success: true, data: { signedOut: true } }` (auth controller `logoutSession`, also in `q16b-identity`); a resend refused
for good is settled only by the server's abandon;
the wallet part of Pay again is known only from the server's `/pay` answer (the customer views strip `walletFunding`).

## WQ11b partner and admin screens: pre-production review fixes (2026-11-22, taken autonomously at the owner's request)

Backend (read-only): stage line `SwasthaDisha-worktrees/q14-owner-decisions` a1735c5, plus the two packets that landed the same
night and are adopted here: `q16b-identity` df87d96 (+ docs 8ec45e8) and `q16a-bookings-money` ab5d6df (+ de776ba, 28225e7).
Every route, schema and code below was read in its route, validation, controller and service. Built on stage 317f21e. The
reviewer's proof tests (`/tmp/review-5461/proofs/{labs,admin,org,desk}`) were turned into journeys in the repo; each new journey
fails on 317f21e (run against a copy of the worktree with the source at 317f21e and only the new tests and mocks).

**Deploy order.** The branch create now sends Q16b's optional `requestKey`; the stage backend before df87d96 refuses unknown
fields, so this web build must ship with or after Q16b. The admin "Cancel (admin)" buttons call Q16a routes: ship with or after
Q16a. Everything else works on a1735c5.

Shared pieces (also used by WQ11c's doctor, pharmacy and finance screens; every change is backward-compatible):
- **`ConfirmAction`** belongs to one step. When its `label`/`confirmLabel` change under it (Deactivate becoming Activate after
  a re-read) it closes; the refusal it showed, or a late answer of the step sent before, is shown next to the trigger with the
  step's name, never inside the other step's confirmation. New optional `version` prop: the confirmation remembers the version
  it was opened on and passes it to `onConfirm(reason, openedOn)`; if the record moves while it is open (and nothing is being
  sent) it closes with "This changed while the confirmation was open, so nothing was done…".
- **Keyboard focus** (`components/focus.ts`, `usePanelFocus`): an inline panel that replaces its trigger moves focus to its first
  control on every step and back to the trigger on Back or close, only when focus would otherwise be lost (on the body, or
  inside the panel). Used by `ConfirmAction`, `NoShowMove` and the lab collector, new-time, release and admin-cancel panels.
- **`NoShowMove`**: after a lost first send, a resend refused for certain no longer locks the move for the session. Once the
  booking, read after that attempt, is still a no-show, the panel offers "Choose a new time again" (a second step). The resend
  keeps the same key (the server answers the same request); a new time is a new move with a new key (a booking moves once
  only, so an earlier attempt arriving later makes the new one refused, never a second move). The stored op carries
  `refused`. Back from the confirmation starts the choice again (the picker remounts empty).
- **`noShows.ts`**: the lab move's slot refusal is `SLOT_UNAVAILABLE` (`partners/services/slots.ts takeSeat`), the doctor/desk
  one `SLOT_NOT_AVAILABLE`; both are slot refusals (picker reopens, slots read again) with the same words.
- **`requests.ts` `ownsKey`**: answers ABOUT A KEY (give-up `used`/`abandoned`, by-key lookups) settle what the page shows when
  the stored operation is that key or nothing is stored any more (a page left mid-send whose late answer already settled it).

Labs (`partnerLabs.ts`, `LabBookingsScreen`, `LabBookingScreen`, `AdminLabBookingsScreen`, `SlotsScreen`):
- **Lab bookings list (HIGH).** Q11 `listForPartnerPage` caps a page at 200 and answers `{ total, nextCursor }`; the web asked
  for 500 and dropped the cursor, so the newest (upcoming) bookings fell off. Now the list is paged with the server's exact
  cursor (`useInfiniteQuery`, 100 a page, "Show more (N more)"), with the total ("260 bookings · showing the soonest 100").
  The default view is **Upcoming** (from today, soonest first, optional "until"); **Past** is a separate view over chosen
  dates before today (a week back by default, oldest first within them, as the server sorts). `bookings()` returns a `Page`;
  cursors and page sizes are checked before any request.
- **Admin lab bookings.** Q11 `adminList` pages by number (default 50, at most 200, newest booked first): the web now asks for
  100 a page, shows the total and "Show more"; rows already shown are not repeated when a new booking shifts the pages.
- **Version fence.** Every lab step sends the `statusVersion` it was reviewed on (Q11 `expectedVersion`): button steps the
  booking as shown, confirmations (no-show, complete, reject) the version they were opened on, the collector form the version
  it was opened on, a new-time proposal the version at its review, a release the version its panel opened on. 409
  `LAB_BOOKING_CHANGED` says the booking changed and nothing was done; the booking is read again (every step re-reads it) and
  the open form adopts the version read.
- **Report uploads.** formidable's `maxTotalFileSize` defaults to the 10 MB `maxFileSize`, so two 6 MB files in one request
  were always refused (500 UPLOAD_FAILED) and shown as "may have been uploaded". Files now go one per request, each with its
  own Q11 `?requestKey=` (a resend after a lost answer is answered, never copied), each checked to be at most 10 MB first. A
  size refusal (400 FILE_TOO_LARGE, 500 UPLOAD_FAILED "max…FileSize exceeded", 413) says "File too large: … not uploaded";
  UPLOAD_FAILED is a definite "not uploaded" (the file service removes what it wrote before anything is attached). After a
  lost answer, "Upload the rest" sends the remaining files with the same keys.
- **Weekly template.** The editor reads the saved template (Q11 `GET /branches/:id/slot-templates/:mode`, null = none) instead
  of guessing it from generated slots (`deriveTemplate` removed), and saves with `expectedUpdatedAt` (its version, null when it
  started from no template). 409 `TEMPLATE_CHANGED` reads it again and shows the conflict (nothing overwritten); a lost answer
  is settled by reading the template (saved = what was sent). The "server does not return the saved template" text is gone.
- **Second no-show.** Marking a booking already moved once as a no-show now says this second no-show is final (no move).
- **Q16a admin cancel of a moved lab no-show** (`POST /partner-workspace/admin/lab-bookings/:id/cancel-no-show`, `{ reason
  3–500, refund boolean }`): an admin on a confirmed booking moved after a no-show gets "Cancel (admin)" with a required
  reason and a "Refund the patient?" choice with no default; refusals and a lost answer are said, the booking re-read. The
  `admin_no_show` cancellation reason is named. Q16a also makes the lab's earning the price after the coupon: the "Complete
  booking" text shows subtotal − discount.

Org (`StaffScreen`, `BranchesScreen`, `ProfileScreen`, `AuditScreen`, `ClinicDoctorsScreen`, admin `PartnerScreen`,
`PartnersScreen`, `NewPartnerScreen`, `draft.ts`, `partners.ts`):
- **Clinic doctors on Staff.** A member with `doctorId` shows "Clinic doctor" and no Remove: "A doctor of this clinic: removed on
  Doctors (owner only)" with a link (`removalBlock` blocks it too). Q16b 409 `USE_DOCTOR_UNLINK` on removal is said in words.
  The Doctors page no longer says "You can invite them again later" (clinics cannot add doctors; the Jansetu team links them).
- **Closed branches in branch access.** Staff reads closed branches too (owners and all-branch branch managers): a closed branch
  a member holds is listed "Name (closed)", can be unticked, and is never sent unless still ticked (`scopeProblem` refuses known
  closed ids). 400 `INVALID_BRANCH_IDS` is shown on the picker in words.
- **Owner sign-in email (Q16b).** Changing any owner's sign-in email is admin-only (403 `OWNER_EMAIL_ADMIN_ONLY`): owners' rows
  offer the email edit only to admins (`canEditEmail(actor, target, admin)`), and an owner added by a member has no email field
  (`canGiveEmail(actor, role, admin)`); members are told by the server.
- **Late save answers** close only the editor that made the save (Staff `closeIfOpen`, Branches `savedFrom`); another editor
  opened meanwhile keeps what was typed.
- **Edit conflicts (Branches; Catalogue the same).** Fields reset because someone else changed them are kept in a list until the
  person types them again; a save then says "… was saved, except the {fields}: someone else changed them …" (warn), never a
  plain "saved". Catalogue's 409 `CATALOGUE_ITEM_CHANGED` re-reads the item and shows the conflict.
- **Own save reported as someone else's change.** `rebase` judges "changed to something else" on canonical forms (trimmed,
  inner spaces collapsed, case ignored, also inside objects and arrays); whether a field changed at all stays exact.
- **Add branch.** Sends Q16b's optional `requestKey` (a repeat answers 200 with the first branch, `replayed`), one send at a
  time; after a lost answer the list is read again and a new branch of that name is taken as the one sent; if none is found
  the form locks with "Send again" (same key and details) or "Start again" behind a confirmation that warns about a duplicate.
- **Branch State code** must be a GST state code (`/^(0[1-9]|[12][0-9]|3[0-8]|97)$/`). Assumption: the backend schema takes any
  text, but bills compare it with the GSTIN's first two digits and `placeOfSupply`.
- **Partner name search** lives in page state, not the URL (an old `?q=` link is read once and removed from the address).
- **Activity log**: plain-words labels for every action the backend records (Q16b's `partner.create/update/verify/suspend`
  included), a readable fallback for later codes, and the record kind in words.
- **New lab/clinic, stale panel.** Give-up and the reload lookup act on the key (`ownsKey`): after leaving and returning
  mid-send, "Give up" opens the partner if it was made and unlocks the form if it was abandoned.

Money, desk and admin (`PharmacyScreen`, `NewPharmacyScreen`, `RefundsScreen`, `ConsultationScreen`, `InvoiceScreen`,
`NewInvoiceScreen`, `DeskScreen`, `CatalogueScreen`, `clinic.ts`, `adminConsultations.ts`):
- **Pharmacy Deactivate/Activate.** Each confirmation has its own key and `version={updatedAt}` and sends the version it was
  opened on; it always closes and the section says the outcome: done, refused (RECORD_CHANGED: nothing changed; other
  definite refusals "Not changed: …") or lost (read again: done if the pharmacy holds it, else "Not confirmed…"). An open Verify
  closes when the pharmacy changes under it. An **archived** pharmacy is never offered Activate: it says it is archived and
  the tech team restores it (Verify is still offered).
- **Stale unconfirmed panels** (NewPharmacy, NewInvoice, Catalogue, Desk): answers about the key use `ownsKey`, so "Give up"
  works after leaving and returning mid-send.
- **Bill resends** refused `REQUEST_ABANDONED` settle on any attempt (the bill was never issued; the form reopens).
- **Payment resends** settle as "not recorded" only on content refusals (400, 422, and the existing definite 409s); 401, 403
  and 404 come before the server looks for the key (`loadForActor`), so they stay unknown.
- **Unconfirmed payment**: "Forget this payment" (second step) once a fresh read of the bill shows no receipt for the key and
  the bill still takes a payment; an earlier send arriving later is refused by its bill-version fence.
- **Desk**: the Bill column is read again after a pay or cancel on the bill; "Mark as seen" is offered (disabled with the
  reason) only from the start time and Q16a 409 `NOT_STARTED_YET` is said in words; the second no-show confirmation says it is
  final when the server says the appointment was moved once, conditional words otherwise (the desk view carries no no-show
  history, in Q14 or Q16a).
- **Catalogue**: Reactivate/Enable show busy and run one at a time.
- **Refunds queue**: `order_cancelled` and the other causes in words; error codes readable with the code kept.
- **Q16a admin cancel of a moved consultation no-show** (`POST /specialists/admin/bookings/:id/cancel-no-show`, `{ reason 3–500,
  refund boolean }`, `BookingService.adminCancelMovedNoShow`): the admin consultation page offers "Cancel (admin)" on a pending
  or confirmed booking moved once after a no-show (never instant, never front-desk: `canAdminCancelMovedNoShow`), with a
  required reason and a "Refund the patient?" choice with no default; refusals in words (`ADMIN_CANCEL_REFUSAL`), a lost
  answer settled by reading the booking (cancelled = done; the server never refunds twice), and a cancelled one says whether
  the patient was refunded (`noShowCancel`).
- **Other Q16a rules adopted**: the desk's "Did not come" is offered from 15 minutes after the appointment time
  (`NO_SHOW_GRACE_MS`, refusal `APPOINTMENT_NOT_STARTED`); the new-bill preview charges CGST and SGST each at half the rate,
  rounded on their own (`computeTotals`).

Assumptions: the Past view sorts as the server does (oldest first within the chosen dates; the server has no newest-first
partner list); 100 rows a page for both lab lists; the "Complete booking" earning follows Q16a (after the coupon); the desk's
"Mark as seen" rule uses the page clock and the server's 409 has the last word; a 422 is a content refusal like a 400.

## WQ11c pre-production review: doctor, pharmacy and finance screens (2026-11-22, taken autonomously at the owner's request)

Branch `wq11c-doctor-pharmacy` from stage `317f21e`. Backend (read only): stage line `q14-owner-decisions` a1735c5; **Q16c
pharmacy committed** (`q16c-pharmacy` 5499417 + 788d268, design table row "Q16c") and adopted; **Q16a bookings not
committed yet** (`q16a-bookings-money` working tree read only), so its doctor codes are handled generically. The
reviewer's proofs (`/tmp/wq10-review-5471/proofs`, PROOF-D1–D3, S1–S2) are journeys now, each failing without its fix.
Parallel packets: WQ11a (customer app, sign-in), WQ11b (partner/admin, `NoShowMove`, `ConfirmAction`): this packet only
uses those two components; `noShows.ts`, `requests.ts`, `client.ts` and `styles.css` get strictly additive changes.

Owner decisions (22 Nov): dates stay day first, said plainly, with a template; a medicine created by an import needs a
prescription unless the file says no; an optional supplier per delivery (Add stock, import).

- **1 HIGH: blank import prices.** Q16c: a blank price cell is "not given" (left out of the row) and keeps the stored
  price; a typed 0 sets 0. The column guide says "Optional — blank keeps the current price"; the preview shows the price
  that will apply: a number (₹0.00 for 0, never "—") or "Current price kept"; a row that sets a price to ₹0 says so
  ("Sets the MRP, selling price to ₹0") and a warning above the confirmation names those rows. The confirmation names the
  rows whose prices change (and how many go to ₹0), and a new medicine without a retail price is "not on sale until
  priced" (Q16c: unpriced items are off the customer shelf); "on sale at once" is no longer said. `importPlan`,
  `importPriceOf`, `importZeroPrices` (api).
- **2 MEDIUM: Mark completed.** `appointmentActions` offers `complete` only once the start time has passed (as no-show).
  Q16a's 409 `NOT_STARTED_YET` (and its no-show grace 409 `APPOINTMENT_NOT_STARTED`) are said in words
  (`APPOINTMENT_REFUSAL`), and the list is read again.
- **3 MEDIUM: no-show slot picker.** `GET /specialists/me/slots` returns the stored slots with `serviceModes` and
  `branchId` (confirmed in `findManagedBySpecialistId`). `noShowSlotFits`: a slot with types takes only those
  (`assertSlotMode`); an in-person visit stays at its clinic branch (or, without one, at a slot with no branch: the doctor's
  own place); an online one moves to a slot without a branch. Options and the confirmation name the place ("Sunrise Clinic ·
  MG Road", "your own place", "online"; branch names from the doctor's clinics). The type refusal (409 `SLOT_NOT_AVAILABLE`
  "not offered for that consultation type") is renamed `SLOT_MODE_NOT_OFFERED` by the api (doctor and admin moves) and
  said as such ("That time is not offered for this consultation type"); the picker reopens and the slots are read again
  (`onSlotRefused`).
- **4 MEDIUM: prescriptions of new medicines.** Q16c default (yes unless "no"); the preview shows "Needs a prescription" /
  "Not needed" for new medicines ("As in the list" otherwise: an import never changes an existing medicine); the
  confirmation counts the new ones that need one.
- **5 LOW-MEDIUM: extension lock.** After a same-key resend is refused outright (4xx, not 408/429: that key was not
  recorded when it arrived), **Choose another extension** frees the field with the minutes (a new key). After a check finds
  nothing (also after a reload), **Forget it** frees it behind a second step that says a late copy may still be added.
- **6 LOW: restored retry.** A step's kind survives a reload (a commit is keyed by the import id, a retry by a new key), so
  a body-less retry is settled only by an outcome written after its `firstAttemptAt` (30 s for clocks); an older outcome
  ends the marker with "The earlier try of the failed rows has not started…" and the retry is offered again.
- **7 LOW: discard and same file.** The backend has **no route to discard a preview (gap, reported)**: **Discard this
  preview…** hides it on this device for this sign-in (session memory, never storage): the page and Recent imports show
  "Discarded on this device", nothing can be confirmed from it until **Use this preview after all**. Before committing,
  another import of the same file name added (or being added) in the last 24 hours is warned about, with a link.
- **8 LOW.**
  - Upload, commit and retry wait 120 s (`RequestOptions.timeoutMs`, additive in `client.ts`). While an import step is
    unconfirmed the page reads the import every 5 s and an outcome that settles it ends it on its own.
  - The confirmation count follows the mode: "Only medicines already in my stock" leaves out rows for medicines not in the
    list ("skipped and not counted"); "Only medicines not yet in my stock" says "up to"; the outcome counts skipped rows.
  - A failed read again keeps what was read (Appointments today/14 days/one day, Home, Consult now offers and running
    list): "Could not refresh just now (…). Showing what was read at HH:MM." with **Try again**; only a first read that
    fails is an error page.
  - Presence: a read is not a check-in, so after a reload (or on load) the first heartbeat goes at once (held back by a
    change or read, it is tried again each second, 5 times), then every minute.
  - `keyedLookup(key, find, notFoundCodes)`: the doctor's clinic (`CLINIC_NOT_FOUND`), payouts (`PAYOUT_NOT_FOUND`) and
    adjustments (`ADJUSTMENT_NOT_FOUND`) treat only their own code as "not recorded"; another 404 is a failed check.
    Desk and catalogue (WQ11b's screens) keep the old behaviour.
  - Return to supplier, Add stock and Import list every active supplier (`allSuppliers`, all pages), with **Find the
    supplier** when there are more than 12.
  - Add stock with an unknown or malformed `?medicine=`: "Medicine not found — pick another." with the picker (a malformed
    id waited forever; an unknown one showed an error).
- **9 Q16c codes.** Template `GET /pharmacy-inventory-imports/template` (xlsx by default) is downloaded when the server
  answers; otherwise the page makes a CSV with the same 16 columns (Q16c order, `supplier` last) and the same example row
  (expiry `31-12-2027`, name "… (example - delete this row)", which Q16c refuses). Upload refusals in words:
  `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`, `UNEXPECTED_FILE_FIELD`, `UPLOAD_INVALID`, `PARSE_FAILED`, `IMPORT_FILE_EMPTY`,
  `IMPORT_COLUMNS_MISSING` (unknown codes: the server's words). Month-first dates are refused per row by Q16c; the import
  page explains them ("This file writes dates month first…"). Supplier per delivery: Add stock sends `supplierId` (only
  ever with received units); the import sends the form field `supplierId` for the whole file, or the file's `supplier`
  column is used (rows show `supplierName`); the import page names the file's supplier (Q16c keeps only its id: the name
  comes from the supplier list, archived ones included); `SUPPLIER_NOT_FOUND` / `SUPPLIER_ARCHIVED` are said in words and
  the suppliers are read again. **Stock history** (new, on Add stock: `GET /pharmacy-inventory/adjustments`, 20 a page)
  shows each delivery's `supplier.displayName`. "Today" for expiry is the India date (`serverToday`, as Q16c).
- **Docs.** Pharmacy guide: day-first dates and the template, supplier per delivery, blank prices, the prescription
  default, discard, stock history. Doctor guide: Mark completed after the start, the no-show picker's place, extensions,
  refresh notes, the heartbeat at load.

Assumptions (owner to confirm): an in-person no-show without a clinic moves only to a slot without a branch, and an online
one never to a clinic slot; a discarded preview is hidden per sign-in on this device only, until the backend adds a
discard route; the same-file warning reads the first 20 imports (newest first); the local template is used whenever the
server's cannot be had (before Q16c deploys, the stage server answers the path with a 500).

Backend contract: **confirmed** (Q16c committed, read in its routes, controller, services and design row): blank prices,
prescription default, upload codes, month-first row refusal, template route and columns, `supplierId` on Add stock and on
the import form, the `supplier` column and `supplierId`/`supplierName` on rows, `supplier` on adjustments, the import's
`supplierId`, 404 `SUPPLIER_NOT_FOUND` / 409 `SUPPLIER_ARCHIVED`, IST "today"; slot `serviceModes`/`branchId` (stage).
**Assumed** (Q16a uncommitted, read in its working tree): 409 `NOT_STARTED_YET`, 409 `APPOINTMENT_NOT_STARTED` (no-show
grace); the type refusal stays `SLOT_NOT_AVAILABLE` with "consultation type" in its message (matched by message).
**Gap:** no route to discard an import preview.

### WQ11c re-review fixes (2026-11-22)

Re-review of `b0a64a4` (every first-round finding closed; fit for stage with backend Q16c). New items, each with a journey
that fails without its fix (proofs `/tmp/wq11c-review-5473/proofs` NEW-1–NEW-7):

- **N1.** While any ready row's name contains `TEMPLATE_EXAMPLE_MARK` the confirmation is not offered: "Row N is the
  template's example row … Delete it from the file and upload the file again" (whatever the backend; discard still works).
- **N2.** Add stock names the supplier only when the delivery as recorded carries it: the save answers only the items, so
  the newest matching adjustment (medicine, batch, units, `add`, since the first send) is re-read; otherwise "Added …
  (supplier not recorded)" (or "supplier not confirmed" when the history cannot be read). The import page shows a
  supplier only from the preview's answer (`supplierId`); a supplier chosen for the file that the answer does not carry is
  said ("… the server did not record a supplier for it").
- **N3.** "Discard this preview…" is disabled while a confirmation is being sent or is unconfirmed, and runs under the
  page's one-at-a-time guard.
- **N4.** `importPriceView`: a blank cell keeps a current price only when there is one. With Q16c's per-row
  `inMyStock` / `currentPrices` (on the row itself, not in `data`: adopted in the WQ11 integration below): a medicine not yet in my stock (or
  a new one) shows "No price yet", and its selling price "Not on sale until priced"; a known current price shows "Kept:
  ₹…"; without the fields "Current price kept". The confirmation counts every row that leaves a medicine unpriced (new,
  not in stock, or selling price 0).
- **N5.** One failed read again of the import keeps the page with a quiet note ("Could not refresh just now…"); a read
  that failed is never used as the import as it is now (a check says it could not check).
- **N6.** A retry stores the outcome on screen when it was sent (`since`, the import's `updatedAt`): only another outcome
  (written after the first send, 30 s for clocks) settles it. A body-less marker after a reload needs an outcome strictly
  later than its first send (no allowance).
- **N7.** Wholesale and purchase prices are shown in the preview when a row changes them. "Patient did not come" from 15
  minutes after the start (Q16a `NO_SHOW_GRACE_MS`; still uncommitted there). A booking whose time cannot be read still
  offers Mark completed (the server decides). Guidance true only with Q16c is kept (shipped together).

## WQ11 integration: WQ11a + WQ11b + WQ11c on the final Q16a/Q16c contract (2026-11-22, taken autonomously at the owner's request)

Branch `wq11/integration` from stage `317f21e`; merged in order `wq11a-customer-signin` (c0db443), `wq11b-partner-admin`
(711f858), `wq11c-doctor-pharmacy` (2eee5e9). Backend read-only: `q16c-pharmacy` bbc467e; `q16a-bookings-money` at ab5d6df +
28225e7 plus its uncommitted re-review work (read in the worktree, still being finished).

Merge conflicts and how they were resolved (both sides' behaviour kept):
- `docs/PLAN.md` (both merges): every section and verification row kept; the WQ11c rows grouped with the other 2026-11-22 rows.
- `packages/api/src/client.ts` `RequestOptions`: WQ11a `keepalive` (sign-out outlives the page) and WQ11c `timeoutMs` (long
  uploads) side by side; the request uses both.
- `packages/api/src/noShows.ts` `isSlotRefusal`: WQ11b's `SLOT_REFUSAL_CODES` (with the lab's `SLOT_UNAVAILABLE`) kept as the one
  list, WQ11c's `SLOT_MODE_NOT_OFFERED` added to it (both are "pick another time": picker reopens, slots read again).
- Auto-merged and checked: `packages/api/src/index.ts` (each branch's exports), `apps/workspace/src/requests.ts` (WQ11c
  `keyedLookup(…, notFoundCodes)`; WQ11b callers keep the old any-404 rule), `partners.test.ts`. There is one focus helper
  (WQ11b `components/focus.ts` `usePanelFocus`); WQ11a's `Confirm` focus is the customer app's own and WQ11c adds none.

Final backend contract adopted:
- **Q16c import preview rows** (`enrichPreviewRow`): `inMyStock` and `currentPrices {mrp, retailPrice, wholesalePrice,
  purchasePrice} | null` are on the row itself, not in `data` as WQ11c assumed: `ImportRow` and `importPriceView` read them
  there (`ImportCurrentPrices`). 400 `IMPORT_FILE_TOO_BIG` (more than 200,000 cells, or a read over 5 s) is said in words.
- **Q16a admin cancel of a moved no-show**: a repeat is refused 409 `ALREADY_CANCELLED` (consultation: `cancelBookingSettlement`
  with `movedNoShow`; lab: `adminCancelMovedNoShow`). Both pages say "already cancelled: nothing more was done" (the
  consultation one with how it was cancelled, read again), never "Not cancelled".
- **Q16a instant accept**: 409 `OFFER_NO_LONGER_AFFORDABLE` (`feeAffordable`: the coupon worked out again on the fee) in words.
- **Q16a desk move after the start** (`rescheduleDeskAppointment` no longer passes `refuseStartedSource`): "Move to another
  time" stays offered for a started desk appointment (a late patient) until it is marked seen or did not come.
- **Q16a lab no-show** (`labSlotEnd`, 409 `SLOT_NOT_STARTED`): offered only once the arrival window has ENDED (was: started).
- **Q16a multi-seat windows** (`reserveSlot`, `bookableNow`): a started doctor session with `maxBookings` > 1 is admitted until
  it ends, so `movableSlot` (doctor and admin no-show moves) offers it until its end; one-patient slots until their start.

## WQ11d: review fixes on wq11/integration and the Q16d rules (2026-11-22, taken autonomously at the owner's request)

Review of `0dde0fb` (fit for stage, with these fixes). Backend read-only: `q16-integration` (Q16a+Q16b+Q16c merged, 01c0899)
with its uncommitted Q16d work (`bookableUntilOf`, `noShowAllowedFromSlot`, `USE_CLINIC_CANCEL`, `batchInStock`, desk "seen"
on the day). Every fix has a journey or test that fails without it.

- **Focus (MEDIUM).** `components/focus.ts` `focusTarget`: a panel opens on its first field when that is a field (a reason,
  a time), else on its Back button (`data-focus-back`), else on the panel itself; never on the action, so Enter twice does
  not carry out an irreversible step (ConfirmAction, NoShowMove, the lab panels, the admin cancel).
- **Q16d.** The desk marks "seen" any time on the appointment's own India day (409 NOT_STARTED_YET only before that day). A
  no-show in a session with several seats waits for 15 minutes after the session ENDS (one-patient slots: 15 minutes after
  the start): the doctor's appointments read the day's slots (`sessionEndOf`; no-show hidden until that read answers), the
  desk uses its free-slot list when it lists the appointment's session (`DeskSlotKnown`); APPOINTMENT_NOT_STARTED in words on
  both. 409 USE_CLINIC_CANCEL in words, and "Cancel (admin)" is not offered for clinic-settled bookings. Import rows'
  `batchInStock`: a blank MRP of a batch not held yet shows "No MRP yet" (its `currentPrices.mrp` is null).
- **Template editor.** The save's answer is written into the cache and the template query is invalidated whether or not an
  editor is open; every opening reads it again and shows the form only from a read made since it opened ("Reading the saved
  template…" until then), so a cached copy older than a save is never shown and a late read never resets typing.
- **Add stock.** "Added N units …" shows at once from the save's answer (the form cleared in the same step); the supplier
  line says "checking the supplier…" until the delivery history answers.
- **Lab reports.** Uploads wait 120 s (`REPORT_UPLOAD_TIMEOUT_MS`). After an unanswered upload the same files and keys are
  kept and other files cannot be chosen until "Upload the rest" or "Check the reports" settles it.
- **Branches.** A refused resend of a lost branch create keeps the form locked (the first may still arrive): settled only by
  the branch list or "Send again".
- **Extensions.** "Choose another extension" reads the instant booking again first (a recorded one settles it) and says the
  one sent before may still have been added, with the time held now.
- **Smaller.** "Discarded on this device" survives a reload (the reload marker store keeps id lists only: `ID_LIST_SLOTS`).
  Another owner (or an admin) may remove an owner's doctor link on Doctors (Q16b N1); one's own link and a doctor's own
  practice are said. The admin no-show picker filters by consultation type and place and names the place. New-bill lines
  show GST as charged: CGST and SGST each rounded on their own. The lab booking page says whether an admin's cancel of a
  moved no-show refunded the patient. A stuck import can be tried again from a tab holding an unconfirmed step for it.
- **Info.** A very late keepalive logout fails safe (no change).

## WQ12 pharmacy: assisted booking for walk-in patients, booked consultations and the wallet (2026-11-22, taken autonomously at the owner's request)

Backend: `m0/r4-assisted-stage` fb4063c7 (assisted phase 0 + 1a merged on the stage line; design ASSISTED_BOOKING_DESIGN.md §17–§20).

- **Book consultation** (`/pharmacy/book`): phone → `POST /pharmacy-assisted/patients/lookup` (masked holder name; a new number is typed twice) →
  the phone's owner, a family member booked here before (`dependentId` from the pharmacy's own `/pharmacy-bookings` rows on that `contactNo`; the
  lookup never lists the family, by design), or a family member by name and relation → required "Patient agreed" tick (consent version
  `web-pharmacy-v1`, `en`) → doctors nearest first (`GET /pharmacy-assisted/doctors`), one doctor's times for 7 days
  (`GET /pharmacy-assisted/doctors/:id/slots`), mode and join → price and wallet → keyed `POST /pharmacy-assisted/consultations` (owned PendingOp,
  `stillCurrent`, `useOneAtATime`; lost answer: resend, `by-key` check, `abandon`). Every documented refusal in words (`assistedRefusal`); switch off =
  503 `ASSISTED_BOOKING_DISABLED` or a code-less 404/503. PRICE_CHANGED (fee or coupon) offers the named price as a new request. A sole first attempt
  refused 429 `ASSISTED_LIMIT_REACHED` is settled as not recorded (the server counts limits before writing; the shared rule keeps 429 unknown).
- **Booked consultations** (`/pharmacy/consultations[/:id]`): cursor list; detail with Join call (partner device, inside the window), cancel before the
  start (two steps, resend-safe: `alreadyCancelled`), the dispensing copy (no diagnosis; PDF via `/file/fetch`; `copyPending`) and an in-store pickup
  order from the prescription (`POST /pharmacy-orders` + `prescriptionFromBookingId` + `requestKey`; lookup/abandon kind `pharmacy_rx_order`).
- **Wallet** (`/pharmacy/wallet`): balance, on hold / owing, history by `signedAmountPaise` with `movementType` labels, Razorpay top-up (customer app
  pattern; workspace CSP now admits Checkout) → `/payments/verify` (no `module`) → fallback `POST /pharmacy-wallet/topups/:id/check`. Unfinished top-ups
  are kept by payment record id only (`wallet-topups:` id-list slot), with "Check my top-up". Starting a top-up is not keyed on the server; it moves no
  money (an unpaid order is never charged), so a failed start is simply tried again.
- Not built: booker reschedule (`/reschedule`), the typed-name edit (`PUT /pharmacy-customers/:id/typed-name`). Both built in WQ13.

### WQ12 review fixes (Opus xhigh review of c1e12b1, 2026-11-22)

- M1: giving a booking up (or a check finding it given up) clears the old review, so Pay can never resend the abandoned key. Only an `abandoned`
  answer counts as given up (booking and prescription order); anything else stays unknown.
- M2: only the modes the create accepts are offered (`supportedModes`: video, call, in-person); a time with none of them (chat only) is hidden.
- M3: consent `web-pharmacy-v2` with the owner-review wording (account for a new number, shared details, 90-day prescription view); the backend takes any
  `statementVersion` up to 40 characters.
- L1 coupon price note; L2 "Remove from this list" after an unpaid check (the server sweep still recovers a late capture); L3 a sole first attempt refused
  503 `ASSISTED_BOOKING_DISABLED` / `INDEXES_OUTDATED` / `CUSTOMER_LINKING_UNAVAILABLE` is "not booked", like a 429 limit (r4 `createPharmacyConsultation`
  throws each before any booking write: the switch first, the indexes before the replay read, customer linking before the transaction); L4
  `autoComplete="off"` on names and the problem; L5 the owner's languages (as, lus, mni, kha, grt, ne, brx, trp; bn and or were there); L6 `join.phone`
  only for a phone call on the patient's phone; L7 wallet paid / join words only on assisted rows; L8 Checkout that does not load: "No money was taken",
  not kept pending. The create and the prescription order have a 60 s client time limit.

## WQ13 pharmacy: change a booking's time, correct the typed name; admin pharmacy wallets (2026-11-22, taken autonomously at the owner's request)

Backend: the stage line with `m0/r6-small-fixes` 694bfaa9 (design ASSISTED_BOOKING_DESIGN.md §21.2), pushed to stage. Web: 8f892cc, pushed to
origin/stage after the Opus review.

- **Small fix**: `supportedModes` uses `Object.hasOwn` (inherited names such as `toString` are never a mode). The doctor card's "Next free
  time" is `nextFreeSlot`: shown only when the slot list would show it (in a supported mode, and in the chosen mode); otherwise "Choose to see
  the free times". r6 makes the server send only video/call/in-person; the client filter stays.
- **Change time** (booked consultation page): the rule in words (same doctor, before the start, same price and mode, patient and doctor told),
  the doctor's times for 7 days from `GET /pharmacy-assisted/doctors/:doctorId/slots?mode=<the booking's mode>` without the time it holds, a
  review, then `POST /pharmacy-assisted/bookings/:id/reschedule {slotId, requestKey, expectedUpdatedAt}`. Owned PendingOp, one guard for every
  change on the page (cancel, time, name). The server replays the same key and slot before its version fence, so a lost answer is resent
  unchanged; there is no by-key lookup, so the check reads the booking (its `slotId`). Refusals (`rescheduleRefusal`): slot taken / started /
  another doctor's / doctor busy / r6 `SAME_SLOT` → choose another time; doctor not available → cancel instead; `BOOKING_CHANGED` → read again;
  started, cancelled or finished → too late, the form closes.
- **Correct the name**: `PUT /pharmacy-customers/:id/typed-name {typedName}` (1–200 characters). It changes only the name this pharmacy sees;
  the patient's account never changes. `:id` = r6 `holder.pharmacyCustomerId` (null: no link, no edit); on q16 (no `holder`) the booking's
  `userId`, which the route also accepts, and only on the holder's own booking. On a family member's booking (r6) it corrects the "Name of the
  phone's owner"; the family member's name is the patient's to change. After saving, r6 `shownName` is said (on a `customer_order` link the
  account name stays shown); on q16 the booking is read again. Idempotent PUT: an unknown outcome is sent again with the same name.
- **Admin: Pharmacy wallets** (`/admin/pharmacy-wallets[/:pharmacyId]`, also linked from a pharmacy's page): search the admin pharmacy list, then
  the wallet (`GET /pharmacy-wallet?pharmacyId=`; null = no wallet yet), on hold / owing, recent history with each admin credit's note
  (`/pharmacy-wallet/transactions?pharmacyId=`), and Add money: whole rupees 1–2,00,000 (the upper limit is a client-side typo guard; the server
  has none), a required note (3–500), a review, and `POST /pharmacy-wallet/topup {pharmacyId, amount, notes}` with an `Idempotency-Key` header
  (the shared client's `idempotencyKey`). The key is the owned PendingOp's, made before sending; a lost answer is resent with the same key and
  body (the server replays; 409 `IDEMPOTENCY_KEY_REUSED` for another body), or found in the history by `referenceType: 'topup'` +
  `referenceId` = the key (also after a reload, when the body is gone and it cannot be resent). The S6 warning is on the form and the review.

### WQ13 review fixes (Opus review of 8f892cc, 2026-11-22; branch `wq13/fixes`)

- M1 (money): "Check" for an unconfirmed admin top-up reads the exact r7 route first (`GET /pharmacy-wallet/topups/admin/by-key/:key?pharmacyId=`
  → `credited` with the row, or `not_found`; backend `m0/r7-followups`, not committed there yet). On a server without it (the catch-all 404
  with no code) it searches the history: up to 20 pages of 20, with no time cut-off (the browser clock is not used). When the page limit ends the
  search: "Only the latest N movements were searched; the credit may be older. Ask the tech team before adding money again." "Forget it" needs
  a tick ("I understand the money may already have been added to this wallet") and says forgetting undoes nothing.
- L1: a resend answered `replayed` while the booking holds another slot says it was moved to that time earlier and has since been moved again.
- L2: a move settled by "Check" closes its review and the time list.
- L3: the typed-name "Check" compares the name stored on the link (`typedName` from `GET /pharmacy-customers`, paged by id with no `search`, so
  no name is in an address), not the name shown. Before r6, a failed re-read after saving claims nothing about which name is shown.
- L4: the family note says the family member is on the phone owner's account and only the phone's owner can change the name.
- L5: an unconfirmed typed-name edit is remembered under the link id (r6) or the booking id, never the patient's account id.
- L6: the top-up review shows the newest admin credit in the history (amount, time, note; "you" or "an admin").
- L7: failed reads on the wallet screens never say "Nothing was added"; an unknown top-up outcome reads the history again.

## WQ14 before production: admin top-up key after a reload, typed-name check (2026-11-23, branch `wq14/before-production`)

Backend: r7 `e90952cc` (`m0/r7-followups`: the admin top-up by-key read, design §21.3) is committed and on stage (origin/stage). This round
builds on r8 (`m0/r8-before-production`, design §21.4, local): B6 `dd8971b0` adds `holder.typedName` to the booker view. No visible change
except W3(c).

- W1 (money): after a reload, an unconfirmed admin credit that "Check" did not find and that was then forgotten (the tick and confirm are
  unchanged) may still be finishing on the server. Its key is kept in session memory for that admin and pharmacy, and the next credit
  reuses it with the new amount and note: the same body is replayed, another body is 409 `IDEMPOTENCY_KEY_REUSED` (shown with the existing
  "already used" words: the earlier credit exists), and a credit that never landed is added once. Once that request is sent, the stored
  request owns the key; only a refusal other than 409 `IDEMPOTENCY_KEY_REUSED` gives it back. After that, new keys.
- W2: the typed-name "Check" reads the booking once (`GET /pharmacy-bookings/:id`) and compares `holder.typedName` (r8 B6) with the cleaned
  name; the `/pharmacy-customers` paging is gone. Without `holder.typedName` (an older backend) the check says the outcome is not known yet,
  and sending the same name again (an idempotent PUT) settles it.
- W3: a 503 or 500 from the by-key read is thrown (unit test), never "not found" or "unavailable"; a check that fails hides "Forget it" again
  until a check succeeds; after the exact by-key read answers `not_found` the words are "Not found so far. …" (was "Not found in the wallet
  history so far. …"; the history search keeps its words).

### WQ14b follow-ups (review of 183a756, 2026-11-23; branch `wq14b/followups`)

- M1 (money): the carried key is kept in the pending-marker shape (`{requestKey, attempts: 0, firstAttemptAt, lastAttemptAt}`), so it
  survives a reload or signing in again as an opaque key only (no amount, no note). It has its own slot, so it is never shown as an
  unconfirmed credit.
- M2 (money): any unconfirmed credit that was checked and then forgotten carries its key, not only one restored after a reload (safer default
  chosen after review; owner informed).
- L1: "Forget it" hides while a check runs; a check that finds the credit drops a key kept for it.
- L2: the carried key does not expire. A later credit with the same amount and note is replayed and shown as added (nothing new is added);
  a different amount or note is refused once (409 `IDEMPOTENCY_KEY_REUSED`, "already used" words), and the credit after that has a new key.
- The Forget tick is cleared whenever "Forget it" hides after a check. On an older backend, a restored name change (which cannot be sent again)
  says only "The outcome of this request is not known yet."

## WQ15 close a card top-up already paid by hand; clinic sign-in refusal (2026-11-23, branch `wq15/close-compensated`)

Backend: r9 (`m0/r9-owner-decisions` 0ca329aa, design ASSISTED_BOOKING_DESIGN.md §22; on origin/stage). Web base: origin/stage
0cbc4a2. One UI addition (the section below) and one new message with its "Choose another workspace" way on; nothing else on the
wallet page or the sign-in changes.

- **Admin › Pharmacy wallets › Card top-ups not credited** (bottom of a pharmacy's wallet page): the pharmacy's rows of
  `GET /admin/wallet-recharges/uncredited` (no query: every pharmacy, filtered here by `pharmacyId`; at most 200 paid-not-credited
  plus 200 never-checked attempts, the last 30 days unless the sweep date is set). Each row: when, amount (`amountMinor`), state
  (`paid_not_credited` "Paid, not credited" / `not_checked_with_gateway` "Not checked with Razorpay") and the payment reference.
  The r9 row carries no Razorpay order id, so the reference is the payment record id (`paymentTransactionId`); a
  `razorpayOrderId` is shown if a server adds one (follow-up below).
- **Mark as already paid by hand**: a required reason (1–500 after trimming), a confirm step with the owner wording ("Use this only
  when Jansetu support already paid this amount to the pharmacy another way. The top-up can then never be credited."), then
  `POST /admin/wallet-payments/:paymentRecordId/close-compensated {reason, requestKey}` (always the record id, so never
  `PAYMENT_AMBIGUOUS` in practice). The key (32 letters and digits, `^[A-Za-z0-9_-]{8,100}$`) is the owned PendingOp's, made at the
  review, stored before sending. A lost answer: "Send the same request again" (same key and body; the server answers the
  closure, `replayed`), or "Check whether it was recorded" (`GET /admin/wallet-payments/close-compensated/by-key/:key` → `closed` /
  `not_found`; anything else, a 503 included, is a failed check). After a reload only the key is kept: check, or forget. Forgetting is
  safe: a top-up already closed answers its closure to any key.
- **Answers**: 200 closed / replayed. 409 `TOPUP_ALREADY_CREDITED` "This top-up was already credited, nothing to close.",
  `TOPUP_REFUNDED` (a backend follow-up: "This top-up was already refunded to the card, nothing to close."), `TOPUP_BLOCKED`, `IDEMPOTENCY_KEY_REUSED`, `PAYMENT_AMBIGUOUS`, `WALLET_CHANGED`; 404 `TOPUP_NOT_FOUND`; 503 `INDEXES_OUTDATED` or
  the admin tools switch (`ASSISTED_BOOKING_DISABLED`, or a server without the route). Credited, blocked and not-a-top-up settle the
  close on any attempt (the server answers an earlier successful close as its closure first). The two coded 503s settle a sole first
  attempt (refused before any write); an uncoded 503 stays unknown.
- **Clinic sign-in**: 403 `CLINIC_OWNER_DOCTOR_NOT_VERIFIED` (and `CLINIC_DOCTOR_NOT_VERIFIED`, its name after a backend follow-up;
  both are recognised) from partner verify, partner select or any partner call says "Your doctor
  account is not verified or not active, so this clinic workspace is closed for you. Contact the Jansetu team." (`messageOf`).
  Not retried. A refused select keeps the workspace choice on screen (WQ15b L3: since r9b the ticket stays valid, so another
  workspace can be opened from the same list; on an older backend the next select answers 401 `SELECTION_EXPIRED`, which asks for
  a new code). On a partner call (the profile read after a reload included), the API client's new `onForbidden` hook lets the session
  end it like a 401 for the current token: `signOut` with that message, which also logs the cookie/native session out on the server
  (logout and refresh carry no partner check), so a reload shows the plain sign-in and nothing loops. When the same refusal ends the
  session during a sign-in, the message is shown once. Review of the 403 handling: the web otherwise signs out only on a 401, and
  a 403 from the profile read after a reload used to leave the person signed out silently; for this code the hook ends the session
  with the message first, and the reload path itself also sets the message (never a silent sign-out). There is no "Sign out" to
  offer: the session is already ended on the server. "Choose another workspace" is offered instead: on the sign-in screen after the
  session ended it picks "Lab or clinic staff" and puts the cursor on the number; after a refused choice the list itself stays to
  choose from. Not offered after a refused verify (one workspace only: verify answers a choice when there are several).

### WQ15b follow-ups (Opus xhigh review of e5d0e1c, 2026-11-23; branch `wq15b/followups`)

Backend r9b `9be7d0a7` (on stage): `selectPartner` keeps the ticket on a refusal; the code is now `CLINIC_DOCTOR_NOT_VERIFIED` (the
old name stays recognised).

- L1 (money wording): the close answer is checked: a 200 without `closed: true` is a 502, so the request stays unknown (check or
  resend) and is never said to be closed.
- L3: a refused workspace choice keeps the choice step and its list (no new code needed); see above.
- N1: `TOPUP_REFUNDED` settles the close on any attempt, like credited and blocked.
- N2: a replayed answer (`replayed: true`, also to a resend) says "This top-up was already closed as paid by hand: … Nothing more
  was changed.", never that this admin closed it once.

## WQ16 assisted booking phase 1b: a pharmacy pays a walk-in booking by card or UPI (2026-11-23, branch `wq16/card-booking`)

Backend: r10 (`m0/r10-phase1b` 9f2a1807, design ASSISTED_BOOKING_DESIGN.md §23; local, not on stage yet). Web base: origin/stage
72a9b27. Behind the backend's own switch `ASSISTED_CARD_PAYMENT_ENABLED` (off by default): with it off the screens offer the card
option, the server refuses it before anything, and the option is then disabled with "Card payment is not switched on yet."

- **Book consultation › Check and pay**: "How do you pay?" with **Pay from wallet** (the default; the wallet path is unchanged) or
  **Pay by card or UPI**. Not offered for a free consultation (wallet only). Card sends the same body with
  `paymentMethod: 'razorpay'` under the same owned PendingOp and key (`assisted-book:<pharmacy>`); an unknown outcome is resent with
  the same key and body, or checked by key. The 201/200 answer's `payment` opens Razorpay Checkout at once (`key = razorpayKeyId`,
  `order_id = razorpayOrderId`, `amount = amountMinor`, `currency`); the proof goes to `POST /payments/verify {paymentTransactionId,
  razorpayOrderId, razorpayPaymentId, razorpaySignature}` (no `module`), and when it settles nothing (closed Checkout, lost answer, a
  bad signature, Razorpay not answering) to `POST /payments/reconcile {paymentTransactionId}`. Only `paymentRecord.status` decides:
  `paid` → **Booked** "paid by card or UPI"; `refunded` (also 400 `PAYMENT_REFUNDED`) → **Not booked**, "the amount is being refunded
  to the card or UPI"; `unpaid` → "Not paid yet"; 400 `PAYMENT_FAILED` → not booked; 403 (pharmacy not operational) → said, nothing
  claimed; anything else → "We could not confirm the payment yet … tap Check payment".
- **Booking held: waiting for payment**: "Pay before HH:MM or the time is released." (`payBy`, India time), **Pay now** (the SAME order:
  the one held, else `GET …/bookings/by-key/:key` → `payment`; there is no second order, C10) and **Check payment** (reconcile).
- **Create refusals**: 400 `PAYMENT_METHOD_UNAVAILABLE` and 503 `RAZORPAY_NOT_CONFIGURED` disable the card option (said next to
  it); 400 `NOTHING_TO_PAY` switches to the wallet; each keeps the review with a new key. 503 `RAZORPAY_NOT_CONFIGURED` joins the
  refused-before-writing 503s (r10 `assertCardGatewayReady` runs before the transaction). 502 `RAZORPAY_ORDER_CREATION_FAILED`
  leaves the request unknown with "The booking is held, but the card payment could not be started. Send the same request again";
  the replay makes the order. Other 503s stay unknown as before.
- **Card bookings on this device**: remembered per pharmacy and booking by their request key only, as a body-less reload marker
  (slot `assisted-card:<pharmacy>:<booking>`, D4: no amount, names or tokens). It gives "Pay now" to the booked consultation (also
  after a reload, in the same tab) and tells the cancel step the booking was paid by card. The booker view does not say how a
  booking was paid (follow-up below).
- **Booked consultations**: a card booking not paid yet (assisted, `pending`/`pending`) shows "Waiting for payment" and a
  **Pay now** link; the booking shows "Price … (not paid yet)" and the payment panel (or, from another tab, the pay-by time and
  that it can be paid only where it was booked).
- **Cancel**: for a booking paid by card in this tab, **Refund to card (default)** or **Refund to wallet**, sent as `refundTo`. The
  answer's `refund` is said in plain words: card `pending` "in progress, usually 5 to 7 working days", `processed` "refunded",
  `failed` "did not go through, Jansetu will contact you", `manual_review` "held for a check"; wallet "back in your Jansetu wallet
  … cannot be withdrawn"; `refund: null` "It was not paid, so nothing is refunded". A booking whose way of payment is not known here
  is cancelled with no `refundTo` (the server's default: back the way it was paid), with neutral words.
- **Admin › Pharmacy wallets › Card refunds of bookings that need a person** (bottom of the list page; every pharmacy):
  `GET /admin/assisted/card-refunds` (no query: failed, held, and stuck pending rows). **Move to wallet** (failed or held rows, not after
  a recorded dispute): the pharmacy's agreement (1–500 characters, required), a confirm step, then
  `POST /admin/assisted/card-refunds/:id/to-wallet {agreement}` with an owned PendingOp (local key; the move is once per refund).
  A lost answer: send the same request again (answered `replayed`), or **Check whether it was recorded** (`?state=processed&limit=200`,
  the row moved to the wallet). 409 `REFUND_NOT_FAILED` / `CHARGEBACK_RECORDED` and 404 `REFUND_NOT_FOUND` settle any attempt; 503
  `ASSISTED_BOOKING_DISABLED` (admin tools switch) settles a sole first attempt. Only an answer with the refund processed to the
  wallet counts (anything else is a 502, left unknown).
- **Not built**: recording a card chargeback on a booking payment (`POST /admin/assisted-payments/:paymentId/chargeback`): it
  takes any assisted payment id (not a queue row), has no read to check a lost answer by, and changes no money (C4); skipped as
  not trivial in this UI.
- **Visible changes outside these features**: the Book consultation intro now says "You pay Jansetu from your wallet, or by card or
  UPI"; on a booked consultation the wallet label "Paid from your wallet" became "Amount paid" (or "Paid by card or UPI" when known),
  and the cancel words say the money goes back the way it was paid; the "Pay from wallet" radio shows above the wallet lines on
  every paid booking review; the admin Pharmacy wallets list page has the new section. The shared Checkout loader in `topup.tsx`
  now takes the amount in paise (top-ups pass `amount × 100`, as before).

### WQ16b the booker view's payment, admin recheck and mark failed (2026-11-23, branch `wq16b/payment-field`)

Backend r10b/r10c (`m0/r10b-phase1b-fixes` 6b223644, design §23.3 and §23.6; in review). On 75e6c45.

- **Booker view `payment`** (`{ method, state, payBy, paymentTransactionId? }`, own pharmacy only): "Waiting for payment" needs
  `method: 'razorpay', state: 'pending'`; the pay-by time is the server's `payBy`; **Check payment** reconciles the
  `paymentTransactionId` from any device; the label says "Paid from your wallet" or "Paid by card or UPI" again; the refund
  choice is offered for a card booking the server says was captured (any device), and a wallet booking gets the wallet words and
  no `refundTo`. **Pay now** still needs the order, which only the create's key gives back (replay or by-key; no read by booking
  or record id), so it opens only in the tab that booked it; elsewhere the page says so and offers Check payment. The device
  marker stays for that, and for the refund choice on an older server (no field: the WQ16 behaviour).
- **New refusals**: 429 `ASSISTED_LIMIT_REACHED` `limit: 'pending_card_bookings'` "Too many bookings are waiting for payment. Pay
  or cancel one of them first." (refused before any write, the review stays, a new key); 409 `PAYMENT_DISPUTED` on verify or
  reconcile is said ("A card dispute was recorded on this booking payment…"), never paid or "not booked"; a bad signature
  (400, record left payable) already fell back to reconcile, so the booking stays pending (pinned by a test).
- **Admin queue**: each row names its pharmacy (`pharmacyName`). **Recheck** (`POST …/:id/recheck`, any row not processed; no
  money moves; the answer is said: the row's state and Razorpay's refunds). **Mark failed** (pending card rows): a reason
  (1–500), a confirm step, an owned request (`POST …/:id/mark-failed {reason}`); a lost answer is resent (an earlier success is
  then 409 `REFUND_NOT_PENDING`, left unknown) or checked among `?state=failed` rows marked by an admin. 409 `REFUND_AT_GATEWAY`
  and 404 settle any attempt; 502 `GATEWAY_LOOKUP_FAILED` and the switch settle a sole first one; `REFUND_BUSY` refuses. Move to
  wallet adds 409 `REFUND_AT_GATEWAY` (final) and 502 `GATEWAY_LOOKUP_FAILED` (refused before writing for a sole attempt). The
  row's count reads "failures" (r10b counts real failures only).

### WQ16c review fixes (review of 398accb, 2026-11-23; branch `wq16c/fixes`)

Backend r10d (`m0/r10d-phase1b` a7ae19bb: `payment.razorpayOrderId` / `razorpayKeyId` while waiting). The refund read by id
(`GET /admin/assisted/card-refunds/:id`) is not on r10d yet: used when present, else `POST …/recheck` (which answers the row).

- 1 (M): "paid" labels only when `payment.state` is captured, refunded or forfeited; `not_paid` shows "Price … (not paid)";
  cancellation cause `payment_timeout` reads "Payment was not completed in time".
- 2 (M): **Pay now** re-reads the order first (by the create's key, else the booking's r10d `payment`, so any device on r10d),
  is hidden from 2 minutes before `payBy` (a timer flips it while the page is open; "The time to pay is almost over…"), and
  Checkout gets Razorpay's `timeout` so it closes itself before then. The create's own order is still opened at once.
- 3 (M): after Checkout reported a payment, a verify 400 `PAYMENT_NOT_COMPLETED`, a reconcile `unpaid` with an `authorized` or
  `created` gateway payment, or an unknown outcome, only **Check payment** is offered: "Razorpay reported the payment; it is
  being confirmed. Do not pay again." (`CardOutcome` `unpaid` carries `inFlight`).
- 4 (L/M): the admin Check reads the refund by id, never the 200-row list. (Superseded by WQ16d: the r10e route
  `GET /admin/assisted/card-refunds/:id`; no recheck fallback, a server without the route leaves the outcome unknown.)
- 5 (L): a booking with no order (502 at create, found after a reload) says "The card payment for this booking could not be
  started. Tap “Check payment”, or cancel this booking … and book again."
- 6 (L): a restored cancellation of a card booking says "refunded the way chosen"; cancelling (or the answer for) a booking
  waiting for payment adds "If a payment arrives later, it goes back to the card."
- 7 (L): Forget on an unconfirmed refund change clears its review and form.
- 8 (L): "Tap Pay now" only where the button is offered; a recheck 5xx says "The outcome is not known"; a code-less 404 on the
  admin refund actions says "Not available on this server yet".

### WQ16d alignment with backend r10e (2026-11-23, branch `wq16c/fixes`)

Backend r10e (`m0/r10d-phase1b` d1ed6d24, §23.3/§23.6).
- The admin Check reads `GET /admin/assisted/card-refunds/:id` exactly: the queue row (with the pharmacy) as `data`; 404
  `REFUND_NOT_FOUND` and 403 are shown as a failed check (outcome unknown). On a server without the route (code-less 404 or 405)
  the check says "Not available on this server yet. The outcome is not known." Recheck is no longer used as a fallback (it can
  send the refund).
- Verify 409 `DUPLICATE_PAYMENT_REFUNDED` (`CardOutcome` `duplicate`): "This booking was already paid with another payment. This
  payment is being refunded to the card or UPI." Final for that attempt, never paid, no reconcile; the booking is read again
  (by key, else by id) and shown paid only when it is, with that sentence; otherwise only Check payment is offered.
- Refund cause `extra_capture` reads "Second payment, refunded" in the admin queue.

### WQ16d card-last: last card-payment fixes before production (2026-11-23, branch `wq16d/card-last`)

On stage 244bbf7. No UI change besides the two wording items.
- 1: a reopened "Pay now" asks the server first (`POST /payments/reconcile`, `beforeCheckout`): an `authorized` payment at
  Razorpay keeps the "being confirmed / Check payment" state and Checkout is not opened (also after the panel was shown again);
  a `created` attempt still opens it, keeping any warning on screen; paid / refunded / refused answers settle as before.
- 2: "You can also pay it from there, on this device." is hidden while the payment is being confirmed.
- 3: Checkout's `timeout` is at least 60 seconds.
- 4: the admin check counts `lastError: MARKED_FAILED_BY_ADMIN` in any row state.
- 5: a failed re-read after a duplicate payment keeps the duplicate sentence on screen.
- 6: a restored card cancellation says "Cancelled. The amount goes back the way chosen."
- 7: comments and PLAN WQ16c item 4 brought up to date.

## WQ17 pharmacy: book lab tests for walk-in patients (phase 2a) (2026-11-23, branch `wq17/pharmacy-lab-booking`)

Backend r11 (`m0/r11-phase2a` f5f171c9, design ASSISTED_BOOKING_DESIGN.md §24.11; on stage). Web base: stage 0aca6c3.

- **Book lab test** (`/pharmacy/lab-book`, nav "Book lab test"): step 1 is the Book consultation patient step itself, moved
  unchanged into `patientStep.tsx` (`usePatientStep` + `PatientSection`; Book consultation now uses it too; only the "Next"
  button label is a prop). Step 2: the visit (at the lab / home collection), labs for that visit (`GET …/labs?visitMode`, nearby
  first), the branch (picked at once when only one takes the visit), tests (`…/labs/:partnerId/catalogue?visitMode`, checkboxes,
  1–20), a time (`…/labs/branches/:id/slots?visitMode&from&days=7`), the home address (the customer app's address rules), the
  language and an optional coupon (no note: see the API gap below). Step 3: the summary, the sum of the chosen tests as `acceptedPriceMinor`, the wallet
  and pay. One keyed create (`POST …/lab-bookings`, `paymentMethod: 'wallet'`) under an owned PendingOp
  (`assisted-lab-book:<pharmacy>`): unknown → resend the same body / check by key / give up (by-key abandon); after a reload only
  the key is kept. `PRICE_CHANGED` offers the server's price as a new request; `INSUFFICIENT_BALANCE` the top-up; the 503 codes
  (switch, `INDEXES_OUTDATED`, customer linking) and the lookup limit settle a sole first attempt as before. The switch off (503
  `ASSISTED_BOOKING_DISABLED` on the lab reads) shows "Booking lab tests for patients is not switched on yet."
- **Booked lab tests** (`/pharmacy/lab-tests`, nav "Booked lab tests"; `/pharmacy/lab-tests/:id`): the list (status filter,
  cursor pages) and one booking: reference, status, patient (`patientName` as the server sends it), lab and branch, visit,
  address, time, tests, collector, cancellation. A lab's new time: "Accept new time" (`POST …/accept-reschedule {version}`, owned
  request, checked by re-reading) or cancel. Cancel (`POST …/cancel {reason?, expectedVersion: statusVersion}`, owned request,
  resend safe) only while `confirmed` and up to 1 hour before the time (any time while a new time is unanswered); otherwise it
  says it is too late; the server's refusal is shown. Released report files (`report.releases`) open through `/file/fetch`
  (the dispensing-copy viewer: PDF or image in the page, anything else as a download). Another pharmacy's booking: 404
  `LAB_BOOKING_NOT_FOUND` → "Lab test not found".
- **Shared, not copied** (owner, 25 Nov: no duplicated code). Moved unchanged out of the consultation screens and used by both:
  `patientStep.tsx` (the patient step), `walletPay.tsx` (balance, hold, refusal with "Use the new price", top-up, pay),
  `unconfirmedBooking.tsx` (check by key / send again / give up), `slotDays.tsx` (free times by day), `ownedCancel.tsx` (the
  booker's cancel with its owned request and check), `documentViewer.tsx` (the dispensing copy and the lab report), and
  `cursorList.tsx` (status filter and Newer/Older pages). The visible consultation screens are unchanged.
- Not built: card payment (2b), "not mine" (patient app), the lab's own screens for assisted rows.
- API gap (r11 f5f171c9, now on stage): `notes` on the create is validated and part of the request hash but never stored or
  shown to the lab, so the screen offers no note and sends none. For the backend: store it and show it to the lab, or drop it.

### WQ17b review fixes (review of 3c1960e, 2026-11-25; same branch)

- M1 (money wording): a lab booking found by its key after a reload shows no price (the booker view has none); it never says
  "Price: ₹0.00". The price line shows only when the price is known.
- D1 (no duplication): the keyed create (send, refusals, re-price, rotate the key, give up, refresh) is one hook,
  `assistedCreate.ts` (`useAssistedCreate`), used by Book consultation and Book lab test; the consultation's card branches plug
  into its answers (`onReceipt`, `onUsed`, `onResult`, `onRefused`). The consultation behaviour and specs are unchanged.
- D2: `hex`, `idOf` and `keyOf` are exported once from `assisted.ts` and imported by `assistedLab.ts`.
- L1: a lost accept is checked as accepted only while the booking is still confirmed and the same proposal (`reschedule.version`)
  is no longer waiting. L2: a refused accept is said by the page, which reads the booking again. L3: a lost cancel, when found,
  says what the server did with the money (`payment.state`: refunded → back in the wallet; forfeited → nothing refunded).
  L4: "Visited" in the status filter.

## WQ18 admin doctors: verify with the S5 fence, unverify; close and refund (2026-11-25, branch `wq18/admin-buttons`)

Backend: the stage line (q16-integration f81c8f3b; routes unchanged at f5f171c9), S5 `specialists/verification.ts`,
`specialists/eligibility.ts` and S5c–S5f `bookings/adminClose.ts`. Web base: origin/stage 0aca6c3. Kept plain (owner, 25 Nov): one
list, one doctor page, the close on the existing consultation page; existing components only.

- **Admin › Doctors** (`/admin/doctors`, admins only): `GET /specialists` as an admin (every doctor), newest first
  (`sortBy=createdAt&sortOrder=desc`), 20 a page; name search in page memory only (never the address); Verification and Active
  filters (`isVerified`, `isActive`). The list, its filters, badges, pager and the not-found page are shared with Pharmacies
  (`screens/admin/accountList.tsx`; Pharmacies moved onto it unchanged).
- **Doctor page** (`/admin/doctors/:id`): status, name, registration number, speciality, degree, sign-in contacts. **Verify**
  (existing ConfirmAction, closed if the doctor changes while open) names the reviewed name and registration number and sends
  `PUT /specialists/:id {isVerified: true, expectedName, expectedRegistrationNumber}` (trimmed; a missing number is ''). 409
  `SPECIALIST_CHANGED_SINCE_REVIEW` (final on any attempt, a resend included): nothing changed; the doctor is read again and
  "You reviewed … / Saved now …" is shown; the admin verifies again on what is shown. A doctor with no name is not offered Verify. `expectedUpdatedAt` is not sent: the brief names the two identity fields, and a version
  fence would also trip on unrelated edits. **Unverify** (`{isVerified: false}`, no fence on the server) says what the doctor
  loses and that their bookings stay. Both go through an owned PendingOp (`admin-doctor-state:<admin>:<doctor>`) under
  `useOneAtATime`; a lost answer is checked by reading the doctor (both only set `isVerified`) or sent again unchanged; a sole
  first attempt refused 503 `INDEXES_OUTDATED` (the audit check, before any write) is settled as refused.
- **Open consultations**: the doctor page links to the existing Consultations list filtered by that doctor and status
  (`/admin/consultations?doctor=<id>&status=pending|confirmed`); each opens its consultation page.
- **Close and refund** (consultation page, S5c): offered for a pending or confirmed scheduled consultation, not moved after a
  no-show (unless clinic-paid), whose doctor is not verified and active or no longer exists (`canCloseAndRefund`; the doctor is
  read with `GET /specialists/:id`). The existing ConfirmAction (danger, required internal reason 3–500 as the moved no-show's
  admin cancel, the patient never sees it; holds the booking version it was opened on), then
  `POST /specialists/admin/bookings/:id/close {reason, requestKey, expectedUpdatedAt: <version opened on>}` with an owned PendingOp
  (`admin-booking-close:<admin>:<booking>`), key made at the confirm. The answer is said as the server gives it: `refunded` (rupees)
  to the patient's wallet; for an assisted booking to the pharmacy's wallet, or, paid by card (`assisted.funding.method:
  'razorpay'`), "is being refunded" to that card (queued); or nothing; `replayed` says nothing more changed. A lost
  answer: send the same request again (replayed), or check: the booking is read first, then its closes
  (`GET /specialists/admin/bookings/:id/close`): this key there = closed; the booking cancelled without it = closed another way
  (a cancelled booking can never be closed later); completed/no-show = can no longer be closed; else still unknown. Final on any
  attempt: not found, not a consultation, instant, not cancellable, moved no-show; `ALREADY_CANCELLED` reads the closes for this key
  first (a resend can race its own first attempt). `BOOKING_CHANGED` on a sole attempt re-reads the booking. A cancelled booking
  lists its closes (when, refund, status before, internal reason).
- **Close as already compensated**: already built in WQ15 (`PharmacyWalletsScreen`, Card top-ups not credited); not changed.

API gaps (no route; nothing invented):
- No server list of bookings stuck with an ineligible doctor (the S5 audit is a CLI script); the doctor page lists that doctor's
  open consultations instead, and the admin finds doctors with the Verification/Active filters.
- `isVerified=false` matches only a stored `false`: legacy doctors with no flag (unverified per S5) are not in that filter
  (they show "Not verified" in the unfiltered list).
- No read of the verification audit (`specialistverifications`: who verified, with which name/number).
- No admin activate/deactivate concept beyond `isActive` on the same PUT; not offered here (out of scope).
- Second-opinion bookings: the close accepts them, but the workspace has no admin list of them (consultations only).
- Doctor documents are stored URLs; no admin file view is built here.

### WQ18b no duplicated code, review follow-ups (2026-11-25, same branch)

- O1: the doctor page's own open-consultations table and `openConsultations` are gone: two links to the Consultations list
  (`?doctor=<id>&status=pending|confirmed`).
- O2: Close and refund uses the existing ConfirmAction (required reason, danger, version fence) instead of its own form; a re-read
  while it is open closes it and says so, never silently wiping the reason.
- O3: `adminDoctors.ts` imports `checkId` (now exported from `partners.ts`, on `OBJECT_ID_PATTERN`) and `REQUEST_KEY_PATTERN`, and
  checks the close reason with `MIN/MAX_ADMIN_CANCEL_REASON`; `bookingCloseReasonProblem` is gone.
- L2: a fence mismatch settles the verify on any attempt (re-read, shown). L3: no Verify without a name (no false "outcome
  unknown"). L4: a card-paid assisted booking's close says the refund "is being refunded" to the card.

### WQ17c pharmacy pays a lab test by card or UPI (phase 2b) (2026-11-25, branch `wq17/pharmacy-lab-booking`)

Backend r14 (`m0/r14-phase2b` 77594d72, design §24.14; local). On stage 24019c4 (WQ17, WQ17b, WQ18).

- **One card machinery, by booking kind** (owner: no duplicated code). The consultation card code is generalised, not copied:
  `assistedCard.ts` `cardBookingState(kind, booking)` (consultation `pending`/`pending` → `confirmed`/`paid`; lab `pending_payment`
  → any later status), `orderFromBooking` for any view (the amount only when the view has a price: a lab view has none, so
  Checkout takes the order's own), `cancelWords(answer, told)`; `cardBooking.tsx` `CardPaymentPanel` takes a
  `CardBookingSource` (`consultationCardSource`, `labCardSource`: the reads, Checkout's description and who is told),
  `useCardChoice` (the way to pay, the card refusals), `CardDueSection`, `NotBooked`, `ORDER_FAILED_WORDS`; `walletPay.tsx`
  `PayChoice` ("How do you pay?"); `ownedCancel.tsx` `CardAwareCancel` (the money words, "Refund to card (default)" / "Refund to
  wallet", `refundTo`). Book consultation, its booked detail and their specs are unchanged. `assistedCard.ts` now reuses `hex`
  and `idOf` from `assisted.ts`.
- **Book lab test**: "How do you pay?" next to the wallet pay; card creates with `paymentMethod: 'razorpay'` (same body, key and
  owned request); Checkout at once on the create's order; verify, then reconcile; the held page with "Pay now" (asks the server
  first: an authorized payment means no second Checkout) and "Check payment"; a late or duplicate payment as for consultations;
  502 order failure, switch off, nothing to pay, no gateway keys as for consultations.
- **Booked lab tests**: "Waiting for payment" in the list and its filter (`status=pending_payment`); on the booking, the
  consultation's payment panel on the lab's own reads (the open order from the booker view's `payment`, any device; "Pay now"
  shows no amount, the view has no price); cancel: a waiting card booking at any time (nothing refunded), a card-paid one up
  to 1 hour before with the refund to the card (default) or the wallet (`refundTo`), the answer's `refund` in words.
- The lab switch-off words for the card (`PAYMENT_METHOD_UNAVAILABLE`) are now the consultation's ("Card payment is not
  switched on yet. Pay from your Jansetu wallet."): lab tests can be paid by card from r14.

## WQ21 pharmacy: the recommended-tests code (phase 3d web) (2026-11-25, branch `wq21/recommendation-code`)

Backend r16 (`m0/r16-phase3d` 8e5337f4, design §25.12.4; local). On WQ17c f089b46.

- **Booked consultation**: the prescription shows "Recommended tests code: ABCD-EFGH" when the booker view carries
  `prescription.recommendationCode`.
- **Book lab test**: after the patient step, "Have a test code from the doctor? (optional)" with "Load tests":
  `POST /pharmacy-assisted/recommendations/lookup {code, phone}` (r16b: both in the body, never in a URL; the code with spaces
  and hyphens dropped; the number is the patient's from step 1). The recommended names are listed; once a lab is chosen its tests named exactly so (case and spaces aside) are ticked,
  once per lab and code, and the pharmacist can change the ticks; names the lab does not list read "…: not in this lab's list".
  400 `INVALID_CODE` / `VALIDATION_ERROR`: "This code is not valid. Check it on the prescription."; 404 `RECOMMENDATION_NOT_FOUND`
  (the server's one answer for an unknown code and a wrong number): "No recommended tests were found for this code and this
  mobile number. Check both with the patient."; 503 `RECOMMENDATIONS_DISABLED` (or a server without the route) hides the field.
  The code and the number stay in the page's state. Nothing new is sent on create (linking is the backend's next round).
- **WQ21 L1**: `routeCardAnswer` (next to `cardBookingState` in `assistedCard.ts`) is the one router for a create's answer
  and a by-key `used` answer, used by Book consultation and Book lab test (consultation behaviour unchanged). **L2**: a "Pay now"
  link on the waiting rows of Booked lab tests, as in Booked consultations.
- Built against the r16b shape (the 3d review moved the load from `GET …/:code?phone=` to a POST body); mocked until r16b lands.


## WQ19 lab front desk: book a walk-in, a lab visit or a home collection, paid at the lab (2026-11-25, branch `wq19/lab-desk`)

Backend: r12 (`m0/r12-phase2c` e304dabe, design ASSISTED_BOOKING_DESIGN.md §24.12; local). Web base: stage 0aca6c3 + WQ17
(`wq17/pharmacy-lab-booking`, merged first; merged again at 24019c4 with WQ17b and WQ18). Behind the backend's `LAB_DESK_ENABLED` (off: lookup and create answer 503
`ASSISTED_BOOKING_DISABLED`, shown as "The lab front desk is not switched on yet.").

- **Lab › Front desk** (`/partner/lab-desk`; labs, `bookings.manage`; admins at `/admin/partners/:id/lab-desk`, linked from the
  partner page). The shared patient step (WQ12/WQ17) with the desk's lookup (`POST /lab-desk/patients/lookup`: masked holder
  only; no "booked before" family list, a family member is typed) and the desk's consent sentence (`web-lab-desk-v1`); then one
  form: Walk-in now / Lab visit at a time / Home collection, the branch (the member's branches offering the visit; chosen at once
  when one), the tests (`GET /catalogue`: active tests and packages offered for the visit, with the total), a time (`GET /slots`,
  open seats after now, the shared day picker; none for a walk-in), the address and an optional collector (name, mobile) for a
  home collection, the language. One primary action, **Book**, then "Check the total" → `POST /lab-desk/bookings` (no `notes`;
  `acceptedTotalMinor` = Σ catalogue prices). Owned PendingOp; a lost answer uses the shared unconfirmed panel (check by key,
  same request again, give up; after a reload only the key). `PRICE_CHANGED`: the tests are read again and the new total said;
  booking again is a new key. A sole first attempt refused before writing (switch, indexes, linking, lookup limit) is settled.
- **After booking**: "Open the booking" (the existing lab booking page) and **Make bill**: the existing new-bill form with the
  lab booking prefilled (session memory handover, as the clinic's Create bill): branch fixed, the account holder's mobile fixed
  (only known right after booking; from the booking page later the member types it: the lab view carries no phone), body
  `labBookingId`.
- **Lab bookings**: desk rows show **Pay at lab** and the bill's number when linked (list and page). The page's steps run for desk
  rows (`payAtLab`, never `paid`): a walk-in offers only Mark visited (no no-show, no new time); a desk row is never rejected
  for a refund; Complete says nothing is recorded through Jansetu. A Bill section (number, or Make bill) and the desk's
  **Cancel this booking** (the shared owned cancel; `POST /lab-desk/bookings/:id/cancel {reason?, expectedVersion}`; no money).
- **Shared, not copied**: the keyed create is WQ17b's `useAssistedCreate` (now with an optional wallet key and `charged: false`;
  the desk passes no price to accept, it re-reads the tests); `usePatientStep`/`PatientSection` take a lookup and the booker's
  words; `UnconfirmedBooking` takes `charged`; the language select and the home address moved to `pharmacy/bookingFields.tsx` (Book consultation and Book lab
  test use them); the bill handover is generic (`BillPrefill.link` = appointment or lab booking; `BillLink` and `BILL_READERS`
  moved from the clinic desk to `partner/billing.tsx`); `LabPayment` badge in `partner/labs.tsx`; `checkId` exported from
  `partners.ts` (as WQ18b).

API gaps:
- The lab booking view carries no phone, so Make bill from the booking page (not right after booking) asks for the account
  holder's mobile (409 `LAB_BOOKING_CUSTOMER_MISMATCH` if it is another number).
- No desk list of family members booked before (the lab never sees the account's family); family members are typed.
- The bill page does not show its `labBookingId` (Q14 shows an appointment); left as it is.

### WQ19b review fix (2026-11-25, same branch)

- M1: the desk cancel's check read "cancelled" as true/false while the shared `OwnedCancel` (WQ17b) settles on "the booking, or
  null": a lost cancel checked while the booking was still confirmed was said to be cancelled. Now it answers the booking when
  cancelled, else null; `OwnedCancel`'s `V` is `extends object` with no default, so a true/false fails typecheck (every caller
  names its booking type).
- L1: the bill form's mobile stays read-only for every clinic appointment bill, as before; only a lab booking's may be typed.
- L2: `labDesk.ts` uses `keyOf` from `assisted.ts` (no local copy).

### WQ21b the recommended-tests code at the lab front desk (2026-11-25, same branch, on the WQ19 merge)

- `wq19/lab-desk` (12f0321, WQ19 + WQ19b) merged in first (the shared WQ17 pieces: WQ17c's card pieces and WQ19's
  `bookingFields.tsx` both kept).
- **Lab › Front desk**: the same "Have a test code from the doctor?" step, now one shared component and hook
  (`pharmacy/recommendedTests.tsx`: `RecommendedTests`, `useRecommendedTicks`) used by Book lab test and the desk, each with its
  own `load`: the desk route `POST /partner-workspace/lab-desk/recommendations/lookup {code, phone}` (admins: the same under
  `/admin/:partnerId/workspace`; `labDeskApi(...).recommendation`, on the shared `recommendationLookup`). The desk's own
  catalogue is ticked by exact name once per visit and code. 403 `LAB_PARTNER_REQUIRED` / `PARTNER_NOT_VERIFIED` hide the field,
  as the switch off does; the other refusals are the pharmacy's words. Nothing new is sent on create.
- The stale `GET …/:code?phone=` comment is gone with the move; the shared component says POST `/lookup` with the code and the
  number in the body.

## WQ20 lab wallet: the lab's own wallet and the admin's lab wallet tools (2026-11-25, branch `wq20/lab-wallet`)

Backend: r13 (`m0/r13-phase2d` 215556e2, design ASSISTED_BOOKING_DESIGN.md §24.13; local). Web base: WQ19 e981104 + WQ19b
12f0321. Behind `ASSISTED_BOOKING_ENABLED_LAB` (off: a new top-up answers 503, said as "Adding money to the lab wallet is not
switched on yet."; reads, checks and verify keep working). Kept minimal; the pharmacy wallet's own pieces show both wallets.

- **Lab › Wallet** (`/partner/wallet`; labs, `wallet.view` or `wallet.manage`): the balance (with "Card money (withdrawals coming
  later)" = `withdrawableMinor`, and the hold/owing words), **Add money** (`wallet.manage` only) by Razorpay: `POST
  /partner-workspace/assisted/wallet/topups {amountMinor, requestKey}` (₹1–₹50,000), Checkout, `…/payments/verify`, else the
  server's `…/wallet/topups/:id/check`; **Top-ups** as the server lists them (`GET …/wallet/topups`, state words; **Check my
  top-up** on one not paid or not added yet: a lost answer is found here, nothing is kept on the device), and the history
  (`GET …/wallet/entries`, cursor pages). `WALLET_LIMIT_REACHED` names the most and what can still be added (paise `details`).
- **Admin › Labs and clinics › a lab › Wallet** (`/admin/partners/:id/wallet`): the balance, **Put on hold / Release the hold**
  (`PUT /admin/labs/:id/wallet/freeze {frozen, reason}`, confirmed with a reason; a lost answer is settled by reading the
  wallet), **Add money** (the admin pharmacy credit form: Idempotency-Key from an owned PendingOp, review with the last admin
  credit, resend the same request, exact by-key read `GET …/topups/by-key/:key`; at most ₹2,00,000), the history with notes,
  **Card top-ups** (lots) with **Record a card dispute** (`POST /admin/wallet-lots/:lotId/chargeback`; a lab's is flag only:
  nothing is taken, the money stops being withdrawable), and **Card top-ups not credited** with the existing "Mark as already
  paid by hand" (the uncredited list's lab rows, `walletKind: 'lab'`, by `partnerId`).
- **Shared, not copied**: the top-up form takes a `TopupSource` (the pharmacy's routes by default; the lab's keyed order); the
  balance, history table, pager and cursor pages are shared (`pharmacy/WalletScreen.tsx`; the admin pharmacy wallet uses the
  same table); the admin credit form, balance and uncredited close take their owner (`AdminTopupTarget`, `owner: 'pharmacy' |
  'lab'`; the pharmacy's slots, routes and fallback search are unchanged); the lab's paise answers are read into the
  pharmacy's shapes (`asPharmacyWallet`, `asMovement`). The partner permissions gain `wallet.view` and `wallet.manage`.

API gaps:
- No admin mirror of the lab's own wallet routes (`/partner-workspace/admin/:id/workspace/assisted/*`); admins use
  `/admin/labs/:id/wallet*` (no Razorpay top-up for an admin, as for pharmacies).
- The lots read has no top-up record id link to the Top-ups list (a dispute is recorded per lot; `POST /admin/wallet-payments/:id/chargeback`
  is not offered separately: the lot's names the same top-up).
- Withdrawals are off (O2): the withdrawable amount is shown only.

### WQ20b review follow-ups (2026-11-25, same branch)

- L1: "View the wallet" / "Add money to the wallet" are offered in the staff editor for labs only (`permissionsForKind`; a kind not
  read yet offers neither); the Wallet menu item was already for labs only.
- L2: a verify answer says "added" only when `paid` and `credited !== false`; otherwise the server's check settles it.
- L3: the lab's order is an owned request: after a lost answer "Top up" asks again with the same key and amount (the field is
  held; "Use another amount" lets it go), so no second unpaid order counts towards the ₹50,000.
- L4: the lab and admin histories and the lab's Top-ups use WQ17's `useCursorPages` / `CursorPager`; the pharmacy keeps its page
  numbers; "Check my top-up" is one hook (`useTopupCheck`) for the device list and the lab's Top-ups.
- WQ20c: the permission editor shows its checklist and allows Save only once the partner's kind is read (loading and error as
  elsewhere): a save before then would have dropped a lab member's wallet access that was not offered yet.


## WQ22 pharmacy "Consult now": an instant consultation for a walk-in, paid from the wallet (2026-11-25, branch `wq22/consult-now`)

Backend: r17 (`m0/r17-phase3e` 02b4a0e0, design ASSISTED_BOOKING_DESIGN.md §25.12; local, under review). Web base: WQ20 97b2449,
origin/stage f089b46 (WQ17c) merged first, then WQ20b and WQ20c. Behind `ASSISTED_INSTANT_ENABLED` and `ASSISTED_BOOKING_ENABLED_PHARMACY`
(off: the reads and new requests answer 503, said as "Consult now for patients is not switched on yet.").

- **Pharmacy › Consult now** (`/pharmacy/consult-now`, next to Book consultation): the shared patient step; then video or phone
  call, the speciality (`GET /pharmacy-assisted/instant/specialities`: only those with doctors online, with the count; none:
  "book a time instead"), any available doctor or a chosen one (`GET …/doctors`, nearest first, with the fee), where the patient
  joins, the language, a coupon and a few words for the doctor; "Next: check the price" reads `GET …/quote`; then the shared
  wallet pay ("Pay ₹X from wallet and request") and one keyed request (`POST …/requests`, the shared `useAssistedCreate`;
  `acceptedQuoteMinor` / `acceptedPayableMinor`). `QUOTE_CHANGED` names the new price ("Use the new price" = a new request with
  the server's quote and discount); `NO_DOCTOR_ONLINE` / `DOCTOR_NOT_ONLINE` send the person back to the doctor choice.
- **Waiting**: the request read every 5 seconds while it waits; activity (`POST …/activity`) at once and every minute while the
  screen is open (the money comes back 30 minutes after the pharmacy leaves); the offer's countdown; **Cancel and refund**
  (`POST …/refund {expectedStatusVersion}`, confirmed); when the offer ran out, **Ask again** (the same choice) or **Ask any
  available doctor** (`POST …/reoffer {target, expectedStatusVersion}`). A command's lost answer is settled by reading the
  request. Once a doctor accepts: what came back of the quote, the booking's **Join call** (the booked consultation's own) and
  **Open the booking**. The request's id (only) is kept in session memory, so leaving and coming back finds it.
- **Shared, not copied**: the keyed create, the patient step, the wallet pay (it takes the button's words), the unconfirmed
  panel; "Where does the patient join?", the language/coupon/problem fields and their rules moved to `bookingFields.tsx`
  (Book consultation uses them); the Join call is exported from the booked consultation page.

- **WQ22b: Waiting for a doctor** (shown only when there are some): this pharmacy's requests still offered (`GET …/requests?status=offered`,
  newest first, WQ17's cursor pager), each with **Open** = the waiting view (activity, Cancel and refund, Ask again). After a reload
  or on another device a waiting request is found here, so it is not requested a second time. It is read again after every command
  and when "Start another" is pressed.

API gaps: none blocking.

### WQ22c review follow-ups (2026-11-25, same branch)

- L1 (money held): activity is sent only while an offer is open; once it ran out ("No doctor accepted"), nothing is sent, so the
  30-minute inactivity refund starts even with the tab open. "Ask again" opens a new offer, and activity with it.
- L2: "Cancel and refund" says the amount the server refunded (`refundedMinor` of its answer).
- L3: a server without the r17 routes (404 with no code) is said as "not switched on yet", never "Route not found".
- L4: one QUOTE_CHANGED parser (`changedQuote`, used by `instantBookerRefusal`); the assisted refusals share one paise formatter
  (`rupees` in `assisted.ts`; the desk's copy is gone too).

## WQ23 doctor wallet: the doctor's own wallet and the admin's doctor wallet tools (2026-11-25, branch `wq23/doctor-wallet`)

Backend: r20 (`m0/r20-phase3a` d3f89855, design ASSISTED_BOOKING_DESIGN.md §25.12; local, under review). Web base: WQ22b 7c76251.
Behind `ASSISTED_BOOKING_ENABLED_DOCTOR` (off: a new top-up answers 503, said as "Adding money to your wallet is not switched on
yet."; reads, the check and verify keep working). Pharmacy and lab screens unchanged.

- **Doctor › Wallet** (`/doctor/wallet`): the shared balance (with the card money), **Add money** by Razorpay on a keyed order
  (`POST /specialists/me/assisted/wallet/topups`; after a lost answer "Top up" asks again with the same key and amount, WQ20b),
  the proof to the existing `/payments/verify`, else the server's check; no top-up list for doctors (r20 E7), so an unconfirmed
  top-up is kept on this device by its record id only, with "Check my top-up" (as the pharmacy's); the history in cursor pages.
  A doctor who is not verified and active (403 `SPECIALIST_NOT_VERIFIED`) sees only "Your wallet opens once Jansetu has verified
  your account and it is active."
- **Admin › Doctors › a doctor › Wallet** (`/admin/doctors/:id/wallet`, linked from WQ18's doctor page): the admin lab wallet page,
  generalised to its owner (`kind: 'lab' | 'doctor'`, `/admin/labs|doctors/:id/wallet*`): balance, hold and release, Add money
  (Idempotency-Key, exact by-key read), history with notes, card top-ups with the dispute flag, card top-ups not credited with
  the existing close (the uncredited list's doctor rows by `specialistId`).
- **Shared, not copied**: the wallet API builds the lab's and the doctor's own routes from one function (`ownWalletApi`) and the
  admin routes from one (`adminOwnerWalletApi`); one refusal mapper per owner (`ownerWalletRefusal`); the owner unions of the
  admin pieces and the top-up warning take `'doctor'`.

API gaps: none blocking. Doctors have no top-up list (by design, E7): a top-up whose answer was lost after a reload or on another
device is not listed (the server's sweep credits it).

### WQ23b review follow-ups (2026-11-25, same branch)

- **A failed read keeps the page**: Add money (with its answer) and the history stay once the wallet was read; only the
  server's "closed" (403 `SPECIALIST_NOT_VERIFIED`) replaces them.
- **A closed wallet still checks this device's top-ups** (r20 E8): the closed note, then "Top-ups not confirmed yet" with
  "Check my top-up", kept in place while the wallet is read again.
- **Words name the owner**: the close as already paid by hand (`closeCompensatedExplain(owner)`, and the missing-reason words
  `closeReasonProblem(text, owner)`); a doctor with no wallet yet: "It is made when money is first added, by the doctor or
  here" (r20 makes none on a read); the admin's balance shows a doctor's card money as the doctor sees it.
- **No duplication**: one keyed top-up source for a lab and a doctor (`ownerTopupSource` in `topup.tsx`); one
  `WalletOwner = 'pharmacy' | WalletOwnerKind`; no `OWNER_WORD`; one owner tools object (`w`, `refusal`) on the admin
  owner page; `adminLabWalletApi`, `adminDoctorWalletApi`, `labWalletRefusal` and `doctorWalletRefusal` removed (tests use
  `adminOwnerWalletApi(c, kind)` and `ownerWalletRefusal(err, kind)`); the admin routes take `ownerId`.

## WQ25 doctor: book a lab test for a patient, paid from the doctor wallet (phase 3b web) (2026-11-25, branch `wq25/doctor-book-lab-test`)

Backend: r26 (`m0/r26-phase3b` + r26b, design ASSISTED_BOOKING_DESIGN.md §25.15; on stage 6a8574e9). Web base: `wq/stage-next-2`
13333e9. Behind `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` (off: the lookup, the lab reads and new bookings answer 503, said as
"Booking lab tests for patients is not switched on yet. Jansetu turns it on for you when it is ready."; the list, cancel,
accept and reports keep working). The pharmacy's screens, words and specs are unchanged.

- **Doctor › Book lab test** (`/doctor/lab-book`, nav after Wallet): the pharmacy's Book lab test with the doctor as the booker.
  A walk-in: the masked lookup (`POST /specialists/me/assisted/patients/lookup`, the phone in the body only) in the shared
  patient step (no "booked here before" family list, as at the lab desk). **From a consultation**
  (`/doctor/lab-book/from/:bookingId`, an id only in the address): Appointments › "Book lab test for this patient" on a
  consultation whose treating window can be open (not cancelled, a no-show or an unpaid pending booking; from 10 minutes
  before the start; `labBookableFrom`; the server decides). The consultation is read (`GET /specialists/me/appointments/:id`,
  the booking only: the patient summary is dropped) to say which one; the doctor types the patient's name (`typedName`, never
  pre-filled with the account name: names rule) and ticks the agreement; the body has `fromBookingId` + `typedName` and no
  phone (nothing counted). Then the same lab, branch, tests, time, address, language and coupon, and the recommended-tests
  code for walk-ins (it needs the number; the doctor's own r16b route; hidden for a doctor not verified). The wallet only (no "How do you pay?"); low balance:
  "Add money" links to Doctor › Wallet (WQ23). 409 `TREATING_WINDOW_CLOSED` and 404 `BOOKING_NOT_FOUND`: said plainly, with
  "Book for the patient by their mobile number instead" (the step links to the walk-in). Consent `web-doctor-lab-v1` (the
  doctor books; it sees the released report for 90 days).
- **Doctor › Lab tests booked** (`/doctor/lab-tests`, `/doctor/lab-tests/:id`): the pharmacy's list and booking: no "Waiting
  for payment" (wallet only), "Cancelled: By you", cancel up to 1 hour before with the refund to the doctor wallet (the
  answer's `refundedMinor`), accept a new time, released reports through `/file/fetch`; another doctor's booking: "Lab test
  not found" (404 `LAB_BOOKING_NOT_FOUND`).
- **Unverified doctor** (403 `SPECIALIST_NOT_VERIFIED` on every r26 route): Book lab test reads the doctor wallet first (the pay
  step reads it anyway) and Lab tests booked its list; either shows only "Booking lab tests for your patients opens once
  Jansetu has verified your account and it is active." A later failed read never hides an unconfirmed booking.
- **Names**: the lists and the booking show the server's `patientName` (typed or masked); once the create (or the by-key
  check) answers, the doctor's summary shows it too (for a family member's consultation, the family member's own name).
- **Shared, not copied** (owner): `labBooker.ts` `LabBooker` (routes, lookup, words, query keys, memory slots, paths;
  `pharmacyLabBooker` is WQ17's exactly, `doctorLabBooker`); `BookLabTest`, `LabList` and `LabDetail` take a booker;
  `assistedLab.ts` `labRoutes(c, kind)` builds both bookers' reads, by-key, abandon, cancel and accept (`pharmacyLabApi`,
  `doctorLabApi` with the doctor's lookup and its one-source create body `doctorLabBody`; `doctorLabRefusal`);
  `WalletPay` takes a `WalletPayer` (`usePayerWallet` in `WalletScreen.tsx`, now also Doctor › Wallet's read); `patientStep.tsx`
  gains the consultation step and the lookup's `refusal`; `RecommendedTests` a `label`. Money safety as WQ17: one owned
  PendingOp per doctor (`assisted-lab-book:doctor:<id>`), stored before sending, settled only while live and `stillCurrent`;
  a request key with by-key check and give-up after a reload (only the key is kept).

API gaps (none blocking): (1) the doctor booker view has no `payment` block (r26 F4), so a cancel found after a lost answer
cannot tell a refund from a forfeit: it says "back in your wallet" only when the doctor cancelled it; (2) the appointment
read sends the whole patient summary (name, phone, email…) though only the booking is needed; (3) the appointment rows carry
no treating-window times, so the link is offered by the client rule above and the server's 409 is said in words.

Seen, not changed: the pharmacy's Book lab test attests the consultation's consent statement (`web-pharmacy-v2`, "books this
consultation", the prescription for 90 days); a lab-test statement would be a new version.

## WQ27 doctor: pay a lab test by card or UPI (phase 3c web) (2026-11-25, branch `wq27/doctor-lab-card`)

Backend: r29 (`m0/r29-phase3c` 88e152ed, design ASSISTED_BOOKING_DESIGN.md §25.16.4; local, under review). Web base: WQ25
292b22d. A doctor's card booking needs `ASSISTED_CARD_PAYMENT_ENABLED` and both doctor switches; card off: 400
`PAYMENT_METHOD_UNAVAILABLE`, said next to the choice ("Card payment is not switched on yet."), which falls back to the
wallet. Pharmacy and lab card flows unchanged (their specs pass as they were).

- **Book lab test (doctor)**: "How do you pay?" (wallet by default, or card or UPI) as for a pharmacy. A card create is the
  same body with `paymentMethod: 'razorpay'` and the same key and owned request: Checkout at once on the create's order, the
  proof to `/payments/verify` (the doctor's token), else `/payments/reconcile`; the held page with "Pay now" (asks the server
  first: an `authorized` payment means no second Checkout) and "Check payment"; the 502 order failure, a late or duplicate
  payment as for the pharmacy. A doctor no longer verified and active (403 `SPECIALIST_NOT_VERIFIED` on verify or reconcile,
  r29 DR9) is told in its own words (`DOCTOR_CARD_BLOCKED_WORDS`: the money goes back to the card), never the pharmacy's.
- **Lab tests booked (doctor)**: "Waiting for payment" in the filter and the list's "Pay now"; the payment panel on the
  booking (any device: the view's open order); cancel a waiting card booking at any time (nothing refunded), a card-paid one
  up to 1 hour before with "Refund to card (default)" or "Refund to wallet" (said before choosing: it pays for bookings and
  cannot be withdrawn; `refundTo`), the answer's `refund` in words ("Refund to card: in progress", or back in the wallet and
  not withdrawable).
- **r29 G1 closes WQ25's gap 1**: the doctor view's `payment` (wallet rows too) now drives the refund choice and the words of a
  cancel found after a lost answer (refunded, forfeited, not paid), exactly as the pharmacy's.
- **Shared, not copied**: `cardBooking.tsx` `doctorLabCardSource` and `labCardSource` are one lab card source over a booker's
  lab routes (`labRoutesCardSource`, the doctor's list named "Lab tests booked"); `LabBooker.cardSource` replaces WQ25's
  `card` flag (both bookers pay by card now); `PayChoice` takes the `WalletPayer`; `doctorLabBody` no longer refuses the card
  and `doctorLabRefusal` leaves the card's switch to the shared words.
- **WQ25 review items folded in**: (1) the consultation read keeps only its date, time, way and the family-member flag, in
  the query itself (a `select` alone would leave the whole booking, prescription included, in the cache); (2) from a
  consultation the labs are read as the step opens, so a doctor lab switch that is off shows the standard notice at once,
  as the walk-in's lookup does; (3) `pharmacyLabApi.book` posts to `LAB_BASE.pharmacy`; (4) "Collect ₹X from the patient"
  reads "at your counter" for a pharmacy only. Also fixed: "Looking for family members you booked for before…" stayed on
  screen for a booker with its own lookup (a doctor; the lab desk since WQ19), whose list is never read.

API gaps: none blocking. `cardCheckProblem` says "This payment was not found for your pharmacy." for
`PAYMENT_RECORD_NOT_FOUND`; a doctor reaches it only for another doctor's record (seen, not changed: pharmacy words).

## WQ28 records access: a treating doctor sees other records with the patient's approval (phase 3f web, both apps) (2026-11-25, branch `wq28/records-access`)

Backend: r30 (`m0/r30-phase3f` 233ef1ab, design ASSISTED_BOOKING_DESIGN.md §25.17; local, being finished: small API changes
are expected after its review). Web base: WQ27 f321df4. Behind `RECORDS_ACCESS_ENABLED` (off: asking, Allow and Deny answer
503 `RECORDS_ACCESS_DISABLED`, said in words; the doctor's own consultations and the holder's lists keep working).

- **Doctor › Appointments › "Patient’s records"** (`/doctor/appointments/:bookingId/records`, an id only in the address; on
  consultations whose treating window can be open, the WQ25 rule). The page reads the consultation for its account, then
  `GET /specialists/me/patients/:userId/history?bookingId=` (the treating view; the server logs every read, so it is read on
  opening, after asking and on "Check again" only, never on focus). It shows the doctor's own consultations with that person
  and "Other records": "Only your own consultations are shown." until a grant is in force, then one list of other doctors'
  prescriptions and released lab reports, newest first (date, doctor or lab, type, "Open": the full PDF or the report through
  `/file/fetch` and the WQ17 document viewer). The request state from `access`: none ("Ask the patient to see their other
  records", a `ConfirmAction` that says the account holder is asked in the app and the request ends after 24 hours or with
  the treating time), waiting until its expiry ("Check again"), denied and ended (ask again), allowed until the grant's end.
  "Ask" is one owned request (`records-request:<doctor>:<booking>`): an unknown answer is checked by reading the page again
  (a newer request or a grant found), resent (a newer request replaces the older) or forgotten. A holder who never signed in
  to the app is said when asking (`channels.app: false`: "The patient hasn’t used the Jansetu app yet; they can’t approve
  until they sign in."); no code box (`channels.sms` stays false in phase 3).
  Another doctor's consultation: "Consultation not found"; a closed window, an unverified doctor and a read log that cannot
  be written (503) are said in words.
- **Customer app**: "Requests to see your records" on Home while one waits (Allow / Deny, each behind the app's `Confirm`
  saying what it means: allowed for up to 12 months while treating, each time recorded, stoppable), and
  `/profile/records` (linked from Profile): waiting requests, "Doctors who can see your records" with "Stop sharing", and
  past requests (allowed, denied, ended, replaced). Every answer, refusal or lost answer reads the lists again; an ended
  request (409 `RECORDS_REQUEST_EXPIRED`) is said and moves to the past.
- **Privacy**: the api module keeps only what the screens show (no patient contacts, diagnosis, medicines or notes in the
  query cache; the consultation read keeps the account id only); nothing is stored; the address holds the booking id only.
- **i18n**: every new word is in a catalogue: `apps/workspace/src/i18n/records` (`workspace-records`) and
  `apps/customer/src/i18n/records` (`customer-records`), their own catalogues while the doctor area and the customer app are
  extracted by other rounds (to merge into those later). No file was added to the allowlist. The literal scan now treats
  `scope` as a technical attribute (the same line as WQ44). The api module `recordsAccess.ts` holds no words (codes only).
- **Reused**: `ConfirmAction` (workspace) and `Confirm` (customer), `useOwnedOp` and `CheckPanel`, `useDocumentViewer` and
  `DocumentPreview`. Not used: the cursor list (the holder's routes answer the newest 50 and 100, no cursor).

API gaps: (1) the treating view needs the account id, which the doctor's appointment rows carry but the web did not type: it
is read from the consultation (one extra read); a `GET …/bookings/:id/records` by booking id would do. (2) The treating view
still sends the holder's contact details (`patient`) and the own consultations' notes and prices (§25.17 "seen"); the web
drops them. (3) The doctor gets no notice when the holder answers: "Check again" reads it.

### WQ28b review fixes (review of 7a66e9a, 2026-11-25; same branch)

1. A refused first "Ask" (409 `TREATING_WINDOW_CLOSED`, 403, 404) now shows its words in the confirmation: the page throws
   an `ApiError` carrying them (`ConfirmAction` shows an `ApiError`'s message; no other screen changes).
2. Customer: a refusal is worded by its code first, so 503 `RECORDS_ACCESS_DISABLED` and `INDEXES_OUTDATED` say their own
   words (no "may not have arrived").
3. The doctor's treating view is never read again on reconnect (`refetchOnReconnect: false`, as on focus); the unconfirmed
   ask's check puts its own read into the page (`setQueryData`): one logged read, not two.
4. "You can see these records until …" shows the earlier of the grant's end and the consultation's treating end; a request
   answered `approved` (a grant already in force) says "The patient has already allowed it.", never "Asked".
5. Both apps word refusals with `t.has('error.<code>')` instead of their own lists of codes.

## WQ29 wallet withdrawals to the bank, and Recover (phase 4d web) (2026-11-25, branch `wq29/withdrawals`)

Backend: r32 (`m0/r32-phase4cd` 23c28687, design ASSISTED_BOOKING_DESIGN.md §26.16.4; local, under review). Web base:
`origin/stage` 3233a59. Behind `WALLET_WITHDRAWALS_ENABLED` (off by default: the section says "Withdrawals to your bank
are not open yet." and offers nothing; a new request answers 503 `WITHDRAWALS_DISABLED`, said in words).

- **"Withdraw to bank"** on the pharmacy's, a lab's and a doctor's wallet page (one piece, `pharmacy/withdrawals.tsx`
  `WithdrawSection` with a `WithdrawalSource`: routes, the wallet's query key, who may act, where the destination is set).
  What is withdrawable now and what becomes so later (card money 7 days after it was paid); the ₹500 minimum and one
  withdrawal a week (the next date said; no form until then); the destination (masked) or, when missing, the pharmacy's
  payout-details form here (the shared `PayoutDetailsForm`, `PUT /pharmacy-assisted/finance/payout-details`), a link to
  Finance (lab) or Earnings (doctor); unverified: said. An amount → its quote (`GET …/withdrawable?amountMinor`) with the
  fee line before confirming ("Card fee on unspent card money: ₹x. You receive ₹y of ₹z." or "No card fee. You receive ₹y.");
  the request is one owned request with its key (a lost answer: checked by key, sent again, or given up with the abandon
  route; after a reload only the key is kept); the list of requests (the server's fee line, state, the bank reference when
  paid, the reason) with Cancel while one waits (fenced by its version). A lab member needs `wallet.manage` to ask or
  cancel (`wallet.view` reads).
- **Admin › Withdrawals** (`/admin/withdrawals`, oldest first, the waiting ones by default): Mark paid (bank transfer or
  UPI, the bank's reference 4–64 characters, the day, a note; a second step that says what it means; one owned request with
  its key: a lost answer is checked by reading the withdrawal or sent again), Reject and Void (a reason; fenced by the
  version shown), each with a link to the owner's wallet.
- **Recover** (r32 §26.8.4): the admin's card top-ups table (`admin/walletLots.tsx`, moved out of the lab/doctor wallet page
  and now also on the pharmacy's, `GET /admin/pharmacies/:id/wallet/lots`): "Record a card dispute" (flag only, for every
  wallet now) and then "Recover the money" (`POST /admin/wallet-lots/:lotId/recover`; taken from the balance, the rest owed,
  the wallet put on hold; once per top-up, so a lost answer is read again and recovering again is safe); "Money taken back"
  once done. The by-payment Recover (`/admin/wallet-payments/:id/recover`, for a top-up credited without a lot) is in the
  api module; no screen lists such top-ups.
- **i18n**: every new word is in `apps/workspace/src/i18n/withdrawals` (`workspace-withdrawals`); the moved lots words
  are byte-identical. No file was added to the allowlist; the literal scan treats `scope` as technical (the WQ44 line). For
  the integrator: the admin nav label "Withdrawals" is in `modules.tsx` as the other labels are on this base; WQ42 moves
  labels to `labelKey`s.
- **Shared, not copied**: `walletWithdrawals.ts` builds the three owners' routes from one function; `pharmacyPayoutApi` uses
  the partner's destination body; `chargebackLot` is one function for every wallet; `PayoutDetailsForm` reads only the
  destination and its version on its re-read (so the pharmacy's comes from its withdrawable answer).

API gaps: (1) the pharmacy has no read of its home account, so its destination form starts empty and re-reads only the
version (from `…/withdrawable`); (2) the withdrawable answer has no `quote` reason when the amount is not covered (above
what is withdrawable is assumed); (3) no list of top-ups credited without a lot, so their Recover has no screen.

### WQ29b review fixes (review of 313979a, 2026-11-25; same branch; backend r32b, `m0/r32-phase4cd` 8b1f6c35, §26.17.7)

1. **HIGH: a pharmacy's card dispute takes the money.** With `WALLET_CHARGEBACK_FLAG_ONLY` off (the default) r32b takes a
   pharmacy's lost dispute at once (the debit, the rest owed, the wallet on hold); a lab's and a doctor's are flagged only
   whatever it says. The lots table takes `takesNow` (the pharmacy's admin wallet) and says "The money is taken back from the
   wallet now"; what was done is said from the answer (`chargebackTook`: the debit `entry` = taken, else flagged; `entry?` on
   the `chargebackLot` answer). The e2e mock follows the rule; both answers are tested.
2. Mark paid refused with 409 `WITHDRAWAL_LOT_DISPUTED`: "A card dispute was recorded on money this withdrawal holds. Reject
   it instead of paying it."
3. A stale quote (until the server's `expectedTransferMinor` fence, r35): the figures the person confirmed are kept with the
   owned request on this device; when the recorded withdrawal's fee or transfer differs, the new figures are said, with Cancel
   in the list.
4. Give up that finds the request recorded clears the review; a replayed answer no longer waiting says the state it is in.
5. The review's destination and its version (the fence) come from the fresh `withdrawable(amount)` answer.
6. A failed read again keeps the owner's list and the admin queue read before.
7. The stored "mark paid" request is held by its row and settled when a read shows the withdrawal paid (with its reference;
   after a reload, paid at all); rows are keyed by the withdrawal only, so an open confirmation stays (it closes itself on a
   new version).
8. The admin queue's key comes from `useAdminScope`; the `adminOwnerWalletApi().chargebackLot` alias is gone (one
   `chargebackLot`).
9. A lab member who cannot open Finance (`finance.view` and partner-wide scope, as the page declares) is told "Ask a lab owner
   to add payout details in Finance." instead of a link.

### WQ29c leftovers (re-check of add6328, 2026-11-25; branch `wq29c/withdrawal-leftovers`)

1. The admin's card top-ups table keeps the lots read before when a read again fails (`if (!data) return isError ? … : …`).
2. Admin › Withdrawals says what was just done above the list ("Marked paid: ref 0000A1, ₹980.00.", "Rejected: …",
   "Voided: …"): a paid, rejected or voided row leaves the filter shown when it is read again, and its own confirmation
   with it. The ref is the last six characters of the withdrawal's id (no one's details), also shown on each row.

## WQ48 the 4f finance screens (phase 4e/4f web) (2026-11-25, branch `wq48/finance-screens`)

From web stage 5ade2d5, with origin/stage 53e523e (the i18n integration) merged before any code, so every new word is in a
catalogue with `t()`. Against backend r35 `m0/r35-phase4ef` bbd6a64b (design §26.10, §26.18.3; stage 198ccc5b) and the r35b
shapes the coordinator sent (`quote.available` = would go through; `referral.setOffMinor`; set-off wallet rows as
`adjustment`/`receivable_setoff`; a referral account's `home`; 409 `REFERRAL_ACCOUNT_USES_HOME`; a branch-limited requester
may cancel). Mocked API in the journeys. Plain words, one primary action per screen.

- **Pharmacy › Finance** (`/pharmacy/finance`, nav "Finance"; `screens/pharmacy/FinanceScreen.tsx`): three tiles from
  `GET /pharmacy-assisted/finance` (wallet balance with withdrawable now/later, owed and on hold; card money = now + later;
  referral earned with paid, set off, due and "payouts are paused"), **Withdraw** (the shared `WithdrawSection`; its
  destination points to the section below), **Payout details** (the masked line and its state; the shared
  `PayoutDetailsForm` prefilled from `payoutDetails.details`, the account number typed again; `PUT …/finance/payout-details`
  with `expectedDetailsVersion`), one **Statement** with a Wallet / Referral earnings choice, the shared period fields and
  CSV (`…/finance/statement?kind=` in cursor pages; `pharmacy-wallet-statement….csv` / `pharmacy-referral-statement….csv`;
  wallet rows in the wallet history table, referral rows in the referral page's table), and the referral **rates**.
- **Folded in:** the pharmacy's "Referral earnings" page is now the Finance page's rates section plus the statement's
  Referral choice; one nav item; `/pharmacy/referral` redirects to Finance. The pharmacy's Wallet page keeps Add money and
  links to Finance for withdrawals (one primary action each). **The lab keeps its own Referral earnings page**: the lab's
  Finance is its settlement ledger with its own statement, payouts and events, and the lab has no `kind=` statement, so
  folding would put two statements with two balances on one page. Its Finance gets the referral tile with a link instead.
- **Lab and doctor Finance**: the referral and withdrawals tiles from the new blocks (`null`, a clinic: hidden);
  `financeTiles.tsx` is shared by the three pages.
- **Withdrawals**: the request sends `expectedTransferMinor` (the transfer shown); 409 `WITHDRAWAL_QUOTE_CHANGED` shows its
  `details` as the new quote to confirm again (a new key; nothing was withdrawn); WQ29b's "fee changed" note is gone. A
  quote that cannot go through is said by its `reason` (the words each refusal already had). `WITHDRAWAL_OPEN` ("Cancel the
  waiting withdrawal first") on every payout-details form (the shared one and the doctor's), `REFERRAL_ACCOUNT_USES_HOME`
  too. A lab member with `wallet.manage` but branch-limited sees "Withdrawals cover the whole lab…" (`FINANCE_SCOPE_REQUIRED`)
  instead of the form, and keeps Cancel (r35b: the requester may cancel; the server decides whose it is).
- **Admin Mark paid**: only after the server refuses with `WITHDRAWAL_LOT_DISPUTED`, "The bank transfer already went out"
  behind a confirm sends `disputeAcknowledged: true` (a new request); a paid row says "Paid after a card dispute: ₹… is owed
  back."
- **Admin › Card disputes** (`/admin/wallet-disputes`, nav "Card disputes"; `GET /admin/wallet-disputes?state`): To recover
  (default) / Recovered / Never credited / All, a link to each wallet, Recover by lot or by payment id where flagged.
- **Admin wallet pages** (pharmacy, lab, doctor): "Older card top-ups" (`…/topups-without-lot`) with Recover by payment id
  where a dispute is recorded; "Pay what is owed from referral earnings" while the wallet owes: one owned request
  (`setoff-from-referral` with a key; a lost answer checked by key, sent again or given up), shown only when the server
  allows it: "Paused until tax advice" while referral payouts are off. The switch is read from any referral account's
  `payoutsPaused` (`GET /settlements/accounts?ownerKind=referral&limit=1`; none = hidden).
- **Admin › Settlements**: the owner filter takes the three referral kinds and "Referral (all)"; referral rows show
  "Paused until tax advice" and (r35b) their home account's masked details. A referral account's page names its home
  account's details (with a link; no edit there) and its payout form uses the home's version and state, or says "Paused
  until tax advice".
- **Shared, not copied**: `useRecover` (lots, older top-ups, disputes), `StatementPeriodFields`/`useStatementPeriod`, the
  referral `StatementList` and `ReferralRates` (exported from the referral page), `MovementsTable`, `PayoutDetailsForm`
  (its `account` is now only the destination and its version). The in-section destination form of WQ29 is gone (no caller).
- **i18n**: words in the `withdrawals`, `finance`, `shell` and api `finance`/`assisted` catalogues; nothing added to the
  allowlist.

API gaps: (1) the admin's wallet pages have no read of the switch or of the owner's referral due, so the set-off section
infers the switch from a referral account's `payoutsPaused` and learns the most it can pay from a refusal's `details`;
(2) the owner's withdrawal view has no requester, so a branch-limited manager is offered Cancel on every waiting
withdrawal and the server refuses the ones it did not ask for; (3) `topups-without-lot` has no recovered marker, so Recover
stays offered after it (a repeat answers "already recovered").

### WQ48b review fixes, part 1: what does not need r35b (2026-11-25, branch `wq48b/finance-fixes` from stage 4ee5c9b, stage 984cc7f merged)

The full workspace suite on 4ee5c9b: 1120/1120 (pw-slot.sh, 22.3 min). Against r35 (198ccc5b) the screens degrade
without a missing line or a NaN: no `setOffMinor` hides that line, no `home` shows the referral account's "paid to the
lab's or doctor's own account" sentence, `recoveredAt` is not read yet. Review items done here:

1. **HIGH:** `isReferralSetOff` matches `referenceType === 'referral_setoff'` only: any other `receivable_setoff` (an owed
   amount cleared from a credit) is a real debit and shows −₹x.
2. (Ahead of r35b) a lab's or doctor's set-off entry takes its amount from `receivableDeltaMinor` when sent; without it
   the amount cell is "—", never ₹0.
3. (Ahead of r35b) a referral account never offers "Add payout details"; a lab's or doctor's offers no details form at all
   (with `home`: its home account's line and link; without: a sentence that payouts go to the lab's or doctor's own
   account); the payout check names the home details.
4. `QuoteReason` adds `LAB_NOT_VERIFIED` and `WALLET_INACTIVE`; 409 `WALLET_INACTIVE` and 403 `PARTNER_NOT_VERIFIED` are
   worded; only `ABOVE_WITHDRAWABLE` says "up to ₹x"; an unknown reason says "This amount cannot be withdrawn now."
5. Card disputes reads `limit: 200`.
6. (Until r35b's `requestedByMe`) a withdrawal with `requestedByMe: false` offers no Cancel to a branch-limited manager;
   a refused cancel (`FINANCE_SCOPE_REQUIRED`) says "You can only cancel withdrawals you asked for."
7. A referral account's payout form is offered only when the switch is known to be on (`paused.data === false`): else
   "Paused until tax advice", "Checking…", or "Could not check…".
8. The referral tile adds "Includes other adjustments: ₹x" when earned − paid − set off ≠ due.
9. A resend refused with `WITHDRAWAL_QUOTE_CHANGED` is worded (the first request's outcome is still unknown).
10. `useKeyedCheck` (ownedOp.tsx): one Check and Give up for owned requests the server looks up by key, used by Withdraw and
    the set-off. Mark paid has no by-key read or give-up route (it reads the withdrawal and offers Forget), so it keeps
    its own check.
11. The untracked temporary Playwright config is deleted.

Waiting for r35b: the admin wallet read's `referral` block (replaces the switch probe), `requestedByMe`, `recoveredAt`,
`home` on the account read and the owner view's `receivableDeltaMinor` (the e2e mocks follow the shapes sent so far).

### WQ48b part 2: built to r35b (backend stage 43f46f57; same branch, from c6a373a)

- **Set-off from referral earnings** reads the admin wallet read's `referral: { dueMinor, payoutsEnabled }` (the pharmacy's
  `GET /pharmacy-wallet?pharmacyId=`, a lab's or doctor's admin wallet): the switch probe is gone. Paused: "Paused until tax
  advice"; on with nothing due (or no line, an older server): not shown; else at most the smaller of what is owed and what
  is due ("Up to ₹x"), checked before asking; the intro names both.
- **Older card top-ups** read `recoveredAt`: a recovered one stays listed, marked "Recovered", with no button.
- **Cancel** follows `requestedByMe` (a branch-limited lab manager is offered only its own; the refusal's words stay).
- **Set-off rows**: a lab's or doctor's entry takes its amount from `receivableDeltaMinor` (the owner's entries carry it
  now); only `referenceType: 'referral_setoff'` rows are shown as paid from referral earnings.
- **Referral accounts**: `account.home` from `GET /settlements/accounts/:id`; `null` (no home account yet) says so, absent
  (an older server) says payouts go to the lab's or doctor's own account. The e2e mocks answer r35b's shapes (and r35's
  for the degradation journey).
- Typed only (no screen needs them): `requestedBy` on the admin's withdrawals.

## WQ50 Pharmacy › New sale: a counter sale (2026-11-26, branch `wq50/pharmacy-sale`)

From web stage 06daf52 with stage ebcbfd7 merged. Against backend stage 43f46f57 (`pharmacyOrders`, `pharmacyCustomers`,
`file`), read in its code; the old app's `CreatePharmacyOrderScreen` sends the same create. Owner asleep: small decisions
below are mine.

- **One screen** (`/pharmacy/sale`, nav "New sale"; `screens/pharmacy/SaleScreen.tsx`, catalogue `i18n/sale`):
  1. **Customer**: search this pharmacy's customers (`GET /pharmacy-customers?search`, the name it may show and the phone;
     empty = latest), or **walk-in** by name and 10-digit phone with the patient's agreement ticked. The server has no
     customer-less order (400 ORDER_PARTY_REQUIRED), so a walk-in is linked first (`POST /pharmacy-customers`, found or
     made by phone, `consent: true`; safe to repeat) and the order is `isWalkIn: true` for that holder.
  2. **Medicines** from active stock (`GET /pharmacy-inventory?isActive=true&search`, sellable = active, unexpired batch
     units; no price sent: the server prices from the stock's retail price, else its wholesale price; prices include GST).
  3. **Prescription** (optional): a file uploaded to `/file/upload/pharmacy-order-prescription` (the old app's module), its
     link in `prescriptionUrls`.
  4. The one primary action **Create sale** (a check step first): `POST /pharmacy-orders` `{ orderType: 'in_store',
     customerId, items: [{ medicineId, orderedQty }], paymentMode: 'in_store_payment', deliveryMode: 'pickup', isWalkIn,
     prescriptionUrls? }`.
  5. The created sale shows its **bill** (lines, the total with the GST inside it, paid or not; "Print the bill" prints the bill alone)
     and takes the **counter payment**: Cash or UPI (`POST …/mark-paid { paymentSource: 'cash'|'upi' }`). An order with a
     prescription medicine (P9: `prescriptionStatus: 'pending'`) is not offered Mark paid: it says the pharmacist approves
     first and links the existing prescription review; a rejected one says to cancel it in Orders. "Open the order" leads to
     the existing order page (cancel, status, returns).
- **Owned request without a key:** the server refuses a request key on a plain create (400 REQUEST_KEY_UNSUPPORTED), so the
  create is an owned request whose lost answer is **never sent again** (it would sell and take stock twice): Check reads
  this customer's in-store orders (`?customerId&orderType=in_store`, newest first) and takes the one with the same lines
  made since the attempt (2 min of clock slack); several, or none, are said; Forget is offered after a check. After a reload
  only the key is kept: look in Orders. Mark paid is safe to repeat (an answer of ORDER_ALREADY_PAID is taken as done).
- **No PII stored:** the customer's name and phone stay in the page; the stored request is body-less after a reload; the
  bill's customer line is this page's own words (the order read does not apply the pharmacy-facing names rule).
- Shared, not copied: `inventoryApi` (now with `isActive`, `retailPrice`), `sellableQty`, `medicineName`, `orderLabel`,
  `CheckPanel`/`useOwnedOp`, `ConfirmAction`, the order page and the prescription review.
- Decisions: the walk-in's agreement tick is required (the server would accept none, recording `not_recorded`); payment
  is cash or UPI only (no card at the counter here); the estimate is from the selling prices (GST inside) and the bill is the server's.

API gaps (not changed): (1) **no request key on the in-store create** (only Rx-from-booking and checkout have one): a lost
answer is found by a heuristic match, not exactly; (2) the inventory list does not send `medicineId.prescriptionRequired`,
so a prescription medicine is known only once the order exists (its line's flag and `prescriptionStatus`); (3)
`GET /pharmacy-orders/:id` does not apply the pharmacy-facing names rule the list applies, so the bill does not show the
order's customer name from it; (4) the create has no way to say "already paid" (an in-store sale is always created
unpaid, then marked paid). Cookie sessions need nothing new: every route is on the pharmacy's bearer token.

### WQ50b review fixes, part 1: before r36 (2026-11-26, branch `wq50b/sale-fixes` from stage 06c2080)

1. **HIGH, a lost sale matched to the wrong order:** before the create is sent, this customer's in-store order ids are read
   and kept with the stored request (this tab's memory only). Check ignores those, and any cancelled, rejected or abandoned
   order (`saleCandidates`). Forget is offered only after a second check at least 30 s after the attempt. (r36: its
   request key, by-key read and abandon replace this.)
2. **Tax:** prices include GST (`computeTotals`: total = subtotal − discount, the GST inside). The form says "Prices include
   tax"; the bill shows the total and "of which GST ₹x"; a missing selling price falls back to the wholesale price (said).
4. **The created sale has its own page** `/pharmacy/sale/:orderId` (bill + payment): a reload shows the bill. The
   prescription review opened from it (`?from=sale`) has "Back to the sale".
5. Check and Create wait while a prescription upload runs (its state belongs to the sale).
6. Mark paid uses the Order page's `canMarkPaid` (now one predicate in `orderLabels.ts`) plus `paymentWaitsForPharmacist`
   (P9, the server's rule). The Order page itself is unchanged in behaviour.
7. 503 `PRESCRIPTION_CHECKOUT_UNAVAILABLE` (decided before anything is written) is a worded refusal, not an unknown outcome.
8. Customer rows without `userId._id` are left out; the create's body is built before the owned request is sent (a bad id
   never becomes an unknown outcome); an unconfirmed sale without a reason says "no answer came back".
9. No copies: `pharmacyOrdersApi().get/markPaid/list` (`OrderQuery` takes `customerId`, `orderType`; `orderIdPath`
   exported); the inventory query's redundant `String(isActive)` is gone.
10. The walk-in's agreement says a Jansetu account is made for that phone if there is none.
11. The bill heads with the pharmacy's name, address and GSTIN (`/pharmacies/me/profile`), says how it was paid
    (`paymentSource`), and shows each line's batch and expiry (`batchAllocations`).
12. Sellable stock counts with India's date (`todayYyyymmdd` now uses `istDateOf`, the server's `istTodayYyyymmdd` rule;
    shared by the stock screens).

Waiting for r36 then: the request key (item 1), `POST /pharmacy-customers/search` (item 3), the prescription flag in the
stock list, the names rule on the order read (all done in part 2). Part 1's full suite: 1146/1146 on ff743be (pw-slot.sh).

### WQ50b part 2: built to r36 (backend stage 135b5639; same branch, on ff743be)

- **The create's request key (r36):** an owned request with its key (`requestKey`): a lost answer is sent again with the
  same stored body and key (a replay answers the first sale, `replayed`), checked by the key
  (`GET /pharmacy-orders/by-key/:key`) or given up by it (`…/abandon`; then it can never be made), through the shared
  `useKeyedCheck`. WQ50b part 1's line-and-time matching and its Forget are gone. 409 `IDEMPOTENCY_KEY_REUSED` reads the key
  (a sale made under it is shown); 409 `REQUEST_ABANDONED` and 503 `INDEXES_OUTDATED` are worded (the latter, like the
  503 prescription gate, ends a sole first attempt: nothing was written).
- **A replay answers the order as it is now:** the sale page shows a cancelled, abandoned or rejected sale as such, with no
  bill and nothing to print.
- **Prescription medicines before the sale:** the stock list's flag (r36b `medicineId.rx`, WQ50c) is read by one helper,
  `isRxMedicine`, and marks the line and says the pharmacist's step.
- **Customer search** is `POST /pharmacy-customers/search` (no name or phone in an address).
- **The bill** is r36's `bill` on the order read: the selling pharmacy's name, address, GSTIN and drug licence, how and when
  it was paid; the customer as this pharmacy may name them (the order read applies the list's rule); each line's batches.

### WQ50c r36b (backend stage 68840c92; branch `wq50c/rx-flag` from stage c512942)

1. The stock list's prescription flag is `medicineId.rx` only (r36b; `prescriptionRequired` is gone from inventory rows):
   `isRxMedicine` reads `rx` and nothing else. (Order lines keep their own `prescriptionRequired`, unchanged.)
2. A keyed in-store sale that is online with no customer is 400 `REQUEST_KEY_UNSUPPORTED` on r36b: the counter sale never
   sends it (`saleRequestBody` always sends `paymentMode: 'in_store_payment'` and refuses a missing customer id; tested).
3. 409 `ORDER_CHECKOUT_PARTY_LOCKED` (a party change on a keyed sale) cannot be triggered from the web: no screen changes an
   order's party (the web has no `PUT /pharmacy-orders/:id`), so it is not worded.

## WQ54 the simple pharmacy home, P1 (2026-11-26, branch `wq54/pharmacy-home` from stage 9b80676)

For an older counter clerk used to a paper register, on any device (`SIMPLE_DESIGN_PLAN_2026-11-26.md`, example 1). Built to
backend r37's draft shapes (in parallel; mocked in e2e until its final shapes come).

- **Home (pharmacy):** four big buttons, **+ New**, **Find patient**, **Sell medicines** (the existing New sale) and **Today**;
  today's register (the latest 10, each row opening its existing page) with the money line ("Collected ₹x: cash ₹a · UPI ₹b ·
  wallet ₹c · unpaid ₹d"; card, online and other only when they have money); a pending strip (each item a link); the
  pharmacy's to-dos (add once per request key, a lost answer sent again with the same key and the text kept; tick fenced by
  the version, shown at once and read again). Other roles' home is unchanged.
- **+ New** (`/pharmacy/new`): step 1 the patient: the same patient as the last visit ("Continue with Asha"), one found by
  phone or name (the POST customer search: nothing in an address), or a new one by phone and name; step 2 what: **Doctor**,
  **Doctor now (video)**, **Lab test**, **Medicines**, each the EXISTING flow (Book consultation, Consult now, Book lab test, New
  sale) opened with `?visit=1`. The patient is held in this session's memory only (`visitPatient.ts`, a plain map, never
  storage or the address) and filled in by the shared patient step (phone looked up once, name and the number-again field
  filled) and by New sale (the walk-in's name and phone). The flows' own steps are when, pay and done (print in New sale, the
  booking's own done panel). **Find patient** opens the same step 1 searching.
- **Today** (`/pharmacy/today`, also in the menu): any India day (date picker, up to today), searched by name, ref or what
  (the r37 rows carry no phone: a phone search needs the server), with the money line and what waits. Read again whenever a
  page shows it (a sale or booking on another page has just changed it). An answer of another shape is shown empty, never a
  crash (`todayOf`).
- **Any device:** big type (17 px) and 48 px targets on the home, + New and Today (`home.css`); on a phone (≤ 600 px) the menu
  is behind one **More** button (tablet and desktop unchanged).
- **No internet:** "No internet connection. Check it, then tap Try again. Nothing you typed is lost." with Try again; what was
  typed stays.
- Decisions (owner away): Find patient is + New's step 1 in search mode (one way to pick a patient); the visit's patient
  stays until another is chosen or the session ends; the phone menu breakpoint is 600 px so tablets keep the side menu; the
  pending strip knows `prescriptions`, `unpaidSales`, `labReports` and `consultations` (others are left out until r37 says).

API gaps / waiting for r37's final shapes: the register's phone search; the pending keys; whether `link` paths are app paths;
the to-do delete is in the api module but not offered (only add and tick were asked).

### WQ54 built to r37's final shapes (backend stage 950417ab; same branch, on ebca0fb)

- **Today's register** (`GET /pharmacy-assisted/today?date&cursor&limit`): rows oldest first (a register is read top to
  bottom; the home shows the latest 10 in that order, from a first page of 200); the Today page reads pages of 50 with
  **Show more**; `totals` are the whole day's on every page (a wallet top-up is listed, not collected); `truncated` is said;
  `what` is the server's ready-made line, shown as data. A row opens its record by `link {kind, id}` (`todayLink`: order →
  the order page, booking → the consultation, lab booking → the lab test, wallet transaction → the wallet). A row is the
  day it was made at the counter; upcoming appointments are in pending and the booking lists.
- **Pending** (first page): prescriptions to review, unpaid counter sales (one opens that sale's page), bookings coming up,
  lab reports ready, low stock, each a link; none shown on later pages.
- **To-dos:** `GET` newest first in a page (`items`), `POST` answers `{ todo, replayed }`, 409 `TODO_CHANGED` is said and
  read again, `createdBy.name` shows who added it (shared within the pharmacy). Delete stays in the api module only.
- The earlier gaps: the register has no phone (search is by name, ref or what); pending and links are now the server's.

### WQ54 r37 review items (ahead of r37b's final shapes; same branch, on ac804db)

- **Every Mark paid sends how it was paid**, exactly `cash`, `upi` or `card`: one shared picker (`paymentPicker.tsx`) on New
  sale and on the Order page (which sent none before, so its payments landed as "other"); the confirmation names it.
- **Today's money is what was received that day:** a row of an earlier day paid today says "paid today · made 24 Nov 2026"
  (`paidToday`, `madeOn`); "unpaid" now reads "to collect" (money still to collect from patients).
- **Pending** adds card payments waiting (to the booked consultations); a queue the server could not read (`null`) says
  "…: couldn't load" on its own line, the others still show.
- Full suite on ac804db (r37 final shapes): 1167/1167 + 1 skipped (15.6 min).

### WQ54 r37b final (backend stage 6de072f2; same branch, on 8d4b33f)

- The r37 review items above match r37b as built: `madeOn`/`paidToday` rows (earlier rows paid that day, at their payment
  time), "collected" = received that day, "to collect" = money still to collect from patients, `null` queues said per line,
  Mark paid always `cash`, `upi` or `card`.
- `cardPaymentsWaiting { count, amountMinor, items:[{kind,id}] }`: the line links to that booking when there is one, else
  the booked consultations.
- To-dos: the server's order (open first, then newest; opaque cursor); 409 `TODO_LIMIT` (500 open) and 409
  `IDEMPOTENCY_KEY_REUSED` (also a deleted to-do's key) are said in words, the text kept, a new key on the next Add.
- Full suite on 8d4b33f: 1167/1167 + 1 skipped (14.8 min).

## WQ54b the simpler pharmacy home (2026-11-26, branch `wq54b/home-simpler` from web stage 662e9f1; backend r37c 7f4ff46b)

Review of WQ54: the right patient every time, correct day data, and fewer things to read for an older clerk.

- **The right patient.** + New hands a flow one patient, once (`visitPatient.ts`): a one-shot handover slot that the flow
  opened with `?visit=1` reads on its first render, clears, and drops `?visit=1` from the address (replace), so Back, Forward
  or a reload opens the flow empty. Only the name this pharmacy typed is handed over (`typedName ?? ''`): a masked or missing
  name is asked in the flow. A patient found by the search sells as that existing customer (not a walk-in). "Type the number
  again" is filled only when the number came from the search results (or was typed twice on + New). The last patient is kept
  apart and offered only as a small "Same patient again: Asha", for 30 minutes after that visit; never the default, and gone
  at sign-out (session memory).
- **One patient step** on + New: one phone field; a patient this pharmacy has is tapped; a new number asks, on the same
  screen, for the name and the number again. "What" in plain words: **See a doctor now (video)**, **Book a doctor for later**,
  **Book a lab test**, **Sell medicines**. The focus moves to the step's heading on each step change.
- **Flows opened from + New** (Consult now, Book consultation, Book lab test, New sale): the patient section is one line,
  "Patient: Asha · 98… [Change] [Home]" (Change opens + New); no "Who is the patient?", no second number; the name only when
  + New had none; the agreement tick stays, large. On a phone such a page has 17 px text and 48 px targets (`visit-mode`).
- **Day data (r37c).** The home reads `order=desc&limit=10` (newest first); a server before r37c (oldest first whatever is
  asked) is followed to its last page for the latest 10. Today reads newest first in pages of 50, and its search is the
  server's (`POST /pharmacy-assisted/today/search { date, q, order, limit, cursor }`, 2–100 characters, the whole day; name,
  ref, line text, 4+ digits a phone). Rows are worded from `whatParts` (`order.items`, `order.counter`, `order.online`,
  `consult.scheduled`, `consult.instant`, `lab.tests`, `wallet.topup`; names and times stay data; the mode through the
  consult-mode words), else `what`. "paid today · made <date>" only when `madeOn` is not the register's day. `truncated` is a
  list (said only when not empty). A wallet top-up row has no "Customer". Pending: bookings waiting for payment by kind
  (`consultationCount`, `labCount`: "2 doctor bookings waiting for payment" → consultations, "1 lab test waiting for payment"
  → lab tests; one record → its page); `cardPaymentsWaiting` is dropped; a missing queue is absent, only `null` says
  "couldn't load".
- **Money:** one big line "Collected today ₹820" (an earlier day: "Collected on 24 Nov 2026: ₹x"), a smaller line with only
  the methods that took money ("Cash ₹320 · Wallet ₹500"), and "To collect ₹x" on its own line, in the warning colour when
  more than 0; a labelled region ("Money of the day").
- **Register rows** are blocks (no grid), time only (the day is the page's). "See all of today" is a 48 px button.
- **Payment picker:** nothing chosen at first ("Tap cash, UPI or card first."; Mark paid / Record payment waits); 48 px
  choices. The Order page's "Payment method" shows the method recorded once paid (`bill.paymentMethod`, else
  `paymentSource`), the payment mode before.
- **Phone shell (≤ 760 px):** `grid-template-rows: auto 1fr`; Home and More in the header; the menu closes on every page
  change. + New, Today and the visit flows have a Home button on the page from 761 px up. Main, forms and sections use
  `minmax(0, 1fr)` columns on a phone, so a wide table scrolls in its own box; New sale no longer scrolls sideways at 390 px.
- **Reuse:** `Failed`, `PAYMENT_METHOD_KEYS`, `OBJECT_ID_PATTERN` (home, New sale, `usableCustomers`), one payment-method
  wording (`methodWords`, Bill and Order page), one agreement tick (`AgreedTick`, three patient steps). Unused keys removed.
- Decisions (owner away): there is no patient history page yet, so **Find patient** is + New's step 1 (titled Find patient);
  a new number on + New is typed twice there, so the flows do not ask again; Today is newest first like the home; the
  Playwright tablet project is now a Galaxy Tab S4 held sideways (1138 px), since up to 760 px is the phone layout, which
  three 390 px journeys cover (example 1, Back after a visit, a masked name).

## WQ54c who the patient is, asked once on + New (2026-11-26, branch `wq54c/visit-who` from web stage 7e2bb7a)

The WQ54b re-check's blocker: visit mode dropped "Who is the patient?", so a mother on her son's phone, or a mother's child,
was booked as the phone's owner. + New's step 1 is now the one place the patient is chosen.

- **Who, on + New:** after Find, the number's lookup (`POST /pharmacy-assisted/patients/lookup`) says "This number is on
  Jansetu: R*** K***" (or "This number is new to Jansetu."), then two big buttons, **This person** (their name; the name
  this pharmacy typed is offered, a masked one never) and **Someone else (family member)** (name, relation, sex, date of
  birth and the phone owner's name, the full step's own fields: `PatientFields`, shared, not copied). A new number is typed
  twice there. Checked with the flows' own rule (`patientProblems`).
- **Handed over once** with who it is and the lookup (`VisitPatient.family`, `.lookup`): the flow draws its draft from it
  (relation and details for a family member) and does not look the number up again; it shows "Patient: Ravi (son of S***
  D***) [Change]". **Change** goes back to + New's step 1 with the number kept (a one-shot memory slot) and asked again.
- **Counter sale:** an order has a customer, not a patient, so a family member's medicines are sold to the phone's owner
  (the found customer, or a walk-in by the owner's name); the page says so. The sale has no patient name, so the bill is
  unchanged.
- **Polish:** step 1 has one box (digits: the phone; letters: a name, this pharmacy's patients by the same POST search);
  every Find asks the server (no cache); Find patient says "Find a patient to see or start a visit." and lists the number's
  visits of today (r37c's day search by phone). The agreement is one plain sentence ("…for this visit", or "…for this test"
  on Book lab test, a lab booking from a consultation and the lab desk) with the full statement behind **Read more**. A
  sale's payment and bill opened from + New keep the 17 px type, with one obvious next step (**Done**, to the home) and
  the rest small. The phone header is one row at 390 px: the short brand and Home and More as 48 px icon buttons, named
  for screen readers.
- Decisions (owner away): the who question is asked for new numbers too (a child on a mother's new number is a family
  member, with the owner's name optional, as in the full step); the family members booked here before are not offered on
  + New (the server reuses a same-name, same-relation member); the bill shows no patient name (the sale has none).

## WQ54d before the older-user test (2026-11-26, branch `wq54d/older-user` from web stage 95b0f32)

- **Phone header:** still one row; a short word under each icon, **Home** and **Menu** (Close while open), which are also
  their names for screen readers.
- **Visit sale bill:** the big **Done** shows only once the sale is paid; until then the next step is choosing cash, UPI or
  card and Mark paid. A sale that cannot be paid here yet (the pharmacist reviews a prescription first) gets a plain Done.
- **Read more** is a 48 px target.
- **Consent line:** one plain line that still names what the statement allows, chosen by the statement shown: a pharmacy's
  consultation ("Jansetu keeps their details (an account for this number), the doctor sees them, and this pharmacy can see
  the prescription for 90 days"), a lab's consultation (this lab), a pharmacy's lab test (the lab sees them), the lab desk
  (the report goes to their Jansetu app) and a doctor's lab test (you can see the report for 90 days). The full statement
  stays behind Read more.
- Seen, not changed: a pharmacy's lab test records and shows the consultation statement (`labBooker.ts` uses
  `CONSENT_STATEMENT`, which speaks of a consultation and a doctor); its short line says what a test allows. A lab-test
  statement for pharmacies needs a new versioned text on the server.

## WQ54e one lab-test statement (2026-11-26, branch `wq54e/lab-test-consent` from web stage 571f5c5; backend r37d a6ac7f3f)

- A pharmacy's and a doctor's **lab-test** bookings attest one statement, `LAB_TEST_CONSENT_STATEMENT` (version
  `web-lab-test-v1`, language `en`; one constant in `assistedLab.ts`, no copies), shown word for word behind Read more on
  both Book lab test pages and sent with that version. It replaces the doctor's `web-doctor-lab-v1` text and the
  consultation statement the pharmacy's lab tests used (WQ54d's "seen, not changed"). Consultations keep their own
  statements (the server refuses the lab-test one on a consultation, 400 `CONSENT_STATEMENT_MISMATCH`).
- The short lines are unchanged: a pharmacy's "…and the lab sees them for this test", a doctor's "…the lab sees them, and
  you can see the report for 90 days" (chosen by who books, since the statement is now shared).

## WQ55 the simple lab front-desk home, P4 (2026-11-26, branch `wq55/lab-home` from web stage 47289d6; backend r38 85c10c6e)

The pharmacy's simple home (WQ54–54e), for a lab member, with the same pieces, not copies.

- **Shared front desk (`screens/front/`).** The home, + New, Today, the visit handover and the visit bar moved out of
  `screens/pharmacy/` and now serve both desks through one config (`desk.tsx`, `useFrontDesk`): routes, big buttons, + New's
  choices, the number lookup, the patients search (a pharmacy's only), the waiting work and where it is done, and a
  "not allowed" sentence. `todayApi(c, 'pharmacy' | 'lab')` reads `/pharmacy-assisted/*` or `/partner-workspace/*` (today,
  today/search, todos); `todayLink(item, desk)` opens each desk's own pages. The visit memory is keyed by the signed-in
  person.
- **Lab home (lab members, owners and staff):** big buttons **+ New**, **Find patient**, **New bill** (the existing bill),
  **Today**; the day's money (r38 adds **bank**), the waiting work (samples to collect today, reports to upload and to
  release, unpaid bills, bookings waiting for payment, consultations waiting; a queue the member may not read is absent, a
  failing one says "couldn't load"), the latest 10 and the to-dos. A desk booking's money is on its bill: its row says
  "Paid on its bill". Rows are worded from r38's `lab.tests` (a home collection says so) and `bill.items`.
- **+ New (`/partner/new`):** the same step 1 (phone only: a lab has no patient list to search by name), with "This person /
  Someone else", the lookup this member may make (the desk's with `bookings.manage`, else the doctor booking's with
  `assisted.book`; a member with neither types the number twice). Then **Lab test at the desk**, **Home collection** (the desk
  opened on a home collection, `home=1`), **Book a doctor** (2e), **Bill**, each by permission, through the one-shot handover
  and visit mode ("Patient: … [Change] [Home]"). A bill for a family member is in the phone owner's name (an in-house bill
  has a customer, not a patient).
- **Permissions and branch scope:** only the buttons and choices the member's permissions allow; the waiting work links only
  to pages they may open; a member allowed no visit is told "To start visits or bills here, ask the lab owner to allow
  them"; a refused read says "Ask the lab owner to allow this." (never a blank screen). The desk keeps its branch scope; the
  server scopes the register.
- **Mark paid needs a chosen method** on a bill too: the bill's payment form starts with no method ("Choose…") and says
  "Choose how it was paid…" until one is chosen (every partner's bills; the specs now choose one).
- Decisions (owner away): Today for a lab is in the menu's Lab section; the lab's register is open to every lab member (the
  server decides what each sees); the lab's to-do example speaks of samples.
- **r38b slots (ahead of it landing):** "Refunded today ₹x" as its own line when the day's `totals.refundedMinor` is above 0
  ("Collected today" unchanged); `pending.deskUnbilled` as "N walk-ins without a bill" (to the lab bookings, one to its page);
  a desk booking row that carries its bill's paid state shows it like any paid row (else "Paid on its bill"); branch-scoped
  lab to-dos need nothing here (the server scopes them).

## WQ55b the lab desk, shorter and truthful (2026-11-26, branch `wq55b/lab-home-simpler` from web stage 531c3a3; backend r38b f86bf769)

- **Truthful rows.** A desk booking's row (r38b: paid when its bill is) says "Paid (cash)" once its bill is paid; otherwise
  "No bill yet" (it is in r38b's `deskUnbilled`), "Bill not paid" (its bill is in the list) or "Pay on its bill" (warn), never
  a claim of payment. Bookings waiting for payment are doctor bookings ("N doctor bookings waiting for payment", to the
  consultations; one to its page). A waiting line this member cannot open is plain text, not a pill.
- **One row per visit (Today and the home).** A bill naming its desk booking is folded into that booking's row
  ("Meena Iyer: CBC · ₹300.00 · Paid (cash)"); a bill on its own says "Bill · …". **Asked of the server:** r38b's bill items
  do not say their booking (the service reads `labBookingId` but leaves it out of the item); the web reads an optional
  `labBookingId` on `kind: 'bill'` items. Until it is sent, a desk booking and its bill stay two rows (both truthful).
- **Access.** Today (the button, the menu and the home's register) only for members holding a register reader permission
  (lab bookings, bills or `assisted.book`); a refused read says "Ask the lab owner to allow this." once, with no Try again.
  "Home collection" only when one of the member's branches does home collection.
- **Shorter walk-in (12 taps at one branch, 13 with two: + New, Find, This person, Next, Lab test at the desk, the
  agreement, Next, [branch], CBC, Book for ₹300.00, Issue bill for ₹300.00, Cash, Record ₹300.00 paid).** In a visit the desk
  books at once (the button names the total; the check step only returns after a refusal) and opens its bill; the patient's
  language starts as the workspace's (else English); the tests come first and a doctor's code is a small link. The bill from a
  booking starts with its booked tests at today's catalogue price (no API change: the server takes catalogue lines for a
  desk booking's bill and does not check them against the booking, L10; a test no longer offered is left out). The visit's
  bill shows name ("Name on the bill", asked when + New had no owner's name; never blank, never a masked name), phone, items
  and total, with age, sex, GSTIN, state code and the GST lines behind "More details", and is issued at once ("Issue bill for
  ₹300.00"). Its payment is cash, UPI, card or bank as 48 px buttons and one "Record ₹300.00 paid" (the whole due), with the
  longer words behind "Read more", a reference and a note behind "Add a note", and "Cancel bill" under "More actions"; once
  paid, one "Done". Outside a visit the desk's Booked screen makes **Make bill** the main button ("Book for another patient"
  secondary).
- **Bill payment rules.** A ₹0 bill keeps "Mark as paid" enabled and says "Choose how it was paid…" without a method; the
  money returned on cancelling has no default method either ("Choose how the money was returned.").
- **r38b:** refunds that day ("Refunded today ₹x", collected unchanged); `deskUnbilled`; branch-scoped to-dos (nothing here).
- Cleanups: the lab's unused `bookingTo` removed (a pharmacy's only); the "server could not read" comment back on its keys;
  "Walk-in now, Indiranagar" (no "now" twice).
- Decisions (owner away): a visit's booking and bill skip their check steps (each button names the total; a refusal brings
  the check back); the short payment records the whole due (part payments stay on the full form); the tap count is from + New
  to the recorded payment, typing not counted.

## WQ55c lab desk polish (2026-11-26, branch `wq55c/lab-desk-polish` from web stage c59c07a; backend r38c 9b512b92)

- **Rows.** A cancelled desk booking reads "Cancelled", a no-show "Did not come"; a bill paid in part (`partly_paid`) "Part paid".
  r38c's `labBookingId` on bill items (null for a member who does not read lab bookings) folds a bill into its booking's row,
  as built in WQ55b; Today's count is of the rows shown (the day's count less the bills folded in the rows read).
- **One bill prefill.** The desk, "Walk-ins without a bill" (to the booking) and the booking page's "Make bill" share
  `billPrefillOf` (the booked tests; the name when the patient is the owner; the phone when known) and open the short bill.
  Booked tests the catalogue no longer offers are named on the bill ("Not on this bill (no longer in your catalogue): …").
- **Words.** "Choose how it was paid." on the full form, "Tap cash, UPI, card or bank." on a visit's (only the methods
  offered); the desk intro no longer says to make the bill from the booking.
- **Desk in a visit.** Once Next is tapped, the patient is one line ("Patient: Meena · ✓ agreed [Change details]") and the
  tests are at the top (also in the pharmacy's visit flows). + New's choice is the visit (at the desk now, or a home
  collection): no other is offered. With several branches the desk starts at this person's last-used branch (session memory,
  per person), else their own first. The messages' language is a line, "Messages in: English [Change]" (English, the one
  released; the full desk keeps its select).
- **Bill in a visit.** Its lines first; "Add another test" is a small link opening the catalogue, which leaves out the tests
  already on the bill (no hand-written line in the short bill). Home before the bill is issued asks "Leave without a bill? The
  walk-in stays unbilled." (Stay is the main answer; a data-router blocker on the way to Home only).
- Taps for a walk-in CBC in cash: 12 at one branch, 13 the first time at two branches, then 12 (the branch is remembered).

## WQ57 the simple clinic reception home, P3 (2026-11-26, branch `wq57/clinic-home` from web stage 85b3815; backend r40 21a4a92b)

The lab's front desk (WQ55–55c), for a clinic's reception, through the same `front/` pieces (`useFrontDesk` gains a clinic
desk; nothing copied).

- **Home:** big buttons **+ New**, **Find patient**, **New bill**, **Today** by permission; **Doctors today**: each clinic doctor
  with their next appointments and, in grey, "12:00–12:30 Busy" when taken elsewhere (r40 `busy`, the time only: never the
  patient or the place; for members who read the clinic's day); the day's money (the lab's shape, refunds and bank); waiting
  work ("3 to check in · 1 to confirm · 2 walk-ins without a bill · 1 unpaid bill"); the latest rows; shared to-dos.
- **Today** (`/partner/today`, now next to Home in the menu for labs and clinics alike): r40's rows. An appointment reads
  "Dr Kavya · 10:15 · In person"; a bill naming its appointment (`appointmentId`) is folded into that row, as a lab's; an
  online appointment paid online reads "Paid (online)" (not in the clinic's money).
- **+ New (`/partner/new`):** the same patient step (This person / Someone else; the clinic desk has no number lookup, so the
  number is typed twice), then **Appointment now (walk-in)**, **Appointment for later**, **Bill**, each by permission.
- **The desk in a visit** (`/partner/desk?visit=1&when=now|later`): the patient named once; the branch (the last-used one
  first, session memory); the doctors as big buttons (one at the branch: chosen at once); "now" offers the doctor's next free
  time today, "later" a day and its free times; a time inside the doctor's busy block is never offered ("Times when the
  doctor is busy elsewhere are not shown."). "Book Dr Kavya at 10:15" books in one tap through the desk's own keyed booking,
  then opens the short bill with the doctor's fee on it ("Consultation · Dr Kavya", a hand line at 0% GST, from the
  appointment's fee); a member without bills sees the receipt and Done. The desk's own "Create bill" also starts with the fee
  and is the main button on its receipt.
- **Taps for a walk-in with Dr Kavya paid in cash: 9** (+ New, Find, This person, Next, Appointment now, Book Dr Kavya at
  10:15, Issue bill for ₹500.00, Cash, Record ₹500.00 paid); one more when the branch has several doctors.
- Decisions (owner away): an appointment row opens the reception's day (there is no appointment page); the fee line is a
  hand line at 0% GST (a consultation is exempt); "now" is the doctor's next free slot today.
- r40c (coming, no shape change): busy blocks rounded out to 15 minutes and clipped to the range read are drawn as given
  (their own from and to) and checked against a time by overlap, never by whole slots; `deskUnbilled` counts up to today on
  the server.

## WQ57b clinic reception polish (2026-11-26, branch `wq57b/clinic-polish` from web stage 7b76939; backend r40, r40d coming)

- **Shared sessions.** The client no longer drops slots that overlap a busy block: the server leaves out a one-patient slot
  inside the doctor's busy time and refuses one (409 `DOCTOR_BUSY`); a shared session (several seats) stays offered. The note
  "Times when the doctor is busy elsewhere are not shown." stays; a refusal reads the slots and the busy times again.
- **Dates on rows.** An appointment on another day than the register's says it ("Dr Kavya · Fri, 27 Nov · 11:30 · In person").
- **Patient identity.** + New uses the clinic's lookup (r40d, built to the lab's `{ exists, holderNameMasked }` on
  `POST /partner-workspace/clinic/patients/lookup`): "This number is on Jansetu: R*** K***", the number typed once. The
  receipt names the server's patient (the booked row read back), and a visit's bill opens only once that row is read, from it
  (`prefillOf(row)`, the short bill), never from typed names.
- **Visit page.** It starts with its task ("Appointment now" / "Appointment for later"), no desk heading or intro. Several
  branches are big buttons with none chosen (the one used last is marked "Used last"); the Book button names the branch
  ("Book Dr Kavya at 10:15, MG Road") and stays in sight at the bottom of a short phone (sticky). "Now" says "Next free:
  10:15"; "later" has Today, Tomorrow and Pick a date.
- **Short bill.** No "Not for this appointment"; no Remove on the only line; "Add another item" at a clinic.
- **Doctors today.** Next appointments sorted by their time, then the first three; "No appointments" for a doctor with none.
  Waiting work: "N waiting for online payment" (r40's to-confirm).
- **Desk "Create bill".** When the clinic's catalogue has a consultation item for that doctor (its name names the doctor, or the
  only consultation at the fee), the bill uses it instead of a hand-written fee.
- **Find patient (clinic).** Also by name, among today's appointments (the day view), so one booked on an earlier day is found;
  a number's appointments today are listed under it.
- **Tidy-ups.** The busy and lookup comments in place; `dayView` and `appointments` share one checked query; the front desk's
  branches are read for a lab only; a clinic's register readers (`CLINIC_REGISTER_READERS`: its bookings or its bills).
- **Taps for a walk-in with Dr Kavya paid in cash: 9 at one branch** (+ New, Find, This person, Next, Appointment now, Book Dr
  Kavya at 10:15, Issue bill for ₹500.00, Cash, Record ₹500.00 paid); 10 with two branches (one tapped).

## WQ57c clinic fixes (2026-11-27, branch `wq57c/clinic-fixes` from web stage 6bc8c1d)

- **Blocker: a server without r40d's lookup.** The clinic's lookup answers a 404 with no code as "not known" (null): + New goes
  on and the number is typed twice. A 403 or 429 is said as before.
- **The fee stays on the bill.** A clinic consultation item replaces the hand-written fee only when its price matches
  and it contains the doctor's full name as whole words. This also applies when the catalogue lists a single consultation.
- **The receipt's name** is the server's (clinic-desk's lost-booking check now expects "Meena with Dr Mehta").
- **No dead end after booking in a visit.** When the booked row cannot be read back, the error with Try again; when it is not
  there yet, "The appointment is booked. Its details could not be read yet." and "Make the bill" (reads it again).
- **Find patient (clinic):** each of today's desk appointments not billed yet has "Bill this appointment" (the short bill,
  linked to the appointment, its fee on it).
- **Missing mobile number:** a bill linked to an appointment asks for the account holder's mobile number when the server omits it.
  Known numbers stay read-only, and the server checks that the number belongs to the appointment's account holder.
- **Menu:** a clinic's Today needs a clinic register reader (`partnerPermissionsByKind`: its bookings or its bills).

## WQ59 user guides for the simple homes (2026-11-27, from web stage 68fe44d)

The pharmacy, lab, clinic and doctor guides (`docs/guides/*-guide.md`) gain, after Sign in: the phone's Home and Menu,
"Your home" (each big button, the money lines, what waits, the register, who sees what), "+ New" step by step with a
worked tap path (pharmacy: medicines in cash; lab: a walk-in CBC in cash, 12 taps; clinic: a walk-in with Dr Kavya in cash,
9 taps; doctor: a clinic or online appointment), "Today" and "To-dos" (shared at a counter, private for a doctor), each with
its Switch line (none; each + New choice keeps its own page's switch). The menu tables gain Home and Today; payments say
that nothing is chosen for you. Word and PDF rebuilt in `~/Desktop/SwasthaDisha/Jansetu-user-guides` with
`docs/guides/md2html.py` and `soffice` (as WQ53).

## WQ31 UI translation, round 6a: the foundation (2026-11-25, branch `wq31/i18n-foundation`)

Specification: [I18N_PLAN.md](I18N_PLAN.md) (WQ30); its recommended answers stand as ASSUMED, Q1–Q5 are with the owner.
Nothing visible changes: English stays byte-identical and no language list shows until a second language is released.

- **`@jansetu/i18n`** (new workspace package, no dependency, no React): `catalogue(name, en, import.meta.glob(...))` returns a
  typed `t(key, params)`: keys and `{placeholders}` typed from the English source (`en.ts`, `as const`), `{ one, other }`
  plurals through `Intl.PluralRules`, English per word when a translation is missing (noted once in development, by key
  only), `t.rich` for elements inside words, `t.has` for keys made from server codes. Other languages are JSON chunks
  loaded when chosen; a language that cannot load changes nothing; the last switch wins.
- **Start-up** (`startLanguage(app)` before the first render): the code kept on this device if the app offers it, else the
  first offered browser language, else English. Offered = `RELEASED` in `languages.ts` (English only for both apps). A
  choice (`chooseLanguage`) keeps only the code in `localStorage['jansetu.lang']`. The pseudo-language (`pseudo`:
  bracketed, accented, 35% longer) can be kept only in development and tests.
- **React side** (`@jansetu/ui`): `useLanguage`, `LanguageScope` (the page content mounts again on a switch; the session,
  the query cache and a doctor's presence stay), `LanguageSwitcher` (renders nothing while one language is offered;
  placed on both sign-in screens, the customer Profile and the workspace side bar), `Parts`.
- **Formats** (`format.ts`): the 15 `Intl` call sites and the duplicated helpers now go through `formatRupees`,
  `formatPaise`, `formatDateTime`, `formatYmd`, `formatClock` and `formatDateWith(at, options)`. Money is `en-IN` in every
  language; dates use `<lang>-IN-u-nu-latn`; English is `en-IN` exactly as before (`assistedCard`'s `en-GB` clock gives
  the same text). `formatRupees` and `formatDateTime` are still exported by `@jansetu/ui`.
- **Checks in `npx vitest run`:** `catalogues.test.ts` (extra keys, shapes, plural forms, empty, placeholders, stale against
  `<lang>.source.json`, released languages at 95% per app); `literals.test.ts` (no English written into code: JSX text,
  word attributes, sentences, templates; `// i18n-ignore` for non-UI strings) with `packages/i18n/literals-allowlist.txt`
  listing the 159 files not extracted yet (6,228 findings), which fails when a listed file is clean so the list only
  shrinks.
- **Tests:** both Playwright configs pin `locale: 'en-IN'`; `tests/setup.ts` puts each test back in English; `e2e/i18n.spec.ts`
  in each app (English by default, no language list, nothing stored; a kept language not offered is ignored).
- Left for 6a2 (I18N_PLAN.md §4): the translator script, fonts and Indic CSS, typed Indian-script digits, saving the choice
  to the account (needs 6a-backend).
- **Merged with `wq/stage-next` bd0df6c** (push 1: lab desk, lab wallet, WQ21b; branch `wq31/i18n-merged`): the lab desk and
  lab wallet money words use `formatPaise` (English unchanged); `assisted.ts` exports `rupees` (= `formatPaise`) for WQ22c's
  desk; the scan no longer counts route attributes (`back="/admin/partners"`); the 7 new files with English are allowlisted
  (166). For the integrator: merging WQ22 adds its new files with English (`assistedInstant.ts`, and its `ConsultNowScreen.tsx`
  unless it is the doctor's, already listed) to the allowlist, and any `Intl` money call it adds goes to `formatPaise`.

## WQ26 referral cuts: the admin's rules per partner, the pharmacy's referral earnings (phase 4a/4b web) (2026-11-25, branch `wq26/referral-cuts`)

Backend: r24 on stage `6a8574e9` (ASSISTED_BOOKING_DESIGN.md §26.5, §26.6, §26.15; `src1/modules/referralCuts`). Web base:
`wq/stage-next-2` 13333e9. Behind `REFERRAL_CUTS_ENABLED` (off by default: rules are saved, nothing is cut); the rule PUT needs
`ASSISTED_ADMIN_TOOLS_ENABLED`; payouts stay off (`REFERRAL_PAYOUTS_ENABLED`, O1), so earnings show as due. Doctor cuts stay off:
no screen sets them. Owner rules: the cut is paid TO the booking partner, per partner and per category, as a % of each line or a
fixed amount per line, taken FROM the provider's earning; a percent is at most 50%, a fixed amount has no upper limit.

- **Admin › Pharmacies › a pharmacy › Referral cuts** (`/admin/pharmacies/:pharmacyId/referral-cuts`) and **Admin › Labs and
  clinics › a lab › Referral cuts** (`/admin/partners/:partnerId/referral-cuts`; a clinic is told cuts are for pharmacies and
  labs): one row per category (consultation, lab test, lab package) with the rule as saved (Off / x% of each line with its
  optional cap / ₹y a line), when it changed and its version, and Edit. The editor: Off, a percent of each line (0.01–50, two
  decimals, optional cap ≥ ₹0.01) or a fixed amount per line (≥ ₹0.01, no upper limit, no cap); Off sends the saved terms with
  `isActive: false`. Save opens `ConfirmAction` with the reason the history keeps, bound to the terms and the version it was
  made from (`expectedVersion`, 0 = create). 409 RECORD_CHANGED: nothing saved, the rules are read again ("Saved now: …") and
  the editor keeps what was typed on the new version. Sent with the owned PendingOp (`useOwnedOp` / `CheckPanel`): a lost answer
  is checked by reading the rules (a newer version with the same terms is the change; the same version is not saved yet, and
  sending it again is safe because the fence lets one attempt through). "Referral cuts are switched off; rules are saved but not
  applied." shows while an active rule is not `effective`. History: the three categories' events, newest first, with the
  reason and who.
- **Pharmacy › Referral earnings** (`/pharmacy/referral`, in the side bar): Due / Earned / Paid to you
  (`GET /pharmacy-assisted/referral`), "Payouts start once Jansetu switches them on." while `payoutsEnabled` is false, the rates
  read only (`/referral-rules`), and the statement (date, short ref, category, base, cut; no patient names) in cursor pages
  (`/referral/statement?before&limit`). Read only.
- **Shared, not copied**: `ConfirmAction`, `useOwnedOp` / `CheckPanel`, `useOneAtATime`, `useCursorPages` / `CursorPager`,
  `NoSuchRecord`, `useAdminScope`, the finance cards and `Signed`; money with `formatPaise`; rupees through `rupeesToPaise` /
  `paiseToInput`. One new API module, `packages/api/src/referralCuts.ts` (`referralRulesAdminApi`, `pharmacyReferralApi`, the
  draft → terms → body checks, the words, the statement row); its three new files are on the literals allowlist (172).

API gaps (none blocking):
- No answer carries the master switch: the screens read it from `effective` of an active rule, so with no active rule the page
  cannot tell (nothing is cut either way).
- Statement lines carry neither the short ref nor the category as fields (§26.6.2 lists them; r24 added `grossMinor` /
  `commissionMinor`): the ref is read from the server's words ("… · Ref ABCD2345") and the category from `source` (a lab
  booking is one row for all its lines). The pharmacy referral statement has no CSV route.
- The admin settlement list filters `ownerKind` by `partner | doctor` only, and shows a `*_referral` account's kind as its code
  (seen, not changed: phase 4e/4f).
### WQ26b referral follow-ups on r33's API (2026-11-25, branch `wq26b/referral-followups`)

Backend: r33 (`m0/r33-referral-gaps` 335e36c2, ASSISTED_BOOKING_DESIGN.md §26.16; local, under review). Web base: stage 25a860c.

- **The switch from the server**: the admin page's "Referral cuts are switched off; rules are saved but not applied." and the
  rates note read `switches.cutsEnabled` (beside the rule lists), also when no rule is set; nothing is inferred from
  `effective` (`referralCutsOn` removed). A server that does not send `switches` shows no note.
- **Statement rows from fields**: `shortRef`, `category` and `lines` (r33) instead of parsing `description`; a lab booking
  stays one row (`Lab tests and packages` when its cut lines differ) with its lines under it ("Lab test ₹300.00: cut ₹15.00").
- **CSV**: "Download CSV (all entries)" on the referral statement, the finance screens' `CsvDownload` (now exported), read
  with the token into memory (`…/referral/statement.csv`, saved as `pharmacy-referral-statement.csv` /
  `lab-referral-statement.csv`).
- **Lab › Referral earnings** (`/partner/referral`, side bar, labs only, `finance.view` with partner-wide scope, as the
  backend's `assertPartnerFinanceReader`): the pharmacy's page through one component with the booker kind
  (`screens/finance/ReferralEarningsScreen.tsx`; `referralReadsApi(c, { kind: 'pharmacy' } | { kind: 'lab', scope })`); a lab
  shows its consultation rate only (labs book consultations). `screens/pharmacy/ReferralEarningsScreen.tsx` is gone.
- **i18n**: the page's words come from a new catalogue `apps/workspace/src/i18n/referral` (`t()`; keys as WQ45 named them,
  `referralEarnings.*`); the page is not on the allowlist. `literals.test.ts` treats `scope` as technical (as WQ44 does). For
  the integrator: WQ45 extracted the old pharmacy file into `i18n/pharmacy` (`referralEarnings.*`); with WQ26b that file is
  deleted and those keys are unused.

### WQ26c review fixes (Opus review of 5475091, 2026-11-25, branch `wq26c/referral-fixes`)

- **A failed read again keeps what was read**: the earnings, rates and statement sections render their data whenever they
  have it; only without data do they show the error (with Try again) or the loading line.
- **The CSV of a period**: the referral statement has the finance statements' period fields (`useStatementPeriod` /
  `StatementPeriodFields`, now shared with `StatementSection`), so above 5,000 entries (the server's `EXPORT_TOO_LARGE`, said
  in its words) a shorter period can be exported; the list follows the same period (from its first page).
- **Lines**: a lab booking also lists its one cut line when that line is not the whole booking.
- **Words**: a category the page does not know is shown as sent (`t.has`); the pharmacy's categories are
  `REFERRAL_CATEGORIES`; the finance-reader rule is one helper (`isFinanceReader`) for the finance page and the lab's
  referral earnings; `ReferralSummary.cutsEnabled` (unused) is gone.

## WQ24 lab › Book consultation: a lab books a doctor consultation for a walk-in patient (phase 2e) (2026-11-25, branch `wq24/lab-book-consultation`)

Backend: r21 + r21b (stage `6a8574e9`, design ASSISTED_BOOKING_DESIGN.md §24.16–§24.17; mocked API). Web base: `wq/stage-next-2`
13333e9. Behind the backend's `ASSISTED_BOOKING_ENABLED_LAB` (off: the lookup, the doctor reads and a new booking answer 503, said as
"Booking for patients is not switched on yet. Jansetu turns it on for your lab when it is ready."); a card booking also needs
`ASSISTED_CARD_PAYMENT_ENABLED` (off: the card option is disabled, as for pharmacies).

- **Lab › Book consultation** (`/partner/book-consultation`) and **Lab › Booked consultations** (`/partner/consultations[/:id]`),
  next to Front desk; lab members holding the new partner permission `assisted.book` (owners hold it; offered for labs only in the
  staff editor as "Book doctor consultations for patients"); the lab's own members only (the lab wallet and payment routes have no
  admin mirror). The pharmacy's flow, unchanged: the patient (`POST /partner-workspace/assisted/patients/lookup`), family members
  the lab booked for before (from its own list), the lab's consent sentence (`web-lab-consult-v1`: "this lab can see the
  prescription … for 90 days"), **the branch the patient is at** (the member's active branches in scope; chosen at once when there
  is one), the doctors near that branch and their times (`?branchId`), mode, join ("On this lab’s device"), language, coupon,
  problem, then "How do you pay?": **the lab wallet** (the WQ20 balance; a member without `wallet.view` is told the lab's wallet pays
  and its balance is not shown; "Top up now" only with `wallet.manage`) or **card or UPI** (verified and reconciled on the lab's own
  `/partner-workspace/assisted/payments/verify|reconcile`). One keyed create `POST …/assisted/consultations` with `branchId`.
- **Booked consultations**: the list (`GET …/assisted/bookings`, the member's branches only), a consultation (`GET …/bookings/:id`;
  another branch's or another lab's is 404 `BOOKING_NOT_FOUND`, "Consultation not found"), Join call, "Pay now" / "Check payment"
  for a card booking waiting for payment, change time (same doctor), cancel before the start with the refund back the way it was
  paid (wallet; card by default, or the wallet on the lab's choice), and the prescription's dispensing copy (`/file/fetch` with the
  member's token; "the diagnosis is not shown to labs"). No typed-name edit (r21 F6) and no medicine order (pharmacies only).
- **Money safety, as for pharmacies** (the same code): an owned PendingOp stored before sending, settled only while live and
  `stillCurrent`; a request key with the check by key, the same request again, and "Give this up" (after a reload only the key);
  `PRICE_CHANGED` offers the server's price as a new request; card: the pre-checkout reconcile and no second Checkout once a payment
  is authorized. No token, phone, name or order id in storage, addresses or logs.
- **Shared, not copied** (owner: no duplicated code). `assisted.ts` `assistedBookerApi(c, kind)` is the one set of consultation
  routes (`pharmacyAssistedApi` = the pharmacy's + its medicine order; `labAssistedApi` = the lab's, `branchId` checked before
  sending); `assistedCard.ts` takes a `CardPayer` (`PHARMACY_PAYER` `/payments`, `LAB_PAYER` the lab's routes) in
  `bookingPaymentApi`, `settleCardPayment`, `beforeCheckout`, `checkCardPayment`, and names the booker in the blocked and not-found
  words. The screens take a `ConsultBooker` (`pharmacy/consultBooker.ts`: routes, refusal words, query keys, the paying wallet,
  the card payer, the consent, the pages, a lab's branches): `BookConsultation`, `BookedConsultationsList`,
  `BookedConsultationDetail` and `ChangeTime` are the pharmacy's, generalised; `PayChoice`/`WalletPay` take a `PayWallet`
  (`pharmacyPayWallet` by default); `usePatientStep` takes the booker's routes; `consultationCardSource` takes the booker's routes
  and payer; `JoinFields` and `joinWords` name the booker. The lab screens (`partner/LabConsultScreens.tsx`) only build the lab's
  booker and the headings. Pharmacy behaviour, look and specs unchanged.
- **Visible outside these screens**: the lab staff editor offers "Book doctor consultations for patients" (a clinic never).

API gaps:
- The booker view carries no `assisted.bookedBy.branchId`, so Change time reads the doctor's times with the member's first branch in
  scope (r21 requires a branch on the slots read; the times do not depend on it), and the booking page cannot name its branch.
- A lab's refusals of the reschedule (permission, branch scope) fall back to the server's message (the shared reschedule words).

Seen, not changed: the admin card refund queue (`admin/CardRefunds.tsx`) still names only `pharmacyName`, so a lab-paid row shows "—" and
its words say "the pharmacy" (r21 adds `payerKind`, `payerId`, `payerName`); the pharmacy-only limit words (`new_accounts`,
`booker_cancellations`, no longer blocking limits) and the `PHARMACY_*` refusals keep their pharmacy words; the document viewer still
reads files through `pharmacyAssistedApi(api).file` (the same `/file/fetch` for any token).

### WQ24b card refunds name their payer; a lab's refusals in its own words (2026-11-25, branch `wq24b/card-refund-payer`)

On WQ24 33439af. Against r21 (§24.17.3 "Admin": card refund rows add `payerKind`, `payerId`, `payerName`).
- **Admin › Pharmacy wallets › Card refunds of bookings that need a person**: each row names its payer (`payerName`, else an older
  answer's `pharmacyName`) under "Paid by" (was "Pharmacy"); the cause "Cancelled by the pharmacy|lab|doctor", the agreement
  ("The lab's agreement", "Write what the lab agreed to …"), the explanations, the button names and the answers name the payer's
  wallet. One `payerWord(kind)` (`assistedCard.ts`, an older answer is a pharmacy's) with `payerNameOf` and `cardRefundCauseLabel`;
  `agreementProblem` takes the payer. Pharmacy rows read exactly as before; the intro now says the bookings may be a pharmacy's, a
  lab's or a doctor's.
- **A lab's refusals** go through its `ConsultBooker.refusal` (`labBookerRefusal`) where it can meet them: the patient lookup
  (`usePatientStep`), the change of time (`rescheduleRefusal(err, refusal)`, the pharmacy's words by default) and the card panel's
  reads (`CardBookingSource.refusal`). The `PHARMACY_*` refusals (`PHARMACY_INACTIVE`, `PHARMACY_NOT_VERIFIED`,
  `PHARMACY_PROFILE_REQUIRED`) are raised only by the pharmacy's own guards (`middleware/auth.ts`), so a lab never meets them; the
  lab's counterparts (`PARTNER_NOT_VERIFIED`, `PARTNER_INACTIVE`, `LAB_PARTNER_REQUIRED`) were already in `labBookerRefusal`.
- **WQ24 review must-fix: a failed read again no longer tears the booking down.** In TanStack 5 a failed background refetch sets
  `isError` and keeps the data, so `LabOnly` (`partner/labs.tsx`, also the front desk, lab bookings, slots and wallet),
  `LabBookFlow` and the shared booked consultation page (pharmacy and lab) replaced a booking, or its waiting card payment,
  with an error page when the member came back from a UPI app on a weak network (and might pay again). They are now gated on
  the data (`!data` → error or loading); the booking page says "Could not refresh just now" (the doctor screens'
  `RefreshFailed`) and keeps the payment panel.
- **Also from the review**: the wallet pay's top-up reads the balance again only with `wallet.view` (a member with
  `wallet.manage` alone never calls a read it may not make); a 403 `INSUFFICIENT_PERMISSIONS` on the lab's verify or reconcile is
  said as a permission (`CARD_PERMISSION_WORDS`), "not active or not verified" only for the account (`PARTNER_NOT_VERIFIED`,
  inactive); one helper for the lab wallet's routes, query key and keyed top-up (`labWalletOf`, `LabWalletScreen.tsx`), used by
  the Wallet page and the lab's wallet pay.
- **Tests**: a failed refetch of the lab and its branches with a card booking held (failing before the fix), Check payment and
  Pay now from the booking page with a failed read again in between (failing before the fix; the pre-checkout reconcile and the
  proof on the lab's routes), Change time for a lab (a branch in scope on the slots read), a lab refused at the lookup in the lab's
  words, and the admin queue with a lab-paid and a doctor-paid refund.
- Seen, not changed: "Open the booking" in the queue links every row to the admin consultation page, also a lab-test booking's
  (`bookingKind`).

## WQ40 UI translation engine: i18next + react-i18next (2026-11-25, branch `wq40/react-i18next`)

Owner decisions of 2026-11-25, recorded in [I18N_PLAN.md](I18N_PLAN.md) §1 items 7–9 and §3.1: use the open-source
`i18next` + `react-i18next` instead of WQ31's in-house engine; translations are machine-made only (IndicTrans2), static
JSON files, no human checker; a language is released once 95% of its app's words are **present** (was "checked").
Nothing visible changes: English is byte-identical and the language list stays hidden (English only in `RELEASED`).

- **Engine** (`packages/i18n/src/store.ts`, `index.ts`): one i18next instance; each catalogue is a namespace of flat keys
  (`keySeparator`/`nsSeparator` off); `{name}` placeholders inserted as written (no escaping, nesting or second pass);
  plurals stored as `key_one`/`key_other`; English fallback per word; only words shaped like their English entry are
  loaded. i18next fetches nothing: `catalogue()` adds English, `setLanguage()` loads each catalogue's `<lang>.json` chunk
  (as before) and then switches. The pseudo-language is an i18next language generated from English in development only
  (not in either release bundle). The missing-word note (development, key only) reads i18next's `usedLng`.
- **Same API for every builder:** `catalogue(name, en, import.meta.glob(...))` → typed `t(key, params)`, `t.rich`, `t.has`;
  `setLanguage`, `chooseLanguage`, `startLanguage`, `getLanguage`, `subscribeLanguage`, the format module, `jansetu.lang`,
  `RELEASED`, `LanguageScope`, `LanguageSwitcher`, `Parts` are unchanged in shape. Code written against 6a needs no change.
- **React** (`packages/ui/src/language.tsx`): the instance is registered with react-i18next (`setI18n`, no provider needed)
  and `useLanguage()` is `useTranslation()` (no Suspense; it also renders again when words are added, so a catalogue
  loaded late shows its words).
- **Dependencies (owner-approved):** `i18next` 27.2.7 in `@jansetu/i18n` (still React-free, so `@jansetu/api` can use it)
  and `react-i18next` 18.0.3 in `@jansetu/ui`, pinned. No other package.
- **Gate:** `catalogues.test.ts` still fails on extra, misshapen, empty, misplaced or stale words; a released language needs
  95% present (machine translations count). `packages/i18n/README.md` tells builders how to extract a string.
- Seen, not changed: customer `e2e/native-session.spec.ts:178` and `e2e/pharmacy.spec.ts:370` fail on unchanged stage
  bac568e too (after a sign-in and a reload the app shows the sign-in screen or stays on "Signing you in…").

## WQ45 UI translation, rounds 6e, 6f and 6i: the pharmacy and doctor workspace screens (2026-11-25, branch `wq45/i18n-pharmacy-doctor`)

Base: `wq45a/merge-24b-27` 3233a59 (origin/stage 25a860c with WQ27, and WQ24 + WQ24b merged), then the WQ24b re-check fixes.
Only `apps/workspace/src/screens/pharmacy/**`, `apps/workspace/src/screens/doctor/**` and their catalogues changed.

- **Two area catalogues** (docs/I18N_PLAN.md §3.2): `apps/workspace/src/i18n/pharmacy` (`workspace-pharmacy`, 1,162 keys: the
  pharmacy operations of 6e, the assisted booking and wallet of 6f, and the booking pieces every booker shares: `patientStep`,
  `walletPay`, `cardBooking`, `ownedCancel`, `unconfirmedBooking`, `bookingFields`, `recommendedTests`, `labBooker`) and
  `apps/workspace/src/i18n/doctor` (`workspace-doctor`, 401 keys, 6i). Keys are `<screen>.<words>`; words used by more than
  one screen of an area are `common.*` there (133 and 18; WQ42's shared keys were not available, so these are area-local).
- **English byte for byte**: the move was made with a TypeScript codemod on the literal scan's own rules (JSX text as React
  renders it, attribute and string values as written, templates with `{placeholders}` for their values, a value that is not
  text passed through `String()` as the template did). No assertion changed.
- **Booker wording as keyed variants**, never an English word passed in: "By your pharmacy|lab", "On this pharmacy’s|lab’s
  device", "The doctor calls this pharmacy|lab", "Your pharmacy’s|lab’s|doctor’s Jansetu wallet pays…", "…turns it on for your
  pharmacy|lab…", "…not shown to pharmacies|labs", "Only used the first time your pharmacy|lab books…".
- **No words at module load** (§3.4.1): 19 module-level labels and sentences became functions called at render
  (`STATUS_FILTERS()`, `FORWARD_LABEL()`, `NOT_OPENED()` …). Local bindings named `t` were renamed (`timer`, `text`, …).
- **Allowlist**: the 49 pharmacy and doctor files left it (the literal scan passes).

Left (for the next rounds):
- Three module-level words stay constants because screens outside this round read them: `REFUND_STATUS_LABEL` (admin
  refunds), `UNPAID_CHECK_AGAIN` and `CHECK_LABEL` (the lab wallet); they become functions with those screens' rounds.
- Sentences around an inline value or element are still split into pieces (`Collect ` + amount + ` from the patient`);
  joining them with `t.rich` is a separate pass, so translators get whole sentences.
- Words built from fragments passed in as props (`what="booking"`, `noun="copy"`, `when` "… at …") and a few lower-case
  fragments the scan does not flag stay as they were; the shared words from `@jansetu/api` (refusals, `joinWords`, the
  consent statements) are WQ42's.
- No translations (the IndicTrans2 pipeline) and no pseudo walk yet (§4.1 item 4).


## WQ49 UI translation fixes before a second language (2026-11-25, branch `wq49/i18n-fixes` on stage 53e523e)

The review items of the integrated i18n review. English is unchanged except the named changes below.

- **Whole sentences:** the 230 pharmacy and doctor values that were pieces glued to a value ('Page ' + n + ' of ' + m)
  became 162 sentences with `{placeholders}` (a TypeScript codemod over the JSX); counts are plurals (`one`/`other`),
  optional parts are separate sentences. `catalogues.test.ts` refuses a value that starts or ends with a space.
- **The literal scan** also finds words shown as they are: a JSX child, a branch of a choice inside one, a word
  attribute's value, a value given to a catalogue word. `i18n-ignore` needs a reason and covers only its own line (after
  code) or the next one. What it found is now catalogue words; the allowlist is empty (`LabConsultScreens.tsx` extracted).
- **No words fixed at load or kept in state:** `UNPAID_CHECK_AGAIN`, `CHECK_LABEL`, `REFUND_STATUS_LABEL` and the weekday
  maps are read at render; the workspace session notices are codes (`SessionNotices`, as the customer's), so the sign-in
  screen no longer compares sentences; the doctor's presence keeps word functions, not words.
- **One copy:** `networkWords()` ("Could not reach the server…") for both sessions; one `genderLabel` for the partner
  screens; `shared()` for the page-not-found, secure-storage, code-sent and empty-wallet-history sentences;
  `useOneAtATime` takes a code (`busy.what.*`); `UnconfirmedBooking` takes a kind with whole sentences.
- Short weekday names come from `Intl` (`weekday: 'short'`), never cut from the long name; `money()` shows "—" for an
  invalid amount again (not ₹NaN); `x == null` where `??` became `=== undefined`; both `main.tsx` start the app even if
  the language start fails.

Named changes (English or behaviour):
- "Card money (withdrawals coming later)" → "Card money": withdrawals exist since WQ29 (e2e `lab-wallet.spec.ts:217`,
  `doctor-wallet.spec.ts:158,246` updated to the new words).
- "Issued in this’s own series" (a bill of a partner without a name) → "Issued in this partner’s own series".
- d5ccd0e (WQ24b re-check, recorded here): Book consultation checks the switched-off notice after the booking states,
  so a held card booking or a made booking stays on screen when a background doctor read answers 503; "Book another
  consultation" then forgets that read (WQ47 4f28c39).
- Kept on purpose (d5ccd0e, `assistedCard.ts` `outcomeOfError`): the card-payment permission words ("Ask your lab’s
  owner") show only for a lab member's 403 `INSUFFICIENT_PERMISSIONS`. That code is the partner workspace's member
  permission (r21); a pharmacy or a doctor has no members, so its 403 on the payment routes is the account's state and
  keeps the account words (`wq24.test.ts` asserts both).

Left: sentences still holding a computed phrase as a placeholder (`{state}`, `{rows}`, `{mode}`) where a full split would
multiply variants; the api's own repeated sentences across its area catalogues ("Give a reason (at least {min}
characters).", "Enter whole minutes from {min} to {max}.").
## WQ46 customer sign-in then reload: two Playwright journeys over their time (2026-11-25, branch `wq46/signin-reload`)

`native-session.spec.ts:178` and `pharmacy.spec.ts:370` failed in full customer runs (desktop and phone): after a
sign-in and a reload the page showed "Signing you in…" or the sign-in screen. **Not an app bug; no app change.**

- **Every failure was the 30 s test timeout**, hit during a full page load near the end of the journey. These two are the
  longest journeys in the suite: five and seven full page loads. Against the Vite dev server each load fetches every
  module again: about 3 s with the machine quiet, 4–7 s under load. The app's own steps were instant: the session call
  went out within milliseconds of the page loading, every answer was handled, and every check passed.
- **Pass rate on unchanged stage 25a860c** (load average 45–55 from other agents): 8/8 at 1 worker (13.7–19.3 s each);
  4/12 at 5 workers, the suite's default (all 8 failures "Test timeout of 30000ms exceeded"). With a 90 s budget, 4/4
  passed at 33–37 s. Against the production build (`vite preview`), all 4 passed in 8–12 s with the default 30 s.
- **No commit introduced it.** The journey took 18–30 s alone at a313850 (22 Nov), 0aca6c3 and 25a860c alike; it was
  always close to 30 s and fails when the machine is busy (WQ41's run passed both).
- **What a patient sees:** nothing wrong. The release build is one bundle, and the restore after a reload (refresh, then
  the home page, or the sign-in screen for a memory-only web session) completes as soon as the server answers.
- **Fix (tests only, checks unchanged):** both journeys get `test.setTimeout(90_000)`, as the same files already do for
  their other long journeys (45 s and 60 s).

## WQ51 Doctor › Bills and Doctor › Services and prices; "Price list" renamed (2026-11-26, branch `wq51/doctor-bills-names` on stage 06daf52)

**Option (b).** A doctor's session cannot read its own clinic's bills or prices: every partner workspace route needs
`req.user.userType === 'partner'` (`requireOperationalPartner` and `partnerPermissionGuard` in the backend's
`src1/modules/middleware/auth.ts`), and the only way into a partner workspace is the workspace choice after a sign-in
code (`POST /api/v1/auth/partner/select` with its one-use ticket). No existing endpoint switches a signed-in doctor, so
(a) is not possible and (c) is not needed.

- The doctor menu has **Bills** (`/doctor/bills`) and **Services and prices** (`/doctor/services`), specialists only.
  Both read the doctor's practice (the Clinics page's query, `practiceKey`) and show the clinic's name and state, one
  line saying where these pages are, and "Sign out and open my clinic’s workspace": it signs out with the notice code
  `toClinicWorkspace`, and the sign-in screen opens with "Lab or clinic staff" chosen and says to choose the clinic.
  Nothing is written to the URL or storage (the notice is a code in memory).
- **No clinic:** "You have no clinic of your own yet" with a link to Doctor › Clinics ("Create your clinic"); no button.
- **Unverified clinic:** its state badge and "Jansetu has not verified your clinic yet.", and the button is still
  offered (decision: the clinic workspace itself shows what an unverified clinic can do; hiding the way there helps no one).
- **Renamed:** the partner menu's "Price list" is "Tests and packages" for a lab and "Services and prices" for a clinic
  (`nav.labelKeyByKind` in `modules.tsx`, read by `navLabelKey`); the lab catalogue page title "Tests and prices" →
  "Tests and packages"; the admin's partner page button "Tests and packages". Words only in catalogues.
- Kept: the audit log's area name "Price list" (`audit.area.catalogue`), a record name for both kinds, not a menu item.

Named e2e changes: `partner-invoices.spec.ts` looks for "Tests and packages" (labs) and "Services and prices" (the clinic
journey) instead of "Price list", and the lab page heading "Tests and packages"; `doctor-tools.spec.ts`'s doctor menu
has 11 items (+ Bills, Services and prices) and 3 new journeys (no clinic, unverified, verified with the switch).

## WQ52 statement date fields: one shared period, read after a pause (2026-11-26, branch `wq52/date-fields` on stage 06daf52)

- **Doctor › Earnings** uses the finance statements' period fields and CSV (`useStatementPeriod`, `StatementPeriodFields`
  and their `CsvDownload` in `screens/finance/finance.tsx`) instead of its own form, "Show" button and download; its own
  period and CSV words are gone from `i18n/doctor`. The list follows the period as the other statements do.
- **A short pause** (`PERIOD_PAUSE_MS`, 400 ms) inside `useStatementPeriod`: typing a year digit by digit (0002, 0020,
  0202, 2026) reads the statement once, on every statement (finance, pharmacy finance and referral, doctor earnings). The
  date error also waits for the pause.

### WQ51b review fixes (2026-11-26, branch `wq51b/doctor-bills-fixes` on stage 06c2080)

- **Lands on the right page**: "Sign out and open my clinic's workspace" sets the address first (as Shell's sign-out does),
  so the clinic staff sign-in opens `#/partner/invoices` from Bills and `#/partner/catalogue` from Services and prices.
- **Home tiles** use `navLabelKey` like the menu (a clinic's tile says "Services and prices").
- **A doctor not verified and active** (`doctorStanding` of the profile) gets `CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE` and no
  button (the server closes the clinic workspace for them).
- **A suspended clinic** is said as such (`clinics.suspended`, one key on Bills, Services and prices and Clinics); "not
  verified yet" only while it is pending.
- `modules.tsx`: `pagesFor`'s comment is above `pagesFor` again; the WQ51 comment on its own line; a stray blank line gone.

## WQ53 user guides refreshed (2026-11-26, branch `wq53/guides` on stage 06c2080)

One short "where is what" guide per sign-in in `docs/guides`: pharmacy, lab (owner and staff), clinic (owner and staff,
incl. a doctor's own clinic), doctor, admin and the new customer guide. Each feature ends with a **Switch** line naming
the backend `.env` switch (`src1/modules/assisted/flags.ts`, `smsNotices/flags.ts`; on only when exactly `true`); the
admin guide lists them all. Labels from the catalogues; example names from the backend's `demo-accounts.example.json`.

- Word and PDF in `~/Desktop/SwasthaDisha/Jansetu-user-guides` (overwritten, plus `Jansetu-customer-guide`): the 20 Nov
  converter was lost with /tmp, so `docs/guides/md2html.py` now keeps it. Build: `python3 -I docs/guides/md2html.py
  docs/guides/<g>-guide.md <out>/Jansetu-<g>-guide.html`, then `soffice --headless --convert-to "docx:MS Word 2007 XML"`
  on the HTML and `soffice --headless --convert-to pdf` on the .docx.
- Written as WQ51b and WQ50b will make it: Doctor › Bills lands on the clinic's Bills after the clinic sign-in; the New
  sale bill is described generally.
- The clinic Home tile wording mismatch found here is fixed by WQ51b.

## WQ56 the doctor's single dashboard, P2 (2026-11-27, branch `wq56/doctor-dashboard` from web stage 85b3815, merged with 7b76939; backend r39 fe9c21f2)

SIMPLE_DESIGN_PLAN_2026-11-26 "Your answers (26 Nov, later)". Built on the shared `front/` desk (WQ54/55/57): `useFrontDesk()`
gains a doctor (`kind: 'doctor'`, `todayApi(c, 'doctor')` on `/specialists/me/today|todos`), so + New's patient step (This
person / Someone else), the one-shot visit handover, the pending strip, the money line, Today and the to-dos are the same
code; `BigActions` is now one component for every home.

- **Home** (`doctor/DoctorHome.tsx`): + New, Find patient, Today, and Bills only when he owns one verified clinic
  (`ownedClinic`); today's appointments from `GET /me/appointments/list` in time order, names from the day register, chips
  All · each clinic (his clinics, and any other on the list) · Online (`channel`) · Booked by partners (pharmacy or lab);
  what waits (prescriptions to write, appointments waiting, lab reports ready, unpaid bills); "Earned today" (`earnedMinor`);
  his clinic's money line only when it has bills or money that day; his status; his private to-dos (no "Added by").
  An unverified or inactive doctor sees his status and to-dos only (r39 reads need a verified, active doctor).
- **+ New** (`doctor/DoctorVisitScreens.tsx`): Clinic appointment (the clinic, skipped when there is one; a day; his free
  times at that clinic's branches from `/me/slots`; `POST /me/clinic-appointments`; it is that clinic's desk appointment);
  Online consultation (video or call, none chosen for him; his times with no branch; "The patient pays in the Jansetu app
  within 30 minutes", then the pay-by time from the answer); Lab test (the existing doctor Book lab test with the visit);
  Follow-up (from + New: his completed consultations of that number in the last 14 days, found by the day register's search
  for each day; from an Appointments row: "Book follow-up"). Each create keeps its request key until the server answers for
  sure (Send again resends it).
- **Billing his own clinic** with the `{ kind: 'doctor' }` workspace scope (`/specialists/me/clinic/catalogue|invoices`, the
  same bill screens; name and branches from `GET /me/clinic`; he is the bill's only doctor): a row of his clinic's desk
  appointment has Bill (WQ57's short bill with his fee line); after booking at his own clinic, "Make the bill" uses WQ57's
  `visitBillPrefill`. Doctor › Bills and › Services and prices show the bills and catalogue for an owner who can bill; the
  WQ51 sign-out way stays for everyone else.
- **Earnings**: "Where your earnings came from" (r39 `breakdown`): chips All · Online · each clinic · Booked by partners ·
  Referral cuts (· Other when any), for a period sent whole (empty dates: the 1st of this month to today), as r39b may make
  the breakdown on demand or default it.

Decided (owner away, reversible):
- The home list reads `/appointments/list` (sources, clinic, branch for the bill) and the Today register (names, money,
  waiting work); chips filter on the page (one read for the day).
- A family member's appointment billed from the home row leaves the bill's name empty (the bill is the account holder's,
  Q14); the phone is asked on the bill (the list has no phone).
- No booking of an in-person visit at his own place outside a clinic (r39: in person = a clinic appointment).
- Follow-up from + New searches 15 days of the day register by phone (no other read lists his consultations by patient).
- r39b (379b1a50): `breakdown=1` is sent (the breakdown comes only when asked); a part with no clinic (`clinicId: null`) is
  "In person, no clinic"; `channel` is by mode only (in person: clinic), which the Online chip follows.
- Doctor › Today is in the menu (the long way).
- The patient's desk request from + New is `visitDeskRequest` (`front/visitPatient.ts`); WQ57's desk keeps its own
  `patientOf`/`requestOf` (its form has more fields): one candidate to fold together later.

Named e2e changes: `doctor-tools.spec.ts`'s first journey counts 12 menu items (+ Today) and no longer looks for the "Next
appointments" list (the home's list is today's appointments, `doctor-dashboard.spec.ts`).

## WQ56b doctor dashboard review fixes (2026-11-27)

- Clinic billing follows the clinic verified by the billing API. A family visit's bill uses the account holder's name and
  phone. When a detail is missing, the form asks for it before issuing the bill. The appointment response shows the current
  linked bill even if it was made or paid on an earlier day. A cancelled bill permits a replacement.
  On backend stage `eb0548d6`, which omits the bill field, the web checks the doctor's scoped invoice list by appointment
  without a date filter. Bill creation waits for a valid invoice response, and a failed read offers Try again. A
  continuation cursor must match the server's timestamp-and-ID format before the web sends it.
- A booking whose answer was lost retains its request key and original details in session memory. The doctor can check
  Appointments and continue the same booking upon return. A full reload keeps only the request key. Check whether it was
  booked looks up that exact request, opens the matching appointment when found and releases the old request. An inconclusive
  answer keeps the request open.
  Backend stage `eb0548d6` does not yet expose the exact request check. The web directs the doctor to Appointments and
  retains the request key when the server cannot perform the check.
- The doctor chooses a clinic even if only one is offered. The Bills menu explains which workspace to use when the
  doctor owns several clinics, and a failed appointment or clinic read offers Try again.
- Follow-up uses the date the server granted. Doctor-created desk bookings identify who booked them. Rows and single
  pending tasks open the relevant record. The next appointment appears when today is empty, and the filter chips scroll.
- Online booking shows the fee. The earnings breakdown, statement and CSV start with the same India-date period
  (month to date) and use the same range after an edit.
- Verification for `66dc4bb` with clinic stage `a65c5a4` merged and the `eb0548d6` stage backend contract. Type check,
  548 unit tests and both same-origin builds passed. The focused doctor and reception run passed 10 cases. The full
  workspace run passed 621 desktop and 612 tablet cases, with nine planned skips. Independent source review approved
  the web candidate. Backend `39d9a74` is the local follow-up that supplies exact request confirmation after reload.

WQ57d clinic follow-up. A same-price catalogue entry for a follow-up cannot replace the consultation fee. The clinic's
visit receipt leaves billing actions to the visit flow while it waits for the booked appointment to appear.

### WQ56c a lost doctor booking settled by its key (2026-11-27, branch `wq56c/doctor-keyed-check` from web stage fd22d0e; backend r41)

r41 adds `GET /specialists/me/clinic-appointments/by-key/:key` and `…/me/consultations/by-key/:key` (an online consultation's
and a follow-up's), each with `POST …/abandon`, answering `{state:'used', booking} | {state:'abandoned'} | {state:'unknown'}`.
The placeholder `POST /me/visit-requests/check` (never on the server) is gone: `doctorDashboardApi().bookingByKey` and
`abandonBooking`, and `keyedBookingId` for the appointment it made.

- A booking whose answer was lost shows the shared check panel (`CheckPanel` + `useKeyedCheck`, as the withdrawal and the
  set-off): Send again (while its details are here), Check whether it was recorded, Give it up, and Check your
  appointments. After a reload (only the key is kept) it is checked or given up the same way, so it is never held for
  ever: found, it settles with "Open appointment"; given up, nothing was or can be booked with it and + New is free again.
- e2e: each kind (clinic, online, follow-up) lost, reloaded, checked (not known yet, kept), then found (settled, nothing
  about the patient stored); an online booking lost before the server, reloaded, checked, given up (`…/abandon`), and
  + New opens again.

## Follow-ups


- WQ15: the r9 `uncredited` row has no Razorpay order id (`uncreditedTopups` selects `razorpayPaymentId` but sends neither). For
  the backend: add `razorpayOrderId` to each row; the section shows it when present. The list is global (no `pharmacyId` query), so
  a pharmacy's rows can be cut off by the 200-row limit across all pharmacies.
- WQ11d: the desk rows (`deskView`) do not carry their slot's seats or end, so the desk knows an appointment is in a
  session with several seats only while that session is still listed with a free seat (the doctor's page reads its own
  slots and always knows). Otherwise the one-patient rule is offered and the server's 409 APPOINTMENT_NOT_STARTED is said
  in words. For the backend: the slot's `maxBookings` and `endTime` on the desk rows.
- WQ11d: Q16d is adopted from the q16-integration worktree while still uncommitted there; re-check its codes when it lands.
- WQ11b: the desk view carries no no-show history (Q14 and Q16a),
  so its second no-show confirmation uses conditional words. The partner lab list has no newest-first order on the server,
  so Past shows oldest first within the chosen dates.

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
| 2026-11-27 | WQ57d reconciled with stage fd22d0e | Stage's clinic billing fix (f115aa5) already keeps the hand-written fee unless an item names this doctor at the fee, and hides the receipt's "Create bill" sentence in a visit (`showBilling`): the WQ57d code edits were dropped; only a spec stays (a follow-up item and another doctor's item leave the fee hand-written). typecheck clean; Vitest 548/548; clinic-home and clinic-desk 71/71 + 3 skipped. |
| 2026-11-27 | WQ57c independent clinic billing review corrections (`f115aa5`) | Type check, 546 unit tests and both same-origin web builds passed. The full workspace run had 1218 passes, 9 skips and one records-access timeout. The timeout passed when rerun alone. The new catalogue test demonstrated the wrong doctor on the prior build. |
| 2026-11-27 | WQ57c merged with web stage 0f69bf2 (WQ56) | typecheck clean; Vitest 546/546; the full suite via pw-slot.sh 1219/1219 + 9 skipped (20.1 min) on a temporary config (port 5568, deleted). `feeLine` lives in `partner/clinic.tsx` (with `prefillOf`); the doctor screens import it from there. |
| 2026-11-27 | WQ57c clinic fixes (from 6bc8c1d) | typecheck clean; Vitest 539/539 (the whole-word match); clinic-desk alone on 1 worker 52/52; clinic-home 17/17 + 3 skipped (a server without the lookup, Bill this appointment); the full suite via pw-slot.sh 1204/1204 + 8 skipped (20.6 min) on a temporary config (port 5568). |
| 2026-11-27 | WQ57b clinic reception polish (r40, r40d lookup built to the lab's shape; from 7b76939) | typecheck clean; Vitest 538/538; the full suite via pw-slot.sh 1202/1202 + 8 skipped (26.2 min) on a temporary config (port 5568, deleted): clinic-home's walk-in with Dr Kavya in cash in 9 taps at one branch (390 px) and 10 with two (desktop, tablet), a shared session offered inside a busy time, the appointment's day on a Today row, Find patient by name among today's appointments, the Book button in sight on a 390 × 667 phone. |
| 2026-11-26 | WQ57 the simple clinic reception home (r40 21a4a92b, from 85b3815) | typecheck clean; Vitest 537/537; the full suite via pw-slot.sh 1197 passed, 2 failed (WQ51b's clinic Home tiles, replaced by the reception home), 7 skipped (22.9 min) on a temporary config (port 5568, deleted); after updating that test (and a type fix in the new spec) doctor-tools and clinic-home 80/80 + 2 skipped. clinic-home: walk-in with Dr Kavya in cash in 9 taps (desktop, tablet, 390 px), one Today row, a later time avoiding a busy block, a family member, a branch-limited member, a member without billing. Screenshots in /tmp/wq57-shots. |
| 2026-11-26 | WQ55c lab desk polish (r38c 9b512b92, from c59c07a) | typecheck clean; Vitest 535/535; lab-home, lab-desk, partner-invoices, pharmacy-home 123/123 + 5 skipped; the full suite via pw-slot.sh 1187/1187 + 5 skipped (14.3 min) on a temporary config (port 5567, deleted). A first full run on an overloaded machine (5.1 h) timed out 48 unrelated tablet tests; the rerun passed. Walk-in CBC in cash: 12 taps at one branch; 13 the first time at two, then 12. |
| 2026-11-26 | WQ55b the lab desk, shorter and truthful (r38b f86bf769, from 531c3a3) | typecheck clean; Vitest 535/535; the full suite via pw-slot.sh 1185/1185 + 5 skipped (14.1 min) on a temporary config (port 5567, deleted): lab-home's walk-in CBC in cash counted at 12 taps for a one-branch clerk (390 px) and 13 with two branches, the booked CBC on the bill, one Today row, truthful desk rows, doctor bookings waiting, plain lines, no Try again on a refusal, no home collection where no branch does it; the refund method chosen; the code link at the desk. Screenshots in /tmp/wq55b-shots. |
| 2026-11-26 | WQ55 the simple lab front-desk home (r38 85c10c6e, from 47289d6) | typecheck clean; Vitest 535/535; the full suite via pw-slot.sh 1185/1185 + 5 skipped (15.7 min) on a temporary config (port 5567, deleted), with lab-home (walk-in CBC paid in cash in Today with totals, home collection, family member, branch-limited member, member without billing; desktop, tablet, 390 px) and the bill payment specs choosing a method; then the r38b slots: lab-home and pharmacy-home again 27/27 + 5 skipped. Screenshots in /tmp/wq55-shots. |
| 2026-11-26 | WQ54e one lab-test statement (r37d a6ac7f3f, from 571f5c5) | typecheck clean; Vitest 534/534; Playwright lab-booking, doctor-lab, pharmacy-home 87/87 + 3 skipped (the exact statement behind Read more on both Book lab test pages; `statementVersion: 'web-lab-test-v1'` in both bodies) on a temporary config (port 5566, deleted). |
| 2026-11-26 | WQ54d before the older-user test (from 95b0f32) | typecheck clean; Vitest 534/534; Playwright pharmacy-home, lab-desk, lab-consult, doctor-lab, lab-booking, consult-now, assisted-booking, card-booking, pharmacy-sale, pharmacy-extras, i18n: 351/351 + 3 skipped on a temporary config (port 5566, deleted). |
| 2026-11-26 | WQ54c who the patient is, asked once on + New (from 7e2bb7a) | typecheck clean; Vitest 534/534; the full suite via pw-slot.sh 1173/1173 + 3 skipped (the 390 px journeys run once) (13.9 min) on a temporary config (port 5566, deleted): who journeys (someone else on a phone, a mother’s child, the owner) on desktop, tablet and 390 px; Find patient by name, every Find asking again, today’s visits; lab specs open Read more for the full consent; 390 px screenshots in /tmp/wq54c-shots. |
| 2026-11-26 | WQ54b the simpler pharmacy home (r37c 7f4ff46b, from 662e9f1) | typecheck clean; Vitest 534/534; the full suite via pw-slot.sh 1171/1171 + 3 skipped (the 390 px journeys run once) (13.5 min) on a temporary config (port 5566, deleted), with the tablet project now a Galaxy Tab S4 held sideways; after a last patient-step fix (visit mode off after a reset or a changed number) pharmacy-home, consult-now, assisted-booking, lab-booking, lab-desk, card-booking, pharmacy-sale and orders again 253/253 + 3 skipped; 390 px screenshots of the home, + New and Today. |
| 2026-11-26 | WQ54 r37b final (6de072f2, on 8d4b33f) | typecheck clean; Vitest 533/533; Playwright pharmacy-home 9/9 + 1 skipped (card payments waiting with r37b's items; TODO_LIMIT said with the text kept) on a temporary config (port 5566, deleted). |
| 2026-11-26 | WQ54 r37 review items (on ac804db) | typecheck clean; Vitest 533/533; Playwright pharmacy-home 9/9 + 1 skipped (the what-waits journey adds a row paid today and made earlier, a queue that could not load, card payments waiting), orders (the cash-on-delivery journey sends `paymentSource: 'upi'` from the picker), pharmacy-sale: 73/73 on a temporary config (port 5566); the full suite via pw-slot.sh 1167/1167 + 1 skipped (14.8 min). |
| 2026-11-26 | WQ54 to r37 final shapes (950417ab, on ebca0fb) | typecheck clean; Vitest 533/533 (pharmacyToday.test.ts: the paged today read and its checks, the to-do routes, `todayLink`, `pendingCount`); Playwright pharmacy-home 9/9 + 1 skipped (+1 journey x 2: an unpaid counter sale one tap from its page, each row opening its record) + session; the full suite via pw-slot.sh 1167/1167 + 1 skipped (15.6 min). |
| 2026-11-26 | WQ54 simple pharmacy home P1 (on stage 9b80676) | Against r37's draft shapes (mocked). typecheck clean; Vitest 532/532 (+3 in pharmacyToday.test.ts: routes and bodies with checks before sending, the money line's parts, an answer of another shape shown empty); Playwright pharmacy-home 7/7 + 1 skipped (example 1 on desktop, tablet and a phone (More menu, 48 px buttons): a new patient, a video consult from the wallet, medicines in cash, Today with both and the money split, a to-do added and ticked; no internet with Try again keeping the to-do's text and key; Find patient by a POST search) + consult-now, assisted-booking, lab-booking, pharmacy-sale, orders, session, i18n on a temporary config (port 5566); the full suite via pw-slot.sh 1165/1165 + 1 skipped (14.6 min). |
| 2026-11-26 | WQ50c r36b rx flag (on stage c512942) | typecheck clean; Vitest 529/529 (+1: `isRxMedicine` reads `rx` only; the keyed sale body is always in-store with a customer); Playwright pharmacy-sale 14/14 (the mock's stock rows carry `rx`) on a temporary config (port 5564, deleted). |
| 2026-11-26 | WQ50b part 2 (r36 135b5639 shapes, on ff743be) | typecheck clean; Vitest 528/528 (pharmacySale.test.ts: the POST search, the keyed create, by-key and abandon routes, a bad key refused before sending); Playwright pharmacy-sale 14/14 (7 journeys x 2: walk-in cash sale with the r36 bill; Rx marked before the sale; refusals incl. INDEXES_OUTDATED; a resend under the same key answers the first sale; checked by key then given up; a replay of a sale cancelled meanwhile prints no bill; a resend refused as another body reads the key) + orders, stock, stock-supply, prescription-review, pharmacy-extras 254/254 on a temporary config (port 5564); the full suite via pw-slot.sh runs on this commit (result in the report). |
| 2026-11-26 | WQ50b part 1 (on stage 06c2080) | typecheck clean; Vitest 529/529 (pharmacySale.test.ts: the body built before sending, rows without a holder left out, a lost sale never matched to an order that existed before or is closed); Playwright pharmacy-sale 10/10 (5 journeys x 2: walk-in cash sale with the GST-inclusive bill, its own page after a reload; Rx sale with Create waiting for the upload and back from the review; refusals incl. the 503 prescription gate; a lost answer ignoring earlier and cancelled sales; Forget only after a late second check) + orders, stock, stock-supply, prescription-review, pharmacy-extras 254/254 on a temporary config (port 5564); the full suite via pw-slot.sh 1146/1146 (15.9 min). |
| 2026-11-26 | WQ50 Pharmacy › New sale (on stage ebcbfd7) | Against backend 43f46f57 (mocked API). typecheck clean; Vitest 529/529 (+3 in pharmacySale.test.ts: the routes and bodies with no price and no request key, the walk-in checks, the lost-sale match); Playwright pharmacy-sale 8/8 (4 journeys x desktop and tablet: a walk-in cash sale with its bill printed; a known customer with a prescription medicine and its file, not payable before the pharmacist; refusals checked before asking and the server's stock refusal; a lost answer found by Check, never resent) + orders, stock, prescription-review, pharmacy-extras 172/172 on a temporary config (port 5564, deleted); the full suite via pw-slot.sh runs on this commit (result in the report). |
| 2026-11-25 | WQ48b part 2 (r35b 43f46f57 shapes, on c6a373a) | typecheck clean; Vitest 526/526; Playwright finance-4f + withdrawals 60/60 (+1 journey x 2: nothing due, no set-off offered; at most the smaller of owed and due; the older top-up marked recovered; a lab set-off entry's amount from its change of what is owed; no switch probe), finance + referral-cuts + lab-wallet + doctor-wallet + pharmacy-extras 156/156 on a temporary config (port 5563); the full suite via pw-slot.sh runs on this commit (result in the report). |
| 2026-11-25 | WQ48b part 1 (on stage 984cc7f) and the full suite on WQ48 4ee5c9b | WQ48 4ee5c9b: full workspace suite 1120/1120 via pw-slot.sh (22.3 min, port 5562, temporary config deleted). WQ48b: typecheck clean; Vitest 526/526 (walletFinance.test.ts: a cleared owed amount is a debit, a lab set-off entry's amount from its receivable change or none); Playwright finance-4f + withdrawals 58/58 (+4 journeys x 2: against r35 nothing missing or NaN and no details form on a referral account; payouts on, the referral payout check names the home details; an unknown quote reason and a lab not verified; a resend refused for a changed fee, then checked by key and given up), and finance + referral-cuts + lab-wallet + doctor-wallet + pharmacy-extras + assisted-booking 196/196 on a temporary config (port 5563, deleted). |
| 2026-11-25 | WQ48 the 4f finance screens (on 5ade2d5 + origin/stage 53e523e) | Against r35 bbd6a64b (§26.10, §26.18.3) and the r35b shapes (mocked API). typecheck clean; Vitest 525/525 (+5 in walletFinance.test.ts: the pharmacy finance and statement routes with cursor and period, `expectedTransferMinor` and the changed quote read from the refusal, `disputeAcknowledged` only when asked, the disputes, top-ups without a lot and set-off routes with their checks, the referral owner kinds and the set-off row's words); Playwright finance-4f (new) + withdrawals + referral-cuts + finance + lab-wallet + doctor-wallet + pharmacy-extras 206/206 on desktop and tablet (finance-4f 18 = 9 journeys x 2; withdrawals 32 (+6: the dispute acknowledged after the refusal, never offered without it, the quote reason, payout details refused while a withdrawal waits; the fee-changed and payout-details journeys rewritten for r35 and the Finance page); referral-cuts' two pharmacy journeys moved to Finance) on a temporary config (port 5561, deleted). The full workspace suite via pw-slot.sh is still to run. |
| 2026-11-25 | WQ45 rounds 6e, 6f, 6i (pharmacy and doctor screens) on wq45a 3233a59 + the WQ24b re-check fixes | typecheck clean; Vitest 506/507 (the literal scan and the catalogue check pass with the 49 files off the allowlist; the one failure, `components/NoShowMove.test.tsx` WQ11b, is a 5 s timeout under load that fails the same way on origin/stage and passed in the wq45a run); Playwright workspace on a temporary config, port 5566 (5556 was held by another agent; `reuseExistingServer: false`, deleted): 1011/1052 with the machine at load 64, then the 41 failures (all 30 s timeouts: page.reload, "Signing you in…") 41/41 with `--last-failed --workers=2`; no assertion changed; `VITE_API_SAME_ORIGIN=true npm run build --workspace apps/workspace` built. |
| 2026-11-25 | WQ29c leftovers (on add6328) | typecheck clean; Vitest 513/513; Playwright withdrawals 26/26 (the admin journey now checks the three notices by short ref; the mock's ids end in their number) on a temporary config (port 5559, deleted). |
| 2026-11-25 | WQ29b review fixes (09c8e4f) + origin/stage c3b68d2 merged | Against r32b 8b1f6c35 (§26.17.7; mocked API). typecheck clean; Vitest 513/513 after the merge (`chargebackLot` now one function, the lab wallet test on it); Playwright withdrawals + lab-wallet + doctor-wallet + pharmacy-extras 128/128 (withdrawals +6 = 3 journeys x 2: a pharmacy's dispute says and does the take (flag-only switch off), Mark paid refused on disputed money, a fee recorded unlike the quote and a replayed request no longer waiting; the Recover journey now runs with the flag-only switch on) under `pw-slot.sh` with 2 workers on a temporary config (port 5559, deleted). |
| 2026-11-25 | WQ28b review fixes (b199189) + origin/stage 3233a59 merged | typecheck clean; Vitest 510/510 after the merge; Playwright workspace records-access + doctor-tools 64/64 (+2 = 1 journey x 2: a refused first ask keeps its words, then an "already allowed" answer is said so; journey 1 now checks the date is the treating end, not the grant's) on a temporary config (port 5557); customer 280/280 (+2 = 1 journey x 2: a 503 switch-off says its own words and the request still waits) under `pw-slot.sh` with 2 workers (port 5558); configs deleted. |
| 2026-11-25 | WQ28 records access, both apps (phase 3f web, on f321df4) | Against r30 233ef1ab (§25.17; mocked API). typecheck clean; Vitest 487/487 (+3 in recordsAccess.test.ts: the treating view reads the booking then the history with bookingId and keeps no contacts or health details; the request and holder routes with ids checked first; where a request stands, incl. an approved one whose grant ended; the catalogue check and the literal scan pass with no file allowlisted). An earlier full run had 2 five-second timeouts in untouched component tests at load ~70 (the same test timed out on the WQ27 base then); clean at load ~24. Playwright workspace 1016/1016 (+8 = 4 journeys x 2: ask, allowed, the other records listed and opened through the file route with the history read three times only; denied and the no-app words; ended and a lost answer to asking checked by reading again; another doctor's consultation and a closed window show nothing) and customer 278/278 (+8 = 4 journeys x 2: Allow on Home then the page's who-can-see and history; a family member's request denied; an ended request said and moved to the past; Stop sharing, and no card when nothing waits), both under `pw-slot.sh` with 2 workers on temporary configs (ports 5557 and 5558, `reuseExistingServer: false`, deleted); both builds with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ29 wallet withdrawals and Recover (phase 4d web, on stage 3233a59) | Against r32 23c28687 (§26.16.4; mocked API). typecheck clean; Vitest 511/511 (+4 in walletWithdrawals.test.ts: the three owners' routes from one base each, amounts, keys, ids, versions and cursors refused before any request, the admin queue bodies (reject and void fenced by the version, paid with the trimmed bank reference, its key and the destination version, no empty note), Recover by lot and by payment, the shared chargeback, the pharmacy's lots and payout-details PUT, and the rules: minimum, available, weekly wait, the reference, a refusal's safe details); the catalogue check and the literal scan pass with nothing allowlisted. Playwright workspace 1069 passed of 1070 (+20 = 10 journeys x 2: the quote's fee line, ask, list and cancel; below the minimum and above what is withdrawable said before asking; the weekly limit from the server; switched off; a lost answer checked by key after a reload; the pharmacy's payout details added here; the doctor's section; admin mark paid, reject and void; a lost "mark paid" checked by reading; the dispute flag then Recover on a pharmacy top-up) under `pw-slot.sh` with 2 workers on a temporary config (port 5559, deleted). The one failure is the known load-timing check stock-supply.spec.ts:1277 (tablet; as in WQ17c, WQ18b and WQ27): right after the 16:10 hold it failed 2 of 3, then passed 3/3 on this tree and 3/3 on the WQ28 tree without these changes. Release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ27 doctor pays a lab test by card or UPI (phase 3c web, on 292b22d) + WQ25 review items | Against r29 88e152ed (§25.16.4; mocked API). typecheck clean; Vitest 484/484 (doctorLab.test.ts: the card create is the same body with razorpay; a doctor's 403 at verify or reconcile has its own words while the pharmacy's 403 keeps CARD_BLOCKED_WORDS; the card switch is the shared card words); Playwright workspace 1007 passed of 1008 (+16 = 8 journeys x 2: pay by card from a consultation, Checkout closed then Pay now after asking the server, another device's authorized payment gives no second Checkout, cancel to the card, cancel to the wallet (not withdrawable, said before and after), card switched off falls back to the wallet, a lost cancel found as forfeited from the view's payment, the doctor lab switch off from a consultation shown at once; WQ25 journeys updated for r29: the card offered with the wallet as default, "Waiting for payment" in the filter, the doctor's collect words, no family-list loading text). The one failure is the known load-timing check in stock-supply.spec.ts:1277 (as in WQ17c and WQ18b), 6/6 alone. Temporary config on port 5514, `reuseExistingServer: false`, deleted; release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ25 doctor books a lab test (phase 3b web, on 13333e9) | Against r26 + r26b on stage 6a8574e9 (§25.15; mocked API). typecheck clean; Vitest 483/483 (+5 in doctorLab.test.ts: the reads, list, by-key, abandon, cancel and accept under /specialists/me/assisted with the pharmacy's paths unchanged; the lookup and the recommended-tests code with the phone in the body only; a create from a consultation with no phone and a walk-in by phone; a bad consultation id, two sources, no name, the card and a bad key refused before any request; the doctor's words (unverified, consultation not found, window closed, wallet only) with the lab and pharmacy words unchanged and the code field hidden for an unverified doctor; the appointment read keeps the booking only and `labBookableFrom`); Playwright workspace 992/992 (+20 = 10 journeys x 2: book from a consultation, a walk-in with the nav order, the treating window closed, low balance then Add money on Wallet, a lost answer found by key after a reload, cancel with the refund to the doctor wallet, accept a new time, open a released report, an unverified doctor on both pages, another doctor's booking not found; doctor-tools' nav count now 9) on a temporary config (port 5512, `reuseExistingServer: false`, deleted). A targeted run of the shared-piece specs earlier had 1 load-timing failure in pharmacy-extras.spec.ts:825 (admin wallet, untouched), 6/6 alone and green in the full run. Release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ24b card refunds name their payer; WQ24 review must-fix (gated on data) and follow-ups, on 33439af | Against r21 (mocked API). typecheck clean; Vitest 491/491 (+4 in `wq24b.test.ts`: `payerWord`, `payerNameOf`, the payer's cause and agreement words with the pharmacy's unchanged, the reschedule refusal in the lab's words; `wq24.test.ts`: a missing permission on the lab's payment routes said as such); Playwright on temporary port 5512 (`reuseExistingServer: false`, config deleted): lab-consult, lab-desk, assisted-booking, card-booking, lab-wallet, admin* and partner-workspace 376/376, and partner-labs, lab-booking, consult-now and pharmacy-extras 184/184; +12 = 6 journeys x 2 (the two failed-refetch journeys fail on 33439af: the held card booking and the booking page's payment panel were unmounted); `VITE_API_SAME_ORIGIN=true npm run build --workspace apps/workspace` built. |
| 2026-11-25 | WQ24 lab › Book consultation (phase 2e) on 13333e9 | Against r21 + r21b, stage 6a8574e9 (§24.16–§24.17; mocked API). typecheck clean; Vitest 487/487 (+9 in `wq24.test.ts`: every lab route and its query/body, `branchId` refused before sending, the pharmacy routes and bodies unchanged, the lab consent, join and refusal words, card verify/reconcile/pre-checkout on the lab's payment routes with the lab named in the blocked and not-found words (pharmacy words unchanged), `assisted.book` offered to labs only); Playwright workspace 990/992 on temporary port 5511 (`reuseExistingServer: false`, config deleted), +20 = 10 journeys x 2 in `lab-consult.spec.ts` (wallet, card with the balance hidden without `wallet.view`, a lost answer checked by key, a lost answer given up after a reload, a changed price, cancels to the wallet and to the card or the wallet, the dispensing copy, another branch's and another lab's booking not found, no menu without `assisted.book`, switch off); the 2 failures (partner-invoices:1119 desktop, stock-supply:1277 tablet, both outside this round) were 30 s load timeouts while other agents ran their suites, and pass alone (4/4), as in an earlier desktop run (496/496); every pharmacy spec passes unchanged; `VITE_API_SAME_ORIGIN=true npm run build --workspace apps/workspace` built. 1 new file allowlisted (170). |


| 2026-11-25 | WQ23b review follow-ups (on 0b14df3) | typecheck clean; Vitest 443/443 (doctorWallet.test.ts and labWallet.test.ts on `adminOwnerWalletApi(c, kind)` and `ownerWalletRefusal(err, kind)`; wq15.test.ts: the close words and the missing-reason words name the owner); Playwright doctor-wallet + lab-wallet + pharmacy-extras + admin + admin-doctors 130/130 (doctor-wallet +4 = 2 journeys x 2: a failed wallet read after a top-up keeps Add money, its answer and the history; a doctor whose wallet closed after a reload still checks this device's top-up and is told it was added; extended: the admin's balance shows a doctor's card money) on a temporary config (port 5496, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ23 doctor wallet (on 7c76251, then WQ22c merged) | Against r20 d3f89855 (§25.12; mocked API). typecheck clean; Vitest 443/443 (+3 in doctorWallet.test.ts: the doctor's own routes and the existing /payments/verify, the admin routes under /admin/doctors with bad ids refused before any request, the words: wallet closed for an unverified doctor, switched off per owner, doctor not found, uncredited doctor rows by specialistId, the warning names the doctor); Playwright workspace 952/954 then doctor-tools + doctor-wallet 62/62 (+8 = 4 journeys x 2: a doctor adds money and sees it in the history, a lost order answer then "Top up" asks again with the same key and amount, an unverified doctor sees only the plain words and a switched-off server says so, the admin adds money after a lost answer (the check finds it by key) and holds and releases the wallet; the 2 failures were the doctor nav count, now 7 with Wallet) on a temporary config (port 5496, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ22c review follow-ups (L1–L4 on 7c76251) | typecheck clean; Vitest 440/440 (assistedInstant.test.ts extended: a 404 with no code is "not switched on", a coded 404 keeps its words, an unreadable QUOTE_CHANGED names no price); Playwright consult-now + assisted-booking + lab-desk 74/74 (consult-now +2 = 1 journey x 2: a server without the routes says not switched on; extended: no activity for three minutes after the offer ran out, activity again after asking again (failing before the fix), the refund words name the amount the server refunded) on a temporary config (port 5497, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ22b waiting requests listed (on da0015d) | typecheck clean; Vitest 440/440; Playwright consult-now 16/16 (+2 = 1 journey x 2: after a reload the waiting request is listed, opens the waiting view and is cancelled and refunded there; nothing about the patient kept in the browser; the list is gone after "Start another") on a temporary config (port 5495, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ22 pharmacy Consult now (on 97b2449 + origin/stage f089b46, then WQ20b and WQ20c) | Against r17 02b4a0e0 (§25.12; mocked API). typecheck clean; Vitest 440/440 (+4 in assistedInstant.test.ts: the routes with the phone only in a body and the speciality trimmed, chat and bad ids/keys/versions refused before any request, where a request stands (waiting, offer ran out, accepted, refunded), the changed quote with the payable the server names, no doctor online, the switch, the wallet words); Playwright workspace 940/940 before WQ20c (+14 = 7 journeys x 2: request and accept with activity and the Join call, a changed quote paid again as a new request, no doctor online, cancel and refund on the version shown, ask any available doctor after the offer ran out, a lost answer checked by key, switched off), then lab-wallet + partner-workspace + consult-now 140/140 after merging WQ20c, on a temporary config (port 5492, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ20c the permission editor waits for the partner's kind (on eebb19f) | typecheck clean; Vitest 432/432; Playwright lab-wallet 14/14 (+2 = 1 journey x 2: while the lab cannot be read, Save is off and nothing is listed; once read, the member's wallet access is kept on save; failing before the fix), partner-workspace + clinic-desk 164/164, on a temporary config (port 5494, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ21b recommended-tests code at the lab front desk (after merging wq19/lab-desk 12f0321) | Mocked API (r16b desk route). typecheck clean; Vitest 437/437 (+1 in wq21.test.ts: the desk and admin-mirror POST paths with the code and number in the body, the 403 codes hiding the field); Playwright lab-desk, lab-booking and clinic-desk 110/110 (+4 = 2 journeys x 2: the desk loads a code and ticks its own tests, says the unmatched name, sends nothing new and stores nothing; an unknown code said plainly). Temporary config on port 5474, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-25 | WQ21 recommended-tests code (phase 3d web) + L1/L2 on f089b46 | Against r16 8e5337f4 with the r16b POST lookup (mocked; §25.12.4). typecheck clean; Vitest 429/429 (+7: wq21.test.ts 4 (cleaning and printing the code, the POST body with no code or number in the URL and no malformed code sent, exact-name ticks, refusal words and the switch-off rule), wq21b.test.ts 3 (`routeCardAnswer` for both kinds, the held-without-order case, `isCardAnswer`)); Playwright workspace 902/902 (+6 = 3 journeys x 2: load and pre-tick with the unmatched name said and nothing new on create and nothing stored or in a URL; typo, not found and switch off; the booked consultation's code; the lab card journey now opens from the list's Pay now link (L2)). Temporary config on port 5473, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-25 | WQ17c lab tests by card or UPI (phase 2b) on 24019c4 | Against r14 77594d72 (§24.14; mocked API). typecheck clean; Vitest 422/422 (+4 in wq17c.test.ts: card state by kind, the lab view's order without an amount, cancel words by who is told and the waiting lab cancel, `refundTo` and `status=pending_payment`; the lab card switch-off words now the consultation's); Playwright workspace 895 passed of 896 (+10 = 5 journeys x 2: lab card pay, Checkout closed then Pay now after asking the server, another device with an authorized payment gets no second Checkout, cancel to the card, cancel to the wallet; the consultation card and wallet specs pass unchanged on the shared pieces). The one failure is the known load-timing check in stock-supply.spec.ts:1277 (as in WQ18b): 6/6 on its own afterwards. Temporary config on port 5472, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-25 | WQ20b review follow-ups (L1–L4 on 97b2449) | typecheck clean; Vitest 432/432 (labWallet.test.ts extended: wallet permissions for labs only, a clinic owner never offered them; partners.test.ts: a lab owner grants everything); Playwright lab-wallet + pharmacy-extras + admin + partner-workspace + assisted-booking + card-booking 306/306 (+2 = 1 journey x 2: a lost order answer, then "Top up" asks again with the same key and amount (one order), and a verify that says paid but not credited is settled by the server's check) on a temporary config (port 5493, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ20 lab wallet (on WQ19b 12f0321) | Against r13 215556e2 (§24.13; mocked API). typecheck clean; Vitest 432/432 (+7: labWallet.test.ts 6 (member and admin paths, the keyed order read into the pharmacy shape, refusals before any request, the Idempotency-Key and the exact by-key read, freeze and lot chargeback bodies, paise into balance/hold/owing and signed history rows, the wallet limit from its details, the switch, checkable states, a lab's uncredited rows, the wallet permissions, the owner in the warning) and topup.test.ts +1 (the ₹50,000 lab cap)); Playwright workspace 914/914 (+10 = 5 journeys x 2: top-up by Razorpay, a lost answer found under Top-ups and checked once, the wallet limit and the switch, wallet.view without Add money and a clinic with no wallet page, the admin credit resent after a lost answer with the same key and added once plus the hold and its release) on a temporary config (port 5491, no server reuse, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ19b review fix (M1, L1, L2 on e981104) | typecheck clean (a true/false `isCancelled` no longer compiles); Vitest 425/425; Playwright lab-desk 18/18 (+2 = 1 journey x 2: a desk cancel lost before the server, checked while the booking is still confirmed, says "Not cancelled so far" and is then resent once; failing before the fix), clinic-desk + partner-invoices + lab-booking + assisted-booking + card-booking 242/242 on a temporary config (port 5481, deleted); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ19 after merging WQ17b + WQ18 (24019c4): the desk on `useAssistedCreate` | typecheck clean; Vitest 425/425; Playwright workspace 902 run (temporary config, port 5481): 901 passed, 1 failed = pharmacy-extras.spec.ts:952 (tablet), whose check that storage holds no "250" matched the stored timestamp 1795552507312 (unrelated; 6/6 alone); lab-desk + lab-booking 38/38; release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ17b review fixes (M1, D1, D2, L1–L4 on 3c1960e) | Against r11 f5f171c9 (mocked API). typecheck clean; Vitest 406/406 (no change: D1/D2 are moves covered by the journeys); Playwright workspace 868/868 (+6 = 3 journeys x 2: L1 a lost accept not claimed after a cancel, L2 a refused accept said and read again, L3 a found cancel says what was done with the money; the reload journey now checks no price is shown (M1) and the list journey the Visited filter (L4); all five failed on 3c1960e; the consultation specs pass unchanged on the shared create hook). Temporary config on port 5471, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-25 | WQ19 lab front desk (on 0aca6c3 + WQ17 3c1960e) | Against r12 e304dabe (§24.12; mocked API). typecheck clean; Vitest 413/413 (+7 in labDesk.test.ts: member and admin paths with the phone only in bodies, refusals before any request, desk tests and total, switch/price/slot words, desk cancel and bill rules, steps on desk rows and walk-ins, the list `source` and the bill `labBookingId`); Playwright workspace 878 run on a temporary config (port 5481, no server reuse): 874 passed, 4 failed = 2 clinic-desk journeys x 2 that asserted a lab has no "Front desk" link (labs now have their own); updated to check that the link is the lab desk, then those and lab-desk.spec.ts 18/18 (+16 = 8 journeys x 2: walk-in, lab visit with a changed price, home collection with a collector, by-key after a reload, Make bill, desk cancel, switched off, branch scope); release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ17 pharmacy lab-test booking (phase 2a) on 0aca6c3 | Against r11 f5f171c9 (§24.11; mocked API). typecheck clean; Vitest 406/406 (+5 in assistedLab.test.ts: lab, catalogue and slot paths and queries, ids and keys checked before sending, the cursor list, by-key, abandon, cancel with `expectedVersion`, accept with the proposal version, the 1-hour cancel rule, the tests' total, branches by visit, status and refusal words); Playwright workspace 862/862 (+16 = 8 journeys x 2: book with the shared patient step and pay from the wallet (no note offered), home collection with its address, a lost answer and a reload then Check by key, price changed then not enough money, list and cancel with the version, accept a new time, open a released report and no cancel within the hour, another pharmacy's booking not found and the switch off); the consultation specs pass unchanged on the shared components. A first full run had 6 timeouts in doctor-tools and admin-pharmacies (load); both specs then passed 88/88 and a second full run passed 862/862. Temporary config on port 5403, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-25 | WQ18b no duplicated code and review follow-ups (O1–O3, L2–L4 on 62e94b3) | Mocked API as WQ18. typecheck clean; Vitest 413/413 (wq18.test.ts updated: no open-consultations read, the close reason checked with the admin-cancel rule, refund targets incl. the card being refunded); Playwright workspace 864 run (+4 = 2 journeys x 2: a resend refused for a fence mismatch is settled and shown, no Verify without a name; a card-paid pharmacy booking's close says the refund is on its way to the card; the close journeys moved to ConfirmAction and the doctor page's links to Consultations): 863 passed, 1 timing failure in the untouched pharmacy stock-import spec (stock-supply.spec.ts:1277, tablet, under a 14-minute loaded run), passing 6/6 on its own; temporary config on port 5462, deleted; release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-25 | WQ18 admin doctors: verify with the S5 fence, unverify; close and refund (on 0aca6c3) | Against stage q16-integration f81c8f3b (routes unchanged at f5f171c9; mocked API). typecheck clean; Vitest 413/413 (+12 in wq18.test.ts: list/get/open-consultation paths and filters, verify body with the trimmed fence and unverify without one, fence holds/mismatch, eligibility, close body/key/version checks before any request, a 200 without this key's close is a 502, when close is offered, final vs before-writing answers, refund words, close by key); Playwright workspace 860/860 (+14 = 7 journeys x 2: list filters and verify OK, fence mismatch shows reviewed vs saved and verifies on the new values, lost verify checked by reading the doctor and unverify, close and refund with reason/key/version and nothing in storage or the address, lost close found by key and a resend replayed once, BOOKING_CHANGED and ALREADY_CANCELLED refusals and no close for a verified doctor, a pharmacy cannot reach the pages) on a temporary config (port 5461, no server reuse), admin specs 84/84 rerun on the final code; release build with VITE_API_SAME_ORIGIN=true. |
| 2026-11-23 | WQ16d card-last (items 1–7 on 244bbf7) | Against r10e d1ed6d24 (mocked API). typecheck clean; Vitest 401/401 (+3 in wq16dLast.test.ts, all failing before: the server asked before Checkout (authorized not opened, created opened), the 60-second minimum, marked-failed in any state; the wq16c timeout case moved to 60); Playwright workspace 846/846 (+10 = 5 journeys x 2: authorized never opens Checkout, created opens it (a guard, passed before), the "pay it from there" line hidden while confirming, the duplicate sentence kept when its re-read fails, a restored cancellation says "goes back the way chosen"; the four others failed before; temporary config on port 5401, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-23 | WQ16d alignment with r10e d1ed6d24 (refund read by id, DUPLICATE_PAYMENT_REFUNDED, extra_capture) | typecheck clean; Vitest 398/398 (+3 in wq16d.test.ts, all failing before; 4 older assertions moved to the r10e envelope and the no-recheck rule); Playwright affected specs (card-booking, assisted-booking, pharmacy-extras) 162/162 (+4 = 2 journeys x 2, both failing before: a duplicate payment refunded and the booking shown paid after a re-read; the extra-capture label and the not-available check without recheck); temporary config on port 5399, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-23 | WQ16c review fixes 1–8 (review of 398accb) | Against r10d a7ae19bb (mocked API; the refund read by id as assumed). typecheck clean; Vitest 395/395 (+8 in wq16c.test.ts, all 8 failed before: paid only for captured/refunded/forfeited, the 2-minute Pay-now cut-off and Checkout timeout, the r10d order from `payment`, `inFlight` after a reported payment and for authorized/created gateway payments, the read by id with the recheck fallback and no list, the unpaid-cancel and recheck/404 words; 5 older assertions updated to the new behaviour); Playwright workspace 831/832 then the failed one 10/10 on rerun (+14 = 7 journeys x 2, all failing before, plus the two admin Check journeys changed to the read by id, failing before: not-paid label and payment timeout, any-device Pay now with a re-read and Checkout timeout, no Pay now near payBy, no second payment after a reported one, the 502 order after a reload, the unpaid-cancel words, recheck 502 and Forget clearing the form). The one failure is an existing time-dependent check in pharmacy-extras WQ14b M1 (`not.toContain('250')` matched the marker's millisecond timestamp), not this change. Temporary configs on ports 5395/5397, `reuseExistingServer: false`, deleted; `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-23 | WQ16b booker view payment, admin recheck and mark failed, new refusals (on 75e6c45) | Against r10b/r10c 6b223644 (§23.3, §23.6; mocked API). typecheck clean; Vitest 387/387 (+8 in wq16b.test.ts: paid-by and waiting from `payment`, the server's payBy and the older-server fallback, pending_card_bookings words, PAYMENT_DISPUTED, bad signature falls back to reconcile (pin; passed before), REFUND_AT_GATEWAY / GATEWAY_LOOKUP_FAILED for the move, recheck request and words, mark-failed request, its 502 on an odd answer, final and before-writing refusals and the check; 7 of 8 failed before the change); Playwright workspace 818/818 (+10 = 5 journeys x 2: another device waits with the server's pay-by and Check payment finds it paid; another device's card-paid booking gets the refund choice; a wallet booking gets wallet words and no refundTo; the pending card bookings limit; admin pharmacy name, Recheck, Mark failed with a lost answer checked, then Move to wallet offered; all 5 failed on 75e6c45; temporary config on port 5393, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-23 | WQ16 assisted booking phase 1b: card or UPI booking, refund choice, admin card refund queue (on 72a9b27) | Against r10 9f2a1807 (design §23.3; mocked API). typecheck clean; Vitest 379/379 (+14 in wq16.test.ts: verify/reconcile answers and refusals read for paid / refunded / unpaid / failed / blocked / unknown, verify without `module` and reconcile with the record id only, a lost verify falls back to reconcile, a late capture is never paid, pay-by words in India time, the card create refusals (switch off, nothing to pay, no gateway keys; the 502 stays unknown), `refundTo` and by-key `payment`, refund and cancel words per state, admin agreement rule, queue rows, move request and its 502 on an odd answer, final and before-writing refusals, the processed-row check); Playwright workspace 808/808 (+20 = 10 journeys x 2: card pay success, Checkout closed then Pay now from Booked consultations on the same order, lost verify then reconcile, late capture refunded, 502 order failure resent, switch off then wallet with a new key, cancel refund to card, cancel refund to wallet, a booking not made here (no choice, neutral words), admin move to wallet with a lost answer checked; temporary config on port 5391, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build OK. |
| 2026-11-23 | WQ15b follow-ups (L1, L3, N1, N2 on e5d0e1c) | Against r9b 9be7d0a7 (mocked API). typecheck clean; Vitest 365/365 (no new tests; extended in wq15.test.ts: a 200 that is not a closure is a 502 (L1), TOPUP_REFUNDED is final (N1); both failed before the fix); Playwright workspace 788/788 (the select-refusal journey rewritten for L3: the choice stays, the same ticket opens another workspace, no new code; the resend journey now expects the N2 "already closed" words; both failed before the fix; temporary config on port 5372, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-23 | WQ15 close a card top-up already paid by hand; clinic sign-in refusal (on 0cbc4a2) | Against r9 0ca329aa (design §22; mocked API). typecheck clean; Vitest 365/365 (+9: wq15.test.ts 8 (close refusal words incl. TOPUP_REFUNDED, the refused-before-writing 503s, the any-attempt final refusals, the reason rule and owner wording, the list filter, the close and by-key requests, both clinic codes, the client's 403 hook), errors.test.ts 1); Playwright workspace 788/788 (+14 = 7 journeys x 2: list and mark with a reason and a confirm step; a lost answer checked by key, resent with the same key and body, and checked after a reload; the 409 credited case and Forget; clinic refusal at verify, at select (then "Choose another workspace" with a new code), on a partner call (session ended on the server, the message, no loop on reload, the follow-up code name) and on a reload (the profile read); the two session-end journeys failed with the hook disabled; temporary config on port 5371, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-23 | WQ14b follow-ups (M1, M2, L1–L3, nits on 183a756) | Mocked API as WQ14. typecheck clean; Vitest 356/356; Playwright workspace 774/774 (+16 = 8 journeys x 2: carried key survives a reload as an opaque marker, a current-page forgotten credit carries its key, Forget hidden during a check, a found credit drops its kept key, a 400 gives the key back, a late original with another body adds nothing, the tick cleared, the restored older-backend name words; 6 of them failed before the fix, the two L3 ones cover existing behaviour; temporary config on port 5361, `reuseExistingServer: false`, deleted); screenshots of Pharmacy wallets and the booked consultation identical to 183a756; `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-23 | WQ14 before production (W1–W3 on 3d26b8c) | Against stage (r7 e90952cc) and r8 B6 dd8971b0 `holder.typedName` (mocked API). typecheck clean; Vitest 356/356 (+2 in wq14.test.ts: a 503/500 by-key read is thrown, the exact-read "Not found" words; −1: the removed customer-list typed-name read); Playwright workspace 758/758 (+14 = 7 journeys x 2: W1 reload mid-credit then the old key reused, the 409 path, Back keeps the key; W3(b) a failed check hides Forget; W2 one booking read and no customer list, an older backend, after a reload; the L3 check test now reads `holder.typedName`; temporary config on port 5351, `reuseExistingServer: false`, deleted); screenshots of Pharmacy wallets and the booked consultation before/after identical except the W3(c) sentence; `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-22 | WQ13 review fixes (M1, L1–L7 on 8f892cc) | Against stage (r6 694bfaa9) and r7 `adminTopupByKey` as in its worktree (mocked API). typecheck clean; Vitest 355/355 (+4 tests, several extended: history search with no clock cut-off and its 20-page limit words, the r7 by-key read (credited / not_found / no route / odd answer), the newest admin credit, read errors without "nothing was added", the stored typed name paged by id with no `search`, marker ids); Playwright workspace 744/744 (+16 = 8 journeys x 2: L1 moved again since, L2 check closes the review, L3 stored-name check and a failed re-read, M1 reload + check of a credit on page 8, the 400-movement limit and the Forget tick, the r7 exact read and the L6 last credit, L7; the spec 120/120 with --repeat-each 3; temporary config on port 5337, `reuseExistingServer: false`, deleted); `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-22 | WQ13 (change time, typed name, admin pharmacy wallets, next free time) | Against q16 338733f8 and r6 694bfaa9 (mocked API). typecheck clean; Vitest 351/351 (+19: own-key modes, next free time, reschedule path/body/key checks and resend body, when it is offered, the slots offered, rule words, refusal words incl. SAME_SLOT, typed-name PUT and target (q16 user id, r6 holder link, no link), admin top-up Idempotency-Key header and same body on resend, refusals before sending, wallet reads with pharmacyId, form rules, finding a credit by key, refusal and S6 words); Playwright workspace 728/728 (+24 = 12 journeys x 2 devices, temporary config on port 5331 with `reuseExistingServer: false`; the two affected specs re-run 62/62 after the family-label change); `VITE_API_SAME_ORIGIN=true` workspace build clean. |
| 2026-11-22 | WQ12 review fixes (Opus xhigh review of c1e12b1) | typecheck clean; Vitest 332/332 (+6: supported modes, refused-before-writing codes, assisted rows, consent v2 and its length, language codes, 60 s write time limit); Playwright workspace 704/704 (+10 = 5 journeys x 2 devices: give up leaves no review and a resend of an abandoned key books nothing, with chat-only times hidden; 429 and coded 503 at create are not booked and each retry is a new key, consent v2 sent; coupon price note and no `join.phone` for video, Assamese sent; a reload mid top-up keeps it listed and the check settles it; Checkout that does not load takes no money and keeps nothing pending, an unpaid top-up removed from the list); `VITE_API_SAME_ORIGIN=true` build. Port 5298, temporary config with `reuseExistingServer: false`, not committed. |
| 2026-11-22 | WQ12 (assisted booking, booked consultations, wallet) | Against backend `m0/r4-assisted-stage` fb4063c7 (mocked API). typecheck clean; Vitest 326/326 (+23: phone canonical form, ApiError `limit`/`details`, lookup phone in the body only, verify without `module`, doctor slots path, cursor list, every documented refusal in words incl. switch off (503 / code-less 404), limits with the wait, PRICE_CHANGED price, wallet balance/state/sign/labels, patient step rules and bodies, family booked before, booker cancel rule, top-up amount); Playwright workspace 694/694 (+28 = 14 journeys x 2 devices: book for the owner with the required tick, nothing about the patient in storage or URLs; new number typed twice + family member; family member booked before sent by id; top-up inside the booking (verify, no module) then pay; insufficient balance, price changed (new key), slot taken, frozen, owing, unverified doctor; wallet on hold/owing blocks paying; coupon priced by the server; lookup limit and switch off (503 and 404); lost answer resent once (one booking, one charge) and checked by key; list, join, cancel with refund; dispensing copy PDF and an order from it; wallet history labels and a closed Checkout settled by the check; an unanswered check kept and settled by “Check my top-up”); `VITE_API_SAME_ORIGIN=true` build. Port 5297, temporary config with `reuseExistingServer: false`, not committed. Not yet run against a real backend or reviewed. |
| 2026-11-22 | WQ11d (review fixes on 0dde0fb: focus on Back or the field, Q16d desk seen and session no-shows, USE_CLINIC_CANCEL, batchInStock MRP, template cache, Add stock confirmation, 120 s report uploads and kept files, branch resend lock, extension re-read, discard kept over reload, owner-doctor unlink, admin picker place, per-half GST, refund on the lab page, stuck retry) | typecheck clean; Vitest 303/303 (298 + 5: ConfirmAction and NoShowMove Enter twice, report upload timeout, id-list markers, desk session no-show; cases added for seen on the day, sessionEndOf, USE_CLINIC_CANCEL, batchInStock, halfMinor); Playwright workspace 666/666 (648 + 18 = 9 journeys x 2: Enter twice on Mark no-show, template reopen after a save, unanswered upload kept, desk session no-show, doctor session no-show, owner-doctor unlink, branch resend lock, Add stock at once, stuck retry with an unconfirmed step; changed: desk seen before the time, NOT_STARTED_YET words, extension re-read, admin picker labels with the place, N4 new batch, discard over a reload, per-half GST, refund on the lab page); customer 266/266. Run twice: the repo's settings and trace off with 4 workers, no failures and no flakes either way (partner-labs template save 80/80 with --repeat-each 10 as well). Every new or changed journey fails with the source fixes put aside (15 of the checked set). Both builds OK with VITE_API_SAME_ORIGIN=true. Temporary configs on ports 5533/5534 (`reuseExistingServer: false`), deleted before commit. |
| 2026-11-22 | WQ11 integration (WQ11a + WQ11b + WQ11c merged on stage 317f21e; final Q16c preview rows and IMPORT_FILE_TOO_BIG; Q16a ALREADY_CANCELLED, OFFER_NO_LONGER_AFFORDABLE, desk move after the start, lab no-show after the window end, multi-seat sessions until their end) | typecheck clean; Vitest 298/298 (266 + 19 + 13 from the three branches; cases added inside existing tests: row-level `inMyStock`/`currentPrices`, IMPORT_FILE_TOO_BIG words, `labSlotEnd` and the no-show window, `movableSlot` for running multi-seat sessions, OFFER_NO_LONGER_AFFORDABLE words); Playwright workspace 648/648 (498 + 14 + 82 + 44 from the branches = 638; +10 = 5 journeys x 2: lab no-show disabled while the window runs and offered at its end; lab and consultation admin cancel answered 409 ALREADY_CANCELLED said as already done; a running doctor session with seats offered for an admin no-show move; a late desk appointment still moved. Changed: the N4 preview rows in the Q16c shape, IMPORT_FILE_TOO_BIG in the upload refusals, OFFER_NO_LONGER_AFFORDABLE in the offers journey, the lab no-show reason. Every new or changed journey fails without the source changes except the desk one, which confirms existing behaviour); Playwright customer 266/266; no flakes in the final run; both builds OK with VITE_API_SAME_ORIGIN=true. Temporary configs on ports 5531/5532 (`reuseExistingServer: false`), deleted before commit. |
| 2026-11-22 | WQ11a re-review N1–N5 + pill | typecheck clean; Vitest 266/266 (marker clear test removed; +1 logout answer shape; the resend rule test rewritten to settle-by-abandon); Playwright customer 266/266 (250 + 16 = 8 more journeys x 2, four of the earlier ones rewritten — markers survive sign-out and the request is resolved, never made twice; Confirm focus on Back, Enter twice does nothing; start-up Reconnecting… then resumed; Sign in again escape and a definite refusal at start; a 200 non-backend logout keeps the record; the pill never covers the title; lost lab resend refused 409/422 settled by abandon; abandon answering used opens the booking; a lost resend given up; doctor resend refused 400 opens the booked one / settles by abandon); Playwright workspace 512/512 (508 + 4 = 2 journeys x 2: start-up Reconnecting… and Sign in again; a 200 non-backend logout keeps the record); every new journey fails on 7d97d74; no flakes; both builds OK with VITE_API_SAME_ORIGIN=true. Temporary configs on ports 5503/5504 (`reuseExistingServer: false`), deleted before commit. |
| 2026-11-22 | WQ11a pre-production review (customer app; sign-in and session on both apps; Q16b partner sessions) | typecheck clean; Vitest 266/266 (253 + 13: web sign-out record and fallback/unknown, transient session errors, marker clear, logout noRenew + keepalive, partner bearer verify/select refused before sending (2 partner/auth tests rewritten to the cookie/native modes), resend settled only on REQUEST_ABANDONED/400/422, payment-check answers, workspace SessionProvider refusing partner sign-in in a cross-origin build and keeping bearer for other staff); Playwright customer 250/250 (222 + 28 = 14 journeys x 2: failed sign-out said, retried, not resumed on reload and cleared when the server answers; next start logs out before any refresh; renewal network failure keeps the session with Reconnecting…; a definite refusal still ends it; profile failure after the code ends the new session; lab coupon re-checked for a family member; lost lab create refused on resend then given up; a 422 resend settled; pay again after 400 PAYMENT_FAILED with amount due and wallet part; sign-in alerts, focus and code description; Confirm focus in and back; explicit sign-out clears markers; a doctor booking answer after leaving opens nothing; doctor give-up. All fail on 317f21e except the definite-refusal guard); Playwright workspace 508/508 (498 + 10 = 5 journeys x 2: failed sign-out not resumed, logout before refresh, Reconnecting…, profile failure ends the session, sign-in alerts and focus; all fail on 317f21e); no flakes; both builds OK with VITE_API_SAME_ORIGIN=true. Temporary configs on ports 5501/5502 (`reuseExistingServer: false`), deleted before commit. |
| 2026-11-22 | WQ11b (partner and admin screens: pre-production review fixes, on Q16a/Q16b) | typecheck clean; Vitest 272/272 (+19: lab paging/cursor/page checks, version fences on every lab step, one-file uploads with keys, size refusals, saved template + TEMPLATE_CHANGED, admin cancel of moved no-shows (lab and consultation), canonical rebase, doctor-membership removal, closed branch scope, owner email admin-only, audit labels, payment refusals 400/422 only, desk 15-minute no-show and start-time rules, CGST/SGST rounding; DOM: ConfirmAction step identity, version and focus, NoShowMove choose-again and Back); Playwright workspace 580/580 (+82 = 41 journeys x 2, ported from the reviewer's proofs; every new one fails on 317f21e, checked in a copy with the source at 317f21e), customer 222/222; temporary configs on 5511/5512 with reuseExistingServer false (deleted); both builds with VITE_API_SAME_ORIGIN=true. |
| 2026-11-22 | WQ11c re-review fixes (N1–N7) | typecheck clean; Vitest 266/266 (+2: what a blank price leaves with Q16c `inMyStock`/`currentPrices`, the template example mark; the completion and no-show rules extended: 15-minute no-show grace, unreadable time still completes); Playwright workspace 542/542 (+16 = 8 journeys x 2 devices: N1 example row blocks adding, N2 Add stock supplier only when recorded and an unkept file supplier said, N3 no discard while confirming, N4 unpriced rows and kept prices with the wholesale column, N5 a failed re-read keeps the import page, N6 a retry lost within 30 s of the previous outcome stays unconfirmed, N7 no-show grace; the S2 journey updated: a ₹0 selling price is unpriced too). With the source changes stashed, all 8 new journeys fail. Customer 222/222. Both release builds with VITE_API_SAME_ORIGIN=true. Temporary config on ports 5523/5524 with `reuseExistingServer: false`, deleted before committing. |
| 2026-11-22 | WQ11c (doctor, pharmacy, finance: pre-production review) | typecheck clean; Vitest 264/264 (+11: completion rule and refusals, no-show slot fit and type refusal, import plan by mode, prices kept or ₹0, same file in 24 h, Q16c upload codes and month-first rows, supplier per delivery, 2-minute import timeout, server template or none, IST "today", by-key not-found codes); Playwright workspace 526/526 (+28 = 14 journeys x 2 devices: review proofs D1–D3 and S1–S2 as journeys, discard and same-file warning, file supplier and upload refusals, month-first rows, Add stock supplier beyond 50 with history and an archived refusal, Return to supplier beyond 50, unknown `?medicine=`, an import step that settles itself, a failed refresh that keeps the lists, the clinic by-key 404; the presence and no-show journeys updated to the new rules). With the source changes stashed, all 16 new or changed journeys fail. Customer 222/222. Both release builds with VITE_API_SAME_ORIGIN=true. Temporary config on ports 5521/5522 with `reuseExistingServer: false`, deleted before committing. |
| 2026-11-20 | WQ10c final review N1/N2 | typecheck clean; Vitest 253/253; Playwright workspace 498/498 (+4 = 2 journeys x 2: give up during an in-flight first send keeps the panel busy and the late send is refused; a supplier add resent into a 403 stays unconfirmed and the check finds it; both fail on f164cbe); stock-supply spec 46/46; both builds OK with VITE_API_SAME_ORIGIN=true. Temporary config on port 5425 (no server reuse), deleted before commit. |
| 2026-11-20 | WQ10c review fixes (patientName on the booking, Give this up for stock and suppliers, P1–P4, retry window, supplier refusals, by-key codes, name search out of the URL, import price note) | typecheck clean; Vitest 253/253 (+3: stuck import retry rule, abandon and specific-404 for stock, suppliers and pharmacies; the list-walk test replaced); Playwright workspace 494/494 (476 + 18 = 9 journeys x 2: P1 found entry clears the form, P2 panel stays busy during a resend, give up an entry that was added, give up / used for a supplier add, a resend refused outright and forget for a supplier edit, P3 older same-name import never opened and a new one asked, P3 restored marker never matched, P4 stuck import Try again, a lost retry not settled by an older outcome; P1–P4 and the retry journey fail on 30b62cd); Playwright customer 222/222; both builds OK with VITE_API_SAME_ORIGIN=true. Temporary configs on ports 5423/5424 (no server reuse), deleted before commit. |
| 2026-11-20 | WQ10c (WQ10 screens on Q15: no-show filter and patient names, SLOT_NOT_THIS_DOCTOR, keyed pharmacy create with by-key/abandon and phone lookup, fenced pharmacy edit with clearing and sign-out warning, keyed stock save and supplier create, INDEXES_OUTDATED, import date guidance) | typecheck clean; Vitest 250/250 (246 → 250: keyed stock save and by-key, keyed supplier create and by-key, pharmacy create key / by-key / abandon / phone filter / fenced update with nulls, sign-out and re-read rules, no-show filter and patient-name lookup, SLOT_NOT_THIS_DOCTOR words; the notes-reference tests removed); Playwright workspace 476/476 (436 + 24 = 460 on the merge; +16 = 8 new journeys x 2: consultations — patient name on the booking page, SLOT_NOT_THIS_DOCTOR refused in words and another time chosen; pharmacies — give up a lost create (abandoned / used), version fence RECORD_CHANGED between re-read and save, a first email does not sign out, 503 INDEXES_OUTDATED kept and resent; stock — lost entry resent with the same key and answered replayed, 503 kept and resent; suppliers — lost add resent replayed after a 503. One journey removed (a resend refused PHONE_ALREADY_EXISTS checked by number). Rewritten to the new contracts: no-show filter and patient names in rows, pharmacy list with the phone lookup, create with key and the holder of a taken number named, lost create resent replayed, lost before made resent once, reload looked up by key or given up, status and details saves with versions and a cleared city, sign-in with email removal, sign-out warning and a 409 email, stock entry with its key, lost entry found by key, lost-before resend and forget, import guidance and the server's expiry error, supplier add with key and a lost add found by key)); Playwright customer 222/222; both builds OK (workspace and customer with VITE_API_SAME_ORIGIN=true). Temporary configs on ports 5421/5422 (no server reuse), deleted before commit. |
| 2026-11-20 | WQ10a (add and import stock, suppliers, order cancel consistency, status words) | typecheck clean; Vitest 235/235 (+13: stock entry checks and body with its reference, lookup by reference, medicine search and history queries, import file checks, template headers, multipart preview / commit / retry paths, committable / retryable / claimed, supplier checks, create / patch bodies with null clears, revision on edit and archive, all pages, conflict code, cancel rule, status words); Playwright workspace 422/422 (+24 = 12 journeys x 2: add stock with confirmation and reference, from a stock row with a refusal, a lost entry found by reference and never resent, a lost entry forgotten after a second step; import with columns, template, problems first, problem rows download, confirm and history; a lost import confirmation settled from the import; suppliers add / edit with a conflicting change / archive with a version conflict; a lost supplier add found by name; return to supplier with none, then with one; Cancel order on Placed/Accepted/Packed without the stale warning; refunded order: no button, one message; ready for pickup: neither; prescription queue and review in words. One journey replaced (the stale-warning check); stock recall trace now reads “Accepted”); Playwright customer 222/222; both builds OK with VITE_API_BASE_URL=https://api.example.test. Temporary configs on ports 5401/5402 (no server reuse), deleted before commit. |
| 2026-11-20 | WQ10b (admin pharmacies, admin consultations and no-show moves, lab report signer registrations) | typecheck clean; Vitest 233/233 (+11: pharmacy list/get/create/update paths and bodies, ids and numbers refused before any request, the lost-create lookup by mobile number newest first with its time bound, create/update checks as the schemas (required name and number, normalised email, PIN, lengths, no clearing a held field), duplicate refusals; consultation list query (status, doctor, YYYYMMDD dates, paging), doctor search, free slots by doctor/day/mode, date and period refusals, the admin no-show offer (offer/used/instant/clinic); registration path and body on both scopes with the fence, kind and 3-60 number checks, owner-only edit); Playwright workspace 436/436 (+38 = 19 journeys x 2: owner adds, changes and removes a registration with the version fence; RECORD_CHANGED and a lost answer settled by a read; staff with staff.manage read-only; admin as owner on the admin route; nobody can sign a report -> Staff link -> registration added -> released under it; pharmacies list search, filters and paging (two quick changes both count); create with field checks, a taken number, one request however often clicked; a lost answer found by number (one POST); lost before the server: check, then the same request once more (one pharmacy); a resend refused PHONE_ALREADY_EXISTS found as created; reload leaves only a body-less marker; verify/deactivate/activate confirmed and only changed details sent; a details field changed elsewhere shown for review; sign-in change confirmed, a taken number on its field, a change made elsewhere stops it; consultations filters as the server takes them; a no-show moved once with key and version from the doctor's own free times; lost answers settled by a read or resent with the same key; instant, front-desk and already-moved bookings offer no move and NO_SHOW_RESCHEDULE_USED is said; a taken time re-reads the times); Playwright customer 222/222; both release builds OK with VITE_API_BASE_URL=https://api.example.test. Temporary configs on ports 5411/5412 (`reuseExistingServer: false`), deleted before commit. |
| 2026-11-19 | WQ9 re-review fixes | typecheck clean; Vitest 222/222 (+1: NFC); Playwright workspace 398/398 (journeys extended: doctor and pharmacy copy, no sign-out warning for a first email, warning when changing one; admin-order-cancellations 120/120 with --repeat-each 10); Playwright customer 222/222 (+2 = 1 journey x 2: an email set elsewhere re-reads the profile after 422); both builds OK. Temporary configs on ports 5305/5306, deleted. |
| 2026-11-19 | WQ9 review fixes | typecheck clean; Vitest 221/221 (+5: normalizeEmail with IDN/punycode and refusals, EMAIL_NOT_REGISTERED, leading 0, short-local masking, cooldownLeft); Playwright workspace 398/398 (+8 = 4 new journeys x 2; one replaced: staff without the email field; OWNER_REQUIRED on add; a save landing after its editor was replaced (fails without the fix); role frozen while sending; doctor EMAIL_NOT_REGISTERED, A → B → A waits and a leading 0); Playwright customer 220/220 (+6 = 3 journeys x 2: EMAIL_NOT_REGISTERED and the new hint; an IDN email from the profile and from sign-in in one ASCII form; A → B → A waits and a leading 0; the profile journey now adds the email through email verification). Both builds OK. Temporary configs on ports 5303/5304 (no server reuse), deleted before commit. |
| 2026-11-19 | WQ9 (sign in with a mobile number or an email; staff and owner emails) | typecheck clean; Vitest 216/216 (+12: identifier parser (+91, spaces, dashes, lower-cased email, refusals, one key only), masking and destination keys, email send/verify bodies, member email path and fence, optional email normalised, owner-only email edits, EMAIL_IN_USE); Playwright workspace 390/390 (+14 = 7 journeys x 2: partner email sign-in with the workspace choice and nothing stored; +91 number, a 429 on one email only, resend to the same destination; staff add with email and EMAIL_IN_USE, list, change and remove with the version fence; email edit refused as RECORD_CHANGED; staff with staff.manage add an email but change none; admin create with owner email and EMAIL_IN_USE; admin-as-owner email edit on the admin route); Playwright customer 214/214 (+6 = 3 journeys x 2: email sign-in sends only `email`, masked, nothing stored; +91 number then an email; a 429 on one email only and a burnt code). Existing login journeys unchanged (the new label contains "Mobile number"). Both release builds OK with VITE_API_BASE_URL=https://api.example.test. Temporary Playwright configs on ports 5301/5302 (no server reuse), deleted before commit. |
| 2026-11-18 | WQ8 review fixes (against Q14 d29b72e) | typecheck clean; Vitest 204/204 (+2: refusals settled for good vs left unknown; the bill handover taken only by its navigation; doctor desk no-shows; date of birth read as the server does); Playwright workspace 376/376 (+10 = 5 journeys x 2: two cashiers (a reviewed ₹300 never sent on the newer version; the cancellation asks again), a refused resend unlocks the bill, the setting's conflict message and "Saved.", a modified click hands nothing over, a desk no-show is the clinic's and an emptied day keeps the notice; receipt bill after a reload, search copy and owner-doctor branches added to existing journeys; the two-cashier and refused-resend journeys fail on 6b9ce70); customer 208/208 (+2: a missed instant consultation is final); both release builds OK. |
| 2026-11-18 | WQ8 Q14 review follow-ups | typecheck clean; Vitest 202/202 (+1: no ordinary new time or rejection after a moved lab no-show; ₹0 bill takes a payment; plain-mode payment checked); Playwright workspace 366/366 (+2 = 1 journey x 2: a ₹0 bill marked paid with a plain method, INVOICE_INDEXES_OUTDATED shown and nothing pending; lab and desk journeys extended: no Propose/Reject after a moved no-show, the bill's customer fixed while linked, no "new family member" claim); customer 206/206 (+2: a partly paid bill with split methods and what is due); both release builds OK. |
| 2026-11-18 | WQ8 (owner decisions, Q14 85a4ec1) | typecheck clean; Vitest 201/201 (+13: no-show move offers and paths for lab/desk/doctor, doctor slots, paid/due and payment rules, split payment bodies with key and version, appointment filter, link/unlink paths and rules, family member rules, own clinic body, admin doctor search, no cancel after a moved no-show); Playwright workspace 364/364 (+20 = 10 journeys x 2 devices: lab no-show moved once with a lost answer and then final, a used move refused; desk family member, desk no-show moved with a lost answer and a refused second move, bill from an appointment with prefill/appointmentId/second bill refused, admin link with a lost answer resent once, owner removes a doctor; doctor no-show move, own clinic created once found by key, DOCTOR_CLINIC_EXISTS and unverified; part and split payments with the owner setting and the refund, full-payment-only and a version refusal); customer 204/204 (+4: missed and moved consultation, missed and moved lab booking); both release builds OK. |
| 2026-11-16 | WQ7 (WQ2/WQ5/WQ6 on Q12/Q13) | typecheck clean; Vitest 143/143 (+4: catalogue search/by-key/abandon paths and key checks; finance cursor pages with total and queue account names, payout/adjustment by-key and abandon, `expectedDetailsVersion` and `expectedFinanceVersion` bodies, cursor/version checks before any request; desk step versions in every body and by-key/abandon paths; the look-alike and UTR-match helpers and their tests removed); Playwright workspace 308/308 (+18 = 9 journeys x 2 devices: catalogue item lost before a reload given up by key then a second one found by key; a resend of a given-up item key refused for good; payout lost before a reload checked by key, given up, a new one recorded, and its given-up resend refused; adjustment given up after a check, and one landing after the check answered `used` by the give-up; FINANCE_CHANGED on a stale adjustment and a payout review closed when the account moved; PAYOUT_DETAILS_CHANGED after the re-read closes the review and shows the saved details; queue/account/partner cursor paging with totals and row names; desk booking dropped before a reload given up, then a given-up resend refused; started slots not offered and SLOT_STARTED for a booking and a move; BOOKING_CHANGED on a stale cancel then a step on the new version; existing journeys updated: by-key checks, version bodies, replay text, invitation names, an open confirmation closing when the appointment changes, a move on a cached day refused then retried), no flakes; release build with VITE_API_BASE_URL=https://api.example.test. Port 5271, temporary config, not committed. Not yet run against a real backend or reviewed. |
| 2026-11-16 | WQ5 review fixes | typecheck clean; Vitest 128/128; Playwright workspace 268/268 (+6 = 3 journeys x 2 devices: a background refresh during the details save's re-read moves the baseline and the reviewed older details are not sent; for a payout and for an adjustment, a left page's late success does not settle the attempt another page resent and lost (still shown after remounting, found by the check, recorded once)); all 3 journeys fail on 1c21528; release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ5 (partner finance, admin settlements/payouts) | typecheck clean; Vitest 122/122 (+13: member/admin-as-owner and `/settlements` paths and queries, request key in the body and identical on resend, CSV blob with the token in the header, id/date/cursor/limit/key checks before any request, destination normalisation as `normalizeDetails`, payout and reason rules, India "today", finding a lost adjustment by key and a lost payout by UTR/amount/date; app: destination labels, form baseline never holding a masked number, event texts, India dates); Playwright workspace 226/226 (+18 = 9 journeys x 2 devices: partner balance, statement paging with running balance, period filter and CSV blob; owner changes the destination after a review saying it must be verified again, then a change made elsewhere stops the save after the re-read; staff with finance.view read-only, without it or branch-limited no page and no request; admin accounts filters, totals and paging; verify, stale details version refused, lost payout answer resent once (one payout); adjustment lost answer found by key; adjustment sent before a reload found by key afterwards (only a body-less marker kept); void from the queue with reason; admin as owner with the full account number; nothing private in storage or URLs); release build with VITE_API_BASE_URL=https://api.example.test. Playwright ran on port 5197 (temporary config, not committed). Not yet run against a real backend or reviewed. |
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
| 2026-11-16 | WQ1 give-up ownership fix | typecheck clean; Vitest 79/79; Playwright workspace 182/182 (+2 = 1 journey x 2 devices: an obsolete give-up answer from a left page does not settle a newer retry; confirmed failing on 4646987); release build with VITE_API_BASE_URL=https://api.example.test. |
| 2026-11-15 | WQ1 re-review fixes + Q10 | typecheck clean; Vitest 79/79 (+ versions on edits, by-key lookup/abandon, RECORD_CHANGED); Playwright workspace 180/180 (+12 = 6 journeys x 2 devices: after a reload a committed create is found by key and opened; a create not found is cleared only by abandon, then a new create (new key) is allowed; a create landing after the lookup makes the give-up answer `used` and opens it (one partner); a late create answer after leaving the page does not navigate; the branch picker is disabled while saving and the validated scope is sent; RECORD_CHANGED on a branch save shows the saved phone and the next save carries the new version, on permissions the revoked grant is shown for review); release build with VITE_API_BASE_URL=https://api.example.test. |
| 2026-11-15 | WQ1 review fixes + Q8 | typecheck clean; Vitest 77/77 (+ draft baseline/rebase, Q8 paths, request key, Q8 rules); Playwright workspace 168/168 (+14 = 7 journeys x 2 devices: switching partners discards drafts and a running submission stays with its partner; permission revoked while editing detected, nothing sent; a branch name edit does not resend changed services/holidays; lost create answer locks the form and the resend reuses key and content (one partner); branch access change and branch reopen; staff see the profile read-only; partner search, paging and reinstate); release build with VITE_API_BASE_URL=https://api.example.test. |
| 2026-11-15 | WQ1 (partner workspace foundation) | typecheck clean; Vitest 69/69 (+9: workspace/admin path building, id validation before any request, select per session mode, selection shape, delegation/scope/removal rules); Playwright workspace 154/154 (+20 = 10 journeys x 2 devices: single and multi-membership sign-in incl. native and expired ticket, nav by permission and scope, staff add/edit/remove with server refusal, branches add/deactivate with confirm, admin list/filter/create/verify/suspend, admin-as-owner staff via `/partner-workspace/admin/<id>/workspace/members`); release build with VITE_API_BASE_URL=https://api.example.test. Not yet run against a real backend or reviewed. |
| 2026-11-15 | WQ2 (catalogue and bills) | typecheck clean; Vitest 87/87 (+18: paise parsing/formatting, preview rounding incl. half-paisa and odd-paisa SGST, IGST, classification, refusals, member/admin paths, admin item switches, body request key with no header, PDF blob, id checks; app: list cursor and repeats, IST date bound, item and bill builders); Playwright workspace 170/170 (+16 = 8 journeys x 2 devices: catalogue add/edit/deactivate in paise; no-GST supplier offered 0% only, GST item refused on a bill, 503 linking refusal unlocks and a changed bill gets a new key; live totals, lost answer resent with the same key and body, one bill, linked notice, nothing in browser storage; reload with an unconfirmed bill: check by key, forget after warning; pay with confirm, refused pay shows the server and the current bill, cancel with reason, PDF via blob for v2 and v0; finance read-only and biller read-only price list, pages absent without permission; clinic doctor picker and IGST; admin-as-owner bills, catalogue and disable/enable); release build with VITE_API_BASE_URL=https://api.example.test. Playwright ran on a spare port (another worktree's dev server held 5174). Not yet run against a real backend or reviewed. |
| 2026-11-16 | WQ3 (lab slots, bookings, reports) | typecheck clean; Vitest 109/109 (+13: IST dates and weeks, template rules and derivation from generated slots, manual slot and capacity rules, reopen/bookable, the booking step table per state/visit mode/permission/payment, eligible signers, report file checks, member/admin paths and bodies, multipart upload, report blob via `/file/fetch` with the token in the header, id/mode/date/file checks before any request); Playwright workspace 204/204 (+14 = 7 journeys x 2 devices: week view, template from generated slots reviewed and saved whole, one-off slot and its 409 repeat, server capacity refusal then client refusal, close/reopen with confirm; a home collection through assign, collected, processing, upload (bad type refused), release as self, complete, nothing in storage; viewer and report-staff permissions, unpaid booking, clinic without lab pages; new time from open slots with a taken slot refused, then reject with reason and refund; admin list across labs, release under a chosen signer (only eligible offered), PDF and image via blob with no token in URLs; admin partner switch discards template and reject drafts, clinic URL says labs only; a held step answer after leaving shows nothing on the next booking, and a held capacity answer after changing week shows nothing); release build with VITE_API_BASE_URL=https://api.example.test. Playwright ran on a spare port (temporary config, not committed). Not yet run against a real backend or reviewed. |
| 2026-11-16 | WQ4 re-review fixes (Codex, 511eff2) | Against Q13 4d877b6. typecheck clean; Vitest 131/131; Playwright workspace 278/278 (+4 = 2 journeys x 2 devices, both failing on 511eff2: attempt 1 held, the doctor leaves and returns, attempt 2 with the same key lost, attempt 1's success released to the left page — the returned page stays locked and a remount's check settles it once (one extension, two POSTs with one key); uncertain with the server showing Off, Enter in the fee field confirms Off against the read version); release build with VITE_API_BASE_URL=https://api.example.test. Unique port 5281, temporary config with `reuseExistingServer: false`, not committed. |
| 2026-11-16 | WQ4 re-review fixes (Codex, 7b32cff) | Against Q13 4d877b6. typecheck clean; Vitest 131/131 (standing per `isEligibleDoctor`); Playwright workspace 274/274 (+6 = 3 journeys x 2 devices, each failing on 7b32cff: a lost change held before its compare-and-set, a reload (still uncertain), a read showing ₹500/v1 with accept and heartbeats blocked, the lost change committing, a confirmation of ₹500 refused 409 and A's ₹100/v2 shown, then ₹100 confirmed as v3 and only then accept and heartbeats; an extension lost, the page left and reopened with the same minutes locked and only the same-key resend (added once), then a reload leaving only the check, settled when the consultation is no longer held; a heartbeat held while the page is shown again sends no second one and the page ends on the newer presence); existing journeys confirm the shown terms after a check; release build with VITE_API_BASE_URL=https://api.example.test. Unique port 5261, temporary config with `reuseExistingServer: false`, not committed. |
| 2026-11-16 | WQ4 re-review fix + Q13 (Codex, 9d9660c) | Against backend Q13 (7032f9d + 4ac16b6). typecheck clean; Vitest 131/131 (doctor API paths/bodies updated: presence read, `expectedPresenceVersion`, keyed extend and booking read, `expectedUpdatedAt`, `expectedDetailsVersion`, cursor-paged payouts/events; cursor, key, version and timestamp checks before any request); Playwright workspace 268/268 (+2 = 1 journey x 2 devices: Codex's sequence — a change whose answer is lost and that reaches the server late, a re-read, newer terms acknowledged, then the late request refused 409 by its stale version: server and page keep the newer fee, heartbeat and accept use it, and a change made elsewhere refuses the next one and shows the server's terms; fails on 9d9660c. Extended journeys: presence read on start and after reload, a lapsed presence not revived, busy shown from the heartbeat; lost fee change → read → resend against the read version; patient's paid amount and a too-high fee blocked; replayed accept; extension lost after or before the server with lookup and same-key resend; schedule and payout-detail 409s from the server-side fences; activity paged by cursor); release build with VITE_API_BASE_URL=https://api.example.test. Unique spare port 5251, temporary config with `reuseExistingServer: false`, not committed. |
| 2026-11-16 | WQ4 review fixes (Codex, f740811) | typecheck clean; Vitest 131/131 (+1: call-link state per mode, status, payment, ready/preparing/failed); Playwright workspace 266/266 on the merged branch (+4 = 2 journeys x 2 devices, both failing on f740811: a ₹500→₹100 change whose answer is lost shows "Not confirmed", hides the old fee, blocks accept and sends no heartbeat for three minutes, then "Send again" is acknowledged, the confirmation names ₹100 and heartbeats resume; an accepted and a recovered consultation show "The call link is being prepared…", the link appears by reading again on Consult now and by Refresh on Appointments, and a failed link says why); existing journeys now switch on before accepting; release build with VITE_API_BASE_URL=https://api.example.test. Spare port, temporary config not committed. |
| 2026-11-16 | WQ4 (doctor tools) | typecheck clean; Vitest 124/124 (+15: YYYYMMDD dates, schedule rules incl. clinic branches and overlap, slot counts, presence rules, offer countdown, refusal words vs unknown outcomes, appointment commands per state/payment/time, practice and payout-detail checks, period and CSV name, every `/specialists/me` path and body, ids/dates/cursors/minutes refused before any request, CSV blob with the token in the header only); Playwright workspace 222/222 (+18 = 9 journeys x 2 devices: doctor sign-in, doctor-only nav and Home status card, other roles' pages absent; partner and admin see no doctor page; schedule with a verified clinic window, overlap refused, server refusal, a day changed elsewhere reset and not sent, leave add/remove; available now with types and fee, heartbeats only while visible and on any page, an answer after Update shown, off again; offers with countdown, accept after confirming, eight refusals in words, a lost answer found in the appointments with one POST, extend and its refusal, nothing in storage; a held accept answer after leaving shows nothing; appointments today/14 days/one day with cancel (reason, refund), complete, no-show only after the start, confirm only when paid; invitations accept/decline, leave, solo practice once; earnings balance, statement paging and period, CSV download, payouts, payout details changed elsewhere stop the save, then saved and shown as waiting for verification); release build with VITE_API_BASE_URL=https://api.example.test. Playwright ran on a spare port (temporary config, not committed). Not yet run against a real backend or reviewed. |
| 2026-11-16 | WQ3 review fixes | typecheck clean; Vitest 109/109; Playwright workspace 208/208 (+2 journeys x 2: an open release cannot be confirmed while an upload runs, then both drafts stay correct (one release, two uploads); a held template save after opening the one-off slot form keeps that draft and the week, and the reverse); both new journeys fail on 214e97b; release build. Spare port (temporary config, not committed). |
| 2026-11-15 | WQ2 fixes (WQ1 review rules) | After merging the WQ1 review fixes: typecheck clean; Vitest 96/96 (catalogue edits from a baseline: only changed fields, rebased field not sent back, price above the saved MRP refused); Playwright workspace 190/190 (+3 journeys x 2: item edit re-read sends only the name while someone else changed the price, a both-changed price is shown again and not sent; a lost item create is locked and sent to the list, one POST; admin switching partners keeps the unconfirmed bill, drafts and an open item edit with their own partner); release build. Spare port again (temporary config, not committed). |
| 2026-11-16 | WQ2 Codex fixes + Q10 | typecheck clean; Vitest 99/99 (mergeDetail both answer orders, bill filters, clinic item kinds, Q10 paths: includeInactive, reactivate, by-key lookup/abandon with key checks, cancel refund, cursor page with total/nextCursor); Playwright workspace 204/204 (24 partner-invoices journeys x 2: catalogue reactivate and expectedUpdatedAt, stale edit 409, clinic kinds, lost item create resent with the same key, lost item create after reload with duplicate confirmation, bill lost before reload abandoned by key, bill issued before reload found by key, catalogue price changed refused then reissued, paid cancel with refund, pay/cancel one at a time with a lost payment replayed, cursor paging across a shared instant, search and date range); release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ2 re-review fixes | typecheck clean; Vitest 100/100 (+ payment settled only by the bill); Playwright workspace 208/208 (+2 journeys x 2, both failing on d046414: a lost UPI payment with failing bill reads keeps the exact payment, offers no Cash form, keeps cancel locked, survives leaving the page and is settled by its receipt; a held give-up answer from a left page does not delete the returned page's resend or its reload marker, and the bill is then found by key, one bill); release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ2 re-review 2 fix | typecheck clean; Vitest 100/100; Playwright workspace 212/212 (+2 journeys x 2, both failing on e3c6440: page A's held UPI payment is shown on page B instead of a new form with cancel locked, B's resend loses its answer with failing reads, A's late 409 leaves B's record, a remount still shows it, the receipt then settles it; a payment sent just before a reload is shown as unconfirmed and a new one is offered only after a fresh unpaid read and a confirm step); release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ6 (clinic doctors and front desk) | typecheck clean; Vitest 129/129 (+14: mobile canonical form, invitation scope and branch rules, in-clinic branches and doctors per branch, desk booking field rules, 31-day range, IST appointment times in both stored formats, desk steps per status/source/permission/time, member and admin paths and bodies (key in the body, no header), id/mobile/date/state/key checks before any request; app: look-alike rows for a lost booking, answers folded into rows); Playwright workspace 264/264 (+20 = 10 journeys x 2 devices: doctors list, invite by mobile and by id with branch choice, a repeat answering the pending invitation, server refusals, revoke after a confirmation; day view by branch/doctor/day with online bookings view-only; booking reviewed and sent once with a key, then arrived and seen, nothing about the patient in storage or the URL; a lost answer locks the booking, the day list shows a look-alike, the same request resent books once, then a loss before a reload is set aside only after a confirmation; a slot taken (409) keeps the details and the next time gets a new key; no-show only after the time and no-show/cancel confirmations saying no money moves; reschedule to another day with a taken slot refused and reloaded; one step at a time with an open confirmation disabled and a late answer silent on another appointment; view-only staff, a biller and a lab; admin as owner with partner switching, admin paths and a lab told the pages are for clinics), clinic spec also 60/60 with --repeat-each=3; release build with VITE_API_BASE_URL=https://api.example.test. Spare port 5198 (temporary config, not committed). Not yet run against a real backend or reviewed. |
| 2026-11-16 | WQ6 review fix | typecheck clean; Vitest 128/128 (the answer-merge helper and its test removed); Playwright workspace 266/266 (+2 = 1 journey x 2 devices, failing on 80adab5: an "arrived" answer is held, the person leaves and comes back, moves the appointment to 10:30, then the old answer lands and the day cannot be read: no stale 12:00 appointment and no steps are shown, only the error with a retry; after the retry 10:30, not checked in), clinic spec 66/66 with --repeat-each=3; release build. Spare port 5236 with a temporary config that never reuses another worktree's server (5198 was taken by a sibling worktree's dev server), not committed. |\n| 2026-11-15 | P8 web, N2 phone apps, P9 web approved | Codex approved P8 web (e0add83, after 3 rounds: attempt ownership, keyed recovery result, decision after waits), N2 (f4c3ff8: secure-store start gate, latest-attempt start-up) and P9 web (aab4e01, after 3 rounds: attachments keyed to their pharmacy, functional updates, no order while attaching, expectedPharmacyId recipient fence). vitest 60; Playwright customer 134, workspace 134; Android debug + unsigned iOS builds for both apps. |
| 2026-11-15 | P8 web, N2 phone apps, P9 web approved | Codex approved P8 web (e0add83, after 3 rounds: attempt ownership, keyed recovery result, decision after waits), N2 (f4c3ff8: secure-store start gate, latest-attempt start-up) and P9 web (aab4e01, after 3 rounds: attachments keyed to their pharmacy, functional updates, no order while attaching, expectedPharmacyId recipient fence). vitest 60; Playwright customer 134, workspace 134; Android debug + unsigned iOS builds for both apps. |
| 2026-11-15 | WC1 (customer: partner labs, bills, Consult now) | typecheck clean; Vitest 82/82 (+ lab/bill/instant api modules, cancel rule, timeline, GST split, waiting rules, file sniffing); Playwright customer 176/176 (new: partner-labs 20, instant-consult 16, bills 6; desktop + Pixel 7, mocked API); release build with VITE_API_BASE_URL=https://api.example.test. The existing "inside 24 hours" test now accepts the Monday 48-hour rule (it failed when 5 hours ahead fell on a Monday). Not yet run against a real backend; not Codex-reviewed. |
| 2026-11-15 | WC1 review round 1 + Q9 | Codex WC1: 5 MEDIUM (quote not bound to funding; stale lab coupon; unowned create/pay completions; no refresh after acceptance; file state across bill versions). Fixed with backend Q9 (78b9efe). typecheck clean; Vitest 89/89 (+ price agreement, paging, single lab, payable mirrors, versioned PDF, recorded refunds); Playwright customer 194/194 (new: coupon re-checked on test change, price refused then accepted (labs and Consult now), late create and pay answers after leaving open nothing, reload lookup used / unknown → confirmed give-up, Meet link after acceptance + doctor cancellation, bill PDF follows the version, report signers by file); release build with VITE_API_BASE_URL=https://api.example.test. |
| 2026-11-16 | WC1 review round 2 | Codex WC1 re-review: 2 MEDIUM (older/left-page create success consumed a newer attempt's request; a coupon dropped by an automatic re-check auto-accepted the higher price). Fixed. typecheck clean; Vitest 89/89; Playwright customer 200/200 (new: out-of-order answers across remounts keep the newer attempt and complete it once; coupon dropped by re-check requires accepting the higher price, labs and Consult now); release build with VITE_API_BASE_URL=https://api.example.test. |
| 2026-11-25 | WQ31 UI translation round 6a (foundation) | typecheck clean (now with `packages/i18n`); Vitest 449/449 (+27: placeholders, plurals, per-word English fallback, loading and the last switch winning, pseudo, start-up and choice storage, formats byte-identical to the old helpers in English with Latin digits elsewhere, the catalogue check, the literal scan, switcher/scope/parts); Playwright workspace 900/900 and customer 270/270 (+4 each: English by default with no language list and nothing stored; a kept language not offered is ignored), all on temporary ports 5476/5477 with `reuseExistingServer: false`, configs deleted; both builds with `VITE_API_SAME_ORIGIN=true` (no pseudo-language in either bundle). |
| 2026-11-25 | WQ31 6a merged with `wq/stage-next` bd0df6c (branch `wq31/i18n-merged`) | typecheck clean; Vitest 471/471; Playwright workspace 942/942 on temporary port 5486 (`reuseExistingServer: false`, config deleted); both builds with `VITE_API_SAME_ORIGIN=true` (no pseudo-language in either bundle). Lab desk and lab wallet money through `formatPaise` (English unchanged); 7 new files allowlisted (166). |
| 2026-11-25 | WQ26 referral cuts, phase 4a/4b web (on `wq/stage-next-2` 13333e9) | Against r24 on stage 6a8574e9 (§26.5, §26.6, §26.15; mocked API). typecheck clean; Vitest 488/488 (+10 in referralCuts.test.ts: percent typed → basis points 1–5000 without floating point, fixed ≥ ₹0.01 with no upper limit and no cap, the optional cap, Off keeps the saved terms inactive, the PUT body checked again, the words, the switch read from `effective`, refusals and the before-writing 503s, the statement row's short ref and category, the routes with ids, kinds and cursors checked first); Playwright workspace 984/984 on temporary port 5513 (`reuseExistingServer: false`, config deleted; +12 = 6 journeys x 2 devices in referral-cuts.spec.ts: a % rule set and confirmed with a reason, sent as a create and shown with its history; a fixed rule for a lab, then a lost answer checked by reading the rules; a version conflict (409 RECORD_CHANGED) read again and sent on the new version; the switch-off note and turning a cut off; the pharmacy's earnings, rates and statement pages with nothing kept on the device; a pharmacy cannot reach the admin page); release build with `VITE_API_SAME_ORIGIN=true`. |
| 2026-11-25 | WQ40 i18next + react-i18next engine (branch `wq40/react-i18next` on stage bac568e) | typecheck clean; Vitest 495/495 (+2: values inserted as written with no escaping, nesting or second pass; only words shaped like their English are used; the 6a i18n, switcher and scope tests pass unchanged on the new engine); Playwright on temporary ports 5541/5542 (`reuseExistingServer: false`, configs deleted): workspace 1004/1004 (932 in the full run, which shared the machine with the customer suite; the 72 that timed out, nearly all right after a `page.reload()`, all passed when run again alone) and customer 266/270: the 4 failures are `native-session.spec.ts:178` and `pharmacy.spec.ts:370` on both devices, which fail the same way on unchanged stage bac568e (pre-existing, not WQ40); both builds with `VITE_API_SAME_ORIGIN=true` (no pseudo-language in either bundle; main chunk +56 kB, +18 kB gzip, for i18next and react-i18next). |
| 2026-11-25 | WQ26b referral follow-ups on r33 (on stage 25a860c) | Against r33 335e36c2 (§26.16; mocked API). typecheck clean; Vitest 493/493 (referralCuts.test.ts on r33's shapes: `switches` beside the lists, rows from `shortRef` / `category` / `lines`, the pharmacy and lab bases incl. admin scope and the CSV period); Playwright workspace 1024/1024 on temporary port 5563 through `pw-slot.sh` with 2 workers (`reuseExistingServer: false`, config deleted; referral-cuts.spec.ts now 8 journeys x 2 devices: the switch note from `switches` with no rule set and after the switch changes, a lab booking's lines in the statement, the CSV download, a lab finance member's earnings page and CSV, a branch-limited lab member refused); release build with `VITE_API_SAME_ORIGIN=true`. |
| 2026-11-25 | WQ46 customer sign-in then reload (branch `wq46/signin-reload` on stage 25a860c) | Tests only, no app change. typecheck clean; Vitest 494/494; Playwright customer 270/270 on temporary port 5561 through `pw-slot.sh` (`reuseExistingServer: false`, config deleted). The two journeys on unchanged stage: 8/8 at 1 worker, 4/12 at 5 workers (all 8 failures the 30 s timeout), 4/4 with 90 s, 4/4 in 8–12 s against the release build. |
| 2026-11-25 | WQ26c referral review fixes (on 5475091) | typecheck clean; Vitest 506/506 (the referral statement with a period); Playwright `referral-cuts.spec.ts` + `finance.spec.ts` 54/54 through `pw-slot.sh` with 2 workers on temporary port 5563 (config deleted; +4 = 2 journeys x 2 devices: a lone cut line that is not the whole booking is listed, the whole-statement CSV refused with the server's words and a period exported with the list following it; a lab member without `finance.view` gets no page and reads nothing). |
| 2026-11-26 | WQ52 statement date fields (on stage 06daf52) | typecheck clean; Vitest 526/526 (the stricter literal scan included); Playwright `finance.spec.ts`, `finance-4f.spec.ts`, `referral-cuts.spec.ts` and `doctor-tools.spec.ts` 132/132 through `pw-slot.sh` with 2 workers on temporary port 5563 (config deleted; the doctor's statement on the shared period fields and CSV; a year typed 0002 → 0020 → 0202 → 2026 read once). |
| 2026-11-26 | WQ51 Doctor › Bills / Services and prices, "Price list" renamed (branch `wq51/doctor-bills-names`, merged with stage ebcbfd7) | Option (b). typecheck clean; Vitest 526/526 (literal scan and catalogue checks pass); Playwright workspace 1136/1136 on temporary port 5571 through `pw-slot.sh` with 2 workers (`reuseExistingServer: false`, config deleted; +6 = 3 journeys x 2 devices in `doctor-tools.spec.ts`: no clinic, unverified clinic, verified clinic with the sign-out switch and nothing in the URL or storage). |
| 2026-11-26 | WQ51b doctor Bills review fixes (on stage 06c2080) | typecheck clean; Vitest 529/529; Playwright `doctor-tools.spec.ts` + `partner-invoices.spec.ts` 140/140 through `pw-slot.sh` with 2 workers on temporary port 5563 (config deleted; +8 = 4 journeys x 2 devices: Bills and Services and prices each sign out and, after a clinic staff sign-in with no address typed, open `#/partner/invoices` / `#/partner/catalogue`; a doctor not verified gets the closed-workspace words and no button, a suspended clinic its own words on Bills and Clinics; a clinic's Home tile has the menu's words — this one fails without the fix). |
| 2026-11-27 | WQ56 doctor dashboard P2 (branch `wq56/doctor-dashboard`, merged with web stage 6bc8c1d; backend r39b 379b1a50) | typecheck clean; Vitest 545/545 (+7 in doctorDashboard.test.ts: the r39 routes and bodies, `breakdown=1`, ids/keys/dates checked first, his Today and private to-dos, the `{ kind: 'doctor' }` bill scope and his clinic read, free slots by place and mode, bookable and owned clinics); Playwright workspace 1215 passed, 9 skipped, 2 failed on temporary port 5576 through `pw-slot.sh` with 2 workers (config deleted): +15 in doctor-dashboard.spec.ts (one list with chips, + New clinic appointment at Demo Care, online consultation awaiting app payment, billing his own clinic, a non-owner without Bills, private to-dos, earnings by source, a 390 px phone). The 2 failures are `clinic-desk.spec.ts:702` (desktop and tablet), WQ57b's: the receipt now names the patient ("Meena with Dr Mehta…") where the test expects "The patient with Dr Mehta…"; not touched by WQ56. An earlier full run's 3 timeouts (`orders.spec.ts:396,419`, `records-access.spec.ts:158`) passed when run again (60/60). Screenshots in /tmp/wq56-shots. |
