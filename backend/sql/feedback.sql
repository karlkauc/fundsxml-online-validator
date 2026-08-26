-- User feedback submitted through the in-app dialog (POST /api/feedback).
-- Run once against the database referenced by FEEDBACK_DB_URL.
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at   timestamptz NOT NULL DEFAULT now(),
  message       text        NOT NULL,   -- ≤ 4000 chars, enforced by the API
  email         text,                   -- optional reply address, user-provided
  page          text,                   -- SPA path the dialog was opened from
  xml_name      text,                   -- XML document loaded at the time, if any
  xsd_name      text,                   -- XSD loaded at the time, if any
  error_detail  text,                   -- error message the user was looking at, if any
  user_agent    text,
  app_version   text
);

CREATE INDEX IF NOT EXISTS idx_feedback_received ON feedback (received_at);
