import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupForField,supplyRecovery,SupplyRequestError,supplyRequest,supplyApi,editableDeclaration,mergeInventory,inventoryEditorRows,inventoryPriceHint} from '../src/lib/supply-client.ts';
test('draft inventory keeps exact quantities and shows unpriced lines',()=>{
  const catalog={items:[{id:'priced',name:'哈夫币',unit:'HAFF_BASE',required:true}]};
  const inventory=[{itemId:'priced',quantity:'0'},{itemId:'extra',quantity:'0'},{itemId:'unknown',quantity:null}];
  assert.deepEqual(mergeInventory({inventory},catalog),inventory);
  assert.deepEqual(mergeInventory({inventory:[]},catalog),[]);
  const rows=inventoryEditorRows(catalog,inventory,[{id:'extra',name:'六级头盔',unit:'PIECE',priced:false}]);
  assert.deepEqual(rows.map(row=>[row.itemId,row.name,row.quantity,row.priced,row.unit]),[
    ['priced','哈夫币','0',true,'HAFF_BASE'],
    ['extra','六级头盔','0',false,'PIECE'],
    ['unknown','未确认（unknown）',null,false,null],
  ]);
  assert.equal(rows.some(row=>row.quantity==='0'&&row.itemId==='unknown'),false);
});
test('current catalog membership overrides an older priced label and keeps unknown separate',()=>{
  const stale=[{id:'retained-stock',name:'先前读取的物品',unit:'PIECE',priced:true},{id:'kept',name:'旧名',unit:'ROUND',priced:false}];
  const excluded=inventoryEditorRows({items:[]},[{itemId:'retained-stock',quantity:'5'}],stale);
  assert.equal(excluded.length,1);
  assert.deepEqual(excluded[0],{itemId:'retained-stock',name:'先前读取的物品',unit:'PIECE',quantity:'5',priced:false,required:false,catalogState:'ready'});
  assert.equal(inventoryPriceHint(excluded[0]),'未进入当前可用价目，不可报价');
  const inventory=[{itemId:'kept',quantity:'4'},{itemId:'zero',quantity:'0'},{itemId:'missing',quantity:null}];
  const labels=[{id:'zero',name:'六级子弹',unit:'ROUND',priced:true},{id:'missing',name:'六级头盔',unit:'PIECE',priced:true}];
  const pending=inventoryEditorRows(null,inventory,labels);
  const failed=inventoryEditorRows(null,inventory,labels,'failed');
  assert.deepEqual(pending.map(row=>[row.itemId,row.quantity,row.priced,row.catalogState,row.name]),[['kept','4',null,'pending','未确认（kept）'],['zero','0',null,'pending','六级子弹'],['missing',null,null,'pending','六级头盔']]);
  assert.deepEqual(failed.map(row=>[row.priced,row.catalogState]),[[null,'failed'],[null,'failed'],[null,'failed']]);
  assert.equal(inventoryPriceHint(pending[0]),'发布目录尚未加载，暂不能判断可否报价');
  assert.equal(inventoryPriceHint(failed[0]),'发布目录读取失败，暂不能判断可否报价');
  const ready=inventoryEditorRows({items:[{id:'kept',name:'目录内物品',unit:'PIECE',required:true}]},inventory,stale.concat(labels));
  assert.deepEqual(ready.map(row=>[row.itemId,row.name,row.unit,row.quantity,row.priced,row.catalogState]),[
    ['kept','目录内物品','PIECE','4',true,'ready'],
    ['zero','六级子弹','ROUND','0',false,'ready'],
    ['missing','六级头盔','PIECE',null,false,'ready'],
  ]);
  assert.equal(inventoryPriceHint(ready[0]),null);
});
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
test('public browse calls keep contract paths and forward abort signals',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,signal:init?.signal});return Response.json({items:[],games:[],skins:[]});};
  const controller=new AbortController();
  try{
    await supplyApi.browseCatalog('game_1',new URLSearchParams({limit:'100'}),controller.signal);
    await supplyApi.market(new URLSearchParams({gameId:'game_1'}),controller.signal);
    await supplyApi.listing('account_1',controller.signal);
    assert.deepEqual(calls.map(call=>call.url),['/api/supply/games/game_1/catalog?limit=100','/api/supply/listings?gameId=game_1','/api/supply/listings/account_1']);
    assert.ok(calls.every(call=>call.signal===controller.signal));
  }finally{globalThis.fetch=old;}
});
test('publish reads use the current catalog and rule-release endpoints with cancellation',async()=>{
  const old=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url,signal:init?.signal});return Response.json({});};
  const controller=new AbortController();
  try{
    await supplyApi.publishingOptions('game_1',controller.signal);
    await supplyApi.catalog('game_1',new URLSearchParams({limit:'30',q:'skin'}),controller.signal);
    await supplyApi.mine('account_1',controller.signal);
    await supplyApi.myAccounts(new URLSearchParams({limit:'20'}),controller.signal);
    assert.deepEqual(calls.map(call=>call.url),['/api/supply/games/game_1/publishing-options','/api/supply/games/game_1/publishing-catalog?limit=30&q=skin','/api/supply/accounts/account_1','/api/supply/me/accounts?limit=20']);
    assert.ok(calls.every(call=>call.signal===controller.signal));
  }finally{globalThis.fetch=old;}
});
