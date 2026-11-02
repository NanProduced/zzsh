import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFinancialDomains } from "./local-target-finance.mjs";
import { applyOpeningDomain } from "./local-target-opening.mjs";
import { applyDisplayDomain } from "./local-target-display.mjs";
import { applyHoldingDomain } from "./local-target-holdings.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Capture exact CAS bodies once; replay never replaces a pending body's expected state. */
async function freezeCas(ctx, domain, fileDomain) {
  const directory = join(ctx.output, "phases"); if (!existsSync(directory)) mkdirSync(directory);
  const file = join(directory, domain + ".json"), prior = ctx.state.generatedPhases?.[domain];
  if (prior) {
    const bytes = readFileSync(file);
    if (sha(bytes) !== prior.sha256) throw new Error("CONTACT_APPEND_FROZEN_CAS_CHANGED");
    return JSON.parse(bytes);
  }
  if (ctx.state.phases[domain]?.nextIndex || existsSync(file)) throw new Error("CONTACT_APPEND_CAS_RECEIPT_UNKNOWN");
  const writer = ctx.mod("supply/legacy-user-migration"), result = [];
  let batch = [];
  async function capture() {
    if (!batch.length) return;
    const targets = new Map((await writer.readLegacyOwnerContactTargets(ctx.client, batch.map(row => row.userId), ctx.actor)).map(row => [row.id, row]));
    for (const row of batch) {
      const current = targets.get(row.userId);
      if (!current || current.migrationSourceDigest !== (row.input.evidence?.sourceDigest ?? row.input.sourceDigest)) throw new Error("CONTACT_APPEND_SOURCE_TARGET_NOT_BOUND");
      result.push({ ...row, input: { ...row.input, expectedTargetDigest: writer.legacyOwnerContactTargetDigest(current) } });
    }
    batch = [];
  }
  await ctx.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    for await (const row of ctx.readRows(ctx.domainFile(fileDomain))) { batch.push(row); if (batch.length === 1000) await capture(); }
    await capture();
    await ctx.client.query("ROLLBACK");
  } catch (error) { await ctx.client.query("ROLLBACK"); throw error; }
  const bytes = Buffer.from(JSON.stringify(result));
  writeFileSync(file, bytes, { flag: "wx" });
  ctx.state.generatedPhases ??= {};
  ctx.state.generatedPhases[domain] = { file, rows: result.length, sha256: sha(bytes), sourceFileSha256: ctx.manifest.files[fileDomain].sha256 };
  ctx.save();
  return result;
}

export async function applyNumberBindings(ctx) {
  const rows = await freezeCas(ctx, "publicNumberBindings", "public-number-bindings");
  await ctx.runItems("publicNumberBindings", rows, row => ctx.mod("supply/legacy-user-migration").bindLegacyOwnerNumber(ctx.client, row.input, ctx.actor));
  if (ctx.state.phases.publicNumberBindings.quarantined) throw new Error("PUBLIC_NUMBER_BINDINGS_NOT_COMPLETE");
  let compared = 0;
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const group = rows.slice(offset, offset + 1000), current = new Map((await ctx.mod("supply/legacy-user-migration").readLegacyOwnerContactTargets(ctx.client, group.map(row => row.userId), ctx.actor)).map(row => [row.id, row]));
    for (const row of group) {
      const target = current.get(row.userId);
      if (!target || target.username !== row.input.sourceSn || target.displayUsername !== row.input.sourceSn || target.migrationSourceDigest !== row.input.sourceDigest || target.migrationLegacyId !== row.sourceId) throw new Error("PUBLIC_NUMBER_EXACT_READBACK_FAILED");
      compared++;
    }
  }
  ctx.state.publicNumberReconciliation = { compared, sourceSubjects: ctx.manifest.counts.publicNumberOnlyBindings, authenticationPhoneUnchanged: true };
  ctx.save();
  await verifyFullContactProjection(ctx);
}

/** Full-source final readback includes the unchanged legacy population, not only corrected samples. */
export async function verifyFullContactProjection(ctx) {
  let batch = [], compared = 0;
  const decisionCounts = {}, mismatches = [];
  async function compare() {
    if (!batch.length) return;
    const current = new Map((await ctx.mod("supply/legacy-user-migration").readLegacyOwnerContactTargets(ctx.client, batch.map(row => row.userId), ctx.actor)).map(row => [row.id, row]));
    for (const row of batch) {
      const actual = current.get(row.userId);
      if (!actual || actual.username !== row.sourceSn || actual.displayUsername !== row.sourceSn || actual.phoneNumber !== row.authenticationPhone
        || actual.accountStatus !== row.accountStatus || actual.migrationSourceDigest !== row.sourceDigest || actual.migrationLegacyId !== row.sourceId) mismatches.push({ sourceId: row.sourceId, reason: "FULL_CONTACT_PROJECTION_DIFFERED" });
      compared++; decisionCounts[row.decision] = (decisionCounts[row.decision] ?? 0) + 1;
    }
    batch = [];
  }
  await ctx.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    for await (const row of ctx.readRows(ctx.domainFile("authentication-projections"))) { batch.push(row); if (batch.length === 1000) await compare(); }
    await compare();
    await ctx.client.query("ROLLBACK");
  } catch (error) { await ctx.client.query("ROLLBACK"); throw error; }
  ctx.state.fullAuthenticationReconciliation = { compared, expected: ctx.manifest.counts.exactAuthenticationReadbackSubjects, decisionCounts, mismatches };
  ctx.save();
  if (mismatches.length || compared !== ctx.manifest.counts.exactAuthenticationReadbackSubjects) throw new Error("FULL_CONTACT_PROJECTION_READBACK_FAILED");
}

export async function applyCancelledContactCorrections(ctx) {
  const rows = await freezeCas(ctx, "cancelledContactCorrections", "cancelled-contact-corrections");
  await ctx.runItems("cancelledContactCorrections", rows, row => {
    if (!row.input.evidence.status.deleted || row.input.evidence.contactProjection.authenticationPhone !== null || row.input.evidence.contactProjection.decision !== "CANCELLED") throw new Error("CANCELLED_CONTACT_MUST_ONLY_UNBIND");
    return ctx.mod("supply/legacy-user-migration").reconcileLegacyOwnerContactProjection(ctx.client, row.input, ctx.actor);
  });
  if (ctx.state.phases.cancelledContactCorrections.quarantined) throw new Error("CANCELLED_CONTACT_CORRECTIONS_NOT_COMPLETE");
}

/** Only original source entities and original economic proofs are appended; no native payment is created. */
export async function applyContactAppend(ctx, core) {
  const rows = await freezeCas(ctx, "contactCorrections", "contact-corrections");
  await ctx.runItems("contactCorrections", rows, row => ctx.mod("supply/legacy-user-migration").reconcileLegacyOwnerContactProjection(ctx.client, row.input, ctx.actor));
  if (ctx.state.phases.contactCorrections.quarantined) throw new Error("CONTACT_CORRECTIONS_NOT_COMPLETE");
  await applyCancelledContactCorrections(ctx);
  await core.applyUsers();
  if (ctx.state.phases.users.quarantined) throw new Error("CONTACT_APPEND_USERS_NOT_COMPLETE");
  await core.applyAccounts();
  if (ctx.state.phases.accounts.quarantined) throw new Error("CONTACT_APPEND_ACCOUNTS_NOT_COMPLETE");
  await core.applyOrders();
  if (ctx.state.phases.orders.quarantined) throw new Error("CONTACT_APPEND_ORDERS_NOT_COMPLETE");
  await applyFinancialDomains(ctx);
  if (ctx.state.quarantine.length) throw new Error("CONTACT_APPEND_FINANCIAL_DOMAINS_NOT_COMPLETE");
  const subjects = [];
  for await (const row of ctx.readRows(ctx.domainFile("users"))) subjects.push(row.userId);
  const directory = join(ctx.output, "opening-proof"); if (!existsSync(directory)) mkdirSync(directory);
  const source = ctx.manifest.files["stored-opening-reviews"], targetFile = join(directory, source.file), original = readFileSync(ctx.domainFile("stored-opening-reviews"));
  if (sha(original) !== source.sha256) throw new Error("CONTACT_APPEND_OPENING_BYTES_CHANGED");
  if (!existsSync(targetFile)) writeFileSync(targetFile, original, { flag: "wx" });
  else if (sha(readFileSync(targetFile)) !== source.sha256) throw new Error("CONTACT_APPEND_OPENING_BYTES_CHANGED");
  const plan = { status: "REVIEWED_CANDIDATES_TARGET_NOT_RUN", datasetSha256: ctx.state.binding.datasetSha256, file: source.file, sha256: source.sha256,
    stats: { candidate: ctx.manifest.counts.openingCandidates, reviewRequired: ctx.manifest.counts.openingReviewRequired }, sourceDatasetSha256: ctx.manifest.sourceDatasetSha256 };
  const planFile = join(directory, "manifest.json"), bytes = Buffer.from(JSON.stringify(plan));
  if (!existsSync(planFile)) writeFileSync(planFile, bytes, { flag: "wx" });
  else if (sha(readFileSync(planFile)) !== sha(bytes)) throw new Error("CONTACT_APPEND_OPENING_MANIFEST_CHANGED");
  await applyOpeningDomain({ ...ctx, openingSubjectIds: subjects }, directory, sha(bytes));
  const accountIds = (await sourceIds(ctx, "accounts")).map(id => ctx.mod("legacy-load/legacy-account-seam").legacyAccountId("legacy_mysql_restore", "la_rental_accounts", id));
  await applyDisplayDomain({ ...ctx, displayAccountIds: accountIds }, core.display.directory, core.display.sha256);
  await applyHoldingDomain({ ...ctx, holdingAccountIds: accountIds }, core.holdings);
  await exactCoreReadback(ctx);
  const counts = (await ctx.client.query(`SELECT
    (SELECT count(*)::int FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])) users,
    (SELECT count(*)::int FROM zzsh_supply.legacy_supply_map WHERE legacy_id=ANY($2::text[]) AND source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts') accounts,
    (SELECT count(*)::int FROM zzsh_order.legacy_order_read_snapshot WHERE legacy_id=ANY($3::text[])) orders`,
    [subjects, await sourceIds(ctx, "accounts"), await sourceIds(ctx, "orders")])).rows[0];
  if (counts.users !== ctx.manifest.counts.appendUsers || counts.accounts !== ctx.manifest.counts.accounts || counts.orders !== ctx.manifest.counts.orders) throw new Error("CONTACT_APPEND_TARGET_DENOMINATOR_MISMATCH");
  ctx.state.contactAppendReconciliation = { counts, sourceAvailableCents: ctx.manifest.sourceAvailableCents, proofCandidateAvailableCents: ctx.manifest.proofCandidateAvailableCents,
    sourceDatasetSha256: ctx.manifest.sourceDatasetSha256, bankArrivalVerified: false, oldReceiptsUnchanged: true };
  ctx.save();
}

async function sourceIds(ctx, domain) { const ids = []; for await (const row of ctx.readRows(ctx.domainFile(domain))) ids.push(row.sourceId); return ids; }

async function exactCoreReadback(ctx) {
  const checked = { users: 0, contactCorrections: 0, cancelledContactCorrections: 0, accounts: 0, orders: 0 }, migration = ctx.mod("supply/legacy-user-migration");
  for await (const row of ctx.readRows(ctx.domainFile("users"))) {
    const e = row.input.evidence, p = e.contactProjection, accountStatus = e.status.deleted ? "CANCELLED" : e.status.disabled ? "FROZEN" : "ACTIVE";
    const actual = (await ctx.client.query(`SELECT u.username=$2 AND u."displayUsername"=$2 AND u."phoneNumber" IS NOT DISTINCT FROM $3::text AND u."phoneNumberVerified" IS FALSE
      AND i.account_status=$4 AND i.identity_status=$5 AND i.age_status=$6 AND i.verified_at IS NULL AND i.provider='legacy_mysql_restore' AND i.provider_reference=$7
      AND CASE WHEN $8::text IS NULL THEN a.id IS NULL ELSE a.password IS NULL AND a."legacyPasswordMd5"=$8 AND a."legacyPasswordSalt"=$9 AND a."legacyPasswordVersion"='legacy-md5-v1' END matched
      FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state i ON i.user_id=u.id LEFT JOIN zzsh_auth_user.account a ON a."userId"=u.id AND a."providerId"='credential' WHERE u.id=$1`,
      [row.userId, p.sourceSn, p.authenticationPhone, accountStatus, e.status.realNameBound ? "VERIFIED" : "UNVERIFIED", e.status.ageAdult === null ? "UNKNOWN" : e.status.ageAdult ? "ADULT" : "MINOR", "la_user:" + e.legacyId, e.legacyPassword?.md5 ?? null, e.legacyPassword?.salt ?? null])).rows;
    if (actual.length !== 1 || actual[0].matched !== true) throw new Error("CONTACT_APPEND_USER_EXACT_READBACK_FAILED");
    checked.users++;
  }
  for (const [file, count] of [["contact-corrections", "contactCorrections"], ["cancelled-contact-corrections", "cancelledContactCorrections"]]) for await (const row of ctx.readRows(ctx.domainFile(file))) {
      const target = await migration.readLegacyOwnerContactTarget(ctx.client, row.userId, ctx.actor), e = row.input.evidence, p = e.contactProjection;
      if (target.username !== p.sourceSn || target.displayUsername !== p.sourceSn || target.phoneNumber !== p.authenticationPhone || target.phoneNumberVerified !== false || target.migrationSourceDigest !== e.sourceDigest
        || e.status.deleted && target.accountStatus !== "CANCELLED") throw new Error("CONTACT_APPEND_CORRECTION_EXACT_READBACK_FAILED");
      checked[count]++;
    }
  for await (const row of ctx.readRows(ctx.domainFile("accounts"))) {
    const actual = (await ctx.client.query(`SELECT m.source_digest=$2 AND a.owner_user_id=$3 matched FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id
      WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=$1`, [row.sourceId, row.sourceDigest, migration.legacyOwnerUserId("legacy_mysql_restore", "la_user", row.ownerLegacyId)])).rows;
    if (actual.length !== 1 || actual[0].matched !== true) throw new Error("CONTACT_APPEND_ACCOUNT_EXACT_READBACK_FAILED");
    checked.accounts++;
  }
  for await (const row of ctx.readRows(ctx.domainFile("orders"))) {
    const actual = (await ctx.client.query(`SELECT source_digest=$2 AND source_snapshot=$3::jsonb AND owner_user_id=$4 AND renter_user_id=$5 matched
      FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order' AND legacy_id=$1`, [row.sourceId, row.source.digest, JSON.stringify(row.source.row), row.owner.userId, row.renter.userId])).rows;
    if (actual.length !== 1 || actual[0].matched !== true) throw new Error("CONTACT_APPEND_ORDER_EXACT_READBACK_FAILED");
    checked.orders++;
  }
  ctx.state.contactAppendExactReadback = { checked, mismatches: 0, sourceFieldsAndRelationshipsPreserved: true };
  ctx.save();
}
