# Jansetu Workspace: Pharmacy Guide

**For:** pharmacy staff. **Website:** https://staff.swasthadisha.etryx.in

This guide says where things are. The names in it (Demo Pharmacy, Asha Demo, Dr Kavya Demo) are examples.

Some pages work only after Jansetu switches them on. Each section ends with a **Switch** line for the Jansetu team. "None" means the page always works. Until a switch is on, the page says "… is not switched on yet" or "… not open yet". Your other pages keep working.

---

## Sign in

1. Under **I am signing in as**, choose **Pharmacy staff**.
2. Type your pharmacy's **Mobile number or email** and tap **Send code**.
3. Type the **6-digit code** and tap **Verify and sign in**.

Only the Jansetu team adds a pharmacy or changes its mobile number. Your menu is on the left, under **Pharmacy**. **Sign out** is at the bottom.
On a phone, **Home** and **Menu** are the two buttons at the top. Tap **Menu** for every other page; it closes when you open one.

## Your home

Home is your counter. At the top are four big buttons:

| Button | What it does |
|---|---|
| **+ New** | Start a visit: the patient first, then what they need |
| **Find patient** | The same first step, to find someone and see today's visits |
| **Sell medicines** | Open New sale |
| **Today** | Everything of the day |

Under them:

- **Collected today ₹…**: money received today. The next line shows only the ways money came in (cash, UPI, card, wallet). **To collect ₹…** is money still owed by patients (in orange when it is more than ₹0). A refund made today has its own line.
- **Waiting for you**: prescriptions to review, unpaid sales, doctor bookings and lab tests waiting for payment, lab reports ready, medicines low in stock. Tap a line to open it.
- **Today's register**: the latest 10 entries, newest first, each with its time, the patient, what it was, the amount and whether it is paid. Tap an entry to open it. **See all of today** opens the Today page.
- **My to-dos** (see below).

**Switch:** none for Home, Today and to-dos. Each choice under + New needs the switch of its own page (below).

## + New: a visit, step by step

1. Tap **+ New**. Type the patient's **mobile number** (or a name) and tap **Find**.
2. The page says **This number is on Jansetu**, with the owner's name partly hidden, or **This number is new to Jansetu**.
3. Tap **This person** and type their name. Or tap **Someone else (family member)** for a child or parent who uses this phone: type their name and the relation. For a new number, type the number again.
4. Tap **Next**. Choose what they need: **See a doctor now (video)**, **Book a doctor for later**, **Book a lab test** or **Sell medicines**.
5. That page opens with the patient already filled in (**Patient: Asha Demo · 98…**). Tick **Patient agreed to this booking** and carry on. **Change** goes back to step 1 with the number kept.

**Same patient again** (small, under the number box) appears for 30 minutes after a visit, for a second thing for the same person.

**Example, medicines in cash:** + New → number → **Find** → **This person** → name → **Next** → **Sell medicines** → tick the agreement → find the medicine → **Add** → **Next: check the sale** → **Create sale** → **Cash** → **Mark paid** → **Yes, it is paid** → **Done**.

## Today

The whole day's register, newest first, 50 at a time (**Show more**). Pick another **Day** to see an earlier day. **Search the day** finds a visit by name, phone (4 or more digits) or reference. The money and waiting lines are the same as on Home.

**Switch:** none.

## To-dos

At the bottom of Home. Type a to-do and tap **Add**; tick it when done. Everyone at your pharmacy sees the same list, with who added each one.

**Switch:** none.


## Where is what

| Menu | What is there |
|---|---|
| Home | Your counter: big buttons, today's money and register, to-dos |
| Today | Every entry of a day, with search |
| New sale | Sell medicines at your counter |
| Orders | Orders from the app and from your counter |
| Prescription review | Orders waiting for a pharmacist's check |
| Stock, Suppliers, Low stock, Quality | Your medicines, batches and suppliers |
| Book consultation, Booked consultations | Book a doctor for a patient at your counter |
| Consult now | Connect a patient with a doctor who is online now |
| Book lab test, Booked lab tests | Book a lab test for a patient at your counter |
| Wallet | Add money; the wallet pays for what you book |
| Finance | Withdraw card money to your bank; referral earnings |
| Settings | The pharmacist who approves prescriptions |

---

## New sale

Sell medicines at the counter.

1. **Customer**: choose **A customer of your pharmacy** and search by name or phone. Or choose **Walk-in customer** and type the name and mobile number. Tick that the customer agreed to be added.
2. **Medicines**: use **Find a medicine in your stock** and set each quantity. You can attach a prescription photo or PDF.
3. Tap **Next: check the sale**, then **Create sale**.
4. Under **Payment at the counter**, tap how they paid (**Cash**, **UPI** or **Card**; nothing is chosen for you), then **Mark paid**.

If a medicine needs a prescription, the pharmacist approves it first (**Review the prescription**). After the sale you can print the bill or start a new sale.

**Switch:** none.

## Orders and Prescription review

- **Orders**: open an order to move it to the **Next step**, **Record payment**, or report a **Delivery problem**.
- **Prescription review**: open an order, check the prescription documents, then **Approve** or **Reject…**.

**Switch:** none.

## Stock, Suppliers, Low stock, Quality

- **Stock**: find a medicine to see its batches. **Add stock**, or **Import stock from a file**.
- **Suppliers**: **Add supplier**, edit or archive one.
- **Low stock**: medicines at or below their reorder level.
- **Quality**: orders holding held stock (**Swap to good stock**), batches on hold, and returns to suppliers.

**Switch:** none.

---

## Book consultation

Book a doctor for a patient at your counter. You pay Jansetu from your wallet (or by card or UPI). You collect the fee from the patient.

1. **1. Patient**: type the **Patient's mobile number**, tap **Find**, and choose who the patient is.
2. **2. Doctor and time**: choose a **Speciality**, a doctor and a time.
3. **3. Check and pay**: **Pay from wallet** or **Pay by card or UPI**.

**Booked consultations** lists what you booked, newest first. Open one to cancel it, join the call or see the prescription.

**Switch:** `ASSISTED_BOOKING_ENABLED_PHARMACY`. Paying by card or UPI also needs `ASSISTED_CARD_PAYMENT_ENABLED`.

## Consult now

Connect a patient at your counter with a doctor who is online now.

1. **1. Patient**: find the patient by mobile number.
2. **2. Doctor**: choose what the patient needs, then a doctor or **Any available doctor (the first to accept)**.
3. Tap **Pay … from wallet and request**.

Keep the screen open while you wait. If no doctor accepts, the money comes back to your wallet. You can **Ask again** or **Cancel and refund**. When a doctor accepts, tap **Open the booking**.

**Switch:** `ASSISTED_BOOKING_ENABLED_PHARMACY` and `ASSISTED_INSTANT_ENABLED`.

## Book lab test

Book a lab test for a patient at your counter. Jansetu takes the price from your wallet; you collect it from the patient.

1. **1. Patient**: find the patient by mobile number.
2. **2. Lab, tests and time**: choose where the sample is taken, the lab, its **Branch**, the tests and a time.
   - **Have a test code from the doctor?** Type the code from the prescription (for example ABCD-EFGH) and tap **Load tests**. The recommended tests are ticked for you.
3. **3. Check and pay**.

**Booked lab tests** lists what you booked. Open one to see its time, cancel it (up to 1 hour before), accept a new time from the lab, or read the report.

**Switch:** `ASSISTED_BOOKING_ENABLED_PHARMACY` and `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY`. The test code needs `TEST_RECOMMENDATIONS_ENABLED`.

---

## Wallet

Your wallet pays for the consultations and lab tests you book for patients.

- **Balance**: the money in your wallet.
- **Add money**: type the **Amount to add (₹)** and tap **Top up**. You pay by card or UPI. A payment not yet confirmed shows under **Top-ups not confirmed yet**; tap **Check my top-up**.
- **Wallet history**: every money movement.

To withdraw money, open **Finance**.

**Switch:** none for adding money. The ₹50,000 limit on top-ups applies only with `WALLET_BALANCE_CAP_ENABLED`.

## Finance: withdrawals and referral earnings

**Finance** shows your wallet, its card money and your referral earnings in one place.

- **Balance**: your wallet balance, your **Card money** (card top-ups not spent yet) and **Referral earned**.
- **Withdraw to bank**: only card money can be withdrawn. Type the **Amount to withdraw (₹)**, tap **Next: see the fee**, then **Withdraw …**. Your requests are listed under **Your withdrawals**. Add your bank account or UPI ID first under **Payout details**.
- Until withdrawals are switched on, it says "Withdrawals to your bank are not open yet. Your wallet keeps paying for bookings as before."
- **Statement**: choose **Wallet** or **Referral earnings** and a date range.
- **Referral earnings**: what you earn for the bookings you make for patients, and your rates. It comes out of the doctor's or lab's earning, not from the patient.

**Switch:** withdrawals need `WALLET_WITHDRAWALS_ENABLED`. Referral earnings need `REFERRAL_CUTS_ENABLED`. Paying them out needs `REFERRAL_PAYOUTS_ENABLED` (until then: "Payouts are paused for now").

## Settings

The **Pharmacist** whose name and registration number are recorded on every prescription approval.

**Switch:** none.

---

## Need help?

Contact the Jansetu team. Tell them your pharmacy name, the page you were on, and the exact message on screen.
