import { createHmac, timingSafeEqual } from "node:crypto";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import type { PoolClient } from "pg";
import type { EffectiveAdminAccess } from "../auth/admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, gameScopeSql, readAdminGameScope } from "../auth/admin-scope";
import { queryAdminReadOrders } from "../order/admin-order-read";
import { readDirectoryUserSummaries } from "../auth/user-directory-summary";
import { escapeLike } from "./catalog";
import { canonicalize } from "./content-hash";
import { requireListingCursorKey, type ListingCursorKey } from "./listing-cursor";
import { loadLegacyHistoricalRead, loadLegacyHistoricalReads, type LegacyHistoricalRead } from "./legacy-listing-read";
import { validateFundingPolicy } from "./funding-policy";
import { decimalToBigInt, parseNonNegativeDecimal, yuanAmountObject } from "./decimal";
import { DELTA_INFO_SOURCE_DICTIONARY, projectDeltaQuote } from "./delta-rental";
import { projectTenantMoney } from "./tenant-price-projection";
import { evaluatePublication, listingCandidatePage, listingDetail, listingPageShared, publicListingBasis, publicListingMemo, readPublicListing, type ListingDetailPrefetch, type ListingPageShared, type ListingPublication, type ListingVersion, type PublishingAccount, type SupplyGate, type SupplyGateReader } from "./publishing";
import { projectPublicAttributeDisplay, publicLoginMethodOptions } from "./listing-query";
import { conflict, forbidden, invalid, notFound, sha256Hex } from "./supply-util";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
export const SUPERVISION_READ_VERSION = "admin-supervision.read.v1";
export type SupervisionViewer = {
    adminId: string;
    sessionId: string;
    access: EffectiveAdminAccess;
    scope: string[];
    contextKey: string;
};
export type SupervisionQuery = {
    view: "all" | "changes" | "restricted" | "paused" | "orders";
    queryKind: "account" | "legacy" | "owner" | "nickname" | "order";
    q: string;
    gameId: string;
    eligibility?: "ELIGIBLE" | "BLOCKED" | "UNKNOWN";
    source?: "NEW" | "LEGACY";
    haffMin?: string;
    haffMax?: string;
    depositMin?: string;
    depositMax?: string;
    loginMethod?: string;
    limit: number;
    cursor: string | null;
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const timePattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const QUERY_KEYS = ["queryVersion", "view", "queryKind", "q", "gameId", "limit", "cursor", "eligibility", "source", "haffMin", "haffMax", "depositMin", "depositMax", "loginMethod"];
/** Omitted means no bound. A present value must be a non-negative integer string; min>max is a separate error. */
function integerFilter(params: URLSearchParams, name: string, label: string): string | undefined {
    if (!params.has(name)) return undefined;
    const value = params.get(name)!;
    if (!/^(0|[1-9]\d{0,29})$/.test(value)) throw invalid(label + " must be a non-negative integer", name);
    return value;
}
function orderedRange(min: string | undefined, max: string | undefined, minName: string) {
    if (min !== undefined && max !== undefined && BigInt(min) > BigInt(max)) throw invalid("Range minimum is greater than maximum", minName);
    return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}
export function parseSupervisionQuery(params: URLSearchParams): SupervisionQuery {
    for (const key of params.keys())
        if (!QUERY_KEYS.includes(key) || params.getAll(key).length !== 1)
            throw invalid("Unsupported supervision query", key);
    const view = params.get("view") ?? "all", queryKind = params.get("queryKind") ?? "account", q = (params.get("q") ?? "").trim(), gameId = params.get("gameId") ?? "", limit = params.get("limit") ?? "20";
    // Phone-like input is only a user-directory lookup for the user clue kinds;
    // a 20-digit order/legacy number is an exact business identifier.
    const userLookup = queryKind === "owner" || queryKind === "nickname";
    if (!["all", "changes", "restricted", "paused", "orders"].includes(view) || !["account", "legacy", "owner", "nickname", "order"].includes(queryKind) || q.length > 128 || /[\u0000-\u001f]/.test(q) || userLookup && /^(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}$/.test(q) || gameId && !idPattern.test(gameId) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50)
        throw invalid("Invalid supervision query");
    const eligibility = params.has("eligibility") ? params.get("eligibility")! : undefined;
    if (eligibility !== undefined && !["ELIGIBLE", "BLOCKED", "UNKNOWN"].includes(eligibility)) throw invalid("Eligibility filter is invalid", "eligibility");
    const source = params.has("source") ? params.get("source")! : undefined;
    if (source !== undefined && !["NEW", "LEGACY"].includes(source)) throw invalid("Source filter is invalid", "source");
    const loginMethod = params.has("loginMethod") ? params.get("loginMethod")! : undefined;
    if (loginMethod !== undefined && !publicLoginMethodOptions().some(option => option.code === loginMethod)) throw invalid("Login method filter is invalid", "loginMethod");
    const haff = orderedRange(integerFilter(params, "haffMin", "haffMin"), integerFilter(params, "haffMax", "haffMax"), "haffMin");
    const deposit = orderedRange(integerFilter(params, "depositMin", "depositMin"), integerFilter(params, "depositMax", "depositMax"), "depositMin");
    return {
        view: view as SupervisionQuery["view"], queryKind: queryKind as SupervisionQuery["queryKind"], q, gameId, limit: Number(limit), cursor: params.get("cursor"),
        ...(eligibility ? { eligibility: eligibility as SupervisionQuery["eligibility"] } : {}),
        ...(source ? { source: source as SupervisionQuery["source"] } : {}),
        ...(haff.min !== undefined ? { haffMin: haff.min } : {}), ...(haff.max !== undefined ? { haffMax: haff.max } : {}),
        ...(deposit.min !== undefined ? { depositMin: deposit.min } : {}), ...(deposit.max !== undefined ? { depositMax: deposit.max } : {}),
        ...(loginMethod !== undefined ? { loginMethod } : {}),
    };
}
export async function supervisionViewer(client: PoolClient, actor: {
    userId: string;
    sessionId: string;
}, access: EffectiveAdminAccess): Promise<SupervisionViewer> {
    const gameScope = await readAdminGameScope(client, actor.userId);
    assertGameScopeUsable(gameScope, access.isBoss);
    const scope = gameScopeSignature(gameScope);
    return { adminId: actor.userId, sessionId: actor.sessionId, access, scope, contextKey: sha256Hex(JSON.stringify([actor.userId, actor.sessionId, access.isBoss, [...access.permissions].sort(), scope])) };
}
// Public listing cursors have a fixed public audience. Reuse their key validation,
// while binding this private cursor to the actor, authorization and whole query.
export function supervisionQueryBinding(viewer: SupervisionViewer, q: SupervisionQuery): string {
    return sha256Hex(JSON.stringify({ actor: viewer.contextKey, ...q, cursor: undefined }));
}
export function encodeSupervisionCursor(position: {
    at: string;
    id: string;
}, binding: string, key: ListingCursorKey | undefined): string {
    requireListingCursorKey(key);
    const body = Buffer.from(JSON.stringify({ audience: SUPERVISION_READ_VERSION, keyId: key.keyId, binding, position })).toString("base64url");
    return body + "." + createHmac("sha256", key.secret).update(body).digest("base64url");
}
export function decodeSupervisionCursor(token: string, binding: string, key: ListingCursorKey | undefined): {
    at: string;
    id: string;
} {
    requireListingCursorKey(key);
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
        throw conflict("Old supervision cursor; return to the first page");
    try {
        const [body, sig] = token.split(".") as [
            string,
            string
        ], actual = Buffer.from(sig, "base64url"), expected = createHmac("sha256", key.secret).update(body).digest();
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw Error();
        const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
        if (decoded.audience !== SUPERVISION_READ_VERSION || decoded.keyId !== key.keyId || decoded.binding !== binding || !timePattern.test(decoded.position?.at) || !idPattern.test(decoded.position?.id))
            throw Error();
        return decoded.position;
    }
    catch {
        throw conflict("Supervision identity, scope or query changed; return to the first page");
    }
}
const sourceSql = `SELECT DISTINCT m.source_system AS "sourceSystem",m.source_entity AS "sourceEntity",m.legacy_id AS "sourceId",h.snapshot->>'resourceNo' AS "businessNo" FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id AND h.source_system=m.source_system AND h.source_entity=m.source_entity AND h.legacy_id=m.legacy_id WHERE m.account_id=$1 ORDER BY "sourceSystem","sourceEntity","sourceId"`;
const pageSourceSql = `SELECT DISTINCT m.account_id AS "accountId",m.source_system AS "sourceSystem",m.source_entity AS "sourceEntity",m.legacy_id AS "sourceId",h.snapshot->>'resourceNo' AS "businessNo" FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id AND h.source_system=m.source_system AND h.source_entity=m.source_entity AND h.legacy_id=m.legacy_id WHERE m.account_id=ANY($1::text[]) ORDER BY "accountId","sourceSystem","sourceEntity","sourceId"`;
const oldNumberSql = `SELECT DISTINCT legacy_account_no AS value FROM zzsh_order.legacy_order_read_snapshot WHERE account_id=$1 AND legacy_account_no IS NOT NULL ORDER BY value`;
const pageOldNumberSql = `SELECT DISTINCT account_id,legacy_account_no AS value FROM zzsh_order.legacy_order_read_snapshot WHERE account_id=ANY($1::text[]) AND legacy_account_no IS NOT NULL ORDER BY account_id,value`;

/** The facts of one supervision row that are the same for every row of a page:
 *  the legacy source rows, the old account numbers and the historical read. */
export type SupervisionPageFacts = {
    sources: Map<string, Array<Record<string, unknown>>>;
    oldNumbers: Map<string, string[]>;
    historical: Map<string, LegacyHistoricalRead | null>;
};

async function loadSupervisionPageFacts(client: PoolClient, accountIds: string[]): Promise<SupervisionPageFacts> {
    const ids = [...new Set(accountIds)];
    const sources = new Map<string, Array<Record<string, unknown>>>(), oldNumbers = new Map<string, string[]>(), historical = new Map<string, LegacyHistoricalRead | null>();
    if (!ids.length)
        return { sources, oldNumbers, historical };
    for (const row of (await client.query(pageSourceSql, [ids])).rows) {
        const list = sources.get(row.accountId) ?? [];
        list.push({ sourceSystem: row.sourceSystem, sourceEntity: row.sourceEntity, sourceId: row.sourceId, businessNo: row.businessNo });
        sources.set(row.accountId, list);
    }
    for (const row of (await client.query(pageOldNumberSql, [ids])).rows) {
        const list = oldNumbers.get(row.account_id) ?? [];
        list.push(row.value);
        oldNumbers.set(row.account_id, list);
    }
    for (const [accountId, read] of await loadLegacyHistoricalReads(client, ids))
        historical.set(accountId, read);
    return { sources, oldNumbers, historical };
}

export async function supervisionFacts(client: PoolClient, a: PublishingAccount, detail: Record<string, any>, gate: SupplyGateReader, admission?: LegacyPublicAdmission, detailIndex?: LegacyPublicAdmissionDetailIndex, context?: { page?: SupervisionPageFacts; prefetch?: ListingDetailPrefetch }) {
    const sources = context?.page ? (context.page.sources.get(a.id) ?? []) : (await client.query(sourceSql, [a.id])).rows;
    const oldNumbers = context?.page ? (context.page.oldNumbers.get(a.id) ?? []) : (await client.query<{
        value: string;
    }>(oldNumberSql, [a.id])).rows.map(r => r.value);
    const blockers: string[] = detail.version ? detail.blockers ?? [] : ["CURRENT_VERSION_MISSING"];
    let publicVisible: boolean | null = null, publicSource: string | null = null, publicRead: Record<string, unknown> | null = null;
    try {
        publicRead = await readPublicListing(client, a, gate, admission, false, "DETAIL", detailIndex, context?.prefetch);
        publicVisible = true;
        publicSource = publicRead.source === "LEGACY_READ_ONLY" ? "LEGACY_READ_ONLY" : "NATIVE_PUBLICATION";
    }
    catch (error) {
        if ((error as {
            status?: number;
        }).status === 404)
            publicVisible = false;
        else
            throw error;
    }
    const unknown = ["OCCUPANCY_UNKNOWN", "FUNDING_UNKNOWN", "PUBLISHER_BAIL_UNCONFIRMED"], definite = blockers.filter(r => !unknown.includes(r));
    const newOrders = definite.length ? false : blockers.length ? null : Boolean(detail.available);
    const flow = ["RULE_CHANGED", "QUOTE_REQUIRED", "ACCEPTANCE_REQUIRED", "MEDIA_REQUIRED", "CONFIRMATION_OR_MEDIA_REQUIRED", "PUBLICATION_REQUIRED"].find(code => blockers.includes(code));
    const primaryReasonCode = a.staff_restricted ? "STAFF_RESTRICTED" : a.owner_paused ? "OWNER_PAUSED" : blockers.includes("CURRENT_VERSION_MISSING") ? "CURRENT_VERSION_MISSING" : flow ?? blockers[0] ?? null;
    const historicalRead = context?.page ? (context.page.historical.get(a.id) ?? null) : await loadLegacyHistoricalRead(client, a.id);
    const occupancyKind = detail.occupancyKind === "PENDING_PAYMENT" || detail.occupancyKind === "RENTED" || detail.occupancyKind === "OCCUPIED" ? detail.occupancyKind : null;
    const publicBasis = publicVisible ? publicListingBasis(publicRead ?? {}) : null;
    if (publicBasis) (publicBasis as Record<string, unknown>).feeSummary = quoteFeeSummary((publicRead as { quote?: Record<string, any> } | null)?.quote);
    return { publicVisible, publicSource, publicVersionId: publicBasis?.id ?? null, publicBasis, newOrders, reasons: blockers, primaryReasonCode, ownerPaused: a.owner_paused, staffRestricted: a.staff_restricted, occupancy: !detail.version ? "UNKNOWN" : blockers.includes("OCCUPIED") ? "OCCUPIED" : blockers.includes("OCCUPANCY_UNKNOWN") ? "UNKNOWN" : "FREE", occupancyKind, sources, legacyNumbers: [...new Set([...sources.map(r => r.businessNo).filter(Boolean), ...oldNumbers])], historicalRead };
}
const timestamp = (value: string) => `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Page-batched guarantee *material*: the legacy fixed funding-policy text and the
 * recorded proof rows.  Neither one is the account's current requirement once the
 * credit guarantee mechanism is enabled — funding-authority then derives it from
 * credit + coverage, and that authoritative verdict is already produced per row by
 * the gate this read path invokes (see guaranteeRequirement).  These two relations
 * are read once per page because the authoritative single-account readers are
 * private to funding-authority and a per-row call would widen the existing N+1.
 */
async function guaranteeFactsBatch(client: PoolClient, accountIds: string[]) {
    if (!accountIds.length)
        return new Map<string, { policyRequirement: PolicyRequirement; proof: Record<string, string | boolean | null> | null }>();
    const policyRows = (await client.query<{
        accountId: string;
        policy: unknown | null;
        status: string;
    }>(`SELECT a.id AS "accountId",p.funding_policy AS policy,p.status AS status
          FROM zzsh_supply.rental_account a
          JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id IS NOT NULL
          JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=a.game_id
          JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
         WHERE a.id=ANY($1::text[])`, [accountIds])).rows;
    const proofRows = (await client.query<{
        accountId: string;
        id: string;
        versionNo: string;
        ownerUserId: string;
        priceVersionId: string;
        policyVersion: string;
        status: string;
        requiredCents: string;
        coveredCents: string;
        validUntil: string | null;
        valid: boolean;
    }>(`SELECT DISTINCT ON (account_id) account_id AS "accountId",id,version_no::text AS "versionNo",owner_user_id AS "ownerUserId",
              price_version_id AS "priceVersionId",policy_version AS "policyVersion",status,
              required_cents::text AS "requiredCents",covered_cents::text AS "coveredCents",
              ${timestamp("valid_until")} AS "validUntil",
              (valid_from<=clock_timestamp() AND (valid_until IS NULL OR clock_timestamp()<valid_until)) AS valid
         FROM zzsh_supply.account_guarantee_proof WHERE account_id=ANY($1::text[]) ORDER BY account_id,version_no DESC`, [accountIds])).rows;
    const proofs = new Map(proofRows.map(row => [row.accountId, row]));
    const policies = new Map(policyRows.map(row => [row.accountId, row]));
    const result = new Map<string, { policyRequirement: PolicyRequirement; proof: Record<string, string | boolean | null> | null }>();
    for (const accountId of accountIds) {
        const row = policies.get(accountId), proof = proofs.get(accountId);
        let policyRequirement: PolicyRequirement = null;
        // An unreadable or unsealed policy stays 未提供; it never becomes 不要求.
        if (row?.status === "SEALED" && row.policy !== null) {
            try {
                const policy = validateFundingPolicy(row.policy);
                policyRequirement = { mode: policy.guaranteeRequirement.mode, requiredCents: policy.guaranteeRequirement.requiredCents };
            }
            catch { /* Invalid policy fails closed as 未提供. */ }
        }
        result.set(accountId, { policyRequirement, proof: proof ? { id: proof.id, versionNo: proof.versionNo, ownerUserId: proof.ownerUserId, priceVersionId: proof.priceVersionId, policyVersion: proof.policyVersion, status: proof.status, requiredCents: proof.requiredCents, coveredCents: proof.coveredCents, validUntil: proof.validUntil, valid: proof.valid } : null });
    }
    return result;
}

/**
 * 要求轴跟随当前启用机制：gate 快照带 creditGuarantee 时，信用/覆盖关系才是
 * 本账号的现行要求（旧固定政策的 NOT_REQUIRED 不能顶替它）；信用上下文未知、
 * 要求金额缺失或本次没走到权威读取，一律 UNAVAILABLE，不回落到旧政策。
 * 快照里没有信用结果时（未启用该机制）固定政策仍是权威，按来源标注后使用。
 */
type PolicyRequirement = { mode: "FIXED_CENTS" | "NOT_REQUIRED"; requiredCents: string } | null;
function guaranteeRequirement(gate: SupplyGate | undefined, policyRequirement: PolicyRequirement) {
    const credit = gate?.creditGuarantee;
    if (credit) {
        if (credit.status === "NOT_REQUIRED")
            return { requirement: { mode: "NOT_REQUIRED" as const, requiredCents: "0" }, requirementSource: "CREDIT_GUARANTEE" as const };
        if ((credit.status === "SATISFIED" || credit.status === "REQUIRED_UNCOVERED") && credit.requiredCents !== null)
            return { requirement: { mode: "FIXED_CENTS" as const, requiredCents: credit.requiredCents }, requirementSource: "CREDIT_GUARANTEE" as const };
        return { requirement: null, requirementSource: "UNAVAILABLE" as const };
    }
    if (!gate || !gate.reference)
        return { requirement: null, requirementSource: "UNAVAILABLE" as const };
    return { requirement: policyRequirement, requirementSource: policyRequirement ? "FIXED_FUNDING_POLICY" as const : "UNAVAILABLE" as const };
}

type ListFeeSummary = { completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; haffRental: ReturnType<typeof yuanAmountObject> | null; materials: ReturnType<typeof yuanAmountObject> | null; resourceTotal: ReturnType<typeof yuanAmountObject> | null };
const unknownFeeSummary = (): ListFeeSummary => ({ completeness: "UNKNOWN", haffRental: null, materials: null, resourceTotal: null });
/** Strict CNY/yuan/scale-2 money; an invalid side is unknown, never re-labelled or coerced. */
function centsOfAmount(value: unknown): bigint | null {
    try {
        const amount = projectTenantMoney(value).amount;
        return decimalToBigInt(parseNonNegativeDecimal(amount, 2, "list fee amount"), 2);
    } catch { return null; }
}
/** The known total survives unknown components; missing lines never become zero and components are never derived by subtraction. */
export function quoteFeeSummary(quote: Record<string, any> | null | undefined): ListFeeSummary {
    if (!quote || quote.currency !== "CNY") return unknownFeeSummary();
    const resource = centsOfAmount(quote.resourceTotal);
    const partial = (): ListFeeSummary => ({ completeness: "PARTIAL", haffRental: null, materials: null, resourceTotal: resource === null ? null : yuanAmountObject(resource) });
    if (!Array.isArray(quote.lines)) return partial();
    let haff: bigint | null = null, materials: bigint | null = null, haffSeen = false, invalid = false;
    for (const line of quote.lines) {
        if (!line || typeof line !== "object") { invalid = true; continue; }
        const cents = centsOfAmount(line.buyerAmount);
        if (cents === null) { invalid = true; continue; }
        if (line.unit === "HAFF_BASE") {
            if (haffSeen) { haff = null; invalid = true; } else { haffSeen = true; haff = cents; }
        } else if (line.unit === "ROUND" || line.unit === "PIECE" || line.unit === "DAY") materials = (materials ?? 0n) + cents;
        else invalid = true;
    }
    // A HAFF-only quote is a proven zero materials fee only when the total closes exactly.
    if (!invalid && haff !== null && materials === null && resource !== null && haff === resource) materials = 0n;
    const complete = !invalid && haff !== null && materials !== null && resource !== null && haff + materials === resource;
    const knownComponent = haff !== null || materials !== null;
    return {
        completeness: complete ? "COMPLETE" : knownComponent || resource !== null ? "PARTIAL" : "UNKNOWN",
        haffRental: haff === null ? null : yuanAmountObject(haff),
        materials: materials === null ? null : yuanAmountObject(materials),
        resourceTotal: resource === null ? null : yuanAmountObject(resource),
    };
}
/** Cheap predicates are already in SQL; these selected aliases keep the same tuple visible to the bounded sampler. */
export function matchesCheapFilters(q: SupervisionQuery, row: Record<string, any>): boolean {
    const legacy = row.filterLegacy === true;
    if (q.source === "LEGACY" && !legacy) return false;
    if (q.source === "NEW" && legacy) return false;
    const range = (raw: unknown, min: string | undefined, max: string | undefined) => {
        if (min === undefined && max === undefined) return true;
        if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
        const value = BigInt(raw);
        return (min === undefined || value >= BigInt(min)) && (max === undefined || value <= BigInt(max));
    };
    if (!range(row.filterHaff, q.haffMin, q.haffMax)) return false;
    if (!range(row.filterDeposit, q.depositMin, q.depositMax)) return false;
    if (q.loginMethod !== undefined && row.filterLogin !== q.loginMethod) return false;
    return true;
}
/** Filters run against the same displayed summary and facts the row shows, before the returned page is sliced. */
export function matchesSupervisionFilters(q: SupervisionQuery, facts: Record<string, any>, summary: Record<string, any> | null): boolean {
    const legacySource = Boolean((Array.isArray(facts.sources) && facts.sources.length) || facts.historicalRead);
    if (q.source === "LEGACY" && !legacySource) return false;
    if (q.source === "NEW" && legacySource) return false;
    if (q.eligibility === "ELIGIBLE" && facts.newOrders !== true) return false;
    if (q.eligibility === "BLOCKED" && facts.newOrders !== false) return false;
    if (q.eligibility === "UNKNOWN" && facts.newOrders !== null) return false;
    if (q.haffMin !== undefined || q.haffMax !== undefined) {
        const raw = summary?.haff?.quantity;
        if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
        const value = BigInt(raw);
        if (q.haffMin !== undefined && value < BigInt(q.haffMin)) return false;
        if (q.haffMax !== undefined && value > BigInt(q.haffMax)) return false;
    }
    if (q.depositMin !== undefined || q.depositMax !== undefined) {
        const raw = summary?.baseDeposit?.amountCents;
        if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
        const value = BigInt(raw);
        if (q.depositMin !== undefined && value < BigInt(q.depositMin)) return false;
        if (q.depositMax !== undefined && value > BigInt(q.depositMax)) return false;
    }
    if (q.loginMethod !== undefined && summary?.login?.code !== q.loginMethod) return false;
    return true;
}
/** 本页真实需要的最小受权摘要；只读已经取得的 detail/facts，缺字段保持 null。 */
/** Same fields, but only the public version's own declaration/quote; never filled from the current draft. */
function publicBasisListingSummary(publicBasis: Record<string, any>, facts: Record<string, any>, guarantee: { policyRequirement: PolicyRequirement; proof: Record<string, string | boolean | null> | null } | undefined, gate: SupplyGate | undefined, rowFacts: {
    accountCreatedAt: string;
    accountUpdatedAt: string | null;
    versionCreatedAt: string | null;
}) {
    const quote = publicBasis.quote ?? null, attributes: Record<string, unknown> = publicBasis.attributes ?? {};
    const lines: Array<Record<string, any>> = Array.isArray(quote?.lines) ? quote.lines : [];
    const presentationItems: Array<Record<string, any>> = Array.isArray(publicBasis.presentation?.items) ? publicBasis.presentation.items : [];
    const named = new Map<string, Record<string, any>>();
    for (const item of presentationItems) if (typeof item?.id === "string") named.set(item.id, item);
    const haffLine = lines.find(line => line.unit === "HAFF_BASE") ?? null;
    const visibleMaterials = lines.filter(line => line !== haffLine && !(typeof line.quantity === "string" && /^0+$/.test(line.quantity)));
    const materials = visibleMaterials.slice(0, 6).map(line => {
        const item = typeof line.itemId === "string" ? named.get(line.itemId) : undefined;
        return { itemId: typeof line.itemId === "string" ? line.itemId : "", name: typeof item?.name === "string" ? item.name : null, code: typeof item?.code === "string" ? item.code : null, quantity: typeof line.quantity === "string" ? line.quantity : null, unit: typeof line.unit === "string" ? line.unit : null };
    });
    const declared = attributes.owner_deposit_declaration as Record<string, unknown> | undefined;
    const declaredCents = typeof publicBasis.baseDeposit?.amountCents === "string" ? publicBasis.baseDeposit.amountCents
      : declared?.schema === "owner-deposit-declaration-v1" && typeof declared.amountCents === "string" ? declared.amountCents : null;
    const payout = publicBasis.fullPayoutSelected;
    const display = publicBasis.attributeDisplay;
    const readiness = !publicBasis ? null : (facts.reasons as string[]).includes("PUBLISHER_BAIL_UNCONFIRMED") ? "UNCONFIRMED" : "CONFIRMED";
    const amount = (value: unknown) => value && typeof value === "object" && typeof (value as { amount?: unknown }).amount === "string"
        ? { amount: (value as { amount: string }).amount, currency: (value as { currency?: string }).currency ?? null, unit: (value as { unit?: string }).unit ?? null, scale: (value as { scale?: string }).scale ?? null }
        : null;
    const termOption = publicBasis.termOption;
    const login = { code: typeof attributes.login_method_code === "string" ? attributes.login_method_code : null, displayName: display?.loginMethod?.displayName ?? null };
    const config = {
        safeBox: display?.safeBox?.displayName ?? (typeof attributes.safe_box_code === "string" ? `未确认（代码 ${attributes.safe_box_code}）` : null),
        characterLevel: attributes.character_level === null || attributes.character_level === undefined ? null : String(attributes.character_level),
        grading: display?.grading?.displayName ?? (typeof attributes.grading_code === "string" ? `未确认（代码 ${attributes.grading_code}）` : null),
        gradingDivision: Object.hasOwn(attributes, "grading_division") && attributes.grading_division !== null && attributes.grading_division !== "" ? String(attributes.grading_division) : null,
    };
    return {
        displaySource: "PUBLIC_VERSION",
        versionId: publicBasis.id,
        sequence: null,
        contentHash: typeof publicBasis.contentHash === "string" ? publicBasis.contentHash : null,
        title: typeof publicBasis.title === "string" ? publicBasis.title : null,
        description: typeof publicBasis.description === "string" ? publicBasis.description : null,
        refs: { ruleReleaseId: typeof publicBasis.releaseId === "string" ? publicBasis.releaseId : null, priceVersionId: null, contentHash: typeof publicBasis.contentHash === "string" ? publicBasis.contentHash : null, catalogRevision: null, publicationSource: "PUBLIC", publishedAt: typeof publicBasis.publishedAt === "string" ? publicBasis.publishedAt : null },
        timing: { accountCreatedAt: rowFacts.accountCreatedAt, accountUpdatedAt: rowFacts.accountUpdatedAt, versionCreatedAt: rowFacts.versionCreatedAt },
        haff: haffLine ? { itemId: haffLine.itemId, quantity: typeof haffLine.quantity === "string" ? haffLine.quantity : null, unit: "HAFF_BASE" } : null,
        materials,
        materialsVisibleTotal: visibleMaterials.length,
        materialsTotal: lines.filter(line => line !== haffLine).length,
        term: { code: typeof termOption?.code === "string" ? termOption.code : null, name: typeof termOption?.displayName === "string" ? termOption.displayName : null, dailyConsumption: typeof termOption?.dailyConsumption?.quantity === "string" ? termOption.dailyConsumption.quantity : null, termSeconds: typeof quote?.termSeconds === "string" ? quote.termSeconds : null },
        login,
        config,
        feeSummary: quoteFeeSummary(quote),
        quote: quote ? { currency: quote.currency ?? null, resourceTotal: amount(quote.resourceTotal), tenantDeposit: amount(quote.tenantDeposit), tenantPayableTotal: amount(quote.tenantPayableTotal), frozen: true, personalised: false } : null,
        baseDeposit: declaredCents ? { amountCents: declaredCents } : null,
        fullPayout: payout === true ? "SELECTED" : payout === false ? "NOT_SELECTED" : "NOT_DECLARED",
        guarantee: { ...guaranteeRequirement(gate, guarantee?.policyRequirement ?? null), recordedProof: guarantee?.proof ?? null, eligibility: readiness },
    };
}
function listingSummary(detail: Record<string, any>, facts: Record<string, any>, guarantee: { policyRequirement: PolicyRequirement; proof: Record<string, string | boolean | null> | null } | undefined, gate: SupplyGate | undefined, termOption: { code: string; name: string; dailyConsumption: string | null } | null, rowFacts: {
    accountCreatedAt: string;
    accountUpdatedAt: string | null;
    versionCreatedAt: string | null;
    refs: {
        ruleReleaseId: string | null;
        priceVersionId: string | null;
    };
}) {
    const version = detail.version ?? null, quote = version?.quote ?? null;
    const attributes: Record<string, unknown> = version?.declaration?.attributes ?? {};
    const inventory: Array<{
        itemId: string;
        quantity: string | null;
    }> = version?.declaration?.inventory ?? [];
    const catalog: Array<{
        id: string;
        unit: string;
        code?: string;
        name?: string;
    }> = version?.catalogItems ?? [];
    const named = new Map<string, { code?: string; name?: string; unit?: string }>();
    for (const item of Array.isArray(version?.presentationItems) ? version.presentationItems : [])
        if (item && typeof item === "object" && typeof item.id === "string") named.set(item.id, item);
    const haffLine = inventory.find(line => (named.get(line.itemId)?.unit ?? catalog.find(item => item.id === line.itemId)?.unit) === "HAFF_BASE") ?? null;
    const visibleMaterials = inventory.filter(line => line !== haffLine && !(typeof line.quantity === "string" && /^0+$/.test(line.quantity)));
    const materials = visibleMaterials.slice(0, 6).map(line => {
        const frozen = named.get(line.itemId), item = catalog.find(entry => entry.id === line.itemId);
        return { itemId: line.itemId, name: frozen?.name ?? item?.name ?? null, code: frozen?.code ?? item?.code ?? null, quantity: line.quantity, unit: frozen?.unit ?? item?.unit ?? null };
    });
    const materialsTotal = inventory.filter(line => line !== haffLine).length;
    const attributeDisplay = version ? projectPublicAttributeDisplay(attributes) : null;
    const login = version ? { code: typeof attributes.login_method_code === "string" ? attributes.login_method_code : null, displayName: attributeDisplay?.loginMethod?.displayName ?? null } : null;
    const config = version ? {
        safeBox: attributeDisplay?.safeBox?.displayName ?? (typeof attributes.safe_box_code === "string" ? `未确认（代码 ${attributes.safe_box_code}）` : null),
        characterLevel: attributes.character_level === null || attributes.character_level === undefined ? null : String(attributes.character_level),
        grading: attributeDisplay?.grading?.displayName ?? (typeof attributes.grading_code === "string" ? `未确认（代码 ${attributes.grading_code}）` : null),
        gradingDivision: Object.hasOwn(attributes, "grading_division") && attributes.grading_division !== null && attributes.grading_division !== "" ? String(attributes.grading_division) : null,
    } : null;
    const payout = attributes.full_payout_declaration;
    const fullPayout = payout && typeof payout === "object" && !Array.isArray(payout) && typeof (payout as {
        selected?: unknown;
    }).selected === "boolean" ? ((payout as {
        selected: boolean;
    }).selected ? "SELECTED" : "NOT_SELECTED") : "NOT_DECLARED";
    const declared = attributes.owner_deposit_declaration;
    const declaredCents = declared && typeof declared === "object" && !Array.isArray(declared) ? (declared as {
        amountCents?: unknown;
    }).amountCents : undefined;
    const amount = (value: unknown) => value && typeof value === "object" && typeof (value as {
        amount?: unknown;
    }).amount === "string" ? { amount: (value as {
        amount: string;
    }).amount, currency: (value as {
        currency?: string;
    }).currency ?? null, unit: (value as {
        unit?: string;
    }).unit ?? null, scale: (value as {
        scale?: string;
    }).scale ?? null } : null;
    // 资格沿用权威 gate 已给出的阻塞码，不在列表里重算保证金规则。
    const eligibility = !version ? null : (facts.reasons as string[]).includes("PUBLISHER_BAIL_UNCONFIRMED") ? "UNCONFIRMED" : "CONFIRMED";
    return {
        displaySource: "CURRENT_VERSION",
        versionId: version?.id ?? null,
        sequence: version?.sequence ?? null,
        contentHash: version?.contentHash ?? null,
        refs: { ruleReleaseId: rowFacts.refs.ruleReleaseId, priceVersionId: rowFacts.refs.priceVersionId, contentHash: version?.contentHash ?? null, catalogRevision: quote?.catalogRevision ?? null, publicationSource: version?.publication?.source ?? null, publishedAt: version?.publication?.publishedAt ?? null },
        title: version?.declaration?.title ?? null,
        description: version?.declaration?.description ?? null,
        timing: { accountCreatedAt: rowFacts.accountCreatedAt, accountUpdatedAt: rowFacts.accountUpdatedAt, versionCreatedAt: rowFacts.versionCreatedAt },
        haff: haffLine ? { itemId: haffLine.itemId, quantity: haffLine.quantity, unit: "HAFF_BASE" } : null,
        materials,
        materialsTotal,
        materialsVisibleTotal: visibleMaterials.length,
        term: version ? { code: termOption?.code ?? null, name: termOption?.name ?? null, dailyConsumption: termOption?.dailyConsumption ?? null, termSeconds: typeof quote?.termSeconds === "string" ? quote.termSeconds : null } : null,
        login,
        config,
        feeSummary: quoteFeeSummary(quote),
        quote: quote ? { currency: quote.currency ?? null, resourceTotal: amount(quote.resourceTotal), tenantDeposit: amount(quote.tenantDeposit), tenantPayableTotal: amount(quote.tenantPayableTotal), ownerTotal: amount(quote.ownerTotal), publisherBailRequirement: amount(quote.publisherBailRequirement), frozen: true, personalised: false } : null,
        baseDeposit: typeof declaredCents === "string" ? { amountCents: declaredCents } : null,
        fullPayout,
        guarantee: { ...guaranteeRequirement(gate, guarantee?.policyRequirement ?? null), recordedProof: guarantee?.proof ?? null, eligibility },
    };
}
/** List rows need the same blockers and the quote already stored on the version.
 *  They do not load agreement text, review history, presentation or draft skins. */
type PageStockLine = { itemId: string; quantity: string | null; unit?: string | null; code?: string | null; name?: string | null };
async function loadPageInventory(client: PoolClient, versionIds: string[], accountIds: string[]) {
    const stock = new Map<string, PageStockLine[]>();
    if (!versionIds.length) return stock;
    const rows = (await client.query<PageStockLine & { versionId: string }>(`SELECT /* page-inventory */ l.version_id AS "versionId", l.item_id AS "itemId", l.quantity::text AS quantity, i.unit, i.code, i.name
       FROM zzsh_supply.inventory_line l
       JOIN zzsh_supply.listing_version v ON v.id=l.version_id
       JOIN zzsh_supply.rental_account a ON a.id=v.account_id AND a.current_version_id=v.id
       LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=a.game_id
      WHERE l.version_id=ANY($1::text[]) AND a.id=ANY($2::text[])
      ORDER BY l.version_id, i.sort_order NULLS LAST, l.item_id`, [versionIds, accountIds])).rows;
    for (const row of rows) {
        const list = stock.get(row.versionId) ?? [];
        list.push({ itemId: row.itemId, quantity: row.quantity ?? null, unit: row.unit ?? null, code: row.code ?? null, name: row.name ?? null });
        stock.set(row.versionId, list);
    }
    return stock;
}
/** Page-batched bound term option: one query for the page, keyed by release+code. */
async function loadPageTermOptions(client: PoolClient, wanted: Array<{ releaseId: string | null; code: string | null }>) {
    const pairs = [...new Map(wanted.filter(row => row.releaseId && row.code).map(row => [`${row.releaseId}\u0000${row.code}`, row])).values()];
    const result = new Map<string, { code: string; name: string; dailyConsumption: string | null }>();
    if (!pairs.length) return result;
    const rows = (await client.query<{ releaseId: string; code: string; name: string; dailyConsumption: string | null }>(
        `SELECT x.release_id AS "releaseId",o.code,o.name,o.daily_consumption::text AS "dailyConsumption"
           FROM unnest($1::text[],$2::text[]) AS x(release_id,code)
           JOIN zzsh_supply.rule_release r ON r.id=x.release_id
           JOIN zzsh_supply.term_option o ON o.version_id=r.term_version_id AND o.code=x.code`,
        [pairs.map(row => row.releaseId), pairs.map(row => row.code)],
    )).rows;
    for (const row of rows) result.set(`${row.releaseId}\u0000${row.code}`, { code: row.code, name: row.name, dailyConsumption: row.dailyConsumption ?? null });
    return result;
}
async function listVersionProjection(client: PoolClient, account: PublishingAccount, version: ListingVersion, gate: SupplyGateReader, quoteViewer: "admin" | "public", shared: ListingPageShared, pageStock?: Map<string, PageStockLine[]>) {
    const observed: { publication?: ListingPublication | null } = {};
    const seen: { gate: SupplyGate | null } = { gate: null };
    const blockers = await evaluatePublication(client, account, version, async (db, row, purpose) => {
        seen.gate = await gate(db, row, purpose);
        return seen.gate;
    }, "READ", false, shared, undefined, observed);
    const payload = version.payload;
    const quoteValues = payload?.quoteValues as { lines?: Array<{ itemId?: unknown; unit?: unknown }> } | undefined;
    const quote = quoteValues ? { ...projectDeltaQuote({ ...quoteValues, contentHash: version.content_hash } as never, quoteViewer), ...(payload?.ruleRefs.catalogRevision === undefined ? {} : { catalogRevision: payload.ruleRefs.catalogRevision }) } : null;
    const lines = Array.isArray(quoteValues?.lines) ? quoteValues.lines : [];
    const savedInventory = payload?.declaration && Array.isArray(payload.declaration.inventory) ? payload.declaration.inventory : null;
    const stock = savedInventory ?? pageStock?.get(version.id) ?? [];
    return {
        occupancyKind: seen.gate?.occupancy === "OCCUPIED" ? (seen.gate.occupancyKind === "PENDING_PAYMENT" || seen.gate.occupancyKind === "RENTED" ? seen.gate.occupancyKind : "OCCUPIED") : null,
        available: blockers.length === 0,
        blockers,
        version: {
            id: version.id,
            sequence: version.sequence,
            contentHash: version.content_hash,
            publication: observed.publication ? { source: observed.publication.source, publishedAt: observed.publication.published_at.toISOString() } : null,
            declaration: { attributes: version.attributes ?? {}, inventory: stock.map(line => ({ itemId: line.itemId, quantity: line.quantity ?? null })) },
            presentationItems: Array.isArray(version.presentation?.items) ? version.presentation.items : [],
            catalogItems: savedInventory ? lines.flatMap(line => typeof line.itemId === "string" ? [{ id: line.itemId, unit: typeof line.unit === "string" ? line.unit : "" }] : []) : stock.filter(line => line.itemId).map(line => ({ id: line.itemId, unit: line.unit ?? "", code: line.code ?? undefined, name: line.name ?? undefined })),
            quote,
            feeSummary: quoteFeeSummary(quote),
        },
    };
}
/** Eligibility still needs the authoritative gate, so residual filtering has a fixed per-request budget. */
export const FILTER_SCAN_MAX_CANDIDATES = 500;
const filterScopeTooLarge = () => new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "筛选范围过大，暂不能完整核对；请缩小筛选条件后重试。");
/** Private attribution is not the account's migration source and never enters public listing projections. */
export function accountManagement(source: unknown) {
    const value = typeof source === "string" && source.trim() ? source : null;
    return { infoSource: value === null ? null : { value, name: DELTA_INFO_SOURCE_DICTIONARY.options.find(option => option.value === value)?.name ?? value } };
}
export async function listSupervision(client: PoolClient, viewer: SupervisionViewer, q: SupervisionQuery, gate: SupplyGateReader, key: ListingCursorKey | undefined, admission?: LegacyPublicAdmission, detailIndex?: LegacyPublicAdmissionDetailIndex) {
    const canOrder = viewer.access.permissions.has("order.read");
    if ((q.view === "orders" || q.queryKind === "order" && q.q) && !canOrder)
        throw forbidden();
    const binding = supervisionQueryBinding(viewer, q), initialAfter = q.cursor ? decodeSupervisionCursor(q.cursor, binding, key) : null;
    requireListingCursorKey(key);
    const quoteViewer = viewer.access.permissions.has("supply.quote.internal.read") ? "admin" : "public";
    const canDirectory = viewer.access.permissions.has("user.directory.read");
    const hasResidualFilters = Boolean(q.eligibility);
    const needsDisplayVersion = q.haffMin !== undefined || q.haffMax !== undefined || q.depositMin !== undefined || q.depositMax !== undefined || q.loginMethod !== undefined;
    const hasCheapFilters = Boolean(q.source || needsDisplayVersion);
    const sort = "COALESCE(v.created_at,a.created_at)", sortAt = `to_char(${sort} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const orderExists = (predicate = "") => `(EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=a.id${predicate}) OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot o WHERE o.account_id=a.id${predicate.replaceAll("o.display_no", "o.original_order_no")}))`;
    const legacySourceSql = `(EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id) OR EXISTS(SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h WHERE h.account_id=a.id))`;
    // The displayed version is the public publication selected by readPublicListing; otherwise the current version.
    const displayJoin = `LEFT JOIN LATERAL (
 SELECT pv.*
 FROM zzsh_supply.listing_version pv
 JOIN zzsh_supply.listing_publication p ON p.version_id=pv.id AND p.account_id=a.id
  AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id
  AND p.rule_release_id=pv.rule_release_id AND p.content_hash=pv.content_hash
 WHERE pv.account_id=a.id
  AND ((pv.review_state='PUBLISHED' AND p.source='OWNER_DIRECT') OR (pv.review_state='APPROVED' AND p.source='LEGACY_APPROVED'))
  AND EXISTS(SELECT 1 FROM zzsh_supply.rule_acceptance ra WHERE ra.account_id=a.id AND ra.listing_version_id=pv.id
   AND ra.rule_release_id=pv.rule_release_id AND ra.accepted_content_hash=pv.content_hash AND ra.owner_user_id=a.owner_user_id)
 ORDER BY (pv.id=a.current_version_id) DESC,p.published_at DESC,pv.sequence DESC,pv.id LIMIT 1
) dv ON true`;
    const displayIsPublic = "(dv.id IS NOT NULL AND v.id IS DISTINCT FROM dv.id)";
    const displayAttributes = "COALESCE(dv.attributes,v.attributes)";
    const haffSql = `CASE WHEN ${displayIsPublic} THEN (
 SELECT CASE WHEN line.item->>'quantity' ~ '^[0-9]+$' THEN (line.item->>'quantity')::numeric END
 FROM jsonb_array_elements(COALESCE(dv.payload->'quoteValues'->'lines','[]'::jsonb)) AS line(item)
 WHERE line.item->>'unit'='HAFF_BASE' LIMIT 1
) ELSE COALESCE(
 (SELECT CASE WHEN inv.item->>'quantity' ~ '^[0-9]+$' THEN (inv.item->>'quantity')::numeric END
  FROM jsonb_array_elements(COALESCE(v.payload->'declaration'->'inventory','[]'::jsonb)) AS inv(item)
  WHERE (inv.item->>'itemId') IN (
   SELECT line.item->>'itemId' FROM jsonb_array_elements(COALESCE(v.payload->'quoteValues'->'lines','[]'::jsonb)) AS line(item) WHERE line.item->>'unit'='HAFF_BASE'
   UNION SELECT item.value->>'id' FROM jsonb_array_elements(COALESCE(v.presentation->'items','[]'::jsonb)) AS item(value) WHERE item.value->>'unit'='HAFF_BASE'
  ) LIMIT 1),
 (SELECT CASE WHEN l.quantity IS NOT NULL AND l.quantity::text ~ '^[0-9]+$' THEN l.quantity::numeric END
  FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=a.game_id AND i.unit='HAFF_BASE'
  WHERE l.version_id=v.id LIMIT 1)
) END`;
    const depositSql = `CASE WHEN ${displayAttributes}#>>'{owner_deposit_declaration,schema}'='owner-deposit-declaration-v1'
 AND (${displayAttributes}#>>'{owner_deposit_declaration,amountCents}') ~ '^[0-9]+$'
 THEN (${displayAttributes}#>>'{owner_deposit_declaration,amountCents}')::numeric END`;
    // Projection is the same authoritative read as a single row; cheap predicates
    // use the displayed tuple in SQL and only residual eligibility uses the gate.
    const project = async (rows: Array<Record<string, any>>) => {
        const ids = rows.map(row => row.id);
        const guarantees = await guaranteeFactsBatch(client, ids);
        const gates = new Map<string, SupplyGate>();
        const recordGate: SupplyGateReader = async (client, account, purpose) => {
            const snapshot = await gate(client, account, purpose);
            gates.set(account.id, snapshot);
            return snapshot;
        };
        const page = listingCandidatePage(client);
        await page.load(ids, true);
        const publicMemo = publicListingMemo(client, recordGate);
        const pageFacts = await loadSupervisionPageFacts(client, ids);
        const unfrozenIds = rows.map(row => page.version(row.id)).filter((version): version is ListingVersion => Boolean(version && !(version.payload?.declaration && Array.isArray(version.payload.declaration.inventory)))).map(version => version.id);
        const pageStock = await loadPageInventory(client, unfrozenIds, ids);
        const termOptions = await loadPageTermOptions(client, rows.map(row => ({ releaseId: row.ruleReleaseId ?? null, code: row.termOptionCode ?? null })));
        const result: Array<Record<string, any>> = [];
        for (const row of rows) {
            const a = page.account(row.id);
            if (!a) throw notFound();
            const version = page.version(row.id);
            // A current version that the batch read did not resolve is a missing
            // object, exactly as the single read reported it.
            if (a.current_version_id && !version) throw notFound();
            const prefetch: ListingDetailPrefetch = { version, shared: page.shared, hasPublication: page.hasPublication(row.id), publicListing: (account) => publicMemo.read(account, prefetch) };
            const detail = version ? await listVersionProjection(client, a, version, recordGate, quoteViewer, page.shared, pageStock) : { version: null, blockers: ["CURRENT_VERSION_MISSING"], available: false, occupancyKind: null };
            const facts = await supervisionFacts(client, a, detail, recordGate, admission, detailIndex, { page: pageFacts, prefetch });
            const rowFacts = { accountCreatedAt: row.accountCreatedAt, accountUpdatedAt: row.accountUpdatedAt, versionCreatedAt: row.versionCreatedAt, refs: { ruleReleaseId: row.ruleReleaseId ?? null, priceVersionId: row.priceVersionId ?? null } };
            // Default list/Dialog/detail show the real public version; the current draft is not mixed into it.
            const summary = facts.publicBasis && (!version || facts.publicBasis.id !== version.id)
                ? publicBasisListingSummary(facts.publicBasis, facts, guarantees.get(row.id), gates.get(row.id), rowFacts)
                : listingSummary(detail, facts, guarantees.get(row.id), gates.get(row.id), termOptions.get(`${row.ruleReleaseId}\u0000${row.termOptionCode}`) ?? null, rowFacts);
            if (hasResidualFilters && !matchesSupervisionFilters(q, facts, summary)) continue;
            result.push({ ...row, facts, summary, ownerLink: canDirectory ? { state: "READY" as const } : { state: "DENIED" as const } });
        }
        return result;
    };
    const candidateWhere = (after: typeof initialAfter) => {
        const values: unknown[] = [viewer.access.isBoss, viewer.adminId], p = (value: unknown) => "$" + values.push(value);
        const where = [gameScopeSql("a.game_id","$2","$1")];
        if (q.gameId)
            where.push(`a.game_id=${p(q.gameId)}`);
        if (q.view === "restricted")
            where.push("a.staff_restricted");
        if (q.view === "paused")
            where.push("a.owner_paused");
        if (q.view === "changes")
            where.push("EXISTS(SELECT 1 FROM zzsh_supply.listing_version previous WHERE previous.account_id=a.id AND previous.sequence<v.sequence)");
        if (q.view === "orders")
            where.push(orderExists());
        if (q.q) {
            const value = p(q.queryKind === "nickname" ? "%" + escapeLike(q.q) + "%" : q.q);
            if (q.queryKind === "account")
                where.push(`(a.id=${value} OR a.display_no=${value})`);
            if (q.queryKind === "owner")
                where.push(`(a.owner_user_id=${value} OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event e WHERE e.object_id=a.owner_user_id AND e.object_type='user' AND e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS' AND e.details->>'legacyId'=${value}))`);
            if (q.queryKind === "nickname")
                where.push(`u.name ILIKE ${value} ESCAPE '\\'`);
            if (q.queryKind === "legacy")
                where.push(`(EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id AND m.legacy_id=${value}) OR EXISTS(SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h WHERE h.account_id=a.id AND h.snapshot->>'resourceNo'=${value}) OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot o WHERE o.account_id=a.id AND o.legacy_account_no=${value}))`);
            if (q.queryKind === "order")
                where.push(orderExists(` AND (o.id=${value} OR o.display_no=${value})`));
        }
        if (q.source === "LEGACY") where.push(legacySourceSql);
        if (q.source === "NEW") where.push(`NOT ${legacySourceSql}`);
        if (q.haffMin !== undefined) where.push(`(${haffSql})>=${p(q.haffMin)}::numeric`);
        if (q.haffMax !== undefined) where.push(`(${haffSql})<=${p(q.haffMax)}::numeric`);
        if (q.depositMin !== undefined) where.push(`(${depositSql})>=${p(q.depositMin)}::numeric`);
        if (q.depositMax !== undefined) where.push(`(${depositSql})<=${p(q.depositMax)}::numeric`);
        if (q.loginMethod !== undefined) where.push(`(${displayAttributes}->>'login_method_code')=${p(q.loginMethod)}`);
        if (after) where.push(`(${sort},a.id COLLATE "C")<(${p(after.at)}::timestamptz,${p(after.id)} COLLATE "C")`);
        return { values, where };
    };
    const from = `FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id ${needsDisplayVersion ? displayJoin : ""} JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id`;
    let total: number | null = null;
    if (!hasResidualFilters) {
        const count = candidateWhere(null);
        const raw = (await client.query(`SELECT count(*)::text AS total ${from} WHERE ${count.where.join(" AND ")}`, count.values)).rows[0]?.total;
        if (typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw) && Number.isSafeInteger(Number(raw))) total = Number(raw);
    }
    const items: Array<Record<string, any>> = [];
    let scanAfter = initialAfter, nextCursor: string | null = null, scanned = 0;
    const batchLimit = hasResidualFilters ? Math.max(q.limit + 1, 20) : q.limit + 1;
    for (;;) {
        const fetchLimit = hasResidualFilters ? Math.min(batchLimit, FILTER_SCAN_MAX_CANDIDATES - scanned) : batchLimit;
        if (fetchLimit <= 0) throw filterScopeTooLarge();
        const { values, where } = candidateWhere(scanAfter), p = (value: unknown) => "$" + values.push(value);
        const rows = (await client.query(`SELECT a.id,a.id AS "accountId",a.display_no AS "displayNo",a.owner_user_id AS "ownerId",a.revision::text AS "revision",${sortAt} AS "sortAt",${timestamp("a.created_at")} AS "accountCreatedAt",${timestamp("a.updated_at")} AS "accountUpdatedAt",v.id AS "versionId",v.sequence::text AS sequence,v.title,v.review_state AS "reviewState",${timestamp("v.created_at")} AS "versionCreatedAt",v.rule_release_id AS "ruleReleaseId",v.term_option_code AS "termOptionCode",v.payload#>>'{ruleRefs,priceVersionId}' AS "priceVersionId",u.name AS "ownerName",g.name AS "gameName"${hasCheapFilters ? `,(${legacySourceSql}) AS "filterLegacy"${needsDisplayVersion ? `,(${haffSql})::text AS "filterHaff",(${depositSql})::text AS "filterDeposit",(${displayAttributes}->>'login_method_code') AS "filterLogin"` : ""}` : ""} ${from} WHERE ${where.join(" AND ")} ORDER BY ${sort} DESC,a.id COLLATE "C" DESC LIMIT ${p(fetchLimit)}`, values)).rows;
        if (!rows.length) break;
        scanned += rows.length;
        const matchingRows = hasCheapFilters ? rows.filter(row => matchesCheapFilters(q, row)) : rows;
        if (matchingRows.length) items.push(...await project(matchingRows));
        else if (!hasResidualFilters) break;
        if (items.length > q.limit) {
            const returned = items.slice(0, q.limit), last = returned.at(-1)!;
            nextCursor = encodeSupervisionCursor({ at: last.sortAt, id: last.id }, binding, key);
            items.splice(q.limit);
            break;
        }
        if (hasResidualFilters && items.length === q.limit && scanned >= FILTER_SCAN_MAX_CANDIDATES && rows.length === fetchLimit) {
            const last = items.at(-1)!;
            nextCursor = encodeSupervisionCursor({ at: last.sortAt, id: last.id }, binding, key);
            break;
        }
        if (rows.length < fetchLimit) break;
        // Eligibility needs the authoritative gate; exceed the fixed candidate budget explicitly.
        if (hasResidualFilters && scanned >= FILTER_SCAN_MAX_CANDIDATES) throw filterScopeTooLarge();
        const last = rows.at(-1)!;
        scanAfter = { at: last.sortAt, id: last.id };
    }
    // Load cross-domain profiles only for the final page, never the scanned eligibility candidates.
    const owners = await readDirectoryUserSummaries(client, items.map(row => row.ownerId), viewer.access.permissions, {adminId:viewer.adminId,isBoss:viewer.access.isBoss,membershipSummaryRead:viewer.access.permissions.has('membership.growth.read.summary'),creditRead:viewer.access.permissions.has('credit.read')});
    for (const item of items) { const owner = owners.get(item.ownerId); if (owner) item.ownerSummary = owner; }
    const games = (await client.query(`SELECT g.id,g.name FROM zzsh_supply.game g ORDER BY g.name,g.id`)).rows;
    if (hasResidualFilters && initialAfter === null && nextCursor === null) total = items.length;
    return { contractVersion: SUPERVISION_READ_VERSION, contextKey: viewer.contextKey, query: { ...q, cursor: undefined }, games, filterOptions: { loginMethods: publicLoginMethodOptions().map(option => ({ code: option.code, name: option.displayName })) }, items, nextCursor, total };
}
export async function readSupervision(client: PoolClient, a: PublishingAccount, viewer: SupervisionViewer, gate: SupplyGateReader, versionId: string | null, admission?: LegacyPublicAdmission, detailIndex?: LegacyPublicAdmissionDetailIndex) {
    if (versionId && !idPattern.test(versionId))
        throw invalid("Invalid version ID");
    if (versionId && !(await client.query("SELECT 1 FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2", [versionId, a.id])).rowCount)
        throw notFound();
    const historical = Boolean(versionId && versionId !== a.current_version_id), quoteViewer = viewer.access.permissions.has("supply.quote.internal.read") ? "admin" : "public";
    // The viewed, current, previous and originally restricted versions all
    // project the same account's public listing; one request-scoped projection
    // serves them, and the page-level game/release reads are shared.
    const publicMemo = publicListingMemo(client, gate);
    const prefetch: ListingDetailPrefetch = { shared: listingPageShared(client), publicListing: (account) => publicMemo.read(account, prefetch) };
    const detail: Record<string, any> = await listingDetail(client, versionId ? { ...a, current_version_id: versionId } : a, "admin", gate, quoteViewer, a, false, "RENTABLE", prefetch);
    if (detail.version) detail.version.feeSummary = quoteFeeSummary(detail.version.quote);
    const live = historical ? await listingDetail(client, a, "admin", gate, quoteViewer, a, false, "RENTABLE", prefetch) : detail;
    const history = (await client.query("SELECT id,sequence::text,origin,review_state,title,content_hash,rule_release_id,created_at FROM zzsh_supply.listing_version WHERE account_id=$1 ORDER BY sequence DESC", [a.id])).rows;
    const viewed = versionId ?? a.current_version_id, previousId = history[history.findIndex(r => r.id === viewed) + 1]?.id;
    const previous: Record<string, any> | null = previousId ? await listingDetail(client, { ...a, current_version_id: previousId }, "admin", gate, quoteViewer, a, false, "RENTABLE", prefetch) : null;
    const events = (await client.query(`SELECT e.id,e.action,e.reason,e.occurred_at AS "occurredAt",u.name AS "actorName",e.details->'before'->>'revision' AS "beforeRevision",e.details->'after'->>'revision' AS "afterRevision",e.details->'before'->>'currentVersionId' AS "versionId",e.details->'after'->'staffRestricted' AS restricted FROM zzsh_iam.audit_event e LEFT JOIN zzsh_auth_admin."user" u ON u.id=e.actor_id WHERE e.object_type='rental_account' AND e.object_id=$1 AND e.action='supply.publication.restriction' AND e.outcome='SUCCESS' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 20`, [a.id])).rows;
    const originalRestrictionId = events.find(e => e.restricted === true)?.versionId;
    const originalRestriction: Record<string, any> | null = originalRestrictionId && history.some(h => h.id === originalRestrictionId) ? await listingDetail(client, { ...a, current_version_id: originalRestrictionId }, "admin", gate, quoteViewer, a, false, "RENTABLE", prefetch) : null;
    const canOrder = viewer.access.permissions.has("order.read"), orders = canOrder ? await queryAdminReadOrders(client, { adminId: viewer.adminId, isBoss: viewer.access.isBoss, internalQuote: false, authorizationKey: viewer.contextKey }, { accountId: a.id, page: 1, pageSize: 5 }) : null;
    const duplicateHints = (await client.query(`SELECT h.id,h.related_account_id,h.evidence_ref,h.result,h.reason FROM zzsh_supply.duplicate_hint h JOIN zzsh_supply.rental_account related ON related.id=h.related_account_id WHERE h.account_id=$1 AND ${gameScopeSql("related.game_id","$3","$2")}`, [a.id, viewer.access.isBoss, viewer.adminId])).rows;
    const changes = previous?.version && detail.version ? { previousVersionId: previous.version.id, previousSequence: previous.version.sequence, changed: canonicalize(previous.version.declaration) !== canonicalize(detail.version.declaration) } : null;
    if (detail.version) {
        const media = detail.version.declaration.mediaBindings;
        const revisions = (await client.query<{
            id: string;
            revision: string;
        }>("SELECT id,revision::text FROM zzsh_supply.media_asset WHERE id=ANY($1::text[])", [media.map((m: {
                assetId: string;
            }) => m.assetId)])).rows;
        for (const binding of media)
            binding.mediaRevision = revisions.find(r => r.id === binding.assetId)?.revision ?? null;
    }
    if (historical) {
        detail.account = a;
        detail.available = false;
        detail.blockers = [...((detail.blockers as string[]) ?? []), "HISTORICAL_VERSION"];
    }
    if (detail.version) detail.version.management = accountManagement(detail.version.declaration.attributes.info_source);
    const facts = await supervisionFacts(client, a, live, gate, admission, detailIndex, { prefetch });
    if (facts.publicBasis) {
        const basis = facts.publicBasis, same = detail.version?.id === basis.id && detail.version?.contentHash === basis.contentHash;
        const source = same ? detail.version.declaration.attributes.info_source : (await client.query(`SELECT attributes->'info_source' AS source FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2 AND content_hash=$3`, [basis.id, a.id, basis.contentHash])).rows[0]?.source;
        const managedBasis = { ...basis, management: accountManagement(source) };
        facts.publicBasis = managedBasis;
    }
    return { ...detail, contractVersion: SUPERVISION_READ_VERSION, contextKey: viewer.contextKey, history, previousDeclaration: previous?.version?.declaration ?? null, previousPresentation: previous?.version?.presentation ?? null, duplicateHints, supervision: { historical, facts, changes, previousVersion: previous?.version ?? null, originalRestrictionVersion: originalRestriction?.version ?? null, restrictionHistory: { state: events.length ? "KNOWN" : "NOT_RECORDED", items: events, limit: 20 }, ownerLink: viewer.access.permissions.has("user.directory.read") ? { state: "READY", userId: a.owner_user_id } : { state: "DENIED" }, orders: orders ? { state: "READY", ...orders } : { state: "DENIED", permission: "order.read" } } };
}
