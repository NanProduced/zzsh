import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import { MembershipBenefitsWorkspace, useMembershipApprovalRequest } from "./membership-benefits-workspace";
import {
  bootstrapGrowthPolicy,
  MembershipGrowthAdminView,
  requestKind,
  unifiedDraftFromProjection,
  unifiedPricingInputFromDraft,
  type AdminGrowthCatalog,
  type AdminGrowthPolicy,
  type AdminGrowthSubject,
  type AdminApproval,
  type AdminPolicyChangeDiff,
  type AdminPolicyRequestedValue,
  type AdminPolicyNotice,
  type AdminPolicyChangeProjection,
  type AdminPolicyChangePerson,
  type AdminPolicyChangeRead,
  type AdminPolicyChangeRequest,
  type AdminPolicyChangeStep,
  type AdminPricingMode,
  type MembershipGrowthAdminState,
} from "./membership-growth-view";
import {
  UNIFIED_PRICING_SCHEMA,
  UNIFIED_PRICING_SCOPE,
  type AdminGrowthCapability,
  type UnifiedDraft,
  type UnifiedPricingProjection,
} from "./membership-unified-contract";

export type PolicyBootstrap = {
  ruleReleaseId: string;
  priceVersionId: string;
  haffSchema: "haff-ratio-v1" | "haff-ratio-v2" | null;
  releaseMode: "SPREAD" | "PERCENT";
  enabledModes: AdminPricingMode[];
  nextVersionNo: number;
  expectedVersion: string;
};

type PolicyMeta = {
  id: string;
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAtUtc: string | null;
  ruleReleaseId: string;
  priceVersionId: string;
  sourceRef: string;
  payloadHash: string;
};

type PolicyResponse = {
  approvedMeta?: { id: string; version: string; effectiveAtUtc: string | null; priceVersionId?: string; payloadHash?: string } | null;
  approvedPolicy?: Record<string, any> | null;
  approvedUnifiedPricing?: UnifiedPricingProjection | null;
  policy: Record<string, any> | null;
  unifiedPricing?: UnifiedPricingProjection | null;
  meta: PolicyMeta | null;
  capability?: AdminGrowthCapability;
  catalog: AdminGrowthCatalog;
  thresholds: Record<string, string>;
  bootstrap?: PolicyBootstrap | null;
  policyChange?: unknown;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function personOf(value: unknown): AdminPolicyChangePerson | null {
  const record = recordOf(value);
  const id = textOf(record?.id);
  return id ? { id, name: textOf(record?.name) } : null;
}

function stepOf(value: unknown): AdminPolicyChangeStep | null {
  const record = recordOf(value);
  const key = textOf(record?.key)?.toUpperCase();
  const label = textOf(record?.label);
  const state = textOf(record?.state)?.toUpperCase();
  if (!key || !label || !["SUBMITTED", "APPROVAL", "EXECUTION", "EFFECTIVE"].includes(key)) return null;
  if (!state || !["COMPLETED", "CURRENT", "PENDING", "FAILED", "UNKNOWN"].includes(state)) return null;
  return {
    key: key as AdminPolicyChangeStep["key"],
    label,
    state: state as AdminPolicyChangeStep["state"],
    actor: personOf(record?.actor),
    atUtc: textOf(record?.atUtc),
    note: textOf(record?.note),
  };
}

function diffOf(value: unknown): AdminPolicyChangeDiff | null {
  const record = recordOf(value);
  const label = textOf(record?.label);
  if (!label) return null;
  const format = textOf(record?.format)?.toUpperCase();
  const risk = textOf(record?.risk)?.toUpperCase();
  return {
    label,
    baseline: textOf(record?.baseline),
    requested: textOf(record?.requested),
    format: format === "DISCOUNT" || format === "CENTS" ? format : "TEXT",
    risk: risk === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "LOW",
  };
}

function requestedValuesOf(value: unknown): AdminPolicyRequestedValue[] | null {
  if (!Array.isArray(value) || value.length > 19) return null;
  const values: AdminPolicyRequestedValue[] = [];
  for (const item of value) {
    const row = recordOf(item), label = textOf(row?.label), format = row?.format;
    if (!label || typeof format !== "string" || !["TEXT", "DISCOUNT", "CENTS"].includes(format) || row?.value !== null && typeof row?.value !== "string") return null;
    values.push({ label, value: row!.value as string | null, format: format as AdminPolicyRequestedValue["format"] });
  }
  return values;
}

/** Optional read projection; absence or an incomplete shape never means there is no request. */
export function normalizePolicyChange(raw: unknown): AdminPolicyChangeRead {
  if (raw === undefined) return { status: "UNAVAILABLE", message: "暂时无法读取申请状态，请稍后刷新。" };
  if (raw === null) return { status: "UNAVAILABLE", message: "暂时无法读取申请状态，请稍后刷新。" };
  const record = recordOf(raw);
  const knowledge = textOf(record?.knowledge)?.toUpperCase();
  if (!record || !knowledge || !["KNOWN", "UNKNOWN", "FORBIDDEN"].includes(knowledge)) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  if (knowledge === "KNOWN" && record.request === undefined) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  const requestRecord = record.request === null || record.request === undefined ? null : recordOf(record.request);
  if (record.request !== null && record.request !== undefined && (!requestRecord || !textOf(requestRecord.id))) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  const reference = recordOf(record.draftReference);
  const request: AdminPolicyChangeRequest | null = requestRecord ? {
    id: textOf(requestRecord.id)!,
    operationCode: textOf(requestRecord.operationCode),
    approvalStatus: textOf(requestRecord.approvalStatus) ?? "UNKNOWN",
    executionStatus: textOf(requestRecord.executionStatus),
    reason: textOf(requestRecord.reason),
    submittedBy: personOf(requestRecord.submittedBy),
    submittedAtUtc: textOf(requestRecord.submittedAtUtc),
    plannedEffectiveAtUtc: textOf(requestRecord.plannedEffectiveAtUtc),
    steps: Array.isArray(requestRecord.steps) ? requestRecord.steps.map(stepOf).filter((step): step is AdminPolicyChangeStep => step !== null) : null,
  } : null;
  const diffSource = Array.isArray(record.immutableDiff) ? record.immutableDiff.map(diffOf).filter((diff): diff is AdminPolicyChangeDiff => diff !== null) : null;
  const effective = recordOf(record.effectiveState);
  return {
    status: "READY",
    knownRequestId: request?.id ?? null,
    change: {
      knowledge: knowledge as AdminPolicyChangeProjection["knowledge"],
      draftReference: reference && textOf(reference.id) && textOf(reference.version) && textOf(reference.payloadHash)
        ? { id: textOf(reference.id)!, version: textOf(reference.version)!, payloadHash: textOf(reference.payloadHash)! }
        : null,
      request,
      requestedValues: knowledge === "KNOWN" && request?.operationCode === "membership.benefit.policy.publish" && reference && textOf(reference.id) && textOf(reference.version) && textOf(reference.payloadHash) ? requestedValuesOf(record.requestedValues) : null,
      immutableDiff: diffSource !== null && record.immutableDiff && Array.isArray(record.immutableDiff) && record.immutableDiff.length > 0 && diffSource.length === 0 ? null : diffSource,
      effectiveState: effective && textOf(effective.status) ? {
        status: textOf(effective.status)!,
        effectiveAtUtc: textOf(effective.effectiveAtUtc),
        executed: typeof effective.executed === "boolean" ? effective.executed : null,
      } : null,
      message: textOf(record.message),
    },
  };
}

type DraftResponse = {
  id: string;
  version: string;
  status: "DRAFT";
  payloadHash: string;
  publishable: boolean;
  warnings: string[];
  unifiedPricing?: UnifiedPricingProjection;
};

export function policyDraftApprovalPayload(meta: PolicyMeta) {
  if (meta.status !== "DRAFT" || !/^[0-9a-f]{64}$/.test(meta.payloadHash)) throw new Error("请先保存当前政策草稿");
  return { policyDraftId: meta.id, policyDraftVersion: Number(meta.version), policyDraftHash: meta.payloadHash, ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef, effectiveAtUtc: meta.effectiveAtUtc };
}

type SubjectResponse = { subjectId: string; growth?: { knowledge: "KNOWN" | "UNKNOWN"; effectiveTier: string | null; rollingPoints: string | null; lifetimePoints: string | null; sourceState: string }; authorizationState?: string };

const TIERS = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"] as const;

function mapPolicyPayload(raw: Record<string, any>, meta: { version: string; status: string; effectiveAtUtc: string | null }, catalog: AdminGrowthCatalog, thresholds: Record<string, string>): AdminGrowthPolicy {
  const tierConfig = raw.tiers as Record<string, any>;
  return {
    version: meta.version,
    status: meta.status === "APPROVED" ? "APPROVED" : "DRAFT",
    effectiveAt: meta.effectiveAtUtc,
    catalog,
    tiers: TIERS.map((tier) => {
      const config = tierConfig[tier] ?? {};
      return {
        tier,
        threshold: thresholds[tier] ?? "0",
        tenantDeposit: config.tenantDeposit === "WAIVED" ? "WAIVED" : "ACCOUNT_BASE",
        depositAllowanceCents: typeof config.depositAllowanceCents === "string" ? config.depositAllowanceCents : "0",
      };
    }),
  };
}

function asPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (response.policy && response.meta) return mapPolicyPayload(response.policy, response.meta, response.catalog, response.thresholds);
  if (!response.policy && response.bootstrap) return bootstrapGrowthPolicy(response.catalog, response.thresholds, response.bootstrap.nextVersionNo);
  return null;
}

function asApprovedPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (!response.approvedPolicy || !response.approvedMeta) return null;
  return mapPolicyPayload(response.approvedPolicy, { ...response.approvedMeta, status: "APPROVED" }, response.catalog, response.thresholds);
}

function emptyUnifiedProjection(reasonCodes: string[]): UnifiedPricingProjection {
  const unknownTier = () => ({ knowledge: "UNKNOWN" as const, payableRatio: null, reasonCodes });
  const unknownRange = () => ({ knowledge: "UNKNOWN" as const, minPayableRatio: null, maxPayableRatio: null, priceVersionId: null, costBasisRef: null, reasonCodes });
  return {
    schema: UNIFIED_PRICING_SCHEMA,
    scope: UNIFIED_PRICING_SCOPE,
    knowledge: "UNKNOWN",
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, unknownTier()])) as UnifiedPricingProjection["tiers"],
    entitlementRanges: { FRIEND: unknownRange(), PRESTIGE: unknownRange() },
  };
}

function latestUnified(response: PolicyResponse): UnifiedPricingProjection {
  if (response.unifiedPricing) return response.unifiedPricing;
  if (response.capability?.unifiedPricingSupported === true) return emptyUnifiedProjection(["UNIFIED_PRICING_UNAVAILABLE"]);
  return emptyUnifiedProjection(["POLICY_UNAVAILABLE"]);
}

/** Metadata/deposits only; the server normalizes pricing and ranges from unifiedPricing. */
function toDraftPolicyBody(policy: AdminGrowthPolicy, versionNo: number): Record<string, unknown> {
  return {
    schema: "membership-growth-v1",
    version: String(versionNo),
    status: "DRAFT",
    effectiveAt: policy.effectiveAt,
    sourceRef: "admin:membership-growth",
    tiers: Object.fromEntries(policy.tiers.map((tier) => [tier.tier, {
      tier: tier.tier,
      tenantDeposit: tier.tenantDeposit,
      ...(tier.depositAllowanceCents !== undefined ? { depositAllowanceCents: tier.depositAllowanceCents } : {}),
    }])),
  };
}

function subjectOf(response: SubjectResponse | null, subjectId: string | undefined, error: unknown = null): AdminGrowthSubject {
  if (!subjectId) return { subjectId: "", status: "NOT_LOADED", reason: "从用户详情打开会员成长后再读取对象" };
  if (!response) return { subjectId, status: error instanceof AdminApiError && error.status === 403 ? "FORBIDDEN" : "UNKNOWN", reason: error instanceof AdminApiError ? `读取失败：${error.status}` : "用户成长来源暂未闭合" };
  if (response.growth?.knowledge !== "KNOWN") return { subjectId, status: "UNKNOWN", reason: `来源状态：${response.growth?.sourceState ?? "UNKNOWN"}` };
  return { subjectId, status: "LOADED", userLabel: subjectId, tier: response.growth.effectiveTier ?? "UNKNOWN", rollingPoints: response.growth.rollingPoints ?? undefined, lifetimePoints: response.growth.lifetimePoints ?? undefined };
}

function policyFailure(error: unknown, response: PolicyResponse | null): string {
  if (error instanceof AdminApiError && error.status === 403) return "当前管理员没有会员成长读取权限";
  if (error instanceof AdminApiError && error.status === 404) return "会员成长功能尚未启用";
  if (response && !response.policy && !response.bootstrap) return "当前没有可用的价格配置，暂时不能建立草稿";
  if (error instanceof AdminApiError) return "会员成长政策暂时无法读取";
  return "尚未读取到会员政策；功能保持未启用或等待首个草稿";
}

export function membershipGrowthAccess(snapshot: Extract<SessionSnapshot, { authenticated: true }>) {
  const boss = snapshot.security.isBoss;
  const canDraft = boss || hasPermission(snapshot, "membership.policy.draft");
  const canRequest = boss || (hasPermission(snapshot, "membership.policy.publish") && hasPermission(snapshot, "approval.request.create"));
  const canReadPolicy = canDraft || hasPermission(snapshot, "membership.policy.publish") || hasPermission(snapshot, "membership.growth.read.summary");
  const canRequestEntitlement = boss || (hasPermission(snapshot, "approval.request.create") && hasPermission(snapshot, "membership.entitlement.request"));
  return { canRead: canReadPolicy || canRequestEntitlement, canReadPolicy, canDraft, canRequest, canRequestEntitlement };
}

type HostProps = { tab: WorkspaceTab; snapshot: Extract<SessionSnapshot, { authenticated: true }>; onDirtyChange: (dirty: boolean) => void; refreshNonce: number; onOpenPath?: (path: string, title?: string) => void };

export function MembershipGrowthAdminHost(props: HostProps) {
  const access = membershipGrowthAccess(props.snapshot);
  return <MembershipBenefitsWorkspace snapshot={props.snapshot} initialUserId={props.tab.query.userId} initialGameId={props.tab.query.gameId} refreshNonce={props.refreshNonce} onOpenPath={props.onOpenPath}
    initialTab={access.canReadPolicy && !access.canRequestEntitlement ? "policy" : "entitlements"}
    policy={access.canReadPolicy ? <MembershipGrowthPolicyHost {...props} /> : undefined} />;
}

function MembershipGrowthPolicyHost({ tab, snapshot, onDirtyChange, refreshNonce, onOpenPath }: HostProps) {
  const subjectId = tab.query.userId;
  const gameId = tab.query.gameId;
  const [state, setState] = useState<MembershipGrowthAdminState>({ status: "loading" });
  const [meta, setMeta] = useState<PolicyMeta | null>(null);
  const [bootstrap, setBootstrap] = useState<PolicyBootstrap | null>(null);
  const [savedDraft, setSavedDraft] = useState<PolicyMeta | null>(null);
  const [savedDraftInfo, setSavedDraftInfo] = useState<{ publishable: boolean; warnings: string[] } | null>(null);
  const [approvedMeta, setApprovedMeta] = useState<PolicyResponse["approvedMeta"]>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [subject, setSubject] = useState<AdminGrowthSubject>({ subjectId: subjectId ?? "", status: "NOT_LOADED" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [policyResetNonce, setPolicyResetNonce] = useState(0);
  const [policyReadRetry, setPolicyReadRetry] = useState(0);
  const [changeRefreshError, setChangeRefreshError] = useState<string | null>(null);
  const [changeRefreshing, setChangeRefreshing] = useState(false);
  const approvalWrite = useMembershipApprovalRequest(snapshot, "policy");
  const editRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const savingRef = useRef(false);
  const changeRefreshRef = useRef(false);
  const policyIdentity = JSON.stringify([snapshot.adminUserId, snapshot.session.id]);
  const knownPolicyRequestRef = useRef<{ identity: string; requestId: string | null }>({ identity: policyIdentity, requestId: null });
  if (knownPolicyRequestRef.current.identity !== policyIdentity) knownPolicyRequestRef.current = { identity: policyIdentity, requestId: null };
  const rememberPolicyChange = (read: AdminPolicyChangeRead): AdminPolicyChangeRead => {
    const change = read.status === "READY" ? read.change : null;
    const explicitNoRequest = change?.knowledge === "KNOWN" && change.request === null;
    const observedId = read.knownRequestId ?? change?.request?.id ?? null;
    knownPolicyRequestRef.current.requestId = explicitNoRequest ? null : observedId ?? knownPolicyRequestRef.current.requestId;
    const knownRequestId = knownPolicyRequestRef.current.requestId;
    return change?.knowledge === "FORBIDDEN"
      ? { status: "READY", knownRequestId, change: { knowledge: "FORBIDDEN", request: null, draftReference: null, immutableDiff: null, effectiveState: null, message: change.message ?? null } }
      : { ...read, knownRequestId };
  };
  const draftRef = useRef<{ policy: AdminGrowthPolicy; unified: UnifiedDraft } | null>(null);
  const savedBaselineRef = useRef<{
    policy: AdminGrowthPolicy;
    unified: UnifiedDraft;
    unifiedPricing: UnifiedPricingProjection;
    meta: PolicyMeta | null;
    savedDraft: PolicyMeta | null;
    savedDraftInfo: { publishable: boolean; warnings: string[] } | null;
  } | null>(null);

  useEffect(() => {
    if (!membershipGrowthAccess(snapshot).canReadPolicy) {
      setState({ status: "permission", message: "当前管理员没有会员成长配置权限" });
      return;
    }
    const controller = new AbortController();
    generationRef.current += 1;
    const generation = generationRef.current;
    setState({ status: "loading" });
    setSaving(false);
    setSaveError(null);
    setChangeRefreshError(null);
    setChangeRefreshing(false);
    changeRefreshRef.current = false;
    setSavedDraft(null);
    setSavedDraftInfo(null);
    setSubmittedHash(null);
    const settle = <T,>(request: Promise<T>) => request.then((value) => ({ value, error: null as unknown })).catch((error: unknown) => ({ value: null, error }));
    Promise.all([
      settle(adminRequest<PolicyResponse>("/membership-growth/policy", undefined, "GET", {}, controller.signal)),
      subjectId ? settle(adminRequest<SubjectResponse>(`/users/${encodeURIComponent(subjectId)}/membership-growth`, undefined, "GET", {}, controller.signal)) : Promise.resolve({ value: null, error: null as unknown }),
    ]).then(([policyResult, subjectResult]) => {
      if (controller.signal.aborted || generation !== generationRef.current || knownPolicyRequestRef.current.identity !== policyIdentity) return;
      const policy = policyResult.value ? asPolicy(policyResult.value) : null;
      const nextSubject = subjectOf(subjectResult.value, subjectId, subjectResult.error);
      setMeta(policyResult.value?.meta ?? null);
      setApprovedMeta(policyResult.value?.approvedMeta ?? null);
      setBootstrap(policyResult.value?.bootstrap ?? null);
      setSavedDraft(policyResult.value?.meta?.status === "DRAFT" ? policyResult.value.meta : null);
      setSubject(nextSubject);
      if (!policy) {
        setState({ status: "error", message: policyFailure(policyResult.error, policyResult.value), subject: nextSubject });
        return;
      }
      const response = policyResult.value!;
      const unifiedPricing = latestUnified(response);
      const unified = unifiedDraftFromProjection(unifiedPricing);
      const loadedMeta = response.meta ?? null;
      const loadedSavedDraft = loadedMeta?.status === "DRAFT" ? loadedMeta : null;
      const initialPolicyChange = rememberPolicyChange(normalizePolicyChange(response.policyChange));
      const serverExplicitNoRequest = initialPolicyChange.status === "READY" && initialPolicyChange.change?.knowledge === "KNOWN" && initialPolicyChange.change.request === null;
      draftRef.current = { policy, unified };
      savedBaselineRef.current = {
        policy,
        unified,
        unifiedPricing,
        meta: loadedMeta,
        savedDraft: loadedSavedDraft,
        savedDraftInfo: null,
      };
      setState({
        status: "ready",
        policy,
        unifiedPricing,
        approvedPolicy: asApprovedPolicy(response),
        approvedUnifiedPricing: response.approvedUnifiedPricing ?? null,
        capability: response.capability ?? {},
        preview: { status: "NOT_RUN", reason: "真实报价预览需在正式quote与主体快照接线后执行" },
        subject: nextSubject,
        approval: loadedSavedDraft && !serverExplicitNoRequest ? { status: "UNKNOWN", message: "申请状态待确认，请刷新或查看原申请。" } : { status: "NOT_REQUESTED" },
        policyChange: initialPolicyChange,
        draftReference: loadedSavedDraft ? { id: loadedSavedDraft.id, version: loadedSavedDraft.version, payloadHash: loadedSavedDraft.payloadHash } : null,
      });
    });
    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [refreshNonce, policyReadRetry, subjectId, snapshot]);

  const currentDraft = state.status === "ready" ? savedDraft ?? (meta?.status === "DRAFT" ? meta : null) : null;
  const currentDraftKey = currentDraft ? `${currentDraft.id}|${currentDraft.version}|${currentDraft.payloadHash}` : "";
  const verifiedReference = approvalWrite.verifiedReference;
  const referencedDraftMatches = Boolean(verifiedReference && currentDraft
    && verifiedReference.policyDraftId === currentDraft.id
    && verifiedReference.policyDraftVersion === currentDraft.version
    && verifiedReference.policyDraftHash === currentDraft.payloadHash);
  const closedDetailStatus = ["REJECTED", "EXPIRED", "CANCELLED"].includes(approvalWrite.detailStatus ?? "") ? approvalWrite.detailStatus as "REJECTED" | "EXPIRED" | "CANCELLED" : null;
  const serverNoRequest = state.status === "ready" && state.policyChange.status === "READY" && state.policyChange.change?.knowledge === "KNOWN" && state.policyChange.change.request === null;
  const serverChange = state.status === "ready" && state.policyChange.status === "READY" ? state.policyChange.change : null;
  const serverClosedHook = Boolean(serverChange?.knowledge === "KNOWN" && serverChange.request?.id === approvalWrite.requestId
    && serverChange.request?.operationCode === "membership.benefit.policy.publish" && verifiedReference
    && serverChange.draftReference?.id === verifiedReference.policyDraftId
    && serverChange.draftReference?.version === verifiedReference.policyDraftVersion
    && serverChange.draftReference?.payloadHash === verifiedReference.policyDraftHash
    && ["rejected", "expired", "cancelled", "effective"].includes(requestKind(serverChange.request!, serverChange)));
  const historyReadbackOnly = Boolean(serverNoRequest && verifiedReference && !referencedDraftMatches
    && approvalWrite.pending.state === "absent" && (closedDetailStatus || approvalWrite.detailStatus === "EXECUTED"));
  const verifiedMessage = approvalWrite.detailStatus === "REJECTED"
    ? "审批已驳回；请核对原因后决定是否重新提交。"
    : approvalWrite.detailStatus === "APPROVED"
      ? "审批已通过，等待执行/发布；批准不等于已发布。"
      : approvalWrite.detailStatus === "PENDING"
        ? "已提交审批，等待审批中心处理。"
        : approvalWrite.detailStatus
          ? `服务端审批状态：${approvalWrite.detailStatus}。`
          : "已提交审批，等待审批中心处理。";

  useEffect(() => {
    if (state.status !== "ready" || !approvalWrite.requestId) return;
    setState((current) => {
      if (current.status !== "ready") return current;
      if (closedDetailStatus && verifiedReference && approvalWrite.pending.state === "absent") {
        return { ...current, approval: { status: closedDetailStatus, requestId: approvalWrite.requestId ?? undefined } };
      }
      if (historyReadbackOnly) {
        return { ...current, approval: { status: "NOT_REQUESTED" } };
      }
      if (referencedDraftMatches) {
        const next = {
          status: approvalWrite.detailStatus === "REJECTED" ? "REJECTED" as const : "REQUESTED" as const,
          requestId: approvalWrite.requestId ?? undefined,
          message: verifiedMessage,
        };
        if (current.approval.requestId === next.requestId && current.approval.status === next.status && current.approval.message === next.message) return current;
        return { ...current, approval: next };
      }
      // An accepted ID only proves a request exists; only a verified same-draft reference may mark this draft requested.
      if (current.approval.status === "UNKNOWN") return current;
      return {
        ...current,
        approval: {
          status: "UNKNOWN",
          message: verifiedReference
            ? "原申请属于另一份草稿；当前草稿关联未知，请以审批中心为准。"
            : "申请已受理，详情待核；当前草稿关联未知，请查询原结果或到审批中心核对。",
        },
      };
    });
    // Scalar dependencies only: the whole state object changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalWrite.requestId, approvalWrite.detailStatus, verifiedReference?.policyDraftId, verifiedReference?.policyDraftVersion, verifiedReference?.policyDraftHash, state.status, currentDraftKey, refreshNonce, approvalWrite.pending.state, historyReadbackOnly]);

  if (state.status !== "ready") return <MembershipGrowthAdminView state={state}
    policyReadbackId={knownPolicyRequestRef.current.requestId} onOpenPath={onOpenPath}
    onRefreshPolicyChange={() => setPolicyReadRetry(value => value + 1)} />;

  const access = membershipGrowthAccess(snapshot);
  const ready = state;
  const binding = meta
    ? { ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef }
    : bootstrap
      ? { ruleReleaseId: bootstrap.ruleReleaseId, priceVersionId: bootstrap.priceVersionId, sourceRef: "admin:membership-growth" }
      : null;
  const unifiedSupported = ready.capability.unifiedPricingSupported === true;

  const saveDraft = async () => {
    if (!binding || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const revision = editRevisionRef.current;
    const generation = generationRef.current;
    const currentDraft = draftRef.current ?? { policy: ready.policy, unified: unifiedDraftFromProjection(ready.unifiedPricing) };
    try {
      const versionNo = meta ? Number(meta.version) + 1 : bootstrap!.nextVersionNo;
      const expectedVersion = meta ? meta.version : bootstrap!.expectedVersion;
      const result = await adminRequest<DraftResponse>("/membership-growth/policy-drafts", {
        policy: toDraftPolicyBody(currentDraft.policy, versionNo),
        unifiedPricing: unifiedPricingInputFromDraft(currentDraft.unified),
        versionNo,
        expectedVersion,
        effectiveAtUtc: currentDraft.policy.effectiveAt,
        ruleReleaseId: binding.ruleReleaseId,
        priceVersionId: binding.priceVersionId,
        sourceRef: binding.sourceRef,
      });
      if (generation !== generationRef.current) return;
      const saved: PolicyMeta = { id: result.id, version: result.version, status: "DRAFT", effectiveAtUtc: currentDraft.policy.effectiveAt, ruleReleaseId: binding.ruleReleaseId, priceVersionId: binding.priceVersionId, sourceRef: binding.sourceRef, payloadHash: result.payloadHash };
      const savedUnifiedPricing = result.unifiedPricing ?? ready.unifiedPricing;
      const savedUnified = unifiedDraftFromProjection(savedUnifiedPricing);
      const savedPolicy = { ...currentDraft.policy, version: result.version, status: "DRAFT" as const };
      const savedInfo = { publishable: result.publishable, warnings: result.warnings ?? [] };
      setMeta(saved);
      // The server accepted this draft even if the operator has already typed newer values.
      savedBaselineRef.current = { policy: savedPolicy, unified: savedUnified, unifiedPricing: savedUnifiedPricing, meta: saved, savedDraft: saved, savedDraftInfo: savedInfo };
      if (revision === editRevisionRef.current) {
        setSavedDraft(saved);
        setSavedDraftInfo(savedInfo);
        draftRef.current = { policy: savedPolicy, unified: savedUnified };
        setState((current) => current.status === "ready" ? {
          ...current,
          policy: savedPolicy,
          unifiedPricing: savedUnifiedPricing,
          draftReference: { id: saved.id, version: saved.version, payloadHash: saved.payloadHash },
          approval: current.approval.status === "REJECTED"
            ? { status: "NOT_REQUESTED", message: "新草稿已保存，可重新提交审批。" }
            : current.approval.status === "REQUESTED"
              ? { status: "UNKNOWN", requestId: current.approval.requestId, message: "当前草稿已保存为新修订；原申请可能对应旧修订，请到审批中心核对。" }
              : current.approval,
        } : current);
        onDirtyChange(false);
      }
    } catch (failure) {
      if (generation === generationRef.current) setSaveError(friendlyError(failure));
    } finally {
      savingRef.current = false;
      if (generation === generationRef.current) setSaving(false);
    }
  };

  const submitApproval = async () => {
    if (!meta || !savedDraft) {
      setState((current) => current.status === "ready" ? { ...current, approval: { status: "NOT_REQUESTED", message: "请先保存当前政策草稿，再提交审批" } } : current);
      return;
    }
    const generation = generationRef.current;
    const requestId = await approvalWrite.submit({ operationCode: "membership.benefit.policy.publish", triggerCondition: "membership.policy.publish.requested", payloadVersion: 1, payload: policyDraftApprovalPayload(savedDraft), summary: `发布会员政策 ${savedDraft.version}` });
    if (!requestId) return;
    if (generationRef.current !== generation) return;
    setSubmittedHash(savedDraft.payloadHash);
  };

  const handlePolicyChange = (policy: AdminGrowthPolicy, unified: UnifiedDraft) => {
    editRevisionRef.current += 1;
    setSavedDraft(null);
    setSavedDraftInfo(null);
    draftRef.current = { policy, unified };
    onDirtyChange(true);
  };

  // Only the policy draft view is reset. Approval original-key/UNKNOWN and in-flight save facts stay untouched.
  const discardPolicyChanges = () => {
    const baseline = savedBaselineRef.current;
    if (!baseline) return;
    editRevisionRef.current += 1;
    draftRef.current = { policy: baseline.policy, unified: baseline.unified };
    setMeta(baseline.meta);
    setSavedDraft(baseline.savedDraft);
    setSavedDraftInfo(baseline.savedDraftInfo);
    setState((current) => current.status === "ready" ? {
      ...current,
      policy: baseline.policy,
      unifiedPricing: baseline.unifiedPricing,
      draftReference: baseline.meta?.status === "DRAFT" ? { id: baseline.meta.id, version: baseline.meta.version, payloadHash: baseline.meta.payloadHash } : null,
    } : current);
    setPolicyResetNonce((value) => value + 1);
    onDirtyChange(false);
  };

  const refreshPolicyChange = async () => {
    if (changeRefreshRef.current || approvalWrite.busy) return;
    changeRefreshRef.current = true;
    setChangeRefreshing(true);
    setChangeRefreshError(null);
    const generation = generationRef.current;
    const classify = (
      previousRead: AdminPolicyChangeRead,
      currentDraftRef: { id: string; version: string; payloadHash: string } | null,
      responseRead: AdminPolicyChangeRead,
    ) => {
      const previousId = previousRead.knownRequestId ?? (previousRead.status === "READY" ? previousRead.change?.request?.id ?? null : null);
      const knownId = previousId ?? approvalWrite.requestId ?? null;
      const change = responseRead.status === "READY" ? responseRead.change : null;
      const request = change?.request ?? null;
      const reference = change?.draftReference ?? null;
      const completeReference = Boolean(reference && reference.id && reference.version && reference.payloadHash);
      const exactOperation = request?.operationCode === "membership.benefit.policy.publish";
      const kind = request && completeReference && exactOperation ? requestKind(request, change!) : null;
      const matchesCurrent = Boolean(completeReference && currentDraftRef && reference!.id === currentDraftRef.id && reference!.version === currentDraftRef.version && reference!.payloadHash === currentDraftRef.payloadHash);
      const terminalDifferent = Boolean(kind && (["rejected", "expired", "cancelled", "effective"].includes(kind)) && !matchesCurrent);
      const publishedWithoutDraft = Boolean(!currentDraftRef && request && completeReference && exactOperation && (kind === "pending-effective" || kind === "effective"));
      const explicitNoRequest = responseRead.status === "READY" && change?.knowledge === "KNOWN" && change.request === null;
      const verifiedNext = explicitNoRequest || Boolean(request && exactOperation && completeReference && (matchesCurrent || terminalDifferent || publishedWithoutDraft));
      const forbidden = responseRead.status === "READY" && change?.knowledge === "FORBIDDEN";
      const knownRequestId = request?.id ?? knownId;
      const nextWithId = responseRead.status === "READY"
        ? { ...responseRead, knownRequestId: explicitNoRequest ? null : knownRequestId }
        : { ...responseRead, knownRequestId };
      const sanitizedForbidden = forbidden ? {
        status: "READY" as const,
        knownRequestId,
        change: { knowledge: "FORBIDDEN" as const, request: null, draftReference: null, immutableDiff: null, effectiveState: null, message: change?.message ?? null },
      } : null;
      const retained = !verifiedNext && !forbidden && Boolean(knownId);
      return { forbidden, verifiedNext, policyChange: sanitizedForbidden ?? (retained ? previousRead : nextWithId) };
    };
    try {
      const response = await adminRequest<PolicyResponse>("/membership-growth/policy", undefined, "GET");
      if (generation !== generationRef.current || knownPolicyRequestRef.current.identity !== policyIdentity) return;
      const nextRead = rememberPolicyChange(normalizePolicyChange(response.policyChange));
      setApprovedMeta(response.approvedMeta ?? null);
      setState((current) => {
        if (current.status !== "ready") return current;
        const classified = classify(current.policyChange, current.draftReference, nextRead);
        const clearPlaceholder = classified.verifiedNext && !approvalWrite.requestId && approvalWrite.pending.state === "absent" && current.approval.status === "UNKNOWN" && !current.approval.requestId;
        return {
          ...current,
          policyChange: classified.policyChange,
          approval: clearPlaceholder ? { status: "NOT_REQUESTED" } : current.approval,
          approvedPolicy: asApprovedPolicy(response) ?? current.approvedPolicy,
          approvedUnifiedPricing: response.approvedUnifiedPricing ?? current.approvedUnifiedPricing,
          capability: response.capability ?? current.capability,
        };
      });
      const responseChange = nextRead.status === "READY" ? nextRead.change : null;
      const responseForbidden = responseChange?.knowledge === "FORBIDDEN";
      const responseReference = responseChange?.draftReference ?? null;
      const responseComplete = Boolean(responseReference && responseReference.id && responseReference.version && responseReference.payloadHash);
      const responseExact = responseChange?.request?.operationCode === "membership.benefit.policy.publish";
      const responseVerified = responseChange?.knowledge === "KNOWN" && (responseChange.request === null || Boolean(responseComplete && responseExact));
      if (responseForbidden) setChangeRefreshError("暂时无法查看申请，请联系有权限的管理员。");
      else if (!responseVerified) setChangeRefreshError("申请状态暂未确认，请刷新后再操作。");
    } catch {
      if (generation === generationRef.current) setChangeRefreshError("刷新失败，请稍后重试。");
    } finally {
      changeRefreshRef.current = false;
      if (generation === generationRef.current) setChangeRefreshing(false);
    }
  };

  const ownPendingRecord = approvalWrite.pending.state === "valid" ? approvalWrite.pending.record : null;
  const foreignPendingRecord = approvalWrite.foreignPending?.state === "valid" ? approvalWrite.foreignPending.record : null;
  const unresolvedPending = approvalWrite.pending.state !== "absent" || Boolean(foreignPendingRecord) || approvalWrite.legacyPending;
  const readback = { requestId: approvalWrite.requestId, onRecover: ownPendingRecord ? () => void approvalWrite.recover() : undefined, recovering: approvalWrite.busy };
  const policyNotice: AdminPolicyNotice | undefined = saveError
    ? { tone: "error", title: "草稿保存失败", description: saveError, ...readback }
    : foreignPendingRecord
      ? { tone: "warning", blocking: true, title: "有一份礼遇申请待核对", description: "请先到礼遇管理查询原结果，再处理新的申请。" }
      : approvalWrite.legacyPending
        ? { tone: "warning", blocking: true, title: "上次申请记录待核对", description: "申请记录暂不完整，请到审批中心核对。", ...readback, onRecover: undefined }
        : ownPendingRecord
          ? { tone: approvalWrite.busy ? "info" : "warning", blocking: true, title: approvalWrite.busy ? "正在确认提交结果" : "上次提交结果待核对", description: approvalWrite.busy ? "请稍候，暂不要再次提交。" : "请查询原结果，核清前暂不能提交新的申请。", ...readback }
          : approvalWrite.error
            ? { tone: "warning", title: "申请操作未完成", description: "请核对原申请后再操作。", ...readback }
            : changeRefreshError
              ? { tone: "warning", blocking: true, title: "申请状态暂未更新", description: changeRefreshError, ...readback }
              : approvalWrite.requestId && !referencedDraftMatches && !closedDetailStatus && !serverClosedHook && !historyReadbackOnly
                ? { tone: "warning", blocking: true, title: "原申请需核对", description: "请先查看原申请，确认对应的政策草稿。", ...readback }
                : undefined;
  return <>
    <MembershipGrowthAdminView
      key={`${gameId ?? ""}:${subjectId ?? ""}`}
      state={ready}
      approvedMeta={approvedMeta}
      policySaved={savedDraft !== null}
      policySaving={saving}
      policyPublishable={savedDraftInfo?.publishable}
      policyWarnings={savedDraftInfo?.warnings ?? []}
      policyResetNonce={policyResetNonce}
      onDiscardPolicyChanges={discardPolicyChanges}
      binding={binding}
      canEditEntitlementRanges={ready.capability.canChangeEntitlementRanges ?? (snapshot.security.isBoss || hasPermission(snapshot, "membership.policy.draft"))}
      canSimulateProfit={(snapshot.security.status === "ACTIVE" && snapshot.security.isBoss) || (hasPermission(snapshot, "supply.quote.internal.read") && (hasPermission(snapshot, "membership.policy.draft") || hasPermission(snapshot, "membership.policy.publish")))}
      localPending={unresolvedPending}
      policyNotice={policyNotice}
      policyReadbackId={approvalWrite.requestId}
      policyChangeRefreshing={changeRefreshing}
      onRefreshPolicyChange={() => void refreshPolicyChange()}
      onOpenPath={onOpenPath}
      onOpenApproval={ready.approval.requestId && onOpenPath ? () => onOpenPath(`/approvals/${encodeURIComponent(ready.approval.requestId!)}?from=membership-growth&fromTab=policy`, "审批详情") : undefined}
      onPolicyChange={access.canDraft && unifiedSupported ? handlePolicyChange : undefined}
      onSavePolicyDraft={access.canDraft && unifiedSupported && !saving && !approvalWrite.busy ? () => void saveDraft() : undefined}
      onSubmitPolicy={access.canRequest && unifiedSupported && savedDraft !== null && submittedHash !== savedDraft.payloadHash && !saving && !approvalWrite.busy && approvalWrite.pending.state === "absent" ? () => void submitApproval() : undefined}
    />
  </>;
}
