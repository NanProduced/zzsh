import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { advisoryLockSql, loadRegisteredTarget } from "./local-target-registry.mjs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate } from "../local-auth.mjs";
import { assertGrowthScopePartition, buildLocalGrowthPlan } from "./local-growth-plan.mjs";
import { readSourceRows } from "./local-source-adapter.mjs";

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const modes = ["--prepare", "--apply", "--readback", "--recover-index"].filter(x => args.includes(x));
if (!modes.length) {
  console.log(JSON.stringify({ status: "PLAN_ONLY", modes: ["--prepare", "--apply", "--readback", "--recover-index <1-based>"], required: ["--input", "--input-sha", "--out"], nonPrepare: ["--manifest", "--manifest-sha"], targetWrites: 0, connections: 0 }));
  process.exit(0);
}
assert.equal(modes.length, 1, "ONE_GROWTH_MODE_REQUIRED");
assert.equal(process.version, "v24.20.0");
const mode = modes[0], sha = value => createHash("sha256").update(value).digest("hex"), started = performance.now();
const restricted = resolve("E:/zzsh-local-state/restricted");
function privatePath(path, output = false) {
  assert(typeof path === "string" && isAbsolute(path), "PRIVATE_GROWTH_PATH_REQUIRED");
  path = resolve(path);
  assert(path.toLowerCase().startsWith(restricted.toLowerCase() + "\\"), "PRIVATE_GROWTH_PATH_REQUIRED");
  for (let p = output ? dirname(path) : path; p !== dirname(p); p = dirname(p)) assert(!lstatSync(p).isSymbolicLink(), "GROWTH_REPARSE_POINT_REFUSED");
  return path;
}
const read = path => JSON.parse(readFileSync(path));
function pinned(file, expected) {
  const bytes = readFileSync(file);
  assert.equal(sha(bytes), expected, "GROWTH_INPUT_SHA_MISMATCH:" + basename(file));
  return JSON.parse(bytes);
}
const inputSha256 = option("--input-sha"), input = pinned(privatePath(option("--input")), inputSha256);
assert.equal(input.schema, "zzsh.local-round.v1");
const growthInput = input.growth;
assert(growthInput && typeof growthInput.policyId === "string" && Number.isFinite(Date.parse(growthInput.policyEffectiveAt)), "EXACT_CURRENT_GROWTH_POLICY_REQUIRED");
const out = privatePath(option("--out"), true);
assert(!existsSync(out), "PRESERVE_ORIGINAL_GROWTH_OUTPUT");
const target = input.target;
assert(/^[1-9]\d*$/.test(target.oid) && /^[a-f0-9]{24}$/.test(target.nonce));
const source = privatePath(input.source.path), dataset = privatePath(input.dataset.path), refundDir = privatePath(input.refundAttempts.path);
const m = pinned(join(dataset, "manifest.json"), input.dataset.sha256), capture = pinned(join(source, "receipt.json"), input.source.sha256);
const refundsReceipt = pinned(join(refundDir, "receipt.json"), input.refundAttempts.sha256);
assert.equal(m.sourceReceiptSha256, input.source.sha256);
assert.equal(refundsReceipt.sourceSupplement.baseReceiptSha256, input.source.sha256);
for (const r of [capture, refundsReceipt]) assert(r.status === "CAPTURED_READ_ONLY" && r.rollbackConfirmed && r.clientClosed && r.database === capture.database && r.containerId === capture.containerId);
const cutoff = new Date(m.sourceCutoff).toISOString().replace(/\.(\d{3})Z$/, (_, ms) => "." + ms + "000Z");
const require = createRequire(import.meta.url), { Client, Pool } = require("pg"), api = resolve(input.apiDist);
for (const [name, digest] of Object.entries(input.buildFiles)) {
  assert(!name.includes("\\") && !name.split("/").includes("..") && !name.startsWith("/") && name.endsWith(".js"), "GROWTH_BUILD_PATH_INVALID");
  assert.equal(sha(readFileSync(join(api, name))), digest, "GROWTH_BUILD_CHANGED:" + name);
}
const mod = name => {
  assert(Object.hasOwn(input.buildFiles, name + ".js"), "GROWTH_BUILD_FILE_UNPINNED:" + name);
  return require(join(api, name + ".js"));
};
const credentialsFile = resolve(input.credentials), resource = loadRegisteredTarget(credentialsFile);
const database = resource.database, marker = resource.marker;
assert.equal(resource.oid, target.oid);
assert.equal(resource.nonce, target.nonce);
assert(!resource.pendingReset && resource.protectedDataset?.manifestSha256 === input.dataset.sha256 && resource.protectedDataset.epoch?.oid === target.oid && resource.protectedDataset.epoch?.nonce === target.nonce, "GROWTH_PROTECTED_SOURCE_TARGET_REQUIRED");
const credentials = read(credentialsFile);
assert.equal(credentials.database, database);
for (const role of ["migration", "runtime"]) {
  assert.equal(credentials[role].name, resource[role + "Role"]);
  const expectedOid = resource[role + "RoleOid"];
  if (expectedOid !== null) assert.equal(credentials[role].oid, expectedOid);
}
assert.equal(credentials.migration.oid, target.migrationRoleOid);
const summaryFile = join(out, "summary.json");
const result = { schema: "zzsh.local-growth-round-receipt.v1", status: "STARTED", mode, inputSha256, datasetSha256: input.dataset.sha256, oid: target.oid, nonce: target.nonce, startedAt: new Date().toISOString(), queries: 0, retries: 0, fundsWrites: 0 };
const save = () => writePrivate(summaryFile, result);
const base = { host: resource.host, port: resource.port, statement_timeout: 30000, connectionTimeoutMillis: 3000, lock_timeout: 1000, application_name: "zzsh-local-growth-round" };
const instrument = client => { const query = client.query.bind(client); client.query = (...a) => { result.queries++; return query(...a); }; return client; };
async function identity(client, role, roleOid) {
  const i = (await client.query(`SELECT current_database() database,d.oid::text,shobj_description(d.oid,'pg_database') marker,pg_get_userbyid(d.datdba) owner,current_setting('zzsh.regression_run') nonce,current_user role,r.oid::text role_oid,current_setting('transaction_read_only') read_only,pg_get_userbyid(c.relowner) coverage_owner,to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as_of FROM pg_database d JOIN pg_roles r ON r.rolname=current_user CROSS JOIN pg_class c WHERE d.datname=current_database() AND c.oid=to_regclass('zzsh_iam.membership_growth_legacy_coverage')`)).rows[0];
  assert(i && i.database === database && i.oid === target.oid && i.marker === marker && i.nonce === target.nonce && i.owner === "zzsh" && i.role === role && (roleOid === undefined || i.role_oid === roleOid) && i.read_only === "on", "LIVE_GROWTH_RESOURCE_CHANGED");
  return i;
}
async function activePolicy(client) {
  const p = (await client.query("SELECT id,effective_at FROM zzsh_iam.membership_growth_policy WHERE status='APPROVED' AND effective_at<=transaction_timestamp() ORDER BY effective_at DESC,version DESC LIMIT 1")).rows[0];
  assert(p && p.id === growthInput.policyId && p.effective_at.toISOString() === new Date(growthInput.policyEffectiveAt).toISOString(), "ACTIVE_GROWTH_POLICY_CHANGED");
  return { id: p.id, effectiveAt: p.effective_at.toISOString() };
}
async function readonly(task) {
  const role = credentials.runtime, db = instrument(new Client({ ...base, database, user: role.name, password: role.password }));
  let began = false;
  try {
    await db.connect(); await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); began = true;
    const i = await identity(db, role.name, role.oid);
    return await task(db, i, await activePolicy(db));
  } finally {
    try { if (began) result.readOnlyRollbackAck = (await db.query("ROLLBACK")).command === "ROLLBACK"; }
    finally { await db.end(); result.readOnlyClientClosed = true; }
  }
}
async function checkedRows(dir, entry) {
  assert.equal(entry.file, basename(entry.file));
  const file = join(dir, entry.file), digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  assert.equal(digest.digest("hex"), entry.sha256);
  const rows = []; for await (const row of readSourceRows(file)) rows.push(row);
  assert.equal(rows.length, entry.rows);
  return rows;
}
const orderSql = `SELECT id,legacy_id AS "legacyId",account_id AS "accountId",legacy_account_id AS "legacyAccountId",game_id AS "gameId",owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId",legacy_owner_id AS "legacyOwnerId",legacy_renter_id AS "legacyRenterId",owner_source_digest AS "ownerSourceDigest",renter_source_digest AS "renterSourceDigest",source_digest AS "sourceDigest",source_order_status AS "sourceOrderStatus",source_pay_status AS "sourcePayStatus",recorded_paid_amount_cents::text AS "paidCents",to_char(source_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "completedAt",source_snapshot AS "sourceSnapshot" FROM zzsh_order.legacy_order_read_snapshot ORDER BY legacy_id`;
const model = mod("auth/membership-growth"), legacy = mod("auth/membership-growth-legacy"), canonicalize = mod("supply/content-hash").canonicalize;
const pinManifest = () => {
  const path = privatePath(option("--manifest")), expected = option("--manifest-sha"), plan = pinned(path, expected);
  assert(plan.schema === "zzsh.local-growth-round-plan.v1" && plan.status === "PREPARED_NOT_APPLIED" && plan.datasetSha256 === input.dataset.sha256 && plan.oid === target.oid && plan.nonce === target.nonce && plan.policy.id === growthInput.policyId && plan.cutoff === cutoff && plan.buildDigest === sha(canonicalize(input.buildFiles)) && plan.packages.length === m.domains.users.ready && plan.summary.orders === m.domains.orders.ready, "GROWTH_PLAN_BINDING_CHANGED");
  result.manifestSha256 = expected;
  return { plan, directory: dirname(path) };
};
save();
try {
  if (mode === "--prepare") {
    const cohort = await checkedRows(dataset, m.files.users), allOrders = await checkedRows(source, capture.files.orders);
    // The seventh round migrates a business-selected subset of the source orders. Growth must close over
    // the orders the target is supposed to hold, and must still account for every order it leaves out.
    const scoped = assertGrowthScopePartition(allOrders, m.selectedScope);
    const orders = scoped.orders, growthExcluded = scoped.excluded;
    const [payments, refunds, refundLogs] = await Promise.all([checkedRows(source, capture.files.pays), checkedRows(source, capture.files.refunds), checkedRows(refundDir, refundsReceipt.files.refundLogs)]);
    const targetProof = await readonly(async (db, identity, policy) => {
      const users = (await db.query("SELECT user_id FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore' ORDER BY user_id")).rows.map(r => r.user_id);
      assert.deepEqual(users.sort(), cohort.map(r => r.userId).sort());
      const counts = (await db.query("SELECT (SELECT count(*)::int FROM zzsh_iam.membership_growth_contribution) contributions,(SELECT count(*)::int FROM zzsh_iam.membership_growth_legacy_coverage) coverage")).rows[0];
      assert.deepEqual(counts, { contributions: 0, coverage: 0 }, "GROWTH_TARGET_NOT_EMPTY");
      return { identity, policy, counts, orders: (await db.query(orderSql)).rows };
    });
    assert.equal(targetProof.orders.length, orders.length);
    writePrivate(join(out, "target-readonly.json"), targetProof);
    const ruleFiles = growthInput.oldRuleFiles;
    assert(ruleFiles && Object.keys(ruleFiles).length > 0, "REVIEWED_OLD_RULE_FILES_REQUIRED");
    for (const [file, expected] of Object.entries(ruleFiles)) assert.equal(sha(readFileSync(file)), expected, "OLD_GROWTH_RULE_CHANGED");
    const lineage = { captureReceiptSha256: input.source.sha256, scenarioManifestSha256: input.dataset.sha256, refundReceiptSha256: input.refundAttempts.sha256, targetFactsSha256: sha(canonicalize({ oid: target.oid, nonce: target.nonce, policy: targetProof.policy, orders: targetProof.orders })), orderFileSha256: capture.files.orders.sha256, paymentFileSha256: capture.files.pays.sha256, refundFileSha256: capture.files.refunds.sha256, refundLogFileSha256: refundsReceipt.files.refundLogs.sha256, cohortSha256: m.files.users.sha256, oldRuleFiles: ruleFiles, sourceCutoffMeaning: m.sourceOrigin.cutoffMeaning };
    const p = buildLocalGrowthPlan({ modules: { canonicalize, ...mod("order/legacy-growth-consumption"), ...legacy, ...model }, cohort, orders, growthExcluded, targets: targetProof.orders, payments, refunds, refundLogs, cutoff, lineage, oldRuleEvidenceRef: "local-growth-reviewed-source:" + sha(canonicalize(lineage)) });
    writePrivate(join(out, "source-review.json"), p.review);
    writePrivate(join(out, "unknown-sources.json"), p.unknownSources);
    mkdirSync(join(out, "packages"));
    const packages = p.packages.map((item, index) => {
      const file = "packages/" + String(index + 1).padStart(5, "0") + ".json";
      writeFileSync(join(out, file), item.bytes, { flag: "wx", mode: 0o600 });
      return { file, userId: item.userId, sha256: item.sha256, executionKey: item.executionKey, coverageState: item.prepared.coverageState, coverageFingerprint: item.prepared.fingerprint, contributionCount: item.prepared.rows.length, projection: item.projection };
    });
    const manifest = { schema: "zzsh.local-growth-round-plan.v1", status: "PREPARED_NOT_APPLIED", datasetSha256: input.dataset.sha256, oid: target.oid, nonce: target.nonce, policy: targetProof.policy, coverageOwner: targetProof.identity.coverage_owner, buildDigest: sha(canonicalize(input.buildFiles)), cutoff, lineage, targetReceiptSha256: sha(readFileSync(join(out, "target-readonly.json"))), reviewDigest: p.reviewDigest, packages, summary: p.summary };
    writePrivate(join(out, "manifest.json"), manifest);
    Object.assign(result, { status: "PREPARED_NOT_APPLIED", manifestSha256: sha(readFileSync(join(out, "manifest.json"))), summary: p.summary });
  } else if (mode === "--readback") {
    const { plan } = pinManifest();
    await readonly(async (db, i) => {
      const coverage = (await db.query('SELECT subject_user_id AS "userId",record_canonical canonical,record_digest digest FROM zzsh_iam.membership_growth_legacy_coverage ORDER BY subject_user_id')).rows;
      const rows = (await db.query(`SELECT user_id AS "userId",game_id AS "gameId",source_key AS "sourceKey",source_type AS "sourceType",source_id AS "sourceId",settlement_version AS "settlementVersion",revision,to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAt",to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",amount_cents::text AS "amountCents",previous_amount_cents::text AS "previousAmountCents",correction_of_source_key AS "correctionOf",correction_mode AS "correctionMode",state AS status,eligible,source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution ORDER BY user_id,source_key,revision`)).rows;
      assert.equal(coverage.length, plan.packages.length);
      assert.equal(rows.length, plan.summary.contributions);
      for (const row of rows) {
        row.revision = Number(row.revision);
        assert(Number.isSafeInteger(row.revision) && row.revision >= 0, "INVALID_STORED_GROWTH_REVISION");
        for (const key of ["previousAmountCents", "correctionOf", "correctionMode"]) if (row[key] === null) delete row[key];
      }
      const byUser = Map.groupBy(rows, r => r.userId), expected = new Map(plan.packages.map(p => [p.userId, p]));
      let complete = 0, pending = 0, lifetime = 0n, rolling = 0n;
      const tiers = {}, currentTiers = {}, samples = new Map();
      for (const stored of coverage) {
        const item = expected.get(stored.userId), own = byUser.get(stored.userId) ?? [], record = legacy.parseVerifiedLegacyCoverageRecord(stored.canonical, stored.digest);
        assert(item && record && record.fingerprint === item.coverageFingerprint && record.coverageState === item.coverageState && record.executionKey === item.executionKey && own.length === item.contributionCount);
        assert.equal(legacy.assessLegacyCoverageRecord(record, own).state, item.coverageState);
        if (item.coverageState !== "COMPLETE") { pending++; samples.set(item.userId, { item }); continue; }
        complete++;
        const before = model.replayGrowthProjection({ userId: item.userId, asOf: cutoff, contributions: own });
        const now = model.replayGrowthProjection({ userId: item.userId, asOf: i.as_of, contributions: own });
        for (const key of ["effectiveTier", "rollingCents", "lifetimeCents"]) assert.equal(before[key], item.projection[key]);
        tiers[before.effectiveTier] = (tiers[before.effectiveTier] ?? 0) + 1;
        currentTiers[now.effectiveTier] = (currentTiers[now.effectiveTier] ?? 0) + 1;
        if (before.effectiveTier !== "STANDARD" || before.lifetimeCents === "0")
          if (!samples.has(before.effectiveTier)) samples.set(before.effectiveTier, { item, now });
        lifetime += BigInt(before.lifetimeCents); rolling += BigInt(before.rollingCents);
      }
      assert.deepEqual({ complete, pending, lifetimeCents: String(lifetime), rollingCents: String(rolling), tiers }, { complete: plan.summary.complete, pending: plan.summary.pending, lifetimeCents: plan.summary.lifetimeCents, rollingCents: plan.summary.rollingCents, tiers: plan.summary.tiers });
      for (const { item, now } of samples.values()) {
        const response = await mod("auth/membership-growth-integration").readMembershipGrowth(db, item.userId, i.as_of);
        assert.equal(response?.growth.knowledge, now ? "KNOWN" : "UNKNOWN");
        if (now) { assert.equal(response.growth.effectiveTier, now.effectiveTier); assert.equal(response.growth.benefitsState, "CONFIGURED"); }
        else assert.equal(response.growth.rollingPoints, null);
      }
      result.summary = { coverage: coverage.length, contributions: rows.length, complete, pending, currentTiers, officialReaderSamples: samples.size };
    });
    assert(result.readOnlyRollbackAck && result.readOnlyClientClosed);
    result.status = "EXACT_ALL_RECORDS_AND_FACTS_VERIFIED";
  } else {
    const { plan, directory } = pinManifest(), recovery = mode === "--recover-index", recoverIndex = recovery ? Number(option("--recover-index")) : null;
    const actorProof = pinned(privatePath(input.actor.path), input.actor.sha256);
    const actor = { id: actorProof.id ?? actorProof.actorId, sessionId: actorProof.sessionId };
    assert(actor.id && actor.sessionId && (!actorProof.actorId || actor.id === actorProof.actorId));
    assert(growthInput.approvedBy === "Root" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(growthInput.approvalRef) && Number.isSafeInteger(growthInput.attempt) && growthInput.attempt >= 1, "GROWTH_ROOT_AUTHORITY_REQUIRED");
    const windowStartUtc = input.window.notBefore, windowEndUtc = input.window.expiresAt;
    assert(Date.parse(windowStartUtc) <= Date.now() && Date.now() < Date.parse(windowEndUtc) && Date.parse(windowEndUtc) - Date.parse(windowStartUtc) <= 86400000, "GROWTH_WINDOW_INACTIVE");
    const user = plan.coverageOwner;
    assert(user === credentials.migration.name || user === "zzsh", "GROWTH_COVERAGE_OWNER_NOT_ALLOWED");
    let password = credentials.migration.password;
    if (user !== credentials.migration.name) {
      const secret = input.secrets?.databaseMaintenance;
      assert(secret && isAbsolute(secret.path) && resolve(secret.path).toLowerCase().startsWith(resolve("E:/zzsh/zzsh/apps/api/.secrets").toLowerCase() + "\\"), "GROWTH_MAINTENANCE_SECRET_REQUIRED");
      const bytes = readFileSync(secret.path);
      assert.equal(sha(bytes), secret.sha256, "GROWTH_MAINTENANCE_SECRET_CHANGED");
      password = bytes.toString("utf8").trim();
    }
    const migration = { ...base, user, password }, lock = instrument(new Client({ ...migration, database: "postgres" })), pool = new Pool({ ...migration, database, max: 1 });
    pool.on("connect", instrument);
    const cli = mod("auth/membership-growth-legacy-cli"), maintenance = mod("auth/membership-growth-legacy-maintenance"), port = mod("auth/membership-growth-legacy-store").createLegacyGrowthCoveragePort();
    const originalActorId = actor.id;
    let continued = null;
    if (option("--continue-from")) {
      assert(!recovery, "CONTINUE_AND_RECOVER_ARE_SEPARATE");
      continued = pinned(privatePath(option("--continue-from")), option("--continue-from-sha"));
      assert(continued.status === "NOT_COMMITTED_STOPPED" && continued.error?.rollbackAcknowledged === true && continued.actorId === originalActorId && continued.manifestSha256 === result.manifestSha256 && continued.oid === target.oid && continued.nonce === target.nonce && Number.isSafeInteger(continued.completed) && continued.completed >= 0 && continued.completed < plan.packages.length, "KNOWN_ORIGINAL_ROLLBACK_REQUIRED_TO_CONTINUE");
      const original = plan.packages[continued.completed];
      assert(continued.pending?.index === continued.completed + 1 && continued.pending.executionKey === original.executionKey && continued.pending.businessPackageSha256 === original.sha256, "CONTINUATION_ORIGINAL_PACKAGE_CHANGED");
    }
    if (recovery) {
      assert(Number.isSafeInteger(recoverIndex) && recoverIndex >= 1 && recoverIndex <= plan.packages.length);
      const from = pinned(privatePath(option("--recover-from")), option("--recover-from-sha"));
      assert(from.status === "COMMIT_UNKNOWN_STOPPED" && from.pending?.index === recoverIndex && from.pending.executionKey === plan.packages[recoverIndex - 1].executionKey && from.manifestSha256 === result.manifestSha256 && from.actorId === originalActorId && from.oid === target.oid && from.nonce === target.nonce, "ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED");
    }
    let held = false, lockConnected = false;
    try {
      await lock.connect(); lockConnected = true;
      held = (await lock.query(advisoryLockSql(resource, "try"))).rows[0]?.ok === true;
      assert(held, "REGRESSION_RESOURCE_BUSY");
      await readonly(async (db, i) => {
        assert.equal(i.coverage_owner, user);
        const counts = (await db.query("SELECT (SELECT count(*)::int FROM zzsh_iam.user_identity_state WHERE provider='legacy_mysql_restore') users,(SELECT count(*)::int FROM zzsh_order.legacy_order_read_snapshot) orders,(SELECT count(*)::int FROM zzsh_iam.membership_growth_legacy_coverage) coverage,(SELECT count(*)::int FROM zzsh_iam.membership_growth_contribution) contributions")).rows[0];
        assert.equal(counts.users, plan.packages.length);
        assert.equal(counts.orders, plan.summary.orders);
        if (!recovery) {
          const committed = continued?.completed ?? 0;
          assert.equal(counts.coverage, committed, "GROWTH_PRIOR_COVERAGE_COUNT_DRIFT");
          assert.equal(counts.contributions, plan.packages.slice(0, committed).reduce((n, p) => n + p.contributionCount, 0), "GROWTH_PRIOR_CONTRIBUTION_COUNT_DRIFT");
          if (committed) {
            const prior = new Map(plan.packages.slice(0, committed).map(p => [p.userId, p]));
            for (const row of (await db.query("SELECT subject_user_id,record_canonical,record_digest FROM zzsh_iam.membership_growth_legacy_coverage")).rows) {
              const item = prior.get(row.subject_user_id), record = legacy.parseVerifiedLegacyCoverageRecord(row.record_canonical, row.record_digest);
              assert(item && record && record.executionKey === item.executionKey && record.fingerprint === item.coverageFingerprint && record.coverageState === item.coverageState, "GROWTH_PRIOR_COVERAGE_KEY_DRIFT");
            }
          }
        }
      });
      const scope = { bindingKind: "DATABASE_COMMENT", databaseName: database, databaseOid: target.oid, owner: "zzsh", runtimeRole: user, databaseComment: marker };
      const { withReadOnlyTransaction } = mod("credit/credit-initialization");
      Object.assign(result, { actorId: originalActorId, completed: continued?.completed ?? 0, inserted: continued?.inserted ?? 0, replayed: continued?.replayed ?? 0, complete: continued?.complete ?? 0, partial: continued?.partial ?? 0 });
      if (continued) result.priorReceiptSha256 = option("--continue-from-sha");
      save();
      mkdirSync(join(out, "approvals"));
      for (const index of recovery ? [recoverIndex] : plan.packages.keys().drop(result.completed).map(i => i + 1)) {
        const item = plan.packages[index - 1];
        assert.equal(item.file, "packages/" + String(index).padStart(5, "0") + ".json");
        const businessPath = privatePath(join(directory, item.file)), businessBytes = readFileSync(businessPath);
        assert.equal(sha(businessBytes), item.sha256);
        const leafMode = recovery ? "RECOVER_READ" : "APPLY";
        const approval = { schema: "legacy-growth-maintenance-approval-v2", status: "APPROVED", approvalRef: growthInput.approvalRef, attempt: growthInput.attempt, mode: leafMode, businessPackageSha256: item.sha256, executionKey: item.executionKey, actor: { adminId: actor.id, sessionId: actor.sessionId }, windowStartUtc, windowEndUtc, resource: scope };
        const leafPath = join(out, "approvals", String(index).padStart(5, "0") + ".json"), approvalBytes = Buffer.from(JSON.stringify(approval) + "\n"), approvalSha256 = sha(approvalBytes);
        writeFileSync(leafPath, approvalBytes, { flag: "wx", mode: 0o600 });
        const run = cli.readLegacyGrowthMaintenanceRun({ LEGACY_GROWTH_ENABLED: "true", LEGACY_GROWTH_PACKAGE_FILE: businessPath, LEGACY_GROWTH_PACKAGE_SHA256: item.sha256, LEGACY_GROWTH_APPROVAL_FILE: leafPath, LEGACY_GROWTH_APPROVAL_SHA256: approvalSha256, LEGACY_GROWTH_MODE: leafMode }, file => file === leafPath ? approvalBytes : businessBytes, Date.now(), { databaseName: database, databaseUser: user });
        const pending = { index, executionKey: item.executionKey, businessPackageSha256: item.sha256, approvalSha256, businessFingerprint: run.input.businessFingerprint };
        result.pending = pending;
        appendFileSync(join(out, "events.jsonl"), JSON.stringify({ event: "INTENT", ...pending }) + "\n", { flush: true });
        const reply = recovery ? await withReadOnlyTransaction(pool, client => maintenance.readLegacyGrowthMaintenanceReceipt(client, run.input, port)) : await cli.runLegacyGrowthMaintenanceApply(pool, run.input, port);
        appendFileSync(join(out, "events.jsonl"), JSON.stringify({ event: recovery ? "RECOVER_READ" : "COMMIT_ACK", ...pending, reply }) + "\n");
        if (recovery) result.recoveryState = reply.state;
        else {
          const receipt = reply.receipt;
          assert(receipt.coverageFingerprint === item.coverageFingerprint && receipt.coverageState === item.coverageState && receipt.subjectUserId === item.userId && receipt.executionKey === item.executionKey, "GROWTH_ACK_RECONCILIATION_FAILED");
          result.inserted += receipt.inserted; result.replayed += receipt.replayed;
          if (item.coverageState === "COMPLETE") result.complete++; else result.partial++;
        }
        result.pending = null; result.completed++;
        if (result.completed === 1 || result.completed % 100 === 0) {
          save();
          console.log(JSON.stringify({ stage: "GROWTH_PROGRESS", completed: result.completed, total: plan.packages.length, inserted: result.inserted, pending: result.partial, queries: result.queries }));
        }
      }
      if (!recovery) {
        assert.equal(result.completed, plan.packages.length);
        assert.equal(result.complete, plan.summary.complete);
        assert.equal(result.partial, plan.summary.pending);
        assert.equal(result.inserted, plan.summary.contributions);
        assert.equal(result.replayed, 0);
      }
      result.status = recovery ? "RECOVERED_READ_ONLY" : "APPLIED_COMMIT_ACK_INDEPENDENT_READBACK_REQUIRED";
    } finally {
      try { await pool.end(); result.poolClosed = true; } finally {
        try { if (held) result.unlockAck = (await lock.query(advisoryLockSql(resource, "unlock"))).rows[0]?.ok === true; }
        finally { if (lockConnected) await lock.end(); result.lockClosed = true; }
      }
    }
    assert(result.poolClosed && result.unlockAck && result.lockClosed, "GROWTH_CLEANUP_UNCONFIRMED");
  }
} catch (error) {
  result.status = error.outcome === "COMMIT_UNKNOWN" ? "COMMIT_UNKNOWN_STOPPED" : error.outcome === "NOT_COMMITTED" ? "NOT_COMMITTED_STOPPED" : "STOPPED_PRESERVE_ORIGINAL_EVIDENCE";
  result.error = { code: error.cause?.code ?? error.code ?? error.name, message: String(error.message).slice(0, 200), rollbackAcknowledged: error.rollbackAcknowledged ?? null, preserved: error.preserved ?? null };
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  result.wallMs = performance.now() - started;
  save();
  console.log(JSON.stringify({ status: result.status, mode, queries: result.queries, wallMs: result.wallMs, manifestSha256: result.manifestSha256, summary: result.summary, receipt: summaryFile }));
}
