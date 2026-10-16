-- Q integration source candidate 0074_legacy_trade_continuation. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/t-trade/implementation/migration-proposals/legacy-trade-continuation.sql
-- Source SHA256 39c753d21412b52e7abe862e2d1934f9d5b090b92c5c2818d4c8fe6bade94aef; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE TABLE zzsh_order.legacy_continuation_evidence (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),
 evidence_version bigint NOT NULL CHECK(evidence_version>0), source_kind text NOT NULL CHECK(source_kind IN('SOURCE_IMPORT','DERIVED')),
 derived_from_command_version_id text UNIQUE, source_as_of timestamptz NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 512),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'), parameter_digest text NOT NULL CHECK(parameter_digest~'^[a-f0-9]{64}$'),
 admission text NOT NULL CHECK(admission IN('PARAMETER_COMPLETE','ISOLATED')), reasons jsonb NOT NULL CHECK(jsonb_typeof(reasons)='array'),
 facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'), facts_canonical text NOT NULL CHECK(octet_length(facts_canonical)<=262144),
 facts_digest text NOT NULL CHECK(facts_digest=encode(sha256(convert_to(facts_canonical,'UTF8')),'hex')),
 UNIQUE(order_id,evidence_version), UNIQUE(order_id,id),
 CHECK(facts_canonical::jsonb=facts),
 CHECK((source_kind='SOURCE_IMPORT' AND derived_from_command_version_id IS NULL AND evidence_version=1)
    OR(source_kind='DERIVED' AND derived_from_command_version_id IS NOT NULL AND evidence_version>1))
);
CREATE UNIQUE INDEX legacy_continuation_one_import ON zzsh_order.legacy_continuation_evidence(order_id) WHERE source_kind='SOURCE_IMPORT';
CREATE TABLE zzsh_order.legacy_continuation_version (
 id text PRIMARY KEY,order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),revision bigint NOT NULL CHECK(revision>0),
 command text NOT NULL CHECK(command IN('PROPOSE','CONFIRM','REJECT','HOLD','RELEASE','CONFISCATE')),
 actor jsonb NOT NULL CHECK(jsonb_typeof(actor)='object'),input_evidence_id text NOT NULL,result_evidence_id text NOT NULL UNIQUE,
 stage int NOT NULL CHECK(stage IN(3,8,9,4)),is_settle int NOT NULL CHECK(is_settle IN(0,2,3)),is_advance_set int NOT NULL CHECK(is_advance_set IN(0,1)),
 amounts jsonb NOT NULL CHECK(jsonb_typeof(amounts)='object'),commission_revisions jsonb NOT NULL CHECK(jsonb_typeof(commission_revisions)='array'),assignments jsonb,
 plan_fingerprint text NOT NULL CHECK(plan_fingerprint~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),superseded_at timestamptz,
 UNIQUE(order_id,revision),UNIQUE(order_id,id),CHECK(input_evidence_id<>result_evidence_id),
 FOREIGN KEY(order_id,input_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(order_id,result_evidence_id) REFERENCES zzsh_order.legacy_continuation_evidence(order_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX legacy_continuation_one_head ON zzsh_order.legacy_continuation_version(order_id) WHERE superseded_at IS NULL;
ALTER TABLE zzsh_order.legacy_continuation_evidence ADD CONSTRAINT legacy_evidence_derived_version_fk
 FOREIGN KEY(order_id,derived_from_command_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE zzsh_order.legacy_order_duty (
 id text PRIMARY KEY,order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),continuation_version_id text,
 kind text NOT NULL CHECK(kind IN('RENTER_REFUND','OWNER_CREDIT','COMMISSION','DEPOSIT_COMPENSATION')),
 source_record_id text NOT NULL CHECK(length(source_record_id) BETWEEN 1 AND 128),counterparty_user_id text REFERENCES zzsh_auth_user."user"(id),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>=0),currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 status text NOT NULL CHECK(status IN('PENDING','MATURED','SETTLED','VOID')),source text NOT NULL CHECK(source IN('LEGACY_IMPORT','CONTINUATION')),
 source_status text,source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),level int CHECK(level IN(2,3)),ratio numeric(24,8),maturity_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),revised_at timestamptz,revised_by jsonb,revision_reason text,
 decided_at timestamptz,decided_by jsonb,decision_reason text,decision_evidence_ref text,
 settled_by text CHECK(settled_by IN('FINANCE','LEGACY_RECORDS')),settled_ref_type text,settled_ref_id text,settled_ref_digest text,
 admission_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(order_id,kind,source_record_id),UNIQUE(order_id,id),
 FOREIGN KEY(order_id,continuation_version_id) REFERENCES zzsh_order.legacy_continuation_version(order_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(kind='COMMISSION' OR maturity_at IS NULL),CHECK(kind='COMMISSION' OR level IS NULL AND ratio IS NULL),
 CHECK((kind<>'COMMISSION' OR(source_status='1' AND level IN(2,3) AND ratio>=0)) IS TRUE),
 CHECK(kind='DEPOSIT_COMPENSATION' OR counterparty_user_id IS NOT NULL),
 CONSTRAINT legacy_duty_settlement_shape CHECK(((status<>'SETTLED' AND settled_by IS NULL AND settled_ref_type IS NULL AND settled_ref_id IS NULL AND settled_ref_digest IS NULL)
   OR(status='SETTLED' AND settled_by='LEGACY_RECORDS' AND source='LEGACY_IMPORT' AND kind='DEPOSIT_COMPENSATION' AND source_status='POSTED_CONFISCATION'
      AND settled_ref_type IS NULL AND settled_ref_id IS NULL AND settled_ref_digest IS NULL)
   OR(status='SETTLED' AND settled_by='FINANCE' AND settled_ref_type IN('LEDGER_ENTRY','CORRECTION_ENTRY') AND settled_ref_id IS NOT NULL AND settled_ref_digest~'^[a-f0-9]{64}$')) IS TRUE)
);
CREATE INDEX legacy_order_duty_party_state ON zzsh_order.legacy_order_duty(counterparty_user_id,status,maturity_at,id);
-- Only the independent 208 completed-parent path uses this immutable source adjudication.
CREATE TABLE zzsh_order.legacy_order_duty_admission (
 id text PRIMARY KEY,duty_id text NOT NULL UNIQUE REFERENCES zzsh_order.legacy_order_duty(id) DEFERRABLE INITIALLY DEFERRED,
 order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),kind text NOT NULL CHECK(kind='COMMISSION'),source_record_id text NOT NULL,
 counterparty_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>=0),currency text NOT NULL CHECK(currency='CNY'),
 level int NOT NULL CHECK(level IN(2,3)),ratio numeric(24,8) NOT NULL CHECK(ratio>=0),parent_source_digest text NOT NULL CHECK(parent_source_digest~'^[a-f0-9]{64}$'),
 source_canonical text NOT NULL CHECK(octet_length(source_canonical)<=32768),source_record_digest text NOT NULL CHECK(source_record_digest=encode(sha256(convert_to(source_canonical,'UTF8')),'hex')),
 final_amount_evidence_canonical text NOT NULL,final_amount_evidence_digest text NOT NULL CHECK(final_amount_evidence_digest=encode(sha256(convert_to(final_amount_evidence_canonical,'UTF8')),'hex')),
 time_kind text NOT NULL CHECK(time_kind IN('COMPLETED_AT','MATURES_AT')),source_time timestamptz NOT NULL,source_time_value text NOT NULL,source_time_unit text NOT NULL CHECK(source_time_unit IN('UNIX_SECONDS','RFC3339_UTC')),time_evidence_canonical text NOT NULL,
 time_evidence_digest text NOT NULL CHECK(time_evidence_digest=encode(sha256(convert_to(time_evidence_canonical,'UTF8')),'hex')),cutoff timestamptz NOT NULL,maturity_at timestamptz NOT NULL,
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 512),admission_canonical text NOT NULL CHECK(octet_length(admission_canonical)<=131072),
 admission_digest text NOT NULL CHECK(admission_digest=encode(sha256(convert_to(admission_canonical,'UTF8')),'hex')),reviewed_by jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(order_id,kind,source_record_id),UNIQUE(order_id,id),
 CHECK(maturity_at=CASE WHEN time_kind='COMPLETED_AT' THEN source_time+interval '7 days' ELSE source_time END),
 CHECK((CASE WHEN source_time_unit='UNIX_SECONDS' THEN source_time_value~'^(0|[1-9][0-9]{0,11})$' AND source_time_value::numeric=extract(epoch FROM source_time) ELSE source_time_value::timestamptz=source_time END) IS TRUE)
);
ALTER TABLE zzsh_order.legacy_order_duty ADD CONSTRAINT legacy_duty_admission_fk FOREIGN KEY(order_id,admission_id) REFERENCES zzsh_order.legacy_order_duty_admission(order_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE zzsh_order.legacy_order_duty_revision (
 id text PRIMARY KEY,duty_id text NOT NULL REFERENCES zzsh_order.legacy_order_duty(id),revision bigint NOT NULL CHECK(revision>1),
 before_values jsonb NOT NULL,after_values jsonb NOT NULL,actor jsonb NOT NULL,source_command_version_id text NOT NULL REFERENCES zzsh_order.legacy_continuation_version(id) DEFERRABLE INITIALLY DEFERRED,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(duty_id,revision)
);
CREATE TABLE zzsh_order.legacy_inflight_register (
 id text PRIMARY KEY,source_system text NOT NULL CHECK(source_system='legacy_mysql_restore'),source_entity text NOT NULL CHECK(source_entity='la_order'),
 legacy_id text NOT NULL,account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 renter_user_id text REFERENCES zzsh_auth_user."user"(id),source_order_status int NOT NULL,source_pay_status int NOT NULL,
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),evidence_ref text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN('ISOLATED_PARTY','REVIEW_REQUIRED','UNKNOWN')),reason text NOT NULL,
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(source_system,source_entity,legacy_id)
);
CREATE INDEX legacy_inflight_account_disposition ON zzsh_order.legacy_inflight_register(account_id,disposition);

CREATE FUNCTION zzsh_order.guard_legacy_continuation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Legacy continuation evidence/decision is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER legacy_evidence_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_continuation_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();
CREATE TRIGGER legacy_duty_revision_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_order_duty_revision FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();
CREATE TRIGGER legacy_duty_admission_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_order_duty_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();
CREATE FUNCTION zzsh_order.check_legacy_duty_admission() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER legacy_duty_admission_complete AFTER INSERT ON zzsh_order.legacy_order_duty_admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_admission();
CREATE TRIGGER legacy_inflight_register_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_inflight_register FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_immutable();
CREATE FUNCTION zzsh_order.guard_legacy_continuation_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
   OR(to_jsonb(NEW)-'superseded_at') IS DISTINCT FROM(to_jsonb(OLD)-'superseded_at')
 THEN RAISE EXCEPTION 'Only a current legacy head may be superseded once' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_head_update BEFORE UPDATE OR DELETE ON zzsh_order.legacy_continuation_version FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_continuation_head();

CREATE FUNCTION zzsh_order.check_legacy_continuation_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER legacy_result_complete AFTER INSERT ON zzsh_order.legacy_continuation_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_continuation_result();

-- Same signature consumed by F. Until its reviewed physical fact adapter is installed, FINANCE is unreachable.
CREATE FUNCTION zzsh_order.assert_legacy_duty_finance_transition(old_row zzsh_order.legacy_order_duty,new_row zzsh_order.legacy_order_duty) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Legacy duty finance adapter unavailable' USING ERRCODE='23514'; END $$;
CREATE FUNCTION zzsh_order.guard_legacy_duty() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NEW.status='VOID' AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.id=NEW.decision_evidence_ref AND a.object_id=NEW.order_id
   AND a.action='order.legacy.duty.source_fact_reviewed' AND a.outcome='SUCCESS' AND a.details->>'sourceRecordId'=NEW.source_record_id
   AND a.details->>'parentSourceDigest'=NEW.source_digest AND(a.details->>'sourceStatus'='3' OR a.details->>'parentCancelledNotPayable'='true'))
  THEN RAISE EXCEPTION 'Commission void lacks reviewed source fact' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_duty_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.legacy_order_duty FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_duty();
CREATE FUNCTION zzsh_order.check_legacy_duty_revision() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER legacy_duty_revision_complete AFTER UPDATE ON zzsh_order.legacy_order_duty DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_revision();

ALTER TABLE zzsh_supply.rule_acceptance ADD COLUMN acceptance_kind text NOT NULL DEFAULT 'OWNER_ACCEPTED'
 CHECK(acceptance_kind IN('OWNER_ACCEPTED','LEGACY_TAKEOVER_AUTHORIZED')),ADD COLUMN authorization_evidence jsonb;
ALTER TABLE zzsh_supply.rule_acceptance ADD CONSTRAINT legacy_acceptance_shape CHECK((
 (acceptance_kind='OWNER_ACCEPTED' AND authorization_evidence IS NULL)
 OR(acceptance_kind='LEGACY_TAKEOVER_AUTHORIZED' AND jsonb_typeof(authorization_evidence)='object'
  AND full_payout_terms_version_id IS NULL AND full_payout_terms_digest IS NULL AND full_payout_disclosure_version IS NULL)) IS TRUE);
CREATE FUNCTION zzsh_supply.guard_legacy_takeover_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER legacy_takeover_authorization_guard BEFORE INSERT ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_takeover_authorization();

-- Q integrates the new permission without a default staff role grant, and applies runtime column ACL.
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES('order.legacy.continue','旧单续办','受权处理旧单续办与佣金成熟，财账终定独立') ON CONFLICT(code) DO NOTHING;
-- Runtime privileges are installed last with an exact configured role; sources/admission/register stay maintenance-only.

-- Source admissions are maintenance writes; ordinary O revisions of an imported duty remain allowed.
CREATE FUNCTION zzsh_order.guard_legacy_source_owner() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER a_legacy_evidence_source_owner BEFORE INSERT ON zzsh_order.legacy_continuation_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();
CREATE TRIGGER a_legacy_duty_source_owner BEFORE INSERT ON zzsh_order.legacy_order_duty FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();
CREATE TRIGGER a_legacy_admission_source_owner BEFORE INSERT ON zzsh_order.legacy_order_duty_admission FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();
CREATE TRIGGER a_legacy_register_source_owner BEFORE INSERT ON zzsh_order.legacy_inflight_register FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_source_owner();

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_continuation_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_duty_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_continuation_head() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_continuation_result() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.assert_legacy_duty_finance_transition(zzsh_order.legacy_order_duty,zzsh_order.legacy_order_duty) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_duty() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_duty_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_takeover_authorization() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_source_owner() FROM PUBLIC;

REVOKE ALL ON TABLE zzsh_order.legacy_continuation_evidence,zzsh_order.legacy_continuation_version,zzsh_order.legacy_order_duty,zzsh_order.legacy_order_duty_admission,zzsh_order.legacy_order_duty_revision,zzsh_order.legacy_inflight_register FROM PUBLIC;
