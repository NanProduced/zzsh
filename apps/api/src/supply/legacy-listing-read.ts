import type { PoolClient } from "pg";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "./content-hash";
import { listingSearchPattern, projectPublicAttributeDisplay } from "./listing-query";
import { assertGameScope, conflict, fingerprintRequest, invalid, notFound, sha256Hex, withIdempotency } from "./supply-util";
import { legacyDisplayDigest, parseLegacyDisplaySnapshot, type LegacyDisplayInput } from "./legacy-display-snapshot";
import { decodeListingCursor, encodeListingCursor, type ListingCursorBinding, type ListingCursorKey } from "./listing-cursor";
import { candidatePredicates, PUBLIC_CANDIDATE_FROM, PUBLIC_CANDIDATE_WHERE, PUBLIC_STANDARD_TIER_GUARD, type ListingPosition } from "./listing-candidates";
import { evaluatePublicDisplayGuard, legacyAdmissionSql, legacyAdmissionRevision, type LegacyPublicAdmission } from "../legacy-load/legacy-public-admission";
import type { ListingQueryV2 } from "./listing-filter-contract";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";

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

export const LEGACY_READ_SOURCE_STATUSES = [0, 3, 4, 5] as const;

/** Public history stays status 3. Other saved statuses are not a public read. */
export function legacyReadSourceAllowed(status: number, deleted: boolean): boolean {
  return deleted === false && LEGACY_READ_SOURCE_STATUSES.includes(status as (typeof LEGACY_READ_SOURCE_STATUSES)[number]);
}

export function legacySnapshotReplaySql(): string {
  return "SELECT observation_version_id,source_system,source_entity,legacy_id,source_digest,source_status,source_updated_at,snapshot,evidence_ref FROM zzsh_supply.legacy_listing_read_snapshot WHERE account_id=$1";
}

/** Authorized admin or owner read. This is not the public VISIBLE predicate. */
export function legacyHistoricalReadSql(many = false): string {
  return `SELECT h.account_id, h.observation_version_id, h.source_digest, h.source_updated_at AS base_updated_at,
      h.source_status::int AS source_status, h.legacy_id, h.snapshot, a.owner_user_id,
      d.account_id AS display_account_id, d.observation_version_id AS display_version_id,
      d.base_source_digest, d.extract_sha256, d.source_updated_at AS display_updated_at,
      d.evidence_ref AS display_evidence_ref, d.snapshot AS display_snapshot, d.display_digest
    FROM zzsh_supply.legacy_listing_read_snapshot h
    JOIN zzsh_supply.rental_account a ON a.id=h.account_id
    LEFT JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=h.account_id AND d.schema_version=1
    WHERE ${many ? "h.account_id = ANY($1::text[])" : "h.account_id=$1"}`;
}

type HistoricalReadRow = {
  source_status: number | string; legacy_id: string; owner_user_id: string; snapshot: unknown;
  account_id?: string; observation_version_id?: string; source_digest?: string; base_updated_at?: Date;
  display_account_id?: string | null; display_version_id?: string | null;
  base_source_digest?: string | null; extract_sha256?: string | null; display_updated_at?: Date | null;
  display_evidence_ref?: string | null; display_snapshot?: unknown; display_digest?: string | null;
};

function projectHistoricalDisplay(row: HistoricalReadRow, accountId?: string) {
  if (row.display_account_id == null) {
    if ([row.display_version_id, row.base_source_digest, row.extract_sha256, row.display_updated_at, row.display_evidence_ref, row.display_snapshot, row.display_digest].some(value => value != null)) throw invalid("Historical display binding is incomplete");
    return { state: "NOT_IMPORTED" as const, facts: null };
  }
  if (!accountId || row.account_id !== accountId || row.display_account_id !== accountId
    || !row.observation_version_id || row.display_version_id !== row.observation_version_id
    || row.base_source_digest !== row.source_digest || !/^[a-f0-9]{64}$/.test(row.source_digest ?? "")
    || !/^[a-f0-9]{64}$/.test(row.extract_sha256 ?? "") || !(row.display_updated_at instanceof Date)
    || !Number.isFinite(row.display_updated_at.getTime())
    || !(row.base_updated_at instanceof Date) || row.base_updated_at.getTime() !== row.display_updated_at.getTime()
    || row.display_evidence_ref !== 'legacy-display-v1:' + row.extract_sha256 + ':' + row.legacy_id) throw invalid("Historical display source binding is invalid");
  const snapshot = parseLegacyDisplaySnapshot(row.display_snapshot);
  const sourceUpdatedAt = row.display_updated_at.toISOString();
  if (row.display_digest !== legacyDisplayDigest(accountId, {
    observationVersionId: row.display_version_id, baseSourceDigest: row.base_source_digest!,
    extractSha256: row.extract_sha256!, sourceUpdatedAt, evidenceRef: row.display_evidence_ref, snapshot,
  })) throw invalid("Historical display digest is invalid");
  return { state: "KNOWN" as const, facts: {
    schema: snapshot.schema, rentalMode: snapshot.rentalMode, attributes: snapshot.attributes,
    resources: snapshot.resources.map(({ code, name, quantity, unit }) => ({ code, name, quantity, unit })),
    attributeDisplay: projectPublicAttributeDisplay(snapshot.attributes), sourceUpdatedAt,
  } };
}

export function projectLegacyHistoricalRead(row: HistoricalReadRow, accountId = row.account_id) {
  let snapshot: LegacyReadSnapshot;
  let display: ReturnType<typeof projectHistoricalDisplay>;
  try {
    if (row.account_id !== undefined && row.account_id !== accountId) throw invalid("Historical account binding is invalid");
    snapshot = parseLegacyReadSnapshot(row.snapshot);
    display = projectHistoricalDisplay(row, accountId);
  } catch {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Historical account display is unavailable");
  }
  const sourceStatus = Number(row.source_status);
  return {
    legacyId: row.legacy_id, sourceStatus, ownerUserId: row.owner_user_id, resourceNo: snapshot.resourceNo,
    historicalQuote: { haffRentYuan: snapshot.haffRentYuan, goodsYuan: snapshot.goodsYuan, depositYuan: snapshot.depositYuan, termDays: snapshot.termDays, dailyHaffBase: snapshot.dailyHaffBase },
    quote: null, canCreateOrder: false as const, trade: "UNKNOWN" as const, display,
    sourceStatusPublicCandidate: sourceStatus === 3,
  };
}

export type LegacyHistoricalRead = ReturnType<typeof projectLegacyHistoricalRead>;

export async function loadLegacyHistoricalRead(client: PoolClient, accountId: string) {
  const row = (await client.query(legacyHistoricalReadSql(), [accountId])).rows[0];
  return row ? projectLegacyHistoricalRead(row, accountId) : null;
}

/** Callers already authorized this page's account IDs; this reader grants no access. */
export async function loadLegacyHistoricalReads(client: PoolClient, accountIds: string[]) {
  const result = new Map<string, LegacyHistoricalRead>();
  if (!accountIds.length) return result;
  const rows = (await client.query<HistoricalReadRow>(legacyHistoricalReadSql(true), [[...new Set(accountIds)]])).rows;
  for (const row of rows) {
    if (!row.account_id || !accountIds.includes(row.account_id)) throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Historical account binding is unavailable");
    result.set(row.account_id, projectLegacyHistoricalRead(row, row.account_id));
  }
  return result;
}

export function legacySnapshotConflicts(old: {
  observation_version_id: string; source_system: string; source_entity: string; legacy_id: string; source_digest: string;
  source_status: number | string; source_updated_at: Date; evidence_ref: string; snapshot: unknown;
}, next: { observationVersionId: string; sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; sourceStatus: number; sourceUpdatedAt: string; evidenceRef: string }, snapshot: unknown): boolean {
  return old.observation_version_id !== next.observationVersionId || old.source_system !== next.sourceSystem || old.source_entity !== next.sourceEntity
    || old.legacy_id !== next.legacyId || old.source_digest !== next.sourceDigest || Number(old.source_status) !== next.sourceStatus
    || old.source_updated_at.toISOString() !== next.sourceUpdatedAt || old.evidence_ref !== next.evidenceRef || canonicalize(old.snapshot) !== canonicalize(snapshot);
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
  if (!legacyReadSourceAllowed(input.sourceStatus, input.sourceDeleted)) throw invalid("Historical listing source status is not allowed");
  if (input.sourceSystem !== "legacy_mysql_restore" || input.sourceEntity !== "la_rental_accounts"
    || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.sourceUpdatedAt)
    || Number.isNaN(Date.parse(input.sourceUpdatedAt)) || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("Historical listing requires source publication evidence");
  const values = [accountId,input.observationVersionId,input.sourceSystem,input.sourceEntity,input.legacyId,input.sourceDigest,input.sourceStatus,input.sourceUpdatedAt,input.evidenceRef,snapshot,actor.id];
  const old = (await client.query(legacySnapshotReplaySql(),[accountId])).rows[0];
  if (old) {
    if (legacySnapshotConflicts(old, input, snapshot)) throw conflict("Historical snapshot conflicts with the recorded source");
    return;
  }
  await client.query(`INSERT INTO zzsh_supply.legacy_listing_read_snapshot(account_id,observation_version_id,source_system,source_entity,legacy_id,source_digest,source_status,source_updated_at,evidence_ref,snapshot,created_by_admin_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, values);
  await recordAudit(client,{actorType:"admin",actorId:actor.id,sessionId:actor.sessionId,requestId:actor.requestId,action:"supply.legacy.read_snapshot_recorded",objectType:"rental_account",objectId:accountId,outcome:"SUCCESS",reason:"旧站账号资料与原始金额只读保存；不创建新平台发布或交易事实",details:{sourceSystem:input.sourceSystem,sourceEntity:input.sourceEntity,legacyId:input.legacyId,sourceDigest:input.sourceDigest,sourceStatus:input.sourceStatus,readOnly:true,after:{readSnapshot:"RECORDED",observationVersionId:input.observationVersionId},result:"READ_SNAPSHOT_RECORDED"}});
}

/** Additive maintenance writer; caller owns the transaction. No public route. */
export async function recordLegacyDisplaySnapshot(client: PoolClient, accountId: string, input: LegacyDisplayInput, actor: {id:string;sessionId:string;requestId:string}) {
  if (!input || Object.keys(input).sort().join(",")!=="baseSourceDigest,evidenceRef,extractSha256,observationVersionId,snapshot,sourceUpdatedAt"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(accountId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.observationVersionId)
    || !/^[a-f0-9]{64}$/.test(input.baseSourceDigest) || !/^[a-f0-9]{64}$/.test(input.extractSha256)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.sourceUpdatedAt) || !Number.isFinite(Date.parse(input.sourceUpdatedAt))
    || typeof input.evidenceRef!=="string" || !input.evidenceRef.startsWith(`legacy-display-v1:${input.extractSha256}:`)) throw invalid("Invalid legacy display binding");
  const normalized={...input,snapshot:parseLegacyDisplaySnapshot(input.snapshot)}, digest=legacyDisplayDigest(accountId,normalized);
  const operation="supply.legacy.display_snapshot_recorded", key=`legacy-display-v1:${accountId}`;
  const result=await withIdempotency(client,{realm:"admin",principalId:actor.id,operation,resourceId:accountId},key,fingerprintRequest(operation,accountId,normalized),async()=>{
    const access=await loadEffectiveAdminAccess(client,actor.id); requirePermission(access,"supply.catalog.manage");
    const account=(await client.query("SELECT game_id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE",[accountId])).rows[0];
    if(!account) throw notFound(); await assertGameScope(client,actor.id,access!.isBoss,account.game_id);
    const old=(await client.query(legacySnapshotReplaySql(),[accountId])).rows[0];
    if(!old || old.observation_version_id!==input.observationVersionId || old.source_digest!==input.baseSourceDigest || old.source_updated_at.toISOString()!==input.sourceUpdatedAt
      || input.evidenceRef!==`legacy-display-v1:${input.extractSha256}:${old.legacy_id}`) throw conflict("Display source binding changed");
    // Reuse the original writer's permission, scope and immutable-source replay checks.
    await recordLegacyReadSnapshot(client,accountId,{observationVersionId:old.observation_version_id,sourceSystem:old.source_system,sourceEntity:old.source_entity,legacyId:old.legacy_id,sourceDigest:old.source_digest,sourceStatus:Number(old.source_status),sourceDeleted:false,sourceUpdatedAt:old.source_updated_at.toISOString(),evidenceRef:old.evidence_ref,snapshot:old.snapshot},actor);
    return false;
  },async()=>{
    const prior=(await client.query("SELECT display_digest FROM zzsh_supply.legacy_listing_display_snapshot WHERE account_id=$1 AND schema_version=1",[accountId])).rows[0];
    if(prior && prior.display_digest!==digest) throw conflict("Display snapshot is immutable; review a new schema version");
    if(!prior){
      await client.query(`INSERT INTO zzsh_supply.legacy_listing_display_snapshot(account_id,schema_version,observation_version_id,base_source_digest,extract_sha256,source_updated_at,evidence_ref,snapshot,display_digest,created_by_admin_id)
        VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`,[accountId,input.observationVersionId,input.baseSourceDigest,input.extractSha256,input.sourceUpdatedAt,input.evidenceRef,normalized.snapshot,digest,actor.id]);
      await recordAudit(client,{actorType:"admin",actorId:actor.id,sessionId:actor.sessionId,requestId:actor.requestId,action:operation,objectType:"rental_account",objectId:accountId,outcome:"SUCCESS",reason:"补充不可变历史展示事实；不改变原快照、资金、库存或交易资格",details:{extractSha256:input.extractSha256,baseSourceDigest:input.baseSourceDigest,displayDigest:digest,before:{displaySnapshot:null},after:{displaySnapshot:"RECORDED",schemaVersion:1},result:"DISPLAY_SNAPSHOT_RECORDED"}});
    }
    return {status:200,body:{accountId,displayDigest:digest,schemaVersion:1}};
  });
  return {...result.body as {accountId:string;displayDigest:string;schemaVersion:number},replayed:result.replayed};
}

// `v` is the version the public read actually shows: the owner's current native
// draft when it exists (the editable representation that carries supplemented
// fields such as the service window, skins and test media), otherwise the
// immutable source observation. Source identity and amounts always stay on `h`.
const FROM = `FROM zzsh_supply.legacy_listing_read_snapshot h
 JOIN zzsh_supply.rental_account a ON a.id=h.account_id
 LEFT JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=h.account_id AND d.schema_version=1
 JOIN zzsh_supply.listing_version ov ON ov.id=h.observation_version_id
 LEFT JOIN zzsh_supply.listing_version dv ON dv.id=a.current_version_id AND dv.origin='NATIVE' AND dv.review_state='DRAFT'
 JOIN zzsh_supply.listing_version v ON v.id=COALESCE(dv.id,ov.id)
 JOIN zzsh_supply.game g ON g.id=a.game_id
 JOIN zzsh_supply.game_service_operation gs ON gs.game_id=g.id AND gs.service_code='ACCOUNT_RENTAL'
 JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id
 LEFT JOIN zzsh_iam.user_identity_state us ON us.user_id=u.id`;
// Native takeover owns the account once any publication fact exists. The guard
// is absence of that fact, not a requirement that a publication exists.
// Status 3 is explicit: lifting legacy_hold must not show a non-public source.
export const LEGACY_NATIVE_TAKEOVER_GUARD = `NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id)`;
// Display-only hold compatibility (legacy-load/legacy-public-admission): the
// frozen facts of an 'UNRESOLVED' account may be shown read-only, while
// publish/edit/order keep their own 'NONE' requirement in publishing.ts.
// 'ACTIVE_LEGACY' stays hidden as pending review.
export const LEGACY_DISPLAY_HOLD_SQL = `a.legacy_hold IN ('NONE','UNRESOLVED')`;
// Core identity evidence pending outside ADULT is not publicly displayed.
export const LEGACY_DISPLAY_IDENTITY_SQL = `COALESCE(us.age_status,'UNKNOWN')='ADULT'`;
// Display is bound to the adjudicated frozen source batch; evidence outside it
// fails closed (legacy-load/legacy-public-admission).
const VISIBLE = `g.enabled AND gs.enabled AND a.lifecycle='ACTIVE' AND ${LEGACY_DISPLAY_HOLD_SQL} AND h.source_status=3 AND NOT a.owner_paused AND NOT a.staff_restricted
 AND NOT u.suspended AND COALESCE(us.account_status,'ACTIVE')='ACTIVE'
 AND ${LEGACY_DISPLAY_IDENTITY_SQL}
 AND (d.account_id IS NULL OR (d.snapshot#>>'{risk,highRiskOwner}'='false' AND d.observation_version_id=h.observation_version_id AND d.base_source_digest=h.source_digest))
 AND ${LEGACY_NATIVE_TAKEOVER_GUARD}`;

// Mode selection must not depend on the currently visible row count: an
// enabled game with a valid configuration keeps its filters and returns an
// empty list when every snapshot is hidden. Hidden rows are never projected.
export async function hasLegacyReadSnapshots(client: PoolClient, gameId: string): Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h JOIN zzsh_supply.rental_account a ON a.id=h.account_id WHERE a.game_id=$1 LIMIT 1`,[gameId])).rowCount);
}

export async function readLegacyListing(client: PoolClient, accountId: string, admission?: LegacyPublicAdmission) {
  const values: unknown[]=[accountId];
  const admitted=legacyAdmissionSql(admission,value=>{values.push(value);return "$"+values.length;});
  const r=(await client.query(`SELECT a.id,g.id game_id,g.code game_code,g.name game_name,v.id version_id,v.title,v.description,v.attributes,h.snapshot,h.source_updated_at,h.evidence_ref,
    d.snapshot AS display_snapshot,d.display_digest,d.observation_version_id AS display_version_id,d.base_source_digest,d.extract_sha256,d.source_updated_at AS display_updated_at,d.evidence_ref AS display_evidence_ref
    ${FROM} WHERE a.id=$1 AND ${VISIBLE} AND ${admitted}`,values)).rows[0];
  if(!r)throw notFound();
  // Shared runtime admission for list and detail: privacy-bearing text and
  // evidence outside the adjudicated batch fail closed without leaking facts.
  if(!evaluatePublicDisplayGuard({title:r.title,description:r.description,evidenceRef:r.evidence_ref}).ok)throw notFound();
  const snapshot=parseLegacyReadSnapshot(r.snapshot);
  const extra=r.display_snapshot ? parseLegacyDisplaySnapshot(r.display_snapshot) : null;
  if(extra && r.display_digest!==legacyDisplayDigest(r.id,{observationVersionId:r.display_version_id,baseSourceDigest:r.base_source_digest,extractSha256:r.extract_sha256,sourceUpdatedAt:r.display_updated_at.toISOString(),evidenceRef:r.display_evidence_ref,snapshot:extra})) throw notFound();
  const rows=(await client.query(`SELECT i.id,i.code,i.name,i.unit,l.quantity::text quantity FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id WHERE l.version_id=$1 ORDER BY i.sort_order,i.id`,[r.version_id])).rows;
  const skins=(await client.query<{id:string;name:string;categoryCode:string|null;categoryName:string|null}>(`SELECT s.id,s.name,c.code AS "categoryCode",c.name AS "categoryName"
    FROM zzsh_supply.listing_skin ls JOIN zzsh_supply.skin s ON s.id=ls.skin_id LEFT JOIN zzsh_supply.skin_category c ON c.id=s.category_id
    WHERE ls.version_id=$1 AND s.enabled AND s.form_visible ORDER BY c.sort_order,c.id,s.sort_order,s.id`,[r.version_id])).rows;
  const media=(await client.query<{assetId:string;position:number}>(`SELECT m.asset_id AS "assetId",m.position
    FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a ON a.id=m.asset_id
    WHERE m.version_id=$1 AND a.purpose='ACCOUNT_DISPLAY' AND a.review_state IN ('PENDING','APPROVED') AND a.technical_state='READY' AND a.access_class='PUBLIC_DISPLAY' AND a.public_storage_key IS NOT NULL
    ORDER BY m.position,m.asset_id`,[r.version_id])).rows;
  const attrs=Object.fromEntries(["safe_box_code","vit_level","bear_level","dive_level","character_level","grading_code","login_method_code","region_province","region_city","secret_kd","service_window_start_minute","service_window_end_minute","service_window_timezone","service_window_cross_midnight"].map(k=>[k,extra ? extra.attributes[k]??null : r.attributes[k]??null]));
  const resources=extra ? extra.resources.map(x=>({id:`legacy-display:${x.code}`,code:x.code,name:x.name,quantity:x.quantity,unit:x.unit})) : rows;
  const display=projectPublicAttributeDisplay(attrs);
  const amount=(v:string)=>({currency:"CNY",unit:"yuan",amount:v,scale:2});
  return {id:r.id,versionId:r.version_id,displayNo:snapshot.resourceNo,title:r.title,description:r.description,
    game:{id:r.game_id,code:r.game_code,name:r.game_name},attributes:attrs,attributeDisplay:display,safeBox:display.safeBox,
    termOption:{code:"legacy_source",displayName:`${snapshot.termDays} 天`,dailyConsumption:{quantity:snapshot.dailyHaffBase,unit:"HAFF_BASE"}},
    source:"LEGACY_READ_ONLY" as const,canCreateOrder:false as const,sourceUpdatedAt:r.source_updated_at.toISOString(),
    ...(extra ? {rentalMode:extra.rentalMode,displaySchema:extra.schema} : {}),
    quote:null,historicalQuote:{haffRent:amount(snapshot.haffRentYuan),goods:amount(snapshot.goodsYuan),deposit:amount(snapshot.depositYuan),termDays:snapshot.termDays},
    inventory:resources.map(x=>({itemId:x.id,quantity:x.quantity,unit:x.unit})),
    presentation:{items:resources.map(({quantity,...x})=>x),skins:skins.map(x=>({id:x.id,name:x.name,...(x.categoryCode?{categoryCode:x.categoryCode}:{}),...(x.categoryName?{categoryName:x.categoryName}:{})})),entitlements:[]},
    media:media.map(m=>({assetId:m.assetId,position:m.position,url:`/api/v1/supply/listings/${r.id}/media/${m.assetId}`})),publishedAt:null};
}

/** Legacy read mode reuses the public v2 filter contract; only the public presentation differs. */
export function legacyListingSortLabel(sort:string,configuredLabel:string|null):string {
  if(sort==="latest")return "更新时间";
  if(sort==="resourceTotal")return "资源费用";
  return configuredLabel??sort;
}

// Legacy rows carry the historical resource number only in the frozen snapshot,
// so the shared title search is widened with that displayed number. Unknown
// values are never grouped into a default class by this predicate.
function legacySearchPredicate(q: string | null, p: (value: unknown) => string): string[] {
  if (q === null) return [];
  const pattern = p(listingSearchPattern(q));
  return [`(v.title ILIKE ${pattern} ESCAPE '\\' OR h.snapshot->>'resourceNo' ILIKE ${pattern} ESCAPE '\\')`];
}

export function buildLegacyListingCandidates(query:ListingQueryV2,after:ListingPosition|null,admission?:LegacyPublicAdmission) {
  const values:unknown[]=[];const p=(v:unknown)=>{values.push(v);return '$'+values.length;};
  const where=[VISIBLE,legacyAdmissionSql(admission,p),`a.game_id=${p(query.gameId)}`,...legacySearchPredicate(query.q,p),...candidatePredicates(query.filters,null,p,"COALESCE(d.snapshot->'attributes',v.attributes)")];
  const key=query.sort==="latest"?`h.source_updated_at`:query.sort==="resourceTotal"?`((h.snapshot->>'haffRentYuan')::numeric+(h.snapshot->>'goodsYuan')::numeric)`:`(SELECT l.quantity FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${p(query.coreItemId)})`;
  let seek="";
  if(after){const id=p(after.id);if(after.isNull)seek=`WHERE sort_key IS NULL AND id>${id}`;
    else {const k=p(after.key),cast=query.sort==="latest"?"timestamptz":"numeric",op=query.direction==="ASC"?">":"<";seek=`WHERE (sort_key ${op} ${k}::${cast} OR sort_key IS NULL OR (sort_key=${k}::${cast} AND id>${id}))`;}}
  const text=`WITH candidates AS (SELECT a.id,v.id AS version_id,${key} AS sort_key ${FROM} WHERE ${where.join(" AND ")}) SELECT id,version_id,${query.sort==="latest"?`to_char(sort_key AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:"sort_key::text"} AS key FROM candidates ${seek} ORDER BY sort_key ${query.direction} NULLS LAST,id ASC LIMIT 200`;
  return {text,values};
}

// Mixed mode keeps native and legacy rows in one candidate set: the union is
// deduplicated by accountId with the native publication taking priority, then
// one seek/order/limit runs over the merged set. Legacy sort keys come from the
// frozen snapshot facts; native keys from the frozen publication payload.
export function buildMixedListingCandidates(query:ListingQueryV2,after:ListingPosition|null,admission?:LegacyPublicAdmission) {
  const values:unknown[]=[];const p=(v:unknown)=>{values.push(v);return '$'+values.length;};
  const game=p(query.gameId),core=query.coreItemId===null?null:p(query.coreItemId);
  const nativeWhere=[PUBLIC_CANDIDATE_WHERE,`a.game_id=${game}`,PUBLIC_STANDARD_TIER_GUARD,...candidatePredicates(query.filters,query.q,p)];
  const legacyWhere=[VISIBLE,legacyAdmissionSql(admission,p),`a.game_id=${game}`,...legacySearchPredicate(query.q,p),...candidatePredicates(query.filters,null,p,"COALESCE(d.snapshot->'attributes',v.attributes)")];
  const publication=`pub.published_at`;
  const amount=`v.payload#>>'{quoteValues,resourceTotal,amount}'`;
  const price=`CASE WHEN v.payload#>>'{quoteValues,currency}'='CNY' AND v.payload#>>'{quoteValues,resourceTotal,unit}'='yuan' AND v.payload#>>'{quoteValues,resourceTotal,scale}'='2' AND ${amount} ~ '^(0|[1-9][0-9]{0,63})[.][0-9]{2}$' THEN (${amount})::numeric END`;
  const nativeKey=query.sort==="latest"?publication:query.sort==="resourceTotal"?price:`(SELECT l.quantity FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${core})`;
  const legacyKey=query.sort==="latest"?`h.source_updated_at`:query.sort==="resourceTotal"?`((h.snapshot->>'haffRentYuan')::numeric+(h.snapshot->>'goodsYuan')::numeric)`:`(SELECT l.quantity FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=${core})`;
  let seek="";
  if(after){const id=p(after.id);if(after.isNull)seek=`WHERE sort_key IS NULL AND id>${id}`;
    else {const k=p(after.key),cast=query.sort==="latest"?"timestamptz":"numeric",op=query.direction==="ASC"?">":"<";seek=`WHERE (sort_key ${op} ${k}::${cast} OR sort_key IS NULL OR (sort_key=${k}::${cast} AND id>${id}))`;}}
  const text=`WITH native AS (SELECT a.id AS id,v.id AS version_id,'native' AS source,0 AS priority,${nativeKey} AS sort_key ${PUBLIC_CANDIDATE_FROM} WHERE ${nativeWhere.join(" AND ")}),
   legacy AS (SELECT a.id AS id,v.id AS version_id,'legacy' AS source,1 AS priority,${legacyKey} AS sort_key ${FROM} WHERE ${legacyWhere.join(" AND ")}),
   merged AS (SELECT DISTINCT ON (id) id,version_id,source,priority,sort_key FROM (SELECT * FROM native UNION ALL SELECT * FROM legacy) combined ORDER BY id,priority),
   candidates AS (SELECT id,version_id,source,sort_key FROM merged ${seek})
   SELECT id,version_id,source,${query.sort==="latest"?`to_char(sort_key AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`:"sort_key::text"} AS key FROM candidates ORDER BY sort_key ${query.direction} NULLS LAST,id ASC LIMIT 200`;
  return {text,values};
}

export function mixedListingBinding(query:ListingQueryV2,revisions:{filterRevision:string;catalogRevision:string;ruleReleaseId:string},admission?:LegacyPublicAdmission):ListingCursorBinding {
  return {queryVersion:2,gameId:query.gameId,queryHash:sha256Hex(canonicalize({mode:"MIXED",...(admission?{admission:legacyAdmissionRevision(admission)}:{}),gameId:query.gameId,q:query.q,filters:query.filters,sort:query.sort,direction:query.direction,coreItemId:query.coreItemId})),sort:query.sort,direction:query.direction,coreItemId:query.coreItemId,filterRevision:revisions.filterRevision,catalogRevision:revisions.catalogRevision,ruleReleaseId:revisions.ruleReleaseId};
}

export async function listLegacyReadListings(client: PoolClient,q:ListingQueryV2,key:ListingCursorKey,revisions:{filterRevision:string;catalogRevision:string;sortLabel:string},admission?:LegacyPublicAdmission) {
  const binding:ListingCursorBinding={queryVersion:2,gameId:q.gameId,queryHash:sha256Hex(canonicalize({mode:"LEGACY_READ_ONLY",...(admission?{admission:legacyAdmissionRevision(admission)}:{}),q:q.q,filters:q.filters,sort:q.sort,direction:q.direction,coreItemId:q.coreItemId})),sort:q.sort,direction:q.direction,coreItemId:q.coreItemId,filterRevision:revisions.filterRevision,catalogRevision:revisions.catalogRevision,ruleReleaseId:"legacy-read-only"};
  const after=q.cursor?decodeListingCursor(q.cursor,binding,key):null;
  const sql=buildLegacyListingCandidates(q,after,admission),rows=(await client.query<{id:string;version_id:string;key:string|null}>(sql.text,sql.values)).rows;
  const items:unknown[]=[];let last:ListingPosition|null=null,scanned=0;
  for(const row of rows){if(items.length===q.limit)break;last={id:row.id,key:row.key,isNull:row.key===null};scanned++;try{items.push(await readLegacyListing(client,row.id,admission));}catch(error){if((error as {status?:number}).status!==404)throw error;}}
  const more=scanned<rows.length||rows.length===200;
  return {queryVersion:2,items,nextCursor:more&&last?encodeListingCursor(last,binding,key):null,sort:q.sort,direction:q.direction,sortLabel:revisions.sortLabel,filterRevision:revisions.filterRevision,catalogRevision:revisions.catalogRevision,ruleReleaseId:null,scannedCount:scanned,scanBudget:200,scanBudgetReached:scanned===200,limit:q.limit};
}
