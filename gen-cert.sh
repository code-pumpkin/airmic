#!/usr/bin/env bash
# Generates a self-signed cert for the local desktop server (testing only)
# Mobile browsers require a SAN entry — CN alone is rejected since Chrome 58+
# For production use Let's Encrypt: certbot certonly --standalone -d yourdomain.com
set -e

# Detect local IP automatically, allow override: IP=1.2.3.4 bash gen-cert.sh
if [ -z "$IP" ]; then
  IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
  if [ -z "$IP" ]; then
    IP="127.0.0.1"
    echo "Warning: could not detect local IP, using 127.0.0.1"
    echo "Override with: IP=192.168.x.x bash gen-cert.sh"
  fi
fi

echo "Generating cert for IP: $IP"
mkdir -p certs

openssl req -x509 -newkey rsa:4096 \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -nodes \
  -subj "/CN=${IP}" \
  -addext "subjectAltName=IP:${IP},IP:127.0.0.1"

echo "Done — certs/key.pem and certs/cert.pem generated for ${IP}"
echo ""
echo "On your phone, open: https://${IP}:4000/<urlToken>"
echo "Accept the self-signed cert warning once, then it works."
