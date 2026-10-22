import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../auth/security-core";
import { conflict, invalid, notFound } from "../supply/supply-util";
import {
  assertSyntheticChannelRequestCapability, claimPaymentRequestLease, readRecoverablePaymentRequest,
  recordExecutorFailure, recordExecutorResult, recordJoinpayNotify,
  type ChannelBinding, type ChannelObservationResult, type SyntheticRequestCapability,
} from "./channel-payment-store";
import { buildJoinpayQueryRequest, buildJoinpayUniPayRequest, type JoinpaySignedForm, type JoinpayTransportFailure } from "./joinpay-protocol";

/** PAY-04 本地执行链；无网络默认实现，不可用合成 profile 接真实商户。 */
export type SyntheticJoinpayExecution = {
  pool: Pool;
  capability: SyntheticRequestCapability;
  binding: ChannelBinding;
  merchantNo: string;
  productName: string;
  tradeMerchantNo: string;
  notifyUrl: string;
  keyFor: (keyVersionRef: string) => string;
  exchange: (request: { operation: "SUBMIT" | "QUERY"; form: JoinpaySignedForm; signal: AbortSignal }) => Promise<{ status: number; body: Uint8Array }>;
};

export class ChannelExecutionUnknown extends Error {
  readonly code = "PAYMENT_EXECUTION_UNKNOWN";
  constructor(readonly requestId: string, readonly phase: "CLAIM" | "RESULT") {
    super("Payment execution requires recovery using the original request");
  }
}

const EXCHANGE_TIMEOUT_MS = 8_000;
const LEASE_SECONDS = 30;
const MAX_RESPONSE_BYTES = 65_536;
type ExchangeResult = { ok: true; body: Uint8Array } | { ok: false; reason: JoinpayTransportFailure };

async function withConfirmedAttempt<T>(pool: Pool, requestId: string, phase: "CLAIM" | "RESULT", body: (client: PoolClient) => Promise<T>): Promise<T> {
  let bodyComplete = false;
  try {
    return await withTransaction(pool, async client => {
      const result = await body(client);
      bodyComplete = true;
      return result;
    });
  } catch (error) {
    // 校验/业务拒绝保留原错误；事务体完成而 COMMIT 未确认时不能回报成功。
    if (bodyComplete) throw new ChannelExecutionUnknown(requestId, phase);
    throw error;
  }
}

async function exchangeOnce(options: SyntheticJoinpayExecution, operation: "SUBMIT" | "QUERY", form: JoinpaySignedForm): Promise<ExchangeResult> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<ExchangeResult>(resolve => {
      timer = setTimeout(() => { resolve({ ok: false, reason: "TIMEOUT" }); abort.abort(); }, EXCHANGE_TIMEOUT_MS);
    });
    const response = Promise.resolve().then(() => options.exchange({ operation, form, signal: abort.signal })).then((value): ExchangeResult => {
      if (value.status !== 200) return { ok: false, reason: "HTTP_STATUS" };
      if (!(value.body instanceof Uint8Array)) return { ok: false, reason: "NETWORK_ERROR" };
      if (value.body.byteLength > MAX_RESPONSE_BYTES) return { ok: false, reason: "BODY_TOO_LARGE" };
      return { ok: true, body: value.body };
    }, (): ExchangeResult => ({ ok: false, reason: "NETWORK_ERROR" }));
    return await Promise.race([deadline, response]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 只执行一次：首租约且仍 SUBMITTING 才构造下单；接管/超时/重启均查询持久原号。
 * claim 的 COMMIT 未确认时绝不外呼；结果提交未确认时抛原 requestId，不二次下单。
 */
export async function executeSyntheticJoinpayRequest(options: SyntheticJoinpayExecution, input: {
  requestId: string; workerId: string;
}): Promise<{ kind: "SKIPPED" } | { kind: "OBSERVED"; operation: "SUBMIT" | "QUERY"; observation: ChannelObservationResult }> {
  const prepared = await withConfirmedAttempt(options.pool, input.requestId, "CLAIM", async client => {
    if (await assertSyntheticChannelRequestCapability(client, options.capability) !== "SYNTHETIC_PROTOCOL") throw invalid("Synthetic JOINPAY capability required");
    const lease = await claimPaymentRequestLease(client, { requestId: input.requestId, owner: input.workerId, ttlSeconds: LEASE_SECONDS });
    if (!lease) return null;
    const request = await readRecoverablePaymentRequest(client, input.requestId);
    if (!request) throw notFound();
    if (request.channel !== "JOINPAY" || options.binding.channel !== "JOINPAY"
      || (Object.keys(request.binding) as (keyof ChannelBinding)[]).some(k => request.binding[k] !== options.binding[k])) {
      throw conflict("Executor profile does not match the original payment request");
    }
    const operation: "SUBMIT" | "QUERY" = lease.leaseVersion === "1" && lease.state === "SUBMITTING" ? "SUBMIT" : "QUERY";
    if (operation === "SUBMIT") {
      const order = (await client.query(`SELECT status, hold_until > clock_timestamp() AS open FROM zzsh_order.rental_order WHERE id=$1`, [request.orderId])).rows[0];
      if (!order || order.status !== "PENDING_PAYMENT" || order.open !== true) return null;
    }
    const key = options.keyFor(request.binding.keyVersionRef);
    const form = operation === "SUBMIT"
      ? buildJoinpayUniPayRequest({ merchantNo: options.merchantNo, orderNo: request.channelOrderNo, amountCents: request.amountCents,
          currency: "CNY", productName: options.productName, notifyUrl: options.notifyUrl, frpCode: request.method, tradeMerchantNo: options.tradeMerchantNo }, key)
      : buildJoinpayQueryRequest({ merchantNo: options.merchantNo, orderNo: request.channelOrderNo }, key);
    return { lease, operation, form };
  });
  if (!prepared) return { kind: "SKIPPED" };

  const result = await exchangeOnce(options, prepared.operation, prepared.form);
  const operation: "SYNC_RESPONSE" | "QUERY_RESPONSE" = prepared.operation === "SUBMIT" ? "SYNC_RESPONSE" : "QUERY_RESPONSE";
  const observation = await withConfirmedAttempt(options.pool, input.requestId, "RESULT", async client => {
    await assertSyntheticChannelRequestCapability(client, options.capability);
    const common = { requestId: input.requestId, leaseVersion: prepared.lease.leaseVersion, leaseOwner: prepared.lease.leaseOwner,
      operation, rawRef: `synthetic-attempt:${input.requestId}:${prepared.lease.leaseVersion}` };
    return result.ok
      ? recordExecutorResult(client, { ...common, body: result.body, merchantNo: options.merchantNo, keyFor: options.keyFor })
      : recordExecutorFailure(client, { ...common, reason: result.reason });
  });
  return { kind: "OBSERVED", operation: prepared.operation, observation };
}

/** 合成通知的 ACK 也必须等 COMMIT；任何不确定提交都回 fail，不能把观察当正式付款。 */
export async function receiveSyntheticJoinpayNotification(options: Pick<SyntheticJoinpayExecution, "pool" | "capability" | "keyFor"> & {
  resolveMerchant: (merchantNo: string) => string | null;
}, input: { rawQuery: string; rawRef: string }): Promise<{ status: 200 | 503; body: "success" | "fail"; evidenceLevel: "SYNTHETIC_PROTOCOL" }> {
  try {
    if (Buffer.byteLength(input.rawQuery, "utf8") > MAX_RESPONSE_BYTES) return { status: 200, body: "fail", evidenceLevel: "SYNTHETIC_PROTOCOL" };
    const result = await withTransaction(options.pool, async client => {
      if (await assertSyntheticChannelRequestCapability(client, options.capability) !== "SYNTHETIC_PROTOCOL") throw invalid();
      return recordJoinpayNotify(client, { ...input, resolveMerchant: options.resolveMerchant, keyFor: options.keyFor });
    });
    return { status: 200, body: result.outcome.ack === "success" ? "success" : "fail", evidenceLevel: "SYNTHETIC_PROTOCOL" };
  } catch {
    return { status: 503, body: "fail", evidenceLevel: "SYNTHETIC_PROTOCOL" };
  }
}
