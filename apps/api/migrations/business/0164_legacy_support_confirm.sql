-- A named operator can confirm an existing legacy proposal without impersonating either user.
CREATE OR REPLACE FUNCTION zzsh_order.check_legacy_continuation_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR(NEW.command='PROPOSE' AND s=3 AND NEW.actor->>'realm'='admin' AND EXISTS (
     SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_auth_admin."user" u ON u.id=a.actor_id AND NOT u.suspended
      WHERE a.action='order.legacy.continuation.propose' AND a.object_type='rental_order' AND a.object_id=NEW.order_id
        AND a.actor_type='admin' AND a.actor_id=NEW.actor->>'userId' AND a.session_id=NEW.actor->>'sessionId'
        AND a.request_id=NEW.actor->>'requestId' AND a.outcome='SUCCESS'
        AND a.details->>'versionId'=NEW.id AND a.details->>'inputEvidenceId'=NEW.input_evidence_id
        AND a.details->>'resultEvidenceId'=NEW.result_evidence_id AND length(btrim(a.details->>'supportReason')) BETWEEN 3 AND 500
        AND ((NEW.stage=8 AND a.details->>'supportOnBehalf'='renter') OR (NEW.stage=9 AND a.details->>'supportOnBehalf'='owner'))
   ))
   OR(NEW.command='CONFIRM' AND NEW.stage=4 AND NEW.actor->>'realm'='user' AND((s=8 AND NEW.actor->>'userId'=l.owner_user_id) OR(s=9 AND NEW.actor->>'userId'=l.renter_user_id)))
   OR(NEW.command='CONFIRM' AND NEW.stage=4 AND s IN (8,9) AND NEW.actor->>'realm'='admin' AND EXISTS (
     SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_auth_admin."user" u ON u.id=a.actor_id AND NOT u.suspended
      WHERE a.action='order.legacy.continuation.confirm' AND a.object_type='rental_order' AND a.object_id=NEW.order_id
        AND a.actor_type='admin' AND a.actor_id=NEW.actor->>'userId' AND a.session_id=NEW.actor->>'sessionId'
        AND a.request_id=NEW.actor->>'requestId' AND a.outcome='SUCCESS'
        AND a.details->>'versionId'=NEW.id AND a.details->>'inputEvidenceId'=NEW.input_evidence_id
        AND a.details->>'resultEvidenceId'=NEW.result_evidence_id AND length(btrim(a.details->>'supportReason')) BETWEEN 3 AND 500
   ))
   OR(NEW.command='REJECT' AND NEW.stage=3 AND NEW.actor->>'realm'='user' AND((s=8 AND NEW.actor->>'userId'=l.owner_user_id) OR(s=9 AND NEW.actor->>'userId'=l.renter_user_id)))
   OR(NEW.command='REJECT' AND NEW.stage=3 AND s IN (8,9) AND NEW.actor->>'realm'='admin' AND EXISTS (
     SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_auth_admin."user" u ON u.id=a.actor_id AND NOT u.suspended
      WHERE a.action='order.legacy.continuation.reject' AND a.object_type='rental_order' AND a.object_id=NEW.order_id
        AND a.actor_type='admin' AND a.actor_id=NEW.actor->>'userId' AND a.session_id=NEW.actor->>'sessionId'
        AND a.request_id=NEW.actor->>'requestId' AND a.outcome='SUCCESS'
        AND a.details->>'versionId'=NEW.id AND a.details->>'inputEvidenceId'=NEW.input_evidence_id
        AND a.details->>'resultEvidenceId'=NEW.result_evidence_id AND length(btrim(a.details->>'supportReason')) BETWEEN 3 AND 500
   ))
   OR(NEW.actor->>'realm'='admin' AND NEW.stage=s AND((NEW.command='HOLD' AND d=0 AND NEW.is_settle=2) OR(NEW.command='RELEASE' AND d=2 AND NEW.is_settle=0) OR(NEW.command='CONFISCATE' AND d=2 AND NEW.is_settle=3)))
 ) IS NOT TRUE THEN RAISE EXCEPTION 'Legacy command transition or actor invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
