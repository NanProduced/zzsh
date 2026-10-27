/**
 * 账号供给列表/快速查看的纯模型：不依赖 React/DOM。
 * 原则：查找类型以用户选择为准，识别只作建议；待核条件单独计数；
 * 公开、占用、运营限制、号主暂停、新单资格各自读取，不由单一状态推导。
 */
import { formatAmount, formatFundingCents, formatTermDays, historicalResourceText, operationalReasons, quantityText, unitText, type SupplyFacts, type SupplyListSummary, type SupplyQueryKind, type SupplyWorkDetail, type SupplyWorkItem, type SupplyWorkView } from "../supply-review/model.ts";

export const LOGIN_METHOD_OPTIONS = [{ code: "legacy_login_qq", name: "QQ账密" }, { code: "login_qq_qr", name: "QQ扫码" }, { code: "legacy_login_wechat", name: "微信扫码" }, { code: "legacy_login_steam_cn", name: "Steam国服" }, { code: "legacy_login_steam_global", name: "Steam国际服" }];
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

/** 手机号形态只影响用户线索；订单/账号/旧编号是精确业务号，不能因子串像手机号被拒。 */
const PHONE_LOOKUP = /^(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}$/;
export function lookupNeedsDirectory(kind: SupplyQueryKind, raw: string): boolean {
  return (kind === "owner" || kind === "nickname") && PHONE_LOOKUP.test(raw.trim());
}

/** 当前选择与输入明显不符时给出提示文案。 */
export function kindHint(raw: string, kind: SupplyQueryKind): string | null {
  const q = raw.trim();
  if (!q) return null;
  // 精确业务号（编号/旧编号/订单号）不靠输入形态猜类型；用户线索才提示。
  if (kind === "account" || kind === "legacy" || kind === "order") return null;
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
  const codes = operationalReasons(facts.reasons);
  if (facts.staffRestricted && !codes.includes("STAFF_RESTRICTED")) codes.push("STAFF_RESTRICTED");
  if (facts.ownerPaused && !codes.includes("OWNER_PAUSED")) codes.push("OWNER_PAUSED");
  const blocked = codes.filter(c => !PENDING.has(c)).map(code => ({ code, who: whoHandles(code) }));
  const pending = codes.filter(c => PENDING.has(c)).map(code => ({ code, who: nextStep(code) }));
  if (facts.publicVisible === null) pending.push({ code: "PUBLIC_UNKNOWN", who: nextStep("PUBLIC_UNKNOWN") });
  const explainsNewOrders = codes.includes("PUBLISHER_BAIL_UNCONFIRMED");
  if (facts.newOrders === null && !explainsNewOrders) pending.push({ code: "NEW_ORDERS_UNKNOWN", who: nextStep("NEW_ORDERS_UNKNOWN") });
  if (facts.occupancy === "UNKNOWN" && !codes.includes("OCCUPANCY_UNKNOWN")) pending.push({ code: "OCCUPANCY_UNKNOWN", who: nextStep("OCCUPANCY_UNKNOWN") });
  if (typeof facts.staffRestricted !== "boolean") pending.push({ code: "RESTRICTION_UNKNOWN", who: nextStep("RESTRICTION_UNKNOWN") });
  if (typeof facts.ownerPaused !== "boolean") pending.push({ code: "PAUSE_UNKNOWN", who: nextStep("PAUSE_UNKNOWN") });
  const satisfied: string[] = [];
  if (facts.staffRestricted === false) satisfied.push("没有运营限制");
  if (facts.ownerPaused === false) satisfied.push("号主未暂停");
  if (facts.occupancy === "FREE") satisfied.push("未被占用");
  return { blocked, pending, satisfied };
}

export function conditionHeadline(g: ConditionGroups, newOrders?: boolean | null): string {
  if (!g.blocked.length && !g.pending.length) {
    if (newOrders === true) return "接新单条件：当前无阻塞";
    if (newOrders === false) return "接新单条件：存在阻塞，原因未提供";
    return "接新单条件：待核";
  }
  return [g.blocked.length ? g.blocked.length + " 项已确认阻塞" : "", g.pending.length ? g.pending.length + " 项待核" : ""].filter(Boolean).join("、");
}

/** 空原因不是“服务端未返回阻塞”：true/false/null 各自表达确定结果、缺原因与待核。 */
export function newOrdersReasonText(newOrders: boolean | null): string {
  if (newOrders === true) return "当前无接新单阻塞";
  if (newOrders === false) return "不可接新单，原因未提供";
  return "接新单待核";
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
  STAFF_RESTRICTED: "运营复核限制", OWNER_PAUSED: "号主自行恢复", CONFIRMATION_OR_MEDIA_REQUIRED: "核对规则接受或展示图；没查到的部分不要当成已经缺图",
  QUOTE_REQUIRED: "沿用已有草稿继续核价", ACCEPTANCE_REQUIRED: "确认本次报价与条款", MEDIA_REQUIRED: "补齐展示图后再上架",
  RULE_CHANGED: "按新规则重新核价并确认", ACCOUNT_NOT_PUBLISHABLE: "资料不能发布", CURRENT_VERSION_MISSING: "号主填写资料", PUBLICATION_REQUIRED: "确认上架",
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

/** Detail that belongs to another version must not keep the list row's amounts. */
type QuickViewRow = SupplyWorkItem & { depositDeclarationUnknown?: boolean };
export function alignedQuickRow(row: SupplyWorkItem, detail?: SupplyWorkDetail): QuickViewRow {
  const version = detail?.version;
  if (!version || !row.summary?.versionId || version.id === row.summary.versionId) return row;
  const named = [...(version.presentation.items ?? []), ...(version.catalogItems ?? [])];
  const haff = version.declaration.inventory.find(line => named.some(item => item.id === line.itemId && item.unit === "HAFF_BASE"));
  const declared = version.declaration.attributes.full_payout_declaration;
  const selected = declared && typeof declared === "object" && !Array.isArray(declared) && typeof (declared as { selected?: unknown }).selected === "boolean" ? (declared as { selected: boolean }).selected : null;
  const rawDeposit = version.declaration.attributes.owner_deposit_declaration;
  const deposit = rawDeposit && typeof rawDeposit === "object" && !Array.isArray(rawDeposit) ? rawDeposit as Record<string, unknown> : null;
  const amount = deposit?.amountCents;
  const baseDeposit = deposit?.schema === "owner-deposit-declaration-v1" && typeof deposit.declarationVersion === "string" && deposit.declarationVersion.trim() && typeof amount === "string" && amount.length <= 24 && formatFundingCents(amount) !== "未提供" ? { amountCents: amount } : null;
  return { ...row, depositDeclarationUnknown: rawDeposit !== null && !baseDeposit, summary: { ...row.summary, versionId: version.id, haff: haff ? { itemId: haff.itemId, quantity: haff.quantity, unit: "HAFF_BASE" } : null, quote: version.quote?.resourceTotal?.amount ? { currency: null, resourceTotal: { amount: version.quote.resourceTotal.amount, currency: null, unit: null, scale: null }, tenantDeposit: null, tenantPayableTotal: null, frozen: true, personalised: false } : null, baseDeposit, fullPayout: selected === null ? "NOT_DECLARED" : selected ? "SELECTED" : "NOT_SELECTED" } };
}

/** 当前库存优先；缺当前记录才补历史显示量，不把每日消耗当库存。 */
export function rowHaffText(row: SupplyWorkItem): string {
  const haff = row.summary?.haff;
  if (haff) return quantityText(haff.quantity);
  if (row.summary) return "未提供";
  const display = row.facts.historicalRead?.display;
  const historical = display?.state === "KNOWN" && Array.isArray(display.facts?.resources) ? display.facts.resources.find(item => item.unit === "HAFF_BASE") : null;
  return historical ? "历史 " + historicalResourceText(historical) : "未提供";
}

/** 账号第一列中性标题：只用当前展示版本的确定属性，不展示夹带旧号的历史标题。 */
export function rowAccountTitle(row: SupplyWorkItem): string {
  const summary = row.summary;
  if (summary) {
    const parts: string[] = [];
    if (summary.haff) parts.push(quantityText(summary.haff.quantity));
    const safeBox = readableConfigName(summary.config?.safeBox), grading = readableConfigName(summary.config?.grading);
    if (safeBox) parts.push(safeBox);
    if (grading) parts.push(grading + (summary.config?.gradingDivision ? ` ${summary.config.gradingDivision}` : ""));
    if (parts.length) return parts.join(" · ");
  }
  return row.gameName ? `${row.gameName}账号` : "账号资料";
}

/** Raw unmapped codes remain in the full record, not in the daily scan title. */
export function readableConfigName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() && !/^未确认[（(]代码/.test(value) ? value : null;
}

/** 列表基础费用三项：哈夫租金、物资费、租客基础押金；分项缺失不拿合计反推。 */
/** Exact M↔HAFF_BASE conversion: the server compares integer base units. */
export function haffBaseFromM(text: string): { value?: string; error?: string } {
  const value = text.trim();
  if (!value) return { value: "" };
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return { error: "哈夫币应为最多 6 位小数的 M 数" };
  const [whole = "", fraction = ""] = value.split(".");
  return { value: (BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6))).toString() };
}
export function haffMFromBase(base: string): string {
  if (!/^\d+$/.test(base)) return "";
  const amount = BigInt(base), fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${amount / 1_000_000n}.${fraction}` : `${amount / 1_000_000n}`;
}
/** Exact yuan↔cent conversion; deposit declarations are stored in cents. */
export function depositCentsFromYuan(text: string): { value?: string; error?: string } {
  const value = text.trim();
  if (!value) return { value: "" };
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return { error: "基础押金应为最多 2 位小数的元数" };
  const [whole = "", fraction = ""] = value.split(".");
  return { value: (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))).toString() };
}
export function depositYuanFromCents(cents: string): string {
  if (!/^\d+$/.test(cents)) return "";
  const amount = BigInt(cents), whole = amount / 100n, fraction = (amount % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

export function rowBaseFeeRows(row: SupplyWorkItem): { haff: string; materials: string; deposit: string; total: string; note: string } {
  const deposit = rowDepositText(row), fee = row.summary?.feeSummary;
  const total = fee?.resourceTotal ? `¥${formatAmount(fee.resourceTotal.amount)}` : row.summary?.quote?.resourceTotal ? `¥${formatAmount(row.summary.quote.resourceTotal.amount)}` : "未提供";
  if (!row.summary) {
    const historical = row.facts.historicalRead?.historicalQuote;
    if (historical) return {
      haff: `历史 ¥${formatAmount(historical.haffRentYuan)}`,
      materials: `历史 ¥${formatAmount(historical.goodsYuan)}`,
      deposit,
      total: "未提供",
      note: "历史记录，非当前资料",
    };
    return { haff: "摘要未装配", materials: "摘要未装配", deposit, total, note: "资料摘要未装配" };
  }
  if (!fee) return { haff: "分项待核", materials: "分项待核", deposit, total, note: "基础分项未提供" };
  return {
    haff: fee.haffRental ? `¥${formatAmount(fee.haffRental.amount)}` : "分项待核",
    materials: fee.materials ? `¥${formatAmount(fee.materials.amount)}` : "分项待核",
    deposit,
    total,
    note: fee.completeness === "COMPLETE" ? "" : "部分费用明细未提供",
  };
}

export function rowDisplaySourceText(row: SupplyWorkItem): string {
  if (row.summary?.displaySource === "PUBLIC_VERSION") return "对外版";
  if (!row.summary) return row.facts.historicalRead ? "历史资料" : "资料未装配";
  return row.facts.publicVisible === false ? "当前草稿" : row.facts.publicVisible === true ? "对外版" : "当前资料";
}

export function rowVisibleMaterials(row: SupplyWorkItem) {
  return (row.summary?.materials ?? []).filter(item => !(typeof item.quantity === "string" && /^0+$/.test(item.quantity)));
}

/** 列表核心资源：哈夫币与已申报的关键物资；未装配摘要时明确未提供，不拿标题猜。 */
export function rowCoreAssetsText(row: SupplyWorkItem): string {
  const haff = rowHaffText(row), materials = rowVisibleMaterials(row), config = row.summary?.config;
  if (!row.summary) {
    const display = row.facts.historicalRead?.display;
    const facts = display?.state === "KNOWN" ? display.facts : null;
    const historicalConfig = [facts?.attributeDisplay?.safeBox?.displayName, facts?.attributeDisplay?.grading?.displayName].filter(Boolean).join(" · ");
    return `${haff}${historicalConfig ? " · " + historicalConfig : ""} · 物资摘要未装配`;
  }
  if (!row.summary.versionId) return `${haff} · 资料版本未提供`;
  const configText = config ? [config.safeBox, config.characterLevel ? config.characterLevel + " 级" : null, config.grading, config.gradingDivision ? "小段位 " + config.gradingDivision : null].filter(Boolean).join(" · ") : "";
  if (!materials.length) return `${haff}${configText ? " · " + configText : ""} · 本版未申报物资`;
  const shown = materials.slice(0, 3).map(item => `${item.name ?? "名称待核"} ${item.quantity ?? "数量未知"} ${unitText(item.unit, item.code ?? undefined)}`).join("、");
  const total = row.summary.materialsVisibleTotal ?? materials.length;
  return `${haff}${configText ? " · " + configText : ""} · ${shown}${total > 3 ? ` 等 ${total} 项` : ""}`;
}

/** 列表出租条件：租期/日耗、登录方式与包赔申报；保证金要求不属于这里。 */
export function rowRentalTerms(row: SupplyWorkItem): { term: string; daily: string; login: string; payout: string } {
  if (!row.summary) return { term: "租期摘要未装配", daily: "日耗摘要未装配", login: "登录摘要未装配", payout: "未提供" };
  if (!row.summary.versionId) return { term: "资料版本未提供", daily: "资料版本未提供", login: "资料版本未提供", payout: "未提供" };
  const term = row.summary.term, login = row.summary.login;
  return {
    term: term?.termSeconds ? formatTermDays(term.termSeconds) : term?.name ?? "租期未提供",
    daily: term?.dailyConsumption ? quantityText(term.dailyConsumption) : "日耗未提供",
    login: login?.displayName ?? (login?.code ? `未确认（代码 ${login.code}）` : "登录未提供"),
    payout: rowFullPayout(row).label,
  };
}

/** 列表出租条件两行：同版摘要缺失时只说明一次，不把同一占位重复三遍。 */
export function rowTermsLines(row: SupplyWorkItem): { conditions: string; loginPayout: string } {
  const terms = rowRentalTerms(row);
  if (!row.summary) return { conditions: "租期与日耗摘要未装配", loginPayout: "登录与包赔摘要未装配" };
  if (!row.summary.versionId) return { conditions: "资料版本未提供，租期、日耗与登录方式待核对", loginPayout: `包赔 ${terms.payout}` };
  const conditions = [terms.term, terms.daily].filter((value, index, all) => value && all.indexOf(value) === index).join(" · ");
  const login = terms.login.startsWith("登录") ? terms.login : `登录 ${terms.login}`;
  return { conditions, loginPayout: `${login} · 包赔 ${terms.payout}` };
}

/** 当前冻结报价优先，历史租金与物资费分开，均不称下单应付。 */
export function rowQuoteText(row: SupplyWorkItem): { total: string; note: string } {
  const quote = row.summary?.quote;
  const historical = row.facts.historicalRead?.historicalQuote;
  if (!quote?.resourceTotal && historical) return { total: `历史租金 ¥${formatAmount(historical.haffRentYuan)}`, note: `历史物资费 ¥${formatAmount(historical.goodsYuan)} · ${historical.termDays} 天 · 非当前报价` };
  if (!quote?.resourceTotal) return { total: "未提供", note: row.summary ? "冻结报价未提供" : "列表摘要未装配" };
  return { total: `¥${formatAmount(quote.resourceTotal.amount)}`, note: quote.personalised ? "该金额标记为个人化口径" : "资料版本冻结报价 · 非下单应付" };
}

/** 号主申报的基础押金；不是租客会员个性化最终应付。摘要未装配时不能说“未申报”。 */
export function rowDepositText(row: QuickViewRow): string {
  const declared = row.summary?.baseDeposit;
  if (declared) return formatFundingCents(declared.amountCents);
  const historical = row.facts.historicalRead?.historicalQuote;
  if (historical) return `历史 ¥${formatAmount(historical.depositYuan)}`;
  if (!row.summary) return "摘要未装配";
  if (row.depositDeclarationUnknown) return "未提供";
  return "未申报";
}

/** 列表只在保证金构成条件时占位；明确不要求不常驻术语。 */
export function rowGuaranteeCondensed(row: SupplyWorkItem): string | null {
  const text = rowGuaranteeRequirementText(row);
  return text.includes("不要求") ? null : text;
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
  if (f.occupancy === "OCCUPIED") {
    if (f.occupancyKind === "PENDING_PAYMENT") return { label: "待付款预留", tone: "info" };
    if (f.occupancyKind === "RENTED") return { label: "租用中", tone: "info" };
    return { label: "占用中", tone: "info" };
  }
  if (f.newOrders === true) return { label: "可接新单", tone: "success" };
  if (f.publicVisible === true) return { label: f.newOrders === null ? "可查看 · 接单待核" : "可查看", tone: "neutral" };
  if (f.publicVisible === false) return { label: "未公开", tone: "neutral" };
  return { label: "公开状态待核", tone: "neutral" };
}
