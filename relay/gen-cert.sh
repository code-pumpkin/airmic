#!/usr/bin/env bash
# Generates a self-signed cert for the relay server (testing only)
# For production use Let's Encrypt: certbot certonly --standalone -d yourdomain.com
set -e
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem \
  -days 365 -nodes -subj "/CN=relay"
echo "Done — certs/key.pem and certs/cert.pem generated"
