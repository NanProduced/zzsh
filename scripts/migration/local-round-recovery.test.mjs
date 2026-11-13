import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { assertSameDirectoryResumeSafe, isRoundReceiptPath, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation } from "./local-load-checkpoint.mjs";
import { acquireMigrationSessionFence, advisoryLockSql, assertCaptureTargetProfile, assertLiveTarget, assertMigrationFenceHeld, assertNextMigrationWriteReady, captureMaintenanceLockEpoch, NEXT_MIGRATION_PROFILE, maintenanceConnection, normalizeRegisteredTarget, releaseMigrationSessionFence, sameMigrationProfile, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";
import { assertRoundPopulationBinding, assertFullExecutionAdmitted } from "./full-source-scope.mjs";
import { assertSelectedScopeForWrite, legacyListedProofVersion, legacyListedTargetMatches, planSelectedBusinessScope, selectedScopeDigest, selectedScopeFilter } from "./selected-business-scope.mjs";
import { summarizePopulationScope } from "./local-source-scenarios.mjs";
import { LEGACY_REFUND_RELATIONSHIP_POLICY, assertDisplayCaptureCoverage, assertNextBusinessPopulation, expectedContinuationImports, verifyNextContinuationRows, readLfLines } from "./local-source-adapter.mjs";
import { verifySelectedPopulationFiles } from "./verify-full-source-population.mjs";
import { BUSINESS_REFERENCE_TABLES, RENTAL_REFERENCE_TABLES } from "./business-reference-readiness.mjs";
import { assertNextSourceTools } from "./local-round-dependencies.mjs";
import { assertRoundBootstrap, assertRoundLegalBootstrap, assertRoundIdentityKeyBinding, assertRoundOpeningPartition, assertRoundPreparationTools, assertRoundSourceOrigin, assessRoundEvidence, compactEmptyCoverageReadbackMatches, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";

test('new rounds require a restored source and both supplements bound to the same dump and capture',()=>{
  const hash='a'.repeat(64),receiptSha='b'.repeat(64),dumpSha='c'.repeat(64),uuid='12345678-1234-1234-1234-123456789abc',id='d'.repeat(64),cutoff='2026-11-03T07:01:00Z';
  const binding={schema:'zzsh.local-source-origin.v2',container:{id,name:'zzsh-migration-mysql-fixture',imageId:'sha256:'+'e'.repeat(64)},source:{database:'sg_zzsh_restore',serverUuid:uuid,network:'none',readOnly:true,superReadOnly:true,eventScheduler:'DISABLED'},
    restoreRecord:{dumpPath:'E:/fixture/source.sql',dumpSha256:dumpSha,consumedSha256:dumpSha,importClientExitCode:0,exportStartedAt:'2026-11-03T07:00:00Z',cutoff,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'}};
  const source={schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,client:{code:0},clientStderrPresent:false,containerId:id,database:'sg_zzsh_restore',
    sourceOrigin:{schema:binding.schema,bindingSha256:hash,serverUuid:uuid,verifiedAfterCapture:true,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'},
    identity:{database:'sg_zzsh_restore',principal:'root@localhost',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE',serverUuid:uuid,globalReadOnly:1,superReadOnly:1,eventScheduler:'DISABLED'}};
  const supplement={...source,sourceSupplement:{baseReceiptSha256:receiptSha}},dataset={sourceReceiptSha256:receiptSha,sourceCutoff:cutoff,sourceOrigin:{bindingSha256:hash,dumpSha256:dumpSha}},
    input={target:{migrationProfile:NEXT_MIGRATION_PROFILE},source:{path:'E:/fixture/out/source',sha256:receiptSha},funds:{path:'E:/fixture/out/finance',sha256:hash},
      refundAttempts:{path:'E:/fixture/out/refund',sha256:hash},sourceBinding:{path:'E:/fixture/binding.json',sha256:hash},sourceWorkflow:{path:'E:/fixture/workflow.json',sha256:hash}};
  const workflowInput={schema:'zzsh.local-source-workflow.v1',suffix:'fixture',imageId:binding.container.imageId,dump:binding.restoreRecord.dumpPath,
    exportStartedAt:binding.restoreRecord.exportStartedAt,cutoff,out:'E:/fixture/out'};
  const workflow={schema:'zzsh.local-source-workflow-receipt.v1',status:'SOURCE_CAPTURED_DATASET_NOT_PREPARED',targetWrites:0,automaticCleanup:false,
    input:{path:'E:/fixture/input.json',sha256:hash},inputSha256:hash,stages:['prepare','restore','capture','finance','refund','verify'].map(name=>({name,status:'ACK',wallMs:1})),
    result:{source:input.source,funds:input.funds,refundAttempts:input.refundAttempts,sourceBinding:input.sourceBinding,containerId:id}};
  assert.doesNotThrow(()=>assertRoundSourceOrigin(input,source,dataset,binding,supplement,supplement,workflow,workflowInput));
  assert.doesNotThrow(()=>assertRoundSourceOrigin({target:{}},{},{},null,null,null,null,null));
  for(const [i,s,d,b,f,r] of [
    [{...input,sourceBinding:undefined},source,dataset,binding,supplement,supplement],
    [input,source,{...dataset,sourceOrigin:{...dataset.sourceOrigin,dumpSha256:'0'.repeat(64)}},binding,supplement,supplement],
    [input,source,dataset,binding,{...supplement,sourceOrigin:{...source.sourceOrigin,verifiedAfterCapture:false}},supplement],
    [input,source,dataset,binding,supplement,{...supplement,sourceSupplement:{baseReceiptSha256:'0'.repeat(64)}}],
    [input,source,dataset,{...binding,schema:'zzsh.local-source-origin.v1'},supplement,supplement],
  ])assert.throws(()=>assertRoundSourceOrigin(i,s,d,b,f,r,workflow,workflowInput));
  assert.throws(()=>assertRoundSourceOrigin(input,source,dataset,binding,supplement,supplement,{...workflow,status:'STARTED'},workflowInput),/ROUND_SOURCE_WORKFLOW_PROOF_REQUIRED/);
  assert.throws(()=>assertRoundSourceOrigin(input,source,dataset,binding,supplement,supplement,workflow,{...workflowInput,cutoff:'2026-11-04T00:00:00Z'}),/ROUND_SOURCE_WORKFLOW_INPUT_CHANGED/);
});
test('new-round growth recovery cannot change the source binding or target profile',()=>{
  const hash='a'.repeat(64),other='b'.repeat(64),ref={path:'fixture',sha256:hash};
  const target={oid:'42',nonce:'c'.repeat(24),migrationRoleOid:'91',migrationProfile:NEXT_MIGRATION_PROFILE,schemaHashes:[]};
  const sources=Object.fromEntries(['source','dataset','funds','refundAttempts','display','openings','paths','pathSourcePlan','dictionary'].map(key=>[key,ref]));
  const previousInput={schema:'zzsh.local-round.v1',...sources,target,sourceBinding:ref,sourceWorkflow:ref},previousReceipt={inputSha256:hash,stages:[{name:'readback'}]};
  const input={...sources,target,sourceBinding:{...ref,sha256:other},sourceWorkflow:ref,growth:{},resume:{schema:'zzsh.local-round-growth-resume.v1',previousInput:ref}};
  assert.throws(()=>assertResumeLineage({input,previousInput,previousInputSha256:hash,previousReceipt}),/ROUND_RESUME_LINEAGE_MISMATCH:sourceBinding/);
  assert.throws(()=>assertResumeLineage({input:{...input,sourceBinding:ref,sourceWorkflow:{...ref,sha256:other}},previousInput,previousInputSha256:hash,previousReceipt}),/ROUND_RESUME_LINEAGE_MISMATCH:sourceWorkflow/);
  const changed={...input,sourceBinding:ref,target:{...target,migrationProfile:'OTHER'}};
  assert.throws(()=>assertResumeLineage({input:changed,previousInput,previousInputSha256:hash,previousReceipt}),/ROUND_RESUME_LINEAGE_MISMATCH:target/);
});

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const script = name => readFileSync(new URL(name, import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replaceAll("import.meta.url", "moduleUrl").replaceAll('await import("./local-target-finance.mjs")', "await financialFixture()");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const epoch = { oid: "42", nonce: "a".repeat(24) };
const window = { notBefore: "2000-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
const schema = ["b".repeat(64)];
const restricted = "E:\\zzsh-local-state\\restricted";
const ds = path.join(restricted, "dataset"), out = path.join(restricted, "load"), funds = path.join(restricted, "funds");
const credentials = path.join(restricted, "resource", "credentials.json"), registry = path.join(path.dirname(credentials), "resource.json");
const checkpoint = path.join(out, "checkpoint.json"), users = [{ sourceId: "101", input: { id: 1, evidence: { status: { realNameBound: false } } } }, { sourceId: "102", input: { id: 2, evidence: { status: { realNameBound: false } } } }];

async function load({ failure, strict = true, reservation = {}, previous, recover = false, exitAfterUsers = false, populationMode, selectedScope, undeclaredPopulation = false, invalidPopulationDigest = false, instance = null, migrationProfile, pendingReset = null, identityProfiles = true, verifiedFirst = false, unicodeFirst = false, profileSecret = "fixture-independent-profile", selectedFixture = false, selectedSourceMismatch = false, refundPolicy = true, fenceFixture = false, continuationRows = null, continuationDomains, additiveFlag, withoutActor = false } = {}) {
  if(migrationProfile===NEXT_MIGRATION_PROFILE && populationMode===undefined){
    populationMode='SELECTED_BUSINESS_SCOPE';selectedScope=planSelectedBusinessScope({accounts:[],orders:[],pays:[]});selectedFixture=true;
  }
  const files = new Map(), directories = new Set(), commands = [], events = [], logs = [], saves = [], scopeChecks = [];
  const userRows = structuredClone(users);
  if (unicodeFirst) userRows[0].input.note = "合成\u2028昵称\u2029保留";
  if (verifiedFirst) Object.assign(userRows[0], { userId: "synthetic-user-101", sourceDigest: "a".repeat(64), trustedIdentityNumber: "99000019900101123X",
    legacyIdentityProfile: { realName: "合成姓名", idCardNo: "99000019900101123X" }, input: { id: 1, evidence: { status: { realNameBound: true } } } });
  if (migrationProfile === NEXT_MIGRATION_PROFILE) for (const row of userRows) {
    row.userId = "synthetic-user-" + row.sourceId; row.sourceDigest = "a".repeat(64);
    Object.assign(row.input.evidence, { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_user", legacyId: row.sourceId, sourceDigest: row.sourceDigest });
    row.input.evidenceDigest = "b".repeat(64);
  }
  const put = (file, value) => files.set(file, JSON.stringify(value));
  const get = file => { assert(files.has(file), file); return files.get(file); };
  const fileEntries = {};
  for (const [name, rows] of Object.entries({ users: userRows, accounts: [], orders: [], ...(continuationRows ? {continuations:continuationRows} : {}) })) {
    const file = name + ".jsonl", body = rows.map(row => JSON.stringify(row) + "\n").join("");
    files.set(path.join(ds, file), body);
    fileEntries[name] = { file, sha256: sha(body), rows:rows.length };
  }
  const manifest = path.join(ds, "manifest.json"), fundsReceipt = path.join(funds, "receipt.json");
  const population = populationMode ? { schema: "zzsh.local-population-scope.v1", mode: populationMode } : null;
  const continuationFixture=continuationDomains===undefined && migrationProfile===NEXT_MIGRATION_PROFILE ? {source:0,parameterComplete:0,isolated:0,unsupportedStatuses:{'2':0,'6':0,'7':0},preparedEvidence:{policy:'PRESERVE_SOURCE_ADMISSION_V1',commissionPolicy:'ACTIVE_OR_SETTLED_SOURCE_V1',readyComplete:0,readyIsolated:0,readyUnprepared:0,unreadyEmitted:0,unreadyUnprepared:0}} : continuationDomains;
  put(manifest, { status: "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN", gameBindings: {}, files: fileEntries,
    ...(continuationFixture?{domains:{continuations:continuationFixture}}:{}),
    ...(identityProfiles && refundPolicy ? { refundRelationshipPolicy: LEGACY_REFUND_RELATIONSHIP_POLICY } : {}),
    ...(selectedFixture ? { source: path.join(restricted, "fixture-source"), sourceReceiptSha256: "a".repeat(64) } : {}),
    ...(identityProfiles ? { identityProfiles: { schema: "zzsh.legacy-identity-profile-source.v1", verified: verifiedFirst ? 1 : 0, ready: verifiedFirst ? 1 : 0, invalid: 0 } } : {}),
    ...(selectedScope ? {selectedScope,selectedScopeSha256:selectedScopeDigest(selectedScope)} : {}),
    ...(population ? { population, populationSha256: invalidPopulationDigest ? "f".repeat(64) : sha(JSON.stringify(population)) } : undeclaredPopulation ? {} : { scenarioSelection: { schema: "zzsh.source-scenarios.v1" } }) });
  put(fundsReceipt, {});
  const migration = { name: "test_migration", oid: "91", password: "test" }, runtime = { name: "test_runtime", oid: "92" };
  const registration = { ...epoch, database: "zzsh_test_regression", marker: "zzsh:regression-test:v1", roles: { migration, runtime }, ...(instance ? {instance} : {}), ...(migrationProfile ? {migrationProfile} : {}), ...(pendingReset ? {pendingReset} : {}), ...(strict || Object.keys(reservation).length ? { protectedDataset: {
    status: strictRoundReservation, epoch, manifestSha256: sha(get(manifest)), ...reservation,
  } } : {}) };
  files.set(registry, previous?.files.get(registry) ?? JSON.stringify(registration));
  if (previous) {
    files.set(checkpoint, previous.files.get(checkpoint));
    directories.add(out);
  }
  put(credentials, { database: registration.database, migration });
  files.set("test-secret", "fixture");
  files.set("test-profile-secret", profileSecret);
  const proc = { version: "v24.20.0", env: { DB_PASSWORD_FILE: "test-secret", USER_IDENTITY_SUBJECT_HMAC_KEY_FILE: "test-secret", USER_LEGACY_IDENTITY_PROFILE_KEY_FILE: "test-profile-secret" }, argv: ["node", "script",
    recover ? "--recover" : "--execute", ...(strict ? ["--strict-round-batch"] : []), ...(additiveFlag?[additiveFlag]:[]), ...(failure?.startsWith("empty-coverage") ? ["--refund-attempts", funds, "--refund-attempts-sha", sha(get(fundsReceipt))] : ["--core-only"]), "--dataset", ds, "--dataset-sha", sha(get(manifest)),
    "--credentials", credentials, "--out", out, "--oid", epoch.oid, "--nonce", epoch.nonce, ...(withoutActor ? [] : ["--actor-id", "test-user", "--session-id", "test-session"]),
    "--schema-binding", JSON.stringify(schema), "--execution-window", JSON.stringify(window), "--funds-source", funds, "--funds-source-sha", sha(get(fundsReceipt)),
  ] };
  let commitAck = false, diskFailed = false;
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql.startsWith("SELECT current_database()")) return { rows: [{ ...epoch, database: registration.database, owner: "zzsh", marker: registration.marker, role: migration.name, role_oid: migration.oid, is_super: "false", can_create_db: "false", can_create_role: "false", can_inherit: "false", can_bypass_rls: "false", system_identifier: instance?.systemIdentifier ?? null }] };
      if (sql.startsWith("SELECT hash")) return { rows: schema.map(hash => ({ hash })) };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ occupied: false }] };
      commands.push(sql);
      if (sql.startsWith("SELECT subject_digest,source FROM zzsh_iam.user_identity_subject")) return { rows: [] };
      if (sql === "COMMIT" && failure === "empty-coverage-unknown" && events.some(e => e.domain === "financeEmptyCoverage" && e.event === "INTENT")) throw Object.assign(Error("original coverage commit error"), {code:"ECONNRESET"});
      if (sql === "COMMIT" && failure === "lost-commit") {
        const error = Object.assign(Error("original commit error"), { code: "ECONNRESET" });
        this.emit("error", error);
        throw error;
      }
      if (sql === "COMMIT") commitAck = true;
      if (sql === "ROLLBACK" && commands.includes("BEGIN") && failure === "lost-rollback") {
        const error = Error("lost rollback");
        this.emit("error", error);
        throw error;
      }
      return { command: sql };
    },
    release(error) { commands.push(error ? "DESTROY_CLIENT" : "RELEASE_CLIENT"); },
  });
  const modules = {
    "supply/content-hash": { canonicalize: JSON.stringify },
    "auth/identity-subject": { deriveIdentitySubjectKey() { return Buffer.alloc(32, 9); }, identitySubjectDigest() { return "b".repeat(64); },
      recordLegacyIdentitySubject() { commands.push("SYNTHETIC_IDENTITY_SUBJECT"); },
      recordLegacyIdentitySubjects() { commands.push("SYNTHETIC_IDENTITY_SUBJECT"); } },
    "auth/legacy-identity-profile": { legacyIdentityProfileKey(value) { return createHash("sha256").update(value).digest(); },
      recordLegacyIdentityProfile() { commands.push("SYNTHETIC_IDENTITY_PROFILE"); if (failure === "profile-rejected") throw Object.assign(Error("profile rejected"), { status: 503 }); },
      recordLegacyIdentityProfiles() { commands.push("SYNTHETIC_IDENTITY_PROFILE"); if (failure === "profile-rejected") throw Object.assign(Error("profile rejected"), { status: 503 }); } },
    "database/business-migrations": { assertBusinessMigrationPrefix() {} },
    "order/legacy-continuation-calc": { admitLegacyEvidence: source => ({admission:source.admission,reasons:source.reasons}) },
    "finance/personal-finance-maintenance": { authorizeFinanceMaintenance() {} },
    "finance/personal-finance-observation-maintenance": { COMPACT_EMPTY_COVERAGE_VERSION: "BATCH_V2",
      importReviewedCompactEmptyFinanceObservationBatch() {}, recoverReviewedCompactEmptyFinanceObservationBatch() {}, compactEmptyFinanceBatchProof() {} },
    "legacy-load/system-user-migration": {
      systemUserMigrationId: source => "synthetic-user-system-" + source,
      systemAccountMigrationId: source => "synthetic-account-system-" + source,
      systemOrderMigrationId: source => "synthetic-order-system-" + source,
      systemFinanceMigrationId: source => "synthetic-finance-system-" + source,
      systemInvitationMigrationId: source => "synthetic-invitation-system-" + source,
      async withSystemUserMigrationBatch(c, acting, body) { await acting.assertMigrationFence(c); const result=await body(); await acting.assertMigrationFence(c); return result; },
      async withSystemAccountMigrationBatch(c, acting, body) { await acting.assertMigrationFence(c); return body(); },
      async withSystemOrderMigrationBatch(c, acting, body) { await acting.assertMigrationFence(c); return body(); },
      async withSystemFinanceMigrationBatch(c, acting, body) { await acting.assertMigrationFence(c); return body(); },
      async withSystemInvitationMigrationBatch(c, acting, body) { await acting.assertMigrationFence(c); return body(); },
    },
    "supply/legacy-user-migration": { legacyOwnerUserId(_system,_entity,id) { return "synthetic-user-"+id; }, async migrateLegacyOwner(_client, row, acting) {
      if (migrationProfile === NEXT_MIGRATION_PROFILE) {
        assert.equal(acting.kind, "SYSTEM_USER_MIGRATION");
        await acting.assertSourceEvidence({sourceSystem:row.evidence.sourceSystem,sourceEntity:row.evidence.sourceEntity,legacyId:row.evidence.legacyId,sourceDigest:row.evidence.sourceDigest,evidenceDigest:row.evidenceDigest});
      }
      if (row.id === 2 && ["rejected", "lost-rollback"].includes(failure)) throw Object.assign(Error("original rejection"), { status: 409 });
      if (unicodeFirst && row.id === 1) { assert.equal(row.note, "合成\u2028昵称\u2029保留"); commands.push("UNICODE_SOURCE_PRESERVED"); }
      return { replayed: false, ...(row.evidence.legacyId ? { userId: "synthetic-user-" + row.evidence.legacyId } : {}) };
    } },
  };
  const context = {
    ...path, createHash, createHmac, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation, process: proc, moduleUrl: "fixture", fileURLToPath: () => "C:\\project\\scripts\\migration\\load-local-dataset.mjs",
    acquireMigrationSessionFence: fenceFixture ? async () => { commands.push('SESSION_FENCE'); } : acquireMigrationSessionFence,
    assertMigrationFenceHeld: fenceFixture ? async () => { commands.push('FENCE'); if (failure === 'fence-lost') throw Error('TARGET_FENCE_EPOCH_LOST'); } : assertMigrationFenceHeld,
    releaseMigrationSessionFence: fenceFixture ? async () => { commands.push('UNFENCE'); } : releaseMigrationSessionFence,
    advisoryLockSql, assertLiveTarget, assertNextMigrationWriteReady: fenceFixture ? () => {} : assertNextMigrationWriteReady,
    captureMaintenanceLockEpoch: fenceFixture ? async () => { commands.push('FENCE_EPOCH'); return { fixture: true }; } : captureMaintenanceLockEpoch,
    NEXT_MIGRATION_PROFILE, maintenanceConnection, targetConnection, targetIdentityQuery, assertFullExecutionAdmitted, assertSelectedScopeForWrite, legacyListedProofVersion, assertNextBusinessPopulation, expectedContinuationImports, verifyNextContinuationRows, LEGACY_REFUND_RELATIONSHIP_POLICY, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure,
    readBoundSelectedSourceReceipt: (_source, _digest) => ({}),
    verifySelectedPopulationFiles: async args => { scopeChecks.push(args); if (selectedSourceMismatch) throw Error("SELECTED_SCOPE_SOURCE_ORDER_DISPOSITION_MISMATCH"); return { status: "SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN", targetWrites: 0 }; },
    // The loader reads its registry through this sandbox filesystem, not the real disk.
    loadRegisteredTarget: credentialPath => { const file = path.join(path.dirname(credentialPath), "resource.json"); return normalizeRegisteredTarget(JSON.parse(get(file)), file); },    financialFixture: () => ({ applyFinancialDomains: ctx => ctx.runItems("financeEmptyCoverage", failure === "empty-coverage" ? [{ sourceId: "empty-original" }] : Array.from({length:5},(_,i)=>({sourceId:`chunk-${i}`})), row => { if(failure === "empty-coverage" || (failure === "empty-coverage-batch" && row.sourceId === "chunk-1")) throw Object.assign(Error("coverage rejected"), { status: 409 }); return {replayed:false}; }, failure === "empty-coverage" ? 1 : 5) }),
    console: { log: message => logs.push(JSON.parse(message)), error: message => logs.push(JSON.parse(message)) },
    createReadStream: file => Readable.from([Buffer.from(get(file))]),
    async *readRows(file) { for await (const line of readLfLines(context.createReadStream(file))) if (line.trim()) yield JSON.parse(line); },
    async preflightBoundSourceBatches(file, entry, size) {
      assert.equal(entry.rows, get(file).split("\n").filter(Boolean).length); assert.equal(size, 100); return {};
    },
    async *readBoundSourceBatches(file) { yield* context.readRows(file); },
    existsSync: file => files.has(file) || directories.has(file), mkdirSync: file => directories.add(file), readFileSync: (file, encoding) => encoding ? get(file) : Buffer.from(get(file)),
    writeFileSync: (file, value) => files.set(file, value), appendFileSync: (_file, value) => events.push(JSON.parse(value)),
    writeLoadCheckpoint(file, value) {
      if (file === checkpoint && commitAck && failure === "receipt" && !diskFailed) { diskFailed = true; throw Object.assign(Error("original disk error"), { code: "ENOSPC" }); }
      put(file, value);
      if (file === checkpoint) saves.push(JSON.parse(get(file)));
    },
    spawnSync: () => ({ stdout: "S-1-5-21-1", status: 0 }),
    createRequire: () => name => name === "pg" ? {
      Client: class { async connect() {} async query(sql) { commands.push(sql.includes("try_advisory") ? "LOCK" : "UNLOCK"); return { rows: [{ ok: true }] }; } async end() { commands.push("MAINTENANCE_END"); } },
      Pool: class { async connect() { return client; } async end() { commands.push("POOL_END"); } },
    } : modules[name.slice(name.indexOf("dist\\src\\") + 9, -3).replaceAll("\\", "/")],
  };
  if (exitAfterUsers) context.createReadStream = file => {
    const reads = commands.includes("COMMIT");
    if (reads && file === path.join(ds, "accounts.jsonl")) throw Error("fixture continued after users");
    return Readable.from([Buffer.from(get(file))]);
  };
  let error;
  try { await new AsyncFunction(...Object.keys(context), script("load-local-dataset.mjs"))(...Object.values(context)); }
  catch (cause) { error = cause; }
  return { commands, directories, error, events, files, logs, saves, scopeChecks, exit: proc.exitCode, state: files.has(checkpoint) ? JSON.parse(get(checkpoint)) : null };
}

test("next-profile dataset execution stops before connecting until all domain adapters are ready",async()=>{
 const result=await load({instance:{host:'127.0.0.1',port:55435,systemIdentifier:'12345'},migrationProfile:'LOCAL_MIGRATION_NEXT_V1'});
 assert.match(result.error?.message??'',/NEXT_MIGRATION_ADMISSION_INCOMPLETE/);
 assert(!result.commands.includes('LOCK'));assert(!result.commands.includes('BEGIN'));assert(!result.commands.includes('COMMIT'));
});

test('NEXT refuses the wrong population or incomplete continuation evidence before target writes',async()=>{
 const instance={host:'127.0.0.1',port:55435,systemIdentifier:'12345'},migrationProfile=NEXT_MIGRATION_PROFILE;
 const refused=await load({instance,migrationProfile,populationMode:'SCENARIO_SELECTION'});
 assert.match(refused.error?.message??'',/NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED/);assert.deepEqual(refused.commands,[]);assert.equal(refused.directories.size,0);
 const selectedScope=planSelectedBusinessScope({accounts:[],orders:[],pays:[]}),options={instance,migrationProfile,populationMode:'SELECTED_BUSINESS_SCOPE',selectedScope,selectedFixture:true};
 const missing=await load({...options,continuationDomains:null});
 assert.match(missing.error?.message??'',/NEXT_CONTINUATION_SOURCE_COVERAGE_UNPROVEN/);assert.deepEqual(missing.commands,[]);assert.equal(missing.directories.size,0);
 const source={legacyOrderId:'1',admission:'ISOLATED',reasons:['MISSING_BASE_BOT']};
 const row={sourceId:'1',parentSourceDigest:'a'.repeat(64),source,admission:'PARAMETER_COMPLETE',reasons:source.reasons,targetParentReady:true};
 const continuationDomains={source:1,parameterComplete:1,isolated:0,unsupportedStatuses:{'2':0,'6':0,'7':0},preparedEvidence:{policy:'PRESERVE_SOURCE_ADMISSION_V1',commissionPolicy:'ACTIVE_OR_SETTLED_SOURCE_V1',readyComplete:1,readyIsolated:0,readyUnprepared:0,unreadyEmitted:0,unreadyUnprepared:0}};
 const altered=await load({...options,continuationRows:[row],continuationDomains});
 assert.match(altered.error?.message??'',/CONTINUATION_SOURCE_ADMISSION_MISMATCH/);assert.deepEqual(altered.commands,[]);assert.equal(altered.directories.size,0);
});

test('NEXT explicitly refuses unbound additive plans before creating output or connecting',async()=>{
 const instance={host:'127.0.0.1',port:55435,systemIdentifier:'12345'};
 for(const additiveFlag of ['--contact-append','--legacy-number-only']){
  const result=await load({instance,migrationProfile:NEXT_MIGRATION_PROFILE,additiveFlag});
  assert.match(result.error?.message??'',/NEXT_ADDITIVE_MIGRATION_NOT_SUPPORTED/);
  assert.deepEqual(result.commands,[]);assert.equal(result.directories.size,0);
 }
});

test('next-profile core batches acquire the transaction fence before writes and roll back on failure', async () => {
  const options = { instance: { host:'127.0.0.1', port:55435, systemIdentifier:'12345' }, migrationProfile:'LOCAL_MIGRATION_NEXT_V1', fenceFixture:true, verifiedFirst:true };
  const applied = await load(options); assert.ifError(applied.error);
  const systemOnly = await load({ ...options, withoutActor: true }); assert.ifError(systemOnly.error);
  assert.equal(systemOnly.state.binding.actorId, null); assert.equal(systemOnly.state.binding.sessionId, null);
  assert(systemOnly.commands.includes('FENCE')); assert(systemOnly.commands.includes('COMMIT'));
  const oldProfile = await load({ withoutActor: true });
  assert.match(oldProfile.error?.message ?? '', /EXISTING_MAINTENANCE_ACTOR_REQUIRED/); assert(!oldProfile.commands.includes('LOCK'));
  assert(applied.commands.indexOf('FENCE_EPOCH') < applied.commands.indexOf('SESSION_FENCE'));
  assert(applied.commands.indexOf('SESSION_FENCE') < applied.commands.indexOf('BEGIN'));
  assert(applied.commands.indexOf('BEGIN') < applied.commands.indexOf('FENCE'));
  assert(applied.commands.indexOf('FENCE') < applied.commands.indexOf('SYNTHETIC_IDENTITY_SUBJECT'));
  assert(applied.commands.indexOf('FENCE') < applied.commands.indexOf('COMMIT'));
  assert(applied.commands.indexOf('UNFENCE') > applied.commands.indexOf('COMMIT'));
  const rejected = await load({ ...options, failure:'fence-lost' });
  assert.equal(rejected.state.status, 'FAILED_ROLLED_BACK'); assert(rejected.commands.includes('ROLLBACK'));
  assert(!rejected.commands.includes('COMMIT')); assert(!rejected.commands.includes('SYNTHETIC_IDENTITY_SUBJECT'));
});

test("a retained successful payment conflicting with the order flag stops before any connection or target write",async()=>{
  const selectedScope=planSelectedBusinessScope({accounts:[{id:'a1',status:'4',is_delete:'0'}],orders:[{id:'o1',accounts_id:'a1',pay_is:'0'}],pays:[{id:'p1',order_id:'o1',order_type:'1',pay_is:'1'}]});
  const result=await load({populationMode:'SELECTED_BUSINESS_SCOPE',selectedScope,strict:false});
  assert.match(result.error?.message??'',/SELECTED_PAID_RECORD_ORDER_FLAG_CONFLICT_REVIEW_REQUIRED/);
  assert.deepEqual(result.commands,[]);assert.equal(result.directories.size,0);assert.equal(result.state,null);
});

test("direct core loader checks source scope before creating output or connecting", async () => {
  const selectedScope = planSelectedBusinessScope({ accounts: [{ id: "a1", status: "3", is_delete: "0" }],
    orders: [{ id: "o1", accounts_id: "a1", pay_is: "1" }], pays: [{ id: "p1", order_id: "o1", order_type: "1", pay_is: "1" }] });
  const options = { populationMode: "SELECTED_BUSINESS_SCOPE", selectedScope, selectedFixture: true };
  const noPolicy = await load({ ...options, refundPolicy: false });
  assert.match(noPolicy.error?.message ?? "", /LEGACY_REFUND_RELATIONSHIP_POLICY_REQUIRED/);
  assert.equal(noPolicy.scopeChecks.length, 0); assert.deepEqual(noPolicy.commands, []); assert.equal(noPolicy.directories.size, 0);
  const bad = await load({ ...options, selectedSourceMismatch: true });
  assert.match(bad.error?.message ?? "", /SELECTED_SCOPE_SOURCE_ORDER_DISPOSITION_MISMATCH/);
  assert.equal(bad.scopeChecks.length, 1);
  assert.deepEqual(bad.commands, []); assert.equal(bad.directories.size, 0); assert.equal(bad.state, null);
  const good = await load(options);
  assert.ifError(good.error); assert.equal(good.scopeChecks.length, 1);
  assert.equal(good.state.sourceScopeVerification.status, "SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN");
  const replay = await load({ ...options, previous: good });
  assert.ifError(replay.error); assert.equal(replay.scopeChecks.length, 1);
  const changed = { ...good, files: new Map(good.files) }, stored = JSON.parse(changed.files.get(checkpoint));
  stored.sourceScopeVerification.status = "ALTERED"; changed.files.set(checkpoint, JSON.stringify(stored));
  const rejected = await load({ ...options, previous: changed });
  assert.match(rejected.error?.message ?? "", /SELECTED_SCOPE_CHECKPOINT_CHANGED/);
  assert.deepEqual(rejected.commands, []);
});

test("strict run commits one batch without savepoints", async () => {
  const r = await load();
  assert.ifError(r.error);
  assert.equal(r.exit, undefined, JSON.stringify(r.logs));
  assert.deepEqual(r.commands.slice(3, 6), ["BEGIN", "SET CONSTRAINTS ALL IMMEDIATE", "COMMIT"]);
  assert.equal(r.state.phases.users.nextIndex, 2);
  assert.equal(r.state.rollbackConfirmed, true);
  assert.equal(JSON.parse(r.files.get(registry)).protectedDataset.bootstrapReservation, strictRoundReservation);
  const continued = await load({ previous: r });
  assert.ifError(continued.error);
  assert.equal(continued.exit, undefined);
  assert.equal(continued.state.phases.users.nextIndex, 2);
  assert.ok(!continued.commands.includes("COMMIT"));
});

test("strict loader preserves Unicode separators in prepared JSONL", async () => {
  const result = await load({ unicodeFirst: true });
  assert.ifError(result.error);assert.equal(result.exit,undefined);assert.ok(result.commands.includes("UNICODE_SOURCE_PRESERVED"));
});

test("new user import commits the identity subject and encrypted profile together", async () => {
  const result = await load({ verifiedFirst: true });
  assert.ifError(result.error); assert.equal(result.exit, undefined);
  const begin = result.commands.indexOf("BEGIN"), subject = result.commands.indexOf("SYNTHETIC_IDENTITY_SUBJECT"),
    profile = result.commands.indexOf("SYNTHETIC_IDENTITY_PROFILE"), commit = result.commands.indexOf("COMMIT");
  assert.ok(begin < subject && subject < profile && profile < commit);
  assert.equal(JSON.stringify(result.logs).includes("合成姓名"), false);
});

test("profile failure rolls back the user batch and a changed key cannot resume it", async () => {
  const failed = await load({ verifiedFirst: true, failure: "profile-rejected" });
  assert.equal(failed.exit, 1); assert.equal(failed.state.status, "FAILED_ROLLED_BACK");
  assert.ok(failed.commands.includes("ROLLBACK")); assert.equal(failed.commands.includes("COMMIT"), false);
  const original = await load({ verifiedFirst: true }); assert.ifError(original.error);
  const changed = await load({ previous: original, verifiedFirst: true, profileSecret: "another-profile-key" });
  assert.match(changed.error?.message ?? "", /CHECKPOINT_BINDING_CHANGED/);
  assert.deepEqual(changed.commands, []);
});

test("a fresh core import refuses an older dataset without identity profile coverage", async () => {
  const result = await load({ identityProfiles: false });
  assert.match(result.error?.message ?? "", /LEGACY_IDENTITY_PROFILE_SOURCE_REQUIRED/);
  assert.deepEqual(result.commands, []);
});

test("a checkpoint refuses another cluster even with the same database OID and nonce", async () => {
  const firstInstance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const first=await load({instance:firstInstance});assert.ifError(first.error);
  assert.deepEqual(first.state.binding.instance,firstInstance);
  const changed=JSON.parse(first.files.get(registry));changed.instance={...firstInstance,systemIdentifier:"456"};
  first.files.set(registry,JSON.stringify(changed));
  const resumed=await load({previous:first,instance:changed.instance});
  assert.match(resumed.error.message,/CHECKPOINT_BINDING_CHANGED/);assert.deepEqual(resumed.commands,[]);
});

test("a registered pending reset stops before any database connection", async () => {
  const result=await load({pendingReset:{oid:"42",at:"2026-11-06T00:00:00Z"}});
  assert.match(result.error.message,/^RES:/);assert.deepEqual(result.commands,[]);
});

test("direct loader refuses full captured source before database connection while selected and legacy plans remain compatible", async () => {
  // A full-source dataset that does not declare the bounded empty-coverage path stays refused before
  // any connection or output, and a scenario or legacy dataset keeps working.
  const full = await load({ populationMode: "FULL_CAPTURED_SOURCE" });
  assert.match(full.error.message, /FULL_CAPTURED_EXECUTION_REQUIRES_BOUNDED_EMPTY_COVERAGE/);
  assert.deepEqual(full.commands, []); assert.equal(full.state, null); assert.deepEqual([...full.directories], []);
  const selected = await load({ populationMode: "SCENARIO_SELECTION" });
  assert.ifError(selected.error); assert.ok(selected.commands.includes("COMMIT"));
  const legacy = await load(); assert.ifError(legacy.error); assert.ok(legacy.commands.includes("COMMIT"));
  const unknown = await load({ undeclaredPopulation: true }); assert.match(unknown.error.message, /UNDECLARED_POPULATION_EXECUTION_BLOCKED/); assert.deepEqual(unknown.commands, []);
  const invalid = await load({ populationMode: "UNKNOWN" }); assert.match(invalid.error.message, /UNDECLARED_POPULATION_EXECUTION_BLOCKED/); assert.deepEqual(invalid.commands, []);
  const badDigest = await load({ populationMode: "SCENARIO_SELECTION", invalidPopulationDigest: true }); assert.match(badDigest.error.message, /POPULATION_SCOPE_DIGEST_INVALID/); assert.deepEqual(badDigest.commands, []);
});

test("R06 strict reservation remains bound across checkpoint continuation", async () => {
  const reservation = { status: "ROUND06_BOOTSTRAP_RESERVED" };
  const first = await load({ reservation });
  assert.ifError(first.error);
  assert.equal(first.exit, undefined);
  assert.equal(JSON.parse(first.files.get(registry)).protectedDataset.bootstrapReservation, reservation.status);
  const continued = await load({ previous: first });
  assert.ifError(continued.error);
  assert.equal(continued.exit, undefined);
  assert.equal(JSON.parse(continued.files.get(registry)).protectedDataset.bootstrapReservation, reservation.status);
  assert.ok(!continued.commands.includes("COMMIT"));
});

test("R07 strict reservation remains R07 across checkpoint continuation", async () => {
  const reservation={status:"ROUND07_BOOTSTRAP_RESERVED"},instance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const first=await load({reservation,instance});assert.ifError(first.error);
  assert.equal(JSON.parse(first.files.get(registry)).protectedDataset.bootstrapReservation,reservation.status);
  const continued=await load({previous:first,instance});assert.ifError(continued.error);
  assert.equal(JSON.parse(continued.files.get(registry)).protectedDataset.bootstrapReservation,reservation.status);
});

test("R06 rejects ordinary mode, other-round markers and source or target drift before connecting", async () => {
  for (const options of [
    { strict: false, reservation: { status: "ROUND06_BOOTSTRAP_RESERVED" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", bootstrapReservation: strictRoundReservation } },
    { reservation: { status: strictRoundReservation, bootstrapReservation: "ROUND06_BOOTSTRAP_RESERVED" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", manifestSha256: "wrong" } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", epoch: { ...epoch, oid: "43" } } },
    { reservation: { status: "ROUND06_BOOTSTRAP_RESERVED", epoch: { ...epoch, nonce: "wrong" } } },
  ]) {
    const r = await load(options);
    assert.match(r.error.message, /CHECKPOINT_STRICT_BATCH_CHANGED|ROUND06_RESERVATION_CHANGED|STRICT_BATCH_REQUIRES_ROUND04/);
    assert.deepEqual(r.commands, []);
    assert.equal(r.directories.size, 0);
  }
});

test("strict rejection rolls back once and ordinary rejection still quarantines", async () => {
  const strict = await load({ failure: "rejected" });
  assert.equal(strict.state.status, "FAILED_ROLLED_BACK");
  assert.equal(strict.state.rollbackConfirmed, true);
  assert.equal(strict.state.pending, null);
  assert.equal(strict.state.phases.users.nextIndex, 0);
  assert.deepEqual(strict.commands.slice(3, 6), ["BEGIN", "ROLLBACK", "RELEASE_CLIENT"]);
  assert.equal(strict.events.find(e => e.event === "STRICT_ROW_REJECTED").index, 1);
  const ordinary = await load({ strict: false, failure: "rejected" });
  assert.equal(ordinary.exit, undefined);
  assert.ok(ordinary.commands.includes("ROLLBACK TO SAVEPOINT source_row"));
  assert.equal(ordinary.state.phases.users.quarantined, 1);
});

for (const [failure, status, stage, lastSql, errorMessage] of [
  ["lost-commit", "COMMIT_UNKNOWN", "COMMIT_UNKNOWN", "COMMIT", "original commit error"],
  ["lost-rollback", "ROLLBACK_UNKNOWN", "ROLLBACK_UNKNOWN", "ROLLBACK", "original rejection"],
  ["receipt", "RECEIPT_WRITE_FAILED_COMMITTED", "COMMIT_ACK_RECEIPT_FAILED", "COMMIT", "original disk error"],
]) test(`${failure} stops the whole run, destroys the client, and retains the exact pending batch`, async () => {
  const r = await load({ failure, exitAfterUsers: true });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.deepEqual(r.commands.slice(-5), [lastSql, "DESTROY_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
  assert.equal(r.state.status, status);
  assert.equal(r.state.error.message, errorMessage);
  assert.equal(r.state.rollbackConfirmed, false);
  assert.equal(r.state.checkpoints, 0);
  assert.equal(r.state.phases.users.nextIndex, 0);
  assert.deepEqual(Object.keys(r.state.phases), ["users"]);
  assert.deepEqual(r.state.pending, { domain: "users", start: 0, end: 2, sourceIds: ["101", "102"], phaseBodyDigest: sha(JSON.stringify(users)), stage });
  assert.ok(r.saves.every(saved => saved.phases.users?.nextIndex !== 2));
  const execute = await load({ previous: r });
  assert.match(execute.error.message, /PENDING_TRANSACTION_READ_ONLY_RECOVERY_REQUIRED/);
  assert.deepEqual(execute.commands, []);
  const recovery = await load({ previous: r, recover: true });
  assert.ifError(recovery.error);
  assert.equal(recovery.exit, undefined);
  assert.equal(recovery.files.get(checkpoint), r.files.get(checkpoint));
  assert.equal(recovery.files.get(registry), r.files.get(registry));
  assert.deepEqual(recovery.commands, ["LOCK", "RELEASE_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
  const receipt = JSON.parse([...recovery.files].find(([file]) => file.startsWith(path.join(out, "recovery-")))[1]);
  assert.deepEqual(receipt.pending, r.state.pending);
  assert.equal(receipt.knowledge, "EXACT_PENDING_KEYS_REQUIRE_INSPECTION");
});

test("direct strict load rejects reservation drift before creating output or connecting", async () => {
  for (const reservation of [{ status: "ROUND03_BOOTSTRAP_RESERVED" }, { manifestSha256: "wrong" }, { epoch: { ...epoch, oid: "43" } }, { epoch: { ...epoch, nonce: "wrong" } }]) {
    const r = await load({ reservation });
    assert.match(r.error.message, /STRICT_BATCH_REQUIRES_ROUND04/);
    assert.deepEqual(r.commands, []);
    assert.equal(r.directories.size, 0);
  }
});

test("ordinary financeEmptyCoverage rolls back the entire chunk on a conflict", async () => {
  const r = await load({ strict: false, failure: "empty-coverage" });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex, 0);
  assert.equal(r.state.phases.financeEmptyCoverage.quarantined, 0);
  assert.equal(r.state.pending, null);
  assert.ok(!r.commands.includes("ROLLBACK TO SAVEPOINT source_row"));
  assert.deepEqual(r.commands.slice(-7), ["BEGIN", "SAVEPOINT source_row", "ROLLBACK", "RELEASE_CLIENT", "POOL_END", "UNLOCK", "MAINTENANCE_END"]);
});

test("five proved-empty chunks roll back together when a later chunk is rejected", async () => {
  const r=await load({failure:"empty-coverage-batch"});
  assert.ifError(r.error);assert.equal(r.exit,1);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,0);
  assert.equal(r.state.pending,null);
  assert.equal(r.events.some(e=>e.domain==="financeEmptyCoverage"&&e.event==="COMMIT_ACK"),false);
  assert.equal(r.state.status,"FAILED_ROLLED_BACK");
});

test("five proved-empty chunks use one acknowledged transaction and retain each chunk outcome", async () => {
  const r=await load({failure:"empty-coverage-success"});
  assert.ifError(r.error);assert.equal(r.exit,undefined);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,5);
  assert.equal(r.state.phases.financeEmptyCoverage.created,5);
  assert.equal(r.events.filter(e=>e.domain==="financeEmptyCoverage"&&e.event==="COMMIT_ACK").length,1);
});

test("unknown coverage commit keeps all five original chunk keys and stops", async () => {
  const r=await load({failure:"empty-coverage-unknown"});
  assert.ifError(r.error);assert.equal(r.exit,1);
  assert.equal(r.state.status,"COMMIT_UNKNOWN");
  assert.deepEqual(r.state.pending.sourceIds,["chunk-0","chunk-1","chunk-2","chunk-3","chunk-4"]);
  assert.equal(r.state.phases.financeEmptyCoverage.nextIndex,0);
});

async function round({ reservationStatus = strictRoundReservation, action = "execute", drift, strict = true, bootstrapDrift, missingBootstrap = false, withGrowth = false, artifactFault, separateBossBinding = false, resumeCase, dependencyDrift, sourceToolDrift = false, instance = null, registryProfile = null, v2Capture = false, sameOutputStopped = false, sameOutputStages = [{ name: "core-and-funds", status: "INTENT" }], sameOutputArtifacts = [], identityProfiles = true, legalInput = true, selectedPopulation = false, selectedSourceMismatch = false, refundMismatch = false, refundPolicy = true, openingStats = {}, displayCoverage = true, packedPreflight = false, distributionInvalid = false, inspectPreflight = false, inlineGrowth = false, inlineLogInvalid = false } = {}) {
  const files = new Map(), directories = [], spawns = [], logs = [], reads = [], liveCommands = [], logOpens = [], scopeChecks = [];
  const targetSchema = reservationStatus === "ROUND06_BOOTSTRAP_RESERVED" ? ["1", "2", "3", "4", "5"].map(x => x.repeat(64)) : schema;
  const cohort = resumeCase === "bad-package" || selectedPopulation ? 1 : 0;
  const put = (file, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    files.set(file, bytes);
    return { path: file, sha256: sha(bytes) };
  };
  const pinned = (name, data, filename = "manifest.json") => {
    const directory = path.join(restricted, name);
    return { ...put(path.join(directory, filename), data), path: directory };
  };
  const selectedData = { users: [{ id: "u1" }], accounts: [{ id: "a1", status: "3", is_delete: "0", user_id: "u1", no: "a1" }], orders: [{ id: "o1", accounts_id: "a1", pay_is: "1", user_id: "u1", order_sn: "order-o1" }],
    pays: [{ id: "p1", order_id: "o1", order_type: "1", pay_is: "1" }], refunds: [{ id: "r1", user_id: "u1", order_type: "order", order_id: "o1", order_sn: "order-o1" }] };
  const source = pinned("source", { status: "CAPTURED_READ_ONLY", ...(v2Capture?{sourceOrigin:{schema:'zzsh.local-source-origin.v2'}}:{}), ...((selectedPopulation || packedPreflight) ? { rollbackConfirmed: true, clientClosed: true,
    files: { ...(selectedPopulation ? Object.fromEntries(Object.entries(selectedData).map(([name, rows]) => [name, { file: "source-" + name, rows: rows.length }])) : {}),
      ...(packedPreflight ? { distributionConfig: { file: "config", rows: 1, sha256: "a".repeat(64) }, distributionLevels: { file: "levels", rows: 1, sha256: "b".repeat(64) } } : {}) } } : {}) }, "receipt.json");
  const supplement = { sourceSupplement: { baseReceiptSha256: source.sha256 } };
  const selectedScope = selectedPopulation ? planSelectedBusinessScope(selectedData) : null;
  const population = selectedScope ? summarizePopulationScope(selectedData, "SELECTED_BUSINESS_SCOPE", selectedScopeFilter(selectedScope), source.sha256) : null;
  const preparationTools = Object.fromEntries(["prepare-local-dataset.mjs", "local-source-adapter.mjs", "local-source-scenarios.mjs", "selected-business-scope.mjs"].map(name => [name, sha("fixture-tool")]));
  preparationTools["business-reference-readiness.mjs"] = sha(readFileSync(new URL("./business-reference-readiness.mjs", import.meta.url)));
  if (packedPreflight) { preparationTools["local-growth-packages.mjs"] = sha("fixture-tool"); preparationTools["local-distribution-qualification-plan.mjs"] = sha("fixture-tool"); }
  const dataset = pinned("dataset", { sourceReceiptSha256: source.sha256, sourceCutoff: "2026-01-01T00:00:00.000Z", scenarioSelection: { schema: "zzsh.source-scenarios.v1" },
    toolFiles: { ...preparationTools, ...(sourceToolDrift ? { "selected-business-scope.mjs": "f".repeat(64) } : {}) },
    ...(selectedScope ? { selectedScope, selectedScopeSha256: selectedScopeDigest(selectedScope), population, populationSha256: sha(JSON.stringify(population)),
      files: { users: { file: "target-users" }, accounts: { file: "target-accounts" }, orders: { file: "target-orders" }, quarantine: { file: "quarantine" } } } : {}),
    ...(!resumeCase && identityProfiles ? { identityProfiles: { schema: "zzsh.legacy-identity-profile-source.v1", verified: 0, ready: 0, invalid: 0 } } : {}),
    ...(!resumeCase && refundPolicy ? { refundRelationshipPolicy: LEGACY_REFUND_RELATIONSHIP_POLICY } : {}),
    storedBalanceTotals: { mappedEarningsCents: "0" },
    domains: { accounts: { source: cohort, ready: cohort, isolated: 0 }, users: { source: cohort, ready: cohort, isolated: 0 }, orders: { source: cohort, ready: cohort, isolated: 0 }, continuations: { parameterComplete: 0 } } });
  const pathSourcePlan = pinned("paths-source", {}, "receipt.json");
  const apiDist = "C:\\project\\dist", buildFiles = {};
  for (const file of ["database/business-migrations.js", "supply/legacy-user-migration.js", "legacy-load/legacy-account-seam.js", "order/legacy-order-read.js", "finance/personal-finance-maintenance.js", "legacy-load/legacy-path-records.js", "legal/legal-documents.js", "auth/security-core.js", "supply/content-hash.js", "supply/supply-util.js"]) buildFiles[file] = put(path.join(apiDist, file), {}).sha256;
  if (packedPreflight) buildFiles["finance/distribution-policy-change.js"] = put(path.join(apiDist, "finance/distribution-policy-change.js"), {}).sha256;
  if (inlineGrowth) buildFiles["auth/membership-growth-legacy-cli.js"] = put(path.join(apiDist, "auth/membership-growth-legacy-cli.js"), {}).sha256;
  const secretRoot = "E:\\zzsh\\zzsh\\apps\\api\\.secrets";
  const target = { ...epoch, database: "zzsh_test_regression", ...(instance?{instance}:{}) }, marker = "zzsh:regression-test:v1";
  const bundle = put(path.join(restricted, "bundle.json"), { moduleSha256: "c".repeat(64), entries: Object.entries(buildFiles).map(([file, digest]) => ({ path: "api-build/src/" + file, sha256: bootstrapDrift === "bundle" ? "2".repeat(64) : digest })) });
  const runtime = put(path.join(restricted, "runtime.json"), { resource: { ...target, ...(bootstrapDrift === "runtime" ? { oid: "43" } : {}), marker, migrationRoleOid: "91" },
    actualResource: { ...target, marker, migration_role_oid: "91", read_only: "on" }, formalAppMounted: true,
    identitySubjectKeySha256: sha(JSON.stringify("fixture")), legacyIdentityProfileKeySha256: bootstrapDrift === "identity-profile" ? "0".repeat(64) : sha(JSON.stringify("fixture-profile")),
    copyManifestSha256: bundle.sha256, moduleSha256: "c".repeat(64), compiledRoot: apiDist });
  const bossOrigin = put(path.join(restricted, "boss-runtime.json"), { resource: { database: target.database, resourceOid: bootstrapDrift === "boss-origin" ? "43" : epoch.oid },
    initialization: { nonce: epoch.nonce, imProvisioner: false, imIdentityRepository: false, imAppId: null } });
  const admin = stage => {
    const prior = stage === "bosses" && separateBossBinding;
    const ref = put(path.join(restricted, stage + ".json"), { stage, status: "FORMAL_INITIALIZATION_COMPLETED", target: bootstrapDrift === stage ? { ...target, oid: "43" } : target,
      serverBindingSha256: prior ? bossOrigin.sha256 : runtime.sha256, finalReadbackRollbackAck: true, maintenanceClosed: true, unlock: true, oldAdminRowsImported: false });
    return prior ? { ...ref, serverBinding: bossOrigin } : ref;
  };
  const policyId = "growth-policy-1", effectiveAt = "2026-01-01T00:00:00.000Z", approvalId = "approval-1";
  const legal = !resumeCase && legalInput ? put(path.join(restricted, "legal-input.json"), { schema: "zzsh.legal-initial-source.v1", effectiveAt,
    terms: { sha256: "a".repeat(64) }, privacy: { sha256: "b".repeat(64) },
    build: Object.fromEntries(["legal/legal-documents.js", "auth/security-core.js", "supply/content-hash.js", "supply/supply-util.js"].map(file => [file, bootstrapDrift === "legal-build" ? "0".repeat(64) : buildFiles[file]])) }) : null;
  const referenceTables = BUSINESS_REFERENCE_TABLES.map(table => ({ table, rows: 1, inserted: true, exact: 1, baselineTimestampOnly: 0 }));
  if (bootstrapDrift === "reference-table-missing") referenceTables.pop();
  if (bootstrapDrift === "reference-table-mismatch") referenceTables[0].exact = 0;
  if (bootstrapDrift === "reference-table-duplicate") referenceTables[0] = referenceTables[1];
  const rentalReference = { status: "SOURCE_RENTAL_REFERENCE_CHECKED", gameCode: "delta", termOptions: 1, enabledItems: 1,
    fullPayout: "REFERENCE_CHECKED", tableCounts: Object.fromEntries(RENTAL_REFERENCE_TABLES.map(name => [name, bootstrapDrift === "reference-count-mismatch" && name === "price_line" ? 2 : 1])),
    targetDigest: "a".repeat(64), validatorSha256: bootstrapDrift === "reference-validator" ? "0".repeat(64) : preparationTools["business-reference-readiness.mjs"] };
  const evidence = { runtime, bundle, swap: put(path.join(restricted, "swap.json"), { ...epoch, ...(instance?{instance}:{}), ...(bootstrapDrift === "swap" ? { oid: "43" } : {}), status: "COMMIT_ACK" }),
    schema: put(path.join(restricted, "schema.json"), reservationStatus === "ROUND06_BOOTSTRAP_RESERVED"
      ? { ...epoch, ...(instance?{instance}:{}), status: "FINAL_SCHEMA_0157_VERIFIED", target: { ...target, database: "zzsh_test_round06_stage", marker: "zzsh:round06-schema-build:v1", migrationRoleOid: "91" },
        hashes: bootstrapDrift === "schema" ? ["2".repeat(64)] : targetSchema, finalOrdinal: 157, commitAck: true, migrationExit: { code: 0, signal: null },
        readbackRollbackAck: true, readbackClientClosed: true, unlockAck: true, maintenanceClosed: true, journalSha256: "a".repeat(64), historySha256: "b".repeat(64) }
      : { ...epoch, ...(instance?{instance}:{}), status: "CLEAN_SCHEMA_INSTALLED", hashes: bootstrapDrift === "schema" ? ["2".repeat(64)] : targetSchema,
        ...(reservationStatus === "ROUND07_BOOTSTRAP_RESERVED" ? {finalOrdinal:160,commitAck:true,migrationAck:true,readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true,journalSha256:'a'.repeat(64),historySha256:'b'.repeat(64)} : {}) }),
    administrators: [admin("bosses"), admin("staff")], business: put(path.join(restricted, "business.json"), { ...epoch, ...(instance?{instance}:{}), ...(bootstrapDrift === "business" ? { oid: "43" } : {}), status: "REFERENCE_BOOTSTRAP_COMMITTED", manifestSha256: "d".repeat(64), tables: legal ? referenceTables : [{}], commitAck: true, maintenanceClosed: true, poolClosed: true, unlock: true, maintenanceAdminId: "test-user", catalogModel: bootstrapDrift === "catalog" ? undefined : "OWNER_KIND_V2",
      ...(legal ? { sourceIdsPreserved: bootstrapDrift !== "reference-source-changed", sourceRawUnchanged: true, pending: bootstrapDrift === "reference-pending" ? [{}] : [], rentalReference: bootstrapDrift === "reference-missing" ? undefined : rentalReference } : {}),
      ...(legal ? { legal: { status: "INITIALIZED", inputSha256: bootstrapDrift === "legal" ? "0".repeat(64) : legal.sha256, effectiveAt,
        terms: { sourceSha256: "a".repeat(64), digest: "c".repeat(64) }, privacy: { sourceSha256: "b".repeat(64), digest: "d".repeat(64) } } } : {}) }),
    readback: put(path.join(restricted, "bootstrap-readback.json"), { identity: { ...target, ...(bootstrapDrift === "readback" ? { oid: "43" } : {}), marker, read_only: "on" }, rollbackAck: true, clientClosed: true, admins: { allActive: true, twoFactor: true, onlyNewUids: true, oldSessions: 0, count: 4 },
      policy: { id: bootstrapDrift === "policy" ? "old-policy" : policyId, status: "APPROVED", effectiveAtUtc: effectiveAt, effectiveNow: true, newApprovalRequestId: approvalId, requestStatus: "EXECUTED", decision: "APPROVED", executionStatus: "SUCCEEDED", onlyNewBossRelations: true } }),
    policy: put(path.join(restricted, "policy.json"), { status: "FORMAL_LOCAL_POLICY_INITIALIZED", executionStatus: "SUCCEEDED", oldApprovalsCopied: false, approvalRequestId: approvalId, policyId, effectiveAtUtc: effectiveAt }) };
  const inputBody = {
    schema: "zzsh.local-round.v1", window: resumeCase ? { notBefore: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } : window,
    credentials, target: { ...epoch, ...(instance?{instance}:{}), bootstrapReservation: ["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(reservationStatus) ? reservationStatus : strictRoundReservation, schemaHashes: targetSchema, migrationRoleOid: "91" },
    out, apiDist, buildFiles, strictBatch: strict, dataset, source, pathSourcePlan, ...(legal ? { legal } : {}),
    paths: pinned("paths", { sourcePlanReceiptSha256: pathSourcePlan.sha256, datasetSha256: dataset.sha256, accounts: cohort }, "receipt.json"),
    display: pinned("display", { datasetSha256: dataset.sha256, rows: cohort, notDisplayable: 0,
      ...(displayCoverage?{accountBaseRatio:{scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',known:cohort,unknown:0},accountFullPayout:{scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',selected:0,unselected:cohort,unknown:0}}:{}) }),
    openings: pinned("opening", { datasetSha256: dataset.sha256, stats: { subjects: cohort, candidate: cohort, reviewRequired: 0, positiveSource: 0, candidatePositive: 0,
      sourceAvailableCents: "0", candidateAvailableCents: "0", reviewAvailableCents: "0", ...openingStats } }),
    funds: pinned("funds", supplement, "receipt.json"), refundAttempts: pinned("refund", supplement, "receipt.json"), dictionary: pinned("dictionary", {}, "receipt.json"),
    actor: put(path.join(restricted, "actor.json"), { id: "test-user", sessionId: "test-session", resourceOid: epoch.oid, nonce: epoch.nonce }),
    secrets: { databaseMaintenance: put(path.join(secretRoot, "db"), "fixture"), identitySubjectHmac: put(path.join(secretRoot, "hmac"), "fixture"),
      ...(!resumeCase ? { identityProfile: put(path.join(secretRoot, "profile"), "fixture-profile") } : {}) },
    ...(withGrowth || resumeCase ? { growth: { policyId, policyEffectiveAt: effectiveAt, approvedBy: "Root", approvalRef: "ROOT-FIXTURE-GROWTH", attempt: 1, ...(packedPreflight ? {packageLayout:'PACKED_V2'} : {}), ...(inlineGrowth ? {approvalLayout:'INLINE_INTENT_V1'} : {}) } } : {}),
    ...(missingBootstrap ? {} : { bootstrapEvidence: evidence }),
  };
  if (["ROUND06_BOOTSTRAP_RESERVED","ROUND07_BOOTSTRAP_RESERVED"].includes(reservationStatus) && dependencyDrift !== "missing") inputBody.dependencyBinding = {
    buildManifest: put(path.join(restricted, "dependency-build.json"), {}), sourceManifest: put(path.join(restricted, "dependency-source.json"), {}), sourceSnapshot: "C:\\fixture",
    proof: put(path.join(restricted, "dependency-proof.json"), { status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", entrypoints: 32, closureFiles: [["fixture", "a".repeat(64)]], closureSha256: "c".repeat(64) }) };
  let oldCheckpointPath, oldCheckpointBytes, oldReceiptRef, oldOut;
  if (resumeCase) {
    oldOut = path.join(restricted, "original-round");
    const oldWindow = { notBefore: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T01:00:00.000Z" };
    const oldActor = put(path.join(restricted, "old-actor.json"), { id: "test-user", sessionId: "old-session", resourceOid: epoch.oid, nonce: epoch.nonce });
    const oldBody = { ...inputBody, out: oldOut, actor: oldActor, window: oldWindow };
    const oldInput = put(path.join(restricted, "original-input.json"), oldBody);
    const oldReceipt = put(path.join(oldOut, resumeCase === "fabricated-receipt" ? "round-receipt-resumed.json" : "round-receipt.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: oldInput.sha256,
      datasetSha256: dataset.sha256, target: inputBody.target, strictBatch: strict, status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS",
      stages: [{ name: "opening", status: "INTENT", code: 1, signal: null }, ...(resumeCase === "prior-growth-stage" ? [{ name: "growth-apply", status: "INTENT" }] : [])] });
    oldReceiptRef = oldReceipt;
    const phaseNames = ["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"];
    const oldCheckpoint = { schema: "zzsh.local-legacy-load.v1", binding: { ...epoch, database: "zzsh_test_regression", datasetSha256: dataset.sha256, actorId: "test-user", sessionId: "old-session" },
      strictBatch: strict, schemaHashes: schema, executionWindow: oldWindow, status: resumeCase === "unknown" ? "COMMIT_UNKNOWN" : "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED",
      pending: resumeCase === "unknown" ? { stage: "COMMIT_UNKNOWN" } : null, poolClosed: true, unlock: true, maintenanceClosed: true, rollbackConfirmed: true,
      phases: Object.fromEntries(phaseNames.map(name => [name, { complete: name !== (resumeCase === "missing-phase" ? "storedOpening" : ""), quarantined: 0, nextIndex: ["users", "accounts", "orders", "accountDisplay", "storedOpening", "skinHoldings"].includes(name) ? cohort : 0 }])), skinHoldingsPreparation: { ready: cohort, isolated: 0 } };
    oldCheckpointPath = path.join(oldOut, "loader", "checkpoint.json");
    const oldCheckpointRef = put(oldCheckpointPath, oldCheckpoint); oldCheckpointBytes = Buffer.from(files.get(oldCheckpointPath));
    inputBody.resume = { schema: "zzsh.local-round-growth-resume.v1", previousInput: oldInput, previousReceipt: oldReceipt, checkpoint: oldCheckpointRef };
    if (resumeCase === "different-source") inputBody.resume.previousInput.sha256 = "f".repeat(64);
    put(credentials, { database: "zzsh_test_regression", migration: { name: "fixture_m", oid: "91", password: "fixture" } });
  }
  const input = put(path.join(restricted, "round-input.json"), inputBody);
  let sameOutputReceipt;
  if (sameOutputStopped) {
    sameOutputReceipt = put(path.join(out, "round-receipt.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: input.sha256, status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS", stages: sameOutputStages });
    files.set(path.join(out, "core-and-funds.stdout.log"), Buffer.from("old stdout"));
    files.set(path.join(out, "core-and-funds.stderr.log"), Buffer.from("old stderr"));
    for (const name of sameOutputArtifacts) files.set(path.join(out, name), Buffer.from("old " + name));
  }
  put(registry, { ...epoch, ...(instance?{instance}:{}), ...(registryProfile?{migrationProfile:registryProfile}:{}), database: "zzsh_test_regression", marker: "zzsh:regression-test:v1", roles: { migration: { name: "fixture_m", oid: "91" }, runtime: { name: "fixture_r", oid: "92" } },
    ...(resumeCase ? { protectedDataset: { status: "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", manifestSha256: dataset.sha256, epoch, report: oldCheckpointPath } }
      : reservationStatus ? { protectedDataset: { status: reservationStatus, manifestSha256: dataset.sha256, epoch, ...drift } } : {}) });
  const attemptPath = path.join(restricted, `growth-resume-attempt-${epoch.oid}-${epoch.nonce}.json`);
  if (resumeCase === "prior-attempt") files.set(attemptPath, Buffer.from("{}"));
  if (bootstrapDrift === "digest") files.set(evidence.business.path, Buffer.from("{}"));
  const proc = { env: {}, execPath: "node", exit() { throw "EXIT"; }, argv: ["node", "script", "--" + action, "--input", input.path, "--input-sha", input.sha256] };
  if (action === "inspect-receipt") {
    if (inspectPreflight) for (const file of ["loader/checkpoint.json", "readback.json", "growth-plan/manifest.json", "growth-plan/summary.json", "growth-execution/summary.json", "growth-readback/summary.json"]) put(path.join(out, ...file.split("/")), {});
    if (inspectPreflight && inlineGrowth) { put(path.join(out, 'growth-execution', 'summary.json'), { approvalLog: { sha256: 'f'.repeat(64) } }); put(path.join(out, 'growth-execution', 'events.jsonl'), 'synthetic-log'); }
    const stageFiles = { readback: 'readback.json', 'growth-prepare': 'growth-plan/summary.json', 'growth-apply': 'growth-execution/summary.json', 'growth-readback': 'growth-readback/summary.json' };
    const stages = inspectPreflight && inlineGrowth ? Object.entries(stageFiles).map(([name,file]) => ({ name, status: 'ACK', metrics: { evidenceSha256: sha(files.get(path.join(out, ...file.split('/')))) } })) : [];
    const original = put(path.join(out, "round-receipt-resumed.json"), { schema: "zzsh.local-round-receipt.v1", inputSha256: input.sha256,
      datasetSha256: dataset.sha256, target: epoch, strictBatch: strict, status: "DATASET_STAGES_ACK_READBACK_PASS", stages,
      ...(inspectPreflight ? { toolFiles: preparationTools, distributionSourcePreflight: {
        status: 'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN', sourceReceiptSha256: source.sha256,
        configurationSha256: 'a'.repeat(64), levelsSha256: 'b'.repeat(64), configurationRows: 1, sourceLevels: 1,
        activeLevels: 1, settlementDelayDays: 7, policyDigest: 'c'.repeat(64), connections: 0, targetWrites: 0,
        validatorSha256: preparationTools['local-distribution-qualification-plan.mjs'], policyParserSha256: buildFiles['finance/distribution-policy-change.js'],
        ...(inlineGrowth ? { growthCommitGuardSha256: buildFiles['auth/membership-growth-legacy-cli.js'] } : {}) } } : {}) });
    proc.argv.push("--receipt", original.path, "--receipt-sha", original.sha256);
  }
  const brokenPath = artifactFault ? path.join(out, ...artifactFault.file.split("/")) : null;
  if (brokenPath) files.set(brokenPath, Buffer.from(artifactFault.kind === "null" ? "null" : artifactFault.kind === "array" ? "[]" : artifactFault.kind === "object" ? "{}" : "{"));
  let attemptFile;
  const context = {
    ...path, assert, createHash, isRoundReceiptPath, isStrictRoundReservation, matchesLoadReservation, strictRoundReservation,
    assertSameDirectoryResumeSafe,
    inspectRoundResumeOutput: directory => directory === oldOut && oldReceiptRef ? { sequence: 1, previousReceipt: oldReceiptRef } : directory === out && sameOutputReceipt ? { sequence: 1, previousReceipt: sameOutputReceipt, stageNames: sameOutputStages.map(stage => stage.name) } : null,
    reserveRoundResumeOutput: directory => { const attempt = path.join(directory, "round-attempt-000001"); directories.push(attempt); return attempt; },
    assertRoundBootstrap, assertRoundLegalBootstrap, assertRoundIdentityKeyBinding, assertRoundOpeningPartition, assertRoundPreparationTools, assertRoundSourceOrigin, assessRoundEvidence: inspectPreflight ? () => ({ status: 'COMPLETE', dataset: 'PASS', growth: 'PASS', issues: [] }) : assessRoundEvidence, compactEmptyCoverageReadbackMatches, legacyListedProofVersion, legacyListedTargetMatches, assertGrowthPlanEvidence, assertGrowthPackages, assertResumeLineage, verifyResumeSchema, assessResumeStages, assertNoWriteRetryLineage, assertRoundPopulationBinding, assertFullExecutionAdmitted, assertNextBusinessPopulation, expectedContinuationImports, LEGACY_REFUND_RELATIONSHIP_POLICY, assertDisplayCaptureCoverage,
    verifyDisplayCaptureInputs:async()=>({status:'SOURCE_DISPLAY_CAPTURE_VERIFIED_TARGET_NOT_RUN',displayRows:cohort,sourceConnections:0,targetConnections:0,targetWrites:0}),
    digestInlineGrowthLog:async()=>inlineLogInvalid?'0'.repeat(64):'f'.repeat(64),
    requiresInvitationCountClosure, process: proc, moduleUrl: "file:///C:/project/scripts/migration/run-local-round.mjs",
    verifySelectedPopulationFiles: async args => {
      scopeChecks.push({ datasetDir: args.datasetDir, sourceDir: args.sourceDir });
      const rows = { "source-users": selectedData.users, "source-accounts": selectedData.accounts, "source-orders": selectedData.orders,
        "source-refunds": refundMismatch ? [{ ...selectedData.refunds[0], order_sn: "different" }] : selectedData.refunds,
        "source-pays": selectedSourceMismatch ? [{ ...selectedData.pays[0], pay_is: "0" }] : selectedData.pays,
        "target-users": [{ sourceId: "u1" }], "target-accounts": [{ sourceId: "a1", ownerLegacyId: "u1", sourceStatus: "3", sourceDeleted: false, businessNo: "a1", snapshot: null }], "target-orders": [{ sourceId: "o1" }], quarantine: [] };
      return verifySelectedPopulationFiles({ ...args, readRows: async (_dir, meta, visit) => { for (const row of rows[meta.file] ?? []) visit(row); } });
    },
    targetConnection, assertCaptureTargetProfile, assertNextMigrationWriteReady, NEXT_MIGRATION_PROFILE, sameMigrationProfile, loadRegisteredTarget: credentialPath => { const file = path.join(path.dirname(credentialPath), "resource.json"); return normalizeRegisteredTarget(JSON.parse(String(files.get(file))), file); },
    assertNextSourceTools,
    inspectRoundDependencyLayout: () => ({ sourceRoot: "C:\\fixture", scriptDir: "C:\\fixture\\scripts\\migration", moduleDirs: ["C:\\fixture\\node_modules"], ...(packedPreflight?{extraEntrypoints:['finance/distribution-policy-change']}:{}), scriptFiles: dependencyDrift === "reference-not-sealed" ? Object.fromEntries(Object.entries(preparationTools).filter(([name]) => name !== "business-reference-readiness.mjs")) : preparationTools }),
    assertRoundDependencyProof: () => { if (dependencyDrift === "proof") throw Error("ROUND_DEPENDENCY_PROOF_CHANGED"); },
    assertBoundRunnerScripts: () => { if (dependencyDrift === "runner") throw Error("ROUND_DEPENDENCY_RUNNER_CHANGED"); },
    verifyRoundDistributionSource: async({input,source,layout})=>{
      if(distributionInvalid)throw Error('DISTRIBUTION_PREFLIGHT_SOURCE_REQUIRED');
      return {status:'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN',sourceReceiptSha256:input.source.sha256,
        configurationSha256:source.files.distributionConfig.sha256,levelsSha256:source.files.distributionLevels.sha256,
        configurationRows:1,sourceLevels:1,activeLevels:1,settlementDelayDays:7,policyDigest:'c'.repeat(64),connections:0,targetWrites:0,
        validatorSha256:layout.scriptFiles['local-distribution-qualification-plan.mjs'],policyParserSha256:input.buildFiles['finance/distribution-policy-change.js'],
        ...(inlineGrowth?{growthCommitGuardSha256:input.buildFiles['auth/membership-growth-legacy-cli.js']}:{})};
    },
    probeRoundDependencies: () => ({ closureSha256: dependencyDrift === "closure" ? "d".repeat(64) : "c".repeat(64), entrypoints: 32 }),
    fileURLToPath: url => path.normalize(String(url).slice("file:///".length)),
    createRequire: () => Object.assign(() => ({ canonicalize:JSON.stringify, parseDistributionPolicyChange:value=>value, Client: class { async connect() { liveCommands.push("connect"); } async query(sql) {
      liveCommands.push(sql); if (sql.startsWith("SELECT current_database")) return { rows: [{ database: "zzsh_test_regression", ...epoch,
        ...(resumeCase === "schema-target-drift" ? { oid: "43" } : {}), owner: "zzsh", marker, role: "fixture_m", role_oid: "91", read_only: "on", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }] };
      if (sql.startsWith("SELECT hash")) return { rows: (resumeCase.startsWith("schema-drift") ? ["3".repeat(64)] : schema).map(hash => ({ hash })) };
      if (sql === "ROLLBACK" && resumeCase.endsWith("rollback-fail")) throw Error("fixture rollback failure");
      return { command: sql }; } async end() { liveCommands.push("end"); if (resumeCase === "schema-close-fail") throw Error("fixture close failure"); } } }), {cache:{}}),
    lstatSync: file => {
      if (sameOutputStopped && path.dirname(file) === out && ["path-execution", "readback.json", "growth-plan", "growth-execution", "growth-readback", "readback-final.json"].includes(path.basename(file)) && !files.has(file)) throw Object.assign(Error("missing fixture output"), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => false };
    }, existsSync: file => files.has(file), mkdirSync: file => directories.push(file),
    readFileSync(file) { reads.push(file); if (file === brokenPath && artifactFault.kind === "read-error") throw Object.assign(Error("original artifact read failure"), { code: "EIO" }); return files.get(file) ?? Buffer.from("fixture-tool"); }, readdirSync: () => Object.keys(buildFiles),
    spawnSync: () => ({ stdout: "S-1-5-21-1", status: 0 }),
    spawn(_node, args) {
      spawns.push(args);
      let exit = 1;
      if (resumeCase && !["readback-fail", "schema-drift", "schema-target-drift", "schema-drift-rollback-fail", "schema-rollback-fail", "schema-close-fail", "unknown", "missing-phase", "different-source"].includes(resumeCase)) {
        const scriptName = args[0], outputPath = args[args.indexOf("--out") + 1];
        if (scriptName.endsWith("readback-local-dataset.mjs")) {
          if (!(resumeCase === "final-readback-fail" && outputPath.endsWith("readback-final.json"))) {
            put(outputPath, { schema: "zzsh.local-dataset-readback.v1", resource: { ...epoch, database: "zzsh_test_regression" }, sourceDatasetSha256: dataset.sha256,
              status: "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED", differenceCount: 0, targetWrites: 0, rollbackConfirmed: true, lockReleased: true, connectionsClosed: true,
              domains: { users: { expected: cohort }, accounts: { expected: cohort }, orders: { expected: cohort } },
              display: { expected: cohort, matched: cohort }, openings: { expected: cohort, matched: cohort }, holdings: { expected: cohort, matched: cohort }, paths: { expected: cohort, matched: cohort } });
            if (resumeCase === "checkpoint-drift") files.set(oldCheckpointPath, Buffer.from("{}"));
            if (resumeCase === "before-corrupt" && outputPath.endsWith("readback-final.json")) files.set(path.join(out, "readback.json"), Buffer.from("{}"));
            if (resumeCase === "summary-drift" && outputPath.endsWith("readback-final.json")) {
              const file = path.join(out, "growth-execution", "summary.json"), value = JSON.parse(files.get(file)); value.extra = "changed"; put(file, value);
            }
            exit = 0;
          }
        } else if (scriptName.endsWith("run-local-growth.mjs")) {
          const shared = { ...epoch, inputSha256: input.sha256, datasetSha256: dataset.sha256 };
          const growthSummary = { users: cohort, orders: cohort, complete: cohort, pending: 0, contributions: 0 };
          if (args.includes("--prepare") && resumeCase !== "growth-prepare-fail") {
            const sorted = Object.fromEntries(Object.entries(buildFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
            const packages = cohort ? [{ file: "packages/00001.json", userId: "user-1", executionKey: "key-1", sha256: sha("correct"), coverageFingerprint: "4".repeat(64), coverageState: "COMPLETE", contributionCount: 0 }] : [];
            if (cohort) files.set(path.join(outputPath, "packages/00001.json"), Buffer.from("changed"));
            const manifest = put(path.join(outputPath, "manifest.json"), { ...epoch, schema: "zzsh.local-growth-round-plan.v1", status: "PREPARED_NOT_APPLIED",
              datasetSha256: dataset.sha256, policy: { id: resumeCase === "growth-prepare-bad-manifest" ? "old-policy" : policyId, effectiveAt }, cutoff: "2026-01-01T00:00:00.000000Z", buildDigest: sha(JSON.stringify(sorted)), packages, summary: growthSummary });
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--prepare", status: "PREPARED_NOT_APPLIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, manifestSha256: manifest.sha256, summary: growthSummary }); exit = 0;
          } else if (args.includes("--apply")) {
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--apply", status: "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED", manifestSha256: args[args.indexOf("--manifest-sha") + 1], poolClosed: true, unlockAck: true, lockClosed: true, completed: 0, inserted: 0, replayed: 0, complete: 0, partial: 0, pending: null, fundsWrites: 0 }); exit = 0;
          } else if (args.includes("--readback")) {
            put(path.join(outputPath, "summary.json"), { ...shared, mode: "--readback", status: "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED", manifestSha256: args[args.indexOf("--manifest-sha") + 1], readOnlyRollbackAck: true, readOnlyClientClosed: true, fundsWrites: 0, summary: { coverage: 0, contributions: 0, complete: 0, pending: 0 } }); exit = 0;
          }
        }
      }
      return { once(event, callback) { if (event === "close") callback(exit, null); } };
    },
    openSync(file, flags) {
      if (file === attemptPath) {
        if (resumeCase === "reservation-race" || files.has(file)) throw Object.assign(Error("already exists"), { code: "EEXIST" });
        attemptFile = file; files.set(file, Buffer.alloc(0)); return 9;
      }
      logOpens.push({ file, flags });
      return 1;
    },
    writeFileSync(fd, bytes) { if (fd === 9) files.set(attemptFile, Buffer.from(bytes)); },
    fsyncSync(fd) { if (fd === 9 && resumeCase === "reservation-fsync-fail") throw Error("fixture marker fsync failure"); },
    closeSync() {}, writeLoadCheckpoint: put, console: { log: value => logs.push(JSON.parse(value)) },
  };
  let error;
  try { await new AsyncFunction(...Object.keys(context), script("run-local-round.mjs"))(...Object.values(context)); }
  catch (cause) { if (cause !== "EXIT") error = cause; }
  const inspectCurrent = async () => {
    const receiptPath = path.join(out, "round-receipt.json"), bytes = files.get(receiptPath);
    proc.argv = ["node", "script", "--inspect-receipt", "--input", input.path, "--input-sha", input.sha256, "--receipt", receiptPath, "--receipt-sha", sha(bytes)];
    delete proc.exitCode;
    const start = logs.length;
    let inspectError;
    try { await new AsyncFunction(...Object.keys(context), script("run-local-round.mjs"))(...Object.values(context)); }
    catch (cause) { if (cause !== "EXIT") inspectError = cause; }
    return { error: inspectError, exit: proc.exitCode, report: logs[start] };
  };
  return { directories, error, exit: proc.exitCode, logs, reads, spawns, liveCommands, logOpens, scopeChecks, oldCheckpointUnchanged: oldCheckpointPath ? Buffer.compare(oldCheckpointBytes, files.get(oldCheckpointPath)) === 0 : undefined,
    receipt: files.get(path.join(out, ...(sameOutputStopped ? ["round-attempt-000001"] : []), "round-receipt.json")),
    omitReceiptPopulation: () => { const file = path.join(out, "round-receipt.json"), value = JSON.parse(String(files.get(file))); delete value.population; files.set(file, Buffer.from(JSON.stringify(value))); },
    sameOutputOriginal: sameOutputReceipt && { receipt: files.get(sameOutputReceipt.path), sha256: sameOutputReceipt.sha256, stdout: files.get(path.join(out, "core-and-funds.stdout.log")), stderr: files.get(path.join(out, "core-and-funds.stderr.log")), artifacts: Object.fromEntries(sameOutputArtifacts.map(name => [name, files.get(path.join(out, name))])) },
    attemptPresent: files.has(attemptPath), inspectCurrent };
}

test("round validation and execution require the exact strict reservation before output", async () => {
  for (const invalid of [{ reservationStatus: null }, { reservationStatus: "ROUND03_BOOTSTRAP_RESERVED" }, { drift: { manifestSha256: "wrong" } }, { drift: { epoch: { ...epoch, oid: "43" } } }, { drift: { epoch: { ...epoch, nonce: "wrong" } } }]) {
    const r = await round(invalid);
    assert.match(r.error.message, /STRICT_BATCH_REQUIRES_REGISTERED_ROUND|FRESH_REGISTERED_RESOURCE/);
    assert.deepEqual(r.directories, []);
    assert.deepEqual(r.spawns, []);
  }
  for (const options of [{ action: "validate" }, { action: "validate", strict: false, reservationStatus: null }]) {
    const valid = await round(options);
    assert.ifError(valid.error);
    assert.equal(valid.logs[0].status, "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");
    assert.deepEqual(valid.directories, []);
    assert.deepEqual(valid.spawns, []);
  }
});

test("prewrite retry preserves original input and demands independently confirmed zero writes", () => {
  const originalInput = { schema: "zzsh.local-round.v1", out: "original", target: { oid: "42", nonce: "nonce" }, actor: { sha256: "actor" }, window: { expiresAt: "original" } };
  const input = { ...originalInput, out: "retry", retryEvidence: { schema: "zzsh.local-round-no-write-retry.v1", originalInput: { sha256: "a" }, originalReceipt: { sha256: "b" } } };
  const originalReceipt = { inputSha256: "a", status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS", stages: [{ name: "core-and-funds", status: "INTENT", code: 1 }], toolFiles: { "load-local-dataset.mjs": "loader" } };
  const audit = { status: "NO_WRITES_CONFIRMED_FOR_FAILED_ATTEMPT", originalReceiptSha256: "b", loaderSha256: "loader", moduleFailureBeforeCredentialAndPool: true,
    loaderDirectoryCreated: false, targetWrites: 0, rollbackAck: true, clientClosed: true, unlockAck: true, maintenanceClosed: true,
    counts: Object.fromEntries(["legacy_users", "legacy_accounts", "legacy_orders", "finance_observations", "opening_basis", "ledger_entries", "economic_roots", "growth_coverage"].map(key => [key, 0])) };
  assert.equal(assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit }).status, "ORIGINAL_PREWRITE_FAILURE_CONFIRMED");
  for (const change of [{ input: { ...input, actor: { sha256: "different" } } }, { audit: { ...audit, counts: { ...audit.counts, legacy_users: 1 } } },
    { audit: { ...audit, unlockAck: false } }, { originalReceipt: { ...originalReceipt, stages: [{ name: "core-and-funds", status: "ACK", code: 0 }] } }])
    assert.throws(() => assertNoWriteRetryLineage({ input, originalInput, originalReceipt, audit, ...change }), /ROUND_NO_WRITE_RETRY_LINEAGE_CHANGED/);
});

test("R06 round validation accepts its exact reservation and rejects target or source drift", async () => {
  const valid = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate" });
  assert.ifError(valid.error);
  assert.equal(valid.logs[0].status, "SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");
  assert.deepEqual(valid.spawns, []);
  const nonStrict = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", strict: false });
  assert.match(nonStrict.error.message, /ROUND06_STRICT_BATCH_REQUIRED/);
  assert.deepEqual(nonStrict.spawns, []);
  const wrongSchema = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", bootstrapDrift: "schema" });
  assert.match(wrongSchema.error.message, /ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:schema/);
  for (const dependencyDrift of ["missing", "proof", "runner", "closure"]) {
    const invalid = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", action: "validate", dependencyDrift });
    assert.match(invalid.error.message, /ROUND_DEPENDENCY_(BINDING_REQUIRED|PROOF_CHANGED|RUNNER_CHANGED|CLOSURE_CHANGED)/);
    assert.deepEqual(invalid.spawns, []);
  }
  for (const drift of [{ manifestSha256: "wrong" }, { epoch: { ...epoch, oid: "43" } }, { epoch: { ...epoch, nonce: "wrong" } }]) {
    const r = await round({ reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", drift, action: "validate" });
    assert.match(r.error.message, /FRESH_REGISTERED_RESOURCE/);
    assert.deepEqual(r.spawns, []);
  }
});

test("R07 fresh-schema inputs require the same isolated instance and dependency closure", async () => {
  const instance={host:"127.0.0.1",port:55433,systemIdentifier:"123"};
  const valid=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance});
  assert.ifError(valid.error);assert.equal(valid.logs[0].status,"SEALED_INPUTS_VALIDATED_TARGET_NOT_RUN");assert.deepEqual(valid.spawns,[]);
  const noDependencies=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance,dependencyDrift:"missing"});
  assert.match(noDependencies.error.message,/ROUND_DEPENDENCY_BINDING_REQUIRED/);assert.deepEqual(noDependencies.spawns,[]);
  const missingReference=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance,dependencyDrift:"reference-not-sealed"});
  assert.match(missingReference.error.message,/ROUND_RENTAL_REFERENCE_VALIDATOR_NOT_SEALED/);assert.deepEqual(missingReference.spawns,[]);assert.deepEqual(missingReference.directories,[]);
  for(const action of ["validate","execute"]){
    const wrongPreparation=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action,instance,sourceToolDrift:true});
    assert.match(wrongPreparation.error.message,/ROUND_PREPARATION_TOOL_CHANGED/);assert.deepEqual(wrongPreparation.spawns,[]);
    assert.deepEqual(wrongPreparation.directories,[]);assert.deepEqual(wrongPreparation.liveCommands,[]);assert.ok(!wrongPreparation.reads.includes(credentials));
  }
  const nonStrict=await round({reservationStatus:"ROUND07_BOOTSTRAP_RESERVED",action:"validate",instance,strict:false});
  assert.match(nonStrict.error.message,/ROUND07_STRICT_BATCH_REQUIRED/);assert.deepEqual(nonStrict.spawns,[]);
});

test('new rounds validate distribution policy source before creating output or starting a writer',async()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'};
 const options={reservationStatus:'ROUND06_BOOTSTRAP_RESERVED',instance,withGrowth:true,packedPreflight:true};
 const valid=await round({...options,action:'validate'});
 assert.ifError(valid.error);assert.equal(valid.logs[0].distributionSourcePreflight.status,'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN');
 assert.deepEqual(valid.spawns,[]);assert.deepEqual(valid.liveCommands,[]);
 const invalid=await round({...options,action:'execute',distributionInvalid:true});
 assert.match(invalid.error.message,/DISTRIBUTION_PREFLIGHT_SOURCE_REQUIRED/);
 assert.deepEqual(invalid.spawns,[]);assert.deepEqual(invalid.directories,[]);assert.deepEqual(invalid.liveCommands,[]);
});

test("round stops at a failed loader and never spawns later stages", async () => {
  const r = await round();
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.spawns.length, 1);
  assert.ok(r.spawns[0].includes("--strict-round-batch"));
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(receipt.failure.stage, "core-and-funds");
  assert.equal(receipt.completion.status, "INCOMPLETE");
  assert.equal(receipt.completion.growth, "NOT_PLANNED");
});

test("same-directory recovery keeps the prior receipt and writes exclusive attempt logs", async () => {
  const result = await round({ sameOutputStopped: true });
  assert.ifError(result.error);
  assert.equal(result.exit, 1);
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
  assert.equal(result.sameOutputOriginal.stdout.toString(), "old stdout");
  assert.equal(result.sameOutputOriginal.stderr.toString(), "old stderr");
  const resumed = JSON.parse(result.receipt);
  assert.equal(resumed.sameDirectoryResume.previousReceipt.sha256, result.sameOutputOriginal.sha256);
  assert.equal(resumed.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(result.logOpens.length, 2);
  assert.ok(result.logOpens.every(item => item.flags === "wx" && item.file.includes("round-attempt-000001")));
});

test("same-directory recovery stops before any spawn after paths and readback succeeded and growth failed", async () => {
  const stages = ["core-and-funds", "display", "opening", "holdings", "paths", "readback"].map(name => ({ name, status: "ACK" }));
  stages.push({ name: "growth-prepare", status: "INTENT" });
  const result = await round({ sameOutputStopped: true, sameOutputStages: stages, sameOutputArtifacts: ["path-execution", "readback.json", "growth-plan"] });
  assert.match(result.error.message, /ROUND_SAME_OUTPUT_STAGE_REQUIRES_SEPARATE_RECOVERY/);
  assert.deepEqual(result.spawns, []);
  assert.deepEqual(result.directories, []);
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
  assert.equal(result.sameOutputOriginal.artifacts["readback.json"].toString(), "old readback.json");
  assert.equal(result.sameOutputOriginal.artifacts["path-execution"].toString(), "old path-execution");
  assert.equal(result.sameOutputOriginal.stdout.toString(), "old stdout");
});

test("same-directory recovery refuses an existing later-stage artifact even if the receipt has no later stage", async () => {
  const result = await round({ sameOutputStopped: true, sameOutputArtifacts: ["readback.json"] });
  assert.match(result.error.message, /ROUND_SAME_OUTPUT_ARTIFACT_REQUIRES_SEPARATE_RECOVERY:readback\.json/);
  assert.deepEqual(result.spawns, []);
  assert.deepEqual(result.directories, []);
  assert.equal(result.sameOutputOriginal.artifacts["readback.json"].toString(), "old readback.json");
  assert.equal(sha(result.sameOutputOriginal.receipt), result.sameOutputOriginal.sha256);
});

test("next target cannot be disguised as an old input profile or reservation",async()=>{
  const instance={host:'127.0.0.1',port:55435,systemIdentifier:'12345'};
  const result=await round({action:'validate',reservationStatus:'ROUND07_BOOTSTRAP_RESERVED',instance,registryProfile:'LOCAL_MIGRATION_NEXT_V1'});
  assert.match(result.error?.message??'',/ROUND_REGISTERED_PROFILE_CHANGED/);assert.deepEqual(result.spawns,[]);assert.deepEqual(result.directories,[]);
  assert.throws(()=>assertRoundBootstrap({target:{migrationProfile:'LOCAL_MIGRATION_NEXT_V1',bootstrapReservation:'ROUND04_BOOTSTRAP_RESERVED'}},null,{}),/ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:schema/);
  const target={oid:'123',nonce:'a'.repeat(24),instance,bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'};
  const resource={...target,database:'zzsh_test_regression',migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};
  assert.throws(()=>assertRoundBootstrap({target,bootstrapEvidence:{}},null,{runtime:{resource,actualResource:resource}}),/ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:runtime-profile/);
});

test("receipt inspection rejects a new capture disguised as the old profile",async()=>{
  const result=await round({action:'inspect-receipt',inspectPreflight:true,v2Capture:true});
  assert.ifError(result.error);assert.equal(result.logs[0].status,'INCOMPLETE');assert.ok(result.logs[0].issues.includes('ROUND_SOURCE_RESTORE_PROOF_UNCONFIRMED'));
  assert.deepEqual(result.spawns,[]);assert.deepEqual(result.directories,[]);
});

test("missing or cross-target bootstrap evidence stops before output and execution", async () => {
  for (const options of [{ missingBootstrap: true }, ...["runtime", "swap", "schema", "staff", "bosses", "business", "readback", "bundle", "digest"].map(bootstrapDrift => ({ bootstrapDrift })), { bootstrapDrift: "policy", withGrowth: true }, { bootstrapDrift: "boss-origin", separateBossBinding: true }]) {
    const r = await round(options);
    assert.match(r.error.message, /ROUND_BOOTSTRAP_EVIDENCE_REQUIRED|ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH|ROUND_INPUT_SHA_MISMATCH/);
    assert.deepEqual(r.directories, []);
    assert.deepEqual(r.spawns, []);
  }
  const valid = await round({ action: "validate", withGrowth: true });
  assert.ifError(valid.error);
  assert.equal(valid.logs[0].growthPlanned, true);
  const reuseBoss = await round({ action: "validate", separateBossBinding: true });
  assert.ifError(reuseBoss.error);
  assert.equal(reuseBoss.logs[0].bootstrapEvidence.status, "TARGET_BOUND_BOOTSTRAP_EVIDENCE_VERIFIED");
  const wrongLegal = await round({ bootstrapDrift: "legal" });
  assert.match(wrongLegal.error.message, /ROUND_LEGAL_BOOTSTRAP_UNCONFIRMED/);
  assert.deepEqual(wrongLegal.spawns, []);
  assert.deepEqual(wrongLegal.directories, []);
  const wrongCatalog = await round({ bootstrapDrift: "catalog" });
  assert.match(wrongCatalog.error.message, /ROUND_CATALOG_BOOTSTRAP_UNCONFIRMED/);
  assert.deepEqual(wrongCatalog.spawns, []); assert.deepEqual(wrongCatalog.directories, []);
  const wrongLegalBuild = await round({ bootstrapDrift: "legal-build" });
  assert.match(wrongLegalBuild.error.message, /ROUND_LEGAL_BUILD_CHANGED/);
  assert.deepEqual(wrongLegalBuild.spawns, []);
  const wrongIdentityRuntime = await round({ bootstrapDrift: "identity-profile" });
  assert.match(wrongIdentityRuntime.error.message, /ROUND_IDENTITY_BOOTSTRAP_UNCONFIRMED/);
  assert.deepEqual(wrongIdentityRuntime.spawns, []);
  assert.deepEqual(wrongIdentityRuntime.directories, []);
  for (const bootstrapDrift of ["reference-missing", "reference-table-missing", "reference-table-mismatch", "reference-table-duplicate", "reference-count-mismatch", "reference-source-changed", "reference-pending", "reference-validator"]) {
    const result = await round({ bootstrapDrift });
    assert.match(result.error?.message ?? "", /ROUND_RENTAL_REFERENCE_(UNCONFIRMED|VALIDATOR_CHANGED)/);
    assert.deepEqual(result.spawns, []); assert.deepEqual(result.directories, []);
  }
});

test("fresh-round validation and execution require identity and legal evidence before any writes", async () => {
  for (const action of ["validate", "execute"]) {
    for (const [options, expected] of [
      [{ identityProfiles: false }, /ROUND_IDENTITY_PROFILE_SOURCE_REQUIRED/],
      [{ legalInput: false }, /ROUND_LEGAL_INPUT_REQUIRED/],
      [{ refundPolicy: false }, /ROUND_REFUND_RELATIONSHIP_POLICY_REQUIRED/],
    ]) {
      const result = await round({ action, ...options });
      assert.match(result.error?.message ?? "", expected);
      assert.deepEqual(result.spawns, []);
      assert.deepEqual(result.directories, []);
      assert.ok(!result.reads.includes(credentials));
    }
  }
});

test('a fresh round refuses a display package missing source ratio or full-payout coverage before any write',async()=>{
 const result=await round({action:'validate',displayCoverage:false});
 assert.match(result.error.message,/DISPLAY_CAPTURE_COVERAGE_REQUIRED/);assert.deepEqual(result.directories,[]);assert.deepEqual(result.spawns,[]);
});

test("fresh selected rounds independently check the source before credentials or output", async () => {
  for (const action of ["validate", "execute"]) {
    const bad = await round({ action, selectedPopulation: true, selectedSourceMismatch: true });
    assert.match(bad.error?.message ?? "", /SELECTED_SCOPE_SOURCE_ORDER_DISPOSITION_MISMATCH/);
    assert.equal(bad.scopeChecks.length, 1);
    assert.deepEqual(bad.spawns, []);
    assert.deepEqual(bad.directories, []);
    assert.deepEqual(bad.liveCommands, []);
    assert.ok(!bad.reads.includes(credentials));
  }
  const good = await round({ action: "validate", selectedPopulation: true });
  assert.ifError(good.error);
  assert.equal(good.scopeChecks.length, 1);
  assert.equal(good.logs[0].population.sourceVerification.status, "SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN");
  assert.equal(good.logs[0].population.sourceVerification.orders.retained, 1);
  assert.equal(good.logs[0].externalReadiness.status, "NOT_ASSESSED_BY_ROUND");
  const unresolved = await round({ action: "validate", selectedPopulation: true, refundMismatch: true });
  assert.ifError(unresolved.error);
  assert.equal(unresolved.logs[0].externalReadiness.refundRelationships.status, "REVIEW_REQUIRED");
  assert.equal(unresolved.logs[0].externalReadiness.refundRelationships.relationshipUnresolved, 1);
});

test("inspection rechecks fresh selected source evidence and rejects a receipt without it", async () => {
  const execution = await round({ selectedPopulation: true });
  assert.equal(execution.scopeChecks.length, 1);
  const inspected = await execution.inspectCurrent();
  assert.ifError(inspected.error);
  assert.equal(execution.scopeChecks.length, 2);
  assert.equal(inspected.report.assessmentScope, "DATASET_AND_GROWTH");
  assert.equal(inspected.report.externalReadiness.status, "NOT_ASSESSED_BY_ROUND");
  assert.ok(inspected.report.externalReadiness.checks.includes("distribution-policy-and-qualification"));
  assert.ok(!inspected.report.issues.includes("ROUND_POPULATION_SCOPE_UNCONFIRMED"));
  execution.omitReceiptPopulation();
  const missing = await execution.inspectCurrent();
  assert.ifError(missing.error);
  assert.ok(missing.report.issues.includes("ROUND_POPULATION_SCOPE_UNCONFIRMED"));
});

test("fresh round validates and reports the stored-opening partition without treating review as zero", async () => {
  for (const action of ["validate", "execute"]) {
    const incomplete = await round({ action, selectedPopulation: true, openingStats: { candidate: 0, reviewRequired: 0 } });
    assert.match(incomplete.error?.message ?? "", /ROUND_OPENING_PARTITION_INCOMPLETE/);
    assert.deepEqual(incomplete.spawns, []); assert.deepEqual(incomplete.directories, []); assert.deepEqual(incomplete.liveCommands, []);
    const badAmount = await round({ action, selectedPopulation: true, openingStats: { sourceAvailableCents: "1" } });
    assert.match(badAmount.error?.message ?? "", /ROUND_OPENING_PARTITION_INCOMPLETE/);
    assert.deepEqual(badAmount.spawns, []); assert.deepEqual(badAmount.directories, []);
  }
  const pending = await round({ action: "validate", selectedPopulation: true, openingStats: { candidate: 0, reviewRequired: 1 } });
  assert.ifError(pending.error);
  assert.deepEqual(pending.logs[0].externalReadiness.storedOpening, { status: "REVIEW_REQUIRED", subjects: 1, candidate: 0, reviewRequired: 1, reviewAvailableCents: "0" });
});

test("stored-opening partition keeps positive review amounts and rejects a changed total", () => {
  const dataset = { domains: { users: { ready: 2 } }, storedBalanceTotals: { mappedEarningsCents: "100" } };
  const stats = { subjects: 2, candidate: 1, reviewRequired: 1, positiveSource: 2, candidatePositive: 1,
    sourceAvailableCents: "100", candidateAvailableCents: "60", reviewAvailableCents: "40" };
  assert.equal(assertRoundOpeningPartition(dataset, { stats }).reviewAvailableCents, "40");
  assert.throws(() => assertRoundOpeningPartition(dataset, { stats: { ...stats, candidateAvailableCents: "61" } }), /ROUND_OPENING_PARTITION_INCOMPLETE/);
  assert.throws(() => assertRoundOpeningPartition(dataset, { stats: { ...stats, reviewAvailableCents: "-1" } }), /ROUND_OPENING_PARTITION_INCOMPLETE/);
  assert.throws(() => assertRoundOpeningPartition(dataset, { stats: { ...stats, positiveSource: 1, candidatePositive: 1 } }), /ROUND_OPENING_PARTITION_INCOMPLETE/);
});

function completedEvidence() {
  const inputSha256 = "e".repeat(64), datasetSha = "f".repeat(64), manifestSha = "1".repeat(64);
  const target = { ...epoch, schemaHashes: schema };
  const input = { target, dataset: { sha256: datasetSha }, window, strictBatch: true, buildFiles: { "one.js": "2".repeat(64) },
    growth: { policyId: "policy-1", policyEffectiveAt: "2026-01-01T00:00:00.000Z" } };
  const actorProof = { id: "test-user", sessionId: "test-session" };
  const dataset = { sourceCutoff: "2026-01-01T00:00:00.000Z", domains: { users: { ready: 2 }, accounts: { ready: 2 }, orders: { ready: 2 }, continuations: { parameterComplete: 1 } } };
  const expected = { dataset, display: { rows: 2 }, openings: { stats: { candidate: 2 } }, paths: { accounts: 2 } };
  const names = ["core-and-funds", "display", "opening", "holdings", "paths", "readback", "growth-prepare", "growth-apply", "growth-readback"];
  const receipt = { schema: "zzsh.local-round-receipt.v1", inputSha256, datasetSha256: datasetSha, target, strictBatch: true,
    status: "DATASET_AND_GROWTH_ACK_READBACK_PASS", stages: names.map(name => ({ name, status: "ACK", code: 0, signal: null, metrics: {} })) };
  const phases = Object.fromEntries(["users", "accounts", "orders", "invitationFacts", "financeHistory", "financeEmptyCoverage", "guaranteeHistory", "continuationEvidence", "liabilityDuties", "completedCommissions", "accountDisplay", "storedOpening", "skinHoldings"].map(name => [name, { complete: true, quarantined: 0, nextIndex: 2 }]));
  phases.continuationEvidence.nextIndex = 1;
  const checkpoint = { schema: "zzsh.local-legacy-load.v1", binding: { ...epoch, database: "zzsh_test_regression", datasetSha256: datasetSha, actorId: actorProof.id, sessionId: actorProof.sessionId },
    strictBatch: true, schemaHashes: schema, executionWindow: window, pending: null, status: "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", phases, poolClosed: true, unlock: true, maintenanceClosed: true, rollbackConfirmed: true,
    skinHoldingsPreparation: { ready: 2, isolated: 0 } };
  const readback = { schema: "zzsh.local-dataset-readback.v1", resource: { ...epoch, database: "zzsh_test_regression" }, sourceDatasetSha256: datasetSha,
    status: "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED", differenceCount: 0, targetWrites: 0, rollbackConfirmed: true, lockReleased: true, connectionsClosed: true,
    domains: { users: { expected: 2 }, accounts: { expected: 2 }, orders: { expected: 2 } },
    display: { expected: 2, matched: 2 }, openings: { expected: 2, matched: 2 }, holdings: { expected: 2, matched: 2 }, paths: { expected: 2, matched: 2 } };
  const summary = { users: 2, orders: 2, complete: 1, pending: 1, contributions: 3 };
  const shared = { ...epoch, inputSha256, datasetSha256: datasetSha, manifestSha256: manifestSha };
  const growth = { manifestSha256: manifestSha,
    prepare: { ...shared, mode: "--prepare", status: "PREPARED_NOT_APPLIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, summary },
    manifest: { ...epoch, schema: "zzsh.local-growth-round-plan.v1", status: "PREPARED_NOT_APPLIED", datasetSha256: datasetSha, policy: { id: "policy-1", effectiveAt: input.growth.policyEffectiveAt }, cutoff: "2026-01-01T00:00:00.000000Z", buildDigest: sha(JSON.stringify(input.buildFiles)), packages: [
      { file: "packages/00001.json", userId: "user-1", executionKey: "key-1", sha256: "3".repeat(64), coverageFingerprint: "4".repeat(64), coverageState: "COMPLETE", contributionCount: 2 },
      { file: "packages/00002.json", userId: "user-2", executionKey: "key-2", sha256: "5".repeat(64), coverageFingerprint: "6".repeat(64), coverageState: "BACKFILL_PENDING", contributionCount: 1 },
    ], summary },
    apply: { ...shared, mode: "--apply", status: "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED", poolClosed: true, unlockAck: true, lockClosed: true, completed: 2, inserted: 3, replayed: 0, complete: 1, partial: 1, pending: null, fundsWrites: 0 },
    readback: { ...shared, mode: "--readback", status: "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED", readOnlyRollbackAck: true, readOnlyClientClosed: true, fundsWrites: 0,
      summary: { coverage: 2, contributions: 3, complete: 1, pending: 1 } } };
  return { input, inputSha256, actorProof, receipt, checkpoint, readback, expected, growth };
}

test("full completion requires actual stage acknowledgements, target checkpoints and independent growth readback", () => {
  const data = completedEvidence();
  assert.deepEqual(assessRoundEvidence(data), { status: "COMPLETE", dataset: "PASS", growth: "PASS", issues: [] });
  const cases = [
    ["ROUND_STAGE_NOT_ACKNOWLEDGED:opening", d => { d.receipt.stages[2].status = "INTENT"; d.receipt.stages[2].code = 1; }],
    ["ROUND_STAGE_NOT_ACKNOWLEDGED:paths", d => { delete d.receipt.stages[4].code; }],
    ["ROUND_PHASE_INCOMPLETE:storedOpening", d => { d.checkpoint.phases.storedOpening.complete = false; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.pending = { stage: "COMMIT_UNKNOWN" }; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.status = "UNKNOWN_STATUS"; }],
    ["ROUND_CHECKPOINT_UNCONFIRMED", d => { d.checkpoint.schemaHashes = ["3".repeat(64)]; }],
    ["ROUND_DATASET_READBACK_UNCONFIRMED", d => { d.readback.resource.oid = "43"; }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifestSha256 = "2".repeat(64); }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.buildDigest = "3".repeat(64); }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.cutoff = "2026-02-01T00:00:00.000000Z"; }],
    ["ROUND_GROWTH_PREPARE_UNCONFIRMED", d => { d.growth.manifest.packages[1].executionKey = "key-1"; }],
    ["ROUND_GROWTH_APPLY_UNCONFIRMED", d => { d.growth.apply.completed = 1; }],
    ["ROUND_GROWTH_READBACK_UNCONFIRMED", d => { d.growth.readback = null; }],
    ["ROUND_STAGE_ORDER_INVALID:growth-prepare", d => { const s = d.receipt.stages.splice(6, 1)[0]; d.receipt.stages.splice(0, 0, s); }],
  ];
  for (const [issue, change] of cases) {
    const d = structuredClone(data); change(d);
    const result = assessRoundEvidence(d);
    assert.equal(result.status, "INCOMPLETE", issue);
    assert.ok(result.issues.includes(issue), `${issue}: ${result.issues}`);
  }
});

test('next-profile completion requires checkpoint fence release and fenced readback', () => {
  const data = completedEvidence(), migrationProfile = 'LOCAL_MIGRATION_NEXT_V1';
  const instance = { host:'127.0.0.1', port:55435, systemIdentifier:'12345' };
  Object.assign(data.expected.dataset,{population:{mode:'SELECTED_BUSINESS_SCOPE'},files:{continuations:{rows:1},'invitation-facts':{rows:0}},invitationFacts:{subjects:2,codes:2,selectedSubjects:2,packets:0,selectedPackets:0,financialEffects:false,policy:null}});
  Object.assign(data.expected.dataset.domains.users,{source:2,isolated:0});
  Object.assign(data.expected.dataset.domains.accounts,{source:2,isolated:0});
  Object.assign(data.expected.dataset.domains.orders,{source:2,isolated:0});
  Object.assign(data.expected.dataset.domains.continuations,{source:1,isolated:0,unsupportedStatuses:{'2':0,'6':0,'7':0},preparedEvidence:{policy:'PRESERVE_SOURCE_ADMISSION_V1',commissionPolicy:'ACTIVE_OR_SETTLED_SOURCE_V1',readyComplete:1,readyIsolated:0,readyUnprepared:0,unreadyEmitted:0,unreadyUnprepared:0}});
  data.expected.dataset.domains.liabilities={source:2};
  data.checkpoint.quarantine=[];data.checkpoint.fundsSupplement={pendingCommissionCoverage:{completedDutyCandidates:2,continuationEvidence:0}};
  data.checkpoint.sourceScopeVerification={continuationSource:{orders:1},liabilitySource:{total:2},continuationCommissions:{total:0,pending:0,settled:0,void:0,unknown:0,softDeletedSettled:0}};
  data.checkpoint.phases.invitationFacts.nextIndex=0;data.checkpoint.phases.invitationCounts={complete:true,quarantined:0,nextIndex:0};
  data.readback.invitationFacts={childCountClosure:{status:'VERIFIED',packets:0,auditsMatched:0,subjects:2,matched:2,known:2,unknown:0}};
  data.expected.display.accountBaseRatio={scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',known:2,unknown:0};
  data.readback.display.accountBaseRatio={...data.expected.display.accountBaseRatio,status:'VERIFIED',expected:2,matched:2};
  data.expected.display.accountFullPayout={scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',selected:1,unselected:1,unknown:0};
  data.readback.display.accountFullPayout={...data.expected.display.accountFullPayout,status:'VERIFIED',expected:2,matched:2};
  Object.assign(data.input.target, { migrationProfile, instance });
  Object.assign(data.receipt.target, { migrationProfile, instance });
  Object.assign(data.checkpoint.binding, { migrationProfile, instance });
  Object.assign(data.readback.resource, { migrationProfile, instance });
  for (const name of ['prepare','manifest','apply','readback']) Object.assign(data.growth[name], { instance, migrationProfile });
  data.checkpoint.targetFenceReleased = true; data.checkpoint.protectionRecorded = true;
  data.readback.targetFence = 'HELD_UNTIL_ROLLBACK';
  data.checkpoint.generatedPhases={financeEmptyCoverage:{schema:'zzsh.empty-coverage-chunks.v1',receiptMode:'BATCH_V2',rows:2,chunks:[{},{}]}};
  data.readback.emptyFinancialCoverage={sourceRebuilt:true,expected:2,readable:2,actual:2,chunks:2,batchProof:{mode:'BATCH_V2',expected:2,matched:2}};
  Object.assign(data.receipt.stages.find(stage=>stage.name==='paths').metrics,{targetFence:'HELD_ACROSS_BATCHES',targetFenceReleased:true});
  for (const name of ['prepare','readback']) Object.assign(data.growth[name], { readOnlyFence:'HELD_UNTIL_ROLLBACK', readOnlyMaintenanceUnlock:true, readOnlyMaintenanceClosed:true });
  Object.assign(data.growth.apply, { targetFence:'HELD_ACROSS_BATCHES', targetFenceReleased:true });
  const listed=structuredClone(data),empty=sha(''),one=sha('listed-1');
  listed.input.source={sha256:'a'.repeat(64)};
  Object.assign(listed.expected.dataset,{sourceReceiptSha256:listed.input.source.sha256,gameBindings:{'1':'delta'}});
  listed.expected.dataset.files.accounts={sha256:'b'.repeat(64)};
  listed.expected.source={files:{accounts:{sha256:'c'.repeat(64)},games:{sha256:'d'.repeat(64)}}};
  const source={schema:'zzsh.legacy-listed-source-scope.v2',scope:'ALL_CAPTURED_GAMES',status:'SOURCE_PARTITION_VERIFIED_TARGET_NOT_RUN',
    sourceCount:1,readyWithSnapshot:1,readyWithoutSnapshot:0,isolated:0,
    sourceIdsSha256:one,readyMappedIdsSha256:one,readyWithSnapshotIdsSha256:one,readyWithoutSnapshotIdsSha256:empty,isolatedIdsSha256:empty,
    binding:{sourceReceiptSha256:listed.input.source.sha256,sourceAccountsSha256:'c'.repeat(64),sourceGamesSha256:'d'.repeat(64),
      datasetAccountsSha256:'b'.repeat(64),gameBindingsSha256:sha(JSON.stringify(listed.expected.dataset.gameBindings)),gameBindingStatus:'VERIFIED'},
    delta:{sourceCount:1,readyWithSnapshot:1,readyWithoutSnapshot:0,isolated:0,sourceIdsSha256:one,readyMappedIdsSha256:one,readyWithSnapshotIdsSha256:one,
      readyWithoutSnapshotIdsSha256:empty,isolatedIdsSha256:empty,status:'SOURCE_PARTITION_VERIFIED_TARGET_NOT_RUN'},
    otherGames:{sourceCount:0,sourceIdsSha256:empty,readyWithoutSnapshot:0,readyWithoutSnapshotIdsSha256:empty,isolated:0,isolatedIdsSha256:empty},
    unknownGame:{sourceCount:0,sourceIdsSha256:empty,readyWithoutSnapshot:0,readyWithoutSnapshotIdsSha256:empty,isolated:0,isolatedIdsSha256:empty}};
  listed.checkpoint.sourceScopeVerification.legacyListed=source;
  listed.readback.legacyListedSource=source;listed.readback.legacyListedSourceOrigin='CHECKPOINT_BOUND_V2';
  listed.readback.legacyListedTarget={status:'MAPPED_HISTORICAL_NOT_PUBLISHED',scope:'MAPPED_DELTA_ACCOUNT_FACTS_ONLY',marketAndDirectOrder:'NOT_ASSESSED',
    sourceProofSha256:sha(JSON.stringify(source)),expectedMapped:1,verifiedMapped:1,missingTarget:0,missingSnapshot:0,published:0,
    expectedMappedIdsSha256:one,verifiedMappedIdsSha256:one,missingTargetIdsSha256:empty,missingSnapshotIdsSha256:empty,publishedIdsSha256:empty};
  Object.assign(data,listed);
  const result = assessRoundEvidence(data); assert.equal(result.status, 'COMPLETE', result.issues.join(','));
  for (const domain of ['liabilityDuties','completedCommissions']) {
    const isolated=structuredClone(data);isolated.checkpoint.quarantine.push({domain,sourceId:'source-1',code:'REVIEW_REQUIRED'});
    assert(assessRoundEvidence(isolated).issues.includes('ROUND_LEGACY_FINANCE_ASSEMBLY_REQUIRES_REVIEW'));
  }
  for (const domain of ['users','accounts','orders']) {
    const isolated=structuredClone(data);isolated.expected.dataset.domains[domain].isolated=1;
    assert(assessRoundEvidence(isolated).issues.includes('ROUND_SELECTED_BUSINESS_REQUIRES_REVIEW'));
  }
  const unsupported=structuredClone(data);unsupported.expected.dataset.domains.continuations.unsupportedStatuses['6']=1;
  assert(assessRoundEvidence(unsupported).issues.includes('ROUND_LEGACY_CONTINUATION_MANUAL_REVIEW'));
  const isolatedContinuation=structuredClone(data);isolatedContinuation.expected.dataset.domains.continuations.preparedEvidence.readyIsolated=1;
  assert(assessRoundEvidence(isolatedContinuation).issues.includes('ROUND_LEGACY_CONTINUATION_MANUAL_REVIEW'));
  const settled=structuredClone(data);Object.assign(settled.checkpoint.sourceScopeVerification.continuationCommissions,{total:1,settled:1});
  assert(assessRoundEvidence(settled).issues.includes('ROUND_LEGACY_COMMISSION_MANUAL_REVIEW'));
  const missingProof=structuredClone(data);delete missingProof.checkpoint.sourceScopeVerification.liabilitySource;
  assert(assessRoundEvidence(missingProof).issues.includes('ROUND_LEGACY_FINANCE_SOURCE_PROOF_UNCONFIRMED'));
  for (const change of [d=>{delete d.checkpoint.quarantine;},d=>{d.expected.dataset.domains.liabilities.source++;},
    d=>{d.checkpoint.fundsSupplement.pendingCommissionCoverage.completedDutyCandidates++;}]) {
    const changed=structuredClone(data);change(changed);assert.equal(assessRoundEvidence(changed).status,'INCOMPLETE');
  }
  for (const change of [d=>{delete d.checkpoint.targetFenceReleased;}, d=>{d.checkpoint.protectionRecorded=false;}]) {
    const changed=structuredClone(data); change(changed);
    assert(assessRoundEvidence(changed).issues.includes('ROUND_CHECKPOINT_UNCONFIRMED'));
  }
  for (const change of [d=>{delete d.readback.targetFence;}, d=>{delete d.readback.resource.migrationProfile;}]) {
    const changed=structuredClone(data); change(changed);
    assert(assessRoundEvidence(changed).issues.includes('ROUND_DATASET_READBACK_UNCONFIRMED'));
  }
  const noPathFence=structuredClone(data);delete noPathFence.receipt.stages.find(stage=>stage.name==='paths').metrics.targetFenceReleased;
  assert(assessRoundEvidence(noPathFence).issues.includes('ROUND_PATH_FENCE_UNCONFIRMED'));
  for (const [issue, change] of [['ROUND_GROWTH_PREPARE_UNCONFIRMED',d=>{delete d.growth.prepare.readOnlyFence;}],
    ['ROUND_GROWTH_APPLY_UNCONFIRMED',d=>{d.growth.apply.targetFenceReleased=false;}],
    ['ROUND_GROWTH_READBACK_UNCONFIRMED',d=>{d.growth.readback.readOnlyMaintenanceClosed=false;}]]) {
    const changed=structuredClone(data); change(changed); assert(assessRoundEvidence(changed).issues.includes(issue));
  }
});

test('packed growth manifests retain the same cohort and reject gaps or layout mismatches',()=>{
 const data=completedEvidence(),manifest=data.growth.manifest;data.input.growth.packageLayout='PACKED_V2';manifest.schema='zzsh.local-growth-round-plan.v2';
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123456'};
 for(const value of [data.input.target,data.receipt.target,data.checkpoint.binding,data.readback.resource,data.growth.prepare,manifest,data.growth.apply,data.growth.readback])value.instance=instance;
 manifest.packs=[{file:'packages/00001.bin',bytes:2,count:2,sha256:'a'.repeat(64)}];
 manifest.packages[0].file='packages/00001.bin';manifest.packages[0].offset=0;manifest.packages[0].length=1;
 manifest.packages[1].file='packages/00001.bin';manifest.packages[1].offset=1;manifest.packages[1].length=1;
 assert.equal(assessRoundEvidence(data).status,'COMPLETE');
 const gap=structuredClone(data);gap.growth.manifest.packages[1].offset=2;
 assert.ok(assessRoundEvidence(gap).issues.includes('ROUND_GROWTH_PREPARE_UNCONFIRMED'));
 const old=structuredClone(data);old.growth.manifest.schema='zzsh.local-growth-round-plan.v1';
 assert.ok(assessRoundEvidence(old).issues.includes('ROUND_GROWTH_PREPARE_UNCONFIRMED'));
 for(const key of ['prepare','manifest']){
  const wrong=structuredClone(data);wrong.growth[key].instance={...instance,systemIdentifier:'654321'};
  assert.ok(assessRoundEvidence(wrong).issues.includes('ROUND_GROWTH_PREPARE_UNCONFIRMED'));
 }
 const inline=structuredClone(data);inline.input.growth.approvalLayout='INLINE_INTENT_V1';
 inline.growth.apply.approvalLayout='INLINE_INTENT_V1';inline.growth.apply.approvalLog={status:'INLINE_INTENTS_AND_ACKS_VERIFIED',startIndex:0,completed:2,lines:4,sha256:'d'.repeat(64)};
 assert.equal(assessRoundEvidence(inline).status,'COMPLETE');
 for(const change of [x=>{delete x.growth.apply.approvalLog},x=>{x.growth.apply.approvalLog.startIndex=1},x=>{x.growth.apply.approvalLog.lines=3},x=>{x.growth.apply.approvalLog.sha256='bad'}]){
  const bad=structuredClone(inline);change(bad);const result=assessRoundEvidence(bad);
  assert.equal(result.status,'INCOMPLETE');assert.equal(result.growth,'INCOMPLETE');assert.ok(result.issues.includes('ROUND_GROWTH_APPROVAL_LOG_UNCONFIRMED'));
 }
 const invalid=structuredClone(inline);invalid.input.growth.packageLayout=undefined;
 assert.ok(assessRoundEvidence(invalid).issues.includes('ROUND_GROWTH_PREPARE_UNCONFIRMED'));
});

test('fresh full-round evidence requires the same captured distribution source and validated policy',()=>{
 const data=completedEvidence(),digest='a'.repeat(64),config='b'.repeat(64),levels='c'.repeat(64),validator='d'.repeat(64),parser='e'.repeat(64);
 data.input.growth.packageLayout='PACKED_V2';data.input.source={sha256:digest};data.input.buildFiles['finance/distribution-policy-change.js']=parser;
 data.expected.dataset.identityProfiles={schema:'zzsh.legacy-identity-profile-source.v1',verified:0,ready:0,invalid:0};
 data.expected.source={files:{distributionConfig:{sha256:config,rows:2},distributionLevels:{sha256:levels,rows:3}}};
 data.receipt.toolFiles={'local-distribution-qualification-plan.mjs':validator};
 data.receipt.distributionSourcePreflight={status:'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN',sourceReceiptSha256:digest,
  configurationSha256:config,levelsSha256:levels,configurationRows:2,sourceLevels:3,activeLevels:1,settlementDelayDays:7,
  policyDigest:'f'.repeat(64),connections:0,targetWrites:0,validatorSha256:validator,policyParserSha256:parser};
 assert(!assessRoundEvidence(data).issues.includes('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED'));
 for(const change of [d=>{delete d.receipt.distributionSourcePreflight},d=>{d.receipt.distributionSourcePreflight.levelsSha256='0'.repeat(64)},
  d=>{d.receipt.distributionSourcePreflight.policyParserSha256='0'.repeat(64)},d=>{d.receipt.distributionSourcePreflight.targetWrites=1}]){
  const changed=structuredClone(data);change(changed);assert(assessRoundEvidence(changed).issues.includes('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED'));
 }
 const inline=structuredClone(data);inline.input.growth.approvalLayout='INLINE_INTENT_V1';
 inline.input.buildFiles['auth/membership-growth-legacy-cli.js']='9'.repeat(64);inline.receipt.distributionSourcePreflight.growthCommitGuardSha256='9'.repeat(64);
 assert(!assessRoundEvidence(inline).issues.includes('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED'));
 inline.receipt.distributionSourcePreflight.growthCommitGuardSha256='8'.repeat(64);
 assert(assessRoundEvidence(inline).issues.includes('ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED'));
});

test("identity profile readiness requires independent source, target and key proof", () => {
  const data = completedEvidence();
  data.expected.dataset.identityProfiles = { schema: "zzsh.legacy-identity-profile-source.v1", verified: 2, ready: 2, invalid: 0 };
  Object.assign(data.checkpoint.binding, { identityProfileKeyProof: "a".repeat(64), identitySubjectKeyProof: "b".repeat(64) });
  data.readback.identityProfiles = { expected: 2, sourceMatched: 2, matched: 2, target: 2, source: { rows: 4, verified: 2, closed: true } };
  data.expected.display.accountBaseRatio={scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',known:2,unknown:0};
  data.expected.display.accountFullPayout={scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',selected:1,unselected:1,unknown:0};
  data.readback.display.accountBaseRatio={status:'VERIFIED',scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',expected:2,matched:2,known:2,unknown:0};
  data.readback.display.accountFullPayout={status:'VERIFIED',scope:'ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',expected:2,matched:2,selected:1,unselected:1,unknown:0};
  data.input.source={sha256:'1'.repeat(64)};data.input.display={sha256:'2'.repeat(64)};
  data.expected.dataset.files={accounts:{sha256:'3'.repeat(64)}};Object.assign(data.expected.display,{sha256:'4'.repeat(64),notDisplayable:0});
  data.receipt.displayCapturePreflight={status:'SOURCE_DISPLAY_CAPTURE_VERIFIED_TARGET_NOT_RUN',sourceReceiptSha256:data.input.source.sha256,
    datasetManifestSha256:data.input.dataset.sha256,displayManifestSha256:data.input.display.sha256,sourceSha256:'5'.repeat(64),
    accountsSha256:'3'.repeat(64),displaySha256:'4'.repeat(64),sourceAccounts:2,preparedAccounts:2,displayRows:2,notDisplayable:0,
    ratio:{known:2,unknown:0},payout:{selected:1,unselected:1,unknown:0},sourceConnections:0,targetConnections:0,targetWrites:0};
  data.input.legal = { sha256: "c".repeat(64) };
  data.input.bootstrapEvidence = { business: { sha256: "f".repeat(64) } };
  data.receipt.bootstrapEvidence = { rentalReference: { targetDigest: "a".repeat(64), businessReceiptSha256: "f".repeat(64) } };
  data.readback.rentalReference = { status: "TARGET_CONFIG_VERIFIED", targetDigest: "a".repeat(64), businessReceiptSha256: "f".repeat(64), runtimeAccess: "VERIFIED", runtimeRollbackConfirmed: true, runtimeClosed: true };
  data.readback.legal = { status: "VERIFIED", inputSha256: data.input.legal.sha256, effectiveAt: "2026-01-01T00:00:00.000Z",
    terms: { id: "terms-1", digest: "d".repeat(64) }, privacy: { id: "privacy-1", digest: "e".repeat(64) } };
  assert.equal(assessRoundEvidence(data).status, "COMPLETE");
  const missingCapture=structuredClone(data);delete missingCapture.receipt.displayCapturePreflight;
  assert.ok(assessRoundEvidence(missingCapture).issues.includes('ROUND_DISPLAY_CAPTURE_PREFLIGHT_UNCONFIRMED'));
  for (const mutate of [d => { delete d.checkpoint.binding.identityProfileKeyProof; }, d => { d.readback.identityProfiles.sourceMatched--; },
    d => { d.readback.identityProfiles.matched--; }, d => { d.readback.identityProfiles.target++; },
    d => { d.expected.dataset.identityProfiles.invalid = 1; }, d => { d.readback.identityProfiles.source.rows = 1; },
    d => { d.readback.identityProfiles.source.closed = false; }]) {
    const bad = structuredClone(data); mutate(bad);
    assert.ok(assessRoundEvidence(bad).issues.includes("ROUND_IDENTITY_PROFILE_READBACK_UNCONFIRMED"));
  }
  for (const mutate of [d => { delete d.readback.legal; }, d => { d.readback.legal.inputSha256 = "0".repeat(64); },
    d => { delete d.readback.legal.privacy.id; }]) {
    const bad = structuredClone(data); mutate(bad);
    assert.ok(assessRoundEvidence(bad).issues.includes("ROUND_LEGAL_READBACK_UNCONFIRMED"));
  }
  for (const mutate of [d => { delete d.readback.rentalReference; }, d => { d.readback.rentalReference.targetDigest = "0".repeat(64); },
    d => { d.readback.rentalReference.businessReceiptSha256 = "0".repeat(64); }, d => { d.readback.rentalReference.runtimeAccess = "UNKNOWN"; },
    d => { d.readback.rentalReference.runtimeClosed = false; }, d => { delete d.receipt.bootstrapEvidence.rentalReference; }]) {
    const bad = structuredClone(data); mutate(bad);
    assert.ok(assessRoundEvidence(bad).issues.includes("ROUND_RENTAL_REFERENCE_READBACK_UNCONFIRMED"));
  }
});

test("selected-round completion requires matching source scope proofs in the receipt and checkpoint", () => {
  const data = completedEvidence();
  data.expected.dataset.identityProfiles = { schema: "zzsh.legacy-identity-profile-source.v1", verified: 0, ready: 0, invalid: 0 };
  data.expected.dataset.population = { mode: "SELECTED_BUSINESS_SCOPE", domains: Object.fromEntries(["users", "accounts", "orders"].map(name => [name, { captured: 2 }])) };
  for (const name of ["users", "accounts", "orders"]) Object.assign(data.expected.dataset.domains[name], { source: 2, isolated: 0 });
  const scope = { status: "SELECTED_SCOPE_SOURCE_AND_INPUT_VERIFIED_TARGET_NOT_RUN", ...Object.fromEntries(["users", "accounts", "orders"].map(name => [name, { captured: 2, retained: 2, excluded: 0, ready: 2, isolated: 0 }])), sourceConnections: 0, targetConnections: 0, targetWrites: 0 };
  data.receipt.population = { mode: "SELECTED_BUSINESS_SCOPE", sourceVerification: { ...scope, elapsedMs: 12 } };
  data.checkpoint.sourceScopeVerification = structuredClone(scope);
  assert.ok(!assessRoundEvidence(data).issues.includes("ROUND_SOURCE_SCOPE_CHECKPOINT_UNCONFIRMED"));
  delete data.checkpoint.sourceScopeVerification;
  assert.ok(assessRoundEvidence(data).issues.includes("ROUND_SOURCE_SCOPE_CHECKPOINT_UNCONFIRMED"));
  data.checkpoint.sourceScopeVerification = structuredClone(scope);
  data.checkpoint.sourceScopeVerification.orders.ready--;
  assert.ok(assessRoundEvidence(data).issues.includes("ROUND_SOURCE_SCOPE_CHECKPOINT_UNCONFIRMED"));
});

test("whole-user migration cannot report completion without invitation count closure and independent readback",()=>{
  const data=completedEvidence(),dataset=data.expected.dataset;
  dataset.population={mode:"SELECTED_BUSINESS_SCOPE"};dataset.domains.users={source:2,ready:2,isolated:0};
  dataset.invitationFacts={subjects:2,codes:2,selectedSubjects:2,packets:2,selectedPackets:2,policy:null,financialEffects:false};
  dataset.files={"invitation-facts":{rows:2}};
  data.checkpoint.phases.invitationCounts={complete:true,quarantined:0,nextIndex:2};
  data.readback.invitationFacts={childCountClosure:{status:"VERIFIED",packets:2,auditsMatched:2,subjects:2,known:1,unknown:1,matched:2}};
  data.expected.display.accountBaseRatio={scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",known:data.expected.display.rows,unknown:0};
  data.readback.display.accountBaseRatio={status:"VERIFIED",scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",expected:data.expected.display.rows,matched:data.expected.display.rows,known:data.expected.display.rows,unknown:0};
  data.expected.display.accountFullPayout={scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",selected:0,unselected:data.expected.display.rows,unknown:0};
  data.readback.display.accountFullPayout={status:"VERIFIED",scope:"ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT",expected:data.expected.display.rows,matched:data.expected.display.rows,selected:0,unselected:data.expected.display.rows,unknown:0};
  assert.equal(assessRoundEvidence(data).status,"COMPLETE");
  const missing=structuredClone(data);delete missing.checkpoint.phases.invitationCounts;
  assert(assessRoundEvidence(missing).issues.includes("ROUND_INVITATION_COUNT_CLOSURE_INCOMPLETE"));
  const unverified=structuredClone(data);unverified.readback.invitationFacts.childCountClosure.auditsMatched=1;
  assert(assessRoundEvidence(unverified).issues.includes("ROUND_INVITATION_COUNT_READBACK_UNCONFIRMED"));
  const ratio=structuredClone(data);ratio.readback.display.accountBaseRatio.matched--;
  assert(assessRoundEvidence(ratio).issues.includes("ROUND_ACCOUNT_CAPTURE_RATIO_READBACK_UNCONFIRMED"));
  const payout=structuredClone(data);payout.readback.display.accountFullPayout.unselected--;
  assert(assessRoundEvidence(payout).issues.includes("ROUND_ACCOUNT_CAPTURE_PAYOUT_READBACK_UNCONFIRMED"));
  const missingUsers=structuredClone(data);missingUsers.expected.dataset.domains.users.ready=1;
  assert(assessRoundEvidence(missingUsers).issues.includes("ROUND_INVITATION_SCOPE_UNPROVEN"));
});

test("R07 accepts an excluded guarantee only with an empty source plan and independent target proof", () => {
  const d=completedEvidence();d.input.target.bootstrapReservation="ROUND07_BOOTSTRAP_RESERVED";delete d.checkpoint.phases.guaranteeHistory;
  d.checkpoint.fundsSupplement={coverage:{guarantees:{policyExcluded:true,selected:0,planned:0,writer:0,listingDeposit:{targetRows:0}}}};
  d.checkpoint.generatedPhases={guaranteeHistory:{rows:0,sha256:sha("[]")},financeEmptyCoverage:{schema:"zzsh.empty-coverage-chunks.v1",rows:2,chunks:[{},{}]}};
  d.readback.ownerGuaranteeHistory={policyExcluded:true,expected:0,actual:0};
  d.readback.emptyFinancialCoverage={sourceRebuilt:true,expected:2,readable:2,actual:2,chunks:2};
  assert.deepEqual(assessRoundEvidence(d),{status:"COMPLETE",dataset:"PASS",growth:"PASS",issues:[]});
  for(const change of [x=>{x.checkpoint.fundsSupplement.coverage.guarantees.writer=1},x=>{x.checkpoint.generatedPhases.guaranteeHistory.sha256="0".repeat(64)},x=>{x.checkpoint.generatedPhases.guaranteeHistory.rows=1}]){
    const bad=structuredClone(d);change(bad);assert(assessRoundEvidence(bad).issues.includes("ROUND_PHASE_INCOMPLETE:guaranteeHistory"));
  }
  const badReadback=structuredClone(d);badReadback.readback.ownerGuaranteeHistory.actual=1;
  assert(assessRoundEvidence(badReadback).issues.includes("ROUND_GUARANTEE_EXCLUSION_READBACK_UNCONFIRMED"));
  const badChunks=structuredClone(d);badChunks.readback.emptyFinancialCoverage.sourceRebuilt=false;
  assert(assessRoundEvidence(badChunks).issues.includes("ROUND_EMPTY_COVERAGE_READBACK_UNCONFIRMED"));
});

test("every growth package is checked before apply, including later missing or changed packages", () => {
  const bytes = [Buffer.from("first"), Buffer.from("second")];
  const manifest = { packages: bytes.map((value, index) => ({ file: `packages/0000${index + 1}.json`, sha256: sha(value) })) };
  assert.doesNotThrow(() => assertGrowthPackages(manifest, file => bytes[file.includes("00001") ? 0 : 1]));
  assert.throws(() => assertGrowthPackages(manifest, file => file.includes("00001") ? bytes[0] : Buffer.from("changed")), /ROUND_GROWTH_PACKAGE_SHA_MISMATCH/);
  assert.throws(() => assertGrowthPackages(manifest, file => { if (file.includes("00002")) throw Error("missing package"); return bytes[0]; }), /missing package/);
});

test("dataset-only success and a manually resumed receipt cannot claim complete growth", () => {
  const data = completedEvidence();
  delete data.input.growth;
  data.receipt.stages = data.receipt.stages.slice(0, 6);
  let result = assessRoundEvidence(data);
  assert.deepEqual(result, { status: "INCOMPLETE", dataset: "PASS", growth: "NOT_PLANNED", issues: ["ROUND_GROWTH_NOT_PLANNED"] });
  const resumed = completedEvidence();
  resumed.receipt.status = "DATASET_STAGES_ACK_READBACK_PASS";
  resumed.receipt.stages = resumed.receipt.stages.slice(0, 6);
  resumed.receipt.stages[2] = { name: "opening", status: "INTENT", code: 1 };
  for (const index of [3, 4, 5]) delete resumed.receipt.stages[index].code;
  result = assessRoundEvidence(resumed);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.growth, "INCOMPLETE");
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:opening"));
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:growth-prepare"));
});

test("receipt inspection is offline, read-only, and reports cross-target bootstrap and missing stages", async () => {
  const r = await round({ action: "inspect-receipt", bootstrapDrift: "staff" });
  assert.ifError(r.error);
  assert.equal(r.exit, 1);
  assert.equal(r.logs[0].status, "INCOMPLETE");
  assert.equal(r.logs[0].bootstrap, "INCOMPLETE");
  assert.equal(r.logs[0].bootstrapReason, "ROUND_BOOTSTRAP_TARGET_OR_EVIDENCE_MISMATCH:staff");
  assert.equal(r.logs[0].growth, "NOT_PLANNED");
  assert.ok(r.logs[0].issues.includes("ROUND_BOOTSTRAP_EVIDENCE_UNCONFIRMED"));
  assert.deepEqual(r.directories, []);
  assert.deepEqual(r.spawns, []);
  assert.ok(!r.reads.includes(credentials));
});

test("receipt inspection marks the dataset incomplete when the distribution source preflight no longer verifies", async () => {
  const options = { action: "inspect-receipt", reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", instance: { host: "127.0.0.1", port: 55433, systemIdentifier: "123" }, withGrowth: true, packedPreflight: true, inspectPreflight: true };
  const verified = await round(options);
  assert.ifError(verified.error);
  assert.equal(verified.logs[0].dataset, "PASS");
  const changed = await round({ ...options, distributionInvalid: true });
  assert.ifError(changed.error);
  assert.equal(changed.logs[0].status, "INCOMPLETE");
  assert.equal(changed.logs[0].dataset, "INCOMPLETE");
  assert.ok(changed.logs[0].issues.includes("ROUND_DISTRIBUTION_SOURCE_UNCONFIRMED"));
  assert.deepEqual(changed.spawns, []);
  assert.deepEqual(changed.liveCommands, []);
});

test("receipt inspection rechecks the sealed inline approval log before reporting growth complete", async () => {
  const options = { action: "inspect-receipt", reservationStatus: "ROUND06_BOOTSTRAP_RESERVED", instance: { host: "127.0.0.1", port: 55433, systemIdentifier: "123" }, withGrowth: true, packedPreflight: true, inspectPreflight: true, inlineGrowth: true };
  const verified = await round(options);
  assert.ifError(verified.error); assert.equal(verified.logs[0].growth, 'PASS');
  const changed = await round({ ...options, inlineLogInvalid: true });
  assert.ifError(changed.error); assert.equal(changed.logs[0].status, 'INCOMPLETE'); assert.equal(changed.logs[0].growth, 'INCOMPLETE');
  assert.ok(changed.logs[0].issues.includes('ROUND_GROWTH_APPROVAL_LOG_UNCONFIRMED'));
  assert.deepEqual(changed.spawns, []); assert.deepEqual(changed.liveCommands, []);
  const replaced = await round({ ...options, artifactFault: { file: 'growth-execution/summary.json', kind: 'object' } });
  assert.ifError(replaced.error); assert.equal(replaced.logs[0].growth, 'INCOMPLETE');
  assert.ok(replaced.logs[0].issues.includes('ROUND_STAGE_EVIDENCE_CHANGED:growth-apply'));
});

test("corrupt and unreadable artifacts never hide the original stopped stage or prevent its receipt", async () => {
  for (const artifactFault of [
    { file: "loader/checkpoint.json", kind: "json", label: "checkpoint" },
    { file: "readback.json", kind: "null", label: "readback" },
    { file: "growth-plan/manifest.json", kind: "array", label: "growth-manifest" },
    { file: "loader/checkpoint.json", kind: "read-error", label: "checkpoint" },
  ]) {
    const r = await round({ withGrowth: true, artifactFault });
    assert.ifError(r.error);
    assert.equal(r.exit, 1);
    const receipt = JSON.parse(r.receipt);
    assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
    assert.equal(receipt.failure.stage, "core-and-funds");
    assert.match(receipt.failure.message, /ROUND_STAGE_STOPPED/);
    assert.equal(receipt.completion.status, "INCOMPLETE");
    assert.ok(receipt.completion.issues.includes("ROUND_ARTIFACT_UNREADABLE:" + artifactFault.label));
  }
  const inspected = await round({ action: "inspect-receipt", artifactFault: { file: "readback.json", kind: "json" } });
  assert.ifError(inspected.error);
  assert.equal(inspected.logs[0].status, "INCOMPLETE");
  assert.ok(inspected.logs[0].issues.includes("ROUND_ARTIFACT_UNREADABLE:readback"));
});

test("null and malformed stage entries are incomplete rather than an assessment exception", () => {
  const d = completedEvidence();
  d.receipt.stages[0] = null;
  d.receipt.stages[1] = "invalid";
  d.expected.dataset = null;
  const result = assessRoundEvidence(d);
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:core-and-funds"));
  assert.ok(result.issues.includes("ROUND_STAGE_NOT_ACKNOWLEDGED:display"));
});

test("growth-only continuation preserves original failure/checkpoint and proves data before and after new growth", async () => {
  const r = await round({ action: "resume-growth", resumeCase: "success" });
  assert.ifError(r.error);
  assert.equal(r.exit, undefined, r.receipt?.toString());
  assert.equal(r.oldCheckpointUnchanged, true);
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.mode, "RESUME_GROWTH");
  assert.equal(receipt.status, "DATASET_AND_GROWTH_REVALIDATED_PASS");
  assert.equal(receipt.completion.status, "COMPLETE");
  assert.equal(receipt.prior.proof.status, "ORIGINAL_COMPLETE_CHECKPOINT_BOUND");
  assert.deepEqual(receipt.stages.map(s => s.name), ["schema-preflight", "readback", "growth-prepare", "growth-attempt-reservation", "growth-apply", "growth-readback", "readback-final"]);
  assert.equal(r.attemptPresent, true);
  assert.equal(receipt.stages.some(s => s.name === "opening"), false);
  assert.equal(r.spawns.some(args => args[0].endsWith("load-local-dataset.mjs") || args[0].endsWith("load-legacy-path-accounts.mjs")), false);
  assert.equal(r.liveCommands[0], "connect");
  assert.equal(r.liveCommands.at(-2), "ROLLBACK"); assert.equal(r.liveCommands.at(-1), "end");
  const inspected = await r.inspectCurrent();
  assert.ifError(inspected.error); assert.equal(inspected.report.status, "COMPLETE");
  assert.equal(inspected.report.evidenceOnly, true); assert.equal(inspected.report.targetConnections, 0);
  const stages = structuredClone(receipt), input = { resume: structuredClone(receipt.prior) };
  assert.equal(assessResumeStages(stages, input).status, "COMPLETE");
  stages.prior.previousReceipt.sha256 = "0".repeat(64);
  assert.ok(assessResumeStages(stages, input).issues.includes("ROUND_RESUME_RECEIPT_LINEAGE_MISMATCH"));
});

test("growth-only continuation rejects unproven lineage and unknown commits before output", async () => {
  for (const resumeCase of ["unknown", "missing-phase", "different-source", "fabricated-receipt", "prior-growth-stage", "prior-attempt"]) {
    const r = await round({ action: "resume-growth", resumeCase });
    assert.ok(r.error, resumeCase);
    assert.equal(r.oldCheckpointUnchanged, true);
    assert.deepEqual(r.directories, []); assert.deepEqual(r.spawns, []); assert.deepEqual(r.liveCommands, []);
  }
});

test("growth-only continuation does not write growth when live schema or initial readback is unproven", async () => {
  for (const resumeCase of ["schema-drift", "schema-target-drift", "schema-drift-rollback-fail", "schema-rollback-fail", "schema-close-fail", "readback-fail", "growth-prepare-fail", "growth-prepare-bad-manifest", "bad-package", "checkpoint-drift", "reservation-race", "reservation-fsync-fail"]) {
    const r = await round({ action: "resume-growth", resumeCase });
    assert.ifError(r.error);
    assert.equal(r.exit, 1);
    const receipt = JSON.parse(r.receipt);
    assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
    assert.equal(receipt.completion.status, "INCOMPLETE");
    assert.equal(r.spawns.some(args => args[0].endsWith("run-local-growth.mjs") && args.includes("--apply")), false, resumeCase);
    if (resumeCase !== "checkpoint-drift") assert.equal(r.oldCheckpointUnchanged, true);
    else assert.ok(receipt.completion.issues.includes("ROUND_ARTIFACT_CHANGED:checkpoint"));
    if (resumeCase.endsWith("rollback-fail")) assert.deepEqual(receipt.failure.readOnlyCleanup, { rollbackAck: false, closed: true });
    if (resumeCase === "schema-close-fail") assert.deepEqual(receipt.failure.readOnlyCleanup, { rollbackAck: true, closed: false });
    if (resumeCase === "reservation-fsync-fail") assert.equal(r.attemptPresent, true);
    if (resumeCase === "bad-package") assert.equal(r.attemptPresent, false);
  }
});

test("final readback failure keeps the committed growth stage visible without claiming complete", async () => {
  const r = await round({ action: "resume-growth", resumeCase: "final-readback-fail" });
  assert.ifError(r.error); assert.equal(r.exit, 1); assert.equal(r.oldCheckpointUnchanged, true);
  const receipt = JSON.parse(r.receipt);
  assert.equal(receipt.status, "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS");
  assert.equal(receipt.failure.stage, "readback-final");
  assert.equal(receipt.stages.find(s => s.name === "growth-apply").status, "ACK");
  assert.equal(receipt.completion.status, "INCOMPLETE");
  const corrupted = await round({ action: "resume-growth", resumeCase: "before-corrupt" });
  assert.ifError(corrupted.error); assert.equal(corrupted.exit, 1);
  const corruptedReceipt = JSON.parse(corrupted.receipt);
  assert.equal(corruptedReceipt.completion.status, "INCOMPLETE");
  assert.ok(corruptedReceipt.completion.issues.includes("ROUND_RESUME_INITIAL_READBACK_UNCONFIRMED"));
  const changed = await round({ action: "resume-growth", resumeCase: "summary-drift" });
  assert.ifError(changed.error); assert.equal(changed.exit, 1);
  assert.ok(JSON.parse(changed.receipt).completion.issues.includes("ROUND_RESUME_STAGE_EVIDENCE_CHANGED:growth-apply"));
});
