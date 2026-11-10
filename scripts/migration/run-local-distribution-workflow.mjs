import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { writePrivate } from '../local-auth.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';
import { assertDistributionCoreReadback } from './local-distribution-qualification-plan.mjs';
import { assertBoundRunnerScripts, assertRoundDependencyProof, DISTRIBUTION_ROUND_SCRIPTS, inspectRoundDependencyLayout, probeRoundDependencies, verifyRoundDistributionSource } from './local-round-dependencies.mjs';
import { distributionInputWindow } from './prepare-local-distribution.mjs';
import { runDistributionWorkflow, validateWorkflowPlan, validateWorkflowPolicy, validateWorkflowReadback } from './local-distribution-workflow.mjs';
import { assertNextMigrationWriteReady } from './local-target-registry.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex'), hex = value => /^[a-f0-9]{64}$/.test(value ?? '');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), scripts = join(root, 'scripts/migration');
const restricted = resolve('E:/zzsh-local-state/restricted');
function privatePath(value, output = false) {
  assert(typeof value === 'string' && isAbsolute(value), 'DISTRIBUTION_WORKFLOW_PRIVATE_PATH_REQUIRED');
  const path = resolve(value), rel = relative(restricted, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'DISTRIBUTION_WORKFLOW_PRIVATE_PATH_REQUIRED');
  for (let current = output ? dirname(path) : path; ; current = dirname(current)) {
    assert(!lstatSync(current).isSymbolicLink(), 'DISTRIBUTION_WORKFLOW_LINK_REFUSED');
    if (current.toLowerCase() === restricted.toLowerCase()) break;
    assert(current !== dirname(current), 'DISTRIBUTION_WORKFLOW_PRIVATE_PATH_REQUIRED');
  }
  return path;
}
function boundBytes(ref) {
  assert(ref && typeof ref.path === 'string' && hex(ref.sha256), 'DISTRIBUTION_WORKFLOW_REF_REQUIRED');
  const file = privatePath(ref.path), bytes = readFileSync(file);
  assert.equal(sha(bytes), ref.sha256, 'DISTRIBUTION_WORKFLOW_REF_CHANGED');
  return bytes;
}
function pinned(ref) { return JSON.parse(boundBytes(ref)); }
function reference(file) {
  const path = privatePath(file), bytes = readFileSync(path);
  return { path, sha256: sha(bytes) };
}
function sameTarget(a, b) { return a?.oid === b?.oid && a?.nonce === b?.nonce && isDeepStrictEqual(a?.instance ?? null, b?.instance ?? null); }

export function makeDistributionWorkflowSteps({ round, spec, window, sourceProof, dataset, canonicalize, invoke, path, read }) {
  const inputArgs = ref => ['--input', ref.path, '--input-sha', ref.sha256], planArgs = plan => ['--plan', plan.ref.path, '--plan-sha', plan.ref.sha256];
  const steps = {
    async candidate() {
      await invoke('candidate', 'prepare-round07-distribution-candidate.mjs', ['--prepare', '--source', round.source.path, '--source-sha', round.source.sha256, '--out', path('candidate')]);
      const item = read(path('candidate', 'candidate.json')); assert(item.value.schema === 'zzsh.round07-distribution-candidate.v1'
        && item.value.source?.receiptSha256 === round.source.sha256, 'DISTRIBUTION_WORKFLOW_CANDIDATE_CHANGED'); return { ref: item.ref };
    },
    async input(candidate) {
      await invoke('input', 'prepare-local-distribution.mjs', ['input', '--round-input', spec.roundInput.path, '--round-sha', spec.roundInput.sha256,
        '--round-receipt', spec.roundReceipt.path, '--round-receipt-sha', spec.roundReceipt.sha256, '--core-readback', spec.coreReadback.path,
        '--core-readback-sha', spec.coreReadback.sha256, '--source-mode', spec.sourceMode, '--build', round.apiDist, '--profile', spec.profile.path,
        '--session-one', spec.sessions.first.path, '--session-two', spec.sessions.second.path, '--actor', spec.actor.path, '--candidate', candidate.ref.path,
        '--not-before', window.notBefore, '--expires-at', window.expiresAt, '--out', path('input', 'input.json')]);
      const item = read(path('input', 'input.json')), value = item.value;
      assert(value.schema === 'zzsh.local-round.v1' && isDeepStrictEqual(value.target, round.target) && isDeepStrictEqual(value.source, round.source)
        && isDeepStrictEqual(value.dataset, round.dataset) && isDeepStrictEqual(value.buildFiles, round.buildFiles)
        && value.distribution?.coreEvidence?.roundInputSha256 === spec.roundInput.sha256
        && value.distribution.coreEvidence.roundReceipt?.sha256 === spec.roundReceipt.sha256
        && value.distribution.coreEvidence.readback?.sha256 === spec.coreReadback.sha256
        && value.distribution.candidate?.sha256 === candidate.ref.sha256 && value.actor?.sha256 === spec.actor.sha256,
      'DISTRIBUTION_WORKFLOW_SEALED_INPUT_CHANGED'); return { ref: item.ref };
    },
    async prepare(input) {
      await invoke('prepare', 'run-local-distribution-qualification.mjs', ['--prepare', ...inputArgs(input.ref), '--out', path('prepare')]);
      const plan = read(path('prepare', 'plan.json')), receipt = read(path('prepare', 'receipt.json'));
      return { ...validateWorkflowPlan({ value: plan.value, receipt: receipt.value, ref: plan.ref, inputRef: input.ref, round, sourceProof,
        users: dataset.domains.users.ready, canonicalize }), receipt: receipt.ref };
    },
    async approve(input, plan) {
      await invoke('approve', 'run-local-distribution-qualification.mjs', ['--approve', ...inputArgs(input.ref), ...planArgs(plan), '--out', path('approve')]);
      const item = read(path('approve', 'receipt.json'));
      validateWorkflowPolicy({ value: item.value, inputRef: input.ref, plan, round }); return { ref: item.ref };
    },
    async authorize(input, plan, policy) {
      await invoke('authorize', 'prepare-local-distribution.mjs', ['authority', '--input', input.ref.path, '--input-sha', input.ref.sha256,
        '--plan', plan.ref.path, '--plan-sha', plan.ref.sha256, '--policy-receipt', policy.ref.path, '--policy-sha', policy.ref.sha256,
        '--review-ref', spec.approvalRef, '--attempt', spec.attempt, '--request-id', spec.requestId, '--out', path('authority', 'authority.json')]);
      const item = read(path('authority', 'authority.json')), value = item.value;
      assert(value.status === 'APPROVED' && value.inputSha256 === input.ref.sha256 && value.planSha256 === plan.ref.sha256
        && value.policyReceipt?.sha256 === policy.ref.sha256 && value.policyId === plan.policyId && value.policyDigest === plan.policyDigest
        && sameTarget(value.target, round.target) && value.allowFinancialWrites === false, 'DISTRIBUTION_WORKFLOW_AUTHORITY_CHANGED');
      return { ref: item.ref };
    },
    async execute(input, plan, authority) {
      await invoke('execute', 'run-local-distribution-qualification.mjs', ['--execute', ...inputArgs(input.ref), ...planArgs(plan),
        '--authority', authority.ref.path, '--authority-sha', authority.ref.sha256, '--out', path('execute')]);
      return verifyReadback(read(path('execute', 'receipt.json')), input, plan, true);
    },
    async readback(input, plan) {
      await invoke('readback', 'run-local-distribution-qualification.mjs', ['--readback', ...inputArgs(input.ref), ...planArgs(plan), '--out', path('readback')]);
      return verifyReadback(read(path('readback', 'receipt.json')), input, plan, false);
    },
  };
  function verifyReadback(item, input, plan, executed) {
    return { ref: item.ref, ...validateWorkflowReadback({ value: item.value, inputRef: input.ref, plan, round, refs: spec,
      users: dataset.domains.users.ready, executed }) };
  }
  return steps;
}

async function main() {
  const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (!args.length) {
    console.log(JSON.stringify({ status: 'PLAN_ONLY', modes: ['--validate', '--execute'], required: ['--input', '--input-sha', '--out'],
      stages: ['candidate', 'input', 'prepare', 'approve', 'authorize-if-needed', 'execute-or-readback'], connections: 0, targetWrites: 0 })); return;
  }
  const modes = ['--validate', '--execute'].filter(mode => args.includes(mode));
  assert(modes.length === 1 && process.version === 'v24.20.0', 'DISTRIBUTION_WORKFLOW_MODE_INVALID');
  const inputRef = { path: option('--input'), sha256: option('--input-sha') }, spec = pinned(inputRef);
  assert(spec?.schema === 'zzsh.local-distribution-workflow-input.v1' && spec.approvedBy === 'Root'
    && spec.purpose === 'INITIALIZE_LEGACY_DISTRIBUTION' && ['captured', 'reused'].includes(spec.sourceMode)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(spec.approvalRef ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(spec.requestId ?? '') && /^[1-9][0-9]{0,8}$/.test(spec.attempt ?? ''),
  'DISTRIBUTION_WORKFLOW_INPUT_INVALID');
  const round = pinned(spec.roundInput), roundReceipt = pinned(spec.roundReceipt), coreReadback = pinned(spec.coreReadback);
  if (modes[0] === '--execute') assertNextMigrationWriteReady(round.target);
  assert(round.schema === 'zzsh.local-round.v1' && round.growth?.packageLayout === 'PACKED_V2'
    && spec.actor?.sha256 === round.actor?.sha256 && resolve(spec.actor.path).toLowerCase() === resolve(round.actor.path).toLowerCase(),
  'DISTRIBUTION_WORKFLOW_ROUND_CHANGED');
  assertDistributionCoreReadback(roundReceipt, coreReadback, { roundInputSha256: spec.roundInput.sha256, readbackSha256: spec.coreReadback.sha256,
    datasetSha256: round.dataset.sha256, sourceSha256: round.source.sha256, target: round.target });
  const datasetRef = { path: join(privatePath(round.dataset.path), 'manifest.json'), sha256: round.dataset.sha256 };
  const sourceRef = { path: join(privatePath(round.source.path), 'receipt.json'), sha256: round.source.sha256 };
  const dataset = pinned(datasetRef), source = pinned(sourceRef);
  assert(dataset.sourceReceiptSha256 === round.source.sha256 && Number.isSafeInteger(dataset.domains?.users?.ready)
    && dataset.domains.users.ready >= 0, 'DISTRIBUTION_WORKFLOW_SOURCE_CHANGED');
  for (const ref of [spec.actor, spec.profile, spec.sessions?.first, spec.sessions?.second]) pinned(ref);
  const binding = round.dependencyBinding, dependencyProof = pinned(binding?.proof), layout = inspectRoundDependencyLayout({ apiDist: round.apiDist,
    bundlePath: round.bootstrapEvidence.bundle.path, bundleSha256: round.bootstrapEvidence.bundle.sha256,
    buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256,
    sourceSnapshot: binding.sourceSnapshot, sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 });
  assertRoundDependencyProof(dependencyProof, layout); assertBoundRunnerScripts(scripts, layout.scriptFiles);
  for (const name of DISTRIBUTION_ROUND_SCRIPTS) {
    const file = join(scripts, name), stat = lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && hex(layout.scriptFiles[name]) && sha(readFileSync(file)) === layout.scriptFiles[name], 'DISTRIBUTION_WORKFLOW_TOOL_CHANGED');
  }
  const live = probeRoundDependencies(layout);
  assert(live.closureSha256 === dependencyProof.closureSha256 && live.entrypoints === dependencyProof.entrypoints, 'DISTRIBUTION_WORKFLOW_DEPENDENCIES_CHANGED');
  const sourceProof = await verifyRoundDistributionSource({ input: round, source, layout, proof: dependencyProof, runnerDir: scripts, privatePath });
  assert(isDeepStrictEqual(sourceProof, roundReceipt.distributionSourcePreflight), 'DISTRIBUTION_WORKFLOW_SOURCE_PREFLIGHT_CHANGED');
  const canonicalizerPath = join(round.apiDist, 'supply/content-hash.js');
  assert.equal(sha(readFileSync(canonicalizerPath)), round.buildFiles?.['supply/content-hash.js'], 'DISTRIBUTION_WORKFLOW_BUILD_CHANGED');
  const { canonicalize } = createRequire(join(layout.sourceRoot, 'apps/api/package.json'))(canonicalizerPath);
  assert.equal(typeof canonicalize, 'function', 'DISTRIBUTION_WORKFLOW_CANONICALIZER_REQUIRED');
  const now = Date.now(), begin = Math.max(Date.parse(round.window?.notBefore), now - 3000), end = Math.min(Date.parse(round.window?.expiresAt), now + 25 * 60000);
  assert(Number.isFinite(begin) && Number.isFinite(end), 'DISTRIBUTION_WORKFLOW_WINDOW_INVALID');
  const window = distributionInputWindow(round.window, { notBefore: new Date(begin).toISOString(), expiresAt: new Date(end).toISOString() }, now);
  const out = privatePath(option('--out'), true); assert(!existsSync(out), 'DISTRIBUTION_WORKFLOW_OUTPUT_EXISTS');
  if (modes[0] === '--validate') {
    console.log(JSON.stringify({ status: 'DISTRIBUTION_WORKFLOW_INPUTS_VALIDATED_TARGET_NOT_RUN', participants: dataset.domains.users.ready,
      sourceLevels: sourceProof.sourceLevels, activeLevels: sourceProof.activeLevels, settlementDelayDays: sourceProof.settlementDelayDays,
      window, connections: 0, targetWrites: 0, sensitiveInputsRead: 4 })); return;
  }
  const report = { schema: 'zzsh.local-distribution-workflow-receipt.v1', status: 'STARTED', inputSha256: inputRef.sha256,
    roundInputSha256: spec.roundInput.sha256, roundReceiptSha256: spec.roundReceipt.sha256, coreReadbackSha256: spec.coreReadback.sha256,
    sourceSha256: round.source.sha256, datasetSha256: round.dataset.sha256, target: round.target, window, stages: [], pending: null,
    startedAt: new Date().toISOString(), financialWrites: 0, automaticRetry: false };
  mkdirSync(out, { mode: 0o700 });
  const receiptFile = join(out, 'receipt.json'); writePrivate(receiptFile, report);
  const save = () => writeLoadCheckpoint(receiptFile, report); save();
  const bound = [inputRef, spec.roundInput, spec.roundReceipt, spec.coreReadback, spec.actor, spec.profile, spec.sessions.first, spec.sessions.second, datasetRef, sourceRef, binding.proof];
  const sourceFiles = ['distributionConfig', 'distributionLevels'].map(name => {
    const entry = source.files?.[name]; assert(entry?.file === basename(entry.file) && hex(entry.sha256), 'DISTRIBUTION_WORKFLOW_SOURCE_CHANGED');
    return { path: join(round.source.path, entry.file), sha256: entry.sha256 };
  });
  function recheck() {
    for (const ref of bound) pinned(ref);
    for (const ref of sourceFiles) boundBytes(ref);
    assertRoundDependencyProof(dependencyProof, inspectRoundDependencyLayout({ apiDist: round.apiDist,
      bundlePath: round.bootstrapEvidence.bundle.path, bundleSha256: round.bootstrapEvidence.bundle.sha256,
      buildManifestPath: binding.buildManifest.path, buildManifestSha256: binding.buildManifest.sha256,
      sourceSnapshot: binding.sourceSnapshot, sourceManifestPath: binding.sourceManifest.path, sourceManifestSha256: binding.sourceManifest.sha256 }));
    for (const name of DISTRIBUTION_ROUND_SCRIPTS) assert.equal(sha(readFileSync(join(scripts, name))), layout.scriptFiles[name], 'DISTRIBUTION_WORKFLOW_TOOL_CHANGED');
    assert(Date.now() < Date.parse(window.expiresAt), 'DISTRIBUTION_WORKFLOW_WINDOW_EXPIRED');
  }
  async function invoke(stage, script, flags) {
    recheck(); let stdout, stderr;
    try {
      stdout = openSync(join(out, stage + '.stdout.log'), 'wx', 0o600); stderr = openSync(join(out, stage + '.stderr.log'), 'wx', 0o600);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE)$/i.test(key)));
      env.NODE_PATH = layout.moduleDirs.join(process.platform === 'win32' ? ';' : ':');
      const child = spawn(process.execPath, [join(scripts, script), ...flags], { cwd: root, windowsHide: true,
        stdio: ['ignore', stdout, stderr], env });
      const result = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', (code, signal) => ok({ code, signal })); });
      assert(result.code === 0 && result.signal === null, 'DISTRIBUTION_WORKFLOW_STAGE_FAILED:' + stage);
    } finally { if (stdout !== undefined) closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
    recheck();
  }
  const path = (...parts) => join(out, ...parts), read = file => { const ref = reference(file); return { ref, value: pinned(ref) }; };
  const steps = makeDistributionWorkflowSteps({ round, spec, window, sourceProof, dataset, canonicalize, invoke, path, read });
  const started = performance.now();
  try {
    const result = await runDistributionWorkflow({ steps, record: async event => {
      if (event.status === 'INTENT') { recheck(); report.pending = { name: event.name, startedAt: new Date().toISOString() }; }
      else { report.stages.push({ ...report.pending, status: 'ACK', finishedAt: new Date().toISOString(), result: event.result }); report.pending = null; }
      save();
    } });
    recheck(); Object.assign(report, result);
    if (result.status !== 'DISTRIBUTION_WORKFLOW_READBACK_PASS') process.exitCode = 1;
  } catch (error) {
    report.status = 'STOPPED_PRESERVE_ORIGINAL_STAGE'; report.error = { code: /^[A-Z][A-Z0-9_:.-]{1,120}$/.test(error.message ?? '') ? error.message : error.code ?? error.name };
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Math.round(performance.now() - started); save();
    console.log(JSON.stringify({ status: report.status, accepted: report.accepted, unresolved: report.unresolved, pending: report.pending, elapsedMs: report.elapsedMs }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ status: 'DISTRIBUTION_WORKFLOW_STOPPED', code: /^[A-Z][A-Z0-9_:.-]{1,120}$/.test(error.message ?? '') ? error.message : error.code ?? error.name })); process.exitCode = 1;
});
