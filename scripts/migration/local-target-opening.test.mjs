import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { openingReviewResource } from "./local-target-opening.mjs";

const source = readFileSync(new URL("./local-target-opening.mjs", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("next-round finance review carries the pinned cluster and epoch without changing old resource shapes", () => {
  const ctx = { targetPort: 55435, state: { binding: { oid: "42", nonce: "a".repeat(24), migrationProfile: "LOCAL_MIGRATION_NEXT_V1",
    instance: { host: "127.0.0.1", port: 55435, systemIdentifier: "12345" } }, resource: { owner: "zzsh", marker: "marker", role: "role", role_oid: "43" } } };
  const resource = openingReviewResource(ctx);
  assert.deepEqual([resource.port, resource.migrationProfile, resource.systemIdentifier, resource.nonce], [55435, "LOCAL_MIGRATION_NEXT_V1", "12345", "a".repeat(24)]);
  const old = structuredClone(ctx); delete old.state.binding.migrationProfile; old.targetPort = 55433;
  assert.equal(Object.hasOwn(openingReviewResource(old), "systemIdentifier"), false);
});

async function rejectOpening(cause) {
  const data = Buffer.from("fixture source\n");
  const manifest = Buffer.from(JSON.stringify({ status: "REVIEWED_CANDIDATES_TARGET_NOT_RUN", datasetSha256: "dataset", file: "openings.jsonl", sha256: sha(data), stats: { candidate: 1, reviewRequired: 0 } }));
  const row = { state: "CANDIDATE", input: { inputSha256: "input", cutoff: "cutoff", proof: { userId: "user", source: { sourceId: "id", identityDigest: "identity" }, sourceDigest: "source", availableCents: "0", coveredDigest: "covered", coveredCount: 0 }, observations: [], admissions: [] } };
  const finance = { async bindReviewedStoredOpeningAdmissionBatch() { throw cause; } };
  const ctx = {
    targetPort: 55433, actor: { userId: "actor", sessionId: "session" },
    state: { binding: { oid: "42", datasetSha256: "dataset" }, resource: { owner: "owner", marker: "marker", role: "role", role_oid: "43" } },
    mod: name => name === "finance/personal-finance-maintenance" ? finance : { canonicalize: JSON.stringify },
    save() {}, async *readRows() { yield row; },
    async runBatches(_phase, candidates, run) { const batch = []; for await (const item of candidates) batch.push(item); await run(batch); },
  };
  const make = new AsyncFunction("createHash", "createReadStream", "readFileSync", "join", "resolve", "basename", source + "\nreturn { applyOpeningDomain };");
  const { applyOpeningDomain } = await make(createHash, () => Readable.from([data]), () => manifest, path.join, path.resolve, path.basename);
  try { await applyOpeningDomain(ctx, "E:/zzsh-local-state/restricted/fixture-openings", sha(manifest)); }
  catch (error) { return error; }
  assert.fail("expected rejection");
}

test("opening rejection preserves a safe code without exposing sensitive cause details", async () => {
  const original = Object.assign(new Error("secret-token-or-personal-data"), { code: "23505", detail: "private detail" });
  const error = await rejectOpening(original);
  assert.equal(error.message, "TARGET_REVIEWED_OPENING_REJECTED");
  assert.equal(error.code, "23505");
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /secret-token-or-personal-data|private detail/);
});

test("unsafe or absent cause codes never enter the migration receipt", async () => {
  for (const cause of [null, { code: "secret token", message: "private" }, { code: "x".repeat(200) }]) {
    const error = await rejectOpening(cause);
    assert.equal(error.message, "TARGET_REVIEWED_OPENING_REJECTED");
    assert.equal(error.code, "TARGET_REVIEWED_OPENING_REJECTED");
    assert.equal(error.cause, undefined);
  }
});
