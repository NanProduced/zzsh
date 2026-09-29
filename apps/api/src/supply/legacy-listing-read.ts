import type { PoolClient } from "pg";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "./content-hash";
import { projectPublicAttributeDisplay } from "./listing-query";
import { assertGameScope, conflict, invalid, notFound, sha256Hex } from "./supply-util";
import { decodeListingCursor, encodeListingCursor, type ListingCursorBinding, type ListingCursorKey } from "./listing-cursor";
import { candidatePredicates, type ListingPosition } from "./listing-candidates";
import type { ListingQueryV2 } from "./listing-filter-contract";

export type LegacyReadSnapshot = {
  schema: "legacy-listing-read-v1";
  resourceNo: string;
  haffRentYuan: string;
  goodsYuan: string;
  depositYuan: string;
  termDays: string;
  dailyHaffBase: string;
};

export function parseLegacyReadSnapshot(value: unknown): LegacyReadSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid legacy read snapshot");
  const x = value as Record<string, unknown>;
  if (Object.keys(x).sort().join(",") !== "dailyHaffBase,depositYuan,goodsYuan,haffRentYuan,resourceNo,schema,termDays"
    || x.schema !== "legacy-listing-read-v1" || typeof x.resourceNo !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(x.resourceNo)) throw invalid("Invalid legacy read snapshot fields");
  for (const k of ["haffRentYuan", "goodsYuan", "depositYuan"])
    if (typeof x[k] !== "string" || !/^(0|[1-9]\d{0,13})\.\d{2}$/.test(x[k] as string)) throw invalid("Invalid historical amount", k);
  for (const k of ["termDays", "dailyHaffBase"])
    if (typeof x[k] !== "string" || !/^[1-9]\d{0,17}$/.test(x[k] as string)) throw invalid("Invalid historical quantity", k);
  return x as LegacyReadSnapshot;
}

/** Controlled importer only; caller owns the transaction. No public write route. */
export async function recordLegacyReadSnapshot(client: PoolClient, accountId: string, input: {
  observationVersionId: string; sourceSystem: string; sourceEntity: string; legacyId: string;
  sourceDigest: string; sourceStatus: number; sourceDeleted: boolean; sourceUpdatedAt: string; evidenceRef: string; snapshot: unknown;
}, actor: { id: string; sessionId: string; requestId: string }): Promise<void> {
  const access = await loadEffectiveAdminAccess(client, actor.id);
  requirePermission(access, "supply.catalog.manage");
  const account = (await client.query("SELECT game_id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!account) throw notFound();
  await assertGameScope(client, actor.id, access!.isBoss, account.game_id);
  const snapshot = parseLegacyReadSnapshot(input.snapshot);
  if (input.sourceSystem !== "legacy_mysql_restore" || input.sourceEntity !== "la_rental_accounts" || input.sourceStatus !== 3 || input.sourceDeleted !== false
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.sourceUpdatedAt)
    || Number.isNaN(Date.parse(input.sourceUpdatedAt)) || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("Historical listing requires source publication evidence");
  const values = [accountId,input.observationVersionId,input.sourceSystem,input.sourceEntity,input.legacyId,input.sourceDigest,input.sourceStatus,input.sourceUpdatedAt,input.evidenceRef,snapshot,actor.id];
  const old = (await client.query("SELECT observation_version_id,source_system,source_entity,legacy_id,source_digest,source_updated_at,snapshot,evidence_ref FROM zzsh_supply.legacy_listing_read_snapshot WHERE account_id=$1",[accountId])).rows[0];
  if (old) {
    if (old.observation_version_id!==input.observationVersionId || old.source_system!==input.sourceSystem || old.source_entity!==input.sourceEntity || old.legacy_id!==input.legacyId || old.source_digest!==input.sourceDigest
      || old.source_updated_at.toISOString()!==input.sourceUpdatedAt || old.evidence_ref!==input.evidenceRef || canonicalize(old.snapshot)!==canonicalize(snapshot)) throw conflict("Historical snapshot conflicts with the recorded source");
    return;
  }
  await client.query(`INSERT INTO zzsh_supply.legacy_listing_read_snapshot(account_id,observation_version_id,source_system,source_entity,legacy_id,source_digest,source_status,source_updated_at,evidence_ref,snapshot,created_by_admin_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, values);
  await recordAudit(client,{actorType:"admin",actorId:actor.id,sessionId:actor.sessionId,requestId:actor.requestId,action:"supply.legacy.read_snapshot_recorded",objectType:"rental_account",objectId:accountId,outcome:"SUCCESS",reason:"旧站上架资料与原始金额只读展示；不创建新平台发布或交易事实",details:{sourceSystem:input.sourceSystem,sourceEntity:input.sourceEntity,legacyId:input.legacyId,sourceDigest:input.sourceDigest,readOnly:true}});
}

// `v` is the version the public read actually shows: the owner's current native
// draft when it exists (the editable representation that carries supplemented
// fields such as the service window, skins and test media), otherwise the
// immutable source observation. Source identity and amounts always stay on `h`.
const FROM = `FROM zzsh_supply.legacy_listing_read_snapshot h
 JOIN zzsh_supply.rental_account a ON a.id=h.account_id
 JOIN zzsh_supply.listing_version ov ON ov.id=h.observation_version_id
 LEFT JOIN zzsh_supply.listing_version dv ON dv.id=a.current_version_id AND dv.origin='NATIVE' AND dv.review_state='DRAFT'
 JOIN zzsh_supply.listing_version v ON v.id=COALESCE(dv.id,ov.id)
 JOIN zzsh_supply.game g ON g.id=a.game_id
 JOIN zzsh_supply.game_service_operation gs ON gs.game_id=g.id AND gs.service_code='ACCOUNT_RENTAL'
 JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id
 LEFT JOIN zzsh_iam.user_identity_state us ON us.user_id=u.id`;
const VISIBLE = `g.enabled AND gs.enabled AND a.lifecycle='ACTIVE' AND a.legacy_hold='NONE' AND NOT a.owner_paused AND NOT a.staff_restricted
 AND NOT u.suspended AND COALESCE(us.account_status,'ACTIVE')='ACTIVE'
 AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id)`;

// Mode selection must not depend on the currently visible row count: an
// enabled game with a valid configuration keeps its filters and returns an
// empty list when every snapshot is hidden. Hidden rows are never projected.
export async function hasLegacyReadSnapshots(client: PoolClient, gameId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h JOIN zzsh_supply.rental_account a ON a.id=h.account_id WHERE a.game_id=$1 LIMIT 1`,[gameId])).rowCount);
}

export async function readLegacyListing(client: PoolClient, accountId: string) {
  const r=(await client.query(`SELECT a.id,g.id game_id,g.code game_code,g.name game_name,v.id version_id,v.title,v.description,v.attributes,h.snapshot,h.source_updated_at
    ${FROM} WHERE a.id=$1 AND ${VISIBLE}`,[accountId])).rows[0];
  if(!r)throw notFound();
  const snapshot=parseLegacyReadSnapshot(r.snapshot);
  const rows=(await client.query(`SELECT i.id,i.code,i.name,i.unit,l.quantity::text quantity FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id WHERE l.version_id=$1 ORDER BY i.sort_order,i.id`,[r.version_id])).rows;
  const skins=(await client.query<{id:string;name:string;categoryCode:string|null;categoryName:string|null}>(`SELECT s.id,s.name,c.code AS "categoryCode",c.name AS "categoryName"
    FROM zzsh_supply.listing_skin ls JOIN zzsh_supply.skin s ON s.id=ls.skin_id LEFT JOIN zzsh_supply.skin_category c ON c.id=s.category_id
    WHERE ls.version_id=$1 AND s.enabled AND s.form_visible ORDER BY c.sort_order,c.id,s.sort_order,s.id`,[r.version_id])).rows;
  const media=(await client.query<{assetId:string;position:number}>(`SELECT m.asset_id AS "assetId",m.position
    FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a ON a.id=m.asset_id
    WHERE m.version_id=$1 AND a.purpose='ACCOUNT_DISPLAY' AND a.review_state IN ('PENDING','APPROVED') AND a.technical_state='READY' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL
    ORDER BY m.position,m.asset_id`,[r.version_id])).rows;
  const attrs=Object.fromEntries(["safe_box_code","vit_level","bear_level","dive_level","character_level","grading_code","login_method_code","region_province","region_city","secret_kd","service_window_start_minute","service_window_end_minute","service_window_timezone","service_window_cross_midnight"].map(k=>[k,r.attributes[k]??null]));
  const display=projectPublicAttributeDisplay(attrs);
  const amount=(v:string)=>({currency:"CNY",unit:"yuan",amount:v,scale:2});
  return {id:r.id,versionId:r.version_id,displayNo:snapshot.resourceNo,title:r.title,description:r.description,
    game:{id:r.game_id,code:r.game_code,name:r.game_name},attributes:attrs,attributeDisplay:display,safeBox:display.safeBox,
    termOption:{code:"legacy_source",displayName:`${snapshot.termDays} 天`,dailyConsumption:{quantity:snapshot.dailyHaffBase,unit:"HAFF_BASE"}},
    source:"LEGACY_READ_ONLY" as const,canCreateOrder:false as const,sourceUpdatedAt:r.source_updated_at.toISOString(),
    quote:null,historicalQuote:{haffRent:amount(snapshot.haffRentYuan),goods:amount(snapshot.goodsYuan),deposit:amount(snapshot.depositYuan),termDays:snapshot.termDays},
    inventory:rows.map(x=>({itemId:x.id,quantity:x.quantity,unit:x.unit})),
    presentation:{items:rows.map(({quantity,...x})=>x),skins:skins.map(x=>({id:x.id,name:x.name,...(x.categoryCode?{categoryCode:x.categoryCode}:{}),...(x.categoryName?{categoryName:x.categoryName}:{})})),entitlements:[]},
    media:media.map(m=>({assetId:m.assetId,position:m.position,url:`/api/v1/supply/listings/${r.id}/media/${m.assetId}`})),publishedAt:null};
}

/** Legacy read mode reuses the public v2 filter contract; only the public presentation differs. */
export function legacyListingSortLabel(sort:string,configuredLabel:string|null):string {
  if(sort==="latest")return "更新时间";
  if(sort==="resourceTotal")return "资源费用";
  return configuredLabel??sort;
}

export function buildLegacyListingCandidates(query:ListingQueryV2,after:ListingPosition|null) {
  const values:unknown[]=[];const p=(v:unknown)=>{values.push(v);return '$'+values.length;};
  const where=[VISIBLE,`a.game_id=${p(query.gameId)}`,...candidatePredicates(query.filters,query.q,p,"v.attributes")];
  const key=query.sort==="latest"?`h.source_updated_at`:query.sort==="resourceTotal"?`((h.snapshot->>'haffRentYuan')::numeric+(h.snapshot->>'goodsYuan')::numeric)`:`(SELECT l.quantity FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${p(query.coreItemId)})`;
  let seek="";
  if(after){const id=p(after.id);if(after.isNull)seek=`WHERE sort_key IS NULL AND id>${id}`;
    else {const k=p(after.key),cast=query.sort==="latest"?"timestamptz":"numeric",op=query.direction==="ASC"?">":"<";seek=`WHERE (sort_key ${op} ${k}::${cast} OR sort_key IS NULL OR (sort_key=${k}::${cast} AND id>${id}))`;}}
  const text=`WITH candidates AS (SELECT a.id,v.id AS version_id,${key} AS sort_key ${FROM} WHERE ${where.join(" AND ")}) SELECT id,version_id,${query.sort==="latest"?`to_char(sort_key AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:"sort_key::text"} AS key FROM candidates ${seek} ORDER BY sort_key ${query.direction} NULLS LAST,id ASC LIMIT 200`;
  return {text,values};
}

export async function listLegacyReadListings(client: PoolClient,q:ListingQueryV2,key:ListingCursorKey,revisions:{filterRevision:string;catalogRevision:string;sortLabel:string}) {
  const binding:ListingCursorBinding={queryVersion:2,gameId:q.gameId,queryHash:sha256Hex(canonicalize({mode:"LEGACY_READ_ONLY",q:q.q,filters:q.filters,sort:q.sort,direction:q.direction,coreItemId:q.coreItemId})),sort:q.sort,direction:q.direction,coreItemId:q.coreItemId,filterRevision:revisions.filterRevision,catalogRevision:revisions.catalogRevision,ruleReleaseId:"legacy-read-only"};
  const after=q.cursor?decodeListingCursor(q.cursor,binding,key):null;
  const sql=buildLegacyListingCandidates(q,after),rows=(await client.query<{id:string;version_id:string;key:string|null}>(sql.text,sql.values)).rows;
  const items:unknown[]=[];let last:ListingPosition|null=null,scanned=0;
  for(const row of rows){if(items.length===q.limit)break;last={id:row.id,key:row.key,isNull:row.key===null};scanned++;try{items.push(await readLegacyListing(client,row.id));}catch(error){if((error as {status?:number}).status!==404)throw error;}}
  const more=scanned<rows.length||rows.length===200;
  return {queryVersion:2,items,nextCursor:more&&last?encodeListingCursor(last,binding,key):null,sort:q.sort,direction:q.direction,sortLabel:revisions.sortLabel,filterRevision:revisions.filterRevision,catalogRevision:revisions.catalogRevision,ruleReleaseId:null,scannedCount:scanned,scanBudget:200,scanBudgetReached:scanned===200,limit:q.limit};
}
