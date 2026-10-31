import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, recordAudit } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { conflict, invalid, notFound } from '../supply/supply-util';
import type { MaintenanceBatch, MaintenanceOperator } from './distribution-earning-store';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Operation = 'ACCRUALS_REPLAY' | 'DUE_SETTLE';
type Callbacks = {
  local: boolean;
  allowedOrderIds: readonly string[];
  accrue: (pool: Pool, orderId: string, requestId: string, operator?: MaintenanceOperator) => Promise<any>;
  transition: (pool: Pool, earningId: string, action: 'SETTLE', expectedVersion: string, requestId: string, reversalSourceId: string | undefined, operator?: MaintenanceOperator) => Promise<any>;
};
export type MaintenanceBatchResult = { httpStatus: number; batch: MaintenanceBatch; replayed: boolean };
const scopeKey = (operation: Operation, operator: MaintenanceOperator) => JSON.stringify([operator.system ? 'system' : 'admin', operator.userId, 'distribution.' + operation.toLowerCase(), null]);
const auditActor = (operator: MaintenanceOperator) => operator.system ? { actorType: 'system', actorId: operator.userId } : { actorType: 'admin', actorId: operator.userId, sessionId: operator.sessionId };
const failureCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'EARNING_WRITE_FAILED';
};
function games(value: readonly string[] | null | undefined) {
  if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length || value.some(id => !ID.test(id)))) throw invalid('Bounded game scope required');
  return value === null || value === undefined ? null : [...value];
}
async function withLock<T>(pool: Pool, key: string, run: (client: PoolClient) => Promise<T>): Promise<T | null> {
  const client = await pool.connect(), lockKey = JSON.stringify(['distribution-maintenance-batch', key]);
  try {
    const acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey])).rows[0]?.acquired === true;
    if (!acquired) return null;
    return await run(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {});
    client.release();
  }
}
async function onClient<T>(client: PoolClient, run: () => Promise<T>) {
  await client.query('BEGIN');
  try { const value = await run(); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
async function updateReceipt(client: PoolClient, operation: Operation, operator: MaintenanceOperator, key: string, fingerprint: string, status: number, batch: MaintenanceBatch) {
  const changed = await client.query('UPDATE zzsh_supply.idempotency_record SET response_status=$2,response_body=$3::jsonb WHERE scope_key=$1 AND key=$4 AND request_fingerprint=$5',
    [scopeKey(operation, operator), status, JSON.stringify(batch), key, fingerprint]);
  if (changed.rowCount !== 1) throw conflict('Distribution batch receipt changed');
}
async function plan(pool: Pool, operation: Operation, input: { requestId: string; operator: MaintenanceOperator; gameIds?: readonly string[] | null; orderIds?: readonly string[]; limit?: number }, callbacks: Callbacks) {
  const operator = input.operator, key = input.requestId;
  const body = operation === 'DUE_SETTLE' ? { limit: input.limit } : { orderIds: input.orderIds };
  return withLock(pool, scopeKey(operation, operator) + '|' + key, async client => onClient(client, async () => {
    await operator.authorize(client);
    const gameScope = operator.games ? games(await operator.games(client)) : games(input.gameIds);
    const fingerprint = sha(canonicalize({ schema: 'distribution-maintenance-command.v1', operation, requestId: key, body, games: gameScope }));
    const found = (await client.query('SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2 FOR UPDATE',
      [scopeKey(operation, operator), key])).rows[0] as { fingerprint: string; status: number; body: MaintenanceBatch } | undefined;
    if (found) {
      if (found.fingerprint !== fingerprint) throw conflict('Original distribution batch key was reused with different parameters');
      return { batch: found.body, status: found.status, replayed: true };
    }
    let planValue: MaintenanceBatch['plan'];
    if (operation === 'DUE_SETTLE') {
      if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) throw invalid('Bounded due batch required');
      const rows = (await client.query(`SELECT e.id,e.version::text AS version FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
        WHERE e.state='PENDING' AND e.due_at<=clock_timestamp() AND ($1::text[] IS NULL OR e.order_id=ANY($1)) AND ($2::text[] IS NULL OR o.game_id=ANY($2))
        ORDER BY e.due_at,e.id LIMIT $3`, [callbacks.local ? [...callbacks.allowedOrderIds] : null, gameScope, input.limit])).rows;
      planValue = { earningIds: rows.map((row: any) => ({ earningId: row.id, version: String(row.version) })) };
    } else {
      const orderIds = [...(input.orderIds ?? [])];
      if (!orderIds.length || orderIds.length > 100 || new Set(orderIds).size !== orderIds.length || orderIds.some(id => !ID.test(id))) throw invalid('One bounded unique order cohort required');
      if (callbacks.local && orderIds.some(id => !callbacks.allowedOrderIds.includes(id))) throw notFound();
      if (gameScope) {
        const rows = (await client.query('SELECT id,game_id FROM zzsh_order.rental_order WHERE id=ANY($1::text[])', [orderIds])).rows;
        if (rows.length !== orderIds.length || rows.some(row => !gameScope.includes(row.game_id))) throw notFound();
      }
      planValue = { orderIds };
    }
    const count = operation === 'DUE_SETTLE' ? (planValue.earningIds?.length ?? 0) : (planValue.orderIds?.length ?? 0);
    const batch: MaintenanceBatch = { schema: 'distribution-maintenance-batch.v1', operation, state: 'PLANNED', requestId: key, fingerprint, plan: planValue, results: [], notAttempted: count, updatedAt: new Date().toISOString() };
    await client.query('INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required) VALUES($1,$2,$3,202,$4::jsonb,false)',
      [scopeKey(operation, operator), key, fingerprint, JSON.stringify(batch)]);
    await recordAudit(client, { ...auditActor(operator), action: 'distribution.maintenance.batch.planned',
      objectType: 'distribution_maintenance_batch', objectId: key, requestId: key, outcome: 'SUCCESS', details: { operation, fingerprint, notAttempted: count } });
    return { batch, status: 202, replayed: false };
  }));
}
async function execute(pool: Pool, batch: MaintenanceBatch, operator: MaintenanceOperator, callbacks: Callbacks) {
  if (batch.state === 'COMPLETE') return batch;
  return withLock(pool, scopeKey(batch.operation, operator) + '|' + batch.requestId, async client => {
    let current = batch;
    const items: any[] = current.operation === 'DUE_SETTLE' ? [...(current.plan.earningIds ?? [])] : (current.plan.orderIds ?? []).map(orderId => ({ orderId }));
    const itemId = (item: any) => current.operation === 'DUE_SETTLE' ? item.earningId : item.orderId;
    const save = async (status: number) => onClient(client, async () => {
      if (status === 200 || status === 503) await recordAudit(client, { ...auditActor(operator),
        action: 'distribution.maintenance.batch.' + current.state.toLowerCase(), objectType: 'distribution_maintenance_batch', objectId: current.requestId, requestId: current.requestId,
        outcome: status === 200 ? 'SUCCESS' : 'FAILURE', details: { operation: current.operation, fingerprint: current.fingerprint, notAttempted: current.notAttempted } });
      await updateReceipt(client, current.operation, operator, current.requestId, current.fingerprint, status, current);
    });
    for (const item of items) {
      const id = itemId(item);
      if (current.results.some(result => result.id === id && result.status !== 'UNKNOWN')) continue;
      let result: Record<string, any>;
      try {
        if (current.operation === 'DUE_SETTLE') {
          const value = await callbacks.transition(pool, item.earningId, 'SETTLE', item.version, current.requestId, undefined, operator);
          result = { id, earningId: item.earningId, status: 'SETTLED', currentState: value.root.state, replayed: value.replayed };
        } else {
          const value = await callbacks.accrue(pool, item.orderId, current.requestId, operator);
          if (value.knowledge === 'UNKNOWN') throw Object.assign(new Error(value.reason), { code: value.reason });
          result = { id, orderId: item.orderId, status: value.items.every((x: any) => x.replayed) ? 'REPLAYED' : 'ACCRUED', earningIds: value.items.map((x: any) => x.root.id) };
        }
      } catch (error) {
        const nextResults = [...current.results.filter(resultValue => resultValue.id !== id), { id, ...(current.operation === 'DUE_SETTLE' ? { earningId: item.earningId } : { orderId: item.orderId }), status: 'UNKNOWN', errorCode: failureCode(error) }];
        current = { ...current, state: 'UNKNOWN', results: nextResults, notAttempted: items.length - nextResults.length, updatedAt: new Date().toISOString() };
        await save(503);
        return current;
      }
      const nextResults = [...current.results.filter(resultValue => resultValue.id !== id), result];
      current = { ...current, state: 'RUNNING', results: nextResults, notAttempted: items.length - nextResults.length, updatedAt: new Date().toISOString() };
      await save(202);
    }
    current = { ...current, state: 'COMPLETE', notAttempted: 0, updatedAt: new Date().toISOString() };
    await save(200);
    return current;
  });
}
export function createMaintenanceBatchRunner(callbacks: Callbacks) {
  return {
    async runReplayBatch(pool: Pool, input: { orderIds: readonly string[]; requestId: string; operator: MaintenanceOperator; gameIds?: readonly string[] | null }): Promise<MaintenanceBatchResult> {
      const planned = await plan(pool, 'ACCRUALS_REPLAY', input, callbacks);
      if (!planned) throw conflict('Distribution batch is already running');
      const batch = await execute(pool, planned.batch, input.operator, callbacks);
      if (!batch) throw conflict('Distribution batch is already running');
      return { httpStatus: batch.state === 'COMPLETE' ? 200 : 503, batch, replayed: planned.replayed };
    },
    async runDueBatch(pool: Pool, input: { limit: number; requestId: string; operator: MaintenanceOperator; gameIds?: readonly string[] | null }): Promise<MaintenanceBatchResult> {
      const planned = await plan(pool, 'DUE_SETTLE', input, callbacks);
      if (!planned) throw conflict('Distribution batch is already running');
      const batch = await execute(pool, planned.batch, input.operator, callbacks);
      if (!batch) throw conflict('Distribution batch is already running');
      return { httpStatus: batch.state === 'COMPLETE' ? 200 : 503, batch, replayed: planned.replayed };
    },
    async readBatch(pool: Pool, input: { requestId: string; operator: MaintenanceOperator }) {
      if (typeof input.requestId !== 'string' || !ID.test(input.requestId)) throw invalid('Exact batch request id required');
      return withTransaction(pool, async client => {
        await input.operator.authorize(client);
        const row = (await client.query('SELECT response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=ANY($1::text[]) AND key=$2 ORDER BY created_at DESC LIMIT 1',
          [[scopeKey('DUE_SETTLE', input.operator), scopeKey('ACCRUALS_REPLAY', input.operator)], input.requestId])).rows[0] as { status: number; body: MaintenanceBatch } | undefined;
        return row ? { httpStatus: row.status, batch: row.body } : null;
      });
    },
  };
}
