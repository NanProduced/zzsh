-- Q integration source candidate 0076_finance_stored_opening. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/f-finance/implementation/finance-stored-opening.sql
-- Source SHA256 309b708944ec264a7a455eb3048f8a0bb1f826727c58d2602fc3c31ed0eb0565; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE TABLE zzsh_order.finance_stored_opening_review (
 basis_id text PRIMARY KEY REFERENCES zzsh_order.finance_opening_basis(id),
 body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),
 source_canonical text NOT NULL,input_canonical text NOT NULL,review_canonical text NOT NULL,
 review_digest text NOT NULL CHECK(review_digest~'^[a-f0-9]{64}$'),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER stored_opening_review_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_stored_opening_review FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_stored_opening_review() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER stored_opening_review_guard BEFORE INSERT ON zzsh_order.finance_stored_opening_review FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_stored_opening_review();

-- No one may append an observation admission after the opening transaction has sealed.
CREATE OR REPLACE FUNCTION zzsh_order.guard_observation_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_name text;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF current_user<>owner_name OR basis.user_id IS DISTINCT FROM NEW.user_id OR basis.source_system IS DISTINCT FROM NEW.source_system
  OR basis.source_id IS DISTINCT FROM NEW.legacy_user_id OR NEW.source_event_at>basis.source_cutoff OR basis.created_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'observation admission subject/cutoff/opening transaction mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION zzsh_order.check_stored_opening_observations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_stored_opening_review;b zzsh_order.finance_opening_basis;item jsonb;observed zzsh_order.personal_finance_observation;a zzsh_order.finance_observation_admission;actual_count bigint;matching_input bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=NEW.basis_id;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT count(*) INTO actual_count FROM zzsh_order.finance_observation_admission WHERE basis_id=NEW.basis_id;
 IF actual_count IS DISTINCT FROM (r.review_canonical::jsonb->>'observationCount')::int THEN RAISE EXCEPTION 'stored observation admission count mismatch' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(r.input_canonical::jsonb->'admissions') LOOP
  SELECT * INTO a FROM zzsh_order.finance_observation_admission WHERE basis_id=r.basis_id AND source_entity=item->>'sourceEntity' AND source_id=item->>'sourceId';
  SELECT * INTO observed FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=b.source_system AND source_entity=a.source_entity AND source_id=a.source_id;
  SELECT count(*) INTO matching_input FROM jsonb_array_elements(r.input_canonical::jsonb->'observations') v WHERE v=observed.snapshot;
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
CREATE CONSTRAINT TRIGGER stored_opening_observations_guard AFTER INSERT ON zzsh_order.finance_stored_opening_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_stored_opening_observations();
REVOKE ALL ON zzsh_order.finance_stored_opening_review FROM PUBLIC;
-- Trusted maintenance owner only INSERT; runtime SELECT projection only, no INSERT/UPDATE/DELETE.

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.guard_stored_opening_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_stored_opening_observations() FROM PUBLIC;
