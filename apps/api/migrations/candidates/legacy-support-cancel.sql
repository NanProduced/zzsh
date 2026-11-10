-- 旧单客服特殊取消沿用旧单版本、责任及原路退款链，不生成新平台付款事实。
DO $prefix$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.check_legacy_continuation_result()','051c4a1bd48cd61ea01e38e6ea9be19c2c984fd0f5962134aeab0e368b39b768'),
  ('zzsh_order.guard_legacy_duty()','4a846afe1dbd6f92ad6141955af02da594963109d4e7c097f8aab9357992e44b'),
  ('zzsh_order.freeze_legacy_refund_wait()','fcfea1a3a70f65ae7400fea6f4b97dce55318fbe1a2a473e2faf89cfe77366fc'),
  ('zzsh_order.guard_legacy_refund_due()','df2a9bcae70a627577cb997d34954c9b3bcaac410816bbfe08bb8fd93cee0716'),
  ('zzsh_order.guard_legacy_duty_finance_fact()','00010e9a990ab9f35ddbd87c153e08b1fe975d39f6ade08e59a0a18b50c9a8c4'),
  ('zzsh_order.guard_legacy_refund_case()','0c95ffc5bffefe1bc26e289c57193d0e3eb44cc2670386ea1b87ac424707c38f'),
  ('zzsh_order.create_legacy_refund_case(text)','cc19296cd6c8fbf47ec8c708ba6e37734a53ff7ea128a506855c264a3c11287c')
 ) expected(signature,digest) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
 WHERE p.oid IS NULL OR encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex') IS DISTINCT FROM expected.digest)
 THEN RAISE EXCEPTION 'legacy cancellation guard prefix differs' USING ERRCODE='55000';END IF;
END $prefix$;

ALTER TABLE zzsh_order.legacy_continuation_version
 DROP CONSTRAINT legacy_continuation_version_command_check,
 ADD CONSTRAINT legacy_continuation_version_command_check CHECK(command IN('PROPOSE','CONFIRM','REJECT','HOLD','RELEASE','CONFISCATE','SUPPORT_CANCEL')),
 DROP CONSTRAINT legacy_continuation_version_stage_check,
 ADD CONSTRAINT legacy_continuation_version_stage_check CHECK(stage IN(3,8,9,4,5)),
 DROP CONSTRAINT legacy_refund_wait_shape,
 ADD CONSTRAINT legacy_refund_wait_shape CHECK(
  (refund_policy_revision IS NULL AND refund_wait_days IS NULL AND refund_due_at IS NULL)
  OR(command IN('CONFIRM','SUPPORT_CANCEL') AND refund_policy_revision IS NOT NULL AND refund_policy_revision>0
    AND refund_wait_days IS NOT NULL AND refund_wait_days BETWEEN 0 AND 365 AND refund_due_at IS NOT NULL
    AND refund_due_at=created_at+refund_wait_days*interval '24 hours'
    AND(command<>'SUPPORT_CANCEL' OR refund_wait_days=0)));
COMMENT ON CONSTRAINT legacy_continuation_version_command_check ON zzsh_order.legacy_continuation_version IS '旧单续办指令；客服特殊取消使用独立指令';
COMMENT ON CONSTRAINT legacy_continuation_version_stage_check ON zzsh_order.legacy_continuation_version IS '旧单续办阶段；5 为客服取消';
COMMENT ON CONSTRAINT legacy_refund_wait_shape ON zzsh_order.legacy_continuation_version IS '正常结算冻结退款等待期；客服特殊取消立即到期';

CREATE OR REPLACE FUNCTION zzsh_order.freeze_legacy_refund_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy record;
BEGIN
 IF NEW.command IN('CONFIRM','SUPPORT_CANCEL') THEN
  SELECT revision,normal_days,early_days INTO policy FROM zzsh_order.settlement_refund_policy WHERE singleton FOR SHARE;
  IF policy IS NULL OR NEW.created_at IS NULL OR NEW.created_at>clock_timestamp()+interval '1 second'
    OR NEW.created_at<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'legacy refund policy or operation time unavailable' USING ERRCODE='23514';END IF;
  NEW.refund_policy_revision:=policy.revision;
  NEW.refund_wait_days:=CASE WHEN NEW.command='SUPPORT_CANCEL' THEN 0 WHEN NEW.is_advance_set=1 THEN policy.early_days ELSE policy.normal_days END;
  NEW.refund_due_at:=NEW.created_at+NEW.refund_wait_days*interval '24 hours';
 ELSIF NEW.refund_policy_revision IS NOT NULL OR NEW.refund_wait_days IS NOT NULL OR NEW.refund_due_at IS NOT NULL THEN
  RAISE EXCEPTION 'legacy refund schedule is not applicable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.freeze_legacy_refund_wait() IS '冻结旧单结算退款等待期；客服特殊取消立即到期';

DO $patch$
DECLARE f text;needle text;updated text;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')) INTO f;
 needle:='i.admission<>''PARAMETER_COMPLETE'' OR r.admission<>''PARAMETER_COMPLETE''';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy continuation admission guard differs';END IF;
 f:=replace(f,needle,'(NEW.command<>''SUPPORT_CANCEL'' AND (i.admission<>''PARAMETER_COMPLETE'' OR r.admission<>''PARAMETER_COMPLETE'')) OR (NEW.command=''SUPPORT_CANCEL'' AND i.admission IS DISTINCT FROM r.admission)');
 needle:='   OR(NEW.command=''REJECT'' AND NEW.stage=3 AND NEW.actor->>''realm''=''user''';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy continuation transition guard differs';END IF;
 updated:=replace(f,needle,$branch$
   OR(NEW.command='SUPPORT_CANCEL' AND NEW.stage=5 AND s IN(3,8,9) AND d IN(0,2) AND NEW.is_settle=0
    AND NEW.actor->>'realm'='admin' AND l.source_pay_status=1 AND l.recorded_paid_amount_cents>0
    AND current_setting('zzsh.actor_type',true)='admin' AND current_setting('zzsh.actor_id',true)=NEW.actor->>'userId'
    AND current_setting('zzsh.session_id',true)=NEW.actor->>'sessionId' AND current_setting('zzsh.request_id',true)=NEW.actor->>'requestId'
    AND CASE WHEN jsonb_typeof(i.facts#>'{evidence,source,paidPay}')='array' THEN jsonb_array_length(i.facts#>'{evidence,source,paidPay}')=1 ELSE false END
    AND i.facts#>>'{evidence,source,legacyOrderId}'=l.legacy_id AND i.facts#>>'{evidence,source,renterId}'=l.legacy_renter_id
    AND i.facts#>>'{evidence,source,ownerId}'=l.legacy_owner_id AND i.facts#>>'{evidence,source,accountId}'=l.legacy_account_id
    AND COALESCE(i.facts#>>'{evidence,source,paidPay,0,id}','')~'^[1-9][0-9]{0,23}$'
    AND COALESCE(i.facts#>>'{evidence,source,paidPay,0,payOrderSn}','')~'^[A-Za-z0-9_-]{1,50}$'
    AND (i.facts#>'{evidence,source,paidPay,0,orderId}' IS NULL OR i.facts#>>'{evidence,source,paidPay,0,orderId}'=l.legacy_id)
    AND jsonb_typeof(i.facts#>'{evidence,source,commissions}')='array'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.facts#>'{evidence,source,commissions}')='array' THEN i.facts#>'{evidence,source,commissions}' ELSE '[]'::jsonb END) c
      WHERE COALESCE(c->>'id','')!~'^[1-9][0-9]{0,23}$' OR COALESCE(c->>'beneficiaryId','')!~'^[1-9][0-9]{0,23}$'
       OR COALESCE(c->>'status','') NOT IN('1','3') OR (c->>'status'='1' AND (SELECT count(*) FROM zzsh_order.legacy_order_duty d
         WHERE d.order_id=NEW.order_id AND d.kind='COMMISSION' AND d.source_record_id=c->>'id')<>1))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.facts#>'{evidence,source,commissions}')='array' THEN i.facts#>'{evidence,source,commissions}' ELSE '[]'::jsonb END) c GROUP BY c->>'id' HAVING count(*)>1)
    AND COALESCE(i.facts#>>'{evidence,source,payMoney}','')~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$'
    AND (i.facts#>>'{evidence,source,payMoney}')::numeric*100=l.recorded_paid_amount_cents
    AND (i.facts#>>'{evidence,source,paidPay,0,payMoney}')::numeric*100=l.recorded_paid_amount_cents
    AND COALESCE(NEW.amounts->>'refundNet','')~'^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'
    AND COALESCE(NEW.amounts->>'ownerNet','')~'^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'
    AND COALESCE(NEW.amounts->>'platformContribution','')~'^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'
    AND ((NEW.amounts->>'refundNet')::numeric+(NEW.amounts->>'ownerNet')::numeric+(NEW.amounts->>'platformContribution')::numeric)*100=l.recorded_paid_amount_cents
    AND (NEW.amounts->>'commissionPool')::numeric=0 AND NEW.commission_revisions='[]'::jsonb
    AND r.facts#>>'{evidence,source,returnOrderMoney}'=NEW.amounts->>'refundNet'
    AND r.facts#>>'{evidence,source,saleEarnings}'=NEW.amounts->>'ownerNet'
    AND (r.facts#>>'{evidence,source,detainMoney}')::numeric=0 AND (r.facts#>>'{evidence,source,fullPayoutMoney}')::numeric=0
    AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_order_duty x WHERE x.order_id=NEW.order_id
      AND ((x.kind IN('RENTER_REFUND','OWNER_CREDIT') AND x.status='SETTLED' AND x.amount_cents>0 AND x.continuation_version_id IS DISTINCT FROM NEW.id)
        OR(x.kind='COMMISSION' AND x.status IN('PENDING','MATURED','SETTLED') AND x.amount_cents>0)))
    AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_auth_admin."user" u ON u.id=a.actor_id AND NOT u.suspended AND u."twoFactorEnabled"
      JOIN zzsh_auth_admin.session session ON session.id=a.session_id AND session."userId"=u.id AND NOT session.locked AND session."expiresAt">clock_timestamp()
      JOIN zzsh_iam.admin_security sec ON sec.admin_user_id=u.id AND sec.status='ACTIVE' AND NOT sec.password_change_required
      WHERE a.action='order.legacy.continuation.support_cancel' AND a.object_type='rental_order' AND a.object_id=NEW.order_id
       AND a.actor_type='admin' AND a.actor_id=NEW.actor->>'userId' AND a.session_id=NEW.actor->>'sessionId'
       AND a.request_id=NEW.actor->>'requestId' AND a.outcome='SUCCESS' AND a.details->>'versionId'=NEW.id
       AND a.details->>'inputEvidenceId'=NEW.input_evidence_id AND a.details->>'resultEvidenceId'=NEW.result_evidence_id
       AND a.details->>'originalPaymentChecked'='true' AND a.details->>'paymentReviewScope' IN('OPERATOR','SIMULATED','UNAVAILABLE')
       AND length(btrim(a.details->>'supportReason')) BETWEEN 3 AND 500
       AND (sec.is_boss OR (NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission deny WHERE deny.admin_user_id=u.id
          AND deny.effect='DENY' AND deny.permission_code IN('order.read','order.legacy.continue','order.settlement.write'))
        AND NOT EXISTS(SELECT 1 FROM (VALUES('order.read'),('order.legacy.continue'),('order.settlement.write')) required(code)
          WHERE NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission allow WHERE allow.admin_user_id=u.id AND allow.effect='ALLOW' AND allow.permission_code=required.code)
           AND NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
             JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=u.id AND rp.permission_code=required.code))
        AND (sec.game_scope_mode='ALL_GAMES' OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=u.id AND scope.game_id=l.game_id))))))
   OR(NEW.command='REJECT' AND NEW.stage=3 AND NEW.actor->>'realm'='user'$branch$);
 IF updated=f THEN RAISE EXCEPTION 'legacy cancellation transition not installed';END IF;
 EXECUTE updated;
END $patch$;

DO $patch$
DECLARE f text;needle text;updated text;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_legacy_duty_finance_fact()')) INTO f;
 needle:='CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''CONFISCATED_CONTINUATION'' ELSE ''CONFIRMED_CONTINUATION'' END';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy duty basis guard differs';END IF;
 f:=replace(f,needle,'CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''CONFISCATED_CONTINUATION'' WHEN b->>''kind''=''SUPPORT_CANCELLED_CONTINUATION'' AND d.kind IN(''OWNER_CREDIT'',''RENTER_REFUND'') THEN ''SUPPORT_CANCELLED_CONTINUATION'' ELSE ''CONFIRMED_CONTINUATION'' END');
 needle:='CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''DISPOSED_AT'' ELSE ''CONFIRMED_AT'' END';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy duty time guard differs';END IF;
 f:=replace(f,needle,'CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''DISPOSED_AT'' WHEN b->>''kind''=''SUPPORT_CANCELLED_CONTINUATION'' THEN ''SUPPORT_CANCELLED_AT'' ELSE ''CONFIRMED_AT'' END');
 needle:='v.command=CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''CONFISCATE'' ELSE ''CONFIRM'' END';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy duty command guard differs';END IF;
 updated:=replace(f,needle,'v.command=CASE WHEN d.kind=''DEPOSIT_COMPENSATION'' THEN ''CONFISCATE'' WHEN b->>''kind''=''SUPPORT_CANCELLED_CONTINUATION'' THEN ''SUPPORT_CANCEL'' ELSE ''CONFIRM'' END');
 IF updated=f THEN RAISE EXCEPTION 'legacy cancellation duty guard not installed';END IF;
 EXECUTE updated;
END $patch$;

DO $patch$
DECLARE f text;needle text;updated text;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_legacy_duty()')) INTO f;
 needle:='AND audit_evt.details->>''parentSourceDigest''=NEW.source_digest AND(audit_evt.details->>''sourceStatus''=''3'' OR audit_evt.details->>''parentCancelledNotPayable''=''true''))';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy commission void guard differs';END IF;
 updated:=replace(f,needle,$branch$
   AND audit_evt.details->>'parentSourceDigest'=NEW.source_digest AND(audit_evt.details->>'sourceStatus'='3' OR audit_evt.details->>'parentCancelledNotPayable'='true'))
  AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v WHERE v.id=NEW.decision_evidence_ref AND v.order_id=NEW.order_id
    AND v.command='SUPPORT_CANCEL' AND v.stage=5 AND v.created_xid=pg_current_xact_id() AND NEW.decision_reason='ORDER_CANCELLED'
    AND NEW.decided_by=v.actor AND NEW.kind='COMMISSION')$branch$);
 IF updated=f THEN RAISE EXCEPTION 'legacy cancellation commission guard not installed';END IF;
 EXECUTE updated;
END $patch$;

DO $patch$
DECLARE f text;needle text;updated text;signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['zzsh_order.guard_legacy_refund_due()','zzsh_order.guard_legacy_refund_case()','zzsh_order.create_legacy_refund_case(text)'] LOOP
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO f;
  needle:='command=''CONFIRM''';
  IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy cancellation refund schedule guard differs: %',signature;END IF;
  updated:=replace(f,needle,'command IN(''CONFIRM'',''SUPPORT_CANCEL'')');
  IF updated=f THEN RAISE EXCEPTION 'legacy cancellation refund guard not installed: %',signature;END IF;
  IF signature='zzsh_order.guard_legacy_refund_case()' THEN
   needle:='e.admission=''PARAMETER_COMPLETE'' AND jsonb_typeof';
   IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'legacy refund admission guard differs';END IF;
   updated:=replace(updated,needle,'(e.admission=''PARAMETER_COMPLETE'' OR (e.admission=''ISOLATED'' AND EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version cancelled WHERE cancelled.id=d.continuation_version_id AND cancelled.order_id=d.order_id AND cancelled.command=''SUPPORT_CANCEL'' AND cancelled.stage=5))) AND jsonb_typeof');
  END IF;
  EXECUTE updated;
 END LOOP;
END $patch$;
