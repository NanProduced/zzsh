-- CANDIDATE ONLY. Not numbered, not in the drizzle journal, not applied by this line.
-- Root assigns the migration number and the runtime grants. Do not edit shipped SQL to make room.
--
-- User-realm atomic throttle. Admin keeps its own candidate tables.
-- subject is a purpose-separated HMAC-SHA256 hex digest. Never store a raw phone or IP.
-- kind: reserved (slot held), failure (credential), sent (SMS committed), unknown (outcome not confirmed).
-- Lock order in the application: sorted (realm, purpose, subject) advisory locks, then captcha signature.
--
-- Suggested ACL after Root numbers this script (replace the role; do not run from this line):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON zzsh_iam.user_auth_throttle_event TO <runtime>;
--   GRANT USAGE, SELECT ON SEQUENCE zzsh_iam.user_auth_throttle_event_id_seq TO <runtime>;
--   GRANT SELECT, INSERT, DELETE ON zzsh_iam.user_auth_captcha_used TO <runtime>;

CREATE TABLE IF NOT EXISTS zzsh_iam.user_auth_throttle_event (
  id bigserial PRIMARY KEY,
  realm text NOT NULL CHECK (realm = 'user'),
  purpose text NOT NULL CHECK (purpose IN ('sign-in', 'sms-phone', 'sms-ip')),
  subject text NOT NULL CHECK (subject ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('reserved', 'failure', 'sent', 'unknown')),
  ticket text NOT NULL CHECK (ticket ~ '^[0-9a-f]{32}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS user_auth_throttle_event_lookup_idx
  ON zzsh_iam.user_auth_throttle_event (realm, purpose, subject, occurred_at);

CREATE INDEX IF NOT EXISTS user_auth_throttle_event_ticket_idx
  ON zzsh_iam.user_auth_throttle_event (ticket);

CREATE TABLE IF NOT EXISTS zzsh_iam.user_auth_captcha_used (
  realm text NOT NULL CHECK (realm = 'user'),
  signature text NOT NULL CHECK (length(signature) BETWEEN 1 AND 128),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (realm, signature)
);

CREATE INDEX IF NOT EXISTS user_auth_captcha_used_expiry_idx
  ON zzsh_iam.user_auth_captcha_used (expires_at);

REVOKE ALL ON zzsh_iam.user_auth_throttle_event, zzsh_iam.user_auth_captcha_used FROM PUBLIC;
REVOKE ALL ON SEQUENCE zzsh_iam.user_auth_throttle_event_id_seq FROM PUBLIC;
