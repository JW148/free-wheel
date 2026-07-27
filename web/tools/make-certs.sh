#!/bin/bash
# Generates a local CA and a server certificate so the spike server can speak HTTPS.
#
# Why this is needed at all: OPFS is gated behind a secure context. `navigator.storage` is
# [SecureContext], so on a plain-HTTP LAN origin it is `undefined` and Phase 1 cannot run on
# a phone at all. Spike 1 did not care, because it touched no storage.
#
# A local CA rather than a tunnel keeps the 137 MB segment transfer on the LAN, which is both
# much faster and nobody else's traffic. The cost is trusting this CA on the test device.
#
# Everything lands in web/certs/, which is gitignored. The CA key never leaves this machine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$HERE/../certs"
DAYS=800   # iOS rejects server certs valid for more than 825 days

# Every IP the phone might reach this machine on, plus loopback for desktop testing.
IPS=$(ipconfig getifaddr en0 2>/dev/null || true)
IPS="${IPS:-}"

mkdir -p "$CERTS"
cd "$CERTS"

if [ ! -f ca.key ]; then
  echo "==> generating local CA"
  openssl genrsa -out ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
    -subj "/CN=free-wheel local CA/O=free-wheel dev" 2>/dev/null
else
  echo "==> reusing existing CA (delete web/certs to start over)"
fi

echo "==> generating server certificate"
{
  echo "[req]"
  echo "distinguished_name=dn"
  echo "req_extensions=ext"
  echo "prompt=no"
  echo "[dn]"
  echo "CN=free-wheel dev server"
  echo "[ext]"
  # iOS requires SAN (it ignores CN entirely) and serverAuth EKU.
  echo "basicConstraints=CA:FALSE"
  echo "keyUsage=digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  for ip in $IPS; do printf ',IP:%s' "$ip"; done
  printf '\n'
} > server.cnf

openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -out server.csr -config server.cnf 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 \
  -extfile server.cnf -extensions ext 2>/dev/null
rm -f server.csr

echo
echo "wrote $CERTS/{ca.crt,server.crt,server.key}"
echo "SANs: localhost, 127.0.0.1${IPS:+, $IPS}"
echo
echo "Next: npm run spike-server -- --https"
echo "Then on the phone, open  https://<lan-ip>:4173/ca.crt  to install the CA."
