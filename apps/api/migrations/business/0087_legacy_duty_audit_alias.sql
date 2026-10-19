-- The admission record a and an audit SQL alias must not share a PL/pgSQL identifier.
CREATE OR REPLACE FUNCTION zzsh_order.guard_legacy_duty() RETURNS trigger LANGUAGE plpgsql AS $$
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
