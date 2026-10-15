/**
 * 账号供给列表/快速查看的纯模型：不依赖 React/DOM。
 * 原则：查找类型以用户选择为准，识别只作建议；待核条件单独计数；
 * 公开、占用、运营限制、号主暂停、新单资格各自读取，不由单一状态推导。
 */
import { formatAmount, formatFundingCents, quantityText, type SupplyFacts, type SupplyListSummary, type SupplyQueryKind, type SupplyWorkItem, type SupplyWorkView } from "../supply-review/model.ts";

export const KIND_LABELS: Record<SupplyQueryKind, string> = { account: "编号", legacy: "旧编号", order: "订单号", owner: "号主", nickname: "昵称", link: "本站链接" };

/** 只给建议，不改变当前查找类型。返回 null 表示无法可靠识别，需要用户自己选。 */
export function suggestKind(raw: string): SupplyQueryKind | null {
  const q = raw.trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q) || q.startsWith("/supply/") || q.startsWith("/orders/") || q.startsWith("/accounts/")) return "link";
  if (/^account_[A-Za-z0-9]+$/.test(q)) return "account";
  if (/^user_[A-Za-z0-9]+$/.test(q)) return "owner";
  // 纯数字可能是旧编号、订单号或旧用户 ID，不能当昵称，也不能替用户决定。
  if (/^\d+$/.test(q)) return null;
  if (/[\u4e00-\u9fff]/.test(q) && !/[-_]/.test(q)) return "nickname";
  return null;
}

/** 当前选择与输入明显不符时给出提示文案。 */
export function kindHint(raw: string, kind: SupplyQueryKind): string | null {
  const q = raw.trim();
  if (!q) return null;
  if (/^\d+$/.test(q) && kind === "nickname") return "纯数字更可能是旧编号、订单号或旧用户 ID，请确认查找类型。";
  if (/^\d+$/.test(q)) return "纯数字无法可靠判断类型，请确认按「" + KIND_LABELS[kind] + "」查找。";
  const s = suggestKind(q);
  if (s && s !== kind) return "看起来像" + KIND_LABELS[s] + "，当前按「" + KIND_LABELS[kind] + "」查找。";
  if (!s) return "无法可靠识别类型，当前按「" + KIND_LABELS[kind] + "」查找。";
  return null;
}

const PENDING = new Set(["OCCUPANCY_UNKNOWN", "FUNDING_UNKNOWN", "PUBLISHER_BAIL_UNCONFIRMED"]);
export type Condition = { code: string; who: string };
export type ConditionGroups = { blocked: Condition[]; pending: Condition[]; satisfied: string[] };

export function whoHandles(code: string): string {
  return nextStep(code);
}

/** 三组分别展示：已确认阻塞 / 待核 / 已满足。待核不并入“已满足”。 */
export function groupConditions(facts: SupplyFacts): ConditionGroups {
  const codes = [...new Set(facts.reasons)];
  if (facts.staffRestricted && !codes.includes("STAFF_RESTRICTED")) codes.push("STAFF_RESTRICTED");
  if (facts.ownerPaused && !codes.includes("OWNER_PAUSED")) codes.push("OWNER_PAUSED");
  const blocked = codes.filter(c => !PENDING.has(c)).map(code => ({ code, who: whoHandles(code) }));
  const pending = codes.filter(c => PENDING.has(c)).map(code => ({ code, who: nextStep(code) }));
  if (facts.publicVisible === null) pending.push({ code: "PUBLIC_UNKNOWN", who: nextStep("PUBLIC_UNKNOWN") });
  if (facts.newOrders === null) pending.push({ code: "NEW_ORDERS_UNKNOWN", who: nextStep("NEW_ORDERS_UNKNOWN") });
  if (facts.occupancy === "UNKNOWN" && !codes.includes("OCCUPANCY_UNKNOWN")) pending.push({ code: "OCCUPANCY_UNKNOWN", who: nextStep("OCCUPANCY_UNKNOWN") });
  if (typeof facts.staffRestricted !== "boolean") pending.push({ code: "RESTRICTION_UNKNOWN", who: nextStep("RESTRICTION_UNKNOWN") });
  if (typeof facts.ownerPaused !== "boolean") pending.push({ code: "PAUSE_UNKNOWN", who: nextStep("PAUSE_UNKNOWN") });
  const satisfied: string[] = [];
  if (facts.staffRestricted === false) satisfied.push("没有运营限制");
  if (facts.ownerPaused === false) satisfied.push("号主未暂停");
  if (facts.occupancy === "FREE") satisfied.push("未被占用");
  return { blocked, pending, satisfied };
}

export function conditionHeadline(g: ConditionGroups): string {
  if (!g.blocked.length && !g.pending.length) return "接新单条件：服务端未返回阻塞";
  return [g.blocked.length ? g.blocked.length + " 项已确认阻塞" : "", g.pending.length ? g.pending.length + " 项待核" : ""].filter(Boolean).join("、");
}

/** 解除弹窗摘要：排除运营限制本身。 */
export function liftSummary(g: ConditionGroups): string {
  const x = g.blocked.filter(c => c.code !== "STAFF_RESTRICTED").length;
  return "另有 " + x + " 项已确认阻塞、" + g.pending.length + " 项待核；解除后重新检查接单资格";
}

/** 五项独立事实，各自读取。 */
export function independentFacts(f: SupplyFacts): Array<{ label: string; value: string; tone: "ok" | "warn" | "muted" | "info" }> {
  return [
    { label: "公开", value: f.publicVisible === null ? "待核" : f.publicVisible ? "租客可见" : "未公开", tone: f.publicVisible === null ? "muted" : f.publicVisible ? "ok" : "muted" },
    { label: "占用", value: f.occupancy === "OCCUPIED" ? "占用中" : f.occupancy === "FREE" ? "空闲" : "待核", tone: f.occupancy === "OCCUPIED" ? "info" : f.occupancy === "FREE" ? "ok" : "muted" },
    { label: "运营限制", value: typeof f.staffRestricted !== "boolean" ? "待核" : f.staffRestricted ? "限制中" : "无", tone: typeof f.staffRestricted !== "boolean" ? "muted" : f.staffRestricted ? "warn" : "ok" },
    { label: "号主暂停", value: typeof f.ownerPaused !== "boolean" ? "待核" : f.ownerPaused ? "已暂停" : "未暂停", tone: typeof f.ownerPaused !== "boolean" ? "muted" : f.ownerPaused ? "warn" : "ok" },
    { label: "新单资格", value: f.newOrders === null ? "待核" : f.newOrders ? "可接新单" : "不可接新单", tone: f.newOrders === null ? "muted" : f.newOrders ? "ok" : "warn" },
  ];
}

/* ---------- 个人保存的视图（仅本浏览器） ---------- */
export const SAVED_VERSION = 1;
export type SavedView = { name: string; view: SupplyWorkView; kind: SupplyQueryKind; q: string; gameId: string };
const VIEWS: SupplyWorkView[] = ["all", "changes", "restricted", "paused", "orders"];
const KINDS: SupplyQueryKind[] = ["account", "legacy", "owner", "nickname", "order", "link"];
export const savedKey = (adminId: string) => "zzsh.admin.supply-accounts.saved-views:" + adminId;

/** 校验本地数据：损坏、版本过期或字段不合法时安全回退，并返回提示。 */
export function parseSavedViews(raw: string | null, adminId: string): { views: SavedView[]; notice?: string } {
  if (raw == null) return { views: [] };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { views: [], notice: "本地保存的视图已损坏，已忽略；请重新保存。" }; }
  const d = data as { version?: unknown; adminId?: unknown; views?: unknown };
  if (!d || typeof d !== "object" || d.version !== SAVED_VERSION || !Array.isArray(d.views)) return { views: [], notice: "本地保存的视图格式已过期，已忽略；请重新保存。" };
  if (d.adminId !== adminId) return { views: [], notice: "本地保存的视图不属于当前账号，已忽略。" };
  const ok = d.views.filter((v): v is SavedView => !!v && typeof v === "object" && typeof (v as SavedView).name === "string" && (v as SavedView).name.trim().length > 0 && (v as SavedView).name.length <= 40 && VIEWS.includes((v as SavedView).view) && KINDS.includes((v as SavedView).kind) && typeof (v as SavedView).q === "string" && (v as SavedView).q.length <= 128 && typeof (v as SavedView).gameId === "string").slice(0, 20);
  return ok.length === d.views.length ? { views: ok } : { views: ok, notice: "部分保存的视图已失效，已跳过 " + (d.views.length - ok.length) + " 条。" };
}
export function serializeSavedViews(views: SavedView[], adminId: string): string {
  return JSON.stringify({ version: SAVED_VERSION, adminId, views: views.slice(0, 20) });
}

/* ---------- 原因与下一步 ---------- */
const NEXT_STEP: Record<string, string> = {
  STAFF_RESTRICTED: "运营复核限制", OWNER_PAUSED: "号主自行恢复", CONFIRMATION_OR_MEDIA_REQUIRED: "号主重新确认规则或补展示图",
  RULE_CHANGED: "号主按新规则重建资料", ACCOUNT_NOT_PUBLISHABLE: "资料重建", CURRENT_VERSION_MISSING: "号主填写资料", PUBLICATION_REQUIRED: "号主重新发布",
  IDENTITY_REQUIRED: "号主完成实名", ADULT_REQUIRED: "号主不满足年龄要求，不能接单", OWNER_UNAVAILABLE: "运营核对号主账号状态",
  GAME_UNAVAILABLE: "运营核对游戏配置", GAME_SERVICE_UNAVAILABLE: "运营核对租赁服务开关", OCCUPIED: "占用解除后重新检查接单资格",
  OCCUPANCY_UNKNOWN: "运营核对占用状态", FUNDING_UNKNOWN: "运营核对押金与包赔申报", PUBLISHER_BAIL_UNCONFIRMED: "运营核对号主保证金",
  HISTORICAL_VERSION: "改看当前版本", PUBLIC_UNKNOWN: "运营核对公开状态", NEW_ORDERS_UNKNOWN: "重新读取后核对",
  RESTRICTION_UNKNOWN: "运营核对限制状态", PAUSE_UNKNOWN: "运营核对号主暂停状态",
};
export const nextStep = (code: string) => NEXT_STEP[code] ?? "运营核对";

/** 列表主原因：服务端 primaryReasonCode 优先，其次已确认阻塞，再次待核。 */
export function primaryReason(f: SupplyFacts): { code: string | null; others: number } {
  const g = groupConditions(f), all = [...g.blocked.map(c => c.code), ...g.pending.map(c => c.code)];
  const code = f.primaryReasonCode && all.includes(f.primaryReasonCode) ? f.primaryReasonCode : all[0] ?? null;
  return { code, others: Math.max(0, all.length - (code ? 1 : 0)) };
}

/** 内部 ID 区分尾号。 */
export const idTail = (id: string) => id.length <= 8 ? id : "…" + id.slice(-6);

/** 紧凑时间：同年 MM-DD HH:mm（Asia/Shanghai），异年 YYYY-MM-DD。 */
export function compactTime(iso: string, now = new Date()): string {
  const d = new Date(iso.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  if (Number.isNaN(d.getTime())) return "时间未提供";
  const p = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const v = (t: string) => p.find(x => x.type === t)?.value ?? "";
  const y = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" }).format(now).replace(/\D/g, "");
  return v("year") === y ? `${v("month")}-${v("day")} ${v("hour")}:${v("minute")}` : `${v("year")}-${v("month")}-${v("day")}`;
}
export const versionText = (seq: string | null | undefined) => seq ? "第" + seq + "版" : "版本未提供";

/** 完整上海时间，用于紧凑时间的 Tooltip；无效时间不编造。 */
export function fullShanghaiTime(iso: string): string {
  const d = new Date(iso.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  if (Number.isNaN(d.getTime())) return "时间未提供";
  const p = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
  const v = (t: string) => p.find(x => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}:${v("second")}`;
}

/* ---------- 列表事实投影（只读正式摘要；缺值即“未提供”，不猜、不补齐、不压成终态） ---------- */

/** 哈夫币精确数量：来自当前资料版本的 inventory 行与目录单位，不按 itemId 名称或标题猜。 */
export function rowHaffText(row: SupplyWorkItem): string {
  const haff = row.summary?.haff;
  return haff ? quantityText(haff.quantity) : "未提供";
}

/** 冻结报价金额：保持接口十进制字符串，不整元舍入，不称会员个性化应付。 */
export function rowQuoteText(row: SupplyWorkItem): { total: string; note: string } {
  const quote = row.summary?.quote;
  if (!quote?.resourceTotal) return { total: "未提供", note: row.summary ? "冻结报价未提供" : "列表摘要未装配" };
  return { total: `¥${formatAmount(quote.resourceTotal.amount)}`, note: quote.personalised ? "该金额标记为个人化口径" : "资料版本冻结报价 · 非下单应付" };
}

/** 号主申报的基础押金；不是租客会员个性化最终应付。摘要未装配时不能说“未申报”。 */
export function rowDepositText(row: SupplyWorkItem): string {
  if (!row.summary) return "摘要未装配";
  const declared = row.summary.baseDeposit;
  return declared ? formatFundingCents(declared.amountCents) : "未申报";
}

/** 保证金要求轴：按当前启用机制投影，并带上依据来源；只有权威写明 NOT_REQUIRED 才称“不要求”。 */
export function rowGuaranteeRequirementText(row: SupplyWorkItem): string {
  if (!row.summary) return "要求未提供（摘要未装配）";
  const { requirement, requirementSource } = row.summary.guarantee;
  if (!requirement) return "要求未提供";
  const basis = requirementSource === "CREDIT_GUARANTEE" ? "信用机制" : requirementSource === "FIXED_FUNDING_POLICY" ? "固定政策" : "依据未提供";
  return requirement.mode === "NOT_REQUIRED" ? `${basis}不要求` : `要求 ${formatFundingCents(requirement.requiredCents)}（${basis}）`;
}

/** 保证金资格轴：沿用权威 gate 的阻塞事实，待核不等于未缴。 */
export function rowGuaranteeEligibilityText(row: SupplyWorkItem): string {
  switch (row.summary?.guarantee.eligibility) {
    case "CONFIRMED": return "资格已确认";
    case "UNCONFIRMED": return "资格待核";
    default: return "资格未提供";
  }
}

/** 保证金凭证记录：只有正式摘要确认没有凭证才说“无凭证记录”；SATISFIED 不等于现金已缴。 */
export function rowGuaranteeProofText(row: SupplyWorkItem): string {
  if (!row.summary) return "凭证事实未提供（摘要未装配）";
  const proof = row.summary.guarantee.recordedProof;
  if (!proof) return "无凭证记录";
  const status = proof.status === "SATISFIED" ? "覆盖达标凭证" : proof.status === "NOT_REQUIRED" ? "不要求凭证" : proof.status === "REVOKED" ? "凭证已撤销" : "状态未识别";
  const coverage = `覆盖 ${formatFundingCents(proof.coveredCents)} / 要求 ${formatFundingCents(proof.requiredCents)}`;
  return `第${proof.versionNo}号凭证 · ${status} · ${coverage}${proof.validUntil ? ` · 有效至 ${compactTime(proof.validUntil)}` : proof.valid === false ? " · 已不在有效期" : ""}（凭证事实，不代表现金到账或退款）`;
}

/** 全额包赔三态：选中、未选、缺记录分开，绝不从标题推断。 */
export function rowFullPayout(row: SupplyWorkItem): { label: string; state: SupplyListSummary["fullPayout"] | "UNASSEMBLED" } {
  const state = row.summary?.fullPayout;
  if (!state) return { label: "未提供", state: "UNASSEMBLED" };
  return { label: state === "SELECTED" ? "已选" : state === "NOT_SELECTED" ? "未选" : "未申报", state };
}

/** 信息来源（服务端字段缺失时留空，不写成自然直发）。 */
export function rowInfoSource(row: SupplyWorkItem): string {
  const source = row.facts.sources[0]?.sourceSystem;
  if (source && !["native", "user_direct", "natural"].includes(source.toLowerCase())) return source;
  return "";
}

/** 业务状态：公开、占用、限制、暂停、新单资格各自独立，UNKNOWN 不压成“已下架”。 */
export function rowListingStatus(row: SupplyWorkItem): { label: string; tone: "success" | "info" | "neutral" | "warning" } {
  const f = row.facts;
  if (f.staffRestricted === true) return { label: "运营限制", tone: "warning" };
  if (f.ownerPaused === true) return { label: "号主暂停", tone: "neutral" };
  if (f.occupancy === "OCCUPIED") return { label: "已出租", tone: "info" };
  if (f.publicVisible === true) return { label: "上架中", tone: "success" };
  if (f.publicVisible === false) return { label: "未公开", tone: "neutral" };
  return { label: "公开状态待核", tone: "neutral" };
}
