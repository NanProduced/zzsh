--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: zzsh_auth_admin; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_auth_admin;


--
-- Name: zzsh_auth_user; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_auth_user;


--
-- Name: zzsh_content; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_content;


--
-- Name: zzsh_credit; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_credit;


--
-- Name: zzsh_iam; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_iam;


--
-- Name: zzsh_order; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_order;


--
-- Name: zzsh_supply; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA zzsh_supply;


--
-- Name: guard_document_acceptance_mutation(); Type: FUNCTION; Schema: zzsh_content; Owner: -
--

CREATE FUNCTION zzsh_content.guard_document_acceptance_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'document acceptance is immutable';
END $$;


--
-- Name: guard_legal_document_version(); Type: FUNCTION; Schema: zzsh_content; Owner: -
--

CREATE FUNCTION zzsh_content.guard_legal_document_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'SEALED' THEN RAISE EXCEPTION 'sealed legal document is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."id", NEW."doc_type", NEW."title", NEW."body", NEW."digest", NEW."status", NEW."revision",
        NEW."effective_at", NEW."created_by_admin_id", NEW."sealed_by_admin_id", NEW."sealed_at", NEW."created_at")
       IS DISTINCT FROM
       (OLD."id", OLD."doc_type", OLD."title", OLD."body", OLD."digest", OLD."status", OLD."revision",
        OLD."effective_at", OLD."created_by_admin_id", OLD."sealed_by_admin_id", OLD."sealed_at", OLD."created_at") THEN
      RAISE EXCEPTION 'sealed legal document is immutable';
    END IF;
  ELSIF NEW."status" NOT IN ('DRAFT', 'SEALED') THEN
    RAISE EXCEPTION 'legal document status transition is invalid';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_resource_version(); Type: FUNCTION; Schema: zzsh_content; Owner: -
--

CREATE FUNCTION zzsh_content.guard_resource_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item_type text;
BEGIN
  SELECT "type" INTO item_type FROM "zzsh_content"."content_item" WHERE "id" = NEW."item_id";
  IF (item_type = 'RESOURCE') <> (NEW."payload" IS NOT NULL) THEN
    RAISE EXCEPTION 'content resource payload shape mismatch' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND ((OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED'))
    OR (OLD."state" = 'PUBLISHED' AND NEW."state" NOT IN ('PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'))
    OR (OLD."state" IN ('SUPERSEDED', 'WITHDRAWN') AND NEW."state" <> OLD."state")) THEN
    RAISE EXCEPTION 'content version state transition is immutable' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND OLD."state" <> 'DRAFT' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id")
      IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'published content versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND OLD."state" = 'DRAFT' AND NEW."state" = 'SUPERSEDED' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id") IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'superseded draft snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_update_settings(); Type: FUNCTION; Schema: zzsh_content; Owner: -
--

CREATE FUNCTION zzsh_content.guard_update_settings() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."state" <> 'DRAFT' AND NEW."update_settings" IS DISTINCT FROM OLD."update_settings" THEN
    RAISE EXCEPTION 'published update settings are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."update_settings" <> '{}'::jsonb AND EXISTS (SELECT 1 FROM "zzsh_content"."content_item" WHERE "id" = NEW."item_id" AND "type" = 'RESOURCE') THEN
    RAISE EXCEPTION 'resource cannot carry update settings' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_credit_event_insert(); Type: FUNCTION; Schema: zzsh_credit; Owner: -
--

CREATE FUNCTION zzsh_credit.guard_credit_event_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: guard_credit_state_update(); Type: FUNCTION; Schema: zzsh_credit; Owner: -
--

CREATE FUNCTION zzsh_credit.guard_credit_state_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('zzsh.credit_mutation', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'credit state is changed only by the credit mutation path' USING ERRCODE='42501';
  END IF;
  IF NEW.score < 0 OR NEW.score > 100 OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'credit state transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: runtime_contract_version(); Type: FUNCTION; Schema: zzsh_credit; Owner: -
--

CREATE FUNCTION zzsh_credit.runtime_contract_version() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$SELECT 1$$;


--
-- Name: clear_admin_password_change_requirement(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.clear_admin_password_change_requirement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE "zzsh_iam"."admin_security"
       SET "password_change_required" = false,
           "updated_at" = clock_timestamp()
     WHERE "admin_user_id" = NEW."userId"
       AND "password_change_required" = true;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: clear_legacy_password_on_change(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.clear_legacy_password_on_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    NEW."legacyPasswordMd5" := NULL;
    NEW."legacyPasswordVersion" := NULL;
    NEW."legacyPasswordSalt" := NULL;
    NEW."legacyPasswordUpgradedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_audit_purge_record(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_audit_purge_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."action" = 'admin.audit.purged' THEN
    RAISE EXCEPTION 'audit purge records are permanent' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;


--
-- Name: guard_im_consultation_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_consultation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."subject_ref" IS DISTINCT FROM OLD."subject_ref"
     OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
     OR NEW."round_seq" IS DISTINCT FROM OLD."round_seq"
     OR NEW."message_scope_type" IS DISTINCT FROM OLD."message_scope_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation identity and message scope type are immutable';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL AND NEW."message_scope_id" IS DISTINCT FROM OLD."message_scope_id" THEN
    RAISE EXCEPTION 'IM consultation message scope identity is immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'CLOSED'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'IM consultation state transition is invalid';
  END IF;
  IF NEW."message_scope_state" IS DISTINCT FROM OLD."message_scope_state" AND NOT (
    (OLD."message_scope_state" = 'PENDING' AND NEW."message_scope_state" IN ('PROVISIONING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'PROVISIONING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'READY' AND NEW."message_scope_state" IN ('TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'TRANSFERRING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'REVOKING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'IM consultation message scope transition is invalid';
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


--
-- Name: guard_im_consultation_scope_operation_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_consultation_scope_operation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."consultation_id" IS DISTINCT FROM OLD."consultation_id"
     OR NEW."operation_type" IS DISTINCT FROM OLD."operation_type"
     OR NEW."scope_version" IS DISTINCT FROM OLD."scope_version"
     OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."previous_admin_id" IS DISTINCT FROM OLD."previous_admin_id"
     OR NEW."target_admin_id" IS DISTINCT FROM OLD."target_admin_id"
     OR NEW."previous_admin_account_id" IS DISTINCT FROM OLD."previous_admin_account_id"
     OR NEW."target_admin_account_id" IS DISTINCT FROM OLD."target_admin_account_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation scope operation identity is immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'PENDING' AND NEW."state" = 'RUNNING')
    OR (OLD."state" = 'RUNNING' AND NEW."state" IN ('UNKNOWN', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW'))
    OR (OLD."state" = 'UNKNOWN' AND NEW."state" = 'RUNNING')
    OR (OLD."state" IN ('FAILED', 'NEEDS_REVIEW') AND NEW."state" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'IM consultation scope operation transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_im_identity_mapping_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_identity_mapping_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."realm" IS DISTINCT FROM OLD."realm"
     OR NEW."identity_kind" IS DISTINCT FROM OLD."identity_kind"
     OR NEW."platform_subject_id" IS DISTINCT FROM OLD."platform_subject_id"
     OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
     OR NEW."identity_marker" IS DISTINCT FROM OLD."identity_marker"
     OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'IM identity mapping identity fields are immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('READY', 'FAILED_PERMANENT', 'DISABLED', 'REVOKED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN ('DISABLED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'IM identity mapping status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_im_support_presence_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_support_presence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.admin_user_id,NEW.app_id) IS DISTINCT FROM (OLD.admin_user_id,OLD.app_id) THEN
    RAISE EXCEPTION 'presence identity is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.active_load < 0 THEN RAISE EXCEPTION 'negative consultation load' USING ERRCODE='40001'; END IF;
  IF (NEW.last_order_assigned_at,NEW.last_consultation_assigned_at) IS DISTINCT FROM
     (OLD.last_order_assigned_at,OLD.last_consultation_assigned_at) AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'assignment must not change presence connection version' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_im_support_round_rating_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_support_round_rating_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IM support round rating is append-only';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
     OR NEW."round_id" IS DISTINCT FROM OLD."round_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."assigned_admin_id" IS DISTINCT FROM OLD."assigned_admin_id"
     OR NEW."score" IS DISTINCT FROM OLD."score"
     OR NEW."comment" IS DISTINCT FROM OLD."comment"
     OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM support round rating identity, score and comment are immutable';
  END IF;
  -- 暂不评价只能从 NULL 推进一次 dismissed_at；已提交的评价不可再 dismiss。
  IF OLD."dismissed_at" IS NOT NULL AND NEW."dismissed_at" IS DISTINCT FROM OLD."dismissed_at" THEN
    RAISE EXCEPTION 'IM support round rating dismissal is immutable';
  END IF;
  IF OLD."dismissed_at" IS NULL AND NEW."dismissed_at" IS NOT NULL AND OLD."score" IS NOT NULL THEN
    RAISE EXCEPTION 'A submitted IM support round rating cannot be dismissed';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_im_support_thread_mutation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_im_support_thread_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."message_scope_type" IS DISTINCT FROM OLD."message_scope_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM support thread identity is immutable';
  END IF;
  IF NEW."last_round_seq" < OLD."last_round_seq" THEN
    RAISE EXCEPTION 'IM support thread round sequence cannot decrease';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'IDLE' AND NEW."state" IN ('WAITING', 'ACTIVE'))
    OR (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'IDLE'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'IDLE')
  ) THEN
    RAISE EXCEPTION 'IM support thread state transition is invalid';
  END IF;
  IF NEW."message_scope_state" IS DISTINCT FROM OLD."message_scope_state" AND NOT (
    (OLD."message_scope_state" = 'PENDING' AND NEW."message_scope_state" IN ('PROVISIONING', 'READY', 'FAILED'))
    OR (OLD."message_scope_state" = 'PROVISIONING' AND NEW."message_scope_state" IN ('READY', 'FAILED'))
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'READY'))
    OR (OLD."message_scope_state" = 'READY' AND NEW."message_scope_state" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'IM support thread message scope transition is invalid';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL
     AND NEW."message_scope_id" IS DISTINCT FROM OLD."message_scope_id"
     AND NEW."message_scope_id" IS NOT NULL THEN
    RAISE EXCEPTION 'IM support thread message scope identity is immutable';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL AND NEW."message_scope_id" IS NULL
     AND NEW."message_scope_state" <> 'PENDING' THEN
    RAISE EXCEPTION 'Cleared IM support thread scope must be PENDING';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_legacy_growth_coverage(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_legacy_growth_coverage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy growth coverage is immutable' USING ERRCODE='23514'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'legacy growth coverage maintenance owner required' USING ERRCODE='23514'; END IF;
 doc:=NEW.record;
 IF doc->>'schema' IS DISTINCT FROM 'legacy-growth-coverage-record-v2'
  OR doc->>'subjectUserId' IS DISTINCT FROM NEW.subject_user_id
  OR doc->>'fingerprint' IS DISTINCT FROM NEW.fingerprint
  OR doc->>'executionKey' IS DISTINCT FROM NEW.execution_key
  OR doc->>'receiptDigest' IS DISTINCT FROM NEW.receipt_digest
  OR (doc->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR (doc->>'fromExclusive')::timestamptz IS DISTINCT FROM NEW.from_exclusive
  OR doc->>'coverageState' IS DISTINCT FROM NEW.coverage_state
  OR jsonb_typeof(doc->'factKeys') IS DISTINCT FROM 'array'
  OR jsonb_typeof(doc->'expectedSourceKeys') IS DISTINCT FROM 'array'
  OR jsonb_typeof(doc->'correctionProofDigests') IS DISTINCT FROM 'array'
  OR encode(sha256(convert_to(doc->>'receiptCanonical','UTF8')),'hex') IS DISTINCT FROM NEW.receipt_digest
 THEN RAISE EXCEPTION 'legacy growth coverage binding invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_rental_membership(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_rental_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'initial membership version must be 1'; END IF;
  ELSE
    IF NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid membership version' USING ERRCODE='40001'; END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;


--
-- Name: guard_user_note_append_only(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.guard_user_note_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  IF (NEW.id,NEW.user_id,NEW.body,NEW.author_admin_id,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.user_id,OLD.body,OLD.author_admin_id,OLD.created_at)
     OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL THEN
    RAISE EXCEPTION 'User notes can only be appended or marked deleted';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: initialize_rental_membership(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.initialize_rental_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO zzsh_iam.user_rental_membership(user_id,tier,source_ref) VALUES(NEW.id,'STANDARD','registration:v1');
  RETURN NEW;
END $$;


--
-- Name: migration_registration_time(jsonb); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.migration_registration_time(details jsonb) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $_$
  SELECT CASE WHEN details->>'sourceSystem'='legacy_mysql_restore'
    AND details->>'sourceEntity'='la_user' AND NULLIF(details->>'legacyId','') IS NOT NULL
    AND details->>'sourceDigest' ~ '^[0-9a-f]{64}$' AND NULLIF(details->>'evidenceRef','') IS NOT NULL
    AND details->>'sourceCreatedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?Z$'
    AND pg_input_is_valid(details->>'sourceCreatedAt','timestamp with time zone')
    THEN (details->>'sourceCreatedAt')::timestamptz ELSE NULL END;
$_$;


--
-- Name: protect_admin_first_activation(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.protect_admin_first_activation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_ENROLLMENT' OR NEW."first_activated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'admin first activation must use the enrollment transition';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."first_activated_at" IS NOT NULL AND NEW."first_activated_at" IS DISTINCT FROM OLD."first_activated_at" THEN
      RAISE EXCEPTION 'admin first activation evidence is immutable';
    END IF;
    IF OLD."first_activated_at" IS NULL AND NEW."first_activated_at" IS NOT NULL
       AND NOT (OLD."status" = 'PENDING_ENROLLMENT' AND NEW."status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'admin first activation evidence must be created by enrollment';
    END IF;
  END IF;
  IF NEW."status" = 'ACTIVE' AND NEW."first_activated_at" IS NULL THEN
    RAISE EXCEPTION 'active admin requires first activation evidence';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: protect_approval_request_snapshot(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.protect_approval_request_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."template_id" IS DISTINCT FROM NEW."template_id"
    OR OLD."template_version" IS DISTINCT FROM NEW."template_version"
    OR OLD."operation_code" IS DISTINCT FROM NEW."operation_code"
    OR OLD."trigger_condition" IS DISTINCT FROM NEW."trigger_condition"
    OR OLD."payload_version" IS DISTINCT FROM NEW."payload_version"
    OR OLD."operation_payload" IS DISTINCT FROM NEW."operation_payload"
    OR OLD."operation_payload_hash" IS DISTINCT FROM NEW."operation_payload_hash"
    OR OLD."summary" IS DISTINCT FROM NEW."summary"
    OR OLD."requested_by" IS DISTINCT FROM NEW."requested_by"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
    OR OLD."supersedes_request_id" IS DISTINCT FROM NEW."supersedes_request_id" THEN
    RAISE EXCEPTION 'approval request snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: purge_admin_audit_events(integer, text, text, text, boolean); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.purge_admin_audit_events(p_retention_days integer, p_actor_id text, p_session_id text, p_request_id text, p_dry_run boolean) RETURNS TABLE(deleted bigint, cutoff timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  v_cutoff timestamptz;
  v_count bigint;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 90 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'retention days out of range' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "zzsh_iam"."admin_security" s
     WHERE s."admin_user_id" = p_actor_id AND s."is_boss" AND s."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'boss required' USING ERRCODE = '42501';
  END IF;
  v_cutoff := clock_timestamp() - make_interval(days => p_retention_days);
  IF p_dry_run THEN
    SELECT count(*) INTO v_count FROM "zzsh_iam"."audit_event" e
     WHERE e."occurred_at" < v_cutoff
       AND split_part(e."action", '.', 1) IN ('admin', 'auth')
       AND e."action" <> 'admin.audit.purged';
    RETURN QUERY SELECT v_count, v_cutoff;
    RETURN;
  END IF;
  DELETE FROM "zzsh_iam"."audit_event" e
   WHERE e."occurred_at" < v_cutoff
     AND split_part(e."action", '.', 1) IN ('admin', 'auth')
     AND e."action" <> 'admin.audit.purged';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    'admin', p_actor_id, p_session_id, 'admin.audit.purged', 'audit_event', NULL,
    'SUCCESS', p_request_id, clock_timestamp(),
    jsonb_build_object('retentionDays', p_retention_days, 'cutoff', v_cutoff, 'deletedCount', v_count, 'scope', 'admin,auth')
  );
  RETURN QUERY SELECT v_count, v_cutoff;
END;
$$;


--
-- Name: record_auth_user_created(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.record_auth_user_created() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "action", "object_type", "object_id",
    "outcome", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin' ELSE 'user' END,
    NEW."id",
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin.account.created' ELSE 'user.account.created' END,
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin_user' ELSE 'auth_user' END,
    NEW."id",
    'SUCCESS',
    clock_timestamp(),
    jsonb_build_object('source', 'better-auth')
  );
  RETURN NEW;
END;
$$;


--
-- Name: record_password_change(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.record_password_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."password" IS NOT DISTINCT FROM NEW."password" THEN RETURN NEW; END IF;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin.password.changed' ELSE 'user.password.changed' END,
    TG_TABLE_SCHEMA || '.account',
    NEW."userId",
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('source', 'database-trigger')
  );
  RETURN NEW;
END;
$$;


--
-- Name: record_security_change(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.record_security_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  changed_id text;
  action_name text;
  noise_keys text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    noise_keys := CASE
      WHEN TG_TABLE_NAME = 'admin_security' THEN ARRAY['updated_at', 'last_full_authenticated_at']
      WHEN TG_TABLE_NAME = 'session' THEN ARRAY['updatedAt', 'expiresAt', 'last_active_at']
      WHEN TG_TABLE_NAME = 'twoFactor' AND (to_jsonb(NEW) ->> 'failedVerificationCount') = '0' THEN ARRAY['failedVerificationCount']
      ELSE ARRAY[]::text[]
    END;
    IF (to_jsonb(NEW) - noise_keys) = (to_jsonb(OLD) - noise_keys) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'admin_security' THEN
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."admin_user_id" ELSE NEW."admin_user_id" END;
    action_name := 'admin.security.' || lower(TG_OP);
  ELSE
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    action_name := 'auth.' || lower(TG_TABLE_SCHEMA) || '.' || lower(TG_TABLE_NAME) || '.' || lower(TG_OP);
  END IF;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    action_name,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    changed_id,
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('operation', TG_OP, 'source', 'database-trigger')
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: record_user_identity_state_change(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.record_user_identity_state_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    'user.identity_state.' || lower(TG_OP),
    'zzsh_iam.user_identity_state',
    NEW."user_id",
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('operation', TG_OP, 'source', 'database-trigger')
  );
  RETURN NEW;
END;
$$;


--
-- Name: refresh_user_registration_fact(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.refresh_user_registration_fact() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
  INSERT INTO zzsh_iam.user_registration_fact(user_id,audit_id,occurred_at,legacy_id,registered_at)
    VALUES (NEW.object_id,NEW.id,NEW.occurred_at,NEW.details->>'legacyId',zzsh_iam.migration_registration_time(NEW.details))
  ON CONFLICT (user_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,occurred_at=EXCLUDED.occurred_at,
    legacy_id=EXCLUDED.legacy_id,registered_at=EXCLUDED.registered_at
  WHERE (EXCLUDED.occurred_at,EXCLUDED.audit_id) > (user_registration_fact.occurred_at,user_registration_fact.audit_id);
  RETURN NEW;
END;
$$;


--
-- Name: revoke_admin_recovery_on_password_change(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.revoke_admin_recovery_on_password_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE "zzsh_iam"."admin_recovery_request"
       SET "status" = 'EXPIRED', "recovery_token_hash" = NULL
     WHERE "target_admin_user_id" = NEW."userId"
       AND "status" IN ('PENDING', 'ISSUED');
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: sync_aftersale_consultation_handler(); Type: FUNCTION; Schema: zzsh_iam; Owner: -
--

CREATE FUNCTION zzsh_iam.sync_aftersale_consultation_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.kind='SERVICE' AND NEW.state='ACTIVE' AND NEW.assigned_admin_id IS NOT NULL THEN
    UPDATE zzsh_iam.im_aftersale_record
       SET handler_admin_id=NEW.assigned_admin_id,version=version+1,updated_at=clock_timestamp()
     WHERE app_id=NEW.app_id AND requester_user_id=NEW.user_id AND state='PENDING'
       AND handler_admin_id IS DISTINCT FROM NEW.assigned_admin_id;
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: joinpay_withdrawal_intent; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_withdrawal_intent (
    id text NOT NULL,
    user_id text NOT NULL,
    payout_key text NOT NULL,
    request_fingerprint text NOT NULL,
    policy_version text NOT NULL,
    destination_id text NOT NULL,
    destination_revision text NOT NULL,
    gross_cents numeric NOT NULL,
    net_cents numeric NOT NULL,
    fee_cents numeric NOT NULL,
    currency text NOT NULL,
    expected_ledger_revision bigint NOT NULL,
    coverage_canonical text NOT NULL,
    coverage_sha256 text NOT NULL,
    coverage_version text NOT NULL,
    covered_set_digest text NOT NULL,
    merchant_identity_id text NOT NULL,
    user_no text NOT NULL,
    trade_merchant_no text,
    merchant_order_no text NOT NULL,
    receiver_account_no_enc text NOT NULL,
    receiver_name_enc text NOT NULL,
    target_fingerprint text NOT NULL,
    admission_ref text NOT NULL,
    admission_sha256 text NOT NULL,
    admission_canonical text NOT NULL,
    scope_ref text NOT NULL,
    scope_sha256 text NOT NULL,
    scope_canonical text NOT NULL,
    initial_profile_id text NOT NULL,
    initial_profile_sha256 text NOT NULL,
    initial_profile_canonical text NOT NULL,
    initial_key_version_ref text NOT NULL,
    frozen_canonical text NOT NULL,
    frozen_digest text NOT NULL,
    economic_root_id text NOT NULL,
    reserve_event_id text NOT NULL,
    state text DEFAULT 'RESERVED'::text NOT NULL,
    operation_version bigint DEFAULT 1 NOT NULL,
    funds_disposition text DEFAULT 'RESERVED'::text NOT NULL,
    lease_version bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_until timestamp with time zone,
    requires_review boolean DEFAULT false NOT NULL,
    terminal_evidence_id text,
    terminal_event_id text,
    platform_serial_no text,
    provider_fee_raw text,
    provider_fee_cents numeric,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_withdrawal_disposition_shape CHECK (((((state <> ALL (ARRAY['SUCCEEDED'::text, 'FAILED'::text])) AND (funds_disposition = 'RESERVED'::text) AND (num_nonnulls(terminal_evidence_id, terminal_event_id, provider_fee_raw, provider_fee_cents) = 0)) OR ((state = 'SUCCEEDED'::text) AND (funds_disposition = 'PAYOUT_POSTED'::text) AND (num_nonnulls(terminal_evidence_id, terminal_event_id, platform_serial_no, provider_fee_raw, provider_fee_cents) = 5)) OR ((state = 'FAILED'::text) AND (funds_disposition = 'RELEASE_POSTED'::text) AND (num_nonnulls(terminal_evidence_id, terminal_event_id, platform_serial_no, provider_fee_raw, provider_fee_cents) = 5))) IS TRUE)),
    CONSTRAINT joinpay_withdrawal_intent_admission_canonical_check CHECK (((octet_length(admission_canonical) >= 2) AND (octet_length(admission_canonical) <= 131072))),
    CONSTRAINT joinpay_withdrawal_intent_admission_ref_check CHECK (((length(admission_ref) >= 1) AND (length(admission_ref) <= 512))),
    CONSTRAINT joinpay_withdrawal_intent_check CHECK ((coverage_sha256 = encode(sha256(convert_to(coverage_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_withdrawal_intent_check1 CHECK ((admission_sha256 = encode(sha256(convert_to(admission_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_withdrawal_intent_check2 CHECK ((scope_sha256 = encode(sha256(convert_to(scope_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_withdrawal_intent_check3 CHECK ((initial_profile_sha256 = encode(sha256(convert_to(initial_profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_withdrawal_intent_check4 CHECK ((frozen_digest = encode(sha256(convert_to(frozen_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_withdrawal_intent_check5 CHECK ((gross_cents = (net_cents + fee_cents))),
    CONSTRAINT joinpay_withdrawal_intent_check6 CHECK (((state <> 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text) OR (platform_serial_no IS NOT NULL))),
    CONSTRAINT joinpay_withdrawal_intent_check7 CHECK ((((state = 'RESERVED'::text) AND (lease_version = 0) AND (lease_owner IS NULL) AND (lease_until IS NULL)) OR ((state <> 'RESERVED'::text) AND (lease_version > 0) AND (lease_owner IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT joinpay_withdrawal_intent_coverage_canonical_check CHECK (((octet_length(coverage_canonical) >= 2) AND (octet_length(coverage_canonical) <= 16384))),
    CONSTRAINT joinpay_withdrawal_intent_coverage_version_check CHECK ((coverage_version ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_covered_set_digest_check CHECK ((covered_set_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT joinpay_withdrawal_intent_destination_id_check CHECK (((length(destination_id) >= 1) AND (length(destination_id) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_destination_revision_check CHECK (((length(destination_revision) >= 1) AND (length(destination_revision) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_expected_ledger_revision_check CHECK ((expected_ledger_revision >= 0)),
    CONSTRAINT joinpay_withdrawal_intent_fee_cents_check CHECK (((fee_cents = trunc(fee_cents)) AND (fee_cents >= (0)::numeric))),
    CONSTRAINT joinpay_withdrawal_intent_frozen_canonical_check CHECK (((octet_length(frozen_canonical) >= 2) AND (octet_length(frozen_canonical) <= 131072))),
    CONSTRAINT joinpay_withdrawal_intent_funds_disposition_check CHECK ((funds_disposition = ANY (ARRAY['RESERVED'::text, 'PAYOUT_POSTED'::text, 'RELEASE_POSTED'::text]))),
    CONSTRAINT joinpay_withdrawal_intent_gross_cents_check CHECK (((gross_cents = trunc(gross_cents)) AND (gross_cents > (0)::numeric) AND (gross_cents <= '999999999999999999999999'::numeric))),
    CONSTRAINT joinpay_withdrawal_intent_id_check CHECK ((id ~ '^jwd_[a-f0-9]{40}$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_initial_key_version_ref_check CHECK (((length(initial_key_version_ref) >= 1) AND (length(initial_key_version_ref) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_initial_profile_canonical_check CHECK (((octet_length(initial_profile_canonical) >= 2) AND (octet_length(initial_profile_canonical) <= 131072))),
    CONSTRAINT joinpay_withdrawal_intent_initial_profile_id_check CHECK (((length(initial_profile_id) >= 1) AND (length(initial_profile_id) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_lease_owner_check CHECK (((length(lease_owner) >= 1) AND (length(lease_owner) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_lease_version_check CHECK ((lease_version >= 0)),
    CONSTRAINT joinpay_withdrawal_intent_merchant_identity_id_check CHECK (((length(merchant_identity_id) >= 1) AND (length(merchant_identity_id) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_merchant_order_no_check CHECK ((merchant_order_no ~ '^[A-Za-z0-9]{12,25}$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_net_cents_check CHECK (((net_cents = trunc(net_cents)) AND (net_cents > (0)::numeric) AND (net_cents <= ('9999999999999999'::bigint)::numeric))),
    CONSTRAINT joinpay_withdrawal_intent_operation_version_check CHECK ((operation_version > 0)),
    CONSTRAINT joinpay_withdrawal_intent_payout_key_check CHECK (((length(payout_key) >= 1) AND (length(payout_key) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_platform_serial_no_check CHECK (((length(platform_serial_no) >= 1) AND (length(platform_serial_no) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_policy_version_check CHECK (((length(policy_version) >= 1) AND (length(policy_version) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_provider_fee_cents_check CHECK (((provider_fee_cents = trunc(provider_fee_cents)) AND (provider_fee_cents >= (0)::numeric))),
    CONSTRAINT joinpay_withdrawal_intent_provider_fee_raw_check CHECK ((octet_length(provider_fee_raw) <= 128)),
    CONSTRAINT joinpay_withdrawal_intent_receiver_account_no_enc_check CHECK (((octet_length(receiver_account_no_enc) >= 1) AND (octet_length(receiver_account_no_enc) <= 8192))),
    CONSTRAINT joinpay_withdrawal_intent_receiver_name_enc_check CHECK (((octet_length(receiver_name_enc) >= 1) AND (octet_length(receiver_name_enc) <= 8192))),
    CONSTRAINT joinpay_withdrawal_intent_request_fingerprint_check CHECK ((request_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_scope_canonical_check CHECK (((octet_length(scope_canonical) >= 2) AND (octet_length(scope_canonical) <= 131072))),
    CONSTRAINT joinpay_withdrawal_intent_scope_ref_check CHECK (((length(scope_ref) >= 1) AND (length(scope_ref) <= 512))),
    CONSTRAINT joinpay_withdrawal_intent_state_check CHECK ((state = ANY (ARRAY['RESERVED'::text, 'SUBMITTING'::text, 'PROCESSING'::text, 'UNKNOWN'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT joinpay_withdrawal_intent_target_fingerprint_check CHECK ((target_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_withdrawal_intent_trade_merchant_no_check CHECK (((length(trade_merchant_no) >= 1) AND (length(trade_merchant_no) <= 128))),
    CONSTRAINT joinpay_withdrawal_intent_user_no_check CHECK (((user_no ~ '^[0-9]{1,32}$'::text) AND (user_no <> '888100000002340'::text)))
);


--
-- Name: assert_joinpay_payout_profile(text, text, text, text, zzsh_order.joinpay_withdrawal_intent); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_joinpay_payout_profile(canonical text, op text, pid text, key_ref text, i zzsh_order.joinpay_withdrawal_intent) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE p jsonb;r jsonb;t jsonb;f jsonb;a jsonb;
BEGIN
 p:=canonical::jsonb;r:=p->'rules';t:=p->'targetRules';f:=p->'feePolicy';a:=i.admission_canonical::jsonb;
 IF (p->>'kind' IS DISTINCT FROM 'JOINPAY_PAYOUT_PROFILE_V1' OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_PAYOUT'
  OR p->>'operation' IS DISTINCT FROM op OR p->>'profileId' IS DISTINCT FROM pid OR p->>'keyVersionRef' IS DISTINCT FROM key_ref
  OR p->>'database' IS DISTINCT FROM current_database() OR p->>'runtimeUser' IS DISTINCT FROM current_user
  OR p->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id OR p->>'userNo' IS DISTINCT FROM i.user_no
  OR p->>'tradeMerchantNo' IS DISTINCT FROM i.trade_merchant_no OR p->>'reviewRef' IS NULL OR p->>'reviewSha256'!~'^[a-f0-9]{64}$'
  OR (p->'knownAnswer' IS DISTINCT FROM '"NOT_OBTAINED"'::jsonb AND
   (jsonb_typeof(p->'knownAnswer') IS DISTINCT FROM 'object' OR NOT COALESCE(length(p#>>'{knownAnswer,reference}')>0,false)
    OR NOT COALESCE(p#>>'{knownAnswer,rawSha256}'~'^[a-f0-9]{64}$',false)))
  OR t->>'binding' IS DISTINCT FROM 'EXACT_RECORDED_OPAQUE_VALUE'
  OR t->>'encodingRuleRef' IS DISTINCT FROM a#>>'{target,encodingRuleRef}'
  OR t->>'encodingRuleSha256' IS DISTINCT FROM a#>>'{target,encodingRuleSha256}'
  OR t->>'encodingImplementationRef' IS DISTINCT FROM a#>>'{target,encodingImplementationRef}'
  OR t->>'encodingImplementationSha256' IS DISTINCT FROM a#>>'{target,encodingImplementationSha256}'
  OR t->>'targetEchoRuleRef' IS DISTINCT FROM a#>>'{target,targetEchoRuleRef}'
  OR t->>'targetEchoRuleSha256' IS DISTINCT FROM a#>>'{target,targetEchoRuleSha256}'
  OR f->>'reference' IS NULL OR f->>'sha256'!~'^[a-f0-9]{64}$' OR f->>'providerUnit' IS DISTINCT FROM 'CNY_YUAN'
  OR f->>'merchantBearsFee' IS DISTINCT FROM 'true' OR f->>'maxProviderFeeCents'!~'^(0|[1-9][0-9]{0,23})$'
  OR r->>'dataEncoding' NOT IN('OBJECT','JSON_STRING') OR r->>'statusCodeToken' NOT IN('STRING','NUMBER')
  OR r->>'statusToken' NOT IN('STRING','NUMBER','NUMBER_EXCEPT_QUERY_214_STRING') OR r->>'amountToken' NOT IN('STRING','NUMBER') OR r->>'feeToken' NOT IN('STRING','NUMBER')
  OR r->>'accountTypeToken' NOT IN('STRING','NUMBER') OR r->>'optionalSigning' IS DISTINCT FROM 'ABSENT_EMPTY_NULL_EQUIVALENT'
  OR r->>'numericSigning' IS DISTINCT FROM 'RAW_JSON_TOKEN' OR r->>'unknownFields' IS DISTINCT FROM 'REJECT'
  OR r->>'notFoundShape' IS DISTINCT FROM 'IDENTITY_ONLY_214' OR r->>'targetBinding' IS DISTINCT FROM 'EXACT_RECORDED_OPAQUE_VALUE'
  OR r->>'providerFeeUnit' IS DISTINCT FROM 'CNY_YUAN' OR jsonb_typeof(p->'requestUtcOffsetMinutes') IS DISTINCT FROM 'number'
  OR p->>'requestUtcOffsetMinutes'!~'^-?[0-9]{1,3}$' OR abs((p->>'requestUtcOffsetMinutes')::integer)>840
  OR(op='SUBMIT' AND(p#>>'{wire,isChecked}' NOT IN('201','202')
   OR(p->'wire' ? 'callbackUrl' AND(jsonb_typeof(p#>'{wire,callbackUrl}') IS DISTINCT FROM 'string' OR p#>>'{wire,callbackUrl}' NOT LIKE 'https://%'))
   OR p#>>'{wire,productCode}' IS NULL OR p#>>'{wire,paidUse}' IS NULL))) IS NOT FALSE
 THEN RAISE EXCEPTION 'payout profile missing reviewed exact merchant/rules/target/fee' USING ERRCODE='23514';END IF;
END $_$;


--
-- Name: assert_joinpay_payout_scope(text, text, text, text, text, text, zzsh_order.joinpay_withdrawal_intent); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_joinpay_payout_scope(canonical text, digest text, op text, pid text, profile_digest text, key_ref text, i zzsh_order.joinpay_withdrawal_intent) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE s jsonb;
BEGIN
 s:=canonical::jsonb;
 IF (s->>'kind' IS DISTINCT FROM 'JOINPAY_PAYOUT_SERVER_SCOPE' OR s->>'reference' IS NULL OR length(s->>'reference') NOT BETWEEN 1 AND 128
  OR s->>'reviewSha256'!~'^[a-f0-9]{64}$' OR digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
  OR s->>'database' IS DISTINCT FROM current_database() OR s->>'runtimeUser' IS DISTINCT FROM current_user
  OR s->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id OR s->>'userNo' IS DISTINCT FROM i.user_no
  OR s->>'tradeMerchantNo' IS DISTINCT FROM i.trade_merchant_no
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'acceptedProfiles') p WHERE p->>'operation'=op
   AND p->>'profileId'=pid AND p->>'profileSha256'=profile_digest AND p->>'keyVersionRef'=key_ref)
  OR(op='SUBMIT' AND(digest IS DISTINCT FROM i.scope_sha256 OR s->>'reference' IS DISTINCT FROM i.scope_ref))
  OR(digest IS DISTINCT FROM i.scope_sha256 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'historicalScopes') h
   WHERE h->>'reference'=i.scope_ref AND h->>'sha256'=i.scope_sha256))) IS NOT FALSE
 THEN RAISE EXCEPTION 'payout scope differs from exact original resource/history/profile' USING ERRCODE='23514';END IF;
END $_$;


--
-- Name: channel_refund_intent; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.channel_refund_intent (
    id text NOT NULL,
    posting_id text,
    order_id text NOT NULL,
    payment_confirmation_id text NOT NULL,
    renter_user_id text NOT NULL,
    payment_source text NOT NULL,
    merchant_identity_id text NOT NULL,
    original_payment_trx_no text NOT NULL,
    original_payment_order_no text NOT NULL,
    responsibility_version_hash text NOT NULL,
    refund_order_no text NOT NULL,
    amount_cents numeric NOT NULL,
    currency text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    state text DEFAULT 'READY'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    lease_version bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_until timestamp with time zone,
    due_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    evidence_level text DEFAULT 'CONTROLLED_TEST'::text NOT NULL,
    initial_admission_ref text,
    initial_admission_sha256 text,
    initial_admission_canonical text,
    wire_merchant_no text,
    initial_profile_id text,
    initial_profile_sha256 text,
    initial_key_version_ref text,
    notify_url text,
    funds_account text,
    refund_reason text,
    budget_disposition text DEFAULT 'ALLOCATED'::text NOT NULL,
    requires_review boolean DEFAULT false NOT NULL,
    terminal_evidence_id text,
    terminal_root_id text,
    terminal_event_id text,
    provider_refund_trx_no text,
    completed_at timestamp with time zone,
    basis_kind text DEFAULT 'POSTING'::text NOT NULL,
    liability_root_id text,
    liability_event_id text,
    CONSTRAINT channel_refund_basis_shape CHECK ((((basis_kind = 'POSTING'::text) AND (posting_id IS NOT NULL) AND (liability_root_id IS NULL) AND (liability_event_id IS NULL)) OR ((basis_kind = ANY (ARRAY['REVIEW_CONFIRMATION'::text, 'PRESTART_TERMINATION'::text])) AND (payment_source = 'JOINPAY'::text) AND (evidence_level = 'JOINPAY_FORMAL'::text) AND (posting_id IS NULL) AND (liability_root_id IS NOT NULL) AND (liability_event_id IS NOT NULL)))),
    CONSTRAINT channel_refund_budget_shape CHECK (((((state <> ALL (ARRAY['SUCCEEDED'::text, 'FAILED'::text])) AND (budget_disposition = 'ALLOCATED'::text) AND (num_nonnulls(terminal_evidence_id, terminal_root_id, terminal_event_id, provider_refund_trx_no, completed_at) = 0)) OR ((state = 'SUCCEEDED'::text) AND (budget_disposition = 'CONSUMED'::text) AND (terminal_evidence_id IS NOT NULL) AND (terminal_root_id IS NOT NULL) AND (terminal_event_id IS NOT NULL) AND (provider_refund_trx_no IS NOT NULL) AND (completed_at IS NOT NULL)) OR ((state = 'FAILED'::text) AND (budget_disposition = 'RELEASED'::text) AND (terminal_evidence_id IS NOT NULL) AND (terminal_root_id IS NULL) AND (terminal_event_id IS NULL))) IS TRUE)),
    CONSTRAINT channel_refund_claim_shape CHECK ((((state = 'READY'::text) AND (lease_version = 0) AND (lease_owner IS NULL)) OR ((state <> 'READY'::text) AND (lease_version > 0) AND (lease_owner IS NOT NULL)))),
    CONSTRAINT channel_refund_intent_amount_cents_check CHECK (((amount_cents = trunc(amount_cents)) AND (amount_cents > (0)::numeric) AND (amount_cents <= ('9999999999999999'::bigint)::numeric))),
    CONSTRAINT channel_refund_intent_check CHECK (((lease_owner IS NULL) = (lease_until IS NULL))),
    CONSTRAINT channel_refund_intent_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT channel_refund_intent_idempotency_key_check CHECK ((idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT channel_refund_intent_lease_owner_check CHECK ((lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT channel_refund_intent_lease_version_check CHECK ((lease_version >= 0)),
    CONSTRAINT channel_refund_intent_merchant_identity_id_check CHECK (((length(merchant_identity_id) >= 1) AND (length(merchant_identity_id) <= 128))),
    CONSTRAINT channel_refund_intent_original_payment_order_no_check CHECK (((length(original_payment_order_no) >= 1) AND (length(original_payment_order_no) <= 128))),
    CONSTRAINT channel_refund_intent_original_payment_trx_no_check CHECK (((length(original_payment_trx_no) >= 1) AND (length(original_payment_trx_no) <= 128))),
    CONSTRAINT channel_refund_intent_refund_order_no_check CHECK ((refund_order_no ~ '^RF[0-9a-f]{28}$'::text)),
    CONSTRAINT channel_refund_intent_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT channel_refund_intent_responsibility_version_hash_check CHECK ((responsibility_version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT channel_refund_intent_revision_check CHECK ((revision > 0)),
    CONSTRAINT channel_refund_source_shape CHECK (((((payment_source = 'CONTROLLED'::text) AND (evidence_level = 'CONTROLLED_TEST'::text) AND (state = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text])) AND (budget_disposition = 'ALLOCATED'::text) AND (NOT requires_review) AND (num_nonnulls(initial_admission_ref, initial_admission_sha256, initial_admission_canonical, wire_merchant_no, initial_profile_id, initial_profile_sha256, initial_key_version_ref, notify_url, funds_account, refund_reason, terminal_evidence_id, terminal_root_id, terminal_event_id, provider_refund_trx_no, completed_at) = 0)) OR ((payment_source = 'JOINPAY'::text) AND (evidence_level = 'JOINPAY_FORMAL'::text) AND (initial_admission_ref IS NOT NULL) AND ((length(initial_admission_ref) >= 1) AND (length(initial_admission_ref) <= 128)) AND (initial_admission_sha256 ~ '^[a-f0-9]{64}$'::text) AND ((octet_length(initial_admission_canonical) >= 2) AND (octet_length(initial_admission_canonical) <= 131072)) AND (initial_admission_sha256 = encode(sha256(convert_to(initial_admission_canonical, 'UTF8'::name)), 'hex'::text)) AND (wire_merchant_no ~ '^[0-9]{1,15}$'::text) AND (wire_merchant_no <> '888100000002340'::text) AND ((length(initial_profile_id) >= 1) AND (length(initial_profile_id) <= 128)) AND (initial_profile_sha256 ~ '^[a-f0-9]{64}$'::text) AND ((length(initial_key_version_ref) >= 1) AND (length(initial_key_version_ref) <= 128)) AND ((octet_length(notify_url) >= 9) AND (octet_length(notify_url) <= 300)) AND (notify_url ~~ 'https://%'::text) AND ((funds_account IS NULL) OR (funds_account = ANY (ARRAY['SETTLED'::text, 'ADVANCE'::text]))) AND ((refund_reason IS NULL) OR (octet_length(refund_reason) <= 400)) AND (state = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text, 'PROCESSING'::text, 'REVIEW_REQUIRED'::text, 'SUCCEEDED'::text, 'FAILED'::text])))) IS TRUE))
);


--
-- Name: assert_joinpay_refund_profile(text, text, text, text, zzsh_order.channel_refund_intent); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_joinpay_refund_profile(canonical text, op text, pid text, key_ref text, i zzsh_order.channel_refund_intent) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE p jsonb;r jsonb;
BEGIN
 p:=canonical::jsonb;r:=p->'rules';
 IF (p->>'kind' IS DISTINCT FROM 'JOINPAY_REFUND_PROFILE_V1' OR p->>'operation' IS DISTINCT FROM op
  OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_REFUND' OR p->>'profileId' IS DISTINCT FROM pid
  OR p->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id OR p->>'merchantNo' IS DISTINCT FROM i.wire_merchant_no
  OR p->>'database' IS DISTINCT FROM current_database() OR p->>'runtimeUser' IS DISTINCT FROM current_user
  OR p->>'keyVersionRef' IS DISTINCT FROM key_ref OR p->>'permission' IS DISTINCT FROM 'REVIEWED_NATIVE_RENTAL_REFUND'
  OR p->>'reviewSha256'!~'^[a-f0-9]{64}$' OR r->>'sha256'!~'^[a-f0-9]{64}$'
  OR (p->'knownAnswer' IS DISTINCT FROM '"NOT_OBTAINED"'::jsonb AND
   (jsonb_typeof(p->'knownAnswer') IS DISTINCT FROM 'object' OR NOT COALESCE(length(p#>>'{knownAnswer,reference}')>0,false)
    OR NOT COALESCE(p#>>'{knownAnswer,rawSha256}'~'^[a-f0-9]{64}$',false)))
  OR r->>'signing' IS DISTINCT FROM 'MD5_UTF8_RAW_VALUES'
  OR r->>'rawQueryDecode' IS DISTINCT FROM 'ONCE' OR r->>'numberTokens' IS DISTINCT FROM 'RAW_JSON_TOKEN'
  OR r->>'fieldPolicy' IS DISTINCT FROM 'STRICT_TABLE_EMPTY_OPTIONAL' OR r->>'refundIdentifier' IS DISTINCT FROM 'EXACT_TEXT'
  OR r->>'notify102' IS DISTINCT FROM 'REVIEW' OR r->>'utcOffsetMinutes'!~'^-?[0-9]{1,3}$'
  OR abs((r->>'utcOffsetMinutes')::integer)>840 OR NOT COALESCE(r->>'refundWay' IN('ORIGINAL_REQUIRED','ORIGINAL_OR_MISSING_REVIEWED'),false)
  OR(op='SUBMIT' AND(p->>'notifyUrl' IS DISTINCT FROM i.notify_url OR p->>'fundsAccount' IS DISTINCT FROM i.funds_account))) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund profile differs from exact merchant/resource/rules' USING ERRCODE='23514';END IF;
END $_$;


--
-- Name: assert_joinpay_withdrawal_admission(zzsh_order.joinpay_withdrawal_intent, boolean); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_joinpay_withdrawal_admission(i zzsh_order.joinpay_withdrawal_intent, new_reservation boolean) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE a jsonb;p jsonb;t jsonb;s jsonb;f jsonb;c jsonb;identity_row zzsh_iam.user_identity_state;
 covered record;revision_now bigint;available numeric;quota numeric;expected_fee numeric;now_at timestamptz;
BEGIN
 a:=i.admission_canonical::jsonb;p:=a->'policy';t:=a->'target';s:=i.scope_canonical::jsonb;f:=i.frozen_canonical::jsonb;c:=i.coverage_canonical::jsonb;now_at:=clock_timestamp();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'withdrawal requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF (a->>'kind' IS DISTINCT FROM 'JOINPAY_WITHDRAWAL_BUSINESS_ADMISSION' OR a->>'reference' IS DISTINCT FROM i.admission_ref
  OR a->>'reviewSha256'!~'^[a-f0-9]{64}$' OR a->>'userId' IS DISTINCT FROM i.user_id
  OR a->>'scopeReference' IS DISTINCT FROM i.scope_ref OR a->>'scopeSha256' IS DISTINCT FROM i.scope_sha256
  OR s->>'reference' IS DISTINCT FROM i.scope_ref OR p->>'version' IS DISTINCT FROM i.policy_version
  OR p->>'reference' IS NULL OR p->>'sha256'!~'^[a-f0-9]{64}$' OR p->>'reviewStrategy' NOT IN('VERIFIED_DIRECT_EXECUTION','MERCHANT_REVIEW_REQUIRED')
  OR (i.initial_profile_canonical::jsonb)#>>'{wire,isChecked}' IS DISTINCT FROM CASE p->>'reviewStrategy' WHEN 'VERIFIED_DIRECT_EXECUTION' THEN '202' WHEN 'MERCHANT_REVIEW_REQUIRED' THEN '201' END
  OR p->>'minCents'!~'^[1-9][0-9]{0,23}$' OR p->>'maxCents'!~'^[1-9][0-9]{0,23}$'
  OR p->>'frequencyBasis' NOT IN('ACCEPTED_INTENT','ACTIVE_OR_SUCCEEDED')
  OR jsonb_typeof(p->'maxIntents') IS DISTINCT FROM 'number' OR p->>'maxIntents'!~'^[1-9][0-9]*$'
  OR (p->>'validFrom')::timestamptz>now_at OR (p->>'expiresAt')::timestamptz<=now_at
  OR (a#>>'{identity,validUntil}')::timestamptz<=now_at OR (p->>'quotaStart')::timestamptz>now_at OR (p->>'quotaEnd')::timestamptz<=now_at
  OR (p->>'validFrom')::timestamptz>=(p->>'expiresAt')::timestamptz OR (p->>'quotaStart')::timestamptz>=(p->>'quotaEnd')::timestamptz
  OR a#>>'{identity,proofReference}' IS NULL OR a#>>'{identity,proofSha256}'!~'^[a-f0-9]{64}$'
  OR t->>'destinationId' IS DISTINCT FROM i.destination_id OR t->>'revision' IS DISTINCT FROM i.destination_revision
  OR t->>'userId' IS DISTINCT FROM i.user_id OR t->>'fingerprint' IS DISTINCT FROM i.target_fingerprint
  OR t->>'receiverAccountNoEnc' IS DISTINCT FROM i.receiver_account_no_enc OR t->>'receiverNameEnc' IS DISTINCT FROM i.receiver_name_enc
  OR t->>'receiverAccountType' NOT IN('201','204') OR t->>'mask' IS NULL OR t->>'bankOwnershipReference' IS NULL
  OR t->>'bankOwnershipSha256'!~'^[a-f0-9]{64}$' OR t->>'encodingRuleRef' IS NULL OR t->>'encodingRuleSha256'!~'^[a-f0-9]{64}$'
  OR t->>'encodingImplementationRef' IS NULL OR t->>'encodingImplementationSha256'!~'^[a-f0-9]{64}$'
  OR t->>'targetEchoRuleRef' IS NULL OR t->>'targetEchoRuleSha256'!~'^[a-f0-9]{64}$') IS NOT FALSE
 THEN RAISE EXCEPTION 'withdrawal business admission incomplete/expired' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=i.user_id AND NOT suspended FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'new withdrawal subject unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO identity_row FROM zzsh_iam.user_identity_state WHERE user_id=i.user_id;
 IF identity_row.user_id IS NULL OR identity_row.account_status<>'ACTIVE' OR identity_row.identity_status<>'VERIFIED' OR identity_row.age_status<>'ADULT'
  OR identity_row.provider~*'(fake|synthetic|model|legacy.*restore|^none$)'
  OR identity_row.provider IS DISTINCT FROM a#>>'{identity,provider}' OR identity_row.provider_reference IS DISTINCT FROM a#>>'{identity,providerReference}'
  OR identity_row.version::text IS DISTINCT FROM a#>>'{identity,version}' OR identity_row.provider_reference IS NULL
 THEN RAISE EXCEPTION 'withdrawal KYC provider/original proof differs from current subject' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_payout_scope(i.scope_canonical,i.scope_sha256,'SUBMIT',i.initial_profile_id,i.initial_profile_sha256,i.initial_key_version_ref,i);
 PERFORM zzsh_order.assert_joinpay_payout_profile(i.initial_profile_canonical,'SUBMIT',i.initial_profile_id,i.initial_key_version_ref,i);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'acceptedProfiles') q WHERE q->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'acceptedProfiles') q WHERE q->>'operation'='NOTIFY')
 THEN RAISE EXCEPTION 'new withdrawal scope requires all three operations' USING ERRCODE='23514';END IF;
 IF NOT new_reservation THEN RETURN;END IF;
 IF (f IS DISTINCT FROM jsonb_build_object('kind','JOINPAY_WITHDRAWAL_FROZEN_BASIS','intentId',i.id,'userId',i.user_id,'payoutKey',i.payout_key,
  'bodyFingerprint',i.request_fingerprint,'policyVersion',i.policy_version,'destinationId',i.destination_id,'destinationRevision',i.destination_revision,
  'grossCents',i.gross_cents::text,'netCents',i.net_cents::text,'feeCents',i.fee_cents::text,'currency','CNY','expectedLedgerRevision',i.expected_ledger_revision::text,
  'coverageSha256',i.coverage_sha256,'coverageVersion',i.coverage_version,'coveredSetDigest',i.covered_set_digest,'merchantIdentityId',i.merchant_identity_id,
  'userNo',i.user_no,'tradeMerchantNo',i.trade_merchant_no,'merchantOrderNo',i.merchant_order_no,'receiverAccountNoEnc',i.receiver_account_no_enc,
  'receiverNameEnc',i.receiver_name_enc,'targetFingerprint',i.target_fingerprint,'admissionReference',i.admission_ref,'admissionSha256',i.admission_sha256,
  'scopeReference',i.scope_ref,'scopeSha256',i.scope_sha256,'initialProfileId',i.initial_profile_id,'initialProfileSha256',i.initial_profile_sha256,'initialKeyVersionRef',i.initial_key_version_ref))
 THEN RAISE EXCEPTION 'withdrawal frozen basis differs from exact immutable columns' USING ERRCODE='23514';END IF;
 SELECT wc.origin,wc.coverage_version,b.source_digest,b.covered_set_digest,
  to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff INTO covered
  FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis b ON b.id=wc.basis_id AND b.user_id=wc.user_id WHERE wc.user_id=i.user_id;
 SELECT ledger_revision INTO revision_now FROM zzsh_order.wallet_revision WHERE user_id=i.user_id;
 IF covered.origin IS NULL OR revision_now IS NULL OR revision_now IS DISTINCT FROM i.expected_ledger_revision
  OR covered.coverage_version::text IS DISTINCT FROM i.coverage_version OR covered.covered_set_digest IS DISTINCT FROM i.covered_set_digest
  OR c IS DISTINCT FROM jsonb_build_object('knowledge','KNOWN','origin',covered.origin,'cutoff',covered.cutoff,
   'sourceDigest',covered.source_digest,'coveredSetDigest',covered.covered_set_digest,'coverageVersion',covered.coverage_version::text)
 THEN RAISE EXCEPTION 'withdrawal wallet coverage/revision is not exact original basis' USING ERRCODE='23514';END IF;
 IF covered.origin='NATIVE_GENESIS' AND NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis b ON b.id=wc.basis_id
  WHERE wc.user_id=i.user_id AND b.source_kind='NATIVE_GENESIS' AND b.available_cents=0 AND b.covered_count=0)
 THEN RAISE EXCEPTION 'withdrawal native genesis incomplete' USING ERRCODE='23514';END IF;
 IF to_regclass('zzsh_order.rental_referral_earning') IS NULL THEN RAISE EXCEPTION 'withdrawal recovery evidence unavailable' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=i.user_id AND state='RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'withdrawal has outstanding native referral recovery' USING ERRCODE='23514';END IF;
 SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
  WHERE counterparty_user_id=i.user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
 IF available<i.gross_cents OR available<0 OR i.gross_cents<(p->>'minCents')::numeric OR i.gross_cents>(p->>'maxCents')::numeric
 THEN RAISE EXCEPTION 'withdrawal has insufficient balance or policy amount' USING ERRCODE='40001';END IF;
 IF p#>>'{fee,kind}'='FIXED' THEN
  IF (p#>>'{fee,cents}'!~'^(0|[1-9][0-9]{0,23})$') IS NOT FALSE THEN RAISE EXCEPTION 'withdrawal fee rule missing' USING ERRCODE='23514';END IF;
  expected_fee:=(p#>>'{fee,cents}')::numeric;
 ELSIF p#>>'{fee,kind}'='RATIO' THEN
  IF (p#>>'{fee,numerator}'!~'^(0|[1-9][0-9]{0,23})$' OR p#>>'{fee,denominator}'!~'^[1-9][0-9]{0,23}$'
   OR p#>>'{fee,rounding}' IS DISTINCT FROM 'HALF_UP_CENT' OR (p#>>'{fee,numerator}')::numeric>(p#>>'{fee,denominator}')::numeric) IS NOT FALSE
  THEN RAISE EXCEPTION 'withdrawal ratio fee rule invalid' USING ERRCODE='23514';END IF;
  expected_fee:=floor((i.gross_cents*(p#>>'{fee,numerator}')::numeric*2+(p#>>'{fee,denominator}')::numeric)/(2*(p#>>'{fee,denominator}')::numeric));
 ELSE RAISE EXCEPTION 'withdrawal fee rule unavailable' USING ERRCODE='23514';END IF;
 IF i.fee_cents IS DISTINCT FROM expected_fee THEN RAISE EXCEPTION 'withdrawal user fee differs from original policy' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO quota FROM zzsh_order.joinpay_withdrawal_intent WHERE user_id=i.user_id
  AND accepted_at>=(p->>'quotaStart')::timestamptz AND accepted_at<(p->>'quotaEnd')::timestamptz
  AND(p->>'frequencyBasis'='ACCEPTED_INTENT' OR state<>'FAILED');
 IF quota>=(p->>'maxIntents')::numeric THEN RAISE EXCEPTION 'withdrawal policy frequency exhausted' USING ERRCODE='23514';END IF;
END $_$;


--
-- Name: assert_legacy_duty_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_legacy_duty_complete(duty_id_value text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;e zzsh_order.finance_event;r zzsh_order.finance_economic_root;line_count bigint;debits numeric;credits numeric;good bigint;positive_account text;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=duty_id_value;
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=f.event_id;SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=f.root_id;
 IF f.duty_id IS NULL OR e.id IS NULL OR r.id IS NULL OR r.source_kind<>'LEGACY_CONTINUATION_DUTY' OR e.kind<>'LEGACY_DUTY_SETTLED' OR e.economic_root_id<>r.id
  OR r.subject_user_id<>f.subject_user_id OR e.subject_user_id<>f.subject_user_id OR r.source_digest<>f.facts_digest OR r.source_id<>f.duty_id
 THEN RAISE EXCEPTION 'legacy duty final root/event relation missing' USING ERRCODE='23514'; END IF;
 positive_account:=CASE f.kind WHEN 'RENTER_REFUND' THEN 'RENTER_REFUND_PAYABLE' WHEN 'COMMISSION' THEN 'WALLET_AVAILABLE' ELSE 'OWNER_AVAILABLE' END;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  (line_no=1 AND account_code=CASE WHEN f.kind='COMMISSION' THEN 'DISTRIBUTION_EXPENSE' ELSE 'LEGACY_LIABILITY_SOURCE' END AND debit_cents=f.amount_cents AND credit_cents=0 AND counterparty_user_id IS NULL)
  OR(line_no=2 AND account_code=positive_account AND debit_cents=0 AND credit_cents=f.amount_cents AND counterparty_user_id=f.subject_user_id AND id=f.ref_id))
 INTO line_count,debits,credits,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=f.event_id;
 IF line_count<>(CASE WHEN f.amount_cents=0 THEN 0 ELSE 2 END) OR debits<>f.amount_cents OR credits<>f.amount_cents OR good<>line_count
  OR(f.amount_cents=0 AND(f.ref_type<>'FINANCE_EVENT' OR f.ref_id<>f.event_id)) OR(f.amount_cents>0 AND f.ref_type<>'LEDGER_ENTRY')
 THEN RAISE EXCEPTION 'legacy duty positive/zero complete batch mismatch' USING ERRCODE='23514'; END IF;
END $$;


--
-- Name: legacy_order_duty; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_order_duty (
    id text NOT NULL,
    order_id text NOT NULL,
    continuation_version_id text,
    kind text NOT NULL,
    source_record_id text NOT NULL,
    counterparty_user_id text,
    amount_cents numeric(24,0) NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    source_status text,
    source_digest text NOT NULL,
    level integer,
    ratio numeric(24,8),
    maturity_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    revised_at timestamp with time zone,
    revised_by jsonb,
    revision_reason text,
    decided_at timestamp with time zone,
    decided_by jsonb,
    decision_reason text,
    decision_evidence_ref text,
    settled_by text,
    settled_ref_type text,
    settled_ref_id text,
    settled_ref_digest text,
    admission_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_duty_settlement_shape CHECK (((((status <> 'SETTLED'::text) AND (settled_by IS NULL) AND (settled_ref_type IS NULL) AND (settled_ref_id IS NULL) AND (settled_ref_digest IS NULL)) OR ((status = 'SETTLED'::text) AND (settled_by = 'LEGACY_RECORDS'::text) AND (source = 'LEGACY_IMPORT'::text) AND (kind = 'DEPOSIT_COMPENSATION'::text) AND (source_status = 'POSTED_CONFISCATION'::text) AND (settled_ref_type IS NULL) AND (settled_ref_id IS NULL) AND (settled_ref_digest IS NULL)) OR ((status = 'SETTLED'::text) AND (settled_by = 'FINANCE'::text) AND (settled_ref_id IS NOT NULL) AND (settled_ref_digest ~ '^[a-f0-9]{64}$'::text) AND (((amount_cents > (0)::numeric) AND (settled_ref_type = 'LEDGER_ENTRY'::text)) OR ((amount_cents = (0)::numeric) AND (settled_ref_type = 'FINANCE_EVENT'::text))))) IS TRUE)),
    CONSTRAINT legacy_order_duty_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT legacy_order_duty_check CHECK (((kind = 'COMMISSION'::text) OR (maturity_at IS NULL))),
    CONSTRAINT legacy_order_duty_check1 CHECK (((kind = 'COMMISSION'::text) OR ((level IS NULL) AND (ratio IS NULL)))),
    CONSTRAINT legacy_order_duty_check2 CHECK ((((kind <> 'COMMISSION'::text) OR ((source_status = '1'::text) AND (level = ANY (ARRAY[2, 3])) AND (ratio >= (0)::numeric))) IS TRUE)),
    CONSTRAINT legacy_order_duty_check3 CHECK (((kind = 'DEPOSIT_COMPENSATION'::text) OR (counterparty_user_id IS NOT NULL))),
    CONSTRAINT legacy_order_duty_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT legacy_order_duty_kind_check CHECK ((kind = ANY (ARRAY['RENTER_REFUND'::text, 'OWNER_CREDIT'::text, 'COMMISSION'::text, 'DEPOSIT_COMPENSATION'::text]))),
    CONSTRAINT legacy_order_duty_level_check CHECK ((level = ANY (ARRAY[2, 3]))),
    CONSTRAINT legacy_order_duty_revision_check CHECK ((revision > 0)),
    CONSTRAINT legacy_order_duty_settled_by_check CHECK ((settled_by = ANY (ARRAY['FINANCE'::text, 'LEGACY_RECORDS'::text]))),
    CONSTRAINT legacy_order_duty_source_check CHECK ((source = ANY (ARRAY['LEGACY_IMPORT'::text, 'CONTINUATION'::text]))),
    CONSTRAINT legacy_order_duty_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_duty_source_record_id_check CHECK (((length(source_record_id) >= 1) AND (length(source_record_id) <= 128))),
    CONSTRAINT legacy_order_duty_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'MATURED'::text, 'SETTLED'::text, 'VOID'::text])))
);


--
-- Name: assert_legacy_duty_finance_transition(zzsh_order.legacy_order_duty, zzsh_order.legacy_order_duty); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_legacy_duty_finance_transition(old_row zzsh_order.legacy_order_duty, new_row zzsh_order.legacy_order_duty) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;
BEGIN
 PERFORM zzsh_order.assert_legacy_finance_order_lock(old_row.order_id);
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=old_row.id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR f.duty_revision<>old_row.revision OR f.order_id<>old_row.order_id OR f.kind<>old_row.kind
  OR f.amount_cents<>old_row.amount_cents OR f.currency<>old_row.currency OR f.subject_user_id IS DISTINCT FROM old_row.counterparty_user_id
  OR new_row.status IS DISTINCT FROM 'SETTLED' OR new_row.settled_by IS DISTINCT FROM 'FINANCE' OR new_row.revision IS DISTINCT FROM old_row.revision+1
  OR new_row.settled_ref_type IS DISTINCT FROM f.ref_type OR new_row.settled_ref_id IS DISTINCT FROM f.ref_id OR new_row.settled_ref_digest IS DISTINCT FROM f.facts_digest
  OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM f.actor_id OR current_setting('zzsh.session_id',true) IS DISTINCT FROM f.session_id
 THEN RAISE EXCEPTION 'untrusted legacy duty financial transition' USING ERRCODE='23514'; END IF;
 PERFORM zzsh_order.assert_legacy_duty_complete(old_row.id);
END $$;


--
-- Name: assert_legacy_duty_funding(jsonb, zzsh_order.legacy_order_duty); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_legacy_duty_funding(p jsonb, d zzsh_order.legacy_order_duty) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE b zzsh_order.finance_opening_basis;c zzsh_order.personal_finance_observation_coverage;o zzsh_order.legacy_order_read_snapshot;
 actual_count bigint;actual_digest text;w jsonb;source_id_value text;entity_value text;types text[];resolved jsonb;bindings jsonb;
BEGIN
 SELECT basis.* INTO b FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis basis ON basis.id=wc.basis_id AND basis.user_id=wc.user_id
  WHERE wc.user_id=d.counterparty_user_id AND wc.origin='RECONCILED_OPENING' AND basis.source_kind='LEGACY_OPENING';
 SELECT * INTO c FROM zzsh_order.personal_finance_observation_coverage WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG' ORDER BY source_cutoff DESC,id COLLATE "C" DESC LIMIT 1;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=d.order_id;
 IF b.id IS NULL OR c.id IS NULL OR o.id IS NULL OR b.source_system<>'legacy_mysql_restore' OR c.source_system<>b.source_system OR c.legacy_user_id<>b.source_id
  OR c.source_entity<>'la_log_earnings' OR c.source_cutoff<>b.source_cutoff OR c.isolated_count<>0 OR c.source_count<>c.imported_count
 THEN RAISE EXCEPTION 'complete opening/history funding witness missing' USING ERRCODE='23514'; END IF;
 resolved:=zzsh_order.legacy_opening_source_proof(b.id);
 IF (resolved IS NOT NULL AND p#>>'{witness,sourceProofDigest}' IS DISTINCT FROM resolved->>'digest')
   OR(resolved IS NULL AND(p->'witness')?'sourceProofDigest')
 THEN RAISE EXCEPTION 'funding reviewed source proof digest differs' USING ERRCODE='23514';END IF;
 SELECT COALESCE(jsonb_object_agg(x->>'observationId',x),'{}'::jsonb) INTO bindings
  FROM jsonb_array_elements(resolved->'logBindings') x;

 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(source_id||':'||source_digest,chr(10) ORDER BY source_id COLLATE "C"),''),'UTF8')),'hex')
 INTO actual_count,actual_digest FROM zzsh_order.personal_finance_observation WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG'
  AND source_system='legacy_mysql_restore' AND source_entity='la_log_earnings' AND source_event_at<=c.source_cutoff;
 IF actual_count<>c.imported_count OR actual_count>20000 OR actual_digest<>c.imported_set_digest
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG'
   AND(source_system<>'legacy_mysql_restore' OR source_entity<>'la_log_earnings' OR source_type<>'LEGACY_MYSQL' OR source_event_at IS NULL OR source_event_at>c.source_cutoff))
 THEN RAISE EXCEPTION 'funding history source set does not close' USING ERRCODE='23514'; END IF;
 entity_value:=CASE WHEN d.kind='COMMISSION' THEN 'la_distribution_order' ELSE 'la_order' END;
 source_id_value:=CASE WHEN d.kind='COMMISSION' THEN d.source_record_id ELSE o.legacy_id END;
 types:=CASE d.kind WHEN 'COMMISSION' THEN ARRAY['LEGACY_DISTRIBUTION_EARNING'] WHEN 'RENTER_REFUND' THEN ARRAY['LEGACY_RENTAL_REFUND'] WHEN 'OWNER_CREDIT' THEN ARRAY['LEGACY_RENTAL_OWNER_INCOME'] ELSE ARRAY['LEGACY_DEPOSIT_COMPENSATION'] END;
 IF p->>'originalSourceEntity' IS DISTINCT FROM entity_value OR p->>'originalSourceId' IS DISTINCT FROM source_id_value OR p->>'originalOrderNumber' IS DISTINCT FROM NULLIF(o.original_order_no,'')
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_covered_event WHERE user_id=d.counterparty_user_id AND source_entity=entity_value AND source_id=source_id_value AND source_kind=ANY(types))
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation obs WHERE obs.user_id=d.counterparty_user_id AND obs.source_kind='HISTORICAL_EARNINGS_LOG'
   AND obs.snapshot->>'action'='1' AND (obs.snapshot->>'amount')::numeric>0 AND(NOT COALESCE(COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')=ANY(ARRAY['LEGACY_DISTRIBUTION_EARNING','LEGACY_RENTAL_REFUND','LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION','LEGACY_WITHDRAWAL','LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN']),false)
    OR COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')=ANY(types)
     AND(CASE WHEN bindings?obs.source_id THEN bindings->obs.source_id->>'sourceEntity'=entity_value AND bindings->obs.source_id->>'sourceId'=source_id_value
       ELSE obs.snapshot->>'referenceId' IN(source_id_value,o.original_order_no) OR obs.snapshot->>'referenceSn'=o.original_order_no END)
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_covered_event prior WHERE prior.basis_id=b.id AND prior.user_id=d.counterparty_user_id
     AND prior.source_kind=COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType') AND prior.source_type='LEGACY_MYSQL' AND prior.source_entity=CASE COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')
      WHEN 'LEGACY_DISTRIBUTION_EARNING' THEN 'la_distribution_order' WHEN 'LEGACY_WITHDRAWAL' THEN 'la_withdraw_apply' WHEN 'LEGACY_ADMIN_LOG' THEN 'la_log_earnings' WHEN 'LEGACY_WITHDRAWAL_RETURN' THEN 'la_log_earnings' ELSE 'la_order' END
     AND prior.source_id=CASE WHEN COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType') IN('LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN') THEN obs.source_id ELSE COALESCE(bindings->obs.source_id->>'sourceId',obs.snapshot->>'referenceId') END
     AND(NOT(bindings?obs.source_id) OR(prior.source_digest=bindings->obs.source_id->>'sourceDigest'
       AND prior.beneficiary_role=bindings->obs.source_id->>'beneficiaryRole')))))
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_fact other WHERE other.order_id=d.order_id AND other.kind=d.kind AND other.subject_user_id=d.counterparty_user_id
   AND(other.duty_id=d.id OR other.facts_canonical::jsonb#>>'{duty,sourceRecordId}'=d.source_record_id))
 THEN RAISE EXCEPTION 'legacy responsibility prior credit/posting not excluded' USING ERRCODE='23514'; END IF;
 w:=jsonb_build_object('openingBasisId',b.id,'openingSourceDigest',b.source_digest,'coveredSetDigest',b.covered_set_digest,
  'historyCoverageVersion',c.id||':'||c.imported_set_digest,'historyReferenceDigest',actual_digest,
  'historyCutoff',to_char(c.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceCount',actual_count::text);
 IF resolved IS NOT NULL THEN w:=w||jsonb_build_object('sourceProofDigest',resolved->>'digest');END IF;
 IF p->'witness' IS DISTINCT FROM w OR p->>'coverageEvidenceDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(w),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'funding DTO differs from immutable source witness' USING ERRCODE='23514'; END IF;
END $$;


--
-- Name: assert_legacy_finance_order_lock(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_legacy_finance_order_lock(order_id_value text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE key_value bigint;
BEGIN
 key_value:=('x'||substr(encode(sha256(convert_to(order_id_value,'UTF8')),'hex'),1,15))::bit(60)::bigint;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
  AND classid=((key_value>>32)&4294967295)::oid AND objid=(key_value&4294967295)::oid AND objsubid=1)
 THEN RAISE EXCEPTION 'shared mapped-order advisory lock required' USING ERRCODE='23514'; END IF;
END $$;


--
-- Name: rental_order; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_order (
    id text NOT NULL,
    display_no text NOT NULL,
    account_id text NOT NULL,
    listing_version_id text NOT NULL,
    owner_user_id text NOT NULL,
    renter_user_id text NOT NULL,
    game_id text NOT NULL,
    rule_release_id text NOT NULL,
    content_hash text NOT NULL,
    term_option_code text NOT NULL,
    status text NOT NULL,
    rental_amount_cents numeric(24,0) NOT NULL,
    deposit_amount_cents numeric(24,0) NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    term_seconds bigint NOT NULL,
    quote_snapshot jsonb NOT NULL,
    title text NOT NULL,
    hold_until timestamp with time zone NOT NULL,
    cancel_reason text,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    paid_confirmation_id text,
    paid_at timestamp with time zone,
    confirmation_id uuid,
    payment_disposition text GENERATED ALWAYS AS (
CASE
    WHEN (status = ANY (ARRAY['PAID'::text, 'COMPLETED'::text])) THEN 'APPLIED'::text
    ELSE NULL::text
END) STORED,
    CONSTRAINT rental_order_cancel_reason_check CHECK ((cancel_reason = ANY (ARRAY['USER'::text, 'TIMEOUT'::text, 'PRESTART_TERMINATED'::text, 'MANUAL_CLOSE'::text, 'SUPPORT_CANCELLED_REFUND'::text]))),
    CONSTRAINT rental_order_cancel_shape CHECK ((((status = 'CANCELLED'::text) AND (cancel_reason IS NOT NULL) AND (cancelled_at IS NOT NULL)) OR ((status = ANY (ARRAY['PENDING_PAYMENT'::text, 'PAID'::text, 'COMPLETED'::text])) AND (cancel_reason IS NULL) AND (cancelled_at IS NULL)))),
    CONSTRAINT rental_order_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_order_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT rental_order_deposit_amount_cents_check CHECK ((deposit_amount_cents >= (0)::numeric)),
    CONSTRAINT rental_order_payment_shape CHECK ((((status = ANY (ARRAY['PAID'::text, 'COMPLETED'::text])) AND (paid_confirmation_id IS NOT NULL) AND (paid_at IS NOT NULL)) OR ((status = 'PENDING_PAYMENT'::text) AND (paid_confirmation_id IS NULL) AND (paid_at IS NULL)) OR ((status = 'CANCELLED'::text) AND (((cancel_reason = ANY (ARRAY['PRESTART_TERMINATED'::text, 'MANUAL_CLOSE'::text, 'SUPPORT_CANCELLED_REFUND'::text])) AND (paid_confirmation_id IS NOT NULL) AND (paid_at IS NOT NULL)) OR ((cancel_reason = ANY (ARRAY['USER'::text, 'TIMEOUT'::text])) AND (paid_confirmation_id IS NULL) AND (paid_at IS NULL)))))),
    CONSTRAINT rental_order_rental_amount_cents_check CHECK ((rental_amount_cents >= (0)::numeric)),
    CONSTRAINT rental_order_renter_not_owner CHECK ((renter_user_id <> owner_user_id)),
    CONSTRAINT rental_order_revision_check CHECK ((revision > 0)),
    CONSTRAINT rental_order_status_check CHECK ((status = ANY (ARRAY['PENDING_PAYMENT'::text, 'CANCELLED'::text, 'PAID'::text, 'COMPLETED'::text]))),
    CONSTRAINT rental_order_term_seconds_check CHECK ((term_seconds > 0))
);


--
-- Name: assert_personal_growth_order_v4(zzsh_order.rental_order); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.assert_personal_growth_order_v4(n zzsh_order.rental_order) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE p jsonb:=n.quote_snapshot->'personal';g jsonb;b jsonb;f jsonb;r jsonb;d jsonb;v zzsh_supply.listing_version;k int;
BEGIN
 g:=p->'membershipGrowth';b:=g->'binding';f:=p->'funding';r:=p->'ruleRefs';d:=p->'fullPayoutDeclaration';
 IF n.confirmation_id IS NULL OR n.quote_snapshot->>'quoteKind' IS DISTINCT FROM 'ORDER_CONFIRMATION' OR n.quote_snapshot->>'confirmationId' IS DISTINCT FROM n.confirmation_id::text
  OR n.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1' OR COALESCE(n.quote_snapshot->>'confirmationDigest','')!~'^[a-f0-9]{64}$'
  OR p->>'schema' IS DISTINCT FROM 'personal-quote-v4' OR n.quote_snapshot?'confirmationToken' OR n.quote_snapshot?'signature'
  OR p?'membership' OR p->>'userId' IS DISTINCT FROM n.renter_user_id OR p->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR p->>'accountId' IS DISTINCT FROM n.account_id
  OR p->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR p->>'listingHash' IS DISTINCT FROM n.content_hash OR n.quote_snapshot->>'listingHash' IS DISTINCT FROM n.content_hash
  OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(g) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object'
  OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(d) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'personal quote v4 binding invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p);
 IF k<>11 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE NOT(x=ANY(ARRAY['schema','userId','ownerUserId','accountId','listingVersionId','listingHash','fullPayoutDeclaration','ruleRefs','membershipGrowth','guarantee','funding'])))
  THEN RAISE EXCEPTION 'personal quote v4 shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(d);
 IF k<>2 OR d->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1' OR jsonb_typeof(d->'selected') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'personal quote v4 declaration invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(r);
 IF k<>5 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) x WHERE NOT(x=ANY(ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(r) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR r->>'releaseId' IS DISTINCT FROM n.rule_release_id OR r->>'priceVersionId' IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR COALESCE(r->>'agreementDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 rules invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(f);
 IF k<>7 OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) x WHERE NOT(x=ANY(ARRAY['version','sourceRef','baseDepositCents','publisherBailRequirementCents','fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(f) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR COALESCE(f->>'baseDepositCents','')!~'^(0|[1-9][0-9]{0,17})$' OR COALESCE(f->>'publisherBailRequirementCents','')!~'^(0|[1-9][0-9]{0,17})$'
  THEN RAISE EXCEPTION 'personal quote v4 funding invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p->'guarantee') IS DISTINCT FROM 'object' OR COALESCE(p#>>'{guarantee,status}','') NOT IN('SATISFIED','NOT_REQUIRED') OR COALESCE(p#>>'{guarantee,reference}','')=''
  THEN RAISE EXCEPTION 'personal quote v4 guarantee invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p->'guarantee');IF k<>2 THEN RAISE EXCEPTION 'personal quote v4 guarantee shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(g);
 IF k<>16 OR EXISTS(SELECT 1 FROM jsonb_object_keys(g) x WHERE NOT(x=ANY(ARRAY['schema','policyVersion','effectiveTier','policyTier','selectedSource','depositSource','entitlementIds','binding','selectedBenefitVersion','selectedEntitlementId','selectedValidUntil','depositBenefitVersion','depositEntitlementId','depositValidUntil','pricePlanDigest','depositCents'])))
  OR g->>'schema' IS DISTINCT FROM 'membership-growth-v2' OR COALESCE(g->>'policyVersion','')!~'^[1-9][0-9]{0,18}$'
  OR COALESCE(g->>'effectiveTier','') NOT IN('STANDARD','SILVER','GOLD','PLATINUM','DIAMOND','BLACK_GOLD')
  OR g->>'policyTier' IS DISTINCT FROM(CASE WHEN g->>'effectiveTier'='BLACK_GOLD' THEN 'DIAMOND' ELSE g->>'effectiveTier' END)
  OR COALESCE(g->>'selectedSource','') NOT IN('GROWTH','FRIEND','PRESTIGE') OR COALESCE(g->>'depositSource','') NOT IN('GROWTH','FRIEND','PRESTIGE')
  OR COALESCE(g->>'selectedBenefitVersion','')='' OR COALESCE(g->>'depositBenefitVersion','')='' OR COALESCE(g->>'pricePlanDigest','')!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(g->'entitlementIds') IS DISTINCT FROM 'array' OR COALESCE(g->>'depositCents','')!~'^(0|[1-9][0-9]{0,23})$'
  THEN RAISE EXCEPTION 'personal quote v4 growth invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(g->'selectedEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'depositEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'selectedValidUntil') NOT IN('null','string') OR jsonb_typeof(g->'depositValidUntil') NOT IN('null','string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(g->'entitlementIds') e WHERE jsonb_typeof(e)<>'string' OR COALESCE(e#>>'{}','')='')
  OR EXISTS(SELECT 1 FROM (SELECT x.source,x.ref,x.until FROM(VALUES(g->>'selectedSource',g->>'selectedEntitlementId',g->>'selectedValidUntil'),(g->>'depositSource',g->>'depositEntitlementId',g->>'depositValidUntil'))x(source,ref,until))z
    WHERE(z.source='GROWTH' AND(z.ref IS NOT NULL OR z.until IS NOT NULL)) OR(z.source<>'GROWTH' AND(z.ref IS NULL OR z.until IS NULL OR NOT(g->'entitlementIds'?z.ref) OR z.until::timestamptz<=clock_timestamp())))
  THEN RAISE EXCEPTION 'personal quote v4 entitlement invalid or expired' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(b);
 IF k<>6 OR b->>'userId' IS DISTINCT FROM n.renter_user_id OR b->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR b->>'accountId' IS DISTINCT FROM n.account_id
  OR b->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR b->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR COALESCE(b->>'quantityDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 offer binding invalid' USING ERRCODE='40001';END IF;
 IF n.quote_snapshot->>'currency' IS DISTINCT FROM 'CNY' OR n.currency IS DISTINCT FROM 'CNY' OR n.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR n.quote_snapshot->>'termSeconds' IS DISTINCT FROM n.term_seconds::text
  OR n.quote_snapshot#>>'{tenantDeposit,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{tenantDeposit,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{tenantDeposit,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{tenantDeposit,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(n.quote_snapshot#>>'{tenantDeposit,amount}')::numeric*100 IS DISTINCT FROM n.deposit_amount_cents
  OR n.quote_snapshot#>>'{resourceTotal,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{resourceTotal,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{resourceTotal,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{resourceTotal,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(g->>'depositCents')::numeric IS DISTINCT FROM n.deposit_amount_cents OR(n.quote_snapshot#>>'{resourceTotal,amount}')::numeric*100 IS DISTINCT FROM n.rental_amount_cents
  THEN RAISE EXCEPTION 'personal quote v4 quote amounts invalid' USING ERRCODE='40001';END IF;
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=n.listing_version_id AND account_id=n.account_id AND content_hash=n.content_hash AND rule_release_id=n.rule_release_id;
 IF NOT FOUND OR v.payload->>'accountId' IS DISTINCT FROM n.account_id OR v.payload->>'gameId' IS DISTINCT FROM n.game_id
  OR v.payload#>>'{ruleRefs,releaseId}' IS DISTINCT FROM r->>'releaseId' OR v.payload#>>'{ruleRefs,priceVersionId}' IS DISTINCT FROM r->>'priceVersionId'
  OR v.payload#>>'{ruleRefs,termVersionId}' IS DISTINCT FROM r->>'termVersionId' OR v.payload#>>'{ruleRefs,agreementVersionId}' IS DISTINCT FROM r->>'agreementVersionId'
  OR v.payload#>>'{ruleRefs,agreementDigest}' IS DISTINCT FROM r->>'agreementDigest' OR v.payload#>'{declaration,attributes,full_payout_declaration}' IS DISTINCT FROM d
  OR v.payload#>>'{quoteValues,priceVersionId}' IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR v.payload#>>'{quoteValues,termSeconds}' IS DISTINCT FROM n.term_seconds::text
  OR b->>'quantityDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload#>'{quoteValues,lines}'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'personal quote v4 listing reference invalid' USING ERRCODE='40001';END IF;
 IF COALESCE(n.quote_snapshot->>'confirmationExpiresAt','')!~'^[1-9][0-9]{0,11}$' OR(n.quote_snapshot->>'confirmationExpiresAt')::numeric<=extract(epoch FROM clock_timestamp())
  THEN RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';END IF;
END $_$;


--
-- Name: canonical_finance_json(jsonb, integer); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.canonical_finance_json(value jsonb, depth integer DEFAULT 0) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE result text;entry record;number_value numeric;
BEGIN
 IF depth<0 OR depth>24 OR value IS NULL THEN RAISE EXCEPTION 'financial JSON depth/value unsupported' USING ERRCODE='23514';END IF;
 CASE jsonb_typeof(value)
 WHEN 'null' THEN RETURN 'null';
 WHEN 'boolean' THEN RETURN value::text;
 WHEN 'string' THEN RETURN value::text;
 WHEN 'number' THEN
  number_value:=value::text::numeric;
  IF number_value<>trunc(number_value) OR abs(number_value)>9007199254740991
  THEN RAISE EXCEPTION 'financial JSON numbers must be safe integers' USING ERRCODE='23514';END IF;
  RETURN number_value::numeric(16,0)::text;
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(zzsh_order.canonical_finance_json(v,depth+1),',' ORDER BY ordinal),'')||']'
   INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS a(v,ordinal);RETURN result;
 WHEN 'object' THEN
  FOR entry IN SELECT key FROM jsonb_each(value) LOOP
   IF entry.key='contentHash' OR entry.key!~'^[ -~]*$'
   THEN RAISE EXCEPTION 'financial canonical object key unsupported' USING ERRCODE='23514';END IF;
  END LOOP;
  SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||zzsh_order.canonical_finance_json(v,depth+1),',' ORDER BY key COLLATE "C"),'')||'}'
   INTO result FROM jsonb_each(value) AS e(key,v);RETURN result;
 ELSE RAISE EXCEPTION 'financial JSON type unsupported' USING ERRCODE='23514';
 END CASE;
END $_$;


--
-- Name: capture_native_user_insert(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.capture_native_user_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'zzsh_auth_user' OR TG_TABLE_NAME<>'user' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'only original user INSERT can issue proof' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.native_user_insert_proof(user_id,insert_xid)
  VALUES(NEW.id,pg_current_xact_id());
 RETURN NEW;
END $$;


--
-- Name: check_abnormal_refund_liability_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_abnormal_refund_liability_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_id text;ev zzsh_order.finance_event;r zzsh_order.finance_economic_root;c zzsh_order.payment_confirmation;
  total bigint;debit_total numeric;credit_total numeric;good bigint;
BEGIN
  IF TG_TABLE_NAME='finance_event' THEN event_id:=NEW.id; ELSE event_id:=NEW.finance_event_id; END IF;
  SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=event_id AND kind='REFUND_LIABILITY_RECOGNIZED';
  IF ev.id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;
  IF r.source_kind='NATIVE_PRESTART_REFUND' THEN RETURN NULL;END IF;
  SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=r.source_id;
  IF r.id IS NULL OR c.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' THEN
    RAISE EXCEPTION 'abnormal refund liability batch original missing' USING ERRCODE='23514';
  END IF;
  SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),
         count(*) FILTER(WHERE source_payment_confirmation_id IS NULL
           AND details=jsonb_build_object('abnormalRefundLiabilityId',c.id,'paymentConfirmationId',c.id,
             'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',c.amount_cents::text)
           AND((line_no=1 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=c.amount_cents AND credit_cents=0
               AND counterparty_user_id IS NULL)
             OR(line_no=2 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=0 AND credit_cents=c.amount_cents
               AND counterparty_user_id=r.subject_user_id)))
    INTO total,debit_total,credit_total,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
  IF total<>2 OR good<>2 OR debit_total<>c.amount_cents OR credit_total<>c.amount_cents THEN
    RAISE EXCEPTION 'abnormal refund liability batch is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;


--
-- Name: check_applied_payment(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_applied_payment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.disposition = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.rental_order o
      JOIN zzsh_order.im_order_group g ON g.order_id=o.id AND g.payment_confirmation_id=NEW.id
     WHERE o.id=NEW.order_id AND o.paid_confirmation_id=NEW.id AND o.status='PAID'
       AND ((NEW.source='CONTROLLED' AND o.display_no=NEW.merchant_order_no)
        OR(NEW.source='JOINPAY' AND EXISTS(SELECT 1 FROM zzsh_order.payment_request r WHERE r.id=NEW.joinpay_request_id AND r.order_id=o.id AND r.channel_order_no=NEW.merchant_order_no))) AND o.currency=NEW.currency
       AND o.rental_amount_cents+o.deposit_amount_cents=NEW.amount_cents
       AND o.paid_at=NEW.accepted_at AND o.paid_at < o.hold_until
  ) THEN
    RAISE EXCEPTION 'applied payment must match paid order and waiting intent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;


--
-- Name: check_channel_transaction_confirmation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_channel_transaction_confirmation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.confirmation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.payment_confirmation p
     WHERE p.id = NEW.confirmation_id AND p.order_id = NEW.native_order_id AND p.source = NEW.channel
       AND p.merchant_scope_id = NEW.merchant_identity_id AND p.provider_transaction_id = NEW.channel_trx_no) THEN
    RAISE EXCEPTION 'channel transaction anchor must match its confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;


--
-- Name: check_controlled_notice_result_receipt(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_controlled_notice_result_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE n zzsh_order.controlled_payout_notice;
BEGIN
 SELECT * INTO n FROM zzsh_order.controlled_payout_notice WHERE intent_id=NEW.intent_id
  AND 'controlled-notice-'||substr(encode(sha256(convert_to(id,'UTF8')),'hex'),1,48)=NEW.result_key;
 IF n.id IS NULL OR n.source_digest IS DISTINCT FROM NEW.evidence_digest OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='controlled.withdrawal.notice.processed' AND a.object_id=n.id
   AND a.details->>'sourceDigest'=n.source_digest AND a.details->>'providerFactId'=NEW.id AND a.details->>'resultKey'=NEW.result_key)
 THEN RAISE EXCEPTION 'notice result requires atomic source and conclusion receipt' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;


--
-- Name: check_distribution_relation_knowledge(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_distribution_relation_knowledge() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE subject text;p zzsh_order.distribution_participant;inviter_count integer;leader_count integer;
BEGIN
 IF TG_TABLE_NAME='distribution_participant' THEN subject:=NEW.user_id;
 ELSIF TG_TABLE_NAME='invitation_relation' THEN subject:=NEW.child_user_id;
 ELSE RAISE EXCEPTION 'unadmitted relation knowledge trigger table' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=subject;
 SELECT count(*) FILTER(WHERE type='INVITER'),count(*) FILTER(WHERE type='DISTRIBUTION_LEADER')
  INTO inviter_count,leader_count FROM zzsh_order.invitation_relation WHERE child_user_id=subject;
 IF p.user_id IS NULL OR (p.inviter_knowledge='KNOWN_PARENT') IS DISTINCT FROM (inviter_count=1)
  OR (p.leader_knowledge='KNOWN_PARENT') IS DISTINCT FROM (leader_count=1)
 THEN RAISE EXCEPTION 'invitation relation and participant knowledge disagree' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_earning_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_earning_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;r zzsh_order.rental_referral_earning;lines integer;dr numeric;cr numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN target:=NEW.id;
 ELSE target:=NEW.finance_event_id;END IF;
 SELECT x.* INTO r FROM zzsh_order.rental_referral_earning x JOIN zzsh_order.finance_event e ON e.economic_root_id=x.economic_root_id WHERE e.id=target;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=target;
 IF r.id IS NULL OR lines<>(SELECT count(*) FROM zzsh_order.earning_expected_lines(target)) OR dr<>r.amount_cents OR cr<>r.amount_cents
 THEN RAISE EXCEPTION 'earning batch is missing, duplicated or unbalanced' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;


--
-- Name: check_earning_reverse_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_earning_reverse_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE root_id text;r zzsh_order.rental_referral_earning;root zzsh_order.finance_economic_root;pending_count integer;settled_count integer;revoked_count integer;action_count integer;e zzsh_order.finance_event;
BEGIN
 IF TG_TABLE_NAME='finance_economic_root' THEN root_id:=NEW.id;
 ELSIF TG_TABLE_NAME IN('rental_referral_earning','finance_event') THEN root_id:=NEW.economic_root_id;
 ELSE root_id:=NEW.earning_id;END IF;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=root_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=root_id;
 IF r.id IS NULL OR root.id IS NULL OR root.source_kind<>'NATIVE_RENTAL_REFERRAL' OR root.source_type<>'NATIVE'
  OR root.source_system<>'zzsh' OR root.source_entity<>'rental_order' OR root.source_id<>r.order_id
  OR root.subject_user_id<>r.beneficiary_user_id OR root.beneficiary_role<>r.beneficiary_role OR root.source_digest<>r.posting_digest
 THEN RAISE EXCEPTION 'earning root and frozen source are not bidirectionally bound' USING ERRCODE='23514';END IF;
 SELECT count(*) FILTER(WHERE kind='EARNING_PENDING'),count(*) FILTER(WHERE kind='EARNING_SETTLED'),count(*) FILTER(WHERE kind='EARNING_REVOKED')
  INTO pending_count,settled_count,revoked_count FROM zzsh_order.finance_event WHERE economic_root_id=root_id;
 IF pending_count<>1 OR settled_count>1 OR revoked_count>1
  OR r.state='PENDING' AND(settled_count<>0 OR revoked_count<>0)
  OR r.state IN('SETTLED','RECOVERY_REQUIRED') AND(settled_count<>1 OR revoked_count<>0)
  OR r.state='REVOKED' AND revoked_count<>1
 THEN RAISE EXCEPTION 'earning state has missing/extra original financial actions' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO action_count FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id;
 IF action_count<>r.version OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='ACCRUE' AND result_version=1)
  OR r.state IN('SETTLED','RECOVERY_REQUIRED') AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='SETTLE')
  OR r.state IN('REVOKED','RECOVERY_REQUIRED') AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='REVOKE' AND reversal_source_id IS NOT NULL)
 THEN RAISE EXCEPTION 'earning has missing original state/action receipt' USING ERRCODE='23514';END IF;
 FOR e IN SELECT * FROM zzsh_order.finance_event WHERE economic_root_id=root_id LOOP
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND finance_event_id=e.id
    AND(e.kind='EARNING_PENDING' AND action='ACCRUE' OR e.kind='EARNING_SETTLED' AND action='SETTLE' OR e.kind='EARNING_REVOKED' AND action IN('REVOKE','RECOVER')))
  THEN RAISE EXCEPTION 'earning financial action has no exact transition receipt' USING ERRCODE='23514';END IF;
 END LOOP;
 IF r.state='RECOVERY_REQUIRED' AND EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='REVOKE' AND finance_event_id IS NOT NULL)
 THEN RAISE EXCEPTION 'recovery required must not falsely post a completed reversal' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=r.id AND action='RECOVER') AND(
  r.state<>'REVOKED' OR settled_count<>1 OR revoked_count<>1 OR NOT EXISTS(
   SELECT 1 FROM zzsh_order.rental_referral_transition debt JOIN zzsh_order.rental_referral_transition recovered ON recovered.earning_id=debt.earning_id
   WHERE debt.earning_id=r.id AND debt.action='REVOKE' AND debt.finance_event_id IS NULL AND recovered.action='RECOVER'
    AND recovered.reversal_source_id=debt.reversal_source_id AND recovered.expected_version=debt.result_version AND recovered.finance_event_id IS NOT NULL))
 THEN RAISE EXCEPTION 'recovery completion requires the same original outstanding reversal and one real debit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_finance_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_finance_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_id_value text;event_row zzsh_order.finance_event;root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;
 line_count bigint;debit_sum numeric;credit_sum numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN event_id_value:=NEW.id; ELSE event_id_value:=NEW.finance_event_id; END IF;
 SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=event_id_value;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=event_row.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO line_count,debit_sum,credit_sum FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=event_id_value;
 IF line_count<>(CASE WHEN basis.available_cents=0 THEN 0 ELSE 2 END) OR debit_sum<>basis.available_cents OR credit_sum<>basis.available_cents
 OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=event_row.subject_user_id AND basis_id=basis.id AND opening_event_id=event_row.id) THEN
  RAISE EXCEPTION 'batch incomplete, unbalanced or coverage missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_guarantee_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_guarantee_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target text;
  e zzsh_order.finance_event;
  root zzsh_order.finance_economic_root;
  amount numeric;
  count_lines bigint;
  debits numeric;
  credits numeric;
BEGIN
  -- The trigger is shared by two relations. Keep NEW field lookup inside the
  -- relation-specific branch; the runtime role must not gain UPDATE merely to
  -- acquire a row lock on immutable finance_event rows.
  IF TG_TABLE_NAME = 'finance_event' THEN
    target := NEW.id;
  ELSE
    target := NEW.finance_event_id;
  END IF;
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id = target;
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id = e.economic_root_id;
  IF root.source_entity = 'owner_guarantee_payment' THEN
    SELECT COALESCE(observed_amount_cents, amount_cents) INTO amount
      FROM zzsh_order.owner_guarantee_payment WHERE id = root.source_id;
  ELSE
    SELECT amount_cents INTO amount
      FROM zzsh_order.owner_guarantee_refund WHERE id = root.source_id;
  END IF;
  SELECT count(*), COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0)
    INTO count_lines, debits, credits
    FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id = target;
  IF e.kind NOT IN ('GUARANTEE_CAPTURE', 'GUARANTEE_REFUND')
     OR count_lines <> 2 OR debits <> amount OR credits <> amount THEN
    RAISE EXCEPTION 'guarantee ledger batch incomplete or unbalanced' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;


--
-- Name: check_joinpay_collection_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_joinpay_collection_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_CANDIDATE' AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_binding WHERE request_id=NEW.id) THEN
  RAISE EXCEPTION 'collection request requires immutable wire evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.evidence_level='JOINPAY_CANDIDATE' THEN
  IF NEW.lease_version>OLD.lease_version AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_attempt WHERE request_id=NEW.id AND lease_version=NEW.lease_version AND lease_owner=NEW.lease_owner) THEN
   RAISE EXCEPTION 'collection lease requires a committed attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) AND NOT EXISTS(
   SELECT 1 FROM zzsh_order.joinpay_collection_observation o JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id
   WHERE o.request_id=NEW.id AND a.lease_version=NEW.lease_version AND o.state_before=OLD.state AND o.state_after=NEW.state AND o.event<>'E9') THEN
   RAISE EXCEPTION 'collection transition requires its raw observation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;


--
-- Name: check_joinpay_formal_confirmation_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NEW.disposition='APPLIED' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.payment_distribution_basis b ON b.order_id=r.order_id AND b.payment_confirmation_id=NEW.id
   JOIN zzsh_order.distribution_order_admission a ON a.id=b.admission_id AND a.order_id=b.order_id AND a.revision=b.admission_revision
  WHERE r.id=NEW.joinpay_request_id AND r.state='ACCEPTED' AND a.mode='NATIVE' AND a.active)
 THEN RAISE EXCEPTION 'formal APPLIED requires same-transaction accepted request and complete native basis' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_joinpay_native_admission_pair(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_joinpay_native_admission_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b record;a record;r record;order_id_value text;
BEGIN
 IF TG_TABLE_NAME='joinpay_collection_binding' THEN
  IF NEW.formal_admission_ref IS NULL THEN RETURN NULL;END IF;
  SELECT order_id INTO order_id_value FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 ELSE
  IF NEW.mode<>'NATIVE' THEN RETURN NULL;END IF;order_id_value:=NEW.order_id;
 END IF;
 SELECT p.*,x.formal_admission_ref,x.formal_admission_sha256 INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding x ON x.request_id=p.id WHERE p.order_id=order_id_value;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=order_id_value;
 IF r.id IS NULL OR r.formal_admission_ref IS NULL OR a.id IS NULL OR a.mode<>'NATIVE'
  OR a.source_admission_ref IS DISTINCT FROM r.formal_admission_ref OR a.approval_digest IS DISTINCT FROM r.formal_admission_sha256
 THEN RAISE EXCEPTION 'formal initial binding and native admission must co-commit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_joinpay_withdrawal_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_joinpay_withdrawal_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;attempt_id_value text;observation_id_value text;a zzsh_order.joinpay_payout_attempt;o zzsh_order.joinpay_payout_observation;
BEGIN
 IF TG_TABLE_NAME='joinpay_withdrawal_intent' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='joinpay_payout_attempt' THEN target:=NEW.intent_id;attempt_id_value:=NEW.id;
 ELSIF TG_TABLE_NAME='joinpay_payout_observation' THEN
  target:=NEW.intent_id;observation_id_value:=NEW.id;
  IF NEW.event='PENDING_TERMINAL' AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_payout_evidence WHERE observation_id=NEW.id)
  THEN RAISE EXCEPTION 'payout pending raw has no terminal evidence' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='joinpay_payout_evidence' THEN target:=NEW.intent_id;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 ELSE target:=NEW.details->>'joinpayWithdrawalIntentId';END IF;
 IF attempt_id_value IS NOT NULL THEN
  SELECT * INTO a FROM zzsh_order.joinpay_payout_attempt WHERE id=attempt_id_value;
  IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event x WHERE x.action='joinpay.payout.claimed' AND x.object_id=target AND x.object_type='joinpay_withdrawal_intent'
   AND x.outcome='SUCCESS' AND x.details=jsonb_build_object('attemptId',a.id,'leaseVersion',a.lease_version::text,'operation',a.operation,'profileSha256',a.profile_sha256,'requestSha256',a.request_sha256))
  THEN RAISE EXCEPTION 'payout attempt missing original atomic claim audit' USING ERRCODE='23514';END IF;
 END IF;
 IF observation_id_value IS NOT NULL THEN
  SELECT * INTO o FROM zzsh_order.joinpay_payout_observation WHERE id=observation_id_value;
  IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event x WHERE x.action='joinpay.payout.observed' AND x.object_id=target AND x.object_type='joinpay_withdrawal_intent'
   AND x.outcome='SUCCESS' AND x.details=jsonb_build_object('observationId',o.id,'attemptId',o.attempt_id,'leaseVersion',o.lease_version::text,'operation',o.operation,
    'profileSha256',o.profile_sha256,'event',o.event,'evidenceLevel',o.evidence_level,'rawSha256',o.raw_sha256))
  THEN RAISE EXCEPTION 'payout raw missing original atomic observed audit' USING ERRCODE='23514';END IF;
 END IF;
 IF zzsh_order.joinpay_withdrawal_complete(target) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'withdrawal reserve/terminal reverse closure incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_legacy_continuation_result(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_legacy_continuation_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.legacy_continuation_evidence;r zzsh_order.legacy_continuation_evidence;p zzsh_order.legacy_continuation_version;l zzsh_order.legacy_order_read_snapshot;s int;d int;
BEGIN
 SELECT * INTO i FROM zzsh_order.legacy_continuation_evidence WHERE id=NEW.input_evidence_id AND order_id=NEW.order_id;
 SELECT * INTO r FROM zzsh_order.legacy_continuation_evidence WHERE id=NEW.result_evidence_id AND order_id=NEW.order_id;
 SELECT * INTO l FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 SELECT * INTO p FROM zzsh_order.legacy_continuation_version WHERE order_id=NEW.order_id AND revision=NEW.revision-1;
 IF i.id IS NULL OR r.id IS NULL OR l.id IS NULL OR i.admission<>'PARAMETER_COMPLETE' OR r.admission<>'PARAMETER_COMPLETE'
   OR r.source_kind<>'DERIVED' OR r.derived_from_command_version_id IS DISTINCT FROM NEW.id
   OR r.facts#>>'{derivedFromEvidenceId}' IS DISTINCT FROM i.id OR r.facts#>>'{derivedFromCommandVersionId}' IS DISTINCT FROM NEW.id
   OR NEW.amounts IS DISTINCT FROM r.facts->'amounts' OR r.parameter_digest IS DISTINCT FROM r.facts#>>'{evidence,parameterDigest}'
   OR r.source_digest<>l.source_digest OR i.source_digest<>l.source_digest
   OR r.facts#>>'{evidence,source,legacyOrderId}' IS DISTINCT FROM l.legacy_id OR r.facts#>>'{evidence,source,renterId}' IS DISTINCT FROM l.legacy_renter_id
   OR r.facts#>>'{evidence,source,ownerId}' IS DISTINCT FROM l.legacy_owner_id OR r.facts#>>'{evidence,source,accountId}' IS DISTINCT FROM l.legacy_account_id
   OR r.facts#>>'{evidence,provenance,profitDot}' IS DISTINCT FROM 'ORDER_COLUMN' OR r.facts#>>'{evidence,provenance,baseBot}' IS DISTINCT FROM 'ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN'
   OR (r.facts#>>'{evidence,source,orderStatus}')::int IS DISTINCT FROM NEW.stage OR (r.facts#>>'{evidence,source,isSettle}')::int IS DISTINCT FROM NEW.is_settle
   OR r.created_xid IS DISTINCT FROM NEW.created_xid
 THEN RAISE EXCEPTION 'Legacy result binding mismatch' USING ERRCODE='23514'; END IF;
 IF(NEW.revision=1 AND(i.source_kind<>'SOURCE_IMPORT' OR p.id IS NOT NULL))
   OR(NEW.revision>1 AND(p.id IS NULL OR p.result_evidence_id<>i.id OR p.superseded_at IS NULL))
 THEN RAISE EXCEPTION 'Legacy head lineage mismatch' USING ERRCODE='23514'; END IF;
 s:=(i.facts#>>'{evidence,source,orderStatus}')::int;d:=(i.facts#>>'{evidence,source,isSettle}')::int;
 IF(
   (NEW.command='PROPOSE' AND s=3 AND NEW.actor->>'realm'='user' AND((NEW.stage=8 AND NEW.actor->>'userId'=l.renter_user_id) OR(NEW.stage=9 AND NEW.actor->>'userId'=l.owner_user_id)))
   OR(NEW.command='CONFIRM' AND NEW.stage=4 AND NEW.actor->>'realm'='user' AND((s=8 AND NEW.actor->>'userId'=l.owner_user_id) OR(s=9 AND NEW.actor->>'userId'=l.renter_user_id)))
   OR(NEW.command='REJECT' AND NEW.stage=3 AND NEW.actor->>'realm'='user' AND((s=8 AND NEW.actor->>'userId'=l.owner_user_id) OR(s=9 AND NEW.actor->>'userId'=l.renter_user_id)))
   OR(NEW.actor->>'realm'='admin' AND NEW.stage=s AND((NEW.command='HOLD' AND d=0 AND NEW.is_settle=2) OR(NEW.command='RELEASE' AND d=2 AND NEW.is_settle=0) OR(NEW.command='CONFISCATE' AND d=2 AND NEW.is_settle=3)))
 ) IS NOT TRUE THEN RAISE EXCEPTION 'Legacy command transition or actor invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_legacy_duty_admission(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_legacy_duty_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE d zzsh_order.legacy_order_duty;l zzsh_order.legacy_order_read_snapshot;s jsonb;f jsonb;t jsonb;
BEGIN
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
 SELECT * INTO l FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 s:=NEW.source_canonical::jsonb;f:=NEW.final_amount_evidence_canonical::jsonb;t:=NEW.time_evidence_canonical::jsonb;
 IF d.id IS NULL OR l.source_order_status IS DISTINCT FROM 4 OR l.source_pay_status IS DISTINCT FROM 1
  OR(d.order_id,d.kind,d.source_record_id,d.counterparty_user_id,d.amount_cents,d.currency,d.level,d.ratio,d.maturity_at,d.admission_id)
   IS DISTINCT FROM(NEW.order_id,NEW.kind,NEW.source_record_id,NEW.counterparty_user_id,NEW.amount_cents,NEW.currency,NEW.level,NEW.ratio,NEW.maturity_at,NEW.id)
  OR NEW.parent_source_digest IS DISTINCT FROM l.source_digest OR s->>'order_id' IS DISTINCT FROM l.legacy_id OR s->>'id' IS DISTINCT FROM NEW.source_record_id
  OR s->>'status' IS DISTINCT FROM '1' OR(s->>'earnings')::numeric*100 IS DISTINCT FROM NEW.amount_cents
  OR f->>'parentSourceDigest' IS DISTINCT FROM NEW.parent_source_digest OR f->>'sourceRecordDigest' IS DISTINCT FROM NEW.source_record_digest
  OR f->>'beneficiaryLegacyId' IS DISTINCT FROM s->>'user_id' OR(f->>'amountCents')::numeric IS DISTINCT FROM NEW.amount_cents
  OR(f->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR t->>'parentSourceDigest' IS DISTINCT FROM NEW.parent_source_digest OR t->>'sourceRecordDigest' IS DISTINCT FROM NEW.source_record_digest
  OR t->>'kind' IS DISTINCT FROM NEW.time_kind OR(t->>'at')::timestamptz IS DISTINCT FROM NEW.source_time OR(t->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR t->>'sourceValue' IS DISTINCT FROM NEW.source_time_value OR t->>'sourceUnit' IS DISTINCT FROM NEW.source_time_unit
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.user_identity_state i WHERE i.user_id=NEW.counterparty_user_id AND i.provider='legacy_mysql_restore' AND i.provider_reference='la_user:'||(s->>'user_id'))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=NEW.order_id AND a.action='order.legacy.commission.completed-import' AND a.outcome='SUCCESS'
   AND a.actor_type='admin' AND a.actor_id=NEW.reviewed_by->>'userId' AND a.session_id=NEW.reviewed_by->>'sessionId'
   AND a.details->>'admissionId'=NEW.id AND a.details->>'admissionDigest'=NEW.admission_digest)
 THEN RAISE EXCEPTION 'Completed commission admission/actor/audit incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_legacy_duty_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_legacy_duty_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE duty_id_value text;d zzsh_order.legacy_order_duty;f zzsh_order.legacy_duty_finance_fact;
BEGIN
 IF TG_TABLE_NAME='legacy_duty_finance_fact' THEN duty_id_value:=NEW.duty_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT duty_id INTO duty_id_value FROM zzsh_order.legacy_duty_finance_fact WHERE event_id=NEW.id;
 ELSE duty_id_value:=NEW.details->>'legacyDutyId';END IF;
 PERFORM zzsh_order.assert_legacy_duty_complete(duty_id_value);
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=duty_id_value;SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=duty_id_value;
 IF d.status IS DISTINCT FROM 'SETTLED' OR d.settled_by IS DISTINCT FROM 'FINANCE' OR d.settled_ref_type IS DISTINCT FROM f.ref_type OR d.settled_ref_id IS DISTINCT FROM f.ref_id
  OR d.settled_ref_digest IS DISTINCT FROM f.facts_digest OR d.revision IS DISTINCT FROM f.duty_revision+1
 THEN RAISE EXCEPTION 'final duty reference not closed with its facts' USING ERRCODE='23514'; END IF;RETURN NULL;
END $$;


--
-- Name: check_legacy_duty_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_legacy_duty_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF(NEW.amount_cents,NEW.maturity_at) IS DISTINCT FROM(OLD.amount_cents,OLD.maturity_at) AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.legacy_order_duty_revision r JOIN zzsh_order.legacy_continuation_version v ON v.id=r.source_command_version_id
  WHERE r.duty_id=NEW.id AND r.revision=NEW.revision AND v.order_id=NEW.order_id AND v.command='CONFIRM'
   AND r.created_xid=pg_current_xact_id() AND v.created_xid=r.created_xid
   AND r.before_values->>'amountCents'=OLD.amount_cents::text AND r.after_values->>'amountCents'=NEW.amount_cents::text
   AND r.before_values?'maturityAt' AND r.after_values?'maturityAt'
   AND r.before_values->>'maturityAt' IS NOT DISTINCT FROM to_char(OLD.maturity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
   AND r.after_values->>'maturityAt' IS NOT DISTINCT FROM to_char(NEW.maturity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 THEN RAISE EXCEPTION 'Commission revision requires same-transaction confirm log' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_legacy_order_read_audit(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_legacy_order_read_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event e
    WHERE e.action='order.legacy.read_imported' AND e.object_id=NEW.id AND e.actor_id=NEW.created_by_admin_id
      AND e.outcome='SUCCESS' AND e.details->>'sourceSystem'=NEW.source_system
      AND e.details->>'sourceEntity'=NEW.source_entity AND e.details->>'legacyId'=NEW.legacy_id
      AND e.details->>'sourceDigest'=NEW.source_digest AND e.details->>'bindingDigest'=NEW.binding_digest)
  THEN RAISE EXCEPTION 'Legacy order import audit is missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;


--
-- Name: check_native_origin_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_native_origin_closure() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE b zzsh_order.finance_opening_basis;r zzsh_order.finance_economic_root;e zzsh_order.finance_event;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.id;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE basis_id=b.id;
 SELECT * INTO e FROM zzsh_order.finance_event WHERE economic_root_id=r.id AND kind='OPENING';
 IF r.id IS NULL OR e.id IS NULL OR r.source_kind<>'NATIVE_GENESIS' OR r.subject_user_id<>b.user_id
  OR e.subject_user_id<>b.user_id OR e.expected_ledger_revision<>0 OR e.created_xid<>b.created_xid
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage c WHERE c.user_id=b.user_id AND c.basis_id=b.id
    AND c.opening_event_id=e.id AND c.origin='NATIVE_GENESIS')
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=b.user_id AND ledger_revision>=1)
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=e.id)
 THEN RAISE EXCEPTION 'native zero origin requires complete zero-entry opening/coverage' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_native_origin_excludes_legacy(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_native_origin_excludes_legacy() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE subject_value text;
BEGIN
 IF TG_TABLE_SCHEMA='zzsh_order' AND TG_TABLE_NAME='finance_opening_basis' THEN
  subject_value:=NEW.user_id;
 ELSIF TG_TABLE_SCHEMA='zzsh_iam' AND TG_TABLE_NAME='audit_event' THEN
  subject_value:=NEW.object_id;
 ELSE RAISE EXCEPTION 'unexpected native origin trigger relation' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_value FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.finance_opening_basis WHERE user_id=subject_value AND source_kind='NATIVE_GENESIS')
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=subject_value AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'legacy identity cannot receive native zero origin' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_native_refund_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_native_refund_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;i zzsh_order.channel_refund_intent;
BEGIN
 IF TG_TABLE_NAME='channel_refund_intent' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='joinpay_refund_evidence' THEN target:=NEW.intent_id;
 ELSIF TG_TABLE_NAME='joinpay_refund_observation' THEN
  IF NEW.event<>'PENDING_TERMINAL' THEN RETURN NULL;END IF;target:=NEW.intent_id;
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE observation_id=NEW.id)
  THEN RAISE EXCEPTION 'pending refund observation lacks terminal evidence' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 ELSE target:=NEW.details->>'nativeRefundIntentId';END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' THEN RAISE EXCEPTION 'native refund closure original missing' USING ERRCODE='23514';END IF;
 IF i.lease_version>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt a
  WHERE a.intent_id=i.id AND a.lease_version=i.lease_version AND a.lease_owner=i.lease_owner)
 THEN RAISE EXCEPTION 'native refund claim has no committed original attempt' USING ERRCODE='23514';END IF;
 IF i.basis_kind='PRESTART_TERMINATION' THEN
  IF i.state IN('SUCCEEDED','FAILED') THEN
   IF NOT zzsh_order.native_prestart_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'prestart refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
   OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
   OR NOT zzsh_order.native_prestart_refund_liability_complete(target)
  THEN RAISE EXCEPTION 'unresolved prestart refund cannot release or post money' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF i.state IN('SUCCEEDED','FAILED') THEN
  IF i.basis_kind='REVIEW_CONFIRMATION' THEN
   IF NOT zzsh_order.native_abnormal_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'abnormal refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  ELSE
   IF NOT zzsh_order.native_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'native refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF i.basis_kind='REVIEW_CONFIRMATION' THEN
  IF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
   OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
   OR NOT zzsh_order.native_abnormal_refund_liability_complete(target)
  THEN RAISE EXCEPTION 'unresolved abnormal refund cannot release or post money' USING ERRCODE='23514';END IF;
 ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
 THEN RAISE EXCEPTION 'unresolved native refund cannot release or post money' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_opening_coverage_set(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_opening_coverage_set() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE basis_id_value text;basis zzsh_order.finance_opening_basis;actual_count bigint;actual_digest text;
BEGIN
 IF TG_TABLE_NAME='finance_opening_basis' THEN basis_id_value:=NEW.id; ELSE basis_id_value:=NEW.basis_id; END IF;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=basis_id_value;
 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(
  '['||to_json(user_id)::text||','||to_json(source_kind)::text||','||to_json(source_type)::text||','||to_json(source_entity)::text||','||
  to_json(source_id)::text||','||to_json(beneficiary_role)::text||','||to_json(extract(epoch FROM source_event_at)::bigint::text)::text||','||to_json(source_digest)::text||']',
  E'\n' ORDER BY source_kind COLLATE "C",source_type COLLATE "C",source_entity COLLATE "C",source_id COLLATE "C",beneficiary_role COLLATE "C"),''),'UTF8')),'hex')
  INTO actual_count,actual_digest FROM zzsh_order.finance_covered_event WHERE basis_id=basis_id_value;
 IF actual_count<>basis.covered_count OR actual_digest<>basis.covered_set_digest THEN RAISE EXCEPTION 'covered set count/digest mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;


--
-- Name: check_order_member_joined(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_order_member_joined() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.state='JOINED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id AND team_state='READY') THEN
    RAISE EXCEPTION 'JOINED requires a READY Team' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;


--
-- Name: check_order_operation_success(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_order_operation_success() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.state='SUCCEEDED' AND NEW.kind='CREATE' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id AND app_id=NEW.app_id
      AND team_state='READY' AND team_id=NEW.candidate_team_id
  ) THEN RAISE EXCEPTION 'CREATE success requires READY binding' USING ERRCODE='23514'; END IF;
  IF NEW.state='SUCCEEDED' AND NEW.kind='ADD_MEMBER' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_group g JOIN zzsh_order.im_order_member mm ON mm.order_id=g.order_id
    JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=g.app_id
      WHERE g.order_id=NEW.order_id AND g.app_id=NEW.app_id AND g.team_state='READY'
        AND g.team_id=NEW.candidate_team_id AND mm.party='STAFF' AND mm.state='JOINED'
        AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.platform_subject_id=NEW.target_admin_id
  ) THEN RAISE EXCEPTION 'ADD success requires joined target in READY Team' USING ERRCODE='23514'; END IF;
  IF NEW.state='SUCCEEDED' AND NEW.kind='BOT_NOTICE' AND NEW.sent_at IS NULL THEN
    RAISE EXCEPTION 'BOT success requires a sent notice' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;


--
-- Name: check_order_team_ready(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_order_team_ready() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.team_state='READY' AND (
    NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_operation WHERE order_id=NEW.order_id AND kind='CREATE'
      AND state='SUCCEEDED' AND candidate_team_id=NEW.team_id)
    OR (SELECT count(*) FROM zzsh_order.im_order_member WHERE order_id=NEW.order_id AND state='JOINED' AND party IN ('BUYER','OWNER'))<>2
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=NEW.order_id AND mm.state='JOINED' AND mm.party='STAFF' AND m.platform_subject_id=NEW.assigned_admin_id)
  ) THEN RAISE EXCEPTION 'READY requires successful CREATE and joined parties' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;


--
-- Name: check_payment_distribution_basis_pair(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_payment_distribution_basis_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE payment_id_value text;p zzsh_order.payment_confirmation;a zzsh_order.distribution_order_admission;b zzsh_order.payment_distribution_basis;
BEGIN
 IF TG_TABLE_NAME='payment_confirmation' THEN payment_id_value:=NEW.id;
 ELSE payment_id_value:=NEW.payment_confirmation_id;END IF;
 SELECT * INTO p FROM zzsh_order.payment_confirmation WHERE id=payment_id_value;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=p.order_id;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE payment_confirmation_id=p.id;
 IF b.id IS NOT NULL AND (p.disposition IS DISTINCT FROM 'APPLIED' OR a.id IS NULL
  OR b.order_id IS DISTINCT FROM p.order_id OR b.admission_id IS DISTINCT FROM a.id
  OR b.admission_revision IS DISTINCT FROM a.revision OR NOT a.active
  OR p.accepted_at<a.admitted_at OR p.accepted_at>=a.expires_at)
 THEN RAISE EXCEPTION 'basis is outside the original admitted APPLIED acceptance' USING ERRCODE='23514';END IF;
 IF p.disposition='APPLIED' AND a.active AND p.accepted_at>=a.admitted_at AND p.accepted_at<a.expires_at AND b.id IS NULL
 THEN RAISE EXCEPTION 'admitted first APPLIED acceptance requires its same-transaction original basis' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_prestart_termination_closure(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_prestart_termination_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;t zzsh_order.prestart_termination;
BEGIN
 IF TG_TABLE_NAME='prestart_termination' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='prestart_termination_decision' THEN target:=NEW.termination_id;
 ELSIF TG_TABLE_NAME='rental_order' THEN SELECT id INTO target FROM zzsh_order.prestart_termination WHERE order_id=NEW.id AND state='APPROVED';
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id AND source_kind='NATIVE_PRESTART_REFUND';
 ELSE target:=NEW.details->>'prestartTerminationId';END IF;
 IF target IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=target;
 IF t.id IS NULL OR(t.state='APPROVED' AND NOT zzsh_order.prestart_liability_complete(t.id))
   OR(t.revision>1 AND NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id
     AND d.result_revision=t.revision AND d.reason=t.last_reason AND d.decision=CASE t.state WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REJECTED' THEN 'REJECT' ELSE 'REVIEW_REQUIRED' END))
 THEN RAISE EXCEPTION 'prestart approval/liability/cancellation batch incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_settlement_posting_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_settlement_posting_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_posting_id text;
  batch record;
  ord record;
  ver record;
  payment record;
  approval record;
  sums record;
  snapshot_captured numeric;
  snapshot_system_owner numeric;
  snapshot_system_refund numeric;
  snapshot_platform numeric;
  snapshot_fee numeric;
  snapshot_haff numeric;
  snapshot_item numeric;
  snapshot_early numeric;
  expected_owner numeric;
  expected_refund numeric;
  expected_platform numeric;
  expected_adjustment numeric;
BEGIN
  IF TG_TABLE_NAME = 'settlement_posting' THEN
    v_posting_id := NEW.id;
  ELSE
    v_posting_id := NEW.posting_id;
  END IF;
  SELECT * INTO batch FROM zzsh_order.settlement_posting WHERE id = v_posting_id;
  IF batch IS NULL THEN RETURN NULL; END IF;
  SELECT status, paid_confirmation_id, renter_user_id, owner_user_id INTO ord
    FROM zzsh_order.rental_order WHERE id = batch.order_id;
  SELECT kind, early, version_hash, superseded_at, approval_request_id, input_snapshot INTO ver
    FROM zzsh_order.settlement_version WHERE id = batch.settlement_version_id AND order_id = batch.order_id;
  SELECT order_id, amount_cents, currency, disposition INTO payment
    FROM zzsh_order.payment_confirmation WHERE id = batch.payment_confirmation_id;
  IF ord IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM batch.version_hash
     OR ver.early IS DISTINCT FROM batch.early OR payment IS NULL OR payment.order_id IS DISTINCT FROM batch.order_id
     OR payment.disposition <> 'APPLIED' OR payment.currency <> 'CNY' OR payment.amount_cents <> batch.captured_cents THEN
    RAISE EXCEPTION 'posting header is not bound to a completed order and its applied payment' USING ERRCODE = '23514';
  END IF;
  IF ver.input_snapshot IS NULL OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind
     OR ver.input_snapshot->>'early' IS DISTINCT FROM batch.early::text THEN
    RAISE EXCEPTION 'posting header is not bound to its settlement snapshot' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'RENTER'
         AND action = 'CONFIRM' AND subject_id = ord.renter_user_id AND version_hash = batch.version_hash) <> 1
     OR (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'OWNER'
         AND action = 'CONFIRM' AND subject_id = ord.owner_user_id AND version_hash = batch.version_hash) <> 1
     OR EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party IN ('RENTER','OWNER') AND action = 'REJECT') THEN
    RAISE EXCEPTION 'posting requires both parties to confirm the same version' USING ERRCODE = '23514';
  END IF;
  IF batch.early AND NOT EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'SUPPORT' AND action = 'REVIEW'
         AND version_hash = batch.version_hash) THEN
    RAISE EXCEPTION 'early posting requires support review' USING ERRCODE = '23514';
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    SELECT status, requested_by, decided_by, operation_payload_hash, expires_at INTO approval
      FROM zzsh_iam.approval_request WHERE id = batch.approval_request_id;
    IF approval IS NULL OR approval.status <> 'APPROVED' OR approval.decided_by IS NULL
       OR approval.decided_by = approval.requested_by OR approval.operation_payload_hash <> batch.version_hash
       OR approval.expires_at <= batch.posted_at OR batch.approval_request_id IS DISTINCT FROM ver.approval_request_id
       OR batch.approval_requested_by IS DISTINCT FROM approval.requested_by
       OR batch.approval_approved_by IS DISTINCT FROM approval.decided_by
       OR batch.approval_expires_at IS DISTINCT FROM approval.expires_at
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash
       OR batch.manual_reason IS DISTINCT FROM ver.input_snapshot->>'reason' THEN
      RAISE EXCEPTION 'posting requires the current valid non-self manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL OR batch.manual_reason IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;

  snapshot_captured := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount');
  snapshot_system_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerNet}');
  snapshot_system_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,renterRefund}');
  snapshot_platform := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformContribution}');
  snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
  snapshot_haff := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,haffSpread}');
  snapshot_item := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,itemSpread}');
  snapshot_early := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,earlyMakeup}');
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    expected_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerNet');
    expected_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedRenterRefund');
  ELSE
    expected_owner := snapshot_system_owner;
    expected_refund := snapshot_system_refund;
  END IF;
  IF snapshot_captured IS NULL OR snapshot_system_owner IS NULL OR snapshot_system_refund IS NULL OR snapshot_platform IS NULL
     OR snapshot_fee IS NULL OR snapshot_haff IS NULL OR snapshot_item IS NULL OR snapshot_early IS NULL
     OR expected_owner IS NULL OR expected_refund IS NULL THEN
    RAISE EXCEPTION 'settlement amount snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_adjustment := snapshot_system_owner + snapshot_system_refund - expected_owner - expected_refund;
  expected_platform := snapshot_platform + expected_adjustment;
  IF batch.captured_cents <> snapshot_captured OR batch.system_owner_net_cents <> snapshot_system_owner
     OR batch.system_renter_refund_cents <> snapshot_system_refund OR batch.owner_net_cents <> expected_owner
     OR batch.renter_refund_cents <> expected_refund OR batch.platform_contribution_cents <> expected_platform
     OR batch.compensation_fee_cents <> snapshot_fee OR batch.captured_cents <> batch.owner_net_cents + batch.renter_refund_cents + batch.platform_contribution_cents THEN
    RAISE EXCEPTION 'posting header does not match the accepted settlement amounts' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer AS line_count,
         COALESCE(sum(debit_cents),0) AS debit_cents,
         COALESCE(sum(credit_cents),0) AS credit_cents,
         count(*) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE') AS source_count,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_debit,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_credit,
         count(*) FILTER (WHERE account_code = 'OWNER_AVAILABLE') AS owner_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_debits,
         count(*) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE') AS refund_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_debits,
         count(*) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD') AS haff_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD'),0) AS haff_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD') AS item_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD'),0) AS item_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP') AS early_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP'),0) AS early_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE') AS fee_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE'),0) AS fee_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT') AS adjustment_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT'),0) AS adjustment_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code LIKE 'PLATFORM_%'),0) AS platform_cents
    INTO sums FROM zzsh_order.settlement_ledger_entry AS entry WHERE entry.posting_id = v_posting_id;
  IF sums.line_count < 2 OR sums.debit_cents <> sums.credit_cents OR sums.source_count <> 1
     OR sums.source_debit <> batch.captured_cents OR sums.source_credit <> 0
     OR sums.owner_count <> (CASE WHEN expected_owner = 0 THEN 0 ELSE 1 END) OR sums.owner_cents <> expected_owner OR sums.owner_debits <> 0
     OR sums.refund_count <> (CASE WHEN expected_refund = 0 THEN 0 ELSE 1 END) OR sums.refund_cents <> expected_refund OR sums.refund_debits <> 0
     OR sums.haff_count <> (CASE WHEN snapshot_haff = 0 THEN 0 ELSE 1 END) OR sums.haff_cents <> snapshot_haff
     OR sums.item_count <> (CASE WHEN snapshot_item = 0 THEN 0 ELSE 1 END) OR sums.item_cents <> snapshot_item
     OR sums.early_count <> (CASE WHEN snapshot_early = 0 THEN 0 ELSE 1 END) OR sums.early_cents <> snapshot_early
     OR sums.fee_count <> (CASE WHEN snapshot_fee = 0 THEN 0 ELSE 1 END) OR sums.fee_cents <> snapshot_fee
     OR sums.adjustment_count <> (CASE WHEN expected_adjustment = 0 THEN 0 ELSE 1 END) OR sums.adjustment_cents <> expected_adjustment
     OR sums.platform_cents <> expected_platform THEN
    RAISE EXCEPTION 'settlement posting classifications are incomplete or inconsistent' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry e WHERE e.posting_id = v_posting_id AND (
       (e.account_code = 'CAPTURED_PAYMENT_SOURCE' AND
         (e.details->>'paymentConfirmationId' IS DISTINCT FROM batch.payment_confirmation_id
          OR e.details->>'disposition' IS DISTINCT FROM 'APPLIED'
          OR e.details->>'fundingSourceRef' IS DISTINCT FROM ver.input_snapshot->>'fundingSourceRef'))
       OR (e.account_code = 'OWNER_AVAILABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details #>> '{systemGross,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,ownerGross}'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedNet') IS DISTINCT FROM expected_owner
          OR e.details->>'feePayer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details #>> '{compensationFee,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeAmount}'))
       OR (e.account_code = 'RENTER_REFUND_PAYABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details->>'dueAt' IS NULL OR (e.details->>'dueAt')::timestamptz IS DISTINCT FROM batch.refund_due_at
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRefund') IS DISTINCT FROM snapshot_system_refund
          OR e.details #>> '{depositRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,depositRefund}'
          OR e.details #>> '{unusedItemRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedItemRefund}'
          OR e.details #>> '{unusedHaffRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedHaffRefund}'))
       OR (e.account_code = 'PLATFORM_HAFF_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_haff)
       OR (e.account_code = 'PLATFORM_ITEM_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_item)
       OR (e.account_code = 'PLATFORM_EARLY_MAKEUP' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_early
          OR e.details->>'endReason' IS DISTINCT FROM ver.input_snapshot->>'endReason'))
       OR (e.account_code = 'PLATFORM_COMPENSATION_FEE' AND
         (e.details #>> '{base,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeBase}'
          OR e.details->>'rate' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeRate}'
          OR e.details->>'payer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details->>'policyVersion' IS DISTINCT FROM ver.input_snapshot->>'feePolicyVersion'))
       OR (e.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' AND
         (e.details->>'reason' IS DISTINCT FROM ver.input_snapshot->>'reason'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemOwnerNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedOwnerNet') IS DISTINCT FROM expected_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRenterRefund') IS DISTINCT FROM snapshot_system_refund
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedRenterRefund') IS DISTINCT FROM expected_refund))
     )) THEN
    RAISE EXCEPTION 'settlement posting details do not match the accepted settlement snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;


--
-- Name: check_stored_opening_observations(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_stored_opening_observations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.finance_stored_opening_review;b zzsh_order.finance_opening_basis;item jsonb;observed zzsh_order.personal_finance_observation;a zzsh_order.finance_observation_admission;actual_count bigint;matching_input bigint;input_document jsonb;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=NEW.basis_id;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT count(*) INTO actual_count FROM zzsh_order.finance_observation_admission WHERE basis_id=NEW.basis_id;
 IF actual_count IS DISTINCT FROM (r.review_canonical::jsonb->>'observationCount')::int THEN RAISE EXCEPTION 'stored observation admission count mismatch' USING ERRCODE='23514'; END IF;
 input_document:=r.input_canonical::jsonb;
 FOR item IN SELECT value FROM jsonb_array_elements(input_document->'admissions') LOOP
  SELECT * INTO a FROM zzsh_order.finance_observation_admission WHERE basis_id=r.basis_id AND source_entity=item->>'sourceEntity' AND source_id=item->>'sourceId';
  SELECT * INTO observed FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=b.source_system AND source_entity=a.source_entity AND source_id=a.source_id;
  SELECT count(*) INTO matching_input FROM jsonb_array_elements(input_document->'observations') v WHERE v=observed.snapshot;
  IF a.basis_id IS NULL OR observed.id IS NULL OR a.user_id IS DISTINCT FROM b.user_id OR a.source_digest IS DISTINCT FROM item->>'sourceDigest'
   OR a.source_event_at IS DISTINCT FROM (item->>'sourceEventAt')::timestamptz OR a.included_in_opening IS DISTINCT FROM (item->>'included')::boolean
   OR observed.user_id IS DISTINCT FROM b.user_id OR observed.legacy_user_id IS DISTINCT FROM b.source_id
   OR observed.source_digest IS DISTINCT FROM a.source_digest OR observed.source_event_at IS DISTINCT FROM a.source_event_at
   OR observed.basis_id IS NOT NULL AND observed.basis_id IS DISTINCT FROM b.id
   OR observed.basis_id IS NOT NULL AND observed.included_in_opening IS DISTINCT FROM a.included_in_opening
   OR observed.basis_id IS NULL AND observed.included_in_opening OR matching_input<>1
  THEN RAISE EXCEPTION 'stored observation fact/admission mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;


--
-- Name: check_withdrawal_batch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_withdrawal_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target text;intent zzsh_order.withdrawal_intent;lines integer;dr numeric;cr numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN target:=NEW.id;ELSE target:=NEW.finance_event_id;END IF;
 SELECT i.* INTO intent FROM zzsh_order.withdrawal_intent i JOIN zzsh_order.finance_event e ON e.economic_root_id=i.economic_root_id WHERE e.id=target;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=target;
 IF intent.id IS NULL OR lines<>(SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(target)) OR dr<>intent.gross_cents OR cr<>intent.gross_cents THEN RAISE EXCEPTION 'controlled batch incomplete/unbalanced' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: check_withdrawal_intent_consistency(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.check_withdrawal_intent_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE intent zzsh_order.withdrawal_intent;root zzsh_order.finance_economic_root;event_row zzsh_order.finance_event;reserve_count integer;payout_count integer;release_count integer;line_count integer;debits numeric;credits numeric;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=intent.economic_root_id;
 IF intent.id IS NULL OR root.id IS NULL OR root.source_kind IS DISTINCT FROM 'LOCAL_CONTROLLED_WITHDRAWAL' OR root.source_type IS DISTINCT FROM 'NATIVE'
  OR root.source_system IS DISTINCT FROM 'zzsh-local-controlled' OR root.source_entity IS DISTINCT FROM 'withdrawal_intent' OR root.source_id IS DISTINCT FROM intent.id
  OR root.subject_user_id IS DISTINCT FROM intent.user_id OR root.policy_version IS DISTINCT FROM intent.policy_version OR root.source_digest IS DISTINCT FROM intent.input_digest
  THEN RAISE EXCEPTION 'withdrawal intent has no exact economic root' USING ERRCODE='23514';END IF;
 SELECT count(*) FILTER(WHERE kind='RESERVE'),count(*) FILTER(WHERE kind='PAYOUT'),count(*) FILTER(WHERE kind='RELEASE') INTO reserve_count,payout_count,release_count
  FROM zzsh_order.finance_event WHERE economic_root_id=intent.economic_root_id;
 IF reserve_count<>1 OR payout_count<>(CASE WHEN intent.funds_disposition='PAYOUT_POSTED' THEN 1 ELSE 0 END)
  OR release_count<>(CASE WHEN intent.funds_disposition='RELEASE_POSTED' THEN 1 ELSE 0 END)
  THEN RAISE EXCEPTION 'withdrawal intent disposition lacks exact reserve/terminal event' USING ERRCODE='23514';END IF;
 FOR event_row IN SELECT * FROM zzsh_order.finance_event WHERE economic_root_id=intent.economic_root_id LOOP
  IF event_row.subject_user_id IS DISTINCT FROM intent.user_id OR event_row.kind NOT IN('RESERVE','PAYOUT','RELEASE') THEN RAISE EXCEPTION 'withdrawal event subject/action mismatch' USING ERRCODE='23514';END IF;
  SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO line_count,debits,credits FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=event_row.id;
  IF line_count<>(SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(event_row.id)) OR debits<>intent.gross_cents OR credits<>intent.gross_cents
   OR EXISTS((SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=event_row.id)
    EXCEPT(SELECT * FROM zzsh_order.withdrawal_expected_lines(event_row.id)))
   OR EXISTS((SELECT * FROM zzsh_order.withdrawal_expected_lines(event_row.id))
    EXCEPT(SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=event_row.id))
   THEN RAISE EXCEPTION 'withdrawal intent has incomplete/mismatched exact ledger' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END $$;


--
-- Name: controlled_notice_arrival_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.controlled_notice_arrival_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=NEW.user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'notice wallet coverage missing' USING ERRCODE='23514';END IF;RETURN NULL;END $$;


--
-- Name: controlled_notice_conclusion_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.controlled_notice_conclusion_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=(SELECT user_id FROM zzsh_order.controlled_payout_notice WHERE id=NEW.object_id);RETURN NULL;END $$;


--
-- Name: derive_payment_referral_inputs(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.derive_payment_referral_inputs(order_id_value text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $_$
DECLARE o zzsh_order.rental_order;v zzsh_order.distribution_policy_version;cfg jsonb;mode text;base numeric;minimum numeric;
 role_name text;party text;own zzsh_order.distribution_participant;relation zzsh_order.invitation_relation;
 parent_row record;graph_closed boolean;level jsonb;status text;pct text;n numeric;d numeric;scale integer;
 item jsonb;items jsonb[]:=ARRAY[]::jsonb[];raw_amounts numeric[]:=ARRAY[0::numeric,0::numeric];i integer;
 uncertain boolean;total numeric;uniform boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_id_value;
 IF o.id IS NULL OR o.currency<>'CNY' THEN RAISE EXCEPTION 'original native CNY order required' USING ERRCODE='23514';END IF;
 SELECT p.* INTO v FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version p
  ON p.id=h.current_version_id AND p.scope=h.scope AND p.revision=h.revision
  WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.source='JOINPAY') THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;
 cfg:=v.canonical_config::jsonb;uniform:=cfg->>'schema'='distribution-policy.v2';
 IF o.quote_snapshot->'schemaVersion'='2'::jsonb THEN mode:=o.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}';END IF;
 IF mode IS NULL OR mode NOT IN('ordinary','custom','fast') THEN mode:=NULL;END IF;
 IF o.quote_snapshot#>>'{platformFullProfit,currency}'='CNY'
  AND o.quote_snapshot#>>'{platformFullProfit,unit}'='yuan'
  AND o.quote_snapshot#>'{platformFullProfit,scale}'='2'::jsonb
  AND jsonb_typeof(o.quote_snapshot#>'{platformFullProfit,amount}')='string'
  AND COALESCE(o.quote_snapshot#>>'{platformFullProfit,amount}','')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$'
 THEN base:=(o.quote_snapshot#>>'{platformFullProfit,amount}')::numeric*100;END IF;
 FOREACH role_name IN ARRAY ARRAY['OWNER_REFERRAL','RENTER_REFERRAL'] LOOP
  party:=CASE WHEN role_name='OWNER_REFERRAL' THEN o.owner_user_id ELSE o.renter_user_id END;
  SELECT * INTO own FROM zzsh_order.distribution_participant WHERE user_id=party;
  SELECT * INTO relation FROM zzsh_order.invitation_relation WHERE child_user_id=party AND type='DISTRIBUTION_LEADER';
  SELECT p.*,CASE WHEN s.account_status IS NULL THEN NULL ELSE NOT u.suspended AND s.account_status='ACTIVE' END AS owner_active
   INTO parent_row FROM zzsh_order.distribution_participant p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
   LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id WHERE p.user_id=relation.parent_user_id;
  graph_closed:=false;
  IF relation.parent_user_id IS NOT NULL THEN
   WITH RECURSIVE chain(user_id,path,cyclic) AS (
    SELECT relation.parent_user_id,ARRAY[relation.parent_user_id],false UNION ALL
    SELECT r.parent_user_id,c.path||r.parent_user_id,r.parent_user_id=ANY(c.path)
     FROM chain c JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER' WHERE NOT c.cyclic
   ) SELECT COALESCE(bool_and(NOT c.cyclic AND COALESCE(
      p.leader_knowledge='KNOWN_NONE' AND r.parent_user_id IS NULL
      OR p.leader_knowledge='KNOWN_PARENT' AND r.parent_user_id IS NOT NULL,false)),false)
    INTO graph_closed FROM chain c LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=c.user_id
    LEFT JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER';
  END IF;
  pct:=NULL;n:=NULL;d:=NULL;level:=NULL;
  IF v.id IS NULL THEN status:='UNKNOWN_POLICY';
  ELSIF cfg->'enabled'<>'true'::jsonb THEN status:='SKIPPED_DISABLED';
  ELSIF mode IS NULL THEN status:='UNKNOWN_MODE';
  ELSIF mode='fast' THEN status:='SKIPPED_FAST';
  ELSIF NOT(cfg->'accountModes' ? mode) THEN status:='SKIPPED_MODE';
  ELSIF own.leader_knowledge='KNOWN_NONE' AND relation.id IS NULL THEN status:='SKIPPED_NO_PARENT';
  ELSIF own.leader_knowledge IS DISTINCT FROM 'KNOWN_PARENT' OR relation.id IS NULL OR NOT graph_closed
    OR relation.parent_user_id=party OR relation.source_digest IS NULL THEN status:='UNKNOWN_RELATION';
  ELSIF parent_row.user_id IS NULL OR parent_row.owner_active IS NULL OR parent_row.eligibility='UNKNOWN'
    OR parent_row.commission_frozen IS NULL THEN status:='UNKNOWN_PARTICIPANT';
  ELSIF NOT parent_row.owner_active OR parent_row.eligibility='INELIGIBLE' OR parent_row.commission_frozen THEN status:='SKIPPED_INELIGIBLE';
  ELSIF uniform THEN
   pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN cfg->>'ownerPercent' ELSE cfg->>'renterPercent' END;
   scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
   n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
   status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
  ELSE
   SELECT value INTO level FROM jsonb_array_elements(cfg->'levels') WHERE value->>'code'=parent_row.level_code;
   IF level IS NULL THEN status:='UNKNOWN_LEVEL';
   ELSE
    pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN level->>'ownerPercent' ELSE level->>'renterPercent' END;
    scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
    n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
    status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
   END IF;
  END IF;
  item:=jsonb_build_object('role',role_name,'partyUserId',party,'status',status,
   'beneficiaryUserId',parent_row.user_id,'relationId',relation.id,'relationDigest',relation.source_digest,
   'levelCode',CASE WHEN uniform THEN NULL ELSE parent_row.level_code END,'percent',pct,
   'ratio',CASE WHEN pct IS NULL THEN NULL ELSE jsonb_build_object('numerator',n::numeric(24,0)::text,'denominator',d::numeric(24,0)::text) END,'estimatedCents',NULL);
  items:=array_append(items,item);
 END LOOP;
 IF v.id IS NOT NULL AND base IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM unnest(items) r WHERE r->>'status' LIKE 'UNKNOWN%') INTO uncertain;
  IF NOT uncertain THEN
   FOR i IN 1..2 LOOP
    IF items[i]->>'status'='ELIGIBLE' THEN raw_amounts[i]:=floor(base*(items[i]#>>'{ratio,numerator}')::numeric/(items[i]#>>'{ratio,denominator}')::numeric+0.5);END IF;
   END LOOP;
  END IF;
  total:=raw_amounts[1]+raw_amounts[2];minimum:=(cfg->>'minimumAccrualCents')::numeric;
  FOR i IN 1..2 LOOP
   IF items[i]->>'status'='ELIGIBLE' THEN
    IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);
    ELSE items[i]:=jsonb_set(items[i],'{estimatedCents}',to_jsonb(raw_amounts[i]::numeric(24,0)::text));END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('policyVersion',v.id,'policyDigest',v.config_digest,'policyConfig',cfg,'accountMode',mode,
  'estimateBaseCents',CASE WHEN base IS NULL THEN NULL ELSE base::numeric(24,0)::text END,'roles',to_jsonb(items));
END $_$;


--
-- Name: distribution_policy_contract_version(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.distribution_policy_contract_version() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT 2 $$;


--
-- Name: earning_expected_lines(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.earning_expected_lines(event_id_value text) RETURNS TABLE(line_no integer, account_code text, debit_cents numeric, credit_cents numeric, counterparty_user_id text, source_payment_confirmation_id text)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;from_settled boolean;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=event_id_value;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 IF r.id IS NULL OR r.amount_cents=0 THEN RETURN;END IF;
 IF e.kind='EARNING_PENDING' THEN
  RETURN QUERY VALUES(1,'DISTRIBUTION_EXPENSE',r.amount_cents,0::numeric,NULL::text,NULL::text),(2,'WALLET_PENDING_EARNINGS',0::numeric,r.amount_cents,r.beneficiary_user_id,NULL::text);
 ELSIF e.kind='EARNING_SETTLED' THEN
  RETURN QUERY VALUES(1,'WALLET_PENDING_EARNINGS',r.amount_cents,0::numeric,r.beneficiary_user_id,NULL::text),(2,'WALLET_AVAILABLE',0::numeric,r.amount_cents,r.beneficiary_user_id,NULL::text);
 ELSIF e.kind='EARNING_REVOKED' THEN
  SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_event WHERE economic_root_id=r.economic_root_id AND kind='EARNING_SETTLED') INTO from_settled;
  RETURN QUERY VALUES(1,CASE WHEN from_settled THEN 'WALLET_AVAILABLE' ELSE 'WALLET_PENDING_EARNINGS' END,r.amount_cents,0::numeric,r.beneficiary_user_id,NULL::text),(2,'DISTRIBUTION_EXPENSE',0::numeric,r.amount_cents,NULL::text,NULL::text);
 END IF;
END $$;


--
-- Name: fill_order_responsible(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.fill_order_responsible() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.provision_state='ASSIGNED' AND NEW.responsible_admin_id IS NULL THEN
    NEW.responsible_admin_id := NEW.assigned_admin_id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: finance_event_wallet_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.finance_event_wallet_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id)
  VALUES(NEW.subject_user_id,CASE basis.source_kind WHEN 'NATIVE_GENESIS' THEN 'NATIVE_GENESIS' ELSE 'RECONCILED_OPENING' END,basis.id,NEW.id);
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(NEW.subject_user_id,1,1)
  ON CONFLICT(user_id) DO UPDATE SET ledger_revision=zzsh_order.wallet_revision.ledger_revision+1,read_revision=zzsh_order.wallet_revision.read_revision+1;
 RETURN NULL;
END $$;


--
-- Name: finance_history_coverage_read_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.finance_history_coverage_read_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(NEW.user_id,0,1)
 ON CONFLICT(user_id) DO UPDATE SET read_revision=zzsh_order.wallet_revision.read_revision+1;
 RETURN NULL;
END $$;


--
-- Name: finance_immutable(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.finance_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'financial evidence immutable' USING ERRCODE='40001'; END $$;


--
-- Name: guard_abnormal_refund_liability_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE ev zzsh_order.finance_event;r zzsh_order.finance_economic_root;c zzsh_order.payment_confirmation;
BEGIN
  SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;
  SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=(NEW.details->>'abnormalRefundLiabilityId');
  IF ev.id IS NULL OR ev.kind<>'REFUND_LIABILITY_RECOGNIZED' OR ev.created_xid<>pg_current_xact_id()
   OR r.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_entity<>'joinpay_abnormal_refund_liability'
   OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.basis_id IS NOT NULL
   OR r.subject_user_id IS DISTINCT FROM ev.subject_user_id OR c.id IS NULL OR c.id IS DISTINCT FROM r.source_id
   OR NEW.posting_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL
   OR NEW.details IS DISTINCT FROM jsonb_build_object('abnormalRefundLiabilityId',c.id,'paymentConfirmationId',c.id,
     'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',c.amount_cents::text)
   OR NOT((NEW.line_no=1 AND NEW.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND NEW.debit_cents=c.amount_cents
       AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
     OR(NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=c.amount_cents
       AND NEW.counterparty_user_id=r.subject_user_id))
  THEN RAISE EXCEPTION 'abnormal refund liability entry differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_abnormal_refund_liability_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.finance_economic_root;rev bigint;
BEGIN
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
  IF r.source_kind='NATIVE_PRESTART_REFUND' THEN RETURN NEW;END IF;
  SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
  IF r.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_entity<>'joinpay_abnormal_refund_liability'
   OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.basis_id IS NOT NULL OR r.created_xid<>pg_current_xact_id()
   OR NEW.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.subject_user_id IS DISTINCT FROM r.subject_user_id
   OR NEW.id IS DISTINCT FROM r.id||'_recognized' OR rev IS NULL OR NEW.expected_ledger_revision IS DISTINCT FROM rev
  THEN RAISE EXCEPTION 'abnormal refund liability event root/revision differs' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id();
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;


--
-- Name: guard_abnormal_refund_liability_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE basis_row record;
BEGIN
  SELECT c0.order_id,c0.source,c0.disposition,c0.reason_code,c0.currency,c0.amount_cents,c0.merchant_scope_id,
         c0.provider_transaction_id,c0.merchant_order_no,c0.joinpay_request_id,c0.joinpay_evidence_id,c0.joinpay_anchor_id,o.renter_user_id,
         rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
         rq.channel_order_no AS request_order_no,rq.amount_cents AS request_amount_cents,rq.currency AS request_currency,
         bnd.wire_merchant_no AS binding_wire_merchant_no,bnd.formal_admission_ref AS formal_admission_ref,
         ev.event AS evidence_event,ev.channel_trx_no AS evidence_trx,ev.schema_outcome AS evidence_schema,
         ev.signature_outcome AS evidence_signature,ev.binding_outcome AS evidence_binding,ev.raw_sha256 AS evidence_raw_sha256,
         an.channel AS anchor_channel,an.evidence_level AS anchor_evidence_level,an.native_order_id AS anchor_order,
         an.request_id AS anchor_request,an.merchant_identity_id AS anchor_merchant,an.channel_trx_no AS anchor_trx
    INTO basis_row
    FROM zzsh_order.payment_confirmation c0
    JOIN zzsh_order.rental_order o ON o.id=c0.order_id
    LEFT JOIN zzsh_order.payment_request rq ON rq.id=c0.joinpay_request_id AND rq.order_id=c0.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=rq.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence ev ON ev.id=c0.joinpay_evidence_id AND ev.request_id=c0.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction an ON an.id=c0.joinpay_anchor_id
   WHERE c0.id=NEW.source_id;
  IF NOT FOUND OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh'
   OR NEW.source_entity<>'joinpay_abnormal_refund_liability' OR NEW.basis_id IS NOT NULL
   OR NEW.beneficiary_role<>'RENTER' OR NEW.policy_version IS NOT NULL
   OR NEW.id IS DISTINCT FROM 'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(NEW.source_id,'UTF8')),'hex'),1,40)
   OR basis_row.source IS DISTINCT FROM 'JOINPAY' OR basis_row.disposition IS DISTINCT FROM 'REVIEW_REQUIRED'
   OR basis_row.reason_code IS NULL OR basis_row.reason_code NOT IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
   OR basis_row.currency IS DISTINCT FROM 'CNY'
   OR NEW.subject_user_id IS DISTINCT FROM basis_row.renter_user_id
   OR NEW.source_digest IS DISTINCT FROM basis_row.evidence_raw_sha256
   OR basis_row.request_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.request_evidence_level IS DISTINCT FROM 'JOINPAY_CANDIDATE'
   OR basis_row.request_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.request_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.request_amount_cents IS DISTINCT FROM basis_row.amount_cents OR basis_row.request_currency IS DISTINCT FROM 'CNY'
   OR basis_row.formal_admission_ref IS NULL OR basis_row.binding_wire_merchant_no IS NULL
   OR basis_row.evidence_event IS DISTINCT FROM 'E4' OR basis_row.evidence_schema IS DISTINCT FROM 'VALID'
   OR basis_row.evidence_signature IS DISTINCT FROM 'MATCH' OR basis_row.evidence_binding IS DISTINCT FROM 'MATCH'
   OR basis_row.evidence_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR basis_row.anchor_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.anchor_evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
   OR basis_row.anchor_order IS DISTINCT FROM basis_row.order_id OR basis_row.anchor_request IS DISTINCT FROM basis_row.joinpay_request_id
   OR basis_row.anchor_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.anchor_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
      AND p.merchant_scope_id=basis_row.merchant_scope_id AND p.provider_transaction_id=basis_row.provider_transaction_id AND p.disposition='APPLIED')
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=NEW.source_id)
   OR (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
       WHERE p.source='JOINPAY' AND p.merchant_scope_id=basis_row.merchant_scope_id
         AND p.merchant_order_no=basis_row.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
  THEN RAISE EXCEPTION 'abnormal refund liability root basis differs' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id();
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;


--
-- Name: guard_channel_payment_append_only(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_channel_payment_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'channel payment observation/anchor is append-only' USING ERRCODE = '40001';
END $$;


--
-- Name: guard_channel_refund_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_channel_refund_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'refund observations are append only' USING ERRCODE = '40001';
END $$;


--
-- Name: guard_controlled_channel_refund_intent_v1(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_controlled_channel_refund_intent_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  basis record;
  paid_allocated numeric;
  responsibility_allocated numeric;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'refund intent requires READ COMMITTED' USING ERRCODE = '25001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund allocations cannot be deleted or released' USING ERRCODE = '40001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at'])
       OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'refund original binding and amount are immutable' USING ERRCODE = '40001';
    END IF;
    IF NEW.lease_version = OLD.lease_version + 1 THEN
      IF (OLD.lease_until IS NOT NULL AND OLD.lease_until > clock_timestamp()) OR OLD.due_at > clock_timestamp()
         OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until <= clock_timestamp()
         OR NEW.lease_until > clock_timestamp() + interval '3600 seconds'
         OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state = 'READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END) THEN
        RAISE EXCEPTION 'refund lease is not claimable' USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.lease_version = OLD.lease_version THEN
      IF OLD.state NOT IN ('SUBMITTING','UNKNOWN') OR NEW.state <> 'UNKNOWN'
         OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
         OR OLD.lease_until IS NULL OR OLD.lease_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'refund result requires the live lease' USING ERRCODE = '40001';
      END IF;
    ELSE
      RAISE EXCEPTION 'refund lease must advance exactly once' USING ERRCODE = '40001';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  SELECT p.order_id, p.payment_confirmation_id, p.version_hash, p.refund_due_at, p.renter_refund_cents,
         o.renter_user_id, c.source, c.merchant_scope_id, c.provider_transaction_id, c.merchant_order_no, c.amount_cents
    INTO basis FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
    JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
    WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED'
      AND c.source='CONTROLLED' AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents;
  IF NOT FOUND OR NEW.order_id IS DISTINCT FROM basis.order_id
     OR NEW.payment_confirmation_id IS DISTINCT FROM basis.payment_confirmation_id
     OR NEW.renter_user_id IS DISTINCT FROM basis.renter_user_id
     OR NEW.responsibility_version_hash IS DISTINCT FROM basis.version_hash
     OR NEW.payment_source IS DISTINCT FROM basis.source OR NEW.merchant_identity_id IS DISTINCT FROM basis.merchant_scope_id
     OR NEW.original_payment_trx_no IS DISTINCT FROM basis.provider_transaction_id
     OR NEW.original_payment_order_no IS DISTINCT FROM basis.merchant_order_no OR NEW.currency <> 'CNY'
     OR NEW.due_at IS DISTINCT FROM basis.refund_due_at THEN
    RAISE EXCEPTION 'refund must bind the immutable native responsibility and payment' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-funds:v1',NEW.payment_source,NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  -- VOLATILE + READ COMMITTED：锁等待结束后下一条查询取新快照；真实并发仍须PG用例验证。
  SELECT COALESCE(sum(amount_cents),0), COALESCE(sum(amount_cents) FILTER (WHERE posting_id=NEW.posting_id),0)
    INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent
    WHERE payment_source=NEW.payment_source AND merchant_identity_id=NEW.merchant_identity_id
      AND original_payment_trx_no=NEW.original_payment_trx_no;
  IF paid_allocated + NEW.amount_cents > basis.amount_cents
     OR responsibility_allocated + NEW.amount_cents > basis.renter_refund_cents THEN
    RAISE EXCEPTION 'refund allocation exceeds paid or responsibility budget' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> 'READY' OR NEW.revision <> 1 OR NEW.lease_version <> 0
     OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL THEN
    RAISE EXCEPTION 'refund intent must start unclaimed' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END $$;


--
-- Name: guard_controlled_notice(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_controlled_notice() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE op zzsh_order.controlled_payout_operation;i zzsh_order.withdrawal_intent;doc jsonb;outcome text;keys integer;
BEGIN
 IF current_database()<>'zzsh_test_m2_auth_auth_compat' OR current_user<>'zzsh_m2_auth_compat_m'
  OR (SELECT oid FROM pg_database WHERE datname=current_database())<>820148
  OR (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM 'zzsh:m2-auth-test:v1'
  THEN RAISE EXCEPTION 'unadmitted declared notice maintenance resource' USING ERRCODE='23514';END IF;
 SELECT * INTO op FROM zzsh_order.controlled_payout_operation WHERE id=NEW.original_operation_id;
 SELECT * INTO i FROM zzsh_order.withdrawal_intent WHERE id=NEW.intent_id;
 IF op.id IS NULL OR op.intent_id IS DISTINCT FROM NEW.intent_id OR op.payout_key IS DISTINCT FROM NEW.payout_key
  OR i.user_id IS DISTINCT FROM NEW.user_id OR i.terminal IS NULL OR i.funds_disposition NOT IN('PAYOUT_POSTED','RELEASE_POSTED')
  THEN RAISE EXCEPTION 'notice has no exact original terminal operation' USING ERRCODE='23514';END IF;
 doc:=NEW.evidence_canonical::jsonb;outcome:=doc->>'outcome';SELECT count(*) INTO keys FROM jsonb_object_keys(doc);
 IF doc->>'mode' IS DISTINCT FROM 'LOCAL_CONTROLLED' OR doc->>'intentId' IS DISTINCT FROM NEW.intent_id OR doc->>'payoutKey' IS DISTINCT FROM NEW.payout_key
  OR outcome IS NULL OR outcome NOT IN('ACKNOWLEDGED','TIMEOUT','SUCCEEDED','FAILED')
  THEN RAISE EXCEPTION 'notice payload does not bind original key' USING ERRCODE='23514';END IF;
 IF outcome IN('ACKNOWLEDGED','TIMEOUT') AND keys<>4 THEN RAISE EXCEPTION 'nonterminal notice shape invalid' USING ERRCODE='23514';END IF;
 IF outcome IN('SUCCEEDED','FAILED') AND(jsonb_typeof(doc->'reference') IS DISTINCT FROM 'string' OR length(btrim(doc->>'reference')) NOT BETWEEN 1 AND 128)
  THEN RAISE EXCEPTION 'notice terminal reference invalid' USING ERRCODE='23514';END IF;
 IF outcome='SUCCEEDED' AND(keys<>7 OR jsonb_typeof(doc->'netCents') IS DISTINCT FROM 'string' OR jsonb_typeof(doc->'feeCents') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'netCents','')!~'^(0|[1-9][0-9]{0,23})$' OR COALESCE(doc->>'feeCents','')!~'^(0|[1-9][0-9]{0,23})$')
  THEN RAISE EXCEPTION 'notice success amount format invalid' USING ERRCODE='23514';END IF;
 IF outcome='FAILED' AND(keys<>8 OR jsonb_typeof(doc->'unpaidConfirmed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(doc->'transferredCents') IS DISTINCT FROM 'string' OR jsonb_typeof(doc->'chargedFeeCents') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'transferredCents','')!~'^(0|[1-9][0-9]{0,23})$' OR COALESCE(doc->>'chargedFeeCents','')!~'^(0|[1-9][0-9]{0,23})$')
  THEN RAISE EXCEPTION 'notice failed amount format invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_controlled_notice_conclusion(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_controlled_notice_conclusion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE n zzsh_order.controlled_payout_notice;i zzsh_order.withdrawal_intent;f zzsh_order.withdrawal_provider_fact;expected text;notice_result_key text;
BEGIN
 SELECT * INTO n FROM zzsh_order.controlled_payout_notice WHERE id=NEW.object_id;
 SELECT * INTO i FROM zzsh_order.withdrawal_intent WHERE id=n.intent_id;
 IF n.id IS NULL OR NEW.actor_type<>'system' OR NEW.actor_id<>'local-controlled-notice-receiver' OR NEW.object_type<>'controlled_payout_notice'
  OR NEW.details->>'sourceDigest' IS DISTINCT FROM n.source_digest OR NEW.details->>'intentId' IS DISTINCT FROM n.intent_id
  OR NEW.details->>'operationVersion' IS DISTINCT FROM i.operation_version::text OR NEW.details->>'state' IS DISTINCT FROM i.state
  OR COALESCE(NEW.details->>'conclusion','') NOT IN('SAME_TERMINAL','IGNORED_NONTERMINAL','CONFLICT_TERMINAL','ALREADY_FROZEN')
  THEN RAISE EXCEPTION 'notice conclusion does not bind source and current intent' USING ERRCODE='23514';END IF;
 IF NEW.details->>'originalOperationId' IS DISTINCT FROM n.original_operation_id THEN RAISE EXCEPTION 'notice conclusion original operation differs' USING ERRCODE='23514';END IF;
 notice_result_key:='controlled-notice-'||substr(encode(sha256(convert_to(n.id,'UTF8')),'hex'),1,48);
 SELECT * INTO f FROM zzsh_order.withdrawal_provider_fact WHERE intent_id=n.intent_id AND result_key=notice_result_key;
 IF NEW.details->>'conclusion'='ALREADY_FROZEN' THEN
  IF i.state<>'RECONCILIATION_REQUIRED' OR f.id IS NOT NULL OR NEW.details->>'providerFactId' IS NOT NULL OR NEW.details->>'resultKey' IS NOT NULL
  THEN RAISE EXCEPTION 'already frozen notice cannot fabricate a processed result' USING ERRCODE='23514';END IF;
 ELSE
  expected:=CASE WHEN n.evidence_canonical::jsonb->>'outcome' IN('ACKNOWLEDGED','TIMEOUT') THEN 'IGNORED_NONTERMINAL'
   WHEN n.source_digest=i.terminal->>'evidenceDigest' THEN 'SAME_TERMINAL' ELSE 'CONFLICT_TERMINAL' END;
  IF f.id IS NULL OR f.evidence_digest IS DISTINCT FROM n.source_digest OR NEW.details->>'providerFactId' IS DISTINCT FROM f.id
   OR NEW.details->>'resultKey' IS DISTINCT FROM f.result_key OR NEW.details->>'conclusion' IS DISTINCT FROM expected
   OR expected='CONFLICT_TERMINAL' AND i.state<>'RECONCILIATION_REQUIRED'
  THEN RAISE EXCEPTION 'notice conclusion has no exact original result proof' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;


--
-- Name: guard_controlled_operation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_controlled_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE intent zzsh_order.withdrawal_intent;dest zzsh_order.withdrawal_destination;adm zzsh_order.withdrawal_admission;doc jsonb;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.intent_id;
 SELECT * INTO dest FROM zzsh_order.withdrawal_destination WHERE id=intent.destination_id;
 SELECT * INTO adm FROM zzsh_order.withdrawal_admission WHERE id=intent.admission_id;
 doc:=NEW.final_evidence_canonical::jsonb;
 IF intent.id IS NULL OR intent.state<>'SUBMITTING' OR NEW.payout_key<>intent.payout_key OR NEW.original_lease_hash IS DISTINCT FROM intent.lease_token_hash OR intent.lease_until<=clock_timestamp()
  OR NEW.original_lease_hash IS DISTINCT FROM current_setting('zzsh.withdrawal_lease_hash',true) OR NEW.scenario<>dest.scenario OR NOT adm.active OR clock_timestamp()>=adm.expires_at
  OR EXISTS(SELECT 1 FROM zzsh_auth_user."user" WHERE id=intent.user_id AND suspended) OR COALESCE((SELECT account_status FROM zzsh_iam.user_identity_state WHERE user_id=intent.user_id),'ACTIVE')<>'ACTIVE'
  OR doc->>'mode' IS DISTINCT FROM 'LOCAL_CONTROLLED' OR doc->>'intentId' IS DISTINCT FROM intent.id OR doc->>'payoutKey' IS DISTINCT FROM intent.payout_key
  OR(NEW.scenario='FAIL_UNPAID' AND doc IS DISTINCT FROM jsonb_build_object('mode','LOCAL_CONTROLLED','intentId',intent.id,'payoutKey',intent.payout_key,'outcome','FAILED','reference',NEW.id,'unpaidConfirmed',true,'transferredCents','0','chargedFeeCents','0'))
  OR(NEW.scenario='TIMEOUT_THEN_SUCCEED' AND doc IS DISTINCT FROM jsonb_build_object('mode','LOCAL_CONTROLLED','intentId',intent.id,'payoutKey',intent.payout_key,'outcome','SUCCEEDED','reference',NEW.id,'netCents',intent.net_cents::text,'feeCents',intent.fee_cents::text)) THEN RAISE EXCEPTION 'unadmitted controlled channel operation' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_controlled_payment_declaration(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_controlled_payment_declaration() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE a zzsh_order.distribution_order_admission;doc jsonb:=NEW.canonical_payment::jsonb;key_name text;
BEGIN
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$'
  OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_oid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.source_event_key IS DISTINCT FROM 'local-controlled-payment:'||NEW.id
 THEN RAISE EXCEPTION 'controlled declaration requires exact maintained local order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE id=NEW.admission_id AND order_id=NEW.order_id;
 IF a.id IS NULL OR NOT a.active OR a.revision<>NEW.admission_revision OR a.approval_digest<>NEW.approval_digest
  OR a.resource_oid<>NEW.resource_oid OR a.admitted_at>clock_timestamp() OR a.expires_at<=clock_timestamp()
  OR a.resource_name<>current_database() OR a.resource_marker IS DISTINCT FROM
   (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'controlled source outside original approved admission' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(doc))<>7 THEN RAISE EXCEPTION 'exact payment input required' USING ERRCODE='23514';END IF;
 FOREACH key_name IN ARRAY ARRAY['orderId','merchantOrderNo','providerTransactionId','amountCents','currency','providerPaidAt','requestId'] LOOP
  IF jsonb_typeof(doc->key_name) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'payment source field absent or not string' USING ERRCODE='23514';END IF;
 END LOOP;
 IF doc->>'orderId' IS DISTINCT FROM NEW.order_id OR doc->>'merchantOrderNo' IS DISTINCT FROM NEW.merchant_order_no
  OR doc->>'providerTransactionId' IS DISTINCT FROM NEW.provider_transaction_id
  OR (doc->>'amountCents')!~'^(0|[1-9][0-9]{0,24})$' OR (doc->>'currency')!~'^[A-Z]{3}$'
  OR (doc->>'providerPaidAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 THEN RAISE EXCEPTION 'payment declaration differs from original immutable tuple' USING ERRCODE='23514';END IF;
 FOREACH key_name IN ARRAY ARRAY['orderId','merchantOrderNo','providerTransactionId','requestId'] LOOP
  IF (doc->>key_name)!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RAISE EXCEPTION 'payment source identifier invalid' USING ERRCODE='23514';END IF;
 END LOOP;
 IF to_char((doc->>'providerPaidAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>doc->>'providerPaidAt'
 THEN RAISE EXCEPTION 'payment source timestamp invalid' USING ERRCODE='23514';END IF;
 NEW.declared_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_covered_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_covered_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE basis zzsh_order.finance_opening_basis;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF current_user<>owner_name OR basis.id IS NULL OR basis.source_kind<>'LEGACY_OPENING' OR basis.user_id<>NEW.user_id OR NEW.source_event_at>basis.source_cutoff THEN
  RAISE EXCEPTION 'covered event requires admitted subject and inclusive cutoff' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_distribution_order_admission(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_distribution_order_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE order_row zzsh_order.rental_order;
BEGIN
 IF NEW.mode='NATIVE' THEN
  IF NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
   OR NEW.resource_marker<>'NATIVE_CREATED_ORDER_V1' OR NEW.created_by_admin_id IS NOT NULL
   OR NEW.source_admission_ref IS NULL OR NEW.revision<>1 OR NOT NEW.active OR NEW.admitted_at>clock_timestamp() OR NEW.expires_at<>'infinity'::timestamptz
   OR NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
    AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.oid<>d.datdba AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))
  THEN RAISE EXCEPTION 'native admission requires exact application runtime source' USING ERRCODE='23514';END IF;
  SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM zzsh_order.payment_request p WHERE p.order_id=NEW.order_id AND p.channel='JOINPAY' AND p.evidence_level='JOINPAY_CANDIDATE'
    AND p.state='SUBMITTING' AND p.revision=1 AND p.lease_version=0)
   OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.id=NEW.native_creation_audit_id AND a.action='order.reservation.created'
    AND a.object_type='rental_order' AND a.object_id=NEW.order_id AND a.actor_type='user' AND a.actor_id=order_row.renter_user_id AND a.outcome='SUCCESS')
  THEN RAISE EXCEPTION 'native admission requires original unpaid request creation' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$' OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.resource_marker IS DISTINCT FROM (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'order admission requires exact maintained order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event WHERE id=NEW.native_creation_audit_id AND action='order.reservation.created'
   AND object_type='rental_order' AND object_id=NEW.order_id AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'new native order origin/payment state is not proved' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_distribution_participant(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_distribution_participant() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE policy jsonb;policy_scope text;policy_schema text;head_id text;default_level text;owner_name text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'participant provenance cannot be deleted' USING ERRCODE='40001';END IF;
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF TG_OP='INSERT' THEN
  IF NEW.source_type<>'NATIVE_REGISTRATION' AND current_user<>owner_name
  THEN RAISE EXCEPTION 'runtime participant requires native registration provenance' USING ERRCODE='23514';END IF;
  IF NEW.source_type='NATIVE_REGISTRATION' THEN
   IF NEW.source_ref<>'registration:'||NEW.user_id OR NEW.invitees_knowledge<>'KNOWN'
    OR NEW.commission_frozen IS DISTINCT FROM false OR NOT EXISTS(
     SELECT 1 FROM zzsh_order.native_user_insert_proof p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
     JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
     WHERE p.user_id=NEW.user_id AND p.insert_xid=pg_current_xact_id() AND NOT u.suspended
      AND s.account_status='ACTIVE' AND s.provider='none')
    OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
   THEN RAISE EXCEPTION 'native participant requires protected fresh insertion' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(
  NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
  OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
  OR NEW.revision<>OLD.revision+1 OR NEW.inviter_knowledge IS DISTINCT FROM OLD.inviter_knowledge
  OR OLD.leader_knowledge='KNOWN_PARENT' AND NEW.leader_knowledge<>'KNOWN_PARENT')
 THEN RAISE EXCEPTION 'participant requires exact next revision and immutable original provenance' USING ERRCODE='40001';END IF;
 IF NEW.policy_version_id IS NULL THEN
  IF NEW.level_code IS NOT NULL OR NEW.eligibility='ELIGIBLE'
  THEN RAISE EXCEPTION 'participant without a policy source cannot claim eligibility or level' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT v.scope,v.schema_version,v.canonical_config::jsonb INTO policy_scope,policy_schema,policy
  FROM zzsh_order.distribution_policy_version v WHERE v.id=NEW.policy_version_id;
 IF policy IS NULL THEN RAISE EXCEPTION 'participant policy source is missing' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id THEN
  SELECT h.current_version_id INTO head_id FROM zzsh_order.distribution_policy_head h WHERE h.scope=policy_scope;
  IF head_id IS DISTINCT FROM NEW.policy_version_id
  THEN RAISE EXCEPTION 'participant must use the exact current head of its policy scope' USING ERRCODE='23514';END IF;
 END IF;
 IF policy_schema='distribution-policy.v2' THEN
  IF NEW.level_code IS NOT NULL THEN RAISE EXCEPTION 'uniform policy participant cannot carry a legacy level' USING ERRCODE='23514';END IF;
  -- v2 disabled stops new first-payment accrual; it does not erase participation eligibility.
  IF TG_OP='INSERT' AND NEW.source_type='NATIVE_REGISTRATION' AND NEW.eligibility<>'ELIGIBLE'
  THEN RAISE EXCEPTION 'uniform registration must retain eligibility' USING ERRCODE='23514';END IF;
 ELSE
  SELECT level->>'code' INTO default_level FROM jsonb_array_elements(COALESCE(policy->'levels','[]'::jsonb)) level WHERE level->'default'='true'::jsonb;
  IF NEW.level_code IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(policy->'levels','[]'::jsonb)) level WHERE level->>'code'=NEW.level_code)
  THEN RAISE EXCEPTION 'participant level has no exact policy source' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' AND NEW.source_type='NATIVE_REGISTRATION'
   AND(NEW.level_code IS DISTINCT FROM default_level OR NEW.eligibility IS DISTINCT FROM(CASE WHEN policy->'enabled'='true'::jsonb THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END))
  THEN RAISE EXCEPTION 'native registration must use original head and default qualification' USING ERRCODE='23514';END IF;
  IF NEW.eligibility='ELIGIBLE' AND policy->'enabled' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'disabled policy cannot admit an eligible participant' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_distribution_policy_head(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_distribution_policy_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||NEW.scope,0));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'policy head cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(NEW.scope IS DISTINCT FROM OLD.scope OR NEW.revision<>OLD.revision+1 OR NEW.current_version_id=OLD.current_version_id)
  THEN RAISE EXCEPTION 'policy head requires exact next immutable version' USING ERRCODE='40001';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_distribution_policy_version(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_distribution_policy_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE doc jsonb:=NEW.canonical_config::jsonb;l jsonb;u jsonb;c jsonb;keys integer;defaults integer:=0;max_r numeric:=0;max_o numeric:=0;
BEGIN
 SELECT count(*) INTO keys FROM jsonb_object_keys(doc);
 IF NEW.schema_version='distribution-policy.v2' THEN
  IF keys<>13 OR doc->>'schema' IS DISTINCT FROM 'distribution-policy.v2' OR doc->>'scope' IS DISTINCT FROM NEW.scope
   OR jsonb_typeof(doc->'enabled') IS DISTINCT FROM 'boolean' OR doc->>'participation' IS DISTINCT FROM 'AUTO_AT_REGISTRATION'
   OR doc->'depth' IS DISTINCT FROM '1'::jsonb OR doc->'selfRebate' IS DISTINCT FROM 'false'::jsonb
   OR doc->>'rateMode' IS DISTINCT FROM 'UNIFORM'
   OR jsonb_typeof(doc->'minimumAccrualCents') IS DISTINCT FROM 'string' OR COALESCE(doc->>'minimumAccrualCents','')!~'^(0|[1-9][0-9]{0,23})$'
   OR jsonb_typeof(doc->'settlementDelayDays') IS DISTINCT FROM 'number' OR COALESCE(doc->>'settlementDelayDays','')!~'^(0|[1-9][0-9]{0,5})$'
   OR jsonb_typeof(doc->'accountModes') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'levels') IS DISTINCT FROM 'array'
   OR jsonb_array_length(doc->'levels')<>0
   OR jsonb_typeof(doc->'renterPercent') IS DISTINCT FROM 'string' OR COALESCE(doc->>'renterPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
   OR jsonb_typeof(doc->'ownerPercent') IS DISTINCT FROM 'string' OR COALESCE(doc->>'ownerPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'typed uniform policy shape invalid' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(doc->'accountModes') NOT BETWEEN 1 AND 2 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'accountModes') m WHERE m NOT IN('"ordinary"'::jsonb,'"custom"'::jsonb))
   OR (SELECT count(DISTINCT m) FROM jsonb_array_elements(doc->'accountModes') m)<>jsonb_array_length(doc->'accountModes')
   OR (doc->>'renterPercent')::numeric+(doc->>'ownerPercent')::numeric>100
  THEN RAISE EXCEPTION 'uniform modes or role rate bounds invalid' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF keys<>10 OR doc->>'schema' IS DISTINCT FROM NEW.schema_version OR doc->>'scope' IS DISTINCT FROM NEW.scope
  OR jsonb_typeof(doc->'enabled') IS DISTINCT FROM 'boolean' OR doc->>'participation' IS DISTINCT FROM 'AUTO_AT_REGISTRATION'
  OR doc->'depth' IS DISTINCT FROM '1'::jsonb OR doc->'selfRebate' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(doc->'minimumAccrualCents') IS DISTINCT FROM 'string' OR COALESCE(doc->>'minimumAccrualCents','')!~'^(0|[1-9][0-9]{0,23})$'
  OR jsonb_typeof(doc->'settlementDelayDays') IS DISTINCT FROM 'number' OR COALESCE(doc->>'settlementDelayDays','')!~'^(0|[1-9][0-9]{0,5})$'
  OR jsonb_typeof(doc->'accountModes') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'levels') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'typed distribution policy shape invalid' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'accountModes') NOT BETWEEN 1 AND 2 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(doc->'accountModes') m WHERE m NOT IN('"ordinary"'::jsonb,'"custom"'::jsonb))
  OR (SELECT count(DISTINCT m) FROM jsonb_array_elements(doc->'accountModes') m)<>jsonb_array_length(doc->'accountModes')
  OR jsonb_array_length(doc->'levels') NOT BETWEEN 1 AND 999
 THEN RAISE EXCEPTION 'distribution modes or levels invalid' USING ERRCODE='23514';END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(doc->'levels') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed level object required' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO keys FROM jsonb_object_keys(l);
  IF keys<>6 OR jsonb_typeof(l->'code') IS DISTINCT FROM 'string' OR COALESCE(l->>'code','')!~'^[A-Za-z][A-Za-z0-9_-]{0,63}$'
   OR jsonb_typeof(l->'rank') IS DISTINCT FROM 'number' OR COALESCE(l->>'rank','')!~'^[1-9][0-9]{0,2}$'
   OR jsonb_typeof(l->'default') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(l->'renterPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'renterPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
   OR jsonb_typeof(l->'ownerPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'ownerPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'typed level fields invalid' USING ERRCODE='23514';END IF;
  max_r:=greatest(max_r,(l->>'renterPercent')::numeric);max_o:=greatest(max_o,(l->>'ownerPercent')::numeric);
  IF l->'default'='true'::jsonb THEN defaults:=defaults+1;END IF;
  u:=l->'upgrade';IF u IS DISTINCT FROM 'null'::jsonb THEN
   IF jsonb_typeof(u) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade required' USING ERRCODE='23514';END IF;
   SELECT count(*) INTO keys FROM jsonb_object_keys(u);
   IF keys<>2 OR COALESCE(u->>'match','') NOT IN('ANY','ALL') OR jsonb_typeof(u->'conditions') IS DISTINCT FROM 'array' OR l->'default'='true'::jsonb
   THEN RAISE EXCEPTION 'typed upgrade shape invalid' USING ERRCODE='23514';END IF;
   IF jsonb_array_length(u->'conditions') NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'empty upgrade is not automatic eligibility' USING ERRCODE='23514';END IF;
   FOR c IN SELECT value FROM jsonb_array_elements(u->'conditions') LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade condition required' USING ERRCODE='23514';END IF;
    SELECT count(*) INTO keys FROM jsonb_object_keys(c);
    IF keys<>2 OR COALESCE(c->>'metric','') NOT IN('LAST_PAID_AMOUNT','TOTAL_PAID_AMOUNT','PAID_COUNT','SETTLED_REFERRAL')
     OR jsonb_typeof(c->'value') IS DISTINCT FROM 'string' OR COALESCE(c->>'value','')!~'^(0|[1-9][0-9]{0,23})$'
    THEN RAISE EXCEPTION 'typed upgrade condition invalid' USING ERRCODE='23514';END IF;
   END LOOP;
   IF (SELECT count(DISTINCT x->>'metric') FROM jsonb_array_elements(u->'conditions') x)<>jsonb_array_length(u->'conditions')
   THEN RAISE EXCEPTION 'duplicate upgrade metric' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 IF defaults<>1 OR max_r+max_o>100
  OR (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
  OR (SELECT count(DISTINCT x->>'rank') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
 THEN RAISE EXCEPTION 'distribution defaults, stable levels or cross-level rate bounds invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_earning_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_earning_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;expected_scope text;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 SELECT CASE WHEN a.mode='NATIVE' THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END INTO expected_scope
  FROM zzsh_order.distribution_order_admission a WHERE a.order_id=r.order_id;
 IF r.id IS NULL OR expected_scope IS NULL OR e.created_xid<>pg_current_xact_id() OR NEW.details->>'earningId' IS DISTINCT FROM r.id
  OR NEW.details->>'earningRole' IS DISTINCT FROM r.beneficiary_role OR NEW.details->>'scope' IS DISTINCT FROM expected_scope
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.earning_expected_lines(e.id) x WHERE
   (NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id,NEW.source_payment_confirmation_id)
    IS NOT DISTINCT FROM(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id))
 THEN RAISE EXCEPTION 'earning line differs from exact original template' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;


--
-- Name: guard_earning_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_earning_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.rental_referral_earning;version_now bigint;available numeric;
BEGIN
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=NEW.economic_root_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.subject_user_id FOR UPDATE;
 SELECT ledger_revision INTO version_now FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF r.id IS NULL OR NEW.subject_user_id<>r.beneficiary_user_id OR version_now IS DISTINCT FROM NEW.expected_ledger_revision
 THEN RAISE EXCEPTION 'earning event lacks exact source/wallet revision' USING ERRCODE='23514';END IF;
 IF NEW.kind='EARNING_PENDING' AND(r.created_xid<>pg_current_xact_id() OR r.state<>'PENDING' OR r.version<>1)
  OR NEW.kind='EARNING_SETTLED' AND(r.state<>'PENDING' OR clock_timestamp()<r.due_at)
  OR NEW.kind='EARNING_REVOKED' AND r.state NOT IN('PENDING','SETTLED','RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'earning event state/due/source transaction invalid' USING ERRCODE='23514';END IF;
 IF NEW.kind='EARNING_REVOKED' AND r.state IN('SETTLED','RECOVERY_REQUIRED') THEN
  SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
   WHERE counterparty_user_id=r.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
  IF available<r.amount_cents THEN RAISE EXCEPTION 'insufficient available requires recovery, no debit' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_finance_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_finance_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_row zzsh_order.finance_event;root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=event_row.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 IF event_row.id IS NULL OR event_row.created_xid<>pg_current_xact_id() OR event_row.kind<>'OPENING' OR basis.available_cents<=0 OR NEW.source_payment_confirmation_id IS NOT NULL THEN
  RAISE EXCEPTION 'batch sealed/unadmitted or native zero cannot have entries' USING ERRCODE='23514'; END IF;
 IF NOT((NEW.line_no=1 AND NEW.account_code='LEGACY_OPENING_SOURCE' AND NEW.debit_cents=basis.available_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
 OR(NEW.line_no=2 AND NEW.account_code='WALLET_AVAILABLE' AND NEW.credit_cents=basis.available_cents AND NEW.debit_cents=0 AND NEW.counterparty_user_id=event_row.subject_user_id)) THEN
  RAISE EXCEPTION 'entry differs from exact admitted template' USING ERRCODE='23514'; END IF;
 IF NEW.details IS DISTINCT FROM jsonb_build_object('basisId',basis.id,'economicRootId',root.id,'sourceDigest',basis.source_digest) THEN
  RAISE EXCEPTION 'entry provenance mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_finance_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_finance_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;revision_now bigint;
BEGIN
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 IF root.id IS NULL OR NEW.subject_user_id<>root.subject_user_id OR NEW.kind<>'OPENING' THEN
  RAISE EXCEPTION 'event source, subject or action mismatch' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.subject_user_id FOR UPDATE;
 SELECT COALESCE((SELECT ledger_revision FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id),0) INTO revision_now;
 IF NEW.expected_ledger_revision<>revision_now OR EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.subject_user_id) THEN
  RAISE EXCEPTION 'stale wallet revision or source already covered' USING ERRCODE='40001'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_finance_history_coverage(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_finance_history_coverage() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE owner_name text;p jsonb;source_rows integer;unique_rows integer;imported_digest text;isolated_digest text;source_digest text;actual_count integer;actual_digest text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name THEN RAISE EXCEPTION 'history coverage requires maintenance owner' USING ERRCODE='42501';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 p:=NEW.source_canonical::jsonb;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'imported') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'isolated') IS DISTINCT FROM 'array'
  OR NEW.body_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex')
  OR p->>'userId' IS DISTINCT FROM NEW.user_id OR p->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id
  OR p->>'sourceSystem' IS DISTINCT FROM NEW.source_system OR p->>'sourceKind' IS DISTINCT FROM NEW.source_kind
  OR p->>'inputSha256' IS DISTINCT FROM NEW.input_sha256 OR p->>'identityDigest' IS DISTINCT FROM NEW.identity_digest
  OR (p->>'cutoff')::timestamptz IS DISTINCT FROM NEW.source_cutoff OR NEW.source_cutoff>clock_timestamp()
  OR p->>'sourceCount' IS DISTINCT FROM NEW.source_count::text
  OR jsonb_array_length(p->'imported')<>NEW.imported_count OR jsonb_array_length(p->'isolated')<>NEW.isolated_count THEN
  RAISE EXCEPTION 'history coverage body/source/count mismatch' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE action='user.legacy_owner.migrated' AND outcome='SUCCESS' AND object_id=NEW.user_id
  AND details->>'sourceSystem'=NEW.source_system AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest) THEN
  RAISE EXCEPTION 'history coverage identity mapping mismatch' USING ERRCODE='23514';END IF;
 SELECT count(*),count(DISTINCT x->>'sourceId'),encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex')
  INTO source_rows,unique_rows,source_digest FROM jsonb_array_elements((p->'imported')||(p->'isolated')) x;
 IF source_rows<>NEW.source_count OR unique_rows<>source_rows OR source_digest<>NEW.source_set_digest
  OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'imported')||(p->'isolated')) x WHERE
   jsonb_typeof(x) IS DISTINCT FROM 'object' OR jsonb_typeof(x->'sourceId') IS DISTINCT FROM 'string' OR (x->>'sourceId') !~ '^[1-9][0-9]{0,23}$'
   OR jsonb_typeof(x->'sourceDigest') IS DISTINCT FROM 'string' OR (x->>'sourceDigest') !~ '^[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'isolated') x WHERE jsonb_typeof(x->'reason') IS DISTINCT FROM 'string' OR length(x->>'reason') NOT BETWEEN 1 AND 128) THEN
  RAISE EXCEPTION 'history coverage duplicate/missing/malformed member' USING ERRCODE='23514';END IF;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO imported_digest FROM jsonb_array_elements(p->'imported') x;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO isolated_digest FROM jsonb_array_elements(p->'isolated') x;
 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(o.source_id||':'||o.source_digest,chr(10) ORDER BY o.source_id COLLATE "C"),''),'UTF8')),'hex')
  INTO actual_count,actual_digest FROM zzsh_order.personal_finance_observation o
  WHERE o.user_id=NEW.user_id AND o.source_system=NEW.source_system AND o.source_type='LEGACY_MYSQL' AND o.source_kind=NEW.source_kind
   AND o.source_entity=NEW.source_entity AND o.legacy_user_id=NEW.legacy_user_id AND o.source_event_at<=NEW.source_cutoff;
 IF imported_digest<>NEW.imported_set_digest OR isolated_digest<>NEW.isolated_set_digest OR actual_count<>NEW.imported_count OR actual_digest<>NEW.imported_set_digest THEN
  RAISE EXCEPTION 'history coverage target set does not close' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_finance_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_finance_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE owner_name text;basis zzsh_order.finance_opening_basis;expected_kind text;event_seconds numeric;admission zzsh_order.finance_observation_admission;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name THEN RAISE EXCEPTION 'historical observations require maintenance admission' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
   AND details->>'sourceSystem'=NEW.source_system AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id) THEN
   RAISE EXCEPTION 'observation legacy subject/source binding missing' USING ERRCODE='23514'; END IF;
 IF NEW.basis_id IS NOT NULL THEN
  SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
  IF basis.id IS NULL OR basis.user_id<>NEW.user_id OR basis.source_system<>NEW.source_system OR basis.source_id<>NEW.legacy_user_id THEN
   RAISE EXCEPTION 'observation basis belongs to another subject/source' USING ERRCODE='23514'; END IF;
 END IF;
 expected_kind:=CASE NEW.source_entity WHEN 'la_log_earnings' THEN 'earningsLog' WHEN 'la_distribution_order' THEN 'historicalDistribution' WHEN 'la_withdraw_apply' THEN 'withdrawObservation' ELSE NULL END;
 IF expected_kind IS NULL OR NEW.snapshot->>'kind' IS DISTINCT FROM expected_kind
  OR NEW.snapshot->>'sourceId' IS DISTINCT FROM NEW.source_id OR NEW.snapshot->>'sourceUserId' IS DISTINCT FROM NEW.legacy_user_id
  OR NEW.snapshot IS DISTINCT FROM NEW.source_canonical::jsonb OR NEW.source_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'observation tuple/canonical digest mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.source_kind IS DISTINCT FROM (CASE NEW.source_entity WHEN 'la_log_earnings' THEN 'HISTORICAL_EARNINGS_LOG' WHEN 'la_distribution_order' THEN 'HISTORICAL_DISTRIBUTION' ELSE 'HISTORICAL_WITHDRAWAL' END) THEN
  RAISE EXCEPTION 'observation source kind mismatch' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(NEW.snapshot->'amount') IS DISTINCT FROM 'string' OR NEW.snapshot->>'amount' !~ '^(0|[1-9][0-9]{0,21})[.][0-9]{2}$' THEN
 RAISE EXCEPTION 'historical amount invalid' USING ERRCODE='23514'; END IF;
 IF NEW.source_entity='la_log_earnings' THEN
  IF jsonb_typeof(NEW.snapshot->'action') IS DISTINCT FROM 'number' OR NEW.snapshot->>'action' NOT IN ('1','2')
   OR jsonb_typeof(NEW.snapshot->'leftAmount') IS DISTINCT FROM 'string' OR NEW.snapshot->>'leftAmount' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'leftAmount'='-0.00' THEN
   RAISE EXCEPTION 'historical direction/left amount invalid' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_entity='la_distribution_order' THEN
  IF jsonb_typeof(NEW.snapshot->'sourceStatus') IS DISTINCT FROM 'number' OR NEW.snapshot->>'sourceStatus' NOT IN ('1','2','3') THEN RAISE EXCEPTION 'distribution status unknown' USING ERRCODE='23514'; END IF;
 ELSE
  IF jsonb_typeof(NEW.snapshot->'sourceStatus') IS DISTINCT FROM 'number' OR NEW.snapshot->>'sourceStatus' NOT IN ('1','2','3','4','5')
   OR jsonb_typeof(NEW.snapshot->'net') IS DISTINCT FROM 'string' OR NEW.snapshot->>'net' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'net'='-0.00'
   OR jsonb_typeof(NEW.snapshot->'fee') IS DISTINCT FROM 'string' OR NEW.snapshot->>'fee' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'fee'='-0.00' THEN RAISE EXCEPTION 'withdrawal source fields invalid' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.source_entity='la_distribution_order' THEN
  IF jsonb_typeof(NEW.snapshot->'sourceUpdatedAt') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'source time unknown' USING ERRCODE='23514'; END IF;
  event_seconds:=(NEW.snapshot->>'sourceUpdatedAt')::numeric;
 ELSE
  IF jsonb_typeof(NEW.snapshot->'createdAt') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'source time unknown' USING ERRCODE='23514'; END IF;
  event_seconds:=(NEW.snapshot->>'createdAt')::numeric;
 END IF;
 IF event_seconds<=0 OR event_seconds<>trunc(event_seconds) OR event_seconds>4294967295
  OR NEW.source_event_at IS DISTINCT FROM to_timestamp(event_seconds::double precision) THEN RAISE EXCEPTION 'snapshot/source event time mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.basis_id IS NOT NULL THEN
  SELECT * INTO admission FROM zzsh_order.finance_observation_admission WHERE basis_id=NEW.basis_id AND source_entity=NEW.source_entity AND source_id=NEW.source_id;
  IF admission.user_id IS DISTINCT FROM NEW.user_id OR admission.source_system IS DISTINCT FROM NEW.source_system OR admission.legacy_user_id IS DISTINCT FROM NEW.legacy_user_id
   OR admission.source_digest IS DISTINCT FROM NEW.source_digest OR admission.source_event_at IS DISTINCT FROM NEW.source_event_at
   OR admission.included_in_opening IS DISTINCT FROM NEW.included_in_opening OR NEW.source_event_at>basis.source_cutoff THEN
   RAISE EXCEPTION 'observation not in reviewed frozen admission' USING ERRCODE='23514'; END IF;
 ELSIF NEW.included_in_opening THEN RAISE EXCEPTION 'unadmitted history cannot be included in opening' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_finance_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_finance_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF basis.id IS NULL OR NEW.source_kind<>basis.source_kind OR NEW.subject_user_id<>basis.user_id OR NEW.source_system<>basis.source_system
  OR NEW.source_entity<>basis.source_entity OR NEW.source_id<>basis.source_id OR NEW.source_digest<>basis.source_digest
  OR NEW.source_type<>'LEGACY_MYSQL'
  OR NEW.beneficiary_role<>'WALLET_HOLDER' OR NEW.policy_version IS NOT NULL THEN
  RAISE EXCEPTION 'root source, subject or role unadmitted; kind not enabled' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=basis.user_id FOR UPDATE;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_first_response_binding(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_first_response_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_row zzsh_order.im_order_event%ROWTYPE;
BEGIN
  IF NEW.first_response_event_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.first_response_state='STOPPED' THEN
      RAISE EXCEPTION 'stopped first response cannot be cleared' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO event_row FROM zzsh_order.im_order_event WHERE id=NEW.first_response_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'first response event is missing' USING ERRCODE='40001'; END IF;
  IF event_row.type<>'first_response' OR event_row.status<>'VERIFIED'
    OR event_row.app_id<>NEW.app_id OR event_row.order_id<>NEW.order_id OR event_row.team_id<>NEW.team_id THEN
    RAISE EXCEPTION 'first response event binding mismatch' USING ERRCODE='40001';
  END IF;
  IF NEW.first_response_at IS DISTINCT FROM event_row.occurred_at THEN
    RAISE EXCEPTION 'first response time must equal its event time' USING ERRCODE='40001';
  END IF;
  IF event_row.message_server_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_event d WHERE d.type='message_delivered' AND d.status='VERIFIED'
      AND d.app_id=NEW.app_id AND d.team_id=NEW.team_id AND d.message_server_id=event_row.message_server_id) THEN
    RAISE EXCEPTION 'first response requires a verified delivery' USING ERRCODE='40001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.first_response_event_id IS NOT NULL AND OLD.first_response_event_id<>NEW.first_response_event_id
    AND (OLD.first_response_at IS NULL OR NEW.first_response_at IS NULL OR NEW.first_response_at>=OLD.first_response_at) THEN
    RAISE EXCEPTION 'first response may only move to an earlier event' USING ERRCODE='40001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.first_response_state='STOPPED' AND NEW.first_response_state<>'STOPPED' THEN
    RAISE EXCEPTION 'stopped first response cannot reopen' USING ERRCODE='40001';
  END IF;
  IF NEW.first_response_state='STOPPED' AND (NEW.first_response_event_id IS NULL OR NEW.first_response_at IS NULL) THEN
    RAISE EXCEPTION 'stopped first response requires evidence' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_guarantee_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_guarantee_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE e zzsh_order.finance_event; root zzsh_order.finance_economic_root; amount numeric; expected jsonb; p record; f record;
BEGIN
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=e.economic_root_id;
  IF e.id IS NULL OR e.kind NOT IN ('GUARANTEE_CAPTURE','GUARANTEE_REFUND') OR e.created_xid<>pg_current_xact_id() OR root.source_kind<>'NATIVE_GUARANTEE' OR NEW.source_payment_confirmation_id IS NOT NULL THEN
    RAISE EXCEPTION 'guarantee ledger entry is unadmitted' USING ERRCODE='23514';
  END IF;
  IF root.source_entity='owner_guarantee_payment' THEN
    SELECT g.requirement_id AS requirement_id,g.owner_user_id AS owner_user_id,COALESCE(g.observed_amount_cents,g.amount_cents) AS amount_cents INTO p FROM zzsh_order.owner_guarantee_payment AS g WHERE g.id=root.source_id;
    amount:=p.amount_cents;
    expected:=jsonb_build_object('guaranteeId',root.source_id,'requirementId',p.requirement_id,'economicRootId',root.id,'sourceDigest',root.source_digest);
  ELSE
    SELECT g.requirement_id AS requirement_id,g.owner_user_id AS owner_user_id,g.amount_cents AS amount_cents INTO f FROM zzsh_order.owner_guarantee_refund AS g WHERE g.id=root.source_id;
    amount:=f.amount_cents;
    expected:=jsonb_build_object('guaranteeId',root.source_id,'requirementId',f.requirement_id,'economicRootId',root.id,'sourceDigest',root.source_digest);
  END IF;
  IF NEW.details IS DISTINCT FROM expected THEN RAISE EXCEPTION 'guarantee ledger provenance mismatch' USING ERRCODE='23514'; END IF;
  IF e.kind='GUARANTEE_CAPTURE' AND NOT((NEW.line_no=1 AND NEW.account_code='GUARANTEE_CASH' AND NEW.debit_cents=amount AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
    OR (NEW.line_no=2 AND NEW.account_code='GUARANTEE_HELD' AND NEW.debit_cents=0 AND NEW.credit_cents=amount AND NEW.counterparty_user_id=(SELECT owner_user_id FROM zzsh_order.owner_guarantee_payment WHERE id=root.source_id))) THEN
    RAISE EXCEPTION 'guarantee capture ledger line differs from exact template' USING ERRCODE='23514';
  END IF;
  IF e.kind='GUARANTEE_REFUND' AND NOT((NEW.line_no=1 AND NEW.account_code='GUARANTEE_CASH' AND NEW.debit_cents=0 AND NEW.credit_cents=amount AND NEW.counterparty_user_id IS NULL)
    OR (NEW.line_no=2 AND NEW.account_code='GUARANTEE_HELD' AND NEW.debit_cents=amount AND NEW.credit_cents=0 AND NEW.counterparty_user_id=(SELECT owner_user_id FROM zzsh_order.owner_guarantee_refund WHERE id=root.source_id))) THEN
    RAISE EXCEPTION 'guarantee refund ledger line differs from exact template' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_guarantee_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_guarantee_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE root zzsh_order.finance_economic_root; p record; f record;
BEGIN
  SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
  IF root.id IS NULL OR root.source_kind<>'NATIVE_GUARANTEE' OR NEW.subject_user_id<>root.subject_user_id OR NEW.expected_ledger_revision<>0
    OR (NEW.kind='GUARANTEE_CAPTURE' AND root.source_entity<>'owner_guarantee_payment')
    OR (NEW.kind='GUARANTEE_REFUND' AND root.source_entity<>'owner_guarantee_refund') THEN
    RAISE EXCEPTION 'guarantee event source/action mismatch' USING ERRCODE='23514';
  END IF;
  IF root.source_entity='owner_guarantee_payment' THEN
    SELECT status,provider_request_state,finance_event_id INTO p FROM zzsh_order.owner_guarantee_payment WHERE id=root.source_id;
    IF p.status<>'CONFIRMED' OR p.provider_request_state<>'CONFIRMED' OR p.finance_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'guarantee capture event requires one unposted confirmed receipt' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT status,provider_request_state,finance_event_id INTO f FROM zzsh_order.owner_guarantee_refund WHERE id=root.source_id;
    IF f.status<>'SUCCEEDED' OR f.provider_request_state<>'SUCCEEDED' OR f.finance_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'guarantee refund event requires one unposted successful receipt' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.created_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;


--
-- Name: guard_guarantee_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_guarantee_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p record; f record;
BEGIN
  IF NEW.source_kind<>'NATIVE_GUARANTEE' OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-credit-guarantee'
    OR NEW.beneficiary_role<>'OWNER' OR NEW.policy_version<>'credit-guarantee-v1' THEN
    RAISE EXCEPTION 'unbound guarantee economic root' USING ERRCODE='23514';
  END IF;
  IF NEW.source_entity='owner_guarantee_payment' THEN
    SELECT id,requirement_id,owner_user_id,source_digest,provider_request_state,status INTO p FROM zzsh_order.owner_guarantee_payment WHERE id=NEW.source_id;
    IF p.id IS NULL OR p.owner_user_id<>NEW.subject_user_id OR p.source_digest IS NULL OR p.source_digest<>NEW.source_digest OR p.status<>'CONFIRMED' OR p.provider_request_state<>'CONFIRMED' THEN
      RAISE EXCEPTION 'guarantee payment root is not an admitted confirmed receipt' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.source_entity='owner_guarantee_refund' THEN
    SELECT id,requirement_id,owner_user_id,source_digest,provider_request_state,status INTO f FROM zzsh_order.owner_guarantee_refund WHERE id=NEW.source_id;
    IF f.id IS NULL OR f.owner_user_id<>NEW.subject_user_id OR f.source_digest IS NULL OR f.source_digest<>NEW.source_digest OR f.status<>'SUCCEEDED' OR f.provider_request_state<>'SUCCEEDED' THEN
      RAISE EXCEPTION 'guarantee refund root is not an admitted successful receipt' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown guarantee root source' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;


--
-- Name: guard_im_order_dispatch(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_im_order_dispatch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE system_row zzsh_iam.im_identity_mapping%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order intent cannot be deleted' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.provision_state<>'WAITING' OR NEW.version<>1 OR NEW.wait_reason IS NOT NULL OR NEW.team_state<>'PENDING'
      OR NEW.system_identity_id IS NOT NULL OR NEW.team_name IS NOT NULL OR NEW.members_limit IS NOT NULL THEN
      RAISE EXCEPTION 'order intent must start unassigned' USING ERRCODE='40001'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id,NEW.payment_confirmation_id,NEW.app_id,NEW.created_at) IS DISTINCT FROM
    (OLD.order_id,OLD.payment_confirmation_id,OLD.app_id,OLD.created_at) OR NEW.version<>OLD.version+1
    OR (OLD.provision_state='ASSIGNED' AND (NEW.provision_state,NEW.assigned_admin_id,NEW.assigned_at) IS DISTINCT FROM (OLD.provision_state,OLD.assigned_admin_id,OLD.assigned_at))
    OR (OLD.team_name IS NOT NULL AND (NEW.team_name,NEW.system_identity_id,NEW.members_limit) IS DISTINCT FROM (OLD.team_name,OLD.system_identity_id,OLD.members_limit))
    OR (OLD.team_id IS NOT NULL AND (NEW.team_id,NEW.team_state,NEW.team_ready_at) IS DISTINCT FROM (OLD.team_id,OLD.team_state,OLD.team_ready_at)) THEN
    RAISE EXCEPTION 'order binding is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.provision_state='WAITING' AND NEW.team_state<>'PENDING' THEN RAISE EXCEPTION 'unassigned Team' USING ERRCODE='23514'; END IF;
  IF NEW.system_identity_id IS NOT NULL THEN
    SELECT * INTO system_row FROM zzsh_iam.im_identity_mapping WHERE id=NEW.system_identity_id;
    IF system_row.app_id IS DISTINCT FROM NEW.app_id OR system_row.identity_kind IS DISTINCT FROM 'SYSTEM'
      OR system_row.realm IS DISTINCT FROM 'system' OR system_row.platform_subject_id IS DISTINCT FROM 'support-manager' THEN
      RAISE EXCEPTION 'wrong SYSTEM identity' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_invitation_relation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_invitation_relation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE cyclic boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 WITH RECURSIVE ancestors(user_id,path) AS(
  SELECT NEW.parent_user_id,ARRAY[NEW.parent_user_id]::text[]
  UNION ALL SELECT r.parent_user_id,a.path||r.parent_user_id FROM ancestors a JOIN zzsh_order.invitation_relation r ON r.child_user_id=a.user_id AND r.type=NEW.type
   WHERE NOT(r.parent_user_id=ANY(a.path))
 ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE user_id=NEW.child_user_id) INTO cyclic;
 IF cyclic THEN RAISE EXCEPTION 'invitation ancestor cycle rejected' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;


--
-- Name: guard_joinpay_account_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_account_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE item record; expected integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Account observations are append only' USING ERRCODE='23514'; END IF;
  NEW.recorded_at := clock_timestamp();
  IF NEW.decision='SUCCESS' THEN
    expected := CASE NEW.operation WHEN 'AVAILABLE' THEN 2 ELSE 4 END;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.amounts))<>expected THEN RAISE EXCEPTION 'Balance fields differ' USING ERRCODE='23514'; END IF;
    FOR item IN SELECT key,value FROM jsonb_each(NEW.amounts) LOOP
      IF NOT (item.key=ANY(CASE NEW.operation WHEN 'AVAILABLE' THEN ARRAY['useAbleSettAmount','availableSettAmountFrozen']
        ELSE ARRAY['useAbleAdvanceAmount','currentAdvanceAmount','usedAdvanceAmount','advanceFrozenAmount'] END))
        OR jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR jsonb_typeof(item.value->'rawDecimal') IS DISTINCT FROM 'string'
        OR length(item.value->>'rawDecimal')>128 OR (item.value->>'rawDecimal') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        OR NOT (item.value ? 'unitKnowledge' AND item.value ? 'cents')
        OR NOT COALESCE(((item.value->>'unitKnowledge'='UNKNOWN' AND item.value->'cents'='null'::jsonb)
          OR (item.value->>'unitKnowledge'='CNY_YUAN' AND jsonb_typeof(item.value->'cents')='string' AND (item.value->>'cents') ~ '^-?(0|[1-9][0-9]*)$')),false)
      THEN RAISE EXCEPTION 'Invalid precise balance' USING ERRCODE='23514'; END IF;
      IF item.value->>'unitKnowledge'='CNY_YUAN' AND
        ((item.value->>'rawDecimal') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
          OR (item.value->>'rawDecimal')::numeric*100<>(item.value->>'cents')::numeric)
      THEN RAISE EXCEPTION 'Balance cents mismatch' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_collection_evidence(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_collection_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE r record;o record;doc jsonb;pdoc jsonb;offset_text text;offset_minutes integer;
BEGIN
 SELECT p.*,b.formal_admission_ref,b.formal_admission_sha256,b.wire_merchant_no INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=p.id WHERE p.id=NEW.request_id;
 doc:=NEW.admission_canonical::jsonb;pdoc:=NEW.profile_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.formal_admission_ref IS NULL
  OR NEW.initial_admission_ref IS DISTINCT FROM r.formal_admission_ref OR NEW.initial_admission_sha256 IS DISTINCT FROM r.formal_admission_sha256
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no
  OR (NEW.admission_sha256<>r.formal_admission_sha256 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedInitialAdmissions') h
   WHERE h->>'reference'=r.formal_admission_ref AND h->>'sha256'=r.formal_admission_sha256))
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=NEW.operation
   AND p->>'profileId'=NEW.profile_id AND p->>'profileSha256'=NEW.profile_sha256 AND p->>'keyVersionRef'=NEW.key_version_ref)
  OR pdoc->>'profileId' IS DISTINCT FROM NEW.profile_id OR pdoc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id
  OR pdoc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no OR pdoc->>'purpose' IS DISTINCT FROM 'COLLECTION'
  OR pdoc->>'evidenceMode' IS DISTINCT FROM 'OFFICIAL' OR pdoc#>>ARRAY['operations',NEW.operation,'keyVersionRef'] IS DISTINCT FROM NEW.key_version_ref
  OR NEW.admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
 THEN RAISE EXCEPTION 'collection evidence original admission/profile binding differs' USING ERRCODE='23514';END IF;
 IF NEW.operation='QUERY' THEN
  SELECT x.*,a.operation,a.profile_id,a.profile_sha256,a.key_version_ref INTO o FROM zzsh_order.joinpay_collection_observation x
   JOIN zzsh_order.joinpay_collection_attempt a ON a.id=x.attempt_id AND a.request_id=x.request_id WHERE x.id=NEW.origin_observation_id;
  IF o.id IS NULL OR o.request_id<>NEW.request_id OR o.operation<>'QUERY' OR o.event<>'E4' OR NOT o.response_complete OR o.http_status<>200
   OR o.transport_failure IS NOT NULL OR o.raw_sha256 IS DISTINCT FROM NEW.raw_sha256 OR o.profile_id IS DISTINCT FROM NEW.profile_id
   OR o.profile_sha256 IS DISTINCT FROM NEW.profile_sha256 OR o.key_version_ref IS DISTINCT FROM NEW.key_version_ref
  THEN RAISE EXCEPTION 'query evidence must reference its exact complete attempt' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.event='E4' THEN
  offset_text:=pdoc#>>ARRAY['operations',NEW.operation,'timeOffsetMinutes'];
  IF offset_text IS NULL OR offset_text!~'^-?[0-9]{1,3}$' THEN RAISE EXCEPTION 'formal provider timezone required' USING ERRCODE='23514';END IF;
  offset_minutes:=offset_text::integer;
  IF abs(offset_minutes)>840 OR NEW.provider_paid_at IS DISTINCT FROM (NEW.provider_paid_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>offset_minutes)
  THEN RAISE EXCEPTION 'formal provider time differs from explicit offset' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_collection_insert(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_collection_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; canonical jsonb;
BEGIN
 IF TG_TABLE_NAME='joinpay_collection_binding' THEN
  SELECT channel,evidence_level INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id;
  IF NOT FOUND OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' THEN
   RAISE EXCEPTION 'collection cannot promote a synthetic or controlled request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 SELECT p.*,b.wire_merchant_no,b.trade_merchant_no,b.notify_url,b.initial_profile_sha256,b.evidence_mode AS original_mode INTO r
 FROM zzsh_order.payment_request p JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=p.id WHERE p.id=NEW.request_id;
 IF NOT FOUND OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR NEW.evidence_mode<>r.original_mode
  OR NEW.lease_version<>r.lease_version OR NEW.lease_owner<>r.lease_owner OR r.lease_until<=clock_timestamp()
  OR NEW.operation IS DISTINCT FROM (CASE WHEN r.lease_version=1 AND r.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END) THEN
  RAISE EXCEPTION 'collection attempt must bind its current lease' USING ERRCODE='23514';
 END IF;
 IF NEW.operation='SUBMIT' AND (NEW.profile_id<>r.config_profile_id OR NEW.key_version_ref<>r.key_version_ref OR NEW.profile_sha256<>r.initial_profile_sha256) THEN
  RAISE EXCEPTION 'first submit must use its original profile' USING ERRCODE='23514';
 END IF;
 canonical:=NEW.profile_canonical::jsonb;
 IF canonical->>'profileId' IS DISTINCT FROM NEW.profile_id OR canonical->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id
  OR canonical->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no
  OR (NEW.operation='SUBMIT' AND (canonical->>'tradeMerchantNo' IS DISTINCT FROM r.trade_merchant_no OR canonical->>'notifyUrl' IS DISTINCT FROM r.notify_url))
  OR canonical->>'purpose' IS DISTINCT FROM 'COLLECTION'
  OR canonical->>'evidenceMode' IS DISTINCT FROM 'OFFICIAL' OR canonical#>>ARRAY['operations',NEW.operation,'keyVersionRef'] IS DISTINCT FROM NEW.key_version_ref THEN
  RAISE EXCEPTION 'collection profile must preserve the original merchant and wire binding' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_collection_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_collection_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE a record; current_lease boolean;
BEGIN
 SELECT p.state,p.lease_version,p.lease_owner,p.lease_until,t.lease_version AS attempt_version,t.lease_owner AS attempt_owner INTO a
 FROM zzsh_order.payment_request p JOIN zzsh_order.joinpay_collection_attempt t ON t.request_id=p.id WHERE t.id=NEW.attempt_id AND p.id=NEW.request_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'collection observation attempt missing' USING ERRCODE='23514'; END IF;
 current_lease:=a.lease_version=a.attempt_version AND a.lease_owner=a.attempt_owner AND a.lease_until>clock_timestamp();
 IF NEW.event='E9' THEN
  IF current_lease OR NEW.state_before<>a.state OR NEW.state_after<>a.state THEN
   RAISE EXCEPTION 'stale collection evidence cannot change the request' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT current_lease THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
  IF NEW.state_after<>a.state THEN
   RAISE EXCEPTION 'collection observation state differs' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_collection_request(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_collection_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN('ACCEPTED','REVIEW_REQUIRED')
  AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.id=current_setting('zzsh.joinpay_evidence',true) AND e.request_id=NEW.id AND e.event='E4')
  AND zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) THEN
  IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal acceptance cannot change worker lease' USING ERRCODE='40001';END IF;
  RETURN NEW;
 END IF;
 IF NEW.state='ACCEPTED' THEN RAISE EXCEPTION 'collection evidence cannot accept payment' USING ERRCODE='23514'; END IF;
 IF NEW.lease_version=OLD.lease_version+1 THEN
  IF NEW.state<>OLD.state OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
   OR OLD.state NOT IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED')
   OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
   OR NEW.lease_until>clock_timestamp()+interval '3600 seconds' THEN
   RAISE EXCEPTION 'collection lease is not claimable' USING ERRCODE='40001';
  END IF;
 ELSIF NEW.lease_version=OLD.lease_version THEN
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   OR OLD.lease_until IS NULL THEN
   RAISE EXCEPTION 'collection result lease binding changed' USING ERRCODE='40001';
  END IF;
  IF OLD.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='40001',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
 ELSE RAISE EXCEPTION 'collection lease must advance once' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_formal_anchor(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_formal_anchor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_VERIFIED' AND (NEW.channel<>'JOINPAY' OR NEW.confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id
  WHERE r.id=NEW.request_id AND r.order_id=NEW.native_order_id AND r.merchant_identity_id=NEW.merchant_identity_id
   AND b.formal_admission_ref IS NOT NULL AND e.event='E4' AND e.channel_trx_no=NEW.channel_trx_no))
 THEN RAISE EXCEPTION 'formal anchor requires admitted original successful evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_formal_binding(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_formal_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r record; doc jsonb;
BEGIN
 IF NEW.formal_admission_ref IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 doc:=NEW.formal_admission_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.state<>'SUBMITTING' OR r.revision<>1 OR r.lease_version<>0
  OR NEW.evidence_mode<>'OFFICIAL' OR NEW.wire_merchant_no='888100000002340'
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.formal_admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NEW.formal_admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=r.config_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=r.key_version_ref)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['SUBMIT','QUERY','NOTIFY']) required(operation) WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=required.operation))
 THEN RAISE EXCEPTION 'initial formal binding is not admitted' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_formal_confirmation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_formal_confirmation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.id=NEW.joinpay_evidence_id
   JOIN zzsh_order.payment_channel_transaction a ON a.id=NEW.joinpay_anchor_id
  WHERE r.id=NEW.joinpay_request_id AND r.order_id=NEW.order_id AND r.channel='JOINPAY' AND b.formal_admission_ref IS NOT NULL
   AND r.channel_order_no=NEW.merchant_order_no AND r.amount_cents=NEW.amount_cents AND r.currency=NEW.currency
   AND r.merchant_identity_id=NEW.merchant_scope_id AND e.event='E4' AND e.channel_trx_no=NEW.provider_transaction_id
   AND e.provider_paid_at=NEW.provider_paid_at AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED'
   AND a.native_order_id=r.order_id AND a.request_id=r.id AND a.merchant_identity_id=NEW.merchant_scope_id AND a.channel_trx_no=NEW.provider_transaction_id)
 THEN RAISE EXCEPTION 'formal confirmation original evidence/funds mapping differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_payout_attempt(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_payout_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'payout attempt requires READ COMMITTED' USING ERRCODE='25001';END IF;
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id;
 IF i.id IS NULL OR i.state IN('RESERVED','SUCCEEDED','FAILED') OR i.funds_disposition<>'RESERVED'
  OR(NEW.operation='SUBMIT' AND i.requires_review)
  OR NEW.operation IS DISTINCT FROM (CASE WHEN i.lease_version=1 AND i.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END)
 THEN RAISE EXCEPTION 'payout attempt original operation invalid' USING ERRCODE='23514';END IF;
 IF (NEW.lease_version,NEW.lease_owner) IS DISTINCT FROM(i.lease_version,i.lease_owner) OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'payout attempt lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
 PERFORM zzsh_order.assert_joinpay_payout_scope(NEW.scope_canonical,NEW.scope_sha256,NEW.operation,NEW.profile_id,NEW.profile_sha256,NEW.key_version_ref,i);
 PERFORM zzsh_order.assert_joinpay_payout_profile(NEW.profile_canonical,NEW.operation,NEW.profile_id,NEW.key_version_ref,i);
 IF NEW.operation='SUBMIT' AND (NEW.profile_id,NEW.profile_sha256,NEW.profile_canonical,NEW.key_version_ref)
  IS DISTINCT FROM(i.initial_profile_id,i.initial_profile_sha256,i.initial_profile_canonical,i.initial_key_version_ref)
 THEN RAISE EXCEPTION 'first payout must use initial profile' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_joinpay_payout_evidence(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_payout_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE i zzsh_order.joinpay_withdrawal_intent;o zzsh_order.joinpay_payout_observation;v jsonb;p jsonb;n jsonb;f jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'payout evidence requires READ COMMITTED' USING ERRCODE='25001';END IF;
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id;
 IF i.id IS NOT NULL THEN
  PERFORM id FROM zzsh_auth_user."user" WHERE id=i.user_id FOR UPDATE;
  PERFORM user_id FROM zzsh_order.wallet_revision WHERE user_id=i.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payout original revision missing' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id FOR UPDATE;
 END IF;
 SELECT * INTO o FROM zzsh_order.joinpay_payout_observation WHERE id=NEW.observation_id AND intent_id=i.id;
 IF i.id IS NULL OR i.requires_review OR i.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE')
  OR i.funds_disposition<>'RESERVED' OR o.id IS NULL OR o.created_xid<>pg_current_xact_id() OR o.operation IS DISTINCT FROM NEW.operation
  OR o.event<>'PENDING_TERMINAL' OR o.evidence_level<>'PROVIDER_RESPONSE' OR NOT o.response_complete OR o.transport_failure IS NOT NULL
  OR(o.operation='QUERY' AND o.http_status IS DISTINCT FROM 200) OR(o.operation='NOTIFY' AND o.http_status IS NOT NULL)
  OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
 THEN RAISE EXCEPTION 'payout evidence lacks same transaction complete raw' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_payout_profile(o.profile_canonical,NEW.operation,o.profile_id,o.key_version_ref,i);
 p:=o.profile_canonical::jsonb;n:=p#>'{feePolicy,unpaidGuarantee}';v:=zzsh_order.joinpay_payout_raw_data(o);f:=NEW.facts_canonical::jsonb;
 IF (v->>'userNo' IS DISTINCT FROM i.user_no OR v->>'tradeMerchantNo' IS DISTINCT FROM i.trade_merchant_no
  OR v->>'merchantOrderNo' IS DISTINCT FROM i.merchant_order_no OR v->>'receiverAccountNoEnc' IS DISTINCT FROM i.receiver_account_no_enc
  OR v->>'receiverNameEnc' IS DISTINCT FROM i.receiver_name_enc OR v->>'platformSerialNo' IS DISTINCT FROM NEW.platform_serial_no
  OR v->>'paidAmount'!~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$' OR (v->>'paidAmount')::numeric*100 IS DISTINCT FROM i.net_cents
  OR v->>'fee' IS DISTINCT FROM NEW.provider_fee_raw OR NEW.provider_fee_cents IS DISTINCT FROM NEW.provider_fee_raw::numeric*100
  OR NEW.provider_fee_cents>(p#>>'{feePolicy,maxProviderFeeCents}')::numeric
  OR(i.platform_serial_no IS NOT NULL AND NEW.platform_serial_no IS DISTINCT FROM i.platform_serial_no)
  OR f IS DISTINCT FROM jsonb_build_object('evidenceId',NEW.id,'intentId',i.id,'userId',i.user_id,'merchantIdentityId',i.merchant_identity_id,
   'merchantOrderNo',i.merchant_order_no,'platformSerialNo',NEW.platform_serial_no,'terminal',NEW.terminal,'grossCents',i.gross_cents::text,
   'netCents',i.net_cents::text,'feeCents',i.fee_cents::text,'currency','CNY','targetFingerprint',i.target_fingerprint,
   'providerFeeRaw',NEW.provider_fee_raw,'providerFeeCents',NEW.provider_fee_cents::text,'sourceObservationId',o.id)) IS NOT FALSE
 THEN RAISE EXCEPTION 'payout evidence differs from exact original amount/target/fee/raw' USING ERRCODE='23514';END IF;
 IF NEW.terminal='PAID' THEN
  IF v->>'status' IS DISTINCT FROM '205' OR COALESCE(v->>'errorCode','')<>''
  THEN RAISE EXCEPTION 'payout paid fact not an exact205' USING ERRCODE='23514';END IF;
 ELSE
  IF (v->>'status' NOT IN('204','208') OR n->>'reference' IS NULL OR n->>'sha256'!~'^[a-f0-9]{64}$'
   OR n->>'transferredCents' IS DISTINCT FROM '0' OR n->>'chargedUserFeeCents' IS DISTINCT FROM '0'
   OR n->>'requiredProviderFeeCents' IS DISTINCT FROM '0' OR n->>'paidAmountMeaning' IS DISTINCT FROM 'REQUESTED_NET'
   OR NEW.provider_fee_cents<>0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(n->'statuses') status WHERE status=v->>'status')) IS NOT FALSE
  THEN RAISE EXCEPTION 'payout failure lacks reviewed zero-execution/fee guarantee' USING ERRCODE='23514';END IF;
 END IF;
 IF o.operation='QUERY' AND((i.lease_version,i.lease_owner) IS DISTINCT FROM(o.lease_version,o.lease_owner)
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'payout evidence lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:joinpay-payout-serial:v1',i.merchant_identity_id,NEW.platform_serial_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.joinpay_withdrawal_intent other WHERE other.id<>i.id AND other.merchant_identity_id=i.merchant_identity_id
  AND other.platform_serial_no=NEW.platform_serial_no)
 THEN RAISE EXCEPTION 'payout serial belongs to another original intent' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_payout_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_payout_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;a zzsh_order.joinpay_payout_attempt;current_lease boolean;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'payout observation requires READ COMMITTED' USING ERRCODE='25001';END IF;
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id;
 IF i.id IS NOT NULL THEN
  PERFORM id FROM zzsh_auth_user."user" WHERE id=i.user_id FOR UPDATE;
  PERFORM user_id FROM zzsh_order.wallet_revision WHERE user_id=i.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payout observation original revision missing' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id FOR UPDATE;
 END IF;
 IF i.id IS NULL OR NEW.state_before IS DISTINCT FROM i.state THEN RAISE EXCEPTION 'payout observation original state differs' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_payout_profile(NEW.profile_canonical,CASE WHEN NEW.operation='SUBMIT' THEN 'SUBMIT' ELSE NEW.operation END,NEW.profile_id,NEW.key_version_ref,i);
 IF NEW.operation<>'NOTIFY' THEN
  SELECT * INTO a FROM zzsh_order.joinpay_payout_attempt WHERE id=NEW.attempt_id AND intent_id=i.id;
  IF a.id IS NULL OR (a.operation,a.lease_version,a.lease_owner,a.profile_id,a.profile_canonical,a.profile_sha256,a.key_version_ref)
   IS DISTINCT FROM(NEW.operation,NEW.lease_version,NEW.lease_owner,NEW.profile_id,NEW.profile_canonical,NEW.profile_sha256,NEW.key_version_ref)
  THEN RAISE EXCEPTION 'payout observation differs from original attempt' USING ERRCODE='23514';END IF;
  current_lease:=(i.lease_version,i.lease_owner) IS NOT DISTINCT FROM(a.lease_version,a.lease_owner) AND i.lease_until IS NOT NULL AND i.lease_until>clock_timestamp();
  IF NEW.event='STALE' THEN
   IF current_lease OR NEW.state_after IS DISTINCT FROM i.state THEN RAISE EXCEPTION 'stale payout cannot change state' USING ERRCODE='23514';END IF;
  ELSIF NOT current_lease THEN RAISE EXCEPTION 'payout result lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
 ELSIF NEW.event='STALE' THEN RAISE EXCEPTION 'payout notification has no worker lease' USING ERRCODE='23514';END IF;
 IF NEW.event IN('PENDING_TERMINAL','TERMINAL') AND(NEW.state_before<>NEW.state_after OR NEW.operation='SUBMIT'
  OR i.requires_review OR NEW.evidence_level<>'PROVIDER_RESPONSE' OR NOT NEW.response_complete OR NEW.transport_failure IS NOT NULL
  OR(NEW.operation='QUERY' AND NEW.http_status IS DISTINCT FROM 200) OR NEW.schema_status<>'VALID' OR NEW.signature_status<>'MATCH' OR NEW.binding_status<>'MATCH')
 THEN RAISE EXCEPTION 'payout terminal observation not complete verified raw' USING ERRCODE='23514';END IF;
 IF(NEW.evidence_level='SYNTHETIC_PROTOCOL' AND(NEW.event IN('REVIEW','PENDING_TERMINAL','TERMINAL') OR NEW.state_after IS DISTINCT FROM NEW.state_before))
  OR((i.requires_review OR i.state IN('SUCCEEDED','FAILED')) AND NEW.state_after IS DISTINCT FROM i.state)
 THEN RAISE EXCEPTION 'synthetic/quarantined payout cannot promote or change terminal' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_joinpay_refund_attempt(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_refund_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR(NEW.operation='SUBMIT' AND i.requires_review)
  OR i.state NOT IN('SUBMITTING','UNKNOWN') OR i.budget_disposition<>'ALLOCATED'
  OR(NEW.operation='SUBMIT' AND NEW.admission_sha256<>i.initial_admission_sha256)
  OR NEW.operation IS DISTINCT FROM (CASE WHEN i.lease_version=1 AND i.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END)
 THEN RAISE EXCEPTION 'refund attempt original binding missing' USING ERRCODE='23514';END IF;
 IF NEW.lease_version<>i.lease_version OR NEW.lease_owner<>i.lease_owner OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'refund attempt lease is stale' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
 IF NEW.operation='SUBMIT' AND(NEW.profile_id<>i.initial_profile_id OR NEW.profile_sha256<>i.initial_profile_sha256
  OR NEW.key_version_ref<>i.initial_key_version_ref)
 THEN RAISE EXCEPTION 'first refund submit must use original profile' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_refund_profile(NEW.profile_canonical,NEW.operation,NEW.profile_id,NEW.key_version_ref,i);
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_joinpay_refund_evidence(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_refund_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE i zzsh_order.channel_refund_intent;o zzsh_order.joinpay_refund_observation;f jsonb;p jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',i.merchant_identity_id,i.original_payment_trx_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
  PERFORM user_id FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'native refund original revision absent' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 END IF;
 SELECT * INTO o FROM zzsh_order.joinpay_refund_observation WHERE id=NEW.observation_id AND intent_id=i.id;
 f:=NEW.facts_canonical::jsonb;
 p:=o.profile_canonical::jsonb;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR i.initial_admission_ref IS NULL
  OR i.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR i.requires_review OR i.budget_disposition<>'ALLOCATED'
  OR o.id IS NULL OR o.created_xid<>pg_current_xact_id() OR o.operation<>NEW.operation OR o.operation='SUBMIT'
  OR o.event<>'PENDING_TERMINAL' OR o.evidence_level<>'PROVIDER_RESPONSE' OR NOT o.response_complete
  OR(o.operation='QUERY' AND o.http_status IS DISTINCT FROM 200) OR(o.operation='NOTIFY' AND o.http_status IS NOT NULL)
  OR o.transport_failure IS NOT NULL OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
  OR f->>'evidenceId' IS DISTINCT FROM NEW.id OR f->>'intentId' IS DISTINCT FROM i.id OR f->>'postingId' IS DISTINCT FROM i.posting_id
  OR f->>'orderId' IS DISTINCT FROM i.order_id OR f->>'paymentConfirmationId' IS DISTINCT FROM i.payment_confirmation_id
  OR f->>'renterUserId' IS DISTINCT FROM i.renter_user_id OR f->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id
  OR f->>'originalPaymentTrxNo' IS DISTINCT FROM i.original_payment_trx_no OR f->>'originalPaymentOrderNo' IS DISTINCT FROM i.original_payment_order_no
  OR f->>'responsibilityVersionHash' IS DISTINCT FROM i.responsibility_version_hash OR f->>'refundOrderNo' IS DISTINCT FROM i.refund_order_no
  OR f->>'amountCents' IS DISTINCT FROM i.amount_cents::text OR f->>'currency' IS DISTINCT FROM 'CNY'
  OR f->>'terminal' IS DISTINCT FROM NEW.terminal OR f->>'refundTransactionNo' IS DISTINCT FROM NEW.refund_transaction_no
  OR(f->>'completedAt')::timestamptz IS DISTINCT FROM NEW.completed_at OR f->>'sourceObservationId' IS DISTINCT FROM o.id
 THEN RAISE EXCEPTION 'refund terminal evidence differs from immutable raw binding' USING ERRCODE='23514';END IF;
 IF NEW.terminal='SUCCEEDED' AND(NEW.completed_at_raw!~'^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
  OR NEW.completed_at IS DISTINCT FROM(NEW.completed_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>(p#>>'{rules,utcOffsetMinutes}')::integer))
 THEN RAISE EXCEPTION 'refund completion time differs from reviewed timezone' USING ERRCODE='23514';END IF;
 IF NEW.terminal='FAILED_NO_EXECUTION' AND((p#>>'{rules,failureNoExecution,accepted}' IS DISTINCT FROM 'true'
  OR p#>>'{rules,failureNoExecution,reference}' IS NULL OR p#>>'{rules,failureNoExecution,sha256}'!~'^[a-f0-9]{64}$'
  OR jsonb_array_length(p#>'{rules,failureNoExecution,codes}')=0) IS NOT FALSE)
 THEN RAISE EXCEPTION 'refund failure has no reviewed no-execution semantics' USING ERRCODE='23514';END IF;
 IF o.operation='QUERY' AND(i.lease_version IS DISTINCT FROM o.lease_version OR i.lease_owner IS DISTINCT FROM o.lease_owner
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'refund terminal evidence lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
 IF NEW.refund_transaction_no IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-transaction:v1','JOINPAY',i.merchant_identity_id,NEW.refund_transaction_no)::text,0));
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent other WHERE other.payment_source='JOINPAY' AND other.id<>i.id
    AND other.merchant_identity_id=i.merchant_identity_id AND other.provider_refund_trx_no=NEW.refund_transaction_no)
  THEN RAISE EXCEPTION 'refund transaction already consumed by another intent' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_refund_intent(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE b record;paid_allocated numeric;responsibility_allocated numeric;proof zzsh_order.joinpay_refund_evidence;
 origin zzsh_order.joinpay_refund_observation;doc jsonb;basis_row record;lr zzsh_order.finance_economic_root;
 le zzsh_order.finance_event;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund allocation immutable' USING ERRCODE='40001';END IF;
 IF NEW.payment_source<>'JOINPAY' OR NEW.evidence_level<>'JOINPAY_FORMAL' THEN RAISE EXCEPTION 'formal refund source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   OR NEW.revision<>OLD.revision+1 OR(OLD.requires_review AND NOT NEW.requires_review)
  THEN RAISE EXCEPTION 'formal refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR OLD.requires_review OR NOT NEW.requires_review
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'formal refund terminal cannot change' USING ERRCODE='40001';END IF;
  ELSIF NOT OLD.requires_review AND NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'refund conflict requires its original review observation' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
   SELECT * INTO proof FROM zzsh_order.joinpay_refund_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
   SELECT * INTO origin FROM zzsh_order.joinpay_refund_observation WHERE id=proof.observation_id;
   IF origin.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM origin.lease_version OR OLD.lease_owner IS DISTINCT FROM origin.lease_owner
    OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
   THEN RAISE EXCEPTION 'refund terminal lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
   IF OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR OLD.requires_review OR NEW.requires_review
    OR proof.id IS NULL OR proof.created_xid<>pg_current_xact_id()
    OR NEW.state IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END)
    OR NEW.budget_disposition IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'CONSUMED' ELSE 'RELEASED' END)
    OR NEW.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no OR NEW.completed_at IS DISTINCT FROM proof.completed_at
    OR NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal refund terminal lacks same transaction proof' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_version=OLD.lease_version+1 THEN
   IF (OLD.state='READY' AND OLD.requires_review) OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR OLD.due_at>clock_timestamp()
    OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL OR NEW.lease_until<=clock_timestamp()
    OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
    OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END)
    OR NEW.budget_disposition<>'ALLOCATED'
   THEN RAISE EXCEPTION 'formal refund lease not claimable' USING ERRCODE='40001';END IF;
   IF OLD.state='READY' AND EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_source='JOINPAY'
    AND x.merchant_identity_id=OLD.merchant_identity_id AND x.original_payment_trx_no=OLD.original_payment_trx_no AND x.requires_review)
   THEN RAISE EXCEPTION 'original payment refund submit requires review' USING ERRCODE='23514';END IF;
  ELSE
   IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.budget_disposition<>'ALLOCATED' OR NEW.state NOT IN('UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.created_xid=pg_current_xact_id()
      AND x.state_before=OLD.state AND x.state_after=NEW.state AND x.event IN('UNKNOWN','PROCESSING','REVIEW')
      AND(x.operation='NOTIFY' OR(x.lease_version=OLD.lease_version AND x.lease_owner=OLD.lease_owner AND OLD.lease_until>clock_timestamp())))
   THEN RAISE EXCEPTION 'formal refund update lacks live evidence' USING ERRCODE='40001';END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 doc:=NEW.initial_admission_canonical::jsonb;
 IF (doc->>'kind' IS DISTINCT FROM 'FORMAL_NATIVE_REFUND_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.initial_admission_ref
  OR doc->>'reviewSha256'!~'^[a-f0-9]{64}$' OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM NEW.merchant_identity_id OR doc->>'merchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=NEW.initial_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=NEW.initial_key_version_ref)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='NOTIFY')) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund initial server admission resource/profile mismatch' USING ERRCODE='23514';END IF;
 IF NEW.basis_kind='PRESTART_TERMINATION' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  IF NEW.posting_id IS NOT NULL OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 OR NEW.amount_cents>9999999999999999
   OR NEW.state<>'READY' OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.revision<>1 OR NEW.requires_review OR NEW.budget_disposition<>'ALLOCATED'
   OR NEW.terminal_evidence_id IS NOT NULL OR NEW.terminal_root_id IS NOT NULL OR NEW.terminal_event_id IS NOT NULL
   OR NEW.provider_refund_trx_no IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
    JOIN zzsh_order.payment_confirmation c ON c.id=t.payment_basis->>'paymentConfirmationId'
    JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=c.joinpay_request_id
    WHERE t.state='APPROVED' AND t.order_id=NEW.order_id AND c.id=NEW.payment_confirmation_id
     AND t.payment_basis->>'source'='JOINPAY' AND zzsh_order.prestart_liability_complete(t.id)
     AND NEW.renter_user_id=t.payment_basis->>'renterUserId' AND NEW.merchant_identity_id=c.merchant_scope_id
     AND NEW.original_payment_trx_no=c.provider_transaction_id AND NEW.original_payment_order_no=c.merchant_order_no
     AND NEW.amount_cents=c.amount_cents AND NEW.wire_merchant_no=bnd.wire_merchant_no AND NEW.due_at=t.approved_at
     AND NEW.responsibility_version_hash=t.basis_digest AND NEW.liability_root_id=t.liability_root_id AND NEW.liability_event_id=t.liability_event_id)
   OR(SELECT count(DISTINCT c.provider_transaction_id) FROM zzsh_order.payment_confirmation c
    WHERE c.source='JOINPAY' AND c.merchant_scope_id=NEW.merchant_identity_id AND c.merchant_order_no=NEW.original_payment_order_no
      AND c.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
   OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY'
     AND i.merchant_identity_id=NEW.merchant_identity_id AND i.original_payment_trx_no=NEW.original_payment_trx_no
     AND(i.requires_review OR i.budget_disposition<>'RELEASED'))
  THEN RAISE EXCEPTION 'prestart refund requires full unique original liability' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF NEW.basis_kind='REVIEW_CONFIRMATION' THEN
  IF NEW.posting_id IS NOT NULL OR NEW.liability_root_id IS NULL OR NEW.liability_event_id IS NULL
   OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 THEN
   RAISE EXCEPTION 'abnormal refund basis shape differs' USING ERRCODE='23514';
  END IF;
  SELECT c0.order_id,c0.source,c0.disposition,c0.reason_code,c0.currency,c0.amount_cents,c0.merchant_scope_id,
         c0.provider_transaction_id,c0.merchant_order_no,c0.joinpay_request_id,c0.joinpay_evidence_id,c0.joinpay_anchor_id,o.renter_user_id,
         rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
         rq.channel_order_no AS request_order_no,rq.amount_cents AS request_amount_cents,rq.currency AS request_currency,
         bnd.wire_merchant_no AS binding_wire_merchant_no,bnd.formal_admission_ref AS formal_admission_ref,
         ev.event AS evidence_event,ev.channel_trx_no AS evidence_trx,ev.schema_outcome AS evidence_schema,
         ev.signature_outcome AS evidence_signature,ev.binding_outcome AS evidence_binding,ev.raw_sha256 AS evidence_raw_sha256,
         an.channel AS anchor_channel,an.evidence_level AS anchor_evidence_level,an.native_order_id AS anchor_order,
         an.request_id AS anchor_request,an.merchant_identity_id AS anchor_merchant,an.channel_trx_no AS anchor_trx
    INTO basis_row
    FROM zzsh_order.payment_confirmation c0
    JOIN zzsh_order.rental_order o ON o.id=c0.order_id
    LEFT JOIN zzsh_order.payment_request rq ON rq.id=c0.joinpay_request_id AND rq.order_id=c0.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=rq.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence ev ON ev.id=c0.joinpay_evidence_id AND ev.request_id=c0.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction an ON an.id=c0.joinpay_anchor_id
   WHERE c0.id=NEW.payment_confirmation_id AND c0.order_id=NEW.order_id;
  IF NOT FOUND
   OR basis_row.source IS DISTINCT FROM 'JOINPAY' OR basis_row.disposition IS DISTINCT FROM 'REVIEW_REQUIRED'
   OR basis_row.reason_code IS NULL OR basis_row.reason_code NOT IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
   OR basis_row.currency IS DISTINCT FROM 'CNY' OR NEW.currency IS DISTINCT FROM 'CNY'
   OR NEW.amount_cents IS DISTINCT FROM basis_row.amount_cents
   OR NEW.renter_user_id IS DISTINCT FROM basis_row.renter_user_id
   OR NEW.merchant_identity_id IS DISTINCT FROM basis_row.merchant_scope_id
   OR NEW.original_payment_trx_no IS DISTINCT FROM basis_row.provider_transaction_id
   OR NEW.original_payment_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.joinpay_request_id IS NULL OR basis_row.joinpay_evidence_id IS NULL OR basis_row.joinpay_anchor_id IS NULL
   OR basis_row.request_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.request_evidence_level IS DISTINCT FROM 'JOINPAY_CANDIDATE'
   OR basis_row.request_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.request_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.request_amount_cents IS DISTINCT FROM basis_row.amount_cents OR basis_row.request_currency IS DISTINCT FROM 'CNY'
   OR basis_row.formal_admission_ref IS NULL OR basis_row.binding_wire_merchant_no IS DISTINCT FROM NEW.wire_merchant_no
   OR basis_row.evidence_event IS DISTINCT FROM 'E4' OR basis_row.evidence_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR basis_row.evidence_schema IS DISTINCT FROM 'VALID' OR basis_row.evidence_signature IS DISTINCT FROM 'MATCH'
   OR basis_row.evidence_binding IS DISTINCT FROM 'MATCH' OR basis_row.evidence_raw_sha256 IS DISTINCT FROM NEW.responsibility_version_hash
   OR basis_row.anchor_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.anchor_evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
   OR basis_row.anchor_order IS DISTINCT FROM basis_row.order_id OR basis_row.anchor_request IS DISTINCT FROM basis_row.joinpay_request_id
   OR basis_row.anchor_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.anchor_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
      AND p.merchant_scope_id=basis_row.merchant_scope_id AND p.provider_transaction_id=basis_row.provider_transaction_id AND p.disposition='APPLIED')
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=NEW.payment_confirmation_id)
   OR (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
       WHERE p.source='JOINPAY' AND p.merchant_scope_id=basis_row.merchant_scope_id
         AND p.merchant_order_no=basis_row.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NEW.liability_root_id IS DISTINCT FROM 'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(NEW.payment_confirmation_id,'UTF8')),'hex'),1,40)
   OR NEW.liability_event_id IS DISTINCT FROM NEW.liability_root_id||'_recognized'
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
  THEN RAISE EXCEPTION 'abnormal refund review basis differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO lr FROM zzsh_order.finance_economic_root WHERE id=NEW.liability_root_id;
  SELECT * INTO le FROM zzsh_order.finance_event WHERE id=NEW.liability_event_id;
  IF lr.id IS NULL OR le.id IS NULL OR lr.source_kind<>'NATIVE_ABNORMAL_REFUND'
   OR lr.source_type<>'NATIVE' OR lr.source_system<>'zzsh' OR lr.source_entity<>'joinpay_abnormal_refund_liability'
   OR lr.basis_id IS NOT NULL OR lr.policy_version IS NOT NULL OR lr.beneficiary_role<>'RENTER'
   OR lr.source_id IS DISTINCT FROM NEW.payment_confirmation_id OR lr.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR lr.source_digest IS DISTINCT FROM NEW.responsibility_version_hash
   OR le.kind<>'REFUND_LIABILITY_RECOGNIZED' OR le.economic_root_id IS DISTINCT FROM lr.id
   OR le.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id)<>2
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=1
     AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=NEW.amount_cents AND l.credit_cents=0
     AND l.counterparty_user_id IS NULL AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=2
     AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=NEW.amount_cents
     AND l.counterparty_user_id=NEW.renter_user_id AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
  THEN RAISE EXCEPTION 'abnormal refund liability closure differs' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents),0) INTO paid_allocated FROM zzsh_order.channel_refund_intent
   WHERE payment_source='JOINPAY' AND merchant_identity_id=NEW.merchant_identity_id
     AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
  IF paid_allocated+NEW.amount_cents>basis_row.amount_cents THEN
    RAISE EXCEPTION 'abnormal refund exceeds original payment budget' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=NEW.payment_confirmation_id
    AND x.basis_kind='REVIEW_CONFIRMATION' AND x.budget_disposition<>'RELEASED')
  THEN RAISE EXCEPTION 'abnormal refund already active for confirmation' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review OR NEW.due_at IS NULL
  THEN RAISE EXCEPTION 'abnormal refund intent must start unclaimed' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp();
  NEW.updated_at:=NEW.created_at;
  RETURN NEW;
 END IF;
 SELECT p.order_id,p.payment_confirmation_id,p.version_hash,p.refund_due_at,p.renter_refund_cents,o.renter_user_id,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.amount_cents INTO b
  FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
  WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED' AND c.source='JOINPAY'
   AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents
   AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE'
    AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0 AND l.counterparty_user_id=o.renter_user_id);
 IF NOT FOUND OR NEW.order_id IS DISTINCT FROM b.order_id OR NEW.payment_confirmation_id IS DISTINCT FROM b.payment_confirmation_id
  OR NEW.renter_user_id IS DISTINCT FROM b.renter_user_id OR NEW.responsibility_version_hash IS DISTINCT FROM b.version_hash
  OR NEW.merchant_identity_id IS DISTINCT FROM b.merchant_scope_id OR NEW.original_payment_trx_no IS DISTINCT FROM b.provider_transaction_id
  OR NEW.original_payment_order_no IS DISTINCT FROM b.merchant_order_no OR NEW.due_at IS DISTINCT FROM b.refund_due_at
  OR NEW.basis_kind IS DISTINCT FROM 'POSTING' OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
 THEN RAISE EXCEPTION 'formal refund frozen posting basis missing' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY' AND i.merchant_identity_id=NEW.merchant_identity_id
  AND i.original_payment_trx_no=NEW.original_payment_trx_no AND i.requires_review)
 THEN RAISE EXCEPTION 'original payment refund requires review' USING ERRCODE='23514';END IF;
 SELECT COALESCE(sum(amount_cents),0),COALESCE(sum(amount_cents) FILTER(WHERE posting_id=NEW.posting_id),0)
  INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY'
  AND merchant_identity_id=NEW.merchant_identity_id AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
 IF paid_allocated+NEW.amount_cents>b.amount_cents OR responsibility_allocated+NEW.amount_cents>b.renter_refund_cents
  OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review
 THEN RAISE EXCEPTION 'formal refund allocation exceeds exact original liability' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_refund_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_refund_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;a zzsh_order.joinpay_refund_attempt;current_lease boolean;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR NEW.state_before<>i.state
 THEN RAISE EXCEPTION 'refund observation original intent mismatch' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_refund_profile(NEW.profile_canonical,NEW.operation,NEW.profile_id,NEW.key_version_ref,i);
 IF NEW.operation<>'NOTIFY' THEN
  SELECT * INTO a FROM zzsh_order.joinpay_refund_attempt WHERE id=NEW.attempt_id AND intent_id=i.id;
  IF a.id IS NULL OR (a.operation,a.lease_version,a.lease_owner) IS DISTINCT FROM (NEW.operation,NEW.lease_version,NEW.lease_owner)
   OR a.profile_id<>NEW.profile_id OR a.profile_sha256<>NEW.profile_sha256 OR a.profile_canonical<>NEW.profile_canonical
   OR a.key_version_ref<>NEW.key_version_ref
  THEN RAISE EXCEPTION 'refund observation attempt mismatch' USING ERRCODE='23514';END IF;
  current_lease:=i.lease_version=a.lease_version AND i.lease_owner=a.lease_owner AND i.lease_until>clock_timestamp();
  IF NEW.event='STALE' THEN
   IF current_lease OR NEW.state_after<>i.state THEN RAISE EXCEPTION 'refund stale observation cannot change state' USING ERRCODE='23514';END IF;
  ELSIF NOT current_lease THEN
   RAISE EXCEPTION 'refund result lease is stale' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';
  END IF;
 ELSIF NEW.event='STALE' THEN RAISE EXCEPTION 'notification has no worker lease' USING ERRCODE='23514';END IF;
 IF NEW.event IN('PENDING_TERMINAL','TERMINAL') AND(NEW.state_before<>NEW.state_after OR NEW.operation='SUBMIT'
  OR NEW.evidence_level<>'PROVIDER_RESPONSE' OR NOT NEW.response_complete
  OR(NEW.operation='QUERY' AND NEW.http_status IS DISTINCT FROM 200) OR(NEW.operation='NOTIFY' AND NEW.http_status IS NOT NULL) OR NEW.transport_failure IS NOT NULL
  OR NEW.schema_status<>'VALID' OR NEW.signature_status<>'MATCH' OR NEW.binding_status<>'MATCH')
 THEN RAISE EXCEPTION 'refund terminal observation must remain a verified raw observation' USING ERRCODE='23514';END IF;
 IF i.state IN('SUCCEEDED','FAILED') AND NEW.state_after<>i.state
 THEN RAISE EXCEPTION 'late refund observation cannot change terminal' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_joinpay_withdrawal_audit(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;e zzsh_order.joinpay_payout_evidence;a zzsh_order.joinpay_payout_attempt;
 o zzsh_order.joinpay_payout_observation;expected jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.object_id;
 IF i.id IS NULL OR NEW.object_type IS DISTINCT FROM 'joinpay_withdrawal_intent' OR NEW.outcome<>'SUCCESS'
 THEN RAISE EXCEPTION 'withdrawal audit has no original intent' USING ERRCODE='23514';END IF;
 IF NEW.action='joinpay.payout.claimed' THEN
  SELECT * INTO a FROM zzsh_order.joinpay_payout_attempt WHERE id=NEW.details->>'attemptId' AND intent_id=i.id;
  IF NEW.actor_type<>'system' OR a.id IS NULL OR a.created_xid<>pg_current_xact_id()
  THEN RAISE EXCEPTION 'payout claim audit lacks same transaction attempt' USING ERRCODE='23514';END IF;
  expected:=jsonb_build_object('attemptId',a.id,'leaseVersion',a.lease_version::text,'operation',a.operation,'profileSha256',a.profile_sha256,'requestSha256',a.request_sha256);
 ELSIF NEW.action='joinpay.payout.observed' THEN
  SELECT * INTO o FROM zzsh_order.joinpay_payout_observation WHERE id=NEW.details->>'observationId' AND intent_id=i.id;
  IF NEW.actor_type<>'system' OR o.id IS NULL OR o.created_xid<>pg_current_xact_id()
  THEN RAISE EXCEPTION 'payout observed audit lacks same transaction raw' USING ERRCODE='23514';END IF;
  expected:=jsonb_build_object('observationId',o.id,'attemptId',o.attempt_id,'leaseVersion',o.lease_version::text,'operation',o.operation,
   'profileSha256',o.profile_sha256,'event',o.event,'evidenceLevel',o.evidence_level,'rawSha256',o.raw_sha256);
 ELSE
  IF NEW.action='joinpay.withdrawal.reserved' THEN
   IF i.created_xid<>pg_current_xact_id() OR NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM i.user_id OR i.funds_disposition<>'RESERVED'
   THEN RAISE EXCEPTION 'withdrawal reserve audit not original same transaction user' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO e FROM zzsh_order.joinpay_payout_evidence WHERE id=i.terminal_evidence_id AND intent_id=i.id;
   IF e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR NEW.actor_type<>'system'
    OR(NEW.action='joinpay.withdrawal.paid' AND(i.state<>'SUCCEEDED' OR e.terminal<>'PAID'))
    OR(NEW.action='joinpay.withdrawal.released' AND(i.state<>'FAILED' OR e.terminal<>'UNPAID_CONFIRMED'))
   THEN RAISE EXCEPTION 'withdrawal terminal audit lacks same transaction disposition' USING ERRCODE='23514';END IF;
  END IF;
  expected:=jsonb_build_object('frozenDigest',i.frozen_digest,'evidenceId',e.id,'factsDigest',e.facts_digest,
   'fundsDisposition',CASE NEW.action WHEN 'joinpay.withdrawal.reserved' THEN 'RESERVED' WHEN 'joinpay.withdrawal.paid' THEN 'PAYOUT_POSTED' ELSE 'RELEASE_POSTED' END,
   'grossCents',i.gross_cents::text,'netCents',i.net_cents::text,'feeCents',i.fee_cents::text,'currency','CNY','channelArrival','UNKNOWN');
 END IF;
 IF NEW.details IS DISTINCT FROM expected THEN RAISE EXCEPTION 'withdrawal audit differs from exact source/disposition' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_withdrawal_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;e zzsh_order.joinpay_payout_evidence;ev zzsh_order.finance_event;
BEGIN
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.details->>'joinpayWithdrawalIntentId';
 IF i.id IS NULL OR ev.id IS NULL OR ev.created_xid<>pg_current_xact_id() OR ev.economic_root_id IS DISTINCT FROM i.economic_root_id
  OR ev.subject_user_id IS DISTINCT FROM i.user_id OR NEW.posting_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL
 THEN RAISE EXCEPTION 'payout entry original event/intent differs' USING ERRCODE='23514';END IF;
 IF ev.kind<>'JOINPAY_WITHDRAWAL_RESERVED' THEN SELECT * INTO e FROM zzsh_order.joinpay_payout_evidence WHERE intent_id=i.id;END IF;
 IF NEW.details IS DISTINCT FROM jsonb_build_object('joinpayWithdrawalIntentId',i.id,'economicRootId',i.economic_root_id,'policyVersion',i.policy_version,
  'inputDigest',i.frozen_digest,'evidenceId',e.id,'evidenceDigest',e.facts_digest)
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_withdrawal_expected_lines(ev.id) x
   WHERE(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id)
    IS NOT DISTINCT FROM(NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id))
 THEN RAISE EXCEPTION 'payout entry differs from exact original template' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_joinpay_withdrawal_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;r zzsh_order.finance_economic_root;e zzsh_order.joinpay_payout_evidence;rev bigint;suffix text;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE economic_root_id=r.id;
 IF i.id IS NOT NULL THEN PERFORM id FROM zzsh_auth_user."user" WHERE id=i.user_id FOR UPDATE;END IF;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF i.id IS NULL OR r.id IS NULL OR r.source_kind<>'JOINPAY_WITHDRAWAL' OR NEW.subject_user_id IS DISTINCT FROM i.user_id
  OR rev IS NULL OR NEW.expected_ledger_revision IS DISTINCT FROM rev
 THEN RAISE EXCEPTION 'payout event original root/subject/revision differs' USING ERRCODE='23514';END IF;
 IF NEW.kind='JOINPAY_WITHDRAWAL_RESERVED' THEN
  suffix:='_reserve';
  IF i.created_xid<>pg_current_xact_id() OR r.created_xid<>pg_current_xact_id() OR i.state<>'RESERVED'
   OR i.funds_disposition<>'RESERVED' OR NEW.id IS DISTINCT FROM i.reserve_event_id OR NEW.expected_ledger_revision IS DISTINCT FROM i.expected_ledger_revision
  THEN RAISE EXCEPTION 'payout reserve not same transaction creation' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM zzsh_order.joinpay_payout_evidence WHERE intent_id=i.id;
  suffix:=CASE NEW.kind WHEN 'JOINPAY_WITHDRAWAL_PAID' THEN '_paid' ELSE '_release' END;
  IF i.requires_review OR e.id IS NULL OR e.created_xid<>pg_current_xact_id()
   OR (NEW.kind='JOINPAY_WITHDRAWAL_PAID' AND e.terminal<>'PAID') OR (NEW.kind='JOINPAY_WITHDRAWAL_RELEASED' AND e.terminal<>'UNPAID_CONFIRMED')
  THEN RAISE EXCEPTION 'payout terminal event lacks same transaction evidence' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.id IS DISTINCT FROM 'jwd_event_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)||suffix
 THEN RAISE EXCEPTION 'payout event id differs from original intent/action' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_joinpay_withdrawal_intent(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE e zzsh_order.joinpay_payout_evidence;o zzsh_order.joinpay_payout_observation;v jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'withdrawal requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'withdrawal intent immutable' USING ERRCODE='40001';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal original subject missing' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  NEW.accepted_at:=clock_timestamp();NEW.updated_at:=NEW.accepted_at;NEW.created_xid:=pg_current_xact_id();
  IF NEW.state<>'RESERVED' OR NEW.operation_version<>1 OR NEW.funds_disposition<>'RESERVED' OR NEW.lease_version<>0
   OR NEW.requires_review OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR num_nonnulls(NEW.terminal_evidence_id,NEW.terminal_event_id,NEW.platform_serial_no,NEW.provider_fee_raw,NEW.provider_fee_cents)<>0
   OR NEW.payout_key IS DISTINCT FROM 'joinpay-withdrawal-'||encode(sha256(convert_to(NEW.id,'UTF8')),'hex')
   OR NEW.economic_root_id IS DISTINCT FROM 'jwd_root_'||substr(encode(sha256(convert_to(NEW.id,'UTF8')),'hex'),1,40)
   OR NEW.reserve_event_id IS DISTINCT FROM 'jwd_event_'||substr(encode(sha256(convert_to(NEW.id,'UTF8')),'hex'),1,40)||'_reserve'
  THEN RAISE EXCEPTION 'withdrawal initial state/identity invalid' USING ERRCODE='23514';END IF;
  PERFORM zzsh_order.assert_joinpay_withdrawal_admission(NEW,true);RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','operation_version','funds_disposition','lease_version','lease_owner','lease_until','requires_review',
  'terminal_evidence_id','terminal_event_id','platform_serial_no','provider_fee_raw','provider_fee_cents','updated_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','operation_version','funds_disposition','lease_version','lease_owner','lease_until','requires_review',
  'terminal_evidence_id','terminal_event_id','platform_serial_no','provider_fee_raw','provider_fee_cents','updated_at'])
  OR NEW.operation_version<>OLD.operation_version+1 OR(OLD.requires_review AND NOT NEW.requires_review)
  OR(OLD.platform_serial_no IS NOT NULL AND NEW.platform_serial_no IS DISTINCT FROM OLD.platform_serial_no)
 THEN RAISE EXCEPTION 'withdrawal frozen binding/serial/CAS immutable' USING ERRCODE='40001';END IF;
 IF OLD.state IN('SUCCEEDED','FAILED') OR(NOT OLD.requires_review AND NEW.requires_review) THEN
  SELECT * INTO o FROM zzsh_order.joinpay_payout_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
   AND x.evidence_level='PROVIDER_RESPONSE' AND x.schema_status='VALID' AND x.signature_status='MATCH'
   AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state
   ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
  IF (to_jsonb(NEW)-ARRAY['operation_version','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['operation_version','requires_review','updated_at'])
   OR OLD.requires_review OR NOT NEW.requires_review OR o.id IS NULL
  THEN RAISE EXCEPTION 'withdrawal conflict only appends original review' USING ERRCODE='23514';END IF;
 ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
  SELECT * INTO e FROM zzsh_order.joinpay_payout_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
  SELECT * INTO o FROM zzsh_order.joinpay_payout_observation WHERE id=e.observation_id;
  IF OLD.requires_review OR NEW.requires_review OR e.id IS NULL OR e.created_xid<>pg_current_xact_id()
   OR NEW.state IS DISTINCT FROM (CASE e.terminal WHEN 'PAID' THEN 'SUCCEEDED' ELSE 'FAILED' END)
   OR NEW.funds_disposition IS DISTINCT FROM (CASE e.terminal WHEN 'PAID' THEN 'PAYOUT_POSTED' ELSE 'RELEASE_POSTED' END)
   OR NEW.terminal_event_id IS DISTINCT FROM 'jwd_event_'||substr(encode(sha256(convert_to(OLD.id,'UTF8')),'hex'),1,40)||(CASE e.terminal WHEN 'PAID' THEN '_paid' ELSE '_release' END)
   OR NEW.platform_serial_no IS DISTINCT FROM e.platform_serial_no OR NEW.provider_fee_raw IS DISTINCT FROM e.provider_fee_raw
   OR NEW.provider_fee_cents IS DISTINCT FROM e.provider_fee_cents
   OR (NEW.lease_version,NEW.lease_owner,NEW.lease_until) IS DISTINCT FROM(OLD.lease_version,OLD.lease_owner,OLD.lease_until)
  THEN RAISE EXCEPTION 'withdrawal terminal lacks same transaction evidence' USING ERRCODE='23514';END IF;
  IF o.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM o.lease_version OR OLD.lease_owner IS DISTINCT FROM o.lease_owner
   OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'withdrawal terminal lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
 ELSIF NEW.lease_version=OLD.lease_version+1 THEN
  IF OLD.state='RESERVED' THEN PERFORM zzsh_order.assert_joinpay_withdrawal_admission(OLD,false);END IF;
  IF(OLD.state='RESERVED' AND OLD.requires_review) OR NEW.requires_review IS DISTINCT FROM OLD.requires_review
   OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL
   OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
   OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='RESERVED' THEN 'SUBMITTING' WHEN OLD.state='SUBMITTING' THEN 'UNKNOWN' ELSE OLD.state END)
   OR NEW.funds_disposition<>'RESERVED' OR num_nonnulls(NEW.terminal_evidence_id,NEW.terminal_event_id,NEW.provider_fee_raw,NEW.provider_fee_cents)<>0
   OR NEW.platform_serial_no IS DISTINCT FROM OLD.platform_serial_no
  THEN RAISE EXCEPTION 'withdrawal claim changes original funds/binding' USING ERRCODE='40001';END IF;
 ELSE
  IF (NEW.lease_version,NEW.lease_owner,NEW.lease_until) IS DISTINCT FROM(OLD.lease_version,OLD.lease_owner,OLD.lease_until)
   OR NEW.funds_disposition<>'RESERVED' OR num_nonnulls(NEW.terminal_evidence_id,NEW.terminal_event_id,NEW.provider_fee_raw,NEW.provider_fee_cents)<>0
   OR(OLD.requires_review AND NEW.state IS DISTINCT FROM OLD.state)
   OR(OLD.state='CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE' AND NEW.state IS DISTINCT FROM OLD.state)
   OR NEW.state NOT IN('UNKNOWN','PROCESSING','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE')
  THEN RAISE EXCEPTION 'withdrawal nonterminal changes money or quarantined state' USING ERRCODE='23514';END IF;
  SELECT * INTO o FROM zzsh_order.joinpay_payout_observation x WHERE x.intent_id=OLD.id AND x.created_xid=pg_current_xact_id()
   AND x.state_before=OLD.state AND x.state_after=NEW.state AND x.event IN('UNKNOWN','PROCESSING','PENDING_TERMINAL')
   AND(x.operation='NOTIFY' OR(x.lease_version=OLD.lease_version AND x.lease_owner=OLD.lease_owner))
   ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
  IF o.id IS NULL THEN RAISE EXCEPTION 'withdrawal result lacks live original observation' USING ERRCODE='23514';END IF;
  IF o.operation<>'NOTIFY' AND(OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'withdrawal result lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
  IF NEW.platform_serial_no IS DISTINCT FROM OLD.platform_serial_no
   OR(NEW.state='CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE' AND NEW.state IS DISTINCT FROM OLD.state) THEN
   IF o.evidence_level<>'PROVIDER_RESPONSE' OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
    OR o.operation='SUBMIT' OR NOT o.response_complete OR o.transport_failure IS NOT NULL
   THEN RAISE EXCEPTION 'synthetic/incomplete observation cannot bind payout serial' USING ERRCODE='23514';END IF;
   v:=zzsh_order.joinpay_payout_raw_data(o);
   IF (v->>'status' NOT IN('201','202','203','204','205','208','210','211','212','213')
    OR(v->>'status'='205' AND COALESCE(v->>'errorCode','')<>'') OR NEW.platform_serial_no IS NULL
    OR(NEW.state='CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE' AND v->>'status' IS DISTINCT FROM '205')
    OR v->>'platformSerialNo' IS DISTINCT FROM NEW.platform_serial_no OR v->>'userNo' IS DISTINCT FROM OLD.user_no
    OR v->>'tradeMerchantNo' IS DISTINCT FROM OLD.trade_merchant_no OR v->>'merchantOrderNo' IS DISTINCT FROM OLD.merchant_order_no
    OR v->>'receiverAccountNoEnc' IS DISTINCT FROM OLD.receiver_account_no_enc OR v->>'receiverNameEnc' IS DISTINCT FROM OLD.receiver_name_enc
    OR v->>'paidAmount'!~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$' OR(v->>'paidAmount')::numeric*100 IS DISTINCT FROM OLD.net_cents) IS NOT FALSE
   THEN RAISE EXCEPTION 'candidate serial differs from original verified transaction' USING ERRCODE='23514';END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:joinpay-payout-serial:v1',OLD.merchant_identity_id,NEW.platform_serial_no)::text,0));
   IF EXISTS(SELECT 1 FROM zzsh_order.joinpay_withdrawal_intent other WHERE other.id<>OLD.id AND other.merchant_identity_id=OLD.merchant_identity_id AND other.platform_serial_no=NEW.platform_serial_no)
   THEN RAISE EXCEPTION 'candidate payout serial belongs to another intent' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF o.id IS NOT NULL AND o.operation<>'NOTIFY' AND((OLD.lease_version,OLD.lease_owner) IS DISTINCT FROM(o.lease_version,o.lease_owner)
  OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'withdrawal final write lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_payout_live_lease';END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_joinpay_withdrawal_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;
BEGIN
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.source_id;
 IF i.id IS NULL OR i.created_xid<>pg_current_xact_id() OR NEW.id IS DISTINCT FROM i.economic_root_id
  OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'joinpay_withdrawal_intent'
  OR NEW.subject_user_id IS DISTINCT FROM i.user_id OR NEW.beneficiary_role<>'WALLET_HOLDER'
  OR NEW.policy_version IS DISTINCT FROM i.policy_version OR NEW.source_digest IS DISTINCT FROM i.frozen_digest
 THEN RAISE EXCEPTION 'payout root lacks exact new reservation' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_legacy_continuation_head(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_continuation_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
   OR(to_jsonb(NEW)-'superseded_at') IS DISTINCT FROM(to_jsonb(OLD)-'superseded_at')
 THEN RAISE EXCEPTION 'Only a current legacy head may be superseded once' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_legacy_continuation_immutable(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_continuation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Legacy continuation evidence/decision is immutable' USING ERRCODE='23514'; END $$;


--
-- Name: guard_legacy_duty(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_duty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE l zzsh_order.legacy_order_read_snapshot;a zzsh_order.legacy_order_duty_admission;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Legacy duty cannot be deleted' USING ERRCODE='23514'; END IF;
 SELECT * INTO l FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 IF l.id IS NULL OR NEW.source_digest<>l.source_digest
  OR(NEW.kind='RENTER_REFUND' AND NEW.counterparty_user_id<>l.renter_user_id)
  OR(NEW.kind IN('OWNER_CREDIT','DEPOSIT_COMPENSATION') AND NEW.counterparty_user_id IS DISTINCT FROM l.owner_user_id)
 THEN RAISE EXCEPTION 'Legacy duty source or beneficiary mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.admission_id IS NOT NULL THEN
   SELECT * INTO a FROM zzsh_order.legacy_order_duty_admission WHERE id=NEW.admission_id AND order_id=NEW.order_id;
   IF a.id IS NULL OR NEW.kind<>'COMMISSION' OR NEW.source<>'LEGACY_IMPORT' OR l.source_order_status<>4 OR l.source_pay_status<>1
    OR(NEW.id,NEW.source_record_id,NEW.counterparty_user_id,NEW.amount_cents,NEW.level,NEW.ratio,NEW.maturity_at,NEW.source_digest)
     IS DISTINCT FROM(a.duty_id,a.source_record_id,a.counterparty_user_id,a.amount_cents,a.level,a.ratio,a.maturity_at,a.parent_source_digest)
    OR a.source_canonical::jsonb->>'id' IS DISTINCT FROM NEW.source_record_id OR a.source_canonical::jsonb->>'order_id' IS DISTINCT FROM l.legacy_id
    OR a.source_canonical::jsonb->>'status' IS DISTINCT FROM '1' OR(a.source_canonical::jsonb->>'earnings')::numeric*100 IS DISTINCT FROM NEW.amount_cents
    OR(a.source_canonical::jsonb->>'level')::int IS DISTINCT FROM NEW.level OR(a.source_canonical::jsonb->>'ratio')::numeric IS DISTINCT FROM NEW.ratio
    OR(a.time_kind='COMPLETED_AT' AND a.source_time IS DISTINCT FROM l.source_completed_at)
   THEN RAISE EXCEPTION 'Completed commission admission mismatch' USING ERRCODE='23514';END IF;
  ELSIF NEW.kind='COMMISSION' AND NEW.source='LEGACY_IMPORT' AND(l.source_order_status NOT IN(3,8,9) OR NEW.maturity_at IS NOT NULL)
   THEN RAISE EXCEPTION 'In-flight commission starts without maturity; completed commission needs admission' USING ERRCODE='23514';END IF;
  IF NEW.status='SETTLED' THEN
   IF NEW.settled_by IS DISTINCT FROM 'LEGACY_RECORDS' OR l.source_snapshot->>'is_settle' IS DISTINCT FROM '3' OR NEW.amount_cents IS DISTINCT FROM l.deposit_amount_cents
    THEN RAISE EXCEPTION 'Only evidenced historical confiscation imports a terminal legacy duty' USING ERRCODE='23514'; END IF;
  ELSIF NEW.status<>'PENDING' OR NEW.revision<>1 THEN RAISE EXCEPTION 'A new duty starts pending' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status IN('SETTLED','VOID') OR OLD.settled_by='LEGACY_RECORDS' THEN RAISE EXCEPTION 'Legacy terminal duty immutable' USING ERRCODE='23514'; END IF;
 IF(NEW.id,NEW.order_id,NEW.kind,NEW.source_record_id,NEW.counterparty_user_id,NEW.currency,NEW.level,NEW.ratio,NEW.source,NEW.source_status,NEW.source_digest,NEW.continuation_version_id,NEW.admission_id,NEW.created_at)
    IS DISTINCT FROM(OLD.id,OLD.order_id,OLD.kind,OLD.source_record_id,OLD.counterparty_user_id,OLD.currency,OLD.level,OLD.ratio,OLD.source,OLD.source_status,OLD.source_digest,OLD.continuation_version_id,OLD.admission_id,OLD.created_at)
   OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Legacy duty immutable fields or revision invalid' USING ERRCODE='23514'; END IF;
 IF NEW.status='SETTLED' THEN
  IF NEW.settled_by IS DISTINCT FROM 'FINANCE' OR(OLD.kind='COMMISSION' AND OLD.status<>'MATURED') OR(OLD.kind<>'COMMISSION' AND OLD.status<>'PENDING')
   THEN RAISE EXCEPTION 'Legacy duty finance transition invalid' USING ERRCODE='23514'; END IF;
  PERFORM zzsh_order.assert_legacy_duty_finance_transition(OLD,NEW);RETURN NEW;
 END IF;
 IF(NEW.settled_by,NEW.settled_ref_type,NEW.settled_ref_id,NEW.settled_ref_digest) IS DISTINCT FROM(OLD.settled_by,OLD.settled_ref_type,OLD.settled_ref_id,OLD.settled_ref_digest)
  THEN RAISE EXCEPTION 'O cannot bind financial settlement fields' USING ERRCODE='23514'; END IF;
 IF(NEW.amount_cents,NEW.maturity_at) IS DISTINCT FROM(OLD.amount_cents,OLD.maturity_at) AND(OLD.kind<>'COMMISSION' OR OLD.status<>'PENDING' OR NEW.status<>'PENDING')
  THEN RAISE EXCEPTION 'Only pending commission amount/maturity may be revised' USING ERRCODE='23514'; END IF;
 IF NEW.status<>OLD.status AND NOT(
  (OLD.kind='COMMISSION' AND OLD.status='PENDING' AND NEW.status='MATURED' AND OLD.maturity_at IS NOT NULL AND OLD.maturity_at<=clock_timestamp())
  OR(OLD.kind='COMMISSION' AND OLD.status IN('PENDING','MATURED') AND NEW.status='VOID' AND NEW.decision_evidence_ref IS NOT NULL))
  THEN RAISE EXCEPTION 'Legacy duty transition invalid' USING ERRCODE='23514'; END IF;
 IF NEW.status='VOID' AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event audit_evt WHERE audit_evt.id=NEW.decision_evidence_ref AND audit_evt.object_id=NEW.order_id
   AND audit_evt.action='order.legacy.duty.source_fact_reviewed' AND audit_evt.outcome='SUCCESS' AND audit_evt.details->>'sourceRecordId'=NEW.source_record_id
   AND audit_evt.details->>'parentSourceDigest'=NEW.source_digest AND(audit_evt.details->>'sourceStatus'='3' OR audit_evt.details->>'parentCancelledNotPayable'='true'))
  THEN RAISE EXCEPTION 'Commission void lacks reviewed source fact' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_legacy_duty_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_duty_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;e zzsh_order.finance_event;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=NEW.details->>'legacyDutyId';SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR e.kind IS DISTINCT FROM 'LEGACY_DUTY_SETTLED' OR e.economic_root_id IS DISTINCT FROM f.root_id
  OR NEW.finance_event_id IS DISTINCT FROM f.event_id OR f.zero_finalization OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('legacyDutyId',f.duty_id,'legacyOrderId',f.order_id,'legacyOrderNumber',f.funding_canonical::jsonb->>'originalOrderNumber','factsDigest',f.facts_digest)
 THEN RAISE EXCEPTION 'legacy duty entry requires exact positive fact' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;


--
-- Name: guard_legacy_duty_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_duty_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;revision_value bigint;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE event_id=NEW.id;
 SELECT COALESCE(ledger_revision,0) INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR NEW.economic_root_id<>f.root_id OR NEW.subject_user_id<>f.subject_user_id
  OR NEW.expected_ledger_revision IS DISTINCT FROM COALESCE(revision_value,0)
 THEN RAISE EXCEPTION 'legacy duty event is not its current final fact' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_legacy_duty_finance_fact(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_duty_finance_fact() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE d zzsh_order.legacy_order_duty;o zzsh_order.legacy_order_read_snapshot;h zzsh_order.legacy_continuation_version;
 e zzsh_order.legacy_continuation_evidence;a zzsh_order.legacy_order_duty_admission;f jsonb;b jsonb;p jsonb;historical_record jsonb;current_state text;current_net numeric;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_contract WHERE singleton AND enabled AND contract_version='legacy-duty-finance.v1')
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin' OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.actor_id
  OR current_setting('zzsh.session_id',true) IS DISTINCT FROM NEW.session_id OR current_setting('zzsh.request_id',true) IS DISTINCT FROM NEW.request_id
 THEN RAISE EXCEPTION 'legacy finance exact trusted admission required' USING ERRCODE='23514'; END IF;
 PERFORM zzsh_order.assert_legacy_finance_order_lock(NEW.order_id);
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 f:=NEW.facts_canonical::jsonb;b:=f->'basis';p:=NEW.funding_canonical::jsonb;
 IF d.id IS NULL OR o.id IS NULL OR d.order_id IS DISTINCT FROM NEW.order_id OR d.kind IS DISTINCT FROM NEW.kind OR d.counterparty_user_id IS DISTINCT FROM NEW.subject_user_id
  OR d.currency IS DISTINCT FROM NEW.currency OR d.amount_cents IS DISTINCT FROM NEW.amount_cents OR d.revision IS DISTINCT FROM NEW.duty_revision
  OR d.status NOT IN('PENDING','MATURED') OR d.settled_by IS NOT NULL OR d.settled_ref_type IS NOT NULL OR d.settled_ref_id IS NOT NULL OR d.settled_ref_digest IS NOT NULL
  OR o.source_digest IS DISTINCT FROM NEW.parent_source_digest OR f->>'contractVersion' IS DISTINCT FROM 'legacy-duty-finance.v1'
  OR encode(sha256(convert_to(NEW.facts_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.facts_digest
  OR encode(sha256(convert_to(NEW.funding_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.funding_digest OR f->'funding' IS DISTINCT FROM p
  OR b->>'dutyId' IS DISTINCT FROM d.id OR b->>'orderId' IS DISTINCT FROM d.order_id OR b->>'dutyKind' IS DISTINCT FROM d.kind
  OR b->>'subjectId' IS DISTINCT FROM d.counterparty_user_id OR b->>'amountCents' IS DISTINCT FROM d.amount_cents::text OR b->>'currency' IS DISTINCT FROM 'CNY'
  OR b->>'dutyRevision' IS DISTINCT FROM d.revision::text OR b->>'sourceRecordId' IS DISTINCT FROM d.source_record_id
  OR b->>'parentSourceId' IS DISTINCT FROM o.legacy_id OR b->>'continuationVersionId' IS DISTINCT FROM d.continuation_version_id OR b->>'admissionId' IS DISTINCT FROM d.admission_id
  OR NOT COALESCE(f->'duty' @> jsonb_build_object('id',d.id,'orderId',d.order_id,'kind',d.kind,'sourceRecordId',d.source_record_id,'counterpartyUserId',d.counterparty_user_id,
   'amountCents',d.amount_cents::text,'currency',d.currency,'revision',d.revision::text,'status',d.status,'source',d.source,'sourceStatus',d.source_status,
   'continuationVersionId',d.continuation_version_id,'admissionId',d.admission_id,'maturityAt',CASE WHEN d.maturity_at IS NULL THEN NULL ELSE to_char(d.maturity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
   'settledBy',NULL,'settledRefType',NULL,'settledRefId',NULL,'settledRefDigest',NULL),false)
  OR b->>'parentSourceDigest' IS DISTINCT FROM NEW.parent_source_digest OR b->>'sourceRecordDigest' IS DISTINCT FROM NEW.source_record_digest
  OR b->>'basisFactsDigest' IS DISTINCT FROM NEW.basis_facts_digest OR b->>'evidenceDigest' IS DISTINCT FROM NEW.effective_facts_digest
  OR b->>'finalAmountKnown' IS DISTINCT FROM 'true' OR jsonb_typeof(b->'netRefundKnown') IS DISTINCT FROM 'boolean'
  OR NOT COALESCE(b->>'fundsDisposition' IN('AVAILABLE','HELD','CONFISCATED','UNKNOWN'),false)
  OR p->>'dutyId' IS DISTINCT FROM d.id OR p->>'orderId' IS DISTINCT FROM d.order_id OR p->>'kind' IS DISTINCT FROM d.kind
  OR p->>'subjectId' IS DISTINCT FROM d.counterparty_user_id OR p->>'amountCents' IS DISTINCT FROM d.amount_cents::text OR p->>'currency' IS DISTINCT FROM 'CNY'
  OR p->>'originalSourceSystem' IS DISTINCT FROM 'legacy_mysql_restore' OR p->>'originalSourceDigest' IS DISTINCT FROM (CASE WHEN d.kind='COMMISSION' THEN NEW.source_record_digest ELSE NEW.parent_source_digest END)
  OR p->>'finalEvidenceDigest' IS DISTINCT FROM NEW.effective_facts_digest OR p->>'coverageDecision' IS DISTINCT FROM 'NOT_PREVIOUSLY_CREDITED'
  OR p->>'sourceStatus' IS DISTINCT FROM 'CONFIRMED_UNPAID_LIABILITY' OR p->>'coverageEvidenceDigest' IS NULL OR (p->>'coverageEvidenceDigest')!~'^[a-f0-9]{64}$'
  OR p->>'evidenceRef' IS DISTINCT FROM b->>'evidenceId' OR NEW.facts_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(f)
  OR NEW.funding_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(p)
 THEN RAISE EXCEPTION 'legacy duty final source/funding tuple mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO h FROM zzsh_order.legacy_continuation_version WHERE order_id=d.order_id AND superseded_at IS NULL;
 SELECT * INTO e FROM zzsh_order.legacy_continuation_evidence WHERE id=h.result_evidence_id AND order_id=d.order_id;
 IF h.id IS DISTINCT FROM NEW.effective_head_id OR h.revision IS DISTINCT FROM NEW.effective_head_revision
  OR b->>'effectiveHeadId' IS DISTINCT FROM h.id OR b->>'effectiveHeadRevision' IS DISTINCT FROM h.revision::text
  OR h.id IS NOT NULL AND(e.id IS NULL OR e.facts_digest IS DISTINCT FROM NEW.effective_facts_digest
   OR e.facts_digest IS DISTINCT FROM encode(sha256(convert_to(e.facts_canonical,'UTF8')),'hex'))
  OR (b->>'sourceTime') IS NULL OR (b->>'sourceTime')::timestamptz>clock_timestamp()
 THEN RAISE EXCEPTION 'current head/time changed under common lock' USING ERRCODE='23514'; END IF;
 current_state:=CASE WHEN h.id IS NULL THEN o.source_snapshot->>'is_settle' ELSE e.facts#>>'{evidence,source,isSettle}' END;
 IF b->>'fundsDisposition' IS DISTINCT FROM (CASE current_state WHEN '0' THEN 'AVAILABLE' WHEN '2' THEN 'HELD' WHEN '3' THEN 'CONFISCATED' ELSE 'UNKNOWN' END)
 THEN RAISE EXCEPTION 'current funds disposition source mismatch' USING ERRCODE='23514'; END IF;
 IF d.kind='COMMISSION' AND(d.status<>'MATURED' OR d.maturity_at IS NULL OR d.maturity_at>clock_timestamp()
  OR d.maturity_at IS DISTINCT FROM (b->>'maturityAt')::timestamptz) THEN RAISE EXCEPTION 'commission not matured' USING ERRCODE='23514'; END IF;
 IF d.kind='RENTER_REFUND' AND(b->>'fundsDisposition' IS DISTINCT FROM 'AVAILABLE' OR b->>'netRefundKnown' IS DISTINCT FROM 'true' OR b->>'currentNetRefundCents' IS DISTINCT FROM d.amount_cents::text)
  OR d.kind='DEPOSIT_COMPENSATION' AND b->>'fundsDisposition' IS DISTINCT FROM 'CONFISCATED'
 THEN RAISE EXCEPTION 'current funds disposition not payable' USING ERRCODE='23514'; END IF;
 IF b->>'kind'='COMPLETED_COMMISSION_ADMISSION' THEN
  SELECT * INTO a FROM zzsh_order.legacy_order_duty_admission WHERE id=d.admission_id;
  IF d.kind<>'COMMISSION' OR a.id IS NULL OR a.duty_id IS DISTINCT FROM d.id OR a.order_id IS DISTINCT FROM d.order_id
   OR a.amount_cents IS DISTINCT FROM d.amount_cents OR a.currency IS DISTINCT FROM d.currency OR a.counterparty_user_id IS DISTINCT FROM d.counterparty_user_id
   OR a.source_record_digest IS DISTINCT FROM NEW.source_record_digest OR a.admission_digest IS DISTINCT FROM NEW.basis_facts_digest
   OR a.parent_source_digest IS DISTINCT FROM o.source_digest OR a.maturity_at IS DISTINCT FROM d.maturity_at
   OR a.source_record_id IS DISTINCT FROM d.source_record_id OR a.source_time IS DISTINCT FROM (b->>'sourceTime')::timestamptz
   OR a.time_kind IS DISTINCT FROM b->>'sourceTimeKind' OR b->>'evidenceId' IS DISTINCT FROM a.id OR d.continuation_version_id IS NOT NULL
   OR b->>'sourceRecordEntity' IS DISTINCT FROM 'la_distribution_order' OR h.id IS NULL AND NEW.effective_facts_digest IS DISTINCT FROM a.admission_digest
  THEN RAISE EXCEPTION 'completed commission immutable admission mismatch' USING ERRCODE='23514'; END IF;
 ELSIF b->>'kind'='HISTORICAL_UNREFUNDED_ADMISSION' THEN
  IF d.kind<>'RENTER_REFUND' OR d.source<>'LEGACY_IMPORT' OR NOT COALESCE(d.source_status IN('COMPLETED_UNREFUNDED','DETAINED'),false) OR d.admission_id IS NOT NULL OR d.continuation_version_id IS NOT NULL
   OR o.source_order_status IS DISTINCT FROM 4 OR d.counterparty_user_id IS DISTINCT FROM o.renter_user_id OR b->>'sourceRecordEntity' IS DISTINCT FROM 'la_order'
   OR b->>'sourceTimeKind' IS DISTINCT FROM 'SOURCE_COMPLETED_AT' OR (b->>'sourceTime')::timestamptz IS DISTINCT FROM o.source_completed_at
   OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event audit WHERE audit.id=b->>'evidenceId' AND audit.object_id=d.order_id AND audit.action='order.legacy.liability.import'
    AND audit.outcome='SUCCESS' AND audit.details->>'dutyId'=d.id AND audit.details->>'classification'=d.source_status
    AND audit.details->>'parentSourceDigest'=o.source_digest AND audit.details#>>'{settlementRecord,digest}'=NEW.source_record_digest
    AND encode(sha256(convert_to(audit.details#>>'{settlementRecord,canonical}','UTF8')),'hex')=NEW.source_record_digest)
  THEN RAISE EXCEPTION 'historical unpaid refund raw admission missing' USING ERRCODE='23514'; END IF;
  SELECT (audit.details#>>'{settlementRecord,canonical}')::jsonb INTO historical_record FROM zzsh_iam.audit_event audit WHERE audit.id=b->>'evidenceId';
  IF NOT COALESCE(historical_record @> o.source_snapshot,false)
    OR historical_record->>'is_settle' IS DISTINCT FROM (CASE d.source_status WHEN 'DETAINED' THEN '2' WHEN 'COMPLETED_UNREFUNDED' THEN '0' END)
    OR NOT(historical_record?'detain_money') OR historical_record->>'return_order_money' IS NULL
   OR NEW.basis_facts_digest IS DISTINCT FROM NEW.source_record_digest OR h.id IS NULL AND NEW.effective_facts_digest IS DISTINCT FROM NEW.source_record_digest
  THEN RAISE EXCEPTION 'historical refund raw snapshot differs' USING ERRCODE='23514'; END IF;
  current_net:=((historical_record->>'return_order_money')::numeric-GREATEST(COALESCE((historical_record->>'detain_money')::numeric,0),0))*100;
  IF current_net IS DISTINCT FROM d.amount_cents THEN RAISE EXCEPTION 'historical net refund differs' USING ERRCODE='23514'; END IF;
 ELSE
  IF b->>'kind' IS DISTINCT FROM (CASE WHEN d.kind='DEPOSIT_COMPENSATION' THEN 'CONFISCATED_CONTINUATION' ELSE 'CONFIRMED_CONTINUATION' END)
   OR d.admission_id IS NOT NULL OR b->>'sourceTimeKind' IS DISTINCT FROM (CASE WHEN d.kind='DEPOSIT_COMPENSATION' THEN 'DISPOSED_AT' ELSE 'CONFIRMED_AT' END)
   OR b->>'sourceRecordEntity' IS DISTINCT FROM (CASE WHEN d.kind='COMMISSION' THEN 'la_distribution_order' ELSE 'legacy_continuation_version' END)
   OR h.id IS NULL OR h.id IS DISTINCT FROM NEW.effective_head_id OR h.revision IS DISTINCT FROM NEW.effective_head_revision
   OR e.facts_digest IS DISTINCT FROM NEW.effective_facts_digest OR e.facts_digest IS DISTINCT FROM encode(sha256(convert_to(e.facts_canonical,'UTF8')),'hex')
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v JOIN zzsh_order.legacy_continuation_evidence original ON original.id=v.result_evidence_id
    WHERE v.id=d.continuation_version_id AND v.order_id=d.order_id AND original.facts_digest=NEW.basis_facts_digest
    AND v.command=CASE WHEN d.kind='DEPOSIT_COMPENSATION' THEN 'CONFISCATE' ELSE 'CONFIRM' END AND original.id=b->>'evidenceId' AND v.created_at=(b->>'sourceTime')::timestamptz
    AND original.facts_digest=encode(sha256(convert_to(original.facts_canonical,'UTF8')),'hex')
    AND(CASE WHEN d.kind='COMMISSION' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(original.facts->'commissionEvidence') proof
      WHERE proof->>'sourceRecordId'=d.source_record_id AND proof->>'digest'=NEW.source_record_digest AND proof->>'digest'=encode(sha256(convert_to(proof->>'canonical','UTF8')),'hex'))
     ELSE original.facts_digest=NEW.source_record_digest END))
  THEN RAISE EXCEPTION 'current/original confirmed final evidence mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF d.kind='RENTER_REFUND' AND h.id IS NOT NULL THEN
  IF e.facts#>>'{evidence,source,returnOrderMoney}' IS NULL THEN RAISE EXCEPTION 'current refund source unknown' USING ERRCODE='23514'; END IF;
  current_net:=((e.facts#>>'{evidence,source,returnOrderMoney}')::numeric-GREATEST(COALESCE((e.facts#>>'{evidence,source,detainMoney}')::numeric,0),0))*100;
  IF current_net IS DISTINCT FROM d.amount_cents OR e.facts#>>'{amounts,refundNet}' IS NOT NULL AND (e.facts#>>'{amounts,refundNet}')::numeric*100 IS DISTINCT FROM d.amount_cents
  THEN RAISE EXCEPTION 'current head net refund differs' USING ERRCODE='23514'; END IF;
 END IF;
 IF d.kind='COMMISSION' AND(b->>'sourceTimeKind' NOT IN('CONFIRMED_AT','COMPLETED_AT','MATURES_AT')
  OR d.maturity_at IS DISTINCT FROM CASE WHEN b->>'sourceTimeKind'='MATURES_AT' THEN (b->>'sourceTime')::timestamptz ELSE (b->>'sourceTime')::timestamptz+interval '168 hours' END)
 THEN RAISE EXCEPTION 'commission maturity proof mismatch' USING ERRCODE='23514'; END IF;
 PERFORM zzsh_order.assert_legacy_duty_funding(p,d);
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_legacy_duty_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_duty_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE root_id=NEW.id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'LEGACY_CONTINUATION'
  OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'legacy_order_duty' OR NEW.source_id<>f.duty_id OR NEW.subject_user_id<>f.subject_user_id
  OR NEW.source_digest<>f.facts_digest OR NEW.beneficiary_role<>f.kind OR NEW.policy_version IS NOT NULL
 THEN RAISE EXCEPTION 'legacy duty root is not its final fact' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;


--
-- Name: guard_legacy_guarantee_coverage(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_guarantee_coverage() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE doc jsonb;actual_count bigint;actual_digest text;input_digest text;isolated_digest text;all_digest text;unique_sources bigint;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'guarantee source maintenance owner required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 doc:=NEW.input_canonical::jsonb;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
  AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest)
  OR doc->>'userId' IS DISTINCT FROM NEW.user_id OR doc->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id OR doc->>'identityDigest' IS DISTINCT FROM NEW.identity_digest
  OR doc->>'inputSha256' IS DISTINCT FROM NEW.input_sha256 OR (doc->>'cutoff')::timestamptz IS DISTINCT FROM NEW.source_cutoff
  OR (doc->>'sourceCount')::int IS DISTINCT FROM NEW.source_count OR NEW.source_cutoff>clock_timestamp()
  OR NEW.input_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(doc) OR NEW.body_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.input_canonical,'UTF8')),'hex')
  OR jsonb_typeof(doc->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'isolated') IS DISTINCT FROM 'array'
  OR jsonb_array_length(doc->'rows') IS DISTINCT FROM NEW.imported_count OR jsonb_array_length(doc->'isolated') IS DISTINCT FROM NEW.isolated_count
 THEN RAISE EXCEPTION 'guarantee coverage canonical source binding invalid' USING ERRCODE='23514'; END IF;
 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(legacy_account_id||':'||source_digest,chr(10) ORDER BY legacy_account_id COLLATE "C"),''),'UTF8')),'hex')
 INTO actual_count,actual_digest FROM zzsh_order.legacy_owner_guarantee_observation WHERE user_id=NEW.user_id AND source_cutoff=NEW.source_cutoff;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((v#>>'{source,id}')||':'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),chr(10) ORDER BY (v#>>'{source,id}') COLLATE "C"),''),'UTF8')),'hex') INTO input_digest FROM jsonb_array_elements(doc->'rows') v;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((v->>'sourceId')||':'||(v->>'sourceDigest'),chr(10) ORDER BY (v->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO isolated_digest FROM jsonb_array_elements(doc->'isolated') v;
 WITH members AS(SELECT v#>>'{source,id}' AS id,encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex') AS digest FROM jsonb_array_elements(doc->'rows') v
  UNION ALL SELECT v->>'sourceId',v->>'sourceDigest' FROM jsonb_array_elements(doc->'isolated') v)
 SELECT count(DISTINCT id),encode(sha256(convert_to(COALESCE(string_agg(id||':'||digest,chr(10) ORDER BY id COLLATE "C"),''),'UTF8')),'hex') INTO unique_sources,all_digest FROM members;
 IF actual_count<>NEW.imported_count OR actual_digest IS DISTINCT FROM NEW.imported_set_digest OR input_digest IS DISTINCT FROM NEW.imported_set_digest
  OR isolated_digest IS DISTINCT FROM NEW.isolated_set_digest OR all_digest IS DISTINCT FROM NEW.source_set_digest OR unique_sources<>NEW.source_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'isolated') v WHERE NOT COALESCE((v->>'sourceId')~'^[1-9][0-9]{0,23}$',false)
   OR NOT COALESCE((v->>'sourceDigest')~'^[a-f0-9]{64}$',false) OR NOT COALESCE(length(v->>'reason') BETWEEN 1 AND 128,false))
 THEN RAISE EXCEPTION 'guarantee coverage source/target sets do not close' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_legacy_guarantee_observation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_guarantee_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE doc jsonb;s jsonb;p jsonb;n bigint;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'guarantee source maintenance owner required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
  AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest)
 THEN RAISE EXCEPTION 'original guarantee owner identity mismatch' USING ERRCODE='23514'; END IF;
 doc:=NEW.source_canonical::jsonb;s:=doc->'source';
 IF doc->>'userId' IS DISTINCT FROM NEW.user_id OR doc->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id OR doc->>'accountId' IS DISTINCT FROM NEW.account_id
  OR s->>'id' IS DISTINCT FROM NEW.legacy_account_id OR s->>'user_id' IS DISTINCT FROM NEW.legacy_user_id
  OR NEW.source_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
  OR NEW.source_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex') OR NEW.source_cutoff>clock_timestamp()
  OR jsonb_typeof(doc->'payOrders') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'payOrders')>1000
  OR NOT COALESCE(s->>'pay_money'~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false) OR NOT COALESCE(s->>'pay_is' IN('0','1'),false)
  OR s->>'return_is' IS NOT NULL AND s->>'return_is'<>'1'
  OR NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts' AND legacy_id=NEW.legacy_account_id AND account_id=NEW.account_id)
 THEN RAISE EXCEPTION 'guarantee source account/canonical binding invalid' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT v->>'id') INTO n FROM jsonb_array_elements(doc->'payOrders') v;
 IF n<>jsonb_array_length(doc->'payOrders') THEN RAISE EXCEPTION 'duplicate guarantee pay attempt' USING ERRCODE='23514'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(doc->'payOrders') LOOP
  IF p->>'order_type' IS DISTINCT FROM '2' OR p->>'order_id' IS DISTINCT FROM NEW.legacy_account_id OR NOT COALESCE(p->>'id'~'^[1-9][0-9]{0,23}$',false)
   OR NOT COALESCE(p->>'pay_is' IN('0','1'),false) OR NOT COALESCE(p->>'pay_money'~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false)
  THEN RAISE EXCEPTION 'typed guarantee attempt source invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW.imported_at:=clock_timestamp();NEW.created_xid:=pg_current_xact_id();RETURN NEW;
END $_$;


--
-- Name: guard_legacy_order_read_binding(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_order_read_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE party record; field_name text; field_value text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id
    WHERE a.id=NEW.account_id AND a.game_id=NEW.game_id
      AND m.source_system=NEW.source_system AND m.source_entity=NEW.legacy_account_entity
      AND m.legacy_id=NEW.legacy_account_id AND m.source_digest=NEW.legacy_account_source_digest
  ) THEN RAISE EXCEPTION 'Legacy account/game/source binding is invalid' USING ERRCODE='23514'; END IF;
  FOR party IN SELECT * FROM (VALUES
    (NEW.owner_user_id,NEW.legacy_owner_id,NEW.owner_source_digest),
    (NEW.renter_user_id,NEW.legacy_renter_id,NEW.renter_source_digest)
  ) AS p(user_id,legacy_id,source_digest)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM zzsh_iam.user_identity_state i JOIN zzsh_iam.audit_event e ON e.object_id=i.user_id
      WHERE i.user_id=party.user_id AND i.provider='legacy_mysql_restore'
        AND i.provider_reference='la_user:'||party.legacy_id
        AND e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS'
        AND e.details->>'sourceSystem'=NEW.source_system AND e.details->>'sourceEntity'='la_user'
        AND e.details->>'legacyId'=party.legacy_id AND e.details->>'sourceDigest'=party.source_digest
    ) THEN RAISE EXCEPTION 'Legacy party/source binding is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Historical ownership is separate from the account's current owner.
  IF NEW.source_snapshot->>'id' IS DISTINCT FROM NEW.legacy_id
    OR NEW.source_snapshot->>'order_sn' IS DISTINCT FROM NEW.original_order_no
    OR NEW.source_snapshot->>'accounts_id' IS DISTINCT FROM NEW.legacy_account_id
    OR NEW.source_snapshot->>'user_id' IS DISTINCT FROM NEW.legacy_renter_id
    OR NEW.source_snapshot->>'sale_user_id' IS DISTINCT FROM NEW.legacy_owner_id
    OR NEW.source_snapshot->>'order_status' IS DISTINCT FROM NEW.source_order_status::text
    OR NEW.source_snapshot->>'pay_is' IS DISTINCT FROM NEW.source_pay_status::text
  THEN RAISE EXCEPTION 'Legacy source snapshot does not match its binding' USING ERRCODE='23514'; END IF;
  FOREACH field_name IN ARRAY ARRAY['money','goods_money','expend_pay_money','need_pay_money','pay_money','deposit_amount','return_order_money','sale_earnings','commission_money','full_payout_money']
  LOOP
    field_value:=NEW.source_snapshot->>field_name;
    IF field_value IS NOT NULL AND field_value !~ '^-?(0|[1-9][0-9]{0,22})\.[0-9]{2}$'
    THEN RAISE EXCEPTION 'Legacy money shape is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH field_name IN ARRAY ARRAY['awm_bullet_num','level6_bullet_num','level6_helmet_num','level6_armor_num','top_insure_card_num','barrett_bullet_num','coffee_num']
  LOOP
    field_value:=NEW.source_snapshot->>field_name;
    IF field_value IS NOT NULL AND field_value !~ '^(0|[1-9][0-9]{0,23})$'
    THEN RAISE EXCEPTION 'Legacy quantity shape is invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF NEW.due_amount_cents IS DISTINCT FROM (NEW.source_snapshot->>'need_pay_money')::numeric*100
    OR NEW.deposit_amount_cents IS DISTINCT FROM (NEW.source_snapshot->>'deposit_amount')::numeric*100
    OR NEW.recorded_paid_amount_cents IS DISTINCT FROM (CASE WHEN NEW.source_pay_status=1 THEN (NEW.source_snapshot->>'pay_money')::numeric*100 ELSE NULL END)
  THEN RAISE EXCEPTION 'Legacy amount/source binding is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_legacy_source_owner(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_legacy_source_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE needs_owner boolean;owner_name text;
BEGIN
 CASE TG_TABLE_NAME
  WHEN 'legacy_continuation_evidence' THEN needs_owner:=(to_jsonb(NEW)->>'source_kind')='SOURCE_IMPORT';
  WHEN 'legacy_order_duty' THEN needs_owner:=(to_jsonb(NEW)->>'source')='LEGACY_IMPORT';
  WHEN 'legacy_order_duty_admission' THEN needs_owner:=true;
  WHEN 'legacy_inflight_register' THEN needs_owner:=true;
  ELSE RAISE EXCEPTION 'unsupported legacy source admission table' USING ERRCODE='23514';
 END CASE;
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF needs_owner AND current_user IS DISTINCT FROM owner_name THEN
  RAISE EXCEPTION 'legacy source admission requires maintenance table owner' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_manual_close_order(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_manual_close_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status='CANCELLED' AND OLD.cancel_reason='MANUAL_CLOSE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'manually closed order is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE' THEN
    IF OLD.status<>'PAID' OR NEW.cancelled_at IS NULL OR NEW.revision<>OLD.revision+1
      OR (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at)
      OR (to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
         IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      OR NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation c
        WHERE c.id=OLD.paid_confirmation_id AND c.order_id=OLD.id AND c.disposition='APPLIED')
      OR EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.id AND t.state<>'REJECTED')
    THEN
      RAISE EXCEPTION 'manual close requires the original applied payment and no termination' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_native_earning_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_earning_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b zzsh_order.payment_distribution_basis;doc jsonb;
BEGIN
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.source_id;doc:=b.canonical_basis::jsonb;
 IF b.id IS NULL OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'rental_order'
  OR NEW.policy_version IS DISTINCT FROM doc->>'policyVersion' OR NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'roles') role WHERE role->>'role'=NEW.beneficiary_role
    AND role->>'beneficiaryUserId'=NEW.subject_user_id AND role->>'status'='ELIGIBLE')
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.subject_user_id)
 THEN RAISE EXCEPTION 'native earning root lacks original eligible payment role/wallet origin' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_native_invitation_source(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_invitation_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p zzsh_order.distribution_participant;
BEGIN
 IF NEW.source_type='NATIVE_REGISTRATION' THEN
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.native_user_insert_proof WHERE user_id=NEW.child_user_id AND insert_xid=pg_current_xact_id())
  THEN RAISE EXCEPTION 'native relation requires protected original insertion transaction' USING ERRCODE='23514';END IF;
  SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=NEW.child_user_id;
  IF p.source_type IS DISTINCT FROM 'NATIVE_REGISTRATION' OR NEW.source_ref IS DISTINCT FROM p.source_ref OR NEW.source_digest IS DISTINCT FROM p.source_digest
  THEN RAISE EXCEPTION 'native relation has different registration provenance' USING ERRCODE='23514';END IF;
 ELSIF NEW.type='INVITER' AND NEW.source_type='LOCAL_CONTROLLED' THEN
  RAISE EXCEPTION 'self-service cannot overwrite registration inviter' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;


--
-- Name: guard_native_invite_code_proof(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_invite_code_proof() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.source_system<>'zzsh' OR NEW.source_entity<>'auth_user' OR NEW.source_id<>NEW.user_id
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.native_user_insert_proof b
   JOIN zzsh_order.distribution_participant p ON p.user_id=b.user_id
   WHERE b.user_id=NEW.user_id AND b.insert_xid=pg_current_xact_id()
    AND p.source_type='NATIVE_REGISTRATION' AND p.source_digest=NEW.source_digest)
 THEN RAISE EXCEPTION 'native code requires the same protected registration source' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_native_origin_basis(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_origin_basis() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE proof jsonb:=NEW.native_origin_canonical::jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name OR session_user!~'_r$' OR proof->>'schema' IS DISTINCT FROM 'native-wallet-origin.v2' OR proof->>'userId' IS DISTINCT FROM NEW.user_id
  OR (SELECT count(*) FROM jsonb_object_keys(proof))<>4
  OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
   JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
   WHERE u.id=NEW.user_id AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
    AND p.insert_xid=pg_current_xact_id() AND p.insert_xid::text=proof->>'insertionXid' AND NEW.source_cutoff=p.captured_at
    AND s.version::text=proof->>'identityVersion')
  OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=NEW.user_id)
  OR EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'native zero origin requires fresh source/empty financial history' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_native_origin_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_origin_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF b.id IS NULL OR b.source_kind<>'NATIVE_GENESIS' OR b.created_xid<>pg_current_xact_id() OR NEW.source_type<>'NATIVE' OR NEW.subject_user_id<>b.user_id
  OR NEW.source_system<>b.source_system OR NEW.source_entity<>b.source_entity OR NEW.source_id<>b.source_id OR NEW.source_digest<>b.source_digest
  OR NEW.beneficiary_role<>'WALLET_HOLDER' OR NEW.policy_version IS NOT NULL
 THEN RAISE EXCEPTION 'native root not bound to original zero origin' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_native_refund_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_refund_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;ev zzsh_order.finance_event;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.details->>'nativeRefundIntentId';
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR ev.id IS NULL OR ev.kind<>'REFUND_PAID' OR ev.created_xid<>pg_current_xact_id()
  OR ev.economic_root_id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR ev.subject_user_id<>i.renter_user_id OR NEW.source_payment_confirmation_id IS NOT NULL
  OR(i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NOT NULL)
  OR NEW.details IS DISTINCT FROM jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0
    AND NEW.counterparty_user_id=i.renter_user_id)
   OR(NEW.line_no=2 AND NEW.account_code=CASE WHEN i.basis_kind='REVIEW_CONFIRMATION' THEN 'JOINPAY_UNALLOCATED_RECEIPT' ELSE 'PAYOUT_CLEARING' END
    AND NEW.debit_cents=0 AND NEW.credit_cents=i.amount_cents AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'native refund entry differs from original responsibility consumption' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_native_refund_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_refund_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;rev bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=r.source_id;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF r.id IS NULL OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.created_xid<>pg_current_xact_id() OR e.id IS NULL
  OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED' OR i.id IS NULL OR rev IS NULL
  OR NEW.id IS DISTINCT FROM 'native_refund_paid_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR NEW.subject_user_id<>i.renter_user_id OR NEW.expected_ledger_revision IS DISTINCT FROM rev
 THEN RAISE EXCEPTION 'native refund event requires original liability revision' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_native_refund_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_refund_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.source_id;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR NEW.id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'channel_refund_intent'
  OR NEW.subject_user_id<>i.renter_user_id OR NEW.beneficiary_role<>'RENTER' OR NEW.policy_version IS NOT NULL OR NEW.source_digest<>e.facts_digest
 THEN RAISE EXCEPTION 'native refund root requires exact same-transaction terminal evidence' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_native_user_insert_proof(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_native_user_insert_proof() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  OR pg_trigger_depth()<>2 OR NEW.insert_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'protected proof can only be issued by original INSERT trigger' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_observation_admission(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_observation_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_name text;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF current_user<>owner_name OR basis.user_id IS DISTINCT FROM NEW.user_id OR basis.source_system IS DISTINCT FROM NEW.source_system
  OR basis.source_id IS DISTINCT FROM NEW.legacy_user_id OR NEW.source_event_at>basis.source_cutoff OR basis.created_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'observation admission subject/cutoff/opening transaction mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_opening_ack(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_opening_ack() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'opening confirmations are immutable' USING ERRCODE = '40001';
END $$;


--
-- Name: guard_opening_basis(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_opening_basis() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF NEW.source_kind<>'LEGACY_OPENING' THEN RAISE EXCEPTION 'native initialization not enabled in U2' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'opening subject missing' USING ERRCODE='23514'; END IF;
 IF current_user<>owner_name OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated'
  AND outcome='SUCCESS' AND details->>'sourceSystem'=NEW.source_system AND details->>'sourceEntity'=NEW.source_entity
  AND details->>'legacyId'=NEW.source_id AND details->>'sourceDigest'=NEW.identity_source_digest) THEN
  RAISE EXCEPTION 'opening requires maintenance admission and exact identity provenance' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_order_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_order_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order event evidence retained' USING ERRCODE='40001'; END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.team_id,NEW.event_key,NEW.type,NEW.actor,NEW.message_client_id,NEW.message_server_id,
      NEW.sender_account_id,NEW.message_type,NEW.occurred_at,NEW.recorded_at,NEW.raw_body_sha256,NEW.metadata,NEW.related_operation_id) IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.team_id,OLD.event_key,OLD.type,OLD.actor,OLD.message_client_id,OLD.message_server_id,
      OLD.sender_account_id,OLD.message_type,OLD.occurred_at,OLD.recorded_at,OLD.raw_body_sha256,OLD.metadata,OLD.related_operation_id) THEN
    RAISE EXCEPTION 'order event binding is immutable' USING ERRCODE='40001'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.type='message_delivered' AND OLD.status='WAITING_AUTH' AND NEW.status IN ('VERIFIED','REJECTED','VERIFY_REQUIRED')
  ) THEN RAISE EXCEPTION 'invalid order event transition' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_order_member(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_order_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE m zzsh_iam.im_identity_mapping%ROWTYPE; o zzsh_order.rental_order%ROWTYPE; g zzsh_order.im_order_group%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member association retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.order_id,NEW.app_id,NEW.identity_id,NEW.party) IS DISTINCT FROM (OLD.order_id,OLD.app_id,OLD.identity_id,OLD.party)
      OR OLD.state='JOINED') THEN RAISE EXCEPTION 'member binding is immutable' USING ERRCODE='40001'; END IF;
  SELECT * INTO m FROM zzsh_iam.im_identity_mapping WHERE id=NEW.identity_id;
  SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  SELECT * INTO g FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id;
  IF m.app_id IS DISTINCT FROM NEW.app_id OR m.status IS DISTINCT FROM 'READY'
    OR (NEW.party='BUYER' AND (m.realm<>'user' OR m.identity_kind<>'USER' OR m.platform_subject_id<>o.renter_user_id))
    OR (NEW.party='OWNER' AND (m.realm<>'user' OR m.identity_kind<>'USER' OR m.platform_subject_id<>o.owner_user_id))
    OR (NEW.party='STAFF' AND (m.realm<>'admin' OR m.identity_kind<>'ADMIN'
        OR (g.team_state<>'READY' AND m.platform_subject_id<>g.assigned_admin_id))) THEN
    RAISE EXCEPTION 'member identity or order party mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_order_operation(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_order_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operation evidence retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.sent_at IS NOT NULL OR NEW.candidate_team_id IS NOT NULL
      OR NEW.version<>1 OR NEW.attempt_count<>0 THEN
      RAISE EXCEPTION 'invalid operation initial state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.kind,NEW.round,NEW.target_admin_id,NEW.created_at)
       IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.kind,OLD.round,OLD.target_admin_id,OLD.created_at)
    OR OLD.state IN ('SUCCEEDED','CANCELLED')
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.candidate_team_id IS NOT NULL AND NEW.candidate_team_id IS DISTINCT FROM OLD.candidate_team_id)
    OR NEW.version<OLD.version OR (NEW.state='PENDING' AND NEW.sent_at IS NOT NULL) THEN
    RAISE EXCEPTION 'operation evidence is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state='CANCELLED' THEN
      allowed := OLD.kind IN ('ADD_MEMBER','BOT_NOTICE') AND OLD.sent_at IS NULL
        AND OLD.state IN ('PENDING','RUNNING') AND NEW.version=OLD.version+1;
    ELSIF OLD.kind='CREATE' THEN
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('PENDING','NEEDS_REVIEW','SUCCEEDED'))
        OR (OLD.state='NEEDS_REVIEW' AND NEW.state='RUNNING' AND OLD.candidate_team_id IS NOT NULL);
    ELSIF OLD.kind='ADD_MEMBER' THEN
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('PENDING','NEEDS_REVIEW','SUCCEEDED'))
        OR (OLD.state='NEEDS_REVIEW' AND NEW.state='RUNNING' AND OLD.sent_at IS NOT NULL);
    ELSE
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('NEEDS_REVIEW','SUCCEEDED'));
    END IF;
    IF NOT allowed THEN RAISE EXCEPTION 'invalid operation transition' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_order_responsible(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_order_responsible() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.responsible_admin_id IS DISTINCT FROM OLD.responsible_admin_id THEN
    IF OLD.responsible_admin_id IS NULL AND OLD.assigned_admin_id IS NULL
      AND NEW.provision_state='ASSIGNED' AND NEW.responsible_admin_id=NEW.assigned_admin_id THEN
      RETURN NEW;
    END IF;
    IF NEW.responsible_admin_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM zzsh_order.im_order_operation op JOIN zzsh_order.im_order_member mm ON mm.order_id=op.order_id
      JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=op.app_id
       WHERE op.order_id=NEW.order_id AND op.app_id=NEW.app_id AND op.kind='ADD_MEMBER'
         AND op.state='SUCCEEDED' AND op.target_admin_id=NEW.responsible_admin_id
         AND op.candidate_team_id=NEW.team_id AND mm.party='STAFF' AND mm.state='JOINED'
         AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.platform_subject_id=NEW.responsible_admin_id
    ) THEN RAISE EXCEPTION 'responsible change requires a confirmed ADD member' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_payment_distribution_basis(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_payment_distribution_basis() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE payment zzsh_order.payment_confirmation;order_row zzsh_order.rental_order;doc jsonb:=NEW.canonical_basis::jsonb;derived jsonb;payment_source jsonb;estimate_source jsonb;
BEGIN
 SELECT * INTO payment FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 payment_source:=jsonb_build_object('id',payment.id,'order_id',payment.order_id,'source',payment.source,
  'merchant_scope_id',payment.merchant_scope_id,'provider_transaction_id',payment.provider_transaction_id,
  'merchant_order_no',payment.merchant_order_no,'amount_cents',payment.amount_cents::text,'currency',payment.currency,
  'provider_paid_at',to_char(payment.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'accepted_at',to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF payment.id IS NULL OR payment.disposition<>'APPLIED' OR payment.order_id<>NEW.order_id OR order_row.paid_confirmation_id IS DISTINCT FROM payment.id
  OR doc->>'schema' IS DISTINCT FROM 'payment-distribution-basis.v1' OR doc->>'orderId' IS DISTINCT FROM NEW.order_id
  OR doc->>'confirmationId' IS DISTINCT FROM NEW.payment_confirmation_id OR doc->>'admissionId' IS DISTINCT FROM NEW.admission_id
  OR doc->>'admissionRevision' IS DISTINCT FROM NEW.admission_revision::text OR doc->>'gameId' IS DISTINCT FROM order_row.game_id
  OR doc->>'currency' IS DISTINCT FROM order_row.currency OR doc->>'acceptedAt' IS DISTINCT FROM to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 THEN RAISE EXCEPTION 'basis must belong to the same first APPLIED transaction and original order' USING ERRCODE='23514';END IF;
 IF doc->>'paymentDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(payment_source),'UTF8')),'hex')
  OR NEW.canonical_basis IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
 THEN RAISE EXCEPTION 'basis or payment source canonical digest differs' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(doc->'roles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'two frozen roles required' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'roles')<>2 OR (SELECT count(DISTINCT r->>'role') FROM jsonb_array_elements(doc->'roles') r WHERE r->>'role' IN('RENTER_REFERRAL','OWNER_REFERRAL'))<>2
 THEN RAISE EXCEPTION 'basis rental roles are not complete' USING ERRCODE='23514';END IF;
 derived:=zzsh_order.derive_payment_referral_inputs(NEW.order_id);
 IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' OR doc->'accountMode' IS DISTINCT FROM derived->'accountMode'
  OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents' OR doc->'roles' IS DISTINCT FROM derived->'roles'
 THEN RAISE EXCEPTION 'payment basis differs from original policy, role, relation or rounded estimate' USING ERRCODE='23514';END IF;
 IF derived->'estimateBaseCents'='null'::jsonb THEN
  IF doc->'estimateDigest' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'unknown estimate cannot claim a digest' USING ERRCODE='23514';END IF;
 ELSE
  estimate_source:=jsonb_build_object('definition','QUOTE_PLATFORM_FULL_PROFIT_ESTIMATE_V1','quote',order_row.quote_snapshot-'contentHash');
  IF order_row.quote_snapshot?'contentHash' THEN estimate_source:=estimate_source||jsonb_build_object('listingHash',order_row.quote_snapshot->'contentHash');END IF;
  IF doc->>'estimateDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(estimate_source),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'estimate digest differs from immutable original quote' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_payment_fact(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_payment_fact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'payment facts and waiting bindings are immutable' USING ERRCODE = '40001';
END $$;


--
-- Name: guard_payment_request(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_payment_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment request is immutable' USING ERRCODE = '40001';
  END IF;
  IF (NEW.id, NEW.order_id, NEW.channel, NEW.merchant_identity_id, NEW.config_profile_id, NEW.protocol_version,
      NEW.key_version_ref, NEW.platform_order_no, NEW.channel_order_no, NEW.amount_cents, NEW.currency,
      NEW.wire_amount_yuan, NEW.method, NEW.evidence_level, NEW.idempotency_scope_key, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.order_id, OLD.channel, OLD.merchant_identity_id, OLD.config_profile_id, OLD.protocol_version,
      OLD.key_version_ref, OLD.platform_order_no, OLD.channel_order_no, OLD.amount_cents, OLD.currency,
      OLD.wire_amount_yuan, OLD.method, OLD.evidence_level, OLD.idempotency_scope_key, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.created_at) THEN
    RAISE EXCEPTION 'payment request binding is immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.state IN ('ACCEPTED','REVIEW_REQUIRED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'payment request terminal state is immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.lease_version < OLD.lease_version THEN
    RAISE EXCEPTION 'payment request revision/lease must advance' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_payment_request_insert(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_payment_request_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.state <> 'SUBMITTING' OR NEW.revision <> 1 OR NEW.lease_version <> 0 OR NEW.lease_owner IS NOT NULL THEN
    RAISE EXCEPTION 'payment request must start as SUBMITTING' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_personal_order(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  expires_text text;
  personal_schema text;
  personal_doc jsonb;
  declaration_doc jsonb;
  rule_refs_doc jsonb;
  membership_doc jsonb;
  guarantee_doc jsonb;
  funding_doc jsonb;
  growth_doc jsonb;
  binding_doc jsonb;
  key_count integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
      RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v4' THEN
    PERFORM zzsh_order.assert_personal_growth_order_v4(NEW);
    RETURN NEW;
  END IF;

  IF NEW.quote_snapshot->>'quoteKind'='ORDER_CONFIRMATION' THEN
    personal_schema := NEW.quote_snapshot#>>'{personal,schema}';
    IF NEW.confirmation_id IS NULL
      OR NEW.quote_snapshot->>'confirmationId' IS DISTINCT FROM NEW.confirmation_id::text
      OR NEW.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1'
      OR COALESCE(NEW.quote_snapshot->>'confirmationDigest','') !~ '^[0-9a-f]{64}$'
      OR NEW.quote_snapshot->>'listingHash' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM NEW.renter_user_id
      OR (personal_schema IS DISTINCT FROM 'personal-quote-v1' AND personal_schema IS DISTINCT FROM 'personal-quote-v2' AND personal_schema IS DISTINCT FROM 'personal-quote-v3')
      OR jsonb_typeof(NEW.quote_snapshot->'priceVersionId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'ruleReleaseId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'termSeconds') IS DISTINCT FROM 'string'
      OR NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}'
      OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
      OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,tier}','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,version}','') !~ '^[1-9][0-9]{0,18}$'
      OR NEW.quote_snapshot ? 'confirmationToken' OR NEW.quote_snapshot ? 'signature' THEN
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema IN ('personal-quote-v2','personal-quote-v3') THEN
      personal_doc := NEW.quote_snapshot->'personal';
      IF jsonb_typeof(personal_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(personal_doc) AS object_key(key);
      IF (personal_schema='personal-quote-v2' AND key_count <> 11)
        OR (personal_schema='personal-quote-v3' AND key_count <> 12)
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(personal_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY[
            'schema','userId','ownerUserId','accountId','listingVersionId','listingHash',
            'fullPayoutDeclaration','ruleRefs','membership','guarantee','funding','membershipGrowth'
          ]::text[]))
          OR (personal_schema='personal-quote-v2' AND object_key.key='membershipGrowth')
        ) THEN
        RAISE EXCEPTION 'invalid personal quote v2/v3 shape' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(personal_doc->'schema') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'userId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'ownerUserId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'accountId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingHash') IS DISTINCT FROM 'string'
        OR personal_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
        OR personal_doc->>'accountId' IS DISTINCT FROM NEW.account_id
        OR personal_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
        OR personal_doc->>'listingHash' IS DISTINCT FROM NEW.content_hash
        OR personal_doc->>'schema' IS DISTINCT FROM personal_schema
        OR NEW.quote_snapshot ? 'fullPayoutSelected'
        OR NEW.quote_snapshot ? 'fullPayoutFeeCents' THEN
        RAISE EXCEPTION 'personal quote v2/v3 binding is invalid' USING ERRCODE='40001';
      END IF;

      declaration_doc := personal_doc->'fullPayoutDeclaration';
      IF jsonb_typeof(declaration_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(declaration_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(declaration_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['schema','selected']::text[]))
      ) OR declaration_doc->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1'
        OR jsonb_typeof(declaration_doc->'selected') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;

      rule_refs_doc := personal_doc->'ruleRefs';
      IF jsonb_typeof(rule_refs_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(rule_refs_doc) AS object_key(key);
      IF key_count <> 5 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(rule_refs_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest']::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(rule_refs_doc->'releaseId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'priceVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'termVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementDigest') IS DISTINCT FROM 'string'
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'releaseId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'priceVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'termVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'agreementVersionId'),''),'') = ''
        OR COALESCE(rule_refs_doc->>'agreementDigest','') !~ '^[0-9a-f]{64}$'
        OR rule_refs_doc->>'releaseId' IS DISTINCT FROM NEW.rule_release_id
        OR rule_refs_doc->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;

      membership_doc := personal_doc->'membership';
      IF jsonb_typeof(membership_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(membership_doc) AS object_key(key);
      IF key_count <> 3 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(membership_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['tier','version','sourceRef']::text[]))
      ) OR jsonb_typeof(membership_doc->'tier') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR COALESCE(membership_doc->>'tier','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
        OR COALESCE(membership_doc->>'version','') !~ '^[1-9][0-9]{0,18}$'
        OR COALESCE(NULLIF(trim(membership_doc->>'sourceRef'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;

      guarantee_doc := personal_doc->'guarantee';
      IF jsonb_typeof(guarantee_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(guarantee_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(guarantee_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['status','reference']::text[]))
      ) OR jsonb_typeof(guarantee_doc->'status') IS DISTINCT FROM 'string'
        OR jsonb_typeof(guarantee_doc->'reference') IS DISTINCT FROM 'string'
        OR COALESCE(guarantee_doc->>'status','') NOT IN ('SATISFIED','NOT_REQUIRED')
        OR COALESCE(NULLIF(trim(guarantee_doc->>'reference'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;

      funding_doc := personal_doc->'funding';
      IF jsonb_typeof(funding_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(funding_doc) AS object_key(key);
      IF key_count <> 9 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(funding_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY[
          'version','sourceRef','baseDepositCents','publisherBailRequirementCents',
          'fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion','vipWaiver','svipWaiver'
        ]::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(funding_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'baseDepositCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'publisherBailRequirementCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'disclosureVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'vipWaiver') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(funding_doc->'svipWaiver') IS DISTINCT FROM 'boolean'
        OR COALESCE(NULLIF(trim(funding_doc->>'version'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'sourceRef'),''),'') = ''
        OR COALESCE(funding_doc->>'baseDepositCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(funding_doc->>'publisherBailRequirementCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyRef'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyVersion'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'disclosureVersion'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;

      IF personal_schema='personal-quote-v3' THEN
        growth_doc := personal_doc->'membershipGrowth';
        IF jsonb_typeof(growth_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(growth_doc) AS object_key(key);
        IF key_count <> 6 OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(growth_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY['schema','policyVersion','selectedSource','entitlementIds','binding','depositSource']::text[]))
        ) OR growth_doc->>'schema' IS DISTINCT FROM 'membership-growth-v1'
          OR COALESCE(NULLIF(trim(growth_doc->>'policyVersion'),''),'') = ''
          OR COALESCE(growth_doc->>'selectedSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE')
          OR COALESCE(growth_doc->>'depositSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE','UNKNOWN')
          OR jsonb_typeof(growth_doc->'entitlementIds') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(growth_doc->'entitlementIds') AS entitlement(value) WHERE jsonb_typeof(entitlement.value) IS DISTINCT FROM 'string') THEN
          RAISE EXCEPTION 'personal quote v3 entitlement references are invalid' USING ERRCODE='40001';
        END IF;
        binding_doc := growth_doc->'binding';
        IF jsonb_typeof(binding_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(binding_doc) AS object_key(key);
        IF key_count <> 6
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(binding_doc) AS object_key(key)
                     WHERE NOT (object_key.key = ANY (ARRAY['userId','accountId','ownerUserId','listingVersionId','ruleReleaseId','quantityDigest']::text[])))
          OR binding_doc->>'userId' IS DISTINCT FROM NEW.renter_user_id
          OR binding_doc->>'accountId' IS DISTINCT FROM NEW.account_id
          OR binding_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
          OR binding_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
          OR binding_doc->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
          OR COALESCE(binding_doc->>'quantityDigest','') !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
      END IF;

      -- The normalized quote is at quote_snapshot root in the real producer.
      IF NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM rule_refs_doc->>'priceVersionId'
        OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
        OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text THEN
        RAISE EXCEPTION 'personal quote v2/v3 quote binding is invalid' USING ERRCODE='40001';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM zzsh_supply.listing_version v
         WHERE v.id=NEW.listing_version_id
           AND v.account_id=NEW.account_id
           AND v.content_hash=NEW.content_hash
           AND v.rule_release_id=NEW.rule_release_id
           AND v.payload->>'accountId' IS NOT DISTINCT FROM NEW.account_id
           AND v.payload->>'gameId' IS NOT DISTINCT FROM NEW.game_id
           AND v.payload#>>'{ruleRefs,releaseId}' IS NOT DISTINCT FROM rule_refs_doc->>'releaseId'
           AND v.payload#>>'{ruleRefs,priceVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'priceVersionId'
           AND v.payload#>>'{ruleRefs,termVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'termVersionId'
           AND v.payload#>>'{ruleRefs,agreementVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementVersionId'
           AND v.payload#>>'{ruleRefs,agreementDigest}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementDigest'
           AND v.payload#>>'{quoteValues,priceVersionId}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
           AND v.payload#>>'{quoteValues,termSeconds}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'termSeconds'
           AND v.payload#>'{declaration,attributes,full_payout_declaration}' IS NOT DISTINCT FROM declaration_doc
      ) THEN
        RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
      END IF;
    ELSIF personal_schema='personal-quote-v1' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema='personal-quote-v1' AND NOT EXISTS(
      SELECT 1 FROM zzsh_supply.listing_version v
       WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id
         AND v.content_hash=NEW.content_hash AND v.rule_release_id=NEW.rule_release_id
    ) THEN
      RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
    END IF;
    expires_text:=NEW.quote_snapshot->>'confirmationExpiresAt';
    IF expires_text IS NULL OR expires_text !~ '^[1-9][0-9]{0,11}$' THEN
      RAISE EXCEPTION 'invalid confirmation expiry' USING ERRCODE='40001';
    END IF;
    IF extract(epoch FROM clock_timestamp()) >= expires_text::numeric THEN
      RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';
    END IF;
  ELSIF NEW.confirmation_id IS NOT NULL OR NEW.quote_snapshot ? 'quoteKind' OR NEW.quote_snapshot->>'schemaVersion'='2' THEN
    RAISE EXCEPTION 'personal quote requires confirmation consumption' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_prestart_liability_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_liability_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE t zzsh_order.prestart_termination;r zzsh_order.finance_economic_root;e zzsh_order.finance_event;amount numeric;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.details->>'prestartTerminationId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=e.economic_root_id;
 amount:=(t.payment_basis->>'amountCents')::numeric;
 IF t.id IS NULL OR r.id IS NULL OR e.id IS NULL OR r.source_kind<>'NATIVE_PRESTART_REFUND' OR r.source_id<>t.id
  OR t.approved_xid IS DISTINCT FROM pg_current_xact_id() OR e.created_xid IS DISTINCT FROM pg_current_xact_id()
  OR e.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.posting_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('prestartTerminationId',t.id,'basisDigest',t.basis_digest,
    'paymentConfirmationId',t.payment_basis->>'paymentConfirmationId','dataOrigin',CASE t.payment_basis->>'source' WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
  OR NOT((NEW.line_no=1 AND NEW.account_code='CAPTURED_PAYMENT_SOURCE' AND NEW.debit_cents=amount AND NEW.credit_cents=0
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id=t.payment_basis->>'paymentConfirmationId')
    OR(NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=amount
      AND NEW.counterparty_user_id=t.payment_basis->>'renterUserId' AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'prestart liability entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_prestart_liability_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_liability_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.finance_economic_root;t zzsh_order.prestart_termination;rev bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 IF r.source_kind IS DISTINCT FROM 'NATIVE_PRESTART_REFUND' THEN RETURN NEW;END IF;
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=r.source_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=r.subject_user_id;
 IF t.id IS NULL OR t.approved_xid IS DISTINCT FROM pg_current_xact_id() OR r.created_xid IS DISTINCT FROM pg_current_xact_id()
  OR NEW.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.subject_user_id IS DISTINCT FROM r.subject_user_id
  OR NEW.expected_ledger_revision IS DISTINCT FROM rev OR rev IS NULL
  OR NEW.id IS DISTINCT FROM 'prestart_liability_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability event/revision differs' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_prestart_liability_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_liability_root() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.source_id;
 IF t.id IS NULL OR t.state<>'APPROVED' OR t.approved_xid IS DISTINCT FROM pg_current_xact_id()
  OR NOT(CASE WHEN t.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(t.payment_basis)
    ELSE zzsh_order.prestart_payment_basis_valid(t.payment_basis) END)
  OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh'
  OR NEW.source_entity<>'prestart_termination' OR NEW.basis_id IS NOT NULL
  OR NEW.policy_version IS DISTINCT FROM(CASE WHEN t.requested_by_party='SUPPORT' THEN 'support-full-refund.v1' ELSE 'prestart-full-refund.v1' END)
  OR NEW.subject_user_id IS DISTINCT FROM t.payment_basis->>'renterUserId' OR NEW.beneficiary_role<>'RENTER' OR NEW.source_digest<>t.basis_digest
  OR NEW.id IS DISTINCT FROM 'prestart_refund_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability root differs' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(t.payment_basis->>'renterUserId',0,0) ON CONFLICT(user_id) DO NOTHING;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_prestart_opening(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_opening() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE order_value text;
BEGIN
 IF TG_TABLE_NAME='rental_opening' THEN order_value:=NEW.order_id;
 ELSE SELECT order_id INTO order_value FROM zzsh_order.rental_opening WHERE id=NEW.opening_id;END IF;
 PERFORM id FROM zzsh_order.rental_order WHERE id=order_value FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.prestart_termination WHERE order_id=order_value AND state<>'REJECTED')
 THEN RAISE EXCEPTION 'prestart termination pending; resolve before opening' USING ERRCODE='40001',CONSTRAINT='prestart_no_opening_while_requested';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_prestart_order_cancel(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_order_cancel() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.status='CANCELLED' AND NEW.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND') THEN
  IF OLD.status<>'PAID' OR NEW.paid_confirmation_id IS DISTINCT FROM OLD.paid_confirmation_id OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
   OR NEW.revision<>OLD.revision+1 OR NEW.cancelled_at IS NULL
   OR(to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.id AND t.state='APPROVED'
     AND t.approved_xid=pg_current_xact_id()
     AND((NEW.cancel_reason='PRESTART_TERMINATED' AND t.requested_by_party<>'SUPPORT')
       OR(NEW.cancel_reason='SUPPORT_CANCELLED_REFUND' AND t.requested_by_party='SUPPORT'))
     AND(CASE WHEN t.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(t.payment_basis)
       ELSE zzsh_order.prestart_payment_basis_valid(t.payment_basis) END)
     AND t.liability_root_id IS NOT NULL AND t.liability_event_id IS NOT NULL)
  THEN RAISE EXCEPTION 'prestart cancellation requires same-transaction approved liability' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_prestart_termination(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_termination() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE o zzsh_order.rental_order;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'prestart request is retained' USING ERRCODE='40001';END IF;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 IF o.id IS NULL OR NEW.basis_digest IS DISTINCT FROM NEW.payment_basis->>'digest'
  OR NEW.payment_basis->>'orderId' IS DISTINCT FROM NEW.order_id
 THEN RAISE EXCEPTION 'prestart original basis differs' USING ERRCODE='23514';END IF;
 IF NEW.requested_by_party IN('RENTER','OWNER') THEN
  IF NEW.requested_by_user_id IS DISTINCT FROM (CASE NEW.requested_by_party WHEN 'RENTER' THEN o.renter_user_id ELSE o.owner_user_id END)
   OR NEW.requested_by_admin_user_id IS NOT NULL
  THEN RAISE EXCEPTION 'prestart original party differs' USING ERRCODE='23514';END IF;
 ELSIF NEW.requested_by_party='SUPPORT' THEN
  IF NEW.requested_by_user_id IS NOT NULL OR NEW.requested_by_admin_user_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin."user" u WHERE u.id=NEW.requested_by_admin_user_id)
  THEN RAISE EXCEPTION 'support cancellation actor missing' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'prestart party unsupported' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'REQUESTED' OR NEW.revision<>1 OR o.status<>'PAID' OR NEW.last_reason IS NOT NULL
   OR NEW.approved_at IS NOT NULL OR NEW.approved_xid IS NOT NULL OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
   OR NOT(CASE WHEN NEW.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(NEW.payment_basis)
     ELSE zzsh_order.prestart_payment_basis_valid(NEW.payment_basis) END)
  THEN RAISE EXCEPTION 'prestart request is ineligible' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','revision','last_reason','approved_at','approved_xid','liability_root_id','liability_event_id','updated_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','last_reason','approved_at','approved_xid','liability_root_id','liability_event_id','updated_at'])
 THEN RAISE EXCEPTION 'prestart frozen request immutable' USING ERRCODE='40001';END IF;
 IF OLD.state='APPROVED' THEN
  IF OLD.approved_xid IS DISTINCT FROM pg_current_xact_id() OR OLD.liability_root_id IS NOT NULL OR OLD.liability_event_id IS NOT NULL
    OR NEW.liability_root_id IS NULL OR NEW.liability_event_id IS NULL
    OR(to_jsonb(NEW)-ARRAY['liability_root_id','liability_event_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['liability_root_id','liability_event_id'])
  THEN RAISE EXCEPTION 'approved prestart request immutable' USING ERRCODE='40001';END IF;
  RETURN NEW;
 END IF;
 IF OLD.state='REJECTED' OR NEW.state NOT IN('REVIEW_REQUIRED','REJECTED','APPROVED') OR NEW.revision<>OLD.revision+1
  OR NEW.last_reason IS NULL OR length(btrim(NEW.last_reason))<3 OR octet_length(NEW.last_reason)>600
  OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL OR o.status<>'PAID'
 THEN RAISE EXCEPTION 'invalid prestart review transition' USING ERRCODE='40001';END IF;
 IF NEW.state='APPROVED' THEN
  IF NOT(CASE WHEN NEW.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(NEW.payment_basis)
    ELSE zzsh_order.prestart_payment_basis_valid(NEW.payment_basis) END)
  THEN RAISE EXCEPTION 'prestart use/payment changed' USING ERRCODE='23514';END IF;
  NEW.approved_at:=clock_timestamp();NEW.approved_xid:=pg_current_xact_id();
 ELSE NEW.approved_at:=NULL;NEW.approved_xid:=NULL;END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_prestart_termination_decision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_prestart_termination_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.termination_id;
 IF t.id IS NULL OR t.revision<>NEW.result_revision OR t.last_reason IS DISTINCT FROM NEW.reason
   OR t.state<>(CASE NEW.decision WHEN 'APPROVE' THEN 'APPROVED' WHEN 'REJECT' THEN 'REJECTED' ELSE 'REVIEW_REQUIRED' END)
   OR NEW.decision='APPROVE' AND ((t.requested_by_party='SUPPORT' AND NEW.assessment<>'SUPPORT_FULL_REFUND')
     OR(t.requested_by_party<>'SUPPORT' AND NEW.assessment<>'NO_USE_NO_DISPUTE'))
   OR NEW.decision<>'APPROVE' AND NEW.assessment IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.session_id AND s."userId"=NEW.admin_user_id AND s."expiresAt">clock_timestamp())
 THEN RAISE EXCEPTION 'prestart decision original differs' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_referral_reversal_declaration(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_referral_reversal_declaration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.rental_referral_earning;a zzsh_order.distribution_order_admission;owner_name text;expected_scope text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=r.order_id;
 expected_scope:=CASE WHEN a.mode='NATIVE' THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END;
 IF current_user<>owner_name OR r.id IS NULL OR a.id IS NULL OR NEW.scope<>expected_scope
  OR NEW.approval_digest IS DISTINCT FROM a.approval_digest OR NEW.basis_digest IS DISTINCT FROM r.basis_digest
  OR NEW.amount_cents IS DISTINCT FROM r.amount_cents OR a.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR a.resource_name<>current_database()
 THEN RAISE EXCEPTION 'reversal declaration requires exact maintenance admission and original earning' USING ERRCODE='23514';END IF;
 NEW.declared_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_referral_transition_source(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_referral_transition_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE r zzsh_order.rental_referral_earning;e zzsh_order.finance_event;s zzsh_order.rental_referral_reversal_source;expected_kind text;expected_digest text;
BEGIN
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 IF r.id IS NULL OR NEW.result_version IS DISTINCT FROM r.version
 THEN RAISE EXCEPTION 'transition receipt must describe its exact accepted version' USING ERRCODE='23514';END IF;
 IF NEW.action='ACCRUE' THEN expected_kind:='EARNING_PENDING';expected_digest:=r.posting_digest;
 ELSIF NEW.action='SETTLE' THEN expected_kind:='EARNING_SETTLED';expected_digest:=r.seed_digest;
 ELSE
  SELECT * INTO s FROM zzsh_order.rental_referral_reversal_source WHERE id=NEW.reversal_source_id;
  IF s.id IS NULL OR s.earning_id<>r.id OR s.basis_digest<>r.basis_digest OR s.amount_cents<>r.amount_cents
  THEN RAISE EXCEPTION 'transition reversal source does not belong to the original earning' USING ERRCODE='23514';END IF;
  expected_kind:='EARNING_REVOKED';expected_digest:=s.source_digest;
 END IF;
 IF NEW.source_digest IS DISTINCT FROM expected_digest
 THEN RAISE EXCEPTION 'transition receipt source digest differs from original evidence' USING ERRCODE='23514';END IF;
 IF NEW.finance_event_id IS NULL THEN
  IF NEW.action<>'REVOKE' OR r.state<>'RECOVERY_REQUIRED' OR r.funds_disposition<>'SETTLED'
   OR r.recovery_required_cents IS DISTINCT FROM r.amount_cents OR r.amount_cents<=0
  THEN RAISE EXCEPTION 'only an original outstanding reversal may have no financial event' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  IF e.id IS NULL OR e.economic_root_id<>r.economic_root_id OR e.subject_user_id<>r.beneficiary_user_id
   OR e.kind<>expected_kind OR e.created_xid<>pg_current_xact_id()
   OR NEW.action='ACCRUE' AND r.state<>'PENDING'
   OR NEW.action='SETTLE' AND r.state<>'SETTLED'
   OR NEW.action IN('REVOKE','RECOVER') AND r.state<>'REVOKED'
  THEN RAISE EXCEPTION 'transition receipt financial event is not the exact accepted action' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;


--
-- Name: guard_rental_opening(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_rental_opening() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opening versions are immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'CONFIRMED' OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.quote_digest IS DISTINCT FROM OLD.quote_digest OR NEW.payment_digest IS DISTINCT FROM OLD.payment_digest
     OR NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'confirmed opening lines are immutable' USING ERRCODE = '40001';
  END IF;
  IF NOT (OLD.status = 'DRAFT' AND NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'opening can only move from draft to confirmed' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_rental_order(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_rental_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  snap_currency text;
  snap_deposit_policy text;
  snap_rental text;
  snap_deposit text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_PAYMENT' THEN
      RAISE EXCEPTION 'rental order must start as PENDING_PAYMENT' USING ERRCODE = '40001';
    END IF;
    snap_currency := NEW.quote_snapshot ->> 'currency';
    snap_deposit_policy := NEW.quote_snapshot #>> '{pricingInputs,depositPolicy}';
    snap_rental := NEW.quote_snapshot #>> '{resourceTotal,amount}';
    snap_deposit := NEW.quote_snapshot #>> '{tenantDeposit,amount}';
    IF snap_currency IS DISTINCT FROM 'CNY' OR NEW.currency <> 'CNY' THEN
      RAISE EXCEPTION 'rental order snapshot currency is not CNY' USING ERRCODE = '40001';
    END IF;
    IF snap_deposit_policy IS DISTINCT FROM 'CONFIGURED' THEN
      RAISE EXCEPTION 'rental order snapshot deposit policy is not CONFIGURED' USING ERRCODE = '40001';
    END IF;
    IF snap_rental IS NULL OR snap_deposit IS NULL
       OR snap_rental !~ '^(0|[1-9]\d*)\.\d{2}$' OR snap_deposit !~ '^(0|[1-9]\d*)\.\d{2}$' THEN
      RAISE EXCEPTION 'rental order snapshot amounts are incomplete' USING ERRCODE = '40001';
    END IF;
    IF NEW.rental_amount_cents <> CAST(replace(snap_rental, '.', '') AS numeric)
       OR NEW.deposit_amount_cents <> CAST(replace(snap_deposit, '.', '') AS numeric) THEN
      RAISE EXCEPTION 'rental order amounts do not match the snapshot' USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.display_no, NEW.account_id, NEW.listing_version_id, NEW.owner_user_id,
      NEW.renter_user_id, NEW.game_id, NEW.rule_release_id, NEW.content_hash, NEW.term_option_code,
      NEW.rental_amount_cents, NEW.deposit_amount_cents, NEW.currency, NEW.term_seconds,
      NEW.quote_snapshot, NEW.title, NEW.hold_until)
     IS DISTINCT FROM
     (OLD.id, OLD.display_no, OLD.account_id, OLD.listing_version_id, OLD.owner_user_id,
      OLD.renter_user_id, OLD.game_id, OLD.rule_release_id, OLD.content_hash, OLD.term_option_code,
      OLD.rental_amount_cents, OLD.deposit_amount_cents, OLD.currency, OLD.term_seconds,
      OLD.quote_snapshot, OLD.title, OLD.hold_until) THEN
    RAISE EXCEPTION 'rental order snapshot is immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated paid order is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='SUPPORT_CANCELLED_REFUND')
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_rental_referral_earning(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_rental_referral_earning() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b zzsh_order.payment_distribution_basis;p zzsh_order.settlement_posting;root zzsh_order.finance_economic_root;doc jsonb;role jsonb;seed jsonb;base numeric;expected numeric;n numeric;d numeric;available numeric;pair_total numeric;pair_role jsonb;
 posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'earning obligation cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.economic_root_id,NEW.economic_key,NEW.order_id,NEW.payment_confirmation_id,NEW.posting_id,NEW.beneficiary_user_id,NEW.beneficiary_role,NEW.amount_cents,NEW.due_at,NEW.basis_digest,NEW.posting_digest,NEW.canonical_seed,NEW.seed_digest,NEW.created_xid,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.economic_root_id,OLD.economic_key,OLD.order_id,OLD.payment_confirmation_id,OLD.posting_id,OLD.beneficiary_user_id,OLD.beneficiary_role,OLD.amount_cents,OLD.due_at,OLD.basis_digest,OLD.posting_digest,OLD.canonical_seed,OLD.seed_digest,OLD.created_xid,OLD.created_at)
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'original earning source/amount/due immutable and next CAS required' USING ERRCODE='40001';END IF;
  IF NOT(OLD.state='PENDING' AND NEW.state IN('SETTLED','REVOKED') OR OLD.state='SETTLED' AND NEW.state IN('REVOKED','RECOVERY_REQUIRED') OR OLD.state='RECOVERY_REQUIRED' AND NEW.state='REVOKED')
  THEN RAISE EXCEPTION 'earning state transition invalid' USING ERRCODE='23514';END IF;
  IF NEW.state='SETTLED' AND clock_timestamp()<OLD.due_at THEN RAISE EXCEPTION 'earning cannot settle before original due' USING ERRCODE='23514';END IF;
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.beneficiary_user_id FOR UPDATE;
  IF NEW.state='RECOVERY_REQUIRED' THEN
   SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
    WHERE counterparty_user_id=NEW.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
   IF available>=OLD.amount_cents OR NEW.recovery_required_cents IS DISTINCT FROM OLD.amount_cents OR NEW.funds_disposition<>'SETTLED'
   THEN RAISE EXCEPTION 'recovery requires actual shortfall and original settled funds' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=NEW.posting_id AND order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;doc:=b.canonical_basis::jsonb;seed:=NEW.canonical_seed::jsonb;
 SELECT value INTO role FROM jsonb_array_elements(doc->'roles') WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF b.id IS NULL OR p.id IS NULL OR root.id IS NULL OR root.created_xid<>pg_current_xact_id() OR root.source_id<>NEW.order_id
  OR root.subject_user_id<>NEW.beneficiary_user_id OR root.beneficiary_role<>NEW.beneficiary_role OR root.source_digest<>NEW.posting_digest
  OR NEW.basis_digest<>b.basis_digest OR role IS NULL OR role->>'status'<>'ELIGIBLE'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND(p.approval_request_id IS NULL OR p.approval_requested_by IS NULL
   OR p.approval_approved_by IS NULL OR p.approval_requested_by=p.approval_approved_by
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
  OR NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.funds_disposition<>'PENDING' OR NEW.recovery_required_cents IS NOT NULL
 THEN RAISE EXCEPTION 'earning must derive from original closed posting/payment role' USING ERRCODE='23514';END IF;
 n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=p.platform_contribution_cents-p.compensation_fee_cents;
 IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'original referral ratio invalid' USING ERRCODE='23514';END IF;
 expected:=floor(base*n/d+0.5);
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 -- Validate the complete frozen pair even when only one earning is being inserted.
 -- Otherwise direct SQL could mint two individually valid shares exceeding the base.
 pair_total:=0;
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') LOOP
  IF pair_role->>'status' LIKE 'UNKNOWN%' THEN RAISE EXCEPTION 'unknown counterpart cannot authorize partial accrual' USING ERRCODE='23514';END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',NEW.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',floor(base*n/d+0.5)::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
   IF pair_role->>'role'=NEW.beneficiary_role AND pair_role->>'beneficiaryUserId'=NEW.beneficiary_user_id THEN own_item:=item;END IF;
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514';END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',NEW.order_id,
  'confirmationId',NEW.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 expected_seed:=jsonb_build_object('id',NEW.id,'economicKey',own_item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order','id',NEW.order_id,
   'digest',posting_hash,'eventAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'beneficiaryUserId',NEW.beneficiary_user_id,'role',NEW.beneficiary_role,'policyVersion',doc->>'policyVersion',
  'policyDigest',doc->>'policyDigest','baseDigest',allocation_hash,'relationDigest',role->>'relationDigest',
  'amountCents',expected::numeric(24,0)::text,'dueAt',due_text,
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(own_item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1');
 IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL
  OR NEW.posting_digest IS DISTINCT FROM posting_hash OR NEW.economic_key IS DISTINCT FROM own_item->>'economicKey'
  OR NEW.id IS DISTINCT FROM 'earning_'||encode(sha256(convert_to(NEW.economic_key,'UTF8')),'hex')
  OR seed IS DISTINCT FROM expected_seed OR NEW.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
 THEN RAISE EXCEPTION 'earning amount/due/seed differs from original frozen derivation' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_settlement_decision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_settlement_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  bound record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement decisions are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT version_hash, basis_hash, superseded_at INTO bound
    FROM zzsh_order.settlement_version WHERE id = NEW.settlement_version_id;
  IF bound IS NULL OR bound.version_hash IS DISTINCT FROM NEW.version_hash
     OR bound.basis_hash IS DISTINCT FROM NEW.basis_hash OR bound.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'settlement decision is not bound to the current version' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zzsh_order.settlement_decision
     WHERE settlement_version_id = NEW.settlement_version_id AND party = NEW.party
       AND action IN ('CONFIRM','REJECT') AND NEW.action IN ('CONFIRM','REJECT') AND action <> NEW.action
  ) THEN
    RAISE EXCEPTION 'settlement party already decided' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_settlement_intake(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_settlement_intake() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement intakes are immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.opening_id IS DISTINCT FROM OLD.opening_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.initiator_party IS DISTINCT FROM OLD.initiator_party
     OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
     OR NEW.lines IS DISTINCT FROM OLD.lines OR NEW.basis_hash IS DISTINCT FROM OLD.basis_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'settlement intake content is immutable' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NOT NULL AND NEW.settlement_version_id IS NULL)
    OR (OLD.status = 'OPEN' AND NEW.status = 'CLASSIFIED' AND NEW.classified_at IS NOT NULL AND NEW.settlement_version_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'settlement intake can only be classified or superseded' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_settlement_ledger_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_settlement_ledger_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  batch record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement ledger entries are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT p.order_id, p.payment_confirmation_id, p.captured_cents,
         o.status, o.owner_user_id, o.renter_user_id
    INTO batch
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.rental_order o ON o.id = p.order_id
   WHERE p.id = NEW.posting_id
   FOR UPDATE OF o;
  IF NOT FOUND OR batch.status IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'settlement posting batch is sealed or not assembling' USING ERRCODE = '40001';
  END IF;
  IF NEW.account_code = 'CAPTURED_PAYMENT_SOURCE' THEN
    IF NEW.debit_cents <> batch.captured_cents OR NEW.credit_cents <> 0
       OR NEW.source_payment_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
       OR NEW.counterparty_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'captured payment source entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'OWNER_AVAILABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.owner_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'owner available entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'RENTER_REFUND_PAYABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.renter_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'renter refund payable entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' THEN
    IF NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'manual adjustment entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'platform contribution entry is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_settlement_posting(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_settlement_posting() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ord record;
  ver record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement postings are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT status, paid_confirmation_id INTO ord FROM zzsh_order.rental_order WHERE id = NEW.order_id FOR UPDATE;
  SELECT kind, early, version_hash, superseded_at INTO ver FROM zzsh_order.settlement_version
    WHERE id = NEW.settlement_version_id AND order_id = NEW.order_id FOR UPDATE;
  IF ord IS NULL OR ord.status <> 'PAID' OR ord.paid_confirmation_id IS DISTINCT FROM NEW.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM NEW.version_hash
     OR ver.early IS DISTINCT FROM NEW.early THEN
    RAISE EXCEPTION 'posting must bind the paid order current settlement and payment' USING ERRCODE = '23514';
  END IF;
  NEW.refund_due_at := NEW.posted_at + CASE WHEN NEW.early THEN interval '168 hours' ELSE interval '0' END;
  RETURN NEW;
END $$;


--
-- Name: guard_settlement_version(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_settlement_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement versions are immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.opening_id IS DISTINCT FROM OLD.opening_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
     OR NEW.early IS DISTINCT FROM OLD.early OR NEW.initiator_party IS DISTINCT FROM OLD.initiator_party
     OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
     OR NEW.basis_hash IS DISTINCT FROM OLD.basis_hash OR NEW.version_hash IS DISTINCT FROM OLD.version_hash
     OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.computation IS DISTINCT FROM OLD.computation
     OR NEW.system_owner_net_cents IS DISTINCT FROM OLD.system_owner_net_cents
     OR NEW.system_renter_refund_cents IS DISTINCT FROM OLD.system_renter_refund_cents
     OR NEW.proposed_owner_net_cents IS DISTINCT FROM OLD.proposed_owner_net_cents
     OR NEW.proposed_renter_refund_cents IS DISTINCT FROM OLD.proposed_renter_refund_cents
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'settlement version content is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_stored_opening_review(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_stored_opening_review() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE b zzsh_order.finance_opening_basis;s jsonb;i jsonb;r jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 s:=NEW.source_canonical::jsonb;i:=NEW.input_canonical::jsonb;r:=NEW.review_canonical::jsonb;
 IF current_user IS DISTINCT FROM owner_name OR b.id IS NULL OR b.source_kind<>'LEGACY_OPENING' OR b.created_xid<>pg_current_xact_id()
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR r#>>'{actor,userId}' IS DISTINCT FROM current_setting('zzsh.actor_id',true)
  OR r#>>'{actor,sessionId}' IS DISTINCT FROM current_setting('zzsh.session_id',true)
  OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
  OR r#>>'{actor,userId}' IS NULL OR r#>>'{actor,sessionId}' IS NULL OR r->>'notBefore' IS NULL OR r->>'expiresAt' IS NULL
  OR r->>'ref' IS NULL OR r->>'attempt' IS NULL OR r->>'inputSha256' IS DISTINCT FROM i->>'inputSha256'
  OR i->>'cutoff' IS DISTINCT FROM r->>'cutoff' OR r->>'observationCount' IS NULL OR r->>'coveredCount' IS NULL
  OR (r->>'notBefore')::timestamptz>=(r->>'expiresAt')::timestamptz
  -- Preserve the exact existing CF1 source-selection digest (JSON.stringify insertion order).
  OR encode(sha256(convert_to('{"id":'||to_jsonb(s->>'id')::text||',"earnings":'||to_jsonb(s->>'earnings')::text||',"money":'||to_jsonb(s->>'money')::text||'}','UTF8')),'hex') IS DISTINCT FROM b.source_digest
  OR encode(sha256(convert_to(NEW.input_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.body_digest
  OR encode(sha256(convert_to(NEW.review_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.review_digest
  OR i->>'sourceCanonical' IS DISTINCT FROM NEW.source_canonical OR r->>'bodyDigest' IS DISTINCT FROM NEW.body_digest
  OR s->>'id' IS DISTINCT FROM b.source_id OR NOT COALESCE((s->>'earnings')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false)
  OR NOT COALESCE((s->>'money')~'^-?(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false) OR (s->>'earnings')::numeric*100 IS DISTINCT FROM b.available_cents
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k NOT IN('id','earnings','money'))
  OR r#>>'{subject,userId}' IS DISTINCT FROM b.user_id OR r#>>'{subject,sourceId}' IS DISTINCT FROM b.source_id
  OR r#>>'{subject,identityDigest}' IS DISTINCT FROM b.identity_source_digest OR r#>>'{subject,sourceDigest}' IS DISTINCT FROM b.source_digest
  OR r#>>'{subject,availableCents}' IS DISTINCT FROM b.available_cents::text OR r#>>'{subject,coveredDigest}' IS DISTINCT FROM b.covered_set_digest
  OR (r->>'coveredCount')::int IS DISTINCT FROM b.covered_count OR (r->>'cutoff')::timestamptz IS DISTINCT FROM b.source_cutoff
  OR (r->>'observationCount')::int NOT BETWEEN 0 AND 10000 OR b.covered_count>5000
  OR i->'proof' IS DISTINCT FROM jsonb_build_object('userId',b.user_id,'source',jsonb_build_object('sourceSystem',b.source_system,'sourceEntity',b.source_entity,'sourceId',b.source_id,'identityDigest',b.identity_source_digest),'availableCents',b.available_cents::text,'sourceDigest',b.source_digest,'coveredCount',b.covered_count,'coveredDigest',b.covered_set_digest,'coveredSet',i#>'{proof,coveredSet}')
  OR jsonb_typeof(i->'admissions') IS DISTINCT FROM 'array' OR jsonb_typeof(i->'observations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(i->'admissions') IS DISTINCT FROM (r->>'observationCount')::int
  OR jsonb_array_length(i->'observations') IS DISTINCT FROM (r->>'observationCount')::int
  OR (r->>'notBefore')::timestamptz>clock_timestamp() OR (r->>'expiresAt')::timestamptz<=clock_timestamp()
  OR b.source_cutoff>(r->>'notBefore')::timestamptz
 THEN RAISE EXCEPTION 'stored opening exact source/review/actor mismatch' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $_$;


--
-- Name: guard_stored_opening_source_proof(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_stored_opening_source_proof() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE b zzsh_order.finance_opening_basis;i jsonb;r jsonb;p jsonb;s jsonb;binding jsonb;obs jsonb;raw_log jsonb;root_source jsonb;
 raw_obs json;matched jsonb;original jsonb;extended jsonb;withdrawal jsonb;value_id text;counted bigint;amount numeric;
BEGIN
 i:=NEW.input_canonical::jsonb;r:=NEW.review_canonical::jsonb;p:=i->'sourceProof';
 IF NOT(i?'sourceProof') THEN
  IF r?'sourceProofDigest' THEN RAISE EXCEPTION 'unbound source proof digest' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF b.id IS NULL OR b.created_xid<>pg_current_xact_id() OR p->>'schema' IS DISTINCT FROM 'legacy-finance-source-proof.v1'
  OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'logBindings') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p->'supplementalLogs') IS DISTINCT FROM 'array'
  OR r->>'sourceProofDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(p),'UTF8')),'hex')
  OR jsonb_array_length(p->'sources')>5000 OR jsonb_array_length(p->'logBindings')>10000 OR jsonb_array_length(p->'supplementalLogs')>10000
  OR jsonb_array_length(p->'sources')<>b.covered_count
  OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v WHERE v->>'kind'='earningsLog' AND v->>'referenceType'='UNRESOLVED_ECONOMIC_SOURCE')<>jsonb_array_length(p->'logBindings')
 THEN RAISE EXCEPTION 'source proof schema/digest/bounds differ' USING ERRCODE='23514';END IF;
 IF(SELECT count(DISTINCT v->>'observationId') FROM jsonb_array_elements(p->'logBindings') v)<>jsonb_array_length(p->'logBindings')
  OR(SELECT count(DISTINCT v->>'observationId') FROM jsonb_array_elements(p->'supplementalLogs') v)<>jsonb_array_length(p->'supplementalLogs')
 THEN RAISE EXCEPTION 'duplicate original observation binding' USING ERRCODE='23514';END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
  original:=(s->>'sourceCanonical')::jsonb;
  IF NOT(s?&ARRAY['sourceKind','sourceEntity','sourceId','beneficiaryRole','sourceEventAt','sourceCanonical','sourceDigest'])
    OR (s->>'sourceId'~'^[1-9][0-9]{0,23}$') IS NOT TRUE OR(s->>'sourceDigest'~'^[a-f0-9]{64}$') IS NOT TRUE
    OR s->>'sourceDigest' IS DISTINCT FROM encode(sha256(convert_to(s->>'sourceCanonical','UTF8')),'hex')
    OR s->>'sourceId' IS DISTINCT FROM original->>'id'
    OR (s->>'sourceEventAt'~'^[1-9][0-9]{0,9}$') IS NOT TRUE OR to_timestamp((s->>'sourceEventAt')::bigint)>b.source_cutoff
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i#>'{proof,coveredSet}') v WHERE v=jsonb_build_array(
      b.user_id,s->>'sourceKind','LEGACY_MYSQL',s->>'sourceEntity',s->>'sourceId',s->>'beneficiaryRole',s->>'sourceEventAt',s->>'sourceDigest'))
    OR(s->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION') AND
      (SELECT count(*) FROM jsonb_array_elements(p->'logBindings') x WHERE x->>'sourceKind'=s->>'sourceKind'
       AND x->>'sourceEntity'=s->>'sourceEntity' AND x->>'sourceId'=s->>'sourceId' AND x->>'beneficiaryRole'=s->>'beneficiaryRole'
       AND x->>'sourceDigest'=s->>'sourceDigest')<>1)
  THEN RAISE EXCEPTION 'source root is not exact covered set' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR binding IN SELECT value FROM jsonb_array_elements(p->'logBindings') LOOP
  SELECT count(*),jsonb_agg(v::jsonb) INTO counted,matched FROM json_array_elements(NEW.input_canonical::json->'observations') v
   WHERE v::jsonb->>'sourceId'=binding->>'observationId' AND v::jsonb->>'kind'='earningsLog'
    AND v::jsonb->>'referenceType'='UNRESOLVED_ECONOMIC_SOURCE'
    AND encode(sha256(convert_to(zzsh_order.canonical_finance_json(v::jsonb),'UTF8')),'hex')=binding->>'observationDigest';
  IF counted<>1 THEN RAISE EXCEPTION 'binding original observation differs' USING ERRCODE='23514';END IF;
  obs:=matched->0;raw_log:=(obs#>>'{rawSource,canonical}')::jsonb;
  IF NOT(raw_log?&ARRAY['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount'])
   OR(raw_log->>'createdAt'~'^[1-9][0-9]{0,9}$') IS NOT TRUE OR to_timestamp((raw_log->>'createdAt')::bigint)>b.source_cutoff
   OR raw_log->>'id' IS DISTINCT FROM binding->>'observationId' OR raw_log->>'userId' IS DISTINCT FROM b.source_id
   OR obs#>>'{rawSource,digest}' IS DISTINCT FROM encode(sha256(convert_to(obs#>>'{rawSource,canonical}','UTF8')),'hex')
   OR raw_log->>'sourceId' IS DISTINCT FROM obs->>'referenceId' OR raw_log->'amount' IS DISTINCT FROM obs->'amount'
   OR raw_log->'action' IS DISTINCT FROM obs->'action' OR raw_log->'createdAt' IS DISTINCT FROM obs->'createdAt'
   OR raw_log->'changeType' IS DISTINCT FROM obs->'legacyChangeType' OR raw_log->'sn' IS DISTINCT FROM obs->'legacyLogNumber'
   OR raw_log->'leftAmount' IS DISTINCT FROM obs->'leftAmount'
   OR(raw_log->>'amount'~'^(0|[1-9][0-9]{0,21})(\.[0-9]{1,2})?$') IS NOT TRUE
  THEN RAISE EXCEPTION 'original log fields changed' USING ERRCODE='23514';END IF;
  SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'sources') v
   WHERE v->>'sourceKind'=binding->>'sourceKind' AND v->>'sourceEntity'=binding->>'sourceEntity'
    AND v->>'sourceId'=binding->>'sourceId' AND v->>'beneficiaryRole'=binding->>'beneficiaryRole' AND v->>'sourceDigest'=binding->>'sourceDigest';
  IF counted<>1 THEN RAISE EXCEPTION 'binding has no unique reviewed root' USING ERRCODE='23514';END IF;
  root_source:=matched->0;original:=(root_source->>'sourceCanonical')::jsonb;amount:=(raw_log->>'amount')::numeric;
  IF root_source->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG') THEN
   IF root_source->>'sourceId'<>raw_log->>'id' OR root_source->>'sourceCanonical' IS DISTINCT FROM obs#>>'{rawSource,canonical}'
     OR root_source->>'sourceEventAt' IS DISTINCT FROM raw_log->>'createdAt'
   THEN RAISE EXCEPTION 'log root must use its own original id/time' USING ERRCODE='23514';END IF;
  END IF;
  IF root_source->>'sourceKind'='LEGACY_WITHDRAWAL_RETURN' THEN
   SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'sources') v
    WHERE v->>'sourceKind'='LEGACY_WITHDRAWAL' AND v->>'sourceId'=raw_log->>'sourceId';
   IF counted<>1 THEN RAISE EXCEPTION 'withdrawal return parent missing' USING ERRCODE='23514';END IF;
   withdrawal:=(matched->0->>'sourceCanonical')::jsonb;
   IF withdrawal->>'status' IS DISTINCT FROM '4' OR withdrawal->>'userId' IS DISTINCT FROM b.source_id OR withdrawal->>'is_delete' IS DISTINCT FROM '0'
    OR(raw_log->>'changeType') NOT IN('1003','1004') OR raw_log->>'action'<>'1'
    OR amount<>(withdrawal->>'money')::numeric OR amount<>(withdrawal->>'handling_fee')::numeric+(withdrawal->>'left_money')::numeric
    OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v
      WHERE v->>'kind'='earningsLog' AND v->>'referenceId'=raw_log->>'sourceId' AND v->>'legacyChangeType'='1002'
       AND v->>'action'='2' AND(v->>'amount')::numeric=amount AND(v->>'createdAt')::bigint>=(withdrawal->>'create_time')::bigint
       AND(v->>'createdAt')::bigint<=(raw_log->>'createdAt')::bigint)<>1
    OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v WHERE v->>'kind'='earningsLog'
      AND v->>'referenceId'=raw_log->>'sourceId' AND v->>'legacyChangeType' IN('1003','1004','1005'))<>1
   THEN RAISE EXCEPTION 'withdrawal debit/return/gross/time does not close' USING ERRCODE='23514';END IF;
  END IF;
  IF raw_log->>'changeType' IN('1006','1007','1008') THEN
   SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'supplementalLogs') v
    WHERE v->>'observationId'=binding->>'observationId';
   IF counted<>1 THEN RAISE EXCEPTION 'actual supplemental extraction missing' USING ERRCODE='23514';END IF;
   s:=matched->0;extended:=(s->>'canonical')::jsonb;
   IF s->>'digest' IS DISTINCT FROM encode(sha256(convert_to(s->>'canonical','UTF8')),'hex')
     OR s->>'originalDigest' IS DISTINCT FROM obs#>>'{rawSource,digest}' OR(s->>'extractSha256')!~'^[a-f0-9]{64}$'
     OR NOT(extended?&ARRAY['source_sn','remark','extra']) OR extended-ARRAY['source_sn','remark','extra'] IS DISTINCT FROM raw_log
     OR EXISTS(SELECT 1 FROM jsonb_each(extended) e WHERE e.key=ANY(ARRAY['source_sn','remark','extra']) AND jsonb_typeof(e.value) NOT IN('null','string'))
   THEN RAISE EXCEPTION 'supplement changed original nine fields or omitted extraction' USING ERRCODE='23514';END IF;
  END IF;
  IF root_source->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION') AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(i->'admissions') a WHERE a->>'sourceEntity'='la_log_earnings' AND a->>'sourceId'=binding->>'observationId' AND a->>'included'='true')
  THEN RAISE EXCEPTION 'reviewed log not included in original opening admission' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $_$;


--
-- Name: guard_supply_final_funding(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_supply_final_funding() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  personal jsonb;
  binding record;
  proof record;
  terms record;
  credit record;
  requirement record;
  last_payment text;
  confirmed numeric;
  refunded numeric;
  active_refund boolean;
  unrecognized boolean;
  reference text;
  required_text text;
  credit_state text;
  coverage_revision text;
  expected_reference text;
BEGIN
  IF NEW.confirmation_id IS NULL THEN RETURN NEW; END IF;
  personal:=NEW.quote_snapshot->'personal';
  IF personal->>'schema' NOT IN ('personal-quote-v2','personal-quote-v3','personal-quote-v4') THEN RETURN NEW; END IF;
  SELECT a.game_id,p.id AS price_id,p.funding_policy AS policy,v.payload,
    p.full_payout_terms_version_id,p.full_payout_terms_digest,p.full_payout_disclosure_version INTO binding
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id=NEW.rule_release_id
    JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.status='SEALED'
    JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.account_id=a.id
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id
     AND p.id=personal#>>'{ruleRefs,priceVersionId}' AND p.funding_policy->>'policyVersion'=personal#>>'{funding,version}';
  IF NOT FOUND THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
  IF personal#>>'{fullPayoutDeclaration,selected}'='true' THEN
    SELECT * INTO terms FROM zzsh_supply.full_payout_terms_version t
      WHERE t.id=binding.full_payout_terms_version_id AND t.game_id=binding.game_id AND t.status='SEALED'
        AND t.digest=binding.full_payout_terms_digest AND t.disclosure_version=binding.full_payout_disclosure_version
        AND t.policy_ref=personal#>>'{funding,fullPayoutPolicyRef}'
        AND t.policy_version=personal#>>'{funding,fullPayoutPolicyVersion}'
        AND t.disclosure_version=personal#>>'{funding,disclosureVersion}'
        AND t.policy_ref=binding.policy->>'fullPayoutPolicyRef'
        AND t.policy_version=binding.policy->>'fullPayoutPolicyVersion'
        AND t.disclosure_version=binding.policy->>'disclosureVersion';
    IF NOT FOUND OR right(personal#>>'{funding,sourceRef}',length(':full-payout-terms:'||terms.id||':'||terms.digest))
      IS DISTINCT FROM ':full-payout-terms:'||terms.id||':'||terms.digest THEN
      RAISE EXCEPTION 'full-payout terms binding changed' USING ERRCODE='40001';
    END IF;
  END IF;
  reference:=personal#>>'{guarantee,reference}';
  IF reference ~ '^credit-guarantee-v1:[0-9a-f]{64}$' THEN
    SELECT score,revision::text INTO credit FROM zzsh_credit.user_credit_state WHERE user_id=NEW.owner_user_id FOR SHARE;
    IF NOT FOUND OR binding.payload#>>'{quoteValues,resourceTotal,currency}' IS DISTINCT FROM 'CNY'
      OR binding.payload#>>'{quoteValues,resourceTotal,unit}' IS DISTINCT FROM 'yuan'
      OR binding.payload#>>'{quoteValues,resourceTotal,scale}' IS DISTINCT FROM '2'
      OR COALESCE(binding.payload#>>'{quoteValues,resourceTotal,amount}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
      OR (binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric<=0
      OR round((binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric*5)<=0
      OR (binding.payload#>'{quoteValues,pricingInputs,compatibility}' IS NOT NULL
        AND binding.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD') THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    SELECT id,required_cents::text,updated_at::text INTO requirement FROM zzsh_order.owner_guarantee_requirement
      WHERE account_id=NEW.account_id AND owner_user_id=NEW.owner_user_id AND price_version_id=binding.price_id
        AND listing_version_id IS NOT DISTINCT FROM NEW.listing_version_id ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN
      IF credit.score<80 THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
      credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;
    ELSE
      SELECT COALESCE(sum(COALESCE(observed_amount_cents,amount_cents)),0),
        COALESCE(bool_or(provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL),false)
        INTO confirmed,unrecognized FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id AND status='CONFIRMED';
      SELECT COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0),
        COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false)
        INTO refunded,active_refund FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=requirement.id;
      SELECT status INTO last_payment FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id ORDER BY created_at DESC,id DESC LIMIT 1;
      IF active_refund OR refunded>0 OR last_payment IN ('REQUESTED','ACCEPTED','PROCESSING','UNKNOWN') OR unrecognized THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      IF confirmed<requirement.required_cents::numeric THEN
        IF credit.score<80 OR confirmed<>0 OR (last_payment IS NOT NULL AND last_payment<>'FAILED') THEN
          RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
        END IF;
        credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;
      ELSE
        credit_state:='SATISFIED';required_text:=requirement.required_cents;coverage_revision:=requirement.updated_at;
      END IF;
    END IF;
    expected_reference:='credit-guarantee-v1:'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object(
      'accountId',NEW.account_id,'ownerUserId',NEW.owner_user_id,'gameId',binding.game_id,'versionId',NEW.listing_version_id,
      'priceVersionId',binding.price_id,'releaseId',NEW.rule_release_id,'creditRevision',credit.revision,
      'coverageRevision',coverage_revision,'state',credit_state,'requiredCents',required_text)), 'UTF8')),'hex');
    IF reference IS DISTINCT FROM expected_reference OR personal#>>'{guarantee,status}' IS DISTINCT FROM credit_state
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM required_text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT id,owner_user_id,account_id,price_version_id,policy_version,status,required_cents,covered_cents,valid_from,valid_until
    INTO proof FROM zzsh_supply.account_guarantee_proof WHERE account_id=NEW.account_id ORDER BY version_no DESC LIMIT 1;
  IF binding.policy#>>'{guaranteeRequirement,mode}'='NOT_REQUIRED' THEN
    IF binding.policy#>>'{guaranteeRequirement,requiredCents}' IS DISTINCT FROM '0'
      OR reference IS DISTINCT FROM 'policy:'||binding.price_id||':'||(binding.policy->>'policyVersion')||':NOT_REQUIRED'
      OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'NOT_REQUIRED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM '0' OR proof.status='REVOKED' THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
  ELSE
    IF proof.id IS DISTINCT FROM reference OR proof.status IS DISTINCT FROM 'SATISFIED'
      OR proof.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR proof.price_version_id IS DISTINCT FROM binding.price_id
      OR proof.policy_version IS DISTINCT FROM binding.policy->>'policyVersion'
      OR proof.required_cents::text IS DISTINCT FROM binding.policy#>>'{guaranteeRequirement,requiredCents}'
      OR proof.covered_cents<proof.required_cents OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'SATISFIED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM proof.required_cents::text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    IF proof.valid_from IS NULL OR proof.valid_until IS NULL OR proof.valid_from>clock_timestamp()
      OR clock_timestamp()>=proof.valid_until THEN
      RAISE EXCEPTION 'formal guarantee expired at order write' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_withdrawal_entry(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_row zzsh_order.finance_event;intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE economic_root_id=event_row.economic_root_id;
 IF event_row.kind NOT IN('RESERVE','RELEASE','PAYOUT') OR event_row.created_xid IS DISTINCT FROM pg_current_xact_id() OR intent.id IS NULL OR NEW.source_payment_confirmation_id IS NOT NULL
 OR NEW.details IS DISTINCT FROM jsonb_build_object('intentId',intent.id,'economicRootId',intent.economic_root_id,'policyVersion',intent.policy_version,'inputDigest',intent.input_digest)
 OR NOT EXISTS(SELECT 1 FROM zzsh_order.withdrawal_expected_lines(event_row.id) x WHERE(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id) IS NOT DISTINCT FROM(NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id)) THEN RAISE EXCEPTION 'controlled entry differs from exact original template' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_withdrawal_event(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE intent zzsh_order.withdrawal_intent;root zzsh_order.finance_economic_root;version_now bigint;
BEGIN
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE economic_root_id=root.id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.subject_user_id FOR UPDATE;
 SELECT ledger_revision INTO version_now FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF root.source_kind IS DISTINCT FROM 'LOCAL_CONTROLLED_WITHDRAWAL' OR intent.id IS NULL OR intent.user_id<>NEW.subject_user_id OR NEW.expected_ledger_revision IS DISTINCT FROM version_now THEN RAISE EXCEPTION 'controlled event source/revision mismatch' USING ERRCODE='40001';END IF;
 IF (NEW.kind='RESERVE' AND(intent.created_xid<>pg_current_xact_id() OR intent.funds_disposition<>'RESERVED'))
 OR(NEW.kind='PAYOUT' AND(intent.terminal_xid IS DISTINCT FROM pg_current_xact_id() OR intent.state<>'SUCCEEDED' OR intent.funds_disposition<>'PAYOUT_POSTED'))
 OR(NEW.kind='RELEASE' AND(intent.terminal_xid IS DISTINCT FROM pg_current_xact_id() OR intent.state<>'FAILED' OR intent.funds_disposition<>'RELEASE_POSTED')) THEN RAISE EXCEPTION 'controlled action not supported by original intent/result' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: guard_withdrawal_fact(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_fact() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE intent zzsh_order.withdrawal_intent;doc jsonb;outcome text;key_count integer;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.intent_id;
 doc:=NEW.evidence_canonical::jsonb;outcome:=doc->>'outcome';SELECT count(*) INTO key_count FROM jsonb_object_keys(doc);
 IF intent.id IS NULL OR NEW.payout_key<>intent.payout_key OR NEW.producer_lease_hash IS DISTINCT FROM intent.lease_token_hash OR intent.lease_until<=clock_timestamp()
  OR NEW.producer_lease_hash IS DISTINCT FROM current_setting('zzsh.withdrawal_lease_hash',true)
  OR doc->>'mode' IS DISTINCT FROM 'LOCAL_CONTROLLED' OR doc->>'intentId' IS DISTINCT FROM intent.id OR doc->>'payoutKey' IS DISTINCT FROM intent.payout_key
  OR outcome IS NULL OR outcome NOT IN('ACKNOWLEDGED','TIMEOUT','SUCCEEDED','FAILED') OR jsonb_typeof(doc->'outcome') IS DISTINCT FROM 'string'
  OR length(NEW.result_key) NOT BETWEEN 1 AND 128 OR octet_length(NEW.evidence_canonical)>4096 THEN RAISE EXCEPTION 'provider fact must bind current original-key lease' USING ERRCODE='23514';END IF;
 IF outcome IN('ACKNOWLEDGED','TIMEOUT') AND key_count<>4 THEN RAISE EXCEPTION 'nonterminal result shape invalid' USING ERRCODE='23514';END IF;
 IF outcome IN('SUCCEEDED','FAILED') AND(jsonb_typeof(doc->'reference') IS DISTINCT FROM 'string' OR length(btrim(doc->>'reference')) NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'terminal result reference invalid' USING ERRCODE='23514';END IF;
 IF outcome='SUCCEEDED' AND(key_count<>7 OR jsonb_typeof(doc->'netCents') IS DISTINCT FROM 'string' OR jsonb_typeof(doc->'feeCents') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'netCents','')!~'^(0|[1-9][0-9]{0,23})$' OR COALESCE(doc->>'feeCents','')!~'^(0|[1-9][0-9]{0,23})$') THEN RAISE EXCEPTION 'success result money invalid' USING ERRCODE='23514';END IF;
 IF outcome='FAILED' AND(key_count<>8 OR jsonb_typeof(doc->'unpaidConfirmed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(doc->'transferredCents') IS DISTINCT FROM 'string' OR jsonb_typeof(doc->'chargedFeeCents') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'transferredCents','')!~'^(0|[1-9][0-9]{0,23})$' OR COALESCE(doc->>'chargedFeeCents','')!~'^(0|[1-9][0-9]{0,23})$') THEN RAISE EXCEPTION 'failed result certainty/money invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $_$;


--
-- Name: guard_withdrawal_intent(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE adm zzsh_order.withdrawal_admission;dest zzsh_order.withdrawal_destination;available numeric;revision_now bigint;uses integer;gross_used numeric;day_start timestamptz;row_fact zzsh_order.withdrawal_provider_fact;doc jsonb;outcome text;lease_proof text;expected_state text;certain boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'withdrawal facts cannot be deleted' USING ERRCODE='40001';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal user unavailable' USING ERRCODE='23514';END IF;
 SELECT * INTO adm FROM zzsh_order.withdrawal_admission WHERE id=NEW.admission_id AND user_id=NEW.user_id;
 SELECT * INTO dest FROM zzsh_order.withdrawal_destination WHERE id=NEW.destination_id AND user_id=NEW.user_id AND admission_id=NEW.admission_id;
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM zzsh_auth_user."user" WHERE id=NEW.user_id AND suspended) OR COALESCE((SELECT account_status FROM zzsh_iam.user_identity_state WHERE user_id=NEW.user_id),'ACTIVE')<>'ACTIVE' THEN RAISE EXCEPTION 'new withdrawal user unavailable' USING ERRCODE='23514';END IF;
  IF adm.id IS NULL OR NOT adm.active OR NOT dest.active OR dest.id IS NULL OR dest.revision<>NEW.destination_revision
   OR adm.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database()) OR adm.resource_name<>current_database()
   OR adm.resource_marker IS DISTINCT FROM (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
   OR clock_timestamp()<adm.admitted_at OR clock_timestamp()>=adm.expires_at THEN RAISE EXCEPTION 'controlled cohort/resource unavailable' USING ERRCODE='23514';END IF;
  SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=NEW.user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
  SELECT ledger_revision INTO revision_now FROM zzsh_order.wallet_revision WHERE user_id=NEW.user_id;
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.user_id) OR revision_now IS DISTINCT FROM NEW.expected_ledger_revision OR available<NEW.gross_cents THEN RAISE EXCEPTION 'uncovered/insufficient/stale controlled wallet' USING ERRCODE='40001';END IF;
  SELECT count(*),COALESCE(sum(gross_cents),0) INTO uses,gross_used FROM zzsh_order.withdrawal_intent WHERE admission_id=adm.id;
  IF uses>=adm.max_intents OR gross_used+NEW.gross_cents>adm.max_gross_cents OR NEW.gross_cents<>adm.per_intent_cents THEN RAISE EXCEPTION 'bounded test admission exhausted' USING ERRCODE='23514';END IF;
  NEW.accepted_at:=date_trunc('milliseconds',clock_timestamp());NEW.created_at:=NEW.accepted_at;NEW.created_xid:=pg_current_xact_id();
  day_start:=(date_trunc('day',NEW.accepted_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai');
  IF (SELECT count(*) FROM zzsh_order.withdrawal_intent WHERE user_id=NEW.user_id AND accepted_at>=day_start AND accepted_at<day_start+interval '24 hours' AND state<>'FAILED')>=2 THEN RAISE EXCEPTION 'controlled daily quota exceeded' USING ERRCODE='23514';END IF;
  IF NEW.state<>'RESERVED' OR NEW.operation_version<>1 OR NEW.funds_disposition<>'RESERVED' OR NEW.lease_token_hash IS NOT NULL OR NEW.last_provider_fact_id IS NOT NULL OR NEW.terminal IS NOT NULL OR NEW.conflict_digest IS NOT NULL
   OR NEW.policy_version IS DISTINCT FROM 'OWNER_LOCAL_RESTORED_20261003_v1_'||dest.kind
   OR NEW.fee_cents IS DISTINCT FROM (CASE WHEN dest.kind='BANK_CARD' THEN 100::numeric ELSE floor((NEW.gross_cents*2+50)/100) END) THEN RAISE EXCEPTION 'controlled initial policy/state invalid' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.user_id,NEW.admission_id,NEW.destination_id,NEW.destination_revision,NEW.mode,NEW.policy_version,NEW.input_digest,NEW.gross_cents,NEW.net_cents,NEW.fee_cents,NEW.expected_ledger_revision,NEW.accepted_at,NEW.payout_key,NEW.economic_root_id,NEW.created_xid,NEW.created_at)
 IS DISTINCT FROM(OLD.id,OLD.user_id,OLD.admission_id,OLD.destination_id,OLD.destination_revision,OLD.mode,OLD.policy_version,OLD.input_digest,OLD.gross_cents,OLD.net_cents,OLD.fee_cents,OLD.expected_ledger_revision,OLD.accepted_at,OLD.payout_key,OLD.economic_root_id,OLD.created_xid,OLD.created_at) OR NEW.operation_version<>OLD.operation_version+1 THEN RAISE EXCEPTION 'withdrawal identity/frozen quote/CAS immutable' USING ERRCODE='40001';END IF;
 lease_proof:=current_setting('zzsh.withdrawal_lease_hash',true);
 IF NEW.lease_token_hash IS NOT NULL AND NEW.lease_token_hash IS DISTINCT FROM OLD.lease_token_hash THEN
  IF OLD.state='RESERVED' AND(EXISTS(SELECT 1 FROM zzsh_auth_user."user" WHERE id=NEW.user_id AND suspended) OR COALESCE((SELECT account_status FROM zzsh_iam.user_identity_state WHERE user_id=NEW.user_id),'ACTIVE')<>'ACTIVE' OR NOT adm.active OR clock_timestamp()>=adm.expires_at)
   THEN RAISE EXCEPTION 'new submit outside active controlled admission' USING ERRCODE='23514';END IF;
  IF OLD.state='RECONCILIATION_REQUIRED' OR OLD.lease_until>clock_timestamp() OR NEW.lease_until<=clock_timestamp() OR NEW.lease_token_hash IS DISTINCT FROM lease_proof
   OR NEW.last_provider_fact_id IS DISTINCT FROM OLD.last_provider_fact_id OR NEW.terminal IS DISTINCT FROM OLD.terminal OR NEW.funds_disposition<>OLD.funds_disposition
   OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='RESERVED' THEN 'SUBMITTING' WHEN OLD.state='SUBMITTING' THEN 'UNKNOWN' ELSE OLD.state END) THEN RAISE EXCEPTION 'invalid controlled lease claim' USING ERRCODE='40001';END IF;
 ELSE
  IF OLD.lease_token_hash IS NULL OR OLD.lease_token_hash IS DISTINCT FROM lease_proof OR OLD.lease_until<=clock_timestamp() OR NEW.lease_token_hash IS NOT NULL THEN RAISE EXCEPTION 'expired/wrong worker cannot finish' USING ERRCODE='40001';END IF;
  SELECT * INTO row_fact FROM zzsh_order.withdrawal_provider_fact WHERE id=NEW.last_provider_fact_id AND intent_id=NEW.id;
  IF row_fact.id IS NULL OR row_fact.producer_lease_hash<>OLD.lease_token_hash THEN RAISE EXCEPTION 'finish requires current original-key fact' USING ERRCODE='23514';END IF;
  doc:=row_fact.evidence_canonical::jsonb;outcome:=doc->>'outcome';
  certain:=(outcome='SUCCEEDED' AND doc->>'netCents'=NEW.net_cents::text AND doc->>'feeCents'=NEW.fee_cents::text)
   OR(outcome='FAILED' AND doc->>'unpaidConfirmed'='true' AND doc->>'transferredCents'='0' AND doc->>'chargedFeeCents'='0');
  expected_state:=CASE WHEN outcome IN('TIMEOUT','ACKNOWLEDGED') THEN CASE WHEN OLD.terminal IS NOT NULL THEN OLD.state WHEN outcome='TIMEOUT' THEN 'UNKNOWN' ELSE 'PROCESSING' END
   WHEN NOT COALESCE(certain,false) THEN 'RECONCILIATION_REQUIRED'
   WHEN OLD.terminal IS NOT NULL AND(OLD.terminal->>'state'<>outcome OR OLD.terminal->>'evidenceDigest'<>row_fact.evidence_digest) THEN 'RECONCILIATION_REQUIRED'
   ELSE outcome END;
  IF NEW.state IS DISTINCT FROM expected_state OR(expected_state='RECONCILIATION_REQUIRED' AND NEW.conflict_digest IS DISTINCT FROM row_fact.evidence_digest)
   OR(expected_state<>'RECONCILIATION_REQUIRED' AND NEW.conflict_digest IS DISTINCT FROM OLD.conflict_digest) THEN RAISE EXCEPTION 'state must match exact original provider knowledge' USING ERRCODE='23514';END IF;
  IF OLD.terminal IS NOT NULL AND (NEW.terminal IS DISTINCT FROM OLD.terminal OR NEW.funds_disposition<>OLD.funds_disposition) THEN RAISE EXCEPTION 'terminal funds cannot change' USING ERRCODE='40001';END IF;
  IF NEW.state='SUCCEEDED' AND NEW.terminal IS NULL OR NEW.state='FAILED' AND NEW.terminal IS NULL THEN RAISE EXCEPTION 'terminal evidence required' USING ERRCODE='23514';END IF;
  IF OLD.terminal IS NULL AND NEW.terminal IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM zzsh_order.controlled_payout_operation p WHERE p.intent_id=NEW.id AND p.payout_key=NEW.payout_key AND p.id=doc->>'reference' AND p.final_evidence_digest=row_fact.evidence_digest)
    THEN RAISE EXCEPTION 'terminal funds require durable original channel truth' USING ERRCODE='23514';END IF;
   IF NEW.terminal IS DISTINCT FROM jsonb_build_object('state',outcome,'evidenceDigest',row_fact.evidence_digest,'reference',doc->>'reference')
    OR(outcome='SUCCEEDED' AND (NEW.state<>'SUCCEEDED' OR NEW.funds_disposition<>'PAYOUT_POSTED' OR doc->>'netCents' IS DISTINCT FROM NEW.net_cents::text OR doc->>'feeCents' IS DISTINCT FROM NEW.fee_cents::text))
    OR(outcome='FAILED' AND (NEW.state<>'FAILED' OR NEW.funds_disposition<>'RELEASE_POSTED' OR doc->>'unpaidConfirmed' IS DISTINCT FROM 'true' OR doc->>'transferredCents' IS DISTINCT FROM '0' OR doc->>'chargedFeeCents' IS DISTINCT FROM '0'))
    OR outcome NOT IN('SUCCEEDED','FAILED') THEN RAISE EXCEPTION 'uncertain/partial result cannot consume reserve' USING ERRCODE='23514';END IF;
   NEW.terminal_xid:=pg_current_xact_id();
  ELSE
   IF NEW.funds_disposition<>OLD.funds_disposition OR NEW.terminal_xid IS DISTINCT FROM OLD.terminal_xid THEN RAISE EXCEPTION 'nonmonetary result changed funds' USING ERRCODE='40001';END IF;
   IF OLD.terminal IS NULL AND NEW.state NOT IN('UNKNOWN','PROCESSING','RECONCILIATION_REQUIRED') THEN RAISE EXCEPTION 'unconfirmed controlled outcome' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;


--
-- Name: guard_withdrawal_referral_recovery(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_referral_recovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=NEW.user_id AND state='RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'outstanding referral recovery prevents new withdrawal reservation' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_withdrawal_return_covered(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_return_covered() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE b zzsh_order.finance_opening_basis;r zzsh_order.finance_stored_opening_review;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=b.id;
 IF b.id IS NULL OR b.created_xid<>pg_current_xact_id() OR r.basis_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.input_canonical::jsonb#>'{sourceProof,sources}') s
   WHERE s->>'sourceKind'=NEW.source_kind AND s->>'sourceEntity'=NEW.source_entity AND s->>'sourceId'=NEW.source_id
    AND s->>'beneficiaryRole'=NEW.beneficiary_role AND s->>'sourceDigest'=NEW.source_digest
    AND to_timestamp((s->>'sourceEventAt')::bigint)=NEW.source_event_at)
 THEN RAISE EXCEPTION 'withdrawal return requires its separately reviewed opening proof' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_withdrawal_root(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.guard_withdrawal_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.source_id;
 IF intent.id IS NULL OR intent.created_xid<>pg_current_xact_id() OR NEW.id<>intent.economic_root_id OR NEW.subject_user_id<>intent.user_id
 OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-local-controlled' OR NEW.source_entity<>'withdrawal_intent' OR NEW.beneficiary_role<>'WALLET_HOLDER'
 OR NEW.policy_version IS DISTINCT FROM intent.policy_version OR NEW.source_digest<>intent.input_digest THEN RAISE EXCEPTION 'unbound controlled economic root' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;


--
-- Name: initialize_native_wallet_origin(text, text, text, text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.initialize_native_wallet_origin(user_id_value text, canonical text, digest text, request_id_value text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE basis_id_value text:='native_basis_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 root_id_value text:='native_root_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 event_id_value text:='native_origin_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);birth timestamptz;
BEGIN
 IF digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'native origin canonical digest mismatch' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_order.native_origin_resource_admission a
  WHERE a.resource_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND a.database_name=current_database() AND a.runtime_role=session_user
   AND a.resource_marker=COALESCE((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),''))
 THEN RETURN jsonb_build_object('knowledge','UNKNOWN','reason','NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED');END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=user_id_value FOR UPDATE;
 SELECT captured_at INTO birth FROM zzsh_order.native_user_insert_proof
  WHERE user_id=user_id_value AND insert_xid=pg_current_xact_id();
 IF birth IS NULL THEN RAISE EXCEPTION 'native subject missing' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest,native_origin_canonical)
  VALUES(basis_id_value,user_id_value,'NATIVE_GENESIS','zzsh-native-registration','zzsh_auth_user.user',user_id_value,digest,digest,0,birth,0,encode(sha256(convert_to('','UTF8')),'hex'),canonical);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
  VALUES(root_id_value,basis_id_value,'NATIVE_GENESIS','NATIVE','zzsh-native-registration','zzsh_auth_user.user',user_id_value,user_id_value,'WALLET_HOLDER',digest);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES(event_id_value,root_id_value,'OPENING',user_id_value,0);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
  VALUES('audit_native_origin_'||replace(gen_random_uuid()::text,'-',''),'system',user_id_value,'finance.native.origin.created','wallet_coverage',user_id_value,'SUCCESS',request_id_value,clock_timestamp(),jsonb_build_object('origin','NATIVE_GENESIS','sourceDigest',digest));
 RETURN jsonb_build_object('knowledge','KNOWN','origin','NATIVE_GENESIS','availableCents','0');
END $$;


--
-- Name: joinpay_formal_request_effect(text, text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.joinpay_formal_request_effect(request_id_value text, state_value text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT EXISTS(SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
  JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.event='E4'
  WHERE r.id=request_id_value AND b.formal_admission_ref IS NOT NULL AND (
   state_value='ACCEPTED' AND EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='APPLIED')
   OR state_value='REVIEW_REQUIRED' AND (EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='REVIEW_REQUIRED')
    OR EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction a WHERE a.channel='JOINPAY' AND a.merchant_identity_id=r.merchant_identity_id
      AND a.channel_trx_no=e.channel_trx_no AND (a.native_order_id<>r.order_id OR a.request_id IS DISTINCT FROM r.id)))))
$$;


--
-- Name: joinpay_payout_observation_read_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.joinpay_payout_observation_read_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE subject_id text;
BEGIN
 SELECT user_id INTO subject_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_id FOR UPDATE;
 UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=subject_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payout observation revision unavailable' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: joinpay_payout_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_payout_observation (
    id text NOT NULL,
    intent_id text NOT NULL,
    attempt_id text,
    operation text NOT NULL,
    lease_version bigint,
    lease_owner text,
    profile_id text NOT NULL,
    profile_canonical text NOT NULL,
    profile_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    raw_body bytea,
    raw_sha256 text,
    response_complete boolean NOT NULL,
    http_status integer,
    received_bytes bigint NOT NULL,
    transport_failure text,
    event text NOT NULL,
    schema_status text NOT NULL,
    signature_status text NOT NULL,
    binding_status text NOT NULL,
    evidence_level text NOT NULL,
    state_before text NOT NULL,
    state_after text NOT NULL,
    request_id text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_payout_observation_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_payout_observation_check1 CHECK ((((raw_body IS NOT NULL) AND (raw_sha256 IS NOT NULL) AND (raw_sha256 = encode(sha256(raw_body), 'hex'::text))) OR ((raw_body IS NULL) AND (raw_sha256 IS NULL) AND (NOT response_complete)))),
    CONSTRAINT joinpay_payout_observation_check2 CHECK ((received_bytes >= COALESCE(octet_length(raw_body), 0))),
    CONSTRAINT joinpay_payout_observation_check3 CHECK (((NOT response_complete) OR ((raw_body IS NOT NULL) AND (received_bytes = octet_length(raw_body)) AND (((operation = 'NOTIFY'::text) AND (http_status IS NULL)) OR ((operation <> 'NOTIFY'::text) AND (http_status IS NOT NULL)))))),
    CONSTRAINT joinpay_payout_observation_check4 CHECK ((((operation = 'NOTIFY'::text) AND (attempt_id IS NULL) AND (lease_version IS NULL) AND (lease_owner IS NULL) AND (http_status IS NULL)) OR ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text])) AND (attempt_id IS NOT NULL) AND (lease_version IS NOT NULL) AND (lease_version > 0) AND (lease_owner IS NOT NULL)))),
    CONSTRAINT joinpay_payout_observation_check5 CHECK (((state_before = ANY (ARRAY['RESERVED'::text, 'SUBMITTING'::text, 'PROCESSING'::text, 'UNKNOWN'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'SUCCEEDED'::text, 'FAILED'::text])) AND (state_after = ANY (ARRAY['RESERVED'::text, 'SUBMITTING'::text, 'PROCESSING'::text, 'UNKNOWN'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'SUCCEEDED'::text, 'FAILED'::text])))),
    CONSTRAINT joinpay_payout_observation_check6 CHECK (((event <> ALL (ARRAY['STALE'::text, 'PENDING_TERMINAL'::text, 'TERMINAL'::text])) OR (state_before = state_after))),
    CONSTRAINT joinpay_payout_observation_event_check CHECK ((event = ANY (ARRAY['UNKNOWN'::text, 'PROCESSING'::text, 'PENDING_TERMINAL'::text, 'REVIEW'::text, 'STALE'::text, 'TERMINAL'::text]))),
    CONSTRAINT joinpay_payout_observation_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['PROVIDER_RESPONSE'::text, 'SYNTHETIC_PROTOCOL'::text]))),
    CONSTRAINT joinpay_payout_observation_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT joinpay_payout_observation_operation_check CHECK ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text, 'NOTIFY'::text]))),
    CONSTRAINT joinpay_payout_observation_profile_canonical_check CHECK (((octet_length(profile_canonical) >= 2) AND (octet_length(profile_canonical) <= 131072))),
    CONSTRAINT joinpay_payout_observation_raw_body_check CHECK ((octet_length(raw_body) <= 65536)),
    CONSTRAINT joinpay_payout_observation_received_bytes_check CHECK ((received_bytes >= 0)),
    CONSTRAINT joinpay_payout_observation_request_id_check CHECK (((length(request_id) >= 1) AND (length(request_id) <= 180)))
);


--
-- Name: joinpay_payout_raw_data(zzsh_order.joinpay_payout_observation); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.joinpay_payout_raw_data(o zzsh_order.joinpay_payout_observation) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE top jsonb;data jsonb;p jsonb;
BEGIN
 IF o.raw_body IS NULL OR NOT o.response_complete OR o.raw_sha256 IS DISTINCT FROM encode(sha256(o.raw_body),'hex')
 THEN RAISE EXCEPTION 'payout complete raw bytes missing' USING ERRCODE='23514';END IF;
 top:=convert_from(o.raw_body,'UTF8')::jsonb;p:=o.profile_canonical::jsonb;
 IF jsonb_typeof(top) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payout raw root is not object' USING ERRCODE='23514';END IF;
 IF o.operation='NOTIFY' THEN RETURN top;END IF;
 IF top->>'statusCode' IS DISTINCT FROM '2001' THEN RAISE EXCEPTION 'payout query response not accepted' USING ERRCODE='23514';END IF;
 IF p#>>'{rules,dataEncoding}'='OBJECT' THEN
  IF jsonb_typeof(top->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payout raw data object missing' USING ERRCODE='23514';END IF;data:=top->'data';
 ELSIF p#>>'{rules,dataEncoding}'='JSON_STRING' THEN
  IF jsonb_typeof(top->'data') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'payout raw data string missing' USING ERRCODE='23514';END IF;data:=(top->>'data')::jsonb;
 ELSE RAISE EXCEPTION 'payout raw encoding not reviewed' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payout raw data shape invalid' USING ERRCODE='23514';END IF;
 RETURN data;
END $$;


--
-- Name: joinpay_withdrawal_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.joinpay_withdrawal_complete(intent_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.joinpay_withdrawal_intent;r zzsh_order.finance_economic_root;e zzsh_order.joinpay_payout_evidence;
 ev zzsh_order.finance_event;reserve_count bigint;paid_count bigint;release_count bigint;total_count bigint;lines bigint;dr numeric;cr numeric;rev bigint;expected_details jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.joinpay_withdrawal_intent WHERE id=intent_id_value;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.economic_root_id;
 IF i.id IS NULL OR r.id IS NULL OR r.source_kind<>'JOINPAY_WITHDRAWAL' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh'
  OR r.source_entity<>'joinpay_withdrawal_intent' OR r.source_id IS DISTINCT FROM i.id OR r.subject_user_id IS DISTINCT FROM i.user_id
  OR r.beneficiary_role<>'WALLET_HOLDER' OR r.basis_id IS NOT NULL OR r.policy_version IS DISTINCT FROM i.policy_version
  OR r.source_digest IS DISTINCT FROM i.frozen_digest OR r.created_xid IS DISTINCT FROM i.created_xid
 THEN RETURN false;END IF;
 SELECT count(*),count(*) FILTER(WHERE kind='JOINPAY_WITHDRAWAL_RESERVED'),count(*) FILTER(WHERE kind='JOINPAY_WITHDRAWAL_PAID'),
  count(*) FILTER(WHERE kind='JOINPAY_WITHDRAWAL_RELEASED') INTO total_count,reserve_count,paid_count,release_count FROM zzsh_order.finance_event WHERE economic_root_id=r.id;
 IF reserve_count<>1 OR paid_count<>(CASE WHEN i.funds_disposition='PAYOUT_POSTED' THEN 1 ELSE 0 END)
  OR release_count<>(CASE WHEN i.funds_disposition='RELEASE_POSTED' THEN 1 ELSE 0 END) OR total_count<>reserve_count+paid_count+release_count
 THEN RETURN false;END IF;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.user_id;
 IF rev IS NULL THEN RETURN false;END IF;
 SELECT * INTO e FROM zzsh_order.joinpay_payout_evidence WHERE intent_id=i.id;
 IF i.state IN('SUCCEEDED','FAILED') THEN
  IF e.id IS NULL OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.platform_serial_no IS DISTINCT FROM e.platform_serial_no
   OR i.provider_fee_raw IS DISTINCT FROM e.provider_fee_raw OR i.provider_fee_cents IS DISTINCT FROM e.provider_fee_cents
   OR i.state IS DISTINCT FROM (CASE e.terminal WHEN 'PAID' THEN 'SUCCEEDED' ELSE 'FAILED' END)
   OR i.funds_disposition IS DISTINCT FROM (CASE e.terminal WHEN 'PAID' THEN 'PAYOUT_POSTED' ELSE 'RELEASE_POSTED' END)
  THEN RETURN false;END IF;
 ELSE
  IF i.funds_disposition<>'RESERVED' OR e.id IS NOT NULL OR i.terminal_evidence_id IS NOT NULL OR i.terminal_event_id IS NOT NULL
  THEN RETURN false;END IF;
 END IF;
 FOR ev IN SELECT * FROM zzsh_order.finance_event WHERE economic_root_id=r.id LOOP
  IF ev.subject_user_id IS DISTINCT FROM i.user_id OR rev<ev.expected_ledger_revision+1 THEN RETURN false;END IF;
  IF ev.kind='JOINPAY_WITHDRAWAL_RESERVED' THEN
   IF ev.id IS DISTINCT FROM i.reserve_event_id OR ev.created_xid IS DISTINCT FROM i.created_xid
    OR ev.expected_ledger_revision IS DISTINCT FROM i.expected_ledger_revision THEN RETURN false;END IF;
   expected_details:=jsonb_build_object('joinpayWithdrawalIntentId',i.id,'economicRootId',i.economic_root_id,'policyVersion',i.policy_version,
    'inputDigest',i.frozen_digest,'evidenceId',NULL::text,'evidenceDigest',NULL::text);
  ELSE
   IF ev.id IS DISTINCT FROM i.terminal_event_id OR e.id IS NULL OR ev.created_xid IS DISTINCT FROM e.created_xid
   THEN RETURN false;END IF;
   expected_details:=jsonb_build_object('joinpayWithdrawalIntentId',i.id,'economicRootId',i.economic_root_id,'policyVersion',i.policy_version,
    'inputDigest',i.frozen_digest,'evidenceId',e.id,'evidenceDigest',e.facts_digest);
  END IF;
  SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
  IF lines<>(SELECT count(*) FROM zzsh_order.joinpay_withdrawal_expected_lines(ev.id)) OR dr<>i.gross_cents OR cr<>i.gross_cents
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id
    AND(l.posting_id IS NOT NULL OR l.source_payment_confirmation_id IS NOT NULL OR l.details IS DISTINCT FROM expected_details))
   OR EXISTS((SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id)
    EXCEPT(SELECT * FROM zzsh_order.joinpay_withdrawal_expected_lines(ev.id)))
   OR EXISTS((SELECT * FROM zzsh_order.joinpay_withdrawal_expected_lines(ev.id))
    EXCEPT(SELECT line_no,account_code,debit_cents,credit_cents,counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id))
  THEN RETURN false;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_type='joinpay_withdrawal_intent' AND a.object_id=i.id
  AND a.action='joinpay.withdrawal.reserved' AND a.actor_type='user' AND a.actor_id=i.user_id AND a.outcome='SUCCESS'
  AND a.details=jsonb_build_object('frozenDigest',i.frozen_digest,'evidenceId',NULL::text,'factsDigest',NULL::text,'fundsDisposition','RESERVED',
   'grossCents',i.gross_cents::text,'netCents',i.net_cents::text,'feeCents',i.fee_cents::text,'currency','CNY','channelArrival','UNKNOWN'))
 THEN RETURN false;END IF;
 IF i.state IN('SUCCEEDED','FAILED') AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_type='joinpay_withdrawal_intent' AND a.object_id=i.id
  AND a.action=CASE i.state WHEN 'SUCCEEDED' THEN 'joinpay.withdrawal.paid' ELSE 'joinpay.withdrawal.released' END AND a.actor_type='system' AND a.outcome='SUCCESS'
  AND a.details=jsonb_build_object('frozenDigest',i.frozen_digest,'evidenceId',e.id,'factsDigest',e.facts_digest,'fundsDisposition',i.funds_disposition,
   'grossCents',i.gross_cents::text,'netCents',i.net_cents::text,'feeCents',i.fee_cents::text,'currency','CNY','channelArrival','UNKNOWN'))
 THEN RETURN false;END IF;
 IF i.lease_version>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_payout_attempt a WHERE a.intent_id=i.id AND a.lease_version=i.lease_version AND a.lease_owner=i.lease_owner)
 THEN RETURN false;END IF;
 RETURN true;
END $$;


--
-- Name: joinpay_withdrawal_expected_lines(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.joinpay_withdrawal_expected_lines(event_id_value text) RETURNS TABLE(line_no integer, account_code text, debit_cents numeric, credit_cents numeric, counterparty_user_id text)
    LANGUAGE sql STABLE
    AS $$
 SELECT v.n,v.code,v.dr,v.cr,v.party FROM zzsh_order.finance_event e
 JOIN zzsh_order.joinpay_withdrawal_intent i ON i.economic_root_id=e.economic_root_id
 CROSS JOIN LATERAL(VALUES
  (1,CASE WHEN e.kind='JOINPAY_WITHDRAWAL_RESERVED' THEN 'WALLET_AVAILABLE' ELSE 'WALLET_RESERVED' END,i.gross_cents,0::numeric,i.user_id),
  (2,CASE e.kind WHEN 'JOINPAY_WITHDRAWAL_RESERVED' THEN 'WALLET_RESERVED' WHEN 'JOINPAY_WITHDRAWAL_PAID' THEN 'PAYOUT_CLEARING' ELSE 'WALLET_AVAILABLE' END,
   0::numeric,CASE WHEN e.kind='JOINPAY_WITHDRAWAL_PAID' THEN i.net_cents ELSE i.gross_cents END,CASE WHEN e.kind='JOINPAY_WITHDRAWAL_PAID' THEN NULL::text ELSE i.user_id END),
  (3,'WITHDRAW_FEE',0::numeric,i.fee_cents,NULL::text))v(n,code,dr,cr,party)
 WHERE e.id=event_id_value AND e.kind IN('JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID','JOINPAY_WITHDRAWAL_RELEASED')
  AND(v.n<3 OR(e.kind='JOINPAY_WITHDRAWAL_PAID' AND i.fee_cents>0))
$$;


--
-- Name: legacy_opening_source_proof(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.legacy_opening_source_proof(basis_id_value text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE r zzsh_order.finance_stored_opening_review;b zzsh_order.finance_opening_basis;i jsonb;proof jsonb;digest_value text;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=basis_id_value;
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=b.id;
 IF r.basis_id IS NULL THEN RETURN NULL;END IF;
 i:=r.input_canonical::jsonb;
 IF NOT(i?'sourceProof') THEN RETURN NULL;END IF;
 proof:=i->'sourceProof';digest_value:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(proof),'UTF8')),'hex');
 IF b.source_kind<>'LEGACY_OPENING' OR proof->>'schema'<>'legacy-finance-source-proof.v1'
   OR r.review_canonical::jsonb->>'sourceProofDigest' IS DISTINCT FROM digest_value
 THEN RAISE EXCEPTION 'sealed source proof digest differs' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('schema','reviewed-opening-log-bindings.v1','basisId',b.id,'userId',b.user_id,'legacyUserId',b.source_id,
  'sourceDigest',b.source_digest,'coveredDigest',b.covered_set_digest,'cutoff',to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'digest',digest_value,'logBindings',proof->'logBindings');
END $$;


--
-- Name: lock_finance_history_subject(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.lock_finance_history_subject() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;RETURN NEW;END $$;


--
-- Name: native_abnormal_refund_liability_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_abnormal_refund_liability_complete(intent_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;r zzsh_order.finance_economic_root;ev zzsh_order.finance_event;
 c zzsh_order.payment_confirmation;total bigint;good bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.liability_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.liability_event_id;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=i.payment_confirmation_id;
 IF i.id IS NULL OR i.basis_kind<>'REVIEW_CONFIRMATION' OR i.posting_id IS NOT NULL OR r.id IS NULL OR ev.id IS NULL OR c.id IS NULL
  OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh'
  OR r.source_entity<>'joinpay_abnormal_refund_liability' OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL
  OR r.source_id<>i.payment_confirmation_id OR r.subject_user_id<>i.renter_user_id
  OR r.source_digest<>i.responsibility_version_hash OR r.beneficiary_role<>'RENTER'
  OR r.id<>'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(i.payment_confirmation_id,'UTF8')),'hex'),1,40)
  OR ev.kind<>'REFUND_LIABILITY_RECOGNIZED' OR ev.economic_root_id<>r.id OR ev.subject_user_id<>i.renter_user_id
  OR ev.id<>r.id||'_recognized' OR c.amount_cents<>i.amount_cents OR c.joinpay_evidence_id IS NULL OR c.joinpay_anchor_id IS NULL
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),count(*) FILTER(WHERE source_payment_confirmation_id IS NULL
   AND details=jsonb_build_object('abnormalRefundLiabilityId',i.payment_confirmation_id,'paymentConfirmationId',i.payment_confirmation_id,
     'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',i.amount_cents::text)
   AND((line_no=1 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=i.amount_cents AND credit_cents=0
       AND counterparty_user_id IS NULL)
     OR(line_no=2 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=0 AND credit_cents=i.amount_cents
       AND counterparty_user_id=i.renter_user_id)))
  INTO total,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN total=2 AND good=2;
END $$;


--
-- Name: native_abnormal_refund_terminal_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_abnormal_refund_terminal_complete(intent_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;rev bigint;lines bigint;good bigint;dr numeric;cr numeric;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL'
  OR i.basis_kind<>'REVIEW_CONFIRMATION' OR i.posting_id IS NOT NULL OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
  OR NOT zzsh_order.native_abnormal_refund_liability_complete(i.id)
 THEN RETURN false;END IF;
 IF e.terminal='FAILED_NO_EXECUTION' THEN
  RETURN i.state='FAILED' AND i.budget_disposition='RELEASED' AND i.terminal_root_id IS NULL AND i.terminal_event_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=i.id)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.allocation.released' AND a.object_type='channel_refund_intent'
    AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
    AND a.details->>'budgetDisposition'='RELEASED' AND a.details->>'postingId' IS NULL
    AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
    AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
 END IF;
 IF e.terminal<>'SUCCEEDED' THEN RETURN false;END IF;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR r.id IS NULL OR ev.id IS NULL OR rev IS NULL
  OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.source_entity<>'channel_refund_intent'
  OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest OR r.beneficiary_role<>'RENTER'
  OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id
  OR ev.subject_user_id<>i.renter_user_id OR rev<ev.expected_ledger_revision+1
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  source_payment_confirmation_id IS NULL AND details=jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId' IS NULL
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;


--
-- Name: native_prestart_refund_liability_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_prestart_refund_liability_complete(intent_id_value text) RETURNS boolean
    LANGUAGE sql
    AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
  JOIN zzsh_order.prestart_termination t ON t.order_id=i.order_id AND t.payment_basis->>'paymentConfirmationId'=i.payment_confirmation_id
  WHERE i.id=intent_id_value AND i.basis_kind='PRESTART_TERMINATION' AND i.posting_id IS NULL
   AND i.payment_source='JOINPAY' AND i.evidence_level='JOINPAY_FORMAL' AND t.payment_basis->>'source'='JOINPAY'
   AND zzsh_order.prestart_liability_complete(t.id) AND i.renter_user_id=t.payment_basis->>'renterUserId'
   AND i.merchant_identity_id=t.payment_basis->>'merchantIdentityId' AND i.original_payment_trx_no=t.payment_basis->>'channelTrxNo'
   AND i.original_payment_order_no=t.payment_basis->>'merchantOrderNo' AND i.amount_cents::text=t.payment_basis->>'amountCents' AND i.currency='CNY'
   AND i.responsibility_version_hash=t.basis_digest AND i.liability_root_id=t.liability_root_id AND i.liability_event_id=t.liability_event_id
   AND i.due_at=t.approved_at),false)
$$;


--
-- Name: native_prestart_refund_terminal_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_prestart_refund_terminal_complete(intent_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;rev bigint;lines bigint;good bigint;dr numeric;cr numeric;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL'
  OR i.basis_kind<>'PRESTART_TERMINATION' OR i.posting_id IS NOT NULL OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
  OR NOT zzsh_order.native_prestart_refund_liability_complete(i.id)
 THEN RETURN false;END IF;
 IF e.terminal='FAILED_NO_EXECUTION' THEN
  RETURN i.state='FAILED' AND i.budget_disposition='RELEASED' AND i.terminal_root_id IS NULL AND i.terminal_event_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=i.id)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.allocation.released' AND a.object_type='channel_refund_intent'
    AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
    AND a.details->>'budgetDisposition'='RELEASED' AND a.details->>'postingId' IS NULL
    AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
    AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
 END IF;
 IF e.terminal<>'SUCCEEDED' THEN RETURN false;END IF;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR r.id IS NULL OR ev.id IS NULL OR rev IS NULL
  OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.source_entity<>'channel_refund_intent'
  OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest OR r.beneficiary_role<>'RENTER'
  OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id
  OR ev.subject_user_id<>i.renter_user_id OR rev<ev.expected_ledger_revision+1
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  source_payment_confirmation_id IS NULL AND details=jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId' IS NULL
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;


--
-- Name: native_refund_terminal_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_refund_terminal_complete(intent_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;lines bigint;good bigint;dr numeric;cr numeric;rev bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
 THEN RETURN false;END IF;
 IF e.terminal='FAILED_NO_EXECUTION' THEN
  RETURN i.state='FAILED' AND i.budget_disposition='RELEASED' AND i.terminal_root_id IS NULL AND i.terminal_event_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=i.id)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.allocation.released' AND a.object_type='channel_refund_intent'
    AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
    AND a.details->>'budgetDisposition'='RELEASED' AND a.details->>'postingId'=i.posting_id
    AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
    AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
 END IF;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR r.id IS NULL OR ev.id IS NULL OR rev IS NULL
  OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.source_entity<>'channel_refund_intent'
  OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest OR r.beneficiary_role<>'RENTER'
  OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id
  OR ev.subject_user_id<>i.renter_user_id OR rev<ev.expected_ledger_revision+1
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  source_payment_confirmation_id IS NULL AND details=jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId'=i.posting_id
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;


--
-- Name: native_settlement_wallet_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.native_settlement_wallet_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE subject_id text;
BEGIN
 FOR subject_id IN SELECT v.id FROM(SELECT owner_user_id AS id FROM zzsh_order.rental_order WHERE id=NEW.order_id AND NEW.owner_net_cents>0
 UNION SELECT renter_user_id AS id FROM zzsh_order.rental_order WHERE id=NEW.order_id AND NEW.renter_refund_cents>0) v ORDER BY v.id COLLATE "C" LOOP
  PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_id FOR UPDATE;
  INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(subject_id,1,1)
  ON CONFLICT(user_id) DO UPDATE SET ledger_revision=zzsh_order.wallet_revision.ledger_revision+1,read_revision=zzsh_order.wallet_revision.read_revision+1;
 END LOOP;
 RETURN NULL;
END $$;


--
-- Name: next_display_no(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.next_display_no() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT 'ZZ' || to_char(clock_timestamp(), 'YYMMDD-') ||
         CASE WHEN v < 1000000 THEN lpad(v::text, 6, '0') ELSE v::text END
    FROM (SELECT nextval('zzsh_order.display_no_seq') AS v) s
$$;


--
-- Name: prestart_liability_complete(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.prestart_liability_complete(termination_id_value text) RETURNS boolean
    LANGUAGE sql
    AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
  JOIN zzsh_order.rental_order o ON o.id=t.order_id
  JOIN zzsh_order.finance_economic_root r ON r.id=t.liability_root_id
  JOIN zzsh_order.finance_event e ON e.id=t.liability_event_id AND e.economic_root_id=r.id
  WHERE t.id=termination_id_value AND t.state='APPROVED' AND t.basis_digest=t.payment_basis->>'digest'
   AND((t.requested_by_party='SUPPORT' AND o.status='CANCELLED' AND o.cancel_reason='SUPPORT_CANCELLED_REFUND'
       AND zzsh_order.support_cancel_payment_basis_valid(t.payment_basis))
     OR(t.requested_by_party<>'SUPPORT' AND o.status='CANCELLED' AND o.cancel_reason='PRESTART_TERMINATED'
       AND zzsh_order.prestart_payment_basis_valid(t.payment_basis)))
   AND r.source_kind='NATIVE_PRESTART_REFUND' AND r.source_type='NATIVE' AND r.source_system='zzsh' AND r.source_entity='prestart_termination'
   AND r.source_id=t.id AND r.subject_user_id=o.renter_user_id AND r.source_digest=t.basis_digest AND r.basis_id IS NULL
   AND r.policy_version=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'support-full-refund.v1' ELSE 'prestart-full-refund.v1' END)
   AND r.beneficiary_role='RENTER'
   AND r.id='prestart_refund_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
   AND e.id='prestart_liability_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
   AND e.kind='REFUND_LIABILITY_RECOGNIZED' AND e.subject_user_id=o.renter_user_id
   AND(SELECT count(*) FROM zzsh_order.finance_event ev WHERE ev.economic_root_id=r.id)=1
   AND(SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=2
   AND(SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id AND l.posting_id IS NULL
     AND l.details=jsonb_build_object('prestartTerminationId',t.id,'basisDigest',t.basis_digest,'paymentConfirmationId',t.payment_basis->>'paymentConfirmationId',
       'dataOrigin',CASE t.payment_basis->>'source' WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
     AND((l.line_no=1 AND l.account_code='CAPTURED_PAYMENT_SOURCE' AND l.debit_cents=(t.payment_basis->>'amountCents')::numeric AND l.credit_cents=0
       AND l.counterparty_user_id IS NULL AND l.source_payment_confirmation_id=t.payment_basis->>'paymentConfirmationId')
      OR(l.line_no=2 AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=(t.payment_basis->>'amountCents')::numeric
       AND l.counterparty_user_id=o.renter_user_id AND l.source_payment_confirmation_id IS NULL)))=2
   AND EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id AND d.result_revision=t.revision
     AND d.decision='APPROVE'
     AND d.assessment=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'SUPPORT_FULL_REFUND' ELSE 'NO_USE_NO_DISPUTE' END)
     AND d.created_xid=t.approved_xid)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
     WHERE a.action=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'order.support_cancel' ELSE 'order.prestart.termination.reviewed' END)
     AND a.object_type='prestart_termination' AND a.object_id=t.id AND a.outcome='SUCCESS'
     AND a.details->>'decision'='APPROVE' AND a.details->>'basisDigest'=t.basis_digest
     AND a.details->>'liabilityRootId'=r.id)),false)
$$;


--
-- Name: prestart_payment_basis_valid(jsonb); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.prestart_payment_basis_valid(b jsonb) RETURNS boolean
    LANGUAGE sql
    AS $_$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.rental_order o
  JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
  WHERE o.id=b->>'orderId' AND c.id=b->>'paymentConfirmationId' AND c.disposition='APPLIED'
   AND c.source IN('JOINPAY','CONTROLLED') AND c.source=b->>'source' AND c.currency='CNY' AND b->>'currency'='CNY'
   AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents AND c.amount_cents::text=b->>'amountCents' AND c.amount_cents>0
   AND b->>'amountCents'~'^[1-9][0-9]{0,15}$' AND b->>'digest'~'^[a-f0-9]{64}$'
   AND o.renter_user_id=b->>'renterUserId' AND o.owner_user_id=b->>'ownerUserId'
   AND c.merchant_scope_id=b->>'merchantIdentityId' AND c.merchant_order_no=b->>'merchantOrderNo' AND c.provider_transaction_id=b->>'channelTrxNo'
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND(x.status='CONFIRMED'
     OR(SELECT count(DISTINCT a.party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2))
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.kind='MANUAL_ADJUSTMENT' AND v.superseded_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')),false)
$_$;


--
-- Name: referral_debt_read_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.referral_debt_read_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE subject_value text;
BEGIN
 SELECT beneficiary_user_id INTO subject_value FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_value FOR UPDATE;
 UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=subject_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'referral debt has no covered wallet' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;


--
-- Name: set_rental_opening_auto_confirm_due(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.set_rental_opening_auto_confirm_due() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW."auto_confirm_due_at" := NEW."created_at" + interval '40 minutes';
  RETURN NEW;
END $$;


--
-- Name: settlement_snapshot_cents(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.settlement_snapshot_cents(value text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $_$
BEGIN
  IF value !~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid settlement snapshot amount' USING ERRCODE = '23514';
  END IF;
  RETURN replace(value, '.', '')::numeric;
END $_$;


--
-- Name: support_cancel_payment_basis_valid(jsonb); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.support_cancel_payment_basis_valid(b jsonb) RETURNS boolean
    LANGUAGE sql
    AS $_$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.rental_order o
  JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
  WHERE o.id=b->>'orderId' AND c.id=b->>'paymentConfirmationId' AND c.disposition='APPLIED'
   AND zzsh_order.prestart_payment_basis_valid(b)
   AND c.source='JOINPAY' AND b->>'source'='JOINPAY' AND c.currency='CNY' AND b->>'currency'='CNY'
   AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents AND c.amount_cents::text=b->>'amountCents' AND c.amount_cents>0
   AND b->>'amountCents'~'^[1-9][0-9]{0,15}$' AND b->>'digest'~'^[a-f0-9]{64}$'
   AND o.renter_user_id=b->>'renterUserId' AND o.owner_user_id=b->>'ownerUserId'
   AND c.merchant_scope_id=b->>'merchantIdentityId' AND c.merchant_order_no=b->>'merchantOrderNo' AND c.provider_transaction_id=b->>'channelTrxNo'
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.superseded_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_intake i WHERE i.order_id=o.id AND i.status IN('OPEN','CLASSIFIED'))
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')),false)
$_$;


--
-- Name: withdrawal_bank_binding_guard(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.withdrawal_bank_binding_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'binding initial revision invalid' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'binding identity or revision invalid' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp(); RETURN NEW;
END; $$;


--
-- Name: withdrawal_expected_lines(text); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.withdrawal_expected_lines(event_id text) RETURNS TABLE(line_no integer, account_code text, debit_cents numeric, credit_cents numeric, counterparty_user_id text)
    LANGUAGE sql STABLE
    AS $$
 SELECT v.n,v.code,v.dr,v.cr,v.party FROM zzsh_order.finance_event e JOIN zzsh_order.withdrawal_intent i ON i.economic_root_id=e.economic_root_id
 CROSS JOIN LATERAL(VALUES
 (1,CASE WHEN e.kind='RESERVE' THEN 'WALLET_AVAILABLE' ELSE 'WALLET_RESERVED' END,i.gross_cents,0::numeric,i.user_id),
 (2,CASE WHEN e.kind='RESERVE' THEN 'WALLET_RESERVED' WHEN e.kind='RELEASE' THEN 'WALLET_AVAILABLE' ELSE 'PAYOUT_CLEARING' END,0::numeric,CASE WHEN e.kind='PAYOUT' THEN i.net_cents ELSE i.gross_cents END,CASE WHEN e.kind='PAYOUT' THEN NULL::text ELSE i.user_id END),
 (3,'WITHDRAW_FEE',0::numeric,i.fee_cents,NULL::text))v(n,code,dr,cr,party)
 WHERE e.id=event_id AND e.kind IN('RESERVE','RELEASE','PAYOUT') AND(v.n<3 OR(e.kind='PAYOUT' AND i.fee_cents>0))
$$;


--
-- Name: withdrawal_read_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.withdrawal_read_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=NEW.user_id;IF NOT FOUND THEN RAISE EXCEPTION 'controlled wallet coverage absent' USING ERRCODE='23514';END IF;RETURN NULL;END $$;


--
-- Name: withdrawal_wallet_revision(); Type: FUNCTION; Schema: zzsh_order; Owner: -
--

CREATE FUNCTION zzsh_order.withdrawal_wallet_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET ledger_revision=ledger_revision+1,read_revision=read_revision+1 WHERE user_id=NEW.subject_user_id;IF NOT FOUND THEN RAISE EXCEPTION 'controlled wallet coverage absent' USING ERRCODE='23514';END IF;RETURN NULL;END $$;


--
-- Name: assert_listing_publication_final(text); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.assert_listing_publication_final(p_version_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  version_state text;
  publication_source text;
  publication_version_id text;
  publication_account_id text;
  publication_owner_user_id text;
  publication_game_id text;
  publication_rule_release_id text;
  publication_content_hash text;
  version_account_id text;
  version_owner_user_id text;
  version_game_id text;
  version_rule_release_id text;
  version_content_hash text;
  has_publication boolean;
BEGIN
  SELECT v.review_state,v.account_id,v.rule_release_id,v.content_hash,a.owner_user_id,a.game_id
    INTO version_state,version_account_id,version_rule_release_id,version_content_hash,version_owner_user_id,version_game_id
    FROM zzsh_supply.listing_version v
    JOIN zzsh_supply.rental_account a ON a.id=v.account_id
   WHERE v.id=p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing version for publication consistency is missing' USING ERRCODE='40001';
  END IF;

  SELECT p.version_id,p.source,p.account_id,p.owner_user_id,p.game_id,p.rule_release_id,p.content_hash
    INTO publication_version_id,publication_source,publication_account_id,publication_owner_user_id,publication_game_id,publication_rule_release_id,publication_content_hash
    FROM zzsh_supply.listing_publication p
   WHERE p.version_id=p_version_id;
  has_publication := FOUND;

  IF version_state='PUBLISHED' THEN
    IF NOT has_publication OR publication_source<>'OWNER_DIRECT' THEN
      RAISE EXCEPTION 'published version requires an OWNER_DIRECT publication fact' USING ERRCODE='40001';
    END IF;
  ELSIF version_state='APPROVED' THEN
    IF NOT has_publication OR publication_source<>'LEGACY_APPROVED' THEN
      RAISE EXCEPTION 'approved version requires a LEGACY_APPROVED publication fact' USING ERRCODE='40001';
    END IF;
  ELSIF has_publication THEN
    RAISE EXCEPTION 'a publication fact cannot belong to this listing state' USING ERRCODE='40001';
  END IF;

  IF has_publication AND (
    publication_version_id IS DISTINCT FROM p_version_id
    OR publication_account_id IS DISTINCT FROM version_account_id
    OR publication_owner_user_id IS DISTINCT FROM version_owner_user_id
    OR publication_game_id IS DISTINCT FROM version_game_id
    OR publication_rule_release_id IS DISTINCT FROM version_rule_release_id
    OR publication_content_hash IS DISTINCT FROM version_content_hash
  ) THEN
    RAISE EXCEPTION 'publication does not match final listing snapshot' USING ERRCODE='40001';
  END IF;

  IF has_publication AND publication_source='LEGACY_APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
      JOIN zzsh_supply.listing_publication p ON p.version_id=d.version_id
     WHERE d.version_id=p_version_id AND d.release_id=version_rule_release_id
       AND d.content_hash=version_content_hash AND d.decision='APPROVE'
       AND p.published_by_admin_id=d.reviewer_admin_id AND p.published_at=d.decided_at
  ) THEN
    RAISE EXCEPTION 'legacy publication has no exact approval' USING ERRCODE='40001';
  END IF;
END $$;


--
-- Name: guard_account_guarantee_proof_immutable(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_account_guarantee_proof_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'account guarantee proof is append-only' USING ERRCODE='40001';
END $$;


--
-- Name: guard_account_guarantee_proof_insert(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_account_guarantee_proof_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  account_row record;
  current_row record;
  policy jsonb;
  previous record;
  expected_version bigint;
  required_permission_code text;
  has_permission boolean;
BEGIN
  SELECT id,owner_user_id,game_id INTO account_row
    FROM zzsh_supply.rental_account WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR account_row.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'guarantee proof account owner mismatch' USING ERRCODE='40001';
  END IF;
  SELECT g.current_release_id AS release_id,r.price_version_id,p.funding_policy AS funding_policy
    INTO current_row
    FROM zzsh_supply.game g
    JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=g.id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
   WHERE g.id=account_row.game_id AND g.enabled;
  IF NOT FOUND OR current_row.funding_policy IS NULL OR NOT zzsh_supply.valid_funding_policy(current_row.funding_policy)
     OR current_row.price_version_id IS DISTINCT FROM NEW.price_version_id THEN
    RAISE EXCEPTION 'guarantee proof is not bound to the current funding policy' USING ERRCODE='40001';
  END IF;
  policy := current_row.funding_policy;
  IF NEW.policy_version IS DISTINCT FROM policy->>'policyVersion' THEN
    RAISE EXCEPTION 'guarantee proof policy version mismatch' USING ERRCODE='40001';
  END IF;

  SELECT id,version_no,status,required_cents,covered_cents INTO previous
    FROM zzsh_supply.account_guarantee_proof
   WHERE account_id=NEW.account_id ORDER BY version_no DESC LIMIT 1;
  expected_version := COALESCE(previous.version_no,0)+1;
  IF NEW.version_no IS DISTINCT FROM expected_version
     OR NEW.supersedes_id IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'guarantee proof append version is stale' USING ERRCODE='40001';
  END IF;

  required_permission_code := CASE WHEN NEW.status='REVOKED' THEN 'supply.guarantee.revoke' ELSE 'supply.guarantee.verify' END;
  SELECT EXISTS (
    SELECT 1 FROM zzsh_iam.admin_security s
     WHERE s.admin_user_id=NEW.verified_by_admin_id AND s.status='ACTIVE'
       AND (
         s.is_boss
         OR (
           (
             EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_role AS ur
               JOIN zzsh_iam.admin_role AS r ON r.id=ur.role_id AND r.status='ACTIVE'
               JOIN zzsh_iam.admin_role_permission AS rp ON rp.role_id=r.id AND rp.permission_code=required_permission_code
              WHERE ur.admin_user_id=NEW.verified_by_admin_id
             )
             OR EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_permission AS up
                WHERE up.admin_user_id=NEW.verified_by_admin_id
                  AND up.permission_code=required_permission_code AND up.effect='ALLOW'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM zzsh_iam.admin_user_permission AS deny
              WHERE deny.admin_user_id=NEW.verified_by_admin_id
                AND deny.permission_code=required_permission_code AND deny.effect='DENY'
           )
         )
       )
  ) INTO has_permission;
  IF NOT has_permission THEN RAISE EXCEPTION 'guarantee proof verifier is not authorized' USING ERRCODE='42501'; END IF;

  NEW.valid_from := clock_timestamp();
  NEW.created_at := NEW.valid_from;
  IF NEW.status='SATISFIED' THEN
    IF policy->'guaranteeRequirement'->>'mode' IS DISTINCT FROM 'FIXED_CENTS'
       OR NEW.required_cents IS DISTINCT FROM (policy->'guaranteeRequirement'->>'requiredCents')::numeric
       OR NEW.covered_cents < NEW.required_cents THEN
      RAISE EXCEPTION 'guarantee proof coverage is insufficient' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NEW.valid_from + ((policy->'proofValidity'->>'satisfiedDays')::numeric * interval '1 day');
  ELSIF NEW.status='NOT_REQUIRED' THEN
    IF policy->'guaranteeRequirement'->>'mode' IS DISTINCT FROM 'NOT_REQUIRED'
       OR NEW.required_cents <> 0 OR NEW.covered_cents <> 0 THEN
      RAISE EXCEPTION 'guarantee proof cannot waive the current requirement' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NULL;
  ELSE
    IF previous.id IS NULL OR previous.status='REVOKED'
       OR NEW.required_cents IS DISTINCT FROM previous.required_cents
       OR NEW.covered_cents IS DISTINCT FROM previous.covered_cents THEN
      RAISE EXCEPTION 'guarantee proof revoke is invalid' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NEW.valid_from;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_account_public_number(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_account_public_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE allocating boolean := TG_OP='INSERT'; day date;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.display_no IS NOT NULL AND NEW.display_no IS DISTINCT FROM OLD.display_no THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_IMMUTABLE';
    END IF;
    allocating := OLD.display_no IS NULL;
  END IF;
  IF NEW.display_no IS NOT NULL AND (btrim(NEW.display_no)='' OR btrim(NEW.display_no)<>NEW.display_no OR length(NEW.display_no)>128 OR NEW.display_no ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
  END IF;
  IF allocating AND NEW.display_no IS NOT NULL THEN
    IF NEW.display_no !~ '^ZZ[0-9]{14}$' OR substring(NEW.display_no FROM 11 FOR 6)='000000' THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
    END IF;
    BEGIN
      day := make_date(substring(NEW.display_no FROM 3 FOR 4)::integer,substring(NEW.display_no FROM 7 FOR 2)::integer,substring(NEW.display_no FROM 9 FOR 2)::integer);
    EXCEPTION WHEN datetime_field_overflow THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
    END;
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_agreement_version_update(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_agreement_version_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."status", NEW."game_id", NEW."title", NEW."body", NEW."digest", NEW."revision",
        NEW."created_by_admin_id", NEW."created_at", NEW."sealed_at", NEW."sealed_by_admin_id")
       IS DISTINCT FROM
       (OLD."status", OLD."game_id", OLD."title", OLD."body", OLD."digest", OLD."revision",
        OLD."created_by_admin_id", OLD."created_at", OLD."sealed_at", OLD."sealed_by_admin_id") THEN
      RAISE EXCEPTION 'sealed agreement version is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_asset_account(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_asset_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN RAISE EXCEPTION 'asset account is immutable'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_compat_price_line(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_compat_price_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent record;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.price_version_id,NEW.item_id,NEW.customer_tier) IS DISTINCT FROM (OLD.price_version_id,OLD.item_id,OLD.customer_tier) THEN RAISE EXCEPTION 'price line identity is immutable' USING ERRCODE='40001'; END IF;
  SELECT * INTO parent FROM zzsh_supply.price_version WHERE id=NEW.price_version_id FOR UPDATE;
  IF NEW.customer_tier<>'STANDARD' AND (parent.mode<>'SPREAD' OR parent.haff_rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2') THEN RAISE EXCEPTION 'tier pricing requires compatibility SPREAD'; END IF;
  IF EXISTS(SELECT 1 FROM zzsh_supply.price_line l WHERE l.price_version_id=NEW.price_version_id AND l.item_id=NEW.item_id AND l.id<>NEW.id
    AND (l.pricing_kind,l.unit_quantity,l.owner_unit_amount) IS DISTINCT FROM (NEW.pricing_kind,NEW.unit_quantity,NEW.owner_unit_amount)) THEN RAISE EXCEPTION 'owner price and unit must agree across tiers'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_compat_price_version(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_compat_price_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id AND customer_tier<>'STANDARD')
    AND (NEW.mode<>'SPREAD' OR NEW.haff_rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2') THEN RAISE EXCEPTION 'tier lines require compatible rule'; END IF;
  IF NEW.status='SEALED' AND NEW.haff_rule->>'schema'='haff-ratio-v2' AND EXISTS(
    SELECT 1 FROM zzsh_supply.price_line l WHERE l.price_version_id=NEW.id AND NOT EXISTS(
      SELECT 1 FROM zzsh_supply.price_line s WHERE s.price_version_id=l.price_version_id AND s.item_id=l.item_id AND s.customer_tier='STANDARD')) THEN RAISE EXCEPTION 'STANDARD price required'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_detail_parents(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_detail_parents() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  parent_table text;
  parent_key text;
  old_id text;
  new_id text;
  parent record;
  parent_game text;
  item_game text;
BEGIN
  parent_table := CASE WHEN TG_TABLE_NAME = 'price_line' THEN 'price_version' ELSE 'term_version' END;
  parent_key := CASE WHEN TG_TABLE_NAME = 'price_line' THEN 'price_version_id' ELSE 'version_id' END;
  IF TG_OP <> 'INSERT' THEN old_id := to_jsonb(OLD)->>parent_key; END IF;
  IF TG_OP <> 'DELETE' THEN new_id := to_jsonb(NEW)->>parent_key; END IF;
  FOR parent IN EXECUTE format('SELECT id, status, game_id FROM zzsh_supply.%I WHERE id = ANY($1) ORDER BY id FOR UPDATE', parent_table)
    USING ARRAY[old_id, new_id]
  LOOP
    IF parent.status = 'SEALED' THEN RAISE EXCEPTION 'sealed detail is immutable' USING ERRCODE = '40001'; END IF;
    IF parent.id = new_id THEN parent_game := parent.game_id; END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF parent_game IS NULL THEN RAISE EXCEPTION 'parent does not exist'; END IF;
  IF TG_TABLE_NAME = 'price_line' THEN
    SELECT game_id INTO item_game FROM zzsh_supply.billable_item WHERE id = NEW.item_id FOR UPDATE;
    IF item_game IS DISTINCT FROM parent_game THEN RAISE EXCEPTION 'price item belongs to another game'; END IF;
  END IF;
  RETURN NEW;
END $_$;


--
-- Name: guard_full_payout_acceptance(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_full_payout_acceptance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE binding record;
BEGIN
  SELECT a.game_id,v.payload,p.funding_policy AS policy INTO binding
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.account_id=a.id
    JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id AND v.rule_release_id=r.id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.status='SEALED'
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND v.content_hash=NEW.accepted_content_hash;
  IF binding.payload#>>'{declaration,attributes,full_payout_declaration,selected}'='true' THEN
    IF NOT EXISTS (SELECT 1 FROM zzsh_supply.full_payout_terms_version t
       WHERE t.id=NEW.full_payout_terms_version_id AND t.game_id=binding.game_id AND t.status='SEALED'
         AND t.policy_ref=binding.policy->>'fullPayoutPolicyRef' AND t.policy_version=binding.policy->>'fullPayoutPolicyVersion'
         AND t.disclosure_version=binding.policy->>'disclosureVersion'
         AND t.digest=NEW.full_payout_terms_digest AND t.disclosure_version=NEW.full_payout_disclosure_version
         AND EXISTS(SELECT 1 FROM zzsh_supply.price_version p JOIN zzsh_supply.rule_release r ON r.price_version_id=p.id
           WHERE r.id=NEW.rule_release_id AND p.full_payout_terms_version_id=t.id
             AND p.full_payout_terms_digest=t.digest AND p.full_payout_disclosure_version=t.disclosure_version)) THEN
      RAISE EXCEPTION 'full-payout terms acceptance is missing or changed' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.full_payout_terms_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'full-payout terms acceptance does not apply' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_full_payout_price_reference(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_full_payout_price_reference() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='SEALED'
    AND (NEW.full_payout_terms_version_id,NEW.full_payout_terms_digest,NEW.full_payout_disclosure_version)
      IS DISTINCT FROM (OLD.full_payout_terms_version_id,OLD.full_payout_terms_digest,OLD.full_payout_disclosure_version) THEN
    RAISE EXCEPTION 'sealed price terms binding is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status='SEALED' AND (TG_OP='INSERT' OR OLD.status='DRAFT') AND NEW.funding_policy IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM zzsh_supply.full_payout_terms_version t
      WHERE t.id=NEW.full_payout_terms_version_id AND t.game_id=NEW.game_id AND t.status='SEALED'
        AND t.digest=NEW.full_payout_terms_digest AND t.disclosure_version=NEW.full_payout_disclosure_version
        AND t.policy_ref=NEW.funding_policy->>'fullPayoutPolicyRef'
        AND t.policy_version=NEW.funding_policy->>'fullPayoutPolicyVersion'
        AND t.disclosure_version=NEW.funding_policy->>'disclosureVersion') THEN
    RAISE EXCEPTION 'price references missing or unsealed full-payout terms' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_full_payout_terms_version(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_full_payout_terms_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' THEN RAISE EXCEPTION 'full-payout terms must start as draft' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.status='SEALED' THEN
    RAISE EXCEPTION 'full-payout terms identity or sealed body is immutable' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.game_id,NEW.policy_ref,NEW.policy_version,NEW.created_by_admin_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.game_id,OLD.policy_ref,OLD.policy_version,OLD.created_by_admin_id,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'full-payout terms identity or revision changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_item_semantics(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_item_semantics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id, NEW.game_id, NEW.code, NEW.unit, NEW.quantity_scale) IS DISTINCT FROM
     (OLD.id, OLD.game_id, OLD.code, OLD.unit, OLD.quantity_scale)
     AND EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION 'referenced billing semantics require a new item' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_legacy_display_snapshot(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_legacy_display_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h
    WHERE h.account_id=NEW.account_id AND h.observation_version_id=NEW.observation_version_id
      AND h.source_digest=NEW.base_source_digest AND h.source_updated_at=NEW.source_updated_at)
    AND EXISTS (SELECT 1 FROM zzsh_supply.listing_version v WHERE v.id=NEW.observation_version_id AND v.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'legacy display snapshot must bind the original read snapshot';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_legacy_read_snapshot(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_legacy_read_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_supply.legacy_supply_map m
    JOIN zzsh_supply.listing_version v ON v.id=m.version_id
    WHERE m.source_system=NEW.source_system AND m.source_entity=NEW.source_entity AND m.legacy_id=NEW.legacy_id
      AND m.account_id=NEW.account_id AND m.version_id=NEW.observation_version_id AND m.source_digest=NEW.source_digest
      AND v.origin='LEGACY_OBSERVATION' AND v.review_state='IMPORTED_UNVERIFIED'
  ) THEN RAISE EXCEPTION 'Legacy read snapshot must bind the immutable source observation'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_legacy_skin_holding(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_legacy_skin_holding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'legacy_skin_holding is append-only' USING ERRCODE='40001';
  END IF;
  SELECT account_id,origin,review_state INTO parent
    FROM zzsh_supply.listing_version WHERE id=NEW.observation_version_id;
  IF parent.account_id IS DISTINCT FROM NEW.account_id
     OR parent.origin IS DISTINCT FROM 'LEGACY_OBSERVATION'
     OR parent.review_state IS DISTINCT FROM 'IMPORTED_UNVERIFIED' THEN
    RAISE EXCEPTION 'legacy_skin_holding requires its own immutable legacy observation'
      USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_legacy_takeover_authorization(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_legacy_takeover_authorization() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.acceptance_kind='LEGACY_TAKEOVER_AUTHORIZED' AND NOT EXISTS(
   SELECT 1 FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id
    JOIN zzsh_supply.listing_version v ON v.account_id=a.id AND v.id=NEW.listing_version_id
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND a.legacy_hold='NONE' AND v.origin='NATIVE'
    AND v.content_hash=NEW.accepted_content_hash AND v.rule_release_id=NEW.rule_release_id
    AND v.attributes#>>'{full_payout_declaration,selected}'='false'
    AND m.source_system=NEW.authorization_evidence->>'sourceSystem' AND m.source_entity=NEW.authorization_evidence->>'sourceEntity'
    AND m.legacy_id=NEW.authorization_evidence->>'legacyId' AND m.source_digest=NEW.authorization_evidence->>'sourceDigest'
    AND m.version_id=NEW.authorization_evidence->>'observationVersionId'
    AND NEW.authorization_evidence->>'authorizingAdminId'=current_setting('zzsh.actor_id',true)
    AND current_setting('zzsh.actor_type',true)='admin')
 THEN RAISE EXCEPTION 'Legacy takeover authorization lacks exact source/version/admin or owner terms required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_listing_acceptance(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_acceptance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE version record;
BEGIN
 SELECT * INTO version FROM zzsh_supply.listing_version WHERE id=NEW.listing_version_id FOR UPDATE;
 IF version.origin<>'NATIVE' OR version.review_state<>'DRAFT' OR version.content_hash IS DISTINCT FROM NEW.accepted_content_hash OR version.rule_release_id IS DISTINCT FROM NEW.rule_release_id THEN RAISE EXCEPTION 'acceptance does not match quoted content'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_listing_child(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_child() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent record; new_id text; old_id text; target_game text; asset record;
BEGIN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.version_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.version_id; END IF;
  FOR parent IN SELECT v.*,a.game_id,a.owner_user_id FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id WHERE v.id=ANY(ARRAY[old_id,new_id]) ORDER BY v.id FOR UPDATE OF v LOOP
    IF parent.review_state<>'DRAFT' THEN RAISE EXCEPTION 'submitted listing children are immutable' USING ERRCODE='40001'; END IF;
    UPDATE zzsh_supply.listing_version SET payload=NULL,content_hash=NULL,rule_release_id=NULL WHERE id=parent.id;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT v.*,a.game_id,a.owner_user_id INTO parent FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id WHERE v.id=new_id;
  IF TG_TABLE_NAME='inventory_line' THEN SELECT game_id INTO target_game FROM zzsh_supply.billable_item WHERE id=NEW.item_id;
  ELSIF TG_TABLE_NAME='listing_skin' THEN SELECT game_id INTO target_game FROM zzsh_supply.skin WHERE id=NEW.skin_id;
  ELSIF TG_TABLE_NAME='listing_entitlement' THEN SELECT game_id INTO target_game FROM zzsh_supply.entitlement WHERE id=NEW.entitlement_id;
  ELSE
    SELECT * INTO asset FROM zzsh_supply.media_asset WHERE id=NEW.asset_id;
    target_game:=asset.game_id;
    IF asset.account_id IS DISTINCT FROM parent.account_id OR asset.owner_user_id IS DISTINCT FROM parent.owner_user_id OR asset.purpose NOT IN ('ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY') THEN RAISE EXCEPTION 'media belongs to another account'; END IF;
  END IF;
  IF target_game IS DISTINCT FROM parent.game_id THEN RAISE EXCEPTION 'listing child belongs to another game'; END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_listing_commitments(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_commitments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.review_state<>'DRAFT' THEN
    RAISE EXCEPTION 'a listing starts as a draft';
  END IF;
  IF NEW.review_state IN ('SUBMITTED','APPROVED','PUBLISHED') AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.rule_acceptance r
     WHERE r.listing_version_id=NEW.id AND r.account_id=NEW.account_id
       AND r.rule_release_id=NEW.rule_release_id AND r.accepted_content_hash=NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'submitted content requires matching acceptance';
  END IF;
  IF NEW.review_state='APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
     WHERE d.version_id=NEW.id AND d.release_id=NEW.rule_release_id
       AND d.content_hash=NEW.content_hash AND d.decision='APPROVE'
  ) THEN
    RAISE EXCEPTION 'approval requires an exact decision';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_listing_content(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.sequence,NEW.origin) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.sequence,OLD.origin) THEN
    RAISE EXCEPTION 'listing identity is immutable';
  END IF;
  IF OLD.review_state <> 'DRAFT' AND (to_jsonb(NEW)-'review_state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'review_state'-'revision') THEN
    RAISE EXCEPTION 'submitted listing content is immutable';
  END IF;
  IF NEW.review_state IS DISTINCT FROM OLD.review_state AND NOT (
    (OLD.review_state='DRAFT' AND NEW.review_state IN ('SUBMITTED','IMPORTED_UNVERIFIED','PUBLISHED')) OR
    (OLD.review_state='SUBMITTED' AND NEW.review_state IN ('WITHDRAWN','APPROVED','REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid listing transition' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_listing_decision(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE v record;
BEGIN
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=NEW.version_id FOR UPDATE;
 IF v.review_state<>'SUBMITTED' OR v.content_hash IS DISTINCT FROM NEW.content_hash OR v.rule_release_id IS DISTINCT FROM NEW.release_id THEN RAISE EXCEPTION 'decision requires exact submitted content' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_listing_filter_config(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_filter_config() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE previous bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'filter revisions are immutable' USING ERRCODE='40001'; END IF;
  PERFORM id FROM zzsh_supply.game WHERE id=NEW.game_id FOR UPDATE;
  SELECT COALESCE(max(revision),0) INTO previous FROM zzsh_supply.listing_filter_config WHERE game_id=NEW.game_id;
  IF NEW.revision<>previous+1 THEN RAISE EXCEPTION 'filter revision changed' USING ERRCODE='40001'; END IF;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;


--
-- Name: guard_listing_publication_consistency(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_publication_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM zzsh_supply.assert_listing_publication_final(
    CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END
  );
  RETURN COALESCE(NEW,OLD);
END $$;


--
-- Name: guard_listing_publication_immutable(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_publication_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'listing publication is immutable' USING ERRCODE='40001';
END $$;


--
-- Name: guard_listing_publication_shape(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_publication_shape() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  listing_row record;
BEGIN
  SELECT lv.*,ra.owner_user_id AS actual_owner,ra.game_id AS actual_game
    INTO listing_row
    FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.rental_account ra ON ra.id=lv.account_id
   WHERE lv.id=NEW.version_id AND ra.id=NEW.account_id
   FOR UPDATE OF lv;
  IF NOT FOUND
     OR listing_row.actual_owner IS DISTINCT FROM NEW.owner_user_id
     OR listing_row.actual_game IS DISTINCT FROM NEW.game_id
     OR listing_row.rule_release_id IS DISTINCT FROM NEW.rule_release_id
     OR listing_row.content_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'publication does not match listing snapshot' USING ERRCODE='40001';
  END IF;
  IF NEW.source='OWNER_DIRECT' AND listing_row.review_state NOT IN ('DRAFT','PUBLISHED') THEN
    RAISE EXCEPTION 'direct publication requires the owner draft';
  END IF;
  IF NEW.source='LEGACY_APPROVED' AND listing_row.review_state<>'APPROVED' THEN
    RAISE EXCEPTION 'legacy publication requires an approved version';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM zzsh_supply.rule_acceptance r
     WHERE r.owner_user_id=NEW.owner_user_id AND r.listing_version_id=NEW.version_id
       AND r.account_id=NEW.account_id AND r.rule_release_id=NEW.rule_release_id
       AND r.accepted_content_hash=NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'publication requires matching rule acceptance';
  END IF;
  IF NEW.source='LEGACY_APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
     WHERE d.version_id=NEW.version_id AND d.release_id=NEW.rule_release_id
       AND d.content_hash=NEW.content_hash AND d.decision='APPROVE'
       AND d.reviewer_admin_id=NEW.published_by_admin_id AND d.decided_at=NEW.published_at
  ) THEN
    RAISE EXCEPTION 'legacy publication requires an exact approval';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_listing_version_publication(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_listing_version_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM zzsh_supply.assert_listing_publication_final(NEW.id);
  RETURN NEW;
END $$;


--
-- Name: guard_media_asset_mutation(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_media_asset_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."game_id" IS DISTINCT FROM OLD."game_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."ownership_kind" IS DISTINCT FROM OLD."ownership_kind"
     OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
     OR NEW."uploaded_by_realm" IS DISTINCT FROM OLD."uploaded_by_realm"
     OR NEW."uploaded_by_user_id" IS DISTINCT FROM OLD."uploaded_by_user_id"
     OR NEW."uploaded_by_admin_id" IS DISTINCT FROM OLD."uploaded_by_admin_id"
     OR NEW."mime" IS DISTINCT FROM OLD."mime"
     OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
     OR NEW."width" IS DISTINCT FROM OLD."width"
     OR NEW."height" IS DISTINCT FROM OLD."height"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'media asset file reference is immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_price_line_mutation(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_price_line_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  version_id text;
  parent_mode text;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."price_version_id";
  ELSE
    version_id := NEW."price_version_id";
  END IF;
  SELECT "mode", "status" INTO parent_mode, parent_status
    FROM "zzsh_supply"."price_version" WHERE "id" = version_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'price version does not exist';
  END IF;
  IF parent_status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed price version lines are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF parent_mode = 'SPREAD' AND NEW."pricing_kind" = 'FIXED_UNIT' THEN
    IF NEW."unit_quantity" IS NULL OR NEW."unit_quantity" <= 0
       OR NEW."buyer_unit_amount" IS NULL OR NEW."owner_unit_amount" IS NULL
       OR NEW."owner_unit_amount" > NEW."buyer_unit_amount" THEN
      RAISE EXCEPTION 'spread fixed lines require buyer and owner unit amounts';
    END IF;
  ELSIF parent_mode = 'PERCENT' AND NEW."pricing_kind" = 'FIXED_UNIT' THEN
    IF NEW."unit_quantity" IS NULL OR NEW."unit_quantity" <= 0
       OR NEW."buyer_unit_amount" IS NULL OR NEW."owner_unit_amount" IS NOT NULL THEN
      RAISE EXCEPTION 'percent fixed lines require only the buyer unit amount';
    END IF;
  ELSE
    IF NEW."unit_quantity" IS NOT NULL OR NEW."buyer_unit_amount" IS NOT NULL OR NEW."owner_unit_amount" IS NOT NULL THEN
      RAISE EXCEPTION 'haff ratio lines cannot define unit amounts';
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_price_version_update(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_price_version_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'SEALED' THEN
    IF (NEW.status,NEW.game_id,NEW.mode,NEW.commission_rate,NEW.haff_rule,NEW.rounding_policy,
        NEW.compensation_policy_ref,NEW.funding_policy,NEW.revision,NEW.created_by_admin_id,
        NEW.created_at,NEW.sealed_at,NEW.sealed_by_admin_id)
       IS DISTINCT FROM
       (OLD.status,OLD.game_id,OLD.mode,OLD.commission_rate,OLD.haff_rule,OLD.rounding_policy,
        OLD.compensation_policy_ref,OLD.funding_policy,OLD.revision,OLD.created_by_admin_id,
        OLD.created_at,OLD.sealed_at,OLD.sealed_by_admin_id) THEN
      RAISE EXCEPTION 'sealed price version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'SEALED' THEN
    IF EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id AND pricing_kind='HAFF_RATIO')
       AND NEW.haff_rule IS NULL THEN RAISE EXCEPTION 'haff rule is required for haff ratio lines'; END IF;
    IF NOT EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id)
       THEN RAISE EXCEPTION 'price version requires at least one line'; END IF;
    IF NEW.funding_policy IS NOT NULL AND NOT zzsh_supply.valid_funding_policy(NEW.funding_policy)
       THEN RAISE EXCEPTION 'funding policy is invalid'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_public_derivative(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_public_derivative() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.public_storage_key IS DISTINCT FROM OLD.public_storage_key THEN
    RAISE EXCEPTION 'public derivative is immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_release_immutable(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_release_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'release is immutable' USING ERRCODE = '40001';
END $$;


--
-- Name: guard_rental_identity(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_rental_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF (NEW.id,NEW.owner_user_id,NEW.game_id) IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.game_id) THEN RAISE EXCEPTION 'rental account identity is immutable'; END IF;
 RETURN NEW;
END $$;


--
-- Name: guard_rule_release_insert(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_rule_release_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  price_row record;
  term_row record;
  agreement_row record;
BEGIN
  SELECT "game_id", "status" INTO price_row FROM "zzsh_supply"."price_version" WHERE "id" = NEW."price_version_id";
  SELECT "game_id", "status" INTO term_row FROM "zzsh_supply"."term_version" WHERE "id" = NEW."term_version_id";
  SELECT "game_id", "status" INTO agreement_row FROM "zzsh_supply"."agreement_version" WHERE "id" = NEW."agreement_version_id";
  IF price_row IS NULL OR term_row IS NULL OR agreement_row IS NULL THEN
    RAISE EXCEPTION 'rule release versions must exist';
  END IF;
  IF price_row."status" <> 'SEALED' OR term_row."status" <> 'SEALED' OR agreement_row."status" <> 'SEALED' THEN
    RAISE EXCEPTION 'rule release versions must be sealed';
  END IF;
  IF price_row."game_id" <> NEW."game_id" OR term_row."game_id" <> NEW."game_id" OR agreement_row."game_id" <> NEW."game_id" THEN
    RAISE EXCEPTION 'rule release versions must belong to the same game';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_sealed_term_version(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_sealed_term_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."status", NEW."game_id", NEW."revision", NEW."created_by_admin_id", NEW."created_at", NEW."sealed_at", NEW."sealed_by_admin_id")
       IS DISTINCT FROM
       (OLD."status", OLD."game_id", OLD."revision", OLD."created_by_admin_id", OLD."created_at", OLD."sealed_at", OLD."sealed_by_admin_id") THEN
      RAISE EXCEPTION 'sealed term version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'SEALED' AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."term_option" WHERE "version_id" = NEW."id") THEN
    RAISE EXCEPTION 'term version requires at least one option';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_skin_category_tree(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_skin_category_tree() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cursor_id text;
  cursor_game text;
  cursor_parent text;
  levels integer := 0;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."parent_id" = NEW."id" THEN
    RAISE EXCEPTION 'skin category cannot be its own parent';
  END IF;
  cursor_id := NEW."parent_id";
  WHILE cursor_id IS NOT NULL LOOP
    levels := levels + 1;
    IF levels > 2 THEN
      RAISE EXCEPTION 'skin category depth exceeds three levels';
    END IF;
    SELECT c."game_id", c."parent_id" INTO cursor_game, cursor_parent
      FROM "zzsh_supply"."skin_category" c WHERE c."id" = cursor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'skin category parent does not exist';
    END IF;
    IF cursor_game <> NEW."game_id" THEN
      RAISE EXCEPTION 'skin category parent belongs to another game';
    END IF;
    IF cursor_parent = NEW."id" THEN
      RAISE EXCEPTION 'skin category cycle detected';
    END IF;
    cursor_id := cursor_parent;
  END LOOP;
  RETURN NEW;
END $$;


--
-- Name: guard_skin_identity_write(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_skin_identity_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  object_name text;
  object_enabled boolean;
  relation_changed boolean;
  identity_changed boolean;
  unclassified_melee boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.naming_state <> 'PENDING' OR NEW.owner_kind IS NOT NULL OR NEW.base_name IS NOT NULL THEN
      RAISE EXCEPTION 'SKIN_CREATE_DRAFT_FIRST';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.game_id, NEW.code, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.game_id, OLD.code, OLD.created_at) THEN
    RAISE EXCEPTION 'SKIN_STABLE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.naming_state IS DISTINCT FROM OLD.naming_state THEN
    RAISE EXCEPTION 'SKIN_NAMING_STATE_IS_DERIVED';
  END IF;
  IF OLD.source_namespace IS NOT NULL AND
     (NEW.source_namespace, NEW.source_field, NEW.source_token) IS DISTINCT FROM (OLD.source_namespace, OLD.source_field, OLD.source_token) THEN
    RAISE EXCEPTION 'SKIN_PRIMARY_SOURCE_IMMUTABLE';
  END IF;
  IF OLD.source_namespace IS NULL AND OLD.source_field IS NOT NULL AND
     (NEW.source_field, NEW.source_token) IS DISTINCT FROM (OLD.source_field, OLD.source_token) THEN
    RAISE EXCEPTION 'SKIN_LEGACY_SOURCE_MUST_BE_PRESERVED';
  END IF;
  relation_changed := (NEW.owner_kind, NEW.owner_id, NEW.firearm_id) IS DISTINCT FROM (OLD.owner_kind, OLD.owner_id, OLD.firearm_id);
  identity_changed := relation_changed OR NEW.base_name IS DISTINCT FROM OLD.base_name;
  IF NEW.owner_kind IS NOT NULL AND NEW.base_name IS NOT NULL THEN NEW.naming_state := 'VERIFIED'; END IF;
  IF OLD.naming_state = 'VERIFIED' AND (NEW.owner_kind IS NULL OR NEW.base_name IS NULL) THEN
    RAISE EXCEPTION 'SKIN_VERIFIED_IDENTITY_CANNOT_BE_CLEARED';
  END IF;
  IF OLD.naming_state = 'LEGACY' AND NEW.naming_state = 'LEGACY' AND
     ((NOT OLD.enabled AND NEW.enabled) OR (NOT OLD.form_visible AND NEW.form_visible)) THEN
    RAISE EXCEPTION 'SKIN_LEGACY_REENABLE_REQUIRES_REVIEW';
  END IF;
  IF NEW.naming_state = 'VERIFIED' AND
     (OLD.naming_state <> 'VERIFIED' OR identity_changed OR NEW.name IS DISTINCT FROM OLD.name) THEN
    unclassified_melee := NEW.owner_kind = 'MELEE_TYPE' AND NEW.owner_id IS NULL;
    IF unclassified_melee THEN
      object_name := ''; object_enabled := true;
    ELSIF NEW.owner_kind = 'FIREARM' THEN
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.firearm WHERE game_id = NEW.game_id AND id = NEW.firearm_id;
    ELSE
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.skin_owner WHERE game_id = NEW.game_id AND kind = NEW.owner_kind AND id = NEW.owner_id;
    END IF;
    IF object_name IS NULL THEN RAISE EXCEPTION 'SKIN_OWNER_NOT_FOUND'; END IF;
    IF (OLD.naming_state <> 'VERIFIED' OR relation_changed) AND NOT object_enabled THEN RAISE EXCEPTION 'SKIN_OWNER_DISABLED'; END IF;
    IF NEW.name IS DISTINCT FROM (CASE WHEN unclassified_melee THEN NEW.base_name ELSE object_name || '-' || NEW.base_name END) THEN
      RAISE EXCEPTION 'SKIN_DISPLAY_NAME_MISMATCH';
    END IF;
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.name = ANY(NEW.aliases)) THEN RAISE EXCEPTION 'SKIN_RENAME_MUST_KEEP_OLD_ALIAS'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;


--
-- Name: guard_term_option_mutation(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_term_option_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  version_id text;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."version_id";
  ELSE
    version_id := NEW."version_id";
  END IF;
  SELECT "status" INTO parent_status FROM "zzsh_supply"."term_version" WHERE "id" = version_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'term version does not exist';
  END IF;
  IF parent_status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed term version options are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: guard_version_identity(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.guard_version_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.game_id IS DISTINCT FROM OLD.game_id
     OR (OLD.status = 'SEALED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'version identity and sealed content are immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: jsonb_exact_keys(jsonb, text[]); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.jsonb_exact_keys(doc jsonb, keys text[]) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (SELECT count(*) FROM jsonb_object_keys(doc)) = cardinality(keys)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(doc) AS item(key)
       WHERE NOT (item.key = ANY(keys))
    );
END $$;


--
-- Name: next_account_display_no(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.next_account_display_no() RETURNS text
    LANGUAGE sql
    AS $$
 SELECT 'AC'||CASE WHEN n<10000000000 THEN lpad(n::text,10,'0') ELSE n::text END
 FROM (SELECT nextval('zzsh_supply.account_display_no_seq') AS n) number_value;
$$;


--
-- Name: next_dated_account_display_no(); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.next_dated_account_display_no() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE business_day date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date; n integer;
BEGIN
  INSERT INTO zzsh_supply.account_display_no_counter AS counter(business_date,last_value)
  VALUES(business_day,1)
  ON CONFLICT(business_date) DO UPDATE SET last_value=counter.last_value+1
    WHERE counter.last_value<999999
  RETURNING last_value INTO n;
  IF n IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='ACCOUNT_NUMBER_DAY_EXHAUSTED';
  END IF;
  RETURN 'ZZ'||to_char(business_day,'YYYYMMDD')||lpad(n::text,6,'0');
END $$;


--
-- Name: skin_aliases_valid(text[]); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.skin_aliases_valid(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT value IS NOT NULL
    AND cardinality(value) <= 32
    AND (cardinality(value) = 0 OR (array_ndims(value) = 1 AND array_lower(value, 1) = 1))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS a(name)
      WHERE NOT zzsh_supply.skin_text_valid(name, 200, true)
    )
    AND cardinality(value) = (SELECT count(DISTINCT name COLLATE "C") FROM unnest(value) AS a(name))
$$;


--
-- Name: skin_text_valid(text, integer, boolean); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.skin_text_valid(value text, max_chars integer, canonical boolean) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT value IS NOT NULL
    AND char_length(value) BETWEEN 1 AND max_chars
    AND btrim(value, E' \t\n\r\f\013') <> ''
    AND (NOT canonical OR value = btrim(value, E' \t\n\r\f\013'))
$$;


--
-- Name: valid_compat_haff_rule(jsonb); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.valid_compat_haff_rule(rule jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE lane text; tier text; mode_name text; map_name text; entry record; cfg jsonb; bound jsonb; p numeric; v numeric; fast_enabled boolean;
BEGIN
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2'
    OR (rule - ARRAY['schema','baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption','compatibility']) <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH map_name IN ARRAY ARRAY['baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption'] LOOP
    IF jsonb_typeof(rule->map_name) IS DISTINCT FROM 'object' OR rule->map_name='{}'::jsonb THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(rule->map_name) LOOP
      IF jsonb_typeof(entry.value) IS DISTINCT FROM 'string' OR (entry.value#>>'{}') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
      IF map_name='baseBySafeBox' AND (entry.value#>>'{}')::numeric<=0 THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  cfg:=rule->'compatibility';
  -- Relaxed shape: compatibility may carry any subset of the lanes plus the required modes map.
  IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg-ARRAY['ordinary','fast','modes']<>'{}'::jsonb
    OR NOT (cfg ? 'modes') OR jsonb_typeof(cfg->'modes') IS DISTINCT FROM 'object'
    OR (cfg->'modes')-ARRAY['ordinary','custom','fast']<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(cfg->'modes'->mode_name) IS DISTINCT FROM 'object' OR jsonb_typeof(cfg->'modes'->mode_name->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF mode_name='ordinary' THEN
      IF (cfg->'modes'->mode_name)-'enabled'<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
      -- Disabled modes still limit their configuration keys to enabled/min/max, but their
      -- min/max content is only validated while the mode is enabled.
      IF (cfg->'modes'->mode_name)-ARRAY['enabled','min','max']<>'{}'::jsonb THEN RETURN false; END IF;
      IF (cfg->'modes'->mode_name->>'enabled')::boolean THEN
        IF NOT ((cfg->'modes'->mode_name) ? 'min') THEN RETURN false; END IF;
        FOREACH map_name IN ARRAY ARRAY['min','max'] LOOP
          -- 上限可省略；出现时（含 null）必须是合法的界值对象。
          IF map_name='max' AND NOT ((cfg->'modes'->mode_name) ? 'max') THEN CONTINUE; END IF;
          bound:=cfg->'modes'->mode_name->map_name;
          IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR bound-ARRAY['base','value']<>'{}'::jsonb
            OR COALESCE(bound->>'base','') NOT IN ('C','ABSOLUTE') OR jsonb_typeof(bound->'value') IS DISTINCT FROM 'string'
            OR (bound->>'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(cfg->'modes') m WHERE m.value->>'enabled'='true') THEN RETURN false; END IF;
  fast_enabled:=(cfg->'modes'->'fast'->>'enabled')::boolean;
  -- Lanes: ordinary is always required; fast is required only while enabled, and is validated
  -- whenever present so a stale lane can never bypass spreadDelta/discount rules.
  IF NOT (cfg ? 'fast') AND fast_enabled THEN RETURN false; END IF;
  FOREACH lane IN ARRAY ARRAY['ordinary','fast'] LOOP
    IF lane='fast' AND NOT (cfg ? 'fast') THEN CONTINUE; END IF;
    IF jsonb_typeof(cfg->lane) IS DISTINCT FROM 'object' OR (cfg->lane)-ARRAY['spreadDelta','discounts']<>'{}'::jsonb
      OR jsonb_typeof(cfg->lane->'spreadDelta') IS DISTINCT FROM 'string' OR (cfg->lane->>'spreadDelta') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR jsonb_typeof(cfg->lane->'discounts') IS DISTINCT FROM 'object' OR (cfg->lane->'discounts')-ARRAY['STANDARD','VIP','SVIP','DISCOUNT_USER']<>'{}'::jsonb THEN RETURN false; END IF;
    p:=(cfg->lane->>'spreadDelta')::numeric;
    FOREACH tier IN ARRAY ARRAY['STANDARD','VIP','SVIP','DISCOUNT_USER'] LOOP
      IF jsonb_typeof(cfg->lane->'discounts'->tier) IS DISTINCT FROM 'string' OR (cfg->lane->'discounts'->>tier) !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
      v:=(cfg->lane->'discounts'->>tier)::numeric;
      IF v>p OR (tier='STANDARD' AND v<>0) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $_$;


--
-- Name: valid_funding_policy(jsonb); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.valid_funding_policy(policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE parameters jsonb := policy->'recommendation'->'parameters';
BEGIN
  IF NOT zzsh_supply.valid_funding_policy_draft(policy) THEN RETURN false; END IF;
  IF policy->'recommendation'->>'schema' IS DISTINCT FROM 'deposit-recommendation-v2' THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinRules') AS rule(value) WHERE value->'firstCents' = 'null'::jsonb OR value->'subsequentCents' = 'null'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinOverrides') AS rule(value) WHERE value->'amountCents' = 'null'::jsonb)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['AGENT','MELEE_TYPE','FIREARM']) AS kind(value) WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinRules') AS rule(value) WHERE rule.value->>'ownerKind'=kind.value AND rule.value->'rarityCode'='null'::jsonb)) THEN RETURN false; END IF;
  RETURN true;
END $$;


--
-- Name: valid_funding_policy_draft(jsonb); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.valid_funding_policy_draft(policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  recommendation jsonb := policy->'recommendation';
  input_spec jsonb := recommendation->'inputSpec';
  parameters jsonb := recommendation->'parameters';
  item jsonb;
  keys text[] := ARRAY[]::text[];
  ids text[] := ARRAY[]::text[];
  match_key text;
  neutral jsonb;
BEGIN
  IF recommendation->>'schema' IS DISTINCT FROM 'deposit-recommendation-v2' THEN
    RETURN zzsh_supply.valid_funding_policy_legacy_v1(policy);
  END IF;
  IF NOT zzsh_supply.jsonb_exact_keys(recommendation, ARRAY['schema','algorithm','version','currency','unit','inputSpec','parameters'])
    OR recommendation->'schema' IS DISTINCT FROM '"deposit-recommendation-v2"'::jsonb
    OR recommendation->'algorithm' IS DISTINCT FROM '"delta-deposit-type-rarity-v2"'::jsonb
    OR recommendation->'version' IS DISTINCT FROM '"2"'::jsonb
    OR input_spec->'schema' IS DISTINCT FROM '"deposit-recommendation-input-v2"'::jsonb
    OR NOT zzsh_supply.jsonb_exact_keys(input_spec->'attributeFields', ARRAY['safeBoxCode','vitality','bear','dive','skinIds','skinFacts'])
    OR input_spec->'attributeFields'->'skinFacts' IS DISTINCT FROM '"catalog.skinFacts"'::jsonb
    OR NOT zzsh_supply.jsonb_exact_keys(parameters, ARRAY['safeBoxWeightsByCode','vitalityAtLeast7Cents','bearAtLeast7Cents','diveAtLeast3Cents','skinRules','skinOverrides','rounding','upperLimitCents'])
    OR jsonb_typeof(parameters->'skinRules') IS DISTINCT FROM 'array'
    OR jsonb_typeof(parameters->'skinOverrides') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(parameters->'skinRules') > 512 OR jsonb_array_length(parameters->'skinOverrides') > 2000 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(parameters->'skinRules') LOOP
    IF NOT zzsh_supply.jsonb_exact_keys(item, ARRAY['ownerKind','rarityCode','firstCents','subsequentCents'])
      OR jsonb_typeof(item->'ownerKind') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'ownerKind','') NOT IN ('AGENT','MELEE_TYPE','FIREARM')
      OR NOT (item->'rarityCode' = 'null'::jsonb OR (jsonb_typeof(item->'rarityCode') = 'string' AND item->>'rarityCode' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'))
      OR NOT (item->'firstCents' = 'null'::jsonb OR (jsonb_typeof(item->'firstCents') = 'string' AND item->>'firstCents' ~ '^(0|[1-9][0-9]{0,23})$'))
      OR NOT (item->'subsequentCents' = 'null'::jsonb OR (jsonb_typeof(item->'subsequentCents') = 'string' AND item->>'subsequentCents' ~ '^(0|[1-9][0-9]{0,23})$')) THEN RETURN false; END IF;
    match_key := jsonb_build_array(item->'ownerKind',item->'rarityCode')::text;
    IF match_key = ANY(keys) THEN RETURN false; END IF;
    keys := array_append(keys,match_key);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(parameters->'skinOverrides') LOOP
    IF NOT zzsh_supply.jsonb_exact_keys(item, ARRAY['skinId','amountCents'])
      OR jsonb_typeof(item->'skinId') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'skinId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      OR NOT (item->'amountCents' = 'null'::jsonb OR (jsonb_typeof(item->'amountCents') = 'string' AND item->>'amountCents' ~ '^(0|[1-9][0-9]{0,23})$'))
      OR item->>'skinId' = ANY(ids) THEN RETURN false; END IF;
    ids := array_append(ids,item->>'skinId');
  END LOOP;
  -- Reuse the strict frozen validator for every non-skin field; these neutral skin values are validation-only.
  neutral := policy || jsonb_build_object('recommendation', recommendation || jsonb_build_object(
    'schema','deposit-recommendation-v1','algorithm','delta-deposit-owner-declared-v1','version','1',
    'inputSpec', input_spec || jsonb_build_object('schema','deposit-recommendation-input-v1','attributeFields',(input_spec->'attributeFields')-'skinFacts'),
    'parameters', (parameters-'skinRules'-'skinOverrides') || '{"skinGroupById":{},"skinWeights":{"LEGACY_GOLD":{"firstCents":"0","subsequentCents":"0"},"LEGACY_AGENT":{"firstCents":"0","subsequentCents":"0"},"LEGACY_KNIFE":{"firstCents":"0","subsequentCents":"0"},"LEGACY_WEAPON":{"firstCents":"0","subsequentCents":"0"}}}'::jsonb
  ));
  RETURN zzsh_supply.valid_funding_policy_legacy_v1(neutral);
END $_$;


--
-- Name: valid_funding_policy_legacy_v1(jsonb); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.valid_funding_policy_legacy_v1(policy jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  recommendation jsonb;
  input_spec jsonb;
  attributes jsonb;
  parameters jsonb;
  rounding jsonb;
  owner_rules jsonb;
  normal_rule jsonb;
  full_rule jsonb;
  guarantee jsonb;
  proof_validity jsonb;
BEGIN
  IF NOT zzsh_supply.jsonb_exact_keys(policy, ARRAY[
    'schema','policyVersion','recommendation','ownerDepositRules','guaranteeRequirement',
    'proofValidity','vipWaiver','svipWaiver','fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion'
  ]) THEN RETURN false; END IF;
  IF jsonb_typeof(policy->'schema') IS DISTINCT FROM 'string'
     OR policy->>'schema' IS DISTINCT FROM 'funding-policy-v1'
     OR jsonb_typeof(policy->'policyVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(policy->>'policyVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR jsonb_typeof(policy->'vipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'svipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'disclosureVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(policy->>'fullPayoutPolicyRef',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(policy->>'fullPayoutPolicyVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(policy->>'disclosureVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;

  recommendation := policy->'recommendation';
  IF NOT zzsh_supply.jsonb_exact_keys(recommendation, ARRAY['schema','algorithm','version','currency','unit','inputSpec','parameters'])
     OR jsonb_typeof(recommendation->'schema') IS DISTINCT FROM 'string'
     OR recommendation->>'schema' IS DISTINCT FROM 'deposit-recommendation-v1'
     OR jsonb_typeof(recommendation->'algorithm') IS DISTINCT FROM 'string'
     OR recommendation->>'algorithm' IS DISTINCT FROM 'delta-deposit-owner-declared-v1'
     OR jsonb_typeof(recommendation->'version') IS DISTINCT FROM 'string'
     OR recommendation->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(recommendation->'currency') IS DISTINCT FROM 'string'
     OR recommendation->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(recommendation->'unit') IS DISTINCT FROM 'string'
     OR recommendation->>'unit' IS DISTINCT FROM 'cent' THEN RETURN false; END IF;

  input_spec := recommendation->'inputSpec';
  IF NOT zzsh_supply.jsonb_exact_keys(input_spec, ARRAY['schema','identityFields','attributeFields','currency','unit'])
     OR jsonb_typeof(input_spec->'schema') IS DISTINCT FROM 'string'
     OR input_spec->>'schema' IS DISTINCT FROM 'deposit-recommendation-input-v1'
     OR jsonb_typeof(input_spec->'currency') IS DISTINCT FROM 'string'
     OR input_spec->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(input_spec->'unit') IS DISTINCT FROM 'string'
     OR input_spec->>'unit' IS DISTINCT FROM 'cent'
     OR input_spec->'identityFields' IS DISTINCT FROM '["accountId","gameId","listingVersionId","priceVersionId","ruleReleaseId"]'::jsonb THEN RETURN false; END IF;
  attributes := input_spec->'attributeFields';
  IF NOT zzsh_supply.jsonb_exact_keys(attributes, ARRAY['safeBoxCode','vitality','bear','dive','skinIds'])
     OR jsonb_typeof(attributes->'safeBoxCode') IS DISTINCT FROM 'string'
     OR attributes->>'safeBoxCode' IS DISTINCT FROM 'declaration.attributes.safe_box_code'
     OR jsonb_typeof(attributes->'vitality') IS DISTINCT FROM 'string'
     OR attributes->>'vitality' IS DISTINCT FROM 'declaration.attributes.vit_level'
     OR jsonb_typeof(attributes->'bear') IS DISTINCT FROM 'string'
     OR attributes->>'bear' IS DISTINCT FROM 'declaration.attributes.bear_level'
     OR jsonb_typeof(attributes->'dive') IS DISTINCT FROM 'string'
     OR attributes->>'dive' IS DISTINCT FROM 'declaration.attributes.dive_level'
     OR jsonb_typeof(attributes->'skinIds') IS DISTINCT FROM 'string'
     OR attributes->>'skinIds' IS DISTINCT FROM 'declaration.skins[].skinId' THEN RETURN false; END IF;

  parameters := recommendation->'parameters';
  IF NOT zzsh_supply.jsonb_exact_keys(parameters, ARRAY['safeBoxWeightsByCode','vitalityAtLeast7Cents','bearAtLeast7Cents','diveAtLeast3Cents','skinGroupById','skinWeights','rounding','upperLimitCents'])
     OR jsonb_typeof(parameters->'safeBoxWeightsByCode') IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode'))
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode') AS policy_entry(key,value)
       WHERE policy_entry.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR jsonb_typeof(policy_entry.value) IS DISTINCT FROM 'string'
          OR policy_entry.value #>> '{}' !~ '^(0|[1-9][0-9]{0,23})$')
     OR jsonb_typeof(parameters->'vitalityAtLeast7Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'vitalityAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'bearAtLeast7Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'bearAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'diveAtLeast3Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'diveAtLeast3Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'skinGroupById') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinGroupById') AS policy_entry(key,value)
       WHERE policy_entry.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR jsonb_typeof(policy_entry.value) IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value #>> '{}','') NOT IN ('LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON','NONE'))
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'skinWeights', ARRAY['LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON'])
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinWeights') AS policy_entry(key,value)
       WHERE NOT zzsh_supply.jsonb_exact_keys(policy_entry.value, ARRAY['firstCents','subsequentCents'])
          OR jsonb_typeof(policy_entry.value->'firstCents') IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value->>'firstCents','') !~ '^(0|[1-9][0-9]{0,23})$'
          OR jsonb_typeof(policy_entry.value->'subsequentCents') IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value->>'subsequentCents','') !~ '^(0|[1-9][0-9]{0,23})$')
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'rounding', ARRAY['mode','unitCents','zeroFallbackCents'])
     OR jsonb_typeof(parameters->'rounding'->'mode') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'mode' IS DISTINCT FROM 'CEIL'
     OR jsonb_typeof(parameters->'rounding'->'unitCents') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'unitCents' IS DISTINCT FROM '5000'
     OR jsonb_typeof(parameters->'rounding'->'zeroFallbackCents') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'zeroFallbackCents' IS DISTINCT FROM '5000'
     OR jsonb_typeof(parameters->'upperLimitCents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'upperLimitCents','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;

  owner_rules := policy->'ownerDepositRules';
  IF NOT zzsh_supply.jsonb_exact_keys(owner_rules, ARRAY['schema','currency','unit','normal','fullPayoutSelected','capCents'])
     OR jsonb_typeof(owner_rules->'schema') IS DISTINCT FROM 'string'
     OR owner_rules->>'schema' IS DISTINCT FROM 'owner-deposit-rule-v1'
     OR jsonb_typeof(owner_rules->'currency') IS DISTINCT FROM 'string'
     OR owner_rules->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(owner_rules->'unit') IS DISTINCT FROM 'string'
     OR owner_rules->>'unit' IS DISTINCT FROM 'cent'
     OR jsonb_typeof(owner_rules->'capCents') IS DISTINCT FROM 'string'
     OR COALESCE(owner_rules->>'capCents','') !~ '^[1-9][0-9]{0,23}$'
     OR owner_rules->>'capCents' IS DISTINCT FROM parameters->>'upperLimitCents' THEN RETURN false; END IF;
  normal_rule := owner_rules->'normal';
  full_rule := owner_rules->'fullPayoutSelected';
  IF NOT zzsh_supply.jsonb_exact_keys(normal_rule, ARRAY['minCents','zeroAllowed'])
     OR jsonb_typeof(normal_rule->'minCents') IS DISTINCT FROM 'string'
     OR normal_rule->>'minCents' IS DISTINCT FROM '1'
     OR jsonb_typeof(normal_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (normal_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR NOT zzsh_supply.jsonb_exact_keys(full_rule, ARRAY['minCents','zeroAllowed'])
     OR jsonb_typeof(full_rule->'minCents') IS DISTINCT FROM 'string'
     OR full_rule->>'minCents' IS DISTINCT FROM '30000'
     OR jsonb_typeof(full_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (full_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR (owner_rules->>'capCents')::numeric < 30000 THEN RETURN false; END IF;

  guarantee := policy->'guaranteeRequirement';
  IF NOT zzsh_supply.jsonb_exact_keys(guarantee, ARRAY['schema','version','scope','currency','unit','mode','requiredCents'])
     OR jsonb_typeof(guarantee->'schema') IS DISTINCT FROM 'string'
     OR guarantee->>'schema' IS DISTINCT FROM 'account-guarantee-requirement-v1'
     OR jsonb_typeof(guarantee->'version') IS DISTINCT FROM 'string'
     OR guarantee->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(guarantee->'scope') IS DISTINCT FROM 'string'
     OR guarantee->>'scope' IS DISTINCT FROM 'GAME_ACCOUNT'
     OR jsonb_typeof(guarantee->'currency') IS DISTINCT FROM 'string'
     OR guarantee->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(guarantee->'unit') IS DISTINCT FROM 'string'
     OR guarantee->>'unit' IS DISTINCT FROM 'cent'
     OR jsonb_typeof(guarantee->'mode') IS DISTINCT FROM 'string'
     OR COALESCE(guarantee->>'mode','') NOT IN ('FIXED_CENTS','NOT_REQUIRED')
     OR jsonb_typeof(guarantee->'requiredCents') IS DISTINCT FROM 'string'
     OR COALESCE(guarantee->>'requiredCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR (guarantee->>'mode'='FIXED_CENTS' AND guarantee->>'requiredCents'='0')
     OR (guarantee->>'mode'='NOT_REQUIRED' AND guarantee->>'requiredCents' IS DISTINCT FROM '0') THEN RETURN false; END IF;

  proof_validity := policy->'proofValidity';
  IF NOT zzsh_supply.jsonb_exact_keys(proof_validity, ARRAY['schema','satisfiedMode','satisfiedDays'])
     OR jsonb_typeof(proof_validity->'schema') IS DISTINCT FROM 'string'
     OR proof_validity->>'schema' IS DISTINCT FROM 'guarantee-proof-validity-v1'
     OR jsonb_typeof(proof_validity->'satisfiedMode') IS DISTINCT FROM 'string'
     OR proof_validity->>'satisfiedMode' IS DISTINCT FROM 'FIXED_DAYS'
     OR jsonb_typeof(proof_validity->'satisfiedDays') IS DISTINCT FROM 'string'
     OR COALESCE(proof_validity->>'satisfiedDays','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;
  RETURN true;
END $_$;


--
-- Name: valid_owner_deposit_declaration(jsonb); Type: FUNCTION; Schema: zzsh_supply; Owner: -
--

CREATE FUNCTION zzsh_supply.valid_owner_deposit_declaration(declaration jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
BEGIN
  IF NOT zzsh_supply.jsonb_exact_keys(declaration, ARRAY['schema','amountCents','declarationVersion'])
     OR jsonb_typeof(declaration->'schema') IS DISTINCT FROM 'string'
     OR declaration->>'schema' IS DISTINCT FROM 'owner-deposit-declaration-v1'
     OR jsonb_typeof(declaration->'amountCents') IS DISTINCT FROM 'string'
     OR COALESCE(declaration->>'amountCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(declaration->'declarationVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(declaration->>'declarationVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;
  RETURN true;
END $_$;


--
-- Name: account; Type: TABLE; Schema: zzsh_auth_admin; Owner: -
--

CREATE TABLE zzsh_auth_admin.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "legacyPasswordMd5" text,
    "legacyPasswordUpgradedAt" timestamp with time zone,
    "legacyPasswordVersion" text,
    "legacyPasswordSalt" text
);


--
-- Name: session; Type: TABLE; Schema: zzsh_auth_admin; Owner: -
--

CREATE TABLE zzsh_auth_admin.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    "pinHash" text,
    "pinFailures" integer DEFAULT 0 NOT NULL,
    last_active_at timestamp with time zone
);


--
-- Name: twoFactor; Type: TABLE; Schema: zzsh_auth_admin; Owner: -
--

CREATE TABLE zzsh_auth_admin."twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean DEFAULT true NOT NULL,
    "failedVerificationCount" integer DEFAULT 0 NOT NULL,
    "lockedUntil" timestamp with time zone
);


--
-- Name: user; Type: TABLE; Schema: zzsh_auth_admin; Owner: -
--

CREATE TABLE zzsh_auth_admin."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    username text,
    "displayUsername" text,
    "twoFactorEnabled" boolean DEFAULT false,
    "phoneNumber" text,
    "phoneNumberVerified" boolean,
    suspended boolean DEFAULT false NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: zzsh_auth_admin; Owner: -
--

CREATE TABLE zzsh_auth_admin.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: account; Type: TABLE; Schema: zzsh_auth_user; Owner: -
--

CREATE TABLE zzsh_auth_user.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "legacyPasswordMd5" text,
    "legacyPasswordUpgradedAt" timestamp with time zone,
    "legacyPasswordVersion" text,
    "legacyPasswordSalt" text
);


--
-- Name: session; Type: TABLE; Schema: zzsh_auth_user; Owner: -
--

CREATE TABLE zzsh_auth_user.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    "pinHash" text,
    "pinFailures" integer DEFAULT 0 NOT NULL
);


--
-- Name: twoFactor; Type: TABLE; Schema: zzsh_auth_user; Owner: -
--

CREATE TABLE zzsh_auth_user."twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean DEFAULT true NOT NULL,
    "failedVerificationCount" integer DEFAULT 0 NOT NULL,
    "lockedUntil" timestamp with time zone
);


--
-- Name: user; Type: TABLE; Schema: zzsh_auth_user; Owner: -
--

CREATE TABLE zzsh_auth_user."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    image text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    username text,
    "displayUsername" text,
    "twoFactorEnabled" boolean DEFAULT false,
    "phoneNumber" text,
    "phoneNumberVerified" boolean,
    suspended boolean DEFAULT false NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: zzsh_auth_user; Owner: -
--

CREATE TABLE zzsh_auth_user.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: carousel_item; Type: TABLE; Schema: zzsh_content; Owner: -
--

CREATE TABLE zzsh_content.carousel_item (
    id text NOT NULL,
    slot_code text NOT NULL,
    media_id text NOT NULL,
    image_alt text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    link_url text,
    enabled boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT carousel_item_description_check CHECK ((char_length(description) <= 300)),
    CONSTRAINT carousel_item_image_alt_check CHECK (((char_length(image_alt) >= 1) AND (char_length(image_alt) <= 300))),
    CONSTRAINT carousel_item_link_url_check CHECK (((link_url IS NULL) OR ((link_url ~ '^/'::text) AND (link_url !~ '^//'::text) AND (char_length(link_url) <= 300)))),
    CONSTRAINT carousel_item_revision_check CHECK ((revision > 0)),
    CONSTRAINT carousel_item_slot_code_check CHECK ((slot_code = 'HOME_HERO'::text)),
    CONSTRAINT carousel_item_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120))),
    CONSTRAINT carousel_item_window_shape CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (starts_at < ends_at)))
);


--
-- Name: content_item; Type: TABLE; Schema: zzsh_content; Owner: -
--

CREATE TABLE zzsh_content.content_item (
    id text NOT NULL,
    type text NOT NULL,
    game_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resource_key text,
    CONSTRAINT content_item_resource_shape CHECK ((((type = 'RESOURCE'::text) AND (resource_key IS NOT NULL) AND (length(resource_key) <= 128) AND (resource_key ~ '^(guide:[a-z0-9]+(-[a-z0-9]+)*|placement:[A-Z][A-Z0-9_]*)$'::text)) OR ((type <> 'RESOURCE'::text) AND (resource_key IS NULL)))),
    CONSTRAINT content_item_revision_check CHECK ((revision > 0)),
    CONSTRAINT content_item_scope_shape CHECK (((type <> 'ANNOUNCEMENT'::text) OR (game_id IS NULL))),
    CONSTRAINT content_item_type_check CHECK ((type = ANY (ARRAY['ANNOUNCEMENT'::text, 'NEWS'::text, 'RESOURCE'::text])))
);


--
-- Name: content_version; Type: TABLE; Schema: zzsh_content; Owner: -
--

CREATE TABLE zzsh_content.content_version (
    id text NOT NULL,
    item_id text NOT NULL,
    sequence integer NOT NULL,
    state text DEFAULT 'DRAFT'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    cover_media_id text,
    revision bigint DEFAULT 1 NOT NULL,
    published_at timestamp with time zone,
    published_by_admin_id text,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payload jsonb,
    update_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT content_update_settings_shape CHECK (((jsonb_typeof(update_settings) = 'object'::text) AND (octet_length((update_settings)::text) <= 65536))),
    CONSTRAINT content_version_body_check CHECK ((octet_length(body) <= 20000)),
    CONSTRAINT content_version_payload_shape CHECK (((payload IS NULL) OR ((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 250000)))),
    CONSTRAINT content_version_publish_shape CHECK ((((state = 'DRAFT'::text) AND (published_at IS NULL) AND (published_by_admin_id IS NULL)) OR ((state <> 'DRAFT'::text) AND (published_at IS NOT NULL) AND (published_by_admin_id IS NOT NULL)) OR ((state = 'SUPERSEDED'::text) AND (payload IS NOT NULL) AND (published_at IS NULL) AND (published_by_admin_id IS NULL)))),
    CONSTRAINT content_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT content_version_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT content_version_state_check CHECK ((state = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'SUPERSEDED'::text, 'WITHDRAWN'::text]))),
    CONSTRAINT content_version_summary_check CHECK ((char_length(summary) <= 500)),
    CONSTRAINT content_version_title_check CHECK ((char_length(title) <= 200))
);


--
-- Name: document_acceptance; Type: TABLE; Schema: zzsh_content; Owner: -
--

CREATE TABLE zzsh_content.document_acceptance (
    id text NOT NULL,
    user_id text NOT NULL,
    document_type text NOT NULL,
    document_version_id text NOT NULL,
    document_digest text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    source text NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    request_id text,
    CONSTRAINT document_acceptance_document_digest_check CHECK ((document_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT document_acceptance_document_type_check CHECK ((document_type = ANY (ARRAY['PLATFORM_TERMS'::text, 'PLATFORM_PRIVACY'::text, 'RENTAL_AGREEMENT'::text, 'FULL_PAYOUT_TERMS'::text, 'EARLY_SETTLEMENT_OWNER'::text, 'EARLY_SETTLEMENT_RENTER'::text]))),
    CONSTRAINT document_acceptance_document_version_id_check CHECK (((length(document_version_id) >= 1) AND (length(document_version_id) <= 160))),
    CONSTRAINT document_acceptance_source_check CHECK ((source = ANY (ARRAY['REGISTRATION'::text, 'LOGIN'::text, 'ACCOUNT_READ'::text, 'ORDER_CREATE'::text, 'SETTLEMENT_SUBMIT'::text, 'SETTLEMENT_DECISION'::text]))),
    CONSTRAINT document_acceptance_subject_id_check CHECK (((length(subject_id) >= 1) AND (length(subject_id) <= 128))),
    CONSTRAINT document_acceptance_subject_type_check CHECK ((subject_type = ANY (ARRAY['USER'::text, 'ACCOUNT'::text, 'ORDER'::text])))
);


--
-- Name: legal_document_version; Type: TABLE; Schema: zzsh_content; Owner: -
--

CREATE TABLE zzsh_content.legal_document_version (
    id text NOT NULL,
    doc_type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    digest text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    effective_at timestamp with time zone,
    created_by_admin_id text NOT NULL,
    sealed_by_admin_id text,
    sealed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legal_document_sealed_shape CHECK (((status = 'DRAFT'::text) OR ((sealed_at IS NOT NULL) AND (sealed_by_admin_id IS NOT NULL) AND (effective_at IS NOT NULL)))),
    CONSTRAINT legal_document_version_body_check CHECK (((octet_length(body) >= 1) AND (octet_length(body) <= 20000))),
    CONSTRAINT legal_document_version_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT legal_document_version_doc_type_check CHECK ((doc_type = ANY (ARRAY['PLATFORM_TERMS'::text, 'PLATFORM_PRIVACY'::text]))),
    CONSTRAINT legal_document_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT legal_document_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SEALED'::text]))),
    CONSTRAINT legal_document_version_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 160)))
);


--
-- Name: credit_event; Type: TABLE; Schema: zzsh_credit; Owner: -
--

CREATE TABLE zzsh_credit.credit_event (
    id text NOT NULL,
    user_id text NOT NULL,
    event_key text NOT NULL,
    event_type text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    subject_role text,
    delta_score smallint NOT NULL,
    applied_delta_score smallint NOT NULL,
    score_before smallint NOT NULL,
    score_after smallint NOT NULL,
    visible_reason text NOT NULL,
    internal_basis text NOT NULL,
    actor_admin_id text,
    reversal_of_id text,
    payload_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT credit_event_applied_delta_score_check CHECK (((applied_delta_score >= '-100'::integer) AND (applied_delta_score <= 100))),
    CONSTRAINT credit_event_delta_score_check CHECK (((delta_score >= '-100'::integer) AND (delta_score <= 100))),
    CONSTRAINT credit_event_event_type_check CHECK ((event_type = ANY (ARRAY['INITIALIZED'::text, 'BREACH_CONFIRMED'::text, 'BREACH_REVERSED'::text, 'RECOVERY_APPROVED'::text, 'MANUAL_DEDUCTION'::text, 'MANUAL_DEDUCTION_REVERSED'::text]))),
    CONSTRAINT credit_event_internal_basis_check CHECK (((length(btrim(internal_basis)) >= 2) AND (length(btrim(internal_basis)) <= 500))),
    CONSTRAINT credit_event_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT credit_event_score_after_check CHECK (((score_after >= 0) AND (score_after <= 100))),
    CONSTRAINT credit_event_score_before_check CHECK (((score_before >= 0) AND (score_before <= 100))),
    CONSTRAINT credit_event_subject_role_check CHECK (((subject_role IS NULL) OR (subject_role = ANY (ARRAY['OWNER'::text, 'RENTER'::text])))),
    CONSTRAINT credit_event_visible_reason_check CHECK (((length(btrim(visible_reason)) >= 2) AND (length(btrim(visible_reason)) <= 500)))
);


--
-- Name: credit_recovery_request; Type: TABLE; Schema: zzsh_credit; Owner: -
--

CREATE TABLE zzsh_credit.credit_recovery_request (
    id text NOT NULL,
    user_id text NOT NULL,
    request_key text NOT NULL,
    request_fingerprint text NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    eligibility_snapshot jsonb NOT NULL,
    score_before smallint NOT NULL,
    completed_orders bigint NOT NULL,
    decision text,
    decision_fingerprint text,
    decision_reason text,
    decided_by text,
    event_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT credit_recovery_request_completed_orders_check CHECK ((completed_orders >= 0)),
    CONSTRAINT credit_recovery_request_decision_check CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text]))),
    CONSTRAINT credit_recovery_request_decision_fingerprint_check CHECK (((decision_fingerprint IS NULL) OR (decision_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT credit_recovery_request_decision_shape CHECK (((((status = 'PENDING'::text) AND (decision IS NULL) AND (decision_fingerprint IS NULL) AND (decided_by IS NULL) AND (decided_at IS NULL) AND (event_id IS NULL)) OR ((status = 'REJECTED'::text) AND (decision IS NOT NULL) AND (decision = 'REJECT'::text) AND (decision_fingerprint IS NOT NULL) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL) AND (event_id IS NULL)) OR ((status = 'APPROVED'::text) AND (decision IS NOT NULL) AND (decision = 'APPROVE'::text) AND (decision_fingerprint IS NOT NULL) AND (decided_by IS NOT NULL) AND (decided_at IS NOT NULL) AND (event_id IS NOT NULL))) IS TRUE)),
    CONSTRAINT credit_recovery_request_reason_check CHECK (((length(btrim(reason)) >= 2) AND (length(btrim(reason)) <= 500))),
    CONSTRAINT credit_recovery_request_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT credit_recovery_request_score_before_check CHECK (((score_before >= 0) AND (score_before <= 100))),
    CONSTRAINT credit_recovery_request_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])))
);


--
-- Name: user_credit_state; Type: TABLE; Schema: zzsh_credit; Owner: -
--

CREATE TABLE zzsh_credit.user_credit_state (
    user_id text NOT NULL,
    score smallint NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    initialized_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_credit_state_revision_check CHECK ((revision > 0)),
    CONSTRAINT user_credit_state_score_check CHECK (((score >= 0) AND (score <= 100)))
);


--
-- Name: admin_auth_captcha_used; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_auth_captcha_used (
    signature text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT admin_auth_captcha_used_signature_check CHECK ((length(signature) <= 256))
);


--
-- Name: admin_auth_failure; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_auth_failure (
    id bigint NOT NULL,
    scope text NOT NULL,
    subject text NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT admin_auth_failure_scope_check CHECK ((scope = ANY (ARRAY['sign-in'::text, 'two-factor'::text, 'step-up'::text, 'recovery'::text]))),
    CONSTRAINT admin_auth_failure_subject_check CHECK ((length(subject) <= 64))
);


--
-- Name: admin_auth_failure_id_seq; Type: SEQUENCE; Schema: zzsh_iam; Owner: -
--

CREATE SEQUENCE zzsh_iam.admin_auth_failure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_auth_failure_id_seq; Type: SEQUENCE OWNED BY; Schema: zzsh_iam; Owner: -
--

ALTER SEQUENCE zzsh_iam.admin_auth_failure_id_seq OWNED BY zzsh_iam.admin_auth_failure.id;


--
-- Name: admin_auth_lockout; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_auth_lockout (
    scope text NOT NULL,
    subject text NOT NULL,
    level integer NOT NULL,
    locked_until timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT admin_auth_lockout_level_check CHECK (((level >= 1) AND (level <= 16))),
    CONSTRAINT admin_auth_lockout_scope_check CHECK ((scope = ANY (ARRAY['sign-in'::text, 'two-factor'::text, 'step-up'::text, 'recovery'::text]))),
    CONSTRAINT admin_auth_lockout_subject_check CHECK ((length(subject) <= 64))
);


--
-- Name: admin_backup_code_generation; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_backup_code_generation (
    admin_user_id text NOT NULL,
    generation integer NOT NULL,
    generation_id text NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    CONSTRAINT admin_backup_code_generation_generation_check CHECK ((generation > 0))
);


--
-- Name: admin_login_number_seq; Type: SEQUENCE; Schema: zzsh_iam; Owner: -
--

CREATE SEQUENCE zzsh_iam.admin_login_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_permission; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_permission (
    code text NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_recovery_notification_target; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_recovery_notification_target (
    id text NOT NULL,
    admin_user_id text NOT NULL,
    channel text NOT NULL,
    target_ref text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT admin_recovery_notification_target_channel_check CHECK ((channel = ANY (ARRAY['EMAIL'::text, 'PHONE'::text, 'SECURE_STORE'::text])))
);


--
-- Name: admin_recovery_request; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_recovery_request (
    id text NOT NULL,
    target_admin_user_id text NOT NULL,
    requested_by text NOT NULL,
    confirmed_by text,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    recovery_token_hash text,
    recovery_method text DEFAULT 'BOSS_CONFIRMATION'::text NOT NULL,
    offline_confirmation_id text,
    CONSTRAINT admin_recovery_request_method_check CHECK ((recovery_method = ANY (ARRAY['BOSS_CONFIRMATION'::text, 'DISASTER_CLI'::text]))),
    CONSTRAINT admin_recovery_request_offline_confirmation_check CHECK ((((recovery_method = 'BOSS_CONFIRMATION'::text) AND (offline_confirmation_id IS NULL)) OR ((recovery_method = 'DISASTER_CLI'::text) AND (offline_confirmation_id IS NOT NULL)))),
    CONSTRAINT admin_recovery_request_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'ISSUED'::text, 'COMPLETED'::text, 'EXPIRED'::text])))
);


--
-- Name: admin_role; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_role (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_role_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text])))
);


--
-- Name: admin_role_permission; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_role_permission (
    role_id text NOT NULL,
    permission_code text NOT NULL
);


--
-- Name: admin_security; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_security (
    admin_user_id text NOT NULL,
    status text NOT NULL,
    is_boss boolean DEFAULT false NOT NULL,
    bootstrap_expires_at timestamp with time zone,
    bootstrap_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_activated_at timestamp with time zone,
    password_change_required boolean DEFAULT false NOT NULL,
    last_full_authenticated_at timestamp with time zone,
    game_scope_mode text DEFAULT 'ALL_GAMES'::text NOT NULL,
    login_two_factor_required boolean DEFAULT true NOT NULL,
    CONSTRAINT admin_security_first_activation_check CHECK (((status <> 'ACTIVE'::text) OR (first_activated_at IS NOT NULL))),
    CONSTRAINT admin_security_game_scope_mode_check CHECK ((game_scope_mode = ANY (ARRAY['ALL_GAMES'::text, 'SELECTED_GAMES'::text]))),
    CONSTRAINT admin_security_status_check CHECK ((status = ANY (ARRAY['PENDING_ENROLLMENT'::text, 'ACTIVE'::text, 'FROZEN'::text])))
);


--
-- Name: admin_security_command; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_security_command (
    admin_user_id text NOT NULL,
    command_id text NOT NULL,
    action text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    fingerprint text NOT NULL,
    status text NOT NULL,
    reason text,
    result jsonb,
    rejection jsonb,
    request_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    retention_until timestamp with time zone NOT NULL,
    CONSTRAINT admin_security_command_action_ck CHECK ((action = ANY (ARRAY['password.change'::text, 'pin.set'::text, 'pin.change'::text, 'backup-codes.generate'::text]))),
    CONSTRAINT admin_security_command_fingerprint_ck CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT admin_security_command_status_ck CHECK ((status = ANY (ARRAY['completed'::text, 'rejected'::text]))),
    CONSTRAINT admin_security_command_target_kind_ck CHECK ((target_kind = ANY (ARRAY['session'::text, 'credential'::text])))
);


--
-- Name: admin_security_notification_outbox; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_security_notification_outbox (
    id text NOT NULL,
    event text NOT NULL,
    actor_id text NOT NULL,
    target_admin_id text NOT NULL,
    reason text,
    request_id text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    delivered_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    claimed_at timestamp with time zone,
    claim_token text,
    CONSTRAINT admin_security_notification_outbox_event_check CHECK ((event = ANY (ARRAY['admin.frozen'::text, 'admin.unfrozen'::text, 'admin.recovery.issued'::text, 'admin.recovery.completed'::text, 'admin.recovery.disaster.issued'::text]))),
    CONSTRAINT admin_security_notification_outbox_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'DELIVERED'::text])))
);


--
-- Name: admin_user_permission; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_user_permission (
    admin_user_id text NOT NULL,
    permission_code text NOT NULL,
    effect text NOT NULL,
    CONSTRAINT admin_user_permission_effect_check CHECK ((effect = ANY (ARRAY['ALLOW'::text, 'DENY'::text])))
);


--
-- Name: admin_user_role; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_user_role (
    admin_user_id text NOT NULL,
    role_id text NOT NULL
);


--
-- Name: admin_workspace_layout; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.admin_workspace_layout (
    admin_user_id text NOT NULL,
    layout_kind text DEFAULT 'admin.workspace.layout'::text NOT NULL,
    version integer NOT NULL,
    widgets jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_workspace_layout_layout_kind_check CHECK ((layout_kind = 'admin.workspace.layout'::text)),
    CONSTRAINT admin_workspace_layout_version_check CHECK ((version > 0)),
    CONSTRAINT admin_workspace_layout_widgets_object CHECK ((jsonb_typeof(widgets) = 'array'::text)),
    CONSTRAINT admin_workspace_layout_widgets_size CHECK ((pg_column_size(widgets) <= 8192))
);


--
-- Name: approval_decision; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_decision (
    id text NOT NULL,
    request_id text NOT NULL,
    approver_admin_id text NOT NULL,
    decision text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    final_payload jsonb,
    final_payload_hash text,
    CONSTRAINT approval_decision_decision_check CHECK ((decision = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text]))),
    CONSTRAINT approval_decision_final_payload_check CHECK ((((final_payload IS NULL) AND (final_payload_hash IS NULL)) OR ((decision = 'APPROVED'::text) AND (final_payload IS NOT NULL) AND (jsonb_typeof(final_payload) = 'object'::text) AND (final_payload_hash IS NOT NULL) AND (final_payload_hash ~ '^[a-f0-9]{64}$'::text))))
);


--
-- Name: approval_execution; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_execution (
    id text NOT NULL,
    request_id text NOT NULL,
    operation_code text NOT NULL,
    status text NOT NULL,
    result_code text NOT NULL,
    result_detail text,
    executed_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_execution_status_check CHECK ((status = ANY (ARRAY['SUCCEEDED'::text, 'FAILED'::text])))
);


--
-- Name: approval_request; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_request (
    id text NOT NULL,
    template_id text NOT NULL,
    template_version integer NOT NULL,
    operation_code text NOT NULL,
    trigger_condition text NOT NULL,
    payload_version integer NOT NULL,
    operation_payload jsonb NOT NULL,
    operation_payload_hash text NOT NULL,
    summary text NOT NULL,
    requested_by text NOT NULL,
    status text NOT NULL,
    status_reason text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by text,
    decision_reason text,
    supersedes_request_id text,
    superseded_by_request_id text,
    CONSTRAINT approval_request_operation_payload_hash_check CHECK ((length(operation_payload_hash) = 64)),
    CONSTRAINT approval_request_payload_version_check CHECK ((payload_version > 0)),
    CONSTRAINT approval_request_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'CANCELLED'::text, 'EXPIRED'::text, 'EXECUTED'::text, 'EXECUTION_FAILED'::text]))),
    CONSTRAINT approval_request_template_version_check CHECK ((template_version > 0))
);


--
-- Name: approval_request_candidate; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_request_candidate (
    request_id text NOT NULL,
    admin_user_id text NOT NULL,
    source text NOT NULL,
    template_version integer NOT NULL,
    added_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_request_candidate_source_check CHECK ((source = ANY (ARRAY['TEMPLATE'::text, 'APPENDED'::text]))),
    CONSTRAINT approval_request_candidate_template_version_check CHECK ((template_version > 0))
);


--
-- Name: approval_template; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_template (
    id text NOT NULL,
    operation_code text NOT NULL,
    trigger_condition text NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_template_version_check CHECK ((version > 0))
);


--
-- Name: approval_template_candidate; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.approval_template_candidate (
    template_id text NOT NULL,
    admin_user_id text NOT NULL
);


--
-- Name: audit_event; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.audit_event (
    id text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    session_id text,
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text,
    outcome text NOT NULL,
    request_id text,
    reason text,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT audit_event_outcome_check CHECK ((outcome = ANY (ARRAY['SUCCESS'::text, 'FAILURE'::text])))
);


--
-- Name: im_aftersale_record; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_aftersale_record (
    id text NOT NULL,
    app_id text NOT NULL,
    order_source text NOT NULL,
    order_id text NOT NULL,
    requester_user_id text NOT NULL,
    requester_party text NOT NULL,
    description text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    handler_admin_id text,
    result text,
    resolved_by_admin_id text,
    resolved_at timestamp with time zone,
    operation_id text NOT NULL,
    resolve_operation_id text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_aftersale_record_description_check CHECK ((((length(description) >= 1) AND (length(description) <= 1000)) AND (octet_length(description) <= 4000))),
    CONSTRAINT im_aftersale_record_order_source_check CHECK ((order_source = 'NATIVE'::text)),
    CONSTRAINT im_aftersale_record_requester_party_check CHECK ((requester_party = ANY (ARRAY['RENTER'::text, 'OWNER'::text]))),
    CONSTRAINT im_aftersale_record_result_check CHECK ((((length(result) >= 1) AND (length(result) <= 1000)) AND (octet_length(result) <= 4000))),
    CONSTRAINT im_aftersale_record_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'RESOLVED'::text]))),
    CONSTRAINT im_aftersale_record_version_check CHECK ((version > 0)),
    CONSTRAINT im_aftersale_resolution_shape CHECK ((((state = 'PENDING'::text) AND (result IS NULL) AND (resolved_by_admin_id IS NULL) AND (resolved_at IS NULL) AND (resolve_operation_id IS NULL)) OR ((state = 'RESOLVED'::text) AND (result IS NOT NULL) AND (resolved_by_admin_id IS NOT NULL) AND (handler_admin_id IS NOT NULL) AND (handler_admin_id = resolved_by_admin_id) AND (resolved_at IS NOT NULL) AND (resolve_operation_id IS NOT NULL))))
);


--
-- Name: im_consultation; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_consultation (
    id text NOT NULL,
    user_id text NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    user_account_id text NOT NULL,
    peer_account_id text,
    assigned_admin_id text,
    subject_ref text,
    version bigint DEFAULT 1 NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    app_id text,
    message_scope_type text DEFAULT 'TEAM'::text NOT NULL,
    message_scope_id text,
    message_scope_state text DEFAULT 'PENDING'::text NOT NULL,
    message_scope_version bigint DEFAULT 1 NOT NULL,
    thread_id text NOT NULL,
    round_seq integer NOT NULL,
    admin_read_at timestamp with time zone,
    last_message_preview text,
    first_user_message_at timestamp with time zone,
    entry_intent text DEFAULT 'SERVICE'::text NOT NULL,
    no_support_notice_at timestamp with time zone,
    user_unread_count integer DEFAULT 0 NOT NULL,
    admin_unread_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT im_consultation_active_assignment_check CHECK (((state <> 'ACTIVE'::text) OR ((assigned_admin_id IS NOT NULL) AND (peer_account_id IS NOT NULL)))),
    CONSTRAINT im_consultation_app_id_check CHECK (((app_id IS NULL) OR (app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT im_consultation_entry_intent_check CHECK ((entry_intent = ANY (ARRAY['SERVICE'::text, 'COMPLAINT'::text]))),
    CONSTRAINT im_consultation_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_consultation_kind_check CHECK ((kind = ANY (ARRAY['SERVICE'::text, 'COMPLAINT'::text]))),
    CONSTRAINT im_consultation_last_message_preview_length CHECK ((char_length(last_message_preview) <= 160)),
    CONSTRAINT im_consultation_message_scope_id_check CHECK (((message_scope_id IS NULL) OR (message_scope_id ~ '^[0-9]{1,19}$'::text))),
    CONSTRAINT im_consultation_message_scope_state_check CHECK (((message_scope_state = ANY (ARRAY['PENDING'::text, 'PROVISIONING'::text, 'READY'::text, 'FAILED'::text, 'TRANSFERRING'::text, 'REVOKING'::text, 'REVOKED'::text])) AND ((message_scope_state = ANY (ARRAY['PENDING'::text, 'PROVISIONING'::text, 'FAILED'::text])) OR (message_scope_id IS NOT NULL)))),
    CONSTRAINT im_consultation_message_scope_type_check CHECK ((message_scope_type = 'TEAM'::text)),
    CONSTRAINT im_consultation_message_scope_version_check CHECK ((message_scope_version > 0)),
    CONSTRAINT im_consultation_peer_account_id_check CHECK (((peer_account_id IS NULL) OR (peer_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text))),
    CONSTRAINT im_consultation_round_seq_check CHECK ((round_seq > 0)),
    CONSTRAINT im_consultation_state_check CHECK ((state = ANY (ARRAY['WAITING'::text, 'ACTIVE'::text, 'CLOSED'::text]))),
    CONSTRAINT im_consultation_subject_ref_check CHECK (((subject_ref IS NULL) OR (subject_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT im_consultation_unread_nonnegative CHECK (((user_unread_count >= 0) AND (admin_unread_count >= 0))),
    CONSTRAINT im_consultation_user_account_id_check CHECK ((user_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)),
    CONSTRAINT im_consultation_version_check CHECK ((version > 0))
);


--
-- Name: im_consultation_event; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_consultation_event (
    id text NOT NULL,
    consultation_id text NOT NULL,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    from_admin_id text,
    to_admin_id text,
    peer_account_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_consultation_event_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'admin'::text, 'system'::text]))),
    CONSTRAINT im_consultation_event_event_type_check CHECK ((event_type = ANY (ARRAY['CREATED'::text, 'ASSIGNED'::text, 'CLAIMED'::text, 'TRANSFERRED'::text, 'CLOSED'::text, 'REOPENED'::text]))),
    CONSTRAINT im_consultation_event_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_consultation_event_peer_account_id_check CHECK (((peer_account_id IS NULL) OR (peer_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)))
);


--
-- Name: im_consultation_scope_operation; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_consultation_scope_operation (
    id text NOT NULL,
    app_id text NOT NULL,
    consultation_id text NOT NULL,
    operation_type text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    scope_version bigint NOT NULL,
    owner_account_id text NOT NULL,
    user_account_id text NOT NULL,
    previous_admin_id text,
    target_admin_id text,
    previous_admin_account_id text,
    target_admin_account_id text,
    provider_team_id text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_until timestamp with time zone,
    lease_token_hash text,
    last_failure_class text,
    last_failure_detail text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_consultation_scope_operation_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_consultation_scope_operation_attempt_check CHECK ((attempt_count >= 0)),
    CONSTRAINT im_consultation_scope_operation_detail_check CHECK (((last_failure_detail IS NULL) OR (length(last_failure_detail) <= 512))),
    CONSTRAINT im_consultation_scope_operation_failure_check CHECK (((last_failure_class IS NULL) OR (last_failure_class = ANY (ARRAY['IDENTITY_PENDING'::text, 'PROVIDER_UNKNOWN'::text, 'PROVIDER_TRANSIENT'::text, 'REMOTE_MISMATCH'::text, 'DB_WRITEBACK_UNKNOWN'::text, 'STALE_OPERATION'::text, 'REQUIRES_MANUAL_REVIEW'::text])))),
    CONSTRAINT im_consultation_scope_operation_id_check CHECK ((id ~ '^im_scope_op_[a-f0-9]{32}$'::text)),
    CONSTRAINT im_consultation_scope_operation_lease_check CHECK ((((state = 'RUNNING'::text) AND (lease_until IS NOT NULL) AND (lease_token_hash IS NOT NULL)) OR ((state <> 'RUNNING'::text) AND (lease_until IS NULL) AND (lease_token_hash IS NULL)))),
    CONSTRAINT im_consultation_scope_operation_owner_check CHECK ((owner_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)),
    CONSTRAINT im_consultation_scope_operation_previous_admin_id_check CHECK (((previous_admin_id IS NULL) OR (previous_admin_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT im_consultation_scope_operation_previous_check CHECK (((previous_admin_account_id IS NULL) OR (previous_admin_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text))),
    CONSTRAINT im_consultation_scope_operation_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'UNKNOWN'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'NEEDS_REVIEW'::text]))),
    CONSTRAINT im_consultation_scope_operation_target_admin_id_check CHECK (((target_admin_id IS NULL) OR (target_admin_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT im_consultation_scope_operation_target_check CHECK (((target_admin_account_id IS NULL) OR (target_admin_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text))),
    CONSTRAINT im_consultation_scope_operation_team_check CHECK (((provider_team_id IS NULL) OR (provider_team_id ~ '^[0-9]{1,19}$'::text))),
    CONSTRAINT im_consultation_scope_operation_type_check CHECK ((((operation_type = 'CREATE'::text) AND (previous_admin_id IS NULL) AND (previous_admin_account_id IS NULL) AND (((target_admin_id IS NULL) AND (target_admin_account_id IS NULL)) OR ((target_admin_id IS NOT NULL) AND (target_admin_account_id IS NOT NULL)))) OR ((operation_type = 'ADD_MEMBER'::text) AND (previous_admin_id IS NULL) AND (previous_admin_account_id IS NULL) AND (target_admin_id IS NOT NULL) AND (target_admin_account_id IS NOT NULL)) OR ((operation_type = 'TRANSFER'::text) AND (previous_admin_id IS NOT NULL) AND (target_admin_id IS NOT NULL) AND (previous_admin_account_id IS NOT NULL) AND (target_admin_account_id IS NOT NULL) AND (previous_admin_account_id <> target_admin_account_id)) OR ((operation_type = 'CLOSE'::text) AND (previous_admin_id IS NULL) AND (target_admin_id IS NULL) AND (previous_admin_account_id IS NULL) AND (target_admin_account_id IS NULL)) OR ((operation_type = 'ROUND_CLOSE'::text) AND (previous_admin_id IS NOT NULL) AND (previous_admin_account_id IS NOT NULL) AND (target_admin_id IS NULL) AND (target_admin_account_id IS NULL)))),
    CONSTRAINT im_consultation_scope_operation_user_check CHECK ((user_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)),
    CONSTRAINT im_consultation_scope_operation_version_check CHECK ((scope_version > 0))
);


--
-- Name: im_identity_mapping; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_identity_mapping (
    id text NOT NULL,
    provider text NOT NULL,
    app_id text NOT NULL,
    realm text NOT NULL,
    identity_kind text NOT NULL,
    platform_subject_id text NOT NULL,
    account_id text NOT NULL,
    identity_marker text NOT NULL,
    status text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    attempt_lease_until timestamp with time zone,
    attempt_lease_token_hash text,
    next_retry_at timestamp with time zone,
    last_failure_class text,
    last_failure_provider_code integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_identity_mapping_account_id_check CHECK ((account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)),
    CONSTRAINT im_identity_mapping_app_id_check CHECK (((char_length(app_id) >= 1) AND (char_length(app_id) <= 128))),
    CONSTRAINT im_identity_mapping_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT im_identity_mapping_attempt_lease_token_hash_check CHECK (((attempt_lease_token_hash IS NULL) OR (attempt_lease_token_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT im_identity_mapping_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_identity_mapping_identity_kind_check CHECK ((identity_kind = ANY (ARRAY['USER'::text, 'ADMIN'::text, 'SYSTEM'::text]))),
    CONSTRAINT im_identity_mapping_identity_marker_check CHECK (((char_length(identity_marker) >= 1) AND (char_length(identity_marker) <= 4096))),
    CONSTRAINT im_identity_mapping_last_failure_class_check CHECK (((last_failure_class IS NULL) OR (last_failure_class = ANY (ARRAY['UNKNOWN_RESULT'::text, 'TRANSIENT_PROVIDER'::text, 'PERMANENT_PROVIDER'::text, 'ACCOUNT_OWNERSHIP_CONFLICT'::text])))),
    CONSTRAINT im_identity_mapping_lease_pair_check CHECK (((attempt_lease_until IS NULL) = (attempt_lease_token_hash IS NULL))),
    CONSTRAINT im_identity_mapping_pending_state_check CHECK (((status = 'PENDING'::text) OR ((attempt_lease_until IS NULL) AND (attempt_lease_token_hash IS NULL) AND (next_retry_at IS NULL)))),
    CONSTRAINT im_identity_mapping_permanent_failure_check CHECK (((status <> 'FAILED_PERMANENT'::text) OR (last_failure_class IS NOT NULL))),
    CONSTRAINT im_identity_mapping_platform_subject_id_check CHECK (((char_length(platform_subject_id) >= 1) AND (char_length(platform_subject_id) <= 256))),
    CONSTRAINT im_identity_mapping_provider_check CHECK ((provider = 'yunxin'::text)),
    CONSTRAINT im_identity_mapping_realm_check CHECK (((char_length(realm) >= 1) AND (char_length(realm) <= 128))),
    CONSTRAINT im_identity_mapping_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'READY'::text, 'FAILED_PERMANENT'::text, 'DISABLED'::text, 'REVOKED'::text]))),
    CONSTRAINT im_identity_mapping_version_check CHECK ((version > 0))
);


--
-- Name: im_read_copy_position; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_read_copy_position (
    app_id text NOT NULL,
    team_id text NOT NULL,
    account_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id text NOT NULL,
    read_message_time bigint NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_read_copy_position_read_message_time_check CHECK ((read_message_time > 0)),
    CONSTRAINT im_read_copy_position_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['SUPPORT'::text, 'ORDER'::text])))
);


--
-- Name: im_read_copy_settings; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_read_copy_settings (
    app_id text NOT NULL,
    version integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    public_origin text,
    updated_by text NOT NULL,
    operation_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_verified_at timestamp with time zone,
    last_event_at timestamp with time zone,
    CONSTRAINT im_read_copy_settings_check CHECK (((NOT enabled) OR (public_origin IS NOT NULL))),
    CONSTRAINT im_read_copy_settings_version_check CHECK ((version > 0))
);


--
-- Name: im_support_handover; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_handover (
    id text NOT NULL,
    app_id text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    from_admin_id text NOT NULL,
    to_admin_id text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_support_handover_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_support_handover_distinct_staff CHECK ((from_admin_id <> to_admin_id)),
    CONSTRAINT im_support_handover_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_support_handover_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 1) AND (char_length(note) <= 200)))),
    CONSTRAINT im_support_handover_object_id_check CHECK (((char_length(object_id) >= 1) AND (char_length(object_id) <= 128))),
    CONSTRAINT im_support_handover_object_type_check CHECK ((object_type = ANY (ARRAY['CONSULTATION'::text, 'ORDER_GROUP'::text])))
);


--
-- Name: im_support_presence; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_presence (
    admin_user_id text NOT NULL,
    availability text NOT NULL,
    connection_state text NOT NULL,
    last_connected_at timestamp with time zone,
    active_load integer DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    app_id text,
    last_order_assigned_at timestamp with time zone,
    last_consultation_assigned_at timestamp with time zone,
    CONSTRAINT im_support_presence_active_load_check CHECK ((active_load >= 0)),
    CONSTRAINT im_support_presence_app_id_check CHECK (((app_id IS NULL) OR (app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT im_support_presence_availability_check CHECK ((availability = ANY (ARRAY['OFF_DUTY'::text, 'AVAILABLE'::text, 'PAUSED'::text]))),
    CONSTRAINT im_support_presence_connection_state_check CHECK ((connection_state = ANY (ARRAY['DISCONNECTED'::text, 'CONNECTING'::text, 'CONNECTED'::text, 'RECONNECTING'::text, 'KICKED'::text, 'AUTH_FAILED'::text]))),
    CONSTRAINT im_support_presence_version_check CHECK ((version > 0))
);


--
-- Name: im_support_presence_session; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_presence_session (
    id text NOT NULL,
    app_id text NOT NULL,
    admin_user_id text NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    last_heartbeat_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_support_presence_session_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_support_presence_session_end_reason_check CHECK ((end_reason = ANY (ARRAY['MANUAL_OFF'::text, 'PAUSED'::text, 'DISCONNECTED'::text, 'STALE'::text, 'FORCED'::text, 'OFF_DUTY'::text]))),
    CONSTRAINT im_support_presence_session_end_shape CHECK (((ended_at IS NULL) = (end_reason IS NULL))),
    CONSTRAINT im_support_presence_session_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_support_presence_session_time_order CHECK (((last_heartbeat_at >= started_at) AND ((ended_at IS NULL) OR (ended_at >= started_at))))
);


--
-- Name: im_support_round_rating; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_round_rating (
    id text NOT NULL,
    app_id text NOT NULL,
    thread_id text NOT NULL,
    round_id text NOT NULL,
    user_id text NOT NULL,
    assigned_admin_id text NOT NULL,
    score smallint,
    comment text,
    submitted_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_support_round_rating_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_support_round_rating_comment CHECK ((char_length(comment) <= 200)),
    CONSTRAINT im_support_round_rating_comment_shape CHECK (((char_length(btrim(comment)) > 0) OR (comment IS NULL))),
    CONSTRAINT im_support_round_rating_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_support_round_rating_score CHECK (((score >= 1) AND (score <= 5))),
    CONSTRAINT im_support_round_rating_shape CHECK ((((score IS NOT NULL) AND (submitted_at IS NOT NULL) AND (dismissed_at IS NULL)) OR ((score IS NULL) AND (submitted_at IS NULL) AND (dismissed_at IS NOT NULL))))
);


--
-- Name: im_support_settings; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_settings (
    app_id text NOT NULL,
    version integer NOT NULL,
    service_message text NOT NULL,
    complaint_message text NOT NULL,
    updated_by text NOT NULL,
    operation_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_support_settings_complaint_message_check CHECK ((((length(complaint_message) >= 1) AND (length(complaint_message) <= 1000)) AND (octet_length(complaint_message) <= 3000))),
    CONSTRAINT im_support_settings_service_message_check CHECK ((((length(service_message) >= 1) AND (length(service_message) <= 1000)) AND (octet_length(service_message) <= 3000))),
    CONSTRAINT im_support_settings_version_check CHECK ((version > 0))
);


--
-- Name: im_support_thread; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.im_support_thread (
    id text NOT NULL,
    app_id text NOT NULL,
    user_id text NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'IDLE'::text NOT NULL,
    user_account_id text NOT NULL,
    peer_account_id text,
    message_scope_type text DEFAULT 'TEAM'::text NOT NULL,
    message_scope_id text,
    message_scope_state text DEFAULT 'PENDING'::text NOT NULL,
    last_round_seq integer DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    user_read_at timestamp with time zone,
    CONSTRAINT im_support_thread_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_support_thread_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_support_thread_kind_check CHECK ((kind = ANY (ARRAY['SERVICE'::text, 'COMPLAINT'::text]))),
    CONSTRAINT im_support_thread_last_round_seq_check CHECK ((last_round_seq >= 0)),
    CONSTRAINT im_support_thread_message_scope_id_check CHECK (((message_scope_id IS NULL) OR (message_scope_id ~ '^[0-9]{1,19}$'::text))),
    CONSTRAINT im_support_thread_message_scope_state_check CHECK ((message_scope_state = ANY (ARRAY['PENDING'::text, 'PROVISIONING'::text, 'READY'::text, 'FAILED'::text]))),
    CONSTRAINT im_support_thread_message_scope_type_check CHECK ((message_scope_type = 'TEAM'::text)),
    CONSTRAINT im_support_thread_peer_account_id_check CHECK (((peer_account_id IS NULL) OR (peer_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text))),
    CONSTRAINT im_support_thread_responsible_shape CHECK (((state <> 'ACTIVE'::text) OR (peer_account_id IS NOT NULL))),
    CONSTRAINT im_support_thread_scope_ready_shape CHECK (((message_scope_state <> 'READY'::text) OR (message_scope_id IS NOT NULL))),
    CONSTRAINT im_support_thread_state_check CHECK ((state = ANY (ARRAY['IDLE'::text, 'WAITING'::text, 'ACTIVE'::text]))),
    CONSTRAINT im_support_thread_user_account_id_check CHECK ((user_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'::text)),
    CONSTRAINT im_support_thread_version_check CHECK ((version > 0))
);


--
-- Name: membership_entitlement; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.membership_entitlement (
    id text NOT NULL,
    user_id text NOT NULL,
    game_id text NOT NULL,
    kind text NOT NULL,
    scope_key text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    pricing_schema text NOT NULL,
    pricing_payload jsonb NOT NULL,
    price_version_id text NOT NULL,
    cost_basis_ref text NOT NULL,
    deposit_waived boolean DEFAULT false NOT NULL,
    approved_policy_id text NOT NULL,
    approval_request_id text NOT NULL,
    approved_payload_hash character(64) NOT NULL,
    status text NOT NULL,
    replaced_by_id text,
    revoked_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deposit_allowance_cents numeric(24,0),
    CONSTRAINT membership_entitlement_check CHECK (((ends_at > starts_at) AND (ends_at <= (starts_at + '90 days'::interval)))),
    CONSTRAINT membership_entitlement_deposit_allowance_check CHECK (((deposit_allowance_cents IS NULL) OR ((deposit_allowance_cents >= (0)::numeric) AND (deposit_allowance_cents <= '999999999999999999999999'::numeric) AND ((NOT deposit_waived) OR (deposit_allowance_cents = (0)::numeric))))),
    CONSTRAINT membership_entitlement_kind_check CHECK ((kind = ANY (ARRAY['FRIEND'::text, 'PRESTIGE'::text]))),
    CONSTRAINT membership_entitlement_pricing_schema_check CHECK ((pricing_schema = ANY (ARRAY['haff-ratio-v1'::text, 'haff-ratio-v2'::text, 'total-discount-v1'::text]))),
    CONSTRAINT membership_entitlement_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED_PENDING_EXECUTION'::text, 'EXECUTED_PENDING_START'::text, 'ACTIVE'::text, 'EXPIRED'::text, 'REVOKED'::text, 'REPLACED'::text])))
);


--
-- Name: COLUMN membership_entitlement.deposit_allowance_cents; Type: COMMENT; Schema: zzsh_iam; Owner: -
--

COMMENT ON COLUMN zzsh_iam.membership_entitlement.deposit_allowance_cents IS 'Per-order tenant deposit reduction in integer cents. NULL preserves legacy boolean semantics; valid sources take max, never sum.';


--
-- Name: membership_growth_contribution; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.membership_growth_contribution (
    id text NOT NULL,
    user_id text NOT NULL,
    game_id text NOT NULL,
    source_key text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    settlement_version text NOT NULL,
    revision bigint NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    amount_cents numeric(24,0) NOT NULL,
    previous_amount_cents numeric(24,0),
    correction_of_source_key text,
    correction_mode text,
    state text NOT NULL,
    eligible boolean NOT NULL,
    exclusion_reason text,
    source_digest character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_growth_contribution_correction_mode_check CHECK ((correction_mode = ANY (ARRAY['REPLACE'::text, 'INCREMENT'::text]))),
    CONSTRAINT membership_growth_contribution_revision_check CHECK ((revision >= 0)),
    CONSTRAINT membership_growth_contribution_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT membership_growth_contribution_source_type_check CHECK ((source_type = ANY (ARRAY['RENTAL_SETTLEMENT'::text, 'MATERIAL_CONSUMPTION'::text, 'MINIMUM_BILLING'::text, 'REFUND_CORRECTION'::text]))),
    CONSTRAINT membership_growth_contribution_state_check CHECK ((state = ANY (ARRAY['SETTLED'::text, 'PENDING'::text, 'VOID'::text])))
);


--
-- Name: membership_growth_legacy_coverage; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.membership_growth_legacy_coverage (
    id text NOT NULL,
    subject_user_id text NOT NULL,
    fingerprint text NOT NULL,
    execution_key text NOT NULL,
    receipt_digest text NOT NULL,
    cutoff timestamp with time zone NOT NULL,
    from_exclusive timestamp with time zone,
    coverage_state text NOT NULL,
    record jsonb NOT NULL,
    record_canonical text NOT NULL,
    record_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT membership_growth_legacy_coverage_check CHECK ((record_digest = encode(sha256(convert_to(record_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT membership_growth_legacy_coverage_check1 CHECK (((from_exclusive IS NULL) OR (from_exclusive < cutoff))),
    CONSTRAINT membership_growth_legacy_coverage_check2 CHECK (((record_canonical)::jsonb = record)),
    CONSTRAINT membership_growth_legacy_coverage_coverage_state_check CHECK ((coverage_state = ANY (ARRAY['COMPLETE'::text, 'BACKFILL_PENDING'::text]))),
    CONSTRAINT membership_growth_legacy_coverage_execution_key_check CHECK ((execution_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'::text)),
    CONSTRAINT membership_growth_legacy_coverage_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT membership_growth_legacy_coverage_id_check CHECK ((id ~ '^growth_coverage_[a-f0-9]{48}$'::text)),
    CONSTRAINT membership_growth_legacy_coverage_receipt_digest_check CHECK ((receipt_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT membership_growth_legacy_coverage_record_check CHECK ((jsonb_typeof(record) = 'object'::text))
);


--
-- Name: membership_growth_policy; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.membership_growth_policy (
    id text NOT NULL,
    version bigint NOT NULL,
    status text NOT NULL,
    effective_at timestamp with time zone,
    rule_release_id text NOT NULL,
    price_version_id text NOT NULL,
    source_ref text NOT NULL,
    policy_schema text NOT NULL,
    policy_payload jsonb NOT NULL,
    payload_hash character(64) NOT NULL,
    approval_request_id text,
    approved_by_admin_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_growth_policy_policy_schema_check CHECK ((policy_schema = 'membership-growth-v1'::text)),
    CONSTRAINT membership_growth_policy_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text, 'REVOKED'::text]))),
    CONSTRAINT membership_growth_policy_version_check CHECK ((version >= 1))
);


--
-- Name: membership_growth_state; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.membership_growth_state (
    user_id text NOT NULL,
    policy_id text NOT NULL,
    rolling_cents numeric(24,0) NOT NULL,
    rolling_points bigint NOT NULL,
    lifetime_cents numeric(24,0) NOT NULL,
    lifetime_points bigint NOT NULL,
    normal_tier text NOT NULL,
    effective_tier text NOT NULL,
    black_gold_state text NOT NULL,
    grace_state text NOT NULL,
    last_tier_drop_at timestamp with time zone,
    grace_until timestamp with time zone,
    projection_revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT membership_growth_state_black_gold_state_check CHECK ((black_gold_state = ANY (ARRAY['QUALIFIED'::text, 'NOT_QUALIFIED'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT membership_growth_state_effective_tier_check CHECK ((effective_tier = ANY (ARRAY['STANDARD'::text, 'SILVER'::text, 'GOLD'::text, 'PLATINUM'::text, 'DIAMOND'::text, 'BLACK_GOLD'::text, 'UNKNOWN'::text]))),
    CONSTRAINT membership_growth_state_grace_state_check CHECK ((grace_state = ANY (ARRAY['NONE'::text, 'ACTIVE'::text, 'RECOVERED'::text, 'EXPIRED'::text, 'UNKNOWN'::text]))),
    CONSTRAINT membership_growth_state_normal_tier_check CHECK ((normal_tier = ANY (ARRAY['STANDARD'::text, 'SILVER'::text, 'GOLD'::text, 'PLATINUM'::text, 'DIAMOND'::text]))),
    CONSTRAINT membership_growth_state_projection_revision_check CHECK ((projection_revision >= 0))
);


--
-- Name: personal_finance_read_scope; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.personal_finance_read_scope (
    admin_user_id text NOT NULL,
    scope_key text NOT NULL,
    subject_user_id text,
    scope_kind text NOT NULL,
    version bigint NOT NULL,
    granted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT personal_finance_read_scope_check CHECK ((((scope_kind = 'ALL_SUBJECTS'::text) AND (subject_user_id IS NULL) AND (scope_key = 'ALL_SUBJECTS'::text)) OR ((scope_kind = 'SUBJECT_SET'::text) AND (subject_user_id IS NOT NULL) AND (scope_key = subject_user_id)))),
    CONSTRAINT personal_finance_read_scope_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['ALL_SUBJECTS'::text, 'SUBJECT_SET'::text]))),
    CONSTRAINT personal_finance_read_scope_version_check CHECK ((version > 0))
);


--
-- Name: user_identity_display_source; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_identity_display_source (
    user_id text NOT NULL,
    real_name text NOT NULL,
    id_card_no text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identity_display_source_id_card_no_check CHECK (((char_length(id_card_no) >= 6) AND (char_length(id_card_no) <= 32))),
    CONSTRAINT user_identity_display_source_real_name_check CHECK (((char_length(real_name) >= 1) AND (char_length(real_name) <= 64)))
);


--
-- Name: user_identity_state; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_identity_state (
    user_id text NOT NULL,
    account_status text DEFAULT 'ACTIVE'::text NOT NULL,
    identity_status text DEFAULT 'UNVERIFIED'::text NOT NULL,
    age_status text DEFAULT 'UNKNOWN'::text NOT NULL,
    provider text DEFAULT 'none'::text NOT NULL,
    provider_reference text,
    version integer DEFAULT 1 NOT NULL,
    verified_at timestamp with time zone,
    anonymized_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identity_state_account_status_check CHECK ((account_status = ANY (ARRAY['ACTIVE'::text, 'FROZEN'::text, 'CANCELLED'::text]))),
    CONSTRAINT user_identity_state_age_status_check CHECK ((age_status = ANY (ARRAY['UNKNOWN'::text, 'ADULT'::text, 'MINOR'::text]))),
    CONSTRAINT user_identity_state_identity_status_check CHECK ((identity_status = ANY (ARRAY['UNVERIFIED'::text, 'VERIFIED'::text, 'REJECTED'::text, 'UNKNOWN'::text]))),
    CONSTRAINT user_identity_state_version_check CHECK ((version > 0))
);


--
-- Name: user_note; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_note (
    id text NOT NULL,
    user_id text NOT NULL,
    body text NOT NULL,
    author_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by text,
    CONSTRAINT user_note_body_check CHECK (((char_length(btrim(body)) >= 2) AND (char_length(btrim(body)) <= 1000))),
    CONSTRAINT user_note_deletion_pair CHECK (((deleted_at IS NULL) = (deleted_by IS NULL)))
);


--
-- Name: user_registration_fact; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_registration_fact (
    user_id text NOT NULL,
    audit_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    legacy_id text,
    registered_at timestamp with time zone
);


--
-- Name: user_rental_membership; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_rental_membership (
    user_id text NOT NULL,
    tier text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    source_ref text NOT NULL,
    updated_by_admin_id text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT user_rental_membership_source_ref_check CHECK (((length(btrim(source_ref)) >= 1) AND (length(btrim(source_ref)) <= 256))),
    CONSTRAINT user_rental_membership_tier_check CHECK ((tier = ANY (ARRAY['STANDARD'::text, 'VIP'::text, 'SVIP'::text, 'DISCOUNT_USER'::text, 'UNKNOWN'::text]))),
    CONSTRAINT user_rental_membership_version_check CHECK ((version > 0))
);


--
-- Name: user_risk_flag; Type: TABLE; Schema: zzsh_iam; Owner: -
--

CREATE TABLE zzsh_iam.user_risk_flag (
    user_id text NOT NULL,
    flagged boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text NOT NULL
);


--
-- Name: channel_refund_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.channel_refund_observation (
    id text NOT NULL,
    intent_id text NOT NULL,
    event text NOT NULL,
    failure_reason text NOT NULL,
    lease_version bigint NOT NULL,
    lease_owner text NOT NULL,
    state_before text NOT NULL,
    state_after text NOT NULL,
    request_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT channel_refund_observation_check CHECK ((((event = 'UNKNOWN'::text) AND (state_before = ANY (ARRAY['SUBMITTING'::text, 'UNKNOWN'::text])) AND (state_after = 'UNKNOWN'::text)) OR ((event = 'STALE'::text) AND (state_after = state_before)))),
    CONSTRAINT channel_refund_observation_event_check CHECK ((event = ANY (ARRAY['UNKNOWN'::text, 'STALE'::text]))),
    CONSTRAINT channel_refund_observation_failure_reason_check CHECK ((failure_reason = ANY (ARRAY['TIMEOUT'::text, 'HTTP_NON_200'::text, 'CONNECTION_LOST'::text, 'RESPONSE_TRUNCATED'::text, 'LOCAL_FAILURE'::text]))),
    CONSTRAINT channel_refund_observation_lease_owner_check CHECK ((lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT channel_refund_observation_lease_version_check CHECK ((lease_version > 0)),
    CONSTRAINT channel_refund_observation_request_id_check CHECK ((request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT channel_refund_observation_state_after_check CHECK ((state_after = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text]))),
    CONSTRAINT channel_refund_observation_state_before_check CHECK ((state_before = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text])))
);


--
-- Name: controlled_payment_declaration; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.controlled_payment_declaration (
    id text NOT NULL,
    mode text NOT NULL,
    source_event_key text NOT NULL,
    resource_oid oid NOT NULL,
    app_id text NOT NULL,
    merchant_scope_id text NOT NULL,
    admission_id text NOT NULL,
    admission_revision bigint NOT NULL,
    order_id text NOT NULL,
    merchant_order_no text NOT NULL,
    provider_transaction_id text NOT NULL,
    canonical_payment text NOT NULL,
    payment_digest text NOT NULL,
    approval_digest text NOT NULL,
    created_by_admin_id text NOT NULL,
    reason text NOT NULL,
    declared_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT controlled_payment_declaration_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT controlled_payment_declaration_canonical_payment_check CHECK ((jsonb_typeof((canonical_payment)::jsonb) = 'object'::text)),
    CONSTRAINT controlled_payment_declaration_check CHECK ((payment_digest = encode(sha256(convert_to(canonical_payment, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT controlled_payment_declaration_check1 CHECK (((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text) AND (merchant_scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))),
    CONSTRAINT controlled_payment_declaration_id_check CHECK ((id ~ '^[A-Za-z0-9_-]{1,128}$'::text)),
    CONSTRAINT controlled_payment_declaration_mode_check CHECK ((mode = 'LOCAL_CONTROLLED_DECLARED_PAYMENT'::text)),
    CONSTRAINT controlled_payment_declaration_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500)))
);


--
-- Name: controlled_payout_notice; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.controlled_payout_notice (
    id text NOT NULL,
    mode text NOT NULL,
    source_system text NOT NULL,
    source_event_key text NOT NULL,
    original_operation_id text NOT NULL,
    intent_id text NOT NULL,
    payout_key text NOT NULL,
    user_id text NOT NULL,
    evidence_canonical text NOT NULL,
    source_digest text NOT NULL,
    approval_digest text NOT NULL,
    declared_by_admin_id text NOT NULL,
    declaration_reason text NOT NULL,
    declared_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT controlled_payout_notice_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT controlled_payout_notice_check CHECK ((source_digest = encode(sha256(convert_to(evidence_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT controlled_payout_notice_declaration_reason_check CHECK (((length(btrim(declaration_reason)) >= 3) AND (length(btrim(declaration_reason)) <= 500))),
    CONSTRAINT controlled_payout_notice_evidence_canonical_check CHECK ((octet_length(evidence_canonical) <= 4096)),
    CONSTRAINT controlled_payout_notice_id_check CHECK (((length(id) >= 1) AND (length(id) <= 128))),
    CONSTRAINT controlled_payout_notice_mode_check CHECK ((mode = 'LOCAL_CONTROLLED_DECLARED_NOTICE'::text)),
    CONSTRAINT controlled_payout_notice_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT controlled_payout_notice_source_event_key_check CHECK (((length(source_event_key) >= 1) AND (length(source_event_key) <= 128))),
    CONSTRAINT controlled_payout_notice_source_system_check CHECK ((source_system = 'zzsh-local-declared-notification-v1'::text))
);


--
-- Name: controlled_payout_operation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.controlled_payout_operation (
    id text NOT NULL,
    intent_id text NOT NULL,
    payout_key text NOT NULL,
    mode text NOT NULL,
    scenario text NOT NULL,
    final_evidence_canonical text NOT NULL,
    final_evidence_digest text NOT NULL,
    original_lease_hash text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT controlled_payout_operation_check CHECK ((final_evidence_digest = encode(sha256(convert_to(final_evidence_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT controlled_payout_operation_final_evidence_digest_check CHECK ((final_evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT controlled_payout_operation_mode_check CHECK ((mode = 'LOCAL_CONTROLLED'::text)),
    CONSTRAINT controlled_payout_operation_original_lease_hash_check CHECK ((original_lease_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT controlled_payout_operation_scenario_check CHECK ((scenario = ANY (ARRAY['FAIL_UNPAID'::text, 'TIMEOUT_THEN_SUCCEED'::text])))
);


--
-- Name: display_no_seq; Type: SEQUENCE; Schema: zzsh_order; Owner: -
--

CREATE SEQUENCE zzsh_order.display_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: distribution_invite_code; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.distribution_invite_code (
    id text NOT NULL,
    user_id text,
    display_code character varying(30) NOT NULL,
    match_code character varying(30) GENERATED ALWAYS AS (upper((display_code)::text)) STORED,
    source_type text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    source_digest text NOT NULL,
    CONSTRAINT distribution_invite_code_display_code_check CHECK (((display_code)::text ~ '^[A-Za-z0-9_-]{1,30}$'::text)),
    CONSTRAINT distribution_invite_code_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT distribution_invite_code_source_type_check CHECK ((source_type = ANY (ARRAY['NATIVE_REGISTRATION'::text, 'LEGACY_MYSQL'::text, 'LOCAL_CONTROLLED'::text])))
);


--
-- Name: distribution_order_admission; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.distribution_order_admission (
    id text NOT NULL,
    order_id text NOT NULL,
    resource_oid oid NOT NULL,
    resource_name text NOT NULL,
    resource_marker text NOT NULL,
    approval_digest text NOT NULL,
    native_creation_audit_id text NOT NULL,
    revision bigint NOT NULL,
    active boolean NOT NULL,
    admitted_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by_admin_id text,
    reason text NOT NULL,
    mode text DEFAULT 'LOCAL_CONTROLLED'::text NOT NULL,
    source_admission_ref text,
    CONSTRAINT distribution_admission_mode_shape CHECK ((((mode = 'LOCAL_CONTROLLED'::text) AND (resource_marker = 'zzsh:order-reservation-test:v1'::text) AND (created_by_admin_id IS NOT NULL) AND (source_admission_ref IS NULL)) OR ((mode = 'NATIVE'::text) AND (resource_marker = 'NATIVE_CREATED_ORDER_V1'::text) AND (created_by_admin_id IS NULL) AND (source_admission_ref IS NOT NULL)))),
    CONSTRAINT distribution_order_admission_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT distribution_order_admission_check CHECK ((expires_at > admitted_at)),
    CONSTRAINT distribution_order_admission_mode_check CHECK ((mode = ANY (ARRAY['LOCAL_CONTROLLED'::text, 'NATIVE'::text]))),
    CONSTRAINT distribution_order_admission_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500))),
    CONSTRAINT distribution_order_admission_revision_check CHECK ((revision = 1))
);


--
-- Name: distribution_participant; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.distribution_participant (
    user_id text NOT NULL,
    eligibility text NOT NULL,
    commission_frozen boolean,
    level_code text,
    policy_version_id text,
    revision bigint NOT NULL,
    inviter_knowledge text NOT NULL,
    leader_knowledge text NOT NULL,
    invitees_knowledge text DEFAULT 'UNKNOWN'::text NOT NULL,
    source_type text NOT NULL,
    source_ref text NOT NULL,
    source_digest text NOT NULL,
    CONSTRAINT distribution_participant_check CHECK (((eligibility <> 'ELIGIBLE'::text) OR (policy_version_id IS NOT NULL))),
    CONSTRAINT distribution_participant_eligibility_check CHECK ((eligibility = ANY (ARRAY['ELIGIBLE'::text, 'INELIGIBLE'::text, 'UNKNOWN'::text]))),
    CONSTRAINT distribution_participant_invitees_knowledge_check CHECK ((invitees_knowledge = ANY (ARRAY['KNOWN'::text, 'UNKNOWN'::text]))),
    CONSTRAINT distribution_participant_inviter_knowledge_check CHECK ((inviter_knowledge = ANY (ARRAY['KNOWN_NONE'::text, 'KNOWN_PARENT'::text, 'UNKNOWN'::text]))),
    CONSTRAINT distribution_participant_leader_knowledge_check CHECK ((leader_knowledge = ANY (ARRAY['KNOWN_NONE'::text, 'KNOWN_PARENT'::text, 'UNKNOWN'::text]))),
    CONSTRAINT distribution_participant_revision_check CHECK ((revision > 0)),
    CONSTRAINT distribution_participant_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT distribution_participant_source_ref_check CHECK (((length(btrim(source_ref)) >= 1) AND (length(btrim(source_ref)) <= 256))),
    CONSTRAINT distribution_participant_source_type_check CHECK ((source_type = ANY (ARRAY['NATIVE_REGISTRATION'::text, 'LEGACY_MYSQL'::text, 'LOCAL_CONTROLLED'::text])))
);


--
-- Name: distribution_policy_head; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.distribution_policy_head (
    scope text NOT NULL,
    revision bigint NOT NULL,
    current_version_id text NOT NULL,
    CONSTRAINT distribution_policy_head_revision_check CHECK ((revision > 0)),
    CONSTRAINT distribution_policy_head_scope_check CHECK ((scope = ANY (ARRAY['LOCAL_CONTROLLED'::text, 'NATIVE'::text])))
);


--
-- Name: distribution_policy_version; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.distribution_policy_version (
    id text NOT NULL,
    revision bigint NOT NULL,
    scope text NOT NULL,
    schema_version text NOT NULL,
    canonical_config text NOT NULL,
    config_digest text NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT distribution_policy_version_canonical_config_check CHECK ((jsonb_typeof((canonical_config)::jsonb) = 'object'::text)),
    CONSTRAINT distribution_policy_version_check CHECK ((config_digest = encode(sha256(convert_to(canonical_config, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT distribution_policy_version_config_digest_check CHECK ((config_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT distribution_policy_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT distribution_policy_version_schema_version_check CHECK ((schema_version = ANY (ARRAY['distribution-policy.v1'::text, 'distribution-policy.v2'::text]))),
    CONSTRAINT distribution_policy_version_scope_check CHECK ((scope = ANY (ARRAY['LOCAL_CONTROLLED'::text, 'NATIVE'::text])))
);


--
-- Name: finance_covered_event; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_covered_event (
    basis_id text NOT NULL,
    user_id text NOT NULL,
    source_kind text NOT NULL,
    source_type text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    beneficiary_role text NOT NULL,
    source_event_at timestamp with time zone NOT NULL,
    source_digest text NOT NULL,
    CONSTRAINT finance_covered_event_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finance_covered_event_source_event_at_check CHECK ((EXTRACT(epoch FROM source_event_at) = trunc(EXTRACT(epoch FROM source_event_at)))),
    CONSTRAINT finance_covered_event_source_kind_check CHECK ((source_kind = ANY (ARRAY['LEGACY_DISTRIBUTION_EARNING'::text, 'LEGACY_WITHDRAWAL'::text, 'LEGACY_RENTAL_OWNER_INCOME'::text, 'LEGACY_ADMIN_LOG'::text, 'LEGACY_DEPOSIT_COMPENSATION'::text, 'LEGACY_WITHDRAWAL_RETURN'::text]))),
    CONSTRAINT finance_covered_event_source_shape CHECK ((((source_kind = 'LEGACY_DISTRIBUTION_EARNING'::text) AND (source_entity = 'la_distribution_order'::text) AND (beneficiary_role = ANY (ARRAY['TASK_REFERRAL'::text, 'RENTER_REFERRAL'::text, 'OWNER_REFERRAL'::text]))) OR ((source_kind = 'LEGACY_WITHDRAWAL'::text) AND (source_entity = 'la_withdraw_apply'::text) AND (beneficiary_role = 'WALLET_HOLDER'::text)) OR ((source_kind = ANY (ARRAY['LEGACY_RENTAL_OWNER_INCOME'::text, 'LEGACY_DEPOSIT_COMPENSATION'::text])) AND (source_entity = 'la_order'::text) AND (beneficiary_role = 'OWNER'::text)) OR ((source_kind = ANY (ARRAY['LEGACY_ADMIN_LOG'::text, 'LEGACY_WITHDRAWAL_RETURN'::text])) AND (source_entity = 'la_log_earnings'::text) AND (beneficiary_role = 'WALLET_HOLDER'::text)))),
    CONSTRAINT finance_covered_event_source_type_check CHECK ((source_type = 'LEGACY_MYSQL'::text))
);


--
-- Name: finance_economic_root; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_economic_root (
    id text NOT NULL,
    basis_id text,
    source_kind text NOT NULL,
    source_type text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    subject_user_id text NOT NULL,
    beneficiary_role text NOT NULL,
    policy_version text,
    source_digest text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT finance_economic_root_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finance_root_enabled_source_shape CHECK ((((source_kind = ANY (ARRAY['LEGACY_OPENING'::text, 'NATIVE_GENESIS'::text])) AND (basis_id IS NOT NULL)) OR ((source_kind = ANY (ARRAY['LOCAL_CONTROLLED_WITHDRAWAL'::text, 'NATIVE_RENTAL_REFERRAL'::text, 'NATIVE_GUARANTEE'::text, 'LEGACY_CONTINUATION_DUTY'::text, 'NATIVE_RENTAL_REFUND'::text, 'JOINPAY_WITHDRAWAL'::text, 'NATIVE_ABNORMAL_REFUND'::text, 'NATIVE_PRESTART_REFUND'::text])) AND (basis_id IS NULL))))
);


--
-- Name: finance_event; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_event (
    id text NOT NULL,
    economic_root_id text NOT NULL,
    kind text NOT NULL,
    subject_user_id text NOT NULL,
    expected_ledger_revision bigint NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT finance_event_expected_ledger_revision_check CHECK ((expected_ledger_revision >= 0)),
    CONSTRAINT finance_event_kind_check CHECK ((kind = ANY (ARRAY['OPENING'::text, 'RESERVE'::text, 'RELEASE'::text, 'PAYOUT'::text, 'EARNING_PENDING'::text, 'EARNING_SETTLED'::text, 'EARNING_REVOKED'::text, 'GUARANTEE_CAPTURE'::text, 'GUARANTEE_REFUND'::text, 'LEGACY_DUTY_SETTLED'::text, 'REFUND_PAID'::text, 'JOINPAY_WITHDRAWAL_RESERVED'::text, 'JOINPAY_WITHDRAWAL_PAID'::text, 'JOINPAY_WITHDRAWAL_RELEASED'::text, 'REFUND_LIABILITY_RECOGNIZED'::text])))
);


--
-- Name: finance_observation_admission; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_observation_admission (
    basis_id text NOT NULL,
    user_id text NOT NULL,
    source_system text NOT NULL,
    legacy_user_id text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    source_digest text NOT NULL,
    source_event_at timestamp with time zone NOT NULL,
    included_in_opening boolean NOT NULL,
    CONSTRAINT finance_observation_admission_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: finance_opening_basis; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_opening_basis (
    id text NOT NULL,
    user_id text NOT NULL,
    source_kind text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    identity_source_digest text,
    source_digest text NOT NULL,
    available_cents numeric(24,0) NOT NULL,
    source_cutoff timestamp with time zone,
    covered_count integer NOT NULL,
    covered_set_digest text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    native_origin_canonical text,
    CONSTRAINT finance_opening_basis_available_cents_check CHECK ((available_cents >= (0)::numeric)),
    CONSTRAINT finance_opening_basis_check CHECK ((((source_kind = 'LEGACY_OPENING'::text) AND (source_entity = 'la_user'::text) AND (source_cutoff IS NOT NULL) AND (identity_source_digest IS NOT NULL) AND (identity_source_digest ~ '^[0-9a-f]{64}$'::text) AND (native_origin_canonical IS NULL)) OR ((source_kind = 'NATIVE_GENESIS'::text) AND (source_system = 'zzsh-native-registration'::text) AND (source_entity = 'zzsh_auth_user.user'::text) AND (source_id = user_id) AND (available_cents = (0)::numeric) AND (covered_count = 0) AND (covered_set_digest = encode(sha256(convert_to(''::text, 'UTF8'::name)), 'hex'::text)) AND (source_cutoff IS NOT NULL) AND (native_origin_canonical IS NOT NULL) AND (source_digest = encode(sha256(convert_to(native_origin_canonical, 'UTF8'::name)), 'hex'::text)) AND (identity_source_digest = source_digest)))),
    CONSTRAINT finance_opening_basis_covered_count_check CHECK ((covered_count >= 0)),
    CONSTRAINT finance_opening_basis_covered_set_digest_check CHECK ((covered_set_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finance_opening_basis_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT finance_opening_basis_source_kind_check CHECK ((source_kind = ANY (ARRAY['LEGACY_OPENING'::text, 'NATIVE_GENESIS'::text])))
);


--
-- Name: finance_stored_opening_review; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.finance_stored_opening_review (
    basis_id text NOT NULL,
    body_digest text NOT NULL,
    source_canonical text NOT NULL,
    input_canonical text NOT NULL,
    review_canonical text NOT NULL,
    review_digest text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT finance_stored_opening_review_body_digest_check CHECK ((body_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT finance_stored_opening_review_review_digest_check CHECK ((review_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: im_order_activity; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_activity (
    order_id text NOT NULL,
    app_id text NOT NULL,
    last_message_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_message_preview text,
    CONSTRAINT im_order_activity_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))
);


--
-- Name: im_order_due_reminder; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_due_reminder (
    id text NOT NULL,
    order_id text NOT NULL,
    app_id text NOT NULL,
    bucket text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_until timestamp with time zone,
    lease_token_hash text,
    sent_at timestamp with time zone,
    failure_class text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_order_due_reminder_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_order_due_reminder_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT im_order_due_reminder_bucket_check CHECK ((bucket = ANY (ARRAY['BEFORE_24H'::text, 'DUE'::text, 'AFTER_1D'::text, 'AFTER_2D'::text, 'AFTER_3D'::text]))),
    CONSTRAINT im_order_due_reminder_failure_class_check CHECK (((failure_class IS NULL) OR (failure_class ~ '^[A-Z_]{1,64}$'::text))),
    CONSTRAINT im_order_due_reminder_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_order_due_reminder_sending_shape CHECK ((((state = 'SENDING'::text) AND (lease_until IS NOT NULL) AND (lease_token_hash IS NOT NULL)) OR ((state <> 'SENDING'::text) AND (lease_until IS NULL) AND (lease_token_hash IS NULL)))),
    CONSTRAINT im_order_due_reminder_sent_shape CHECK (((state = 'SENT'::text) = (sent_at IS NOT NULL))),
    CONSTRAINT im_order_due_reminder_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'SENDING'::text, 'SENT'::text, 'SKIPPED'::text])))
);


--
-- Name: im_order_event; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_event (
    id text NOT NULL,
    order_id text NOT NULL,
    app_id text NOT NULL,
    team_id text NOT NULL,
    event_key text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    actor text,
    message_client_id text,
    message_server_id text,
    sender_account_id text NOT NULL,
    message_type text,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    raw_body_sha256 text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    related_operation_id text,
    CONSTRAINT im_order_event_body_shape CHECK (((type = 'verify_required'::text) OR ((type = ANY (ARRAY['first_response_reminder'::text, 'add_member'::text, 'bot_notice'::text, 'staff_exhausted'::text])) AND (raw_body_sha256 IS NULL)) OR ((type = ANY (ARRAY['send_approved'::text, 'message_delivered'::text, 'first_response'::text])) AND (raw_body_sha256 IS NOT NULL)))),
    CONSTRAINT im_order_event_check2 CHECK (((type <> 'message_delivered'::text) OR (message_server_id IS NOT NULL))),
    CONSTRAINT im_order_event_check3 CHECK (((type <> 'send_approved'::text) OR (message_client_id IS NOT NULL))),
    CONSTRAINT im_order_event_event_key_check CHECK (((char_length(event_key) >= 1) AND (char_length(event_key) <= 200))),
    CONSTRAINT im_order_event_message_client_id_check CHECK (((message_client_id IS NULL) OR ((char_length(message_client_id) >= 1) AND (char_length(message_client_id) <= 128)))),
    CONSTRAINT im_order_event_message_server_id_check CHECK (((message_server_id IS NULL) OR (message_server_id ~ '^[0-9]{1,19}$'::text))),
    CONSTRAINT im_order_event_message_type_check CHECK ((message_type = ANY (ARRAY['TEXT'::text, 'PICTURE'::text]))),
    CONSTRAINT im_order_event_raw_body_sha256_check CHECK ((raw_body_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT im_order_event_sender_account_id_check CHECK (((char_length(sender_account_id) >= 1) AND (char_length(sender_account_id) <= 64))),
    CONSTRAINT im_order_event_status_check CHECK ((((type = 'send_approved'::text) AND (status = ANY (ARRAY['VERIFIED'::text, 'REJECTED'::text]))) OR ((type = 'message_delivered'::text) AND (status = ANY (ARRAY['WAITING_AUTH'::text, 'VERIFIED'::text, 'REJECTED'::text, 'VERIFY_REQUIRED'::text]))) OR ((type = 'first_response'::text) AND (status = 'VERIFIED'::text)) OR ((type = 'verify_required'::text) AND (status = 'VERIFY_REQUIRED'::text)) OR ((type = 'first_response_reminder'::text) AND (status = 'RECORDED'::text)) OR ((type = ANY (ARRAY['add_member'::text, 'bot_notice'::text])) AND (status = 'PLANNED'::text)) OR ((type = 'staff_exhausted'::text) AND (status = 'EXHAUSTED'::text)))),
    CONSTRAINT im_order_event_team_id_check CHECK ((team_id ~ '^[0-9]{1,19}$'::text)),
    CONSTRAINT im_order_event_type_check CHECK ((type = ANY (ARRAY['send_approved'::text, 'message_delivered'::text, 'first_response'::text, 'verify_required'::text, 'first_response_reminder'::text, 'add_member'::text, 'bot_notice'::text, 'staff_exhausted'::text])))
);


--
-- Name: im_order_group; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_group (
    order_id text NOT NULL,
    payment_confirmation_id text NOT NULL,
    app_id text NOT NULL,
    provision_state text DEFAULT 'WAITING'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    assigned_admin_id text,
    assigned_at timestamp with time zone,
    version bigint DEFAULT 1 NOT NULL,
    wait_reason text,
    team_state text DEFAULT 'PENDING'::text NOT NULL,
    system_identity_id text,
    team_name text,
    members_limit integer,
    team_id text,
    team_ready_at timestamp with time zone,
    team_failure text,
    team_retry_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    first_response_event_id text,
    first_response_at timestamp with time zone,
    first_response_state text DEFAULT 'NOT_STARTED'::text NOT NULL,
    responsible_admin_id text,
    remind_due_at timestamp with time zone,
    next_add_due_at timestamp with time zone,
    add_round integer DEFAULT 0 NOT NULL,
    escalation_state text DEFAULT 'NOT_STARTED'::text NOT NULL,
    CONSTRAINT im_order_escalation_inactive_due_shape CHECK (((escalation_state = ANY (ARRAY['RUNNING'::text, 'NOT_STARTED'::text])) OR ((remind_due_at IS NULL) AND (next_add_due_at IS NULL)))),
    CONSTRAINT im_order_escalation_not_started_shape CHECK (((escalation_state <> 'NOT_STARTED'::text) OR ((remind_due_at IS NULL) AND (next_add_due_at IS NULL)))),
    CONSTRAINT im_order_escalation_running_shape CHECK (((escalation_state <> 'RUNNING'::text) OR ((team_state = 'READY'::text) AND (first_response_state = 'RUNNING'::text) AND (responsible_admin_id IS NOT NULL)))),
    CONSTRAINT im_order_first_response_shape CHECK ((((first_response_state = ANY (ARRAY['NOT_STARTED'::text, 'RUNNING'::text, 'VERIFY_REQUIRED'::text])) AND (first_response_event_id IS NULL) AND (first_response_at IS NULL)) OR ((first_response_state = 'STOPPED'::text) AND (first_response_event_id IS NOT NULL) AND (first_response_at IS NOT NULL)))),
    CONSTRAINT im_order_group_add_round_check CHECK ((add_round >= 0)),
    CONSTRAINT im_order_group_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_order_group_assignment_shape CHECK ((((provision_state = 'WAITING'::text) AND (assigned_admin_id IS NULL) AND (assigned_at IS NULL)) OR ((provision_state = 'ASSIGNED'::text) AND (assigned_admin_id IS NOT NULL) AND (assigned_at IS NOT NULL) AND (wait_reason IS NULL)))),
    CONSTRAINT im_order_group_escalation_state_check CHECK ((escalation_state = ANY (ARRAY['NOT_STARTED'::text, 'RUNNING'::text, 'STOPPED'::text, 'EXHAUSTED'::text, 'VERIFY_REQUIRED'::text]))),
    CONSTRAINT im_order_group_first_response_state_check CHECK ((first_response_state = ANY (ARRAY['NOT_STARTED'::text, 'RUNNING'::text, 'STOPPED'::text, 'VERIFY_REQUIRED'::text]))),
    CONSTRAINT im_order_group_members_limit_check CHECK (((members_limit >= 4) AND (members_limit <= 5000))),
    CONSTRAINT im_order_group_team_failure_check CHECK ((team_failure ~ '^[A-Z_]{1,64}$'::text)),
    CONSTRAINT im_order_group_team_id_check CHECK ((team_id ~ '^[0-9]{1,19}$'::text)),
    CONSTRAINT im_order_group_team_name_check CHECK (((char_length(team_name) >= 1) AND (char_length(team_name) <= 64))),
    CONSTRAINT im_order_group_team_state_check CHECK ((team_state = ANY (ARRAY['PENDING'::text, 'IDENTITY_PENDING'::text, 'CREATING'::text, 'READY'::text, 'NEEDS_REVIEW'::text]))),
    CONSTRAINT im_order_group_version_check CHECK ((version > 0)),
    CONSTRAINT im_order_group_wait_reason_check CHECK ((wait_reason = 'NO_ELIGIBLE_STAFF'::text)),
    CONSTRAINT im_order_plan_shape CHECK (((team_state <> ALL (ARRAY['CREATING'::text, 'READY'::text])) OR ((provision_state = 'ASSIGNED'::text) AND (system_identity_id IS NOT NULL) AND (team_name IS NOT NULL) AND (members_limit IS NOT NULL)))),
    CONSTRAINT im_order_responsible_ready_shape CHECK (((team_state <> 'READY'::text) OR (responsible_admin_id IS NOT NULL))),
    CONSTRAINT im_order_team_shape CHECK ((((team_state <> 'READY'::text) AND (team_id IS NULL) AND (team_ready_at IS NULL)) OR ((team_state = 'READY'::text) AND (team_id IS NOT NULL) AND (team_ready_at IS NOT NULL))))
);


--
-- Name: im_order_member; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_member (
    order_id text NOT NULL,
    app_id text NOT NULL,
    identity_id text NOT NULL,
    party text NOT NULL,
    state text DEFAULT 'PLANNED'::text NOT NULL,
    joined_at timestamp with time zone,
    CONSTRAINT im_order_member_check CHECK ((((state = 'PLANNED'::text) AND (joined_at IS NULL)) OR ((state = 'JOINED'::text) AND (joined_at IS NOT NULL)))),
    CONSTRAINT im_order_member_party_check CHECK ((party = ANY (ARRAY['BUYER'::text, 'OWNER'::text, 'STAFF'::text]))),
    CONSTRAINT im_order_member_state_check CHECK ((state = ANY (ARRAY['PLANNED'::text, 'JOINED'::text])))
);


--
-- Name: im_order_operation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_operation (
    id text NOT NULL,
    order_id text NOT NULL,
    app_id text NOT NULL,
    kind text DEFAULT 'CREATE'::text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_until timestamp with time zone,
    lease_token_hash text,
    sent_at timestamp with time zone,
    candidate_team_id text,
    failure_class text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    round integer DEFAULT 0 NOT NULL,
    target_admin_id text,
    CONSTRAINT im_order_operation_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT im_order_operation_candidate_shape CHECK (((candidate_team_id IS NULL) OR ((sent_at IS NOT NULL) AND (kind = ANY (ARRAY['CREATE'::text, 'ADD_MEMBER'::text]))))),
    CONSTRAINT im_order_operation_candidate_team_id_check CHECK ((candidate_team_id ~ '^[0-9]{1,19}$'::text)),
    CONSTRAINT im_order_operation_check CHECK ((((state = 'RUNNING'::text) AND (lease_until IS NOT NULL) AND (lease_token_hash IS NOT NULL)) OR ((state <> 'RUNNING'::text) AND (lease_until IS NULL) AND (lease_token_hash IS NULL)))),
    CONSTRAINT im_order_operation_failure_class_check CHECK ((failure_class ~ '^[A-Z_]{1,64}$'::text)),
    CONSTRAINT im_order_operation_kind_check CHECK ((kind = ANY (ARRAY['CREATE'::text, 'ADD_MEMBER'::text, 'BOT_NOTICE'::text]))),
    CONSTRAINT im_order_operation_pending_unsent CHECK (((state <> 'PENDING'::text) OR (sent_at IS NULL))),
    CONSTRAINT im_order_operation_round_check CHECK ((round >= 0)),
    CONSTRAINT im_order_operation_round_target CHECK ((((kind = 'CREATE'::text) AND (round = 0) AND (target_admin_id IS NULL)) OR ((kind = 'ADD_MEMBER'::text) AND (round >= 1) AND (target_admin_id IS NOT NULL)) OR ((kind = 'BOT_NOTICE'::text) AND (round >= 1) AND (target_admin_id IS NULL)))),
    CONSTRAINT im_order_operation_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'NEEDS_REVIEW'::text, 'SUCCEEDED'::text, 'CANCELLED'::text]))),
    CONSTRAINT im_order_operation_success_shape CHECK (((state <> 'SUCCEEDED'::text) OR ((kind = ANY (ARRAY['CREATE'::text, 'ADD_MEMBER'::text])) AND (candidate_team_id IS NOT NULL)) OR ((kind = 'BOT_NOTICE'::text) AND (candidate_team_id IS NULL)))),
    CONSTRAINT im_order_operation_version_check CHECK ((version > 0))
);


--
-- Name: im_order_stage_card; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_stage_card (
    id text NOT NULL,
    order_id text NOT NULL,
    app_id text NOT NULL,
    kind text NOT NULL,
    card_id text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_until timestamp with time zone,
    lease_token_hash text,
    sent_at timestamp with time zone,
    failure_class text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT im_order_stage_card_app_id_check CHECK ((app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_order_stage_card_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT im_order_stage_card_card_id_check CHECK ((card_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT im_order_stage_card_failure_class_check CHECK (((failure_class IS NULL) OR (failure_class ~ '^[A-Z_]{1,64}$'::text))),
    CONSTRAINT im_order_stage_card_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 128))),
    CONSTRAINT im_order_stage_card_kind_check CHECK ((kind = ANY (ARRAY['ORDER_WELCOME'::text, 'ORDER_OPENING'::text, 'ORDER_ENDING'::text, 'ORDER_SETTLED'::text, 'ORDER_PRICE_CHANGE'::text]))),
    CONSTRAINT im_order_stage_card_sending_shape CHECK ((((state = 'SENDING'::text) AND (lease_until IS NOT NULL) AND (lease_token_hash IS NOT NULL)) OR ((state <> 'SENDING'::text) AND (lease_until IS NULL) AND (lease_token_hash IS NULL)))),
    CONSTRAINT im_order_stage_card_sent_shape CHECK (((state = 'SENT'::text) = (sent_at IS NOT NULL))),
    CONSTRAINT im_order_stage_card_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'SENDING'::text, 'SENT'::text, 'SKIPPED'::text])))
);


--
-- Name: im_order_unread; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.im_order_unread (
    order_id text NOT NULL,
    identity_id text NOT NULL,
    unread_count integer DEFAULT 0 NOT NULL,
    last_read_at timestamp with time zone,
    CONSTRAINT im_order_unread_unread_count_check CHECK ((unread_count >= 0))
);


--
-- Name: invitation_relation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.invitation_relation (
    id text NOT NULL,
    type text NOT NULL,
    child_user_id text NOT NULL,
    parent_user_id text NOT NULL,
    policy_version_id text,
    source_type text NOT NULL,
    source_ref text NOT NULL,
    source_digest text NOT NULL,
    bound_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT invitation_relation_check CHECK ((child_user_id <> parent_user_id)),
    CONSTRAINT invitation_relation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT invitation_relation_source_type_check CHECK ((source_type = ANY (ARRAY['NATIVE_REGISTRATION'::text, 'LEGACY_MYSQL'::text, 'LOCAL_CONTROLLED'::text, 'NATIVE_SELF_BIND'::text]))),
    CONSTRAINT invitation_relation_type_check CHECK ((type = ANY (ARRAY['INVITER'::text, 'DISTRIBUTION_LEADER'::text])))
);


--
-- Name: joinpay_account_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_account_observation (
    attempt_id text NOT NULL,
    merchant_identity_id text NOT NULL,
    operation text NOT NULL,
    profile_id text NOT NULL,
    profile_sha256 text NOT NULL,
    rules_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    review_ref text NOT NULL,
    review_sha256 text NOT NULL,
    request_sha256 text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    http_status integer,
    response_complete boolean NOT NULL,
    received_bytes bigint NOT NULL,
    transport_failure text,
    raw_body bytea,
    raw_sha256 text,
    evidence_level text NOT NULL,
    decision text NOT NULL,
    schema_status text NOT NULL,
    signature_status text NOT NULL,
    binding_status text NOT NULL,
    reason text NOT NULL,
    status_code text,
    error_code text,
    amounts jsonb,
    CONSTRAINT joinpay_account_observation_attempt_id_check CHECK ((attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_account_observation_binding_status_check CHECK ((binding_status = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text]))),
    CONSTRAINT joinpay_account_observation_check CHECK ((received_at >= requested_at)),
    CONSTRAINT joinpay_account_observation_check1 CHECK ((((raw_body IS NULL) AND (raw_sha256 IS NULL) AND (NOT response_complete) AND (received_bytes = 0)) OR ((raw_body IS NOT NULL) AND (raw_sha256 IS NOT NULL) AND (raw_sha256 = encode(sha256(raw_body), 'hex'::text)) AND (octet_length(raw_body) <= 65536) AND (received_bytes >= octet_length(raw_body)) AND ((NOT response_complete) OR (received_bytes = octet_length(raw_body)))))),
    CONSTRAINT joinpay_account_observation_check2 CHECK (((decision = 'UNKNOWN'::text) OR (response_complete AND (http_status = 200) AND (transport_failure IS NULL) AND (schema_status = 'VALID'::text) AND (signature_status = 'MATCH'::text) AND (binding_status = 'MATCH'::text)))),
    CONSTRAINT joinpay_account_observation_check3 CHECK ((((decision = 'SUCCESS'::text) AND (status_code = '2001'::text) AND (error_code IS NULL) AND (amounts IS NOT NULL) AND (jsonb_typeof(amounts) = 'object'::text)) OR ((decision <> 'SUCCESS'::text) AND (amounts IS NULL)))),
    CONSTRAINT joinpay_account_observation_decision_check CHECK ((decision = ANY (ARRAY['SUCCESS'::text, 'SIGNED_PROVIDER_ERROR'::text, 'UNKNOWN'::text]))),
    CONSTRAINT joinpay_account_observation_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['SYNTHETIC_PROTOCOL'::text, 'PROVIDER_RESPONSE'::text]))),
    CONSTRAINT joinpay_account_observation_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT joinpay_account_observation_merchant_identity_id_check CHECK ((merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_account_observation_operation_check CHECK ((operation = ANY (ARRAY['AVAILABLE'::text, 'COLLECTION'::text]))),
    CONSTRAINT joinpay_account_observation_profile_sha256_check CHECK ((profile_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_account_observation_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 128))),
    CONSTRAINT joinpay_account_observation_received_bytes_check CHECK ((received_bytes >= 0)),
    CONSTRAINT joinpay_account_observation_request_sha256_check CHECK ((request_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_account_observation_review_sha256_check CHECK ((review_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_account_observation_rules_sha256_check CHECK ((rules_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_account_observation_schema_status_check CHECK ((schema_status = ANY (ARRAY['VALID'::text, 'INVALID'::text]))),
    CONSTRAINT joinpay_account_observation_signature_status_check CHECK ((signature_status = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text])))
);


--
-- Name: joinpay_collection_attempt; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_collection_attempt (
    id text NOT NULL,
    request_id text NOT NULL,
    lease_version bigint NOT NULL,
    lease_owner text NOT NULL,
    operation text NOT NULL,
    profile_id text NOT NULL,
    profile_canonical text NOT NULL,
    profile_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    evidence_mode text NOT NULL,
    request_body bytea NOT NULL,
    request_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_collection_attempt_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_collection_attempt_check1 CHECK ((request_sha256 = encode(sha256(request_body), 'hex'::text))),
    CONSTRAINT joinpay_collection_attempt_evidence_mode_check CHECK ((evidence_mode = 'OFFICIAL'::text)),
    CONSTRAINT joinpay_collection_attempt_id_check CHECK ((id ~ '^jpat_[0-9a-f]{32}$'::text)),
    CONSTRAINT joinpay_collection_attempt_key_version_ref_check CHECK ((key_version_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_collection_attempt_lease_owner_check CHECK ((lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_collection_attempt_lease_version_check CHECK ((lease_version > 0)),
    CONSTRAINT joinpay_collection_attempt_operation_check CHECK ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text]))),
    CONSTRAINT joinpay_collection_attempt_profile_canonical_check CHECK ((octet_length(profile_canonical) <= 131072)),
    CONSTRAINT joinpay_collection_attempt_profile_id_check CHECK ((profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_collection_attempt_request_body_check CHECK (((octet_length(request_body) >= 1) AND (octet_length(request_body) <= 16384)))
);


--
-- Name: joinpay_collection_binding; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_collection_binding (
    request_id text NOT NULL,
    wire_merchant_no text NOT NULL,
    trade_merchant_no text NOT NULL,
    product_name text NOT NULL,
    notify_url text NOT NULL,
    initial_profile_sha256 text NOT NULL,
    evidence_mode text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    formal_admission_ref text,
    formal_admission_sha256 text,
    formal_admission_canonical text,
    CONSTRAINT joinpay_collection_binding_evidence_mode_check CHECK ((evidence_mode = 'OFFICIAL'::text)),
    CONSTRAINT joinpay_collection_binding_initial_profile_sha256_check CHECK ((initial_profile_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT joinpay_collection_binding_notify_url_check CHECK (((notify_url ~~ 'https://%'::text) AND (length(notify_url) <= 300))),
    CONSTRAINT joinpay_collection_binding_product_name_check CHECK (((length(product_name) >= 1) AND (length(product_name) <= 30))),
    CONSTRAINT joinpay_collection_binding_trade_merchant_no_check CHECK (((length(trade_merchant_no) >= 1) AND (length(trade_merchant_no) <= 50))),
    CONSTRAINT joinpay_collection_binding_wire_merchant_no_check CHECK (((wire_merchant_no ~ '^[0-9]{1,15}$'::text) AND (wire_merchant_no <> '888100000002340'::text))),
    CONSTRAINT joinpay_formal_initial_shape CHECK ((((formal_admission_ref IS NULL) AND (formal_admission_sha256 IS NULL) AND (formal_admission_canonical IS NULL)) OR ((formal_admission_ref IS NOT NULL) AND (formal_admission_sha256 IS NOT NULL) AND (formal_admission_canonical IS NOT NULL) AND (formal_admission_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text) AND (octet_length(formal_admission_canonical) <= 262144) AND (formal_admission_sha256 = encode(sha256(convert_to(formal_admission_canonical, 'UTF8'::name)), 'hex'::text)))))
);


--
-- Name: joinpay_collection_evidence; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_collection_evidence (
    id text NOT NULL,
    request_id text NOT NULL,
    operation text NOT NULL,
    origin_observation_id text,
    raw_query bytea,
    raw_sha256 text NOT NULL,
    profile_id text NOT NULL,
    profile_sha256 text NOT NULL,
    profile_canonical text NOT NULL,
    key_version_ref text NOT NULL,
    initial_admission_ref text NOT NULL,
    initial_admission_sha256 text NOT NULL,
    admission_ref text NOT NULL,
    admission_sha256 text NOT NULL,
    admission_canonical text NOT NULL,
    event text NOT NULL,
    result text NOT NULL,
    schema_outcome text NOT NULL,
    signature_outcome text NOT NULL,
    binding_outcome text NOT NULL,
    channel_trx_no text,
    provider_paid_at_raw text,
    provider_paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_collection_evidence_admission_canonical_check CHECK ((octet_length(admission_canonical) <= 262144)),
    CONSTRAINT joinpay_collection_evidence_binding_outcome_check CHECK ((binding_outcome = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text]))),
    CONSTRAINT joinpay_collection_evidence_channel_trx_no_check CHECK ((channel_trx_no ~ '^[A-Za-z0-9_-]{1,64}$'::text)),
    CONSTRAINT joinpay_collection_evidence_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_collection_evidence_check1 CHECK ((admission_sha256 = encode(sha256(convert_to(admission_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_collection_evidence_check2 CHECK ((((operation = 'NOTIFY'::text) AND (raw_query IS NOT NULL) AND (origin_observation_id IS NULL) AND (raw_sha256 = encode(sha256(raw_query), 'hex'::text))) OR ((operation = 'QUERY'::text) AND (raw_query IS NULL) AND (origin_observation_id IS NOT NULL)))),
    CONSTRAINT joinpay_collection_evidence_check3 CHECK (((event <> 'E4'::text) OR ((schema_outcome = 'VALID'::text) AND (signature_outcome = 'MATCH'::text) AND (binding_outcome = 'MATCH'::text) AND (channel_trx_no IS NOT NULL) AND (provider_paid_at_raw IS NOT NULL) AND (provider_paid_at IS NOT NULL)))),
    CONSTRAINT joinpay_collection_evidence_event_check CHECK ((event = ANY (ARRAY['E4'::text, 'E5'::text, 'E6'::text, 'E6X'::text, 'E11'::text]))),
    CONSTRAINT joinpay_collection_evidence_id_check CHECK ((id ~ '^jpe_[0-9a-f]{32}$'::text)),
    CONSTRAINT joinpay_collection_evidence_operation_check CHECK ((operation = ANY (ARRAY['NOTIFY'::text, 'QUERY'::text]))),
    CONSTRAINT joinpay_collection_evidence_profile_canonical_check CHECK ((octet_length(profile_canonical) <= 131072)),
    CONSTRAINT joinpay_collection_evidence_provider_paid_at_raw_check CHECK ((length(provider_paid_at_raw) <= 64)),
    CONSTRAINT joinpay_collection_evidence_raw_query_check CHECK ((octet_length(raw_query) <= 65536)),
    CONSTRAINT joinpay_collection_evidence_raw_sha256_check CHECK ((raw_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT joinpay_collection_evidence_result_check CHECK ((result ~ '^[A-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT joinpay_collection_evidence_schema_outcome_check CHECK ((schema_outcome = ANY (ARRAY['VALID'::text, 'INVALID'::text]))),
    CONSTRAINT joinpay_collection_evidence_signature_outcome_check CHECK ((signature_outcome = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text])))
);


--
-- Name: joinpay_collection_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_collection_observation (
    id text NOT NULL,
    attempt_id text NOT NULL,
    request_id text NOT NULL,
    raw_body bytea,
    raw_sha256 text,
    http_status integer,
    response_complete boolean NOT NULL,
    received_bytes bigint NOT NULL,
    transport_failure text,
    event text NOT NULL,
    result text NOT NULL,
    schema_outcome text NOT NULL,
    signature_outcome text NOT NULL,
    binding_outcome text NOT NULL,
    verified boolean NOT NULL,
    state_before text NOT NULL,
    state_after text NOT NULL,
    channel_status text,
    provider_paid_at_raw text,
    channel_trx_no text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_collection_observation_binding_outcome_check CHECK ((binding_outcome = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text]))),
    CONSTRAINT joinpay_collection_observation_channel_status_check CHECK ((length(channel_status) <= 32)),
    CONSTRAINT joinpay_collection_observation_channel_trx_no_check CHECK (((length(channel_trx_no) >= 1) AND (length(channel_trx_no) <= 128))),
    CONSTRAINT joinpay_collection_observation_check CHECK ((((raw_body IS NOT NULL) AND (raw_sha256 IS NOT NULL) AND (raw_sha256 = encode(sha256(raw_body), 'hex'::text))) OR ((raw_body IS NULL) AND (raw_sha256 IS NULL) AND (NOT response_complete)))),
    CONSTRAINT joinpay_collection_observation_check1 CHECK ((received_bytes >= COALESCE(octet_length(raw_body), 0))),
    CONSTRAINT joinpay_collection_observation_check2 CHECK (((NOT response_complete) OR ((raw_body IS NOT NULL) AND (http_status IS NOT NULL) AND (received_bytes = octet_length(raw_body))))),
    CONSTRAINT joinpay_collection_observation_check3 CHECK (((transport_failure IS NOT NULL) OR (response_complete AND (http_status = 200)))),
    CONSTRAINT joinpay_collection_observation_check4 CHECK (((NOT verified) OR (response_complete AND (http_status = 200) AND (schema_outcome = 'VALID'::text) AND (signature_outcome = 'MATCH'::text) AND (binding_outcome = 'MATCH'::text)))),
    CONSTRAINT joinpay_collection_observation_check5 CHECK (((transport_failure IS NULL) OR (NOT verified))),
    CONSTRAINT joinpay_collection_observation_check6 CHECK (((event <> 'E4'::text) OR verified)),
    CONSTRAINT joinpay_collection_observation_check7 CHECK (((event <> 'E9'::text) OR ((NOT verified) AND (state_before = state_after)))),
    CONSTRAINT joinpay_collection_observation_event_check CHECK ((event = ANY (ARRAY['E1'::text, 'E1P'::text, 'E2'::text, 'E3'::text, 'E4'::text, 'E5'::text, 'E6'::text, 'E6X'::text, 'E9'::text, 'E11'::text]))),
    CONSTRAINT joinpay_collection_observation_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT joinpay_collection_observation_id_check CHECK ((id ~ '^jpobs_[0-9a-f]{32}$'::text)),
    CONSTRAINT joinpay_collection_observation_provider_paid_at_raw_check CHECK ((length(provider_paid_at_raw) <= 64)),
    CONSTRAINT joinpay_collection_observation_raw_body_check CHECK ((octet_length(raw_body) <= 65536)),
    CONSTRAINT joinpay_collection_observation_received_bytes_check CHECK ((received_bytes >= 0)),
    CONSTRAINT joinpay_collection_observation_result_check CHECK ((result ~ '^[A-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT joinpay_collection_observation_schema_outcome_check CHECK ((schema_outcome = ANY (ARRAY['VALID'::text, 'INVALID'::text, 'NOT_CHECKED'::text]))),
    CONSTRAINT joinpay_collection_observation_signature_outcome_check CHECK ((signature_outcome = ANY (ARRAY['MATCH'::text, 'MISMATCH'::text, 'NOT_CHECKED'::text]))),
    CONSTRAINT joinpay_collection_observation_state_after_check CHECK ((state_after = ANY (ARRAY['SUBMITTING'::text, 'UNKNOWN'::text, 'ACTION_READY'::text, 'PROCESSING_UNCONFIRMED'::text, 'REJECTED_BY_CHANNEL'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'ACCEPTED'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT joinpay_collection_observation_state_before_check CHECK ((state_before = ANY (ARRAY['SUBMITTING'::text, 'UNKNOWN'::text, 'ACTION_READY'::text, 'PROCESSING_UNCONFIRMED'::text, 'REJECTED_BY_CHANNEL'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'ACCEPTED'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT joinpay_collection_observation_transport_failure_check CHECK ((transport_failure = ANY (ARRAY['TIMEOUT'::text, 'ABORTED'::text, 'HTTP_STATUS'::text, 'BODY_TOO_LARGE'::text, 'NETWORK_ERROR'::text])))
);


--
-- Name: joinpay_payout_attempt; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_payout_attempt (
    id text NOT NULL,
    intent_id text NOT NULL,
    operation text NOT NULL,
    lease_version bigint NOT NULL,
    lease_owner text NOT NULL,
    profile_id text NOT NULL,
    profile_canonical text NOT NULL,
    profile_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    scope_canonical text NOT NULL,
    scope_sha256 text NOT NULL,
    request_body bytea NOT NULL,
    request_sha256 text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_payout_attempt_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_payout_attempt_check1 CHECK ((scope_sha256 = encode(sha256(convert_to(scope_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_payout_attempt_check2 CHECK ((request_sha256 = encode(sha256(request_body), 'hex'::text))),
    CONSTRAINT joinpay_payout_attempt_lease_owner_check CHECK (((length(lease_owner) >= 1) AND (length(lease_owner) <= 128))),
    CONSTRAINT joinpay_payout_attempt_lease_version_check CHECK ((lease_version > 0)),
    CONSTRAINT joinpay_payout_attempt_operation_check CHECK ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text]))),
    CONSTRAINT joinpay_payout_attempt_profile_canonical_check CHECK (((octet_length(profile_canonical) >= 2) AND (octet_length(profile_canonical) <= 131072))),
    CONSTRAINT joinpay_payout_attempt_profile_id_check CHECK (((length(profile_id) >= 1) AND (length(profile_id) <= 128))),
    CONSTRAINT joinpay_payout_attempt_request_body_check CHECK (((octet_length(request_body) >= 1) AND (octet_length(request_body) <= 65536))),
    CONSTRAINT joinpay_payout_attempt_scope_canonical_check CHECK (((octet_length(scope_canonical) >= 2) AND (octet_length(scope_canonical) <= 131072)))
);


--
-- Name: joinpay_payout_evidence; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_payout_evidence (
    id text NOT NULL,
    intent_id text NOT NULL,
    observation_id text NOT NULL,
    operation text NOT NULL,
    terminal text NOT NULL,
    platform_serial_no text NOT NULL,
    provider_fee_raw text NOT NULL,
    provider_fee_cents numeric NOT NULL,
    facts_canonical text NOT NULL,
    facts_digest text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_payout_evidence_check CHECK ((facts_digest = encode(sha256(convert_to(facts_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_payout_evidence_facts_canonical_check CHECK (((octet_length(facts_canonical) >= 2) AND (octet_length(facts_canonical) <= 16384))),
    CONSTRAINT joinpay_payout_evidence_operation_check CHECK ((operation = ANY (ARRAY['QUERY'::text, 'NOTIFY'::text]))),
    CONSTRAINT joinpay_payout_evidence_platform_serial_no_check CHECK (((length(platform_serial_no) >= 1) AND (length(platform_serial_no) <= 128))),
    CONSTRAINT joinpay_payout_evidence_provider_fee_cents_check CHECK (((provider_fee_cents = trunc(provider_fee_cents)) AND (provider_fee_cents >= (0)::numeric))),
    CONSTRAINT joinpay_payout_evidence_provider_fee_raw_check CHECK (((octet_length(provider_fee_raw) <= 128) AND (provider_fee_raw ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'::text))),
    CONSTRAINT joinpay_payout_evidence_terminal_check CHECK ((terminal = ANY (ARRAY['PAID'::text, 'UNPAID_CONFIRMED'::text])))
);


--
-- Name: joinpay_refund_attempt; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_refund_attempt (
    id text NOT NULL,
    intent_id text NOT NULL,
    operation text NOT NULL,
    lease_version bigint NOT NULL,
    lease_owner text NOT NULL,
    profile_id text NOT NULL,
    profile_canonical text NOT NULL,
    profile_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    admission_sha256 text NOT NULL,
    request_body bytea NOT NULL,
    request_sha256 text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_refund_attempt_admission_sha256_check CHECK ((admission_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT joinpay_refund_attempt_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_refund_attempt_check1 CHECK ((request_sha256 = encode(sha256(request_body), 'hex'::text))),
    CONSTRAINT joinpay_refund_attempt_key_version_ref_check CHECK (((length(key_version_ref) >= 1) AND (length(key_version_ref) <= 128))),
    CONSTRAINT joinpay_refund_attempt_lease_owner_check CHECK ((lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT joinpay_refund_attempt_lease_version_check CHECK ((lease_version > 0)),
    CONSTRAINT joinpay_refund_attempt_operation_check CHECK ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text]))),
    CONSTRAINT joinpay_refund_attempt_profile_canonical_check CHECK (((octet_length(profile_canonical) >= 2) AND (octet_length(profile_canonical) <= 131072))),
    CONSTRAINT joinpay_refund_attempt_profile_id_check CHECK (((length(profile_id) >= 1) AND (length(profile_id) <= 128))),
    CONSTRAINT joinpay_refund_attempt_request_body_check CHECK (((octet_length(request_body) >= 1) AND (octet_length(request_body) <= 16384)))
);


--
-- Name: joinpay_refund_evidence; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_refund_evidence (
    id text NOT NULL,
    intent_id text NOT NULL,
    observation_id text NOT NULL,
    operation text NOT NULL,
    terminal text NOT NULL,
    refund_transaction_no text,
    completed_at_raw text,
    completed_at timestamp with time zone,
    facts_canonical text NOT NULL,
    facts_digest text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_refund_evidence_check CHECK ((facts_digest = encode(sha256(convert_to(facts_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_refund_evidence_check1 CHECK (((terminal <> 'SUCCEEDED'::text) OR ((refund_transaction_no IS NOT NULL) AND (completed_at_raw IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT joinpay_refund_evidence_facts_canonical_check CHECK (((octet_length(facts_canonical) >= 2) AND (octet_length(facts_canonical) <= 16384))),
    CONSTRAINT joinpay_refund_evidence_operation_check CHECK ((operation = ANY (ARRAY['QUERY'::text, 'NOTIFY'::text]))),
    CONSTRAINT joinpay_refund_evidence_refund_transaction_no_check CHECK (((length(refund_transaction_no) >= 1) AND (length(refund_transaction_no) <= 128))),
    CONSTRAINT joinpay_refund_evidence_terminal_check CHECK ((terminal = ANY (ARRAY['SUCCEEDED'::text, 'FAILED_NO_EXECUTION'::text])))
);


--
-- Name: joinpay_refund_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.joinpay_refund_observation (
    id text NOT NULL,
    intent_id text NOT NULL,
    attempt_id text,
    operation text NOT NULL,
    lease_version bigint,
    lease_owner text,
    profile_id text NOT NULL,
    profile_canonical text NOT NULL,
    profile_sha256 text NOT NULL,
    key_version_ref text NOT NULL,
    raw_body bytea,
    raw_sha256 text,
    response_complete boolean NOT NULL,
    http_status integer,
    received_bytes integer NOT NULL,
    transport_failure text,
    event text NOT NULL,
    schema_status text NOT NULL,
    signature_status text NOT NULL,
    binding_status text NOT NULL,
    evidence_level text NOT NULL,
    state_before text NOT NULL,
    state_after text NOT NULL,
    request_id text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT joinpay_refund_observation_check CHECK ((profile_sha256 = encode(sha256(convert_to(profile_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT joinpay_refund_observation_check1 CHECK ((((raw_body IS NOT NULL) AND (raw_sha256 IS NOT NULL) AND (raw_sha256 = encode(sha256(raw_body), 'hex'::text))) OR ((raw_body IS NULL) AND (raw_sha256 IS NULL) AND (NOT response_complete)))),
    CONSTRAINT joinpay_refund_observation_check2 CHECK ((received_bytes >= COALESCE(octet_length(raw_body), 0))),
    CONSTRAINT joinpay_refund_observation_check3 CHECK (((NOT response_complete) OR ((raw_body IS NOT NULL) AND (received_bytes = octet_length(raw_body)) AND (((operation = 'NOTIFY'::text) AND (http_status IS NULL)) OR ((operation <> 'NOTIFY'::text) AND (http_status IS NOT NULL)))))),
    CONSTRAINT joinpay_refund_observation_check4 CHECK ((((operation = 'NOTIFY'::text) AND (attempt_id IS NULL) AND (lease_version IS NULL) AND (lease_owner IS NULL)) OR ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text])) AND (attempt_id IS NOT NULL) AND (lease_version IS NOT NULL) AND (lease_version > 0) AND (lease_owner IS NOT NULL)))),
    CONSTRAINT joinpay_refund_observation_check5 CHECK (((state_before = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text, 'PROCESSING'::text, 'REVIEW_REQUIRED'::text, 'SUCCEEDED'::text, 'FAILED'::text])) AND (state_after = ANY (ARRAY['READY'::text, 'SUBMITTING'::text, 'UNKNOWN'::text, 'PROCESSING'::text, 'REVIEW_REQUIRED'::text, 'SUCCEEDED'::text, 'FAILED'::text])))),
    CONSTRAINT joinpay_refund_observation_check6 CHECK (((event <> 'STALE'::text) OR (state_before = state_after))),
    CONSTRAINT joinpay_refund_observation_event_check CHECK ((event = ANY (ARRAY['UNKNOWN'::text, 'PROCESSING'::text, 'PENDING_TERMINAL'::text, 'REVIEW'::text, 'STALE'::text, 'TERMINAL'::text]))),
    CONSTRAINT joinpay_refund_observation_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['PROVIDER_RESPONSE'::text, 'SYNTHETIC_PROTOCOL'::text]))),
    CONSTRAINT joinpay_refund_observation_http_status_check CHECK (((http_status >= 100) AND (http_status <= 599))),
    CONSTRAINT joinpay_refund_observation_key_version_ref_check CHECK (((length(key_version_ref) >= 1) AND (length(key_version_ref) <= 128))),
    CONSTRAINT joinpay_refund_observation_operation_check CHECK ((operation = ANY (ARRAY['SUBMIT'::text, 'QUERY'::text, 'NOTIFY'::text]))),
    CONSTRAINT joinpay_refund_observation_profile_canonical_check CHECK (((octet_length(profile_canonical) >= 2) AND (octet_length(profile_canonical) <= 131072))),
    CONSTRAINT joinpay_refund_observation_profile_id_check CHECK (((length(profile_id) >= 1) AND (length(profile_id) <= 128))),
    CONSTRAINT joinpay_refund_observation_raw_body_check CHECK ((octet_length(raw_body) <= 65536)),
    CONSTRAINT joinpay_refund_observation_received_bytes_check CHECK ((received_bytes >= 0)),
    CONSTRAINT joinpay_refund_observation_request_id_check CHECK ((request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'::text))
);


--
-- Name: legacy_continuation_evidence; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_continuation_evidence (
    id text NOT NULL,
    order_id text NOT NULL,
    evidence_version bigint NOT NULL,
    source_kind text NOT NULL,
    derived_from_command_version_id text,
    source_as_of timestamp with time zone NOT NULL,
    captured_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    evidence_ref text NOT NULL,
    source_digest text NOT NULL,
    parameter_digest text NOT NULL,
    admission text NOT NULL,
    reasons jsonb NOT NULL,
    facts jsonb NOT NULL,
    facts_canonical text NOT NULL,
    facts_digest text NOT NULL,
    CONSTRAINT legacy_continuation_evidence_admission_check CHECK ((admission = ANY (ARRAY['PARAMETER_COMPLETE'::text, 'ISOLATED'::text]))),
    CONSTRAINT legacy_continuation_evidence_check CHECK ((facts_digest = encode(sha256(convert_to(facts_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT legacy_continuation_evidence_check1 CHECK (((facts_canonical)::jsonb = facts)),
    CONSTRAINT legacy_continuation_evidence_check2 CHECK ((((source_kind = 'SOURCE_IMPORT'::text) AND (derived_from_command_version_id IS NULL) AND (evidence_version = 1)) OR ((source_kind = 'DERIVED'::text) AND (derived_from_command_version_id IS NOT NULL) AND (evidence_version > 1)))),
    CONSTRAINT legacy_continuation_evidence_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 512))),
    CONSTRAINT legacy_continuation_evidence_evidence_version_check CHECK ((evidence_version > 0)),
    CONSTRAINT legacy_continuation_evidence_facts_canonical_check CHECK ((octet_length(facts_canonical) <= 262144)),
    CONSTRAINT legacy_continuation_evidence_facts_check CHECK ((jsonb_typeof(facts) = 'object'::text)),
    CONSTRAINT legacy_continuation_evidence_parameter_digest_check CHECK ((parameter_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_continuation_evidence_reasons_check CHECK ((jsonb_typeof(reasons) = 'array'::text)),
    CONSTRAINT legacy_continuation_evidence_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_continuation_evidence_source_kind_check CHECK ((source_kind = ANY (ARRAY['SOURCE_IMPORT'::text, 'DERIVED'::text])))
);


--
-- Name: legacy_continuation_version; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_continuation_version (
    id text NOT NULL,
    order_id text NOT NULL,
    revision bigint NOT NULL,
    command text NOT NULL,
    actor jsonb NOT NULL,
    input_evidence_id text NOT NULL,
    result_evidence_id text NOT NULL,
    stage integer NOT NULL,
    is_settle integer NOT NULL,
    is_advance_set integer NOT NULL,
    amounts jsonb NOT NULL,
    commission_revisions jsonb NOT NULL,
    assignments jsonb,
    plan_fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT legacy_continuation_version_actor_check CHECK ((jsonb_typeof(actor) = 'object'::text)),
    CONSTRAINT legacy_continuation_version_amounts_check CHECK ((jsonb_typeof(amounts) = 'object'::text)),
    CONSTRAINT legacy_continuation_version_check CHECK ((input_evidence_id <> result_evidence_id)),
    CONSTRAINT legacy_continuation_version_command_check CHECK ((command = ANY (ARRAY['PROPOSE'::text, 'CONFIRM'::text, 'REJECT'::text, 'HOLD'::text, 'RELEASE'::text, 'CONFISCATE'::text]))),
    CONSTRAINT legacy_continuation_version_commission_revisions_check CHECK ((jsonb_typeof(commission_revisions) = 'array'::text)),
    CONSTRAINT legacy_continuation_version_is_advance_set_check CHECK ((is_advance_set = ANY (ARRAY[0, 1]))),
    CONSTRAINT legacy_continuation_version_is_settle_check CHECK ((is_settle = ANY (ARRAY[0, 2, 3]))),
    CONSTRAINT legacy_continuation_version_plan_fingerprint_check CHECK ((plan_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_continuation_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT legacy_continuation_version_stage_check CHECK ((stage = ANY (ARRAY[3, 8, 9, 4])))
);


--
-- Name: legacy_duty_finance_contract; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_duty_finance_contract (
    singleton boolean NOT NULL,
    contract_version text NOT NULL,
    enabled boolean NOT NULL,
    approval_ref text NOT NULL,
    approval_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_duty_finance_contract_approval_digest_check CHECK ((approval_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_contract_approval_ref_check CHECK (((length(approval_ref) >= 1) AND (length(approval_ref) <= 128))),
    CONSTRAINT legacy_duty_finance_contract_contract_version_check CHECK ((contract_version = 'legacy-duty-finance.v1'::text)),
    CONSTRAINT legacy_duty_finance_contract_enabled_check CHECK (enabled),
    CONSTRAINT legacy_duty_finance_contract_singleton_check CHECK (singleton)
);


--
-- Name: legacy_duty_finance_fact; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_duty_finance_fact (
    duty_id text NOT NULL,
    order_id text NOT NULL,
    root_id text NOT NULL,
    event_id text NOT NULL,
    subject_user_id text NOT NULL,
    kind text NOT NULL,
    amount_cents numeric(24,0) NOT NULL,
    currency text NOT NULL,
    duty_revision bigint NOT NULL,
    effective_head_id text,
    effective_head_revision bigint,
    parent_source_digest text NOT NULL,
    source_record_digest text NOT NULL,
    basis_facts_digest text NOT NULL,
    effective_facts_digest text NOT NULL,
    zero_finalization boolean NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    facts_canonical text NOT NULL,
    facts_digest text NOT NULL,
    funding_canonical text NOT NULL,
    funding_digest text NOT NULL,
    approval_ref text NOT NULL,
    attempt text NOT NULL,
    actor_id text NOT NULL,
    session_id text NOT NULL,
    request_id text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_duty_finance_fact_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT legacy_duty_finance_fact_basis_facts_digest_check CHECK ((basis_facts_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_fact_check CHECK ((zero_finalization = (amount_cents = (0)::numeric))),
    CONSTRAINT legacy_duty_finance_fact_check1 CHECK ((((amount_cents = (0)::numeric) AND (ref_type = 'FINANCE_EVENT'::text) AND (ref_id = event_id)) OR ((amount_cents > (0)::numeric) AND (ref_type = 'LEDGER_ENTRY'::text)))),
    CONSTRAINT legacy_duty_finance_fact_check2 CHECK (((effective_head_id IS NULL) = (effective_head_revision IS NULL))),
    CONSTRAINT legacy_duty_finance_fact_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT legacy_duty_finance_fact_duty_revision_check CHECK ((duty_revision > 0)),
    CONSTRAINT legacy_duty_finance_fact_effective_facts_digest_check CHECK ((effective_facts_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_fact_facts_digest_check CHECK ((facts_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_fact_funding_digest_check CHECK ((funding_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_fact_kind_check CHECK ((kind = ANY (ARRAY['RENTER_REFUND'::text, 'OWNER_CREDIT'::text, 'COMMISSION'::text, 'DEPOSIT_COMPENSATION'::text]))),
    CONSTRAINT legacy_duty_finance_fact_parent_source_digest_check CHECK ((parent_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_duty_finance_fact_ref_type_check CHECK ((ref_type = ANY (ARRAY['LEDGER_ENTRY'::text, 'FINANCE_EVENT'::text]))),
    CONSTRAINT legacy_duty_finance_fact_source_record_digest_check CHECK ((source_record_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: legacy_inflight_register; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_inflight_register (
    id text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    legacy_id text NOT NULL,
    account_id text NOT NULL,
    owner_user_id text NOT NULL,
    renter_user_id text,
    source_order_status integer NOT NULL,
    source_pay_status integer NOT NULL,
    source_digest text NOT NULL,
    evidence_ref text NOT NULL,
    disposition text NOT NULL,
    reason text NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_inflight_register_disposition_check CHECK ((disposition = ANY (ARRAY['ISOLATED_PARTY'::text, 'REVIEW_REQUIRED'::text, 'UNKNOWN'::text]))),
    CONSTRAINT legacy_inflight_register_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_inflight_register_source_entity_check CHECK ((source_entity = 'la_order'::text)),
    CONSTRAINT legacy_inflight_register_source_system_check CHECK ((source_system = 'legacy_mysql_restore'::text))
);


--
-- Name: legacy_order_duty_admission; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_order_duty_admission (
    id text NOT NULL,
    duty_id text NOT NULL,
    order_id text NOT NULL,
    kind text NOT NULL,
    source_record_id text NOT NULL,
    counterparty_user_id text NOT NULL,
    amount_cents numeric(24,0) NOT NULL,
    currency text NOT NULL,
    level integer NOT NULL,
    ratio numeric(24,8) NOT NULL,
    parent_source_digest text NOT NULL,
    source_canonical text NOT NULL,
    source_record_digest text NOT NULL,
    final_amount_evidence_canonical text NOT NULL,
    final_amount_evidence_digest text NOT NULL,
    time_kind text NOT NULL,
    source_time timestamp with time zone NOT NULL,
    source_time_value text NOT NULL,
    source_time_unit text NOT NULL,
    time_evidence_canonical text NOT NULL,
    time_evidence_digest text NOT NULL,
    cutoff timestamp with time zone NOT NULL,
    maturity_at timestamp with time zone NOT NULL,
    evidence_ref text NOT NULL,
    admission_canonical text NOT NULL,
    admission_digest text NOT NULL,
    reviewed_by jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_order_duty_admission_admission_canonical_check CHECK ((octet_length(admission_canonical) <= 131072)),
    CONSTRAINT legacy_order_duty_admission_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT legacy_order_duty_admission_check CHECK ((source_record_digest = encode(sha256(convert_to(source_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT legacy_order_duty_admission_check1 CHECK ((final_amount_evidence_digest = encode(sha256(convert_to(final_amount_evidence_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT legacy_order_duty_admission_check2 CHECK ((time_evidence_digest = encode(sha256(convert_to(time_evidence_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT legacy_order_duty_admission_check3 CHECK ((admission_digest = encode(sha256(convert_to(admission_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT legacy_order_duty_admission_check4 CHECK ((maturity_at =
CASE
    WHEN (time_kind = 'COMPLETED_AT'::text) THEN (source_time + '7 days'::interval)
    ELSE source_time
END)),
    CONSTRAINT legacy_order_duty_admission_check5 CHECK ((
CASE
    WHEN (source_time_unit = 'UNIX_SECONDS'::text) THEN ((source_time_value ~ '^(0|[1-9][0-9]{0,11})$'::text) AND ((source_time_value)::numeric = EXTRACT(epoch FROM source_time)))
    ELSE ((source_time_value)::timestamp with time zone = source_time)
END IS TRUE)),
    CONSTRAINT legacy_order_duty_admission_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT legacy_order_duty_admission_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 512))),
    CONSTRAINT legacy_order_duty_admission_kind_check CHECK ((kind = 'COMMISSION'::text)),
    CONSTRAINT legacy_order_duty_admission_level_check CHECK ((level = ANY (ARRAY[2, 3]))),
    CONSTRAINT legacy_order_duty_admission_parent_source_digest_check CHECK ((parent_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_duty_admission_ratio_check CHECK ((ratio >= (0)::numeric)),
    CONSTRAINT legacy_order_duty_admission_source_canonical_check CHECK ((octet_length(source_canonical) <= 32768)),
    CONSTRAINT legacy_order_duty_admission_source_time_unit_check CHECK ((source_time_unit = ANY (ARRAY['UNIX_SECONDS'::text, 'RFC3339_UTC'::text]))),
    CONSTRAINT legacy_order_duty_admission_time_kind_check CHECK ((time_kind = ANY (ARRAY['COMPLETED_AT'::text, 'MATURES_AT'::text])))
);


--
-- Name: legacy_order_duty_revision; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_order_duty_revision (
    id text NOT NULL,
    duty_id text NOT NULL,
    revision bigint NOT NULL,
    before_values jsonb NOT NULL,
    after_values jsonb NOT NULL,
    actor jsonb NOT NULL,
    source_command_version_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT legacy_order_duty_revision_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 500))),
    CONSTRAINT legacy_order_duty_revision_revision_check CHECK ((revision > 1))
);


--
-- Name: legacy_order_read_snapshot; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_order_read_snapshot (
    id text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    legacy_id text NOT NULL,
    source_digest text NOT NULL,
    evidence_ref text NOT NULL,
    original_order_no text NOT NULL,
    account_id text NOT NULL,
    game_id text NOT NULL,
    owner_user_id text NOT NULL,
    renter_user_id text NOT NULL,
    legacy_account_id text NOT NULL,
    legacy_account_entity text NOT NULL,
    legacy_account_source_digest text NOT NULL,
    legacy_account_no text,
    legacy_owner_id text NOT NULL,
    legacy_owner_no text,
    owner_source_digest text NOT NULL,
    legacy_renter_id text NOT NULL,
    legacy_renter_no text,
    renter_source_digest text NOT NULL,
    source_order_status integer NOT NULL,
    source_pay_status integer NOT NULL,
    source_created_at timestamp with time zone,
    source_paid_at timestamp with time zone,
    source_cancelled_at timestamp with time zone,
    source_completed_at timestamp with time zone,
    due_amount_cents numeric,
    recorded_paid_amount_cents numeric,
    deposit_amount_cents numeric,
    source_snapshot jsonb NOT NULL,
    snapshot_schema_version integer NOT NULL,
    binding_digest text NOT NULL,
    created_by_admin_id text NOT NULL,
    imported_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_order_read_snapshot_binding_digest_check CHECK ((binding_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_read_snapshot_deposit_amount_cents_check CHECK (((deposit_amount_cents = trunc(deposit_amount_cents)) AND (abs(deposit_amount_cents) < '10000000000000000000000000'::numeric))),
    CONSTRAINT legacy_order_read_snapshot_due_amount_cents_check CHECK (((due_amount_cents = trunc(due_amount_cents)) AND (abs(due_amount_cents) < '10000000000000000000000000'::numeric))),
    CONSTRAINT legacy_order_read_snapshot_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 512))),
    CONSTRAINT legacy_order_read_snapshot_legacy_account_entity_check CHECK ((legacy_account_entity = 'la_rental_accounts'::text)),
    CONSTRAINT legacy_order_read_snapshot_legacy_account_source_digest_check CHECK ((legacy_account_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_read_snapshot_legacy_id_check CHECK (((length(legacy_id) >= 1) AND (length(legacy_id) <= 128))),
    CONSTRAINT legacy_order_read_snapshot_original_order_no_check CHECK (((length(original_order_no) >= 1) AND (length(original_order_no) <= 255))),
    CONSTRAINT legacy_order_read_snapshot_owner_source_digest_check CHECK ((owner_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_read_snapshot_recorded_paid_amount_cents_check CHECK (((recorded_paid_amount_cents = trunc(recorded_paid_amount_cents)) AND (abs(recorded_paid_amount_cents) < '10000000000000000000000000'::numeric))),
    CONSTRAINT legacy_order_read_snapshot_renter_source_digest_check CHECK ((renter_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_read_snapshot_snapshot_schema_version_check CHECK ((snapshot_schema_version = 1)),
    CONSTRAINT legacy_order_read_snapshot_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_order_read_snapshot_source_entity_check CHECK ((source_entity = 'la_order'::text)),
    CONSTRAINT legacy_order_read_snapshot_source_snapshot_check CHECK ((jsonb_typeof(source_snapshot) = 'object'::text)),
    CONSTRAINT legacy_order_read_snapshot_source_system_check CHECK ((source_system = 'legacy_mysql_restore'::text))
);


--
-- Name: legacy_owner_guarantee_coverage; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_owner_guarantee_coverage (
    id text NOT NULL,
    user_id text NOT NULL,
    legacy_user_id text NOT NULL,
    source_cutoff timestamp with time zone NOT NULL,
    input_sha256 text NOT NULL,
    identity_digest text NOT NULL,
    source_count integer NOT NULL,
    imported_count integer NOT NULL,
    isolated_count integer NOT NULL,
    source_set_digest text NOT NULL,
    imported_set_digest text NOT NULL,
    isolated_set_digest text NOT NULL,
    body_digest text NOT NULL,
    input_canonical text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT legacy_owner_guarantee_coverage_body_digest_check CHECK ((body_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_coverage_check CHECK ((source_count = (imported_count + isolated_count))),
    CONSTRAINT legacy_owner_guarantee_coverage_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_coverage_imported_count_check CHECK ((imported_count >= 0)),
    CONSTRAINT legacy_owner_guarantee_coverage_imported_set_digest_check CHECK ((imported_set_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_coverage_input_sha256_check CHECK ((input_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_coverage_isolated_count_check CHECK ((isolated_count >= 0)),
    CONSTRAINT legacy_owner_guarantee_coverage_isolated_set_digest_check CHECK ((isolated_set_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_coverage_source_count_check CHECK (((source_count >= 0) AND (source_count <= 50000))),
    CONSTRAINT legacy_owner_guarantee_coverage_source_set_digest_check CHECK ((source_set_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: legacy_owner_guarantee_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.legacy_owner_guarantee_observation (
    id text NOT NULL,
    user_id text NOT NULL,
    legacy_user_id text NOT NULL,
    account_id text,
    legacy_account_id text NOT NULL,
    source_cutoff timestamp with time zone NOT NULL,
    input_sha256 text NOT NULL,
    identity_digest text NOT NULL,
    source_canonical text NOT NULL,
    source_digest text NOT NULL,
    imported_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT legacy_owner_guarantee_observation_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_observation_input_sha256_check CHECK ((input_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_owner_guarantee_observation_legacy_account_id_check CHECK ((legacy_account_id ~ '^[1-9][0-9]{0,23}$'::text)),
    CONSTRAINT legacy_owner_guarantee_observation_legacy_user_id_check CHECK ((legacy_user_id ~ '^[1-9][0-9]{0,23}$'::text)),
    CONSTRAINT legacy_owner_guarantee_observation_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: native_origin_resource_admission; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.native_origin_resource_admission (
    resource_oid oid NOT NULL,
    database_name text NOT NULL,
    runtime_role text NOT NULL,
    resource_marker text NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT native_origin_resource_admission_database_name_check CHECK ((database_name ~ '^zzsh_test_order_[a-z][a-z0-9_]{0,20}$'::text)),
    CONSTRAINT native_origin_resource_admission_resource_marker_check CHECK ((resource_marker = 'zzsh:order-reservation-test:v1'::text)),
    CONSTRAINT native_origin_resource_admission_runtime_role_check CHECK ((runtime_role ~ '^zzsh_order_[a-z][a-z0-9_]{0,20}_r$'::text))
);


--
-- Name: native_user_insert_proof; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.native_user_insert_proof (
    user_id text NOT NULL,
    insert_xid xid8,
    captured_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: owner_guarantee_payment; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.owner_guarantee_payment (
    id text NOT NULL,
    requirement_id text NOT NULL,
    owner_user_id text NOT NULL,
    request_key text NOT NULL,
    request_fingerprint text NOT NULL,
    merchant_order_no text NOT NULL,
    provider text NOT NULL,
    provider_request_state text NOT NULL,
    provider_transaction_id text,
    amount_cents numeric(24,0) NOT NULL,
    observed_amount_cents numeric(24,0),
    status text NOT NULL,
    original_receipt jsonb,
    source_digest text,
    finance_event_id text,
    ledger_entry_ref text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT owner_guarantee_payment_amount_cents_check CHECK (((amount_cents > (0)::numeric) AND (amount_cents <= (10000)::numeric))),
    CONSTRAINT owner_guarantee_payment_check CHECK (((observed_amount_cents IS NULL) OR ((observed_amount_cents > (0)::numeric) AND (observed_amount_cents <= amount_cents)))),
    CONSTRAINT owner_guarantee_payment_provider_check CHECK ((provider = 'HUIJU'::text)),
    CONSTRAINT owner_guarantee_payment_provider_request_state_check CHECK ((provider_request_state = ANY (ARRAY['NOT_AUTHORIZED'::text, 'SUBMITTED'::text, 'UNKNOWN'::text, 'CONFIRMED'::text, 'FAILED'::text]))),
    CONSTRAINT owner_guarantee_payment_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT owner_guarantee_payment_source_digest_check CHECK (((source_digest IS NULL) OR (source_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT owner_guarantee_payment_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'ACCEPTED'::text, 'PROCESSING'::text, 'CONFIRMED'::text, 'FAILED'::text, 'UNKNOWN'::text])))
);


--
-- Name: owner_guarantee_reconciliation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.owner_guarantee_reconciliation (
    id text NOT NULL,
    payment_id text,
    refund_id text,
    observed_state text NOT NULL,
    observed_amount_cents numeric(24,0),
    provider_reference text,
    canonical_payload jsonb NOT NULL,
    payload_digest text NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT owner_guarantee_reconciliation_check CHECK (((payment_id IS NOT NULL) <> (refund_id IS NOT NULL))),
    CONSTRAINT owner_guarantee_reconciliation_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: owner_guarantee_refund; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.owner_guarantee_refund (
    id text NOT NULL,
    requirement_id text NOT NULL,
    payment_id text NOT NULL,
    owner_user_id text NOT NULL,
    request_key text NOT NULL,
    request_fingerprint text NOT NULL,
    provider text NOT NULL,
    provider_request_state text NOT NULL,
    provider_refund_id text,
    amount_cents numeric(24,0) NOT NULL,
    status text NOT NULL,
    release_policy_state text NOT NULL,
    release_decision_reason text,
    release_decision_fingerprint text,
    release_decided_by text,
    release_decided_at timestamp with time zone,
    original_receipt jsonb,
    source_digest text,
    finance_event_id text,
    ledger_entry_ref text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT owner_guarantee_refund_amount_cents_check CHECK (((amount_cents > (0)::numeric) AND (amount_cents <= (10000)::numeric))),
    CONSTRAINT owner_guarantee_refund_provider_check CHECK ((provider = 'HUIJU'::text)),
    CONSTRAINT owner_guarantee_refund_provider_request_state_check CHECK ((provider_request_state = ANY (ARRAY['NOT_AUTHORIZED'::text, 'SUBMITTED'::text, 'UNKNOWN'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT owner_guarantee_refund_release_decision_fingerprint_check CHECK (((release_decision_fingerprint IS NULL) OR (release_decision_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT owner_guarantee_refund_release_decision_shape CHECK ((((release_policy_state = 'OWNER_DECISION_REQUIRED'::text) AND (release_decision_fingerprint IS NULL) AND (release_decided_by IS NULL) AND (release_decided_at IS NULL)) OR ((release_policy_state = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text])) AND (release_decision_fingerprint IS NOT NULL) AND (release_decided_by IS NOT NULL) AND (release_decided_at IS NOT NULL)))),
    CONSTRAINT owner_guarantee_refund_release_policy_state_check CHECK ((release_policy_state = ANY (ARRAY['OWNER_DECISION_REQUIRED'::text, 'APPROVED'::text, 'REJECTED'::text]))),
    CONSTRAINT owner_guarantee_refund_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT owner_guarantee_refund_source_digest_check CHECK (((source_digest IS NULL) OR (source_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT owner_guarantee_refund_status_check CHECK ((status = ANY (ARRAY['REQUESTED'::text, 'PROCESSING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'UNKNOWN'::text])))
);


--
-- Name: owner_guarantee_requirement; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.owner_guarantee_requirement (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    account_id text NOT NULL,
    game_id text NOT NULL,
    listing_version_id text,
    price_version_id text NOT NULL,
    rule_release_id text NOT NULL,
    policy_version text NOT NULL,
    base_cents numeric(24,0) NOT NULL,
    required_cents numeric(24,0) NOT NULL,
    score_snapshot smallint NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT owner_guarantee_requirement_base_cents_check CHECK ((base_cents >= (0)::numeric)),
    CONSTRAINT owner_guarantee_requirement_required_cents_check CHECK (((required_cents >= (0)::numeric) AND (required_cents <= (10000)::numeric))),
    CONSTRAINT owner_guarantee_requirement_score_snapshot_check CHECK (((score_snapshot >= 0) AND (score_snapshot <= 100))),
    CONSTRAINT owner_guarantee_requirement_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'COVERED'::text, 'REFUND_REQUESTED'::text, 'REFUND_PROCESSING'::text, 'REFUNDED'::text, 'RESTRICTED'::text])))
);


--
-- Name: payment_channel_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.payment_channel_observation (
    id text NOT NULL,
    request_id text,
    channel text NOT NULL,
    merchant_identity_id text,
    channel_order_no text,
    channel_trx_no text,
    config_profile_id text,
    protocol_version text,
    key_version_ref text,
    operation text NOT NULL,
    source text NOT NULL,
    evidence_level text NOT NULL,
    event text NOT NULL,
    result text NOT NULL,
    reason text,
    channel_status text,
    provider_paid_at_raw text,
    raw_sha256 text NOT NULL,
    raw_ref text NOT NULL,
    verify_outcome text,
    lease_version bigint,
    state_before text,
    state_after text,
    stale boolean DEFAULT false NOT NULL,
    late boolean DEFAULT false NOT NULL,
    conflict boolean DEFAULT false NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT payment_channel_observation_channel_check CHECK ((channel = ANY (ARRAY['JOINPAY'::text, 'CONTROLLED'::text]))),
    CONSTRAINT payment_channel_observation_channel_order_no_check CHECK (((length(channel_order_no) >= 1) AND (length(channel_order_no) <= 128))),
    CONSTRAINT payment_channel_observation_channel_status_check CHECK ((length(channel_status) <= 32)),
    CONSTRAINT payment_channel_observation_channel_trx_no_check CHECK (((length(channel_trx_no) >= 1) AND (length(channel_trx_no) <= 128))),
    CONSTRAINT payment_channel_observation_check CHECK (((NOT stale) OR (event = 'E9'::text))),
    CONSTRAINT payment_channel_observation_check1 CHECK (((request_id IS NOT NULL) OR ((state_before IS NULL) AND (state_after IS NULL)))),
    CONSTRAINT payment_channel_observation_event_check CHECK ((event = ANY (ARRAY['E1'::text, 'E1P'::text, 'E2'::text, 'E3'::text, 'E4'::text, 'E5'::text, 'E6'::text, 'E6X'::text, 'E7'::text, 'E8'::text, 'E9'::text, 'E11'::text]))),
    CONSTRAINT payment_channel_observation_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['SYNTHETIC_PROTOCOL'::text, 'UNVERIFIED'::text, 'CONTROLLED_TEST'::text]))),
    CONSTRAINT payment_channel_observation_id_check CHECK ((id ~ '^payobs_[0-9a-f]{32}$'::text)),
    CONSTRAINT payment_channel_observation_merchant_identity_id_check CHECK ((merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_channel_observation_operation_check CHECK ((operation = ANY (ARRAY['SYNC_RESPONSE'::text, 'ASYNC_NOTIFY'::text, 'QUERY_RESPONSE'::text, 'ACCEPTANCE'::text]))),
    CONSTRAINT payment_channel_observation_provider_paid_at_raw_check CHECK ((length(provider_paid_at_raw) <= 64)),
    CONSTRAINT payment_channel_observation_raw_ref_check CHECK (((length(raw_ref) >= 1) AND (length(raw_ref) <= 256))),
    CONSTRAINT payment_channel_observation_raw_sha256_check CHECK ((raw_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payment_channel_observation_reason_check CHECK ((reason ~ '^[A-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT payment_channel_observation_result_check CHECK ((result ~ '^[A-Z0-9_-]{1,64}$'::text)),
    CONSTRAINT payment_channel_observation_source_check CHECK ((source = ANY (ARRAY['EXECUTOR'::text, 'PROVIDER_INBOUND'::text, 'ACCEPTANCE_GATE'::text]))),
    CONSTRAINT payment_channel_observation_verify_outcome_check CHECK ((length(verify_outcome) <= 64))
);


--
-- Name: payment_channel_transaction; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.payment_channel_transaction (
    id text NOT NULL,
    channel text NOT NULL,
    merchant_identity_id text NOT NULL,
    channel_trx_no text NOT NULL,
    order_origin text NOT NULL,
    native_order_id text NOT NULL,
    request_id text,
    confirmation_id text,
    evidence_level text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT payment_channel_transaction_channel_check CHECK ((channel = ANY (ARRAY['JOINPAY'::text, 'CONTROLLED'::text]))),
    CONSTRAINT payment_channel_transaction_channel_trx_no_check CHECK (((length(channel_trx_no) >= 1) AND (length(channel_trx_no) <= 128))),
    CONSTRAINT payment_channel_transaction_check CHECK (((channel = 'CONTROLLED'::text) OR (confirmation_id IS NULL))),
    CONSTRAINT payment_channel_transaction_check1 CHECK (((channel = 'CONTROLLED'::text) = (evidence_level = 'CONTROLLED_TEST'::text))),
    CONSTRAINT payment_channel_transaction_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['SYNTHETIC_PROTOCOL'::text, 'CONTROLLED_TEST'::text, 'JOINPAY_VERIFIED'::text]))),
    CONSTRAINT payment_channel_transaction_id_check CHECK ((id ~ '^paytrx_[0-9a-f]{32}$'::text)),
    CONSTRAINT payment_channel_transaction_merchant_identity_id_check CHECK ((merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_channel_transaction_order_origin_check CHECK ((order_origin = 'NATIVE'::text))
);


--
-- Name: payment_confirmation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.payment_confirmation (
    id text NOT NULL,
    source text NOT NULL,
    merchant_scope_id text NOT NULL,
    provider_transaction_id text NOT NULL,
    merchant_order_no text NOT NULL,
    order_id text NOT NULL,
    amount_cents numeric(25,0) NOT NULL,
    currency text NOT NULL,
    provider_paid_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    disposition text NOT NULL,
    reason_code text,
    request_id text NOT NULL,
    joinpay_request_id text,
    joinpay_evidence_id text,
    joinpay_anchor_id text,
    CONSTRAINT payment_confirmation_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT payment_confirmation_check CHECK ((((disposition = 'APPLIED'::text) AND (reason_code IS NULL)) OR ((disposition = 'REVIEW_REQUIRED'::text) AND (reason_code IS NOT NULL)))),
    CONSTRAINT payment_confirmation_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT payment_confirmation_disposition_check CHECK ((disposition = ANY (ARRAY['APPLIED'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT payment_confirmation_merchant_order_no_check CHECK (((length(merchant_order_no) >= 1) AND (length(merchant_order_no) <= 128))),
    CONSTRAINT payment_confirmation_merchant_scope_id_check CHECK (((length(merchant_scope_id) >= 1) AND (length(merchant_scope_id) <= 128))),
    CONSTRAINT payment_confirmation_provider_transaction_id_check CHECK (((length(provider_transaction_id) >= 1) AND (length(provider_transaction_id) <= 128))),
    CONSTRAINT payment_confirmation_reason_code_check CHECK ((reason_code = ANY (ARRAY['BINDING_MISMATCH'::text, 'LATE_PAYMENT'::text, 'DUPLICATE_PAYMENT'::text]))),
    CONSTRAINT payment_confirmation_source_check CHECK ((source = ANY (ARRAY['CONTROLLED'::text, 'JOINPAY'::text]))),
    CONSTRAINT payment_confirmation_source_shape CHECK ((((source = 'CONTROLLED'::text) AND (joinpay_request_id IS NULL) AND (joinpay_evidence_id IS NULL) AND (joinpay_anchor_id IS NULL)) OR ((source = 'JOINPAY'::text) AND (currency = 'CNY'::text) AND (joinpay_request_id IS NOT NULL) AND (joinpay_evidence_id IS NOT NULL) AND (joinpay_anchor_id IS NOT NULL))))
);


--
-- Name: payment_distribution_basis; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.payment_distribution_basis (
    id text NOT NULL,
    order_id text NOT NULL,
    payment_confirmation_id text NOT NULL,
    admission_id text NOT NULL,
    admission_revision bigint NOT NULL,
    canonical_basis text NOT NULL,
    basis_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT payment_distribution_basis_basis_digest_check CHECK ((basis_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payment_distribution_basis_canonical_basis_check CHECK ((jsonb_typeof((canonical_basis)::jsonb) = 'object'::text)),
    CONSTRAINT payment_distribution_basis_check CHECK ((basis_digest = encode(sha256(convert_to(canonical_basis, 'UTF8'::name)), 'hex'::text)))
);


--
-- Name: payment_request; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.payment_request (
    id text NOT NULL,
    order_id text NOT NULL,
    channel text NOT NULL,
    merchant_identity_id text NOT NULL,
    config_profile_id text NOT NULL,
    protocol_version text NOT NULL,
    key_version_ref text NOT NULL,
    platform_order_no text NOT NULL,
    channel_order_no text NOT NULL,
    amount_cents numeric(25,0) NOT NULL,
    currency text NOT NULL,
    wire_amount_yuan text NOT NULL,
    method text NOT NULL,
    evidence_level text NOT NULL,
    idempotency_scope_key text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    state text DEFAULT 'SUBMITTING'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    lease_version bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT payment_request_amount_cents_check CHECK (((amount_cents >= (1)::numeric) AND (amount_cents <= ('9999999999999999'::bigint)::numeric))),
    CONSTRAINT payment_request_channel_check CHECK ((channel = ANY (ARRAY['JOINPAY'::text, 'CONTROLLED'::text]))),
    CONSTRAINT payment_request_check CHECK (((lease_owner IS NULL) = (lease_until IS NULL))),
    CONSTRAINT payment_request_check1 CHECK (((replace(wire_amount_yuan, '.'::text, ''::text))::numeric = amount_cents)),
    CONSTRAINT payment_request_check2 CHECK ((((channel = 'JOINPAY'::text) AND (channel_order_no ~ '^[A-Za-z0-9_]{1,50}$'::text) AND (channel_order_no = replace(platform_order_no, '-'::text, '_'::text))) OR ((channel = 'CONTROLLED'::text) AND (channel_order_no = platform_order_no)))),
    CONSTRAINT payment_request_check3 CHECK (((channel = 'CONTROLLED'::text) = (evidence_level = 'CONTROLLED_TEST'::text))),
    CONSTRAINT payment_request_config_profile_id_check CHECK ((config_profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_request_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT payment_request_evidence_level_check CHECK ((evidence_level = ANY (ARRAY['SYNTHETIC_PROTOCOL'::text, 'CONTROLLED_TEST'::text, 'JOINPAY_CANDIDATE'::text]))),
    CONSTRAINT payment_request_id_check CHECK ((id ~ '^payreq_[0-9a-f]{32}$'::text)),
    CONSTRAINT payment_request_key_version_ref_check CHECK ((key_version_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_request_lease_owner_check CHECK ((lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_request_lease_version_check CHECK ((lease_version >= 0)),
    CONSTRAINT payment_request_merchant_identity_id_check CHECK ((merchant_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text)),
    CONSTRAINT payment_request_method_check CHECK ((method = ANY (ARRAY['ALIPAY_NATIVE'::text, 'WEIXIN_NATIVE'::text]))),
    CONSTRAINT payment_request_platform_order_no_check CHECK (((length(platform_order_no) >= 1) AND (length(platform_order_no) <= 128))),
    CONSTRAINT payment_request_protocol_version_check CHECK ((protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$'::text)),
    CONSTRAINT payment_request_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payment_request_revision_check CHECK ((revision >= 1)),
    CONSTRAINT payment_request_state_check CHECK ((state = ANY (ARRAY['SUBMITTING'::text, 'UNKNOWN'::text, 'ACTION_READY'::text, 'PROCESSING_UNCONFIRMED'::text, 'REJECTED_BY_CHANNEL'::text, 'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'::text, 'ACCEPTED'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT payment_request_wire_amount_yuan_check CHECK ((wire_amount_yuan ~ '^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'::text))
);


--
-- Name: personal_finance_observation; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.personal_finance_observation (
    id text NOT NULL,
    user_id text NOT NULL,
    basis_id text,
    source_kind text NOT NULL,
    source_type text NOT NULL,
    source_system text NOT NULL,
    legacy_user_id text NOT NULL,
    source_entity text NOT NULL,
    source_id text NOT NULL,
    source_digest text NOT NULL,
    source_canonical text NOT NULL,
    source_event_at timestamp with time zone,
    imported_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    included_in_opening boolean NOT NULL,
    snapshot jsonb NOT NULL,
    CONSTRAINT personal_finance_observation_check CHECK (((NOT included_in_opening) OR (basis_id IS NOT NULL))),
    CONSTRAINT personal_finance_observation_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT personal_finance_observation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_source_kind_check CHECK ((source_kind = ANY (ARRAY['HISTORICAL_EARNINGS_LOG'::text, 'HISTORICAL_DISTRIBUTION'::text, 'HISTORICAL_WITHDRAWAL'::text]))),
    CONSTRAINT personal_finance_observation_source_type_check CHECK ((source_type = 'LEGACY_MYSQL'::text))
);


--
-- Name: personal_finance_observation_coverage; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.personal_finance_observation_coverage (
    id text NOT NULL,
    user_id text NOT NULL,
    source_system text NOT NULL,
    legacy_user_id text NOT NULL,
    source_kind text NOT NULL,
    source_entity text NOT NULL,
    source_cutoff timestamp with time zone NOT NULL,
    input_sha256 text NOT NULL,
    identity_digest text NOT NULL,
    source_count integer NOT NULL,
    imported_count integer NOT NULL,
    isolated_count integer NOT NULL,
    source_set_digest text NOT NULL,
    imported_set_digest text NOT NULL,
    isolated_set_digest text NOT NULL,
    body_digest text NOT NULL,
    source_canonical text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_finance_observation_coverage_body_digest_check CHECK ((body_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_check CHECK ((source_count = (imported_count + isolated_count))),
    CONSTRAINT personal_finance_observation_coverage_check1 CHECK ((((source_kind = 'HISTORICAL_EARNINGS_LOG'::text) AND (source_entity = 'la_log_earnings'::text)) OR ((source_kind = 'HISTORICAL_DISTRIBUTION'::text) AND (source_entity = 'la_distribution_order'::text)) OR ((source_kind = 'HISTORICAL_WITHDRAWAL'::text) AND (source_entity = 'la_withdraw_apply'::text)))),
    CONSTRAINT personal_finance_observation_coverage_identity_digest_check CHECK ((identity_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_imported_count_check CHECK ((imported_count >= 0)),
    CONSTRAINT personal_finance_observation_coverage_imported_set_digest_check CHECK ((imported_set_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_isolated_count_check CHECK ((isolated_count >= 0)),
    CONSTRAINT personal_finance_observation_coverage_isolated_set_digest_check CHECK ((isolated_set_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_legacy_user_id_check CHECK ((legacy_user_id ~ '^[1-9][0-9]{0,23}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_source_count_check CHECK (((source_count >= 0) AND (source_count <= 500000))),
    CONSTRAINT personal_finance_observation_coverage_source_kind_check CHECK ((source_kind = ANY (ARRAY['HISTORICAL_EARNINGS_LOG'::text, 'HISTORICAL_DISTRIBUTION'::text, 'HISTORICAL_WITHDRAWAL'::text]))),
    CONSTRAINT personal_finance_observation_coverage_source_set_digest_check CHECK ((source_set_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT personal_finance_observation_coverage_source_system_check CHECK ((source_system = 'legacy_mysql_restore'::text))
);


--
-- Name: prestart_termination; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.prestart_termination (
    id text NOT NULL,
    order_id text NOT NULL,
    requested_by_user_id text,
    requested_by_party text NOT NULL,
    reason text NOT NULL,
    basis_digest text NOT NULL,
    payment_basis jsonb NOT NULL,
    request_id text NOT NULL,
    state text DEFAULT 'REQUESTED'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    last_reason text,
    approved_at timestamp with time zone,
    approved_xid xid8,
    liability_root_id text,
    liability_event_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    requested_by_admin_user_id text,
    CONSTRAINT prestart_termination_basis_digest_check CHECK ((basis_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT prestart_termination_check CHECK ((((state = 'APPROVED'::text) AND (approved_at IS NOT NULL) AND (approved_xid IS NOT NULL)) OR ((state <> 'APPROVED'::text) AND (approved_at IS NULL) AND (approved_xid IS NULL) AND (liability_root_id IS NULL) AND (liability_event_id IS NULL)))),
    CONSTRAINT prestart_termination_party_shape CHECK ((requested_by_party = ANY (ARRAY['RENTER'::text, 'OWNER'::text, 'SUPPORT'::text]))),
    CONSTRAINT prestart_termination_reason_check CHECK (((length(btrim(reason)) >= 3) AND (octet_length(reason) <= 600))),
    CONSTRAINT prestart_termination_requester_shape CHECK ((((requested_by_party = ANY (ARRAY['RENTER'::text, 'OWNER'::text])) AND (requested_by_user_id IS NOT NULL) AND (requested_by_admin_user_id IS NULL)) OR ((requested_by_party = 'SUPPORT'::text) AND (requested_by_user_id IS NULL) AND (requested_by_admin_user_id IS NOT NULL)))),
    CONSTRAINT prestart_termination_revision_check CHECK ((revision > 0)),
    CONSTRAINT prestart_termination_state_check CHECK ((state = ANY (ARRAY['REQUESTED'::text, 'REVIEW_REQUIRED'::text, 'REJECTED'::text, 'APPROVED'::text])))
);


--
-- Name: prestart_termination_decision; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.prestart_termination_decision (
    id text NOT NULL,
    termination_id text NOT NULL,
    result_revision bigint NOT NULL,
    decision text NOT NULL,
    assessment text,
    reason text NOT NULL,
    admin_user_id text NOT NULL,
    session_id text NOT NULL,
    request_id text NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT prestart_termination_decision_assessment_shape CHECK ((((decision = 'APPROVE'::text) AND (assessment = ANY (ARRAY['NO_USE_NO_DISPUTE'::text, 'SUPPORT_FULL_REFUND'::text]))) OR ((decision <> 'APPROVE'::text) AND (assessment IS NULL)))),
    CONSTRAINT prestart_termination_decision_decision_check CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text, 'REVIEW_REQUIRED'::text]))),
    CONSTRAINT prestart_termination_decision_reason_check CHECK (((length(btrim(reason)) >= 3) AND (octet_length(reason) <= 600))),
    CONSTRAINT prestart_termination_decision_result_revision_check CHECK ((result_revision > 1))
);


--
-- Name: rental_opening; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_opening (
    id text NOT NULL,
    order_id text NOT NULL,
    version_no integer NOT NULL,
    quote_digest text NOT NULL,
    payment_digest text NOT NULL,
    lines jsonb NOT NULL,
    status text NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    confirmed_at timestamp with time zone,
    confirm_source text,
    auto_confirm_due_at timestamp with time zone,
    CONSTRAINT rental_opening_check CHECK ((((status = 'DRAFT'::text) AND (confirmed_at IS NULL)) OR ((status = 'CONFIRMED'::text) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT rental_opening_confirm_source_check CHECK (((confirm_source IS NULL) OR (confirm_source = ANY (ARRAY['PARTY'::text, 'ON_BEHALF'::text, 'AUTO'::text])))),
    CONSTRAINT rental_opening_payment_digest_check CHECK ((payment_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_opening_quote_digest_check CHECK ((quote_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_opening_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'CONFIRMED'::text]))),
    CONSTRAINT rental_opening_version_no_check CHECK ((version_no > 0))
);


--
-- Name: rental_opening_ack; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_opening_ack (
    opening_id text NOT NULL,
    party text NOT NULL,
    user_id text NOT NULL,
    version_no integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    source text DEFAULT 'PARTY'::text NOT NULL,
    CONSTRAINT rental_opening_ack_party_check CHECK ((party = ANY (ARRAY['RENTER'::text, 'OWNER'::text]))),
    CONSTRAINT rental_opening_ack_source_check CHECK ((source = ANY (ARRAY['PARTY'::text, 'ON_BEHALF'::text, 'AUTO'::text]))),
    CONSTRAINT rental_opening_ack_version_no_check CHECK ((version_no > 0))
);


--
-- Name: rental_referral_earning; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_referral_earning (
    id text NOT NULL,
    economic_root_id text NOT NULL,
    economic_key text NOT NULL,
    order_id text NOT NULL,
    payment_confirmation_id text NOT NULL,
    posting_id text NOT NULL,
    beneficiary_user_id text NOT NULL,
    beneficiary_role text NOT NULL,
    amount_cents numeric(24,0) NOT NULL,
    due_at timestamp with time zone NOT NULL,
    basis_digest text NOT NULL,
    posting_digest text NOT NULL,
    canonical_seed text NOT NULL,
    seed_digest text NOT NULL,
    state text NOT NULL,
    funds_disposition text NOT NULL,
    recovery_required_cents numeric(24,0),
    version bigint NOT NULL,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT rental_referral_earning_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT rental_referral_earning_basis_digest_check CHECK ((basis_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_referral_earning_beneficiary_role_check CHECK ((beneficiary_role = ANY (ARRAY['RENTER_REFERRAL'::text, 'OWNER_REFERRAL'::text]))),
    CONSTRAINT rental_referral_earning_check CHECK ((seed_digest = encode(sha256(convert_to(canonical_seed, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT rental_referral_earning_check1 CHECK ((id = economic_root_id)),
    CONSTRAINT rental_referral_earning_check2 CHECK ((((state = 'PENDING'::text) AND (funds_disposition = 'PENDING'::text) AND (recovery_required_cents IS NULL)) OR ((state = 'SETTLED'::text) AND (funds_disposition = 'SETTLED'::text) AND (recovery_required_cents IS NULL)) OR ((state = 'REVOKED'::text) AND (funds_disposition = 'REVOKED'::text) AND (recovery_required_cents IS NULL)) OR ((state = 'RECOVERY_REQUIRED'::text) AND (funds_disposition = 'SETTLED'::text) AND (amount_cents > (0)::numeric) AND (recovery_required_cents = amount_cents)))),
    CONSTRAINT rental_referral_earning_funds_disposition_check CHECK ((funds_disposition = ANY (ARRAY['PENDING'::text, 'SETTLED'::text, 'REVOKED'::text]))),
    CONSTRAINT rental_referral_earning_posting_digest_check CHECK ((posting_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_referral_earning_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'SETTLED'::text, 'REVOKED'::text, 'RECOVERY_REQUIRED'::text]))),
    CONSTRAINT rental_referral_earning_version_check CHECK ((version > 0))
);


--
-- Name: rental_referral_reversal_source; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_referral_reversal_source (
    id text NOT NULL,
    earning_id text NOT NULL,
    scope text NOT NULL,
    basis_digest text NOT NULL,
    amount_cents numeric(24,0) NOT NULL,
    canonical_source text NOT NULL,
    source_digest text NOT NULL,
    approval_digest text NOT NULL,
    created_by_admin_id text NOT NULL,
    reason text NOT NULL,
    declared_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT rental_referral_reversal_source_amount_cents_check CHECK ((amount_cents >= (0)::numeric)),
    CONSTRAINT rental_referral_reversal_source_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_referral_reversal_source_basis_digest_check CHECK ((basis_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rental_referral_reversal_source_check CHECK ((source_digest = encode(sha256(convert_to(canonical_source, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT rental_referral_reversal_source_check1 CHECK (COALESCE(((jsonb_typeof((canonical_source)::jsonb) = 'object'::text) AND (((canonical_source)::jsonb ->> 'schema'::text) = 'rental-referral-reversal.v1'::text) AND (((canonical_source)::jsonb ->> 'scope'::text) = scope) AND (((canonical_source)::jsonb ->> 'earningId'::text) = earning_id) AND (((canonical_source)::jsonb ->> 'basisDigest'::text) = basis_digest) AND (((canonical_source)::jsonb ->> 'amountCents'::text) = (amount_cents)::text)), false)),
    CONSTRAINT rental_referral_reversal_source_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500))),
    CONSTRAINT rental_referral_reversal_source_scope_check CHECK ((scope = ANY (ARRAY['LOCAL_CONTROLLED'::text, 'NATIVE'::text])))
);


--
-- Name: rental_referral_transition; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.rental_referral_transition (
    id text NOT NULL,
    earning_id text NOT NULL,
    action text NOT NULL,
    expected_version bigint NOT NULL,
    result_version bigint NOT NULL,
    finance_event_id text,
    reversal_source_id text,
    source_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT rental_referral_transition_action_check CHECK ((action = ANY (ARRAY['ACCRUE'::text, 'SETTLE'::text, 'REVOKE'::text, 'RECOVER'::text]))),
    CONSTRAINT rental_referral_transition_check CHECK ((result_version = (expected_version + 1))),
    CONSTRAINT rental_referral_transition_check1 CHECK ((((action = 'ACCRUE'::text) AND (expected_version = 0) AND (result_version = 1) AND (reversal_source_id IS NULL) AND (finance_event_id IS NOT NULL)) OR ((action = 'SETTLE'::text) AND (expected_version > 0) AND (reversal_source_id IS NULL) AND (finance_event_id IS NOT NULL)) OR ((action = 'REVOKE'::text) AND (expected_version > 0) AND (reversal_source_id IS NOT NULL)) OR ((action = 'RECOVER'::text) AND (expected_version > 0) AND (reversal_source_id IS NOT NULL) AND (finance_event_id IS NOT NULL)))),
    CONSTRAINT rental_referral_transition_expected_version_check CHECK ((expected_version >= 0)),
    CONSTRAINT rental_referral_transition_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: settlement_decision; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.settlement_decision (
    id text NOT NULL,
    settlement_version_id text NOT NULL,
    version_hash text NOT NULL,
    basis_hash text NOT NULL,
    party text NOT NULL,
    action text NOT NULL,
    subject_id text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT settlement_decision_action_check CHECK ((action = ANY (ARRAY['CONFIRM'::text, 'REJECT'::text, 'REVIEW'::text]))),
    CONSTRAINT settlement_decision_basis_hash_check CHECK ((basis_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT settlement_decision_check CHECK ((((party = ANY (ARRAY['RENTER'::text, 'OWNER'::text])) AND (action = ANY (ARRAY['CONFIRM'::text, 'REJECT'::text]))) OR ((party = 'SUPPORT'::text) AND (action = 'REVIEW'::text)))),
    CONSTRAINT settlement_decision_check1 CHECK (((action <> 'REJECT'::text) OR ((reason IS NOT NULL) AND (length(reason) >= 1)))),
    CONSTRAINT settlement_decision_party_check CHECK ((party = ANY (ARRAY['RENTER'::text, 'OWNER'::text, 'SUPPORT'::text]))),
    CONSTRAINT settlement_decision_version_hash_check CHECK ((version_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: settlement_intake; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.settlement_intake (
    id text NOT NULL,
    order_id text NOT NULL,
    opening_id text NOT NULL,
    version_no integer NOT NULL,
    initiator_party text NOT NULL,
    initiator_subject_id text NOT NULL,
    lines jsonb NOT NULL,
    basis_hash text NOT NULL,
    status text NOT NULL,
    settlement_version_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    classified_at timestamp with time zone,
    superseded_at timestamp with time zone,
    CONSTRAINT settlement_intake_basis_hash_check CHECK ((basis_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT settlement_intake_check CHECK ((((status = 'OPEN'::text) AND (settlement_version_id IS NULL) AND (classified_at IS NULL) AND (superseded_at IS NULL)) OR ((status = 'CLASSIFIED'::text) AND (settlement_version_id IS NOT NULL) AND (classified_at IS NOT NULL) AND (superseded_at IS NULL)) OR ((status = 'SUPERSEDED'::text) AND (settlement_version_id IS NULL) AND (classified_at IS NULL) AND (superseded_at IS NOT NULL)))),
    CONSTRAINT settlement_intake_initiator_party_check CHECK ((initiator_party = ANY (ARRAY['RENTER'::text, 'OWNER'::text]))),
    CONSTRAINT settlement_intake_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLASSIFIED'::text, 'SUPERSEDED'::text]))),
    CONSTRAINT settlement_intake_version_no_check CHECK ((version_no > 0))
);


--
-- Name: settlement_ledger_entry; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.settlement_ledger_entry (
    id text NOT NULL,
    posting_id text,
    line_no integer NOT NULL,
    account_code text NOT NULL,
    debit_cents numeric(24,0) DEFAULT 0 NOT NULL,
    credit_cents numeric(24,0) DEFAULT 0 NOT NULL,
    counterparty_user_id text,
    source_payment_confirmation_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finance_event_id text,
    CONSTRAINT settlement_ledger_accounts CHECK ((((posting_id IS NOT NULL) AND (account_code = ANY (ARRAY['CAPTURED_PAYMENT_SOURCE'::text, 'OWNER_AVAILABLE'::text, 'RENTER_REFUND_PAYABLE'::text, 'PLATFORM_HAFF_SPREAD'::text, 'PLATFORM_ITEM_SPREAD'::text, 'PLATFORM_EARLY_MAKEUP'::text, 'PLATFORM_COMPENSATION_FEE'::text, 'PLATFORM_MANUAL_NET_ADJUSTMENT'::text]))) OR ((finance_event_id IS NOT NULL) AND (account_code = ANY (ARRAY['WALLET_AVAILABLE'::text, 'LEGACY_OPENING_SOURCE'::text, 'WALLET_RESERVED'::text, 'PAYOUT_CLEARING'::text, 'WITHDRAW_FEE'::text, 'WALLET_PENDING_EARNINGS'::text, 'DISTRIBUTION_EXPENSE'::text, 'GUARANTEE_CASH'::text, 'GUARANTEE_HELD'::text, 'LEGACY_LIABILITY_SOURCE'::text, 'OWNER_AVAILABLE'::text, 'RENTER_REFUND_PAYABLE'::text, 'JOINPAY_UNALLOCATED_RECEIPT'::text, 'CAPTURED_PAYMENT_SOURCE'::text]))))),
    CONSTRAINT settlement_ledger_counterparty CHECK ((((account_code = ANY (ARRAY['OWNER_AVAILABLE'::text, 'RENTER_REFUND_PAYABLE'::text, 'WALLET_AVAILABLE'::text, 'WALLET_RESERVED'::text, 'WALLET_PENDING_EARNINGS'::text, 'GUARANTEE_HELD'::text])) AND (counterparty_user_id IS NOT NULL)) OR ((account_code <> ALL (ARRAY['OWNER_AVAILABLE'::text, 'RENTER_REFUND_PAYABLE'::text, 'WALLET_AVAILABLE'::text, 'WALLET_RESERVED'::text, 'WALLET_PENDING_EARNINGS'::text, 'GUARANTEE_HELD'::text])) AND (counterparty_user_id IS NULL)))),
    CONSTRAINT settlement_ledger_entry_check CHECK ((((debit_cents > (0)::numeric) AND (credit_cents = (0)::numeric)) OR ((credit_cents > (0)::numeric) AND (debit_cents = (0)::numeric)))),
    CONSTRAINT settlement_ledger_entry_check1 CHECK ((((account_code = 'CAPTURED_PAYMENT_SOURCE'::text) AND (source_payment_confirmation_id IS NOT NULL) AND (counterparty_user_id IS NULL)) OR ((account_code <> 'CAPTURED_PAYMENT_SOURCE'::text) AND (source_payment_confirmation_id IS NULL)))),
    CONSTRAINT settlement_ledger_entry_credit_cents_check CHECK ((credit_cents >= (0)::numeric)),
    CONSTRAINT settlement_ledger_entry_debit_cents_check CHECK ((debit_cents >= (0)::numeric)),
    CONSTRAINT settlement_ledger_entry_line_no_check CHECK ((line_no > 0)),
    CONSTRAINT settlement_ledger_exact_parent CHECK ((num_nonnulls(posting_id, finance_event_id) = 1))
);


--
-- Name: settlement_posting; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.settlement_posting (
    id text NOT NULL,
    order_id text NOT NULL,
    settlement_version_id text NOT NULL,
    payment_confirmation_id text NOT NULL,
    version_hash text NOT NULL,
    early boolean NOT NULL,
    currency text DEFAULT 'CNY'::text NOT NULL,
    captured_cents numeric(24,0) NOT NULL,
    system_owner_net_cents numeric(24,0) NOT NULL,
    owner_net_cents numeric(24,0) NOT NULL,
    system_renter_refund_cents numeric(24,0) NOT NULL,
    renter_refund_cents numeric(24,0) NOT NULL,
    platform_contribution_cents numeric(24,0) NOT NULL,
    compensation_fee_cents numeric(24,0) NOT NULL,
    manual_reason text,
    approval_request_id text,
    approval_requested_by text,
    approval_approved_by text,
    approval_expires_at timestamp with time zone,
    approval_payload_hash text,
    posted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    refund_due_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT settlement_posting_approval_payload_hash_check CHECK (((approval_payload_hash IS NULL) OR (approval_payload_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT settlement_posting_captured_cents_check CHECK ((captured_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_check CHECK ((captured_cents = ((owner_net_cents + renter_refund_cents) + platform_contribution_cents))),
    CONSTRAINT settlement_posting_check1 CHECK ((((manual_reason IS NULL) AND (approval_request_id IS NULL)) OR (((length(btrim(manual_reason)) >= 3) AND (length(btrim(manual_reason)) <= 500)) AND (approval_request_id IS NOT NULL)))),
    CONSTRAINT settlement_posting_check2 CHECK ((((approval_request_id IS NULL) AND (approval_requested_by IS NULL) AND (approval_approved_by IS NULL) AND (approval_expires_at IS NULL) AND (approval_payload_hash IS NULL)) OR ((approval_request_id IS NOT NULL) AND (approval_requested_by IS NOT NULL) AND (approval_approved_by IS NOT NULL) AND (approval_requested_by <> approval_approved_by) AND (approval_expires_at > posted_at) AND (approval_payload_hash IS NOT NULL)))),
    CONSTRAINT settlement_posting_check3 CHECK ((refund_due_at = (posted_at +
CASE
    WHEN early THEN '168:00:00'::interval
    ELSE '00:00:00'::interval
END))),
    CONSTRAINT settlement_posting_compensation_fee_cents_check CHECK ((compensation_fee_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_currency_check CHECK ((currency = 'CNY'::text)),
    CONSTRAINT settlement_posting_owner_net_cents_check CHECK ((owner_net_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_platform_contribution_cents_check CHECK ((platform_contribution_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_renter_refund_cents_check CHECK ((renter_refund_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_system_owner_net_cents_check CHECK ((system_owner_net_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_system_renter_refund_cents_check CHECK ((system_renter_refund_cents >= (0)::numeric)),
    CONSTRAINT settlement_posting_version_hash_check CHECK ((version_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: settlement_version; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.settlement_version (
    id text NOT NULL,
    order_id text NOT NULL,
    opening_id text NOT NULL,
    version_no integer NOT NULL,
    kind text NOT NULL,
    end_reason text NOT NULL,
    early boolean NOT NULL,
    initiator_party text NOT NULL,
    initiator_subject_id text NOT NULL,
    basis_hash text NOT NULL,
    version_hash text NOT NULL,
    input_snapshot jsonb NOT NULL,
    computation jsonb NOT NULL,
    system_owner_net_cents numeric(24,0) NOT NULL,
    system_renter_refund_cents numeric(24,0) NOT NULL,
    proposed_owner_net_cents numeric(24,0),
    proposed_renter_refund_cents numeric(24,0),
    approval_request_id text,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT settlement_version_basis_hash_check CHECK ((basis_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT settlement_version_check CHECK ((basis_hash = version_hash)),
    CONSTRAINT settlement_version_check1 CHECK ((((kind = 'SYSTEM'::text) AND (proposed_owner_net_cents IS NULL) AND (proposed_renter_refund_cents IS NULL) AND (approval_request_id IS NULL)) OR ((kind = 'MANUAL_ADJUSTMENT'::text) AND (proposed_owner_net_cents IS NOT NULL) AND (proposed_renter_refund_cents IS NOT NULL) AND (approval_request_id IS NOT NULL)))),
    CONSTRAINT settlement_version_end_reason_check CHECK ((end_reason = ANY (ARRAY['NORMAL'::text, 'TENANT_VOLUNTARY_EARLY'::text, 'OWNER_OR_ACCOUNT_EARLY'::text]))),
    CONSTRAINT settlement_version_initiator_party_check CHECK ((initiator_party = ANY (ARRAY['RENTER'::text, 'OWNER'::text, 'SUPPORT'::text]))),
    CONSTRAINT settlement_version_kind_check CHECK ((kind = ANY (ARRAY['SYSTEM'::text, 'MANUAL_ADJUSTMENT'::text]))),
    CONSTRAINT settlement_version_proposed_owner_net_cents_check CHECK ((proposed_owner_net_cents >= (0)::numeric)),
    CONSTRAINT settlement_version_proposed_renter_refund_cents_check CHECK ((proposed_renter_refund_cents >= (0)::numeric)),
    CONSTRAINT settlement_version_system_owner_net_cents_check CHECK ((system_owner_net_cents >= (0)::numeric)),
    CONSTRAINT settlement_version_system_renter_refund_cents_check CHECK ((system_renter_refund_cents >= (0)::numeric)),
    CONSTRAINT settlement_version_version_hash_check CHECK ((version_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT settlement_version_version_no_check CHECK ((version_no > 0))
);


--
-- Name: wallet_coverage; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.wallet_coverage (
    user_id text NOT NULL,
    origin text NOT NULL,
    basis_id text NOT NULL,
    opening_event_id text NOT NULL,
    coverage_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT wallet_coverage_coverage_version_check CHECK ((coverage_version = 1)),
    CONSTRAINT wallet_coverage_origin_check CHECK ((origin = ANY (ARRAY['RECONCILED_OPENING'::text, 'NATIVE_GENESIS'::text])))
);


--
-- Name: wallet_revision; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.wallet_revision (
    user_id text NOT NULL,
    ledger_revision bigint NOT NULL,
    read_revision bigint NOT NULL,
    CONSTRAINT wallet_revision_check CHECK ((read_revision >= ledger_revision)),
    CONSTRAINT wallet_revision_ledger_revision_check CHECK ((ledger_revision >= 0))
);


--
-- Name: withdrawal_admission; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.withdrawal_admission (
    id text NOT NULL,
    user_id text NOT NULL,
    scope text NOT NULL,
    resource_oid oid NOT NULL,
    resource_name text NOT NULL,
    resource_marker text NOT NULL,
    revision bigint NOT NULL,
    active boolean NOT NULL,
    per_intent_cents numeric(24,0) NOT NULL,
    max_intents integer NOT NULL,
    max_gross_cents numeric(24,0) NOT NULL,
    admitted_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by_admin_id text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT withdrawal_admission_check CHECK ((expires_at > admitted_at)),
    CONSTRAINT withdrawal_admission_max_gross_cents_check CHECK ((max_gross_cents > (0)::numeric)),
    CONSTRAINT withdrawal_admission_max_intents_check CHECK (((max_intents >= 1) AND (max_intents <= 2))),
    CONSTRAINT withdrawal_admission_per_intent_cents_check CHECK (((per_intent_cents >= (200)::numeric) AND (per_intent_cents <= (1000000)::numeric))),
    CONSTRAINT withdrawal_admission_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500))),
    CONSTRAINT withdrawal_admission_revision_check CHECK ((revision > 0)),
    CONSTRAINT withdrawal_admission_scope_check CHECK ((scope = 'LOCAL_CONTROLLED'::text))
);


--
-- Name: withdrawal_bank_binding; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.withdrawal_bank_binding (
    id text NOT NULL,
    user_id text NOT NULL,
    revision bigint NOT NULL,
    sealed_details text NOT NULL,
    card_mask text NOT NULL,
    holder_mask text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT withdrawal_bank_binding_card_mask_check CHECK ((card_mask ~ '^\*{4} \*{4} [0-9]{4}$'::text)),
    CONSTRAINT withdrawal_bank_binding_holder_mask_check CHECK (((char_length(holder_mask) = 3) AND ("right"(holder_mask, 2) = '**'::text))),
    CONSTRAINT withdrawal_bank_binding_id_check CHECK ((id ~ '^bank_[a-f0-9]{32}$'::text)),
    CONSTRAINT withdrawal_bank_binding_revision_check CHECK ((revision > 0)),
    CONSTRAINT withdrawal_bank_binding_sealed_details_check CHECK ((((octet_length(sealed_details) >= 1) AND (octet_length(sealed_details) <= 4096)) AND (jsonb_typeof((sealed_details)::jsonb) = 'object'::text)))
);


--
-- Name: withdrawal_destination; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.withdrawal_destination (
    id text NOT NULL,
    user_id text NOT NULL,
    admission_id text NOT NULL,
    mode text NOT NULL,
    kind text NOT NULL,
    scenario text NOT NULL,
    display_mask text NOT NULL,
    revision bigint NOT NULL,
    active boolean NOT NULL,
    CONSTRAINT withdrawal_destination_display_mask_check CHECK (((length(display_mask) >= 1) AND (length(display_mask) <= 100))),
    CONSTRAINT withdrawal_destination_kind_check CHECK ((kind = ANY (ARRAY['BANK_CARD'::text, 'PAYMENT_CODE'::text]))),
    CONSTRAINT withdrawal_destination_mode_check CHECK ((mode = 'LOCAL_CONTROLLED'::text)),
    CONSTRAINT withdrawal_destination_revision_check CHECK ((revision > 0)),
    CONSTRAINT withdrawal_destination_scenario_check CHECK ((scenario = ANY (ARRAY['FAIL_UNPAID'::text, 'TIMEOUT_THEN_SUCCEED'::text])))
);


--
-- Name: withdrawal_intent; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.withdrawal_intent (
    id text NOT NULL,
    user_id text NOT NULL,
    admission_id text NOT NULL,
    destination_id text NOT NULL,
    destination_revision bigint NOT NULL,
    mode text NOT NULL,
    policy_version text NOT NULL,
    input_digest text NOT NULL,
    gross_cents numeric(24,0) NOT NULL,
    net_cents numeric(24,0) NOT NULL,
    fee_cents numeric(24,0) NOT NULL,
    expected_ledger_revision bigint NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    payout_key text NOT NULL,
    economic_root_id text NOT NULL,
    state text NOT NULL,
    operation_version bigint NOT NULL,
    funds_disposition text NOT NULL,
    lease_token_hash text,
    lease_until timestamp with time zone,
    last_provider_fact_id text,
    terminal jsonb,
    conflict_digest text,
    terminal_xid xid8,
    created_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT withdrawal_intent_check CHECK ((gross_cents = (net_cents + fee_cents))),
    CONSTRAINT withdrawal_intent_check1 CHECK (((lease_token_hash IS NULL) = (lease_until IS NULL))),
    CONSTRAINT withdrawal_intent_check2 CHECK ((((state = ANY (ARRAY['RESERVED'::text, 'SUBMITTING'::text, 'PROCESSING'::text, 'UNKNOWN'::text])) AND (funds_disposition = 'RESERVED'::text) AND (terminal IS NULL)) OR ((state = 'SUCCEEDED'::text) AND (funds_disposition = 'PAYOUT_POSTED'::text) AND (terminal IS NOT NULL)) OR ((state = 'FAILED'::text) AND (funds_disposition = 'RELEASE_POSTED'::text) AND (terminal IS NOT NULL)) OR (state = 'RECONCILIATION_REQUIRED'::text))),
    CONSTRAINT withdrawal_intent_conflict_digest_check CHECK ((conflict_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT withdrawal_intent_expected_ledger_revision_check CHECK ((expected_ledger_revision >= 0)),
    CONSTRAINT withdrawal_intent_fee_cents_check CHECK ((fee_cents >= (0)::numeric)),
    CONSTRAINT withdrawal_intent_funds_disposition_check CHECK ((funds_disposition = ANY (ARRAY['RESERVED'::text, 'PAYOUT_POSTED'::text, 'RELEASE_POSTED'::text]))),
    CONSTRAINT withdrawal_intent_gross_cents_check CHECK ((gross_cents > (0)::numeric)),
    CONSTRAINT withdrawal_intent_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT withdrawal_intent_lease_token_hash_check CHECK ((lease_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT withdrawal_intent_mode_check CHECK ((mode = 'LOCAL_CONTROLLED'::text)),
    CONSTRAINT withdrawal_intent_net_cents_check CHECK ((net_cents > (0)::numeric)),
    CONSTRAINT withdrawal_intent_operation_version_check CHECK ((operation_version > 0)),
    CONSTRAINT withdrawal_intent_state_check CHECK ((state = ANY (ARRAY['RESERVED'::text, 'SUBMITTING'::text, 'PROCESSING'::text, 'UNKNOWN'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'RECONCILIATION_REQUIRED'::text])))
);


--
-- Name: withdrawal_provider_fact; Type: TABLE; Schema: zzsh_order; Owner: -
--

CREATE TABLE zzsh_order.withdrawal_provider_fact (
    id text NOT NULL,
    intent_id text NOT NULL,
    payout_key text NOT NULL,
    mode text NOT NULL,
    result_key text NOT NULL,
    evidence_canonical text NOT NULL,
    evidence_digest text NOT NULL,
    producer_lease_hash text NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT withdrawal_provider_fact_check CHECK ((evidence_digest = encode(sha256(convert_to(evidence_canonical, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT withdrawal_provider_fact_evidence_canonical_check CHECK ((jsonb_typeof((evidence_canonical)::jsonb) = 'object'::text)),
    CONSTRAINT withdrawal_provider_fact_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT withdrawal_provider_fact_mode_check CHECK ((mode = 'LOCAL_CONTROLLED'::text)),
    CONSTRAINT withdrawal_provider_fact_producer_lease_hash_check CHECK ((producer_lease_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: account_display_no_counter; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.account_display_no_counter (
    business_date date NOT NULL,
    last_value integer NOT NULL,
    CONSTRAINT account_display_no_counter_business_date_check CHECK (((business_date >= '0001-01-01'::date) AND (business_date < '10000-01-01'::date))),
    CONSTRAINT account_display_no_counter_last_value_check CHECK (((last_value >= 1) AND (last_value <= 999999)))
);


--
-- Name: account_display_no_seq; Type: SEQUENCE; Schema: zzsh_supply; Owner: -
--

CREATE SEQUENCE zzsh_supply.account_display_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_guarantee_proof; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.account_guarantee_proof (
    id text NOT NULL,
    account_id text NOT NULL,
    owner_user_id text NOT NULL,
    version_no bigint NOT NULL,
    price_version_id text NOT NULL,
    policy_version text NOT NULL,
    status text NOT NULL,
    required_cents numeric(24,0) NOT NULL,
    covered_cents numeric(24,0) NOT NULL,
    evidence_ref text NOT NULL,
    evidence_digest text NOT NULL,
    verified_by_admin_id text NOT NULL,
    valid_from timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    valid_until timestamp with time zone,
    supersedes_id text,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT account_guarantee_proof_covered_cents_check CHECK ((covered_cents >= (0)::numeric)),
    CONSTRAINT account_guarantee_proof_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT account_guarantee_proof_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 200))),
    CONSTRAINT account_guarantee_proof_policy_version_check CHECK ((policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'::text)),
    CONSTRAINT account_guarantee_proof_reason_check CHECK (((length(reason) >= 2) AND (length(reason) <= 500))),
    CONSTRAINT account_guarantee_proof_required_cents_check CHECK ((required_cents >= (0)::numeric)),
    CONSTRAINT account_guarantee_proof_status_check CHECK ((status = ANY (ARRAY['SATISFIED'::text, 'NOT_REQUIRED'::text, 'REVOKED'::text]))),
    CONSTRAINT account_guarantee_proof_valid_time CHECK (((valid_until IS NULL) OR (valid_until >= valid_from))),
    CONSTRAINT account_guarantee_proof_version_no_check CHECK ((version_no > 0))
);


--
-- Name: admin_supply_scope; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.admin_supply_scope (
    admin_user_id text NOT NULL,
    game_id text NOT NULL,
    granted_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agreement_version; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.agreement_version (
    id text NOT NULL,
    game_id text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    digest text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    sealed_by_admin_id text,
    sealed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agreement_version_body_size CHECK ((octet_length(body) <= 20000)),
    CONSTRAINT agreement_version_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT agreement_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT agreement_version_sealed_shape CHECK (((status = 'DRAFT'::text) OR ((sealed_at IS NOT NULL) AND (sealed_by_admin_id IS NOT NULL)))),
    CONSTRAINT agreement_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SEALED'::text])))
);


--
-- Name: billable_item; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.billable_item (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    unit text NOT NULL,
    quantity_scale smallint DEFAULT 0 NOT NULL,
    required boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    source_field text,
    source_token text,
    source_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    media_id text,
    CONSTRAINT billable_item_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT billable_item_quantity_scale_check CHECK (((quantity_scale >= 0) AND (quantity_scale <= 6))),
    CONSTRAINT billable_item_unit_check CHECK ((unit = ANY (ARRAY['HAFF_BASE'::text, 'ROUND'::text, 'PIECE'::text, 'DAY'::text])))
);


--
-- Name: duplicate_hint; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.duplicate_hint (
    id text NOT NULL,
    account_id text NOT NULL,
    related_account_id text NOT NULL,
    evidence_ref text NOT NULL,
    result text NOT NULL,
    reason text NOT NULL,
    reviewer_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT duplicate_hint_check CHECK ((account_id <> related_account_id)),
    CONSTRAINT duplicate_hint_result_check CHECK ((result = ANY (ARRAY['UNREVIEWED'::text, 'DISTINCT'::text, 'POSSIBLE_SAME'::text])))
);


--
-- Name: entitlement; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.entitlement (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    value_kind text NOT NULL,
    expiry_kind text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    source_field text,
    source_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entitlement_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT entitlement_expiry_kind_check CHECK ((expiry_kind = ANY (ARRAY['PERMANENT'::text, 'TIMED'::text]))),
    CONSTRAINT entitlement_value_kind_check CHECK ((value_kind = ANY (ARRAY['FLAG'::text, 'LEVEL'::text, 'CAPACITY'::text])))
);


--
-- Name: favorite; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.favorite (
    user_id text NOT NULL,
    account_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: firearm; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.firearm (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    classification_id text,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    media_id text,
    source_namespace text,
    source_token text,
    source_note text,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text,
    updated_by_admin_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT firearm_code_check CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT firearm_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT firearm_revision_check CHECK ((revision > 0)),
    CONSTRAINT firearm_sort_order_check CHECK (((sort_order >= '-100000'::integer) AND (sort_order <= 100000))),
    CONSTRAINT firearm_source_note_check CHECK (((source_note IS NULL) OR (char_length(source_note) <= 500))),
    CONSTRAINT firearm_source_shape CHECK (((source_namespace IS NULL) = (source_token IS NULL)))
);


--
-- Name: firearm_alias; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.firearm_alias (
    id text NOT NULL,
    game_id text NOT NULL,
    firearm_id text NOT NULL,
    locale text DEFAULT 'zh-CN'::text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    source_namespace text,
    source_token text,
    source_note text,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text,
    updated_by_admin_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT firearm_alias_locale_check CHECK (((char_length(locale) >= 2) AND (char_length(locale) <= 32))),
    CONSTRAINT firearm_alias_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT firearm_alias_revision_check CHECK ((revision > 0)),
    CONSTRAINT firearm_alias_sort_order_check CHECK (((sort_order >= '-100000'::integer) AND (sort_order <= 100000))),
    CONSTRAINT firearm_alias_source_note_check CHECK (((source_note IS NULL) OR (char_length(source_note) <= 500))),
    CONSTRAINT firearm_alias_source_shape CHECK (((source_namespace IS NULL) = (source_token IS NULL)))
);


--
-- Name: firearm_classification; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.firearm_classification (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    source_namespace text,
    source_token text,
    source_note text,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text,
    updated_by_admin_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT firearm_classification_code_check CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT firearm_classification_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT firearm_classification_revision_check CHECK ((revision > 0)),
    CONSTRAINT firearm_classification_sort_order_check CHECK (((sort_order >= '-100000'::integer) AND (sort_order <= 100000))),
    CONSTRAINT firearm_classification_source_note_check CHECK (((source_note IS NULL) OR (char_length(source_note) <= 500))),
    CONSTRAINT firearm_classification_source_shape CHECK (((source_namespace IS NULL) = (source_token IS NULL)))
);


--
-- Name: full_payout_terms_version; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.full_payout_terms_version (
    id text NOT NULL,
    game_id text NOT NULL,
    policy_ref text NOT NULL,
    policy_version text NOT NULL,
    disclosure_version text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    digest text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    sealed_by_admin_id text,
    sealed_at timestamp with time zone,
    CONSTRAINT full_payout_terms_version_body_check CHECK ((((octet_length(body) >= 1) AND (octet_length(body) <= 20000)) AND (btrim(body) <> ''::text))),
    CONSTRAINT full_payout_terms_version_check CHECK ((digest = encode(sha256(convert_to(body, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT full_payout_terms_version_check1 CHECK ((((status = 'DRAFT'::text) AND (sealed_by_admin_id IS NULL) AND (sealed_at IS NULL)) OR ((status = 'SEALED'::text) AND (sealed_by_admin_id IS NOT NULL) AND (sealed_at IS NOT NULL)))),
    CONSTRAINT full_payout_terms_version_disclosure_version_check CHECK ((((length(disclosure_version) >= 1) AND (length(disclosure_version) <= 160)) AND (btrim(disclosure_version) <> ''::text))),
    CONSTRAINT full_payout_terms_version_policy_ref_check CHECK ((((length(policy_ref) >= 1) AND (length(policy_ref) <= 160)) AND (btrim(policy_ref) <> ''::text))),
    CONSTRAINT full_payout_terms_version_policy_version_check CHECK ((((length(policy_version) >= 1) AND (length(policy_version) <= 160)) AND (btrim(policy_version) <> ''::text))),
    CONSTRAINT full_payout_terms_version_revision_check CHECK ((revision >= 0)),
    CONSTRAINT full_payout_terms_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SEALED'::text]))),
    CONSTRAINT full_payout_terms_version_title_check CHECK ((((length(title) >= 1) AND (length(title) <= 120)) AND (btrim(title) <> ''::text)))
);


--
-- Name: game; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.game (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    catalog_revision bigint DEFAULT 1 NOT NULL,
    current_release_id text,
    cover_media_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT game_catalog_revision_check CHECK ((catalog_revision > 0)),
    CONSTRAINT game_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text))
);


--
-- Name: game_service_operation; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.game_service_operation (
    id text NOT NULL,
    game_id text NOT NULL,
    service_code text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT game_service_operation_revision_check CHECK ((revision > 0)),
    CONSTRAINT game_service_operation_service_code_check CHECK ((service_code = ANY (ARRAY['ACCOUNT_RENTAL'::text, 'GUNSMITH'::text])))
);


--
-- Name: gunsmith_code; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.gunsmith_code (
    id text NOT NULL,
    game_id text NOT NULL,
    firearm_id text NOT NULL,
    code text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    mode_code text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    last_reviewed_at timestamp with time zone,
    source_namespace text,
    source_token text,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    updated_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_note text,
    CONSTRAINT gunsmith_code_code_check CHECK ((((char_length(code) >= 4) AND (char_length(code) <= 1024)) AND (code = btrim(code)) AND (code !~ '[[:cntrl:]]'::text))),
    CONSTRAINT gunsmith_code_mode_code_check CHECK (((mode_code IS NULL) OR (mode_code = ANY (ARRAY['HAZARD'::text, 'BATTLEFIELD'::text, 'GENERAL'::text])))),
    CONSTRAINT gunsmith_code_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT gunsmith_code_revision_check CHECK ((revision > 0)),
    CONSTRAINT gunsmith_code_source_note_check CHECK (((source_note IS NULL) OR (char_length(source_note) <= 500))),
    CONSTRAINT gunsmith_code_source_shape CHECK (((source_namespace IS NULL) = (source_token IS NULL))),
    CONSTRAINT gunsmith_code_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'WITHDRAWN'::text])))
);


--
-- Name: idempotency_record; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.idempotency_record (
    scope_key text NOT NULL,
    key text NOT NULL,
    request_fingerprint text NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publish_required boolean DEFAULT false NOT NULL,
    CONSTRAINT idempotency_record_request_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: inventory_line; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.inventory_line (
    version_id text NOT NULL,
    item_id text NOT NULL,
    quantity numeric(24,0),
    CONSTRAINT inventory_line_quantity_check CHECK ((quantity >= (0)::numeric))
);


--
-- Name: legacy_listing_display_snapshot; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.legacy_listing_display_snapshot (
    account_id text NOT NULL,
    schema_version smallint NOT NULL,
    observation_version_id text NOT NULL,
    base_source_digest text NOT NULL,
    extract_sha256 text NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    evidence_ref text NOT NULL,
    snapshot jsonb NOT NULL,
    display_digest text NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT legacy_listing_display_snapshot_base_source_digest_check CHECK ((base_source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_listing_display_snapshot_display_digest_check CHECK ((display_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_listing_display_snapshot_extract_sha256_check CHECK ((extract_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_listing_display_snapshot_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT legacy_listing_display_snapshot_snapshot_check CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND (NOT ((snapshot ->> 'schema'::text) IS DISTINCT FROM 'legacy-listing-display-v1'::text))))
);


--
-- Name: legacy_listing_read_snapshot; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.legacy_listing_read_snapshot (
    account_id text NOT NULL,
    observation_version_id text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    legacy_id text NOT NULL,
    source_digest text NOT NULL,
    source_status integer NOT NULL,
    source_updated_at timestamp with time zone NOT NULL,
    evidence_ref text NOT NULL,
    snapshot jsonb NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legacy_listing_read_snapshot_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 512))),
    CONSTRAINT legacy_listing_read_snapshot_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT legacy_listing_read_snapshot_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_listing_read_snapshot_source_status_check CHECK ((source_status = ANY (ARRAY[0, 3, 4, 5, 6])))
);


--
-- Name: legacy_skin_holding; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.legacy_skin_holding (
    account_id text NOT NULL,
    observation_version_id text NOT NULL,
    source_system text NOT NULL,
    source_entity text NOT NULL,
    legacy_id text NOT NULL,
    source_digest text NOT NULL,
    holding_digest text NOT NULL,
    skin_ids text[] DEFAULT '{}'::text[] NOT NULL,
    evidence_ref text NOT NULL,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT legacy_skin_holding_evidence_ref_check CHECK (((length(evidence_ref) >= 1) AND (length(evidence_ref) <= 512))),
    CONSTRAINT legacy_skin_holding_holding_digest_check CHECK ((holding_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_skin_holding_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT legacy_skin_holding_source_entity_check CHECK ((source_entity = 'la_rental_accounts'::text)),
    CONSTRAINT legacy_skin_holding_source_system_check CHECK ((source_system = 'legacy_mysql_restore'::text))
);


--
-- Name: legacy_supply_map; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.legacy_supply_map (
    source_system text NOT NULL,
    source_entity text NOT NULL,
    legacy_id text NOT NULL,
    account_id text NOT NULL,
    version_id text NOT NULL,
    evidence_ref text NOT NULL,
    source_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: listing_entitlement; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_entitlement (
    version_id text NOT NULL,
    entitlement_id text NOT NULL,
    value jsonb,
    expires_at timestamp with time zone,
    expiry_knowledge text NOT NULL,
    CONSTRAINT listing_entitlement_expiry_knowledge_check CHECK ((expiry_knowledge = ANY (ARRAY['KNOWN'::text, 'UNKNOWN'::text])))
);


--
-- Name: listing_filter_config; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_filter_config (
    game_id text NOT NULL,
    revision bigint NOT NULL,
    config jsonb NOT NULL,
    restore_from_revision bigint,
    created_by_admin_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT listing_filter_config_check CHECK (((restore_from_revision IS NULL) OR (restore_from_revision < revision))),
    CONSTRAINT listing_filter_config_config_check CHECK (COALESCE(((jsonb_typeof(config) = 'object'::text) AND ((config -> 'schemaVersion'::text) = '1'::jsonb) AND (jsonb_typeof((config -> 'fields'::text)) = 'array'::text) AND (jsonb_typeof((config -> 'sorts'::text)) = 'array'::text)), false)),
    CONSTRAINT listing_filter_config_revision_check CHECK ((revision > 0))
);


--
-- Name: listing_media; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_media (
    version_id text NOT NULL,
    asset_id text NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT listing_media_position_check CHECK ((("position" >= 0) AND ("position" < 100)))
);


--
-- Name: listing_publication; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_publication (
    id text NOT NULL,
    version_id text NOT NULL,
    account_id text NOT NULL,
    owner_user_id text NOT NULL,
    game_id text NOT NULL,
    rule_release_id text NOT NULL,
    content_hash text NOT NULL,
    source text NOT NULL,
    published_by_realm text NOT NULL,
    published_by_user_id text,
    published_by_admin_id text,
    published_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT listing_publication_actor_shape CHECK ((((source = 'OWNER_DIRECT'::text) AND (published_by_realm = 'user'::text) AND (published_by_user_id IS NOT NULL) AND (published_by_user_id = owner_user_id) AND (published_by_admin_id IS NULL)) OR ((source = 'LEGACY_APPROVED'::text) AND (published_by_realm = 'admin'::text) AND (published_by_user_id IS NULL) AND (published_by_admin_id IS NOT NULL)))),
    CONSTRAINT listing_publication_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT listing_publication_published_by_realm_check CHECK ((published_by_realm = ANY (ARRAY['user'::text, 'admin'::text]))),
    CONSTRAINT listing_publication_source_check CHECK ((source = ANY (ARRAY['OWNER_DIRECT'::text, 'LEGACY_APPROVED'::text])))
);


--
-- Name: listing_skin; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_skin (
    version_id text NOT NULL,
    skin_id text NOT NULL
);


--
-- Name: listing_version; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.listing_version (
    id text NOT NULL,
    account_id text NOT NULL,
    sequence bigint NOT NULL,
    origin text DEFAULT 'NATIVE'::text NOT NULL,
    review_state text DEFAULT 'DRAFT'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    description text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    term_option_code text DEFAULT ''::text NOT NULL,
    pricing_option_code text DEFAULT ''::text NOT NULL,
    rule_release_id text,
    content_hash text,
    payload jsonb,
    presentation jsonb DEFAULT '{}'::jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT listing_version_check CHECK (((payload IS NULL) = (content_hash IS NULL))),
    CONSTRAINT listing_version_check1 CHECK (((review_state <> ALL (ARRAY['SUBMITTED'::text, 'APPROVED'::text])) OR ((payload IS NOT NULL) AND (rule_release_id IS NOT NULL) AND (submitted_at IS NOT NULL)))),
    CONSTRAINT listing_version_check2 CHECK (((origin <> 'LEGACY_OBSERVATION'::text) OR (review_state = ANY (ARRAY['DRAFT'::text, 'IMPORTED_UNVERIFIED'::text])))),
    CONSTRAINT listing_version_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT listing_version_origin_check CHECK ((origin = ANY (ARRAY['NATIVE'::text, 'LEGACY_OBSERVATION'::text]))),
    CONSTRAINT listing_version_owner_deposit_shape CHECK ((((attributes -> 'owner_deposit_declaration'::text) IS NULL) OR zzsh_supply.valid_owner_deposit_declaration((attributes -> 'owner_deposit_declaration'::text)))),
    CONSTRAINT listing_version_review_state_check CHECK ((review_state = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'WITHDRAWN'::text, 'REJECTED'::text, 'APPROVED'::text, 'PUBLISHED'::text, 'IMPORTED_UNVERIFIED'::text]))),
    CONSTRAINT listing_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT listing_version_schema_version_check CHECK ((schema_version = ANY (ARRAY[1, 2]))),
    CONSTRAINT listing_version_sequence_check CHECK ((sequence > 0))
);


--
-- Name: media_asset; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.media_asset (
    id text NOT NULL,
    game_id text,
    purpose text NOT NULL,
    ownership_kind text NOT NULL,
    owner_user_id text,
    uploaded_by_realm text NOT NULL,
    uploaded_by_user_id text,
    uploaded_by_admin_id text,
    storage_key text NOT NULL,
    content_hash text NOT NULL,
    mime text NOT NULL,
    byte_size bigint NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    access_class text DEFAULT 'PRIVATE_REVIEW'::text NOT NULL,
    review_state text DEFAULT 'PENDING'::text NOT NULL,
    reviewed_by_admin_id text,
    reviewed_at timestamp with time zone,
    review_reason text,
    source_note text,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    public_storage_key text,
    account_id text,
    technical_state text DEFAULT 'UNKNOWN'::text NOT NULL,
    technical_checked_at timestamp with time zone,
    technical_failure_code text,
    CONSTRAINT asset_user_actor_required CHECK (((uploaded_by_realm <> 'user'::text) OR (uploaded_by_user_id IS NOT NULL))),
    CONSTRAINT media_asset_access_class_check CHECK ((access_class = ANY (ARRAY['PUBLIC_DISPLAY'::text, 'PRIVATE_REVIEW'::text]))),
    CONSTRAINT media_asset_actor_shape CHECK ((((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'PLATFORM_CATALOG'::text) AND (purpose = ANY (ARRAY['GAME_COVER'::text, 'SKIN_MEDIA'::text, 'ITEM_MEDIA'::text, 'FIREARM_MEDIA'::text])) AND (game_id IS NOT NULL) AND (owner_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL) AND (uploaded_by_user_id IS NULL)) OR ((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'PLATFORM_CONTENT'::text) AND (purpose = 'CONTENT_MEDIA'::text) AND (game_id IS NULL) AND (owner_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL) AND (uploaded_by_user_id IS NULL)) OR ((uploaded_by_realm = 'user'::text) AND (ownership_kind = 'USER_SUPPLY'::text) AND (purpose = ANY (ARRAY['ACCOUNT_EVIDENCE'::text, 'ACCOUNT_DISPLAY'::text])) AND (game_id IS NOT NULL) AND (owner_user_id = uploaded_by_user_id) AND (uploaded_by_admin_id IS NULL) AND (owner_user_id IS NOT NULL)) OR ((uploaded_by_realm = 'user'::text) AND (ownership_kind = 'USER_AVATAR'::text) AND (purpose = 'AVATAR'::text) AND (game_id IS NULL) AND (owner_user_id = uploaded_by_user_id) AND (owner_user_id IS NOT NULL) AND (uploaded_by_user_id IS NOT NULL) AND (uploaded_by_admin_id IS NULL) AND (account_id IS NULL)) OR ((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'ADMIN_AVATAR'::text) AND (purpose = 'AVATAR'::text) AND (game_id IS NULL) AND (owner_user_id IS NULL) AND (uploaded_by_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL) AND (account_id IS NULL)))),
    CONSTRAINT media_asset_byte_size_check CHECK (((byte_size > 0) AND (byte_size <= 10485760))),
    CONSTRAINT media_asset_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_asset_height_check CHECK (((height > 0) AND (height <= 8192))),
    CONSTRAINT media_asset_mime_check CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_asset_ownership_kind_check CHECK ((ownership_kind = ANY (ARRAY['PLATFORM_CATALOG'::text, 'USER_SUPPLY'::text, 'PLATFORM_CONTENT'::text, 'USER_AVATAR'::text, 'ADMIN_AVATAR'::text]))),
    CONSTRAINT media_asset_pixel_total CHECK ((((width)::bigint * (height)::bigint) <= 40000000)),
    CONSTRAINT media_asset_public_storage_key_check CHECK ((public_storage_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_asset_public_visibility CHECK (((access_class <> 'PUBLIC_DISPLAY'::text) OR ((public_storage_key IS NOT NULL) AND (((ownership_kind = ANY (ARRAY['PLATFORM_CATALOG'::text, 'PLATFORM_CONTENT'::text])) AND (review_state = 'APPROVED'::text)) OR ((ownership_kind = 'USER_SUPPLY'::text) AND (purpose = 'ACCOUNT_DISPLAY'::text) AND (technical_state = 'READY'::text)) OR ((ownership_kind = ANY (ARRAY['USER_AVATAR'::text, 'ADMIN_AVATAR'::text])) AND (purpose = 'AVATAR'::text) AND (review_state = 'APPROVED'::text) AND (technical_state = 'READY'::text)))))),
    CONSTRAINT media_asset_purpose_check CHECK ((purpose = ANY (ARRAY['GAME_COVER'::text, 'SKIN_MEDIA'::text, 'ITEM_MEDIA'::text, 'ACCOUNT_EVIDENCE'::text, 'ACCOUNT_DISPLAY'::text, 'CONTENT_MEDIA'::text, 'FIREARM_MEDIA'::text, 'AVATAR'::text]))),
    CONSTRAINT media_asset_review_shape CHECK ((((review_state = 'PENDING'::text) AND (reviewed_by_admin_id IS NULL) AND (reviewed_at IS NULL)) OR ((review_state <> 'PENDING'::text) AND (reviewed_by_admin_id IS NOT NULL) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT media_asset_review_state_check CHECK ((review_state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'QUARANTINED'::text]))),
    CONSTRAINT media_asset_revision_check CHECK ((revision > 0)),
    CONSTRAINT media_asset_storage_key_check CHECK ((storage_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_asset_technical_check_shape CHECK ((((technical_state = 'UNKNOWN'::text) AND (technical_checked_at IS NULL) AND (technical_failure_code IS NULL)) OR ((technical_state = 'READY'::text) AND (technical_checked_at IS NOT NULL) AND (technical_failure_code IS NULL)) OR ((technical_state = 'FAILED'::text) AND (technical_checked_at IS NOT NULL) AND (technical_failure_code IS NOT NULL)))),
    CONSTRAINT media_asset_technical_state_check CHECK ((technical_state = ANY (ARRAY['UNKNOWN'::text, 'READY'::text, 'FAILED'::text]))),
    CONSTRAINT media_asset_uploaded_by_realm_check CHECK ((uploaded_by_realm = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT media_asset_width_check CHECK (((width > 0) AND (width <= 8192)))
);


--
-- Name: media_upload_intent; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.media_upload_intent (
    id text NOT NULL,
    token_hash text NOT NULL,
    game_id text,
    account_id text,
    purpose text NOT NULL,
    ownership_kind text NOT NULL,
    owner_user_id text,
    uploaded_by_realm text NOT NULL,
    uploaded_by_user_id text,
    uploaded_by_admin_id text,
    declared_mime text NOT NULL,
    declared_size bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_asset_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_upload_intent_actor_shape CHECK ((((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'PLATFORM_CATALOG'::text) AND (purpose = ANY (ARRAY['GAME_COVER'::text, 'SKIN_MEDIA'::text, 'ITEM_MEDIA'::text, 'FIREARM_MEDIA'::text])) AND (game_id IS NOT NULL) AND (owner_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL) AND (uploaded_by_user_id IS NULL) AND (account_id IS NULL)) OR ((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'PLATFORM_CONTENT'::text) AND (purpose = 'CONTENT_MEDIA'::text) AND (game_id IS NULL) AND (owner_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL) AND (uploaded_by_user_id IS NULL) AND (account_id IS NULL)) OR ((uploaded_by_realm = 'user'::text) AND (ownership_kind = 'USER_SUPPLY'::text) AND (purpose = ANY (ARRAY['ACCOUNT_EVIDENCE'::text, 'ACCOUNT_DISPLAY'::text])) AND (game_id IS NOT NULL) AND (owner_user_id = uploaded_by_user_id) AND (uploaded_by_admin_id IS NULL) AND (owner_user_id IS NOT NULL) AND (account_id IS NOT NULL)) OR ((uploaded_by_realm = 'user'::text) AND (ownership_kind = 'USER_AVATAR'::text) AND (purpose = 'AVATAR'::text) AND (game_id IS NULL) AND (account_id IS NULL) AND (owner_user_id = uploaded_by_user_id) AND (owner_user_id IS NOT NULL) AND (uploaded_by_user_id IS NOT NULL) AND (uploaded_by_admin_id IS NULL)) OR ((uploaded_by_realm = 'admin'::text) AND (ownership_kind = 'ADMIN_AVATAR'::text) AND (purpose = 'AVATAR'::text) AND (game_id IS NULL) AND (account_id IS NULL) AND (owner_user_id IS NULL) AND (uploaded_by_user_id IS NULL) AND (uploaded_by_admin_id IS NOT NULL)))),
    CONSTRAINT media_upload_intent_consumed_shape CHECK (((consumed_at IS NULL) = (consumed_asset_id IS NULL))),
    CONSTRAINT media_upload_intent_declared_mime_check CHECK ((declared_mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_upload_intent_declared_size_check CHECK (((declared_size > 0) AND (declared_size <= 10485760))),
    CONSTRAINT media_upload_intent_ownership_kind_check CHECK ((ownership_kind = ANY (ARRAY['PLATFORM_CATALOG'::text, 'USER_SUPPLY'::text, 'PLATFORM_CONTENT'::text, 'USER_AVATAR'::text, 'ADMIN_AVATAR'::text]))),
    CONSTRAINT media_upload_intent_purpose_check CHECK ((purpose = ANY (ARRAY['GAME_COVER'::text, 'SKIN_MEDIA'::text, 'ITEM_MEDIA'::text, 'ACCOUNT_EVIDENCE'::text, 'ACCOUNT_DISPLAY'::text, 'CONTENT_MEDIA'::text, 'FIREARM_MEDIA'::text, 'AVATAR'::text]))),
    CONSTRAINT media_upload_intent_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_upload_intent_uploaded_by_realm_check CHECK ((uploaded_by_realm = ANY (ARRAY['admin'::text, 'user'::text]))),
    CONSTRAINT upload_user_actor_required CHECK (((uploaded_by_realm <> 'user'::text) OR (uploaded_by_user_id IS NOT NULL)))
);


--
-- Name: price_line; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.price_line (
    id text NOT NULL,
    price_version_id text NOT NULL,
    item_id text NOT NULL,
    customer_tier text DEFAULT 'STANDARD'::text NOT NULL,
    pricing_kind text NOT NULL,
    unit_quantity numeric(24,0),
    buyer_unit_amount numeric(24,8),
    owner_unit_amount numeric(24,8),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_line_amounts_non_negative CHECK ((((buyer_unit_amount IS NULL) OR (buyer_unit_amount >= (0)::numeric)) AND ((owner_unit_amount IS NULL) OR (owner_unit_amount >= (0)::numeric)))),
    CONSTRAINT price_line_customer_tier_check CHECK ((customer_tier = ANY (ARRAY['STANDARD'::text, 'VIP'::text, 'SVIP'::text, 'DISCOUNT_USER'::text]))),
    CONSTRAINT price_line_pricing_kind_check CHECK ((pricing_kind = ANY (ARRAY['FIXED_UNIT'::text, 'HAFF_RATIO'::text])))
);


--
-- Name: price_version; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.price_version (
    id text NOT NULL,
    game_id text NOT NULL,
    mode text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    commission_rate numeric(12,8),
    haff_rule jsonb,
    rounding_policy text DEFAULT 'HALF_UP_CENT_V1'::text NOT NULL,
    compensation_policy_ref text,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    sealed_by_admin_id text,
    sealed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    funding_policy jsonb,
    full_payout_terms_version_id text,
    full_payout_terms_digest text,
    full_payout_disclosure_version text,
    CONSTRAINT price_version_full_payout_shape CHECK ((((full_payout_terms_version_id IS NULL) AND (full_payout_terms_digest IS NULL) AND (full_payout_disclosure_version IS NULL)) OR ((full_payout_terms_version_id IS NOT NULL) AND (full_payout_terms_digest IS NOT NULL) AND (full_payout_terms_digest ~ '^[0-9a-f]{64}$'::text) AND (full_payout_disclosure_version IS NOT NULL)))),
    CONSTRAINT price_version_funding_policy_shape CHECK (((funding_policy IS NULL) OR
CASE
    WHEN (status = 'DRAFT'::text) THEN zzsh_supply.valid_funding_policy_draft(funding_policy)
    ELSE zzsh_supply.valid_funding_policy(funding_policy)
END)),
    CONSTRAINT price_version_haff_rule_shape CHECK (COALESCE(((haff_rule IS NULL) OR ((jsonb_typeof(haff_rule) = 'object'::text) AND ((haff_rule ->> 'schema'::text) = 'haff-ratio-v1'::text)) OR ((mode = 'SPREAD'::text) AND zzsh_supply.valid_compat_haff_rule(haff_rule))), false)),
    CONSTRAINT price_version_mode_amounts CHECK ((((mode = 'SPREAD'::text) AND (commission_rate IS NULL)) OR ((mode = 'PERCENT'::text) AND (commission_rate IS NOT NULL) AND (commission_rate >= (0)::numeric) AND (commission_rate < (1)::numeric)))),
    CONSTRAINT price_version_mode_check CHECK ((mode = ANY (ARRAY['SPREAD'::text, 'PERCENT'::text]))),
    CONSTRAINT price_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT price_version_sealed_shape CHECK (((status = 'DRAFT'::text) OR ((sealed_at IS NOT NULL) AND (sealed_by_admin_id IS NOT NULL)))),
    CONSTRAINT price_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SEALED'::text])))
);


--
-- Name: profile_avatar; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.profile_avatar (
    realm text NOT NULL,
    subject_id text NOT NULL,
    default_preset_id text NOT NULL,
    current_kind text NOT NULL,
    current_preset_id text,
    current_asset_id text,
    pending_asset_id text,
    latest_upload_intent_id text,
    revision bigint DEFAULT 1 NOT NULL,
    current_version bigint DEFAULT 1 NOT NULL,
    last_review_asset_id text,
    last_review_state text,
    last_review_reason text,
    last_reviewed_at timestamp with time zone,
    last_review_applied boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT profile_avatar_check CHECK (((pending_asset_id IS NULL) OR (latest_upload_intent_id IS NULL))),
    CONSTRAINT profile_avatar_current_kind_check CHECK ((current_kind = ANY (ARRAY['DEFAULT'::text, 'CUSTOM'::text]))),
    CONSTRAINT profile_avatar_current_preset_id_check CHECK ((current_preset_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'::text)),
    CONSTRAINT profile_avatar_current_shape CHECK ((((current_kind = 'DEFAULT'::text) AND (current_preset_id IS NOT NULL) AND (current_asset_id IS NULL)) OR ((current_kind = 'CUSTOM'::text) AND (current_preset_id IS NULL) AND (current_asset_id IS NOT NULL)))),
    CONSTRAINT profile_avatar_current_version_check CHECK ((current_version > 0)),
    CONSTRAINT profile_avatar_default_preset_id_check CHECK ((default_preset_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'::text)),
    CONSTRAINT profile_avatar_last_review_shape CHECK ((((last_review_asset_id IS NULL) AND (last_review_state IS NULL) AND (last_review_reason IS NULL) AND (last_reviewed_at IS NULL) AND (last_review_applied = false)) OR ((last_review_asset_id IS NOT NULL) AND (last_review_state IS NOT NULL) AND (last_reviewed_at IS NOT NULL)))),
    CONSTRAINT profile_avatar_last_review_state_check CHECK ((last_review_state = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text, 'QUARANTINED'::text, 'WITHDRAWN'::text]))),
    CONSTRAINT profile_avatar_pending_distinct CHECK (((pending_asset_id IS NULL) OR (pending_asset_id IS DISTINCT FROM current_asset_id))),
    CONSTRAINT profile_avatar_realm_check CHECK ((realm = ANY (ARRAY['user'::text, 'admin'::text]))),
    CONSTRAINT profile_avatar_revision_check CHECK ((revision > 0)),
    CONSTRAINT profile_avatar_subject_id_check CHECK ((subject_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'::text))
);


--
-- Name: rental_account; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.rental_account (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    game_id text NOT NULL,
    display_no text,
    lifecycle text DEFAULT 'ACTIVE'::text NOT NULL,
    owner_paused boolean DEFAULT false NOT NULL,
    staff_restricted boolean DEFAULT false NOT NULL,
    restriction_reason text,
    current_version_id text,
    legacy_hold text DEFAULT 'NONE'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rental_account_legacy_hold_check CHECK ((legacy_hold = ANY (ARRAY['NONE'::text, 'UNRESOLVED'::text, 'ACTIVE_LEGACY'::text]))),
    CONSTRAINT rental_account_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text]))),
    CONSTRAINT rental_account_restriction_reason CHECK (((NOT staff_restricted) OR (restriction_reason IS NOT NULL))),
    CONSTRAINT rental_account_revision_check CHECK ((revision > 0))
);


--
-- Name: review_decision; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.review_decision (
    id text NOT NULL,
    version_id text NOT NULL,
    release_id text NOT NULL,
    content_hash text NOT NULL,
    decision text NOT NULL,
    reason text NOT NULL,
    reviewer_admin_id text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_decision_decision_check CHECK ((decision = ANY (ARRAY['APPROVE'::text, 'REJECT'::text]))),
    CONSTRAINT review_decision_reason_check CHECK (((length(reason) >= 2) AND (length(reason) <= 500)))
);


--
-- Name: rule_acceptance; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.rule_acceptance (
    id text NOT NULL,
    owner_user_id text NOT NULL,
    account_id text NOT NULL,
    listing_version_id text NOT NULL,
    rule_release_id text NOT NULL,
    accepted_content_hash text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    full_payout_terms_version_id text,
    full_payout_terms_digest text,
    full_payout_disclosure_version text,
    acceptance_kind text DEFAULT 'OWNER_ACCEPTED'::text NOT NULL,
    authorization_evidence jsonb,
    CONSTRAINT legacy_acceptance_shape CHECK (((((acceptance_kind = 'OWNER_ACCEPTED'::text) AND (authorization_evidence IS NULL)) OR ((acceptance_kind = 'LEGACY_TAKEOVER_AUTHORIZED'::text) AND (jsonb_typeof(authorization_evidence) = 'object'::text) AND (full_payout_terms_version_id IS NULL) AND (full_payout_terms_digest IS NULL) AND (full_payout_disclosure_version IS NULL))) IS TRUE)),
    CONSTRAINT rule_acceptance_acceptance_kind_check CHECK ((acceptance_kind = ANY (ARRAY['OWNER_ACCEPTED'::text, 'LEGACY_TAKEOVER_AUTHORIZED'::text]))),
    CONSTRAINT rule_acceptance_accepted_content_hash_check CHECK ((accepted_content_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT rule_acceptance_full_payout_shape CHECK ((((full_payout_terms_version_id IS NULL) AND (full_payout_terms_digest IS NULL) AND (full_payout_disclosure_version IS NULL)) OR ((full_payout_terms_version_id IS NOT NULL) AND (full_payout_terms_digest IS NOT NULL) AND (full_payout_terms_digest ~ '^[0-9a-f]{64}$'::text) AND (full_payout_disclosure_version IS NOT NULL) AND (btrim(full_payout_disclosure_version) <> ''::text))))
);


--
-- Name: rule_release; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.rule_release (
    id text NOT NULL,
    game_id text NOT NULL,
    price_version_id text NOT NULL,
    term_version_id text NOT NULL,
    agreement_version_id text NOT NULL,
    generation bigint NOT NULL,
    activated_by_admin_id text NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rule_release_generation_check CHECK ((generation > 0))
);


--
-- Name: skin; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.skin (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    category_id text NOT NULL,
    rarity_code text,
    enabled boolean DEFAULT false NOT NULL,
    form_visible boolean DEFAULT false NOT NULL,
    media_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    source_field text,
    source_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_kind text,
    owner_id text,
    firearm_id text,
    base_name text,
    aliases text[] DEFAULT ARRAY[]::text[] NOT NULL,
    source_namespace text,
    naming_state text DEFAULT 'PENDING'::text NOT NULL,
    rarity_evidence jsonb,
    is_collectible boolean,
    default_state text DEFAULT 'UNKNOWN'::text NOT NULL,
    media_source jsonb,
    CONSTRAINT skin_aliases_valid CHECK (zzsh_supply.skin_aliases_valid(aliases)),
    CONSTRAINT skin_base_name_valid CHECK (((base_name IS NULL) OR zzsh_supply.skin_text_valid(base_name, 120, true))),
    CONSTRAINT skin_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT skin_default_state_valid CHECK ((default_state = ANY (ARRAY['UNKNOWN'::text, 'DEFAULT'::text, 'NON_DEFAULT'::text]))),
    CONSTRAINT skin_media_source_shape CHECK (((media_source IS NULL) OR (((media_id IS NOT NULL) AND (jsonb_typeof(media_source) = 'object'::text) AND (media_source ?& ARRAY['schema'::text, 'kind'::text, 'sourceName'::text, 'url'::text]) AND ((media_source - ARRAY['schema'::text, 'kind'::text, 'sourceName'::text, 'url'::text]) = '{}'::jsonb) AND ((media_source ->> 'schema'::text) = 'skin-media-source-v1'::text) AND ((media_source ->> 'kind'::text) = ANY (ARRAY['PORTRAIT_CARD'::text, 'MODEL_IMAGE'::text, 'PROMO_POSTER'::text])) AND (jsonb_typeof((media_source -> 'sourceName'::text)) = 'string'::text) AND ((length(btrim((media_source ->> 'sourceName'::text))) >= 1) AND (length(btrim((media_source ->> 'sourceName'::text))) <= 100)) AND (jsonb_typeof((media_source -> 'url'::text)) = 'string'::text) AND ((length((media_source ->> 'url'::text)) >= 1) AND (length((media_source ->> 'url'::text)) <= 2000)) AND ((media_source ->> 'url'::text) ~ '^https://[^[:space:]]+$'::text)) IS TRUE))),
    CONSTRAINT skin_name_valid CHECK (zzsh_supply.skin_text_valid(name, 120, true)),
    CONSTRAINT skin_naming_state_shape CHECK (((((naming_state = ANY (ARRAY['LEGACY'::text, 'PENDING'::text])) AND (owner_kind IS NULL) AND (base_name IS NULL)) OR ((naming_state = 'VERIFIED'::text) AND (owner_kind IS NOT NULL) AND (base_name IS NOT NULL))) IS TRUE)),
    CONSTRAINT skin_owner_shape CHECK (((((owner_kind IS NULL) AND (owner_id IS NULL) AND (firearm_id IS NULL)) OR ((owner_kind = 'AGENT'::text) AND (owner_id IS NOT NULL) AND (firearm_id IS NULL)) OR ((owner_kind = 'MELEE_TYPE'::text) AND (firearm_id IS NULL)) OR ((owner_kind = 'FIREARM'::text) AND (owner_id IS NULL) AND (firearm_id IS NOT NULL))) IS TRUE)),
    CONSTRAINT skin_pending_disabled CHECK (((naming_state <> 'PENDING'::text) OR ((NOT enabled) AND (NOT form_visible)))),
    CONSTRAINT skin_rarity_evidence_shape CHECK (((rarity_evidence IS NULL) OR (((rarity_code IS NOT NULL) AND (jsonb_typeof(rarity_evidence) = 'object'::text) AND (rarity_evidence ?& ARRAY['schema'::text, 'basis'::text, 'sourceName'::text, 'references'::text]) AND ((rarity_evidence - ARRAY['schema'::text, 'basis'::text, 'sourceName'::text, 'references'::text]) = '{}'::jsonb) AND ((rarity_evidence ->> 'schema'::text) = 'skin-rarity-evidence-v1'::text) AND ((rarity_evidence ->> 'basis'::text) = ANY (ARRAY['PLATFORM_REFERENCE'::text, 'OFFICIAL'::text])) AND (jsonb_typeof((rarity_evidence -> 'sourceName'::text)) = 'string'::text) AND ((length(btrim((rarity_evidence ->> 'sourceName'::text))) >= 1) AND (length(btrim((rarity_evidence ->> 'sourceName'::text))) <= 100)) AND
CASE
    WHEN (jsonb_typeof((rarity_evidence -> 'references'::text)) = 'array'::text) THEN ((jsonb_array_length((rarity_evidence -> 'references'::text)) >= 1) AND (jsonb_array_length((rarity_evidence -> 'references'::text)) <= 8))
    ELSE false
END) IS TRUE))),
    CONSTRAINT skin_source_field_valid CHECK (((source_field IS NULL) OR zzsh_supply.skin_text_valid(source_field, 64, true))),
    CONSTRAINT skin_source_namespace_valid CHECK (((source_namespace IS NULL) OR zzsh_supply.skin_text_valid(source_namespace, 64, true))),
    CONSTRAINT skin_source_shape CHECK (((((source_namespace IS NULL) AND (source_field IS NULL) AND (source_token IS NULL)) OR ((naming_state = 'LEGACY'::text) AND (source_namespace IS NULL) AND (source_field IS NOT NULL) AND (source_token IS NOT NULL)) OR ((source_namespace IS NOT NULL) AND (source_field IS NOT NULL) AND (source_token IS NOT NULL))) IS TRUE)),
    CONSTRAINT skin_source_token_valid CHECK (((source_token IS NULL) OR zzsh_supply.skin_text_valid(source_token, 200, false)))
);


--
-- Name: skin_category; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.skin_category (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    parent_id text,
    sort_order integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    form_visible boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skin_category_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT skin_category_not_self CHECK (((parent_id IS NULL) OR (parent_id <> id)))
);


--
-- Name: skin_owner; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.skin_owner (
    id text NOT NULL,
    game_id text NOT NULL,
    kind text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT skin_owner_code_check CHECK ((((char_length(code) >= 2) AND (char_length(code) <= 64)) AND (code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text))),
    CONSTRAINT skin_owner_id_check CHECK (zzsh_supply.skin_text_valid(id, 128, true)),
    CONSTRAINT skin_owner_kind_check CHECK ((kind = ANY (ARRAY['AGENT'::text, 'MELEE_TYPE'::text]))),
    CONSTRAINT skin_owner_name_check CHECK (zzsh_supply.skin_text_valid(name, 120, true))
);


--
-- Name: skin_rarity; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.skin_rarity (
    id text NOT NULL,
    game_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skin_rarity_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text))
);


--
-- Name: term_option; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.term_option (
    id text NOT NULL,
    version_id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    daily_consumption numeric(24,0) NOT NULL,
    duration_rounding text DEFAULT 'CEIL_DAY'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_option_code_format CHECK ((code ~ '^[a-z][a-z0-9_:-]{1,63}$'::text)),
    CONSTRAINT term_option_daily_consumption_check CHECK ((daily_consumption > (0)::numeric)),
    CONSTRAINT term_option_duration_rounding_check CHECK ((duration_rounding = 'CEIL_DAY'::text))
);


--
-- Name: term_version; Type: TABLE; Schema: zzsh_supply; Owner: -
--

CREATE TABLE zzsh_supply.term_version (
    id text NOT NULL,
    game_id text NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_admin_id text NOT NULL,
    sealed_by_admin_id text,
    sealed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_version_revision_check CHECK ((revision > 0)),
    CONSTRAINT term_version_sealed_shape CHECK (((status = 'DRAFT'::text) OR ((sealed_at IS NOT NULL) AND (sealed_by_admin_id IS NOT NULL)))),
    CONSTRAINT term_version_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'SEALED'::text])))
);


--
-- Name: admin_auth_failure id; Type: DEFAULT; Schema: zzsh_iam; Owner: -
--

ALTER TABLE ONLY zzsh_iam.admin_auth_failure ALTER COLUMN id SET DEFAULT nextval('zzsh_iam.admin_auth_failure_id_seq'::regclass);


--
-- PostgreSQL database dump complete
--


