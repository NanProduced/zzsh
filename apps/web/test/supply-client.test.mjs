import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupForField,supplyRecovery,SupplyRequestError,supplyRequest,supplyApi,editableDeclaration} from '../src/lib/supply-client.ts';
test('supply recovery locates groups and never overwrites stale drafts',()=>{
  assert.equal(groupForField('inventory[2].quantity'),'inventory');assert.equal(groupForField('mediaBindings.0.assetId'),'media');assert.equal(groupForField('attributes.vit_level'),'basics');
  const e=new SupplyRequestError(409,{error:{code:'CONFLICT',message:'version changed',requestId:'r'}});
  assert.deepEqual(supplyRecovery(e),{action:'RELOAD_AND_CONFIRM',groups:[],preserveDraft:true});
  assert.equal(supplyRecovery(new SupplyRequestError(401,null)).action,'LOGIN');
  const draft=editableDeclaration({title:'资料',description:null,attributes:{},inventory:[],skins:[],entitlements:[],termOptionCode:'daily',pricingOptionCode:'standard',mediaBindings:[{assetId:'a',position:0,purpose:'ACCOUNT_EVIDENCE',byteHash:'server-only'}]});
  assert.deepEqual(draft.mediaBindings,[{assetId:'a',position:0}]);
  assert.equal(groupForField('rules'),'rules');
  assert.equal(supplyRecovery(new SupplyRequestError(500,{})).action,'RETRY_SAME_REQUEST');
});
test('user calls carry explicit replay keys, no price calculation or automatic retries',async()=>{
  const old=globalThis.fetch;let count=0;globalThis.fetch=async(url,init)=>{count++;assert.equal(url,'/api/supply/favorites/a');assert.equal(init.headers['idempotency-key'],'stable-key');assert.deepEqual(JSON.parse(init.body),{saved:true});return Response.json({accountId:'a',saved:true});};
  try{assert.deepEqual(await supplyApi.setFavorite('a',true,'stable-key'),{accountId:'a',saved:true});assert.equal(count,1);globalThis.fetch=async()=>{count++;throw Error('network');};await assert.rejects(()=>supplyRequest('/favorites/a',{method:'PUT',body:{saved:true},idempotencyKey:'stable-key'}),e=>e.idempotencyKey==='stable-key'&&e.status===0);assert.equal(count,2);}finally{globalThis.fetch=old;}
});
