CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_support_presence" (
  "admin_user_id" text PRIMARY KEY REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "availability" text NOT NULL CHECK ("availability" IN ('OFF_DUTY', 'AVAILABLE', 'PAUSED')),
  "connection_state" text NOT NULL CHECK ("connection_state" IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'KICKED', 'AUTH_FAILED')),
  "last_connected_at" timestamptz,
  "active_load" integer NOT NULL DEFAULT 0 CHECK ("active_load" >= 0),
  "capacity" integer NOT NULL DEFAULT 3 CHECK ("capacity" BETWEEN 1 AND 100),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "im_support_presence_available_idx"
  ON "zzsh_iam"."im_support_presence" ("availability", "connection_state", "last_connected_at", "active_load", "updated_at", "admin_user_id");

CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_consultation" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('SERVICE', 'COMPLAINT')),
  "state" text NOT NULL CHECK ("state" IN ('WAITING', 'ACTIVE', 'CLOSED')),
  "user_account_id" text NOT NULL CHECK ("user_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "peer_account_id" text CHECK ("peer_account_id" IS NULL OR "peer_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "assigned_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "subject_ref" text CHECK ("subject_ref" IS NULL OR "subject_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "last_message_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_consultation_active_assignment_check"
    CHECK ("state" <> 'ACTIVE' OR ("assigned_admin_id" IS NOT NULL AND "peer_account_id" IS NOT NULL))
);

DROP INDEX IF EXISTS "zzsh_iam"."im_consultation_user_kind_active_unique_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "im_consultation_user_kind_active_unique_idx"
  ON "zzsh_iam"."im_consultation" ("user_id", "kind")
  WHERE "state" <> 'CLOSED';

CREATE INDEX IF NOT EXISTS "im_consultation_queue_idx"
  ON "zzsh_iam"."im_consultation" ("state", "kind", "assigned_admin_id", "updated_at" DESC, "id");
CREATE INDEX IF NOT EXISTS "im_consultation_user_idx"
  ON "zzsh_iam"."im_consultation" ("user_id", "updated_at" DESC, "id");

CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_consultation_event" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "consultation_id" text NOT NULL REFERENCES "zzsh_iam"."im_consultation"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL CHECK ("event_type" IN ('CREATED', 'ASSIGNED', 'CLAIMED', 'TRANSFERRED', 'CLOSED', 'REOPENED')),
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('user', 'admin', 'system')),
  "actor_id" text,
  "from_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "to_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "peer_account_id" text CHECK ("peer_account_id" IS NULL OR "peer_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS "im_consultation_event_consultation_idx"
  ON "zzsh_iam"."im_consultation_event" ("consultation_id", "created_at", "id");

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_support_presence_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."admin_user_id" IS DISTINCT FROM OLD."admin_user_id"
     OR NEW."capacity" IS DISTINCT FROM OLD."capacity" THEN
    RAISE EXCEPTION 'IM support presence identity and capacity are immutable';
  END IF;
  IF NEW."active_load" < 0 OR NEW."active_load" > NEW."capacity" THEN
    RAISE EXCEPTION 'IM support presence load is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_support_presence_mutation_guard" ON "zzsh_iam"."im_support_presence";
CREATE TRIGGER "im_support_presence_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_support_presence"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_support_presence_mutation"();

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."subject_ref" IS DISTINCT FROM OLD."subject_ref"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation identity fields are immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'CLOSED'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'IM consultation state transition is invalid';
  END IF;
  IF OLD."state" = 'CLOSED' AND (
    NEW."assigned_admin_id" IS DISTINCT FROM OLD."assigned_admin_id"
    OR NEW."peer_account_id" IS DISTINCT FROM OLD."peer_account_id"
  ) THEN
    RAISE EXCEPTION 'Closed IM consultation assignment is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_consultation_mutation_guard" ON "zzsh_iam"."im_consultation";
CREATE TRIGGER "im_consultation_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_consultation"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"();

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('im.support.accept', '接待客服咨询', '接手服务类咨询并维护当前受权接待关系'),
  ('im.support.complaint', '处理投诉反馈', '查看并处理投诉反馈类咨询'),
  ('im.support.transfer', '转交客服咨询', '将当前受权咨询转交给另一位合格客服'),
  ('im.support.presence', '设置客服在线状态', '维护当前管理员的客服接待状态与云信连接状态')
ON CONFLICT ("code") DO NOTHING;
