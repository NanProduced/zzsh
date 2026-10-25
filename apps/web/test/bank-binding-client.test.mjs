import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseBankBinding,readBankBinding,saveBankBinding,recoverBankBinding,pendingBankBinding,validateBankBindingInput} from '../src/lib/withdrawal-bank-binding-client.ts';
import {userId,bankRead,json,withStorage} from './withdrawal-fixtures.mjs';
const input={name:' 测试用户 ',cardNo:'0000 0000 0000 0000',expectedRevision:'0'};

test('bank binding distinguishes unreadable integration from unbound and projects only masks',()=>{
 assert.deepEqual(parseBankBinding({contractVersion:'withdrawal-bank-binding.v1',integration:'NOT_INTEGRATED',binding:null,expectedRevision:null}),{contractVersion:'withdrawal-bank-binding.v1',integration:'NOT_INTEGRATED',binding:null,expectedRevision:null});
 assert.equal(parseBankBinding({contractVersion:'withdrawal-bank-binding.v1',integration:'INTEGRATED',binding:null,expectedRevision:'0'}).expectedRevision,'0');
 const raw=bankRead();raw.binding.name='PRIVATE_NAME';raw.binding.cardNo='PRIVATE_CARD';const parsed=parseBankBinding(raw);assert(!JSON.stringify(parsed).includes('PRIVATE_'));assert.equal(parsed.binding.ownershipVerification,'NOT_VERIFIED');
 assert.throws(()=>parseBankBinding({...raw,expectedRevision:'2'}));
 assert.throws(()=>validateBankBindingInput({...input,cardNo:'**** **** 0000'}));
 assert.equal(validateBankBindingInput(input).cardNo,'0000000000000000');
});
test('failed bank save persists only user/key/revision and recovers original receipt then current binding',()=>withStorage(async({values})=>{
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});throw Error('offline transport loss');};
 await assert.rejects(()=>saveBankBinding(userId,input),e=>e.uncertain===true);
 const pending=pendingBankBinding(userId);assert(pending);const stored=[...values.values()][0];assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['expectedRevision','key','userId']);assert(!stored.includes('测试'));assert(!stored.includes('0000000000000000'));
 assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers['idempotency-key'],pending.key);
 assert.deepEqual(JSON.parse(calls[0].init.body),{name:'测试用户',cardNo:'0000000000000000',expectedRevision:'0'});
 globalThis.fetch=async(url)=>String(url).includes('/receipt?')?json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead('1','0000')}):json(bankRead('3','2222'));
 const recovered=await recoverBankBinding(userId);assert.equal(recovered.receipt.binding.revision,'1');assert.equal(recovered.current.binding.revision,'3');assert.equal(recovered.current.binding.cardMask,'**** **** 2222');assert.equal(pendingBankBinding(userId),null);
}));
test('UNKNOWN keeps original key; refresh recovery requires explicit resume and original revision',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);
 await assert.rejects(()=>saveBankBinding(userId,input));const first=pendingBankBinding(userId);
 globalThis.fetch=async()=>json({integration:'INTEGRATED',knowledge:'UNKNOWN',receipt:null});
 assert.equal((await recoverBankBinding(userId)).knowledge,'UNKNOWN');assert.equal(pendingBankBinding(userId).key,first.key);
 await assert.rejects(()=>saveBankBinding(userId,input),e=>e.code==='PENDING_REQUEST_EXISTS');
 await assert.rejects(()=>saveBankBinding(userId,{...input,expectedRevision:'4'},{resume:true,expectedPending:first}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');
 const seen=[];globalThis.fetch=async(url,init)=>{seen.push({url:String(url),init});return json(bankRead());};
 await saveBankBinding(userId,input,{resume:true,expectedPending:first});assert.equal(seen[0].init.headers['idempotency-key'],first.key);assert.equal(seen[1].init.method,'GET');assert.equal(pendingBankBinding(userId),null);
}));
test('storage failure blocks bank POST and identity switch keeps old marker without disclosing result',()=>withStorage(async({storage})=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};const original=storage.setItem;storage.setItem=()=>{throw Error('blocked');};
 await assert.rejects(()=>saveBankBinding(userId,input),e=>e.code==='RECOVERY_STORAGE_UNAVAILABLE');assert.equal(calls,0);storage.setItem=original;
 let current=true;globalThis.fetch=async()=>{current=false;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,input,{isCurrent:()=>current}),e=>e.code==='IDENTITY_CHANGED');assert(pendingBankBinding(userId));assert.equal(pendingBankBinding('another_user'),null);
}));
test('known bank save followed by unavailable current read is not an unknown command',()=>withStorage(async()=>{
 globalThis.fetch=async(_url,init)=>init.method==='POST'?json(bankRead()):json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);
 await assert.rejects(()=>saveBankBinding(userId,input),e=>e.code==='BANK_BINDING_CURRENT_READ_UNAVAILABLE'&&!e.uncertain);assert.equal(pendingBankBinding(userId),null);
}));
test('no pending marker does not invent an INTEGRATED recovery result',()=>withStorage(async()=>{await assert.rejects(()=>recoverBankBinding(userId),e=>e.code==='NO_PENDING_REQUEST');}));
test('explicit resume without its original marker never becomes a new save',()=>withStorage(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,input,{resume:true}),e=>e.code==='NO_PENDING_REQUEST');assert.equal(calls,0);assert.equal(pendingBankBinding(userId),null);
}));
test('resume freezes selected key and version instead of following a replaced recovery marker',()=>withStorage(async({storage})=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);await assert.rejects(()=>saveBankBinding(userId,input));const original=pendingBankBinding(userId);
 const replacement={...original,key:'different-request'};storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,input,{resume:true,expectedPending:original}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');assert.equal(calls,0);assert.deepEqual(pendingBankBinding(userId),replacement);
}));
test('in-flight resume retains its selected key and cannot settle a replacement marker',()=>withStorage(async({storage})=>{
 const original={userId,key:'original-request',expectedRevision:'0'},replacement={userId,key:'newer-request',expectedRevision:'4'};
 storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(original));let sentKey;
 globalThis.fetch=async(_url,init)=>{sentKey=init.headers['idempotency-key'];storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,input,{resume:true,expectedPending:original}),e=>e.code==='RECOVERY_CONTEXT_CHANGED');
 assert.equal(sentKey,original.key);assert.deepEqual(pendingBankBinding(userId),replacement);
}));
test('a selected recovery context cannot be downgraded to a fresh save',()=>withStorage(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return json(bankRead());};
 await assert.rejects(()=>saveBankBinding(userId,input,{resume:false,expectedPending:{userId,key:'old-key',expectedRevision:'0'}}),e=>e.code==='PENDING_REQUEST_EXISTS');assert.equal(calls,0);assert.equal(pendingBankBinding(userId),null);
}));
test('contradictory original receipt revision cannot resolve a bank recovery marker',()=>withStorage(async()=>{
 globalThis.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);await assert.rejects(()=>saveBankBinding(userId,input));const original=pendingBankBinding(userId);
 const calls=[];globalThis.fetch=async url=>{calls.push(String(url));return json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead('9','9999')});};
 await assert.rejects(()=>recoverBankBinding(userId),e=>e.code==='WITHDRAWAL_CONTRACT_REQUIRED');assert.deepEqual(pendingBankBinding(userId),original);assert.equal(calls.length,1);
}));
test('selected original-key read remains read-only after marker loss and never clears a replacement',()=>withStorage(async({storage})=>{
 const original={userId,key:'selected-original',expectedRevision:'0'};const replacement={userId,key:'newer-request',expectedRevision:'3'};storage.setItem('zzsh.bank-binding-recovery.v1:'+userId,JSON.stringify(replacement));const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init.method});return String(url).includes('/receipt?')?json({integration:'INTEGRATED',knowledge:'KNOWN',receipt:bankRead()}):json(bankRead('4','4444'));};
 const result=await recoverBankBinding(userId,{expectedPending:original});assert.equal(result.knowledge,'KNOWN');assert(calls[0].url.includes('key=selected-original'));assert(calls.every(x=>x.method==='GET'));assert.deepEqual(pendingBankBinding(userId),replacement);
 storage.removeItem('zzsh.bank-binding-recovery.v1:'+userId);await recoverBankBinding(userId,{expectedPending:original});assert.equal(pendingBankBinding(userId),null);
}));
