import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { assertJoinpayAccountReadProfile, describeJoinpayAccountProfile, queryJoinpayAccount, readJoinpayAccountObservation, JoinpayAccountError,
  type AccountQueryDependencies, type AccountQueryResult, type BoundJoinpayAccountProfile, type JoinpayAccountOperation } from "./joinpay-account";

type Reader = Pick<PoolClient, "query">;
const TABLE = "zzsh_order.joinpay_account_observation";
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function scope(merchant: string, operation: JoinpayAccountOperation) {
  if (!ID.test(merchant) || !["AVAILABLE", "COLLECTION"].includes(operation)) throw new JoinpayAccountError("ACCOUNT_SCOPE_INVALID");
}
async function ready(c: Reader, expected?: ReturnType<typeof describeJoinpayAccountProfile>): Promise<boolean> {
  const row = (await c.query("SELECT to_regclass($1) IS NOT NULL AS ready,current_database() AS database,current_user AS runtime_user", [TABLE])).rows[0];
  if (expected && (row?.database !== expected.resourceDatabase || row?.runtime_user !== expected.resourceRuntimeUser)) throw new JoinpayAccountError("ACCOUNT_RESOURCE_MISMATCH");
  return row?.ready === true;
}
export class AccountObservationWriteError extends Error {
  constructor(readonly code: "ACCOUNT_OBSERVATION_COMMIT_UNKNOWN" | "ACCOUNT_OBSERVATION_WRITE_FAILED", readonly attemptId: string, readonly originalResult: AccountQueryResult) { super(code); }
}
export type AccountRefreshActor = Readonly<{ adminId: string; sessionId: string; requestId: string }>;
/** 身份/专用命令授权/商户对象范围由Admin装配先核；这里不从finance.read推导刷新权限。 */
export async function refreshJoinpayAccount(pool: Pool, profile: BoundJoinpayAccountProfile, deps: AccountQueryDependencies, actor: AccountRefreshActor) {
  if (![actor.adminId, actor.sessionId, actor.requestId].every(v => typeof v === "string" && ID.test(v))) throw new JoinpayAccountError("ACCOUNT_ACTOR_INVALID");
  return refreshAccount(pool, profile, deps, { actorType: "admin", actorId: actor.adminId, sessionId: actor.sessionId, requestId: actor.requestId });
}
/** 服务端定时任务独立入口；不伪造管理员或把finance.read解释成刷新命令。 */
export async function refreshJoinpayAccountBySystem(pool: Pool, profile: BoundJoinpayAccountProfile, deps: AccountQueryDependencies, requestId: string) {
  if (typeof requestId !== "string" || !ID.test(requestId)) throw new JoinpayAccountError("ACCOUNT_ACTOR_INVALID");
  assertJoinpayAccountReadProfile(profile);
  return refreshAccount(pool, profile, deps, { actorType: "system", actorId: "joinpay-account-observer", requestId });
}
async function refreshAccount(pool: Pool, profile: BoundJoinpayAccountProfile, deps: AccountQueryDependencies,
  actor: Pick<Parameters<typeof recordAudit>[1], "actorType" | "actorId" | "sessionId" | "requestId">) {
  const expected = describeJoinpayAccountProfile(profile);
  const probe = await pool.connect(); let integrated: boolean;
  try { integrated = await ready(probe, expected); } finally { probe.release(); }
  if (!integrated) return Object.freeze({ integration: "NOT_INTEGRATED" as const, result: null });
  const result = await queryJoinpayAccount(profile, deps), observation = readJoinpayAccountObservation(result), p = observation.profile, i = observation.inspection;
  let callbackCompleted = false;
  try {
    const stored = await withTransaction(pool, async c => {
      // probe与写事务可能借到不同连接；在原写client重核，错库/角色不能存成商户事实。
      if (!await ready(c, expected)) throw new JoinpayAccountError("ACCOUNT_SCHEMA_NOT_DEPLOYED");
      const row = (await c.query(`INSERT INTO ${TABLE}(attempt_id,merchant_identity_id,operation,profile_id,profile_sha256,rules_sha256,
        key_version_ref,review_ref,review_sha256,request_sha256,requested_at,received_at,http_status,response_complete,received_bytes,
        transport_failure,raw_body,raw_sha256,evidence_level,decision,schema_status,signature_status,binding_status,reason,status_code,error_code,amounts)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb)
        RETURNING ${utc("recorded_at")} AS recorded_at`, [result.attemptId, p.merchantIdentityId, result.operation, p.profileId, p.profileSha256, p.rulesSha256,
        p.keyVersionRef, p.reviewRef, p.reviewSha256, observation.requestSha256, observation.requestedAt, observation.receivedAt,
        observation.httpStatus, observation.responseComplete, observation.receivedBytes, observation.transportFailure,
        observation.body === null ? null : Buffer.from(observation.body), observation.rawSha256, result.evidenceLevel,
        i.decision, i.schema, i.signature, i.binding, i.reason, i.statusCode, i.errorCode, i.amounts === null ? null : JSON.stringify(i.amounts)])).rows[0];
      const recordedAt: unknown = row?.recorded_at;
      if (typeof recordedAt !== "string" || !recordedAt) throw new JoinpayAccountError("ACCOUNT_OBSERVATION_RECEIPT_INVALID");
      await recordAudit(c, { ...actor,
        action: "finance.joinpay.account.observed", objectType: "joinpay_account_observation", objectId: result.attemptId,
        outcome: i.decision === "SUCCESS" ? "SUCCESS" : "FAILURE", reason: i.reason,
        details: { operation: result.operation, evidenceLevel: result.evidenceLevel, decision: result.decision, requestSha256: observation.requestSha256,
          rawSha256: observation.rawSha256, responseComplete: observation.responseComplete, profileSha256: p.profileSha256 } });
      const receipt = Object.freeze({ integration: "INTEGRATED" as const, result, recordedAt });
      callbackCompleted = true;
      return receipt;
    });
    return stored;
  } catch {
    // COMMIT丢回执时保留原结果；不能用ROLLBACK ACK声称原观察不存在，也不重查渠道。
    throw new AccountObservationWriteError(callbackCompleted ? "ACCOUNT_OBSERVATION_COMMIT_UNKNOWN" : "ACCOUNT_OBSERVATION_WRITE_FAILED", result.attemptId, result);
  }
}

const SAFE_FIELDS = `attempt_id AS "attemptId",operation,evidence_level AS "evidenceLevel",decision,reason,
  ${utc("requested_at")} AS "requestedAt",${utc("received_at")} AS "receivedAt",${utc("recorded_at")} AS "recordedAt",
  response_complete AS "responseComplete",http_status AS "httpStatus",status_code AS "statusCode",error_code AS "errorCode",
  CASE WHEN decision='SUCCESS' THEN amounts ELSE NULL END AS amounts`;
export type AccountSnapshot = Readonly<{ attemptId: string; operation: JoinpayAccountOperation; evidenceLevel: "SYNTHETIC_PROTOCOL" | "PROVIDER_RESPONSE";
  decision: "SUCCESS" | "SIGNED_PROVIDER_ERROR" | "UNKNOWN"; reason: string; requestedAt: string; receivedAt: string; recordedAt: string;
  responseComplete: boolean; httpStatus: number | null; statusCode: string | null; errorCode: string | null; amounts: Record<string, unknown> | null }>;
/** 本地只读摘要：两个操作独立调用；最新坏响应不替换先前真实已验成功。 */
export async function readJoinpayAccountSummary(c: Reader, merchantIdentityId: string, operation: JoinpayAccountOperation) {
  scope(merchantIdentityId, operation);
  if (!await ready(c)) return Object.freeze({ version: "admin-joinpay-account-summary.v1" as const, operation, integration: "NOT_INTEGRATED" as const,
    knowledge: "UNKNOWN" as const, channelAsOf: null, latestObservation: null, latestVerifiedSnapshot: null });
  const row = (await c.query(`WITH scoped AS (SELECT ${SAFE_FIELDS} FROM ${TABLE} WHERE merchant_identity_id=$1 AND operation=$2)
    SELECT (SELECT row_to_json(o) FROM scoped o ORDER BY "recordedAt"::timestamptz DESC,"attemptId" DESC LIMIT 1) AS latest,
      (SELECT row_to_json(v) FROM scoped v WHERE "evidenceLevel"='PROVIDER_RESPONSE' AND decision='SUCCESS'
        ORDER BY "recordedAt"::timestamptz DESC,"attemptId" DESC LIMIT 1) AS verified`, [merchantIdentityId, operation])).rows[0];
  return Object.freeze({ version: "admin-joinpay-account-summary.v1" as const, operation, integration: "INTEGRATED" as const,
    knowledge: row?.verified ? "KNOWN" as const : "UNKNOWN" as const, channelAsOf: null,
    latestObservation: (row?.latest ?? null) as AccountSnapshot | null, latestVerifiedSnapshot: (row?.verified ?? null) as AccountSnapshot | null });
}
/** 按原attempt本地恢复；NOT_FOUND仅表示本次快照未见，不允许据此自动重发查询。 */
export async function recoverJoinpayAccountObservation(c: Reader, merchantIdentityId: string, operation: JoinpayAccountOperation, attemptId: string) {
  scope(merchantIdentityId, operation); if (!ID.test(attemptId)) throw new JoinpayAccountError("ACCOUNT_ATTEMPT_INVALID");
  if (!await ready(c)) return Object.freeze({ integration: "NOT_INTEGRATED" as const, status: "UNKNOWN" as const, observation: null });
  const row = (await c.query(`SELECT ${SAFE_FIELDS} FROM ${TABLE} WHERE attempt_id=$1 AND merchant_identity_id=$2 AND operation=$3`, [attemptId, merchantIdentityId, operation])).rows[0];
  return Object.freeze({ integration: "INTEGRATED" as const, status: row ? "FOUND" as const : "NOT_FOUND" as const, observation: (row ?? null) as AccountSnapshot | null });
}
