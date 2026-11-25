# Jansetu Workspace: Lab Guide

**For:** lab owners and lab staff. **Website:** https://staff.swasthadisha.etryx.in

This guide says where things are. The names in it (Demo Diagnostics, Suresh Demo, Lab Desk Demo) are examples.

Some pages work only after Jansetu switches them on. Each section ends with a **Switch** line for the Jansetu team. "None" means the page always works. Until a switch is on, the page says "… is not switched on yet" or "… not open yet". Your other pages keep working.

---

## Sign in

1. Under **I am signing in as**, choose **Lab or clinic staff**.
2. Type your **Mobile number or email** and tap **Send code**. Email works only if your owner has added it for you.
3. Type the **6-digit code** and tap **Verify and sign in**.
4. Choose your lab (for example "Demo Diagnostics · Lab · Owner") and tap **Open workspace**.

A new lab opens once Jansetu has verified it. Until then Home says it "is waiting for verification by Jansetu".

## Where is what

**Owners** see every page. **Staff** see the pages their permissions allow. The owner gives permissions on **Staff**.

| Menu (section) | What is there | Staff need |
|---|---|---|
| Profile (Organisation) | Your lab's details and contact | everyone |
| Staff (Organisation) | Add staff and give permissions | Manage staff |
| Branches (Organisation) | Addresses, services, opening hours | Manage branches |
| Activity log (Organisation) | The latest 100 changes | Manage staff, all branches |
| Tests and packages (Billing) | What customers can book, and its prices | Manage tests and services, or Create invoices (view only) |
| Bills (Billing) | Bills made at your counter | Create invoices, Cancel invoices, Record payments or View finance |
| Finance (Billing) | Money Jansetu collected for you and paid out | View finance, all branches |
| Lab bookings (Lab) | Tests booked in the app, at your desk, or by pharmacies and doctors | View bookings, Manage bookings, Upload reports or Release reports |
| Front desk (Lab) | Book tests for a patient at your lab | Manage bookings |
| Book consultation, Booked consultations (Lab) | Book a doctor for a patient at your lab | Book doctor consultations for patients |
| Wallet (Lab) | Add money; withdraw card money | View the wallet or Add money to the wallet |
| Referral earnings (Lab) | What you earn for consultations you book | View finance, all branches |
| Slots (Lab) | Times customers can book | Manage slots, View bookings or Manage bookings |

"All branches" means the owner, or staff given **All branches, including new ones**.

---

## Organisation: Profile, Staff, Branches, Activity log

- **Profile**: your contact details, and **Allow part payments of bills**. Only an owner can change them. Jansetu changes registration and tax details.
- **Staff**: **Add a staff member** with name, mobile number, role, permissions and branches. On a row: **Edit permissions**, **Change branch access**, **Add registration** (for the person who signs reports), or remove them. You can give only permissions you hold yourself.
- **Branches**: **Add a branch** with its address, services (home sample collection, walk-in), opening hours and holidays.
- **Activity log**: who changed what, newest first.

**Switch:** none.

## Tests and packages

Your tests and packages with their prices. These are what customers book and what appear on bills.

- **Add an item**: name, code, price, MRP, GST rate, where it is offered, report time. Then **Add item**.
- On a row: **Edit**, **Deactivate** or **Reactivate**. Price changes apply at once.

**Switch:** none.

## Bills

Bills made at your counter, newest first.

1. Tap **New bill**, choose the branch and customer.
2. Add items **From the catalogue** (your tests and packages), or **Add a line by hand**.
3. Tap **Review the bill**, then **Issue bill**.

On a bill: **Record payment**, **Cancel bill**, **Open PDF**.

**Switch:** none.

## Finance

Money Jansetu collected online for your lab, and what it paid out. Bills paid at your counter are not part of it.

- **Balance**, **Statement** (with **Download CSV**), **Payouts**.
- **Where payouts are sent**: **Add payout details**. Owners only.

**Switch:** none.

---

## Lab bookings

Every test booking, by slot time: from the app, from your front desk, and from pharmacies and doctors who book for patients.

- **Show** upcoming or past bookings; filter by branch and status.
- Open a booking to move it along: **Mark sample collected** or **Mark visited**, **Start processing**, **Upload as drafts**, **Release** the report, **Complete booking**.
- Also: **Propose a new time**, **Assign collector**, **Mark no-show**, **Reject booking**.
- A front-desk booking also has **Make bill** and **Cancel this booking**.

**Switch:** none. Bookings from pharmacies need `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY`; from doctors, `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR`.

## Slots

Times customers can book, per branch and visit type.

- **Edit the weekly template**, then **Review the template** and **Save the template**.
- **Add a one-off slot**.
- On a slot: **Change seats**, **Close** or **Reopen**.

**Switch:** none.

## Front desk

Book tests for a patient at your lab. The patient pays at the lab; you make the bill from the booking.

1. **1. Patient**: type the **Patient's mobile number**, tap **Find**, tick **Patient agreed to this booking**, then **Next: choose the tests**.
2. **2. Tests and time**: choose **Walk-in now**, **Lab visit at a time** or **Home collection**, the branch and the tests.
   - **Have a test code from the doctor?** Type the code from the prescription (for example ABCD-EFGH) and tap **Load tests**. The recommended tests are ticked for you.
3. **3. Check the total**: tap **Yes, book for …**.

Then **Make bill**, **Open the booking** or **Book for another patient**.

**Switch:** `LAB_DESK_ENABLED`. The test code needs `TEST_RECOMMENDATIONS_ENABLED` (without it the code field is not shown).

## Book consultation

Book a doctor for a patient at your lab. You pay Jansetu from the lab's wallet (or by card or UPI). You collect the fee from the patient.

1. **1. Patient**: find the patient by mobile number.
2. **2. Doctor and time**: choose the branch, a speciality, a doctor and a time. Tap **Next: check the price**.
3. **3. Check and pay**.

**Booked consultations** lists what your lab booked. Open one to cancel it, join the call or see the prescription.

**Switch:** `ASSISTED_BOOKING_ENABLED_LAB`. Paying by card or UPI also needs `ASSISTED_CARD_PAYMENT_ENABLED`.

---

## Wallet

Your lab's wallet pays for the consultations your lab books for patients.

- **Balance**: the money in your wallet, and its **Card money**.
- **Add money**: type the **Amount to add (₹)** and tap **Top up**. You pay by card or UPI. Tap **Check my top-up** if a payment is not confirmed.
- **Withdraw to bank**: only card money can be withdrawn. Type the **Amount to withdraw (₹)**, tap **Next: see the fee**, then **Withdraw …**. You need all branches for this. Until withdrawals are switched on, it says "Withdrawals to your bank are not open yet. Your wallet keeps paying for bookings as before."

**Switch:** adding money needs `ASSISTED_BOOKING_ENABLED_LAB`. Withdrawals need `WALLET_WITHDRAWALS_ENABLED`.

## Referral earnings

What your lab earns for the consultations it books for patients. It comes out of the doctor's earning, not from the patient.

- **Earnings**: due to you, earned, paid to you.
- **Your rates**: set by Jansetu.
- **Statement**: a date range and CSV.

**Switch:** `REFERRAL_CUTS_ENABLED`. Payouts need `REFERRAL_PAYOUTS_ENABLED` (until then: "Payouts start once Jansetu switches them on.").

---

## Need help?

Contact the Jansetu team. Tell them your lab name, the page you were on, and the exact message on screen.
