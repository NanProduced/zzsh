import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import {
  bootstrapGrowthPolicy,
  entitlementFromCap,
  MembershipGrowthAdminView,
  type AdminEntitlementDraft,
  type AdminGrowthCatalog,
  type AdminGrowthPolicy,
  type AdminGrowthSubject,
  type AdminApproval,
  type AdminPricingMode,
  type MembershipGrowthAdminState,
} from "./membership-growth-view";

export type PolicyBootstrap = {
  ruleReleaseId: string;
  priceVersionId: string;
  haffSchema: "haff-ratio-v1" | "haff-ratio-v2" | null;
  releaseMode: "SPREAD" | "PERCENT";
  enabledModes: AdminPricingMode[];
  nextVersionNo: number;
  expectedVersion: string;
};

type PolicyResponse = {
  policy: Record<string, any> | null;
  meta: { id: string; version: string; status: "DRAFT" | "APPROVED"; effectiveAtUtc: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; payloadHash: string } | null;
  catalog: AdminGrowthCatalog;
  thresholds: Record<string, string>;
  bootstrap?: PolicyBootstrap | null;
};

export function policyDraftApprovalPayload(meta: NonNullable<PolicyResponse["meta"]>) {
  if (meta.status !== "DRAFT" || !/^[0-9a-f]{64}$/.test(meta.payloadHash)) throw new Error("请先保存当前政策草稿");
  return { policyDraftId: meta.id, policyDraftVersion: Number(meta.version), policyDraftHash: meta.payloadHash, ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef, effectiveAtUtc: meta.effectiveAtUtc };
}

type SubjectResponse = { subjectId: string; growth?: { knowledge: "KNOWN" | "UNKNOWN"; effectiveTier: string | null; rollingPoints: string | null; lifetimePoints: string | null; sourceState: string }; authorizationState?: string };

function asPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (response.policy && response.meta) {
    const raw = response.policy;
    const tiers = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"] as const;
    const tierConfig = raw.tiers as Record<string, any>;
    return {
      version: response.meta.version,
      status: raw.status === "APPROVED" ? "APPROVED" : "DRAFT",
      effectiveAt: response.meta.effectiveAtUtc,
      catalog: response.catalog,
      selectedSafeBoxCode: response.catalog.safeBoxes[0] ?? "",
      selectedMaterialId: response.catalog.materials[0]?.id ?? "",
      tiers: tiers.map((tier) => {
        const config = tierConfig[tier] ?? {};
        return { tier, threshold: response.thresholds[tier] ?? "0", tenantDeposit: config.tenantDeposit === "WAIVED" ? "WAIVED" : "ACCOUNT_BASE", ordinary: config.pricing?.ordinary ?? { status: "NOT_PRICED", reason: "未载入普通方案" }, custom: config.pricing?.custom ?? { status: "NOT_PRICED", reason: "未载入自定义方案" }, fast: config.pricing?.fast ?? { status: "NOT_PRICED", reason: "未载入极速方案" }, maxEntitlement: config.entitlementCap ?? { status: "NOT_PRICED", reason: "未载入礼遇上限" } };
      }),
      changes: [],
    };
  }
  // Empty policy table: the first draft binds the real sealed release/catalog; unknown prices stay 待核.
  if (!response.policy && response.bootstrap) return bootstrapGrowthPolicy(response.catalog, response.thresholds, response.bootstrap.nextVersionNo);
  return null;
}

function toGrowthPolicy(policy: AdminGrowthPolicy): Record<string, unknown> {
  return {
    schema: "membership-growth-v1",
    version: policy.version,
    status: policy.status,
    effectiveAt: policy.effectiveAt,
    sourceRef: "admin:membership-growth",
    tiers: Object.fromEntries(policy.tiers.map((tier) => [tier.tier, { tier: tier.tier, tenantDeposit: tier.tenantDeposit, pricing: { ordinary: tier.ordinary, custom: tier.custom, fast: tier.fast }, entitlementCap: tier.maxEntitlement }])),
    entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" },
  };
}

function initialEntitlement(policy: AdminGrowthPolicy): AdminEntitlementDraft {
  const mode = policy.catalog.enabledModes?.[0] ?? "ordinary";
  return entitlementFromCap(policy, "FRIEND", mode, new Date().toISOString(), new Date(Date.now() + 7 * 86_400_000).toISOString());
}

function subjectOf(response: SubjectResponse | null, subjectId: string | undefined, error: unknown = null): AdminGrowthSubject {
  if (!subjectId) return { subjectId: "", status: "NOT_LOADED", reason: "从用户详情打开会员成长后再读取对象" };
  if (!response) return { subjectId, status: error instanceof AdminApiError && error.status === 403 ? "FORBIDDEN" : "UNKNOWN", reason: error instanceof AdminApiError ? `读取失败：${error.status}` : "用户成长来源暂未闭合" };
  if (response.growth?.knowledge !== "KNOWN") return { subjectId, status: "UNKNOWN", reason: `来源状态：${response.growth?.sourceState ?? "UNKNOWN"}` };
  return { subjectId, status: "LOADED", userLabel: subjectId, tier: response.growth.effectiveTier ?? "UNKNOWN", rollingPoints: response.growth.rollingPoints ?? undefined, lifetimePoints: response.growth.lifetimePoints ?? undefined };
}

/** A missing/failed policy read is reported on its own; it never erases an authorized subject read. */
function policyFailure(error: unknown, response: PolicyResponse | null): string {
  if (error instanceof AdminApiError && error.status === 403) return "当前管理员没有会员成长读取权限";
  if (error instanceof AdminApiError && error.status === 404) return "会员成长功能尚未启用";
  if (response && !response.policy && !response.bootstrap) return "当前没有可绑定的 SEALED 价格版本，首版草稿暂不能建立";
  if (error instanceof AdminApiError) return "会员成长政策暂时无法读取";
  return "尚未读取到会员政策；功能保持未启用或等待首个草稿";
}

/** GAP-007: nav entry and API GET /membership-growth/policy both admit summary readers; the host gate must match and only hide write actions. */
export function membershipGrowthAccess(snapshot: Extract<SessionSnapshot, { authenticated: true }>) {
  const boss = snapshot.security.isBoss;
  const canDraft = boss || hasPermission(snapshot, "membership.policy.draft");
  const canRequest = canDraft || hasPermission(snapshot, "membership.policy.publish");
  const canRead = canRequest || hasPermission(snapshot, "membership.growth.read.summary");
  return { canRead, canDraft, canRequest };
}

export function MembershipGrowthAdminHost({ tab, snapshot, onDirtyChange, refreshNonce }: { tab: WorkspaceTab; snapshot: Extract<SessionSnapshot, { authenticated: true }>; onDirtyChange: (dirty: boolean) => void; refreshNonce: number }) {
  const subjectId = tab.query.userId;
  const gameId = tab.query.gameId;
  const [state, setState] = useState<MembershipGrowthAdminState>({ status: "loading" });
  const [meta, setMeta] = useState<PolicyResponse["meta"]>(null);
  const [bootstrap, setBootstrap] = useState<PolicyBootstrap | null>(null);
  const [savedDraft, setSavedDraft] = useState<PolicyResponse["meta"]>(null);
  const [subject, setSubject] = useState<AdminGrowthSubject>({ subjectId: subjectId ?? "", status: "NOT_LOADED" });
  /** R1-02: a save receipt only marks the exact edit revision it was built from as saved. */
  const editRevisionRef = useRef(0);
  /** R1-02: late responses from a previous subject/refresh generation never write into the new context. */
  const generationRef = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!membershipGrowthAccess(snapshot).canRead) {
      setState({ status: "permission", message: "当前管理员没有会员成长配置权限" });
      return;
    }
    const controller = new AbortController();
    generationRef.current += 1;
    const generation = generationRef.current;
    setState({ status: "loading" });
    setSavedDraft(null);
    const settle = <T,>(request: Promise<T>) => request.then((value) => ({ value, error: null as unknown })).catch((error: unknown) => ({ value: null, error }));
    Promise.all([
      settle(adminRequest<PolicyResponse>("/membership-growth/policy", undefined, "GET", {}, controller.signal)),
      subjectId ? settle(adminRequest<SubjectResponse>(`/users/${encodeURIComponent(subjectId)}/membership-growth`, undefined, "GET", {}, controller.signal)) : Promise.resolve({ value: null, error: null as unknown }),
    ]).then(([policyResult, subjectResult]) => {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      const policy = policyResult.value ? asPolicy(policyResult.value) : null;
      const nextSubject = subjectOf(subjectResult.value, subjectId, subjectResult.error);
      setMeta(policyResult.value?.meta ?? null);
      setBootstrap(policyResult.value?.bootstrap ?? null);
      setSavedDraft(policyResult.value?.meta?.status === "DRAFT" ? policyResult.value.meta : null);
      setSubject(nextSubject);
      if (!policy) {
        setState({ status: "error", message: policyFailure(policyResult.error, policyResult.value), subject: nextSubject });
        return;
      }
      setState({ status: "ready", policy, preview: { status: "NOT_RUN", reason: "真实报价预览需在正式quote与主体快照接线后执行" }, subject: nextSubject, entitlement: initialEntitlement(policy), approval: { status: "NOT_REQUESTED" } });
    });
    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [refreshNonce, snapshot, subjectId]);

  if (state.status !== "ready") return <MembershipGrowthAdminView state={state} />;
  const access = membershipGrowthAccess(snapshot);
  const ready = state;
  const binding = meta
    ? { ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef }
    : bootstrap
      ? { ruleReleaseId: bootstrap.ruleReleaseId, priceVersionId: bootstrap.priceVersionId, sourceRef: "admin:membership-growth" }
      : null;
  const saveDraft = async () => {
    if (!binding || savingRef.current) return;
    savingRef.current = true;
    const revision = editRevisionRef.current;
    const generation = generationRef.current;
    try {
      const versionNo = meta ? Number(meta.version) + 1 : bootstrap!.nextVersionNo;
      const expectedVersion = meta ? meta.version : bootstrap!.expectedVersion;
      const draft = await adminRequest<{ id: string; version: string; payloadHash: string }>("/membership-growth/policy-drafts", { policy: toGrowthPolicy({ ...ready.policy, status: "DRAFT", version: String(versionNo) }), versionNo, expectedVersion, effectiveAtUtc: ready.policy.effectiveAt, ruleReleaseId: binding.ruleReleaseId, priceVersionId: binding.priceVersionId, sourceRef: binding.sourceRef });
      const saved: NonNullable<PolicyResponse["meta"]> = { id: draft.id, version: draft.version, status: "DRAFT", effectiveAtUtc: ready.policy.effectiveAt, ruleReleaseId: binding.ruleReleaseId, priceVersionId: binding.priceVersionId, sourceRef: binding.sourceRef, payloadHash: draft.payloadHash };
      if (generation !== generationRef.current) return; // a receipt from another subject/refresh never writes into this context
      // The version advances for the next save, but only the exact revision that was sent becomes "saved".
      setMeta(saved);
      if (revision === editRevisionRef.current) {
        setSavedDraft(saved);
        setState(current => current.status === "ready" ? { ...current, policy: { ...current.policy, version: draft.version, status: "DRAFT", changes: [] } } : current);
        onDirtyChange(false);
      }
    } finally {
      savingRef.current = false;
    }
  };
  const submitApproval = async () => {
    if (!meta) return;
    const generation = generationRef.current;
    if (!savedDraft) { setState((current) => current.status === "ready" ? { ...current, approval: { status: "NOT_REQUESTED", message: "请先保存当前政策草稿，再提交审批" } } : current); return; }
    const response = await adminRequest<{ requestId: string }>("/security/approvals/requests", { operationCode: "membership.benefit.policy.publish", triggerCondition: "membership.policy.publish.requested", payloadVersion: 1, payload: policyDraftApprovalPayload(savedDraft!), summary: `发布会员政策 ${ready.policy.version}` });
    if (generationRef.current !== generation) return;
    // Only the approval state of this generation is touched; edits made meanwhile stay untouched.
    setState((current) => current.status === "ready" ? { ...current, approval: { status: "REQUESTED", requestId: response.requestId, message: "已提交既有审批链" } } : current);
  };
  const submitEntitlement = async () => {
    if (ready.subject.status !== "LOADED" || !gameId || !meta) return;
    const generation = generationRef.current;
    const draft = ready.entitlement;
    const response = await adminRequest<{ requestId: string }>("/security/approvals/requests", { operationCode: "membership.entitlement.grant", triggerCondition: "membership.entitlement.grant.requested", payloadVersion: 1, payload: {
      userId: ready.subject.subjectId, gameId, kind: draft.kind, scopeKey: draft.scopeKey, startsAtUtc: draft.startsAtUtc, endsAtUtc: draft.endsAtUtc, policyId: meta.id,
      // Manual grant sets its own payable share and expiry; no second haff/material price table is sent.
      pricing: { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode: draft.pricingMode, priceVersionId: draft.priceVersionId, payableRatio: draft.payableRatio, costBasisRef: draft.costBasisRef },
      depositWaived: draft.depositWaived, reason: draft.reason }, summary: `申请${draft.kind === "FRIEND" ? "挚友" : "尊享"}礼遇` });
    if (generationRef.current !== generation) return;
    setState((current) => current.status === "ready" ? { ...current, approval: { status: "REQUESTED", requestId: response.requestId, message: "已提交既有审批链" } } : current);
  };
  const handlePolicyChange = (policy: AdminGrowthPolicy) => {
    editRevisionRef.current += 1;
    setSavedDraft(null);
    setState((current) => current.status === "ready" ? { ...current, policy } : current);
    onDirtyChange(true);
  };
  return <MembershipGrowthAdminView state={ready} policySaved={meta !== null} onPolicyChange={access.canDraft ? handlePolicyChange : undefined} onSavePolicyDraft={access.canDraft ? () => void saveDraft() : undefined} onSubmitPolicy={access.canRequest ? () => void submitApproval() : undefined} onEntitlementChange={access.canRequest ? (entitlement) => setState((current) => current.status === "ready" ? { ...current, entitlement } : current) : undefined} onSubmitEntitlement={access.canRequest ? () => void submitEntitlement() : undefined} />;
}
