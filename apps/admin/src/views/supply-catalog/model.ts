import type {
  AdminCatalogResponse,
  CatalogSkin,
  CatalogSkinOwner,
  SupplyGame,
} from "../../api";

export type CatalogKind = "items" | "categories" | "skins" | "rarities" | "entitlements" | "skin-owners";

export function preferredCatalogGame(games: SupplyGame[], current: string, preferDelta: boolean): string {
  if (games.some(game => game.id === current)) return current;
  return preferDelta ? games.find(game => game.enabled && game.code === "delta")?.id ?? games.find(game => game.enabled)?.id ?? games[0]?.id ?? "" : games[0]?.id ?? "";
}

export const OBJECT_ORDER: CatalogKind[] = ["items", "categories", "skins", "skin-owners", "rarities", "entitlements"];

export const OBJECT_LABEL: Record<CatalogKind, string> = {
  items: "计费物品",
  categories: "皮肤分类",
  skins: "皮肤",
  "skin-owners": "所属对象",
  rarities: "品质",
  entitlements: "账号权益",
};

export const OBJECT_PURPOSE: Record<CatalogKind, string> = {
  items: "报价资源定义：计价单位与数量精度来自这里；发布表单按该物品自身的必填配置校验。",
  categories: "发布表单皮肤选择的分组树；表单展示开关决定该分类是否出现在发布表单。",
  skins: "维护可选外观及其身份、归属和展示信息；此处不直接维护价格。",
  "skin-owners": "维护皮肤所属干员；枪械归属复用枪械目录。三角洲近战外观独立维护，不需要所属对象。",
  rarities: "维护展示使用的受控词表；不按俗称自动推导价格或押金分组。",
  entitlements: "账号属性的类型词表；值类型与有效类型供账号供给与展示读取。",
};

export const OBJECT_DISABLE_NOTE: Record<CatalogKind, string> = {
  items: "停用状态随目录投影给发布与报价读取；下游是否仍可选由对应合同决定，影响范围未提供。历史引用保留，不能物理删除。",
  categories: "停用状态随目录投影给发布表单分组读取；下游过滤行为影响范围未提供。历史引用保留，不能物理删除。",
  skins: "停用状态随目录投影给发布表单可选外观读取；下游过滤行为影响范围未提供。历史引用保留，不能物理删除。",
  "skin-owners": "停用状态随目录投影给皮肤归属选择读取；已挂接皮肤的历史归属保留。影响范围未提供，不能物理删除。",
  rarities: "停用状态随目录投影给皮肤展示档位读取；已标注皮肤的历史档位保留。影响范围未提供，不能物理删除。",
  entitlements: "停用状态随目录投影给账号属性读取；历史账号属性保留。影响范围未提供，不能物理删除。",
};

export const OBJECT_EMPTY_HINT: Record<CatalogKind, string> = {
  items: "创建第一个计费物品后，规则与价目才能按物品定价。",
  categories: "创建第一个分类后，皮肤才有可挂接的分组。",
  skins: "皮肤需要先有至少一个皮肤分类；创建后为停用待核草稿，身份确认与启用是独立动作。",
  "skin-owners": "创建所属干员后，干员皮肤可挂接归属；枪械归属复用枪械目录，三角洲近战外观无需所属对象。",
  rarities: "创建受控品质词表后，皮肤可按明确的官方或平台来源标注品质；停用的品质不能再新选。",
  entitlements: "创建权益词表后，账号属性才有可读取的类型。",
};

export const IDENTITY_FILTER_ITEMS = [
  { value: "all", label: "全部" },
  { value: "PENDING", label: "待核实" },
  { value: "VERIFIED", label: "已核实" },
  { value: "LEGACY", label: "旧源未核实" },
];
export type IdentityFilter = "all" | "PENDING" | "VERIFIED" | "LEGACY";

export const IDENTITY_LABEL: Record<CatalogSkin["namingState"], string> = {
  LEGACY: "旧源未核实",
  PENDING: "待核实",
  VERIFIED: "已核实",
};

export type CatalogRow = Record<string, unknown> & { id: string };
export type CatalogFirearmOwner = NonNullable<AdminCatalogResponse["firearmOwners"]>[number];
export type CatalogWriteKind = CatalogKind | "games";
export type PendingCatalogWrite = { schema: 1; adminId: string; gameId: string; kind: CatalogWriteKind; id?: string; path: string; method: "POST" | "PUT"; body: Record<string, unknown>; key: string; fingerprint: string; expectedCode?: string; accepted: boolean; createdGameId?: string };
export const pendingCatalogKey = (adminId: string) => `zzsh.admin.catalog.pending.v1:${adminId}`;
export const catalogOperation = (pending: Pick<PendingCatalogWrite, "kind" | "id">) => pending.kind === "games" ? "supply.game.create" : `supply.catalog.${pending.kind.replaceAll("-", "_")}.${pending.id ? "update" : "create"}`;
export const catalogResource = (pending: Pick<PendingCatalogWrite, "kind" | "id" | "gameId">) => pending.kind === "games" ? undefined : pending.id ?? pending.gameId;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** 本地命令只锁定新写；恢复先核服务端原回执，不从本地记录自动重发。 */
export function parsePendingCatalog(raw: string | null, adminId: string): PendingCatalogWrite | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("目录恢复记录损坏，请联系维护者核对原回执。");
  const pending = value as PendingCatalogWrite;
  if (pending.schema !== 1 || pending.adminId !== adminId || !(pending.kind === "games" || OBJECT_ORDER.includes(pending.kind)) || (!safeId(pending.gameId) && !(pending.gameId === "" && pending.kind === "games"))
    || (pending.id !== undefined && !safeId(pending.id)) || !/^idem_[A-Za-z0-9_-]+$/.test(pending.key) || !/^[0-9a-f]{64}$/.test(pending.fingerprint)
    || (pending.kind === "games" && pending.id !== undefined) || pending.method !== (pending.id ? "PUT" : "POST") || pending.path !== (pending.kind === "games" ? "/supply/games" : pending.id ? `/supply/${pending.kind}/${pending.id}` : `/supply/games/${pending.gameId}/${pending.kind}`)
    || !pending.body || typeof pending.body !== "object" || Array.isArray(pending.body) || typeof pending.accepted !== "boolean"
    || (pending.expectedCode !== undefined && typeof pending.expectedCode !== "string") || (pending.createdGameId !== undefined && (pending.kind !== "games" || !safeId(pending.createdGameId)))) throw new Error("目录恢复记录无法识别，请联系维护者核对原回执。");
  return pending;
}

export async function catalogFingerprint(pending: Pick<PendingCatalogWrite, "kind" | "id" | "gameId" | "body">): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([catalogOperation(pending), catalogResource(pending) ?? null, pending.body]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
}

export function catalogFirearmOwners(catalog: AdminCatalogResponse | null): CatalogFirearmOwner[] | null {
  const entries = catalog?.firearmOwners;
  return Array.isArray(entries) && entries.every(entry => entry && typeof entry.id === "string" && entry.id.length > 0 && typeof entry.code === "string" && typeof entry.name === "string" && typeof entry.enabled === "boolean") ? entries : null;
}

export const UNIT_LABEL: Record<string, string> = { HAFF_BASE: "哈夫币基础单位", ROUND: "发", PIECE: "件", DAY: "天" };
export const VALUE_KIND_LABEL: Record<string, string> = { FLAG: "是否拥有", LEVEL: "等级", CAPACITY: "容量" };
export const EXPIRY_KIND_LABEL: Record<string, string> = { PERMANENT: "永久", TIMED: "限时" };

export function objectRows(catalog: AdminCatalogResponse | null, kind: CatalogKind): CatalogRow[] {
  if (!catalog) return [];
  if (kind === "items") return catalog.items as CatalogRow[];
  if (kind === "categories") return catalog.categories as CatalogRow[];
  if (kind === "skins") return catalog.skins as CatalogRow[];
  if (kind === "skin-owners") return (catalog.owners ?? []).filter(owner => catalog.game.code !== "delta" || owner.kind === "AGENT") as CatalogRow[];
  if (kind === "rarities") return catalog.rarities as CatalogRow[];
  return catalog.entitlements as CatalogRow[];
}

export function pendingIdentityCount(catalog: AdminCatalogResponse | null): number {
  if (!catalog) return 0;
  return catalog.skins.filter((skin) => skin.namingState === "PENDING").length;
}

export function matchesQuery(row: CatalogRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
  const code = typeof row.code === "string" ? row.code.toLowerCase() : "";
  const aliases = Array.isArray(row.aliases) ? row.aliases.map((entry) => String(entry).toLowerCase()) : [];
  return name.includes(needle) || code.includes(needle) || aliases.some((alias) => alias.includes(needle));
}

export function applyIdentityFilter(rows: CatalogRow[], filter: IdentityFilter): CatalogRow[] {
  if (filter === "all") return rows;
  return rows.filter((row) => row.namingState === filter);
}

export function categoryPath(categoryId: string | null | undefined, categories: Array<{ id: string; name: string; parentId: string | null }>): string {
  if (!categoryId) return "一级分类";
  const parts: string[] = [];
  let current = categories.find((entry) => entry.id === categoryId);
  // ponytail: depth cap 8, catalog trees are shallow; a cycle would otherwise loop
  for (let depth = 0; current && depth < 8; depth += 1) {
    parts.unshift(current.name);
    current = current.parentId ? categories.find((entry) => entry.id === current!.parentId) : undefined;
  }
  return parts.join(" / ") || "一级分类";
}

export function ownerText(
  ownerRef: CatalogSkin["ownerRef"],
  owners: CatalogSkinOwner[],
  firearms: CatalogFirearmOwner[] | null,
): string {
  if (!ownerRef) return "未挂接归属";
  if (ownerRef.kind === "FIREARM") {
    const firearm = firearms?.find((entry) => entry.id === ownerRef.id);
    if (firearm) return `${firearm.name}（枪械）${firearm.enabled ? "" : " · 已停用"}`;
    return firearms ? "枪械归属未在当前目录中" : "枪械归属未接入";
  }
  const owner = owners.find((entry) => entry.id === ownerRef.id);
  if (!owner) return `${ownerRef.kind === "AGENT" ? "干员" : "近战"}归属未提供`;
  return `${owner.name}（${ownerRef.kind === "AGENT" ? "干员" : "近战"}）${owner.enabled ? "" : " · 已停用"}`;
}

export const skinOwnerKind = (skin: Pick<CatalogSkin, "ownerKind" | "ownerRef">) => skin.ownerKind ?? skin.ownerRef?.kind ?? null;
export function skinIsSelectable(skin: CatalogSkin, catalog: AdminCatalogResponse): boolean {
  if (!catalog.game.enabled || !skin.enabled || !skin.formVisible || skin.namingState !== "VERIFIED") return false;
  const seen = new Set<string>();
  let categoryId: string | null = skin.categoryId;
  while (categoryId !== null) {
    if (seen.has(categoryId)) return false;
    seen.add(categoryId);
    const category = catalog.categories.find(row => row.id === categoryId);
    if (!category?.enabled || !category.formVisible) return false;
    categoryId = category.parentId;
  }
  return true;
}
export function skinRarityBasisText(skin: CatalogSkin): string {
  return skin.rarityEvidence?.basis === "OFFICIAL" ? "官方已核" : skin.rarityEvidence?.basis === "PLATFORM_REFERENCE" ? "平台参考" : "品质依据待补";
}

export function skinNextSteps(skin: CatalogSkin): string[] {
  const steps: string[] = [];
  if (skin.namingState !== "VERIFIED") steps.push("身份待核实：对照身份依据确认后转为已核实");
  if (skin.rarityCode && !skin.rarityEvidence) steps.push("品质依据待补：与身份核实分开维护");
  if (skin.namingState === "VERIFIED" && !skin.enabled) steps.push("已核实但未启用：可单独启用");
  if (!skin.mediaId) steps.push("未绑定图片：绑图不是启用前置，仅影响公开投影");
  if (!skin.formVisible) steps.push("发布表单隐藏中");
  return steps;
}

export const COLUMN_SETS: Record<CatalogKind, Array<{ key: string; label: string }>> = {
  items: [
    { key: "media", label: "图片" },
    { key: "unit", label: "单位" },
    { key: "quantityScale", label: "数量精度" },
    { key: "required", label: "必填配置" },
    { key: "sortOrder", label: "排序" },
    { key: "enabled", label: "状态" },
  ],
  categories: [
    { key: "parentPath", label: "父分类" },
    { key: "sortOrder", label: "排序" },
    { key: "enabled", label: "状态" },
    { key: "formVisible", label: "表单展示" },
  ],
  skins: [
    { key: "media", label: "图片" },
    { key: "ownerRef", label: "类型与所属" },
    { key: "namingState", label: "身份状态" },
    { key: "categoryPath", label: "分类" },
    { key: "rarityCode", label: "品质" },
    { key: "appearance", label: "外观属性" },
    { key: "enabled", label: "状态" },
    { key: "formVisible", label: "表单展示" },
  ],
  "skin-owners": [
    { key: "kind", label: "类型" },
    { key: "enabled", label: "状态" },
  ],
  rarities: [
    { key: "sortOrder", label: "排序" },
    { key: "enabled", label: "状态" },
  ],
  entitlements: [
    { key: "valueKind", label: "值类型" },
    { key: "expiryKind", label: "有效类型" },
    { key: "sortOrder", label: "排序" },
    { key: "enabled", label: "状态" },
  ],
};
