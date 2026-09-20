import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { checkedId,parseFilterConfig,type FilterConfig,type ListingQueryV2 } from "./listing-filter-contract";
import { invalid,notFound } from "./supply-util";
import { publicGradingOptions,publicLoginMethodOptions } from "./listing-query";
import { GAME_SERVICE,requirePublicGameService } from "./game-services";

export async function listingCatalogContext(client:PoolClient,gameId:string) {
  const game=(await client.query(`SELECT g.id,g.code,g.catalog_revision::text AS "catalogRevision",g.current_release_id AS "ruleReleaseId",p.haff_rule AS rule FROM zzsh_supply.game g LEFT JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id LEFT JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE g.id=$1`,[gameId])).rows[0];
  if(!game || game.code!=="delta")throw notFound();
  const items=(await client.query<{id:string;code:string;name:string;unit:string}>(`SELECT id,code,name,unit FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled ORDER BY sort_order,id`,[gameId])).rows;
  const categories=(await client.query<{id:string;parentId:string|null;name:string}>(`WITH RECURSIVE visible AS (SELECT id,parent_id,name FROM zzsh_supply.skin_category WHERE game_id=$1 AND parent_id IS NULL AND enabled AND form_visible UNION ALL SELECT c.id,c.parent_id,c.name FROM zzsh_supply.skin_category c JOIN visible p ON p.id=c.parent_id WHERE c.game_id=$1 AND c.enabled AND c.form_visible) SELECT id,parent_id AS "parentId",name FROM visible ORDER BY id`,[gameId])).rows;
  return {game,items,categories};
}
type Catalog=Awaited<ReturnType<typeof listingCatalogContext>>;
function allowedCodes(c:Catalog,key:string):string[] {
  if(key==="safeBoxCodes")return Object.keys(c.game.rule?.baseBySafeBox??{});
  return (key==="gradingCodes"?publicGradingOptions():publicLoginMethodOptions()).map(o=>o.code);
}
function allowedLevels(c:Catalog,key:string):number[]{return Object.keys(c.game.rule?.[key==="vitality"?"vitalityDeltaByLevel":"bearDeltaByLevel"]??{}).map(Number);}
export function validateConfigCatalog(config:FilterConfig,c:Catalog) {
  for(const f of config.fields) {
    if(f.items?.some(r=>!c.items.some(i=>i.id===r.itemId)))throw invalid("Unknown, disabled or foreign item","config.fields.items");
    if(f.categoryIds?.some(id=>!c.categories.some(c=>c.id===id)))throw invalid("Unknown, hidden or foreign category","config.fields.categoryIds");
    if(f.options?.some(o=>!allowedCodes(c,f.key).includes(o.value)))throw invalid("Unknown option code","config.fields.options");
    if(f.levels?.some(l=>!allowedLevels(c,f.key).includes(l)))throw invalid("Unknown allowed level","config.fields.levels");
  }
  for(const sort of config.sorts)if(sort.itemIds?.some(id=>!c.items.some(i=>i.id===id&&i.unit==="HAFF_BASE")))throw invalid("Core sort requires enabled HAFF_BASE item","config.sorts.itemIds");
}
export async function readListingState(client:PoolClient,gameId:string) {
  await requirePublicGameService(client,gameId,GAME_SERVICE.ACCOUNT_RENTAL);
  const catalog=await listingCatalogContext(client,gameId);
  const row=(await client.query(`SELECT revision::text,config FROM zzsh_supply.listing_filter_config WHERE game_id=$1 ORDER BY revision DESC LIMIT 1`,[gameId])).rows[0];
  let config:FilterConfig|null=null;
  if(row){try{config=parseFilterConfig(row.config);}catch{throw new SecurityApiError(503,"LISTING_QUERY_UNAVAILABLE","Filter configuration requires an update");}}
  return {catalog,config,filterRevision:row?.revision??null,catalogRevision:catalog.game.catalogRevision as string,ruleReleaseId:catalog.game.ruleReleaseId as string|null};
}
export async function validateListingQuery(client:PoolClient,q:ListingQueryV2,state:Awaited<ReturnType<typeof readListingState>>) {
  if(!state.config || !state.ruleReleaseId)throw new SecurityApiError(503,"LISTING_QUERY_UNAVAILABLE","Listing filters or rules are not configured");
  const config=state.config,c=state.catalog;
  const sort=config.sorts.find(s=>s.key===q.sort&&s.enabled);if(!sort)throw invalid("Sort is disabled","sort");
  if(q.coreItemId && (!sort.itemIds?.includes(q.coreItemId)||!c.items.some(i=>i.id===q.coreItemId&&i.unit==="HAFF_BASE")))throw invalid("Invalid core item","coreItemId");
  for(const [key,value] of Object.entries(q.filters)) {
    const f=config.fields.find(f=>f.key===key&&f.enabled);if(!f)throw invalid("Filter is disabled","filters."+key);
    if(key==="resources")for(const r of q.filters.resources!) {const item=f.items?.find(i=>i.itemId===r.itemId);if(!item||!c.items.some(i=>i.id===r.itemId)||BigInt(r.minQuantity)<BigInt(item.min)||BigInt(r.minQuantity)>BigInt(item.max))throw invalid("Resource is unavailable or outside configured bounds","filters.resources");}
    if(key==="safeBoxCodes"||key==="gradingCodes"||key==="loginMethodCodes")if((value as string[]).some(v=>!f.options?.some(o=>o.value===v)||!allowedCodes(c,key).includes(v)))throw invalid("Unavailable option","filters."+key);
    if(key==="vitality"||key==="bear"){const min=(value as {min:number}).min;if(!f.levels?.includes(min)||!allowedLevels(c,key).includes(min))throw invalid("Unavailable level","filters."+key);}
    if(key==="regions")if(q.filters.regions!.some(r=>!f.regions?.some(a=>a.province===r.province&&a.city===r.city)))throw invalid("Unavailable region pair","filters.regions");
    if(key==="skinGroups") {
      const all=q.filters.skinGroups!.flatMap(g=>g.ids);
      const skins=(await client.query<{id:string;categoryId:string}>(`SELECT id,category_id AS "categoryId" FROM zzsh_supply.skin WHERE game_id=$1 AND enabled AND form_visible AND id=ANY($2::text[])`,[q.gameId,all])).rows;
      const parents=new Map(c.categories.map(r=>[r.id,r.parentId]));
      for(const g of q.filters.skinGroups!){if(!f.categoryIds?.includes(g.categoryId)||!parents.has(g.categoryId))throw invalid("Unavailable category","filters.skinGroups.categoryId");
        for(const id of g.ids){const s=skins.find(s=>s.id===id);let cat=s?.categoryId;while(cat && parents.has(cat)&&cat!==g.categoryId)cat=parents.get(cat)??undefined;if(!s||cat!==g.categoryId)throw invalid("Unknown, hidden, disabled or foreign skin","filters.skinGroups.ids");}}
    }
  }
}
export function publicFilterMetadata(state:Awaited<ReturnType<typeof readListingState>>,signingReady:boolean) {
  const {catalog:c,config}=state;
  const fields=config?.fields.filter(f=>f.enabled).map(f=>({...f,
    ...(f.items?{items:f.items.filter(r=>c.items.some(i=>i.id===r.itemId))}:{}),
    ...(f.options?{options:f.options.filter(o=>allowedCodes(c,f.key).includes(o.value))}:{}),
    ...(f.levels?{levels:f.levels.filter(n=>allowedLevels(c,f.key).includes(n))}:{}),
    ...(f.categoryIds?{categoryIds:f.categoryIds.filter(id=>c.categories.some(a=>a.id===id))}:{}),
  })).sort((a,b)=>a.order-b.order)||[];
  return {available:Boolean(config&&state.ruleReleaseId&&signingReady),reasonCode:!config?"FILTERS_UNCONFIGURED":!state.ruleReleaseId?"RULES_UNCONFIGURED":!signingReady?"SIGNING_UNCONFIGURED":null,gameId:c.game.id,queryVersion:2,filterRevision:state.filterRevision,catalogRevision:state.catalogRevision,ruleReleaseId:state.ruleReleaseId,defaultSort:{sort:"latest",direction:"DESC",label:"最新发布"},fields,sorts:config?.sorts.filter(s=>s.enabled).map(s=>({...s,...(s.itemIds?{itemIds:s.itemIds.filter(id=>c.items.some(i=>i.id===id&&i.unit==="HAFF_BASE"))}:{})})).sort((a,b)=>a.order-b.order)??[],directions:["ASC","DESC"],items:c.items.filter(i=>fields.some(f=>f.items?.some(r=>r.itemId===i.id))||config?.sorts.some(s=>s.itemIds?.includes(i.id))),categories:c.categories.filter(a=>fields.some(f=>f.categoryIds?.includes(a.id))),skinCatalogUrl:`/api/v1/supply/games/${checkedId(c.game.id,"gameId")}/catalog`,limits:{urlBytes:8192,resources:16,skinGroups:8,skinIds:50,enumValues:50,regions:20,limit:50,scanBudget:200},livePages:true};
}
