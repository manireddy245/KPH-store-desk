# Setup guide: test on your laptop with a friend, then set up the shop

This guide has three parts:
- **A–E:** run Store Desk on your laptop and let Shreyansh test it as an admin, from the same Wi-Fi or from his own home.
- **F:** set up the shop for real use.
- **G:** problems and fixes.

Testing happens in **practice data** (the yellow "SAMPLE DATA" banner). Nothing he does touches your real books.

---

## A. Start Store Desk on your laptop

1. Close any other copy of Store Desk first. Only one can run at a time; a second copy fails because the address is taken.
2. In the Store Desk folder, double-click **Start Store Desk.cmd**. A black window opens. Keep it open; closing it stops Store Desk.
3. After about a minute the window shows:
   ```
   Kanakapatnam Store Desk is running (SAMPLE DATA)
   On this computer:   http://localhost:4000
   On other counters:  http://192.168.x.x:4000
   ```
4. Open **http://localhost:4000** in Chrome or Edge on your laptop and sign in.
5. While he is testing, keep the laptop awake:
   - Windows Settings → System → Power → **Screen and sleep** → "When plugged in, put my device to sleep after" → **Never**.
   - Keep the charger plugged in.
   - Closing the lid may still sleep it; set "Lid close action" to "Do nothing" in Control Panel → Power Options if needed.

## B. Make Shreyansh's admin login

1. Make sure the banner says **SAMPLE DATA**. Practice data and real data have separate logins, so this ID exists only for testing.
2. Settings → **Users & roles** → **+ Add user**.
3. Fill in:
   - **Name:** Shreyansh
   - **Role:** Admin (everything the owner can do)
   - **PIN:** any 4–6 digits you choose
   - **Discount cap:** leave blank
4. Save. Tell him the PIN privately: in person or by phone call, not in a group chat.

Everything he does is recorded under his name in **Activity**, so you can see what he tested.

## C. Let him in

### Option 1: he is in the shop or at your home, on the same Wi-Fi

1. The first time, Windows Firewall asks whether Node.js may use the network. Tick **Private networks** and allow. If it never asked, see part G.
2. On his laptop or phone, he opens the "On other counters" address from the black window, for example `http://192.168.0.110:4000`.
3. He types a counter name, for example "Shreyansh laptop", and presses **Register**.
4. You approve it from your own laptop: Settings → **Counters** → **Approve**. Don't type your admin PIN on his device.
5. He picks **Shreyansh** and enters his PIN.

### Option 2: he is at his own home, using Tailscale (free, private)

Tailscale joins your laptop and his into a private network, like a tunnel. Only the people you invite can reach Store Desk; it is not opened to the whole internet.

**On your laptop (once):**
1. Install Tailscale from **tailscale.com/download** and sign in with your Google account.
2. Open the Tailscale admin page (login.tailscale.com) → **Machines**.
3. Next to your laptop, click **⋯ → Share…**, then copy the invite link.
4. Send that link to Shreyansh.
5. Note your laptop's Tailscale address, shown there as `100.x.y.z`.

**On his laptop (once):**
1. He installs Tailscale and signs in with his own Google account.
2. He opens your invite link and accepts. Your laptop now appears in his Tailscale list.
3. He opens **http://100.x.y.z:4000** (your Tailscale address).
4. He registers a counter ("Shreyansh home"). You approve it in Settings → **Counters**, then he signs in as Shreyansh.

**Optional, for voice notes in the Assistant:** the browser only allows the microphone on a secure (https) address.
1. On your laptop, open Command Prompt and run:
   ```
   tailscale serve --bg 4000
   ```
2. Tailscale shows an https address such as `https://your-laptop.tail1234.ts.net`. He uses that address instead.

Everything else, including taking bill photos with the camera, works on the plain address.

**Don't** open a port on your Wi-Fi router or use a "public link" service. That would put your shop's billing on the open internet.

## D. What to ask him to test

Give him this list. Ask him to note anything odd with a screenshot and the bill number.

- [ ] **Billing:**
  - a cash bill, a UPI bill, a credit bill to a customer
  - a discount above the limit (asks for an admin PIN)
  - a half-made bill survives Ctrl+L (lock)
- [ ] **Big bill:** above ₹50,000 → "E-way bill needed?" → Yes → fill the form → **Open e-way bill website** (just look; don't make a real one)
- [ ] **Loading charges:** add "Loading and unloading charges" to a bill. GST is added, and stock doesn't change.
- [ ] **Ship-to:** fill the **Ship to, PAN & delivery details** section, print the bill, and check the layout and logos
- [ ] **Returns and cancellations:** return one item (Sales → open bill → Return items), then cancel a bill
- [ ] **Khata:** receive a payment against a credit bill, send a WhatsApp reminder (opens WhatsApp only), print a statement
- [ ] **Purchases and stock:**
  - enter a purchase
  - do a stock count with a reason
  - look at Stock → Reorder
- [ ] **Quotations and deliveries:** make a quotation → **Make bill**; make a delivery challan
- [ ] **Reports:**
  - GSTR-1 and GSTR-3B Excel
  - Profit & Loss
  - Tally export (download only)
- [ ] **Owner page:** check the day and send the daily summary to himself on WhatsApp
- [ ] **Telugu:** switch to Telugu in the top bar; check the words make sense
- [ ] **Phone:** open the same address on his phone; check the Owner page and the menu
- [ ] **Two people at once:** you bill on your laptop while he watches the Dashboard update

The invoice scanner and the Assistant need the Gemini key in Settings → Shop & billing. Without it they say so politely.

## E. When testing is over

1. Settings → **Users & roles** → Shreyansh → **Edit** → Status: **Inactive — cannot log in**. His past entries stay; he just can't log in.
2. Settings → **Counters** → **Block** his device(s).
3. Tailscale admin page → **Machines** → your laptop → **Share…** → remove him. You can also uninstall Tailscale if you won't use it.
4. Optional: wipe the practice data: Settings → Data & backups → **Reset sample data…**.

---

## F. Set up the shop for real

### 1. The server PC
- Pick one desktop PC in the shop. It stays on during shop hours and the other counters connect to it.
- Ideally put a small UPS on it.

### 2. Install Store Desk on that PC (once)
1. Install **Node.js 24 LTS** from nodejs.org (Windows installer, default options).
2. Open Command Prompt and run:
   ```
   npm install -g pnpm
   ```
3. Copy the Store Desk folder to the PC, for example `C:\StoreDesk`. Don't copy `node_modules`, and don't keep the folder inside OneDrive.
4. In that folder, run:
   ```
   pnpm install
   ```
   ```
   pnpm build
   ```
5. Double-click **Start Store Desk.cmd** and allow Node.js through the firewall on **private networks**.
6. Make it start by itself:
   - Win+R → `shell:startup` → paste a shortcut to **Start Store Desk.cmd** there.
   - Give the PC a fixed address in your Wi-Fi router (DHCP reservation), so counters always find it.
   - See [ADMIN-GUIDE.md](ADMIN-GUIDE.md) → "Server PC switched on in the morning, off at night".

### 3. Switch to real data and fill in the basics
1. Settings → Data & backups → **Switch to real data** → type REAL DATA → create the **owner account**: your name and your own PIN.
2. Settings → **Shop & billing:**
   - shop name, address, phone
   - invoice prefix
   - UPI ID
   - owner's WhatsApp number and e-mail
   - closing time 8:30 pm
   - Gemini key, if you want the scanner and Assistant
3. Settings → **GST & invoices:** GSTIN, state, invoice labels, brand logos on or off.
4. Settings → **Categories & discounts:** the discount limit for each category.
5. Settings → **Users & roles:** add your staff, each with their own PIN and role.

### 4. Products, customers and opening stock
1. Settings → **Import:** products (with HSN, GST %, prices), customers (with GSTIN, old dues) and suppliers, from Excel. Check the problem report, then Import.
2. Add services: Inventory → Add product → tick **This is a service**. Loading / unloading is SAC 996749 at 18%; add transport charges if you charge them.
3. **Opening stock and balances**, dated **1 April** (Accounts → Setup): stock count, cash in hand, customer and supplier balances.
   - Old non-paying dues: mark them "on hold" in Khata so they are kept only as a record.

### 5. Counters
1. On each counter PC or phone, open the server's address (shown in the black window), register it with its name ("Counter 1", "Counter 2", "Office"), and approve it in Settings → Counters.
2. Test print one bill on each counter's printer: A4, margins "Default", and "Background graphics" ticked so the shading prints.

### 6. Backups, before the first real bill
1. Settings → Data & backups → **Second copy (encrypted)**: choose a Google Drive folder (best) or a USB drive and a passphrase.
2. **Write the passphrase on paper and keep it at home.**
3. Press **Back up now** and check it says **Last copy OK**.

### 7. First day
1. Make a few real bills.
2. Look at the Dashboard and the Owner page in the evening.
3. Check that the 8:30 pm backup and summary appear.

Then follow the daily, weekly and monthly routine in [ADMIN-GUIDE.md](ADMIN-GUIDE.md). Staff use [STAFF-GUIDE.md](STAFF-GUIDE.md).

---

## G. Problems and fixes

| What you see | What to do |
|---|---|
| The other laptop or phone can't open the address | Same Wi-Fi? Laptop awake? Black window still open? Windows Defender Firewall → Allow an app → tick **Node.js** for Private. Make sure your Wi-Fi is set as a **Private** network (Settings → Network → Wi-Fi → your network → Private). |
| "Waiting for approval" on his device | Approve it in Settings → Counters on your laptop. |
| Address changed after a restart | The 192.168… number can change. Use the Tailscale address (doesn't change), or set a DHCP reservation in the router. |
| Black window says the database could not start | Wait 10 seconds and start it again. If it repeats, restart the laptop. |
| It went to sleep while he was testing | Set sleep to **Never** when plugged in (part A, step 5). |
