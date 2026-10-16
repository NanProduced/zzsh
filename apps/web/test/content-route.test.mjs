import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET}=await import('../src/app/api/content/[...path]/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={})=>new Request('http://127.0.0.1:3100/api/content/'+path.join('/')+(init.search??''),{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});

test('content BFF proxies carousel reads and rewrites media URLs to local paths',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({items:[{id:'c1',title:'官方活动',mediaUrl:'/api/v1/content/media/m1/content',linkUrl:'/help'}]});};
  try{
    const p=['carousel'];const r=await GET(input(p,{search:'?slot=HOME_HERO'}),ctx(p));
    assert.equal(r.status,200);
    assert.equal(seen.url,'http://127.0.0.1:3102/api/v1/content/carousel?slot=HOME_HERO');
    const sentHeaders=new Headers(seen.options.headers);
    assert.equal(sentHeaders.get('cookie'),null);
    const body=await r.json();
    assert.equal(body.items[0].mediaUrl,'/api/content/media/m1/content');
    assert.equal(body.items[0].linkUrl,'/help');
  }finally{globalThis.fetch=old;}
});

test('content BFF proxies public activity without cookies and preserves cache policy',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({generatedAt:'2026-10-16T04:00:00.000Z',metrics:{visits:{state:'UNAVAILABLE',reason:'NO_AUTHORITATIVE_SOURCE',detail:'x'},transactions:{state:'AVAILABLE',value:12,asOf:'t',scope:'s'},listings:{state:'UNAVAILABLE',reason:'SOURCE_UNKNOWN',detail:'y'}},deals:{state:'AVAILABLE',items:[],asOf:'t'}},{headers:{'cache-control':'public, max-age=30'}});
  try{
    const r=await GET(input(['activity'],{headers:{cookie:'zzsh_user.session_token=usr'}}),ctx(['activity']));
    assert.equal(r.status,200);
    assert.equal(r.headers.get('cache-control'),'public, max-age=30');
    const body=await r.json();
    assert.equal(body.metrics.transactions.value,12);
    assert.equal(body.metrics.visits.state,'UNAVAILABLE');
  }finally{globalThis.fetch=old;}
});

test('content BFF rejects writes, unknown paths, traversal and authorization headers before forwarding',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{
    for(const p of [['items','a','..','admin'],['admin','items'],['media','m'],['carousel','extra']])assert.equal((await GET(input(p),ctx(p))).status,404);
    assert.equal((await GET(input(['items'],{headers:{authorization:'Bearer x'}}),ctx(['items']))).status,403);
    assert.equal(calls,0);
  }finally{globalThis.fetch=old;}
});

test('content BFF streams whitelisted image bytes and bounds upstream JSON',async()=>{
  const old=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(new Uint8Array([9,8,7]),{headers:{'content-type':'image/webp'}});
    const m=['media','m1','content'];
    const r=await GET(input(m),ctx(m));
    assert.equal(r.status,200);
    assert.equal(r.headers.get('content-type'),'image/webp');
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),new Uint8Array([9,8,7]));
    globalThis.fetch=async()=>new Response(new Uint8Array(2*1024*1024+1),{headers:{'content-type':'application/json'}});
    assert.equal((await GET(input(['items']),ctx(['items']))).status,502);
    globalThis.fetch=async()=>{throw new Error('down');};
    assert.equal((await GET(input(['carousel']),ctx(['carousel']))).status,503);
  }finally{globalThis.fetch=old;}
});
