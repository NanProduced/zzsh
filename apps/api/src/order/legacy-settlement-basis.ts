import type { PoolClient } from "pg";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { conflict, invalid, newSupplyId, sha256Hex } from "../supply/supply-util";
import { planVerifiedLegacySettlement, type LegacyPrices, type LegacyQuantities, type LegacySettlementBasis } from "./legacy-continuation-calc";
import { legacyPlanYuanToCents, readSealedLegacyFacts, type LegacyContinuationActor, type LegacyEvidenceRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";

const ACTION = "order.legacy.settlement_basis.verified";
const NAMES = ["barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AMOUNT = /^(0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;
export type BasisInput = { expectedRevision: string | null; inputEvidenceId: string; expectedBasisId: string | null;
  openingHaffM: string; baseBot: string; ownerPrices: LegacyPrices; openingItems: LegacyQuantities;
  fullPayout: boolean; partiesVerified: true; reason: string };
type StoredBasis = { basis: LegacySettlementBasis; ordinal: string; sourceDigest: string; evidenceId: string; headRevision: string | null };

export function projectLegacySettlementBasis(basis: LegacySettlementBasis) {
  return { id: basis.id, openingHaffM: basis.openingHaffM, openingItems: structuredClone(basis.openingItems),
    fullPayout: basis.fullPayout, source: "STAFF_VERIFIED" as const };
}

export function parseLegacyOwnerPrices(value: unknown): LegacyPrices {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...NAMES].sort().join(",")) throw invalid("OWNER_PRICES_INVALID");
  const row = value as Record<string, unknown>;
  for (const key of NAMES) if (row[key] !== null && (typeof row[key] !== "string" || !AMOUNT.test(row[key] as string))) throw invalid("OWNER_PRICES_INVALID");
  return row as LegacyPrices;
}

/** The order advisory lock serializes writers; audit ordinal provides stable ordering and recovery. */
async function latest(client: PoolClient, orderId: string): Promise<StoredBasis | null> {
  const rows = (await client.query<{details: Record<string, unknown>}>(`SELECT details FROM zzsh_iam.audit_event
    WHERE action=$1 AND object_type='rental_order' AND object_id=$2 AND outcome='SUCCESS'
    ORDER BY CASE WHEN details->>'ordinal' ~ '^[1-9][0-9]{0,17}$' THEN (details->>'ordinal')::numeric ELSE NULL END DESC NULLS FIRST,id DESC LIMIT 2`, [ACTION, orderId])).rows;
  if (!rows.length) return null;
  const first = rows[0]!.details as unknown as StoredBasis & {schema?:string; basisDigest?:string; partiesVerified?:boolean};
  if (!first || first.schema !== "legacy-settlement-basis.v1" || !/^[1-9]\d{0,17}$/.test(first.ordinal ?? "")
    || !first.basis || !ID.test(first.basis.id ?? "") || first.basisDigest !== sha256Hex(canonicalize(first.basis))
    || first.partiesVerified !== true || !/^[a-f0-9]{64}$/.test(first.sourceDigest ?? "") || !ID.test(first.evidenceId ?? "")
    || first.headRevision !== null && !/^[1-9]\d{0,17}$/.test(first.headRevision ?? "")
    || rows[1] && (rows[1].details.ordinal === first.ordinal || typeof rows[1].details.ordinal !== "string")) throw conflict("OPENING_BASIS_UNAVAILABLE");
  return first;
}

export async function readLegacySettlementBasis(client: PoolClient, binding: LegacyOrderBinding, row: LegacyEvidenceRow, head: LegacyHeadRow | null): Promise<LegacySettlementBasis | null> {
  const found = await latest(client, binding.id);
  if (!found || found.sourceDigest !== binding.sourceDigest || found.evidenceId !== row.id || found.headRevision !== (head?.revision ?? null)) return null;
  return found.basis;
}

export async function readLatestLegacySettlementBasisId(client: PoolClient, binding: LegacyOrderBinding): Promise<string | null> {
  const found = await latest(client, binding.id);
  if (found && found.sourceDigest !== binding.sourceDigest) throw conflict("OPENING_BASIS_UNAVAILABLE");
  return found?.basis.id ?? null;
}

export async function readLegacyProposalBasis(client: PoolClient, binding: LegacyOrderBinding, basisId: string, evidenceId: string): Promise<LegacySettlementBasis | null> {
  const found = await latest(client, binding.id);
  if (!found || found.sourceDigest !== binding.sourceDigest || found.evidenceId !== evidenceId || found.basis.id !== basisId) return null;
  return found.basis;
}

export async function readLegacyBasisInputEvidence(client: PoolClient, binding: LegacyOrderBinding, evidenceId: string): Promise<LegacyEvidenceRow | null> {
  if (!ID.test(evidenceId)) throw conflict("OPENING_BASIS_UNAVAILABLE");
  const row = (await client.query<LegacyEvidenceRow>(`SELECT id,order_id AS "orderId",evidence_version::text AS "evidenceVersion",source_kind AS "sourceKind",
    source_digest AS "sourceDigest",facts_digest AS "factsDigest",facts_canonical AS "factsCanonical",facts
    FROM zzsh_order.legacy_continuation_evidence WHERE order_id=$1 AND id=$2`, [binding.id,evidenceId])).rows[0] ?? null;
  if (!row || row.sourceDigest !== binding.sourceDigest) return null;
  readSealedLegacyFacts(row);
  return row;
}

/** A party acknowledgement is not a settlement posting or a channel refund. */
export async function legacyEarlyPartyConfirmed(client: PoolClient, binding: LegacyOrderBinding, head: LegacyHeadRow, row: LegacyEvidenceRow): Promise<boolean> {
  const source=readSealedLegacyFacts(row).evidence.source, basis=source.settlementV2;
  if (!basis || source.isAdvanceSet !== "1" || !["8","9"].includes(source.orderStatus)) return false;
  const partyId=source.orderStatus==="8"?binding.ownerUserId:binding.renterUserId;
  const result=(await client.query<{confirmed:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event
    WHERE action='order.legacy.settlement.party_confirmed' AND object_type='rental_order' AND object_id=$1
      AND actor_type='user' AND actor_id=$2 AND outcome='SUCCESS' AND details->>'headId'=$3
      AND details->>'evidenceId'=$4 AND details->>'basisId'=$5 AND details->>'sourceDigest'=$6) AS confirmed`,
    [binding.id,partyId,head.id,row.id,basis.basisId,binding.sourceDigest])).rows[0];
  if (typeof result?.confirmed !== "boolean") throw conflict("FINANCE_FACT_UNAVAILABLE");
  return result.confirmed;
}

/** Called after current admin/game authorization and the shared order lock. */
export async function recordLegacySettlementBasis(client: PoolClient, actor: LegacyContinuationActor, binding: LegacyOrderBinding,
  row: LegacyEvidenceRow, head: LegacyHeadRow | null, input: BasisInput) {
  if (actor.realm !== "admin" || input.partiesVerified !== true || typeof input.reason !== "string"
    || [...input.reason.trim()].length < 3 || Buffer.byteLength(input.reason, "utf8") > 600 || /[\u0000-\u001f\u007f]/.test(input.reason)
    || input.inputEvidenceId !== row.id || input.expectedRevision !== (head?.revision ?? null)
    || input.expectedBasisId !== null && !ID.test(input.expectedBasisId)) throw invalid("OPENING_BASIS_INVALID");
  const facts = readSealedLegacyFacts(row);
  if (facts.evidence.source.orderStatus !== "3" || binding.sourcePayStatus !== 1 || binding.paidCents === null
    || facts.evidence.source.legacyOrderId !== binding.legacyId || facts.evidence.source.renterId !== binding.legacyRenterId
    || facts.evidence.source.ownerId !== binding.legacyOwnerId || facts.evidence.source.accountId !== binding.legacyAccountId
    || facts.evidence.source.payMoney === null || legacyPlanYuanToCents(facts.evidence.source.payMoney) !== binding.paidCents) throw conflict("OPENING_BASIS_UNAVAILABLE");
  const previous = await latest(client, binding.id);
  if ((previous?.basis.id ?? null) !== input.expectedBasisId) throw conflict("OPENING_BASIS_CHANGED");
  const ordinal = (BigInt(previous?.ordinal ?? "0") + 1n).toString();
  if (ordinal.length > 18) throw conflict("OPENING_BASIS_UNAVAILABLE");
  const basis: LegacySettlementBasis = { id: newSupplyId("legacy_basis"), openingHaffM: input.openingHaffM, baseBot: input.baseBot,
    ownerPrices: parseLegacyOwnerPrices(input.ownerPrices), openingItems: structuredClone(input.openingItems), fullPayout: input.fullPayout };
  // Check the original ratio against the old order without asserting any later consumption.
  const probe = {expendHaff:basis.openingHaffM,...Object.fromEntries(NAMES.map(name=>[name,"0"]))} as LegacyQuantities;
  const plan = planVerifiedLegacySettlement(facts.evidence, { kind: "propose", caller: {role:"admin",legacyUserId:"",onBehalf:"renter"}, quantities: probe, endReason:"NORMAL" }, basis);
  if (!plan.ok) throw conflict(plan.code);
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId,
    action: ACTION, objectType: "rental_order", objectId: binding.id, outcome: "SUCCESS", reason: input.reason.trim(),
    details: { schema:"legacy-settlement-basis.v1", ordinal, sourceDigest:binding.sourceDigest, evidenceId:row.id,
      headRevision:head?.revision ?? null, partiesVerified:true, basis, basisDigest:sha256Hex(canonicalize(basis)) } });
  return { status:200, body:{orderId:binding.id,basisId:basis.id,basisRevision:ordinal,state:"VERIFIED"} };
}
