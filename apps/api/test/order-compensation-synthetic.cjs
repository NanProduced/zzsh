// Dedicated disposable PostgreSQL only. The fixture uses injected context and does not test auth or a provider.
const assert=require('node:assert/strict'),Module=require('node:module'),{createHash}=require('node:crypto'),{readFileSync}=require('node:fs'),{join}=require('node:path'),{Pool}=require('pg');
assert.equal(process.env.ORDER_COMPENSATION_SYNTH_OPT_IN,'1');
assert.match(process.env.ORDER_COMPENSATION_SYNTH_OID??'',/^[1-9]\d*$/);
assert.match(process.env.ORDER_COMPENSATION_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const originalLoad=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args);};
const {canonicalize}=require('../dist/src/supply/content-hash.js');
const {computeDeltaQuote}=require('../dist/src/supply/pricing.js');
const {compatRule}=require('../dist/test/pricing-compat-fixture.js');
const {handleAdminApprovalRoute}=require('../dist/src/auth/approval-audit.js');
const {applyRuntimePrivileges}=require('../dist/src/database/business-migrations.js');
const {executeOrderCompensation,compensationOrderBasis,readCompensationCases}=require('../dist/src/finance/order-compensation-approval.js');
const {readPersonalFinanceEntries}=require('../dist/src/finance/personal-finance-read.js');
const {readAdminBalanceActivity,parseActivityQuery}=require('../dist/src/finance/admin-finance-activity.js');
const raw=new Pool({host:'127.0.0.1',port:5432,user:'postgres',database:'zzsh_order_comp_synth',max:6,statement_timeout:10000});
const pool={async connect(){const c=await raw.connect();try{await c.query('SET ROLE synth_comp_runtime');return c;}catch(e){c.release();throw e;}},async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
const ctx=async()=>({userId:'synthetic_ops',sessionId:'synthetic_session'}),opts={pool,testOperationsEnabled:false,approvalOperationExecutor:executeOrderCompensation};
async function call(method,path,body,key){let statusCode=0,result;const response={headersSent:false,status(n){statusCode=n;return this},setHeader(){return this},json(value){result=value;return this}};
 try{await handleAdminApprovalRoute({method,originalUrl:'/api/v1/admin/security'+path,body,headers:key?{'idempotency-key':key}:{}},response,'synthetic_trace',opts,ctx);return{status:statusCode,body:result};}
 catch(e){if(typeof e.status==='number')return{status:e.status,error:e.message};throw e;}}
(async()=>{
 const c=await raw.connect();try{
  const identity=(await c.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,(pg_control_system()).system_identifier::text AS system_id,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(identity,{db:'zzsh_order_comp_synth',role:'postgres',host:'127.0.0.1/32',system_id:process.env.ORDER_COMPENSATION_SYNTH_SYSTEM_ID,oid:process.env.ORDER_COMPENSATION_SYNTH_OID,marker:'zzsh:order-compensation-synth:v1'});
  assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='synth_comp_runtime'")).rows[0].n,0,'a fresh synthetic instance is required');
  await c.query(readFileSync(join(__dirname,'order-compensation-synthetic-seed.sql'),'utf8').replace(/^\\set ON_ERROR_STOP on\s*/,''));
  await c.query('BEGIN');await applyRuntimePrivileges(c,'synth_comp_runtime');await c.query('COMMIT');
  const computed=computeDeltaQuote({priceVersionId:'price',mode:'SPREAD',customerTier:'STANDARD',roundingPolicy:'HALF_UP_CENT_V1',haffRule:compatRule('47'),conditions:{safeBoxCode:'box-a',vitLevel:6,bearLevel:6,termOptionCode:'daily-10m',rentalPricing:{rentalMode:'ordinary'}},termOption:{code:'daily-10m',dailyConsumption:'10000000',durationRounding:'CEIL_DAY'},lines:[{itemId:'haff',customerTier:'STANDARD',quantity:'100000000',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO'}],deposits:{tenantDepositCents:'0',publisherBailRequirementCents:'0'}});
  assert(computed.quotable);const quote=computed.quote,hash='a'.repeat(64),cents=String(BigInt(quote.resourceTotal.amount.replace('.','')));
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  for(const [suffix,selected,tampered,mismatch] of [['selected',true,false,false],['unselected',false,false,false],['tampered',true,true,false],['mismatch',true,false,true]]){
   const id='synthetic_native_'+suffix,paymentId='synthetic_payment_'+suffix;
   const personal={schema:'personal-quote-v4',userId:'synthetic_renter',ownerUserId:'synthetic_owner',accountId:'synthetic_account',listingVersionId:'synthetic_listing',listingHash:hash,ruleRefs:{releaseId:'synthetic_release'},fullPayoutDeclaration:{schema:'full-payout-declaration-v1',selected}};
   const confirmationDigest=createHash('sha256').update(canonicalize({...personal,quote})).digest('hex');
   const snapshot={...quote,personal,listingHash:hash,confirmationDigest:tampered?'b'.repeat(64):confirmationDigest};
   await c.query(`INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,term_seconds,quote_snapshot,title,hold_until,paid_confirmation_id,paid_at)
    VALUES($1,$2,'synthetic_account','synthetic_listing','synthetic_owner','synthetic_renter','synthetic_game','synthetic_release',$3,'daily-10m','COMPLETED',$4,0,86400,$5::jsonb,'synthetic',now(),$6,now())`,[id,id,hash,cents,JSON.stringify(snapshot),paymentId]);
   await c.query(`INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,request_id,joinpay_request_id,joinpay_evidence_id,joinpay_anchor_id)
    VALUES($1,'JOINPAY','synthetic',$1,$1,$2,$3,'CNY',now(),'APPLIED','synthetic_trace',$4,$5,$6)`,[paymentId,id,mismatch?String(BigInt(cents)+1n):cents,'synthetic_request_'+suffix,'synthetic_evidence_'+suffix,'synthetic_anchor_'+suffix]);
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 const client=await pool.connect();let basis;try{
  basis=await compensationOrderBasis(client,'NATIVE','synthetic_native_selected');assert.equal(basis.state,'SELECTED');
  assert.equal((await compensationOrderBasis(client,'NATIVE','synthetic_native_unselected')).state,'NOT_SELECTED');
  assert.equal((await compensationOrderBasis(client,'NATIVE','synthetic_native_tampered')).state,'UNKNOWN');
  assert.equal(await compensationOrderBasis(client,'NATIVE','synthetic_native_mismatch'),null);
 }finally{client.release();}
 const payload={schema:'order-compensation.v1',orderId:basis.orderId,origin:basis.origin,gameId:basis.gameId,ownerUserId:basis.ownerUserId,sourceDigest:basis.sourceDigest,amountCents:'3456',caseRef:'合成新单事故-1',reason:'合成环境核对',evidenceRef:'合成凭证-1'};
 const body={operationCode:'order.compensation.grant',triggerCondition:'order.compensation.requested',payloadVersion:1,payload,summary:'synthetic native compensation'};
 const [a,b]=await Promise.all([call('POST','/approvals/requests',body,'idem_synth_native_a'),call('POST','/approvals/requests',body,'idem_synth_native_b')]);
 assert.deepEqual([a.status,b.status].sort(),[200,409],JSON.stringify({a,b}));const id=(a.status===200?a:b).body.approvalRequestId;
 const approved=await call('POST','/approvals/requests/decision',{requestId:id,decision:'APPROVE'},'idem_synth_native_decide');assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.body.status,'EXECUTED');
 const proof=(await raw.query(`SELECT count(*)::int AS cases,min(p.amount_cents)::text AS amount,bool_and(zzsh_order.order_compensation_posting_complete(p.id)) AS complete FROM zzsh_order.order_compensation_posting p WHERE p.approval_request_id=$1`,[id])).rows[0];
 assert.deepEqual(proof,{cases:1,amount:'3456',complete:true});
 const legacy=await pool.connect();let legacyBasis;try{legacyBasis=await compensationOrderBasis(legacy,'LEGACY','legacy_order_synthetic');assert.equal(legacyBasis.state,'LEGACY_REVIEW');}finally{legacy.release();}
 const legacyPayload={schema:'order-compensation.v1',orderId:legacyBasis.orderId,origin:'LEGACY',gameId:legacyBasis.gameId,ownerUserId:legacyBasis.ownerUserId,sourceDigest:legacyBasis.sourceDigest,amountCents:'1200',caseRef:'合成旧单事故-1',reason:'合成环境核对',evidenceRef:'合成凭证-2'};
 const legacyRequest=await call('POST','/approvals/requests',{...body,payload:legacyPayload},'idem_synth_legacy_create');assert.equal(legacyRequest.status,200,JSON.stringify(legacyRequest));
 const legacyId=legacyRequest.body.approvalRequestId,decision={requestId:legacyId,decision:'APPROVE'};
 const [first,second]=await Promise.all([call('POST','/approvals/requests/decision',decision,'idem_synth_legacy_decide'),call('POST','/approvals/requests/decision',decision,'idem_synth_legacy_decide')]);
 assert.equal(first.status,200,JSON.stringify(first));assert.equal(second.status,200,JSON.stringify(second));assert([first.body.idempotencyReplay,second.body.idempotencyReplay].includes(true));
 const legacyProof=(await raw.query(`SELECT count(*)::int AS cases,bool_and(zzsh_order.order_compensation_posting_complete(p.id)) AS complete FROM zzsh_order.order_compensation_posting p WHERE p.approval_request_id=$1`,[legacyId])).rows[0];assert.deepEqual(legacyProof,{cases:1,complete:true});
 const expiredBody={...body,payload:{...payload,caseRef:'合成过期事故-1'}};
 const expiredRequest=await call('POST','/approvals/requests',expiredBody,'idem_synth_expired_create');assert.equal(expiredRequest.status,200,JSON.stringify(expiredRequest));
 const expiredId=expiredRequest.body.approvalRequestId;
 const unsafeReplacement=await call('POST','/approvals/requests',{...expiredBody,payload:{...expiredBody.payload,caseRef:'不同事故-2'},supersedesRequestId:expiredId},'idem_synth_replace_reject');assert.equal(unsafeReplacement.status,400,JSON.stringify(unsafeReplacement));
 const fixture=await raw.connect();try{await fixture.query('RESET ROLE');assert.equal((await fixture.query('SELECT status FROM zzsh_iam.approval_request WHERE id=$1',[expiredId])).rows[0].status,'PENDING');await fixture.query('BEGIN');await fixture.query("SET LOCAL session_replication_role='replica'");await fixture.query("UPDATE zzsh_iam.approval_request SET expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[expiredId]);await fixture.query('COMMIT');}catch(e){await fixture.query('ROLLBACK').catch(()=>{});throw e;}finally{fixture.release();}
 const replacement=await call('POST','/approvals/requests',expiredBody,'idem_synth_expired_retry');assert.equal(replacement.status,200,JSON.stringify(replacement));
 const expiredState=(await raw.query(`SELECT a.status,(SELECT count(*)::int FROM zzsh_order.order_compensation_posting p WHERE p.approval_request_id=a.id) AS postings FROM zzsh_iam.approval_request a WHERE a.id=$1`,[expiredId])).rows[0];assert.deepEqual(expiredState,{status:'EXPIRED',postings:0});
 const read=await pool.connect();try{
  const page=await readPersonalFinanceEntries(read,{userId:'synthetic_owner',sessionId:'synthetic_user_session'},{limit:20,cursor:null,bucket:'AVAILABLE',projectionVersion:3},undefined);
  const credits=page.items.filter(item=>item.sourceKind==='ORDER_COMPENSATION_PAID');assert.equal(credits.length,2);
  assert.deepEqual(credits.map(item=>[item.businessReference.type,item.businessReference.id,item.deltaCents]).sort(),[['LEGACY_ORDER','legacy_order_synthetic','1200'],['RENTAL_ORDER','synthetic_native_selected','3456']]);
  const admin=await readAdminBalanceActivity(read,parseActivityQuery(new URLSearchParams('view=LIVE&type=FULL_PAYOUT_COMPENSATION&subjectUserId=synthetic_owner'),true),{adminId:'synthetic_ops',isBoss:true,orderRead:true,financeDocumentRead:true,resourceRead:true});
  assert.equal(admin.items.length,2);assert(admin.items.every(item=>item.label==='包赔赔偿'&&item.documentRef===null));
 }finally{read.release();}
 const guard=await raw.connect();try{await guard.query('RESET ROLE');await guard.query('BEGIN');await guard.query('ALTER TABLE zzsh_order.finance_event DISABLE TRIGGER order_compensation_event_complete');await guard.query('SET ROLE synth_comp_runtime');assert.equal((await readCompensationCases(guard,'NATIVE',basis.orderId)).state,'UNAVAILABLE');await guard.query('ROLLBACK');}catch(e){await guard.query('ROLLBACK').catch(()=>{});throw e;}finally{guard.release();}
 const failure=await raw.connect();try{
  await failure.query('RESET ROLE');
  for(const [file,requestId,expected] of [['order-compensation-synthetic-rollback.sql','synthetic_abort',/compensation approval and ledger are not closed/],['order-compensation-synthetic-denied.sql','synthetic_denied_request',/compensation approval permission unavailable/]]){
   const sql=readFileSync(join(__dirname,file),'utf8').replace(/\r\n/g,'\n').replace(/^\\set ON_ERROR_STOP on\s*/,'');
   const split=sql.indexOf('BEGIN;\nSET LOCAL ROLE synth_comp_runtime;');assert(split>0);
   await failure.query(sql.slice(0,split));
   await assert.rejects(()=>failure.query(sql.slice(split)),expected);await failure.query('ROLLBACK');
   const row=(await failure.query(`SELECT a.status,(SELECT count(*)::int FROM zzsh_iam.approval_decision d WHERE d.request_id=a.id) AS decisions,(SELECT count(*)::int FROM zzsh_order.order_compensation_posting p WHERE p.approval_request_id=a.id) AS postings FROM zzsh_iam.approval_request a WHERE a.id=$1`,[requestId])).rows[0];
   assert.deepEqual(row,{status:'PENDING',decisions:0,postings:0});
  }
 }finally{failure.release();}
 process.stdout.write('COMPENSATION_SYNTHETIC_PG_PASS\n');
})().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;}).finally(()=>raw.end());
