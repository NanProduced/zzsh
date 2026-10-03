import type { AdminCatalogResponse, CatalogSkin, CatalogSkinOwner } from "../api";

export const skinStates = { LEGACY: "旧词条（LEGACY）", PENDING: "待核草稿（PENDING）", VERIFIED: "身份已核（VERIFIED）" };
export const ownerKinds = { AGENT: "干员", MELEE_TYPE: "刀型", FIREARM: "枪械" };
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
      (s.ownerRef === null || (s.ownerRef && ["AGENT", "MELEE_TYPE", "FIREARM"].includes(s.ownerRef.kind) && typeof s.ownerRef.id === "string"))));
}

export function skinValues(skin?: CatalogSkin): Record<string, string> {
  return { aliases: skin?.aliases?.join("\n") ?? "", sourceNamespace: skin?.sourceNamespace ?? "", sourceField: skin?.sourceField ?? "", sourceToken: skin?.sourceToken ?? "",
    changeSource: "false", ownerKind: skin?.ownerRef?.kind ?? "AGENT", ownerId: skin?.ownerRef?.id ?? "", baseName: skin?.baseName ?? "", reason: "", evidenceUrls: "", observedAt: "", region: "", note: "" };
}

export function evidenceFields(values: Record<string, string>) {
  const urls = lines(values.evidenceUrls);
  if (urls.length < 1 || urls.length > 8) throw new Error("请填写1至8条证据链接，每行一条。");
  const observedAt = values.observedAt ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString().slice(0, 10) !== observedAt) throw new Error("请填写有效的证据核对日期。");
  const region = text(values.region, "适用地区", 64), note = text(values.note, "证据说明", 500);
  const evidenceRefs = urls.map(raw => {
    const url = text(raw, "证据链接", 2000);
    let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("证据链接须为公开HTTPS地址。"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("证据链接须为不含登录信息的公开HTTPS地址。");
    return { url, observedAt, region, note };
  });
  return { reason: text(values.reason, "原因", 500), evidenceRefs };
}

export function skinPayload(values: Record<string, string>, revision: string, original?: CatalogSkin, confirm = false): Record<string, unknown> {
  if (!/^[1-9]\d*$/.test(revision)) throw new Error("目录版本未就绪，请重新读取目录。");
  const body: Record<string, unknown> = { expectedCatalogRevision: revision };
  const aliases = lines(values.aliases).map(v => text(v, "别名", 200));
  if (aliases.length > 32 || new Set(aliases).size !== aliases.length) throw new Error("别名最多32项且不能重复，请每行填写一项。");
  if (!original || JSON.stringify(aliases) !== JSON.stringify(original.aliases)) body.aliases = aliases;
  if (!original) {
    body.code = values.code; body.name = text(values.name, "名称", 120); body.categoryId = text(values.categoryId, "分类", 128);
    body.rarityCode = values.rarityCode || null; body.enabled = false; body.formVisible = false;
    body.sortOrder = Number(values.sortOrder || "0");
  } else if (!confirm) {
    if (original.namingState !== "VERIFIED" && values.name !== original.name) { body.name = text(values.name, "名称", 120); body.reason = text(values.reason, "改名原因", 500); }
    for (const field of ["categoryId", "rarityCode", "sortOrder", "enabled", "formVisible"] as const) {
      const value = field === "sortOrder" ? Number(values[field]) : field === "enabled" || field === "formVisible" ? values[field] === "true" : field === "rarityCode" ? values[field] || null : values[field];
      if (value !== original[field]) body[field] = value;
    }
  }
  if ("sortOrder" in body && (!Number.isInteger(body.sortOrder) || Math.abs(body.sortOrder as number) > 100000)) throw new Error("排序须为-100000至100000的整数。");
  if (values.changeSource === "true") {
    if (original?.sourceNamespace) throw new Error("现有主来源不可覆盖。");
    body.sourceNamespace = text(values.sourceNamespace, "来源命名空间", 64);
    body.sourceField = original?.sourceField ?? text(values.sourceField, "来源字段", 64);
    body.sourceToken = original?.sourceToken ?? text(values.sourceToken, "原始来源值", 200, false);
    if (original) Object.assign(body, evidenceFields(values));
  }
  if (confirm) {
    if (!original) throw new Error("请先创建草稿，再单独确认身份。");
    if (!["AGENT", "MELEE_TYPE", "FIREARM"].includes(values.ownerKind ?? "")) throw new Error("请选择所属对象类型。");
    body.ownerRef = { kind: values.ownerKind, id: text(values.ownerId, "所属对象", 128) };
    body.baseName = text(values.baseName, "皮肤本名", 120); body.confirmIdentity = true; Object.assign(body, evidenceFields(values));
  }
  if (original && !confirm && Object.keys(body).length === 1) throw new Error("没有需要保存的改动。");
  return body;
}

export function ownerPayload(values: Record<string, string>, revision: string, original?: CatalogSkinOwner): Record<string, unknown> {
  if (original) return { expectedCatalogRevision: revision, enabled: values.enabled === "true", reason: text(values.reason, "原因", 500) };
  if (!["AGENT", "MELEE_TYPE"].includes(values.ownerKind ?? "")) throw new Error("只支持维护干员或刀型。");
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
