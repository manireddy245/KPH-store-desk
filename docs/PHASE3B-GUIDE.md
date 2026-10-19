# Phase 3B: profit reports and Tally export

All of this is under **Reports**. The profit tabs need permission to see costs, which admin has.

## Profit & Loss

For any month, quarter or date range:

| Line | Where it comes from |
|---|---|
| Net sales | Bills less returns, before GST |
| Cost of goods sold | The **weighted-average cost recorded on each bill line** at the moment of sale |
| Returns | Take back both the sale and its cost |
| Stock written off / found | Stock adjustments (damaged, lost, count differences), valued at cost |
| **Gross profit** | |
| Expenses | Every expense head, freight on purchases, and bill round-off |
| Other income | |
| **Net profit** | Before income tax |

GST is not counted as income or expense. A warning shows if any bill line was sold before its product had a cost price.

## Profit by product, category, brand

Sales, cost, profit and margin %, with a bar for each row. Switch between **by product**, **by category** and **by brand**. Excel download included.

## Stock value

- Every item in stock on a date, at weighted-average cost, with totals by category.
- Warns about items with no cost price or negative stock.
- For a past date the quantities are exact, but they are valued at today's average cost.

## Balance summary

On a date, three lists:
- **What the shop has**: cash, banks, UPI/card money not yet in the bank, money customers owe, stock, advances, GST credit.
- **What it owes**: suppliers, customer advances, GST to pay, loans.
- **Owner's funds**: the difference between the two.

This is a simple picture of the business; your CA prepares the formal balance sheet.

## Tally export (TallyPrime XML)

Reports → **Tally export**. Three files:

1. **Masters (ledgers)**: every account with its Tally group (Sundry Debtors, Bank Accounts, Duties & Taxes…).
   - Opening balances included.
   - Customers and suppliers carry GSTIN, state and phone.
   - GST ledgers are marked with their tax type (Central / State / Integrated Tax).
2. **Stock items** (optional): units, stock groups (our categories), HSN and GST rate.
3. **Vouchers** for the chosen period: every sale, receipt, purchase, payment, expense, contra, journal, credit note and debit note.
   - Each keeps our number (KPH/26-27/000123, PUR/…, PAY/…).
   - Purchases carry the supplier's bill number and date.
   - Bill-by-bill references are included, so Tally's outstanding reports work: a sale opens a new bill, a supplier payment marked against bills settles those bills, returns are set against their bills, and receipts go on account.
   - A cancelled document goes across as the original plus a reversing journal, so it nets to zero, just like here.

**Import into TallyPrime:** Gateway → Import → Masters (first), then Import → Transactions. **The first time, import into a copy of the company**, then compare its trial balance with Accounts → Books → Trial balance.

**Account names.** If your CA's Tally uses different names (for example "Sales @ 18%" or "HDFC Bank A/c"), set the Tally name next to each account. The vouchers then post to those ledgers.

Tally needs every ledger name to be unique, so two customers called "Ravi" are exported as "Ravi (1111)" and "Ravi (2222)", using the last digits of their phones. These are marked *changed*.

**Company name.** Settings → Shop & billing → "Company name in Tally". Leave it blank to use the shop name.

**Exports are logged.** Exporting the same period again shows a warning, so vouchers aren't imported twice by mistake.

**Format and version.** TallyPrime's "Import Data" XML, for TallyPrime 3.0 and later. Vouchers are accounts-only, without item lines. Tell me if your CA wants item-wise invoices in Tally instead.

## Also fixed

- **Sample data**: opening stock is now dated before the month of sample bills, so stock and balance figures for past dates make sense.
  - This only applies to a fresh sample. To get it, stop Store Desk and run `pnpm db:reset-sample`. That clears the practice workspace, including any practice entries.
  - Your live workspace is not affected.
- **P&L screen**: amounts that come out in our favour (such as round-off) now show with a minus sign, instead of as "₹-1.21".

## Tests

167 automated tests (53 core + 114 server). New in this phase:
- the P&L moves by exactly a known sale, return, damaged write-off and expense
- profit by product, category and brand
- stock value today and on an earlier date
- the balance summary adds up
- Tally:
  - every voucher balances, debits are negative, and the party ledger is flagged
  - renamed accounts are used in vouchers, and the same Tally name can't be used twice
  - duplicate customer names become unique
  - GST details and tax types are in the masters, and special characters are handled safely
  - stock items carry HSN codes
  - exporting the same period again is flagged, and counter staff can't export
