-- Test-only controlled withdrawal; no JOINPAY payout or bank operation is created.
DO $guard$
DECLARE d record;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(db.oid,'pg_database') AS marker INTO d FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test-demo-finance:v1' OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
  OR d.owner<>current_user OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL THEN RAISE EXCEPTION 'Exact demo resource required';END IF;
END $guard$;
DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['zzsh_order.check_sandbox_withdrawal_target_receipt()','zzsh_order.check_withdrawal_batch()','zzsh_order.check_withdrawal_intent_consistency()','zzsh_order.guard_controlled_operation()','zzsh_order.guard_sandbox_withdrawal_admission()','zzsh_order.guard_sandbox_withdrawal_destination()','zzsh_order.guard_sandbox_withdrawal_intent()','zzsh_order.guard_sandbox_withdrawal_original_provider()','zzsh_order.guard_withdrawal_entry()','zzsh_order.guard_withdrawal_event()','zzsh_order.guard_withdrawal_fact()','zzsh_order.guard_withdrawal_intent()','zzsh_order.guard_withdrawal_referral_recovery()','zzsh_order.guard_withdrawal_root()','zzsh_order.withdrawal_expected_lines(text)']) AS names(signature) WHERE to_regprocedure(signature) IS NOT NULL) THEN RAISE EXCEPTION 'Existing withdrawal function cannot be replaced';END IF;END $guard$;
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
    sandbox_registration_ref text,
    CONSTRAINT withdrawal_admission_check CHECK ((expires_at > admitted_at)),
    CONSTRAINT withdrawal_admission_max_gross_cents_check CHECK ((max_gross_cents > (0)::numeric)),
    CONSTRAINT withdrawal_admission_max_intents_check CHECK (((max_intents >= 1) AND (max_intents <= 2))),
    CONSTRAINT withdrawal_admission_per_intent_cents_check CHECK (((per_intent_cents >= (200)::numeric) AND (per_intent_cents <= (1000000)::numeric))),
    CONSTRAINT withdrawal_admission_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500))),
    CONSTRAINT withdrawal_admission_revision_check CHECK ((revision > 0)),
    CONSTRAINT withdrawal_admission_scope_check CHECK ((scope = 'LOCAL_CONTROLLED'::text))
);
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
    sandbox_registration_ref text,
    bank_binding_id text,
    bank_binding_revision bigint,
    valid_until timestamp with time zone,
    CONSTRAINT sandbox_withdrawal_destination_shape CHECK ((((sandbox_registration_ref IS NULL) AND (bank_binding_id IS NULL) AND (bank_binding_revision IS NULL) AND (valid_until IS NULL)) OR ((sandbox_registration_ref IS NOT NULL) AND (bank_binding_id IS NOT NULL) AND (bank_binding_revision IS NOT NULL) AND (valid_until IS NOT NULL)))),
    CONSTRAINT withdrawal_destination_bank_binding_revision_check CHECK ((bank_binding_revision > 0)),
    CONSTRAINT withdrawal_destination_display_mask_check CHECK (((length(display_mask) >= 1) AND (length(display_mask) <= 100))),
    CONSTRAINT withdrawal_destination_kind_check CHECK ((kind = ANY (ARRAY['BANK_CARD'::text, 'PAYMENT_CODE'::text]))),
    CONSTRAINT withdrawal_destination_mode_check CHECK ((mode = 'LOCAL_CONTROLLED'::text)),
    CONSTRAINT withdrawal_destination_revision_check CHECK ((revision > 0)),
    CONSTRAINT withdrawal_destination_scenario_check CHECK ((scenario = ANY (ARRAY['FAIL_UNPAID'::text, 'TIMEOUT_THEN_SUCCEED'::text])))
);
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
    sandbox_registration_ref text,
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

CREATE OR REPLACE FUNCTION zzsh_order.check_sandbox_withdrawal_target_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a zzsh_order.withdrawal_admission;s zzsh_order.ecs_test_demo_finance_registration;
BEGIN
 SELECT * INTO a FROM zzsh_order.withdrawal_admission WHERE id=NEW.admission_id AND user_id=NEW.user_id;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref;
 IF a.id IS NULL OR s.reference IS NULL OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event e
  WHERE e.action='controlled.withdrawal.target.declared' AND e.object_type='withdrawal_destination' AND e.object_id=NEW.id
   AND e.actor_type='user' AND e.actor_id=NEW.user_id AND e.outcome='SUCCESS' AND e.details->>'sandboxDigest'=s.registration_digest
   AND e.occurred_at>=a.admitted_at
   AND e.details->>'bankBindingId'=NEW.bank_binding_id AND e.details->>'bankBindingRevision'=NEW.bank_binding_revision::text
   AND e.details->>'amountCents'=a.per_intent_cents::text AND e.details->>'currency'='CNY'
   AND e.details->>'identityMeaning'='EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC')
 THEN RAISE EXCEPTION 'sandbox target requires its original user declaration receipt' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.check_withdrawal_batch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE target text;intent zzsh_order.withdrawal_intent;lines integer;dr numeric;cr numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN target:=NEW.id;ELSE target:=NEW.finance_event_id;END IF;
 SELECT i.* INTO intent FROM zzsh_order.withdrawal_intent i JOIN zzsh_order.finance_event e ON e.economic_root_id=i.economic_root_id WHERE e.id=target;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=target;
 IF intent.id IS NULL OR lines<>(SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(target)) OR dr<>intent.gross_cents OR cr<>intent.gross_cents THEN RAISE EXCEPTION 'controlled batch incomplete/unbalanced' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.check_withdrawal_intent_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_controlled_operation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_sandbox_withdrawal_admission()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE s zzsh_order.ecs_test_demo_finance_registration;
BEGIN
 IF NEW.sandbox_registration_ref IS NULL THEN RAISE EXCEPTION 'Exact test registration required' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref AND active FOR SHARE;
 IF s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR NEW.scope<>'LOCAL_CONTROLLED' OR NEW.resource_oid<>((s.canonical_registration::jsonb #>> '{resource,databaseOid}')::oid) OR NEW.resource_name<>current_database()
  OR NEW.resource_marker<>(s.canonical_registration::jsonb #>> '{resource,marker}') OR NEW.created_by_admin_id<>(s.canonical_registration::jsonb->>'administratorId')
  OR NEW.revision<>1 OR NOT NEW.active OR NEW.max_intents<>1 OR NEW.max_gross_cents<>NEW.per_intent_cents
 THEN RAISE EXCEPTION 'sandbox withdrawal admission requires current exact registration' USING ERRCODE='23514';END IF;
 PERFORM u.id FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_identity_state i ON i.user_id=u.id
  WHERE u.id=NEW.user_id AND NOT u.suspended AND COALESCE(i.account_status,'ACTIVE')='ACTIVE' FOR UPDATE OF u;
 IF NOT FOUND THEN RAISE EXCEPTION 'sandbox withdrawal subject unavailable' USING ERRCODE='23514';END IF;
 NEW.admitted_at:=date_trunc('milliseconds',clock_timestamp());
 IF NEW.expires_at IS DISTINCT FROM 'infinity'::timestamptz THEN RAISE EXCEPTION 'registered environment execution cannot inherit a per-test expiry window' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_sandbox_withdrawal_destination()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a zzsh_order.withdrawal_admission;b zzsh_order.withdrawal_bank_binding;s zzsh_order.ecs_test_demo_finance_registration;
BEGIN
 IF NEW.sandbox_registration_ref IS NULL THEN RAISE EXCEPTION 'Exact test registration required' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM zzsh_order.withdrawal_admission WHERE id=NEW.admission_id AND user_id=NEW.user_id;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref AND active FOR SHARE;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 SELECT * INTO b FROM zzsh_order.withdrawal_bank_binding WHERE id=NEW.bank_binding_id AND user_id=NEW.user_id;
 IF a.id IS NULL OR s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR a.sandbox_registration_ref IS DISTINCT FROM s.reference OR a.resource_oid<>((s.canonical_registration::jsonb #>> '{resource,databaseOid}')::oid) OR NOT a.active OR clock_timestamp()>=a.expires_at
  OR b.id IS NULL OR b.revision IS DISTINCT FROM NEW.bank_binding_revision OR b.card_mask IS DISTINCT FROM NEW.display_mask
  OR NEW.mode<>'LOCAL_CONTROLLED' OR NEW.kind<>'BANK_CARD' OR NEW.scenario<>'TIMEOUT_THEN_SUCCEED'
  OR NEW.revision<>1 OR NOT NEW.active
  OR NEW.valid_until IS DISTINCT FROM ((date_trunc('day',a.admitted_at AT TIME ZONE 'Asia/Shanghai')+interval '1 day') AT TIME ZONE 'Asia/Shanghai')
 THEN RAISE EXCEPTION 'sandbox target requires the exact own stored masked bank binding' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_sandbox_withdrawal_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE a zzsh_order.withdrawal_admission;d zzsh_order.withdrawal_destination;s zzsh_order.ecs_test_demo_finance_registration;
BEGIN
 IF NEW.sandbox_registration_ref IS NULL THEN RAISE EXCEPTION 'Exact test registration required' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.sandbox_registration_ref IS DISTINCT FROM OLD.sandbox_registration_ref
 THEN RAISE EXCEPTION 'original sandbox withdrawal registration is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref AND active FOR SHARE;
 SELECT * INTO a FROM zzsh_order.withdrawal_admission WHERE id=NEW.admission_id AND user_id=NEW.user_id;
 SELECT * INTO d FROM zzsh_order.withdrawal_destination WHERE id=NEW.destination_id AND admission_id=NEW.admission_id AND user_id=NEW.user_id;
 IF s.reference IS NULL OR a.id IS NULL OR d.id IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR a.sandbox_registration_ref IS DISTINCT FROM s.reference OR d.sandbox_registration_ref IS DISTINCT FROM s.reference
  OR a.resource_oid<>((s.canonical_registration::jsonb #>> '{resource,databaseOid}')::oid) OR a.resource_name<>current_database() OR a.resource_marker<>(s.canonical_registration::jsonb #>> '{resource,marker}')
  OR NEW.mode<>'LOCAL_CONTROLLED' OR d.mode<>'LOCAL_CONTROLLED' OR d.kind<>'BANK_CARD' OR d.scenario<>'TIMEOUT_THEN_SUCCEED'
 THEN RAISE EXCEPTION 'sandbox intent cannot drive old or cross-registration funds' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
  IF d.valid_until<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM zzsh_order.withdrawal_bank_binding b
    WHERE b.id=d.bank_binding_id AND b.user_id=NEW.user_id AND b.revision=d.bank_binding_revision)
  THEN RAISE EXCEPTION 'new sandbox reserve requires current valid quote target; accepted intent target stays frozen' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_sandbox_withdrawal_original_provider()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE i zzsh_order.withdrawal_intent;s zzsh_order.ecs_test_demo_finance_registration;
BEGIN

 SELECT * INTO i FROM zzsh_order.withdrawal_intent WHERE id=NEW.intent_id;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=i.sandbox_registration_ref AND active FOR SHARE;
 IF i.id IS NULL OR s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
 THEN RAISE EXCEPTION 'sandbox channel action requires its current original registered intent' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_entry()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE event_row zzsh_order.finance_event;intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE economic_root_id=event_row.economic_root_id;
 IF event_row.kind NOT IN('RESERVE','RELEASE','PAYOUT') OR event_row.created_xid IS DISTINCT FROM pg_current_xact_id() OR intent.id IS NULL OR NEW.source_payment_confirmation_id IS NOT NULL
 OR NEW.details IS DISTINCT FROM jsonb_build_object('intentId',intent.id,'economicRootId',intent.economic_root_id,'policyVersion',intent.policy_version,'inputDigest',intent.input_digest)
 OR NOT EXISTS(SELECT 1 FROM zzsh_order.withdrawal_expected_lines(event_row.id) x WHERE(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id) IS NOT DISTINCT FROM(NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id)) THEN RAISE EXCEPTION 'controlled entry differs from exact original template' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_fact()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_referral_recovery()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=NEW.user_id AND state='RECOVERY_REQUIRED')
 THEN RAISE EXCEPTION 'outstanding referral recovery prevents new withdrawal reservation' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.guard_withdrawal_root()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.source_id;
 IF intent.id IS NULL OR intent.created_xid<>pg_current_xact_id() OR NEW.id<>intent.economic_root_id OR NEW.subject_user_id<>intent.user_id
 OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-local-controlled' OR NEW.source_entity<>'withdrawal_intent' OR NEW.beneficiary_role<>'WALLET_HOLDER'
 OR NEW.policy_version IS DISTINCT FROM intent.policy_version OR NEW.source_digest<>intent.input_digest THEN RAISE EXCEPTION 'unbound controlled economic root' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION zzsh_order.withdrawal_expected_lines(event_id text)
 RETURNS TABLE(line_no integer, account_code text, debit_cents numeric, credit_cents numeric, counterparty_user_id text)
 LANGUAGE sql
 STABLE
AS $function$
 SELECT v.n,v.code,v.dr,v.cr,v.party FROM zzsh_order.finance_event e JOIN zzsh_order.withdrawal_intent i ON i.economic_root_id=e.economic_root_id
 CROSS JOIN LATERAL(VALUES
 (1,CASE WHEN e.kind='RESERVE' THEN 'WALLET_AVAILABLE' ELSE 'WALLET_RESERVED' END,i.gross_cents,0::numeric,i.user_id),
 (2,CASE WHEN e.kind='RESERVE' THEN 'WALLET_RESERVED' WHEN e.kind='RELEASE' THEN 'WALLET_AVAILABLE' ELSE 'PAYOUT_CLEARING' END,0::numeric,CASE WHEN e.kind='PAYOUT' THEN i.net_cents ELSE i.gross_cents END,CASE WHEN e.kind='PAYOUT' THEN NULL::text ELSE i.user_id END),
 (3,'WITHDRAW_FEE',0::numeric,i.fee_cents,NULL::text))v(n,code,dr,cr,party)
 WHERE e.id=event_id AND e.kind IN('RESERVE','RELEASE','PAYOUT') AND(v.n<3 OR(e.kind='PAYOUT' AND i.fee_cents>0))
$function$
;

ALTER TABLE ONLY zzsh_order.controlled_payout_operation
    ADD CONSTRAINT controlled_payout_operation_intent_id_key UNIQUE (intent_id);
ALTER TABLE ONLY zzsh_order.controlled_payout_operation
    ADD CONSTRAINT controlled_payout_operation_payout_key_key UNIQUE (payout_key);
ALTER TABLE ONLY zzsh_order.controlled_payout_operation
    ADD CONSTRAINT controlled_payout_operation_pkey PRIMARY KEY (id);
ALTER TABLE ONLY zzsh_order.withdrawal_admission
    ADD CONSTRAINT withdrawal_admission_id_user_id_key UNIQUE (id, user_id);
ALTER TABLE ONLY zzsh_order.withdrawal_admission
    ADD CONSTRAINT withdrawal_admission_pkey PRIMARY KEY (id);
ALTER TABLE ONLY zzsh_order.withdrawal_destination
    ADD CONSTRAINT withdrawal_destination_id_user_id_admission_id_key UNIQUE (id, user_id, admission_id);
ALTER TABLE ONLY zzsh_order.withdrawal_destination
    ADD CONSTRAINT withdrawal_destination_pkey PRIMARY KEY (id);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_economic_root_id_key UNIQUE (economic_root_id);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_id_payout_key_key UNIQUE (id, payout_key);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_id_user_id_key UNIQUE (id, user_id);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_payout_key_key UNIQUE (payout_key);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_pkey PRIMARY KEY (id);
ALTER TABLE ONLY zzsh_order.withdrawal_provider_fact
    ADD CONSTRAINT withdrawal_provider_fact_id_intent_id_key UNIQUE (id, intent_id);
ALTER TABLE ONLY zzsh_order.withdrawal_provider_fact
    ADD CONSTRAINT withdrawal_provider_fact_intent_id_result_key_key UNIQUE (intent_id, result_key);
ALTER TABLE ONLY zzsh_order.withdrawal_provider_fact
    ADD CONSTRAINT withdrawal_provider_fact_pkey PRIMARY KEY (id);
CREATE INDEX sandbox_withdrawal_admission_user ON zzsh_order.withdrawal_admission USING btree (user_id, sandbox_registration_ref, admitted_at DESC, id) WHERE (sandbox_registration_ref IS NOT NULL);
CREATE INDEX sandbox_withdrawal_destination_user ON zzsh_order.withdrawal_destination USING btree (user_id, sandbox_registration_ref, id) WHERE (sandbox_registration_ref IS NOT NULL);
CREATE INDEX sandbox_withdrawal_intent_user ON zzsh_order.withdrawal_intent USING btree (user_id, sandbox_registration_ref, accepted_at DESC, id) WHERE (sandbox_registration_ref IS NOT NULL);
CREATE TRIGGER aaa_sandbox_controlled_operation_guard BEFORE INSERT ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_original_provider();
CREATE TRIGGER aaa_sandbox_withdrawal_fact_guard BEFORE INSERT ON zzsh_order.withdrawal_provider_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_original_provider();
CREATE TRIGGER aaa_sandbox_withdrawal_intent_guard BEFORE INSERT OR UPDATE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_intent();
CREATE TRIGGER controlled_operation_guard BEFORE INSERT ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_controlled_operation();
CREATE TRIGGER controlled_operation_immutable BEFORE DELETE OR UPDATE ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER sandbox_withdrawal_admission_guard BEFORE INSERT ON zzsh_order.withdrawal_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_admission();
CREATE TRIGGER sandbox_withdrawal_destination_guard BEFORE INSERT ON zzsh_order.withdrawal_destination FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_sandbox_withdrawal_destination();
CREATE CONSTRAINT TRIGGER sandbox_withdrawal_target_receipt AFTER INSERT ON zzsh_order.withdrawal_destination DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.sandbox_registration_ref IS NOT NULL)) EXECUTE FUNCTION zzsh_order.check_sandbox_withdrawal_target_receipt();
CREATE TRIGGER withdrawal_admission_immutable BEFORE DELETE OR UPDATE ON zzsh_order.withdrawal_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER withdrawal_destination_immutable BEFORE DELETE OR UPDATE ON zzsh_order.withdrawal_destination FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER withdrawal_fact_guard BEFORE INSERT ON zzsh_order.withdrawal_provider_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_fact();
CREATE TRIGGER withdrawal_fact_immutable BEFORE DELETE OR UPDATE ON zzsh_order.withdrawal_provider_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE CONSTRAINT TRIGGER withdrawal_intent_commit_guard AFTER INSERT OR UPDATE ON zzsh_order.withdrawal_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_withdrawal_intent_consistency();
CREATE TRIGGER withdrawal_intent_guard BEFORE INSERT OR DELETE OR UPDATE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_intent();
CREATE TRIGGER withdrawal_operation_read_revision AFTER UPDATE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_read_revision();
CREATE TRIGGER withdrawal_referral_recovery_guard BEFORE INSERT ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_referral_recovery();
ALTER TABLE ONLY zzsh_order.controlled_payout_operation
    ADD CONSTRAINT controlled_payout_operation_intent_id_payout_key_fkey FOREIGN KEY (intent_id, payout_key) REFERENCES zzsh_order.withdrawal_intent(id, payout_key);
ALTER TABLE ONLY zzsh_order.withdrawal_admission
    ADD CONSTRAINT withdrawal_admission_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id) REFERENCES zzsh_auth_admin."user"(id);
ALTER TABLE ONLY zzsh_order.withdrawal_admission
    ADD CONSTRAINT withdrawal_admission_sandbox_registration_ref_fkey FOREIGN KEY (sandbox_registration_ref) REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference);
ALTER TABLE ONLY zzsh_order.withdrawal_admission
    ADD CONSTRAINT withdrawal_admission_user_id_fkey FOREIGN KEY (user_id) REFERENCES zzsh_auth_user."user"(id);
ALTER TABLE ONLY zzsh_order.withdrawal_destination
    ADD CONSTRAINT withdrawal_destination_admission_id_user_id_fkey FOREIGN KEY (admission_id, user_id) REFERENCES zzsh_order.withdrawal_admission(id, user_id);
ALTER TABLE ONLY zzsh_order.withdrawal_destination
    ADD CONSTRAINT withdrawal_destination_bank_binding_id_fkey FOREIGN KEY (bank_binding_id) REFERENCES zzsh_order.withdrawal_bank_binding(id);
ALTER TABLE ONLY zzsh_order.withdrawal_destination
    ADD CONSTRAINT withdrawal_destination_sandbox_registration_ref_fkey FOREIGN KEY (sandbox_registration_ref) REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_admission_id_user_id_fkey FOREIGN KEY (admission_id, user_id) REFERENCES zzsh_order.withdrawal_admission(id, user_id);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_destination_id_user_id_admission_id_fkey FOREIGN KEY (destination_id, user_id, admission_id) REFERENCES zzsh_order.withdrawal_destination(id, user_id, admission_id);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_economic_root_id_fkey FOREIGN KEY (economic_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_intent_sandbox_registration_ref_fkey FOREIGN KEY (sandbox_registration_ref) REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference);
ALTER TABLE ONLY zzsh_order.withdrawal_intent
    ADD CONSTRAINT withdrawal_last_fact_fk FOREIGN KEY (last_provider_fact_id, id) REFERENCES zzsh_order.withdrawal_provider_fact(id, intent_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY zzsh_order.withdrawal_provider_fact
    ADD CONSTRAINT withdrawal_provider_fact_intent_id_payout_key_fkey FOREIGN KEY (intent_id, payout_key) REFERENCES zzsh_order.withdrawal_intent(id, payout_key);

ALTER TABLE zzsh_order.withdrawal_admission ADD CONSTRAINT demo_withdrawal_registration_required CHECK(sandbox_registration_ref IS NOT NULL);
ALTER TABLE zzsh_order.withdrawal_destination ADD CONSTRAINT demo_withdrawal_registration_required CHECK(sandbox_registration_ref IS NOT NULL);
ALTER TABLE zzsh_order.withdrawal_intent ADD CONSTRAINT demo_withdrawal_registration_required CHECK(sandbox_registration_ref IS NOT NULL);
ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT production_no_local_controlled_root, ADD CONSTRAINT production_no_local_controlled_root CHECK(source_kind<>'LOCAL_CONTROLLED_WITHDRAWAL' OR source_system='zzsh-local-controlled');
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT production_no_controlled_withdrawal_event, ADD CONSTRAINT production_no_controlled_withdrawal_event CHECK(kind NOT IN('RESERVE','RELEASE','PAYOUT') OR economic_root_id LIKE 'withdrawal_root_%');
ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT production_no_controlled_withdrawal_entry, ADD CONSTRAINT production_no_controlled_withdrawal_entry CHECK(finance_event_id IS NULL OR NOT(details?'intentId') OR details->>'intentId' LIKE 'wd_%');
CREATE TRIGGER withdrawal_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN (new.source_kind = 'LOCAL_CONTROLLED_WITHDRAWAL'::text) EXECUTE FUNCTION zzsh_order.guard_withdrawal_root();
CREATE CONSTRAINT TRIGGER withdrawal_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.kind = ANY (ARRAY['RESERVE'::text, 'RELEASE'::text, 'PAYOUT'::text])) EXECUTE FUNCTION zzsh_order.check_withdrawal_batch();
CREATE TRIGGER withdrawal_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN (new.kind = ANY (ARRAY['RESERVE'::text, 'RELEASE'::text, 'PAYOUT'::text])) EXECUTE FUNCTION zzsh_order.guard_withdrawal_event();
CREATE CONSTRAINT TRIGGER withdrawal_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.finance_event_id IS NOT NULL AND new.details ? 'intentId'::text) EXECUTE FUNCTION zzsh_order.check_withdrawal_batch();
CREATE TRIGGER withdrawal_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN (new.finance_event_id IS NOT NULL AND new.details ? 'intentId'::text) EXECUTE FUNCTION zzsh_order.guard_withdrawal_entry();
REVOKE ALL ON FUNCTION zzsh_order.check_sandbox_withdrawal_target_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_withdrawal_batch() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_withdrawal_intent_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_controlled_operation() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_sandbox_withdrawal_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_sandbox_withdrawal_destination() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_sandbox_withdrawal_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_sandbox_withdrawal_original_provider() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_intent() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_referral_recovery() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_root() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.withdrawal_expected_lines(text) FROM PUBLIC;
COMMENT ON TABLE zzsh_order.withdrawal_admission IS '测试提现申请的资源准入，不能用于真实代付。';
COMMENT ON TABLE zzsh_order.withdrawal_destination IS '测试提现目标，关联本人的银行卡脱敏信息。';
COMMENT ON TABLE zzsh_order.withdrawal_intent IS '测试提现意图、预留和模拟结果，不表示银行卡到账。';
COMMENT ON TABLE zzsh_order.withdrawal_provider_fact IS '测试提现模拟结果记录，不是汇聚渠道事实。';
COMMENT ON TABLE zzsh_order.controlled_payout_operation IS '测试提现原操作及模拟终态，不代表真实出款。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.final_evidence_canonical IS '模拟处理结果的规范化正文。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.final_evidence_digest IS '模拟处理结果正文的摘要。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.id IS '本表记录的稳定标识。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.intent_id IS '关联的原申请或退款意图标识。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.mode IS '测试操作的来源模式，不表示真实渠道。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.original_lease_hash IS '原处理租约的摘要，用于拒绝过期执行者写回。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.payout_key IS '同一次模拟提现的稳定幂等键。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.recorded_at IS '该模拟处理结果的记录时间。';
COMMENT ON COLUMN zzsh_order.controlled_payout_operation.scenario IS '测试模拟使用的场景。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.active IS '该登记或准入当前是否有效。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.admitted_at IS '该准入开始生效的时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.created_by_admin_id IS '创建该受控记录的管理员或系统主体标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.expires_at IS '该准入到期时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.id IS '本表记录的稳定标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.max_gross_cents IS '该准入允许的提现总额上限，单位为分。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.max_intents IS '该准入允许的最大提现申请次数。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.per_intent_cents IS '单次测试提现的允许上限，单位为分。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.reason IS '创建该受控记录的原因。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.resource_marker IS '绑定的测试数据库标识；不是渠道身份。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.resource_name IS '绑定的测试数据库名称。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.resource_oid IS '本次绑定的测试数据库 OID；恢复到另一数据库后须重新登记。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.revision IS '该记录的并发控制版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.sandbox_registration_ref IS '关联的测试模拟资源登记标识；空值不表示已接入。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.scope IS '测试资金操作的范围与来源类型。';
COMMENT ON COLUMN zzsh_order.withdrawal_admission.user_id IS '关联的用户主体标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.active IS '该登记或准入当前是否有效。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.admission_id IS '关联本测试资源的原准入记录。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.bank_binding_id IS '关联的银行卡绑定记录标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.bank_binding_revision IS '银行卡绑定记录的冻结版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.display_mask IS '向授权用户展示的目标掩码。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.id IS '本表记录的稳定标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.kind IS '目标或记录的业务类型。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.mode IS '测试操作的来源模式，不表示真实渠道。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.revision IS '该记录的并发控制版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.sandbox_registration_ref IS '关联的测试模拟资源登记标识；空值不表示已接入。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.scenario IS '测试模拟使用的场景。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.user_id IS '关联的用户主体标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_destination.valid_until IS '该目标绑定允许使用的截止时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.accepted_at IS '本平台接纳申请的时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.admission_id IS '关联本测试资源的原准入记录。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.conflict_digest IS '冲突事实的摘要，用于定位原请求。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.created_at IS '该记录的创建时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.created_xid IS '创建该事实的数据库事务标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.destination_id IS '关联的原提现目标记录。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.destination_revision IS '提现申请使用的目标冻结版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.economic_root_id IS '关联的资金经济根记录标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.expected_ledger_revision IS '本次操作要求的原钱包账本版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.fee_cents IS '提现手续费，单位为分。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.funds_disposition IS '该申请相关资金的占用、释放或处理状态。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.gross_cents IS '提现申请总额，单位为分。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.id IS '本表记录的稳定标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.input_digest IS '原申请输入的摘要。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.last_provider_fact_id IS '最近一次模拟结果事实标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.lease_token_hash IS '执行租约令牌的摘要，不保存令牌正文。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.lease_until IS '当前执行租约的到期时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.mode IS '测试操作的来源模式，不表示真实渠道。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.net_cents IS '扣除手续费后的模拟出款额，单位为分。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.operation_version IS '操作或租约的并发版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.payout_key IS '同一次模拟提现的稳定幂等键。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.policy_version IS '本次操作绑定的业务政策版本。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.sandbox_registration_ref IS '关联的测试模拟资源登记标识；空值不表示已接入。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.state IS '当前操作状态，不等于渠道或银行到账。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.terminal IS '当前原模拟操作的终态标识，不代表银行到账。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.terminal_xid IS '终态写入对应的数据库事务标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_intent.user_id IS '关联的用户主体标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.evidence_canonical IS '规范化模拟事实正文，不是渠道或银行回单。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.evidence_digest IS '模拟事实正文的摘要。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.id IS '本表记录的稳定标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.intent_id IS '关联的原申请或退款意图标识。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.mode IS '测试操作的来源模式，不表示真实渠道。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.observed_at IS '模拟结果被记录的时间。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.payout_key IS '同一次模拟提现的稳定幂等键。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.producer_lease_hash IS '产生该结果的原执行租约摘要。';
COMMENT ON COLUMN zzsh_order.withdrawal_provider_fact.result_key IS '原模拟结果的稳定幂等键。';
