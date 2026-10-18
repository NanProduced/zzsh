import { Checkbox } from "@base-ui/react/checkbox";
import { useEffect, useState } from "react";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import "./membership-growth-view.css";

export type AdminGrowthTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";
export type AdminNotPriced = { status: "NOT_PRICED"; reason: string };
export function isAdminNotPriced(value: AdminPricingContract | AdminNotPriced | undefined): value is AdminNotPriced { return Boolean(value && "status" in value && value.status === "NOT_PRICED"); }
export type AdminHaffPrice = AdminNotPriced | { status: "CONFIGURED"; kind: "HAFF_RATIO"; schema: "haff-ratio-v1" | "haff-ratio-v2"; priceVersionId: string; costBasisRef: string; baseBySafeBox: Record<string, string>; spreadDelta?: string };
export type AdminMaterialPrice = AdminNotPriced | { status: "CONFIGURED"; kind: "FIXED_UNIT"; itemId: string; unit: "ROUND" | "PIECE" | "DAY"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string; priceVersionId: string; costBasisRef: string };
export type AdminPricingMode = "ordinary" | "custom" | "fast";
export type AdminPricingContract = AdminNotPriced | { mode: AdminPricingMode; priceVersionId: string; haff: AdminHaffPrice; materials: Record<string, AdminMaterialPrice> };
export type AdminEntitlementCapByMode = { byMode: Partial<Record<AdminPricingMode, AdminPricingContract | AdminNotPriced>> };
export type AdminEntitlementCap = AdminPricingContract | AdminNotPriced | AdminEntitlementCapByMode;
export type AdminGrowthCatalog = { safeBoxes: string[]; materials: Array<{ id: string; name: string; unit: "ROUND" | "PIECE" | "DAY"; unitQuantity?: string }>; priceVersions: Array<{ id: string; label: string }>; enabledModes?: AdminPricingMode[]; haffSchema?: "haff-ratio-v1" | "haff-ratio-v2"; releaseMode?: "SPREAD" | "PERCENT" };
export type AdminGrowthPolicy = {
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: string | null;
  catalog: AdminGrowthCatalog;
  selectedSafeBoxCode: string;
  selectedMaterialId: string;
  tiers: Array<{ tier: AdminGrowthTier; threshold: string; tenantDeposit: "ACCOUNT_BASE" | "WAIVED"; ordinary: AdminPricingContract; custom: AdminPricingContract; fast: AdminPricingContract; maxEntitlement: AdminEntitlementCap }>;
  changes: Array<{ label: string; before: string; after: string; risk: "LOW" | "REVIEW_REQUIRED" }>;
};

export type AdminGrowthPreview = { status: "NOT_RUN" | "LOCAL_FIXTURE" | "KNOWN" | "UNKNOWN"; totalCents?: string; priceBasis?: string; depositBasis?: string; reason?: string };
export type AdminGrowthSubject = { subjectId: string; status: "NOT_LOADED" | "LOADED" | "UNKNOWN" | "FORBIDDEN"; userLabel?: string; tier?: string; rollingPoints?: string; lifetimePoints?: string; evidence?: string[]; reason?: string };
export type AdminEntitlementMaterial = { unit: "ROUND" | "PIECE" | "DAY"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string };
export type AdminEntitlementDraft = { kind: "FRIEND" | "PRESTIGE"; scopeKey: string; startsAtUtc: string; endsAtUtc: string; pricingMode: AdminPricingMode; priceVersionId: string; spreadDelta: string; haffBaseBySafeBox: Record<string, string>; materials: Record<string, AdminEntitlementMaterial>; costBasisRef: string; depositWaived: boolean; reason: string };
export type AdminApproval = { status: "NOT_REQUESTED" | "REQUESTED" | "APPROVED_PENDING_EXECUTION" | "APPLIED" | "REJECTED" | "UNKNOWN"; requestId?: string; message?: string };

export type MembershipGrowthAdminState =
  | { status: "loading" }
  // A missing/failed policy must not discard the granted subject read; the subject stays visible.
  | { status: "error"; message: string; subject?: AdminGrowthSubject }
  | { status: "permission"; message: string }
  | { status: "ready"; policy: AdminGrowthPolicy; preview: AdminGrowthPreview; subject: AdminGrowthSubject; entitlement: AdminEntitlementDraft; approval: AdminApproval };

const TIER_LABELS: Record<AdminGrowthTier, string> = { STANDARD: "普通", SILVER: "银卡", GOLD: "金卡", PLATINUM: "铂金", DIAMOND: "钻石" };
const GROWTH_TIER_LABELS: Record<string, string> = { ...TIER_LABELS, BLACK_GOLD: "黑金", UNKNOWN: "资格待确认" };
const BASIS_LABELS: Record<string, string> = { GROWTH: "成长权益", ENTITLEMENT: "人工礼遇", ACCOUNT_BASE: "账号条件", WAIVED: "独立免押" };
const MODES = ["ordinary", "custom", "fast"] as const satisfies readonly AdminPricingMode[];
const UNIT_LABELS: Record<Exclude<AdminMaterialPrice, AdminNotPriced>["unit"], string> = { ROUND: "局", PIECE: "件", DAY: "天" };

function isNotPriced(value: AdminPricingContract | AdminNotPriced): value is AdminNotPriced { return "status" in value && value.status === "NOT_PRICED"; }
type ConfiguredAdminPricingContract = { mode: AdminPricingMode; priceVersionId: string; haff: Exclude<AdminHaffPrice, AdminNotPriced>; materials: Record<string, Exclude<AdminMaterialPrice, AdminNotPriced>> };
export function isAdminCapByMode(cap: AdminEntitlementCap): cap is AdminEntitlementCapByMode { return Boolean(cap && "byMode" in cap); }
export function adminCapForMode(cap: AdminEntitlementCap, mode: AdminPricingMode): AdminPricingContract | AdminNotPriced | undefined {
  return isAdminCapByMode(cap) ? cap.byMode[mode] : cap;
}

function configuredContract(mode: AdminPricingMode, priceVersionId = "", haffSchema: "haff-ratio-v1" | "haff-ratio-v2" = "haff-ratio-v1"): ConfiguredAdminPricingContract {
  return { mode, priceVersionId, haff: { status: "CONFIGURED", kind: "HAFF_RATIO", schema: haffSchema, priceVersionId, costBasisRef: "", baseBySafeBox: {}, spreadDelta: "" }, materials: {} };
}

function contractOf(value: AdminPricingContract, mode: AdminPricingMode, priceVersionId = "", haffSchema?: "haff-ratio-v1" | "haff-ratio-v2"): Exclude<AdminPricingContract, AdminNotPriced> {
  return isNotPriced(value) ? configuredContract(mode, priceVersionId, haffSchema ?? "haff-ratio-v1") : value;
}

function materialOf(contract: Exclude<AdminPricingContract, AdminNotPriced>, materialId: string, unit: "ROUND" | "PIECE" | "DAY" = "PIECE", unitQuantity = ""): Exclude<AdminMaterialPrice, AdminNotPriced> {
  const material = contract.materials[materialId];
  return material?.status === "CONFIGURED" ? material : { status: "CONFIGURED", kind: "FIXED_UNIT", itemId: materialId, unit, unitQuantity, buyerUnitAmount: "", ownerUnitAmount: "", priceVersionId: contract.priceVersionId, costBasisRef: "" };
}

/** First draft for an empty policy table: real sealed-release catalog keys, every unknown price stays 待核. */
export function bootstrapGrowthPolicy(catalog: AdminGrowthCatalog, thresholds: Record<string, string>, versionNo: number): AdminGrowthPolicy {
  const pending = (reason: string): AdminNotPriced => ({ status: "NOT_PRICED", reason });
  return {
    version: String(versionNo),
    status: "DRAFT",
    effectiveAt: null,
    catalog,
    selectedSafeBoxCode: catalog.safeBoxes[0] ?? "",
    selectedMaterialId: catalog.materials[0]?.id ?? "",
    tiers: ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"].map((tier) => ({
      tier: tier as AdminGrowthTier,
      threshold: thresholds[tier] ?? "0",
      tenantDeposit: tier === "STANDARD" || tier === "SILVER" ? "ACCOUNT_BASE" as const : "WAIVED" as const,
      ordinary: pending("普通方案待核：需批准的经营价差与成本依据"),
      custom: pending("自定义方案待核：需批准的经营价差与成本依据"),
      fast: pending("极速方案待核：需批准的经营价差与成本依据"),
      maxEntitlement: pending("礼遇价格上限待核：需批准的让利边界"),
    })),
    changes: [],
  };
}

/** Seeds a 礼遇 draft from the approved cap of the matching tier so edits start at the allowed boundary. */
export function entitlementFromCap(policy: AdminGrowthPolicy, kind: AdminEntitlementDraft["kind"], mode: AdminPricingMode, startsAtUtc: string, endsAtUtc: string): AdminEntitlementDraft {
  const capTier = policy.tiers.find((tier) => tier.tier === (kind === "FRIEND" ? "GOLD" : "DIAMOND"));
  const capEntry = capTier ? adminCapForMode(capTier.maxEntitlement, mode) : undefined;
  const configured = capEntry && !isNotPriced(capEntry) ? capEntry : null;
  const haff = configured && configured.haff.status === "CONFIGURED" ? configured.haff : null;
  return {
    kind, scopeKey: "", startsAtUtc, endsAtUtc, pricingMode: mode,
    priceVersionId: policy.catalog.priceVersions[0]?.id ?? "",
    spreadDelta: haff?.spreadDelta ?? "",
    haffBaseBySafeBox: Object.fromEntries(policy.catalog.safeBoxes.map((code) => [code, haff?.baseBySafeBox[code] ?? ""])),
    materials: Object.fromEntries(policy.catalog.materials.map((material) => {
      const configuredMaterial = configured?.materials[material.id];
      const amounts = configuredMaterial && configuredMaterial.status === "CONFIGURED" ? configuredMaterial : null;
      return [material.id, { unit: material.unit, unitQuantity: amounts?.unitQuantity ?? material.unitQuantity ?? "", buyerUnitAmount: amounts?.buyerUnitAmount ?? "", ownerUnitAmount: amounts?.ownerUnitAmount ?? "" }];
    })),
    costBasisRef: haff?.costBasisRef ?? "",
    depositWaived: false,
    reason: "",
  };
}

export function validateAdminPolicyDraft(policy: AdminGrowthPolicy, enabledModes: readonly AdminPricingMode[] = MODES): { errors: string[]; warnings: string[]; publishable: boolean } {
  const errors: string[] = [], warnings: string[] = [];
  const enabled = new Set<AdminPricingMode>(enabledModes);
  const pending = (value: string | undefined) => !value || !value.trim();
  for (const tier of policy.tiers) for (const mode of MODES) {
    const contract = tier[mode];
    const path = `${tier.tier}.${mode}`;
    if (!enabled.has(mode)) continue; // the sealed release disabled this mode: draft content is inert
    if (isNotPriced(contract)) { warnings.push(`${path}:价格为待核`); continue; }
    const missing: string[] = [];
    if (pending(contract.priceVersionId)) errors.push(`${path}:缺少价格版本`);
    const haff = contract.haff.status === "CONFIGURED" ? contract.haff : null;
    if (!haff) errors.push(`${path}:哈夫合同未完成`);
    else {
      if (pending(haff.baseBySafeBox[policy.selectedSafeBoxCode])) missing.push("哈夫比例");
      if (haff.schema === "haff-ratio-v2" && pending(haff.spreadDelta)) missing.push("价差");
      if (pending(haff.costBasisRef)) missing.push("成本依据");
    }
    const material = materialOf(contract, policy.selectedMaterialId, policy.catalog.materials.find((item) => item.id === policy.selectedMaterialId)?.unit ?? "PIECE");
    if (pending(material.unitQuantity)) missing.push("单位数量");
    if (pending(material.buyerUnitAmount)) missing.push("买方单价");
    if (pending(material.ownerUnitAmount)) missing.push("号主单价");
    if (missing.length > 0) warnings.push(`${path}:待补 ${missing.join("/")}`);
    const coveredBoxes = haff ? policy.catalog.safeBoxes.filter((code) => haff.baseBySafeBox[code] !== undefined).length : 0;
    const coveredMaterials = policy.catalog.materials.filter((item) => contract.materials[item.id] && contract.materials[item.id]!.status === "CONFIGURED").length;
    if (haff && (coveredBoxes < policy.catalog.safeBoxes.length || coveredMaterials < policy.catalog.materials.length)) warnings.push(`${path}:目录未覆盖（安全箱 ${coveredBoxes}/${policy.catalog.safeBoxes.length}，物资 ${coveredMaterials}/${policy.catalog.materials.length}）`);
  }
  return { errors, warnings, publishable: errors.length === 0 && warnings.length === 0 };
}

export function capStatusSummary(cap: AdminEntitlementCap, enabledModes: readonly AdminPricingMode[]): string {
  const modes = enabledModes.length > 0 ? enabledModes : MODES;
  const configured = modes.filter((mode) => { const entry = adminCapForMode(cap, mode); return Boolean(entry && !isNotPriced(entry)); });
  return configured.length === 0 ? "礼遇上限未配置" : `礼遇上限 ${configured.map((mode) => ({ ordinary: "普通", custom: "自定义", fast: "极速" }[mode])).join("/")} 已配置${configured.length < modes.length ? "（部分模式）" : ""}`;
}

function GrowthSelect({ label, value, onChange, options, className = "" }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; className?: string }) {
  return <label className={`membership-admin-control ${className}`}><span>{label}</span><Select value={value || null} onValueChange={(next) => onChange(next ?? "")}><SelectTrigger aria-label={label} className="membership-admin-select-trigger"><SelectValue placeholder="请选择">{options.find((option) => option.value === value)?.label}</SelectValue></SelectTrigger><SelectContent align="start">{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}

export function formatCents(cents: string | undefined): string { if (!cents || !/^(0|[1-9]\d*)$/.test(cents)) return "待确认"; const value = cents.padStart(3, "0"); return `¥${value.slice(0, -2)}.${value.slice(-2)}`; }
export function utcToBeijingInput(value: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date); const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ""; return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`; }
export function beijingInputToUtc(value: string): string { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return ""; const date = new Date(`${value}:00+08:00`); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
export function entitlementWindowError(startsAtUtc: string, endsAtUtc: string): string { if (!startsAtUtc || !endsAtUtc) return "请填写北京时间起止"; const duration = Date.parse(endsAtUtc) - Date.parse(startsAtUtc); return !Number.isFinite(duration) ? "请填写北京时间起止" : duration <= 0 || duration > 90 * 24 * 60 * 60 * 1000 ? "礼遇单次最多90天" : ""; }

function approvalLabel(status: AdminApproval["status"]): string {
  return { NOT_REQUESTED: "未提交", REQUESTED: "审批中", APPROVED_PENDING_EXECUTION: "已批准，待执行", APPLIED: "已执行并生效", REJECTED: "已拒绝", UNKNOWN: "状态待确认" }[status];
}

function SubjectFacts({ subject }: { subject: AdminGrowthSubject }) {
  return <>
    {subject.status === "LOADED" ? <dl className="membership-admin-facts"><div><dt>对象</dt><dd>{subject.userLabel}</dd></div><div><dt>当前档位</dt><dd>{GROWTH_TIER_LABELS[subject.tier ?? ""] ?? subject.tier ?? "资格待确认"}</dd></div><div><dt>近90天积分</dt><dd>{subject.rollingPoints} 分</dd></div><div><dt>累计积分</dt><dd>{subject.lifetimePoints} 分</dd></div></dl> : <div className="membership-admin-empty"><strong>{subject.status === "FORBIDDEN" ? "当前身份无权查看" : subject.status === "UNKNOWN" ? "成长依据未知" : "尚未加载用户"}</strong><span>{subject.reason ?? "未知不显示为普通会员或0分。"}</span></div>}
    {subject.evidence?.length ? <ul className="membership-admin-evidence">{subject.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : null}
  </>;
}

function stateMessage(state: Exclude<MembershipGrowthAdminState, { status: "ready" }>) {
  const title = state.status === "loading" ? "正在读取会员成长配置" : state.status === "permission" ? "没有会员成长管理权限" : "会员成长模块暂不可用";
  return <section className="membership-admin-view" data-state={state.status} role={state.status === "error" ? "alert" : "status"}>
    <div className="membership-admin-state"><strong>{title}</strong><p>{state.status === "loading" ? "不会把未知数据显示为0或成功。" : state.message}</p></div>
    {state.status === "error" && state.subject ? <section className="membership-admin-section" aria-labelledby="membership-admin-subject-heading"><div className="membership-admin-section-heading"><div><h3 id="membership-admin-subject-heading">用户成长依据</h3><p>政策缺失只影响配置区；已获准的对象读取继续显示，不用它推断档位或积分。</p></div></div><SubjectFacts subject={state.subject} /></section> : null}
  </section>;
}

export function MembershipGrowthAdminView({ state, policySaved = true, onPolicyChange, onSavePolicyDraft, onSubmitPolicy, onEntitlementChange, onSubmitEntitlement, onRevokeEntitlement }: {
  state: MembershipGrowthAdminState;
  /** false for an unsaved first draft: saving it records the DRAFT without requiring an edit first. */
  policySaved?: boolean;
  onPolicyChange?: (policy: AdminGrowthPolicy) => void;
  onSavePolicyDraft?: () => void;
  onSubmitPolicy?: () => void;
  onEntitlementChange?: (draft: AdminEntitlementDraft) => void;
  onSubmitEntitlement?: () => void;
  onRevokeEntitlement?: (reason: string) => void;
}) {
  const [draftPolicy, setDraftPolicy] = useState<AdminGrowthPolicy | null>(state.status === "ready" ? state.policy : null);
  const [draftEntitlement, setDraftEntitlement] = useState<AdminEntitlementDraft | null>(state.status === "ready" ? state.entitlement : null);
  const [draftSubjectId, setDraftSubjectId] = useState<string | null>(state.status === "ready" ? state.subject.subjectId : null);
  const [mode, setMode] = useState<AdminPricingMode>("ordinary");
  const [policyDirty, setPolicyDirty] = useState(false);
  const [entitlementDirty, setEntitlementDirty] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  useEffect(() => { if (state.status === "ready") { setDraftPolicy(state.policy); setDraftEntitlement(state.entitlement); setDraftSubjectId(state.subject.subjectId); setPolicyDirty(false); setEntitlementDirty(false); setRevokeReason(""); } }, [state.status === "ready" ? state.policy.version : null, state.status === "ready" ? state.subject.subjectId : null]);
  if (state.status !== "ready") return stateMessage(state);
  if (!draftPolicy || !draftEntitlement) return stateMessage({ status: "loading" });
  const { preview, subject, approval } = state;
  const policy = draftPolicy;
  const entitlement = !entitlementDirty || draftSubjectId !== state.subject.subjectId ? state.entitlement : draftEntitlement;
  const enabledModes: AdminPricingMode[] = policy.catalog.enabledModes && policy.catalog.enabledModes.length > 0 ? [...policy.catalog.enabledModes] : [...MODES];
  const boundPriceVersion = policy.catalog.priceVersions[0]?.id ?? "";
  const boundHaffSchema = policy.catalog.haffSchema ?? "haff-ratio-v1";
  const validation = validateAdminPolicyDraft(policy, enabledModes);
  const updatePolicy = (next: AdminGrowthPolicy) => { setDraftPolicy(next); setPolicyDirty(true); onPolicyChange?.(next); };
  const updateTier = (tierName: AdminGrowthTier, update: (tier: AdminGrowthPolicy["tiers"][number]) => AdminGrowthPolicy["tiers"][number]) => updatePolicy({ ...policy, tiers: policy.tiers.map((tier) => tier.tier === tierName ? update(tier) : tier) });
  const updateEntitlement = (next: AdminEntitlementDraft) => { setDraftEntitlement(next); setEntitlementDirty(true); onEntitlementChange?.(next); };
  const setEntitlementField = (field: keyof AdminEntitlementDraft, value: string | boolean) => updateEntitlement({ ...entitlement, [field]: value });
  const setEntitlementFields = (patch: Partial<AdminEntitlementDraft>) => updateEntitlement({ ...entitlement, ...patch });
  // Changing kind or mode re-seeds the whole pricing contract from that cap; identity fields stay as typed.
  const reseedEntitlement = (kind: AdminEntitlementDraft["kind"], pricingMode: AdminPricingMode) => {
    const seeded = entitlementFromCap(policy, kind, pricingMode, entitlement.startsAtUtc, entitlement.endsAtUtc);
    updateEntitlement({ ...seeded, scopeKey: entitlement.scopeKey, depositWaived: entitlement.depositWaived, reason: entitlement.reason });
  };
  const configuredHaffOf = (contract: Exclude<AdminPricingContract, AdminNotPriced>) => contract.haff.status === "CONFIGURED" ? contract.haff : configuredContract(contract.mode, boundPriceVersion, boundHaffSchema).haff;
  const patchContract = (tierName: AdminGrowthTier, patch: (contract: Exclude<AdminPricingContract, AdminNotPriced>) => Exclude<AdminPricingContract, AdminNotPriced>) => updateTier(tierName, (current) => ({ ...current, [mode]: patch(contractOf(current[mode], mode, boundPriceVersion, boundHaffSchema)) }));
  const entitlementErrors = [
    !entitlement.scopeKey.trim() ? "请填写业务范围" : "",
    entitlementWindowError(entitlement.startsAtUtc, entitlement.endsAtUtc),
    !entitlement.priceVersionId.trim() ? "请选择价格方案" : "",
    policy.catalog.safeBoxes.some((code) => !entitlement.haffBaseBySafeBox[code]?.trim()) ? "哈夫比例未覆盖全部安全箱" : "",
    !entitlement.spreadDelta.trim() ? "哈夫价差未完成" : "",
    policy.catalog.materials.some((material) => { const entry = entitlement.materials[material.id]; return !entry || !entry.unitQuantity.trim() || !entry.buyerUnitAmount.trim() || !entry.ownerUnitAmount.trim(); }) ? "物资单价合同未完成" : "",
    !entitlement.costBasisRef.trim() ? "成本依据未完成" : "",
    entitlement.reason.trim().length < 2 ? "请填写申请原因" : "",
  ].filter(Boolean);
  return <div className="membership-admin-view" data-testid="membership-growth-admin-view">
    <header className="membership-admin-header"><div><p className="membership-admin-kicker">运营工作台 · 会员成长</p><h2>成长权益与人工礼遇</h2><p>按“政策 → 报价判断 → 审批 → 执行结果”查看，不把批准、执行和业务生效混成一个成功状态。</p></div><span className={`membership-admin-status membership-admin-status--${policy.status.toLowerCase()}`}>{policy.status === "DRAFT" ? "草稿" : "已批准版本"} · {policy.version}</span></header>

    <section className="membership-admin-section" aria-labelledby="membership-admin-policy-heading">
      <div className="membership-admin-section-heading"><div><h3 id="membership-admin-policy-heading">等级权益配置</h3><p>阈值固定；编辑当前计价模式的哈夫比例、物资单位和买方/号主单价。缺成本依据可以保存草稿，不能提交批准。</p></div><div className="membership-admin-action-row"><GrowthSelect label="编辑计价模式" value={mode} onChange={(value) => setMode(value as AdminPricingMode)} options={enabledModes.map((value) => ({ value, label: value === "ordinary" ? "普通" : value === "custom" ? "自定义" : "极速" }))} className="membership-admin-inline-field" /><GrowthSelect label="安全箱目录" value={policy.selectedSafeBoxCode} onChange={(value) => updatePolicy({ ...policy, selectedSafeBoxCode: value })} options={policy.catalog.safeBoxes.map((code) => ({ value: code, label: `安全箱 ${code}` }))} className="membership-admin-inline-field" /><GrowthSelect label="物资目录" value={policy.selectedMaterialId} onChange={(value) => updatePolicy({ ...policy, selectedMaterialId: value })} options={policy.catalog.materials.map((item) => ({ value: item.id, label: item.name }))} className="membership-admin-inline-field" />{onSavePolicyDraft ? <button type="button" className="membership-admin-button" disabled={(!policyDirty && policySaved) || validation.errors.length > 0} onClick={onSavePolicyDraft}>保存草稿</button> : null}{onSubmitPolicy ? <button type="button" className="membership-admin-button" disabled={!validation.publishable || validation.errors.length > 0} onClick={onSubmitPolicy}>提交审批</button> : null}</div></div>
      <div className="membership-admin-table-wrap"><table className="membership-admin-table"><thead><tr><th>档位</th><th>成长门槛</th><th>免押</th><th>当前模式报价（哈夫比例/价差）</th><th>物资（单位数量/买方/号主）</th><th>版本/成本/上限</th></tr></thead><tbody>{policy.tiers.map((tier) => {
        const contract = contractOf(tier[mode], mode, boundPriceVersion, boundHaffSchema);
        const catalogMaterial = policy.catalog.materials.find((item) => item.id === policy.selectedMaterialId);
        const material = materialOf(contract, policy.selectedMaterialId, catalogMaterial?.unit ?? "PIECE", catalogMaterial?.unitQuantity ?? "");
        const haff = contract.haff.status === "CONFIGURED" ? contract.haff : null;
        const setMaterial = (patch: Partial<Exclude<AdminMaterialPrice, AdminNotPriced>>) => patchContract(tier.tier, (current) => ({ ...current, materials: { ...current.materials, [policy.selectedMaterialId]: { ...material, ...patch } } }));
        return <tr key={tier.tier}><th>{TIER_LABELS[tier.tier]}</th><td>{tier.threshold} 分</td><td><GrowthSelect label={`${tier.tier}免押`} value={tier.tenantDeposit} onChange={(value) => updateTier(tier.tier, (current) => ({ ...current, tenantDeposit: value as "ACCOUNT_BASE" | "WAIVED" }))} options={[{ value: "ACCOUNT_BASE", label: "按账号条件" }, { value: "WAIVED", label: "免押" }]} className="membership-admin-table-select" /></td><td><div className="membership-admin-price-pair"><Input aria-label={`${tier.tier}${mode}哈夫比例`} disabled={!policy.selectedSafeBoxCode} value={haff ? haff.baseBySafeBox[policy.selectedSafeBoxCode] ?? "" : ""} onChange={(event) => patchContract(tier.tier, (current) => { const currentHaff = configuredHaffOf(current); return { ...current, haff: { ...currentHaff, baseBySafeBox: { ...currentHaff.baseBySafeBox, [policy.selectedSafeBoxCode]: event.target.value } } }; })} /><Input aria-label={`${tier.tier}${mode}价差`} value={haff?.spreadDelta ?? ""} onChange={(event) => patchContract(tier.tier, (current) => ({ ...current, haff: { ...configuredHaffOf(current), spreadDelta: event.target.value } }))} /></div></td><td><div className="membership-admin-price-pair"><Input aria-label={`${tier.tier}物资单位数量`} disabled={!policy.selectedMaterialId} value={material.unitQuantity} onChange={(event) => setMaterial({ unitQuantity: event.target.value })} /><Input aria-label={`${tier.tier}物资买方单价`} disabled={!policy.selectedMaterialId} value={material.buyerUnitAmount} onChange={(event) => setMaterial({ buyerUnitAmount: event.target.value })} /><Input aria-label={`${tier.tier}物资号主单价`} disabled={!policy.selectedMaterialId} value={material.ownerUnitAmount} onChange={(event) => setMaterial({ ownerUnitAmount: event.target.value })} /></div></td><td><Input aria-label={`${tier.tier}成本依据`} value={haff?.costBasisRef ?? ""} onChange={(event) => patchContract(tier.tier, (current) => ({ ...current, haff: { ...configuredHaffOf(current), costBasisRef: event.target.value }, materials: { ...current.materials, [policy.selectedMaterialId]: { ...materialOf(current, policy.selectedMaterialId, catalogMaterial?.unit ?? "PIECE"), costBasisRef: event.target.value } } }))} /><small>{haff?.priceVersionId ? `价格方案 ${haff.priceVersionId}` : "价格方案待绑定"}</small>{tier.tier === "GOLD" || tier.tier === "DIAMOND" ? <small>{capStatusSummary(tier.maxEntitlement, enabledModes)}</small> : null}</td></tr>;
      })}</tbody></table></div>
      {validation.errors.length > 0 ? <p className="membership-admin-form-error" role="alert">配置仍缺少：{validation.errors.slice(0, 3).join("、")}</p> : null}{validation.warnings.length > 0 ? <p className="membership-admin-form-warning" role="status">可保存草稿，但不能提交批准：{validation.warnings.slice(0, 2).join("；")}</p> : null}
      <div className="membership-admin-change-list">{policy.changes.length === 0 ? <p className="membership-admin-muted">当前没有待审差异。</p> : policy.changes.map((change) => <div key={change.label} data-risk={change.risk}><span>{change.label}</span><span>{change.before} → {change.after}</span><strong>{change.risk === "REVIEW_REQUIRED" ? "需核查" : "可审阅"}</strong></div>)}</div>
    </section>

    <div className="membership-admin-two-col">
      <section className="membership-admin-section" aria-labelledby="membership-admin-preview-heading">
        <div className="membership-admin-section-heading"><div><h3 id="membership-admin-preview-heading">报价预览</h3><p>比较同一主体、账号版本和数量快照下的完整方案；未知价格保留待确认。</p></div></div>
        <div className="membership-admin-preview" data-state={preview.status}><strong>{preview.status === "KNOWN" || preview.status === "LOCAL_FIXTURE" ? formatCents(preview.totalCents) : preview.status === "NOT_RUN" ? "未演算" : "未知"}</strong><dl><div><dt>价格依据</dt><dd>{BASIS_LABELS[preview.priceBasis ?? ""] ?? preview.priceBasis ?? "待确认"}</dd></div><div><dt>免押依据</dt><dd>{BASIS_LABELS[preview.depositBasis ?? ""] ?? preview.depositBasis ?? "待确认"}</dd></div></dl><p>{preview.reason ?? "完整成长方案与礼遇方案择优，不拼接项目、不叠折。"}</p></div>
      </section>
      <section className="membership-admin-section" aria-labelledby="membership-admin-subject-heading">
        <div className="membership-admin-section-heading"><div><h3 id="membership-admin-subject-heading">用户成长依据</h3><p>查看授权范围内的消费来源、更正、90天退出和黑金证据。</p></div></div>
        <SubjectFacts subject={subject} />
      </section>
    </div>

    <section key={`entitlement-${state.subject.subjectId}`} className="membership-admin-section" aria-labelledby="membership-admin-entitlement-heading">
      <div className="membership-admin-section-heading"><div><h3 id="membership-admin-entitlement-heading">人工礼遇申请</h3><p>收礼人等级不限制是否可收礼；挚友/尊享只限制可配置价格范围。北京时间输入会转换为 UTC 合同。</p></div><span className="membership-admin-status membership-admin-status--unknown">阶段 B 待接线</span></div>
      <div className="membership-admin-form-grid">
        <GrowthSelect label="礼遇类型" value={entitlement.kind} onChange={(value) => reseedEntitlement(value as AdminEntitlementDraft["kind"], entitlement.pricingMode)} options={[{ value: "FRIEND", label: "挚友 · 金卡价格上限" }, { value: "PRESTIGE", label: "尊享 · 钻石价格上限" }]} />
        <label>业务范围<Input value={entitlement.scopeKey} maxLength={200} onChange={(event) => setEntitlementField("scopeKey", event.target.value)} /></label>
        <label>开始（北京时间）<Input type="datetime-local" value={utcToBeijingInput(entitlement.startsAtUtc)} onChange={(event) => setEntitlementField("startsAtUtc", beijingInputToUtc(event.target.value))} /></label>
        <label>结束（北京时间）<Input type="datetime-local" value={utcToBeijingInput(entitlement.endsAtUtc)} onChange={(event) => setEntitlementField("endsAtUtc", beijingInputToUtc(event.target.value))} /></label>
        <GrowthSelect label="计价模式" value={entitlement.pricingMode} onChange={(value) => reseedEntitlement(entitlement.kind, value as AdminPricingMode)} options={enabledModes.map((value) => ({ value, label: value === "ordinary" ? "普通方案" : value === "custom" ? "自定义方案" : "极速方案" }))} />
        <GrowthSelect label="价格方案" value={entitlement.priceVersionId} onChange={(value) => setEntitlementField("priceVersionId", value)} options={policy.catalog.priceVersions.map((item) => ({ value: item.id, label: item.label }))} />
        <label className="membership-admin-checkbox"><Checkbox.Root checked={entitlement.depositWaived} aria-label="独立授予免押" className="membership-admin-checkbox-control" onCheckedChange={(checked) => setEntitlementField("depositWaived", checked)}><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root><span>独立授予免押</span></label>
        <label className="membership-admin-wide">原因<textarea value={entitlement.reason} maxLength={500} onChange={(event) => setEntitlementField("reason", event.target.value)} /></label>
      </div>
      <details className="membership-admin-advanced" open><summary>完整计价合同（安全箱/资源/价差）</summary>
        <div className="membership-admin-form-grid">
          <label>成本依据<Input aria-label="礼遇成本依据" value={entitlement.costBasisRef} onChange={(event) => setEntitlementField("costBasisRef", event.target.value)} /></label>
          <label>哈夫价差<Input aria-label="礼遇价差" inputMode="decimal" value={entitlement.spreadDelta} onChange={(event) => setEntitlementField("spreadDelta", event.target.value)} /></label>
          <label>哈夫规则版本<span className="membership-admin-readonly-value">{boundHaffSchema === "haff-ratio-v2" ? "规则版本二" : "规则版本一"}</span></label>
        </div>
        <div className="membership-admin-table-wrap"><table className="membership-admin-table"><thead><tr><th>安全箱</th><th>哈夫比例</th></tr></thead><tbody>{policy.catalog.safeBoxes.map((code) => <tr key={code}><th>{code}</th><td><Input aria-label={`礼遇哈夫比例${code}`} value={entitlement.haffBaseBySafeBox[code] ?? ""} onChange={(event) => setEntitlementFields({ haffBaseBySafeBox: { ...entitlement.haffBaseBySafeBox, [code]: event.target.value } })} /></td></tr>)}</tbody></table></div>
        <div className="membership-admin-table-wrap"><table className="membership-admin-table"><thead><tr><th>物资</th><th>单位</th><th>单位数量</th><th>买方单价（元）</th><th>号主单价（元）</th></tr></thead><tbody>{policy.catalog.materials.map((material) => { const entry = entitlement.materials[material.id] ?? { unit: material.unit, unitQuantity: "", buyerUnitAmount: "", ownerUnitAmount: "" }; const patchMaterial = (patch: Partial<AdminEntitlementMaterial>) => setEntitlementFields({ materials: { ...entitlement.materials, [material.id]: { ...entry, ...patch } } }); return <tr key={material.id}><th>{material.name}</th><td>{UNIT_LABELS[material.unit]}</td><td><Input aria-label={`礼遇单位数量${material.id}`} inputMode="numeric" value={entry.unitQuantity} onChange={(event) => patchMaterial({ unitQuantity: event.target.value })} /></td><td><Input aria-label={`礼遇买方单价${material.id}`} inputMode="decimal" value={entry.buyerUnitAmount} onChange={(event) => patchMaterial({ buyerUnitAmount: event.target.value })} /></td><td><Input aria-label={`礼遇号主单价${material.id}`} inputMode="decimal" value={entry.ownerUnitAmount} onChange={(event) => patchMaterial({ ownerUnitAmount: event.target.value })} /></td></tr>; })}</tbody></table></div>
      </details>
      {entitlementErrors.length > 0 ? <p className="membership-admin-form-error" role="alert">提交前需要修正：{entitlementErrors.join("；")}</p> : null}
      <div className="membership-admin-action-row"><button type="button" className="membership-admin-button" disabled={entitlementErrors.length > 0 || !onSubmitEntitlement} onClick={onSubmitEntitlement}>提交礼遇审批</button><span className="membership-admin-muted">未接线时按钮禁用，不显示假成功。</span></div>
    </section>

    <section className="membership-admin-section" aria-labelledby="membership-admin-approval-heading">
      <div className="membership-admin-section-heading"><div><h3 id="membership-admin-approval-heading">审批与实际生效</h3><p>批准不等于执行，执行不等于订单生效；只消费原批准参数。</p></div><span className={`membership-admin-status membership-admin-status--${approval.status.toLowerCase()}`}>{approvalLabel(approval.status)}</span></div>
      <div className="membership-admin-approval-row"><strong>{approvalLabel(approval.status)}</strong><span>申请编号</span><code>{approval.requestId ?? "待创建"}</code><span>{approval.message ?? "当前没有可执行的批准回执。"}</span></div>
      {approval.status === "APPLIED" ? <div className="membership-admin-revoke-row"><label>撤销原因<Input value={revokeReason} maxLength={500} onChange={(event) => setRevokeReason(event.target.value)} /></label><button type="button" className="membership-admin-button membership-admin-button--danger" disabled={revokeReason.trim().length < 2 || !onRevokeEntitlement} onClick={() => { if (window.confirm("确认提交撤销申请？")) onRevokeEntitlement?.(revokeReason.trim()); }}>撤销礼遇</button></div> : null}
    </section>
  </div>;
}
