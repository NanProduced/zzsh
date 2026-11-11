import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { writePrivate } from "../local-auth.mjs";
import { NEXT_MIGRATION_PROFILE } from "./local-target-registry.mjs";

export const ROUND_MODULES = ["auth/identity-subject", "auth/identity-mask", "auth/legacy-identity-profile", "auth/membership-growth", "auth/membership-growth-integration", "auth/membership-growth-legacy", "auth/membership-growth-legacy-cli",
  "auth/membership-growth-legacy-maintenance", "auth/membership-growth-legacy-store", "auth/auth-security", "auth/security-core", "credit/credit-initialization",
  "database/business-migrations", "finance/legacy-finance-source-preparation", "finance/legacy-invitation-facts", "finance/legacy-invitation-facts-maintenance",
  "finance/personal-finance-maintenance", "finance/personal-finance-observation-maintenance",
  "legacy-load/legacy-account-seam", "legacy-load/legacy-skin-holdings", "legacy-load/legacy-path-records", "legal/legal-documents", "order/legacy-continuation-evidence", "order/legacy-continuation-model",
  "order/legacy-growth-consumption", "order/legacy-liability-intake", "order/legacy-order-read", "profile/profile-avatar", "profile/profile-avatar-presets",
  "supply/content-hash", "supply/legacy-listing-read", "supply/legacy-observation", "supply/legacy-user-migration"];
export const ROUND_SCRIPTS = ["run-local-round.mjs", "local-round-contract.mjs", "local-round-dependencies.mjs", "prepare-local-dataset.mjs", "local-source-scenarios.mjs", "load-local-dataset.mjs", "local-load-checkpoint.mjs", "full-source-scope.mjs", "selected-business-scope.mjs", "verify-full-source-population.mjs", "local-target-registry.mjs", "local-key-set.mjs", "local-source-adapter.mjs", "local-target-finance.mjs", "local-funds-plan.mjs", "local-opening-proof.mjs", "local-target-display.mjs", "local-target-opening.mjs",
  "local-target-holdings.mjs", "local-target-contact-append.mjs", "load-legacy-path-accounts.mjs", "local-legal-pair.mjs", "readback-local-dataset.mjs", "run-local-growth.mjs", "local-growth-plan.mjs", "../local-auth.mjs"];
export const LISTED_ROUND_SCRIPTS = ['readback-listed-batches.mjs','readback-empty-legacy-listed.mjs','legacy-listed-execution-plan.mjs','legacy-listed-round-source.mjs',
  'load-legacy-listed-accounts.mjs','legacy-listed-provisional-credit.mjs','verify-legacy-listed-policy-dump.mjs','local-distribution-qualification-plan.mjs',
  'prepare-listed-same-capture-policy.mjs','prepare-legacy-listed-source-plan.mjs','listed-batch-workflow.mjs','run-listed-batches.mjs'];
export const LISTED_EXTRA_MODULES = ['finance/distribution-policy-change','order/order','supply/publishing','supply/funding-authority','supply/supply-util','supply/legacy-listed-pricing'];
export const DISTRIBUTION_ROUND_SCRIPTS = ['run-local-distribution-workflow.mjs','local-distribution-workflow.mjs','prepare-round07-distribution-candidate.mjs',
  'prepare-local-distribution.mjs','run-local-distribution-qualification.mjs','local-distribution-qualification-plan.mjs','local-distribution-qualification-runner.mjs',
  'local-distribution-qualification-readback.mjs','local-distribution-policy-approval.mjs','local-distribution-policy-runtime.mjs'];
export const DISTRIBUTION_EXTRA_MODULES = ['finance/distribution-policy-change','finance/distribution-policy-store','finance/distribution-policy-approval',
  'finance/controlled-regression-resource','finance/legacy-invitation-facts-maintenance','auth/auth-runtime','auth/auth-security','auth/approval-audit','supply/supply-util'];
export const NEXT_SOURCE_SCRIPTS = ['prepare-local-mysql-source.mjs','run-local-source-workflow.mjs','capture-local-source.mjs','capture-legacy-account-extra.mjs','local-legacy-bank-source.mjs','verify-legacy-listed-policy-dump.mjs','local-load-checkpoint.mjs'];
const RUNNER_SCRIPTS = ["run-local-round.mjs", "local-round-contract.mjs", "local-round-dependencies.mjs", "local-load-checkpoint.mjs", "full-source-scope.mjs", "selected-business-scope.mjs", "verify-full-source-population.mjs", "local-source-adapter.mjs", "local-target-registry.mjs", "../local-auth.mjs"];
const sha = value => createHash("sha256").update(value).digest("hex"), fileSha = file => sha(readFileSync(file));
export function listedDependencyRequirements(sourceManifest) {
  const files=Array.isArray(sourceManifest?.files)?sourceManifest.files:[],sentinel=files.filter(row=>row?.path==='scripts/migration/readback-listed-batches.mjs');
  assert(sentinel.length<=1,'ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID');
  if(!sentinel.length)return {scripts:[],modules:[]};
  for(const name of LISTED_ROUND_SCRIPTS){const found=files.filter(row=>row?.path==='scripts/migration/'+name);
    assert(found.length===1&&/^[a-f0-9]{64}$/.test(found[0].sha256??''),'ROUND_DEPENDENCY_LISTED_TOOLS_REQUIRED');}
  return {scripts:LISTED_ROUND_SCRIPTS,modules:LISTED_EXTRA_MODULES.filter(name=>!ROUND_MODULES.includes(name))};
}
export function distributionDependencyRequirements(sourceManifest) {
  const files=Array.isArray(sourceManifest?.files)?sourceManifest.files:[],sentinel=files.filter(row=>row?.path==='scripts/migration/run-local-distribution-workflow.mjs');
  assert(sentinel.length<=1,'ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID');
  if(!sentinel.length)return {scripts:[],modules:[]};
  for(const name of DISTRIBUTION_ROUND_SCRIPTS){const found=files.filter(row=>row?.path==='scripts/migration/'+name);
    assert(found.length===1&&/^[a-f0-9]{64}$/.test(found[0].sha256??''),'ROUND_DEPENDENCY_DISTRIBUTION_TOOLS_REQUIRED');}
  return {scripts:DISTRIBUTION_ROUND_SCRIPTS,modules:DISTRIBUTION_EXTRA_MODULES.filter(name=>!ROUND_MODULES.includes(name))};
}
export function optionalRoundSourceScripts(sourceManifest) {
  const files=Array.isArray(sourceManifest?.files)?sourceManifest.files:[],found=[];
  for(const name of ['business-reference-readiness.mjs','local-growth-packages.mjs']){
    const entries=files.filter(row=>row?.path==='scripts/migration/'+name);
    assert(entries.length<=1,'ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID');
    if(entries.length){assert(/^[a-f0-9]{64}$/.test(entries[0].sha256??''),'ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID');found.push(name);}
  }
  const sentinel=files.filter(row=>row?.path==='scripts/migration/prepare-local-mysql-source.mjs');
  assert(sentinel.length<=1,'ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID');
  if(sentinel.length)for(const name of NEXT_SOURCE_SCRIPTS){const entries=files.filter(row=>row?.path==='scripts/migration/'+name);
    assert(entries.length===1&&/^[a-f0-9]{64}$/.test(entries[0].sha256??''),'ROUND_DEPENDENCY_SOURCE_RESTORE_TOOLS_REQUIRED');found.push(name);}
  return found;
}
export function assertNextSourceTools(input,binding,receipts,scriptFiles,workflow){
  if(input.target?.migrationProfile!==NEXT_MIGRATION_PROFILE)return;
  for(const name of [...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs'])
    assert(/^[a-f0-9]{64}$/.test(scriptFiles?.[name]??'')&&workflow?.toolFiles?.[name]===scriptFiles[name],'ROUND_DEPENDENCY_SOURCE_RESTORE_TOOLS_REQUIRED');
  assert(binding?.toolSha256===scriptFiles['prepare-local-mysql-source.mjs'],'ROUND_SOURCE_RESTORE_TOOL_CHANGED');
  assert(binding?.checkpointToolSha256===scriptFiles['local-load-checkpoint.mjs'],'ROUND_SOURCE_CHECKPOINT_TOOL_CHANGED');
  for(const receipt of receipts)assert(receipt?.toolSha256===scriptFiles['capture-local-source.mjs']
    &&receipt.supportToolSha256===scriptFiles['local-source-adapter.mjs']&&receipt.accountExtraToolSha256===scriptFiles['capture-legacy-account-extra.mjs'],
    'ROUND_SOURCE_CAPTURE_TOOL_CHANGED');
}
const childCode = String.raw`const fs=require('fs'),path=require('path'),crypto=require('crypto'),{createRequire}=require('module');
const api=path.resolve(process.argv[1]),root=path.resolve(process.argv[2]),mods=JSON.parse(process.argv[3]),r=createRequire(path.join(api,'app.js')),sr=createRequire(path.join(root,'scripts/migration/load-local-dataset.mjs'));
for(const name of ['pg','@nestjs/common','@nestjs/core','drizzle-orm','reflect-metadata'])r(name);sr('pg');for(const name of mods)r(path.join(api,name+'.js'));
const paths=new Set();for(const f of Object.keys(require.cache)){if(!f.toLowerCase().includes('node_modules'))continue;if(!path.resolve(f).toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('DEPENDENCY_OUTSIDE_BOUND_BUILD');paths.add(f);let p=path.dirname(f);while(p.toLowerCase().startsWith(root.toLowerCase()+path.sep)){const pkg=path.join(p,'package.json');if(fs.existsSync(pkg)){paths.add(pkg);break}p=path.dirname(p)}}
const files=[...paths].map(f=>[path.relative(root,f).replaceAll('\\','/'),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]).sort(([a],[b])=>a<b?-1:a>b?1:0);
if(!files.length)throw Error('EMPTY_DEPENDENCY_CLOSURE');process.stdout.write(JSON.stringify({files,entrypoints:mods.length}));`;

/** A final-build manifest binds the runtime copy to its actual installed dependencies. */
export function inspectRoundDependencyLayout({ apiDist, bundlePath, bundleSha256, buildManifestPath, buildManifestSha256, sourceSnapshot, sourceManifestPath, sourceManifestSha256 }) {
  assert([apiDist, bundlePath, buildManifestPath, sourceSnapshot, sourceManifestPath].every(isAbsolute), "ROUND_DEPENDENCY_ABSOLUTE_PATH_REQUIRED");
  assert.equal(fileSha(bundlePath), bundleSha256, "ROUND_DEPENDENCY_BUNDLE_CHANGED");
  assert.equal(fileSha(buildManifestPath), buildManifestSha256, "ROUND_DEPENDENCY_FINAL_BUILD_CHANGED");
  const bundle = JSON.parse(readFileSync(bundlePath)), manifest = JSON.parse(readFileSync(buildManifestPath));
  assert(bundle.finalBuildManifestSha256 === buildManifestSha256 && bundle.finalSourceManifestSha256 === manifest.sourceSnapshotManifestSha256
    && manifest.sourceSnapshotManifestSha256 === sourceManifestSha256 && fileSha(sourceManifestPath) === sourceManifestSha256
    && ["zzsh.round06-preview-build.v1", "zzsh.round07-preview-build.v1"].includes(manifest.schema) && typeof manifest.layout?.apiDistDir === "string" && Array.isArray(manifest.components?.api), "ROUND_DEPENDENCY_BUILD_LINEAGE_CHANGED");
  const sourceRoot = resolve(dirname(buildManifestPath), "source"), scriptDir = join(sourceRoot, "scripts/migration"), moduleDirs = [join(sourceRoot, "apps/api/node_modules"), join(sourceRoot, "node_modules")];
  for (const directory of [sourceRoot, scriptDir, ...moduleDirs]) assert(existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), "ROUND_DEPENDENCY_DIRECTORY_REQUIRED");
  const prefix = manifest.layout.apiDistDir.replaceAll("\\", "/") + "/", finalBuild = Object.fromEntries(manifest.components.api.filter(row => row.path?.startsWith(prefix) && row.path.endsWith(".js")).map(row => [row.path.slice(prefix.length), row.sha256]));
  const copied = Object.fromEntries(bundle.entries.filter(row => row.path.startsWith("api-build/src/") && row.path.endsWith(".js")).map(row => [row.path.slice("api-build/src/".length), row.sha256]));
  assert.deepEqual(copied, finalBuild, "ROUND_DEPENDENCY_RUNTIME_BUILD_CHANGED");
  for (const file of ["package-lock.json", "node_modules/.package-lock.json"]) {
    const entry = manifest.components.api.find(row => row.path === file); assert(entry && fileSha(join(sourceRoot, file)) === entry.sha256, "ROUND_DEPENDENCY_LOCK_CHANGED:" + basename(file));
  }
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath));
  const listed=listedDependencyRequirements(sourceManifest);
  const distribution=distributionDependencyRequirements(sourceManifest);
  const optional=optionalRoundSourceScripts(sourceManifest);
  const scripts = [...new Set([...ROUND_SCRIPTS,...optional,...listed.scripts,...distribution.scripts])];
  const scriptFiles = Object.fromEntries(scripts.map(file => [file, fileSha(join(scriptDir, file))]));
  for(const name of [...optional,...listed.scripts,...distribution.scripts])assert.equal(sourceManifest.files.find(row=>row.path==='scripts/migration/'+name).sha256,scriptFiles[name],"ROUND_DEPENDENCY_SOURCE_MANIFEST_CHANGED");
  for (const [file, digest] of Object.entries(scriptFiles)) {
    const source = join(scriptDir,file), snapshot = join(sourceSnapshot, "scripts/migration", file);
    assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink() && lstatSync(snapshot).isFile() && !lstatSync(snapshot).isSymbolicLink(), "ROUND_DEPENDENCY_SCRIPT_UNSAFE:" + file);
    assert.equal(fileSha(snapshot), digest, "ROUND_DEPENDENCY_SNAPSHOT_SCRIPT_CHANGED:" + file);
  }
  return { apiDist: resolve(apiDist), sourceRoot, sourceSnapshot: resolve(sourceSnapshot), sourceManifestSha256, scriptDir, moduleDirs, bundleSha256, buildManifestSha256, scriptFiles,
    ...(listed.scripts.length||distribution.scripts.length?{extraEntrypoints:[...new Set([...listed.modules,...distribution.modules])]}:{}) };
}

/** The invoking process must be the sealed runner too, not merely its spawned children. */
export function assertBoundRunnerScripts(runnerDir,scriptFiles) {
  for (const file of [...new Set([...RUNNER_SCRIPTS, ...(Object.hasOwn(scriptFiles,"business-reference-readiness.mjs") ? ["business-reference-readiness.mjs"] : []),...(Object.hasOwn(scriptFiles,"local-growth-packages.mjs")?["local-growth-packages.mjs"]:[]),...NEXT_SOURCE_SCRIPTS.filter(name=>Object.hasOwn(scriptFiles,name))])]) {
    const path=join(runnerDir,file),stat=lstatSync(path);
    assert(stat.isFile()&&!stat.isSymbolicLink()&&fileSha(path)===scriptFiles[file],"ROUND_DEPENDENCY_RUNNER_CHANGED:"+file);
  }
}

export function assertListedRunnerScripts(runnerDir,scriptFiles) {
  for(const file of LISTED_ROUND_SCRIPTS){const path=join(runnerDir,file),stat=lstatSync(path);
    assert(stat.isFile()&&!stat.isSymbolicLink()&&fileSha(path)===scriptFiles[file],"ROUND_DEPENDENCY_RUNNER_CHANGED:"+file);}
}

/** Bind source policy validation to this round's sealed runner, compiled API and dependencies. */
export async function verifyRoundDistributionSource({ input, source, layout, proof, runnerDir, privatePath }) {
  const moduleName = "finance/distribution-policy-change.js", validatorName = "local-distribution-qualification-plan.mjs";
  assert(layout?.extraEntrypoints?.includes("finance/distribution-policy-change") && Array.isArray(proof?.closureFiles), "ROUND_DISTRIBUTION_DEPENDENCY_REQUIRED");
  assertListedRunnerScripts(runnerDir, layout.scriptFiles);
  const { verifyLegacyDistributionPrerequisite } = await import(pathToFileURL(join(runnerDir, validatorName)).href);
  const api = resolve(input.apiDist), parserPath = join(api, moduleName), moduleSha = input.buildFiles?.[moduleName];
  assert(/^[a-f0-9]{64}$/.test(moduleSha ?? "") && fileSha(parserPath) === moduleSha, "ROUND_DISTRIBUTION_PARSER_CHANGED");
  const previousNodePath = process.env.NODE_PATH;
  try {
    process.env.NODE_PATH = layout.moduleDirs.join(process.platform === "win32" ? ";" : ":"); Module._initPaths();
    const require = createRequire(join(layout.sourceRoot, "apps/api/package.json"));
    const { canonicalize } = require(join(api, "supply/content-hash.js")), { parseDistributionPolicyChange } = require(parserPath);
    let growthCommitGuardSha256, growthFenceGuardVersion;
    if (input.growth?.approvalLayout === 'INLINE_INTENT_V1' || input.target?.migrationProfile === NEXT_MIGRATION_PROFILE) {
      const name = 'auth/membership-growth-legacy-cli.js', file = join(api, name);
      growthCommitGuardSha256 = input.buildFiles?.[name];
      assert(/^[a-f0-9]{64}$/.test(growthCommitGuardSha256 ?? '') && fileSha(file) === growthCommitGuardSha256, 'ROUND_GROWTH_PRECOMMIT_GUARD_REQUIRED');
      delete require.cache[require.resolve(file)];
      const growth = require(file);
      assert.equal(growth.LEGACY_GROWTH_PRECOMMIT_GUARD_VERSION, 'v1', 'ROUND_GROWTH_PRECOMMIT_GUARD_REQUIRED');
      if (input.target?.migrationProfile === NEXT_MIGRATION_PROFILE) {
        assert.equal(growth.LEGACY_GROWTH_TARGET_FENCE_GUARD_VERSION, 'v1', 'ROUND_GROWTH_TARGET_FENCE_GUARD_REQUIRED');
        growthFenceGuardVersion = 'v1';
      }
    }
    const evidence = await verifyLegacyDistributionPrerequisite({ sourceDir: privatePath(input.source.path), receipt: source,
      sourceSha256: input.source.sha256, canonicalize, parsePolicy: parseDistributionPolicyChange, safePath: privatePath });
    const dependencies = new Map(proof.closureFiles);
    for (const file of Object.keys(require.cache)) {
      const compiled = relative(api, file).replaceAll("\\", "/");
      if (compiled && !compiled.startsWith("../") && !isAbsolute(compiled))
        assert(fileSha(file) === input.buildFiles[compiled], "ROUND_DISTRIBUTION_BUILD_CHANGED");
      if (file.toLowerCase().includes("node_modules")) {
        const path = relative(layout.sourceRoot, file).replaceAll("\\", "/");
        assert(path && !path.startsWith("../") && !isAbsolute(path) && dependencies.get(path) === fileSha(file), "ROUND_DISTRIBUTION_DEPENDENCY_CHANGED");
      }
    }
    return { ...evidence, validatorSha256: layout.scriptFiles[validatorName], policyParserSha256: moduleSha, ...(growthCommitGuardSha256 ? { growthCommitGuardSha256 } : {}), ...(growthFenceGuardVersion ? { growthFenceGuardVersion } : {}) };
  } finally {
    if (previousNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = previousNodePath;
    Module._initPaths();
  }
}

export function probeRoundDependencies(layout, spawn = spawnSync) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)));
  env.NODE_PATH = layout.moduleDirs.join(process.platform === "win32" ? ";" : ":");
  const modules=[...ROUND_MODULES,...(layout.extraEntrypoints??[])];
  const result = spawn(process.execPath, ["-e", childCode, layout.apiDist, layout.sourceRoot, JSON.stringify(modules)], { cwd: layout.sourceRoot, env, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert(result.status === 0 && result.signal === null, "ROUND_DEPENDENCY_CLOSURE_NOT_LOADABLE");
  const output = JSON.parse(result.stdout); assert(Array.isArray(output.files) && output.files.length > 0 && output.entrypoints === modules.length, "ROUND_DEPENDENCY_PROBE_INVALID");
  return { ...layout, nodeVersion: process.version, closureFiles: output.files, closureSha256: sha(JSON.stringify(output.files)), entrypoints: output.entrypoints };
}

export function assertRoundDependencyProof(proof, expected) {
  assert(proof?.status === "ROUND_DEPENDENCY_CLOSURE_VERIFIED" && proof.nodeVersion === process.version && proof.apiDist === expected.apiDist
    && proof.bundleSha256 === expected.bundleSha256 && proof.buildManifestSha256 === expected.buildManifestSha256
    && proof.sourceRoot === expected.sourceRoot && proof.sourceSnapshot === expected.sourceSnapshot && proof.sourceManifestSha256 === expected.sourceManifestSha256
    && proof.scriptDir === expected.scriptDir && JSON.stringify(proof.moduleDirs) === JSON.stringify(expected.moduleDirs)
    && JSON.stringify(proof.scriptFiles) === JSON.stringify(expected.scriptFiles) && JSON.stringify(proof.extraEntrypoints??[])===JSON.stringify(expected.extraEntrypoints??[])
    && Array.isArray(proof.closureFiles) && proof.closureFiles.length > 0
    && sha(JSON.stringify(proof.closureFiles)) === proof.closureSha256 && proof.entrypoints === ROUND_MODULES.length+(expected.extraEntrypoints??[]).length, "ROUND_DEPENDENCY_PROOF_CHANGED");
  for (const [relative, digest] of proof.closureFiles) {
    assert(typeof relative === "string" && !isAbsolute(relative) && !relative.split("/").includes("..") && /^[a-f0-9]{64}$/.test(digest), "ROUND_DEPENDENCY_FILE_INVALID");
    assert.equal(fileSha(join(expected.sourceRoot, relative)), digest, "ROUND_DEPENDENCY_FILE_CHANGED:" + basename(relative));
  }
}

async function main() {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (!args.includes("--probe")) { console.log(JSON.stringify({ status: "PLAN_ONLY", required: ["--probe", "--api-dist", "--bundle", "--bundle-sha", "--build-manifest", "--build-manifest-sha", "--source-snapshot", "--source-manifest", "--source-manifest-sha", "--out"], connections: 0, targetWrites: 0 })); return; }
  const out = resolve(option("--out") ?? ""), restricted = resolve("E:/zzsh-local-state/restricted");
  assert(dirname(out).toLowerCase() === restricted.toLowerCase() && /^round0[67]-dependency-proof-[a-z0-9-]+$/i.test(basename(out)) && !existsSync(out), "NEW_DEPENDENCY_PROOF_REQUIRED");
  const started = performance.now(), startedAt = new Date().toISOString(), layout = inspectRoundDependencyLayout({ apiDist: resolve(option("--api-dist") ?? ""), bundlePath: resolve(option("--bundle") ?? ""), bundleSha256: option("--bundle-sha"), buildManifestPath: resolve(option("--build-manifest") ?? ""), buildManifestSha256: option("--build-manifest-sha"), sourceSnapshot: resolve(option("--source-snapshot") ?? ""), sourceManifestPath: resolve(option("--source-manifest") ?? ""), sourceManifestSha256: option("--source-manifest-sha") });
  const proof = { schema: basename(out).toLowerCase().startsWith("round07-") ? "zzsh.round07-dependency-proof.v1" : "zzsh.round06-dependency-proof.v1", status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", startedAt, ...probeRoundDependencies(layout), finishedAt: new Date().toISOString(), wallMs: performance.now() - started, connections: 0, targetWrites: 0 };
  writePrivate(join(out, "proof.json"), proof);
  console.log(JSON.stringify({ status: proof.status, entrypoints: proof.entrypoints, dependencyFiles: proof.closureFiles.length, closureSha256: proof.closureSha256, wallMs: proof.wallMs, proof: join(out, "proof.json"), sha256: fileSha(join(out, "proof.json")), connections: 0, targetWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
