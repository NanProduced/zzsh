import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {selectReviewedHistoryCandidates,assertHistoryHoldingAuthority} from './complete-round07-history-holdings.mjs';

test('only complete sets resolvable by the five reviewed mappings become candidates',()=>{
 const overlay={mappings:[1,2,3,4,5].map(x=>({field:'f',token:'t'+x}))};
 const row=(sourceId,pending,unresolved=[],extra={})=>({sourceId,reasons:[],holding:{pending,unresolved,unobservedColumns:[],...extra}});
 const values={isolated:[row('a',[{field:'f',token:'t1'}]),row('b',[{field:'f',token:'t2'}],[{field:'f',token:'t3'}]),row('c',[{field:'f',token:'unknown'}]),row('d',[{field:'f',token:'t1'}],[],{unobservedColumns:['missing']}),row('e',[])]};
 assert.deepEqual(selectReviewedHistoryCandidates(values,overlay),['a','b']);
 assert.throws(()=>selectReviewedHistoryCandidates({isolated:[values.isolated[0],values.isolated[0]]},overlay));
 assert.throws(()=>selectReviewedHistoryCandidates(values,{mappings:overlay.mappings.slice(1)}));
});
test('holding authority binds the exact target, count, finite window and no financial writes',()=>{
 const now=Date.parse('2026-11-06T15:10:00Z'),plan={target:{oid:'42'},rows:[{},{}]},a={schema:'zzsh.r07-history-holdings-authority.v1',approvedBy:'Root',status:'APPROVED',planSha256:'a',target:plan.target,operation:'ADD_REVIEWED_COMPLETE_HOLDINGS',maxAccounts:2,lock:'806006',allowFinancialWrites:false,notBefore:'2026-11-06T15:00:00Z',expiresAt:'2026-11-06T15:20:00Z',approvalRef:'r',attempt:'1'};
 assert.doesNotThrow(()=>assertHistoryHoldingAuthority(a,plan,'a',now));
 for(const change of [{maxAccounts:3},{target:{oid:'43'}},{allowFinancialWrites:true},{expiresAt:'2026-11-06T16:00:00Z'},{expiresAt:'2026-11-06T15:05:00Z'},{attempt:''}])assert.throws(()=>assertHistoryHoldingAuthority({...a,...change},plan,'a',now));
});
test('history holdings command defaults to offline mode',()=>{const p=spawnSync(process.execPath,[new URL('./complete-round07-history-holdings.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});assert.equal(p.status,0);assert.equal(JSON.parse(p.stdout).connections,0);});
