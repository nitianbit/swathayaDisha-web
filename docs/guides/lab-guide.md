# Jansetu Workspace: Lab Guide

**What you can do here:** run your lab on Jansetu. You can set up staff, branches, tests and prices, and slots. You handle online lab bookings and reports, make bills at the counter, and track the money Jansetu pays you.

Website: **https://staff.swasthadisha.etryx.in**. Customers book in the Jansetu app or at https://swasthadisha.etryx.in.

Working at a clinic? See the Clinic guide instead.

---

## 1. Sign in

1. Open the website.
2. Under **I am signing in as**, choose **Lab or clinic staff**.
3. Type your **Mobile number or email**. Email works only if your owner has added it to your staff record.
4. Tap **Send code**, type the 6-digit code from the SMS or email, and tap **Verify and sign in**.
5. If your number works for several labs or clinics, choose one and tap **Open workspace**.

To switch to another lab, tap **Sign out** (bottom of the menu) and sign in again.

A new lab shows "…is waiting for verification by Jansetu". The workspace opens once Jansetu has verified it.

### Who sees what

**Owners** see every page and can do everything. **Staff** see only the pages their permissions allow. The menu on the left changes to match.

| Menu item (section) | Who sees it |
|---|---|
| Profile (Organisation) | Everyone |
| Staff (Organisation) | Permission "Manage staff" |
| Branches (Organisation) | "Manage branches" |
| Activity log (Organisation) | "Manage staff", with access to all branches |
| Price list (Billing) | "Manage tests and services" or "Create invoices" |
| Bills (Billing) | "Create invoices", "Cancel invoices", "Record payments" or "View finance" |
| Finance (Billing) | "View finance", with access to all branches |
| Lab bookings (Lab) | "View bookings", "Manage bookings", "Upload reports" or "Release reports" |
| Slots (Lab) | "Manage slots", "View bookings" or "Manage bookings" |

---

## 2. Profile

**Profile** shows your lab's type, status (**Verified**, **Waiting for verification** or **Suspended**), GSTIN, PAN, tax type, invoice prefix and number of owners.

- **Owners** can change **Contact details** (**Display name**, **Legal name**, **Contact phone**, **Contact email**) and tap **Save**.
- Registration and tax details are changed by Jansetu.

### Payments at the counter (owners only)

This decides how bills can be paid:

- **Off** (the starting setting): "Full payment only". Each payment must clear everything still due. It can still be split across methods, such as cash and UPI.
- **On**: tick **Allow part payments of bills** and tap **Save payment setting**. A bill can then be paid in several smaller payments.

---

## 3. Staff (owners, or staff with "Manage staff")

**Add someone:**

1. Tap **Add a staff member**.
2. Fill in **Name** and **Mobile number**. Owners also see **Email (optional)**. With an email, the person can also sign in by email.
3. Choose **Role**: **Staff**, or **Owner** (owners only). An owner can do everything, in every branch.
4. For staff, tick their permissions and their branches. Tick **All branches, including new ones**, or pick branches. You can give only permissions you hold yourself.
5. Tap **Add staff member** (or **Add owner**).

**Change someone:** on their row, use **Edit permissions**, **Add registration** / **Change registration**, **Change branch access**, **Add email** / **Change email**, or **Remove**.

- Only owners change permissions, registrations and emails.
- Changing or removing someone's email signs them out of the workspace.
- You cannot remove yourself or the last owner.

### Add a report signer's registration (owners only)

A report is released under a registered professional. Their name, what they are registered as and the number are on the report the customer gets. The **Registration** column shows who has one.

1. On the person's row, tap **Add registration** (or **Change registration**).
2. Choose **Registered as**: **Pathologist**, **Doctor** or **Pharmacist**.
3. Type the **Registration number** (3 to 60 characters).
4. Tap **Save registration**.

To release reports, the person also needs **Release reports** (owners have it) and must work at the booking's branch.

To take a registration off, tap **Change registration**, then **Remove registration**, and confirm. Reports already released keep the registration they were released under.

If someone else changed it while you were typing, nothing is saved and the form shows what is saved now. Check it and save again.

---

## 4. Branches

1. Tap **Add a branch** (owners and all-branch managers).
2. Fill in **Branch name**, **Phone**, address and **State code** (the GST state code, for example 29).
3. Under **Services**, tick **Home sample collection** and/or **Walk-in at the lab**.
4. Set **Opening hours** for each day and add **Holidays**.
5. Tap **Add branch**.

Use **Edit** to change a branch. **Deactivate** stops a branch taking bookings and closes its open slots. **Reopen** is under **Closed branches**.

---

## 5. Price list (tests and packages)

The page is called **Tests and prices**. Customers book these, and they appear on bills.

1. Tap **Add an item**.
2. Choose **Type**: Test or Package. Fill in **Name**, **Price (₹)** and, if you like, **Code**, **MRP**, **GST rate** and **SAC**.
3. Under **Where it is offered**, tick **Home collection** and/or **At the lab**.
4. Add **Sample type**, **Report within (hours)**, **Description**, **Preparation** (for example "fasting for 10 hours") and, for packages, **Includes**.
5. Tap **Add item**.

**Edit** changes an item, and price changes apply at once. **Deactivate** takes it off sale (bills already issued keep it). **Reactivate** it later from Status: **Deactivated**.

An item marked **Disabled by Jansetu** cannot be booked or billed until Jansetu enables it again. A lab that is not registered for regular GST can bill only 0% GST.

---

## 6. Slots (weekly timings and closing days)

Slots are the times customers can book, per branch and visit type. They are made for the next 30 days from your weekly template.

1. Choose the **Branch** and **Visit type** (**Home collection** or **At the lab**).
2. Tap **Edit the weekly template**. Set **Slot length (minutes)**, **Seats per slot** and, for each day, time windows (**Add a window**).
3. Tap **Review the template**, check the summary, then tap **Save the template**.

Other tools:

- **Add a one-off slot**: an extra time on one date (**Date**, **Starts**, **Ends**, **Seats**).
- **Change seats** on a slot.
- **Close** a slot so nobody new can book it. People already booked keep their seats. **Reopen** opens it again.
- **Closing a whole day:** add it as a holiday on the branch (section 4). Its slots close automatically.

Use **Previous week**, **This week** and **Next week** to move around. Times are India time.

---

## 7. Lab bookings

**Lab bookings** lists tests customers booked and paid for in the Jansetu app, by slot time. Filter by **Branch**, **Status** and dates, then tap a slot time to open a booking.

### Booking statuses

| Status | What it means |
|---|---|
| Waiting for payment | Not paid yet. Nothing to do. Unpaid bookings expire on their own. |
| Confirmed | Paid and booked. Ready for you. |
| Sample collected / Visited | Sample taken at home, or the patient came to the lab. |
| Processing | Tests are being run. |
| Report released | At least one report is with the customer. |
| Completed | Finished. Your earning is recorded. |
| Cancelled | Cancelled by the customer, not paid in time, or rejected by the lab. |
| No-show | The patient was not there. |

A paid booking is **Confirmed** automatically. There is no separate confirm step.

### Step by step

1. **Home collection:** tap **Assign collector**. Choose a staff member, or type a name and mobile. The customer sees them. Then tap **Mark sample collected**.
   **At the lab:** tap **Mark visited** when the patient arrives.
2. Tap **Start processing**.
3. Under **Upload reports**, choose files (PDF, JPEG, PNG or WebP, up to 10 MB each). Tap **Upload as drafts**. Customers cannot see drafts. If an upload gets no answer, the same files stay chosen: tap **Upload the rest** (a file already added is never added twice) or **Check the reports** before choosing other files.
4. Next to each draft, tap **Release**, then confirm. The customer can open it in the app at once. A released report cannot be withdrawn here.
5. When all reports are out, tap **Complete booking**. No more reports can be added after this.

### Other actions (on a Confirmed booking)

- **Propose a new time**: pick a free slot and write a reason. The customer accepts it, or cancels for a full refund. The booking shows **New time proposed** until they answer.
- **Reject booking**: write a reason the customer will see. The booking is cancelled and the customer gets the full amount back in their Jansetu wallet.
- **Mark no-show**: only after the slot has ended (for a 9:00–9:30 slot, from 9:30). The patient may still arrive during the slot. The customer is not refunded and the lab earns nothing. It cannot be undone.
- **Reschedule no-show**: on a no-show booking, choose a new time and confirm. This works **once only**, at the same price. If the patient misses again, that no-show is final.

The **Timeline** at the bottom shows everything that happened.

---

## 8. Bills (at the counter)

**Bills** lists bills you issued, newest first. Search by bill number, customer name or phone, or filter by status, branch and date.

### Make a new bill

1. Tap **New bill**.
2. Choose the **Branch**. Fill in **Customer name** and, if you like, **Mobile number**, **Age**, **Gender**, **Customer GSTIN** and **Customer state code**.
3. Under **Items**, pick from **From the catalogue** and tap **Add item**. Set **Quantity** and **Discount** per line.
4. Check **Expected amounts**. Tap **Review the bill**, then **Issue bill**.

An issued bill gets the next number and cannot be changed, only cancelled. If you gave a mobile number, the bill is added to that person's Jansetu account.

### Record a payment

1. Open the bill and tap **Record payment**.
2. Choose **Paid by** (Cash, UPI, Card, Bank transfer, Other), the **Amount (₹)** and an optional **Reference**.
3. To split the payment (for example part cash, part UPI), tap **Add another method**.
4. Tap **Continue**, check, then tap **Record … paid**.

If part payments are off, the amounts must add up to everything due. Bill status shows **Unpaid**, **Partly paid**, **Paid** or **Cancelled**.

### Cancel a bill

1. Tap **Cancel bill** and write **Why is this bill cancelled?**.
2. If money was paid, record how you gave it back: **Money returned by**, plus optional **Refund reference** and **Refund note**.
3. Tap **Cancel bill …**. This is permanent. The number is never reused.

### PDF

Tap **Open PDF** to see it, then **Save the PDF**. After a payment or cancellation you can also tap **Open PDF as issued** to see the original.

---

## 9. Finance (owners, and all-branch staff with "View finance")

This shows money Jansetu collected online for you and pays out to you. Bills paid at the counter are not included.

- **Balance**: **Balance due**, **Earned**, **Reversed**, **Paid out**, **Adjustments**, and your last payout.
- **Where payouts are sent**: owners tap **Add payout details** (or **Change payout details**). Choose **Bank account** or **UPI**, fill it in, tap **Review the change**, then **Save payout details**. Jansetu must verify every change before the next payout.
- **Statement**: pick **From** and **To** dates, then **Download CSV**.
- **Payouts** and **Finance events** list what was paid and changed.

---

## 10. Activity log

**Activity log** shows the latest 100 changes to your profile, staff and branches: who did what, and when. Changes made by Jansetu show as "Jansetu admin".

---

## Good to know

- Online lab bookings are paid in the Jansetu app before you can act on them. Customers can cancel in the app, with a full refund, up to 2 hours before the slot.
- No-shows are never refunded and earn the lab nothing. You can reschedule a no-show only once.
- You earn for a booking only when you tap **Complete booking**.
- Rejecting a booking always refunds the customer in full.
- To release a report, your staff record needs a professional registration number. An owner adds it in **Staff** (section 3).
- Part payments happen only if an owner switches them on in **Profile**.
- If you see "The outcome of this request is not known yet", tap the button to send the same request again. It is never recorded twice.

---

## Common questions

**I can't see Staff (or Bills, or Finance) in my menu.**
You do not have that permission. Ask your owner.

**Customers can't book my lab.**
Check that the lab is **Verified**, the branch offers the right service, the tests are **Offered**, and slots exist in **Slots**.

**The Mark no-show button is grey.**
It works only after the slot has ended (its end time, not its start).

**How do I close the lab on a festival day?**
Add the date under **Holidays** on the branch. Its slots close by themselves.

**Can I give part of a bill back?**
When you cancel a paid bill, the refund recorded is everything that was paid.

**Release says I cannot sign the report.**
Your staff record needs a professional registration number. Ask an owner to open **Staff** and tap **Add registration** on your row.

**How do I give a staff member email sign-in?**
An owner opens **Staff** and taps **Add email** on their row.

---

## Need help?

Contact the Jansetu team. Tell them:

- your lab name and branch;
- the booking or bill number;
- what you tried, and the exact message on screen.

Jansetu support: (add phone and email here)
