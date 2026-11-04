import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import sharp from "sharp";
import { planAccountMediaReferences, planAccountMediaImport, projectAccountMediaSlots, scanAccountMediaBatch, scanAccountMediaReferences } from "./legacy-account-media-plan.mjs";

const input = row => ({ sourceSnapshotSha256: "a".repeat(64), accountId: "account_1", ownerUserId: "user_1", row: { id: "11", user_id: "22", ...row } });

test("source CSV keeps first occurrence and separates evidence, missing and unsafe values", () => {
  const plan = planAccountMediaReferences(input({ img_paths: " x.png, , y.png, x.png,../bad.png,https://bad.invalid/a.png ", punishment_img_url: "https://private.invalid/proof" }));
  assert.deepEqual(plan.references.map(ref => [ref.field, ref.sourceToken, ref.ordinal, ref.position, ref.state]), [
    ["img_paths", "x.png", 0, 0, "PENDING_IMPORT"], ["img_paths", "y.png", 2, 1, "PENDING_IMPORT"],
    ["img_paths", "../bad.png", 4, 2, "ISOLATED"], ["img_paths", "https://bad.invalid/a.png", 5, 3, "ISOLATED"],
    ["punishment_img_url", "https://private.invalid/proof", 0, 0, "ISOLATED"],
  ]);
  assert.equal(plan.references.at(-1).purpose, "ACCOUNT_EVIDENCE");
  assert.equal(planAccountMediaReferences(input({ img_paths: " , " })).fields.img_paths.observation, "EMPTY");
  assert.equal(planAccountMediaReferences(input({ img_paths: null })).fields.img_paths.observation, "NULL");
  assert.equal(planAccountMediaReferences(input({})).fields.img_paths.observation, "ABSENT");
  const unbound = planAccountMediaReferences({ ...input({ img_paths: "x.png" }), accountId: null, ownerUserId: null });
  assert.equal(unbound.bindingState, "UNBOUND");
  assert.equal(unbound.references[0].state, "PENDING_IMPORT");
});

test("partial downloads do not become ready; equal bytes dedupe and conflicts isolate", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-plan-"));
  const first = join(root, "20261030"), second = join(root, "20261031"), a = join(first, "x.png"), b = join(second, "x.png"), jpeg = join(first, "orientation.jpg");
  try {
    await mkdir(first); await mkdir(second);
    const red = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#c4363a" } }).png().toBuffer();
    const blue = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#1122cc" } }).png().toBuffer();
    await writeFile(a, red); await writeFile(b, red);
    const source = planAccountMediaReferences(input({ img_paths: "x.png,missing.png" }));
    const same = await scanAccountMediaReferences(source, root);
    const found = same.references[0];
    assert.equal(found.state, "PENDING_IMPORT");
    assert.equal(found.reason, "FOUND_BASENAME_INDEX_REQUIRED");
    assert.equal(found.candidates.length, 2);
    assert.equal(found.candidates[0].sha256, found.candidates[1].sha256);
    assert.equal(same.references[1].reason, "BYTES_NOT_FOUND");
    assert.throws(() => planAccountMediaImport(found, {}), /REVIEWED_SOURCE_ASSOCIATION_REQUIRED/);
    const paths = found.candidates.map(item => item.path);
    const evidenceSha256 = createHash("sha256").update(JSON.stringify([...paths].sort())).digest("hex");
    const proposed = planAccountMediaImport(found, { kind: "UNIQUE_PATH_INDEX", referenceId: found.referenceId, paths, evidenceSha256 });
    assert.equal(proposed.status, "READY_FOR_REVIEWED_UPLOAD");
    assert.equal(proposed.databaseWrites, 0);
    await writeFile(b, blue);
    const conflict = await scanAccountMediaReferences(source, root);
    assert.equal(conflict.references[0].state, "ISOLATED");
    assert.equal(conflict.references[0].reason, "AMBIGUOUS_BASENAME");
    assert.throws(() => planAccountMediaImport(conflict.references[0], {}), /REVIEWED_SOURCE_ASSOCIATION_REQUIRED/);
    const exactSource = planAccountMediaReferences(input({ img_paths: "accountsImage/20261030/x.png", punishment_img_url: "accountsImage/20261030/x.png,accountsImage/20261031/x.png" }));
    const exact = await scanAccountMediaReferences(exactSource, root);
    assert.equal(exact.references[0].reason, "FOUND_EXACT_SOURCE_PATH");
    assert.equal(exact.references[0].candidates.length, 1);
    assert.equal(planAccountMediaImport(exact.references[0]).path, "20261030/x.png");
    assert.equal(exact.references.filter(ref => ref.purpose === "ACCOUNT_EVIDENCE").length, 2);
    const batch = await scanAccountMediaBatch([exactSource, source], root);
    assert.equal(batch.length, 2);
    assert.equal(batch[0].references[0].reason, "FOUND_EXACT_SOURCE_PATH");
    assert.equal(batch[1].references[0].reason, "AMBIGUOUS_BASENAME");
    await writeFile(jpeg, await sharp({ create: { width: 4, height: 3, channels: 3, background: "#1122cc" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    const oriented = await scanAccountMediaReferences(planAccountMediaReferences(input({ img_paths: "accountsImage/20261030/orientation.jpg" })), root);
    const image = oriented.references[0].candidates[0];
    assert.deepEqual([image.width, image.height, image.mime], [3, 4, "image/jpeg"]);
    assert.notEqual(image.sha256, image.publicDerivative.sha256);
  } finally { await rm(a, { force: true }); await rm(b, { force: true }); await rm(jpeg, { force: true }); await rmdir(first); await rmdir(second); await rmdir(root); }
});

test("public projection excludes private evidence and requires public asset qualification", () => {
  const plan = planAccountMediaReferences(input({ img_paths: "x.png,y.png", punishment_img_url: "proof.png" }));
  assert.deepEqual(projectAccountMediaSlots(plan), []);
  plan.references[1] = { ...plan.references[1], state: "READY", assetId: "asset_1" };
  assert.deepEqual(projectAccountMediaSlots(plan, { publicEligible: true }), [{ position: 0, state: "PENDING_IMPORT" }, { position: 1, state: "UNAVAILABLE" }]);
  assert.deepEqual(projectAccountMediaSlots(plan, { publicEligible: true, verifiedPublicAssetIds: new Set(["asset_1"]) }), [{ position: 0, state: "PENDING_IMPORT" }, { position: 1, state: "READY", assetId: "asset_1" }]);
  plan.references.at(-1).field = "img_paths";
  assert.equal(projectAccountMediaSlots(plan, { publicEligible: true }).length, 2, "private evidence is never projected even if its field is malformed");
});
