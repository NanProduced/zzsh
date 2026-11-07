// Explicit registered local sandbox only; target declaration grants no real KYC or payout authority.
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { canonicalize } from "../supply/content-hash";
import { conflict, ensureOnlyFields, fingerprintRequest, invalid, notFound, withIdempotency } from "../supply/supply-util";
import { readWithdrawalBankBinding } from "./withdrawal-bank-binding";
import { localWithdrawalDayWindow, ownerLocalWithdrawalPolicy } from "./controlled-withdrawal";
import { assertRegisteredWithdrawalResource, withdrawalRegistration, type RegisteredWithdrawalResource } from "./native-withdrawal-resource";
import { assertDemoWithdrawalIdentity } from "./demo-withdrawal-identity";

type Actor = UserContext & { requestId: string };
type TargetInput = Readonly<{ bankBindingId: string; bankBindingRevision: string; amountCents: string }>;
const OP = "local-sandbox.withdrawal-target.v1", sha = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Original local withdrawal target unavailable");
function targetInput(body: Record<string, unknown>): TargetInput {
  ensureOnlyFields(body, ["bankBindingId", "bankBindingRevision", "amountCents"]);
  const { bankBindingId, bankBindingRevision, amountCents } = body;
  if (typeof bankBindingId !== "string" || !/^bank_[a-f0-9]{32}$/.test(bankBindingId)
    || typeof bankBindingRevision !== "string" || !/^[1-9][0-9]{0,18}$/.test(bankBindingRevision)
    || BigInt(bankBindingRevision) > 9223372036854775807n || typeof amountCents !== "string" || !/^[1-9][0-9]{0,23}$/.test(amountCents)) throw invalid();
  return { bankBindingId, bankBindingRevision, amountCents };
}
export class LocalSandboxTargetCommitUnknown extends SecurityApiError {
  constructor(readonly originalKey: string) { super(503, "EVIDENCE_UNAVAILABLE", "Local target result is unknown; recover the original key"); }
}

async function originalTarget(c: PoolClient, sandbox: RegisteredWithdrawalResource, userId: string, receipt: unknown): Promise<void> {
  const p = withdrawalRegistration(sandbox), r = receipt as { target?: { id?: unknown } } | null;
  if (typeof r?.target?.id !== "string") throw unavailable();
  const found = (await c.query(`SELECT d.id FROM zzsh_order.withdrawal_destination d
    JOIN zzsh_order.withdrawal_admission a ON a.id=d.admission_id AND a.user_id=d.user_id
    WHERE d.id=$1 AND d.user_id=$2 AND a.sandbox_registration_ref=$3 AND d.sandbox_registration_ref=$3
      AND a.resource_oid=$4 AND a.resource_name=$5 AND a.resource_marker=$6
      AND d.bank_binding_id IS NOT NULL AND d.bank_binding_revision IS NOT NULL`,
  [r.target.id, userId, p.registration.reference, p.registration.resource.resourceOid, p.registration.resource.database, p.registration.resource.marker])).rows[0];
  if (!found) throw unavailable();
}

/** Declares one immutable local target from the authenticated subject's existing masked bank binding.
 * It does not reserve a cent, establish coverage/KYC, change the binding, or call a bank/provider. */
export async function declareLocalSandboxWithdrawalTarget(pool: Pool, actor: Actor, body: Record<string, unknown>, keyValue: unknown, sandbox: RegisteredWithdrawalResource) {
  const input = targetInput(body), key = validateIdempotencyKey(keyValue), p = withdrawalRegistration(sandbox);
  const policy = ownerLocalWithdrawalPolicy("BANK_CARD", [actor.userId]);
  if (BigInt(input.amountCents) < BigInt(policy.minCents) || BigInt(input.amountCents) > BigInt(policy.maxCents)) throw conflict("Withdrawal limit reached");
  let completed = false;
  try { return await withTransaction(pool, async c => {
    await assertRegisteredWithdrawalResource(c, sandbox, "READ_ORIGINAL");
    const result = await withIdempotency(c, { realm: "user", principalId: actor.userId, operation: OP, resourceId: p.registration.reference }, key,
      fingerprintRequest(OP, p.registration.reference, input), async replay => {
        await assertUserContextInTransaction(c, actor);
        if (replay) {
          const old = (await c.query("SELECT response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2",
            [JSON.stringify(["user", actor.userId, OP, p.registration.reference]), key])).rows[0];
          if (!old) throw unavailable(); await originalTarget(c, sandbox, actor.userId, old.body);
        }
      }, async () => {
        const registration = await assertRegisteredWithdrawalResource(c, sandbox);
        if(sandbox.kind!=="REGISTERED_LOCAL_FINANCIAL_SANDBOX")await assertDemoWithdrawalIdentity(c,actor.userId,sandbox);
        // Uses only the existing public masked projection. No protection key or sealed_details read.
        const current = await readWithdrawalBankBinding(c, actor, { database: registration.resource.database, runtimeUser: registration.resource.runtimeRole });
        if (current.integration !== "INTEGRATED" || !current.binding) throw notFound();
        if (current.binding.id !== input.bankBindingId || current.binding.revision !== input.bankBindingRevision) throw conflict("Bank binding changed; read the current masked target");
        const at = (await c.query<{ at: string }>(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows[0]?.at;
        if (!at) throw unavailable();
        // Only a NEW quote from this target expires at the local day boundary. The environment's
        // original execution admission has no per-test window, so a reserved intent can recover tomorrow.
        const expiresAt = localWithdrawalDayWindow(at).end, suffix = sha(canonicalize([p.digest, actor.userId, key])).slice(0, 40);
        const admissionId = "sandbox_wda_" + suffix, destinationId = "sandbox_wdd_" + suffix;
        await c.query(`INSERT INTO zzsh_order.withdrawal_admission(id,user_id,scope,resource_oid,resource_name,resource_marker,
          revision,active,per_intent_cents,max_intents,max_gross_cents,admitted_at,expires_at,created_by_admin_id,reason,sandbox_registration_ref)
          VALUES($1,$2,'LOCAL_CONTROLLED',$3,$4,$5,1,true,$6,1,$6,$7,$8,$9,'Registered local sandbox target; not real KYC',$10)`,
        [admissionId, actor.userId, registration.resource.resourceOid, registration.resource.database, registration.resource.marker,
          input.amountCents, at, 'infinity', registration.approvedByAdminId, registration.reference]);
        await c.query(`INSERT INTO zzsh_order.withdrawal_destination(id,user_id,admission_id,mode,kind,scenario,display_mask,
          revision,active,sandbox_registration_ref,bank_binding_id,bank_binding_revision,valid_until)
          VALUES($1,$2,$3,'LOCAL_CONTROLLED','BANK_CARD','TIMEOUT_THEN_SUCCEED',$4,1,true,$5,$6,$7,$8)`,
        [destinationId, actor.userId, admissionId, current.binding.cardMask, registration.reference, current.binding.id, current.binding.revision,expiresAt]);
        await recordAudit(c, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId,
          action: "controlled.withdrawal.target.declared", objectType: "withdrawal_destination", objectId: destinationId, outcome: "SUCCESS",
          details: { sandboxDigest: p.digest, bankBindingId: current.binding.id, bankBindingRevision: current.binding.revision,
            amountCents: input.amountCents, currency: "CNY", inputDigest: sha(canonicalize(input)), identityMeaning: "EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC" } });
        return { status: 200, body: { contractVersion: "local-sandbox.withdrawal-target.v1", scope: "LOCAL_CONTROLLED",
          identityMeaning: "EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC", target: { id: destinationId, kind: "BANK_CARD", mask: current.binding.cardMask,
            amountCents: input.amountCents, currency: "CNY", expiresAt, policyVersion: policy.version }, reservationState: "REQUIRES_CURRENT_QUOTE", bankArrival: "UNKNOWN" } };
      });
    await originalTarget(c, sandbox, actor.userId, result.body);await c.query('SET CONSTRAINTS ALL IMMEDIATE'); completed = true; return result;
  }); } catch (error) { if (completed) throw new LocalSandboxTargetCommitUnknown(key); throw error; }
}

/** Pure original-key read, no implicit target creation/reservation and no provider action. */
export async function readLocalSandboxWithdrawalTargetReceipt(pool: Pool, actor: Actor, keyValue: unknown, sandbox: RegisteredWithdrawalResource) {
  const key = validateIdempotencyKey(keyValue), p = withdrawalRegistration(sandbox);
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertRegisteredWithdrawalResource(c, sandbox, "READ_ORIGINAL"); await assertUserContextInTransaction(c, actor, "READ");
    const row = (await c.query("SELECT response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2",
      [JSON.stringify(["user", actor.userId, OP, p.registration.reference]), key])).rows[0];
    if (row) await originalTarget(c, sandbox, actor.userId, row.body);
    return { scope: "LOCAL_CONTROLLED", knowledge: row ? "KNOWN" : "UNKNOWN", receipt: row?.body ?? null, mayReapply: false };
  });
}
