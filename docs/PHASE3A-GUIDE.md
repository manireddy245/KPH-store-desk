# Phase 3A: money books

**Accounts** in the top menu. Each tab appears only for people allowed to use it.

| Tab | What it's for | Who |
|---|---|---|
| **Cash count** | Count the drawer at day end against what the books say | Counter staff and admin |
| **Expenses** | Rent, salaries, electricity, loading/unloading… with an optional bill photo | Admin (petty cash for counter staff is **off**, as decided) |
| **Pay supplier** | Pay by cash or bank, against specific bills or "on account" | Admin |
| **Supplier dues** | What we owe each supplier, by age | Admin |
| **Cash ↔ bank** | Cash deposited, cash withdrawn, UPI / card money credited by the bank | Admin |
| **Books** | Cash book, bank book, any ledger, Day Book, trial balance, with Excel | Admin |
| **Journal** | Corrections, with a required reason | Admin only |
| **Setup** | Bank accounts, expense heads, opening balances | Admin |

Admin can grant other people these permissions in Settings → Roles: "Pay suppliers…", "Enter shop expenses", "Bank accounts, expense heads, journals and opening balances".

## How each part works

**Every entry is numbered** in its own series:
- PAY/26-27/000001 for payments
- EXP/… for expenses
- CTR/… for cash ↔ bank
- JRN/… for journals

Entries can be back-dated, but not into the future and not before the go-live date. Nothing is deleted. **Cancel…** keeps the entry, marked cancelled with the reason, and posts the reverse entry today.

**Paying a supplier**
- Pick the supplier; their unpaid bills are listed.
- Type the amount, then press **Oldest first** to spread it over the bills, or type amounts against bills yourself.
- Whatever isn't marked against a bill stays "on account".
- Purchase returns (debit notes) are already taken off each bill.

**Supplier dues**
- Splits what we owe each supplier into 0–30, 31–60, 61–90 and 90+ days.
- Payments marked against bills settle those bills. Payments on account settle the oldest bills first.
- **Pay…** jumps to the payment form with that supplier selected.

**Expenses**
- Choose the head, the amount, and where the money came from.
- If the expense has a **GST bill** (rent from a registered landlord, a transport company…), tick it and enter the rate, their GSTIN and the bill number.
- The amount you type is the bill total. The GST part goes to input tax credit and appears in **Reports → GSTR-3B** (4(A)(5)).

**Cash ↔ bank**
- UPI and card payments collect in "UPI Collections" and "Card Collections".
- When the bank credits them, enter it here: from UPI Collections, to your bank account.
- If the bank cut charges, type them under **Charges cut**; they go to Bank Charges.

**Cash count**
- The screen shows the opening cash, cash in, cash out and what the drawer *should* hold.
- Type how many of each note and coin you have. The difference shows straight away and is saved with who counted it.
- Admin can tick **Book the difference** to post it to "Cash Short & Excess", so the cash book matches the drawer.
- You can count more than once a day; every count is kept.

**Books**
- **Ledger**: pick any account (Cash, a bank, UPI, a customer, a supplier, an expense head…). It shows the opening balance, every entry with the accounts on the other side, and a running balance.
- **Day Book**: every entry in the period, line by line.
- **Trial balance**: on any date. Customers and suppliers appear as one line each, with the details on their own screens.

## Cost price: weighted average

Each purchase now sets a product's cost to the **weighted average** of the stock on hand and the new purchase. Example: 10 bags at ₹280 plus 200 bags at ₹292 gives ₹291.43.

Every sale already records the cost at that moment, so Phase 3B's profit reports will be exact per bill line.

## Opening balances

Accounts → Setup → **Opening balances**:

1. Set the **go-live date**, the day Store Desk takes over the books (1 April is easiest).
2. Type the balances of cash, each bank account, loans and other accounts, ideally from your CA's trial balance on that date.
3. These come from their own screens, not this one:
   - customer balances: Customers / Excel import
   - supplier balances: Suppliers / Excel import
   - opening stock: Inventory
4. **Capital** is worked out so the books balance.
5. **Confirm and lock**. After that the trial balance agrees to the paisa. Later corrections are made with a journal entry.

Until the opening balances are confirmed, the trial balance shows a difference. That is expected.

## Also fixed

- **Backups now include the e-way bill details (Phase 2B) and all the new tables.** A new test fails if any table is ever missing from the backup.
- The opening-balance screen now refuses openings on accounts that don't take one (Sales, Purchases, Capital).

## Still waiting on you

- **Your bank accounts.** Add them in Setup (name, last 4 digits, IFSC). Today there is one account called "Bank", which bank receipts use.
- **Your Tally version**, before Phase 3B builds the Tally export.

## Tests

159 automated tests (53 core + 106 server). New in this phase:
- weighted-average cost
- supplier payments against bills and on account, and ageing (oldest first)
- cancelling a payment puts everything back
- expenses with GST feed input tax credit into GSTR-3B; counter staff are blocked from entering expenses
- the bill photo
- UPI settlement with charges
- journals must balance and need a reason
- the ledger statement closes on the account balance, and every Day Book entry balances
- cash counts: the difference is recorded, and only admin can book it
- opening balances: Capital works out right, the trial balance agrees to the paisa after locking, and nothing changes after the lock
- backup coverage

## Next: Phase 3B

Profit & Loss, profit by product, category and brand, stock valuation, balance summary, and the Tally XML export.
