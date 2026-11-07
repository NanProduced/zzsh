-- Resume a reviewed native refund only for the original query; never release or duplicate its budget.
DO $$
BEGIN
 IF encode(sha256(convert_to(pg_get_functiondef('zzsh_order.guard_joinpay_refund_intent()'::regprocedure),'UTF8')),'hex')
   IS DISTINCT FROM 'ff6398bba91f3de14814893740232f7e1401bccae126a0d3f3dbd8f5885bb93a'
 THEN RAISE EXCEPTION 'native refund guard differs from accepted prefix' USING ERRCODE='55000';END IF;
END $$;

--> statement-breakpoint
CREATE TABLE zzsh_order.native_refund_review_resolution (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.channel_refund_intent(id),previous_revision bigint NOT NULL,
 actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),session_id text NOT NULL,request_id text NOT NULL,reason text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(intent_id,previous_revision)
);
CREATE TRIGGER native_refund_review_resolution_immutable BEFORE UPDATE OR DELETE ON zzsh_order.native_refund_review_resolution FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
REVOKE ALL ON zzsh_order.native_refund_review_resolution FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b record;paid_allocated numeric;responsibility_allocated numeric;proof zzsh_order.joinpay_refund_evidence;
 origin zzsh_order.joinpay_refund_observation;doc jsonb;basis_row record;lr zzsh_order.finance_economic_root;
 le zzsh_order.finance_event;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund allocation immutable' USING ERRCODE='40001';END IF;
 IF NEW.payment_source<>'JOINPAY' OR NEW.evidence_level<>'JOINPAY_FORMAL' THEN RAISE EXCEPTION 'formal refund source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   OR NEW.revision<>OLD.revision+1
  THEN RAISE EXCEPTION 'formal refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR OLD.requires_review OR NOT NEW.requires_review
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'formal refund terminal cannot change' USING ERRCODE='40001';END IF;
  ELSIF OLD.requires_review AND NOT NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['state','revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','requires_review','updated_at'])
    OR NEW.state<>'UNKNOWN' OR OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR OLD.terminal_evidence_id IS NOT NULL OR OLD.budget_disposition<>'ALLOCATED' OR OLD.lease_until IS NULL OR OLD.lease_until>clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.native_refund_review_resolution z WHERE z.intent_id=OLD.id AND z.previous_revision=OLD.revision
      AND z.created_xid=pg_current_xact_id() AND z.actor_id=current_setting('zzsh.actor_id',true)
      AND z.session_id=current_setting('zzsh.session_id',true) AND z.request_id=current_setting('zzsh.request_id',true))
   THEN RAISE EXCEPTION 'native refund review requires authorized original-query recovery' USING ERRCODE='23514';END IF;
  ELSIF NOT OLD.requires_review AND NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'refund conflict requires its original review observation' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
   SELECT * INTO proof FROM zzsh_order.joinpay_refund_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
   SELECT * INTO origin FROM zzsh_order.joinpay_refund_observation WHERE id=proof.observation_id;
   IF origin.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM origin.lease_version OR OLD.lease_owner IS DISTINCT FROM origin.lease_owner
    OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
   THEN RAISE EXCEPTION 'refund terminal lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
   IF OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR OLD.requires_review OR NEW.requires_review
    OR proof.id IS NULL OR proof.created_xid<>pg_current_xact_id()
    OR NEW.state IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END)
    OR NEW.budget_disposition IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'CONSUMED' ELSE 'RELEASED' END)
    OR NEW.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no OR NEW.completed_at IS DISTINCT FROM proof.completed_at
    OR NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal refund terminal lacks same transaction proof' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_version=OLD.lease_version+1 THEN
   IF (OLD.state='READY' AND OLD.requires_review) OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR OLD.due_at>clock_timestamp()
    OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL OR NEW.lease_until<=clock_timestamp()
    OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
    OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END)
    OR NEW.budget_disposition<>'ALLOCATED'
   THEN RAISE EXCEPTION 'formal refund lease not claimable' USING ERRCODE='40001';END IF;
   IF OLD.state='READY' AND EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_source='JOINPAY'
    AND x.merchant_identity_id=OLD.merchant_identity_id AND x.original_payment_trx_no=OLD.original_payment_trx_no AND x.requires_review)
   THEN RAISE EXCEPTION 'original payment refund submit requires review' USING ERRCODE='23514';END IF;
  ELSE
   IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.budget_disposition<>'ALLOCATED' OR NEW.state NOT IN('UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.created_xid=pg_current_xact_id()
      AND x.state_before=OLD.state AND x.state_after=NEW.state AND x.event IN('UNKNOWN','PROCESSING','REVIEW')
      AND(x.operation='NOTIFY' OR(x.lease_version=OLD.lease_version AND x.lease_owner=OLD.lease_owner AND OLD.lease_until>clock_timestamp())))
   THEN RAISE EXCEPTION 'formal refund update lacks live evidence' USING ERRCODE='40001';END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 doc:=NEW.initial_admission_canonical::jsonb;
 IF (doc->>'kind' IS DISTINCT FROM 'FORMAL_NATIVE_REFUND_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.initial_admission_ref
  OR doc->>'reviewSha256'!~'^[a-f0-9]{64}$' OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM NEW.merchant_identity_id OR doc->>'merchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=NEW.initial_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=NEW.initial_key_version_ref)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='NOTIFY')) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund initial server admission resource/profile mismatch' USING ERRCODE='23514';END IF;
 IF NEW.basis_kind='PRESTART_TERMINATION' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  IF NEW.posting_id IS NOT NULL OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 OR NEW.amount_cents>9999999999999999
   OR NEW.state<>'READY' OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.revision<>1 OR NEW.requires_review OR NEW.budget_disposition<>'ALLOCATED'
   OR NEW.terminal_evidence_id IS NOT NULL OR NEW.terminal_root_id IS NOT NULL OR NEW.terminal_event_id IS NOT NULL
   OR NEW.provider_refund_trx_no IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
    JOIN zzsh_order.payment_confirmation c ON c.id=t.payment_basis->>'paymentConfirmationId'
    JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=c.joinpay_request_id
    WHERE t.state='APPROVED' AND t.order_id=NEW.order_id AND c.id=NEW.payment_confirmation_id
     AND t.payment_basis->>'source'='JOINPAY' AND zzsh_order.prestart_liability_complete(t.id)
     AND NEW.renter_user_id=t.payment_basis->>'renterUserId' AND NEW.merchant_identity_id=c.merchant_scope_id
     AND NEW.original_payment_trx_no=c.provider_transaction_id AND NEW.original_payment_order_no=c.merchant_order_no
     AND NEW.amount_cents=c.amount_cents AND NEW.wire_merchant_no=bnd.wire_merchant_no AND NEW.due_at=t.approved_at
     AND NEW.responsibility_version_hash=t.basis_digest AND NEW.liability_root_id=t.liability_root_id AND NEW.liability_event_id=t.liability_event_id)
   OR(SELECT count(DISTINCT c.provider_transaction_id) FROM zzsh_order.payment_confirmation c
    WHERE c.source='JOINPAY' AND c.merchant_scope_id=NEW.merchant_identity_id AND c.merchant_order_no=NEW.original_payment_order_no
      AND c.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
   OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY'
     AND i.merchant_identity_id=NEW.merchant_identity_id AND i.original_payment_trx_no=NEW.original_payment_trx_no
     AND(i.requires_review OR i.budget_disposition<>'RELEASED'))
  THEN RAISE EXCEPTION 'prestart refund requires full unique original liability' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF NEW.basis_kind='REVIEW_CONFIRMATION' THEN
  IF NEW.posting_id IS NOT NULL OR NEW.liability_root_id IS NULL OR NEW.liability_event_id IS NULL
   OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 THEN
   RAISE EXCEPTION 'abnormal refund basis shape differs' USING ERRCODE='23514';
  END IF;
  SELECT c0.order_id,c0.source,c0.disposition,c0.reason_code,c0.currency,c0.amount_cents,c0.merchant_scope_id,
         c0.provider_transaction_id,c0.merchant_order_no,c0.joinpay_request_id,c0.joinpay_evidence_id,c0.joinpay_anchor_id,o.renter_user_id,
         rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
         rq.channel_order_no AS request_order_no,rq.amount_cents AS request_amount_cents,rq.currency AS request_currency,
         bnd.wire_merchant_no AS binding_wire_merchant_no,bnd.formal_admission_ref AS formal_admission_ref,
         ev.event AS evidence_event,ev.channel_trx_no AS evidence_trx,ev.schema_outcome AS evidence_schema,
         ev.signature_outcome AS evidence_signature,ev.binding_outcome AS evidence_binding,ev.raw_sha256 AS evidence_raw_sha256,
         an.channel AS anchor_channel,an.evidence_level AS anchor_evidence_level,an.native_order_id AS anchor_order,
         an.request_id AS anchor_request,an.merchant_identity_id AS anchor_merchant,an.channel_trx_no AS anchor_trx
    INTO basis_row
    FROM zzsh_order.payment_confirmation c0
    JOIN zzsh_order.rental_order o ON o.id=c0.order_id
    LEFT JOIN zzsh_order.payment_request rq ON rq.id=c0.joinpay_request_id AND rq.order_id=c0.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=rq.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence ev ON ev.id=c0.joinpay_evidence_id AND ev.request_id=c0.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction an ON an.id=c0.joinpay_anchor_id
   WHERE c0.id=NEW.payment_confirmation_id AND c0.order_id=NEW.order_id;
  IF NOT FOUND
   OR basis_row.source IS DISTINCT FROM 'JOINPAY' OR basis_row.disposition IS DISTINCT FROM 'REVIEW_REQUIRED'
   OR basis_row.reason_code IS NULL OR basis_row.reason_code NOT IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
   OR basis_row.currency IS DISTINCT FROM 'CNY' OR NEW.currency IS DISTINCT FROM 'CNY'
   OR NEW.amount_cents IS DISTINCT FROM basis_row.amount_cents
   OR NEW.renter_user_id IS DISTINCT FROM basis_row.renter_user_id
   OR NEW.merchant_identity_id IS DISTINCT FROM basis_row.merchant_scope_id
   OR NEW.original_payment_trx_no IS DISTINCT FROM basis_row.provider_transaction_id
   OR NEW.original_payment_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.joinpay_request_id IS NULL OR basis_row.joinpay_evidence_id IS NULL OR basis_row.joinpay_anchor_id IS NULL
   OR basis_row.request_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.request_evidence_level IS DISTINCT FROM 'JOINPAY_CANDIDATE'
   OR basis_row.request_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.request_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.request_amount_cents IS DISTINCT FROM basis_row.amount_cents OR basis_row.request_currency IS DISTINCT FROM 'CNY'
   OR basis_row.formal_admission_ref IS NULL OR basis_row.binding_wire_merchant_no IS DISTINCT FROM NEW.wire_merchant_no
   OR basis_row.evidence_event IS DISTINCT FROM 'E4' OR basis_row.evidence_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR basis_row.evidence_schema IS DISTINCT FROM 'VALID' OR basis_row.evidence_signature IS DISTINCT FROM 'MATCH'
   OR basis_row.evidence_binding IS DISTINCT FROM 'MATCH' OR basis_row.evidence_raw_sha256 IS DISTINCT FROM NEW.responsibility_version_hash
   OR basis_row.anchor_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.anchor_evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
   OR basis_row.anchor_order IS DISTINCT FROM basis_row.order_id OR basis_row.anchor_request IS DISTINCT FROM basis_row.joinpay_request_id
   OR basis_row.anchor_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.anchor_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
      AND p.merchant_scope_id=basis_row.merchant_scope_id AND p.provider_transaction_id=basis_row.provider_transaction_id AND p.disposition='APPLIED')
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=NEW.payment_confirmation_id)
   OR (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
       WHERE p.source='JOINPAY' AND p.merchant_scope_id=basis_row.merchant_scope_id
         AND p.merchant_order_no=basis_row.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NEW.liability_root_id IS DISTINCT FROM 'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(NEW.payment_confirmation_id,'UTF8')),'hex'),1,40)
   OR NEW.liability_event_id IS DISTINCT FROM NEW.liability_root_id||'_recognized'
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
  THEN RAISE EXCEPTION 'abnormal refund review basis differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO lr FROM zzsh_order.finance_economic_root WHERE id=NEW.liability_root_id;
  SELECT * INTO le FROM zzsh_order.finance_event WHERE id=NEW.liability_event_id;
  IF lr.id IS NULL OR le.id IS NULL OR lr.source_kind<>'NATIVE_ABNORMAL_REFUND'
   OR lr.source_type<>'NATIVE' OR lr.source_system<>'zzsh' OR lr.source_entity<>'joinpay_abnormal_refund_liability'
   OR lr.basis_id IS NOT NULL OR lr.policy_version IS NOT NULL OR lr.beneficiary_role<>'RENTER'
   OR lr.source_id IS DISTINCT FROM NEW.payment_confirmation_id OR lr.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR lr.source_digest IS DISTINCT FROM NEW.responsibility_version_hash
   OR le.kind<>'REFUND_LIABILITY_RECOGNIZED' OR le.economic_root_id IS DISTINCT FROM lr.id
   OR le.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id)<>2
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=1
     AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=NEW.amount_cents AND l.credit_cents=0
     AND l.counterparty_user_id IS NULL AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=2
     AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=NEW.amount_cents
     AND l.counterparty_user_id=NEW.renter_user_id AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
  THEN RAISE EXCEPTION 'abnormal refund liability closure differs' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents),0) INTO paid_allocated FROM zzsh_order.channel_refund_intent
   WHERE payment_source='JOINPAY' AND merchant_identity_id=NEW.merchant_identity_id
     AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
  IF paid_allocated+NEW.amount_cents>basis_row.amount_cents THEN
    RAISE EXCEPTION 'abnormal refund exceeds original payment budget' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=NEW.payment_confirmation_id
    AND x.basis_kind='REVIEW_CONFIRMATION' AND x.budget_disposition<>'RELEASED')
  THEN RAISE EXCEPTION 'abnormal refund already active for confirmation' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review OR NEW.due_at IS NULL
  THEN RAISE EXCEPTION 'abnormal refund intent must start unclaimed' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp();
  NEW.updated_at:=NEW.created_at;
  RETURN NEW;
 END IF;
 SELECT p.order_id,p.payment_confirmation_id,p.version_hash,p.refund_due_at,p.renter_refund_cents,o.renter_user_id,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.amount_cents INTO b
  FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
  WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED' AND c.source='JOINPAY'
   AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents
   AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE'
    AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0 AND l.counterparty_user_id=o.renter_user_id);
 IF NOT FOUND OR NEW.order_id IS DISTINCT FROM b.order_id OR NEW.payment_confirmation_id IS DISTINCT FROM b.payment_confirmation_id
  OR NEW.renter_user_id IS DISTINCT FROM b.renter_user_id OR NEW.responsibility_version_hash IS DISTINCT FROM b.version_hash
  OR NEW.merchant_identity_id IS DISTINCT FROM b.merchant_scope_id OR NEW.original_payment_trx_no IS DISTINCT FROM b.provider_transaction_id
  OR NEW.original_payment_order_no IS DISTINCT FROM b.merchant_order_no OR NEW.due_at IS DISTINCT FROM b.refund_due_at
  OR NEW.basis_kind IS DISTINCT FROM 'POSTING' OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
 THEN RAISE EXCEPTION 'formal refund frozen posting basis missing' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY' AND i.merchant_identity_id=NEW.merchant_identity_id
  AND i.original_payment_trx_no=NEW.original_payment_trx_no AND i.requires_review)
 THEN RAISE EXCEPTION 'original payment refund requires review' USING ERRCODE='23514';END IF;
 SELECT COALESCE(sum(amount_cents),0),COALESCE(sum(amount_cents) FILTER(WHERE posting_id=NEW.posting_id),0)
  INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY'
  AND merchant_identity_id=NEW.merchant_identity_id AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
 IF paid_allocated+NEW.amount_cents>b.amount_cents OR responsibility_allocated+NEW.amount_cents>b.renter_refund_cents
  OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review
 THEN RAISE EXCEPTION 'formal refund allocation exceeds exact original liability' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.resume_native_refund_review(intent_value text,reason_text text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i zzsh_order.channel_refund_intent;game_value text;boss boolean;resolution_value text;
 actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(request_value),0)=0
  OR length(request_value)>128 OR reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 3 AND 200 OR reason_text~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'native refund review identity or reason unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_value AND payment_source='JOINPAY';
 SELECT game_id INTO game_value FROM zzsh_order.rental_order WHERE id=i.order_id;
 IF i.id IS NULL OR game_value IS NULL THEN RAISE EXCEPTION 'native refund review unavailable' USING ERRCODE='23514';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin."session" s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'native refund review session unavailable' USING ERRCODE='42501';END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission deny WHERE deny.admin_user_id=actor_value AND deny.permission_code='order.settlement.write' AND deny.effect='DENY')
  OR NOT(EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission allow WHERE allow.admin_user_id=actor_value AND allow.permission_code='order.settlement.write' AND allow.effect='ALLOW')
   OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
    JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code='order.settlement.write'))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
   OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=game_value))))
 THEN RAISE EXCEPTION 'native refund review permission unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',i.merchant_identity_id,i.original_payment_trx_no)::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',i.merchant_identity_id,i.original_payment_order_no)::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',i.original_payment_order_no)::text,0));
 PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_value AND payment_source='JOINPAY' FOR UPDATE;
 IF NOT i.requires_review THEN
  SELECT id INTO resolution_value FROM zzsh_order.native_refund_review_resolution WHERE intent_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF resolution_value IS NULL THEN RAISE EXCEPTION 'native refund has no review to resume' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('intentId',i.id,'resumed',false,'state',i.state,'resolutionId',resolution_value);
 END IF;
 IF i.terminal_evidence_id IS NOT NULL OR i.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED') OR i.budget_disposition<>'ALLOCATED'
  OR i.lease_until IS NULL OR i.lease_until>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt WHERE intent_id=i.id AND operation='SUBMIT')
 THEN RAISE EXCEPTION 'native refund original query cannot resume' USING ERRCODE='23514';END IF;
 resolution_value:='native_refund_review_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO zzsh_order.native_refund_review_resolution(id,intent_id,previous_revision,actor_id,session_id,request_id,reason)
  VALUES(resolution_value,i.id,i.revision,actor_value,session_value,request_value,trim(reason_text));
 UPDATE zzsh_order.channel_refund_intent SET state='UNKNOWN',requires_review=false,revision=revision+1 WHERE id=i.id AND revision=i.revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'native refund review changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
  VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.native.refund.review_resumed',
   'channel_refund_intent',i.id,'SUCCESS',request_value,trim(reason_text),clock_timestamp(),
   jsonb_build_object('orderId',i.order_id,'resolutionId',resolution_value,'refundOrderNo',i.refund_order_no,'firstDispatchAllowed',false));
 RETURN jsonb_build_object('intentId',i.id,'resumed',true,'state','UNKNOWN','resolutionId',resolution_value);
END $$;
REVOKE ALL ON FUNCTION zzsh_order.resume_native_refund_review(text,text) FROM PUBLIC;
