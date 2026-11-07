-- A legacy confirmation freezes its refund wait; old versions remain unknown, never silently recalculated.
ALTER TABLE zzsh_order.legacy_continuation_version
  ADD COLUMN refund_policy_revision bigint,
  ADD COLUMN refund_wait_days integer,
  ADD COLUMN refund_due_at timestamptz,
  ADD CONSTRAINT legacy_refund_wait_shape CHECK (
    (refund_policy_revision IS NULL AND refund_wait_days IS NULL AND refund_due_at IS NULL)
    OR (command='CONFIRM' AND refund_policy_revision IS NOT NULL AND refund_policy_revision > 0
      AND refund_wait_days IS NOT NULL AND refund_wait_days BETWEEN 0 AND 365 AND refund_due_at IS NOT NULL
      AND refund_due_at = created_at + refund_wait_days * interval '24 hours')
  );

CREATE FUNCTION zzsh_order.freeze_legacy_refund_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy record;
BEGIN
  IF NEW.command='CONFIRM' THEN
    SELECT revision,normal_days,early_days INTO policy FROM zzsh_order.settlement_refund_policy WHERE singleton FOR SHARE;
    IF policy IS NULL OR NEW.created_at IS NULL OR NEW.created_at > clock_timestamp() + interval '1 second'
      OR NEW.created_at < clock_timestamp() - interval '5 minutes' THEN
      RAISE EXCEPTION 'legacy refund policy or confirmation time unavailable' USING ERRCODE='23514';
    END IF;
    NEW.refund_policy_revision:=policy.revision;
    NEW.refund_wait_days:=CASE WHEN NEW.is_advance_set=1 THEN policy.early_days ELSE policy.normal_days END;
    NEW.refund_due_at:=NEW.created_at + NEW.refund_wait_days * interval '24 hours';
  ELSIF NEW.refund_policy_revision IS NOT NULL OR NEW.refund_wait_days IS NOT NULL OR NEW.refund_due_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a confirmed legacy settlement has a refund schedule' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_wait_freeze BEFORE INSERT ON zzsh_order.legacy_continuation_version
FOR EACH ROW EXECUTE FUNCTION zzsh_order.freeze_legacy_refund_wait();

CREATE FUNCTION zzsh_order.guard_legacy_refund_due() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duty zzsh_order.legacy_order_duty; due_at timestamptz;
BEGIN
  IF NEW.kind='RENTER_REFUND' THEN
    SELECT * INTO duty FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
    IF duty.source='CONTINUATION' THEN
      SELECT refund_due_at INTO due_at FROM zzsh_order.legacy_continuation_version
        WHERE id=duty.continuation_version_id AND order_id=duty.order_id AND command='CONFIRM';
      IF due_at IS NULL OR due_at>clock_timestamp() THEN
        RAISE EXCEPTION 'legacy refund is not yet due or its deadline is unknown' USING ERRCODE='23514';
      END IF;
    ELSIF duty.source='LEGACY_IMPORT' THEN
      SELECT source_completed_at INTO due_at FROM zzsh_order.legacy_order_read_snapshot
        WHERE id=duty.order_id AND source_order_status=4 AND source_pay_status=1
          AND source_snapshot->>'is_settle'=CASE duty.source_status WHEN 'COMPLETED_UNREFUNDED' THEN '0' WHEN 'DETAINED' THEN '2' END;
      IF NOT COALESCE(duty.source_status IN('COMPLETED_UNREFUNDED','DETAINED'),false) OR due_at IS NULL OR due_at>clock_timestamp()
        OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.legacy.refund.reviewed'
          AND a.object_type='legacy_order_duty' AND a.object_id=duty.id AND a.outcome='SUCCESS' AND a.actor_type='admin'
          AND a.actor_id=current_setting('zzsh.actor_id',true) AND a.session_id=current_setting('zzsh.session_id',true)
          AND a.request_id=current_setting('zzsh.request_id',true) AND a.details->>'noUnresolvedRefunds'='true'
          AND a.details->>'historicalDueVerified'='true' AND (a.details->>'reviewedAt')::timestamptz BETWEEN due_at AND clock_timestamp()
          AND (duty.source_status<>'DETAINED' OR a.details->>'historicalReleaseVerified'='true')
          AND a.details->>'channelResult'='NOT_SUBMITTED' AND a.details->>'sourceDigest'=duty.source_digest) THEN
        RAISE EXCEPTION 'historical refund needs a due date and staff review' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_due_guard BEFORE INSERT ON zzsh_order.legacy_duty_finance_fact
FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_due();

REVOKE ALL ON FUNCTION zzsh_order.freeze_legacy_refund_wait(), zzsh_order.guard_legacy_refund_due() FROM PUBLIC;
