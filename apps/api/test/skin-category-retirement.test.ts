import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {createCatalogEntry,updateCatalogEntry,readPublicCatalog,parseSkinWrite} from '../src/supply/catalog';
import {readPresentation,readDraftSkinSummary} from '../src/supply/publishing';
import type {ListingVersion} from '../src/supply/publishing';
import {parseListingFilters,parseFilterConfig,type ListingQueryV2} from '../src/supply/listing-filter-contract';
import {publicFilterMetadata,validateConfigCatalog,validateListingQuery,type listingCatalogContext,type readListingState} from '../src/supply/listing-filter-config';

// Relation-aware models of the real functions. No PostgreSQL constraints, locks or migration are executed.
function writer(ready=true,game='delta') {
 const calls:{sql:string;args:unknown[]}[]=[];
 const old={id:'skin',game_id:'game',code:'stable',name:'Old',category_id:'old_cat',rarity_code:null,media_id:null,sort_order:0,enabled:false,form_visible:false,naming_state:'PENDING',aliases:[],owner_kind:null,owner_id:null,firearm_id:null,base_name:null,source_namespace:null,source_field:null,source_token:null};
 const client={query:async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});let rows:unknown[]=[];
  if(sql.startsWith('SELECT code FROM zzsh_supply.game'))rows=[{code:game}];
  else if(sql.includes('categoryless-skin-storage'))rows=[{ready}];
  else if(sql.includes('SELECT catalog_revision::text'))rows=[{revision:'10'}];
  else if(sql.startsWith('UPDATE zzsh_supply.game'))rows=[{revision:'11'}];
  else if(sql.startsWith('SELECT * FROM "zzsh_supply"."skin"'))rows=[old];
  else if(sql.startsWith('SELECT * FROM "zzsh_supply"."skin_category"'))rows=[{id:'old_cat',game_id:'game'}];
  else if(sql.startsWith('UPDATE zzsh_supply.skin SET'))rows=[{namingState:'PENDING'}];
  else if(sql.includes('FROM "zzsh_supply"."game"'))rows=[{id:'game',code:game,catalogRevision:'10'}];
  else if(sql.includes('SELECT 1 FROM "zzsh_supply"."skin_category"'))rows=[{}];
  else if(sql.startsWith('INSERT INTO "zzsh_supply"."skin_category"')||sql.startsWith('UPDATE "zzsh_supply"."skin_category"'))rows=[];
  else if(sql.includes('SELECT 1 FROM "zzsh_supply"."skin"'))rows=[];
  else if(!sql.startsWith('INSERT INTO zzsh_supply.skin'))throw Error('Unexpected writer model SQL');
  return{rows,rowCount:rows.length};}} as unknown as PoolClient;
 return{client,calls};
}
test('Delta creates an uncategorized disabled draft only after physical-readiness proof',async()=>{
 const f=writer();await createCatalogEntry(f.client,'admin',true,'skins','game',{code:'new_skin',name:'New',expectedCatalogRevision:'10'});
 const insert=f.calls.find(c=>c.sql.startsWith('INSERT INTO zzsh_supply.skin'))!;assert.equal(insert.args[4],null);assert.match(insert.sql,/false,false/);assert(!f.calls.some(c=>c.sql.includes('SELECT 1 FROM "zzsh_supply"."skin_category"')));
 const blocked=writer(false);await assert.rejects(createCatalogEntry(blocked.client,'admin',true,'skins','game',{code:'new_skin',name:'New',expectedCatalogRevision:'10'}),(e:unknown)=>(e as {status:number}).status===503);assert(!blocked.calls.some(c=>c.sql.startsWith('INSERT')));
});
test('new Delta category binding and category maintenance are refused, old references are preserved',async()=>{
 const input={code:'new_skin',name:'New',categoryId:'old_cat',expectedCatalogRevision:'10'};
 await assert.rejects(createCatalogEntry(writer().client,'admin',true,'skins','game',input),/退役/);
 await assert.rejects(createCatalogEntry(writer().client,'admin',true,'categories','game',{code:'old_group',name:'Gold'}),/历史读取/);
 await assert.rejects(updateCatalogEntry(writer().client,'admin',true,'categories','old_cat',{name:'Other'}),/历史读取/);
 const f=writer();await updateCatalogEntry(f.client,'admin',true,'skins','skin',{expectedCatalogRevision:'10',sortOrder:2});assert.equal(f.calls.find(c=>c.sql.startsWith('UPDATE zzsh_supply.skin SET'))!.args[4],'old_cat');
 await assert.rejects(updateCatalogEntry(writer().client,'admin',true,'skins','skin',{expectedCatalogRevision:'10',categoryId:null}),/只读/);
 assert.throws(()=>parseSkinWrite({code:'x',name:'New',expectedCatalogRevision:'10'},false));
 await createCatalogEntry(writer(true,'other').client,'admin',true,'skins','game',input);
});
test('Delta public default selection ignores retired group visibility and keeps legacy category query shape',async()=>{
 const queries:{sql:string;args:unknown[]}[]=[];
 const client={query:async(sql:string,args:unknown[]=[])=>{queries.push({sql,args});let rows:unknown[]=[];
  if(sql.includes('FROM "zzsh_supply"."game"'))rows=[{id:'game',code:'delta',name:'Delta',catalogRevision:'10',currentReleaseId:'release'}];
  else if(sql.includes('catalog-reference-check'))rows=[{categoryOk:true,rarityOk:true,ownerOk:true,classificationOk:true}];
  else if(sql.includes('FROM "zzsh_supply"."skin" s'))rows=sql.includes('s."category_id" = ANY(')?[]:[{id:'skin',code:'new',name:'New',categoryId:null,ownerKind:'MELEE_TYPE',ownerId:null,ownerName:null,rarityCode:null,sortOrder:0}];
  else if(!/skin_category|skin_rarity|billable_item|firearm_classification|entitlement|SELECT DISTINCT s.category_id/.test(sql))throw Error('Unexpected public model SQL');
  return{rows,rowCount:rows.length};}} as unknown as PoolClient;
 const result=await readPublicCatalog(client,'game',{},20) as {skins:unknown[];skinCategoryModel:{mode:string}};assert.equal(result.skins.length,1);assert.equal(result.skinCategoryModel.mode,'RETIRED');
 await readPublicCatalog(client,'game',{categoryId:'old_cat'},20);assert(queries.some(c=>c.sql.includes('WITH RECURSIVE descendants')&&c.args.includes('old_cat')));
});

const context={game:{id:'game',code:'delta',catalogRevision:'10',ruleReleaseId:'release',rule:null},items:[],categories:[{id:'old_cat',parentId:null,name:'Legacy'}]} as Awaited<ReturnType<typeof listingCatalogContext>>;
const config=(legacy=false)=>parseFilterConfig({schemaVersion:1,fields:[{key:'skinGroups',operator:'GROUPS',label:'皮肤',enabled:true,order:0,...(legacy?{categoryIds:['old_cat']}:{ownerKinds:['AGENT','MELEE_TYPE','FIREARM']})}],sorts:[{key:'latest',label:'最新发布',enabled:true,order:0}]});
test('new filter metadata uses real skin types, while legacy category queries and stored configuration remain readable',async()=>{
 const old=config(true),before=JSON.stringify(old);validateConfigCatalog(old,context,false,'READ');assert.throws(()=>validateConfigCatalog(old,context,false,'WRITE'),/只保留历史读取/);validateConfigCatalog(config(),context,false,'WRITE');
 const state={catalog:context,config:old,legacyReadOnly:false,mixed:false,mode:'NATIVE',hasLegacySnapshots:false,allowLegacyOptions:false,filterRevision:'1',catalogRevision:'10',ruleReleaseId:'release'} as Awaited<ReturnType<typeof readListingState>>;
 const legacyMetadata=publicFilterMetadata(state,true);assert.deepEqual(legacyMetadata.fields[0]!.categoryIds,["old_cat"]);assert.equal(legacyMetadata.fields[0]!.ownerKinds,undefined);
 const metadata=publicFilterMetadata(state,true,"TYPE");assert.deepEqual(metadata.fields[0]!.ownerKinds,['AGENT','MELEE_TYPE','FIREARM']);assert(!Object.hasOwn(metadata.fields[0]!,'categoryIds'));assert.equal(JSON.stringify(old),before);
 const client={query:async()=>({rows:[{id:'skin',categoryId:'old_cat',ownerKind:'MELEE_TYPE'}]})} as unknown as PoolClient;
 const query={queryVersion:2,gameId:'game',q:null,filters:parseListingFilters({skinGroups:[{ownerKind:'MELEE_TYPE',ids:['skin'],match:'ALL'}]}),sort:'latest',direction:'DESC',coreItemId:null,limit:20,cursor:null,filterRevision:null,catalogRevision:null,ruleReleaseId:null} satisfies ListingQueryV2;
 await validateListingQuery(client,query,state);await validateListingQuery(client,{...query,filters:parseListingFilters({skinGroups:[{categoryId:'old_cat',ids:['skin'],match:'ALL'}]})},state);
 await assert.rejects(validateListingQuery(client,{...query,filters:parseListingFilters({skinGroups:[{ownerKind:'AGENT',ids:['skin'],match:'ALL'}]})},state),/foreign skin/);
 assert.throws(()=>parseListingFilters({skinGroups:[{categoryId:'old_cat',ownerKind:'MELEE_TYPE',ids:['skin'],match:'ANY'}]}));
});
test('stored presentation stays immutable; explicit category null is not backfilled from a later catalog',async()=>{
 const noQuery={query:async()=>{throw Error('Unexpected presentation lookup');}} as unknown as PoolClient;
 for(const category of [{categoryCode:'legacy',categoryName:'Gold'},{categoryCode:null,categoryName:null,categoryModel:'RETIRED'}]){
  const presentation={items:[],skins:[{id:'skin',name:'Old',...category}]},version={presentation} as unknown as ListingVersion,before=JSON.stringify(version);
  assert.equal(await readPresentation(noQuery,version),presentation);assert.equal(JSON.stringify(version),before);
 }
});

test('legacy read parameters and non-Delta writers retain the exact category contract',async()=>{
 const legacy={skinGroups:[{categoryId:'old_cat',ids:['skin'],match:'ALL'}]};assert.deepEqual(parseListingFilters(legacy),legacy);assert.throws(()=>parseSkinWrite({code:'new_skin',name:'New',categoryId:'old_cat',expectedCatalogRevision:'10',retiredCategories:true},false));
 await createCatalogEntry(writer(true,'other').client,'admin',true,'skins','game',{code:'new_skin',name:'New',categoryId:'old_cat',expectedCatalogRevision:'10'});
});

test('new Delta draft summaries keep categoryless typed skins rather than dropping them through an inner category join',async()=>{
 const client={query:async(sql:string)=>{const independent=sql.includes("LEFT JOIN zzsh_supply.skin_category")&&sql.includes("g.code='delta' OR");return{rows:[{revision:'10',items:independent?[{id:'skin',name:'New',base_name:'New',owner_kind:'MELEE_TYPE',owner_name:null,rarity_code:null,category_code:null,category_name:null,media_id:null}]:[]}]};}} as unknown as PoolClient;
 const result=await readDraftSkinSummary(client,'game',['skin']);assert.equal((result.items as unknown[]).length,1);assert.equal(result.withheld,0);assert.equal((result.items as {ownerKind:string}[])[0]!.ownerKind,'MELEE_TYPE');
});

test('a mixed presentation fills only old missing display metadata and never overwrites new retired-null fields',async()=>{
 const original={items:[],skins:[{id:'new',name:'New',categoryCode:null,categoryName:null,categoryModel:'RETIRED'},{id:'old',name:'Old'}]},version={presentation:original} as unknown as ListingVersion,before=JSON.stringify(version);
 const client={query:async()=>({rows:[{id:'new',categoryCode:'wrong_current',categoryName:'Wrong'},{id:'old',categoryCode:'legacy',categoryName:'Legacy'}]})} as unknown as PoolClient;const result=await readPresentation(client,version);const rows=result.skins as {categoryCode:string|null}[];assert.equal(rows[0]!.categoryCode,null);assert.equal(rows[1]!.categoryCode,'legacy');assert.equal(JSON.stringify(version),before);
});
