import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET}=await import('../src/app/api/content/[...path]/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={})=>new Request('http://127.0.0.1:3100/api/content/'+path.join('/')+(init.search??''),{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});

test('content BFF proxies carousel reads and rewrites media URLs to local paths',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({items:[{id:'c1',title:'官方活动',mediaUrl:'/api/v1/content/media/m1/content',mobileMediaUrl:'/api/v1/content/media/m2/content',linkUrl:'/help'}]});};
  try{
    const p=['carousel'];const r=await GET(input(p,{search:'?slot=HOME_HERO'}),ctx(p));
    assert.equal(r.status,200);
    assert.equal(seen.url,'http://127.0.0.1:3102/api/v1/content/carousel?slot=HOME_HERO');
    const sentHeaders=new Headers(seen.options.headers);
    assert.equal(sentHeaders.get('cookie'),null);
    const body=await r.json();
    assert.equal(body.items[0].mediaUrl,'/api/content/media/m1/content');
    assert.equal(body.items[0].mobileMediaUrl,'/api/content/media/m2/content');
    assert.equal(body.items[0].linkUrl,'/help');
  }finally{globalThis.fetch=old;}
});

test('structured content BFF permits encoded resource keys and rewrites only authorized image projections',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url)=>{seen=String(url);return Response.json({schema:'content-resource.v1',key:'placement:FOLLOW',media:[{id:'m1',url:'/api/v1/content/media/m1/content'},{id:'m2',url:null}]},{headers:{'cache-control':'no-store'}});};
  try{
    const p=['resources','placement:FOLLOW'];const r=await GET(input(p),ctx(p));
    assert.equal(r.status,200);assert.match(seen,/resources\/placement(?:%3A|:)FOLLOW$/);
    const body=await r.json();assert.equal(body.media[0].url,'/api/content/media/m1/content');assert.equal(body.media[1].url,null);
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal((await GET(input(['resources','guide:../secret']),ctx(['resources','guide:../secret']))).status,404);
  }finally{globalThis.fetch=old;}
});

test('public resource client validates schema, media eligibility and finite pagination without reviving withdrawn content',async()=>{
  const {parsePublicContentResource,fetchContentResources}=await import('../src/lib/content-public.ts');
  const {DEFAULT_RESOURCES}=await import('@zzsh/content');
  const entry={schema:'content-resource.v1',key:'placement:FOLLOW',source:'MANAGED',state:'available',payload:{...DEFAULT_RESOURCES['placement:FOLLOW'],qrMediaId:'m1',enabled:true},media:[{id:'m1',url:null}]};
  assert.equal(parsePublicContentResource(entry).media[0].url,null);
  assert.throws(()=>parsePublicContentResource({...entry,schema:'unknown'}));
  assert.throws(()=>parsePublicContentResource({...entry,media:[{id:'m1',url:'https://evil.test/private'}]}));
  assert.throws(()=>parsePublicContentResource({...entry,media:[]}));
  assert.equal(parsePublicContentResource({...entry,state:'withdrawn',payload:null,media:[]}).payload,null);
  let calls=0;
  await assert.rejects(()=>fetchContentResources('placement',{fetcher:async()=>{calls++;return Response.json({items:calls===1?[entry]:[],nextCursor:'same'});}}));
  assert.equal(calls,2,'a repeated cursor terminates with an error');
  await assert.rejects(()=>fetchContentResources('placement',{fetcher:async()=>new Response(null,{status:503})}));
});

test('resource reads use bounded five-item pages and no-store for every cursor request',async()=>{
  const {fetchContentResources}=await import('../src/lib/content-public.ts');
  const {DEFAULT_GUIDES}=await import('@zzsh/content');
  const entries=DEFAULT_GUIDES.slice(0,6).map(guide=>({schema:'content-resource.v1',key:`guide:${guide.slug}`,source:'BUILTIN',state:'available',payload:guide,media:[],version:null}));
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url:new URL(url,'http://127.0.0.1'),options});
    return Response.json(calls.length===1?{items:entries.slice(0,5),nextCursor:'page-2'}:{items:entries.slice(5),nextCursor:null});
  };
  const result=await fetchContentResources('guide',{fetcher});
  assert.deepEqual(result.map(item=>item.key),entries.map(item=>item.key));
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call.url.searchParams.get('limit')),['5','5']);
  assert.deepEqual(calls.map(call=>call.url.searchParams.get('cursor')),[null,'page-2']);
  for(const call of calls){assert.equal(call.url.searchParams.get('kind'),'guide');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');}
  await assert.rejects(()=>fetchContentResources('guide',{fetcher:async()=>Response.json({items:entries,nextCursor:null})}),'oversized resource pages are rejected even when all entries are individually valid');
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
