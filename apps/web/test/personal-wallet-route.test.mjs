import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const {GET,POST}=await import('../src/app/api/account/wallet/[[...path]]/route.ts'),root='http://127.0.0.1:4200/api/account/wallet',context=(path=[])=>({params:Promise.resolve({path})});
const page={contractVersion:'personal-finance.read.v1',subjectId:'self',asOf:'2026-10-04T00:00:00.000000Z',snapshotVersion:'1:2:1',coverage:{knowledge:'KNOWN',origin:'RECONCILED_OPENING'},bucket:'ALL',items:[],totals:{count:'0',byBucket:[],historicalCoverage:'NO_HISTORY',meaning:'history'},nextCursor:null};
test('actual wallet BFF preserves safe source-only facts and never forwards private original payloads',async()=>{
 const previous=globalThis.fetch,sourceDetails={associationState:null,associationReason:null,recordedAmountCents:'1234',originalStatus:'1',originalNumber:'REFUND',originalOrderType:'order',originalRatio:null,originalLevel:null,sourcePaidAt:null,channelArrival:'UNKNOWN',affectsCurrentWallet:false};
 globalThis.fetch=async()=>Response.json({...page,projectionVersion:2,entry:{schemaVersion:1,id:'history:source',occurredAt:page.asOf,importedAt:page.asOf,postedAt:null,recordedAt:page.asOf,bucket:'AVAILABLE',deltaCents:'0',kind:'HISTORICAL',includedInOpening:false,sourceKind:'HISTORICAL_REFUND',source:{type:'LEGACY_MYSQL',system:'legacy_mysql_restore',entity:'la_refund_record',id:'11'},businessReference:{type:'LEGACY_UNRESOLVED',id:null,number:null},balanceAfterCents:null,sourceDetails:{...sourceDetails,remark:'PRIVATE'},rawSource:'PRIVATE'}});
 try{const r=await GET(new Request(root+'/entries/history%3Asource?projectionVersion=2'),context(['entries','history:source'])),b=await r.json();assert.equal(r.status,200);assert.deepEqual(b.entry.sourceDetails,sourceDetails);assert.equal(b.entry.deltaCents,'0');assert.equal(b.entry.businessReference.id,null);assert(!JSON.stringify(b).includes('PRIVATE'));}finally{globalThis.fetch=previous;}
});
test('wallet actual BFF carries exact list coverage, safe old default and only realm user cookies',async()=>{
 const original=globalThis.fetch;let received;try{
  for(const known of [false,true]){globalThis.fetch=async(url,options)=>{received={url:String(url),options};return Response.json({...page,privateSource:'SECRET',...(known?{listCoverage:{knowledge:'KNOWN',count:'0',mappedRecordCount:'0',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:'2026-10-04T00:00:00.000Z',version:'proof-v1'}}:{})});};
   const r=await GET(new Request(root+'/entries?bucket=ALL',{headers:{cookie:'zzsh_user.session_token=u; zzsh_admin.session_token=a'}}),context(['entries'])),b=await r.json();assert.equal(r.status,200);assert.equal(b.listCoverage.knowledge,known?'KNOWN':'UNKNOWN');assert.equal(b.listCoverage.count,known?'0':null);assert(!JSON.stringify(b).includes('SECRET'));assert.equal(received.options.headers.get('cookie'),'zzsh_user.session_token=u');
  }
 }finally{globalThis.fetch=original;}
});
test('actual wallet BFF carries projection 2 for reserved/pending list and qualified detail, while old responses keep the old wire shape',async()=>{
 const previous=globalThis.fetch,requests=[],at=page.asOf,entry={schemaVersion:1,id:'ledger:reserved',occurredAt:at,importedAt:at,bucket:'RESERVED',deltaCents:'30',kind:'POSTED',includedInOpening:false,sourceKind:'CONTROLLED_WITHDRAWAL_RESERVE',source:{type:'NATIVE',system:'zzsh-local-controlled',entity:'withdrawal_intent',id:'intent'},businessReference:{type:'UNKNOWN',id:null,number:null},balanceAfterCents:null};
 try{globalThis.fetch=async(url)=>{requests.push(String(url));return Response.json(String(url).includes('/entries/ledger%3Areserved')?{...page,projectionVersion:2,entry}:{...page,projectionVersion:2,bucket:'RESERVED',items:[entry],totals:{...page.totals,count:'1',byBucket:[{bucket:'RESERVED',count:'1',postedNetCents:'30',coveredHistoricalNetCents:'0',uncoveredHistoricalNetCents:'0',coveredCount:'0',uncoveredCount:'0'}]},listCoverage:{knowledge:'KNOWN',count:'1',mappedRecordCount:'1',reason:'POSTED_LEDGER_SCOPE',cutoff:null,version:'LEDGER:1:2:1',scope:'POSTED_LEDGER_ONLY'}});};
  const list=await GET(new Request(root+'/entries?projectionVersion=2&bucket=RESERVED'),context(['entries'])),body=await list.json();assert.equal(list.status,200);assert.equal(body.projectionVersion,2);assert.equal(body.items[0].bucket,'RESERVED');assert.equal(body.listCoverage.scope,'POSTED_LEDGER_ONLY');const detail=await GET(new Request(root+'/entries/ledger%3Areserved?projectionVersion=2'),context(['entries','ledger:reserved']));assert.equal(detail.status,200);assert.equal((await detail.json()).entry.bucket,'RESERVED');assert(requests.every(url=>new URL(url).searchParams.get('projectionVersion')==='2'));
  globalThis.fetch=async()=>Response.json(page);assert.equal((await GET(new Request(root+'/entries?projectionVersion=2'),context(['entries']))).status,502);const old=await GET(new Request(root+'/entries'),context(['entries']));assert.equal(old.status,200);assert.equal('projectionVersion' in await old.json(),false);
 }finally{globalThis.fetch=previous;}
});
test('wallet unknown/duplicate projections and detail query changes reject before upstream',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error();};try{for(const path of ['/entries?projectionVersion=4','/entries?projectionVersion=2&projectionVersion=2','/entries/ledger%3Ax?projectionVersion=4','/entries/ledger%3Ax?projectionVersion=2&bucket=ALL'])assert.equal((await GET(new Request(root+path),context(path.includes('/entries/')?['entries','ledger:x']:['entries']))).status,400);assert.equal(calls,0);}finally{globalThis.fetch=previous;}
});

test('v3 wallet BFF forwards only verified purpose and rejects non-balance or malformed records',async()=>{
 const previous=globalThis.fetch,at=page.asOf,base={schemaVersion:1,id:'history:one',occurredAt:at,importedAt:at,bucket:'AVAILABLE',deltaCents:'500',kind:'HISTORICAL',includedInOpening:false,sourceKind:'HISTORICAL_EARNINGS_LOG',purpose:'OWNER_RENTAL_INCOME',historicalAmountSemantics:'BALANCE_RECORD',source:{type:'LEGACY_MYSQL',system:'legacy_mysql_restore',entity:'la_log_earnings',id:'11'},businessReference:{type:'UNKNOWN',id:null,number:null},balanceAfterCents:null,rawSource:'PRIVATE'};
 try{
  globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,entry:base});
  const r=await GET(new Request(root+'/entries/history%3Aone?projectionVersion=3'),context(['entries','history:one'])),body=await r.json();
  assert.equal(r.status,200);assert.equal(body.projectionVersion,3);assert.equal(body.entry.purpose,'OWNER_RENTAL_INCOME');assert(!JSON.stringify(body).includes('PRIVATE'));
  const totals={...page.totals,count:'1',byBucket:[{bucket:'AVAILABLE',count:'1',postedNetCents:'0',coveredHistoricalNetCents:null,uncoveredHistoricalNetCents:null,coveredCount:'0',uncoveredCount:'1'}]};
  globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,items:[base],totals,nextCursor:'signed-cursor'});
  const list=await GET(new Request(root+'/entries?projectionVersion=3'),context(['entries'])),listed=await list.json();
  assert.equal(list.status,200);assert.equal(listed.items[0].purpose,'OWNER_RENTAL_INCOME');assert.equal(listed.nextCursor,'signed-cursor');assert(!JSON.stringify(listed).includes('PRIVATE'));
  globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,items:[base],totals:{...totals,byBucket:[{...totals.byBucket[0],bucket:'REFUND_PAYABLE'}]}});
  assert.equal((await GET(new Request(root+'/entries?projectionVersion=3'),context(['entries']))).status,502);
  const pending={...base,purpose:'UNKNOWN',historicalAmountSemantics:'UNVERIFIED',deltaCents:null,occurredAt:null,postedAt:null,balanceAfterCents:null,includedInOpening:null};
  globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,entry:pending});
  const pendingResponse=await GET(new Request(root+'/entries/history%3Aone?projectionVersion=3'),context(['entries','history:one'])),pendingBody=await pendingResponse.json();
  assert.equal(pendingResponse.status,200);assert.equal(pendingBody.entry.deltaCents,null);assert.equal(pendingBody.entry.occurredAt,null);assert.equal(pendingBody.entry.historicalAmountSemantics,'UNVERIFIED');
  for(const unsafe of [{deltaCents:'500'},{occurredAt:at},{includedInOpening:false},{purpose:'OWNER_RENTAL_INCOME'},{businessReference:{type:'LEGACY_ORDER',id:'other',number:'OTHER'}}]){
   globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,entry:{...pending,...unsafe}});
   assert.equal((await GET(new Request(root+'/entries/history%3Aone?projectionVersion=3'),context(['entries','history:one']))).status,502);
  }
  for(const patch of [{purpose:'NOT_A_PURPOSE'},{purpose:undefined},{bucket:'REFUND_PAYABLE'},{sourceKind:'HISTORICAL_REFUND'}]){
   globalThis.fetch=async()=>Response.json({...page,projectionVersion:3,entry:{...base,...patch}});
   assert.equal((await GET(new Request(root+'/entries/history%3Aone?projectionVersion=3'),context(['entries','history:one']))).status,502);
  }
 }finally{globalThis.fetch=previous;}
});
test('wallet proxy rejects foreign origins, caller identities, duplicate filters and unsupported guarantee actions before upstream',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error();};try{
  for(const q of ['userId=other','cursor=a&cursor=b'])assert.equal((await GET(new Request(root+'/guarantees?'+q),context(['guarantees']))).status,400);
  assert.equal((await GET(new Request(root+'/guarantees?bucket=ALL'),context(['guarantees']))).status,400);assert.equal((await GET(new Request(root,{headers:{origin:'https://foreign.test'}}),context())).status,403);assert.equal((await GET(new Request(root,{headers:{'sec-fetch-site':'cross-site'}}),context())).status,403);assert.equal((await GET(new Request(root+'/guarantees/x'),context(['guarantees','x']))).status,404);assert.equal(POST().status,404);assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});

test('wallet BFF preserves authoritative timestamps including explicit unknown and old-service absence',async()=>{
 const previous=globalThis.fetch,at=page.asOf,base={schemaVersion:1,id:'ledger:time',occurredAt:at,importedAt:at,bucket:'AVAILABLE',deltaCents:'100',kind:'POSTED',includedInOpening:false,sourceKind:'NATIVE_SETTLEMENT',source:{type:'NATIVE',system:'zzsh',entity:'settlement_posting',id:'p'},businessReference:{type:'UNKNOWN',id:null,number:null},balanceAfterCents:null};
 try{
  for(const times of [{},{postedAt:null,recordedAt:at},{postedAt:null,recordedAt:null},{postedAt:'2026-10-03T15:59:59.000Z',recordedAt:at}]){
   globalThis.fetch=async()=>Response.json({...page,entry:{...base,...times}});
   const result=await GET(new Request(root+'/entries/ledger%3Atime'),context(['entries','ledger:time'])),body=await result.json();
   assert.equal(result.status,200);assert.equal(Object.hasOwn(body.entry,'postedAt'),Object.hasOwn(times,'postedAt'));
   if(Object.hasOwn(times,'postedAt'))assert.equal(body.entry.postedAt,times.postedAt);
   assert.equal(Object.hasOwn(body.entry,'recordedAt'),Object.hasOwn(times,'recordedAt'));
   if(Object.hasOwn(times,'recordedAt'))assert.equal(body.entry.recordedAt,times.recordedAt);
  }
  globalThis.fetch=async()=>Response.json({...page,entry:{...base,postedAt:'not-a-time'}});
  assert.equal((await GET(new Request(root+'/entries/ledger%3Atime'),context(['entries','ledger:time']))).status,502);
 }finally{globalThis.fetch=previous;}
});

test('guarantee BFF admits the new-platform unified v2 shape, drops legacy leftovers and refuses a mismatched old assembly',async()=>{
 const previous=globalThis.fetch,at='2026-10-04T00:00:00.000000Z',event={id:'native:requirement:req-1',eventKind:'REQUIREMENT',accountId:'account-1',accountNumber:'ZZ-001',occurredAt:at,recordedAt:at,amountCents:'500',source:{type:'NATIVE',entity:'owner_guarantee_requirement',id:'req-1'},requirement:{id:'req-1',status:'OPEN',requiredCents:'500'},paymentAttempt:null,refundAttempt:null,localPosting:null,channelArrival:'UNKNOWN'};
 const v2={contractVersion:'owner-guarantee-history.read.v2',projectionVersion:2,subjectId:'self',asOf:at,snapshotVersion:'unified-v2',items:[event],nextCursor:null,coverage:{knowledge:'KNOWN',count:'1',mappedRecordCount:'1',reason:'ALL_BOUND_GUARANTEE_SOURCES'},sources:{native:{knowledge:'KNOWN',count:'1'}},unknownTimeCount:'0',postedHeld:{knowledge:'KNOWN',amountCents:'0',scope:'POSTED_LEDGER_ONLY',reason:'NATIVE_GUARANTEE_POSTINGS_ONLY'},liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN',privateEvidence:'SECRET'};let received;
 try{globalThis.fetch=async(url)=>{received=String(url);return Response.json(v2);};const r=await GET(new Request(root+'/guarantees?projectionVersion=2'),context(['guarantees'])),body=await r.json();assert.equal(r.status,200);assert.equal(body.projectionVersion,2);assert.equal(body.coverage.count,'1');assert.equal('cutoff' in body.coverage,false,'absent cutoff is not invented');assert.equal(body.items[0].eventKind,'REQUIREMENT');assert.equal(body.items[0].source.type,'NATIVE');assert.equal(body.postedHeld.amountCents,'0');assert(!JSON.stringify(body).includes('SECRET'));assert.equal(new URL(received).searchParams.get('projectionVersion'),'2');
  globalThis.fetch=async()=>Response.json({...v2,coverage:{...v2.coverage,cutoff:null},sources:{...v2.sources,legacy:{knowledge:'KNOWN',count:'0',reason:'PROVED_NATIVE_BIRTH_ABSENCE'}}});const leftover=await GET(new Request(root+'/guarantees?projectionVersion=2'),context(['guarantees'])),leftoverBody=await leftover.json();assert.equal(leftover.status,200);assert.equal(leftoverBody.coverage.cutoff,null);assert.equal('legacy' in leftoverBody.sources,false,'retired legacy source count is not echoed');
  globalThis.fetch=async()=>Response.json({...v2,items:[{...event,eventKind:'PAYMENT_OBSERVATION',source:{type:'LEGACY_MYSQL',entity:'la_pay_order',id:'501'}}]});assert.equal((await GET(new Request(root+'/guarantees?projectionVersion=2'),context(['guarantees']))).status,502,'retired legacy rows are not served');
  globalThis.fetch=async()=>Response.json({...v2,contractVersion:'owner-guarantee-history.read.v1'});assert.equal((await GET(new Request(root+'/guarantees?projectionVersion=2'),context(['guarantees']))).status,502);
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error();};for(const query of ['projectionVersion=1','projectionVersion=3','projectionVersion=2&projectionVersion=2'])assert.equal((await GET(new Request(root+'/guarantees?'+query),context(['guarantees']))).status,400);assert.equal((await GET(new Request(root+'/guarantees'),context(['guarantees']))).status,400);assert.equal(calls,0);
 }finally{globalThis.fetch=previous;}
});
