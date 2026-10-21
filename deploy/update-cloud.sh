#!/usr/bin/env bash
# Kanakapatnam Store Desk — bring the cloud server up to the latest version on GitHub (run as root).
# A backup is taken first. Billing stops for about a minute while it restarts.
set -euo pipefail
APP=/opt/kph-store-desk
cd "$APP"
echo "== Backup before updating"
sudo -u storedesk -H env KPH_DATA_DIR=/var/lib/kph-store-desk KPH_PORT=4000 pnpm backup || echo "(backup skipped: $?)"
echo "== Get the new version"
sudo -u storedesk git pull --ff-only
sudo -u storedesk -H pnpm install --frozen-lockfile
sudo -u storedesk -H pnpm build
systemctl restart storedesk
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4000/api/bootstrap >/dev/null 2>&1 && { echo "Store Desk is running: $(git log --oneline -1)"; exit 0; }
  sleep 2
done
echo "Store Desk did not come back — see: journalctl -u storedesk -n 50"
exit 1
