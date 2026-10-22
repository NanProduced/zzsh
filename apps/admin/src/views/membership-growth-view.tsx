import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { MembershipDateTimeField, parsePayableRatio, type AdminEntitlementDraft, type AdminEntitlementRange, type AdminEntitlementRanges } from './membership-entitlement-form';
export { parsePayableRatio, formatEntitlementDiscount, beijingInputToUtc, utcToBeijingInput, entitlementWindowError } from './membership-entitlement-form';
export type { AdminEntitlementDraft, AdminEntitlementRange, AdminEntitlementRanges } from './membership-entitlement-form';
import "./membership-growth-view.css";

export type AdminGrowthTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND";
export type AdminNotPriced = { status: "NOT_PRICED"; reason: string };
export type AdminHaffPrice = AdminNotPriced | { status: "CONFIGURED"; kind: "HAFF_RATIO"; schema: "haff-ratio-v1" | "haff-ratio-v2"; priceVersionId: string; costBasisRef: string; baseBySafeBox: Record<string, string>; spreadDelta?: string };
export type AdminMaterialPrice = AdminNotPriced | { status: "CONFIGURED"; kind: "FIXED_UNIT"; itemId: string; unit: "ROUND" | "PIECE" | "DAY"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string; priceVersionId: string; costBasisRef: string };
export type AdminPricingMode = "ordinary" | "custom" | "fast";
/** Legacy haff/materials contract (read compatibility only; new member benefits no longer use it). */
export type AdminPricingContract = AdminNotPriced | { mode: AdminPricingMode; priceVersionId: string; haff: AdminHaffPrice; materials: Record<string, AdminMaterialPrice> };
/** Owner total-discount contract: payable share of haff rent + item resource fees, applied once. */
export type AdminTotalDiscount = { status: "CONFIGURED"; kind: "TOTAL_DISCOUNT"; mode: AdminPricingMode; priceVersionId: string; payableRatio: string; costBasisRef: string };
export type AdminModeContract = AdminPricingContract | AdminTotalDiscount | AdminNotPriced;
export type AdminEntitlementCapByMode = { byMode: Partial<Record<AdminPricingMode, AdminModeContract>> };
export type AdminEntitlementCap = AdminModeContract | AdminEntitlementCapByMode;
export type AdminGrowthCatalog = { safeBoxes: string[]; materials: Array<{ id: string; name: string; unit: "ROUND" | "PIECE" | "DAY"; unitQuantity?: string }>; priceVersions: Array<{ id: string; label: string }>; enabledModes?: AdminPricingMode[]; haffSchema?: "haff-ratio-v1" | "haff-ratio-v2"; releaseMode?: "SPREAD" | "PERCENT"; catalogSource?: "SEALED" | "POLICY_PAYLOAD" | null };
export type AdminGrowthPolicy = {
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: string | null;
  catalog: AdminGrowthCatalog;
  selectedSafeBoxCode: string;
  selectedMaterialId: string;
  tiers: Array<{ tier: AdminGrowthTier; threshold: string; tenantDeposit: "ACCOUNT_BASE" | "WAIVED"; ordinary: AdminModeContract; custom: AdminModeContract; fast: AdminModeContract; maxEntitlement: AdminEntitlementCap }>;
  changes: Array<{ label: string; before: string; after: string; risk: "LOW" | "REVIEW_REQUIRED" }>;
  entitlementRanges?: AdminEntitlementRanges;
};

export type AdminGrowthPreview = { status: "NOT_RUN" | "LOCAL_FIXTURE" | "KNOWN" | "UNKNOWN"; totalCents?: string; priceBasis?: string; depositBasis?: string; reason?: string };
export type AdminGrowthSubject = { subjectId: string; status: "NOT_LOADED" | "LOADED" | "UNKNOWN" | "FORBIDDEN"; userLabel?: string; tier?: string; rollingPoints?: string; lifetimePoints?: string; evidence?: string[]; reason?: string };
/** Manual entitlement grant: discount plus an explicit expiry, no second base price table. */
export type AdminApproval = { status: "NOT_REQUESTED" | "REQUESTED" | "APPROVED_PENDING_EXECUTION" | "APPLIED" | "REJECTED" | "UNKNOWN"; requestId?: string; message?: string };

export type MembershipGrowthAdminState =
  | { status: "loading" }
  // A missing/failed policy must not discard the granted subject read; the subject stays visible.
  | { status: "error"; message: string; subject?: AdminGrowthSubject }
  | { status: "permission"; message: string }
  | { status: "ready"; policy: AdminGrowthPolicy; preview: AdminGrowthPreview; subject: AdminGrowthSubject; entitlement: AdminEntitlementDraft; approval: AdminApproval };

const TIER_LABELS: Record<AdminGrowthTier, string> = { STANDARD: "普通", SILVER: "银卡", GOLD: "金卡", PLATINUM: "铂金", DIAMOND: "钻石" };
const MODES = ["ordinary", "custom", "fast"] as const satisfies readonly AdminPricingMode[];
const MODE_LABELS: Record<AdminPricingMode, string> = { ordinary: "普通", custom: "自定义", fast: "极速" };

export function isAdminNotPriced(value: unknown): value is AdminNotPriced { return Boolean(value && typeof value === "object" && "status" in value && (value as AdminNotPriced).status === "NOT_PRICED"); }
export function isAdminTotalDiscount(value: unknown): value is AdminTotalDiscount { return Boolean(value && typeof value === "object" && "status" in value && (value as AdminTotalDiscount).status === "CONFIGURED" && (value as AdminTotalDiscount).kind === "TOTAL_DISCOUNT"); }
export function isLegacyAdminPricing(value: unknown): value is Exclude<AdminPricingContract, AdminNotPriced> { return Boolean(value && typeof value === "object" && "haff" in value && "materials" in value && !isAdminNotPriced(value) && !isAdminTotalDiscount(value)); }
export function isAdminCapByMode(cap: AdminEntitlementCap): cap is AdminEntitlementCapByMode { return Boolean(cap && "byMode" in cap); }
export function adminCapForMode(cap: AdminEntitlementCap, mode: AdminPricingMode): AdminModeContract | undefined {
  return isAdminCapByMode(cap) ? cap.byMode[mode] : cap;
}

function discountDraft(mode: AdminPricingMode, priceVersionId: string, payableRatio = "", costBasisRef = ""): AdminTotalDiscount {
  return { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode, priceVersionId, payableRatio, costBasisRef };
}

function pending(value: string | undefined): boolean { return !value || !value.trim(); }

function modeContractOf(value: AdminModeContract, mode: AdminPricingMode, priceVersionId: string): AdminTotalDiscount {
  return isAdminTotalDiscount(value) ? value : discountDraft(mode, priceVersionId);
}

/** First draft for an empty policy table: one total-discount slot per enabled mode, every unknown share stays 待核. */
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
      ordinary: pending("普通方案待配置：需批准的应付比例与成本依据"),
      custom: pending("自定义方案待配置：需批准的应付比例与成本依据"),
      fast: pending("极速方案待配置：需批准的应付比例与成本依据"),
      maxEntitlement: pending("独立礼遇范围另行配置，旧档位上限不适用"),
    })),
    changes: [],
    entitlementRanges: {FRIEND:{byMode:{}},PRESTIGE:{byMode:{}}},
  };
}

function capTierFor(kind: AdminEntitlementDraft["kind"]): AdminGrowthTier { return kind === "FRIEND" ? "GOLD" : "DIAMOND"; }

/** Seeds a 礼遇 draft from the cap of the matching tier so edits start at the allowed boundary. */
export function entitlementFromCap(policy: AdminGrowthPolicy, kind: AdminEntitlementDraft["kind"], mode: AdminPricingMode, startsAtUtc: string, endsAtUtc: string): AdminEntitlementDraft {
  const capTier = policy.tiers.find((tier) => tier.tier === capTierFor(kind));
  const capEntry = capTier ? adminCapForMode(capTier.maxEntitlement, mode) : undefined;
  const discount = isAdminTotalDiscount(capEntry) ? capEntry : null;
  return {
    kind, scopeKey: "", startsAtUtc, endsAtUtc, pricingMode: mode,
    priceVersionId: policy.catalog.priceVersions[0]?.id ?? "",
    payableRatio: discount?.payableRatio ?? "",
    costBasisRef: discount?.costBasisRef ?? "",
    depositWaived: false,
    reason: "",
  };
}

export function validateAdminPolicyDraft(policy: AdminGrowthPolicy, enabledModes: readonly AdminPricingMode[] = MODES): { errors: string[]; warnings: string[]; publishable: boolean } {
  const errors: string[] = [], warnings: string[] = [];
  const enabled = new Set<AdminPricingMode>(enabledModes);
  if(!enabled.size)warnings.push('当前没有启用的计价模式');
  if (!policy.effectiveAt) warnings.push("政策生效时点未填写：发布前必须确认");
  for (const tier of policy.tiers) for (const mode of MODES) {
    const contract = tier[mode];
    const path = `${TIER_LABELS[tier.tier]} · ${MODE_LABELS[mode]}`;
    if (!enabled.has(mode)) continue; // the sealed release disabled this mode: draft content is inert
    if (isAdminNotPriced(contract)) { warnings.push(`${path}:应付比例待配置`); continue; }
    if (isLegacyAdminPricing(contract)) continue; // legacy haff/materials contract stays readable as-is
    const missing: string[] = [];
    if (pending(contract.priceVersionId)) errors.push(`${path}:缺少价格版本`);
    if (pending(contract.payableRatio)) missing.push("应付比例");
    else if (parsePayableRatio(contract.payableRatio) === null) errors.push(`${path}:应付比例须为0–1之间的小数`);
    if (pending(contract.costBasisRef)) missing.push("成本依据");
    else if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(contract.costBasisRef))errors.push(`${path}:成本依据须填写有效编号`);
    if (missing.length > 0) warnings.push(`${path}:待补 ${missing.join("/")}`);
  }
  // Higher tiers must never pay a larger share of the same base total; disabled modes stay inert.
  for (let index = 1; index < policy.tiers.length; index += 1) {
    const lower = policy.tiers[index - 1]!, higher = policy.tiers[index]!;
    for (const mode of enabled) {
      const lowerContract = lower[mode], higherContract = higher[mode];
      if (!isAdminTotalDiscount(lowerContract) || !isAdminTotalDiscount(higherContract)) continue;
      const lowerRatio = parsePayableRatio(lowerContract.payableRatio);
      const higherRatio = parsePayableRatio(higherContract.payableRatio);
      if (lowerRatio !== null && higherRatio !== null && higherRatio > lowerRatio) errors.push(`${TIER_LABELS[higher.tier]} · ${MODE_LABELS[mode]}：高档应付比例不得高于低档`);
    }
  }
  if (policy.entitlementRanges) {
    for (const kind of ['FRIEND','PRESTIGE'] as const) for (const mode of enabled) {
      const entry=policy.entitlementRanges[kind]?.byMode[mode],path=`${kind==='FRIEND'?'挚友':'尊享'}.${MODE_LABELS[mode]}`;
      if(!entry||isAdminNotPriced(entry)){warnings.push(`${path}:独立折扣范围待配置`);continue;}
      const min=parsePayableRatio(entry.minPayableRatio),max=parsePayableRatio(entry.maxPayableRatio);
      if(entry.mode!==mode)errors.push(`${path}:模式不一致`);
      if(!entry.priceVersionId.trim())errors.push(`${path}:缺少价格版本`);
      if(!entry.minPayableRatio||!entry.maxPayableRatio)errors.push(`${path}:请填写最小和最大应付比例`);
      else if(min===null||max===null||min>max)errors.push(`${path}:范围须在0–1之间，最小值不能大于最大值`);
      if(!entry.costBasisRef.trim())warnings.push(`${path}:成本依据待配置`);
      else if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(entry.costBasisRef))errors.push(`${path}:成本依据须填写有效编号`);
    }
  } else for (const tier of policy.tiers) {
    const cap = tier.maxEntitlement;
    if (!isAdminCapByMode(cap)) { if (isAdminNotPriced(cap)) warnings.push(`${TIER_LABELS[tier.tier]}：旧礼遇上限未配置`); continue; }
    for (const mode of enabled) {
      const entry = cap.byMode[mode];
      const path = `${TIER_LABELS[tier.tier]} · ${MODE_LABELS[mode]}旧礼遇上限`;
      if (!entry || isAdminNotPriced(entry)) { warnings.push(`${path}:礼遇上限未配置`); continue; }
      if (entry.mode !== mode) { errors.push(`${path}:模式不一致`); continue; }
      if (isLegacyAdminPricing(entry)) continue; // legacy configured cap stays readable as-is
      const missing: string[] = [];
      if (pending(entry.priceVersionId)) errors.push(`${path}:缺少价格版本`);
      if (pending(entry.payableRatio)) missing.push("应付比例");
      else if (parsePayableRatio(entry.payableRatio) === null) errors.push(`${path}:应付比例须为0–1之间的小数`);
      if (pending(entry.costBasisRef)) missing.push("成本依据");
      if (missing.length > 0) { warnings.push(`${path}:待补 ${missing.join("/")}`); continue; }
      // A cap at or above its tier share is a legitimate tightening; below it would let 礼遇 beat the tier.
      const tierContract = tier[mode];
      const capRatio = parsePayableRatio(entry.payableRatio);
      const tierRatio = isAdminTotalDiscount(tierContract) ? parsePayableRatio(tierContract.payableRatio) : null;
      if (capRatio !== null && tierRatio !== null && capRatio < tierRatio) warnings.push(`${path}:礼遇上限深于该成长档`);
    }
  }
  return { errors, warnings, publishable: errors.length === 0 && warnings.length === 0 };
}

/**
 * Explicit DRAFT-only action: repair missing, pending or invalid caps from the matching tier share,
 * fill an incomplete cap's own missing cost/version from the tier, and keep legitimate tightened caps.
 */
export function completeEntitlementCaps(policy: AdminGrowthPolicy, enabledModes: readonly AdminPricingMode[]): AdminGrowthPolicy {
  if(policy.entitlementRanges)return policy;
  return {
    ...policy,
    tiers: policy.tiers.map((tier) => {
      const cap = tier.maxEntitlement;
      const existing = isAdminCapByMode(cap) ? cap.byMode : null;
      if (!existing && !isAdminNotPriced(cap)) return tier; // legacy configured cap is preserved untouched
      const byMode: Partial<Record<AdminPricingMode, AdminModeContract>> = { ...(existing ?? {}) };
      for (const mode of enabledModes) {
        const current = byMode[mode];
        const tierContract = tier[mode];
        const tierDiscount = isAdminTotalDiscount(tierContract) ? tierContract : null;
        if (!tierDiscount) continue; // only a configured tier share can seed/repair a cap
        const currentRatio = isAdminTotalDiscount(current) ? parsePayableRatio((current as AdminTotalDiscount).payableRatio) : null;
        const tierRatio = parsePayableRatio(tierDiscount.payableRatio);
        const invalid = !current || isAdminNotPriced(current) || currentRatio === null
          || (currentRatio !== null && tierRatio !== null && currentRatio < tierRatio); // deeper than the tier cannot stand
        if (invalid) { byMode[mode] = JSON.parse(JSON.stringify(tierDiscount)) as AdminTotalDiscount; continue; }
        if (isAdminTotalDiscount(current) && (pending(current.costBasisRef) || pending(current.priceVersionId))) {
          // Keep the operator's tightened share, repair only the incomplete facts from the tier.
          byMode[mode] = { ...current, costBasisRef: pending(current.costBasisRef) ? tierDiscount.costBasisRef : current.costBasisRef, priceVersionId: pending(current.priceVersionId) ? tierDiscount.priceVersionId : current.priceVersionId };
        }
      }
      return { ...tier, maxEntitlement: { byMode } };
    }),
  };
}

export function capStatusSummary(cap: AdminEntitlementCap, enabledModes: readonly AdminPricingMode[]): string {
  const modes = enabledModes.length > 0 ? enabledModes : MODES;
  const configured = modes.filter((mode) => { const entry = adminCapForMode(cap, mode); return Boolean(entry && !isAdminNotPriced(entry)); });
  return configured.length === 0 ? "礼遇上限未配置" : `礼遇上限 ${configured.map((mode) => MODE_LABELS[mode]).join("/")} 已配置${configured.length < modes.length ? "（部分模式）" : ""}`;
}

function GrowthSelect({ label, value, onChange, options, className = "", disabled=false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; className?: string;disabled?:boolean }) {
  return <label className={`membership-admin-control ${className}`}><span>{label}</span><Select value={value || null} disabled={disabled||!options.length} onValueChange={(next) => onChange(next ?? "")}><SelectTrigger aria-label={label} className="membership-admin-select-trigger"><SelectValue placeholder="请选择">{options.find((option) => option.value === value)?.label}</SelectValue></SelectTrigger><SelectContent align="start">{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}

export function formatCents(cents: string | undefined): string { if (!cents || !/^(0|[1-9]\d*)$/.test(cents)) return "待确认"; const value = cents.padStart(3, "0"); return `¥${value.slice(0, -2)}.${value.slice(-2)}`; }

function stateMessage(state: Exclude<MembershipGrowthAdminState, {status:'ready'}>) {
  const title=state.status==='loading'?'正在读取会员政策':state.status==='permission'?'没有会员政策查看权限':'会员政策暂不可用';
  return <section className="membership-admin-view" data-state={state.status} role={state.status==='error'?'alert':'status'}>
    <div className="membership-admin-state"><strong>{title}</strong>{state.status==='loading'?<><Skeleton className="h-8 w-full"/><Skeleton className="h-36 w-full"/></>:<p>{state.message}</p>}</div>
  </section>;
}

export function MembershipGrowthAdminView({state,policySaved=true,canEditEntitlementRanges=false,onPolicyChange,onSavePolicyDraft,onSubmitPolicy}:{
  state:MembershipGrowthAdminState;policySaved?:boolean;canEditEntitlementRanges?:boolean;
  onPolicyChange?:(policy:AdminGrowthPolicy)=>void;onSavePolicyDraft?:()=>void;onSubmitPolicy?:()=>void;
  /** Kept for the old host during the split; grants and approvals now use their own workspace. */
  onEntitlementChange?:(draft:AdminEntitlementDraft)=>void;onSubmitEntitlement?:()=>void;onRevokeEntitlement?:(reason:string)=>void;
}) {
  const [draftPolicy,setDraftPolicy]=useState<AdminGrowthPolicy|null>(state.status==='ready'?state.policy:null);
  const [mode,setMode]=useState<AdminPricingMode>('ordinary'),[dirty,setDirty]=useState(false);
  useEffect(()=>{if(state.status==='ready'){setDraftPolicy(state.policy);setDirty(false);}},[state.status==='ready'?state.policy.version:null,state.status==='ready'?state.policy.catalog.priceVersions[0]?.id:null]);
  if(state.status!=='ready')return stateMessage(state);
  if(!draftPolicy)return stateMessage({status:'loading'});
  const policy=draftPolicy,enabledModes=policy.catalog.enabledModes??[...MODES];
  const activeMode=enabledModes.includes(mode)?mode:enabledModes[0]??'ordinary';
  const boundPriceVersion=policy.catalog.priceVersions[0]?.id??'',editable=!!onPolicyChange&&enabledModes.length>0;
  const rangeEditable=editable&&canEditEntitlementRanges,validation=validateAdminPolicyDraft(policy,enabledModes);
  const updatePolicy=(next:AdminGrowthPolicy)=>{setDraftPolicy(next);setDirty(true);onPolicyChange?.(next);};
  const updateTier=(tierName:AdminGrowthTier,patch:Partial<AdminGrowthPolicy['tiers'][number]>)=>updatePolicy({...policy,tiers:policy.tiers.map(tier=>tier.tier===tierName?{...tier,...patch}:tier)});
  const setTierDiscount=(tier:AdminGrowthPolicy['tiers'][number],patch:Partial<Pick<AdminTotalDiscount,'payableRatio'|'costBasisRef'>>)=>updateTier(tier.tier,{[activeMode]:{...modeContractOf(tier[activeMode],activeMode,boundPriceVersion),...patch}});
  const updateRange=(kind:'FRIEND'|'PRESTIGE',patch:Partial<Pick<AdminEntitlementRange,'minPayableRatio'|'maxPayableRatio'|'costBasisRef'>>)=>{
    if(!rangeEditable)return;
    const existing=policy.entitlementRanges?.[kind]?.byMode[activeMode];
    const entry:AdminEntitlementRange=existing?.status==='CONFIGURED'?existing:{status:'CONFIGURED',kind:'TOTAL_DISCOUNT_RANGE',mode:activeMode,priceVersionId:boundPriceVersion,minPayableRatio:'',maxPayableRatio:'',costBasisRef:''};
    const ranges=policy.entitlementRanges??{FRIEND:{byMode:{}},PRESTIGE:{byMode:{}}};
    updatePolicy({...policy,entitlementRanges:{...ranges,[kind]:{byMode:{...ranges[kind].byMode,[activeMode]:{...entry,...patch}}}}});
  };
  return <div className="membership-admin-view" data-testid="membership-growth-admin-view">
    <header className="membership-admin-header"><div><h2>会员政策</h2><p>配置成长权益与两类礼遇的折扣范围。已批准版本保留原件，修改后保存新草稿。</p></div><Badge variant={dirty?'warning':policy.status==='DRAFT'?'secondary':'success'}>{dirty?'有未保存修改':policy.status==='DRAFT'?'政策草稿':'已批准版本'} · {policy.version}</Badge></header>
    <div className="membership-admin-policy-toolbar"><GrowthSelect label="计价模式" value={activeMode} onChange={value=>setMode(value as AdminPricingMode)} options={enabledModes.map(value=>({value,label:MODE_LABELS[value]}))} className="membership-admin-inline-field"/>
      <MembershipDateTimeField label="政策生效" value={policy.effectiveAt??''} disabled={!editable} onChange={value=>updatePolicy({...policy,effectiveAt:value||null})}/>
    </div>
    {!enabledModes.length?<p className="membership-admin-form-warning" role="status">当前没有启用的计价模式，暂不能配置或提交政策。</p>:null}
    {policy.catalog.catalogSource==='POLICY_PAYLOAD'?<p className="membership-admin-form-warning" role="status">当前显示政策保存的资料；保存与发布仍需核对规则绑定。</p>:null}
    <section className="membership-admin-section" aria-labelledby="membership-admin-policy-heading"><div className="membership-admin-section-heading"><div><h3 id="membership-admin-policy-heading">成长等级权益</h3><p>应付比例作用于哈夫币租金与物资费合计，0.9 表示九折。</p></div></div>
      <Table className="membership-admin-table"><TableHeader><TableRow><TableHead>会员等级</TableHead><TableHead>成长门槛</TableHead><TableHead>押金权益</TableHead><TableHead>{MODE_LABELS[activeMode]}应付比例</TableHead><TableHead>成本依据</TableHead></TableRow></TableHeader><TableBody>{policy.tiers.map(tier=>{
        const contract=tier[activeMode],discount=isAdminTotalDiscount(contract)?contract:null;
        return <TableRow key={tier.tier}><TableCell className="font-medium">{TIER_LABELS[tier.tier]}</TableCell><TableCell className="tabular-nums">{tier.threshold} 分</TableCell>
          <TableCell><GrowthSelect label={`${tier.tier}免押`} disabled={!editable} value={tier.tenantDeposit} onChange={value=>updateTier(tier.tier,{tenantDeposit:value as 'ACCOUNT_BASE'|'WAIVED'})} options={[{value:'ACCOUNT_BASE',label:'按账号条件'},{value:'WAIVED',label:'免押'}]} className="membership-admin-table-select"/></TableCell>
          <TableCell><Input aria-label={`${tier.tier}${activeMode}应付比例`} disabled={!editable} inputMode="decimal" value={discount?.payableRatio??''} placeholder={isLegacyAdminPricing(contract)?'旧价格合同':'待配置'} onChange={event=>setTierDiscount(tier,{payableRatio:event.target.value})}/></TableCell>
          <TableCell><Input aria-label={`${tier.tier}${activeMode}成本依据`} disabled={!editable} value={discount?.costBasisRef??''} placeholder={isLegacyAdminPricing(contract)?'旧合同兼容':'待配置'} onChange={event=>setTierDiscount(tier,{costBasisRef:event.target.value})}/></TableCell>
        </TableRow>;
      })}</TableBody></Table>
    </section>
    <section className="membership-admin-section" aria-labelledby="membership-admin-range-heading"><div className="membership-admin-section-heading"><div><h3 id="membership-admin-range-heading">礼遇折扣范围</h3><p>挚友与尊享分别配置，与成长等级的折扣独立。</p></div><Badge variant="outline">{canEditEntitlementRanges?'Boss 可配置':'仅 Boss 可修改'}</Badge></div>
      {!policy.entitlementRanges?<p className="membership-admin-form-warning" role="status">尚未配置独立范围，当前按旧政策兼容。已批准礼遇保持原条款。</p>:null}
      <Table className="membership-admin-table membership-admin-range-table"><TableHeader><TableRow><TableHead>礼遇类型</TableHead><TableHead>最小应付比例</TableHead><TableHead>最大应付比例</TableHead><TableHead>成本依据</TableHead><TableHead>当前模式</TableHead></TableRow></TableHeader><TableBody>{(['FRIEND','PRESTIGE'] as const).map(kind=>{
        const raw=policy.entitlementRanges?.[kind]?.byMode[activeMode],range=raw?.status==='CONFIGURED'?raw:null;
        return <TableRow key={kind}><TableCell className="font-medium">{kind==='FRIEND'?'挚友礼遇':'尊享礼遇'}</TableCell>
          <TableCell><Input aria-label={`${kind}${activeMode}最小应付比例`} disabled={!rangeEditable} inputMode="decimal" value={range?.minPayableRatio??''} placeholder="如 0.8" onChange={event=>updateRange(kind,{minPayableRatio:event.target.value})}/></TableCell>
          <TableCell><Input aria-label={`${kind}${activeMode}最大应付比例`} disabled={!rangeEditable} inputMode="decimal" value={range?.maxPayableRatio??''} placeholder="如 1" onChange={event=>updateRange(kind,{maxPayableRatio:event.target.value})}/></TableCell>
          <TableCell><Input aria-label={`${kind}${activeMode}成本依据`} disabled={!rangeEditable} value={range?.costBasisRef??''} placeholder="待配置" onChange={event=>updateRange(kind,{costBasisRef:event.target.value})}/></TableCell>
          <TableCell><Badge variant={range?'secondary':'outline'}>{MODE_LABELS[activeMode]} · {range?'已填写':'待配置'}</Badge></TableCell>
        </TableRow>;
      })}</TableBody></Table><p className="membership-admin-muted">比例须大于0且不超过1，最小值不大于最大值。实际发放时仍需审批。</p>
    </section>
    {validation.errors.length?<p className="membership-admin-form-error" role="alert">请修正：{validation.errors.slice(0,3).join('；')}</p>:null}
    {validation.warnings.length?<p className="membership-admin-form-warning" role="status">可保存草稿，提审前需补齐：{validation.warnings.slice(0,3).join('；')}</p>:null}
    {policy.changes.length?<div className="membership-admin-change-list">{policy.changes.map(change=><div key={change.label}><span>{change.label}</span><span>{change.before} → {change.after}</span><Badge variant={change.risk==='REVIEW_REQUIRED'?'warning':'outline'}>{change.risk==='REVIEW_REQUIRED'?'需核查':'待审阅'}</Badge></div>)}</div>:null}
    <div className="membership-admin-action-row">{onSavePolicyDraft?<Button type="button" disabled={(!dirty&&policySaved)||validation.errors.length>0} onClick={onSavePolicyDraft}>保存草稿</Button>:null}{onSubmitPolicy?<Button type="button" variant="outline" disabled={dirty||!policySaved||policy.status!=='DRAFT'||!validation.publishable||!enabledModes.length} onClick={onSubmitPolicy}>提交审批</Button>:null}{dirty?<span className="membership-admin-muted">保存后再提交审批。</span>:null}</div>
  </div>;
}
