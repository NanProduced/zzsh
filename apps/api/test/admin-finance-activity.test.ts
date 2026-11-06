import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { parseActivityQuery, readAdminBalanceActivity, readAdminChannelActivity } from '../src/finance/admin-finance-activity';

const access = { adminId:'admin',isBoss:true,orderRead:true,financeDocumentRead:true,resourceRead:true };
const base = { q:'',source:'NATIVE' as const,kind:'ALL' as const,view:'LIVE' as const,page:1,pageSize:20,asOf:null };

test('activity filters reject ambiguous queries, phone numbers and unanchored later pages',()=>{
  assert.equal(parseActivityQuery(new URLSearchParams('source=LEGACY&kind=REFUND'),false).kind,'REFUND');
  assert.equal(parseActivityQuery(new URLSearchParams('view=OPENING'),true).view,'OPENING');
  assert.equal(parseActivityQuery(new URLSearchParams('source=LEGACY'),true).view,'HISTORY');
  for (const input of ['q=13812345678','page=2','source=LEGACY&source=NATIVE','kind=GUARANTEE','pageSize=101','asOf=bad'])
    assert.throws(()=>parseActivityQuery(new URLSearchParams(input),false));
  assert.throws(()=>parseActivityQuery(new URLSearchParams('kind=REFUND'),true));
  assert.throws(()=>parseActivityQuery(new URLSearchParams('view=OPENING'),false));
  assert.equal(parseActivityQuery(new URLSearchParams(),false).source,'NATIVE');
  assert.throws(()=>parseActivityQuery(new URLSearchParams('source=ALL'),false));
  assert.throws(()=>parseActivityQuery(new URLSearchParams('operation=QUERY'),false));
  assert.throws(()=>parseActivityQuery(new URLSearchParams('view=OPENING&source=NATIVE'),true));
  for(const input of ['from=2026-01-01','from=2026-02-30&to=2026-03-01','from=2026-03-02&to=2026-03-01','view=OPENING&type=WITHDRAWAL','view=HISTORY&nonzero=1','view=OPENING&from=2026-01-01&to=2026-01-02'])assert.throws(()=>parseActivityQuery(new URLSearchParams(input),true));
  const selected=parseActivityQuery(new URLSearchParams('view=HISTORY&type=SETTLEMENT&from=2026-01-01&to=2026-01-31'),true);assert.equal(selected.balanceType,'SETTLEMENT');assert.equal(selected.from,'2026-01-01');assert.equal(selected.to,'2026-01-31');
  assert.equal(parseActivityQuery(new URLSearchParams('view=OPENING&nonzero=1'),true).nonzero,true);
});

test('channel list selects recorded Joinpay attempts and never builds SQL from a search term',async()=>{
  let seen = '', params:unknown[]=[];
  const client = { query:async(sql:string,values:unknown[])=>{ seen=sql; params=values; return {rows:[{family:null,id:null,at:null,total:'0'}]}; } } as unknown as PoolClient;
  const result=await readAdminChannelActivity(client,{...base,q:"test%' OR true --"},access);
  assert.equal(result.items.length,0);
  assert.match(seen,/joinpay_collection_attempt/); assert.match(seen,/joinpay_refund_attempt/); assert.match(seen,/joinpay_payout_attempt/);
  assert.match(seen,/p\.channel='JOINPAY'/); assert.doesNotMatch(seen,/test%' OR true/);
  assert.equal(params[0],"%test\\%' OR true --%");
});

test('document-only channel lookup requires an exact record number and cannot search user names',async()=>{
 let seen='',params:unknown[]=[];
 const client={query:async(sql:string,values:unknown[])=>{seen=sql;params=values;return {rows:[{family:null,id:null,at:null,total:'0'}]};}} as unknown as PoolClient;
 await assert.rejects(()=>readAdminChannelActivity(client,base,access,true));
 await readAdminChannelActivity(client,{...base,source:'LEGACY',q:'PAY-123'},access,true);
 assert.equal(params[0],'PAY-123');assert.match(seen,/o\.snapshot->>'sourceNumber',''\)=\$1/);
 assert.doesNotMatch(seen,/u\.name.*ILIKE|u\.id.*ILIKE/);assert.doesNotMatch(seen,/ILIKE/);
 assert.doesNotMatch(seen,/joinpay_collection_attempt|joinpay_refund_attempt|joinpay_payout_attempt/);
});

test('native channel records include submissions only, never query attempts',async()=>{
 let sql='',values:unknown[]=[];const client={query:async(text:string,params:unknown[])=>{sql=text;values=params;return {rows:[{family:null,id:null,at:null,total:'0'}]};}} as unknown as PoolClient;
 await readAdminChannelActivity(client,parseActivityQuery(new URLSearchParams(),false),access);
 assert.equal((sql.match(/a\.operation='SUBMIT'/g)??[]).length,3);assert.doesNotMatch(sql,/a\.operation='QUERY'|HISTORICAL_PAYMENT/);assert.equal(values.length,11);
});

test('a payout attempt displays the channel net amount without exposing request or bank data',async()=>{
 let detail='';
 const client={query:async(sql:string)=>{
  if(sql.startsWith('WITH activity_candidates'))return {rows:[{family:'withdrawal',id:'attempt1',at:'2026-01-01T00:00:00Z',total:'1'}]};
  detail=sql;return {rows:[{id:'attempt1',operation:'SUBMIT',business_id:'wd1',number:'N1',state:'UNKNOWN',amount:'950',gross_cents:'1000',fee_cents:'50',user_id:'u1',name:'用户',at:'2026-01-01T00:00:00Z'}]};
 }} as unknown as PoolClient;
 const result=await readAdminChannelActivity(client,{...base,kind:'WITHDRAWAL'},access),item=result.items[0] as {amountCents:string;grossCents:string;feeCents:string;amountLabel:string;state:string};
 assert.match(detail,/w\.net_cents::text AS amount/);assert.doesNotMatch(detail,/request_body|receiver_account|receiver_name/);
 assert.equal(item.amountCents,'950');assert.equal(item.grossCents,'1000');assert.equal(item.feeCents,'50');assert.equal(item.amountLabel,'渠道出款金额');assert.equal(item.state,'UNKNOWN');
});

test('current balance movements exclude opening and show each available withdrawal leg once',async()=>{
  const ledger = [
    {id:'reserve',account_code:'WALLET_AVAILABLE',subject_id:'u1',subject_name:'用户',delta:'-1000',event_kind:'JOINPAY_WITHDRAWAL_RESERVED',source_entity:'joinpay_withdrawal_intent',source_id:'w1',at:'2026-01-02T00:00:00Z'},
    {id:'release',account_code:'WALLET_AVAILABLE',subject_id:'u1',subject_name:'用户',delta:'1000',event_kind:'JOINPAY_WITHDRAWAL_RELEASED',source_entity:'joinpay_withdrawal_intent',source_id:'w1',at:'2026-01-03T00:00:00Z'},
    {id:'revoke',account_code:'WALLET_AVAILABLE',subject_id:'u1',subject_name:'用户',delta:'-200',event_kind:'EARNING_REVOKED',source_kind:'NATIVE_RENTAL_REFERRAL',economic_root_id:'earning1',at:'2026-01-04T00:00:00Z'},
    {id:'legacy-commission',account_code:'WALLET_AVAILABLE',subject_id:'u1',subject_name:'用户',delta:'300',event_kind:'LEGACY_DUTY_SETTLED',source_kind:'LEGACY_CONTINUATION_DUTY',beneficiary_role:'COMMISSION',source_id:'duty1',at:'2026-01-05T00:00:00Z'},
  ];
  let selection='';
  const client={query:async(sql:string)=>{
    if(sql.startsWith('WITH activity_candidates')) {selection=sql;return {rows:ledger.map(row=>({family:'ledger',id:row.id,at:row.at,total:String(ledger.length)}))};}
    return {rows:ledger};
  }} as unknown as PoolClient;
  const result=await readAdminBalanceActivity(client,base,access), items=result.items as {source:string;label:string;amountCents:string}[];
  assert.match(selection,/l\.account_code IN \('OWNER_AVAILABLE','WALLET_AVAILABLE'\)/);
  assert.match(selection,/e\.kind<>'OPENING'/);assert.doesNotMatch(selection,/personal_finance_observation/);
  assert.deepEqual(items.map(row=>[row.source,row.label,row.amountCents]),[['NATIVE','提现扣除','-1000'],['NATIVE','提现退回','1000'],['NATIVE','分销收益冲回','-200'],['NATIVE','分销收入','300']]);
  assert.equal(result.total,4);
});

test('opening view shows proved zero and nonzero opening values without inventing ledger entries',async()=>{
  let selection='';
  const client={query:async(sql:string)=>{
    if(sql.startsWith('WITH activity_candidates')) {selection=sql;return {rows:[{family:'opening',id:'basis0',at:'2026-01-01T00:00:00Z',total:'2'},{family:'opening',id:'basis1',at:'2026-01-01T00:00:00Z',total:'2'}]};}
    return {rows:[{id:'basis0',user_id:'u1',name:'用户',amount:'0',at:'2026-01-01T00:00:00Z'},{id:'basis1',user_id:'u2',name:'用户二',amount:'12345',at:'2026-01-01T00:00:00Z'}]};
  }} as unknown as PoolClient;
  const result=await readAdminBalanceActivity(client,{...base,view:'OPENING'},access),items=result.items as {source:string;amountCents:string;documentRef:null}[];
  assert.match(selection,/finance_opening_basis/);assert.match(selection,/wallet_coverage/);assert.doesNotMatch(selection,/settlement_ledger_entry/);
  assert.deepEqual(items.map(item=>[item.source,item.amountCents,item.documentRef]),[['OPENING','0',null],['OPENING','12345',null]]);assert.equal(result.total,2);
});

test('history view never mixes current ledger or opening facts and retains an exact empty-page total',async()=>{
 let selection='';const client={query:async(sql:string)=>{selection=sql;return {rows:[{family:null,id:null,at:null,total:'4'}]};}} as unknown as PoolClient;
 const result=await readAdminBalanceActivity(client,{...base,view:'HISTORY',page:2,asOf:'2026-01-01T00:00:00.000Z'},access);
 assert.match(selection,/HISTORICAL_EARNINGS_LOG/);assert.doesNotMatch(selection,/finance_opening_basis|settlement_ledger_entry/);
 assert.equal(result.total,4);assert.equal(result.items.length,0);assert.equal(result.hasMore,false);
});

test('date and type filters are applied before counting and opening can select nonzero values',async()=>{
 let sql='',values:unknown[]=[];const client={query:async(text:string,params:unknown[])=>{sql=text;values=params;return {rows:[{family:null,id:null,at:null,total:'0'}]};}} as unknown as PoolClient;
 const history=parseActivityQuery(new URLSearchParams('view=HISTORY&type=SETTLEMENT&from=2026-01-01&to=2026-01-31'),true);
 await readAdminBalanceActivity(client,history,access);assert.match(sql,/legacyChangeType/);assert.match(sql,/o\.source_event_at>=\$8::timestamptz/);assert.ok(sql.indexOf('legacyChangeType')<sql.indexOf('activity_total'));
 assert.equal(values[7],'2026-01-01T00:00:00+08:00');assert.equal(values[8],'2026-01-31T16:00:00.000Z');assert.equal(values[9],'SETTLEMENT');
 await readAdminBalanceActivity(client,parseActivityQuery(new URLSearchParams('view=OPENING&nonzero=1'),true),access);assert.match(sql,/b\.available_cents<>0/);assert.equal(values[10],true);
});
