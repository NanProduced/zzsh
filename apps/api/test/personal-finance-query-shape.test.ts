import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readPersonalFinanceEntries,readPersonalFinanceEntry} from '../src/finance/personal-finance-read';
import {readObservationCoverage} from '../src/finance/personal-finance-coverage';
import {readControlledWithdrawalsInTransaction} from '../src/finance/controlled-withdrawal-store';

const at='2026-10-15T00:00:00.000000Z',asOf='2026-10-16T00:00:00.000000Z',actor={userId:'u1',sessionId:'s1',requestId:'req_shape'},key={keyId:'shape',secret:'y'.repeat(40)};
/** Recording shell; each probe installs its own query behavior and keeps the captured traffic. */
function walletShell(){
 const seen:{sql:string;args:any[]}[]=[];
 const client={query:async(_sql:string,_args:any[]=[])=>({rows:[] as any[]}),release(){}};
 return{seen,client};
}

test('entries list issues one statement with one entries materialization carrying totals and page together',async()=>{
 const totals=[{bucket:'AVAILABLE',count:'3',postedNetCents:'100',coveredHistoricalNetCents:'0',uncoveredHistoricalNetCents:'-20',coveredCount:'0',uncoveredCount:'1'}];
 const base={at,imported_at:at,kind:'POSTED',included:false,source_kind:'NATIVE_SETTLEMENT',source_type:'NATIVE',source_system:'zzsh',source_entity:'settlement_posting',source_id:'s',balance_after:null,business_type:'RENTAL_ORDER',business_id:'o',business_no:null,sort_at:at};
 const page=[{...base,id:'ledger:c',bucket:'AVAILABLE',delta:'100'},{...base,id:'ledger:b',bucket:'AVAILABLE',delta:'-20'}];
 const shell=walletShell();
 shell.client.query=async(sql:string,args:any[]=[])=>{shell.seen.push({sql,args});
  if(sql.includes('to_regclass'))return{rows:[{ready:true,installed:false}]};
  if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};
  if(sql.includes('AS available'))return{rows:[{available:'0'}]};
  if(sql.includes('page_json'))return{rows:[{totals_json:JSON.stringify(totals),page_json:JSON.stringify(page)}]};
  if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{at:asOf}]};
  return{rows:[]};};
 const result=await readPersonalFinanceEntries(shell.client as any,actor,{limit:20,cursor:null,bucket:'ALL'},key);
 const statements=shell.seen.filter(q=>q.sql.includes('WITH entries'));
 assert.equal(statements.length,1,'entries CTE must be built exactly once per list read');
 assert(statements[0]!.sql.includes('GROUP BY bucket')&&statements[0]!.sql.includes('LIMIT $6'),'totals and page ride the same statement');
 assert(statements[0]!.sql.includes(`o.source_kind='HISTORICAL_EARNINGS_LOG' AND o.source_entity='la_log_earnings'`),'history branch carries the exact kind/entity pair');
 assert.equal(result.items.length,2);assert.equal(result.totals.count,'3');assert.equal(result.totals.byBucket[0]!.uncoveredHistoricalNetCents,'-20');
 assert.deepEqual(result.items.map(i=>i.id),['ledger:c','ledger:b']);
});

test('totals survive an empty keyset page and stay on the same statement',async()=>{
 const totals=[{bucket:'AVAILABLE',count:'7',postedNetCents:'5',coveredHistoricalNetCents:'0',uncoveredHistoricalNetCents:'0',coveredCount:'0',uncoveredCount:'0'}];
 const shell=walletShell();
 shell.client.query=async(sql:string,args:any[]=[])=>{shell.seen.push({sql,args});
  if(sql.includes('to_regclass'))return{rows:[{ready:true,installed:false}]};
  if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};
  if(sql.includes('AS available'))return{rows:[{available:'0'}]};
  if(sql.includes('page_json'))return{rows:[{totals_json:JSON.stringify(totals),page_json:'[]'}]};
  if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{at:asOf}]};
  return{rows:[]};};
 const result=await readPersonalFinanceEntries(shell.client as any,actor,{limit:1,cursor:null,bucket:'AVAILABLE'},key);
 assert.equal(result.items.length,0);assert.equal(result.totals.count,'7');assert.equal(result.nextCursor,null);
 assert.equal(result.totals.historicalCoverage,'NO_HISTORY');
});

test('detail reads route by exact id prefix to their own branch without scanning the union',async()=>{
 const seen:{sql:string;args:any[]}[]=[];
 const row={id:'ledger:x',at,imported_at:at,bucket:'AVAILABLE',delta:'5',kind:'POSTED',included:false,source_kind:'NATIVE_SETTLEMENT',source_type:'NATIVE',source_system:'zzsh',source_entity:'settlement_posting',source_id:'s',balance_after:null,business_id:null,business_no:null,business_type:'UNKNOWN'};
 const client={async query(sql:string,args:any[]=[]){seen.push({sql,args});
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};
  if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};
  if(sql.includes('AS available'))return{rows:[{available:'0'}]};
  if(sql.includes(`'ledger:'||l.id`))return{rows:args[1]==='x'?[row]:[]};
  if(sql.includes(`'history:'||o.id`))return{rows:[]};
  return{rows:[]};}};
 const detail=await readPersonalFinanceEntry(client as any,'u1','ledger:x');
 assert.equal(detail.entry.id,'ledger:x');assert.equal(detail.entry.deltaCents,'5');
 const ledgerSql=seen.find(q=>q.sql.includes(`'ledger:'||l.id`))!.sql;
 assert(ledgerSql.includes('AND l.id=$2')&&!ledgerSql.includes('UNION ALL'),'ledger detail is a primary-key branch read');
 assert(ledgerSql.includes(`l.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE','RENTER_REFUND_PAYABLE')`)&&!ledgerSql.includes('WALLET_RESERVED'),'v1 detail keeps the v1 account set');
 const history=await readPersonalFinanceEntry(client as any,'u1','history:missing').catch(e=>e);
 assert.equal(history.status,404);
 const historySql=seen.find(q=>q.sql.includes(`'history:'||o.id`))!.sql;
 assert(historySql.includes('AND o.id=$2')&&historySql.includes(`o.source_kind='HISTORICAL_EARNINGS_LOG'`)&&!historySql.includes('UNION ALL'),'history detail is a primary-key branch read with the exact kind/entity pair');
 await assert.rejects(readPersonalFinanceEntry(client as any,'u1','other:x'),(e:any)=>e.status===404);
 assert(seen.filter(q=>q.sql.includes(`||l.id`)||q.sql.includes(`||o.id`)).every(q=>q.args[0]==='u1'),'subject binding stays the first parameter');
});

test('page rows normalize numeric included flags without accepting money shape drift',async()=>{
 const shell=walletShell();
 shell.client.query=async(sql:string,args:any[]=[])=>{shell.seen.push({sql,args});
  if(sql.includes('to_regclass'))return{rows:[{ready:true,installed:false}]};
  if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};
  if(sql.includes('AS available'))return{rows:[{available:'0'}]};
  if(sql.includes('page_json'))return{rows:[{totals_json:'[]',page_json:JSON.stringify([{id:'history:h',at,imported_at:at,bucket:'AVAILABLE',delta:'-5',kind:'HISTORICAL',included:1,source_kind:'HISTORICAL_EARNINGS_LOG',source_type:'LEGACY_MYSQL',source_system:'legacy_mysql_restore',source_entity:'la_log_earnings',source_id:'7',balance_after:'10',business_id:null,business_no:null,business_type:'LEGACY_UNRESOLVED',sort_at:at}])}]};
  if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{at:asOf}]};
  return{rows:[]};};
 const result=await readPersonalFinanceEntries(shell.client as any,actor,{limit:20,cursor:null,bucket:'ALL'},key);
 assert.equal(result.items[0]!.includedInOpening,true);
 shell.client.query=async(sql:string)=>{if(sql.includes('page_json'))return{rows:[{totals_json:'[]',page_json:JSON.stringify([{id:'ledger:z',at,imported_at:at,bucket:'AVAILABLE',delta:'1.5',kind:'POSTED',included:false,source_kind:'NATIVE_SETTLEMENT',source_type:'NATIVE',source_system:'zzsh',source_entity:'settlement_posting',source_id:'s',balance_after:null,business_id:null,business_no:null,business_type:'UNKNOWN',sort_at:at}])}]};if(sql.includes('to_regclass'))return{rows:[{ready:true,installed:false}]};if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};if(sql.includes('AS available'))return{rows:[{available:'0'}]};if(sql.includes('clock_timestamp() AT TIME ZONE'))return{rows:[{at:asOf}]};return{rows:[]};};
 await assert.rejects(readPersonalFinanceEntries(shell.client as any,actor,{limit:20,cursor:null,bucket:'ALL'},key),(e:any)=>e.status===400);
});

test('native genesis wallets run the stricter native aggregate once, never the plain one too',async()=>{
 const seen:{sql:string;args:any[]}[]=[];
 const client={async query(sql:string,args:any[]=[]){seen.push({sql,args});
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};
  if(sql.includes('FOR SHARE'))return{rowCount:1,rows:[]};
  if(sql.startsWith('SELECT c.origin,b.source_kind'))return{rows:[{origin:'NATIVE_GENESIS',source_kind:'NATIVE_GENESIS',opening_amount:'0',covered_count:0}]};
  if(sql.startsWith('SELECT c.origin,b.source_cutoff'))return{rows:[{origin:'NATIVE_GENESIS',cutoff:null,sourceDigest:null,coveredSetDigest:null,coverageVersion:'1'}]};
  if(sql.includes('AS available'))return{rows:[{available:'0',reserved:'0',pending:'0',refund:'0'}]};
  return{rows:[]};}};
 const {readPersonalWallet}=await import('../src/finance/personal-finance-read');
 const wallet=await readPersonalWallet(client as any,'u1');
 assert.equal(wallet.buckets.available.amountCents,'0');
 assert.equal(seen.filter(q=>q.sql.includes('AS available')).length,1,'native origin already implies the bucket aggregate; the plain totals scan must not repeat');
});

test('history coverage reconciliation reads its observation set in one pass',async()=>{
 const seen:{sql:string;args:any[]}[]=[];
 const client={async query(sql:string,args:any[]=[]){seen.push({sql,args});
  if(sql.includes('coverage installed'))return{rows:[{installed:false}]};
  return{rows:[]};}};
 await readObservationCoverage(client as any,'u1','HISTORICAL_WITHDRAWAL');
 const client2={async query(sql:string,args:any[]=[]){seen.push({sql,args});if(sql.includes('coverage installed'))return{rows:[{installed:true}]};return{rows:[]};}};
 await readObservationCoverage(client2 as any,'u1','HISTORICAL_EARNINGS_LOG');
 const target=seen.find(q=>q.sql.includes('finance history coverage exact target'))!.sql;
 assert.equal(target.split('FROM zzsh_order.personal_finance_observation o').length-1,1,'one scan serves all four reconciliation predicates');
 assert.equal(target.split(' FILTER(WHERE').length-1,4,'all four original predicates survive as FILTER clauses');
 assert(target.includes('ORDER BY c.source_cutoff DESC,c.id COLLATE "C" DESC LIMIT 1'),'latest-target selection unchanged');
});

/* The pre-change correlated-subquery shape, frozen here as the equivalence baseline for the derived-table rewrite. */
const legacyTargetsSql=`SELECT d.id,d.kind,d.display_mask AS mask,a.per_intent_cents::text,
 a.active AND clock_timestamp()>=a.admitted_at AND clock_timestamp()<a.expires_at
 AND NOT EXISTS(SELECT 1 FROM zzsh_order.withdrawal_intent i WHERE i.destination_id=d.id)
 AND (SELECT count(*) FROM zzsh_order.withdrawal_intent i WHERE i.admission_id=a.id)<a.max_intents
 AND (SELECT COALESCE(sum(i.gross_cents),0) FROM zzsh_order.withdrawal_intent i WHERE i.admission_id=a.id)+a.per_intent_cents<=a.max_gross_cents AS can_quote
 FROM zzsh_order.withdrawal_destination d JOIN zzsh_order.withdrawal_admission a ON a.id=d.admission_id AND a.user_id=d.user_id
 WHERE d.user_id=$1 AND d.active ORDER BY d.id`;
const currentTargetsSql=`SELECT d.id,d.kind,d.display_mask AS mask,a.per_intent_cents::text,
 a.active AND clock_timestamp()>=a.admitted_at AND clock_timestamp()<a.expires_at
 AND used.destination_id IS NULL
 AND COALESCE(it.intent_count,0)<a.max_intents
 AND COALESCE(it.intent_gross,0)+a.per_intent_cents<=a.max_gross_cents AS can_quote
 FROM zzsh_order.withdrawal_destination d JOIN zzsh_order.withdrawal_admission a ON a.id=d.admission_id AND a.user_id=d.user_id
 LEFT JOIN (SELECT admission_id,count(*) AS intent_count,COALESCE(sum(gross_cents),0) AS intent_gross FROM zzsh_order.withdrawal_intent GROUP BY admission_id) it ON it.admission_id=a.id
 LEFT JOIN (SELECT DISTINCT destination_id FROM zzsh_order.withdrawal_intent) used ON used.destination_id=d.id
 WHERE d.user_id=$1 AND d.active ORDER BY d.id`;

function withdrawalFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE withdrawal_destination(id TEXT PRIMARY KEY,kind TEXT,display_mask TEXT,user_id TEXT,admission_id TEXT,active INTEGER);
 CREATE TABLE withdrawal_admission(id TEXT PRIMARY KEY,user_id TEXT,revision INTEGER,admitted_at TEXT,expires_at TEXT,max_intents INTEGER,per_intent_cents INTEGER,max_gross_cents INTEGER,active INTEGER);
 CREATE TABLE withdrawal_intent(id TEXT PRIMARY KEY,user_id TEXT,admission_id TEXT,destination_id TEXT,gross_cents INTEGER,state TEXT);`);
 const now='2026-10-20T00:00:00.000Z';
 const insA=db.prepare('INSERT INTO withdrawal_admission VALUES(?,?,?,?,?,?,?,?,?)');
 insA.run('a1','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',3,200,1000,1);
 insA.run('a2','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',1,200,1000,1);
 insA.run('a3','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',5,200,300,1);
 insA.run('a4','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',5,200,1000,0);
 insA.run('a5','u1',1,'2026-09-01T00:00:00.000Z','2026-09-30T00:00:00.000Z',5,200,1000,1);
 insA.run('a6','u1',1,'2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',5,200,1000,1);
 insA.run('a7','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',5,200,1000,1);
 insA.run('a8','u1',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',2,200,400,1);
 const insD=db.prepare('INSERT INTO withdrawal_destination VALUES(?,?,?,?,?,?)');
 for(const [id,a]of [['d1','a1'],['d2','a1'],['d3','a2'],['d4','a3'],['d5','a3'],['d6','a4'],['d7','a5'],['d8','a6'],['d9','a7'],['d10','a8']] as const)insD.run(id,'BANK_CARD','**'+id,'u1',a,1);
 const insI=db.prepare('INSERT INTO withdrawal_intent VALUES(?,?,?,?,?,?)');
 insI.run('i1','u1','a1','d2',200,'RESERVED');
 insI.run('i2','u1','a2','other_destination',200,'SUCCEEDED');
 insI.run('i3','u1','a3','other_d3',200,'FAILED');
 insI.run('i4','u9','a9','foreign_dest',200,'RESERVED');
 insI.run('i5','u1','a8','other_d10',200,'SUBMITTING');
 const run=(sql:string)=>db.prepare(sql.replaceAll('zzsh_order.','').replaceAll('clock_timestamp()',`'${now}'`).replace(/::(?:text|timestamptz)\b/g,'').replace('$1',"'u1'")).all() as {id:string;can_quote:number}[];
 return{legacy:run(legacyTargetsSql),current:run(currentTargetsSql),close:()=>db.close()};
}

test('withdrawal destination quote gate is row-for-row equivalent to the correlated-subquery shape',async()=>{
 const seen:{sql:string;args:any[]}[]=[];
 const client={async query(sql:string,args:any[]=[]){seen.push({sql,args});
  if(sql.startsWith('SELECT d.oid::int')||sql.startsWith('SELECT current_database()'))return{rows:[{name:'zzsh_test_m2_auth_auth_compat',oid:820148,role:'zzsh_m2_auth_compat_r',marker:'zzsh:m2-auth-test:v1',complete:true}]};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}]};
  if(sql.includes('user_identity_state'))return{rows:[{accountStatus:'ACTIVE'}]};
  if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
  if(sql.includes('FROM zzsh_order.withdrawal_admission'))return{rows:[{id:'a1',revision:'1',admitted_at:new Date(at),expires_at:new Date('2026-11-01T00:00:00Z')}]};
  if(sql.includes(' AS count,md5'))return{rows:[{count:'0',digest:'d41d8cd98f00b204e9800998ecf8427e'}]};
  if(sql.startsWith('SELECT to_char'))return{rows:[{at}]};
  if(sql.includes('FROM zzsh_order.withdrawal_intent WHERE'))return{rows:[]};
  if(sql.includes('FROM zzsh_order.withdrawal_intent i JOIN'))return{rows:[{reserved:'0',paid:'0',fee:'0'}]};
  if(sql.includes('FROM zzsh_order.withdrawal_destination'))return{rows:[]};
  throw Error('Unexpected shape probe SQL: '+sql);},release(){}};
 await readControlledWithdrawalsInTransaction(client as any,actor,undefined,undefined,{limit:20,cursor:null,state:'ALL',key});
 const issued=seen.find(q=>q.sql.includes('FROM zzsh_order.withdrawal_destination'))!.sql;
 assert.equal(issued.replace(/\s+/g,' ').trim(),currentTargetsSql.replace(/\s+/g,' ').trim(),'the shipped targets query stays the verified derived-table shape');
 const f=withdrawalFixture();try{
  assert.equal(f.legacy.length,f.current.length);
  assert.deepEqual(f.current.map(r=>r.id),f.legacy.map(r=>r.id),'ordering by destination id unchanged');
  for(const [before,after]of f.legacy.map((r,n)=>[r,f.current[n]!] as const))assert.equal(Boolean(after.can_quote),Boolean(before.can_quote),`can_quote mismatch on ${before.id}`);
  const byId=Object.fromEntries(f.current.map(r=>[r.id,Boolean(r.can_quote)]));
  assert.deepEqual(byId,{d1:true,d2:false,d3:false,d4:false,d5:false,d6:false,d7:false,d8:false,d9:true,d10:true});
 }finally{f.close();}
 assert(!seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});
