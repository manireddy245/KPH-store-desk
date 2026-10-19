# Phase 1 — what's built, how to run it, how to test it

## What Phase 1 gives you

- **Logins and counters**: each computer registers once with a counter name ("Counter 1", "Office") and an admin approves it. Staff log in with a PIN; the screen locks after idle time (default 5 minutes) and **Ctrl+L** switches user. Five wrong PINs lock that user for 5 minutes.
- **Roles and permissions**: Admin, Counter staff and Stock staff, matching your table. Admin can change them in Settings → Users & roles. Every rule is checked by the server, not just hidden on screen.
- **Admin PIN approval**: when staff try something they can't do (discount above the limit, cancelling a bill), the admin types their PIN on the same screen. Each approval is for that one action only, works once, expires in 5 minutes and is logged.
- **Max discount per product**: set per category (default) or per product, as % or ₹ per unit, plus an optional cap per staff member — the lower applies. The billing screen shows a faint hint (e.g. "D8"); it is never printed. Admin can switch the hint off.
- **Billing**: keyboard-first (F2 find, Enter add, F4 customer, Alt+1–4 payment, F8 admin PIN, F10 save & print, Ctrl+S save only). Per-line breakdown, CGST/SGST per product rate, round-off to the rupee, stock check, credit needs a customer, half-made bills are saved continuously (survive lock, user switch, power cut).
- **Invoice**: A4 tax invoice with your logo and brand, amount in words, GST summary, CANCELLED watermark, save as PDF from the print window. *Provisional layout until you send your preferred format.*
- **Sales history**: search, filter, reprint, cancel with reason (stock and accounts reversed; the number stays, marked CANCELLED).
- **Inventory**: add/edit/deactivate, inline price edit (admin), stock adjustment with required reason, stock card showing every movement, low/out filters, export.
- **Customers**: balance, credit limit, statement with running balance, receive payment (cash/UPI/card/bank/cheque). **Suppliers**: details, lead time, opening balance.
- **Dashboard**: today's sales by payment mode, collections, stock counts and value, 30-day chart, low stock, recent bills, alerts (discounts above limit, cancellations, admin PIN use, stock changes), backup status.
- **Activity log**: who, which counter, when — for every important action. Entries can't be edited or deleted.
- **Import** products / customers / suppliers from Excel or CSV with column matching, a row-by-row problem report, and opening stock / opening balances.
- **Backups**: automatic daily backup (keeps the last 30), "Back up now", download, and restore (with an automatic safety copy first).
- **Sample vs real data**: two separate databases. Sample data has a yellow banner on every screen. "Switch to real data" starts the real books empty.

### Built-in safety (enforced by the database itself)

- Money is stored as whole paise; quantities as thousandths of a unit. No floating point.
- Bills, bill lines, stock movements, accounting entries and the activity log **cannot be edited or deleted** — not even by a bug in the app. Bills can only change from "posted" to "cancelled", with a reason.
- Stock on hand is calculated from the stock ledger automatically; the app cannot write it directly. A check runs every 15 minutes and alerts if anything ever disagrees.
- Every bill and payment posts a balanced double-entry voucher (debit = credit, checked at save) — ready for ledgers and Tally export in Phase 3.
- Invoice numbers are gapless and per financial year (KPH/26-27/000001…), even with two counters billing at the same second. A failed bill does not use up a number.

## How to run it

Needs **Node.js 20.19 or newer** (for the shop server PC install **Node 24 LTS**) and **pnpm**.

```bash
pnpm install
pnpm build
pnpm start
```

Then open **http://localhost:4000** on that computer. The window prints the address for the other counters, e.g. `http://192.168.1.82:4000` — open that in Chrome/Edge on Counter 1 and Counter 2. The first time, Windows Firewall asks whether Node.js may use the network: allow it on **private networks**.

The first start takes about a minute: it sets up the built-in PostgreSQL database and loads sample data.

**Where the data lives:** `%LOCALAPPDATA%\KPHStoreDesk` (database, backups, passwords for the database). It is deliberately *not* inside the project folder, because OneDrive must never sync a live database.

Maintenance commands (stop the server first):

```bash
pnpm backup
```
```bash
pnpm restore "C:\path\to\storedesk-....json.gz"
```
```bash
pnpm db:reset-sample
```

For development with live reload: `pnpm dev` (screens on http://localhost:5173, server on 4000).

## Sample logins (sample data only)

| User | Role | PIN |
|---|---|---|
| Guru Mani | Admin | 1234 |
| Ravi | Counter staff | 2222 |
| Suresh | Stock staff | 3333 |

These exist only in the sample workspace. The real workspace starts empty and asks you to create the owner account.

## Step-by-step test (about 20 minutes)

1. **Register a counter.** Open the app → name it "Counter 1" → approve with Guru Mani's PIN.
2. **Log in as Ravi** (counter staff). You land on Billing.
3. **Make a bill.** F2 → type `ppc` → Enter → quantity `20` → Enter → discount `0.5` → Enter. Click the line to see the breakdown. Add `opus 4` too. Press F10. The bill saves and the invoice opens; check the totals, round-off and amount in words.
4. **Discount above the limit.** New bill, cement, discount `2`. The line turns red ("Ask admin PIN"). Press F8, choose Guru Mani, PIN 1234. The line shows "approved by Guru Mani". Save.
5. **Check the hint.** Note the faint "D0.95" under the discount box — it never appears on the printed bill.
6. **Credit bill.** Choose payment Credit without a customer → it refuses. Press F4, type `reddy`, pick Srinivasa Reddy; see their balance and limit. Save.
7. **Not enough stock.** Add "Padlock 50mm" (0 in stock) → the line shows "only 0 in stock" and Save stays disabled.
8. **Half-made bill.** Add two items, press Ctrl+L, log back in as Ravi → the bill is still there.
9. **Two counters at once.** Open the app in a second browser (or another PC), register "Counter 2", log in. Make a bill on one; watch stock and the dashboard update on the other within a second.
10. **Cancel a bill as staff.** Sales → open a bill → Cancel bill… → reason → it asks for the admin PIN → approve. The bill shows CANCELLED; the stock is back (Inventory → Stock card).
11. **Staff limits.** Still as Ravi: Inventory has no price editing or stock adjusting; Settings isn't in the menu.
12. **Stock staff.** Log in as Suresh → Inventory → click a stock quantity → enter a counted number → reason "Damaged" → save. Check the stock card.
13. **Admin.** Log in as Guru Mani → Dashboard shows alerts for the discount, the cancellation and the stock change, plus backup status. Activity shows every step with user and counter.
14. **Receive payment.** Customers → Srinivasa Reddy → Receive payment → ₹5,000 UPI → the statement and balance update.
15. **Import.** Settings → Import → Products → choose an Excel/CSV of a few items (include a row with no unit and a row with a bad price) → check the problem report → Import. The items appear with opening stock.
16. **Backup and restore.** Settings → Data & backups → Back up now → Download. Make one more bill. Restore the downloaded file (type RESTORE) → that last bill is gone, everything else is back. A safety copy was saved first.
17. **Real data.** When ready: Settings → Data & backups → Switch to real data (type REAL DATA) → set up the owner account. Switch back to sample any time for training.

## Decisions made in this phase (tell me if you want any changed)

- **Database stays inside the shop** (Option C): the shop server PC runs PostgreSQL; the online copy on DigitalOcean (owner phone from anywhere, off-site backup) is set up in a later phase — no paid service has been created yet.
- **PostgreSQL 18 is bundled** with the app (no separate installer). It only listens on the server PC itself; the counters talk to the Store Desk server, never directly to the database.
- **Counters run in Chrome/Edge**, not an Electron app yet. Each browser registers as a counter. An Electron wrapper (silent printing, auto-start) can be added when you set up the shop PCs.
- **Plain SQL migrations** instead of the Drizzle ORM proposed in Phase 0 — simpler and gives full control of the database safety rules.
- **No discount limit set = 0%**: any discount on such a product needs the admin PIN. Sample categories have limits (cement ₹3/bag ≈ 1%, paints 8%, putty 5%, pipes 5%, hardware 10%…).
- **Prices are typed excluding GST** in Phase 1. The Incl./Excl. GST toggle comes in Phase 2.
- **Credit limit is shown and warned about**, but enforcing it with an admin PIN is Phase 4 (as in the brief).
- **Customer payments are "on account"**; allocating to specific bills is Phase 4.
- The **Gemini invoice scanner** moves to Phase 3, where it creates a draft purchase entry.
- **Old app JSON import** will be written once you share a sample backup file.
- **Brand**: all screens follow your Kanakapatnam brand guidelines (Brick Orange, Ink, Concrete, Deep Teal; Archivo + Anek Telugu, bundled so they work without internet). Screen designs: https://claude.ai/artifact/4ijnAiphfJRqh11FVVPYhF

## Known limits in Phase 1

- Interface is English; the full Telugu switch is Phase 7 (Telugu labels already appear on headings and the invoice).
- No purchases, ledgers, GST reports or Tally export yet (Phases 2–3).
- Backups stay on the server PC; copying to a second location with encryption is Phase 7.
- The project folder is on the OneDrive Desktop. For the shop server, copy it to a normal folder such as `C:\KPH Store Desk` so OneDrive doesn't sync thousands of program files.

## Tests

`pnpm test` runs 72 automated tests: money and GST rounding (including CGST = SGST and round-off always reconciling), discount limits, FY numbering at the 31 March/1 April boundary in India time, 40 simultaneous bills with gapless numbers, stock never going below zero, cancel reversing stock and accounts, every role's permissions, database refusing edits/deletes, import problem detection, and backup→restore giving back exactly the same data.
