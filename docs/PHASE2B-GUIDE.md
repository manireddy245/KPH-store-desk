# Phase 2B: GST returns, registers, discounts, e-way bills

All of it is under **Reports** in the top menu. It needs the *reports* permission, which admin has.

At the top, pick a **month**, a **quarter** (Q1 is Apr–Jun) or **dates**. The page opens on last month, because returns are filed for the month that just ended. Every tab has **Download Excel**.

## GSTR-1

The screen shows each GSTR-1 table with its total:

| Table | What goes in it |
|---|---|
| **B2B (4A)** | Bills to customers with a GSTIN, one row per bill per tax rate |
| **B2C large (5)** | Bills to another state, to a customer without a GSTIN, over ₹1,00,000 |
| **B2C others (7)** | All other retail sales, totalled by state and rate. Returns on these bills are already taken off. |
| **Credit notes (9B)** | Returns on B2B bills (CDNR) and on B2C-large bills (CDNUR) |
| **HSN summary (12)** | Split into B2B and B2C. Quantities are in GST unit codes: bag → BAG, rod → NOS, litre → LTR, tonne → MTS. |
| **Documents (13)** | Invoice and credit-note number ranges, with how many were cancelled |

**Excel**: the sheet names and headings copy the GST offline tool's Excel template (b2b,sez,de · b2cl · b2cs · cdnr · cdnur · hsn(b2b) · hsn(b2c) · docs), so your CA can import it or paste from it.

Warnings at the top of the page point out:
- items sold with no HSN code (fix them in Inventory)
- HSN codes shorter than 4 digits
- a B2C total that comes out negative

## GSTR-3B

- **3.1(a)**: sales less credit notes, with taxable value, IGST, CGST and SGST.
- **3.2**: sales to other states for customers without a GSTIN, by state.
- **4(A)(5)**: input tax credit from purchase bills, by supplier bill date, less debit notes.
- A rough figure for the tax to pay in cash. The GST portal applies the exact set-off rules.

## Registers

- **Sales register**: every bill, cancelled ones included (struck out, shown as zero), plus credit notes. Columns: customer, GSTIN, tax, total, discount, e-way bill number, staff.
- **Purchase register**: supplier bills by **bill date**, with our PUR number and the date entered, plus debit notes.

## Discounts

- **By staff member**: bills, gross sales, discount and discount %, plus how many lines went above the limit with the admin PIN.
- **By product**: quantity, discount, average and highest %.
- **Above the limit**: each line approved with the admin PIN. Shows who gave it, who approved it, and the limit.

## E-way bills

Bills whose goods value (taxable plus GST) is over **₹50,000** show **E-way bill needed…** in Sales → open the bill. The same bills are listed in Reports → **E-way bills**.

1. In the window, fill in the delivery town, PIN code, distance and vehicle number. A transporter ID is only needed if a transporter carries the goods.
2. Press **Download JSON for the portal**.
3. On ewaybillgst.gov.in: e-Waybill → **Generate Bulk** → choose the file. Check the result on the portal.
4. Type the 12-digit e-way bill number back in and **Save**. It then prints on the invoice, with the vehicle number.

If no e-way bill was needed (for example, the customer collected the goods in their own vehicle), tick **No e-way bill for this bill** and give the reason.

Store Desk does not connect to the portal itself. That needs a paid GSP account; we can add it later if you want.

First, in Settings → Shop & billing, check:
- your **GSTIN**
- **Town**: Kavali
- **PIN code**: 524201

## Fixed in this phase

**Bills could not be saved from the billing screen.** The Phase 2A update had a typo in the place-of-supply check, so the server refused every bill the screen sent. It is fixed, and the new tests save bills through that same check.

## Please check with your CA

- **B2C large**: the ₹1,00,000 limit is the rule from 1 Aug 2024.
- **Credit notes**: a credit note on an ordinary retail bill is netted into B2C others in the month the note is issued.
- **E-way bills**: the ₹50,000 limit is used for trips inside Andhra Pradesh too. Your CA can say if any local trips are exempt.
- **Quarterly filing (QRMP)**: if you file quarterly, use the **Quarter** period. The monthly IFF is the B2B table of the same report for that month.
- **Input tax credit**: GSTR-3B counts it from the bills entered here. Claim only what appears in GSTR-2B.
- **Not covered yet**: purchases from unregistered dealers, exempt or nil-rated items, and reverse charge.

## Tests

149 automated tests (53 core + 96 server). New in this phase:
- a fixed set of bills is checked table by table: B2B, B2CL, B2CS with returns taken off, CDNR, CDNUR and the HSN quantities
- the Excel sheet names and headings
- GSTR-3B totals net of returns, and input tax credit by bill date
- the registers and the discount figures
- e-way bill rules (₹50,000, vehicle number checks) and the full portal JSON
- the e-way bill number showing on the bill afterwards
