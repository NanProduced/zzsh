import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { MembershipBenefitsWorkspace, useMembershipApprovalRequest } from "./membership-benefits-workspace";
import {
  bootstrapGrowthPolicy,
  MembershipGrowthAdminView,
  unifiedDraftFromProjection,
  unifiedPricingInputFromDraft,
  type AdminGrowthCatalog,
  type AdminGrowthPolicy,
  type AdminGrowthSubject,
  type AdminApproval,
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
};

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
  if (response && !response.policy && !response.bootstrap) return "当前没有可绑定的 SEALED 价格版本，首版草稿暂不能建立";
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
  const approvalWrite = useMembershipApprovalRequest(snapshot);
  const editRevisionRef = useRef(0);
  const generationRef = useRef(0);
  const savingRef = useRef(false);
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
    setSavedDraft(null);
    setSavedDraftInfo(null);
    setSubmittedHash(null);
    const settle = <T,>(request: Promise<T>) => request.then((value) => ({ value, error: null as unknown })).catch((error: unknown) => ({ value: null, error }));
    Promise.all([
      settle(adminRequest<PolicyResponse>("/membership-growth/policy", undefined, "GET", {}, controller.signal)),
      subjectId ? settle(adminRequest<SubjectResponse>(`/users/${encodeURIComponent(subjectId)}/membership-growth`, undefined, "GET", {}, controller.signal)) : Promise.resolve({ value: null, error: null as unknown }),
    ]).then(([policyResult, subjectResult]) => {
      if (controller.signal.aborted || generation !== generationRef.current) return;
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
        approval: { status: "NOT_REQUESTED" },
      });
    });
    return () => {
      controller.abort();
      generationRef.current += 1;
    };
  }, [refreshNonce, subjectId, snapshot]);

  if (state.status !== "ready") return <MembershipGrowthAdminView state={state} />;
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
          approval: current.approval.status === "REJECTED" ? { status: "NOT_REQUESTED", message: "新草稿已保存，可重新提交审批。" } : current.approval,
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
    setState((current) => current.status === "ready" ? { ...current, approval: { status: "REQUESTED", requestId, message: "已提交审批，等待审批中心处理；审批通过并执行后才会影响线上折扣。" } } : current);
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
    setState((current) => current.status === "ready" ? { ...current, policy: baseline.policy, unifiedPricing: baseline.unifiedPricing } : current);
    setPolicyResetNonce((value) => value + 1);
    onDirtyChange(false);
  };

  return <>
    {saveError || approvalWrite.error ? <Alert variant="destructive"><AlertDescription>{saveError ?? approvalWrite.error}</AlertDescription></Alert> : null}
    {approvalWrite.pending.state !== "absent" ? <Button variant="outline" disabled={approvalWrite.busy} onClick={() => void approvalWrite.recover()}>查询原审批申请结果</Button> : null}
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
      onOpenPath={onOpenPath}
      onOpenApproval={ready.approval.requestId && onOpenPath ? () => onOpenPath(`/approvals/${encodeURIComponent(ready.approval.requestId!)}`) : undefined}
      onPolicyChange={access.canDraft && unifiedSupported ? handlePolicyChange : undefined}
      onSavePolicyDraft={access.canDraft && unifiedSupported && !saving && !approvalWrite.busy ? () => void saveDraft() : undefined}
      onSubmitPolicy={access.canRequest && unifiedSupported && savedDraft !== null && submittedHash !== savedDraft.payloadHash && !saving && !approvalWrite.busy && approvalWrite.pending.state === "absent" ? () => void submitApproval() : undefined}
    />
  </>;
}
