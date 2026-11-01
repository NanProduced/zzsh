/** A user-shared order reference, not a fulfillment instruction or trusted quote. */
export type OrderReference = { id: string; displayNo: string; title: string; party: "renter" | "owner" };
const PREFIX = "【关联订单卡】";
function label(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function valid(value: unknown): value is OrderReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as OrderReference;
  return typeof item.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.id)
    && label(item.displayNo, 80) && label(item.title, 240) && (item.party === "renter" || item.party === "owner");
}
/** Uses the existing text transport, so retries retain its original message id. */
export function encodeOrderReference(order: OrderReference, caption = ""): string {
  if (!valid(order)) throw new TypeError("订单信息不完整，请刷新订单列表。");
  const wire = PREFIX + JSON.stringify({ version: 1, id: order.id, displayNo: order.displayNo, title: order.title, party: order.party }) + (caption.trim() ? "\n" + caption.trim() : "");
  if (wire.length > 4000) throw new TypeError("附言过长，请缩短后再发送。");
  return wire;
}
export function parseOrderReference(text: unknown): { order: OrderReference; caption: string } | null {
  if (typeof text !== "string" || !text.startsWith(PREFIX) || text.length > 4000) return null;
  const split = text.indexOf("\n"), line = split < 0 ? text : text.slice(0, split);
  try {
    const value: unknown = JSON.parse(line.slice(PREFIX.length));
    if (!valid(value) || (value as OrderReference & { version?: unknown }).version !== 1) return null;
    return { order: { id: value.id, displayNo: value.displayNo, title: value.title, party: value.party }, caption: split < 0 ? "" : text.slice(split + 1) };
  } catch { return null; }
}
export function orderReferenceSummary(text: string): string {
  const reference = parseOrderReference(text);
  return reference ? `[订单] ${reference.order.title} · ${reference.order.displayNo}` : text.startsWith(PREFIX) ? "[订单]" : text;
}
