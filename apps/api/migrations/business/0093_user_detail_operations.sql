-- Proposal only: Master combines this into the next migration and its runtime ACL registration.
CREATE TABLE "zzsh_iam"."user_note" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE CASCADE,
  "body" text NOT NULL CHECK (char_length(btrim("body")) BETWEEN 2 AND 1000),
  "author_admin_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "deleted_at" timestamptz,
  "deleted_by" text,
  CONSTRAINT "user_note_deletion_pair" CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "user_note_visible_by_user" ON "zzsh_iam"."user_note" ("user_id", "created_at" DESC, "id" COLLATE "C" DESC) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION "zzsh_iam"."guard_user_note_append_only"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.user_id,NEW.body,NEW.author_admin_id,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.user_id,OLD.body,OLD.author_admin_id,OLD.created_at)
     OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL THEN
    RAISE EXCEPTION 'User notes can only be appended or marked deleted';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_note_append_only" BEFORE UPDATE ON "zzsh_iam"."user_note" FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_user_note_append_only"();
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code","name","description") VALUES
 ('user.note.write','添加用户内部备注','添加用户内部备注或删除本人备注；不允许修改正文'),
 ('user.note.manage','删除任意用户内部备注','删除任意管理员添加的用户内部备注；不允许修改正文'),
 ('user.identity.sensitive.read','查看用户敏感身份资料','主动查看用户已记录的明文手机号和敏感身份资料；每次查看均审计')
ON CONFLICT ("code") DO NOTHING;
-- Runtime ACL: SELECT, INSERT and UPDATE on zzsh_iam.user_note; explicitly revoke DELETE
-- after the existing runtime schema-wide grants. No sequence or new schema privilege is needed.
-- This adds permission dictionary entries only; no staff grants are implied.

--> statement-breakpoint
-- Proposal only. The Admin Master owns the final forward migration number and journal.
-- No existing credit records or scores are rewritten or initialized.
ALTER TABLE zzsh_credit.credit_event
  DROP CONSTRAINT credit_event_event_type_check,
  ADD CONSTRAINT credit_event_event_type_check CHECK (event_type IN (
    'INITIALIZED','BREACH_CONFIRMED','BREACH_REVERSED','RECOVERY_APPROVED',
    'MANUAL_DEDUCTION','MANUAL_DEDUCTION_REVERSED'
  ));

CREATE OR REPLACE FUNCTION zzsh_credit.guard_credit_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_row record; original record;
BEGIN
  IF NEW.applied_delta_score IS DISTINCT FROM NEW.score_after - NEW.score_before THEN
    RAISE EXCEPTION 'credit event applied delta is inconsistent' USING ERRCODE='23514';
  END IF;
  SELECT score INTO state_row FROM zzsh_credit.user_credit_state WHERE user_id=NEW.user_id;
  IF state_row.score IS NULL OR NEW.score_before IS DISTINCT FROM state_row.score THEN
    RAISE EXCEPTION 'credit event does not bind the current score' USING ERRCODE='23514';
  END IF;
  IF NEW.event_type='INITIALIZED' THEN
    IF NEW.delta_score<>0 OR NEW.score_before<>100 OR NEW.score_after<>100 OR NEW.actor_admin_id IS NOT NULL THEN
      RAISE EXCEPTION 'credit initialization is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='BREACH_CONFIRMED' THEN
    IF NEW.delta_score<>-10 OR NEW.subject_role IS NULL OR NEW.reversal_of_id IS NOT NULL OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit breach is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='BREACH_REVERSED' THEN
    SELECT * INTO original FROM zzsh_credit.credit_event WHERE id=NEW.reversal_of_id AND user_id=NEW.user_id;
    IF original.id IS NULL OR original.event_type<>'BREACH_CONFIRMED' OR NEW.delta_score<>-original.applied_delta_score OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit reversal is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='RECOVERY_APPROVED' THEN
    IF NEW.delta_score<>10 OR NEW.source_type<>'RECOVERY_REQUEST' OR NEW.actor_admin_id IS NULL THEN
      RAISE EXCEPTION 'credit recovery event is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='MANUAL_DEDUCTION' THEN
    IF NEW.source_type<>'USER_MANUAL' OR NEW.source_id<>NEW.user_id OR NEW.subject_role IS NOT NULL
      OR NEW.reversal_of_id IS NOT NULL OR NEW.actor_admin_id IS NULL
      OR NEW.delta_score NOT BETWEEN -100 AND -1 OR NEW.applied_delta_score<>NEW.delta_score THEN
      RAISE EXCEPTION 'manual credit deduction is invalid' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_type='MANUAL_DEDUCTION_REVERSED' THEN
    SELECT * INTO original FROM zzsh_credit.credit_event WHERE id=NEW.reversal_of_id AND user_id=NEW.user_id;
    IF original.id IS NULL OR original.event_type<>'MANUAL_DEDUCTION' OR original.source_type<>'USER_MANUAL'
      OR original.source_id<>NEW.user_id OR NEW.source_type<>'USER_MANUAL' OR NEW.source_id<>NEW.user_id
      OR NEW.subject_role IS NOT NULL OR NEW.actor_admin_id IS NULL
      OR NEW.delta_score<>-original.applied_delta_score
      OR NEW.applied_delta_score<>LEAST(100,NEW.score_before+NEW.delta_score)-NEW.score_before THEN
      RAISE EXCEPTION 'manual credit reversal is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported credit event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
