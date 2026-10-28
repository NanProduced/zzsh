import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.NODE_ENV='test';
const {GET,POST}=await import('../src/app/api/orders/[[...path]]/route.ts');
const {POST:CONFIRM}=await import('../src/app/api/order-confirmations/route.ts');
const {POST:CREATE_V2}=await import('../src/app/api/v2/orders/route.ts');
const ctx=path=>({params:Promise.resolve({path})});
const input=(path,init={},query='')=>new Request('http://127.0.0.1:3100/api/orders/'+path.join('/')+query,{...init,headers:{origin:'http://127.0.0.1:3100',...init.headers}});

test('未开租结束GET/申请保持本人Cookie身份预检；不代理Admin审核或隐式渠道query',async()=>{
 const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});
  return Response.json(String(url).includes('get-session')?{user:{id:'renter_1'},session:{id:'session_1'}}:{orderId:'order_1'});};
 try{const headers={cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin','x-zzsh-expected-user-id':'renter_1'};
  const r=await GET(input(['order_1','prestart-termination'],{headers}),ctx(['order_1','prestart-termination']));assert.equal(r.status,200);
  const forwarded=calls.at(-1);assert.match(forwarded.url,/order_1\/prestart-termination$/);assert.equal(forwarded.options.headers.get('cookie'),'zzsh_user.session_token=user');
  const body=JSON.stringify({expectedOrderRevision:'1',reason:'申请尚未开租结束'});
  const p=await POST(input(['order_1','prestart-termination','requests'],{method:'POST',headers:{...headers,'idempotency-key':'original_1','content-type':'application/json'},body}),ctx(['order_1','prestart-termination','requests']));
  assert.equal(p.status,200);assert.equal(calls.at(-1).options.headers.get('idempotency-key'),'original_1');
  const count=calls.length;assert.equal((await POST(input(['order_1','prestart-termination','term_1','review'],{method:'POST',headers,body:'{}'}),ctx(['order_1','prestart-termination','term_1','review']))).status,404);
  assert.equal((await GET(input(['order_1','prestart-termination'],{headers},'?query=channel'),ctx(['order_1','prestart-termination']))).status,400);assert.equal(calls.length,count);
 }finally{globalThis.fetch=old;}
});

test('v2 creation has an explicit path and preserves credential/body/key without changing v1',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({order:{id:'order-v2'}});};
  try {
    const body=JSON.stringify({confirmationToken:'original-signed-credential'});
    const r=await CREATE_V2(new Request('http://127.0.0.1:3100/api/v2/orders',{method:'POST',headers:{origin:'http://127.0.0.1:3100','content-type':'application/json','idempotency-key':'v2-key',cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin'},body}));
    assert.equal(r.status,200);assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/orders-v2');assert.equal(seen.options.headers.get('idempotency-key'),'v2-key');assert.equal(seen.options.headers.get('cookie'),'zzsh_user.session_token=user');assert.equal(new TextDecoder().decode(seen.options.body),body);assert.equal(r.headers.get('cache-control'),'no-store');
  } finally {globalThis.fetch=old;}
});

test('personal confirmation BFF preserves only user session, bounded body and no-store credential',async()=>{
  const old=globalThis.fetch;let seen;
  globalThis.fetch=async(url,options)=>{seen={url:String(url),options};return Response.json({confirmationToken:'synthetic-signed-credential',quote:{resourceTotal:{amount:'10.00'}}});};
  try {
    const body=JSON.stringify({accountId:'a',versionId:'v',releaseId:'r'});
    const result=await CONFIRM(new Request('http://127.0.0.1:3100/api/order-confirmations',{method:'POST',headers:{origin:'http://127.0.0.1:3100','content-type':'application/json',cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin'},body}));
    assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/order-confirmations');assert.equal(seen.options.headers.get('cookie'),'zzsh_user.session_token=user');
    assert.equal(new TextDecoder().decode(seen.options.body),body);assert.equal((await result.json()).confirmationToken,'synthetic-signed-credential');
    for(const headers of [{origin:'https://evil.invalid'},{origin:'http://127.0.0.1:3100',authorization:'Bearer unsafe'}])assert.equal((await CONFIRM(new Request('http://127.0.0.1:3100/api/order-confirmations',{method:'POST',headers:{'content-type':'application/json',...headers},body}))).status,403);
  } finally {globalThis.fetch=old;}
});

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

test('historical order BFF forwards only GET list/detail and preserves authorization errors',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,init)=>{calls++;assert.match(String(url),/\/api\/bff\/user\/orders\/legacy/);assert.equal(init.method,'GET');return Response.json({error:{code:'NOT_FOUND',message:'未找到'}},{status:404});};
  try{
    assert.equal((await GET(input(['legacy','legacy_order_a']),ctx(['legacy','legacy_order_a']))).status,404);
    assert.equal(calls,1);
    assert.equal((await POST(input(['legacy','legacy_order_a'],{method:'POST',headers:{origin:'http://127.0.0.1:3100','content-type':'application/json'},body:'{}'}),ctx(['legacy','legacy_order_a']))).status,404);
    assert.equal(calls,1);
  }finally{globalThis.fetch=old;}
});

test('channel payment GET forwards the v1 local projection, user session and null unknowns without changing legacy reads',async()=>{
  const old=globalThis.fetch;const seen=[];
  const projection={contractVersion:'order-payment-request.v1',dataOrigin:'UNKNOWN',request:null,paymentAction:null,payment:null};
  globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/get-session'))return Response.json({user:{id:'user_a'}});seen.push({url:String(url),options});return Response.json(projection);};
  try{
    const path=['order_channel','channel-payment-requests'];
    const response=await GET(input(path,{headers:{cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin','x-zzsh-expected-user-id':'user_a'}}),ctx(path));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),projection);
    assert.equal(seen[0].url,'http://127.0.0.1:3102/api/bff/user/orders/order_channel/channel-payment-requests');
    assert.equal(seen[0].options.headers.get('cookie'),'zzsh_user.session_token=user');
    assert.equal(seen[0].options.method,'GET');assert.equal(response.headers.get('cache-control'),'no-store');
    await GET(input(['order_channel','payment-requests']),ctx(['order_channel','payment-requests']));
    assert.equal(seen[1].url,'http://127.0.0.1:3102/api/bff/user/orders/order_channel/payment-requests');
  }finally{globalThis.fetch=old;}
});

test('channel payment POST keeps method, frozen key, pending receipt and upstream status instead of manufacturing paid',async()=>{
  const old=globalThis.fetch;let seen;
  const receipt={contractVersion:'order-payment-request.v1',replay:false,request:{id:'payreq_channel',state:'SUBMITTING'},paymentAction:null,payment:null};
  globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/get-session'))return Response.json({user:{id:'user_a'}});seen={url:String(url),options};return Response.json(receipt,{status:202});};
  try{
    const path=['order_channel','channel-payment-requests'],body=JSON.stringify({method:'WEIXIN_NATIVE'});
    const response=await POST(input(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'original-channel-key','x-zzsh-expected-user-id':'user_a'},body}),ctx(path));
    assert.equal(response.status,202);assert.deepEqual(await response.json(),receipt);
    assert.equal(seen.url,'http://127.0.0.1:3102/api/bff/user/orders/order_channel/channel-payment-requests');
    assert.equal(seen.options.headers.get('idempotency-key'),'original-channel-key');assert.equal(seen.options.headers.get('origin'),'http://127.0.0.1:3100');
    assert.equal(new TextDecoder().decode(seen.options.body),body);assert.equal(seen.options.redirect,'error');
  }finally{globalThis.fetch=old;}
});

test('channel paths retain origin and bearer rejection and do not open nested or legacy channel commands',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  try{
    const p=['order_channel','channel-payment-requests'];
    assert.equal((await POST(input(p,{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:'{}'}),ctx(p))).status,403);
    assert.equal((await GET(input(p,{headers:{authorization:'Bearer unsafe'}}),ctx(p))).status,403);
    for(const path of [[...p,'refresh'],['legacy','old_order','channel-payment-requests']]){
      assert.equal((await POST(input(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),ctx(path))).status,404);
    }
    assert.equal(calls,0);
  }finally{globalThis.fetch=old;}
});

const channelSubjectCtx={params:Promise.resolve({path:['order_subject','channel-payment-requests']})};
const channelSubjectRequest=(method='POST',user='user_a')=>new Request('http://127.0.0.1:3100/api/orders/order_subject/channel-payment-requests',{method,headers:{origin:'http://127.0.0.1:3100','content-type':'application/json',cookie:'zzsh_user.session_token=synthetic_user_b; zzsh_admin.session_token=not-forwarded','idempotency-key':'original_subject_key',...(user?{'x-zzsh-expected-user-id':user}:{})},...(method==='POST'?{body:'{"method":"WEIXIN_NATIVE"}'}:{})});
test('channel command from page A with captured cookie B never reaches a payment command',async()=>{const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push(String(url));return String(url).endsWith('/get-session')?Response.json({user:{id:'user_b'}}):Response.json({request:{id:'must_not_submit'}});};try{const r=await POST(channelSubjectRequest(),channelSubjectCtx);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'IDENTITY_CHANGED');assert.equal(calls.filter(s=>s.includes('/channel-payment-requests')).length,0);}finally{globalThis.fetch=old;}});
test('channel local GET checks the captured session subject before exposing a projection',async()=>{const old=globalThis.fetch,calls=[];globalThis.fetch=async(url)=>{calls.push(String(url));return Response.json({user:{id:'user_b'}});};try{const r=await GET(channelSubjectRequest('GET'),channelSubjectCtx);assert.equal(r.status,401);assert.equal(calls.filter(s=>s.includes('/channel-payment-requests')).length,0);}finally{globalThis.fetch=old;}});
test('missing expected subject is rejected before any upstream fetch',async()=>{const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};try{assert.equal((await POST(channelSubjectRequest('POST',null),channelSubjectCtx)).status,400);assert.equal(calls,0);}finally{globalThis.fetch=old;}});
test('matched subject preserves captured user cookie and original key/body, stripping internal header',async()=>{const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return String(url).endsWith('/get-session')?Response.json({user:{id:'user_a'}}):Response.json({request:{id:'synthetic_request'}},{status:202});};try{const r=await POST(channelSubjectRequest(),channelSubjectCtx);assert.equal(r.status,202);assert.equal(calls.length,2);for(const c of calls)assert.equal(c.options.headers.get('cookie'),'zzsh_user.session_token=synthetic_user_b');const c=calls[1];assert.equal(c.options.headers.get('idempotency-key'),'original_subject_key');assert.equal(c.options.headers.has('x-zzsh-expected-user-id'),false);assert.equal(new TextDecoder().decode(c.options.body),'{"method":"WEIXIN_NATIVE"}');}finally{globalThis.fetch=old;}});
test('failed or malformed session evidence cannot cause a channel command',async()=>{const old=globalThis.fetch;try{for(const response of [()=>Response.json(null),()=>Response.json({user:null}),()=>Response.json({user:{id:7}}),()=>new Response('not-json'),()=>Response.json({error:{code:'UNAUTHENTICATED'}},{status:401})]){const commands=[];globalThis.fetch=async(url)=>{if(!String(url).endsWith('/get-session'))commands.push(String(url));return response();};const r=await POST(channelSubjectRequest(),channelSubjectCtx);assert(r.status>=400);assert.equal(commands.length,0);}}finally{globalThis.fetch=old;}});

test('channel query forwards only the original-number command with captured subject and no idempotency key',async()=>{
  const old=globalThis.fetch;let calls=[];
  const receipt={contractVersion:'order-payment-request.v1',request:{id:'payreq_q',orderId:'order_q',state:'UNKNOWN'},query:{kind:'OBSERVED',event:'E4',result:'QUERY_SUCCEEDED'}};
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return String(url).endsWith('/get-session')?Response.json({user:{id:'user_a'}}):Response.json(receipt);};
  try{
    const path=['order_q','channel-payment-requests','query'];
    const response=await POST(input(path,{method:'POST',headers:{'content-type':'application/json','x-zzsh-expected-user-id':'user_a',cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin'},body:'{}'}),ctx(path));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),receipt);assert.equal(calls.length,2);
    const upstream=calls[1];
    assert.equal(upstream.url,'http://127.0.0.1:3102/api/bff/user/orders/order_q/channel-payment-requests/query');
    assert.equal(upstream.options.method,'POST');assert.equal(upstream.options.headers.has('idempotency-key'),false);
    assert.equal(upstream.options.headers.has('x-zzsh-expected-user-id'),false);
    assert.equal(upstream.options.headers.get('cookie'),'zzsh_user.session_token=user');
    assert.equal(new TextDecoder().decode(upstream.options.body),'{}');
  }finally{globalThis.fetch=old;}
});

test('channel query rejects legacy/nested paths and identity changes before any upstream command',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({user:{id:'user_b'}});};
  try{
    for(const path of [['legacy','old_order','channel-payment-requests','query'],['order_q','channel-payment-requests','query','extra']]){
      assert.equal((await POST(input(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),ctx(path))).status,404);
    }
    const path=['order_q','channel-payment-requests','query'];
    const response=await POST(input(path,{method:'POST',headers:{'content-type':'application/json','x-zzsh-expected-user-id':'user_a'},body:'{}'}),ctx(path));
    assert.equal(response.status,401);assert.equal((await response.json()).error.code,'IDENTITY_CHANGED');
    assert.equal(calls,1);
  }finally{globalThis.fetch=old;}
});

test('refund read forwards GET with the captured user cookie and strips the identity header',async()=>{
  const old=globalThis.fetch,calls=[];
  const projection={contractVersion:'personal-native-refunds.v1',subjectId:'user_a',order:{orderId:'order_r',displayNo:'ZZ-R',status:'PAID'},outcome:'RESPONSIBILITY_NOT_POSTED'};
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});return String(url).endsWith('/get-session')?Response.json({user:{id:'user_a'}}):Response.json({...projection,extra:'kept'});};
  try{
    const path=['order_r','refunds'];
    const response=await GET(input(path,{headers:{cookie:'zzsh_user.session_token=user; zzsh_admin.session_token=admin','x-zzsh-expected-user-id':'user_a'}}),ctx(path));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{...projection,extra:'kept'});assert.equal(calls.length,2);
    assert.equal(calls[1].url,'http://127.0.0.1:3102/api/bff/user/orders/order_r/refunds');
    assert.equal(calls[1].options.method,'GET');assert.equal(calls[1].options.headers.get('cookie'),'zzsh_user.session_token=user');
    assert.equal(calls[1].options.headers.has('x-zzsh-expected-user-id'),false);
  }finally{globalThis.fetch=old;}
});

test('refund read requires the expected subject, no query and the captured session subject',async()=>{
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({user:{id:'user_b'}});};
  try{
    const path=['order_r','refunds'];
    assert.equal((await GET(input(path,{headers:{}}),ctx(path))).status,400);
    assert.equal((await GET(input(path,{headers:{'x-zzsh-expected-user-id':'user_a'}}, '?any=1'),ctx(path))).status,400);
    assert.equal((await POST(input(path,{method:'POST',headers:{'content-type':'application/json','x-zzsh-expected-user-id':'user_a'},body:'{}'}),ctx(path))).status,404);
    assert.equal(calls,0);
    const changed=await GET(input(path,{headers:{'x-zzsh-expected-user-id':'user_a'}}),ctx(path));
    assert.equal(changed.status,401);assert.equal((await changed.json()).error.code,'IDENTITY_CHANGED');assert.equal(calls,1);
  }finally{globalThis.fetch=old;}
});

test('a refund projection with the wrong contract, subject or order never reaches the page',async()=>{
  const old=globalThis.fetch;
  const valid={contractVersion:'personal-native-refunds.v1',subjectId:'user_a',order:{orderId:'order_r'}};
  try{
    for(const mutation of [{contractVersion:'personal-native-refunds.v0'},{subjectId:'user_b'},{order:{orderId:'order_other'}}]){
      globalThis.fetch=async(url)=>String(url).endsWith('/get-session')?Response.json({user:{id:'user_a'}}):Response.json({...valid,...mutation});
      const path=['order_r','refunds'];
      const response=await GET(input(path,{headers:{'x-zzsh-expected-user-id':'user_a'}}),ctx(path));
      assert.equal(response.status,502);assert.equal((await response.json()).error.code,'INTERNAL_ERROR');
    }
    globalThis.fetch=async(url)=>String(url).endsWith('/get-session')?Response.json({user:{id:'user_a'}}):new Response('not-json',{status:200});
    const path=['order_r','refunds'];
    assert.equal((await GET(input(path,{headers:{'x-zzsh-expected-user-id':'user_a'}}),ctx(path))).status,502);
  }finally{globalThis.fetch=old;}
});
