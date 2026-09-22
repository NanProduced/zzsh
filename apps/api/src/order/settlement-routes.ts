import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson } from "../supply/supply-util";
import { decodeId, requireOrigin, requestPath, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import {
  adjustSettlement,
  classifySettlement,
  confirmOpening,
  decideSettlement,
  previewSettlement,
  previewStaffSettlement,
  projectSettlementResponse,
  readSettlement,
  recheckSettlement,
  recordOpening,
  reviewSettlement,
  settlementSurfaceOpen,
  submitSettlement,
} from "./settlement-record";

type Options = AuthSecurityOptions & { settlementRecordingEnabled?: boolean };
type Request = Parameters<typeof requestPath>[0];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function idOf(value: string): string {
  const id = decodeId(value);
  if (!ID.test(id)) throw invalid("Invalid identifier");
  return id;
}

function linesOf(body: Record<string, unknown>, field: "quantity" | "remainingQuantity"): Array<{ itemId: string; quantity: string }> {
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 64) throw invalid("Lines are invalid", "lines");
  return lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw invalid("Lines are invalid", "lines");
    const row = line as Record<string, unknown>;
    ensureOnlyFields(row, ["itemId", field]);
    if (typeof row.itemId !== "string" || !ID.test(row.itemId)) throw invalid("Invalid identifier", "itemId");
    if (typeof row[field] !== "string" || !/^(0|[1-9]\d{0,18})$/.test(row[field])) throw invalid("Quantity is invalid", field);
    return { itemId: row.itemId, quantity: row[field] };
  });
}

function hashOf(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw invalid("Version hash is invalid", field);
  return value;
}

export async function handleSettlementUserRoute(request: Request, response: SupplyResponse, options: Options): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase();
  const { path } = requestPath(request, "/api/v1/orders");
  const preview = /^\/([A-Za-z0-9._:-]+)\/settlement-preview$/.exec(path);
  const submit = /^\/([A-Za-z0-9._:-]+)\/settlements$/.exec(path);
  const decision = /^\/([A-Za-z0-9._:-]+)\/settlements\/([A-Za-z0-9._:-]+)\/decision$/.exec(path);
  const opening = /^\/([A-Za-z0-9._:-]+)\/openings\/([A-Za-z0-9._:-]+)\/confirm$/.exec(path);
  const read = /^\/([A-Za-z0-9._:-]+)\/settlement$/.exec(path);
  if (!preview && !submit && !decision && !opening && !read) return false;
  if (!settlementSurfaceOpen(options.settlementRecordingEnabled)) throw notFound();
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (method !== "GET" && !requireOrigin(request, response, options, requestId)) return true;
  const context = await readUserContext(request, options);
  const actor = { realm: "user" as const, userId: context.userId, sessionId: context.sessionId };
  if (method === "GET" && read) {
    const result = await withTransaction(options.pool, async (client) => projectSettlementResponse(client, actor, await readSettlement(client, idOf(read[1]!), actor)));
    sendJson(response, result.status, result.body, requestId);
    return true;
  }
  if (method === "POST" && preview) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines"]);
    const result = await withTransaction(options.pool, async (client) => projectSettlementResponse(
      client, actor, await previewSettlement(client, idOf(preview[1]!), actor, linesOf(body, "remainingQuantity")),
    ));
    sendJson(response, result.status, result.body, requestId);
    return true;
  }
  const orderId = idOf((submit ?? decision ?? opening)![1]!);
  if (method === "POST" && submit) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines", "acceptedHash"]);
    const remaining = linesOf(body, "remainingQuantity");
    const acceptedHash = hashOf(body, "acceptedHash");
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.settlement.submit", resourceId: orderId },
      { realm: "user", id: actor.userId, sessionId: actor.sessionId }, { lines: remaining, acceptedHash },
      async (client) => { await recheckSettlement(client, orderId, actor); },
      (client) => submitSettlement(client, orderId, actor, remaining, acceptedHash, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  if (method === "POST" && decision) {
    const versionId = idOf(decision[2]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["action", "versionHash", "reason"]);
    if (body.action !== "CONFIRM" && body.action !== "REJECT") throw invalid("Action is invalid", "action");
    const versionHash = hashOf(body, "versionHash");
    let reason: string | null = null;
    if (body.reason !== undefined) {
      if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) throw invalid("Reason is invalid", "reason");
      reason = body.reason.trim();
    }
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.settlement.decide", resourceId: versionId },
      { realm: "user", id: actor.userId, sessionId: actor.sessionId }, { action: body.action, versionHash, reason },
      async (client, replay) => { await recheckSettlement(client, orderId, actor, replay !== null); },
      (client) => decideSettlement(client, orderId, versionId, actor, body.action as "CONFIRM" | "REJECT", versionHash, reason, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  if (method === "POST" && opening) {
    const openingId = idOf(opening[2]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["versionNo"]);
    if (typeof body.versionNo !== "number" || !Number.isInteger(body.versionNo) || body.versionNo < 1) throw invalid("Version is invalid", "versionNo");
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.opening.confirm", resourceId: openingId },
      { realm: "user", id: actor.userId, sessionId: actor.sessionId }, { versionNo: body.versionNo },
      async (client) => { await recheckSettlement(client, orderId, actor); },
      (client) => confirmOpening(client, orderId, openingId, body.versionNo as number, actor, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  throw notFound();
}

export async function handleSettlementAdminRoute(request: Request, response: SupplyResponse, options: Options): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase();
  const { path } = requestPath(request, "/api/v1/admin/orders");
  const read = /^\/([A-Za-z0-9._:-]+)\/settlement$/.exec(path);
  const preview = /^\/([A-Za-z0-9._:-]+)\/settlement-preview$/.exec(path);
  const openings = /^\/([A-Za-z0-9._:-]+)\/openings$/.exec(path);
  const classify = /^\/([A-Za-z0-9._:-]+)\/settlements\/classify$/.exec(path);
  const review = /^\/([A-Za-z0-9._:-]+)\/settlements\/([A-Za-z0-9._:-]+)\/review$/.exec(path);
  const adjust = /^\/([A-Za-z0-9._:-]+)\/settlements\/adjustments$/.exec(path);
  if (!read && !preview && !openings && !classify && !review && !adjust) return false;
  if (!settlementSurfaceOpen(options.settlementRecordingEnabled)) throw notFound();
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (method !== "GET" && !requireOrigin(request, response, options, requestId)) return true;
  const context = await readAdminContext(request, options);
  const actor = { realm: "admin" as const, userId: context.userId, sessionId: context.sessionId };
  const orderId = idOf((read ?? preview ?? openings ?? classify ?? review ?? adjust)![1]!);
  if (method === "POST" && preview) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines", "endReason", "proposedOwnerNet", "proposedRenterRefund", "reason"]);
    const endReason = body.endReason === undefined || body.endReason === null ? null : body.endReason;
    if (endReason !== null && endReason !== "TENANT_VOLUNTARY_EARLY" && endReason !== "OWNER_OR_ACCOUNT_EARLY") throw invalid("End reason is invalid", "endReason");
    const earlyReason = endReason as "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY" | null;
    const result = await withTransaction(options.pool, async (client) => projectSettlementResponse(client, actor, await previewStaffSettlement(client, orderId, actor, {
      remaining: linesOf(body, "remainingQuantity"),
      endReason: earlyReason,
      ...(typeof body.proposedOwnerNet === "string" ? { proposedOwnerNet: body.proposedOwnerNet } : {}),
      ...(typeof body.proposedRenterRefund === "string" ? { proposedRenterRefund: body.proposedRenterRefund } : {}),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    })));
    sendJson(response, result.status, result.body, requestId);
    return true;
  }
  if (method === "GET" && read) {
    const result = await withTransaction(options.pool, async (client) => projectSettlementResponse(client, actor, await readSettlement(client, orderId, actor)));
    sendJson(response, result.status, result.body, requestId);
    return true;
  }
  if (method === "POST" && openings) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines"]);
    const lines = linesOf(body, "quantity");
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.opening.record", resourceId: orderId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, { lines },
      async (client) => { await recheckSettlement(client, orderId, actor); },
      (client) => recordOpening(client, orderId, actor, lines, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  if (method === "POST" && classify) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines", "endReason", "acceptedHash"]);
    if (body.endReason !== "TENANT_VOLUNTARY_EARLY" && body.endReason !== "OWNER_OR_ACCOUNT_EARLY") throw invalid("End reason is invalid", "endReason");
    const remaining = linesOf(body, "remainingQuantity");
    const acceptedHash = hashOf(body, "acceptedHash");
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.settlement.classify", resourceId: orderId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, { lines: remaining, endReason: body.endReason, acceptedHash },
      async (client) => { await recheckSettlement(client, orderId, actor); },
      (client) => classifySettlement(client, orderId, actor, remaining, body.endReason as "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY", acceptedHash, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  if (method === "POST" && review) {
    const versionId = idOf(review[2]!);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["versionHash"]);
    const versionHash = hashOf(body, "versionHash");
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.settlement.review", resourceId: versionId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, { versionHash },
      async (client, replay) => { await recheckSettlement(client, orderId, actor, replay !== null); },
      (client) => reviewSettlement(client, orderId, versionId, actor, versionHash, requestId),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  if (method === "POST" && adjust) {
    const body = bodyOf(request);
    ensureOnlyFields(body, ["lines", "endReason", "proposedOwnerNet", "proposedRenterRefund", "reason", "acceptedHash"]);
    if (body.endReason !== undefined && body.endReason !== null && body.endReason !== "TENANT_VOLUNTARY_EARLY" && body.endReason !== "OWNER_OR_ACCOUNT_EARLY") {
      throw invalid("End reason is invalid", "endReason");
    }
    if (typeof body.proposedOwnerNet !== "string" || typeof body.proposedRenterRefund !== "string" || typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.length > 500) {
      throw invalid("Adjustment is invalid");
    }
    const remaining = linesOf(body, "remainingQuantity");
    const acceptedHash = hashOf(body, "acceptedHash");
    const endReason = body.endReason === undefined || body.endReason === null ? null : body.endReason;
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.settlement.adjust", resourceId: orderId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId },
      { lines: remaining, endReason, proposedOwnerNet: body.proposedOwnerNet, proposedRenterRefund: body.proposedRenterRefund, reason: body.reason.trim(), acceptedHash },
      async (client) => { await recheckSettlement(client, orderId, actor); },
      (client) => adjustSettlement(client, orderId, actor, {
        remaining, endReason, proposedOwnerNet: body.proposedOwnerNet as string, proposedRenterRefund: body.proposedRenterRefund as string,
        reason: (body.reason as string).trim(), acceptedHash, requestId,
      }),
      (client, result) => projectSettlementResponse(client, actor, result));
    return true;
  }
  throw notFound();
}
