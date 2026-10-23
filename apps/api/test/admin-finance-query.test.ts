import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {scopedFinanceSql,financeVersionSql,financeLookupPageSql} from "../src/finance/admin-finance-query";
import {parseAdminFinanceFilters,adminFinanceObservationSql,ADMIN_FINANCE_LEDGER_SQL,projectAdminFinanceObservation,readAdminFinanceSubject} from "../src/finance/admin-finance-read";
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
