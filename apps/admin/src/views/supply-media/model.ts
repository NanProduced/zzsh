import type { MediaAssetReview } from "../../api";

export const STATE_LABELS: Record<MediaAssetReview["reviewState"], string> = {
  PENDING: "待审核",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  QUARANTINED: "已隔离",
};

export const PURPOSE_LABELS: Record<MediaAssetReview["purpose"], string> = {
  GAME_COVER: "游戏封面",
  SKIN_MEDIA: "皮肤图",
  ITEM_MEDIA: "物品图",
  FIREARM_MEDIA: "枪械图",
  ACCOUNT_DISPLAY: "账号展示图",
  ACCOUNT_EVIDENCE: "账号凭证",
};

export const OWNERSHIP_LABELS: Record<MediaAssetReview["ownershipKind"], string> = {
  PLATFORM_CATALOG: "平台目录素材",
  USER_SUPPLY: "用户供给素材",
};

export const VISIBILITY_LABELS: Record<MediaAssetReview["accessClass"], string> = {
  PUBLIC_DISPLAY: "公开配置",
  PRIVATE_REVIEW: "私有",
};

const KNOWN_STATES = new Set(Object.keys(STATE_LABELS));
const KNOWN_PURPOSES = new Set(Object.keys(PURPOSE_LABELS));
const KNOWN_OWNERSHIP = new Set(Object.keys(OWNERSHIP_LABELS));
const CATALOG_PURPOSES = new Set(["GAME_COVER", "SKIN_MEDIA", "ITEM_MEDIA", "FIREARM_MEDIA"]);
const ACCOUNT_PURPOSES = new Set(["ACCOUNT_DISPLAY", "ACCOUNT_EVIDENCE"]);
export const UPLOAD_PURPOSES = ["GAME_COVER", "SKIN_MEDIA", "ITEM_MEDIA", "FIREARM_MEDIA"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const REVIEW_TABS = [
  { key: "pending", label: "待审核" },
  { key: "reviewed", label: "已审核" },
] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number]["key"];
export const REVIEWED_STATES = ["APPROVED", "REJECTED", "QUARANTINED"] as const;
export type ReviewedState = (typeof REVIEWED_STATES)[number];
export type QueueState = "PENDING" | ReviewedState;
export type OwnershipFilter = "PLATFORM_CATALOG" | "USER_SUPPLY";

/** Tabs/子过滤/归属 → 一次真实查询的参数；不合并多状态，不造未登记枚举。 */
export function queueParams(input: {
  state: QueueState;
  ownershipKind: OwnershipFilter;
  cursor?: string;
  limit?: number;
}): { state: string; ownershipKind: string; limit: number; cursor?: string } {
  if (!KNOWN_STATES.has(input.state)) throw new Error(`unknown state ${input.state}`);
  return {
    state: input.state,
    ownershipKind: input.ownershipKind,
    limit: input.limit ?? 20,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

export type MediaAction =
  | { kind: "review"; decision: "APPROVE" | "REJECT" | "QUARANTINE"; label: string; reasonRequired: boolean; effect: string }
  | { kind: "visibility"; visibility: "PUBLIC_DISPLAY" | "PRIVATE_REVIEW"; label: string; effect: string }
  | { kind: "cover"; label: string; effect: string };

export type ActionSet = {
  actions: MediaAction[];
  /** 只读或部分动作时说明原因；未知归属/用途/组合 fail closed。 */
  note: string | null;
  /** ACCOUNT_DISPLAY 免预审：本页不处置，跳来源账号核对。 */
  accountDisplayOnly: boolean;
};

const REVIEW_EFFECTS = {
  APPROVE: "审核通过并保持私有；不会自动公开，公开需另行操作并由服务端校验公开衍生图。",
  REJECT: "驳回素材并保持私有。",
  QUARANTINE: "隔离素材并保持私有。",
} as const;

const UNBIND_NOTE = "本次会转为私有、撤销公开访问并解除目录绑定（游戏封面/皮肤/物品/枪械上的素材关联会被清除，数量未提供）。";

/** 公开素材上的任何审核决定都会经 PRIVATE_REVIEW 转私有并解绑，效果必须如实告知。 */
export function reviewEffect(asset: MediaAssetReview, decision: "APPROVE" | "REJECT" | "QUARANTINE"): string {
  const base = decision === "APPROVE" ? REVIEW_EFFECTS.APPROVE : decision === "REJECT" ? REVIEW_EFFECTS.REJECT : REVIEW_EFFECTS.QUARANTINE;
  return asset.accessClass === "PUBLIC_DISPLAY" ? `${base}${UNBIND_NOTE}` : base;
}

/**
 * 动作由归属+用途+审核状态+权限共同决定；服务端最终校验。
 * 未知归属/用途/不合法组合一律只读，不用宽泛 else 归入可审/可公开。
 */
export function actionsFor(asset: MediaAssetReview, ctx: { canDecide: boolean; canUpload: boolean }): ActionSet {
  const known =
    KNOWN_STATES.has(asset.reviewState) &&
    KNOWN_PURPOSES.has(asset.purpose) &&
    KNOWN_OWNERSHIP.has(asset.ownershipKind) &&
    KNOWN_STATES.has(asset.reviewState) &&
    (asset.accessClass === "PUBLIC_DISPLAY" || asset.accessClass === "PRIVATE_REVIEW");
  if (!known) {
    return { actions: [], note: "素材的归属、用途或状态超出已知范围，仅可查看，不能审核或公开。", accountDisplayOnly: false };
  }
  const catalogMatch = CATALOG_PURPOSES.has(asset.purpose) && asset.ownershipKind === "PLATFORM_CATALOG";
  const accountMatch = ACCOUNT_PURPOSES.has(asset.purpose) && asset.ownershipKind === "USER_SUPPLY";
  if (!catalogMatch && !accountMatch) {
    return { actions: [], note: "素材的归属与用途组合超出已知合同，仅可查看，不能审核或公开。", accountDisplayOnly: false };
  }
  if (asset.purpose === "ACCOUNT_DISPLAY") {
    return {
      actions: [],
      note: "账号展示图免发布前预审，本页不做审核、隔离或公开处置；请在来源账号按图片与版本核对。",
      accountDisplayOnly: true,
    };
  }
  const actions: MediaAction[] = [];
  const evidence = asset.purpose === "ACCOUNT_EVIDENCE";
  if (ctx.canDecide) {
    if (asset.reviewState !== "APPROVED") {
      actions.push({
        kind: "review",
        decision: "APPROVE",
        label: "通过（保持私有）",
        reasonRequired: asset.reviewState !== "PENDING",
        effect: evidence ? "审核通过并保持私有；私有凭证不提供公开选项，通过不等于账号可接单。" : reviewEffect(asset, "APPROVE"),
      });
    }
    if (asset.reviewState !== "REJECTED") {
      actions.push({ kind: "review", decision: "REJECT", label: "驳回", reasonRequired: true, effect: reviewEffect(asset, "REJECT") });
    }
    if (asset.reviewState !== "QUARANTINED") {
      actions.push({ kind: "review", decision: "QUARANTINE", label: "隔离", reasonRequired: true, effect: reviewEffect(asset, "QUARANTINE") });
    }
    if (catalogMatch) {
      if (asset.reviewState === "APPROVED" && asset.accessClass === "PRIVATE_REVIEW") {
        actions.push({
          kind: "visibility",
          visibility: "PUBLIC_DISPLAY",
          label: "转为公开",
          effect: "公开后可被公共展示读取；公开不等于已绑定对象，绑定关系不由公开状态推断。需服务端校验公开衍生图。",
        });
      }
      if (asset.accessClass === "PUBLIC_DISPLAY") {
        actions.push({
          kind: "visibility",
          visibility: "PRIVATE_REVIEW",
          label: "撤销公开",
          effect: "撤销公开会解除目录绑定（游戏封面/皮肤/物品/枪械上的素材关联会被清除）并使旧公开访问失效；绑定数量未提供。",
        });
      }
    }
  }
  // 封面绑定是目录维护权限（supply.catalog.manage），不属于审核决定；服务端再核游戏范围与素材资格。
  if (catalogMatch && ctx.canUpload && asset.purpose === "GAME_COVER" && asset.reviewState === "APPROVED" && asset.accessClass === "PUBLIC_DISPLAY") {
    actions.push({ kind: "cover", label: "设为游戏封面", effect: "该游戏的封面将改用本素材，原封面关联被替换。" });
  }
  return {
    actions,
    note: ctx.canDecide ? null : "当前账号可以查看但不能决定审核；隐藏按钮不是授权，服务端也会拒绝。",
    accountDisplayOnly: false,
  };
}

/** 镜像服务端 reviewMediaAsset 的理由约束；服务端最终校验。 */
export function reviewReasonError(asset: MediaAssetReview, decision: MediaAction extends { kind: "review" } ? never : "APPROVE" | "REJECT" | "QUARANTINE", reason: string): string | null {
  const needsReason = decision !== "APPROVE" || asset.reviewState === "REJECTED" || asset.reviewState === "QUARANTINED";
  if (!needsReason) return null;
  const trimmed = reason.trim();
  if (trimmed.length < 2) return "本次决定必填 2–500 字的具体原因。";
  if (trimmed.length > 500) return "原因不能超过 500 字。";
  return null;
}

export function visibilityReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length < 2 || trimmed.length > 500) return "可见性说明为 2–500 字；不需要说明时留空。";
  return null;
}

/** 人类名称/用途主显；对象名合同未返回时显示真实缺失态。 */
export function objectName(asset: MediaAssetReview, gameNames: Map<string, string>): string {
  if (asset.purpose === "ACCOUNT_DISPLAY" || asset.purpose === "ACCOUNT_EVIDENCE") {
    return asset.accountId ? `账号 ${asset.accountId}` : "来源账号未提供";
  }
  if (asset.purpose === "GAME_COVER") {
    return gameNames.get(asset.gameId) ?? "游戏名未提供";
  }
  return "对象名未提供";
}

const beijing = (value: string): Date | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 列表短时间：同年 MM-DD HH:mm，异年 YYYY-MM-DD HH:mm（Asia/Shanghai）。 */
export function timeShort(value: string | null, now: Date = new Date()): string {
  if (!value) return "时间未提供";
  const date = beijing(value);
  if (!date) return "时间未知";
  const part = (options: Intl.DateTimeFormatOptions) =>
    Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, ...options }).formatToParts(date).map((p) => [p.type, p.value]));
  const d = part({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const nowYear = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric" }).format(now).replace(/\D/g, "");
  const thisYear = String(d.year ?? "").replace(/\D/g, "");
  return thisYear === nowYear
    ? `${d.month}-${d.day} ${d.hour}:${d.minute}`
    : `${thisYear}-${d.month}-${d.day} ${d.hour}:${d.minute}`;
}

/** 悬停/聚焦的完整北京时间。 */
export function timeFull(value: string | null): string {
  if (!value) return "时间未提供";
  const date = beijing(value);
  if (!date) return "时间未知";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${String(p.year ?? "").replace(/\D/g, "")}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} 北京时间`;
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const TECHNICAL_LABELS: Record<string, string> = { UNKNOWN: "尚未完成技术检查", READY: "技术处理就绪", FAILED: "技术处理失败" };
const BINDING_OBJECT_LABELS: Record<string, string> = { game: "游戏封面", skin: "皮肤", billable_item: "物品", firearm: "枪械", listing_version: "账号资料版本" };

/** 技术轴：只报服务端投影；缺字段保持未提供，不由 img.onload 或公开配置推导。 */
export function technicalFact(asset: MediaAssetReview): string {
  if (!asset.technicalState) return "技术状态未提供";
  const label = TECHNICAL_LABELS[asset.technicalState] ?? `技术状态未识别（${asset.technicalState}）`;
  return asset.technicalCheckedAt ? `${label} · 检查于 ${timeShort(asset.technicalCheckedAt)}` : label;
}

/** 绑定轴：只报受权计数，并区分当前有效引用与历史版本引用；无投影不填 0。 */
export function bindingFact(asset: MediaAssetReview): string {
  const binding = asset.binding;
  if (!binding) return "对象绑定未提供";
  if (binding.state !== "KNOWN") return "绑定事实本次不可读";
  const describe = (counts: Record<string, number>) => Object.entries(counts)
    .map(([type, count]) => `${BINDING_OBJECT_LABELS[type] ?? `对象类型 ${type}`} ${count} 处`)
    .join("、");
  const current = describe(binding.current), historical = describe(binding.historical);
  if (!current && !historical) return "当前无有效引用，也无历史版本引用";
  return [current ? `当前有效引用：${current}` : "当前无有效引用", historical ? `历史版本引用：${historical}` : ""].filter(Boolean).join(" · ");
}

/** 素材修订只在合同返回时显示，不暗示所有写已支持版本冲突保护。 */
export function revisionFact(asset: MediaAssetReview): string {
  return asset.revision ? `修订 ${asset.revision}` : "素材修订未提供";
}
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

/** 本地校验只看声明类型与大小；服务端会按真实字节校验，png 通过不代表全部类型可用。 */
export function validateImageFile(file: { name: string; size: number; type: string }): string | null {
  if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(file.type)) return "仅支持 JPEG/PNG/WebP 图片。";
  if (file.size <= 0) return "文件为空，不能上传。";
  if (file.size > MAX_MEDIA_BYTES) return "单文件不能超过 10 MiB。";
  return null;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function shortAssetId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}
