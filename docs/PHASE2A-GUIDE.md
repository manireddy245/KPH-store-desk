# Phase 2A — prices incl./excl. GST, units, GST invoices, returns

## What's new

### Prices including or excluding GST
- **Products** keep their price either way: a switch next to the price (*Excl. GST | Incl. GST*) shows the other value instantly (₹1,180 incl. = ₹1,000 + ₹90 + ₹90).
- **Billing**: under the items, *Prices typed: Excl. GST | Incl. GST* sets the whole bill; each line has a small switch under its rate to change just that line.
- **Exact totals**: when prices are typed including GST, the bill total is exactly what was typed. The taxable value is worked back, CGST and SGST stay equal, and the few paise left over go into round-off. Tested on 2,000 random bills.
- **Purchases**: *Line amounts on the bill are: Before GST / Including GST*.
- Defaults for both: Settings → GST & invoices.

### Units — steel by the rod, bought by the tonne
- A product's stock is kept in one unit (TMT bars: **rod**). Under **Other units** in the product form you add, for example, *tonne* with "rods in 1 tonne" = 94. A hint shows the standard number for the bar size (12 mm ≈ 94 for 12 m rods); use your own figure.
- **Purchases**: pick *tonne* on the line and type 5 → it shows "= 470 rods". If you counted a different number off the lorry, type it in **counted** and that is what goes into stock. The cost per rod is worked out from the bill.
- **Billing**: rods are sold by count. If a product has a sale unit (e.g. wire: coil = 90 m), a unit picker appears under the quantity; a unit can have its own price.
- A product's base unit can't be changed once it has stock (that would corrupt the stock figures).
- **Paint packs** stay separate products (1L, 4L, 10L, 20L). The new *Pack contents in litres* field feeds the litre reports in later phases.

### GST-compliant invoices
- **Customer GSTIN** is now checked including its check digit (the last character). The customer's state is taken from it.
- **Place of supply** (billing screen, under Payment): automatic — a business customer's GSTIN state, otherwise Andhra Pradesh. Another state switches the bill to **IGST** automatically.
- **Rules enforced** (screen and server):
  - a business (GSTIN) customer must have an address;
  - a bill of ₹50,000 or more to an unregistered customer needs name and address (walk-in address field added).
- **Invoice print**: HSN-wise tax summary, IGST when inter-state, place of supply with state name, "Reverse charge: No", B2B tag, *rate includes GST* marker, labels in **English + Telugu** (Settings → GST & invoices), and **1 / 2 / 3 copies** (Original / Duplicate for transporter / Triplicate for supplier).

### Returns
- **Sales return (credit note)**: Sales → open a bill → **Return items…** → quantities per line, *back to stock* (untick for damaged goods — written off with a note), reason, and money back: *credit to the customer's account* or *cash / UPI / bank / card refund*. Numbered CN/26-27/000001, printable, linked to the bill. Counter staff need the admin PIN. A line can be returned in parts; the parts always add up exactly to the original.
- **Purchase return (debit note)**: Purchases → open a purchase → **Return to supplier…** → quantities and reason. Stock goes out, the supplier's balance and input GST go down. Numbered DN/26-27/000001.
- A bill or purchase that has returns can't be cancelled (use further returns instead).

### GST month lock
- Settings → GST & invoices → **GST months**: after your CA files GSTR-1, press *Mark filed* (you can note the ARN). Bills of that month can then no longer be cancelled — only corrected with credit notes. *Re-open* exists for mistakes and is logged.

### Also fixed
- Start-up now recovers by itself if the server was stopped suddenly and left the database half-running (this happened during testing and is now handled).
- Sample data now uses valid GSTINs and steel in rods; a test loads the whole sample set every run.
- Product search ranks words that start a word first.

## How to try it (about 15 minutes)

To get the new sample data (steel in rods, tonne units), stop Store Desk and run:

```bash
pnpm db:reset-sample
```

Then `pnpm start`, register the computer, and log in as Guru Mani (sample PIN 1234).

1. **Inclusive price**: Billing → switch *Prices typed* to *Incl. GST* → add cement, type rate 371.70 and 50 bags → amount ₹18,585.00 exactly; open the line to see the taxable value worked back.
2. **Rods**: add *TMT 12mm rod*, quantity 20 → stock goes down by 20 rods.
3. **Buying in tonnes**: Purchases → Enter by hand → supplier JSW → TMT 12mm → unit *tonne*, qty 5 → "= 470 rods"; type 468 in *counted* → save → stock up by 468.
4. **IGST**: Customers → add a business with GSTIN `27AAPFU0939F1ZV` and an address → bill them → the summary shows IGST; print → IGST, B2B, place of supply Maharashtra (27). Try a wrong last character in the GSTIN — it is refused.
5. **₹50,000 rule**: a walk-in bill over ₹50,000 can't be saved until name and address are typed.
6. **Sales return**: Sales → that bill → Return items… → 10 bags, credit to account → print the credit note; the customer's balance goes down.
7. **Damaged return**: return 1 item from another bill with *back to stock* unticked → stock card shows "returned" then "written off".
8. **Purchase return**: Purchases → the TMT purchase → Return to supplier… → 10 rods → debit note; supplier balance down.
9. **Month lock**: Settings → GST & invoices → mark this month filed → try to cancel a bill → refused, use Return items → then *Re-open*.
10. **Telugu labels / copies**: print any bill, choose 3 copies.

## Decisions made (tell me if you want any changed)

- Prices excluding GST stay the default for new bills and purchases (changeable in Settings).
- An incl.-GST price on an excl.-priced product is accepted at its converted rate without the admin PIN; any other rate change needs admin.
- Credit notes are rounded to the rupee like bills, except a return of everything left on a bill, which refunds exactly what remains of that bill.
- Damaged returns are first booked back into stock, then written off with an adjustment, so the stock card shows both steps.
- Telugu wording on the invoice (పన్ను బిల్లు, కొనుగోలుదారు, …) — please check it reads naturally for your customers.
- Your own invoice layout is still pending; when you send it I'll match the print to it.

## Tests

120 automated tests (45 core + 75 server). New in this phase: inclusive-price totals on 2,000 random bills, GSTIN check digits, unit conversions, rods from tonnes and counted overrides, unit locking, IGST, the B2B and ₹50,000 rules, partial/full/damaged returns adding up exactly, walk-in cash refunds, debit notes, month lock, and the full sample data loading.

## Still to come in Phase 2B

E-way bill helper, GSTR-1 and GSTR-3B Excel exports, sales/purchase registers, and the discount report per staff member and product.
