import assert from "node:assert/strict";
import test from "node:test";
import { CREDIT_TABLES, preflightCreditGuarantee, readCreditGuaranteeEnabled } from "../src/credit/credit-guarantee-runtime";
import { configureCreditGuaranteePrivileges } from "../src/database/business-migrations";
import { mountAuthHandlers } from "../src/auth/auth-runtime";

test("credit capability defaults off, rejects ambiguous flags and never probes old schema while off", async () => {
  assert.equal(readCreditGuaranteeEnabled({}),false);assert.equal(readCreditGuaranteeEnabled({CREDIT_GUARANTEE_ENABLED:"true"}),true);
  for(const value of ["1","yes","TRUE",""])assert.throws(()=>readCreditGuaranteeEnabled({CREDIT_GUARANTEE_ENABLED:value}));
  await preflightCreditGuarantee({query:async()=>{throw Error("must not query");}} as never,false);
});

test("enabled deployment fails before mounting auth when schema/ACL/contract is incomplete",async()=>{
  for(const failure of ["absent","partial","unreadable","version","schema-owner","query-error"]){
    const pool={query:async(sql:string)=>{
      if(failure==="query-error")throw Error("db unavailable");
      if(sql.includes("unnest"))return{rows:CREDIT_TABLES.map((name,i)=>({name,present:failure!=="absent"&&!(failure==="partial"&&i===1),readable:failure!=="unreadable"}))};
      return{rows:[{version:failure==="version"?2:1,schemaCreate:failure==="schema-owner"}]};
    }} as never;
    await assert.rejects(()=>preflightCreditGuarantee(pool,true),/schema or runtime privileges/);
    await assert.rejects(()=>mountAuthHandlers({} as never,{pool,creditGuaranteeEnabled:true} as never),/schema or runtime privileges/);
  }
  await preflightCreditGuarantee({query:async(sql:string)=>({rows:sql.includes("unnest")?CREDIT_TABLES.map(name=>({name,present:true,readable:true})):[{version:1,schemaCreate:false}]})} as never,true);
});

test("credit ACL converges all columns without granting event/reconciliation updates or deletes",async()=>{
  const seen:string[]=[];const pool={query:async(sql:string,args:any[]=[])=>{seen.push(sql);return{rows:sql.startsWith("SELECT name")?args[0].map((name:string)=>({name,present:true})):sql.startsWith("SELECT attname")?[{attname:"id"},{attname:"unlisted_column"}]:[]};}} as never;
  await configureCreditGuaranteePrivileges(pool,"runtime_role");const first=[...seen];seen.length=0;await configureCreditGuaranteePrivileges(pool,"runtime_role");assert.deepEqual(seen,first);
  assert.equal(seen.filter(s=>s.startsWith("REVOKE ALL ON TABLE")).length,7);assert(seen.filter(s=>s.startsWith("REVOKE ALL ON TABLE")).every(s=>s.includes('"unlisted_column"')));
  const grant=seen.at(-1)!;assert(!grant.includes("unlisted_column"));assert(!/GRANT\s+(?:DELETE|TRUNCATE)/.test(grant));assert(grant.includes("UPDATE(status,updated_at) ON zzsh_order.owner_guarantee_requirement"));assert(!/UPDATE[^;]*ON zzsh_credit.credit_event/.test(grant));assert(!/UPDATE[^;]*ON zzsh_order.owner_guarantee_reconciliation/.test(grant));assert(grant.includes("runtime_contract_version()"));
  seen.length=0;await assert.rejects(()=>configureCreditGuaranteePrivileges(pool,"unsafe;role"));assert.equal(seen.length,0);
  let writes=0;await configureCreditGuaranteePrivileges({query:async()=>{writes++;return{rows:CREDIT_TABLES.map(name=>({name,present:false}))};}} as never,"runtime_role");assert.equal(writes,1);
  await assert.rejects(()=>configureCreditGuaranteePrivileges({query:async()=>({rows:CREDIT_TABLES.map((name,i)=>({name,present:i===0}))})} as never,"runtime_role"),/partially/);
});
