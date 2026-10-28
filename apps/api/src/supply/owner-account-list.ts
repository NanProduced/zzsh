import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { requireListingCursorKey, type ListingCursorKey } from "./listing-cursor";
import { effectivePublicationStateSql, projectPublicAttributeDisplay } from "./listing-query";
import { publicAccountNumber } from "./account-number";
import { conflict, invalid } from "./supply-util";

/** B1: owner-side account list (个人中心「我的账号」). List indicator only — not the full rentability gate. */
export const OWNER_RENTAL_STATES = ["RENTED", "LISTED", "PAUSED", "REVIEWING", "DRAFT", "REJECTED", "RESTRICTED", "UNKNOWN"] as const;
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

/** Same precedence as documented in brief.md (B1). Exported for offline tests and reuse. */
export const RENTAL_STATE_SQL = `CASE
  WHEN ao.status='PAID' THEN 'RENTED'
  WHEN a.staff_restricted THEN 'RESTRICTED'
  WHEN v.id IS NULL THEN 'UNKNOWN'
  WHEN v.review_state='SUBMITTED' THEN 'REVIEWING'
  WHEN v.review_state='REJECTED' THEN 'REJECTED'
  WHEN v.review_state IN ('DRAFT','WITHDRAWN','IMPORTED_UNVERIFIED') THEN 'DRAFT'
  WHEN p.version_id IS NOT NULL AND ${effectivePublicationStateSql("v", "p")} THEN CASE WHEN a.owner_paused THEN 'PAUSED' ELSE 'LISTED' END
  ELSE 'UNKNOWN' END`;
const utc = (c: string) => `CASE WHEN ${c} IS NULL THEN NULL ELSE to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;

export const OWNER_ACCOUNT_LIST_SQL = `SELECT /* owner-account-list */ * FROM (
 SELECT a.id,a.display_no,a.game_id,a.revision::text,a.owner_paused,a.staff_restricted,v.id AS version_id,v.title,v.review_state,v.sequence::text,
   u.name AS owner_name,g.name AS game_name,v.payload,v.presentation->'items' AS presentation_items,
   (v.rule_release_id IS NOT DISTINCT FROM g.current_release_id) AS rule_current,
   ao.id AS ao_id,ao.display_no AS ao_display_no,ao.status AS ao_status,ru.name AS ao_renter_name,ao.term_seconds::text AS ao_term_seconds,
   ${utc("ao.paid_at")} AS ao_started_at,${utc("ao.paid_at + make_interval(secs => ao.term_seconds)")} AS ao_deadline_at,
   ao.quote_snapshot->'ownerTotal' AS ao_owner_amount,
   ${RENTAL_STATE_SQL} AS rental_state
  FROM zzsh_supply.rental_account a
  LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
  LEFT JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=a.id
  JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id
  JOIN zzsh_supply.game g ON g.id=a.game_id
  LEFT JOIN LATERAL (SELECT o.* FROM zzsh_order.rental_order o WHERE o.account_id=a.id AND o.owner_user_id=a.owner_user_id AND o.status IN ('PENDING_PAYMENT','PAID') ORDER BY o.created_at DESC LIMIT 1) ao ON true
  LEFT JOIN zzsh_auth_user."user" ru ON ru.id=ao.renter_user_id
  WHERE a.owner_user_id=$1 AND a.id>$2
) t WHERE ($3::text IS NULL OR t.rental_state=$3) ORDER BY t.id LIMIT $4`;

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
  if (row.ao_status === "PAID") blockers.push("RENTED");
  if (row.ao_status === "PENDING_PAYMENT") blockers.push("PENDING_PAYMENT");
  if (row.staff_restricted) blockers.push("STAFF_RESTRICTED");
  if (row.owner_paused) blockers.push("OWNER_PAUSED");
  if (row.rental_state === "REVIEWING") blockers.push("UNDER_REVIEW");
  if (["DRAFT", "REJECTED"].includes(row.rental_state)) blockers.push("NOT_PUBLISHED");
  if (row.rental_state === "UNKNOWN") blockers.push("STATE_UNKNOWN");
  if (row.version_id && row.rule_current === false) blockers.push("RULE_CHANGED");
  const { payload: _p, presentation_items: _i, rule_current: _r, ...rest } = row;
  for (const k of Object.keys(rest)) if (k.startsWith("ao_")) delete (rest as any)[k];
  const displayNo = publicAccountNumber(row.display_no);
  return {
    ...rest,
    display_no: displayNo,
    rentalState: row.rental_state,
    accountDisplay: { displayNo, gameId: row.game_id, titleFacts, unknownReason },
    activeOrder: row.ao_id ? {
      id: row.ao_id, displayNo: row.ao_display_no, status: row.ao_status, renterName: row.ao_renter_name ?? null,
      termSeconds: row.ao_term_seconds ?? null, startedAt: row.ao_started_at ?? null, rentalDeadlineAt: row.ao_deadline_at ?? null,
      ownerAmount: row.ao_owner_amount && typeof row.ao_owner_amount.amount === "string" ? row.ao_owner_amount : null,
    } : null,
    available: row.rental_state === "LISTED" && blockers.length === 0,
    blockers,
  };
}

export async function listOwnerAccounts(client: PoolClient, userId: string, q: OwnerAccountQuery, key: ListingCursorKey | undefined) {
  const after = q.cursor !== null ? decodeOwnerAccountCursor(q.cursor, userId, q.rentalState, key) : q.after;
  const rows = (await client.query<OwnerAccountRow>(OWNER_ACCOUNT_LIST_SQL, [userId, after, q.rentalState, q.limit + 1])).rows;
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page.at(-1)?.id ?? null;
  let nextPageCursor: string | null = null;
  if (hasMore && last) { try { nextPageCursor = encodeOwnerAccountCursor(last, userId, q.rentalState, key); } catch { nextPageCursor = null; } }
  return { page, hasMore, last, nextPageCursor };
}
