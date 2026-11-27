# Jansetu Workspace: Doctor Guide

**For:** doctors. **Website:** https://staff.swasthadisha.etryx.in

This guide says where things are. The names in it (Dr Kavya Demo, Dr Arjun Skin Clinic, Asha Demo) are examples.

Some pages work only after Jansetu switches them on. Each section ends with a **Switch** line for the Jansetu team. "None" means the page always works. Until a switch is on, the page says "… is not switched on yet" or "… not open yet". Your other pages keep working.

---

## Sign in

1. Under **I am signing in as**, choose **Doctor**.
2. Type your **Mobile number or email** and tap **Send code**. Email works only if the Jansetu team has added it.
3. Type the **6-digit code** and tap **Verify and sign in**.

Your first sign-in with a new mobile number creates your doctor account. Patients can book you, and you can take instant consultations, once Jansetu has verified you. **Home** shows **Verified** or **Waiting for verification**.
On a phone, **Home** and **Menu** are the two buttons at the top. Tap **Menu** for every other page; it closes when you open one.

## Your home

Home is your whole day in one place. At the top are the big buttons **+ New**, **Find patient**, **Today**, and **Bills** (only when you own a clinic that is verified).

Under them:

- **Today's appointments** in time order, from every place: your clinics, online, and those booked for you by pharmacies and labs. The chips **All**, each clinic, **Online** and **Booked by partners** filter the list. When today is empty, your next appointment is shown.
- **Waiting for you**: prescriptions to write, appointments waiting, lab reports ready, unpaid bills. Tap a line to open it.
- **Earned today ₹…**, and your own clinic's money when it has bills that day.
- At your own clinic, a desk appointment's row has **Bill**: it opens the short bill with your fee on it.
- **My to-dos**: only you see them.

If Jansetu has not verified you yet, Home shows your status and your to-dos only.

**Switch:** none for Home, Today and to-dos.

## + New: book for a patient

1. Tap **+ New**. Type the patient's **mobile number** and tap **Find**. The page says whether the number is on Jansetu.
2. Tap **This person** or **Someone else (family member)**, then **Next**.
3. Choose **Clinic appointment**, **Online consultation (video or call)**, **Lab test** or **Follow-up**.
   - **Clinic appointment**: tap the clinic, a day and a free time, then **Book 17:00 on Fri, 27 Nov, 2026 at …**. It appears in that clinic's reception list; the patient pays at the clinic.
   - **Online consultation**: tap **Video** or the phone call, a day and a free time, then **Book …**. The patient pays in the Jansetu app within 30 minutes.
   - **Lab test**: your Book lab test page, with the patient filled in.
   - **Follow-up**: your completed consultations with that number in the last 14 days.

If a booking's answer is lost, **Send again** sends the same request; **Check whether it was booked** looks it up.

## Today

The whole day, newest first, with search by name, phone (4 or more digits) or reference.

**Switch:** none.

## To-dos

At the bottom of Home. Type a to-do and tap **Add**; tick it when done. Your to-dos are private: only you see them.

**Switch:** none.


## Where is what

Your menu is on the left, under **Doctor**.

| Menu | What is there |
|---|---|
| Home | Your day: big buttons, today's appointments, what waits, earnings, to-dos |
| Today | Every entry of a day, with search |
| Consult now | Go online and accept instant consultations |
| Appointments | Your consultations; a patient's records |
| Schedule | Weekly hours and leave days |
| Clinics | Clinics you consult at; create your own clinic |
| Bills, Services and prices | The way to your own clinic's bills and prices |
| Earnings | What you earned, payouts, payout details |
| Wallet | Add money; withdraw card money |
| Book lab test, Lab tests booked | Book a lab test for your patient |

---

## Consult now

1. Tick the **Consultation types you take now** (video, phone call, chat) and enter **Your fee for an instant consultation (₹)**.
2. Tap **Go available now**. Keep a workspace page open and visible: you stop getting offers soon after it is closed.
3. Offers appear under **Offers for you**, each for 5 minutes. Tap **Accept…**, then **Accept and start**.
4. Under **Instant consultations today** you can **Extend** a consultation.

To stop, tap **Stop being available**.

**Switch:** none.

## Appointments

Your consultations, booked and instant. **Show**: today, the next days, or one day. Times are India time.

On an appointment: **Confirm**, **Join the call**, **Mark completed**, **Patient did not come**, **Cancel**, **Patient's records**, **Book lab test for this patient**.

**Switch:** none.

## Patient records

Open **Patient's records** on an appointment.

- **Your consultations with this patient** are always shown.
- To see their prescriptions from other doctors and their lab reports, tap **Ask the patient to see their other records**, then **Yes, ask the patient**. The account holder answers in the Jansetu app. The request ends after 24 hours.
- While you wait: "Waiting for the patient to answer in the Jansetu app". Tap **Check again**.
- Once allowed, the records are listed with **Open**. Every record you open is logged.

**Switch:** `RECORDS_ACCESS_ENABLED`. Until then only your own consultations are shown.

## Schedule

- **Change weekly hours**: set the slot length, **Add a window** for each day, choose its place (online, your own place, or a clinic) and the consultation types. Then **Review the weekly hours** and **Save the weekly hours**.
- **Leave days**: **Add a leave day**. Nobody can book you that day.

**Switch:** none.

## Clinics

- **Clinics you consult at**: the clinics the Jansetu team has linked you to. **Leave** to stop consulting at one.
- **Your own clinic**: if you are verified, fill in the clinic and its first branch and tap **Create my clinic**. It waits for Jansetu to verify it.

**Switch:** none.

## Bills and Services and prices

Your clinic's bills and prices are in your clinic's workspace, not here.

- **No clinic yet**: the page says "You have no clinic of your own yet". Tap **Create your clinic**.
- **Clinic not verified yet**: the page says "Jansetu has not verified your clinic yet."
- **To open them**: tap **Sign out and open my clinic's workspace**. Sign in as **Lab or clinic staff** with the same mobile number and choose your clinic. You land on its **Bills**. See the Clinic guide.

**Switch:** none.

---

## Earnings

What you earned through Jansetu and what was paid out. You earn for a consultation once it is completed.

- **Balance**, **Statement** (choose the dates; **Download CSV**), **Payouts**.
- **Where payouts go**: **Add payout details** (bank or UPI). Jansetu verifies every change.
- **Referral earned**: what you earn for lab tests you book for patients.
- **Withdrawals to the bank**: shows "Not open yet" until withdrawals are switched on.

**Switch:** none for earnings. Referral earnings need `REFERRAL_CUTS_ENABLED` and `REFERRAL_DOCTOR_CUTS_ENABLED`. Paying them out needs `REFERRAL_PAYOUTS_ENABLED`.

## Wallet

Your wallet pays for the lab tests you book for patients. It opens once you are verified.

- **Add money**: type the amount and tap **Top up**. You pay by card or UPI.
- **Withdraw to bank**: only card money can be withdrawn. Add your payout details on **Earnings** first. Until withdrawals are switched on, it says "Withdrawals to your bank are not open yet. Your wallet keeps paying for bookings as before."

**Switch:** adding money needs `ASSISTED_BOOKING_ENABLED_DOCTOR`. Withdrawals need `WALLET_WITHDRAWALS_ENABLED`.

## Book lab test

Book a lab test for your patient. Jansetu takes the price from your wallet; you collect it from the patient.

1. Start from an appointment (**Book lab test for this patient**), or open **Book lab test** and find the patient by mobile number.
2. Choose the lab, branch, tests and a time. On **Book lab test** you can also type a recommended-tests code and tap **Load tests**.
3. Check and pay.

**Lab tests booked** lists what you booked. Open one to see its time, cancel it or read its report.

**Switch:** `ASSISTED_BOOKING_ENABLED_DOCTOR` and `ASSISTED_LAB_BOOKING_ENABLED_DOCTOR`. Codes for recommended tests (printed on your prescription) need `TEST_RECOMMENDATIONS_ENABLED`.

---

## Need help?

Contact the Jansetu team. Tell them your name, the appointment date and time if there is one, and the exact message on screen.
