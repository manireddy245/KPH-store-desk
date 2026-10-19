# Invoice scanner and purchases

Supplier bills now come into Store Desk as **purchases**. A purchase adds the items to stock at their cost, records what you owe the supplier, and keeps the bill (photo or PDF) for checking later. The scanner reads the bill for you; a person always checks it before anything is saved.

## Who can use it

Admin and **Stock staff** (Purchases menu). Stock staff can also add a new supplier. Only admin can create a brand-new product from a bill — stock staff pick an existing product or ask admin.

## One-time setup (admin)

1. Get a Gemini API key from Google AI Studio (aistudio.google.com → Get API key). Google charges per page read beyond the free allowance; a typical one-page bill costs a fraction of a rupee. Check current prices on Google's site.
2. Settings → Shop & billing → paste it into **Gemini API key** → Save. The key stays on the shop server; it never reaches the counters, phones or backups.
3. **Scanner model** is set to `gemini-3.8-flash`. Change it only if Google retires that model (the scanner will tell you).

The bill images are sent to Google for reading. If a bill must not leave the shop, use **Enter by hand** instead.

## On a phone (godown / delivery van)

1. Open Store Desk on the phone (same address as the counters, e.g. `http://192.168.1.82:4000` on the shop Wi-Fi). The first time, register it as e.g. "Godown phone" and approve it with the admin PIN.
2. Log in → **Purchases → Scan a supplier bill → Take a photo**. The camera opens. Photograph each page (up to 6) — flat, good light, all four corners visible.
3. Press **Read the bill**. After 10–30 seconds the review screen opens.

## On a PC

**Purchases → Scan a supplier bill → Choose photo or PDF file…** — pick the PDF the supplier emailed or a photo, then **Read the bill**.

## Checking the bill (review screen)

- **Supplier** is matched by GSTIN (or name). If it isn't found, press **+ New**.
- Each line shows what is printed on the bill and **our product**:
  - **Remembered** — matched the same way as last time for this supplier (most reliable)
  - **Item code** — the supplier's code equals our SKU
  - **Name match** — looks like the same product; please check
  - **Not matched** — choose our product, or (admin) **Create a new product**
- **Qty is in our unit.** If the supplier bills steel in tonnes and we stock kg, type the kg. The screen warns when units differ.
- **Amount excl. GST** is the line value before GST, after any discount — as printed. The cost per unit is worked out from it, and you are warned if it's more than 25% away from last time.
- Type the **bill's grand total**. Store Desk checks the lines add up: exact or within ₹10 (saved as round-off) lets you save; a bigger difference blocks saving until fixed.
- **Save purchase** adds the stock, updates the cost price, records the supplier balance, and remembers how this supplier names each product so the next scan matches automatically.

## Safety

- Nothing touches stock until **Save purchase**.
- The **same supplier bill number can't be saved twice**, and scanning a photo that was already used for a saved purchase shows a warning.
- A half-checked bill is kept on that screen even if the page is closed.
- Every scan and purchase is in the Activity log with user and device.
- **Cancel purchase** (from the purchase details) takes the stock off again and reverses the accounts; it needs the admin PIN for stock staff, and is refused if the goods have already been sold (use a stock adjustment; proper purchase returns come in Phase 2).

## Without internet

The scanner needs the internet; everything else doesn't. Use **Enter by hand** — the same review screen, empty.

## What I tested, and what I could not

- 19 automated tests: matching (sizes like 50kg/20L/12mm never match a different size), purchase stock and accounts, duplicate bills, round-off limit, permissions, cancel rules, and the scanner flow with a stand-in for Gemini.
- In the browser: the scan screen, the review screen (with a simulated scan), creating a new product from a line, saving, stock and cost updating, duplicate refusal, and the "no key" message.
- **Not tested: a real bill through Google Gemini** — there is no API key on this computer. Please scan two or three real supplier bills after adding your key and tell me how well it reads them.
