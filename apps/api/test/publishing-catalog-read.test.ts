import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {readPublicCatalog,readAdminCatalog,parseCursor,encodeCursor,publicSkinMetadataSql} from '../src/supply/catalog';

function fixture(requiredUnpriced=false, hasRelease=true) {
  const items=Array.from({length:8},(_,n)=>({id:`item_${n}`,code:`item_code_${n}`,name:`物资${n}`,unit:n===0?'HAFF_BASE':'PIECE',quantityScale:0,required:requiredUnpriced&&n===1,priced:n===0&&hasRelease,sortOrder:n}));
  const queries:string[]=[];
  const client={async query(sql:string,args:unknown[]=[]) {
    queries.push(sql);
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:[{id:'game_delta',code:'delta',name:'三角洲行动',catalogRevision:'129',currentReleaseId:hasRelease?'release_current':null,coverMediaId:null}]};
    if(sql.includes('FROM "zzsh_supply"."billable_item"'))return{rows:sql.includes('AND EXISTS')?items.filter(i=>i.priced):items};
    if(sql.startsWith('SELECT id,name FROM zzsh_supply.billable_item'))return{rows:items.filter(i=>i.required&&(sql.includes('NOT EXISTS')?!i.priced:!(args[1] as string[]).includes(i.id)))};
    if(sql.includes('skin_category')||sql.includes('skin_rarity')||sql.includes('entitlement')||sql.includes('FROM "zzsh_supply"."skin"'))return{rows:[]};
    throw Error('Unexpected catalog read SQL');
  }} as unknown as PoolClient;
  return{client,items,queries};
}
test('publishing catalog returns all enabled items and separates current price availability',async()=>{
  const f=fixture(),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);
  assert.deepEqual(body.items.map((i:any)=>i.priced),[true,false,false,false,false,false,false,false]);
  assert.equal(body.ready,true);assert.deepEqual(body.blockers,[]);
  assert(f.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE)/.test(q)));
});
test('returning unpriced items does not clear the required price blocker',async()=>{
  const f=fixture(true),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);assert.equal(body.ready,false);
  assert.deepEqual(body.blockers,[{code:'REQUIRED_ITEM_UNPRICED',path:'inventory',itemId:'item_1',name:'物资1'}]);
});
test('a game without an active release still exposes its draft inventory and stays unready',async()=>{
  const f=fixture(false,false),body=await readPublicCatalog(f.client,'game_delta',{},20,undefined,'publishing') as any;
  assert.equal(body.items.length,8);assert(body.items.every((i:any)=>i.priced===false));
  assert.equal(body.ready,false);assert.deepEqual(body.blockers,[{code:'RULE_UNCONFIGURED',path:'rules'}]);
});

test('public owners and category kinds cover the whole visible tree regardless of page or search filters',async()=>{
  const categories=[
    {id:'root',parentId:null},{id:'agents',parentId:'root'},{id:'firearms',parentId:'root'},
    {id:'melee',parentId:null},{id:'mixed',parentId:null},{id:'empty',parentId:null},
  ];
  const refs=[
    {categoryId:'agents',kind:'AGENT',id:'owner_A',name:'干员甲'},
    {categoryId:'agents',kind:'AGENT',id:'owner_B',name:'干员乙'},
    {categoryId:'agents',kind:'AGENT',id:'owner_A',name:'干员甲'},
    {categoryId:'firearms',kind:'FIREARM',id:'firearm_A',name:'枪械甲'},
    {categoryId:'melee',kind:'MELEE_TYPE',id:null,name:null},
    {categoryId:'mixed',kind:'AGENT',id:'owner_A',name:'干员甲'},
    {categoryId:'mixed',kind:null,id:null,name:null},
  ];
  const queries:Array<{sql:string;args:unknown[]}>=[];
  const page=[{id:'skin_A',name:'外观甲',ownerKind:'AGENT',rarityBasis:'PLATFORM_REFERENCE',isCollectible:false,defaultState:'NON_DEFAULT'},{id:'skin_B',name:'外观乙'}];
  const client={query:async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:[{id:'game_delta',catalogRevision:'129',currentReleaseId:null}]};
    if(sql.startsWith('WITH RECURSIVE'))return{rows:categories};
    if(sql.startsWith('SELECT DISTINCT s.category_id'))return{rows:refs};
    if(sql.includes('s."owner_kind" AS "ownerKind"'))return{rows:page};
    return{rows:[]};
  }} as unknown as PoolClient;
  const filters={categoryId:'agents',ownerId:'owner_A',rarityCode:'quality_A',q:'甲%_'};
  const body=await readPublicCatalog(client,'game_delta',filters,1) as any;
  assert.deepEqual(body.skins,[page[0]]);
  assert.deepEqual(body.owners.map((owner:any)=>owner.id).sort(),['firearm_A','owner_A','owner_B'],'same-game owners outside this page/filter remain available');
  assert.equal(body.owners.some((owner:any)=>owner.id===null),false,'an unclassified melee is not a fake owner option');
  assert.deepEqual(Object.fromEntries(body.categories.map((category:any)=>[category.id,category.ownerKind])),{root:null,agents:'AGENT',firearms:'FIREARM',melee:'MELEE_TYPE',mixed:null,empty:null});
  const allRefs=queries.find(query=>query.sql.startsWith('SELECT DISTINCT s.category_id'))!;
  assert.deepEqual(allRefs.args,['game_delta',categories.map(category=>category.id)]);
  assert.match(allRefs.sql,/s\.game_id=\$1 AND s\.enabled=true AND s\.form_visible=true/);
  assert.equal(allRefs.sql.includes('LIMIT'),false);
  assert.match(allRefs.sql,/f\.game_id=s\.game_id/);
  assert.match(allRefs.sql,/o\.game_id=s\.game_id/);
  const skinSql=queries.find(query=>query.sql.includes('s."owner_kind" AS "ownerKind"'))!;
  assert.match(skinSql.sql,/COALESCE\(s\."owner_id",s\."firearm_id"\) = \$5/);
  assert.deepEqual(skinSql.args.slice(2),['agents','quality_A','owner_A','%甲\\%\\_%',2]);
  assert.ok(skinSql.sql.includes(publicSkinMetadataSql('s')));
  assert.equal(skinSql.sql.includes('AS "mediaSource"'),false);
  assert.equal(skinSql.sql.includes('AS "rarityEvidence"'),false);
  assert.equal(parseCursor(body.nextCursor,{gameId:'game_delta',revision:'129',filters}),'skin_A');
  assert.throws(()=>parseCursor(body.nextCursor,{gameId:'game_delta',revision:'129',filters:{...filters,ownerId:'owner_B'}}),/cursor does not match/);
  assert.ok(queries.every(query=>!/^\s*(INSERT|UPDATE|DELETE)/.test(query.sql)));
});

test('owner filtering binds cursors while older unfiltered cursors remain compatible',()=>{
  const old=Buffer.from(JSON.stringify({v:1,gameId:'g',revision:'1',q:null,categoryId:null,rarityCode:null,lastSkinId:'s'})).toString('base64url');
  assert.equal(parseCursor(old,{gameId:'g',revision:'1',filters:{}}),'s');
  assert.throws(()=>parseCursor(old,{gameId:'g',revision:'1',filters:{ownerId:'owner_A'}}),/cursor does not match/);
  const cursor=encodeCursor({gameId:'g',revision:'1',filters:{ownerId:'owner_A'}},'s');
  for(const filters of [{},{ownerId:'owner_B'},{ownerId:'owner_A',q:'changed'},{ownerId:'owner_A',rarityCode:'changed'},{ownerId:'owner_A',categoryId:'changed'}])assert.throws(()=>parseCursor(cursor,{gameId:'g',revision:'1',filters}),/cursor does not match/);
});

test('admin receives full metadata and only constructs ownerRef with a real owner identity',async()=>{
  const queries:string[]=[];
  const client={query:async(sql:string)=>{
    queries.push(sql);
    return{rows:sql.includes('FROM "zzsh_supply"."game"')?[{id:'game_delta'}]:[]};
  }} as unknown as PoolClient;
  await readAdminCatalog(client,'boss_fixture',true,'game_delta');
  const sql=queries.find(query=>query.includes('AS "namingState"'))!;
  for(const field of ['ownerKind','rarityEvidence','isCollectible','defaultState','mediaSource'])assert.ok(sql.includes(`AS "${field}"`),field);
  assert.match(sql,/owner_kind IS NULL OR COALESCE\(owner_id,firearm_id\) IS NULL THEN NULL/);
  assert.equal(publicSkinMetadataSql('skin'),'skin.rarity_evidence->>\'basis\' AS "rarityBasis", skin.is_collectible AS "isCollectible", skin.default_state AS "defaultState"');
});
