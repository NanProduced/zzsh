import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {scopedFinanceSql,financeVersionSql,financeScopedVersionSql,financeLookupPageSql,FINANCE_GLOBAL_VERSION_DOMAIN} from "../src/finance/admin-finance-query";
import {parseAdminFinanceFilters,adminFinanceObservationSql,ADMIN_FINANCE_LEDGER_SQL,projectAdminFinanceObservation,projectAdminFinanceLedger,projectUnpostedFinanceSource,financeDocuments,readAdminFinanceSubject,financeSnapshot,financePeriodProjection} from "../src/finance/admin-finance-read";
import {FinanceSqlFixture} from './admin-finance-fixture';
import {prepareOwnerGuaranteeHistory} from '../src/finance/owner-guarantee-history';

test("query selection is before the matched ceiling and restored content digest covers all source rows",()=>{
 const filters=parseAdminFinanceFilters(new URLSearchParams("scope=u1&q=%25_%5C&from=2026-10-03&to=2026-10-03"));
 const query=scopedFinanceSql("SELECT * FROM input ORDER BY l.id COLLATE \"C\" LIMIT $1","ledger",{filters},20001,false);
 assert.ok(query.text.indexOf("WHERE")<query.text.lastIndexOf("LIMIT"));assert.ok(query.values.includes("u1"));assert.equal(query.values.at(-1),20001);assert.ok(query.values.some(value=>typeof value==="string"&&value.includes("\\%\\_\\\\")));
 const version=financeVersionSql({withdrawals:true,native_orders:true,legacy_orders:true});assert.ok(!/LIMIT|pg_current_snapshot|current_database|count\(|max\(/i.test(version));assert.match(version,/string_agg/);assert.match(version,/controlled_payout_operation/);assert.match(version,/wallet_revision/);assert.match(version,/legacy_order_read_snapshot/);
});

test('restored finance content changes for original responsibility evidence, not unrelated cluster activity',()=>{
 const fixture=new FinanceSqlFixture({ledger:[{id:'line1',subject_id:'u1',delta:'100',at:'2026-10-03T01:00:00Z',details:{legacyDutyId:'duty1'}}],legacy:[{id:'old1',source_snapshot:{return_order_money:'1.00',unrelatedNote:'before'}}],legacyDutyFacts:[{duty_id:'duty1',order_id:'old1',facts_canonical:'original',facts_digest:'a'.repeat(64)}],legacyDuties:[{id:'duty1',order_id:'old1',counterparty_user_id:'u1',amount_cents:'100',maturity_at:'2026-10-03T01:00:00Z'}]});
 try{
  fixture.db.exec("INSERT INTO zzsh_order.settlement_posting(id,settlement_version_id,refund_due_at) VALUES('posting1','version1','2026-10-03T01:00:00Z')");
  const sql=financeVersionSql({legacy_orders:true,legacy_duty_finance:true}),version=()=>fixture.query(sql,[]).rows[0]!.finance_version;
  let previous=version();fixture.clusterSnapshot='200:300:201';assert.equal(version(),previous);
  fixture.db.prepare("UPDATE zzsh_order.legacy_order_read_snapshot SET source_snapshot=? WHERE id='old1'").run(JSON.stringify({return_order_money:'1.00',unrelatedNote:'after'}));assert.equal(version(),previous);
  for(const statement of [
   "UPDATE zzsh_order.settlement_posting SET settlement_version_id='version2' WHERE id='posting1'",
   "UPDATE zzsh_order.settlement_posting SET refund_due_at='2026-10-04T01:00:00Z' WHERE id='posting1'",
   "UPDATE zzsh_order.legacy_order_duty SET maturity_at='2026-10-05T01:00:00Z' WHERE id='duty1'",
   "UPDATE zzsh_order.legacy_order_duty SET counterparty_user_id='u2' WHERE id='duty1'",
   "UPDATE zzsh_order.legacy_duty_finance_fact SET facts_canonical='changed' WHERE duty_id='duty1'",
   "UPDATE zzsh_order.fixture_ledger SET details='{}' WHERE id='line1'",
   "UPDATE zzsh_order.legacy_order_read_snapshot SET source_snapshot='{\"return_order_money\":\"2.00\"}' WHERE id='old1'"
  ]){fixture.db.exec(statement);const next=version();assert.notEqual(next,previous,statement);previous=next;}
 }finally{fixture.close();}
});

test('subject finance applies the requested Beijing day before limiting both ledger and historical documents',()=>{
 const ledger=(id:string,subject_id:string,at:string|null,account_code='WALLET_AVAILABLE')=>({id,subject_id,subject_name:subject_id,at,account_code,delta:'100',posting_id:'posting-'+id,order_id:'order-'+id,source_entity:'settlement_posting'});
 const history=(id:string,subject_id:string,at:string|null)=>({id,subject_id,subject_name:subject_id,at,source_entity:'la_log_earnings',source_kind:'HISTORICAL_EARNINGS_LOG',source_id:id,amount:'1.00',action:'1'});
 const fixture=new FinanceSqlFixture({ledger:[ledger('01-before','u1','2026-10-21T15:59:59.999Z'),ledger('02-start','u1','2026-10-21T16:00:00Z'),ledger('03-last','u1','2026-10-22T15:59:59.999Z'),ledger('04-after','u1','2026-10-22T16:00:00Z'),ledger('05-other','u2','2026-10-22T01:00:00Z'),ledger('06-reserved','u1','2026-10-22T01:00:00Z','WALLET_RESERVED'),ledger('07-unknown','u1',null)],
  history:[history('01-old','u1','2026-06-01T00:00:00Z'),history('02-today','u1','2026-10-22T01:00:00Z'),history('03-other','u2','2026-10-22T01:00:00Z'),history('04-unknown','u1',null)]});
 try{
  const filters=parseAdminFinanceFilters(new URLSearchParams('scope=ALL&bucket=AVAILABLE&period=1&from=2026-10-22&to=2026-10-22'));
  for(const [family,source,expected] of [['ledger',ADMIN_FINANCE_LEDGER_SQL,['02-start','03-last','07-unknown']],['history',adminFinanceObservationSql({}),['02-today','04-unknown']]] as const){
   const query=scopedFinanceSql(source,family,{subjectId:'u1',filters},3,false);
   assert.deepEqual(fixture.query(query.text,query.values).rows.map(row=>row.id),expected);
   assert(query.values.includes('2026-10-22T00:00:00+08:00'));assert(query.values.includes('2026-10-22T16:00:00.000Z'));
   assert(query.text.indexOf('r.at::timestamptz')<query.text.lastIndexOf('LIMIT'));
   const other=scopedFinanceSql(source,family,{subjectId:'u1',filters:{...filters,scope:'u2'}},3,false);
   assert.deepEqual(fixture.query(other.text,other.values).rows,[],'filter scope cannot override the subject in the URL');
  }
 }finally{fixture.close();}
});

test('subject all-time compatibility and document details retain their complete facts',()=>{
 const fixture=new FinanceSqlFixture({ledger:[
  {id:'one',subject_id:'u1',account_code:'WALLET_AVAILABLE',delta:'100',at:'2026-06-01T00:00:00Z',order_id:'shared'},
  {id:'two',subject_id:'u2',account_code:'WALLET_AVAILABLE',delta:'200',at:'2026-10-22T00:00:00Z',order_id:'shared'},
  {id:'three',subject_id:'u1',account_code:'WALLET_AVAILABLE',delta:'300',at:'2026-09-01T00:00:00Z',order_id:'other'},
 ]});
 try{
  const filters=parseAdminFinanceFilters(new URLSearchParams('scope=u1&period=0&from=2026-10-22&to=2026-10-22'),new Date(),false);
  const all=scopedFinanceSql(ADMIN_FINANCE_LEDGER_SQL,'ledger',{subjectId:'u1',filters},20,false);
  assert.deepEqual(fixture.query(all.text,all.values).rows.map(row=>row.id),['one','three']);
  const detail=scopedFinanceSql(ADMIN_FINANCE_LEDGER_SQL,'ledger',{subjectId:'u1',documentRef:'ORDER:shared',filters:{...filters,period:true}},20,false);
  assert.deepEqual(fixture.query(detail.text,detail.values).rows.map(row=>row.id),['one','two'],'document detail must keep both parties and all dates');
  assert(!detail.values.includes('2026-10-22T00:00:00+08:00'));
 }finally{fixture.close();}
});

test('a dated subject document selection does not turn the current wallet into a period balance',async()=>{
 const seen:{sql:string;values:unknown[]}[]=[],client={query:async(sql:string,values:unknown[]=[])=>{
  seen.push({sql,values});
  if(sql.includes('to_regclass'))return {rows:[{ready:true}],rowCount:1};
  if(sql.includes('FOR SHARE'))return {rows:[{id:'u1'}],rowCount:1};
  if(sql.includes('FROM zzsh_order.wallet_coverage c'))return {rows:[{origin:'LEGACY_IMPORT',cutoff:'2026-09-13T00:00:00Z',sourceDigest:'a'.repeat(64),coveredSetDigest:'b'.repeat(64),coverageVersion:'1'}],rowCount:1};
  if(sql.includes('FROM zzsh_order.wallet_revision'))return {rows:[{ledgerRevision:'5',readRevision:'2'}],rowCount:1};
  if(sql.includes('FROM zzsh_order.settlement_ledger_entry'))return {rows:[{available:'12850',reserved:'1000',pending:'0',refund:'200'}],rowCount:1};
  throw Error('Unexpected wallet source query');
 }};
 const data=await readAdminFinanceSubject(client as any,{subjects:[{id:'u1',name:'用户一'}],entries:[],revisions:[],withdrawalsReady:true,asOf:'2026-10-22T00:00:00Z',version:'proof'},'u1','2026-10-22T00:00:00Z');
 assert.deepEqual(data.documents,[]);assert.equal(data.wallet.buckets.available.amountCents,'12850');assert.equal(data.wallet.buckets.reserved.amountCents,'1000');
 const ledger=seen.find(query=>query.sql.includes('FROM zzsh_order.settlement_ledger_entry'))!;
 assert.deepEqual(ledger.values,['u1']);assert(!ledger.sql.includes('created_at>'));assert(!ledger.sql.includes('created_at<'));
});

test('historical earnings searches the original log number rather than pretending it is the related business number',()=>{
 const fixture=new FinanceSqlFixture({history:[{id:'original-log',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy_mysql_restore',source_entity:'la_log_earnings',source_kind:'HISTORICAL_EARNINGS_LOG',source_id:'11437',amount:'734.00',action:'2',reference_id:'5053',reference_no:null,at:'2026-06-29T11:22:00Z',extra_evidence:{snapshot:{legacyChangeType:1002,legacyLogNumber:'ORIGINAL-FLOW-20260629'}}}]});
 try{
  const filters=parseAdminFinanceFilters(new URLSearchParams('period=0&q=ORIGINAL-FLOW-20260629'),new Date(),false);
  const query=scopedFinanceSql(adminFinanceObservationSql({}),'history',{filters},20,false);
  const rows=fixture.query(query.text,query.values).rows;assert.equal(rows.length,1);assert.equal(rows[0]!.source_id,'11437');assert.equal(rows[0]!.reference_id,'5053');assert.equal(rows[0]!.reference_no,null);
  assert(query.text.includes('legacyLogNumber'));assert(!query.text.includes('ORIGINAL-FLOW-20260629'));
 }finally{fixture.close();}
});

test('actual native zero source branch remains visible as its distribution document without fabricating ledger rows',()=>{
 const fixture=new FinanceSqlFixture({earnings:[{id:'zero-earning',economic_root_id:'zero-earning',beneficiary_user_id:'u1',beneficiary_role:'RENTER_REFERRAL',amount_cents:'0',state:'SETTLED',funds_disposition:'SETTLED',version:'2',seed_digest:'a'.repeat(64),posting_digest:'b'.repeat(64),order_id:'native-order',created_at:'2026-10-03T01:00:00.000000Z'}],
  financeEvents:[{id:'zero-accrue',economic_root_id:'zero-earning',kind:'EARNING_PENDING',subject_user_id:'u1',created_at:'2026-10-03T01:00:00.000001Z'}],
  earningTransitions:[{id:'zero-receipt',earning_id:'zero-earning',action:'ACCRUE',expected_version:'0',result_version:'1',finance_event_id:'zero-accrue',source_digest:'b'.repeat(64)}]});
 try{
  const filters=parseAdminFinanceFilters(new URLSearchParams('scope=u1&kind=DISTRIBUTION&state=SETTLED&from=2026-10-03&to=2026-10-03')),source=adminFinanceObservationSql({native_distribution:true}),q=scopedFinanceSql(source,'history',{filters},20,false),rows=fixture.query(q.text,q.values).rows;assert.equal(rows.length,1);
  const row=projectAdminFinanceObservation(rows[0]!);assert.equal(row.documentRef,'DISTRIBUTION:zero-earning');assert.equal(row.deltaCents,'0');assert.equal(row.affectsCurrentLedger,false);assert.equal(row.classification,'ZERO_AMOUNT_FACT');
  const page=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,source,{}, {filters,lookup:{exact:false},page:1,pageSize:20}),keys=fixture.query(page.text,page.values).rows;assert.equal(keys[0]!.ref,'DISTRIBUTION:zero-earning');
  const empty=scopedFinanceSql(source,'history',{filters:{...filters,scope:'u2'}},20,false);assert.equal(fixture.query(empty.text,empty.values).rows.length,0);
  const version=financeVersionSql({native_distribution:true});assert(version.includes('rental_referral_earning'));assert.match(fixture.query(version,[]).rows[0]!.finance_version as string,/^[a-f0-9]{32}$/);
 }finally{fixture.close();}
});
test('actual guarantee history SQL uses its own source document and never adds paid observations to current held or old-order links',()=>{
 const input={userId:'u1',legacyUserId:'11',accountId:'account1',source:{id:'101',user_id:'11',no:'SOURCE-ACCOUNT',pay_money:'0.00',pay_is:'0',pay_time:null,return_is:null},payOrders:[{id:'501',order_id:'101',order_type:'2',pay_money:'5.00',pay_is:'1',create_time:'1779469700',pay_time:'1779469800',pay_order_sn:'ORIGINAL-MERCHANT'}]},p=prepareOwnerGuaranteeHistory(input);
 const fixture=new FinanceSqlFixture({guaranteeHistory:[{id:'guarantee-fixture',user_id:'u1',account_id:'account1',legacy_account_id:'101',source_canonical:p.sourceCanonical,source_digest:p.sourceDigest,source_cutoff:'2026-09-13T13:31:22.000Z',imported_at:'2026-10-03T01:00:00.000000Z'}]});
 try{const filters=parseAdminFinanceFilters(new URLSearchParams('scope=u1&kind=GUARANTEE&from=2026-10-03&to=2026-10-03')),source=adminFinanceObservationSql({guarantee_history:true}),q=scopedFinanceSql(source,'history',{filters},20,false),rows=fixture.query(q.text,q.values).rows;assert.equal(rows.length,1);
  const row=projectAdminFinanceObservation(rows[0]!);assert.equal(row.documentRef,'GUARANTEE_SOURCE:guarantee_source:guarantee-fixture');assert.equal(row.deltaCents,null);assert.equal(row.knowledge,'UNKNOWN');assert.equal(row.evidence.sourcePaidRecordCents,'500');assert.equal(row.evidence.currentLiabilityCents,null);assert.equal(row.affectsCurrentLedger,false);assert.equal(row.affectsCurrentWallet,false);assert.equal(row.related.length,0);assert(!JSON.stringify(row).includes('ORIGINAL-MERCHANT'));
  const page=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,source,{}, {filters,lookup:{exact:false},page:1,pageSize:20});assert.equal(fixture.query(page.text,page.values).rows[0]!.ref,row.documentRef);
  const other=scopedFinanceSql(source,'history',{filters:{...filters,scope:'u2'}},20,false);assert.equal(fixture.query(other.text,other.values).rows.length,0);
  assert.throws(()=>projectAdminFinanceObservation({...rows[0],subject_id:'u2'}),(e:any)=>e.status===503);
 }finally{fixture.close();}
});
test("actual PostgreSQL CTE: 6001 unrelated users and 25001 unrelated entries do not block exact filtered rows",{skip:process.env.ADM_FINANCE_QUERY_PG!=="admin_order_read"},async()=>{
 const c=JSON.parse(readFileSync("E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/admin_order_read/credentials.json","utf8"));
 assert.equal(c.database,"zzsh_test_order_admin_order_read");assert.equal(c.host,"127.0.0.1");assert.equal(c.port,55432);
 const pool=new Pool({host:c.host,port:c.port,database:c.database,user:c.runtime.role,password:c.runtime.password,application_name:"adm-finance-query-readonly",max:1});const client=await pool.connect();
 try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,"on");
 const base=`SELECT 'line_'||n AS id,'WALLET_AVAILABLE'::text AS account_code,'user_'||n AS subject_id,CASE WHEN n=6001 THEN '中文%_\\' ELSE '无关用户' END::text AS subject_name,'100'::text AS delta,'2026-10-03T00:00:00.000000Z'::text AS at,NULL::text AS event_kind,NULL::text AS source_kind,NULL::text AS beneficiary_role,NULL::text AS economic_root_id,NULL::text AS earning_state,NULL::text AS source_entity,'source_'||n AS source_id,NULL::text AS basis_id,NULL::text AS posting_id,NULL::text AS order_id,'NO_'||n AS display_no FROM generate_series(1,25001) n`;
 const scoped=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("scope=user_6001&from=2026-10-03&to=2026-10-03"))},20001,false);
 const rows=(await client.query(scoped.text,scoped.values)).rows;assert.equal(rows.length,1);assert.equal(rows[0].subject_id,"user_6001");
 const literal=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("q=%25_%5C&from=2026-10-03&to=2026-10-03"))},20001,false);assert.equal((await client.query(literal.text,literal.values)).rows.length,1);
 const all=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("from=2026-10-03&to=2026-10-03"))},20001,false);assert.equal((await client.query(all.text,all.values)).rows.length,20001);
 // This is a synthetic SELECT-only SQL branch check, not real finance-data acceptance.
 }finally{await client.query("ROLLBACK").catch(()=>undefined);client.release();await pool.end();}
});
test("document and subject digests ignore unrelated rows and still change when their own dependency changes",()=>{
 const fixture=new FinanceSqlFixture({ledger:[
  {id:"mine",subject_id:"u1",account_code:"WALLET_AVAILABLE",delta:"100",posting_id:"post-1",at:"2026-10-03T00:00:00Z"},
  {id:"other",subject_id:"u2",account_code:"WALLET_AVAILABLE",delta:"900",posting_id:"post-2",at:"2026-01-01T00:00:00Z"},
  {id:"platform",subject_id:null,account_code:"PLATFORM_FEE",delta:"10",posting_id:"post-1",at:"2026-10-03T00:00:00Z"},
 ],native:[{id:"order-1",owner_user_id:"u1",renter_user_id:"u2",status:"PAID",revision:"3"},{id:"order-2",owner_user_id:"u2",renter_user_id:"u1",status:"PAID",revision:"1"}]});
 try{
  fixture.db.exec("INSERT INTO zzsh_order.settlement_posting(id,order_id,version_hash,captured_cents) VALUES('post-1','order-1','hash-1','100'),('post-2','order-2','hash-2','900')");
  const ready={native_orders:true},global=()=>financeVersionSql(ready),scoped=()=>financeScopedVersionSql(ready,{mode:"document",documentRef:"ORDER:order-1"}),subject=()=>financeScopedVersionSql(ready,{mode:"subject",subjectId:"u1"});
  assert.equal(financeScopedVersionSql(ready,{mode:"document",documentRef:"POSTING:post-1"}),null);
  assert.match(global(),/admin-finance-proof\.r2/);assert.doesNotMatch(global(),/\$1|pg_current_snapshot|count\(|max\(/i);
  const digest=(query:{text:string;values:string[]}|null)=>fixture.query(query!.text,query!.values).rows[0]!.finance_version;
  const beforeGlobal=digest({text:global(),values:[]}),beforeDoc=digest(scoped()),beforeSubject=digest(subject());
  const ledgerRows=(query:{text:string;values:string[]}|null)=>[...query!.text.matchAll(/FROM \((SELECT[\s\S]*?)\) v/g)].map(match=>match[1]!).filter(sql=>sql.startsWith("SELECT id,account_code")).map(sql=>fixture.query(sql,query!.values).rows.length);
  assert.deepEqual(ledgerRows({text:global(),values:[]}),[3]);assert.deepEqual(ledgerRows(scoped()),[2]);assert.deepEqual(ledgerRows(subject()),[1]);
  fixture.db.exec("UPDATE zzsh_order.fixture_ledger SET credit_cents='901' WHERE id='other'");
  assert.notEqual(digest({text:global(),values:[]}),beforeGlobal);assert.equal(digest(scoped()),beforeDoc);assert.equal(digest(subject()),beforeSubject);
  fixture.db.exec("INSERT INTO \"zzsh_auth_user\".\"user\"(id,name) VALUES('u3','外人')");
  assert.equal(digest(scoped()),beforeDoc);assert.equal(digest(subject()),beforeSubject);
  fixture.db.prepare("UPDATE \"zzsh_auth_user\".\"user\" SET name=? WHERE id='u2'").run("租客");
  const renterNamed=digest(scoped());assert.notEqual(renterNamed,beforeDoc);assert.equal(digest(subject()),beforeSubject);
  fixture.db.prepare("UPDATE \"zzsh_auth_user\".\"user\" SET name=? WHERE id='u1'").run("号主");
  assert.notEqual(digest(scoped()),renterNamed);assert.notEqual(digest(subject()),beforeSubject);
  const next=digest(scoped());
  fixture.db.exec("UPDATE zzsh_order.settlement_posting SET version_hash='hash-3' WHERE id='post-1'");
  assert.notEqual(digest(scoped()),next);
  const subjectBeforeOrder=digest(subject());
  fixture.db.exec("UPDATE zzsh_order.rental_order SET status='COMPLETED' WHERE id='order-1'");
  assert.notEqual(digest(subject()),subjectBeforeOrder);
  const docBeforePlatform=digest(scoped()),subjectBeforePlatform=digest(subject());
  fixture.db.exec("UPDATE zzsh_order.fixture_ledger SET credit_cents='11' WHERE id='platform'");
  const docAfterPlatform=digest(scoped());assert.notEqual(docAfterPlatform,docBeforePlatform);assert.equal(digest(subject()),subjectBeforePlatform);
  fixture.db.exec("INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('u1','4','4')");
  assert.equal(digest(scoped()),docAfterPlatform);assert.notEqual(digest(subject()),subjectBeforePlatform);
  const key={keyId:"read1",secret:"x".repeat(64)},filters=parseAdminFinanceFilters(new URLSearchParams("from=2026-10-03&to=2026-10-03")),actor={userId:"admin1",sessionId:"session1",authorizationKey:"access1"};
  const token=financeSnapshot({entries:[],subjects:[],revisions:[],withdrawalsReady:false,asOf:"2026-10-03T00:00:00.000000Z",version:String(beforeDoc)},filters,actor,key).token;
  assert.throws(()=>financeSnapshot({entries:[],subjects:[],revisions:[],withdrawalsReady:false,asOf:"2026-10-03T00:00:00.000000Z",version:String(beforeGlobal)},filters,actor,key,token),(error:any)=>error.status===409);
  assert.equal(FINANCE_GLOBAL_VERSION_DOMAIN,"admin-finance-proof.r2");
  assert.doesNotMatch(readFileSync("src/finance/admin-finance-export.ts","utf8"),/financeScopedVersionSql/);
  assert.match(readFileSync("src/finance/admin-finance-export.ts","utf8"),/readFinanceSourceVersion\(client\)/);
  assert.doesNotMatch(readFileSync("src/finance/admin-finance-routes.ts","utf8"),/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  const full={withdrawals:true,native_orders:true,legacy_orders:true,native_distribution:true,history_coverage:true,legacy_duty_finance:true,guarantee_history:true,payment_requests:true,refund_intents:true,joinpay_withdrawals:true};
  assert.ok(financeScopedVersionSql(full,{mode:"document",documentRef:"ORDER:order-1"}));
  assert.ok(financeScopedVersionSql(full,{mode:"subject",subjectId:"u1"}));
  assert.match(financeVersionSql(full),/payment_request/);assert.match(financeVersionSql(full),/channel_refund_intent/);assert.match(financeVersionSql(full),/joinpay_withdrawal_intent/);
  assert.doesNotMatch(financeVersionSql(full),/receiver_account_no_enc|admission_canonical|key_version_ref|count\(|max\(|pg_current_snapshot/i);
 }finally{fixture.close();}
});
test("exact local source numbers stay separate per merchant and are not ledger income",()=>{
 const fixture=new FinanceSqlFixture();
 try{
  fixture.db.exec(`CREATE TABLE zzsh_order.payment_request(id TEXT,order_id TEXT,channel TEXT,merchant_identity_id TEXT,platform_order_no TEXT,channel_order_no TEXT,state TEXT,amount_cents TEXT,currency TEXT,evidence_level TEXT,created_at TEXT,updated_at TEXT)`);
  fixture.db.exec(`INSERT INTO zzsh_order.payment_request VALUES('p1','o1','JOINPAY','merchant_a','P-1','M-100','READY','100','CNY','LOCAL','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z'),('p2','o2','JOINPAY','merchant_b','P-2','M-100','READY','200','CNY','LOCAL','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z'),('p3','o3','JOINPAY','merchant_a','P-3','M-1000','READY','300','CNY','LOCAL','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z')`);
  const page=(q:string)=>financeLookupPageSql("SELECT * FROM fixture_ledger","SELECT * FROM fixture_history",{payment_requests:true},{filters:parseAdminFinanceFilters(new URLSearchParams(`period=0&q=${q}`),new Date(),false),lookup:{exact:false},page:1,pageSize:20});
  const refs=(q:string)=>fixture.query(page(q).text,page(q).values).rows.map(row=>row.ref).filter(Boolean).sort();
  assert.deepEqual(refs("M-100"),["PAYMENT_REQUEST:p1","PAYMENT_REQUEST:p2"]);
  assert.deepEqual(refs("M-1000"),["PAYMENT_REQUEST:p3"]);
  assert.deepEqual(refs("M-10"),[]);
  const posted=projectAdminFinanceLedger({id:"j1",account_code:"WALLET_AVAILABLE",subject_id:"u1",delta:"-100",source_entity:"joinpay_withdrawal_intent",source_id:"intent1",event_kind:"PAYOUT"});
  assert.equal(posted.documentRef,"JOINPAY_WITHDRAWAL:intent1");assert.equal(posted.kind,"WITHDRAWAL");assert.equal(posted.affectsCurrentLedger,true);
  const open=projectUnpostedFinanceSource({id:"p1",order_id:"o1",channel:"JOINPAY",merchant_identity_id:"merchant_a",channel_order_no:"M-100",platform_order_no:"P-1",state:"READY",amount_cents:"100",at:"2026-10-03T00:00:00.000000Z"},"PAYMENT_REQUEST");
  const other=projectUnpostedFinanceSource({id:"p2",order_id:"o2",channel:"JOINPAY",merchant_identity_id:"merchant_b",channel_order_no:"M-100",platform_order_no:"P-2",state:"READY",amount_cents:"200",at:"2026-10-03T00:00:00.000000Z"},"PAYMENT_REQUEST");
  assert.notEqual(open.documentRef,other.documentRef);assert.equal(open.deltaCents,null);assert.equal(open.affectsCurrentLedger,false);assert.equal(open.evidence.merchantIdentityId,"merchant_a");assert.equal(other.evidence.merchantIdentityId,"merchant_b");
  assert.equal(financePeriodProjection([open,other]).find(row=>row.bucket==="CLEARING")!.knownInflows,"0");
 }finally{fixture.close();}
});


test('unposted business amount and platform reference never become ledger income or channel serial',()=>{
 const payment=projectUnpostedFinanceSource({id:'p',order_id:'o',renter_user_id:'u1',subject_name:'原租客',channel_order_no:'M-1',platform_order_no:'P-1',amount_cents:'100',state:'READY'},'PAYMENT_REQUEST');
 assert.equal(payment.subjectId,'u1');assert.equal(payment.subjectName,'原租客');assert.equal(payment.evidence.platformOrderNo,'P-1');assert.equal(payment.evidence.channelSerial,null);
 const refund=projectUnpostedFinanceSource({id:'r',order_id:'o',renter_user_id:'u1',refund_order_no:'R-1',amount_cents:'50',state:'READY'},'REFUND_INTENT');
 assert.equal(financeDocuments([payment])[0]!.requestedAmountCents,'100');assert.equal(financeDocuments([refund])[0]!.requestedAmountCents,'50');
 for(const entry of [payment,refund]){assert.equal(entry.deltaCents,null);assert.equal(entry.affectsCurrentLedger,false);}
 assert.equal(financePeriodProjection([payment,refund]).find(row=>row.bucket==='CLEARING')!.knownInflows,'0');
});

test('legacy order keeps global history admission proof instead of an incomplete r3 dependency set',()=>{
 const ready={native_orders:true,legacy_orders:true,history_coverage:true};
 assert.equal(financeScopedVersionSql(ready,{mode:'document',documentRef:'LEGACY_ORDER:old-1'}),null);
 assert.match(financeVersionSql(ready),/wallet_coverage/);assert.match(financeVersionSql(ready),/finance_opening_basis/);
 assert.ok(financeScopedVersionSql(ready,{mode:'document',documentRef:'ORDER:native-1'}),'native scope stays narrow');
});

test('exact payment refund and payout keys honor Beijing half-open dates without prefix matches',()=>{
 const f=new FinanceSqlFixture();
 try{
  f.db.exec("CREATE TABLE zzsh_order.payment_request(id TEXT,order_id TEXT,channel_order_no TEXT,platform_order_no TEXT,created_at TEXT); CREATE TABLE zzsh_order.channel_refund_intent(id TEXT,renter_user_id TEXT,refund_order_no TEXT,provider_refund_trx_no TEXT,original_payment_order_no TEXT,created_at TEXT); CREATE TABLE zzsh_order.joinpay_withdrawal_intent(id TEXT,user_id TEXT,merchant_order_no TEXT,platform_serial_no TEXT,state TEXT,accepted_at TEXT)");
  const times:Array<[string,string]>=[['old','2026-10-24T00:00:00Z'],['left','2026-10-25T16:00:00Z'],['mid','2026-10-26T00:00:00Z'],['right','2026-10-26T16:00:00Z']];
  for(const[id,at]of times){f.db.prepare("INSERT INTO zzsh_order.payment_request VALUES(?,?,?,?,?)").run(id,'o-'+id,'M-WINDOW','P-'+id,at);f.db.prepare("INSERT INTO zzsh_order.channel_refund_intent VALUES(?,?,?,?,?,?)").run(id,'u1','M-WINDOW','T-'+id,'P-'+id,at);f.db.prepare("INSERT INTO zzsh_order.joinpay_withdrawal_intent VALUES(?,?,?,?,?,?)").run(id,'u1','M-WINDOW','W-'+id,'RESERVED',at);}
  const refs=(period:boolean,q='M-WINDOW')=>{const filters=parseAdminFinanceFilters(new URLSearchParams('period='+(period?'1':'0')+'&from=2026-10-26&to=2026-10-26&q='+q),new Date('2026-10-26T00:00:00Z'),false),query=financeLookupPageSql('SELECT * FROM fixture_ledger','SELECT * FROM fixture_history',{payment_requests:true,refund_intents:true,joinpay_withdrawals:true},{filters,lookup:{exact:false},page:1,pageSize:20});
   // SQLite uses TEXT for PG timestamp columns; adapt only these named columns to its same timestamp comparison type.
   const text=query.text.replace(/\b([piw]\.(?:created_at|accepted_at))(?=\s*[<>])/g,'julianday($1)');return f.query(text,query.values).rows.map(row=>row.ref).filter(Boolean).sort();};
  assert.deepEqual(refs(true),['JOINPAY_WITHDRAWAL:left','JOINPAY_WITHDRAWAL:mid','PAYMENT_REQUEST:left','PAYMENT_REQUEST:mid','REFUND_INTENT:left','REFUND_INTENT:mid']);
  assert.equal(refs(false).length,12);assert.deepEqual(refs(true,'M-WIN'),[]);
 }finally{f.close();}
});
