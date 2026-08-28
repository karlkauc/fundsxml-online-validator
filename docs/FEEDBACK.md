# User feedback (POST /api/feedback)

The 💬 Feedback dialog in the header posts to `POST /api/feedback`
(`backend/app/api/feedback.py`, 5 requests/min/IP, honeypot field `website`).
Message + optional e-mail, the SPA path, loaded XML/XSD file names, an error
detail (when opened from an error), user agent and app version are stored.
**No IP address, no file contents.**

- `USAGE_DB_URL` (or the legacy override `FEEDBACK_DB_URL`) set ⇒ rows go to
  the Postgres `feedback` table (`backend/sql/feedback.sql`, store in
  `backend/app/usage/feedback.py`). Since usage tracking was added
  (`docs/USAGE_STATS.md`) the row also carries `visitor_hash`, `country_code`
  and `device` — the same anonymised visitor columns as `usage_event`
  (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the end of `feedback.sql`
  and in `usage_stats.sql`).
- Not set (local dev, tests) ⇒ the feedback is written to the application log
  at WARNING level (`"user feedback (no FEEDBACK_DB_URL configured)"`).

## Production database

Shared **PostgreSQL 18** on the Hetzner VPS `tanzapp-prod` (62.238.116.11),
same pattern as the XSD viewer:

- DB `xmlviewer_stats`, role `xmlviewer` (owner). Password in
  `/home/deploy/xmlviewer-db-password.txt` on the server and in Secret Manager
  `xmlviewer-feedback-db-password` (project `xml-viewer-online`).
- `pg_hba.conf`: `hostssl xmlviewer_stats xmlviewer 0.0.0.0/0 scram-sha-256`
  (+ `::/0`) — TLS, this DB/role only. ufw already opens 5432/tcp;
  fail2ban jail `postgresql` bans after failed logins.
- Backups: Hetzner VM snapshots (daily, 7 rolling).

### One-time setup (done 2026-08-26; repeat for a new environment)

```bash
# on the VPS
openssl rand -base64 30 | tr -d "/+=" | cut -c1-32 > /home/deploy/xmlviewer-db-password.txt
sudo -u postgres psql -c "CREATE ROLE xmlviewer LOGIN PASSWORD '…';" \
                      -c "CREATE DATABASE xmlviewer_stats OWNER xmlviewer;"
printf "hostssl xmlviewer_stats xmlviewer 0.0.0.0/0 scram-sha-256\nhostssl xmlviewer_stats xmlviewer ::/0 scram-sha-256\n" \
  | sudo tee -a /etc/postgresql/18/main/pg_hba.conf && sudo systemctl reload postgresql
PGPASSWORD=… psql -h 127.0.0.1 -U xmlviewer -d xmlviewer_stats -f backend/sql/feedback.sql

# GCP secret + service config (no rebuild needed)
gcloud services enable secretmanager.googleapis.com --project xml-viewer-online
gcloud secrets create xmlviewer-feedback-db-password --data-file=- --project xml-viewer-online
gcloud secrets add-iam-policy-binding xmlviewer-feedback-db-password --project xml-viewer-online \
  --member serviceAccount:239650873304-compute@developer.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor
gcloud run services update xml-online-viewer --project xml-viewer-online --region europe-west1 \
  --update-env-vars 'FEEDBACK_DB_URL=postgresql://xmlviewer@62.238.116.11:5432/xmlviewer_stats?sslmode=require' \
  --update-secrets 'FEEDBACK_DB_PASSWORD=xmlviewer-feedback-db-password:latest'
```

Note: `gcloud run deploy … --set-env-vars …` **replaces** all plain env
vars. Deploy with `scripts/deploy.sh`, which carries the complete list; since
the usage-tracking rollout the DSN is passed as `USAGE_DB_URL` and the password
as `USAGE_DB_PASSWORD` (same secret `xmlviewer-feedback-db-password`) — the
feedback store falls back to those, `FEEDBACK_DB_*` remain optional overrides.

## Reading feedback

```bash
pip install --user "psycopg[binary]"
python3 tools/feedback_report.py                 # totals, per day, pages, latest 20
python3 tools/feedback_report.py --days 30 --full # last 30 days, full message text
```

Password comes from `$FEEDBACK_DB_PASSWORD` / `$PGPASSWORD` or, if unset,
from Secret Manager via `gcloud`. Direct access:
`psql "postgresql://xmlviewer:…@62.238.116.11:5432/xmlviewer_stats?sslmode=require"`.
