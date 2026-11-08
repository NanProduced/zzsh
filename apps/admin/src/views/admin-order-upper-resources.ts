import type { LegacyAdminQuantities, LegacyAdminView } from "../lib/legacy-continuation-client";
import type { SettlementReadView } from "../lib/order-fulfillment-client";
import { quantityText, unitText } from "./supply-review/model";

type Resource = { itemId?: string; code: string; name: string | null; quantity: string | null; unit: string };
type Frozen = { source: string; haff: Resource | null; materials: Resource[] };
type LegacyResources = { state: "KNOWN" | "NONE" | "INVALID"; items: Array<{ code: string; name: string; quantity: string }> };
type Row = { key: string; name: string; recorded: string; consumed: string };
const integer = (v: unknown): string | null => typeof v === "string" && /^(0|[1-9]\d{0,23})$/.test(v) ? v : null;
const quantity = (item: Resource, value: unknown) => {
  const v = integer(value);
  if (v === null) return "—";
  if (item.unit === "HAFF_BASE") return quantityText(v);
  if (["level6_round", "df_billable_level6_bullet"].includes(item.code) && item.unit === "ROUND") {
    const n = BigInt(v), groups = n / 60n;
    return n % 60n === 0n ? `${groups}组（${v}发）` : `${v}发`;
  }
  return `${v}${unitText(item.unit, item.code)}`;
};
const legacyFields: Record<string, keyof LegacyAdminQuantities> = {
  df_billable_haff: "expendHaff", haff_base: "expendHaff", "legacy-display:haff_base": "expendHaff", df_billable_awm_bullet: "awm", awm_round: "awm",
  df_billable_barrett_bullet: "barrett", legacy_barrett_round: "barrett", df_billable_level6_bullet: "bullet", level6_round: "bullet",
  df_billable_level6_armor: "armor", level6_armor: "armor", df_billable_level6_helmet: "helmet", level6_helmet: "helmet",
  df_billable_coffee: "coffee", coffee: "coffee", df_billable_top_insure_card: "card", legacy_insurance_day: "card",
};
const legacyUnits: Record<keyof LegacyAdminQuantities, string> = { expendHaff: " M 哈夫币", awm: "发", barrett: "发", bullet: "组", armor: "件", helmet: "件", coffee: "件", card: "天" };
const legacyNames: Record<keyof LegacyAdminQuantities, string> = { expendHaff: "哈夫币", awm: "AWM子弹", barrett: "巴雷特子弹", bullet: "6级子弹", armor: "6级护甲", helmet: "6级头盔", coffee: "咖啡豆", card: "保险体验卡" };
function legacyQuantity(field: keyof LegacyAdminQuantities, value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,23})(?:\.\d{1,2})?$/.test(value)) return "—";
  if (field === "bullet" && /^\d+$/.test(value)) return `${value}组（${BigInt(value) * 60n}发）`;
  return `${value}${legacyUnits[field]}`;
}

/** 只展示本单过账版本，旧站账号快照不能冒充订单冻结库存。 */
export function orderUpperResources(input: { origin: "NATIVE" | "LEGACY"; frozen?: Frozen | null; settlement?: SettlementReadView | null; legacy?: LegacyAdminView | null; original?: LegacyResources | null; originalCompleted: boolean }) {
  const { origin, frozen, settlement, legacy, original } = input;
  const version = settlement?.posting?.settlementVersionId && settlement.posting.versionHash
    ? settlement.versions?.find(v => v.id === settlement.posting!.settlementVersionId && v.versionHash === settlement.posting!.versionHash)
    : undefined;
  const computed = version?.computation?.ok === true ? version.computation.consumed : null;
  const isLegacyContinuation = origin === "LEGACY" && !!legacy?.evidenceId && ["4", "8", "9"].includes(legacy.stage ?? "") && legacy.quantities;
  const originalItems = origin === "LEGACY" && input.originalCompleted && original?.state === "KNOWN" ? original.items : [];
  const originalByCode = new Map(originalItems.map(item => [item.code, item]));
  const rows: Row[] = [];
  const items = frozen ? [...(frozen.haff ? [frozen.haff] : []), ...frozen.materials] : [];
  const usedLegacy = new Set<string>();
  for (const item of items) {
    let consumed = "—";
    const field = legacyFields[item.code];
    if (origin === "LEGACY" && field) {
      usedLegacy.add(field);
      const originalValue = originalItems.find(row => legacyFields[row.code] === field)?.quantity;
      consumed = legacyQuantity(field, isLegacyContinuation ? legacy!.quantities![field] : originalValue);
    } else if (origin === "NATIVE" && item.itemId && computed) {
      if (item.unit === "HAFF_BASE") consumed = quantity(item, computed.haff);
      else {
        const matches = computed.items?.filter(row => row.itemId === item.itemId) ?? [];
        if (matches.length === 1) consumed = quantity(item, matches[0]?.consumed);
      }
    }
    rows.push({ key: item.itemId ?? item.code, name: item.name ?? (item.unit === "HAFF_BASE" ? "哈夫币" : "名称未记录"), recorded: quantity(item, item.quantity), consumed });
  }
  if (origin === "NATIVE" && computed?.items) for (const extra of settlement?.extraResources ?? []) {
    if (items.some(item => item.itemId === extra.itemId)) continue;
    const matches = computed.items.filter(item => item.itemId === extra.itemId);
    const value = matches.length === 1 ? integer(matches[0]?.consumed) : null;
    if (value === null || BigInt(value) === 0n) continue;
    rows.push({ key: extra.itemId, name: extra.name ?? "名称未记录", recorded: "—", consumed: quantity({ ...extra, code: "", quantity: null }, value) });
  }
  if (origin === "LEGACY") for (const item of originalItems) {
    const field = legacyFields[item.code];
    if (!field || usedLegacy.has(field)) continue;
    usedLegacy.add(field);
    rows.push({ key: item.code, name: item.name, recorded: "—", consumed: legacyQuantity(field, isLegacyContinuation ? legacy!.quantities![field] : originalByCode.get(item.code)?.quantity) });
  }
  if (isLegacyContinuation) for (const field of Object.keys(legacyNames) as Array<keyof LegacyAdminQuantities>) {
    if (usedLegacy.has(field) || legacy!.quantities![field] == null) continue;
    rows.push({ key: `legacy-${field}`, name: legacyNames[field], recorded: "—", consumed: legacyQuantity(field, legacy!.quantities![field]) });
  }
  return { rows, recordedLabel: frozen?.source === "ORDER_VERSION" ? "下单时数量" : origin === "LEGACY" ? "迁入时账号参考" : "账号资料参考", consumedLabel: isLegacyContinuation ? legacy!.stage === "4" ? "续办记录消耗" : "申报消耗（待确认）" : origin === "LEGACY" && originalItems.length ? "旧站记录消耗" : "结算实际消耗" };
}
