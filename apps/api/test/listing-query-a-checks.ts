import assert from "node:assert/strict";
import { randomBytes,randomUUID,createHash } from "node:crypto";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTransaction } from "../src/auth/security-core";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { createListingDraft,saveListingDraft,quoteListing,acceptListingRules,submitListing,readPublishingAccount,readCurrentVersion } from "../src/supply/publishing";
import { parseListingQueryV2,LISTING_OPERATORS,type FilterConfig,type ListingFilters } from "../src/supply/listing-filter-contract";
import { buildListingCandidates } from "../src/supply/listing-candidates";
import type { Options } from "./supply-publishing-checks";

export const queryFixtureKey={keyId:"query-a-fixture",secret:randomBytes(32).toString("hex")};
export async function runListingQueryAChecks(o:Options) {
  const before=(await o.pool.query(`SELECT id,payload,content_hash FROM zzsh_supply.listing_version WHERE payload IS NOT NULL ORDER BY id`)).rows;
  await runBusinessMigrations(o.migration,{runtimeUser:o.runtimeUser});await runBusinessMigrations(o.migration,{runtimeUser:o.runtimeUser});
  assert.deepEqual((await o.pool.query(`SELECT id,payload,content_hash FROM zzsh_supply.listing_version WHERE payload IS NOT NULL ORDER BY id`)).rows,before);
  const folder=join(__dirname,"../../migrations/business"),journal=JSON.parse(await readFile(join(folder,"meta/_journal.json"),"utf8"));
  const migrations=(await o.migration.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;assert.equal(migrations.length,43);
  for(const [i,e] of journal.entries.entries())assert.deepEqual(migrations[i],{hash:createHash("sha256").update(await readFile(join(folder,e.tag+".sql"))).digest("hex"),created_at:String(e.when)});
  console.log("Query A migration hash",migrations[42].hash);
  const call=async(path:string,body?:unknown,jar=o.boss,method=body===undefined?"GET":"POST",key="querya_"+randomUUID())=>{const r=await fetch(o.base+path,{method,headers:{origin:path.includes("/admin/")?o.adminOrigin:o.userOrigin,cookie:jar.header(),...(body===undefined?{}:{"content-type":"application/json","idempotency-key":key})},...(body===undefined?{}:{body:JSON.stringify(body)})});jar.update?.(r);return {status:r.status,body:await r.json()};};
  const ok=async(path:string,body?:unknown,jar=o.boss,method?:string)=>{const r=await call(path,body,jar,method);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const root=`/api/bff/admin/supply/games/${o.gameId}`,publicRoot=`/api/v1/supply/games/${o.gameId}`;
  const core=(await ok(root+"/items",{code:"query_core",name:"查询核心币",unit:"HAFF_BASE"})).id;
  const catA=(await ok(root+"/categories",{code:"query_a",name:"分类A"})).id,catB=(await ok(root+"/categories",{code:"query_b",name:"分类B"})).id;
  const skins:string[]=[];for(let i=0;i<4;i++)skins.push((await ok(root+"/skins",{code:"query_skin_"+i,name:"查询皮肤"+i,categoryId:i<2?catA:catB})).id);
  const current=(await o.pool.query(`SELECT r.*,p.haff_rule FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE g.id=$1`,[o.gameId])).rows[0];
  const lines=(await o.pool.query(`SELECT item_id AS "itemId",customer_tier AS "customerTier",pricing_kind AS "pricingKind",unit_quantity::text AS "unitQuantity",buyer_unit_amount::text AS "buyerUnitAmount",owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.price_line WHERE price_version_id=$1 AND customer_tier='STANDARD'`,[current.price_version_id])).rows.map(l=>Object.fromEntries(Object.entries(l).filter(([,v])=>v!==null)));
  const round=lines.find(l=>l.pricingKind==="FIXED_UNIT")!.itemId as string;
  const price=(await ok("/api/bff/admin/supply/price-drafts",{gameId:o.gameId,mode:"SPREAD"})).id;
  const rule={...current.haff_rule,baseBySafeBox:{"box-a":"50","box-b":"60"},vitalityDeltaByLevel:{6:"0",7:"0"},bearDeltaByLevel:{6:"0",7:"0"}};
  await ok(`/api/bff/admin/supply/price-drafts/${price}`,{expectedRevision:"1",haffRule:rule,lines:[...lines,{itemId:core,customerTier:"STANDARD",pricingKind:"HAFF_RATIO"}]},o.boss,"PUT");
  await ok(`/api/bff/admin/supply/price-drafts/${price}/seal`,{expectedRevision:"2"});
  await ok("/api/bff/admin/supply/releases",{gameId:o.gameId,priceVersionId:price,termVersionId:current.term_version_id,agreementVersionId:current.agreement_version_id,expectedGeneration:String(current.generation)});
  const regionPairs=[{province:"河南省",city:"郑州市"},{province:"河南省",city:"洛阳市"},{province:"四川省",city:"成都市"}];
  const config:FilterConfig={schemaVersion:1,fields:[
    {key:"resources",operator:LISTING_OPERATORS.resources,label:"资源",enabled:true,order:0,items:[o.itemId,round,core].map(itemId=>({itemId,min:"0",max:"999999999999999999999999"}))},
    ...(["safeBoxCodes","gradingCodes","loginMethodCodes"] as const).map((key,i)=>({key,operator:LISTING_OPERATORS[key],label:key,enabled:true,order:i+1,options:(key==="safeBoxCodes"?["box-a","box-b"]:key==="gradingCodes"?["6","7"]:["legacy_login_qq","legacy_login_wechat"]).map(value=>({value,label:value}))})),
    ...(["vitality","bear"] as const).map((key,i)=>({key,operator:LISTING_OPERATORS[key],label:key,enabled:true,order:i+4,levels:[6,7]})),
    {key:"regions",operator:"PAIRS_ANY",label:"地区",enabled:true,order:6,regions:regionPairs},
    {key:"serviceWindow",operator:"COVERS",label:"服务时段",enabled:true,order:7},
    {key:"skinGroups",operator:"GROUPS",label:"皮肤",enabled:true,order:8,categoryIds:[catA,catB]},
  ],sorts:[{key:"latest",label:"最新发布",enabled:true,order:0},{key:"resourceTotal",label:"资源总价",enabled:true,order:1},{key:"coreQuantity",label:"核心数量",enabled:true,order:2,itemIds:[o.itemId,core]}]};
  await o.testContext.test("Query A configuration authority, CAS, replay, audit rollback and immutable restore",async()=>{
    const empty=await ok(publicRoot+"/listing-filters");assert.equal(empty.available,false);assert.equal(empty.reasonCode,"FILTERS_UNCONFIGURED");
    assert.equal((await call(root+"/listing-filters",undefined,o.operator)).status,403);
    const body={expectedRevision:"0",config,reason:"isolated query configuration"},key="qa_config_"+randomUUID();
    assert.equal((await call(root+"/listing-filters",body,o.operator,"PUT")).status,403);
    const first=await call(root+"/listing-filters",body,o.boss,"PUT",key);assert.equal(first.status,200);assert.deepEqual(await call(root+"/listing-filters",body,o.boss,"PUT",key),first);
    assert.equal((await call(root+"/listing-filters",body,o.boss,"PUT")).status,409);
    const before=(await o.pool.query(`SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision`,[o.gameId])).rows;
    await o.migration.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`);
    try{assert.equal((await call(root+"/listing-filters",{...body,expectedRevision:"1"},o.boss,"PUT")).status,500);}finally{await o.migration.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`);}
    assert.deepEqual((await o.pool.query(`SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision`,[o.gameId])).rows,before);
    await assert.rejects(()=>o.pool.query(`UPDATE zzsh_supply.listing_filter_config SET config=config WHERE game_id=$1`,[o.gameId]),{code:"42501"});
    await assert.rejects(()=>o.migration.query(`DELETE FROM zzsh_supply.listing_filter_config WHERE game_id=$1`,[o.gameId]),{code:"40001"});
    const restored=await ok(root+"/listing-filters/restore",{expectedRevision:"1",restoreFromRevision:"1",reason:"copy historical fixture"});assert.equal(restored.revision,"2");assert.deepEqual(restored.config,first.body.config);
    const snapshot=async()=>({configs:(await o.pool.query('SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision',[o.gameId])).rows,audits:(await o.pool.query("SELECT * FROM zzsh_iam.audit_event WHERE action LIKE 'supply.listing_filters.%' ORDER BY id")).rows});
    const unchanged=await snapshot();
    for(const key of [["resources"],{}, {toString:null,valueOf:null},null,0,true,undefined,"UNKNOWN"]) {
      const bad={...config,fields:[{key,operator:"AND_MIN",label:"资源",enabled:true,order:0,options:[]}]};
      const rejected=await call(root+"/listing-filters",{expectedRevision:"2",config:bad,reason:"invalid field key fixture"},o.boss,"PUT");
      assert.equal(rejected.status,400,JSON.stringify(rejected.body));assert.equal(rejected.body.error.details[0].path,"config.fields.key");assert.deepEqual(await snapshot(),unchanged);
    }
    const invalid=structuredClone(config) as any;invalid.fields[0].operator="SQL";
    assert.equal((await call(root+"/listing-filters",{expectedRevision:"2",config:invalid,reason:"invalid logic"},o.boss,"PUT")).status,400);
  });
  if(process.env.SUPPLY_MEDIA_B0_ONLY==="1") {
    await o.testContext.test("B0 skin media projection, revocation revision, cursor and audit atomicity",async()=>{
      const snapshots=(await o.pool.query('SELECT id,payload,content_hash FROM zzsh_supply.listing_version ORDER BY id')).rows;
      const intent=await ok('/api/bff/admin/supply/media/upload-intents',{gameId:o.gameId,purpose:'SKIN_MEDIA',mime:'image/png',size:o.bytes.length});
      const uploaded=await fetch(o.base+'/api/bff/admin/supply/media/uploads/'+intent.intentId,{method:'PUT',headers:{origin:o.adminOrigin,cookie:o.boss.header(),'content-type':'image/png','x-upload-token':intent.uploadToken,'idempotency-key':'b0_'+randomUUID()},body:new Uint8Array(o.bytes)});assert.equal(uploaded.status,200);const asset=(await uploaded.json()).assetId;
      const bind=(skin:string,mediaId:string)=>call('/api/bff/admin/supply/skins/'+skin,{mediaId},o.boss,'PUT');
      assert.equal((await bind(skins[0]!,asset)).status,400,'unreviewed asset rejected');
      await ok('/api/bff/admin/supply/media/'+asset+'/review',{decision:'APPROVE',visibility:'PRIVATE_REVIEW'});
      assert.equal((await bind(skins[0]!,asset)).status,400,'private asset rejected');
      await ok('/api/bff/admin/supply/media/'+asset+'/visibility',{visibility:'PUBLIC_DISPLAY'});
      for(const s of skins.slice(0,2))assert.equal((await bind(s,asset)).status,200);
      const catalog=async()=>ok(publicRoot+'/catalog?limit=100');
      assert.equal((await catalog()).skins.find((s:any)=>s.id===skins[0]).mediaId,asset);
      const wrong=(await o.pool.query("SELECT id FROM zzsh_supply.media_asset WHERE game_id=$1 AND purpose='GAME_COVER' AND review_state='APPROVED' AND access_class='PUBLIC_DISPLAY' LIMIT 1",[o.gameId])).rows[0].id;
      assert.equal((await bind(skins[2]!,wrong)).status,400,'wrong purpose binding rejected');
      await o.pool.query('UPDATE zzsh_supply.skin SET media_id=$1 WHERE id=$2',[wrong,skins[2]]);
      assert.equal((await catalog()).skins.find((s:any)=>s.id===skins[2]).mediaId,null,'legacy wrong purpose projected as no image');
      const otherGame=(await o.pool.query('SELECT id FROM zzsh_supply.game WHERE id<>$1 LIMIT 1',[o.gameId])).rows[0].id;
      const source=(await o.pool.query('SELECT * FROM zzsh_supply.media_asset WHERE id=$1',[asset])).rows[0];const foreign={...source,id:'b0_foreign_'+randomUUID(),game_id:otherGame};const columns=Object.keys(foreign);
      await o.migration.query('INSERT INTO zzsh_supply.media_asset('+columns.map(c=>'"'+c+'"').join(',')+') VALUES('+columns.map((_,i)=>'$'+(i+1)).join(',')+')',columns.map(c=>foreign[c]));
      assert.equal((await bind(skins[2]!,foreign.id)).status,400,'cross-game rejected');
      await o.pool.query('UPDATE zzsh_supply.skin SET media_id=$1 WHERE id=$2',[foreign.id,skins[2]]);assert.equal((await catalog()).skins.find((s:any)=>s.id===skins[2]).mediaId,null);
      await o.pool.query('UPDATE zzsh_supply.skin SET media_id=NULL WHERE id=$1',[skins[2]]);
      // Legacy inconsistent bindings exercise all actual affected games; only synthetic regression data.
      await o.pool.query('UPDATE zzsh_supply.billable_item SET media_id=$1 WHERE id=$2',[asset,core]);
      await o.pool.query('UPDATE zzsh_supply.game SET cover_media_id=$1 WHERE id=$2',[asset,otherGame]);
      const before=async()=>({games:(await o.pool.query('SELECT id,catalog_revision::text,cover_media_id FROM zzsh_supply.game ORDER BY id')).rows,asset:(await o.pool.query('SELECT * FROM zzsh_supply.media_asset WHERE id=$1',[asset])).rows,skins:(await o.pool.query('SELECT id,media_id FROM zzsh_supply.skin ORDER BY id')).rows,items:(await o.pool.query('SELECT id,media_id FROM zzsh_supply.billable_item ORDER BY id')).rows,audits:(await o.pool.query('SELECT * FROM zzsh_iam.audit_event ORDER BY id')).rows});
      const original=await before();const cursor=(await ok(publicRoot+'/catalog?limit=1')).nextCursor;assert.ok(cursor);
      const metadata=await ok(publicRoot+'/listing-filters');
      const revoke=()=>call('/api/bff/admin/supply/media/'+asset+'/visibility',{visibility:'PRIVATE_REVIEW',reason:'B0 synthetic revoke'});
      await o.migration.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`);try{assert.equal((await revoke()).status,500);}finally{await o.migration.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`);}
      assert.deepEqual(await before(),original,'audit failure rolls back asset, bindings, revision and audit');
      assert.equal((await revoke()).status,200);
      const after=await before();for(const game of original.games)assert.equal(BigInt(after.games.find(g=>g.id===game.id).catalog_revision),BigInt(game.catalog_revision)+([o.gameId,otherGame].includes(game.id)?1n:0n));
      assert.equal((await catalog()).skins.find((s:any)=>s.id===skins[0]).mediaId,null);
      assert.equal((await fetch(o.base+'/api/v1/supply/media/'+asset+'/content')).status,404);
      assert.equal((await call(publicRoot+'/catalog?limit=1&cursor='+encodeURIComponent(cursor))).status,409);
      assert.equal((await call('/api/v1/supply/listings?'+new URLSearchParams({queryVersion:'2',gameId:o.gameId,catalogRevision:metadata.catalogRevision}))).status,409);
      const fresh=await ok(publicRoot+'/listing-filters');assert.equal((await call('/api/v1/supply/listings?'+new URLSearchParams({queryVersion:'2',gameId:o.gameId,catalogRevision:fresh.catalogRevision}))).status,200);
      const once=after.games;assert.equal((await revoke()).status,200);assert.deepEqual((await before()).games,once,'no binding means no revision bump');
      await ok('/api/bff/admin/supply/media/'+asset+'/visibility',{visibility:'PUBLIC_DISPLAY'});assert.equal((await bind(skins[0]!,asset)).status,200);
      const revision=BigInt((await ok(publicRoot+'/listing-filters')).catalogRevision);await ok('/api/bff/admin/supply/media/'+asset+'/review',{decision:'REJECT',reason:'synthetic rejected'});
      assert.equal(BigInt((await ok(publicRoot+'/listing-filters')).catalogRevision),revision+1n);assert.equal((await catalog()).skins.find((s:any)=>s.id===skins[0]).mediaId,null);
      assert.deepEqual((await o.pool.query('SELECT id,payload,content_hash FROM zzsh_supply.listing_version ORDER BY id')).rows,snapshots);
    });
    return;
  }
  if(process.env.SUPPLY_QUERY_A_CONFIG_ONLY==="1")return;
  const owner=(await o.pool.query(`SELECT owner_user_id FROM zzsh_supply.rental_account WHERE id=$1`,[o.accountId])).rows[0].owner_user_id;
  const media=(await o.pool.query(`SELECT * FROM zzsh_supply.media_asset WHERE account_id=$1 AND purpose='ACCOUNT_DISPLAY' AND review_state IN ('APPROVED','PUBLISHED') AND access_class='PUBLIC_DISPLAY' ORDER BY id LIMIT 1`,[o.accountId])).rows[0];assert.ok(media);
  const samples:{id:string;core:string|null;price:bigint;at:string;index:number}[]=[];
  const start=performance.now();
  for(let batch=0;batch<100;batch++){
    await withTransaction(o.pool,async client=>{
      for(let i=batch*10;i<batch*10+10;i++) {
        const id="qa_account_"+String(i).padStart(4,"0");await client.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES($1,$2,$3)`,[id,owner,o.gameId]);
        const asset={...media,id:"qa_media_"+i,account_id:id,technical_state:"READY",technical_checked_at:new Date(),technical_failure_code:null};const columns=Object.keys(asset);await client.query(`INSERT INTO zzsh_supply.media_asset(${columns.map(c=>'"'+c+'"').join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')})`,columns.map(c=>asset[c]));
        o.gates.set(id,{publisherBail:"NOT_REQUIRED",occupancy:"FREE",reference:"fixture:query-a"});const gate=async()=>o.gates.get(id)!;
        const a=await readPublishingAccount(client,id);await createListingDraft(client,a,a.revision,gate);
        const extra=i%3===0?null:(i>=695&&i<705?9007199254740992n+BigInt(i-695):BigInt(i%11)*1000000n).toString();
        const regions=[...regionPairs,{province:"河南省",city:"成都市"}];const region=regions[i%4]!;
        const hours=[{start:0,end:1440,cross:false},{start:540,end:1380,cross:false},{start:1320,end:120,cross:true},{start:300,end:600,cross:false}][i%4]!;
        const chosen=skins.filter((_,j)=>i % ([2,5,3,7][j]!) !== 1); // deterministic overlapping categories
        const attrs={safe_box_code:i%2?"box-a":"box-b",vit_level:6+i%2,bear_level:6+Math.floor(i/2)%2,grading_code:i%2?"7":"6",login_method_code:i%3?"legacy_login_wechat":"legacy_login_qq",region_province:region.province,region_city:region.city,service_window_start_minute:hours.start,service_window_end_minute:hours.end,service_window_cross_midnight:i%19===0?!hours.cross:hours.cross,service_window_timezone:i%17===0?null:"Asia/Shanghai",...(rule.schema==="haff-ratio-v2"?{rentalPricing:{rentalMode:"ordinary"}}:{})};
        await saveListingDraft(client,a,{expectedRevision:a.revision,title:"query-a-"+String(i).padStart(4,"0"),attributes:attrs,termOptionCode:"daily-10m",pricingOptionCode:rule.schema==="haff-ratio-v2"?"":"standard",inventory:[{itemId:o.itemId,quantity:String((i%7+1)*10000000)},{itemId:round,quantity:String(i%13*60)},...(extra===null?[]:[{itemId:core,quantity:extra}])],skins:chosen,entitlements:[],mediaBindings:[{assetId:asset.id,position:0}]},gate);
        await quoteListing(client,a,a.revision);const v=await readCurrentVersion(client,a);const token=()=>({expectedRevision:a.revision,versionId:v.id,releaseId:v.rule_release_id,contentHash:v.content_hash});
        await acceptListingRules(client,a,token());await submitListing(client,a,owner,token(),gate);
        const at=(await client.query(`SELECT to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM zzsh_supply.listing_publication WHERE version_id=$1`,[v.id])).rows[0].at;
        samples.push({id,index:i,core:extra,price:BigInt(String((v.payload!.quoteValues as any).resourceTotal.amount).replace('.','')),at});
      }
    });
    if(batch%20===19)console.log("Query A approved synthetic candidates",samples.length);
  }
  console.log("Query A seed",{count:samples.length,ms:Math.round(performance.now()-start),media:"synthetic copies of existing approved fixture bytes; quotes/accept/review through business services"});
  const cmp=(a:string|bigint,b:string|bigint)=>a<b?-1:a>b?1:0;
  const ordered=(sort:string,direction:string)=>[...samples].sort((a,b)=>{const left=sort==="latest"?a.at:sort==="resourceTotal"?a.price:a.core===null?null:BigInt(a.core),right=sort==="latest"?b.at:sort==="resourceTotal"?b.price:b.core===null?null:BigInt(b.core);return left===null&&right!==null?1:right===null&&left!==null?-1:left===null&&right===null?cmp(a.id,b.id):(direction==="ASC"?1:-1)*cmp(left!,right!)||cmp(a.id,b.id);});
  const blocked=new Set(ordered("latest","DESC").slice(0,200).map(s=>s.id));for(const id of blocked)o.gates.set(id,{publisherBail:"UNKNOWN",occupancy:"FREE",reference:"fixture:withdrawn"});
  const list=async(extra:Record<string,string>={})=>call("/api/v1/supply/listings?"+new URLSearchParams({queryVersion:"2",gameId:o.gameId,q:"query-a-",...extra}));
  await o.testContext.test("Query A budget-empty pages progress; every sort/direction traverses precise keys and NULLS LAST",async()=>{
    const first=await list();assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.items.length,0);assert.equal(first.body.scannedCount,200);assert.equal(first.body.scanBudgetReached,true);assert.ok(first.body.nextCursor);
    for(const sort of ["latest","resourceTotal","coreQuantity"])for(const direction of ["ASC","DESC"]) {
      let cursor:string|null=null;const seen:string[]=[];let pages=0;
      do{const r=await list({sort,direction,limit:"50",...(sort==="coreQuantity"?{coreItemId:core}:{}),...(cursor?{cursor}:{})});assert.equal(r.status,200,JSON.stringify(r.body));seen.push(...r.body.items.map((x:any)=>x.id));cursor=r.body.nextCursor;assert.ok(++pages<50);}while(cursor);
      assert.deepEqual(seen,ordered(sort,direction).filter(s=>!blocked.has(s.id)).map(s=>s.id));console.log("Query A traversal",{sort,direction,pages,count:seen.length});
    }
  });
  await o.testContext.test("Query A SQL combines resources, enum OR, independent skin groups, paired regions and complete windows",async()=>{
    const target=samples[700]!;assert.equal(blocked.has(target.id),false);
    const filters:ListingFilters={resources:[{itemId:o.itemId,minQuantity:"10000000"},{itemId:round,minQuantity:"600"}],safeBoxCodes:["box-a","box-b"],vitality:{min:6},bear:{min:6},gradingCodes:["6","7"],loginMethodCodes:["legacy_login_wechat"],regions:[regionPairs[0]!,regionPairs[2]!],serviceWindow:{startMinute:540,endMinute:1380,crossMidnight:false,timezone:"Asia/Shanghai"},skinGroups:[{categoryId:catA,ids:skins.slice(0,2),match:"ALL"},{categoryId:catB,ids:[skins[3]!],match:"ANY"}]};
    const r=await list({q:"query-a-0700",filters:JSON.stringify(filters)});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.items.map((x:any)=>x.id),[target.id]);
    assert.equal((await list({q:"query-a-0703",filters:JSON.stringify({regions:[regionPairs[0],regionPairs[2]]})})).body.items.length,0,"no province/city cartesian product");
    assert.equal((await list({q:"query-a-0702",filters:JSON.stringify({serviceWindow:{startMinute:1380,endMinute:60,crossMidnight:true,timezone:"Asia/Shanghai"}})})).body.items.length,1);
    assert.equal((await list({q:"query-a-0703",filters:JSON.stringify({serviceWindow:{startMinute:540,endMinute:1380,crossMidnight:false,timezone:"Asia/Shanghai"}})})).body.items.length,0,"overlap is not containment");
    for(const index of [680,684])assert.equal((await list({q:"query-a-"+String(index).padStart(4,"0"),filters:JSON.stringify({serviceWindow:{startMinute:540,endMinute:1380,crossMidnight:false,timezone:"Asia/Shanghai"}})})).body.items.length,0,"unknown timezone or contradictory cross-midnight is not a match");
    for(const bad of [{resources:[{itemId:"foreign",minQuantity:"0"}]},{skinGroups:[{categoryId:catA,ids:[skins[2]],match:"ANY"}]},{gradingCodes:["UNKNOWN"]},{regions:[{province:"河南省",city:"成都市"}]}])assert.equal((await list({filters:JSON.stringify(bad)})).status,400);
  });
  await o.testContext.test("Query A cursor revision binding and real anonymous Web BFF byte budget",async()=>{
    const first=(await list()).body;assert.ok(first.nextCursor);
    assert.equal((await list({cursor:first.nextCursor,view:"card"})).status,200);
    assert.equal((await list({cursor:first.nextCursor,q:"other"})).status,409);
    assert.equal((await list({cursor:first.nextCursor+"x"})).status,400);
    assert.equal((await list({filterRevision:"1"})).status,409);
    await ok(root+"/listing-filters/restore",{expectedRevision:"2",restoreFromRevision:"1",reason:"revision invalidation fixture"});assert.equal((await list({cursor:first.nextCursor})).status,409);
    const cursor=(await list()).body.nextCursor;
    await ok(root+"/items",{code:"query_revision_bump",name:"目录revision",unit:"PIECE"});assert.equal((await list({cursor})).status,409);
    const oldApi=process.env.ZZSH_API_ORIGIN,oldWeb=process.env.ZZSH_WEB_ORIGIN;process.env.ZZSH_API_ORIGIN=o.base;process.env.ZZSH_WEB_ORIGIN=o.userOrigin;
    let web:any;try{web=require("../../../web/src/app/api/supply/[...path]/route.ts");}finally{if(oldApi===undefined)delete process.env.ZZSH_API_ORIGIN;else process.env.ZZSH_API_ORIGIN=oldApi;if(oldWeb===undefined)delete process.env.ZZSH_WEB_ORIGIN;else process.env.ZZSH_WEB_ORIGIN=oldWeb;}
    const suffix="?queryVersion=2&gameId="+o.gameId+"&q=";const budget=8192-("/api/bff/user/supply/listings"+suffix).length;const pad="%20".repeat(Math.floor(budget/3))+"+".repeat(budget%3);
    const response=await web.GET(new Request(o.userOrigin+"/api/supply/listings"+suffix+pad),{params:Promise.resolve({path:["listings"]})});assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    const tooLong=await web.GET(new Request(o.userOrigin+"/api/supply/listings"+suffix+pad+"+"),{params:Promise.resolve({path:["listings"]})});assert.equal(tooLong.status,400);assert.equal((await tooLong.json()).error.details[0].path,"url");
    const metadata=await web.GET(new Request(o.userOrigin+"/api/supply/games/"+o.gameId+"/listing-filters"),{params:Promise.resolve({path:["games",o.gameId,"listing-filters"]})});assert.equal(metadata.status,200);const m=await metadata.json();assert.equal(m.defaultSort.label,"最新发布");assert.ok(m.skinCatalogUrl.startsWith("/api/supply/"));
    const legacy=await call("/api/v1/supply/listings?"+new URLSearchParams({gameId:o.gameId,q:"query-a-0700",itemId:round,minQuantity:"600"})+"&skinId="+skins[0]+"&skinId="+skins[1]+"&skinMatch=ALL");assert.equal(legacy.status,200);assert.equal(legacy.body.items.length,1);
  });
  const query=new URLSearchParams({queryVersion:"2",gameId:o.gameId,q:"query-a-",sort:"latest"});const sql=buildListingCandidates(parseListingQueryV2(query,"/listings?"+query),null);
  const plan=(await o.pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+sql.text,sql.values)).rows;
  await mkdir(join(__dirname,"../../../../tmp/account-list-ui"),{recursive:true});await writeFile(join(__dirname,"../../../../tmp/account-list-ui/query-a-plan.json"),JSON.stringify({sampleCount:1000,unavailable:200,sql:sql.text,plan},null,2));console.log("Query A EXPLAIN saved; no speculative per-combination indexes");
  await o.testContext.test("Query A disabled references reject query and historical restore; release change invalidates cursor",async()=>{
    const cursor=(await list()).body.nextCursor;assert.ok(cursor);
    await ok('/api/bff/admin/supply/items/'+core,{enabled:false},o.boss,'PUT');
    assert.equal((await list({cursor})).status,409);
    assert.equal((await list({sort:'coreQuantity',coreItemId:core})).status,400);
    const before=(await o.pool.query('SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision',[o.gameId])).rows;
    assert.equal((await call(root+'/listing-filters/restore',{expectedRevision:'3',restoreFromRevision:'1',reason:'disabled historical reference'})).status,400);
    assert.deepEqual((await o.pool.query('SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision',[o.gameId])).rows,before);
    await ok('/api/bff/admin/supply/items/'+core,{enabled:true},o.boss,'PUT');
    await ok('/api/bff/admin/supply/skins/'+skins[0],{enabled:false},o.boss,'PUT');
    assert.equal((await list({filters:JSON.stringify({skinGroups:[{categoryId:catA,ids:[skins[0]],match:'ANY'}]})})).status,400);
    await ok('/api/bff/admin/supply/skins/'+skins[0],{enabled:true},o.boss,'PUT');
    const latest=(await o.pool.query('SELECT r.* FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id WHERE g.id=$1',[o.gameId])).rows[0];
    const oldCursor=(await list()).body.nextCursor;assert.ok(oldCursor);
    await ok('/api/bff/admin/supply/releases',{gameId:o.gameId,priceVersionId:price,termVersionId:latest.term_version_id,agreementVersionId:latest.agreement_version_id,expectedGeneration:String(latest.generation)});
    assert.equal((await list({cursor:oldCursor})).status,409);
    // A future/unsupported historical payload must not bypass today's fixed parser on restore.
    const unsupported=structuredClone(config);unsupported.fields[0]!.operator='SQL';
    await o.migration.query('INSERT INTO zzsh_supply.listing_filter_config(game_id,revision,config,created_by_admin_id) VALUES($1,4,$2,$3)',[o.gameId,unsupported,o.bossId]);
    const historyBefore=(await o.pool.query('SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision',[o.gameId])).rows;
    assert.equal((await call(root+'/listing-filters/restore',{expectedRevision:'4',restoreFromRevision:'4',reason:'unsupported historical logic'})).status,400);
    assert.deepEqual((await o.pool.query('SELECT * FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision',[o.gameId])).rows,historyBefore);
  });
}
