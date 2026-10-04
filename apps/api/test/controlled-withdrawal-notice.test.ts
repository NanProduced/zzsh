import {test} from 'node:test';import {strict as assert} from 'node:assert';import type {Pool,PoolClient} from 'pg';import {createControlledNoticeReader,requireVerifiedControlledNotice,declareControlledNotice} from '../src/finance/controlled-withdrawal-notice';import {createHash} from 'node:crypto';import {canonicalize} from '../src/supply/content-hash';
const evidence={mode:'LOCAL_CONTROLLED',intentId:'intent',payoutKey:'original',outcome:'FAILED',reference:'original-operation',unpaidConfirmed:true,transferredCents:'0',chargedFeeCents:'0'},canonical=canonicalize(evidence),resource={name:'zzsh_test_m2_auth_auth_compat',role:'zzsh_m2_auth_compat_r',oid:820148,marker:'zzsh:m2-auth-test:v1',complete:true};
function probe(patch:Record<string,unknown>={},present=true){const queries:string[]=[];const pool={connect:async()=>({release(){},query:async(sql:string)=>{queries.push(sql);return{rows:sql.startsWith('SELECT current_database')?[resource]:sql.startsWith('SELECT to_regclass')?[{present}]:sql.startsWith('SELECT n.id')?[{id:'notice',original_operation_id:'op',evidence_canonical:canonical,source_digest:createHash('sha256').update(canonical).digest('hex'),mode:'LOCAL_CONTROLLED_DECLARED_NOTICE',intent_id:'intent',payout_key:'original',...patch}]:[]};}})} as unknown as Pool;return{queries,pool};}
test('notice capability comes only from declared original source and cannot be copied or moved to UI resource',async()=>{const p=probe(),notice=await createControlledNoticeReader(p.pool,{resourceOid:820148,allowedNoticeIds:['notice']})('notice');assert.equal(requireVerifiedControlledNotice(notice,820148),notice);assert.throws(()=>requireVerifiedControlledNotice({...notice},820148));assert.throws(()=>requireVerifiedControlledNotice(notice,833000));assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));});
test('absent schema, wrong source digest/mode/key and undeclared notice fail before any mutation',async()=>{for(const patch of [{source_digest:'0'.repeat(64)},{mode:'REAL_BANK'},{payout_key:'other'}]){const p=probe(patch);await assert.rejects(createControlledNoticeReader(p.pool,{resourceOid:820148,allowedNoticeIds:['notice']})('notice'));assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));}const absent=probe({},false);await assert.rejects(createControlledNoticeReader(absent.pool,{resourceOid:820148,allowedNoticeIds:['notice']})('notice'),e=>(e as {status?:number}).status===503);await assert.rejects(createControlledNoticeReader(absent.pool,{resourceOid:820148,allowedNoticeIds:['notice']})('foreign'));});
test('canonical digest alone cannot admit malformed notice amounts, flags, extra fields or references',async()=>{
 for(const change of [{chargedFeeCents:0},{transferredCents:'-1'},{unpaidConfirmed:'true'},{reference:''},{surprise:'field'}]){
  const bad=canonicalize({...evidence,...change}),p=probe({evidence_canonical:bad,source_digest:createHash('sha256').update(bad).digest('hex')});
  await assert.rejects(createControlledNoticeReader(p.pool,{resourceOid:820148,allowedNoticeIds:['notice']})('notice'));assert(!p.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));
 }
});
test('runtime and other resources cannot declare a source even with a syntactically correct approval digest',async()=>{
 for(const r of [resource,{...resource,role:'zzsh_m2_auth_compat_m',oid:833000}]){
  const queries:string[]=[],c={query:async(sql:string)=>{queries.push(sql);return{rows:[r]};}} as PoolClient;
  await assert.rejects(declareControlledNotice(c,{userId:'boss',sessionId:'session',requestId:'request'},{noticeId:'notice',sourceEventKey:'event',originalOperationId:'op',userId:'user',evidence:evidence as any,approvalDigest:'a'.repeat(64),reason:'reviewed local'}));assert.equal(queries.length,1);
 }
});
test('same source event with a new request id returns original notice; changed digest has no writes',async()=>{
 const queries:string[]=[],digest=createHash('sha256').update(canonical).digest('hex'),c={query:async(sql:string)=>{
  queries.push(sql);if(sql.startsWith('SELECT current_database'))return{rows:[{...resource,role:'zzsh_m2_auth_compat_m'}]};
  if(sql.startsWith('SELECT s.'))return{rows:[{locked:false,twoFactorEnabled:true}]};
  if(sql.includes('FROM "zzsh_iam"."admin_security"'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}]};
  if(sql.startsWith('SELECT suspended'))return{rows:[{suspended:false}]};
  if(sql.startsWith('SELECT id,source_digest'))return{rows:[{id:'original-notice',source_digest:digest,original_operation_id:'op',user_id:'user',intent_id:'intent',payout_key:'original'}]};return{rows:[]};
 }} as PoolClient,actor={userId:'boss',sessionId:'session',requestId:'request'},input={noticeId:'new-request-id',sourceEventKey:'same-event',originalOperationId:'op',userId:'user',evidence:evidence as any,approvalDigest:'a'.repeat(64),reason:'reviewed local'};
 assert.deepEqual(await declareControlledNotice(c,actor,input),{noticeId:'original-notice',replayed:true,sourceDigest:digest});
 await assert.rejects(declareControlledNotice(c,actor,{...input,evidence:{...evidence,chargedFeeCents:'1'} as any}),e=>(e as {status?:number}).status===409);
 assert(!queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));assert(!queries.some(q=>q.includes('settlement_ledger_entry')));
});
test('source event key accepts the 128-character boundary and rejects 129 before SQL',async()=>{
 const queries:string[]=[],c={query:async(sql:string)=>{queries.push(sql);return{rows:[resource]};}} as PoolClient,actor={userId:'boss',sessionId:'session',requestId:'request'},input={noticeId:'notice',sourceEventKey:'x'.repeat(128),originalOperationId:'op',userId:'user',evidence:evidence as any,approvalDigest:'a'.repeat(64),reason:'reviewed local'};
 await assert.rejects(declareControlledNotice(c,actor,input),e=>(e as {status?:number}).status===409);assert.equal(queries.length,1);queries.length=0;
 await assert.rejects(declareControlledNotice(c,actor,{...input,sourceEventKey:'x'.repeat(129)}),e=>(e as {status?:number}).status===400);assert.equal(queries.length,0);
});
