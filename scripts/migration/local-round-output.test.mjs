import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";
import { assertSameDirectoryResumeSafe, inspectRoundResumeOutput, isRoundReceiptPath, reserveRoundResumeOutput } from "./local-load-checkpoint.mjs";

const inputSha256 = "a".repeat(64);
const hash = value => createHash("sha256").update(value).digest("hex");
const receipt = fields => ({ schema: "zzsh.local-round-receipt.v1", inputSha256, status: "STOPPED_PRESERVE_ORIGINAL_KEYS_AND_RECEIPTS", stages: [], ...fields });

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "zzsh-round-output-test-"));
  try {
    mkdirSync(join(root, "loader"));
    writeFileSync(join(root, "loader", "checkpoint.json"), "original checkpoint");
    writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ failure: { stage: "opening" } })));
    writeFileSync(join(root, "opening.stdout.log"), "original stdout");
    writeFileSync(join(root, "opening.stderr.log"), "original stderr");
    run(root);
  } finally {
    assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("zzsh-round-output-test-"));
    rmSync(root, { recursive: true });
  }
}

test("resumes retain original receipt and logs and bind each successive attempt", () => fixture(root => {
  const original = readFileSync(join(root, "round-receipt.json"));
  const first = inspectRoundResumeOutput(root, inputSha256);
  assert.equal(first.sequence, 1);
  assert.equal(first.previousReceipt.sha256, hash(original));
  const firstDir = reserveRoundResumeOutput(root, first);
  const firstBytes = Buffer.from(JSON.stringify(receipt({ sameDirectoryResume: first })));
  writeFileSync(join(firstDir, "round-receipt.json"), firstBytes, { flag: "wx" });
  writeFileSync(join(firstDir, "opening.stdout.log"), "retry stdout", { flag: "wx" });
  writeFileSync(join(firstDir, "opening.stderr.log"), "retry stderr", { flag: "wx" });
  const second = inspectRoundResumeOutput(root, inputSha256);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousReceipt.sha256, hash(firstBytes));
  const secondDir = reserveRoundResumeOutput(root, second);
  writeFileSync(join(secondDir, "round-receipt.json"), JSON.stringify(receipt({ sameDirectoryResume: second })), { flag: "wx" });
  assert.deepEqual(readFileSync(join(root, "round-receipt.json")), original);
  assert.equal(readFileSync(join(root, "opening.stdout.log"), "utf8"), "original stdout");
  assert.equal(readFileSync(join(root, "opening.stderr.log"), "utf8"), "original stderr");
  assert.equal(readFileSync(join(firstDir, "opening.stdout.log"), "utf8"), "retry stdout");
  assert.equal(inspectRoundResumeOutput(root, inputSha256).sequence, 3);
  assert.equal(isRoundReceiptPath(root, join(root, "round-receipt.json")), true);
  assert.equal(isRoundReceiptPath(root, join(firstDir, "round-receipt.json")), true);
  assert.equal(isRoundReceiptPath(root, join(root, "round-attempt-000000", "round-receipt.json")), false);
  assert.equal(isRoundReceiptPath(root, join(root, "other", "round-receipt.json")), false);
}));

test("a racing or unfinished attempt never overwrites evidence or advances silently", () => fixture(root => {
  const attempt = inspectRoundResumeOutput(root, inputSha256);
  const attemptDir = reserveRoundResumeOutput(root, attempt);
  assert.throws(() => reserveRoundResumeOutput(root, attempt), /EEXIST/);
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
  assert.equal(existsSync(join(attemptDir, "round-receipt.json")), false);
}));

test("changed input or prior receipt refuses automatic resume", () => fixture(root => {
  assert.throws(() => inspectRoundResumeOutput(root, "b".repeat(64)), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
  const first = inspectRoundResumeOutput(root, inputSha256);
  const firstDir = reserveRoundResumeOutput(root, first);
  writeFileSync(join(firstDir, "round-receipt.json"), JSON.stringify(receipt({ sameDirectoryResume: first })));
  writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ failure: { stage: "changed" } })));
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
}));

test("a missing checkpoint refuses automatic resume", () => fixture(root => {
  unlinkSync(join(root, "loader", "checkpoint.json"));
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
}));

test("later-stage history in any prior attempt blocks same-directory replay", () => fixture(root => {
  writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ stages: [{ name: "paths", status: "ACK" }, { name: "readback", status: "ACK" }] })));
  const first = inspectRoundResumeOutput(root, inputSha256);
  const firstDir = reserveRoundResumeOutput(root, first);
  writeFileSync(join(firstDir, "round-receipt.json"), JSON.stringify(receipt({ sameDirectoryResume: first, stages: [{ name: "opening", status: "INTENT" }] })));
  const latest = inspectRoundResumeOutput(root, inputSha256);
  assert.deepEqual(latest.stageNames, ["paths", "readback", "opening"]);
  assert.throws(() => assertSameDirectoryResumeSafe(latest, () => false), /ROUND_SAME_OUTPUT_STAGE_REQUIRES_SEPARATE_RECOVERY/);
}));

test("all fresh-only artifact paths block same-directory replay and early stages remain eligible", () => fixture(root => {
  const resume = inspectRoundResumeOutput(root, inputSha256);
  assert.doesNotThrow(() => assertSameDirectoryResumeSafe({ ...resume, stageNames: ["core-and-funds", "display", "opening", "holdings"] }, () => false));
  for (const name of ["path-execution", "readback.json", "growth-plan", "growth-execution", "growth-readback", "readback-final.json"]) {
    assert.throws(() => assertSameDirectoryResumeSafe(resume, actual => actual === name), /ROUND_SAME_OUTPUT_ARTIFACT_REQUIRES_SEPARATE_RECOVERY/);
  }
  assert.throws(() => assertSameDirectoryResumeSafe({ ...resume, stageNames: ["unknown-stage"] }, () => false), /ROUND_SAME_OUTPUT_STAGE_REQUIRES_SEPARATE_RECOVERY/);
}));

test("a completed original round cannot be treated as stopped", () => fixture(root => {
  writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ status: "DATASET_AND_GROWTH_ACK_READBACK_PASS" })));
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
}));

test("growth-only continuation accepts a completed data-only receipt without allowing a rewrite", () => fixture(root => {
  writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ status: "INCOMPLETE_GROWTH_NOT_PLANNED" })));
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
  assert.equal(inspectRoundResumeOutput(root, inputSha256, { allowGrowthContinuation: true }).sequence, 1);
  writeFileSync(join(root, "round-receipt.json"), JSON.stringify(receipt({ status: "RUNNING" })));
  assert.throws(() => inspectRoundResumeOutput(root, inputSha256, { allowGrowthContinuation: true }), /PRESERVE_ORIGINAL_ROUND_OUTPUT/);
}));
