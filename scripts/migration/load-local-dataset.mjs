import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url), { Client, Pool } = require("pg");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--execute") && !args.includes("--recover")) {
    console.log(JSON.stringify({ action: "PLAN", target: "zzsh_test_regression", required: ["--execute", "--dataset", "--dataset-sha", "--oid", "--nonce", "--actor-id", "--session-id", "--credentials", "--out"], connections: 0, credentialReads: 0 }));
    process.exit(0);
}
if (process.version !== "v24.20.0")
    throw new Error("NODE_BASELINE_MISMATCH");
const sha = value => createHash("sha256").update(value).digest("hex");
const dataset = resolve(option("--dataset") ?? ""), output = resolve(option("--out") ?? ""), expectedOid = option("--oid"), expectedNonce = option("--nonce");
if (!dataset.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !output.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !/^[0-9]+$/.test(expectedOid ?? "") || !/^[a-f0-9]{24}$/.test(expectedNonce ?? ""))
    throw new Error("EXACT_LOCAL_DATASET_RESOURCE_REQUIRED");
const manifestBytes = readFileSync(join(dataset, "manifest.json"));
if (sha(manifestBytes) !== option("--dataset-sha"))
    throw new Error("DATASET_MANIFEST_SHA_MISMATCH");
const manifest = JSON.parse(manifestBytes);
const contactAppend = args.includes("--contact-append"), numberOnly = args.includes("--legacy-number-only");
if (contactAppend && numberOnly) throw new Error("ONE_ADDITIVE_PHASE_PER_EXECUTION");
if (contactAppend || numberOnly) {
    if (manifest.format !== "zzsh.legacy-contact-append-plan.v1" || manifest.status !== "SOURCE_CLOSED_PENDING_ROOT_REVIEW_AND_FRESH_TARGET_CAS"
        || !/^[a-f0-9]{64}$/.test(manifest.sourceDatasetSha256 ?? "") || !option("--source-review-ref")) throw new Error("ROOT_REVIEWED_CONTACT_APPEND_REQUIRED");
    if (contactAppend) for (const name of ["display-plan", "holding-source", "skin-dictionary"]) {
        if (!option("--" + name) || !/^[a-f0-9]{64}$/.test(option("--" + name + "-sha") ?? "")) throw new Error("CONTACT_APPEND_DISPLAY_AND_HOLDING_BINDINGS_REQUIRED");
    }
} else if (manifest.status !== "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN")
    throw new Error("DATASET_NOT_PREPARED");
async function* readRows(file) { const stream = createReadStream(file); const reader = createInterface({ input: stream, crlfDelay: Infinity }); try {
    for await (const line of reader)
        if (line)
            yield JSON.parse(line);
}
finally {
    reader.close();
    stream.destroy();
} }
for (const [name, file] of Object.entries(manifest.files)) {
    if (file.file !== basename(file.file))
        throw new Error("DATASET_FILE_PATH_INVALID");
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(join(dataset, file.file)))
        hash.update(bytes);
    if (hash.digest("hex") !== file.sha256)
        throw new Error("DATASET_FILE_SHA_MISMATCH:" + name);
}
const api = resolve(option("--api-dist") ?? join(ROOT, "apps/api/dist/src")), mod = name => require(join(api, name + ".js"));
const canonical = mod("supply/content-hash").canonicalize;
const actor = { id: option("--actor-id"), userId: option("--actor-id"), realm: "admin", sessionId: option("--session-id"), requestId: "core-legacy-dataset-" + expectedOid };
if (!actor.id || !actor.sessionId)
    throw new Error("EXISTING_MAINTENANCE_ACTOR_REQUIRED");
const statePath = join(output, "checkpoint.json"), eventsPath = join(output, "events.jsonl");
if (!existsSync(output)) {
    mkdirSync(output);
    const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
    if (!sid)
        throw new Error("SID_UNAVAILABLE");
    if (spawnSync("icacls", [output, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true }).status !== 0)
        throw new Error("OUTPUT_ACL_FAILED");
}
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : null;
const binding = { datasetSha256: sha(manifestBytes), database: "zzsh_test_regression", oid: expectedOid, nonce: expectedNonce, actorId: actor.id, sessionId: actor.sessionId };
if (state && JSON.stringify(state.binding) !== JSON.stringify(binding))
    throw new Error("CHECKPOINT_BINDING_CHANGED");
if (state?.pending && !args.includes("--recover"))
    throw new Error("PENDING_TRANSACTION_READ_ONLY_RECOVERY_REQUIRED");
state ??= { schema: "zzsh.local-legacy-load.v1", binding, status: "STARTED", startedAt: new Date().toISOString(), phases: {}, pending: null, queries: 0, quarantine: [], checkpoints: 0 };
const displayOnly = args.includes("--enrich-display");
const openingOnly = args.includes("--import-openings");
const holdingsOnly = args.includes("--enrich-holdings");
if ([displayOnly, openingOnly, holdingsOnly, contactAppend, numberOnly].filter(Boolean).length > 1) throw new Error("ONE_ADDITIVE_PHASE_PER_EXECUTION");
if (displayOnly && !args.includes("--recover") && !["LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", "FAILED_STOPPED"].includes(state.status))
    throw new Error("CORE_DATASET_KNOWN_CHECKPOINT_REQUIRED");
if (displayOnly && !["users", "accounts", "orders"].every(domain => state.phases[domain]?.complete === true))
    throw new Error("CORE_SOURCE_PHASES_NOT_COMPLETE");
if (openingOnly && (!state.phases.users?.complete || !state.phases.financeHistory?.complete || state.status === "RUNNING"))
    throw new Error("CORE_FINANCE_KNOWN_CHECKPOINT_REQUIRED");
if (holdingsOnly && (!["users", "accounts", "orders"].every(domain => state.phases[domain]?.complete) || state.status === "RUNNING"))
    throw new Error("CORE_SOURCE_PHASES_NOT_COMPLETE");
let checkpointOwned = false;
function resetRunCleanup() { state.poolClosed=false; state.unlock=false; state.maintenanceClosed=false; state.rollbackConfirmed=false; }
function save() { if (!checkpointOwned) return; const file = statePath + ".new"; writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { flag: "wx" }); renameSync(file, statePath); }
function event(value) { if (!checkpointOwned) return; appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"); }
const credentialFile = option("--credentials");
if (!credentialFile)
    throw new Error("REGISTERED_MIGRATION_CREDENTIAL_REQUIRED");
const registered = JSON.parse(readFileSync(join(dirname(resolve(credentialFile)), "resource.json"), "utf8"));
const credentials = JSON.parse(readFileSync(credentialFile, "utf8"));
if (registered.database !== "zzsh_test_regression" || registered.oid !== expectedOid || registered.nonce !== expectedNonce || registered.pendingReset || credentials.database !== "zzsh_test_regression" || credentials.migration?.name !== registered.roles?.migration?.name || credentials.migration?.oid !== registered.roles?.migration?.oid)
    throw new Error("REGISTERED_MIGRATION_CREDENTIAL_REQUIRED");
const maintenance = new Client({ host: "127.0.0.1", port: 55432, database: "postgres", user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/postgres_password", "utf8").trim(), application_name: "core-full-legacy-lock", connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 500 });
const pool = new Pool({ host: "127.0.0.1", port: 55432, database: "zzsh_test_regression", user: credentials.migration.name, password: credentials.migration.password, application_name: "core-full-legacy-import", max: 1, connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 1000 });
const subject = mod("auth/identity-subject"), subjectKey = subject.deriveIdentitySubjectKey(readFileSync(process.env.USER_IDENTITY_SUBJECT_HMAC_KEY_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/user_identity_subject_hmac", "utf8").trim());
let client, held = false;
const gameIds = new Map();
const domainFile = name => manifest.files[name] ? join(dataset, manifest.files[name].file) : null;
async function checkpointBatch(domain, batch, start, body) {
    state.pending = { domain, start, end: start + batch.length, sourceIds: batch.map(row => row.sourceId ?? row.parentLegacyOrderId), phaseBodyDigest: sha(canonical(batch)), stage: "BEFORE_BEGIN" };
    save();
    event({ domain, start, end: start + batch.length, event: "INTENT" });
    let commitSent = false, commitAck = false;
    const outcomes = [];
    await client.query("BEGIN");
    try {
        for (const row of batch) {
            await client.query("SAVEPOINT source_row");
            try {
                outcomes.push(await body(row));
                await client.query("RELEASE SAVEPOINT source_row");
            }
            catch (error) {
                if (contactAppend || numberOnly) throw error;
                if (error?.status !== 400 && error?.status !== 409)
                    throw error;
                await client.query("ROLLBACK TO SAVEPOINT source_row");
                await client.query("RELEASE SAVEPOINT source_row");
                const failure = { domain, sourceId: row.sourceId ?? row.parentLegacyOrderId, code: error.code ?? "SOURCE_BINDING_REJECTED", status: error.status };
                outcomes.push({ quarantined: true });
                state.quarantine.push(failure);
                event({ ...failure, event: "ROW_QUARANTINED" });
            }
        }
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        state.pending.stage = "COMMIT_INTENT";
        save();
        commitSent = true;
        await client.query("COMMIT");
        commitAck = true;
        state.phases[domain].nextIndex = start + batch.length;
        state.phases[domain].created += outcomes.filter(row => row?.replayed === false).length;
        state.phases[domain].replayed += outcomes.filter(row => row?.replayed === true).length;
        state.phases[domain].quarantined += outcomes.filter(row => row?.quarantined).length;
        state.checkpoints++;
        state.pending = null;
        save();
        event({ domain, start, end: start + batch.length, event: "COMMIT_ACK" });
        if (state.checkpoints % 10 === 0)
            console.log(JSON.stringify({ status: "PROGRESS", domain, nextIndex: start + batch.length, queries: state.queries }));
    }
    catch (error) {
        if (commitSent && !commitAck) {
            state.status = "COMMIT_UNKNOWN";
            state.pending.stage = "COMMIT_UNKNOWN";
            event({ event: "COMMIT_UNKNOWN", domain, start });
            save();
        }
        else if (commitAck) {
            state.status = "RECEIPT_WRITE_FAILED_COMMITTED";
            event({ event: "RECEIPT_WRITE_FAILED_COMMITTED", domain, start });
        }
        else {
            try {
                await client.query("ROLLBACK");
                state.pending = null;
                state.status = "FAILED_ROLLED_BACK";
                save();
            }
            catch {
                state.status = "ROLLBACK_UNKNOWN";
                event({ event: "ROLLBACK_UNKNOWN", domain, start });
                save();
            }
        }
        throw error;
    }
}
async function runItems(domain, items, body, batchSize = 100) {
    state.phases[domain] ??= { nextIndex: 0, created: 0, replayed: 0, quarantined: 0 };
    const phase = state.phases[domain], started = performance.now(), queriesBefore = state.queries;
    const segment = { startedAt: new Date().toISOString(), startIndex: phase.nextIndex, queriesBefore, batchSize, concurrency: 1 };
    phase.timingSegments ??= [];
    phase.timingSegments.push(segment);
    save();
    try {
        let index = 0, batch = [];
        for await (const row of items) {
            if (index++ < phase.nextIndex) continue;
            batch.push(row);
            if (batch.length === batchSize) {
                await checkpointBatch(domain, batch, index - batch.length, body);
                batch = [];
            }
        }
        if (batch.length) await checkpointBatch(domain, batch, index - batch.length, body);
        phase.complete = true;
        save();
        console.log(JSON.stringify({ status: "PHASE_COMPLETE", domain, ...phase }));
    }
    finally {
        Object.assign(segment, { finishedAt: new Date().toISOString(), monotonicElapsedMs: performance.now() - started, endIndex: phase.nextIndex, queriesAfter: state.queries, queryDelta: state.queries - queriesBefore, complete: phase.complete === true });
        save();
    }
}
async function runPhase(domain, body, batchSize = 100) { const file = domainFile(domain); if (file)
    return runItems(domain, readRows(file), body, batchSize); }
async function applyUsers() { await runPhase("users", async (row) => { const result = await mod("supply/legacy-user-migration").migrateLegacyOwner(client, row.input, actor); if (row.trustedIdentityNumber) {
    const wanted = subject.identitySubjectDigest(row.trustedIdentityNumber, subjectKey);
    const old = (await client.query("SELECT subject_digest,source FROM zzsh_iam.user_identity_subject WHERE user_id=$1", [row.userId])).rows[0];
    if (old && (old.subject_digest !== wanted || old.source !== "LEGACY_IMPORT"))
        throw new Error("LEGACY_SUBJECT_BINDING_CONFLICT");
    if (!old)
        await subject.recordLegacyIdentitySubject(client, row.userId, row.trustedIdentityNumber, subjectKey);
} return result; }); }
async function applyAccounts() { await runPhase("accounts", async (row) => { const gameId = gameIds.get(row.gameCode); if (!gameId)
    throw new Error("TARGET_GAME_NOT_BOUND"); const input = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.sourceId, sourceDigest: row.sourceDigest, evidenceRef: row.evidenceRef, owner: { legacyId: row.ownerLegacyId, sourceDigest: row.ownerSourceDigest }, gameId }; const result = await mod("legacy-load/legacy-account-seam").createLegacyOwnerRentalAccount(client, input, actor); const observationVersionId = await mod("supply/legacy-observation").recordLegacyObservation(client, result.accountId, { sourceSystem: input.sourceSystem, sourceEntity: input.sourceEntity, legacyId: input.legacyId, sourceDigest: input.sourceDigest, evidenceRef: input.evidenceRef, inventory: [] }, actor); if (row.snapshot && row.sourceUpdatedAt && mod("supply/legacy-listing-read").legacyReadSourceAllowed(Number(row.sourceStatus), row.sourceDeleted))
    await mod("supply/legacy-listing-read").recordLegacyReadSnapshot(client, result.accountId, { observationVersionId, sourceSystem: input.sourceSystem, sourceEntity: input.sourceEntity, legacyId: input.legacyId, sourceDigest: input.sourceDigest, sourceStatus: Number(row.sourceStatus), sourceDeleted: row.sourceDeleted, sourceUpdatedAt: row.sourceUpdatedAt, evidenceRef: input.evidenceRef, snapshot: row.snapshot }, actor); return result; }); }
async function applyOrders() { await runPhase("orders", async (row) => { const gameId = gameIds.get(row.gameCode), accountId = mod("legacy-load/legacy-account-seam").legacyAccountId("legacy_mysql_restore", "la_rental_accounts", row.account.legacyId); const input = { source: row.source, account: { ...row.account, accountId, gameId }, owner: row.owner, renter: row.renter }; return mod("order/legacy-order-read").importLegacyOrderRead(client, input, actor); }); }
function protectDataset(resourceState, status) {
    if (contactAppend || numberOnly) {
        if (resourceState.protectedDataset?.manifestSha256 !== manifest.sourceDatasetSha256 || resourceState.protectedDataset?.epoch?.oid !== expectedOid
            || resourceState.protectedDataset?.epoch?.nonce !== expectedNonce) throw new Error("CONTACT_APPEND_PARENT_DATASET_NOT_PROTECTED");
        resourceState.protectedDataset.additiveReports ??= {};
        resourceState.protectedDataset.additiveReports[state.binding.datasetSha256 + (numberOnly ? ":public-numbers" : ":contact-append")] = { status, report: statePath, sourceReviewRef: option("--source-review-ref") };
    } else resourceState.protectedDataset={manifestSha256:state.binding.datasetSha256,epoch:{oid:expectedOid,nonce:expectedNonce},reason:"REHEARSAL_REVIEW",status,report:statePath};
    return resourceState;
}
resetRunCleanup();
try {
    await maintenance.connect();
    held = (await maintenance.query("SELECT pg_try_advisory_lock(806006::bigint) ok")).rows[0].ok;
    if (!held)
        throw new Error("REGRESSION_RESOURCE_BUSY");
    // A previous writer may have finished while this invocation was validating its inputs.
    if (existsSync(statePath)) state=JSON.parse(readFileSync(statePath));
    if (JSON.stringify(state.binding)!==JSON.stringify(binding)) throw new Error("CHECKPOINT_BINDING_CHANGED");
    if (state.pending&&!args.includes("--recover")) throw new Error("PENDING_TRANSACTION_READ_ONLY_RECOVERY_REQUIRED");
    client = await pool.connect();
    const original = client.query.bind(client);
    client.query = (...args) => { state.queries++; return original(...args); };
    const actual = (await client.query("SELECT d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_user role,r.oid::text role_oid,current_setting('zzsh.regression_run') nonce,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()")).rows[0];
    if (actual.oid !== expectedOid || actual.nonce !== expectedNonce || actual.owner !== "zzsh" || actual.marker !== "zzsh:regression-test:v1" || actual.role !== credentials.migration.name || actual.role_oid !== credentials.migration.oid || actual.rolsuper || actual.rolcreatedb || actual.rolcreaterole || actual.rolbypassrls)
        throw new Error("TARGET_IDENTITY_CHANGED");
    checkpointOwned = true;
    resetRunCleanup();
    state.resource = actual;
    if (args.includes("--recover")) {
        const domains = Object.keys(state.phases), counts = (await client.query("SELECT (SELECT count(*)::text FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore') legacy_users,(SELECT count(*)::text FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore') legacy_accounts,(SELECT count(*)::text FROM zzsh_order.legacy_order_read_snapshot) legacy_orders")).rows[0];
        writeFileSync(join(output, "recovery-" + Date.now() + ".json"), JSON.stringify({ mode: "READ_ONLY", binding, pending: state.pending, domains, counts, knowledge: state.pending ? "EXACT_PENDING_KEYS_REQUIRE_INSPECTION" : "NO_PENDING_COMMIT" }, null, 2), { flag: "wx" });
        console.log(JSON.stringify({ status: "READ_ONLY_RECOVERY_RECORDED", counts }));
    }
    else {
        await mod("database/business-migrations").assertBusinessMigrationPrefix(client);
        await client.query("BEGIN READ ONLY");
        await mod("finance/personal-finance-maintenance").authorizeFinanceMaintenance(client, actor);
        for (const code of Object.values(manifest.gameBindings)) {
            const game = (await client.query("SELECT id,enabled FROM zzsh_supply.game WHERE code=$1", [code])).rows[0];
            if (!game || !game.enabled)
                throw new Error("REVIEWED_REFERENCE_GAME_REQUIRED");
            if (state.gameBindings?.[code] && state.gameBindings[code] !== game.id)
                throw new Error("TARGET_GAME_BINDING_DRIFT");
            gameIds.set(code, game.id);
        }
        await client.query("ROLLBACK");
        state.gameBindings = Object.fromEntries(gameIds);
        state.status = "RUNNING";
        const startingResource=JSON.parse(readFileSync(join(dirname(resolve(credentialFile)),"resource.json")));
        if(startingResource.oid!==expectedOid||startingResource.nonce!==expectedNonce)throw new Error("PROTECTED_DATASET_RESOURCE_DRIFT");
        protectDataset(startingResource, "BUILDING");
        writeFileSync(join(dirname(resolve(credentialFile)),"resource.json"),JSON.stringify(startingResource,null,2)+"\n");
        save();
        if (contactAppend || numberOnly) {
            const { applyContactAppend, applyNumberBindings } = await import("./local-target-contact-append.mjs");
            const ctx = { client, actor, mod, manifest, state, output, domainFile, readRows, runItems, save, event };
            if (numberOnly) await applyNumberBindings(ctx);
            else {
                await applyContactAppend(ctx, { applyUsers, applyAccounts, applyOrders, display: { directory: option("--display-plan"), sha256: option("--display-plan-sha") },
                    holdings: { source: option("--holding-source"), sourceSha256: option("--holding-source-sha"), dictionary: option("--skin-dictionary"), dictionarySha256: option("--skin-dictionary-sha") } });
            }
            state.status = numberOnly ? "LOCAL_DATASET_PUBLIC_NUMBERS_COMMITTED_REVIEW_REQUIRED" : "LOCAL_DATASET_CONTACT_APPEND_COMMITTED_REVIEW_REQUIRED";
        }
        else if (holdingsOnly) {
            const { applyHoldingDomain } = await import("./local-target-holdings.mjs");
            await applyHoldingDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, save, event }, { source: option("--holding-source"), sourceSha256: option("--holding-source-sha"), dictionary: option("--skin-dictionary"), dictionarySha256: option("--skin-dictionary-sha") });
            state.status = "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED";
        }
        else if (openingOnly) {
            const { applyOpeningDomain } = await import("./local-target-opening.mjs");
            await applyOpeningDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, save, event }, option("--opening-proof"), option("--opening-proof-sha"));
            state.status = "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED";
        }
        else if (displayOnly) {
            const { applyDisplayDomain } = await import("./local-target-display.mjs");
            await applyDisplayDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, save, event }, option("--display-plan"), option("--display-plan-sha"));
            state.status = "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED";
        }
        else {
            await applyUsers();
            await applyAccounts();
            await applyOrders();
            const { applyFinancialDomains } = await import("./local-target-finance.mjs");
            await applyFinancialDomains({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, save, event });
            state.status = "LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED";
        }
        save();
    }
}
catch (error) {
    if (!["COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "RECEIPT_WRITE_FAILED_COMMITTED"].includes(state.status))
        state.status = "FAILED_STOPPED";
    state.error = { name: error.name, code: error.code ?? null, status: error.status ?? null, message: String(error.message).slice(0, 300), detail: error.detail ?? null, constraint: error.constraint ?? null };
    try {
        save();
    }
    catch { }
    console.error(JSON.stringify({ status: state.status, code: state.error.code, phase: state.pending?.domain ?? null }));
    process.exitCode = 1;
}
finally {
    if (client) {
        try {
            await client.query("ROLLBACK");
            state.rollbackConfirmed = true;
        }
        catch {
            state.rollbackConfirmed = false;
        }
        client.release();
    }
    try { await pool.end(); state.poolClosed = true; } catch { state.poolClosed = false; process.exitCode=1; }
    if (held) {
        try {
            state.unlock = (await maintenance.query("SELECT pg_advisory_unlock(806006::bigint) ok")).rows[0].ok;
        }
        catch {
            state.unlock = false;
        }
    }
    try { await maintenance.end(); state.maintenanceClosed = true; } catch { state.maintenanceClosed = false; process.exitCode=1; }
    if(checkpointOwned && (!state.poolClosed || !state.unlock || !state.maintenanceClosed || !state.rollbackConfirmed)) process.exitCode=1;
    if(checkpointOwned && (Object.values(state.phases).some(phase=>phase.nextIndex>0)||["COMMIT_UNKNOWN","ROLLBACK_UNKNOWN"].includes(state.status))){
        const registryPath=join(dirname(resolve(credentialFile)),"resource.json");const resourceState=JSON.parse(readFileSync(registryPath));
        if(resourceState.oid!==expectedOid||resourceState.nonce!==expectedNonce)throw new Error("PROTECTED_DATASET_RESOURCE_DRIFT");
        protectDataset(resourceState, state.status);
        writeFileSync(registryPath,JSON.stringify(resourceState,null,2)+"\n");state.protectionRecorded=true;
    }
    state.updatedAt = new Date().toISOString();
    try {
        save();
    }
    catch { }
    console.log(JSON.stringify({ status: state.status, phases: state.phases, quarantine: state.quarantine.length, queries: state.queries, unlock: state.unlock, poolClosed: state.poolClosed, checkpointOwned }));
}
