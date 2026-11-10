import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import pg from "pg";
import { readBoundSourceRows } from "./local-source-adapter.mjs";
import { acquireMigrationSessionFence, advisoryLockSql, assertLiveTarget, assertMigrationFenceHeld, assertNextMigrationWriteReady, captureMaintenanceLockEpoch, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, releaseMigrationSessionFence, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--verify") && !args.includes("--apply")) { console.log(JSON.stringify({ action: "PLAN", required: ["--verify or --apply", "--plan-dir", "--plan-receipt-sha", "--source-plan-dir", "--source-dir", "--source-receipt-sha", "--api-dist"], applyAlsoRequires: ["--credentials", "--actor-file", "--oid", "--nonce", "--out"], dbConnections: 0, targetWrites: 0 })); process.exit(0); }
const apply = args.includes("--apply");
if (apply && process.platform !== "win32") throw new Error("WINDOWS_PRIVATE_ACL_REQUIRED");
const planDir = option("--plan-dir"), sourcePlanDir = option("--source-plan-dir"), sourceDir = option("--source-dir"), apiDist = option("--api-dist");
if (![planDir, sourcePlanDir, sourceDir, apiDist].every(path => path && isAbsolute(path))) throw new Error("ABSOLUTE_PATHS_REQUIRED");
const privateRoot = realpathSync("E:/zzsh-local-state/restricted");
for (const path of [planDir, sourcePlanDir, sourceDir]) {
  if (!resolve(path).toLowerCase().startsWith(privateRoot.toLowerCase() + "\\")) throw new Error("PRIVATE_INPUT_REQUIRED");
  let p = resolve(path); for (;;) { if (lstatSync(p).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(p); if (parent === p || p === parse(p).root) break; p = parent; }
}
const sha = value => createHash("sha256").update(value).digest("hex");
const readBound = (path, expected) => { const bytes = readFileSync(path); if (sha(bytes) !== expected) throw new Error("INPUT_RECEIPT_SHA_MISMATCH"); return JSON.parse(bytes); };
const plan = readBound(join(planDir, "receipt.json"), option("--plan-receipt-sha"));
const sourcePlan = readBound(join(sourcePlanDir, "receipt.json"), plan.sourcePlanReceiptSha256);
const source = readBound(join(sourceDir, "receipt.json"), option("--source-receipt-sha"));
if (plan.status !== "PREPARED_TARGET_NOT_RUN" || sourcePlan.status !== "SOURCE_REFERENCES_PLANNED_TARGET_NOT_RUN" || source.status !== "CAPTURED_READ_ONLY" || !source.rollbackConfirmed || !source.clientClosed || sourcePlan.sourceReceiptSha256 !== option("--source-receipt-sha") || sourcePlan.sourceAccountsSha256 !== source.files?.accounts?.sha256 || source.files?.accounts?.file !== "accounts.jsonl") throw new Error("SOURCE_BINDING_MISMATCH");
async function checkFile(path, expected) { const digest = createHash("sha256"); for await (const bytes of createReadStream(path)) digest.update(bytes); if (digest.digest("hex") !== expected) throw new Error("INPUT_FILE_SHA_MISMATCH"); }
const planFile = join(planDir, "account-paths.jsonl"), sourceFile = join(sourceDir, "accounts.jsonl");
const require = createRequire(import.meta.url), writer = require(join(resolve(apiDist), "legacy-load/legacy-path-records.js"));
if (typeof writer.prepareLegacyPathRecord !== "function" || typeof writer.recordLegacyPathRecords !== "function") throw new Error("BUILT_WRITER_REQUIRED");
const prepared = new Map(); let displayCount = 0, penaltyCount = 0;
for await (const item of readBoundSourceRows(planFile, { sha256: plan.fileSha256, rows: plan.accounts })) {
  if (!/^[1-9][0-9]*$/.test(item.legacyId ?? "") || prepared.has(item.legacyId) || !/^[a-f0-9]{64}$/.test(item.sourceDigest ?? "") || typeof item.ownerUserId !== "string") throw new Error("PATH_PLAN_INVALID");
  if (!Array.isArray(item.displayPaths) || !Array.isArray(item.penaltyPaths)) throw new Error("PATH_PLAN_INVALID");
  displayCount += item.displayPaths.length; penaltyCount += item.penaltyPaths.length;
  prepared.set(item.legacyId, { plan: item, sourceRow: null });
}
if (prepared.size !== plan.accounts || displayCount !== plan.displayPaths || penaltyCount !== plan.penaltyPaths) throw new Error("PATH_PLAN_COUNT_MISMATCH");
let matched = 0;
for await (const row of readBoundSourceRows(sourceFile, source.files.accounts)) {
  const entry = prepared.get(row.id); if (!entry) continue;
  if (entry.sourceRow || row.user_id !== entry.plan.legacyOwnerId) throw new Error("SOURCE_OWNER_MISMATCH");
  const actual = writer.prepareLegacyPathRecord(row);
  if (actual.ownerUserId !== entry.plan.ownerUserId || actual.sourceDigest !== entry.plan.sourceDigest || JSON.stringify(actual.displayPaths) !== JSON.stringify(entry.plan.displayPaths) || JSON.stringify(actual.penaltyPaths) !== JSON.stringify(entry.plan.penaltyPaths)) throw new Error("SOURCE_PATH_PLAN_MISMATCH");
  entry.sourceRow = row; matched++;
}
if (matched !== prepared.size) throw new Error("SOURCE_ACCOUNT_CLOSURE_MISMATCH");
await checkFile(planFile, plan.fileSha256); await checkFile(sourceFile, source.files.accounts.sha256);
if (!apply) { console.log(JSON.stringify({ status: "SOURCE_PLAN_VERIFIED_TARGET_NOT_RUN", accounts: matched, displayPaths: plan.displayPaths, penaltyPaths: plan.penaltyPaths, dbConnections: 0, targetWrites: 0 })); process.exit(0); }

const credentialsFile = option("--credentials"), actorFile = option("--actor-file"), expectedOid = option("--oid"), expectedNonce = option("--nonce"), out = option("--out");
const notBefore = option("--not-before"), expiresAt = option("--expires-at");
const withinWindow = () => {
  if ((notBefore || expiresAt) && !(Date.now() >= Date.parse(notBefore) && Date.now() < Date.parse(expiresAt))) throw new Error("PATH_LOAD_WINDOW_INACTIVE");
};
withinWindow();
if (![credentialsFile, actorFile, out].every(path => path && isAbsolute(path)) || !/^[0-9]+$/.test(expectedOid ?? "") || !/^[a-z0-9]{12,40}$/.test(expectedNonce ?? "")) throw new Error("EXACT_TARGET_AND_ACTOR_REQUIRED");
for (const path of [actorFile, out]) if (!resolve(path).toLowerCase().startsWith(privateRoot.toLowerCase() + "\\")) throw new Error("PRIVATE_PATH_REQUIRED");
for (const path of [actorFile, credentialsFile]) { let p = resolve(path); for (;;) { if (lstatSync(p).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(p); if (parent === p || p === parse(p).root) break; p = parent; } }
if (existsSync(out)) throw new Error("NEW_OUTPUT_REQUIRED");
const resource = JSON.parse(readFileSync(join(dirname(credentialsFile), "resource.json"))), credentials = JSON.parse(readFileSync(credentialsFile)), actorProof = JSON.parse(readFileSync(actorFile));
const registered = loadRegisteredTarget(credentialsFile);
if (apply) assertNextMigrationWriteReady(registered);
const actor = { id: actorProof.id ?? actorProof.actorId, sessionId: actorProof.sessionId };
if (actorProof.actorId && actorProof.actorId !== actor.id) throw new Error("TARGET_ACTOR_ALIASES_CONFLICT");
if (resource.database !== "zzsh_test_regression" || registered.database !== resource.database || registered.oid !== expectedOid || registered.nonce !== expectedNonce || resource.oid !== expectedOid || resource.nonce !== expectedNonce || resource.pendingReset || credentials.migration?.name !== resource.roles?.migration?.name || credentials.migration?.oid !== resource.roles?.migration?.oid || credentials.migration?.name !== registered.migrationRole || credentials.migration?.oid !== registered.migrationRoleOid || typeof actor.id !== "string" || typeof actor.sessionId !== "string" || !actor.id || !actor.sessionId) throw new Error("TARGET_BINDING_INVALID");
let ancestor = dirname(resolve(out)); for (;;) { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED"); const parent = dirname(ancestor); if (parent === ancestor || ancestor === parse(ancestor).root) break; ancestor = parent; }
const user = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 }), sid = /S-1-5-[0-9-]+/.exec(user.stdout)?.[0];
if (user.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
mkdirSync(out);
if (spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, timeout: 5000 }).status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_FAILED");
const acl = "$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
if (spawnSync("pwsh.exe", ["-NoProfile", "-Command", acl], { env: { ...process.env, ZZSH_MEDIA_ACL_PATH: resolve(out), ZZSH_MEDIA_ACL_SID: sid }, windowsHide: true, timeout: 5000 }).status !== 0) throw new Error("PRIVATE_OUTPUT_ACL_UNVERIFIED");
const fd = openSync(join(out, "load-events.jsonl"), "wx"), log = value => { const bytes = Buffer.from(JSON.stringify(value) + "\n"); let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) throw new Error("OUTPUT_WRITE_FAILED"); at += n; } };
const connection = { user: credentials.migration.name, password: credentials.migration.password, connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 };
const client = new pg.Client(targetConnection(registered, { ...connection, applicationName: "legacy-path-account-loader" }));
const maintenance = new pg.Client(maintenanceConnection(registered, { ...connection, applicationName: "legacy-path-account-lock" }));
const started = performance.now(), originalQuery = client.query.bind(client), maintenanceQuery = maintenance.query.bind(maintenance);
let queries = 0, chunks = 0, closed = false, lockHeld = false, lockReleased = false;
client.query = (...args) => { queries++; return originalQuery(...args); };
maintenance.query = (...args) => { queries++; return maintenanceQuery(...args); };
const auth = require(join(resolve(apiDist), "auth/auth-security.js")), security = require(join(resolve(apiDist), "auth/security-core.js"));
let state = "STARTED", applied = 0, replayed = 0, begun = false, commitSent = false, commitAck = false, failure, fenceEpoch, fenceHeld = false, targetFenceReleased;
try {
  await maintenance.connect();
  lockHeld = (await maintenance.query(advisoryLockSql(registered, "try"))).rows[0]?.ok === true;
  if (!lockHeld) throw new Error("REGRESSION_RESOURCE_BUSY");
  if (registered.migrationProfile === NEXT_MIGRATION_PROFILE) fenceEpoch = await captureMaintenanceLockEpoch(maintenance, registered);
  await client.connect();
  if (fenceEpoch) {
    assertLiveTarget(registered, (await client.query(targetIdentityQuery())).rows[0]);
    await acquireMigrationSessionFence(client, registered, fenceEpoch); fenceHeld = true;
  }
  await client.query("BEGIN READ ONLY"); begun = true;
  const identity = (await client.query(targetIdentityQuery())).rows[0];
  assertLiveTarget(registered, identity);
  if (fenceHeld) await assertMigrationFenceHeld(client, registered, fenceEpoch);
  if (identity.oid !== expectedOid || identity.nonce !== expectedNonce || identity.marker !== "zzsh:regression-test:v1" || identity.role !== credentials.migration.name || identity.role_oid !== credentials.migration.oid) throw new Error("LIVE_TARGET_CHANGED");
  await auth.assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  const rows = (await client.query(`SELECT m.legacy_id,m.account_id,m.source_digest,a.owner_user_id FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`, [[...prepared.keys()]])).rows;
  if (rows.length !== prepared.size) throw new Error("TARGET_MAPPING_COUNT_MISMATCH");
  for (const row of rows) { const entry = prepared.get(row.legacy_id); if (!entry || entry.accountId || row.source_digest !== entry.plan.sourceDigest || row.owner_user_id !== entry.plan.ownerUserId) throw new Error("TARGET_MAPPING_MISMATCH"); entry.accountId = row.account_id; }
  const rollback = await client.query("ROLLBACK"); begun = false; if (rollback.command !== "ROLLBACK") throw new Error("PREFLIGHT_ROLLBACK_UNCONFIRMED");
  const items = [...prepared.values()];
  for (let offset = 0; offset < items.length; offset += 100) {
    withinWindow();
    const batch = items.slice(offset, offset + 100); log({ event: "BATCH_START", offset, count: batch.length });
    await client.query("BEGIN"); begun = true;
    if (fenceHeld) await assertMigrationFenceHeld(client, registered, fenceEpoch);
    const requestId = `legacy_media_paths_${offset}`; await security.setAuditContext(client, "admin", actor.id, actor.sessionId, requestId);
    const result = await writer.recordLegacyPathRecords(client, batch.map(entry => ({ accountId: entry.accountId, sourceRow: entry.sourceRow })), { id: actor.id, sessionId: actor.sessionId, requestId });
    const newCount = result.inserted, replayCount = result.replayed;
    log({ event: "BATCH_COMMIT_INTENT", offset, count: batch.length, planReceiptSha256: option("--plan-receipt-sha") });
    fsyncSync(fd);
    withinWindow();
    if (fenceHeld) await assertMigrationFenceHeld(client, registered, fenceEpoch);
    commitSent = true; const commit = await client.query("COMMIT"); begun = false;
    if (commit.command !== "COMMIT") throw new Error("COMMIT_ACK_MISMATCH");
    commitAck = true;
    applied += newCount; replayed += replayCount; chunks++; log({ event: "BATCH_COMMIT_ACK", offset, count: batch.length, inserted: newCount, replayed: replayCount }); fsyncSync(fd); commitSent = false; commitAck = false;
  }
  state = "COMPLETE"; log({ event: "COMPLETE", accounts: prepared.size, applied, replayed });
} catch (error) {
  state = commitSent ? commitAck ? "COMMIT_ACK_RECEIPT_FAILED" : "COMMIT_UNKNOWN" : "STOPPED";
  failure = error.code ?? (/^[A-Z][A-Z0-9_]+$/.test(error.message ?? "") ? error.message : error.name);
  if (begun && !commitSent) { try { const ack = await client.query("ROLLBACK"); begun = false; if (ack.command !== "ROLLBACK") state = "ROLLBACK_UNKNOWN"; log({ event: "ROLLBACK", acknowledged: ack.command === "ROLLBACK" }); } catch { state = "ROLLBACK_UNKNOWN"; log({ event: "ROLLBACK", acknowledged: false }); } }
  log({ event: state, applied, replayed, failure });
} finally {
  if (fenceHeld && !begun && !commitSent) {
    try { await releaseMigrationSessionFence(client, registered); targetFenceReleased = true; }
    catch { targetFenceReleased = false; }
  } else if (fenceHeld) targetFenceReleased = false;
  const targetClosed = await client.end().then(() => true, () => false);
  if (lockHeld) {
    try { lockReleased = (await maintenance.query(advisoryLockSql(registered, "unlock"))).rows[0]?.ok === true; } catch {}
  }
  const maintenanceClosed = await maintenance.end().then(() => true, () => false);
  closed = targetClosed && maintenanceClosed;
  closeSync(fd);
}
console.log(JSON.stringify({ status: state, accounts: prepared.size, applied, replayed, queries, chunks, closed, lockReleased, ...(fenceEpoch?{targetFence:'HELD_ACROSS_BATCHES',targetFenceReleased}:{}), failure, wallMs: performance.now() - started })); if (state !== "COMPLETE" || !closed || !lockReleased || fenceEpoch && targetFenceReleased !== true) process.exitCode = 1;
