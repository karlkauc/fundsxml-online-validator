# Anonymous usage statistics

The public site records **aggregate, anonymous** usage so the viewer can be
improved based on real use: how many people load XML documents and schemas,
from where, how big they are, how long parsing/validation takes and how often
it fails. Document/schema **content is never stored**, and the raw client IP
is neither stored nor logged.

The feature is **off by default** — it only activates when `USAGE_DB_URL` is
set. Self-hosted installs without it record nothing.

The implementation (`backend/app/usage/`) is a port of the XSD viewer's
module; the `usage_event` table has the **same columns** in both apps so one
dashboard can query both databases. Only the event types and the meaning of
a few columns differ.

## What is collected

One row per event in table `usage_event` (DDL: `backend/sql/usage_stats.sql`):

| Column | Meaning |
|---|---|
| `event_type` | `page_view` (SPA shell served), `xml_load`, `xsd_load`, `validate`, `export` |
| `visitor_hash` | `sha256(daily_salt ‖ ip ‖ user-agent)[:32]`; salt = `HMAC(USAGE_HASH_SECRET, date)` ⇒ same visitor within a day, unlinkable across days, not reversible |
| `country_code` | ISO-3166-1 alpha-2 derived server-side via MaxMind GeoLite2; NULL if unknown |
| `user_agent`, `device` | UA string (≤255) and a cheap classification `desktop`/`mobile`/`bot`/`unknown` |
| `referrer` | `scheme://host/path` of the `Referer` header, query dropped |
| `path` | page_view only — SPA path served. Only routes in `SPA_ROUTES` (`backend/app/main.py`: `/`, `/index.html`, `/fundsxml`) emit a page_view; any other unknown path is answered with 404 and **not** recorded, so scanner probes (`/wp-admin/install.php`, `/.env`, …) never reach the table. `/go/freexmltoolkit` with `source=freexmltoolkit` and `status_code=302` is an outbound click on a FreeXmlToolkit link (counted redirect, see `app/api/go.py`). |
| `source` | `xml_load`: `upload`/`text`/`url`; `xsd_load`: the same plus `release` (FundsXML GitHub release) and `auto` (schema detected from the document's `xsi:schemaLocation`); `export`: `excel`; `validate`: NULL (both inputs come from the cache) |
| `schema_name` | `xml_load`: XML file name (upload/text: **basename**; url: URL without query); `xsd_load`: XSD main file (release: `tag/file`); `validate`/`export`: XSD main file |
| `input_bytes` | size of the parsed input (release: sum of all fetched XSD assets; validate: the cached XML) |
| `file_count` | `xsd_load`: number of files in the schema set; `xml_load`: 1 |
| `element_count` | `xml_load`: `node_count` of the document |
| `error_count` | `validate`/`export`: number of validation errors |
| `duration_ms`, `status`, `status_code`, `error_detail` | timing and outcome (`ok`/`invalid`/`parse_error`/`rejected`); `error_detail` is the exception message, ≤255 chars |
| `target_namespace`, `type_count`, `diagnostic_count` | always NULL here (kept for column parity with the XSD viewer) |
| `app_version`, `received_at` | build version, server timestamp |

Status semantics: `rejected` = size limit, SSRF guard, unknown/expired cache
id or unknown release; `parse_error` = malformed XML / XSD compile error;
`invalid` = validation ran and found errors.

Not tracked: `GET /api/xml/{id}` (cache read) and the FundsXML release
listing.

### Feedback

`POST /api/feedback` writes one row per message to table `feedback`
(`backend/sql/feedback.sql`): `message`, optional `email`, `page`, `xml_name`,
`xsd_name`, `error_detail`, plus the same `visitor_hash`, `country_code`,
`user_agent`, `device`, `app_version` as above. Without a database the
feedback is logged at WARNING level instead (see `docs/FEEDBACK.md`).

**Never collected:** XML/XSD content, raw IP, cookies, anything from the
browser beyond the standard request headers. There is no client-side tracking
script (the CSP forbids one anyway).

## Architecture

```
request → request_logging middleware binds RequestUsage(ip, ua, referrer)
        → router calls emit("xml_load", …)          (app/usage/context.py)
        → UsageRecorder queue (in-memory, 1000)     (app/usage/recorder.py)
        → background task: batched INSERT via psycopg, 3 attempts, then drop
```

- `emit()` never raises and is a no-op when no tracker is installed.
  `reject()` in `app/api/_common.py` emits **and** returns the
  `HTTPException`, so a route never records the same request twice.
- Writes happen in a background task, but on Cloud Run the CPU is throttled
  once the response is sent and the task starves. The middleware therefore
  waits (bounded by `USAGE_DRAIN_SECONDS`, default 2 s) for pending writes
  **before** returning a response that emitted events. On SIGTERM the
  lifespan `stop()` flushes for ≤5 s.
- GeoLite2-Country is downloaded by `scripts/deploy.sh` into
  `backend/geoip/` and baked into the image (`GEOIP_DB_PATH`). If the file is
  absent the app downloads it at startup when `MAXMIND_LICENSE_KEY` is set,
  else `country_code` stays NULL. Attribution: *This product includes
  GeoLite2 data created by MaxMind, available from <https://www.maxmind.com>.*

## Configuration

| Env | Meaning |
|---|---|
| `USAGE_DB_URL` | libpq URL **without password**, e.g. `postgresql://xmlviewer@62.238.116.11:5432/xmlviewer_stats?sslmode=require`. Empty ⇒ feature off. Also used by the feedback store unless `FEEDBACK_DB_URL` overrides it. |
| `USAGE_DB_PASSWORD` | DB password (Secret Manager on Cloud Run); feedback falls back to it as well |
| `USAGE_HASH_SECRET` | random secret for the daily salt; empty ⇒ warning, date-only salt |
| `MAXMIND_LICENSE_KEY` | free GeoLite2 key; empty ⇒ no runtime download |
| `GEOIP_DB_PATH` | default `/tmp/geoip/GeoLite2-Country.mmdb`; the image sets `/app/geoip/GeoLite2-Country.mmdb` |
| `USAGE_DRAIN_SECONDS` | default `2` — upper bound the middleware waits for pending writes |

## Production database

Same DB as the feedback table: `xmlviewer_stats` / role `xmlviewer` on the
Hetzner VPS (62.238.116.11, TLS only). Details in `docs/FEEDBACK.md`.

### One-time setup

```bash
# 1. DDL on the VPS (scp backend/sql/usage_stats.sql there first)
ssh deploy@62.238.116.11
PGPASSWORD=$(cat /home/deploy/xmlviewer-db-password.txt) \
  psql "postgresql://xmlviewer@127.0.0.1:5432/xmlviewer_stats?sslmode=require" -f usage_stats.sql
#    check: \d usage_event  and  \d feedback (visitor_hash, country_code, device)

# 2. GCP secrets (project xml-viewer-online); the DB password secret already exists
openssl rand -hex 32 | gcloud secrets create xmlviewer-usage-hash-secret --data-file=- --project xml-viewer-online
gcloud secrets create xmlviewer-maxmind-license-key --data-file=- --project xml-viewer-online
for s in xmlviewer-usage-hash-secret xmlviewer-maxmind-license-key; do
  gcloud secrets add-iam-policy-binding "$s" --project xml-viewer-online \
    --member serviceAccount:239650873304-compute@developer.gserviceaccount.com \
    --role roles/secretmanager.secretAccessor
done

# 3. Deploy (downloads GeoLite2, sets the full env-var list + secrets)
scripts/deploy.sh
```

## Analysis

Connect directly:
`psql "postgresql://xmlviewer:…@62.238.116.11:5432/xmlviewer_stats?sslmode=require"`
(or from the VPS via `127.0.0.1`). Useful queries:

```sql
-- Events per type
SELECT event_type, count(*) FROM usage_event GROUP BY 1 ORDER BY 2 DESC;

-- Loads and visitors per day (bots excluded from visitors)
SELECT received_at::date d,
       count(*) FILTER (WHERE event_type='page_view') views,
       count(DISTINCT visitor_hash) FILTER (WHERE device<>'bot') visitors,
       count(*) FILTER (WHERE event_type IN ('xml_load','xsd_load')) loads,
       count(*) FILTER (WHERE event_type='validate') validations
FROM usage_event GROUP BY 1 ORDER BY 1 DESC;

-- Input type & outcome
SELECT event_type, source, status, count(*), round(avg(duration_ms)) avg_ms, round(avg(input_bytes)/1024) avg_kb
FROM usage_event WHERE event_type IN ('xml_load','xsd_load') GROUP BY 1,2,3 ORDER BY 1,2,4 DESC;

-- Validation outcome
SELECT status, count(*), round(avg(error_count)) avg_errors
FROM usage_event WHERE event_type='validate' GROUP BY 1;

-- Which files / schemas
SELECT schema_name, count(*) FROM usage_event WHERE event_type='xsd_load' GROUP BY 1 ORDER BY 2 DESC LIMIT 25;

-- Countries, referrers, devices
SELECT country_code, count(DISTINCT visitor_hash) FROM usage_event WHERE device<>'bot' GROUP BY 1 ORDER BY 2 DESC;
SELECT referrer, count(*) FROM usage_event WHERE event_type='page_view' GROUP BY 1 ORDER BY 2 DESC LIMIT 25;

-- Size watch
SELECT pg_size_pretty(pg_total_relation_size('usage_event')), count(*) FROM usage_event;
```

Housekeeping:

```sql
DELETE FROM usage_event WHERE received_at < now() - interval '24 months';
VACUUM (ANALYZE) usage_event;
```

## Privacy

No personal data is persisted: the IP is hashed with a daily rotating salt and
discarded, the user agent is a standard browser string, and file names are
whatever the user uploaded/typed or the URL they pasted (never content).
