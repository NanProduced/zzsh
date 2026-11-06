import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {
  assertOpeningConservation,assertOpeningLedgerClosure,authorizeMaintenanceBatch,closeMaintenanceBatch,
} from '../src/finance/personal-finance-maintenance';

const sha=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex');
const actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'};
const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_guar_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};

type Query={sql:string;args:any[]};
function client(options:{now?:string;identity?:boolean;ledger?:Record<string,string>;owner?:string}={}){
  const state={queries:[] as Query[],now:options.now??'2026-10-15T08:30:00.000Z',identity:options.identity!==false,ledger:options.ledger??{}};
  const query=async(sql:string,args:any[]=[])=>{
    state.queries.push({sql,args});
    if(sql.includes('finance-opening resource'))return{rows:[{...resource,now:state.now,tableOwner:options.owner??resource.role}],rowCount:1};
    if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:state.identity?[{locked:false,twoFactorEnabled:true}]:[],rowCount:state.identity?1:0};
    if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
    if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
    if(sql.includes('batch window head')||sql.includes('batch window tail'))return{rows:[{at:state.now}],rowCount:1};
    if(sql.includes('opening ledger closure gate'))return{rows:[state.ledger],rowCount:1};
    return{rows:[],rowCount:1};
  };
  return{state,c:{query,connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role}} as any};
}
function review(overrides:Record<string,unknown>={}){
  return{ref:'FIXTURE-NOT-APPROVAL',attempt:'fixture-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource,notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',...overrides} as any;
}

test('batch authorization runs the full gate once and records the window',async()=>{
  const f=client(),w=await authorizeMaintenanceBatch(f.c,actor,[review(),review(),review()]);
  assert.equal(w.authorizedAt,'2026-10-15T08:30:00.000Z');
  assert.equal(w.windowExpiresAt,'2026-10-15T09:00:00.000Z');
  const headCost=f.state.queries.length;
  const tail=await closeMaintenanceBatch(f.c,actor,review());
  assert.equal(tail.closedAt,'2026-10-15T08:30:00.000Z');
  const tailCost=f.state.queries.length-headCost;
  // 成本与批大小无关：50 个对象与 3 个对象的鉴权开销必须完全相同
  const big=client();
  await authorizeMaintenanceBatch(big.c,actor,Array.from({length:50},()=>review()));
  assert.equal(big.state.queries.length,headCost);
  // 整批鉴权是常数开销（一次资源/身份校验 + 一次窗口读取），不是每对象一次
  assert.ok(headCost>0&&headCost<=8,`unexpected batch authorization cost ${headCost}`);
  assert.ok(tailCost>0&&tailCost<=8,`unexpected batch close cost ${tailCost}`);
});

test('a batch whose objects do not share actor, resource or window is rejected before any SQL',async()=>{
  for(const change of [{resource:{...resource,role:'other_role'}},{actor:{userId:'other',sessionId:actor.sessionId}},{expiresAt:'2026-10-15T10:00:00.000Z'}]){
    const f=client();
    await assert.rejects(authorizeMaintenanceBatch(f.c,actor,[review(),review(change)]),(e:any)=>e.status===409);
    assert.equal(f.state.queries.length,0);
  }
});

test('an expired or wrong-role window rejects the tail so the whole batch rolls back',async()=>{
  const expired=client({now:'2026-10-15T09:00:00.000Z'});
  await assert.rejects(closeMaintenanceBatch(expired.c,actor,review()),(e:any)=>e.status===403);
  const wrongOwner=client({owner:'someone_else'});
  await assert.rejects(authorizeMaintenanceBatch(wrongOwner.c,actor,[review()]),(e:any)=>e.status===409);
  const unauthenticated=client({identity:false});
  await assert.rejects(authorizeMaintenanceBatch(unauthenticated.c,actor,[review()]),(e:any)=>e.status===401);
});

test('the conservation gate fails when the ledger total or the OPENING row count drifts',async()=>{
  const ok=client({ledger:{basisCents:'7500992',positiveSubjects:'633',ledgerCents:'7500992',entryRows:'1266'}});
  const pass=await assertOpeningConservation(ok.c,{amountCents:'7500992',entryRows:1266});
  assert.equal(pass.entryRows,1266);assert.equal(pass.positiveSubjects,633);

  // 有人删掉分录：basis 还在，但账本加总为 0 → 必须 fail
  const deleted=client({ledger:{basisCents:'7500992',positiveSubjects:'633',ledgerCents:'0',entryRows:'0'}});
  await assert.rejects(assertOpeningLedgerClosure(deleted.c),(e:any)=>e.status===409);

  // 分录数少一半（只留借方）→ 必须 fail
  const half=client({ledger:{basisCents:'7500992',positiveSubjects:'633',ledgerCents:'7500992',entryRows:'633'}});
  await assert.rejects(assertOpeningLedgerClosure(half.c),(e:any)=>e.status===409);

  // 与冻结期望不一致（换成别的数据集数字）→ 必须 fail
  const other=client({ledger:{basisCents:'100',positiveSubjects:'1',ledgerCents:'100',entryRows:'2'}});
  await assert.rejects(assertOpeningConservation(other.c,{amountCents:'7500992',entryRows:1266}),(e:any)=>e.status===409);

  // 期望值本身不合法 → 直接拒
  await assert.rejects(assertOpeningConservation(ok.c,{amountCents:'-1',entryRows:1266}));
});

test('the conservation gate is dataset-independent: any basis/ledger mismatch fails',async()=>{
  const mismatch=client({ledger:{basisCents:'500',positiveSubjects:'2',ledgerCents:'499',entryRows:'4'}});
  await assert.rejects(assertOpeningLedgerClosure(mismatch.c),(e:any)=>e.status===409);
  const zero=client({ledger:{basisCents:'0',positiveSubjects:'0',ledgerCents:'0',entryRows:'0'}});
  assert.equal((await assertOpeningLedgerClosure(zero.c)).entryRows,0);
});
