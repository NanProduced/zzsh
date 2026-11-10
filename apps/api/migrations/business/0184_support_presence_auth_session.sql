-- Bind support presence to the auth session that owns the IM connection.
-- Dispatch only treats presence as eligible while that session is unlocked and
-- unexpired; locking a session can therefore revoke dispatchability immediately.
ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD COLUMN IF NOT EXISTS "auth_session_id" text;

CREATE INDEX IF NOT EXISTS "im_support_presence_auth_session_idx"
  ON "zzsh_iam"."im_support_presence" ("app_id", "auth_session_id");

COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."auth_session_id"
  IS 'Auth session that owns this presence; NULL from pre-0184 rows is non-dispatchable until the client re-claims it.';
