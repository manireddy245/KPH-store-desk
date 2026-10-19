# Phase 4: credit (khata) management

**Khata** in the top menu. Counter staff and admin can use it.

## What's new

**Khata page**
- Totals at the top: how much customers owe, how much is overdue, and the amounts by age (0–30, 31–60, 61–90, over 90 days).
- Filters: Overdue, Everyone who owes, Over credit limit, Paid in advance. You can also search by name or phone.
- Each customer row shows:
  - what they owe and what is overdue
  - their oldest unpaid bill, last payment and last reminder
  - **WhatsApp** and **Receive** buttons
- Pick any date at the top to see the position as it was then. Admin can download it as Excel.

**When a bill is overdue**
- A credit bill is overdue after the customer's **credit days**.
- The shop default is **30 days** (Settings → Shop & billing). Each customer can have their own (Customers → Edit).

**Customer page**
- A new **Dues** tab shows every unpaid bill with its due date and how old it is.
- It also keeps a log of every WhatsApp reminder, call or visit. Use **Log a call / visit** to note "will pay ₹10,000 on Friday".

**Receiving payment against bills**
- The payment window now lists the customer's unpaid credit bills, with what is *still due* on each.
- Type amounts against bills, or press **Oldest first** to spread the payment.
- Anything not marked against a bill is "on account" and settles the oldest bills first.
- A return credited to the account settles its own bill.
- Cancelling a receipt (for example, a bounced cheque) reopens the bills.
- **Pay supplier** in Accounts now shows the same "still due" figures.

**Credit limit**
- A credit bill that takes the customer over their limit needs the **admin PIN**.
- The approval covers that customer, up to that amount, once.
- Admin can bill over the limit directly; it is still recorded in the activity log, as are PIN approvals.
- Cash, UPI and card bills are never blocked.

**WhatsApp reminder**
- One tap opens WhatsApp with a polite message already typed:
  - the customer's name
  - their balance and the overdue part
  - their oldest bill and how many days old it is
  - the shop's name and phone
- You just press Send in WhatsApp. No paid service is needed, and nothing is sent automatically.
- The message is in **Telugu** by default. Change the default in Settings, or set it per customer.
- If you add the shop's **UPI ID** in Settings, the message includes a pay link.
- Every reminder is logged with who sent it.

**Statement printout**
- Customer → **Print statement** gives an A4 page with your letterhead:
  - opening balance
  - every bill, payment and return, with a running balance
  - closing balance
  - bills still due
- Labels are in English and Telugu. Choose any dates, then print or save as PDF.

**Dashboard**
- A new **Payments due** card shows overdue customers, each with a WhatsApp button.

**Tally**
- Receipts marked against bills are exported against those bills ("Agst Ref"), so Tally's outstanding report matches.

## Also fixed
- The backup test sometimes failed when another test wrote at the same moment. It now compares against the backup file itself.
- The "still due" amount on a bill now takes earlier on-account payments into account. It used to show the full bill amount.

## How to try it (sample workspace)
1. Khata → **Everyone who owes** → open Srinivasa Reddy → **Dues** tab.
2. **Receive** → ₹5,000 → **Oldest first** → save. The bill's "still due" goes down.
3. **WhatsApp** on P. Ramesh: WhatsApp opens with the Telugu message. Close it without sending if you're only testing.
4. Customers → edit a customer → set a credit limit of ₹1,000. In Billing, as Ravi (counter), make a credit bill above that; it asks for the admin PIN.
5. Customer → **Print statement** → change the dates → Print.

## Tests
177 automated tests (57 core + 120 server). New in this phase:
- Credit limit:
  - PIN needed; an approval for a smaller amount is refused
  - cash bills are never blocked
  - admin can bill over the limit, and it is logged
- Payments against bills, plus on-account amounts settling the oldest first.
- Returns credited to the account settle their own bill.
- A cancelled receipt reopens its bills.
- Ageing buckets and overdue amounts by credit days.
- Statements: opening, closing and entries, from any start date.
- WhatsApp reminders:
  - the link and message in both languages
  - mobile number checks, and refused when nothing is due
  - the reminder log, and calls logged without a mobile
- Tally bill references for receipts.
