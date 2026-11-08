import { readOrderPaymentSummary, type ChannelPaymentReadOptions } from "./channel-payment-read";
import type { INestApplication } from "@nestjs/common";
import type { DistributionEarningStore } from "../finance/distribution-earning-store";
import type {LocalFinancialSandbox} from '../finance/local-financial-sandbox-resource';
import type {DemoFinanceResource} from '../finance/ecs-test-demo-resource';
import { listUnifiedUserOrders, parseUnifiedOrderQuery } from "./unified-user-order-read";
import { getUserLegacyOrder, listUserLegacyOrders, parseLegacyUserOrderQuery } from "./legacy-user-order-read";
import { compensationOrderBasis, readCompensationCases } from '../finance/order-compensation-approval';
import type { OrderImSdkRouteBindings } from "../config/config";
import type { ImMessageTransport } from "../im/im-contract";
import type { YunxinOrderTeamApi } from "../im/yunxin-provider";
import { assertOrderTeamInviteAccess, inviteOrderTeamAdmin, listOrderTeamInviteTargets } from "../im/order-team-invite";
import { assertManualCloseAccess, manualCloseOrder } from "./manual-close";
import { listJoinedOrderTeams } from "../im/order-team-access";
import { assertLegacyOrderTeamRequest, requestLegacyOrderTeam, listJoinedLegacyOrderTeams, readAnyOrderTeamAccess as readOrderTeamAccess } from "../im/legacy-order-team";
import { parseRfc3339Timestamp } from "../content/content";
import { queryAdminReadOrders, getAdminReadOrder, parseOrderOrigin, type OrderReadFilters } from "./admin-order-read";

import { ADMIN_PERMISSION, hasPermission, requirePermission } from "../auth/admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, readAdminGameScope } from "../auth/admin-scope";
import { readAdminContext, assertAdminContextInTransaction, type AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { readPersonalNativeRefunds } from "../finance/personal-refund-read";
import { readOwnerRefundMinimalSummary } from "../finance/owner-refund-summary-read";
import { withTransaction, SecurityApiError } from "../auth/security-core";
import { ensureApiV1RequestId, API_V1_ERROR_CODES } from "../contracts/api-v1";
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
import { handlePrestartTerminationRoute } from "./prestart-termination-routes";
import { handleSupportCancelAdminRoute } from "./support-cancel-routes";
import { handleSupportUnpaidCancelRoute } from "./support-unpaid-cancel-routes";
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
  /** Explicit server-only local capability; never parsed from client actors/bodies. */
  localFinancialSandbox?:LocalFinancialSandbox;
  ecsTestDemo?:DemoFinanceResource;
  channelPaymentReadOptions?: ChannelPaymentReadOptions;
  distributionEarnings?: DistributionEarningStore;
  legacyDutyFinalizationReader?: LegacyDutyFinalizationReader;
  legacyRefund?:import('./legacy-continuation-routes').LegacyContinuationRouteOptions['legacyRefund'];
  orderHoldSeconds?: number;
  supplyGateReader?: SupplyGateReader;
  /** 订单关联账号与账号页同一公开口径所需的旧平台准入（可缺省） */
  legacyPublicAdmission?: LegacyPublicAdmission;
  legacyPublicAdmissionDetail?: LegacyPublicAdmissionDetailIndex;
  orderImSdkRouteBindings?: OrderImSdkRouteBindings;
  /** Present only when order Teams are configured; the invite path never creates a Team. */
  orderTeamMembers?: { appId: string; provider: Pick<YunxinOrderTeamApi, "readOrderTeam"|"addSupportTeamMember">; wake?:()=>void };
  /** Explicit controlled-test switch. Production leaves it unset. */
  settlementRecordingEnabled?: boolean;
  /** Local/test system text seam; a production NIM implementation remains later work. */
  systemMessageTransport?: Pick<ImMessageTransport, "sendText">;
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

const ORDER_PAGE_QUERY_KEYS = ["page","pageSize","status","origin","createdFrom","createdTo","paymentConfirmedFrom","paymentConfirmedTo","paidFrom","paidTo","paymentOpen","qKind","qValue","restoreKey","view","fundsResolution"] as const;
function parseRecordedPaymentRange(query: URLSearchParams) {
  const from=parseRfc3339Timestamp(query.get("paidFrom"),"paidFrom"),to=parseRfc3339Timestamp(query.get("paidTo"),"paidTo");
  const micros=(point:NonNullable<typeof from>)=>{
    const fraction=point.text.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]??"";
    if(fraction.length>6)throw invalid("Paid range precision exceeds microseconds");
    return BigInt(point.date.getTime())*1000n+BigInt(fraction.padEnd(6,"0").slice(3));
  };
  const start=from?micros(from):null,end=to?micros(to):null;
  if(start!==null&&end!==null&&start>=end)throw invalid("Paid range is invalid");
  return {...(from?{paidFrom:from.text}:{}),...(to?{paidTo:to.text}:{})};
}
/** The numbered list is the admin read contract: every filter is parsed before the count/page query. */
export function parseAdminOrderPageQuery(query: URLSearchParams): OrderReadFilters {
  for (const key of query.keys()) if (!ORDER_PAGE_QUERY_KEYS.includes(key as typeof ORDER_PAGE_QUERY_KEYS[number]) || query.getAll(key).length !== 1) throw invalid("Unsupported order page query", key);
  const positive=(name:string,fallback:number,max:number)=>{const text=query.get(name);if(text===null)return fallback;if(!/^[1-9]\d{0,6}$/.test(text)||Number(text)>max)throw invalid("Page argument is invalid",name);return Number(text);};
  const qKind=query.get("qKind")??"order";
  if(!["order","account","party","renter","owner"].includes(qKind))throw invalid("Lookup kind is invalid");
  const qValue=query.get("qValue");if(qValue!==null&&(!qValue.trim()||qValue.length>255||/[\x00-\x1f\x7f]/.test(qValue)))throw invalid("Lookup value is invalid");
  const view=query.get("view");if(view!==null&&view!=="list")throw invalid("View is invalid","view");
  const fundsResolution=query.get("fundsResolution");if(fundsResolution!==null&&fundsResolution!=="MANUAL_CLOSE")throw invalid("Funds resolution is invalid","fundsResolution");
  const paymentOpen=query.get("paymentOpen");if(paymentOpen!==null&&paymentOpen!=="true")throw invalid("Payment-open filter is invalid","paymentOpen");
  const paidFromRaw=query.get("paymentConfirmedFrom"),paidToRaw=query.get("paymentConfirmedTo");
  const paidFrom=paidFromRaw===null?undefined:parseRfc3339Timestamp(paidFromRaw,"paymentConfirmedFrom");
  const paidTo=paidToRaw===null?undefined:parseRfc3339Timestamp(paidToRaw,"paymentConfirmedTo");
  if(paidFrom&&paidTo&&paidFrom.date.getTime()>=paidTo.date.getTime())throw invalid("Payment-confirmed range is invalid");
  if(query.get("origin")==="LEGACY"&&(paymentOpen||paidFrom||paidTo))throw invalid("Payment filters apply to native orders only");
  const restoreKey=query.get("restoreKey");if(restoreKey!==null&&!/^[a-f0-9]{64}$/.test(restoreKey))throw invalid("Restore key is invalid");
  return {page:positive("page",1,1000000),pageSize:positive("pageSize",20,100),qKind:qKind as OrderReadFilters["qKind"],...(qValue!==null?{qValue:qValue.trim()}:{}),...parseCreatedRange(query),...parseRecordedPaymentRange(query),...(query.has("status")?{status:parseStatus(query.get("status"))}:{}),...(query.has("origin")?{origin:parseOrderOrigin(query)}:{}) ,...(restoreKey?{restoreKey}:{}),...(view==="list"?{view:"list" as const}:{}),...(fundsResolution?{fundsResolution:"MANUAL_CLOSE" as const}:{}),...(paymentOpen?{paymentOpen:true as const}:{}),...(paidFrom?{paymentConfirmedFrom:paidFrom.text}:{}),...(paidTo?{paymentConfirmedTo:paidTo.text}:{})};
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
    if(method==="GET"&&path==="/legacy-im-groups"){
      const team=options.orderTeamMembers;if(!team)throw new SecurityApiError(503,API_V1_ERROR_CODES.IM_UNAVAILABLE,"客服群暂不可用");
      for(const key of query.keys())if(!["party","cursor","limit"].includes(key)||query.getAll(key).length!==1)throw invalid("Query is invalid",key);
      const party=query.get("party");if(party!=="renter"&&party!=="owner")throw invalid("Party is invalid","party");
      const cursor=query.get("cursor");if(cursor&&!/^legacy_order_[a-f0-9]{40}$/.test(cursor))throw invalid("Cursor is invalid","cursor");
      const context=await readUserContext(request,options);
      const data=await withTransaction(options.pool,c=>listJoinedLegacyOrderTeams(c,{...context,realm:"user"},team.appId,party,cursor,parseLimit(query.get("limit"))));
      sendJson(response,200,data,requestId);return;
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
    if (await handlePrestartTerminationRoute(request, response, options, "user")) return;
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
    const refundMatch = /^\/([A-Za-z0-9._:-]+)\/refunds$/.exec(path);
    if (method === "GET" && refundMatch) {
      if (query.size) throw invalid("Refund read does not accept query fields");
      const context = await readUserContext(request, options), orderId = decodeId(refundMatch[1]!);
      const data = await withTransaction(options.pool, async client => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const party = (await client.query<{ renter: string; owner: string }>(
          `SELECT renter_user_id AS renter, owner_user_id AS owner FROM zzsh_order.rental_order WHERE id=$1`,
          [orderId],
        )).rows[0];
        if (!party) throw notFound();
        if (party.owner === context.userId) return readOwnerRefundMinimalSummary(client, context, { orderId });
        return readPersonalNativeRefunds(client, context, { orderId }, options.localFinancialSandbox ?? options.ecsTestDemo);
      });
      sendJson(response, 200, data, requestId); return;
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
    if (await handlePrestartTerminationRoute(request, response, options, "admin")) return;
    if (await handleSettlementAdminRoute(request, response, options)) return;
    const supportUnpaidCancel = /^\/([A-Za-z0-9._:-]+)\/support-unpaid-cancel$/.exec(path);
    if (supportUnpaidCancel) {
      await handleSupportUnpaidCancelRoute(request, response, options, decodeId(supportUnpaidCancel[1]!), query, method);
      return;
    }
    const supportCancel = /^\/([A-Za-z0-9._:-]+)\/support-cancel$/.exec(path);
    if (supportCancel) {
      await handleSupportCancelAdminRoute(request, response, options, decodeId(supportCancel[1]!), query, method);
      return;
    }
    const legacyTeam = /^\/(legacy_order_[a-f0-9]{40})\/create-team$/.exec(path);
    if(method==="POST"&&legacyTeam){
      if(!requireOrigin(request,response,options,requestId))return;
      const team=options.orderTeamMembers;if(!team)throw new SecurityApiError(503,API_V1_ERROR_CODES.IM_UNAVAILABLE,"客服群暂不可用");
      const body=bodyOf(request);ensureOnlyFields(body,[]);
      const context=await readAdminContext(request,options),actor={userId:context.userId,sessionId:context.sessionId},orderId=legacyTeam[1]!;
      await runIdempotentWrite(options,request,response,requestId,
        {principalId:actor.userId,operation:"im.order.legacy_team.create",resourceId:orderId},
        {realm:"admin",id:actor.userId,sessionId:actor.sessionId},{orderId},
        async client=>{await assertLegacyOrderTeamRequest(client,actor,orderId);},
        async client=>({status:200,body:await requestLegacyOrderTeam(client,actor,team.appId,orderId,requestId)}),
        undefined,async()=>{team.wake?.();});
      return;
    }
    const memberInvite = /^\/([A-Za-z0-9._:-]+)\/members$/.exec(path);
    if (method === "POST" && memberInvite) {
      if (!requireOrigin(request, response, options, requestId)) return;
      if (!options.orderTeamMembers) throw new SecurityApiError(503, API_V1_ERROR_CODES.IM_UNAVAILABLE, "Order Team settings are unavailable");
      const orderId = decodeId(memberInvite[1]!);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["adminUserId"]);
      const targetAdminId = idField(body.adminUserId, "adminUserId");
      const context = await readAdminContext(request, options);
      const actor = { userId: context.userId, sessionId: context.sessionId };
      const teamMembers = options.orderTeamMembers;
      await runIdempotentWrite(options, request, response, requestId,
        { principalId: actor.userId, operation: "im.order.team.member.invite", resourceId: orderId },
        { realm: "admin", id: actor.userId, sessionId: actor.sessionId },
        { orderId, adminUserId: targetAdminId },
        async (client) => { await assertOrderTeamInviteAccess(client, actor, teamMembers.appId, orderId); },
        async (client) => ({ status: 200, body: await inviteOrderTeamAdmin(client, teamMembers, actor, orderId, targetAdminId, requestId) }));
      return;
    }
    const manualClose = /^\/([A-Za-z0-9._:-]+)\/manual-close$/.exec(path);
    if (method === "POST" && manualClose) {
      if (!requireOrigin(request, response, options, requestId)) return;
      const orderId = decodeId(manualClose[1]!);
      const body = bodyOf(request);
      ensureOnlyFields(body, ["remark"]);
      const remark = typeof body.remark === "string" ? body.remark.trim() : "";
      if (remark.length < 3 || remark.length > 200) throw invalid("Remark is invalid", "remark");
      if ([...remark].some((ch) => { const code = ch.codePointAt(0)!; return code < 32 || code === 127; })) throw invalid("Remark is invalid", "remark");
      const context = await readAdminContext(request, options);
      const actor = { userId: context.userId, sessionId: context.sessionId };
      await runIdempotentWrite(options, request, response, requestId,
        { principalId: actor.userId, operation: "order.manual_close", resourceId: orderId },
        { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, { remark },
        async (client) => { await assertManualCloseAccess(client, orderId, actor); },
        (client) => manualCloseOrder(client, orderId, actor, remark, requestId),
        undefined,
        async () => {
          const transport = options.systemMessageTransport;
          if (!transport) return;
          const group = (await options.pool.query<{ teamId: string; systemAccount: string }>(
            `SELECT g.team_id AS "teamId", m.account_id AS "systemAccount"
               FROM zzsh_order.im_order_group g JOIN zzsh_iam.im_identity_mapping m ON m.id = g.system_identity_id
               JOIN zzsh_order.rental_order o ON o.id=g.order_id AND o.status='CANCELLED' AND o.cancel_reason='MANUAL_CLOSE'
              WHERE g.order_id = $1 AND g.team_state = 'READY' AND g.team_id IS NOT NULL LIMIT 1`, [orderId])).rows[0];
          if (!group) return;
          try {
            await transport.sendText({ conversationId: `${group.systemAccount}|2|${group.teamId}`,
              senderAccountId: group.systemAccount, receiverAccountId: group.teamId,
              text: "客服已手动结束本单。如对处理有疑问，请联系客服。",
              messageClientId: `manual_close_${orderId}` });
          } catch { /* The close and audit are committed; notification is best-effort in the fake seam. */ }
        });
      return;
    }
    if (method !== "GET") throw notFound();
    const context = await readAdminContext(request, options);
    await withTransaction(options.pool, async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assertAdminContextInTransaction(client, context);
      if(path==="/im-groups"){
        const cursor=query.get("cursor");if(cursor&&!ID_TOKEN.test(cursor))throw invalid("Cursor is invalid");
        let groups: Awaited<ReturnType<typeof listJoinedOrderTeams>>;
        try {
          groups = await listJoinedOrderTeams(client,{...context,realm:"admin"},cursor,parseLimit(query.get("limit")),options.orderTeamMembers?.appId??"");
        } catch (error) {
          // 订单群列表 500 曾无堆栈可查；这里把请求上下文与原始错误一起打出来。
          console.error(JSON.stringify({ event: "order.im_groups.failed", requestId,
            appId: options.orderTeamMembers?.appId ?? null, error: error instanceof Error ? error.message : String(error) }));
          throw error;
        }
        sendJson(response,200,groups,requestId);return;
      }
      const teamMatch=/^\/([A-Za-z0-9._:-]+)\/im$/.exec(path);
      if(teamMatch){const operation=query.get("operation")??"read";if(operation!=="read"&&operation!=="send")throw invalid("Operation is invalid");sendJson(response,200,await readOrderTeamAccess(client,{...context,realm:"admin"},decodeId(teamMatch[1]!),operation,options.orderImSdkRouteBindings),requestId);return;}
      const candidateMatch=/^\/([A-Za-z0-9._:-]+)\/member-candidates$/.exec(path);
      if(candidateMatch){
        for(const key of query.keys())if(key!=="limit"||query.getAll(key).length!==1)throw invalid("Query is invalid",key);
        const raw=query.get("limit");const limit=raw===null?20:Number(raw);
        if(!Number.isInteger(limit)||limit<1||limit>50)throw invalid("Limit is invalid","limit");
        if(!options.orderTeamMembers)throw new SecurityApiError(503,API_V1_ERROR_CODES.IM_UNAVAILABLE,"Order Team settings are unavailable");
        sendJson(response,200,await listOrderTeamInviteTargets(client,{userId:context.userId,sessionId:context.sessionId},
          options.orderTeamMembers.appId,decodeId(candidateMatch[1]!),limit),requestId);return;
      }
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
      const compensationMatch=/^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/compensation$/.exec(path);
      if (compensationMatch) {
        if (!access.isBoss && !hasPermission(access,ADMIN_PERMISSION.orderCompensationRequest) && !hasPermission(access,ADMIN_PERMISSION.orderCompensationApprove)) throw notFound();
        if ([...query.keys()].some(key=>key!=='origin') || query.getAll('origin').length!==1 || !['NATIVE','LEGACY'].includes(query.get('origin') ?? '')) throw invalid('Order origin is required');
        const origin=query.get('origin') as 'NATIVE'|'LEGACY',orderId=decodeId(compensationMatch[1]!);
        const basis=await compensationOrderBasis(client,origin,orderId);if(!basis)throw notFound();
        await assertGameScope(client,context.userId,access.isBoss,basis.gameId);
        sendJson(response,200,{schema:'admin-order-compensation.v1',basis,...await readCompensationCases(client,origin,orderId)},requestId);return;
      }
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
