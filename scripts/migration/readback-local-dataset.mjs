import {assertEmptyCoverageReceiptMode,assertRebuiltEmptyCoverageChunk,assertRebuiltEmptyCoverageManifest,readCompactCoverageEvidence,continuationCommissionEffects,prepareLocalFundsPlan} from "./local-funds-plan.mjs";
import { acquireMigrationTransactionFence, advisoryLockSql, assertCoreSystemMigrationBinding, assertLiveTarget, assertMigrationFenceHeld, assertReadbackTarget, captureMaintenanceLockEpoch, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";
import { compareKeySets } from "./local-key-set.mjs";
import { legacyListedIdsDigest, legacyListedSourceForReadback, legacyListedTargetMatches } from "./selected-business-scope.mjs";
import { readBoundSelectedSourceReceipt, verifySelectedPopulationFiles } from "./verify-full-source-population.mjs";
import { assertLegacyIdentityColumns, assertDisplayCaptureCoverage, assertNextBusinessPopulation, inspectUnresolvedRefundSource, matchesLegacyIdentitySource, classifyLegacyRegistrationTime, compareLegacyRegistrationFact, matchesLegacyAccountMetricAudit, readSystemMigrationAudits, matchesSystemMigrationAudit, legacyAccountCaptureProof, matchesLegacyAccountCapture, matchesCapturedAccountBaseRatio, matchesCapturedAccountFullPayout, legacyOrderCaptureProof, matchesLegacyOrderCapture, readBoundSourceRows, readSourceRows as rows } from "./local-source-adapter.mjs";
import { assessInvitationChildSet, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";
import { prepareLegalPair, readPinnedRegularFile, verifyLegalPair } from "./local-legal-pair.mjs";
import { assertRentalReferenceReceipt, readTargetRentalReference, verifyRuntimeRentalReference } from "./business-reference-readiness.mjs";
import { createHash, createHmac } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (!args.includes("--readback")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--readback", "--dataset", "--dataset-sha", "--checkpoint", "--credentials", "--out"], connections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}
if (process.version !== "v24.20.0") throw new Error("NODE_BASELINE_MISMATCH");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), api = resolve(option("--api-dist") ?? join(root, "apps/api/dist/src")), require = createRequire(join(api,"app.js")), { Client } = require("pg");
const hash = value => createHash("sha256").update(value).digest("hex");
const dataset = resolve(option("--dataset") ?? ""), checkpoint = resolve(option("--checkpoint") ?? ""), output = resolve(option("--out") ?? "");
if (![dataset, checkpoint].every(path => path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")) || existsSync(output)) throw new Error("BOUND_PRIVATE_INPUT_NEW_RECEIPT_REQUIRED");
const credentialPath = option("--credentials");
if (!credentialPath) throw new Error("REGISTERED_CREDENTIAL_REQUIRED");
const registration = loadRegisteredTarget(credentialPath);
const bytes = readFileSync(join(dataset, "manifest.json"));
if (hash(bytes) !== option("--dataset-sha")) throw new Error("DATASET_MANIFEST_SHA_MISMATCH");
const manifest = JSON.parse(bytes), state = JSON.parse(readFileSync(checkpoint));
assertNextBusinessPopulation(manifest.population, registration.migrationProfile === NEXT_MIGRATION_PROFILE);
if (manifest.population?.mode === "SELECTED_BUSINESS_SCOPE") {
  const times=manifest.registrationTimeSource;
  if (!times || ![times.VALID,times.MISSING,times.INVALID].every(n=>Number.isSafeInteger(n)&&n>=0)
    || times.VALID+times.MISSING+times.INVALID!==manifest.domains?.users?.source) throw new Error("SOURCE_REGISTRATION_TIME_COUNTS_REQUIRED");
}
// The checkpoint may only be reconciled against the target its registry names, never against a
// database name repeated in this script.
if (state.binding?.datasetSha256 !== option("--dataset-sha") || state.binding.database !== registration.database || state.binding.oid !== registration.oid || state.pending || state.status === "RUNNING" || !["users", "accounts", "orders"].every(name => state.phases[name]?.complete)) throw new Error("KNOWN_COMPLETED_CORE_CHECKPOINT_REQUIRED");
if (registration.migrationProfile === NEXT_MIGRATION_PROFILE && (state.targetFenceReleased !== true || state.protectionRecorded !== true))
  throw new Error("TARGET_FENCE_CLEANUP_UNCONFIRMED");
for (const [name, entry] of Object.entries(manifest.files)) {
  if (entry.file !== basename(entry.file)) throw new Error("DATASET_FILE_PATH_INVALID");
  const digest = createHash("sha256"); for await (const bytes of createReadStream(join(dataset, entry.file))) digest.update(bytes);
  if (digest.digest("hex") !== entry.sha256) throw new Error("DATASET_FILE_SHA_MISMATCH:" + name);
}
let listedSource, listedBinding, listedSourceOrigin, listedSourceReceipt;
if (registration.migrationProfile === NEXT_MIGRATION_PROFILE) {
  const source = readBoundSelectedSourceReceipt(manifest.source, manifest.sourceReceiptSha256);
  listedSourceReceipt = source;
  if (source.status !== "CAPTURED_READ_ONLY" || source.rollbackConfirmed !== true || source.clientClosed !== true)
    throw new Error("LEGACY_LISTED_SOURCE_RECEIPT_UNCONFIRMED");
  ({source:listedSource,origin:listedSourceOrigin}=await legacyListedSourceForReadback(state.sourceScopeVerification,
    () => verifySelectedPopulationFiles({datasetDir:dataset,sourceDir:manifest.source,dataset:manifest,source})));
  if (listedSource?.schema !== "zzsh.legacy-listed-source-scope.v2") throw new Error("LEGACY_LISTED_SOURCE_PROOF_UNAVAILABLE");
  for (const name of ["accounts", "games"]) {
    const entry = source.files?.[name];
    if (!entry && name === "games") continue;
    if (!entry || entry.file !== basename(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ""))
      throw new Error("LEGACY_LISTED_SOURCE_FILE_INVALID:" + name);
    const file = join(manifest.source, entry.file), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("LEGACY_LISTED_SOURCE_FILE_INVALID:" + name);
    // The existing account capture proof below already hashes and reads the full account source.
    if (name === "accounts") continue;
    const digest = createHash("sha256"); for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest("hex") !== entry.sha256) throw new Error("LEGACY_LISTED_SOURCE_FILE_CHANGED:" + name);
  }
  listedBinding = { sourceReceiptSha256: manifest.sourceReceiptSha256, sourceAccountsSha256: source.files.accounts.sha256,
    sourceGamesSha256: source.files.games?.sha256 ?? null, datasetAccountsSha256: manifest.files.accounts?.sha256 ?? null,
    gameBindingsSha256: hash(JSON.stringify(manifest.gameBindings ?? {})) };
  if (Object.entries(listedBinding).some(([key, value]) => listedSource.binding?.[key] !== value))
    throw new Error("LEGACY_LISTED_SOURCE_BINDING_CHANGED");
}
const credential = JSON.parse(readFileSync(credentialPath));
assertReadbackTarget(registration, state.binding, credential);
const maintenance = new Client(maintenanceConnection(registration, { user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? join(root, "apps/api/.secrets/postgres_password"), "utf8").trim(), applicationName: "core-dataset-reconciliation-lock", connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 }));
const db = new Client(targetConnection(registration, { user: credential.migration.name, password: credential.migration.password, applicationName: "core-dataset-reconciliation-read-only", connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 }));
const mod = name => require(join(api, name + ".js"));
const canonical = mod("supply/content-hash").canonicalize, accountId = mod("legacy-load/legacy-account-seam").legacyAccountId, orderRead = mod("order/legacy-order-read");
const hasSystemIds = ["systemUserId","systemAccountId","systemOrderId"].some(key => state.binding?.[key] !== undefined);
const systemCore = assertCoreSystemMigrationBinding(registration,state.binding,hasSystemIds ? mod("legacy-load/system-user-migration") : null);
const hasIdentityProfiles = manifest.identityProfiles?.schema === "zzsh.legacy-identity-profile-source.v1";
if (manifest.identityProfiles && (!hasIdentityProfiles || manifest.identityProfiles.invalid !== 0
  || manifest.identityProfiles.verified !== manifest.identityProfiles.ready)) throw new Error("LEGACY_IDENTITY_PROFILE_SOURCE_INCOMPLETE");
let identityProfile, identitySubject, profileKey, subjectKey, sourceUsers, expectedSourceUsers = 0, previousSourceId = -1n;
let legalService, preparedLegal, legalInputSha, businessReceipt, businessReceiptFile, businessReceiptSha;
if (hasIdentityProfiles || option("--legal-input")) {
  const file = option("--legal-input"), expected = option("--legal-input-sha");
  if (!file || !resolve(file).toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || !/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("LEGAL_INITIAL_INPUT_REQUIRED");
  const inputBytes = readPinnedRegularFile(file);
  if (hash(inputBytes) !== expected) throw new Error("LEGAL_INITIAL_INPUT_CHANGED");
  legalInputSha = expected; legalService = mod("legal/legal-documents");
  preparedLegal = prepareLegalPair(JSON.parse(inputBytes), readPinnedRegularFile, legalService);
}
if (hasIdentityProfiles || option("--business-bootstrap")) {
  businessReceiptFile = option("--business-bootstrap"); businessReceiptSha = option("--business-bootstrap-sha");
  if (!businessReceiptFile || !resolve(businessReceiptFile).toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")
    || !/^[a-f0-9]{64}$/.test(businessReceiptSha ?? "")) throw new Error("RENTAL_REFERENCE_BOOTSTRAP_REQUIRED");
  const businessBytes = readPinnedRegularFile(businessReceiptFile, 2_000_000);
  if (hash(businessBytes) !== businessReceiptSha) throw new Error("RENTAL_REFERENCE_BOOTSTRAP_CHANGED");
  businessReceipt = JSON.parse(businessBytes); assertRentalReferenceReceipt(businessReceipt);
  if (businessReceipt.status !== "REFERENCE_BOOTSTRAP_COMMITTED" || businessReceipt.commitAck !== true
    || businessReceipt.maintenanceClosed !== true || businessReceipt.poolClosed !== true || businessReceipt.unlock !== true
    || String(businessReceipt.oid) !== registration.oid || businessReceipt.nonce !== registration.nonce
    || JSON.stringify(businessReceipt.instance ?? null) !== JSON.stringify(registration.instance ?? null)
    || (businessReceipt.migrationProfile ?? null) !== registration.migrationProfile
    || registration.migrationProfile === NEXT_MIGRATION_PROFILE && businessReceipt.targetFence !== "HELD_UNTIL_TRANSACTION_END"
    || businessReceipt.rentalReference.validatorSha256 !== hash(readFileSync(new URL("./business-reference-readiness.mjs", import.meta.url))))
    throw new Error("RENTAL_REFERENCE_BOOTSTRAP_UNCONFIRMED");
}
const identitySource = { rows: 0, verified: 0, closed: false };
async function nextIdentitySource() {
  const next = await sourceUsers.next();
  if (!next.done) {
    if (typeof next.value.id !== "string" || !/^\d{1,32}$/.test(next.value.id)) throw new Error("IDENTITY_SOURCE_KEY_INVALID");
    const id = BigInt(next.value.id);
    if (id <= previousSourceId) throw new Error("IDENTITY_SOURCE_ORDER_INVALID");
    previousSourceId = id; identitySource.rows++;
    if (next.value.is_bind_id === "1") identitySource.verified++;
  }
  return next;
}
if (hasIdentityProfiles) {
  if (!process.env.USER_LEGACY_IDENTITY_PROFILE_KEY_FILE) throw new Error("LEGACY_IDENTITY_PROFILE_KEY_FILE_REQUIRED");
  identityProfile = mod("auth/legacy-identity-profile"); identitySubject = mod("auth/identity-subject");
  const profileSecret = readFileSync(process.env.USER_LEGACY_IDENTITY_PROFILE_KEY_FILE, "utf8").trim();
  const subjectSecret = readFileSync(process.env.USER_IDENTITY_SUBJECT_HMAC_KEY_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/user_identity_subject_hmac", "utf8").trim();
  if (profileSecret === subjectSecret) throw new Error("LEGACY_IDENTITY_PROFILE_KEY_NOT_INDEPENDENT");
  profileKey = identityProfile.legacyIdentityProfileKey(profileSecret); subjectKey = identitySubject.deriveIdentitySubjectKey(subjectSecret);
  if (state.binding.identityProfileKeyProof !== createHmac("sha256", profileKey).update("legacy-profile-key-v1:" + hash(bytes)).digest("hex")
    || state.binding.identitySubjectKeyProof !== createHmac("sha256", subjectKey).update("legacy-subject-key-v1:" + hash(bytes)).digest("hex")) throw new Error("LEGACY_IDENTITY_PROFILE_KEY_BINDING_CHANGED");
  const receiptBytes = readFileSync(join(manifest.source, "receipt.json"));
  if (hash(receiptBytes) !== manifest.sourceReceiptSha256) throw new Error("IDENTITY_SOURCE_RECEIPT_CHANGED");
  const sourceReceipt = JSON.parse(receiptBytes), file = sourceReceipt.files?.users;
  if (sourceReceipt.status !== "CAPTURED_READ_ONLY" || sourceReceipt.rollbackConfirmed !== true || sourceReceipt.clientClosed !== true
    || !file || file.file !== basename(file.file) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) throw new Error("IDENTITY_SOURCE_RECEIPT_INVALID");
  assertLegacyIdentityColumns(new Set(file.fields ?? []));
  const path = join(manifest.source, file.file);
  if (registration.migrationProfile !== NEXT_MIGRATION_PROFILE) {
    const digest = createHash("sha256");for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (digest.digest("hex") !== file.sha256) throw new Error("IDENTITY_SOURCE_FILE_CHANGED");
  }
  if (!Number.isSafeInteger(file.rows) || file.rows < 0) throw new Error("IDENTITY_SOURCE_COUNT_INVALID");
  expectedSourceUsers = file.rows;
  sourceUsers = registration.migrationProfile === NEXT_MIGRATION_PROFILE ? readBoundSourceRows(path,file) : rows(path);
}
const originalMetricSources = manifest.legacyDashboardSources ? {} : null;
if (originalMetricSources) {
  const sourceReceiptBytes = readFileSync(join(manifest.source, "receipt.json"));
  if (hash(sourceReceiptBytes) !== manifest.sourceReceiptSha256) throw new Error("METRIC_SOURCE_RECEIPT_CHANGED");
  const sourceReceipt = JSON.parse(sourceReceiptBytes);
  if (sourceReceipt.status !== "CAPTURED_READ_ONLY" || sourceReceipt.rollbackConfirmed !== true || sourceReceipt.clientClosed !== true) throw new Error("METRIC_SOURCE_RECEIPT_UNCONFIRMED");
  for (const domain of ["accounts", "orders"]) {
    const entry = sourceReceipt.files?.[domain];
    if (!entry || entry.file !== basename(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error("METRIC_SOURCE_FILE_INVALID:" + domain);
    const path = join(manifest.source, entry.file);
    if (registration.migrationProfile !== NEXT_MIGRATION_PROFILE) {
      const digest = createHash("sha256");for await (const bytes of createReadStream(path)) digest.update(bytes);
      if (digest.digest("hex") !== entry.sha256) throw new Error("METRIC_SOURCE_FILE_CHANGED:" + domain);
    }
    const records = new Map();
    for await (const raw of (registration.migrationProfile === NEXT_MIGRATION_PROFILE ? readBoundSourceRows(path,entry) : rows(path))) {
      if (!raw?.id || records.has(raw.id)) throw new Error("METRIC_SOURCE_KEY_INVALID:" + domain);
      records.set(raw.id, domain === "accounts" ? legacyAccountCaptureProof(raw, canonical) : legacyOrderCaptureProof(raw, orderRead.LEGACY_ORDER_READ_SOURCE_FIELDS, canonical));
    }
    if (records.size !== entry.rows) throw new Error("METRIC_SOURCE_COUNT_CHANGED:" + domain);
    originalMetricSources[domain] = records;
  }
}
let listedAccountSources = originalMetricSources?.accounts ?? null;
if (listedSource && !listedAccountSources) {
  const entry = listedSourceReceipt.files.accounts, path = join(manifest.source, entry.file);
  listedAccountSources = new Map();
  for await (const raw of readBoundSourceRows(path,entry)) {
    if (!raw?.id || listedAccountSources.has(raw.id)) throw new Error("LEGACY_LISTED_SOURCE_ACCOUNT_INVALID");
    listedAccountSources.set(raw.id, legacyAccountCaptureProof(raw, canonical));
  }
  if (listedAccountSources.size !== entry.rows) throw new Error("LEGACY_LISTED_SOURCE_ACCOUNT_COUNT_CHANGED");
}
const report = { schema: "zzsh.local-dataset-readback.v1", startedAt: new Date().toISOString(), resource: { oid: state.binding.oid, nonce: state.binding.nonce, database: registration.database, ...(registration.instance ? {instance:registration.instance} : {}), ...(registration.migrationProfile ? {migrationProfile:registration.migrationProfile} : {}) }, sourceDatasetSha256: option("--dataset-sha"), status: "STARTED", queries: 0, domains: {}, differences: [], differenceCount: 0, targetWrites: 0, rollbackConfirmed: false, lockReleased: false, connectionsClosed: false };
const systemAttribution = systemCore ? Object.fromEntries(["users","accounts","orders"].map(name=>[name,{expected:0,matched:0}])) : null;
if (listedSource) { report.legacyListedSource = listedSource; report.legacyListedSourceOrigin = listedSourceOrigin; }
const difference = (domain, id, reason) => { report.differenceCount++; if (report.differences.length < 100) report.differences.push({ domain, id, reason }); };
const query = async (...args) => { report.queries++; return db.query(...args); };
async function batched(domain, apply, collect = null, batchSize = 1000, source = null) { let batch = [], count = 0;
  let input=source;
  if(!input){const entry=manifest.files[domain],path=join(dataset,entry.file);
    input=registration.migrationProfile===NEXT_MIGRATION_PROFILE?readBoundSourceRows(path,entry):rows(path);}
  for await (const row of input) { batch.push(row); if (collect) collect.push(row.sourceId); if (batch.length === batchSize) { await apply(batch); count += batch.length; batch = []; } } if (batch.length) { await apply(batch); count += batch.length; } return count; }
const started = performance.now(); let held = false, connected = false, fenceEpoch;
try {
  await maintenance.connect(); held = (await maintenance.query(advisoryLockSql(registration, "try"))).rows[0].ok;
  if (!held) throw new Error("REGRESSION_RESOURCE_BUSY");
  fenceEpoch = registration.migrationProfile === NEXT_MIGRATION_PROFILE ? await captureMaintenanceLockEpoch(maintenance, registration) : null;
  await db.connect(); connected = true; await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const actual = (await query(targetIdentityQuery())).rows[0];
  assertLiveTarget(registration, actual);
  if (fenceEpoch) {
    await acquireMigrationTransactionFence({ query, getTransactionStatus: () => db.getTransactionStatus() }, registration, fenceEpoch);
    report.targetFence = "HELD_UNTIL_ROLLBACK";
  }
  if (preparedLegal) report.legal = { status: "VERIFIED", inputSha256: legalInputSha,
    ...verifyLegalPair(await legalService.readCurrentPlatformDocuments(db), preparedLegal) };
  if (businessReceipt) {
    const actualReference = await readTargetRentalReference({ query }, businessReceipt.rentalReference.gameCode);
    if (actualReference.targetDigest !== businessReceipt.rentalReference.targetDigest
      || ["gameCode", "termOptions", "enabledItems", "fullPayout"].some(field => actualReference[field] !== businessReceipt.rentalReference[field])
      || JSON.stringify(actualReference.tableCounts) !== JSON.stringify(businessReceipt.rentalReference.tableCounts))
      throw new Error("RENTAL_REFERENCE_TARGET_CHANGED");
    if (credential.runtime?.name !== registration.runtimeRole || credential.runtime?.oid !== registration.runtimeRoleOid
      || typeof credential.runtime.password !== "string" || !credential.runtime.password) throw new Error("RENTAL_REFERENCE_RUNTIME_ROLE_CHANGED");
    const runtimeDb = new Client(targetConnection(registration, { user: credential.runtime.name, password: credential.runtime.password,
      applicationName: "rental-reference-runtime-readback", connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 }));
    const runtimeProof = await verifyRuntimeRentalReference(runtimeDb, businessReceipt.rentalReference, async client => {
      const identity = (await client.query(targetIdentityQuery())).rows[0];
      assertLiveTarget(registration, identity, "runtime");
      if (identity.read_only !== "on") throw new Error("RENTAL_REFERENCE_RUNTIME_NOT_READ_ONLY");
    });
    if (hash(readPinnedRegularFile(businessReceiptFile, 2_000_000)) !== businessReceiptSha) throw new Error("RENTAL_REFERENCE_BOOTSTRAP_CHANGED");
    report.rentalReference = { status: "TARGET_CONFIG_VERIFIED", businessReceiptSha256: businessReceiptSha,
      targetDigest: actualReference.targetDigest, ...runtimeProof, apiAvailability: "NOT_ASSESSED" };
  }
  const userKeys = [], accountKeys = [], orderKeys = [];
  const registrationTime = { sourceCaptured: manifest.registrationTimeSource ?? null, readySource: { VALID: 0, MISSING: 0, INVALID: 0 }, targetFactMissing: 0, targetLegacyIdMismatch: 0, targetTimeMismatch: 0 };
  const identityProfiles = { expected: 0, sourceMatched: 0, matched: 0, target: 0 };
  const users = await batched("users", async batch => {
    const actual = new Map((await query(`SELECT u.id,u.name,u."phoneNumber",u."phoneNumberVerified",u.suspended,u.image,
       i.provider,i.provider_reference,i.account_status,i.identity_status,i.age_status,i.verified_at,
       c.password,c."legacyPasswordMd5" md5,c."legacyPasswordSalt" salt,c."legacyPasswordVersion" password_version,
       a.details->>'sourceDigest' source_digest,a.details->>'evidenceDigest' evidence_digest,
       p.current_kind,p.default_preset_id,p.current_preset_id,p.current_asset_id,p.current_version::text avatar_version,
       rf.user_id registration_user_id,rf.legacy_id registration_legacy_id,rf.registered_at registration_time
       FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state i ON i.user_id=u.id
       LEFT JOIN zzsh_auth_user.account c ON c."userId"=u.id AND c."providerId"='credential'
       LEFT JOIN LATERAL (SELECT details FROM zzsh_iam.audit_event WHERE object_id=u.id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS' ORDER BY occurred_at DESC LIMIT 1) a ON true
       LEFT JOIN zzsh_supply.profile_avatar p ON p.realm='user' AND p.subject_id=u.id
       LEFT JOIN zzsh_iam.user_registration_fact rf ON rf.user_id=u.id
       WHERE u.id=ANY($1::text[])`, [batch.map(row => row.userId)])).rows.map(row => [row.id, row]));
    const systemAudits = systemCore ? await readSystemMigrationAudits(query,"users",batch.map(row=>row.userId)) : null;
    const profiles = hasIdentityProfiles ? new Map((await query(`SELECT p.user_id,p.source_ref,p.source_digest,p.subject_digest,p.key_version,p.name_mask,p.document_mask,p.nonce,p.authentication_tag,p.ciphertext,
      b.subject_digest AS bound_subject_digest,b.source AS bound_source FROM zzsh_iam.user_legacy_identity_profile p
      LEFT JOIN zzsh_iam.user_identity_subject b ON b.user_id=p.user_id WHERE p.user_id=ANY($1::text[])`, [batch.map(row => row.userId)])).rows.map(row => [row.user_id,row])) : null;
    for (const row of batch) {
      const found = actual.get(row.userId), e = row.input.evidence;
      if (systemAudits) {
        systemAttribution.users.expected++;
        if(matchesSystemMigrationAudit(systemAudits.get(row.userId)??[],{objectId:row.userId,action:"user.legacy_owner.migrated",
          actorId:state.binding.systemUserId,manifestSha256:state.binding.datasetSha256,sourceSystem:e.sourceSystem,sourceEntity:e.sourceEntity,
          legacyId:e.legacyId,sourceDigest:e.sourceDigest,evidenceDigest:row.input.evidenceDigest,initialAvatarPresetId:found?.default_preset_id??null})) systemAttribution.users.matched++;
        else difference("users",row.sourceId,"SYSTEM_SOURCE_AUDIT_DRIFT");
      }
      if (profiles) {
        const stored = profiles.get(row.userId);
        let source = await nextIdentitySource();
        while (!source.done && source.value.id !== row.sourceId) source = await nextIdentitySource();
        const sameSource = !source.done && matchesLegacyIdentitySource(source.value, row);
        if (!sameSource) difference("identityProfiles", row.sourceId, "IDENTITY_ORIGINAL_SOURCE_DRIFT");
        if (e.status.realNameBound) {
          identityProfiles.expected++;
          if (sameSource) identityProfiles.sourceMatched++;
          try {
            if (!stored || !row.legacyIdentityProfile || !row.trustedIdentityNumber || stored.source_ref !== "la_user:" + row.sourceId
              || stored.source_digest !== row.sourceDigest || stored.bound_source !== "LEGACY_IMPORT"
              || stored.subject_digest !== stored.bound_subject_digest
              || stored.subject_digest !== identitySubject.identitySubjectDigest(row.trustedIdentityNumber, subjectKey)) throw new Error();
            const opened = identityProfile.openLegacyIdentityProfile({ userId: row.userId, sourceRef: stored.source_ref,
              sourceDigest: stored.source_digest, subjectDigest: stored.subject_digest },
            { keyVersion: stored.key_version, nameMask: stored.name_mask, documentMask: stored.document_mask,
              nonce: stored.nonce, tag: stored.authentication_tag, ciphertext: stored.ciphertext }, profileKey, subjectKey);
            if (opened.realName !== row.legacyIdentityProfile.realName || opened.idCardNo !== row.legacyIdentityProfile.idCardNo) throw new Error();
            identityProfiles.matched++;
          } catch { difference("identityProfiles", row.sourceId, "SOURCE_TARGET_IDENTITY_PROFILE_DRIFT"); }
        } else if (stored) difference("identityProfiles", row.sourceId, "UNVERIFIED_USER_HAS_IDENTITY_PROFILE");
      }
      registrationTime.readySource[classifyLegacyRegistrationTime(e.sourceCreatedAt, orderRead.legacyEpochTimestamp)]++;
      if (!found) { registrationTime.targetFactMissing++; difference("users", row.sourceId, "TARGET_IDENTITY_MISSING"); continue; }
      const registration = compareLegacyRegistrationFact(e.sourceCreatedAt, row.sourceId, {userId:found.registration_user_id,legacyId:found.registration_legacy_id,registeredAt:found.registration_time});
      if (registration !== "MATCH") {
        if (registration === "TARGET_FACT_MISSING") registrationTime.targetFactMissing++;
        else if (registration === "TARGET_LEGACY_ID_MISMATCH") registrationTime.targetLegacyIdMismatch++;
        else if (registration === "TARGET_TIME_MISMATCH") registrationTime.targetTimeMismatch++;
        difference("users", row.sourceId, registration);
      }
      const expectedPhone = e.contactProjection ? e.contactProjection.authenticationPhone : "+86" + e.mobile;
      const expectedPhoneVerified = e.contactProjection?.authenticationPhone != null;
      if (found.name !== e.nickname || found.phoneNumber !== expectedPhone || found.phoneNumberVerified !== expectedPhoneVerified || found.suspended !== false || found.provider !== "legacy_mysql_restore" || found.provider_reference !== "la_user:" + row.sourceId || found.account_status !== (e.status.deleted ? "CANCELLED" : e.status.disabled ? "FROZEN" : "ACTIVE") || found.identity_status !== (e.status.realNameBound ? "VERIFIED" : "UNVERIFIED") || found.age_status !== (e.status.ageAdult === true ? "ADULT" : e.status.ageAdult === false ? "MINOR" : "UNKNOWN") || found.verified_at !== null || found.source_digest !== e.sourceDigest || found.evidence_digest !== row.input.evidenceDigest) difference("users", row.sourceId, "SOURCE_STATUS_IDENTITY_OR_AUDIT_DRIFT");
      const password = e.legacyPassword;
      if (password ? found.password !== null || found.md5 !== password.md5 || found.salt !== password.salt || found.password_version !== password.version : found.md5 !== null || found.password !== null) difference("users", row.sourceId, "SOURCE_CREDENTIAL_NOT_PRESERVED");
      if (found.current_kind !== "DEFAULT" || found.default_preset_id !== found.current_preset_id || found.current_asset_id !== null || !mod("profile/profile-avatar-presets").isProfileAvatarPresetId(found.default_preset_id) || found.image !== mod("profile/profile-avatar").avatarImagePath("user", row.userId, found.avatar_version)) difference("users", row.sourceId, "PERSISTED_DEFAULT_AVATAR_NOT_BOUND");
    }
  }, userKeys);
  report.domains.users = { expected: users };
  if (hasIdentityProfiles) {
    while (!(await nextIdentitySource()).done) { /* count the complete frozen source */ }
    if (identitySource.rows !== expectedSourceUsers) difference("identityProfiles", "SOURCE", "IDENTITY_SOURCE_DENOMINATOR_DRIFT");
    identityProfiles.target = Number((await query("SELECT count(*)::int AS n FROM zzsh_iam.user_legacy_identity_profile")).rows[0].n);
    if (identityProfiles.expected !== manifest.identityProfiles.ready || identityProfiles.target !== identityProfiles.expected)
      difference("identityProfiles", "COHORT", "IDENTITY_PROFILE_DENOMINATOR_DRIFT");
    report.identityProfiles = { ...identityProfiles, source: identitySource };
  }
  report.registrationTime = registrationTime;
  const legacyListedTarget = { expectedMapped: 0, verifiedMapped: 0, missingTarget: 0, missingSnapshot: 0, published: 0 };
  const listedExpectedIds = [], listedVerifiedIds = [], listedMissingIds = [], listedMissingSnapshotIds = [], listedPublishedIds = [];
  const accounts = await batched("accounts", async batch => {
    const actual = new Map((await query(`SELECT m.legacy_id,m.account_id,m.source_digest,m.evidence_ref,m.version_id,a.owner_user_id,a.game_id,a.current_version_id,a.legacy_hold,v.origin,v.review_state,
       EXISTS(SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id) AS has_publication,
       h.account_id snapshot_account,h.snapshot,h.source_digest snapshot_digest,to_char(h.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') snapshot_updated_at,h.source_status,
       to_jsonb(h)->>'created_by_migration_id' snapshot_migration_id,to_jsonb(h)->>'migration_manifest_sha256' snapshot_manifest
       FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id JOIN zzsh_supply.listing_version v ON v.id=m.version_id
       LEFT JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id
       WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`, [batch.map(row => row.sourceId)])).rows.map(row => [row.legacy_id, row]));
    const systemAudits=systemCore ? await readSystemMigrationAudits(query,"accounts",[...actual.values()].map(row=>row.account_id)) : null;
    for (const row of batch) {
      if(systemAudits)systemAttribution.accounts.expected++;
      const nextDelta = registration.migrationProfile === NEXT_MIGRATION_PROFILE && row.gameCode === "delta";
      const listed = nextDelta && Number(row.sourceStatus) === 3 && !row.sourceDeleted;
      if (listed) { legacyListedTarget.expectedMapped++; listedExpectedIds.push(row.sourceId); }
      const captured = listedAccountSources?.get(row.sourceId);
      const captureMatches = (!listedSource || Boolean(captured && captured.sourceId === row.sourceId && captured.sourceDigest === row.sourceDigest))
        && (!originalMetricSources || matchesLegacyAccountCapture(originalMetricSources.accounts.get(row.sourceId), row, canonical));
      if (!captureMatches) difference("accounts", row.sourceId, "ACCOUNT_CAPTURE_METRIC_SOURCE_DRIFT");
      const found = actual.get(row.sourceId);
      if (!found) { if (listed) { legacyListedTarget.missingTarget++; listedMissingIds.push(row.sourceId); } difference("accounts", row.sourceId, "TARGET_ACCOUNT_MAP_MISSING"); continue; }
      const sourceMatches = found.account_id === accountId("legacy_mysql_restore", "la_rental_accounts", row.sourceId) && found.source_digest === row.sourceDigest && found.evidence_ref === row.evidenceRef && found.owner_user_id === row.ownerUserId && found.game_id === state.gameBindings[row.gameCode] && found.version_id === found.current_version_id && found.origin === "LEGACY_OBSERVATION" && found.review_state === "IMPORTED_UNVERIFIED" && found.legacy_hold === "UNRESOLVED";
      if (!sourceMatches) difference("accounts", row.sourceId, "SOURCE_OWNER_GAME_OBSERVATION_OR_HOLD_DRIFT");
      const snapshotExpected = row.snapshot && row.sourceUpdatedAt && [0, 3, 4, 5, 6].includes(Number(row.sourceStatus)) && !row.sourceDeleted;
      if (nextDelta && found.has_publication !== false) difference("accounts", row.sourceId, "MIGRATED_ACCOUNT_HAS_PUBLICATION");
      if (listed && !snapshotExpected) difference("accounts", row.sourceId, "LISTED_SOURCE_SNAPSHOT_MISSING");
      const snapshotMatches = snapshotExpected ? Boolean(found.snapshot_account) && canonical(found.snapshot) === canonical(row.snapshot) && found.snapshot_digest === row.sourceDigest && found.snapshot_updated_at === row.sourceUpdatedAt && Number(found.source_status) === Number(row.sourceStatus) : found.snapshot_account === null;
      if (!snapshotMatches) difference("accounts", row.sourceId, "HISTORICAL_SNAPSHOT_DRIFT_OR_UNPROVED_PUBLIC_FACT");
      if (systemAudits) {
        const input={sourceSystem:"legacy_mysql_restore",sourceEntity:"la_rental_accounts",legacyId:row.sourceId,sourceDigest:row.sourceDigest,
          evidenceRef:row.evidenceRef,owner:{legacyId:row.ownerLegacyId,sourceDigest:row.ownerSourceDigest},gameId:state.gameBindings[row.gameCode]};
        const observation={sourceSystem:input.sourceSystem,sourceEntity:input.sourceEntity,legacyId:input.legacyId,sourceDigest:input.sourceDigest,evidenceRef:input.evidenceRef,inventory:[]};
        const base={objectId:found.account_id,actorId:state.binding.systemAccountId,manifestSha256:state.binding.datasetSha256,
          sourceSystem:input.sourceSystem,sourceEntity:input.sourceEntity,legacyId:input.legacyId,sourceDigest:input.sourceDigest};
        const events=systemAudits.get(found.account_id)??[];
        let attributionOk=matchesSystemMigrationAudit(events,{...base,action:"supply.legacy.account_created",payloadDigest:hash(JSON.stringify(input))})
          && matchesSystemMigrationAudit(events,{...base,action:"supply.publication.legacy_observed",payloadDigest:hash(JSON.stringify(mod("supply/legacy-observation").normalizeLegacyObservationInput(observation)))});
        if(!attributionOk)
          difference("accounts",row.sourceId,"SYSTEM_SOURCE_AUDIT_DRIFT");
        if(snapshotExpected){
          const snapshotInput={observationVersionId:found.version_id,sourceSystem:input.sourceSystem,sourceEntity:input.sourceEntity,legacyId:input.legacyId,
            sourceDigest:input.sourceDigest,sourceStatus:Number(row.sourceStatus),sourceDeleted:row.sourceDeleted,sourceUpdatedAt:row.sourceUpdatedAt,evidenceRef:input.evidenceRef,snapshot:row.snapshot};
          if(found.snapshot_migration_id!==base.actorId||found.snapshot_manifest!==base.manifestSha256
            ||!matchesSystemMigrationAudit(events,{...base,action:"supply.legacy.read_snapshot_recorded",
              payloadDigest:mod("supply/legacy-listing-read").legacyReadSnapshotMigrationDigest(snapshotInput),observationVersionId:found.version_id})) {
            attributionOk=false;
            difference("accounts",row.sourceId,"SYSTEM_SNAPSHOT_AUDIT_DRIFT");
          }
        }
        if(attributionOk)systemAttribution.accounts.matched++;
      }
      if (listed) {
        if (!snapshotExpected || !snapshotMatches) { legacyListedTarget.missingSnapshot++; listedMissingSnapshotIds.push(row.sourceId); }
        if (found.has_publication !== false) { legacyListedTarget.published++; listedPublishedIds.push(row.sourceId); }
        if (captureMatches && sourceMatches && snapshotExpected && snapshotMatches && found.has_publication === false) {
          legacyListedTarget.verifiedMapped++; listedVerifiedIds.push(row.sourceId);
        }
      }
    }
  }, accountKeys);
  report.domains.accounts = { expected: accounts };
  if (registration.migrationProfile === NEXT_MIGRATION_PROFILE) report.legacyListedTarget = {
    ...legacyListedTarget,
    ...(listedSource ? { sourceProofSha256: hash(JSON.stringify(listedSource)),
      expectedMappedIdsSha256: legacyListedIdsDigest(listedExpectedIds), verifiedMappedIdsSha256: legacyListedIdsDigest(listedVerifiedIds),
      missingTargetIdsSha256: legacyListedIdsDigest(listedMissingIds), missingSnapshotIdsSha256: legacyListedIdsDigest(listedMissingSnapshotIds),
      publishedIdsSha256: legacyListedIdsDigest(listedPublishedIds) } : {}),
    scope: "MAPPED_DELTA_ACCOUNT_FACTS_ONLY", marketAndDirectOrder: "NOT_ASSESSED", sourceIsolations: "SEE_SOURCE_SCOPE_VERIFICATION",
  };
  if (report.legacyListedTarget) report.legacyListedTarget.status = listedSource
    ? legacyListedTargetMatches(listedSource, report.legacyListedTarget, listedBinding) ? "MAPPED_HISTORICAL_NOT_PUBLISHED" : "REVIEW_REQUIRED"
    : "SOURCE_SCOPE_NOT_ASSESSED";
  let deleted = 0;
  const accountMetricAudit = { expected: 0, matched: 0 };
  const orders = await batched("orders", async batch => {
    const actual = new Map((await query(`SELECT l.legacy_id,l.id,l.binding_digest,l.source_digest,l.source_snapshot,l.account_id,l.game_id,l.owner_user_id,l.renter_user_id,l.due_amount_cents::text due,l.recorded_paid_amount_cents::text paid,l.deposit_amount_cents::text deposit,to_char(l.source_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_paid_at,
      to_jsonb(l)->>'created_by_migration_id' migration_id,to_jsonb(l)->>'migration_manifest_sha256' migration_manifest
      FROM zzsh_order.legacy_order_read_snapshot l WHERE l.source_system='legacy_mysql_restore' AND l.source_entity='la_order' AND l.legacy_id=ANY($1::text[])`, [batch.map(row => row.sourceId)])).rows.map(row => [row.legacy_id, row]));
    const orderIds = [...actual.values()].map(row => row.id);
    const systemAudits=systemCore ? await readSystemMigrationAudits(query,"orders",orderIds) : null, audits = new Map();
    if (!systemAudits && batch.some(row => row.account.metricSourceFields !== undefined) && orderIds.length) for (const audit of (await query(`SELECT object_id,details FROM zzsh_iam.audit_event WHERE object_type='rental_order' AND action='order.legacy.read_imported' AND outcome='SUCCESS' AND object_id=ANY($1::text[])`, [orderIds])).rows) {
      if (!audits.has(audit.object_id)) audits.set(audit.object_id, []); audits.get(audit.object_id).push(audit.details);
    }
    for (const row of batch) {
      if(systemAudits)systemAttribution.orders.expected++;
      if (row.account.metricSourceFields !== undefined) accountMetricAudit.expected++;
      if (originalMetricSources && !matchesLegacyOrderCapture(originalMetricSources.orders.get(row.sourceId), row, canonical)) difference("orders", row.sourceId, "ORDER_CAPTURE_METRIC_SOURCE_DRIFT");
      if (originalMetricSources && !matchesLegacyAccountCapture(originalMetricSources.accounts.get(row.account.legacyId), {sourceId:row.account.legacyId,sourceDigest:row.account.sourceDigest,metricSourceFields:row.account.metricSourceFields}, canonical)) difference("orders", row.sourceId, "ORDER_ACCOUNT_CAPTURE_BINDING_DRIFT");
      const found = actual.get(row.sourceId), bound = { source: row.source, account: { ...row.account, accountId: accountId("legacy_mysql_restore", "la_rental_accounts", row.account.legacyId), gameId: state.gameBindings[row.gameCode] }, owner: row.owner, renter: row.renter }, expected = orderRead.normalizeLegacyOrderReadInput(bound);
      if (row.sourceDeleted) deleted++;
      if (!found) { difference("orders", row.sourceId, "TARGET_ORDER_SNAPSHOT_MISSING"); continue; }
      if (found.id !== expected.id || found.binding_digest !== expected.bindingDigest || found.source_digest !== row.sourceDigest || canonical(found.source_snapshot) !== canonical(row.source.row) || found.account_id !== bound.account.accountId || found.game_id !== bound.account.gameId || found.owner_user_id !== row.owner.userId || found.renter_user_id !== row.renter.userId || found.due !== expected.dueCents || found.paid !== expected.paidCents || found.deposit !== expected.depositCents || found.source_paid_at !== expected.paidAt) difference("orders", row.sourceId, "ORIGINAL_ORDER_RELATION_STATUS_OR_MONEY_DRIFT");
      if(systemAudits) {
        if(found.migration_id===state.binding.systemOrderId && found.migration_manifest===state.binding.datasetSha256
          && matchesSystemMigrationAudit(systemAudits.get(found.id)??[],{objectId:found.id,action:"order.legacy.read_imported",actorId:state.binding.systemOrderId,
            manifestSha256:state.binding.datasetSha256,sourceSystem:"legacy_mysql_restore",sourceEntity:"la_order",legacyId:row.sourceId,
            sourceDigest:row.sourceDigest,bindingDigest:expected.bindingDigest})) systemAttribution.orders.matched++;
        else difference("orders",row.sourceId,"SYSTEM_SOURCE_AUDIT_DRIFT");
      }
      if (bound.account.metricSourceFields !== undefined) {
        const matches = systemAudits ? (systemAudits.get(found.id)??[]).map(audit=>audit.details) : audits.get(found.id) ?? [], source = orderRead.legacyAccountMetricSource(bound);
        if (!matchesLegacyAccountMetricAudit(matches, source, expected.bindingDigest, canonical)) difference("orders", row.sourceId, "ACCOUNT_CAPTURE_METRIC_SOURCE_DRIFT");
        else accountMetricAudit.matched++;
      }
    }
  }, orderKeys);
  report.domains.orders = { expected: orders, preservedSourceDeleted: deleted };
  if(systemAttribution)report.systemMigrationAttribution={...systemAttribution,
    status:Object.values(systemAttribution).every(value=>value.expected===value.matched)?"VERIFIED":"MISMATCH"};
  if (originalMetricSources) report.legacyDashboardSources = { source: manifest.legacyDashboardSources, sourceReceiptAndFilesSha256Verified: true,
    accountRowsCompared: accounts, orderRowsCompared: orders, accountMetricAudit };
  // Per-row checks prove each planned row is right; this proves the planned key set and the target
  // key set are the same set, so a missing or extra object cannot hide behind matching totals.
  report.sets = {};
  const compareSet = async (domain, sourceKeys, targetSql) => {
    const result = compareKeySets(sourceKeys, (await query(targetSql)).rows);
    report.sets[domain] = result;
    if (!result.equal) difference(domain, "KEY_SET", "TARGET_KEY_SET_DIFFERS");
  };
  await compareSet("users", userKeys, `SELECT substring(provider_reference from char_length('la_user:') + 1) AS legacy_id FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore' AND provider_reference LIKE 'la_user:%'`);
  await compareSet("accounts", accountKeys, `SELECT legacy_id FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts'`);
  await compareSet("orders", orderKeys, `SELECT legacy_id FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order'`);
  if (option("--paths-plan")) {
    const checked = async (dir, name, expected) => {
      const path = join(dir, basename(name)), digest = createHash("sha256");
      if (name !== basename(name)) throw new Error("ADDITIVE_READBACK_PATH_INVALID");
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      if (digest.digest("hex") !== expected) throw new Error("ADDITIVE_READBACK_SHA_MISMATCH:" + name);
      return path;
    };
    async function compare(name, items, readRows, matches, expected) {
      let batch = [], count = 0, matched = 0;
      async function flush() {
        const actual = new Map((await readRows(batch)).map(row => [row.key, row]));
        for (const row of batch) {
          const key = row.sourceId ?? row.legacyId;
          if (matches(row, actual.get(key))) matched++;
          else difference(name, key, "ADDITIVE_EXACT_SOURCE_FACT_DRIFT");
          count++;
        }
        batch = [];
      }
      for await (const row of items) { batch.push(row); if (batch.length === 500) await flush(); }
      if (batch.length) await flush();
      if (count !== expected) difference(name, "COHORT", "ADDITIVE_EXPECTED_COUNT_DRIFT");
      report[name] = { expected, matched };
    }
    const display = state.additiveInputs.display, dm = JSON.parse(readFileSync(await checked(display.directory, "manifest.json", display.manifestSha256)));
    if(hasIdentityProfiles)assertDisplayCaptureCoverage(dm);
    const ratio = dm.accountBaseRatio ? { scope: dm.accountBaseRatio.scope, expected: dm.rows, matched: 0, known: 0, unknown: 0 } : null;
    const payout = dm.accountFullPayout ? { scope: dm.accountFullPayout.scope, expected: dm.rows, matched: 0, selected: 0, unselected: 0, unknown: 0 } : null;
    if (ratio && (ratio.scope !== "ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT" || !originalMetricSources || dm.accountBaseRatio.known + dm.accountBaseRatio.unknown !== dm.rows)) throw new Error("DISPLAY_ACCOUNT_RATIO_SOURCE_PROOF_REQUIRED");
    if (payout && (payout.scope !== "ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT" || !originalMetricSources || dm.accountFullPayout.selected + dm.accountFullPayout.unselected + dm.accountFullPayout.unknown !== dm.rows)) throw new Error("DISPLAY_ACCOUNT_PAYOUT_SOURCE_PROOF_REQUIRED");
    await compare("display", rows(await checked(display.directory, dm.file, dm.sha256)), async batch => (await query(`SELECT m.legacy_id key,m.version_id,d.observation_version_id,d.extract_sha256,d.base_source_digest,d.snapshot,to_char(d.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.legacy_listing_display_snapshot d USING(account_id) WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`, [batch.map(r => r.sourceId)])).rows, (r, a) => {
      if (!a || a.version_id !== a.observation_version_id || a.extract_sha256 !== dm.extractSha256 || a.base_source_digest !== r.baseSourceDigest || a.updated_at !== r.sourceUpdatedAt || canonical(a.snapshot) !== canonical(r.snapshot)) return false;
      if (ratio) {
        if (!matchesCapturedAccountBaseRatio(originalMetricSources.accounts.get(r.sourceId), a.snapshot, a.base_source_digest)) return false;
        ratio.matched++;ratio[a.snapshot.sourceAccountBaseRatioWanPerYuan === null ? "unknown" : "known"]++;
      }
      if (payout) {
        if (!matchesCapturedAccountFullPayout(originalMetricSources.accounts.get(r.sourceId), a.snapshot, a.base_source_digest)) return false;
        payout.matched++;payout[a.snapshot.sourceAccountFullPayoutSelected === null ? "unknown" : a.snapshot.sourceAccountFullPayoutSelected ? "selected" : "unselected"]++;
      }
      return true;
    }, dm.rows);
    if (ratio) {
      ratio.status = ratio.matched === dm.rows && ratio.known === dm.accountBaseRatio.known && ratio.unknown === dm.accountBaseRatio.unknown ? "VERIFIED" : "MISMATCH";
      if (ratio.status !== "VERIFIED") difference("display", "ACCOUNT_RATIO", "SOURCE_ACCOUNT_RATIO_READBACK_DRIFT");
      report.display.accountBaseRatio = ratio;
    }
    if (payout) {
      payout.status = payout.matched === dm.rows && ['selected','unselected','unknown'].every(key=>payout[key]===dm.accountFullPayout[key]) ? "VERIFIED" : "MISMATCH";
      if (payout.status !== "VERIFIED") difference("display", "ACCOUNT_FULL_PAYOUT", "SOURCE_ACCOUNT_PAYOUT_READBACK_DRIFT");
      report.display.accountFullPayout = payout;
    }
    const hm = state.generatedPhases.skinHoldings, hp = JSON.parse(readFileSync(await checked(join(dirname(checkpoint), "phases"), "skinHoldings.json", hm.sha256)));
    await compare("holdings", hp.rows, async batch => (await query("SELECT legacy_id key,account_id,observation_version_id,source_digest,holding_digest,skin_ids,evidence_ref FROM zzsh_supply.legacy_skin_holding WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts' AND legacy_id=ANY($1::text[])", [batch.map(r => r.sourceId)])).rows, (r, a) => a && a.account_id === r.sealedRow.accountId && a.observation_version_id === r.sealedRow.observationVersionId && a.source_digest === r.sealedRow.sourceDigest && a.holding_digest === r.expectedHoldingDigest && a.evidence_ref === r.evidenceRef && canonical([...a.skin_ids].sort()) === canonical([...r.expectedSkinIds].sort()), hm.rows);
    const holdingAudits = new Map((await query("SELECT object_id,details->'sourceAdmission' admission FROM zzsh_iam.audit_event WHERE action='supply.legacy.skin_holdings_recorded' AND outcome='SUCCESS'")).rows.map(r => [r.object_id, r.admission]));
    for (const row of hp.rows) {
      const audit = holdingAudits.get(row.sealedRow.accountId);
      if (!audit || audit.sourceUpdatedAtUtc !== row.sealedRow.sourceUpdatedAtUtc || audit.sourceExtractSha256 !== hp.sourceContext.sourceExtractSha256 || audit.mappingOverlay?.sha256 !== hp.sourceContext.mappingOverlay?.sha256) difference("holdings", row.sourceId, "HOLDING_SOURCE_TIME_OR_REVIEWED_OVERLAY_AUDIT_DRIFT");
    }
    const opening = state.additiveInputs.opening, om = JSON.parse(readFileSync(await checked(opening.directory, "manifest.json", opening.manifestSha256)));
    async function* candidates() { for await (const row of rows(await checked(opening.directory, om.file, om.sha256))) if (row.state === "CANDIDATE") yield row; }
    await compare("openings", candidates(), async batch => (await query("SELECT source_id key,user_id,source_digest,identity_source_digest,available_cents::text available_cents,covered_count,covered_set_digest,source_cutoff FROM zzsh_order.finance_opening_basis WHERE source_system='legacy_mysql_restore' AND source_id=ANY($1::text[])", [batch.map(r => r.sourceId)])).rows, (r, a) => {
      const p = r.input.proof;
      return a && a.user_id === p.userId && a.source_digest === p.sourceDigest && a.identity_source_digest === p.source.identityDigest && a.available_cents === p.availableCents && a.covered_count === p.coveredCount && a.covered_set_digest === p.coveredDigest && a.source_cutoff.toISOString() === r.input.cutoff;
    }, om.stats.candidate);
    const pathDir = option("--paths-plan"), pm = JSON.parse(readFileSync(await checked(pathDir, "receipt.json", option("--paths-plan-sha"))));
    if (pm.datasetSha256 !== state.binding.datasetSha256) throw new Error("ADDITIVE_PATH_DATASET_DRIFT");
    await compare("paths", rows(await checked(pathDir, pm.file, pm.fileSha256)), async batch => (await query("SELECT m.legacy_id key,m.version_id,p.observation_version_id,p.source_digest,p.display_paths,p.penalty_paths FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.legacy_account_media_paths p USING(account_id) WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])", [batch.map(r => r.legacyId)])).rows, (r, a) => a && a.version_id === a.observation_version_id && a.source_digest === r.sourceDigest && canonical(a.display_paths) === canonical(r.displayPaths) && canonical(a.penalty_paths) === canonical(r.penaltyPaths), pm.accounts);
    const totals = (await query("SELECT (SELECT count(*)::int FROM zzsh_supply.legacy_listing_display_snapshot) display,(SELECT count(*)::int FROM zzsh_supply.legacy_skin_holding WHERE source_system='legacy_mysql_restore') holdings,(SELECT count(*)::int FROM zzsh_order.finance_opening_basis WHERE source_system='legacy_mysql_restore') openings,(SELECT count(*)::int FROM zzsh_supply.legacy_account_media_paths) paths")).rows[0];
    for (const [name, count] of Object.entries(totals)) if (count !== report[name].expected) difference(name, "COHORT", "ADDITIVE_TARGET_COUNT_DRIFT");
  }
  if (state.phases.financeHistory?.complete && state.fundsSupplement) {
    const phase=state.generatedPhases.financeHistory,bytes=readFileSync(join(dirname(checkpoint),"phases","financeHistory.json"));
    if(hash(bytes)!==phase.sha256)throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
    const expected=JSON.parse(bytes).flatMap(group=>mod("finance/personal-finance-observation-maintenance").planFinanceObservations(group.input).observations.map(row=>({...row,domain:group.domain})));
    const counts={},attemptStatusCounts={};let readableAttempts=0;
    const unresolvedRefunds={expected:0,verified:0,issues:{}};
    for(let i=0;i<expected.length;i+=500){
      const batch=expected.slice(i,i+500),actual=new Map((await query(`SELECT o.source_entity,o.source_id,o.user_id,o.legacy_user_id,o.source_digest,o.source_canonical,o.snapshot,to_char(o.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') event_at FROM zzsh_order.personal_finance_observation o JOIN unnest($1::text[],$2::text[]) k(entity,id) ON o.source_entity=k.entity AND o.source_id=k.id WHERE o.source_system='legacy_mysql_restore'`,[batch.map(r=>r.sourceEntity),batch.map(r=>r.sourceId)])).rows.map(r=>[r.source_entity+":"+r.source_id,r]));
      for(const row of batch){const found=actual.get(row.sourceEntity+":"+row.sourceId);counts[row.domain]??={expected:0,readable:0};counts[row.domain].expected++;
        if(state.binding.migrationProfile===NEXT_MIGRATION_PROFILE && row.domain==='refunds' && row.snapshot?.associationState==='UNRESOLVED'){
          unresolvedRefunds.expected++;
          const issue=inspectUnresolvedRefundSource(found?.snapshot,canonical);
          if(issue){unresolvedRefunds.issues[issue]=(unresolvedRefunds.issues[issue]??0)+1;difference('financeHistory',row.sourceEntity+':'+row.sourceId,'UNRESOLVED_REFUND_'+issue);}
          else unresolvedRefunds.verified++;
        }
        if(!found||found.user_id!==row.userId||found.legacy_user_id!==row.legacyUserId||found.source_digest!==row.sourceDigest||found.source_canonical!==row.sourceCanonical||canonical(found.snapshot)!==canonical(row.snapshot)||found.event_at!==row.sourceEventAt)difference("financeHistory",row.sourceEntity+":"+row.sourceId,"FROZEN_SOURCE_OBSERVATION_DRIFT");else{counts[row.domain].readable++;if(row.domain==='refunds')for(const attempt of found.snapshot.sourceAttempts??[]){readableAttempts++;attemptStatusCounts[attempt.sourceStatus]=(attemptStatusCounts[attempt.sourceStatus]??0)+1;}}
      }
    }
    report.refundAttempts={readable:readableAttempts,actualStatusCounts:attemptStatusCounts,expected:state.fundsSupplement.refundAttemptCoverage?.selected??null,sourceStates:state.fundsSupplement.refundAttemptCoverage?.statusCounts??{},scope:"TYPED_LA_REFUND_LOG_CHILDREN_EXACTLY_COVERED_BY_PARENT_CANONICAL_DIGEST_NOT_NEW_CHANNEL_TRANSACTIONS"};
    if(state.binding.migrationProfile===NEXT_MIGRATION_PROFILE)report.unresolvedRefundSources={...unresolvedRefunds,scope:'RAW_SOURCE_PRESERVED_NOT_A_CONFIRMED_ORDER_LINK_OR_CHANNEL_REFUND'};
    const actualTotal = (await query("SELECT count(*)::int n FROM zzsh_order.personal_finance_observation WHERE source_system='legacy_mysql_restore'")).rows[0].n;
    if (actualTotal !== expected.length) difference("financeHistory", "COHORT", "OBSERVATION_DENOMINATOR_DIFFERED");
    report.financialHistory={scope:"source observations only; no wallet posting or channel arrival",counts,walletEffectsFromObservation:false,arrivalVerified:false};
  }
  if (state.phases.financeHistory?.complete && !state.fundsSupplement) {
    const preparation = mod("finance/legacy-finance-source-preparation");
    const observed = await batched("finance-observations", async batch => {
      const entities = { earnings: "la_log_earnings", withdraws: "la_withdraw_apply", distributionOrders: "la_distribution_order" };
      const actual = new Map((await query(`SELECT source_entity,source_id,user_id,legacy_user_id,source_digest,source_canonical,snapshot,to_char(source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') event_at
        FROM zzsh_order.personal_finance_observation WHERE source_system='legacy_mysql_restore' AND source_entity=ANY($1::text[]) AND source_id=ANY($2::text[])`, [[...new Set(batch.map(row => entities[row.domain]))], batch.map(row => row.sourceId)])).rows.map(row => [row.source_entity + ":" + row.source_id, row]));
      for (const row of batch) {
        const normalized = preparation.prepareFrozenFinanceObservation(row.kind, row.row, { userId: row.userId, legacyUserId: row.legacyUserId, identityDigest: row.identityDigest });
        const found = actual.get(entities[row.domain] + ":" + row.sourceId);
        if (!found || found.user_id !== row.userId || found.legacy_user_id !== row.legacyUserId || found.source_digest !== normalized.sourceDigest || found.source_canonical !== canonical(normalized.row) || canonical(found.snapshot) !== canonical(normalized.row) || found.event_at !== normalized.sourceEventAt) difference("financeHistory", row.sourceId, "FROZEN_SOURCE_OBSERVATION_DRIFT");
      }
    });
    const actual = (await query("SELECT count(*)::int n FROM zzsh_order.personal_finance_observation WHERE source_system='legacy_mysql_restore'")).rows[0].n;
    report.financialHistory = { table: "zzsh_order.personal_finance_observation", scope: "original source historical display observations, not current duties or ledger entries", expected: observed, actual, walletEffectsFromObservation: false, arrivalVerified: false };
    if (actual !== observed) difference("financeHistory", "COHORT", "OBSERVATION_DENOMINATOR_DIFFERED");
  }
  if(state.phases.financeEmptyCoverage?.complete){
    const phase=state.generatedPhases.financeEmptyCoverage, chunks=phase?.chunks;
    const compact=registration.migrationProfile===NEXT_MIGRATION_PROFILE;
    if(compact&&phase?.schema!=="zzsh.empty-coverage-chunks.v1")throw new Error("EMPTY_COVERAGE_RECEIPT_MODE_UNPROVEN");
    assertEmptyCoverageReceiptMode(phase,compact);
    if(phase?.schema!=="zzsh.empty-coverage-chunks.v1"){
      const bytes=readFileSync(join(dirname(checkpoint),"phases","financeEmptyCoverage.json"));if(hash(bytes)!==phase?.sha256)throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
      const expected=JSON.parse(bytes).flatMap(chunk=>chunk.rows.map(row=>mod("finance/personal-finance-observation-maintenance").planFinanceObservations(row.input).coverage));let readable=0;
      for(let i=0;i<expected.length;i+=500){
        const batch=expected.slice(i,i+500),actual=new Map((await query(`SELECT c.id,c.user_id,c.source_kind,c.source_count,c.imported_count,c.isolated_count,c.body_digest,c.source_canonical,(SELECT count(*)::text FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_system=c.source_system AND o.source_kind=c.source_kind AND (o.source_event_at IS NULL OR o.source_event_at<=c.source_cutoff)) AS actual_count FROM zzsh_order.personal_finance_observation_coverage c WHERE c.id=ANY($1::text[])`,[batch.map(r=>r.id)])).rows.map(r=>[r.id,r]));
        for(const row of batch){const found=actual.get(row.id);if(!found||found.user_id!==row.userId||found.source_kind!==row.sourceKind||found.source_count!==0||found.imported_count!==0||found.isolated_count!==0||found.actual_count!=='0'||found.body_digest!==row.bodyDigest||found.source_canonical!==row.canonical)difference("financeEmptyCoverage",row.id,"PROVED_EMPTY_COVERAGE_DRIFT");else readable++;}
      }
      report.emptyFinancialCoverage={expected:expected.length,readable,scope:"EXACT_SOURCE_ZERO_PER_SUBJECT_AND_KIND_NOT_A_ZERO_WALLET"};
    }else{
    if(!Array.isArray(chunks))throw new Error("EMPTY_COVERAGE_CHUNK_MANIFEST_REQUIRED");
    const fundsDir=resolve(option("--funds-source")??""),refundDir=resolve(option("--refund-attempts")??"");
    if(!fundsDir.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")||!refundDir.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")
      ||!/^[a-f0-9]{64}$/.test(option("--funds-source-sha")??"")||!/^[a-f0-9]{64}$/.test(option("--refund-attempts-sha")??""))throw new Error("EMPTY_COVERAGE_FROZEN_SOURCE_REQUIRED");
    const chunkDir=resolve(dirname(checkpoint),"phases","financeEmptyCoverage");let checkedChunks=0;
    const chunkFile=descriptor=>{
      if(!/^[a-f0-9]{64}$/.test(descriptor?.digest??""))throw new Error("EMPTY_COVERAGE_CHUNK_PATH_INVALID");
      const path=resolve(chunkDir,descriptor.digest+".json");
      if(resolve(descriptor.file??"").toLowerCase()!==path.toLowerCase()||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||lstatSync(chunkDir).isSymbolicLink())throw new Error("EMPTY_COVERAGE_CHUNK_PATH_INVALID");
      return path;
    };
    // Rebuild from the pinned original sources and compare the complete chunk bytes before using
    // any saved item as evidence. This is source-only; the active target transaction is read-only.
    const rebuilt=await prepareLocalFundsPlan({manifest,domainFile:name=>manifest.files?.[name]?join(dataset,manifest.files[name].file):null,mod,apiDist:api,
      fundsSource:{path:fundsDir,sha256:option("--funds-source-sha")},refundAttemptsSource:{path:refundDir,sha256:option("--refund-attempts-sha")},
      emitEmptyChunk:chunk=>{const descriptor=chunks[checkedChunks++];assertRebuiltEmptyCoverageChunk(descriptor,chunk,readFileSync(chunkFile(descriptor)));}});
    if(rebuilt.inputSha256!==state.fundsSupplement?.inputSha256)throw new Error("EMPTY_COVERAGE_SOURCE_BINDING_CHANGED");
    assertRebuiltEmptyCoverageManifest(phase,rebuilt.emptyCoverage,checkedChunks);
    let readable=0,expected=0,batch=[];const compactProofs=[];
    const systemFinance=compact&&phase.receiptMode==='SYSTEM_BATCH_V1';
    let financeActor;
    if(systemFinance){
      const target={systemIdentifier:registration.instance?.systemIdentifier,databaseOid:registration.oid,marker:registration.marker,
        nonce:registration.nonce,roleOid:registration.migrationRoleOid};
      const id=mod('legacy-load/system-user-migration').systemFinanceMigrationId(state.binding.datasetSha256,target);
      if(state.binding.systemFinanceId!==id)throw new Error('SYSTEM_FINANCE_SOURCE_BINDING_CHANGED');
      financeActor={kind:'SYSTEM_FINANCE_MIGRATION',id,sourceDatasetSha256:state.binding.datasetSha256,target,requestId:'core-legacy-dataset-'+state.binding.oid};
    }
    async function checkEmptyBatch(){
      const actual=new Map((await query(`SELECT c.id,c.user_id,c.source_kind,c.source_count,c.imported_count,c.isolated_count,c.body_digest,c.source_canonical,(SELECT count(*)::text FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_system=c.source_system AND o.source_kind=c.source_kind AND (o.source_event_at IS NULL OR o.source_event_at<=c.source_cutoff)) AS actual_count FROM zzsh_order.personal_finance_observation_coverage c WHERE c.id=ANY($1::text[])`,[batch.map(r=>r.id)])).rows.map(r=>[r.id,r]));
      for(const row of batch){const found=actual.get(row.id);if(!found||found.user_id!==row.userId||found.source_kind!==row.sourceKind||found.source_count!==0||found.imported_count!==0||found.isolated_count!==0||found.actual_count!=='0'||found.body_digest!==row.bodyDigest||found.source_canonical!==row.canonical)difference("financeEmptyCoverage",row.id,"PROVED_EMPTY_COVERAGE_DRIFT");else readable++;}batch=[];
    }
    for(const chunk of chunks){const chunkRows=JSON.parse(readFileSync(chunkFile(chunk)));
      if(compact){
        if(systemFinance){
          const proof=mod("finance/personal-finance-observation-maintenance").systemCompactEmptyFinanceBatchProof(chunkRows.map(row=>row.input),financeActor);
          if(proof.body.inputSha256!==state.fundsSupplement.inputSha256||proof.body.cutoff!==new Date(manifest.sourceCutoff).toISOString())
            throw new Error('SYSTEM_FINANCE_SOURCE_BINDING_CHANGED');
          compactProofs.push(proof);
        }
        else {
        if(typeof state.binding.actorId!=='string'||typeof state.binding.sessionId!=='string'||!registration.instance?.systemIdentifier)throw new Error('COMPACT_COVERAGE_ACTOR_OR_TARGET_MISSING');
        compactProofs.push(mod("finance/personal-finance-observation-maintenance").compactEmptyFinanceBatchProof(chunkRows.map(row=>row.input),{
          ref:'CORE_FULL_LEGACY_'+state.binding.oid,attempt:'dataset-'+state.binding.datasetSha256.slice(0,16),actor:{userId:state.binding.actorId,sessionId:state.binding.sessionId},
          resource:{migrationProfile:registration.migrationProfile,systemIdentifier:registration.instance.systemIdentifier,oid:Number(registration.oid),nonce:registration.nonce},
          inputSha256:state.fundsSupplement.inputSha256,cutoff:new Date(manifest.sourceCutoff).toISOString()},'core-legacy-dataset-'+state.binding.oid));
        }
      }
      for(const row of chunkRows){batch.push(mod("finance/personal-finance-observation-maintenance").planFinanceObservations(row.input).coverage);expected++;
        if(batch.length===500)await checkEmptyBatch();}
    }
    if(batch.length)await checkEmptyBatch();
    let batchProof;
    if(compact){
      const actor=systemFinance?financeActor:{userId:state.binding.actorId,sessionId:state.binding.sessionId},checked=await readCompactCoverageEvidence(query,compactProofs,actor);
      for(const item of checked.differences)difference('financeEmptyCoverage',item.batchId,item.reason);
      batchProof={mode:phase.receiptMode,expected:checked.expected,matched:checked.matched};
    }
    const total=(await query(`SELECT count(*)::int n FROM zzsh_order.personal_finance_observation_coverage WHERE source_system='legacy_mysql_restore' AND source_count=0 AND source_kind=ANY($1::text[])`,[Object.values(phase.kinds)])).rows[0].n;
    if(expected!==phase.rows||total!==expected)difference("financeEmptyCoverage","COHORT","EMPTY_COVERAGE_TARGET_COUNT_DRIFT");
    report.emptyFinancialCoverage={expected,readable,actual:total,sourceRebuilt:true,chunks:checkedChunks,...(batchProof?{batchProof}:{}),scope:"EXACT_SOURCE_ZERO_PER_SUBJECT_AND_KIND_NOT_A_ZERO_WALLET"};
    }
  }
  // The old listing deposit is retired: nothing to reconcile, and any row would be a leak.
  {
    // The retired listing-deposit table is expected to be absent; treat absence as zero.
  const guaranteePresent=(await query(`SELECT to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL AS present`)).rows[0]?.present===true;
  const actual=guaranteePresent?(await query(`SELECT count(*)::int AS count FROM zzsh_order.legacy_owner_guarantee_observation`)).rows[0]:{count:0};
    report.ownerGuaranteeHistory={expected:0,readable:0,actual:actual?.count??0,policyExcluded:true};
    if((actual?.count??0)!==0)difference("guaranteeHistory","TABLE","RETIRED_LISTING_DEPOSIT_PRESENT_IN_TARGET");
  }
  if(state.phases.invitationFacts?.complete){
    const module=mod("finance/legacy-invitation-facts"), closureRequired=requiresInvitationCountClosure(manifest);
    let expectedSubjects=0,matchedSubjects=0,expectedRelations=0,matchedRelations=0,childProofAudits=0;
    const closure={status:closureRequired?"VERIFYING":"NOT_APPLICABLE_PARTIAL_SOURCE",packets:0,auditsMatched:0,subjects:0,known:0,unknown:0,matched:0};
    if(closureRequired && (state.phases.invitationCounts?.complete!==true || state.phases.invitationCounts.quarantined!==0
      || state.phases.invitationCounts.nextIndex!==manifest.invitationFacts.selectedPackets)) difference("invitationCounts","PHASE","COUNT_CLOSURE_NOT_COMMITTED");
    const audits = new Map((await query("SELECT object_id,details FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND outcome='SUCCESS'")).rows.map(r => [r.object_id, r.details]));
    const countAudits=new Map();
    if(closureRequired)for(const row of (await query("SELECT object_id,details FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed' AND outcome='SUCCESS'")).rows){
      const values=countAudits.get(row.object_id)??[];values.push(row.details);countAudits.set(row.object_id,values);
    }
    const invitationFile=manifest.files["invitation-facts"], invitationPath=invitationFile?join(dataset,invitationFile.file):null;
    if(closureRequired && !invitationFile)throw new Error("INVITATION_FILE_BINDING_REQUIRED");
    const invitationHashes=closureRequired ? await preflightInvitationFile(invitationPath,invitationFile?.sha256,manifest,module) : null;
    if(invitationFile) await batched("invitation-facts",async packets=>{for(const packet of packets){
      const plan=module.prepareLegacyInvitationFacts(packet.input,packet.bodyDigest),ids=plan.subjects.map(p=>p.userId);
      const audit = audits.get(plan.bodyDigest);
      if (!audit || canonical(audit.facts) !== canonical(packet.input.subjects) || canonical(audit.source) !== canonical(packet.input.source) || audit.financialEffects !== false) difference("invitationFacts", plan.bodyDigest, "ORIGINAL_CHILD_DENOMINATOR_AUDIT_DRIFT");
      else childProofAudits++;
      const subjects=new Map((await query(`SELECT p.*,c.id AS code_id,c.display_code,c.match_code,c.source_type AS code_source_type,c.source_id AS code_source_id,c.source_digest AS code_digest FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_order.distribution_invite_code c ON c.user_id=p.user_id WHERE p.user_id=ANY($1::text[])`,[ids])).rows.map(r=>[r.user_id,r]));
      for(const expected of plan.subjects){expectedSubjects++;const found=subjects.get(expected.userId);if(!found||found.source_type!=='LEGACY_MYSQL'||found.source_ref!==expected.sourceRef||found.source_digest!==expected.sourceDigest||found.eligibility!==expected.eligibility||found.commission_frozen!==expected.commissionFrozen||found.policy_version_id!==null||found.code_id!==expected.codeId||found.display_code!==expected.fact.codeSource.code||found.match_code!==expected.fact.codeSource.code.toUpperCase()||found.code_source_type!=='LEGACY_MYSQL'||found.code_source_id!==expected.fact.legacyId||found.code_digest!==expected.codeDigest)difference("invitationFacts",expected.userId,"IMMUTABLE_INVITATION_FACT_CODE_OR_ELIGIBILITY_DRIFT");else matchedSubjects++;}
      const relations=new Map((await query(`SELECT * FROM zzsh_order.invitation_relation WHERE child_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL'`,[ids])).rows.map(r=>[r.id,r]));
      for(const expected of plan.relations){expectedRelations++;const found=relations.get(expected.id);if(!found||found.type!==expected.type||found.child_user_id!==expected.childUserId||found.parent_user_id!==expected.parentUserId||found.policy_version_id!==null||found.source_ref!==expected.sourceRef||found.source_digest!==expected.sourceDigest)difference("invitationFacts",expected.id,"ORIGINAL_PARENT_RELATION_DRIFT");else matchedRelations++;}
      if(closureRequired){
        closure.packets++;
        const childRows=(await query(`SELECT id,type,parent_user_id,source_digest FROM zzsh_order.invitation_relation
          WHERE parent_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL' ORDER BY id COLLATE "C"`,[ids])).rows;
        const children=new Map();for(const row of childRows){const key=row.parent_user_id+"|"+row.type,list=children.get(key)??[];list.push([row.id,row.source_digest]);children.set(key,list);}
        let known=0,unknown=0;
        for(const fact of packet.input.subjects){
          const checked=assessInvitationChildSet(fact,{INVITER:children.get(fact.userId+"|INVITER"),DISTRIBUTION_LEADER:children.get(fact.userId+"|DISTRIBUTION_LEADER")},module.invitationFactHash);
          closure.subjects++;if(checked.knowledge==="KNOWN")known++;else unknown++;
          if(!checked.matches || subjects.get(fact.userId)?.invitees_knowledge!==checked.knowledge) difference("invitationCounts",fact.userId,"ORIGINAL_CHILD_SET_OR_KNOWLEDGE_DRIFT");
          else closure.matched++;
        }
        closure.known+=known;closure.unknown+=unknown;
        const expected={bodyDigest:plan.bodyDigest,sourceDigest:module.invitationFactHash(packet.input.source),subjects:ids.length,known,unknown,financialEffects:false};
        const evidence=countAudits.get(plan.bodyDigest)??[];
        if(evidence.length!==1||canonical(evidence[0])!==canonical(expected))difference("invitationCounts",plan.bodyDigest,"COUNT_CLOSURE_AUDIT_DRIFT");
        else closure.auditsMatched++;
      }
    }},null,1,invitationHashes ? readBoundInvitationPackets(invitationPath,invitationFile.sha256,invitationHashes) : null);
    if(closureRequired){
      if(closure.packets!==manifest.invitationFacts.selectedPackets||closure.subjects!==manifest.domains.users.source)difference("invitationCounts","POPULATION","COUNT_CLOSURE_DENOMINATOR_DRIFT");
      closure.status=closure.packets===closure.auditsMatched&&closure.subjects===closure.matched&&closure.subjects===manifest.domains.users.source?"VERIFIED":"MISMATCH";
    }
    report.invitationFacts={expectedSubjects,matchedSubjects,expectedRelations,matchedRelations,childProofAudits,policy:null,childCountClosure:closure};
  }
  const phaseDirectory = dirname(checkpoint);
  const reviewedEffects = [];
  for (const phaseName of ["liabilityDuties", "completedCommissions"]) {
    const binding = state.generatedPhases?.[phaseName];
    if (!binding) continue;
    const phaseBytes = readFileSync(join(phaseDirectory, "phases", phaseName + ".json"));
    if (hash(phaseBytes) !== binding.sha256) throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
    reviewedEffects.push(...JSON.parse(phaseBytes).filter(row => row.effect).map(row => ({...row.effect,...(row.body?.commission?{level:row.body.commission.level,ratio:row.body.commission.ratio,sourceRecordId:row.body.commission.id}:{})})));
  }
  if(state.fundsSupplement&&state.generatedPhases?.continuationEvidence){
    const phase = state.generatedPhases.continuationEvidence, bytes = readFileSync(join(phaseDirectory, "phases/continuationEvidence.json"));
    if (hash(bytes) !== phase.sha256) throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
    const expected = JSON.parse(bytes), model = mod("order/legacy-continuation-model");
    reviewedEffects.push(...continuationCommissionEffects(expected, mod));
    const actual = new Map((await query(`SELECT order_id,source_digest,parameter_digest,evidence_ref,admission,facts,facts_digest,facts_canonical,to_char(source_as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') source_as_of FROM zzsh_order.legacy_continuation_evidence WHERE source_kind='SOURCE_IMPORT'`)).rows.map(row => [row.order_id, row]));
    let matched = 0;
    for (const row of expected) {
      const a = actual.get(row.body.orderId), b = row.body, facts = model.initialLegacyFacts(b.source, b.commissionEvidence), sealed = model.sealLegacyFacts(facts);
      if (!a || a.source_digest !== b.sourceDigest || a.source_as_of !== b.sourceAsOf || a.evidence_ref !== b.evidenceRef || a.parameter_digest !== facts.evidence.parameterDigest || a.admission !== facts.evidence.admission || a.facts_digest !== sealed.digest || a.facts_canonical !== sealed.canonical || canonical(a.facts) !== sealed.canonical) difference("continuationEvidence", row.sourceId, "CONTINUATION_SOURCE_FACT_DRIFT");
      else matched++;
    }
    if (actual.size !== expected.length) difference("continuationEvidence", "COHORT", "CONTINUATION_TARGET_COUNT_DRIFT");
    report.continuationEvidence = { expected: expected.length, matched, total: actual.size };
  }
  if (reviewedEffects.length) {
    const actual = new Map((await query("SELECT id,kind,amount_cents::text amount,status,counterparty_user_id beneficiary,settled_by,source_record_id,level::text AS level,ratio::text,source_digest FROM zzsh_order.legacy_order_duty WHERE id=ANY($1::text[])", [reviewedEffects.map(row => row.dutyId)])).rows.map(row => [row.id, row]));
    let total = 0n;
    for (const expected of reviewedEffects) {
      total += BigInt(expected.amountCents);
      const found = actual.get(expected.dutyId);
      if (!found || found.kind !== expected.kind || found.amount !== expected.amountCents || found.status !== expected.status || found.beneficiary !== expected.beneficiaryUserId || found.settled_by !== expected.settledBy||expected.sourceRecordId!==undefined&&found.source_record_id!==expected.sourceRecordId||expected.level!==undefined&&(found.level!==expected.level||!mod("order/legacy-continuation-model").legacyDecimalEquals(found.ratio,expected.ratio))||expected.sourceDigest!==undefined&&found.source_digest!==expected.sourceDigest) difference("duties", expected.dutyId, "REVIEWED_ECONOMIC_RESPONSIBILITY_DRIFT");
    }
    report.reviewedDuties = { table: "zzsh_order.legacy_order_duty", scope: "Exact source completed/inflight commissions, renter refund duties and legacy terminal records; counts derived from this frozen input", expected: reviewedEffects.length, actual: actual.size, expectedAmountCents: total.toString(), amountsAreResponsibilitiesNotChannelPayments: true };
  }
  if (state.generatedPhases?.continuationEvidence) {
    const bytes = readFileSync(join(phaseDirectory, "phases/continuationEvidence.json"));
    if (hash(bytes) !== state.generatedPhases.continuationEvidence.sha256) throw new Error("CONTINUATION_PHASE_INPUT_CHANGED");
    const model = mod("order/legacy-continuation-model"), ownerId = mod("supply/legacy-user-migration").legacyOwnerUserId;
    const expected = JSON.parse(bytes).flatMap(row => ["3", "8", "9"].includes(String(row.body.source.orderStatus)) ? row.body.source.commissions.filter(c => c.status === "1").map(c => ({ id: model.legacyEconomicDutyId(row.body.orderId, "COMMISSION", c.id), sourceId: c.id, amount: model.legacyPlanYuanToCents(c.storedEarnings), beneficiary: ownerId("legacy_mysql_restore", "la_user", c.beneficiaryId), level: c.level, ratio: c.ratio, sourceDigest: row.body.sourceDigest })) : []);
    const actual = new Map((await query("SELECT id,kind,source_record_id source_id,amount_cents::text amount,status,source,counterparty_user_id beneficiary,level,ratio::text ratio,maturity_at,admission_id,source_digest FROM zzsh_order.legacy_order_duty WHERE id=ANY($1::text[])", [expected.map(row => row.id)])).rows.map(row => [row.id, row]));
    for (const wanted of expected) {
      const found = actual.get(wanted.id);
      if (!found || found.kind !== "COMMISSION" || found.source_id !== wanted.sourceId || found.amount !== wanted.amount || found.status !== "PENDING" || found.source !== "LEGACY_IMPORT" || found.beneficiary !== wanted.beneficiary || String(found.level) !== wanted.level || !model.legacyDecimalEquals(found.ratio, wanted.ratio) || found.maturity_at !== null || found.admission_id !== null || found.source_digest !== wanted.sourceDigest) difference("inflightCommissions", wanted.id, "PROVISIONAL_ORIGINAL_COMMISSION_DRIFT");
    }
    report.inflightCommissions = { table: "zzsh_order.legacy_order_duty", source: "formal continuation import; separate from completed-parent batch", expected: expected.length, actual: actual.size, stillPendingFinalConfirmation: true, originalAmountCents: expected.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString() };
  }
  report.legacyDutyState = (await query("SELECT kind,status,settled_by,count(*)::int rows,sum(amount_cents)::text amount_cents FROM zzsh_order.legacy_order_duty GROUP BY kind,status,settled_by ORDER BY kind,status,settled_by")).rows;
  report.legacyDutyStateMeaning = { table: "zzsh_order.legacy_order_duty", commissionTotalIncludes: "completed-parent admitted duties and in-flight provisional duties; not an observe-only total", postingVerified: false, arrivalVerified: false, neverAddHistoricalObservationsAgain: true };
  report.actualCounts = (await query(`SELECT (SELECT count(*)::int FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore') users,(SELECT count(*)::int FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts') accounts,(SELECT count(*)::int FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order') orders,(SELECT count(*)::int FROM zzsh_order.rental_order) native_orders,(SELECT count(*)::int FROM zzsh_order.payment_confirmation) native_payment_confirmations`)).rows[0];
  for (const [domain, fact] of Object.entries(report.domains)) if (report.actualCounts[domain] !== fact.expected) difference(domain, "COHORT", "TARGET_DENOMINATOR_DIFFERED");
  report.sourceDomains = manifest.domains; report.sourceQuarantine = manifest.quarantine;
  report.status = report.differenceCount === 0 ? "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED" : "CORE_SOURCE_TARGET_DIFFERENCES";
  if (fenceEpoch) await assertMigrationFenceHeld({ query }, registration, fenceEpoch);
  if ((await query("ROLLBACK")).command !== "ROLLBACK") throw new Error("READBACK_ROLLBACK_ACK_UNCONFIRMED");
  report.rollbackConfirmed = true;
}
catch (error) { report.status = "READBACK_FAILED"; report.error = typeof error.code === "string" ? error.code : /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message ?? "") ? error.message : "READBACK_OPERATION_FAILED"; process.exitCode = 1; }
finally {
  if (sourceUsers) {
    try { await sourceUsers.return(); identitySource.closed = true; }
    catch { report.status = "READBACK_FAILED"; report.error = "IDENTITY_SOURCE_CLOSE_FAILED"; process.exitCode = 1; }
  }
  if (connected && !report.rollbackConfirmed) { try { report.rollbackConfirmed = (await query("ROLLBACK")).command === "ROLLBACK"; } catch {} }
  let targetClosed = false, maintenanceClosed = false;
  try { await db.end(); targetClosed = true; } catch { /* cleanup remains unconfirmed */ }
  if (held) { try { report.lockReleased = (await maintenance.query(advisoryLockSql(registration, "unlock"))).rows[0].ok; } catch {} }
  try { await maintenance.end(); maintenanceClosed = true; } catch { /* cleanup remains unconfirmed */ }
  report.connectionsClosed = targetClosed && maintenanceClosed; report.finishedAt = new Date().toISOString(); report.monotonicElapsedMs = performance.now() - started;
  if (!report.rollbackConfirmed || !report.lockReleased || !report.connectionsClosed || report.differenceCount) {
    if (report.status === "CORE_SOURCE_TARGET_EXACT_READBACK_PASSED") report.status = "READBACK_CLEANUP_UNCONFIRMED";
    process.exitCode = 1;
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, differences: report.differenceCount, queries: report.queries, rollback: report.rollbackConfirmed, unlock: report.lockReleased, closed: report.connectionsClosed }));
}
