import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {prepareFrozenFinanceObservation} from '../src/finance/legacy-finance-source-preparation';
import {readWalletHistoricalPurposes,walletHistoricalPurpose} from '../src/finance/personal-wallet-purpose';

const subject={userId:'u1',legacyUserId:'11',identityDigest:'a'.repeat(64)},system='legacy_mysql_restore',now=1728000000;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function observation(kind:'HISTORICAL_EARNINGS_LOG'|'HISTORICAL_DISTRIBUTION'|'HISTORICAL_WITHDRAWAL',raw:Record<string,unknown>){
 const p=prepareFrozenFinanceObservation(kind,raw,subject),snapshot=p.row;
 return{id:'row-'+kind,user_id:subject.userId,legacy_user_id:subject.legacyUserId,source_kind:kind,source_type:'LEGACY_MYSQL',source_system:system,
  source_entity:kind==='HISTORICAL_EARNINGS_LOG'?'la_log_earnings':kind==='HISTORICAL_DISTRIBUTION'?'la_distribution_order':'la_withdraw_apply',
  source_id:p.sourceId,source_digest:p.sourceDigest,source_canonical:canonicalize(snapshot),source_event_at:p.sourceEventAt,snapshot};
}
const earnings=(changeType=1001,action=1,sourceId=77,sourceSn='SOURCE-77',id=101,createdAt=now)=>{
 const row=observation('HISTORICAL_EARNINGS_LOG',{id,sn:'LOG-'+id,action,amount:'5.00',userId:11,sourceId,createdAt,changeType,leftAmount:'50.00',sourceSn,remark:'PRIVATE'});
 return{...row,id:'row-earnings-'+id};
};
const distribution=(sn='SOURCE-77')=>observation('HISTORICAL_DISTRIBUTION',{
 id:'77',sn,user_id:'11',order_type:'1',order_id:'88',earnings:'5.00',level:'2',ratio:'0.05',status:'2',settle_time:String(now),is_delete:'0',update_time:String(now)});
const withdrawal=()=>observation('HISTORICAL_WITHDRAWAL',{
 id:77,sn:'SOURCE-77',type:1,money:'5.00',status:4,userId:11,is_delete:0,left_money:'5.00',create_time:now-10,handling_fee:'0.00',payment_time:0});
function order(sn='SOURCE-77',confirmTime=now){
 const snapshot={id:'77',order_sn:sn,sale_user_id:'11',order_status:'4',pay_is:'1',confirm_time:String(confirmTime),sale_earnings:'6.00',full_payout_money:'1.00'};
 return{owner_user_id:'u1',legacy_owner_id:'11',source_system:system,source_entity:'la_order',legacy_id:'77',original_order_no:sn,source_snapshot:snapshot,source_digest:sha(canonicalize(snapshot)),source_completed_at:new Date(confirmTime*1000).toISOString()};
}

test('same old 1001 code needs a uniquely verified typed source and independent source number',()=>{
 const log=earnings(),rent=order(),referral=distribution();
 assert.equal(walletHistoricalPurpose(log,[],[rent],'u1'),'OWNER_RENTAL_INCOME');
 assert.equal(walletHistoricalPurpose(log,[referral],[],'u1'),'DISTRIBUTION_INCOME');
 assert.equal(walletHistoricalPurpose(log,[referral],[rent],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[referral],[order('OTHER')],'u1'),'DISTRIBUTION_INCOME');
 assert.equal(walletHistoricalPurpose(log,[],[order('OTHER')],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[],[{...rent,legacy_id:'78'}],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[],[{...rent,owner_user_id:'u2'}],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[],[{...rent,source_system:'other'}],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[{...referral,source_digest:'0'.repeat(64)}],[rent],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[],[order('SOURCE-77',now-1)],'u1'),'OWNER_RENTAL_INCOME');
 assert.equal(walletHistoricalPurpose(log,[],[order('SOURCE-77',now-2)],'u1'),'OWNER_RENTAL_INCOME');
 assert.equal(walletHistoricalPurpose(log,[],[order('SOURCE-77',now+1)],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(log,[],[{...rent,source_completed_at:new Date((now-1)*1000).toISOString()}],'u1'),'UNKNOWN');
});
test('a missing or inconsistent supplementary source number never closes a relation',()=>{
 const log=earnings(),rent=order(),snapshot=structuredClone(log.snapshot) as any;
 delete snapshot.sourceSupplement;
 const absent={...log,snapshot,source_canonical:canonicalize(snapshot),source_digest:sha(canonicalize(snapshot))};
 assert.equal(walletHistoricalPurpose(absent,[],[rent],'u1'),'UNKNOWN');
 const changed=structuredClone(log.snapshot) as any;changed.sourceSupplement.digest='0'.repeat(64);
 const damaged={...log,snapshot:changed,source_canonical:canonicalize(changed),source_digest:sha(canonicalize(changed))};
 assert.equal(walletHistoricalPurpose(damaged,[],[rent],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose({...log,user_id:'u2'},[],[rent],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose({...log,source_system:'another-system'},[],[rent],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose({...log,source_digest:'0'.repeat(64)},[],[rent],'u1'),'UNKNOWN');
});
test('withdrawal debit and returns follow old earnings types, not payment-channel refunds',()=>{
 const apply=withdrawal(),debit=earnings(1002,2,77,'SOURCE-77',100,now-1);
 for(const [type,action,expected] of [[1002,2,'WITHDRAWAL_DEBIT'],[1003,1,'WITHDRAWAL_REJECTED_RETURN'],[1004,1,'TRANSFER_FAILED_RETURN'],[1005,1,'WECHAT_WITHDRAWAL_FAILED_RETURN']] as const){
  const log=type===1002?debit:earnings(type,action);assert.equal(walletHistoricalPurpose(log,[apply,debit,...(type===1002?[]:[log])],[],'u1'),expected);
  assert.equal(walletHistoricalPurpose(log,[],[],'u1'),'UNKNOWN');
  assert.equal(walletHistoricalPurpose(earnings(type,action===1?2:1),[apply],[],'u1'),'UNKNOWN');
  assert.equal(walletHistoricalPurpose(log,[{...apply,legacy_user_id:'12'},debit,log],[],'u1'),'UNKNOWN');
 }
});
test('withdrawal conflict checks stay within the exact application and distinguish unrelated events',()=>{
 const apply=withdrawal(),debit=earnings(1002,2,77,'SOURCE-77',100,now-1),back=earnings(1004,1);
 assert.equal(walletHistoricalPurpose(back,[apply,debit,back],[],'u1'),'TRANSFER_FAILED_RETURN');
 assert.equal(walletHistoricalPurpose(back,[apply,back],[],'u1'),'UNKNOWN');
 const repeatedDebit=earnings(1002,2,77,'SOURCE-77',102,now-1);
 const repeatedReturn=earnings(1003,1,77,'SOURCE-77',103,now);
 assert.equal(walletHistoricalPurpose(back,[apply,debit,repeatedDebit,back],[],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(back,[apply,debit,back,repeatedReturn],[],'u1'),'UNKNOWN');
 assert.equal(walletHistoricalPurpose(back,[apply,debit,back,earnings(1004,1,77,'OTHER-APPLICATION',104),earnings(1001,1,77,'SOURCE-77',105)],[],'u1'),'TRANSFER_FAILED_RETURN');
 const snapshot=structuredClone(repeatedReturn.snapshot) as any;snapshot.referenceSn='OTHER-APPLICATION';
 const inconsistent={...repeatedReturn,snapshot,source_canonical:canonicalize(snapshot),source_digest:sha(canonicalize(snapshot))};
 assert.equal(walletHistoricalPurpose(back,[apply,debit,back,inconsistent],[],'u1'),'UNKNOWN');
});
test('direct original adjustments require verified type and direction',()=>{
 for(const [type,action,expected] of [[1006,1,'PLATFORM_CREDIT'],[1007,2,'PLATFORM_DEBIT'],[1008,1,'DEPOSIT_COMPENSATION'],[1009,1,'TASK_SETTLEMENT']] as const){
  assert.equal(walletHistoricalPurpose(earnings(type,action,0,''),[],[],'u1'),expected);
  assert.equal(walletHistoricalPurpose(earnings(type,action===1?2:1,0,''),[],[],'u1'),'UNKNOWN');
 }
});
test('page enrichment uses bounded subject-scoped set reads, strips evidence and never queries per row',async()=>{
 const log=earnings(),rent=order(),queries:{sql:string;args:any[]}[]=[];
 const client={query:async(sql:string,args:any[])=>{queries.push({sql,args});return{rows:sql.includes('wallet purpose observations')?[log]:[rent]};}};
 const entries=Array.from({length:20},()=>({id:'history:'+log.id,kind:'HISTORICAL',source_kind:'HISTORICAL_EARNINGS_LOG',source_type:'LEGACY_MYSQL',source_system:system,source_id:log.source_id,business_id:'77',at:log.source_event_at,delta:'500'}));
 const result=await readWalletHistoricalPurposes(client as any,'u1',entries);
 assert.deepEqual(result.get(entries[0]!.id),{purpose:'OWNER_RENTAL_INCOME',amountSemantics:'BALANCE_RECORD'});assert.equal(queries.length,2);
 assert(queries.every(q=>q.args[0]==='u1'&&q.sql.includes('user_id=$1')));
 assert(!JSON.stringify([...result]).includes('PRIVATE'));
});
test('verified old balance amount is distinct from missing, changed or mismatched original evidence',async()=>{
 const log=earnings(),entry={id:'history:'+log.id,kind:'HISTORICAL',source_kind:'HISTORICAL_EARNINGS_LOG',source_type:'LEGACY_MYSQL',source_system:system,source_id:log.source_id,business_id:'77',at:log.source_event_at,delta:'500'};
 const run=async(rows:any[],item=entry)=>readWalletHistoricalPurposes({query:async(sql:string)=>({rows:sql.includes('wallet purpose observations')?rows:[]})} as any,'u1',[item]);
 assert.deepEqual((await run([log])).get(entry.id),{purpose:'UNKNOWN',amountSemantics:'BALANCE_RECORD'});
 assert.deepEqual((await run([{...log,source_digest:'0'.repeat(64)}])).get(entry.id),{purpose:'UNKNOWN',amountSemantics:'UNVERIFIED'});
 assert.deepEqual((await run([])).get(entry.id),{purpose:'UNKNOWN',amountSemantics:'UNVERIFIED'});
 assert.deepEqual((await run([log],{...entry,delta:'501'})).get(entry.id),{purpose:'UNKNOWN',amountSemantics:'UNVERIFIED'});
 assert.deepEqual((await run([log],{...entry,at:new Date((now+1)*1000).toISOString()})).get(entry.id),{purpose:'UNKNOWN',amountSemantics:'UNVERIFIED'});
});
