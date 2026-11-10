import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { planLegacyIdentitySource, sourceUserPlanningRow, sourceContactPlanningRow, sourceAccountPlan, sourceOrderPlan, sourceFinanceObservation, readSourceRows as rows } from "./local-source-adapter.mjs";
import { prepareLocalStoredOpening } from "./local-opening-proof.mjs";

const args = process.argv.slice(2), option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--execute") || args.includes("--apply")) throw new Error("PREPARATION_ONLY_NO_TARGET_WRITER");
if (!args.includes("--prepare")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--prepare", "--dataset", "--dataset-sha", "--api-dist", "--out"], connections: 0, credentialFileReads: 0, targetWrites: 0 }));
  process.exit(0);
}
if (process.version !== "v24.20.0") throw new Error("NODE_BASELINE_MISMATCH");
const require = createRequire(import.meta.url), root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataset = resolve(option("--dataset") ?? ""), out = resolve(option("--out") ?? "");
if (![dataset, out].every(p => p.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")) || existsSync(out)) throw new Error("NEW_PRIVATE_APPEND_PACKAGE_REQUIRED");
const sha = value => createHash("sha256").update(value).digest("hex"), bytes = readFileSync(join(dataset, "manifest.json"));
if (sha(bytes) !== option("--dataset-sha")) throw new Error("ACCEPTED_SOURCE_MANIFEST_CHANGED");
const original = JSON.parse(bytes), receiptBytes = readFileSync(join(original.source, "receipt.json"));
if (sha(receiptBytes) !== original.sourceReceiptSha256) throw new Error("FROZEN_SOURCE_RECEIPT_CHANGED");
const receipt = JSON.parse(receiptBytes);
if (receipt.status !== "CAPTURED_READ_ONLY" || !receipt.rollbackConfirmed || !receipt.clientClosed) throw new Error("UNCONFIRMED_FROZEN_SOURCE");
async function checked(dir, entry) { if (!entry || entry.file !== basename(entry.file)) throw new Error("BOUND_INPUT_PATH_INVALID"); const path = join(dir, entry.file), h = createHash("sha256"); for await (const bytes of createReadStream(path)) h.update(bytes); if (h.digest("hex") !== entry.sha256) throw new Error("BOUND_INPUT_BYTES_CHANGED"); return path; }
for (const entry of Object.values(receipt.files)) await checked(original.source, entry);
for (const entry of Object.values(original.files)) await checked(dataset, entry);
const api = resolve(option("--api-dist") ?? join(root, "apps/api/dist/src")), mod = name => require(join(api, name + ".js"));
const modules = { planner: mod("legacy-load/user-order-offline-plan"), contentHash: mod("supply/content-hash"), orderRead: mod("order/legacy-order-read"),
  migration: mod("supply/legacy-user-migration"), phone: mod("auth/phone-number"), finance: mod("finance/legacy-finance-source-preparation"), money: mod("finance/personal-finance-read"), identity: mod("auth/identity-subject"), identityProfile: mod("auth/legacy-identity-profile") };
if (typeof modules.planner.planLegacyUserContactBatch !== "function") throw new Error("CONTACT_AWARE_BUILD_REQUIRED");
const sid = /S-1-5-[0-9-]+/.exec(spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout)?.[0];
if (!sid) throw new Error("SID_REQUIRED");
mkdirSync(out); if (spawnSync("icacls", [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true }).status !== 0) throw new Error("OUTPUT_ACL_FAILED");
const files = {}, emit = (name, data) => { const value = Buffer.from(data.map(row => JSON.stringify(row)).join("\n") + (data.length ? "\n" : "")); writeFileSync(join(out, name + ".jsonl"), value, { flag: "wx" }); files[name] = { file: name + ".jsonl", rows: data.length, bytes: value.length, sha256: sha(value) }; };
const users = new Map(), accounts = new Map(), orders = new Map(), admittedUsers = new Map(), admittedAccounts = new Map(), excluded = new Set(), excludedAccounts = new Set(), excludedOrders = new Set();
for await (const row of rows(join(dataset, original.files.quarantine.file))) { if (row.domain === "users") excluded.add(row.sourceId); if (row.domain === "accounts") excludedAccounts.add(row.sourceId); if (row.domain === "orders") excludedOrders.add(row.sourceId); }
for await (const row of rows(join(dataset, original.files.users.file))) admittedUsers.set(row.sourceId, { userId: row.userId, sourceDigest: row.sourceDigest });
for await (const row of rows(join(dataset, original.files.accounts.file))) admittedAccounts.set(row.sourceId, row);
const phoneGroups = new Map();
for await (const row of rows(join(original.source, receipt.files.users.file))) { users.set(row.id, row); const p = modules.phone.normalizeMainlandPhone(row.mobile); if (p) { const group = phoneGroups.get(p) ?? []; group.push(row.id); phoneGroups.set(p, group); } }
for await (const row of rows(join(original.source, receipt.files.accounts.file))) accounts.set(row.id, row);
for await (const row of rows(join(original.source, receipt.files.orders.file))) orders.set(row.id, row);
const family = new Set(excluded);
for (const id of excluded) { const source = users.get(id); if (!source) throw new Error("GENUINE_SOURCE_USER_MISSING_DO_NOT_CREATE_SHADOW"); const p = modules.phone.normalizeMainlandPhone(source.mobile); for (const member of p ? phoneGroups.get(p) : []) family.add(member); }
const cancelledOnly = new Set([...users.values()].filter(row => row.is_delete === "1" && !family.has(row.id)).map(row => row.id));
const sourceRef = original.sourceRef, contactPlan = modules.planner.planLegacyUserContactBatch([...family, ...cancelledOnly].map(id => sourceUserPlanningRow(users.get(id), modules, sourceRef)));
if (contactPlan.isolated) throw new Error("CONTACT_SUBJECT_SOURCE_STILL_INVALID");
const planned = new Map(contactPlan.results.filter(r => r.disposition === "PARAMETER_READY").map(r => [r.writerInput.evidence.legacyId, r]));
const newUsers = [], corrections = [], cancelledCorrections = [], recovery = [], balances = [];
for (const [id, plan] of planned) {
  const e = plan.writerInput.evidence, p = e.contactProjection;
  if (excluded.has(id)) {
    const raw = users.get(id);
    let trustedIdentityNumber = null;
    if (e.status.realNameBound && typeof raw.id_card === "string" && raw.id_card.trim()) {
      try { trustedIdentityNumber = modules.identity.normalizeIdentityDocument(raw.id_card); } catch { }
    }
    const identity = original.identityProfiles ? planLegacyIdentitySource(raw, e.status.realNameBound, modules) : null;
    if (identity?.state === "INVALID") throw new Error("LEGACY_IDENTITY_SOURCE_INCOMPLETE");
    newUsers.push({ sourceId: id, userId: plan.userId, sourceDigest: e.sourceDigest, input: plan.writerInput,
      trustedIdentityNumber, ...(identity ? { legacyIdentityProfile: identity.legacyIdentityProfile } : {}), operation: "supply.legacy.owner-migrate", idempotencyKey: modules.migration.legacyOwnerMigrationKey(e), targetExistence: "UNREAD_REQUIRES_ABSENCE_OR_EXACT_REPLAY" });
    balances.push({ sourceId: id, userId: plan.userId, sourceDigest: e.sourceDigest, source: { id: raw.id, earnings: raw.earnings, money: raw.money },
      amounts: { earnings: modules.money.sourceYuanToCents(raw.earnings), money: modules.money.sourceSignedYuanToCents(raw.money) } });
    let reason = e.status.deleted ? "SOURCE_CANCELLED_LOGIN_DISABLED" : e.status.disabled ? "SOURCE_FROZEN_LOGIN_DISABLED" : e.legacyPassword ? "LEGACY_NUMBER_PASSWORD_ENDPOINT_REQUIRED"
      : p.decision === "UNIQUE_NON_CANCELLED" ? "NO_SOURCE_PASSWORD_REQUIRES_LEGAL_PHONE_RECOVERY" : "NO_SOURCE_PASSWORD_AND_NO_UNIQUE_PHONE_REQUIRES_INDEPENDENT_RECOVERY";
    recovery.push({ sourceId: id, userId: plan.userId, reason, sourceStoredEarningsCents: balances.at(-1).amounts.earnings,
      legacyCredentialPresent: e.legacyPassword !== null, sourceState: plan.projected.accountStatus, authenticationPhonePlanned: p.authenticationPhone !== null });
  } else {
    if (!admittedUsers.has(id)) throw new Error("SOURCE_FAMILY_HAS_UNACCOUNTED_EXISTING_SUBJECT");
    if (cancelledOnly.has(id) && (p.decision !== "CANCELLED" || p.authenticationPhone !== null || !e.status.deleted)) throw new Error("CANCELLED_CONTACT_MUST_ONLY_UNBIND");
    (cancelledOnly.has(id) ? cancelledCorrections : corrections).push({ sourceId: id, userId: plan.userId, input: { ...plan.writerInput, expectedTargetDigest: null },
      operation: "supply.legacy.contact-projection", idempotencyKey: modules.migration.legacyOwnerContactCorrectionKey(e),
      requiredFreshBinding: "readLegacyOwnerContactTarget + exact digest after source/role/actor checks; cannot execute with null digest",
      intendedChange: { authenticationPhoneBound: p.authenticationPhone !== null, decision: p.decision, sourceState: plan.projected.accountStatus, username: p.sourceSn },
      immutable: ["source UID", "status", "legacy credential", "identity/age fact", "orders", "wallet", "old receipt"] });
  }
}
emit("users", newUsers); emit("contact-corrections", corrections); emit("cancelled-contact-corrections", cancelledCorrections); emit("login-recovery", recovery); emit("stored-balances", balances);
const numbers = [], sourceNumbers = new Set();
for (const [id, raw] of users) {
  if (typeof raw.sn !== "string" || !raw.sn.length || raw.sn.length > 128 || /[\x00-\x1f\x7f]/.test(raw.sn) || sourceNumbers.has(raw.sn)) throw new Error("EXACT_SOURCE_PUBLIC_NUMBER_NOT_UNIQUE");
  sourceNumbers.add(raw.sn);
  if (family.has(id) || cancelledOnly.has(id)) continue;
  const target = admittedUsers.get(id);
  if (!target) throw new Error("PUBLIC_NUMBER_SUBJECT_NOT_ACCOUNTED");
  const sourceDigest = sha(modules.contentHash.canonicalize(raw));
  if (sourceDigest !== target.sourceDigest) throw new Error("PUBLIC_NUMBER_FROZEN_SOURCE_DRIFT");
  const input = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_user", legacyId: id, sourceDigest, sourceSn: raw.sn, expectedTargetDigest: null };
  numbers.push({ sourceId: id, userId: target.userId, input, requiredFreshBinding: "exact current target digest; username only; phone/state/credential/money unchanged" });
}
emit("public-number-bindings", numbers);
const allContacts = mod("legacy-load/legacy-contact-projection").planLegacyContactProjections([...users.values()].map(row => sourceContactPlanningRow(row, modules, sourceRef)));
const authentication = [...allContacts].map(([id, p]) => {
  const raw = users.get(id);
  return { sourceId: id, userId: modules.migration.legacyOwnerUserId("legacy_mysql_restore", "la_user", id), sourceDigest: sha(modules.contentHash.canonicalize(raw)),
    sourceSn: p.sourceSn, authenticationPhone: p.authenticationPhone, decision: p.decision,
    accountStatus: raw.is_delete === "1" ? "CANCELLED" : raw.is_disable === "1" ? "FROZEN" : "ACTIVE" };
});
emit("authentication-projections", authentication);
const virtualUsers = new Map(admittedUsers); for (const row of newUsers) virtualUsers.set(row.sourceId, { userId: row.userId, sourceDigest: row.sourceDigest });
const virtualAccounts = new Map(admittedAccounts), accountAppend = [], orderAppend = [];
for (const id of excludedAccounts) { const raw = accounts.get(id); if (!raw) throw new Error("GENUINE_SOURCE_ACCOUNT_MISSING"); const plan = sourceAccountPlan(raw, virtualUsers, modules, sourceRef, new Map(Object.entries(original.gameBindings))); if (!plan.ready) throw new Error("ACCOUNT_DEPENDENCY_STILL_MISSING"); accountAppend.push(plan); virtualAccounts.set(id, plan); }
for (const id of excludedOrders) { const raw = orders.get(id); if (!raw) throw new Error("GENUINE_SOURCE_ORDER_MISSING"); const plan = sourceOrderPlan(raw, virtualUsers, virtualAccounts, modules, sourceRef); if (!plan.ready) throw new Error("ORDER_DEPENDENCY_STILL_MISSING"); orderAppend.push(plan); }
emit("accounts", accountAppend); emit("orders", orderAppend);
const continuation = []; for await (const row of rows(join(dataset, original.files.continuations.file))) if (excludedOrders.has(row.sourceId)) continuation.push({ ...row, targetParent: "PENDING_APPEND_AND_EXACT_READBACK" }); emit("continuations", continuation);
const observations = [], logs = new Map(), withdrawals = new Map(), distributions = new Map();
for (const domain of ["earnings", "withdraws", "distributionOrders"]) for await (const row of rows(join(original.source, receipt.files[domain].file))) {
  if (domain === "earnings") { const group = logs.get(row.user_id) ?? []; group.push(row); logs.set(row.user_id, group); }
  if (domain === "withdraws") withdrawals.set(row.id, row);
  if (domain === "distributionOrders") distributions.set(row.id, row);
  if (!excluded.has(row.user_id)) continue;
  const subject = virtualUsers.get(row.user_id), observed = sourceFinanceObservation(domain, row);
  const preview = modules.finance.previewFrozenFinanceObservation(observed.kind, observed.row, { userId: subject.userId, legacyUserId: row.user_id });
  observations.push({ domain, ...observed, userId: subject.userId, identityDigest: subject.sourceDigest, sourceDigest: preview.sourceDigest, sourceEventAt: preview.sourceEventAt, financialSource: preview.financialSource });
}
emit("finance-observations", observations);
const openingModules = { preparation: modules.finance, proof: mod("finance/legacy-finance-source-evidence"), canonical: modules.contentHash.canonicalize };
const openings = balances.map(balance => prepareLocalStoredOpening(balance, { modules: openingModules, logs, orders, withdraws: withdrawals, distributions,
  cutoff: original.sourceCutoff, inputSha256: files["stored-balances"].sha256, sourceExtractSha256: original.sourceReceiptSha256 }));
emit("stored-opening-reviews", openings);
const sourceTotal = balances.reduce((sum, row) => sum + BigInt(row.amounts.earnings), 0n), admittedTotal = openings.filter(r => r.state === "CANDIDATE").reduce((sum, row) => sum + BigInt(row.input.proof.availableCents), 0n);
const reasons = {}; for (const row of recovery) { const entry = reasons[row.reason] ?? { subjects: 0, sourceStoredEarningsCents: 0n }; entry.subjects++; entry.sourceStoredEarningsCents += BigInt(row.sourceStoredEarningsCents); reasons[row.reason] = entry; }
const report = { format: "zzsh.legacy-contact-append-plan.v1", status: "SOURCE_CLOSED_PENDING_ROOT_REVIEW_AND_FRESH_TARGET_CAS", sourceDatasetSha256: sha(bytes), sourceReceiptSha256: original.sourceReceiptSha256,
  ...(original.identityProfiles ? { identityProfiles: { schema: "zzsh.legacy-identity-profile-source.v1", verified: newUsers.filter(row => row.input.evidence.status.realNameBound).length, ready: newUsers.filter(row => row.legacyIdentityProfile).length, invalid: 0 } } : {}),
  source: original.source, sourceRef: original.sourceRef, gameBindings: original.gameBindings, sourceOrigin: original.sourceOrigin,
  sourceCutoff: original.sourceCutoff, apiDist: api, codeEntrySha256: sha(readFileSync(fileURLToPath(import.meta.url))), files,
  counts: { sourceFamily: family.size, additionalCancelledContactCorrections: cancelledCorrections.length, appendUsers: newUsers.length, existingContactCorrections: corrections.length, accounts: accountAppend.length, orders: orderAppend.length, continuationEvidence: continuation.length,
    publicNumberOnlyBindings: numbers.length, sourcePublicNumbers: sourceNumbers.size, exactAuthenticationReadbackSubjects: authentication.length,
    financeObservations: observations.length, openingCandidates: openings.filter(r => r.state === "CANDIDATE").length, openingReviewRequired: openings.filter(r => r.state !== "CANDIDATE").length },
  sourceAvailableCents: sourceTotal.toString(), proofCandidateAvailableCents: admittedTotal.toString(), flowSum: "NOT_COMPUTED", sourceMoneyNotAdded: true,
  loginRecovery: Object.fromEntries(Object.entries(reasons).map(([key, value]) => [key, { subjects: value.subjects, sourceStoredEarningsCents: value.sourceStoredEarningsCents.toString() }])),
  rules: { nonCancelledIncludesFrozen: true, cancelledContactNotAuthentication: true, ambiguousGroupsNoWinner: true, missingPhoneNotMissingSubject: true, noInventedPasswordOrAdult: true, contactOnlyCurrentProofCannotBeOverwritten: true },
  execution: { writeAllowed: false, targetOid: null, targetNonce: null, currentActor: "UNBOUND", contactCorrectionCas: "UNBOUND", sourcePlanReview: "PENDING_ROOT", sequence: ["fresh target/actor/source checks", "contact-correction CAS", "54 subject imports", "29 account observations", "96 original order snapshots", "31545 continuation", "missing original observations", "reviewed original stored openings", "source-target readback"],
    unknown: "stop and recover original operation/key/body; never change financial keys or retry COMMIT unknown", oldAcceptedReceipts: "immutable originals retained; correction/append is separately accepted" },
  connections: 0, credentialFileReads: 0, frozenSensitiveSourceRead: true, targetWrites: 0 };
writeFileSync(join(out, "manifest.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: report.status, counts: report.counts, sourceAvailableCents: report.sourceAvailableCents, proofCandidateAvailableCents: report.proofCandidateAvailableCents, loginRecovery: report.loginRecovery, connections: 0, credentialFileReads: 0, targetWrites: 0, manifestSha256: sha(readFileSync(join(out, "manifest.json"))) }));
