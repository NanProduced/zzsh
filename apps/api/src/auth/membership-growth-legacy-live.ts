import type { PoolClient } from "pg";
import { projectLegacyGrowthConsumption, type LegacyGrowthConsumptionInput } from "../order/legacy-growth-consumption";
import { prepareLegacyGrowthRow, writeLegacyGrowthContributionRows, type PreparedLegacyRow } from "./membership-growth-legacy";
import { SecurityApiError } from "./security-core";

type ConfirmOrigin = Extract<LegacyGrowthConsumptionInput["origin"], { kind: "CONTINUATION_CONFIRM" }>;
export type LegacyConfirmGrowthInput = Omit<LegacyGrowthConsumptionInput, "origin"> & { origin: ConfirmOrigin };
export type LegacyGrowthLiveSource = { sourceKey: string; commandId: string | null; revision: string | null; createdAt?: string | null; growthInput?: LegacyConfirmGrowthInput | null };

/** Both single and page readers verify the same formal CONFIRM and sealed source evidence, not a caller assertion. */
export const LEGACY_GROWTH_LIVE_COLUMNS = `
 'legacy_mysql_restore:la_order:'||o.legacy_id AS "sourceKey",v.id AS "commandId",v.revision::text AS revision,
 to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
 CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object(
   'subjectUserId',o.renter_user_id,'recordedAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'binding',jsonb_build_object('id',o.id,'legacyId',o.legacy_id,'accountId',o.account_id,'legacyAccountId',o.legacy_account_id,'gameId',o.game_id,
     'ownerUserId',o.owner_user_id,'renterUserId',o.renter_user_id,'legacyOwnerId',o.legacy_owner_id,'legacyRenterId',o.legacy_renter_id,
     'ownerSourceDigest',o.owner_source_digest,'renterSourceDigest',o.renter_source_digest,'sourceDigest',o.source_digest,
     'sourceOrderStatus',o.source_order_status,'sourcePayStatus',o.source_pay_status,'paidCents',o.recorded_paid_amount_cents::text,
     'completedAt',to_char(o.source_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
   'origin',jsonb_build_object('kind','CONTINUATION_CONFIRM','command',jsonb_build_object(
     'id',v.id,'revision',v.revision::text,'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
     'actor',v.actor,'inputEvidenceId',v.input_evidence_id,'resultEvidenceId',v.result_evidence_id,'planFingerprint',v.plan_fingerprint),
     'input',jsonb_build_object('id',i.id,'orderId',i.order_id,'evidenceVersion',i.evidence_version::text,'sourceKind',i.source_kind,
       'sourceDigest',i.source_digest,'factsDigest',i.facts_digest,'factsCanonical',i.facts_canonical,'facts',i.facts),
     'result',jsonb_build_object('id',r.id,'orderId',r.order_id,'evidenceVersion',r.evidence_version::text,'sourceKind',r.source_kind,
       'sourceDigest',r.source_digest,'factsDigest',r.facts_digest,'factsCanonical',r.facts_canonical,'facts',r.facts))) END AS "growthInput"`;
export const LEGACY_GROWTH_LIVE_FROM = `
 FROM zzsh_order.legacy_order_read_snapshot o LEFT JOIN zzsh_order.legacy_continuation_version v
   ON v.order_id=o.id AND v.command='CONFIRM' AND v.created_at<=$2::timestamptz
 LEFT JOIN zzsh_order.legacy_continuation_evidence i ON i.id=v.input_evidence_id AND i.order_id=o.id
 LEFT JOIN zzsh_order.legacy_continuation_evidence r ON r.id=v.result_evidence_id AND r.order_id=o.id`;

export function prepareLegacyConfirmGrowth(input: LegacyConfirmGrowthInput): { ok: true; rows: PreparedLegacyRow[] } | { ok: false; reason: string } {
  try {
    if (input?.origin?.kind !== "CONTINUATION_CONFIRM" || input.origin.components) return { ok: false, reason: "CONFIRMED_RESULT_UNPROVEN" };
    const projected = projectLegacyGrowthConsumption(input);
    if (projected.knowledge !== "KNOWN") return { ok: false, reason: projected.reason ?? "CONFIRMED_RESULT_UNPROVEN" };
    if (projected.facts.length !== 2 || !["RENTAL_SETTLEMENT", "MATERIAL_CONSUMPTION"].every(component => projected.facts.some(fact => fact.component === component))) return { ok: false, reason: "CONFIRM_COMPONENTS_INCOMPLETE" };
    const rows = projected.facts.map(fact => prepareLegacyGrowthRow(fact, input.binding.gameId));
    if (rows.some(row => row === null)) return { ok: false, reason: "CONFIRM_COMPONENTS_INVALID" };
    return { ok: true, rows: rows as PreparedLegacyRow[] };
  } catch { return { ok: false, reason: "CONFIRMED_RESULT_UNPROVEN" }; }
}

/** Runs after the existing parties/game/order lock prefix and before the caller's confirmation COMMIT. */
export async function recordLegacyConfirmGrowth(client: PoolClient, input: LegacyConfirmGrowthInput): Promise<{ inserted: number; replayed: number }> {
  const prepared = prepareLegacyConfirmGrowth(input);
  if (!prepared.ok) throw new SecurityApiError(409, "CONFLICT", "LEGACY_CONFIRM_GROWTH_UNPROVEN:" + prepared.reason);
  return writeLegacyGrowthContributionRows(client, prepared.rows);
}
