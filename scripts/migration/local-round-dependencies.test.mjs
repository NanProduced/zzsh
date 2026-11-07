import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRoundDependencyProof, assertBoundRunnerScripts, probeRoundDependencies, ROUND_MODULES } from "./local-round-dependencies.mjs";
const ROUND_MODULE_COUNT = ROUND_MODULES.length;

test("dependency probe validates the actual module count and rejects incomplete results", () => {
  const layout = { apiDist:"api", sourceRoot:"source", moduleDirs:["a","b"] };
  const spawn = (_bin,_args) => ({status:0,signal:null,stdout:JSON.stringify({files:[["node_modules/pkg/index.js","a".repeat(64)]],entrypoints:ROUND_MODULE_COUNT})});
  assert.equal(probeRoundDependencies(layout,spawn).entrypoints,ROUND_MODULE_COUNT);
  assert.throws(() => probeRoundDependencies(layout,()=>({status:0,signal:null,stdout:JSON.stringify({files:[["x","a"]],entrypoints:0})})),/ROUND_DEPENDENCY_PROBE_INVALID/);
});

test("the invoking runner and its direct imports match the sealed scripts", t => {
  const root = mkdtempSync(join(tmpdir(),"round-runner-")), dir=join(root,"migration");t.after(()=>rmSync(root,{recursive:true}));mkdirSync(dir);
  const files=["run-local-round.mjs","local-round-contract.mjs","local-round-dependencies.mjs","local-load-checkpoint.mjs","full-source-scope.mjs","local-target-registry.mjs","../local-auth.mjs"];
  const digest={};for(const file of files){writeFileSync(join(dir,file),file);digest[file]=createHash("sha256").update(file).digest("hex");}
  assert.doesNotThrow(()=>assertBoundRunnerScripts(dir,digest));writeFileSync(join(dir,"local-target-registry.mjs"),"changed");
  assert.throws(()=>assertBoundRunnerScripts(dir,digest),/ROUND_DEPENDENCY_RUNNER_CHANGED/);
});

test("dependency proof rejects changed bytes, changed script lineage and path escape", t => {
  const root = mkdtempSync(join(tmpdir(), "round-deps-")); t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true }); const file = join(root, "node_modules/pkg/index.js"); writeFileSync(file, "module.exports=1;\n");
  const hash = value => createHash("sha256").update(value).digest("hex"), files = [["node_modules/pkg/index.js", hash("module.exports=1;\n")]];
  const expected = { apiDist: "api", sourceRoot: root, sourceSnapshot: "snapshot", sourceManifestSha256: "source", scriptDir: "scripts", moduleDirs: ["modules"], bundleSha256: "bundle", buildManifestSha256: "manifest", scriptFiles: { "loader.mjs": "digest" } };
  const proof = { ...expected, status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", nodeVersion: process.version, closureFiles: files, closureSha256: hash(JSON.stringify(files)), entrypoints: ROUND_MODULE_COUNT };
  assert.doesNotThrow(() => assertRoundDependencyProof(proof, expected));
  assert.throws(() => assertRoundDependencyProof({ ...proof, scriptFiles: {} }, expected), /ROUND_DEPENDENCY_PROOF_CHANGED/);
  const escape = [["../outside", hash("anything")]];
  assert.throws(() => assertRoundDependencyProof({ ...proof, closureFiles: escape, closureSha256: hash(JSON.stringify(escape)) }, expected), /ROUND_DEPENDENCY_FILE_INVALID/);
  writeFileSync(file, "module.exports=2;\n"); assert.throws(() => assertRoundDependencyProof(proof, expected), /ROUND_DEPENDENCY_FILE_CHANGED/);
});
