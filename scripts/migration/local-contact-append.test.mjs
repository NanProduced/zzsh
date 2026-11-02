import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { applyNumberBindings, applyContactAppend, applyCancelledContactCorrections, verifyFullContactProjection } from "./local-target-contact-append.mjs";
import { prepareLocalStoredOpening } from "./local-opening-proof.mjs";

const here = dirname(fileURLToPath(import.meta.url)), dirs = [], sha = bytes => createHash("sha256").update(bytes).digest("hex");
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "zzsh-contact-append-")); dirs.push(path); return path; };
after(() => { for (const path of dirs) { assert.equal(dirname(path), tmpdir()); assert.ok(path.split(/[\\/]/).at(-1).startsWith("zzsh-contact-append-")); rmSync(path, { recursive: true }); } });

for (const cli of ["prepare-legacy-contact-append.mjs", "load-local-dataset.mjs"]) test(cli + " defaults to a plan before private input access", () => {
  const result = spawnSync(process.execPath, [join(here, cli), "--dataset", "DOES_NOT_EXIST", "--credentials", "DOES_NOT_EXIST"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout); assert.equal(plan.action, "PLAN"); assert.equal(plan.connections, 0);
});
test("preparation cannot turn into an execute or apply entry", () => {
  for (const action of ["--execute", "--apply"]) {
    const result = spawnSync(process.execPath, [join(here, "prepare-legacy-contact-append.mjs"), action], { encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /PREPARATION_ONLY_NO_TARGET_WRITER/);
  }
});

function context() {
  const output = temporary(), queries = [], calls = [], source = [{ sourceId: "11", userId: "user-11", input: { sourceDigest: "a".repeat(64), sourceSn: "001001", expectedTargetDigest: null } }];
  const target = { id: "user-11", migrationSourceDigest: "a".repeat(64), migrationLegacyId: "11", username: null, displayUsername: null, phoneNumber: null, accountStatus: "ACTIVE", updatedAt: "old" };
  const state = { phases: {}, generatedPhases: {}, pending: null };
  const writer = { readLegacyOwnerContactTargets: async (client, ids) => { assert.deepEqual(ids, ["user-11"]); return [{ ...target }]; }, legacyOwnerContactTargetDigest: value => sha(JSON.stringify(value)),
    bindLegacyOwnerNumber: async (client, input) => { assert.match(input.expectedTargetDigest, /^[a-f0-9]{64}$/); calls.push(input); target.username = input.sourceSn; target.displayUsername = input.sourceSn; return { replayed: false }; } };
  const ctx = { output, state, actor: { id: "boss", sessionId: "session" }, manifest: { counts: { publicNumberOnlyBindings: 1, exactAuthenticationReadbackSubjects: 1 }, files: { "public-number-bindings": { sha256: "b".repeat(64) } } },
    client: { query: async sql => { queries.push(sql); return { rows: [] }; } }, mod: () => writer, domainFile: name => name,
    readRows: async function* (file) { if (file === "authentication-projections") yield { sourceId: "11", userId: "user-11", sourceDigest: "a".repeat(64), sourceSn: "001001", authenticationPhone: null, accountStatus: "ACTIVE", decision: "NO_SOURCE_PHONE" }; else for (const row of source) yield row; }, save() {}, event() {},
    runItems: async (domain, rows, body) => { for (const row of rows) await body(row); state.phases[domain] = { quarantined: 0, complete: true }; } };
  return { ctx, source, target, queries, calls };
}
test("number-only coordinator durably binds fresh CAS before writer and reuses the same body", async () => {
  const f = context(); await applyNumberBindings(f.ctx);
  assert.deepEqual(f.queries, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"]);
  const first = f.calls[0]; f.target.updatedAt = "new";
  await applyNumberBindings(f.ctx); assert.deepEqual(f.calls[1], first); assert.equal(f.queries.length, 6);
  assert.equal(f.ctx.state.generatedPhases.publicNumberBindings.rows, 1);
});
test("changed CAS file, missing source provenance and rejected rows cannot report completion", async () => {
  const f = context(); await applyNumberBindings(f.ctx);
  writeFileSync(join(f.ctx.output, "phases/publicNumberBindings.json"), "[]");
  await assert.rejects(() => applyNumberBindings(f.ctx), /FROZEN_CAS_CHANGED/);
  const g = context(); g.target.migrationSourceDigest = "c".repeat(64);
  await assert.rejects(() => applyNumberBindings(g.ctx), /SOURCE_TARGET_NOT_BOUND/); assert.equal(g.calls.length, 0);
  assert.equal(g.queries.at(-1), "ROLLBACK");
  const h = context(); h.ctx.runItems = async (domain) => { h.ctx.state.phases[domain] = { quarantined: 1 }; };
  await assert.rejects(() => applyNumberBindings(h.ctx), /NOT_COMPLETE/);
});
test("contact correction rejection stops before new subjects, orders or money", async () => {
  const f = context(); f.ctx.manifest.files["contact-corrections"] = { sha256: "b".repeat(64) };
  f.ctx.mod = () => ({ readLegacyOwnerContactTargets: async () => [{ ...f.target }], legacyOwnerContactTargetDigest: value => sha(JSON.stringify(value)) });
  f.ctx.runItems = async domain => { f.ctx.state.phases[domain] = { quarantined: 1 }; };
  let writes = 0;
  await assert.rejects(() => applyContactAppend(f.ctx, { applyUsers: async () => writes++, applyAccounts: async () => writes++, applyOrders: async () => writes++ }), /CONTACT_CORRECTIONS_NOT_COMPLETE/);
  assert.equal(writes, 0);
});
test("cancelled-contact phase accepts only CANCELLED plus an explicit null phone", async () => {
  for (const invalid of [false, true]) {
    const f = context(); f.ctx.manifest.files["cancelled-contact-corrections"] = { sha256: "b".repeat(64) };
    f.source[0].input.evidence = { sourceDigest: "a".repeat(64), status: { deleted: true }, contactProjection: { decision: "CANCELLED", authenticationPhone: invalid ? "+8619900000001" : null } };
    let writes = 0; const original = f.ctx.mod;
    f.ctx.mod = name => ({ ...original(name), reconcileLegacyOwnerContactProjection: async () => { writes++; return { replayed: false }; } });
    if (invalid) { await assert.rejects(() => applyCancelledContactCorrections(f.ctx), /MUST_ONLY_UNBIND/); assert.equal(writes, 0); }
    else { await applyCancelledContactCorrections(f.ctx); assert.equal(writes, 1); }
  }
});
test("full-source readback rejects mismatched phone and keeps its separate difference report", async () => {
  const f = context(); f.target.username = "001001"; f.target.displayUsername = "001001"; f.target.phoneNumber = "+8619900000001";
  await assert.rejects(() => verifyFullContactProjection(f.ctx), /READBACK_FAILED/);
  assert.equal(f.ctx.state.fullAuthenticationReconciliation.mismatches.length, 1);
  assert.equal(f.queries.at(-1), "ROLLBACK");
});

test("opening preparation uses the formal original balance proof without summing flows", () => {
  const require = createRequire(import.meta.url), api = resolve(process.env.ZZSH_TEST_API_DIST ?? join(here, "../../apps/api/dist/src"));
  const modules = { preparation: require(join(api, "finance/legacy-finance-source-preparation.js")), proof: require(join(api, "finance/legacy-finance-source-evidence.js")), canonical: require(join(api, "supply/content-hash.js")).canonicalize };
  const balance = { sourceId: "11", userId: "fixture-user", sourceDigest: "a".repeat(64), source: { id: "11", earnings: "1.10", money: "-2.00" }, amounts: { earnings: "110", money: "-200" } };
  const ctx = { modules, logs: new Map(), orders: new Map(), withdraws: new Map(), distributions: new Map(), cutoff: "2026-09-13T13:31:13.000Z", inputSha256: "b".repeat(64), sourceExtractSha256: "c".repeat(64) };
  const ready = prepareLocalStoredOpening(balance, ctx); assert.equal(ready.state, "CANDIDATE"); assert.equal(ready.input.proof.availableCents, "110");
  ctx.logs.set("11", [{ id: "10", sn: "LOG", action: "2", change_amount: "1.10", left_amount: "0.00", user_id: "11", source_id: "99", create_time: "1779469800", change_type: "1002" }]);
  const missing = prepareLocalStoredOpening(balance, ctx); assert.equal(missing.state, "REVIEW_REQUIRED"); assert.equal(missing.reason, "ECONOMIC_ROOT_OR_TIME_UNREAD");
  assert.equal(missing.input, undefined);
});
