# Plan: run Store Desk on a cloud server (option C)

**Goal:** Store Desk and its database run together on a small rented server in India. The counters, the office and the owner's phone open it by a web address, from the shop or from anywhere.
- No shop server PC.
- No laptop that must stay on.

**Nothing has been signed up for or bought yet.** Every paid step below waits for the owner's OK.

---

## 1. What changes, and what doesn't

| | Today (local) | With the cloud server |
|---|---|---|
| Where Store Desk runs | Shop PC / your laptop | Rented server in Bangalore or Mumbai |
| Opening it | `http://192.168…:4000` in the shop | `https://` address (e.g. `https://desk.kanakapatnam.in`) from anywhere |
| Owner's phone away from shop | Needs Tailscale and the laptop on | Works on any internet |
| Internet in the shop | Not needed | **Needed for billing.** Keep a 4G hotspot as backup. |
| Speed of saving a bill | Instant | Instant on the server; each page click takes about 0.1 s more over the internet |
| Daily backup and summary | At 8:30 pm if the PC is on | At 8:30 pm every day (the server never sleeps) |
| Billing screens, bills, GST, Tally | Same | Same; no change for staff |

## 2. Choose a provider

| Provider | Server (2 GB memory, enough for this shop) | Notes |
|---|---|---|
| **DigitalOcean**, Bangalore | about **$12 / month** (+$2.40 for weekly server snapshots) | Simple, well documented. Billed in US dollars on an international card. |
| **AWS Lightsail**, Mumbai | about **$12 / month** | Amazon. Also USD. |
| **E2E Networks** (Indian company), Delhi or Mumbai | about **₹800–1,200 / month** | Billed in rupees with a **GST invoice**, so the shop may claim input tax credit. Ask the CA. |

**Recommendation:**
- **E2E Networks** if a GST invoice matters to you.
- **DigitalOcean Bangalore** otherwise (the easiest to set up and to get help with).

**Also needed:**
- **A web address (domain):** e.g. `kanakapatnam.in`, about **₹800–1,000 a year**. Optional: you can use a free subdomain or Tailscale-only access instead (see 3).
- **Rough total:** about **₹1,000–1,300 a month** plus the domain.

Prices from public pricing pages, October 2026. Check on the provider's page before paying.

## 3. Choose how people reach it

**Option 1: public web address with HTTPS (recommended for a shop).**
Anyone with the address sees the login screen, but can do nothing without both of these:
- **an approved device:** each new browser must be approved by the owner in Settings → Counters
- **a person's PIN:** repeated wrong PINs lock that person out for a while

I would add before going live:
- a **limit on attempts** (logins and device registrations per minute)
- **HTTPS only** (the address is encrypted, with an automatic certificate)

**Option 2: private, through Tailscale only.**
- The server has no public address. Only devices in your Tailscale network can open it, so it's safer.
- The catch: every counter PC and every phone needs the Tailscale app installed and signed in.

## 4. Work before moving (done by me, in the code, tested; nothing paid)

1. **Run on Linux:** cloud servers run Linux. Check the built-in database and the app start cleanly there, and test it all on a Linux test machine.
2. **Attempt limits:** cap logins, PIN approvals and device registrations per minute for each address, for the public internet.
3. **Ready-made server setup:** a setup script, the service that keeps Store Desk running and restarts it after a crash or reboot, and the HTTPS front door (Caddy, which renews its certificate by itself).
4. **Second backup copy in the cloud:** the server has no Google Drive folder. The encrypted second copy goes instead to cloud storage, either:
   - Google Drive through *rclone*, or
   - the provider's storage space.

   You can still download any backup from Settings.
5. **A "server status" check** that the provider can watch, so you get an e-mail if Store Desk ever stops.

## 5. Moving day (about 2 hours, best on a Sunday or after closing)

1. **You:** sign up with the chosen provider and buy the domain. I guide you screen by screen. You do the payment and passwords.
2. **Create the server:** Ubuntu, Bangalore or Mumbai, 2 GB. Turn on the provider's weekly snapshots.
3. **Install Store Desk** on it with the setup script. I can run the commands if you give me access to the server for that session.
4. **Point the domain** at the server. HTTPS switches on by itself.
5. **Move the data:** on the laptop, Settings → Data & backups → **Back up now** → **Download**. On the cloud server: Settings → Data & backups → **Restore** that file.
6. **Set up the second copy** (cloud storage) and press **Back up now**. It must say **Last copy OK**.
7. **Counters:** on each counter PC and phone, open the new address and register. You approve each one.
8. **Test:** make a test bill and a payment, print, check the Owner page from your phone on 4G, then cancel the test bill.
9. **The laptop or shop PC** is no longer needed as a server. Keep the old data folder for a month, just in case.

## 6. Running it

- **Shop internet:** keep the main connection plus a 4G hotspot (any phone) ready. If the internet drops, connect the counter to the hotspot and keep billing.
- **Backups:** daily at 8:30 pm on the server, plus the encrypted cloud copy, plus the provider's weekly snapshot. Download one to a USB drive once a month and keep it at home.
- **Updates:** I prepare the update and test it. It goes on the server after closing time, with a backup first.
- **Cost watch:** the provider e-mails a monthly invoice. Set a billing alert at ₹1,500.

## 7. Timeline

| When | What |
|---|---|
| This week | Code preparation (part 4) and tests, then practice run on a cheap test server for a few days with practice data |
| Before 1 April | Moving day (part 5) |
| 1 April | Go live with real data on the cloud server |

## Decisions needed from you

1. **Provider:** E2E Networks (rupee GST invoice) or DigitalOcean Bangalore (simplest).
2. **Access:** public address with HTTPS (easiest for staff), or private through Tailscale.
3. **Domain name:** e.g. `kanakapatnam.in`, `kphstore.in` (I'll check what's free), or no domain if you choose Tailscale.
