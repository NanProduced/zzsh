import type { InlineStatusTone } from "../../components/ui/badge";

/**
 * 审批展示契约。字段名与枚举取自 apps/api/src/auth/approval-business.ts 与
 * approval-audit.ts（status/decision/execution 枚举见 migrations/business/0009）。
 * 运行中的 API 可能早于本合同，因此除 requestId/status 外一律可选：
 * 缺字段的唯一合法表达是「未接入 / 无权查看 / 未知」，不是 0 或空。
 */

/**
 * KNOWN 回执的终态信封校验：外层身份 + 正文结果都要完整、自洽、目标关联，才能解除责任。
 * 枚举与相互关系取自后端命令返回值（approval-audit.ts 的 decide / appendCandidate / execute /
 * configureTemplate 与 0009 迁移的 CHECK），不是任意对象 shape。返回 null 才可作为终态证据。
 */
export function receiptEnvelopeIssue(result: RecoveryResult, bound: { key: string; operation: string; target: string | null }): string | null {
  if (result.key !== bound.key || result.operation !== bound.operation) return "回执的标识或操作与当前未决请求不一致";
  if ((result.targetRequestId ?? null) !== (bound.target ?? null)) return "回执的目标与当前未决请求不一致";
  if (typeof result.originalResponseStatus !== "number") return "回执缺少原响应状态";
  if (result.outcome !== "ACCEPTED" && result.outcome !== "REJECTED") return "回执缺少可核实的受理或拒绝结果";
  const receipt = result.receipt;
  if (!receipt || typeof receipt !== "object") return "回执缺少结果内容";
  if (result.outcome === "ACCEPTED" && result.originalResponseStatus !== 200) return "受理结果与原响应状态矛盾";
  if (result.outcome === "REJECTED") {
    if (result.originalResponseStatus === 200) return "拒绝结果与原响应状态矛盾";
    if (!receipt.rejection || typeof receipt.rejection.code !== "string" || !receipt.rejection.code.trim()) return "拒绝回执缺少原因码";
    return null;
  }

  // 受理态：正文必须带上与绑定目标一致的申请号（创建类除外，它提交前还没有申请号）。
  const requestId = typeof receipt.approvalRequestId === "string" ? receipt.approvalRequestId.trim() : "";
  if (bound.target) {
    if (!requestId) return "回执正文缺少申请号";
    if (requestId !== bound.target) return "回执正文的申请号与当前未决请求不是同一笔";
  } else if (bound.operation === "approval.request.create" && !requestId) {
    return "创建回执缺少申请号";
  }

  const status = typeof receipt.status === "string" ? receipt.status.trim() : "";
  switch (bound.operation) {
    case "approval.request.create":
      return status === "PENDING" ? null : "创建回执缺少待审批状态";
    case "approval.request.decide": {
      // 决定命令的返回是 APPROVED / REJECTED；PENDING 或未知值都不是终态。
      if (status !== "APPROVED" && status !== "REJECTED") return "决定回执不是已生效的批准或驳回终态";
      if (receipt.decision !== undefined && receipt.decision !== status) return "决定回执的决定与状态互相矛盾";
      return null;
    }
    case "approval.request.execute": {
      const executionStatus = typeof receipt.executionStatus === "string" ? receipt.executionStatus.trim() : "";
      if (executionStatus !== "SUCCEEDED" && executionStatus !== "FAILED") return "执行回执缺少成功或失败终态";
      const expected = executionStatus === "SUCCEEDED" ? "EXECUTED" : "EXECUTION_FAILED";
      if (status && status !== expected) return "执行回执的申请状态与执行结果矛盾";
      return null;
    }
    case "approval.request.add_candidate": {
      const candidate = typeof receipt.candidateUsername === "string" ? receipt.candidateUsername.trim() : "";
      if (!candidate) return "追加候选回执缺少候选人";
      if (status && status !== "CANDIDATE_ADDED") return "追加候选回执的状态与操作不符";
      return null;
    }
    case "approval.template.configure": {
      // 后端 configureTemplate 返回 { templateId, version, candidateCount, status: "CONFIGURED" }，
      // 而恢复白名单只投影 status/candidateCount/templateVersion（version 不映射为 templateVersion）。
      // 因此合法投影是 CONFIGURED + candidateCount；版本号存在时另核正整数，但不能借版本绕过状态。
      if (status !== "CONFIGURED") return "模板回执不是已配置完成的终态";
      if (receipt.templateVersion !== undefined
        && (typeof receipt.templateVersion !== "number" || !Number.isInteger(receipt.templateVersion) || receipt.templateVersion < 1)) {
        return "模板回执的版本号不是合法正整数";
      }
      return null;
    }
    default:
      return "未识别的恢复操作，不能据此判定终态";
  }
}

function rejectionDetail(result: RecoveryResult): string {
  const rejection = result.receipt?.rejection;
  const code = typeof rejection?.code === "string" && rejection.code.trim() ? rejection.code.trim() : "";
  const reason = Array.isArray(rejection?.reasons) ? rejection.reasons.find((item) => typeof item === "string" && item.trim()) : undefined;
  return "原请求当时已被拒绝" + (code ? "（" + code + (reason ? "：" + reasonLabel(reason) : "") + "）" : "");
}

/**
 * 已核实回执的结果说明。恢复回执证明的是「原请求当时被受理或被拒绝」，
 * 不等于原命令的成功文案，因此两条读回路径共用这一句，避免再各写一份而漂移。
 */
export function recoveryOutcomeSummary(result: RecoveryResult): string {
  if (result.outcome === "REJECTED") return rejectionDetail(result) + "；最新状态已读取，未重发该命令。";
  return "原请求已确认受理，最新状态已读取；可按当前资格继续处理。";
}

/**
 * 回执已核实、但最新详情仍读不到时的说明：只陈述已核实的部分，
 * 不声称已读取，也不拼接原命令的成功文案。
 */
export function recoveryOutcomeUnconfirmedSummary(result: RecoveryResult): string {
  if (result.outcome === "REJECTED") return rejectionDetail(result) + "；最新状态暂未读到，可重试读取。未重发该命令。";
  return "原请求已确认受理；最新状态暂未读到，可重试读取。";
}

/** 动作集合固定：withdraw 由申请人（或 Boss）在待审批时显式撤回，产生 CANCELLED；replace 则新建替代申请。 */
export const APPROVAL_ACTION_NAMES = ["approve", "reject", "execute", "addCandidate", "replace", "withdraw"] as const;

export type ActionEligibility = {
  action: string;
  allowed: boolean;
  reasonCode: string;
  requiredPermission?: string | null;
  executionMode?: string | null;
  nextStepCode?: string | null;
};

export type Person = { username: string; displayUsername?: string; name: string; status?: string };

export type Candidate = Person & { eligible?: boolean; source?: string; reasonCode?: string; isBoss?: boolean };

export type Money = { amount: string; currency: string; unit: string; scale: number; basis?: string };

export type ObjectRef = { type: string; id: string | null };

export type BusinessView = {
  requestId?: string;
  businessType?: string;
  businessTitle?: string;
  operationCode?: string;
  executionMode?: string;
  summaryAvailable?: boolean;
  detailsAvailable?: boolean;
  changeSummary?: string;
  restrictedReasonCodes?: string[];
  pricingRestrictedReasonCode?: string;
  summary?: Record<string, unknown>;
  objectRefs?: ObjectRef[];
  game?: { id: string; name: string | null };
  resultAvailability?: "KNOWN" | "UNRESOLVED" | "NOT_APPLICABLE" | string;
  resultReasonCode?: string;
  executionReceipt?: { status: string; resultCode: string; resultDetail: string | null };
  entitlement?: { id: string; status: string; startsAt: string | null; endsAt: string | null; effectiveState: string; replacedById: string | null };
  publishedPolicy?: { id: string; version: number; status: string; effectiveAt: string | null };
  settlementResult?: {
    settlementVersionId: string; versionNo: number; versionHash: string; kind: string;
    currentVersion: boolean; approvedPayloadMatchesVersion: boolean;
    confirmedParties: string[]; rejectedParties: string[]; supportReviewed: boolean;
    posted: boolean; postingId: string | null; postedAt: string | null; refundDueAt: string | null;
  };
  pendingConditionCodes?: string[];
  /** 会员定价与成本口径引用；仅在持有 membership.growth.read.detail 时返回。 */
  pricingReference?: { mode: string | null; scope?: string | null; priceVersionId: string | null; costBasisRef: string | null; schema: string | null; payableRatio?: string | null; payloadSource?: string };
  costBasis?: { priceVersionId: string | null; ruleReleaseId: string | null };
  /** 分销申请的冻结改动，不是当前全局政策或完整原值。 */
  policyChange?: { schema?: string; initial?: boolean; expectedPolicyId: string | null; expectedRevision: string | null; expectedPolicyDigest: string | null; changes?: Record<string, unknown>; reason: string | null };
  result?: { knowledge: string; policyVersionId?: string | null };
};

export type RequestSummary = {
  requestId: string;
  operationCode: string;
  triggerCondition: string;
  payloadVersion: number;
  payloadHash: string;
  summary: string;
  status: string;
  statusReason?: string | null;
  requester: Person;
  createdAt: string | null;
  expiresAt: string | null;
  business?: BusinessView;
  actions?: ActionEligibility[];
  candidateAvailability?: { total: number; eligible: number; blockingReasonCode: string | null } | null;
};

export type AuditEvent = {
  eventId: string;
  actor: Person;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  occurredAt: string | null;
  details: Record<string, unknown>;
};

export type RequestDetail = Omit<RequestSummary, "operationCode"> & {
  entitlementAmendment?: { expectedPayloadHash: string; editablePayload: EntitlementAmendmentPayload } | null;
  operation: {
    code: string; triggerCondition: string; payloadVersion: number; payloadHash: string;
    executionMode?: string; payload?: Record<string, unknown>;
  };
  template: { id: string; version: number };
  decision: { decision: string; reason: string | null; approver: Person; createdAt: string | null; requestPayloadHash?: string; finalPayloadHash?: string | null; approvedPayloadHash?: string } | null;
  execution: { status: string; resultCode: string; resultDetail: string | null; executor: Person; createdAt: string | null; completedAt: string | null } | null;
  candidates: Candidate[];
  history: AuditEvent[];
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
};

export type EntitlementAmendmentPayload = Record<string, unknown> & {
  startsAtUtc: string; endsAtUtc: string; depositWaived: boolean; depositAllowanceCents?: string; reason: string;
  pricing: Record<string, unknown> & { payableRatio: string };
};
export type ApprovalDecisionAmendment = { expectedPayloadHash: string; finalPayload: EntitlementAmendmentPayload };

export type OperationTrigger = {
  triggerCondition: string; templateVersion: number;
  candidateTotal: number; candidateEligible: number; blockingReasonCode: string | null;
};

export type OperationEntry = {
  operationCode: string; businessType: string; title: string; executionMode: string; testOnly: boolean;
  initiation: { allowed: boolean; reasonCode: string; requiredPermission: string };
  triggers: OperationTrigger[];
};

export type CandidateOptions = {
  candidates: Candidate[];
  excludedByReason: Record<string, number>;
  requesterExcluded?: boolean;
  excludedFields?: string[];
  requiredPermission?: string;
};

export type RecoveryReceipt = {
  approvalRequestId?: string | null; status?: string | null; decision?: string | null;
  executionStatus?: string | null; resultCode?: string | null; executionMode?: string | null;
  businessResultRef?: string | null; templateVersion?: number | null; candidateCount?: number | null;
  candidateUsername?: string | null; expiresAt?: string | null;
  rejection?: { code: string; message: string; reasons?: string[] };
};

export type RecoveryResult = {
  knowledge: "KNOWN" | "UNRESOLVED" | string;
  operation: string;
  key: string;
  targetRequestId?: string | null;
  explanationCode?: string;
  resolution?: string;
  fingerprint?: string;
  committedAt?: string | null;
  originalResponseStatus?: number;
  outcome?: "ACCEPTED" | "REJECTED" | string;
  receipt?: RecoveryReceipt | null;
};

export type Template = {
  id: string; operationCode: string; triggerCondition: string; version: number;
  updatedAt: string | null; candidates: Candidate[];
};

// ── 标签与色调 ────────────────────────────────────────────────────────────

const STATUS: Record<string, { label: string; tone: InlineStatusTone }> = {
  PENDING: { label: "待审批", tone: "warning" },
  APPROVED: { label: "已批准", tone: "info" },
  REJECTED: { label: "已驳回", tone: "error" },
  CANCELLED: { label: "已撤回或被替代", tone: "neutral" },
  EXPIRED: { label: "已过期", tone: "neutral" },
  EXECUTED: { label: "审批执行完成", tone: "success" },
  EXECUTION_FAILED: { label: "执行失败", tone: "error" },
};

export function statusView(value: string | undefined | null): { label: string; tone: InlineStatusTone } {
  if (!value) return { label: "状态未提供", tone: "unknown" };
  return STATUS[value] ?? { label: value, tone: "unknown" };
}

const EXECUTION: Record<string, { label: string; tone: InlineStatusTone }> = {
  SUCCEEDED: { label: "执行成功", tone: "success" },
  FAILED: { label: "执行失败", tone: "error" },
};

export function executionView(value: string | undefined | null): { label: string; tone: InlineStatusTone } {
  if (!value) return { label: "尚未执行", tone: "neutral" };
  return EXECUTION[value] ?? { label: value, tone: "unknown" };
}

export const ACTION_LABELS: Record<string, string> = {
  approve: "批准", reject: "驳回", execute: "执行", addCandidate: "追加审批人", replace: "替代申请", withdraw: "撤回申请",
};

/** 原因码解释。未知码原样显示，不猜含义。 */
const REASONS: Record<string, string> = {
  OK: "当前可操作",
  ACTOR_INACTIVE: "你的账号当前不是生效状态",
  PERMISSION_REQUIRED: "缺少该动作所需权限",
  TWO_FACTOR_REQUIRED: "需要先启用双因素认证",
  NOT_CANDIDATE: "你不在这张申请的候选审批人内",
  SELF_REQUEST_NOT_ALLOWED: "不能审批自己发起的申请",
  BUSINESS_PERMISSION_REQUIRED: "缺少该业务的阶段权限",
  GAME_SCOPE_DENIED: "目标游戏不在你的业务范围内",
  OUT_OF_REQUEST_SCOPE: "这张申请不在你的可读范围内",
  REQUESTER_ONLY: "只有申请人本人（或 Boss）可以替代或撤回这张申请",
  STATUS_NOT_PENDING: "申请已不在待审批状态",
  STATUS_NOT_APPROVED: "需要先有批准决定才能执行",
  EXPIRED: "申请已过期，不再推进",
  TEST_OPERATION_DISABLED: "测试操作在当前环境未开启",
  OPERATION_UNREGISTERED: "该业务操作未登记，只读且不可办理",
  EXECUTION_MODE_SOURCE_BUSINESS: "由来源业务流程完成，审批页不执行",
  EXECUTOR_NOT_ASSEMBLED: "执行器尚未装配",
  TARGET_NOT_ACTIVE: "目标对象当前状态不允许该动作",
  OBJECT_VERSION_CHANGED: "对象版本已变化，需要重新核对",
  UNKNOWN_STATE: "当前状态未知，按不可操作处理",
  INITIATED_FROM_SOURCE_BUSINESS: "只能由来源业务流程发起",
  CANDIDATE_NOT_ACTIVE: "账号不是生效状态",
  BUSINESS_ADAPTER_MISSING: "该业务尚未接入摘要适配",
  TEST_OPERATION_PAYLOAD_WITHHELD: "测试操作载荷不外发",
  MEMBERSHIP_DETAIL_READ_REQUIRED: "定价与成本口径需要会员明细读取权限",
  NO_CANDIDATE_SNAPSHOT: "候选快照为空",
  NO_ELIGIBLE_CANDIDATE: "候选中无人当前合格",
  ENTITLEMENT_RESULT_NOT_READ: "读不到本次执行作用的权益行",
  SETTLEMENT_VERSION_NOT_READ: "读不到本次调整对应的结算版本",
  RECEIPT_NOT_FOUND: "没有找到这把请求标识对应的回执",
  UNKNOWN_NOT_ABSENT: "读不到不等于没执行",
};

export function reasonLabel(code: string | undefined | null): string {
  if (!code) return "原因未提供";
  return REASONS[code] ?? code;
}

const NEXT_STEP: Record<string, string> = {
  APPROVAL_DECISION_REQUIRED: "下一步：先由合格候选人作出批准或驳回决定",
  SOURCE_BUSINESS_COMPLETION_REQUIRED: "下一步：回到来源业务完成双方确认、客服复核与过账",
};

export function nextStepLabel(code: string | undefined | null): string | null {
  if (!code) return null;
  return NEXT_STEP[code] ?? code;
}

const PENDING_CONDITION: Record<string, string> = {
  SETTLEMENT_VERSION_MISSING: "结算版本缺失",
  RENTER_CONFIRMATION_REQUIRED: "待租客确认",
  OWNER_CONFIRMATION_REQUIRED: "待号主确认",
  PARTY_REJECTED_CURRENT_VERSION: "有一方已拒绝当前版本",
  SUPPORT_REVIEW_REQUIRED: "待客服复核",
  SETTLEMENT_NOT_POSTED: "尚未过账",
  SETTLEMENT_VERSION_SUPERSEDED: "该版本已被后续版本替代",
};

export function pendingConditionLabel(code: string): string {
  return PENDING_CONDITION[code] ?? code;
}

const ENTITLEMENT_STATE: Record<string, { label: string; tone: InlineStatusTone }> = {
  EFFECTIVE: { label: "已生效", tone: "success" },
  NOT_STARTED: { label: "已执行，未到生效时间", tone: "info" },
  STARTED: { label: "已到生效时间", tone: "success" },
  PENDING: { label: "权益待审批", tone: "warning" },
  APPROVED_PENDING_EXECUTION: { label: "权益已批准，待执行", tone: "info" },
  EXECUTED_PENDING_START: { label: "已执行，未到生效时间", tone: "info" },
  ACTIVE: { label: "生效中", tone: "success" },
  EXPIRED: { label: "已到期", tone: "neutral" },
  REVOKED: { label: "已撤销", tone: "neutral" },
  REPLACED: { label: "已被替换", tone: "neutral" },
};

export function entitlementStateView(value: string | undefined | null): { label: string; tone: InlineStatusTone } {
  if (!value) return { label: "权益状态未提供", tone: "unknown" };
  return ENTITLEMENT_STATE[value] ?? { label: value, tone: "unknown" };
}

const POLICY_STATUS: Record<string, string> = {
  DRAFT: "草稿", PENDING: "待审批", APPROVED: "已批准", ACTIVE: "生效中",
  REJECTED: "已驳回", EXPIRED: "已到期", REVOKED: "已撤销", SUPERSEDED: "已被替代",
};

export function policyStatusLabel(value: string | undefined | null): string {
  if (!value) return "状态未提供";
  return POLICY_STATUS[value] ?? value;
}

export const OBJECT_REF_LABELS: Record<string, string> = {
  membership_game: "游戏",
  membership_growth_policy: "会员成长政策",
  membership_entitlement: "会员礼遇权益",
  rental_order: "租赁订单",
  settlement_version: "结算版本",
  settlement_posting: "结算过账",
};

export function objectRefLabel(type: string): string {
  return OBJECT_REF_LABELS[type] ?? type;
}

/** objectRef → 管理平台内已有对象页路径；没有对应页面的类型返回 null，不拼技术 ID 造入口。 */
export function objectRefPath(ref: ObjectRef): string | null {
  if (!ref.id) return null;
  const id = encodeURIComponent(ref.id);
  if (ref.type === "rental_order") return `/orders/${id}`;
  if (ref.type === "membership_entitlement" || ref.type === "membership_growth_policy") return `/membership-growth`;
  return null;
}

// ── 纯 helper ─────────────────────────────────────────────────────────────

export function personLabel(person: Person | undefined | null): string {
  if (!person) return "账号未提供";
  return `${person.name}（${person.displayUsername ?? person.username}）`;
}

/**
 * 金额只用服务端精确串；缺字段或非字符串整体省略，绝不填 0。
 * basis 为 PROPOSED_* 时标明「拟定」，与已到账语义分开。
 */
export function moneyLabel(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const money = value as Partial<Money>;
  if (typeof money.amount !== "string" || money.amount.trim() === "") return null;
  const unit = money.unit === "yuan" ? "元" : money.unit ?? "";
  const suffix = typeof money.basis === "string" && money.basis.startsWith("PROPOSED_") ? "（拟定）" : "";
  return `${money.amount} ${unit}${suffix}`.trim();
}

/** 动作资格以服务端逐项 actions 为准；缺 actions、缺该项或未知动作名一律不可操作。 */
export function actionFor(actions: ActionEligibility[] | undefined, name: string): ActionEligibility | null {
  if (!Array.isArray(actions)) return null;
  const found = actions.find((item) => item && item.action === name);
  return found ?? null;
}

export function canAct(actions: ActionEligibility[] | undefined, name: string): boolean {
  const found = actionFor(actions, name);
  return found?.allowed === true;
}

/** 动作不可用的就地解释；可用时返回 null。 */
export function actionBlockReason(actions: ActionEligibility[] | undefined, name: string): string | null {
  const found = actionFor(actions, name);
  if (!found) return "服务端未提供该动作资格，按不可操作处理";
  if (found.allowed === true) return null;
  const next = nextStepLabel(found.nextStepCode);
  return next ? `${reasonLabel(found.reasonCode)}；${next}` : reasonLabel(found.reasonCode);
}

export const BUSINESS_NOT_CONNECTED = "业务摘要未接入";

/** 列表主标题：业务名称优先，缺失时明确说未接入，不把裸操作码当主文本。 */
export function businessTitleOf(item: Pick<RequestSummary, "business" | "operationCode">): string {
  const title = item.business?.businessTitle;
  if (typeof title === "string" && title.trim()) return title;
  if (item.business === undefined) return BUSINESS_NOT_CONNECTED;
  return "未登记的业务操作";
}

export function executionModeLabel(mode: string | undefined | null): string {
  if (mode === "GENERIC_TRANSACTION") return "平台执行";
  if (mode === "SOURCE_BUSINESS") return "来源业务完成";
  if (mode === "UNSUPPORTED") return "不支持执行";
  return mode ? mode : "执行方式未提供";
}

/**
 * 业务进度：与审批状态分列的领域事实。
 * 读不到、无权、未到阶段分别表达，不用审批状态冒充业务结果。
 */
export function businessProgress(business: BusinessView | undefined): { label: string; tone: InlineStatusTone; detail: string | null } {
  if (business === undefined) return { label: BUSINESS_NOT_CONNECTED, tone: "unknown", detail: null };
  const restricted = business.restrictedReasonCodes;
  if (business.summaryAvailable === false && Array.isArray(restricted) && restricted.length > 0) {
    return { label: "无权查看业务结果", tone: "neutral", detail: restricted.map(reasonLabel).join("；") };
  }
  const availability = business.resultAvailability;
  if (availability === "NOT_APPLICABLE") return { label: "尚未到执行阶段", tone: "neutral", detail: null };
  if (availability === "UNRESOLVED") {
    return { label: "业务结果未读到", tone: "unknown", detail: reasonLabel(business.resultReasonCode) };
  }
  if (availability !== "KNOWN") return { label: "业务结果未提供", tone: "unknown", detail: null };

  const settlement = business.settlementResult;
  if (settlement) {
    if (settlement.posted) return { label: "结算已过账", tone: "success", detail: `版本 ${settlement.versionNo}` };
    const pending = (business.pendingConditionCodes ?? []).map(pendingConditionLabel);
    return {
      label: "结算未完成",
      tone: "warning",
      detail: pending.length > 0 ? pending.join(" · ") : `版本 ${settlement.versionNo} 尚未过账`,
    };
  }
  const policy = business.publishedPolicy;
  if (policy) return { label: `政策 v${policy.version} · ${policyStatusLabel(policy.status)}`, tone: "info", detail: null };
  const entitlement = business.entitlement;
  if (entitlement) {
    const view = entitlementStateView(entitlement.effectiveState || entitlement.status);
    return { label: view.label, tone: view.tone, detail: null };
  }
  return { label: "业务结果未提供", tone: "unknown", detail: null };
}

/** 执行状态：只回答「本次执行是否成功」，不代表业务对象已生效或已到账。 */
export function executionProgress(detail: Pick<RequestDetail, "execution" | "status" | "business">): { label: string; tone: InlineStatusTone; detail: string | null } {
  const execution = detail.execution;
  if (!execution) {
    if (detail.business?.executionMode === "SOURCE_BUSINESS") {
      return { label: "审批页不执行，由来源业务完成", tone: "info", detail: null };
    }
    if (detail.status === "APPROVED") return { label: "待执行", tone: "info", detail: null };
    return { label: "尚未执行", tone: "neutral", detail: null };
  }
  const view = executionView(execution.status);
  return { label: view.label, tone: view.tone, detail: execution.resultDetail ?? execution.resultCode ?? null };
}

export function candidateAvailabilityLabel(value: RequestSummary["candidateAvailability"]): string | null {
  if (!value) return null;
  if (value.blockingReasonCode) return `候选 ${value.total} 人，无人可处理：${reasonLabel(value.blockingReasonCode)}`;
  return `候选 ${value.total} 人，其中 ${value.eligible} 人当前合格`;
}

/** 写成功后需要读回哪些读取面来确认最新状态；可序列化，随责任记录一起保存。 */
export type ReadbackTarget =
  | { kind: "templates" }
  | { kind: "lists"; keys: Array<"mine" | "pending" | "audit"> }
  | { kind: "detail-and-lists"; requestId: string; keys: Array<"mine" | "pending" | "audit"> };

// ── 审计事件词表（动作码取自 approval-audit.ts 的 recordAudit 调用点）────────

export const AUDIT_ACTIONS = [
  "approval.request.created",
  "approval.request.approved",
  "approval.request.rejected",
  "approval.request.cancelled",
  "approval.request.expired",
  "approval.request.candidate_added",
  "approval.request.withdrawn",
  "approval.execution.completed",
  "approval.template.configured",
];

const AUDIT_ACTION_LABELS: Record<string, string> = {
  "approval.request.created": "提交申请",
  "approval.request.approved": "审批同意",
  "approval.request.rejected": "审批驳回",
  "approval.request.cancelled": "申请被替代或取消",
  "approval.request.withdrawn": "撤回申请",
  "approval.request.expired": "申请过期",
  "approval.request.candidate_added": "追加审批人",
  "approval.execution.completed": "执行完成",
  "approval.template.configured": "配置审批模板",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export const AUDIT_OBJECT_TYPES: Array<{ value: string; label: string }> = [
  { value: "approval_request", label: "审批申请" },
  { value: "approval_template", label: "审批模板" },
];

export function auditObjectLabel(objectType: string): string {
  return AUDIT_OBJECT_TYPES.find((item) => item.value === objectType)?.label ?? objectType;
}

export function auditOutcomeView(outcome: string): { label: string; tone: InlineStatusTone } {
  if (outcome === "SUCCESS") return { label: "成功", tone: "success" };
  if (outcome === "FAILURE") return { label: "失败", tone: "error" };
  return { label: outcome, tone: "unknown" };
}

/** audit_event.request_id 是 HTTP 请求编号，不是审批申请；只有审批申请对象本身可跳转。 */
export function relatedRequestIdOf(event: AuditEvent): string | null {
  return event.objectType === "approval_request" ? event.objectId : null;
}

export function auditNarrative(event: AuditEvent): string {
  if (event.reason) return event.reason;
  const summary = event.details?.summary;
  if (typeof summary === "string" && summary.trim()) return summary;
  return "无附加说明";
}

export function auditScopeLabel(scope: string | undefined): string {
  if (scope === "BOSS_ALL_APPROVAL_EVENTS") return "Boss：全部审批与授权事件";
  if (scope === "ACTOR_OR_REQUEST_SCOPE") return "当前账号：本人操作或本人相关申请的事件";
  return "已按当前账号范围过滤";
}
