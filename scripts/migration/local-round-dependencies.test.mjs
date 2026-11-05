import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRoundDependencyProof } from "./local-round-dependencies.mjs";

test("dependency proof rejects changed bytes, changed script lineage and path escape", t => {
  const root = mkdtempSync(join(tmpdir(), "round-deps-")); t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true }); const file = join(root, "node_modules/pkg/index.js"); writeFileSync(file, "module.exports=1;\n");
  const hash = value => createHash("sha256").update(value).digest("hex"), files = [["node_modules/pkg/index.js", hash("module.exports=1;\n")]];
  const expected = { apiDist: "api", sourceRoot: root, sourceSnapshot: "snapshot", sourceManifestSha256: "source", scriptDir: "scripts", moduleDirs: ["modules"], bundleSha256: "bundle", buildManifestSha256: "manifest", scriptFiles: { "loader.mjs": "digest" } };
  const proof = { ...expected, status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", nodeVersion: process.version, closureFiles: files, closureSha256: hash(JSON.stringify(files)), entrypoints: 32 };
  assert.doesNotThrow(() => assertRoundDependencyProof(proof, expected));
  assert.throws(() => assertRoundDependencyProof({ ...proof, scriptFiles: {} }, expected), /ROUND_DEPENDENCY_PROOF_CHANGED/);
  const escape = [["../outside", hash("anything")]];
  assert.throws(() => assertRoundDependencyProof({ ...proof, closureFiles: escape, closureSha256: hash(JSON.stringify(escape)) }, expected), /ROUND_DEPENDENCY_FILE_INVALID/);
  writeFileSync(file, "module.exports=2;\n"); assert.throws(() => assertRoundDependencyProof(proof, expected), /ROUND_DEPENDENCY_FILE_CHANGED/);
});
