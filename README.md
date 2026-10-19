# Kanakapatnam Store Desk

Billing, stock and accounts for Kanakapatnam Paints and Hardwares, Kavali.

- `packages/core` — money, GST, rounding, discount limits, numbering, permissions (shared by screens and server, fully tested)
- `apps/server` — Fastify API, built-in PostgreSQL, database migrations and safety rules
- `apps/web` — React screens (counters, office, owner phone)
- `docs/` — plans, decisions and the phase guides

Start here: [docs/PHASE1-GUIDE.md](docs/PHASE1-GUIDE.md) · Invoice scanner: [docs/SCANNER-GUIDE.md](docs/SCANNER-GUIDE.md) · Phase 2A: [docs/PHASE2A-GUIDE.md](docs/PHASE2A-GUIDE.md)

```bash
pnpm install
pnpm build
pnpm start
```
