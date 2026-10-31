import type { INestApplication } from '@nestjs/common';
import { readAdminContext, type AuthSecurityOptions } from '../auth/auth-security';
import { withTransaction } from '../auth/security-core';
import { loadEffectiveAdminAccess } from '../auth/admin-authorization';
import { assertGameScopeUsable, readAdminGameScope, scopeAllowsGame } from '../auth/admin-scope';
import { ensureApiV1RequestId } from '../contracts/api-v1';
import { bodyOf, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from '../supply/supply-util';
import { requestPath, requireOrigin, safely, type SupplyResponse } from '../supply/supply-routes';
import { DISTRIBUTION_POLICY_PERMISSION } from './distribution-policy-store';
import type { DistributionEarningStore } from './distribution-earning-store';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type Options = AuthSecurityOptions & { distributionEarnings: DistributionEarningStore };
async function authorize(c: Parameters<Parameters<typeof withTransaction>[1]>[0], adminId: string) {
  const access = await loadEffectiveAdminAccess(c, adminId);
  if (!access || access.status !== 'ACTIVE' || !access.permissions.has(DISTRIBUTION_POLICY_PERMISSION.manage)) throw forbidden('Distribution operations permission required');
  const scope = access.isBoss ? null : await readAdminGameScope(c, adminId);
  if (scope) assertGameScopeUsable(scope, false);
  return { isBoss: access.isBoss === true, games: scope ? scope.gameIds : null, scope };
}
async function assertOrderScope(c: Parameters<Parameters<typeof withTransaction>[1]>[0], actor: { isBoss: boolean; scope: any }, orderIds: string[]) {
  if (actor.isBoss) return;
  const rows = (await c.query('SELECT id,game_id FROM zzsh_order.rental_order WHERE id=ANY($1::text[])', [orderIds])).rows;
  if (rows.length !== orderIds.length || rows.some(row => !scopeAllowsGame(actor.scope, false, row.game_id))) throw forbidden('Distribution order is outside the admin game scope');
}
/** Operator-only bounded maintenance. No full-table scheduler and no page GET drives money. */
export async function handleAdminDistributionMaintenance(request: SupplyNodeRequest, response: SupplyResponse, options: Options) {
  const requestId = ensureApiV1RequestId(request);
  return safely(response, requestId, async () => {
    const { path, query } = requestPath(request, '/api/v1/admin/distribution/maintenance'), method = request.method ?? 'GET';
    if (!requireOrigin(request, response, options, requestId)) return;
    const actor = { ...await readAdminContext(request, options), requestId };
    if (method === 'GET' && path === '/accruals') {
      if (query.size > 1 || query.size && query.getAll('limit').length !== 1) throw invalid('Bounded accrual discovery query required');
      const limit = query.get('limit') ?? '20';
      if (!/^[1-9]\d?$|^100$/.test(limit)) throw invalid('Accrual discovery limit must be 1-100');
      const authorized = await withTransaction(options.pool, c => authorize(c, actor.userId));
      const result = await options.distributionEarnings.discover(options.pool, { limit: Number(limit), gameIds: authorized.games });
      sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', asOf: new Date().toISOString(), ...result }, requestId);
      return;
    }
    if (method === 'POST' && (path === '/accruals/replay' || path === '/due-settlements')) {
      if (query.size) throw invalid('Maintenance command does not accept query parameters');
      const body = bodyOf(request);
      const key = Object.keys(body).sort();
      if (path === '/accruals/replay') {
        if (key.join(',') !== 'orderIds,requestId') throw invalid('Exact replay input required');
        const orderIds = body.orderIds, commandId = body.requestId;
        if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 100 || orderIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(orderIds).size !== orderIds.length
          || typeof commandId !== 'string' || !ID.test(commandId)) throw invalid('One bounded unique order cohort and request required');
        const authorized = await withTransaction(options.pool, async c => { const access = await authorize(c, actor.userId); await assertOrderScope(c, access, orderIds); return access; });
        const result = await options.distributionEarnings.replay(options.pool, orderIds, commandId);
        sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
        return;
      }
      if (key.join(',') !== 'limit,requestId') throw invalid('Exact due settlement input required');
      const limit = body.limit, commandId = body.requestId;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100 || typeof commandId !== 'string' || !ID.test(commandId)) throw invalid('Bounded due batch and request required');
      const authorized = await withTransaction(options.pool, c => authorize(c, actor.userId));
      const result = await options.distributionEarnings.settleDue(options.pool, limit as number, commandId, authorized.games);
      sendJson(response, 200, { contractVersion: 'distribution-maintenance.v1', ...result }, requestId);
      return;
    }
    throw notFound();
  });
}
export function mountAdminDistributionMaintenanceRoutes(app: INestApplication, options: Options) {
  app.getHttpAdapter().getInstance().use('/api/v1/admin/distribution/maintenance', (request: SupplyNodeRequest, response: SupplyResponse) =>
    handleAdminDistributionMaintenance(request, response, options));
}
