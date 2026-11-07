import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {revalidateReviewedSkinMappings,bindReboundOverlayToSpec} from './rebind-reviewed-skin-overlay.mjs';

function fixture(){
 const mappings=Array.from({length:5},(_,i)=>({field:'weapon_skin',token:'token'+i,sourceRows:[{dictField:'weapon_skin',dictTypeId:1,dictDataId:i+1,state:'CURRENT'}],target:{skinId:'old'+i,sourceNamespace:'ns',sourceField:'weapon_skin',sourceToken:'token'+i,name:'name'+i,ownerKind:'FIREARM'}}));
 const dictionary=mappings.map((m,i)=>({id:String(i+1),type_id:'1',name:m.token,value:m.token,is_delete:'0'})),types=new Map([['1',{dict_type:'weapon_skin'}]]),catalog=mappings.map(m=>({gameId:'new-game',...m.target,namingState:'VERIFIED',enabled:true,formVisible:true}));
 return{original:{mappings},dictionary,types,catalog};
}
test('unchanged reviewed source and exact target rebind without old-account assumptions',()=>{
 const f=fixture(),result=revalidateReviewedSkinMappings(f.original,f.dictionary,f.types,f.catalog,'new-game');
 assert.equal(result.mappings.length,5);assert.equal(result.isolated.length,0);assert.deepEqual(result.mappings.map(x=>x.target.skinId),['old0','old1','old2','old3','old4']);
});
test('changed, missing or additional source dictionary rows isolate only affected mappings',()=>{
 for(const change of [f=>{f.dictionary[0].is_delete='1'},f=>{f.dictionary.shift()},f=>{f.dictionary.push({...f.dictionary[0],id:'99'})}]){
  const f=fixture();change(f);const r=revalidateReviewedSkinMappings(f.original,f.dictionary,f.types,f.catalog,'new-game');
  assert.equal(r.mappings.length,4);assert.equal(r.isolated.length,1);assert.equal(r.isolated[0].reason,'SOURCE_DICTIONARY_CHANGED');
 }
});
test('changed, unavailable or duplicate target semantics never silently inherit an old mapping',()=>{
 for(const [change,reason] of [[f=>{f.catalog[0].name='changed'},'TARGET_CHANGED_OR_MISSING'],[f=>{f.catalog[0].skinId='new-id'},'TARGET_ID_CHANGED'],[f=>{f.catalog[0].enabled=false},'TARGET_NOT_AVAILABLE'],[f=>{f.catalog.push({...f.catalog[0],skinId:'duplicate'})},'TARGET_AMBIGUOUS']]){
  const f=fixture();change(f);const r=revalidateReviewedSkinMappings(f.original,f.dictionary,f.types,f.catalog,'new-game');assert.equal(r.mappings.length,4);assert.equal(r.isolated[0].reason,reason);
 }
});
test('duplicate previously reviewed source keys are rejected',()=>{const f=fixture();f.original.mappings[1]={...f.original.mappings[0]};assert.throws(()=>revalidateReviewedSkinMappings(f.original,f.dictionary,f.types,f.catalog,'new-game'),/SKIN_REBIND_DUPLICATE_REVIEWED_MAPPING/);});
test('final round spec binds the preliminary source and target to the reviewed overlay',()=>{
 const target={oid:'42',nonce:'n',instance:{port:55433}},spec={schema:'zzsh.round07-assembly-spec.v1',kind:'round',paths:{source:'E:/data/source',credentials:'E:/data/credentials',roundOutput:'E:/data/output'}},preliminary={schema:'zzsh.local-round.v1',source:{path:spec.paths.source,sha256:'source'},credentials:spec.paths.credentials,out:spec.paths.roundOutput,target};
 const rebindInput={schema:'zzsh.reviewed-skin-overlay-rebind-input.v1',roundInput:{sha256:'prelim'}},receipt={schema:'zzsh.reviewed-skin-overlay-rebind-receipt.v1',status:'ALL_REVIEWED_MAPPINGS_REBOUND',inputSha256:'rebind',sourceSha256:'source',sourceExtractSha256:'extract',sourceDictionarySha256:'dictionary',catalogRevision:'1',target,overlay:{path:'E:/data/overlay.json',sha256:'overlay'},targetWrites:0,readOnlyRollbackAck:true,clientClosed:true},overlay={sourceReceiptSha256:'source',sourceExtractSha256:'extract',sourceDictionarySha256:'dictionary',catalogRevision:'1'},args={spec,preliminary,preliminarySha256:'prelim',rebindInput,rebindInputSha256:'rebind',receipt,overlay,overlaySha256:'overlay'};
 assert.equal(bindReboundOverlayToSpec(args).paths.holdingOverlay,receipt.overlay.path);assert.equal(spec.paths.holdingOverlay,undefined);
 for(const changed of [{...args,preliminarySha256:'other'},{...args,receipt:{...receipt,target:{...target,oid:'wrong'}}},{...args,overlay:{...overlay,sourceDictionarySha256:'wrong'}},{...args,spec:{...spec,paths:{...spec.paths,holdingOverlay:'old'}}},{...args,receipt:{...receipt,status:'PARTIAL_REVIEW_REQUIRED'}}])assert.throws(()=>bindReboundOverlayToSpec(changed));
 assert.equal(bindReboundOverlayToSpec({...args,receipt:{...receipt,status:'PARTIAL_REVIEW_REQUIRED'},acceptPartial:true}).paths.holdingOverlay,receipt.overlay.path);
});
test('generic skin rebind defaults to no connection or write',()=>{const p=spawnSync(process.execPath,[new URL('./rebind-reviewed-skin-overlay.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')],{encoding:'utf8'});assert.equal(p.status,0);const result=JSON.parse(p.stdout);assert.equal(result.connections,0);assert.equal(result.targetWrites,0);});
