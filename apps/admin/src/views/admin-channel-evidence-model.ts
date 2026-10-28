/** 渠道证据读取的显示状态：未授权、未接入、未找到、未知、截断分开呈现，金额缺失不补 0。 */
export type ChannelEvidenceDisplay = { kind: "unauthorized" | "not-integrated" | "not-found" | "unknown" | "truncated" | "ready"; text: string };
export function channelEvidenceErrorDisplay(status: number | undefined): ChannelEvidenceDisplay {
  if (status === 403) return { kind: "unauthorized", text: "当前账号无权读取该渠道证据；不能据此认定没有记录" };
  if (status === 503) return { kind: "not-integrated", text: "渠道证据读取未接入或范围未配置；不能据此认定没有记录" };
  if (status === 404) return { kind: "not-found", text: "未在可读范围内找到该对象（可能不存在或不在授权范围）" };
  return { kind: "unknown", text: "渠道证据读取失败，结果未知；请稍后重试" };
}
const STATUS_TEXT: Record<string, string> = { AVAILABLE: "已取得本地登记证据", INTEGRATED: "已取得本地登记证据", FOUND: "已找到本地登记记录",
  NOT_FOUND_LOCAL: "本地未登记（不代表渠道无记录）", NOT_INTEGRATED: "该来源未接入渠道证据", NOT_APPLICABLE: "旧来源不适用本平台渠道证据，按原来源核对",
  FORBIDDEN: "无财务权限，金额未显示", UNAVAILABLE: "证据暂不可用，结果未知", AMBIGUOUS: "命中多个候选，需逐一核对" };
export function channelEvidenceStatusDisplay(section: { status?: string; coverage?: string; truncated?: boolean } | null | undefined): ChannelEvidenceDisplay {
  if (!section || typeof section.status !== "string") return { kind: "unknown", text: "未取得证据，结果未知" };
  if (section.truncated === true || section.coverage === "TRUNCATED") return { kind: "truncated", text: "记录超出读取上限已截断；合计不完整，不显示汇总" };
  if (section.status === "NOT_INTEGRATED" || section.status === "NOT_APPLICABLE") return { kind: "not-integrated", text: STATUS_TEXT[section.status]! };
  if (section.status === "FORBIDDEN") return { kind: "unauthorized", text: STATUS_TEXT.FORBIDDEN! };
  if (section.status === "UNAVAILABLE") return { kind: "unknown", text: STATUS_TEXT.UNAVAILABLE! };
  if (section.status === "NOT_FOUND_LOCAL") return { kind: "not-found", text: STATUS_TEXT.NOT_FOUND_LOCAL! };
  if (!["AVAILABLE", "INTEGRATED", "FOUND"].includes(section.status)) return { kind: "unknown", text: STATUS_TEXT[section.status] ?? "状态待核" };
  return { kind: "ready", text: STATUS_TEXT[section.status]! };
}
/** 金额只在服务端给出精确分值时显示；null/缺失显示“未知”，不补 0。 */
export function evidenceCents(value: unknown): string | null {
  const cents = value && typeof value === "object" ? (value as { cents?: unknown }).cents : value;
  return typeof cents === "string" && /^(0|[1-9][0-9]{0,23})$/.test(cents) ? cents : null;
}
const LEGACY = /legacy|旧/i;
/** 来源族显示：先给人能读的来源归属，原始标识只作追溯。 */
export function sourceFamilyText(source: { sourceType?: string | null; sourceSystem?: string | null; sourceEntity?: string | null } | null | undefined): string {
  if (!source) return "未取得";
  const raw = [source.sourceType, source.sourceSystem, source.sourceEntity].filter(Boolean).join("/");
  if (!raw) return "未取得";
  const owner = LEGACY.test(`${source.sourceSystem ?? ""} ${source.sourceType ?? ""}`) ? "旧平台迁移来源"
    : /^zzsh$/i.test(source.sourceSystem ?? "") || source.sourceType === "NATIVE" ? "本平台来源" : "来源未核定";
  return `${owner}（原标识 ${raw}）`;
}
