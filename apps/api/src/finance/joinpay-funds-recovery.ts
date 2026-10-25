import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";
import { executeJoinpayRefund, allocatePostedJoinpayRefunds, RefundAllocationCommitUnknown, RefundAttemptCommitUnknown, JOINPAY_REFUND_MAX_AUTOMATIC_QUERIES, type RefundExecution } from "../order/joinpay-refund-attempt";
import { readFormalRefundAdmission, assertFormalRefundProfile, assertRefundStart } from "../order/joinpay-refund-profile";
import { executeJoinpayPayout, PayoutCommitUnknown, JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES, type PayoutExecution } from "./joinpay-payout-attempt";
import { readPayoutScope } from "./joinpay-payout-profile";

export type JoinpayFundsRecoverySettings = { workerId: string; batchLimit: number; minimumIntervalSeconds: number };
type RefundOptions = JoinpayFundsRecoverySettings & { execution: RefundExecution };
type PayoutOptions = JoinpayFundsRecoverySettings & { execution: PayoutExecution };
export type JoinpayFundsRecoveryOptions = { refund?: RefundOptions; payout?: PayoutOptions };
type Row = { id: string; state: string };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, PAYOUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const REFUND_STATES = ["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED"];
const PAYOUT_STATES = ["RESERVED", "SUBMITTING", "UNKNOWN", "PROCESSING", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"];
function settings<T extends JoinpayFundsRecoverySettings>(value: T): T {
  if (!value || typeof value.workerId !== "string" || !ID.test(value.workerId) || !Number.isSafeInteger(value.batchLimit) || value.batchLimit < 1 || value.batchLimit > 10
    || !Number.isSafeInteger(value.minimumIntervalSeconds) || value.minimumIntervalSeconds < 30 || value.minimumIntervalSeconds > 86400) {
    throw new Error("FUNDS_RECOVERY_OPTIONS_INVALID");
  }
  return { ...value };
}
function refundOptions(value: RefundOptions) { const copy = settings(value); readFormalRefundAdmission(copy.execution?.admission);
  if (copy.execution.initialProfile) { assertFormalRefundProfile(copy.execution.admission, copy.execution.initialProfile, "SUBMIT"); assertRefundStart(copy.execution.admission); }
  return { ...copy, execution: { ...copy.execution } }; }
function payoutOptions(value: PayoutOptions) { const copy = settings(value); readPayoutScope(copy.execution?.scope); return { ...copy, execution: { ...copy.execution } }; }
async function scan(pool: Pool, resource: { database: string; runtimeUser: string }, sql: string, values: unknown[],
  states: readonly string[], limit: number, kind: "REFUND" | "PAYOUT", signal?: AbortSignal) {
  if (signal?.aborted) return [];
  const client = await pool.connect(); let rows: Row[];
  try {
    if (signal?.aborted) return [];
    const identity = (await client.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    if (identity?.db !== resource.database || identity?.actor !== resource.runtimeUser) throw new Error("FUNDS_RECOVERY_RESOURCE_MISMATCH");
    rows = (await client.query<Row>(sql, values)).rows;
  } finally { client.release(); }
  if (rows.length > limit || new Set(rows.map(r => r.id)).size !== rows.length
    || rows.some(r => typeof r.id !== "string" || !(kind === "REFUND" ? ID : PAYOUT_ID).test(r.id) || !states.includes(r.state))) {
    throw new Error("FUNDS_RECOVERY_CANDIDATES_INVALID");
  }
  return rows;
}

/** 只扫描既有正式原单；扫描连接释放后逐单复用执行器，执行器在原行锁内再核间隔和预算。 */
export async function recoverJoinpayRefundBatch(input: RefundOptions, signal?: AbortSignal) {
  const o = refundOptions(input), a = readFormalRefundAdmission(o.execution.admission);
  const allocation = o.execution.initialProfile ? await allocatePostedJoinpayRefunds(o.execution, o.batchLimit, signal) : undefined;
  const accepted = [{ reference: a.reference, sha256: a.sha256 }, ...a.historicalInitialAdmissions];
  const canSubmit = a.acceptedProfiles.some(profile => profile.operation === "SUBMIT");
  const rows = await scan(o.execution.pool, a, `SELECT i.id,i.state FROM zzsh_order.channel_refund_intent i
    WHERE i.payment_source='JOINPAY' AND i.evidence_level='JOINPAY_FORMAL' AND i.merchant_identity_id=$1 AND i.wire_merchant_no=$2
      AND i.budget_disposition='ALLOCATED' AND i.state=ANY($4::text[]) AND i.due_at<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS accepted(reference text,sha256 text)
        WHERE accepted.reference=i.initial_admission_ref AND accepted.sha256=i.initial_admission_sha256)
      AND (i.state<>'READY' OR i.lease_version>0 OR NOT i.requires_review)
      AND (i.lease_version>0 OR $8::boolean)
      AND (i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
      AND (SELECT count(*) FROM zzsh_order.joinpay_refund_attempt counted WHERE counted.intent_id=i.id AND counted.operation='QUERY')<$7::integer
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt recent WHERE recent.intent_id=i.id
        AND recent.created_at>clock_timestamp()-make_interval(secs=>$5::integer))
    ORDER BY i.due_at,i.id LIMIT $6`, [a.merchantIdentityId, a.merchantNo, JSON.stringify(accepted), REFUND_STATES,
    o.minimumIntervalSeconds, o.batchLimit, JOINPAY_REFUND_MAX_AUTOMATIC_QUERIES, canSubmit], REFUND_STATES, o.batchLimit, "REFUND", signal);
  const result = { selected: rows.length, recorded: 0, skipped: 0, ...(allocation ? { allocation } : {}) };
  for (const row of rows) {
    if (signal?.aborted) break;
    const observed = await executeJoinpayRefund(o.execution, row.id, o.workerId, o.minimumIntervalSeconds);
    if (observed) result.recorded++; else result.skipped++;
  }
  return result;
}

export async function recoverJoinpayPayoutBatch(input: PayoutOptions, signal?: AbortSignal) {
  const o = payoutOptions(input), a = readPayoutScope(o.execution.scope);
  const accepted = [{ reference: a.reference, sha256: a.sha256 }, ...a.historicalScopes];
  const rows = await scan(o.execution.pool, a, `SELECT i.id,i.state FROM zzsh_order.joinpay_withdrawal_intent i
    WHERE i.merchant_identity_id=$1 AND i.user_no=$2 AND i.trade_merchant_no IS NOT DISTINCT FROM $3::text
      AND i.funds_disposition='RESERVED' AND i.state=ANY($5::text[])
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS accepted(reference text,sha256 text)
        WHERE accepted.reference=i.scope_ref AND accepted.sha256=i.scope_sha256)
      AND (i.state<>'RESERVED' OR i.lease_version>0 OR NOT i.requires_review)
      AND (i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
      AND (SELECT count(*) FROM zzsh_order.joinpay_payout_attempt counted WHERE counted.intent_id=i.id AND counted.operation='QUERY')<$8::integer
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_payout_attempt recent WHERE recent.intent_id=i.id
        AND recent.created_at>clock_timestamp()-make_interval(secs=>$6::integer))
    ORDER BY i.updated_at,i.id LIMIT $7`, [a.merchantIdentityId, a.userNo, a.tradeMerchantNo ?? null, JSON.stringify(accepted), PAYOUT_STATES,
    o.minimumIntervalSeconds, o.batchLimit, JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES], PAYOUT_STATES, o.batchLimit, "PAYOUT", signal);
  const result = { selected: rows.length, recorded: 0, skipped: 0 };
  for (const row of rows) {
    if (signal?.aborted) break;
    const observed = await executeJoinpayPayout(o.execution, row.id, o.workerId, o.minimumIntervalSeconds);
    if (observed) result.recorded++; else result.skipped++;
  }
  return result;
}

function start(run: (signal: AbortSignal) => Promise<unknown>, interval: number) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined;
  let failure: { code: string; intentId?: string; postingId?: string; idempotencyKey?: string; phase?: "CLAIM" | "RESULT" | "ALLOCATION" } | null = null;
  const tick = () => {
    if (controller.signal.aborted) return;
    active = run(controller.signal).then(() => {
      if (!controller.signal.aborted) { timer = setTimeout(tick, interval * 1000); timer.unref(); }
    }, error => {
      failure = error instanceof RefundAllocationCommitUnknown
        ? { code: error.code, postingId: error.postingId, idempotencyKey: error.idempotencyKey, phase: "ALLOCATION" }
        : error instanceof RefundAttemptCommitUnknown || error instanceof PayoutCommitUnknown
          ? { code: error.code, intentId: error.intentId, phase: error.phase } : { code: "FUNDS_RECOVERY_FAILED" };
      controller.abort();
    });
  };
  timer = setTimeout(tick, 0); timer.unref();
  return { status: () => ({ stopped: controller.signal.aborted, failure: failure && { ...failure } }),
    stop: async () => { controller.abort(); if (timer) clearTimeout(timer); await active; } };
}

/** 与收款相同：只在显式配置且Nest已启动时派发，关闭先排空任务再让连接池关闭。 */
@Injectable()
export class JoinpayFundsRecoveryLifecycle implements BeforeApplicationShutdown, OnApplicationBootstrap {
  private options?: JoinpayFundsRecoveryOptions;
  private workers: Partial<Record<"refund" | "payout", ReturnType<typeof start>>> = {};
  private bootstrapped = false;
  private closing = false;
  start(options: JoinpayFundsRecoveryOptions) {
    if (this.options || this.closing) throw new Error("FUNDS_RECOVERY_ALREADY_STARTED");
    if (!options || !options.refund && !options.payout) throw new Error("FUNDS_RECOVERY_OPTIONS_INVALID");
    this.options = { ...(options.refund ? { refund: refundOptions(options.refund) } : {}), ...(options.payout ? { payout: payoutOptions(options.payout) } : {}) };
    if (this.bootstrapped) this.launch();
  }
  private launch() {
    const o = this.options!;
    if (o.refund) this.workers.refund = start(signal => recoverJoinpayRefundBatch(o.refund!, signal), o.refund.minimumIntervalSeconds);
    if (o.payout) this.workers.payout = start(signal => recoverJoinpayPayoutBatch(o.payout!, signal), o.payout.minimumIntervalSeconds);
  }
  onApplicationBootstrap() { this.bootstrapped = true; if (this.options && !this.closing) this.launch(); }
  status() { return { refund: this.workers.refund?.status() ?? { stopped: true, failure: null }, payout: this.workers.payout?.status() ?? { stopped: true, failure: null } }; }
  async beforeApplicationShutdown() { this.closing = true; await Promise.all(Object.values(this.workers).map(worker => worker.stop())); }
}
