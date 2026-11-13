import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SecurityApiError } from '../auth/security-core';
import type { DistributionEarningStore, MaintenanceOperator } from './distribution-earning-store';

export const DISTRIBUTION_DUE_LOCK_KEY = '806007';

export const distributionAccrualTaskAbsentSql = `(
 to_regclass('zzsh_order.distribution_accrual_task') IS NULL
 AND to_regprocedure('zzsh_order.guard_distribution_accrual_task()') IS NULL
 AND to_regprocedure('zzsh_order.enqueue_distribution_accrual_task()') IS NULL
 AND to_regprocedure('zzsh_order.guard_referral_earning_task()') IS NULL
 AND to_regprocedure('zzsh_order.derive_frozen_referral_accrual(text)') IS NULL
 AND to_regprocedure('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)') IS NULL
 AND to_regclass('zzsh_order.distribution_accrual_task_due') IS NULL
 AND to_regclass('zzsh_order.referral_earning_posting') IS NULL
 AND to_regclass('zzsh_supply.distribution_due_unfinished_receipt') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('zzsh_order.settlement_posting')
  AND tgname='settlement_distribution_accrual_enqueue' AND NOT tgisinternal)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('zzsh_order.rental_referral_earning')
  AND tgname='rental_referral_earning_task_guard' AND NOT tgisinternal)
 AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('zzsh_order.guard_rental_referral_earning()')
  AND position('derive_frozen_referral_accrual' IN prosrc)>0)
)`;

/** One contract is shared by the posting gate and fixed-fee readiness. */
export const distributionAccrualTaskContractSql = `COALESCE(
 current_setting('session_replication_role')='origin'
 AND to_regclass('zzsh_order.distribution_accrual_task') IS NOT NULL
 AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.distribution_accrual_task')
  AND attnum>0 AND NOT attisdropped)=6
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('posting_id','text'),('state','text'),('next_attempt_at','timestamp with time zone'),
  ('created_at','timestamp with time zone'),('updated_at','timestamp with time zone')
 ) required(name,type) WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a
  WHERE a.attrelid=to_regclass('zzsh_order.distribution_accrual_task') AND a.attname=required.name
   AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND format_type(a.atttypid,a.atttypmod)=required.type))
 AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('zzsh_order.distribution_accrual_task')
  AND a.attname='reason_code' AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull AND format_type(a.atttypid,a.atttypmod)='text')
 AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_order.distribution_accrual_task')
  AND c.contype='p' AND c.convalidated AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute
   WHERE attrelid=c.conrelid AND attname='posting_id' AND NOT attisdropped)]::smallint[])
 AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_order.distribution_accrual_task')
  AND c.contype='f' AND c.convalidated AND c.confrelid=to_regclass('zzsh_order.settlement_posting')
  AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='posting_id' AND NOT attisdropped)]::smallint[]
  AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id' AND NOT attisdropped)]::smallint[])
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('distribution_accrual_task_state_check','REVIEW_REQUIRED'),('distribution_accrual_task_reason_code_check','A-Z0-9_'),
  ('distribution_accrual_task_outcome_check','SKIPPED')
 ) required(name,marker) WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c
  WHERE c.conrelid=to_regclass('zzsh_order.distribution_accrual_task') AND c.contype='c' AND c.conname=required.name
   AND c.convalidated AND position(required.marker IN pg_get_constraintdef(c.oid))>0))
 AND EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid=to_regclass('zzsh_order.distribution_accrual_task') AND a.attname='state'
   AND position('PENDING' IN pg_get_expr(d.adbin,d.adrelid))>0)
 AND NOT EXISTS(SELECT 1 FROM (VALUES('next_attempt_at'),('created_at'),('updated_at')) required(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
   WHERE d.adrelid=to_regclass('zzsh_order.distribution_accrual_task') AND a.attname=required.name
    AND position('clock_timestamp' IN pg_get_expr(d.adbin,d.adrelid))>0))
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.distribution_accrual_task','distribution_accrual_task_guard','zzsh_order.guard_distribution_accrual_task()',23),
  ('zzsh_order.settlement_posting','settlement_distribution_accrual_enqueue','zzsh_order.enqueue_distribution_accrual_task()',5),
  ('zzsh_order.rental_referral_earning','rental_referral_earning_task_guard','zzsh_order.guard_referral_earning_task()',23)
 ) required(relation,name,signature,type) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=to_regclass('zzsh_order.distribution_accrual_task')
  WHERE t.tgrelid=to_regclass(required.relation) AND t.tgname=required.name AND t.tgfoid=to_regprocedure(required.signature)
   AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.type::smallint
   AND t.tgnargs=0 AND t.tgqual IS NULL AND NOT t.tgdeferrable AND p.proowner=c.relowner AND NOT p.prosecdef))
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_order.enqueue_distribution_accrual_task()')
  AND position('INSERT INTO zzsh_order.distribution_accrual_task' IN p.prosrc)>0)
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_order.guard_distribution_accrual_task()')
  AND position('accrual task original identity or completed state changed' IN p.prosrc)>0
  AND position('derive_frozen_referral_accrual' IN p.prosrc)>0 AND position('earning_expected_lines' IN p.prosrc)>0)
 AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_order.guard_referral_earning_task()')
  AND position('complete original accrual task' IN p.prosrc)>0)
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.derive_frozen_referral_accrual(text)','fixed fee commission lacks a bound completed settlement'),
  ('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)','allocationDigest')
 ) required(signature,marker) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p
  JOIN pg_class c ON c.oid=to_regclass('zzsh_order.distribution_accrual_task')
  WHERE p.oid=to_regprocedure(required.signature) AND p.proowner=c.relowner AND NOT p.prosecdef
   AND position(required.marker IN p.prosrc)>0 AND has_function_privilege(current_user,p.oid,'EXECUTE')))
 AND COALESCE(has_function_privilege(current_user,to_regprocedure('zzsh_order.earning_expected_lines(text)'),'EXECUTE'),false)
 AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_order.distribution_accrual_task_due')
  AND i.indrelid=to_regclass('zzsh_order.distribution_accrual_task') AND i.indisvalid AND i.indisready
  AND pg_get_indexdef(i.indexrelid,1,true)='next_attempt_at' AND pg_get_indexdef(i.indexrelid,2,true)='posting_id'
  AND position('PENDING' IN pg_get_expr(i.indpred,i.indrelid))>0)
 AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_order.referral_earning_posting')
  AND i.indrelid=to_regclass('zzsh_order.rental_referral_earning') AND i.indisvalid AND i.indisready
  AND pg_get_indexdef(i.indexrelid,1,true)='posting_id' AND pg_get_indexdef(i.indexrelid,2,true)='economic_key')
 AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('zzsh_supply.distribution_due_unfinished_receipt')
  AND i.indrelid=to_regclass('zzsh_supply.idempotency_record') AND i.indisvalid AND i.indisready
  AND pg_get_indexdef(i.indexrelid,1,true)='created_at' AND pg_get_indexdef(i.indexrelid,2,true)='key'
  AND position('response_status' IN pg_get_expr(i.indpred,i.indrelid))>0
  AND position('distribution-due-' IN pg_get_expr(i.indpred,i.indrelid))>0)
 AND NOT EXISTS(SELECT 1 FROM (VALUES
  ('posting_id','SELECT'),('state','SELECT'),('reason_code','SELECT'),('next_attempt_at','SELECT'),
  ('posting_id','INSERT'),('state','UPDATE'),('reason_code','UPDATE'),('next_attempt_at','UPDATE'),('updated_at','UPDATE')
 ) required(name,privilege) WHERE NOT COALESCE(has_column_privilege(current_user,
  to_regclass('zzsh_order.distribution_accrual_task'),required.name,required.privilege),false))
 ,false)`;

export async function distributionAccrualTaskSchema(client: Pick<PoolClient,'query'>): Promise<'ABSENT'|'READY'|'PARTIAL'> {
  const row = (await client.query(`SELECT /* distribution_accrual_task_schema_v1 */
   ${distributionAccrualTaskAbsentSql} AS absent, ${distributionAccrualTaskContractSql} AS ready`)).rows[0];
  return row?.ready === true ? 'READY' : row?.absent === true ? 'ABSENT' : 'PARTIAL';
}

/** Installed trigger records the task in the posting transaction, including during rolling upgrades. */
export async function assertDistributionAccrualTask(client: PoolClient, postingId: string, required: boolean): Promise<void> {
  const schema = await distributionAccrualTaskSchema(client);
  if (schema === 'ABSENT' && !required) return;
  if (schema !== 'READY') throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Distribution accrual task contract is unavailable');
  const task = await client.query("SELECT 1 FROM zzsh_order.distribution_accrual_task WHERE posting_id=$1 AND state='PENDING'", [postingId]);
  if (task.rowCount !== 1) throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Original posting accrual task is unavailable');
}

export class DistributionAccrualSessionLost extends Error {}

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'ACCRUAL_WRITE_UNAVAILABLE';
};
const needsReview = (error: unknown) => {
  const value = error as { status?: unknown; code?: unknown } | null;
  return typeof value?.status === 'number' && value.status >= 400 && value.status < 500
    || value?.status === 503 && value?.code === 'EVIDENCE_UNAVAILABLE'
    || typeof value?.code === 'string' && /^23[0-9A-Z]{3}$/.test(value.code);
};

/** Run on the 806007 lock session. Task state and any resulting earnings share one transaction. */
export async function runDistributionAccrualTasks(
  client: PoolClient,
  store: DistributionEarningStore,
  operator: MaintenanceOperator,
  limit: number,
  stillHeld: () => boolean,
): Promise<{ available: boolean; examined: number; completed: number; review: number }> {
  let page: Awaited<ReturnType<DistributionEarningStore['pendingAccrualTasks']>>;
  let discoveryCommitRequested = false;
  try {
    await client.query('BEGIN');
    page = await store.pendingAccrualTasks(client, limit);
    if (!stillHeld()) throw new DistributionAccrualSessionLost('Distribution worker lock is no longer held');
    discoveryCommitRequested = true;
    await client.query('COMMIT');
  } catch (error) {
    if (discoveryCommitRequested) throw new DistributionAccrualSessionLost('Accrual discovery commit outcome is unknown', { cause: error });
    try { await client.query('ROLLBACK'); }
    catch { throw new DistributionAccrualSessionLost('Accrual task discovery requires a fresh session'); }
    if (!stillHeld()) throw new DistributionAccrualSessionLost('Distribution worker lock is no longer held');
    throw error;
  }
  const result = { available: page.available, examined: 0, completed: 0, review: 0 };
  for (const task of page.items) {
    if (!stillHeld()) throw new DistributionAccrualSessionLost('Distribution worker lock is no longer held');
    result.examined++;
    const requestId = `accrual_${createHash('sha256').update(task.postingId).digest('hex').slice(0, 40)}`;
    let commitRequested = false;
    try {
      await client.query('BEGIN');
      const allocation = await store.accrueOn(client, task.orderId, requestId, operator);
      const state = allocation.knowledge === 'UNKNOWN' ? 'REVIEW_REQUIRED' : allocation.items.length ? 'DONE' : 'SKIPPED';
      const reason = allocation.knowledge === 'UNKNOWN' ? codeOf({ code: allocation.reason })
        : state === 'SKIPPED' ? codeOf({ code: allocation.skipReason ?? 'NO_ELIGIBLE_REFERRAL' }) : null;
      const changed = await client.query(`UPDATE zzsh_order.distribution_accrual_task
        SET state=$2,reason_code=$3,updated_at=clock_timestamp() WHERE posting_id=$1 AND state='PENDING'`,
        [task.postingId, state, reason]);
      if (changed.rowCount !== 1) throw new Error('Original accrual task changed');
      if (!stillHeld()) throw new DistributionAccrualSessionLost('Distribution worker lock is no longer held');
      commitRequested = true;
      await client.query('COMMIT');
      if (state === 'REVIEW_REQUIRED') result.review++; else result.completed++;
    } catch (error) {
      // A lost COMMIT acknowledgement cannot prove rollback or justify a new write.
      if (commitRequested) throw new DistributionAccrualSessionLost('Accrual commit outcome is unknown; recover the original task', { cause: error });
      try { await client.query('ROLLBACK'); }
      catch { throw new DistributionAccrualSessionLost('Accrual transaction requires original-task recovery'); }
      if (!stillHeld()) throw new DistributionAccrualSessionLost('Distribution worker lock is no longer held');
      if (error instanceof DistributionAccrualSessionLost) throw error;
      const code = codeOf(error);
      if (needsReview(error)) {
        const changed = await client.query(`UPDATE zzsh_order.distribution_accrual_task SET state='REVIEW_REQUIRED',reason_code=$2,
          updated_at=clock_timestamp() WHERE posting_id=$1 AND state='PENDING'`, [task.postingId, code]);
        if (changed.rowCount === 1) result.review++;
      } else {
        // A lost COMMIT may already have completed the task; never overwrite that result.
        await client.query(`UPDATE zzsh_order.distribution_accrual_task SET reason_code=$2,
          next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
          WHERE posting_id=$1 AND state='PENDING'`, [task.postingId, code]);
      }
    }
  }
  return result;
}
