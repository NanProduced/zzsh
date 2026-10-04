-- U3 candidate only. idx59/1789490028000 reserved by Master; DB execution separately reviewed.
-- LOCAL_CONTROLLED facts do not claim total historical reserved/withdrawable coverage.
CREATE TABLE zzsh_order.withdrawal_admission (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 scope text NOT NULL CHECK(scope='LOCAL_CONTROLLED'),resource_oid oid NOT NULL,resource_name text NOT NULL,resource_marker text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL,
 per_intent_cents numeric(24,0) NOT NULL CHECK(per_intent_cents>=200 AND per_intent_cents<=1000000),
 max_intents integer NOT NULL CHECK(max_intents BETWEEN 1 AND 2),max_gross_cents numeric(24,0) NOT NULL CHECK(max_gross_cents>0),
 admitted_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>admitted_at),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 UNIQUE(id,user_id)
);
CREATE TABLE zzsh_order.withdrawal_destination (
 id text PRIMARY KEY,user_id text NOT NULL,admission_id text NOT NULL,
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED'),kind text NOT NULL CHECK(kind IN('BANK_CARD','PAYMENT_CODE')),
 scenario text NOT NULL CHECK(scenario IN('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED')),
 display_mask text NOT NULL CHECK(length(display_mask) BETWEEN 1 AND 100),revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL,
 FOREIGN KEY(admission_id,user_id) REFERENCES zzsh_order.withdrawal_admission(id,user_id),UNIQUE(id,user_id,admission_id)
);
CREATE TABLE zzsh_order.withdrawal_intent (
 id text PRIMARY KEY,user_id text NOT NULL,admission_id text NOT NULL,destination_id text NOT NULL,destination_revision bigint NOT NULL,
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED'),policy_version text NOT NULL,input_digest text NOT NULL CHECK(input_digest~'^[0-9a-f]{64}$'),
 gross_cents numeric(24,0) NOT NULL CHECK(gross_cents>0),net_cents numeric(24,0) NOT NULL CHECK(net_cents>0),fee_cents numeric(24,0) NOT NULL CHECK(fee_cents>=0),
 expected_ledger_revision bigint NOT NULL CHECK(expected_ledger_revision>=0),accepted_at timestamptz NOT NULL,
 payout_key text NOT NULL UNIQUE,economic_root_id text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED')),
 operation_version bigint NOT NULL CHECK(operation_version>0),funds_disposition text NOT NULL CHECK(funds_disposition IN('RESERVED','PAYOUT_POSTED','RELEASE_POSTED')),
 lease_token_hash text CHECK(lease_token_hash~'^[0-9a-f]{64}$'),lease_until timestamptz,last_provider_fact_id text,
 terminal jsonb,conflict_digest text CHECK(conflict_digest~'^[0-9a-f]{64}$'),terminal_xid xid8,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(gross_cents=net_cents+fee_cents),CHECK((lease_token_hash IS NULL)=(lease_until IS NULL)),
 CHECK((state IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN') AND funds_disposition='RESERVED' AND terminal IS NULL)
 OR(state='SUCCEEDED' AND funds_disposition='PAYOUT_POSTED' AND terminal IS NOT NULL)
 OR(state='FAILED' AND funds_disposition='RELEASE_POSTED' AND terminal IS NOT NULL)
 OR state='RECONCILIATION_REQUIRED'),
 FOREIGN KEY(admission_id,user_id) REFERENCES zzsh_order.withdrawal_admission(id,user_id),
 FOREIGN KEY(destination_id,user_id,admission_id) REFERENCES zzsh_order.withdrawal_destination(id,user_id,admission_id),
 FOREIGN KEY(economic_root_id) REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(id,user_id),UNIQUE(id,payout_key)
);
CREATE TABLE zzsh_order.withdrawal_provider_fact (
 id text PRIMARY KEY,intent_id text NOT NULL,payout_key text NOT NULL,
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED'),result_key text NOT NULL,
 evidence_canonical text NOT NULL,evidence_digest text NOT NULL CHECK(evidence_digest~'^[0-9a-f]{64}$'),
 producer_lease_hash text NOT NULL CHECK(producer_lease_hash~'^[0-9a-f]{64}$'),observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(intent_id,payout_key) REFERENCES zzsh_order.withdrawal_intent(id,payout_key),UNIQUE(intent_id,result_key),UNIQUE(id,intent_id),
 CHECK(evidence_digest=encode(sha256(convert_to(evidence_canonical,'UTF8')),'hex')),
 CHECK(jsonb_typeof(evidence_canonical::jsonb)='object')
);
-- Durable local-channel truth is independent of the worker acknowledgement/result write.
CREATE TABLE zzsh_order.controlled_payout_operation (
 id text PRIMARY KEY,intent_id text NOT NULL UNIQUE,payout_key text NOT NULL UNIQUE,
 mode text NOT NULL CHECK(mode='LOCAL_CONTROLLED'),scenario text NOT NULL CHECK(scenario IN('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED')),
 final_evidence_canonical text NOT NULL,final_evidence_digest text NOT NULL CHECK(final_evidence_digest~'^[0-9a-f]{64}$'),
 original_lease_hash text NOT NULL CHECK(original_lease_hash~'^[0-9a-f]{64}$'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(intent_id,payout_key) REFERENCES zzsh_order.withdrawal_intent(id,payout_key),
 CHECK(final_evidence_digest=encode(sha256(convert_to(final_evidence_canonical,'UTF8')),'hex'))
);
ALTER TABLE zzsh_order.withdrawal_intent ADD CONSTRAINT withdrawal_last_fact_fk FOREIGN KEY(last_provider_fact_id,id)
 REFERENCES zzsh_order.withdrawal_provider_fact(id,intent_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER withdrawal_admission_immutable BEFORE UPDATE OR DELETE ON zzsh_order.withdrawal_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER withdrawal_destination_immutable BEFORE UPDATE OR DELETE ON zzsh_order.withdrawal_destination FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER withdrawal_fact_immutable BEFORE UPDATE OR DELETE ON zzsh_order.withdrawal_provider_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER controlled_operation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE FUNCTION zzsh_order.guard_withdrawal_intent() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER withdrawal_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_intent();
CREATE FUNCTION zzsh_order.guard_withdrawal_fact() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER withdrawal_fact_guard BEFORE INSERT ON zzsh_order.withdrawal_provider_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_withdrawal_fact();
CREATE FUNCTION zzsh_order.guard_controlled_operation() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER controlled_operation_guard BEFORE INSERT ON zzsh_order.controlled_payout_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_controlled_operation();

ALTER TABLE zzsh_order.finance_economic_root ALTER COLUMN basis_id DROP NOT NULL,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind='LEGACY_OPENING' AND basis_id IS NOT NULL) OR(source_kind='LOCAL_CONTROLLED_WITHDRAWAL' AND basis_id IS NULL));
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT'));
DROP TRIGGER finance_root_guard ON zzsh_order.finance_economic_root;
CREATE TRIGGER finance_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN(NEW.source_kind<>'LOCAL_CONTROLLED_WITHDRAWAL') EXECUTE FUNCTION zzsh_order.guard_finance_root();
DROP TRIGGER finance_event_guard ON zzsh_order.finance_event;
CREATE TRIGGER finance_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='OPENING') EXECUTE FUNCTION zzsh_order.guard_finance_event();
DROP TRIGGER finance_event_revision ON zzsh_order.finance_event;
CREATE TRIGGER finance_event_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='OPENING') EXECUTE FUNCTION zzsh_order.finance_event_wallet_revision();
DROP TRIGGER finance_event_batch_guard ON zzsh_order.finance_event;
CREATE CONSTRAINT TRIGGER finance_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='OPENING') EXECUTE FUNCTION zzsh_order.check_finance_batch();
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId')) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId')) EXECUTE FUNCTION zzsh_order.check_finance_batch();
ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts,DROP CONSTRAINT settlement_ledger_counterparty,
 ADD CONSTRAINT settlement_ledger_accounts CHECK((posting_id IS NOT NULL AND account_code IN('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT')) OR(finance_event_id IS NOT NULL AND account_code IN('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE','WALLET_RESERVED','PAYOUT_CLEARING','WITHDRAW_FEE'))),
 ADD CONSTRAINT settlement_ledger_counterparty CHECK((account_code IN('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED') AND counterparty_user_id IS NOT NULL) OR(account_code NOT IN('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE','WALLET_RESERVED') AND counterparty_user_id IS NULL));

CREATE FUNCTION zzsh_order.guard_withdrawal_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE id=NEW.source_id;
 IF intent.id IS NULL OR intent.created_xid<>pg_current_xact_id() OR NEW.id<>intent.economic_root_id OR NEW.subject_user_id<>intent.user_id
 OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-local-controlled' OR NEW.source_entity<>'withdrawal_intent' OR NEW.beneficiary_role<>'WALLET_HOLDER'
 OR NEW.policy_version IS DISTINCT FROM intent.policy_version OR NEW.source_digest<>intent.input_digest THEN RAISE EXCEPTION 'unbound controlled economic root' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN(NEW.source_kind='LOCAL_CONTROLLED_WITHDRAWAL') EXECUTE FUNCTION zzsh_order.guard_withdrawal_root();
CREATE FUNCTION zzsh_order.guard_withdrawal_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER withdrawal_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind<>'OPENING') EXECUTE FUNCTION zzsh_order.guard_withdrawal_event();
CREATE FUNCTION zzsh_order.withdrawal_expected_lines(event_id text) RETURNS TABLE(line_no integer,account_code text,debit_cents numeric,credit_cents numeric,counterparty_user_id text) LANGUAGE sql STABLE AS $$
 SELECT v.n,v.code,v.dr,v.cr,v.party FROM zzsh_order.finance_event e JOIN zzsh_order.withdrawal_intent i ON i.economic_root_id=e.economic_root_id
 CROSS JOIN LATERAL(VALUES
 (1,CASE WHEN e.kind='RESERVE' THEN 'WALLET_AVAILABLE' ELSE 'WALLET_RESERVED' END,i.gross_cents,0::numeric,i.user_id),
 (2,CASE WHEN e.kind='RESERVE' THEN 'WALLET_RESERVED' WHEN e.kind='RELEASE' THEN 'WALLET_AVAILABLE' ELSE 'PAYOUT_CLEARING' END,0::numeric,CASE WHEN e.kind='PAYOUT' THEN i.net_cents ELSE i.gross_cents END,CASE WHEN e.kind='PAYOUT' THEN NULL::text ELSE i.user_id END),
 (3,'WITHDRAW_FEE',0::numeric,i.fee_cents,NULL::text))v(n,code,dr,cr,party)
 WHERE e.id=event_id AND e.kind IN('RESERVE','RELEASE','PAYOUT') AND(v.n<3 OR(e.kind='PAYOUT' AND i.fee_cents>0))
$$;
CREATE FUNCTION zzsh_order.guard_withdrawal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_row zzsh_order.finance_event;intent zzsh_order.withdrawal_intent;
BEGIN
 SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO intent FROM zzsh_order.withdrawal_intent WHERE economic_root_id=event_row.economic_root_id;
 IF event_row.kind NOT IN('RESERVE','RELEASE','PAYOUT') OR event_row.created_xid IS DISTINCT FROM pg_current_xact_id() OR intent.id IS NULL OR NEW.source_payment_confirmation_id IS NOT NULL
 OR NEW.details IS DISTINCT FROM jsonb_build_object('intentId',intent.id,'economicRootId',intent.economic_root_id,'policyVersion',intent.policy_version,'inputDigest',intent.input_digest)
 OR NOT EXISTS(SELECT 1 FROM zzsh_order.withdrawal_expected_lines(event_row.id) x WHERE(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id) IS NOT DISTINCT FROM(NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id)) THEN RAISE EXCEPTION 'controlled entry differs from exact original template' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'intentId') EXECUTE FUNCTION zzsh_order.guard_withdrawal_entry();
CREATE FUNCTION zzsh_order.check_withdrawal_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;intent zzsh_order.withdrawal_intent;lines integer;dr numeric;cr numeric;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN target:=NEW.id;ELSE target:=NEW.finance_event_id;END IF;
 SELECT i.* INTO intent FROM zzsh_order.withdrawal_intent i JOIN zzsh_order.finance_event e ON e.economic_root_id=i.economic_root_id WHERE e.id=target;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0) INTO lines,dr,cr FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=target;
 IF intent.id IS NULL OR lines<>(SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(target)) OR dr<>intent.gross_cents OR cr<>intent.gross_cents THEN RAISE EXCEPTION 'controlled batch incomplete/unbalanced' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER withdrawal_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind<>'OPENING') EXECUTE FUNCTION zzsh_order.check_withdrawal_batch();
CREATE CONSTRAINT TRIGGER withdrawal_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'intentId') EXECUTE FUNCTION zzsh_order.check_withdrawal_batch();
-- Reverse closure: creating/updating an intent cannot commit without its money facts.
-- Read the final row, not an intermediate NEW value from claim/result updates.
CREATE FUNCTION zzsh_order.check_withdrawal_intent_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER withdrawal_intent_commit_guard AFTER INSERT OR UPDATE ON zzsh_order.withdrawal_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_withdrawal_intent_consistency();
CREATE FUNCTION zzsh_order.withdrawal_wallet_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET ledger_revision=ledger_revision+1,read_revision=read_revision+1 WHERE user_id=NEW.subject_user_id;IF NOT FOUND THEN RAISE EXCEPTION 'controlled wallet coverage absent' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION zzsh_order.withdrawal_wallet_revision() FROM PUBLIC;
CREATE TRIGGER withdrawal_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind<>'OPENING') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();
CREATE FUNCTION zzsh_order.withdrawal_read_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN UPDATE zzsh_order.wallet_revision SET read_revision=read_revision+1 WHERE user_id=NEW.user_id;IF NOT FOUND THEN RAISE EXCEPTION 'controlled wallet coverage absent' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION zzsh_order.withdrawal_read_revision() FROM PUBLIC;
CREATE TRIGGER withdrawal_operation_read_revision AFTER UPDATE ON zzsh_order.withdrawal_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.withdrawal_read_revision();
-- Native posting functions/trigger and the exact OPENING functions remain unmodified.
-- Runtime grants and explicit cohort/destinations are separate exact reviewed post-migration/data plans.
