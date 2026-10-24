import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { withTransaction } from "../auth/security-core";
import type { SupplyNodeRequest } from "../supply/supply-util";
import type { SupplyResponse } from "../supply/supply-routes";
import { assertRefundResource } from "./channel-refund-store";
import { decodeJoinpayQuery } from "./joinpay-protocol";
import { receiveJoinpayRefundNotification, type RefundExecution } from "./joinpay-refund-attempt";
export const JOINPAY_REFUND_NOTIFICATION_PATH = "/api/v1/refunds/joinpay/notifications";
function ack(response: SupplyResponse, body: "success" | "fail", status = 200) {
  if (typeof response.send !== "function") throw Error("JOINPAY_TEXT_RESPONSE_ADAPTER_REQUIRED");
  response.status(status); response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.send(body);
}
/** 原URI仅一次解码用于定位已知原号；不取req.query重建签名，也不扫描所有key。 */
export async function handleJoinpayRefundNotification(request: SupplyNodeRequest, response: SupplyResponse, options: RefundExecution): Promise<boolean> {
  const uri = request.originalUrl ?? request.url ?? "", q = uri.indexOf("?"), pathname = q < 0 ? uri : uri.slice(0, q);
  if (pathname !== JOINPAY_REFUND_NOTIFICATION_PATH) return false;
  if ((request.method ?? "GET").toUpperCase() !== "GET") { ack(response, "fail", 405); return true; }
  const raw = q < 0 ? "" : uri.slice(q + 1);
  if (!raw || Buffer.byteLength(raw) > 65536) { ack(response, "fail"); return true; }
  const parsed = decodeJoinpayQuery(raw);
  if (!parsed.ok) { ack(response, "fail"); return true; }
  const merchant = parsed.raw.get("r1_MerchantNo")?.value, refundNo = parsed.raw.get("r3_RefundOrderNo")?.value;
  if (typeof merchant !== "string" || typeof refundNo !== "string" || !/^[0-9]{1,15}$/.test(merchant) || !/^[A-Za-z0-9_-]{1,30}$/.test(refundNo)) { ack(response, "fail"); return true; }
  try {
    const id = await withTransaction(options.pool, async c => {
      await assertRefundResource(c, options.admission);
      const rows = (await c.query(`SELECT id FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND wire_merchant_no=$1 AND refund_order_no=$2`, [merchant, refundNo])).rows;
      return rows.length === 1 ? rows[0].id as string : null;
    });
    if (!id) { ack(response, "fail"); return true; }
    const result = await receiveJoinpayRefundNotification(options, id, raw, `refund_notify_${randomUUID().replaceAll("-", "")}`);
    ack(response, result.ack);
  } catch { ack(response, "fail"); }
  return true;
}
/** 共享装配者显式mount；导入不取配置/建池，不自动开放商户入口。 */
export function mountJoinpayRefundNotifications(app: INestApplication, options: RefundExecution): void {
  app.getHttpAdapter().getInstance().use(JOINPAY_REFUND_NOTIFICATION_PATH, (req: SupplyNodeRequest, res: SupplyResponse, next: () => void) =>
    handleJoinpayRefundNotification(req, res, options).then(handled => { if (!handled) next(); }));
}
