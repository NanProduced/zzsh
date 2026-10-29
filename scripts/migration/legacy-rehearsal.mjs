#!/usr/bin/env node
/**
 * Legacy migration rehearsal CLI (offline).
 *
 * Default command: plan. It reads one frozen manifest, verifies every input
 * SHA, calls the product planners that already exist in apps/api, and writes a
 * plan with original keys, dependencies, isolation reasons and next requests.
 *
 * It never opens MySQL/PostgreSQL, never performs HTTP, never calls a writer,
 * and never writes outside --out. Those facts are enforced by lib/offline-guard
 * and reported in io.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { installOfflineGuard } from "./lib/offline-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = join(HERE, "fixtures", "manifest.json");
const DEFAULT_OUT = join(HERE, "out");
const FIXED_COMMIT = "376760181054ae0a3e12fa99f155d88588a6ca03";
const STATUSES = ["READY", "REPLAY_ONLY", "MISSING_FACT", "CONFLICT", "ISOLATED"];
const SECRET_KEYS = new Set(["mobile", "nickname", "password", "legacyPassword", "id_card", "idCard", "bank_card", "bankCard", "token", "secret", "authorization"]);

const io = { fileReads: 0, fileWrites: 0, networkAttempts: 0, dbConnects: 0, writerCalls: 0 };
installOfflineGuard(io);

const require = createRequire(import.meta.url);

function fail(code, detail) {
  const error = new Error(code);
  error.code = code;
  error.detail = detail;
  throw error;
}

function codeOf(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)) return error.message;
  return "SOURCE_REJECTED";
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEYS.has(key) ? "[REDACTED]" : redact(item);
    }
    return result;
  }
  return value;
}

function assertInside(root, path) {
  const rootAbs = resolve(root) + sep;
  const pathAbs = resolve(path);
  if (pathAbs !== resolve(root) && !pathAbs.startsWith(rootAbs)) fail("OUT_PATH_ESCAPE", { root: resolve(root), path: pathAbs });
}

function readJson(path, label) {
  if (/(?:^|[\\/])(?:\.secrets|\.env(?:\..*)?)(?:[\\/]|$)/i.test(path)) fail("PRIVATE_INPUT_REFUSED", { label });
  io.fileReads += 1;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail("INPUT_READ_FAILED", { label, path, message: error instanceof Error ? error.message : String(error) });
  }
  try {
    return { value: JSON.parse(text), sha256: sha256(text), path };
  } catch (error) {
    fail("INPUT_JSON_INVALID", { label, path });
  }
}

function writeJson(outDir, name, value) {
  const path = resolve(outDir, name);
  assertInside(outDir, path);
  mkdirSync(dirname(path), { recursive: true });
  io.fileWrites += 1;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function writeText(outDir, name, value) {
  const path = resolve(outDir, name);
  assertInside(outDir, path);
  mkdirSync(dirname(path), { recursive: true });
  io.fileWrites += 1;
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  return path;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "help") {
      args.help = true;
      continue;
    }
    if (key === "allow-other-source") {
      fail("SOURCE_OVERRIDE_NOT_SUPPORTED");
    }
    if (key === "plan") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        args.planFlag = true;
      } else {
        args.plan = next;
        index += 1;
      }
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail("CLI_ARGUMENT_MISSING", { key });
    args[key] = next;
    index += 1;
  }
  return args;
}

function findApiDist(explicit) {
  const apiDist = resolve(explicit ?? join(HERE, "..", "..", "apps", "api", "dist", "src"));
  if (!existsSync(join(apiDist, "legacy-load", "user-order-offline-plan.js"))) fail("API_DIST_NOT_FOUND");
  return apiDist;
}

function loadPlanners(apiDist) {
  const load = (relative) => {
    const path = join(apiDist, relative);
    if (!existsSync(path)) fail("PLANNER_MODULE_MISSING", { path });
    return require(path);
  };
  return {
    userOrderPlan: load("legacy-load/user-order-offline-plan.js"),
    legacySkinHoldings: load("legacy-load/legacy-skin-holdings.js"),
    continuationPreparation: load("order/legacy-continuation-source-preparation.js"),
    financePreparation: load("finance/legacy-finance-source-preparation.js"),
    dutyCreditSources: load("finance/legacy-duty-funding.js").LEGACY_DUTY_CREDIT_SOURCES,
  };
}

function verifyPlannerBuild(apiDist, manifest) {
  const build = manifest.plannerBuild;
  if (!build || build.sourceCommit !== manifest.sourceCommit || build.nodeVersion !== process.version || !build.files || Object.keys(build.files).length < 4) fail("PLANNER_BUILD_BINDING_REQUIRED");
  for (const [relative, digest] of Object.entries(build.files)) {
    const full = resolve(apiDist, relative); assertInside(apiDist, full);
    if (!/^[a-f0-9]{64}$/.test(digest) || !existsSync(full) || sha256(readFileSync(full)) !== digest) fail("PLANNER_BUILD_DRIFT", { module: relative });
    const source = resolve(HERE, "..", "..", "apps", "api", "src", relative.replace(/\.js$/, ".ts"));
    assertInside(resolve(HERE, "..", "..", "apps", "api", "src"), source);
    if (build.sources?.[relative] !== sha256(readFileSync(source))) fail("PLANNER_SOURCE_DRIFT", { module: relative });
  }
  const repo = resolve(HERE, "..", "..");
  if (build.packageLockSha256 !== sha256(readFileSync(join(repo, "package-lock.json")))) fail("PLANNER_DEPENDENCY_LOCK_DRIFT");
  for (const [relative, digest] of Object.entries(build.sharedFiles ?? {})) {
    const full = resolve(repo, relative); assertInside(repo, full);
    if (!relative.startsWith("packages/") || sha256(readFileSync(full)) !== digest) fail("PLANNER_SHARED_DRIFT");
  }
}
function moduleHashes(apiDist, manifest) {
  const loaded = Object.keys(require.cache).filter(p => p.startsWith(apiDist + sep));
  for (const full of loaded) {
    const relative = full.slice(apiDist.length + 1).replaceAll("\\", "/");
    if (manifest.plannerBuild.files[relative] !== sha256(readFileSync(full))) fail("PLANNER_CLOSURE_UNBOUND", { module: relative });
  }
  return ["legacy-load/user-order-offline-plan.js", "legacy-load/legacy-skin-holdings.js", "order/legacy-continuation-source-preparation.js", "finance/legacy-finance-source-preparation.js"].map(relative => ({
    path: "apps/api/src/" + relative.replace(/\.js$/, ".ts"), sourceSha256: manifest.plannerBuild.sources[relative], compiledSha256: sha256(readFileSync(join(apiDist, relative))), sourceCommit: manifest.sourceCommit,
  }));
}

function compareLegacyId(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function canonicalStatus(sourceState) {
  switch (sourceState) {
    case "PARAMETER_READY":
    case "ADMISSION_CANDIDATE":
    case "READY":
    case "LEGACY_TERMINAL":
    case "OBSERVE_ONLY":
      return "READY";
    case "ALREADY_APPLIED":
    case "REPLAY_ONLY":
      return "REPLAY_ONLY";
    case "PENDING_DEPENDENCY":
    case "MISSING_FACT":
      return "MISSING_FACT";
    case "CONFLICT":
      return "CONFLICT";
    case "ISOLATED":
      return "ISOLATED";
    default:
      return "CONFLICT";
  }
}

function actionFor(sourceState) {
  switch (sourceState) {
    case "ALREADY_APPLIED":
    case "REPLAY_ONLY":
      return "REPLAY_ORIGINAL_KEY";
    case "LEGACY_TERMINAL":
      return "LEGACY_TERMINAL";
    case "OBSERVE_ONLY":
      return "OBSERVE_ONLY";
    case "PARAMETER_READY":
    case "ADMISSION_CANDIDATE":
    case "READY":
      return "PLAN_ONLY";
    default:
      return "NONE";
  }
}

function countStatuses(items) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

function commandSummary(command) {
  if (!command) return null;
  return {
    kind: command.kind ?? null,
    operation: command.operation,
    resourceId: command.resourceId,
    scopeKey: command.scopeKey ?? null,
    idempotencyKey: command.idempotencyKey,
    fingerprint: command.fingerprint,
    recovery: command.recovery,
    recoveryPrincipalId: command.recoveryPrincipalId ?? null,
    bodySha256: sha256(stable(command.body)),
    binding: Object.fromEntries(["legacyId", "accountId", "ownerUserId", "renterUserId", "disposition"].filter(k => command.body?.[k] !== undefined).map(k => [k, command.body[k]])),
  };
}

function sourceIdOf(sourceKey) {
  if (typeof sourceKey !== "string") return null;
  const index = sourceKey.indexOf(":");
  return index >= 0 ? sourceKey.slice(index + 1) : null;
}

function loadManifest(path, allowOtherSource) {
  const read = readJson(path, "manifest");
  const manifest = read.value;
  if (!manifest || manifest.schema !== "legacy-rehearsal-manifest.v1") fail("MANIFEST_SCHEMA_INVALID");
  if (manifest.mode !== "PLAN_ONLY") fail("MODE_NOT_PLAN_ONLY", { mode: manifest.mode });
  if (manifest.sourceCommit !== FIXED_COMMIT) fail("SOURCE_COMMIT_NOT_FIXED", { expected: FIXED_COMMIT, actual: manifest.sourceCommit });
  if (manifest.approval?.approved !== false) fail("APPROVAL_MUST_BE_FALSE_FOR_PLAN", { approval: manifest.approval });
  if (manifest.approval?.claim !== null) fail("CLAIM_MUST_BE_NULL_FOR_PLAN");
  if (manifest.target?.databaseOid !== null && !(manifest.target?.engine === "postgresql" && manifest.target?.bound === true && Number.isSafeInteger(manifest.target.databaseOid) && manifest.target.databaseOid > 0)) fail("TARGET_IDENTITY_INVALID");
  const baseDir = dirname(resolve(path));
  const inputs = {};
  const inputHashes = {};
  for (const [name, spec] of Object.entries(manifest.inputs ?? {})) {
    if (!spec || typeof spec.path !== "string" || typeof spec.sha256 !== "string") fail("MANIFEST_INPUT_INVALID", { name });
    const inputPath = resolve(baseDir, spec.path);
    const input = readJson(inputPath, name);
    if (input.sha256 !== spec.sha256) fail("INPUT_SHA_MISMATCH", { name, expected: spec.sha256, actual: input.sha256, path: inputPath });
    inputs[name] = input.value;
    inputHashes[name] = { path: spec.path, sha256: input.sha256, bytes: statSync(inputPath).size };
  }
  return { manifest, manifestSha256: read.sha256, manifestPath: resolve(path), inputs, inputHashes };
}

function identityDomain(p, input) {
  const users = [...(input.users ?? [])].sort((a, b) => compareLegacyId(a.id, b.id));
  const batch = p.userOrderPlan.planLegacyUserBatch(users, new Set(input.seenMobiles ?? []));
  const items = batch.results.map((result, index) => {
    const row = users[index];
    const sourceState = result.disposition;
    return {
      sourceKey: `la_user:${row.id}`,
      legacyId: row.id,
      userId: result.userId ?? null,
      status: canonicalStatus(sourceState),
      sourceState,
      action: actionFor(sourceState),
      reason: result.reason ?? null,
      blockers: result.blockers ?? [],
      sourceDigest: row.sourceDigest,
      evidenceRef: row.evidenceRef,
      evidenceDigest: result.writerInput?.evidenceDigest ?? null,
      projected: result.projected ?? null,
      passwordPreserved: result.legacyPasswordPresent ?? null,
      highRisk: result.risk ?? null,
      dependencies: [],
      writeAllowed: false,
    };
  });
  return { status: items.some((item) => item.status === "CONFLICT") ? "BLOCKED" : "PLAN_READY", counts: countStatuses(items), items, parameterReady: batch.parameterReady, isolated: batch.isolated, writes: 0 };
}

function accountAndOrderDomains(p, input) {
  const accounts = [];
  const orders = [];
  for (const chain of input.chains ?? []) {
    const result = p.userOrderPlan.planSourceChain(chain);
    const steps = result.steps.map((step) => ({
      step: step.step,
      status: canonicalStatus(step.disposition),
      sourceState: step.disposition,
      reason: step.reason ?? null,
      ready: step.parameterReady === true || step.snapshotReady === true,
      parameterReady: step.parameterReady === true,
      snapshotReady: step.snapshotReady === true,
      writer: step.writer ?? null,
    }));
    const snapshotStep = result.steps.find((step) => step.step === "readSnapshot");
    const orderStep = result.steps.find((step) => step.step === "order");
    const critical = ["owner", "renter", "game", "account", "observation", "map", "readSnapshot"];
    const sourceReady = critical.every((name) => steps.some((step) => step.step === name && step.ready)) && !steps.some((step) => step.status === "ISOLATED");
    const orderReady = !chain.order || (orderStep && orderStep.disposition === "PARAMETER_READY");
    const isolated = steps.some((step) => step.status === "ISOLATED");
    const accountSourceState = isolated ? "ISOLATED" : sourceReady && orderReady ? "PARAMETER_READY" : "PENDING_DEPENDENCY";
    const account = {
      sourceKey: `la_rental_accounts:${chain.account.row.id}`,
      legacyId: chain.account.row.id,
      accountId: result.ids.accountId,
      ownerUserId: result.ids.ownerUserId,
      renterUserId: result.ids.renterUserId,
      gameId: result.ids.targetGameId,
      sourceGameId: result.ids.sourceGameId,
      status: canonicalStatus(accountSourceState),
      sourceState: accountSourceState,
      action: actionFor(accountSourceState),
      reasons: canonicalStatus(accountSourceState) === "READY" ? [] : [...new Set(steps.filter((step) => step.status !== "READY" && !step.ready).map((step) => step.reason ?? `${step.step}_NOT_READY`))],
      steps,
      relations: result.relations,
      dependencies: {
        ownerUserId: result.ids.ownerUserId,
        renterUserId: result.ids.renterUserId,
        accountId: result.ids.accountId,
        gameId: result.ids.targetGameId,
        sourceGameId: result.ids.sourceGameId,
      },
      originalKeys: {
        accountId: result.ids.accountId,
        orderId: result.ids.orderId,
        accountSourceDigest: chain.account.sourceDigest,
        orderSourceDigest: chain.order?.source?.digest ?? null,
        accountEvidenceRef: chain.account.evidenceRef,
      },
      rentableGate: {
        sourceAccountReady: sourceReady,
        sourceSnapshotReady: snapshotStep?.snapshotReady === true,
        sourceStatusPublicCandidate: snapshotStep?.sourceStatusPublicCandidate === true,
        sourceStatus: snapshotStep?.sourceStatus ?? null,
        ownerAcceptance: "UNREAD",
        currentQuote: "UNREAD",
        currentPolicy: "UNREAD",
        media: "UNREAD",
        targetOccupancy: "UNREAD",
        targetReadback: "UNREAD",
        rentable: false,
        reason: "TARGET_QUOTE_ACCEPTANCE_OCCUPANCY_MEDIA_UNREAD",
      },
      writeAllowed: false,
    };
    accounts.push(account);

    if (chain.order) {
      const orderStep = result.steps.find((step) => step.step === "order");
      const bound = orderStep?.writerInput;
      const dependency = {
        ownerUserId: result.ids.ownerUserId,
        renterUserId: result.ids.renterUserId,
        accountId: result.ids.accountId,
        gameId: result.ids.targetGameId,
      };
      const planned = bound ? p.userOrderPlan.planLegacyOrder(bound, dependency) : null;
      const orderSourceState = orderStep?.disposition ?? "PENDING_DEPENDENCY";
      orders.push({
        sourceKey: `la_order:${chain.order.source.legacyId}`,
        legacyId: chain.order.source.legacyId,
        orderId: result.ids.orderId,
        accountId: result.ids.accountId,
        accountLegacyId: chain.account.row.id,
        ownerUserId: result.ids.ownerUserId,
        renterUserId: result.ids.renterUserId,
        status: canonicalStatus(orderSourceState),
        sourceState: orderSourceState,
        action: actionFor(orderSourceState),
        reason: orderStep?.reason ?? null,
        originalOrderNo: planned?.originalOrderNo ?? chain.order.source.row.order_sn ?? null,
        sourceStatus: planned?.sourceStatus ?? chain.order.source.row.order_status ?? null,
        inflightReadOnly: planned?.inflightReadOnly ?? null,
        cancelledWithPaymentRecord: planned?.cancelledWithPaymentRecord ?? null,
        dueCents: planned?.dueCents ?? null,
        paidCents: planned?.paidCents ?? null,
        depositCents: planned?.depositCents ?? null,
        refundCents: planned?.refundCents ?? null,
        refundChannelState: planned?.refundChannelState ?? "UNKNOWN",
        sourceDigest: chain.order.source.digest,
        dependencyDigests: planned?.dependencyDigests ?? null,
        dependencies: dependency,
        writeAllowed: false,
      });
    }
  }
  return {
    account: { status: accounts.some((item) => item.status === "CONFLICT" || item.status === "ISOLATED") ? "BLOCKED" : "PLAN_READY", counts: countStatuses(accounts), items: accounts },
    order: { status: orders.some((item) => item.status === "CONFLICT" || item.status === "ISOLATED") ? "BLOCKED" : "PLAN_READY", counts: countStatuses(orders), items: orders },
  };
}

function continuationDomain(p, input) {
  const currentFacts = input.current?.json ? JSON.parse(input.current.json) : null;
  const accountByLegacy = new Map((currentFacts?.accounts ?? []).map((account) => [account.legacyId, account.accountId]));
  const accountByTarget = new Map((currentFacts?.accounts ?? []).map((account) => [account.accountId, account.legacyId]));
  const result = p.continuationPreparation.assembleLegacyContinuationBatch({
    batchId: input.batchId,
    targetDatabaseOid: input.targetDatabaseOid,
    principalId: input.principalId,
    source: input.source,
    current: input.current,
  });
  const items = result.rows.map((row) => ({
    sourceKey: row.legacyId ? `la_order:${row.legacyId}` : "invalid_row",
    legacyId: row.legacyId,
    orderId: row.orderId,
    group: row.group,
    status: canonicalStatus(row.state),
    sourceState: row.state,
    action: actionFor(row.state),
    reasons: row.reasons,
    admitted: row.state === "READY" || row.state === "REPLAY_ONLY",
    originalKeys: row.command
      ? {
          kind: row.command.kind,
          operation: row.command.operation,
          resourceId: row.command.resourceId,
          scopeKey: row.command.scopeKey ?? null,
          idempotencyKey: row.command.idempotencyKey,
          fingerprint: row.command.fingerprint,
          recovery: row.command.recovery,
        }
      : null,
    command: commandSummary(row.command),
    accountTargetId: row.prepared ? accountByLegacy.get(row.prepared.source.accountId) ?? null : (row.command?.kind === "INFLIGHT_REGISTER" ? row.command.body?.accountId ?? null : null),
    accountLegacyId: row.prepared ? row.prepared.source.accountId : (row.command?.kind === "INFLIGHT_REGISTER" ? accountByTarget.get(row.command.body?.accountId) ?? null : null),
    dependencies: {
      sourceReceiptDigest: result.sourceReceiptDigest,
      currentReadObservedAt: input.current?.receipt?.observedAt ?? null,
      currentReadRef: input.current?.receipt?.factsSha256 ?? null,
      principalId: input.principalId,
      targetDatabaseOid: input.targetDatabaseOid,
      targetDatabaseOidSource: "CONTINUATION_INPUT",
    },
    duties: row.duties,
    prepared: row.prepared
      ? {
          sourceAsOf: row.prepared.sourceAsOf,
          evidenceRef: row.prepared.evidenceRef,
          factsDigest: row.prepared.factsDigest,
          pendingScope: row.prepared.pendingScope,
          emptyPendingProven: row.prepared.emptyPendingProven,
          commissionCount: row.prepared.source.commissions.length,
          accountLegacyId: row.prepared.source.accountId,
          accountTargetId: accountByLegacy.get(row.prepared.source.accountId) ?? null,
        }
      : null,
    writeAllowed: false,
  }));
  return {
    status: items.some((item) => item.status === "CONFLICT") ? "BLOCKED" : items.some((item) => item.status === "MISSING_FACT") ? "BLOCKED_MISSING_FACT" : "PLAN_READY",
    counts: countStatuses(items),
    items,
    sourceReceiptDigest: result.sourceReceiptDigest,
    inputDigest: result.inputDigest,
    denominators: result.denominators,
    conserved: result.conserved,
    commissionScope: result.commissionScope,
    writeAllowed: false,
  };
}

function financeDomain(p, input, continuation) {
  const history = [];
  for (const entry of input.history ?? []) {
    let prepared = null;
    let error = null;
    try {
      prepared = p.financePreparation.prepareFrozenFinanceHistory(entry);
    } catch (caught) {
      error = codeOf(caught);
    }
    const rowItems = (entry.rows ?? []).map((row, index) => {
      try {
        const preview = p.financePreparation.prepareFrozenFinanceObservation(entry.sourceKind, row, entry.subject);
        return {
          sourceKey: `${preview.row.rawSource?.entity ?? entry.sourceKind}:${preview.sourceId}`,
          sourceId: String(preview.sourceId),
          sourceDigest: preview.sourceDigest,
          sourceEventAt: preview.sourceEventAt,
          status: "READY",
          sourceState: "PARAMETER_READY",
          reason: null,
        };
      } catch (caught) {
        return {
          sourceKey: `${entry.sourceKind}:row:${index}`,
          sourceId: null,
          sourceDigest: null,
          sourceEventAt: null,
          status: "CONFLICT",
          sourceState: "CONFLICT",
          reason: codeOf(caught),
        };
      }
    });
    const observations = prepared
      ? prepared.observations.map((row) => ({
          sourceKey: `${row.rawSource?.entity ?? entry.sourceKind}:${row.sourceId}`,
          sourceId: String(row.sourceId),
          sourceDigest: prepared.coverage.imported.find((item) => String(item.sourceId) === String(row.sourceId))?.sourceDigest ?? null,
          sourceEventAt: row.sourceEventAt,
          financialSource: entry.sourceKind === "HISTORICAL_EARNINGS_LOG" ? "UNKNOWN" : "OBSERVATION_ONLY",
          status: "READY",
          sourceState: "PARAMETER_READY",
          reason: null,
        }))
      : rowItems;
    history.push({
      label: entry.label ?? entry.sourceKind,
      sourceKind: entry.sourceKind,
      status: prepared ? "READY" : "CONFLICT",
      sourceState: prepared ? "PARAMETER_READY" : "CONFLICT",
      reason: error,
      coverage: prepared?.coverage ?? null,
      denominators: {
        sourceCount: entry.sourceCount,
        imported: observations.length,
        isolated: entry.isolated?.length ?? 0,
        unprocessed: Math.max(0, Number(entry.sourceCount) - observations.length - (entry.isolated?.length ?? 0)),
      },
      observations,
      rows: rowItems,
      writeAllowed: false,
    });
  }

  const openings = [];
  for (const entry of input.storedOpenings ?? []) {
    const base = {
      openingId: entry.openingId,
      openingIdMeaning: "SCENARIO_LABEL_NOT_DATABASE_ID",
      sourceKey: `la_user:${entry.subject?.legacyUserId ?? "UNKNOWN"}`,
      userId: entry.subject?.userId ?? null,
      legacyUserId: entry.subject?.legacyUserId ?? null,
      flowSum: "NOT_COMPUTED",
      writeAllowed: false,
    };
    try {
      const result = p.financePreparation.prepareStoredOpeningCandidate(entry);
      if (result.state === "CANDIDATE") {
        openings.push({
          ...base,
          status: "READY",
          sourceState: "CANDIDATE",
          action: "PLAN_ONLY",
          reason: null,
          availableCents: result.input.proof.availableCents,
          coveredCount: result.input.proof.coveredCount,
          coveredDigest: result.input.proof.coveredDigest,
          sourceDigest: result.input.proof.sourceDigest,
          inputSha256: result.input.inputSha256,
          sourceProofPresent: Boolean(result.input.sourceProof),
          coveredRoots: (entry.covered ?? []).map((source) => `${source.sourceEntity}:${source.sourceId}`),
          coveredEconomicKeys: result.input.proof.coveredSet.map(row => stable([row[0], row[1], row[3], row[4]])),
          executable: false,
        });
      } else {
        openings.push({
          ...base,
          status: "MISSING_FACT",
          sourceState: result.state,
          action: "NONE",
          reason: result.reason,
          availableCents: entry.candidate?.storedEarningsCents ?? null,
          coveredCount: null,
          coveredDigest: null,
          sourceDigest: entry.candidate?.sourceDigest ?? null,
          inputSha256: entry.inputSha256 ?? null,
          sourceProofPresent: false,
          coveredRoots: (entry.covered ?? []).map((source) => `${source.sourceEntity}:${source.sourceId}`),
          executable: false,
        });
      }
    } catch (caught) {
      openings.push({
        ...base,
        status: "CONFLICT",
        sourceState: "CONFLICT",
        action: "NONE",
        reason: codeOf(caught),
        availableCents: entry.candidate?.storedEarningsCents ?? null,
        coveredCount: null,
        coveredDigest: null,
        sourceDigest: entry.candidate?.sourceDigest ?? null,
        inputSha256: entry.inputSha256 ?? null,
        sourceProofPresent: false,
        coveredRoots: (entry.covered ?? []).map((source) => `${source.sourceEntity}:${source.sourceId}`),
        executable: false,
      });
    }
  }

  const liabilities = p.financePreparation.assembleLegacyLiabilityBatch(input.liabilities);
  const liabilityItems = liabilities.rows.map((row) => ({
    sourceKey: row.sourceKey,
    orderId: row.orderId,
    group: row.group,
    status: canonicalStatus(row.state),
    sourceState: row.state,
    action: actionFor(row.state),
    admitted: row.admitted,
    reasons: row.reasons,
    effect: row.effect,
    command: commandSummary(row.command),
    writeAllowed: false,
  }));

  const commissions = p.financePreparation.assembleLegacyCompletedCommissionBatch(input.commissions);
  const commissionItems = commissions.rows.map((row) => ({
    sourceKey: row.sourceKey,
    orderId: row.orderId,
    group: row.group,
    status: canonicalStatus(row.state),
    sourceState: row.state,
    action: actionFor(row.state),
    admitted: row.admitted,
    reasons: row.reasons,
    effect: row.effect,
    command: commandSummary(row.command),
    writeAllowed: false,
  }));

  const dutyItems = [];
  for (const item of [...liabilityItems, ...commissionItems]) if (item.effect) dutyItems.push({ ...item.effect, orderId: item.orderId, sourceRecordId: item.sourceKey.split(":").slice(1).join(":"), sourceKey: item.sourceKey });
  for (const row of continuation.items) {
    for (const duty of row.duties ?? []) {
      dutyItems.push({
        dutyId: duty.id,
        orderId: row.orderId,
        kind: "COMMISSION",
        sourceRecordId: duty.sourceRecordId,
        amountCents: duty.amountCents,
        beneficiaryUserId: duty.beneficiaryUserId,
        status: duty.status,
        settledBy: null,
        sourceKey: row.sourceKey,
      });
    }
  }
  const dutyIdCounts = new Map();
  const economicCounts = new Map();
  for (const duty of dutyItems) {
    dutyIdCounts.set(duty.dutyId, (dutyIdCounts.get(duty.dutyId) ?? 0) + 1);
    const key = `${duty.orderId}|${duty.kind}|${duty.sourceRecordId}`;
    economicCounts.set(key, (economicCounts.get(key) ?? 0) + 1);
  }
  const duplicateDutyIds = [...dutyIdCounts].filter(([, count]) => count > 1).map(([id]) => id);
  const duplicateEconomicRoots = [...economicCounts].filter(([, count]) => count > 1).map(([key]) => key);
  const openingSubjects = new Map();
  for (const item of openings.filter(item => item.status === "READY")) openingSubjects.set(item.userId, (openingSubjects.get(item.userId) ?? 0) + 1);
  const duplicateOpeningSubjects = [...openingSubjects].filter(([, count]) => count > 1).map(([userId]) => userId);
  for (const item of openings) if (item.status === "READY" && duplicateOpeningSubjects.includes(item.userId)) { item.status = "CONFLICT"; item.reason = "DUPLICATE_OPENING_SUBJECT"; }
  const openingRoots = new Set(openings.filter(item => item.status === "READY").flatMap(item => item.coveredEconomicKeys ?? []));
  const dutyRoots = new Set(dutyItems.flatMap(duty => (p.dutyCreditSources[duty.kind] ?? []).map(sourceKind => stable([duty.beneficiaryUserId, sourceKind, duty.kind === "COMMISSION" ? "la_distribution_order" : "la_order", duty.sourceRecordId]))));
  const openingDutyOverlap = [...openingRoots].filter((root) => dutyRoots.has(root));

  const allItems = [...history, ...openings, ...liabilityItems, ...commissionItems];
  return {
    status: allItems.some((item) => item.status === "CONFLICT") || openingDutyOverlap.length || duplicateDutyIds.length || duplicateEconomicRoots.length ? "BLOCKED" : allItems.some((item) => item.status === "MISSING_FACT") ? "BLOCKED_MISSING_FACT" : "PLAN_READY",
    counts: countStatuses(allItems),
    history,
    openings,
    liabilities: { counts: liabilities.counts, byGroup: liabilities.byGroup, conserved: liabilities.conserved, distinctSourceKeys: liabilities.distinctSourceKeys, pendingFacts: liabilities.pendingFacts, inputDigest: liabilities.inputDigest, items: liabilityItems, writeAllowed: false },
    commissions: { counts: commissions.counts, byGroup: commissions.byGroup, conserved: commissions.conserved, distinctSourceKeys: commissions.distinctSourceKeys, pendingFacts: commissions.pendingFacts, inputDigest: commissions.inputDigest, items: commissionItems, writeAllowed: false },
    duties: dutyItems,
    duplicateDutyIds,
    duplicateEconomicRoots,
    openingDutyOverlap,
    duplicateOpeningSubjects,
    writeAllowed: false,
  };
}

function skinsAndMediaDomains(p, skinInput, mediaInput) {
  const index = p.legacySkinHoldings.buildLegacySkinIndex(skinInput.catalog ?? [], skinInput.rules ?? []);
  const holdings = (skinInput.holdings ?? []).map((input) => {
    const holding = p.legacySkinHoldings.mapLegacySkinHolding(input, index, skinInput.catalogRevision);
    const sourceState = holding.complete ? "PARAMETER_READY" : holding.unresolved.length ? "ISOLATED" : "MISSING_FACT";
    return {
      sourceKey: `la_rental_accounts:${holding.accountKey}`,
      accountKey: holding.accountKey,
      gameId: holding.gameId,
      status: canonicalStatus(sourceState),
      sourceState,
      action: actionFor(sourceState),
      reasons: holding.complete ? [] : [...holding.unresolved.map((item) => item.reason), ...holding.pending.map((item) => `PENDING:${item.namingState}`), ...holding.unobservedColumns.map((item) => `UNOBSERVED:${item}`)],
      catalogRevision: holding.catalogRevision,
      digest: holding.digest,
      complete: holding.complete,
      mappedSkinIds: holding.mappedSkinIds,
      pending: holding.pending,
      unresolved: holding.unresolved,
      unobservedColumns: holding.unobservedColumns,
      declarable: p.legacySkinHoldings.declarableLegacySkinIds(holding),
      writeAllowed: false,
    };
  });
  const holdingByAccount = new Map(holdings.map((holding) => [holding.accountKey, holding]));
  const media = [];
  for (const item of mediaInput.items ?? []) {
    const reasons = [];
    let sourceState = "PARAMETER_READY";
    const required = ["accountKey", "skinId", "mediaId", "storageKey", "sha256", "sourceRef", "reviewState", "visibility"];
    for (const key of required) if (typeof item[key] !== "string" || item[key].length === 0) reasons.push(`FIELD_MISSING:${key}`);
    if (typeof item.sha256 === "string" && !/^[a-f0-9]{64}$/.test(item.sha256)) reasons.push("MEDIA_SHA256_INVALID");
    if (typeof item.storageKey === "string" && (item.storageKey.endsWith("/") || item.storageKey.includes(".."))) reasons.push("MEDIA_STORAGE_KEY_NOT_OBJECT");
    if (!["PENDING", "APPROVED", "REJECTED"].includes(item.reviewState)) reasons.push("MEDIA_REVIEW_STATE_INVALID");
    if (!["PRIVATE", "PUBLIC_DISPLAY"].includes(item.visibility)) reasons.push("MEDIA_VISIBILITY_INVALID");
    if (item.visibility === "PUBLIC_DISPLAY" && /(^|\/)private(\/|$)/i.test(item.storageKey ?? "")) reasons.push("PRIVATE_PREFIX_PUBLIC_LEAK");
    const holding = holdingByAccount.get(item.accountKey);
    if (!holding) reasons.push("ACCOUNT_HOLDING_UNREAD");
    else if (![...holding.mappedSkinIds, ...holding.pending.map(p => p.skinId)].includes(item.skinId)) reasons.push("SKIN_NOT_IN_HOLDING");
    if (reasons.some((reason) => reason.startsWith("FIELD_MISSING") || reason === "MEDIA_SHA256_INVALID" || reason === "MEDIA_STORAGE_KEY_NOT_OBJECT" || reason === "MEDIA_REVIEW_STATE_INVALID" || reason === "MEDIA_VISIBILITY_INVALID")) sourceState = "ISOLATED";
    else if (reasons.includes("SKIN_NOT_IN_HOLDING") || reasons.includes("ACCOUNT_HOLDING_UNREAD")) sourceState = "MISSING_FACT";
    else if (reasons.length) sourceState = "CONFLICT";
    else if (item.reviewState === "PENDING") { sourceState = "MISSING_FACT"; reasons.push("MEDIA_REVIEW_PENDING"); }
    else if (item.reviewState === "REJECTED") { sourceState = "ISOLATED"; reasons.push("MEDIA_REVIEW_REJECTED"); }
    media.push({
      sourceKey: `media_asset:${item.mediaId ?? "UNKNOWN"}`,
      mediaId: item.mediaId ?? null,
      accountKey: item.accountKey ?? null,
      skinId: item.skinId ?? null,
      storageKey: item.storageKey ?? null,
      sha256: item.sha256 ?? null,
      sourceRef: item.sourceRef ?? null,
      reviewState: item.reviewState ?? null,
      visibility: item.visibility ?? null,
      publicDisplayReady: item.reviewState === "APPROVED" && item.visibility === "PUBLIC_DISPLAY" && reasons.length === 0,
      status: canonicalStatus(sourceState),
      sourceState,
      action: actionFor(sourceState),
      reasons,
      writeAllowed: false,
    });
  }
  return {
    skins: { status: holdings.some((item) => item.status === "CONFLICT" || item.status === "ISOLATED") ? "BLOCKED" : holdings.some((item) => item.status === "MISSING_FACT") ? "BLOCKED_MISSING_FACT" : "PLAN_READY", counts: countStatuses(holdings), items: holdings },
    media: { status: media.some((item) => item.status === "CONFLICT" || item.status === "ISOLATED") ? "BLOCKED" : media.some((item) => item.status === "MISSING_FACT") ? "BLOCKED_MISSING_FACT" : "PLAN_READY", counts: countStatuses(media), items: media },
  };
}

function occupancyDomain(accounts, orders, continuation) {
  const byLegacy = new Map(accounts.map((item) => [item.legacyId, item]));
  const byTarget = new Map(accounts.map((item) => [item.accountId, item]));
  const state = new Map();
  const touch = (account, orderKey, kind) => {
    if (!account) return;
    const current = state.get(account.accountId) ?? { account, keys: [], kinds: new Set() };
    current.keys.push(orderKey);
    current.kinds.add(kind);
    state.set(account.accountId, current);
  };
  for (const row of continuation.items) {
    if (row.group === "MAPPED" && row.accountTargetId) {
      touch(byLegacy.get(row.accountLegacyId) ?? { accountId: row.accountTargetId, legacyId: row.accountLegacyId }, `la_order:${row.legacyId}`, "INFLIGHT_MAPPED");
    } else if (row.group === "ISOLATED_REGISTER" && row.accountTargetId) {
      touch(byTarget.get(row.accountTargetId) ?? { accountId: row.accountTargetId, legacyId: row.accountLegacyId }, `la_order:${row.legacyId}`, "ISOLATED_REGISTER");
    }
  }
  for (const order of orders) {
    if (["3", "8", "9"].includes(String(order.sourceStatus))) touch(byLegacy.get(order.accountLegacyId), `la_order:${order.legacyId}`, "INFLIGHT_MAPPED");
  }
  const all = new Map();
  for (const account of accounts) {
    if (typeof account.accountId === "string" && account.accountId.length > 0 && ["READY", "REPLAY_ONLY"].includes(account.status)) all.set(account.accountId, { account, keys: [], kinds: new Set() });
  }
  for (const [accountId, entry] of state) all.set(accountId, entry);
  const items = [...all.values()]
    .map(({ account, keys, kinds }) => {
      const expected = kinds.has("INFLIGHT_MAPPED") ? "OCCUPIED_OR_UNKNOWN" : kinds.has("ISOLATED_REGISTER") ? "UNKNOWN" : "FREE_CANDIDATE";
      return {
        sourceKey: `la_rental_accounts:${account.legacyId}`,
        accountId: account.accountId,
        legacyId: account.legacyId,
        expected,
        sourceOrderKeys: keys,
        targetState: "UNREAD",
        status: "MISSING_FACT",
        sourceState: "TARGET_READ_REQUIRED",
        action: "NONE",
        reasons: ["TARGET_OCCUPANCY_UNREAD"],
        writeAllowed: false,
      };
    })
    .sort((left, right) => String(left.accountId).localeCompare(String(right.accountId)));
  return { status: "BLOCKED_TARGET_FACTS", counts: countStatuses(items), items, writeAllowed: false };
}

function buildPlan(options) {
  const loaded = loadManifest(options.manifest, options.allowOtherSource);
  const apiDist = findApiDist(options.apiDist);
  const manifest = loaded.manifest;
  verifyPlannerBuild(apiDist, manifest);
  const p = loadPlanners(apiDist);
  const inputs = loaded.inputs;
  const identity = identityDomain(p, inputs.identities ?? {});
  const accountOrder = accountAndOrderDomains(p, inputs.chains ?? {});
  const continuation = continuationDomain(p, inputs.continuation ?? {});
  const finance = financeDomain(p, inputs.finance ?? {}, continuation);
  const skinsMedia = skinsAndMediaDomains(p, inputs.skins ?? {}, inputs.media ?? {});
  const occupancy = occupancyDomain(accountOrder.account.items, accountOrder.order.items, continuation);

  for (const account of accountOrder.account.items) {
    const media = skinsMedia.media.items.filter((item) => item.accountKey === account.legacyId);
    account.rentableGate.media = media.length === 0 ? "UNREAD" : media.every((item) => item.status === "READY") ? "READY" : "BLOCKED";
    const occ = occupancy.items.find((item) => item.accountId === account.accountId);
    account.rentableGate.targetOccupancy = occ?.expected ?? "UNREAD";
  }

  const allItems = [
    ...identity.items,
    ...accountOrder.account.items,
    ...accountOrder.order.items,
    ...occupancy.items,
    ...continuation.items,
    ...skinsMedia.skins.items,
    ...skinsMedia.media.items,
    ...finance.history,
    ...finance.openings,
    ...finance.liabilities.items,
    ...finance.commissions.items,
  ];
  const totals = { sourceItems: allItems.length, statusCounts: countStatuses(allItems), writeAllowed: false, writerCalls: 0, networkAttempts: 0 };
  const plan = {
    schema: "legacy-rehearsal-plan.v1",
    generatedAt: new Date().toISOString(),
    mode: "PLAN_ONLY",
    sourceCommit: manifest.sourceCommit,
    manifestPath: loaded.manifestPath,
    manifestSha256: loaded.manifestSha256,
    inputHashes: loaded.inputHashes,
    cutoff: manifest.cutoff,
    source: manifest.source,
    target: {
      ...manifest.target,
      databaseOid: manifest.target.databaseOid,
      fixtureDatabaseOid: manifest.target?.fixtureDatabaseOid ?? null,
      fixtureDatabaseOidNote: "SYNTHETIC_PLACEHOLDER_NOT_A_RESOURCE",
      bound: manifest.target.bound === true,
      oidSource: manifest.target.bound === true ? "EXPLICIT_READBACK_BINDING_NOT_WRITE_AUTHORITY" : "NOT_BOUND_IN_PLAN",
    },
    approval: manifest.approval,
    fieldProtocol: manifest.fieldProtocol,
    domainOrder: manifest.domainOrder,
    apiDist,
    modules: moduleHashes(apiDist, manifest),
    domains: {
      identity,
      account: accountOrder.account,
      order: accountOrder.order,
      occupancy,
      growth_credit: { status: "NOT_RUN", counts: countStatuses([]), items: [], reason: "OUT_OF_SCOPE_THIS_PACKAGE", nextRequest: "NEXT-READ-GROWTH-CREDIT", writeAllowed: false },
      continuation,
      skins: skinsMedia.skins,
      media: skinsMedia.media,
      finance,
    },
    totals,
    pendingContracts: manifest.pendingContracts ?? [],
    missingEvidenceSeeds: manifest.missingEvidenceSeeds ?? [],
    writeAllowed: false,
    networkAllowed: false,
    writerCalls: 0,
  };
  plan.io = { ...io, note: "fileWrites excludes this plan write" };
  for (const [name, domain] of Object.entries(plan.domains)) {
    const hasOpen = (domain.items ?? []).some((item) => ["MISSING_FACT", "CONFLICT", "ISOLATED"].includes(item.status));
    domain.nextRequest = domain.nextRequest ?? (hasOpen ? nextReadFor(name) : null);
    for (const item of domain.items ?? []) {
      item.nextRequest = ["MISSING_FACT", "CONFLICT", "ISOLATED"].includes(item.status) ? nextReadFor(name) : null;
    }
  }
  plan.nextRequestRef = "NEXT-REHEARSAL-READ-01";
  plan.nextRequestFile = "next-request.json";
  return plan;
}

function requiredEvidenceFor(reason) {
  if (!reason) return "source corroboration";
  if (reason.includes("CURRENT_TARGET_UNREAD") || reason.includes("TARGET_READ_REQUIRED")) return "exact target current read for the bound actor/resource (orders, duties, admissions, idempotency records)";
  if (reason.includes("TARGET_OCCUPANCY_UNREAD")) return "target occupancy read for the account (OCCUPIED/UNKNOWN/FREE) plus the source in-flight order keys";
  if (reason.includes("CURRENT_PARENT_TARGET_MISSING")) return "target legacy_order_read_snapshot for the mapped order";
  if (reason.includes("BENEFICIARY_IDENTITY_UNVERIFIED") || reason.includes("PARTY_IDENTITY")) return "verified beneficiary/party identity mapping from la_user to target user";
  if (reason.includes("TARGET_COMPLETED_AT_UNBOUND") || reason.includes("COMPLETED_TIME")) return "target completedAt plus original confirm_time in Unix seconds";
  if (reason.includes("ORIGINAL_KEY_RECEIPT_MISSING")) return "original actor/key/body idempotency receipt";
  if (reason.includes("MEDIA_REVIEW_PENDING")) return "target media review decision (APPROVED/REJECTED) with reviewer and audit evidence";
  if (reason.includes("MEDIA_REVIEW_REJECTED")) return "a new reviewed source asset; do not overwrite the rejected original";
  if (reason.includes("MEDIA") || reason.includes("SKIN")) return "source media object SHA plus target media asset review/visibility and skin binding";
  if (reason.includes("ACCOUNT_HOLDING_UNREAD")) return "reviewed four-column skin holding for the account";
  if (reason.includes("SOURCE_AMBIGUOUS")) return "reviewed legacy dictionary source tuple for the held token; keep SOURCE_AMBIGUOUS until an explicit reviewed rule replaces it";
  if (reason.startsWith("UNOBSERVED:")) return `the missing four-column skin extract field (${reason.slice("UNOBSERVED:".length)})`;
  if (reason.includes("MOBILE_DUPLICATE")) return "source mobile ownership/canonical phone review; keep the smallest source id winner and isolate the other row";
  if (reason.includes("ACCOUNT_OWNER_MISMATCH")) return "source la_rental_accounts.user_id versus owner evidence; corrected mapping or isolation";
  if (reason.includes("ACCOUNT_STATUS_NOT_PUBLIC")) return "source status/is_delete evidence plus the target visibility decision";
  if (reason.includes("UPSTREAM_NOT_READY")) return "upstream identity/account plan must be READY before this row";
  if (reason.includes("DEPOSIT_AMOUNT_UNPROVEN")) return "original deposit_amount and target deposit cents";
  if (reason.includes("REFUND_AMOUNT_UNPROVEN") || reason.includes("ORIGINAL_DETAIN")) return "original return_order_money and detain_money columns";
  if (reason.includes("ECONOMIC_SOURCE_REVIEW_INCOMPLETE")) return "explicit reviewed economic source set and log bindings";
  if (reason.includes("SOURCE_RELATION_UNRESOLVED")) return "explicit source relation / economic root";
  return "source corroboration for the exact reason code";
}

function nextReadFor(domain) {
  switch (domain) {
    case "identity": return "NEXT-READ-IDENTITY";
    case "account":
    case "occupancy": return "NEXT-READ-ACCOUNT-OCCUPANCY";
    case "order": return "NEXT-READ-OLD-ORDER";
    case "continuation": return "NEXT-READ-CONTINUATION-CURRENT";
    case "finance": return "NEXT-READ-FIN-SOURCE";
    case "media":
    case "skins": return "NEXT-READ-MEDIA-SKIN";
    default: return "NEXT-READ-GROWTH-CREDIT";
  }
}

function buildMissingEvidence(plan, manifest) {
  const rows = [];
  const domains = plan.domains ?? {};
  for (const [domain, value] of Object.entries(domains)) {
    const items = domain === "finance" ? [...(value.history ?? []), ...(value.openings ?? []), ...(value.liabilities?.items ?? []), ...(value.commissions?.items ?? [])] : value?.items ?? [];
    for (const item of items) {
      if (!["MISSING_FACT", "CONFLICT", "ISOLATED"].includes(item.status)) continue;
      const reasons = [...new Set([...(item.reasons ?? []), ...(item.reason ? [item.reason] : [])].filter(Boolean))];
      rows.push({
        domain,
        sourceKey: item.sourceKey ?? item.openingId ?? item.mediaId ?? null,
        sourceKind: item.sourceKind ?? item.group ?? null,
        sourceId: sourceIdOf(item.sourceKey),
        state: "UNKNOWN",
        value: null,
        notZero: true,
        reasons,
        requiredEvidence: [...new Set(reasons.map(requiredEvidenceFor))],
        nextRead: nextReadFor(domain),
      });
    }
  }
  for (const seed of manifest?.missingEvidenceSeeds ?? plan.missingEvidenceSeeds ?? []) {
    rows.push({ ...seed, state: "UNKNOWN", value: null, notZero: true, nextRead: seed.nextRead ?? nextReadFor(seed.domain) });
  }
  const counts = { total: rows.length, unknown: rows.length, byDomain: {}, byNextRead: {} };
  for (const row of rows) {
    counts.byDomain[row.domain] = (counts.byDomain[row.domain] ?? 0) + 1;
    counts.byNextRead[row.nextRead] = (counts.byNextRead[row.nextRead] ?? 0) + 1;
  }
  return { schema: "legacy-missing-evidence.v1", generatedAt: new Date().toISOString(), sourceCommit: plan.sourceCommit, rows, counts };
}

function planMarkdown(plan) {
  const lines = [
    "# Legacy rehearsal plan (PLAN_ONLY)",
    "",
    `- source commit: \`${plan.sourceCommit}\``,
    `- manifest: \`${plan.manifestSha256}\``,
    `- cutoff: \`${plan.cutoff}\``,
    `- approval: \`${plan.approval?.approved}\`; claim: \`${plan.approval?.claim}\`; target OID: \`${plan.target?.databaseOid}\``,
    `- writeAllowed: \`${plan.writeAllowed}\`; networkAllowed: \`${plan.networkAllowed}\`; writerCalls: \`${plan.writerCalls}\``,
    `- io: reads=\`${plan.io.fileReads}\`, writes=\`${plan.io.fileWrites}\`, network=\`${plan.io.networkAttempts}\`, db=\`${plan.io.dbConnects}\`, writer=\`${plan.io.writerCalls}\``,
    "",
    "## Domains",
    "",
    "| domain | status | READY | REPLAY_ONLY | MISSING_FACT | CONFLICT | ISOLATED |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const [name, domain] of Object.entries(plan.domains)) {
    const counts = domain.counts ?? {};
    lines.push(`| ${name} | ${domain.status} | ${counts.READY ?? 0} | ${counts.REPLAY_ONLY ?? 0} | ${counts.MISSING_FACT ?? 0} | ${counts.CONFLICT ?? 0} | ${counts.ISOLATED ?? 0} |`);
  }
  lines.push("", "## Rentable gate", "", "No account is marked rentable by this plan. Source readiness is separate from target quote, owner acceptance, media and occupancy.", "");
  for (const account of plan.domains.account.items) {
    lines.push(`- \`${account.sourceKey}\`: sourceReady=\`${account.rentableGate.sourceAccountReady}\`, snapshotReady=\`${account.rentableGate.sourceSnapshotReady}\`, publicCandidate=\`${account.rentableGate.sourceStatusPublicCandidate}\`, media=\`${account.rentableGate.media}\`, targetOccupancy=\`${account.rentableGate.targetOccupancy}\`, rentable=\`${account.rentableGate.rentable}\``);
  }
  lines.push("", "## Original keys and isolation", "");
  for (const [name, domain] of Object.entries(plan.domains)) {
    for (const item of domain.items ?? []) {
      if (!["CONFLICT", "ISOLATED", "MISSING_FACT"].includes(item.status)) continue;
      const key = item.originalKeys?.idempotencyKey ?? item.originalKeys?.accountId ?? item.sourceKey ?? item.openingId ?? item.mediaId;
      lines.push(`- \`${name}\` \`${key}\`: \`${item.status}\` ${JSON.stringify(item.reasons ?? item.reason ?? [])} next=\`${item.nextRequest ?? "NONE"}\``);
    }
  }
  return lines.join("\n");
}

function compareDomain(name, sourceItems, targetItems, options) {
  const source = sourceItems ?? [];
  const target = targetItems ?? [];
  const keyOf = options.key;
  const sourceMap = new Map();
  const targetMap = new Map();
  const duplicateSourceKeys = [];
  const duplicateTargetKeys = [];
  for (const item of source) {
    const key = keyOf(item);
    if (sourceMap.has(key)) duplicateSourceKeys.push(key);
    else sourceMap.set(key, item);
  }
  for (const item of target) {
    const key = keyOf(item);
    if (targetMap.has(key)) duplicateTargetKeys.push(key);
    else targetMap.set(key, item);
  }
  const items = [];
  const counts = { source: source.length, target: target.length, matched: 0, sourceOnly: 0, targetOnly: 0, changed: 0, unknown: 0, isolated: 0, duplicateSourceKeys: duplicateSourceKeys.length, duplicateTargetKeys: duplicateTargetKeys.length };
  for (const item of source) {
    const key = keyOf(item);
    const other = targetMap.get(key);
    if (!other) {
      if (["ISOLATED", "CONFLICT", "MISSING_FACT"].includes(item.status)) {
        counts.isolated += 1;
        items.push({ key, state: "isolated_or_unknown", sourceStatus: item.status, reasons: item.reasons ?? (item.reason ? [item.reason] : []) });
      } else {
        counts.sourceOnly += 1;
        items.push({ key, state: "source_only", sourceStatus: item.status, source: options.brief ? options.brief(item) : item });
      }
      continue;
    }
    const changes = options.compare(item, other);
    if (changes.length === 0) {
      counts.matched += 1;
      items.push({ key, state: "matched" });
    } else {
      const unknownOnly = changes.every((change) => change.unknown === true);
      if (unknownOnly) {
        counts.unknown += 1;
        items.push({ key, state: "unknown", changes });
      } else {
        counts.changed += 1;
        items.push({ key, state: "changed", changes });
      }
    }
  }
  for (const item of target) {
    const key = keyOf(item);
    if (!sourceMap.has(key)) {
      counts.targetOnly += 1;
      items.push({ key, state: "target_only", target: options.brief ? options.brief(item) : item });
    }
  }
  const conserved = counts.sourceOnly === 0 && counts.targetOnly === 0 && counts.changed === 0 && counts.duplicateSourceKeys === 0 && counts.duplicateTargetKeys === 0;
  return { domain: name, status: conserved ? "PASS" : "FAIL", conserved, counts, items };
}

function valueChange(field, sourceValue, targetValue) {
  const sourceUnknown = sourceValue === null || sourceValue === undefined || sourceValue === "UNKNOWN";
  const targetUnknown = targetValue === null || targetValue === undefined || targetValue === "UNKNOWN";
  if (sourceUnknown && targetUnknown) return null;
  if (sourceUnknown && targetValue === "0") return { field, source: sourceValue, target: targetValue, reason: "UNKNOWN_FILLED_ZERO" };
  if (String(sourceValue) !== String(targetValue)) return { field, source: sourceValue, target: targetValue, reason: "VALUE_CHANGED" };
  return null;
}

function compareReconcile(plan, target) {
  if (!target || target.schema !== "legacy-target-readback.v1") fail("TARGET_READBACK_SCHEMA_INVALID");
  if (plan?.schema !== "legacy-rehearsal-plan.v1" || target.sourceManifestSha256 !== plan.manifestSha256 || target.sourceCommit !== plan.sourceCommit || typeof target.fixtureOnly !== "boolean") fail("TARGET_SOURCE_BINDING_MISMATCH");
  if (!target.fixtureOnly && (!plan.target?.bound || plan.target.engine !== "postgresql" || target.target?.databaseOid !== plan.target.databaseOid || target.target?.databaseNameRef !== plan.target.databaseNameRef || !target.target?.readRef || !Number.isFinite(Date.parse(target.target?.readAt)))) fail("TARGET_RESOURCE_UNBOUND");
  const required = ["identities", "accounts", "orders", "duties", "openings", "observations", "media", "occupancy", "registers", "holdings", "continuations"];
  const missingDomains = required.filter((name) => !Array.isArray(target[name]));
  if (missingDomains.length) fail("TARGET_DOMAIN_MISSING", { missingDomains });

  const domains = {};
  domains.identities = compareDomain(
    "identities",
    plan.domains.identity.items,
    target.identities,
    {
      key: (item) => item.legacyId ?? item.userId,
      compare: (source, other) => [
        valueChange("userId", source.userId, other.userId),
        valueChange("sourceDigest", source.sourceDigest, other.sourceDigest),
        valueChange("accountStatus", source.projected?.accountStatus ?? null, other.accountStatus ?? null),
        valueChange("identityStatus", source.projected?.identityStatus ?? null, other.identityStatus ?? null),
      ].filter(Boolean),
      brief: (item) => ({ userId: item.userId, legacyId: item.legacyId, sourceDigest: item.sourceDigest }),
    },
  );
  domains.accounts = compareDomain(
    "accounts",
    plan.domains.account.items,
    target.accounts,
    {
      key: (item) => item.legacyId,
      compare: (source, other) => {
        const changes = [
          valueChange("accountId", source.accountId, other.accountId),
          valueChange("ownerUserId", source.ownerUserId, other.ownerUserId),
          valueChange("gameId", source.gameId, other.gameId),
          valueChange("sourceDigest", source.originalKeys?.accountSourceDigest ?? null, other.sourceDigest ?? null),
        ].filter(Boolean);
        if (other.rentable === true) {
          if (source.rentableGate.rentable !== true) changes.push({ field: "rentable", source: false, target: true, reason: "RENTABLE_WITHOUT_QUOTE_ACCEPTANCE_OR_FREE_OCCUPANCY" });
        }
        return changes;
      },
      brief: (item) => ({ accountId: item.accountId, legacyId: item.legacyId, ownerUserId: item.ownerUserId, gameId: item.gameId }),
    },
  );
  domains.orders = compareDomain(
    "orders",
    plan.domains.order.items,
    target.orders,
    {
      key: (item) => item.legacyId,
      compare: (source, other) => [
        valueChange("orderId", source.orderId, other.orderId),
        valueChange("ownerUserId", source.ownerUserId, other.ownerUserId),
        valueChange("renterUserId", source.renterUserId, other.renterUserId),
        valueChange("accountId", source.accountId, other.accountId),
        valueChange("sourceDigest", source.sourceDigest, other.sourceDigest),
        valueChange("sourceStatus", source.sourceStatus, other.sourceStatus),
        valueChange("originalOrderNo", source.originalOrderNo, other.originalOrderNo),
        valueChange("currency", "CNY", other.currency),
        valueChange("paidCents", source.paidCents, other.paidCents),
        valueChange("dueCents", source.dueCents, other.dueCents),
        valueChange("depositCents", source.depositCents, other.depositCents),
        valueChange("refundCents", source.refundCents, other.refundCents),
        valueChange("refundChannelState", source.refundChannelState, other.refundChannelState),
      ].filter(Boolean),
      brief: (item) => ({ orderId: item.orderId, legacyId: item.legacyId, paidCents: item.paidCents, dueCents: item.dueCents }),
    },
  );
  domains.duties = compareDomain(
    "duties",
    plan.domains.finance.duties,
    target.duties,
    {
      key: (item) => item.dutyId ?? item.id,
      compare: (source, other) => [
        valueChange("orderId", source.orderId, other.orderId),
        valueChange("currency", "CNY", other.currency),
        valueChange("kind", source.kind, other.kind),
        valueChange("sourceRecordId", source.sourceRecordId, other.sourceRecordId),
        valueChange("amountCents", source.amountCents, other.amountCents),
        valueChange("status", source.status, other.status),
        valueChange("counterpartyUserId", source.beneficiaryUserId, other.counterpartyUserId),
        valueChange("settledBy", source.settledBy, other.settledBy),
        valueChange("maturityAt", source.maturityAt ?? null, other.maturityAt ?? null),
        source.admissionId ? valueChange("admissionId", source.admissionId, other.admissionId) : null,
      ].filter(Boolean),
      brief: (item) => ({ dutyId: item.dutyId ?? item.id, orderId: item.orderId, amountCents: item.amountCents }),
    },
  );
  domains.openings = compareDomain(
    "openings",
    plan.domains.finance.openings.filter((item) => item.status === "READY"),
    target.openings,
    {
      key: (item) => item.userId,
      compare: (source, other) => [
        valueChange("userId", source.userId, other.userId),
        valueChange("legacyUserId", source.legacyUserId, other.legacyUserId),
        valueChange("currency", "CNY", other.currency),
        valueChange("availableCents", source.availableCents, other.availableCents),
        valueChange("coveredCount", source.coveredCount, other.coveredCount),
        valueChange("coveredDigest", source.coveredDigest, other.coveredDigest),
        valueChange("sourceDigest", source.sourceDigest, other.sourceDigest),
      ].filter(Boolean),
      brief: (item) => ({ openingId: item.openingId, availableCents: item.availableCents, coveredCount: item.coveredCount }),
    },
  );
  domains.observations = compareDomain(
    "observations",
    plan.domains.finance.history.flatMap((item) => item.observations ?? []),
    target.observations,
    {
      key: (item) => item.sourceKey,
      compare: (source, other) => [valueChange("sourceDigest", source.sourceDigest, other.sourceDigest)].filter(Boolean),
      brief: (item) => ({ sourceKey: item.sourceKey, sourceDigest: item.sourceDigest }),
    },
  );
  domains.media = compareDomain(
    "media",
    plan.domains.media.items,
    target.media,
    {
      key: (item) => item.mediaId,
      compare: (source, other) => {
        const changes = [
          valueChange("accountKey", source.accountKey, other.accountKey),
          valueChange("sourceRef", source.sourceRef, other.sourceRef),
          valueChange("reviewState", source.reviewState, other.reviewState),
          valueChange("visibility", source.visibility, other.visibility),
          valueChange("storageKey", source.storageKey, other.storageKey),
          valueChange("sha256", source.sha256, other.sha256),
          valueChange("skinId", source.skinId, other.skinId),
        ].filter(Boolean);
        if (source.reviewState === "REJECTED" && other.reviewState === "APPROVED") changes.push({ field: "reviewState", source: source.reviewState, target: other.reviewState, reason: "REJECTED_MEDIA_APPROVED" });
        if (source.visibility === "PRIVATE" && other.visibility === "PUBLIC_DISPLAY" && source.reviewState !== "APPROVED") changes.push({ field: "visibility", source: source.visibility, target: other.visibility, reason: "PRIVATE_MEDIA_PUBLIC_WITHOUT_APPROVAL" });
        return changes;
      },
      brief: (item) => ({ mediaId: item.mediaId, sha256: item.sha256, skinId: item.skinId }),
    },
  );
  domains.occupancy = compareDomain(
    "occupancy",
    plan.domains.occupancy.items,
    target.occupancy,
    {
      key: (item) => item.accountId,
      compare: (source, other) => {
        const targetState = other.state;
        if (source.expected === "FREE_CANDIDATE") return targetState === "FREE" || targetState === "UNKNOWN" || targetState === "OCCUPIED" ? [] : [{ field: "state", source: source.expected, target: targetState, reason: "OCCUPANCY_STATE_INVALID" }];
        if (targetState === "FREE") return [{ field: "state", source: source.expected, target: targetState, reason: "OCCUPANCY_FREED_WITH_INFLIGHT_OR_ISOLATED" }];
        if (targetState === "OCCUPIED" || targetState === "UNKNOWN") return [];
        return [{ field: "state", source: source.expected, target: targetState, reason: "OCCUPANCY_STATE_INVALID" }];
      },
      brief: (item) => ({ accountId: item.accountId, expected: item.expected }),
    },
  );
  domains.registers = compareDomain(
    "registers",
    plan.domains.continuation.items.filter((item) => item.command?.kind === "INFLIGHT_REGISTER").map((item) => ({ ...item, registerId: item.command.binding?.legacyId ?? item.legacyId, accountId: item.command.binding?.accountId, ownerUserId: item.command.binding?.ownerUserId, renterUserId: item.command.binding?.renterUserId, disposition: item.command.binding?.disposition })),
    target.registers,
    {
      key: (item) => item.registerId,
      compare: (source, other) => [
        valueChange("accountId", source.accountId, other.accountId),
        valueChange("ownerUserId", source.ownerUserId, other.ownerUserId),
        valueChange("renterUserId", source.renterUserId, other.renterUserId),
        valueChange("disposition", source.disposition, other.disposition),
      ].filter(Boolean),
      brief: (item) => ({ registerId: item.registerId, accountId: item.accountId, disposition: item.disposition }),
    },
  );

  domains.holdings = compareDomain("holdings", plan.domains.skins.items, target.holdings, {
    key: item => item.accountKey,
    compare: (source, other) => [valueChange("gameId", source.gameId, other.gameId), valueChange("digest", source.digest, other.digest), valueChange("catalogRevision", source.catalogRevision, other.catalogRevision), valueChange("mappedSkinIds", stable([...source.mappedSkinIds].sort()), stable([...(other.mappedSkinIds ?? [])].sort()))].filter(Boolean),
  });
  domains.continuations = compareDomain("continuations", plan.domains.continuation.items.filter(item => item.command?.kind !== "INFLIGHT_REGISTER"), target.continuations, {
    key: item => item.orderId,
    compare: (source, other) => [valueChange("factsDigest", source.prepared?.factsDigest, other.factsDigest), valueChange("sourceAsOf", source.prepared?.sourceAsOf, other.sourceAsOf), valueChange("idempotencyKey", source.originalKeys?.idempotencyKey, other.idempotencyKey), valueChange("fingerprint", source.originalKeys?.fingerprint, other.fingerprint)].filter(Boolean),
  });
  const dutyEconomicKeys = new Map();
  for (const duty of target.duties) {
    const key = `${duty.orderId}|${duty.kind}|${duty.sourceRecordId}`;
    dutyEconomicKeys.set(key, (dutyEconomicKeys.get(key) ?? 0) + 1);
  }
  const duplicateEconomicRoots = [...dutyEconomicKeys].filter(([, count]) => count > 1).map(([key]) => key);
  const cents = value => typeof value === "string" && /^(0|[1-9]\d{0,23})$/.test(value) ? BigInt(value) : null;
  const sum = (items, field) => {
    let total = 0n;
    for (const item of items) { const value = cents(item[field]); if (value === null) return null; total += value; }
    return total.toString();
  };
  const sumBy = (items, groupField, amountField) => {
    const groups = {};
    for (const item of items) { const key = String(item[groupField] ?? "UNKNOWN"), value = cents(item[amountField]); groups[key] = value === null || groups[key] === null ? null : (BigInt(groups[key] ?? "0") + value).toString(); }
    return groups;
  };

  const sourceDuties = plan.domains.finance.duties;
  const sourceOpenings = plan.domains.finance.openings.filter((item) => item.status === "READY");
  const sourceOrders = plan.domains.order.items.filter((item) => ["READY", "REPLAY_ONLY"].includes(item.status));
  const dutySourceCents = sum(sourceDuties, "amountCents");
  const dutyTargetCents = sum(target.duties, "amountCents");
  const openingSourceCents = sum(sourceOpenings, "availableCents");
  const openingTargetCents = sum(target.openings, "availableCents");
  const orderAmounts = {};
  for (const field of ["paidCents", "dueCents", "depositCents", "refundCents"]) {
    const source = sum(sourceOrders, field);
    const targetValue = sum(target.orders, field);
    orderAmounts[field] = { source, target: targetValue, conserved: source !== null && targetValue !== null && source === targetValue };
  }
  const occupancyExpected = {};
  for (const item of plan.domains.occupancy.items) occupancyExpected[item.expected] = (occupancyExpected[item.expected] ?? 0) + 1;
  const occupancyTarget = {};
  for (const item of target.occupancy) occupancyTarget[item.state] = (occupancyTarget[item.state] ?? 0) + 1;
  const conservation = {
    duties: { sourceCents: dutySourceCents, targetCents: dutyTargetCents, conserved: dutySourceCents !== null && dutyTargetCents !== null && dutySourceCents === dutyTargetCents, sourceByKind: sumBy(sourceDuties, "kind", "amountCents"), targetByKind: sumBy(target.duties, "kind", "amountCents") },
    openings: { sourceCents: openingSourceCents, targetCents: openingTargetCents, conserved: openingSourceCents !== null && openingTargetCents !== null && openingSourceCents === openingTargetCents },
    orders: orderAmounts,
    occupancy: {
      expected: occupancyExpected,
      target: occupancyTarget,
      freedWithInflight: (domains.occupancy?.items ?? []).filter((item) => (item.changes ?? []).some((change) => change.reason === "OCCUPANCY_FREED_WITH_INFLIGHT_OR_ISOLATED")).length,
    },
    media: { source: plan.domains.media.items.length, target: target.media.length, conserved: plan.domains.media.items.length === target.media.length },
  };
  const amountConserved = conservation.duties.conserved && conservation.openings.conserved && Object.values(orderAmounts).every((item) => item.conserved) && conservation.media.conserved;
  const summary = { sourceItems: 0, targetItems: 0, matched: 0, sourceOnly: 0, targetOnly: 0, changed: 0, unknown: 0, isolated: 0, duplicateSourceKeys: 0, duplicateTargetKeys: 0, duplicateEconomicRoots: duplicateEconomicRoots.length };
  for (const domain of Object.values(domains)) {
    summary.sourceItems += domain.counts.source;
    summary.targetItems += domain.counts.target;
    for (const key of ["matched", "sourceOnly", "targetOnly", "changed", "unknown", "isolated", "duplicateSourceKeys", "duplicateTargetKeys"]) summary[key] += domain.counts[key];
  }
  summary.conserved = Object.values(domains).every((domain) => domain.conserved) && duplicateEconomicRoots.length === 0 && amountConserved;
  summary.amountConserved = amountConserved;
  summary.duplicateEconomicRootsList = duplicateEconomicRoots;
  return {
    schema: "legacy-source-target-reconciliation.v1",
    generatedAt: new Date().toISOString(),
    sourceCommit: plan.sourceCommit,
    fixtureOnly: target.fixtureOnly,
    evidenceLevel: target.fixtureOnly ? "SYNTHETIC_FORMAT_ONLY" : "TARGET_EXPORT_REQUIRES_ROOT_RECEIPT_REVIEW",
    planManifestSha256: plan.manifestSha256,
    target: { readRef: target.target?.readRef ?? null, databaseOid: target.target?.databaseOid ?? null, databaseNameRef: target.target?.databaseNameRef ?? null, readAt: target.target?.readAt ?? null },
    domains,
    conservation,
    summary,
    writeAllowed: false,
    note: "target readback is an explicit input; missing domains are not treated as an empty pass",
  };
}

function reconcileMarkdown(result) {
  const lines = [
    "# Source-target reconciliation",
    "",
    `- source commit: \`${result.sourceCommit}\``,
    `- target read: \`${result.target.readRef}\` (OID: \`${result.target.databaseOid}\`, name: \`${result.target.databaseNameRef}\`)`,
    `- conserved: \`${result.summary.conserved}\``,
    `- source/target items: \`${result.summary.sourceItems}\` / \`${result.summary.targetItems}\``,
    `- matched: \`${result.summary.matched}\`; source-only: \`${result.summary.sourceOnly}\`; target-only: \`${result.summary.targetOnly}\`; changed: \`${result.summary.changed}\`; unknown: \`${result.summary.unknown}\`; isolated: \`${result.summary.isolated}\``,
    `- duplicate economic roots: \`${result.summary.duplicateEconomicRoots}\``,
    "",
    "| domain | status | source | target | matched | source-only | target-only | changed | unknown | isolated |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const domain of Object.values(result.domains)) {
    const counts = domain.counts;
    lines.push(`| ${domain.domain} | ${domain.status} | ${counts.source} | ${counts.target} | ${counts.matched} | ${counts.sourceOnly} | ${counts.targetOnly} | ${counts.changed} | ${counts.unknown} | ${counts.isolated} |`);
  }
  lines.push("", "## Responsibility conservation", "");
  lines.push(`- duties: source=\`${result.conservation?.duties?.sourceCents}\` target=\`${result.conservation?.duties?.targetCents}\` conserved=\`${result.conservation?.duties?.conserved}\``);
  lines.push(`- openings: source=\`${result.conservation?.openings?.sourceCents}\` target=\`${result.conservation?.openings?.targetCents}\` conserved=\`${result.conservation?.openings?.conserved}\``);
  for (const [field, value] of Object.entries(result.conservation?.orders ?? {})) lines.push(`- orders.${field}: source=\`${value.source}\` target=\`${value.target}\` conserved=\`${value.conserved}\``);
  lines.push(`- occupancy expected/target: \`${JSON.stringify(result.conservation?.occupancy?.expected)}\` / \`${JSON.stringify(result.conservation?.occupancy?.target)}\`; freed-with-inflight=\`${result.conservation?.occupancy?.freedWithInflight}\``);
  lines.push(`- amountConserved: \`${result.summary.amountConserved}\``);
  lines.push("", "## Non-matching items", "");
  let shown = 0;
  for (const domain of Object.values(result.domains)) {
    for (const item of domain.items) {
      if (item.state === "matched") continue;
      shown += 1;
      lines.push(`- \`${domain.domain}\` \`${item.key}\`: \`${item.state}\` ${JSON.stringify(item.changes ?? item.reasons ?? [])}`);
    }
  }
  if (shown === 0) lines.push("None.");
  return lines.join("\n");
}

function commandPlan(args) {
  const manifest = args.manifest ?? DEFAULT_MANIFEST;
  const outDir = args.out ?? join(DEFAULT_OUT, "plan");
  const plan = buildPlan({ manifest, apiDist: args["api-dist"], allowOtherSource: args.allowOtherSource });
  plan.io = { ...io, note: "fileWrites excludes this plan write" };
  const planPath = writeJson(outDir, "plan.json", redact(plan));
  writeText(outDir, "plan-summary.md", planMarkdown(plan));
  const missing = buildMissingEvidence(plan, readManifestSeeds(manifest, plan.manifestSha256));
  writeJson(outDir, "missing-evidence.json", missing);
  writeText(outDir, "missing-evidence.md", missingEvidenceMarkdown(missing));
  console.log(JSON.stringify({ command: "plan", ok: true, plan: planPath, writeAllowed: false, io: plan.io, totals: plan.totals }, null, 2));
}

function readManifestSeeds(manifestPath, expectedSha256) {
  const read = readJson(manifestPath, "manifest-seeds");
  if (read.sha256 !== expectedSha256) fail("MANIFEST_PLAN_MISMATCH");
  return read.value;
}

function missingEvidenceMarkdown(missing) {
  const lines = [
    "# Missing evidence / UNKNOWN ledger",
    "",
    `- source commit: \`${missing.sourceCommit}\``,
    `- rows: \`${missing.counts.total}\``,
    "- Every row is UNKNOWN with value null. It is never filled with 0.",
    "",
    "| domain | source key | reason | required evidence | next read |",
    "|---|---|---|---|---|",
  ];
  for (const row of missing.rows) {
    lines.push(`| ${row.domain ?? ""} | \`${row.sourceKey ?? row.sourceKind ?? ""}\` | ${(row.reasons ?? []).join(", ")} | ${(row.requiredEvidence ?? []).join("; ")} | ${row.nextRead} |`);
  }
  return lines.join("\n");
}

function commandReconcile(args) {
  if (!args.plan) fail("CLI_ARGUMENT_MISSING", { key: "plan" });
  if (!args.target) fail("CLI_ARGUMENT_MISSING", { key: "target" });
  const planRead = readJson(resolve(args.plan), "plan");
  const targetRead = readJson(resolve(args.target), "target");
  const result = compareReconcile(planRead.value, targetRead.value);
  result.planSha256 = planRead.sha256;
  result.targetSha256 = targetRead.sha256;
  result.io = { ...io, note: "fileWrites excludes this reconciliation write" };
  const outDir = args.out ?? join(DEFAULT_OUT, "reconcile");
  const resultPath = writeJson(outDir, "reconcile.json", result);
  writeText(outDir, "reconcile-summary.md", reconcileMarkdown(result));
  console.log(JSON.stringify({ command: "reconcile", ok: result.summary.conserved, reconcile: resultPath, summary: result.summary, io: result.io }, null, 2));
  if (!result.summary.conserved) process.exitCode = 2;
}

function commandMissingEvidence(args) {
  if (!args.plan) fail("CLI_ARGUMENT_MISSING", { key: "plan" });
  const planRead = readJson(resolve(args.plan), "plan");
  const seeds = args.manifest ? readManifestSeeds(resolve(args.manifest), planRead.value.manifestSha256) : null;
  const missing = buildMissingEvidence(planRead.value, seeds);
  const outDir = args.out ?? join(DEFAULT_OUT, "missing-evidence");
  const path = writeJson(outDir, "missing-evidence.json", missing);
  writeText(outDir, "missing-evidence.md", missingEvidenceMarkdown(missing));
  console.log(JSON.stringify({ command: "missing-evidence", ok: true, missing: path, counts: missing.counts, io }, null, 2));
}

function domainReadiness(plan, name) {
  const domain = plan.domains?.[name];
  if (!domain || domain.status === "NOT_RUN") return "NOT_RUN";
  const counts = domain?.counts ?? {};
  if (domain.status === "BLOCKED" || (counts.CONFLICT ?? 0) > 0) return "BLOCKED_CONFLICT";
  if ((counts.MISSING_FACT ?? 0) > 0) return "BLOCKED_MISSING_FACT";
  if ((counts.ISOLATED ?? 0) > 0) return "ISOLATED_ROWS_RETAINED";
  return "PLAN_READY";
}

function commandReadiness(args) {
  if (!args.plan) fail("CLI_ARGUMENT_MISSING", { key: "plan" });
  if (!args.reconcile) fail("CLI_ARGUMENT_MISSING", { key: "reconcile" });
  const planRead = readJson(resolve(args.plan), "plan");
  const reconcileRead = readJson(resolve(args.reconcile), "reconcile");
  const plan = planRead.value;
  const reconcile = reconcileRead.value;
  if (reconcile.planSha256 !== planRead.sha256 || reconcile.planManifestSha256 !== plan.manifestSha256) fail("RECONCILIATION_PLAN_MISMATCH");
  const missing = buildMissingEvidence(plan, args.manifest ? readManifestSeeds(resolve(args.manifest), plan.manifestSha256) : null);
  const readiness = {
    schema: "legacy-rehearsal-readiness.v1",
    generatedAt: new Date().toISOString(),
    sourceCommit: plan.sourceCommit,
    manifestSha256: plan.manifestSha256,
    planSha256: planRead.sha256,
    reconcileSha256: reconcileRead.sha256,
    approved: false,
    claim: null,
    targetDatabaseOid: null,
    targetResourceOid: null,
    node: process.version,
    modules: plan.modules,
    domains: {
      identity: domainReadiness(plan, "identity"),
      accountSource: domainReadiness(plan, "account"),
      accountRentable: "BLOCKED_TARGET_FACTS",
      order: domainReadiness(plan, "order"),
      occupancy: "BLOCKED_TARGET_FACTS",
      continuation: domainReadiness(plan, "continuation"),
      finance: domainReadiness(plan, "finance"),
      skins: domainReadiness(plan, "skins"),
      media: domainReadiness(plan, "media"),
      growth_credit: "NOT_RUN",
      sourceTargetConservation: reconcile.summary?.conserved ? reconcile.fixtureOnly ? "FIXTURE_PASS" : "EXPORT_CONSERVED_PENDING_REVIEW" : "FAIL",
    },
    blockers: [
      ...missing.rows.slice(0, 200).map((row) => ({ domain: row.domain, sourceKey: row.sourceKey ?? row.sourceKind ?? null, reasons: row.reasons ?? [], nextRead: row.nextRead })),
      ...(reconcile.summary?.conserved ? [] : [{ domain: "source-target", sourceKey: "reconcile", reasons: ["RECONCILIATION_NOT_CONSERVED"], nextRead: "NEXT-READ-TARGET" }]),
    ],
    counts: { missingEvidence: missing.counts.total, reconciliation: reconcile.summary },
    pendingContracts: plan.pendingContracts ?? [],
    nextRequest: "next-request.json",
    note: "PLAN_READY is not target execution approval. approved=false and no OID/claim is bound.",
  };
  const outDir = args.out ?? join(DEFAULT_OUT, "readiness");
  const path = writeJson(outDir, "rehearsal-readiness.json", readiness);
  console.log(JSON.stringify({ command: "readiness", ok: true, readiness: path, domains: readiness.domains, io }, null, 2));
}

function commandApply() {
  console.log(JSON.stringify({ command: "apply", ok: false, code: "APPLY_NOT_AUTHORIZED", message: "This package is PLAN_ONLY. It does not call writers or open MySQL/PostgreSQL. A separate Root-approved execution window is required." }, null, 2));
  process.exitCode = 4;
}

function runChild(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: HERE, encoding: "utf8", env: { ...process.env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

function commandSelftest(args) {
  const outDir = resolve(args.out ?? join(DEFAULT_OUT, "selftest"));
  mkdirSync(outDir, { recursive: true });
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  const manifest = args.manifest ?? DEFAULT_MANIFEST;
  const apiArgs = args["api-dist"] ? ["--api-dist", args["api-dist"]] : [];
  const planDir = join(outDir, "plan");
  const planRun = runChild(["plan", "--manifest", manifest, "--out", planDir, ...apiArgs]);
  add("plan-exit-0", planRun.status === 0, { status: planRun.status, stderr: planRun.stderr.slice(0, 800) });
  const planOutput = parseJsonOutput(planRun.stdout);
  add("plan-json", Boolean(planOutput?.ok), planOutput);
  const aliasRun = runChild(["--plan", "--out", join(outDir, "plan-alias"), ...apiArgs]);
  add("plan-flag-alias", aliasRun.status === 0 && parseJsonOutput(aliasRun.stdout)?.command === "plan", { status: aliasRun.status, stderr: aliasRun.stderr.slice(0, 500) });
  const plan = planOutput ? readJson(resolve(planDir, "plan.json"), "selftest-plan").value : null;
  if (plan) {
    add("plan-zero-network", plan.io.networkAttempts === 0 && plan.io.dbConnects === 0, plan.io);
    add("plan-zero-writer", plan.writerCalls === 0 && plan.io.writerCalls === 0, { writerCalls: plan.writerCalls, io: plan.io });
    add("plan-no-rentable", plan.domains.account.items.every((item) => item.rentableGate.rentable === false), plan.domains.account.items.map((item) => item.rentableGate));
    add("plan-continuation-counts", plan.domains.continuation.counts.READY >= 3 && plan.domains.continuation.counts.CONFLICT === 0, plan.domains.continuation.counts);
    add("plan-liability-counts", plan.domains.finance.liabilities.counts.ADMISSION_CANDIDATE >= 2 && plan.domains.finance.liabilities.counts.LEGACY_TERMINAL >= 1 && plan.domains.finance.liabilities.counts.OBSERVE_ONLY >= 1, plan.domains.finance.liabilities.counts);
    add("plan-commission-counts", plan.domains.finance.commissions.counts.ADMISSION_CANDIDATE >= 1 && plan.domains.finance.commissions.counts.OBSERVE_ONLY >= 2, plan.domains.finance.commissions.counts);
    add("plan-opening-not-flow-sum", plan.domains.finance.openings.every((item) => item.flowSum === "NOT_COMPUTED"), plan.domains.finance.openings.map((item) => item.flowSum));
    add("plan-media-sha-preserved", plan.domains.media.items.every((item) => item.sha256 && /^[a-f0-9]{64}$/.test(item.sha256)), plan.domains.media.items.map((item) => item.sha256));
    add("plan-original-keys", plan.domains.continuation.items.filter((item) => item.status === "READY").every((item) => item.command?.kind === "INFLIGHT_REGISTER" ? Boolean(item.command.bodySha256 && item.command.binding?.legacyId) : Boolean(item.originalKeys?.idempotencyKey)), plan.domains.continuation.items.map((item) => item.originalKeys));
    const dutyById = new Map(plan.domains.finance.duties.map((item) => [item.dutyId, item]));
    const liabilityByKey = new Map(plan.domains.finance.liabilities.items.map((item) => [item.sourceKey, item]));
    add("plan-liability-amounts", liabilityByKey.get("la_order:101")?.effect?.amountCents === "8200" && liabilityByKey.get("la_order:201")?.effect?.amountCents === "8200" && liabilityByKey.get("la_order:301")?.effect?.amountCents === "5700" && liabilityByKey.get("la_order:301")?.effect?.status === "SETTLED" && liabilityByKey.get("la_order:401")?.effect === null, [...liabilityByKey.values()].map((item) => ({ key: item.sourceKey, effect: item.effect })));
    const commission = plan.domains.finance.commissions.items.find((item) => item.sourceKey === "la_distribution_order:91");
    add("plan-commission-amount-maturity", commission?.effect?.amountCents === "1000" && commission?.effect?.status === "PENDING" && commission?.effect?.maturityAt === "2026-10-08T01:02:03.000000Z", commission?.effect ?? null);
    const continuationDuty = plan.domains.finance.duties.find((item) => item.kind === "COMMISSION" && item.orderId === plan.domains.continuation.items[0]?.orderId);
    add("plan-continuation-duty", continuationDuty?.amountCents === "100" && continuationDuty?.status === "PENDING" && continuationDuty?.beneficiaryUserId?.startsWith("user_"), continuationDuty ?? null);
    add("plan-opening-amounts", plan.domains.finance.openings.find((item) => item.openingId === "OPENING-FIN-01")?.availableCents === "110" && plan.domains.finance.openings.find((item) => item.openingId === "OPENING-FIN-01")?.coveredCount === 2 && plan.domains.finance.duplicateOpeningSubjects.length === 0, plan.domains.finance.openings.map((item) => ({ caseLabel: item.openingId, cents: item.availableCents, covered: item.coveredCount })));
    add("plan-occupancy-conservative", plan.domains.occupancy.items.filter((item) => ["50000", "50001", "50002"].includes(item.legacyId)).every((item) => item.expected === "OCCUPIED_OR_UNKNOWN") && plan.domains.occupancy.items.find((item) => item.legacyId === "50003")?.expected === "UNKNOWN", plan.domains.occupancy.items.map((item) => ({ legacyId: item.legacyId, expected: item.expected })));
    add("plan-next-requests", Object.values(plan.domains).flatMap((domain) => domain.items ?? []).filter((item) => ["MISSING_FACT", "CONFLICT", "ISOLATED"].includes(item.status)).every((item) => typeof item.nextRequest === "string" && item.nextRequest.startsWith("NEXT-READ-")), Object.values(plan.domains).flatMap((domain) => domain.items ?? []).filter((item) => ["MISSING_FACT", "CONFLICT", "ISOLATED"].includes(item.status)).map((item) => ({ key: item.sourceKey, next: item.nextRequest })));
  }

  const positiveDir = join(outDir, "reconcile-positive");
  const positiveRun = runChild(["reconcile", "--plan", join(planDir, "plan.json"), "--target", join(HERE, "fixtures", "target-readback.positive.json"), "--out", positiveDir]);
  const positive = positiveRun.status === 0 ? readJson(resolve(positiveDir, "reconcile.json"), "selftest-positive").value : null;
  add("reconcile-positive-exit-0", positiveRun.status === 0, { status: positiveRun.status, stderr: positiveRun.stderr.slice(0, 800) });
  add("reconcile-positive-conserved", positive?.summary?.conserved === true, positive?.summary ?? null);
  add("reconcile-positive-amounts", positive?.summary?.amountConserved === true && positive?.conservation?.duties?.sourceCents === positive?.conservation?.duties?.targetCents && positive?.conservation?.openings?.sourceCents === positive?.conservation?.openings?.targetCents, positive?.conservation ?? null);

  const negativeDir = join(outDir, "reconcile-negative");
  const negativeRun = runChild(["reconcile", "--plan", join(planDir, "plan.json"), "--target", join(HERE, "fixtures", "target-readback.negative.json"), "--out", negativeDir]);
  const negative = readJson(resolve(negativeDir, "reconcile.json"), "selftest-negative").value;
  add("reconcile-negative-exit-2", negativeRun.status === 2, { status: negativeRun.status, stderr: negativeRun.stderr.slice(0, 800) });
  add("reconcile-negative-changed", negative?.summary?.changed >= 3, negative?.summary ?? null);
  add("reconcile-negative-target-only", negative?.summary?.targetOnly >= 1, negative?.summary ?? null);
  add("reconcile-negative-occupancy", negative?.domains?.occupancy?.counts?.changed >= 1, negative?.domains?.occupancy?.counts ?? null);
  add("reconcile-negative-media", negative?.domains?.media?.counts?.changed >= 1, negative?.domains?.media?.counts ?? null);
  add("reconcile-negative-unknown-zero", Object.values(negative?.domains ?? {}).some((domain) => (domain.items ?? []).some((item) => (item.changes ?? []).some((change) => change.reason === "UNKNOWN_FILLED_ZERO"))), Object.values(negative?.domains ?? {}).flatMap((domain) => (domain.items ?? []).flatMap((item) => item.changes ?? [])).filter((change) => change.reason === "UNKNOWN_FILLED_ZERO"));
  add("reconcile-negative-rentable-gate", Object.values(negative?.domains ?? {}).some((domain) => (domain.items ?? []).some((item) => (item.changes ?? []).some((change) => change.reason === "RENTABLE_WITHOUT_QUOTE_ACCEPTANCE_OR_FREE_OCCUPANCY"))), Object.values(negative?.domains ?? {}).flatMap((domain) => (domain.items ?? []).flatMap((item) => item.changes ?? [])).filter((change) => change.reason === "RENTABLE_WITHOUT_QUOTE_ACCEPTANCE_OR_FREE_OCCUPANCY"));

  const missingDir = join(outDir, "missing-evidence");
  const missingRun = runChild(["missing-evidence", "--plan", join(planDir, "plan.json"), "--manifest", manifest, "--out", missingDir]);
  add("missing-evidence-exit-0", missingRun.status === 0, { status: missingRun.status });
  const missing = missingRun.status === 0 ? readJson(resolve(missingDir, "missing-evidence.json"), "selftest-missing").value : null;
  add("missing-evidence-unknown-not-zero", missing?.rows?.every((row) => row.state === "UNKNOWN" && row.value === null && row.notZero === true), missing?.counts ?? null);

  const readinessDir = join(outDir, "readiness");
  const readinessRun = runChild(["readiness", "--plan", join(planDir, "plan.json"), "--reconcile", join(positiveDir, "reconcile.json"), "--manifest", manifest, "--out", readinessDir]);
  add("readiness-exit-0", readinessRun.status === 0, { status: readinessRun.status, stderr: readinessRun.stderr.slice(0, 800) });
  const readiness = readinessRun.status === 0 ? readJson(resolve(readinessDir, "rehearsal-readiness.json"), "selftest-readiness").value : null;
  add("readiness-unapproved", readiness?.approved === false && readiness?.claim === null && readiness?.targetDatabaseOid === null, readiness ? { approved: readiness.approved, claim: readiness.claim, targetDatabaseOid: readiness.targetDatabaseOid } : null);

  const badManifestPath = join(outDir, "bad-manifest.json");
  const originalManifest = readJson(manifest, "selftest-manifest").value;
  const badManifest = JSON.parse(JSON.stringify(originalManifest));
  for (const spec of Object.values(badManifest.inputs)) spec.path = resolve(dirname(resolve(manifest)), spec.path);
  badManifest.inputs.identities.sha256 = "0".repeat(64);
  writeJson(outDir, "bad-manifest.json", badManifest);
  const badRun = runChild(["plan", "--manifest", badManifestPath, "--out", join(outDir, "bad-plan")]);
  add("bad-input-sha-rejected", badRun.status === 3 && badRun.stderr.includes("INPUT_SHA_MISMATCH"), { status: badRun.status, stderr: badRun.stderr.slice(0, 500) });

  const applyRun = runChild(["apply"]);
  add("apply-rejected", applyRun.status === 4 && applyRun.stdout.includes("APPLY_NOT_AUTHORIZED"), { status: applyRun.status });

  const guardCode = [
    "import {installOfflineGuard} from './lib/offline-guard.mjs';",
    "import net from 'node:net';",
    "const io={networkAttempts:0,dbConnects:0,writerCalls:0};installOfflineGuard(io);",
    "try{net.connect({port:1});console.log('NO_GUARD');}catch(e){console.log(e.code);}",
  ].join("\n");
  const guardRun = spawnSync(process.execPath, ["--input-type=module", "-e", guardCode], { cwd: HERE, encoding: "utf8" });
  add("network-guard-denied", guardRun.stdout.trim() === "OFFLINE_GUARD", { stdout: guardRun.stdout.trim(), stderr: guardRun.stderr.slice(0, 300) });

  const passed = checks.every((check) => check.passed);
  const result = { schema: "legacy-rehearsal-selftest.v1", generatedAt: new Date().toISOString(), sourceCommit: FIXED_COMMIT, passed, checks };
  const path = writeJson(outDir, "selftest.json", result);
  console.log(JSON.stringify({ command: "selftest", ok: passed, selftest: path, checks, io }, null, 2));
  if (!passed) process.exitCode = 1;
}

function usage() {
  console.log(`Legacy rehearsal CLI (offline, PLAN_ONLY)

Usage:
  node legacy-rehearsal.mjs [plan] [--plan] [--manifest <file>] [--out <dir>] [--api-dist <dir>]
  node legacy-rehearsal.mjs reconcile --plan <plan.json> --target <target-readback.json> [--out <dir>]
  node legacy-rehearsal.mjs missing-evidence --plan <plan.json> [--manifest <file>] [--out <dir>]
  node legacy-rehearsal.mjs readiness --plan <plan.json> --reconcile <reconcile.json> [--manifest <file>] [--out <dir>]
  node legacy-rehearsal.mjs selftest [--manifest <file>] [--out <dir>]
  node legacy-rehearsal.mjs apply        # always rejected: PLAN_ONLY

Default command is plan. No command opens MySQL/PostgreSQL, performs HTTP, or calls a writer.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.planFlag && args._[0] && args._[0] !== "plan") fail("CLI_CONFLICTING_COMMANDS", { command: args._[0] });
  const command = args._[0] ?? "plan";
  if (command === "plan") return commandPlan(args);
  if (command === "reconcile") return commandReconcile(args);
  if (command === "missing-evidence") return commandMissingEvidence(args);
  if (command === "readiness") return commandReadiness(args);
  if (command === "selftest") return commandSelftest(args);
  if (command === "apply") return commandApply(args);
  fail("CLI_COMMAND_UNKNOWN", { command });
}

try {
  main();
} catch (error) {
  const code = error?.code ?? "UNEXPECTED";
  const detail = error?.detail ?? (error instanceof Error ? error.message : String(error));
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exitCode = code === "APPLY_NOT_AUTHORIZED" ? 4 : 3;
}
