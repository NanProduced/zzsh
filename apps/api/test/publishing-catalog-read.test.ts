import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {readPublicCatalog,readAdminCatalog,parseCursor,encodeCursor,parseCatalogQuery,publicSkinMetadataSql} from '../src/supply/catalog';
import {handleSupplyUserRoute} from '../src/supply/supply-routes';
import {mountUserSupplyBff} from '../src/bff/user-supply-bff';

function fixture(requiredUnpriced=false, hasRelease=true) {
  const items=Array.from({length:8},(_,n)=>({id:`item_${n}`,code:`item_code_${n}`,name:`物资${n}`,unit:n===0?'HAFF_BASE':'PIECE',quantityScale:0,required:requiredUnpriced&&n===1,priced:n===0&&hasRelease,sortOrder:n}));
  const queries:string[]=[];
  const client={async query(sql:string,args:unknown[]=[]) {
    queries.push(sql);
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:[{id:'game_delta',code:'delta',name:'三角洲行动',catalogRevision:'129',currentReleaseId:hasRelease?'release_current':null,coverMediaId:null}]};
    if(sql.includes('FROM "zzsh_supply"."billable_item"'))return{rows:sql.includes('AND EXISTS')?items.filter(i=>i.priced):items};
    if(sql.startsWith('SELECT id,name FROM zzsh_supply.billable_item'))return{rows:items.filter(i=>i.required&&(sql.includes('NOT EXISTS')?!i.priced:!(args[1] as string[]).includes(i.id)))};
    if(sql.includes('skin_category')||sql.includes('skin_rarity')||sql.includes('firearm_classification')||sql.includes('entitlement')||sql.includes('FROM "zzsh_supply"."skin"'))return{rows:[]};
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
  const page=[{id:'skin_A',name:'外观甲',ownerKind:'AGENT',rarityBasis:'PLATFORM_REFERENCE',isCollectible:false,defaultState:'NON_DEFAULT',mediaKind:'PROMO_POSTER'},{id:'skin_B',name:'外观乙',mediaKind:null}];
  const client={query:async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});
    if(sql.includes('catalog-reference-check'))return{rows:[{categoryOk:true,rarityOk:true,ownerOk:true,classificationOk:true}]};
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:[{id:'game_delta',code:'compat',catalogRevision:'129',currentReleaseId:null}]};
    if(sql.startsWith('WITH RECURSIVE'))return{rows:categories};
    if(sql.startsWith('SELECT DISTINCT s.category_id'))return{rows:refs};
    if(sql.includes('s."owner_kind" AS "ownerKind"'))return{rows:page};
    return{rows:[]};
  }} as unknown as PoolClient;
  const filters={categoryId:'agents',ownerId:'owner_A',rarityCode:'quality_A',q:'甲%_'};
  const body=await readPublicCatalog(client,'game_delta',filters,1) as any;
  assert.deepEqual(body.skins,[page[0]]);
  assert.equal(body.skins[0].mediaKind,'PROMO_POSTER');
  assert.deepEqual(body.owners.map((owner:any)=>owner.id).sort(),['firearm_A','owner_A','owner_B'],'same-game owners outside this page/filter remain available');
  assert.equal(body.owners.some((owner:any)=>owner.id===null),false,'an unclassified melee is not a fake owner option');
  assert.deepEqual(Object.fromEntries(body.categories.map((category:any)=>[category.id,category.ownerKind])),{root:null,agents:'AGENT',firearms:'FIREARM',melee:'MELEE_TYPE',mixed:null,empty:null});
  const allRefs=queries.find(query=>query.sql.startsWith('SELECT DISTINCT s.category_id'))!;
  assert.deepEqual(allRefs.args,['game_delta',categories.map(category=>category.id),false]);
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
  assert.ok(skinSql.sql.includes('s.media_source->>\'kind\' AS "mediaKind"'));
  assert.equal(skinSql.sql.includes('media_source->>\'url\''),false);
  assert.equal(parseCursor(body.nextCursor,{gameId:'game_delta',revision:'129',filters}),'skin_A');
  assert.throws(()=>parseCursor(body.nextCursor,{gameId:'game_delta',revision:'129',filters:{...filters,ownerId:'owner_B'}}),/cursor does not match/);
  assert.ok(queries.every(query=>!/^\s*(INSERT|UPDATE|DELETE)/.test(query.sql)));
});

/** A bounded relational fixture executes the actual reader's predicates/parameters;
 *  it never substitutes the reader, parser, codec, route or BFF. It is not PostgreSQL. */
function filterFixture(emptyClasses=false, gameCode='delta') {
  const categories=[{id:'root',parentId:null},{id:'agents',parentId:'root'},{id:'firearms',parentId:'root'},{id:'melee',parentId:'root'}];
  const owners=[{id:'agent_A',kind:'AGENT',name:'Agent Alpha'},{id:'knife_A',kind:'MELEE_TYPE',name:'Knife Alpha'}];
  const classes=emptyClasses?[]:[{id:'class_A',code:'rifle',name:'Rifle',sortOrder:1,enabled:true},{id:'class_retired',code:'retired',name:'Retired class',sortOrder:2,enabled:false},{id:'class_unused',code:'unused',name:'No current skin',sortOrder:3,enabled:true}];
  const firearms=[{id:'firearm_A',name:'Firearm Alpha',classificationId:emptyClasses?null:'class_A'},{id:'firearm_B',name:'Firearm Beta',classificationId:null},{id:'firearm_old',name:'Old firearm',classificationId:emptyClasses?null:'class_retired'}];
  const rarities=[{code:'quality_A',name:'Epic',enabled:true},{code:'quality_retired',name:'Historical quality',enabled:false},{code:'quality_unused',name:'Unused quality',enabled:true}];
  const skins=[
    {id:'s1',name:'Agent Alpha Paint',categoryId:'agents',ownerKind:'AGENT',ownerId:'agent_A',rarityCode:'quality_A',isCollectible:false,aliases:['Alias%_']},
    {id:'s2',name:'Agent Unknown',categoryId:'agents',ownerKind:'AGENT',ownerId:'agent_A',rarityCode:null,isCollectible:null,aliases:[]},
    {id:'s3',name:'Firearm Collection',categoryId:'firearms',ownerKind:'FIREARM',ownerId:'firearm_A',rarityCode:'quality_A',isCollectible:true,aliases:[]},
    {id:'s4',name:'Firearm Unknown',categoryId:'firearms',ownerKind:'FIREARM',ownerId:'firearm_B',rarityCode:null,isCollectible:false,aliases:[]},
    {id:'s5',name:'Retired quality paint',categoryId:'firearms',ownerKind:'FIREARM',ownerId:'firearm_old',rarityCode:'quality_retired',isCollectible:false,aliases:[]},
    {id:'s6',name:'Melee Paint',categoryId:'melee',ownerKind:'MELEE_TYPE',ownerId:'knife_A',rarityCode:null,isCollectible:null,aliases:[]},
    {id:'s7',name:'Unclassified Melee',categoryId:'melee',ownerKind:'MELEE_TYPE',ownerId:null,rarityCode:null,isCollectible:null,aliases:[]},
  ];
  const queries:Array<{sql:string;args:unknown[]}>=[];let revision='129',connections=0;
  const named=(s:typeof skins[number])=>s.ownerKind==='FIREARM'?firearms.find(f=>f.id===s.ownerId):owners.find(o=>o.id===s.ownerId);
  const matchLike=(value:string,pattern:string)=>{let re='';for(let i=0;i<pattern.length;i++){const c=pattern[i]!;if(c==='\\'&&i+1<pattern.length){re+=pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}else re+=c==='%'?'.*':c==='_'?'.':c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}return new RegExp('^'+re+'$','iu').test(value);};
  const client={release(){},async query(sql:string,args:unknown[]=[]) {
    queries.push({sql,args});assert(!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(sql),'read path must not write');
    if(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql))return{rows:[],rowCount:0};
    if(sql.includes('game_service_operation'))return{rows:[{id:'service',gameCode:'delta',gameEnabled:true,enabled:true}]};
    if(sql.includes('catalog-reference-check'))return{rows:[{categoryOk:args[1]===null||categories.some(c=>c.id===args[1]),rarityOk:args[2]===null||rarities.some(r=>r.code===args[2]),ownerOk:args[3]===null||[...owners,...firearms].some(o=>o.id===args[3]),classificationOk:args[4]===null||classes.some(c=>c.id===args[4])}]};
    if(sql.includes('FROM "zzsh_supply"."game"'))return{rows:args[0]==='game_delta'?[{id:'game_delta',code:gameCode,catalogRevision:revision,currentReleaseId:null}]:[]};
    if(sql.startsWith('WITH RECURSIVE'))return{rows:categories};
    if(sql.startsWith('SELECT DISTINCT s.category_id'))return{rows:skins.map(s=>{const owner=named(s),f=firearms.find(f=>f.id===s.ownerId);return{categoryId:s.categoryId,kind:s.ownerKind,id:s.ownerId,name:owner?.name??null,firearmClassificationId:f?.classificationId??null,firearmClassificationName:classes.find(c=>c.id===f?.classificationId)?.name??null};})};
    if(sql.includes('FROM "zzsh_supply"."skin_rarity"'))return{rows:rarities.filter(r=>r.enabled)};
    if(sql.includes('FROM zzsh_supply.firearm_classification'))return{rows:classes.filter(c=>c.enabled).map(({enabled,...c})=>c)};
    if(sql.includes('s."owner_kind" AS "ownerKind"')){
      let rows=skins.slice();const parameter=(re:RegExp)=>{const m=re.exec(sql);return m?{present:true,value:args[Number(m[1])-1]}:{present:false,value:undefined};};
      const category=parameter(/WHERE "id" = \$(\d+) AND "game_id" = \$1/);if(category.present){const descendants=new Set([category.value]);for(const c of categories)if(c.parentId&&descendants.has(c.parentId))descendants.add(c.id);rows=rows.filter(s=>descendants.has(s.categoryId));}
      for(const [re,field]of [[/s\."rarity_code" = \$(\d+)/,'rarityCode'],[/COALESCE\(s\."owner_id",s\."firearm_id"\) = \$(\d+)/,'ownerId'],[/s\."owner_kind" = \$(\d+)/,'ownerKind'],[/s\."is_collectible" = \$(\d+)/,'isCollectible']] as const){const p=parameter(re);if(p.present)rows=rows.filter(s=>s[field]===p.value);}
      const classification=parameter(/f\."classification_id" = \$(\d+)/);if(classification.present)rows=rows.filter(s=>s.ownerKind==='FIREARM'&&firearms.find(f=>f.id===s.ownerId)?.classificationId===classification.value);
      if(sql.includes('s."is_collectible" IS NULL'))rows=rows.filter(s=>s.isCollectible===null);
      if(sql.includes('s."rarity_code" IS NULL'))rows=rows.filter(s=>s.rarityCode===null);
      const q=parameter(/s\."name" ILIKE \$(\d+)/);if(q.present)rows=rows.filter(s=>[s.name,named(s)?.name??'',...s.aliases].some(v=>matchLike(v,q.value as string)));
      const after=parameter(/s\."id" > \$(\d+)/);if(after.present)rows=rows.filter(s=>s.id>(after.value as string));
      const page=rows.sort((a,b)=>a.id<b.id?-1:1).slice(0,args.at(-1) as number).map(s=>{const f=firearms.find(f=>f.id===s.ownerId),rarity=rarities.find(r=>r.code===s.rarityCode);return{id:s.id,code:s.id,name:s.name,baseName:s.name,categoryId:s.categoryId,rarityCode:s.rarityCode,ownerKind:s.ownerKind,ownerName:named(s)?.name??null,rarityName:rarity?.name??null,rarityBasis:s.rarityCode?'PLATFORM_REFERENCE':null,isCollectible:s.isCollectible,defaultState:'UNKNOWN',mediaId:null,mediaKind:null,sortOrder:0,...(sql.includes('AS "ownerId"')?{ownerId:s.ownerId,firearmClassificationId:f?.classificationId??null,firearmClassificationName:classes.find(c=>c.id===f?.classificationId)?.name??null}:{})};});return{rows:page};
    }
    if(sql.includes('billable_item')||sql.includes('entitlement'))return{rows:[]};throw Error('Unrecognized fixture query');
  }} as unknown as PoolClient;
  return{client,pool:{connect:async()=>{connections++;return client;}},queries,setRevision(v:string){revision=v;},get connections(){return connections;}};
}

test('catalog parser preserves old empty queries and strictly parses the accepted single parameters',()=>{
  assert.deepEqual(parseCatalogQuery(new URLSearchParams('q=&categoryId=&rarityCode=&ownerId=')),{filters:{},limit:20});
  for(const [value,expected]of [['true',true],['false',false],['null',null]] as const)assert.deepEqual(parseCatalogQuery(new URLSearchParams({isCollectible:value})).filters,{isCollectible:expected});
  for(const query of ['ownerKind=','ownerKind=firearm','firearmClassificationId=','isCollectible=0','isCollectible=UNKNOWN','rarityState=KNOWN','rarityState=UNKNOWN&rarityCode=','ownerKind=AGENT&ownerKind=FIREARM','q=a&q=b','limit=20&limit=30','unexpected=x'])assert.throws(()=>parseCatalogQuery(new URLSearchParams(query)),(e:any)=>e.status===400,query);
});

test('new cursor binding distinguishes omitted false and null and keeps old unfiltered cursors',()=>{
  const old=Buffer.from(JSON.stringify({v:1,gameId:'g',revision:'1',q:null,categoryId:null,rarityCode:null,lastSkinId:'s'})).toString('base64url');
  assert.equal(parseCursor(old,{gameId:'g',revision:'1',filters:{}}),'s');
  const filters=[{}, {isCollectible:false}, {isCollectible:null}, {ownerKind:'FIREARM' as const}, {firearmClassificationId:'class_A'}, {rarityState:'UNKNOWN' as const}];
  for(let i=0;i<filters.length;i++){const cursor=encodeCursor({gameId:'g',revision:'1',filters:filters[i]!},'s');assert.equal(parseCursor(cursor,{gameId:'g',revision:'1',filters:filters[i]!}),'s');for(let j=0;j<filters.length;j++)if(i!==j)assert.throws(()=>parseCursor(cursor,{gameId:'g',revision:'1',filters:filters[j]!}),(e:any)=>e.status===409);}
  assert.throws(()=>parseCursor(old,{gameId:'g',revision:'1',filters:{isCollectible:null}}),(e:any)=>e.status===409);
  for(const cursor of ['!','e30',Buffer.from(JSON.stringify({v:1,gameId:'g',revision:'1',lastSkinId:[]})).toString('base64url')])assert.throws(()=>parseCursor(cursor,{gameId:'g',revision:'1',filters:{}}),(e:any)=>e.status===400);
});

test('actual catalog reader applies AND predicates and real false/null/unknown parameter semantics',async()=>{
  const f=filterFixture();for(const [q,ids]of [
    ['ownerKind=FIREARM',['s3','s4','s5']],['isCollectible=false',['s1','s4','s5']],['isCollectible=null',['s2','s6','s7']],['isCollectible=true',['s3']],['rarityState=UNKNOWN',['s2','s4','s6','s7']],['firearmClassificationId=class_A&rarityCode=quality_A&isCollectible=true',['s3']],['ownerKind=AGENT&firearmClassificationId=class_A',[]],['q=Alias%25_',['s1']],['ownerId=firearm_old&rarityCode=quality_retired',['s5']],
  ] as const){const p=parseCatalogQuery(new URLSearchParams(q)),body=await readPublicCatalog(f.client,'game_delta',p.filters,20) as any;assert.deepEqual(body.skins.map((s:any)=>s.id),ids,q);}
  const body=await readPublicCatalog(f.client,'game_delta',{ownerId:'firearm_old'},20) as any;assert.equal(body.skins[0].rarityName,'Historical quality');assert.equal(body.skins[0].firearmClassificationName,'Retired class');assert.equal(body.skins[0].ownerId,'firearm_old');assert.equal(body.rarities.some((r:any)=>r.code==='quality_retired'),false);
});

test('catalog reference validation is game-scoped and independent of result filters or page',async()=>{
  for(const filters of [{categoryId:'foreign_category'},{rarityCode:'foreign_quality'},{ownerId:'foreign_owner'},{firearmClassificationId:'foreign_class'}]){const f=filterFixture();await assert.rejects(()=>readPublicCatalog(f.client,'game_delta',filters,20),(e:any)=>e.status===400);assert.equal(f.queries.some(q=>q.sql.includes('s."owner_kind" AS "ownerKind"')),false);}
  const f=filterFixture(),body=await readPublicCatalog(f.client,'game_delta',{q:'no matching skin',ownerId:'firearm_A'},1) as any;assert.deepEqual(body.skins,[]);assert(body.owners.some((o:any)=>o.id==='firearm_A'));assert(body.skinFilters.firearmClassifications.some((c:any)=>c.id==='class_unused'));assert(body.rarities.some((r:any)=>r.code==='quality_unused'));assert.equal(f.queries.filter(q=>q.sql.includes('catalog-reference-check')).length,1);
});

test('Delta public catalog never offers or projects a legacy melee parent; other games retain compatibility',async()=>{
  for(const scope of ['browse','publishing'] as const){
    const f=filterFixture(),body=await readPublicCatalog(f.client,'game_delta',{ownerKind:'MELEE_TYPE'},20,undefined,scope) as any;
    assert.deepEqual(body.skins.map((s:any)=>s.id),['s6','s7']);
    assert(body.skins.every((s:any)=>s.ownerId===null&&s.ownerName===null));
    assert(body.owners.every((o:any)=>o.kind!=='MELEE_TYPE'));
    assert.equal(body.categories.find((c:any)=>c.id==='melee').ownerKind,'MELEE_TYPE');
  }
  const f=filterFixture(false,'other'),body=await readPublicCatalog(f.client,'game_delta',{ownerKind:'MELEE_TYPE'},20) as any;
  assert.equal(body.skins[0].ownerId,'knife_A');assert.equal(body.skins[0].ownerName,'Knife Alpha');
  assert(body.owners.some((o:any)=>o.id==='knife_A'));
});

test('full options, empty class dictionary and pagination stay bounded without exposing private metadata',async()=>{
  const f=filterFixture(true),body=await readPublicCatalog(f.client,'game_delta',{ownerKind:'FIREARM'},1) as any;assert.equal(body.skinFilters.version,1);assert.deepEqual(body.skinFilters.ownerKinds,['AGENT','FIREARM','MELEE_TYPE']);assert.deepEqual(body.skinFilters.firearmClassifications,[]);assert.deepEqual(body.skinFilters.collectibleValues,['true','false','null']);assert.deepEqual(body.skinFilters.rarityStates,['UNKNOWN']);assert.equal(body.skins[0].firearmClassificationId,null);assert.equal(body.owners.find((o:any)=>o.id==='firearm_A').firearmClassificationId,null);
  const ids:string[]=[];let cursor: string|undefined;do{const page=await readPublicCatalog(f.client,'game_delta',{ownerKind:'FIREARM'},1,cursor) as any;ids.push(...page.skins.map((s:any)=>s.id));cursor=page.nextCursor??undefined;}while(cursor);assert.deepEqual(ids,['s3','s4','s5']);assert.equal(new Set(ids).size,3);
  f.setRevision('130');await assert.rejects(()=>readPublicCatalog(f.client,'game_delta',{ownerKind:'FIREARM'},1,body.nextCursor),(e:any)=>e.status===409);
  for(const q of f.queries.filter(q=>q.sql.includes('s."owner_kind" AS "ownerKind"'))){assert(!/AS "(?:rarityEvidence|mediaSource)"|source_namespace|source_token|owner_user_id|pricingInputs/.test(q.sql));assert.equal(q.args.at(-1),2);}
});

async function catalogRoute(f:ReturnType<typeof filterFixture>,suffix:string,bff=false){let body:any,status=0;const response={headersSent:false,setHeader(){return this;},status(n:number){status=n;return this;},json(value:any){body=value;this.headersSent=true;return this;}};const options={pool:f.pool,userOrigin:'http://user.invalid',apiOrigin:'http://api.invalid',adminOrigin:'http://admin.invalid',mediaStorage:{available:false}};const request={method:'GET',url:suffix,originalUrl:suffix,headers:{origin:'http://user.invalid','x-request-id':'req_catalog_fixture'}};if(bff){let middleware:any;mountUserSupplyBff({getHttpAdapter:()=>({getInstance:()=>({use:(_path:string,fn:any)=>{middleware=fn;}})})} as never,options as never);await middleware(request,response);}else await handleSupplyUserRoute(request as never,response as never,options as never);return{status,body};}

test('both real catalog GET handlers share strict parsing and filter execution',async()=>{
  for(const endpoint of ['catalog','publishing-catalog']){const f=filterFixture(),r=await catalogRoute(f,'/api/v1/supply/games/game_delta/'+endpoint+'?ownerKind=FIREARM&isCollectible=false');assert.equal(r.status,200);assert.deepEqual(r.body.skins.map((s:any)=>s.id),['s4','s5']);assert.equal(r.body.skinFilters.version,1);}
  for(const q of ['ownerKind=bad','isCollectible=','isCollectible=false&isCollectible=null','rarityState=UNKNOWN&rarityCode=quality_A','ignored=x']){const f=filterFixture(),r=await catalogRoute(f,'/api/v1/supply/games/game_delta/catalog?'+q);assert.equal(r.status,400,q);assert.equal(f.connections,0,'syntax rejection precedes database acquisition');}
  const foreign=await catalogRoute(filterFixture(),'/api/v1/supply/games/game_delta/catalog?ownerId=foreign_owner');assert.equal(foreign.status,400);assert.equal(JSON.stringify(foreign.body).includes('Firearm Alpha'),false);
});

test('existing API user BFF preserves literal null and duplicates through the real handler',async()=>{
  const f=filterFixture(),r=await catalogRoute(f,'/api/bff/user/supply/games/game_delta/catalog?isCollectible=null',true);assert.equal(r.status,200);assert.deepEqual(r.body.skins.map((s:any)=>s.id),['s2','s6','s7']);const duplicate=await catalogRoute(filterFixture(),'/api/bff/user/supply/games/game_delta/catalog?ownerKind=AGENT&ownerKind=FIREARM',true);assert.equal(duplicate.status,400);
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
  assert.equal(publicSkinMetadataSql('skin'),'skin.rarity_evidence->>\'basis\' AS "rarityBasis", skin.is_collectible AS "isCollectible", skin.default_state AS "defaultState", skin.media_source->>\'kind\' AS "mediaKind"');
});
