import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, requirePermission } from "../auth/admin-authorization";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { assertUserContextInTransaction, readUserContext } from "../auth/user-identity";
import { recordAudit, setAuditContext, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { canonicalize } from "../supply/content-hash";
import { decodeId, requireAdminAccess, safely, type SupplyResponse } from "../supply/supply-routes";
import { assertGameScope, bodyOf, ensureOnlyFields, forbidden, headerValue, invalid, notFound, requiredString, sendJson, sha256Hex, type SupplyNodeRequest } from "../supply/supply-util";
import {
  confirmBreach,
  decideRecovery,
  readCreditSnapshot,
  readGuaranteeContext,
  requestGuaranteeRefund,
  requestRecovery,
  reverseBreach,
  createGuaranteePaymentIntent,
  readGuaranteeTransactions,
  decideGuaranteeRefund,
} from "./credit-guarantee";

function originAllowed(request: SupplyNodeRequest, options: AuthSecurityOptions, admin: boolean): void {
  const origin = headerValue(request.headers.origin);
  const allowed = admin ? [options.apiOrigin, options.adminOrigin] : [options.apiOrigin, options.userOrigin];
  if (origin !== undefined && !allowed.includes(origin)) throw forbidden();
}

function pathOf(request: SupplyNodeRequest, prefix: string): { path: string; url: URL } {
  const url = new URL(request.originalUrl ?? request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === prefix) return { path: "/", url };
  if (!url.pathname.startsWith(`${prefix}/`)) return { path: "", url };
  return { path: url.pathname.slice(prefix.length), url };
}

function userEvent(event: Record<string, unknown>) {
  const { internalBasis: _internalBasis, actorAdminId: _actorAdminId, payloadHash: _payloadHash, ...visible } = event;
  return visible;
}

async function creditObligationReader(userId: string, client: PoolClient, configured: AuthSecurityOptions["userObligationReader"]): Promise<"NONE" | "PENDING" | "UNKNOWN"> {
  const listing = await client.query(`SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id WHERE a.owner_user_id=$1 AND v.review_state IN ('SUBMITTED','APPROVED','PUBLISHED') LIMIT 1`, [userId]);
  if (listing.rowCount) return "PENDING";
  const orders = await client.query(`SELECT 1 FROM zzsh_order.rental_order WHERE status IN ('PENDING_PAYMENT','PAID') AND (owner_user_id=$1 OR renter_user_id=$1) LIMIT 1`, [userId]);
  if (orders.rowCount) return "PENDING";
  return configured ? configured(userId, client) : "NONE";
}

async function ownedGuarantees(client: PoolClient, userId: string) {
  const accounts = (await client.query(`SELECT id,display_no AS "displayNo",game_id AS "gameId" FROM zzsh_supply.rental_account WHERE owner_user_id=$1 ORDER BY id`, [userId])).rows as Array<{ id: string; displayNo: string | null; gameId: string }>;
  const items = [];
  for (const account of accounts) {
    const context = await readGuaranteeContext(client, account.id, userId);
    if (!context) continue;
    items.push({ ...context, displayNo: account.displayNo });
  }
  return items.map(({ policy: _policy, ...item }) => item);
}

async function scopedGuarantees(client: PoolClient, userId: string, actor: { userId: string; isBoss: boolean }) {
  const accounts = (await client.query(`SELECT id,display_no AS "displayNo",game_id AS "gameId" FROM zzsh_supply.rental_account WHERE owner_user_id=$1 AND ($2::boolean OR EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$3 AND s.game_id=rental_account.game_id)) ORDER BY id`, [userId, actor.isBoss, actor.userId])).rows as Array<{ id: string; displayNo: string | null; gameId: string }>;
  const items = [];
  for (const account of accounts) { const context = await readGuaranteeContext(client, account.id, userId); if (context) items.push({ ...context, displayNo: account.displayNo }); }
  return items.map(({ policy: _policy, ...item }) => item);
}

async function assertCreditSourceScope(client: PoolClient, actor: { userId: string; isBoss: boolean }, input: { userId: string; sourceType: string; sourceId: string }): Promise<void> {
  const row = input.sourceType === "ACCOUNT"
    ? (await client.query<{ gameId: string }>(`SELECT game_id AS "gameId" FROM zzsh_supply.rental_account WHERE id=$1 AND owner_user_id=$2`, [input.sourceId, input.userId])).rows[0]
    : input.sourceType === "ORDER"
      ? (await client.query<{ gameId: string }>(`SELECT game_id AS "gameId" FROM zzsh_order.rental_order WHERE id=$1 AND (owner_user_id=$2 OR renter_user_id=$2)`, [input.sourceId, input.userId])).rows[0]
      : null;
  if (!row) throw notFound();
  await assertGameScope(client, actor.userId, actor.isBoss, row.gameId);
}

async function assertCreditUserScope(client: PoolClient, actor: { userId: string; isBoss: boolean }, userId: string): Promise<void> {
  if (actor.isBoss) return;
  const scoped = await client.query(`SELECT 1 FROM zzsh_supply.rental_account a WHERE a.owner_user_id=$1 AND EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$2 AND s.game_id=a.game_id) UNION ALL SELECT 1 FROM zzsh_order.rental_order o WHERE (o.owner_user_id=$1 OR o.renter_user_id=$1) AND EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$2 AND s.game_id=o.game_id) LIMIT 1`, [userId, actor.userId]);
  if (!scoped.rowCount) throw notFound();
}

async function readRecoveryRequests(client: PoolClient, userId: string) {
  return (await client.query(`SELECT id,status,reason,score_before AS "scoreBefore",completed_orders AS "completedOrders",decision_reason AS "decisionReason",created_at::text AS "createdAt",decided_at::text AS "decidedAt" FROM zzsh_credit.credit_recovery_request WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, [userId])).rows;
}

export function mountCreditGuaranteeRoutes(app: INestApplication, options: AuthSecurityOptions): void {
  const express = app.getHttpAdapter().getInstance();
  const userPrefixes = ["/api/v1/users/me/credit", "/api/bff/user/credit"];
  for (const prefix of userPrefixes) {
    express.use(prefix, (request: SupplyNodeRequest, response: SupplyResponse) => {
      const requestId = ensureApiV1RequestId(request);
      return safely(response, requestId, async () => {
        originAllowed(request, options, false);
        const { path, url } = pathOf(request, prefix);
        const method = (request.method ?? "GET").toUpperCase();
        const context = await readUserContext(request, options);
        const body = await withTransaction(options.pool, async (client) => {
          await assertUserContextInTransaction(client, context);
          if (method === "GET" && (path === "/" || path === "/overview")) {
            if (url.search) throw notFound();
            const credit = await readCreditSnapshot(client, context.userId, true);
            return { credit: credit ? { ...credit, events: credit.events.map((event) => userEvent(event as unknown as Record<string, unknown>)) } : null, recoveryRequests: await readRecoveryRequests(client, context.userId), guarantees: await ownedGuarantees(client, context.userId), transactions: await readGuaranteeTransactions(client, context.userId) };
          }
          if (method === "POST" && path === "/recovery-requests") {
            const input = bodyOf(request);
            ensureOnlyFields(input, ["reason"]);
            const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
            const result = await requestRecovery(client, { userId: context.userId, requestKey: key, requestFingerprint: sha256Hex(canonicalize(input)), reason: requiredString(input, "reason", 500), obligationReader: (userId, scopedClient) => creditObligationReader(userId, scopedClient, options.userObligationReader) });
            await recordAudit(client, { actorType: "user", actorId: context.userId, sessionId: context.sessionId, action: "credit.recovery.requested", objectType: "credit_recovery_request", objectId: String(result.requestId), outcome: "SUCCESS", requestId, reason: String(input.reason), details: { result: result.duplicate ? "REPLAY" : "APPLIED" } });
            return result;
          }
          const paymentMatch = /^\/accounts\/([^/]+)\/payment-intents$/.exec(path);
          if (method === "POST" && paymentMatch) {
            const input = bodyOf(request);
            ensureOnlyFields(input, []);
            const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
            const accountId = decodeId(paymentMatch[1]!);
            // The common function resolves accepted intent before any current-policy read.
            const result = await createGuaranteePaymentIntent(client, { accountId, context: null, userId: context.userId, requestKey: key, requestFingerprint: sha256Hex(canonicalize(input)) });
            await recordAudit(client, { actorType: "user", actorId: context.userId, sessionId: context.sessionId, action: "credit.guarantee.payment_intent_created", objectType: "owner_guarantee_payment", objectId: String(result.paymentId), outcome: "SUCCESS", requestId, details: { result: result.duplicate ? "REPLAY" : "APPLIED", providerAction: result.providerAction } });
            return result;
          }
          const refundMatch = /^\/guarantees\/([^/]+)\/refund-requests$/.exec(path);
          if (method === "POST" && refundMatch) {
            const input = bodyOf(request);
            ensureOnlyFields(input, []);
            const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
            const result = await requestGuaranteeRefund(client, { userId: context.userId, requirementId: decodeId(refundMatch[1]!), requestKey: key, requestFingerprint: sha256Hex(canonicalize(input)), obligationReader: (userId, scopedClient) => creditObligationReader(userId, scopedClient, options.userObligationReader) });
            await recordAudit(client, { actorType: "user", actorId: context.userId, sessionId: context.sessionId, action: "credit.guarantee.refund_requested", objectType: "owner_guarantee_refund", objectId: String(result.refundId), outcome: "SUCCESS", requestId, details: { result: result.duplicate ? "REPLAY" : "APPLIED", providerAction: result.providerAction } });
            return result;
          }
          throw notFound();
        });
        sendJson(response, 200, body, requestId);
      });
    });
  }

  const adminPrefixes = ["/api/v1/admin/credit", "/api/bff/admin/credit"];
  for (const prefix of adminPrefixes) {
    express.use(prefix, (request: SupplyNodeRequest, response: SupplyResponse) => {
      const requestId = ensureApiV1RequestId(request);
      return safely(response, requestId, async () => {
        originAllowed(request, options, true);
        const { path, url } = pathOf(request, prefix);
        const context = await readAdminContext(request, options);
        const body = await withTransaction(options.pool, async (client) => {
          await assertAdminContextInTransaction(client, context);
          const access = await requireAdminAccess(client, context.userId);
          const userMatch = /^\/users\/([^/]+)$/.exec(path);
          if (request.method === "GET" && userMatch) {
            requirePermission(access, ADMIN_PERMISSION.creditRead);
            const userId = decodeId(userMatch[1]!);
            await assertCreditUserScope(client, { userId: context.userId, isBoss: access.isBoss }, userId);
            const credit = await readCreditSnapshot(client, userId, false, { adminId: context.userId, isBoss: access.isBoss });
            const guaranteeReadable = access.permissions.has(ADMIN_PERMISSION.creditGuaranteeRead) || access.isBoss;
            return { credit, recoveryRequests: await readRecoveryRequests(client, userId), guarantees: guaranteeReadable ? await scopedGuarantees(client, userId, { userId: context.userId, isBoss: access.isBoss }) : [], transactions: guaranteeReadable ? await readGuaranteeTransactions(client, userId, { userId: context.userId, isBoss: access.isBoss }) : [] };
          }
          if (request.method === "GET" && path === "/guarantees") {
            requirePermission(access, ADMIN_PERMISSION.creditGuaranteeRead);
            const userId = url.searchParams.get("userId");
            if (!userId) throw invalid("userId is required");
            const targetUserId = decodeId(userId);
            await assertCreditUserScope(client, { userId: context.userId, isBoss: access.isBoss }, targetUserId);
            return { userId: targetUserId, guarantees: await scopedGuarantees(client, targetUserId, { userId: context.userId, isBoss: access.isBoss }) };
          }
          const breach = request.method === "POST" && path === "/breaches";
          if (breach) {
            requirePermission(access, ADMIN_PERMISSION.creditDecide);
            const input = bodyOf(request);
            ensureOnlyFields(input, ["userId", "sourceType", "sourceId", "subjectRole", "visibleReason", "internalBasis"]);
            const breachInput = { userId: requiredString(input, "userId", 128), sourceType: requiredString(input, "sourceType", 128), sourceId: requiredString(input, "sourceId", 128), subjectRole: input.subjectRole as "OWNER" | "RENTER", visibleReason: requiredString(input, "visibleReason", 500), internalBasis: requiredString(input, "internalBasis", 500), actorAdminId: context.userId };
            await assertCreditSourceScope(client, { userId: context.userId, isBoss: access.isBoss }, breachInput);
            const result = await confirmBreach(client, breachInput);
            await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "credit.breach.confirmed", objectType: "credit_event", objectId: result.event.id, outcome: "SUCCESS", requestId, reason: result.event.visibleReason, details: { result: result.duplicate ? "REPLAY" : "APPLIED", userId: result.event.userId, sourceType: result.event.sourceType, sourceId: result.event.sourceId } });
            return { ...result, event: userEvent(result.event as unknown as Record<string, unknown>) };
          }
          const reverse = request.method === "POST" && /^\/events\/[^/]+\/reverse$/.exec(path);
          if (reverse) {
            requirePermission(access, ADMIN_PERMISSION.creditDecide);
            const input = bodyOf(request);
            ensureOnlyFields(input, ["visibleReason", "internalBasis"]);
            const eventId = decodeId(path.split("/")[2]!);
            const source = (await client.query<{ userId: string; sourceType: string; sourceId: string }>(`SELECT user_id AS "userId",source_type AS "sourceType",source_id AS "sourceId" FROM zzsh_credit.credit_event WHERE id=$1 AND event_type='BREACH_CONFIRMED'`, [eventId])).rows[0];
            if (!source) throw notFound();
            await assertCreditSourceScope(client, { userId: context.userId, isBoss: access.isBoss }, source);
            const result = await reverseBreach(client, { eventId, visibleReason: requiredString(input, "visibleReason", 500), internalBasis: requiredString(input, "internalBasis", 500), actorAdminId: context.userId });
            await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "credit.breach.reversed", objectType: "credit_event", objectId: result.event.id, outcome: "SUCCESS", requestId, reason: result.event.visibleReason, details: { result: result.duplicate ? "REPLAY" : "APPLIED", reversalOfId: result.event.reversalOfId } });
            return { ...result, event: userEvent(result.event as unknown as Record<string, unknown>) };
          }
          const decision = request.method === "POST" && /^\/recovery-requests\/[^/]+\/decision$/.exec(path);
          if (decision) {
            requirePermission(access, ADMIN_PERMISSION.creditDecide);
            const input = bodyOf(request);
            ensureOnlyFields(input, ["decision", "reason"]);
            const requestOwner = (await client.query<{ userId: string }>(`SELECT user_id AS "userId" FROM zzsh_credit.credit_recovery_request WHERE id=$1`, [decodeId(path.split("/")[2]!)])).rows[0];
            if (!requestOwner) throw notFound();
            if (requestOwner.userId === context.userId) throw forbidden();
            await assertCreditUserScope(client, { userId: context.userId, isBoss: access.isBoss }, requestOwner.userId);
            const result = await decideRecovery(client, { requestId: decodeId(path.split("/")[2]!), actorAdminId: context.userId, decision: input.decision as "APPROVE" | "REJECT", reason: requiredString(input, "reason", 500), obligationReader: (userId, scopedClient) => creditObligationReader(userId, scopedClient, options.userObligationReader) });
            await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "credit.recovery.decided", objectType: "credit_recovery_request", objectId: String(result.requestId), outcome: "SUCCESS", requestId, reason: String(input.reason), details: { decision: result.status, result: result.duplicate ? "REPLAY" : "APPLIED" } });
            return result;
          }
          const releaseDecision = request.method === "POST" && /^\/guarantees\/[^/]+\/release-decision$/.exec(path);
          if (releaseDecision) {
            requirePermission(access, ADMIN_PERMISSION.creditGuaranteeManage);
            const input = bodyOf(request);
            ensureOnlyFields(input, ["decision", "reason"]);
            const refundId = decodeId(path.split("/")[2]!);
            const source = (await client.query<{ ownerUserId: string; gameId: string }>(`SELECT f.owner_user_id AS "ownerUserId",a.game_id AS "gameId" FROM zzsh_order.owner_guarantee_refund f JOIN zzsh_order.owner_guarantee_requirement r ON r.id=f.requirement_id JOIN zzsh_supply.rental_account a ON a.id=r.account_id WHERE f.id=$1`, [refundId])).rows[0];
            if (!source) throw notFound();
            await assertGameScope(client, context.userId, access.isBoss, source.gameId);
            const result = await decideGuaranteeRefund(client, { refundId, actorAdminId: context.userId, decision: input.decision as "APPROVE" | "REJECT", reason: requiredString(input, "reason", 500) });
            await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "credit.guarantee.release_decided", objectType: "owner_guarantee_refund", objectId: refundId, outcome: "SUCCESS", requestId, reason: String(input.reason), details: { decision: result.releasePolicyState, result: result.duplicate ? "REPLAY" : "APPLIED" } });
            return result;
          }
          throw notFound();
        });
        sendJson(response, 200, body, requestId);
      });
    });
  }
}
