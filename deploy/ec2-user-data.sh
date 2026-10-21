#!/bin/bash
# CaringU on a single EC2 instance (Amazon Linux 2023, x86_64 or arm64).
# Paste into "User data" when launching the instance. It installs Node 24, builds
# the app, runs it as a systemd service on port 8787, and puts Caddy in front for
# automatic HTTPS on https://<public-ip-with-dashes>.sslip.io (no domain needed).
#
# Bedrock: attach an instance role whose policy allows bedrock:InvokeModel on
# arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0. No keys on disk.
set -euxo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ohi-Me/CaringU.git}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="24.12.0"
CADDY_VERSION="2.8.4"

ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && NARCH=arm64 || NARCH=x64; [ "$ARCH" = "aarch64" ] && CARCH=arm64 || CARCH=amd64

dnf install -y git tar xz python3.11 python3.11-pip
# Node (official binary; node:sqlite needs >= 22.13)
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NARCH}.tar.xz" | tar -xJ -C /opt
ln -sf /opt/node-v${NODE_VERSION}-linux-${NARCH}/bin/{node,npm,npx} /usr/local/bin/

useradd --system --create-home --home-dir /opt/caringu caringu || true
sudo -u caringu git clone --depth 1 -b "$BRANCH" "$REPO_URL" /opt/caringu/app
cd /opt/caringu/app/web && sudo -u caringu npm ci && sudo -u caringu npm run build
cd /opt/caringu/app/server && sudo -u caringu npm ci --omit=dev
# OpenCV 5 vision service (pinned; manylinux wheels exist for x86_64 and aarch64/Graviton)
cd /opt/caringu/app/vision && sudo -u caringu python3.11 -m venv .venv && sudo -u caringu .venv/bin/pip install -q -r requirements.txt
mkdir -p /opt/caringu/data/refs /opt/caringu/data/photos && chown -R caringu /opt/caringu/data

cat >/etc/systemd/system/caringu.service <<'UNIT'
[Unit]
Description=CaringU (MCP server + agent + web)
After=network-online.target
[Service]
User=caringu
WorkingDirectory=/opt/caringu/app/server
Environment=PORT=8787 DB_PATH=/opt/caringu/data/caringu.db WEB_DIST=/opt/caringu/app/web/dist
Environment=AGENT_MODE=bedrock AWS_REGION=us-east-1 BEDROCK_MODEL_ID=amazon.nova-pro-v1:0 NODE_NO_WARNINGS=1
Environment=VISION_URL=http://127.0.0.1:8790 PHOTO_DIR=/opt/caringu/data/photos
ExecStart=/usr/local/bin/node --import tsx src/index.ts
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /opt/caringu/data && chown caringu /opt/caringu/data
cat >/etc/systemd/system/caringu-vision.service <<'UNIT'
[Unit]
Description=CaringU vision (OpenCV 5)
After=network-online.target
[Service]
User=caringu
WorkingDirectory=/opt/caringu/app/vision
Environment=VISION_REFS_DIR=/opt/caringu/data/refs
ExecStart=/opt/caringu/app/vision/.venv/bin/python -m uvicorn caringu_vision.app:app --host 127.0.0.1 --port 8790
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now caringu-vision caringu

# HTTPS via Caddy + sslip.io hostname derived from the public IP (IMDSv2).
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
HOST="${IP//./-}.sslip.io"
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CARCH}.tar.gz" | tar -xz -C /usr/local/bin caddy
mkdir -p /etc/caddy && printf '%s {\n  reverse_proxy 127.0.0.1:8787 {\n    flush_interval -1\n  }\n}\n' "$HOST" >/etc/caddy/Caddyfile
cat >/etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
Restart=always
AmbientCapabilities=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now caddy
echo "CaringU: https://${HOST}" > /etc/motd
