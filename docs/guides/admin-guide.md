# Jansetu Workspace: Admin Guide

**For:** the Jansetu team. **Website:** https://staff.swasthadisha.etryx.in

This guide says where things are. The names in it (Demo Admin, Demo Diagnostics, Demo Care Clinic, Demo Pharmacy, Dr Kavya Demo) are examples.

Some features work only after a switch is on in the backend `.env` (the value must be exactly `true`). Each section ends with a **Switch** line. "None" means it always works. All switches are listed at the end.

---

## Sign in

1. Under **I am signing in as**, choose **Admin**.
2. Type your **Mobile number or email** and tap **Send code**.
3. Type the **6-digit code** and tap **Verify and sign in**.

## Where is what

Your menu is on the left, under **Admin**.

| Menu | What is there |
|---|---|
| Labs and clinics | Add, verify and suspend labs and clinics; manage one as its owner; link doctors to clinics; lab referral cuts and wallets |
| Lab bookings | Online bookings at every lab |
| Pharmacies | Add and verify pharmacies; their referral cuts |
| Pharmacy wallets | A pharmacy's wallet; add money; card refunds that need a person |
| Doctors | Verify doctors |
| Consultations | Doctor bookings; move a no-show once |
| Order cancellations | Paid pharmacy orders someone asked to cancel |
| Refunds needing attention | Pharmacy refunds that did not complete |
| External cancellations | Lab and doctor cancellations not confirmed at the provider |
| Settlements | What Jansetu owes labs, clinics and doctors; record a payout |
| Payouts | Payouts recorded; void a mistake |
| Withdrawals | Wallet withdrawal requests to pay |
| Card disputes | Card top-ups whose dispute was lost |

---

## Labs and clinics

- **Add a lab or clinic**: choose **Lab** or **Clinic**, fill in the details and the **First owner**, then **Create**.
- Open one to **Verify**, **Suspend** or **Reinstate** it.
- **Manage as owner**: open any of its pages (Profile, Staff, Branches, Tests and packages or Services and prices, Bills, Finance, and for a lab Lab bookings, Slots, Front desk, Wallet; for a clinic Front desk and Doctors).
- A lab's **Referral cuts**: the cut per category (**Off**, a percent, or a fixed amount), then **Save**. A **History** list follows.
- A lab's **Wallet**: balance, **Add money**, card top-ups, **Put on hold**.

**Switch:** none. Referral cuts are applied only with `REFERRAL_CUTS_ENABLED` (until then: "Referral cuts are switched off; rules are saved but not applied."). A wallet hold needs `ASSISTED_ADMIN_TOOLS_ENABLED`.

## Add a doctor to a clinic

1. **Labs and clinics** › open the clinic › **Doctors**.
2. Under **Add doctor**, **Find a doctor** by name or speciality and tap **Choose**. Only verified, active doctors are found.
3. Choose where they consult (**Consults at**: branches, or every branch), tap **Continue**, then **Link …**.

The doctor is told; there is no acceptance step. The clinic's front desk can then book them.

**Switch:** none.

## Doctors: verify a doctor

Doctors create their account by signing in as **Doctor** for the first time. Then they appear here.

1. Open the doctor. Check the name, registration number, speciality and degree.
2. Tap **Verify**, then confirm. To take it back, tap **Unverify**.

The doctor page also links to the doctor's **Wallet** and consultations.

**Switch:** none.

## Pharmacies and Pharmacy wallets

- **Pharmacies**: **Add a pharmacy**, find one by mobile number, **Verify**, change its mobile number or email, and its **Referral cuts**.
- **Pharmacy wallets**: find a pharmacy, **Open wallet**, **Add money** (with a reason), card top-ups, and card refunds of bookings that need a person (**Recheck**, **Mark failed**, **Move to wallet**).

**Switch:** none. Referral cuts as above. Card payment of bookings needs `ASSISTED_CARD_PAYMENT_ENABLED`.

---

## Lab bookings and Consultations

- **Lab bookings**: online bookings at every lab. Open one to act as the lab's owner.
- **Consultations**: doctor bookings. Open one to move a no-show once, cancel it, or **Close and refund** when the doctor is not verified or not active.

**Switch:** none.

## Order cancellations, Refunds needing attention, External cancellations

- **Order cancellations**: **Approve cancellation** or **Keep the order**.
- **Refunds needing attention**: **Retry** a pharmacy refund that did not complete.
- **External cancellations**: **Provider confirms cancelled…** or **No booking at the provider…**. No refund is made until then.

**Switch:** none.

## Settlements and Payouts

- **Settlements**: open an account to verify its payout details, **Record a payout** or **Post an adjustment**.
- **Payouts**: every payout recorded. **Void** one recorded by mistake.

**Switch:** none. Referral accounts show "Paused until tax advice" until `REFERRAL_PAYOUTS_ENABLED` is on.

## Withdrawals

Requests from pharmacies, labs and doctors to withdraw card money to their bank, oldest first.

1. Pay the request by bank transfer or UPI.
2. Tap **Mark paid** and type the bank's reference.

Also **Reject**, **Void**, or **Open wallet**.

**Switch:** `WALLET_WITHDRAWALS_ENABLED` for new requests. Until then they see "not open yet". The smallest withdrawal is ₹500 (`WALLET_WITHDRAWAL_MIN_MINOR`, in paise).

## Card disputes

Card top-ups whose payment was disputed and lost. **Show**: to recover, recovered, never credited. Tap **Recover the money** to take it back from the wallet.

**Switch:** lab and doctor top-ups always come here. Pharmacy top-ups come here only with `WALLET_CHARGEBACK_FLAG_ONLY`; without it the money is taken back at once.

---

## All switches

| Switch | What it turns on |
|---|---|
| `ASSISTED_BOOKING_ENABLED_PHARMACY` | Pharmacy: Book consultation; also needed for Consult now and Book lab test |
| `ASSISTED_INSTANT_ENABLED` | Pharmacy: Consult now |
| `ASSISTED_LAB_BOOKING_ENABLED_PHARMACY` | Pharmacy: Book lab test |
| `ASSISTED_BOOKING_ENABLED_LAB` | Lab: Book consultation, and adding money to the lab wallet |
| `LAB_DESK_ENABLED` | Lab: Front desk |
| `ASSISTED_BOOKING_ENABLED_DOCTOR` | Doctor: adding money to the wallet; also needed for Book lab test |
| `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR` | Doctor: Book lab test |
| `TEST_RECOMMENDATIONS_ENABLED` | Recommended-tests codes on prescriptions, and **Load tests** |
| `ASSISTED_CARD_PAYMENT_ENABLED` | Paying for a booking by card or UPI |
| `RECORDS_ACCESS_ENABLED` | Doctors asking to see a patient's other records |
| `WALLET_WITHDRAWALS_ENABLED` | New withdrawal requests (pharmacy, lab, doctor) |
| `REFERRAL_CUTS_ENABLED` | Referral earnings on new bookings |
| `REFERRAL_DOCTOR_CUTS_ENABLED` | Referral earnings for doctors who book |
| `REFERRAL_PAYOUTS_ENABLED` | Paying referral earnings out |
| `WALLET_BALANCE_CAP_ENABLED` | The ₹50,000 limit on a pharmacy's card top-ups |
| `WALLET_CHARGEBACK_FLAG_ONLY` | Lost disputes on pharmacy top-ups go to Card disputes |
| `ASSISTED_ADMIN_TOOLS_ENABLED` | Admin wallet tools (hold, move or dismiss) |
| `ASSISTED_RECONCILIATION_ENABLED` | The daily money check |
| `SMS_NOTICES_ENABLED` | Booking text messages (not sign-in codes) |

Pages not in this table need no switch: New sale, orders, stock, bills, tests and packages, services and prices, lab bookings, slots, clinic front desk, doctor Consult now, appointments, schedule, earnings, the customer's Consult now, and the admin pages above.
