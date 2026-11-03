import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readPersonalWallet} from '../src/finance/personal-finance-read';
function fixture(){
 const state={coverage:true,revision:true,controlled:true,channel:true,reserved:'200',reservation:'200',available:'1200',debt:'0',debtCount:'0',installed:true,invalid:0,fail:null as Error|null};
 const queries:{sql:string;params:any[]}[]=[];
 const client={query:async(sql:string,params:any[]=[])=>{queries.push({sql,params});if(state.fail&&sql.includes('withdrawal amount reservations'))throw state.fail;
  if(sql.includes('wallet withdrawal amount schema'))return{rows:[{controlled:state.controlled,channel:state.channel}]};
  if(sql.includes('wallet withdrawal amount reservations'))return{rows:[{reserved:state.reservation,invalid:'0'}]};
  if(sql.includes("rental_referral_earning')"))return{rows:[{installed:state.installed}]};
  if(sql.includes("state='RECOVERY_REQUIRED'"))return{rows:[{amount:state.debt,count:state.debtCount,invalid:state.invalid}]};
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};
  if(sql.includes('FOR SHARE'))return{rows:[],rowCount:1};
  if(sql.startsWith('SELECT c.origin'))return{rows:state.coverage?[{origin:'RECONCILED_OPENING',cutoff:'2026-09-13T00:00:00Z',coverageVersion:'1'}]:[]};
  if(sql.includes('FROM zzsh_order.wallet_revision'))return{rows:state.revision?[{ledgerRevision:'3',readRevision:'2'}]:[]};
  if(sql.includes('AS available'))return{rows:[{available:state.available,reserved:state.reserved,pending:'0',refund:'0'}]};
  throw Error('unhandled wallet fixture SQL');
 }};return{state,queries,client:client as any};
}
test('known available and exact active reservation can be offered without declaring channel eligibility or double-subtracting reserved money',async()=>{const f=fixture(),w=await readPersonalWallet(f.client,'owner');assert.equal(w.buckets.available.amountCents,'1200');assert.equal(w.buckets.reserved.amountCents,'200');assert.equal(w.withdrawable.knowledge,'KNOWN');assert.equal(w.withdrawable.amountCents,'1200');assert(w.withdrawable.reasonCodes.includes('CURRENT_APPLICATION_CHECKS_REQUIRED'));assert(!f.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));assert(f.queries.filter(q=>q.params.length).every(q=>q.params[0]==='owner'));});
test('formal recovery blocks the new application amount but neither debits nor zeroes the displayed balance',async()=>{const f=fixture();f.state.debt='50';f.state.debtCount='1';const w=await readPersonalWallet(f.client,'owner');assert.equal(w.buckets.available.amountCents,'1200');assert.equal(w.withdrawable.amountCents,'0');assert(w.withdrawable.reasonCodes.includes('WITHDRAWAL_BLOCKED_BY_RECOVERY'));});
test('missing coverage, revisions, reservation source and inconsistent reserved facts never invent a known zero',async()=>{for(const patch of [{coverage:false},{revision:false},{controlled:false},{channel:false},{reservation:'201'},{installed:false},{invalid:1}]){const f=fixture();Object.assign(f.state,patch);const w=await readPersonalWallet(f.client,'owner');assert.equal(w.withdrawable.knowledge,'UNKNOWN');assert.equal(w.withdrawable.amountCents,null);assert(!w.withdrawable.reasonCodes.includes('WITHDRAWAL_POLICY_NOT_ACTIVE'));}});
test('known empty balances remain exact zero; very large cents remain strings; negative ledgers and SQL faults are not downgraded to empty funds',async()=>{for(const value of ['0','999999999999999999999999']){const f=fixture();f.state.available=value;const w=await readPersonalWallet(f.client,'owner');assert.equal(w.withdrawable.amountCents,value);}for(const patch of [{available:'-1'},{reserved:'-1'}]){const f=fixture();Object.assign(f.state,patch);await assert.rejects(readPersonalWallet(f.client,'owner'),(e:any)=>e.status===503);}const f=fixture();f.state.fail=Error('transport fixture failure');await assert.rejects(readPersonalWallet(f.client,'owner'),e=>e===f.state.fail);});
