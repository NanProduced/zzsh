import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {scopedFinanceSql,financeVersionSql,financeLookupPageSql} from "../src/finance/admin-finance-query";
import {parseAdminFinanceFilters,adminFinanceObservationSql,ADMIN_FINANCE_LEDGER_SQL,projectAdminFinanceObservation} from "../src/finance/admin-finance-read";
import {FinanceSqlFixture} from './admin-finance-fixture';
import {prepareOwnerGuaranteeHistory} from '../src/finance/owner-guarantee-history';

test("query selection is before the matched ceiling and restored content digest covers all source rows",()=>{
 const filters=parseAdminFinanceFilters(new URLSearchParams("scope=u1&q=%25_%5C&from=2026-10-03&to=2026-10-03"));
 const query=scopedFinanceSql("SELECT * FROM input ORDER BY l.id COLLATE \"C\" LIMIT $1","ledger",{filters},20001,false);
 assert.ok(query.text.indexOf("WHERE")<query.text.lastIndexOf("LIMIT"));assert.ok(query.values.includes("u1"));assert.equal(query.values.at(-1),20001);assert.ok(query.values.some(value=>typeof value==="string"&&value.includes("\\%\\_\\\\")));
 const version=financeVersionSql({withdrawals:true,native_orders:true,legacy_orders:true});assert.ok(!/LIMIT|pg_current_snapshot|current_database|count\(|max\(/i.test(version));assert.match(version,/string_agg/);assert.match(version,/controlled_payout_operation/);assert.match(version,/wallet_revision/);assert.match(version,/legacy_order_read_snapshot/);
});

test('actual native zero source branch remains visible as its distribution document without fabricating ledger rows',()=>{
 const fixture=new FinanceSqlFixture({earnings:[{id:'zero-earning',economic_root_id:'zero-earning',beneficiary_user_id:'u1',beneficiary_role:'RENTER_REFERRAL',amount_cents:'0',state:'SETTLED',funds_disposition:'SETTLED',version:'2',seed_digest:'a'.repeat(64),order_id:'native-order',created_at:'2026-10-03T01:00:00.000000Z'}]});
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
