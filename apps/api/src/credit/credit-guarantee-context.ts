import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { canonicalize } from "../supply/content-hash";
import { parseNonNegativeDecimal } from "../supply/decimal";
import { effectiveRuleRelease } from "../supply/effective-rule-release";
import { validateFundingPolicy, type FundingPolicy } from "../supply/funding-policy";
import { invalid } from "../supply/supply-util";
import { CREDIT_GUARANTEE_CAP_CENTS, CREDIT_GUARANTEE_THRESHOLD } from "./credit-guarantee-internals";

export type GuaranteeState = "NOT_REQUIRED" | "REQUIRED" | "PAYMENT_PENDING" | "SATISFIED" | "REFUND_REQUESTED" | "REFUND_PROCESSING" | "REFUNDED" | "FAILED" | "UNKNOWN";

function guaranteeReference(input: {
  accountId: string;
  ownerUserId: string;
  gameId: string;
  versionId: string | null;
  priceVersionId: string;
  releaseId: string;
  creditRevision: string | null;
  coverageRevision: string | null;
  state: GuaranteeState;
  requiredCents: string;
}): string {
  return `credit-guarantee-v1:${createHash("sha256").update(canonicalize(input)).digest("hex")}`;
}

export function requiredGuaranteeCents(standardRentalAndResourceCents: string | bigint): string {
  const base = typeof standardRentalAndResourceCents === "bigint" ? standardRentalAndResourceCents : BigInt(standardRentalAndResourceCents);
  if (base < 0n) throw invalid("Standard rental amount cannot be negative");
  const numerator = base * 5n;
  const rounded = numerator / 100n + (numerator % 100n >= 50n ? 1n : 0n);
  return (rounded > CREDIT_GUARANTEE_CAP_CENTS ? CREDIT_GUARANTEE_CAP_CENTS : rounded).toString();
}

function quoteResourceCents(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const quote = (payload as Record<string, unknown>).quoteValues;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return null;
  const pricingInputs = (quote as Record<string, unknown>).pricingInputs;
  if (pricingInputs && typeof pricingInputs === "object" && !Array.isArray(pricingInputs)) {
    const compatibility = (pricingInputs as Record<string, unknown>).compatibility;
    if (compatibility && typeof compatibility === "object" && !Array.isArray(compatibility) && (compatibility as Record<string, unknown>).customerTier !== "STANDARD") return null;
  }
  const amount = (quote as Record<string, unknown>).resourceTotal;
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) return null;
  const item = amount as Record<string, unknown>;
  if (item.currency !== "CNY" || item.unit !== "yuan" || item.scale !== 2 || typeof item.amount !== "string") return null;
  try {
    const parsed = parseNonNegativeDecimal(item.amount, 2, "resourceTotal");
    return (parsed.value * 10n ** BigInt(2 - parsed.scale)).toString();
  } catch {
    return null;
  }
}

type GuaranteeContextRow = { accountId: string; ownerUserId: string; gameId: string; currentVersionId: string | null; versionId: string | null; versionState?: string | null; publicationId?: string | null; publicationWaived?: boolean | null; publicationWaivedRevision?: string | null; otherOutstandingRequirementId?: string | null; priceVersionId: string; releaseId: string; policy: unknown; policyStatus: string; payload: unknown; priceStatus: string };
const OTHER_OUTSTANDING_GUARANTEE_SQL = `(SELECT previous.id FROM zzsh_order.owner_guarantee_requirement previous
  JOIN zzsh_order.owner_guarantee_payment paid ON paid.requirement_id=previous.id AND paid.owner_user_id=previous.owner_user_id
  WHERE previous.account_id=a.id AND previous.owner_user_id=a.owner_user_id
    AND (previous.price_version_id IS DISTINCT FROM p.id OR previous.listing_version_id IS DISTINCT FROM v.id)
    AND paid.status<>'FAILED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_refund refunded
      WHERE refunded.payment_id=paid.id AND refunded.status='SUCCEEDED' AND refunded.provider_request_state='SUCCEEDED'
        AND refunded.amount_cents=COALESCE(paid.observed_amount_cents,paid.amount_cents)
        AND EXISTS(SELECT 1 FROM zzsh_order.finance_event e JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
          JOIN zzsh_order.settlement_ledger_entry cash ON cash.id=refunded.ledger_entry_ref AND cash.finance_event_id=e.id
          WHERE e.id=refunded.finance_event_id AND e.kind='GUARANTEE_REFUND' AND e.subject_user_id=previous.owner_user_id
            AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_refund' AND root.source_id=refunded.id
            AND root.subject_user_id=previous.owner_user_id AND root.source_digest=refunded.source_digest
            AND cash.account_code='GUARANTEE_CASH' AND cash.debit_cents=0 AND cash.credit_cents=refunded.amount_cents))
  ORDER BY previous.created_at DESC,previous.id DESC LIMIT 1)`;
type GuaranteeBindingRow = {
  requirementId: string;
  requirementStatus: string;
  bindingBaseCents: string;
  bindingRequiredCents: string;
  bindingScore?: number;
  paymentId: string | null;
  paymentState: string | null;
  paymentProviderState: string | null;
  paymentAmountCents: string | null;
  paymentObservedAmountCents: string | null;
  paymentFinanceEventId: string | null;
  paymentLedgerEntryRef: string | null;
  confirmedCents: string;
  unrecognizedPayment: boolean;
  refundId: string | null;
  refundState: string | null;
  refundProviderState: string | null;
  refundAmountCents: string | null;
  refundPolicyState: string | null;
  refundFinanceEventId: string | null;
  refundLedgerEntryRef: string | null;
  succeededRefundCents: string;
  activeRefund: boolean;
  updatedAt: string;
};
export type GuaranteeContext = {
  accountId: string;
  ownerUserId: string;
  gameId: string;
  requirementId?: string;
  versionId: string | null;
  priceVersionId: string;
  releaseId: string;
  policy: FundingPolicy;
  baseCents: string | null;
  requiredCents: string;
  score: number | null;
  creditRevision: string | null;
  coverageRevision: string | null;
  state: GuaranteeState;
  reference: string | null;
  reasonCode?: string;
  paymentId?: string | null;
  paymentState?: string | null;
  paymentProviderState?: string | null;
  paymentAmountCents?: string | null;
  paymentObservedAmountCents?: string | null;
  paymentFinanceEventId?: string | null;
  paymentLedgerEntryRef?: string | null;
  refundId?: string | null;
  refundState?: string | null;
  refundProviderState?: string | null;
  refundAmountCents?: string | null;
  refundPolicyState?: string | null;
  refundFinanceEventId?: string | null;
  refundLedgerEntryRef?: string | null;
};

export async function readGuaranteeContext(client: PoolClient, accountId: string, ownerUserId: string, versionId?: string): Promise<GuaranteeContext | null> {
  // A published account keeps the guarantee basis accepted at publication; a draft uses current rules.
  const row = (await client.query<GuaranteeContextRow>(
    `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",a.game_id AS "gameId",a.current_version_id AS "currentVersionId",
            v.id AS "versionId",v.review_state AS "versionState",p.id AS "priceVersionId",r.id AS "releaseId",p.funding_policy AS policy,p.status AS "priceStatus",
            r.id AS "releaseId",v.payload,p.status AS "policyStatus",pub.id AS "publicationId",pub.credit_guarantee_waived AS "publicationWaived",
            pub.credit_guarantee_waived_revision::text AS "publicationWaivedRevision",CASE WHEN v.review_state IN ('DRAFT','PUBLISHED','APPROVED') THEN ${OTHER_OUTSTANDING_GUARANTEE_SQL} ELSE NULL END AS "otherOutstandingRequirementId"
       FROM zzsh_supply.rental_account a
       JOIN zzsh_supply.game g ON g.id=a.game_id AND ${effectiveRuleRelease("g")} IS NOT NULL
       LEFT JOIN zzsh_supply.listing_version v ON v.id=COALESCE($3,a.current_version_id) AND v.account_id=a.id
         AND (v.review_state IN ('PUBLISHED','APPROVED') OR v.rule_release_id=${effectiveRuleRelease("g")})
       JOIN zzsh_supply.rule_release r ON r.id=CASE WHEN v.review_state IN ('PUBLISHED','APPROVED') THEN v.rule_release_id ELSE ${effectiveRuleRelease("g")} END AND r.game_id=a.game_id
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
       LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id AND pub.owner_user_id=a.owner_user_id
         AND pub.game_id=a.game_id AND pub.rule_release_id=v.rule_release_id AND pub.content_hash=v.content_hash
      WHERE a.id=$1 AND a.owner_user_id=$2`,
    [accountId, ownerUserId, versionId ?? null],
  )).rows[0];
  const context = readableGuaranteeRow(row);
  if (!context) return null;
  const credit = await readGuaranteeCredit(client, ownerUserId);
  const binding = bindingNeeded(context.row, credit)
    ? await readGuaranteeBinding(client, accountId, ownerUserId, context.row.priceVersionId, context.row.versionId)
    : undefined;
  return projectGuaranteeContext(context.row, context.policy, credit, binding);
}

type GuaranteeCreditRow = { score: number; revision: string };

function readableGuaranteeRow(row: GuaranteeContextRow | undefined): { row: GuaranteeContextRow; policy: FundingPolicy } | null {
  if (!row || row.policyStatus !== "SEALED" || row.policy === null) return null;
  return { row, policy: validateFundingPolicy(row.policy) };
}

async function readGuaranteeCredit(client: PoolClient, ownerUserId: string): Promise<GuaranteeCreditRow | undefined> {
  return (await client.query<GuaranteeCreditRow>(`SELECT score,revision::text FROM zzsh_credit.user_credit_state WHERE user_id=$1`, [ownerUserId])).rows[0];
}

/** The binding facts are only read when the projection can reach a binding-dependent state. */
function bindingNeeded(row: GuaranteeContextRow, credit: GuaranteeCreditRow | undefined): boolean {
  if (!credit) return false;
  const baseCents = quoteResourceCents(row.payload);
  return baseCents !== null && requiredGuaranteeCents(baseCents) !== "0";
}

async function readGuaranteeBinding(client: PoolClient, accountId: string, ownerUserId: string, priceVersionId: string, versionId: string | null): Promise<GuaranteeBindingRow | undefined> {
  return (await client.query<GuaranteeBindingRow>(
    `WITH payment_totals AS (
       SELECT requirement_id,
              COALESCE(sum(CASE WHEN status='CONFIRMED' THEN COALESCE(observed_amount_cents,amount_cents) ELSE 0 END),0)::text AS "confirmedCents",
              COALESCE(bool_or(status='CONFIRMED' AND (provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL)),false) AS "unrecognizedPayment"
         FROM zzsh_order.owner_guarantee_payment GROUP BY requirement_id
     ), refund_totals AS (
       SELECT requirement_id,
              COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0)::text AS "succeededRefundCents",
              COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false) AS "activeRefund"
         FROM zzsh_order.owner_guarantee_refund GROUP BY requirement_id
     )
     SELECT r.id AS "requirementId",r.status AS "requirementStatus",r.base_cents::text AS "bindingBaseCents",r.required_cents::text AS "bindingRequiredCents",r.score_snapshot AS "bindingScore",
            p.id AS "paymentId",p.status AS "paymentState",p.provider_request_state AS "paymentProviderState",p.amount_cents::text AS "paymentAmountCents",p.observed_amount_cents::text AS "paymentObservedAmountCents",p.finance_event_id AS "paymentFinanceEventId",p.ledger_entry_ref AS "paymentLedgerEntryRef",
            COALESCE(pt."confirmedCents",'0') AS "confirmedCents",COALESCE(pt."unrecognizedPayment",false) AS "unrecognizedPayment",
            f.id AS "refundId",f.status AS "refundState",f.provider_request_state AS "refundProviderState",f.amount_cents::text AS "refundAmountCents",f.release_policy_state AS "refundPolicyState",f.finance_event_id AS "refundFinanceEventId",f.ledger_entry_ref AS "refundLedgerEntryRef",
            COALESCE(rt."succeededRefundCents",'0') AS "succeededRefundCents",COALESCE(rt."activeRefund",false) AS "activeRefund",r.updated_at::text AS "updatedAt"
       FROM zzsh_order.owner_guarantee_requirement r
       LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) f ON true
       LEFT JOIN payment_totals pt ON pt.requirement_id=r.id
       LEFT JOIN refund_totals rt ON rt.requirement_id=r.id
      WHERE r.account_id=$1 AND r.owner_user_id=$2 AND r.price_version_id=$3 AND r.listing_version_id IS NOT DISTINCT FROM $4
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
    [accountId, ownerUserId, priceVersionId, versionId],
  )).rows[0];
}

/**
 * Page reader for one owner's accounts: the same facts as readGuaranteeContext per account, but the
 * owner credit row is read once and the binding aggregates are scoped to these accounts in one pass.
 * Missing/unreadable rows stay absent from the map, matching the single reader's null result.
 */
export async function readGuaranteeContextsBatch(client: PoolClient, ownerUserId: string, accountIds: readonly string[], creditRow?: GuaranteeCreditRow | null): Promise<Map<string, GuaranteeContext>> {
  const ids = [...new Set(accountIds)];
  const results = new Map<string, GuaranteeContext>();
  if (ids.length === 0) return results;
  const rows = (await client.query<GuaranteeContextRow>(
    `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",a.game_id AS "gameId",a.current_version_id AS "currentVersionId",
            v.id AS "versionId",v.review_state AS "versionState",p.id AS "priceVersionId",r.id AS "releaseId",p.funding_policy AS policy,p.status AS "priceStatus",
            r.id AS "releaseId",v.payload,p.status AS "policyStatus",pub.id AS "publicationId",pub.credit_guarantee_waived AS "publicationWaived",
            pub.credit_guarantee_waived_revision::text AS "publicationWaivedRevision",CASE WHEN v.review_state IN ('DRAFT','PUBLISHED','APPROVED') THEN ${OTHER_OUTSTANDING_GUARANTEE_SQL} ELSE NULL END AS "otherOutstandingRequirementId"
       FROM zzsh_supply.rental_account a
       JOIN zzsh_supply.game g ON g.id=a.game_id AND ${effectiveRuleRelease("g")} IS NOT NULL
       LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
         AND (v.review_state IN ('PUBLISHED','APPROVED') OR v.rule_release_id=${effectiveRuleRelease("g")})
       JOIN zzsh_supply.rule_release r ON r.id=CASE WHEN v.review_state IN ('PUBLISHED','APPROVED') THEN v.rule_release_id ELSE ${effectiveRuleRelease("g")} END AND r.game_id=a.game_id
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
       LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id AND pub.owner_user_id=a.owner_user_id
         AND pub.game_id=a.game_id AND pub.rule_release_id=v.rule_release_id AND pub.content_hash=v.content_hash
      WHERE a.id=ANY($1::text[]) AND a.owner_user_id=$2`,
    [ids, ownerUserId],
  )).rows;
  const readable = new Map<string, { row: GuaranteeContextRow; policy: FundingPolicy }>();
  for (const row of rows) {
    const context = readableGuaranteeRow(row);
    if (context) readable.set(row.accountId, context);
  }
  if (readable.size === 0) return results;
  const credit = creditRow !== undefined ? creditRow ?? undefined : await readGuaranteeCredit(client, ownerUserId);
  const bindings = new Map<string, GuaranteeBindingRow>();
  const needingBinding = [...readable.values()].filter((entry) => bindingNeeded(entry.row, credit));
  if (needingBinding.length > 0) {
    // I-R1-01: the binding facts are matched against the exact tuples the first contexts read selected.
    // Re-reading current_release_id/current_version_id here would let a version switch between the two
    // statements pair one version's context with another version's payment facts.
    for (const binding of (await client.query<GuaranteeBindingRow & { accountId: string }>(
      `WITH frozen AS (
         SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS t(account_id, owner_user_id, price_version_id, listing_version_id)
       ), payment_totals AS (
         SELECT requirement_id,
                COALESCE(sum(CASE WHEN status='CONFIRMED' THEN COALESCE(observed_amount_cents,amount_cents) ELSE 0 END),0)::text AS "confirmedCents",
                COALESCE(bool_or(status='CONFIRMED' AND (provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL)),false) AS "unrecognizedPayment"
           FROM zzsh_order.owner_guarantee_payment
          WHERE requirement_id IN (SELECT r.id FROM zzsh_order.owner_guarantee_requirement r
                                     JOIN frozen fr ON fr.account_id=r.account_id AND fr.owner_user_id=r.owner_user_id
                                      AND fr.price_version_id=r.price_version_id AND r.listing_version_id IS NOT DISTINCT FROM fr.listing_version_id)
          GROUP BY requirement_id
       ), refund_totals AS (
         SELECT requirement_id,
                COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0)::text AS "succeededRefundCents",
                COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false) AS "activeRefund"
           FROM zzsh_order.owner_guarantee_refund
          WHERE requirement_id IN (SELECT r.id FROM zzsh_order.owner_guarantee_requirement r
                                     JOIN frozen fr ON fr.account_id=r.account_id AND fr.owner_user_id=r.owner_user_id
                                      AND fr.price_version_id=r.price_version_id AND r.listing_version_id IS NOT DISTINCT FROM fr.listing_version_id)
          GROUP BY requirement_id
       )
       SELECT DISTINCT ON (r.account_id) r.account_id AS "accountId",
              r.id AS "requirementId",r.status AS "requirementStatus",r.base_cents::text AS "bindingBaseCents",r.required_cents::text AS "bindingRequiredCents",r.score_snapshot AS "bindingScore",
              p.id AS "paymentId",p.status AS "paymentState",p.provider_request_state AS "paymentProviderState",p.amount_cents::text AS "paymentAmountCents",p.observed_amount_cents::text AS "paymentObservedAmountCents",p.finance_event_id AS "paymentFinanceEventId",p.ledger_entry_ref AS "paymentLedgerEntryRef",
              COALESCE(pt."confirmedCents",'0') AS "confirmedCents",COALESCE(pt."unrecognizedPayment",false) AS "unrecognizedPayment",
              f.id AS "refundId",f.status AS "refundState",f.provider_request_state AS "refundProviderState",f.amount_cents::text AS "refundAmountCents",f.release_policy_state AS "refundPolicyState",f.finance_event_id AS "refundFinanceEventId",f.ledger_entry_ref AS "refundLedgerEntryRef",
              COALESCE(rt."succeededRefundCents",'0') AS "succeededRefundCents",COALESCE(rt."activeRefund",false) AS "activeRefund",r.updated_at::text AS "updatedAt"
         FROM zzsh_order.owner_guarantee_requirement r
         JOIN frozen fr ON fr.account_id=r.account_id AND fr.owner_user_id=r.owner_user_id
         LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
         LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) f ON true
         LEFT JOIN payment_totals pt ON pt.requirement_id=r.id
         LEFT JOIN refund_totals rt ON rt.requirement_id=r.id
        WHERE r.price_version_id=fr.price_version_id
          AND r.listing_version_id IS NOT DISTINCT FROM fr.listing_version_id
        ORDER BY r.account_id,r.created_at DESC,r.id DESC`,
      [needingBinding.map((entry) => entry.row.accountId), needingBinding.map((entry) => entry.row.ownerUserId), needingBinding.map((entry) => entry.row.priceVersionId), needingBinding.map((entry) => entry.row.versionId)],
    )).rows) bindings.set(binding.accountId, binding);
  }
  for (const [accountId, { row, policy }] of readable) results.set(accountId, projectGuaranteeContext(row, policy, credit, bindings.get(accountId)));
  return results;
}

/**
 * A guarantee row is a *requirement*, so the page may only list one where a guarantee fact exists.
 * Listed: a current requirement to pay (REQUIRED), and a recorded requirement that is being paid,
 * satisfied, refunded or failed (PAYMENT_PENDING / SATISFIED / REFUND_REQUESTED / REFUND_PROCESSING /
 * REFUNDED / FAILED), plus an unresolved projection that still has a recorded requirement behind it.
 * Not listed: NOT_REQUIRED (the policy asks for nothing, so there is no guarantee status to show) and
 * UNKNOWN without a requirement record (no current quote / no credit file / nothing to guarantee —
 * the pseudo rows this predicate was added for). The migration initialises every user at 100 points and
 * the old platform had neither a credit score nor a guarantee scheme, so merely owning an account must
 * never produce a guarantee status. The projection itself keeps returning NOT_REQUIRED/UNKNOWN, so the
 * supply gate stays closed (fail-closed) and unchanged for exactly the same accounts.
 */
export function isGuaranteeRequirementFact(context: GuaranteeContext): boolean {
  if (context.state === "NOT_REQUIRED") return false;
  if (context.state === "UNKNOWN") return context.requirementId !== undefined;
  return true;
}

function projectGuaranteeContext(row: GuaranteeContextRow, policy: FundingPolicy, credit: GuaranteeCreditRow | undefined, binding: GuaranteeBindingRow | undefined): GuaranteeContext {
  if (!credit) return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents: null, requiredCents: "0", score: null, creditRevision: null, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "CREDIT_UNINITIALIZED" };
  const baseCents = quoteResourceCents(row.payload);
  if (baseCents === null) return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents: null, requiredCents: "0", score: credit.score, creditRevision: credit.revision, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "STANDARD_QUOTE_UNAVAILABLE" };
  const published = ["PUBLISHED", "APPROVED"].includes(row.versionState ?? "");
  if (published && !row.publicationId) return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId,
    versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents,
    requiredCents: "0", score: null, creditRevision: null, coverageRevision: null, state: "UNKNOWN", reference: null,
    reasonCode: "PUBLICATION_GUARANTEE_UNAVAILABLE" };
  if (published && row.otherOutstandingRequirementId) return { accountId: row.accountId, ownerUserId: row.ownerUserId,
    gameId: row.gameId, requirementId: row.otherOutstandingRequirementId, versionId: row.versionId,
    priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: null,
    creditRevision: null, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "GUARANTEE_REVIEW_REQUIRED" };
  if (published && row.publicationWaived === true && typeof row.publicationWaivedRevision === "string" && /^[1-9]\d*$/.test(row.publicationWaivedRevision)) {
    // A waiver cannot erase a later unexpected payment or unresolved refund observation.
    if (binding && (binding.requirementStatus === "RESTRICTED" || binding.unrecognizedPayment === true || binding.activeRefund === true
      || BigInt(binding.confirmedCents ?? "0") > 0n || BigInt(binding.succeededRefundCents ?? "0") > 0n
      || (binding.paymentState !== null && binding.paymentState !== "FAILED"))) {
      return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, requirementId: binding.requirementId,
        versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0",
        score: null, creditRevision: null, coverageRevision: binding.updatedAt, state: "UNKNOWN", reference: null,
        reasonCode: "PUBLICATION_GUARANTEE_UNAVAILABLE" };
    }
    const revision = row.publicationWaivedRevision;
    return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId,
      priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: null,
      creditRevision: revision, coverageRevision: null, state: "NOT_REQUIRED",
      reference: guaranteeReference({ accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId,
        versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId,
        creditRevision: revision, coverageRevision: null, state: "NOT_REQUIRED", requiredCents: "0" }) };
  }
  if (published && (!binding || !Number.isInteger(binding.bindingScore) || binding.bindingScore! < 0 || binding.bindingScore! > 100)) {
    return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId,
      priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: null,
      creditRevision: null, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "PUBLICATION_GUARANTEE_UNAVAILABLE" };
  }
  // A paid publication uses the original requirement, not the owner's current credit revision.
  const effectiveCredit = published ? { score: binding!.bindingScore!, revision: null } : credit;
  const requiredCents = requiredGuaranteeCents(baseCents);
  if (requiredCents === "0") return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents, score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "ZERO_AMOUNT_PROVIDER_UNSUPPORTED" };
  if (row.versionState === "DRAFT" && row.otherOutstandingRequirementId) {
    return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, requirementId: row.otherOutstandingRequirementId,
      versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents,
      score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: null, state: "UNKNOWN", reference: null,
      reasonCode: "GUARANTEE_BASIS_CHANGED" };
  }
  if (!binding) {
    if (effectiveCredit.score >= CREDIT_GUARANTEE_THRESHOLD) return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: null, state: "NOT_REQUIRED", reference: guaranteeReference({ accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: effectiveCredit.revision, coverageRevision: null, state: "NOT_REQUIRED", requiredCents: "0" }) };
    return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents, score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: null, state: "REQUIRED", reference: null };
  }
  const boundRequiredCents = binding.bindingRequiredCents ?? requiredCents;
  const confirmedCents = binding.confirmedCents ?? (binding.paymentState === "CONFIRMED" ? (binding.paymentAmountCents ?? boundRequiredCents) : "0");
  const unrecognizedPayment = binding.unrecognizedPayment ?? false;
  const succeededRefundCents = binding.succeededRefundCents ?? (binding.refundState === "SUCCEEDED" ? (binding.refundAmountCents ?? boundRequiredCents) : "0");
  const activeRefund = binding.activeRefund ?? ["REQUESTED", "PROCESSING", "UNKNOWN"].includes(binding.refundState ?? "");
  let state: GuaranteeState = "REQUIRED";
  let reasonCode: string | undefined;
  if (binding.requirementStatus === "RESTRICTED") {
    state = "UNKNOWN";
    reasonCode = "GUARANTEE_REVIEW_REQUIRED";
  } else if (activeRefund) {
    state = binding.refundState === "REQUESTED" ? "REFUND_REQUESTED" : binding.refundState === "PROCESSING" ? "REFUND_PROCESSING" : "UNKNOWN";
  } else if (BigInt(succeededRefundCents) > 0n) {
    state = "REFUNDED";
  } else if (["REQUESTED", "ACCEPTED", "PROCESSING", "UNKNOWN"].includes(binding.paymentState ?? "")) {
    state = "PAYMENT_PENDING";
  } else if (unrecognizedPayment) {
    state = "UNKNOWN";
    reasonCode = "PAYMENT_LEDGER_UNRECONCILED";
  } else if (BigInt(confirmedCents) < BigInt(boundRequiredCents)) {
    state = "REQUIRED";
    reasonCode = "PAYMENT_UNDERPAID";
  } else {
    state = "SATISFIED";
  }
  const changedDraftBasis = row.versionState === "DRAFT" && boundRequiredCents !== requiredCents;
  if (changedDraftBasis && (state === "SATISFIED" || state === "REQUIRED")) {
    state = "UNKNOWN";
    reasonCode = "GUARANTEE_BASIS_CHANGED";
  }
  if (!published && effectiveCredit.score >= CREDIT_GUARANTEE_THRESHOLD && state === "REQUIRED" && BigInt(confirmedCents) === 0n && (!binding.paymentId || binding.paymentState === "FAILED")) {
    state = "NOT_REQUIRED";
    return { accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: null, state, reference: guaranteeReference({ accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: effectiveCredit.revision, coverageRevision: null, state, requiredCents: "0" }) };
  }
  const reference = reasonCode === "GUARANTEE_BASIS_CHANGED" || reasonCode === "GUARANTEE_REVIEW_REQUIRED" ? null : guaranteeReference({ accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: effectiveCredit.revision, coverageRevision: binding.updatedAt, state, requiredCents: boundRequiredCents });
  return {
    accountId: row.accountId, ownerUserId: row.ownerUserId, gameId: row.gameId, requirementId: binding.requirementId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: changedDraftBasis ? requiredCents : boundRequiredCents,
    score: effectiveCredit.score, creditRevision: effectiveCredit.revision, coverageRevision: binding.updatedAt, state, reasonCode, reference,
    paymentId: binding.paymentId, paymentState: binding.paymentState, paymentProviderState: binding.paymentProviderState, paymentAmountCents: binding.paymentAmountCents,
    paymentObservedAmountCents: binding.paymentObservedAmountCents, paymentFinanceEventId: binding.paymentFinanceEventId, paymentLedgerEntryRef: binding.paymentLedgerEntryRef,
    refundId: binding.refundId, refundState: binding.refundState, refundProviderState: binding.refundProviderState, refundAmountCents: binding.refundAmountCents,
    refundPolicyState: binding.refundPolicyState, refundFinanceEventId: binding.refundFinanceEventId, refundLedgerEntryRef: binding.refundLedgerEntryRef,
  };
}

/**
 * Gate-only read: serialize an enabled publication/confirmation/order check
 * against credit mutations and guarantee release updates. Display/payment
 * readers stay non-locking; runtime still receives no UPDATE privilege.
 */
export async function readGuaranteeContextForGate(client: PoolClient, accountId: string, ownerUserId: string, versionId?: string): Promise<GuaranteeContext | null> {
  await client.query(`SELECT user_id FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR SHARE`, [ownerUserId]);
  let context = await readGuaranteeContext(client, accountId, ownerUserId, versionId);
  if (context?.requirementId) {
    await client.query(`SELECT id FROM zzsh_order.owner_guarantee_requirement WHERE id=$1 FOR SHARE`, [context.requirementId]);
    context = await readGuaranteeContext(client, accountId, ownerUserId, versionId);
  }
  return context;
}
