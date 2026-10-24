import { Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { acceptJoinpayCollectionEvidence, CollectionAttemptCommitUnknown, executeJoinpayCollectionAttempt,
  JOINPAY_COLLECTION_MAX_AUTOMATIC_QUERIES, type JoinpayCollectionExecution } from "./joinpay-collection-attempt";
import { readFormalCollectionAdmission } from "./joinpay-collection-profile";
import type { FormalCollectionSourceOptions } from "./joinpay-collection-source";

export type JoinpayCollectionRecoveryOptions = {
  execution: JoinpayCollectionExecution & { formal: FormalCollectionSourceOptions };
  workerId: string;
  batchLimit: number;
  minimumIntervalSeconds: number;
};
type Candidate = { request_id: string; state: string; observation_id: string | null };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECOVERABLE = ["SUBMITTING", "UNKNOWN", "ACTION_READY", "PROCESSING_UNCONFIRMED", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"];

function checked(options: JoinpayCollectionRecoveryOptions) {
  if (!options || !ID.test(options.workerId) || !Number.isSafeInteger(options.batchLimit) || options.batchLimit < 1 || options.batchLimit > 10
    || !Number.isSafeInteger(options.minimumIntervalSeconds) || options.minimumIntervalSeconds < 30 || options.minimumIntervalSeconds > 86400) {
    throw new Error("COLLECTION_RECOVERY_OPTIONS_INVALID");
  }
  const admission = readFormalCollectionAdmission(options.execution?.formal?.admission);
  const previous = JSON.parse(admission.canonical).acceptedInitialAdmissions as { reference: string; sha256: string }[];
  return { ...options, execution: { ...options.execution, formal: { ...options.execution.formal } },
    admission, accepted: [{ reference: admission.reference, sha256: admission.sha256 }, ...previous] };
}

/** 未派发的原请求可首次派发，已有尝试只查原号；待接纳直接复用已验观察。 */
export async function recoverJoinpayCollectionBatch(input: JoinpayCollectionRecoveryOptions, signal?: AbortSignal) {
  const options = checked(input), result = { selected: 0, firstDispatched: 0, queried: 0, acceptanceRecovered: 0, skipped: 0 };
  if (signal?.aborted) return result;
  const client = await options.execution.pool.connect();
  let rows: Candidate[];
  try {
    const identity = (await client.query(`SELECT current_database() AS db,current_user AS actor`)).rows[0];
    if (identity?.db !== options.admission.database || identity?.actor !== options.admission.runtimeUser) {
      throw new Error("COLLECTION_RECOVERY_RESOURCE_MISMATCH");
    }
    rows = (await client.query<Candidate>(`SELECT r.id AS request_id,r.state,paid.observation_id
    FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
    LEFT JOIN LATERAL (SELECT o.id AS observation_id FROM zzsh_order.joinpay_collection_observation o
      JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id AND a.request_id=o.request_id
      WHERE o.request_id=r.id AND a.operation='QUERY' AND o.event='E4' AND o.verified
      ORDER BY a.lease_version DESC LIMIT 1) paid ON true
    WHERE r.channel='JOINPAY' AND r.evidence_level='JOINPAY_CANDIDATE' AND b.evidence_mode='OFFICIAL'
      AND r.merchant_identity_id=$1 AND b.wire_merchant_no=$2
      AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS allowed(reference text,sha256 text)
        WHERE allowed.reference=b.formal_admission_ref AND allowed.sha256=b.formal_admission_sha256)
      AND r.state=ANY($4::text[])
      AND (r.state='CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE' AND paid.observation_id IS NOT NULL
        OR (r.lease_version>0 OR r.state='SUBMITTING' AND EXISTS(SELECT 1 FROM zzsh_order.rental_order payable
          WHERE payable.id=r.order_id AND payable.status='PENDING_PAYMENT' AND payable.hold_until>clock_timestamp()))
        AND r.state<>'CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE'
        AND (SELECT count(*) FROM zzsh_order.joinpay_collection_attempt counted WHERE counted.request_id=r.id AND counted.operation='QUERY')<$7::integer
        AND r.created_at<=clock_timestamp()-make_interval(secs=>$5::integer)
        AND (r.lease_until IS NULL OR r.lease_until<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_attempt recent WHERE recent.request_id=r.id
          AND recent.created_at>clock_timestamp()-make_interval(secs=>$5::integer)))
    ORDER BY r.updated_at,r.id LIMIT $6`, [options.admission.merchantIdentityId, options.admission.wireMerchantNo,
    JSON.stringify(options.accepted), RECOVERABLE, options.minimumIntervalSeconds, options.batchLimit, JOINPAY_COLLECTION_MAX_AUTOMATIC_QUERIES])).rows;
  } finally { client.release(); }
  if (rows.length > options.batchLimit || rows.some(row => !ID.test(row.request_id) || !RECOVERABLE.includes(row.state)
    || row.state === "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" && (!row.observation_id || !ID.test(row.observation_id)))) {
    throw new Error("COLLECTION_RECOVERY_CANDIDATES_INVALID");
  }
  result.selected = rows.length;
  for (const row of rows) {
    if (signal?.aborted) break;
    if (row.state === "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE") {
      await acceptJoinpayCollectionEvidence(options.execution.pool, options.execution.formal,
        { operation: "QUERY", requestId: row.request_id, observationId: row.observation_id! });
      result.acceptanceRecovered++;
    } else {
      const observed = await executeJoinpayCollectionAttempt(options.execution, { requestId: row.request_id, workerId: options.workerId,
        recoveryMinimumIntervalSeconds: options.minimumIntervalSeconds, allowFirstDispatch: true });
      if (observed.kind === "OBSERVED") {
        if (observed.operation === "QUERY") result.queried++;
        else if (row.state === "SUBMITTING") result.firstDispatched++;
        else throw new Error("COLLECTION_RECOVERY_SUBMIT_FORBIDDEN");
      } else result.skipped++;
    }
  }
  return result;
}

/** 显式启动、自有单任务定时器；失败即停，关闭等待在途任务，不在导入或GET中启动。 */
export function startJoinpayCollectionRecovery(input: JoinpayCollectionRecoveryOptions) {
  const options = checked(input), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined;
  let failure: Readonly<{ code: "RECOVERY_FAILED" } | { code: "PAYMENT_EXECUTION_UNKNOWN"; requestId: string; phase: "CLAIM" | "RESULT" }> | null = null;
  const tick = () => {
    if (controller.signal.aborted) return;
    active = recoverJoinpayCollectionBatch(options, controller.signal).then(() => {
      if (!controller.signal.aborted) { timer = setTimeout(tick, options.minimumIntervalSeconds * 1000); timer.unref(); }
    }, error => {
      failure = Object.freeze(error instanceof CollectionAttemptCommitUnknown
        ? { code: "PAYMENT_EXECUTION_UNKNOWN", requestId: error.requestId, phase: error.phase } : { code: "RECOVERY_FAILED" });
      controller.abort();
    });
  };
  timer = setTimeout(tick, 0); timer.unref();
  return Object.freeze({
    status: () => ({ stopped: controller.signal.aborted, failure }),
    stop: async () => { controller.abort(); if (timer) clearTimeout(timer); await active; },
  });
}

/** 复用现有后台任务的Before钩子，先排空本任务，再让数据库进入关闭阶段。 */
@Injectable()
export class JoinpayCollectionRecoveryLifecycle implements BeforeApplicationShutdown, OnApplicationBootstrap {
  private worker?: ReturnType<typeof startJoinpayCollectionRecovery>;
  private options?: JoinpayCollectionRecoveryOptions;
  private bootstrapped = false;
  private closing = false;
  start(options: JoinpayCollectionRecoveryOptions): void {
    if (this.options || this.closing) throw new Error("COLLECTION_RECOVERY_ALREADY_STARTED");
    this.options = checked(options);
    if (this.bootstrapped) this.worker = startJoinpayCollectionRecovery(this.options);
  }
  onApplicationBootstrap(): void {
    this.bootstrapped = true;
    if (this.options && !this.closing) this.worker = startJoinpayCollectionRecovery(this.options);
  }
  status() { return this.worker?.status() ?? { stopped: true, failure: null }; }
  async beforeApplicationShutdown(): Promise<void> { this.closing = true; await this.worker?.stop(); }
}
