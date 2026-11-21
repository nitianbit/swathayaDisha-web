# Jansetu Workspace: Clinic Guide

**What you can do here:** run your clinic's front desk. Book walk-in and phone patients with your doctors, check them in, make bills at the counter, and manage your staff, branches, services and prices.

Website: **https://staff.swasthadisha.etryx.in**. Patients can also book your doctors online in the Jansetu app or at https://swasthadisha.etryx.in.

---

## 1. Sign in

1. Open the website.
2. Under **I am signing in as**, choose **Lab or clinic staff**.
3. Type your **Mobile number or email**. Email works only if the clinic owner has added it to your staff record.
4. Tap **Send code**, type the 6-digit code from the SMS or email, and tap **Verify and sign in**.
5. If your number works for several labs or clinics, choose your clinic and tap **Open workspace**.

**Doctors linked to the clinic** sign in the same way: choose **Lab or clinic staff** and use your mobile number, or an email the owner has set for you. Your doctor tools (Consult now, Appointments, Schedule) are under the **Doctor** sign-in instead.

A new clinic shows "…is waiting for verification by Jansetu". The workspace opens once Jansetu has verified it. This includes a clinic a doctor created for themselves.

### Who sees what

**Owners** see every page. **Staff** see only the pages their permissions allow.

| Menu item (section) | Who sees it |
|---|---|
| Profile (Organisation) | Everyone |
| Staff (Organisation) | Permission "Manage staff" |
| Branches (Organisation) | "Manage branches" |
| Activity log (Organisation) | "Manage staff", with access to all branches |
| Price list (Billing) | "Manage tests and services" or "Create invoices" |
| Bills (Billing) | "Create invoices", "Cancel invoices", "Record payments" or "View finance" |
| Finance (Billing) | "View finance", with access to all branches |
| Front desk (Clinic) | "View bookings" or "Manage bookings" |
| Doctors (Clinic) | "Manage staff", "View bookings", "Manage bookings" or "Create invoices" |

A desk person usually needs **Manage bookings**, **Create invoices** and **Record payments**.

---

## 2. Profile

**Profile** shows your clinic's type, status (**Verified**, **Waiting for verification** or **Suspended**), GSTIN, PAN, tax type, invoice prefix and number of owners.

- **Owners** can change **Contact details** (**Display name**, **Legal name**, **Contact phone**, **Contact email**) and tap **Save**.
- Registration and tax details are changed by Jansetu.

### Payments at the counter (owners only)

- **Off** (the starting setting): "Full payment only". Each payment must clear everything still due. It can still be split across methods, such as cash and UPI.
- **On**: tick **Allow part payments of bills** and tap **Save payment setting**. A bill can then be paid in several smaller payments.

---

## 3. Staff

**Add desk staff** (owners, or staff with "Manage staff"):

1. Tap **Add a staff member**.
2. Fill in **Name** and **Mobile number**. Only owners see **Email (optional)**. With an email, the person can also sign in by email.
3. Choose **Role**: **Staff**, or **Owner** (only owners can add owners).
4. Tick their permissions (for example **Manage bookings**, **Create invoices**, **Record payments**) and their branches. Tick **All branches, including new ones**, or pick branches. You can give only permissions you hold yourself.
5. Tap **Add staff member**.

On each row you can use **Edit permissions**, **Change branch access**, **Add email** / **Change email**, or **Remove**.

- Only owners change permissions and sign-in emails.
- Changing or removing someone's email signs them out of the workspace.
- You cannot remove yourself or the last owner.

---

## 4. Branches

1. Tap **Add a branch** (owners and all-branch managers).
2. Fill in **Branch name**, **Phone**, address and **State code** (the GST state code, for example 29).
3. Under **Services**, tick **Consultations at the clinic**. Without it, the desk cannot book at this branch.
4. Set **Opening hours** and **Holidays**, then tap **Add branch**.

Use **Edit** to change a branch. **Deactivate** stops it taking bookings. **Reopen** is under **Closed branches**.

---

## 5. Price list (services and prices)

The page is called **Services and prices**. These items appear on your bills.

1. Tap **Add an item**.
2. Choose **Type**: **Consultation**, **Procedure**, **Package** or **Other**.
3. Fill in **Name** and **Price (₹)**. Add **Code**, **MRP**, **GST rate**, **SAC**, **Description** or **Preparation** if you like. Packages can list what they include.
4. Tap **Add item**.

**Edit** changes an item, and price changes apply at once. **Deactivate** takes it off (old bills keep it). **Reactivate** it later from Status: **Deactivated**. An item marked **Disabled by Jansetu** cannot be billed until Jansetu enables it. A clinic not registered for regular GST can bill only 0% GST.

---

## 6. Front desk (your daily screen)

Open **Front desk**. Choose the **Branch**, the **Day** (or tap **Previous day**, **Today**, **Next day**) and, if you like, one **Doctor**. You see:

- **Appointments on …**: every appointment that day, desk and online.
- **Free slots**: the chosen doctor's free in-clinic times.

### Appointment statuses

| Status | What it means |
|---|---|
| Booked | A confirmed appointment. **Arrived** shows once checked in. |
| Seen | The visit is done. |
| Did not come | A no-show. |
| Cancelled | Cancelled. |
| Waiting for payment | An online booking the patient has not paid yet. |

The **Booked** column shows **At the desk**, **Online, paid** or **Online**.

### Book a walk-in or phone patient

1. Choose the **Doctor**. Under **Free slots**, tap **Book** next to a time.
2. Enter the **Patient's mobile number**. The appointment goes on the Jansetu account of that number, and an account is created if there is none.
3. Under **Who is seen**, choose:
   - **The account holder** (the person with this mobile number). Add **Patient's name** if you like.
   - **A family member of the account holder**. Enter the **Family member's name** and **Relation to the account holder**, plus gender and date of birth if you like.
4. Add **Notes for the clinic** if needed. Tap **Review the booking**, then **Book appointment**.

Desk appointments are always in person, and the fee is paid at the clinic. The patient and the doctor are notified.

### During the day

Tap **Open** on an appointment, then:

- **Mark arrived**: when the patient checks in.
- **Mark as seen**: when the visit is over, any time on the day of the appointment (even before its time). The fee is paid at the clinic, so make a bill for it (section 7).
- **Mark did not come**: from 15 minutes after the appointment time; in a session with several patients, from 15 minutes after the session ends. Nothing is charged or refunded through Jansetu, and the doctor earns nothing.
- **Move to another time**: choose **Branch**, **New day** and **New time** (same doctor), tap **Continue**, then **Move the appointment**. This works even after the appointment time, for a patient who is running late, until you mark them seen or did not come.
- **Cancel appointment**: add a reason if you like. The seat is freed. If you already made a bill, cancel it under **Bills**.
- **Reschedule no-show**: on a "Did not come" appointment, pick a new time and confirm. This works **once only**. If the patient misses again, it is final.

The patient and the doctor are told about every move and cancellation.

**Online bookings are view-only.** For an appointment the patient booked in the app, the clinic can only look. The doctor or the patient makes any change.

---

## 7. Bills

### Bill an appointment (Create bill)

1. On the **Front desk** day list, find the desk appointment and tap **Create bill** in the **Bill** column.
2. The new bill already has the branch, the doctor and the patient. The bill is made out to the account holder (the mobile number it was booked with), even if a family member was seen.
3. Under **Items**, pick from **From the catalogue** and tap **Add item**.
4. Tap **Review the bill**, then **Issue bill**.

After that, the bill number shows on the appointment row. Each appointment can have one open bill. You can also make a bill without an appointment with **New bill** on the **Bills** page.

With a mobile number, the bill is added to that person's Jansetu account (they see it under Bills in their app). An issued bill cannot be changed, only cancelled.

### Record a payment

1. Open the bill and tap **Record payment**.
2. Choose **Paid by** (Cash, UPI, Card, Bank transfer, Other), the **Amount (₹)** and an optional **Reference**.
3. To mix methods (for example part cash, part UPI), tap **Add another method**.
4. Tap **Continue**, check, then tap **Record … paid**.

If part payments are off, the amounts must add up to everything due. If they are on, you can take less and the bill shows **Partly paid** until the rest is paid. Bill statuses: **Unpaid**, **Partly paid**, **Paid**, **Cancelled**.

### Cancel a bill

1. Tap **Cancel bill** and fill in **Why is this bill cancelled?**.
2. If money was paid, record how you gave it back: **Money returned by**, plus optional **Refund reference** and **Refund note**. The refund recorded is everything that was paid.
3. Tap **Cancel bill …**. This is permanent, and the number is never reused.

### PDF

Tap **Open PDF**, then **Save the PDF** to print or share. **Open PDF as issued** shows the original version.

---

## 8. Doctors

**Doctors** lists the doctors who consult at your clinic, with their speciality, branches, fee and status. **Can be booked** means the doctor is active. **Not bookable** means their Jansetu doctor account is inactive or not verified.

- Clinics cannot invite or add doctors. The Jansetu team links doctors to your clinic after checking them. Ask the team.
- **Owners** can **Remove** a doctor. New bookings with them stop at once and their in-clinic slots close. Booked appointments are kept. Only the Jansetu team can link them again.
- **Earlier invitations** lists old invitations. They can no longer be accepted. You can revoke a waiting one to tidy up.

---

## 9. Finance and Activity log

- **Finance** (owners, and all-branch staff with "View finance") shows money Jansetu collected online for the clinic and paid out. Bills paid at the counter are not included. Owners set **Where payouts are sent** (bank account or UPI). Jansetu verifies every change before the next payout. You can download a **Statement** as CSV.
- **Activity log** shows the latest 100 changes to your profile, staff and branches: who did what, and when.

---

## Good to know

- Desk appointments are paid at the clinic. Nothing is charged or refunded through Jansetu for them.
- A no-show is never refunded and the doctor earns nothing. It can be rescheduled only once.
- You can mark "did not come" from 15 minutes after the appointment time (a session with several patients: 15 minutes after it ends).
- Online bookings are view-only for the clinic.
- Only the Jansetu team adds doctors to your clinic. A doctor's own new clinic stays waiting until Jansetu verifies it.
- Part payments happen only if an owner switches them on in **Profile**.
- Only owners set staff sign-in emails.
- If you see "The outcome of this request is not known yet", tap the button to send the same request again. It is never booked or recorded twice.

---

## Common questions

**There are no free slots for a doctor.**
The doctor sets their in-clinic hours in their own Jansetu doctor schedule. Ask the doctor to add hours at your branch.

**The desk says "No branch for consultations".**
An owner must tick **Consultations at the clinic** on a branch under **Branches**.

**How do I book for a child or parent?**
Choose **A family member of the account holder**, then enter their name and relation.

**Why can't I change an online appointment?**
Online bookings belong to the patient and the doctor. The clinic can only view them.

**The patient wants to pay half now.**
An owner must first switch on **Allow part payments of bills** in **Profile**.

**How do I add a new doctor?**
Ask the Jansetu team. They link the doctor after checking them.

**I can't see Staff or Finance in my menu.**
You do not have that permission. Ask your owner.

---

## Need help?

Contact the Jansetu team. Tell them:

- your clinic name and branch;
- the appointment or bill number;
- what you tried, and the exact message on screen.

Jansetu support: (add phone and email here)
