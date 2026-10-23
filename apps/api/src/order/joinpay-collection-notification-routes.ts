import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import type { SupplyNodeRequest } from "../supply/supply-util";
import type { SupplyResponse } from "../supply/supply-routes";
import { receiveJoinpayCollectionNotification } from "./joinpay-collection-attempt";
import { JOINPAY_COLLECTION_EVIDENCE_LIMIT, type FormalCollectionSourceOptions } from "./joinpay-collection-source";

export const JOINPAY_COLLECTION_NOTIFICATION_PATH = "/api/v1/payments/joinpay/notifications";
export type JoinpayCollectionNotificationOptions = { pool: Pool; source: FormalCollectionSourceOptions };
/** 精确纯文本，没有JSON、换行或BOM。success仅来自已确认的原业务事务。 */
export function sendJoinpayNotificationAcknowledgement(response: SupplyResponse, result: { status: number; body: "success" | "fail" }): void {
  if (typeof response.send !== "function") throw new Error("JOINPAY_TEXT_RESPONSE_ADAPTER_REQUIRED");
  response.status(result.status); response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store"); response.send(result.body);
}
export async function handleJoinpayCollectionNotification(request: SupplyNodeRequest, response: SupplyResponse,
  options: JoinpayCollectionNotificationOptions): Promise<boolean> {
  const raw = request.originalUrl ?? request.url ?? "", question = raw.indexOf("?"), pathname = question < 0 ? raw : raw.slice(0, question);
  if (pathname !== JOINPAY_COLLECTION_NOTIFICATION_PATH) return false;
  if ((request.method ?? "GET").toUpperCase() !== "GET") { sendJoinpayNotificationAcknowledgement(response, { status: 405, body: "fail" }); return true; }
  // 使用原URI片段，不从Express query或URLSearchParams重建已解码值。
  const rawQuery = question < 0 ? "" : raw.slice(question + 1);
  if (Buffer.byteLength(rawQuery, "utf8") > JOINPAY_COLLECTION_EVIDENCE_LIMIT) {
    sendJoinpayNotificationAcknowledgement(response, { status: 200, body: "fail" }); return true;
  }
  const result = await receiveJoinpayCollectionNotification(options.pool, options.source, rawQuery);
  sendJoinpayNotificationAcknowledgement(response, result); return true;
}
/** 仅共享服务端装配显式安装，不读取环境，不经过用户登录或BFF。 */
export function mountJoinpayCollectionNotifications(app: INestApplication, options: JoinpayCollectionNotificationOptions): void {
  app.getHttpAdapter().getInstance().use(JOINPAY_COLLECTION_NOTIFICATION_PATH,
    (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => handleJoinpayCollectionNotification(request, response, options).then(handled => { if (!handled) next(); }));
}
