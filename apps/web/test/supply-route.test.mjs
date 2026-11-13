import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET,HEAD,POST,PUT}=await import('../src/app/api/supply/[...path]/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={})=>new Request('http://127.0.0.1:3100/api/supply/'+path.join('/')+'?limit=2',{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});

test('exact number BFF forwards literal text and public read-only state without creating a private detail path',async()=>{
 const old=globalThis.fetch;let seen;
 globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({id:'account-a',displayNo:'0000123',availability:{state:'OFFLINE'},canCreateOrder:false});};
 try{const req=new Request('http://127.0.0.1:3100/api/supply/listings/lookup?number=0000123&gameId=delta');const response=await GET(req,ctx(['listings','lookup']));
  assert.equal(new URL(seen.url).pathname,'/api/bff/user/supply/listings/lookup');assert.equal(new URL(seen.url).searchParams.get('number'),'0000123');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.equal(body.id,'account-a');assert.equal(body.canCreateOrder,false);assert.equal(body.availability.state,'OFFLINE');
 }finally{globalThis.fetch=old;}
});
test('listing v2 BFF preserves encoded filters, rewrites metadata and bounds raw URLs',async()=>{
  const old=globalThis.fetch;let seen,calls=0;
  globalThis.fetch=async url=>{calls++;seen=String(url);return Response.json({skinCatalogUrl:'/api/v1/supply/games/delta/catalog'});};
  try{
    const params=new URLSearchParams({queryVersion:'2',gameId:'delta',filters:JSON.stringify({regions:[{province:'河南省',city:'郑州市'}],resources:[{itemId:'ammo',minQuantity:'10',maxQuantity:'20'}]})});
    const r=await GET(new Request('http://127.0.0.1:3100/api/supply/listings?'+params),ctx(['listings']));
    assert.equal(r.status,200);assert.equal(new URL(seen).search,'?'+params);assert.deepEqual(JSON.parse(new URL(seen).searchParams.get('filters')).resources,[{itemId:'ammo',minQuantity:'10',maxQuantity:'20'}]);assert.equal((await r.json()).skinCatalogUrl,'/api/supply/games/delta/catalog');
    assert.equal((await GET(input(['games','delta','listing-filters']),ctx(['games','delta','listing-filters']))).status,200);
    assert.equal((await GET(new Request('http://127.0.0.1:3100/api/supply/games/delta/full-payout-terms?releaseId=release_1'),ctx(['games','delta','full-payout-terms']))).status,200);
    assert.equal(new URL(seen).pathname,'/api/bff/user/supply/games/delta/full-payout-terms');assert.equal(new URL(seen).searchParams.get('releaseId'),'release_1');
    const before=calls;const long=await GET(new Request('http://127.0.0.1:3100/api/supply/listings?queryVersion=2&q='+'x'.repeat(8192)),ctx(['listings']));
    assert.equal(long.status,400);assert.equal((await long.json()).error.details[0].path,'url');assert.equal(calls,before);
  }finally{globalThis.fetch=old;}
});
test('listing v2 BFF adapts convenience sort and zone parameters into canonical query',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async url=>{seen=String(url);return Response.json({items:[]});};
  try{
    const req=new Request('http://127.0.0.1:3100/api/supply/listings?queryVersion=2&gameId=delta&sortType=haff&sortOrder=asc&smallAmount=1&lingchen=1');
    const r=await GET(req,ctx(['listings']));
    assert.equal(r.status,200);
    const parsed=new URL(seen);
    assert.equal(parsed.searchParams.get('sort'),'coreQuantity');
    assert.equal(parsed.searchParams.get('coreItemId'),'haff');
    assert.equal(parsed.searchParams.get('direction'),'ASC');
    assert.equal(parsed.searchParams.has('sortType'),false);
    assert.equal(parsed.searchParams.has('sortOrder'),false);
    assert.equal(parsed.searchParams.has('smallAmount'),false);
    assert.equal(parsed.searchParams.has('lingchen'),false);
    const filters=JSON.parse(parsed.searchParams.get('filters'));
    assert.equal(filters.resources[0].maxQuantity,'150000000');
    assert.equal(filters.serviceWindow.startMinute,0);
    assert.equal(filters.serviceWindow.endMinute,480);
  }finally{globalThis.fetch=old;}
});
test('supply BFF forwards only user cookies, preserves query and adapts public URLs',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({items:[{url:'/api/v1/supply/listings/a/media/m',resourceTotal:{amount:'125.00'}}],sessionToken:'must-not-forward'});};
  try{const p=['listings'];const r=await GET(input(p,{headers:{cookie:'zzsh_user.session_token=usr; zzsh_admin.session_token=adm; other=x'}}),ctx(p));assert.equal(r.status,200);assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/supply/listings?limit=2');assert.equal(seen.options.headers.get('cookie'),'zzsh_user.session_token=usr');const b=await r.json();assert.equal(b.items[0].url,'/api/supply/listings/a/media/m');assert.equal(b.items[0].resourceTotal.amount,'125.00');assert.equal('sessionToken' in b,false);assert.equal(r.headers.get('cache-control'),'no-store');}finally{globalThis.fetch=old;}
});

test('supply original-result GET forwards only the user realm and preserves the recovery key',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({receipt:'UNRESOLVED'});};
  try{const query=new URLSearchParams({operation:'supply.publication.pause',resourceId:'account-1',fingerprint:'a'.repeat(64)});
    const request=new Request('http://127.0.0.1:3100/api/supply/operation-result?'+query,{headers:{cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin','idempotency-key':'original-recovery-key'}});
    const response=await GET(request,ctx(['operation-result']));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/supply/operation-result?'+query);assert.equal(seen.options.method,'GET');assert.equal(seen.options.body,undefined);
    assert.equal(seen.options.headers.get('cookie'),'zzsh_user.session_token=user');assert.equal(seen.options.headers.get('idempotency-key'),'original-recovery-key');
  }finally{globalThis.fetch=old;}
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
test('legacy media HEAD preserves only the confirmed missing marker and accepts no arbitrary path',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,options)=>{calls++;assert.equal(options.method,'HEAD');return new Response(null,{status:404,headers:{'x-zzsh-legacy-missing':'1'}});};
  try{const path=['listings','account_1','legacy-images','0'];const response=await HEAD(new Request('http://127.0.0.1:3100/api/supply/'+path.join('/'),{method:'HEAD'}),ctx(path));
    assert.equal(response.status,404);assert.equal(response.headers.get('x-zzsh-legacy-missing'),'1');assert.equal(await response.text(),'');
    const invalid=['listings','account_1','legacy-images','../x'];assert.equal((await HEAD(new Request('http://127.0.0.1:3100/api/supply/x',{method:'HEAD'}),ctx(invalid))).status,404);assert.equal(calls,1);
  }finally{globalThis.fetch=old;}
});
test('legacy media URLs are rewritten to the same-origin user proxy',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({legacyImages:[{position:0,url:'/api/v1/supply/listings/account_1/legacy-images/0'}]});
  try{const path=['listings','account_1'];const response=await GET(new Request('http://127.0.0.1:3100/api/supply/'+path.join('/')),ctx(path));
    assert.equal((await response.json()).legacyImages[0].url,'/api/supply/listings/account_1/legacy-images/0');
  }finally{globalThis.fetch=old;}
});

test('the BFF passes an opt-in private account redirect only for its configured OSS origin', async t => {
  const oldFetch = globalThis.fetch, oldOrigin = process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN;
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldOrigin === undefined) delete process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN;
    else process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN = oldOrigin;
  });
  const origin = 'https://images.example.com';
  process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN = origin;
  const path = ['media', 'asset_1', 'access'];
  const req = () => new Request('http://127.0.0.1:3100/api/supply/' + path.join('/') + '?delivery=direct');
  for (const [host, status] of [[origin, 307], ['https://untrusted.example.com', 502]]) {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).searchParams.get('delivery'), 'direct');
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 307, headers: { Location: host + '/original?signature=fixture' } });
    };
    const response = await GET(req(), ctx(path));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('location'), status === 307 ? origin + '/original?signature=fixture' : null);
    if (status === 307) assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  delete process.env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).search, '');
    assert.equal(options.redirect, 'error');
    return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } });
  };
  assert.deepEqual(new Uint8Array(await (await GET(req(), ctx(path))).arrayBuffer()), new Uint8Array([1, 2]));
});
