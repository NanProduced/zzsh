import assert from 'node:assert/strict';import {test} from 'node:test';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const {GET,POST}=await import('../src/app/api/account/withdrawals/[[...path]]/route.ts');
const context=(path=[])=>({params:Promise.resolve({path})}),url='http://127.0.0.1:4200/api/account/withdrawals';
const intent={id:'wd_1',scope:'LOCAL_CONTROLLED',userId:'self',state:'UNKNOWN',operationVersion:'3',fundsDisposition:'RESERVED',amountCents:'200',netCents:'196',feeCents:'4',destinationId:'code',policyVersion:'local_v1',acceptedAt:'2026-10-04T00:00:00Z',terminal:null,lease:'private',payoutKey:'private'};
const body={amountCents:'200',destinationId:'code',policyVersion:'local_v1',expectedWalletVersion:'1'};
const post=(patch={},headers={})=>new Request(url,{method:'POST',headers:{origin:'http://127.0.0.1:4200','content-type':'application/json','idempotency-key':'original-key',...headers},body:JSON.stringify({...body,...patch})});
test('withdrawal BFF forwards only user cookie and four server-validated inputs; strips worker evidence',async()=>{
 const previous=globalThis.fetch;let seen;globalThis.fetch=async(u,o)=>{seen={u:String(u),o};return Response.json({intent});};
 try{const r=await POST(post({}, {cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin; other=x'}),context());assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const b=await r.json();assert(!JSON.stringify(b).includes('private'));assert.equal(b.intent.state,'UNKNOWN');assert.equal(seen.u,'http://127.0.0.1:4202/api/v1/users/me/withdrawals');assert.equal(seen.o.headers.get('cookie'),'zzsh_user.session_token=user');assert.equal(seen.o.headers.get('idempotency-key'),'original-key');assert.deepEqual(JSON.parse(seen.o.body),body);}
 finally{globalThis.fetch=previous;}
});
test('withdrawal BFF rejects actor/outcome overrides and cross-origin before contacting API',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error();};
 try{assert.equal((await POST(post({userId:'other'}),context())).status,400);assert.equal((await POST(post({outcome:'SUCCEEDED'}),context())).status,400);assert.equal((await POST(post({}, {origin:'https://other.test'}),context())).status,403);assert.equal((await POST(post({}, {authorization:'Bearer fake'}),context())).status,403);assert.equal((await POST(post({}, {'idempotency-key':''}),context())).status,400);assert.equal((await GET(new Request(url+'?userId=other'),context())).status,400);assert.equal(calls,0);}
 finally{globalThis.fetch=previous;}
});
test('withdrawal BFF transport or malformed successful write is unknown; query stays read-only',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>{throw Error('down');};
 try{const r=await POST(post(),context());assert.equal(r.status,502);assert.equal((await r.json()).error.code,'WRITE_OUTCOME_UNKNOWN');const read=await GET(new Request(url+'/receipt?key=original-key'),context(['receipt']));assert.equal((await read.json()).error.code,'EVIDENCE_UNAVAILABLE');globalThis.fetch=async()=>Response.json({intent:{...intent,feeCents:'3'}});assert.equal((await (await POST(post(),context())).json()).error.code,'WRITE_OUTCOME_UNKNOWN');}
 finally{globalThis.fetch=previous;}
});
test('withdrawal BFF preserves known local zero separately from unknown global buckets and receipt absence',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({scope:'LOCAL_CONTROLLED',coverage:{knowledge:'KNOWN',cohorts:[]},items:[],destinations:[],totals:{reservedCents:'0',payoutCents:'0',feeCents:'0'},globalReserved:'UNKNOWN'});
 try{const b=await (await GET(new Request(url),context())).json();assert.equal(b.totals.reservedCents,'0');assert.equal(b.globalReserved,'UNKNOWN');globalThis.fetch=async()=>Response.json({scope:'LOCAL_CONTROLLED',knowledge:'UNKNOWN',receipt:null});assert.deepEqual(await (await GET(new Request(url+'/receipt?key=original-key'),context(['receipt']))).json(),{scope:'LOCAL_CONTROLLED',knowledge:'UNKNOWN',receipt:null});globalThis.fetch=async()=>Response.json({scope:'LOCAL_CONTROLLED',knowledge:'KNOWN',receipt:{intent}});const known=await (await GET(new Request(url+'/receipt?key=original-key'),context(['receipt']))).json();assert.equal(known.receipt.intent.id,'wd_1');assert(!JSON.stringify(known).includes('private'));}
 finally{globalThis.fetch=previous;}
});
