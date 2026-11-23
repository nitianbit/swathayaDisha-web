# Jansetu Workspace: Admin Guide

**What you can do here:** add and verify labs and clinics, manage any of them with owner rights, link doctors to clinics, watch lab bookings, add and manage pharmacies, move a doctor's no-show, decide pharmacy order cancellations, fix stuck refunds and provider cancellations, and pay out labs, clinics and doctors.

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
- **Pharmacies**
- **Pharmacy wallets**
- **Consultations**
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
  - **Staff**: add owners and staff, permissions, professional registrations (report signers), branch access and sign-in emails.
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

If it says **Nobody can sign this report**, tap the **Staff** link in that message. On the signer's row tap **Add registration**, choose **Registered as**, type the **Registration number** and tap **Save registration**. Then go back to the booking and release the report.

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

## 9. Pharmacies

Only admins add pharmacies. This lists every pharmacy, newest first. Search by name, or filter by **Verification** and **Active**. To see which pharmacy signs in with a number, type it in **Find by mobile number** and tap **Find**.

### Add a pharmacy

1. Tap **Add a pharmacy**.
2. Fill in **Mobile number** (the pharmacy signs in with it) and **Pharmacy name**. Add **Email (optional)**, the owner's name, address, GST number and drug licence number if you have them. Tick **Pick up at the pharmacy** and **Get a delivery** if it offers them.
3. Tap **Add pharmacy**. Its page opens.

A new pharmacy is **Not verified**. Customers see it only once you verify it. Two pharmacies can never have the same mobile number. If the number is taken, the form names the pharmacy that has it.

If the answer does not arrive, the form locks and says it could not confirm. Then:

- Tap **Send again**. It sends the same request, so it can never create a second pharmacy. If it was created, its page opens.
- Or tap **Give up this create**. Then it can never be created, and you can change the form. If it had already been created, its page opens instead.

If the page reloads before you know, the page checks for you. If it was created, tap **Open …**. If not, tap **Give up this create**, then add it again.

### Open a pharmacy

Tap its name.

- **Verify**: customers can find it and order from it.
- **Deactivate**: it can no longer sign in, and customers no longer see it. Its orders and stock stay. **Activate** turns it back on.
- **Sign-in**: to change the mobile number or email it signs in with, tap **Change mobile number or email**, make the change, and tap **Continue**. Read what will change, then tap **Change sign-in**. The old number or email stops working for sign-in. To remove the email, empty its field. The mobile number cannot be removed. Do this only when the pharmacy asks and you have checked it is them.
- Changing the mobile number, or changing or removing the email, **signs the pharmacy out** everywhere. Tell them first. Adding a first email does not sign them out.
- **Details**: change the name, owner, address, licences, pickup and delivery, then tap **Save details**. To remove an optional detail, empty its field and save. The name cannot be removed.

If someone else changed the same thing while you were typing, nothing is saved and the form shows what is saved now. Check it and save again.

### Pharmacy wallets

**Pharmacy wallets** (also **Wallet and adding money** on a pharmacy's page) shows a pharmacy's Jansetu wallet and lets you add money to it, for stage testing or a support credit.

1. Type part of the pharmacy's name, tap **Search**, then **Open wallet**.
2. You see the **Money in the wallet**, whether it is **on hold** or **owes Jansetu** (after a disputed card payment), and recent money in and out, with the note of each admin credit.
3. Under **Add money**, type the **Amount to add (₹)** (whole rupees, 1 or more) and **Why is the money added?** (required, for example "stage testing" or "support credit").
4. Tap **Next: check before adding**, read the amount, the pharmacy and the note, then tap **Yes, add ₹…**.

**Do not use this to make up for a card top-up that never arrived. Ask the tech team to run the top-up check instead, or the pharmacy could be paid twice.**

- If the wallet owes Jansetu, the money added clears that first.
- A pharmacy with no wallet yet gets one when you add money.
- The review also shows the **last money added by an admin** to this wallet (amount, time and note). If it is the same credit, do not add it again.
- "The outcome of this request is not known yet": tap **Send the same request again**. The money is never added twice. Or tap **Check whether it was recorded**: it looks for exactly this credit.
- After a page reload, an unconfirmed credit can only be checked, not sent again. If you see "Only the latest … movements were searched", the credit may be older: ask the tech team before adding money again.
- **Forget it** needs you to tick "I understand the money may already have been added to this wallet". Forgetting does not undo a credit that was made.
- An admin credit can never be withdrawn by the pharmacy.

#### Card top-ups not credited

At the bottom of a pharmacy's wallet page, **Card top-ups not credited** lists that pharmacy's card top-ups that never reached the wallet: when, the amount, the state (**Paid, not credited**, or **Not checked with Razorpay**) and the payment reference.

**Use this only when Jansetu support already paid this amount to the pharmacy another way. The top-up can then never be credited.**

1. On the top-up's row, tap **Mark as already paid by hand**.
2. Type **Why is it closed?** (required, for example who at Jansetu support paid the pharmacy, how and when).
3. Tap **Next: check before closing**, read the amount, the date and the pharmacy, then tap **Yes, mark as already paid**.

- The top-up leaves the list and is never credited to the wallet, also not by a later card check.
- "This top-up was already credited, nothing to close": the money is in the wallet already. If support also paid by hand, ask the tech team.
- "This top-up was already refunded to the card, nothing to close": the pharmacy got its money back; nothing more to do.
- "The outcome of this request is not known yet": tap **Send the same request again** (it is closed only once), or **Check whether it was recorded**. After a page reload you can only check. **Forget it** is safe: a top-up already closed is never closed twice.
- "The admin tools are switched off on this server" or "The server needs an update": nothing was changed; ask the tech team.

---

#### Card refunds of bookings that need a person

At the bottom of the **Pharmacy wallets** page, **Card refunds of bookings that need a person** lists card or UPI refunds of consultations booked by pharmacies that did not go through on their own: when, the amount, why (who cancelled, or "Paid after the booking was released"), the state (**Refund to card failed**, **Held for a check**, or **Refund to card in progress** when it is still trying after 20 tries or a day) the pharmacy that paid, and a link to the booking. **Recheck** asks Razorpay about the refund now and says what Razorpay holds (no wallet money moves).

**Mark failed**: only for a card refund still in progress that Razorpay cannot complete. Tap **Mark failed**, write **Why is it marked failed?**, tap **Next: check before marking**, then **Yes, mark failed**. Jansetu reads Razorpay first: "Razorpay already has a refund of this payment" means the money is already going back to the card, so nothing changes. After it is marked failed you can move it to the wallet (below).

**Move to wallet**: only when the card refund cannot go through and the pharmacy agreed to take the money in its Jansetu wallet instead.
1. On the refund's row, tap **Move to wallet**.
2. Type **The pharmacy’s agreement**: who agreed, how and when. It is kept with the refund.
3. Tap **Next: check before moving**, read it, then tap **Yes, move to wallet**.
- The money is added to the pharmacy's wallet at once (it cannot be withdrawn) and the card refund is closed. A refund is never moved twice.
- "A card dispute was recorded on this payment": the bank already took the money back; it is never refunded.
- "Razorpay already has a refund of this payment": tap **Recheck**; the card refund is on its way, so nothing is moved.
- "The outcome of this request is not known yet": tap **Send the same request again** (it is moved only once), or **Check whether it was recorded**.
- Recording a lost card dispute on a booking payment is not in this workspace yet: ask the tech team.

## 10. Consultations

This lists doctor consultation bookings, latest appointment first. Filter by **Status**, by doctor (type part of the name, tap **Find doctor**, then choose them), and by **Appointments from** and **Appointments to**.

Each row shows the **Patient**: the family member's name if the booking is for one, otherwise the account holder's. The booking page shows it too. To see only missed appointments, set **Status** to **No-show**.

### Move a doctor's no-show

A no-show is not refunded and the doctor earns nothing for it. It can be moved once to a later time, at the same price.

1. Open the booking. **No-show** shows when it was missed, and any earlier move.
2. Tap **Reschedule no-show**.
3. Choose a **New day**, then a **New time**. Only that doctor's free times for the same kind of consultation are shown. If you see "That time belongs to another doctor", choose another time from the list.
4. Tap **Continue**, read the message, then tap **Move to …**.

The patient and the doctor are told the new time. If the new time is missed too, that no-show is final.

You cannot move:

- an instant consultation;
- an appointment booked at a clinic's front desk (the clinic moves it);
- a booking that was already moved once.

If the answer does not arrive, tap **Send the same move again** or **Check the booking**. A booking is never moved twice. If the time was just taken, choose another.

---

## 11. Not in this workspace

- **Doctor accounts** (adding and verifying doctors), coupons and other older sections: use the admin panel or ask the tech team.

---

## Good to know

- No-shows are never refunded and earn nobody anything. A no-show can be rescheduled only once.
- Part payments of bills happen only if the partner switches them on.
- Only admins create pharmacies and link doctors to clinics. Pharmacies cannot change their own sign-in mobile number or email: you do it on their page.
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
Open **Pharmacies** and tap **Add a pharmacy** (section 9).

**A pharmacy has a new mobile number.**
Open it in **Pharmacies**, then under **Sign-in** tap **Change mobile number or email**. This signs the pharmacy out; it signs in again with the new number.

**A report cannot be released: "Nobody can sign this report."**
No staff member at that branch has a professional registration number on their record. Tap the **Staff** link in the message and add one (section 3).

**A patient missed a doctor's appointment and wants a new time.**
Open it in **Consultations** and tap **Reschedule no-show** (section 10). It works only once.

---

## Need help?

Contact the Jansetu tech team. Tell them:

- the partner, booking, order or account name;
- what you tried, and the exact message on screen.

Jansetu tech team: (add phone and email here)
