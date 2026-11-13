import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { requireListingCursorKey, type ListingCursorKey } from "./listing-cursor";
import { effectivePublicationStateSql, projectPublicAttributeDisplay } from "./listing-query";
import { publicAccountNumber } from "./account-number";
import { declaredTitleOrNull } from "./publishing";
import { conflict, invalid } from "./supply-util";
import { occupyingLegacyOrdersSql } from "../order/legacy-order-occupancy";
import { legacyContinuationReady, legacyEpochTimestamp } from "../order/legacy-order-read";
import { readLegacyMarketAccountIds } from "./legacy-listing-read";
import type { LegacyPublicAdmission } from "../legacy-load/legacy-public-admission";

/** B1: owner-side account list (个人中心「我的账号」). List indicator only — not the full rentability gate. */
export const OWNER_RENTAL_STATES = ["RENTED", "PENDING_PAYMENT", "LISTED", "DELISTED", "HISTORICAL", "PAUSED", "REVIEWING", "DRAFT", "REJECTED", "RESTRICTED", "COMPLETED", "UNKNOWN"] as const;
export type OwnerRentalState = typeof OWNER_RENTAL_STATES[number];
export type OwnerAccountQuery = { limit: number; after: string; cursor: string | null; rentalState: OwnerRentalState | null };
const CURSOR_AUDIENCE = "zzsh:owner-accounts-v1";

export function parseOwnerAccountQuery(query: URLSearchParams): OwnerAccountQuery {
  const limit = Number(query.get("limit") ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const states = query.getAll("rentalState");
  if (states.length > 1) throw invalid("rentalState is repeated", "rentalState");
  const rentalState = states[0] ?? null;
  if (rentalState !== null && !(OWNER_RENTAL_STATES as readonly string[]).includes(rentalState)) throw invalid("rentalState is invalid", "rentalState");
  const cursor = query.get("cursor");
  if (cursor !== null && query.get("after") !== null) throw invalid("Use cursor or after, not both", "cursor");
  return { limit, after: query.get("after") ?? "", cursor, rentalState: rentalState as OwnerRentalState | null };
}

function binding(userId: string, rentalState: OwnerRentalState | null): string {
  return createHash("sha256").update(JSON.stringify([CURSOR_AUDIENCE, userId, rentalState])).digest("hex");
}
export function encodeOwnerAccountCursor(lastId: string, userId: string, rentalState: OwnerRentalState | null, key: ListingCursorKey | undefined): string {
  requireListingCursorKey(key);
  const body = Buffer.from(JSON.stringify({ schema: 1, audience: CURSOR_AUDIENCE, keyId: key.keyId, binding: binding(userId, rentalState), id: lastId })).toString("base64url");
  return body + "." + createHmac("sha256", key.secret).update(body).digest("base64url");
}
export function decodeOwnerAccountCursor(token: string, userId: string, rentalState: OwnerRentalState | null, key: ListingCursorKey | undefined): string {
  requireListingCursorKey(key);
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid("Invalid cursor", "cursor");
  const [body, sig] = token.split(".") as [string, string];
  const expected = createHmac("sha256", key.secret).update(body).digest();
  const signature = Buffer.from(sig, "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw invalid("Invalid cursor", "cursor");
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { throw invalid("Invalid cursor", "cursor"); }
  if (c.audience !== CURSOR_AUDIENCE || c.schema !== 1 || typeof c.id !== "string" || !c.id) throw invalid("Invalid cursor", "cursor");
  if (c.keyId !== key.keyId || c.binding !== binding(userId, rentalState)) throw conflict("Account cursor is stale; refresh from the first page");
  return c.id;
}

const retiredLegacySql = `g.code='delta' AND EXISTS (SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts')`;
/** The active order remains visible even when its imported account is read-only. */
const rentalStateSql = (continuationReady: boolean) => `CASE
  WHEN ao.status='PAID' OR lo.occupied
    ${continuationReady ? `OR EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register r WHERE r.account_id=a.id AND r.disposition='ISOLATED_PARTY')` : ""} THEN 'RENTED'
  WHEN ao.status='PENDING_PAYMENT' THEN 'PENDING_PAYMENT'
  WHEN a.lifecycle='DELISTED' THEN 'DELISTED'
  WHEN ${retiredLegacySql} THEN 'HISTORICAL'
  WHEN a.lifecycle='ARCHIVED' THEN 'COMPLETED'
  WHEN a.staff_restricted THEN 'RESTRICTED'
  WHEN a.id=ANY($5::text[]) THEN CASE WHEN a.owner_paused THEN 'PAUSED' ELSE 'LISTED' END
  WHEN v.id IS NULL THEN 'UNKNOWN'
  WHEN v.review_state='SUBMITTED' THEN 'REVIEWING'
  WHEN v.review_state='REJECTED' THEN 'REJECTED'
  WHEN v.review_state IN ('DRAFT','WITHDRAWN','IMPORTED_UNVERIFIED') THEN 'DRAFT'
  WHEN p.version_id IS NOT NULL AND ${effectivePublicationStateSql("v", "p")} THEN CASE WHEN a.owner_paused THEN 'PAUSED' ELSE 'LISTED' END
  ELSE 'UNKNOWN' END`;
export const RENTAL_STATE_SQL = rentalStateSql(true);
const utc = (c: string) => `CASE WHEN ${c} IS NULL THEN NULL ELSE to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;

const ownerAccountListSql = (continuationReady: boolean) => `SELECT /* owner-account-list */ * FROM (
 SELECT a.id,a.display_no,a.game_id,a.revision::text,a.owner_paused,a.staff_restricted,v.id AS version_id,v.origin AS version_origin,v.title,v.review_state,v.sequence::text,
   u.name AS owner_name,g.name AS game_name,v.payload,v.presentation->'items' AS presentation_items,(${retiredLegacySql}) AS retired_legacy,
   (v.rule_release_id IS NOT DISTINCT FROM g.current_release_id OR
     COALESCE(${effectivePublicationStateSql("v", "p")} AND p.owner_user_id=a.owner_user_id
       AND p.game_id=a.game_id AND p.rule_release_id=v.rule_release_id AND p.content_hash=v.content_hash,false)) AS rule_current,
   CASE WHEN ao.id IS NOT NULL AND lo.occupied THEN NULL ELSE COALESCE(ao.id,lo.id) END AS ao_id,
   COALESCE(ao.display_no,lo.original_order_no) AS ao_display_no,
   CASE WHEN ao.id IS NULL AND lo.id IS NOT NULL THEN 'LEGACY' ELSE 'NATIVE' END AS ao_origin,
   COALESCE(ao.status,CASE WHEN lo.id IS NOT NULL THEN 'PAID' END) AS ao_status,ru.name AS ao_renter_name,ao.term_seconds::text AS ao_term_seconds,
   CASE WHEN ao.id IS NULL THEN lo.deadline END AS ao_legacy_deadline,
   a.id=ANY($5::text[]) AS legacy_market,
   ${utc("opening.confirmed_at")} AS ao_started_at,${utc("(opening.confirmed_at + make_interval(secs => ao.term_seconds))")} AS ao_deadline_at,
   ao.quote_snapshot->'ownerTotal' AS ao_owner_amount,
   ${rentalStateSql(continuationReady)} AS rental_state
  FROM zzsh_supply.rental_account a
  LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
  LEFT JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=a.id
  JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id
  JOIN zzsh_supply.game g ON g.id=a.game_id
  LEFT JOIN LATERAL (SELECT o.* FROM zzsh_order.rental_order o WHERE o.account_id=a.id AND o.owner_user_id=a.owner_user_id AND o.status IN ('PENDING_PAYMENT','PAID') ORDER BY o.created_at DESC LIMIT 1) ao ON true
  LEFT JOIN zzsh_order.rental_opening opening ON opening.order_id=ao.id AND opening.status='CONFIRMED'
  LEFT JOIN zzsh_auth_user."user" ru ON ru.id=ao.renter_user_id
  LEFT JOIN LATERAL (
    SELECT count(*)>0 AS occupied,
      CASE WHEN count(*)=1 AND bool_and(bound) THEN min(current_order.id) END AS id,
      CASE WHEN count(*)=1 AND bool_and(bound) THEN min(current_order.original_order_no) END AS original_order_no,
      CASE WHEN count(*)=1 AND bool_and(bound) THEN min(current_order.deadline) END AS deadline
    FROM (SELECT l.id,l.original_order_no,l.source_snapshot->>'tenancy_deadline' AS deadline,
      (l.owner_user_id=$1 AND l.owner_user_id=a.owner_user_id AND COALESCE(l.source_snapshot->>'is_delete','0')='0') AS bound
      ${occupyingLegacyOrdersSql("a.id", continuationReady)} LIMIT 2) current_order
  ) lo ON true
  WHERE a.owner_user_id=$1 AND a.id>$2
) t WHERE ($3::text IS NULL OR t.rental_state=$3) ORDER BY t.id LIMIT $4`;
export const OWNER_ACCOUNT_LIST_SQL = ownerAccountListSql(true);

export type OwnerAccountRow = Record<string, any> & { id: string; display_no: unknown; rental_state: OwnerRentalState };

function quantityOf(payload: any, items: unknown, unit: string): string | null | undefined {
  const frozen = Array.isArray(items) ? items.filter((i: any) => i && i.unit === unit && typeof i.id === "string") : [];
  if (frozen.length !== 1) return undefined;
  const line = (payload?.declaration?.inventory ?? []).find((l: any) => l?.itemId === frozen[0].id);
  return line ? (typeof line.quantity === "string" ? line.quantity : null) : undefined;
}
const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** titleFacts from the current version's declaration and its quote. Unquoted ⇒ ownerQuoteTotal=null (never 0). */
export function projectTitleFacts(row: OwnerAccountRow) {
  if (!row.version_id) return { titleFacts: null, unknownReason: "VERSION_MISSING" as const };
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || !payload.declaration) return { titleFacts: null, unknownReason: "DECLARATION_UNREADABLE" as const };
  const attrs = (payload.declaration.attributes ?? {}) as Record<string, unknown>;
  const display = projectPublicAttributeDisplay(attrs);
  const haff = quantityOf(payload, row.presentation_items, "HAFF_BASE");
  const total = payload.quoteValues?.ownerTotal;
  const rentalMode = (attrs.rentalPricing as any)?.rentalMode;
  return {
    titleFacts: {
      haffBase: haff ?? null,
      safeBox: display.safeBox ? { code: display.safeBox.code, displayName: display.safeBox.displayName } : null,
      rank: display.grading ? { code: display.grading.code, displayName: display.grading.displayName } : null,
      level: num(attrs.character_level),
      vitLevel: num(attrs.vit_level ?? attrs.vitLevel),
      bearLevel: num(attrs.bear_level ?? attrs.bearLevel),
      rentalMode: typeof rentalMode === "string" ? rentalMode : null,
      ownerQuoteTotal: total && typeof total === "object" && typeof total.amount === "string" ? { currency: total.currency, unit: total.unit, amount: total.amount, scale: total.scale } : null,
    },
    unknownReason: total ? null : "NOT_QUOTED" as const,
  };
}

export function projectOwnerAccount(row: OwnerAccountRow) {
  const { titleFacts, unknownReason } = projectTitleFacts(row);
  const blockers: string[] = [];
  if (row.rental_state === "RENTED") blockers.push("RENTED");
  if (row.rental_state === "PENDING_PAYMENT" || row.ao_status === "PENDING_PAYMENT") blockers.push("PENDING_PAYMENT");
  if (row.rental_state === "COMPLETED") blockers.push("RENTAL_COMPLETED");
  if (row.rental_state === "DELISTED") blockers.push("ACCOUNT_DELISTED");
  if (row.retired_legacy === true || row.rental_state === "HISTORICAL") blockers.push("LEGACY_LISTING_RELIST_REQUIRED");
  if (row.staff_restricted) blockers.push("STAFF_RESTRICTED");
  if (row.owner_paused) blockers.push("OWNER_PAUSED");
  if (row.rental_state === "REVIEWING") blockers.push("UNDER_REVIEW");
  if (["DRAFT", "REJECTED"].includes(row.rental_state)) blockers.push("NOT_PUBLISHED");
  if (row.rental_state === "UNKNOWN") blockers.push("STATE_UNKNOWN");
  if (row.legacy_market) blockers.push("NOT_TRADE_READY");
  if (row.version_id && row.rule_current === false) blockers.push("RULE_CHANGED");
  const { payload: _p, presentation_items: _i, rule_current: _r, legacy_market: _m, retired_legacy: _legacy, version_origin: _o, title: storedTitle, ...rest } = row;
  for (const k of Object.keys(rest)) if (k.startsWith("ao_")) delete (rest as any)[k];
  const displayNo = publicAccountNumber(row.display_no);
  return {
    ...rest,
    // B1: the stored placeholder is not a name. Absent title stays null so readers fall back to the
    // account number; the reason stays in accountDisplay.unknownReason.
    title: declaredTitleOrNull(storedTitle),
    display_no: displayNo,
    rentalState: row.rental_state,
    historicalReadOnly: row.version_origin === "LEGACY_OBSERVATION" || row.retired_legacy === true || row.rental_state === "HISTORICAL",
    accountDisplay: { displayNo, gameId: row.game_id, titleFacts, unknownReason },
    activeOrder: row.ao_id ? {
      id: row.ao_id, displayNo: row.ao_display_no, status: row.ao_status, origin: row.ao_origin === "LEGACY" ? "LEGACY" : "NATIVE", renterName: row.ao_renter_name ?? null,
      termSeconds: row.ao_term_seconds ?? null, startedAt: row.ao_started_at ?? null, rentalDeadlineAt: row.ao_deadline_at ?? legacyEpochTimestamp(row.ao_legacy_deadline),
      ownerAmount: row.ao_owner_amount && typeof row.ao_owner_amount.amount === "string" ? row.ao_owner_amount : null,
    } : null,
    available: row.rental_state === "LISTED" && blockers.length === 0,
    blockers,
  };
}

export async function listOwnerAccounts(client: PoolClient, userId: string, q: OwnerAccountQuery, key: ListingCursorKey | undefined, admission?: LegacyPublicAdmission) {
  const after = q.cursor !== null ? decodeOwnerAccountCursor(q.cursor, userId, q.rentalState, key) : q.after;
  const continuationReady = await legacyContinuationReady(client);
  const legacyMarketIds = await readLegacyMarketAccountIds(client, admission, userId, true);
  const rows = (await client.query<OwnerAccountRow>(continuationReady ? OWNER_ACCOUNT_LIST_SQL : ownerAccountListSql(false), [userId, after, q.rentalState, q.limit + 1, legacyMarketIds])).rows;
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1)?.id ?? null;
  let nextPageCursor: string | null = null;
  if (hasMore && last) { try { nextPageCursor = encodeOwnerAccountCursor(last, userId, q.rentalState, key); } catch { nextPageCursor = null; } }
  return { page, hasMore, last, nextPageCursor };
}
