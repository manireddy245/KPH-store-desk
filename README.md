# Kanakapatnam Store Desk

Billing, stock, accounts and GST for **Kanakapatnam Paints and Hardwares** (Kavali, Andhra Pradesh): a cement, steel, paint, electrical and plumbing shop with two to three billing counters, an office PC and the owner's phone.

It runs on **one shop PC** (the "server") with its own built-in database. The counters and phones open it in Chrome or Edge over the shop Wi-Fi. No internet and no paid cloud service are needed to bill.

> **New here?** Read [What it does](#what-it-does), then [Run it on your computer](#run-it-on-your-computer). The app starts with **practice data** (a yellow "SAMPLE DATA" banner), so you can click around freely.

---

## What it does

| Area | What you can do |
|---|---|
| **Billing** | Fast keyboard billing (F2 find, F10 save & print) with multiple units (bag / ton / rod) and prices typed with or without GST. Discount limits per product or category; going over needs the owner's PIN. Credit limits. Half-made bills survive a screen lock or power cut. Bills above ₹50,000 ask "E-way bill needed?". |
| **Printed bill** | A4 GST tax invoice: CGST / SGST (or IGST) on every line, HSN or SAC per item, ship-to, customer PAN, delivery details, amount in words, a "For … / Authorised signatory" block, and an "Authorised dealers for" brand logo row. Original / duplicate / triplicate copies. |
| **Services** | Loading / unloading and transport charges are billed with their SAC code and GST but never count as stock. |
| **Returns** | Sales returns as credit notes (restocked or written off as damaged) and purchase returns as debit notes. Bills are never deleted; cancelling keeps the number and marks it CANCELLED. |
| **Stock** | Stock ledger for every movement, stock counts with reasons, and fast / slow / dead items with days of stock left. Reorder suggestions that explain themselves, turned into purchase orders sent on WhatsApp. Cement batch age (oldest first). |
| **Purchases** | Supplier bills typed in or **scanned from a photo** (Google Gemini reads the bill). Weighted-average cost. |
| **Khata (credit)** | Customer dues and ageing, payments against bills, WhatsApp reminders in Telugu or English, printable statements, old dues kept "on hold". |
| **Accounts** | Double-entry books underneath everything: cash / bank / UPI, expenses, supplier payments, journals, daily cash closing per counter, opening balances. |
| **GST & CA** | GSTR-1 and GSTR-3B (Excel), sales and purchase registers, discount report, e-way bill JSON for the government portal, and a **TallyPrime** export for the CA. Filed months are locked. |
| **Trade partners** | Painters, masons and contractors tagged on bills and sites, with rewards earned and taken back on returns. "Top" and "gone quiet" lists. |
| **Operations** | Daily rate board (share on WhatsApp), quotations → one-click bill, delivery challans with partial trips. |
| **Owner** | A phone-friendly Owner page: today's sales, cash, credit, alerts, stock warnings, and a daily summary at closing time (Telugu or English) to send on WhatsApp. Profit & loss, profit by item, stock value. |
| **Assistant** | Ask in Telugu or English, by text, photo or voice note ("ppc 20 bags for Reddy") and it drafts the bill. Needs a Gemini key. |
| **People** | PIN login per person, roles (admin, counter staff, stock staff), approved devices only, a full activity log (who, which counter, what changed). English or Telugu screens per person. |
| **Safety** | Automatic daily backup at closing time, plus an **encrypted second copy** (USB / another PC / Google Drive folder) that is checked every time. Restore with one click. |

## Run it on your computer

You need **Windows, macOS or Linux** with:
- **Node.js 20.19 or newer** (24 LTS recommended), from nodejs.org
- **pnpm**, installed with:
  ```bash
  npm install -g pnpm
  ```

Then, in this folder:

```bash
pnpm install
```
```bash
pnpm build
```
```bash
pnpm start
```

The first start takes about a minute: it sets up the built-in PostgreSQL database and loads practice data. Then open **http://localhost:4000**.

The first time, the browser asks you to **register this computer as a counter**. Type a name (e.g. "My laptop") and approve it right there with the sample admin's PIN.

**Practice-data logins** (these exist only in practice data, never in real data):

| Name | Role | PIN |
|---|---|---|
| Guru Mani | Admin (owner) | 1234 |
| Ravi | Counter staff | 2222 |
| Suresh | Stock staff | 3333 |

A short tour to try:
1. **Billing:** press F2, type `ppc`, Enter, quantity 20, Enter, Enter, then F10. The bill prints.
2. **Sales:** open the bill → Return items… / Cancel bill… / E-way bill… / Ship-to & details….
3. **Owner** page; **Stock → Reorder**; **Khata**; **Reports → GSTR-1**.
4. Switch the screens to **తెలుగు** in the top bar.

**Where the data lives:** outside this folder, in `%LOCALAPPDATA%\KPHStoreDesk` on Windows (`~/.local/share/KPHStoreDesk` elsewhere). Practice data and real data are separate databases. Settings → Data & backups switches between them.

**Development** (live reload: screens on :5173, API on :4000):

```bash
pnpm dev
```

**Tests:**

```bash
pnpm test
```

These run the core money/GST rules and the server against a real PostgreSQL.

## How it's built

```
packages/core   Money (paise), GST and rounding, discount limits, numbering, units,
                GST return helpers, stock insights, permissions. Pure TypeScript, fully tested.
apps/server     Fastify API + built-in PostgreSQL (embedded-postgres). SQL migrations,
                database-level safety rules, backups, daily jobs.
apps/web        React 19 + Vite + Tailwind screens for counters, office and the owner's phone.
docs/           Guides for each phase, plus staff, admin and setup guides.
```

House rules the code keeps:
- **Money is whole paise** (integers): no floating-point rupees anywhere.
- **Bill numbers are gapless** per financial year (e.g. `KPH/26-27/000123`). A failed save never uses up a number.
- **Nothing is deleted.** Bills, payments and stock entries can only be cancelled or reversed, with a reason.
  - The database enforces this: the app's own login cannot delete business records or edit stock balances.
- **Every stock change goes through the stock ledger**, and every rupee through a balanced double-entry voucher.
- **Everything is audited** with user, counter and time.

## Documents

**Start here:**
- [Setup guide](docs/SETUP-GUIDE.md): run it, let someone test it remotely, set up the shop
- [Staff guide (English + Telugu)](docs/STAFF-GUIDE.md)
- [Admin guide](docs/ADMIN-GUIDE.md)

**What each phase added:**
- [Phase 1](docs/PHASE1-GUIDE.md): billing, stock, counters, safety
- [Invoice scanner](docs/SCANNER-GUIDE.md)
- [Phase 2A](docs/PHASE2A-GUIDE.md): units, returns, prices with or without GST
- [Phase 2B](docs/PHASE2B-GUIDE.md): GSTR-1/3B, registers, e-way bills
- [Phase 3A](docs/PHASE3A-GUIDE.md): money books
- [Phase 3B](docs/PHASE3B-GUIDE.md): P&L, profit, Tally export
- [Phase 4](docs/PHASE4-GUIDE.md): khata
- [Phase 5](docs/PHASE5-GUIDE.md): trade partners
- [Phase 6A](docs/PHASE6A-GUIDE.md): rate board, quotations, challans
- [Phase 6B](docs/PHASE6B-GUIDE.md): smart stock, purchase orders, stock count
- [Phase 7](docs/PHASE7-GUIDE.md): owner page, Telugu, encrypted backups
- [Assistant](docs/ASSISTANT-GUIDE.md)

**Plans and decisions:** [docs/PLAN-decisions.md](docs/PLAN-decisions.md)

## Status

All planned phases are built and tested. The app is in **owner testing** before the real go-live (planned 1 April). Still to come:
- the owner's own fine-tuning
- official brand logo files from the distributors
- the CA's check of the GST Excel files

**Notes:**
- Brand logos shown on the bill belong to their companies and are used only to show which brands the shop deals in.
- The scanner and Assistant use Google Gemini; the shop's own API key goes in Settings and is never stored in backups.

## Testing it on the owner's laptop (remote)

The owner can share their running copy privately over **Tailscale**. You get an invite, open `http://<their Tailscale address>:4000`, register your device, and they approve it. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md), part C, and the test checklist in part D.
