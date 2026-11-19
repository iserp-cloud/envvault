#!/usr/bin/env bash
# Make a self-signed certificate for a hub reached by IP or hostname (no domain, no public CA).
#
#   scripts/self-signed-cert.sh 10.0.0.5 10.0.0.6 [more IPs or hostnames…]
#
# Writes to ./envvault-tls (override with OUT=dir):
#   tls.crt   the certificate. Not secret. The CLI remembers it on first connect; for a browser,
#             trust it once (import into the OS or browser certificate store).
#   tls.key   its PRIVATE key. Never commit or share it.
# Every address people will type must be listed: clients reject an address the certificate lacks.
# Then run the hub with ENVVAULT_TLS_CERT=envvault-tls/tls.crt ENVVAULT_TLS_KEY=envvault-tls/tls.key.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <ip-or-hostname> [more…]" >&2
  exit 1
fi

OUT="${OUT:-envvault-tls}"
DAYS="${DAYS:-800}" # macOS/iOS reject server certificates valid for longer than 825 days
[ -e "$OUT/tls.key" ] && { echo "$OUT/tls.key already exists; remove $OUT or set OUT=other-dir" >&2; exit 1; }
mkdir -p "$OUT"
umask 077

san=""
for host in "$@"; do
  if [[ "$host" =~ ^[0-9.]+$ || "$host" == *:* ]]; then san+="IP:$host,"; else san+="DNS:$host,"; fi
done
san="${san%,}"

openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/tls.key"
openssl req -x509 -new -key "$OUT/tls.key" -sha256 -days "$DAYS" -subj "/CN=EnvVault hub" \
  -addext "subjectAltName=$san" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=serverAuth" \
  -out "$OUT/tls.crt"
chmod 600 "$OUT/tls.key"
chmod 644 "$OUT/tls.crt"

echo "Created $OUT/tls.crt and $OUT/tls.key for: ${san//,/, }  (valid $DAYS days)"
echo "SHA-256 fingerprint: $(openssl x509 -in "$OUT/tls.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
echo
echo "Run the hub with ENVVAULT_TLS_CERT=$OUT/tls.crt ENVVAULT_TLS_KEY=$OUT/tls.key (it logs the same fingerprint)."
echo "CLI: envvault remote set https://<address>:<port>   (it remembers the certificate on first connect)"
