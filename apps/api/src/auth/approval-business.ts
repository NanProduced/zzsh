import type { Pool, PoolClient } from "pg";

import { ADMIN_PERMISSION, hasPermission, type EffectiveAdminAccess } from "./admin-authorization";
import { isAllGamesScope, scopeAllowsGame, type AdminGameScope } from "./admin-scope";
import { entitlementPricingSummary, isTotalDiscountContract } from "./membership-growth";

export const APPROVAL_TEST_OPERATION = "approval.test.execute";
export const SETTLEMENT_ADJUST_OPERATION = "order.settlement.adjust";

export const APPROVAL_EXECUTION_MODE = {
  /** 通用事务执行器（会员域）在一次事务内形成业务事实。 */
  genericTransaction: "GENERIC_TRANSACTION",
  /** 审批只给依据；业务事实由原领域流程（双方确认/客服复核/过账）完成。 */
  sourceBusiness: "SOURCE_BUSINESS",
  unsupported: "UNSUPPORTED",
} as const;

export type ApprovalExecutionMode = (typeof APPROVAL_EXECUTION_MODE)[keyof typeof APPROVAL_EXECUTION_MODE];
export type ApprovalBusinessType = "membership" | "settlement" | "test";

export type ApprovalOperationRegistration = {
  operationCode: string;
  businessType: ApprovalBusinessType;
  title: string;
  executionMode: ApprovalExecutionMode;
  /** 仅测试开关下装配，不作为生产发起入口。 */
  testOnly: boolean;
  /** 发起时必填的触发标识，由既有模板读取校验，不在这里放宽。 */
  permissionStage: "REQUEST" | "DECIDE" | "EXECUTE" | null;
};

const GENERIC = APPROVAL_EXECUTION_MODE.genericTransaction;
const SOURCE = APPROVAL_EXECUTION_MODE.sourceBusiness;

const REGISTRATIONS: readonly ApprovalOperationRegistration[] = [
  { operationCode: "membership.benefit.policy.publish", businessType: "membership", title: "发布会员权益政策", executionMode: GENERIC, testOnly: false, permissionStage: "EXECUTE" },
  { operationCode: "membership.entitlement.grant", businessType: "membership", title: "发放会员礼遇权益", executionMode: GENERIC, testOnly: false, permissionStage: "EXECUTE" },
  { operationCode: "membership.entitlement.replace", businessType: "membership", title: "替换会员礼遇权益", executionMode: GENERIC, testOnly: false, permissionStage: "EXECUTE" },
  { operationCode: "membership.entitlement.revoke", businessType: "membership", title: "撤销会员礼遇权益", executionMode: GENERIC, testOnly: false, permissionStage: "EXECUTE" },
  { operationCode: SETTLEMENT_ADJUST_OPERATION, businessType: "settlement", title: "人工调整订单结算", executionMode: SOURCE, testOnly: false, permissionStage: null },
  { operationCode: APPROVAL_TEST_OPERATION, businessType: "test", title: "本地非资金测试动作", executionMode: GENERIC, testOnly: true, permissionStage: null },
];

const BY_OPERATION = new Map(REGISTRATIONS.map((item) => [item.operationCode, item]));

export const APPROVAL_REGISTERED_OPERATIONS = REGISTRATIONS;
export const APPROVAL_REGISTERED_OPERATION_CODES = REGISTRATIONS.map((item) => item.operationCode);

export function approvalRegistration(operationCode: string): ApprovalOperationRegistration | null {
  return BY_OPERATION.get(operationCode) ?? null;
}

/**
 * 会员五阶段业务权限的唯一映射：写事务与动作资格判定共用，
 * 避免预检与实际执行各写一份而漂移。
 */
export function membershipBusinessPermission(operationCode: string, stage: "REQUEST" | "DECIDE" | "EXECUTE"): string | null {
  if (!operationCode.startsWith("membership.")) return null;
  if (operationCode === "membership.benefit.policy.publish") return ADMIN_PERMISSION.membershipPolicyPublish;
  if (operationCode === "membership.entitlement.revoke") return ADMIN_PERMISSION.membershipEntitlementRevoke;
  return stage === "REQUEST"
    ? ADMIN_PERMISSION.membershipEntitlementRequest
    : stage === "DECIDE"
      ? ADMIN_PERMISSION.membershipEntitlementDecide
      : ADMIN_PERMISSION.membershipEntitlementExecute;
}

/** 执行侧是否要求游戏对象范围：与会员执行器实际校验保持一致，不机械加严审批前置。 */
export function membershipOperationRequiresGameScope(operationCode: string): boolean {
  return operationCode !== "membership.benefit.policy.publish";
}

export type ApprovalRequestFacts = {
  id: string;
  operationCode: string;
  payloadVersion: number;
  operationPayload: Record<string, unknown>;
  operationPayloadHash: string;
  summary: string;
  requestedBy: string;
  status: string;
  decidedBy: string | null;
  expiresAt: Date | string;
  /** Verified append-only decision override; the original request snapshot stays intact. */
  finalPayload?: Record<string, unknown> | null;
  finalPayloadHash?: string | null;
};

export function editableEntitlementApprovalPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!isTotalDiscountContract(payload.pricing) || entitlementPricingSummary(payload.pricing).knowledge !== "KNOWN") return null;
  const fields = ["userId", "gameId", "kind", "policyId", "scopeKey", "replaceEntitlementId", "startsAtUtc", "endsAtUtc", "depositWaived", "reason", "pricing"];
  if (Object.keys(payload).some((field) => !fields.includes(field))) return null;
  if (["userId", "gameId", "kind", "policyId", "scopeKey", "startsAtUtc", "endsAtUtc", "reason"].some((field) => typeof payload[field] !== "string")) return null;
  if (Object.keys(payload.pricing).some((field) => !["status", "kind", "mode", "priceVersionId", "payableRatio", "costBasisRef"].includes(field))) return null;
  const pricing = payload.pricing;
  const result: Record<string, unknown> = {};
  for (const field of ["userId", "gameId", "kind", "policyId", "scopeKey", "replaceEntitlementId", "startsAtUtc", "endsAtUtc", "depositWaived", "reason"]) if (payload[field] !== undefined) result[field] = payload[field];
  result.pricing = { status: pricing.status, kind: pricing.kind, mode: pricing.mode, priceVersionId: pricing.priceVersionId, payableRatio: pricing.payableRatio, costBasisRef: pricing.costBasisRef };
  return result;
}

export type ApprovalProjectionViewer = {
  userId: string;
  access: EffectiveAdminAccess;
  gameScope: AdminGameScope;
};

type EntitlementRow = {
  id: string;
  userId: string;
  gameId: string;
  kind: string;
  scopeKey: string;
  status: string;
  startsAt: Date | string;
  endsAt: Date | string;
  approvedPolicyId: string;
  approvalRequestId: string;
  replacedById: string | null;
  revokedReason: string | null;
};

type PolicyRow = {
  id: string;
  version: number;
  status: string;
  effectiveAt: Date | string | null;
  priceVersionId: string;
  ruleReleaseId: string;
  approvalRequestId: string | null;
};

type SettlementRow = {
  id: string;
  orderId: string;
  gameId: string | null;
  versionNo: number;
  versionHash: string;
  kind: string;
  early: boolean;
  endReason: string;
  initiatorParty: string;
  approvalRequestId: string;
  supersededAt: Date | string | null;
  postingId: string | null;
  postedAt: Date | string | null;
  refundDueAt: Date | string | null;
  confirmedParties: string[];
  rejectedParties: string[];
  supportReviewed: boolean;
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function textField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 引用类标量（版本号等）允许数字载荷，统一成稳定字符串；金额一律走 moneyField 的精确字符串。 */
function scalarField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function booleanField(payload: Record<string, unknown>, field: string): boolean | null {
  return typeof payload[field] === "boolean" ? (payload[field] as boolean) : null;
}

/**
 * 金额只用冻结审批载荷里的精确元字符串，配货币/单位/口径；
 * 字段缺失就整体省略，绝不填 0，也不把应退当到账。
 */
function moneyField(value: unknown, basis: string): Record<string, unknown> | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  return { amount: value, currency: "CNY", unit: "yuan", scale: 2, basis };
}

function restricted(view: Record<string, unknown>, ...reasonCodes: string[]): Record<string, unknown> {
  return { ...view, summaryAvailable: false, detailsAvailable: false, restrictedReasonCodes: reasonCodes };
}

const KIND_TITLES: Record<string, string> = { FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" };

const ENTITLEMENT_COLUMNS = `"id", "user_id" AS "userId", "game_id" AS "gameId", "kind", "scope_key" AS "scopeKey", "status", "starts_at" AS "startsAt", "ends_at" AS "endsAt", "approved_policy_id" AS "approvedPolicyId", "approval_request_id" AS "approvalRequestId", "replaced_by_id" AS "replacedById", "revoked_reason" AS "revokedReason"`;

async function loadGames(client: Pool | PoolClient, gameIds: Set<string>): Promise<Map<string, string>> {
  if (gameIds.size === 0) return new Map();
  const rows = await client.query<{ id: string; name: string }>(
    `SELECT "id", "name" FROM "zzsh_supply"."game" WHERE "id" = ANY($1::text[])`,
    [[...gameIds]],
  );
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

/** 目标权益按 id 批量取，执行结果权益按 approval_request_id 批量取：查询条数与行数无关。 */
async function loadEntitlements(client: Pool | PoolClient, rows: readonly ApprovalRequestFacts[]): Promise<{ byId: Map<string, EntitlementRow>; byRequestId: Map<string, EntitlementRow> }> {
  const targetIds = new Set<string>();
  for (const row of rows) {
    const payload = row.operationPayload;
    for (const field of ["entitlementId", "replaceEntitlementId"]) {
      const value = textField(payload, field);
      if (value) targetIds.add(value);
    }
  }
  const targets = targetIds.size > 0
    ? (await client.query<EntitlementRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM "zzsh_iam"."membership_entitlement" WHERE "id" = ANY($1::text[])`, [[...targetIds]])).rows
    : [];
  const created = rows.length > 0
    ? (await client.query<EntitlementRow>(`SELECT ${ENTITLEMENT_COLUMNS} FROM "zzsh_iam"."membership_entitlement" WHERE "approval_request_id" = ANY($1::text[])`, [rows.map((row) => row.id)])).rows
    : [];
  return {
    byId: new Map(targets.map((row) => [row.id, row])),
    byRequestId: new Map(created.map((row) => [row.approvalRequestId, row])),
  };
}

async function loadPolicies(client: Pool | PoolClient, rows: readonly ApprovalRequestFacts[]): Promise<{ byId: Map<string, PolicyRow>; byRequestId: Map<string, PolicyRow> }> {
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const field of ["policyId", "policyDraftId"]) {
      const value = textField(row.operationPayload, field);
      if (value) referenced.add(value);
    }
  }
  const byId = referenced.size > 0
    ? new Map((await client.query<PolicyRow>(
        `SELECT "id", "version", "status", "effective_at" AS "effectiveAt", "price_version_id" AS "priceVersionId", "rule_release_id" AS "ruleReleaseId", "approval_request_id" AS "approvalRequestId"
           FROM "zzsh_iam"."membership_growth_policy" WHERE "id" = ANY($1::text[])`,
        [[...referenced]],
      )).rows.map((row) => [row.id, row]))
    : new Map<string, PolicyRow>();
  const byRequestId = rows.length > 0
    ? new Map((await client.query<PolicyRow>(
        `SELECT "id", "version", "status", "effective_at" AS "effectiveAt", "price_version_id" AS "priceVersionId", "rule_release_id" AS "ruleReleaseId", "approval_request_id" AS "approvalRequestId"
           FROM "zzsh_iam"."membership_growth_policy" WHERE "approval_request_id" = ANY($1::text[])`,
        [rows.map((row) => row.id)],
      )).rows.map((row) => [row.approvalRequestId!, row]))
    : new Map<string, PolicyRow>();
  return { byId, byRequestId };
}

/**
 * 结算回链只读既有事实：版本是否仍是当前版、双方决定、客服复核、过账引用。
 * 同版确认/复核/过账的权威闸门仍在结算事务内，本投影不重算业务结论。
 */
async function loadSettlements(client: Pool | PoolClient, rows: readonly ApprovalRequestFacts[]): Promise<Map<string, SettlementRow>> {
  if (rows.length === 0) return new Map();
  const version = await client.query<Omit<SettlementRow, "confirmedParties" | "rejectedParties" | "supportReviewed">>(
    `SELECT v."id", v."order_id" AS "orderId", o."game_id" AS "gameId", v."version_no" AS "versionNo", v."version_hash" AS "versionHash",
            v."kind", v."early", v."end_reason" AS "endReason", v."initiator_party" AS "initiatorParty",
            v."approval_request_id" AS "approvalRequestId", v."superseded_at" AS "supersededAt",
            p."id" AS "postingId", p."posted_at" AS "postedAt", p."refund_due_at" AS "refundDueAt"
       FROM "zzsh_order"."settlement_version" v
       JOIN "zzsh_order"."rental_order" o ON o."id" = v."order_id"
       LEFT JOIN "zzsh_order"."settlement_posting" p ON p."settlement_version_id" = v."id"
      WHERE v."approval_request_id" = ANY($1::text[])`,
    [rows.map((row) => row.id)],
  );
  const versions = version.rows;
  if (versions.length === 0) return new Map();
  const decisions = await client.query<{ versionId: string; party: string; action: string }>(
    `SELECT "settlement_version_id" AS "versionId", "party", "action" FROM "zzsh_order"."settlement_decision" WHERE "settlement_version_id" = ANY($1::text[])`,
    [versions.map((row) => row.id)],
  );
  const byRequestId = new Map<string, SettlementRow>();
  const byVersionId = new Map<string, SettlementRow>();
  for (const row of versions) {
    const view = { ...row, confirmedParties: [], rejectedParties: [], supportReviewed: false };
    byRequestId.set(row.approvalRequestId, view);
    byVersionId.set(row.id, view);
  }
  for (const row of decisions.rows) {
    const view = byVersionId.get(row.versionId);
    if (!view) continue;
    if (row.action === "CONFIRM") view.confirmedParties.push(row.party);
    else if (row.action === "REJECT") view.rejectedParties.push(row.party);
    else if (row.action === "REVIEW") view.supportReviewed = true;
  }
  return byRequestId;
}

/**
 * 执行回执按 request_id 批量读取。撤销类操作只更新既有权益，不会把权益的
 * approval_request_id 改写为撤销申请，因此“本次执行成功”必须以执行记录为准，
 * 再指向被操作的冻结目标；这与“新建业务行”是两种不同的结果来源。
 */
async function loadExecutionReceipts(client: Pool | PoolClient, rows: readonly ApprovalRequestFacts[]): Promise<Map<string, { status: string; resultCode: string; resultDetail: string | null }>> {
  if (rows.length === 0) return new Map();
  const result = await client.query<{ requestId: string; status: string; resultCode: string; resultDetail: string | null }>(
    `SELECT "request_id" AS "requestId", "status", "result_code" AS "resultCode", "result_detail" AS "resultDetail"
       FROM "zzsh_iam"."approval_execution" WHERE "request_id" = ANY($1::text[])`,
    [rows.map((row) => row.id)],
  );
  return new Map(result.rows.map((row) => [row.requestId, { status: row.status, resultCode: row.resultCode, resultDetail: row.resultDetail }]));
}

function settlementPendingConditions(row: SettlementRow): string[] {
  const pending: string[] = [];
  if (row.kind !== "MANUAL_ADJUSTMENT") pending.push("SETTLEMENT_VERSION_MISSING");
  if (!row.confirmedParties.includes("RENTER")) pending.push("RENTER_CONFIRMATION_REQUIRED");
  if (!row.confirmedParties.includes("OWNER")) pending.push("OWNER_CONFIRMATION_REQUIRED");
  if (row.rejectedParties.length > 0) pending.push("PARTY_REJECTED_CURRENT_VERSION");
  if (row.early && !row.supportReviewed) pending.push("SUPPORT_REVIEW_REQUIRED");
  if (!row.postingId) pending.push("SETTLEMENT_NOT_POSTED");
  if (row.supersededAt) pending.push("SETTLEMENT_VERSION_SUPERSEDED");
  return pending;
}

function entitlementOutcome(row: EntitlementRow | undefined, startsInFuture: boolean): Record<string, unknown> {
  if (!row) return { resultAvailability: "UNRESOLVED", resultReasonCode: "ENTITLEMENT_RESULT_NOT_READ" };
  return {
    resultAvailability: "KNOWN",
    entitlement: {
      type: "membership_entitlement",
      id: row.id,
      status: row.status,
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      effectiveState: row.status === "ACTIVE" ? "EFFECTIVE" : row.status === "EXECUTED_PENDING_START" ? (startsInFuture ? "NOT_STARTED" : "STARTED") : row.status,
      replacedById: row.replacedById,
    },
  };
}

function membershipView(
  row: ApprovalRequestFacts,
  viewer: ApprovalProjectionViewer,
  games: Map<string, string>,
  entitlements: { byId: Map<string, EntitlementRow>; byRequestId: Map<string, EntitlementRow> },
  policies: { byId: Map<string, PolicyRow>; byRequestId: Map<string, PolicyRow> },
  executions: Map<string, { status: string; resultCode: string; resultDetail: string | null }>,
): Record<string, unknown> {
  const payload = row.finalPayload ?? row.operationPayload;
  const base: Record<string, unknown> = {
    requestId: row.id,
    businessType: "membership",
    businessTitle: approvalRegistration(row.operationCode)?.title ?? "会员操作",
    operationCode: row.operationCode,
    executionMode: APPROVAL_EXECUTION_MODE.genericTransaction,
  };
  const decidePermission = membershipBusinessPermission(row.operationCode, "DECIDE");
  const canReadBusiness = viewer.access.isBoss || row.requestedBy === viewer.userId || hasPermission(viewer.access, decidePermission!);
  if (!canReadBusiness) return restricted(base, "BUSINESS_PERMISSION_REQUIRED");
  const gameId = textField(payload, "gameId");
  const inScope = !gameId || viewer.access.isBoss || isAllGamesScope(viewer.gameScope) || scopeAllowsGame(viewer.gameScope, false, gameId);
  if (!inScope) return restricted(base, "GAME_SCOPE_DENIED");

  const summary: Record<string, unknown> = { schemaVersion: 1, changeSummary: row.summary, payloadVersion: row.payloadVersion, payloadHash: row.finalPayloadHash ?? row.operationPayloadHash, requestPayloadHash: row.operationPayloadHash, finalPayloadHash: row.finalPayloadHash ?? null, payloadSource: row.finalPayload ? "APPROVED_FINAL" : "REQUEST_ORIGINAL" };
  if (row.operationCode === "membership.entitlement.grant" || row.operationCode === "membership.entitlement.replace") {
    summary.pricingSummary = entitlementPricingSummary(payload.pricing);
    if (row.finalPayload) summary.originalRequest = { startsAt: textField(row.operationPayload, "startsAtUtc"), endsAt: textField(row.operationPayload, "endsAtUtc"), depositWaived: booleanField(row.operationPayload, "depositWaived"), reason: textField(row.operationPayload, "reason"), pricingSummary: entitlementPricingSummary(row.operationPayload.pricing) };
  }
  const refs: Record<string, unknown>[] = [{ type: "membership_game", id: gameId ?? null }];
  if (gameId) {
    const name = games.get(gameId);
    if (name) summary.gameName = name;
  }
  const kind = textField(payload, "kind");
  if (kind) {
    summary.entitlementKind = kind;
    summary.entitlementKindTitle = KIND_TITLES[kind] ?? kind;
  }
  for (const [payloadField, viewField] of [["userId", "targetUserId"], ["scopeKey", "scopeKey"], ["startsAtUtc", "startsAt"], ["endsAtUtc", "endsAt"], ["reason", "reason"]] as const) {
    const value = textField(payload, payloadField);
    if (value) summary[viewField] = value;
  }
  const depositWaived = booleanField(payload, "depositWaived");
  if (depositWaived !== null) summary.depositWaived = depositWaived;

  const policyId = textField(payload, "policyId");
  const draftId = textField(payload, "policyDraftId");
  const referencedPolicy = policies.byId.get(policyId ?? "") ?? policies.byId.get(draftId ?? "");
  if (policyId) {
    summary.policyId = policyId;
    if (referencedPolicy) {
      summary.policyVersion = referencedPolicy.version;
      summary.policyStatus = referencedPolicy.status;
    }
    refs.push({ type: "membership_growth_policy", id: policyId });
  }
  if (draftId) {
    const draft: Record<string, unknown> = {
      id: draftId,
      version: typeof payload.policyDraftVersion === "number" ? payload.policyDraftVersion : null,
    };
    const draftHash = textField(payload, "policyDraftHash");
    if (draftHash) draft.hash = draftHash;
    if (referencedPolicy) draft.currentStatus = referencedPolicy.status;
    for (const [payloadField, viewField] of [["ruleReleaseId", "ruleReleaseId"], ["priceVersionId", "priceVersionId"], ["sourceRef", "sourceRef"], ["effectiveAtUtc", "effectiveAtUtc"]] as const) {
      const value = textField(payload, payloadField);
      if (value) draft[viewField] = value;
    }
    summary.policyDraft = draft;
    refs.push({ type: "membership_growth_policy", id: draftId });
  }
  if (!policyId && !draftId && payload.policy && typeof payload.policy === "object") {
    // 无草稿的内联政策载荷：只列版本与层级标识，阈值属明细读范围。
    const tiers = (payload.policy as { tiers?: Record<string, unknown> }).tiers;
    summary.inlinePolicy = { versionNo: typeof payload.versionNo === "number" ? payload.versionNo : null, tierCodes: tiers ? Object.keys(tiers).sort() : [] };
  }
  for (const [payloadField, viewField] of [["entitlementId", "revokeEntitlementId"], ["replaceEntitlementId", "replaceEntitlementId"]] as const) {
    const value = textField(payload, payloadField);
    if (!value) continue;
    const current = entitlements.byId.get(value);
    summary[payloadField === "entitlementId" ? "revokedEntitlement" : "replacedEntitlement"] = {
      id: value,
      frozenTargetScopeKey: textField(payload, "scopeKey"),
      currentStatus: current?.status ?? null,
      currentEndsAt: current ? iso(current.endsAt) : null,
      readAvailable: Boolean(current),
    };
    refs.push({ type: "membership_entitlement", id: value });
  }

  const result: Record<string, unknown> = {};
  const receipt = executions.get(row.id);
  if (receipt) result.executionReceipt = { status: receipt.status, resultCode: receipt.resultCode, resultDetail: receipt.resultDetail };
  const publishedPolicy = policies.byRequestId.get(row.id);
  if (publishedPolicy) {
    result.resultAvailability = "KNOWN";
    result.publishedPolicy = { type: "membership_growth_policy", id: publishedPolicy.id, version: publishedPolicy.version, status: publishedPolicy.status, effectiveAt: iso(publishedPolicy.effectiveAt) };
    refs.push({ type: "membership_growth_policy", id: publishedPolicy.id });
  } else {
    const created = entitlements.byRequestId.get(row.id);
    if (created) {
      const startsAt = created.startsAt instanceof Date ? created.startsAt : new Date(created.startsAt);
      Object.assign(result, entitlementOutcome(created, startsAt.getTime() > Date.now()));
      refs.push({ type: "membership_entitlement", id: created.id });
    } else {
      // 撤销只更新既有权益：结果来自本次执行记录指向的冻结目标，不改写原授予来源。
      const actedTargetId = textField(payload, "entitlementId");
      const acted = actedTargetId ? entitlements.byId.get(actedTargetId) : undefined;
      if (acted && receipt?.status === "SUCCEEDED") {
        result.resultAvailability = "KNOWN";
        result.entitlement = {
          type: "membership_entitlement",
          id: acted.id,
          status: acted.status,
          startsAt: iso(acted.startsAt),
          endsAt: iso(acted.endsAt),
          effectiveState: acted.status === "REVOKED" ? "REVOKED" : acted.status === "REPLACED" ? "REPLACED" : acted.status === "ACTIVE" ? "EFFECTIVE" : acted.status,
          replacedById: acted.replacedById,
        };
        refs.push({ type: "membership_entitlement", id: acted.id });
      } else if (row.status === "EXECUTED") {
        Object.assign(result, entitlementOutcome(undefined, false));
      }
    }
  }
  if (result.resultAvailability !== "KNOWN" && row.status !== "EXECUTED") result.resultAvailability = "NOT_APPLICABLE";

  const view: Record<string, unknown> = { ...base, summaryAvailable: true, detailsAvailable: true, summary, objectRefs: refs, ...result };
  if (hasPermission(viewer.access, ADMIN_PERMISSION.membershipGrowthDetailRead)) {
    const pricing = payload.pricing;
    if (pricing && typeof pricing === "object") {
      const value = pricing as Record<string, unknown>;
      view.pricingReference = { mode: typeof value.mode === "string" ? value.mode : null, priceVersionId: textField(value, "priceVersionId"), costBasisRef: textField(value, "costBasisRef"), schema: textField(value, "haffSchema") ?? textField(value, "schema") ?? textField(value, "kind"), payableRatio: textField(value, "payableRatio"), payloadSource: row.finalPayload ? "APPROVED_FINAL" : "REQUEST_ORIGINAL" };
    }
    if (referencedPolicy) view.costBasis = { priceVersionId: referencedPolicy.priceVersionId, ruleReleaseId: referencedPolicy.ruleReleaseId };
  } else {
    view.pricingRestrictedReasonCode = "MEMBERSHIP_DETAIL_READ_REQUIRED";
  }
  return view;
}

function settlementView(
  row: ApprovalRequestFacts,
  viewer: ApprovalProjectionViewer,
  games: Map<string, string>,
  settlements: Map<string, SettlementRow>,
): Record<string, unknown> {
  const payload = row.operationPayload;
  const base: Record<string, unknown> = {
    requestId: row.id,
    businessType: "settlement",
    businessTitle: approvalRegistration(row.operationCode)?.title ?? "结算人工调整",
    operationCode: row.operationCode,
    executionMode: APPROVAL_EXECUTION_MODE.sourceBusiness,
  };
  if (!hasPermission(viewer.access, ADMIN_PERMISSION.orderRead) && !viewer.access.isBoss) return restricted(base, "BUSINESS_PERMISSION_REQUIRED");
  const version = settlements.get(row.id);
  const gameId = version?.gameId ?? null;
  if (gameId && !viewer.access.isBoss && !isAllGamesScope(viewer.gameScope) && !scopeAllowsGame(viewer.gameScope, false, gameId)) return restricted(base, "GAME_SCOPE_DENIED");

  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    changeSummary: row.summary,
    payloadVersion: row.payloadVersion,
    payloadHash: row.operationPayloadHash,
    settlementSchema: textField(payload, "schema"),
    reason: textField(payload, "reason"),
    endReason: textField(payload, "endReason"),
    early: booleanField(payload, "early"),
    currency: "CNY",
    unit: "yuan",
    scale: 2,
  };
  for (const [payloadField, viewField] of [["baseVersionId", "baseSettlementVersionId"], ["baseVersionNo", "baseSettlementVersionNo"], ["openingId", "openingId"], ["openingVersion", "openingVersion"], ["paymentConfirmationId", "paymentConfirmationId"], ["decisionDigest", "decisionDigest"], ["quoteDigest", "quoteDigest"], ["paymentDigest", "paymentDigest"], ["listingHash", "listingHash"]] as const) {
    const value = scalarField(payload, payloadField);
    if (value) summary[viewField] = value;
  }
  const amounts = payload.amounts;
  if (amounts && typeof amounts === "object") {
    const value = amounts as Record<string, unknown>;
    const systemOwnerNet = moneyField(value.ownerNet, "SYSTEM_OWNER_NET");
    const systemRenterRefund = moneyField(value.renterRefund, "SYSTEM_RENTER_REFUND");
    if (systemOwnerNet) summary.systemOwnerNet = systemOwnerNet;
    if (systemRenterRefund) summary.systemRenterRefund = systemRenterRefund;
  }
  const proposedOwnerNet = moneyField(payload.proposedOwnerNet, "PROPOSED_OWNER_NET");
  const proposedRenterRefund = moneyField(payload.proposedRenterRefund, "PROPOSED_RENTER_REFUND");
  const captured = moneyField(payload.capturedAmount, "CAPTURED");
  const deposit = moneyField(payload.depositAmount, "DEPOSIT");
  if (proposedOwnerNet) summary.proposedOwnerNet = proposedOwnerNet;
  if (proposedRenterRefund) summary.proposedRenterRefund = proposedRenterRefund;
  if (captured) summary.capturedAmount = captured;
  if (deposit) summary.depositAmount = deposit;

  const refs: Record<string, unknown>[] = [{ type: "rental_order", id: textField(payload, "orderId") }];
  const view: Record<string, unknown> = { ...base, summaryAvailable: true, detailsAvailable: true, summary, objectRefs: refs };
  if (gameId) {
    view.game = { id: gameId, name: games.get(gameId) ?? null };
    refs.push({ type: "membership_game", id: gameId });
  }
  if (!version) {
    view.resultAvailability = "UNRESOLVED";
    view.resultReasonCode = "SETTLEMENT_VERSION_NOT_READ";
    view.pendingConditionCodes = ["SETTLEMENT_VERSION_MISSING"];
    return view;
  }
  refs.push({ type: "settlement_version", id: version.id });
  if (version.postingId) refs.push({ type: "settlement_posting", id: version.postingId });
  view.resultAvailability = "KNOWN";
  view.settlementResult = {
    settlementVersionId: version.id,
    versionNo: version.versionNo,
    versionHash: version.versionHash,
    kind: version.kind,
    currentVersion: version.supersededAt === null,
    approvedPayloadMatchesVersion: version.versionHash === row.operationPayloadHash,
    confirmedParties: [...version.confirmedParties].sort(),
    rejectedParties: [...version.rejectedParties].sort(),
    supportReviewed: version.supportReviewed,
    posted: Boolean(version.postingId),
    postingId: version.postingId,
    postedAt: iso(version.postedAt),
    refundDueAt: iso(version.refundDueAt),
  };
  view.pendingConditionCodes = settlementPendingConditions(version);
  return view;
}

/**
 * 审批摘要投影：只回本次判断所需的冻结字段与当前对象状态，
 * 列表按有界集合批量投影，查询条数与本页行数无关。
 */
export type ApprovalObjectState = { targetEntitlementStatus: string | null; policyDraftStatus: string | null };

export type ApprovalProjection = {
  views: Map<string, Record<string, unknown>>;
  /** 冻结目标对象的当前状态：只用于动作资格判定，不随视图输出。 */
  objectStates: Map<string, ApprovalObjectState>;
};

export async function projectApprovalBusinesses(
  client: Pool | PoolClient,
  rows: readonly ApprovalRequestFacts[],
  viewer: ApprovalProjectionViewer,
): Promise<ApprovalProjection> {
  const views = new Map<string, Record<string, unknown>>();
  const objectStates = new Map<string, ApprovalObjectState>();
  const membership = rows.filter((row) => approvalRegistration(row.operationCode)?.businessType === "membership");
  const settlements = rows.filter((row) => approvalRegistration(row.operationCode)?.businessType === "settlement");
  const unknown = rows.filter((row) => {
    const registration = approvalRegistration(row.operationCode);
    return !registration || (registration.businessType !== "membership" && registration.businessType !== "settlement");
  });

  const [entitlements, policies, settlementRows, executions] = await Promise.all([
    loadEntitlements(client, membership),
    loadPolicies(client, membership),
    loadSettlements(client, settlements),
    loadExecutionReceipts(client, membership),
  ]);
  const gameIds = new Set<string>();
  for (const row of membership) {
    const gameId = textField(row.operationPayload, "gameId");
    if (gameId) gameIds.add(gameId);
    const targetId = textField(row.operationPayload, "entitlementId") ?? textField(row.operationPayload, "replaceEntitlementId");
    const draftId = textField(row.operationPayload, "policyDraftId");
    objectStates.set(row.id, {
      targetEntitlementStatus: targetId ? entitlements.byId.get(targetId)?.status ?? null : null,
      policyDraftStatus: draftId ? policies.byId.get(draftId)?.status ?? null : null,
    });
  }
  for (const row of settlementRows.values()) {
    if (row.gameId) gameIds.add(row.gameId);
  }
  const games = await loadGames(client, gameIds);

  for (const row of membership) views.set(row.id, membershipView(row, viewer, games, entitlements, policies, executions));
  for (const row of settlements) views.set(row.id, settlementView(row, viewer, games, settlementRows));
  for (const row of unknown) {
    const registration = approvalRegistration(row.operationCode);
    const base: Record<string, unknown> = {
      requestId: row.id,
      businessType: registration?.businessType ?? "unknown",
      businessTitle: registration?.title ?? "未登记的业务操作",
      operationCode: row.operationCode,
      executionMode: registration?.executionMode ?? APPROVAL_EXECUTION_MODE.unsupported,
    };
    if (registration?.businessType === "test") {
      views.set(row.id, { ...base, summaryAvailable: false, detailsAvailable: true, changeSummary: row.summary, restrictedReasonCodes: ["TEST_OPERATION_PAYLOAD_WITHHELD"] });
      continue;
    }
    views.set(row.id, restricted(base, registration ? "BUSINESS_ADAPTER_MISSING" : "OPERATION_UNREGISTERED"));
  }
  return { views, objectStates };
}
