import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runDistributionWorkflow, validateWorkflowPlan, validateWorkflowPolicy, validateWorkflowReadback } from './local-distribution-workflow.mjs';
import { makeDistributionWorkflowSteps } from './run-local-distribution-workflow.mjs';

test('workflow CLI defaults to a no-connection plan and rejects incomplete execution', () => {
  const file = fileURLToPath(new URL('./run-local-distribution-workflow.mjs', import.meta.url));
  const plan = spawnSync(process.execPath, [file], { encoding: 'utf8' }); assert.equal(plan.status, 0);
  assert.equal(JSON.parse(plan.stdout).status, 'PLAN_ONLY'); assert.equal(JSON.parse(plan.stdout).connections, 0);
  const invalid = spawnSync(process.execPath, [file, '--execute'], { encoding: 'utf8' }); assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /DISTRIBUTION_WORKFLOW_REF_REQUIRED/);
});

function fixture({ accepted = 2, unresolved = 0, failure } = {}) {
  const calls = [], records = [], steps = {};
  for (const name of ['candidate', 'input', 'prepare', 'approve', 'authorize', 'execute', 'readback']) {
    steps[name] = async (...args) => {
      calls.push({ name, args }); if (name === failure) throw Error('synthetic failure');
      return name === 'prepare' ? { ref: 'plan', accepted, unresolved } : { ref: name };
    };
  }
  return { calls, records, steps, record: async event => records.push(event) };
}

test('distribution workflow initializes policy, qualifies and reads back in fixed order', async () => {
  const f = fixture(), result = await runDistributionWorkflow(f);
  assert.deepEqual(f.calls.map(row => row.name), ['candidate', 'input', 'prepare', 'approve', 'authorize', 'execute']);
  assert.deepEqual(f.records.map(row => row.status), ['INTENT', 'ACK', 'INTENT', 'ACK', 'INTENT', 'ACK', 'INTENT', 'ACK', 'INTENT', 'ACK', 'INTENT', 'ACK']);
  assert.deepEqual(result, { status: 'DISTRIBUTION_WORKFLOW_READBACK_PASS', accepted: 2, unresolved: 0, readback: { ref: 'execute' } });
  assert.equal(f.calls.at(-1).args[2].ref, 'authorize');
});

test('empty qualification set uses readback without authorizing or executing writes', async () => {
  const f = fixture({ accepted: 0, unresolved: 1 }), result = await runDistributionWorkflow(f);
  assert.deepEqual(f.calls.map(row => row.name), ['candidate', 'input', 'prepare', 'approve', 'readback']);
  assert.equal(result.status, 'DISTRIBUTION_WORKFLOW_REVIEW_REQUIRED');
});

test('each failed stage and failed intent or ACK persistence stops before any later stage', async () => {
  const order = ['candidate', 'input', 'prepare', 'approve', 'authorize', 'execute'];
  for (const [index, failure] of order.entries()) {
    const f = fixture({ failure }); await assert.rejects(runDistributionWorkflow(f), /synthetic failure/);
    assert.deepEqual(f.calls.map(row => row.name), order.slice(0, index + 1));
    assert.equal(f.records.at(-1).status, 'INTENT'); assert.equal(f.records.at(-1).name, failure === 'execute' ? 'execute-and-readback' : failure);
  }
  for (const status of ['INTENT', 'ACK']) {
    const f = fixture(); f.record = async event => { f.records.push(event); if (event.name === 'approve' && event.status === status) throw Error('receipt unavailable'); };
    await assert.rejects(runDistributionWorkflow(f), /receipt unavailable/);
    assert(!f.calls.some(row => row.name === 'authorize' || row.name === 'execute'));
    assert.equal(f.calls.some(row => row.name === 'approve'), status === 'ACK');
  }
});

test('workflow validates source, cluster, policy, commit and complete independent readback', () => {
  const h = char => char.repeat(64), target = { oid: '42', nonce: 'a'.repeat(24), instance: { host: '127.0.0.1', port: 55433, systemIdentifier: '123' } };
  const round = { target, dataset: { sha256: h('b') }, source: { sha256: h('c') } }, inputRef = { sha256: h('d') }, ref = { sha256: h('e') };
  const sourceProof = { policyDigest: h('f') }, value = { scope: 'NATIVE', inputSha256: inputRef.sha256, datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256,
    target, policyId: 'synthetic-policy', policyDigest: sourceProof.policyDigest, readOnlyRollbackAck: true, clientClosed: true,
    accepted: [{ userId: 'u1' }, { userId: 'u2' }], existing: [], ineligible: [{ userId: 'u3' }], unresolved: [], exceptions: [], batches: [] };
  const body = { scope: value.scope, policyId: value.policyId, policyDigest: value.policyDigest, subjects: value.accepted };
  value.batches = [{ body, bodyDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }];
  const receipt = { status: 'PREPARED_POLICY_MAY_REQUIRE_APPROVAL', policyActive: false, planSha256: ref.sha256 };
  const args = { value, receipt, ref, inputRef, round, sourceProof, users: 3, canonicalize: JSON.stringify }, plan = validateWorkflowPlan(args);
  assert.deepEqual([plan.accepted, plan.ineligible, plan.unresolved, plan.batches], [2, 1, 0, 1]);
  for (const changed of [{ ...value, target: { ...target, instance: { ...target.instance, systemIdentifier: '999' } } },
    { ...value, target: { ...target, migrationProfile:'LOCAL_MIGRATION_NEXT_V1' } },
    { ...value, policyDigest: h('0') }, { ...value, exceptions: [{}] }, { ...value, accepted: [{}] }, { ...value, batches: [] }])
    assert.throws(() => validateWorkflowPlan({ ...args, value: changed }), /DISTRIBUTION_/);
  const policy = { status: 'NATIVE_POLICY_APPROVED_READBACK_PASSED', mode: '--approve', inputSha256: inputRef.sha256, planSha256: ref.sha256,
    policyActive: true, policyId: plan.policyId, datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256, target,
    financialWrites: 0, lockReleased: true, lockClientClosed: true, clientsClosed: true,
    steps: ['decision', 'execute', 'approval-readback'].map(step => ({ step, status: 200 })) };
  assert.doesNotThrow(() => validateWorkflowPolicy({ value: policy, inputRef, plan, round }));
  for (const changed of [{ ...policy, policyActive: false }, { ...policy, lockReleased: false }, { ...policy, steps: policy.steps.slice(0, 2) }])
    assert.throws(() => validateWorkflowPolicy({ value: changed, inputRef, plan, round }), /DISTRIBUTION_WORKFLOW_POLICY_UNCONFIRMED/);
  const refs = { roundInput: { sha256: h('1') }, roundReceipt: { sha256: h('2') }, coreReadback: { sha256: h('3') } };
  const readback = { status: 'EXACT_QUALIFICATION_READBACK_PASSED', mode: '--execute', inputSha256: inputRef.sha256, planSha256: ref.sha256,
    roundInputSha256: refs.roundInput.sha256, roundReceiptSha256: refs.roundReceipt.sha256, coreReadbackSha256: refs.coreReadback.sha256,
    datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256, target, policyActive: true, policyId: plan.policyId, policyDigest: plan.policyDigest,
    financialWrites: 0, readOnlyRollbackAck: true, readOnlyClientClosed: true, transaction: { status: 'COMMIT_ACKNOWLEDGED' }, lockReleased: true, clientsClosed: true,
    counts: { participants: 3, readbackEligible: 2, readbackIneligible: 1, readbackUnresolved: 0, readbackExceptions: 0, verifiedReceiptBatches: 1, verifiedReceiptParticipants: 2 } };
  const readArgs = { value: readback, inputRef, plan, round, refs, users: 3, executed: true };
  assert.equal(validateWorkflowReadback(readArgs).eligible, 2);
  for (const changed of [{ ...readback, transaction: { status: 'COMMIT_UNKNOWN' } }, { ...readback, sourceDigest: h('0') },
    { ...readback, counts: { ...readback.counts, verifiedReceiptParticipants: 1 } }, { ...readback, readOnlyRollbackAck: false }])
    assert.throws(() => validateWorkflowReadback({ ...readArgs, value: changed }), /DISTRIBUTION_WORKFLOW_READBACK_UNCONFIRMED/);
});

function adapterFixture({ accepted = 2, unresolved = 0, alter = () => {} } = {}) {
  const h = char => char.repeat(64), path = (...parts) => join('synthetic-output', ...parts), files = new Map(), calls = [], records = [];
  const target = { oid: '42', nonce: 'a'.repeat(24), instance: { host: '127.0.0.1', port: 55433, systemIdentifier: '123' } };
  const round = { target, source: { path: 'synthetic-source', sha256: h('a') }, dataset: { path: 'synthetic-dataset', sha256: h('b') },
    apiDist: 'synthetic-api', buildFiles: { 'api.js': h('c') } };
  const spec = { roundInput: { path: 'round.json', sha256: h('d') }, roundReceipt: { path: 'round-receipt.json', sha256: h('e') },
    coreReadback: { path: 'core-readback.json', sha256: h('f') }, actor: { path: 'actor.json', sha256: h('1') }, profile: { path: 'profile.json' },
    sessions: { first: { path: 'first.json' }, second: { path: 'second.json' } }, sourceMode: 'captured', approvalRef: 'synthetic-ref', attempt: '1', requestId: 'synthetic-request' };
  const window = { notBefore: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-10T00:25:00.000Z' }, sourceProof = { policyDigest: h('2') };
  const dataset = { domains: { users: { ready: 3 } } };
  const put = (file, value) => { files.set(file, structuredClone(value)); };
  const read = file => { assert(files.has(file), 'SYNTHETIC_ARTIFACT_MISSING:' + file); const value = structuredClone(files.get(file));
    return { value, ref: { path: file, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') } }; };
  const invoke = async (stage, script, flags) => {
    calls.push({ stage, script, flags }); const out = flags[flags.indexOf('--out') + 1];
    const inputRef = () => read(path('input', 'input.json')).ref, planRef = () => read(path('prepare', 'plan.json')).ref;
    let value;
    if (stage === 'candidate') value = { schema: 'zzsh.round07-distribution-candidate.v1', source: { receiptSha256: round.source.sha256 } };
    else if (stage === 'input') value = { schema: 'zzsh.local-round.v1', target, source: round.source, dataset: round.dataset, buildFiles: round.buildFiles,
      actor: spec.actor, distribution: { candidate: read(path('candidate', 'candidate.json')).ref, coreEvidence: { roundInputSha256: spec.roundInput.sha256,
        roundReceipt: spec.roundReceipt, readback: spec.coreReadback } } };
    else if (stage === 'prepare') {
      const subjects = Array.from({ length: accepted }, (_, i) => ({ userId: 'synthetic-' + i }));
      const body = { scope: 'NATIVE', policyId: 'synthetic-policy', policyDigest: sourceProof.policyDigest, subjects };
      value = { ...body, inputSha256: inputRef().sha256, datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256, target,
        readOnlyRollbackAck: true, clientClosed: true, accepted: subjects, existing: [], ineligible: Array.from({ length: 3 - accepted - unresolved }, () => ({})),
        unresolved: Array.from({ length: unresolved }, () => ({})), exceptions: [], batches: accepted ? [{ body, bodyDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }] : [] };
    } else if (stage === 'approve') value = { status: 'NATIVE_POLICY_APPROVED_READBACK_PASSED', mode: '--approve', inputSha256: inputRef().sha256,
      planSha256: planRef().sha256, policyActive: true, policyId: 'synthetic-policy', datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256,
      target, financialWrites: 0, lockReleased: true, lockClientClosed: true, clientsClosed: true,
      steps: ['decision', 'execute', 'approval-readback'].map(step => ({ step, status: 200 })) };
    else if (stage === 'authorize') value = { status: 'APPROVED', inputSha256: inputRef().sha256, planSha256: planRef().sha256,
      policyReceipt: read(path('approve', 'receipt.json')).ref, policyId: 'synthetic-policy', policyDigest: sourceProof.policyDigest, target, allowFinancialWrites: false };
    else value = { status: 'EXACT_QUALIFICATION_READBACK_PASSED', mode: stage === 'execute' ? '--execute' : '--readback', inputSha256: inputRef().sha256,
      planSha256: planRef().sha256, roundInputSha256: spec.roundInput.sha256, roundReceiptSha256: spec.roundReceipt.sha256, coreReadbackSha256: spec.coreReadback.sha256,
      datasetSha256: round.dataset.sha256, sourceDigest: round.source.sha256, target, policyActive: true, policyId: 'synthetic-policy', policyDigest: sourceProof.policyDigest,
      financialWrites: 0, readOnlyRollbackAck: true, readOnlyClientClosed: true, transaction: { status: 'COMMIT_ACKNOWLEDGED' }, lockReleased: true, clientsClosed: true,
      counts: { participants: 3, readbackEligible: accepted, readbackIneligible: 3 - accepted - unresolved, readbackUnresolved: unresolved, readbackExceptions: 0,
        verifiedReceiptBatches: accepted ? 1 : 0, verifiedReceiptParticipants: accepted } };
    value = structuredClone(value);
    alter(stage, value);
    if (stage === 'candidate') put(join(out, 'candidate.json'), value);
    else if (stage === 'input' || stage === 'authorize') put(out, value);
    else if (stage === 'prepare') { put(join(out, 'plan.json'), value); put(join(out, 'receipt.json'),
      { status: 'PREPARED_POLICY_MAY_REQUIRE_APPROVAL', policyActive: false, planSha256: read(join(out, 'plan.json')).ref.sha256 }); }
    else put(join(out, 'receipt.json'), value);
  };
  const steps = makeDistributionWorkflowSteps({ round, spec, window, sourceProof, dataset, canonicalize: JSON.stringify, invoke, path, read });
  return { steps, record: async event => records.push(event), calls, records, read, path, round, spec };
}

test('actual distribution adapter binds child commands to each preceding artifact', async () => {
  const f = adapterFixture(), result = await runDistributionWorkflow(f);
  assert.equal(result.status, 'DISTRIBUTION_WORKFLOW_READBACK_PASS');
  assert.deepEqual(f.calls.map(call => call.stage), ['candidate', 'input', 'prepare', 'approve', 'authorize', 'execute']);
  for (const call of f.calls) {
    const flag = name => call.flags[call.flags.indexOf(name) + 1];
    if (call.stage === 'input') assert.equal(flag('--candidate'), f.read(f.path('candidate', 'candidate.json')).ref.path);
    if (['prepare', 'approve', 'authorize', 'execute'].includes(call.stage)) assert.equal(flag('--input-sha'), f.read(f.path('input', 'input.json')).ref.sha256);
    if (['approve', 'authorize', 'execute'].includes(call.stage)) assert.equal(flag('--plan-sha'), f.read(f.path('prepare', 'plan.json')).ref.sha256);
    if (call.stage === 'execute') assert.equal(flag('--authority-sha'), f.read(f.path('authority', 'authority.json')).ref.sha256);
  }
});

test('actual distribution adapter stops on altered target, absent policy approval or unknown commit', async () => {
  for (const [badStage, mutate, forbidden] of [
    ['prepare', value => { value.target.instance.systemIdentifier = '999'; }, 'approve'],
    ['approve', value => { value.policyActive = false; }, 'authorize'],
    ['authorize', value => { value.allowFinancialWrites = true; }, 'execute'],
    ['execute', value => { value.transaction.status = 'COMMIT_UNKNOWN'; }, null],
  ]) {
    const f = adapterFixture({ alter: (stage, value) => { if (stage === badStage) mutate(value); } });
    await assert.rejects(runDistributionWorkflow(f), /DISTRIBUTION_WORKFLOW_/);
    assert.equal(f.records.at(-1).status, 'INTENT');
    if (forbidden) assert(!f.calls.some(call => call.stage === forbidden));
  }
});

test('actual distribution adapter reads back empty accepted set and keeps unresolved review visible', async () => {
  const f = adapterFixture({ accepted: 0, unresolved: 1 }), result = await runDistributionWorkflow(f);
  assert.equal(result.status, 'DISTRIBUTION_WORKFLOW_REVIEW_REQUIRED');
  assert.deepEqual(f.calls.map(call => call.stage), ['candidate', 'input', 'prepare', 'approve', 'readback']);
  assert.equal(result.readback.unresolved, 1);
});
