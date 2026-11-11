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
import { APPROVAL_TEST_OPERATION } from '../src/auth/approval-business';

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

test('unregistered reversal operation has no initiation/decision/execution affordance; registered operations still fail closed on game scope', () => {
  const access = { status: 'ACTIVE' as const, isBoss: false, passwordChangeRequired: false, permissions: new Set(['approval.request.create', 'approval.request.read', 'approval.request.approve', 'approval.request.execute', 'approval.request.add_approver', 'personal.distribution.policy.manage']) };
  const row = (operationCode: string, objectGameId: any) => ({ id: 'approval_rev', templateId: 't', templateVersion: 1, operationCode, triggerCondition: 'manual', payloadVersion: 1,
    operationPayload: payload, operationPayloadHash: 'c'.repeat(64), summary: '冲回', requestedBy: 'other_1', status: 'APPROVED', statusReason: null, expiresAt: new Date(Date.now() + 600000), createdAt: new Date(), decidedAt: new Date(), decidedBy: 'boss_1', decisionReason: null, supersedesRequestId: null, supersededByRequestId: null, objectGameId });
  // decisionRole 为新增必填入参：OPS 可审批，纯客服由服务端硬拦。
  const base = { userId: 'ops_1', access, twoFactorEnabled: true, isCandidate: true, decisionRole: 'OPS' as const, testOperationsEnabled: true, executorAssembled: true };
  const reasons = (input: any) => evaluateApprovalActions(input).map(item => [item.action, item.reasonCode] as const);
  const reason = (input: any, action: string) => reasons(input).find(item => item[0] === action)?.[1];

  // distribution.earning.reverse 已从业务登记移除：无论对象游戏范围如何，审批/发起/候选动作一律 OPERATION_UNREGISTERED。
  const unregistered = reasons({ ...base, row: row('distribution.earning.reverse', 'epsilon'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['alpha'] } });
  for (const action of ['approve', 'reject', 'execute', 'replace', 'withdraw']) assert.equal(unregistered.find(item => item[0] === action)?.[1], 'OPERATION_UNREGISTERED', `${action} is unavailable for an unregistered operation`);
  // addCandidate 的审批权是 Boss 专属，用 Boss 身份越过该前置后仍落到未登记判定。
  assert.equal(reason({ ...base, access: { ...access, isBoss: true }, row: row('distribution.earning.reverse', 'delta'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['delta'] } }, 'addCandidate'), 'OPERATION_UNREGISTERED');
  // 即使对象范围不可解析、Boss 全局范围或 ALL_GAMES，下线类型也不会被放行。
  assert.equal(reason({ ...base, row: row('distribution.earning.reverse', null), gameScope: { mode: 'ALL_GAMES' as const, gameIds: [] } }, 'execute'), 'OPERATION_UNREGISTERED');
  assert.equal(reason({ ...base, row: row('distribution.earning.reverse', 'delta'), access: { ...access, isBoss: true }, gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: [] } }, 'execute'), 'OPERATION_UNREGISTERED');
  // 纯客服硬拦优先于未登记判定。
  assert.equal(reason({ ...base, decisionRole: 'SUPPORT_ONLY' as const, row: row('distribution.earning.reverse', 'delta'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['delta'] } }, 'approve'), 'SUPPORT_ROLE_DECISION_DENIED');

  // 对仍需保留的游戏范围断言，改用仍登记的审批类型。
  const outside = reason({ ...base, row: row(APPROVAL_TEST_OPERATION, 'epsilon'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['alpha'] } }, 'execute');
  assert.equal(outside, 'GAME_SCOPE_DENIED', 'a withdrawn game scope removes the execute affordance');
  const inside = reason({ ...base, row: row(APPROVAL_TEST_OPERATION, 'delta'), gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: ['delta'] } }, 'execute');
  assert.equal(inside, 'OK');
  const allGames = reason({ ...base, row: row(APPROVAL_TEST_OPERATION, 'delta'), gameScope: { mode: 'ALL_GAMES' as const, gameIds: [] } }, 'execute');
  assert.equal(allGames, 'OK');
  const boss = reason({ ...base, row: row(APPROVAL_TEST_OPERATION, 'delta'), access: { ...access, isBoss: true }, gameScope: { mode: 'SELECTED_GAMES' as const, gameIds: [] } }, 'execute');
  assert.equal(boss, 'OK', 'Boss decision keeps the contracted global reach');
});

/** Exercise the public recovery route: it assembles current action scope before any receipt lookup. */
async function recoveryRouteFixture(scope: any, options: { objectGameId?: string | null; operationCode?: string } = {}) {
  const operationCode = options.operationCode ?? 'distribution.earning.reverse';
  const objectGameId = options.objectGameId === undefined ? 'delta' : options.objectGameId;
  const access = { ...operator(scope), permissions: new Set(['approval.request.read', 'approval.request.execute', 'personal.distribution.policy.manage']) };
  const restore = stubAccess({ ops_1: access });
  const sql: string[] = [];
  let body: any, responseStatus: number | undefined;
  const row = { id: 'approval_recovery_r3', templateId: 'template_1', templateVersion: 1,
    operationCode, triggerCondition: 'manual', payloadVersion: 1,
    operationPayload: payload, operationPayloadHash: 'c'.repeat(64), summary: '全额冲回', requestedBy: 'ops_1',
    status: 'EXECUTED', statusReason: null, expiresAt: new Date(0), createdAt: new Date(0),
    decidedAt: new Date(0), decidedBy: 'boss_1', decisionReason: null,
    supersedesRequestId: null, supersededByRequestId: null, objectGameId };
  const pool = { async query(query: string) {
    sql.push(query);
    if (query.includes('FROM "zzsh_iam"."approval_request" WHERE "id" = $1')) return { rows: [row] };
    if (query.includes('FROM "zzsh_iam"."approval_request_candidate"')) return { rows: [] };
    if (query.includes('WHERE u."id" = $1')) return { rows: [{ id: 'ops_1', username: 'ops_1', name: 'Operator', status: 'ACTIVE', isBoss: false, twoFactorEnabled: true }] };
    // 统一审批口径新增的 SQL：决策角色层级与当前游戏范围（buildApprovalActionContext 会读取）。
    if (query.includes('FROM "zzsh_iam"."admin_user_role"')) return { rows: [{ code: 'role_preset_ops', canApprove: true }] };
    if (query.includes('admin_supply_scope')) return { rows: [{ mode: 'SELECTED_GAMES', gameIds: ['delta'] }] };
    if (query.includes('FROM "zzsh_supply"."idempotency_record"')) return { rows: [{ requestFingerprint: 'f'.repeat(64), responseStatus: 200,
      responseBody: { approvalRequestId: row.id, status: 'EXECUTED', resultCode: 'APPROVAL_EXECUTED' }, createdAt: new Date(0) }] };
    throw new Error('Unexpected recovery SQL: ' + query);
  }, async connect() { throw new Error('Recovery GET must not open a write transaction'); } };
  const response = { status(value: number) { responseStatus = value; return this; }, setHeader() { return this; }, json(value: unknown) { body = value; } };
  const { handleAdminApprovalRoute } = await import('../src/auth/approval-audit');
  return { sql, restore, response: () => ({ body, status: responseStatus }), run: () => handleAdminApprovalRoute({ method: 'GET',
    url: '/api/v1/admin/security/approvals/recovery?operation=approval.request.execute&key=recovery_r3&requestId=' + row.id, headers: {} },
    response, 'read_recovery_r3', { pool, testOperationsEnabled: true, approvalOperationExecutor: async () => ({ resultCode: 'UNUSED' }) } as any,
    async () => ({ userId: 'ops_1', sessionId: 'session_1' } as any)) };
}

test('recovery of an unregistered reversal operation is denied before any receipt lookup', async () => {
  const fixture = await recoveryRouteFixture({ mode: 'SELECTED_GAMES', gameIds: ['alpha'] });
  try {
    await assert.rejects(fixture.run(), (error: any) => error.status === 409 && /OPERATION_UNREGISTERED/.test(error.message));
    assert.equal(fixture.sql.filter(query => query.includes('idempotency_record')).length, 0);
    assert.equal(fixture.response().body, undefined);
  } finally { fixture.restore(); }
});

test('recovery preserves the original executed receipt for a still-registered operation within its object game scope', async () => {
  const fixture = await recoveryRouteFixture({ mode: 'SELECTED_GAMES', gameIds: ['delta'] }, { operationCode: APPROVAL_TEST_OPERATION });
  try {
    await fixture.run();
    assert.equal(fixture.response().status, 200);
    assert.equal(fixture.response().body.knowledge, 'KNOWN');
    assert.equal(fixture.response().body.receipt.resultCode, 'APPROVAL_EXECUTED');
    assert.equal(fixture.sql.filter(query => query.includes('idempotency_record')).length, 1);
    assert.equal(fixture.sql.filter(query => /^\s*(INSERT|UPDATE|DELETE)/i.test(query)).length, 0);
  } finally { fixture.restore(); }
});

test('recovery of an unregistered reversal operation fails closed even with an unresolvable original object game', async () => {
  const fixture = await recoveryRouteFixture({ mode: 'ALL_GAMES', gameIds: [] }, { objectGameId: null });
  try {
    await assert.rejects(fixture.run(), (error: any) => error.status === 409 && /OPERATION_UNREGISTERED/.test(error.message));
    assert.equal(fixture.sql.filter(query => query.includes('idempotency_record')).length, 0);
  } finally { fixture.restore(); }
});
