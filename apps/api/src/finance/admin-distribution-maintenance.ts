import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { readAdminContext, type AuthSecurityOptions } from '../auth/auth-security';
import { assertAdminCommandAuthorizedInTransaction } from '../auth/admin-auth-session';
import { withTransaction } from '../auth/security-core';
import { loadEffectiveAdminAccess } from '../auth/admin-authorization';
import { assertGameScopeUsable, readAdminGameScope, scopeAllowsGame } from '../auth/admin-scope';
import { ensureApiV1RequestId } from '../contracts/api-v1';
import { bodyOf, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from '../supply/supply-util';
import { requestPath, requireOrigin, safely, type SupplyResponse } from '../supply/supply-routes';
import { DISTRIBUTION_POLICY_PERMISSION } from './distribution-policy-store';
import type { DistributionEarningStore, MaintenanceOperator } from './distribution-earning-store';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Options = AuthSecurityOptions & { distributionEarnings: DistributionEarningStore };
type Actor = { userId: string; sessionId: string };
async function authorize(c: PoolClient, adminId: string) {
  const access = await loadEffectiveAdminAccess(c, adminId);
  if (!access || access.status !== 'ACTIVE' || !access.permissions.has(DISTRIBUTION_POLICY_PERMISSION.manage)) throw forbidden('Distribution operations permission required');
  const scope = access.isBoss ? null : await readAdminGameScope(c, adminId);
  if (scope) assertGameScopeUsable(scope, false);
  return { isBoss: access.isBoss === true, games: scope ? scope.gameIds : null, scope };
}
async function assertOrderScope(c: PoolClient, actor: { isBoss: boolean; scope: any }, orderIds: string[]) {
  if (actor.isBoss) return;
  const rows = (await c.query('SELECT id,game_id FROM zzsh_order.rental_order WHERE id=ANY($1::text[])', [orderIds])).rows;
  if (rows.length !== orderIds.length || rows.some(row => !scopeAllowsGame(actor.scope, false, row.game_id))) throw forbidden('Distribution order is outside the admin game scope');
}
/** Revalidates admin session, current permission and object game scope inside each money transaction. */
function operatorFor(actor: Actor): MaintenanceOperator {
  return { userId: actor.userId, sessionId: actor.sessionId, authorize: async (c, orderId) => {
    await assertAdminCommandAuthorizedInTransaction(c, { userId: actor.userId, sessionId: actor.sessionId });
    const access = await loadEffectiveAdminAccess(c, actor.userId);
    if (!access || access.status !== 'ACTIVE' || !access.permissions.has(DISTRIBUTION_POLICY_PERMISSION.manage)) throw forbidden('Distribution operations permission required');
    if (!orderId) return;
    const order = (await c.query('SELECT game_id FROM zzsh_order.rental_order WHERE id=$1', [orderId])).rows[0];
    if (!order) throw notFound();
    if (!access.isBoss) {
      const scope = await readAdminGameScope(c, actor.userId);
      assertGameScopeUsable(scope, false);
      if (!scopeAllowsGame(scope, false, order.game_id)) throw forbidden('Distribution order is outside the admin game scope');
    }
  }, games: async c => {
    const access = await loadEffectiveAdminAccess(c, actor.userId);
    if (!access || access.status !== 'ACTIVE') throw forbidden('Distribution operations permission required');
    if (access.isBoss) return null;
    const scope = await readAdminGameScope(c, actor.userId);
    assertGameScopeUsable(scope, false);
    return scope.gameIds;
  } };
}
/** Operator-only bounded maintenance. No full-table scheduler and no page GET drives money. */
export async function handleAdminDistributionMaintenance(request: SupplyNodeRequest, response: SupplyResponse, options: Options) {
  const requestId = ensureApiV1RequestId(request);
  return safely(response, requestId, async () => {
    const { path, query } = requestPath(request, '/api/v1/admin/distribution/maintenance'), method = request.method ?? 'GET';
    if (!requireOrigin(request, response, options, requestId)) return;
    const context = await readAdminContext(request, options), actor: Actor = { userId: context.userId, sessionId: context.sessionId };
    if (method === 'GET' && path === '/accruals') {
      if (query.size > 2 || query.size && (query.getAll('limit').length > 1 || query.getAll('cursor').length > 1)) throw invalid('Bounded accrual discovery query required');
      const limit = query.get('limit') ?? '20', cursor = query.get('cursor');
      if (!/^[1-9]\d?$|^100$/.test(limit) || cursor !== null && (cursor.length > 400)) throw invalid('Accrual discovery limit must be 1-100');
      const authorized = await withTransaction(options.pool, c => authorize(c, actor.userId));
      const result = await options.distributionEarnings.discover(options.pool, { limit: Number(limit), gameIds: authorized.games, cursor });
      sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', asOf: new Date().toISOString(), ...result }, requestId);
      return;
    }
    if (method === 'GET' && /^\/batches\/[A-Za-z0-9._:-]+$/.test(path)) {
      if (query.size) throw invalid('Batch recovery does not accept query parameters');
      const result = await options.distributionEarnings.readBatch(options.pool, { requestId: path.slice('/batches/'.length), operator: operatorFor(actor) });
      if (!result) throw notFound();
      sendJson(response, result.httpStatus, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
      return;
    }
    if (method === 'GET' && /^\/orders\/[A-Za-z0-9._:-]+$/.test(path)) {
      if (query.size) throw invalid('Original order recovery does not accept query parameters');
      const orderId = path.slice('/orders/'.length);
      await withTransaction(options.pool, async c => { const access = await authorize(c, actor.userId); await assertOrderScope(c, access, [orderId]); });
      const result = await options.distributionEarnings.readOrder(options.pool, orderId);
      sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
      return;
    }
    if (method === 'POST' && (path === '/accruals/replay' || path === '/due-settlements')) {
      if (query.size) throw invalid('Maintenance command does not accept query parameters');
      const body = bodyOf(request), keys = Object.keys(body).sort();
      if (path === '/accruals/replay') {
        if (keys.join(',') !== 'orderIds,requestId') throw invalid('Exact replay input required');
        const orderIds = body.orderIds, commandId = body.requestId;
        if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 100 || orderIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(orderIds).size !== orderIds.length
          || typeof commandId !== 'string' || !ID.test(commandId)) throw invalid('One bounded unique order cohort and request required');
        const authorized = await withTransaction(options.pool, async c => { const access = await authorize(c, actor.userId); await assertOrderScope(c, access, orderIds); return access; });
        const result = await options.distributionEarnings.runReplayBatch(options.pool, { orderIds, requestId: commandId, operator: operatorFor(actor), gameIds: authorized.games });
        sendJson(response, result.httpStatus, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
        return;
      }
      if (keys.join(',') !== 'limit,requestId') throw invalid('Exact due settlement input required');
      const limit = body.limit, commandId = body.requestId;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || typeof commandId !== 'string' || !ID.test(commandId)) throw invalid('Bounded due batch and request required');
      const authorized = await withTransaction(options.pool, c => authorize(c, actor.userId));
      const result = await options.distributionEarnings.runDueBatch(options.pool, { limit: limit as number, requestId: commandId, operator: operatorFor(actor), gameIds: authorized.games });
      sendJson(response, result.httpStatus, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
      return;
    }
    if (method === 'POST' && /^\/earnings\/[A-Za-z0-9._:-]+\/(revoke|recover)$/.test(path)) {
      if (query.size) throw invalid('Earning transition does not accept query parameters');
      const match = /^\/earnings\/([A-Za-z0-9._:-]+)\/(revoke|recover)$/.exec(path)!;
      const body = bodyOf(request);
      if (Object.keys(body).sort().join(',') !== 'expectedVersion,requestId,reversalSourceId') throw invalid('Exact original reversal evidence required');
      const expectedVersion = body.expectedVersion, commandId = body.requestId, reversalSourceId = body.reversalSourceId;
      if (typeof expectedVersion !== 'string' || !/^[1-9]\d{0,18}$/.test(expectedVersion) || typeof commandId !== 'string' || !ID.test(commandId)
        || typeof reversalSourceId !== 'string' || !ID.test(reversalSourceId)) throw invalid('Exact original reversal evidence required');
      const orderId = await withTransaction(options.pool, async c => {
        await operatorFor(actor).authorize(c);
        const row = (await c.query('SELECT order_id FROM zzsh_order.rental_referral_earning WHERE id=$1', [match[1]])).rows[0];
        if (!row) throw notFound();
        await operatorFor(actor).authorize(c, row.order_id);
        return row.order_id as string;
      });
      const result = await options.distributionEarnings.transition(options.pool, match[1]!, match[2] === 'revoke' ? 'REVOKE' : 'RECOVER', expectedVersion, commandId, reversalSourceId, operatorFor(actor));
      sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', orderId, ...result }, requestId);
      return;
    }
    throw notFound();
  });
}
export function mountAdminDistributionMaintenanceRoutes(app: INestApplication, options: Options) {
  app.getHttpAdapter().getInstance().use('/api/v1/admin/distribution/maintenance', (request: SupplyNodeRequest, response: SupplyResponse) =>
    handleAdminDistributionMaintenance(request, response, options));
}
