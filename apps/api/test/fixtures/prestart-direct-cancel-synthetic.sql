SET LOCAL session_replication_role='replica';
INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES
 ('synth_renter','Renter','renter@invalid.example',now(),now()),
 ('synth_owner','Owner','owner@invalid.example',now(),now());
INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES
 ('synth_session_renter','synth_renter','synthetic-token-r',now()+interval '1 hour',now(),now()),
 ('synth_session_owner','synth_owner','synthetic-token-o',now()+interval '1 hour',now(),now());
INSERT INTO zzsh_supply.game(id,code,name) VALUES('synth_game','synth_game','Synthetic');
INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('synth_account','synth_owner','synth_game');
INSERT INTO zzsh_supply.listing_version(id,account_id,sequence) VALUES('synth_version','synth_account',1);
INSERT INTO zzsh_supply.rule_release(id,game_id,price_version_id,term_version_id,agreement_version_id,generation,activated_by_admin_id)
 VALUES('synth_release','synth_game','synth_price','synth_terms','synth_agreement',1,'synth_admin');
INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,
 content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,hold_until,paid_confirmation_id,paid_at)
 VALUES('synth_order','SYNTH_ORDER','synth_account','synth_version','synth_owner','synth_renter','synth_game','synth_release',
 repeat('a',64),'synth','PAID',8000,2000,'CNY',3600,'{}','Synthetic',now()+interval '1 hour','synth_payment',now());
INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,
 amount_cents,currency,provider_paid_at,disposition,request_id,joinpay_request_id,joinpay_evidence_id,joinpay_anchor_id)
 VALUES('synth_payment','JOINPAY','synth_merchant','synth_trx','synth_order_no','synth_order',10000,'CNY',now(),'APPLIED','synth_payment_req',
 'synth_channel_request','synth_channel_evidence','synth_channel_anchor');

INSERT INTO zzsh_order.rental_opening(id,order_id,version_no,quote_digest,payment_digest,lines,status,created_by_source,payment_confirmation_id)
 VALUES('synth_opening','synth_order',1,repeat('c',64),repeat('d',64),'[]'::jsonb,'DRAFT','SYSTEM','synth_payment');
SET LOCAL session_replication_role='origin';
