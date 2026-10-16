import assert from 'node:assert/strict';import {test} from 'node:test';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const{GET}=await import('../src/app/api/account/credit/[[...path]]/route.ts');
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
