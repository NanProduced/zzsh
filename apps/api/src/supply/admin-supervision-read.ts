import { createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { EffectiveAdminAccess } from "../auth/admin-authorization";
import { queryAdminReadOrders } from "../order/admin-order-read";
import { escapeLike } from "./catalog";
import { canonicalize } from "./content-hash";
import { requireListingCursorKey, type ListingCursorKey } from "./listing-cursor";
import { listingDetail, readPublishingAccount, readPublicListing, type PublishingAccount, type SupplyGateReader } from "./publishing";
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
    const scope = (await client.query<{
        gameId: string;
    }>(`SELECT game_id AS "gameId" FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 ORDER BY game_id`, [actor.userId])).rows.map(r => r.gameId);
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
    return { publicVisible, publicSource, newOrders, reasons: blockers, primaryReasonCode, ownerPaused: a.owner_paused, staffRestricted: a.staff_restricted, occupancy: !detail.version ? "UNKNOWN" : blockers.includes("OCCUPIED") ? "OCCUPIED" : blockers.includes("OCCUPANCY_UNKNOWN") ? "UNKNOWN" : "FREE", sources, legacyNumbers: [...new Set([...sources.map(r => r.businessNo).filter(Boolean), ...oldNumbers])] };
}
export async function listSupervision(client: PoolClient, viewer: SupervisionViewer, q: SupervisionQuery, gate: SupplyGateReader, key: ListingCursorKey | undefined) {
    const canOrder = viewer.access.permissions.has("order.read");
    if ((q.view === "orders" || q.queryKind === "order" && q.q) && !canOrder)
        throw forbidden();
    const binding = sha256Hex(JSON.stringify({ actor: viewer.contextKey, ...q, cursor: undefined })), after = q.cursor ? decodeSupervisionCursor(q.cursor, binding, key) : null;
    requireListingCursorKey(key);
    const values: unknown[] = [viewer.access.isBoss, viewer.adminId], p = (value: unknown) => "$" + values.push(value);
    const where = [`($1::boolean OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$2 AND s.game_id=a.game_id))`];
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
    const rows = (await client.query(`SELECT a.id,${sortAt} AS "sortAt",v.id AS "versionId",v.sequence::text AS sequence,v.title,v.review_state AS "reviewState",u.name AS "ownerName",g.name AS "gameName" FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id WHERE ${where.join(" AND ")} ORDER BY ${sort} DESC,a.id COLLATE "C" DESC LIMIT ${p(q.limit + 1)}`, values)).rows;
    const visible = rows.slice(0, q.limit), items = [];
    // Bounded pages reuse the authoritative publication/legacy read instead of
    // inventing a cheaper, divergent eligibility rule in a SQL list projection.
    for (const row of visible) {
        const a = await readPublishingAccount(client, row.id), detail = await listingDetail(client, a, "admin", gate, "public");
        items.push({ ...row, accountId: a.id, displayNo: a.display_no, ownerId: a.owner_user_id, revision: a.revision, facts: await supervisionFacts(client, a, detail, gate) });
    }
    const last = visible.at(-1);
    const games = (await client.query(`SELECT g.id,g.name FROM zzsh_supply.game g WHERE $1::boolean OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$2 AND s.game_id=g.id) ORDER BY g.name,g.id`, [viewer.access.isBoss, viewer.adminId])).rows;
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
    const duplicateHints = (await client.query(`SELECT h.id,h.related_account_id,h.evidence_ref,h.result,h.reason FROM zzsh_supply.duplicate_hint h JOIN zzsh_supply.rental_account related ON related.id=h.related_account_id WHERE h.account_id=$1 AND ($2 OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$3 AND s.game_id=related.game_id))`, [a.id, viewer.access.isBoss, viewer.adminId])).rows;
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
