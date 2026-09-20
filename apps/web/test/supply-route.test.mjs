import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET,POST,PUT}=await import('../src/app/api/supply/[...path]/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={})=>new Request('http://127.0.0.1:3100/api/supply/'+path.join('/')+'?limit=2',{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});
test('listing v2 BFF preserves encoded filters, rewrites metadata and bounds raw URLs',async()=>{
  const old=globalThis.fetch;let seen,calls=0;
  globalThis.fetch=async url=>{calls++;seen=String(url);return Response.json({skinCatalogUrl:'/api/v1/supply/games/delta/catalog'});};
  try{
    const params=new URLSearchParams({queryVersion:'2',gameId:'delta',filters:JSON.stringify({regions:[{province:'河南省',city:'郑州市'}]})});
    const r=await GET(new Request('http://127.0.0.1:3100/api/supply/listings?'+params),ctx(['listings']));
    assert.equal(r.status,200);assert.equal(new URL(seen).search,'?'+params);assert.equal((await r.json()).skinCatalogUrl,'/api/supply/games/delta/catalog');
    assert.equal((await GET(input(['games','delta','listing-filters']),ctx(['games','delta','listing-filters']))).status,200);
    const before=calls;const long=await GET(new Request('http://127.0.0.1:3100/api/supply/listings?queryVersion=2&q='+'x'.repeat(8192)),ctx(['listings']));
    assert.equal(long.status,400);assert.equal((await long.json()).error.details[0].path,'url');assert.equal(calls,before);
  }finally{globalThis.fetch=old;}
});
test('supply BFF forwards only user cookies, preserves query and adapts public URLs',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({items:[{url:'/api/v1/supply/listings/a/media/m',resourceTotal:{amount:'125.00'}}],sessionToken:'must-not-forward'});};
  try{const p=['listings'];const r=await GET(input(p,{headers:{cookie:'zzsh_user.session_token=usr; zzsh_admin.session_token=adm; other=x'}}),ctx(p));assert.equal(r.status,200);assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/supply/listings?limit=2');assert.equal(seen.options.headers.get('cookie'),'zzsh_user.session_token=usr');const b=await r.json();assert.equal(b.items[0].url,'/api/supply/listings/a/media/m');assert.equal(b.items[0].resourceTotal.amount,'125.00');assert.equal('sessionToken' in b,false);assert.equal(r.headers.get('cache-control'),'no-store');}finally{globalThis.fetch=old;}
});
test('supply BFF rejects admin routes, traversal, wrong method and cross-origin writes before forwarding',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{for(const p of [['admin','supply'],['accounts','a/../admin'],['accounts','a','submit']])assert.equal((await GET(input(p),ctx(p))).status,404);
    const p=['favorites','a'];assert.equal((await PUT(input(p,{method:'PUT',headers:{origin:'https://other.invalid','content-type':'application/json'},body:'{}'}),ctx(p))).status,403);
    assert.equal((await GET(input(['listings'],{headers:{authorization:'Bearer forbidden'}}),ctx(['listings']))).status,403);assert.equal(calls,0);
  }finally{globalThis.fetch=old;}
});
test('supply JSON preserves idempotency and field errors; binary uploads use a separate bound',async()=>{
  const old=globalThis.fetch;let seen;globalThis.fetch=async(_url,options)=>{seen=options;return Response.json({error:{code:'INVALID_ARGUMENT',message:'数量错误',requestId:'req_x',details:[{path:'inventory',code:'INVALID_FIELD'}]}},{status:400});};
  try{let p=['accounts','a','draft'];const r=await PUT(input(p,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':'key_123456'},body:'{}'}),ctx(p));assert.equal(seen.headers.get('idempotency-key'),'key_123456');assert.equal((await r.json()).error.details[0].path,'inventory');
    p=['media','uploads','up'];await PUT(input(p,{method:'PUT',headers:{'content-type':'image/png','x-upload-token':'limited-upload-token','idempotency-key':'upload_1234'},body:new Uint8Array(100000)}),ctx(p));assert.equal(seen.body.byteLength,100000);assert.equal(seen.headers.get('x-upload-token'),'limited-upload-token');
  }finally{globalThis.fetch=old;}
});
test('supply BFF bounds chunked input and upstream output and preserves image bytes',async()=>{
  const old=globalThis.fetch;let calls=0,cancelled=false;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{const p=['accounts'];const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}});assert.equal((await POST(input(p,{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body,duplex:'half'}),ctx(p))).status,413);assert.equal(cancelled,true);assert.equal(calls,0);
    globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});const m=['listings','a','media','m'];assert.deepEqual(new Uint8Array(await(await GET(input(m),ctx(m))).arrayBuffer()),new Uint8Array([1,2,3]));
    globalThis.fetch=async()=>new Response(new Uint8Array(2*1024*1024+1),{headers:{'content-type':'application/json'}});assert.equal((await GET(input(['listings']),ctx(['listings']))).status,502);
  }finally{globalThis.fetch=old;}
});
