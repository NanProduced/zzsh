import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { INestApplication } from "@nestjs/common";

import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "./admin-authorization";
import { assertGameScopeUsable, isAllGamesScope, readAdminGameScope, scopeAllowsGame } from "./admin-scope";
import { readUserContext } from "./user-identity";
import { recordAudit, setAuditContext, SecurityApiError, withTransaction } from "./security-core";
import { assertSealedRuleRelease, type SealedReleaseFacts } from "./membership-growth-approval";
import { assertReplayAuthorization } from "../order/order";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { decodeId, safely, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { backfillAcceptedSettlementAfterPosting, membershipGrowthEnabled, parseGrowthConsumptionQuery, readMembershipGrowth, readMembershipGrowthConsumption, readMembershipGrowthScopeDetail } from "./membership-growth-integration";
import { canonicalize } from "../supply/content-hash";
import { GROWTH_THRESHOLDS, NORMAL_GROWTH_TIERS, sealedEnabledRentalModes, validateBenefitPolicy, type GrowthBenefitPolicy } from "./membership-growth";
import { normalizeUnifiedMembershipPolicy, projectUnifiedMembershipPricing } from "./membership-unified-pricing";
import { parseMembershipEntitlementQuery, readApprovedMembershipPolicy, readMembershipEntitlementContext, readMembershipEntitlementOptions, readMembershipEntitlements } from "./membership-entitlement-read";
import { canSimulateMembershipProfit, readMembershipProfitSimulation, readMembershipProfitSimulationContext } from "./membership-profit-simulation";

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
  const ordinary = policy?.tiers?.STANDARD?.pricing?.ordinary as unknown as Record<string, unknown> | undefined;
  const haff = ordinary?.haff && typeof ordinary.haff === "object" && !Array.isArray(ordinary.haff) && (ordinary.haff as Record<string, unknown>).status === "CONFIGURED" ? ordinary.haff as Record<string, unknown> : null;
  const safeBoxes = haff?.baseBySafeBox && typeof haff.baseBySafeBox === "object" && !Array.isArray(haff.baseBySafeBox) ? Object.keys(haff.baseBySafeBox).sort() : [];
  const materialsRaw = ordinary?.materials && typeof ordinary.materials === "object" && !Array.isArray(ordinary.materials) ? ordinary.materials as Record<string, unknown> : {};
  const materials = Object.values(materialsRaw).filter((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) return false; const row = item as Record<string, unknown>; return row.status === "CONFIGURED" && typeof row.itemId === "string" && ["ROUND", "PIECE", "DAY"].includes(String(row.unit)); }).map((item) => { const row = item as Record<string, unknown>; return { id: row.itemId as string, name: row.itemId as string, unit: row.unit as "ROUND" | "PIECE" | "DAY" }; }).sort((a, b) => a.id.localeCompare(b.id));
  return { safeBoxes, materials, priceVersions: priceVersionId ? [{ id: priceVersionId, label: priceVersionId }] : [] };
}

/** Read-only release facts for the Admin editor; an unreadable binding falls back to the policy payload. */
async function sealedFactsOrNull(client: PoolClient, ruleReleaseId: string, priceVersionId: string): Promise<SealedReleaseFacts | null> {
  try { return await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId); } catch { return null; }
}

function bootstrapCatalog(sealed: SealedReleaseFacts, priceVersionId: string): ReturnType<typeof policyCatalog> {
  return {
    safeBoxes: sealed.catalog.safeBoxes,
    materials: sealed.catalog.materials.map((material) => ({ id: material.itemId, name: material.name ?? material.itemId, unit: material.unit ?? "PIECE", ...(material.unitQuantity === undefined ? {} : { unitQuantity: material.unitQuantity }) })),
    priceVersions: [{ id: priceVersionId, label: priceVersionId }],
  };
}

export async function handleMembershipGrowthPolicyAdmin(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    if (!originAllowed(request, options, true) || (request.method !== "GET" && !membershipGrowthEnabled())) throw notFound();
    const path = (request.originalUrl ?? request.url ?? "").split("?", 1)[0] ?? "";
    const context = await readAdminContext(request, options);
    if (request.method === "POST" && path === "/api/v1/admin/membership-growth/profit-simulation"
      || request.method === "GET" && path === "/api/v1/admin/membership-growth/profit-simulation-context") {
      const result = await withTransaction(options.pool, async client => {
        await client.query("SET TRANSACTION READ ONLY");
        await assertAdminContextInTransaction(client, context);
        const access = await loadEffectiveAdminAccess(client, context.userId);
        if (!access || !canSimulateMembershipProfit(access)) throw forbidden();
        const viewer = { adminId: context.userId, access };
        if (request.method === "POST") return readMembershipProfitSimulation(client, viewer, bodyRecord(request));
        const query = new URL(request.originalUrl ?? request.url ?? "", "http://127.0.0.1").searchParams;
        for (const key of query.keys()) if (!["ruleReleaseId", "priceVersionId"].includes(key) || query.getAll(key).length !== 1) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Simulation context query is invalid");
        return readMembershipProfitSimulationContext(client, viewer, query.get("ruleReleaseId") ?? "", query.get("priceVersionId") ?? "");
      });
      sendJson(response, 200, result, requestId);
      return;
    }
    if (request.method === "GET" && ["entitlements", "entitlement-context", "entitlement-options"].some(name => path === `/api/v1/admin/membership-growth/${name}`)) {
      const query = new URL(request.originalUrl ?? request.url ?? "", "http://127.0.0.1").searchParams;
      const result = await withTransaction(options.pool, async (client) => {
        await assertAdminContextInTransaction(client, context);
        const access = await loadEffectiveAdminAccess(client, context.userId);
        if (!access || access.status !== "ACTIVE") throw forbidden();
        const viewer = { adminId: context.userId, access };
        if (path.endsWith("/entitlement-options")) {
          if ([...query.keys()].length) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Entitlement options do not accept query parameters");
          return readMembershipEntitlementOptions(client, viewer);
        }
        if (path.endsWith("/entitlements")) return readMembershipEntitlements(client, viewer, parseMembershipEntitlementQuery(query));
        for (const key of query.keys()) if (!["userId", "gameId"].includes(key) || query.getAll(key).length !== 1) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Entitlement context query is invalid");
        return readMembershipEntitlementContext(client, viewer, query.get("userId") ?? "", query.get("gameId") ?? "");
      });
      sendJson(response, 200, result, requestId);
      return;
    }
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
        const approved = await readApprovedMembershipPolicy(client);
        const approvedFields = {
          approvedPolicy: approved?.policy ?? null,
          approvedUnifiedPricing: projectUnifiedMembershipPricing(approved?.policy ?? null, approved ? sealedEnabledRentalModes(approved.haffRule) : null),
          approvedMeta: approved ? { id: approved.id, version: approved.version, status: "APPROVED", effectiveAtUtc: approved.effectiveAtUtc, ruleReleaseId: approved.ruleReleaseId, priceVersionId: approved.priceVersionId, sourceRef: approved.sourceRef, payloadHash: approved.payloadHash } : null,
          capability: { canDraft: access?.isBoss === true || hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft), canChangeEntitlementRanges: access?.isBoss === true || hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft), canRequestEntitlement: access?.isBoss === true || hasPermission(access, ADMIN_PERMISSION.approvalRequestCreate) && hasPermission(access, ADMIN_PERMISSION.membershipEntitlementRequest), depositAllowanceSupported: true, unifiedPricingSupported: true, canSimulateProfit: canSimulateMembershipProfit(access) },
        };
        const thresholds = Object.fromEntries(NORMAL_GROWTH_TIERS.map((tier) => [tier, GROWTH_THRESHOLDS[tier].toString()]));
        const row = (await client.query<{ id: string; version: string; status: string; effectiveAt: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; payloadHash: string; policyPayload: GrowthBenefitPolicy }>(
          `SELECT id, version::text AS version, status, effective_at AS "effectiveAt", rule_release_id AS "ruleReleaseId", price_version_id AS "priceVersionId", source_ref AS "sourceRef", payload_hash AS "payloadHash", policy_payload AS "policyPayload"
             FROM zzsh_iam.membership_growth_policy ORDER BY version DESC, created_at DESC LIMIT 1`,
        )).rows[0];
        if (row) {
          // R1-03: an existing draft keeps the bound sealed catalog for editing; a pending payload must
          // never collapse the editor to 0 boxes / 0 resources. An unreadable release is labelled, not faked.
          const sealed = await sealedFactsOrNull(client, row.ruleReleaseId, row.priceVersionId);
          const catalog = sealed
            ? { ...bootstrapCatalog(sealed, row.priceVersionId), enabledModes: sealed.enabledModes, haffSchema: sealed.haffSchema, releaseMode: sealed.releaseMode, catalogSource: "SEALED" as const }
            : { ...policyCatalog(row.policyPayload, row.priceVersionId), releaseMode: null, catalogSource: "POLICY_PAYLOAD" as const };
          return { ...approvedFields, policy: row.policyPayload, unifiedPricing: projectUnifiedMembershipPricing(row.policyPayload, sealed?.enabledModes ?? null), meta: { id: row.id, version: row.version, status: row.status, effectiveAtUtc: row.effectiveAt, ruleReleaseId: row.ruleReleaseId, priceVersionId: row.priceVersionId, sourceRef: row.sourceRef, payloadHash: row.payloadHash }, catalog, thresholds, bootstrap: null };
        }
        const sealedRelease = (await client.query<{ releaseId: string; priceVersionId: string }>(
          `SELECT r.id AS "releaseId", r.price_version_id AS "priceVersionId"
             FROM zzsh_supply.rule_release r JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
            WHERE p.status='SEALED'
            ORDER BY (EXISTS (SELECT 1 FROM zzsh_supply.game g WHERE g.current_release_id=r.id AND g.enabled)) DESC, r.created_at DESC, r.id DESC
            LIMIT 1`,
        )).rows[0];
        const sealed = sealedRelease ? await sealedFactsOrNull(client, sealedRelease.releaseId, sealedRelease.priceVersionId) : null;
        if (!sealed) return { ...approvedFields, policy: null, unifiedPricing: projectUnifiedMembershipPricing(null, null), meta: null, catalog: { ...policyCatalog(null, null), releaseMode: null, catalogSource: null }, thresholds, bootstrap: null };
        return {
          ...approvedFields,
          policy: null,
          unifiedPricing: projectUnifiedMembershipPricing(null, sealed.enabledModes),
          meta: null,
          catalog: { ...bootstrapCatalog(sealed, sealedRelease!.priceVersionId), enabledModes: sealed.enabledModes, haffSchema: sealed.haffSchema, releaseMode: sealed.releaseMode, catalogSource: "SEALED" as const },
          thresholds,
          bootstrap: { ruleReleaseId: sealedRelease!.releaseId, priceVersionId: sealedRelease!.priceVersionId, haffSchema: sealed.haffSchema, releaseMode: sealed.releaseMode, enabledModes: sealed.enabledModes, nextVersionNo: 1, expectedVersion: "0" },
        };
      });
      sendJson(response, 200, result, requestId);
      return;
    }
    if (request.method !== "POST" || path !== "/api/v1/admin/membership-growth/policy-drafts") throw notFound();
    const body = bodyRecord(request);
    const requestedPolicy = body.policy;
    if (!requestedPolicy || typeof requestedPolicy !== "object" || Array.isArray(requestedPolicy)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "policy is invalid");
    if ((requestedPolicy as Record<string, unknown>).status !== "DRAFT") throw new SecurityApiError(400, "INVALID_ARGUMENT", "policy.status must be DRAFT");
    const versionNo = body.versionNo;
    if (typeof versionNo !== "number" || !Number.isSafeInteger(versionNo) || versionNo < 1) throw new SecurityApiError(400, "INVALID_ARGUMENT", "versionNo is invalid");
    const ruleReleaseId = requiredText(body, "ruleReleaseId");
    const priceVersionId = requiredText(body, "priceVersionId");
    const sourceRef = requiredText(body, "sourceRef", 200);
    const expectedVersion = body.expectedVersion;
    const effectiveAtUtc = optionalText(body, "effectiveAtUtc");
    const result = await withTransaction(options.pool, async (client) => {
      await assertAdminContextInTransaction(client, context);
      const access = await loadEffectiveAdminAccess(client, context.userId);
      if (!hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft)) throw forbidden();
      const sealed = await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId);
      let policy = requestedPolicy as GrowthBenefitPolicy;
      if (body.unifiedPricing !== undefined) {
        try { policy = normalizeUnifiedMembershipPolicy(policy, body.unifiedPricing, { enabledModes: sealed.enabledModes, priceVersionId }); }
        catch (error) { if (error instanceof TypeError) throw new SecurityApiError(400, "INVALID_ARGUMENT", error.message); throw error; }
      }
      const validation = validateBenefitPolicy(policy as GrowthBenefitPolicy, { enabledModes: sealed.enabledModes, catalog: sealed.catalog, releaseMode: sealed.releaseMode });
      if (!validation.valid) throw new SecurityApiError(409, "CONFLICT", validation.errors.join(","));
      const unifiedPricing = projectUnifiedMembershipPricing(policy, sealed.enabledModes);
      const publishable = validation.publishable && unifiedPricing.knowledge === "KNOWN";
      const digest = createHash("sha256").update(canonicalize({ schema: "membership-growth-draft-v1", policy, versionNo, ruleReleaseId, priceVersionId, sourceRef, effectiveAtUtc })).digest("hex");
      const draftId = `growth_policy_draft_${digest.slice(0, 40)}`;
      const current = (await client.query<{ version: string; policyPayload: GrowthBenefitPolicy }>(`SELECT version::text AS version,policy_payload AS "policyPayload" FROM zzsh_iam.membership_growth_policy ORDER BY version DESC,created_at DESC LIMIT 1`)).rows[0];
      if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || expectedVersion !== (current?.version ?? "0"))) throw new SecurityApiError(409, "CONFLICT", "Membership policy version changed");
      await client.query(
        `INSERT INTO zzsh_iam.membership_growth_policy (id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash)
         VALUES ($1,$2,'DRAFT',$3::timestamptz,$4,$5,$6,'membership-growth-v1',$7::jsonb,$8)
         ON CONFLICT (id) DO NOTHING`,
        [draftId, versionNo, effectiveAtUtc, ruleReleaseId, priceVersionId, sourceRef, JSON.stringify(policy), digest],
      );
      await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
      await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "membership.policy.draft.saved", objectType: "membership_growth_policy", objectId: draftId, outcome: "SUCCESS", requestId, details: { version: versionNo, payloadHash: digest } });
      return { id: draftId, version: String(versionNo), status: "DRAFT", payloadHash: digest, publishable, unifiedPricing, warnings: [...validation.warnings, ...(unifiedPricing.knowledge === "KNOWN" ? [] : ["UNIFIED_PRICING_REQUIRED"])] };
    });
    sendJson(response, 200, result, requestId);
  });
}

export async function handleMembershipGrowthUser(request: SupplyNodeRequest, response: SupplyResponse, options: AuthSecurityOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "", "http://127.0.0.1");
    const detail = url.pathname === "/api/v1/users/me/membership-growth/consumption";
    if (request.method !== "GET" || !detail && url.pathname !== "/api/v1/users/me/membership-growth") throw notFound();
    const query = detail ? parseGrowthConsumptionQuery(url.searchParams) : null;
    const context = await readUserContext(request, options);
    const result = await withTransaction(options.pool, async (client) => {
      await assertReplayAuthorization(client, context);
      return query ? readMembershipGrowthConsumption(client, context.userId, query) : readMembershipGrowth(client, context.userId);
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
