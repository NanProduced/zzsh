import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { decodeId, requireOrigin, requestPath, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { authorizeLegacyContinuation, readLegacyContinuation, readLegacyContinuationBinding, readLegacyContinuationEvidence, readLegacyContinuationHead } from "./legacy-continuation-evidence";
import { applyLegacyContinuationCommand, applyLegacyDutyCommand, authorizeLegacyMutation, legacyCommandOutcome, parseLegacyMutation, parseLegacyQuantities, type LegacyMutationKind,type LegacyMutationAuthority } from "./legacy-continuation-command";
import { legacyOrderAdvisoryKey, previewLegacyContinuation, readSealedLegacyFacts, type LegacyContinuationActor, type LegacyDutyFinalizationReader } from "./legacy-continuation-model";

export type LegacyContinuationRouteOptions = AuthSecurityOptions & { legacyDutyFinalizationReader?: LegacyDutyFinalizationReader };
export function parseLegacyContinuationPath(path: string) {
  const match = /^\/legacy\/([^/]+)\/continuation(?:\/(receipt|preview|propose|confirm|reject|hold|release|confiscate)|\/duties\/([^/]+)\/(mature|void))?$/.exec(path);
  if (!match) return null;
  const orderId = decodeId(match[1]!); legacyOrderAdvisoryKey(orderId);
  const dutyId = match[3] ? decodeId(match[3]) : null;
  return { orderId, command: match[2] ?? null, dutyId, dutyCommand: match[4] as "mature" | "void" | undefined };
}
export async function handleLegacyContinuationRoute(request: SupplyNodeRequest, response: SupplyResponse, options: LegacyContinuationRouteOptions, realm: "user" | "admin"): Promise<boolean> {
  const prefix = realm === "user" ? "/api/v1/orders" : "/api/v1/admin/orders";
  const { path, query } = requestPath(request, prefix), parsed = parseLegacyContinuationPath(path);
  if (!parsed) return false;
  const method = (request.method ?? "GET").toUpperCase(), requestId = ensureApiV1RequestId(request);
  if ((parsed.command !== "receipt" && query.size) || method !== (parsed.command && parsed.command !== "receipt" || parsed.dutyId ? "POST" : "GET")) throw notFound();
  if (method !== "GET" && !requireOrigin(request, response, options, requestId)) return true;
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  const actor: LegacyContinuationActor = { realm, ...context, requestId };
  if (parsed.command === "receipt") {
    for (const key of query.keys()) if (!["key", "command", "dutyId"].includes(key) || query.getAll(key).length !== 1) throw invalid("Invalid receipt query");
    const key = validateIdempotencyKey(query.get("key") ?? undefined), command = query.get("command") ?? "", dutyId = query.get("dutyId");
    if (!["propose", "confirm", "reject", "hold", "release", "confiscate", "mature", "void"].includes(command)) throw invalid("Invalid original command");
    if (realm === "user" && ["hold", "release", "confiscate", "mature", "void"].includes(command)) throw notFound();
    const duty = command === "mature" || command === "void";
    if (duty ? realm !== "admin" || !dutyId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dutyId) : dutyId !== null) throw invalid("Invalid original duty");
    const data = await withTransaction(options.pool, async client => {
      await authorizeLegacyMutation(client, actor, parsed.orderId,true);
      if (duty && !(await client.query(`SELECT 1 FROM zzsh_order.legacy_order_duty WHERE id=$1 AND order_id=$2`, [dutyId, parsed.orderId])).rowCount) throw notFound();
      const operation = duty ? "order.legacy.duty." + command : "order.legacy.continuation." + command;
      const row = (await client.query<{ status: number; body: unknown; fingerprint: string }>(`SELECT response_status AS status,response_body AS body,request_fingerprint AS fingerprint FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`, [JSON.stringify([realm, actor.userId, operation, duty ? dutyId : parsed.orderId]), key])).rows[0];
      return row ? { state: row.status >= 200 && row.status < 300 ? "KNOWN_SUCCESS" : "KNOWN_REJECTED", status: row.status, receipt: row.body, fingerprint: row.fingerprint } : { state: "UNKNOWN" };
    });
    sendJson(response, 200, data, requestId); return true;
  }
  if (method === "GET") {
    const data = await withTransaction(options.pool, client => readLegacyContinuation(client, actor, parsed.orderId, options.legacyDutyFinalizationReader));
    sendJson(response, 200, data, requestId); return true;
  }
  const body = bodyOf(request);
  if (parsed.command === "preview") {
    ensureOnlyFields(body, ["quantities"]);
    const quantities = parseLegacyQuantities(body.quantities);
    const data = await withTransaction(options.pool, async client => {
      const binding = await readLegacyContinuationBinding(client, parsed.orderId);
      await authorizeLegacyContinuation(client, actor, binding);
      const head = await readLegacyContinuationHead(client, parsed.orderId), row = await readLegacyContinuationEvidence(client, parsed.orderId, head);
      if (!row) throw invalid("NOT_IMPORTED");
      return { ...previewLegacyContinuation(readSealedLegacyFacts(row), binding, actor, quantities), revision: head?.revision ?? null, inputEvidenceId: row.id };
    });
    sendJson(response, 200, data, requestId); return true;
  }
  if (parsed.dutyId && parsed.dutyCommand) {
    if (realm !== "admin") throw notFound();
    ensureOnlyFields(body, ["expectedRevision", "sourceFactAuditId", "reason"]);
    if (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision)) throw invalid("Invalid duty revision");
    if (body.sourceFactAuditId !== undefined && (typeof body.sourceFactAuditId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.sourceFactAuditId))) throw invalid("Invalid source evidence reference");
    if (body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) throw invalid("Invalid reason");
    const input = { dutyId: parsed.dutyId, kind: parsed.dutyCommand, expectedRevision: body.expectedRevision, sourceFactAuditId: body.sourceFactAuditId as string | undefined, reason: body.reason as string | undefined };
    let authority:LegacyMutationAuthority|undefined;
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.legacy.duty." + input.kind, resourceId: input.dutyId }, { realm, id: actor.userId, sessionId: actor.sessionId }, input,
      async(client,replay)=>{authority=await authorizeLegacyMutation(client,actor,parsed.orderId,!!replay);}, client => legacyCommandOutcome(client, actor, parsed.orderId, () => applyLegacyDutyCommand(client, actor, parsed.orderId, input,authority)));
    return true;
  }
  const input = parseLegacyMutation(parsed.command as LegacyMutationKind, body);
  let authority:LegacyMutationAuthority|undefined;
  await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.legacy.continuation." + input.kind, resourceId: parsed.orderId }, { realm, id: actor.userId, sessionId: actor.sessionId }, input,
    async(client,replay)=>{authority=await authorizeLegacyMutation(client,actor,parsed.orderId,!!replay);}, client => legacyCommandOutcome(client, actor, parsed.orderId, () => applyLegacyContinuationCommand(client, actor, parsed.orderId, input, options.legacyDutyFinalizationReader,authority)));
  return true;
}
