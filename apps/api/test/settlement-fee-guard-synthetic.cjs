// Synthetic fixtures bypass seed triggers; subsequent commands use real guards and a stubbed admission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const payment = require('../dist/src/order/payment-confirmation');
const settlement = require('../dist/src/order/settlement-record');
const { hashApprovalPayload } = require('../dist/src/auth/approval-audit');
const { setAuditContext } = require('../dist/src/auth/security-core');

assert.equal(process.env.LEGACY_COMPLETION_SYNTH_OPT_IN, '1');
const pool = new Pool({host:'127.0.0.1',port:55439,database:'zzsh_synth_prod_refund_r3',user:'postgres',max:1});
const originalAdmission = payment.assertControlledSettlementResource;
payment.assertControlledSettlementResource = async () => {};

async function approveSyntheticAdjustment(client,requestId,key) {
  const leased={query:async(sql,values)=>{
    if(sql==='BEGIN')return client.query('SAVEPOINT synthetic_approval_route');
    if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT synthetic_approval_route');
    if(sql==='ROLLBACK'){await client.query('ROLLBACK TO SAVEPOINT synthetic_approval_route');return client.query('RELEASE SAVEPOINT synthetic_approval_route');}
    return client.query(sql,values);
  },release(){}};
  const pool={query:(...args)=>client.query(...args),connect:async()=>leased};
  const request={method:'POST',url:'/api/v1/admin/security/approvals/requests/decision',
    headers:{'idempotency-key':key},body:{requestId,decision:'APPROVE',reason:'双方已核实'}};
  let status=0,body=null;const response={headersSent:false,status(value){status=value;return this;},setHeader(){return this;},json(value){body=value;return this;}};
  const context={userId:'fee-admin',sessionId:'fee-admin-session',credentials:{},security:{status:'ACTIVE',isBoss:true,passwordChangeRequired:false},sessionLocked:false};
  await require('../dist/src/auth/approval-audit').handleAdminApprovalRoute(request,response,'fee-approval-request',{pool},async()=>context);
  assert.equal(status,200,JSON.stringify(body));
  const proof=(await client.query(`SELECT r.status,r.decided_by,(SELECT count(*)::int FROM zzsh_iam.approval_decision d
    WHERE d.request_id=r.id AND d.decision='APPROVED' AND d.approver_admin_id='fee-admin') AS decisions,
    (SELECT count(*)::int FROM zzsh_iam.audit_event a WHERE a.object_id=r.id AND a.action='approval.request.approved' AND a.outcome='SUCCESS') AS audits
    FROM zzsh_iam.approval_request r WHERE r.id=$1`,[requestId])).rows[0];
  assert.deepEqual(proof,{status:'APPROVED',decided_by:'fee-admin',decisions:1,audits:1});
}

(async () => {
  const client = await pool.connect();
  try {
    const identity = (await client.query(`SELECT (pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,
      shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.deepEqual(identity,{system_id:process.env.LEGACY_COMPLETION_SYNTH_SYSTEM_ID,oid:process.env.LEGACY_COMPLETION_SYNTH_OID,marker:'zzsh:synthetic:production-refund-v1'});
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role='replica'");
    for (const id of ['fee-owner','fee-renter']) {
      await client.query('INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',[id,id+'@example.invalid']);
      await client.query('INSERT INTO zzsh_auth_user.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$1,now()+interval \'1 hour\',now(),now())',[id+'-session',id]);
    }
    await client.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',['fee-admin','fee-admin@example.invalid']);
    await client.query("INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES('fee-admin','ACTIVE',true,now())");
    await client.query("INSERT INTO zzsh_auth_admin.session(id,\"userId\",token,\"expiresAt\",\"createdAt\",\"updatedAt\") VALUES('fee-admin-session','fee-admin','fee-admin-token',now()+interval '1 hour',now(),now())");
    await client.query("INSERT INTO zzsh_supply.game(id,code,name) VALUES('fee-game','fee-game','fee game')");
    await client.query("INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('fee-account','fee-owner','fee-game')");
    await client.query(`INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,term_seconds,quote_snapshot,title,hold_until,paid_confirmation_id,paid_at)
      VALUES('fee-order','FEE-ORDER','fee-account','fixture-listing','fee-owner','fee-renter','fee-game','fixture-rule',$1,'fixture','PAID',35000,30000,86400,'{}','fee order',now(),'fixture-payment',now())`,['a'.repeat(64)]);
    const snapshot={endReason:'TENANT_VOLUNTARY_EARLY',amounts:{feePayer:'RENTER'}};
    const hash=hashApprovalPayload(snapshot).hash;
    await client.query(`INSERT INTO zzsh_order.settlement_version(id,order_id,opening_id,version_no,kind,end_reason,early,initiator_party,initiator_subject_id,basis_hash,version_hash,input_snapshot,computation,system_owner_net_cents,system_renter_refund_cents)
      VALUES('fee-version','fee-order','fixture-opening',1,'SYSTEM','TENANT_VOLUNTARY_EARLY',true,'SUPPORT','fee-admin',$1,$1,$2::jsonb,'{}',10800,46080)`,[hash,JSON.stringify(snapshot)]);
    await client.query("SET LOCAL session_replication_role='origin'");
    const actor={realm:'user',userId:'fee-owner',sessionId:'fee-owner-session',controlledPaymentFact:{}};
    const boss={realm:'admin',userId:'fee-admin',sessionId:'fee-admin-session',controlledPaymentFact:{}};
    const result=await settlement.decideSettlement(client,'fee-order','fee-version',actor,'CONFIRM',hash,null,'fee-request',true);
    assert.equal(result.status,409);assert.deepEqual(result.body.reasons,['SETTLEMENT_FEE_RECONFIRM_REQUIRED']);
    const review=await settlement.reviewSettlement(client,'fee-order','fee-version',boss,hash,'fee-review');
    assert.deepEqual(review.body.reasons,['SETTLEMENT_FEE_RECONFIRM_REQUIRED']);
    const forced=await settlement.finalizeSettlementBySupport(client,'fee-order','fee-version',boss,hash,'已核对旧方案','fee-finalize');
    assert.deepEqual(forced.body.reasons,['SETTLEMENT_FEE_RECONFIRM_REQUIRED']);
    const read=await settlement.readSettlement(client,'fee-order',actor);
    assert(read.body.reasons.includes('SETTLEMENT_FEE_RECONFIRM_REQUIRED'));
    assert.equal(read.body.stage.code,'UNKNOWN');assert.equal(read.body.stage.viewerActionRequired,false);
    const list=await settlement.readSettlementStages(client,['fee-order'],'fee-owner');
    assert.equal(list.get('fee-order').code,'UNKNOWN');
    const counts=(await client.query(`SELECT (SELECT count(*)::int FROM zzsh_order.settlement_decision WHERE settlement_version_id='fee-version') AS decisions,
      (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id='fee-order') AS postings`)).rows[0];
    assert.deepEqual(counts,{decisions:0,postings:0});
    console.log('PASS synthetic PostgreSQL: old native fee proposal cannot be confirmed, reviewed, finalized, or shown as actionable');

    await client.query('SAVEPOINT outdated_owner_basis');
    await client.query("SET LOCAL session_replication_role='replica'");
    const fullBasis={endReason:'TENANT_VOLUNTARY_EARLY',amounts:{feePayer:'OWNER',feeBase:'240.00',ownerGross:'108.00'}};
    const fullBasisHash=hashApprovalPayload(fullBasis).hash;
    await client.query("UPDATE zzsh_order.settlement_version SET input_snapshot=$2::jsonb,basis_hash=$3,version_hash=$3 WHERE id=$1",['fee-version',JSON.stringify(fullBasis),fullBasisHash]);
    await client.query("SET LOCAL session_replication_role='origin'");
    const oldBasisDecision=await settlement.decideSettlement(client,'fee-order','fee-version',actor,'CONFIRM',fullBasisHash,null,'fee-request-2',true);
    assert.deepEqual(oldBasisDecision.body.reasons,['SETTLEMENT_FEE_RECONFIRM_REQUIRED']);
    assert.equal((await settlement.readSettlementStages(client,['fee-order'],'fee-owner')).get('fee-order').code,'UNKNOWN');
    await client.query('ROLLBACK TO SAVEPOINT outdated_owner_basis');
    await client.query('SAVEPOINT outdated_manual_fee');
    await client.query("SET LOCAL session_replication_role='replica'");
    const manualOld={kind:'MANUAL_ADJUSTMENT',fullPayoutSelected:true,endReason:'NORMAL',amounts:{feePayer:'OWNER'}};
    const manualOldHash=hashApprovalPayload(manualOld).hash;
    await client.query("UPDATE zzsh_order.settlement_version SET input_snapshot=$2::jsonb,basis_hash=$3,version_hash=$3 WHERE id=$1",['fee-version',JSON.stringify(manualOld),manualOldHash]);
    await client.query("SET LOCAL session_replication_role='origin'");
    assert.deepEqual((await settlement.decideSettlement(client,'fee-order','fee-version',actor,'CONFIRM',manualOldHash,null,'fee-manual-old',true)).body.reasons,['SETTLEMENT_FEE_RECONFIRM_REQUIRED']);
    assert.equal((await settlement.readSettlementStages(client,['fee-order'],'fee-owner')).get('fee-order').code,'UNKNOWN');
    await client.query('ROLLBACK TO SAVEPOINT outdated_manual_fee');

    // Synthetic quote and payment are seeded; subsequent settlement commands and posting guards run normally.
    const money=(amount,scale)=>({currency:'CNY',unit:'yuan',amount,scale});
    const quoteLines=[
      {itemId:'haff',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',unitQuantity:'1000000',buyerAmount:money('250.00',2),ownerAmount:money('200.00',2),buyerUnitAmount:money('0.00000000',8),ownerUnitAmount:money('0.00000000',8)},
      {itemId:'kit',quantity:'10',unit:'PIECE',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerAmount:money('100.00',2),ownerAmount:money('40.00',2),buyerUnitAmount:money('10.00000000',8),ownerUnitAmount:money('4.00000000',8)},
    ];
    const ratio={itemId:'haff',buyerNumerator:'250.00',buyerDenominator:'1',ownerNumerator:'200.00',ownerDenominator:'1'};
    const contentHash='b'.repeat(64),quote={ruleReleaseId:'fee-rule',priceVersionId:'fee-price',lines:quoteLines,pricingInputs:{exactRatios:[ratio]},
      personal:{schema:'personal-quote-v2',userId:'fee-renter',ownerUserId:'fee-owner',accountId:'fee-account-2',listingVersionId:'fee-listing-2',listingHash:contentHash,
        ruleRefs:{releaseId:'fee-rule'},membership:{version:'1',sourceRef:'fixture',tier:'STANDARD'},guarantee:{reference:'fixture',status:'NOT_REQUIRED'},
        funding:{version:'1',sourceRef:'fixture',baseDepositCents:'30000',publisherBailRequirementCents:'0',vipWaiver:false,svipWaiver:false,fullPayoutPolicyRef:'fixture',fullPayoutPolicyVersion:'1',disclosureVersion:'1'},
        fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected:true}}};
    const digestLines=quoteLines.map(line=>({itemId:line.itemId,quantity:line.quantity,unit:line.unit,pricingKind:line.pricingKind,
      buyer:line.buyerAmount.amount,owner:line.ownerAmount.amount,buyerUnit:line.buyerUnitAmount.amount,ownerUnit:line.ownerUnitAmount.amount,
      ...(line.itemId==='haff'?{buyerNumerator:ratio.buyerNumerator,buyerDenominator:ratio.buyerDenominator,ownerNumerator:ratio.ownerNumerator,ownerDenominator:ratio.ownerDenominator}:{})}));
    const quoteDigest=hashApprovalPayload({contentHash,priceVersionId:'fee-price',lines:digestLines}).hash;
    const paymentDigest=hashApprovalPayload({confirmationId:'fee-payment-2',amountCents:'65000',currency:'CNY',disposition:'APPLIED'}).hash;
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('fee-account-2','fee-owner','fee-game')");
    await client.query("INSERT INTO zzsh_supply.listing_version(id,account_id,sequence) VALUES('fee-listing-2','fee-account-2',1)");
    await client.query("INSERT INTO zzsh_supply.rule_release(id,game_id,price_version_id,term_version_id,agreement_version_id,generation,activated_by_admin_id) VALUES('fee-rule','fee-game','fee-price','fee-term','fee-agreement',1,'fee-admin')");
    await client.query(`INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,term_seconds,quote_snapshot,title,hold_until,paid_confirmation_id,paid_at)
      VALUES('fee-order-2','FEE-ORDER-2','fee-account-2','fee-listing-2','fee-owner','fee-renter','fee-game','fee-rule',$1,'fixture','PAID',35000,30000,86400,$2::jsonb,'fee order',now(),'fee-payment-2',now())`,[contentHash,JSON.stringify(quote)]);
    await client.query(`INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,request_id,joinpay_request_id,joinpay_evidence_id,joinpay_anchor_id)
      VALUES('fee-payment-2','JOINPAY','fixture-merchant','fixture-transaction','fixture-order','fee-order-2',65000,'CNY',now(),'APPLIED','fixture-request','fixture-joinpay','fixture-evidence','fixture-anchor')`);
    await client.query(`INSERT INTO zzsh_order.rental_opening(id,order_id,version_no,quote_digest,payment_digest,lines,status,confirmed_at,confirm_source,created_by_source,payment_confirmation_id)
      VALUES('fee-opening-2','fee-order-2',1,$1,$2,$3::jsonb,'CONFIRMED',now(),'PARTY','SYSTEM','fee-payment-2')`,[quoteDigest,paymentDigest,JSON.stringify(quoteLines.map(line=>({itemId:line.itemId,quantity:line.quantity})))]);
    await client.query("SET LOCAL session_replication_role='origin'");
    await client.query('SAVEPOINT before_native_fee_posting');
    const remaining=[{itemId:'haff',quantity:'50000000'},{itemId:'kit',quantity:'8'}];
    await setAuditContext(client,'admin',boss.userId,boss.sessionId,'fee-preview');
    const preview=await settlement.previewStaffSettlement(client,'fee-order-2',boss,{remaining,endReason:'TENANT_VOLUNTARY_EARLY'});
    assert.equal(preview.status,200,JSON.stringify(preview.body));
    assert.deepEqual([preview.body.amounts.feePayer,preview.body.amounts.feeAmount,preview.body.amounts.ownerNet,preview.body.amounts.renterRefund],['OWNER','8.64','99.36','480.00']);
    const classified=await settlement.classifySettlement(client,'fee-order-2',boss,remaining,'TENANT_VOLUNTARY_EARLY',preview.body.versionHash,'fee-classify');
    assert.equal(classified.status,200,JSON.stringify(classified.body));
    const current=classified.body.settlement;
    for(const userId of ['fee-renter','fee-owner']){
      const user={realm:'user',userId,sessionId:userId+'-session',controlledPaymentFact:{}};
      await setAuditContext(client,'user',user.userId,user.sessionId,'fee-confirm');
      const decided=await settlement.decideSettlement(client,'fee-order-2',current.id,user,'CONFIRM',current.versionHash,null,'fee-confirm',true);
      assert.equal(decided.status,200,JSON.stringify(decided.body));
    }
    await setAuditContext(client,'admin',boss.userId,boss.sessionId,'fee-review-2');
    const posted=await settlement.reviewSettlement(client,'fee-order-2',current.id,boss,current.versionHash,'fee-review-2');
    assert.equal(posted.status,200,JSON.stringify(posted.body));
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const posting=(await client.query(`SELECT owner_net_cents::text AS owner,renter_refund_cents::text AS refund,
      compensation_fee_cents::text AS fee,platform_contribution_cents::text AS platform FROM zzsh_order.settlement_posting WHERE order_id='fee-order-2'`)).rows[0];
    assert.deepEqual(posting,{owner:'9936',refund:'48000',fee:'864',platform:'7064'});
    const entries=(await client.query(`SELECT account_code,credit_cents::text AS credit,details FROM zzsh_order.settlement_ledger_entry
      WHERE posting_id=(SELECT id FROM zzsh_order.settlement_posting WHERE order_id='fee-order-2') AND account_code IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_COMPENSATION_FEE') ORDER BY account_code`)).rows;
    assert.deepEqual(entries.map(row=>[row.account_code,row.credit]),[['OWNER_AVAILABLE','9936'],['PLATFORM_COMPENSATION_FEE','864'],['RENTER_REFUND_PAYABLE','48000']]);
    assert.equal(entries[1].details.payer,'OWNER');assert.equal(entries[1].details.policyVersion,'owner-actual-income-20261111');
    console.log('PASS synthetic PostgreSQL: native early payout fee, owner credit, refund liability and balanced posting');
    await client.query('ROLLBACK TO SAVEPOINT before_native_fee_posting');

    // Exercise an actual old cancellation, then upgrade and replay it without reinterpreting its amount.
    const fixture=fs.readFileSync(path.join(__dirname,'fixtures/poststart-support-refund-synthetic.sql'),'utf8');
    const seedEnd=fixture.indexOf("SELECT set_config('zzsh.actor_type'");assert(seedEnd>0);
    const seed=(prefix)=>fixture.slice(0,seedEnd).replace(/^BEGIN;\s*/,'').replaceAll('post_',prefix+'_').replaceAll('post-',prefix+'-')
      .replaceAll('POST_',prefix.toUpperCase()+'_').replace("'la_user','1'",`'la_user','${prefix==='hfee'?'1':'2'}'`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(seed('hfee'));
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('hfee_owner',0,0) ON CONFLICT DO NOTHING");
    await client.query("SET LOCAL session_replication_role='origin'");
    await setAuditContext(client,'admin','hfee_admin','hfee_admin_session','hfee_cancel_req');
    const {withIdempotency,fingerprintRequest}=require('../dist/src/supply/supply-util');
    const oldScope={realm:'admin',principalId:'hfee_admin',operation:'order.support_cancel_after_opening',resourceId:'hfee_order'};
    const oldBody={expectedOrderRevision:'1',reason:'客服协商取消',refundCents:'5000',ownerCents:'2000',expectedAdminId:'hfee_admin'};
    const oldFingerprint=fingerprintRequest(oldScope.operation,oldScope.resourceId,oldBody);
    const original=await withIdempotency(client,oldScope,'hfee-original-key',oldFingerprint,async()=>{},async()=>{
      const receipt=(await client.query("SELECT zzsh_order.cancel_order_after_start('hfee_order',1,5000,2000,'客服协商取消') AS value")).rows[0].value;
      return {status:200,body:receipt};
    });
    assert.equal(original.body.ownerCents,'2000');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const upgrade=fs.readFileSync(path.join(__dirname,'../migrations/business/0196_owner_payout_fee.sql'),'utf8');
    await client.query('SET LOCAL ROLE zzsh_synth_migrator');
    await client.query(fs.readFileSync(path.join(__dirname,'../migrations/business/0195_approval_center_link.sql'),'utf8'));
    await client.query(upgrade);
    await client.query('RESET ROLE');
    assert.equal((await client.query("SELECT zzsh_order.support_poststart_cancellation_complete(id) AS complete FROM zzsh_order.support_poststart_cancellation WHERE order_id='hfee_order'")).rows[0].complete,true);
    const replay=await withIdempotency(client,oldScope,'hfee-original-key',oldFingerprint,async()=>{},async()=>{throw Error('old receipt must not execute again')});
    assert.equal(replay.replayed,true);assert.equal(replay.body.ownerCents,'2000');
    const refused=await withIdempotency(client,oldScope,'hfee-unused-key',oldFingerprint,async()=>{},async()=>({status:409,body:{reasons:['OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED']}}));
    assert.equal(refused.status,409);
    const late=await withIdempotency(client,oldScope,'hfee-unused-key',oldFingerprint,async()=>{},async()=>{throw Error('a late old request must not execute')});
    assert.equal(late.replayed,true);assert.equal(late.status,409);

    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await setAuditContext(client,'admin',boss.userId,boss.sessionId,'fee-manual');
    const manual={remaining,endReason:'TENANT_VOLUNTARY_EARLY',proposedOwnerGross:'120',proposedRenterRefund:'470',reason:'双方核实后调整'};
    await client.query('SAVEPOINT manual_without_payout');
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("UPDATE zzsh_order.rental_order SET quote_snapshot=jsonb_set(quote_snapshot,'{personal,fullPayoutDeclaration,selected}','false'::jsonb) WHERE id='fee-order-2'");
    await client.query("SET LOCAL session_replication_role='origin'");
    const uninsuredPreview=await settlement.previewStaffSettlement(client,'fee-order-2',boss,manual);
    assert.equal(uninsuredPreview.status,200,JSON.stringify(uninsuredPreview.body));
    assert.equal(uninsuredPreview.body.proposedFullPayoutFee,'0.00');assert.equal(uninsuredPreview.body.proposedOwnerNet,'120.00');
    await client.query('ROLLBACK TO SAVEPOINT manual_without_payout');
    await client.query('SAVEPOINT before_manual_fee');
    const manualPreview=await settlement.previewStaffSettlement(client,'fee-order-2',boss,manual);
    assert.equal(manualPreview.status,200,JSON.stringify(manualPreview.body));
    assert.deepEqual([manualPreview.body.proposedOwnerGross,manualPreview.body.proposedFullPayoutFee,manualPreview.body.proposedOwnerNet,manualPreview.body.proposedRenterRefund],
      ['120.00','9.60','110.40','470.00']);
    const manualExcess=await settlement.previewStaffSettlement(client,'fee-order-2',boss,{...manual,proposedRenterRefund:'531.00'});
    assert.deepEqual(manualExcess.body.reasons,['FUNDING_SOURCE_REQUIRED']);
    const submitted=await settlement.adjustSettlement(client,'fee-order-2',boss,{...manual,acceptedHash:manualPreview.body.versionHash,requestId:'fee-manual'});
    assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    const manualVersion=submitted.body.settlement;
    assert.equal((await settlement.readSettlementStages(client,['fee-order-2'],'fee-owner')).get('fee-order-2').code,'DECISION_PENDING');
    const approval=(await client.query("SELECT approval_request_id FROM zzsh_order.settlement_version WHERE id=$1",[manualVersion.id])).rows[0];
    assert(approval?.approval_request_id);
    await approveSyntheticAdjustment(client,approval.approval_request_id,'fee-approval-key');
    for(const userId of ['fee-renter','fee-owner']){
      const user={realm:'user',userId,sessionId:userId+'-session',controlledPaymentFact:{}};
      await setAuditContext(client,'user',user.userId,user.sessionId,'fee-manual-confirm');
      const decision=await settlement.decideSettlement(client,'fee-order-2',manualVersion.id,user,'CONFIRM',manualVersion.versionHash,null,'fee-manual-confirm',true);
      assert.equal(decision.status,200,JSON.stringify(decision.body));
    }
    await setAuditContext(client,'admin',boss.userId,boss.sessionId,'fee-manual-review');
    const manualPosted=await settlement.reviewSettlement(client,'fee-order-2',manualVersion.id,boss,manualVersion.versionHash,'fee-manual-review');
    assert.equal(manualPosted.status,200,JSON.stringify(manualPosted.body));
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const manualPosting=(await client.query(`SELECT owner_net_cents::text AS owner,renter_refund_cents::text AS refund,
      compensation_fee_cents::text AS fee,platform_contribution_cents::text AS platform FROM zzsh_order.settlement_posting WHERE order_id='fee-order-2'`)).rows[0];
    assert.deepEqual(manualPosting,{owner:'11040',refund:'47000',fee:'960',platform:'6960'});
    const manualLines=(await client.query(`SELECT account_code,debit_cents::text AS debit,credit_cents::text AS credit,details
      FROM zzsh_order.settlement_ledger_entry WHERE posting_id=(SELECT id FROM zzsh_order.settlement_posting WHERE order_id='fee-order-2')
      AND account_code IN ('PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT') ORDER BY account_code`)).rows;
    assert.deepEqual(manualLines.map(x=>[x.account_code,x.debit,x.credit]),[['PLATFORM_COMPENSATION_FEE','0','960'],['PLATFORM_MANUAL_NET_ADJUSTMENT','200','0']]);
    assert.equal(manualLines[0].details.base.amount,'120.00');assert.equal(manualLines[1].details.deltaPayoutFee,'0.96');
    console.log('PASS synthetic PostgreSQL: approved manual gross, owner fee, balance, and settlement ledger');
    await client.query('ROLLBACK TO SAVEPOINT before_manual_fee');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const lower={...manual,proposedOwnerGross:'50.00'};
    const lowerPreview=await settlement.previewStaffSettlement(client,'fee-order-2',boss,lower);
    const lowerSubmitted=await settlement.adjustSettlement(client,'fee-order-2',boss,{...lower,acceptedHash:lowerPreview.body.versionHash,requestId:'fee-manual-lower'});
    const lowerVersion=lowerSubmitted.body.settlement;
    const lowerApproval=(await client.query("SELECT approval_request_id FROM zzsh_order.settlement_version WHERE id=$1",[lowerVersion.id])).rows[0].approval_request_id;
    await approveSyntheticAdjustment(client,lowerApproval,'fee-lower-approval-key');
    for(const userId of ['fee-renter','fee-owner']){
      const user={realm:'user',userId,sessionId:userId+'-session',controlledPaymentFact:{}};
      await setAuditContext(client,'user',user.userId,user.sessionId,'fee-manual-lower-confirm');
      assert.equal((await settlement.decideSettlement(client,'fee-order-2',lowerVersion.id,user,'CONFIRM',lowerVersion.versionHash,null,'fee-manual-lower-confirm',true)).status,200);
    }
    await setAuditContext(client,'admin',boss.userId,boss.sessionId,'fee-manual-lower-review');
    assert.equal((await settlement.reviewSettlement(client,'fee-order-2',lowerVersion.id,boss,lowerVersion.versionHash,'fee-manual-lower-review')).status,200);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const lowerLines=(await client.query(`SELECT account_code,debit_cents::text AS debit,credit_cents::text AS credit,details
      FROM zzsh_order.settlement_ledger_entry WHERE posting_id=(SELECT id FROM zzsh_order.settlement_posting WHERE order_id='fee-order-2')
      AND account_code IN ('PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT') ORDER BY account_code`)).rows;
    assert.deepEqual(lowerLines.map(x=>[x.account_code,x.debit,x.credit]),[['PLATFORM_COMPENSATION_FEE','0','400'],['PLATFORM_MANUAL_NET_ADJUSTMENT','0','6800']]);
    assert.equal(lowerLines[1].details.deltaPayoutFee,'-4.64');
    console.log('PASS synthetic PostgreSQL: a lower manual income reduces the fee without unbalancing the ledger');

    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(seed('cfee'));
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('cfee_owner',0,0) ON CONFLICT DO NOTHING");
    const cancelQuote={ruleReleaseId:'cfee_release',personal:{schema:'personal-quote-v2',userId:'cfee_renter',ownerUserId:'cfee_owner',
      accountId:'cfee_account',listingVersionId:'cfee_version',listingHash:'a'.repeat(64),ruleRefs:{releaseId:'cfee_release'},
      funding:{fullPayoutPolicyVersion:'1',disclosureVersion:'1'},fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected:true}}};
    await client.query("UPDATE zzsh_order.rental_order SET quote_snapshot=$2::jsonb WHERE id=$1",['cfee_order',JSON.stringify(cancelQuote)]);
    await client.query("SET LOCAL session_replication_role='origin'");
    await setAuditContext(client,'admin','cfee_admin','cfee_admin_session','cfee_cancel_req');
    const support=require('../dist/src/order/support-cancel');
    const cancelActor={userId:'cfee_admin',sessionId:'cfee_admin_session',controlledPaymentFact:{}};
    const request={orderId:'cfee_order',expectedOrderRevision:'1',reason:'客服协商取消',refundCents:'5000',ownerCents:'2000',requestId:'cfee_cancel_req'};
    await assert.rejects(support.supportCancelAfterOpening(client,cancelActor,request),/OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED/);
    await client.query('SAVEPOINT cancellation_unknown_payout');
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("UPDATE zzsh_order.rental_order SET quote_snapshot='{}'::jsonb WHERE id='cfee_order'");
    await client.query("SET LOCAL session_replication_role='origin'");
    await assert.rejects(support.supportCancelAfterOpening(client,cancelActor,{...request,ownerAmountBasis:'GROSS_BEFORE_FEE_V1'}),/FULL_PAYOUT_UNKNOWN/);
    assert.equal((await client.query("SELECT status FROM zzsh_order.rental_order WHERE id='cfee_order'")).rows[0].status,'PAID');
    const zero=await support.supportCancelAfterOpening(client,cancelActor,{...request,refundCents:'10000',ownerCents:'0',ownerAmountBasis:'GROSS_BEFORE_FEE_V1'});
    assert.equal(zero.body.poststartCancellation.fullPayoutFeeCents,'0');assert.equal(zero.body.poststartCancellation.fullPayoutSelected,null);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('ROLLBACK TO SAVEPOINT cancellation_unknown_payout');
    await client.query('SAVEPOINT cancellation_no_payout');
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query("UPDATE zzsh_order.rental_order SET quote_snapshot=jsonb_set(quote_snapshot,'{personal,fullPayoutDeclaration,selected}','false'::jsonb) WHERE id='cfee_order'");
    await client.query("SET LOCAL session_replication_role='origin'");
    const noPayout=await support.supportCancelAfterOpening(client,cancelActor,{...request,ownerAmountBasis:'GROSS_BEFORE_FEE_V1'});
    assert.equal(noPayout.body.poststartCancellation.ownerCents,'2000');assert.equal(noPayout.body.poststartCancellation.fullPayoutFeeCents,'0');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('ROLLBACK TO SAVEPOINT cancellation_no_payout');
    const cancelled=await support.supportCancelAfterOpening(client,cancelActor,{...request,ownerAmountBasis:'GROSS_BEFORE_FEE_V1'});
    assert.deepEqual([cancelled.body.poststartCancellation.ownerGrossCents,cancelled.body.poststartCancellation.fullPayoutFeeCents,
      cancelled.body.poststartCancellation.ownerCents,cancelled.body.poststartCancellation.refundCents,cancelled.body.poststartCancellation.platformContributionCents],
      ['2000','160','1840','5000','3160']);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const cancelEntries=(await client.query(`SELECT l.account_code,l.debit_cents::text AS debit,l.credit_cents::text AS credit
      FROM zzsh_order.settlement_ledger_entry l JOIN zzsh_order.support_poststart_cancellation p ON p.event_id=l.finance_event_id
      WHERE p.order_id='cfee_order' ORDER BY l.line_no`)).rows;
    assert.deepEqual(cancelEntries.map(x=>[x.account_code,x.debit,x.credit]),[
      ['CAPTURED_PAYMENT_SOURCE','10000','0'],['RENTER_REFUND_PAYABLE','0','5000'],['OWNER_AVAILABLE','0','1840'],
      ['PLATFORM_CANCELLATION_CONTRIBUTION','0','3000'],['PLATFORM_COMPENSATION_FEE','0','160']]);
    const readback=await support.readSupportCancellation(client,cancelActor,'cfee_order');
    assert.equal(readback.poststartCancellation.ownerGrossCents,'2000');assert.equal(readback.poststartCancellation.fullPayoutFeeCents,'160');
    console.log('PASS synthetic PostgreSQL: old cancellation replay and new gross-owner cancellation with separate fee ledger');
  } finally {
    await client.query('ROLLBACK');client.release();payment.assertControlledSettlementResource=originalAdmission;await pool.end();
  }
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;pool.end().catch(()=>{});});
