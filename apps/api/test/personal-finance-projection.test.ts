import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readPersonalFinanceEntries,readPersonalFinanceEntry,parseFinanceQuery,decodeFinanceEntryId,FINANCE_LEDGER_POSTED_AT_SQL} from '../src/finance/personal-finance-read';
import {mountPersonalFinanceRead} from '../src/finance/personal-finance-routes';
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
 const translate=(sql:string)=>sql.replace(/to_char\((at|imported_at|posted_at|recorded_at) AT TIME ZONE 'UTC','[^']*'\)/g,'$1').replace(/::numeric\(24,0\)/g,'').replace(/::(?:text|numeric|timestamptz)\b/g,'').replaceAll("o.snapshot->>'action'","CAST(o.snapshot->>'action' AS TEXT)").replaceAll(' COLLATE "C"','').replaceAll('json_build_object(','json_object(').replaceAll('json_agg(','json_group_array(');
 const mapRow=(r:Record<string,any>)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='included'?Boolean(v):v!==null&&['delta','balance_after','count','postedNetCents','coveredHistoricalNetCents','uncoveredHistoricalNetCents','coveredCount','uncoveredCount'].includes(k)?String(v):v]));
 const query=async(sql:string,args:any[]=[])=>{seen.push({sql,args});
  if(sql.startsWith('WITH entries')||sql.startsWith(`SELECT 'ledger:'||`)||sql.startsWith(`SELECT 'history:'||`)){
   const rows=db.prepare(translate(sql)).all(Object.fromEntries(args.map((v,i)=>['$'+(i+1),v]))) as Record<string,any>[];
   if(sql.includes('page_json')){
    const bundle=rows[0] as any,fix=(j:string,keys:string[])=>JSON.stringify((JSON.parse(j) as any[]).map(o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,keys.includes(k)&&v!==null?String(v):v]))));
    return{rows:[{totals_json:fix(bundle.totals_json,['count','postedNetCents','coveredHistoricalNetCents','uncoveredHistoricalNetCents','coveredCount','uncoveredCount']),page_json:fix(bundle.page_json,['delta','balance_after'])}],rowCount:1};
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

test('authoritative postedAt is additive: native event/posting and history clocks never replace the v1/v2 sort clock',async()=>{
 const f=fixture();try{
  assert.equal(FINANCE_LEDGER_POSTED_AT_SQL,'CASE WHEN l.finance_event_id IS NOT NULL THEN e.created_at ELSE p.posted_at END');
  f.db.exec(`DELETE FROM zzsh_order.settlement_ledger_entry;
   INSERT INTO zzsh_order.finance_event VALUES('event','OPENING',NULL,'2026-10-15T16:00:00.000000Z');
   INSERT INTO zzsh_order.settlement_posting VALUES('posting','order','2026-10-14T15:59:59.999000Z');
   INSERT INTO zzsh_order.settlement_ledger_entry VALUES
    ('event-line','2026-10-15T15:59:59.999000Z','WALLET_AVAILABLE','100','0','u1','event','posting','{}'),
    ('posting-line','2026-10-15T16:00:00.001000Z','WALLET_AVAILABLE','200','0','u1',NULL,'posting','{}'),
    ('orphan-event','2026-10-15T16:00:00.002000Z','WALLET_AVAILABLE','300','0','u1','missing','posting','{}');
   INSERT INTO zzsh_order.personal_finance_observation VALUES
    ('history-line','u1','2026-06-01T01:00:00.000000Z','2026-10-15T22:00:00.000000Z','{"amount":"7.00","action":1,"leftAmount":"7.00"}',0,'HISTORICAL_EARNINGS_LOG','1','LEGACY_MYSQL','legacy','la_log_earnings',NULL,'digest','11');`);
  for(const projectionVersion of [1,2] as const){
   const page=await readPersonalFinanceEntries(f.c,actor,{limit:100,cursor:null,bucket:'ALL',...(projectionVersion===2?{projectionVersion:2 as const}:{})},key);
   assert.deepEqual(page.items.map(item=>item.id),['ledger:orphan-event','ledger:posting-line','ledger:event-line','history:history-line']);
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
test('v1 fixed two-bucket ALL remains unchanged; explicit v2 lists and details expose reserved/pending only as their own ledger buckets',async()=>{
 const f=fixture();try{
  for(const q of ['', 'projectionVersion=1']){const r=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams(q)),key);assert.equal(r.items.length,2);assert.deepEqual(r.items.map(i=>i.bucket).sort(),['AVAILABLE','REFUND_PAYABLE']);assert.equal('projectionVersion' in r,false);}
  const r=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams('projectionVersion=2')),key);assert.equal(r.projectionVersion,2);assert.equal(r.items.length,4);assert.deepEqual(r.totals.byBucket.map(t=>t.bucket).sort(),['AVAILABLE','PENDING_EARNINGS','REFUND_PAYABLE','RESERVED']);assert.equal((r.totals as any).postedNetCents,undefined);
  const reserved=await readPersonalFinanceEntries(f.c,actor,parseFinanceQuery(new URLSearchParams('projectionVersion=2&bucket=RESERVED')),key);assert.equal(reserved.listCoverage.scope,'POSTED_LEDGER_ONLY');assert.equal(reserved.listCoverage.count,'1');assert.equal(reserved.items[0]!.deltaCents,'30');
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
  assert.equal((await call('/entries?projectionVersion=2&bucket=PENDING_EARNINGS')).body.items[0].bucket,'PENDING_EARNINGS');
  for(const path of ['/entries?projectionVersion=3','/entries/ledger%3Areserved?projectionVersion=3','/entries/ledger%3Areserved?projectionVersion=2&state=ALL'])assert.equal((await call(path)).statusCode,400);
  for(const path of ['/entries/ledger%253Areserved?projectionVersion=2','/entries/ledger%3Areserved%2Fforeign?projectionVersion=2','/entries/ledger%3Areserved%5Cforeign?projectionVersion=2'])assert.equal((await call(path)).statusCode,404);
  assert(f.seen.some(q=>q.sql==='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));assert(!f.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 }finally{f.close();}
});
