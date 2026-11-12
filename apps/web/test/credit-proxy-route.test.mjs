import assert from 'node:assert/strict';import {test} from 'node:test';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const{GET,POST}=await import('../src/app/api/account/credit/[[...path]]/route.ts');
const base='http://127.0.0.1:4200/api/account/credit',ctx=(path=[])=>({params:Promise.resolve({path})});
test('GAP-012 credit proxy GET allowlist equals core reader: only / and /overview are forwarded',async()=>{
  const previous=globalThis.fetch;const seen=[];globalThis.fetch=async(u)=>{seen.push(String(u));return Response.json({creditState:'NOT_INITIALIZED',credit:null});};
  try{
    assert.equal((await GET(new Request(base),ctx())).status,200);
    assert.equal((await GET(new Request(base+'/overview'),ctx(['overview']))).status,200);
    for(const extra of [['events'],['guarantees'],['overview','x'],['recovery-requests']]){const r=await GET(new Request(base+'/'+extra.join('/')),ctx(extra));assert.equal(r.status,403,extra.join('/'));}
    assert.deepEqual(seen,['http://127.0.0.1:4202/api/v1/users/me/credit','http://127.0.0.1:4202/api/v1/users/me/credit/overview']);
  }finally{globalThis.fetch=previous;}
});
test('demo guarantee confirmation forwards only its bounded route and original key',async()=>{
  const previous=globalThis.fetch,seen=[];globalThis.fetch=async(url,init)=>{seen.push({url:String(url),method:init.method,key:init.headers.get('idempotency-key')});return Response.json({status:'CONFIRMED'});};
  const parts=['accounts','account-1','payment-intents','pay-1','demo-confirm'];
  const request=(origin='http://127.0.0.1:4200')=>new Request(base+'/'+parts.join('/'),{method:'POST',headers:{origin,'content-type':'application/json','idempotency-key':'original-key'},body:'{}'});
  try{
    assert.equal((await POST(request(),ctx(parts))).status,200);
    assert.deepEqual(seen,[{url:'http://127.0.0.1:4202/api/v1/users/me/credit/accounts/account-1/payment-intents/pay-1/demo-confirm',method:'POST',key:'original-key'}]);
    assert.equal((await POST(request('https://other.invalid'),ctx(parts))).status,403);
    assert.equal((await POST(request(),ctx(['accounts','account-1','payment-intents','pay-1','other']))).status,403);
    assert.equal(seen.length,1);
  }finally{globalThis.fetch=previous;}
});
