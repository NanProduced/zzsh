import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";

import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "./admin-authorization";
import { assertGameScopeUsable, isAllGamesScope, readAdminGameScope, scopeAllowsGame } from "./admin-scope";
import { readUserContext } from "./user-identity";
import { recordAudit, setAuditContext, SecurityApiError, withTransaction } from "./security-core";
import { assertSealedRuleRelease } from "./membership-growth-approval";
import { assertReplayAuthorization } from "../order/order";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { decodeId, safely, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { backfillAcceptedSettlementAfterPosting, membershipGrowthEnabled, readMembershipGrowth, readMembershipGrowthScopeDetail } from "./membership-growth-integration";
import { canonicalize } from "../supply/content-hash";
import { GROWTH_THRESHOLDS, NORMAL_GROWTH_TIERS, validateBenefitPolicy, type GrowthBenefitPolicy } from "./membership-growth";

function originAllowed(request: SupplyNodeRequest, options: AuthSecurityOptions, admin: boolean): boolean {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  if (origin === undefined) return true;
  return origin === (admin ? options.adminOrigin : options.userOrigin) || origin === options.apiOrigin;
}

function bodyRecord(request: SupplyNodeRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Request body is invalid");
  return body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string, max = 512): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new SecurityApiError(400, "INVALID_ARGUMENT", `${field} is invalid`);
  return value;
}

function optionalText(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 128) throw new SecurityApiError(400, "INVALID_ARGUMENT", `${field} is invalid`);
  return value;
}

function policyCatalog(policy: GrowthBenefitPolicy | null, priceVersionId: string | null): { safeBoxes: string[]; materials: Array<{ id: string; name: string; unit: "ROUND" | "PIECE" | "DAY" }>; priceVersions: Array<{ id: string; label: string }> } {
  const ordinary = policy?.tiers.STANDARD.pricing.ordinary as unknown as Record<string, unknown> | undefined;
  const haff = ordinary?.haff && typeof ordinary.haff === "object" && !Array.isArray(ordinary.haff) && (ordinary.haff as Record<string, unknown>).status === "CONFIGURED" ? ordinary.haff as Record<string, unknown> : null;
  const safeBoxes = haff?.baseBySafeBox && typeof haff.baseBySafeBox === "object" && !Array.isArray(haff.baseBySafeBox) ? Object.keys(haff.baseBySafeBox).sort() : [];
  const materialsRaw = ordinary?.materials && typeof ordinary.materials === "object" && !Array.isArray(ordinary.materials) ? ordinary.materials as Record<string, unknown> : {};
  const materials = Object.values(materialsRaw).filter((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) return false; const row = item as Record<string, unknown>; return row.status === "CONFIGURED" && typeof row.itemId === "string" && ["ROUND", "PIECE", "DAY"].includes(String(row.unit)); }).map((item) => { const row = item as Record<string, unknown>; return { id: row.itemId as string, name: row.itemId as string, unit: row.unit as "ROUND" | "PIECE" | "DAY" }; }).sort((a, b) => a.id.localeCompare(b.id));
  return { safeBoxes, materials, priceVersions: priceVersionId ? [{ id: priceVersionId, label: priceVersionId }] : [] };
}

export async function handleMembershipGrowthPolicyAdmin(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    if (!originAllowed(request, options, true) || (request.method !== "GET" && !membershipGrowthEnabled())) throw notFound();
    const path = (request.originalUrl ?? request.url ?? "").split("?", 1)[0] ?? "";
    const context = await readAdminContext(request, options);
    if (request.method === "POST" && path === "/api/v1/admin/membership-growth/backfill") {
      const body = bodyRecord(request);
      if (Object.keys(body).some((key) => key !== "orderId")) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Request body is invalid");
      const orderId = requiredText(body, "orderId");
      await withTransaction(options.pool, async (client) => {
        await assertAdminContextInTransaction(client, context);
        const access = await loadEffectiveAdminAccess(client, context.userId);
        if (!access || (!access.isBoss && !hasPermission(access, ADMIN_PERMISSION.membershipGrowthBackfill))) throw forbidden();
        const order = (await client.query<{ gameId: string }>(`SELECT game_id AS "gameId" FROM zzsh_order.rental_order WHERE id=$1`, [orderId])).rows[0];
        if (!order) throw notFound();
        if (!access.isBoss && !scopeAllowsGame(await readAdminGameScope(client, context.userId), false, order.gameId)) throw forbidden();
      });
      const result = await backfillAcceptedSettlementAfterPosting(options.pool, orderId, { source: "ADMIN_MAINTENANCE", realm: "admin", userId: context.userId, sessionId: context.sessionId }, requestId);
      sendJson(response, 200, { orderId, ...result }, requestId);
      return;
    }
    if (request.method === "GET" && path === "/api/v1/admin/membership-growth/policy") {
      const result = await withTransaction(options.pool, async (client) => {
        await assertAdminContextInTransaction(client, context);
        const access = await loadEffectiveAdminAccess(client, context.userId);
        if (!hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft) && !hasPermission(access, ADMIN_PERMISSION.membershipPolicyPublish) && !hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead)) throw forbidden();
        const row = (await client.query<{ id: string; version: string; status: string; effectiveAt: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; payloadHash: string; policyPayload: GrowthBenefitPolicy }>(
          `SELECT id, version::text AS version, status, effective_at AS "effectiveAt", rule_release_id AS "ruleReleaseId", price_version_id AS "priceVersionId", source_ref AS "sourceRef", payload_hash AS "payloadHash", policy_payload AS "policyPayload"
             FROM zzsh_iam.membership_growth_policy ORDER BY version DESC, created_at DESC LIMIT 1`,
        )).rows[0];
        return row ? { policy: row.policyPayload, meta: { id: row.id, version: row.version, status: row.status, effectiveAtUtc: row.effectiveAt, ruleReleaseId: row.ruleReleaseId, priceVersionId: row.priceVersionId, sourceRef: row.sourceRef, payloadHash: row.payloadHash }, catalog: policyCatalog(row.policyPayload, row.priceVersionId), thresholds: Object.fromEntries(NORMAL_GROWTH_TIERS.map((tier) => [tier, GROWTH_THRESHOLDS[tier].toString()])) } : { policy: null, meta: null, catalog: policyCatalog(null, null), thresholds: Object.fromEntries(NORMAL_GROWTH_TIERS.map((tier) => [tier, GROWTH_THRESHOLDS[tier].toString()])) };
      });
      sendJson(response, 200, result, requestId);
      return;
    }
    if (request.method !== "POST" || path !== "/api/v1/admin/membership-growth/policy-drafts") throw notFound();
    const body = bodyRecord(request);
    const policy = body.policy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "policy is invalid");
    if ((policy as Record<string, unknown>).status !== "DRAFT") throw new SecurityApiError(400, "INVALID_ARGUMENT", "policy.status must be DRAFT");
    const validation = validateBenefitPolicy(policy as GrowthBenefitPolicy);
    if (!validation.valid) throw new SecurityApiError(409, "CONFLICT", validation.errors.join(","));
    const versionNo = body.versionNo;
    if (typeof versionNo !== "number" || !Number.isSafeInteger(versionNo) || versionNo < 1) throw new SecurityApiError(400, "INVALID_ARGUMENT", "versionNo is invalid");
    const ruleReleaseId = requiredText(body, "ruleReleaseId");
    const priceVersionId = requiredText(body, "priceVersionId");
    const sourceRef = requiredText(body, "sourceRef", 200);
    const expectedVersion = body.expectedVersion;
    const effectiveAtUtc = optionalText(body, "effectiveAtUtc");
    const digest = createHash("sha256").update(canonicalize({ schema: "membership-growth-draft-v1", policy, versionNo, ruleReleaseId, priceVersionId, sourceRef, effectiveAtUtc })).digest("hex");
    const draftId = `growth_policy_draft_${digest.slice(0, 40)}`;
    const result = await withTransaction(options.pool, async (client) => {
      await assertAdminContextInTransaction(client, context);
      const access = await loadEffectiveAdminAccess(client, context.userId);
      if (!hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft)) throw forbidden();
      await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId);
      const current = (await client.query<{ version: string }>(`SELECT version::text AS version FROM zzsh_iam.membership_growth_policy ORDER BY version DESC LIMIT 1`)).rows[0];
      if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || expectedVersion !== (current?.version ?? "0"))) throw new SecurityApiError(409, "CONFLICT", "Membership policy version changed");
      await client.query(
        `INSERT INTO zzsh_iam.membership_growth_policy (id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash)
         VALUES ($1,$2,'DRAFT',$3::timestamptz,$4,$5,$6,'membership-growth-v1',$7::jsonb,$8)
         ON CONFLICT (id) DO NOTHING`,
        [draftId, versionNo, effectiveAtUtc, ruleReleaseId, priceVersionId, sourceRef, JSON.stringify(policy), digest],
      );
      await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "membership.policy.draft.saved", objectType: "membership_growth_policy", objectId: draftId, outcome: "SUCCESS", requestId, details: { version: versionNo, payloadHash: digest } });
      return { id: draftId, version: String(versionNo), status: "DRAFT", payloadHash: digest, publishable: validation.publishable, warnings: validation.warnings };
    });
    sendJson(response, 200, result, requestId);
  });
}

export async function handleMembershipGrowthUser(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    if (request.method !== "GET" || (request.originalUrl ?? request.url ?? "").split("?", 1)[0] !== "/api/v1/users/me/membership-growth") throw notFound();
    const context = await readUserContext(request, options);
    const result = await withTransaction(options.pool, async (client) => {
      await assertReplayAuthorization(client, context);
      return readMembershipGrowth(client, context.userId);
    });
    if (!result) throw notFound();
    sendJson(response, 200, result, requestId);
  });
}

export async function handleMembershipGrowthAdmin(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    if (request.method !== "GET" || !originAllowed(request, options, true)) throw notFound();
    const path = (request.originalUrl ?? request.url ?? "").split("?", 1)[0] ?? "";
    const match = /^\/api\/v1\/admin\/users\/([^/]+)\/membership-growth$/.exec(path);
    if (!match) throw notFound();
    const subjectId = decodeId(match[1]!);
    const context = await readAdminContext(request, options);
    const result = await withTransaction(options.pool, async (client) => {
      await assertAdminContextInTransaction(client, context);
      const access = await loadEffectiveAdminAccess(client, context.userId);
      if (hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead)) {
        const subject = await readMembershipGrowth(client, subjectId);
        if (!subject) throw notFound();
        return { ...subject, authorizationState: "SUMMARY_AUTHORIZED" as const };
      }
      if (!hasPermission(access, ADMIN_PERMISSION.membershipGrowthDetailRead)) throw forbidden();
      const scope = await readAdminGameScope(client, context.userId);
      assertGameScopeUsable(scope, false);
      const gameIds = isAllGamesScope(scope)
        ? (await client.query<{ gameId: string }>(`SELECT id AS "gameId" FROM zzsh_supply.game ORDER BY id`)).rows.map((row) => row.gameId)
        : scope.gameIds;
      return readMembershipGrowthScopeDetail(client, subjectId, gameIds);
    });
    sendJson(response, 200, result, requestId);
  });
}

export function mountMembershipGrowthRoutes(app: INestApplication, options: AuthSecurityOptions): void {
  const express = app.getHttpAdapter().getInstance();
  express.use("/api/v1/users/me/membership-growth", (request: SupplyNodeRequest, response: SupplyResponse) => handleMembershipGrowthUser(request, response, options));
  express.use("/api/v1/admin/users", (request: SupplyNodeRequest, response: SupplyResponse) => handleMembershipGrowthAdmin(request, response, options));
  express.use("/api/v1/admin/membership-growth", (request: SupplyNodeRequest, response: SupplyResponse) => handleMembershipGrowthPolicyAdmin(request, response, options));
}
