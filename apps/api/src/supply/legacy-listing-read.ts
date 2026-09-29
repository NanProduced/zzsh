import type { PoolClient } from "pg";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "./content-hash";
import { escapeLike } from "./catalog";
import { projectPublicAttributeDisplay } from "./listing-query";
import { assertGameScope, conflict, invalid, notFound, sha256Hex } from "./supply-util";
import { decodeListingCursor, encodeListingCursor, type ListingCursorBinding, type ListingCursorKey } from "./listing-cursor";
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

const FROM = `FROM zzsh_supply.legacy_listing_read_snapshot h
 JOIN zzsh_supply.rental_account a ON a.id=h.account_id
 JOIN zzsh_supply.listing_version v ON v.id=h.observation_version_id
 JOIN zzsh_supply.game g ON g.id=a.game_id
 JOIN zzsh_supply.game_service_operation gs ON gs.game_id=g.id AND gs.service_code='ACCOUNT_RENTAL'
 JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id
 LEFT JOIN zzsh_iam.user_identity_state us ON us.user_id=u.id`;
const VISIBLE = `g.enabled AND gs.enabled AND a.lifecycle='ACTIVE' AND a.legacy_hold='NONE' AND NOT a.owner_paused AND NOT a.staff_restricted
 AND NOT u.suspended AND COALESCE(us.account_status,'ACTIVE')='ACTIVE'
 AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id)`;

export async function hasLegacyReadListings(client: PoolClient, gameId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 ${FROM} WHERE a.game_id=$1 AND ${VISIBLE} LIMIT 1`,[gameId])).rowCount);
}

export async function readLegacyListing(client: PoolClient, accountId: string) {
  const r=(await client.query(`SELECT a.id,g.id game_id,g.code game_code,g.name game_name,v.id version_id,v.title,v.description,v.attributes,h.snapshot,h.source_updated_at
    ${FROM} WHERE a.id=$1 AND ${VISIBLE}`,[accountId])).rows[0];
  if(!r)throw notFound();
  const snapshot=parseLegacyReadSnapshot(r.snapshot);
  const rows=(await client.query(`SELECT i.id,i.code,i.name,i.unit,l.quantity::text quantity FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id WHERE l.version_id=$1 ORDER BY i.sort_order,i.id`,[r.version_id])).rows;
  const attrs=Object.fromEntries(["safe_box_code","vit_level","bear_level","dive_level","character_level","grading_code","login_method_code","region_province","region_city","secret_kd","service_window_start_minute","service_window_end_minute","service_window_timezone","service_window_cross_midnight"].map(k=>[k,r.attributes[k]??null]));
  const display=projectPublicAttributeDisplay(attrs);
  const amount=(v:string)=>({currency:"CNY",unit:"yuan",amount:v,scale:2});
  return {id:r.id,versionId:r.version_id,displayNo:snapshot.resourceNo,title:r.title,description:r.description,
    game:{id:r.game_id,code:r.game_code,name:r.game_name},attributes:attrs,attributeDisplay:display,safeBox:display.safeBox,
    termOption:{code:"legacy_source",displayName:`旧站租期 ${snapshot.termDays} 天`,dailyConsumption:{quantity:snapshot.dailyHaffBase,unit:"HAFF_BASE"}},
    source:"LEGACY_READ_ONLY" as const,canCreateOrder:false as const,sourceUpdatedAt:r.source_updated_at.toISOString(),
    quote:null,historicalQuote:{haffRent:amount(snapshot.haffRentYuan),goods:amount(snapshot.goodsYuan),deposit:amount(snapshot.depositYuan),termDays:snapshot.termDays},
    inventory:rows.map(x=>({itemId:x.id,quantity:x.quantity,unit:x.unit})),
    presentation:{items:rows.map(({quantity,...x})=>x),skins:[],entitlements:[]},media:[],publishedAt:null};
}

/** Only the explicit migration fallback uses this mode; current quotes keep their existing query and guards. */
export async function listLegacyReadListings(client: PoolClient,q:ListingQueryV2,key:ListingCursorKey, catalogRevision:string) {
  if(q.sort!=="latest" || q.coreItemId!==null || Object.keys(q.filters).length) throw invalid("Historical read mode supports name search and source update ordering only");
  const binding:ListingCursorBinding={queryVersion:2,gameId:q.gameId,queryHash:sha256Hex(canonicalize({mode:"LEGACY_READ_ONLY",q:q.q})),sort:"latest",direction:q.direction,coreItemId:null,filterRevision:"1",catalogRevision,ruleReleaseId:"legacy-read-only"};
  const after=q.cursor?decodeListingCursor(q.cursor,binding,key):null;
  const cmp=q.direction==="ASC"?">":"<",order=q.direction==="ASC"?"ASC":"DESC";
  const rows=(await client.query<{id:string;key:string}>(`SELECT a.id,to_char(h.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') key ${FROM}
    WHERE a.game_id=$1 AND ${VISIBLE} AND ($2::text IS NULL OR v.title ILIKE $2 ESCAPE '\\')
      AND ($3::text IS NULL OR (h.source_updated_at,a.id) ${cmp} ($4::timestamptz,$3))
    ORDER BY h.source_updated_at ${order},a.id ${order} LIMIT $5`,[q.gameId,q.q?`%${escapeLike(q.q)}%`:null,after?.id??null,after?.key??null,q.limit+1])).rows;
  const visible=rows.slice(0,q.limit),last=visible.at(-1),items=[];
  for(const r of visible)items.push(await readLegacyListing(client,r.id));
  return {queryVersion:2,items,nextCursor:rows.length>q.limit&&last?encodeListingCursor({id:last.id,key:last.key,isNull:false},binding,key):null,sort:"latest",direction:q.direction,sortLabel:"来源更新时间",filterRevision:"1",catalogRevision,ruleReleaseId:null,scannedCount:visible.length,scanBudget:200,scanBudgetReached:false,limit:q.limit};
}
