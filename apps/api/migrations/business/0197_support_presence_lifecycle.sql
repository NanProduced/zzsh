-- Decouple "on reception" from the transient IM connection state.
-- state_revision is the server-issued monotonic marker used to reject stale
-- heartbeats from an older connection/tab generation. It is independent from the
-- client-visible presence version because heartbeats no longer need version CAS.
ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD COLUMN IF NOT EXISTS "last_confirmed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "disconnected_since" timestamptz,
  ADD COLUMN IF NOT EXISTS "dispatch_paused" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "state_revision" bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "connection_id" text,
  ADD COLUMN IF NOT EXISTS "connection_expires_at" timestamptz;

-- A tab/window binds claim, heartbeat, release and connection-lease refresh to
-- this id. Same auth session in two tabs must still be two connection instances.
ALTER TABLE "zzsh_iam"."im_support_presence"
  DROP CONSTRAINT IF EXISTS "im_support_presence_connection_id_check";
ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD CONSTRAINT "im_support_presence_connection_id_check"
  CHECK ("connection_id" IS NULL OR "connection_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$');

UPDATE "zzsh_iam"."im_support_presence"
   SET "last_confirmed_at" = "last_connected_at"
 WHERE "last_confirmed_at" IS NULL AND "last_connected_at" IS NOT NULL;

-- Pre-lifecycle stale AVAILABLE rows may have no open interval. They cannot be
-- trusted as reception and must require an explicit start after upgrade.
UPDATE "zzsh_iam"."im_support_presence" p
   SET "availability" = 'OFF_DUTY',
       "connection_state" = 'DISCONNECTED',
       "auth_session_id" = NULL,
       "connection_id" = NULL,
       "connection_expires_at" = NULL,
       "dispatch_paused" = false,
       "disconnected_since" = NULL,
       "version" = p."version" + 1,
       "state_revision" = p."state_revision" + 1,
       "updated_at" = clock_timestamp()
 WHERE p."availability" = 'AVAILABLE'
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."im_support_presence_session" s
      WHERE s."app_id" = p."app_id" AND s."admin_user_id" = p."admin_user_id" AND s."ended_at" IS NULL
   );

-- Accept the new end reasons before any repair writes them; the old 0196-era
-- constraint would reject LOST/LOGOUT/SESSION_EXPIRED/REVOKED/TAKEN_OVER.
ALTER TABLE "zzsh_iam"."im_support_presence_session"
  DROP CONSTRAINT IF EXISTS "im_support_presence_session_end_reason_check";
ALTER TABLE "zzsh_iam"."im_support_presence_session"
  ADD CONSTRAINT "im_support_presence_session_end_reason_check"
  CHECK ("end_reason" IN (
    'MANUAL_OFF', 'PAUSED', 'DISCONNECTED', 'STALE', 'FORCED', 'OFF_DUTY',
    'LOST', 'LOGOUT', 'SESSION_EXPIRED', 'REVOKED', 'TAKEN_OVER'
  ));

-- 0184 made auth_session_id nullable. A legacy AVAILABLE row with an open
-- interval but no owner cannot prove that anyone is receiving; close it at the
-- last trusted liveness and require an explicit start, so a connection claim
-- cannot turn an old unbound interval back into dispatchable reception.
UPDATE "zzsh_iam"."im_support_presence_session" s
   SET "ended_at" = GREATEST(COALESCE(p."last_confirmed_at", s."started_at", clock_timestamp()), s."started_at"),
       "end_reason" = 'LOST'
  FROM "zzsh_iam"."im_support_presence" p
 WHERE s."app_id" = p."app_id" AND s."admin_user_id" = p."admin_user_id"
   AND s."ended_at" IS NULL AND p."availability" = 'AVAILABLE' AND p."auth_session_id" IS NULL;

UPDATE "zzsh_iam"."im_support_presence" p
   SET "availability" = 'OFF_DUTY',
       "connection_state" = 'DISCONNECTED',
       "connection_id" = NULL,
       "connection_expires_at" = NULL,
       "dispatch_paused" = false,
       "disconnected_since" = NULL,
       "version" = p."version" + 1,
       "state_revision" = p."state_revision" + 1,
       "updated_at" = clock_timestamp()
 WHERE p."availability" = 'AVAILABLE' AND p."auth_session_id" IS NULL;

-- Close any interval left open while the presence is no longer AVAILABLE. The
-- historical end is the last trusted liveness, never a later tick/upgrade time.
UPDATE "zzsh_iam"."im_support_presence_session" s
   SET "ended_at" = GREATEST(COALESCE(p."last_confirmed_at", s."started_at", clock_timestamp()), s."started_at"),
       "end_reason" = 'LOST'
  FROM "zzsh_iam"."im_support_presence" p
 WHERE s."app_id" = p."app_id" AND s."admin_user_id" = p."admin_user_id"
   AND s."ended_at" IS NULL AND p."availability" <> 'AVAILABLE';

-- Existing AVAILABLE rows that are not connected start their grace window from the
-- last known connection instead of pretending to be freshly online.
UPDATE "zzsh_iam"."im_support_presence"
   SET "disconnected_since" = COALESCE("disconnected_since", "last_connected_at", clock_timestamp())
 WHERE "availability" = 'AVAILABLE'
   AND "connection_state" <> 'CONNECTED'
   AND "disconnected_since" IS NULL;

UPDATE "zzsh_iam"."im_support_presence" p
   SET "dispatch_paused" = true
  FROM "zzsh_auth_admin"."session" a
 WHERE p."auth_session_id" = a."id"
   AND a."locked" = true;

ALTER TABLE "zzsh_iam"."im_support_presence_session"
  ADD COLUMN IF NOT EXISTS "metric_version" smallint NOT NULL DEFAULT 1;

ALTER TABLE "zzsh_iam"."im_support_presence_session"
  ALTER COLUMN "metric_version" SET DEFAULT 2;

ALTER TABLE "zzsh_iam"."im_support_presence_session"
  DROP CONSTRAINT IF EXISTS "im_support_presence_session_metric_version_check";
ALTER TABLE "zzsh_iam"."im_support_presence_session"
  ADD CONSTRAINT "im_support_presence_session_metric_version_check"
  CHECK ("metric_version" IN (1, 2));

COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."last_confirmed_at"
  IS 'Server-confirmed liveness: connected heartbeat or locked-page liveness.';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."disconnected_since"
  IS 'First observation of the current IM disconnect; cleared by a confirmed connection.';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."dispatch_paused"
  IS 'Reception remains on but new dispatch is paused until a confirmed IM connection (lock/takeover).';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."state_revision"
  IS 'Server-issued monotonic state marker; stale heartbeat revisions are rejected.';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."connection_id"
  IS 'Connection instance (tab/window) that owns the exclusive IM login and renewal lease.';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence"."connection_expires_at"
  IS 'Connection claim lease deadline; renewed by the owning instance, recoverable after abnormal exit.';
COMMENT ON COLUMN "zzsh_iam"."im_support_presence_session"."metric_version"
  IS '1 = historical connection-bound timing; 2 = reception timing independent of IM connection.';
