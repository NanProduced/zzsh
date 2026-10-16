-- Q integration source candidate 0077_legacy_duty_finance. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/f-finance/implementation/legacy-duty-finance.sql
-- Source SHA256 fad5ddac15796f52141d29d983fb7ec2d3641e6ea93ce10557175fafb692d3ff; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE TABLE zzsh_order.legacy_duty_finance_contract (
 singleton boolean PRIMARY KEY CHECK(singleton),contract_version text NOT NULL CHECK(contract_version='legacy-duty-finance.v1'),
 enabled boolean NOT NULL CHECK(enabled),approval_ref text NOT NULL CHECK(length(approval_ref) BETWEEN 1 AND 128),
 approval_digest text NOT NULL CHECK(approval_digest~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- No INSERT here. An absent contract row leaves all new financial writes closed.
CREATE TRIGGER legacy_duty_contract_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_duty_finance_contract FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE TABLE zzsh_order.legacy_duty_finance_fact (
 duty_id text PRIMARY KEY REFERENCES zzsh_order.legacy_order_duty(id),order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),
 root_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 subject_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 kind text NOT NULL CHECK(kind IN('RENTER_REFUND','OWNER_CREDIT','COMMISSION','DEPOSIT_COMPENSATION')),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>=0),currency text NOT NULL CHECK(currency='CNY'),duty_revision bigint NOT NULL CHECK(duty_revision>0),
 effective_head_id text REFERENCES zzsh_order.legacy_continuation_version(id),effective_head_revision bigint,
 parent_source_digest text NOT NULL CHECK(parent_source_digest~'^[a-f0-9]{64}$'),source_record_digest text NOT NULL CHECK(source_record_digest~'^[a-f0-9]{64}$'),
 basis_facts_digest text NOT NULL CHECK(basis_facts_digest~'^[a-f0-9]{64}$'),effective_facts_digest text NOT NULL CHECK(effective_facts_digest~'^[a-f0-9]{64}$'),
 zero_finalization boolean NOT NULL,ref_type text NOT NULL CHECK(ref_type IN('LEDGER_ENTRY','FINANCE_EVENT')),ref_id text NOT NULL,
 facts_canonical text NOT NULL,facts_digest text NOT NULL CHECK(facts_digest~'^[a-f0-9]{64}$'),funding_canonical text NOT NULL,funding_digest text NOT NULL CHECK(funding_digest~'^[a-f0-9]{64}$'),
 approval_ref text NOT NULL,attempt text NOT NULL,actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),session_id text NOT NULL,request_id text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(zero_finalization=(amount_cents=0)),CHECK((amount_cents=0 AND ref_type='FINANCE_EVENT' AND ref_id=event_id) OR(amount_cents>0 AND ref_type='LEDGER_ENTRY')),
 CHECK((effective_head_id IS NULL)=(effective_head_revision IS NULL))
);
CREATE INDEX legacy_duty_finance_subject ON zzsh_order.legacy_duty_finance_fact(subject_user_id,created_at DESC,duty_id COLLATE "C" DESC);
CREATE TRIGGER legacy_duty_fact_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_duty_finance_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE FUNCTION zzsh_order.assert_legacy_finance_order_lock(order_id_value text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE key_value bigint;
BEGIN
 key_value:=('x'||substr(encode(sha256(convert_to(order_id_value,'UTF8')),'hex'),1,15))::bit(60)::bigint;
 IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
  AND classid=((key_value>>32)&4294967295)::oid AND objid=(key_value&4294967295)::oid AND objsubid=1)
 THEN RAISE EXCEPTION 'shared mapped-order advisory lock required' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION zzsh_order.assert_legacy_duty_funding(p jsonb,d zzsh_order.legacy_order_duty) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;c zzsh_order.personal_finance_observation_coverage;o zzsh_order.legacy_order_read_snapshot;
 actual_count bigint;actual_digest text;w jsonb;source_id_value text;entity_value text;types text[];
BEGIN
 SELECT basis.* INTO b FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis basis ON basis.id=wc.basis_id AND basis.user_id=wc.user_id
  WHERE wc.user_id=d.counterparty_user_id AND wc.origin='RECONCILED_OPENING' AND basis.source_kind='LEGACY_OPENING';
 SELECT * INTO c FROM zzsh_order.personal_finance_observation_coverage WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG' ORDER BY source_cutoff DESC,id COLLATE "C" DESC LIMIT 1;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=d.order_id;
 IF b.id IS NULL OR c.id IS NULL OR o.id IS NULL OR b.source_system<>'legacy_mysql_restore' OR c.source_system<>b.source_system OR c.legacy_user_id<>b.source_id
  OR c.source_entity<>'la_log_earnings' OR c.source_cutoff<>b.source_cutoff OR c.isolated_count<>0 OR c.source_count<>c.imported_count
 THEN RAISE EXCEPTION 'complete opening/history funding witness missing' USING ERRCODE='23514'; END IF;
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
   AND obs.snapshot->>'action'='1' AND (obs.snapshot->>'amount')::numeric>0 AND(NOT COALESCE(obs.snapshot->>'referenceType'=ANY(ARRAY['LEGACY_DISTRIBUTION_EARNING','LEGACY_RENTAL_REFUND','LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION','LEGACY_WITHDRAWAL','LEGACY_ADMIN_LOG']),false)
    OR obs.snapshot->>'referenceType'=ANY(types) AND(obs.snapshot->>'referenceId' IN(source_id_value,o.original_order_no) OR obs.snapshot->>'referenceSn'=o.original_order_no)
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_covered_event prior WHERE prior.basis_id=b.id AND prior.user_id=d.counterparty_user_id
     AND prior.source_kind=obs.snapshot->>'referenceType' AND prior.source_type='LEGACY_MYSQL' AND prior.source_entity=CASE obs.snapshot->>'referenceType'
      WHEN 'LEGACY_DISTRIBUTION_EARNING' THEN 'la_distribution_order' WHEN 'LEGACY_WITHDRAWAL' THEN 'la_withdraw_apply' WHEN 'LEGACY_ADMIN_LOG' THEN 'la_log_earnings' ELSE 'la_order' END
     AND prior.source_id=CASE WHEN obs.snapshot->>'referenceType'='LEGACY_ADMIN_LOG' THEN obs.source_id ELSE obs.snapshot->>'referenceId' END)))
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_fact other WHERE other.order_id=d.order_id AND other.kind=d.kind AND other.subject_user_id=d.counterparty_user_id
   AND(other.duty_id=d.id OR other.facts_canonical::jsonb#>>'{duty,sourceRecordId}'=d.source_record_id))
 THEN RAISE EXCEPTION 'legacy responsibility prior credit/posting not excluded' USING ERRCODE='23514'; END IF;
 w:=jsonb_build_object('openingBasisId',b.id,'openingSourceDigest',b.source_digest,'coveredSetDigest',b.covered_set_digest,
  'historyCoverageVersion',c.id||':'||c.imported_set_digest,'historyReferenceDigest',actual_digest,
  'historyCutoff',to_char(c.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceCount',actual_count::text);
 IF p->'witness' IS DISTINCT FROM w OR p->>'coverageEvidenceDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(w),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'funding DTO differs from immutable source witness' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION zzsh_order.guard_legacy_duty_finance_fact() RETURNS trigger LANGUAGE plpgsql AS $$
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
  OR p->>'originalSourceSystem' IS DISTINCT FROM 'legacy_mysql_restore' OR p->>'originalSourceDigest' IS DISTINCT FROM CASE WHEN d.kind='COMMISSION' THEN NEW.source_record_digest ELSE NEW.parent_source_digest END
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
 IF b->>'fundsDisposition' IS DISTINCT FROM CASE current_state WHEN '0' THEN 'AVAILABLE' WHEN '2' THEN 'HELD' WHEN '3' THEN 'CONFISCATED' ELSE 'UNKNOWN' END
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
    OR historical_record->>'is_settle' IS DISTINCT FROM CASE d.source_status WHEN 'DETAINED' THEN '2' WHEN 'COMPLETED_UNREFUNDED' THEN '0' END
    OR NOT(historical_record?'detain_money') OR historical_record->>'return_order_money' IS NULL
   OR NEW.basis_facts_digest IS DISTINCT FROM NEW.source_record_digest OR h.id IS NULL AND NEW.effective_facts_digest IS DISTINCT FROM NEW.source_record_digest
  THEN RAISE EXCEPTION 'historical refund raw snapshot differs' USING ERRCODE='23514'; END IF;
  current_net:=((historical_record->>'return_order_money')::numeric-GREATEST(COALESCE((historical_record->>'detain_money')::numeric,0),0))*100;
  IF current_net IS DISTINCT FROM d.amount_cents THEN RAISE EXCEPTION 'historical net refund differs' USING ERRCODE='23514'; END IF;
 ELSE
  IF b->>'kind' IS DISTINCT FROM CASE WHEN d.kind='DEPOSIT_COMPENSATION' THEN 'CONFISCATED_CONTINUATION' ELSE 'CONFIRMED_CONTINUATION' END
   OR d.admission_id IS NOT NULL OR b->>'sourceTimeKind' IS DISTINCT FROM CASE WHEN d.kind='DEPOSIT_COMPENSATION' THEN 'DISPOSED_AT' ELSE 'CONFIRMED_AT' END
   OR b->>'sourceRecordEntity' IS DISTINCT FROM CASE WHEN d.kind='COMMISSION' THEN 'la_distribution_order' ELSE 'legacy_continuation_version' END
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
END $$;
CREATE TRIGGER legacy_duty_fact_guard BEFORE INSERT ON zzsh_order.legacy_duty_finance_fact FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_duty_finance_fact();

-- Preserve T's exact historical exception and CAS guard; only the zero FINANCE ref shape is added.
ALTER TABLE zzsh_order.legacy_order_duty DROP CONSTRAINT legacy_duty_settlement_shape,
 ADD CONSTRAINT legacy_duty_settlement_shape CHECK(((status<>'SETTLED' AND settled_by IS NULL AND settled_ref_type IS NULL AND settled_ref_id IS NULL AND settled_ref_digest IS NULL)
  OR(status='SETTLED' AND settled_by='LEGACY_RECORDS' AND source='LEGACY_IMPORT' AND kind='DEPOSIT_COMPENSATION' AND source_status='POSTED_CONFISCATION'
   AND settled_ref_type IS NULL AND settled_ref_id IS NULL AND settled_ref_digest IS NULL)
  OR(status='SETTLED' AND settled_by='FINANCE' AND settled_ref_id IS NOT NULL AND settled_ref_digest~'^[a-f0-9]{64}$'
   AND((amount_cents>0 AND settled_ref_type='LEDGER_ENTRY') OR(amount_cents=0 AND settled_ref_type='FINANCE_EVENT')))) IS TRUE);

ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
 OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE','LEGACY_CONTINUATION_DUTY') AND basis_id IS NULL));
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED','GUARANTEE_CAPTURE','GUARANTEE_REFUND','LEGACY_DUTY_SETTLED'));
ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts,
 ADD CONSTRAINT settlement_ledger_accounts CHECK((posting_id IS NOT NULL AND account_code IN('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
 OR(finance_event_id IS NOT NULL AND account_code IN('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE','WALLET_RESERVED','PAYOUT_CLEARING','WITHDRAW_FEE','WALLET_PENDING_EARNINGS','DISTRIBUTION_EXPENSE','GUARANTEE_CASH','GUARANTEE_HELD','LEGACY_LIABILITY_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE')));

CREATE FUNCTION zzsh_order.guard_legacy_duty_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE root_id=NEW.id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'LEGACY_CONTINUATION'
  OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'legacy_order_duty' OR NEW.source_id<>f.duty_id OR NEW.subject_user_id<>f.subject_user_id
  OR NEW.source_digest<>f.facts_digest OR NEW.beneficiary_role<>f.kind OR NEW.policy_version IS NOT NULL
 THEN RAISE EXCEPTION 'legacy duty root is not its final fact' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER legacy_duty_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW WHEN(NEW.source_kind='LEGACY_CONTINUATION_DUTY') EXECUTE FUNCTION zzsh_order.guard_legacy_duty_root();
CREATE FUNCTION zzsh_order.guard_legacy_duty_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;revision_value bigint;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE event_id=NEW.id;
 SELECT COALESCE(ledger_revision,0) INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR NEW.economic_root_id<>f.root_id OR NEW.subject_user_id<>f.subject_user_id
  OR NEW.expected_ledger_revision IS DISTINCT FROM COALESCE(revision_value,0)
 THEN RAISE EXCEPTION 'legacy duty event is not its current final fact' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_duty_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_DUTY_SETTLED') EXECUTE FUNCTION zzsh_order.guard_legacy_duty_event();

CREATE FUNCTION zzsh_order.assert_legacy_duty_complete(duty_id_value text) RETURNS void LANGUAGE plpgsql AS $$
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
 IF line_count<>CASE WHEN f.amount_cents=0 THEN 0 ELSE 2 END OR debits<>f.amount_cents OR credits<>f.amount_cents OR good<>line_count
  OR(f.amount_cents=0 AND(f.ref_type<>'FINANCE_EVENT' OR f.ref_id<>f.event_id)) OR(f.amount_cents>0 AND f.ref_type<>'LEDGER_ENTRY')
 THEN RAISE EXCEPTION 'legacy duty positive/zero complete batch mismatch' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION zzsh_order.guard_legacy_duty_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f zzsh_order.legacy_duty_finance_fact;e zzsh_order.finance_event;
BEGIN
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=NEW.details->>'legacyDutyId';SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR e.kind IS DISTINCT FROM 'LEGACY_DUTY_SETTLED' OR e.economic_root_id IS DISTINCT FROM f.root_id
  OR NEW.finance_event_id IS DISTINCT FROM f.event_id OR f.zero_finalization OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('legacyDutyId',f.duty_id,'legacyOrderId',f.order_id,'legacyOrderNumber',f.funding_canonical::jsonb->>'originalOrderNumber','factsDigest',f.facts_digest)
 THEN RAISE EXCEPTION 'legacy duty entry requires exact positive fact' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER legacy_duty_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyDutyId') EXECUTE FUNCTION zzsh_order.guard_legacy_duty_entry();
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId') AND NOT(NEW.details?'legacyDutyId')) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId') AND NOT(NEW.details?'legacyDutyId')) EXECUTE FUNCTION zzsh_order.check_finance_batch();

CREATE FUNCTION zzsh_order.check_legacy_duty_batch() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER legacy_duty_fact_batch AFTER INSERT ON zzsh_order.legacy_duty_finance_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();
CREATE CONSTRAINT TRIGGER legacy_duty_event_batch AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='LEGACY_DUTY_SETTLED') EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();
CREATE CONSTRAINT TRIGGER legacy_duty_entry_batch AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyDutyId') EXECUTE FUNCTION zzsh_order.check_legacy_duty_batch();

CREATE OR REPLACE FUNCTION zzsh_order.assert_legacy_duty_finance_transition(old_row zzsh_order.legacy_order_duty,new_row zzsh_order.legacy_order_duty) RETURNS void LANGUAGE plpgsql AS $$
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

-- Legacy duty creates ledger/read revisions only, never new wallet coverage or native origin.
CREATE TRIGGER legacy_duty_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_DUTY_SETTLED') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();
REVOKE ALL ON zzsh_order.legacy_duty_finance_fact,zzsh_order.legacy_duty_finance_contract FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.assert_legacy_duty_complete(text),zzsh_order.assert_legacy_finance_order_lock(text) FROM PUBLIC;
-- Q: runtime SELECT only; actual trusted maintenance INSERT/UPDATE privileges are separately scoped.
-- T: add FINANCE_EVENT to its ref enum only under the accepted zero-finalization contract.

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.assert_legacy_duty_funding(jsonb,zzsh_order.legacy_order_duty) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_duty_finance_fact() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_duty_root() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_duty_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_duty_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_duty_batch() FROM PUBLIC;
