import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { isEffectivePublicationState } from "./listing-query";
import { conflict, invalid } from "./supply-util";
import {
  validateFundingPolicy,
  validateOwnerDepositAmount,
  validateOwnerDepositDeclaration,
  type FundingPolicy,
  type OwnerDepositDeclaration,
} from "./funding-policy";
import type { ConfirmationFunding, ConfirmationFundingReader } from "../order/personal-confirmation";
import type { ListingVersion, PublishingAccount, SupplyGate, SupplyGateReader } from "./publishing";

type PolicyRow = { priceVersionId: string; policy: unknown | null; status: string; gameId: string; releaseId: string };
type ProofRow = {
  id: string;
  versionNo: string;
  ownerUserId: string;
  accountId: string;
  priceVersionId: string;
  policyVersion: string;
  status: "SATISFIED" | "NOT_REQUIRED" | "REVOKED";
  requiredCents: string;
  coveredCents: string;
  valid: boolean;
  validUntil: string | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const unknownGate = (): SupplyGate => ({ publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
const unavailable = (): null => null;

export async function readFundingPolicyForRelease(client: PoolClient, releaseId: string): Promise<FundingPolicy | null> {
  const row = (await client.query<{ policy: unknown | null }>(
    `SELECT p.funding_policy AS policy
       FROM zzsh_supply.rule_release r
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE r.id=$1 AND p.status='SEALED'`,
    [releaseId],
  )).rows[0];
  if (!row || row.policy === null) return null;
  return validateFundingPolicy(row.policy);
}

async function currentPolicyForAccount(client: PoolClient, accountId: string, ownerUserId: string): Promise<PolicyRow | null> {
  const row = (await client.query<PolicyRow>(
    `SELECT p.id AS "priceVersionId",p.funding_policy AS policy,p.status,
            a.game_id AS "gameId",r.id AS "releaseId"
       FROM zzsh_supply.rental_account a
       JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id IS NOT NULL
       JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=a.game_id
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE a.id=$1 AND a.owner_user_id=$2`,
    [accountId, ownerUserId],
  )).rows[0];
  return row ?? null;
}

async function latestProof(client: PoolClient, accountId: string): Promise<ProofRow | null> {
  const row = (await client.query<ProofRow>(
    `SELECT id,version_no::text AS "versionNo",owner_user_id AS "ownerUserId",account_id AS "accountId",
            price_version_id AS "priceVersionId",policy_version AS "policyVersion",status,
            required_cents::text AS "requiredCents",covered_cents::text AS "coveredCents",
            valid_until::text AS "validUntil",
            (valid_from <= clock_timestamp() AND (valid_until IS NULL OR clock_timestamp() < valid_until)) AS valid
       FROM zzsh_supply.account_guarantee_proof
      WHERE account_id=$1 ORDER BY version_no DESC LIMIT 1`,
    [accountId],
  )).rows[0];
  return row ?? null;
}

function effectiveProof(
  policy: FundingPolicy,
  expectedPriceVersionId: string,
  expectedAccountId: string,
  expectedOwnerUserId: string,
  proof: ProofRow | null,
): ProofRow | null {
  if (!proof || !proof.valid) return null;
  if (
    proof.priceVersionId !== expectedPriceVersionId
    || proof.accountId !== expectedAccountId
    || proof.ownerUserId !== expectedOwnerUserId
  ) return null;
  if (policy.guaranteeRequirement.mode === "NOT_REQUIRED") {
    return proof.status === "NOT_REQUIRED" && proof.policyVersion === policy.policyVersion && proof.requiredCents === "0" && proof.coveredCents === "0" && proof.validUntil === null ? proof : null;
  }
  return proof.status === "SATISFIED" && proof.policyVersion === policy.policyVersion && proof.requiredCents === policy.guaranteeRequirement.requiredCents && BigInt(proof.coveredCents) >= BigInt(policy.guaranteeRequirement.requiredCents) ? proof : null;
}

async function readFormalContext(client: PoolClient, accountId: string, ownerUserId: string, versionId?: string): Promise<{ policy: FundingPolicy; proof: ProofRow; priceVersionId: string; releaseId: string; gameId: string } | null> {
  const policyRow = versionId
    ? (await client.query<PolicyRow & { versionId: string; ownerUserId: string; accountId: string; contentHash: string | null; payload: ListingVersion["payload"]; currentVersionId: string | null; publicationSource: string | null }>(
      `SELECT p.id AS "priceVersionId",p.funding_policy AS policy,p.status,
              a.game_id AS "gameId",r.id AS "releaseId",v.id AS "versionId",
              a.owner_user_id AS "ownerUserId",a.current_version_id AS "currentVersionId",
              v.account_id AS "accountId",v.content_hash AS "contentHash",v.payload,
              pub.source AS "publicationSource"
         FROM zzsh_supply.listing_version v
         JOIN zzsh_supply.rental_account a ON a.id=v.account_id
         JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id=v.rule_release_id
         JOIN zzsh_supply.rule_release r ON r.id=v.rule_release_id AND r.game_id=a.game_id
         JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
         LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id
        WHERE v.id=$1 AND v.account_id=$2 AND a.owner_user_id=$3 AND p.status='SEALED'`,
      [versionId, accountId, ownerUserId],
    )).rows[0]
    : await currentPolicyForAccount(client, accountId, ownerUserId);
  if (!policyRow || policyRow.policy === null || policyRow.status !== "SEALED") return null;
  const policy = validateFundingPolicy(policyRow.policy);
  const proof = effectiveProof(policy, policyRow.priceVersionId, accountId, ownerUserId, await latestProof(client, accountId));
  if (!proof) return null;
  return { policy, proof, priceVersionId: policyRow.priceVersionId, releaseId: policyRow.releaseId, gameId: policyRow.gameId };
}

export const readFormalSupplyGate: SupplyGateReader = async (client, account) => {
  try {
    const context = await readFormalContext(client, account.id, account.owner_user_id);
    if (!context) return unknownGate();
    return { publisherBail: context.policy.guaranteeRequirement.mode === "NOT_REQUIRED" ? "NOT_REQUIRED" : "SATISFIED", occupancy: "FREE", reference: context.proof.id };
  } catch {
    return unknownGate();
  }
};

function fullPayout(value: unknown): { schema: "full-payout-declaration-v1"; selected: boolean } | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "schema,selected" || entry.schema !== "full-payout-declaration-v1" || typeof entry.selected !== "boolean") return null;
  return { schema: "full-payout-declaration-v1", selected: entry.selected };
}

export const readFormalConfirmationFunding: ConfirmationFundingReader = async (client, account, version) => {
  try {
    const context = await readFormalContext(client, account.id, account.owner_user_id, version.id);
    if (!context || account.current_version_id !== version.id || !version.payload || !version.content_hash) return unavailable();
    const publication = (await client.query<{ source: string }>(
      `SELECT source FROM zzsh_supply.listing_publication
        WHERE version_id=$1 AND account_id=$2 AND owner_user_id=$3 AND rule_release_id=$4 AND content_hash=$5 LIMIT 1`,
      [version.id, account.id, account.owner_user_id, version.rule_release_id, version.content_hash],
    )).rows[0];
    if (!isEffectivePublicationState(version.review_state, publication?.source)) return unavailable();
    if (context.releaseId !== version.rule_release_id || context.priceVersionId !== version.payload.ruleRefs.priceVersionId) return unavailable();
    const declaration = validateOwnerDepositDeclaration(version.payload.declaration.attributes.owner_deposit_declaration);
    if (!declaration) return unavailable();
    const selected = fullPayout(version.payload.declaration.attributes.full_payout_declaration);
    if (selected === null) return unavailable();
    validateOwnerDepositAmount(context.policy, declaration.amountCents, selected.selected);
    const fundingBase = {
      version: context.policy.policyVersion,
      sourceRef: `funding-policy:${context.priceVersionId}:${context.policy.policyVersion}:guarantee:${context.proof.id}`,
      baseDepositCents: declaration.amountCents,
      publisherBailRequirementCents: context.policy.guaranteeRequirement.requiredCents,
      vipWaiver: context.policy.vipWaiver,
      svipWaiver: context.policy.svipWaiver,
      fullPayoutPolicyRef: context.policy.fullPayoutPolicyRef,
    };
    return { schema: "personal-quote-v2", ...fundingBase, fullPayoutPolicyVersion: context.policy.fullPayoutPolicyVersion, disclosureVersion: context.policy.disclosureVersion };
  } catch {
    return unavailable();
  }
};

const productionReaders = new WeakSet<ConfirmationFundingReader>();

export function createProductionConfirmationFundingReader(): ConfirmationFundingReader {
  const reader: ConfirmationFundingReader = readFormalConfirmationFunding;
  productionReaders.add(reader);
  return reader;
}

export function isProductionConfirmationFundingReader(reader: ConfirmationFundingReader): boolean {
  return productionReaders.has(reader) || reader === readFormalConfirmationFunding;
}

export type GuaranteeProofWriteInput = {
  expectedProofVersion: string;
  expectedPolicyVersion: string;
  status: "SATISFIED" | "NOT_REQUIRED" | "REVOKED";
  coveredCents?: string;
  evidenceRef: string;
  evidenceDigest: string;
  reason: string;
};

export async function appendAccountGuaranteeProof(client: PoolClient, adminUserId: string, accountId: string, input: GuaranteeProofWriteInput): Promise<Record<string, unknown>> {
  if (!/^(0|[1-9]\d{0,18})$/.test(input.expectedProofVersion)) throw invalid("Expected proof version is invalid");
  if (!ID.test(input.expectedPolicyVersion)) throw invalid("Expected policy version is invalid");
  if (!ID.test(input.evidenceRef) || !/^[0-9a-f]{64}$/.test(input.evidenceDigest)) throw invalid("Proof evidence is invalid");
  if (input.reason.trim().length < 2 || input.reason.length > 500) throw invalid("Proof reason is invalid");
  const account = (await client.query<{ id: string; ownerUserId: string; gameId: string }>(
    `SELECT id,owner_user_id AS "ownerUserId",game_id AS "gameId" FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [accountId],
  )).rows[0];
  if (!account) throw conflict("Account guarantee target is unavailable");
  const policyRow = await currentPolicyForAccount(client, account.id, account.ownerUserId);
  if (!policyRow || policyRow.policy === null || policyRow.status !== "SEALED") throw new SecurityApiError(503, "CONFIRMATION_DEPENDENCY_UNAVAILABLE", "Funding policy is unavailable");
  const policy = validateFundingPolicy(policyRow.policy);
  if (policy.policyVersion !== input.expectedPolicyVersion) throw conflict("Funding policy changed; refresh and retry");
  const previous = await latestProof(client, account.id);
  const expected = previous ? previous.versionNo : "0";
  if (expected !== input.expectedProofVersion) throw conflict("Guarantee proof changed; refresh and retry");
  if (input.status === "REVOKED" && !previous) throw conflict("There is no guarantee proof to revoke");
  if (input.status === "REVOKED" && previous?.status === "REVOKED") throw conflict("Guarantee proof is already revoked");
  const requiredCents = input.status === "NOT_REQUIRED" ? "0" : input.status === "REVOKED" ? previous!.requiredCents : policy.guaranteeRequirement.requiredCents;
  const coveredCents = input.status === "NOT_REQUIRED" ? "0" : input.status === "REVOKED" ? previous!.coveredCents : input.coveredCents ?? "";
  if (!/^(0|[1-9]\d{0,23})$/.test(coveredCents)) throw invalid("Covered guarantee amount is invalid");
  if (input.status === "SATISFIED" && (policy.guaranteeRequirement.mode !== "FIXED_CENTS" || BigInt(coveredCents) < BigInt(requiredCents))) throw invalid("Guarantee coverage is insufficient");
  if (input.status === "NOT_REQUIRED" && policy.guaranteeRequirement.mode !== "NOT_REQUIRED") throw invalid("The current policy requires a guarantee");
  const versionNo = (BigInt(expected) + 1n).toString();
  const id = `proof_${randomUUID().replaceAll("-", "")}`;
  const row = (await client.query(
    `INSERT INTO zzsh_supply.account_guarantee_proof
      (id,account_id,owner_user_id,version_no,price_version_id,policy_version,status,required_cents,covered_cents,evidence_ref,evidence_digest,verified_by_admin_id,valid_from,valid_until,supersedes_id,reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp(),
       CASE WHEN $7='SATISFIED' THEN clock_timestamp()+($13::numeric * interval '1 day')
            WHEN $7='REVOKED' THEN clock_timestamp() ELSE NULL END,
       $14,$15)
     RETURNING id,account_id AS "accountId",owner_user_id AS "ownerUserId",version_no::text AS "versionNo",price_version_id AS "priceVersionId",policy_version AS "policyVersion",status,required_cents::text AS "requiredCents",covered_cents::text AS "coveredCents",valid_from AS "validFrom",valid_until AS "validUntil",supersedes_id AS "supersedesId",evidence_ref AS "evidenceRef",evidence_digest AS "evidenceDigest",verified_by_admin_id AS "verifiedByAdminId",reason,created_at AS "createdAt"`,
    [id, account.id, account.ownerUserId, versionNo, policyRow.priceVersionId, policy.policyVersion, input.status, requiredCents, coveredCents, input.evidenceRef, input.evidenceDigest, adminUserId, policy.proofValidity.satisfiedDays, previous?.id ?? null, input.reason],
  )).rows[0];
  return row as Record<string, unknown>;
}

export async function readLatestAccountGuaranteeProof(client: PoolClient, accountId: string): Promise<Record<string, unknown> | null> {
  return (await client.query(
    `SELECT id,account_id AS "accountId",owner_user_id AS "ownerUserId",version_no::text AS "versionNo",price_version_id AS "priceVersionId",policy_version AS "policyVersion",status,required_cents::text AS "requiredCents",covered_cents::text AS "coveredCents",valid_from AS "validFrom",valid_until AS "validUntil",supersedes_id AS "supersedesId",evidence_ref AS "evidenceRef",evidence_digest AS "evidenceDigest",verified_by_admin_id AS "verifiedByAdminId",reason,created_at AS "createdAt"
       FROM zzsh_supply.account_guarantee_proof WHERE account_id=$1 ORDER BY version_no DESC LIMIT 1`, [accountId])).rows[0] ?? null;
}
