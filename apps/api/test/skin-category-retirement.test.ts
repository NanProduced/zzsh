import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {createCatalogEntry,updateCatalogEntry,readPublicCatalog,parseSkinWrite} from '../src/supply/catalog';
import {readPresentation,readDraftSkinSummary} from '../src/supply/publishing';
import type {ListingVersion} from '../src/supply/publishing';
import {parseListingFilters,parseFilterConfig,type ListingQueryV2} from '../src/supply/listing-filter-contract';
import {publicFilterMetadata,validateConfigCatalog,validateListingQuery,type listingCatalogContext,type readListingState} from '../src/supply/listing-filter-config';

const retired=(error:unknown)=>(error as {status?:number;code?:string}).status===410&&(error as {code?:string}).code==='SKIN_CATEGORY_RETIRED';
function writer(ready=true){
 const calls:{sql:string;args:unknown[]}[]=[];
 const old={id:'skin',game_id:'game',code:'stable',name:'Old',rarity_code:null,media_id:null,sort_order:0,enabled:false,form_visible:false,naming_state:'PENDING',aliases:[],owner_kind:null,owner_id:null,firearm_id:null,base_name:null,source_namespace:null,source_field:null,source_token:null};
 const client={query:async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});let rows:unknown[]=[];
  if(sql.includes('categoryless-skin-storage'))rows=[{ready}];
  else if(sql.includes('SELECT catalog_revision::text'))rows=[{revision:'10'}];
  else if(sql.startsWith('UPDATE zzsh_supply.game'))rows=[{revision:'11'}];
  else if(sql.startsWith('SELECT * FROM "zzsh_supply"."skin"'))rows=[old];
  else if(sql.startsWith('UPDATE zzsh_supply.skin SET'))rows=[{namingState:'PENDING'}];
  else if(sql.includes('FROM "zzsh_supply"."game"'))rows=[{id:'game',code:'delta',catalogRevision:'10'}];
  else if(sql.includes('SELECT 1 FROM "zzsh_supply"."skin"'))rows=[];
  else if(!sql.startsWith('INSERT INTO zzsh_supply.skin'))throw Error('Unexpected writer model SQL');
  return{rows,rowCount:rows.length};}} as unknown as PoolClient;
 return{client,calls};
}
test('new categoryless draft requires the completed physical migration',async()=>{
 const f=writer();await createCatalogEntry(f.client,'admin',true,'skins','game',{code:'new_skin',name:'New',expectedCatalogRevision:'10'});
 const insert=f.calls.find(c=>c.sql.startsWith('INSERT INTO zzsh_supply.skin'))!;assert(!insert.sql.includes('category_id'));assert.match(insert.sql,/false,false/);
 const blocked=writer(false);await assert.rejects(createCatalogEntry(blocked.client,'admin',true,'skins','game',{code:'new_skin',name:'New',expectedCatalogRevision:'10'}),(e:unknown)=>(e as {status:number}).status===503);
 assert(!blocked.calls.some(c=>c.sql.startsWith('INSERT')));
});
test('legacy category writes fail explicitly; normal updates do not touch removed columns',async()=>{
 assert.throws(()=>parseSkinWrite({code:'x',name:'New',categoryId:'old',expectedCatalogRevision:'10'},false),retired);
 await assert.rejects(createCatalogEntry(writer().client,'admin',true,'skins','game',{code:'new_skin',name:'New',categoryId:'old',expectedCatalogRevision:'10'}),retired);
 await assert.rejects(createCatalogEntry(writer().client,'admin',true,'categories','game',{code:'old_group',name:'Gold'}),retired);
 await assert.rejects(updateCatalogEntry(writer().client,'admin',true,'categories','old_cat',{name:'Other'}),retired);
 const f=writer();await updateCatalogEntry(f.client,'admin',true,'skins','skin',{expectedCatalogRevision:'10',sortOrder:2});assert(!f.calls.find(c=>c.sql.startsWith('UPDATE zzsh_supply.skin SET'))!.sql.includes('category_id'));
});
test('public catalog has no old category query and rejects categoryId',async()=>{
 const queries:string[]=[];const client={query:async(sql:string)=>{queries.push(sql);let rows:unknown[]=[];
  if(sql.includes('FROM "zzsh_supply"."game"'))rows=[{id:'game',code:'delta',name:'Delta',catalogRevision:'10',currentReleaseId:'release'}];
  else if(sql.includes('FROM "zzsh_supply"."skin" s')&&!sql.startsWith('SELECT DISTINCT'))rows=[{id:'skin',code:'new',name:'New',categoryId:null,ownerKind:'MELEE_TYPE',ownerId:null,ownerName:null,rarityCode:null,sortOrder:0}];
  return{rows,rowCount:rows.length};}} as unknown as PoolClient;
 const result=await readPublicCatalog(client,'game',{},20) as {skins:unknown[];categories:unknown[];skinCategoryModel:{mode:string}};
 assert.equal(result.skins.length,1);assert.deepEqual(result.categories,[]);assert.equal(result.skinCategoryModel.mode,'RETIRED');
 assert(!queries.some(sql=>/FROM\s+"?zzsh_supply"?\."?skin_category/i.test(sql)));
 await assert.rejects(readPublicCatalog(client,'game',{categoryId:'old_cat'},20),retired);
});
const context={game:{id:'game',code:'delta',catalogRevision:'10',ruleReleaseId:'release',rule:null},items:[],categories:[],safeBoxes:[],levels:{vitality:[],bear:[]},pricingAvailable:false} as Awaited<ReturnType<typeof listingCatalogContext>>;
const config=(legacy=false)=>parseFilterConfig({schemaVersion:1,fields:[{key:'skinGroups',operator:'GROUPS',label:'皮肤',enabled:true,order:0,...(legacy?{categoryIds:['old_cat']}:{ownerKinds:['AGENT','MELEE_TYPE','FIREARM']})}],sorts:[{key:'latest',label:'最新发布',enabled:true,order:0}]});
test('new filtering requires the explicit type contract and does not infer old category membership',async()=>{
 assert.throws(()=>validateConfigCatalog(config(true),context,false,'READ'),retired);validateConfigCatalog(config(),context,false,'WRITE');
 const state={catalog:context,config:config(),legacyReadOnly:false,mixed:false,mode:'NATIVE',hasLegacySnapshots:false,allowLegacyOptions:false,filterRevision:'1',catalogRevision:'10',ruleReleaseId:'release'} as Awaited<ReturnType<typeof readListingState>>;
 assert.throws(()=>publicFilterMetadata(state,true),retired);const metadata=publicFilterMetadata(state,true,'TYPE');assert.deepEqual(new Set(metadata.fields[0]!.ownerKinds),new Set(['AGENT','MELEE_TYPE','FIREARM']));
 const client={query:async()=>({rows:[{id:'skin',ownerKind:'MELEE_TYPE'}]})} as unknown as PoolClient;
 const query={queryVersion:2,gameId:'game',q:null,filters:parseListingFilters({skinGroups:[{ownerKind:'MELEE_TYPE',ids:['skin'],match:'ALL'}]}),sort:'latest',direction:'DESC',coreItemId:null,limit:20,cursor:null,filterRevision:null,catalogRevision:null,ruleReleaseId:null} satisfies ListingQueryV2;
 await validateListingQuery(client,query,state);assert.throws(()=>parseListingFilters({skinGroups:[{categoryId:'old_cat',ids:['skin'],match:'ALL'}]}),retired);
 await assert.rejects(validateListingQuery(client,{...query,filters:parseListingFilters({skinGroups:[{ownerKind:'AGENT',ids:['skin'],match:'ALL'}]})},state),/foreign skin/);
});
test('frozen category values stay exact and missing historic labels remain unknown',async()=>{
 const client={query:async()=>{throw Error('Historical skin labels must not query current catalog');}} as unknown as PoolClient;
 for(const skin of [{id:'a',name:'Old',categoryCode:'legacy',categoryName:'Gold',categoryModel:'RETIRED'},{id:'b',name:'Older'}]){
  const presentation={items:[],skins:[skin]},version={presentation} as unknown as ListingVersion,before=JSON.stringify(version);
  assert.equal(await readPresentation(client,version),presentation);assert.equal(JSON.stringify(version),before);
 }
});
test('draft summary uses typed skins without a category join',async()=>{
 const client={query:async(sql:string)=>{assert(!sql.includes('skin_category'));return{rows:[{revision:'10',items:[{id:'skin',name:'New',base_name:'New',owner_kind:'MELEE_TYPE',owner_name:null,rarity_code:null,category_code:null,category_name:null,media_id:null}]}]};}} as unknown as PoolClient;
 const result=await readDraftSkinSummary(client,'game',['skin']);assert.equal((result.items as unknown[]).length,1);assert.equal(result.withheld,0);assert.equal((result.items as {ownerKind:string}[])[0]!.ownerKind,'MELEE_TYPE');
});
