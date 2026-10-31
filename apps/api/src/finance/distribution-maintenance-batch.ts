import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, recordAudit } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { conflict, forbidden, invalid, notFound } from '../supply/supply-util';
import type { MaintenanceBatch, MaintenanceOperator } from './distribution-earning-store';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unusableClients = new WeakSet<PoolClient>();
type Operation = 'ACCRUALS_REPLAY' | 'DUE_SETTLE';
/** Money bodies run on the caller's client so a batch never borrows a second pooled connection. */
type Callbacks = {
  local: boolean;
  allowedOrderIds: readonly string[];
  accrue: (client: PoolClient, orderId: string, requestId: string, operator?: MaintenanceOperator) => Promise<any>;
  transition: (client: PoolClient, earningId: string, action: 'SETTLE', expectedVersion: string, requestId: string, reversalSourceId: string | undefined, operator?: MaintenanceOperator) => Promise<any>;
};
export type MaintenanceBatchResult = { httpStatus: number; batch: MaintenanceBatch; replayed: boolean };
type Target = { pool: Pool; client?: PoolClient };
type CommandInput = { requestId: string; operator: MaintenanceOperator; gameIds?: readonly string[] | null; orderIds?: readonly string[]; limit?: number; client?: PoolClient };
/** One namespace per actor: the fingerprint carries the operation, so a key can never name two different commands. */
const scopeKey = (operator: MaintenanceOperator) => JSON.stringify([operator.system ? 'system' : 'admin', operator.userId, 'distribution.maintenance', null]);
const auditActor = (operator: MaintenanceOperator) => operator.system ? { actorType: 'system', actorId: operator.userId } : { actorType: 'admin', actorId: operator.userId, sessionId: operator.sessionId };
const failureCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'EARNING_WRITE_FAILED';
};
/**
 * A business rejection means the money transaction rolled back without writing, so it is terminal for
 * this command and must not be confused with a lost commit acknowledgement.
 */
const terminalRejection = (error: unknown) => {
  const candidate = error as { constructor?: { name?: string }; status?: unknown; code?: unknown };
  return candidate?.constructor?.name === 'SecurityApiError' && Number.isSafeInteger(candidate.status) && (candidate.status as number) < 500 && typeof candidate.code === 'string';
};
function games(value: readonly string[] | null | undefined) {
  if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 50 || new Set(value).size !== value.length || value.some(id => !ID.test(id)))) throw invalid('Bounded game scope required');
  return value === null || value === undefined ? null : [...value];
}
const batchIds = (batch: MaintenanceBatch) => batch.operation === 'DUE_SETTLE' ? (batch.plan.earningIds ?? []).map(item => item.earningId) : (batch.plan.orderIds ?? []);
/** Re-reads the object scope of every planned root so a narrowed admin cannot keep reading a stale plan. */
async function assertPlanScope(client: PoolClient, operator: MaintenanceOperator, batch: MaintenanceBatch) {
  if (!operator.games) return;
  const allowed = games(await operator.games(client));
  if (allowed === null) return;
  const ids = batchIds(batch);
  if (!ids.length) return;
  const rows = batch.operation === 'DUE_SETTLE'
    ? (await client.query('SELECT e.id,o.game_id FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=ANY($1::text[])', [ids])).rows
    : (await client.query('SELECT id,game_id FROM zzsh_order.rental_order WHERE id=ANY($1::text[])', [ids])).rows;
  if (rows.length !== ids.length || rows.some(row => !allowed.includes(row.game_id))) throw forbidden('Distribution batch is outside the admin game scope');
}
async function onClient<T>(client: PoolClient, run: () => Promise<T>) {
  if (unusableClients.has(client)) throw conflict('Original transaction requires receipt recovery on a new connection');
  await client.query('BEGIN');
  try { const value = await run(); await client.query('COMMIT'); return value; }
  catch (error) {
    try { await client.query('ROLLBACK'); } catch { unusableClients.add(client); }
    throw error;
  }
}
/** Plan, money and progress share one connection: the session lock and its work die together. */
async function withBatchLock<T>(target: Target, key: string, run: (client: PoolClient) => Promise<T>): Promise<T | null> {
  const borrowed = target.client ? null : await target.pool.connect();
  const client = target.client ?? borrowed!;
  const lockKey = JSON.stringify(['distribution-maintenance-batch', key]);
  let acquired = false;
  try {
    try { acquired = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey])).rows[0]?.acquired === true; }
    catch (error) { unusableClients.add(client); throw error; }
    if (!acquired) return null;
    return await run(client);
  } finally {
    if (acquired && !unusableClients.has(client)) {
      try {
        const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released', [lockKey]);
        if (result.rows[0]?.released !== true) unusableClients.add(client);
      } catch { unusableClients.add(client); }
    }
    if (borrowed || unusableClients.has(client)) client.release(unusableClients.has(client) ? true : undefined);
  }
}
async function updateReceipt(client: PoolClient, operator: MaintenanceOperator, key: string, fingerprint: string, status: number, batch: MaintenanceBatch) {
  const changed = await client.query('UPDATE zzsh_supply.idempotency_record SET response_status=$2,response_body=$3::jsonb WHERE scope_key=$1 AND key=$4 AND request_fingerprint=$5',
    [scopeKey(operator), status, JSON.stringify(batch), key, fingerprint]);
  if (changed.rowCount !== 1) throw conflict('Distribution batch receipt changed');
}
async function loadBatch(client: PoolClient, operator: MaintenanceOperator, key: string, forUpdate: boolean) {
  const row = (await client.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [scopeKey(operator), key])).rows[0] as { fingerprint: string; status: number; body: MaintenanceBatch } | undefined;
  return row ? { batch: row.body, status: row.status, fingerprint: row.fingerprint } : null;
}
async function plan(client: PoolClient, operation: Operation, input: CommandInput, callbacks: Callbacks) {
  const operator = input.operator, key = input.requestId;
  const body = operation === 'DUE_SETTLE' ? { limit: input.limit } : { orderIds: input.orderIds };
  await operator.authorize(client);
  const gameScope = operator.games ? games(await operator.games(client)) : games(input.gameIds);
  const fingerprint = sha(canonicalize({ schema: 'distribution-maintenance-command.v1', operation, requestId: key, body, games: gameScope }));
  const found = await loadBatch(client, operator, key, true);
  if (found) {
    if (found.fingerprint !== fingerprint) throw conflict('Original distribution batch key was reused with different parameters');
    return { batch: found.batch, replayed: true };
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
  const batch: MaintenanceBatch = { schema: 'distribution-maintenance-batch.v1', operation, state: 'PLANNED', requestId: key, fingerprint,
    command: { ...body, games: gameScope }, plan: planValue, results: [], notAttempted: count, updatedAt: new Date().toISOString() };
  await client.query('INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required) VALUES($1,$2,$3,202,$4::jsonb,false)',
    [scopeKey(operator), key, fingerprint, JSON.stringify(batch)]);
  await recordAudit(client, { ...auditActor(operator), action: 'distribution.maintenance.batch.planned',
    objectType: 'distribution_maintenance_batch', objectId: key, requestId: key, outcome: 'SUCCESS', details: { operation, fingerprint, notAttempted: count, command: batch.command } });
  return { batch, replayed: false };
}
async function execute(client: PoolClient, batch: MaintenanceBatch, operator: MaintenanceOperator, callbacks: Callbacks) {
  if (batch.state === 'COMPLETE') return batch;
  let current = batch;
  const items: any[] = current.operation === 'DUE_SETTLE' ? [...(current.plan.earningIds ?? [])] : (current.plan.orderIds ?? []).map(orderId => ({ orderId }));
  const itemId = (item: any) => current.operation === 'DUE_SETTLE' ? item.earningId : item.orderId;
  const save = async (status: number) => onClient(client, async () => {
    if (status === 200 || status === 503) await recordAudit(client, { ...auditActor(operator),
      action: 'distribution.maintenance.batch.' + current.state.toLowerCase(), objectType: 'distribution_maintenance_batch', objectId: current.requestId, requestId: current.requestId,
      outcome: status === 200 ? 'SUCCESS' : 'FAILURE', details: { operation: current.operation, fingerprint: current.fingerprint, notAttempted: current.notAttempted } });
    await updateReceipt(client, operator, current.requestId, current.fingerprint, status, current);
  });
  for (const item of items) {
    const id = itemId(item);
    // REJECTED/SETTLED/ACCRUED/REPLAYED are terminal for this command; only UNKNOWN is re-attempted.
    if (current.results.some(result => result.id === id && result.status !== 'UNKNOWN')) continue;
    let result: Record<string, any>;
    try {
      if (current.operation === 'DUE_SETTLE') {
        const value = await onClient(client, () => callbacks.transition(client, item.earningId, 'SETTLE', item.version, current.requestId, undefined, operator));
        result = { id, earningId: item.earningId, status: 'SETTLED', currentState: value.root.state, replayed: value.replayed };
      } else {
        const value = await onClient(client, () => callbacks.accrue(client, item.orderId, current.requestId, operator));
        if (value.knowledge === 'UNKNOWN') result = { id, orderId: item.orderId, status: 'REJECTED', reason: value.reason, baseCents: value.baseCents };
        else result = { id, orderId: item.orderId, status: value.items.every((x: any) => x.replayed) ? 'REPLAYED' : 'ACCRUED', earningIds: value.items.map((x: any) => x.root.id) };
      }
    } catch (error) {
      // A failed rollback cannot share a later receipt transaction that might commit old work.
      if (unusableClients.has(client)) throw error;
      const rejected = terminalRejection(error);
      const nextResults = [...current.results.filter(resultValue => resultValue.id !== id), { id, ...(current.operation === 'DUE_SETTLE' ? { earningId: item.earningId } : { orderId: item.orderId }),
        status: rejected ? 'REJECTED' : 'UNKNOWN', errorCode: failureCode(error), ...(rejected ? {} : { recoveryRequired: true }) }];
      current = { ...current, state: rejected ? current.state : 'UNKNOWN', results: nextResults, notAttempted: items.length - nextResults.length, updatedAt: new Date().toISOString() };
      await save(rejected ? 202 : 503);
      if (!rejected) return current;
      continue;
    }
    const nextResults = [...current.results.filter(resultValue => resultValue.id !== id), result];
    current = { ...current, state: 'RUNNING', results: nextResults, notAttempted: items.length - nextResults.length, updatedAt: new Date().toISOString() };
    await save(202);
  }
  current = { ...current, state: 'COMPLETE', notAttempted: 0, updatedAt: new Date().toISOString() };
  await save(200);
  return current;
}
/** Plan + execute under one lock acquisition, so no window lets a second command re-plan the same key. */
async function command(target: Target, operation: Operation, input: CommandInput, callbacks: Callbacks): Promise<MaintenanceBatchResult | null> {
  return withBatchLock(target, scopeKey(input.operator) + '|' + input.requestId, async client => {
    const planned = await onClient(client, () => plan(client, operation, input, callbacks));
    if (planned.batch.state === 'COMPLETE') return { httpStatus: 200, batch: planned.batch, replayed: true };
    const batch = await execute(client, planned.batch, input.operator, callbacks);
    return { httpStatus: batch.state === 'COMPLETE' ? 200 : 503, batch, replayed: planned.replayed };
  });
}
/** Recovery by original key only: the stored plan and fingerprint are the input, never the current config. */
async function resume(target: Target, input: { requestId: string; operator: MaintenanceOperator }, callbacks: Callbacks): Promise<MaintenanceBatchResult | null> {
  return withBatchLock(target, scopeKey(input.operator) + '|' + input.requestId, async client => {
    const stored = await onClient(client, async () => {
      await input.operator.authorize(client);
      const found = await loadBatch(client, input.operator, input.requestId, true);
      if (!found) throw notFound();
      await assertPlanScope(client, input.operator, found.batch);
      return found;
    });
    if (stored.batch.state === 'COMPLETE') return { httpStatus: 200, batch: stored.batch, replayed: true };
    const batch = await execute(client, stored.batch, input.operator, callbacks);
    return { httpStatus: batch.state === 'COMPLETE' ? 200 : 503, batch, replayed: true };
  });
}
export function createMaintenanceBatchRunner(callbacks: Callbacks) {
  return {
    async runReplayBatch(pool: Pool, input: CommandInput): Promise<MaintenanceBatchResult> {
      const result = await command({ pool, client: input.client }, 'ACCRUALS_REPLAY', input, callbacks);
      if (!result) throw conflict('Distribution batch is already running');
      return result;
    },
    async runDueBatch(pool: Pool, input: CommandInput): Promise<MaintenanceBatchResult> {
      const result = await command({ pool, client: input.client }, 'DUE_SETTLE', input, callbacks);
      if (!result) throw conflict('Distribution batch is already running');
      return result;
    },
    async resumeBatch(pool: Pool, input: { requestId: string; operator: MaintenanceOperator; client?: PoolClient }): Promise<MaintenanceBatchResult> {
      if (typeof input.requestId !== 'string' || !ID.test(input.requestId)) throw invalid('Exact batch request id required');
      const result = await resume({ pool, client: input.client }, input, callbacks);
      if (!result) throw conflict('Distribution batch is already running');
      return result;
    },
    async findUnfinishedBatch(pool: Pool, input: { operator: MaintenanceOperator; client?: PoolClient }) {
      const work = async (client: PoolClient) => {
        const found = await client.query(`SELECT key,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record
          WHERE scope_key=$1 AND response_status<>200 ORDER BY created_at DESC LIMIT 1`, [scopeKey(input.operator)]);
        const row = found.rows[0] as { key: string; status: number; body: MaintenanceBatch } | undefined;
        return row ? { requestId: row.key, status: Number(row.status), operation: row.body.operation } : null;
      };
      return input.client ? onClient(input.client, () => work(input.client!)) : withTransaction(pool, work);
    },
    async readBatch(pool: Pool, input: { requestId: string; operator: MaintenanceOperator; client?: PoolClient }) {
      if (typeof input.requestId !== 'string' || !ID.test(input.requestId)) throw invalid('Exact batch request id required');
      const work = async (client: PoolClient) => {
        await input.operator.authorize(client);
        const found = await loadBatch(client, input.operator, input.requestId, false);
        if (!found) return null;
        await assertPlanScope(client, input.operator, found.batch);
        return { httpStatus: Number(found.status), batch: found.batch };
      };
      return input.client ? onClient(input.client, () => work(input.client!)) : withTransaction(pool, work);
    },
  };
}
