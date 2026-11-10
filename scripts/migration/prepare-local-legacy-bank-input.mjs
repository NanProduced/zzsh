import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { hasVerifiedNextInitialSchema, isRegisteredMigrationInstance, NEXT_MIGRATION_PROFILE, normalizeRegisteredTarget } from "./local-target-registry.mjs";
import { assertDistributionCoreReadback, assertRegisteredDistributionTarget, isolatedDistributionBuild } from "./local-distribution-qualification-plan.mjs";
import { captureBoundLegacyBankSource, releaseBoundLegacyBankSource, useBoundLegacyBankSource } from "./local-legacy-bank-source.mjs";

const sha = value => createHash("sha256").update(value).digest("hex"), hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stop = () => { throw Error("LEGACY_BANK_PREPARATION_UNAVAILABLE"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tools = ["run-local-legacy-bank.mjs", "prepare-local-legacy-bank-input.mjs", "local-legacy-bank-source.mjs", "local-legacy-bank-runner.mjs", "local-source-adapter.mjs", "local-target-registry.mjs", "local-distribution-qualification-plan.mjs", "verify-legacy-listed-policy-dump.mjs", "../local-auth.mjs"];

/** The local loader reads only files below the explicit working directory's .secrets. */
export function relativeBankSecretPath(workingDirectory, filePath) {
  if (typeof workingDirectory !== "string" || typeof filePath !== "string" || !isAbsolute(workingDirectory) || !isAbsolute(filePath)) stop();
  const base = resolve(workingDirectory), path = resolve(filePath), inside = relative(resolve(base, ".secrets"), path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) stop();
  const result = relative(base, path).replaceAll("\\", "/"); if (!result.startsWith(".secrets/")) stop(); return result;
}

/** The migration CLI consumes only this task's sealed final build. */
export function assertBankNoSymlinkPath(path, stat = lstatSync) {
  if (typeof path !== "string" || !isAbsolute(path)) stop();
  for (let p = resolve(path); p !== dirname(p); p = dirname(p)) if (stat(p).isSymbolicLink()) stop();
}
export function requireFinalR06ApiDist(root, candidate, stat = lstatSync) {
  if (typeof root !== "string" || typeof candidate !== "string" || !isAbsolute(root) || !isAbsolute(candidate)) stop();
  const expected = resolve(root, "apps/api/dist-r06-v3/src");
  if (resolve(candidate).toLowerCase() !== expected.toLowerCase()) stop(); assertBankNoSymlinkPath(expected, stat); return expected;
}
export function requireFinalR07ApiDist(root, candidate, stat = lstatSync) {
  const expected = isolatedDistributionBuild(root, candidate); assertBankNoSymlinkPath(expected, stat); return expected;
}

/** Intermediate 0156 or an unacknowledged/mismatched final target cannot authorize a bank input. */
export function assertFinalLegacyBankSchema(proof, final, registry, stage, swap, original) {
  const t = proof?.target;
  const upgraded=proof?.schema === "zzsh.round07-bank-schema-proof.v2";
  const next=proof?.schema === "zzsh.local-bank-schema-proof.v1";
  if (proof?.schema === "zzsh.round07-bank-schema-proof.v1" || upgraded || next) {
    const registered = normalizeRegisteredTarget(registry);
    if (proof.status !== "FINAL_SCHEMA_READBACK_ACK" || !Number.isInteger(proof.finalOrdinal) || proof.finalOrdinal < 160
      || proof.readOnlyRollbackAck !== true || proof.clientClosed !== true || !hex(proof.journalSha256) || !hex(proof.historySha256)
      || ![proof.roundInput,proof.roundReceipt,proof.coreReadback,proof.finalReceipt].every(ref => typeof ref?.path === "string" && hex(ref.sha256))
      || final?.schema !== (next?"zzsh.local-bank-final-schema.v1":upgraded?"zzsh.round07-final-schema.v2":"zzsh.round07-final-schema.v1") || final.status !== "FINAL_SCHEMA_VERIFIED" || final.operation !== (upgraded?"UPGRADE_0161_AND_READBACK":"BOOTSTRAP_AND_CORE_READBACK")
      || final.actualMigrationPerformed !== false || final.finalOrdinal !== proof.finalOrdinal || final.journalSha256 !== proof.journalSha256
      || final.historySha256 !== proof.historySha256 || final.readOnlyRollbackAck !== true || final.clientClosed !== true || final.unlockAck !== true || final.maintenanceClosed !== true
      || final.roundInputSha256 !== proof.roundInput.sha256 || final.roundReceiptSha256 !== proof.roundReceipt.sha256 || final.coreReadbackSha256 !== proof.coreReadback.sha256
      || next && (!original || !hasVerifiedNextInitialSchema(original.schema) || original.schema.migrationProfile!==NEXT_MIGRATION_PROFILE
        || typeof proof.schemaReceipt?.path!=='string' || !hex(proof.schemaReceipt.sha256) || !same(proof.schemaReceipt,original.round?.bootstrapEvidence?.schema)
        || final.schemaReceiptSha256!==proof.schemaReceipt.sha256 || original.round?.target?.migrationProfile!==NEXT_MIGRATION_PROFILE
        || original.round.target.bootstrapReservation!=='ROUND07_BOOTSTRAP_RESERVED' || String(original.schema.oid)!==String(t?.databaseOid)
        || original.schema.nonce!==t?.nonce || !same(original.schema.instance,t?.instance)
        || original.schema.journalSha256!==proof.journalSha256 || original.schema.historySha256!==proof.historySha256
        || !same(original.schema.hashes,original.round.target.schemaHashes))
      || !t || t.round !== (next?'next':7) || !isRegisteredMigrationInstance(registered) || !same(t.instance, registered.instance) || t.host !== registered.host || t.port !== registered.port
      || (t.migrationProfile??null)!==(registered.migrationProfile??null) || (next?registered.migrationProfile!==NEXT_MIGRATION_PROFILE:registered.migrationProfile!==null)
      || t.database !== "zzsh_test_regression" || String(t.databaseOid) !== registered.oid || t.nonce !== registered.nonce || t.marker !== registered.marker || registered.pendingReset
      || registered.lockKey !== "806006" || registered.maintenanceDatabase !== "postgres"
      || ![t.databaseOid,t.ownerOid,t.runtimeRoleOid,t.migrationRoleOid].every(v => Number.isSafeInteger(v) && v > 0 && v <= 4294967295)
      || [3058841,3179610,3287891].includes(t.databaseOid) || t.owner !== registered.owner || t.runtimeUser !== registered.runtimeRole
      || String(t.runtimeRoleOid) !== registered.runtimeRoleOid || t.migrationUser !== registered.migrationRole || String(t.migrationRoleOid) !== registered.migrationRoleOid
      || !same(final.target,t) || upgraded&&(!same(final.upgradeRefs,proof.upgradeRefs)||!["oldProof","oldFinal","upgradePlan","upgradeExecution","upgradeReadback","liveReadback"].every(k=>typeof proof.upgradeRefs?.[k]?.path==='string'&&hex(proof.upgradeRefs[k].sha256)))) stop();
    return t;
  }
  if (proof?.schema !== "zzsh.round06-bank-schema-proof.v1" || proof.status !== "FINAL_SCHEMA_READBACK_ACK" || !Number.isInteger(proof.finalOrdinal) || proof.finalOrdinal < 157
    || proof.readOnlyRollbackAck !== true || proof.clientClosed !== true || !hex(proof.journalSha256) || !hex(proof.historySha256)
    || final?.schema !== "zzsh.round06-final-schema.v1" || final.status !== "FINAL_SCHEMA_VERIFIED" || final.operation !== "POST_SWAP_READ_ONLY_REVALIDATION"
    || final.actualMigrationPerformed !== false || final.finalOrdinal !== proof.finalOrdinal
    || final.journalSha256 !== proof.journalSha256 || final.historySha256 !== proof.historySha256 || final.readOnlyRollbackAck !== true || final.clientClosed !== true
    || final.unlockAck !== true || final.maintenanceClosed !== true || !hex(final.stageReceipt?.sha256) || !hex(final.swapReceipt?.sha256)
    || !t || t.round !== 6 || t.host !== "127.0.0.1" || t.port !== 55432 || t.database !== "zzsh_test_regression"
    || ![t.databaseOid, t.ownerOid, t.runtimeRoleOid].every(v => Number.isSafeInteger(v) && v > 0 && v <= 4294967295)
    || [3058841, 3179610, 3287891].includes(t.databaseOid) || !/^[a-f0-9]{24}$/.test(t.nonce ?? "")
    || !/^zzsh:[a-z0-9-]+:v1$/.test(t.marker ?? "") || !/^zzsh(?:_[a-z0-9_]+)?$/.test(t.owner ?? "") || !/^zzsh_[a-z0-9_]+$/.test(t.runtimeUser ?? "")
    || Number(final.target?.oid) !== t.databaseOid || final.target?.nonce !== t.nonce || final.target?.marker !== t.marker || final.target?.database !== t.database
    || final.target?.owner !== t.owner || Number(final.target?.ownerOid) !== t.ownerOid || final.target?.runtimeUser !== t.runtimeUser || Number(final.target?.runtimeRoleOid) !== t.runtimeRoleOid
    || stage?.status !== "FINAL_SCHEMA_0157_VERIFIED" || stage.target?.database !== "zzsh_test_round06_stage" || stage.target?.marker !== "zzsh:round06-schema-build:v1"
    || Number(stage.target?.oid) !== t.databaseOid || stage.target?.nonce !== t.nonce || stage.commitAck !== true || stage.unlockAck !== true || stage.maintenanceClosed !== true
    || !Array.isArray(stage.hashes) || stage.hashes.length < 5 || stage.hashes.some(v => !hex(v)) || !same(stage.hashes, final.stageHashes)
    || swap?.status !== "COMMIT_ACK" || Number(swap.oid) !== t.databaseOid || swap.nonce !== t.nonce || swap.schemaReceiptSha256 !== final.stageReceipt.sha256
    || swap.unlockAck !== true || swap.maintenanceClosed !== true || swap.targetIdentity?.rollbackAck !== true || swap.targetIdentity?.clientClosed !== true
    || swap.targetIdentity?.database !== t.database || Number(swap.targetIdentity?.oid) !== t.databaseOid || swap.targetIdentity?.nonce !== t.nonce
    || swap.targetIdentity?.marker !== t.marker || swap.targetIdentity?.owner !== t.owner || Number(swap.targetIdentity?.ownerOid) !== t.ownerOid
    || swap.targetIdentity?.runtimeRole !== t.runtimeUser || Number(swap.targetIdentity?.runtimeRoleOid) !== t.runtimeRoleOid
    || Number(registry?.oid) !== t.databaseOid || registry.database !== t.database || registry.marker !== t.marker || registry.nonce !== t.nonce || registry.pendingReset
    || registry.roles?.runtime?.name !== t.runtimeUser || Number(registry.roles?.runtime?.oid) !== t.runtimeRoleOid) stop();
  return t;
}

/** Rebind the original R07 bank proof to an acknowledged 0161 upgrade and new two-role readback. */
export function makeR07UpgradedBankSchemaEvidence({oldProof,oldFinal,upgradePlan,upgradeExecution,upgradeReadback,liveReadback,registry,refs,finalPath}){
  const target=assertFinalLegacyBankSchema(oldProof,oldFinal,registry),sameTarget=x=>x?.oid===String(target.databaseOid)&&x?.nonce===target.nonce&&same(x?.instance,target.instance);
  if(oldProof.schema!=='zzsh.round07-bank-schema-proof.v1'||oldProof.finalOrdinal!==160||!same(oldProof.finalReceipt,refs.oldFinal)
    ||upgradePlan?.status!=='READ_ONLY_PREPARED'||!sameTarget(upgradePlan.target)||upgradePlan.before?.historySha256!==oldProof.historySha256
    ||upgradeExecution?.status!=='UPGRADE_READBACK_PASSED'||!sameTarget(upgradeExecution.target)||upgradeExecution.commitAck!==true||upgradeExecution.readbackRollbackAck!==true
    ||upgradeExecution.unlockAck!==true||upgradeExecution.clientClosed!==true||upgradeExecution.lockClosed!==true||upgradeExecution.financialWrites!==0
    ||upgradeReadback?.status!=='EXACT_0161_AND_PREIMAGE_READBACK_PASSED'||!sameTarget(upgradeReadback.target)||upgradeReadback.inputs?.plan!==refs.upgradePlan.sha256
    ||upgradeReadback.inputs?.execution!==refs.upgradeExecution.sha256||upgradeReadback.lastMigrationSha256!==upgradePlan.migrationSha256||upgradeReadback.functionSha256!==upgradePlan.expectedFunctionSha256
    ||upgradeReadback.readOnlyRollbackAck!==true||upgradeReadback.clientClosed!==true||upgradeReadback.targetWrites!==0
    ||liveReadback?.schema!=='zzsh.r07-bank-upgraded-schema-readback.v1'||liveReadback.status!=='UPGRADED_SCHEMA_AND_BOTH_ROLES_READBACK_PASSED'
    ||!same(liveReadback.target,target)||liveReadback.finalOrdinal!==161||liveReadback.journalSha256!==upgradePlan.journalSha256
    ||liveReadback.historySha256!==upgradeExecution.after?.historySha256||liveReadback.prefixSha256!==oldProof.historySha256||liveReadback.lastMigrationSha256!==upgradePlan.migrationSha256
    ||!['bank_table','can_select','can_insert','can_update'].every(k=>liveReadback.bankAcl?.[k]===true)||liveReadback.migrationRollbackAck!==true||liveReadback.runtimeRollbackAck!==true
    ||liveReadback.unlockAck!==true||liveReadback.clientsClosed!==true||liveReadback.targetWrites!==0||typeof finalPath!=='string'
    ||!['oldProof','oldFinal','upgradePlan','upgradeExecution','upgradeReadback','liveReadback'].every(k=>typeof refs[k]?.path==='string'&&hex(refs[k].sha256)))stop();
  const final={schema:'zzsh.round07-final-schema.v2',status:'FINAL_SCHEMA_VERIFIED',operation:'UPGRADE_0161_AND_READBACK',actualMigrationPerformed:false,finalOrdinal:161,
    journalSha256:liveReadback.journalSha256,historySha256:liveReadback.historySha256,readOnlyRollbackAck:true,clientClosed:true,unlockAck:true,maintenanceClosed:true,
    roundInputSha256:oldProof.roundInput.sha256,roundReceiptSha256:oldProof.roundReceipt.sha256,coreReadbackSha256:oldProof.coreReadback.sha256,target,upgradeRefs:refs};
  const finalBytes=Buffer.from(JSON.stringify(final,null,2)+'\n'),proof={schema:'zzsh.round07-bank-schema-proof.v2',status:'FINAL_SCHEMA_READBACK_ACK',finalOrdinal:161,
    journalSha256:final.journalSha256,historySha256:final.historySha256,readOnlyRollbackAck:true,clientClosed:true,target,roundInput:oldProof.roundInput,roundReceipt:oldProof.roundReceipt,
    coreReadback:oldProof.coreReadback,upgradeRefs:refs,finalReceipt:{path:finalPath,sha256:sha(finalBytes)}};
  assertFinalLegacyBankSchema(proof,final,registry);return{final,proof};
}

/** Build a R07 proof only from the sealed fresh-schema receipt and independent core readback. */
export function makeR07BankSchemaEvidence({round,roundInput,roundReceipt,roundReceiptRef,readback,readbackRef,schema,runtime,registry,journalSha256,finalPath}) {
  const t=round?.target,registered=normalizeRegisteredTarget(registry),actual=runtime?.actualResource,next=t?.migrationProfile===NEXT_MIGRATION_PROFILE;
  if(round?.schema!=="zzsh.local-round.v1" || t?.bootstrapReservation!=="ROUND07_BOOTSTRAP_RESERVED"
    || !isRegisteredMigrationInstance(registered) || !same(t.instance,registered.instance) || (t.migrationProfile??null)!==registered.migrationProfile || registered.database!=="zzsh_test_regression"
    || registered.oid!==t.oid || registered.nonce!==t.nonce || registered.pendingReset || !registered.owner
    || !registered.migrationRoleOid || !registered.runtimeRoleOid || registered.migrationRoleOid!==t.migrationRoleOid
    || registered.lockKey!=="806006" || registered.maintenanceDatabase!=="postgres" || !hex(journalSha256)
    || ![roundInput,roundReceiptRef,readbackRef].every(ref=>typeof ref?.path==="string"&&hex(ref.sha256))
    || typeof finalPath!=="string" || schema?.status!=="CLEAN_SCHEMA_INSTALLED" || !Number.isInteger(schema.finalOrdinal) || schema.finalOrdinal<160
    || String(schema.oid)!==t.oid || schema.nonce!==t.nonce || !same(schema.instance,t.instance) || schema.journalSha256!==journalSha256
    || !hex(schema.historySha256) || !same(schema.hashes,t.schemaHashes) || schema.commitAck!==true || schema.migrationAck!==true
    || next && !hasVerifiedNextInitialSchema(schema)
    || schema.readbackRollbackAck!==true || schema.readbackClientClosed!==true || schema.unlockAck!==true || schema.maintenanceClosed!==true
    || runtime?.formalAppMounted!==true || runtime.resource?.database!==registered.database || String(runtime.resource?.oid??runtime.resource?.resourceOid)!==registered.oid
    || runtime.resource?.nonce!==registered.nonce || !same(runtime.resource?.instance,registered.instance)
    || actual?.database!==registered.database || String(actual.oid??actual.resourceOid)!==registered.oid || actual.nonce!==registered.nonce
    || !same(actual.instance,registered.instance) || actual.marker!==registered.marker || actual.owner!==registered.owner
    || next&&[runtime.resource,actual].some(value=>value?.migrationProfile!==NEXT_MIGRATION_PROFILE)
    || String(actual.migration_role_oid)!==registered.migrationRoleOid || actual.runtime_role!==registered.runtimeRole || String(actual.runtime_role_oid)!==registered.runtimeRoleOid
    || actual.read_only!=="on" || !/^[1-9]\d*$/.test(String(actual.owner_oid??""))) stop();
  assertRegisteredDistributionTarget(t,round.dataset?.sha256,{...registry,instance:registered.instance});
  assertDistributionCoreReadback(roundReceipt,readback,{roundInputSha256:roundInput.sha256,readbackSha256:readbackRef.sha256,
    datasetSha256:round.dataset?.sha256,sourceSha256:round.source?.sha256,target:t});
  const target={round:next?'next':7,host:registered.host,port:registered.port,instance:registered.instance,database:registered.database,databaseOid:Number(registered.oid),
    ...(next?{migrationProfile:NEXT_MIGRATION_PROFILE}:{}),
    marker:registered.marker,nonce:registered.nonce,owner:registered.owner,ownerOid:Number(actual.owner_oid),runtimeUser:registered.runtimeRole,
    runtimeRoleOid:Number(registered.runtimeRoleOid),migrationUser:registered.migrationRole,migrationRoleOid:Number(registered.migrationRoleOid)};
  const final={schema:next?"zzsh.local-bank-final-schema.v1":"zzsh.round07-final-schema.v1",status:"FINAL_SCHEMA_VERIFIED",operation:"BOOTSTRAP_AND_CORE_READBACK",actualMigrationPerformed:false,
    finalOrdinal:schema.finalOrdinal,journalSha256,historySha256:schema.historySha256,readOnlyRollbackAck:readback.rollbackConfirmed,clientClosed:readback.connectionsClosed,
    unlockAck:readback.lockReleased,maintenanceClosed:readback.connectionsClosed,roundInputSha256:roundInput.sha256,roundReceiptSha256:roundReceiptRef.sha256,coreReadbackSha256:readbackRef.sha256,
    ...(next?{schemaReceiptSha256:round.bootstrapEvidence?.schema?.sha256}:{}),target};
  const finalBytes=Buffer.from(JSON.stringify(final,null,2)+"\n"),proof={schema:next?"zzsh.local-bank-schema-proof.v1":"zzsh.round07-bank-schema-proof.v1",status:"FINAL_SCHEMA_READBACK_ACK",finalOrdinal:final.finalOrdinal,
    journalSha256,historySha256:final.historySha256,readOnlyRollbackAck:true,clientClosed:true,target,roundInput,roundReceipt:roundReceiptRef,coreReadback:readbackRef,
    ...(next?{schemaReceipt:round.bootstrapEvidence?.schema}:{}),
    finalReceipt:{path:finalPath,sha256:sha(finalBytes)}};
  assertFinalLegacyBankSchema(proof,final,registry,undefined,undefined,next?{round,schema}:undefined);
  return {final,proof};
}

export function assertLegacyBankKeyringProof(proof,target) {
  const next=target?.round==='next',r07=target?.round===7,modern=next||r07;
  if(!modern&&target?.round!==6 || proof?.schema!==(next?"zzsh.local-bank-keyring-receipt.v1":r07?"zzsh.r07-bank-keyring-receipt.v1":"zzsh.r06-bank-keyring-receipt.v1") || proof.status!=="KEYRING_READY"
    || proof.aclVerified!==true || proof.backupMatches!==true || proof.database!==target.database || proof.runtimeUser!==target.runtimeUser
    || typeof proof.version!=="string" || !proof.files?.[proof.version]
    || modern && (proof.target?.oid!==String(target.databaseOid) || proof.target?.nonce!==target.nonce || !same(proof.target?.instance,target.instance)
      || (proof.target?.migrationProfile??null)!==(target.migrationProfile??null))) stop();
}

export function assertLegacyBankSourceProof(proof,round,sourceReceiptSha256,sourceBindingSha256) {
  if(![6,7,'next'].includes(round) || proof?.schema!==(round==='next'?"zzsh.local-bank-source-validation.v1":round===7?"zzsh.r07-bank-source-validation.v1":"zzsh.r06-bank-source-validation.v1") || proof.status!=="SOURCE_VERIFIED_READ_ONLY"
    || proof.restoreMatchesDump!==true || proof.sourceAccess!=="MYSQL_REPEATABLE_READ_READ_ONLY_ROLLBACK" || proof.plaintextRowsPersisted!==false
    || proof.postgresConnections!==0 || proof.writes!==0 || !hex(proof.sourceReceiptSha256) || !hex(proof.sourceBindingSha256)
    || proof.sourceReceiptSha256!==sourceReceiptSha256 || proof.sourceBindingSha256!==sourceBindingSha256)stop();
}

/** Testable content-only authority construction; no source rows, credentials or key bytes enter this object. */
export function makeLegacyBankAuthority(input, inputSha256, plan, planSha256, window, approvalRef) {
  if (!hex(inputSha256) || !hex(planSha256) || !input || !plan || ![6,7,'next'].includes(input.target?.round) || input.schema !== "zzsh.local-legacy-bank-input.v1"
    || plan.schema !== "zzsh.local-legacy-bank-plan.v1" || plan.inputSha256 !== inputSha256 || plan.datasetSha256 !== input.dataset?.sha256
    || plan.buildSha256 !== input.buildSha256 || plan.schemaJournalSha256 !== input.schemaJournalSha256 || plan.schemaHistorySha256 !== input.schemaHistorySha256
    || !same(plan.binding?.target, input.target) || plan.binding?.source?.sourceReceiptSha256 !== input.source?.sourceReceiptSha256
    || !hex(plan.commitment) || !Number.isSafeInteger(plan.counts?.ready) || plan.counts.ready < 1
    || !window || !Number.isFinite(Date.parse(window.notBefore)) || !Number.isFinite(Date.parse(window.expiresAt))
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(window.notBefore) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(window.expiresAt)
    || Date.parse(window.notBefore) >= Date.parse(window.expiresAt) || typeof approvalRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approvalRef)) stop();
  return { schema: "zzsh.local-legacy-bank-authority.v1", purpose: input.target?.round === 'next' ? "LOCAL_MIGRATION_BANK_IMPORT" : input.target?.round === 7 ? "ROUND_07_BANK_IMPORT" : "ROUND_06_BANK_IMPORT", inputSha256, planSha256,
    binding: plan.binding, commitment: plan.commitment, buildSha256: input.buildSha256, schemaJournalSha256: input.schemaJournalSha256,
    schemaHistorySha256: input.schemaHistorySha256, maxWrites: plan.counts.ready, notBefore: window.notBefore, expiresAt: window.expiresAt, approvalRef };
}

export function collectLegacyBankBuild(apiDir) {
  const files = {};
  function walk(dir, prefix = "") {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) stop(); const name = prefix + item.name, path = join(dir, item.name);
      if (item.isDirectory()) walk(path, name + "/"); else if (item.isFile() && name.endsWith(".js")) files[name] = sha(readFileSync(path));
    }
  }
  walk(apiDir); if (!Object.keys(files).length) stop(); return files;
}

function pathUnder(value, roots, parentOnly = false) {
  if (typeof value !== "string" || !isAbsolute(value)) stop(); const path = resolve(value);
  if (!roots.some(root => { const rel = relative(root, path); return rel && !rel.startsWith("..") && !isAbsolute(rel); })) stop();
  for (let p = parentOnly ? dirname(path) : path; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) stop();
  return path;
}

function powershell(script, extraEnv = {}) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) stop(); return r.stdout.trim();
}
function currentSid() {
  const sid = powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  if (!/^S-1-[0-9-]+$/.test(sid)) stop(); return sid;
}
function checkAcl(dir, sid, requireProtected = false) {
  const script = `$ErrorActionPreference='Stop'; $p=$env:ZZSH_BANK_ACL_PATH; if([System.IO.Directory]::Exists($p)) { $acl=([System.IO.DirectoryInfo]::new($p)).GetAccessControl() } else { $acl=([System.IO.FileInfo]::new($p)).GetAccessControl() };\n` +
    `$allowed=@($env:ZZSH_BANK_ACL_SID,'S-1-5-18','S-1-5-32-544');\n` +
    `if ($env:ZZSH_BANK_ACL_REQUIRE_PROTECTED -eq '1' -and -not $acl.AreAccessRulesProtected) { exit 2 };\n` +
    `$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);\n` +
    `foreach($r in $rules) { if($r.AccessControlType -eq 'Allow' -and $allowed -notcontains $r.IdentityReference.Value) { exit 3 } }; exit 0`;
  powershell(script, { ZZSH_BANK_ACL_PATH: dir, ZZSH_BANK_ACL_SID: sid, ZZSH_BANK_ACL_REQUIRE_PROTECTED: requireProtected ? "1" : "0" });
}
/** Check effective allow ACEs; newly created key/backup directories additionally require protected inheritance. */
export function assertWindowsBankAcl(path, requireProtected = false) {
  if (process.platform !== "win32") stop(); checkAcl(path, currentSid(), requireProtected);
}
function secureNewDirectory(path, restricted, sid) {
  const out = pathUnder(path, [restricted], true); if (existsSync(out)) stop();
  mkdirSync(out, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") stop();
  const acl = spawnSync("icacls.exe", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (acl.status !== 0) stop(); checkAcl(out, sid, true); return out;
}
function jsonFile(path, expected, roots, sid) {
  const file = pathUnder(path, roots); checkAcl(dirname(file), sid); checkAcl(file, sid);
  if (!hex(expected)) stop(); const bytes = readFileSync(file); if (sha(bytes) !== expected) stop();
  try { return JSON.parse(bytes); } catch { return stop(); }
}
function readOriginalNextBankSchema(proof, restricted, sid) {
  if (proof?.schema !== 'zzsh.local-bank-schema-proof.v1') return undefined;
  const round=jsonFile(proof.roundInput?.path,proof.roundInput?.sha256,[restricted],sid);
  if (!same(round.bootstrapEvidence?.schema,proof.schemaReceipt)) stop();
  return {round,schema:jsonFile(proof.schemaReceipt?.path,proof.schemaReceipt?.sha256,[restricted],sid)};
}
function writeNew(path, value) { let fd; try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); } finally { if (fd !== undefined) closeSync(fd); } }

async function main() {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const modes = ["--schema-proof", "--schema-upgrade-proof", "--keyring-proof", "--source-proof", "--input", "--authority"].filter(mode => args.includes(mode));
  if (!modes.length) { console.log(JSON.stringify({ status: "PLAN_ONLY", modes: ["--schema-proof", "--schema-upgrade-proof", "--keyring-proof", "--source-proof", "--input", "--authority"], required: ["--request", "--request-sha", "--out"], dbConnections: 0, keyReads: 0, keysGenerated: 0 })); return; }
  if (modes.length !== 1 || process.platform !== "win32") stop();
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url))), restricted = resolve("E:/zzsh-local-state/restricted"), runtime = resolve("E:/zzsh-local-state/runtime"), secrets = resolve("E:/zzsh/zzsh/apps/api/.secrets"), sid = currentSid();
  const request = jsonFile(option("--request"), option("--request-sha"), [restricted], sid), out = secureNewDirectory(option("--out"), restricted, sid);
  if (modes[0] === "--schema-proof") {
    const next=request.schema==="zzsh.local-bank-schema-request.v1";
    if(!next&&request.schema!=="zzsh.round07-bank-schema-request.v1")stop();
    const round=jsonFile(request.roundInput?.path,request.roundInput?.sha256,[restricted],sid),
      roundReceipt=jsonFile(request.roundReceipt?.path,request.roundReceipt?.sha256,[restricted],sid),
      readback=jsonFile(request.coreReadback?.path,request.coreReadback?.sha256,[restricted],sid),
      registry=jsonFile(request.registry?.path,request.registry?.sha256,[restricted],sid),
      schema=jsonFile(round.bootstrapEvidence?.schema?.path,round.bootstrapEvidence?.schema?.sha256,[restricted],sid),
      runtimeBinding=jsonFile(round.bootstrapEvidence?.runtime?.path,round.bootstrapEvidence?.runtime?.sha256,[restricted,runtime],sid);
    if((round.target?.migrationProfile===NEXT_MIGRATION_PROFILE)!==next)stop();
    if(resolve(request.registry.path).toLowerCase()!==resolve(dirname(round.credentials),"resource.json").toLowerCase())stop();
    const journalBytes=readFileSync(join(root,"apps/api/migrations/business/meta/_journal.json")),journal=JSON.parse(journalBytes),last=journal.entries?.at(-1);
    if(last?.idx!==schema.finalOrdinal || !Number.isSafeInteger(last.idx) || last.idx<160 || typeof last.tag!=='string'
      || !new RegExp('^'+String(last.idx).padStart(4,'0')+'_[a-z0-9_]+$').test(last.tag)
      || !existsSync(join(root,'apps/api/migrations/business',last.tag+'.sql')))stop();
    const result=makeR07BankSchemaEvidence({round,roundInput:request.roundInput,roundReceipt,roundReceiptRef:request.roundReceipt,readback,readbackRef:request.coreReadback,
      schema,runtime:runtimeBinding,registry,journalSha256:sha(journalBytes),finalPath:join(out,"final-schema.json")});
    writeNew(join(out,"final-schema.json"),result.final);writeNew(join(out,"schema-proof.json"),result.proof);
    if(sha(readFileSync(join(out,"final-schema.json")))!==result.proof.finalReceipt.sha256)stop();
    console.log(JSON.stringify({status:next?"LOCAL_BANK_SCHEMA_EVIDENCE_READY_NOT_EXECUTED":"R07_SCHEMA_EVIDENCE_READY_NOT_EXECUTED",proofSha256:sha(readFileSync(join(out,"schema-proof.json"))),dbConnections:0,keyReads:0}));
  } else if (modes[0] === "--schema-upgrade-proof") {
    if(request.schema!=='zzsh.round07-bank-schema-upgrade-request.v1')stop();
    const refs=request.upgradeRefs,values=Object.fromEntries(['oldProof','oldFinal','upgradePlan','upgradeExecution','upgradeReadback','liveReadback'].map(k=>[k,jsonFile(refs?.[k]?.path,refs?.[k]?.sha256,[restricted],sid)])),
      registry=jsonFile(request.registry?.path,request.registry?.sha256,[restricted],sid),result=makeR07UpgradedBankSchemaEvidence({...values,registry,refs,finalPath:join(out,'final-schema.json')});
    writeNew(join(out,'final-schema.json'),result.final);writeNew(join(out,'schema-proof.json'),result.proof);
    if(sha(readFileSync(join(out,'final-schema.json')))!==result.proof.finalReceipt.sha256)stop();
    console.log(JSON.stringify({status:'R07_UPGRADED_SCHEMA_EVIDENCE_READY_NOT_EXECUTED',proofSha256:sha(readFileSync(join(out,'schema-proof.json'))),dbConnections:0,keyReads:0}));
  } else if (modes[0] === "--source-proof") {
    const next=request.schema==="zzsh.local-bank-source-request.v1";
    if(!next&&request.schema!=="zzsh.round07-bank-source-request.v1")stop();
    const round=jsonFile(request.roundInput?.path,request.roundInput?.sha256,[restricted],sid),apiDir=requireFinalR07ApiDist(root,round.apiDist),
      hashPath=join(apiDir,"supply/content-hash.js"),moduleSha=round.buildFiles?.["supply/content-hash.js"];
    if(round.target?.bootstrapReservation!=="ROUND07_BOOTSTRAP_RESERVED" || (round.target?.migrationProfile===NEXT_MIGRATION_PROFILE)!==next || !hex(moduleSha) || sha(readFileSync(hashPath))!==moduleSha
      || !hex(round.source?.sha256) || !hex(request.sourceBindingSha256))stop();
    const require=createRequire(join(root,"apps/api/package.json")),{canonicalize}=require(hashPath),sourceInput={sourceDir:round.source.path,
      sourceReceiptSha256:round.source.sha256,sourceBinding:request.sourceBinding,sourceBindingSha256:request.sourceBindingSha256};
    const token=await captureBoundLegacyBankSource(sourceInput,canonicalize);
    try {
      const value=useBoundLegacyBankSource(token),evidence={schema:next?"zzsh.local-bank-source-validation.v1":"zzsh.r07-bank-source-validation.v1",status:"SOURCE_VERIFIED_READ_ONLY",restoreMatchesDump:true,
        sourceAccess:"MYSQL_REPEATABLE_READ_READ_ONLY_ROLLBACK",plaintextRowsPersisted:false,postgresConnections:0,writes:0,
        sourceReceiptSha256:round.source.sha256,sourceBindingSha256:request.sourceBindingSha256,sourceDumpSha256:value.source.sourceDumpSha256,rows:value.rows.length};
      assertLegacyBankSourceProof(evidence,next?'next':7,round.source.sha256,request.sourceBindingSha256);writeNew(join(out,"source-proof.json"),evidence);
      console.log(JSON.stringify({status:next?"LOCAL_BANK_SOURCE_EVIDENCE_READY_NOT_EXECUTED":"R07_BANK_SOURCE_EVIDENCE_READY_NOT_EXECUTED",sourceProofSha256:sha(readFileSync(join(out,"source-proof.json"))),rows:evidence.rows,postgresConnections:0,writes:0}));
    } finally {releaseBoundLegacyBankSource(token);}
  } else if (modes[0] === "--keyring-proof") {
    const next=request.schema==="zzsh.local-bank-keyring-request.v1";
    if(!next&&request.schema!=="zzsh.round07-bank-keyring-request.v1" || typeof request.version!=="string" || !request.files?.[request.version])stop();
    const proof=jsonFile(request.schemaProof?.path,request.schemaProof?.sha256,[restricted],sid),
      final=jsonFile(proof.finalReceipt?.path,proof.finalReceipt?.sha256,[restricted],sid),
      registry=jsonFile(request.registry?.path,request.registry?.sha256,[restricted],sid),original=readOriginalNextBankSchema(proof,restricted,sid),
      target=assertFinalLegacyBankSchema(proof,final,registry,undefined,undefined,original);
    if(target.round!==(next?'next':7))stop();
    for(const ref of [request.config,...Object.values(request.files)]){
      if(!hex(ref?.sha256))stop();const path=pathUnder(ref.path,[secrets]);checkAcl(dirname(path),sid,true);checkAcl(path,sid);
      if(sha(readFileSync(path))!==ref.sha256)stop();relativeBankSecretPath(resolve("E:/zzsh/zzsh/apps/api"),path);
    }
    const config=jsonFile(request.config.path,request.config.sha256,[secrets],sid);
    if(config.database!==target.database||config.runtimeUser!==target.runtimeUser||config.writeEnabled!==true||!config.keyVariables
      ||Object.keys(config.keyVariables).sort().join()!==Object.keys(request.files).sort().join())stop();
    const backupDir=pathUnder(request.backupDirectory,[restricted,secrets]),backup=pathUnder(request.backupFile,[backupDir]);
    checkAcl(backupDir,sid,true);checkAcl(backup,sid);
    if(!hex(request.backupSha256)||sha(readFileSync(backup))!==request.backupSha256||request.backupSha256!==request.files[request.version].sha256)stop();
    const evidence={schema:next?"zzsh.local-bank-keyring-receipt.v1":"zzsh.r07-bank-keyring-receipt.v1",status:"KEYRING_READY",aclVerified:true,backupMatches:true,database:target.database,runtimeUser:target.runtimeUser,
      target:{oid:String(target.databaseOid),nonce:target.nonce,instance:target.instance,...(next?{migrationProfile:NEXT_MIGRATION_PROFILE}:{})},version:request.version,config:request.config,files:request.files,
      backupDirectory:backupDir,backupFile:backup,backupSha256:request.backupSha256};
    assertLegacyBankKeyringProof(evidence,target);writeNew(join(out,"keyring-proof.json"),evidence);
    console.log(JSON.stringify({status:next?"LOCAL_BANK_KEYRING_EVIDENCE_READY_NOT_EXECUTED":"R07_KEYRING_EVIDENCE_READY_NOT_EXECUTED",proofSha256:sha(readFileSync(join(out,"keyring-proof.json"))),dbConnections:0,keysGenerated:0}));
  } else if (modes[0] === "--input") {
    if (request.schema !== "zzsh.local-legacy-bank-input-request.v1") stop();
    const proof = jsonFile(request.schemaProof?.path, request.schemaProof?.sha256, [restricted], sid), r07 = ["zzsh.round07-bank-schema-proof.v1","zzsh.round07-bank-schema-proof.v2","zzsh.local-bank-schema-proof.v1"].includes(proof.schema);
    const registryPath = r07 ? pathUnder(request.registry?.path, [restricted]) : resolve(secrets, "local-postgresql/regression_test/resource.json");
    if (resolve(request.registry?.path ?? "").toLowerCase() !== registryPath.toLowerCase()) stop();
    const registry = jsonFile(registryPath, request.registry?.sha256, r07 ? [restricted] : [secrets], sid);
    const final = jsonFile(proof.finalReceipt?.path, proof.finalReceipt?.sha256, [restricted], sid);
    const stage = r07 ? null : jsonFile(final.stageReceipt?.path, final.stageReceipt?.sha256, [restricted], sid), swap = r07 ? null : jsonFile(final.swapReceipt?.path, final.swapReceipt?.sha256, [restricted], sid);
    const source = jsonFile(request.sourceProof?.path, request.sourceProof?.sha256, [restricted], sid);
    const dataset = jsonFile(request.dataset?.path, request.dataset?.sha256, [restricted], sid), keyring = jsonFile(request.keyringProof?.path, request.keyringProof?.sha256, [restricted], sid);
    const t = assertFinalLegacyBankSchema(proof, final, registry, stage, swap, readOriginalNextBankSchema(proof,restricted,sid));
    if(proof.schema==='zzsh.round07-bank-schema-proof.v2'){
      const refs=proof.upgradeRefs,values=Object.fromEntries(['oldProof','oldFinal','upgradePlan','upgradeExecution','upgradeReadback','liveReadback'].map(k=>[k,jsonFile(refs?.[k]?.path,refs?.[k]?.sha256,[restricted],sid)]));
      const checked=makeR07UpgradedBankSchemaEvidence({...values,registry,refs,finalPath:proof.finalReceipt.path});if(!same(checked.final,final)||!same(checked.proof,proof))stop();
    }
    if (r07) {
      const round = jsonFile(proof.roundInput.path, proof.roundInput.sha256, [restricted], sid),
        roundReceipt = jsonFile(proof.roundReceipt.path, proof.roundReceipt.sha256, [restricted], sid),
        readback = jsonFile(proof.coreReadback.path, proof.coreReadback.sha256, [restricted], sid);
      if (round.target?.oid !== String(t.databaseOid) || round.target?.nonce !== t.nonce || !same(round.target.instance,t.instance)
        || round.dataset?.sha256 !== request.dataset.sha256) stop();
      assertRegisteredDistributionTarget(round.target,request.dataset.sha256,{...registry,instance:normalizeRegisteredTarget(registry).instance});
      assertDistributionCoreReadback(roundReceipt,readback,{roundInputSha256:proof.roundInput.sha256,readbackSha256:proof.coreReadback.sha256,
        datasetSha256:request.dataset.sha256,sourceSha256:round.source?.sha256,target:round.target});
    }
    assertLegacyBankSourceProof(source,t.round,dataset.sourceReceiptSha256,r07 ? request.sourceBindingSha256 : source.sourceBindingSha256);
    if(dataset.sourceReceiptSha256 !== source.sourceReceiptSha256 || !Number.isSafeInteger(dataset.domains?.users?.ready)) stop();
    assertLegacyBankKeyringProof(keyring,t);
    const referencedFiles = [keyring.config, ...Object.values(keyring.files)];
    for (const ref of referencedFiles) {
      if (!hex(ref?.sha256)) stop(); const file = pathUnder(ref.path, [restricted, secrets]); checkAcl(dirname(file), sid, true); checkAcl(file, sid);
    }
    const backupDir = pathUnder(keyring.backupDirectory, [restricted, secrets]); checkAcl(backupDir, sid, true);
    const backupFile = pathUnder(keyring.backupFile, [backupDir]); checkAcl(backupFile, sid);
    if (!hex(keyring.backupSha256) || keyring.backupSha256 !== keyring.files[keyring.version].sha256) stop();
    if (!hex(request.operator?.sha256)) stop(); const actorPath = pathUnder(request.operator.path, [restricted, secrets]); checkAcl(dirname(actorPath), sid); checkAcl(actorPath, sid);
    const apiDir = r07 ? requireFinalR07ApiDist(root, request.apiDist) : requireFinalR06ApiDist(root, resolve(root, "apps/api/dist-r06-v3/src"));
    const buildFiles = collectLegacyBankBuild(apiDir), require = createRequire(join(root, "apps/api/package.json"));
    const { canonicalize } = require(join(apiDir, "supply/content-hash.js")), buildSha256 = sha(canonicalize(buildFiles));
    const journalSha = sha(readFileSync(join(root, "apps/api/migrations/business/meta/_journal.json"))); if (journalSha !== proof.journalSha256) stop();
    const toolFiles = Object.fromEntries(tools.map(name => { const path = join(root, "scripts/migration", name); assertBankNoSymlinkPath(path); return [name, sha(readFileSync(path))]; }));
    const credentialsFile = r07 ? pathUnder(join(dirname(registryPath), "credentials.json"), [restricted]) : null;
    if (credentialsFile) { checkAcl(dirname(credentialsFile),sid);checkAcl(credentialsFile,sid); }
    const input = { schema: "zzsh.local-legacy-bank-input.v1", target: t, lockId: 806006,
      ...(credentialsFile ? {credentials:{path:credentialsFile,sha256:sha(readFileSync(credentialsFile))}} : {}),
      source: { sourceDir: request.sourceDir, sourceReceiptSha256: source.sourceReceiptSha256, sourceBinding: request.sourceBinding, sourceBindingSha256: source.sourceBindingSha256 },
      dataset: request.dataset, apiDist: apiDir, buildFiles, buildSha256, toolFiles, schemaJournalSha256: proof.journalSha256,
      schemaHistorySha256: proof.historySha256, operator: request.operator, keyring: { version: keyring.version, config: keyring.config, files: keyring.files },
      evidence: { schemaProof: request.schemaProof, finalSchemaReceipt: proof.finalReceipt, sourceProof: request.sourceProof, keyringProof: request.keyringProof,
        ...(r07 ? {roundInput:proof.roundInput,roundReceipt:proof.roundReceipt,coreReadback:proof.coreReadback} : {}) } };
    writeNew(join(out, "input.json"), input);
    console.log(JSON.stringify({ status: "INPUT_READY_NOT_EXECUTED", inputSha256: sha(readFileSync(join(out, "input.json"))), buildFiles: Object.keys(buildFiles).length, dbConnections: 0, keyReads: 0, keysGenerated: 0 }));
  } else {
    if (request.schema !== "zzsh.local-legacy-bank-authority-request.v1") stop();
    const input = jsonFile(request.input?.path, request.input?.sha256, [restricted], sid), plan = jsonFile(request.plan?.path, request.plan?.sha256, [restricted], sid);
    const authority = makeLegacyBankAuthority(input, request.input.sha256, plan, request.plan.sha256, request.window, request.approvalRef);
    writeNew(join(out, "authority.json"), authority);
    console.log(JSON.stringify({ status: "AUTHORITY_READY_NOT_EXECUTED", authoritySha256: sha(readFileSync(join(out, "authority.json"))), maxWrites: authority.maxWrites, dbConnections: 0, keyReads: 0, keysGenerated: 0 }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error("LEGACY_BANK_PREPARATION_UNAVAILABLE"); process.exitCode = 1; });
