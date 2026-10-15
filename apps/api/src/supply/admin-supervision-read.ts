import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { EffectiveAdminAccess } from "../auth/admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, gameScopeSql, readAdminGameScope } from "../auth/admin-scope";
import { queryAdminReadOrders } from "../order/admin-order-read";
import { maskPhoneNumber } from "../auth/user-directory";
import { escapeLike } from "./catalog";
import { canonicalize } from "./content-hash";
import { requireListingCursorKey, type ListingCursorKey } from "./listing-cursor";
import { loadLegacyHistoricalRead } from "./legacy-listing-read";
import { validateFundingPolicy } from "./funding-policy";
import { listingDetail, readPublishingAccount, readPublicListing, type PublishingAccount, type SupplyGate, type SupplyGateReader } from "./publishing";
import { conflict, forbidden, invalid, notFound, sha256Hex } from "./supply-util";
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
    limit: number;
    cursor: string | null;
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const timePattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
export function parseSupervisionQuery(params: URLSearchParams): SupervisionQuery {
    for (const key of params.keys())
        if (!["queryVersion", "view", "queryKind", "q", "gameId", "limit", "cursor"].includes(key) || params.getAll(key).length !== 1)
            throw invalid("Unsupported supervision query", key);
    const view = params.get("view") ?? "all", queryKind = params.get("queryKind") ?? "account", q = (params.get("q") ?? "").trim(), gameId = params.get("gameId") ?? "", limit = params.get("limit") ?? "20";
    if (!["all", "changes", "restricted", "paused", "orders"].includes(view) || !["account", "legacy", "owner", "nickname", "order"].includes(queryKind) || q.length > 128 || /[\u0000-\u001f]/.test(q) || /(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/.test(q) || gameId && !idPattern.test(gameId) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50)
        throw invalid("Invalid supervision query");
    return { view: view as SupervisionQuery["view"], queryKind: queryKind as SupervisionQuery["queryKind"], q, gameId, limit: Number(limit), cursor: params.get("cursor") };
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
export async function supervisionFacts(client: PoolClient, a: PublishingAccount, detail: Record<string, any>, gate: SupplyGateReader) {
    const sources = (await client.query(sourceSql, [a.id])).rows;
    const oldNumbers = (await client.query<{
        value: string;
    }>(`SELECT DISTINCT legacy_account_no AS value FROM zzsh_order.legacy_order_read_snapshot WHERE account_id=$1 AND legacy_account_no IS NOT NULL ORDER BY value`, [a.id])).rows.map(r => r.value);
    const blockers: string[] = detail.version ? detail.blockers ?? [] : ["CURRENT_VERSION_MISSING"];
    let publicVisible: boolean | null = null, publicSource: string | null = null;
    try {
        const publicRead = await readPublicListing(client, a, gate);
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
    const primaryReasonCode = a.staff_restricted ? "STAFF_RESTRICTED" : a.owner_paused ? "OWNER_PAUSED" : blockers.includes("CURRENT_VERSION_MISSING") ? "CURRENT_VERSION_MISSING" : blockers.includes("PUBLICATION_REQUIRED") ? "PUBLICATION_REQUIRED" : blockers[0] ?? null;
    const historicalRead = await loadLegacyHistoricalRead(client, a.id);
    return { publicVisible, publicSource, newOrders, reasons: blockers, primaryReasonCode, ownerPaused: a.owner_paused, staffRestricted: a.staff_restricted, occupancy: !detail.version ? "UNKNOWN" : blockers.includes("OCCUPIED") ? "OCCUPIED" : blockers.includes("OCCUPANCY_UNKNOWN") ? "UNKNOWN" : "FREE", sources, legacyNumbers: [...new Set([...sources.map(r => r.businessNo).filter(Boolean), ...oldNumbers])], historicalRead };
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

/** 号主下钻所需的脱敏资料；无 user.directory.read 时整块不返回。 */
async function ownerSummaryBatch(client: PoolClient, userIds: string[]) {
    if (!userIds.length)
        return new Map<string, { name: string; image: string | null; maskedPhone: string | null }>();
    const rows = (await client.query<{
        id: string;
        name: string;
        image: string | null;
        phone: string | null;
    }>(`SELECT id,name,image,"phoneNumber" AS phone FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])`, [userIds])).rows;
    return new Map(rows.map(row => [row.id, { name: row.name, image: row.image, maskedPhone: maskPhoneNumber(row.phone) }]));
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

/** 本页真实需要的最小受权摘要；只读已经取得的 detail/facts，缺字段保持 null。 */
function listingSummary(detail: Record<string, any>, facts: Record<string, any>, guarantee: { policyRequirement: PolicyRequirement; proof: Record<string, string | boolean | null> | null } | undefined, gate: SupplyGate | undefined, rowFacts: {
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
    }> = version?.catalogItems ?? [];
    const haffLine = inventory.find(line => catalog.find(item => item.id === line.itemId)?.unit === "HAFF_BASE") ?? null;
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
        versionId: version?.id ?? null,
        sequence: version?.sequence ?? null,
        refs: { ruleReleaseId: rowFacts.refs.ruleReleaseId, priceVersionId: rowFacts.refs.priceVersionId, contentHash: version?.contentHash ?? null, catalogRevision: quote?.catalogRevision ?? null, publicationSource: version?.publication?.source ?? null, publishedAt: version?.publication?.publishedAt ?? null },
        timing: { accountCreatedAt: rowFacts.accountCreatedAt, accountUpdatedAt: rowFacts.accountUpdatedAt, versionCreatedAt: rowFacts.versionCreatedAt },
        haff: haffLine ? { itemId: haffLine.itemId, quantity: haffLine.quantity, unit: "HAFF_BASE" } : null,
        quote: quote ? { currency: quote.currency ?? null, resourceTotal: amount(quote.resourceTotal), tenantDeposit: amount(quote.tenantDeposit), tenantPayableTotal: amount(quote.tenantPayableTotal), ownerTotal: amount(quote.ownerTotal), publisherBailRequirement: amount(quote.publisherBailRequirement), frozen: true, personalised: false } : null,
        baseDeposit: typeof declaredCents === "string" ? { amountCents: declaredCents } : null,
        fullPayout,
        guarantee: { ...guaranteeRequirement(gate, guarantee?.policyRequirement ?? null), recordedProof: guarantee?.proof ?? null, eligibility },
    };
}
export async function listSupervision(client: PoolClient, viewer: SupervisionViewer, q: SupervisionQuery, gate: SupplyGateReader, key: ListingCursorKey | undefined) {
    const canOrder = viewer.access.permissions.has("order.read");
    if ((q.view === "orders" || q.queryKind === "order" && q.q) && !canOrder)
        throw forbidden();
    const binding = sha256Hex(JSON.stringify({ actor: viewer.contextKey, ...q, cursor: undefined })), after = q.cursor ? decodeSupervisionCursor(q.cursor, binding, key) : null;
    requireListingCursorKey(key);
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
    const orderExists = (predicate = "") => `(EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=a.id${predicate}) OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot o WHERE o.account_id=a.id${predicate.replaceAll("o.display_no", "o.original_order_no")}))`;
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
    const sort = "COALESCE(v.created_at,a.created_at)", sortAt = `to_char(${sort} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    if (after)
        where.push(`(${sort},a.id COLLATE "C")<(${p(after.at)}::timestamptz,${p(after.id)} COLLATE "C")`);
    const quoteViewer = viewer.access.permissions.has("supply.quote.internal.read") ? "admin" : "public";
    const rows = (await client.query(`SELECT a.id,a.id AS "accountId",a.display_no AS "displayNo",a.owner_user_id AS "ownerId",a.revision::text AS "revision",${sortAt} AS "sortAt",${timestamp("a.created_at")} AS "accountCreatedAt",${timestamp("a.updated_at")} AS "accountUpdatedAt",v.id AS "versionId",v.sequence::text AS sequence,v.title,v.review_state AS "reviewState",${timestamp("v.created_at")} AS "versionCreatedAt",v.rule_release_id AS "ruleReleaseId",v.payload#>>'{ruleRefs,priceVersionId}' AS "priceVersionId",u.name AS "ownerName",g.name AS "gameName" FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id WHERE ${where.join(" AND ")} ORDER BY ${sort} DESC,a.id COLLATE "C" DESC LIMIT ${p(q.limit + 1)}`, values)).rows;
    const visible = rows.slice(0, q.limit), items = [];
    // Bounded pages reuse the authoritative publication/legacy read instead of
    // inventing a cheaper, divergent eligibility rule in a SQL list projection.
    const guarantees = await guaranteeFactsBatch(client, visible.map(row => row.id));
    const canDirectory = viewer.access.permissions.has("user.directory.read");
    const owners = canDirectory ? await ownerSummaryBatch(client, [...new Set(visible.map(row => row.ownerId))]) : new Map<string, {
        name: string;
        image: string | null;
        maskedPhone: string | null;
    }>();
    // publicationBlockers already invokes the gate for every row with a current
    // version, so recording its result costs no extra read.
    const gates = new Map<string, SupplyGate>();
    const recordGate: SupplyGateReader = async (client, account, purpose) => {
        const snapshot = await gate(client, account, purpose);
        gates.set(account.id, snapshot);
        return snapshot;
    };
    for (const row of visible) {
        const a = await readPublishingAccount(client, row.id), detail = await listingDetail(client, a, "admin", recordGate, quoteViewer);
        const facts = await supervisionFacts(client, a, detail, recordGate);
        const ownerSummary = owners.get(row.ownerId);
        items.push({ ...row, facts, summary: listingSummary(detail, facts, guarantees.get(row.id), gates.get(row.id), { accountCreatedAt: row.accountCreatedAt, accountUpdatedAt: row.accountUpdatedAt, versionCreatedAt: row.versionCreatedAt, refs: { ruleReleaseId: row.ruleReleaseId ?? null, priceVersionId: row.priceVersionId ?? null } }), ownerLink: canDirectory ? { state: "READY" as const } : { state: "DENIED" as const }, ...(ownerSummary ? { ownerSummary } : {}) });
    }
    const last = visible.at(-1);
    const games = (await client.query(`SELECT g.id,g.name FROM zzsh_supply.game g ORDER BY g.name,g.id`)).rows;
    return { contractVersion: SUPERVISION_READ_VERSION, contextKey: viewer.contextKey, query: { ...q, cursor: undefined }, games, items, nextCursor: rows.length > q.limit && last ? encodeSupervisionCursor({ at: last.sortAt, id: last.id }, binding, key) : null };
}
export async function readSupervision(client: PoolClient, a: PublishingAccount, viewer: SupervisionViewer, gate: SupplyGateReader, versionId: string | null) {
    if (versionId && !idPattern.test(versionId))
        throw invalid("Invalid version ID");
    if (versionId && !(await client.query("SELECT 1 FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2", [versionId, a.id])).rowCount)
        throw notFound();
    const historical = Boolean(versionId && versionId !== a.current_version_id), quoteViewer = viewer.access.permissions.has("supply.quote.internal.read") ? "admin" : "public";
    const detail: Record<string, any> = await listingDetail(client, versionId ? { ...a, current_version_id: versionId } : a, "admin", gate, quoteViewer, a);
    const live = historical ? await listingDetail(client, a, "admin", gate, quoteViewer) : detail;
    const history = (await client.query("SELECT id,sequence::text,origin,review_state,title,content_hash,rule_release_id,created_at FROM zzsh_supply.listing_version WHERE account_id=$1 ORDER BY sequence DESC", [a.id])).rows;
    const viewed = versionId ?? a.current_version_id, previousId = history[history.findIndex(r => r.id === viewed) + 1]?.id;
    const previous: Record<string, any> | null = previousId ? await listingDetail(client, { ...a, current_version_id: previousId }, "admin", gate, quoteViewer, a) : null;
    const events = (await client.query(`SELECT e.id,e.action,e.reason,e.occurred_at AS "occurredAt",u.name AS "actorName",e.details->'before'->>'revision' AS "beforeRevision",e.details->'after'->>'revision' AS "afterRevision",e.details->'before'->>'currentVersionId' AS "versionId",e.details->'after'->'staffRestricted' AS restricted FROM zzsh_iam.audit_event e LEFT JOIN zzsh_auth_admin."user" u ON u.id=e.actor_id WHERE e.object_type='rental_account' AND e.object_id=$1 AND e.action='supply.publication.restriction' AND e.outcome='SUCCESS' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 20`, [a.id])).rows;
    const originalRestrictionId = events.find(e => e.restricted === true)?.versionId;
    const originalRestriction: Record<string, any> | null = originalRestrictionId && history.some(h => h.id === originalRestrictionId) ? await listingDetail(client, { ...a, current_version_id: originalRestrictionId }, "admin", gate, quoteViewer, a) : null;
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
    return { ...detail, contractVersion: SUPERVISION_READ_VERSION, contextKey: viewer.contextKey, history, previousDeclaration: previous?.version?.declaration ?? null, previousPresentation: previous?.version?.presentation ?? null, duplicateHints, supervision: { historical, facts: await supervisionFacts(client, a, live, gate), changes, previousVersion: previous?.version ?? null, originalRestrictionVersion: originalRestriction?.version ?? null, restrictionHistory: { state: events.length ? "KNOWN" : "NOT_RECORDED", items: events, limit: 20 }, ownerLink: viewer.access.permissions.has("user.directory.read") ? { state: "READY", userId: a.owner_user_id } : { state: "DENIED" }, orders: orders ? { state: "READY", ...orders } : { state: "DENIED", permission: "order.read" } } };
}
