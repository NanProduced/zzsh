import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import * as adminAuthorization from '../src/auth/admin-authorization';
import * as adminScope from '../src/auth/admin-scope';
import {
  assertReversalObjectScope,
  createDistributionReversalApprovalExecutor,
  parseDistributionReversalRequest,
  reversalObjectGameId,
  reversalObjectGameIds,
  validateDistributionReversalSubmission,
} from '../src/finance/distribution-reversal-approval';
import { evaluateApprovalActions } from '../src/auth/approval-audit';

const payload = { schema: 'distribution-reversal-request.v1', earningId: 'earning_1', orderId: 'order_1', amountCents: '2500', full: true, reason: '客服核实的错发佣金' };
const earningRow = { id: 'earning_1', order_id: 'order_1', amount_cents: '2500', state: 'SETTLED', beneficiary_role: 'OWNER_REFERRAL', game_id: 'delta', reversals: 0 };

let currentRows: { earning?: any; existing?: any } = {};
const rows_earning = () => currentRows.earning;
function fakeDb(rows: { earning?: any; existing?: any } = {}) {
  currentRows = rows;
  const sql: string[] = [];
  const client = { async query(query: string, params: any[] = []) {
    sql.push(query);
    if (query.includes('AS "earningId"')) {
      const wanted: string[] = params[0] ?? [];
      const rows = wanted.includes(earningRow.id) ? [{ earningId: earningRow.id, gameId: (rows_earning()?.game_id) ?? 'delta' }] : [];
      return { rows, rowCount: rows.length };
    }
    if (query.includes('rental_referral_earning e') && query.includes('JOIN zzsh_order.rental_order o ON o.id=e.order_id')) {
      const row = rows.earning === undefined ? earningRow : rows.earning;
      const matched = row && row.id === params[0] && (!params[1] || row.order_id === params[1]) ? [row] : (Array.isArray(params[0]) ? (row ? [row] : []) : []);
      return { rows: matched, rowCount: matched.length };
    }
    if (query.includes('FROM zzsh_iam.approval_request')) return { rows: rows.existing ? [rows.existing] : [], rowCount: rows.existing ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } } as unknown as PoolClient & { query: any };
  return { client, sql };
}

/** The access rows come from the real admin-authorization loader; only its result is scripted here. */
function stubAccess(map: Record<string, any>) {
  const previous = { load: adminAuthorization.loadEffectiveAdminAccess, scope: adminScope.readAdminGameScope };
  (adminAuthorization as any).loadEffectiveAdminAccess = async (_client: any, adminUserId: string) => map[adminUserId] ?? null;
  (adminScope as any).readAdminGameScope = async (_client: any, adminUserId: string) => map[adminUserId]?.scope ?? { mode: 'SELECTED_GAMES', gameIds: [] };
  return () => { (adminAuthorization as any).loadEffectiveAdminAccess = previous.load; (adminScope as any).readAdminGameScope = previous.scope; };
}
const operator = (scope: any) => ({ status: 'ACTIVE', isBoss: false, passwordChangeRequired: false, permissions: new Set(['personal.distribution.policy.manage']), scope });
const boss = { status: 'ACTIVE', isBoss: true, passwordChangeRequired: false, permissions: new Set<string>(), scope: { mode: 'SELECTED_GAMES', gameIds: ['alpha'] } };

test('the reversal object scope is the original order game, read server-side', async () => {
  const db = fakeDb();
  assert.equal(await reversalObjectGameId(db.client, 'earning_1', 'order_1'), 'delta');
  await assert.rejects(reversalObjectGameId(db.client, 'earning_1', 'order_other'), /not found|404/i);
  const missing = fakeDb({ earning: null });
  await assert.rejects(reversalObjectGameId(missing.client, 'earning_x', 'order_x'));
  const batch = await reversalObjectGameIds(db.client, [{ earningId: 'earning_1' }]);
  assert.equal(batch.get('earning_1'), 'delta');
  await assert.rejects(reversalObjectGameIds(db.client, [{ earningId: 'earning_absent' }]));
  await assert.rejects(reversalObjectGameIds(db.client, [{ earningId: 'bad id' }]));
  assert.equal((await reversalObjectGameIds(db.client, [])).size, 0);
});

test('a withdrawn game scope blocks the reversal at creation, execution and read', async () => {
  const restore = stubAccess({ ops_1: operator({ mode: 'SELECTED_GAMES', gameIds: ['alpha'] }), boss_1: boss });
  try {
    const db = fakeDb();
    await assert.rejects(validateDistributionReversalSubmission(db.client, payload, 'ops_1'), /outside the admin game scope/);
    await assert.rejects(assertReversalObjectScope(db.client, 'ops_1', 'delta'), /outside the admin game scope/);
    const empty = stubAccess({ ops_1: operator({ mode: 'SELECTED_GAMES', gameIds: [] }) });
    await assert.rejects(assertReversalObjectScope(db.client, 'ops_1', 'delta'), /No game scope is assigned/, 'an empty explicit scope stays unusable, not global');
    empty();
    const all = stubAccess({ ops_1: operator({ mode: 'ALL_GAMES', gameIds: [] }) });
    assert.equal((await assertReversalObjectScope(db.client, 'ops_1', 'delta')).status, 'ACTIVE');
    all();
    assert.equal((await assertReversalObjectScope(db.client, 'boss_1', 'delta')).isBoss, true, 'Boss keeps the existing contract');
    const frozen = stubAccess({ ops_1: { ...operator({ mode: 'ALL_GAMES', gameIds: [] }), status: 'FROZEN' } });
    await assert.rejects(assertReversalObjectScope(db.client, 'ops_1', 'delta'), /remain active/);
    frozen();
    const unknown = stubAccess({});
    await assert.rejects(assertReversalObjectScope(db.client, 'ghost', 'delta'), /remain active/);
  } finally { restore(); }
});

test('creation still validates the original root and the in-flight request after scope', async () => {
  const restore = stubAccess({ ops_1: operator({ mode: 'ALL_GAMES', gameIds: [] }) });
  try {
    await validateDistributionReversalSubmission(fakeDb().client, payload, 'ops_1');
    await assert.rejects(validateDistributionReversalSubmission(fakeDb({ earning: { ...earningRow, game_id: 'delta' }, existing: { id: 'approval_1' } }).client, payload, 'ops_1'), /already requires handling/);
    await assert.rejects(validateDistributionReversalSubmission(fakeDb({ earning: { ...earningRow, reversals: 1 } }).client, payload, 'ops_1'), /not eligible/);
    await assert.rejects(validateDistributionReversalSubmission(fakeDb({ earning: { ...earningRow, amount_cents: '2400' } }).client, payload, 'ops_1'), /not eligible/);
    await assert.rejects(validateDistributionReversalSubmission(fakeDb({ earning: { ...earningRow, game_id: null } }).client, payload, 'ops_1'), /not eligible/);
    // A client-chosen gameId cannot widen the object scope: the payload shape has no such field.
    assert.throws(() => parseDistributionReversalRequest({ ...payload, gameId: 'delta' }));
  } finally { restore(); }
});

test('the executor re-checks the operator and the deciding Boss against the original order game', async () => {
  const input: any = { requestId: 'approval_req_r2', operationCode: 'distribution.earning.reverse', payloadVersion: 1, operationPayload: payload, operationPayloadHash: 'c'.repeat(64), requestedBy: 'ops_1', decidedBy: 'boss_1', expiresAt: new Date(Date.now() + 600000).toISOString() };
  const restore = stubAccess({ ops_1: operator({ mode: 'SELECTED_GAMES', gameIds: ['delta'] }), boss_1: boss });
  try {
    const db = fakeDb();
    const { canonicalize } = await import('../src/supply/content-hash');
  const digest = createHash('sha256').update(canonicalize(payload)).digest('hex');
    const executor = createDistributionReversalApprovalExecutor();
    const authorized = await executor(db.client, { ...input, operationPayloadHash: digest }, { userId: 'ops_1', sessionId: 'session_1' }, 'approval_req_r2');
    assert.deepEqual(authorized, { resultCode: 'DISTRIBUTION_REVERSAL_AUTHORIZED', resultDetail: 'earning_1' });
    // Operator scope withdrawn after the request was created.
    const narrowed = stubAccess({ ops_1: operator({ mode: 'SELECTED_GAMES', gameIds: ['alpha'] }), boss_1: boss });
    await assert.rejects(executor(db.client, { ...input, operationPayloadHash: digest }, { userId: 'ops_1', sessionId: 'session_1' }, 'approval_req_r2'), /outside the admin game scope/);
    narrowed();
    // Boss loses Boss status after deciding: the decider check fails first, and it never writes money.
    const demoted = stubAccess({ ops_1: operator({ mode: 'ALL_GAMES', gameIds: [] }), boss_1: { ...operator({ mode: 'ALL_GAMES', gameIds: [] }), isBoss: false } });
    await assert.rejects(executor(db.client, { ...input, operationPayloadHash: digest }, { userId: 'ops_1', sessionId: 'session_1' }, 'approval_req_r2'), /Boss approval required/);
    demoted();
    // The deciding Boss no longer covers the game and is not Boss-active: read side already fails closed.
    const frozenDecider = stubAccess({ ops_1: operator({ mode: 'ALL_GAMES', gameIds: [] }), boss_1: { ...boss, status: 'FROZEN' } });
    await assert.rejects(executor(db.client, { ...input, operationPayloadHash: digest }, { userId: 'ops_1', sessionId: 'session_1' }, 'approval_req_r2'), /Boss approval required/);
    frozenDecider();
    assert.equal(db.sql.filter(statement => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement)).length, 0, 'authorization never writes money');
  } finally { restore(); }
});

test('approval actions and candidates fail closed for a reversal without a resolvable object scope', () => {
  const access = { status: 'ACTIVE' as const, isBoss: false, passwordChangeRequired: false, permissions: new Set(['approval.request.approve', 'approval.request.execute', 'personal.distribution.policy.manage']) };
  const row = (objectGameId: any) => ({ id: 'approval_rev', templateId: 't', templateVersion: 1, operationCode: 'distribution.earning.reverse', triggerCondition: 'manual', payloadVersion: 1,
    operationPayload: payload, operationPayloadHash: 'c'.repeat(64), summary: '冲回', requestedBy: 'other_1', status: 'APPROVED', statusReason: null, expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), decidedAt: new Date(), decidedBy: 'boss_1', decisionReason: null, supersedesRequestId: null, supersededByRequestId: null, objectGameId });
  const base = { userId: 'ops_1', access, twoFactorEnabled: true, isCandidate: true, testOperationsEnabled: false, executorAssembled: true };
  const reasons = (input: any) => evaluateApprovalActions(input).map(item => [item.action, item.reasonCode] as const);
  const outside = reasons({ ...base, row: row('epsilon'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['alpha'] } });
  assert.equal(outside.find(item => item[0] === 'execute')?.[1], 'GAME_SCOPE_DENIED', 'a withdrawn game scope removes the execute affordance');
  const inside = reasons({ ...base, row: row('delta'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['delta'] } });
  assert.equal(inside.find(item => item[0] === 'execute')?.[1], 'OK');
  const unresolvable = reasons({ ...base, row: row(null), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['alpha'] } });
  assert.equal(unresolvable.find(item => item[0] === 'execute')?.[1], 'GAME_SCOPE_DENIED', 'a missing original object scope is never treated as global');
  const allGames = reasons({ ...base, row: row('delta'), gameScope: { mode: 'ALL_GAMES' as const, gameIds: [] } });
  assert.equal(allGames.find(item => item[0] === 'execute')?.[1], 'OK');
  const pending = { ...row('delta'), status: 'PENDING' as const, decidedAt: null, decidedBy: null };
  const bossApprove = reasons({ ...base, row: pending, access: { ...access, isBoss: true }, gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: [] } });
  assert.equal(bossApprove.find(item => item[0] === 'approve')?.[1], 'OK', 'Boss decision keeps the contracted global reach');
  const candidateApprove = reasons({ ...base, row: row('delta'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['delta'] } });
  assert.equal(candidateApprove.find(item => item[0] === 'approve')?.[1], 'BUSINESS_PERMISSION_REQUIRED', 'a non-Boss candidate is blocked by the Boss rule before scope');
});
