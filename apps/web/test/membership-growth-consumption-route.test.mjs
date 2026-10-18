import assert from 'node:assert/strict';
import {test} from 'node:test';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4222';
process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4220';
const {GET,POST}=await import('../src/app/api/account/membership-growth/consumption/route.ts');
const request=(query='',headers={})=>new Request('http://127.0.0.1:4220/api/account/membership-growth/consumption'+query,{headers});
test('growth BFF forwards scope/cursor and only user-realm cookies',async()=>{
 const old=globalThis.fetch;
 try{globalThis.fetch=async(url,init)=>{assert.equal(String(url),'http://127.0.0.1:4222/api/v1/users/me/membership-growth/consumption?scope=LIFETIME&limit=20&cursor=opaque');assert.equal(init.method,'GET');assert.equal(init.headers.get('cookie'),'zzsh_user.session_token=fixture_user');assert.equal(init.headers.get('origin'),'http://127.0.0.1:4220');assert(!init.headers.has('authorization'));return Response.json({knowledge:'KNOWN',items:[]})};
 const r=await GET(request('?scope=LIFETIME&limit=20&cursor=opaque',{cookie:'zzsh_user.session_token=fixture_user; zzsh_admin.session_token=fixture_admin; random=fixture'}));assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 }finally{globalThis.fetch=old}
});
test('growth BFF refuses bearer, wrong origin, foreign subject and malformed paging without upstream calls',async()=>{
 const old=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async()=>{calls++;throw Error('must not reach upstream')};
 for(const [q,h,status]of [['',{authorization:'Bearer fixture'},403],['',{origin:'http://127.0.0.1:3100'},403],['?userId=foreign',{},400],['?limit=1&limit=2',{},400],['?limit=51',{},400],['?cursor=',{},400],['?scope=ALL',{},400]])assert.equal((await GET(request(q,h))).status,status);
 assert.equal(POST().status,404);assert.equal(calls,0);
 }finally{globalThis.fetch=old}
});
test('growth BFF preserves upstream authorization and stale-source errors',async()=>{
 const old=globalThis.fetch;
 try{for(const status of[401,403,409]){globalThis.fetch=async()=>Response.json({error:{code:'FIXTURE_DENIAL'}},{status});const r=await GET(request());assert.equal(r.status,status);assert.equal((await r.json()).error.code,'FIXTURE_DENIAL')}}finally{globalThis.fetch=old}
});
test('growth BFF rejects oversized or non-JSON upstream bodies instead of returning false data',async()=>{
 const old=globalThis.fetch;
 try{for(const body of['not-json','x'.repeat(128*1024+1)]){globalThis.fetch=async()=>new Response(body);const r=await GET(request());assert.equal(r.status,502)}}finally{globalThis.fetch=old}
});
