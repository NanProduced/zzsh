import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {mountPersonalFinanceRead} from '../src/finance/personal-finance-routes';
import {projectUnifiedGuaranteeEvent,readUnifiedOwnerGuaranteeHistory} from '../src/finance/owner-guarantee-unified-read';

const at='2026-10-15T00:00:00.000000Z',actor={userId:'owner',sessionId:'session'},key={keyId:'fixture',secret:'x'.repeat(40)},sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const native=(id='p1',kind='PAYMENT_ATTEMPT'):any=>({id:'native:'+(kind==='REQUIREMENT'?'requirement':kind==='REFUND_ATTEMPT'?'refund':'payment')+':'+id,occurredAt:at,recordedAt:at,sortAt:at,sourceCanonical:null,sourceDigest:null,payload:{sourceType:'NATIVE',eventKind:kind,sourceEntity:kind==='REQUIREMENT'?'owner_guarantee_requirement':kind==='REFUND_ATTEMPT'?'owner_guarantee_refund':'owner_guarantee_payment',sourceId:id,requirementId:kind==='REQUIREMENT'?id:'req1',requirementStatus:'COVERED',requiredCents:'500',accountId:'account101',accountNumber:'NATIVE-ACCOUNT',amountCents:'500',attemptStatus:'REQUESTED',providerState:'NOT_AUTHORIZED',merchantOrderNumber:'NATIVE-PAYMENT',paymentId:'p1',releasePolicyState:'OWNER_DECISION_REQUIRED',financeEventId:null,ledgerEntryRef:null,postedAt:null,postingValid:false,postedAmountCents:'500'}});
function fixture(size=3){
 const state={items:[...Array.from({length:size},(_,i)=>native('p'+String(i).padStart(3,'0')))],ready:true,fail:null as Error|null};const queries:{sql:string;params:any[]}[]=[];
 const client={query:async(sql:string,params:any[]=[])=>{queries.push({sql,params});
  if(sql.includes('owner guarantee history schema'))return{rows:[{ready:state.ready}]};
  if(sql.includes('posted held only'))return{rows:[{held:'500'}]};
  if(sql.includes('owner guarantee history v2')){if(state.fail)throw state.fail;const all=[...state.items].sort((a,b)=>b.sortAt.localeCompare(a.sortAt)||b.id.localeCompare(a.id));const visible=all.filter(r=>!params[2]||r.sortAt<params[2]||r.sortAt===params[2]&&r.id<params[3]).slice(0,21);return{rows:[{total:String(all.length),native_count:String(all.length),unknown_time_count:'0',duplicate_count:String(all.length-new Set(all.map(i=>i.id)).size),digest:sha(canonicalize(all)),as_of:params[1]??at,page:visible}]};}
  if(sql.includes('clock_timestamp()'))return{rows:[{at}]};
  throw Error('unhandled guarantee fixture SQL');
 }};return{state,queries,c:client as any};
}

test('native requirement, payment and refund attempts project onto their own axes and never carry a source observation',async()=>{
 const f=fixture(0);f.state.items.unshift(native('req1','REQUIREMENT'),native(),native('f1','REFUND_ATTEMPT'));
 const p=await readUnifiedOwnerGuaranteeHistory(f.c,actor,null,key);
 assert.equal(p.contractVersion,'owner-guarantee-history.read.v2');assert.equal(p.projectionVersion,2);assert.equal(p.subjectId,actor.userId);
 assert.equal(p.coverage.knowledge,'KNOWN');assert.equal(p.coverage.count,'3');assert.equal(p.sources.native.knowledge,'KNOWN');assert.equal(p.sources.native.count,'3');
 assert.equal(p.items.length,3);assert.deepEqual(p.items.map(i=>i.eventKind).sort(),['PAYMENT_ATTEMPT','REFUND_ATTEMPT','REQUIREMENT']);
 assert(p.items.every(i=>i.source.type==='NATIVE'));assert(p.items.every(i=>i.channelArrival==='UNKNOWN'));
 const payment=p.items.find(i=>i.eventKind==='PAYMENT_ATTEMPT')!;
 assert.equal(payment.paymentAttempt!.merchantOrderNumber,'NATIVE-PAYMENT');assert.equal(payment.requirement!.requiredCents,'500');assert.equal(payment.accountNumber,'NATIVE-ACCOUNT');
 assert.equal(p.items.find(i=>i.eventKind==='REFUND_ATTEMPT')!.refundAttempt!.releasePolicyState,'OWNER_DECISION_REQUIRED');
 assert.equal(p.postedHeld.knowledge,'KNOWN');assert.equal(p.postedHeld.amountCents,'500');assert.equal(p.postedHeld.scope,'POSTED_LEDGER_ONLY');
 // 旧上架保证金观测不得出现在任何返回字段里
 assert(!JSON.stringify(p).includes('LEGACY'));
 assert(f.queries.filter(q=>q.sql.includes('history v2')||q.sql.includes('posted held')).every(q=>q.params[0]==='owner'));
 assert(!f.queries.some(q=>/^(INSERT|UPDATE|DELETE|ALTER)/.test(q.sql)));
});

test('all attempts paginate once; subject/session/version domains are bound and mutable status changes invalidate the original snapshot',async()=>{
 const f=fixture(23),one=await readUnifiedOwnerGuaranteeHistory(f.c,actor,null,key);
 assert.equal(one.items.length,20);assert(one.nextCursor);
 const two=await readUnifiedOwnerGuaranteeHistory(f.c,actor,one.nextCursor,key);
 assert.equal(two.items.length,3);assert.equal(new Set([...one.items,...two.items].map(i=>i.id)).size,23);
 await assert.rejects(readUnifiedOwnerGuaranteeHistory(f.c,{...actor,sessionId:'different'},one.nextCursor,key),(e:any)=>e.status===409);
 await assert.rejects(readUnifiedOwnerGuaranteeHistory(f.c,actor,one.nextCursor+'x',key),(e:any)=>e.status===400);
 f.state.items[0].payload.attemptStatus='PROCESSING';
 await assert.rejects(readUnifiedOwnerGuaranteeHistory(f.c,actor,one.nextCursor,key),(e:any)=>e.status===409);
});

test('duplicate native identities fail closed instead of silently collapsing a page',async()=>{
 const f=fixture(0);f.state.items=[native(),native()];
 await assert.rejects(readUnifiedOwnerGuaranteeHistory(f.c,actor,null,key),(e:any)=>e.status===503);
});

test('a missing guarantee finance schema degrades to unknown rather than a false known empty history',async()=>{
 const f=fixture(0);f.state.ready=false;
 const p=await readUnifiedOwnerGuaranteeHistory(f.c,actor,null,key);
 assert.equal(p.items.length,0);assert.equal(p.nextCursor,null);assert.equal(p.coverage.knowledge,'UNKNOWN');assert.equal(p.coverage.count,null);
 assert.equal(p.sources.native.knowledge,'UNKNOWN');assert.equal(p.postedHeld.knowledge,'UNKNOWN');assert.equal(p.channelArrival,'UNKNOWN');
});

test('native local posting requires both original references and exact valid event/ledger binding; it never proves bank arrival',()=>{
 const r=native();r.payload.attemptStatus='CONFIRMED';r.payload.providerState='CONFIRMED';Object.assign(r.payload,{financeEventId:'event1',ledgerEntryRef:'line1',postingValid:true,postedAt:at});
 const x=projectUnifiedGuaranteeEvent(r,'owner');
 assert.equal(x.localPosting!.amountCents,'500');assert.equal(x.localPosting!.postedAt,at);assert.equal(x.channelArrival,'UNKNOWN');
 for(const change of [{ledgerEntryRef:null},{postingValid:false}])assert.throws(()=>projectUnifiedGuaranteeEvent({...r,payload:{...r.payload,...change}},'owner'),(e:any)=>e.status===503);
});

test('only new-platform guarantee events are accepted: legacy source kinds and forged event ids are rejected, not reinterpreted',()=>{
 assert.throws(()=>projectUnifiedGuaranteeEvent({...native(),payload:{...native().payload,sourceType:'LEGACY_MYSQL'}},'owner'),(e:any)=>e.status===503);
 assert.throws(()=>projectUnifiedGuaranteeEvent({...native(),id:'legacy:payment:501'},'owner'),(e:any)=>e.status===503);
 assert.throws(()=>projectUnifiedGuaranteeEvent({...native(),payload:{...native().payload,eventKind:'ACCOUNT_OBSERVATION'}},'owner'),(e:any)=>e.status===503);
});

test('mounted guarantees handler serves the native v2 projection and rejects unsupported versions or caller subjects',async()=>{
 const f=fixture(1),query=f.c.query.bind(f.c),seen:string[]=[];
 f.c.query=async(sql:string,params:any[]=[])=>{
  seen.push(sql);
  if(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql))return {rows:[],rowCount:0};
  if(sql.includes('zzsh_auth_user')||sql.includes('user_identity_state'))return{rows:[{suspended:false,accountStatus:'ACTIVE'}],rowCount:1};
  return query(sql,params);
 };
 const pool={query:f.c.query,connect:async()=>({...f.c,release(){}})};let handler:any;
 mountPersonalFinanceRead({getHttpAdapter:()=>({getInstance:()=>({use:(path:string,fn:any)=>{if(path==='/api/v1/users/me/wallet')handler=fn;}})})} as any,
  {pool,listingCursorKey:key,userAuth:{api:{getSession:async()=>({user:{id:actor.userId},session:{id:actor.sessionId}})}},apiOrigin:'http://api',userOrigin:'http://user'} as any);
 const request=async(q:string)=>{const r:any={headersSent:false,statusCode:0,setHeader(){return this;},status(n:number){this.statusCode=n;return this;},json(body:any){this.body=body;this.headersSent=true;}};await handler({method:'GET',originalUrl:'/api/v1/users/me/wallet/guarantees'+q,headers:{origin:'http://user','x-user-id':'other'}},r);return r;};
 const implicit=await request('');assert.equal(implicit.statusCode,200);assert.equal(implicit.body.contractVersion,'owner-guarantee-history.read.v2');assert.equal(implicit.body.subjectId,actor.userId);
 const explicit=await request('?projectionVersion=2');assert.equal(explicit.statusCode,200);assert.equal(explicit.body.contractVersion,'owner-guarantee-history.read.v2');
 assert(seen.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'));
 for(const q of ['?projectionVersion=1','?projectionVersion=3','?projectionVersion=2&projectionVersion=2','?userId=other'])assert.equal((await request(q)).statusCode,400);
});
