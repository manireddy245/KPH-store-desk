# Admin guide

For the owner and whoever runs the books. The phase guides have the details; this page is the short version.

## Every day
- **Owner page:** check the day, the alerts and the stock warnings. Send yourself the daily summary on WhatsApp.
- **Dashboard → Needs your attention:** discounts above the limit, cancellations, PIN approvals, backup status and second-copy status.
- **Counter closing:** each counter closes its cash in Accounts → Close counter. Look at any difference on the Owner page.

## Every week
- **Stock → Reorder:** tick the items to order and make draft purchase orders, one per supplier. Send them on WhatsApp.
- **Stock → Slow & dead:** decide what to do with stuck stock.
- **Khata:** overdue and owing customers. Send reminders in Telugu or English.
- **Partners → Top / gone quiet:** painters and masons who brought business, and those who stopped.

## Every month (GST and the CA)
- Reports → **GSTR-1** and **GSTR-3B** for the month → **Excel** → send to the CA.
- Reports → **Sales register**, **Purchase register**, **Discounts** if the CA asks.
- Reports → **Tally export** → download the file. The CA imports it into TallyPrime: Gateway → Import → Masters first, then Import → Transactions. The first time, they should import into a copy of the company. Set the company name exactly as in their Tally under Settings → Shop & billing → **Company name in Tally**.
- Reports → **Profit & Loss**, **Profit by item**, **Stock value**, **Balance summary** are for you. Staff can't see costs.

## People and counters
- Settings → **Users & roles:**
  - add staff, reset a PIN, deactivate someone who leaves (their past bills stay)
  - set each person's discount cap
  - roles decide who can see costs, adjust stock, receive payments and so on
- Settings → **Counters:** a new PC or phone asks to join. Approve it here, or block a lost phone.
- Nobody can delete a bill, payment or stock entry. Cancelling needs a reason, and an admin PIN for staff. Everything is in **Activity**, with the user and the counter.

## Backups
- A backup is made by itself every day (Settings → Data & backups). The last 30 are kept on the server PC.
- **Set up the second copy:** a USB drive, another PC, or a Google Drive folder, plus a passphrase. See [PHASE7-GUIDE.md](PHASE7-GUIDE.md). **Keep the passphrase on paper at home.**
- If the Dashboard says a backup or copy failed, fix it the same day (usually the USB drive was unplugged).
- **Restore:** Settings → Data & backups → Restore from a backup → choose the file (`.json.gz`, or `.enc` with the passphrase) → type RESTORE. The current data is saved first, just in case.

## Settings worth checking once
- **Shop & billing:**
  - shop details on bills, invoice prefix
  - credit days (0 = no due dates)
  - reminder language, UPI ID
  - owner's WhatsApp number and e-mail, shop closing hour
  - stock advice numbers
- **GST & invoices:** GSTIN, state, HSN and rates per category.
- **Categories & discounts:** the discount limit for each category. No limit = every discount needs your PIN.
- **Gemini key:** used by the invoice scanner and the assistant. It stays on this PC only.

## Sample data and real data
- **Sample data** has a yellow banner. Use it for training; nothing reaches the real books.
- When ready: Settings → Data & backups → **Switch to real data** → create the owner account → import products, customers and opening stock (Settings → Import). The suggested opening date is 1 April.
- You can switch back to sample at any time for training. The two never mix.

## Server PC switched on in the morning, off at night
This is fine. Store Desk is made for it.

**Once, when setting up the server PC:**
1. Put a shortcut to **Start Store Desk.cmd** (in the Store Desk folder) into the Startup folder: press Win+R, type `shell:startup`, press Enter, and paste the shortcut there. Store Desk then starts by itself when Windows starts.
2. Optional: let Windows sign in by itself (Win+R → `netplwiz` → untick "Users must enter a user name and password"), so nobody has to type the PC password each morning.
3. Optional: in the PC's BIOS, set **"Restore on AC power loss" → Power On**, so the PC turns on as soon as the mains switch is turned on.
4. Give the server PC a fixed address on the shop Wi-Fi/router (DHCP reservation), so the counters always find it at the same address.

**Every day:**
- **Morning:** switch on the server PC first. Wait about 1 minute, then open Store Desk on the counters.
- **Night:** after 8:30 pm the day's backup and summary are made by themselves. Then **shut down Windows normally** (Start → Shut down) and only after that switch off the mains.
- Never cut the power while the PC is still running: a sudden power cut can damage the database. A small **UPS** (₹3,000–4,000) on the server PC protects against power cuts during the day.

**If the PC was switched off early** (before 8:30 pm), nothing is lost. The backup and that day's summary are made as soon as it starts next morning.

**Counters and phones only work while the server PC is on.** To see the shop from home after closing you would need the online copy (a paid server), which we have not set up.
