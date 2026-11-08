import { canonicalize } from "../supply/content-hash";
import { decimalToBigInt, divideToScale, formatScaledInteger, parseNonNegativeDecimal } from "../supply/decimal";
import { conflict, invalid, notFound, sha256Hex } from "../supply/supply-util";
import { admitLegacyEvidence, planLegacyContinuation, type AmountPlan, type LegacyCommand, type LegacyContinuationEvidence, type LegacyContinuationSource, type LegacyQuantities } from "./legacy-continuation-calc";

export const LEGACY_DUTY_KINDS = ["RENTER_REFUND", "OWNER_CREDIT", "COMMISSION", "DEPOSIT_COMPENSATION"] as const;
export type LegacyDutyKind = typeof LEGACY_DUTY_KINDS[number];
export type LegacyDutyStatus = "PENDING" | "MATURED" | "SETTLED" | "VOID";
export type LegacyContinuationActor = { realm: "user" | "admin"; userId: string; sessionId: string; requestId: string };
export type LegacyOrderBinding = {
  id: string; legacyId: string; accountId: string; legacyAccountId: string; gameId: string;
  ownerUserId: string; renterUserId: string; legacyOwnerId: string; legacyRenterId: string;
  ownerSourceDigest: string; renterSourceDigest: string; sourceDigest: string;
  sourceOrderStatus: number; sourcePayStatus: number; paidCents: string | null; completedAt?: string | null; sourceDeletedFlag?: string | null;
};
export type LegacyEffectiveFacts = {
  schemaVersion: 1; evidence: LegacyContinuationEvidence;
  amounts: Record<string, string | null>;
  commissionEvidence?: LegacyCommissionEvidence[];
  derivedFromEvidenceId: string | null; derivedFromCommandVersionId: string | null;
};
export type LegacyCommissionEvidence = { sourceRecordId: string; canonical: string; digest: string; evidenceRef: string };
export function assertLegacyCommissionEvidence(proof: LegacyCommissionEvidence, legacyOrderId: string, commission: LegacyContinuationSource["commissions"][number]) {
  if (!proof || proof.sourceRecordId !== commission.id || typeof proof.canonical !== "string" || proof.canonical.length > 32768 || sha256Hex(proof.canonical) !== proof.digest || !proof.evidenceRef || proof.evidenceRef.length > 512) throw conflict("COMMISSION_SOURCE_EVIDENCE_MISSING");
  let row: Record<string, unknown>;
  try { row = JSON.parse(proof.canonical); } catch { throw conflict("COMMISSION_SOURCE_EVIDENCE_INVALID"); }
  if (!row || typeof row !== "object" || Array.isArray(row) || canonicalize(row) !== proof.canonical || row.id !== commission.id || row.order_id !== legacyOrderId || row.user_id !== commission.beneficiaryId || row.status !== commission.status || String(row.level) !== commission.level
    || typeof row.earnings !== "string" || !legacyDecimalEquals(row.earnings, commission.storedEarnings) || typeof row.ratio !== "string" || !legacyDecimalEquals(row.ratio, commission.ratio)) throw conflict("COMMISSION_SOURCE_EVIDENCE_MISMATCH");
  return row;
}
export type LegacyEvidenceRow = {
  id: string; orderId: string; evidenceVersion: string; sourceKind: "SOURCE_IMPORT" | "DERIVED";
  sourceDigest: string; factsDigest: string; factsCanonical: string; facts: LegacyEffectiveFacts;
};
export type LegacyHeadRow = {
  id: string; orderId: string; revision: string; inputEvidenceId: string; resultEvidenceId: string;
  stage: number; isSettle: number; command: string; amounts: Record<string, string | null>; refundDueAt?: string | null;
};
export type LegacyDutyRow = {
  id: string; orderId: string; continuationVersionId: string | null; kind: LegacyDutyKind; sourceRecordId: string;
  counterpartyUserId: string | null; amountCents: string; currency: "CNY"; status: LegacyDutyStatus;
  source: "LEGACY_IMPORT" | "CONTINUATION"; sourceStatus: string | null; level: string | null; ratio: string | null;
  maturityAt: string | null; revision: string; settledBy: "FINANCE" | "LEGACY_RECORDS" | null;
  settledRefType: string | null; settledRefId: string | null; settledRefDigest: string | null; admissionId?: string | null;
};
export type LegacyFinanceDisposition = "NONE" | "POSTED_POSITIVE_REFUND" | "FINALIZED_ZERO" | "UNKNOWN";
export type LegacyDutyFinalizationReader = (client: import("pg").PoolClient, orderId: string, duties: readonly LegacyDutyRow[]) => Promise<LegacyFinanceDisposition>;
export type LegacyContinuationView = {
  schema: "legacy-continuation.v1"; availability: "KNOWN" | "NOT_IMPORTED" | "ISOLATED";
  revision: string | null; evidenceId: string | null; stage: string | null; isSettle: string | null;
  amounts: Record<string, { cents: string; yuan: string } | null>; quantities: LegacyQuantities | null;
  confirmationAmounts?: { ownerNet: { cents: string; yuan: string }; refundNet: { cents: string; yuan: string } } | null;
  refundDueAt?: string | null;
  settlementKind?: "EARLY" | "NORMAL" | null; earlyFee?: string | null;
  capabilities: string[]; commandFingerprints: Record<string, string>; reasons: string[]; duties: Array<{ id: string; kind: LegacyDutyKind; amountCents: string; currency: "CNY"; status: LegacyDutyStatus; maturityAt: string | null; sourceStatus: string | null; revision: string; settledBy: string | null; financeVerified:boolean }>;
  channelState: "UNKNOWN";
};
const LEGACY_VISIBLE_REASONS = new Set(["DEPOSIT_SHORT", "RETURN_NEGATIVE", "EVIDENCE_ISOLATED", "MISSING_STORED_SETTLEMENT", "FINANCE_FACT_UNAVAILABLE", "FINANCE_FACT_UNKNOWN", "DEPOSIT_ALREADY_SETTLED", "CONTINUATION_REVISION_CONFLICT", "PLAN_FINGERPRINT_MISMATCH", "DUTY_REVISION_CONFLICT", "STATUS_INVALID", "QUANTITY_INVALID", "PRECISION_UNSUPPORTED", "CONFIRM_POOL_NEGATIVE", "OWNER_NET_NEGATIVE", "WALLET_CREDIT_HISTORY_UNPROVEN", "WALLET_CREDIT_BASIS_UNAVAILABLE"]);
export function visibleLegacyReason(value: unknown): string | undefined { return typeof value === "string" && LEGACY_VISIBLE_REASONS.has(value) ? value : undefined; }

/** Calc emits exact decimals of variable scale; the persisted contract is integer cents. */
export function legacyPlanYuanToCents(value: string): string {
  try {
    if (typeof value !== "string" || value.length > 40) throw new Error("shape");
    const cents = decimalToBigInt(parseNonNegativeDecimal(value, 8, "legacy amount"), 2);
    if (cents.toString().length > 24) throw new Error("range");
    return cents.toString();
  } catch { throw invalid("PRECISION_UNSUPPORTED"); }
}
export function legacyDecimalEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try { return decimalToBigInt(parseNonNegativeDecimal(a, 8, "legacy decimal"), 8) === decimalToBigInt(parseNonNegativeDecimal(b, 8, "legacy decimal"), 8); } catch { return false; }
}
export function legacyOrderAdvisoryKey(orderId: string): string {
  if (!/^legacy_order_[a-f0-9]{40}$/.test(orderId)) throw invalid("Invalid mapped historical order");
  return BigInt(`0x${sha256Hex(orderId).slice(0, 15)}`).toString();
}
export function legacyEconomicDutyId(orderId: string, kind: LegacyDutyKind, sourceRecordId: string): string {
  return "legacy_duty_" + sha256Hex(JSON.stringify([orderId, kind, sourceRecordId])).slice(0, 40);
}
export function assertLegacyEffectiveFacts(facts: LegacyEffectiveFacts): LegacyEffectiveFacts {
  if (!facts || facts.schemaVersion !== 1 || !facts.evidence || !facts.amounts || Array.isArray(facts.amounts)) throw conflict("EVIDENCE_SCHEMA");
  const checked = admitLegacyEvidence(facts.evidence.source);
  if (canonicalize(checked) !== canonicalize(facts.evidence)) throw conflict("EVIDENCE_DIGEST_MISMATCH");
  if (!["3", "8", "9", "4"].includes(checked.source.orderStatus) || !["0", "2", "3"].includes(checked.source.isSettle)) throw conflict("STATUS_INVALID");
  for (const value of Object.values(facts.amounts)) if (value !== null) legacyPlanYuanToCents(value);
  if (facts.commissionEvidence) {
    if (!Array.isArray(facts.commissionEvidence) || new Set(facts.commissionEvidence.map(p => p.sourceRecordId)).size !== facts.commissionEvidence.length) throw conflict("COMMISSION_SOURCE_EVIDENCE_INVALID");
    for (const proof of facts.commissionEvidence) { const source = checked.source.commissions.find(c => c.id === proof.sourceRecordId); if (!source) throw conflict("COMMISSION_SOURCE_EVIDENCE_MISMATCH"); assertLegacyCommissionEvidence(proof, checked.source.legacyOrderId, source); }
  }
  return facts;
}
export function initialLegacyFacts(source: LegacyContinuationSource, commissionEvidence?: LegacyCommissionEvidence[]): LegacyEffectiveFacts {
  const evidence = admitLegacyEvidence(source);
  const amounts = {
    payMoney: source.payMoney, saleEarnings: source.saleEarnings, returnOrderMoney: source.returnOrderMoney,
    fullPayoutMoney: source.fullPayoutMoney, detainMoney: source.detainMoney,
  };
  return assertLegacyEffectiveFacts({ schemaVersion: 1, evidence, amounts, ...(commissionEvidence ? { commissionEvidence: structuredClone(commissionEvidence) } : {}), derivedFromEvidenceId: null, derivedFromCommandVersionId: null });
}
export function sealLegacyFacts(facts: LegacyEffectiveFacts) {
  assertLegacyEffectiveFacts(facts);
  const canonical = canonicalize(facts);
  return { canonical, digest: sha256Hex(canonical) };
}
export function readSealedLegacyFacts(row: LegacyEvidenceRow): LegacyEffectiveFacts {
  if (sha256Hex(row.factsCanonical) !== row.factsDigest || canonicalize(JSON.parse(row.factsCanonical)) !== canonicalize(row.facts)) throw conflict("EVIDENCE_DIGEST_MISMATCH");
  return assertLegacyEffectiveFacts(row.facts);
}
/** A disposal plan is a delta. It must never replace the full confirmed settlement. */
export function deriveLegacyFacts(current: LegacyEffectiveFacts, plan: AmountPlan, command: LegacyCommand, evidenceId: string, versionId: string): LegacyEffectiveFacts {
  assertLegacyEffectiveFacts(current);
  const source = structuredClone(current.evidence.source);
  let amounts = { ...current.amounts, ...plan.amounts };
  if (plan.nextStatus !== null) source.orderStatus = plan.nextStatus;
  if (plan.isSettle !== null) source.isSettle = plan.isSettle;
  if (plan.isAdvanceSet !== null) source.isAdvanceSet = String(plan.isAdvanceSet);
  if (command.kind === "propose") source.quantities = structuredClone(command.quantities);
  for (const field of ["payMoney", "saleEarnings", "returnOrderMoney", "fullPayoutMoney", "detainMoney"] as const) {
    const value = plan.amounts[field];
    // A null unassigned payout in the old plan retains its known stored value.
    if (value !== undefined && value !== null) source[field] = value;
    amounts[field] = source[field];
  }
  if (command.kind === "reject") {
    source.saleEarnings = null; source.returnOrderMoney = null; source.fullPayoutMoney = "0";
    source.quantities = { expendHaff: null, barrett: "0", bullet: "0", awm: "0", armor: "0", helmet: "0", coffee: "0", card: "0" };
    amounts = { payMoney: source.payMoney, saleEarnings: null, returnOrderMoney: null, fullPayoutMoney: "0", detainMoney: source.detainMoney };
  }
  return assertLegacyEffectiveFacts({ schemaVersion: 1, evidence: admitLegacyEvidence(source), amounts, ...(current.commissionEvidence ? { commissionEvidence: structuredClone(current.commissionEvidence) } : {}), derivedFromEvidenceId: evidenceId, derivedFromCommandVersionId: versionId });
}
export function legacyContinuationRole(binding: LegacyOrderBinding, actor: LegacyContinuationActor): "renter" | "owner" | "admin" | "other" {
  return actor.realm === "admin" ? "admin" : actor.userId === binding.renterUserId ? "renter" : actor.userId === binding.ownerUserId ? "owner" : "other";
}
const LEGACY_OWNER_AMOUNTS = ["saleEarnings", "ownerNet", "fullPayoutMoney", "divide2", "expendAccount", "depositCompensation"];
const LEGACY_RENTER_AMOUNTS = ["payMoney", "returnOrderMoney", "refundGross", "refundNet", "detainMoney", "divide", "expendOrder"];
/** Stored evidence and fingerprints stay complete; only the authenticated party's output is narrowed. */
export function projectLegacyPartyAmounts<T>(binding: LegacyOrderBinding, actor: LegacyContinuationActor, amounts: Record<string, T>): Record<string, T> {
  if (legacyContinuationRole(binding, actor) === "other") throw notFound();
  if (actor.realm === "admin") return structuredClone(amounts);
  const fields = new Set([...(actor.userId === binding.ownerUserId ? LEGACY_OWNER_AMOUNTS : []), ...(actor.userId === binding.renterUserId ? LEGACY_RENTER_AMOUNTS : [])]);
  return Object.fromEntries(Object.entries(amounts).filter(([key]) => fields.has(key)));
}
/** Current command receipts contain IDs/status only; whitelist older cached bodies before sending them again. */
export function projectLegacyCommandReceipt(binding: LegacyOrderBinding, actor: LegacyContinuationActor, body: unknown): unknown {
  if (legacyContinuationRole(binding, actor) === "other") throw notFound();
  if (actor.realm === "admin") return structuredClone(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>, result: Record<string, unknown> = {};
  for (const key of ["orderId", "command", "revision", "versionId", "inputEvidenceId", "resultEvidenceId", "evidenceId", "stage", "channelState", "outcome", "status"]) {
    if (Object.hasOwn(source, key) && (source[key] === null || ["string", "number", "boolean"].includes(typeof source[key]))) result[key] = source[key];
  }
  for (const key of ["amounts", "previewAmounts", "proposalAmounts"]) {
    const value = source[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    result[key] = Object.fromEntries(Object.entries(projectLegacyPartyAmounts(binding, actor, value as Record<string, unknown>)).map(([name, amount]) => [name,
      amount === null || typeof amount === "string" ? amount : amount && typeof amount === "object" && !Array.isArray(amount)
        ? Object.fromEntries(Object.entries(amount).filter(([field, v]) => ["cents", "yuan"].includes(field) && typeof v === "string")) : null]));
  }
  const error = source.error;
  if (error && typeof error === "object" && !Array.isArray(error)) result.error = Object.fromEntries(Object.entries(error).filter(([key, value]) => (["code", "message", "requestId"].includes(key) && typeof value === "string") || (key === "reason" && visibleLegacyReason(value) !== undefined)));
  return result;
}
export function legacyCapabilities(source: LegacyContinuationSource, role: "renter" | "owner" | "admin" | "other", canOperate: boolean, disposition: LegacyFinanceDisposition): string[] {
  if (role === "other") return [];
  if (role === "admin") {
    if (!canOperate || !["NONE", "FINALIZED_ZERO"].includes(disposition)) return [];
    const deposit = source.isSettle === "0" ? ["hold"] : source.isSettle === "2" ? ["release", "confiscate"] : [];
    return [ ...(source.orderStatus === "3" ? ["preview", "propose"] : []), ...(["8", "9"].includes(source.orderStatus) ? ["confirm", "reject"] : []), ...deposit ];
  }
  if (source.orderStatus === "3") return ["preview", "propose"];
  if (source.orderStatus === (role === "owner" ? "8" : "9")) return ["confirm", "reject"];
  return [];
}
function legacyEarlyFee(amounts: Record<string, string | null>): string | null {
  try {
    const amount = (name: string) => BigInt(legacyPlanYuanToCents(amounts[name]!));
    const difference = amount("payMoney") - amount("divide") - amount("expendOrder") - amount("returnOrderMoney");
    return difference >= 0n ? formatScaledInteger(difference, 2) : null;
  } catch { return null; }
}
export function projectLegacyContinuation(binding: LegacyOrderBinding, actor: LegacyContinuationActor, evidence: LegacyEvidenceRow | null, head: LegacyHeadRow | null, duties: readonly LegacyDutyRow[], canOperate = false, disposition: LegacyFinanceDisposition = "UNKNOWN", canReadCommission = false,canSettle=false): LegacyContinuationView {
  const role = legacyContinuationRole(binding, actor);
  if (role === "other") throw notFound();
  const visibleDuties = actor.realm === "admin" ? duties.filter(d => d.kind !== "COMMISSION" || canReadCommission) : duties.filter(d => d.counterpartyUserId === actor.userId);
  const base = { schema: "legacy-continuation.v1" as const, revision: head?.revision ?? null, evidenceId: evidence?.id ?? null, channelState: "UNKNOWN" as const,
    duties: visibleDuties.map(d => ({ id: d.id, kind: d.kind, amountCents: d.amountCents, currency: d.currency, status: d.status, maturityAt: d.maturityAt, sourceStatus: d.sourceStatus, revision: d.revision, settledBy: d.settledBy, financeVerified:d.status==="SETTLED" && d.settledBy==="FINANCE" && disposition!=="UNKNOWN" })) };
  if (!evidence) return { ...base, availability: "NOT_IMPORTED", stage: null, isSettle: null, amounts: {}, quantities: null, capabilities: [], commandFingerprints: {}, reasons: ["NOT_IMPORTED"] };
  const facts = readSealedLegacyFacts(evidence), source = facts.evidence.source;
  const amounts = Object.fromEntries(Object.entries(projectLegacyPartyAmounts(binding, actor, facts.amounts)).map(([key, value]) => {
    const cents = value === null ? null : legacyPlanYuanToCents(value);
    return [key, cents === null ? null : { cents, yuan: formatScaledInteger(BigInt(cents), 2) }];
  }));
  const reasons = [...facts.evidence.reasons, ...(actor.realm === "admin" && disposition === "UNKNOWN" ? ["FINANCE_FACT_UNAVAILABLE"] : [])];
  const commandFingerprints: Record<string, string> = {};
  let confirmationAmounts: LegacyContinuationView["confirmationAmounts"] = null;
  const capabilities = (facts.evidence.admission === "PARAMETER_COMPLETE" ? legacyCapabilities(source, role, canOperate, disposition) : []).filter(kind => {
    if (kind === "preview" || kind === "propose") return true;
    if (role === "admin" && kind === "confirm" && !canSettle) return false;
    const plan = planLegacyContinuation(facts.evidence, { kind: kind as "confirm" | "reject" | "hold" | "release" | "confiscate", caller: { role, legacyUserId: role === "owner" ? binding.legacyOwnerId : role === "renter" ? binding.legacyRenterId : "" } });
    if (!plan.ok) { reasons.push(plan.code); return false; }
    if (role === "admin" && kind === "confirm") {
      const owner = plan.amounts.ownerNet, refund = plan.amounts.refundNet;
      if (typeof owner !== "string" || typeof refund !== "string") return false;
      const ownerCents = legacyPlanYuanToCents(owner), refundCents = legacyPlanYuanToCents(refund);
      confirmationAmounts = { ownerNet: { cents: ownerCents, yuan: formatScaledInteger(BigInt(ownerCents), 2) }, refundNet: { cents: refundCents, yuan: formatScaledInteger(BigInt(refundCents), 2) } };
    }
    commandFingerprints[kind] = plan.fingerprint; return true;
  });
  const settlementKind = ["8", "9", "4"].includes(source.orderStatus) ? source.isAdvanceSet === "1" ? "EARLY" : source.isAdvanceSet === "0" ? "NORMAL" : null : null;
  return { ...base, availability: facts.evidence.admission === "PARAMETER_COMPLETE" ? "KNOWN" : "ISOLATED", stage: source.orderStatus, isSettle: source.isSettle, amounts, quantities: structuredClone(source.quantities), capabilities, commandFingerprints, reasons,
    settlementKind, ...(role === "renter" && settlementKind === "EARLY" ? { earlyFee: legacyEarlyFee(facts.amounts) } : {}), ...(role === "renter" || role === "admin" ? { refundDueAt: head?.refundDueAt ?? null } : {}), ...(role === "admin" ? { confirmationAmounts, basis: { orderPrices: source.orderPrices, accountPrices: source.accountPrices, isFullPayout: source.isFullPayout, isAdvanceSet: source.isAdvanceSet, note: "旧单单价来自旧平台建单时价目；号主单价为迁移截点账号配置，不是下单时冻结值" } } : {}) };
}
export type CompletedCommissionTime = { kind: "COMPLETED_AT" | "MATURES_AT"; at: string; evidenceDigest: string };
export function legacyTimeMicros(value: string): bigint {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  const ms = Date.parse(match[1] + "Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
export function legacyCommissionMaturity(time: CompletedCommissionTime, cutoff: string): { maturityAt: string; maturedByCutoff: boolean } {
  if (!time || !["COMPLETED_AT", "MATURES_AT"].includes(time.kind) || !/^[a-f0-9]{64}$/.test(time.evidenceDigest) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(time.at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(cutoff)) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  const at = legacyTimeMicros(time.at), asOf = legacyTimeMicros(cutoff);
  const due = at + (time.kind === "COMPLETED_AT" ? 7n * 86400000000n : 0n);
  if (due < 0n || due > 253402300799999999n) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  return { maturityAt: new Date(Number(due / 1000000n) * 1000).toISOString().slice(0, 19) + "." + (due % 1000000n).toString().padStart(6, "0") + "Z", maturedByCutoff: due <= asOf };
}
export function previewLegacyContinuation(facts: LegacyEffectiveFacts, binding: LegacyOrderBinding, actor: LegacyContinuationActor, quantities: LegacyQuantities, onBehalf?: "renter" | "owner") {
  const role = legacyContinuationRole(binding, actor);
  if (role === "admin" ? !onBehalf : onBehalf !== undefined) throw invalid("STAFF_ROLE_INVALID");
  const caller = { role, legacyUserId: role === "owner" ? binding.legacyOwnerId : role === "renter" ? binding.legacyRenterId : "", ...(onBehalf ? { onBehalf } : {}) };
  const plan = planLegacyContinuation(facts.evidence, { kind: "preview", caller, quantities });
  if (!plan.ok) throw conflict(plan.code);
  const command = { kind: "propose" as const, caller, quantities };
  const proposal = planLegacyContinuation(facts.evidence, command);
  if (!proposal.ok) throw conflict(proposal.code);
  try { deriveLegacyFacts(facts, proposal, command, "preview", "preview"); }
  catch (error) { if (error instanceof Error && error.message === "PRECISION_UNSUPPORTED") throw conflict("PRECISION_UNSUPPORTED"); throw error; }
  const display = (amounts: Record<string, string | null>) => Object.fromEntries(Object.entries(projectLegacyPartyAmounts(binding, actor, amounts))
    .map(([key, value]) => [key, value === null ? null : formatScaledInteger(divideToScale(parseNonNegativeDecimal(value, 18, "legacy preview"), { value: 1n, scale: 0 }, 2).value, 2)]));
  return { previewAmounts: display(plan.amounts), proposalAmounts: display(proposal.amounts),
    proposalFingerprint: proposal.fingerprint, settlementKind: proposal.isAdvanceSet === 1 ? "EARLY" as const : "NORMAL" as const,
    ...(role === "renter" ? { earlyFee: proposal.isAdvanceSet === 1 ? legacyEarlyFee(proposal.amounts) : null } : {}) };
}
