import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { authorizeSystemOrderMigration, type SystemOrderMigrationActor } from "../legacy-load/system-user-migration";
import { assertGameScope, conflict, ensureOnlyFields, fingerprintRequest, invalid, sha256Hex, withIdempotency } from "../supply/supply-util";
import type { SettlementStage, SettlementStageCode } from "./settlement-record";

/** 0074 continuation capability. A chain that stops before 0074 has no continuation tables; every
 *  relation that joins them must degrade to its pre-continuation shape instead of failing the read. */
export async function legacyContinuationReady(client: Pick<PoolClient, "query">): Promise<boolean> {
  return (await client.query<{ ready?: boolean }>(`SELECT to_regclass('zzsh_order.legacy_continuation_version') IS NOT NULL AS ready`)).rows[0]?.ready === true;
}
// Every consuming relation joins the unique current continuation head as h.
export const LEGACY_EFFECTIVE_STAGE_SQL = `COALESCE(h.stage,l.source_order_status)`;
export const LEGACY_CONTINUATION_COMPLETED_AT_SQL = `COALESCE((SELECT created_at FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND command='CONFIRM' ORDER BY revision DESC LIMIT 1),l.source_completed_at)`;
export const LEGACY_CONTINUATION_CANCELLED_AT_SQL = `COALESCE((SELECT created_at FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND command='SUPPORT_CANCEL' ORDER BY revision DESC LIMIT 1),l.source_cancelled_at)`;
export const LEGACY_ORDER_STATUS_SQL = `CASE WHEN ${LEGACY_EFFECTIVE_STAGE_SQL}=5 THEN 'CANCELLED' WHEN ${LEGACY_EFFECTIVE_STAGE_SQL}=4 THEN 'COMPLETED'
 WHEN ${LEGACY_EFFECTIVE_STAGE_SQL}=1 AND l.source_pay_status=0 THEN 'PENDING_PAYMENT'
 WHEN ${LEGACY_EFFECTIVE_STAGE_SQL} IN(2,3,6,7,8,9) AND l.source_pay_status=1 THEN 'PAID' ELSE 'UNKNOWN' END`;
const LEGACY_STATE: Record<string,string> = {"1":"待支付","2":"待上号","3":"进行中","4":"已完成","5":"已取消","6":"待验号","7":"待确认额外消耗","8":"待卖家确认","9":"待买家确认"};
export function legacyOrderReadState(status: number, payStatus: number) {
  const paymentState = payStatus === 1 ? "RECORDED_PAID" : payStatus === 0 ? "RECORDED_UNPAID" : "UNKNOWN";
  const orderStatus = status === 5 ? "CANCELLED" : status === 4 ? "COMPLETED" : status === 1 && payStatus === 0 ? "PENDING_PAYMENT" : [2,3,6,7,8,9].includes(status) && payStatus === 1 ? "PAID" : "UNKNOWN";
  return { status: orderStatus, paymentState, statusLabel: orderStatus === "UNKNOWN" ? "状态待核实" : LEGACY_STATE[String(status)]! };
}

/** A historical lifecycle label does not establish a native posting or authorize an action. */
export function legacyOrderLifecycleStage(status: number, payStatus: number, party?: "owner" | "renter"): SettlementStage {
  const state = legacyOrderReadState(status, payStatus);
  let code: SettlementStageCode = "UNKNOWN";
  if (["PENDING_PAYMENT", "COMPLETED", "CANCELLED"].includes(state.status)) code = "NONE";
  if (state.status === "PAID") {
    if (status === 2) code = "OPENING_PENDING";
    if (status === 3) code = "RENTING";
    if (status === 8 || status === 9) code = party === (status === 8 ? "owner" : "renter") ? "DECISION_PENDING" : "DECISION_WAITING";
  }
  return { code, label: code === "NONE" ? null : code === "UNKNOWN" ? "状态待核实" : state.statusLabel, viewerActionRequired: false, settlementVersionNo: null };
}

type PartyBinding = { userId: string; legacyId: string; businessNo: string | null; sourceDigest: string };
export type LegacyOrderReadInput = {
  source: { legacyId: string; digest: string; evidenceRef: string; row: Record<string, string | null> };
  account: { accountId: string; gameId: string; legacyId: string; businessNo: string | null; sourceDigest: string; metricSourceFields?: { is_full_payout?: string | null } };
  owner: PartyBinding;
  renter: PartyBinding;
};
const MONEY_FIELDS = ["money", "goods_money", "expend_pay_money", "need_pay_money", "pay_money", "deposit_amount", "return_order_money", "detain_money", "sale_earnings", "commission_money", "share_money", "full_payout_money", "compensation"];
const QUANTITY_FIELDS = ["awm_bullet_num", "level6_bullet_num", "level6_helmet_num", "level6_armor_num", "top_insure_card_num", "barrett_bullet_num", "coffee_num"];
export const LEGACY_ORDER_READ_SOURCE_FIELDS = ["id", "order_sn", "user_id", "sale_user_id", "accounts_id", "order_type", "order_source", "order_status", "pay_is", "is_settle", "is_delete", "create_time", "update_time", "pay_time", "confirm_time", "cancel_time", "tenancy_deadline", "express_is", "express_time", "expend_haff", ...MONEY_FIELDS, ...QUANTITY_FIELDS, "awm_bullet_price", "level6_bullet_price", "level6_helmet_price", "level6_armor_price", "top_insure_card_price", "barrett_bullet_price", "coffee_price"];
const MONEY = /^-?(0|[1-9]\d{0,22})\.\d{2}$/;
const INTEGER = /^(0|[1-9]\d{0,23})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export function legacyMoneyCents(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !MONEY.test(value)) throw invalid("Legacy money is invalid");
  return BigInt(value.replace(".", "")).toString();
}
export function legacyEpochTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "0") return null;
  if (typeof value !== "string" || !INTEGER.test(value)) throw invalid("Legacy timestamp is invalid");
  const ms = BigInt(value) * 1000n;
  if (ms > 253402300799999n) throw invalid("Legacy timestamp is out of range");
  return new Date(Number(ms)).toISOString();
}
function bindingId(value: unknown): void { if (typeof value !== "string" || !ID.test(value)) throw invalid("Legacy binding ID is invalid"); }
export function normalizeLegacyOrderReadInput(input: LegacyOrderReadInput) {
  if (!input || typeof input !== "object" || Array.isArray(input) || [input.source,input.account,input.owner,input.renter].some(value => !value || typeof value !== "object" || Array.isArray(value))) throw invalid("Legacy import binding is invalid");
  ensureOnlyFields(input, ["source", "account", "owner", "renter"]);
  ensureOnlyFields(input.source, ["legacyId", "digest", "evidenceRef", "row"]);
  ensureOnlyFields(input.account, ["accountId", "gameId", "legacyId", "businessNo", "sourceDigest", "metricSourceFields"]);
  if (input.account.metricSourceFields !== undefined) {
    const facts = input.account.metricSourceFields;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) throw invalid("Legacy account capture facts are invalid");
    ensureOnlyFields(facts, ["is_full_payout"]);
    if (Object.hasOwn(facts, "is_full_payout") && facts.is_full_payout !== null
      && (typeof facts.is_full_payout !== "string" || facts.is_full_payout.length > 255 || /[\x00-\x1f\x7f]/.test(facts.is_full_payout))) throw invalid("Legacy account capture fact is invalid");
  }
  for (const party of [input.owner, input.renter]) ensureOnlyFields(party, ["userId", "legacyId", "businessNo", "sourceDigest"]);
  const row = input.source.row;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("Legacy source row is invalid");
  ensureOnlyFields(row, LEGACY_ORDER_READ_SOURCE_FIELDS);
  for (const value of Object.values(row)) if (value !== null && (typeof value !== "string" || value.length > 255)) throw invalid("Legacy source value is invalid");
  if (Object.hasOwn(row,"is_delete") && row.is_delete !== "0" && row.is_delete !== "1") throw invalid("Legacy deletion flag is invalid");
  for (const value of [input.source.legacyId, input.account.legacyId, input.owner.legacyId, input.renter.legacyId, input.account.accountId, input.account.gameId]) bindingId(value);
  for (const binding of [input.account, input.owner, input.renter]) {
    if (!DIGEST.test(binding.sourceDigest) || (binding.businessNo !== null && (typeof binding.businessNo !== "string" || binding.businessNo.length > 255))) throw invalid("Legacy source binding is invalid");
  }
  for (const party of [input.owner, input.renter]) {
    bindingId(party.userId);
    if (party.userId !== legacyOwnerUserId("legacy_mysql_restore", "la_user", party.legacyId)) throw conflict("Legacy user mapping does not match its source");
  }
  if (!DIGEST.test(input.source.digest) || sha256Hex(canonicalize(row)) !== input.source.digest) throw conflict("Legacy order digest does not match the frozen source");
  if (typeof input.source.evidenceRef !== "string" || !input.source.evidenceRef || input.source.evidenceRef.length > 512) throw invalid("Legacy evidence reference is invalid");
  if (row.id !== input.source.legacyId || row.accounts_id !== input.account.legacyId || row.sale_user_id !== input.owner.legacyId || row.user_id !== input.renter.legacyId) throw conflict("Legacy source relationships do not match the target binding");
  if (!row.order_sn || /[\x00-\x1f\x7f]/.test(row.order_sn)) throw invalid("Legacy order number is invalid");
  if (!row.order_status || !/^-?\d{1,9}$/.test(row.order_status) || !row.pay_is || !/^-?\d{1,9}$/.test(row.pay_is)) throw invalid("Legacy source status is invalid");
  for (const field of MONEY_FIELDS) legacyMoneyCents(row[field]);
  for (const field of QUANTITY_FIELDS) if (row[field] !== null && row[field] !== undefined && !INTEGER.test(row[field]!)) throw invalid("Legacy quantity is invalid");
  if (row.expend_haff !== null && row.expend_haff !== undefined && !MONEY.test(row.expend_haff)) throw invalid("Legacy consumption is invalid");
  const createdAt = legacyEpochTimestamp(row.create_time), paidAt = legacyEpochTimestamp(row.pay_time), cancelledAt = legacyEpochTimestamp(row.cancel_time), completedAt = legacyEpochTimestamp(row.confirm_time);
  const bindingDigest = sha256Hex(canonicalize(input));
  return { id: `legacy_order_${sha256Hex(JSON.stringify(["legacy_mysql_restore", "la_order", input.source.legacyId])).slice(0, 40)}`, bindingDigest, createdAt, paidAt, cancelledAt, completedAt,
    dueCents: legacyMoneyCents(row.need_pay_money), paidCents: row.pay_is === "1" ? legacyMoneyCents(row.pay_money) : null, depositCents: legacyMoneyCents(row.deposit_amount) };
}

/** A related account flag is a same-capture observation, not a payment-time or ledger fact. */
export function legacyAccountMetricSource(input: LegacyOrderReadInput) {
  if (input.account.metricSourceFields === undefined) return null;
  return { schema: "legacy-account-metric-source-v1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts",
    legacyId: input.account.legacyId, sourceDigest: input.account.sourceDigest, orderEvidenceRef: input.source.evidenceRef,
    fields: input.account.metricSourceFields };
}

/** Caller owns the transaction. No public import route or transaction engine. */
export async function importLegacyOrderRead(client: PoolClient, input: LegacyOrderReadInput,
  actor: { id: string; sessionId: string; requestId: string } | SystemOrderMigrationActor) {
  const normalized = normalizeLegacyOrderReadInput(input), operation = "order.legacy.read-import";
  const systemActor = "kind" in actor && actor.kind === "SYSTEM_ORDER_MIGRATION" ? actor : null;
  const result = await withIdempotency(client, { realm: systemActor ? "system" : "admin", principalId: actor.id, operation },
    sha256Hex(JSON.stringify(["legacy_mysql_restore", "la_order", input.source.legacyId])), fingerprintRequest(operation, normalized.id, input), async () => {
      if (systemActor) await authorizeSystemOrderMigration(client,systemActor,{orderId:normalized.id,legacyId:input.source.legacyId,
        sourceDigest:input.source.digest,bindingDigest:normalized.bindingDigest});
      else {
        await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: (actor as {sessionId:string}).sessionId });
        const access = await loadEffectiveAdminAccess(client, actor.id);
        requirePermission(access, "supply.catalog.manage"); requirePermission(access, "order.read");
        await assertGameScope(client, actor.id, access?.isBoss === true, input.account.gameId);
      }
    }, async () => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [(BigInt(`0x${sha256Hex(normalized.id).slice(0, 15)}`)).toString()]);
      const existing = (await client.query<{ id: string; digest: string }>("SELECT id,binding_digest AS digest FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order' AND legacy_id=$1", [input.source.legacyId])).rows[0];
      if (existing) {
        if (existing.id !== normalized.id || existing.digest !== normalized.bindingDigest) throw conflict("Legacy order conflicts with the stored complete binding");
        return { status: 200, body: { orderId: existing.id } };
      }
      const r = input.source.row;
      await client.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot
        (id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,account_id,game_id,owner_user_id,renter_user_id,
         legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_account_no,legacy_owner_id,legacy_owner_no,owner_source_digest,
         legacy_renter_id,legacy_renter_no,renter_source_digest,source_order_status,source_pay_status,source_created_at,source_paid_at,source_cancelled_at,source_completed_at,
         due_amount_cents,recorded_paid_amount_cents,deposit_amount_cents,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id${systemActor ? ",created_by_migration_id,migration_manifest_sha256" : ""})
        VALUES($1,'legacy_mysql_restore','la_order',$2,$3,$4,$5,$6,$7,$8,$9,$10,'la_rental_accounts',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,1,$29,$30${systemActor ? ",$31,$32" : ""})`,
      [normalized.id,input.source.legacyId,input.source.digest,input.source.evidenceRef,r.order_sn,input.account.accountId,input.account.gameId,input.owner.userId,input.renter.userId,
        input.account.legacyId,input.account.sourceDigest,input.account.businessNo,input.owner.legacyId,input.owner.businessNo,input.owner.sourceDigest,input.renter.legacyId,input.renter.businessNo,input.renter.sourceDigest,
        Number(r.order_status),Number(r.pay_is),normalized.createdAt,normalized.paidAt,normalized.cancelledAt,normalized.completedAt,normalized.dueCents,normalized.paidCents,normalized.depositCents,JSON.stringify(r),normalized.bindingDigest,systemActor ? null : actor.id,
        ...(systemActor ? [systemActor.id,systemActor.sourceDatasetSha256] : [])]);
      const accountMetricSource = legacyAccountMetricSource(input);
      await recordAudit(client, { actorType: systemActor ? "system" : "admin", actorId: actor.id,
        ...(systemActor ? {legacyMigrationManifestSha256:systemActor.sourceDatasetSha256} : {sessionId:(actor as {sessionId:string}).sessionId}),
        requestId: actor.requestId, action: "order.legacy.read_imported", objectType: "rental_order", objectId: normalized.id, outcome: "SUCCESS",
        details: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_order", legacyId: input.source.legacyId, sourceDigest: input.source.digest,
          bindingDigest: normalized.bindingDigest, ...(systemActor ? {sourceDatasetSha256:systemActor.sourceDatasetSha256,
            migrationRunDigest:systemActor.id.slice("legacy-order-migration:".length)} : {}),
          ruleOrigin: "LEGACY_ORDER", result: "IMPORTED", ...(accountMetricSource ? { accountMetricSource } : {}) } });
      return { status: 200, body: { orderId: normalized.id } };
    });
  return { ...result.body as { orderId: string }, replayed: result.replayed };
}
