-- personal-finance.v3-r1-proposed / U2 wallet-read foundation.
-- RESERVED 0058 / U2 ONLY / PERSISTENT EXECUTION NOT AUTHORIZED.
-- U3 withdrawal and U4 earning/correction remain required goal phases.
-- This prefix rejects their writes; later reviewed DDL enables typed sources.
-- Existing 0048/0049 functions and native balance assertions remain unchanged.

CREATE TABLE zzsh_order.finance_opening_basis (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 source_kind text NOT NULL CHECK(source_kind='LEGACY_OPENING'),
 source_system text NOT NULL,source_entity text NOT NULL,source_id text NOT NULL,
 identity_source_digest text,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 available_cents numeric(24,0) NOT NULL CHECK(available_cents>=0),source_cutoff timestamptz,
 covered_count integer NOT NULL CHECK(covered_count>=0),
 covered_set_digest text NOT NULL CHECK(covered_set_digest~'^[0-9a-f]{64}$'),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_system,source_entity,source_id),
 CHECK(source_entity='la_user' AND source_cutoff IS NOT NULL AND identity_source_digest IS NOT NULL AND identity_source_digest~'^[0-9a-f]{64}$'),
 UNIQUE(id,user_id)
);
CREATE TABLE zzsh_order.finance_covered_event (
 basis_id text NOT NULL REFERENCES zzsh_order.finance_opening_basis(id),user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 source_kind text NOT NULL CHECK(source_kind IN ('LEGACY_DISTRIBUTION_EARNING','LEGACY_WITHDRAWAL','LEGACY_RENTAL_OWNER_INCOME','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION')),
 source_type text NOT NULL CHECK(source_type='LEGACY_MYSQL'),source_entity text NOT NULL,source_id text NOT NULL,beneficiary_role text NOT NULL,
 source_event_at timestamptz NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 CHECK(extract(epoch FROM source_event_at)=trunc(extract(epoch FROM source_event_at))),
 CHECK((source_kind='LEGACY_DISTRIBUTION_EARNING' AND source_entity='la_distribution_order' AND beneficiary_role IN ('TASK_REFERRAL','RENTER_REFERRAL','OWNER_REFERRAL'))
 OR(source_kind='LEGACY_WITHDRAWAL' AND source_entity='la_withdraw_apply' AND beneficiary_role='WALLET_HOLDER')
 OR(source_kind IN ('LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION') AND source_entity='la_order' AND beneficiary_role='OWNER')
 OR(source_kind='LEGACY_ADMIN_LOG' AND source_entity='la_log_earnings' AND beneficiary_role='WALLET_HOLDER')),
 PRIMARY KEY(user_id,source_kind,source_type,source_entity,source_id,beneficiary_role)
);
CREATE TABLE zzsh_order.finance_economic_root (
 id text PRIMARY KEY,basis_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_opening_basis(id),
 source_kind text NOT NULL,source_type text NOT NULL,source_system text NOT NULL,source_entity text NOT NULL,source_id text NOT NULL,
 subject_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),beneficiary_role text NOT NULL,policy_version text,
 source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role)
);
-- No additional source/action uniqueness omits role. Child uniqueness is root+kind.
CREATE TABLE zzsh_order.finance_event (
 id text PRIMARY KEY,economic_root_id text NOT NULL REFERENCES zzsh_order.finance_economic_root(id),
 kind text NOT NULL CHECK(kind='OPENING'),subject_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 expected_ledger_revision bigint NOT NULL CHECK(expected_ledger_revision>=0),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(economic_root_id,kind)
);
CREATE TABLE zzsh_order.wallet_coverage (
 user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),origin text NOT NULL CHECK(origin='RECONCILED_OPENING'),
 basis_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_opening_basis(id),opening_event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id),
 coverage_version bigint NOT NULL DEFAULT 1 CHECK(coverage_version=1)
);
CREATE TABLE zzsh_order.wallet_revision (
 user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),ledger_revision bigint NOT NULL CHECK(ledger_revision>=0),
 read_revision bigint NOT NULL CHECK(read_revision>=ledger_revision)
);
CREATE TABLE zzsh_order.finance_observation_admission (
 basis_id text NOT NULL,user_id text NOT NULL,source_system text NOT NULL,legacy_user_id text NOT NULL,
 source_entity text NOT NULL,source_id text NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 source_event_at timestamptz NOT NULL,included_in_opening boolean NOT NULL,
 FOREIGN KEY(basis_id,user_id) REFERENCES zzsh_order.finance_opening_basis(id,user_id),
 PRIMARY KEY(basis_id,source_entity,source_id)
);
CREATE FUNCTION zzsh_order.guard_observation_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_name text;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF current_user<>owner_name OR basis.user_id IS DISTINCT FROM NEW.user_id OR basis.source_system IS DISTINCT FROM NEW.source_system
 OR basis.source_id IS DISTINCT FROM NEW.legacy_user_id OR NEW.source_event_at>basis.source_cutoff THEN
 RAISE EXCEPTION 'observation admission subject/cutoff mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER observation_admission_guard BEFORE INSERT ON zzsh_order.finance_observation_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_observation_admission();
CREATE TABLE zzsh_order.personal_finance_observation (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),basis_id text,
 source_kind text NOT NULL CHECK(source_kind IN ('HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL')),
 source_type text NOT NULL CHECK(source_type='LEGACY_MYSQL'),source_system text NOT NULL,legacy_user_id text NOT NULL,
 source_entity text NOT NULL,source_id text NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 source_canonical text NOT NULL,source_event_at timestamptz,imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 included_in_opening boolean NOT NULL,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 FOREIGN KEY(basis_id,user_id) REFERENCES zzsh_order.finance_opening_basis(id,user_id),
 CHECK(NOT included_in_opening OR basis_id IS NOT NULL),
 UNIQUE(source_type,source_system,source_entity,source_id)
);
CREATE TABLE zzsh_iam.personal_finance_read_scope (
 admin_user_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),scope_key text NOT NULL,subject_user_id text REFERENCES zzsh_auth_user."user"(id),
 scope_kind text NOT NULL CHECK(scope_kind IN ('ALL_SUBJECTS','SUBJECT_SET')),version bigint NOT NULL CHECK(version>0),
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,PRIMARY KEY(admin_user_id,scope_key),
 CHECK((scope_kind='ALL_SUBJECTS' AND subject_user_id IS NULL AND scope_key='ALL_SUBJECTS')
 OR(scope_kind='SUBJECT_SET' AND subject_user_id IS NOT NULL AND scope_key=subject_user_id))
);
CREATE FUNCTION zzsh_order.finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial evidence immutable' USING ERRCODE='40001'; END $$;
CREATE TRIGGER opening_basis_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_opening_basis FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER covered_event_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_covered_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER economic_root_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_economic_root FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER finance_event_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER wallet_coverage_immutable BEFORE UPDATE OR DELETE ON zzsh_order.wallet_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER observation_admission_immutable BEFORE UPDATE OR DELETE ON zzsh_order.finance_observation_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER finance_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE FUNCTION zzsh_order.guard_opening_basis() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER opening_basis_guard BEFORE INSERT ON zzsh_order.finance_opening_basis FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_opening_basis();
CREATE FUNCTION zzsh_order.guard_covered_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis zzsh_order.finance_opening_basis;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF current_user<>owner_name OR basis.id IS NULL OR basis.source_kind<>'LEGACY_OPENING' OR basis.user_id<>NEW.user_id OR NEW.source_event_at>basis.source_cutoff THEN
  RAISE EXCEPTION 'covered event requires admitted subject and inclusive cutoff' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER covered_event_guard BEFORE INSERT ON zzsh_order.finance_covered_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_covered_event();
CREATE FUNCTION zzsh_order.check_opening_coverage_set() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER opening_coverage_set_guard AFTER INSERT ON zzsh_order.finance_opening_basis DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_opening_coverage_set();
CREATE CONSTRAINT TRIGGER covered_event_set_guard AFTER INSERT ON zzsh_order.finance_covered_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_opening_coverage_set();
CREATE FUNCTION zzsh_order.guard_finance_root() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER finance_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_root();
CREATE FUNCTION zzsh_order.guard_finance_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER finance_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_event();
ALTER TABLE zzsh_order.settlement_ledger_entry ALTER COLUMN posting_id DROP NOT NULL,
 ADD COLUMN finance_event_id text REFERENCES zzsh_order.finance_event(id),
 ADD CONSTRAINT settlement_ledger_exact_parent CHECK(num_nonnulls(posting_id,finance_event_id)=1),
 ADD CONSTRAINT finance_event_line_once UNIQUE(finance_event_id,line_no),
 DROP CONSTRAINT settlement_ledger_entry_account_code_check,DROP CONSTRAINT settlement_ledger_entry_check2;
ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK(
 (posting_id IS NOT NULL AND account_code IN ('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
 OR(finance_event_id IS NOT NULL AND account_code IN ('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE'))),
 ADD CONSTRAINT settlement_ledger_counterparty CHECK((account_code IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE') AND counterparty_user_id IS NOT NULL)
 OR(account_code NOT IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','WALLET_AVAILABLE') AND counterparty_user_id IS NULL));
DROP TRIGGER settlement_ledger_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER settlement_ledger_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.posting_id IS NOT NULL) EXECUTE FUNCTION zzsh_order.guard_settlement_ledger_entry();
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON zzsh_order.settlement_ledger_entry FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_finance_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
CREATE FUNCTION zzsh_order.check_finance_batch() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER finance_event_batch_guard AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_finance_batch();
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL) EXECUTE FUNCTION zzsh_order.check_finance_batch();
-- Fixed-source triggers only; runtime cannot directly update wallet metadata.
CREATE FUNCTION zzsh_order.finance_event_wallet_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES(NEW.subject_user_id,'RECONCILED_OPENING',basis.id,NEW.id);
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(NEW.subject_user_id,1,1)
 ON CONFLICT(user_id) DO UPDATE SET ledger_revision=zzsh_order.wallet_revision.ledger_revision+1,read_revision=zzsh_order.wallet_revision.read_revision+1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.finance_event_wallet_revision() FROM PUBLIC;
CREATE TRIGGER finance_event_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_event_wallet_revision();
CREATE FUNCTION zzsh_order.native_settlement_wallet_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
REVOKE ALL ON FUNCTION zzsh_order.native_settlement_wallet_revision() FROM PUBLIC;
CREATE TRIGGER native_settlement_revision AFTER INSERT ON zzsh_order.settlement_posting FOR EACH ROW EXECUTE FUNCTION zzsh_order.native_settlement_wallet_revision();
-- Grants are a separate exact Master-reviewed script. Runtime basis INSERT
-- exists only for guarded native zero; legacy proofs, covered sets and scopes
-- remain maintenance-only. Metadata UPDATE/DELETE and TRUNCATE must be denied.
-- No schema compilation, PG assertion, role grant or import was run here.

CREATE FUNCTION zzsh_order.guard_finance_observation() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
CREATE TRIGGER finance_observation_guard BEFORE INSERT ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_observation();

-- Runtime basis/covered/observation/scope writes and wallet metadata updates
-- remain denied. NATIVE_ZERO/INITIALIZE_NATIVE are not enabled in this prefix.
