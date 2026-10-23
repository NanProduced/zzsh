import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const {GET,POST}=await import('../src/app/api/account/wallet/[[...path]]/route.ts'),root='http://127.0.0.1:4200/api/account/wallet',context=(path=[])=>({params:Promise.resolve({path})});
const page={contractVersion:'personal-finance.read.v1',subjectId:'self',asOf:'2026-10-04T00:00:00.000000Z',snapshotVersion:'1:2:1',coverage:{knowledge:'KNOWN',origin:'RECONCILED_OPENING'},bucket:'ALL',items:[],totals:{count:'0',byBucket:[],historicalCoverage:'NO_HISTORY',meaning:'history'},nextCursor:null};
const history={contractVersion:'owner-guarantee-history.read.v1',subjectId:'self',items:[],nextCursor:null,coverage:{knowledge:'UNKNOWN',count:null,reason:'HISTORY_NOT_IMPORTED'},postedHeld:{knowledge:'KNOWN',amountCents:'0',scope:'POSTED_LEDGER_ONLY',reason:'NATIVE_GUARANTEE_POSTINGS_ONLY'},liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN'};
test('wallet actual BFF carries exact list coverage, safe old default and only realm user cookies',async()=>{
 const original=globalThis.fetch;let received;try{
  for(const known of [false,true]){globalThis.fetch=async(url,options)=>{received={url:String(url),options};return Response.json({...page,privateSource:'SECRET',...(known?{listCoverage:{knowledge:'KNOWN',count:'0',mappedRecordCount:'0',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',cutoff:'2026-10-04T00:00:00.000Z',version:'proof-v1'}}:{})});};
   const r=await GET(new Request(root+'/entries?bucket=ALL',{headers:{cookie:'zzsh_user.session_token=u; zzsh_admin.session_token=a'}}),context(['entries'])),b=await r.json();assert.equal(r.status,200);assert.equal(b.listCoverage.knowledge,known?'KNOWN':'UNKNOWN');assert.equal(b.listCoverage.count,known?'0':null);assert(!JSON.stringify(b).includes('SECRET'));assert.equal(received.options.headers.get('cookie'),'zzsh_user.session_token=u');
  }
 }finally{globalThis.fetch=original;}
});
test('guarantee actual BFF keeps unknown history separate from posted native zero and strips private raw evidence',async()=>{
 const original=globalThis.fetch;let url;globalThis.fetch=async(path)=>{url=String(path);return Response.json({...history,originalReceipt:'SECRET'});};try{const r=await GET(new Request(root+'/guarantees'),context(['guarantees'])),b=await r.json();assert.equal(r.status,200);assert.equal(b.coverage.count,null);assert.equal(b.postedHeld.amountCents,'0');assert.equal(b.liability.amountCents,null);assert.equal(url,'http://127.0.0.1:4202/api/v1/users/me/wallet/guarantees');assert(!JSON.stringify(b).includes('SECRET'));}finally{globalThis.fetch=original;}
});
test('actual wallet BFF carries projection 2 for reserved/pending list and qualified detail, while old responses keep the old wire shape',async()=>{
 const previous=globalThis.fetch,requests=[],at=page.asOf,entry={schemaVersion:1,id:'ledger:reserved',occurredAt:at,importedAt:at,bucket:'RESERVED',deltaCents:'30',kind:'POSTED',includedInOpening:false,sourceKind:'CONTROLLED_WITHDRAWAL_RESERVE',source:{type:'NATIVE',system:'zzsh-local-controlled',entity:'withdrawal_intent',id:'intent'},businessReference:{type:'UNKNOWN',id:null,number:null},balanceAfterCents:null};
 try{globalThis.fetch=async(url)=>{requests.push(String(url));return Response.json(String(url).includes('/entries/ledger%3Areserved')?{...page,projectionVersion:2,entry}:{...page,projectionVersion:2,bucket:'RESERVED',items:[entry],totals:{...page.totals,count:'1',byBucket:[{bucket:'RESERVED',count:'1',postedNetCents:'30',coveredHistoricalNetCents:'0',uncoveredHistoricalNetCents:'0',coveredCount:'0',uncoveredCount:'0'}]},listCoverage:{knowledge:'KNOWN',count:'1',mappedRecordCount:'1',reason:'POSTED_LEDGER_SCOPE',cutoff:null,version:'LEDGER:1:2:1',scope:'POSTED_LEDGER_ONLY'}});};
  const list=await GET(new Request(root+'/entries?projectionVersion=2&bucket=RESERVED'),context(['entries'])),body=await list.json();assert.equal(list.status,200);assert.equal(body.projectionVersion,2);assert.equal(body.items[0].bucket,'RESERVED');assert.equal(body.listCoverage.scope,'POSTED_LEDGER_ONLY');const detail=await GET(new Request(root+'/entries/ledger%3Areserved?projectionVersion=2'),context(['entries','ledger:reserved']));assert.equal(detail.status,200);assert.equal((await detail.json()).entry.bucket,'RESERVED');assert(requests.every(url=>new URL(url).searchParams.get('projectionVersion')==='2'));
  globalThis.fetch=async()=>Response.json(page);assert.equal((await GET(new Request(root+'/entries?projectionVersion=2'),context(['entries']))).status,502);const old=await GET(new Request(root+'/entries'),context(['entries']));assert.equal(old.status,200);assert.equal('projectionVersion' in await old.json(),false);
 }finally{globalThis.fetch=previous;}
});
test('wallet unknown/duplicate projections and detail query changes reject before upstream',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error();};try{for(const path of ['/entries?projectionVersion=3','/entries?projectionVersion=2&projectionVersion=2','/entries/ledger%3Ax?projectionVersion=3','/entries/ledger%3Ax?projectionVersion=2&bucket=ALL'])assert.equal((await GET(new Request(root+path),context(path.includes('/entries/')?['entries','ledger:x']:['entries']))).status,400);assert.equal(calls,0);}finally{globalThis.fetch=previous;}
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
