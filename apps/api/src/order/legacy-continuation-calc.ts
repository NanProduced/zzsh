import { createHash } from "node:crypto";
import { canonicalize } from "../supply/content-hash";
import { addDecimal, DecimalError, divideToScale, multiplyDecimal, parseNonNegativeDecimal, subtractDecimal, formatDecimalAtScale, type Decimal } from "../supply/decimal";

/** Old settlement arithmetic. Plans only: no database, clock, route, or ledger write. */
export const LEGACY_CONTINUATION_CALC_VERSION = "legacy-continuation-calc.v1";
const INT = /^(0|[1-9]\d{0,9})$/;
const QTY = /^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
type Text = string | null;
export type PriceName = "barrett" | "bullet" | "awm" | "armor" | "helmet" | "coffee" | "card";
export type LegacyPrices = Record<PriceName, Text>;
export type LegacyQuantities = { expendHaff: Text } & LegacyPrices;
export type LegacyPolicy = { advanceOrderSetRatio: string; expend: Record<string, string> };
export type PaidPaySource = { id: string; payOrderSn: string; payMoney: string; orderId?: string };
export type CommissionSource = { id: string; beneficiaryId: string; ratio: string; level: string; status: string; storedEarnings: string };
export type LegacyContinuationSource = {
  legacyOrderId: string; orderStatus: string; isSettle: string; renterId: string; ownerId: string; accountId: Text;
  profitDot: Text; baseBot: Text; payMoney: Text; goodsMoney: Text; storedCommissionMoney: Text; depositAmount: Text;
  detainMoney: Text; returnOrderMoney: Text; saleEarnings: Text; fullPayoutMoney: Text; isFullPayout: Text;
  isAdvanceSet: Text; orderPrices: LegacyPrices; accountPrices: LegacyPrices; quantities: LegacyQuantities;
  paidPay: PaidPaySource[]; commissions: CommissionSource[]; policy: LegacyPolicy;
};
export type EvidenceAdmission = "PARAMETER_COMPLETE" | "ISOLATED";
export type LegacyContinuationEvidence = {
  schemaVersion: 1; legacyOrderId: string; admission: EvidenceAdmission; reasons: string[];
  provenance: { profitDot: "ORDER_COLUMN"; baseBot: "ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN" };
  parameterDigest: string; source: LegacyContinuationSource;
};
type Caller = { role: "renter" | "owner" | "admin" | "other"; legacyUserId: string };
export type LegacyCommand =
  | { kind: "preview" | "propose"; caller: Caller; quantities: LegacyQuantities }
  | { kind: "confirm" | "reject" | "hold" | "release" | "confiscate"; caller: Caller };
export type CalcRefusal = { ok: false; code: string; amounts: Record<string, string | null> };
export const LEGACY_REJECT_ASSIGNMENTS = {
  orderStatus: "3", expendHaff: null, expendMoney: null, expendRemark: null, returnOrderMoney: null, saleEarnings: null,
  awmBulletNum: "0", level6BulletNum: "0", level6HelmetNum: "0", barrettBulletNum: "0", coffeeNum: "0", level6ArmorNum: "0", topInsureCardNum: "0",
  fullPayoutMoney: "0", isAdvanceSet: "0", disagreeCountDelta: "1",
} as const;
export type AmountPlan = {
  ok: true; applied: false; kind: LegacyCommand["kind"]; nextStatus: string | null; isSettle: string | null;
  isAdvanceSet: 0 | 1 | null; amounts: Record<string, string | null>; assignments: typeof LEGACY_REJECT_ASSIGNMENTS | null;
  commissionRevisions: { id: string; beneficiaryId: string; legalEarnings: string; recalculable: boolean; reason: string | null }[];
  recognitionDelta: "0"; fingerprint: string;
};
const NAMES: PriceName[] = ["barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"];
const ORDER_KEY: Record<PriceName, string> = { barrett: "barrettBulletSale", bullet: "bulletSale", awm: "awmSale", armor: "armorSale", helmet: "helmetSale", coffee: "coffeeSale", card: "experienceCardSale" };
const ACCOUNT_KEY: Record<PriceName, string> = { barrett: "barrettBullet", bullet: "bullet", awm: "awm", armor: "armor", helmet: "helmet", coffee: "coffee", card: "experienceCard" };
const zero = (): Decimal => ({ value: 0n, scale: 0 });
const text = (value: Decimal) => formatDecimalAtScale(value, value.scale);
const dec = (value: string, label: string) => parseNonNegativeDecimal(value, 8, label);
const cmp = (left: Decimal, right: Decimal) => {
  const scale = Math.max(left.scale, right.scale);
  const delta = subtractDecimal({ ...left, value: left.value * 10n ** BigInt(scale - left.scale), scale }, { ...right, value: right.value * 10n ** BigInt(scale - right.scale), scale }).value;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
const gt = (left: Decimal, right: Decimal) => cmp(left, right) > 0;
const digest = (value: unknown) => createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
const parsed = (value: string): Decimal | null => { try { return dec(value, "money"); } catch { return null; } };
const moneyEqual = (left: string, right: string) => { const a = parsed(left), b = parsed(right); return a !== null && b !== null && cmp(a, b) === 0; };
function prices(value: LegacyPrices | null | undefined): string[] {
  if (!value) return ["MISSING_PRICES"];
  return NAMES.flatMap(name => {
    const raw = value[name];
    if (raw !== null && raw.startsWith("-")) return [`NEGATIVE_${name.toUpperCase()}_PRICE`];
    if (raw !== null && raw !== "" && parsed(raw) === null) return [`INVALID_${name.toUpperCase()}_PRICE`];
    return [];
  });
}
function evidenceBody(source: LegacyContinuationSource) {
  return { schemaVersion: 1 as const, legacyOrderId: source.legacyOrderId, provenance: { profitDot: "ORDER_COLUMN" as const, baseBot: "ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN" as const }, source };
}
export function admitLegacyEvidence(input: LegacyContinuationSource): LegacyContinuationEvidence {
  const source = structuredClone(input);
  const reasons: string[] = [];
  if (!source || !INT.test(source.legacyOrderId ?? "")) reasons.push("MISSING_ORDER");
  if (!INT.test(source.renterId ?? "") || !INT.test(source.ownerId ?? "")) reasons.push("INVALID_PARTY");
  if (source.accountId === null) reasons.push("MISSING_ACCOUNT");
  else if (!INT.test(source.accountId)) reasons.push("INVALID_ACCOUNT");
  if (source.baseBot === null) reasons.push("MISSING_BASE_BOT");
  else if (!INT.test(source.baseBot)) reasons.push("INVALID_BASE_BOT");
  else if (source.baseBot === "0") reasons.push("BASE_BOT_ZERO");
  if (source.profitDot === null) reasons.push("MISSING_PROFIT_DOT");
  else if (!INT.test(source.profitDot)) reasons.push("INVALID_PROFIT_DOT");
  if (INT.test(source.baseBot ?? "") && INT.test(source.profitDot ?? "") && BigInt(source.baseBot!) <= BigInt(source.profitDot!)) reasons.push("INVALID_DIVISOR");
  for (const [field, missing, invalid] of [["payMoney", "MISSING_PAY_MONEY", "INVALID_PAY_MONEY"], ["goodsMoney", "MISSING_GOODS_MONEY", "INVALID_GOODS_MONEY"], ["storedCommissionMoney", "MISSING_STORED_COMMISSION", "INVALID_STORED_COMMISSION"]] as const) {
    const value = source[field];
    if (value === null) reasons.push(missing);
    else if (parsed(value) === null) reasons.push(invalid);
  }
  if (!Array.isArray(source.paidPay) || !Array.isArray(source.commissions)) reasons.push("EVIDENCE_SHAPE");
  else {
    if (source.paidPay.length === 0) reasons.push("MISSING_PAID_PAY_ROW");
    if (source.paidPay.length > 1) reasons.push("AMBIGUOUS_PAID_PAY_ROWS");
    if (source.paidPay.length === 1) {
      const pay = source.paidPay[0]!;
      if (!pay.payOrderSn) reasons.push("MISSING_PAY_ORDER_SN");
      if (!INT.test(pay.id ?? "")) reasons.push("INVALID_PAY_ID");
      if (pay.orderId !== undefined && pay.orderId !== source.legacyOrderId) reasons.push("PAY_ORDER_MISMATCH");
      if (source.payMoney !== null && pay.payMoney !== undefined && !moneyEqual(source.payMoney, pay.payMoney)) reasons.push("PAID_AMOUNT_MISMATCH");
    }
    for (const row of source.commissions) {
      if (row.status !== "1" && row.status !== "2" && row.status !== "3") reasons.push("UNKNOWN_COMMISSION_STATUS");
      if (!INT.test(row.beneficiaryId ?? "")) reasons.push("INVALID_COMMISSION_BENEFICIARY");
      if (parsed(row.ratio ?? "") === null) reasons.push("INVALID_COMMISSION_RATIO");
    }
  }
  if (typeof source.policy?.advanceOrderSetRatio !== "string" || parsed(source.policy.advanceOrderSetRatio) === null || Object.values(source.policy.expend ?? {}).some(value => typeof value !== "string" || parsed(value) === null)) reasons.push("INVALID_POLICY");
  reasons.push(...prices(source.orderPrices), ...prices(source.accountPrices));
  for (const name of NAMES) {
    const orderRaw = source.orderPrices?.[name] ?? null;
    let orderNeedsFallback = orderRaw === null || orderRaw === "";
    if (!orderNeedsFallback && !orderRaw!.startsWith("-")) {
      const amount = parsed(orderRaw!);
      if (amount === null) reasons.push("INVALID_ORDER_PRICE");
      else orderNeedsFallback = !gt(amount, zero());
    }
    if (orderNeedsFallback && source.policy?.expend?.[ORDER_KEY[name]] === undefined) reasons.push("MISSING_EXPEND_CONFIG");
    if ((source.accountPrices?.[name] ?? null) === null && source.policy?.expend?.[ACCOUNT_KEY[name]] === undefined) reasons.push("MISSING_EXPEND_CONFIG");
  }
  const unique = [...new Set(reasons)];
  const body = { schemaVersion: 1 as const, legacyOrderId: source.legacyOrderId, provenance: { profitDot: "ORDER_COLUMN" as const, baseBot: "ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN" as const }, source };
  return { ...body, admission: unique.length ? "ISOLATED" : "PARAMETER_COMPLETE", reasons: unique, parameterDigest: digest(body) };
}
function qtyOf(name: PriceName, quantities: LegacyQuantities): Decimal | null {
  const raw = quantities[name];
  if (raw === null || raw === "") return null;
  if (!QTY.test(raw)) throw new DecimalError("quantity is invalid");
  const value = dec(raw, name);
  return cmp(value, zero()) > 0 ? value : null;
}
function priced(raw: Text, mode: "order" | "account", key: string, policy: LegacyPolicy): Decimal {
  if (mode === "account") {
    if (raw === null) {
      const fallback = policy.expend[key];
      if (fallback === undefined) throw new DecimalError(`missing ${key}`);
      return dec(fallback, key);
    }
    return dec(raw, key);
  }
  if (raw !== null && gt(dec(raw, key), zero())) return dec(raw, key);
  const fallback = policy.expend[key];
  if (fallback === undefined) throw new DecimalError(`missing ${key}`);
  return dec(fallback, key);
}
function expend(quantities: LegacyQuantities, priceset: LegacyPrices | null, mode: "order" | "account" | "config", policy: LegacyPolicy): Decimal {
  let total = zero();
  for (const name of NAMES) {
    const quantity = qtyOf(name, quantities);
    if (!quantity) continue;
    const key = mode === "order" ? ORDER_KEY[name] : ACCOUNT_KEY[name];
    const price = mode === "config" ? dec(policy.expend[key] ?? (() => { throw new DecimalError(`missing ${key}`); })(), key) : priced(priceset![name], mode, key, policy);
    total = addDecimal(total, multiplyDecimal(quantity, price));
  }
  return total;
}
function splits(haff: Decimal, baseBot: bigint, profitDot: bigint) {
  if (baseBot <= 0n || baseBot <= profitDot) throw new DecimalError("divisor is invalid");
  const hundred = dec("100", "hundred");
  return {
    narrow: divideToScale(multiplyDecimal(haff, hundred), { value: baseBot - profitDot, scale: 0 }, 0),
    wide: divideToScale(multiplyDecimal(haff, hundred), { value: baseBot, scale: 0 }, 0),
  };
}
function advance(goods: Decimal, ratio: string, probe: Decimal): boolean {
  const cut = divideToScale(dec(ratio, "advance ratio"), dec("100", "hundred"), 2);
  return gt(multiplyDecimal(goods, cut), probe);
}
function poolOf(pay: Decimal, sale: Decimal, returned: Decimal) { return subtractDecimal(subtractDecimal(pay, sale), returned); }
function payoutFields(kind: "preview" | "propose", sale: Decimal, assigned: Decimal | null, stored: Text): { fullPayoutMoney: string | null; ownerNet: string | null } {
  if (kind === "preview") return { fullPayoutMoney: null, ownerNet: null };
  if (assigned) return { fullPayoutMoney: text(assigned), ownerNet: text(subtractDecimal(sale, assigned)) };
  if (stored === null) return { fullPayoutMoney: null, ownerNet: null };
  return { fullPayoutMoney: null, ownerNet: text(subtractDecimal(sale, dec(stored, "stored payout"))) };
}
function revisions(source: LegacyContinuationSource, pool: Decimal) {
  return source.commissions.map(row => {
    if (row.status === "2" || row.status === "3") return { id: row.id, beneficiaryId: row.beneficiaryId, legalEarnings: row.storedEarnings, recalculable: false, reason: row.status === "2" ? "ALREADY_SETTLED" : "ALREADY_VOID" };
    if (row.status !== "1") return { id: row.id, beneficiaryId: row.beneficiaryId, legalEarnings: row.storedEarnings, recalculable: false, reason: "UNKNOWN_COMMISSION_STATUS" };
    const ratio = parsed(row.ratio);
    if (!ratio) return { id: row.id, beneficiaryId: row.beneficiaryId, legalEarnings: row.storedEarnings, recalculable: false, reason: "INVALID_COMMISSION_RATIO" };
    const legal = divideToScale(multiplyDecimal(ratio, pool), dec("100", "hundred"), 2);
    return { id: row.id, beneficiaryId: row.beneficiaryId, legalEarnings: text(legal), recalculable: true, reason: null };
  });
}
function refuse(code: string, observed: Record<string, string | null> = {}): CalcRefusal { return { ok: false, code, amounts: observed }; }
function finish(source: LegacyContinuationEvidence, command: LegacyCommand, plan: Omit<AmountPlan, "ok" | "applied" | "fingerprint" | "recognitionDelta" | "assignments"> & { assignments?: AmountPlan["assignments"] }): AmountPlan {
  const fingerprint = digest({ evidence: source.parameterDigest, command });
  return { ok: true, assignments: null, ...plan, applied: false, recognitionDelta: "0", fingerprint };
}
export function planLegacyContinuation(evidence: LegacyContinuationEvidence, command: LegacyCommand): AmountPlan | CalcRefusal {
  if (evidence?.schemaVersion !== 1 || evidence.legacyOrderId !== evidence.source?.legacyOrderId || evidence.provenance?.profitDot !== "ORDER_COLUMN" || evidence.provenance?.baseBot !== "ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN") return refuse("EVIDENCE_RELATION");
  let checked: LegacyContinuationEvidence;
  try { checked = admitLegacyEvidence(evidence.source); } catch { return refuse("EVIDENCE_SCHEMA"); }
  if (checked.parameterDigest !== evidence.parameterDigest) return refuse("EVIDENCE_DIGEST_MISMATCH");
  if (evidence.admission !== "PARAMETER_COMPLETE" || checked.admission !== "PARAMETER_COMPLETE") return refuse("EVIDENCE_ISOLATED");
  const source = checked.source;
  const caller = command.caller;
  if (caller.role === "admin" || caller.role === "other") {
    if (command.kind === "preview" || command.kind === "propose" || command.kind === "confirm" || command.kind === "reject") return refuse("STAFF_CANNOT_CONFIRM");
  }
  const party = caller.role === "renter" ? source.renterId : caller.role === "owner" ? source.ownerId : null;
  if (party !== null && caller.legacyUserId !== party) return refuse("NOT_PARTY");
  if (command.kind === "hold" || command.kind === "release" || command.kind === "confiscate") {
    if (caller.role !== "admin") return refuse("DEPOSIT_ACTOR_INVALID");
    if (command.kind === "hold" && source.isSettle !== "0") return refuse("DEPOSIT_STATE_INVALID");
    if (command.kind !== "hold" && source.isSettle !== "2") return refuse("DEPOSIT_STATE_INVALID");
    const next = command.kind === "hold" ? "2" : command.kind === "release" ? "0" : "3";
    const amounts: Record<string, string | null> = { returnOrderMoney: source.returnOrderMoney, detainMoney: source.detainMoney, depositCompensation: command.kind === "confiscate" ? source.depositAmount : null };
    return finish(evidence, command, { kind: command.kind, nextStatus: source.orderStatus, isSettle: next, isAdvanceSet: null, amounts, commissionRevisions: [] });
  }
  if (command.kind === "reject") {
    const expected = caller.role === "owner" ? "8" : caller.role === "renter" ? "9" : "";
    if (source.orderStatus !== expected) return refuse("STATUS_INVALID");
    return finish(evidence, command, { kind: "reject", nextStatus: "3", isSettle: source.isSettle, isAdvanceSet: 0, amounts: {}, assignments: LEGACY_REJECT_ASSIGNMENTS, commissionRevisions: [] });
  }
  if (command.kind === "confirm") {
    const expected = caller.role === "owner" ? "8" : caller.role === "renter" ? "9" : "";
    if (source.orderStatus !== expected) return refuse("STATUS_INVALID");
    if (source.saleEarnings === null || source.returnOrderMoney === null || source.fullPayoutMoney === null) return refuse("MISSING_STORED_SETTLEMENT");
    const pay = parsed(source.payMoney!), sale = parsed(source.saleEarnings), returned = parsed(source.returnOrderMoney), payout = parsed(source.fullPayoutMoney);
    if (!pay || !sale || !returned || !payout) return refuse("AMOUNT_INVALID");
    const pool = poolOf(pay, sale, returned);
    if (pool.value < 0n) return refuse("CONFIRM_POOL_NEGATIVE", { commissionPool: text(pool) });
    const ownerNet = subtractDecimal(sale, payout);
    if (ownerNet.value < 0n) return refuse("OWNER_NET_NEGATIVE", { saleEarnings: text(sale), fullPayoutMoney: text(payout), ownerNet: text(ownerNet) });
    const detain = source.detainMoney === null ? null : parsed(source.detainMoney);
    if (source.detainMoney !== null && !detain) return refuse("AMOUNT_INVALID");
    const net = detain && gt(detain, zero()) ? subtractDecimal(returned, detain) : returned;
    if (net.value < 0n) return refuse("REFUND_NET_NEGATIVE", { returnOrderMoney: text(returned), detainMoney: source.detainMoney, refundNet: text(net) });
    const commissionRevisions = revisions(source, pool);
    if (commissionRevisions.some(row => row.reason === "UNKNOWN_COMMISSION_STATUS" || row.reason === "INVALID_COMMISSION_RATIO")) return refuse("COMMISSION_UNPROVEN");
    const allocated = source.commissions.reduce((sum, row) => row.status === "1" ? addDecimal(sum, parsed(commissionRevisions.find(item => item.id === row.id)?.legalEarnings ?? "0") ?? zero()) : sum, zero());
    if (gt(allocated, pool)) return refuse("COMMISSION_EXCEEDS_POOL", { commissionPool: text(pool), commissionAllocated: text(allocated) });
    return finish(evidence, command, { kind: "confirm", nextStatus: "4", isSettle: source.isSettle, isAdvanceSet: source.isAdvanceSet === "1" ? 1 : 0, amounts: { payMoney: text(pay), saleEarnings: text(sale), returnOrderMoney: text(returned), fullPayoutMoney: text(payout), ownerNet: text(ownerNet), commissionPool: text(pool), refundGross: text(returned), refundNet: text(net) }, commissionRevisions });
  }
  if (command.kind !== "preview" && command.kind !== "propose") return refuse("STATUS_INVALID");
  if (source.orderStatus !== "3") return refuse("STATUS_INVALID");
  if (caller.role !== "renter" && caller.role !== "owner") return refuse("NOT_PARTY");
  const quantities = command.quantities;
  let haff: Decimal;
  try {
    if (quantities.expendHaff === null) return refuse("MISSING_QUANTITY");
    haff = dec(quantities.expendHaff, "haff");
    for (const name of NAMES) qtyOf(name, quantities);
  } catch { return refuse("QUANTITY_INVALID"); }
  try {
    const pay = dec(source.payMoney!, "pay");
    const goods = dec(source.goodsMoney!, "goods");
    const stored = dec(source.storedCommissionMoney!, "stored commission");
    const base = BigInt(source.baseBot!);
    const profit = BigInt(source.profitDot!);
    const { narrow, wide } = splits(haff, base, profit);
    const orderExpend = expend(quantities, source.orderPrices, "order", source.policy);
    const accountExpend = expend(quantities, source.accountPrices, "account", source.policy);
    const configExpend = expend(quantities, null, "config", source.policy);
    if (caller.role === "renter") {
      if (gt(addDecimal(narrow, orderExpend), pay)) return refuse("DEPOSIT_SHORT");
      const early = advance(goods, source.policy.advanceOrderSetRatio, addDecimal(narrow, orderExpend));
      const returned = early ? subtractDecimal(subtractDecimal(subtractDecimal(pay, wide), orderExpend), stored) : subtractDecimal(subtractDecimal(pay, narrow), orderExpend);
      if (returned.value < 0n) return refuse("RETURN_NEGATIVE", { returnOrderMoney: text(returned) });
      const sale = addDecimal(wide, accountExpend);
      const assigned = !early && source.isFullPayout === "1" ? multiplyDecimal(sale, dec("0.08", "payout")) : null;
      const amounts = { payMoney: text(pay), divide: text(narrow), divide2: text(wide), expendOrder: text(orderExpend), saleEarnings: command.kind === "preview" ? null : text(sale), returnOrderMoney: text(returned), ...payoutFields(command.kind, sale, assigned, source.fullPayoutMoney), commissionPool: command.kind === "preview" ? null : text(poolOf(pay, sale, returned)) };
      return finish(evidence, command, { kind: command.kind, nextStatus: command.kind === "propose" ? "8" : null, isSettle: source.isSettle, isAdvanceSet: early ? 1 : 0, amounts, commissionRevisions: [] });
    }
    if (gt(addDecimal(narrow, orderExpend), pay)) return refuse("DEPOSIT_SHORT");
    const early = advance(goods, source.policy.advanceOrderSetRatio, addDecimal(narrow, command.kind === "preview" ? configExpend : accountExpend));
    const sale = addDecimal(wide, command.kind === "preview" ? configExpend : accountExpend);
    const shown = command.kind === "preview" && !early && source.isFullPayout === "1" ? multiplyDecimal(sale, dec("0.92", "preview payout")) : sale;
    const returned = early ? subtractDecimal(subtractDecimal(subtractDecimal(pay, wide), orderExpend), stored) : subtractDecimal(subtractDecimal(pay, narrow), orderExpend);
    if (returned.value < 0n) return refuse("RETURN_NEGATIVE", { returnOrderMoney: text(returned) });
    const assigned = command.kind === "propose" && !early && source.isFullPayout === "1" ? multiplyDecimal(sale, dec("0.08", "payout")) : null;
    const amounts = { payMoney: text(pay), saleEarnings: text(command.kind === "preview" ? shown : sale), returnOrderMoney: command.kind === "preview" ? null : text(returned), expendOrder: text(orderExpend), expendAccount: text(accountExpend), ...payoutFields(command.kind, sale, assigned, source.fullPayoutMoney), commissionPool: command.kind === "preview" ? null : text(poolOf(pay, sale, returned)) };
    return finish(evidence, command, { kind: command.kind, nextStatus: command.kind === "propose" ? "9" : null, isSettle: source.isSettle, isAdvanceSet: early ? 1 : 0, amounts, commissionRevisions: [] });
  } catch (error) {
    return refuse(error instanceof DecimalError ? "AMOUNT_INVALID" : "AMOUNT_INVALID");
  }
}
