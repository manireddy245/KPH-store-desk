# Kanakapatnam Store Desk — Phase 0 decisions log

Status: planning. No app code written yet.

## Decided

| Topic | Decision |
|---|---|
| Architecture | **Option C (hybrid)**: shop server PC is the main database; a near-real-time copy is pushed to an online (cloud) database for owner access from anywhere + off-site backup |
| Database | PostgreSQL 17 — local on the shop server PC (primary) + online copy (provider pending) |
| Remote access | Tailscale (free) for full admin access to the shop server |
| Server PC | Shop will provide an existing PC (specs pending) |
| Invoice number | `KPH/26-27/000123` — one series per document type per financial year |
| Printers | Normal A4 printer only. Invoice layout: provisional until owner sends sample |
| Project folder | Desktop\KPH APP |

## Pending

- Cloud provider for the online copy (see options/costs in chat; pay nothing until owner approves)
- **Sales** turnover (purchases ≈ ₹4 crore/yr) — decides whether B2B e-invoicing (IRN) is mandatory (> ₹5 crore aggregate turnover). Confirm with CA.
- Server PC specs: Windows version, RAM, SSD/HDD, UPS
- Backup second location (Phase 7)
- Tally version used by CA
- Invoice print sample from owner

## Why C and not B

- Billing never depends on the shop's internet (counters talk to the shop server over Wi-Fi/LAN).
- One gapless invoice series and no overselling — B would need separate per-counter series and sync/conflict handling during outages.
- Owner still gets an online database: phone dashboard works from Chennai even when the shop PC is off; the cloud copy doubles as an off-site backup.
- If the shop server PC fails: hot-standby on a counter PC, or restore from the cloud copy.
