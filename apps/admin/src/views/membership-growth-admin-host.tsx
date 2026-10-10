import { useEffect, useState } from "react";
import { AdminApiError, adminRequest, hasPermission, type SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import {
  MembershipGrowthAdminView,
  type AdminEntitlementDraft,
  type AdminGrowthPolicy,
  type AdminGrowthSubject,
  type AdminApproval,
  type MembershipGrowthAdminState,
} from "./membership-growth-view";

type PolicyResponse = {
  policy: Record<string, any> | null;
  meta: { id: string; version: string; status: "DRAFT" | "APPROVED"; effectiveAtUtc: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; payloadHash: string } | null;
  catalog: AdminGrowthPolicy["catalog"];
  thresholds: Record<string, string>;
};

export function policyDraftApprovalPayload(meta: NonNullable<PolicyResponse["meta"]>) {
  if (meta.status !== "DRAFT" || !/^[0-9a-f]{64}$/.test(meta.payloadHash)) throw new Error("请先保存当前政策草稿");
  return { policyDraftId: meta.id, policyDraftVersion: Number(meta.version), policyDraftHash: meta.payloadHash, ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef, effectiveAtUtc: meta.effectiveAtUtc };
}

type SubjectResponse = { subjectId: string; growth?: { knowledge: "KNOWN" | "UNKNOWN"; effectiveTier: string | null; rollingPoints: string | null; lifetimePoints: string | null; sourceState: string }; authorizationState?: string };

function asPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (!response.policy || !response.meta) return null;
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
  const material = policy.catalog.materials[0];
  return { kind: "FRIEND", scopeKey: "", startsAtUtc: new Date().toISOString(), endsAtUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(), pricingMode: "ordinary", priceVersionId: policy.catalog.priceVersions[0]?.id ?? "", haffSchema: "haff-ratio-v1", safeBoxCode: policy.selectedSafeBoxCode, haffBaseRatio: "", materialItemId: material?.id ?? "", materialUnit: material?.unit ?? "PIECE", materialUnitQuantity: "", materialBuyerUnitAmount: "", materialOwnerUnitAmount: "", costBasisRef: "", depositWaived: false, reason: "" };
}

function subjectOf(response: SubjectResponse | null, subjectId: string | undefined): AdminGrowthSubject {
  if (!subjectId) return { subjectId: "", status: "NOT_LOADED", reason: "从用户详情打开会员成长后再读取对象" };
  if (!response) return { subjectId, status: "UNKNOWN", reason: "用户成长来源暂未闭合" };
  if (response.growth?.knowledge !== "KNOWN") return { subjectId, status: "UNKNOWN", reason: `来源状态：${response.growth?.sourceState ?? "UNKNOWN"}` };
  return { subjectId, status: "LOADED", userLabel: subjectId, tier: response.growth.effectiveTier ?? "UNKNOWN", rollingPoints: response.growth.rollingPoints ?? undefined, lifetimePoints: response.growth.lifetimePoints ?? undefined };
}

export function MembershipGrowthAdminHost({ tab, snapshot, onDirtyChange, refreshNonce }: { tab: WorkspaceTab; snapshot: Extract<SessionSnapshot, { authenticated: true }>; onDirtyChange: (dirty: boolean) => void; refreshNonce: number }) {
  const subjectId = tab.query.userId;
  const gameId = tab.query.gameId;
  const [state, setState] = useState<MembershipGrowthAdminState>({ status: "loading" });
  const [meta, setMeta] = useState<PolicyResponse["meta"]>(null);
  const [savedDraft, setSavedDraft] = useState<PolicyResponse["meta"]>(null);
  const [subject, setSubject] = useState<AdminGrowthSubject>({ subjectId: subjectId ?? "", status: "NOT_LOADED" });

  useEffect(() => {
    if (!hasPermission(snapshot, "membership.policy.draft") && !hasPermission(snapshot, "membership.policy.publish") && !snapshot.security.isBoss) {
      setState({ status: "permission", message: "当前管理员没有会员成长配置权限" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    setSavedDraft(null);
    Promise.all([
      adminRequest<PolicyResponse>("/membership-growth/policy", undefined, "GET", {}, controller.signal),
      subjectId ? adminRequest<SubjectResponse>(`/users/${encodeURIComponent(subjectId)}/membership-growth`, undefined, "GET", {}, controller.signal) : Promise.resolve(null),
    ]).then(([policyResponse, subjectResponse]) => {
      if (controller.signal.aborted) return;
      const policy = asPolicy(policyResponse);
      const nextSubject = subjectOf(subjectResponse, subjectId);
      setMeta(policyResponse.meta);
      setSavedDraft(policyResponse.meta?.status === "DRAFT" ? policyResponse.meta : null);
      setSubject(nextSubject);
      if (!policy) {
        setState({ status: "error", message: "尚未读取到会员政策；功能保持未启用或等待首个草稿" });
        return;
      }
      setState({ status: "ready", policy, preview: { status: "NOT_RUN", reason: "真实报价预览需在正式quote与主体快照接线后执行" }, subject: nextSubject, entitlement: initialEntitlement(policy), approval: { status: "NOT_REQUESTED" } });
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      const failure = error instanceof AdminApiError && error.status === 403 ? "当前管理员没有会员成长读取权限" : error instanceof AdminApiError && error.status === 404 ? "会员成长功能尚未启用" : "会员成长配置暂时无法读取";
      setState({ status: "error", message: failure });
    });
    return () => controller.abort();
  }, [refreshNonce, snapshot, subjectId]);

  if (state.status !== "ready") return <MembershipGrowthAdminView state={state} />;
  const ready = state;
  const saveDraft = async () => {
    if (!meta) return;
    const draft = await adminRequest<{ id: string; version: string; payloadHash: string }>("/membership-growth/policy-drafts", { policy: toGrowthPolicy({ ...ready.policy, status: "DRAFT", version: String(Number(meta.version) + 1) }), versionNo: Number(meta.version) + 1, expectedVersion: meta.version, effectiveAtUtc: ready.policy.effectiveAt, ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: "admin:membership-growth" });
    const saved = { ...meta, id: draft.id, version: draft.version, payloadHash: draft.payloadHash, status: "DRAFT" as const, effectiveAtUtc: ready.policy.effectiveAt, sourceRef: "admin:membership-growth" };
    setMeta(saved); setSavedDraft(saved); setState(current => current.status === "ready" ? { ...current, policy: { ...current.policy, version: draft.version, status: "DRAFT", changes: [] } } : current);
    onDirtyChange(false);
  };
  const submitApproval = async () => {
    if (!meta) return;
    if (!savedDraft) { setState({ ...ready, approval: { status: "NOT_REQUESTED", message: "请先保存当前政策草稿，再提交审批" } }); return; }
    const response = await adminRequest<{ requestId: string }>("/security/approvals/requests", { operationCode: "membership.benefit.policy.publish", triggerCondition: "membership.policy.publish.requested", payloadVersion: 1, payload: policyDraftApprovalPayload(savedDraft!), summary: `发布会员政策 ${ready.policy.version}`, supersedesRequestId: null });
    setState({ ...ready, approval: { status: "REQUESTED", requestId: response.requestId, message: "已提交既有审批链" } });
  };
  const submitEntitlement = async () => {
    if (ready.subject.status !== "LOADED" || !gameId || !meta) return;
    const draft = ready.entitlement;
    const response = await adminRequest<{ requestId: string }>("/security/approvals/requests", { operationCode: "membership.entitlement.grant", triggerCondition: "membership.entitlement.grant.requested", payloadVersion: 1, payload: { userId: ready.subject.subjectId, gameId, kind: draft.kind, scopeKey: draft.scopeKey, startsAtUtc: draft.startsAtUtc, endsAtUtc: draft.endsAtUtc, policyId: meta.id, pricing: { mode: draft.pricingMode, priceVersionId: draft.priceVersionId, haff: { status: "CONFIGURED", kind: "HAFF_RATIO", schema: draft.haffSchema, priceVersionId: draft.priceVersionId, costBasisRef: draft.costBasisRef, baseBySafeBox: { [draft.safeBoxCode]: draft.haffBaseRatio } }, materials: { [draft.materialItemId]: { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: draft.materialItemId, unit: draft.materialUnit, unitQuantity: draft.materialUnitQuantity, buyerUnitAmount: draft.materialBuyerUnitAmount, ownerUnitAmount: draft.materialOwnerUnitAmount, priceVersionId: draft.priceVersionId, costBasisRef: draft.costBasisRef } } }, depositWaived: draft.depositWaived, reason: draft.reason }, summary: `申请${draft.kind === "FRIEND" ? "挚友" : "尊享"}礼遇`, supersedesRequestId: null });
    setState({ ...ready, approval: { status: "REQUESTED", requestId: response.requestId, message: "已提交既有审批链" } });
  };
  return <MembershipGrowthAdminView state={ready} onPolicyChange={(policy) => { setSavedDraft(null); setState((current) => current.status === "ready" ? { ...current, policy } : current); onDirtyChange(true); }} onSavePolicyDraft={() => void saveDraft()} onSubmitPolicy={() => void submitApproval()} onEntitlementChange={(entitlement) => setState((current) => current.status === "ready" ? { ...current, entitlement } : current)} onSubmitEntitlement={() => void submitEntitlement()} />;
}
