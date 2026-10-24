-- 未编号前向候选；唯一父序为已接受G3完整fixture→本G4，未授权任何实际安装。
-- 第一条语句只读目录；缺父包、部分部署或父守卫漂移必须在本文件DDL前停。
DO $$
DECLARE x record;name text;definition text;
BEGIN
 FOREACH name IN ARRAY ARRAY['zzsh_order.channel_refund_intent','zzsh_order.joinpay_refund_attempt',
  'zzsh_order.joinpay_refund_observation','zzsh_order.joinpay_refund_evidence','zzsh_order.finance_economic_root',
  'zzsh_order.finance_event','zzsh_order.settlement_ledger_entry','zzsh_order.wallet_coverage','zzsh_order.wallet_revision'] LOOP
  IF to_regclass(name) IS NULL THEN RAISE EXCEPTION 'G4 requires complete accepted G3 parent: %',name USING ERRCODE='55000';END IF;
 END LOOP;
 FOR x IN SELECT * FROM(VALUES
  ('zzsh_order.guard_controlled_channel_refund_intent_v1()','1214c9caa05138d90340c7936c607f8bd6f6396b4505d57cc245f0c43e96563d'),
  ('zzsh_order.guard_joinpay_refund_intent()','1d439d2eff9c7b39c6b06de380eb7161696f210f8afed9c2b959fe1fd450f1eb'),
  ('zzsh_order.assert_joinpay_refund_profile(text,text,text,text,zzsh_order.channel_refund_intent)','e8e362a3e9cf4fae1a4f720dc1d2bf1cf0a990e774de0b873293bf3306ee5f25'),
  ('zzsh_order.guard_joinpay_refund_attempt()','bc519429a8f57490b4a5c4cc5f7ce3c1e492af09621e1435c205a0ddbf6b8713'),
  ('zzsh_order.guard_joinpay_refund_observation()','51e78865a41b09cb48003b27e316c0798a6594f57fe3eb64fd94392241fa86cf'),
  ('zzsh_order.guard_joinpay_refund_evidence()','3e83ad5b2696fb5684ebfc2afcfd9c938f4b61c7e086e4488b6b4d6bbcfeb83e'),
  ('zzsh_order.guard_native_refund_root()','8d5bb7abd32f0a628f2097eab600641ec7e395475642da20cf5c46752a827716'),
  ('zzsh_order.guard_native_refund_event()','3d460333f024fd31dc4817aab14a64422e5695b986e44a2d0c0fa657b0d459bc'),
  ('zzsh_order.guard_native_refund_entry()','3a95c6fdbfb98e7ddb898a74dca9ea981c61392cba1594738395d480528f20de'),
  ('zzsh_order.native_refund_terminal_complete(text)','e259ec195f4064894025e80b69ff579a37d0276d684d1b6745cba4f899985633'),
  ('zzsh_order.check_native_refund_closure()','eacd4bf94a75495c8ee3aaaf5a464f1d14578316f2562708b59a43648d12eeaf')
 ) AS v(signature,digest) LOOP
  IF to_regprocedure(x.signature) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(x.signature)
   AND position(E'\r' IN replace(p.prosrc,E'\r\n',E'\n'))=0
   AND encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')=x.digest)
  THEN RAISE EXCEPTION 'accepted G3 function differs: %',x.signature USING ERRCODE='55000';END IF;
 END LOOP;
 FOR x IN SELECT * FROM(VALUES
  ('zzsh_order.channel_refund_intent','channel_refund_joinpay_write_guard','zzsh_order.guard_joinpay_refund_intent()',23,false),
  ('zzsh_order.channel_refund_intent','channel_refund_controlled_write_guard','zzsh_order.guard_controlled_channel_refund_intent_v1()',23,false),
  ('zzsh_order.channel_refund_intent','channel_refund_controlled_delete_guard','zzsh_order.guard_controlled_channel_refund_intent_v1()',11,false),
  ('zzsh_order.channel_refund_intent','channel_refund_joinpay_delete_guard','zzsh_order.guard_joinpay_refund_intent()',11,false),
  ('zzsh_order.joinpay_refund_attempt','joinpay_refund_attempt_guard','zzsh_order.guard_joinpay_refund_attempt()',7,false),
  ('zzsh_order.joinpay_refund_observation','joinpay_refund_observation_guard','zzsh_order.guard_joinpay_refund_observation()',7,false),
  ('zzsh_order.joinpay_refund_evidence','joinpay_refund_evidence_guard','zzsh_order.guard_joinpay_refund_evidence()',7,false),
  ('zzsh_order.joinpay_refund_attempt','joinpay_refund_attempt_immutable','zzsh_order.finance_immutable()',27,false),
  ('zzsh_order.joinpay_refund_observation','joinpay_refund_observation_immutable','zzsh_order.finance_immutable()',27,false),
  ('zzsh_order.joinpay_refund_evidence','joinpay_refund_evidence_immutable','zzsh_order.finance_immutable()',27,false),
  ('zzsh_order.finance_economic_root','native_refund_root_guard','zzsh_order.guard_native_refund_root()',7,false),
  ('zzsh_order.finance_event','native_refund_event_guard','zzsh_order.guard_native_refund_event()',7,false),
  ('zzsh_order.settlement_ledger_entry','native_refund_entry_guard','zzsh_order.guard_native_refund_entry()',7,false),
  ('zzsh_order.settlement_ledger_entry','finance_entry_guard','zzsh_order.guard_finance_entry()',7,false),
  ('zzsh_order.settlement_ledger_entry','finance_entry_batch_guard','zzsh_order.check_finance_batch()',5,true),
  ('zzsh_order.finance_event','native_refund_wallet_revision','zzsh_order.withdrawal_wallet_revision()',5,false),
  ('zzsh_order.channel_refund_intent','native_refund_intent_closure','zzsh_order.check_native_refund_closure()',21,true),
  ('zzsh_order.joinpay_refund_evidence','native_refund_evidence_closure','zzsh_order.check_native_refund_closure()',5,true),
  ('zzsh_order.joinpay_refund_observation','native_refund_observation_closure','zzsh_order.check_native_refund_closure()',5,true),
  ('zzsh_order.finance_economic_root','native_refund_root_closure','zzsh_order.check_native_refund_closure()',5,true),
  ('zzsh_order.finance_event','native_refund_event_closure','zzsh_order.check_native_refund_closure()',5,true),
  ('zzsh_order.settlement_ledger_entry','native_refund_entry_closure','zzsh_order.check_native_refund_closure()',5,true)
 ) AS v(table_name,trigger_name,signature,type_bits,is_deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(x.table_name) AND t.tgname=x.trigger_name
   AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgfoid=to_regprocedure(x.signature) AND t.tgtype=x.type_bits
   AND t.tgdeferrable=x.is_deferred AND t.tginitdeferred=x.is_deferred)
  THEN RAISE EXCEPTION 'accepted G3 trigger differs: %',x.trigger_name USING ERRCODE='55000';END IF;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['channel_refund_source_shape','channel_refund_budget_shape','channel_refund_claim_shape',
  'joinpay_refund_terminal_evidence_fk','joinpay_refund_terminal_root_fk','joinpay_refund_terminal_event_fk'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname=name AND convalidated)
  THEN RAISE EXCEPTION 'accepted G3 intent constraint missing: %',name USING ERRCODE='55000';END IF;
 END LOOP;
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='zzsh_order.finance_economic_root'::regclass AND conname='finance_root_enabled_source_shape' AND convalidated;
 IF definition IS NULL OR position('NATIVE_RENTAL_REFUND' IN definition)=0
 THEN RAISE EXCEPTION 'accepted G3 refund root gate missing' USING ERRCODE='55000';END IF;
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='zzsh_order.finance_event'::regclass AND conname='finance_event_kind_check' AND convalidated;
 IF definition IS NULL OR position('REFUND_PAID' IN definition)=0
 THEN RAISE EXCEPTION 'accepted G3 refund event gate missing' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='zzsh_order.joinpay_refund_observation'::regclass AND convalidated
   AND pg_get_constraintdef(oid) LIKE '%raw_sha256 IS NOT NULL%')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='zzsh_order.joinpay_refund_observation'::regclass AND convalidated
   AND pg_get_constraintdef(oid) LIKE '%lease_version IS NOT NULL%')
 THEN RAISE EXCEPTION 'accepted G3 nullable raw/lease guard missing' USING ERRCODE='55000';END IF;
 FOREACH name IN ARRAY ARRAY['finance_entry_guard','finance_entry_batch_guard'] LOOP
  SELECT substring(pg_get_triggerdef(oid) FROM ' WHEN \((.*)\) EXECUTE FUNCTION ') INTO definition FROM pg_trigger WHERE tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND tgname=name AND tgnargs=0;
  IF definition IS NULL OR position('intentId' IN definition)=0 OR position('earningId' IN definition)=0
   OR position('guaranteeId' IN definition)=0 OR position('legacyDutyId' IN definition)=0 OR position('nativeRefundIntentId' IN definition)=0
  THEN RAISE EXCEPTION 'accepted G3 generic namespace gate missing: %',name USING ERRCODE='55000';END IF;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['zzsh_order.joinpay_withdrawal_intent','zzsh_order.joinpay_payout_attempt',
  'zzsh_order.joinpay_payout_observation','zzsh_order.joinpay_payout_evidence'] LOOP
  IF to_regclass(name) IS NOT NULL THEN RAISE EXCEPTION 'G4 already or partially installed: %',name USING ERRCODE='55000';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE action IN('joinpay.withdrawal.reserved','joinpay.withdrawal.paid','joinpay.withdrawal.released','joinpay.payout.claimed','joinpay.payout.observed'))
 THEN RAISE EXCEPTION 'G4 audit exists without complete G4 installation' USING ERRCODE='55000';END IF;
END $$;

CREATE TABLE zzsh_order.joinpay_withdrawal_intent (
 id text PRIMARY KEY CHECK(id~'^jwd_[a-f0-9]{40}$'),user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 payout_key text NOT NULL UNIQUE CHECK(length(payout_key) BETWEEN 1 AND 128),request_fingerprint text NOT NULL CHECK(request_fingerprint~'^[a-f0-9]{64}$'),
 policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 128),destination_id text NOT NULL CHECK(length(destination_id) BETWEEN 1 AND 128),
 destination_revision text NOT NULL CHECK(length(destination_revision) BETWEEN 1 AND 128),
 gross_cents numeric NOT NULL CHECK(gross_cents=trunc(gross_cents) AND gross_cents>0 AND gross_cents<=999999999999999999999999),
 net_cents numeric NOT NULL CHECK(net_cents=trunc(net_cents) AND net_cents>0 AND net_cents<=9999999999999999),
 fee_cents numeric NOT NULL CHECK(fee_cents=trunc(fee_cents) AND fee_cents>=0),currency text NOT NULL CHECK(currency='CNY'),
 expected_ledger_revision bigint NOT NULL CHECK(expected_ledger_revision>=0),
 coverage_canonical text NOT NULL CHECK(octet_length(coverage_canonical) BETWEEN 2 AND 16384),
 coverage_sha256 text NOT NULL CHECK(coverage_sha256=encode(sha256(convert_to(coverage_canonical,'UTF8')),'hex')),
 coverage_version text NOT NULL CHECK(coverage_version~'^[1-9][0-9]*$'),covered_set_digest text NOT NULL CHECK(covered_set_digest~'^[a-f0-9]{64}$'),
 merchant_identity_id text NOT NULL CHECK(length(merchant_identity_id) BETWEEN 1 AND 128),
 user_no text NOT NULL CHECK(user_no~'^[0-9]{1,32}$' AND user_no<>'888100000002340'),trade_merchant_no text CHECK(length(trade_merchant_no) BETWEEN 1 AND 128),
 merchant_order_no text NOT NULL CHECK(merchant_order_no~'^[A-Za-z0-9]{12,25}$'),
 receiver_account_no_enc text NOT NULL CHECK(octet_length(receiver_account_no_enc) BETWEEN 1 AND 8192),
 receiver_name_enc text NOT NULL CHECK(octet_length(receiver_name_enc) BETWEEN 1 AND 8192),
 target_fingerprint text NOT NULL CHECK(target_fingerprint~'^[a-f0-9]{64}$'),admission_ref text NOT NULL CHECK(length(admission_ref) BETWEEN 1 AND 512),
 admission_sha256 text NOT NULL CHECK(admission_sha256=encode(sha256(convert_to(admission_canonical,'UTF8')),'hex')),
 admission_canonical text NOT NULL CHECK(octet_length(admission_canonical) BETWEEN 2 AND 131072),
 scope_ref text NOT NULL CHECK(length(scope_ref) BETWEEN 1 AND 512),scope_sha256 text NOT NULL CHECK(scope_sha256=encode(sha256(convert_to(scope_canonical,'UTF8')),'hex')),
 scope_canonical text NOT NULL CHECK(octet_length(scope_canonical) BETWEEN 2 AND 131072),
 initial_profile_id text NOT NULL CHECK(length(initial_profile_id) BETWEEN 1 AND 128),initial_profile_sha256 text NOT NULL CHECK(initial_profile_sha256=encode(sha256(convert_to(initial_profile_canonical,'UTF8')),'hex')),
 initial_profile_canonical text NOT NULL CHECK(octet_length(initial_profile_canonical) BETWEEN 2 AND 131072),initial_key_version_ref text NOT NULL CHECK(length(initial_key_version_ref) BETWEEN 1 AND 128),
 frozen_canonical text NOT NULL CHECK(octet_length(frozen_canonical) BETWEEN 2 AND 131072),
 frozen_digest text NOT NULL CHECK(frozen_digest=encode(sha256(convert_to(frozen_canonical,'UTF8')),'hex')),
 economic_root_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 reserve_event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 state text NOT NULL DEFAULT 'RESERVED' CHECK(state IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','SUCCEEDED','FAILED')),
 operation_version bigint NOT NULL DEFAULT 1 CHECK(operation_version>0),
 funds_disposition text NOT NULL DEFAULT 'RESERVED' CHECK(funds_disposition IN('RESERVED','PAYOUT_POSTED','RELEASE_POSTED')),
 lease_version bigint NOT NULL DEFAULT 0 CHECK(lease_version>=0),lease_owner text CHECK(length(lease_owner) BETWEEN 1 AND 128),lease_until timestamptz,
 requires_review boolean NOT NULL DEFAULT false,terminal_evidence_id text,terminal_event_id text REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 platform_serial_no text CHECK(length(platform_serial_no) BETWEEN 1 AND 128),provider_fee_raw text CHECK(octet_length(provider_fee_raw)<=128),provider_fee_cents numeric CHECK(provider_fee_cents=trunc(provider_fee_cents) AND provider_fee_cents>=0),
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(merchant_identity_id,merchant_order_no),UNIQUE(id,user_id),CHECK(gross_cents=net_cents+fee_cents),
 CHECK(state<>'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE' OR platform_serial_no IS NOT NULL),
 CHECK((state='RESERVED' AND lease_version=0 AND lease_owner IS NULL AND lease_until IS NULL)
  OR(state<>'RESERVED' AND lease_version>0 AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
 CONSTRAINT joinpay_withdrawal_disposition_shape CHECK((
  (state NOT IN('SUCCEEDED','FAILED') AND funds_disposition='RESERVED'
   AND num_nonnulls(terminal_evidence_id,terminal_event_id,provider_fee_raw,provider_fee_cents)=0)
  OR(state='SUCCEEDED' AND funds_disposition='PAYOUT_POSTED' AND num_nonnulls(terminal_evidence_id,terminal_event_id,platform_serial_no,provider_fee_raw,provider_fee_cents)=5)
  OR(state='FAILED' AND funds_disposition='RELEASE_POSTED' AND num_nonnulls(terminal_evidence_id,terminal_event_id,platform_serial_no,provider_fee_raw,provider_fee_cents)=5)
 ) IS TRUE)
);
CREATE UNIQUE INDEX joinpay_withdrawal_platform_once ON zzsh_order.joinpay_withdrawal_intent(merchant_identity_id,platform_serial_no)
 WHERE platform_serial_no IS NOT NULL;

CREATE TABLE zzsh_order.joinpay_payout_attempt (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.joinpay_withdrawal_intent(id),
 operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY')),lease_version bigint NOT NULL CHECK(lease_version>0),lease_owner text NOT NULL CHECK(length(lease_owner) BETWEEN 1 AND 128),
 profile_id text NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 128),profile_canonical text NOT NULL CHECK(octet_length(profile_canonical) BETWEEN 2 AND 131072),
 profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),key_version_ref text NOT NULL,
 scope_canonical text NOT NULL CHECK(octet_length(scope_canonical) BETWEEN 2 AND 131072),
 scope_sha256 text NOT NULL CHECK(scope_sha256=encode(sha256(convert_to(scope_canonical,'UTF8')),'hex')),
 request_body bytea NOT NULL CHECK(octet_length(request_body) BETWEEN 1 AND 65536),request_sha256 text NOT NULL CHECK(request_sha256=encode(sha256(request_body),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,lease_version),UNIQUE(id,intent_id)
);
CREATE UNIQUE INDEX joinpay_payout_submit_once ON zzsh_order.joinpay_payout_attempt(intent_id) WHERE operation='SUBMIT';

CREATE TABLE zzsh_order.joinpay_payout_observation (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.joinpay_withdrawal_intent(id),attempt_id text,
 operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY','NOTIFY')),lease_version bigint,lease_owner text,
 profile_id text NOT NULL,profile_canonical text NOT NULL CHECK(octet_length(profile_canonical) BETWEEN 2 AND 131072),
 profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),key_version_ref text NOT NULL,
 raw_body bytea CHECK(octet_length(raw_body)<=65536),raw_sha256 text,response_complete boolean NOT NULL,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),received_bytes bigint NOT NULL CHECK(received_bytes>=0),transport_failure text,
 event text NOT NULL CHECK(event IN('UNKNOWN','PROCESSING','PENDING_TERMINAL','REVIEW','STALE','TERMINAL')),
 schema_status text NOT NULL,signature_status text NOT NULL,binding_status text NOT NULL,
 evidence_level text NOT NULL CHECK(evidence_level IN('PROVIDER_RESPONSE','SYNTHETIC_PROTOCOL')),state_before text NOT NULL,state_after text NOT NULL,request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 180),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,intent_id),
 FOREIGN KEY(attempt_id,intent_id) REFERENCES zzsh_order.joinpay_payout_attempt(id,intent_id),
 CHECK((raw_body IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_sha256=encode(sha256(raw_body),'hex'))
  OR(raw_body IS NULL AND raw_sha256 IS NULL AND NOT response_complete)),
 CHECK(received_bytes>=COALESCE(octet_length(raw_body),0)),
 CHECK(NOT response_complete OR(raw_body IS NOT NULL AND received_bytes=octet_length(raw_body)
  AND((operation='NOTIFY' AND http_status IS NULL) OR(operation<>'NOTIFY' AND http_status IS NOT NULL)))),
 CHECK((operation='NOTIFY' AND attempt_id IS NULL AND lease_version IS NULL AND lease_owner IS NULL AND http_status IS NULL)
  OR(operation IN('SUBMIT','QUERY') AND attempt_id IS NOT NULL AND lease_version IS NOT NULL AND lease_version>0 AND lease_owner IS NOT NULL)),
 CHECK(state_before IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','SUCCEEDED','FAILED')
  AND state_after IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','SUCCEEDED','FAILED')),
 CHECK(event NOT IN('STALE','PENDING_TERMINAL','TERMINAL') OR state_before=state_after)
);

CREATE TABLE zzsh_order.joinpay_payout_evidence (
 id text PRIMARY KEY,intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.joinpay_withdrawal_intent(id),observation_id text NOT NULL UNIQUE,
 operation text NOT NULL CHECK(operation IN('QUERY','NOTIFY')),terminal text NOT NULL CHECK(terminal IN('PAID','UNPAID_CONFIRMED')),
 platform_serial_no text NOT NULL CHECK(length(platform_serial_no) BETWEEN 1 AND 128),
 provider_fee_raw text NOT NULL CHECK(octet_length(provider_fee_raw)<=128 AND provider_fee_raw~'^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'),
 provider_fee_cents numeric NOT NULL CHECK(provider_fee_cents=trunc(provider_fee_cents) AND provider_fee_cents>=0),
 facts_canonical text NOT NULL CHECK(octet_length(facts_canonical) BETWEEN 2 AND 16384),
 facts_digest text NOT NULL CHECK(facts_digest=encode(sha256(convert_to(facts_canonical,'UTF8')),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,intent_id),FOREIGN KEY(observation_id,intent_id) REFERENCES zzsh_order.joinpay_payout_observation(id,intent_id)
);
ALTER TABLE zzsh_order.joinpay_withdrawal_intent ADD CONSTRAINT joinpay_withdrawal_terminal_evidence_fk
 FOREIGN KEY(terminal_evidence_id,id) REFERENCES zzsh_order.joinpay_payout_evidence(id,intent_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION zzsh_order.assert_joinpay_payout_scope(canonical text,digest text,op text,pid text,profile_digest text,key_ref text,i zzsh_order.joinpay_withdrawal_intent)
RETURNS void LANGUAGE plpgsql AS $$
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
END $$;

CREATE FUNCTION zzsh_order.assert_joinpay_payout_profile(canonical text,op text,pid text,key_ref text,i zzsh_order.joinpay_withdrawal_intent)
RETURNS void LANGUAGE plpgsql AS $$
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
END $$;

CREATE FUNCTION zzsh_order.assert_joinpay_withdrawal_admission(i zzsh_order.joinpay_withdrawal_intent,new_reservation boolean)
RETURNS void LANGUAGE plpgsql AS $$
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
END $$;

CREATE FUNCTION zzsh_order.joinpay_payout_raw_data(o zzsh_order.joinpay_payout_observation) RETURNS jsonb LANGUAGE plpgsql AS $$
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

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER joinpay_withdrawal_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.joinpay_withdrawal_intent
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_intent();

CREATE FUNCTION zzsh_order.guard_joinpay_payout_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_payout_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_payout_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_attempt();

CREATE FUNCTION zzsh_order.guard_joinpay_payout_observation() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_payout_observation_guard BEFORE INSERT ON zzsh_order.joinpay_payout_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_observation();

CREATE FUNCTION zzsh_order.guard_joinpay_payout_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER joinpay_payout_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_payout_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_payout_evidence();
CREATE TRIGGER joinpay_payout_attempt_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_payout_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER joinpay_payout_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_payout_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER joinpay_payout_evidence_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_payout_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

-- 保留父G3完整root/kind白名单，旧CONTROLLED、分佣、保证金、legacy、refund守卫不改。
ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
  OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE','LEGACY_CONTINUATION_DUTY','NATIVE_RENTAL_REFUND','JOINPAY_WITHDRAWAL') AND basis_id IS NULL));
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED',
  'GUARANTEE_CAPTURE','GUARANTEE_REFUND','LEGACY_DUTY_SETTLED','REFUND_PAID','JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID','JOINPAY_WITHDRAWAL_RELEASED'));

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_root() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_withdrawal_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root
 FOR EACH ROW WHEN(NEW.source_kind='JOINPAY_WITHDRAWAL') EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_root();

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_withdrawal_event_guard BEFORE INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind IN('JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID','JOINPAY_WITHDRAWAL_RELEASED'))
 EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_event();

CREATE FUNCTION zzsh_order.joinpay_withdrawal_expected_lines(event_id_value text)
RETURNS TABLE(line_no integer,account_code text,debit_cents numeric,credit_cents numeric,counterparty_user_id text) LANGUAGE sql STABLE AS $$
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

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_withdrawal_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry
 FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'joinpayWithdrawalIntentId') EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_entry();
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId'))
 EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId'))
 EXECUTE FUNCTION zzsh_order.check_finance_batch();
CREATE TRIGGER joinpay_withdrawal_wallet_revision AFTER INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind IN('JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID','JOINPAY_WITHDRAWAL_RELEASED'))
 EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();
CREATE TRIGGER joinpay_withdrawal_read_revision AFTER UPDATE ON zzsh_order.joinpay_withdrawal_intent
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_read_revision();
CREATE FUNCTION zzsh_order.joinpay_payout_observation_read_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject_id text;
BEGIN
 SELECT user_id INTO subject_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=NEW.intent_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_id FOR UPDATE;
 UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=subject_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'payout observation revision unavailable' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER joinpay_payout_observation_read_revision AFTER INSERT ON zzsh_order.joinpay_payout_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.joinpay_payout_observation_read_revision();

CREATE FUNCTION zzsh_order.guard_joinpay_withdrawal_audit() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER joinpay_withdrawal_audit_guard BEFORE INSERT ON zzsh_iam.audit_event FOR EACH ROW
 WHEN(NEW.action IN('joinpay.withdrawal.reserved','joinpay.withdrawal.paid','joinpay.withdrawal.released','joinpay.payout.claimed','joinpay.payout.observed'))
 EXECUTE FUNCTION zzsh_order.guard_joinpay_withdrawal_audit();
CREATE UNIQUE INDEX joinpay_withdrawal_money_audit_once ON zzsh_iam.audit_event(object_id,action)
 WHERE action IN('joinpay.withdrawal.reserved','joinpay.withdrawal.paid','joinpay.withdrawal.released');
CREATE UNIQUE INDEX joinpay_payout_claim_audit_once ON zzsh_iam.audit_event((details->>'attemptId')) WHERE action='joinpay.payout.claimed';
CREATE UNIQUE INDEX joinpay_payout_observed_audit_once ON zzsh_iam.audit_event((details->>'observationId')) WHERE action='joinpay.payout.observed';

CREATE FUNCTION zzsh_order.joinpay_withdrawal_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
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

CREATE FUNCTION zzsh_order.check_joinpay_withdrawal_closure() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_intent_closure AFTER INSERT OR UPDATE ON zzsh_order.joinpay_withdrawal_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_payout_attempt_closure AFTER INSERT ON zzsh_order.joinpay_payout_attempt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_payout_observation_closure AFTER INSERT ON zzsh_order.joinpay_payout_observation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_payout_evidence_closure AFTER INSERT ON zzsh_order.joinpay_payout_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_root_closure AFTER INSERT ON zzsh_order.finance_economic_root
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='JOINPAY_WITHDRAWAL') EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_event_closure AFTER INSERT ON zzsh_order.finance_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind IN('JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID','JOINPAY_WITHDRAWAL_RELEASED'))
 EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();
CREATE CONSTRAINT TRIGGER joinpay_withdrawal_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'joinpayWithdrawalIntentId')
 EXECUTE FUNCTION zzsh_order.check_joinpay_withdrawal_closure();

REVOKE ALL ON zzsh_order.joinpay_withdrawal_intent,zzsh_order.joinpay_payout_attempt,zzsh_order.joinpay_payout_observation,zzsh_order.joinpay_payout_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.assert_joinpay_payout_scope(text,text,text,text,text,text,zzsh_order.joinpay_withdrawal_intent),
 zzsh_order.assert_joinpay_payout_profile(text,text,text,text,zzsh_order.joinpay_withdrawal_intent),zzsh_order.assert_joinpay_withdrawal_admission(zzsh_order.joinpay_withdrawal_intent,boolean),
 zzsh_order.joinpay_payout_raw_data(zzsh_order.joinpay_payout_observation),zzsh_order.guard_joinpay_withdrawal_intent(),zzsh_order.guard_joinpay_payout_attempt(),
 zzsh_order.guard_joinpay_payout_observation(),zzsh_order.guard_joinpay_payout_evidence(),zzsh_order.guard_joinpay_withdrawal_root(),zzsh_order.guard_joinpay_withdrawal_event(),
 zzsh_order.guard_joinpay_withdrawal_entry(),zzsh_order.guard_joinpay_withdrawal_audit(),zzsh_order.joinpay_withdrawal_expected_lines(text),
 zzsh_order.joinpay_withdrawal_complete(text),zzsh_order.check_joinpay_withdrawal_closure(),zzsh_order.joinpay_payout_observation_read_revision() FROM PUBLIC;
-- runtime精确ACL hunk另交Admin：四表SELECT/业务列INSERT，intent仅CAS/lease/review/terminal列UPDATE。
-- 原件表不授UPDATE/DELETE；metadata不授写；wallet_revision仅SELECT；实际安装/编号/journal均NOT_RUN。

