import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { gameScopeSql } from "../auth/admin-scope";
import { orderReadRelation } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { CHANNEL_EVIDENCE_PRODUCTS, createChannelEvidenceReadScope, readAdminChannelPaymentEvidence, readAdminChannelRefundEvidence,
  readAdminChannelWithdrawalEvidence, searchAdminChannelOriginals, type ChannelProductFamily } from "./channel-evidence-read";
import type { JoinpayAccountReadAccess } from "./channel-finance-read";

export const ADMIN_CHANNEL_EVIDENCE_VERSION = "admin-channel-evidence.read.v1";
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
type Actor = { userId: string; complete: boolean; relations: { adminId: string; isBoss: boolean; orderRead: boolean } };
const invalid = (m: string) => new SecurityApiError(400, "INVALID_ARGUMENT", m);
const notFound = () => new SecurityApiError(404, "NOT_FOUND", "Channel evidence object not found");
function ref(value: string): string {
  let decoded: string; try { decoded = decodeURIComponent(value); } catch { throw invalid("Invalid channel evidence reference"); }
  if (!REF.test(decoded)) throw invalid("Invalid channel evidence reference");
  return decoded;
}
function onlyParams(query: URLSearchParams, allowed: readonly string[]) {
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported or repeated channel evidence parameter");
}

/** Scope is minted only from the server-side session actor plus explicit server merchant grants; the URL never widens it. */
export async function readAdminChannelEvidenceRoute(client: PoolClient, actor: Actor, route: string, query: URLSearchParams, access?: JoinpayAccountReadAccess) {
  if (!access) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Channel evidence scope is not configured");
  const [, kind, first, second] = route.split("/");
  const merchantIds = [...(access.merchantIdsByAdmin.get(actor.relations.adminId) ?? [])];
  const base = { database: access.database, runtimeUser: access.runtimeUser, adminId: actor.relations.adminId, merchantIds,
    financeReadable: actor.complete, userReadable: false, readableUserIds: [] as string[] };
  if (kind === "orders" && first && !second) {
    onlyParams(query, []);
    const orderId = ref(first);
    if (!actor.relations.isBoss && !actor.relations.orderRead) throw new SecurityApiError(403, "FORBIDDEN", "Order read permission required");
    const relation = orderReadRelation(await legacyContinuationReady(client), false, { nativeIds: "$1", legacyIds: "$1" });
    const row = (await client.query<{ origin: string }>(`WITH all_orders AS(${relation}) SELECT x.origin FROM all_orders x WHERE x.id=ANY($1::text[]) AND ${gameScopeSql("x.game_id", "$3", "$2")}`,
      [[orderId], actor.relations.isBoss, actor.relations.adminId])).rows;
    if (row.length !== 1) throw notFound();
    const origin = row[0]!.origin === "NATIVE" ? "NATIVE" as const : "LEGACY" as const;
    const scope = createChannelEvidenceReadScope({ ...base, orderReadable: true, readableOrderIds: [orderId] });
    return { contractVersion: ADMIN_CHANNEL_EVIDENCE_VERSION, kind: "ORDER", orderId, origin,
      payment: await readAdminChannelPaymentEvidence(client, scope, { orderId, origin }),
      refund: await readAdminChannelRefundEvidence(client, scope, { orderId, origin }), bankArrival: "UNKNOWN" as const };
  }
  const scope = createChannelEvidenceReadScope({ ...base, orderReadable: false, readableOrderIds: [] });
  if (kind === "withdrawals" && first && second) {
    onlyParams(query, []);
    return { contractVersion: ADMIN_CHANNEL_EVIDENCE_VERSION, kind: "WITHDRAWAL", bankArrival: "UNKNOWN" as const,
      withdrawal: await readAdminChannelWithdrawalEvidence(client, scope, { merchantIdentityId: ref(first), intentId: ref(second) }) };
  }
  if (kind === "originals" && first && !second) {
    onlyParams(query, ["productFamily", "merchantOrderNo", "channelTrxNo"]);
    const productFamily = query.get("productFamily") as ChannelProductFamily;
    if (!CHANNEL_EVIDENCE_PRODUCTS.includes(productFamily)) throw invalid("Unsupported channel product family");
    return { contractVersion: ADMIN_CHANNEL_EVIDENCE_VERSION, kind: "ORIGINAL_SEARCH", bankArrival: "UNKNOWN" as const,
      search: await searchAdminChannelOriginals(client, scope, { merchantIdentityId: ref(first), productFamily,
        merchantOrderNo: query.get("merchantOrderNo"), channelTrxNo: query.get("channelTrxNo") }) };
  }
  throw notFound();
}
const rows = (value: readonly unknown[]) => value.length;