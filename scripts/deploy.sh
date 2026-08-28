#!/usr/bin/env bash
# Deploy the public site (Cloud Run service xml-online-viewer, project xml-viewer-online).
#
# 1. Downloads the current GeoLite2-Country database into backend/geoip/ (key
#    from Secret Manager) so the Dockerfile bakes it into the image — one
#    MaxMind download per deploy instead of one per Cloud Run instance.
# 2. Runs `gcloud run deploy --source .` with the project flag set explicitly
#    and the COMPLETE env-var list (--set-env-vars replaces all plain env vars).
#
# Usage: scripts/deploy.sh            (from the repo root or anywhere)
#        SKIP_GEOIP=1 scripts/deploy.sh   (deploy without refreshing the DB)
set -euo pipefail

PROJECT=xml-viewer-online
REGION=europe-west1
SERVICE=xml-online-viewer
EDITION=GeoLite2-Country

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="backend/geoip/${EDITION}.mmdb"

if [[ "${SKIP_GEOIP:-}" != "1" ]]; then
  echo ">> fetching MaxMind license key from Secret Manager"
  KEY="$(gcloud secrets versions access latest --secret=xmlviewer-maxmind-license-key --project "$PROJECT" | tr -d '\n')"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo ">> downloading ${EDITION}"
  # -s: never echo the URL (it carries the key); query auth is what MaxMind offers for GeoLite.
  curl -fsSL --retry 3 --retry-delay 5 -o "$TMP/db.tar.gz" \
    "https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${KEY}&suffix=tar.gz"
  tar -xzf "$TMP/db.tar.gz" -C "$TMP" --wildcards "*/${EDITION}.mmdb"
  mkdir -p backend/geoip
  mv "$TMP"/*/"${EDITION}.mmdb" "$DEST"
  echo ">> $DEST ($(du -h "$DEST" | cut -f1))"
fi

[[ -s "$DEST" ]] || echo "!! $DEST missing — the image will fall back to a runtime download" >&2

# Plain env vars: --set-env-vars REPLACES the whole set, so every variable the
# service needs must be listed here. USAGE_DB_URL also serves the feedback
# store (FEEDBACK_DB_URL is only an override, see backend/app/config.py).
ENV_VARS='LOG_LEVEL=INFO'
ENV_VARS+=',MAX_UPLOAD_MB=50'
ENV_VARS+=',MAX_ZIP_ENTRIES=2000'
ENV_VARS+=',MAX_ZIP_UNCOMPRESSED_MB=200'
ENV_VARS+=',MAX_XML_NODES=500000'
ENV_VARS+=',CACHE_TTL_MIN=60'
ENV_VARS+=',CACHE_MAX_ENTRIES=64'
ENV_VARS+=',FETCH_MAX_RESPONSE_MB=10'
ENV_VARS+=',USAGE_DB_URL=postgresql://xmlviewer@62.238.116.11:5432/xmlviewer_stats?sslmode=require'

SECRETS='USAGE_DB_PASSWORD=xmlviewer-feedback-db-password:latest'
SECRETS+=',USAGE_HASH_SECRET=xmlviewer-usage-hash-secret:latest'
SECRETS+=',MAXMIND_LICENSE_KEY=xmlviewer-maxmind-license-key:latest'

echo ">> deploying $SERVICE to $PROJECT/$REGION"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated --ingress all \
  --memory 1Gi --cpu 1 --concurrency 20 --max-instances 5 --timeout 120 \
  --set-env-vars "$ENV_VARS" \
  --update-secrets "$SECRETS"
