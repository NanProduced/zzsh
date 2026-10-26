import { beijingCalendarDate } from "../workspace/beijing-time.ts";
import type { AdminCatalogResponse, CatalogRarity, CatalogSkin, CatalogSkinOwner } from "../api";

export const skinStates = { LEGACY: "旧词条（LEGACY）", PENDING: "待核草稿（PENDING）", VERIFIED: "身份已核（VERIFIED）" };
export const ownerKinds = { AGENT: "干员", MELEE_TYPE: "近战外观", FIREARM: "枪械" };
export const rarityBases = { PLATFORM_REFERENCE: "平台参考", OFFICIAL: "官方已核" };
export const defaultStates = { UNKNOWN: "默认属性待核", DEFAULT: "默认外观", NON_DEFAULT: "非默认外观" };
export const SKIN_SOURCE_NAME_MAX_LENGTH = 100;
const edge = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;
const clean = (value: string) => value.replace(edge, "");
function text(value: string | undefined, label: string, max: number, trim = true) {
  const raw = value ?? "", result = trim ? clean(raw) : raw;
  if (!clean(raw) || [...result].length > max) throw new Error(`${label}不能为空且最多${max}个字符。`);
  return result;
}
function lines(value: string | undefined) { return (value ?? "").split(/\r?\n/).map(clean).filter(Boolean); }

export function skinContractReady(catalog: AdminCatalogResponse | null): boolean {
  return Boolean(catalog && /^[1-9]\d*$/.test(catalog.game.catalogRevision) && Array.isArray(catalog.owners) &&
    catalog.owners.every(o => o && typeof o.id === "string" && ["AGENT", "MELEE_TYPE"].includes(o.kind) && typeof o.name === "string" && typeof o.enabled === "boolean") &&
    Array.isArray(catalog.skins) && catalog.skins.every(s => s && typeof s.id === "string" && typeof s.code === "string" && typeof s.name === "string" && typeof s.enabled === "boolean" && typeof s.formVisible === "boolean" && (s.sourceField === null || typeof s.sourceField === "string") && (s.sourceToken === null || typeof s.sourceToken === "string") && ["LEGACY", "PENDING", "VERIFIED"].includes(s.namingState) &&
      Array.isArray(s.aliases) && s.aliases.every(a => typeof a === "string") &&
      (s.baseName === null || typeof s.baseName === "string") && (s.sourceNamespace === null || typeof s.sourceNamespace === "string") &&
      (s.ownerRef === null || (s.ownerRef && ["AGENT", "MELEE_TYPE", "FIREARM"].includes(s.ownerRef.kind) && typeof s.ownerRef.id === "string")) &&
      (s.mediaId === null || typeof s.mediaId === "string")));
}

/**
 * Quality choices for creating or editing a skin, matching the server guard:
 * only enabled entries can be newly selected. A disabled entry is listed only
 * when it is this skin's current binding, so an unrelated edit keeps it as-is.
 */
export function rarityOptions(rarities: readonly CatalogRarity[], currentCode: string | null | undefined): Array<{ value: string; label: string }> {
  const items = [{ value: "", label: "品质未知（不默认）" }];
  for (const rarity of rarities) {
    if (rarity.enabled) items.push({ value: rarity.code, label: rarity.name });
    else if (currentCode && rarity.code === currentCode) items.push({ value: rarity.code, label: `${rarity.name}（已停用，仅保留现有绑定）` });
  }
  return items;
}

export function skinValues(skin?: CatalogSkin): Record<string, string> {
  const today = beijingCalendarDate();
  return { aliases: skin?.aliases?.join("\n") ?? "", sourceNamespace: skin?.sourceNamespace ?? "", sourceField: skin?.sourceField ?? "", sourceToken: skin?.sourceToken ?? "",
    mediaId: skin?.mediaId ?? "", changeSource: "false", ownerKind: skin?.ownerKind ?? skin?.ownerRef?.kind ?? "AGENT", ownerId: skin?.ownerRef?.id ?? "", baseName: skin?.baseName ?? "", reason: "", evidenceUrls: "", observedAt: today, region: "中国大陆", note: "",
    defaultState: skin?.defaultState ?? "UNKNOWN", isCollectible: skin?.isCollectible == null ? "unknown" : String(skin.isCollectible),
    changeRarityEvidence: "false", rarityBasis: skin?.rarityEvidence?.basis ?? "", raritySourceName: skin?.rarityEvidence?.sourceName ?? "", rarityEvidenceUrls: skin?.rarityEvidence?.references.map(ref => ref.url).join("\n") ?? "", rarityObservedAt: today, rarityNote: "",
    changeMediaSource: "false", mediaSourceKind: skin?.mediaSource?.kind ?? "MODEL_IMAGE", mediaSourceName: skin?.mediaSource?.sourceName ?? "", mediaSourceUrl: skin?.mediaSource?.url ?? "" };
}

export function evidenceFields(values: Record<string, string>) {
  const urls = lines(values.evidenceUrls);
  if (urls.length < 1 || urls.length > 8) throw new Error("请填写1至8条证据链接，每行一条。");
  const observedAt = values.observedAt || beijingCalendarDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString().slice(0, 10) !== observedAt) throw new Error("请填写有效的证据核对日期。");
  const region = text(values.region || "中国大陆", "适用地区", 64), note = text(values.note, "证据说明", 500);
  const evidenceRefs = urls.map(raw => {
    const url = text(raw, "证据链接", 2000);
    let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("证据链接须为公开HTTPS地址。"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("证据链接须为不含登录信息的公开HTTPS地址。");
    return { url, observedAt, region, note };
  });
  return { reason: text(values.reason, "原因", 500), evidenceRefs };
}

export function skinDisplayNameChanged(values: Record<string, string>, original?: CatalogSkin): boolean {
  return original?.namingState === "VERIFIED" && values.baseName !== undefined && clean(values.baseName) !== (original.baseName ?? "");
}

export function skinPayload(values: Record<string, string>, revision: string, original?: CatalogSkin, confirm = false, gameCode?: string): Record<string, unknown> {
  if (!/^[1-9]\d*$/.test(revision)) throw new Error("目录版本未就绪，请重新读取目录。");
  const body: Record<string, unknown> = { expectedCatalogRevision: revision };
  const aliases = lines(values.aliases).map(v => text(v, "别名", 200));
  if (aliases.length > 32 || new Set(aliases).size !== aliases.length) throw new Error("别名最多32项且不能重复，请每行填写一项。");
  if (!original || JSON.stringify(aliases) !== JSON.stringify(original.aliases)) body.aliases = aliases;
  if (original && values.mediaId !== String(original.mediaId ?? "")) {
    body.mediaId = values.mediaId === "" ? null : text(values.mediaId, "图片素材", 128);
    if (original.mediaSource && values.changeMediaSource !== "true") body.mediaSource = null;
  }
  if (!original) {
    body.code = values.code; body.name = text(values.name, "名称", 120);
    if (gameCode !== "delta") body.categoryId = text(values.categoryId, "分类", 128);
    body.rarityCode = values.rarityCode || null; body.enabled = false; body.formVisible = false;
    body.sortOrder = Number(values.sortOrder || "0");
  } else if (!confirm) {
    if (original.namingState !== "VERIFIED" && values.name !== original.name) { body.name = text(values.name, "名称", 120); body.reason = text(values.reason, "改名原因", 500); }
    for (const field of ["categoryId", "rarityCode", "sortOrder", "enabled", "formVisible"] as const) {
      const value = field === "sortOrder" ? Number(values[field]) : field === "enabled" || field === "formVisible" ? values[field] === "true" : field === "rarityCode" ? values[field] || null : values[field];
      if (field !== "categoryId" || gameCode !== "delta") if (value !== original[field]) body[field] = value;
    }
  }
  if ("sortOrder" in body && (!Number.isInteger(body.sortOrder) || Math.abs(body.sortOrder as number) > 100000)) throw new Error("排序须为-100000至100000的整数。");
  if (!confirm) {
    if (!Object.hasOwn(defaultStates, values.defaultState ?? "")) throw new Error("请选择有效的默认属性状态。");
    if (!["unknown", "true", "false"].includes(values.isCollectible ?? "")) throw new Error("请选择有效的典藏状态。");
    if (original ? values.defaultState !== (original.defaultState ?? "UNKNOWN") : values.defaultState !== "UNKNOWN") body.defaultState = values.defaultState;
    const collectible = values.isCollectible === "unknown" ? null : values.isCollectible === "true";
    if (original ? collectible !== (original.isCollectible ?? null) : collectible !== null) body.isCollectible = collectible;
    const rarityChanged = !original ? Boolean(values.rarityCode) : Object.hasOwn(body, "rarityCode");
    if (rarityChanged || values.changeRarityEvidence === "true") {
      if (!values.rarityCode) body.rarityEvidence = null;
      else {
        if (!Object.hasOwn(rarityBases, values.rarityBasis ?? "")) throw new Error("品质变更须填写品质依据；请打开详细信息补充来源。");
        const refs = evidenceFields({ ...values, evidenceUrls: values.rarityEvidenceUrls ?? "", observedAt: values.rarityObservedAt ?? "", note: values.rarityNote ?? "" });
        body.rarityEvidence = { schema: "skin-rarity-evidence-v1", basis: values.rarityBasis, sourceName: text(values.raritySourceName, "品质来源名称", SKIN_SOURCE_NAME_MAX_LENGTH), references: refs.evidenceRefs };
      }
    }
    if (values.changeMediaSource === "true") {
      if (!original || !clean(values.mediaId ?? "")) throw new Error("请先保存词条并绑定平台图片，再记录图片来源。");
      if (!["PORTRAIT_CARD", "MODEL_IMAGE", "PROMO_POSTER"].includes(values.mediaSourceKind ?? "")) throw new Error("请选择图片构图类型。");
      let url: URL; try { url = new URL(values.mediaSourceUrl ?? ""); } catch { throw new Error("图片来源须为公开HTTPS地址。"); }
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) throw new Error("图片来源须为不含登录信息的公开HTTPS地址。");
      body.mediaSource = { schema: "skin-media-source-v1", kind: values.mediaSourceKind, sourceName: text(values.mediaSourceName, "图片来源名称", SKIN_SOURCE_NAME_MAX_LENGTH), url: url.href };
    }
    if (original && ["defaultState", "isCollectible", "rarityEvidence", "mediaSource"].some(key => Object.hasOwn(body, key))) body.reason = text(values.reason, "修改原因", 500);
  }
  if (values.changeSource === "true") {
    if (original?.sourceNamespace) throw new Error("现有主来源不可覆盖。");
    body.sourceNamespace = text(values.sourceNamespace, "来源命名空间", 64);
    body.sourceField = original?.sourceField ?? text(values.sourceField, "来源字段", 64);
    body.sourceToken = original?.sourceToken ?? text(values.sourceToken, "原始来源值", 200, false);
    if (original) Object.assign(body, evidenceFields(values));
  }
  const sameIdentityRename = !confirm && skinDisplayNameChanged(values, original);
  if (sameIdentityRename) {
    const kind = original!.ownerKind ?? original!.ownerRef?.kind;
    if (!original!.baseName || !kind || (kind !== "MELEE_TYPE" && !original!.ownerRef)) throw new Error("原词条身份尚未完整读到，请先核对身份后再修正名称。");
    if (values.ownerKind !== kind || (values.ownerId ?? "") !== (original!.ownerRef?.id ?? "")) throw new Error("普通名称修正不能改变所属身份。");
    values = { ...values, ownerKind: kind, ownerId: original!.ownerRef?.id ?? "" };
  }
  if (confirm || sameIdentityRename) {
    if (!original) throw new Error("请先创建草稿，再单独确认身份。");
    if (!["AGENT", "MELEE_TYPE", "FIREARM"].includes(values.ownerKind ?? "")) throw new Error("请选择所属对象类型。");
    body.ownerKind = values.ownerKind;
    body.ownerRef = values.ownerKind === "MELEE_TYPE" && (gameCode === "delta" || !clean(values.ownerId ?? "")) ? null : { kind: values.ownerKind, id: text(values.ownerId, "所属对象", 128) };
    body.baseName = text(values.baseName, "皮肤本名", 120); body.confirmIdentity = true; Object.assign(body, evidenceFields(values));
  }
  if (original && !confirm && Object.keys(body).length === 1) throw new Error("没有需要保存的改动。");
  if (original) body.reason = text(values.reason, "修改原因", 500);
  return body;
}

export function ownerPayload(values: Record<string, string>, revision: string, original?: CatalogSkinOwner, gameCode?: string): Record<string, unknown> {
  if (original?.kind === "MELEE_TYPE" && gameCode === "delta" && values.enabled === "true") throw new Error("近战外观无需所属对象，历史记录不能重新启用。");
  if (original) return { expectedCatalogRevision: revision, enabled: values.enabled === "true", reason: text(values.reason, "原因", 500) };
  if (gameCode === "delta" && values.ownerKind === "MELEE_TYPE") throw new Error("近战外观无需所属对象，请在皮肤目录维护。");
  if (!["AGENT", "MELEE_TYPE"].includes(values.ownerKind ?? "")) throw new Error("请选择支持的所属对象类型。");
  return { expectedCatalogRevision: revision, kind: values.ownerKind, code: values.code, name: text(values.name, "名称", 120), ...evidenceFields(values) };
}

export function catalogReceipt(value: unknown, kind: "skins" | "skin-owners", body: Record<string, unknown>, id?: string, expectedCode?: string): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0 && (!id || r.id === id) && typeof r.code === "string" && r.code.length > 0 &&
    (!body.code || r.code === body.code) && (!expectedCode || r.code === expectedCode) && typeof r.catalogRevision === "string" && /^[1-9]\d*$/.test(r.catalogRevision) &&
    (kind === "skins" ? ["LEGACY", "PENDING", "VERIFIED"].includes(String(r.namingState)) && (!body.confirmIdentity || r.namingState === "VERIFIED") && (Boolean(id) || r.namingState === "PENDING")
      : ["AGENT", "MELEE_TYPE"].includes(String(r.kind)) && typeof r.enabled === "boolean" && (!body.kind || r.kind === body.kind));
}
