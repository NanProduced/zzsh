import { createHash, createHmac } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isStrictRoundReservation, matchesLoadReservation, strictRoundReservation, writeLoadCheckpoint } from "./local-load-checkpoint.mjs";
import { assertFullExecutionAdmitted } from "./full-source-scope.mjs";
import { assertSelectedScopeForWrite } from "./selected-business-scope.mjs";
import { LEGACY_REFUND_RELATIONSHIP_POLICY, assertNextBusinessPopulation, expectedContinuationImports, verifyNextContinuationRows, readSourceRows as readRows } from "./local-source-adapter.mjs";
import { readBoundSelectedSourceReceipt, verifySelectedPopulationFiles } from "./verify-full-source-population.mjs";
import { preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";
import { acquireMigrationSessionFence, advisoryLockSql, assertLiveTarget, assertMigrationFenceHeld, assertNextMigrationWriteReady, captureMaintenanceLockEpoch, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, releaseMigrationSessionFence, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";
const require = createRequire(import.meta.url), { Client, Pool } = require("pg");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const execute = args.includes("--execute"), recover = args.includes("--recover"), strictBatch = args.includes("--strict-round-batch");
if (execute && recover) throw new Error("ONE_LOAD_ACTION_REQUIRED");
if (!execute && !recover) {
    console.log(JSON.stringify({ action: "PLAN", target: "zzsh_test_regression", required: ["--execute", "--dataset", "--dataset-sha", "--oid", "--nonce", "--actor-id", "--session-id", "--credentials", "--out", "--funds-source", "--funds-source-sha"], connections: 0, credentialReads: 0 }));
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
if ((args.includes("--contact-append") || args.includes("--legacy-number-only"))
    && loadRegisteredTarget(option("--credentials")).migrationProfile === NEXT_MIGRATION_PROFILE)
    throw new Error("NEXT_ADDITIVE_MIGRATION_NOT_SUPPORTED");
// A direct invocation must not bypass the runner's full-capture readiness gate.
const population = manifest.population ?? { mode: manifest.scenarioSelection?.schema === "zzsh.source-scenarios.v1" ? "LEGACY_SCENARIO_SELECTION" : "LEGACY_UNDECLARED" };
assertFullExecutionAdmitted(population, execute ? "execute" : "recover");
if (execute) assertSelectedScopeForWrite(manifest);
if (execute && manifest.population && (manifest.population.schema !== "zzsh.local-population-scope.v1" || sha(JSON.stringify(manifest.population)) !== manifest.populationSha256)) throw new Error("POPULATION_SCOPE_DIGEST_INVALID");
const schemaBinding = option("--schema-binding");
const expectedSchema = schemaBinding ? JSON.parse(schemaBinding) : null;
if (expectedSchema && (!Array.isArray(expectedSchema) || !expectedSchema.length || expectedSchema.some(hash => !/^[a-f0-9]{64}$/.test(hash))))
    throw new Error("ORDERED_SCHEMA_HASHES_REQUIRED");
const executionWindow = option("--execution-window") ? JSON.parse(option("--execution-window")) : null;
if (executionWindow && (!Object.keys(executionWindow).every(k => ["notBefore", "expiresAt"].includes(k)) ||
    ![executionWindow.notBefore, executionWindow.expiresAt].every(time => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)) ||
    !(Date.parse(executionWindow.expiresAt) > Date.parse(executionWindow.notBefore)))) throw new Error("ROUND_EXECUTION_WINDOW_INVALID");
function assertRoundWindow() {
    if (executionWindow && !(Date.now() >= Date.parse(executionWindow.notBefore) && Date.now() < Date.parse(executionWindow.expiresAt)))
        throw new Error("ROUND_EXECUTION_WINDOW_INACTIVE");
}
const contactAppend = args.includes("--contact-append"), numberOnly = args.includes("--legacy-number-only");
if (strictBatch && (!executionWindow || !expectedSchema || contactAppend || numberOnly)) throw new Error("STRICT_ROUND_BATCH_BINDING_REQUIRED");
if (strictBatch && execute) assertRoundWindow();
if (contactAppend && numberOnly) throw new Error("ONE_ADDITIVE_PHASE_PER_EXECUTION");
if (contactAppend || numberOnly) {
    if (manifest.format !== "zzsh.legacy-contact-append-plan.v1" || manifest.status !== "SOURCE_CLOSED_PENDING_ROOT_REVIEW_AND_FRESH_TARGET_CAS"
        || !/^[a-f0-9]{64}$/.test(manifest.sourceDatasetSha256 ?? "") || !option("--source-review-ref")) throw new Error("ROOT_REVIEWED_CONTACT_APPEND_REQUIRED");
    if (contactAppend) for (const name of ["display-plan", "holding-source", "skin-dictionary"]) {
        if (!option("--" + name) || !/^[a-f0-9]{64}$/.test(option("--" + name + "-sha") ?? "")) throw new Error("CONTACT_APPEND_DISPLAY_AND_HOLDING_BINDINGS_REQUIRED");
    }
} else if (manifest.status !== "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN")
    throw new Error("DATASET_NOT_PREPARED");
const importsCore = !["--enrich-display", "--import-openings", "--enrich-holdings", "--contact-append", "--legacy-number-only"].some(flag => args.includes(flag));
let sourceScopeVerification;
if (execute && importsCore && manifest.identityProfiles?.schema !== "zzsh.legacy-identity-profile-source.v1")
    throw new Error("LEGACY_IDENTITY_PROFILE_SOURCE_REQUIRED");
if (execute && importsCore && manifest.refundRelationshipPolicy !== LEGACY_REFUND_RELATIONSHIP_POLICY)
    throw new Error("LEGACY_REFUND_RELATIONSHIP_POLICY_REQUIRED");
if (execute && importsCore && population.mode === "SELECTED_BUSINESS_SCOPE") {
    const source = readBoundSelectedSourceReceipt(manifest.source, manifest.sourceReceiptSha256);
    sourceScopeVerification = await verifySelectedPopulationFiles({ datasetDir: dataset, sourceDir: manifest.source, dataset: manifest, source });
}
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
const subject = mod("auth/identity-subject"), identityProfile = mod("auth/legacy-identity-profile");
const subjectSecret = readFileSync(process.env.USER_IDENTITY_SUBJECT_HMAC_KEY_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/user_identity_subject_hmac", "utf8").trim();
const subjectKey = subject.deriveIdentitySubjectKey(subjectSecret);
const hasIdentityProfiles = manifest.identityProfiles?.schema === "zzsh.legacy-identity-profile-source.v1";
if (manifest.identityProfiles && (!hasIdentityProfiles || manifest.identityProfiles.invalid !== 0
    || !Number.isSafeInteger(manifest.identityProfiles.ready) || manifest.identityProfiles.ready < 0
    || manifest.identityProfiles.verified !== manifest.identityProfiles.ready)) throw new Error("LEGACY_IDENTITY_PROFILE_SOURCE_INCOMPLETE");
let profileKey;
if (hasIdentityProfiles) {
    if (!process.env.USER_LEGACY_IDENTITY_PROFILE_KEY_FILE) throw new Error("LEGACY_IDENTITY_PROFILE_KEY_FILE_REQUIRED");
    const profileSecret = readFileSync(process.env.USER_LEGACY_IDENTITY_PROFILE_KEY_FILE, "utf8").trim();
    if (profileSecret === subjectSecret) throw new Error("LEGACY_IDENTITY_PROFILE_KEY_NOT_INDEPENDENT");
    profileKey = identityProfile.legacyIdentityProfileKey(profileSecret);
}
const keyBinding = hasIdentityProfiles ? {
    identityProfileKeyProof: createHmac("sha256", profileKey).update("legacy-profile-key-v1:" + sha(manifestBytes)).digest("hex"),
    identitySubjectKeyProof: createHmac("sha256", subjectKey).update("legacy-subject-key-v1:" + sha(manifestBytes)).digest("hex"),
} : {};
let invitationSource, invitationPacketCount;
if (execute && !["--enrich-display", "--import-openings", "--enrich-holdings", "--contact-append", "--legacy-number-only", "--core-only"].some(flag => args.includes(flag))
    && requiresInvitationCountClosure(manifest)) {
    const file = manifest.files["invitation-facts"];
    if (!file) throw new Error("INVITATION_FILE_BINDING_REQUIRED");
    const path=join(dataset,file.file),hashes=await preflightInvitationFile(path,file.sha256,manifest,mod("finance/legacy-invitation-facts"));
    invitationPacketCount=hashes.length;invitationSource=()=>readBoundInvitationPackets(path,file.sha256,hashes);
}
const actor = { id: option("--actor-id"), userId: option("--actor-id"), realm: "admin", sessionId: option("--session-id"), requestId: "core-legacy-dataset-" + expectedOid };
if (!actor.id || !actor.sessionId)
    throw new Error("EXISTING_MAINTENANCE_ACTOR_REQUIRED");
const statePath = join(output, "checkpoint.json"), eventsPath = join(output, "events.jsonl");
function createOutput() {
    if (existsSync(output)) return;
    mkdirSync(output);
    const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
    if (!sid)
        throw new Error("SID_UNAVAILABLE");
    if (spawnSync("icacls", [output, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { encoding: "utf8", windowsHide: true }).status !== 0)
        throw new Error("OUTPUT_ACL_FAILED");
}
// The registered target is resolved before the checkpoint binding is built, so a checkpoint can only
// ever be compared against the target its registry names - never against a literal in this script.
const registered = loadRegisteredTarget(option("--credentials"));
assertNextBusinessPopulation(population, registered.migrationProfile === NEXT_MIGRATION_PROFILE);
expectedContinuationImports(manifest, registered.migrationProfile === NEXT_MIGRATION_PROFILE);
if (registered.migrationProfile === NEXT_MIGRATION_PROFILE) {
    const file = manifest.files.continuations, rows = [];
    if (file) for await (const row of readRows(join(dataset, file.file))) rows.push(row);
    verifyNextContinuationRows(manifest, rows, mod("order/legacy-continuation-calc").admitLegacyEvidence);
    const finance=mod("finance/personal-finance-observation-maintenance");
    if(finance.COMPACT_EMPTY_COVERAGE_VERSION!=="BATCH_V2"||typeof finance.importReviewedCompactEmptyFinanceObservationBatch!=="function"
      ||typeof finance.recoverReviewedCompactEmptyFinanceObservationBatch!=="function"||typeof finance.compactEmptyFinanceBatchProof!=="function")
        throw new Error("NEXT_COMPACT_COVERAGE_BUILD_REQUIRED");
}
if (execute) assertNextMigrationWriteReady(registered);

let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : null;
const binding = { datasetSha256: sha(manifestBytes), database: registered.database, oid: expectedOid, nonce: expectedNonce, actorId: actor.id, sessionId: actor.sessionId, ...keyBinding,
    ...(registered.instance ? {instance: registered.instance} : {}), ...(registered.migrationProfile ? {migrationProfile: registered.migrationProfile} : {}) };
function assertCheckpointBinding(checkpoint) {
    if (recover && !checkpoint?.pending) throw new Error("ORIGINAL_PENDING_CHECKPOINT_REQUIRED");
    if (!checkpoint) return;
    if (JSON.stringify(checkpoint.binding) !== JSON.stringify(binding)) throw new Error("CHECKPOINT_BINDING_CHANGED");
    if (JSON.stringify(checkpoint.executionWindow ?? null) !== JSON.stringify(executionWindow)) throw new Error("CHECKPOINT_EXECUTION_WINDOW_CHANGED");
    if (JSON.stringify(checkpoint.schemaHashes ?? null) !== JSON.stringify(expectedSchema)) throw new Error("CHECKPOINT_SCHEMA_BINDING_CHANGED");
    if ((checkpoint.strictBatch ?? false) !== strictBatch) throw new Error("CHECKPOINT_STRICT_BATCH_CHANGED");
    if (checkpoint.pending && !recover) throw new Error("PENDING_TRANSACTION_READ_ONLY_RECOVERY_REQUIRED");
}
assertCheckpointBinding(state);
if (sourceScopeVerification && state?.sourceScopeVerification && JSON.stringify(sourceScopeVerification) !== JSON.stringify(state.sourceScopeVerification))
    throw new Error("SELECTED_SCOPE_CHECKPOINT_CHANGED");
state ??= { schema: "zzsh.local-legacy-load.v1", binding, status: "STARTED", startedAt: new Date().toISOString(), phases: {}, pending: null, queries: 0, quarantine: [], checkpoints: 0 };
if (sourceScopeVerification) state.sourceScopeVerification = sourceScopeVerification;
if (strictBatch) state.strictBatch = true;
if (executionWindow) state.executionWindow = executionWindow;
if (expectedSchema) state.schemaHashes = expectedSchema;
const displayOnly = args.includes("--enrich-display");
const openingOnly = args.includes("--import-openings");
const holdingsOnly = args.includes("--enrich-holdings");
const coreOnly = args.includes("--core-only");
if (!displayOnly && !openingOnly && !holdingsOnly && !contactAppend && !numberOnly && (!option("--funds-source") || !/^[a-f0-9]{64}$/.test(option("--funds-source-sha") ?? ""))) throw new Error("BOUND_FINANCIAL_SOURCE_SUPPLEMENT_REQUIRED");
if(!coreOnly&&!displayOnly&&!openingOnly&&!holdingsOnly&&!contactAppend&&!numberOnly&&!args.includes("--recover")&&(!option("--refund-attempts")||!/^[a-f0-9]{64}$/.test(option("--refund-attempts-sha")??"")))throw new Error("BOUND_REFUND_ATTEMPT_SOURCE_REQUIRED");
if ([displayOnly, openingOnly, holdingsOnly, contactAppend, numberOnly, coreOnly].filter(Boolean).length > 1) throw new Error("ONE_ADDITIVE_PHASE_PER_EXECUTION");
if (displayOnly && !args.includes("--recover") && !["LOCAL_DATASET_CORE_ONLY_COMMITTED_FINANCE_NOT_RUN", "LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED", "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED", "FAILED_STOPPED"].includes(state.status))
    throw new Error("CORE_DATASET_KNOWN_CHECKPOINT_REQUIRED");
if (displayOnly && !["users", "accounts", "orders"].every(domain => state.phases[domain]?.complete === true))
    throw new Error("CORE_SOURCE_PHASES_NOT_COMPLETE");
if (openingOnly && (!state.phases.users?.complete || !state.phases.financeHistory?.complete || state.status === "RUNNING"))
    throw new Error("CORE_FINANCE_KNOWN_CHECKPOINT_REQUIRED");
if (holdingsOnly && (!["users", "accounts", "orders"].every(domain => state.phases[domain]?.complete) || state.status === "RUNNING"))
    throw new Error("CORE_SOURCE_PHASES_NOT_COMPLETE");
const fundsSourceBinding=option("--funds-source")?{path:resolve(option("--funds-source")),sha256:option("--funds-source-sha")}:null;
if(fundsSourceBinding){
 if(!fundsSourceBinding.path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")||sha(readFileSync(join(fundsSourceBinding.path,"receipt.json")))!==fundsSourceBinding.sha256)throw new Error("FUNDS_SOURCE_BINDING_CHANGED");
 if(state.fundsSourceBinding&&JSON.stringify(state.fundsSourceBinding)!==JSON.stringify(fundsSourceBinding))throw new Error("CHECKPOINT_FUNDS_SOURCE_CHANGED");
}
const refundAttemptsBinding=option("--refund-attempts")?{path:resolve(option("--refund-attempts")),sha256:option("--refund-attempts-sha")}:null;
if(refundAttemptsBinding){if(!refundAttemptsBinding.path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")||sha(readFileSync(join(refundAttemptsBinding.path,"receipt.json")))!==refundAttemptsBinding.sha256||state.refundAttemptsBinding&&JSON.stringify(state.refundAttemptsBinding)!==JSON.stringify(refundAttemptsBinding))throw new Error("REFUND_ATTEMPT_CHECKPOINT_BINDING_CHANGED");}
let checkpointOwned = false;
function resetRunCleanup() { state.poolClosed=false; state.unlock=false; state.maintenanceClosed=false; state.rollbackConfirmed=false; }
function save(value = state) { if (checkpointOwned) writeLoadCheckpoint(statePath, value); }
function event(value) { if (!checkpointOwned) return; appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n"); }
const credentialFile = option("--credentials");
const round06Reservation = "ROUND06_BOOTSTRAP_RESERVED";
const initialReservation = registered.protectedDataset;
const round06 = initialReservation?.status === round06Reservation || initialReservation?.bootstrapReservation === round06Reservation;
const registeredReservation = initialReservation?.bootstrapReservation ?? initialReservation?.status;
function assertResource(resource, checkpoint) {
    if (resource.database !== binding.database || resource.oid !== expectedOid || resource.nonce !== expectedNonce || resource.pendingReset)
        throw new Error("RES:"+JSON.stringify([resource.database,binding.database,resource.oid,expectedOid,resource.nonce,expectedNonce,resource.pendingReset]));
    const instance = resource.instance ? {host:resource.instance.host ?? "127.0.0.1",port:Number(resource.instance.port ?? 55432),systemIdentifier:resource.instance.systemIdentifier ?? null} : null;
    if (JSON.stringify(instance) !== JSON.stringify(registered.instance) || (resource.migrationProfile ?? null) !== registered.migrationProfile
        || String(resource.lockKey ?? "806006") !== registered.lockKey) throw new Error("REGISTERED_INSTANCE_CHANGED");
    const reservation = resource.protectedDataset;
    const strictRound = status => isStrictRoundReservation(status) || status === round06Reservation;
    if ((strictRound(reservation?.bootstrapReservation) || reservation?.status === round06Reservation) && !strictBatch) throw new Error("CHECKPOINT_STRICT_BATCH_CHANGED");
    if (round06 && (reservation?.status === round06Reservation
        ? reservation.bootstrapReservation !== undefined && reservation.bootstrapReservation !== round06Reservation
        : reservation?.bootstrapReservation !== round06Reservation || [strictRoundReservation, "ROUND05_BOOTSTRAP_RESERVED"].includes(reservation.status)))
        throw new Error("ROUND06_RESERVATION_CHANGED");
    if (reservation?.report && reservation.report !== statePath && ["BUILDING", "COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "RECEIPT_WRITE_FAILED_COMMITTED"].includes(reservation.status))
        throw new Error("ORIGINAL_PENDING_CHECKPOINT_REQUIRED");
    if (strictBatch && (!matchesLoadReservation(reservation, binding) || !(strictRound(reservation.status)
        || (strictRound(reservation.bootstrapReservation) && reservation.report === statePath && checkpoint?.strictBatch === true))))
        throw new Error("STRICT_BATCH_REQUIRES_ROUND04");
}
assertResource(registered, existsSync(statePath) ? state : null);
const credentials = JSON.parse(readFileSync(credentialFile, "utf8"));
function assertRegisteredRole(resource) {
    // The resolved target and the registry file read back for drift both reach here: one carries the
    // role name directly, the other still holds the raw roles block that is written back unchanged.
    const registeredRole = resource.migrationRole ?? resource.roles?.migration?.name;
    const registeredRoleOid = resource.migrationRoleOid ?? resource.roles?.migration?.oid;
    if (credentials.database !== binding.database || !credentials.migration?.name || !credentials.migration.oid
        || credentials.migration.name !== registeredRole
        || typeof registeredRoleOid !== "string" || credentials.migration.oid !== registeredRoleOid)
        throw new Error("REGISTERED_MIGRATION_CREDENTIAL_REQUIRED");
}
function readStartingResource() {
    const currentCheckpoint = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : null;
    assertCheckpointBinding(currentCheckpoint);
    if (currentCheckpoint) state = currentCheckpoint;
    const startingResource = JSON.parse(readFileSync(registered.sourceFile));
    assertResource(startingResource, currentCheckpoint);
    assertRegisteredRole(startingResource);
    if(fundsSourceBinding&&state.fundsSourceBinding&&JSON.stringify(state.fundsSourceBinding)!==JSON.stringify(fundsSourceBinding))throw new Error("CHECKPOINT_FUNDS_SOURCE_CHANGED");
    return startingResource;
}
assertRegisteredRole(registered);
const maintenance = new Client(maintenanceConnection(registered, { user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? join(ROOT, "apps/api/.secrets/postgres_password"), "utf8").trim(), applicationName: "core-full-legacy-lock", connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 500 }));
const pool = new Pool(targetConnection(registered, { user: credentials.migration.name, password: credentials.migration.password, applicationName: "core-full-legacy-import", max: 1, connectionTimeoutMillis: 3000, statement_timeout: 600000, lock_timeout: 1000 }));
let client, held = false, unsafeConnection, fenceEpoch, fenceHeld = false;
const gameIds = new Map();
const domainFile = name => manifest.files[name] ? join(dataset, manifest.files[name].file) : null;
async function checkpointBatch(domain, batch, start, body, beforeBatch, batchBody) {
    assertRoundWindow();
    const sourceIds = batch.map(row => row.sourceId ?? row.parentLegacyOrderId ?? row.key);
    if (strictBatch && sourceIds.some(id => id === undefined || id === "")) throw new Error("STRICT_BATCH_ORIGINAL_KEYS_REQUIRED");
    const batchIntent = { domain, start, end: start + batch.length, sourceIds, phaseBodyDigest: sha(canonical(batch)), stage: "BEFORE_BEGIN" };
    state.pending = batchIntent;
    save();
    event({ domain, start, end: start + batch.length, event: "INTENT" });
    let commitSent = false, commitAck = false;
    const outcomes = [], quarantine = [];
    try {
        await client.query("BEGIN");
        if (fenceHeld) await assertMigrationFenceHeld(client, registered, fenceEpoch);
        await beforeBatch?.(batch);
        for (const [offset, row] of batch.entries()) {
            // Batch-body mode: one call writes the whole chunk in a few jsonb_to_recordset statements.
            // It must return one outcome per row so created/replayed accounting stays exact.
            if (batchBody) {
                const produced = await batchBody(batch, start);
                if (!Array.isArray(produced) || produced.length !== batch.length) throw new Error("BATCH_BODY_OUTCOME_SHAPE_INVALID");
                outcomes.push(...produced);
                break;
            }
            if (strictBatch) {
                try { outcomes.push(await body(row)); }
                catch (error) {
                    try { event({ event: "STRICT_ROW_REJECTED", domain, index: start + offset, status: error?.status ?? null }); } catch { }
                    throw error;
                }
                continue;
            }
            await client.query("SAVEPOINT source_row");
            try {
                outcomes.push(await body(row));
                await client.query("RELEASE SAVEPOINT source_row");
            }
            catch (error) {
                // Each item in this phase contains an entire coverage chunk.
                if (contactAppend || numberOnly || ["financeEmptyCoverage", "invitationCounts"].includes(domain)) throw error;
                if (error?.status !== 400 && error?.status !== 409)
                    throw error;
                await client.query("ROLLBACK TO SAVEPOINT source_row");
                await client.query("RELEASE SAVEPOINT source_row");
                const failure = { domain, sourceId: row.sourceId ?? row.parentLegacyOrderId, code: error.code ?? "SOURCE_BINDING_REJECTED", status: error.status };
                outcomes.push({ quarantined: true });
                quarantine.push(failure);
                event({ ...failure, event: "ROW_QUARANTINED" });
            }
        }
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        state.pending = { ...batchIntent, stage: "COMMIT_INTENT" };
        save();
        assertRoundWindow();
        if (fenceHeld) await assertMigrationFenceHeld(client, registered, fenceEpoch);
        commitSent = true;
        if ((await client.query("COMMIT")).command !== "COMMIT") throw new Error("ROUND_COMMIT_ACK_NOT_CONFIRMED");
        commitAck = true;
        const phase = state.phases[domain], committed = {
            ...phase, nextIndex: batchIntent.end,
            created: phase.created + outcomes.filter(row => row?.replayed === false).length,
            replayed: phase.replayed + outcomes.filter(row => row?.replayed === true).length,
            quarantined: phase.quarantined + quarantine.length,
        };
        const next = { ...state, phases: { ...state.phases, [domain]: committed }, quarantine: [...state.quarantine, ...quarantine], checkpoints: state.checkpoints + 1, pending: null };
        event({ domain, start, end: start + batch.length, event: "COMMIT_ACK" });
        save(next);
        Object.assign(state, { quarantine: next.quarantine, checkpoints: next.checkpoints, pending: null });
        Object.assign(phase, committed);
    }
    catch (error) {
        if (commitSent) {
            unsafeConnection = error;
            state.status = commitAck ? "RECEIPT_WRITE_FAILED_COMMITTED" : "COMMIT_UNKNOWN";
            state.pending = { ...batchIntent, stage: commitAck ? "COMMIT_ACK_RECEIPT_FAILED" : "COMMIT_UNKNOWN" };
        }
        else {
            try {
                if (unsafeConnection) throw unsafeConnection;
                if ((await client.query("ROLLBACK")).command !== "ROLLBACK") throw new Error("ROUND_ROLLBACK_ACK_NOT_CONFIRMED");
                state.rollbackConfirmed = true;
                state.pending = null;
                state.status = "FAILED_ROLLED_BACK";
            }
            catch (rollbackError) {
                unsafeConnection = rollbackError;
                state.status = "ROLLBACK_UNKNOWN";
                state.pending = { ...batchIntent, stage: "ROLLBACK_UNKNOWN" };
            }
        }
        // Keep the original failure even when the evidence volume cannot accept writes.
        try { save(); } catch { }
        try { event({ event: state.status, domain, start }); } catch { }
        throw error;
    }
    if (state.checkpoints % 10 === 0)
        console.log(JSON.stringify({ status: "PROGRESS", domain, nextIndex: start + batch.length, queries: state.queries }));
}
async function runItems(domain, items, body, batchSize = 100, beforeBatch, batchBody) {
    state.phases[domain] ??= { nextIndex: 0, created: 0, replayed: 0, quarantined: 0 };
    const phase = state.phases[domain], started = performance.now(), queriesBefore = state.queries, checkpointsBefore = state.checkpoints;
    const segment = { startedAt: new Date().toISOString(), startIndex: phase.nextIndex, queriesBefore, batchSize, concurrency: 1 };
    phase.timingSegments ??= [];
    phase.timingSegments.push(segment);
    save();
    let failed = false;
    try {
        let index = 0, batch = [];
        for await (const row of items) {
            if (index++ < phase.nextIndex) continue;
            batch.push(row);
            if (batch.length === batchSize) {
                await checkpointBatch(domain, batch, index - batch.length, body, beforeBatch, batchBody);
                batch = [];
            }
        }
        if (batch.length) await checkpointBatch(domain, batch, index - batch.length, body, beforeBatch, batchBody);
        phase.complete = true;
        save();
    }
    catch (error) {
        failed = true;
        throw error;
    }
    finally {
        Object.assign(segment, { finishedAt: new Date().toISOString(), monotonicElapsedMs: performance.now() - started, endIndex: phase.nextIndex, committedItems: phase.nextIndex - segment.startIndex, committedChunks: state.checkpoints - checkpointsBefore, queriesAfter: state.queries, queryDelta: state.queries - queriesBefore, complete: phase.complete === true });
        try { save(); } catch (error) { if (!failed) throw error; }
        if (phase.complete) console.log(JSON.stringify({ status: "PHASE_COMPLETE", domain, ...phase }));
    }
}
/** Batch-body variant: chunkBody(rows) writes a whole checkpoint chunk and returns one outcome per row. */
async function runBatches(domain, items, chunkBody, batchSize = 500) {
    return runItems(domain, items, null, batchSize, undefined, chunkBody);
}
async function runPhase(domain, body, batchSize = 100) { const file = domainFile(domain); if (file)
    return runItems(domain, readRows(file), body, batchSize); }
async function applyUser(row, profiles) { const result = await mod("supply/legacy-user-migration").migrateLegacyOwner(client, row.input, actor); if (row.trustedIdentityNumber) {
    const wanted = subject.identitySubjectDigest(row.trustedIdentityNumber, subjectKey);
    const old = (await client.query("SELECT subject_digest,source FROM zzsh_iam.user_identity_subject WHERE user_id=$1", [row.userId])).rows[0];
    if (old && (old.subject_digest !== wanted || old.source !== "LEGACY_IMPORT"))
        throw new Error("LEGACY_SUBJECT_BINDING_CONFLICT");
    if (!old)
        await subject.recordLegacyIdentitySubject(client, row.userId, row.trustedIdentityNumber, subjectKey);
    if (hasIdentityProfiles) {
        if (!row.legacyIdentityProfile) throw new Error("LEGACY_IDENTITY_PROFILE_SOURCE_MISSING");
        const entry = { binding: { userId: row.userId, sourceRef: "la_user:" + row.sourceId,
            sourceDigest: row.sourceDigest, subjectDigest: wanted }, details: row.legacyIdentityProfile };
        if (profiles) profiles.push(entry);
        else await identityProfile.recordLegacyIdentityProfile(client, entry.binding, entry.details, profileKey, subjectKey);
    }
} else if (hasIdentityProfiles && (row.input.evidence.status.realNameBound || row.legacyIdentityProfile)) {
    throw new Error("LEGACY_IDENTITY_SUBJECT_SOURCE_MISSING");
} return result; }
async function applyUsers() {
    if (!strictBatch) return runPhase("users", row => applyUser(row));
    const file = domainFile("users"); if (!file) return;
    return runBatches("users", readRows(file), async (batch, start) => {
        const results = [], profiles = [];
        for (const [offset, row] of batch.entries()) {
            try { results.push(await applyUser(row, profiles)); }
            catch (error) { try { event({ event: "STRICT_ROW_REJECTED", domain: "users", index: start + offset, status: error?.status ?? null }); } catch { } throw error; }
        }
        if (profiles.length) {
            try { await identityProfile.recordLegacyIdentityProfiles(client, profiles, profileKey, subjectKey); }
            catch (error) { try { event({ event: "STRICT_BATCH_REJECTED", domain: "users", start, count: profiles.length, status: error?.status ?? null }); } catch { } throw error; }
        }
        return results;
    }, 100);
}
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
    } else resourceState.protectedDataset={manifestSha256:state.binding.datasetSha256,epoch:{oid:expectedOid,nonce:expectedNonce},reason:"REHEARSAL_REVIEW",status,report:statePath,
        ...(strictBatch ? { bootstrapReservation: isStrictRoundReservation(registeredReservation) ? registeredReservation : strictRoundReservation } : {})};
    return resourceState;
}
resetRunCleanup();
try {
    await maintenance.connect();
    held = (await maintenance.query(advisoryLockSql(registered, "try"))).rows[0].ok;
    if (!held)
        throw new Error("REGRESSION_RESOURCE_BUSY");
    if (registered.migrationProfile === NEXT_MIGRATION_PROFILE && !recover)
        fenceEpoch = await captureMaintenanceLockEpoch(maintenance, registered);
    let startingResource;
    if (!fenceEpoch) startingResource = readStartingResource();
    client = await pool.connect();
    // pg emits socket errors separately from rejecting the active query.
    client.on("error", error => { unsafeConnection ??= error; });
    const original = client.query.bind(client);
    client.query = (...args) => { state.queries++; return original(...args); };
    const actual = (await client.query(targetIdentityQuery())).rows[0];
    // Every field of the registered target - including the cluster identity when the registry pins
    // one - is proved on the live connection before this run opens a transaction.
    assertLiveTarget(registered, actual);
    if (actual.role_oid !== credentials.migration.oid || actual.oid !== expectedOid || actual.nonce !== expectedNonce)
        throw new Error("TARGET_IDENTITY_CHANGED");
    if (fenceEpoch) {
        await acquireMigrationSessionFence(client, registered, fenceEpoch); fenceHeld = true;
        // A predecessor may have finished while this process waited for the target fence.
        startingResource = readStartingResource();
    }
    resetRunCleanup();
    if(refundAttemptsBinding&&state.refundAttemptsBinding&&JSON.stringify(state.refundAttemptsBinding)!==JSON.stringify(refundAttemptsBinding))throw new Error("REFUND_ATTEMPT_CHECKPOINT_BINDING_CHANGED");
    if (recover) {
        const { pending, status } = state;
        writeFileSync(join(output, "recovery-" + Date.now() + ".json"), JSON.stringify({ mode: "READ_ONLY", binding, pending, checkpointStatus: status, knowledge: "EXACT_PENDING_KEYS_REQUIRE_INSPECTION" }, null, 2), { flag: "wx" });
        console.log(JSON.stringify({ status: "READ_ONLY_RECOVERY_RECORDED", phase: pending.domain }));
    }
    else {
        await mod("database/business-migrations").assertBusinessMigrationPrefix(client);
        await client.query("BEGIN READ ONLY");
        if (expectedSchema) {
            const actualSchema = (await client.query("SELECT hash FROM zzsh_business_meta.migrations ORDER BY id")).rows.map(row => row.hash);
            if (JSON.stringify(actualSchema) !== JSON.stringify(expectedSchema)) throw new Error("ROUND_SCHEMA_NOT_EXACT");
            if (!Object.keys(state.phases).length) {
                const occupied = (await client.query(`SELECT EXISTS(SELECT FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore')
                    OR EXISTS(SELECT FROM zzsh_supply.legacy_supply_map)
                    OR EXISTS(SELECT FROM zzsh_order.legacy_order_read_snapshot)
                    OR EXISTS(SELECT FROM zzsh_order.personal_finance_observation)
                    OR EXISTS(SELECT FROM zzsh_order.personal_finance_observation_coverage)
                    OR EXISTS(SELECT FROM zzsh_order.finance_opening_basis)
                    OR EXISTS(SELECT FROM zzsh_order.rental_order) AS occupied`)).rows[0]?.occupied;
                if (occupied !== false) throw new Error("ROUND_TARGET_NOT_EMPTY");
            }
        }
        await mod("finance/personal-finance-maintenance").authorizeFinanceMaintenance(client, actor);
        for (const code of Object.values(manifest.gameBindings)) {
            const game = (await client.query("SELECT id,enabled FROM zzsh_supply.game WHERE code=$1", [code])).rows[0];
            if (!game || !game.enabled)
                throw new Error("REVIEWED_REFERENCE_GAME_REQUIRED");
            if (state.gameBindings?.[code] && state.gameBindings[code] !== game.id)
                throw new Error("TARGET_GAME_BINDING_DRIFT");
            gameIds.set(code, game.id);
        }
        try {
            if ((await client.query("ROLLBACK")).command !== "ROLLBACK") throw new Error("ROUND_ROLLBACK_ACK_NOT_CONFIRMED");
        } catch (error) { unsafeConnection = error; throw error; }
        assertRoundWindow();
        if (expectedSchema && !contactAppend && !numberOnly && startingResource.protectedDataset
            && startingResource.protectedDataset.manifestSha256 !== binding.datasetSha256) throw new Error("DIFFERENT_DATASET_ALREADY_PROTECTED");
        createOutput();
        checkpointOwned = true;
        state.resource = actual;
        if(fundsSourceBinding)state.fundsSourceBinding=fundsSourceBinding;
        if(refundAttemptsBinding)state.refundAttemptsBinding=refundAttemptsBinding;
        state.gameBindings = Object.fromEntries(gameIds);
        state.status = "RUNNING";
        protectDataset(startingResource, "BUILDING");
        writeLoadCheckpoint(registered.sourceFile, startingResource);
        save();
        if (contactAppend || numberOnly) {
            const { applyContactAppend, applyNumberBindings } = await import("./local-target-contact-append.mjs");
            const ctx = { client, actor, mod, manifest, state, output, domainFile, readRows, runItems, runBatches, save, event, isNextMigration: registered.migrationProfile === NEXT_MIGRATION_PROFILE };
            if (numberOnly) await applyNumberBindings(ctx);
            else {
                await applyContactAppend(ctx, { applyUsers, applyAccounts, applyOrders, display: { directory: option("--display-plan"), sha256: option("--display-plan-sha") },
                    holdings: { source: option("--holding-source"), sourceSha256: option("--holding-source-sha"), dictionary: option("--skin-dictionary"), dictionarySha256: option("--skin-dictionary-sha"), mappingOverlay: option("--holding-mapping-overlay"), mappingOverlaySha256: option("--holding-mapping-overlay-sha") } });
            }
            state.status = numberOnly ? "LOCAL_DATASET_PUBLIC_NUMBERS_COMMITTED_REVIEW_REQUIRED" : "LOCAL_DATASET_CONTACT_APPEND_COMMITTED_REVIEW_REQUIRED";
        }
        else if (holdingsOnly) {
            const { applyHoldingDomain } = await import("./local-target-holdings.mjs");
            await applyHoldingDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, runBatches, save, event }, { source: option("--holding-source"), sourceSha256: option("--holding-source-sha"), dictionary: option("--skin-dictionary"), dictionarySha256: option("--skin-dictionary-sha"), mappingOverlay: option("--holding-mapping-overlay"), mappingOverlaySha256: option("--holding-mapping-overlay-sha") });
            state.status = "LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED";
        }
        else if (openingOnly) {
            const { applyOpeningDomain } = await import("./local-target-opening.mjs");
            await applyOpeningDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, runBatches, save, event, targetPort: registered.port ?? registered.instance?.port ?? null }, option("--opening-proof"), option("--opening-proof-sha"));
            state.status = "LOCAL_DATASET_STORED_OPENINGS_COMMITTED_REVIEW_REQUIRED";
        }
        else if (displayOnly) {
            const { applyDisplayDomain } = await import("./local-target-display.mjs");
            await applyDisplayDomain({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, runBatches, save, event }, option("--display-plan"), option("--display-plan-sha"));
            state.status = "LOCAL_DATASET_DISPLAY_ENRICHMENT_COMMITTED_REVIEW_REQUIRED";
        }
        else {
            await applyUsers();
            await applyAccounts();
            await applyOrders();
            if(coreOnly){
                if(!["users","accounts","orders"].every(domain=>state.phases[domain]?.complete===true))throw new Error("CORE_SOURCE_PHASES_NOT_COMPLETE");
                state.status="LOCAL_DATASET_CORE_ONLY_COMMITTED_FINANCE_NOT_RUN";
            }else{
                const { applyFinancialDomains } = await import("./local-target-finance.mjs");
                await applyFinancialDomains({ client, actor, mod, manifest, state, output, domainFile, readRows, runItems, runBatches, save, event, invitationSource, invitationPacketCount, isNextMigration: registered.migrationProfile === NEXT_MIGRATION_PROFILE, targetPort: registered.port ?? registered.instance?.port ?? null, apiDist:api,fundsSource:fundsSourceBinding,refundAttemptsSource:refundAttemptsBinding });
                state.status = "LOCAL_DATASET_CORE_AND_FINANCIAL_DOMAINS_COMMITTED_REVIEW_REQUIRED";
            }
        }
        save();
    }
}
catch (error) {
    const batchFailure = ["COMMIT_UNKNOWN", "ROLLBACK_UNKNOWN", "RECEIPT_WRITE_FAILED_COMMITTED"].includes(state.status);
    if (!checkpointOwned || (!batchFailure && (!strictBatch || state.status !== "FAILED_ROLLED_BACK")))
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
    let fencedProtectionHandled = false;
    if (client) {
        if (!recover && !unsafeConnection && !state.rollbackConfirmed) {
            try {
                if ((await client.query("ROLLBACK")).command !== "ROLLBACK") throw new Error("ROUND_ROLLBACK_ACK_NOT_CONFIRMED");
                state.rollbackConfirmed = true;
            } catch (error) { unsafeConnection = error; }
        }
        if (fenceHeld) {
            fencedProtectionHandled = true;
            if (checkpointOwned && (strictBatch || state.pending || Object.values(state.phases).some(phase => phase.nextIndex > 0))) {
                try {
                    const resourceState = JSON.parse(readFileSync(registered.sourceFile));
                    assertResource(resourceState, state);
                    protectDataset(resourceState, state.status);
                    writeLoadCheckpoint(registered.sourceFile, resourceState);
                    state.protectionRecorded = true;
                } catch (error) { unsafeConnection ??= error; process.exitCode = 1; }
            }
            if (!unsafeConnection) {
                try { await releaseMigrationSessionFence(client, registered); state.targetFenceReleased = true; }
                catch (error) { state.targetFenceReleased = false; unsafeConnection = error; process.exitCode = 1; }
            } else state.targetFenceReleased = false;
        }
        client.release(unsafeConnection);
    }
    try { await pool.end(); state.poolClosed = true; } catch { state.poolClosed = false; process.exitCode=1; }
    if (!fencedProtectionHandled && checkpointOwned && (strictBatch || state.pending || Object.values(state.phases).some(phase => phase.nextIndex > 0))) {
        try {
            const resourceState = JSON.parse(readFileSync(registered.sourceFile));
            assertResource(resourceState, state);
            protectDataset(resourceState, state.status);
            writeLoadCheckpoint(registered.sourceFile, resourceState);
            state.protectionRecorded = true;
        } catch { process.exitCode = 1; }
    }
    if (held) {
        try {
            state.unlock = (await maintenance.query(advisoryLockSql(registered, "unlock"))).rows[0].ok;
        }
        catch {
            state.unlock = false;
        }
    }
    try { await maintenance.end(); state.maintenanceClosed = true; } catch { state.maintenanceClosed = false; process.exitCode=1; }
    if(checkpointOwned && (!state.poolClosed || !state.unlock || !state.maintenanceClosed || !state.rollbackConfirmed
        || registered.migrationProfile === NEXT_MIGRATION_PROFILE && state.targetFenceReleased !== true)) process.exitCode=1;
    state.updatedAt = new Date().toISOString();
    try {
        save();
    }
    catch { process.exitCode = 1; }
    console.log(JSON.stringify({ status: state.status, phases: state.phases, quarantine: state.quarantine.length, queries: state.queries, unlock: state.unlock, poolClosed: state.poolClosed, checkpointOwned }));
}
