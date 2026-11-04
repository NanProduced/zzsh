import type { PoolClient } from "pg";
import { readAdminContext, assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { withTransaction } from "../auth/security-core";
import { readUserContext, assertUserContextInTransaction } from "../auth/user-identity";
import { defaultCreateClient, loadOssCredentials, type OssObjectClient } from "./media-oss";
import { legacyImageHttpResult, readLegacyImage, selectLegacyImagePath, type LegacyMediaRecord, type LegacyMediaViewer } from "./legacy-path-media";
import { authorizeLegacyPublicSlot } from "./legacy-path-projection";
import { readPublicListing, readPublishingAccount, unknownSupplyGate, withPublicListingSnapshot } from "./publishing";
import { assertGameScope, notFound, type SupplyNodeRequest, type SupplyNodeResponse } from "./supply-util";
import type { SupplyRuntimeOptions } from "./supply-routes";

const id = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", slot = "(0|[1-9][0-9]{0,5})";
const publicPath = new RegExp(`^/listings/(${id})/legacy-images/${slot}$`);
const accountPath = new RegExp(`^/accounts/(${id})/legacy-images/(display|penalty)/${slot}$`);
const readers = new WeakMap<object, OssObjectClient>();

function ossReader(options: SupplyRuntimeOptions): { reader: OssObjectClient; prefix: string } | null {
  const storage = options.mediaStorage, target = storage.configuration?.target;
  if (storage.kind !== "oss" || !storage.available || !target) return null;
  try {
    let reader = readers.get(storage);
    if (!reader) { reader = defaultCreateClient(target, loadOssCredentials(process.env)); readers.set(storage, reader); }
    return { reader, prefix: target.objectPrefix };
  } catch { return null; }
}

async function readRecord(client: PoolClient, accountId: string): Promise<LegacyMediaRecord | null> {
  return (await client.query<LegacyMediaRecord>(
    `SELECT p.account_id AS "accountId",a.owner_user_id AS "ownerUserId",p.observation_version_id AS "observationVersionId",
            a.current_version_id AS "currentVersionId",p.source_digest AS "sourceDigest",m.source_digest AS "currentSourceDigest",
            p.display_paths AS "displayPaths",p.penalty_paths AS "penaltyPaths"
       FROM zzsh_supply.legacy_account_media_paths p JOIN zzsh_supply.rental_account a ON a.id=p.account_id
       JOIN zzsh_supply.legacy_supply_map m ON m.account_id=p.account_id AND m.version_id=p.observation_version_id
         AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      WHERE p.account_id=$1`, [accountId],
  )).rows[0] ?? null;
}

export async function handleLegacyPathMediaRoute(request: SupplyNodeRequest, response: SupplyNodeResponse, options: SupplyRuntimeOptions, requestId: string, path: string, query: URLSearchParams, admin: boolean): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase(), pub = !admin ? publicPath.exec(path) : null, account = accountPath.exec(path);
  if (!pub && !account) return false;
  if (!["GET", "HEAD"].includes(method) || [...query.keys()].length || (admin && pub)) throw notFound();
  const accountId = (pub ?? account)![1]!, field = pub ? "display" : account![2] as "display" | "penalty", index = Number(pub ? pub[2] : account![3]);
  let viewer: LegacyMediaViewer;
  let row: LegacyMediaRecord | null;
  if (pub) {
    const admitted = await withPublicListingSnapshot(options.pool, async client => {
      const a = await readPublishingAccount(client, accountId);
      const listing = await readPublicListing(client, a, options.supplyGateReader ?? unknownSupplyGate, options.legacyPublicAdmission, false, "DETAIL", options.legacyPublicAdmissionDetail);
      const row = await readRecord(client, accountId);
      const versionId = await authorizeLegacyPublicSlot(client, listing, row, index);
      if (!versionId) throw notFound();
      return { row, versionId };
    });
    row = admitted.row;
    viewer = { realm: "public", admitted: true, versionId: admitted.versionId };
  } else if (admin) {
    const context = await readAdminContext(request, options);
    row = await withTransaction(options.pool, async client => {
      await assertAdminContextInTransaction(client, context);
      const access = await loadEffectiveAdminAccess(client, context.userId); requirePermission(access, "supply.review.read");
      const a = await readPublishingAccount(client, accountId); await assertGameScope(client, context.userId, access!.isBoss, a.game_id);
      return readRecord(client, accountId);
    });
    viewer = { realm: "admin", canReview: true, inGameScope: true };
  } else {
    const context = await readUserContext(request, options);
    row = await withTransaction(options.pool, async client => { await assertUserContextInTransaction(client, context, "READ"); return readRecord(client, accountId); });
    viewer = { realm: "user", userId: context.userId };
  }
  const store = ossReader(options);
  const allowed = selectLegacyImagePath(row, accountId, field, index, viewer);
  const result = !allowed ? { state: "NOT_FOUND" as const } : store ? await readLegacyImage(store.reader, store.prefix, row, accountId, field, index, viewer, method === "HEAD") : { state: "UNAVAILABLE" as const };
  const output = legacyImageHttpResult(result);
  response.status(output.status); response.setHeader("X-Request-Id", requestId);
  for (const [key, value] of Object.entries(output.headers)) response.setHeader(key, value);
  if (method === "HEAD" || output.body) response.send?.(output.body ?? "");
  else response.json({ error: { code: output.status === 503 ? "INTERNAL_ERROR" : "NOT_FOUND", message: "图片暂不可用", requestId } });
  return true;
}
