import type {
  AdminGunsmithAlias,
  AdminGunsmithClassification,
  AdminGunsmithCode,
  AdminGunsmithFirearm,
} from "../../api";
import type { InlineStatusTone } from "../../components/ui/badge";

export type GunsmithEntity = "classification" | "firearm" | "alias" | "code";

export type PendingGunsmithWrite = { schema: 1; adminId: string; gameId: string; entity: GunsmithEntity; action: string; key: string; path: string; method: "POST" | "PUT"; body: Record<string, unknown>; accepted: boolean };
export const pendingGunsmithKey = (adminId: string) => `zzsh.admin.gunsmith.pending.v1:${adminId}`;

/** 恢复记录只作为阻止新写的依据，从不直接用于重发或决定授权。 */
export function parsePendingGunsmith(raw: string | null, adminId: string): PendingGunsmithWrite | null {
  if (!raw) return null;
  const p: unknown = JSON.parse(raw);
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("改枪码恢复记录损坏，请联系维护者核对原结果。");
  const v = p as PendingGunsmithWrite;
  if (v.schema !== 1 || v.adminId !== adminId || !["classification", "firearm", "alias", "code"].includes(v.entity)
    || typeof v.gameId !== "string" || typeof v.action !== "string" || typeof v.key !== "string" || !/^idem_[A-Za-z0-9_-]+$/.test(v.key)
    || typeof v.path !== "string" || !v.path.startsWith("/supply/") || !["POST", "PUT"].includes(v.method)
    || !v.body || typeof v.body !== "object" || Array.isArray(v.body) || typeof v.accepted !== "boolean") throw new Error("改枪码恢复记录无法识别，请联系维护者核对原结果。");
  return v;
}

export const ENTITY_LABEL: Record<GunsmithEntity, string> = {
  classification: "枪械分类",
  firearm: "枪械",
  alias: "别名",
  code: "改枪码",
};

export const MODE_ITEMS = [
  { value: "", label: "未标注" },
  { value: "HAZARD", label: "烽火地带" },
  { value: "BATTLEFIELD", label: "全面战场" },
  { value: "GENERAL", label: "通用" },
];

export const MODE_LABEL: Record<string, string> = {
  HAZARD: "烽火地带",
  BATTLEFIELD: "全面战场",
  GENERAL: "通用",
};

export const CODE_STATUS_LABEL: Record<AdminGunsmithCode["status"], string> = {
  ACTIVE: "已收录",
  WITHDRAWN: "已撤回",
};

// 语气由领域给出：已收录表示当前有效，不是成功；撤回是终态中性记录。
export const CODE_STATUS_TONE: Record<AdminGunsmithCode["status"], InlineStatusTone> = {
  ACTIVE: "info",
  WITHDRAWN: "neutral",
};

export const ENTITY_PURPOSE: Record<GunsmithEntity, string> = {
  classification: "按武器类型组织枪械；分类可排序与停用，停用不改变历史引用。",
  firearm: "枪械是共享稳定实体：改枪码与皮肤目录都按 firearm ID 引用它，改名不换身份。",
  alias: "别名用于检索与玩家俗称，不参与匹配定价，也不替代稳定 code。",
  code: "改枪码原文按玩家复制的样子原样保存；平台不解析、不验证游戏导入结果。",
};

export const ENTITY_DISABLE_NOTE: Record<GunsmithEntity, string> = {
  classification: "停用状态随枪械目录投影；下游过滤行为影响范围未提供。历史引用保留，不能物理删除。",
  firearm: "停用后新选择不再列出该枪械；已挂接的别名与改枪码保留。引用影响范围未提供，不能物理删除。",
  alias: "停用别名不再参与检索提示；历史引用保留，不能物理删除。",
  code: "撤回只把方案标为已撤回，原文与复核记录保留；不提供删除，也不声称全库失效。",
};

export const EMPTY_HINT: Record<GunsmithEntity, string> = {
  classification: "创建第一个分类后，枪械才能按武器类型归组。",
  firearm: "改枪码不能脱离枪械存在；先建枪械（或直接建在未分类）。",
  alias: "给这把枪加玩家常用叫法，便于在已加载范围内检索。",
  code: "为这把枪录入第一条改枪码：原文按玩家复制的样子保存，并标注适用模式。",
};

export const CODE_MIN_LENGTH = 4;

export function modeLabel(mode: AdminGunsmithCode["modeCode"]): string {
  return mode ? MODE_LABEL[mode] ?? String(mode) : "未标注";
}

export function reviewedLabel(code: AdminGunsmithCode): string {
  return code.lastReviewedAt ? code.lastReviewedAt : "未核验";
}

export function firearmsOfClassification(firearms: AdminGunsmithFirearm[], classificationId: string | null): AdminGunsmithFirearm[] {
  return firearms.filter((firearm) => (classificationId ? firearm.classificationId === classificationId : !firearm.classificationId));
}

export function aliasCount(aliases: AdminGunsmithAlias[], firearmId: string): number {
  return aliases.filter((alias) => alias.firearmId === firearmId).length;
}

export function codeCount(codes: AdminGunsmithCode[], firearmId: string): number {
  return codes.filter((code) => code.firearmId === firearmId).length;
}

export function activeCodeCount(codes: AdminGunsmithCode[], firearmId: string): number {
  return codes.filter((code) => code.firearmId === firearmId && code.status === "ACTIVE").length;
}

/** 搜索只覆盖已加载数据：枪械名、别名命中即保留该枪械。 */
export function firearmMatchesQuery(firearm: AdminGunsmithFirearm, aliases: AdminGunsmithAlias[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (firearm.name.toLowerCase().includes(needle) || firearm.code.toLowerCase().includes(needle)) return true;
  return aliases.some((alias) => alias.firearmId === firearm.id && alias.name.toLowerCase().includes(needle));
}

export function codeMatchesQuery(code: AdminGunsmithCode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return code.code.toLowerCase().includes(needle) || (code.note ?? "").toLowerCase().includes(needle);
}

/** 模式和状态过滤仍只作用于服务端已经返回的方案。 */
export function codeMatchesFilters(code: AdminGunsmithCode, query: string, mode: string, status: string): boolean {
  return codeMatchesQuery(code, query)
    && (mode === "all" || (mode === "unmarked" ? code.modeCode === null : code.modeCode === mode))
    && (status === "all" || code.status === status);
}

export function reviewTimeInput(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16);
}

export function reviewTimeUtc(value: string, original?: string | null): string | null {
  if (!value) return null;
  if (original && reviewTimeInput(original) === value) return original;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("请填写有效的北京时间。");
  const date = new Date(value + ":00+08:00");
  if (Number.isNaN(date.getTime()) || reviewTimeInput(date.toISOString()) !== value) throw new Error("请填写有效的北京时间。");
  return date.toISOString();
}

export function firearmContext(firearm: AdminGunsmithFirearm | null, classifications: AdminGunsmithClassification[]): string {
  if (!firearm) return "未选择枪械";
  const classification = classifications.find((entry) => entry.id === firearm.classificationId);
  return `${firearm.name}（${firearm.code}）${classification ? ` · ${classification.name}` : " · 未分类"}${firearm.enabled ? "" : " · 枪械已停用"}`;
}

export function newCodeDisabledReason(firearm: AdminGunsmithFirearm | null): string | undefined {
  if (!firearm) return "请先在左侧选择一把枪械；改枪码必须挂在稳定 firearm ID 上。";
  if (!firearm.enabled) return `枪械「${firearm.name}」已停用，先启用枪械或改选其他枪械后再新增改枪码。`;
  return undefined;
}

export function writePhaseLabel(phase: "idle" | "saving" | "unknown"): string {
  if (phase === "saving") return "正在提交…";
  if (phase === "unknown") return "结果尚未确认";
  return "";
}

export type FirearmGroup = { classification: AdminGunsmithClassification | null; firearms: AdminGunsmithFirearm[] };

/**
 * API C：原结果读取目标由恢复记录已有的 entity + method + path 推导，不改已存结构，
 * 旧待核记录同样可核对；创建类没有 resourceId。
 */
export function gunsmithRecoveryTarget(record: Pick<PendingGunsmithWrite, "entity" | "method" | "path">): { operation: string; resourceId?: string } | null {
  const status = /\/gunsmith\/codes\/([^/]+)\/(withdraw|restore)$/.exec(record.path);
  if (status) return { operation: `supply.gunsmith.code.${status[2]}`, resourceId: status[1] };
  const update = /\/(firearm-classifications|firearms|firearm-aliases|codes)\/([^/]+)$/.exec(record.path);
  if (record.method === "PUT" && update) return { operation: `supply.gunsmith.${record.entity}.update`, resourceId: update[2] };
  if (record.method === "POST") return { operation: `supply.gunsmith.${record.entity}.create` };
  return null;
}

/**
 * F6：全部 / 有方案 / 待录入 必须同范围。三个计数都来自传入的（已按查找过滤的）
 * groups，待录入是同范围差值，不用全目录分母减过滤后的命中数。
 */
export function schemeCounts(groups: FirearmGroup[], hasCodes: (firearm: AdminGunsmithFirearm) => boolean) {
  let total = 0, withCodes = 0;
  for (const group of groups) for (const firearm of group.firearms) {
    total++;
    if (hasCodes(firearm)) withCodes++;
  }
  return { total, withCodes, withoutCodes: total - withCodes };
}

/** 左栏武器导航：按分类分组，未分类单独成组；分类顺序沿用接口返回。 */
export function groupFirearms(
  classifications: AdminGunsmithClassification[],
  firearms: AdminGunsmithFirearm[],
): FirearmGroup[] {
  const groups: FirearmGroup[] = classifications.map((classification) => ({
    classification,
    firearms: firearms.filter((firearm) => firearm.classificationId === classification.id),
  }));
  const unclassified = firearms.filter((firearm) => !firearm.classificationId || !classifications.some((entry) => entry.id === firearm.classificationId));
  if (unclassified.length > 0) groups.push({ classification: null, firearms: unclassified });
  return groups.filter((group) => group.firearms.length > 0);
}
