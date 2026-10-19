# Phase 5: painters, masons and trade partners

**Partners** in the top menu. They are kept separate from customers. Counter staff can add partners and tag them on bills. Only admin can set rewards and pay them out.

## What's new

**Partners**
- Fields: name, phone, area, type, joined date, notes, message language, active.
- Types: Painter, Mason, Contractor, Plumber, Electrician and Engineer. Admin can add more (Partners → Types & rewards).
- The partner list shows each partner's bills and sales this month, their last bill (and how many days ago), and the reward due.

**Tagging a bill**
- The billing screen has a new box, **Brought by (painter, mason…)**. Search the partner and, if they have sites, pick the site.
- The paying customer stays separate. For example, the customer is the house owner and the partner is the painter who brought them.
- A bill made without a partner can be tagged later: Sales → open the bill → **Tag the painter / mason…** (once per bill).

**Partner page.** Click a partner to see:
- **What they bring**: sales by category and brand for any dates, after returns. Paint also shows litres (e.g. 6 buckets = 120 litres).
- **Bills**: every tagged bill, with returns shown.
- **Notes**: a dated timeline, optionally about a bill or a site. For example, "Bought 20L Birla Opus exterior for Reddy's house, shade 7034".
- **Sites**: house or project name, address and owner, with each site's bills and sales. Mark a site *Finished* when the work is done.
- **Rewards**: what they've earned, what was taken back, payouts and gifts.
- **Shades**: paint shade records (paint, base, tint/formula, shade code and name, quantity, site), so repeat orders match exactly.

**Rewards** (Partners → Types & rewards, admin only)
- For each partner type, a reward can be:
  - a **% of the bill** (before GST), or
  - **₹ per unit** (per bag, per bucket, per rod…), for one category or for all other items.
  - A category rule beats the general rule.
- A tagged bill earns the reward straight away, worked out with the rules at that moment.
- Returns take back exactly the reward on the returned part. A cancelled bill takes back the whole reward.
- **Pay out** in cash or from the bank: it is booked as an expense under **Partner Commission**, with an EXP number.
- **Gift**: recorded against the reward balance, with no money entry.

**Reports**
- **Top this month**: partners ranked by sales.
- **Gone quiet**: partners with no bill for 30–59, 60–89 or 90+ days, or none at all. Worth a phone call.
- **Paint shades**: search every saved shade by code, name, partner or customer.
- The Excel download includes partner-wise sales by category.

## Defaults I chose (tell me if you want them changed)
- Rewards start at zero for every type; admin sets them. In the sample data, painters get 2% and masons 1%.
- One partner per bill.
- Counter staff can add partners, tag bills, and add notes, sites and shades. Rules and payouts are admin only.

## Sample data
The new sample partners (Raju, Venkat Rao, Subbaiah, Krishna) and their tagged bills appear only after a sample reset. That clears the practice workspace, including any practice entries. To do it, stop Store Desk and run:

```bash
pnpm db:reset-sample
```

The live workspace is never touched.

## Tests
- Reward rules: admin only, one rule per category.
- Earning on bills, exact take-back on returns and cancellation, tagging once.
- Payouts booked as an expense to Partner Commission, and gifts.
- Notes (a note can only point to the partner's own bills), sites and shades.
- Top and gone-quiet reports.
