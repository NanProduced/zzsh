BEGIN;
SET LOCAL session_replication_role='replica';
INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES
 ('post_renter','Renter','post-renter@invalid.example',now(),now()),
 ('post_owner','Owner','post-owner@invalid.example',now(),now());
INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES
 ('post_session_renter','post_renter','post-token-r',now()+interval '1 hour',now(),now()),
 ('post_session_owner','post_owner','post-token-o',now()+interval '1 hour',now(),now());
INSERT INTO zzsh_supply.game(id,code,name) VALUES('post_game','post_game','Synthetic');
INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('post_account','post_owner','post_game');
INSERT INTO zzsh_supply.listing_version(id,account_id,sequence) VALUES('post_version','post_account',1);
INSERT INTO zzsh_supply.rule_release(id,game_id,price_version_id,term_version_id,agreement_version_id,generation,activated_by_admin_id)
 VALUES('post_release','post_game','post_price','post_terms','post_agreement',1,'post_admin');
INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,
 content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,hold_until,paid_confirmation_id,paid_at)
 VALUES('post_order','POST_ORDER','post_account','post_version','post_owner','post_renter','post_game','post_release',
 repeat('a',64),'synth','PAID',8000,2000,'CNY',3600,'{}','Synthetic',now()+interval '1 hour','post_payment',now());
INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,
 amount_cents,currency,provider_paid_at,disposition,request_id,joinpay_request_id,joinpay_evidence_id,joinpay_anchor_id)
 VALUES('post_payment','JOINPAY','post_merchant','post_trx','post_order_no','post_order',10000,'CNY',now(),'APPLIED','post_payment_req','post_req','post_evidence','post_anchor');

INSERT INTO zzsh_order.rental_opening(id,order_id,version_no,quote_digest,payment_digest,lines,status,created_by_source,payment_confirmation_id)
 VALUES('post_opening','post_order',1,repeat('c',64),repeat('d',64),'[]'::jsonb,'DRAFT','SYSTEM','post_payment');
INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES('post_admin','Admin','post-admin@invalid.example',true,now(),now());
INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES('post_admin','ACTIVE',true,now());
INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('post_admin_session','post_admin','post-admin-token',now()+interval '1 hour',now(),now());
INSERT INTO zzsh_order.rental_opening_ack(opening_id,party,user_id,version_no,source) VALUES('post_opening','RENTER','post_renter',1,'PARTY'),('post_opening','OWNER','post_owner',1,'PARTY');
INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest) VALUES('post_owner_basis','post_owner','LEGACY_OPENING','LEGACY_MYSQL','la_user','1',repeat('a',64),repeat('b',64),0,now(),0,repeat('c',64));
INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES('post_owner','RECONCILED_OPENING','post_owner_basis','post_opening_event');
UPDATE zzsh_order.payment_confirmation SET source='JOINPAY',joinpay_request_id='post_req',joinpay_evidence_id='post_evidence',joinpay_anchor_id='post_anchor' WHERE id='post_payment';
INSERT INTO zzsh_order.joinpay_collection_binding(request_id,wire_merchant_no,trade_merchant_no,product_name,notify_url,initial_profile_sha256,evidence_mode)
 VALUES('post_req','123456','123456','Synthetic','https://example.invalid/notify',repeat('a',64),'OFFICIAL');
INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('post_renter',0,0);
SET LOCAL session_replication_role='origin';

SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','post_admin',true),set_config('zzsh.session_id','post_admin_session',true),set_config('zzsh.request_id','post_cancel_req',true);
SELECT zzsh_order.cancel_order_after_start('post_order',1,:'refund'::numeric,:'owner'::numeric,'客服协商取消');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN IF (SELECT status FROM zzsh_order.rental_order WHERE id='post_order')<>'CANCELLED' OR NOT EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id='post_order' AND zzsh_order.support_poststart_cancellation_complete(p.id)) THEN RAISE EXCEPTION 'poststart cancellation not closed';END IF;END $$;
WITH proof AS (
 SELECT jsonb_build_object('kind','FORMAL_NATIVE_REFUND_SERVER_REVIEW','reference','synthetic_refund_admission',
  'reviewSha256',repeat('a',64),'database',current_database(),'runtimeUser',current_user,
  'merchantIdentityId','post_merchant','merchantNo','123456','acceptedProfiles',jsonb_build_array(
    jsonb_build_object('operation','SUBMIT','profileId','synthetic_profile','profileSha256',repeat('b',64),'keyVersionRef','synthetic_key'),
    jsonb_build_object('operation','QUERY'),jsonb_build_object('operation','NOTIFY')))::text AS canonical
)
INSERT INTO zzsh_order.channel_refund_intent(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
 merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,
 amount_cents,currency,idempotency_key,request_fingerprint,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,
 initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,
 basis_kind,liability_root_id,liability_event_id)
SELECT 'post_refund',NULL,p.order_id,p.payment_confirmation_id,p.renter_user_id,'JOINPAY',c.merchant_scope_id,
 c.provider_transaction_id,c.merchant_order_no,p.source_digest,'RF'||repeat('a',28),p.refund_cents,'CNY','post_refund_key',repeat('c',64),
 p.created_at,'JOINPAY_FORMAL','synthetic_refund_admission',encode(sha256(convert_to(proof.canonical,'UTF8')),'hex'),
 proof.canonical,'123456','synthetic_profile',repeat('b',64),'synthetic_key','https://example.invalid/notify',
 'SUPPORT_CANCELLATION',p.root_id,p.event_id
FROM zzsh_order.support_poststart_cancellation p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id CROSS JOIN proof
WHERE p.order_id='post_order';
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
 IF NOT zzsh_order.support_cancellation_refund_liability_complete('post_refund')
  OR (SELECT amount_cents FROM zzsh_order.channel_refund_intent WHERE id='post_refund')<>5000
 THEN RAISE EXCEPTION 'support refund does not match partial liability';END IF;
 BEGIN
  INSERT INTO zzsh_order.channel_refund_intent(id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
   merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,
   amount_cents,currency,idempotency_key,request_fingerprint,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,
   initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,
   basis_kind,liability_root_id,liability_event_id)
  SELECT 'post_refund_bad',posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,
   merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,'RF'||repeat('b',28),
   amount_cents+1,currency,'post_refund_bad_key',request_fingerprint,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,
   initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,
   basis_kind,liability_root_id,liability_event_id FROM zzsh_order.channel_refund_intent WHERE id='post_refund';
  RAISE EXCEPTION 'incorrect refund amount was accepted';
 EXCEPTION WHEN check_violation THEN NULL;END;
END $$;
ROLLBACK;
