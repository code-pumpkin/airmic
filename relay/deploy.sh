#!/usr/bin/env bash
# deploy.sh — sets up the relay on a fresh Ubuntu/Debian VPS
# Run as root: bash deploy.sh
set -e

INSTALL_DIR=/opt/wireless-mic-relay
NODE_MIN=18

echo "==> Checking Node.js..."
if ! command -v node &>/dev/null || [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -lt "$NODE_MIN" ]; then
  echo "==> Installing Node.js $NODE_MIN..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN}.x | bash -
  apt-get install -y nodejs
fi

echo "==> Copying files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp relay.js package.json package-lock.json "$INSTALL_DIR/"

# Copy public/ — check relay/public/ first, then fall back to ../public/
if [ -d "public" ]; then
  cp -r public "$INSTALL_DIR/"
elif [ -d "../public" ]; then
  cp -r ../public "$INSTALL_DIR/"
else
  echo "WARNING: no public/ directory found — phones won't get index.html from relay"
  echo "         Copy your public/ folder next to relay.js on the VPS manually"
fi

echo "==> Installing dependencies..."
npm install --omit=dev --prefix "$INSTALL_DIR"

echo "==> Setting up certs..."
if command -v certbot &>/dev/null; then
  echo "    certbot found — use: certbot certonly --standalone -d yourdomain.com"
  echo "    Then set CERT_DIR=/etc/letsencrypt/live/yourdomain.com in the service file"
else
  echo "    No certbot — generating self-signed cert (dev only)..."
  mkdir -p "$INSTALL_DIR/certs"
  openssl req -x509 -newkey rsa:4096 \
    -keyout "$INSTALL_DIR/certs/key.pem" \
    -out    "$INSTALL_DIR/certs/cert.pem" \
    -days 365 -nodes -subj "/CN=relay"
fi

echo "==> Installing systemd service..."
cp wireless-mic-relay.service /etc/systemd/system/
sed -i "s|/opt/wireless-mic-relay|$INSTALL_DIR|g" /etc/systemd/system/wireless-mic-relay.service
systemctl daemon-reload
systemctl enable wireless-mic-relay
systemctl restart wireless-mic-relay

echo ""
echo "Done. Relay is running on port 4001."
echo "Check status: systemctl status wireless-mic-relay"
echo "View logs:    journalctl -u wireless-mic-relay -f"
