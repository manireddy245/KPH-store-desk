#!/usr/bin/env bash
# Kanakapatnam Store Desk — set up a fresh Ubuntu 24.04 cloud server (run once, as root).
#
#   bash setup-cloud.sh [web address]
#
# Web address: the name people type in the browser, e.g. desk.kanakapatnamstores.in.
# Without one it uses <ip>.sslip.io (a free name that points at this server's IP), so HTTPS
# works before a domain is bought. Run it again later with the real name to switch.
#
# What it does: Node.js 22 + pnpm, the app from GitHub in /opt/kph-store-desk, the data in
# /var/lib/kph-store-desk, a "storedesk" service that starts on boot and restarts if it stops,
# Caddy for HTTPS (free certificate, renewed by itself), and a firewall that only lets in
# SSH and the web.
set -euo pipefail

REPO=https://github.com/manireddy245/KPH-store-desk.git
APP=/opt/kph-store-desk
DATA=/var/lib/kph-store-desk
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
HOST=${1:-${IP//./-}.sslip.io}

[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
echo "== Store Desk will be at https://$HOST"

echo "== System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq curl git ufw debian-keyring debian-archive-keyring apt-transport-https gnupg

# 2 GB RAM is tight while building the web app: add swap once
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
corepack enable

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

echo "== App user and folders"
id storedesk >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/storedesk --shell /usr/sbin/nologin storedesk
mkdir -p "$APP" "$DATA"
chown storedesk:storedesk "$APP" "$DATA"
chmod 700 "$DATA"
# Real books, never the sample data (its PINs are in the public guide)
[ -f "$DATA/active-workspace.json" ] || echo '{"workspace":"live"}' > "$DATA/active-workspace.json"
chown storedesk:storedesk "$DATA/active-workspace.json"

echo "== Get and build the app"
if [ -d "$APP/.git" ]; then
  sudo -u storedesk git -C "$APP" pull --ff-only
else
  sudo -u storedesk git clone "$REPO" "$APP"
fi
cd "$APP"
sudo -u storedesk -H COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
sudo -u storedesk -H COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm build

echo "== Service"
cat > /etc/systemd/system/storedesk.service <<UNIT
[Unit]
Description=Kanakapatnam Store Desk
After=network-online.target
Wants=network-online.target

[Service]
User=storedesk
WorkingDirectory=$APP
Environment=KPH_DATA_DIR=$DATA
Environment=KPH_HOST=127.0.0.1
Environment=KPH_PORT=4000
Environment=KPH_PUBLIC=1
Environment=TZ=Asia/Kolkata
Environment=NODE_ENV=production
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ExecStart=/usr/bin/pnpm start
KillSignal=SIGINT
TimeoutStopSec=60
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable storedesk
systemctl restart storedesk

echo "== HTTPS"
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4000
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
		-Server
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "== Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "== Automatic security updates"
apt-get install -yq unattended-upgrades >/dev/null
timedatectl set-timezone Asia/Kolkata

echo "== Waiting for Store Desk to start"
for i in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4000/api/bootstrap >/dev/null 2>&1 && break
  sleep 2
done
systemctl --no-pager --lines=0 status storedesk | head -3
journalctl -u storedesk --no-pager | grep -o 'one-time setup code: [0-9]*' | tail -1 || true
echo
echo "Done: open https://$HOST"
