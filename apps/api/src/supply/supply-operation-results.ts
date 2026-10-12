import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, requirePermission, type EffectiveAdminAccess } from "../auth/admin-authorization";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { assertGameScope, invalid, notFound } from "./supply-util";

type Definition = { table: string; permission: string; resultKey?: string; scopeIsTarget?: boolean; platformMedia?: boolean };
const operations = new Map<string, Definition>();
for (const [kind, table] of Object.entries({ items: "billable_item", rarities: "skin_rarity", categories: "skin_category", skins: "skin", entitlements: "entitlement", skin_owners: "skin_owner" })) {
  operations.set(`supply.catalog.${kind}.create`, { table, permission: ADMIN_PERMISSION.supplyCatalogManage });
  operations.set(`supply.catalog.${kind}.update`, { table, permission: ADMIN_PERMISSION.supplyCatalogManage, scopeIsTarget: true });
}
for (const kind of ["price", "term", "agreement", "full_payout_terms"]) {
  for (const action of ["create", "update", "seal"]) {
    operations.set(`supply.rules.${kind}_draft.${action}`, { table: `${kind}_version`, permission: ADMIN_PERMISSION.supplyRulesEdit, scopeIsTarget: action !== "create" });
  }
}
operations.set("supply.rules.release.activate", { table: "rule_release", permission: ADMIN_PERMISSION.supplyRulesEdit, resultKey: "releaseId" });
operations.set("supply.game.create", { table: "game", permission: ADMIN_PERMISSION.supplyCatalogManage });
operations.set("supply.game.update", { table: "game", permission: ADMIN_PERMISSION.supplyCatalogManage, scopeIsTarget: true });
operations.set("supply.media.upload_intent.create", { table: "media_upload_intent", permission: ADMIN_PERMISSION.supplyCatalogManage, resultKey: "intentId", platformMedia: true });
operations.set("supply.media.upload", { table: "media_upload_intent", permission: ADMIN_PERMISSION.supplyCatalogManage, scopeIsTarget: true, platformMedia: true });
for (const operation of ["review", "visibility"]) operations.set(`supply.media.${operation}`, { table: "media_asset", permission: ADMIN_PERMISSION.supplyReviewDecide, scopeIsTarget: true, platformMedia: true });

const safeFields = ["id", "intentId", "assetId", "releaseId", "revision", "generation", "status", "technicalState", "reviewState", "accessClass", "visibility", "expiresAt", "noop"];
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

export async function readAdminSupplyOperationResult(client: PoolClient, actorId: string, access: EffectiveAdminAccess, query: URLSearchParams, keyHeader: string | undefined) {
  for (const name of query.keys()) if (!["operation", "resourceId", "fingerprint"].includes(name) || query.getAll(name).length !== 1) throw invalid("Unsupported operation result query");
  const operation = query.get("operation") ?? "", definition = operations.get(operation);
  if (!definition) throw invalid("Operation does not support result recovery", "operation");
  requirePermission(access, definition.permission);
  const resourceId = query.has("resourceId") ? query.get("resourceId")! : undefined;
  if (resourceId !== undefined && !id(resourceId)) throw invalid("Invalid original resource", "resourceId");
  const fingerprint = query.get("fingerprint");
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) throw invalid("Original request fingerprint is required", "fingerprint");
  const key = validateIdempotencyKey(keyHeader);
  const row = (await client.query<{ requestFingerprint: string; responseStatus: number; responseBody: Record<string, unknown> }>(
    `SELECT request_fingerprint AS "requestFingerprint",response_status AS "responseStatus",response_body AS "responseBody"
       FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,
    [JSON.stringify(["admin", actorId, operation, resourceId ?? null]), key],
  )).rows[0];
  if (!row) return { receipt: "UNRESOLVED" as const };
  if (row.requestFingerprint !== fingerprint) throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Original request fingerprint does not match");
  const body = row.responseBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw notFound();
  const game = body.game as Record<string, unknown> | undefined;
  const targetId = definition.scopeIsTarget ? resourceId : body[definition.resultKey ?? "id"] ?? (definition.table === "game" ? game?.id : undefined);
  if (!id(targetId)) throw notFound();
  // Table names come only from the operation allowlist; cached bodies never choose a query.
  const target = (await client.query<{ gameId: string; ownershipKind?: string }>(
    `SELECT ${definition.table === "game" ? "id" : "game_id"} AS "gameId"${definition.platformMedia ? ',ownership_kind AS "ownershipKind"' : ""}
       FROM zzsh_supply.${definition.table} WHERE id=$1`, [targetId],
  )).rows[0];
  if (!target || (definition.platformMedia && target.ownershipKind !== "PLATFORM_CATALOG")) throw notFound();
  await assertGameScope(client, actorId, access.isBoss, target.gameId);
  const result: Record<string, string | number | boolean | null> = {};
  for (const name of safeFields) {
    const value = body[name];
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 160)) result[name] = value;
  }
  if (definition.table === "game") result.id = targetId;
  return { receipt: "RECORDED" as const, operation, resourceId: resourceId ?? null, responseStatus: row.responseStatus, result };
}
