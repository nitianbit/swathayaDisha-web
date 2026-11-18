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

Assumed (not in Q14): nothing on the wire. Not shown because the server does not send it: desk rows' no-show history (`deskView`), so the desk's
"used" state comes from the 409. Admin search by mobile depends on the server's text index (rows show each doctor's mobile to check). The admin route
for moving any doctor's no-show is in `doctorAdminApi` but has no screen yet (no admin consultation-bookings page).

Verification: see the 2026-11-18 WQ8 row below. Playwright ran on ports 5291 (workspace) and 5292 (customer) with temporary configs
(`reuseExistingServer: false`), not committed.

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
