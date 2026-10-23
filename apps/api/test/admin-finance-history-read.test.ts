import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {previewFrozenFinanceObservation} from '../src/finance/legacy-finance-source-preparation';
import {loadAdminFinanceFacts,financeDocuments,financePeriodProjection,readAdminFinanceDocument} from '../src/finance/admin-finance-read';
import {financeOrderSql} from '../src/finance/admin-finance-order-read';
import {FinanceSqlFixture,legacyFinanceOrder} from './admin-finance-fixture';

const at=1782762304,subject={userId:'u1',legacyUserId:'11'};
function observation(kind:'HISTORICAL_EARNINGS_LOG'|'HISTORICAL_WITHDRAWAL',raw:Record<string,unknown>,id:string){
 const prepared=previewFrozenFinanceObservation(kind,raw,subject),source=prepared.row;
 return{id,subject_id:subject.userId,subject_name:'用户一',source_type:'LEGACY_MYSQL',source_system:'legacy_mysql_restore',source_kind:kind,
  source_entity:kind==='HISTORICAL_EARNINGS_LOG'?'la_log_earnings':'la_withdraw_apply',source_id:String(prepared.sourceId),source_digest:prepared.sourceDigest,
  amount:source.amount,action:source.action,source_status:source.sourceStatus,reference_id:source.referenceId,reference_no:source.referenceSn,
  net:source.net,fee:source.fee,balance_after:source.leftAmount,at:prepared.sourceEventAt,imported_at:'2026-10-22T00:00:00Z',included_in_opening:false,
  extra_evidence:{snapshot:source,canonical:canonicalize(source),legacyUserId:subject.legacyUserId}};
}
const log=(id='11437')=>observation('HISTORICAL_EARNINGS_LOG',{id,sn:'ORIGINAL-FLOW-'+id,action:2,amount:'734.00',userId:'11',sourceId:'5053',createdAt:at,changeType:1002,leftAmount:'10.00'},'log-'+id);
const withdrawal=()=>observation('HISTORICAL_WITHDRAWAL',{id:'5053',sn:'WITHDRAW-BUSINESS',type:0,money:'734.00',status:3,userId:'11',batch_no:'',is_delete:0,left_money:'733.00',create_time:at,handling_fee:'1.00',payment_time:0},'withdraw-5053');
function reader(fixture:FinanceSqlFixture,ready:{legacy_orders?:boolean;native_orders?:boolean}={}){
 const queries:{sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  queries.push({sql,values});
  if(sql.startsWith('SELECT to_regclass'))return {rows:[{ready:true,withdrawals:false,native_orders:false,legacy_orders:false,...ready}],rowCount:1};
  if(sql.includes('AS finance_version'))return {rows:[{finance_version:'fixture-content-version'}],rowCount:1};
  if(sql.includes('clock_timestamp()'))return {rows:[{at:'2026-10-22T00:00:00.000000Z'}],rowCount:1};
  return fixture.query(sql,values);
 }} as unknown as PoolClient;
 return{client,queries};
}
const access={adminId:'admin-fixture',isBoss:false,orderRead:false,financeDocumentRead:true};

test('withdrawal detail batches reverse debit evidence by original source and subject without adding or double counting historical rows',async()=>{
 const w=withdrawal(),h=log(),fixture=new FinanceSqlFixture({history:[w,h,{...h,id:'wrong-system',source_system:'other-system'},{...h,id:'wrong-subject',subject_id:'u2'}]});
 try{
  const r=reader(fixture),facts=await loadAdminFinanceFacts(r.client,{documentRef:'HISTORY_WITHDRAWAL:'+w.id},access),detail=readAdminFinanceDocument(facts,'HISTORY_WITHDRAWAL:'+w.id);
  assert.equal(facts.entries.length,1);assert.equal(facts.entries[0]!.historical!.association.state,'MATCHED');assert(detail.related.some(link=>link.ref==='HISTORY_EARNINGS:'+h.id));assert(!JSON.stringify(detail.related).includes('wrong-'));
  const queries=r.queries.filter(query=>query.sql.startsWith('WITH finance_reverse_candidates'));assert.equal(queries.length,1);assert(queries[0]!.values.includes('legacy_mysql_restore'));assert(queries[0]!.values.includes('u1'));assert(queries[0]!.values.includes('5053'));assert(queries[0]!.values.includes('1002'));
  assert.equal(detail.document.kind,'WITHDRAWAL');assert(facts.entries.every(entry=>!entry.affectsCurrentLedger&&!entry.affectsCurrentWallet));
 }finally{fixture.close();}
});

test('legacy order detail resolves its exact owner income through immutable source bytes and retains a missing current posting',async()=>{
 const source={id:71,order_sn:'OLD-BUSINESS',sale_user_id:11,order_status:4,pay_is:1,sale_earnings:'80.00',full_payout_money:'3.00',confirm_time:at};
 const h=observation('HISTORICAL_EARNINGS_LOG',{id:'501',sn:'OWNER-INCOME',action:1,amount:'77.00',userId:'11',sourceId:'71',createdAt:at,changeType:1001,leftAmount:'77.00'},'owner-income');
 const order=legacyFinanceOrder('old-order',{source_system:'legacy_mysql_restore',source_entity:'la_order',legacy_id:'71',original_order_no:'OLD-BUSINESS',owner_user_id:'u1',source_snapshot:source,source_digest:createHash('sha256').update(canonicalize(source)).digest('hex'),source_completed_at:new Date(at*1000).toISOString()});
 const fixture=new FinanceSqlFixture({history:[h],legacy:[order]});
 try{const r=reader(fixture,{legacy_orders:true}),facts=await loadAdminFinanceFacts(r.client,{documentRef:'LEGACY_ORDER:old-order'},{...access,isBoss:true,orderRead:true}),detail=readAdminFinanceDocument(facts,'LEGACY_ORDER:old-order');
  assert.equal(detail.entries.length,0);assert(detail.related.some(link=>link.ref==='HISTORY_EARNINGS:owner-income'));assert(detail.reasonCodes.includes('ORDER_NO_CURRENT_POSTING'));assert(!detail.reasonCodes.includes('ORIGINAL_ORDER_REFERENCE_UNRESOLVED'));
  assert.equal(r.queries.filter(query=>query.sql.startsWith('WITH finance_reverse_candidates')).length,1);
 }finally{fixture.close();}
});

test('ambiguous reverse debit stays unresolved rather than choosing one record or claiming a second withdrawal',async()=>{
 const w=withdrawal(),fixture=new FinanceSqlFixture({history:[w,log('11437'),log('11438')]});
 try{const r=reader(fixture),facts=await loadAdminFinanceFacts(r.client,{documentRef:'HISTORY_WITHDRAWAL:'+w.id},access),detail=readAdminFinanceDocument(facts,'HISTORY_WITHDRAWAL:'+w.id);
  assert.equal(facts.entries.length,1);assert.equal(facts.entries[0]!.historical!.association.state,'AMBIGUOUS');assert.equal(detail.related.length,0);assert(detail.reasonCodes.includes('ORIGINAL_ORDER_REFERENCE_AMBIGUOUS'));
 }finally{fixture.close();}
});

test('selected log document uses one exact source/subject/entity batch to link its withdrawal and preserves original rows',async()=>{
 const h=log(),w=withdrawal(),fixture=new FinanceSqlFixture({history:[h,w,{...w,id:'different-system',source_system:'other-system'}]});
 try{
  const r=reader(fixture),before=fixture.db.prepare('SELECT * FROM fixture_history ORDER BY id').all();
  const facts=await loadAdminFinanceFacts(r.client,{documentRef:'HISTORY_EARNINGS:'+h.id},access);
  assert.equal(facts.entries.length,1,'reference rows are private evidence, never extra displayed ledger entries');
  const item=facts.entries[0]!,display=item.historical!;
  assert.equal(item.documentNumber,'ORIGINAL-FLOW-11437');assert.equal(item.documentRef,'HISTORY_EARNINGS:log-11437');assert.equal(item.sourceId,'11437');assert.equal(item.sourceDigest,h.source_digest);
  assert.equal(display.association.state,'MATCHED');assert.equal(display.association.documentRef,'HISTORY_WITHDRAWAL:withdraw-5053');assert.equal(display.association.number,'WITHDRAW-BUSINESS');
  assert.equal(display.recordedAmountCents,'73400');assert.equal(display.feeCents,'100');assert.equal(display.netCents,'73300');assert.equal(display.channelState,'UNVERIFIED');
  assert.equal(financeDocuments(facts.entries)[0]!.historical,display);
  assert(!JSON.stringify(financeDocuments(facts.entries)).includes('rawSource'));assert(!JSON.stringify(facts.entries).includes('canonical'));
  const batches=r.queries.filter(query=>query.sql.startsWith('WITH finance_reference_rows'));
  assert.equal(batches.length,1);assert.deepEqual(batches[0]!.values.slice(0,-1),['legacy_mysql_restore','u1','la_withdraw_apply','5053']);assert.equal(batches[0]!.values.at(-1),20001);
  assert.deepEqual(fixture.db.prepare('SELECT * FROM fixture_history ORDER BY id').all(),before);
  assert(r.queries.every(query=>!/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)/.test(query.sql)));
 }finally{fixture.close();}
});

test('already-loaded withdrawal facts are reused and multiple log records do not become multiple current withdrawals',async()=>{
 const fixture=new FinanceSqlFixture({history:[log('11437'),log('11438'),withdrawal()]});
 try{
  const r=reader(fixture),facts=await loadAdminFinanceFacts(r.client,{subjectId:'u1'},access);
  assert.equal(facts.entries.length,3);assert.equal(r.queries.filter(query=>query.sql.startsWith('WITH finance_reference_rows')).length,0);
  const logs=facts.entries.filter(entry=>entry.sourceEntity==='la_log_earnings');assert.equal(logs.length,2);
  assert(logs.every(entry=>entry.historical!.association.documentRef==='HISTORY_WITHDRAWAL:withdraw-5053'));
  assert(facts.entries.every(entry=>!entry.affectsCurrentLedger&&!entry.affectsCurrentWallet));
  assert(financePeriodProjection(facts.entries).every(bucket=>bucket.knownInflows==='0'&&bucket.knownOutflows==='0'));
 }finally{fixture.close();}
});

test('missing reference source stays unresolved instead of inferring a withdrawal or net amount',async()=>{
 const fixture=new FinanceSqlFixture({history:[log()]});
 try{
  const r=reader(fixture),facts=await loadAdminFinanceFacts(r.client,{documentRef:'HISTORY_EARNINGS:log-11437'},access);
  const item=facts.entries[0]!;assert.equal(item.historical!.purposeCode,'WITHDRAWAL_DEBIT');assert.equal(item.historical!.association.state,'UNRESOLVED');
  assert.equal(item.historical!.feeCents,null);assert.equal(item.historical!.netCents,null);assert.deepEqual(item.related,[]);
  assert.equal(r.queries.filter(query=>query.sql.startsWith('WITH finance_reference_rows')).length,1);
 }finally{fixture.close();}
});

test('existing batched order reader evaluates explicit domain capabilities and game scope without filtering finance facts away',()=>{
 const fixture=new FinanceSqlFixture({legacy:[legacyFinanceOrder('allowed',{game_id:'delta'}),legacyFinanceOrder('denied',{game_id:'other'})]});
 try{
  fixture.db.prepare('INSERT INTO zzsh_iam.admin_security VALUES(?,?)').run('operator','SELECTED_GAMES');
  fixture.db.prepare('INSERT INTO zzsh_supply.admin_supply_scope VALUES(?,?)').run('operator','delta');
  const scope={orderRefs:['LEGACY_ORDER:allowed','LEGACY_ORDER:denied']},capabilities={...access,adminId:'operator',orderRead:true,resourceRead:false};
  const sql=financeOrderSql(true,scope,[],20001,capabilities),rows=fixture.query(sql.text,sql.values).rows;
  assert.equal(rows.length,2);assert.equal(rows.find(row=>row.id==='allowed')!.object_readable,1);assert.equal(rows.find(row=>row.id==='denied')!.object_readable,0);
  assert(rows.every(row=>row.account_readable===0));
  const financialOnly=financeOrderSql(true,scope,[],20001,{...capabilities,orderRead:false});
  assert(fixture.query(financialOnly.text,financialOnly.values).rows.every(row=>row.object_readable===0));
 }finally{fixture.close();}
});
