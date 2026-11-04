import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readPersonalFinanceEntries,readPersonalFinanceEntry,parseFinanceQuery,decodeFinanceEntryId,FINANCE_LEDGER_POSTED_AT_SQL} from '../src/finance/personal-finance-read';
import {mountPersonalFinanceRead} from '../src/finance/personal-finance-routes';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import * as historyCoverage from '../src/finance/personal-finance-coverage';
import * as nativeWallet from '../src/finance/native-wallet-projection';
const {parseWalletEntryListCoverage}=require(resolve('../web/src/lib/personal-wallet-client.ts'));
const at='2026-10-15T00:00:00.000000Z',asOf='2026-10-16T00:00:00.000000Z',actor={userId:'u1',sessionId:'s1'},key={keyId:'fixture',secret:'x'.repeat(40)};
/** Executes the actual small-value CASE/filter/page SQL; PG numeric/MVCC/lock behavior is not simulated. */
function fixture(){
 const db=new DatabaseSync(':memory:'),seen:{sql:string;args:any[]}[]=[];
 db.exec(`ATTACH DATABASE ':memory:' AS zzsh_order;
  CREATE TABLE zzsh_order.settlement_ledger_entry(id TEXT,created_at TEXT,account_code TEXT,credit_cents TEXT,debit_cents TEXT,counterparty_user_id TEXT,finance_event_id TEXT,posting_id TEXT,details TEXT);
  CREATE TABLE zzsh_order.finance_event(id TEXT,kind TEXT,economic_root_id TEXT,created_at TEXT);
  CREATE TABLE zzsh_order.finance_economic_root(id TEXT,source_kind TEXT,source_type TEXT,source_system TEXT,source_entity TEXT,source_id TEXT);
  CREATE TABLE zzsh_order.settlement_posting(id TEXT,order_id TEXT,posted_at TEXT);
  CREATE TABLE zzsh_order.personal_finance_observation(id TEXT,user_id TEXT,source_event_at TEXT,imported_at TEXT,snapshot TEXT,included_in_opening BOOLEAN,source_kind TEXT,source_id TEXT,source_type TEXT,source_system TEXT,source_entity TEXT,basis_id TEXT,source_digest TEXT,legacy_user_id TEXT);
  CREATE TABLE zzsh_order.wallet_coverage(user_id TEXT,basis_id TEXT);
  CREATE TABLE zzsh_order.finance_observation_admission(basis_id TEXT,user_id TEXT,source_system TEXT,legacy_user_id TEXT,source_entity TEXT,source_id TEXT,source_digest TEXT,source_event_at TEXT,included_in_opening BOOLEAN);`);
 const insert=db.prepare('INSERT INTO zzsh_order.settlement_ledger_entry VALUES(?,?,?,?,?,?,?,?,?)');
 for(const [id,bucket,amount,user]of [['available','WALLET_AVAILABLE','100','u1'],['refund','RENTER_REFUND_PAYABLE','20','u1'],['reserved','WALLET_RESERVED','30','u1'],['pending','WALLET_PENDING_EARNINGS','40','u1'],['foreign','WALLET_RESERVED','999','u2']])insert.run(id!,at,bucket!,amount!,'0',user!,null,null,'{}');
 const translate=(sql:string)=>sql.replace(/to_char\((at|imported_at|posted_at|recorded_at) AT TIME ZONE 'UTC','[^']*'\)/g,'$1').replace(/::numeric\(24,0\)/g,'').replace(/::(?:text|numeric|timestamptz|jsonb)\b/g,'').replaceAll("o.snapshot->>'action'","CAST(o.snapshot->>'action' AS TEXT)").replaceAll(' COLLATE "C"','').replaceAll('json_build_object(','json_object(').replaceAll('json_agg(','json_group_array(');
 const mapRow=(r:Record<string,any>)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='included'?Boolean(v):v!==null&&['delta','balance_after','recorded_amount','source_status','source_level','count','postedNetCents','coveredHistoricalNetCents','uncoveredHistoricalNetCents','coveredCount','uncoveredCount'].includes(k)?String(v):v]));
 const query=async(sql:string,args:any[]=[])=>{seen.push({sql,args});
  if(sql.startsWith('WITH entries')||sql.startsWith(`SELECT 'ledger:'||`)||sql.startsWith(`SELECT 'history:'||`)){
   const rows=db.prepare(translate(sql)).all(Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]))) as Record<string,any>[];
   if(sql.includes('page_json')){
    const bundle=rows[0] as any,fix=(j:string,keys:string[])=>JSON.stringify((JSON.parse(j) as any[]).map(o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,keys.includes(k)&&v!==null?String(v):v]))));
    return{rows:[{totals_json:fix(bundle.totals_json,['count','postedNetCents','coveredHistoricalNetCents','uncoveredHistoricalNetCents','coveredCount','uncoveredCount']),page_json:fix(bundle.page_json,['delta','balance_after','recorded_amount','source_status','source_level'])}],rowCount:1};
   }
   return{rows:rows.map(mapRow),rowCount:rows.length};
  }
  if(sql.includes('to_regclass'))return{rows:[{ready:true,installed:false}],rowCount:1};
  if(sql.includes('FOR SHARE'))return{rows:[{id:args[0]}],rowCount:1};
  if(sql.startsWith('SELECT c.origin'))return{rows:[{origin:'RECONCILED_OPENING',cutoff:'2026-09-13T13:31:22.000Z',coverageVersion:'1'}],rowCount:1};
  if(sql.includes('AS available'))return{rows:[{available:'100',reserved:'30',pending:'40',refund:'20'}],rowCount:1};
  if(sql.includes('wallet_revision'))return{rows:[{ledgerRevision:'5',readRevision:'9'}],rowCount:1};
  if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{at:asOf}],rowCount:1};
  return{rows:[{suspended:false,accountStatus:'ACTIVE'}],rowCount:1};
 };
 const c={query,release(){}} as any,pool={query,connect:async()=>c} as any;
 return{db,c,pool,seen,close:()=>db.close()};
}

test('five full-length source coverage revisions fit the actual wallet parser and any source change invalidates the cursor',async t=>{
 const f=fixture(),cutoff='2026-09-13T13:31:22.000Z';let changed=false;
 const versions=new Map(Object.keys(historyCoverage.OBSERVATION_ENTITIES).map(sourceKind=>{
  const c=historyCoverage.prepareObservationCoverage({userId:'u1',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',sourceKind:sourceKind as historyCoverage.ObservationKind,cutoff,inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:0,imported:[],isolated:[]});
  return[sourceKind,c.id+':'+c.importedSetDigest];
 }));
 t.mock.method(historyCoverage,'readObservationCoverage',async(_client:unknown,_userId:string,kind:historyCoverage.ObservationKind)=>({knowledge:'KNOWN',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',count:'0',cutoff,version:changed&&kind==='HISTORICAL_PAYMENT'?versions.get(kind)!.slice(0,-64)+createHash('sha256').update('changed-payment-set').digest('hex'):versions.get(kind)!} as const));
 try{
  assert.equal([...versions.values()].join(':').length,614,'use the real persisted ID and set-digest lengths');
  const q={limit:1,cursor:null,bucket:'ALL' as const,projectionVersion:2 as const},first=await readPersonalFinanceEntries(f.c,actor,q,key);
  assert.equal(first.listCoverage.knowledge,'KNOWN');assert(first.listCoverage.version!.length<=256);
  assert.deepEqual(parseWalletEntryListCoverage(first.listCoverage,first.totals.count),first.listCoverage);
  assert(first.nextCursor);changed=true;
  const next=await readPersonalFinanceEntries(f.c,actor,q,key);assert.notEqual(next.listCoverage.version,first.listCoverage.version);
  assert.deepEqual(parseWalletEntryListCoverage(next.listCoverage,next.totals.count),next.listCoverage);
  await assert.rejects(readPersonalFinanceEntries(f.c,actor,{...q,cursor:first.nextCursor},key),(error:any)=>error.status===409);
 }finally{f.close();}
});

test('five proved native history absences keep the original NATIVE_GENESIS version accepted by the wallet parser',async t=>{
 const f=fixture(),query=f.c.query;
 t.mock.method(f.c,'query',async(sql:string,args:unknown[]=[])=>sql.startsWith('SELECT c.origin')?{rows:[{origin:'NATIVE_GENESIS',coverageVersion:'1'}],rowCount:1}:query(sql,args));
 t.mock.method(historyCoverage,'hasProvedNativeHistoryAbsence',async()=>true);
 t.mock.method(historyCoverage,'readObservationCoverage',async()=>{throw new Error('proved native history must not claim a legacy coverage');});
 const money={currency:'CNY',unit:'cent',knowledge:'KNOWN',amountCents:'0'};
 t.mock.method(nativeWallet,'readNativeWalletBuckets',async()=>({available:money,reserved:money,pendingEarnings:money,refundPayable:money,restricted:{...money,knowledge:'UNKNOWN',amountCents:null}} as never));
 try{
  const page=await readPersonalFinanceEntries(f.c,actor,{limit:20,cursor:null,bucket:'ALL',projectionVersion:2},key);
  assert.equal(page.listCoverage.reason,'PROVED_NATIVE_HISTORY_ABSENCE');assert.equal(page.listCoverage.version,'NATIVE_GENESIS');
  assert.deepEqual(parseWalletEntryListCoverage(page.listCoverage,page.totals.count),page.listCoverage);
 }finally{f.close();}
});

test('v2 source payment/refund/distribution/withdrawal records are readable in the same timeline/detail without changing wallet totals or leaking raw fields',async()=>{
 const f=fixture();try{
  const insert=f.db.prepare('INSERT INTO zzsh_order.personal_finance_observation VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(const [kind,entity]of [['HISTORICAL_PAYMENT','la_pay_order'],['HISTORICAL_REFUND','la_refund_record'],['HISTORICAL_DISTRIBUTION','la_distribution_order'],['HISTORICAL_WITHDRAWAL','la_withdraw_apply']])insert.run(kind!,'u1',at,at,JSON.stringify({amount:'12.34',action:1,sourceStatus:1,sourceNumber:'ORIGINAL-'+kind,sourceOrderType:'1',sourceRatio:'7.00',level:3,sourcePaidAt:'1779469900',referenceType:'LEGACY_UNRESOLVED',rawSource:{canonical:'PRIVATE remark extra'}}),0,kind!,'11','LEGACY_MYSQL','legacy_mysql_restore',entity!,null,'digest','11');
  const before=await readPersonalFinanceEntries(f.c,actor,{limit:100,cursor:null,bucket:'ALL'},key);
  const page=await readPersonalFinanceEntries(f.c,actor,{limit:100,cursor:null,bucket:'ALL',projectionVersion:2},key);
  // U-2: a zero-amount source record (affectsCurrentWallet=false, deltaCents=0) is evidence, not a wallet
  // movement, so it leaves the visible list while its detail read keeps every field.
  assert.equal(page.items.filter(row=>row.kind==='HISTORICAL').length,0);
  const sources=await Promise.all(['HISTORICAL_PAYMENT','HISTORICAL_REFUND','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL'].map(id=>readPersonalFinanceEntry(f.c,'u1','history:'+id,2).then(result=>result.entry)));
  assert.equal(sources.length,4);
  assert.equal(page.totals.byBucket.find(b=>b.bucket==='AVAILABLE')!.postedNetCents,before.totals.byBucket.find(b=>b.bucket==='AVAILABLE')!.postedNetCents);
  assert.equal(page.totals.byBucket.find(b=>b.bucket==='AVAILABLE')!.uncoveredHistoricalNetCents,'0');
  for(const row of sources){assert.equal(row.deltaCents,'0');assert.equal(row.kind,'HISTORICAL');assert.equal(row.sourceDetails!.recordedAmountCents,'1234');assert.equal(row.sourceDetails!.affectsCurrentWallet,false);assert.equal(row.postedAt,null);assert.equal(row.sourceDetails!.channelArrival,'UNKNOWN');assert.equal(row.sourceDetails!.originalLevel,'3');const detail=await readPersonalFinanceEntry(f.c,'u1',row.id,2);assert.deepEqual(detail.entry.sourceDetails,row.sourceDetails);}
  assert(!JSON.stringify(page).includes('PRIVATE'));assert(!JSON.stringify(page).includes('rawSource'));
  await assert.rejects(readPersonalFinanceEntry(f.c,'u2','history:HISTORICAL_PAYMENT',2),(e:any)=>e.status===404);
 }finally{f.close();}
});

test('refund list/detail project each original attempt without leaking restricted messages, operators or another source subject',async()=>{
 const f=fixture();try{
  const attempt={sourceEntity:'la_refund_log',sourceId:'7',sourceRecordId:'11',sourceNumber:'TRY-1',sourceStatus:'0',amountCents:'200',createdEpoch:'1779469800',updatedEpoch:'1779469900',subjectMatchesParent:true,legacyOperatorId:'PRIVATE-OPERATOR',messageSha256:'PRIVATE-RESTRICTED-HASH',restrictedSourceRef:'PRIVATE-RESTRICTED-REF'};
  const insert=f.db.prepare('INSERT INTO zzsh_order.personal_finance_observation VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');insert.run('refund-with-attempts','u1',at,at,JSON.stringify({amount:'2.00',sourceStatus:1,sourceNumber:'REFUND',sourceAttempts:[attempt,{...attempt,sourceId:'8',sourceNumber:'PRIVATE-FOREIGN-NUMBER',subjectMatchesParent:false}],sourceRefundFlags:['MULTIPLE_REFUND_RECORDS_FOR_TYPED_ORDER']}),0,'HISTORICAL_REFUND','11','LEGACY_MYSQL','legacy_mysql_restore','la_refund_record',null,'digest','11');
  const page=await readPersonalFinanceEntries(f.c,actor,{limit:100,cursor:null,bucket:'ALL',projectionVersion:2},key);
  // U-2: the zero-amount refund observation is not a listed movement; its detail keeps every attempt.
  assert.equal(page.items.some(r=>r.id==='history:refund-with-attempts'),false);
  const row=(await readPersonalFinanceEntry(f.c,'u1','history:refund-with-attempts',2)).entry;
  assert.equal(row.sourceDetails!.attempts.length,2);assert.equal(row.sourceDetails!.attempts[0]!.originalStatus,'0');assert.equal(row.sourceDetails!.attempts[0]!.originalNumber,'TRY-1');assert.equal(row.sourceDetails!.attempts[0]!.recordedAmountCents,'200');assert.equal(row.sourceDetails!.attempts[1]!.recordedAmountCents,null);assert.equal(row.deltaCents,'0');
  const detail=await readPersonalFinanceEntry(f.c,'u1',row.id,2);assert.deepEqual(detail.entry.sourceDetails,row.sourceDetails);assert(!JSON.stringify(page).includes('PRIVATE'));
 }finally{f.close();}
});

test('authoritative postedAt is additive: native event/posting and history clocks never replace the v1/v2 sort clock',async()=>{
 const f=fixture();try{
  assert.equal(FINANCE_LEDGER_POSTED_AT_SQL,'CASE WHEN l.finance_event_id IS NOT NULL THEN e.created_at ELSE p.posted_at END');
  f.db.exec(`DELETE FROM zzsh_order.settlement_ledger_entry;
   INSERT INTO zzsh_order.finance_event VALUES('event','SETTLEMENT',NULL,'2026-10-15T16:00:00.000000Z'),('opening-event','OPENING',NULL,'2026-10-15T16:00:00.000000Z');
   INSERT INTO zzsh_order.settlement_posting VALUES('posting','order','2026-10-14T15:59:59.999000Z');
   INSERT INTO zzsh_order.settlement_ledger_entry VALUES
    ('event-line','2026-10-15T15:59:59.999000Z','WALLET_AVAILABLE','100','0','u1','event','posting','{}'),
    ('posting-line','2026-10-15T16:00:00.001000Z','WALLET_AVAILABLE','200','0','u1',NULL,'posting','{}'),
    ('orphan-event','2026-10-15T16:00:00.002000Z','WALLET_AVAILABLE','300','0','u1','missing','posting','{}'),
    ('opening-line','2026-10-15T16:00:00.003000Z','WALLET_AVAILABLE','400','0','u1','opening-event','posting','{}');
   INSERT INTO zzsh_order.personal_finance_observation VALUES
    ('history-line','u1','2026-06-01T01:00:00.000000Z','2026-10-15T22:00:00.000000Z','{"amount":"7.00","action":1,"leftAmount":"7.00"}',0,'HISTORICAL_EARNINGS_LOG','1','LEGACY_MYSQL','legacy','la_log_earnings',NULL,'digest','11');`);
  for(const projectionVersion of [1,2] as const){
   const page=await readPersonalFinanceEntries(f.c,actor,{limit:100,cursor:null,bucket:'ALL',...(projectionVersion===2?{projectionVersion:2 as const}:{})},key);
   // U-2: the opening basis row (sourceKind=OPENING) never enters the user-visible list; the clocks of all other rows are unchanged.
   assert.deepEqual(page.items.map(item=>item.id),['ledger:orphan-event','ledger:posting-line','ledger:event-line','history:history-line']);
   assert.equal(page.items.some(item=>item.id==='ledger:opening-line'),false,'opening basis rows stay out of the wallet list');
   assert.equal(page.totals.byBucket.reduce((n:bigint,row:any)=>n+BigInt(row.count),0n),4n,'opening rows are excluded from the totals on the same snapshot');
   const [orphan,posting,event,history]=page.items;
   assert.equal(orphan!.postedAt,null,'missing finance_event never falls back to a joined posting or the line time');
   assert.equal(posting!.postedAt,'2026-10-14T15:59:59.999000Z');
   assert.equal(event!.postedAt,'2026-10-15T16:00:00.000000Z','finance_event wins when both joins exist');
   assert.equal(event!.occurredAt,'2026-10-15T15:59:59.999000Z');assert.equal(event!.recordedAt,event!.occurredAt);
   assert.equal(history!.postedAt,history!.occurredAt);assert.equal(history!.recordedAt,history!.importedAt);
   assert.equal(page.snapshotVersion,'5:9:1');
   for(const item of page.items){const detail=await readPersonalFinanceEntry(f.c,'u1',item.id,projectionVersion);assert.equal(detail.entry.postedAt,item.postedAt);assert.equal(detail.entry.recordedAt,item.recordedAt);}
   const first=await readPersonalFinanceEntries(f.c,actor,{limit:1,cursor:null,bucket:'ALL',...(projectionVersion===2?{projectionVersion:2 as const}:{})},key);
   const cursor=JSON.parse(Buffer.from(first.nextCursor!.split('.')[0]!,'base64url').toString());
   assert.equal(cursor.audience,'personal-finance.read.v1');assert.equal(cursor.position.at,'2026-10-15T16:00:00.002000Z');
   const next=await readPersonalFinanceEntries(f.c,actor,{limit:1,cursor:first.nextCursor,bucket:'ALL',...(projectionVersion===2?{projectionVersion:2 as const}:{})},key);
   assert.equal(next.items[0]!.id,'ledger:posting-line');
  }
 }finally{f.close();}
});
test('v1 fixed two-bucket ALL remains unchanged; v2 lists only spendable movements while reserved/pending stay readable as their own details',async()=>{
 const f=fixture();try{
  for(const q of ['', 'projectionVersion=1']){const r=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams(q)),key);assert.equal(r.items.length,2);assert.deepEqual(r.items.map(i=>i.bucket).sort(),['AVAILABLE','REFUND_PAYABLE']);assert.equal('projectionVersion' in r,false);}
  // U-1/U-3: the RESERVED hold and the PENDING_EARNINGS accrual are internal counter-legs, not wallet movements, so v2 lists the same two spendable buckets as v1.
  const r=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams('projectionVersion=2')),key);assert.equal(r.projectionVersion,2);assert.equal(r.items.length,2);assert.deepEqual(r.totals.byBucket.map(t=>t.bucket).sort(),['AVAILABLE','REFUND_PAYABLE']);assert.equal((r.totals as any).postedNetCents,undefined);
  // The bucket filter still parses and still scopes to the posted ledger, but a hold leg is not a listed movement.
  const reserved=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams('projectionVersion=2&bucket=RESERVED')),key);assert.equal(reserved.listCoverage.scope,'POSTED_LEDGER_ONLY');assert.equal(reserved.listCoverage.count,'0');assert.equal(reserved.items.length,0);
  await assert.rejects(readPersonalFinanceEntry(f.c,'u1','ledger:reserved'),(e:any)=>e.status===404);const detail=await readPersonalFinanceEntry(f.c,'u1','ledger:reserved',2);assert.equal(detail.projectionVersion,2);assert.equal(detail.entry.bucket,'RESERVED');assert.equal(detail.entry.deltaCents,'30');await assert.rejects(readPersonalFinanceEntry(f.c,'u1','ledger:foreign',2),(e:any)=>e.status===404);
  for(const q of ['bucket=RESERVED','projectionVersion=1&bucket=PENDING_EARNINGS','projectionVersion=3','projectionVersion=2&projectionVersion=2'])assert.throws(()=>parseFinanceQuery(new URLSearchParams(q)),(e:any)=>e.status===400);
 }finally{f.close();}
});
test('wallet cursors bind exact projection, bucket, subject and session; missing history is not global known empty',async()=>{
 const f=fixture();try{const q={limit:1,cursor:null,bucket:'ALL' as const},v1=await readPersonalFinanceEntries(f.c,actor,q,key),v2=await readPersonalFinanceEntries(f.c,actor,{...q,projectionVersion:2},key);assert(v1.nextCursor&&v2.nextCursor);assert.equal(v1.listCoverage.knowledge,'UNKNOWN');
  for(const [query,a]of [[{...q,projectionVersion:2,cursor:v1.nextCursor},actor],[{...q,cursor:v2.nextCursor},actor],[{...q,projectionVersion:2,cursor:v2.nextCursor},{...actor,sessionId:'other'}],[{...q,projectionVersion:2,cursor:v2.nextCursor},{...actor,userId:'u2'}]] as const)await assert.rejects(readPersonalFinanceEntries(f.c,a,query as any,key),(e:any)=>e.status===409);
  const next=await readPersonalFinanceEntries(f.c,actor,{...q,projectionVersion:2,cursor:v2.nextCursor},key);assert.notEqual(next.items[0]!.id,v2.items[0]!.id);
 }finally{f.close();}
});
test('actual mounted wallet handler decodes qualified IDs once, keeps list/detail versions and rejects unknown versions and unsafe paths',async()=>{
 const f=fixture(),handlers=new Map<string,any>();mountPersonalFinanceRead({getHttpAdapter:()=>({getInstance:()=>({use:(path:string,handler:any)=>handlers.set(path,handler)})})} as any,{pool:f.pool,listingCursorKey:key,userAuth:{api:{getSession:async()=>({user:{id:'u1'},session:{id:'s1'}})}},apiOrigin:'http://127.0.0.1:3102',userOrigin:'http://127.0.0.1:3100'} as any);
 const call=async(path:string)=>{const r:any={statusCode:0,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:any){this.body=body;this.headersSent=true;}};await handlers.get('/api/v1/users/me/wallet')({method:'GET',originalUrl:'/api/v1/users/me/wallet'+path,headers:{origin:'http://127.0.0.1:3100','x-user-id':'u2'}},r);return r;};
 try{for(const path of ['/entries/ledger%3Areserved?projectionVersion=2','/entries/ledger:reserved?projectionVersion=2']){const r=await call(path);assert.equal(r.statusCode,200);assert.equal(r.body.subjectId,'u1');assert.equal(r.body.entry.bucket,'RESERVED');assert.equal(r.body.projectionVersion,2);}
  // U-3: the accrual leg stays in the distribution module, never in the wallet entry list.
  assert.equal((await call('/entries?projectionVersion=2&bucket=PENDING_EARNINGS')).body.items.length,0);
  for(const path of ['/entries?projectionVersion=3','/entries/ledger%3Areserved?projectionVersion=3','/entries/ledger%3Areserved?projectionVersion=2&state=ALL'])assert.equal((await call(path)).statusCode,400);
  for(const path of ['/entries/ledger%253Areserved?projectionVersion=2','/entries/ledger%3Areserved%2Fforeign?projectionVersion=2','/entries/ledger%3Areserved%5Cforeign?projectionVersion=2'])assert.equal((await call(path)).statusCode,404);
  assert(f.seen.some(q=>q.sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));assert(!f.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 }finally{f.close();}
});




