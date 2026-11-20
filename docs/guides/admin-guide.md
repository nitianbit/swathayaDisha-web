# Jansetu Workspace: Admin Guide

**What you can do here:** add and verify labs and clinics, manage any of them with owner rights, link doctors to clinics, watch lab bookings, decide pharmacy order cancellations, fix stuck refunds and provider cancellations, and pay out labs, clinics and doctors.

Website: **https://staff.swasthadisha.etryx.in**

---

## 1. Sign in

1. Open the website.
2. Under **I am signing in as**, choose **Admin**.
3. Type your **Mobile number or email**. Email works only if it is on your admin account.
4. Tap **Send code**, type the 6-digit code from the SMS or email, and tap **Verify and sign in**.

Your menu is on the left, under **Admin**:

- **Labs and clinics**
- **Lab bookings**
- **Order cancellations**
- **Refunds needing attention**
- **External cancellations**
- **Settlements**
- **Payouts**

**Sign out** is at the bottom.

---

## 2. Labs and clinics

This lists every partner. Search by name, or filter by **Type**, **Status** (**Waiting for verification**, **Verified**, **Suspended**) and **Active**.

### Add a lab or clinic

1. Tap **Add a lab or clinic**.
2. Choose **Type**: **Lab** or **Clinic**. For a one-doctor clinic, tick **Single-doctor practice**.
3. Fill in **Display name**, **Contact phone**, **Invoice prefix** (1 to 6 letters or digits) and **Tax**. Add **Legal name**, **Contact email**, **GSTIN** and **PAN** if you have them.
4. Under **First owner**, fill in **Owner name**, **Owner mobile number** and, if you like, **Owner email (optional)**. The owner can sign in with that email too.
5. Tap **Create**.

The new partner starts as **Waiting for verification**. Its owner can use the workspace once you verify it.

### Verify, suspend, reinstate

These buttons are on each row of the list and at the top of a partner's page:

- **Verify**: for a partner waiting for verification. Its members can start working and it can take bookings.
- **Suspend**: its members are signed out and cannot sign in until it is reinstated.
- **Reinstate**: makes a suspended partner verified and active again.

**A doctor's own clinic:** when a doctor creates a clinic, it appears here as **Waiting for verification**. Open it, check its details and **Tax and invoicing**, then tap **Verify**. Until then, patients cannot book the doctor there.

### Open a partner

Tap a partner's name. You see its **Status**, contact details and owners, then:

- **Tax and invoicing**: change **GSTIN**, **PAN**, **Tax** and **Invoice prefix**, then tap **Save tax details**. Partners cannot change these themselves.
- **Manage as owner**: you can do everything an owner can. Your changes show as "Jansetu admin" in its activity log. The links are:
  - **Profile**: contact details, and **Payments at the counter** (part payments on or off).
  - **Staff**: add owners and staff, permissions, branch access and sign-in emails.
  - **Branches**: add, edit, deactivate and reopen branches.
  - **Activity log**: the latest 100 changes.
  - **Tests and prices** or **Services and prices**: you can also **Disable** an item. It then shows **Disabled by Jansetu**, and the partner cannot undo it. **Enable** brings it back.
  - **Bills**: make, pay and cancel in-house bills, and open PDFs.
  - **Finance**: the partner's balance, payouts and payout details.
  - Labs only: **Lab bookings** and **Slots**.
  - Clinics only: **Front desk** and **Doctors**.

A **Back to …** link at the top of each page returns you to the partner.

### Link a doctor to a clinic (Add doctor)

Only admins link doctors to clinics. Clinics cannot invite doctors.

1. Open the clinic, then **Doctors**.
2. Under **Add doctor**, search by the doctor's full name or speciality and tap **Search**. Only active, verified doctors are found.
3. Check the mobile number shown, then tap **Choose**.
4. Under **Consults at**, tick branches, or **Every branch, including ones added later**.
5. Tap **Continue**, then **Link …**.

The doctor can consult there at once (there is no acceptance step) and is told. The clinic needs a branch with **Consultations at the clinic** switched on first.

---

## 3. Lab bookings

This lists online bookings at every partner lab, newest first. Filter by **Lab** and **Status**. Open a booking to act on it as the lab's owner: collect, process, upload and release reports, propose a new time, reject with a refund, mark a no-show or reschedule a no-show (once).

When you release a report, choose who signs it under **Signed by**. The signer must be an owner or hold "Release reports", work at that branch, and have a professional registration number on their staff record.

---

## 4. Order cancellations

These are paid pharmacy orders that the customer or a pharmacy asked to cancel. Nothing moves until someone decides. Each request shows the pharmacy, customer, medicines and the order's earlier status.

- **Approve cancellation**: the order is cancelled, stock goes back and the customer is refunded. Online payments go to the customer's Jansetu wallet first. For cash or counter payments the refund is not automatic: you arrange it.
- **Keep the order**: write why (the customer sees it). The order carries on.

---

## 5. Refunds needing attention

These are pharmacy refunds that did not finish on their own. The **Why** column shows **Prescription rejected**, **Not collected**, **Refused at the door** or **Cancelled for held stock**.

- Waiting wallet credit: tap **Retry**, then **Retry now**.
- **Finance to review**: settled by finance outside this workspace.
- **Waiting for the payment provider**: nothing to do yet.

---

## 6. External cancellations

These are lab and doctor bookings with outside providers, where the cancellation at the provider is not confirmed. No refund is made until it is. Choose **Waiting for an admin** or **All open**.

If a case is "Still being retried automatically", act only if the provider has already told you the outcome. Otherwise, check with the provider first, then record one of:

- **Provider confirms cancelled…**: every provider booking for it is cancelled.
- **No booking at the provider…**: the provider never held a booking.

Either one releases the customer's refund. If the list changes while you look, check again and tap **I have checked the updated list**.

---

## 7. Settlements

This shows the balances Jansetu owes labs, clinics and doctors from online payments. Search by account name, or filter by **Account of**, **Payout details**, and **Only with a balance due**. Open an account to work on it.

### Verify payout details

Under **Payout details**, check the bank or UPI details outside Jansetu (a penny drop, or the account holder's documents). Then tap **Mark as verified** and **Yes, these details are verified**. You can also tap **Add payout details** or **Change payout details**. Any change must be verified again.

### Record a payout

Do this after you have made the transfer.

1. Under **Record a payout**, enter **Amount paid (₹)** (at most the balance) and choose **Paid by** (**Bank transfer**, **UPI** or **Other**).
2. Fill in **Bank reference (UTR)** and **Paid on (India date)**, plus a **Note** if needed.
3. Tap **Review the payout**, then **Record payout**.

You can record a payout only when the account is active, the details are verified and a balance is due. A payout cannot be deleted. A mistake is fixed by voiding it (section 8).

### Post an adjustment

1. Under **Post an adjustment**, choose **Add to the balance** or **Take from the balance (recovery)**.
2. Enter the **Adjustment amount (₹)** and **Reason (kept with the entry)**.
3. Tap **Review the adjustment**, then **Post adjustment**.

The account page also shows its **Payouts**, **Statement** (with CSV download), **Earlier history** (old payouts, for reference only) and **Finance events**.

---

## 8. Payouts

This lists every recorded payout, newest first. Filter by **Status** (**Recorded** or **Voided**) and paid dates. To undo a payout that did not reach the person, or came back, tap **Void**, give a reason, and tap **Void the payout**. The amount goes back to their balance. This cannot be undone.

---

## 9. Not in this workspace

- **Creating pharmacies:** only admins can create a pharmacy, but there is no screen for it here. Use the admin panel or ask the tech team.
- **Doctor accounts** (adding and verifying doctors), pharmacy details, coupons and other older sections: use the admin panel or ask the tech team.
- **Reschedule a doctor's no-show:** no screen here. The doctor does it from their own workspace.

---

## Good to know

- No-shows are never refunded and earn nobody anything. A no-show can be rescheduled only once.
- Part payments of bills happen only if the partner switches them on.
- Only admins create pharmacies and link doctors to clinics.
- A doctor can create one clinic of their own. It stays waiting until you verify it.
- Staff can sign in by email only after an owner (or you, as owner) adds it. A new account is never created from an email.
- Every change you make as owner is recorded as "Jansetu admin".
- Never record a payout or an external cancellation before you have checked it outside Jansetu. What you record moves real money.
- If you see "The outcome of this request is not known yet", tap the button to send the same request again. It is never recorded twice.

---

## Common questions

**A new lab says it can't use the workspace.**
It is waiting for verification. Open it in **Labs and clinics** and tap **Verify**.

**A clinic wants to add a doctor.**
Check the doctor, then use **Add doctor** on the clinic's **Doctors** page.

**Record payout is not shown for an account.**
Read the message there. Usually the payout details are not verified yet, or nothing is due.

**I recorded a payout with the wrong amount.**
**Void** it under **Payouts**, then record the right one.

**A lab owner lost their phone number.**
Open the lab, go to **Staff**, and add or change the owner's email so they can sign in by email.

**How do I add a pharmacy?**
Use the admin panel, or ask the tech team.

**A report cannot be released: "Nobody can sign this report."**
No staff member at that branch has a professional registration number on their record. Ask the tech team to add one.

---

## Need help?

Contact the Jansetu tech team. Tell them:

- the partner, booking, order or account name;
- what you tried, and the exact message on screen.

Jansetu tech team: (add phone and email here)
