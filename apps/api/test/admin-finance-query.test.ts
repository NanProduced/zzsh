import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {scopedFinanceSql,financeVersionSql,financeScopedVersionSql,financeLookupPageSql,FINANCE_GLOBAL_VERSION_DOMAIN} from "../src/finance/admin-finance-query";
import {parseAdminFinanceFilters,adminFinanceObservationSql,ADMIN_FINANCE_LEDGER_SQL,ADMIN_FINANCE_LOOKUP_OBSERVATION_SQL,projectAdminFinanceObservation,projectAdminFinanceLedger,projectUnpostedFinanceSource,financeDocuments,readAdminFinanceSubject,financeSnapshot,financePeriodProjection} from "../src/finance/admin-finance-read";
import {FinanceSqlFixture} from './admin-finance-fixture';

test("query selection is before the matched ceiling and restored content digest covers all source rows",()=>{
 const filters=parseAdminFinanceFilters(new URLSearchParams("scope=u1&q=%25_%5C&from=2026-10-03&to=2026-10-03"));
 const query=scopedFinanceSql("SELECT * FROM input ORDER BY l.id COLLATE \"C\" LIMIT $1","ledger",{filters},20001,false);
 assert.ok(query.text.indexOf("WHERE")<query.text.lastIndexOf("LIMIT"));assert.ok(query.values.includes("u1"));assert.equal(query.values.at(-1),20001);assert.ok(query.values.some(value=>typeof value==="string"&&value.includes("\\%\\_\\\\")));
 const version=financeVersionSql({withdrawals:true,native_orders:true,legacy_orders:true});assert.ok(!/pg_current_snapshot|current_database/i.test(version));assert.match(version,/string_agg/);assert.match(version,/controlled_payout_operation/);assert.match(version,/wallet_revision/);assert.match(version,/legacy_order_read_snapshot/);
});

test('global finance content binds revised duties and appended frozen facts, not unrelated cluster activity',()=>{
 const fixture=new FinanceSqlFixture({ledger:[{id:'line1',subject_id:'u1',delta:'100',at:'2026-10-03T01:00:00Z',details:{legacyDutyId:'duty1'}}],legacy:[{id:'old1',source_snapshot:{return_order_money:'1.00',unrelatedNote:'before'}}],legacyDutyFacts:[{duty_id:'duty1',order_id:'old1',facts_canonical:'original',facts_digest:'a'.repeat(64)}],legacyDuties:[{id:'duty1',order_id:'old1',counterparty_user_id:'u1',amount_cents:'100',maturity_at:'2026-10-03T01:00:00Z'}]});
 try{
  fixture.db.exec("INSERT INTO zzsh_order.settlement_posting(id,settlement_version_id,refund_due_at) VALUES('posting1','version1','2026-10-03T01:00:00Z'); UPDATE zzsh_order.legacy_order_duty SET revision='1' WHERE id='duty1'; INSERT INTO zzsh_order.legacy_order_duty(id,revision) VALUES('unchanged-max','99')");
  const sql=financeVersionSql({legacy_orders:true,legacy_duty_finance:true}),version=()=>fixture.query(sql,[]).rows[0]!.finance_version;
  let previous=version();fixture.clusterSnapshot='200:300:201';assert.equal(version(),previous);
  for(const statement of [
   "UPDATE zzsh_order.legacy_order_duty SET maturity_at='2026-10-05T01:00:00Z',revision='2' WHERE id='duty1'",
   "UPDATE zzsh_order.legacy_order_duty SET amount_cents='101',revision='3' WHERE id='duty1'",
   "INSERT INTO zzsh_order.settlement_posting(id,settlement_version_id,refund_due_at) VALUES('posting2','version2','2026-10-04T01:00:00Z')",
   "INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,facts_digest) VALUES('duty2','second-frozen-digest')",
   "INSERT INTO zzsh_order.fixture_ledger(id,credit_cents,details) VALUES('line2','101','{}')",
   "INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_digest,binding_digest) VALUES('old2','second-source','second-binding')"
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
  const light=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({native_distribution:true},true),{},{filters,lookup:{exact:false},page:1,pageSize:20},true);assert.deepEqual(fixture.query(light.text,light.values).rows,keys);assert.match(light.text,/t\.action='ACCRUE'/);assert.doesNotMatch(light.text,/'earningRole',e\.beneficiary_role/);
  const empty=scopedFinanceSql(source,'history',{filters:{...filters,scope:'u2'}},20,false);assert.equal(fixture.query(empty.text,empty.values).rows.length,0);
  const version=financeVersionSql({native_distribution:true});assert(version.includes('rental_referral_earning'));assert.match(fixture.query(version,[]).rows[0]!.finance_version as string,/^[a-f0-9]{32}$/);
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
  assert.ok(global().includes(FINANCE_GLOBAL_VERSION_DOMAIN));assert.doesNotMatch(global(),/\$1|pg_current_snapshot/i);
  const digest=(query:{text:string;values:string[]}|null)=>fixture.query(query!.text,query!.values).rows[0]!.finance_version;
  const beforeGlobal=digest({text:global(),values:[]}),beforeDoc=digest(scoped()),beforeSubject=digest(subject());
  const oldGlobal=global().replace(FINANCE_GLOBAL_VERSION_DOMAIN,'admin-finance-proof.r9.history-amount-semantics');assert.notEqual(digest({text:oldGlobal,values:[]}),beforeGlobal);
  const subjectQuery=subject()!;assert.match(subjectQuery.text,/admin-finance-proof\.r6\.subject/);assert.notEqual(digest({...subjectQuery,text:subjectQuery.text.replace('admin-finance-proof.r6.subject','admin-finance-proof.r5.subject')}),beforeSubject);
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
  assert.equal(FINANCE_GLOBAL_VERSION_DOMAIN,"admin-finance-proof.r11.withdrawal-source-links");
  assert.doesNotMatch(readFileSync("src/finance/admin-finance-export.ts","utf8"),/financeScopedVersionSql/);
  assert.match(readFileSync("src/finance/admin-finance-export.ts","utf8"),/readFinanceSourceVersion\(client\)/);
  assert.doesNotMatch(readFileSync("src/finance/admin-finance-routes.ts","utf8"),/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  fixture.db.exec(`CREATE TABLE zzsh_order.legacy_withdrawal_subject_revision(source_system TEXT,user_id TEXT,revision TEXT);
    CREATE TABLE zzsh_order.legacy_withdrawal_link_evidence(parent_id TEXT,revision TEXT,debit_id TEXT,return_id TEXT,source_system TEXT,user_id TEXT,
      parent_digest TEXT,debit_digest TEXT,return_digest TEXT,parent_fingerprint TEXT,debit_fingerprint TEXT,return_fingerprint TEXT);
    INSERT INTO zzsh_order.legacy_withdrawal_subject_revision VALUES('old','other','1');`);
  const scopedWithLinks=()=>financeScopedVersionSql({...ready,legacy_withdrawal_links:true},{mode:"document",documentRef:"ORDER:order-1"});
  assert.ok(scopedWithLinks());const beforeLinks=digest(scopedWithLinks());
  fixture.db.exec("UPDATE zzsh_order.legacy_withdrawal_subject_revision SET revision='2'");
  assert.equal(digest(scopedWithLinks()),beforeLinks,'an unrelated legacy withdrawal must not invalidate a native order');
  fixture.db.exec("UPDATE zzsh_order.settlement_posting SET version_hash='hash-4' WHERE id='post-1'");
  assert.notEqual(digest(scopedWithLinks()),beforeLinks,'the original posting must still invalidate its own order');
  const full={withdrawals:true,native_orders:true,legacy_orders:true,native_distribution:true,history_coverage:true,legacy_duty_finance:true,guarantee_history:true,payment_requests:true,refund_intents:true,joinpay_withdrawals:true};
  assert.ok(financeScopedVersionSql(full,{mode:"document",documentRef:"ORDER:order-1"}));
  assert.ok(financeScopedVersionSql(full,{mode:"subject",subjectId:"u1"}));
  assert.match(financeVersionSql(full),/payment_request/);assert.match(financeVersionSql(full),/channel_refund_intent/);assert.match(financeVersionSql(full),/joinpay_withdrawal_intent/);
  assert.doesNotMatch(financeVersionSql(full),/receiver_account_no_enc|admission_canonical|key_version_ref|pg_current_snapshot/i);
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

test('legacy order document bounds original history, later opening admission and duty evidence',()=>{
 const ready={native_orders:true,legacy_orders:true,history_coverage:true};
 const scoped=financeScopedVersionSql({...ready,legacy_duty_finance:true},{mode:'document',documentRef:'LEGACY_ORDER:old-1'})!;
 assert.deepEqual(scoped.values,['old-1']);
 assert.match(scoped.text,/admin-finance-proof\.r7\.typed-document/);
 for(const required of ['history_bound','finance_observation_admission','legacy_order_duty','legacy_duty_finance_fact','la_pay_order','la_refund_record','la_distribution_order'])assert.ok(scoped.text.includes(required));
 assert.match(financeVersionSql(ready),/wallet_coverage/);assert.match(financeVersionSql(ready),/finance_opening_basis/);
 assert.ok(financeScopedVersionSql(ready,{mode:'document',documentRef:'ORDER:native-1'}),'native scope stays narrow');
});

test('global proof uses frozen source digests and per-row CAS while scoped proofs keep their encoding',()=>{
 const fixture=new FinanceSqlFixture({ledger:[{id:'l',subject_id:'u1',delta:'100',details:{original:'first'}}],history:[{id:'h',subject_id:'u1',source_entity:'la_log_earnings',source_id:'1',source_digest:'source',extra_evidence:{canonical:'x'.repeat(100000),snapshot:{amount:'1.00',legacyChangeType:1002,legacyLogNumber:'FLOW-1'}}}],earnings:[{id:'e',beneficiary_user_id:'u1',amount_cents:'95',state:'PENDING',funds_disposition:'PENDING',canonical_seed:'seed',seed_digest:'seed-digest',version:'1'}],legacyDutyFacts:[{duty_id:'d',facts_canonical:'duty-facts',facts_digest:'duty-digest'}]});
 try{
  fixture.db.exec("INSERT INTO zzsh_order.finance_opening_basis(id,user_id,native_origin_canonical,source_digest,available_cents) VALUES('b','u1','origin','source','100'); INSERT INTO zzsh_order.wallet_revision VALUES('u1','1','1'); INSERT INTO zzsh_order.wallet_coverage VALUES('u1','LEGACY_IMPORT','b','event','1'); INSERT INTO zzsh_order.payment_distribution_basis VALUES('basis','order','payment','canonical','digest')");
  const sql=financeVersionSql({native_distribution:true,legacy_duty_finance:true});
  for(const field of ['source_canonical','snapshot','native_origin_canonical','canonical_seed','canonical_basis','facts_canonical','details'])assert(!sql.includes(field),field+' is immutable and covered by its source digest or frozen row');
  for(const field of ['source_digest','seed_digest','basis_digest','facts_digest','version::text','revision::text'])assert(sql.includes(field),field+' remains part of the complete row set');
  const version=()=>fixture.query(sql,[]).rows[0]!.finance_version;let before=version();
  for(const [statement,args]of [
   ["UPDATE zzsh_order.wallet_revision SET read_revision='2' WHERE user_id='u1'",[]],
   ["UPDATE zzsh_order.rental_referral_earning SET state='SETTLED',funds_disposition='SETTLED',version='2' WHERE id='e'",[]],
   ["UPDATE zzsh_order.rental_referral_earning SET state='RECOVERY_REQUIRED',version='3',recovery_required_cents='95' WHERE id='e'",[]],
   ["UPDATE zzsh_auth_user.\"user\" SET name='changed-in-place' WHERE id='u1'",[]],
   ["INSERT INTO zzsh_order.payment_distribution_basis VALUES('basis2','order2','payment2','frozen-canonical','second-digest')",[]],
   ["INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,facts_digest) VALUES('d2','second-facts-digest')",[]],
   ["INSERT INTO zzsh_order.fixture_history(id,subject_id,source_digest) VALUES('h2','u1','second-source-digest')",[]],
  ] as Array<[string,string[]]>){fixture.db.prepare(statement).run(...args);const after=version();assert.notEqual(after,before,statement);before=after;}
  fixture.clusterSnapshot='999:1000:999';assert.equal(version(),before);
  const scoped=financeScopedVersionSql({},{mode:'subject',subjectId:'u1'})!;assert.match(scoped.text,/md5\(to_jsonb\(v\)::text\)/);assert.doesNotMatch(scoped.text,/md5\(v::text\)|md5\(details::text\)/);
 }finally{fixture.close();}
});

test('lookup raw snapshot keys are equivalent to full evidence across filters, priorities, null times and every page',()=>{
 const fixture=new FinanceSqlFixture({
  ledger:[{id:'l1',subject_id:'u1',subject_name:'用户一',account_code:'WALLET_AVAILABLE',delta:'999999999999999999999999',at:'2026-10-03T01:00:00.000000Z',order_id:'o1',display_no:'ORDER-ONE',source_entity:'settlement_posting',posting_id:'post1'},
   {id:'l2',subject_id:'u1',subject_name:'用户一',account_code:'WALLET_AVAILABLE',delta:'-100',at:'2026-10-03T02:00:00.000000Z',order_id:'o1',display_no:'ORDER-ONE',source_entity:'settlement_posting',posting_id:'post2'}],
  history:[{id:'h1',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_log_earnings',source_id:'41',amount:'1.00',action:'2',at:'2026-10-03T01:00:00.000000Z',extra_evidence:{canonical:'never-search-this-canonical'.repeat(1000),snapshot:{legacyChangeType:1002,legacyLogNumber:'FLOW-1'}}},
   {id:'h2',subject_id:'u2',subject_name:'用户二',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_distribution_order',source_id:'42',amount:'2.00',at:null},
   {id:'h3',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_log_earnings',source_id:'43',amount:'3.00',action:'1',at:null,extra_evidence:{canonical:'kept-in-full-payload',snapshot:{legacyChangeType:1001,legacyLogNumber:'literal%_\\'}}}],
  native:[{id:'o1',display_no:'ORDER-ONE',owner_user_id:'u1',renter_user_id:'u2',created_at:'2026-10-03T23:00:00.000000Z',status:'PAID'},
   {id:'o2',display_no:'UNPAID-ORDER',owner_user_id:'u1',renter_user_id:'u2',created_at:'2026-10-03T03:00:00.000000Z',status:'PENDING_PAYMENT'}],
  legacy:[{id:'old1',legacy_id:'1',original_order_no:'OLD-ORDER',owner_user_id:'u2',renter_user_id:'u1',source_created_at:null,source_snapshot:{private:'not a lookup clue'}}]
 });
 try{
  let comparisons=0;for(const q of ['', 'FLOW-1','literal%_\\','never-search-this-canonical','UNPAID-ORDER','ORDER_LINK:o1','用户一'])for(const scope of ['ALL','u1','u2'])for(const kind of ['ALL','WITHDRAWAL','DISTRIBUTION','SETTLEMENT'])for(const page of [1,2,8]){
   const filters=parseAdminFinanceFilters(new URLSearchParams({q,scope,kind,period:'0'}),new Date(),false),load={filters,lookup:{exact:false},page,pageSize:2},ready={native_orders:true,legacy_orders:true};
   const old=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({}),ready,load),next=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({},true),ready,load,true);
   assert.deepEqual(fixture.query(next.text,next.values).rows,fixture.query(old.text,old.values).rows,JSON.stringify({q,scope,kind,page}));comparisons++;
  }
  const filters=parseAdminFinanceFilters(new URLSearchParams('period=0'),new Date(),false),query=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({},true),{native_orders:true,legacy_orders:true},{filters,lookup:{exact:false},page:1,pageSize:20},true),rows=fixture.query(query.text,query.values).rows;
  assert.equal(comparisons,252);assert(rows.some(r=>r.ref==='ORDER:o2'),'an unposted unpaid order remains a real document');assert.equal(rows.filter(r=>r.ref==='ORDER:o1').length,1);
  assert(rows.some(r=>r.ref==='HISTORY_EARNINGS:h1'),'unproved withdrawal children remain searchable');
  assert.equal(Number(rows[0]!.entry_count),5);
  for(const exact of [false,true])for(const period of ['0','1'])for(const bucket of ['ALL','AVAILABLE','PENDING_EARNINGS'])for(const state of ['ALL','HISTORICAL_OBSERVED','ORDER_RECORDED']){
   const f=parseAdminFinanceFilters(new URLSearchParams({q:'FLOW-1',period,bucket,state,from:'2026-10-03',to:'2026-10-03'}),new Date(),false),scope={filters:f,lookup:{exact},page:1,pageSize:2};
   const old=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({}),{native_orders:true,legacy_orders:true},scope),next=financeLookupPageSql(ADMIN_FINANCE_LEDGER_SQL,adminFinanceObservationSql({},true),{native_orders:true,legacy_orders:true},scope,true);
   assert.deepEqual(fixture.query(next.text,next.values).rows,fixture.query(old.text,old.values).rows,JSON.stringify({exact,period,bucket,state}));
  }
  assert.doesNotMatch(query.text,/canonical',o\.source_canonical|legacyUserId/);assert.match(ADMIN_FINANCE_LOOKUP_OBSERVATION_SQL,/o\.snapshot AS extra_evidence/);assert.match(adminFinanceObservationSql({}),/'canonical',o\.source_canonical/);
 }finally{fixture.close();}
});

test('withdrawal lookup counts records without adding amounts and exact child numbers remain searchable',()=>{
 const history=[
  {id:'apply',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_withdraw_apply',source_id:'55',reference_no:'APPLY-55',amount:'734.00',at:'2026-10-03T01:00:00.000000Z',extra_evidence:{snapshot:{referenceSn:'APPLY-55'}}},
  {id:'debit',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_log_earnings',source_id:'66',reference_no:'APPLY-55',amount:'734.00',action:'2',at:'2026-10-03T01:00:01.000000Z',extra_evidence:{snapshot:{legacyChangeType:1002,legacyLogNumber:'DEBIT-66',referenceId:'55',referenceSn:'APPLY-55'}}},
  {id:'orphan',subject_id:'u1',subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy',source_entity:'la_log_earnings',source_id:'67',reference_no:'UNKNOWN-APPLY',amount:'10.00',action:'1',at:'2026-10-03T01:01:00.000000Z',extra_evidence:{snapshot:{legacyChangeType:1004,legacyLogNumber:'ORPHAN-67',referenceId:'99',referenceSn:'UNKNOWN-APPLY'}}},
 ];
 const fixture=new FinanceSqlFixture({history});try{
  const page=(q:string,exact:boolean)=>{const filters=parseAdminFinanceFilters(new URLSearchParams({q,kind:'WITHDRAWAL',period:'0'}),new Date(),false);const query=financeLookupPageSql('SELECT * FROM fixture_ledger','SELECT * FROM fixture_history',{}, {filters,lookup:{exact},page:1,pageSize:20});assert.doesNotMatch(query.text,/\bsum\s*\(/i);return fixture.query(query.text,query.values).rows;};
  const all=page('',false);assert.deepEqual(all.map(row=>row.ref).sort(),['HISTORY_EARNINGS:debit','HISTORY_EARNINGS:orphan','HISTORY_WITHDRAWAL:apply']);assert.equal(Number(all[0]!.document_count),3);assert.equal(Number(all[0]!.entry_count),3);
  for(const exact of [false,true]){const debit=page('DEBIT-66',exact);assert.deepEqual(debit.map(row=>row.ref),['HISTORY_EARNINGS:debit']);assert.equal(Number(debit[0]!.document_count),1);assert.deepEqual(page('ORPHAN-67',exact).map(row=>row.ref),['HISTORY_EARNINGS:orphan']);}
 }finally{fixture.close();}
});

test('global refund block proof owns exact existing intent IDs, including in-place audit changes',()=>{
 const fixture=new FinanceSqlFixture();try{
  fixture.db.exec("CREATE TABLE zzsh_iam.audit_event(id TEXT,action TEXT,object_id TEXT,occurred_at TEXT,details TEXT); CREATE TABLE zzsh_order.channel_refund_intent(id TEXT,revision TEXT,order_id TEXT,renter_user_id TEXT,posting_id TEXT,payment_confirmation_id TEXT,payment_source TEXT,state TEXT,budget_disposition TEXT,amount_cents TEXT); CREATE TABLE zzsh_order.joinpay_refund_attempt(id TEXT,intent_id TEXT,operation TEXT,lease_version TEXT,created_at TEXT)");
  for(const c of ['reason_code','merchant_scope_id','provider_transaction_id','merchant_order_no','joinpay_request_id','joinpay_evidence_id','joinpay_anchor_id'])fixture.db.exec('ALTER TABLE zzsh_order.payment_confirmation ADD COLUMN '+c+' TEXT');
  fixture.db.exec("INSERT INTO zzsh_iam.audit_event VALUES('a1','order.refund.abnormal.first_submit.blocked','r1','2026-11-02','first'),('a2','order.refund.abnormal.first_submit.blocked','r2','2026-11-02','unrelated')");
  const sql=financeVersionSql({refund_intents:true,refund_read_dependencies:true}),relation=sql.match(/FROM \((SELECT a\.id,a\.action,a\.object_id,a\.occurred_at,[\s\S]*? FROM zzsh_iam\.audit_event a WHERE[\s\S]*?)\) v/)?.[1];assert(relation);
  const rows=()=>fixture.db.prepare(relation.replace(/::text\b/g,'')+' ORDER BY a.id').all(),version=()=>fixture.query(sql,[]).rows[0]!.finance_version;
  assert.deepEqual(rows(),[],'no intent means no related blocked evidence');const withoutIntent=version();
  fixture.db.exec("INSERT INTO zzsh_order.channel_refund_intent(id,revision,payment_confirmation_id,state,amount_cents) VALUES('r1','1','p1','UNKNOWN','100')");assert.deepEqual(rows().map(r=>r.id),['a1']);const before=version();assert.notEqual(before,withoutIntent);
  fixture.db.exec("UPDATE zzsh_iam.audit_event SET details='changed-unrelated' WHERE id='a2'");assert.equal(version(),before);
  fixture.db.exec("UPDATE zzsh_iam.audit_event SET details='changed-related' WHERE id='a1'");assert.notEqual(version(),before);
  fixture.db.exec("INSERT INTO zzsh_order.channel_refund_intent(id,payment_confirmation_id) VALUES('r3','p1')");assert.deepEqual(rows().map(r=>r.id),['a1'],'shared payment never pulls in another intent audit');const beforeSecond=version();
  fixture.db.exec("INSERT INTO zzsh_order.channel_refund_intent(id,payment_confirmation_id,state) VALUES('r2',NULL,'SUBMITTING')");assert.deepEqual(rows().map(r=>r.id),['a1','a2'],'a newly relevant intent enters the full proof even without a confirmation');assert.notEqual(version(),beforeSecond);
  const beforeReview=version();fixture.db.exec("UPDATE zzsh_order.channel_refund_intent SET revision='2' WHERE id='r1'");assert.notEqual(version(),beforeReview,'a legal review transition advances the per-row revision even if listed state is unchanged');
 }finally{fixture.close();}
});

test('global narrow proof catches non-max CAS, first payment and complete capability identity',()=>{
 const fixture=new FinanceSqlFixture({native:[{id:'order',revision:'1',status:'PENDING_PAYMENT'}],withdrawals:[{id:'w1',operation_version:'1',state:'RESERVED'},{id:'w99',operation_version:'99',state:'RESERVED'}]});
 try{
  fixture.db.exec("CREATE TABLE zzsh_order.payment_request(id TEXT,revision TEXT,order_id TEXT,channel TEXT,merchant_identity_id TEXT,platform_order_no TEXT,channel_order_no TEXT,state TEXT,amount_cents TEXT,currency TEXT,evidence_level TEXT,updated_at TEXT); CREATE TABLE zzsh_order.channel_refund_intent(id TEXT,revision TEXT,order_id TEXT,renter_user_id TEXT,posting_id TEXT,payment_confirmation_id TEXT,payment_source TEXT,state TEXT,budget_disposition TEXT)");
  fixture.db.exec("INSERT INTO zzsh_order.payment_request(id,revision,state) VALUES('p1','1','READY'),('p99','99','READY'); INSERT INTO zzsh_order.channel_refund_intent(id,revision,state) VALUES('r1','1','ALLOCATED'),('r99','99','ALLOCATED')");
  const ready={native_orders:true,payment_requests:true,refund_intents:true,withdrawals:true},sql=financeVersionSql(ready),version=()=>fixture.query(sql,[]).rows[0]!.finance_version;
  let before=version();
  for(const statement of [
   "UPDATE zzsh_order.payment_request SET revision='2' WHERE id='p1'",
   "UPDATE zzsh_order.channel_refund_intent SET revision='2' WHERE id='r1'",
   "UPDATE zzsh_order.withdrawal_intent SET operation_version='2' WHERE id='w1'",
   "UPDATE zzsh_order.rental_order SET status='PAID',paid_confirmation_id='payment',paid_at='2026-11-02T01:00:00Z' WHERE id='order'",
   "INSERT INTO zzsh_auth_user.\"user\"(id,name) VALUES('outside-page','另一用户')"
  ]){fixture.db.exec(statement);const next=version();assert.notEqual(next,before,statement);before=next;}
  assert.equal(fixture.db.prepare('SELECT MAX(CAST(revision AS INTEGER)) AS revision FROM zzsh_order.payment_request').get()!.revision,99);
  assert.equal(fixture.db.prepare('SELECT MAX(CAST(revision AS INTEGER)) AS revision FROM zzsh_order.channel_refund_intent').get()!.revision,99);
  assert.equal(fixture.db.prepare('SELECT MAX(CAST(operation_version AS INTEGER)) AS revision FROM zzsh_order.withdrawal_intent').get()!.revision,99);
  const empty=new FinanceSqlFixture();try{assert.notEqual(empty.query(financeVersionSql({native_orders:true}),[]).rows[0]!.finance_version,empty.query(financeVersionSql({withdrawals:true}),[]).rows[0]!.finance_version);}finally{empty.close();}
 }finally{fixture.close();}
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


test('exact source clocks are UTC text before joining ledger and order lookup keys',()=>{
 const filters=parseAdminFinanceFilters(new URLSearchParams('period=0&q=M-CLOCK'),new Date(),false);
 const q=financeLookupPageSql('SELECT * FROM fixture_ledger','SELECT * FROM fixture_history',{payment_requests:true,refund_intents:true,joinpay_withdrawals:true},{filters,lookup:{exact:false},page:1,pageSize:20});
 // Ledger/history/native-order clocks use to_char(text); raw timestamptz UNION fails in PostgreSQL.
 for(const field of ['p.created_at','i.created_at','w.accepted_at'])assert.ok(q.text.includes("to_char("+field+" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"),field+' must share the existing UTC text clock');
 assert.ok(q.values.includes('M-CLOCK'));
});

test('exact source key pagination preserves all three families and a null occurrence clock',()=>{
 const fixture=new FinanceSqlFixture();
 try{
  fixture.db.exec("CREATE TABLE zzsh_order.payment_request(id TEXT,order_id TEXT,channel_order_no TEXT,platform_order_no TEXT,created_at TEXT)");
  fixture.db.exec("CREATE TABLE zzsh_order.channel_refund_intent(id TEXT,refund_order_no TEXT,provider_refund_trx_no TEXT,original_payment_order_no TEXT,created_at TEXT)");
  fixture.db.exec("CREATE TABLE zzsh_order.joinpay_withdrawal_intent(id TEXT,merchant_order_no TEXT,platform_serial_no TEXT,accepted_at TEXT)");
  fixture.db.exec("INSERT INTO zzsh_order.payment_request VALUES('pc','o','M-CLOCK','P','2026-10-26T10:00:00Z'); INSERT INTO zzsh_order.channel_refund_intent VALUES('rc','R',NULL,'M-CLOCK','2026-10-26T09:00:00Z'); INSERT INTO zzsh_order.joinpay_withdrawal_intent VALUES('wc','M-CLOCK',NULL,NULL)");
  const filters=parseAdminFinanceFilters(new URLSearchParams('period=0&q=M-CLOCK'),new Date(),false),page=(n:number)=>financeLookupPageSql('SELECT * FROM fixture_ledger','SELECT * FROM fixture_history',{payment_requests:true,refund_intents:true,joinpay_withdrawals:true},{filters,lookup:{exact:false},page:n,pageSize:2});
  const one=page(1),two=page(2),first=fixture.query(one.text,one.values).rows,next=fixture.query(two.text,two.values).rows;
  assert.deepEqual(first.map(r=>r.ref),['PAYMENT_REQUEST:pc','REFUND_INTENT:rc']);assert.deepEqual(next.map(r=>r.ref),['JOINPAY_WITHDRAWAL:wc']);assert.equal(Number(first[0]!.document_count),3);assert.equal(Number(next[0]!.entry_count),0);
 }finally{fixture.close();}
});

