import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareOwnerGuaranteeHistory,planOwnerGuaranteeHistoryBatch,readOwnerGuaranteeHistory,readPostedOwnerGuarantee,type LegacyGuaranteeHistoryInput} from '../src/finance/owner-guarantee-history';
const at='2026-10-15T00:00:00.000000Z',cutoff='2026-09-13T13:31:22.000Z',actor={userId:'owner',sessionId:'session'},key={keyId:'fixture',secret:'x'.repeat(40)};
const source=(id='101'):LegacyGuaranteeHistoryInput=>({userId:'owner',legacyUserId:'11',accountId:'account-'+id,source:{id,user_id:'11',no:'ACCOUNT-'+id,status:'1',is_delete:'0',pay_money:'0.00',pay_is:'0',pay_time:'1779469800',return_is:'1'},payOrders:[{id:'501',order_id:id,order_type:'2',pay_money:'5.00',pay_is:'1',pay_order_sn:'ORIGINAL-MERCHANT-ORDER',pay_time:'1779469800',create_time:'1779469700'}]});
test('CF3 zero/reset marks retain original paid attempts, amount mismatch and UNKNOWN liability/refund without creating held cash',()=>{
 const i=source();i.payOrders.push({...i.payOrders[0]!,id:'502'});const p=prepareOwnerGuaranteeHistory(i);assert.equal(p.accountFieldCents,'0');assert.equal(p.paidRecordCents,'1000');assert.equal(p.paidRecordCount,'2');assert.equal(p.classification,'ZERO_AMOUNT_RETURN_MARK');assert.deepEqual(p.conflicts,['MULTIPLE_PAID_ATTEMPTS','CURRENT_AMOUNT_DIFFERS_FROM_PAID_ATTEMPT']);assert.equal(p.payments[0]!.merchantOrderNumber,'ORIGINAL-MERCHANT-ORDER');assert.equal(p.payments[0]!.channelArrival,'UNKNOWN');assert.equal(p.liability.amountCents,null);assert.equal(p.refund.amountCents,null);
});

test('a zero current amount never hides an original typed paid attempt behind the zero-paid-mark classification',()=>{
 const i=source();i.source.return_is=null;i.source.pay_is='1';const p=prepareOwnerGuaranteeHistory(i);assert.equal(p.classification,'SOURCE_PAID_REFUND_UNKNOWN');assert.equal(p.accountFieldCents,'0');assert.equal(p.paidRecordCents,'500');assert.equal(p.payments.length,1);assert.deepEqual(p.conflicts,['CURRENT_AMOUNT_DIFFERS_FROM_PAID_ATTEMPT']);assert.equal(p.liability.knowledge,'UNKNOWN');assert.equal(p.refund.knowledge,'UNKNOWN');assert.equal(p.channelArrival,'UNKNOWN');
 i.payOrders=[];assert.equal(prepareOwnerGuaranteeHistory(i).classification,'ZERO_AMOUNT_PAID_MARK');
});
test('rental-order same numeric ID, foreign owner/account, duplicate attempts, secrets and invalid cents reject',()=>{
 for(const change of [(i:LegacyGuaranteeHistoryInput)=>i.payOrders[0]!.order_type='1',(i:LegacyGuaranteeHistoryInput)=>i.source.user_id='other',(i:LegacyGuaranteeHistoryInput)=>i.payOrders[0]!.order_id='other',(i:LegacyGuaranteeHistoryInput)=>i.payOrders.push({...i.payOrders[0]!}),(i:LegacyGuaranteeHistoryInput)=>i.source.pay_url='secret-link',(i:LegacyGuaranteeHistoryInput)=>i.payOrders[0]!.pay_money='5.001']){const i=source();change(i);assert.throws(()=>prepareOwnerGuaranteeHistory(i));}
});
test('source universe explicitly closes complete zero, mapped observations and isolated sources',()=>{
 const base={userId:'owner',legacyUserId:'11',identityDigest:'a'.repeat(64),inputSha256:'b'.repeat(64),cutoff,sourceCount:0,rows:[],isolated:[]};
 assert.equal(planOwnerGuaranteeHistoryBatch(base).coverage.sourceKind,'OWNER_GUARANTEE_HISTORY');assert.equal(planOwnerGuaranteeHistoryBatch(base).coverage.sourceEntity,'la_rental_accounts');
 assert.equal(planOwnerGuaranteeHistoryBatch({...base,sourceCount:1,rows:[source()]}).coverage.importedCount,1);
 assert.equal(planOwnerGuaranteeHistoryBatch({...base,sourceCount:1,isolated:[{sourceId:'102',sourceDigest:'c'.repeat(64),reason:'ACCOUNT_UNMAPPED'}]}).coverage.isolatedCount,1);
 assert.throws(()=>planOwnerGuaranteeHistoryBatch({...base,sourceCount:2,rows:[source(),source()]}));
});
function fixture(count=1){
 const plans=Array.from({length:count},(_,n)=>prepareOwnerGuaranteeHistory(source(String(101+n)))),digest=createHash('sha256').update(plans.slice().sort((a,b)=>a.sourceId<b.sourceId?-1:1).map(p=>p.sourceId+':'+p.sourceDigest).join('\n')).digest('hex');
 const rows=plans.map((p,n)=>({id:'guarantee_history_'+String(n).padStart(3,'0'),account_id:p.accountId,legacy_account_id:p.sourceId,source_canonical:p.sourceCanonical,source_digest:p.sourceDigest,at})).reverse();
 const state={installed:true,coverage:true,isolated:0,badDigest:false,badRow:false,held:'500',queries:[] as {sql:string;args:any[]}[]};
 const c={query:async(sql:string,args:any[]=[])=>{state.queries.push({sql,args});if(sql.includes('owner guarantee history schema'))return{rows:[{ready:state.installed,native_ready:true}]};if(sql.includes('owner guarantee posted held'))return{rows:[{held:state.held}]};if(sql.includes('owner guarantee history coverage'))return{rows:state.coverage?[{id:'coverage-fixture',user_id:'owner',source_count:count+state.isolated,imported_count:count,isolated_count:state.isolated,body_digest:'d'.repeat(64),cutoff,actual_count:String(count),actual_digest:state.badDigest?'wrong':digest,imported_set_digest:digest}]:[]};if(sql.includes('owner guarantee history page'))return{rows:rows.filter(r=>!args[4]||r.id<args[4]).slice(0,21).map(r=>state.badRow?{...r,source_digest:'f'.repeat(64)}:r)};if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};throw Error('Unexpected history read');}};
 return{state,c:c as any};
}
test('known full history, source-absent empty and partial isolation are distinct; no row creates guarantee credit or refund',async()=>{
 const p=fixture(),r=await readOwnerGuaranteeHistory(p.c,actor,null,key);assert.equal(r.items[0]!.paidRecordCents,'500');assert.equal(r.items[0]!.liability.amountCents,null);assert.equal(r.coverage.knowledge,'KNOWN');assert.equal(r.postedHeld.amountCents,'500');assert.equal(r.postedHeld.scope,'POSTED_LEDGER_ONLY');assert(!p.state.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 const empty=fixture(0);assert.equal((await readOwnerGuaranteeHistory(empty.c,actor,null,key)).coverage.count,'0');empty.state.coverage=false;const unknown=await readOwnerGuaranteeHistory(empty.c,actor,null,key);assert.equal(unknown.coverage.count,null);assert.equal(unknown.items.length,0);
 p.state.isolated=1;const partial=await readOwnerGuaranteeHistory(p.c,actor,null,key);assert.equal(partial.coverage.count,null);assert.equal(partial.items.length,1);
});
test('same-time history paging is source-version/session bound and preserves original source IDs',async()=>{
 const f=fixture(21),first=await readOwnerGuaranteeHistory(f.c,actor,null,key);assert.equal(first.items.length,20);assert(first.nextCursor);const next=await readOwnerGuaranteeHistory(f.c,actor,first.nextCursor,key);assert.equal(next.items.length,1);assert.notEqual(first.items[0]!.id,next.items[0]!.id);await assert.rejects(readOwnerGuaranteeHistory(f.c,{...actor,sessionId:'other'},first.nextCursor,key),(e:any)=>e.status===409);assert(f.state.queries.filter(q=>q.sql.includes('history page')).every(q=>q.args[0]==='owner'));
});
test('native held changes invalidate an otherwise unchanged history cursor before querying another page',async()=>{
 const f=fixture(21),first=await readOwnerGuaranteeHistory(f.c,actor,null,key);assert(first.nextCursor);assert.equal((await readOwnerGuaranteeHistory(f.c,actor,first.nextCursor,key)).items.length,1);
 const pages=f.state.queries.filter(q=>q.sql.includes('history page')).length;f.state.held='600';
 await assert.rejects(readOwnerGuaranteeHistory(f.c,actor,first.nextCursor,key),(e:any)=>e.status===409);assert.equal(f.state.queries.filter(q=>q.sql.includes('history page')).length,pages);
 const fresh=await readOwnerGuaranteeHistory(f.c,actor,null,key);assert.equal(fresh.postedHeld.amountCents,'600');assert.notEqual(fresh.snapshotVersion,first.snapshotVersion);assert.equal(fresh.items.length,20);assert(fresh.snapshotVersion!.length<=256);
});
test('bad target set, source canonical and DB failures do not become normal empty history',async()=>{
 const f=fixture();f.state.badDigest=true;await assert.rejects(readOwnerGuaranteeHistory(f.c,actor,null,key),(e:any)=>e.status===503);f.state.badDigest=false;f.state.badRow=true;await assert.rejects(readOwnerGuaranteeHistory(f.c,actor,null,key),(e:any)=>e.status===503);
 const fail=Error('DB_UNAVAILABLE');await assert.rejects(readPostedOwnerGuarantee({query:async()=>{throw fail;}} as any,'owner'),e=>e===fail);
});
