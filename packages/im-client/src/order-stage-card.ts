/** Platform-owned order stage card payload carried by a NIM custom message. */
export type OrderStageCardKind = "ORDER_OPENING" | "ORDER_ENDING" | "ORDER_SETTLED" | "ORDER_PRICE_CHANGE";
export type OrderStageCard = { kind: OrderStageCardKind; orderId: string; cardId: string };

const SCHEMA = "zzsh.order-card";
const KINDS = new Set<OrderStageCardKind>(["ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED", "ORDER_PRICE_CHANGE"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function encodeOrderStageCard(card: OrderStageCard): string {
  if (!KINDS.has(card.kind) || !ID.test(card.orderId) || !ID.test(card.cardId)) {
    throw new TypeError("订单卡片信息不完整");
  }
  return JSON.stringify({ schema: SCHEMA, version: 1, kind: card.kind, orderId: card.orderId, cardId: card.cardId });
}

/**
 * Only the platform-owned shape. Unknown/forged payloads stay ordinary message
 * text; every amount and order fact still comes from the authorized order read.
 */
export function parseOrderStageCard(value: unknown): OrderStageCard | null {
  let input = value;
  if (typeof input === "string") {
    if (input.length > 1024) return null;
    try { input = JSON.parse(input); } catch { return null; }
  }
  const wrapper = record(input);
  if (wrapper && typeof wrapper.raw === "string") return parseOrderStageCard(wrapper.raw);
  const card = wrapper;
  if (!card || Object.keys(card).some((key) => !["schema", "version", "kind", "orderId", "cardId"].includes(key))) return null;
  if (card.schema !== SCHEMA || card.version !== 1 || typeof card.kind !== "string" || !KINDS.has(card.kind as OrderStageCardKind)) return null;
  if (typeof card.orderId !== "string" || !ID.test(card.orderId) || typeof card.cardId !== "string" || !ID.test(card.cardId)) return null;
  return { kind: card.kind as OrderStageCardKind, orderId: card.orderId, cardId: card.cardId };
}
