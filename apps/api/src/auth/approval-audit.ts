import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES, API_V1_TOKEN_PATTERN } from "../contracts/api-v1";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, requirePermission, type EffectiveAdminAccess } from "./admin-authorization";
import { lockActor } from "./admin-directory";
import { isAllGamesScope, readAdminGameScope, scopeAllowsGame, type AdminGameScope } from "./admin-scope";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "./security-core";
import { withIdempotency, type IdempotencyReplay } from "../supply/supply-util";
import {
  APPROVAL_EXECUTION_MODE,
  APPROVAL_REGISTERED_OPERATIONS,
  APPROVAL_TEST_OPERATION,
  approvalRegistration,
  membershipBusinessPermission,
  membershipDecisionRequiresBoss,
  membershipOperationRequiresGameScope,
  editableEntitlementApprovalPayload,
  projectApprovalBusinesses,
  type ApprovalOperationRegistration,
  type ApprovalRequestFacts,
} from "./approval-business";
import type { AdminContext, AuthSecurityNodeRequest, AuthSecurityNodeResponse, AuthSecurityOptions } from "./auth-security";
import { validateMembershipEntitlementPayload, validateUnifiedMembershipPolicySubmission } from "./membership-growth-approval";
import { validateDistributionPolicySubmission } from "../finance/distribution-policy-approval";
import { isUnifiedTotalDiscountContract } from "./membership-growth";
import { normalizeGrowthInstant } from "./membership-growth-integration";

const IDEMPOTENCY_KEY_PATTERN = new RegExp(API_V1_TOKEN_PATTERN);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED" | "EXECUTED" | "EXECUTION_FAILED";

const OPERATION_PATTERN = /^[a-z][a-z0-9._:-]{1,127}$/;
const TRIGGER_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const TEST_OPERATION = APPROVAL_TEST_OPERATION;
const TEST_OUTCOMES = new Set(["SUCCESS", "FAILURE"]);
const SENSITIVE_DETAIL_KEY = /(password|token|secret|pin|otp|credential|raw.?payload|operation.?payload)/i;

type ContextReader = (request: AuthSecurityNodeRequest, options: AuthSecurityOptions) => Promise<AdminContext>;

type Person = {
  id: string;
  username: string;
  displayUsername: string;
  name: string;
  status: "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";
  isBoss: boolean;
  twoFactorEnabled: boolean;
};

type TemplateRow = {
  id: string;
  operationCode: string;
  triggerCondition: string;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type RequestRow = {
  id: string;
  templateId: string;
  templateVersion: number;
  operationCode: string;
  triggerCondition: string;
  payloadVersion: number;
  operationPayload: Record<string, unknown>;
  operationPayloadHash: string;
  summary: string;
  requestedBy: string;
  status: ApprovalStatus;
  statusReason: string | null;
  expiresAt: Date | string;
  createdAt: Date | string;
  decidedAt: Date | string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
};

type DecisionRow = { requestId: string; decision: string; reason: string | null; createdAt: Date | string; approverId: string; finalPayload: Record<string, unknown> | null; finalPayloadHash: string | null };
const AMENDABLE_ENTITLEMENTS = new Set(["membership.entitlement.grant", "membership.entitlement.replace"]);

function invalid(message = "Request body is invalid"): never {
  throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message);
}

function conflict(message: string): never {
  throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, message);
}

function requireMembershipBusinessPermission(access: EffectiveAdminAccess, operationCode: string, stage: "REQUEST" | "DECIDE" | "EXECUTE"): void {
  const permission = membershipBusinessPermission(operationCode, stage);
  if (!permission) return;
  if (!access.isBoss && !hasPermission(access, permission)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Membership business permission is required");
}

const APPROVAL_WRITE_OPERATIONS = {
  create: "approval.request.create",
  configureTemplate: "approval.template.configure",
  decide: "approval.request.decide",
  addCandidate: "approval.request.add_candidate",
  execute: "approval.request.execute",
  withdraw: "approval.request.withdraw",
} as const;

/** 恢复合同的三个目标型操作必须带申请号；白名单本身是全部已登记审批写操作，绝不接受任意表名或任意键扫描。 */
const RECOVERY_TARGET_SCOPED = new Set<string>([APPROVAL_WRITE_OPERATIONS.decide, APPROVAL_WRITE_OPERATIONS.addCandidate, APPROVAL_WRITE_OPERATIONS.execute, APPROVAL_WRITE_OPERATIONS.withdraw]);

function headerOf(request: AuthSecurityNodeRequest, name: string): string | undefined {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireIdempotencyKey(request: AuthSecurityNodeRequest): string {
  const value = headerOf(request, "idempotency-key");
  if (!value) throw new SecurityApiError(400, API_V1_ERROR_CODES.MISSING_IDEMPOTENCY_KEY, "Idempotency-Key is required");
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Idempotency-Key is invalid", [{ path: "Idempotency-Key", code: "INVALID_FIELD" }]);
  }
  return value;
}

/**
 * 指纹绑定原业务命令的全部有意义输入：操作种类、载荷版本与 hash、目标、摘要、替代关系。
 * 采用长度前缀编码避免分隔符歧义，且一律不含每请求变化的 X-Request-Id。
 */
function approvalFingerprint(parts: readonly (string | number | null | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part ?? "");
    hash.update(String(value.length) + ":").update(value);
  }
  return hash.digest("hex");
}

function approvalErrorReceipt(status: number, code: string, message: string, requestId: string, reasonCode: string): ApprovalWriteResult {
  return { status, body: { error: { code, message, requestId, reasons: [reasonCode] } } };
}

type ApprovalWriteResult = { status: number; body: Record<string, unknown> };

/**
 * 一次审批写命令在同一 PoolClient 事务内提交：原操作事实、回执与必要审计原子生效。
 * 重放只在幂等记录存在时返回原回执，不再创建申请、不再递增模板版本、不再追加审计；
 * 重放仍先核当前身份、原操作所需权限与对象范围，状态前置只在首次命令上判定。
 */
async function runApprovalWrite(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  context: AdminContext,
  input: {
    operation: string;
    resourceId?: string;
    fingerprint: string;
    authorize: (client: PoolClient, replay: IdempotencyReplay) => Promise<void>;
    action: (client: PoolClient) => Promise<ApprovalWriteResult>;
  },
): Promise<void> {
  const key = requireIdempotencyKey(request);
  const committed = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    return withIdempotency(
      client,
      { realm: "admin", principalId: context.userId, operation: input.operation, resourceId: input.resourceId },
      key,
      input.fingerprint,
      (replay) => input.authorize(client, replay),
      () => input.action(client),
    );
  });
  if (committed.status !== 200) {
    send(response, committed.status, committed.body, requestId);
    return;
  }
  sendSuccess(response, { ...(committed.body as Record<string, unknown>), idempotencyReplay: committed.replayed }, requestId);
}

export const APPROVAL_ACTIONS = ["approve", "reject", "execute", "addCandidate", "replace", "withdraw"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export type ApprovalActionReasonCode =
  | "OK"
  | "ACTOR_INACTIVE"
  | "PERMISSION_REQUIRED"
  | "TWO_FACTOR_REQUIRED"
  | "NOT_CANDIDATE"
  | "SELF_REQUEST_NOT_ALLOWED"
  | "BUSINESS_PERMISSION_REQUIRED"
  | "GAME_SCOPE_DENIED"
  | "OUT_OF_REQUEST_SCOPE"
  | "REQUESTER_ONLY"
  | "STATUS_NOT_PENDING"
  | "STATUS_NOT_APPROVED"
  | "EXPIRED"
  | "TEST_OPERATION_DISABLED"
  | "OPERATION_UNREGISTERED"
  | "EXECUTION_MODE_SOURCE_BUSINESS"
  | "EXECUTOR_NOT_ASSEMBLED"
  | "TARGET_NOT_ACTIVE"
  | "OBJECT_VERSION_CHANGED"
  | "UNKNOWN_STATE";

const REASON_REJECTION: Record<ApprovalActionReasonCode, { status: number; code: typeof API_V1_ERROR_CODES[keyof typeof API_V1_ERROR_CODES] }> = {
  OK: { status: 200, code: API_V1_ERROR_CODES.INVALID_ARGUMENT },
  ACTOR_INACTIVE: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  PERMISSION_REQUIRED: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  TWO_FACTOR_REQUIRED: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  NOT_CANDIDATE: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  SELF_REQUEST_NOT_ALLOWED: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  BUSINESS_PERMISSION_REQUIRED: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  GAME_SCOPE_DENIED: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  OUT_OF_REQUEST_SCOPE: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  REQUESTER_ONLY: { status: 403, code: API_V1_ERROR_CODES.FORBIDDEN },
  STATUS_NOT_PENDING: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  STATUS_NOT_APPROVED: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  EXPIRED: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  TEST_OPERATION_DISABLED: { status: 404, code: API_V1_ERROR_CODES.NOT_FOUND },
  OPERATION_UNREGISTERED: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  EXECUTION_MODE_SOURCE_BUSINESS: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  EXECUTOR_NOT_ASSEMBLED: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  TARGET_NOT_ACTIVE: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  OBJECT_VERSION_CHANGED: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
  UNKNOWN_STATE: { status: 409, code: API_V1_ERROR_CODES.CONFLICT },
};

export type ApprovalActionEligibility = {
  action: ApprovalAction;
  allowed: boolean;
  reasonCode: ApprovalActionReasonCode;
  requiredPermission: string | null;
  executionMode: string | null;
  nextStepCode: string | null;
};

/** 到期在申请仍活跃时形成虚拟 EXPIRED 读取，不改写历史状态。 */
export function virtualRequestStatus(row: Pick<RequestRow, "status" | "expiresAt">, asOfUtc?: string): ApprovalStatus {
  const expired = asOfUtc === undefined ? new Date(row.expiresAt).getTime() <= Date.now()
    : normalizeGrowthInstant(row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt, "expiresAt") <= normalizeGrowthInstant(asOfUtc, "asOf");
  return expired && (row.status === "PENDING" || row.status === "APPROVED") ? "EXPIRED" : row.status;
}

function payloadGameId(payload: Record<string, unknown>): string | null {
  const value = payload.gameId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type ApprovalActionContext = {
  row: RequestRow;
  userId: string;
  access: EffectiveAdminAccess;
  twoFactorEnabled: boolean;
  gameScope: AdminGameScope;
  isCandidate: boolean;
  testOperationsEnabled: boolean;
  executorAssembled: boolean;
  /** 冻结目标对象的当前状态由业务投影带回，预检不为此额外查库。 */
  targetEntitlementStatus?: string | null;
  policyDraftStatus?: string | null;
  /**
   * 幂等重放只重核身份、权限与对象范围；状态/到期/目标版本属于首次命令的前置，
   * 不能因为原操作已经完成就把同 key 重放一律拒绝。
   */
  includeStatePreconditions?: boolean;
};

/**
 * 申请上的当前动作资格。判定顺序与写事务一致，因此预检说明和实际拒绝同源；
 * 它只是解释，写接口仍在锁 actor 与请求行后重新执行同一判定与领域校验。
 */
export function evaluateApprovalActions(input: ApprovalActionContext): ApprovalActionEligibility[] {
  const { row, access, userId } = input;
  const withState = input.includeStatePreconditions !== false;
  const status = virtualRequestStatus(row);
  const active = access.status === "ACTIVE";
  const selfRequester = row.requestedBy === userId;
  const linked = access.isBoss || selfRequester || input.isCandidate;
  const scopeDenied = businessScopeDenied({ isBoss: access.isBoss, gameScope: input.gameScope }, row.operationCode, row.operationPayload);
  const registration = approvalRegistration(row.operationCode);
  const unregistered = registration === null;
  const build = (
    action: ApprovalAction,
    reason: ApprovalActionReasonCode,
    requiredPermission: string | null,
    nextStepCode: string | null = null,
  ): ApprovalActionEligibility => ({
    action,
    allowed: reason === "OK",
    reasonCode: reason,
    requiredPermission,
    executionMode: registration?.executionMode ?? APPROVAL_EXECUTION_MODE.unsupported,
    nextStepCode,
  });

  const decisionGate = (action: ApprovalAction): ApprovalActionEligibility => {
    const approvePermission = ADMIN_PERMISSION.approvalRequestApprove;
    const businessPermission = membershipBusinessPermission(row.operationCode, "DECIDE");
    if (!active) return build(action, "ACTOR_INACTIVE", approvePermission);
    if (!hasPermission(access, approvePermission)) return build(action, "PERMISSION_REQUIRED", approvePermission);
    if (unregistered) return build(action, "OPERATION_UNREGISTERED", approvePermission);
    if (!input.twoFactorEnabled) return build(action, "TWO_FACTOR_REQUIRED", approvePermission);
    if (!input.isCandidate) return build(action, "NOT_CANDIDATE", approvePermission);
    if (selfRequester) return build(action, "SELF_REQUEST_NOT_ALLOWED", approvePermission);
    if (membershipDecisionRequiresBoss(row.operationCode) && !access.isBoss) return build(action, "BUSINESS_PERMISSION_REQUIRED", businessPermission, "BOSS_REVIEW_REQUIRED");
    if (businessPermission && !access.isBoss && !hasPermission(access, businessPermission)) return build(action, "BUSINESS_PERMISSION_REQUIRED", businessPermission);
    if (scopeDenied) return build(action, "GAME_SCOPE_DENIED", businessPermission);
    if (withState && status === "EXPIRED") return build(action, "EXPIRED", approvePermission);
    if (withState && row.status !== "PENDING") return build(action, "STATUS_NOT_PENDING", approvePermission);
    return build(action, "OK", approvePermission);
  };

  const executeGate = (): ApprovalActionEligibility => {
    const permission = ADMIN_PERMISSION.approvalRequestExecute;
    const businessPermission = membershipBusinessPermission(row.operationCode, "EXECUTE");
    if (!active) return build("execute", "ACTOR_INACTIVE", permission);
    if (!hasPermission(access, permission)) return build("execute", "PERMISSION_REQUIRED", permission);
    if (unregistered) return build("execute", "OPERATION_UNREGISTERED", permission);
    if (businessPermission && !access.isBoss && !hasPermission(access, businessPermission)) return build("execute", "BUSINESS_PERMISSION_REQUIRED", businessPermission);
    if (row.operationCode === TEST_OPERATION && !input.testOperationsEnabled) return build("execute", "TEST_OPERATION_DISABLED", permission);
    if (!linked) return build("execute", "OUT_OF_REQUEST_SCOPE", permission);
    if (withState && status === "EXPIRED") return build("execute", "EXPIRED", permission);
    if (withState && row.status !== "APPROVED") return build("execute", "STATUS_NOT_APPROVED", permission, "APPROVAL_DECISION_REQUIRED");
    if (registration.executionMode !== APPROVAL_EXECUTION_MODE.genericTransaction) {
      return build("execute", registration.executionMode === APPROVAL_EXECUTION_MODE.sourceBusiness ? "EXECUTION_MODE_SOURCE_BUSINESS" : "OPERATION_UNREGISTERED", permission, "SOURCE_BUSINESS_COMPLETION_REQUIRED");
    }
    if (row.operationCode !== TEST_OPERATION && !input.executorAssembled) return build("execute", "EXECUTOR_NOT_ASSEMBLED", permission);
    if (scopeDenied) return build("execute", "GAME_SCOPE_DENIED", businessPermission);
    if (withState && input.targetEntitlementStatus && !["EXECUTED_PENDING_START", "ACTIVE"].includes(input.targetEntitlementStatus)) return build("execute", "TARGET_NOT_ACTIVE", businessPermission);
    if (withState && input.policyDraftStatus && input.policyDraftStatus !== "DRAFT") return build("execute", "OBJECT_VERSION_CHANGED", businessPermission);
    return build("execute", "OK", permission);
  };

  return [
    decisionGate("approve"),
    decisionGate("reject"),
    executeGate(),
    (() => {
      const permission = ADMIN_PERMISSION.approvalRequestAddApprover;
      if (!active) return build("addCandidate", "ACTOR_INACTIVE", permission);
      if (!hasPermission(access, permission)) return build("addCandidate", "PERMISSION_REQUIRED", permission);
      if (unregistered) return build("addCandidate", "OPERATION_UNREGISTERED", permission);
      if (!(access.isBoss || selfRequester)) return build("addCandidate", "OUT_OF_REQUEST_SCOPE", permission);
      if (withState && status === "EXPIRED") return build("addCandidate", "EXPIRED", permission);
      if (withState && row.status !== "PENDING") return build("addCandidate", "STATUS_NOT_PENDING", permission);
      return build("addCandidate", "OK", permission);
    })(),
    (() => {
      const permission = ADMIN_PERMISSION.approvalRequestCreate;
      const businessPermission = membershipBusinessPermission(row.operationCode, "REQUEST");
      if (!active) return build("replace", "ACTOR_INACTIVE", permission);
      if (!hasPermission(access, permission)) return build("replace", "PERMISSION_REQUIRED", permission);
      if (unregistered) return build("replace", "OPERATION_UNREGISTERED", permission);
      if (businessPermission && !access.isBoss && !hasPermission(access, businessPermission)) return build("replace", "BUSINESS_PERMISSION_REQUIRED", businessPermission);
      if (!selfRequester) return build("replace", "REQUESTER_ONLY", permission);
      if (withState && status === "EXPIRED") return build("replace", "EXPIRED", permission);
      if (withState && row.status !== "PENDING") return build("replace", "STATUS_NOT_PENDING", permission);
      return build("replace", "OK", permission, "NEW_REQUEST_WITH_SUPERSEDES");
    })(),
    (() => {
      const permission = ADMIN_PERMISSION.approvalRequestRead;
      if (!active) return build("withdraw", "ACTOR_INACTIVE", permission);
      if (unregistered) return build("withdraw", "OPERATION_UNREGISTERED", permission);
      if (!(access.isBoss || selfRequester)) return build("withdraw", "REQUESTER_ONLY", permission);
      if (withState && status === "EXPIRED") return build("withdraw", "EXPIRED", permission);
      if (withState && row.status !== "PENDING") return build("withdraw", "STATUS_NOT_PENDING", permission);
      return build("withdraw", "OK", permission);
    })(),
  ];
}

export function assertApprovalAction(actions: readonly ApprovalActionEligibility[], action: ApprovalAction): ApprovalActionEligibility {
  const item = actions.find((entry) => entry.action === action);
  if (!item) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Approval action state is unavailable: UNKNOWN_STATE");
  if (item.allowed) return item;
  const rejection = REASON_REJECTION[item.reasonCode];
  throw new SecurityApiError(rejection.status, rejection.code, `Approval action ${action} is not available: ${item.reasonCode}`);
}

function routePath(request: AuthSecurityNodeRequest): string {
  const source = request.originalUrl ?? request.url ?? "/";
  return source.split("?", 1)[0] || "/";
}

function queryValue(request: AuthSecurityNodeRequest, name: string): string | undefined {
  const source = request.originalUrl ?? request.url ?? "";
  const query = source.includes("?") ? source.slice(source.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get(name) ?? undefined;
}

function bodyOf(request: AuthSecurityNodeRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) invalid();
  return request.body as Record<string, unknown>;
}

function assertFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid();
}

function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) invalid();
  return value;
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (body[field] === undefined) return undefined;
  return requiredString(body, field, maxLength);
}

function username(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) invalid("Administrator login is invalid");
  return normalized;
}

function usernameList(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid();
  const result = value.map((item) => {
    if (typeof item !== "string") invalid();
    return username(item);
  });
  if (new Set(result).size !== result.length) invalid("Candidate list must not contain duplicates");
  return result;
}

function operationCode(value: string): string {
  const normalized = value.trim();
  if (!OPERATION_PATTERN.test(normalized)) invalid("Operation code is invalid");
  return normalized;
}

function triggerCondition(value: string): string {
  const normalized = value.trim();
  if (!TRIGGER_PATTERN.test(normalized)) invalid("Trigger condition is invalid");
  return normalized;
}

function payloadVersion(body: Record<string, unknown>): number {
  const value = body.payloadVersion;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) invalid();
  return value;
}

function normalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 8) invalid("Operation payload is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 2000) invalid("Operation payload is too large");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Operation payload contains an invalid number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid("Operation payload array is too large");
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (typeof value !== "object") invalid("Operation payload is invalid");
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 64) invalid("Operation payload object is too large");
  const result: { [key: string]: JsonValue } = {};
  for (const [key, child] of entries) {
    if (!key || key.length > 80 || ["__proto__", "constructor", "prototype"].includes(key)) invalid("Operation payload key is invalid");
    result[key] = normalizeJson(child, depth + 1);
  }
  return result;
}

export function hashApprovalPayload(payload: Record<string, unknown>): { value: Record<string, unknown>; raw: string; hash: string } {
  const value = normalizeJson(payload) as Record<string, JsonValue>;
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) invalid("Operation payload is too large");
  return { value, raw, hash: createHash("sha256").update(raw, "utf8").digest("hex") };
}

function immutablePayload(body: Record<string, unknown>): { value: Record<string, unknown>; raw: string; hash: string } {
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) invalid("Operation payload must be an object");
  return hashApprovalPayload(body.payload as Record<string, unknown>);
}

function assertFinalPayloadTarget(row: RequestRow, final: Record<string, unknown>, expectedHash: string): void {
  if (!AMENDABLE_ENTITLEMENTS.has(row.operationCode)) invalid("This operation does not support amended approval");
  if (row.operationPayloadHash !== expectedHash) conflict("Approval request payload changed; reload before deciding");
  const mutable = new Set(["startsAtUtc", "endsAtUtc", "pricing", "depositWaived", "depositAllowanceCents", "reason"]);
  const fixed = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload).filter(([key]) => !mutable.has(key)));
  if (hashApprovalPayload(fixed(row.operationPayload)).hash !== hashApprovalPayload(fixed(final)).hash) conflict("An amended approval must keep the original recipient and business references");
  const pricingFixed = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "payableRatio")) : {};
  if (hashApprovalPayload(pricingFixed(row.operationPayload.pricing)).hash !== hashApprovalPayload(pricingFixed(final.pricing)).hash) conflict("An amended approval may change the payable share, not its pricing references");
}

function verifiedFinalPayload(row: RequestRow, decision: DecisionRow): ReturnType<typeof hashApprovalPayload> | null {
  if (decision.finalPayload == null && decision.finalPayloadHash == null) return null;
  if (decision.decision !== "APPROVED" || !decision.finalPayload || !decision.finalPayloadHash || !/^[a-f0-9]{64}$/.test(decision.finalPayloadHash)) conflict("Approval decision payload is incomplete");
  if (decision.approverId !== row.decidedBy || !["APPROVED", "EXECUTED", "EXECUTION_FAILED", "EXPIRED"].includes(row.status)) conflict("Approved final decision binding is inconsistent");
  const final = immutablePayload({ payload: decision.finalPayload });
  if (final.hash !== decision.finalPayloadHash) conflict("Approved final payload hash does not match");
  assertFinalPayloadTarget(row, final.value, row.operationPayloadHash);
  return final;
}

export async function readDecisions(client: Pool | PoolClient, rows: readonly RequestRow[]): Promise<Map<string, DecisionRow>> {
  if (!rows.length) return new Map();
  const decisions = await client.query<DecisionRow>(
    `SELECT "request_id" AS "requestId","decision","reason","created_at" AS "createdAt","approver_admin_id" AS "approverId","final_payload" AS "finalPayload","final_payload_hash" AS "finalPayloadHash"
       FROM "zzsh_iam"."approval_decision" WHERE "request_id" = ANY($1::text[])`, [rows.map((row) => row.id)],
  );
  const requests = new Map(rows.map((row) => [row.id, row])), result = new Map<string, DecisionRow>();
  for (const decision of decisions.rows) {
    const row = requests.get(decision.requestId);
    if (!row || result.has(row.id)) conflict("Approval decision identity is inconsistent");
    verifiedFinalPayload(row, decision);
    result.set(row.id, decision);
  }
  return result;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function send(response: AuthSecurityNodeResponse, status: number, body: unknown, requestId: string): void {
  if (response.headersSent) return;
  response.status(status).setHeader("X-Request-Id", requestId).setHeader("Cache-Control", "no-store").json(body);
}

function sendSuccess(response: AuthSecurityNodeResponse, body: unknown, requestId: string): void {
  send(response, 200, body, requestId);
}

async function requireCurrentAccess(pool: Pool, context: AdminContext, permission: string): Promise<EffectiveAdminAccess> {
  const access = await loadEffectiveAdminAccess(pool, context.userId);
  requirePermission(access, permission);
  return access!;
}

async function adminByUserId(client: Pool | PoolClient, userId: string): Promise<Person> {
  const result = await client.query<{
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string;
    status: Person["status"];
    isBoss: boolean;
    twoFactorEnabled: boolean;
  }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE u."id" = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  const login = row.username ?? row.displayUsername?.toLowerCase() ?? "unknown";
  return {
    id: row.id,
    username: login,
    displayUsername: row.displayUsername ?? login.toUpperCase(),
    name: row.name,
    status: row.status,
    isBoss: row.isBoss,
    twoFactorEnabled: row.twoFactorEnabled === true,
  };
}

async function adminsByUsernames(client: PoolClient, usernames: string[]): Promise<Person[]> {
  const result = await client.query<{
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string;
    status: Person["status"];
    isBoss: boolean;
    twoFactorEnabled: boolean;
  }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE lower(u."username") = ANY($1::text[])
      FOR UPDATE OF u, s`,
    [usernames],
  );
  const byUsername = new Map(result.rows.map((row) => [row.username?.toLowerCase() ?? "", row]));
  if (byUsername.size !== usernames.length || usernames.some((item) => !byUsername.has(item))) {
    throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Candidate administrator not found");
  }
  return usernames.map((item) => {
    const row = byUsername.get(item)!;
    return {
      id: row.id,
      username: row.username ?? item,
      displayUsername: row.displayUsername ?? item.toUpperCase(),
      name: row.name,
      status: row.status,
      isBoss: row.isBoss,
      twoFactorEnabled: row.twoFactorEnabled === true,
    };
  });
}

async function candidateView(client: Pool | PoolClient, candidate: Person, source?: string, addedBy?: string | null): Promise<Record<string, unknown>> {
  const access = await loadEffectiveAdminAccess(client, candidate.id);
  return {
    username: candidate.username,
    displayUsername: candidate.displayUsername,
    name: candidate.name,
    status: candidate.status,
    isBoss: candidate.isBoss,
    eligible: candidate.status === "ACTIVE" && candidate.twoFactorEnabled && hasPermission(access, ADMIN_PERMISSION.approvalRequestApprove),
    ...(source ? { source } : {}),
    ...(addedBy ? { addedBy: (await adminByUserId(client, addedBy)).displayUsername } : {}),
  };
}

async function templateRows(pool: Pool): Promise<TemplateRow[]> {
  const result = await pool.query<TemplateRow>(
    `SELECT "id", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "version", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
       FROM "zzsh_iam"."approval_template"
      ORDER BY "operation_code", "trigger_condition"`,
  );
  return result.rows;
}

async function templateResponse(pool: Pool, row: TemplateRow): Promise<Record<string, unknown>> {
  const candidates = await pool.query<{ id: string; username: string | null; displayUsername: string | null; name: string; status: Person["status"]; isBoss: boolean; twoFactorEnabled: boolean }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled"
       FROM "zzsh_iam"."approval_template_candidate" c
       JOIN "zzsh_auth_admin"."user" u ON u."id" = c."admin_user_id"
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE c."template_id" = $1
      ORDER BY lower(u."username")`,
    [row.id],
  );
  return {
    id: row.id,
    operationCode: row.operationCode,
    triggerCondition: row.triggerCondition,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    candidates: await Promise.all(candidates.rows.map(async (candidate) => candidateView(pool, {
      id: candidate.id,
      username: candidate.username ?? "unknown",
      displayUsername: candidate.displayUsername ?? candidate.username?.toUpperCase() ?? "UNKNOWN",
      name: candidate.name,
      status: candidate.status,
      isBoss: candidate.isBoss,
      twoFactorEnabled: candidate.twoFactorEnabled === true,
    }))),
  };
}

async function listTemplates(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalTemplateRead);
  sendSuccess(response, { templates: await Promise.all((await templateRows(options.pool)).map((row) => templateResponse(options.pool, row))) }, requestId);
}

async function requireWriteAccess(client: PoolClient, context: AdminContext, permission: string): Promise<EffectiveAdminAccess> {
  const access = await lockActor(client, context.userId);
  requirePermission(access, permission);
  return access;
}

async function configureTemplate(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["operationCode", "triggerCondition", "candidateUsernames"]);
  const op = operationCode(requiredString(body, "operationCode", 128));
  const trigger = triggerCondition(requiredString(body, "triggerCondition", 64));
  const candidateUsernames = usernameList(body, "candidateUsernames");
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.configureTemplate,
    fingerprint: approvalFingerprint([op, trigger, ...[...candidateUsernames].sort()]),
    authorize: async (client) => {
      await requireWriteAccess(client, context, ADMIN_PERMISSION.approvalTemplateConfigure);
    },
    action: async (client) => {
      const candidates = await adminsByUsernames(client, candidateUsernames);
      const current = await client.query<{ id: string; version: number }>(
        `SELECT "id", "version" FROM "zzsh_iam"."approval_template" WHERE "operation_code" = $1 AND "trigger_condition" = $2 FOR UPDATE`,
        [op, trigger],
      );
      const existing = current.rows[0];
      const templateId = existing?.id ?? `approval_tpl_${randomUUID().replaceAll("-", "")}`;
      const version = existing ? existing.version + 1 : 1;
      if (existing) {
        await client.query(
          `UPDATE "zzsh_iam"."approval_template" SET "version" = $1, "updated_at" = clock_timestamp() WHERE "id" = $2`,
          [version, templateId],
        );
        await client.query(`DELETE FROM "zzsh_iam"."approval_template_candidate" WHERE "template_id" = $1`, [templateId]);
      } else {
        await client.query(
          `INSERT INTO "zzsh_iam"."approval_template" ("id", "operation_code", "trigger_condition", "version") VALUES ($1, $2, $3, $4)`,
          [templateId, op, trigger, version],
        );
      }
      for (const candidate of candidates) {
        await client.query(
          `INSERT INTO "zzsh_iam"."approval_template_candidate" ("template_id", "admin_user_id") VALUES ($1, $2)`,
          [templateId, candidate.id],
        );
      }
      await recordAudit(client, {
        actorType: "admin",
        actorId: context.userId,
        sessionId: context.sessionId,
        action: "approval.template.configured",
        objectType: "approval_template",
        objectId: templateId,
        outcome: "SUCCESS",
        requestId,
        details: { operationCode: op, triggerCondition: trigger, version, candidateCount: candidates.length },
      });
      return { status: 200, body: { templateId, version, candidateCount: candidates.length, status: "CONFIGURED" } };
    },
  });
}

const REQUEST_SELECT_COLUMNS = `"id", "template_id" AS "templateId", "template_version" AS "templateVersion", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "payload_version" AS "payloadVersion", "operation_payload" AS "operationPayload", "operation_payload_hash" AS "operationPayloadHash", "summary", "requested_by" AS "requestedBy", "status", "status_reason" AS "statusReason", "expires_at" AS "expiresAt", "created_at" AS "createdAt", "decided_at" AS "decidedAt", "decided_by" AS "decidedBy", "decision_reason" AS "decisionReason", "supersedes_request_id" AS "supersedesRequestId", "superseded_by_request_id" AS "supersededByRequestId"`;

export async function readRequestById(executor: Pool | PoolClient, requestId: string): Promise<RequestRow | undefined> {
  const result = await executor.query<RequestRow>(
    `SELECT ${REQUEST_SELECT_COLUMNS} FROM "zzsh_iam"."approval_request" WHERE "id" = $1`,
    [requestId],
  );
  return result.rows[0];
}

async function readRequestForUpdate(client: PoolClient, requestId: string): Promise<RequestRow> {
  const result = await client.query<RequestRow>(
    `SELECT ${REQUEST_SELECT_COLUMNS} FROM "zzsh_iam"."approval_request" WHERE "id" = $1 FOR UPDATE`,
    [requestId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  return row;
}

async function requestCandidateRows(client: Pool | PoolClient, requestId: string): Promise<Array<{ candidate: Person; source: string; templateVersion: number; addedBy: string | null }>> {
  const result = await client.query<{ id: string; username: string | null; displayUsername: string | null; name: string; status: Person["status"]; isBoss: boolean; twoFactorEnabled: boolean; source: string; templateVersion: number; addedBy: string | null }>(
    `SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss", u."twoFactorEnabled", c."source", c."template_version" AS "templateVersion", c."added_by" AS "addedBy"
       FROM "zzsh_iam"."approval_request_candidate" c
       JOIN "zzsh_auth_admin"."user" u ON u."id" = c."admin_user_id"
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE c."request_id" = $1
      ORDER BY c."source", lower(u."username")`,
    [requestId],
  );
  return result.rows.map((row) => ({
    candidate: {
      id: row.id,
      username: row.username ?? "unknown",
      displayUsername: row.displayUsername ?? row.username?.toUpperCase() ?? "UNKNOWN",
      name: row.name,
      status: row.status,
      isBoss: row.isBoss,
      twoFactorEnabled: row.twoFactorEnabled === true,
    },
    source: row.source,
    templateVersion: row.templateVersion,
    addedBy: row.addedBy,
  }));
}

function requestFingerprint(row: Pick<RequestRow, "operationCode" | "triggerCondition" | "payloadVersion" | "operationPayloadHash" | "summary">): string {
  return [row.operationCode, row.triggerCondition, row.payloadVersion, row.operationPayloadHash, row.summary].join("\u0000");
}

async function createRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["operationCode", "triggerCondition", "payloadVersion", "payload", "summary", "supersedesRequestId"]);
  const op = operationCode(requiredString(body, "operationCode", 128));
  const trigger = triggerCondition(requiredString(body, "triggerCondition", 64));
  const version = payloadVersion(body);
  const payload = immutablePayload(body);
  const summary = requiredString(body, "summary", 240).trim();
  if (summary.length < 3) invalid("Summary is required");
  const supersedes = optionalString(body, "supersedesRequestId", 128);
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.create,
    fingerprint: approvalFingerprint([op, trigger, version, payload.hash, summary, supersedes]),
    authorize: async (client) => {
      const access = await requireWriteAccess(client, context, ADMIN_PERMISSION.approvalRequestCreate);
      await assertCreateAuthorization(client, options, context, access, op, payload.value, supersedes);
    },
    action: async (client) => {
      if (AMENDABLE_ENTITLEMENTS.has(op) && !isUnifiedTotalDiscountContract(payload.value.pricing)) throw new SecurityApiError(409, "CONFLICT", "礼遇办理已改为统一总价折扣，请刷新并使用新版表单", [{ path: "pricing.scope", code: "INVALID_FIELD" }]);
      if (op === "membership.benefit.policy.publish") await validateUnifiedMembershipPolicySubmission(client, payload.value as Record<string, unknown>);
      if (op === "distribution.policy.publish") await validateDistributionPolicySubmission(client, payload.value as Record<string, unknown>, options.distributionPolicyWriteScope);
      const templateResult = await client.query<TemplateRow>(
        `SELECT "id", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "version", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
           FROM "zzsh_iam"."approval_template" WHERE "operation_code" = $1 AND "trigger_condition" = $2 FOR UPDATE`,
        [op, trigger],
      );
      const template = templateResult.rows[0];
      if (!template) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval template not found");
      const candidates = await client.query<{ adminUserId: string }>(
        `SELECT "admin_user_id" AS "adminUserId" FROM "zzsh_iam"."approval_template_candidate" WHERE "template_id" = $1 ORDER BY "admin_user_id"`,
        [template.id],
      );
      if (candidates.rows.length < 1) conflict("Approval template has no candidate");
      const newRequestId = `approval_req_${randomUUID().replaceAll("-", "")}`;
      let previous: RequestRow | undefined;
      if (supersedes) {
        previous = await readRequestForUpdate(client, supersedes);
        if (previous.requestedBy !== context.userId) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only the requester can replace its pending request");
        if (previous.status !== "PENDING" || virtualRequestStatus(previous) !== "PENDING") conflict("Only a pending request can be replaced; submit a new request after rejection");
        const nextFingerprint = requestFingerprint({ operationCode: op, triggerCondition: trigger, payloadVersion: version, operationPayloadHash: payload.hash, summary });
        if (requestFingerprint(previous) === nextFingerprint) conflict("Replacement must change the operation request");
      }
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_request" ("id", "template_id", "template_version", "operation_code", "trigger_condition", "payload_version", "operation_payload", "operation_payload_hash", "summary", "requested_by", "status", "expires_at", "supersedes_request_id")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'PENDING', $11, $12)`,
        [newRequestId, template.id, template.version, op, trigger, version, payload.raw, payload.hash, summary, context.userId, expiresAt, supersedes ?? null],
      );
      for (const candidate of candidates.rows) {
        await client.query(
          `INSERT INTO "zzsh_iam"."approval_request_candidate" ("request_id", "admin_user_id", "source", "template_version") VALUES ($1, $2, 'TEMPLATE', $3)`,
          [newRequestId, candidate.adminUserId, template.version],
        );
      }
      if (previous) {
        await client.query(
          `UPDATE "zzsh_iam"."approval_request" SET "status" = 'CANCELLED', "status_reason" = '已由新申请替代', "superseded_by_request_id" = $1 WHERE "id" = $2 AND "status" = 'PENDING'`,
          [newRequestId, previous.id],
        );
        await recordAudit(client, {
          actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
          action: "approval.request.cancelled", objectType: "approval_request", objectId: previous.id,
          outcome: "SUCCESS", requestId, reason: "已由新申请替代", details: { supersededByRequestId: newRequestId },
        });
      }
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: "approval.request.created", objectType: "approval_request", objectId: newRequestId,
        outcome: "SUCCESS", requestId,
        details: { operationCode: op, triggerCondition: trigger, payloadVersion: version, operationPayloadHash: payload.hash, templateVersion: template.version, candidateCount: candidates.rows.length, summary },
      });
      return {
        status: 200,
        body: {
          requestId: newRequestId,
          approvalRequestId: newRequestId,
          approvalRequestKind: "approval_request",
          templateVersion: template.version,
          candidateCount: candidates.rows.length,
          expiresAt: expiresAt.toISOString(),
          status: "PENDING",
        },
      };
    },
  });
}

async function expireRequest(client: PoolClient, row: RequestRow, context: AdminContext, requestId: string): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."approval_request" SET "status" = 'EXPIRED', "status_reason" = '审批有效期已过' WHERE "id" = $1 AND "status" IN ('PENDING', 'APPROVED')`,
    [row.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
    action: "approval.request.expired", objectType: "approval_request", objectId: row.id,
    outcome: "FAILURE", requestId, reason: "审批有效期已过",
    details: { previousStatus: row.status },
  });
}

/**
 * 写侧与读侧共用的资格上下文装配：候选归属、本人 2FA 与游戏范围当场复核；
 * 目标对象当前状态只在读取预检时由业务投影带入，写侧仍由领域执行器再校验。
 */
async function buildApprovalActionContext(
  client: Pool | PoolClient,
  row: RequestRow,
  context: AdminContext,
  access: EffectiveAdminAccess,
  options: { testOperationsEnabled: boolean; executorAssembled: boolean; includeStatePreconditions: boolean; targetEntitlementStatus?: string | null; policyDraftStatus?: string | null },
): Promise<ApprovalActionContext> {
  const candidate = await client.query(
    `SELECT 1 FROM "zzsh_iam"."approval_request_candidate" WHERE "request_id" = $1 AND "admin_user_id" = $2`,
    [row.id, context.userId],
  );
  const self = await adminByUserId(client, context.userId);
  const gameId = payloadGameId(row.operationPayload);
  const scopeNeeded = gameId !== null && membershipOperationRequiresGameScope(row.operationCode) && !access.isBoss;
  // 不带游戏目标或本人是 Boss 时范围判定不会触发，这里用中性全范围值省掉一次查询。
  const gameScope: AdminGameScope = scopeNeeded ? await readAdminGameScope(client, context.userId) : { mode: "ALL_GAMES", gameIds: [] };
  return {
    row,
    userId: context.userId,
    access,
    twoFactorEnabled: self.twoFactorEnabled,
    gameScope,
    isCandidate: candidate.rows.length === 1,
    testOperationsEnabled: options.testOperationsEnabled,
    executorAssembled: options.executorAssembled,
    targetEntitlementStatus: options.targetEntitlementStatus,
    policyDraftStatus: options.policyDraftStatus,
    includeStatePreconditions: options.includeStatePreconditions,
  };
}

async function decideRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId", "decision", "reason", "finalPayload", "expectedPayloadHash"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const decision = requiredString(body, "decision", 16);
  if (decision !== "APPROVE" && decision !== "REJECT") invalid("Decision is invalid");
  const reason = optionalString(body, "reason", 500)?.trim();
  if (decision === "REJECT" && (!reason || reason.length < 3)) invalid("A rejection reason is required");
  const final = body.finalPayload === undefined ? null : immutablePayload({ payload: body.finalPayload });
  const expectedHash = optionalString(body, "expectedPayloadHash", 64);
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedHash)) invalid("Expected payload hash is invalid");
  if (final && expectedHash === undefined) invalid("An amended approval requires the original payload hash");
  if (decision !== "APPROVE" && (final || expectedHash !== undefined)) invalid("A rejection cannot amend the payload");
  const action: ApprovalAction = decision === "APPROVE" ? "approve" : "reject";
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.decide,
    resourceId: targetRequestId,
    fingerprint: approvalFingerprint(final || expectedHash !== undefined ? [targetRequestId, decision, reason ?? "", expectedHash, final?.hash ?? ""] : [targetRequestId, decision, reason ?? ""]),
    authorize: async (client) => {
      const access = await requireWriteAccess(client, context, ADMIN_PERMISSION.approvalRequestApprove);
      const row = await readRequestForUpdate(client, targetRequestId);
      const input = await buildApprovalActionContext(client, row, context, access, {
        testOperationsEnabled: options.testOperationsEnabled,
        executorAssembled: Boolean(options.approvalOperationExecutor),
        includeStatePreconditions: false,
      });
      assertApprovalAction(evaluateApprovalActions(input), action);
      if (final) assertFinalPayloadTarget(row, final.value, expectedHash!);
      else if (expectedHash !== undefined) {
        if (!AMENDABLE_ENTITLEMENTS.has(row.operationCode)) invalid("This operation does not support amended approval");
        if (row.operationPayloadHash !== expectedHash) conflict("Approval request payload changed; reload before deciding");
      }
    },
    action: async (client) => {
      const row = await readRequestForUpdate(client, targetRequestId);
      if (row.status !== "PENDING") conflict("This approval request is already closed");
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await expireRequest(client, row, context, requestId);
        return approvalErrorReceipt(409, API_V1_ERROR_CODES.CONFLICT, "Approval request expired before the decision", requestId, "EXPIRED");
      }
      if (final) await validateMembershipEntitlementPayload(client, final.value, row.requestedBy);
      const finalStatus: ApprovalStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_decision" ("id", "request_id", "approver_admin_id", "decision", "reason", "final_payload", "final_payload_hash") VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [`approval_dec_${randomUUID().replaceAll("-", "")}`, row.id, context.userId, finalStatus, reason ?? null, final?.raw ?? null, final?.hash ?? null],
      );
      await client.query(
        `UPDATE "zzsh_iam"."approval_request" SET "status" = $1, "decided_at" = clock_timestamp(), "decided_by" = $2, "decision_reason" = $3, "status_reason" = $4 WHERE "id" = $5 AND "status" = 'PENDING'`,
        [finalStatus, context.userId, reason ?? null, finalStatus === "REJECTED" ? "审批已拒绝" : "审批已通过，等待执行", row.id],
      );
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: decision === "APPROVE" ? "approval.request.approved" : "approval.request.rejected",
        objectType: "approval_request", objectId: row.id, outcome: "SUCCESS", requestId, reason,
        details: { decision: finalStatus, summary: row.summary, operationCode: row.operationCode, requestPayloadHash: row.operationPayloadHash, finalPayloadHash: final?.hash ?? null, approvedPayloadHash: final?.hash ?? row.operationPayloadHash },
      });
      return { status: 200, body: { requestId: row.id, approvalRequestId: row.id, decision: finalStatus, status: finalStatus, ...(final || expectedHash !== undefined ? { requestPayloadHash: row.operationPayloadHash, finalPayloadHash: final?.hash ?? null, approvedPayloadHash: final?.hash ?? row.operationPayloadHash } : {}) } };
    },
  });
}

async function appendCandidate(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId", "username", "reason"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const targetUsername = username(requiredString(body, "username", 64));
  const reason = requiredString(body, "reason", 500).trim();
  if (reason.length < 3) invalid("A reason is required");
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.addCandidate,
    resourceId: targetRequestId,
    fingerprint: approvalFingerprint([targetRequestId, targetUsername, reason]),
    authorize: async (client) => {
      const access = await requireWriteAccess(client, context, ADMIN_PERMISSION.approvalRequestAddApprover);
      const row = await readRequestForUpdate(client, targetRequestId);
      const input = await buildApprovalActionContext(client, row, context, access, {
        testOperationsEnabled: options.testOperationsEnabled,
        executorAssembled: Boolean(options.approvalOperationExecutor),
        includeStatePreconditions: false,
      });
      assertApprovalAction(evaluateApprovalActions(input), "addCandidate");
    },
    action: async (client) => {
      const row = await readRequestForUpdate(client, targetRequestId);
      if (row.status !== "PENDING") conflict("Only a pending request can receive an additional candidate");
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await expireRequest(client, row, context, requestId);
        return approvalErrorReceipt(409, API_V1_ERROR_CODES.CONFLICT, "Approval request expired before the candidate was added", requestId, "EXPIRED");
      }
      const target = (await adminsByUsernames(client, [targetUsername]))[0]!;
      if (target.id === row.requestedBy) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "The requester cannot be added as an approver");
      const [candidateState] = await candidateAccessStates(client, [target.id]).then((map) => [map.get(target.id)]);
      if (!candidateState || candidateReasonCode(candidateState, row) !== "OK") {
        throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "The additional candidate is not currently eligible");
      }
      const inserted = await client.query(
        `INSERT INTO "zzsh_iam"."approval_request_candidate" ("request_id", "admin_user_id", "source", "template_version", "added_by") VALUES ($1, $2, 'APPENDED', $3, $4) ON CONFLICT ("request_id", "admin_user_id") DO NOTHING`,
        [row.id, target.id, row.templateVersion, context.userId],
      );
      if (inserted.rowCount !== 1) conflict("This administrator is already a candidate");
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: "approval.request.candidate_added", objectType: "approval_request", objectId: row.id,
        outcome: "SUCCESS", requestId, reason,
        details: { candidateUsername: target.username, source: "APPENDED" },
      });
      return { status: 200, body: { requestId: row.id, approvalRequestId: row.id, candidateUsername: target.username, status: "CANDIDATE_ADDED" } };
    },
  });
}

async function withdrawRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId", "reason"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  const reason = optionalString(body, "reason", 500)?.trim() || "申请人撤回";
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.withdraw,
    resourceId: targetRequestId,
    fingerprint: approvalFingerprint([targetRequestId, reason]),
    authorize: async (client) => {
      const access = await lockActor(client, context.userId);
      const row = await readRequestForUpdate(client, targetRequestId);
      const input = await buildApprovalActionContext(client, row, context, access, {
        testOperationsEnabled: options.testOperationsEnabled,
        executorAssembled: Boolean(options.approvalOperationExecutor),
        includeStatePreconditions: false,
      });
      assertApprovalAction(evaluateApprovalActions(input), "withdraw");
    },
    action: async (client) => {
      const row = await readRequestForUpdate(client, targetRequestId);
      if (row.status !== "PENDING") conflict("Only a pending request can be withdrawn");
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await expireRequest(client, row, context, requestId);
        return approvalErrorReceipt(409, API_V1_ERROR_CODES.CONFLICT, "Approval request expired before withdrawal", requestId, "EXPIRED");
      }
      const updated = await client.query(
        `UPDATE "zzsh_iam"."approval_request" SET "status" = 'CANCELLED', "status_reason" = $1 WHERE "id" = $2 AND "status" = 'PENDING'`,
        [row.requestedBy === context.userId ? "申请人已撤回" : "Boss 已撤回", row.id],
      );
      if (updated.rowCount !== 1) conflict("This approval request is already closed");
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: "approval.request.withdrawn", objectType: "approval_request", objectId: row.id,
        outcome: "SUCCESS", requestId, reason,
        details: { summary: row.summary, operationCode: row.operationCode, withdrawnByRequester: row.requestedBy === context.userId },
      });
      return { status: 200, body: { requestId: row.id, approvalRequestId: row.id, status: "CANCELLED" } };
    },
  });
}

async function executeRequest(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const body = bodyOf(request);
  assertFields(body, ["requestId"]);
  const targetRequestId = requiredString(body, "requestId", 128);
  await runApprovalWrite(request, response, requestId, options, context, {
    operation: APPROVAL_WRITE_OPERATIONS.execute,
    resourceId: targetRequestId,
    fingerprint: approvalFingerprint([targetRequestId]),
    authorize: async (client) => {
      const access = await requireWriteAccess(client, context, ADMIN_PERMISSION.approvalRequestExecute);
      const row = await readRequestForUpdate(client, targetRequestId);
      const input = await buildApprovalActionContext(client, row, context, access, {
        testOperationsEnabled: options.testOperationsEnabled,
        executorAssembled: Boolean(options.approvalOperationExecutor),
        includeStatePreconditions: false,
      });
      assertApprovalAction(evaluateApprovalActions(input), "execute");
    },
    action: async (client) => {
      const row = await readRequestForUpdate(client, targetRequestId);
      if (new Date(row.expiresAt).getTime() <= Date.now() && (row.status === "PENDING" || row.status === "APPROVED")) {
        await expireRequest(client, row, context, requestId);
        return approvalErrorReceipt(409, API_V1_ERROR_CODES.CONFLICT, "Approved request expired before execution", requestId, "EXPIRED");
      }
      if (row.status !== "APPROVED") conflict("Only an approved request can be executed");
      const decision = (await readDecisions(client, [row])).get(row.id);
      if (!decision || decision.decision !== "APPROVED" || decision.approverId !== row.decidedBy) conflict("Approved decision is missing or inconsistent");
      const final = verifiedFinalPayload(row, decision);
      const registration = approvalRegistration(row.operationCode);
      let executionStatus: "SUCCEEDED" | "FAILED" = "SUCCEEDED";
      let resultCode: string;
      let resultDetail: string;
      let resultRef: string | null = null;
      if (row.operationCode === TEST_OPERATION) {
        const outcome = row.operationPayload.outcome;
        if (typeof outcome !== "string" || !TEST_OUTCOMES.has(outcome)) conflict("The test operation payload is invalid");
        executionStatus = outcome === "SUCCESS" ? "SUCCEEDED" : "FAILED";
        resultCode = outcome === "SUCCESS" ? "TEST_ACTION_EXECUTED" : "TEST_ACTION_FAILED";
        resultDetail = outcome === "SUCCESS" ? "本地非资金测试动作已执行一次" : "本地非资金测试动作按载荷返回失败";
      } else {
        const executed = await options.approvalOperationExecutor!(client, {
          requestId: row.id,
          operationCode: row.operationCode,
          payloadVersion: row.payloadVersion,
          operationPayload: final?.value ?? row.operationPayload,
          operationPayloadHash: final?.hash ?? row.operationPayloadHash,
          requestedBy: row.requestedBy,
          decidedBy: row.decidedBy!,
          expiresAt: row.expiresAt,
        }, { userId: context.userId, sessionId: context.sessionId }, requestId);
        resultCode = executed.resultCode;
        resultDetail = executed.resultDetail ?? "会员操作已执行";
        resultRef = executed.resultDetail ?? null;
      }
      await client.query(
        `INSERT INTO "zzsh_iam"."approval_execution" ("id", "request_id", "operation_code", "status", "result_code", "result_detail", "executed_by") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [`approval_exec_${randomUUID().replaceAll("-", "")}`, row.id, row.operationCode, executionStatus, resultCode, resultDetail, context.userId],
      );
      await client.query(
        `UPDATE "zzsh_iam"."approval_request" SET "status" = $1, "status_reason" = $2 WHERE "id" = $3 AND "status" = 'APPROVED'`,
        [executionStatus === "SUCCEEDED" ? "EXECUTED" : "EXECUTION_FAILED", executionStatus === "SUCCEEDED" ? "执行成功" : "执行失败，结果已记录", row.id],
      );
      await recordAudit(client, {
        actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
        action: "approval.execution.completed", objectType: "approval_request", objectId: row.id,
        outcome: executionStatus === "SUCCEEDED" ? "SUCCESS" : "FAILURE", requestId,
        details: { operationCode: row.operationCode, executionStatus, resultCode, summary: row.summary, requestPayloadHash: row.operationPayloadHash, finalPayloadHash: final?.hash ?? null, approvedPayloadHash: final?.hash ?? row.operationPayloadHash },
      });
      return {
        status: 200,
        body: {
          requestId: row.id,
          approvalRequestId: row.id,
          status: executionStatus === "SUCCEEDED" ? "EXECUTED" : "EXECUTION_FAILED",
          executionStatus,
          resultCode,
          executionMode: registration?.executionMode ?? APPROVAL_EXECUTION_MODE.unsupported,
          businessResultRef: resultRef,
          ...(final ? { requestPayloadHash: row.operationPayloadHash, finalPayloadHash: final.hash, approvedPayloadHash: final.hash } : {}),
        },
      };
    },
  });
}

async function listRequests(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader, pending: boolean): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, pending ? ADMIN_PERMISSION.approvalRequestApprove : ADMIN_PERMISSION.approvalRequestRead);
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const cursor = queryValue(request, "cursor");
  if (cursor && cursor.length > 256) invalid("Cursor is invalid");
  let cursorValues: [Date, string] | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
      if (!decoded.createdAt || !decoded.id) invalid("Cursor is invalid");
      cursorValues = [new Date(decoded.createdAt), decoded.id];
      if (Number.isNaN(cursorValues[0].getTime())) invalid("Cursor is invalid");
    } catch {
      invalid("Cursor is invalid");
    }
  }
  const values: unknown[] = [limit + 1];
  const conditions = pending
    ? [`c."admin_user_id" = $${values.push(context.userId)}`, `r."status" = 'PENDING'`, `r."expires_at" > clock_timestamp()`, `r."requested_by" <> $${values.push(context.userId)}`]
    : [`r."requested_by" = $${values.push(context.userId)}`];
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    const timeParam = values.length - 1;
    const idParam = values.length;
    conditions.push(`(r."created_at" < $${timeParam} OR (r."created_at" = $${timeParam} AND r."id" < $${idParam}))`);
  }
  const result = await options.pool.query<RequestRow & { requesterUsername: string | null; requesterDisplayUsername: string | null; requesterName: string }>(
    `SELECT r."id", r."template_id" AS "templateId", r."template_version" AS "templateVersion", r."operation_code" AS "operationCode", r."trigger_condition" AS "triggerCondition", r."payload_version" AS "payloadVersion", r."operation_payload" AS "operationPayload", r."operation_payload_hash" AS "operationPayloadHash", r."summary", r."requested_by" AS "requestedBy", r."status", r."status_reason" AS "statusReason", r."expires_at" AS "expiresAt", r."created_at" AS "createdAt", r."decided_at" AS "decidedAt", r."decided_by" AS "decidedBy", r."decision_reason" AS "decisionReason", r."supersedes_request_id" AS "supersedesRequestId", r."superseded_by_request_id" AS "supersededByRequestId", u."username" AS "requesterUsername", u."displayUsername" AS "requesterDisplayUsername", u."name" AS "requesterName"
       FROM "zzsh_iam"."approval_request" r
       JOIN "zzsh_auth_admin"."user" u ON u."id" = r."requested_by"
       ${pending ? `JOIN "zzsh_iam"."approval_request_candidate" c ON c."request_id" = r."id"` : ""}
      WHERE ${conditions.join(" AND ")}
      ORDER BY r."created_at" DESC, r."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const views = await approvalReadViews(options.pool, context, access, rows, options.testOperationsEnabled, Boolean(options.approvalOperationExecutor));
  const next = hasMore ? Buffer.from(JSON.stringify({ createdAt: iso(rows.at(-1)?.createdAt), id: rows.at(-1)?.id })).toString("base64url") : null;
  sendSuccess(response, {
    requests: rows.map((row) => ({
      requestId: row.id,
      operationCode: row.operationCode,
      triggerCondition: row.triggerCondition,
      payloadVersion: row.payloadVersion,
      payloadHash: row.operationPayloadHash,
      summary: row.summary,
      status: virtualRequestStatus(row),
      statusReason: row.statusReason,
      requester: { username: row.requesterUsername ?? "unknown", displayUsername: row.requesterDisplayUsername ?? row.requesterUsername?.toUpperCase() ?? "UNKNOWN", name: row.requesterName },
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      business: views.business.get(row.id) ?? null,
      actions: views.actions.get(row.id) ?? [],
      candidateAvailability: views.candidates.get(row.id) ?? null,
    })),
    nextCursor: next,
    scope: pending ? "PENDING_FOR_CURRENT_ADMIN" : "REQUESTED_BY_CURRENT_ADMIN",
    ...(access.isBoss ? { includesBossScope: true } : {}),
  }, requestId);
}

type CandidateAccessState = {
  id: string;
  username: string | null;
  displayUsername: string | null;
  name: string;
  status: Person["status"];
  isBoss: boolean;
  twoFactorEnabled: boolean;
  permissions: string[];
  gameScope: AdminGameScope;
};

/**
 * 一条集合化查询取回候选的身份、状态、2FA、有效权限码与游戏范围。
 * 权限语义与 loadEffectiveAdminAccess 完全一致：角色授权并上个人 ALLOW，再减去个人 DENY，Boss 不受 DENY 影响。
 * 具体申请的资格由调用方按上下文计算，因此候选选择器不会给出写事务必然拒绝的人。
 */
async function candidateAccessStates(client: Pool | PoolClient, adminIds: readonly string[]): Promise<Map<string, CandidateAccessState>> {
  const result = await client.query<{
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string;
    status: Person["status"];
    isBoss: boolean;
    twoFactorEnabled: boolean;
    grantedCodes: string[];
    deniedCodes: string[];
    scopeMode: string | null;
    gameIds: string[] | null;
  }>(
    `WITH granted_codes AS (
       SELECT ur."admin_user_id" AS "adminId", rp."permission_code" AS "code"
         FROM "zzsh_iam"."admin_user_role" ur
         JOIN "zzsh_iam"."admin_role" r ON r."id" = ur."role_id" AND r."status" = 'ACTIVE'
         JOIN "zzsh_iam"."admin_role_permission" rp ON rp."role_id" = r."id"
        WHERE ($1::text[] = '{}'::text[] OR ur."admin_user_id" = ANY($1::text[]))
       UNION
       SELECT up."admin_user_id" AS "adminId", up."permission_code" AS "code"
         FROM "zzsh_iam"."admin_user_permission" up
        WHERE up."effect" = 'ALLOW' AND ($1::text[] = '{}'::text[] OR up."admin_user_id" = ANY($1::text[]))
     ),
     denied_codes AS (
       SELECT "admin_user_id" AS "adminId", "permission_code" AS "code"
         FROM "zzsh_iam"."admin_user_permission"
        WHERE "effect" = 'DENY' AND ($1::text[] = '{}'::text[] OR "admin_user_id" = ANY($1::text[]))
     )
     SELECT u."id", u."username", u."displayUsername", u."name", s."status", s."is_boss" AS "isBoss",
            u."twoFactorEnabled" = true AS "twoFactorEnabled",
            COALESCE((SELECT array_agg(DISTINCT g."code") FROM granted_codes g WHERE g."adminId" = u."id"), '{}') AS "grantedCodes",
            COALESCE((SELECT array_agg(DISTINCT d."code") FROM denied_codes d WHERE d."adminId" = u."id"), '{}') AS "deniedCodes",
            s."game_scope_mode" AS "scopeMode",
            COALESCE((SELECT array_agg(sc."game_id") FROM "zzsh_supply"."admin_supply_scope" sc WHERE sc."admin_user_id" = u."id"), '{}') AS "gameIds"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE ($1::text[] = '{}'::text[] OR u."id" = ANY($1::text[]))`,
    [[...adminIds]],
  );
  return new Map(result.rows.map((row) => [row.id, {
    id: row.id,
    username: row.username,
    displayUsername: row.displayUsername,
    name: row.name,
    status: row.status,
    isBoss: row.isBoss,
    twoFactorEnabled: row.twoFactorEnabled,
    permissions: row.grantedCodes.filter((code) => !row.deniedCodes.includes(code)),
    gameScope: { mode: row.scopeMode === "ALL_GAMES" ? "ALL_GAMES" : "SELECTED_GAMES", gameIds: row.gameIds ?? [] },
  }]));
}

function candidatePermission(state: CandidateAccessState, code: string): boolean {
  return state.status === "ACTIVE" && (state.isBoss || state.permissions.includes(code));
}

/**
 * 候选资格的单一来源：不带申请时给出模板级通用资格（与追加候选写事务的历史口径一致），
 * 带申请时再核该操作 DECIDE 阶段的业务权限与目标游戏范围，选择器与统计因此不可能互相矛盾。
 */
function candidateReasonCode(state: CandidateAccessState, row?: RequestRow): string {
  if (state.status !== "ACTIVE") return "CANDIDATE_NOT_ACTIVE";
  if (!candidatePermission(state, ADMIN_PERMISSION.approvalRequestApprove)) return "PERMISSION_REQUIRED";
  if (!state.twoFactorEnabled) return "TWO_FACTOR_REQUIRED";
  if (!row) return "OK";
  const business = membershipBusinessPermission(row.operationCode, "DECIDE");
  if (membershipDecisionRequiresBoss(row.operationCode) && !state.isBoss) return "BUSINESS_PERMISSION_REQUIRED";
  if (business && !candidatePermission(state, business)) return "BUSINESS_PERMISSION_REQUIRED";
  if (businessScopeDenied({ isBoss: state.isBoss, gameScope: state.gameScope }, row.operationCode, row.operationPayload)) return "GAME_SCOPE_DENIED";
  return "OK";
}

/** 通用审批资格：模板候选与追加候选的可选择下限。 */
function candidateCanApprove(state: CandidateAccessState): boolean {
  return candidateReasonCode(state) === "OK";
}

/** 本申请能否由该候选作出决定：通用资格之外再核业务权限与目标游戏范围。 */
function candidateCanDecideRequest(state: CandidateAccessState, row: RequestRow): boolean {
  return candidateReasonCode(state, row) === "OK";
}

/** 游戏范围谓词的单一实现：申请侧与候选侧同一判据。 */
function businessScopeDenied(state: { isBoss: boolean; gameScope: AdminGameScope }, operationCode: string, payload: Record<string, unknown>): boolean {
  const gameId = payloadGameId(payload);
  if (!gameId || !membershipOperationRequiresGameScope(operationCode)) return false;
  if (state.isBoss || isAllGamesScope(state.gameScope)) return false;
  return !scopeAllowsGame(state.gameScope, false, gameId);
}

async function candidateRowsFor(client: Pool | PoolClient, requestIds: readonly string[]): Promise<Array<{ requestId: string; adminUserId: string }>> {
  if (requestIds.length === 0) return [];
  const result = await client.query<{ requestId: string; adminUserId: string }>(
    `SELECT "request_id" AS "requestId", "admin_user_id" AS "adminUserId" FROM "zzsh_iam"."approval_request_candidate" WHERE "request_id" = ANY($1::text[])`,
    [[...requestIds]],
  );
  return result.rows;
}

type ApprovalReadViews = {
  business: Map<string, Record<string, unknown>>;
  actions: Map<string, ApprovalActionEligibility[]>;
  candidates: Map<string, { total: number; eligible: number; blockingReasonCode: string | null }>;
  decisions: Map<string, DecisionRow>;
};

/**
 * 一页申请的读取装配：业务视图、逐单当前动作资格与候选可用聚合。
 * 查询条数只随业务种类变化，不随本页行数变化。
 */
async function approvalReadViews(
  client: Pool | PoolClient,
  context: AdminContext,
  access: EffectiveAdminAccess,
  rows: readonly RequestRow[],
  testOperationsEnabled: boolean,
  executorAssembled: boolean,
): Promise<ApprovalReadViews> {
  const decisions = await readDecisions(client, rows);
  const facts: ApprovalRequestFacts[] = rows.map((row) => ({
    id: row.id,
    operationCode: row.operationCode,
    payloadVersion: row.payloadVersion,
    operationPayload: row.operationPayload,
    operationPayloadHash: row.operationPayloadHash,
    summary: row.summary,
    requestedBy: row.requestedBy,
    status: row.status,
    decidedBy: row.decidedBy,
    expiresAt: row.expiresAt,
    finalPayload: decisions.get(row.id)?.finalPayload ?? null,
    finalPayloadHash: decisions.get(row.id)?.finalPayloadHash ?? null,
  }));
  const [gameScope, self, candidateRows, viewerCandidateRows] = await Promise.all([
    readAdminGameScope(client, context.userId),
    adminByUserId(client, context.userId),
    candidateRowsFor(client, rows.map((row) => row.id)),
    rows.length > 0
      ? client.query<{ requestId: string }>(
          `SELECT "request_id" AS "requestId" FROM "zzsh_iam"."approval_request_candidate" WHERE "request_id" = ANY($1::text[]) AND "admin_user_id" = $2`,
          [rows.map((row) => row.id), context.userId],
        )
      : Promise.resolve({ rows: [] as { requestId: string }[] }),
  ]);
  const projection = await projectApprovalBusinesses(client, facts, { userId: context.userId, access, gameScope });
  const states = await candidateAccessStates(client, [...new Set(candidateRows.map((row) => row.adminUserId))]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const isViewerCandidate = new Set(viewerCandidateRows.rows.map((row) => row.requestId));
  const candidates = new Map<string, { total: number; eligible: number; blockingReasonCode: string | null }>();
  for (const row of rows) candidates.set(row.id, { total: 0, eligible: 0, blockingReasonCode: null });
  for (const item of candidateRows) {
    const entry = candidates.get(item.requestId);
    const row = byId.get(item.requestId);
    const state = states.get(item.adminUserId);
    if (!entry || !row || !state) continue;
    entry.total += 1;
    if (item.adminUserId !== row.requestedBy && candidateCanDecideRequest(state, row)) entry.eligible += 1;
  }
  for (const entry of candidates.values()) {
    if (entry.total === 0) entry.blockingReasonCode = "NO_CANDIDATE_SNAPSHOT";
    else if (entry.eligible === 0) entry.blockingReasonCode = "NO_ELIGIBLE_CANDIDATE";
  }
  const actions = new Map<string, ApprovalActionEligibility[]>();
  for (const row of rows) {
    const state = projection.objectStates.get(row.id);
    actions.set(row.id, evaluateApprovalActions({
      row,
      userId: context.userId,
      access,
      twoFactorEnabled: self.twoFactorEnabled,
      gameScope,
      isCandidate: isViewerCandidate.has(row.id),
      testOperationsEnabled,
      executorAssembled,
      targetEntitlementStatus: state?.targetEntitlementStatus,
      policyDraftStatus: state?.policyDraftStatus,
    }));
  }
  return { business: projection.views, actions, candidates, decisions };
}

function sanitizeDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetail);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    result[key] = sanitizeDetail(child);
  }
  return result;
}

type AuditRow = {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  actorDisplayUsername: string | null;
  actorName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
  requestId: string | null;
  occurredAt: Date | string;
  details: Record<string, unknown>;
};

function auditView(row: AuditRow): Record<string, unknown> {
  return {
    eventId: row.id,
    actor: { username: row.actorUsername ?? "系统", displayUsername: row.actorDisplayUsername ?? row.actorUsername?.toUpperCase() ?? "系统", name: row.actorName ?? "系统" },
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    outcome: row.outcome,
    reason: row.reason,
    requestId: row.requestId,
    occurredAt: iso(row.occurredAt),
    details: sanitizeDetail(row.details),
  };
}

export async function requestScope(pool: Pool | PoolClient, userId: string, requestId: string, isBoss: boolean): Promise<boolean> {
  if (isBoss) return true;
  const result = await pool.query<{ allowed: boolean }>(
    `SELECT (r."requested_by" = $1 OR EXISTS (SELECT 1 FROM "zzsh_iam"."approval_request_candidate" c WHERE c."request_id" = r."id" AND c."admin_user_id" = $1)) AS allowed
       FROM "zzsh_iam"."approval_request" r WHERE r."id" = $2`,
    [userId, requestId],
  );
  return result.rows[0]?.allowed === true;
}

async function requestDetail(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalRequestRead);
  const targetRequestId = queryValue(request, "requestId");
  if (!targetRequestId || targetRequestId.length > 128) invalid("Request id is required");
  if (!(await requestScope(options.pool, context.userId, targetRequestId, access.isBoss))) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  const result = await options.pool.query<RequestRow>(
    `SELECT "id", "template_id" AS "templateId", "template_version" AS "templateVersion", "operation_code" AS "operationCode", "trigger_condition" AS "triggerCondition", "payload_version" AS "payloadVersion", "operation_payload" AS "operationPayload", "operation_payload_hash" AS "operationPayloadHash", "summary", "requested_by" AS "requestedBy", "status", "status_reason" AS "statusReason", "expires_at" AS "expiresAt", "created_at" AS "createdAt", "decided_at" AS "decidedAt", "decided_by" AS "decidedBy", "decision_reason" AS "decisionReason", "supersedes_request_id" AS "supersedesRequestId", "superseded_by_request_id" AS "supersededByRequestId"
       FROM "zzsh_iam"."approval_request" WHERE "id" = $1`,
    [targetRequestId],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  const requester = await adminByUserId(options.pool, row.requestedBy);
  const candidates = await requestCandidateRows(options.pool, row.id);
  const execution = await options.pool.query<{ status: string; resultCode: string; resultDetail: string | null; executedBy: string; createdAt: Date | string; completedAt: Date | string }>(
    `SELECT "status", "result_code" AS "resultCode", "result_detail" AS "resultDetail", "executed_by" AS "executedBy", "created_at" AS "createdAt", "completed_at" AS "completedAt" FROM "zzsh_iam"."approval_execution" WHERE "request_id" = $1`,
    [row.id],
  );
  const history = await options.pool.query<AuditRow>(
    `SELECT e."id", e."actor_id" AS "actorId", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName", e."action", e."object_type" AS "objectType", e."object_id" AS "objectId", e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id"
      WHERE e."action" LIKE 'approval.%' AND e."object_type" = 'approval_request' AND e."object_id" = $1
      ORDER BY e."occurred_at", e."id"`,
    [row.id],
  );
  const status = virtualRequestStatus(row);
  const views = await approvalReadViews(options.pool, context, access, [row], options.testOperationsEnabled, Boolean(options.approvalOperationExecutor));
  const decision = views.decisions.get(row.id);
  const mayAmend = AMENDABLE_ENTITLEMENTS.has(row.operationCode) && views.actions.get(row.id)?.some((action) => action.action === "approve" && action.allowed);
  const editablePayload = mayAmend ? editableEntitlementApprovalPayload(row.operationPayload) : null;
  sendSuccess(response, {
    requestId: row.id,
    status,
    statusReason: status === "EXPIRED" ? "审批有效期已过" : row.statusReason,
    operation: { code: row.operationCode, triggerCondition: row.triggerCondition, payloadVersion: row.payloadVersion, payloadHash: row.operationPayloadHash, executionMode: views.business.get(row.id)?.executionMode ?? null, payload: row.operationCode === TEST_OPERATION ? sanitizeDetail(row.operationPayload) : undefined },
    summary: row.summary,
    business: views.business.get(row.id) ?? null,
    entitlementAmendment: editablePayload ? { expectedPayloadHash: row.operationPayloadHash, editablePayload } : null,
    actions: views.actions.get(row.id) ?? [],
    candidateAvailability: views.candidates.get(row.id) ?? null,
    template: { id: row.templateId, version: row.templateVersion },
    requester: { username: requester.username, displayUsername: requester.displayUsername, name: requester.name, status: requester.status },
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    decision: decision ? { decision: decision.decision, reason: decision.reason, approver: await adminByUserId(options.pool, decision.approverId), createdAt: iso(decision.createdAt), requestPayloadHash: row.operationPayloadHash, finalPayloadHash: decision.finalPayloadHash ?? null, approvedPayloadHash: decision.finalPayloadHash ?? row.operationPayloadHash } : null,
    execution: execution.rows[0] ? { status: execution.rows[0].status, resultCode: execution.rows[0].resultCode, resultDetail: execution.rows[0].resultDetail, executor: await adminByUserId(options.pool, execution.rows[0].executedBy), createdAt: iso(execution.rows[0].createdAt), completedAt: iso(execution.rows[0].completedAt) } : null,
    candidates: await Promise.all(candidates.map((item) => candidateView(options.pool, item.candidate, item.source, item.addedBy))),
    history: history.rows.map(auditView),
    supersedesRequestId: row.supersedesRequestId,
    supersededByRequestId: row.supersededByRequestId,
  }, requestId);
}

async function auditEvents(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalAuditRead);
  const rawLimit = queryValue(request, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) invalid("Limit is invalid");
  const cursor = queryValue(request, "cursor");
  let cursorValues: [Date, string] | undefined;
  if (cursor) {
    if (cursor.length > 256) invalid("Cursor is invalid");
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { occurredAt?: string; id?: string };
      if (!decoded.occurredAt || !decoded.id) invalid("Cursor is invalid");
      cursorValues = [new Date(decoded.occurredAt), decoded.id];
      if (Number.isNaN(cursorValues[0].getTime())) invalid("Cursor is invalid");
    } catch {
      invalid("Cursor is invalid");
    }
  }
  const action = queryValue(request, "action");
  const targetRequestId = queryValue(request, "requestId");
  const actorUsername = queryValue(request, "actorUsername")?.trim().toLowerCase();
  const objectType = queryValue(request, "objectType");
  if (action && (!action.startsWith("approval.") || action.length > 128)) invalid("Action filter is invalid");
  if (targetRequestId && targetRequestId.length > 128) invalid("Request id is invalid");
  if (actorUsername && !USERNAME_PATTERN.test(actorUsername)) invalid("Actor filter is invalid");
  if (objectType && !/^[a-z][a-z0-9_]{0,63}$/.test(objectType)) invalid("Object filter is invalid");
  const values: unknown[] = access.isBoss ? [limit + 1] : [limit + 1, context.userId];
  const conditions = [
    `e."action" LIKE 'approval.%'`,
    access.isBoss ? "TRUE" : `(e."actor_id" = $2 OR (e."object_type" = 'approval_request' AND (r."requested_by" = $2 OR EXISTS (SELECT 1 FROM "zzsh_iam"."approval_request_candidate" rc WHERE rc."request_id" = r."id" AND rc."admin_user_id" = $2))))`,
  ];
  if (action) conditions.push(`e."action" = $${values.push(action)}`);
  if (targetRequestId) {
    const requestParameter = values.push(targetRequestId);
    conditions.push(`((e."object_type" = 'approval_request' AND e."object_id" = $${requestParameter}) OR (e."request_id" = $${requestParameter}))`);
  }
  if (actorUsername) conditions.push(`lower(COALESCE(u."username", '')) = $${values.push(actorUsername)}`);
  if (objectType) conditions.push(`e."object_type" = $${values.push(objectType)}`);
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    const timeParam = values.length - 1;
    const idParam = values.length;
    conditions.push(`(e."occurred_at" < $${timeParam} OR (e."occurred_at" = $${timeParam} AND e."id" < $${idParam}))`);
  }
  const result = await options.pool.query<AuditRow>(
    `SELECT e."id", e."actor_id" AS "actorId", u."username" AS "actorUsername", u."displayUsername" AS "actorDisplayUsername", u."name" AS "actorName", e."action", e."object_type" AS "objectType", e."object_id" AS "objectId", e."outcome", e."reason", e."request_id" AS "requestId", e."occurred_at" AS "occurredAt", e."details"
       FROM "zzsh_iam"."audit_event" e
       LEFT JOIN "zzsh_auth_admin"."user" u ON u."id" = e."actor_id"
       LEFT JOIN "zzsh_iam"."approval_request" r ON e."object_type" = 'approval_request' AND e."object_id" = r."id"
      WHERE ${conditions.join(" AND ")}
      ORDER BY e."occurred_at" DESC, e."id" DESC
      LIMIT $1`,
    values,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const next = hasMore ? Buffer.from(JSON.stringify({ occurredAt: iso(rows.at(-1)?.occurredAt), id: rows.at(-1)?.id })).toString("base64url") : null;
  sendSuccess(response, { events: rows.map(auditView), nextCursor: next, scope: access.isBoss ? "BOSS_ALL_APPROVAL_EVENTS" : "ACTOR_OR_REQUEST_SCOPE" }, requestId);
}

/** 恢复合同只投影安全业务字段：绝不回载荷正文、token 或越权金额。 */
const RECEIPT_FIELDS = ["approvalRequestId", "status", "decision", "executionStatus", "resultCode", "executionMode", "businessResultRef", "templateVersion", "candidateCount", "candidateUsername", "expiresAt", "requestPayloadHash", "finalPayloadHash", "approvedPayloadHash"] as const;

function recoveryReceipt(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const error = source.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const value = error as Record<string, unknown>;
    return {
      rejection: {
        code: typeof value.code === "string" ? value.code : null,
        message: typeof value.message === "string" ? value.message : null,
        reasons: Array.isArray(value.reasons) ? value.reasons.filter((item): item is string => typeof item === "string") : [],
      },
    };
  }
  const receipt: Record<string, unknown> = {};
  for (const field of RECEIPT_FIELDS) {
    if (source[field] !== undefined) receipt[field] = source[field];
  }
  return receipt;
}

function approvalIdempotencyScopeKey(operation: string, principalId: string, resourceId: string | null): string {
  return JSON.stringify(["admin", principalId, operation, resourceId]);
}

/**
 * 抛出型的业务授权谓词：阶段业务权限 + 目标游戏范围。
 * 发起（含替代旧对象）与恢复合同共用它，因此同一身份同一申请在 POST 与 GET 上不会给出两种答案。
 */
async function assertBusinessAuthorization(
  client: Pool | PoolClient,
  adminUserId: string,
  access: EffectiveAdminAccess,
  operationCode: string,
  payload: Record<string, unknown>,
  stage: "REQUEST" | "DECIDE" | "EXECUTE",
): Promise<void> {
  requireMembershipBusinessPermission(access, operationCode, stage);
  if (businessScopeDenied({ isBoss: access.isBoss, gameScope: await readAdminGameScope(client, adminUserId) }, operationCode, payload)) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Approval authorization is not available: GAME_SCOPE_DENIED");
  }
}

/** 首次创建、重放与恢复共同检查新旧对象；旧申请已取消不影响原回执恢复。 */
async function assertCreateAuthorization(
  client: Pool | PoolClient,
  options: AuthSecurityOptions,
  context: AdminContext,
  access: EffectiveAdminAccess,
  operationCode: string,
  payload: Record<string, unknown>,
  supersedesRequestId: string | null | undefined,
): Promise<void> {
  requirePermission(access, ADMIN_PERMISSION.approvalRequestCreate);
  await assertBusinessAuthorization(client, context.userId, access, operationCode, payload, "REQUEST");
  if (!supersedesRequestId) return;
  const previous = await readRequestById(client, supersedesRequestId);
  if (!previous) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
  const input = await buildApprovalActionContext(client, previous, context, access, {
    testOperationsEnabled: options.testOperationsEnabled,
    executorAssembled: Boolean(options.approvalOperationExecutor),
    includeStatePreconditions: false,
  });
  assertApprovalAction(evaluateApprovalActions(input), "replace");
  await assertBusinessAuthorization(client, context.userId, access, previous.operationCode, previous.operationPayload, "REQUEST");
}

/**
 * 恢复读取使用与原命令重放同一套当前授权判定：身份、原操作所需权限、业务权限与对象范围，
 * 但排除首次命令的状态前置，已完成的命令因此仍可读出原回执。
 */
async function assertRecoveryAuthorization(
  pool: Pool,
  options: AuthSecurityOptions,
  context: AdminContext,
  access: EffectiveAdminAccess,
  operation: string,
  row: RequestRow,
): Promise<void> {
  if (operation === APPROVAL_WRITE_OPERATIONS.create) {
    requirePermission(access, ADMIN_PERMISSION.approvalRequestCreate);
    if (row.requestedBy !== context.userId && !access.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Approval receipt is outside the current request scope: OUT_OF_REQUEST_SCOPE");
    await assertCreateAuthorization(pool, options, context, access, row.operationCode, row.operationPayload, row.supersedesRequestId);
    return;
  }
  const action: ApprovalAction = operation === APPROVAL_WRITE_OPERATIONS.decide
    ? "approve"
    : operation === APPROVAL_WRITE_OPERATIONS.addCandidate
      ? "addCandidate"
      : "execute";
  const input = await buildApprovalActionContext(pool, row, context, access, {
    testOperationsEnabled: options.testOperationsEnabled,
    executorAssembled: Boolean(options.approvalOperationExecutor),
    includeStatePreconditions: false,
  });
  assertApprovalAction(evaluateApprovalActions(input), action);
}

async function recoveryRead(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalRequestRead);
  const operation = queryValue(request, "operation") ?? "";
  if (!(Object.values(APPROVAL_WRITE_OPERATIONS) as string[]).includes(operation)) invalid("Recovery operation is not supported");
  const key = queryValue(request, "key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) invalid("Recovery key is invalid");
  const targetRequestId = queryValue(request, "requestId");
  if (targetRequestId && targetRequestId.length > 128) invalid("Request id is invalid");
  const targetScoped = RECOVERY_TARGET_SCOPED.has(operation);
  if (targetScoped) {
    if (!targetRequestId) invalid("Request id is required for this operation");
    const targetRow = await readRequestById(options.pool, targetRequestId);
    if (!targetRow) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
    await assertRecoveryAuthorization(options.pool, options, context, access, operation, targetRow);
  } else if (targetRequestId) invalid("Request id does not apply to this operation");
  if (operation === APPROVAL_WRITE_OPERATIONS.configureTemplate) requirePermission(access, ADMIN_PERMISSION.approvalTemplateConfigure);
  const resourceId = targetScoped ? targetRequestId! : null;
  const row = (await options.pool.query<{ requestFingerprint: string; responseStatus: number; responseBody: unknown; createdAt: Date | string }>(
    `SELECT "request_fingerprint" AS "requestFingerprint", "response_status" AS "responseStatus", "response_body" AS "responseBody", "created_at" AS "createdAt"
       FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2`,
    [approvalIdempotencyScopeKey(operation, context.userId, resourceId), key],
  )).rows[0];
  if (!row) {
    sendSuccess(response, {
      knowledge: "UNRESOLVED",
      operation,
      key,
      targetRequestId: resourceId,
      explanationCode: "RECEIPT_NOT_FOUND",
      resolution: "UNKNOWN_NOT_ABSENT",
    }, requestId);
    return;
  }
  if (operation === APPROVAL_WRITE_OPERATIONS.create) {
    const stored = row.responseBody && typeof row.responseBody === "object" ? (row.responseBody as Record<string, unknown>).approvalRequestId : null;
    const created = typeof stored === "string" ? await readRequestById(options.pool, stored) : undefined;
    if (!created) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Approval receipt scope is unavailable: OUT_OF_REQUEST_SCOPE");
    await assertRecoveryAuthorization(options.pool, options, context, access, operation, created);
  }
  sendSuccess(response, {
    knowledge: "KNOWN",
    operation,
    key,
    targetRequestId: resourceId,
    fingerprint: row.requestFingerprint,
    committedAt: iso(row.createdAt),
    originalResponseStatus: row.responseStatus,
    outcome: row.responseStatus === 200 ? "ACCEPTED" : "REJECTED",
    receipt: recoveryReceipt(row.responseBody),
  }, requestId);
}

function evaluateInitiation(
  registration: ApprovalOperationRegistration,
  access: EffectiveAdminAccess,
  testOperationsEnabled: boolean,
): { allowed: boolean; reasonCode: string; requiredPermission: string } {
  const createPermission = ADMIN_PERMISSION.approvalRequestCreate;
  if (access.status !== "ACTIVE") return { allowed: false, reasonCode: "ACTOR_INACTIVE", requiredPermission: createPermission };
  if (registration.testOnly && !testOperationsEnabled) return { allowed: false, reasonCode: "TEST_OPERATION_DISABLED", requiredPermission: createPermission };
  if (!hasPermission(access, createPermission)) return { allowed: false, reasonCode: "PERMISSION_REQUIRED", requiredPermission: createPermission };
  if (registration.executionMode === APPROVAL_EXECUTION_MODE.sourceBusiness) {
    return { allowed: false, reasonCode: "INITIATED_FROM_SOURCE_BUSINESS", requiredPermission: createPermission };
  }
  const business = membershipBusinessPermission(registration.operationCode, "REQUEST");
  if (business && !access.isBoss && !hasPermission(access, business)) return { allowed: false, reasonCode: "BUSINESS_PERMISSION_REQUIRED", requiredPermission: business };
  return { allowed: true, reasonCode: "OK", requiredPermission: createPermission };
}

async function operationsRead(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await requireCurrentAccess(options.pool, context, ADMIN_PERMISSION.approvalRequestRead);
  const [templates, links] = await Promise.all([
    templateRows(options.pool),
    options.pool.query<{ templateId: string; adminUserId: string }>(`SELECT "template_id" AS "templateId", "admin_user_id" AS "adminUserId" FROM "zzsh_iam"."approval_template_candidate"`),
  ]);
  const states = await candidateAccessStates(options.pool, [...new Set(links.rows.map((row) => row.adminUserId))]);
  const grouped = new Map<string, { total: number; eligible: number }>();
  for (const link of links.rows) {
    const entry = grouped.get(link.templateId) ?? { total: 0, eligible: 0 };
    entry.total += 1;
    const state = states.get(link.adminUserId);
    if (state && candidateCanApprove(state)) entry.eligible += 1;
    grouped.set(link.templateId, entry);
  }
  const operations = APPROVAL_REGISTERED_OPERATIONS.map((registration) => ({
    operationCode: registration.operationCode,
    businessType: registration.businessType,
    title: registration.title,
    executionMode: registration.executionMode,
    testOnly: registration.testOnly,
    initiation: evaluateInitiation(registration, access, options.testOperationsEnabled),
    triggers: templates
      .filter((template) => template.operationCode === registration.operationCode)
      .map((template) => {
        const entry = grouped.get(template.id) ?? { total: 0, eligible: 0 };
        return {
          triggerCondition: template.triggerCondition,
          templateVersion: template.version,
          candidateTotal: entry.total,
          candidateEligible: entry.eligible,
          blockingReasonCode: entry.total === 0 ? "NO_CANDIDATE_SNAPSHOT" : entry.eligible === 0 ? "NO_ELIGIBLE_CANDIDATE" : null,
        };
      }),
  }));
  sendSuccess(response, {
    operations,
    unregisteredOperationPolicy: "未知操作只读展示并给出原因，不进入通用执行器",
    scope: "REGISTERED_OPERATIONS_FOR_CURRENT_ADMIN",
    testOperationsEnabled: options.testOperationsEnabled,
  }, requestId);
}

async function candidateOptionsRead(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, requestId: string, options: AuthSecurityOptions, readContext: ContextReader): Promise<void> {
  const context = await readContext(request, options);
  const access = await loadEffectiveAdminAccess(options.pool, context.userId);
  const canConfigure = hasPermission(access, ADMIN_PERMISSION.approvalTemplateConfigure);
  const canAppend = hasPermission(access, ADMIN_PERMISSION.approvalRequestAddApprover);
  if (!canConfigure && !canAppend) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  const targetRequestId = queryValue(request, "requestId");
  if (targetRequestId && targetRequestId.length > 128) invalid("Request id is invalid");
  let requesterId: string | null = null;
  let targetRow: RequestRow | undefined;
  if (targetRequestId) {
    if (!canAppend) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
    targetRow = await readRequestById(options.pool, targetRequestId);
    if (!targetRow) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval request not found");
    if (!(targetRow.requestedBy === context.userId || access?.isBoss === true)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only the requester or a Boss can choose additional candidates");
    requesterId = targetRow.requestedBy;
  }
  const states = await candidateAccessStates(options.pool, []);
  const excludedReasonCounts: Record<string, number> = {};
  const candidates: Record<string, unknown>[] = [];
  for (const state of states.values()) {
    if (state.id === requesterId) continue;
    const reasonCode = candidateReasonCode(state, targetRow);
    if (reasonCode !== "OK") {
      excludedReasonCounts[reasonCode] = (excludedReasonCounts[reasonCode] ?? 0) + 1;
      continue;
    }
    candidates.push({
      username: state.username ?? "unknown",
      displayUsername: state.displayUsername ?? (state.username ?? "unknown").toUpperCase(),
      name: state.name,
      isBoss: state.isBoss,
      eligible: true,
      reasonCode: "OK",
    });
  }
  candidates.sort((left, right) => String(left.username).localeCompare(String(right.username)));
  sendSuccess(response, {
    candidates,
    excludedByReason: excludedReasonCounts,
    requesterExcluded: requesterId !== null,
    excludedFields: ["ip", "session", "credentials", "lastLoginAt"],
    requiredPermission: canConfigure ? ADMIN_PERMISSION.approvalTemplateConfigure : ADMIN_PERMISSION.approvalRequestAddApprover,
  }, requestId);
}

export async function handleAdminApprovalRoute(
  request: AuthSecurityNodeRequest,
  response: AuthSecurityNodeResponse,
  requestId: string,
  options: AuthSecurityOptions,
  readContext: ContextReader,
): Promise<void> {
  const path = routePath(request);
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET") {
    if (path === "/api/v1/admin/security/approvals/templates") return listTemplates(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/mine") return listRequests(request, response, requestId, options, readContext, false);
    if (path === "/api/v1/admin/security/approvals/requests/pending") return listRequests(request, response, requestId, options, readContext, true);
    if (path === "/api/v1/admin/security/approvals/requests/detail") return requestDetail(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/operations") return operationsRead(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/candidate-options") return candidateOptionsRead(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/recovery") return recoveryRead(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/audit/events") return auditEvents(request, response, requestId, options, readContext);
  }
  if (method === "POST") {
    if (path === "/api/v1/admin/security/approvals/templates/update") return configureTemplate(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests") return createRequest(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/decision") return decideRequest(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/add-candidate") return appendCandidate(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/withdraw") return withdrawRequest(request, response, requestId, options, readContext);
    if (path === "/api/v1/admin/security/approvals/requests/execute") return executeRequest(request, response, requestId, options, readContext);
  }
  throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Resource not found");
}
