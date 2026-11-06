import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { writePrivate } from "../local-auth.mjs";

export const ROUND_MODULES = ["auth/identity-subject", "auth/membership-growth", "auth/membership-growth-integration", "auth/membership-growth-legacy", "auth/membership-growth-legacy-cli",
  "auth/membership-growth-legacy-maintenance", "auth/membership-growth-legacy-store", "auth/auth-security", "auth/security-core", "credit/credit-initialization",
  "database/business-migrations", "finance/legacy-finance-source-preparation", "finance/legacy-invitation-facts", "finance/legacy-invitation-facts-maintenance",
  "finance/personal-finance-maintenance", "finance/personal-finance-observation-maintenance",
  "legacy-load/legacy-account-seam", "legacy-load/legacy-skin-holdings", "legacy-load/legacy-path-records", "order/legacy-continuation-evidence", "order/legacy-continuation-model",
  "order/legacy-growth-consumption", "order/legacy-liability-intake", "order/legacy-order-read", "profile/profile-avatar", "profile/profile-avatar-presets",
  "supply/content-hash", "supply/legacy-listing-read", "supply/legacy-observation", "supply/legacy-user-migration"];
const scriptNames = ["load-local-dataset.mjs", "local-load-checkpoint.mjs", "local-source-adapter.mjs", "local-target-finance.mjs", "local-funds-plan.mjs", "local-target-display.mjs", "local-target-opening.mjs",
  "local-target-holdings.mjs", "load-legacy-path-accounts.mjs", "readback-local-dataset.mjs", "run-local-growth.mjs", "local-growth-plan.mjs"];
const sha = value => createHash("sha256").update(value).digest("hex"), fileSha = file => sha(readFileSync(file));
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
    && manifest.schema === "zzsh.round06-preview-build.v1" && typeof manifest.layout?.apiDistDir === "string" && Array.isArray(manifest.components?.api), "ROUND_DEPENDENCY_BUILD_LINEAGE_CHANGED");
  const sourceRoot = resolve(dirname(buildManifestPath), "source"), scriptDir = join(sourceRoot, "scripts/migration"), moduleDirs = [join(sourceRoot, "apps/api/node_modules"), join(sourceRoot, "node_modules")];
  for (const directory of [sourceRoot, scriptDir, ...moduleDirs]) assert(existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), "ROUND_DEPENDENCY_DIRECTORY_REQUIRED");
  const prefix = manifest.layout.apiDistDir.replaceAll("\\", "/") + "/", finalBuild = Object.fromEntries(manifest.components.api.filter(row => row.path?.startsWith(prefix) && row.path.endsWith(".js")).map(row => [row.path.slice(prefix.length), row.sha256]));
  const copied = Object.fromEntries(bundle.entries.filter(row => row.path.startsWith("api-build/src/") && row.path.endsWith(".js")).map(row => [row.path.slice("api-build/src/".length), row.sha256]));
  assert.deepEqual(copied, finalBuild, "ROUND_DEPENDENCY_RUNTIME_BUILD_CHANGED");
  for (const file of ["package-lock.json", "node_modules/.package-lock.json"]) {
    const entry = manifest.components.api.find(row => row.path === file); assert(entry && fileSha(join(sourceRoot, file)) === entry.sha256, "ROUND_DEPENDENCY_LOCK_CHANGED:" + basename(file));
  }
  const scriptFiles = Object.fromEntries(scriptNames.map(file => [file, fileSha(join(scriptDir, file))]));
  for (const [file, digest] of Object.entries(scriptFiles)) assert.equal(fileSha(join(sourceSnapshot, "scripts/migration", file)), digest, "ROUND_DEPENDENCY_SNAPSHOT_SCRIPT_CHANGED:" + file);
  return { apiDist: resolve(apiDist), sourceRoot, sourceSnapshot: resolve(sourceSnapshot), sourceManifestSha256, scriptDir, moduleDirs, bundleSha256, buildManifestSha256, scriptFiles };
}

export function probeRoundDependencies(layout) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)));
  env.NODE_PATH = layout.moduleDirs.join(process.platform === "win32" ? ";" : ":");
  const result = spawnSync(process.execPath, ["-e", childCode, layout.apiDist, layout.sourceRoot, JSON.stringify(ROUND_MODULES)], { cwd: layout.sourceRoot, env, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert(result.status === 0 && result.signal === null, "ROUND_DEPENDENCY_CLOSURE_NOT_LOADABLE");
  const output = JSON.parse(result.stdout); assert(Array.isArray(output.files) && output.files.length > 0 && output.entrypoints === modules.length, "ROUND_DEPENDENCY_PROBE_INVALID");
  return { ...layout, nodeVersion: process.version, closureFiles: output.files, closureSha256: sha(JSON.stringify(output.files)), entrypoints: output.entrypoints };
}

export function assertRoundDependencyProof(proof, expected) {
  assert(proof?.status === "ROUND_DEPENDENCY_CLOSURE_VERIFIED" && proof.nodeVersion === process.version && proof.apiDist === expected.apiDist
    && proof.bundleSha256 === expected.bundleSha256 && proof.buildManifestSha256 === expected.buildManifestSha256
    && proof.sourceRoot === expected.sourceRoot && proof.sourceSnapshot === expected.sourceSnapshot && proof.sourceManifestSha256 === expected.sourceManifestSha256
    && proof.scriptDir === expected.scriptDir && JSON.stringify(proof.moduleDirs) === JSON.stringify(expected.moduleDirs)
    && JSON.stringify(proof.scriptFiles) === JSON.stringify(expected.scriptFiles) && Array.isArray(proof.closureFiles) && proof.closureFiles.length > 0
    && sha(JSON.stringify(proof.closureFiles)) === proof.closureSha256 && proof.entrypoints === ROUND_MODULES.length, "ROUND_DEPENDENCY_PROOF_CHANGED");
  for (const [relative, digest] of proof.closureFiles) {
    assert(typeof relative === "string" && !isAbsolute(relative) && !relative.split("/").includes("..") && /^[a-f0-9]{64}$/.test(digest), "ROUND_DEPENDENCY_FILE_INVALID");
    assert.equal(fileSha(join(expected.sourceRoot, relative)), digest, "ROUND_DEPENDENCY_FILE_CHANGED:" + basename(relative));
  }
}

async function main() {
  const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (!args.includes("--probe")) { console.log(JSON.stringify({ status: "PLAN_ONLY", required: ["--probe", "--api-dist", "--bundle", "--bundle-sha", "--build-manifest", "--build-manifest-sha", "--source-snapshot", "--source-manifest", "--source-manifest-sha", "--out"], connections: 0, targetWrites: 0 })); return; }
  const out = resolve(option("--out") ?? ""), restricted = resolve("E:/zzsh-local-state/restricted");
  assert(dirname(out).toLowerCase() === restricted.toLowerCase() && /^round06-dependency-proof-[a-z0-9-]+$/i.test(basename(out)) && !existsSync(out), "NEW_DEPENDENCY_PROOF_REQUIRED");
  const started = performance.now(), startedAt = new Date().toISOString(), layout = inspectRoundDependencyLayout({ apiDist: resolve(option("--api-dist") ?? ""), bundlePath: resolve(option("--bundle") ?? ""), bundleSha256: option("--bundle-sha"), buildManifestPath: resolve(option("--build-manifest") ?? ""), buildManifestSha256: option("--build-manifest-sha"), sourceSnapshot: resolve(option("--source-snapshot") ?? ""), sourceManifestPath: resolve(option("--source-manifest") ?? ""), sourceManifestSha256: option("--source-manifest-sha") });
  const proof = { schema: "zzsh.round06-dependency-proof.v1", status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", startedAt, ...probeRoundDependencies(layout), finishedAt: new Date().toISOString(), wallMs: performance.now() - started, connections: 0, targetWrites: 0 };
  writePrivate(join(out, "proof.json"), proof);
  console.log(JSON.stringify({ status: proof.status, entrypoints: proof.entrypoints, dependencyFiles: proof.closureFiles.length, closureSha256: proof.closureSha256, wallMs: proof.wallMs, proof: join(out, "proof.json"), sha256: fileSha(join(out, "proof.json")), connections: 0, targetWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
