import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { humanText } from "./content-hash";
import type { FundingPolicy } from "./funding-policy";
import { conflict, ensureOnlyFields, invalid } from "./supply-util";

export type FullPayoutTermsAcceptance = { termsVersionId: string; termsDigest: string; disclosureVersion: string };
export type FullPayoutTerms = FullPayoutTermsAcceptance & {
  policyRef: string; policyVersion: string; title: string; body: string;
};
type PolicyRefs = Pick<FundingPolicy, "fullPayoutPolicyRef" | "fullPayoutPolicyVersion" | "disclosureVersion">;

export function parseFullPayoutTermsAcceptance(value: unknown): FullPayoutTermsAcceptance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid full-payout terms acceptance", "fullPayoutTermsAcceptance");
  const body = value as Record<string, unknown>;
  ensureOnlyFields(body, ["termsVersionId", "termsDigest", "disclosureVersion"]);
  if (typeof body.termsVersionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.termsVersionId)
    || typeof body.termsDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.termsDigest)
    || typeof body.disclosureVersion !== "string" || !body.disclosureVersion.trim() || body.disclosureVersion.length > 160) {
    throw invalid("Invalid full-payout terms acceptance", "fullPayoutTermsAcceptance");
  }
  return { termsVersionId: body.termsVersionId, termsDigest: body.termsDigest, disclosureVersion: body.disclosureVersion };
}

export function assertFullPayoutTermsAccepted(terms: FullPayoutTerms, value: unknown): FullPayoutTermsAcceptance {
  const accepted = parseFullPayoutTermsAcceptance(value);
  if (!accepted || accepted.termsVersionId !== terms.termsVersionId || accepted.termsDigest !== terms.termsDigest
    || accepted.disclosureVersion !== terms.disclosureVersion) {
    throw conflict("请阅读并确认这份报价实际适用的包赔条款");
  }
  return accepted;
}

export function fullPayoutDraftFields(body: Record<string, unknown>) {
  const fields: Record<string, string> = {};
  for (const name of ["policyRef", "policyVersion", "disclosureVersion", "title", "body"]) {
    if (typeof body[name] !== "string") throw invalid("Full-payout terms field is required", name);
    const value = humanText(body[name] as string);
    if (!value.trim() || (name === "body" ? Buffer.byteLength(value, "utf8") > 20_000 : value.length > (name === "title" ? 120 : 160))) {
      throw invalid("Full-payout terms field is invalid", name);
    }
    fields[name] = value;
  }
  return { ...fields, digest: createHash("sha256").update(fields.body!, "utf8").digest("hex") } as {
    policyRef: string; policyVersion: string; disclosureVersion: string; title: string; body: string; digest: string;
  };
}

export function verifyFullPayoutTermsRow(row: Record<string, unknown>): void {
  const fields = fullPayoutDraftFields({ policyRef: row.policy_ref, policyVersion: row.policy_version,
    disclosureVersion: row.disclosure_version, title: row.title, body: row.body });
  if (fields.body !== row.body || fields.digest !== row.digest) throw conflict("包赔条款正文与摘要不一致");
}

export async function readFullPayoutTerms(client: PoolClient, gameId: string, policy: PolicyRefs, priceVersionId?: string): Promise<FullPayoutTerms> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT t.id,t.policy_ref,t.policy_version,t.disclosure_version,t.title,t.body,t.digest,t.status
       FROM zzsh_supply.full_payout_terms_version t
       ${priceVersionId ? `JOIN zzsh_supply.price_version p ON p.id=$4 AND p.game_id=t.game_id AND p.status='SEALED'
         AND p.full_payout_terms_version_id=t.id AND p.full_payout_terms_digest=t.digest AND p.full_payout_disclosure_version=t.disclosure_version` : ""}
      WHERE t.game_id=$1 AND t.policy_ref=$2 AND t.policy_version=$3 AND t.status='SEALED'`,
    [gameId, policy.fullPayoutPolicyRef, policy.fullPayoutPolicyVersion, ...(priceVersionId ? [priceVersionId] : [])],
  )).rows[0];
  if (!row || row.status !== "SEALED" || row.policy_ref !== policy.fullPayoutPolicyRef
    || row.policy_version !== policy.fullPayoutPolicyVersion || row.disclosure_version !== policy.disclosureVersion) {
    throw conflict("适用的包赔条款未配置、未封存或版本不一致");
  }
  verifyFullPayoutTermsRow(row);
  return { termsVersionId: String(row.id), termsDigest: String(row.digest), disclosureVersion: String(row.disclosure_version),
    policyRef: String(row.policy_ref), policyVersion: String(row.policy_version), title: String(row.title), body: String(row.body) };
}

export function fullPayoutTermsSourceSuffix(terms: FullPayoutTerms): string {
  return `:full-payout-terms:${terms.termsVersionId}:${terms.termsDigest}`;
}
