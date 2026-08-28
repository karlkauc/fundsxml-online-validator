-- Usage statistics schema for the XML Online Viewer (docs/USAGE_STATS.md).
-- Column set is identical to the XSD viewer's usage_event so one dashboard can
-- query both databases; only the event_type list and the meaning of a few
-- columns differ (see the comments). Apply once by hand as the owning role; the
-- app never issues DDL. From the VPS (scp this file there first):
--   PGPASSWORD=$(cat /home/deploy/xmlviewer-db-password.txt) \
--     psql "postgresql://xmlviewer@127.0.0.1:5432/xmlviewer_stats?sslmode=require" -f usage_stats.sql
-- or remotely over TLS:
--   psql "postgresql://xmlviewer@62.238.116.11:5432/xmlviewer_stats?sslmode=require" -f backend/sql/usage_stats.sql

CREATE TABLE IF NOT EXISTS usage_event (
  event_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at      timestamptz NOT NULL DEFAULT now(),
  event_type       text        NOT NULL CHECK (event_type IN ('page_view','xml_load','xsd_load','validate','export')),
  visitor_hash     text,                 -- sha256(daily salt | ip | user-agent), first 32 hex chars; no raw IP
  country_code     char(2),              -- ISO-3166-1 alpha-2 via GeoLite2, NULL if unknown
  user_agent       text,                 -- truncated to 255
  device           text,                 -- desktop | mobile | bot | unknown
  status_code      int,
  app_version      text,
  path             text,                 -- page_view: SPA path served
  referrer         text,                 -- scheme://host/path, no query
  source           text,                 -- xml_load/xsd_load: upload|text|url|release ; export: excel ; validate: NULL
  schema_name      text,                 -- xml_load: XML file name ; xsd_load/validate/export: XSD main file (never content)
  target_namespace text,                 -- unused (NULL) in this app
  input_bytes      int,
  file_count       int,                  -- xsd_load: files in the schema set ; xml_load: 1
  element_count    int,                  -- xml_load: node_count of the document
  type_count       int,                  -- unused (NULL) in this app
  diagnostic_count int,                  -- unused (NULL) in this app
  error_count      int,                  -- validate/export: number of validation errors
  duration_ms      int,
  status           text,                 -- ok | invalid | parse_error | rejected
  error_detail     text                  -- exception message, truncated to 255
);

CREATE INDEX IF NOT EXISTS idx_usage_event_received  ON usage_event (received_at);
CREATE INDEX IF NOT EXISTS idx_usage_event_type_time ON usage_event (event_type, received_at);
CREATE INDEX IF NOT EXISTS idx_usage_event_visitor   ON usage_event (visitor_hash);
CREATE INDEX IF NOT EXISTS idx_usage_event_country   ON usage_event (country_code);

-- The feedback table (backend/sql/feedback.sql) gains the same anonymised
-- visitor columns as usage_event; idempotent for databases created earlier.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS visitor_hash text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS country_code char(2);
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS device text;
