#!/bin/bash
# CareCircle on a single EC2 instance (Amazon Linux 2023, x86_64 or arm64).
# Paste into "User data" when launching the instance. It installs Node 24, builds
# the app, runs it as a systemd service on port 8787, and puts Caddy in front for
# automatic HTTPS on https://<public-ip-with-dashes>.sslip.io (no domain needed).
#
# Bedrock: attach an instance role whose policy allows bedrock:InvokeModel on
# arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0. No keys on disk.
set -euxo pipefail

REPO_URL="${REPO_URL:-https://github.com/Ohi-Me/CareCircle.git}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="24.12.0"
CADDY_VERSION="2.8.4"

ARCH=$(uname -m); [ "$ARCH" = "aarch64" ] && NARCH=arm64 || NARCH=x64; [ "$ARCH" = "aarch64" ] && CARCH=arm64 || CARCH=amd64

dnf install -y git tar xz python3.11 python3.11-pip
# Node (official binary; node:sqlite needs >= 22.13)
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NARCH}.tar.xz" | tar -xJ -C /opt
ln -sf /opt/node-v${NODE_VERSION}-linux-${NARCH}/bin/{node,npm,npx} /usr/local/bin/

useradd --system --create-home --home-dir /opt/carecircle carecircle || true
sudo -u carecircle git clone --depth 1 -b "$BRANCH" "$REPO_URL" /opt/carecircle/app
cd /opt/carecircle/app/web && sudo -u carecircle npm ci && sudo -u carecircle npm run build
cd /opt/carecircle/app/server && sudo -u carecircle npm ci --omit=dev
# OpenCV 5 vision service (pinned; manylinux wheels exist for x86_64 and aarch64/Graviton)
cd /opt/carecircle/app/vision && sudo -u carecircle python3.11 -m venv .venv && sudo -u carecircle .venv/bin/pip install -q -r requirements.txt
mkdir -p /opt/carecircle/data/refs /opt/carecircle/data/photos && chown -R carecircle /opt/carecircle/data

cat >/etc/systemd/system/carecircle.service <<'UNIT'
[Unit]
Description=CareCircle (MCP server + agent + web)
After=network-online.target
[Service]
User=carecircle
WorkingDirectory=/opt/carecircle/app/server
Environment=PORT=8787 DB_PATH=/opt/carecircle/data/carecircle.db WEB_DIST=/opt/carecircle/app/web/dist
Environment=AGENT_MODE=bedrock AWS_REGION=us-east-1 BEDROCK_MODEL_ID=amazon.nova-pro-v1:0 NODE_NO_WARNINGS=1
Environment=VISION_URL=http://127.0.0.1:8790 PHOTO_DIR=/opt/carecircle/data/photos
ExecStart=/usr/local/bin/node --import tsx src/index.ts
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /opt/carecircle/data && chown carecircle /opt/carecircle/data
cat >/etc/systemd/system/carecircle-vision.service <<'UNIT'
[Unit]
Description=CareCircle vision (OpenCV 5)
After=network-online.target
[Service]
User=carecircle
WorkingDirectory=/opt/carecircle/app/vision
Environment=VISION_REFS_DIR=/opt/carecircle/data/refs
ExecStart=/opt/carecircle/app/vision/.venv/bin/python -m uvicorn carecircle_vision.app:app --host 127.0.0.1 --port 8790
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now carecircle-vision carecircle

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
echo "CareCircle: https://${HOST}" > /etc/motd
