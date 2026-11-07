-- A confirmed user retains their own identity; the generated keys preserve the original actor foreign keys.
ALTER TABLE zzsh_order.legacy_duty_finance_fact
 DROP CONSTRAINT legacy_duty_finance_fact_actor_id_fkey,
 ADD COLUMN actor_realm text NOT NULL DEFAULT 'admin' CONSTRAINT legacy_duty_finance_fact_actor_realm_check CHECK(actor_realm IN('admin','user','system')),
 ADD COLUMN admin_actor_id text GENERATED ALWAYS AS (CASE WHEN actor_realm='admin' THEN actor_id END) STORED,
 ADD COLUMN user_actor_id text GENERATED ALWAYS AS (CASE WHEN actor_realm='user' THEN actor_id END) STORED,
 ADD CONSTRAINT legacy_duty_finance_admin_actor_fkey FOREIGN KEY(admin_actor_id) REFERENCES zzsh_auth_admin."user"(id),
 ADD CONSTRAINT legacy_duty_finance_user_actor_fkey FOREIGN KEY(user_actor_id) REFERENCES zzsh_auth_user."user"(id);

--> statement-breakpoint
CREATE INDEX legacy_commission_due_idx ON zzsh_order.legacy_order_duty(maturity_at,id COLLATE "C")
 WHERE kind='COMMISSION' AND status IN('PENDING','MATURED') AND (continuation_version_id IS NOT NULL OR admission_id IS NOT NULL);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_legacy_duty_finance_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d zzsh_order.legacy_order_duty;o zzsh_order.legacy_order_read_snapshot;h zzsh_order.legacy_continuation_version;
 e zzsh_order.legacy_continuation_evidence;a zzsh_order.legacy_order_duty_admission;f jsonb;b jsonb;p jsonb;historical_record jsonb;current_state text;current_net numeric;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_contract WHERE singleton AND enabled AND contract_version='legacy-duty-finance.v1')
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM NEW.actor_realm OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.actor_id
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
END $$;

--> statement-breakpoint
-- Runtime legacy duties reuse the existing immutable source and balanced-ledger guards.
INSERT INTO zzsh_order.legacy_duty_finance_contract(singleton,contract_version,enabled,approval_ref,approval_digest)
 VALUES(true,'legacy-duty-finance.v1',true,'runtime:legacy-finance-duty:v1',encode(sha256(convert_to('runtime:legacy-finance-duty:v1','UTF8')),'hex'))
 ON CONFLICT(singleton) DO NOTHING;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_contract WHERE singleton AND enabled
  AND contract_version='legacy-duty-finance.v1' AND approval_ref='runtime:legacy-finance-duty:v1'
  AND approval_digest=encode(sha256(convert_to('runtime:legacy-finance-duty:v1','UTF8')),'hex'))
 THEN RAISE EXCEPTION 'existing legacy finance contract requires explicit reconciliation' USING ERRCODE='55000';END IF;
END $$;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.post_legacy_finance_duty(facts_text text,funding_text text,reason_text text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE facts jsonb; funding jsonb; basis jsonb; d zzsh_order.legacy_order_duty; o zzsh_order.legacy_order_read_snapshot;
 actor_value text:=current_setting('zzsh.actor_id',true); session_value text:=current_setting('zzsh.session_id',true);
 actor_realm text:=current_setting('zzsh.actor_type',true); request_value text:=current_setting('zzsh.request_id',true); boss boolean; revision_value bigint;
 digest_value text; funding_digest text; suffix text; root_value text; event_value text; entry_value text; reference_type text;
BEGIN
 IF COALESCE(actor_realm,'') NOT IN('admin','user','system') OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0
  OR COALESCE(length(request_value),0)=0 OR length(request_value)>128 OR reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 3 AND 500
  OR facts_text IS NULL OR funding_text IS NULL OR octet_length(facts_text)>262144 OR octet_length(funding_text)>262144
 THEN RAISE EXCEPTION 'legacy owner credit command context unavailable' USING ERRCODE='23514'; END IF;
 facts:=facts_text::jsonb;funding:=funding_text::jsonb;basis:=facts->'basis';
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=facts#>>'{duty,id}' FOR UPDATE;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=d.order_id;
 IF d.id IS NULL OR o.id IS NULL OR NOT((d.kind IN('OWNER_CREDIT','RENTER_REFUND') AND d.source='CONTINUATION' AND d.status='PENDING')
  OR(d.kind='COMMISSION' AND d.status='MATURED' AND d.maturity_at IS NOT NULL AND d.maturity_at<=clock_timestamp()))
  OR d.settled_by IS NOT NULL OR facts#>>'{duty,orderId}' IS DISTINCT FROM o.id
 THEN RAISE EXCEPTION 'legacy owner credit duty unavailable' USING ERRCODE='23514'; END IF;
 PERFORM zzsh_order.assert_legacy_finance_order_lock(d.order_id);
 IF actor_realm='admin' THEN
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec
  JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin."session" s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required
   AND NOT u.suspended AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp()
  FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'legacy owner credit session unavailable' USING ERRCODE='42501'; END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM (VALUES('order.legacy.continue'),('order.settlement.write'),('finance.document.read')) required(code)
   WHERE (required.code<>'finance.document.read' OR d.kind='COMMISSION') AND (
    EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission deny WHERE deny.admin_user_id=actor_value AND deny.permission_code=required.code AND deny.effect='DENY')
    OR NOT (EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission allow WHERE allow.admin_user_id=actor_value AND allow.permission_code=required.code AND allow.effect='ALLOW')
      OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
        JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code=required.code))))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
    OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=o.game_id))))
 THEN RAISE EXCEPTION 'legacy owner credit permission unavailable' USING ERRCODE='42501'; END IF;
 ELSIF actor_realm='user' THEN
  IF d.kind<>'OWNER_CREDIT' OR d.source<>'CONTINUATION' OR actor_value NOT IN(o.owner_user_id,o.renter_user_id)
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId"=u.id
    JOIN zzsh_iam.user_identity_state identity ON identity.user_id=u.id
    WHERE u.id=actor_value AND NOT u.suspended AND identity.account_status='ACTIVE' AND s.id=session_value AND s."expiresAt">clock_timestamp())
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v JOIN zzsh_iam.audit_event a
     ON a.object_id=v.order_id AND a.action='order.legacy.continuation.confirm' AND a.outcome='SUCCESS'
     AND a.actor_type='user' AND a.actor_id=actor_value AND a.session_id=session_value AND a.request_id=request_value AND a.details->>'versionId'=v.id
    WHERE v.id=d.continuation_version_id AND v.order_id=d.order_id AND v.command='CONFIRM' AND v.stage=4
     AND v.created_xid=pg_current_xact_id() AND v.actor->>'realm'='user' AND v.actor->>'userId'=actor_value
     AND v.actor->>'sessionId'=session_value AND v.actor->>'requestId'=request_value)
  THEN RAISE EXCEPTION 'legacy owner credit confirmation authority unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  IF actor_value<>'legacy-commission-due' OR session_value<>'system' OR d.kind<>'COMMISSION' OR o.source_pay_status<>1
   OR request_value IS DISTINCT FROM 'legacy-due-'||substr(encode(sha256(convert_to(d.id,'UTF8')),'hex'),1,40)
   OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND mode='ExclusiveLock'
     AND granted AND objsubid=1 AND classid='0'::oid AND objid='806007'::oid)
   OR NOT ((o.source_order_status IN(3,8,9) AND d.admission_id IS NULL AND EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v
      WHERE v.id=d.continuation_version_id AND v.order_id=d.order_id AND v.command='CONFIRM' AND v.stage=4))
    OR (o.source_order_status=4 AND d.continuation_version_id IS NULL AND EXISTS(SELECT 1 FROM zzsh_order.legacy_order_duty_admission a
      WHERE a.id=d.admission_id AND a.duty_id=d.id AND a.order_id=d.order_id)))
  THEN RAISE EXCEPTION 'legacy commission worker authority unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 digest_value:=encode(sha256(convert_to(facts_text,'UTF8')),'hex');funding_digest:=encode(sha256(convert_to(funding_text,'UTF8')),'hex');
 suffix:=substr(encode(sha256(convert_to(d.id,'UTF8')),'hex'),1,40);root_value:='legacy_duty_root_'||suffix;event_value:='legacy_duty_settled_'||suffix;
 entry_value:=CASE WHEN d.amount_cents=0 THEN event_value ELSE 'legacy_duty_cr_'||suffix END;
 reference_type:=CASE WHEN d.amount_cents=0 THEN 'FINANCE_EVENT' ELSE 'LEDGER_ENTRY' END;
 SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=d.counterparty_user_id;
 IF revision_value IS NULL THEN RAISE EXCEPTION 'legacy owner wallet unavailable' USING ERRCODE='23514'; END IF;
 SET CONSTRAINTS zzsh_order.legacy_duty_fact_batch,zzsh_order.legacy_duty_event_batch,zzsh_order.legacy_duty_entry_batch DEFERRED;
 INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,order_id,root_id,event_id,subject_user_id,kind,amount_cents,currency,duty_revision,
  effective_head_id,effective_head_revision,parent_source_digest,source_record_digest,basis_facts_digest,effective_facts_digest,zero_finalization,
  ref_type,ref_id,facts_canonical,facts_digest,funding_canonical,funding_digest,approval_ref,attempt,actor_id,actor_realm,session_id,request_id)
 VALUES(d.id,d.order_id,root_value,event_value,d.counterparty_user_id,d.kind,d.amount_cents,'CNY',d.revision,
  basis->>'effectiveHeadId',(basis->>'effectiveHeadRevision')::bigint,basis->>'parentSourceDigest',basis->>'sourceRecordDigest',basis->>'basisFactsDigest',basis->>'evidenceDigest',d.amount_cents=0,
  reference_type,entry_value,facts_text,digest_value,funding_text,funding_digest,'runtime:legacy-finance-duty:v1',request_value,actor_value,actor_realm,session_value,request_value);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
  VALUES(root_value,NULL,'LEGACY_CONTINUATION_DUTY','LEGACY_CONTINUATION','zzsh','legacy_order_duty',d.id,d.counterparty_user_id,d.kind,digest_value);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
  VALUES(event_value,root_value,'LEGACY_DUTY_SETTLED',d.counterparty_user_id,revision_value);
 IF d.amount_cents>0 THEN
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
   VALUES('legacy_duty_dr_'||suffix,event_value,1,CASE WHEN d.kind='COMMISSION' THEN 'DISTRIBUTION_EXPENSE' ELSE 'LEGACY_LIABILITY_SOURCE' END,d.amount_cents,0,NULL,
    jsonb_build_object('legacyDutyId',d.id,'legacyOrderId',d.order_id,'legacyOrderNumber',funding->>'originalOrderNumber','factsDigest',digest_value)),
   (entry_value,event_value,2,CASE WHEN d.kind='COMMISSION' THEN 'WALLET_AVAILABLE' WHEN d.kind='RENTER_REFUND' THEN 'RENTER_REFUND_PAYABLE' ELSE 'OWNER_AVAILABLE' END,0,d.amount_cents,d.counterparty_user_id,
    jsonb_build_object('legacyDutyId',d.id,'legacyOrderId',d.order_id,'legacyOrderNumber',funding->>'originalOrderNumber','factsDigest',digest_value));
 END IF;
 UPDATE zzsh_order.legacy_order_duty SET status='SETTLED',settled_by='FINANCE',settled_ref_type=reference_type,settled_ref_id=entry_value,
  settled_ref_digest=digest_value,revision=revision+1 WHERE id=d.id AND revision=d.revision AND status=d.status AND settled_by IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy owner credit duty changed' USING ERRCODE='40001'; END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
  VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),actor_realm,actor_value,session_value,CASE WHEN d.kind='COMMISSION' THEN 'order.legacy.commission.posted' WHEN d.kind='RENTER_REFUND' THEN 'order.legacy.refund_liability.posted' ELSE 'order.legacy.owner_credit.posted' END,'legacy_order_duty',d.id,'SUCCESS',request_value,
   trim(reason_text),clock_timestamp(),jsonb_build_object('orderId',d.order_id,'factsDigest',digest_value,'amountCents',d.amount_cents::text,'channelArrival','UNKNOWN'));
 SET CONSTRAINTS zzsh_order.legacy_duty_fact_batch,zzsh_order.legacy_duty_event_batch,zzsh_order.legacy_duty_entry_batch IMMEDIATE;
 RETURN jsonb_build_object('dutyId',d.id,'orderId',d.order_id,'amountCents',d.amount_cents::text,'reference',
  jsonb_build_object('type',reference_type,'id',entry_value,'digest',digest_value),'channelArrival','UNKNOWN');
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION zzsh_order.post_legacy_finance_duty(text,text,text) FROM PUBLIC;
