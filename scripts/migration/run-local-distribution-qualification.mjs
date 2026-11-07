import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate } from "../local-auth.mjs";
import { readSourceRows } from "./local-source-adapter.mjs";
import { assertDistributionCoreReadback, assertDistributionPolicyReceipt, assertDistributionSourceBindings, assertDistributionRepairBuild, assertDistributionOptimizedBuild, assertDistributionRepairGuard, assertQualificationRecoveryEvidence, assertQualificationRenewalEvidence, assertQualificationConstraintRetryEvidence, assertHistoricalFinancePopulation, assertHistoricalFinanceUnchanged, assertNewDistributionTarget, assertQualificationAuthority, assertQualificationPlanBinding, assertQualificationPolicy, assertQualificationReadback, assertRegisteredDistributionTarget, buildLegacyQualificationPlan, isolatedDistributionBuild, legacyDistributionPolicy, privateDistributionPath, reviewedDistributionActor } from "./local-distribution-qualification-plan.mjs";
import { executeQualification, assertQualificationRecoveryPreimage } from "./local-distribution-qualification-runner.mjs";
import { verifyQualificationReceipts } from "./local-distribution-qualification-readback.mjs";
import { approveLocalNativePolicy } from "./local-distribution-policy-runtime.mjs";
import { assertLiveTarget, loadRegisteredTarget, targetIdentityQuery } from "./local-target-registry.mjs";
import { assertRoundDependencyProof, inspectRoundDependencyLayout } from "./local-round-dependencies.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const processStarted = performance.now(), processStartedAt = new Date().toISOString();
const modes = ["--prepare", "--approve", "--execute", "--readback"].filter(mode => args.includes(mode));
if (!modes.length) {
  console.log(JSON.stringify({ status: "PLAN_ONLY", modes: ["--prepare", "--approve", "--execute", "--readback"], required: ["--input", "--input-sha", "--out"], nonPrepare: ["--plan", "--plan-sha"], execute: ["--authority", "--authority-sha"], connections: 0, credentialReads: 0, financialWrites: 0 }));
  process.exit(0);
}
assert.equal(modes.length, 1, "ONE_DISTRIBUTION_MODE_REQUIRED");
assert.equal(process.version, "v24.20.0", "NODE_BASELINE_MISMATCH");
const mode = modes[0], sha = value => createHash("sha256").update(value).digest("hex"), hex = /^[a-f0-9]{64}$/;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url))), restricted = resolve("E:/zzsh-local-state/restricted");
function privatePath(value, output = false) {
  const path = privateDistributionPath(restricted,value);
  for (let p = output ? dirname(path) : path; p !== dirname(p); p = dirname(p)) assert(!lstatSync(p).isSymbolicLink(), "DISTRIBUTION_REPARSE_POINT_REFUSED");
  return path;
}
function protectedInput(value) {
  assert(typeof value === "string" && isAbsolute(value), "DISTRIBUTION_PROTECTED_PATH_REQUIRED");
  const path = resolve(value), secretRoot = resolve("E:/zzsh/zzsh/apps/api/.secrets");
  assert([restricted, secretRoot].some(base => { const rel = relative(base, path); return rel && !rel.startsWith("..") && !isAbsolute(rel); }), "DISTRIBUTION_PROTECTED_PATH_REQUIRED");
  for (let p = path; p !== dirname(p); p = dirname(p)) assert(!lstatSync(p).isSymbolicLink(), "DISTRIBUTION_REPARSE_POINT_REFUSED");
  return path;
}
function pinned(file, expected) {
  assert(hex.test(expected ?? ""), "DISTRIBUTION_SHA_REQUIRED");
  const bytes = readFileSync(file); assert.equal(sha(bytes), expected, "DISTRIBUTION_INPUT_SHA_MISMATCH:" + basename(file));
  return JSON.parse(bytes);
}
const out = privatePath(option("--out"), true); assert(!existsSync(out), "PRESERVE_DISTRIBUTION_OUTPUT");
const output = (name, value) => writePrivate(join(out, name), value), inputSha256 = option("--input-sha");
const summary = { schema: "zzsh.local-distribution-qualification-receipt.v1", status: "STARTED", mode, inputSha256, startedAt: processStartedAt, timings: {}, financialWrites: 0, automaticRetry: false };
output("receipt.json", summary);
try {
const input = pinned(privatePath(option("--input")), inputSha256);
assert.equal(input.schema, "zzsh.local-round.v1");
const d = input.distribution;
assert(d && d.scope === "NATIVE" && typeof d.candidate?.path === "string" && hex.test(d.candidate?.sha256 ?? "") && hex.test(d.lockfileSha256 ?? ""), "BOUND_DISTRIBUTION_INPUT_REQUIRED");
assert([d.qualificationRecovery,d.qualificationRenewal,d.qualificationConstraintRetry].filter(Boolean).length<=1,'DISTRIBUTION_RECOVERY_MODE_CONFLICT');
const optimized=d.qualificationRenewal||d.qualificationConstraintRetry;
const target = input.target;
Object.assign(summary,{datasetSha256:input.dataset?.sha256,sourceDigest:input.source?.sha256,target:{oid:target?.oid,nonce:target?.nonce}});
assertNewDistributionTarget(target);
const sourceDir = privatePath(input.source.path), datasetDir = privatePath(input.dataset.path);
const capture = pinned(join(sourceDir, "receipt.json"), input.source.sha256), dataset = pinned(join(datasetDir, "manifest.json"), input.dataset.sha256);
const candidate = pinned(privatePath(d.candidate.path), d.candidate.sha256);
assertDistributionSourceBindings(input.source.sha256,capture,dataset,candidate);
const core = d.coreEvidence;
const roundReceipt = pinned(privatePath(core?.roundReceipt?.path), core?.roundReceipt?.sha256), coreReadback = pinned(privatePath(core?.readback?.path), core?.readback?.sha256);
const financialObservations = assertDistributionCoreReadback(roundReceipt, coreReadback, { roundInputSha256: core.roundInputSha256, readbackSha256: core.readback.sha256,
  datasetSha256: input.dataset.sha256, sourceSha256: input.source.sha256, target });
summary.coreReadbackSha256 = core.readback.sha256; summary.financialObservations = financialObservations;

const api = isolatedDistributionBuild(root, input.apiDist);
assert(!lstatSync(root).isSymbolicLink(), "DISTRIBUTION_BUILD_REPARSE_REFUSED");
for (let p = api; p.toLowerCase() !== root.toLowerCase(); p = dirname(p)) {
  assert(p !== dirname(p) && !lstatSync(p).isSymbolicLink(), "DISTRIBUTION_BUILD_REPARSE_REFUSED");
}
function jsFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), "DISTRIBUTION_BUILD_REPARSE_REFUSED");
    const name = prefix + entry.name;
    return entry.isDirectory() ? jsFiles(join(dir, entry.name), name + "/") : entry.isFile() && name.endsWith(".js") ? [name] : [];
  });
}
assert(input.buildFiles && Object.keys(input.buildFiles).length > 0);
let recoveryDependency;
function verifyBuild() {
  assert.equal(sha(readFileSync(join(root, "package-lock.json"))), d.lockfileSha256, "DISTRIBUTION_LOCKFILE_CHANGED");
  assert.deepEqual(jsFiles(api).sort(), Object.keys(input.buildFiles).sort(), "DISTRIBUTION_BUILD_FILE_SET_CHANGED");
  for (const [name, hash] of Object.entries(input.buildFiles)) {
    assert(!name.includes("\\") && !name.split("/").includes("..") && !name.startsWith("/") && name.endsWith(".js"));
    assert.equal(sha(readFileSync(join(api, name))), hash, "DISTRIBUTION_BUILD_CHANGED:" + name);
  }
  for (const [name, hash] of Object.entries(toolFiles)) assert.equal(sha(readFileSync(join(root, "scripts/migration", name))), hash, "DISTRIBUTION_TOOL_CHANGED:" + name);
  if(recoveryDependency){
    const {round,proof,proofRef}=recoveryDependency,binding=round.dependencyBinding;
    assert.equal(sha(readFileSync(proofRef.path)),proofRef.sha256,'DISTRIBUTION_RECOVERY_DEPENDENCY_PROOF_CHANGED');
    const layout=inspectRoundDependencyLayout({apiDist:round.apiDist,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,
      buildManifestPath:binding.buildManifest.path,buildManifestSha256:binding.buildManifest.sha256,sourceSnapshot:binding.sourceSnapshot,
      sourceManifestPath:binding.sourceManifest.path,sourceManifestSha256:binding.sourceManifest.sha256});
    assertRoundDependencyProof(proof,layout);(optimized?assertDistributionOptimizedBuild:assertDistributionRepairBuild)(round.buildFiles,input.buildFiles);
    if(recoveryDependency.guardRef)assert.equal(sha(readFileSync(recoveryDependency.guardRef.path)),recoveryDependency.guardRef.sha256,'DISTRIBUTION_REPAIR_GUARD_CHANGED');
  }
}
const toolFiles = Object.fromEntries(["run-local-distribution-qualification.mjs", "local-distribution-qualification-plan.mjs", "local-distribution-qualification-runner.mjs", "local-distribution-qualification-readback.mjs", "local-distribution-policy-approval.mjs", "local-distribution-policy-runtime.mjs", "local-source-adapter.mjs", "local-target-registry.mjs", "local-round-dependencies.mjs", "../local-auth.mjs"].map(name => [name, sha(readFileSync(join(root, "scripts/migration", name)))]));
verifyBuild();
let moduleDirs=[join(root,"apps/api/node_modules"),join(root,"node_modules")];
if(d.recovery){
  const round=pinned(privatePath(d.recovery.round?.path),d.recovery.round?.sha256);
  assert(d.recovery.round.sha256===core.roundInputSha256&&round.target?.oid===target.oid&&round.target?.nonce===target.nonce
    &&JSON.stringify(round.target?.instance??null)===JSON.stringify(target.instance??null)&&round.dataset?.sha256===input.dataset.sha256,'DISTRIBUTION_RECOVERY_ROUND_CHANGED');
  const binding=round.dependencyBinding,proofRef={path:privatePath(binding?.proof?.path),sha256:binding?.proof?.sha256},proof=pinned(proofRef.path,proofRef.sha256);
  const layout=inspectRoundDependencyLayout({apiDist:round.apiDist,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,
    buildManifestPath:binding.buildManifest.path,buildManifestSha256:binding.buildManifest.sha256,sourceSnapshot:binding.sourceSnapshot,
    sourceManifestPath:binding.sourceManifest.path,sourceManifestSha256:binding.sourceManifest.sha256});
  assertRoundDependencyProof(proof,layout);(optimized?assertDistributionOptimizedBuild:assertDistributionRepairBuild)(round.buildFiles,input.buildFiles);moduleDirs=layout.moduleDirs;
  recoveryDependency={round,proof,proofRef,layout};summary.recoveryDependency={proofSha256:proofRef.sha256,closureSha256:proof.closureSha256,changedFiles:optimized?['finance/distribution-policy-store.js','finance/legacy-invitation-facts-maintenance.js']:['finance/distribution-policy-store.js']};
}
process.env.NODE_PATH = moduleDirs.join(delimiter);
Module._initPaths();
const require = createRequire(join(d.recovery?api:join(root,"apps/api"), d.recovery?"app.js":"package.json"));
if(recoveryDependency){
  const resolved=realpathSync(require.resolve('pg')),relativePg=relative(recoveryDependency.layout.sourceRoot,resolved).replaceAll('\\','/'),entry=recoveryDependency.proof.closureFiles.find(row=>row[0]===relativePg);
  assert(entry&&sha(readFileSync(resolved))===entry[1],'DISTRIBUTION_RECOVERY_PG_DEPENDENCY_CHANGED');verifyBuild();
}
const moduleFromBuild = name => { assert(Object.hasOwn(input.buildFiles, name + ".js"), "DISTRIBUTION_BUILD_MODULE_UNPINNED:" + name); return require(join(api, name + ".js")); };
assert(Object.hasOwn(input.buildFiles, "auth/approval-audit.js"), "DISTRIBUTION_TEMPLATE_CAS_BUILD_REQUIRED");
const approvalBuild=readFileSync(join(api,"auth/approval-audit.js"),"utf8");
assert(approvalBuild.includes("expected-version:")&&approvalBuild.includes("approval-template-v1"),"DISTRIBUTION_TEMPLATE_CAS_BUILD_REQUIRED");
const { canonicalize } = moduleFromBuild("supply/content-hash"), { projectLegacyInvitationQualification } = moduleFromBuild("finance/legacy-invitation-facts");
const { parseDistributionPolicyChange } = moduleFromBuild("finance/distribution-policy-change");
const { readDistributionPolicyRowInTransaction } = moduleFromBuild("finance/distribution-policy-store");
const buildDigest = sha(canonicalize(input.buildFiles));
async function capturedRows(name) {
  const file = capture.files[name]; assert(file && file.file === basename(file.file) && hex.test(file.sha256 ?? ""));
  const path = privatePath(join(sourceDir, file.file)), bytes = readFileSync(path); assert.equal(sha(bytes), file.sha256, "DISTRIBUTION_CAPTURE_FILE_CHANGED:" + name);
  const rows = []; for await (const row of readSourceRows(path)) rows.push(row);
  assert.equal(rows.length, file.rows); return rows;
}
const configuration = await capturedRows("distributionConfig"), rawLevels = await capturedRows("distributionLevels");
assert.equal(canonicalize(configuration), canonicalize(candidate.configuration), "DISTRIBUTION_CONFIGURATION_SOURCE_CHANGED");
assert.equal(canonicalize(rawLevels), canonicalize(candidate.rawLevels), "DISTRIBUTION_LEVEL_SOURCE_CHANGED");
const payload = legacyDistributionPolicy({ scope: d.scope, receiptSha256: input.source.sha256, configurationSha256: capture.files.distributionConfig.sha256, levelsSha256: capture.files.distributionLevels.sha256, configuration, rawLevels });
assert.equal(canonicalize(payload), canonicalize(candidate.approvalPayloads?.find(p => p.config?.scope === d.scope)), "DISTRIBUTION_CANDIDATE_POLICY_CHANGED");
assert.equal(canonicalize(parseDistributionPolicyChange(payload)), canonicalize(payload), "DISTRIBUTION_POLICY_INVALID");
const credentialFile = protectedInput(input.credentials);
const registry = JSON.parse(readFileSync(join(dirname(credentialFile), "resource.json")));
const registered = loadRegisteredTarget(credentialFile);
registry.instance = registered.instance;
assertRegisteredDistributionTarget(target,input.dataset.sha256,registry);
if(d.recovery){
 const previousPlan=pinned(privatePath(d.recovery.plan?.path),d.recovery.plan?.sha256),guardRef={path:privatePath(d.recovery.repairGuard?.path),sha256:d.recovery.repairGuard?.sha256},guard=pinned(guardRef.path,guardRef.sha256);
 assert(previousPlan.target?.oid===target.oid&&previousPlan.target?.nonce===target.nonce&&JSON.stringify(previousPlan.target.instance??null)===JSON.stringify(target.instance??null)
  &&Number.isSafeInteger(previousPlan.target.ownerOid)&&previousPlan.target.ownerOid>0,'DISTRIBUTION_REPAIR_OWNER_PROOF_REQUIRED');
 assertDistributionRepairGuard(guard,{target,registry:{...registered,ownerOid:previousPlan.target.ownerOid},moduleSha256:input.buildFiles['finance/distribution-policy-store.js']});
 recoveryDependency.guardRef=guardRef;verifyBuild();
}
assert.equal(registered.lockKey, "806006", "DISTRIBUTION_LOCK_BINDING_CHANGED");
assert.equal(registered.maintenanceDatabase, "postgres", "DISTRIBUTION_MAINTENANCE_DATABASE_CHANGED");
summary.target.instance = registered.instance;
const credentials = JSON.parse(readFileSync(credentialFile));
assert(credentials.database === registry.database && credentials.marker === registry.marker, "DISTRIBUTION_REGISTERED_CREDENTIAL_TARGET_CHANGED");
for (const role of ["runtime", "migration"]) assert(credentials[role]?.name === registry.roles[role]?.name && credentials[role]?.oid === registry.roles[role]?.oid, "DISTRIBUTION_REGISTERED_ROLE_CHANGED");
assert.equal(credentials.migration.oid, target.migrationRoleOid);
assert.equal(credentials.migration.name, "zzsh_regression_migration");
assert.equal(credentials.runtime.name, "zzsh_regression_runtime");
const { Client, Pool } = require("pg");
const base = { host: registered.host, port: registered.port, database: registry.database, statement_timeout: 30000, lock_timeout: 1000, connectionTimeoutMillis: 3000, application_name: "zzsh-local-distribution-qualification" };
async function identity(client, role, readOnly) {
  const row = (await client.query(targetIdentityQuery())).rows[0];
  assertLiveTarget(registered, row, role);
  assert(row && row.database === registry.database && row.oid === target.oid && row.nonce === target.nonce && row.marker === registry.marker && row.owner === "zzsh" && row.role === credentials[role].name && row.role_oid === credentials[role].oid && row.read_only === (readOnly ? "on" : "off"), "DISTRIBUTION_LIVE_TARGET_CHANGED");
  return row;
}
async function readTarget(originalPlan) {
  const timing={startedAt:new Date().toISOString()}, allAt=performance.now();
  (summary.timings.targetReads ??= []).push(timing);
  const c = new Client({ ...base, user: credentials.runtime.name, password: credentials.runtime.password }); let begun = false, result;
  try {
    let at=performance.now(); await c.connect(); await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true; timing.connectAndBeginMs=Math.round(performance.now()-at);
    at=performance.now();
    const resource = await identity(c, "runtime", true);
    timing.identityMs=Math.round(performance.now()-at); at=performance.now();
    const participants = (await c.query("SELECT user_id,source_digest,revision::text,eligibility,commission_frozen,policy_version_id,level_code FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL' ORDER BY user_id COLLATE \"C\"")).rows;
    timing.participantsReadMs=Math.round(performance.now()-at);timing.participants=participants.length;at=performance.now();
    const packets = (await c.query("SELECT details->'source' source,details->'facts' facts FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND outcome='SUCCESS' AND details#>>'{source,receiptSha256}'=$1", [input.source.sha256])).rows;
    timing.auditReadMs=Math.round(performance.now()-at);timing.auditPackets=packets.length;at=performance.now();
    const read = await readDistributionPolicyRowInTransaction(c, false, d.scope), policy = read.policy;
    timing.policyReadMs=Math.round(performance.now()-at);at=performance.now();
    const history=(await c.query(`SELECT source_kind,count(*)::text AS count,
      encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(f)::text,chr(10) ORDER BY id COLLATE "C"),''),'UTF8')),'hex') AS digest
      FROM zzsh_order.personal_finance_observation f WHERE source_type='LEGACY_MYSQL' GROUP BY source_kind ORDER BY source_kind`)).rows;
    assertHistoricalFinancePopulation(history, financialObservations);
    timing.historyFingerprintMs=Math.round(performance.now()-at);timing.historyKinds=history.length;at=performance.now();
    const plan = buildLegacyQualificationPlan({ participants, packets, payload, sourceDigest: input.source.sha256, canonicalize, projectQualification: projectLegacyInvitationQualification, expectedParticipants: dataset.domains.users.ready });
    timing.planProjectionMs=Math.round(performance.now()-at);at=performance.now();
    let qualificationReceipts;
    if(originalPlan){
      const actorFile=pinned(privatePath(input.actor.path),input.actor.sha256),actorId=actorFile.id??actorFile.actorId;
      reviewedDistributionActor(actorFile,target,{userId:actorId,sessionId:actorFile.sessionId,requestId:'readback'});
      const {fingerprintRequest}=moduleFromBuild('supply/supply-util');
      qualificationReceipts=await verifyQualificationReceipts(c,{plan:originalPlan,actorId,sourceDigest:input.source.sha256},fingerprintRequest);
      timing.qualificationReceiptReadMs=Math.round(performance.now()-at);timing.verifiedReceiptBatches=qualificationReceipts.batches;at=performance.now();
    }
    const headCompatible = !policy || policy.versionId === plan.policyId && policy.digest === plan.policyDigest && canonicalize(policy.config) === canonicalize(payload.config);
    result = { resource, plan, history, headCompatible, policyActive: !!policy && headCompatible, qualificationReceipts };
    assert.equal((await c.query("ROLLBACK")).command, "ROLLBACK"); begun = false;timing.rollbackAck=true;timing.rollbackMs=Math.round(performance.now()-at);
  } finally { try { if (begun) {const at=performance.now();try{timing.rollbackAck=(await c.query("ROLLBACK")).command==='ROLLBACK'}catch(error){timing.rollbackAck=false;throw error}finally{timing.rollbackMs=Math.round(performance.now()-at)}} } finally { try{await c.end();timing.clientClosed=true}catch(error){timing.clientClosed=false;throw error}finally{timing.finishedAt=new Date().toISOString();timing.elapsedMs=Math.round(performance.now()-allAt);output('receipt.json',summary)} } }
  return result;
}
summary.timings.inputValidationMs=Math.round(performance.now()-processStarted); output("receipt.json", summary);
  if (mode === "--prepare") {
    const data = await readTarget(); verifyBuild();
    const plan = { schema: "zzsh.local-distribution-qualification-plan.v1", inputSha256, datasetSha256: input.dataset.sha256, sourceDigest: input.source.sha256, candidateSha256: d.candidate.sha256, target: { oid: target.oid, nonce: target.nonce, database: registry.database, marker: registry.marker, ownerOid: data.resource.owner_oid, migrationRoleOid: credentials.migration.oid, instance:registered.instance }, buildDigest, toolFiles, ...data.plan, historicalFinance: data.history, headCompatible: data.headCompatible, policyActiveAtPrepare: data.policyActive, readOnlyRollbackAck: true, clientClosed: true };
    if(d.qualificationRenewal){const r=d.qualificationRenewal,evidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','buildManifest'].map(name=>[name,pinned(privatePath(r[name]?.path),r[name]?.sha256)]));
      summary.renewal=assertQualificationRenewalEvidence({...evidence,plan,input,refs:r,canonicalize});}
    if(d.qualificationConstraintRetry){const r=d.qualificationConstraintRetry,evidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','priorRecoveryInput','upgradePlan','upgradeExecution','upgradeReadback','buildManifest'].map(name=>[name,pinned(privatePath(r[name]?.path),r[name]?.sha256)]));
      summary.constraintRetry=assertQualificationConstraintRetryEvidence({...evidence,plan,input,refs:r,canonicalize});}
    output("plan.json", plan);
    summary.historicalFinanceBaseline = data.history;
    summary.status = plan.exceptions.length || plan.existing.length || !plan.headCompatible ? "REVIEW_REQUIRED" : "PREPARED_POLICY_MAY_REQUIRE_APPROVAL";
    if(plan.existing.length)summary.reason="ORIGINAL_QUALIFICATION_PLAN_REQUIRED_FOR_EXISTING_SUBJECTS";
    summary.planSha256 = sha(readFileSync(join(out, "plan.json")));
    summary.counts = { participants: dataset.domains.users.ready, accepted: plan.accepted.length, existing: plan.existing.length, ineligible: plan.ineligible.length, unresolved: (plan.unresolved ?? []).length, exceptions: plan.exceptions.length, batches: plan.batches.length };
    summary.policyActive = data.policyActive;
  } else {
    const plan = pinned(privatePath(option("--plan")), option("--plan-sha"));
    const planBinding = { inputSha256, datasetSha256: input.dataset.sha256, sourceDigest: input.source.sha256, candidateSha256: d.candidate.sha256, scope: d.scope, target: { oid: target.oid, nonce: target.nonce, database: registry.database, marker: registry.marker, migrationRoleOid: credentials.migration.oid, instance:registered.instance }, expectedParticipants: dataset.domains.users.ready, buildDigest, toolFiles };
    assertQualificationPlanBinding(plan, planBinding, canonicalize);
    const expectedPolicy = buildLegacyQualificationPlan({ participants: [], packets: [], payload, sourceDigest: input.source.sha256, canonicalize, projectQualification: projectLegacyInvitationQualification, expectedParticipants: 0 });
    assertQualificationPolicy(plan, expectedPolicy, canonicalize);
    summary.historicalFinanceBaseline = plan.historicalFinance;
    summary.counts = { participants: dataset.domains.users.ready, accepted: plan.accepted.length, existing: plan.existing.length, ineligible: plan.ineligible.length, unresolved: (plan.unresolved ?? []).length, exceptions: plan.exceptions.length, batches: plan.batches.length };
    output("receipt.json", summary);
    if (mode === "--approve") {
      assert(!optimized,'DISTRIBUTION_RENEWAL_CANNOT_REAPPROVE_POLICY');
      await approveLocalNativePolicy({ input, plan, registry, credentials, target, base, Pool, Client, sha, pinned, protectedInput, moduleFromBuild, identity, readTarget, canonicalize, verifyBuild, summary, save: () => output("receipt.json", summary) });
    } else if (mode === "--execute") {
      const authority = pinned(privatePath(option("--authority")), option("--authority-sha"));
      assertQualificationAuthority(authority, { ...planBinding, planSha256: option("--plan-sha"), policyId: plan.policyId, policyDigest: plan.policyDigest, window: input.window });
      const policyReceipt = pinned(privatePath(authority.policyReceipt?.path), authority.policyReceipt?.sha256);
      const q=d.qualificationRecovery;let qEvidence;
      if(q){qEvidence=Object.fromEntries(['failure','inspection','guard','previousPlan','previousInput','previousAuthority'].map(name=>[name,pinned(privatePath(q[name]?.path),q[name]?.sha256)]));
        assertQualificationRecoveryEvidence({...qEvidence,plan,input,refs:q,canonicalize});
        assert(authority.approvalRef===qEvidence.previousAuthority.approvalRef&&authority.attempt===qEvidence.previousAuthority.attempt
          &&canonicalize(authority.actor)===canonicalize(qEvidence.previousAuthority.actor)&&Date.parse(authority.notBefore)>=Date.parse(qEvidence.previousAuthority.notBefore)
          &&Date.parse(authority.expiresAt)<=Date.parse(qEvidence.previousAuthority.expiresAt),'DISTRIBUTION_QUALIFICATION_RECOVERY_AUTHORITY_CHANGED');}
      const r=d.qualificationRenewal;let renewalEvidence;
      if(r){renewalEvidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','buildManifest'].map(name=>[name,pinned(privatePath(r[name]?.path),r[name]?.sha256)]));
        summary.renewal=assertQualificationRenewalEvidence({...renewalEvidence,plan,input,refs:r,canonicalize});
        assert(authority.approvalRef!==renewalEvidence.previousAuthority.approvalRef&&authority.attempt!==renewalEvidence.previousAuthority.attempt
          &&authority.actor?.userId===renewalEvidence.previousAuthority.actor?.userId&&authority.actor?.sessionId===renewalEvidence.previousAuthority.actor?.sessionId
          &&authority.maxBatches===plan.batches.length&&authority.maxSubjectsPerBatch===1000&&authority.sourceLock==='TRANSACTION_SHARE_AUDIT_AND_INVITATION_GRAPH','DISTRIBUTION_RENEWAL_AUTHORITY_CHANGED');}
      const r2=d.qualificationConstraintRetry;let retryEvidence;
      if(r2){retryEvidence=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','priorRecoveryInput','upgradePlan','upgradeExecution','upgradeReadback','buildManifest'].map(name=>[name,pinned(privatePath(r2[name]?.path),r2[name]?.sha256)]));
        summary.constraintRetry=assertQualificationConstraintRetryEvidence({...retryEvidence,plan,input,refs:r2,canonicalize});
        assert(authority.approvalRef!==retryEvidence.previousAuthority.approvalRef&&authority.attempt!==retryEvidence.previousAuthority.attempt
          &&authority.actor?.userId===retryEvidence.previousAuthority.actor?.userId&&authority.actor?.sessionId===retryEvidence.previousAuthority.actor?.sessionId
          &&authority.maxBatches===plan.batches.length&&authority.maxSubjectsPerBatch===1000&&authority.sourceLock==='TRANSACTION_SHARE_AUDIT_AND_INVITATION_GRAPH','DISTRIBUTION_RETRY_AUTHORITY_CHANGED');}
      const policyInputSha=r2?retryEvidence.priorRecoveryInput.distribution.qualificationRecovery.previousInput.sha256:r?renewalEvidence.previousInput.distribution.qualificationRecovery.previousInput.sha256:q?q.previousInput.sha256:undefined;
      assertDistributionPolicyReceipt(policyReceipt, { ...planBinding, ...(policyInputSha?{inputSha256:policyInputSha}:{}), policyId: plan.policyId, historicalFinance: plan.historicalFinance }, canonicalize);
      assert(plan.accepted.length > 0 && plan.batches.length > 0, "NO_DISTRIBUTION_QUALIFICATION_WRITES_REQUIRED");
      const actorFile = pinned(privatePath(input.actor.path), input.actor.sha256), actor = reviewedDistributionActor(actorFile, target, authority.actor);
      const { bindReviewedLegacyInvitationFacts, qualifyReviewedLegacyParticipants, prepareReviewedLegacyQualificationIndex } = moduleFromBuild("finance/legacy-invitation-facts-maintenance");
      if(optimized)assert.equal(typeof prepareReviewedLegacyQualificationIndex,'function','DISTRIBUTION_RENEWAL_INDEX_REQUIRED');
      const pool = new Pool({ ...base, user: credentials.migration.name, password: credentials.migration.password, max: 1 });
      const lock = new Client({ ...base, database: "postgres", user: credentials.migration.name, password: credentials.migration.password });
      await executeQualification({ pool, lock, identity, plan, authority, actor, registry, target, sourceDigest: input.source.sha256, bind: bindReviewedLegacyInvitationFacts, qualify: qualifyReviewedLegacyParticipants, prepareIndex: prepareReviewedLegacyQualificationIndex, verifyBuild, summary, save: () => output("receipt.json", summary), ...(q||r||r2?{verifyRecovery:client=>assertQualificationRecoveryPreimage(client,plan,actor)}:{}) });
    }
    if (mode !== "--approve") {
      verifyBuild(); const after = await readTarget(plan); verifyBuild(); assert(after.policyActive && after.headCompatible, "ACTIVE_DISTRIBUTION_POLICY_REQUIRED");
      assertQualificationReadback(plan, after.plan);
      assertHistoricalFinanceUnchanged(plan.historicalFinance,after.history,canonicalize);
      summary.historicalFinanceReadback = after.history;
      summary.status = "EXACT_QUALIFICATION_READBACK_PASSED"; summary.readOnlyRollbackAck = true; summary.readOnlyClientClosed = true;
      summary.counts = { ...summary.counts, readbackEligible: after.plan.existing.length, readbackIneligible: after.plan.ineligible.length, readbackUnresolved: (after.plan.unresolved ?? []).length, readbackExceptions: after.plan.exceptions.length, verifiedReceiptBatches: after.qualificationReceipts.batches, verifiedReceiptParticipants: after.qualificationReceipts.participants };
    }
  }
} catch (error) {
  if(summary.timings.inputValidationMs===undefined)summary.timings.inputValidationMs=Math.round(performance.now()-processStarted);
  if (!["COMMIT_UNKNOWN", "STOPPED", "COMMITTED_ACK_READBACK_REQUIRED", "POLICY_COMMIT_ACK_READBACK_REQUIRED"].includes(summary.status)) summary.status = summary.pending ? "STOPPED_APPROVAL_OUTCOME_UNKNOWN" : "STOPPED_READBACK_OR_PREPARE";
  summary.error = { code: /^[A-Z][A-Z0-9_:.]{1,100}$/.test(error.message ?? "") ? error.message : error.code ?? error.name }; process.exitCode = 1;
} finally {
  summary.finishedAt = new Date().toISOString(); summary.elapsedMs=Math.round(performance.now()-processStarted); output("receipt.json", summary);
  console.log(JSON.stringify({ status: summary.status, counts: summary.counts, policyActive: summary.policyActive, planSha256: summary.planSha256, rollbackAck: summary.rollbackAck, lockReleased: summary.lockReleased, clientsClosed: summary.clientsClosed, financialWrites: 0 }));
}
