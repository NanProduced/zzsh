import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET,POST}=await import('../src/app/api/orders/[[...path]]/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={},query='')=>new Request('http://127.0.0.1:3100/api/orders/'+path.join('/')+query,{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});

test('order BFF list/detail forward only user cookies and preserve query',async()=>{
  const old=globalThis.fetch;const seen=[];
  globalThis.fetch=async(url,options)=>{seen.push({url:String(url),options});return Response.json({items:[],nextCursor:null,limit:20});};
  try{
    const r=await GET(input([],{headers:{cookie:'zzsh_user.session_token=usr; zzsh_admin.session_token=adm; other=x'}},'?party=owner&status=PENDING_PAYMENT&limit=5'),ctx(undefined));
    assert.equal(r.status,200);
    assert.equal(seen[0].url,'http://127.0.0.1:3102/api/bff/user/orders/?party=owner&status=PENDING_PAYMENT&limit=5');
    assert.equal(seen[0].options.headers.get('cookie'),'zzsh_user.session_token=usr');
    assert.equal(seen[0].options.headers.get('cookie').includes('adm'),false);
    const d=await GET(input(['order_abc'],{}),ctx(['order_abc']));
    assert.equal(d.status,200);
    assert.equal(seen[1].url,'http://127.0.0.1:3102/api/bff/user/orders/order_abc');
    const im=await GET(input(['order_abc','im'],{},'?operation=send'),ctx(['order_abc','im']));
    assert.equal(im.status,200);
    assert.equal(seen[2].url,'http://127.0.0.1:3102/api/bff/user/orders/order_abc/im?operation=send');
    assert.equal(r.headers.get('cache-control'),'no-store');
  }finally{globalThis.fetch=old;}
});
test('order BFF rejects unknown paths, wrong method, cross-origin writes and authorization headers',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{
    for(const p of [['admin','orders'],['order_abc','pay'],['order_abc','cancel','extra'],['a','..','b']])assert.equal((await GET(input(p),ctx(p))).status,404);
    assert.equal((await POST(input(['order_abc','cancel'],{method:'PUT'}),ctx(['order_abc','cancel']))).status,404);
    assert.equal((await POST(input(['order_abc','im'],{method:'POST'}),ctx(['order_abc','im']))).status,404);
    assert.equal((await POST(input([],{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:'{}'}),ctx(undefined))).status,403);
    assert.equal((await GET(input([],{headers:{authorization:'Bearer forbidden'}}),ctx(undefined))).status,403);
    assert.equal(calls,0);
  }finally{globalThis.fetch=old;}
});
test('order BFF preserves idempotency key and upstream error bodies',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(_url,options)=>{seen=options;return Response.json({error:{code:'OCCUPIED',message:'账号当前已被占用',requestId:'req_x'}},{status:409});};
  try{
    const r=await POST(input([],{method:'POST',headers:{'content-type':'application/json','idempotency-key':'key_order_1'},body:'{"accountId":"a","versionId":"v","releaseId":"r"}'}),ctx(undefined));
    assert.equal(seen.headers.get('idempotency-key'),'key_order_1');
    assert.equal(r.status,409);
    assert.equal((await r.json()).error.code,'OCCUPIED');
  }finally{globalThis.fetch=old;}
});
test('order BFF rejects non-JSON writes, bounds input and maps upstream failures',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{
    assert.equal((await POST(input([],{method:'POST',headers:{'content-type':'text/plain'},body:'x'}),ctx(undefined))).status,400);
    const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){}});
    assert.equal((await POST(input([],{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'}),ctx(undefined))).status,413);
    globalThis.fetch=async()=>{throw new Error('network down');};
    assert.equal((await GET(input([]),ctx(undefined))).status,503);
    globalThis.fetch=async()=>new Response('not-json',{headers:{'content-type':'application/json'}});
    assert.equal((await GET(input([]),ctx(undefined))).status,502);
    assert.equal(calls,0);
  }finally{globalThis.fetch=old;}
});
