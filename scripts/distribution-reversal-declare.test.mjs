import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { declareReversal, reversalSource, sealedAuthorization, canonical, sha256 } from './distribution-reversal-declare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'distribution-reversal-declare.mjs');
const payload = { schema: 'distribution-reversal-request.v1', earningId: 'earning_1', orderId: 'order_1', amountCents: '2500', full: true, reason: '客服核实的错发佣金' };
const config = { schema: 'distribution-full-reversal-authorization.v1', database: 'zzsh_regression_db', ownerUser: 'zzsh_regression_owner', resourceOid: 123456,
  earningId: 'earning_1', orderId: 'order_1', amountCents: '2500', approvalRequestId: 'approval_1', approvedByAdminId: 'admin_boss', admissionDigest: 'a'.repeat(64), reason: '客服核实的错发佣金' };
const earning = { id: 'earning_1', order_id: 'order_1', payment_confirmation_id: 'pay_1', amount_cents: '2500', basis_digest: 'b'.repeat(64), state: 'SETTLED', beneficiary_role: 'OWNER_REFERRAL', beneficiary_user_id: 'user_owner', posting_id: 'post_1', policy_version: 'policy_1' };
const admission = { mode: 'NATIVE', approval_digest: config.admissionDigest, source_admission_ref: 'admission_ref_1' };
const decider = { status: 'ACTIVE', is_boss: true };
const request = { id: 'approval_1', status: 'EXECUTED', operation_code: 'distribution.earning.reverse', operation_payload: payload, operation_payload_hash: sha256(canonical(payload)), requested_by: 'admin_ops', decided_by: 'admin_boss', live: true };
const receipt = { id: 'execution_1', status: 'SUCCEEDED', result_code: 'DISTRIBUTION_REVERSAL_AUTHORIZED', result_detail: 'earning_1', executed_by: 'admin_ops', completed_at: '2026-10-31T00:00:00Z' };

function fakeDb(overrides = {}) {
  const rows = { earning, admission, decider, request, receipt, ...overrides }, queries = [];
  const client = { async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('FROM zzsh_order.rental_referral_earning e WHERE e.id=$1')) return { rows: rows.earning ? [rows.earning] : [], rowCount: rows.earning ? 1 : 0 };
    if (sql.includes('rental_referral_reversal_source WHERE earning_id=$1 FOR UPDATE')) return { rows: rows.declared ? [rows.declared] : [], rowCount: rows.declared ? 1 : 0 };
    if (sql.includes('FROM zzsh_iam.approval_request WHERE id=$1 FOR UPDATE')) return { rows: rows.request ? [rows.request] : [], rowCount: rows.request ? 1 : 0 };
    if (sql.includes('FROM zzsh_iam.approval_execution')) return { rows: rows.receipt ? [rows.receipt] : [], rowCount: rows.receipt ? 1 : 0 };
    if (sql.includes('zzsh_auth_admin."user" WHERE id=$1')) return { rows: rows.decider ? [rows.decider] : [], rowCount: rows.decider ? 1 : 0 };
    if (sql.includes('distribution_order_admission WHERE order_id=$1')) return { rows: rows.admission ? [rows.admission] : [], rowCount: rows.admission ? 1 : 0 };
    if (sql.includes('rental_referral_transition WHERE earning_id=$1')) return { rows: rows.started ? [{ one: 1 }] : [], rowCount: rows.started ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } };
  const wrote = () => queries.some(q => q.sql.startsWith('INSERT INTO zzsh_order.rental_referral_reversal_source'));
  const audited = () => queries.filter(q => q.sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"'));
  return { client, queries, wrote, audited };
}

test('an approved request without a consumed authorization receipt can never declare', async () => {
  for (const [label, override] of [['no receipt', { receipt: null }], ['failed receipt', { receipt: { ...receipt, status: 'FAILED' } }],
    ['other result code', { receipt: { ...receipt, result_code: 'OTHER' } }], ['another earning', { receipt: { ...receipt, result_detail: 'earning_x' } }],
    ['still APPROVED', { request: { ...request, status: 'APPROVED' } }], ['changed payload hash', { request: { ...request, operation_payload_hash: 'f'.repeat(64) } }],
    ['boss frozen', { decider: { status: 'FROZEN', is_boss: true } }], ['decider no longer boss', { decider: { status: 'ACTIVE', is_boss: false } }]]) {
    const db = fakeDb(override);
    await assert.rejects(declareReversal(db.client, config, { execute: true }), /REVERSAL_/i, label);
    assert.equal(db.wrote(), false, label);
    assert.ok(db.queries.some(q => q.sql === 'ROLLBACK'), label + ' must roll back');
  }
});

test('plan reads and locks the original evidence but writes nothing', async () => {
  const db = fakeDb();
  const outcome = await declareReversal(db.client, config);
  assert.equal(outcome.writing, false);
  assert.equal(db.wrote(), false);
  assert.deepEqual(outcome.source, reversalSource(earning, 'NATIVE', config.earningId));
  assert.equal(outcome.approval.executionReceiptId, 'execution_1');
  assert.ok(db.queries.some(q => q.sql.includes('FOR UPDATE') && q.sql.includes('approval_execution')));
});

test('execute inserts one declaration and its durable approval link', async () => {
  const db = fakeDb();
  const outcome = await declareReversal(db.client, config, { execute: true });
  assert.equal(outcome.writing, true);
  assert.equal(db.queries.filter(q => q.sql.startsWith('INSERT INTO zzsh_order.rental_referral_reversal_source')).length, 1);
  const audit = db.audited();
  assert.equal(audit.length, 1);
  const details = JSON.parse(audit[0].params[4]);
  assert.equal(details.reversalSourceId, outcome.source.sourceId);
  assert.equal(details.approvalRequestId, config.approvalRequestId);
  assert.equal(details.executionReceiptId, 'execution_1');
  assert.equal(details.approvalPayloadHash, request.operation_payload_hash);
  assert.equal(details.amountCents, '2500');
  assert.equal(details.basisDigest, earning.basis_digest);
  assert.equal(details.postingId, earning.posting_id);
  assert.ok(db.queries.some(q => q.sql === 'COMMIT'));
});

test('an already declared original source replays even after the reversal started', async () => {
  const source = reversalSource(earning, 'NATIVE', config.earningId);
  const db = fakeDb({ declared: { id: source.sourceId, canonical_source: source.canonicalSource, source_digest: source.sourceDigest, approval_digest: config.admissionDigest },
    earning: { ...earning, state: 'REVOKED' }, started: true });
  const outcome = await declareReversal(db.client, config, { execute: true });
  assert.equal(outcome.replayed, true);
  assert.equal(db.wrote(), false);
  assert.ok(db.queries.some(q => q.sql === 'ROLLBACK'));
  const forged = fakeDb({ declared: { id: 'reversal_other', canonical_source: source.canonicalSource, source_digest: source.sourceDigest, approval_digest: config.admissionDigest } });
  await assert.rejects(declareReversal(forged.client, config, { execute: true }), /EXISTING_REVERSAL_SOURCE_DIFFERS/);
});

test('the sealed authorization shape is checked before any credential is touched', () => {
  assert.throws(() => sealedAuthorization(Buffer.from(JSON.stringify({ ...config, amountCents: '0' }))), /AUTHORIZATION_SHAPE_INVALID/);
  assert.throws(() => sealedAuthorization(Buffer.from(JSON.stringify({ ...config, approvalRequestId: 7 }))), /AUTHORIZATION_SHAPE_INVALID/);
  assert.deepEqual(sealedAuthorization(Buffer.from(JSON.stringify(config))), config);
});

test('the default plan process reads no credential and opens no connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zzsh-reversal-plan-'));
  try {
    const file = join(dir, 'authorization.json');
    writeFileSync(file, JSON.stringify(config));
    const sealed = sha256(Buffer.from(JSON.stringify(config)));
    const plan = spawnSync(process.execPath, [script, '--config', file, '--sha256', sealed], { encoding: 'utf8', env: { ...process.env, DISTRIBUTION_OWNER_PASSWORD_FILE: '' } });
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.mode, 'PLAN');
    assert.equal(parsed.readsSecrets, false);
    assert.equal(parsed.connections, 0);
    assert.equal(parsed.requiresExecutionReceipt, true);
    assert.equal(parsed.authorizationSha256, sealed);
    const bad = spawnSync(process.execPath, [script, '--config', file, '--sha256', '0'.repeat(64)], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /AUTHORIZATION_SHA_MISMATCH/);
    const exec = spawnSync(process.execPath, [script, '--config', file, '--sha256', sealed, '--execute'], { encoding: 'utf8', env: { ...process.env, DISTRIBUTION_OWNER_PASSWORD_FILE: '' } });
    assert.notEqual(exec.status, 0);
    assert.match(exec.stderr, /DISTRIBUTION_OWNER_PASSWORD_FILE_REQUIRED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
