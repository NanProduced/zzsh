import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import type {Pool} from 'pg';
import * as adminSession from '../src/auth/admin-auth-session';
import * as authorization from '../src/auth/admin-authorization';
import * as managementResource from '../src/finance/distribution-management-resource';
import {setParticipantCommissionFrozen} from '../src/finance/admin-distribution-management';

const actor={userId:'operator',sessionId:'session',requestId:'request'},denied={...actor,userId:'denied'};
const body=(revision:string,frozen:boolean)=>({expectedParticipantRevision:revision,frozen,reason:'核实后调整分销资格'});
function fixture(initial:boolean|null=false){
 const state={frozen:initial,revision:'1',allowed:true,audits:[] as unknown[],calls:[] as string[],records:new Map<string,any>()};
 const client={release(){},async query(sql:string,values:any[]=[]){state.calls.push(sql);
  if(['BEGIN','COMMIT','ROLLBACK','SET CONSTRAINTS ALL IMMEDIATE'].includes(sql)||sql.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[],rowCount:0};
  if(sql.includes('FROM "zzsh_supply"."idempotency_record"')){const row=state.records.get(values[0]+'|'+values[1]);return{rows:row?[row]:[],rowCount:row?1:0};}
  if(sql.startsWith('SELECT has_column_privilege'))return{rows:[{allowed:state.allowed}],rowCount:1};
  if(sql.startsWith('SELECT commission_frozen,revision'))return{rows:[{commission_frozen:state.frozen,revision:state.revision}],rowCount:1};
  if(sql.startsWith('UPDATE zzsh_order.distribution_participant')){if(values[2]!==state.revision)return{rows:[],rowCount:0};state.frozen=values[1];state.revision=(BigInt(state.revision)+1n).toString();return{rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')){state.audits.push(JSON.parse(values[10]));return{rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){state.records.set(values[0]+'|'+values[1],{requestFingerprint:values[2],responseStatus:values[3],responseBody:JSON.parse(values[4]),publishRequired:values[5]});return{rows:[],rowCount:1};}
  throw Error('Unexpected synthetic query: '+sql);
 }};
 return{state,pool:{connect:async()=>client} as unknown as Pool};
}
async function withAuthorization(run:()=>Promise<void>){
 const session=adminSession as any,auth=authorization as any,resource=managementResource as any;
 const original=[session.assertAdminCommandAuthorizedInTransaction,auth.loadEffectiveAdminAccess,resource.assertDistributionManagementResource];
 session.assertAdminCommandAuthorizedInTransaction=async()=>{};
 auth.loadEffectiveAdminAccess=async(_c:unknown,id:string)=>({status:'ACTIVE',isBoss:false,passwordChangeRequired:false,permissions:new Set(id==='operator'?['distribution.participant.manage']:[])});
 resource.assertDistributionManagementResource=async()=>{};
 try{await run();}finally{[session.assertAdminCommandAuthorizedInTransaction,auth.loadEffectiveAdminAccess,resource.assertDistributionManagementResource]=original;}
}

test('freeze is an explicitly authorized, audited and revision-checked state change with original-key replay',async()=>withAuthorization(async()=>{
 const f=fixture(false);await assert.rejects(setParticipantCommissionFrozen(f.pool,denied,'subject',body('1',true),'key-denied'),(error:any)=>error.status===403);
 const first=await setParticipantCommissionFrozen(f.pool,actor,'subject',body('1',true),'key-1');assert.deepEqual(first.body,{userId:'subject',frozen:true,revision:'2',changed:true});
 const replay=await setParticipantCommissionFrozen(f.pool,actor,'subject',body('1',true),'key-1');assert.equal(replay.replayed,true);assert.deepEqual(replay.body,first.body);
 await assert.rejects(setParticipantCommissionFrozen(f.pool,actor,'subject',body('1',false),'key-1'),(error:any)=>error.status===409);
 await assert.rejects(setParticipantCommissionFrozen(f.pool,actor,'subject',body('1',false),'key-stale'),(error:any)=>error.status===409);
 const unchanged=await setParticipantCommissionFrozen(f.pool,actor,'subject',body('2',true),'key-noop');assert.deepEqual(unchanged.body,{userId:'subject',frozen:true,revision:'2',changed:false});
 const final=await setParticipantCommissionFrozen(f.pool,actor,'subject',body('2',false),'key-2');assert.deepEqual(final.body,{userId:'subject',frozen:false,revision:'3',changed:true});
 assert.equal(f.state.audits.length,3);assert.deepEqual(f.state.audits[0],{beforeFrozen:false,frozen:true,changed:true,beforeRevision:'1',revision:'2'});
 assert.ok(f.state.calls.some(sql=>sql.includes("pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))")));
 assert.ok(f.state.calls.every(sql=>!/(UPDATE|INSERT INTO)\s+zzsh_order\.(rental_referral_earning|settlement_ledger_entry|invitation_relation)/i.test(sql)));
}));

test('unknown source and missing column grant fail closed without recording a new operation',async()=>withAuthorization(async()=>{
 const unknown=fixture(null);await assert.rejects(setParticipantCommissionFrozen(unknown.pool,actor,'subject',body('1',false),'key-unknown'),(error:any)=>error.status===409);
 assert.equal(unknown.state.audits.length,0);assert.equal(unknown.state.records.size,0);
 const ungranted=fixture(false);ungranted.state.allowed=false;
 await assert.rejects(setParticipantCommissionFrozen(ungranted.pool,actor,'subject',body('1',true),'key-ungranted'),(error:any)=>error.status===503);
 assert.equal(ungranted.state.audits.length,0);assert.equal(ungranted.state.records.size,0);
}));

test('freeze validates body before taking any database connection',async()=>{
 let connected=false;const pool={connect:async()=>{connected=true;throw Error('must not connect');}} as unknown as Pool;
 for(const value of [{expectedParticipantRevision:'1',reason:'原因合理'},{...body('1',true),extra:true},{...body('0',true)},{...body('1',true),reason:'短'}])
  await assert.rejects(setParticipantCommissionFrozen(pool,actor,'subject',value as any,'key'),(error:any)=>error.status===400);
 assert.equal(connected,false);
});
