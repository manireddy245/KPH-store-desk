# Phase 6B: smart stock, purchase orders, stock count, counter closing

## Stock page (top menu → Stock)

### Reorder
- At the top:
  - items that will **run out in 3 or 7 days**
  - **fast movers below their target**
  - **newly dead stock**
  - **money stuck in slow and dead stock**
- The list shows what to reorder. Each line explains itself, for example:

  > sold 120 bags in the last 30 days; sells about 4 a day; 15 in stock; about 3 days left; supplier takes 3 days; target 15 days of stock

- **How the suggestion is worked out:**
  - average daily sale × (supplier's delivery days + target days), less what is in stock and already on order
  - "**order now**" means the stock won't last until a new delivery arrives
- A fast mover is warned earlier than a slow one with the same stock, because the warning is based on days left, not a fixed quantity.
- Tick items, set quantities and suppliers, then **Make draft orders**. You get one purchase order per supplier. **Nothing is ever ordered on its own.**

### Slow & dead
- **Slow**: sells well below similar items in its category.
- **Dead**: no sale for 60 days.
- Each item shows the money stuck at cost and its last sale.
- Choose what to do: don't reorder, run an offer, tell painters/masons, return to supplier, or keep. The choice is remembered, and "Don't reorder" removes the item from suggestions.
- Also shows **movement changes**: items that sped up or slowed down compared with the 30 days before.

### All items
Every item with its movement, stock, sales, daily rate, days left and value. Excel download included.

### Purchase orders
- Open a draft, change quantities, then **Send on WhatsApp**. The supplier's number is used if saved, and the message lists the items.
- Print the order, mark it received, or cancel it.
- Quantities on open orders count as "on order" in the suggestions.

### Stock count (audit)
1. Start a count, for all items or one category.
2. Type what is on the shelf; it saves as you go.
3. Differences show straight away. Each needs a reason: damaged, leakage, shortage, found, wrong entry or other.
4. **Close count & adjust stock** posts one adjustment per difference, with its reason.

The book figure is taken at the moment of counting, so bills made during the count don't confuse it. Only stock staff and admin can count.

## Other screens
- **Dashboard → Stock update**: the daily summary above. On Mondays it also shows the week's changes and the total value of slow and dead stock.
- **Purchases**: buying a slow or dead item beyond its usual level shows a warning on that line.
- **Accounts → Close counter**: the day-end closing for this counter.
  - **Totals**: bills, UPI, card, credit given and payments collected.
  - **Cash that should be in the drawer** = float + cash bills + cash collected − cash refunds − cash paid out.
  - Type the cash counted and close; any difference is recorded.
  - Staff-wise sales are shown too.
  - Admin sees every counter's closings.

## Settings
These can be changed by admin:
- sales period looked at: 30 days
- dead after: 60 days without a sale
- target days of stock: 15, settable per category
- supplier delivery days: 3 by default, or the supplier's own lead time

Once a year of sales exists, suggestions are adjusted by the same season last year (for example, the festival months).

Barcodes and labels are not in this version. Product codes (SKU) are already unique, so they can be added later.

## Tests
- **Calculations:**
  - fast, normal, slow, dead and new
  - days left
  - reorder amounts, including what is already on order
  - fast movers warned earlier than slow ones
  - the season adjustment
- **Insights:** checked with 120 bags sold over 30 days, a supplier who takes 3 days, and a 15-day target.
- **Dead stock:** never suggested for reorder, and decisions are remembered.
- **Purchase orders:** one per supplier, editable while a draft, then sent.
- **Stock count:** the book figure is fixed when counting, every difference needs a reason, and closing posts the adjustments.
- **Counter closing:** expected cash and differences, and the staff totals.
