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
| 2026-11-16 | WQ3 review fixes | typecheck clean; Vitest 109/109; Playwright workspace 208/208 (+2 journeys x 2: an open release cannot be confirmed while an upload runs, then both drafts stay correct (one release, two uploads); a held template save after opening the one-off slot form keeps that draft and the week, and the reverse); both new journeys fail on 214e97b; release build. Spare port (temporary config, not committed). |
| 2026-11-15 | WQ2 fixes (WQ1 review rules) | After merging the WQ1 review fixes: typecheck clean; Vitest 96/96 (catalogue edits from a baseline: only changed fields, rebased field not sent back, price above the saved MRP refused); Playwright workspace 190/190 (+3 journeys x 2: item edit re-read sends only the name while someone else changed the price, a both-changed price is shown again and not sent; a lost item create is locked and sent to the list, one POST; admin switching partners keeps the unconfirmed bill, drafts and an open item edit with their own partner); release build. Spare port again (temporary config, not committed). |
| 2026-11-16 | WQ2 Codex fixes + Q10 | typecheck clean; Vitest 99/99 (mergeDetail both answer orders, bill filters, clinic item kinds, Q10 paths: includeInactive, reactivate, by-key lookup/abandon with key checks, cancel refund, cursor page with total/nextCursor); Playwright workspace 204/204 (24 partner-invoices journeys x 2: catalogue reactivate and expectedUpdatedAt, stale edit 409, clinic kinds, lost item create resent with the same key, lost item create after reload with duplicate confirmation, bill lost before reload abandoned by key, bill issued before reload found by key, catalogue price changed refused then reissued, paid cancel with refund, pay/cancel one at a time with a lost payment replayed, cursor paging across a shared instant, search and date range); release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ2 re-review fixes | typecheck clean; Vitest 100/100 (+ payment settled only by the bill); Playwright workspace 208/208 (+2 journeys x 2, both failing on d046414: a lost UPI payment with failing bill reads keeps the exact payment, offers no Cash form, keeps cancel locked, survives leaving the page and is settled by its receipt; a held give-up answer from a left page does not delete the returned page's resend or its reload marker, and the bill is then found by key, one bill); release build. Spare port (temporary config, not committed). |
| 2026-11-16 | WQ2 re-review 2 fix | typecheck clean; Vitest 100/100; Playwright workspace 212/212 (+2 journeys x 2, both failing on e3c6440: page A's held UPI payment is shown on page B instead of a new form with cancel locked, B's resend loses its answer with failing reads, A's late 409 leaves B's record, a remount still shows it, the receipt then settles it; a payment sent just before a reload is shown as unconfirmed and a new one is offered only after a fresh unpaid read and a confirm step); release build. Spare port (temporary config, not committed). |
| 2026-11-15 | P8 web, N2 phone apps, P9 web approved | Codex approved P8 web (e0add83, after 3 rounds: attempt ownership, keyed recovery result, decision after waits), N2 (f4c3ff8: secure-store start gate, latest-attempt start-up) and P9 web (aab4e01, after 3 rounds: attachments keyed to their pharmacy, functional updates, no order while attaching, expectedPharmacyId recipient fence). vitest 60; Playwright customer 134, workspace 134; Android debug + unsigned iOS builds for both apps. |
