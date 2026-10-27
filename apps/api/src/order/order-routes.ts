import { readOrderPaymentSummary, type ChannelPaymentReadOptions } from "./channel-payment-read";
import type { INestApplication } from "@nestjs/common";
import type { DistributionEarningStore } from "../finance/distribution-earning-store";
import { listUnifiedUserOrders, parseUnifiedOrderQuery } from "./unified-user-order-read";
import { getUserLegacyOrder, listUserLegacyOrders, parseLegacyUserOrderQuery } from "./legacy-user-order-read";
import type { OrderImSdkRouteBindings } from "../config/config";
import { readOrderTeamAccess, listJoinedOrderTeams } from "../im/order-team-access";
import { parseRfc3339Timestamp } from "../content/content";
import { queryAdminReadOrders, getAdminReadOrder, parseOrderOrigin, type OrderReadFilters } from "./admin-order-read";

import { ADMIN_PERMISSION, requirePermission } from "../auth/admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, readAdminGameScope } from "../auth/admin-scope";
import { readAdminContext, assertAdminContextInTransaction, type AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { humanText } from "../supply/content-hash";
import { unknownSupplyGate, type SupplyGateReader } from "../supply/publishing";
import { readOrderAccountViews } from "../supply/admin-supervision-read";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import type { OrderAccountViewReader } from "./admin-order-read";
import {
  assertGameScope,
  bodyOf,
  ensureOnlyFields,
  invalid,
  notFound,
  optionalTrimmedString,
  sendJson,
  sha256Hex,
  type SupplyNodeRequest,
} from "../supply/supply-util";
import {
  decodeId,
  requireAdminAccess,
  requireOrigin,
  requestPath,
  runIdempotentWrite,
  safely,
  type SupplyResponse,
} from "../supply/supply-routes";
import { handleSettlementAdminRoute, handleSettlementUserRoute } from "./settlement-routes";
import { handleLegacyContinuationRoute } from "./legacy-continuation-routes";
import type { LegacyDutyFinalizationReader } from "./legacy-continuation-model";
import {
  assertFreshCreateAuthorization,
  assertReplayAuthorization,
  cancelReservation,
  createReservation,
  getAdminOrder,
  getMyOrder,
  listAdminOrders,
  listMyOrders,
  ORDER_STATUS,
  type OrderStatus,
} from "./order";

/** 订单读注入账号视图读取：同一事务快照内按账号页口径读公开版本 */
const orderAccountViews=(options:OrderRuntimeOptions):OrderAccountViewReader=>(client,ids)=>readOrderAccountViews(client,ids,options.supplyGateReader??unknownSupplyGate,options.legacyPublicAdmission,options.legacyPublicAdmissionDetail);
export type OrderRuntimeOptions = AuthSecurityOptions & {
  channelPaymentReadOptions?: ChannelPaymentReadOptions;
  distributionEarnings?: DistributionEarningStore;
  legacyDutyFinalizationReader?: LegacyDutyFinalizationReader;
  orderHoldSeconds?: number;
  supplyGateReader?: SupplyGateReader;
  /** 订单关联账号与账号页同一公开口径所需的旧平台准入（可缺省） */
  legacyPublicAdmission?: LegacyPublicAdmission;
  legacyPublicAdmissionDetail?: LegacyPublicAdmissionDetailIndex;
  orderImSdkRouteBindings?: OrderImSdkRouteBindings;
  /** Explicit controlled-test switch. Production leaves it unset. */
  settlementRecordingEnabled?: boolean;
};

export type OrderResponse = SupplyResponse;

const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function idField(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_TOKEN.test(value)) throw invalid("Invalid identifier", path);
  return value;
}

function parseStatus(raw: string | null): OrderStatus | undefined {
  if (raw === null) return undefined;
  if (raw === ORDER_STATUS.PENDING_PAYMENT || raw === ORDER_STATUS.CANCELLED || raw === ORDER_STATUS.PAID || raw === ORDER_STATUS.COMPLETED) return raw;
  throw invalid("Status is invalid");
}

function parseLimit(raw: string | null): number {
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

const ORDER_PAGE_QUERY_KEYS = ["page","pageSize","status","origin","createdFrom","createdTo","qKind","qValue","restoreKey","view"] as const;
/** The numbered list is the admin read contract: every filter is parsed before the count/page query. */
export function parseAdminOrderPageQuery(query: URLSearchParams): OrderReadFilters {
  for (const key of query.keys()) if (!ORDER_PAGE_QUERY_KEYS.includes(key as typeof ORDER_PAGE_QUERY_KEYS[number]) || query.getAll(key).length !== 1) throw invalid("Unsupported order page query", key);
  const positive=(name:string,fallback:number,max:number)=>{const text=query.get(name);if(text===null)return fallback;if(!/^[1-9]\d{0,6}$/.test(text)||Number(text)>max)throw invalid("Page argument is invalid",name);return Number(text);};
  const qKind=query.get("qKind")??"order";
  if(!["order","account","party","renter","owner"].includes(qKind))throw invalid("Lookup kind is invalid");
  const qValue=query.get("qValue");if(qValue!==null&&(!qValue.trim()||qValue.length>255||/[\x00-\x1f\x7f]/.test(qValue)))throw invalid("Lookup value is invalid");
  const view=query.get("view");if(view!==null&&view!=="list")throw invalid("View is invalid","view");
  const restoreKey=query.get("restoreKey");if(restoreKey!==null&&!/^[a-f0-9]{64}$/.test(restoreKey))throw invalid("Restore key is invalid");
  return {page:positive("page",1,1000000),pageSize:positive("pageSize",20,100),qKind:qKind as OrderReadFilters["qKind"],...(qValue!==null?{qValue:qValue.trim()}:{}),...parseCreatedRange(query),...(query.has("status")?{status:parseStatus(query.get("status"))}:{}),...(query.has("origin")?{origin:parseOrderOrigin(query)}:{}) ,...(restoreKey?{restoreKey}:{}),...(view==="list"?{view:"list" as const}:{})};
}
function parseCreatedRange(query: URLSearchParams): { createdFrom?: string; createdTo?: string } {
  const fromRaw = query.get("createdFrom");
  const toRaw = query.get("createdTo");
  const from = fromRaw === null ? null : parseRfc3339Timestamp(fromRaw, "createdFrom");
  const to = toRaw === null ? null : parseRfc3339Timestamp(toRaw, "createdTo");
  if (from && to && from.date.getTime() > to.date.getTime()) {
    throw invalid("createdFrom must not be after createdTo", "createdFrom");
  }
  return {
    ...(from ? { createdFrom: from.text } : {}),
    ...(to ? { createdTo: to.text } : {}),
  };
}

export async function handleOrderUserRoute(
  request: Parameters<typeof requestPath>[0],
  response: OrderResponse,
  options: OrderRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/orders");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (await handleLegacyContinuationRoute(request, response, options, "user")) return;
    if (path === "/unified") {
      if (method !== "GET") throw notFound();
      const context = await readUserContext(request, options);
      const filter = parseUnifiedOrderQuery(query);
      const data = await withTransaction(options.pool, async client => {
        await assertReplayAuthorization(client, context);
        return listUnifiedUserOrders(client, context.userId, filter);
      });
      sendJson(response, 200, data, requestId);
      return;
    }
    const legacyMatch = /^\/legacy(?:\/([A-Za-z0-9._:-]+))?$/.exec(path);
    if (legacyMatch) {
      if (method !== "GET") throw notFound();
      const context = await readUserContext(request, options);
      const orderId = legacyMatch[1];
      if (orderId && query.size !== 0) throw invalid("Order detail does not accept query fields");
      const filter = orderId ? null : parseLegacyUserOrderQuery(query);
      const data = await withTransaction(options.pool, async client => {
        await assertReplayAuthorization(client, context);
        return orderId ? getUserLegacyOrder(client, context.userId, decodeId(orderId)) : listUserLegacyOrders(client, context.userId, filter!);
      });
      sendJson(response, 200, data, requestId);
      return;
    }
    if (await handleSettlementUserRoute(request, response, options)) return;
    if (method === "POST" && path === "/") {
      if (!requireOrigin(request, response, options, requestId)) return;
      const context = await readUserContext(request, options);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["accountId", "versionId", "releaseId"]);
      const accountId = idField(body.accountId, "accountId");
      const versionId = idField(body.versionId, "versionId");
      const releaseId = idField(body.releaseId, "releaseId");
      const gate = options.supplyGateReader ?? unknownSupplyGate;
      await runIdempotentWrite(
        options,
        request,
        response,
        requestId,
        { principalId: context.userId, operation: "order.reservation.create", resourceId: accountId },
        { realm: "user", id: context.userId, sessionId: context.sessionId },
        { accountId, versionId, releaseId },
        async (client, replay) => {
          if (replay) await assertReplayAuthorization(client, context);
          else await assertFreshCreateAuthorization(client, context, accountId);
        },
        async (client) => {
          const account = (
            await client.query<{ ownerUserId: string; gameId: string }>(
              `SELECT owner_user_id AS "ownerUserId", game_id AS "gameId" FROM zzsh_supply.rental_account WHERE id = $1`,
              [accountId],
            )
          ).rows[0];
          if (!account) throw notFound();
          return createReservation(client, {
            context,
            accountId,
            versionId,
            releaseId,
            ownerUserId: account.ownerUserId,
            gameId: account.gameId,
            holdSeconds: options.orderHoldSeconds,
            gate,
            requestId,
          });
        },
      );
      return;
    }

    const cancelMatch = /^\/([A-Za-z0-9._:-]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      if (!requireOrigin(request, response, options, requestId)) return;
      const context = await readUserContext(request, options);
      const orderId = decodeId(cancelMatch[1]!);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["reason"]);
      const reason = optionalTrimmedString(body, "reason", 500);
      await runIdempotentWrite(
        options,
        request,
        response,
        requestId,
        { principalId: context.userId, operation: "order.reservation.cancel", resourceId: orderId },
        { realm: "user", id: context.userId, sessionId: context.sessionId },
        { orderId, ...(reason !== undefined ? { reason: humanText(reason) } : {}) },
        async (client) => {
          await assertReplayAuthorization(client, context);
        },
        async (client) =>
          cancelReservation(client, {
            context,
            orderId,
            ...(reason !== undefined ? { reason: humanText(reason) } : {}),
            requestId,
          }),
      );
      return;
    }

    if (method === "GET" && path === "/") {
      const context = await readUserContext(request, options);
      const partyRaw = query.get("party") ?? "renter";
      if (partyRaw !== "renter" && partyRaw !== "owner") throw invalid("Party is invalid");
      const status = parseStatus(query.get("status"));
      const accountIdRaw = query.get("accountId");
      if (accountIdRaw !== null && !ID_TOKEN.test(accountIdRaw)) throw invalid("Account is invalid");
      const data = await withTransaction(options.pool, async (client) => {
        await assertReplayAuthorization(client, context);
        return listMyOrders(client, context.userId, {
          party: partyRaw,
          ...(status !== undefined ? { status } : {}),
          ...(accountIdRaw !== null ? { accountId: accountIdRaw } : {}),
          limit: parseLimit(query.get("limit")),
          ...(query.get("cursor") !== null ? { cursor: query.get("cursor")! } : {}),
        });
      });
      sendJson(response, 200, data, requestId);
      return;
    }

    const teamMatch = /^\/([A-Za-z0-9._:-]+)\/im$/.exec(path);
    if(method==="GET"&&teamMatch){
      const context=await readUserContext(request,options);
      const operation=query.get("operation")??"read";if(operation!=="read"&&operation!=="send")throw invalid("Operation is invalid");
      const data=await withTransaction(options.pool,c=>readOrderTeamAccess(c,{...context,realm:"user"},decodeId(teamMatch[1]!),operation,options.orderImSdkRouteBindings));
      sendJson(response,200,data,requestId);return;
    }
    const detailMatch = /^\/([A-Za-z0-9._:-]+)$/.exec(path);
    if (method === "GET" && detailMatch) {
      const context = await readUserContext(request, options);
      const orderId = decodeId(detailMatch[1]!);
      const data = await withTransaction(options.pool, async (client) => {
        await assertReplayAuthorization(client, context);
        return getMyOrder(client, context.userId, orderId);
      });
      sendJson(response, 200, data, requestId);
      return;
    }

    throw notFound();
  });
}

export async function handleOrderAdminRoute(
  request: Parameters<typeof requestPath>[0],
  response: OrderResponse,
  options: OrderRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  const { path, query } = requestPath(request, "/api/v1/admin/orders");
  const method = (request.method ?? "GET").toUpperCase();

  await safely(response, requestId, async () => {
    if (await handleLegacyContinuationRoute(request, response, options, "admin")) return;
    if (await handleSettlementAdminRoute(request, response, options)) return;
    if (method !== "GET") throw notFound();
    const context = await readAdminContext(request, options);
    await withTransaction(options.pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertAdminContextInTransaction(client, context);
      if(path==="/im-groups"){
        const cursor=query.get("cursor");if(cursor&&!ID_TOKEN.test(cursor))throw invalid("Cursor is invalid");
        sendJson(response,200,await listJoinedOrderTeams(client,{...context,realm:"admin"},cursor,parseLimit(query.get("limit"))),requestId);return;
      }
      const teamMatch=/^\/([A-Za-z0-9._:-]+)\/im$/.exec(path);
      if(teamMatch){const operation=query.get("operation")??"read";if(operation!=="read"&&operation!=="send")throw invalid("Operation is invalid");sendJson(response,200,await readOrderTeamAccess(client,{...context,realm:"admin"},decodeId(teamMatch[1]!),operation,options.orderImSdkRouteBindings),requestId);return;}
      const access = await requireAdminAccess(client, context.userId);
      requirePermission(access, ADMIN_PERMISSION.orderRead);
      const gameScope = await readAdminGameScope(client, context.userId);
      assertGameScopeUsable(gameScope, access.isBoss);
      const admin = {
        adminId: context.userId,
        isBoss: access.isBoss,
        internalQuote: access.permissions.has("supply.quote.internal.read"),
        financeReadable: access.permissions.has(ADMIN_PERMISSION.financeRead),
        permissions: access.permissions,
        authorizationKey: sha256Hex(JSON.stringify([context.userId,context.sessionId,access.isBoss,[...access.permissions].sort(),gameScopeSignature(gameScope)])),
      };
      if (path === "/") {
        if (query.has("page")) {
          sendJson(response,200,await queryAdminReadOrders(client,admin,parseAdminOrderPageQuery(query),orderAccountViews(options)),requestId);return;
        }
        const status = parseStatus(query.get("status"));
        const accountIdRaw = query.get("accountId");
        if (accountIdRaw !== null && !ID_TOKEN.test(accountIdRaw)) throw invalid("Account is invalid");
        const gameIdRaw = query.get("gameId");
        if (gameIdRaw !== null && !ID_TOKEN.test(gameIdRaw)) throw invalid("Game is invalid");
        const displayNoRaw = query.get("displayNo");
        if (displayNoRaw !== null && !ID_TOKEN.test(displayNoRaw)) throw invalid("Display number is invalid", "displayNo");
        const renterUserIdRaw = query.get("renterUserId");
        if (renterUserIdRaw !== null && !ID_TOKEN.test(renterUserIdRaw)) throw invalid("Renter user ID is invalid", "renterUserId");
        const ownerUserIdRaw = query.get("ownerUserId");
        if (ownerUserIdRaw !== null && !ID_TOKEN.test(ownerUserIdRaw)) throw invalid("Owner user ID is invalid", "ownerUserId");
        const createdRange = parseCreatedRange(query);
        const data = await listAdminOrders(client, admin, {
          ...(status !== undefined ? { status } : {}),
          ...(accountIdRaw !== null ? { accountId: accountIdRaw } : {}),
          ...(gameIdRaw !== null ? { gameId: gameIdRaw } : {}),
          ...(displayNoRaw !== null ? { displayNo: displayNoRaw } : {}),
          ...(renterUserIdRaw !== null ? { renterUserId: renterUserIdRaw } : {}),
          ...(ownerUserIdRaw !== null ? { ownerUserId: ownerUserIdRaw } : {}),
          ...createdRange,
          limit: parseLimit(query.get("limit")),
          ...(query.get("cursor") !== null ? { cursor: query.get("cursor")! } : {}),
        });
        sendJson(response, 200, data, requestId);
        return;
      }
      const detailMatch = /^\/([A-Za-z0-9._:-]+)$/.exec(path);
      if (!detailMatch) throw notFound();
      if(detailMatch[1]!.startsWith("legacy_order_")||query.get("readMode")==="combined") {sendJson(response,200,await getAdminReadOrder(client,admin,decodeId(detailMatch[1]!),options.channelPaymentReadOptions,orderAccountViews(options)),requestId);return;}
      const orderId=decodeId(detailMatch[1]!);
      const data = await getAdminOrder(client, admin, orderId, assertGameScope);
      const paymentSummary=await readOrderPaymentSummary(client,{orderId,origin:"NATIVE",financeReadable:admin.financeReadable},options.channelPaymentReadOptions);
      sendJson(response, 200, {...data,contextKey:admin.authorizationKey,paymentSummary}, requestId);
    });
  });
}

export function mountOrderHandlers(app: INestApplication, options: OrderRuntimeOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: never, response: OrderResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/v1/orders", (request, response) => handleOrderUserRoute(request, response, options));
  expressApp.use("/api/v1/admin/orders", (request, response) => handleOrderAdminRoute(request, response, options));
}

export function mountUserOrderBff(app: INestApplication, options: OrderRuntimeOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: SupplyNodeRequest, response: OrderResponse) => Promise<void>) => void;
  };
  expressApp.use("/api/bff/user/orders", (request, response) => {
    const raw = request.originalUrl ?? request.url ?? "/";
    const suffix = raw.startsWith("/api/bff/user/orders") ? raw.slice("/api/bff/user/orders".length) : raw;
    request.url = "/api/v1/orders" + suffix;
    request.originalUrl = request.url;
    return handleOrderUserRoute(request, response, options);
  });
}
