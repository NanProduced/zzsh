import { effectivePublicationStateSql, listingSearchPattern } from "./listing-query";
import type { ListingFilters, ListingQueryV2, ServiceWindow } from "./listing-filter-contract";

type CandidateFilters=Omit<ListingFilters,"skinGroups">&{skinGroups?:{ids:string[];match:string}[]};
export const PUBLIC_CANDIDATE_FROM=`FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id JOIN zzsh_supply.game g ON g.id=a.game_id`;
export const PUBLIC_CANDIDATE_WHERE=`a.lifecycle='ACTIVE' AND NOT a.owner_paused AND NOT a.staff_restricted AND a.legacy_hold='NONE' AND ${effectivePublicationStateSql("v","pub")} AND v.rule_release_id=g.current_release_id AND pub.content_hash=v.content_hash`;
const attrs=`v.payload#>'{declaration,attributes}'`;
const attribute=(name:string)=>`(${attrs})->>'${name}'`;
const numericAttribute=(name:string,digits:number)=>`CASE WHEN jsonb_typeof((${attrs})->'${name}')='number' AND ${attribute(name)} ~ '^(0|[1-9][0-9]{0,${digits-1}})$' THEN (${attribute(name)})::numeric END`;
function windowLiteral(w:ServiceWindow,p:(v:unknown)=>string):string {
  const start=p(w.startMinute),end=p(w.endMinute);
  return w.crossMidnight?`int4multirange(int4range(0,${end}::int,'[)'),int4range(${start}::int,1440,'[)'))`:`int4multirange(int4range(${start}::int,${end}::int,'[)'))`;
}
export function candidatePredicates(filters:CandidateFilters,q:string|null,p:(v:unknown)=>string):string[] {
  const where:string[]=[];
  if(q!==null)where.push(`v.title ILIKE ${p(listingSearchPattern(q))} ESCAPE '\\'`);
  for(const row of filters.resources??[]){const itemId=p(row.itemId),bounds=[row.minQuantity===undefined?null:`l.quantity>=${p(row.minQuantity)}::numeric`,row.maxQuantity===undefined?null:`l.quantity<=${p(row.maxQuantity)}::numeric`].filter(Boolean);where.push(`EXISTS(SELECT 1 FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${itemId} AND ${bounds.join(" AND ")})`);}
  for(const group of filters.skinGroups??[]) {
    if(!group.ids.length)continue;const ids=p(group.ids);
    where.push(group.match==="ALL"?`(SELECT count(*) FROM zzsh_supply.listing_skin s WHERE s.version_id=v.id AND s.skin_id=ANY(${ids}::text[]))=cardinality(${ids}::text[])`:`EXISTS(SELECT 1 FROM zzsh_supply.listing_skin s WHERE s.version_id=v.id AND s.skin_id=ANY(${ids}::text[]))`);
  }
  for(const [key,attr] of [["safeBoxCodes","safe_box_code"],["gradingCodes","grading_code"],["loginMethodCodes","login_method_code"]] as const)if(filters[key]?.length)where.push(`${attribute(attr)}=ANY(${p(filters[key])}::text[])`);
  for(const [key,attr,legacy] of [["vitality","vit_level","vitLevel"],["bear","bear_level","bearLevel"]] as const)if(filters[key]){
    const n=`COALESCE((${numericAttribute(attr,10)}),(${numericAttribute(legacy,10)}))`;
    where.push(`${n}>=${p(filters[key]!.min)}::numeric AND ${n}<=2147483647`);
  }
  if(filters.regions?.length)where.push(`(${filters.regions.map(r=>`(${attribute("region_province")}=${p(r.province)} AND ${attribute("region_city")}=${p(r.city)})`).join(" OR ")})`);
  if(filters.serviceWindow){
    const s=`(${numericAttribute("service_window_start_minute",4)})`,e=`(${numericAttribute("service_window_end_minute",4)})`,cross=attribute("service_window_cross_midnight");
    const valid=`${attribute("service_window_timezone")}='Asia/Shanghai' AND jsonb_typeof((${attrs})->'service_window_cross_midnight')='boolean' AND ${s}<1440 AND ${e}<=1440 AND ${s}<>${e} AND ((${cross}='true' AND ${e}<${s}) OR (${cross}='false' AND ${e}>${s}))`;
    const actual=`CASE WHEN ${valid} THEN CASE WHEN ${cross}='true' THEN int4multirange(int4range(0,${e}::int,'[)'),int4range(${s}::int,1440,'[)')) ELSE int4multirange(int4range(${s}::int,${e}::int,'[)')) END END`;
    where.push(`${windowLiteral(filters.serviceWindow,p)} <@ (${actual})`);
  }
  return where;
}
export type ListingPosition={id:string;key:string|null;isNull:boolean};
export function buildListingCandidates(query:ListingQueryV2,after:ListingPosition|null) {
  const values:unknown[]=[];const p=(v:unknown)=>{values.push(v);return '$'+values.length;};
  const where=[PUBLIC_CANDIDATE_WHERE,`a.game_id=${p(query.gameId)}`,...candidatePredicates(query.filters,query.q,p)];
  const publication=`pub.published_at`;
  const amount=`v.payload#>>'{quoteValues,resourceTotal,amount}'`;
  const price=`CASE WHEN v.payload#>>'{quoteValues,currency}'='CNY' AND v.payload#>>'{quoteValues,resourceTotal,unit}'='yuan' AND v.payload#>>'{quoteValues,resourceTotal,scale}'='2' AND ${amount} ~ '^(0|[1-9][0-9]{0,63})[.][0-9]{2}$' THEN (${amount})::numeric END`;
  const key=query.sort==="latest"?publication:query.sort==="resourceTotal"?price:`(SELECT quantity FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${p(query.coreItemId)})`;
  // Public v2 snapshots must be STANDARD. Legacy quotes have no tier field.
  where.push(`(v.payload#>>'{quoteValues,schemaVersion}'='1' OR v.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}'='STANDARD')`);
  let seek="";
  if(after){const id=p(after.id);if(after.isNull)seek=`WHERE sort_key IS NULL AND id>${id}`;
    else {const k=p(after.key),cast=query.sort==="latest"?"timestamptz":"numeric",op=query.direction==="ASC"?">":"<";seek=`WHERE (sort_key ${op} ${k}::${cast} OR sort_key IS NULL OR (sort_key=${k}::${cast} AND id>${id}))`;}}
  const text=`WITH candidates AS (SELECT a.id,v.id AS version_id,${key} AS sort_key ${PUBLIC_CANDIDATE_FROM} WHERE ${where.join(" AND ")}) SELECT id,version_id,${query.sort==="latest"?`to_char(sort_key AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:"sort_key::text"} AS key FROM candidates ${seek} ORDER BY sort_key ${query.direction} NULLS LAST,id ASC LIMIT 200`;
  return {text,values};
}
