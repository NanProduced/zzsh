import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {scopedFinanceSql,financeVersionSql} from "../src/finance/admin-finance-query";
import {parseAdminFinanceFilters} from "../src/finance/admin-finance-read";

test("query selection is before the matched ceiling and version digest has no client population limit",()=>{
 const filters=parseAdminFinanceFilters(new URLSearchParams("scope=u1&q=%25_%5C&from=2026-10-03&to=2026-10-03"));
 const query=scopedFinanceSql("SELECT * FROM input ORDER BY l.id COLLATE \"C\" LIMIT $1","ledger",{filters},20001,false);
 assert.ok(query.text.indexOf("WHERE")<query.text.lastIndexOf("LIMIT"));assert.ok(query.values.includes("u1"));assert.equal(query.values.at(-1),20001);assert.ok(query.values.some(value=>typeof value==="string"&&value.includes("\\%\\_\\\\")));
 const version=financeVersionSql({withdrawals:true,native_orders:true,legacy_orders:true});assert.ok(!/LIMIT/.test(version));assert.match(version,/string_agg/);assert.match(version,/controlled_payout_operation/);assert.match(version,/wallet_revision/);
});
test("actual PostgreSQL CTE: 6001 unrelated users and 25001 unrelated entries do not block exact filtered rows",{skip:process.env.ADM_FINANCE_QUERY_PG!=="admin_order_read"},async()=>{
 const c=JSON.parse(readFileSync("E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/admin_order_read/credentials.json","utf8"));
 assert.equal(c.database,"zzsh_test_order_admin_order_read");assert.equal(c.host,"127.0.0.1");assert.equal(c.port,55432);
 const pool=new Pool({host:c.host,port:c.port,database:c.database,user:c.runtime.role,password:c.runtime.password,application_name:"adm-finance-query-readonly",max:1});const client=await pool.connect();
 try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,"on");
 const base=`SELECT 'line_'||n AS id,'WALLET_AVAILABLE'::text AS account_code,'user_'||n AS subject_id,CASE WHEN n=6001 THEN '中文%_\\' ELSE '无关用户' END::text AS subject_name,'100'::text AS delta,'2026-10-03T00:00:00.000000Z'::text AS at,NULL::text AS event_kind,NULL::text AS source_entity,'source_'||n AS source_id,NULL::text AS basis_id,NULL::text AS posting_id,NULL::text AS order_id,'NO_'||n AS display_no FROM generate_series(1,25001) n`;
 const scoped=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("scope=user_6001&from=2026-10-03&to=2026-10-03"))},20001,false);
 const rows=(await client.query(scoped.text,scoped.values)).rows;assert.equal(rows.length,1);assert.equal(rows[0].subject_id,"user_6001");
 const literal=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("q=%25_%5C&from=2026-10-03&to=2026-10-03"))},20001,false);assert.equal((await client.query(literal.text,literal.values)).rows.length,1);
 const all=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("from=2026-10-03&to=2026-10-03"))},20001,false);assert.equal((await client.query(all.text,all.values)).rows.length,20001);
 // This is a synthetic SELECT-only SQL branch check, not real finance-data acceptance.
 }finally{await client.query("ROLLBACK").catch(()=>undefined);client.release();await pool.end();}
});
