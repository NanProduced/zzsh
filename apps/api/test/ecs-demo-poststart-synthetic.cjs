// Isolated disposable PostgreSQL only; no real provider or business data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Pool}=require('pg');
assert.equal(process.env.ECS_CANCEL_SYNTH_OPT_IN,'1');
const port=Number(process.env.ECS_CANCEL_SYNTH_PORT),oid=Number(process.env.ECS_CANCEL_SYNTH_OID);
assert(Number.isInteger(port)&&port>1024&&port<65536&&Number.isInteger(oid)&&oid>0);
assert(/^[1-9]\d*$/.test(process.env.ECS_CANCEL_SYNTH_SYSTEM_ID||''));
const db=process.env.ECS_CANCEL_SYNTH_DB||'zzsh_ecs_test_synth_refund';
assert(['zzsh_ecs_test_synth_refund','zzsh_ecs_test_synth_r2','zzsh_ecs_test_synth_r3'].includes(db));
const opts={host:'127.0.0.1',port,database:db,statement_timeout:10000};
const migration=new Pool({...opts,user:'zzsh_synth_migrator',max:1}),admin=new Pool({...opts,user:'postgres',max:1}),runtime=new Pool({...opts,user:'zzsh_synth_runtime',max:2});
const resourceModule=require('../dist/src/finance/ecs-test-demo-resource.js'),paymentModule=require('../dist/src/order/channel-payment-store.js');
async function main(){
 const ids=(await admin.query(`SELECT d.oid::int AS oid,shobj_description(d.oid,'pg_database') AS marker,
  (pg_control_system()).system_identifier::text AS system_id,d.datdba::int AS owner_oid,
  (SELECT oid::int FROM pg_roles WHERE rolname='zzsh_synth_migrator') AS migration_oid,
  (SELECT oid::int FROM pg_roles WHERE rolname='zzsh_synth_runtime') AS runtime_oid FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.equal(ids.oid,oid);assert.equal(ids.marker,'zzsh:ecs-test:v1');assert.equal(ids.system_id,process.env.ECS_CANCEL_SYNTH_SYSTEM_ID);
 const resource={database:db,databaseOid:oid,systemIdentifier:ids.system_id,marker:ids.marker,owner:'zzsh_synth_owner',ownerOid:ids.owner_oid,
  migrationRole:'zzsh_synth_migrator',migrationRoleOid:ids.migration_oid,runtimeRole:'zzsh_synth_runtime',runtimeRoleOid:ids.runtime_oid};
 const config={profile:'ecs-test',provider:'real',testOperationsEnabled:false,database:{target:'ecs-test',targetProfile:'ecs-test',name:db,user:resource.runtimeRole,
  runtimeUser:resource.runtimeRole,ssl:{rejectUnauthorized:true}}};
 const env={ECS_TEST_DEMO_FINANCE_ENABLED:'true',APP_PROFILE:'ecs-test',NODE_ENV:'production',JOINPAY_COLLECTION_ENABLED:'false',
  JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
 const origins={apiOrigin:'https://api.example.invalid',userOrigin:'https://user.example.invalid',adminOrigin:'https://admin.example.invalid',secureCookies:true};
 const demo=resourceModule.createEcsTestDemoResource({config,env,origins,reference:'synth_demo',administratorId:'post_admin',
  sourceSnapshotSha256:'a'.repeat(64),restoreReceiptSha256:'b'.repeat(64),resource});assert(demo);
 const proof=resourceModule.readEcsTestDemoRegistration(demo);
 const mc=await migration.connect();
 try{
  await mc.query('BEGIN');
  const existing=(await mc.query("SELECT canonical_registration,registration_digest FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference='synth_demo'")).rows[0];
  if(existing)assert.deepEqual(existing,{canonical_registration:proof.canonical,registration_digest:proof.digest});
  else await mc.query('INSERT INTO zzsh_order.ecs_test_demo_finance_registration(reference,canonical_registration,registration_digest) VALUES($1,$2,$3)',
   [proof.registration.reference,proof.canonical,proof.digest]);
  await require('../dist/src/database/business-migrations.js').applyRuntimePrivileges(mc,resource.runtimeRole);
  const grant=fs.readFileSync(path.join(__dirname,'../migrations/candidates/ecs-test-demo-finance/grant-runtime.sql'),'utf8');
  await mc.query(grant);await mc.query('COMMIT');
 }catch(e){await mc.query('ROLLBACK').catch(()=>{});throw e;}finally{mc.release();}
 console.log('PASS: production initial, demo schema and cancellation runtime ACL installed on isolated synthetic PG');
 const capability=paymentModule.createEcsDemoRefundCapability(demo);
 assert.equal(paymentModule.demoForChannelRequestCapability(capability),demo);
 const tag=process.env.ECS_CANCEL_SYNTH_TAG||'post';assert(/^[a-z][a-z0-9]{0,12}$/.test(tag));
 const orderId=`${tag}_order`,renterId=`${tag}_renter`,ownerId=`${tag}_owner`,paymentId=`${tag}_payment`,adminId=`${tag}_admin`,sessionId=`${tag}_admin_session`;
 const anchor=resourceModule.ecsTestDemoPaymentAnchor(demo,orderId);
 const fixture=fs.readFileSync(path.join(__dirname,'fixtures/poststart-support-refund-synthetic.sql'),'utf8');
 const boundary=fixture.indexOf("UPDATE zzsh_order.payment_confirmation SET source='JOINPAY'");assert(boundary>0);
 const seed=fixture.slice(0,boundary).replaceAll('post_',`${tag}_`).replaceAll('post-',`${tag}-`).replace('POST_ORDER',`${tag.toUpperCase()}_ORDER`)
  .replace("'JOINPAY',","'CONTROLLED',")
  .replace(`'${tag}_payment_req','${tag}_req','${tag}_evidence','${tag}_anchor'`,`'${tag}_payment_req',NULL,NULL,NULL`)
  .replace(`${tag}_merchant`,anchor.merchantScopeId).replace(`${tag}_trx`,anchor.providerTransactionId).replace(`${tag}_payment_req`,anchor.requestId)
  .replace("'LEGACY_MYSQL','la_user','1'",`'LEGACY_MYSQL','la_user','${tag}'`);
 const ac=await admin.connect();
 try{
  assert.equal((await ac.query('SELECT 1 FROM zzsh_order.rental_order WHERE id=$1',[orderId])).rowCount,0,'synthetic tag already used');
  await ac.query(seed);
  const admitted=`${tag}_admission`,orderNo=`${tag}_order_no`;
  await ac.query(`INSERT INTO zzsh_order.distribution_order_admission(id,order_id,mode,resource_oid,resource_name,resource_marker,
    approval_digest,native_creation_audit_id,revision,active,admitted_at,expires_at,created_by_admin_id,reason)
    VALUES($1,$2,'LOCAL_CONTROLLED',$3,$4,$5,$6,$7,1,true,clock_timestamp()-interval '1 minute','infinity',$8,'Synthetic admission')`,
   [admitted,orderId,oid,db,resource.marker,proof.digest,`${tag}_audit`,adminId]);
  const canonical=JSON.stringify({orderId,amountCents:'10000',currency:'CNY',providerTransactionId:anchor.providerTransactionId});
  await ac.query(`INSERT INTO zzsh_order.controlled_payment_declaration(id,mode,source_event_key,resource_oid,app_id,merchant_scope_id,
   admission_id,admission_revision,order_id,merchant_order_no,provider_transaction_id,canonical_payment,payment_digest,approval_digest,created_by_admin_id,reason)
   VALUES($1,'LOCAL_CONTROLLED_DECLARED_PAYMENT',$2,$3,'synthetic_app',$4,$5,1,$6,$7,$8,$9,$10,$11,$12,'Synthetic payment')`,
   [anchor.declarationId,`${tag}_source_event`,oid,anchor.merchantScopeId,admitted,orderId,orderNo,anchor.providerTransactionId,canonical,
    crypto.createHash('sha256').update(canonical).digest('hex'),proof.digest,adminId]);
  await ac.query('SET LOCAL session_replication_role=origin');await ac.query('COMMIT');
 }catch(e){await ac.query('ROLLBACK').catch(()=>{});throw e;}finally{ac.release();}
 const rc=await runtime.connect();
 try{
  await rc.query('BEGIN');await rc.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id',$1,true),set_config('zzsh.session_id',$2,true),set_config('zzsh.request_id',$3,true)",[adminId,sessionId,`${tag}_cancel_req`]);
  const {readAccountOccupancyFacts}=require('../dist/src/order/legacy-order-occupancy.js');
  assert.equal((await readAccountOccupancyFacts(rc,`${tag}_account`)).state,'OCCUPIED');
  const {supportCancelAfterOpening}=require('../dist/src/order/support-cancel.js');
  const result=await supportCancelAfterOpening(rc,{userId:adminId,sessionId,ecsTestDemo:demo},
   {orderId,expectedOrderRevision:'1',reason:'客服协商取消',refundCents:'5000',ownerCents:'3000',requestId:`${tag}_cancel_req`});
  assert.equal(result.body.poststartCancellation.refundCents,'5000');assert.equal(result.body.poststartCancellation.commissionCents,'0');
  assert.equal((await readAccountOccupancyFacts(rc,`${tag}_account`)).state,'FREE');
  await rc.query('SET CONSTRAINTS ALL IMMEDIATE');await rc.query('COMMIT');
 }catch(e){await rc.query('ROLLBACK').catch(()=>{});throw e;}finally{rc.release();}
 const {runEcsDemoRefundBatch}=require('../dist/src/order/ecs-demo-refund-service.js');
 const outcome=await runEcsDemoRefundBatch(runtime,{demo,capability},10,`${tag}_worker`);
 assert.equal(outcome.cancellationSelected,1);assert.equal(outcome.cancellationAllocations[0].outcome,'ALLOCATED');
 const refund=(await admin.query(`SELECT state,budget_disposition,amount_cents::text,basis_kind,
   zzsh_order.local_controlled_refund_terminal_complete(id) AS complete FROM zzsh_order.channel_refund_intent WHERE order_id=$1`,[orderId])).rows[0];
 assert.deepEqual(refund,{state:'SUCCEEDED',budget_disposition:'CONSUMED',amount_cents:'5000',basis_kind:'SUPPORT_CANCELLATION',complete:true});
 const replay=await runEcsDemoRefundBatch(runtime,{demo,capability},10,`${tag}_worker`);
 assert.equal(replay.cancellationSelected,0);assert.equal(replay.outcomes.length,0);
 const balances=(await admin.query(`SELECT
  COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='OWNER_AVAILABLE' AND counterparty_user_id=$2),0)::text AS owner,
  COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='RENTER_REFUND_PAYABLE' AND counterparty_user_id=$3),0)::text AS refund_pending,
  COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='PLATFORM_CANCELLATION_CONTRIBUTION'),0)::text AS platform
  FROM zzsh_order.settlement_ledger_entry WHERE details->>'orderId'=$1 OR finance_event_id IN
   (SELECT terminal_event_id FROM zzsh_order.channel_refund_intent WHERE order_id=$1)`,[orderId,ownerId,renterId])).rows[0];
 assert.deepEqual(balances,{owner:'3000',refund_pending:'0',platform:'2000'});
 const readClient=await runtime.connect();
 try{
  await readClient.query('BEGIN READ ONLY');
  const {readPersonalSupportCancellationRefund}=require('../dist/src/finance/personal-refund-read.js');
  const read=await readPersonalSupportCancellationRefund(readClient,orderId,renterId,paymentId,demo);
  assert.deepEqual(read,{state:'SUCCEEDED',amountCents:'5000',source:'SIMULATED',bankArrival:'UNKNOWN'});
  const ownerSummary=await require('../dist/src/finance/owner-refund-summary-read.js').readOwnerRefundMinimalSummary(readClient,
   {userId:ownerId,sessionId:`${tag}_session_owner`},{orderId});
  assert.equal(ownerSummary.progress,'DONE');
  const entries=(await readClient.query(`SELECT l.id FROM zzsh_order.settlement_ledger_entry l
   JOIN zzsh_order.support_poststart_cancellation p ON p.event_id=l.finance_event_id WHERE p.order_id=$1 AND l.account_code='OWNER_AVAILABLE'`,[orderId])).rows;
  const origin=await require('../dist/src/finance/demo-ledger-provenance.js').readDemoLedgerOrigins(readClient,entries.map(r=>r.id));
  assert.equal(origin.get(entries[0].id),'ECS_TEST_SIMULATED');
  const ledgerSql=require('../dist/src/finance/admin-finance-read.js').adminFinanceLedgerSql(true,true)
   .replace(/\s+ORDER BY l\.id COLLATE "C" LIMIT \$1\s*$/,' AND l.id=$1');
  const ledger=(await readClient.query(ledgerSql,[entries[0].id])).rows[0];assert.equal(ledger.order_id,orderId);
  await readClient.query('ROLLBACK');
 }finally{readClient.release();}
 const probe=await admin.connect();
 try{
  await probe.query('BEGIN');
  await probe.query('ALTER TABLE zzsh_order.settlement_ledger_entry DISABLE TRIGGER support_poststart_entry_guard');
  await probe.query('SET LOCAL ROLE zzsh_synth_runtime');
  assert.equal(await require('../dist/src/order/support-cancel.js').supportPoststartSchemaReady(probe,true),false);
 }finally{await probe.query('ROLLBACK').catch(()=>{});probe.release();}
 console.log('PASS: real synthetic-PG cancellation, simulated original refund, renter readback and demo ledger origin');
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{await migration.end();await admin.end();await runtime.end();});
