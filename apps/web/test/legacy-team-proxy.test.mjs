import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:3102';
process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:3100';
const {forwardOrderRequest}=await import('../src/lib/order-proxy.ts');
const order='legacy_order_'+'a'.repeat(40),headers={'x-zzsh-expected-user-id':'user_a',cookie:'zzsh_user.session_token=fixture'};
const run=(path,extra={})=>forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/'+path,{headers:{...headers,...extra}}),{params:Promise.resolve({path:path.split('/')})});

test('legacy group BFF binds session and response subject for lists and detail',async()=>{
 const previous=globalThis.fetch;let session='user_a',subject='user_a',returnedOrder=order,calls=[];
 globalThis.fetch=async(input,init)=>{const url=String(input);calls.push({url,init});return Response.json(url.endsWith('/get-session')?{user:{id:session}}:url.includes('legacy-im-groups')?{subjectId:subject,items:[],nextCursor:null}:{subjectId:subject,orderId:returnedOrder,canRead:true});};
 try{
  assert.equal((await run('legacy-im-groups?party=renter')).status,404,'route params exclude the query string');
  const list=()=>forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/legacy-im-groups?party=renter',{headers}),{params:Promise.resolve({path:['legacy-im-groups']})});
  assert.equal((await list()).status,200);assert.equal((await run(order+'/im')).status,200);
  assert(calls.every(call=>call.init.headers.get('cookie')==='zzsh_user.session_token=fixture'));
  session='user_b';assert.equal((await list()).status,401);session='user_a';subject='user_b';assert.equal((await list()).status,502);
  subject='user_a';returnedOrder='legacy_order_'+'b'.repeat(40);assert.equal((await run(order+'/im')).status,502);
  const missing=await forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/legacy-im-groups'),{params:Promise.resolve({path:['legacy-im-groups']})});assert.equal(missing.status,400);
 }finally{globalThis.fetch=previous;}
});
