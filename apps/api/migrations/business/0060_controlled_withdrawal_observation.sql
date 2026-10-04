-- C1 candidate. Original 0059 is immutable; notices never create a money event.
CREATE TABLE zzsh_order.controlled_payout_notice (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED_DECLARED_NOTICE'),
 source_system text NOT NULL CHECK(source_system='zzsh-local-declared-notification-v1'),
 source_event_key text NOT NULL CHECK(length(source_event_key) BETWEEN 1 AND 128),
 original_operation_id text NOT NULL REFERENCES zzsh_order.controlled_payout_operation(id),
 intent_id text NOT NULL,payout_key text NOT NULL,user_id text NOT NULL,
 evidence_canonical text NOT NULL CHECK(octet_length(evidence_canonical)<=4096),
 source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 approval_digest text NOT NULL CHECK(approval_digest~'^[0-9a-f]{64}$'),
 declared_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 declaration_reason text NOT NULL CHECK(length(btrim(declaration_reason)) BETWEEN 3 AND 500),
 declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_system,source_event_key),
 FOREIGN KEY(intent_id,payout_key) REFERENCES zzsh_order.withdrawal_intent(id,payout_key),
 FOREIGN KEY(intent_id,user_id) REFERENCES zzsh_order.withdrawal_intent(id,user_id),
 CHECK(source_digest=encode(sha256(convert_to(evidence_canonical,'UTF8')),'hex'))
);
CREATE TRIGGER controlled_notice_immutable BEFORE UPDATE OR DELETE ON zzsh_order.controlled_payout_notice
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_controlled_notice() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER controlled_notice_source_guard BEFORE INSERT ON zzsh_order.controlled_payout_notice
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_controlled_notice();
CREATE FUNCTION zzsh_order.controlled_notice_arrival_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=NEW.user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'notice wallet coverage missing' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION zzsh_order.controlled_notice_arrival_revision() FROM PUBLIC;
CREATE TRIGGER controlled_notice_arrival AFTER INSERT ON zzsh_order.controlled_payout_notice
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.controlled_notice_arrival_revision();
-- The existing append-only audit facility is the processing conclusion receipt.
CREATE UNIQUE INDEX controlled_notice_processed_once ON zzsh_iam.audit_event(object_id)
 WHERE action='controlled.withdrawal.notice.processed';
CREATE FUNCTION zzsh_order.guard_controlled_notice_conclusion() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER controlled_notice_conclusion_guard BEFORE INSERT ON zzsh_iam.audit_event
 FOR EACH ROW WHEN(NEW.action='controlled.withdrawal.notice.processed') EXECUTE FUNCTION zzsh_order.guard_controlled_notice_conclusion();
CREATE FUNCTION zzsh_order.controlled_notice_conclusion_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=(SELECT user_id FROM zzsh_order.controlled_payout_notice WHERE id=NEW.object_id);RETURN NULL;END $$;
REVOKE ALL ON FUNCTION zzsh_order.controlled_notice_conclusion_revision() FROM PUBLIC;
CREATE TRIGGER controlled_notice_conclusion_revision AFTER INSERT ON zzsh_iam.audit_event
 FOR EACH ROW WHEN(NEW.action='controlled.withdrawal.notice.processed') EXECUTE FUNCTION zzsh_order.controlled_notice_conclusion_revision();
-- A notice result cannot COMMIT alone; the same transaction must contain its exact conclusion.
CREATE FUNCTION zzsh_order.check_controlled_notice_result_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n zzsh_order.controlled_payout_notice;
BEGIN
 SELECT * INTO n FROM zzsh_order.controlled_payout_notice WHERE intent_id=NEW.intent_id
  AND 'controlled-notice-'||substr(encode(sha256(convert_to(id,'UTF8')),'hex'),1,48)=NEW.result_key;
 IF n.id IS NULL OR n.source_digest IS DISTINCT FROM NEW.evidence_digest OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='controlled.withdrawal.notice.processed' AND a.object_id=n.id
   AND a.details->>'sourceDigest'=n.source_digest AND a.details->>'providerFactId'=NEW.id AND a.details->>'resultKey'=NEW.result_key)
 THEN RAISE EXCEPTION 'notice result requires atomic source and conclusion receipt' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER controlled_notice_result_receipt_guard AFTER INSERT ON zzsh_order.withdrawal_provider_fact
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.result_key LIKE 'controlled-notice-%') EXECUTE FUNCTION zzsh_order.check_controlled_notice_result_receipt();
