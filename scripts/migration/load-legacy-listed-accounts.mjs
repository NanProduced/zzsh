import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeLoadCheckpoint } from "./local-load-checkpoint.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const mode = ["--prepare", "--trial", "--execute", "--recover"].filter(flag => args.includes(flag));
if (mode.length === 0) {
  console.log(JSON.stringify({ action: "PLAN", target: "zzsh_test_regression",
    prepare: ["--prepare", "--input", "--input-sha", "--out", "--actor-file", "--credentials", "--oid", "--nonce", "--api-dist"],
    execute: ["--execute", "--input", "--input-sha", "--out", "--actor-file", "--credentials", "--oid", "--nonce", "--api-dist", "--maintenance-password-file"],
    trial: "Same prepared input and lock as execute. Runs each candidate in its own transaction and confirms rollback.",
    recover: "Same prepared input and original execution --out; reads original receipt only.", connections: 0, credentialReads: 0 }));
  process.exit(0);
}
if (mode.length !== 1 || process.version !== "v24.20.0") throw new Error("EXPLICIT_MODE_AND_NODE_BASELINE_REQUIRED");
const [action] = mode;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const privateRoot = resolve("E:/zzsh-local-state/restricted");
function privatePath(value) {
  if (!value || !isAbsolute(value) || !resolve(value).toLowerCase().startsWith(privateRoot.toLowerCase() + "\\")) throw new Error("PRIVATE_PATH_REQUIRED");
  for (let current = resolve(value); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED");
    if (dirname(current) === current) break;
  }
  return resolve(value);
}
function newPrivateDirectory(path) {
  const who = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const sid = /S-1-5-[0-9-]+/.exec(who.stdout)?.[0];
  if (who.status !== 0 || !sid) throw new Error("CURRENT_SID_REQUIRED");
  mkdirSync(path);
  if (spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, timeout: 5000 }).status !== 0)
    throw new Error("OUTPUT_ACL_FAILED");
}
const inputFile = option("--input"), inputBytes = readFileSync(action === "--prepare" ? resolve(inputFile ?? "") : privatePath(inputFile));
const inputSha = sha(inputBytes), input = JSON.parse(inputBytes);
const out = privatePath(option("--out")), actor = JSON.parse(readFileSync(privatePath(option("--actor-file"))));
const oid = option("--oid"), nonce = option("--nonce"), credentialsFile = option("--credentials"), apiDist = option("--api-dist");
if (inputSha !== option("--input-sha") || !/^\d+$/.test(oid ?? "") || !/^[a-z0-9]{12,40}$/.test(nonce ?? "")
  || !isAbsolute(credentialsFile ?? "") || !isAbsolute(apiDist ?? "") || typeof actor.id !== "string" || !actor.id
  || typeof actor.sessionId !== "string" || !actor.sessionId) throw new Error("EXACT_TARGET_AND_INPUT_REQUIRED");
const resource = JSON.parse(readFileSync(join(dirname(credentialsFile), "resource.json")));
const credentials = JSON.parse(readFileSync(credentialsFile));
const roleKind = action === "--execute" || action === "--trial" ? "migration" : "runtime";
const role = credentials[roleKind];
if (resource.database !== "zzsh_test_regression" || credentials.database !== resource.database || resource.oid !== oid || resource.nonce !== nonce || resource.pendingReset
  || role?.name !== resource.roles?.[roleKind]?.name || role?.oid !== resource.roles?.[roleKind]?.oid) throw new Error("TARGET_BINDING_INVALID");
const moduleNames = ["auth/auth-security", "auth/security-core", "order/order", "supply/content-hash", "supply/funding-authority",
  "supply/legacy-display-snapshot", "supply/legacy-listing-read", "supply/legacy-published-reference", "supply/legacy-trade-takeover", "supply/publishing", "supply/supply-util"];
const moduleFile = name => join(apiDist, name + ".js");
const compiled = Object.fromEntries(moduleNames.map(name => [name, sha(readFileSync(moduleFile(name)))]));
const mod = name => require(moduleFile(name));
const { canonicalize } = mod("supply/content-hash");
const { readLegacyPublishedReference } = mod("supply/legacy-published-reference");
const { prepareLegacyTradeIntake, takeoverLegacyTrade } = mod("supply/legacy-trade-takeover");
const { readPublishingAccount, readDeclaration, readCurrentVersion } = mod("supply/publishing");
const { readLegacyDeclaredSkins } = mod("supply/legacy-listing-read");
const { legacyDisplayDigest } = mod("supply/legacy-display-snapshot");
const { createProductionSupplyGateReader } = mod("supply/funding-authority");
const { composeSupplyGateWithOrderOccupancy } = mod("order/order");
const { assertAdminContextInTransaction } = mod("auth/auth-security");
const { setAuditContext } = mod("auth/security-core");
const { fingerprintRequest } = mod("supply/supply-util");
const operation = "supply.legacy.trade_takeover";
const { Client } = require("pg");
const target = { database: resource.database, oid, nonce, actorId: actor.id };
const client = new Client({ host: "127.0.0.1", port: 55432, database: target.database, user: role.name, password: role.password,
  application_name: "legacy-listed-accounts-" + action.slice(2), connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 1000 });
const creditGuaranteeEnabled = action === "--prepare" ? args.includes("--credit-guarantee") : input.creditGuaranteeEnabled === true;
const gate = composeSupplyGateWithOrderOccupancy(createProductionSupplyGateReader({ creditGuaranteeEnabled }));
const phase = join(out, "checkpoint.json");
let transaction = false, commitSent = false, maintenance;
const actionBody = (row, intake) => ({ batchId: "capture03-listed-continuity-v1", intake, reviewedDeclaration: {
  title: row.titleBasis, reason: "原在架账号继续经营，按已核游戏与资源数量生成标题",
} });
function binding(body) {
  const { intake } = body, accountId = intake.accountId;
  return { scope: JSON.stringify(["admin", actor.id, operation, accountId]),
    key: sha(JSON.stringify([accountId, intake.source.expectedObservationVersionId, sha(canonicalize(intake))])),
    fingerprint: fingerprintRequest(operation, accountId, body) };
}
async function prepareRow(row) {
  const record = (await client.query(`SELECT m.account_id,m.version_id,m.source_digest,d.snapshot,d.extract_sha256,d.evidence_ref,d.source_updated_at,d.display_digest
    FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id
      AND h.observation_version_id=m.version_id AND h.source_system=m.source_system AND h.source_entity=m.source_entity
      AND h.legacy_id=m.legacy_id AND h.source_digest=m.source_digest AND h.source_status=3
    JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=m.account_id AND d.observation_version_id=m.version_id
      AND d.base_source_digest=m.source_digest AND d.schema_version=1
    WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=$1`, [row.sourceId])).rows;
  if (record.length !== 1 || record[0].source_digest !== row.sourceDigest) return { sourceId: row.sourceId, blocked: "SOURCE_TARGET_BINDING_REQUIRED" };
  const r = record[0], account = await readPublishingAccount(client, r.account_id);
  const version = await readCurrentVersion(client, account);
  if (!version || version.id !== r.version_id || version.origin !== "LEGACY_OBSERVATION"
    || account.lifecycle !== "ACTIVE" || account.owner_paused || account.staff_restricted) return { sourceId: row.sourceId, blocked: "CURRENT_ACCOUNT_NOT_ELIGIBLE" };
  const owner = (await client.query(`SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
    WHERE u.id=$1 AND NOT u.suspended AND s.account_status='ACTIVE' AND s.identity_status='VERIFIED' AND s.age_status='ADULT'`,
  [account.owner_user_id])).rowCount === 1;
  if (!owner) return { sourceId: row.sourceId, blocked: "CURRENT_OWNER_IDENTITY_NOT_ELIGIBLE" };
  if (!(r.source_updated_at instanceof Date) || legacyDisplayDigest(account.id, { observationVersionId: version.id, baseSourceDigest: row.sourceDigest,
    extractSha256: r.extract_sha256, sourceUpdatedAt: r.source_updated_at.toISOString(), evidenceRef: r.evidence_ref, snapshot: r.snapshot }) !== r.display_digest)
    return { sourceId: row.sourceId, blocked: "DISPLAY_SOURCE_BINDING_MISMATCH" };
  const reference = await readLegacyPublishedReference(client, account.id);
  if (!reference || reference.sourceDigest !== row.sourceDigest || reference.observationVersionId !== version.id)
    return { sourceId: row.sourceId, blocked: "LEGACY_PUBLISHED_REFERENCE_REQUIRED" };
  const currentGate = await gate(client, account, "READ");
  if (currentGate.occupancy !== "FREE" || !["SATISFIED", "NOT_REQUIRED"].includes(currentGate.publisherBail) || currentGate.rentalCompleted)
    return { sourceId: row.sourceId, blocked: "CURRENT_OCCUPANCY_OR_FUNDING_GATE" };
  const terms = (await client.query(`SELECT t.code,r.id release_id FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id
      JOIN zzsh_supply.term_option t ON t.version_id=r.term_version_id WHERE g.id=$1 AND g.enabled AND t.daily_consumption=$2::numeric`,
  [account.game_id, row.termDailyHaff])).rows;
  if (terms.length !== 1) return { sourceId: row.sourceId, blocked: "CURRENT_TERM_NOT_UNIQUE" };
  const declaration = await readDeclaration(client, version);
  const skins = await readLegacyDeclaredSkins(client, version.id, account.game_id);
  if (skins.some(skin => !skin.isPublic)) return { sourceId: row.sourceId, blocked: "CURRENT_SKIN_CATALOG_REVIEW_REQUIRED" };
  const source = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.sourceId,
    sourceDigest: row.sourceDigest, expectedObservationVersionId: version.id, expectedOwnerUserId: account.owner_user_id, expectedGameId: account.game_id };
  const canonical = canonicalize({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: row.sourceId,
    baseSourceDigest: row.sourceDigest, deposit_amount: row.depositYuan, is_full_payout: row.fullPayout, ownerRatioB: row.ownerRatioB,
    sourceStatus: "3", sourceDeleted: "0", processing_time_start: row.window.rawStart, processing_time_end: row.window.rawEnd });
  if (sha(canonical) !== row.sourceFieldEvidenceDigest) throw new Error("SOURCE_FIELD_DIGEST_CHANGED");
  const intake = { accountId: account.id, source, display: r.snapshot, title: declaration.title, description: declaration.description,
    depositYuan: row.depositYuan, isFullPayout: row.fullPayout, ownerRatioB: row.ownerRatioB, termOptionCode: terms[0].code,
    pricingOptionCode: "", skins: skins.map(skin => skin.id), entitlements: declaration.entitlements, media: [],
    sourceFieldEvidence: { canonical, digest: sha(canonical), extractSha256: r.extract_sha256, evidenceRef: r.evidence_ref } };
  const catalog = (await client.query(`SELECT id,code,unit,quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled ORDER BY id`, [account.game_id])).rows;
  const draft = prepareLegacyTradeIntake({ ...intake, title: row.titleBasis }, catalog, reference.digest);
  if (draft.admission !== "TRADE_CANDIDATE") return { sourceId: row.sourceId, blocked: draft.reasons };
  const body = actionBody(row, intake);
  return { sourceId: row.sourceId, releaseId: terms[0].release_id, referenceDigest: reference.digest, body, ...binding(body) };
}

async function runPublication(row) {
  const requestId = `listed_takeover_${row.sourceId}`;
  await setAuditContext(client, "admin", actor.id, actor.sessionId, requestId);
  const release = (await client.query("SELECT current_release_id FROM zzsh_supply.game WHERE id=$1", [row.body.intake.source.expectedGameId])).rows[0];
  if (release?.current_release_id !== row.releaseId || !await readLegacyPublishedReference(client, row.body.intake.accountId, row.referenceDigest))
    throw new Error("REVIEWED_RELEASE_OR_REFERENCE_CHANGED");
  const result = await takeoverLegacyTrade(client, { id: actor.id, sessionId: actor.sessionId, requestId }, row.body, gate);
  if (result.status !== 200 || result.body?.state !== "PUBLISHED") throw new Error("FORMAL_PUBLICATION_NOT_READY");
  return result;
}

try {
  if (action === "--execute" || action === "--trial") {
    const passwordFile = option("--maintenance-password-file");
    if (!isAbsolute(passwordFile ?? "")) throw new Error("MAINTENANCE_LOCK_CREDENTIAL_REQUIRED");
    maintenance = new Client({ host: "127.0.0.1", port: 55432, database: "postgres", user: "zzsh",
      password: readFileSync(passwordFile, "utf8").trim(), connectionTimeoutMillis: 3000, statement_timeout: 5000,
      application_name: "legacy-listed-maintenance-lock" });
    await maintenance.connect();
    if (!(await maintenance.query("SELECT pg_try_advisory_lock(806006) locked")).rows[0]?.locked) throw new Error("RESOURCE_MAINTENANCE_BUSY");
  }
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
  const live = (await client.query(`SELECT d.oid::text oid,shobj_description(d.oid,'pg_database') marker,current_user role,
    r.oid::text role_oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,current_setting('zzsh.regression_run',true) nonce
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  if (live.oid !== oid || live.nonce !== nonce || live.marker !== "zzsh:regression-test:v1" || live.role !== role.name
    || live.role_oid !== role.oid || live.rolsuper || live.rolcreatedb || live.rolcreaterole || live.rolbypassrls) throw new Error("LIVE_TARGET_CHANGED");
  await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  if (action === "--prepare") {
    if (input.schema !== "zzsh.listed-source-continuity-plan.v1" || input.listings?.length !== 10
      || new Set(input.listings.map(row => row.sourceId)).size !== 10 || input.listings.filter(row => row.fullPayout === "0").length !== 8)
      throw new Error("TEN_LISTED_SOURCE_ROWS_REQUIRED");
    const rows = [];
    for (const row of input.listings) rows.push(row.fullPayout === "0" ? await prepareRow(row) : { sourceId: row.sourceId, blocked: "OWNER_ACCEPTED_SPECIAL_TERMS_REQUIRED" });
    await client.query("ROLLBACK"); transaction = false;
    newPrivateDirectory(out);
    const bytes = JSON.stringify({ schema: "zzsh.legacy-listed-execution-plan.v1", target, compiled, sourcePlanSha256: inputSha, creditGuaranteeEnabled, rows }, null, 2) + "\n";
    writeFileSync(join(out, "plan.json"), bytes, { flag: "wx" });
    console.log(JSON.stringify({ status: "PREPARED_TARGET_READ_ONLY", ready: rows.filter(row => row.body).length,
      blocked: rows.filter(row => row.blocked), planSha256: sha(bytes) }));
  } else {
    if (input.schema !== "zzsh.legacy-listed-execution-plan.v1" || canonicalize(input.target) !== canonicalize(target)
      || canonicalize(input.compiled) !== canonicalize(compiled)) throw new Error("EXECUTION_PLAN_BINDING_CHANGED");
    const rows = input.rows.filter(row => row.body);
    if (!rows.length || rows.length > 8 || new Set(rows.map(row => row.body.intake.accountId)).size !== rows.length
      || rows.some(row => row.body.intake.isFullPayout !== "0" || canonicalize(binding(row.body)) !== canonicalize({ scope: row.scope, key: row.key, fingerprint: row.fingerprint })))
      throw new Error("EXECUTION_PLAN_BODY_CHANGED");
    if (action === "--recover") {
      const checkpoint = JSON.parse(readFileSync(phase, "utf8"));
      if (checkpoint.inputSha !== inputSha || !checkpoint.pending) throw new Error("ORIGINAL_PENDING_RECEIPT_REQUIRED");
      const row = rows.find(candidate => candidate.key === checkpoint.pending.key && candidate.scope === checkpoint.pending.scope);
      if (!row || row.fingerprint !== checkpoint.pending.fingerprint) throw new Error("ORIGINAL_PENDING_BODY_CHANGED");
      const receipt = (await client.query(`SELECT request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`, [row.scope, row.key])).rows[0];
      if (receipt && receipt.request_fingerprint !== row.fingerprint) throw new Error("ORIGINAL_RECEIPT_FINGERPRINT_MISMATCH");
      const published = receipt?.response_body?.state === "PUBLISHED" && (await client.query(`SELECT 1 FROM zzsh_supply.listing_publication
        WHERE account_id=$1 AND version_id=$2 AND rule_release_id=$3 AND content_hash=$4 AND source='LEGACY_APPROVED'`,
      [row.body.intake.accountId, receipt.response_body.versionId, receipt.response_body.releaseId, receipt.response_body.contentHash])).rowCount === 1;
      console.log(JSON.stringify({ status: published ? "ORIGINAL_PUBLICATION_RECOVERED" : "UNKNOWN", sourceId: row.sourceId }));
    }
    await client.query("ROLLBACK"); transaction = false;
    if (action === "--trial") {
      newPrivateDirectory(out);
      const results = [];
      for (const row of rows) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); transaction = true;
        let result;
        try {
          const publication = await runPublication(row);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          result = { sourceId: row.sourceId, state: publication.replayed ? "ALREADY_PUBLISHED" : "READY" };
        } catch (error) {
          if (![400, 403, 409].includes(error.status)) throw error;
          result = { sourceId: row.sourceId, state: "REJECTED", status: error.status, code: error.code, reason: error.message };
        } finally {
          if ((await client.query("ROLLBACK")).command !== "ROLLBACK") throw new Error("TRIAL_ROLLBACK_UNCONFIRMED");
          transaction = false;
        }
        results.push(result);
        writeLoadCheckpoint(join(out, "trial.json"), { inputSha, target, results, rollbackAcknowledged: results.length });
      }
      console.log(JSON.stringify({ status: "TRIAL_ROLLED_BACK", ready: results.filter(row => row.state === "READY").length,
        replayed: results.filter(row => row.state === "ALREADY_PUBLISHED").length, rejected: results.filter(row => row.state === "REJECTED").length }));
    }
    if (action === "--execute") {
      newPrivateDirectory(out);
      const checkpoint = { inputSha, target, pending: null, completed: [] };
      for (const row of rows) {
        checkpoint.pending = { scope: row.scope, key: row.key, fingerprint: row.fingerprint, stage: "BEFORE_BEGIN" };
        writeLoadCheckpoint(phase, checkpoint);
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); transaction = true;
        const result = await runPublication(row);
        checkpoint.pending.stage = "COMMIT_INTENT";
        writeLoadCheckpoint(phase, checkpoint);
        commitSent = true;
        const ack = await client.query("COMMIT");
        transaction = false;
        if (ack.command !== "COMMIT") throw new Error("COMMIT_ACK_UNCONFIRMED");
        checkpoint.completed.push({ sourceId: row.sourceId, replayed: result.replayed, publication: result.body });
        checkpoint.pending = null;
        writeLoadCheckpoint(phase, checkpoint);
        commitSent = false;
      }
      console.log(JSON.stringify({ status: "COMMIT_ACK_REVIEW_REQUIRED", completed: checkpoint.completed.length, blocked: input.rows.length - rows.length }));
    }
  }
} finally {
  try { if (transaction && !commitSent) await client.query("ROLLBACK"); }
  finally { try { await client.end(); } finally { if (maintenance) await maintenance.end(); } }
}
