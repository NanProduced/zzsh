import {continuationCommissionEffects} from "./local-funds-plan.mjs";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
if (!args.includes("--readback")) {
  console.log(JSON.stringify({ action: "PLAN", required: ["--readback", "--dataset", "--dataset-sha", "--checkpoint", "--credentials", "--out"], connections: 0, credentialReads: 0, targetWrites: 0 }));
  process.exit(0);
}
if (process.version !== "v24.20.0") throw new Error("NODE_BASELINE_MISMATCH");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), require = createRequire(import.meta.url), { Client } = require("pg");
const hash = value => createHash("sha256").update(value).digest("hex");
const dataset = resolve(option("--dataset") ?? ""), checkpoint = resolve(option("--checkpoint") ?? ""), output = resolve(option("--out") ?? "");
if (![dataset, checkpoint].every(path => path.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\")) || existsSync(output)) throw new Error("BOUND_PRIVATE_INPUT_NEW_RECEIPT_REQUIRED");
const bytes = readFileSync(join(dataset, "manifest.json"));
if (hash(bytes) !== option("--dataset-sha")) throw new Error("DATASET_MANIFEST_SHA_MISMATCH");
const manifest = JSON.parse(bytes), state = JSON.parse(readFileSync(checkpoint));
if (state.binding?.datasetSha256 !== option("--dataset-sha") || state.binding.database !== "zzsh_test_regression" || state.pending || state.status === "RUNNING" || !["users", "accounts", "orders"].every(name => state.phases[name]?.complete)) throw new Error("KNOWN_COMPLETED_CORE_CHECKPOINT_REQUIRED");
async function* rows(path) { const stream = createReadStream(path), reader = createInterface({ input: stream, crlfDelay: Infinity }); try { for await (const line of reader) if (line) yield JSON.parse(line); } finally { reader.close(); stream.destroy(); } }
for (const [name, entry] of Object.entries(manifest.files)) {
  if (entry.file !== basename(entry.file)) throw new Error("DATASET_FILE_PATH_INVALID");
  const digest = createHash("sha256"); for await (const bytes of createReadStream(join(dataset, entry.file))) digest.update(bytes);
  if (digest.digest("hex") !== entry.sha256) throw new Error("DATASET_FILE_SHA_MISMATCH:" + name);
}
const credentialPath = option("--credentials");
if (!credentialPath) throw new Error("REGISTERED_CREDENTIAL_REQUIRED");
const registration = JSON.parse(readFileSync(join(dirname(resolve(credentialPath)), "resource.json")));
const credential = JSON.parse(readFileSync(credentialPath));
if (registration.oid !== state.binding.oid || registration.nonce !== state.binding.nonce || registration.database !== "zzsh_test_regression" || registration.pendingReset || credential.migration.name !== registration.roles.migration.name || credential.migration.oid !== registration.roles.migration.oid) throw new Error("RESOURCE_BINDING_CHANGED");
const parameters = { host: "127.0.0.1", port: 55432, user: credential.migration.name, password: credential.migration.password, connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 };
const maintenance = new Client({ ...parameters, database: "postgres", application_name: "core-dataset-reconciliation-lock" });
const db = new Client({ ...parameters, database: "zzsh_test_regression", application_name: "core-dataset-reconciliation-read-only" });
const api = resolve(option("--api-dist") ?? join(root, "apps/api/dist/src"));
const mod = name => require(join(api, name + ".js"));
const canonical = mod("supply/content-hash").canonicalize, accountId = mod("legacy-load/legacy-account-seam").legacyAccountId, orderRead = mod("order/legacy-order-read");
const report = { schema: "zzsh.local-dataset-readback.v1", startedAt: new Date().toISOString(), resource: { oid: state.binding.oid, nonce: state.binding.nonce, database: "zzsh_test_regression" }, sourceDatasetSha256: option("--dataset-sha"), status: "STARTED", queries: 0, domains: {}, differences: [], differenceCount: 0, targetWrites: 0, rollbackConfirmed: false, lockReleased: false, connectionsClosed: false };
const difference = (domain, id, reason) => { report.differenceCount++; if (report.differences.length < 100) report.differences.push({ domain, id, reason }); };
const query = async (...args) => { report.queries++; return db.query(...args); };
async function batched(domain, apply) { let batch = [], count = 0; for await (const row of rows(join(dataset, manifest.files[domain].file))) { batch.push(row); if (batch.length === 1000) { await apply(batch); count += batch.length; batch = []; } } if (batch.length) { await apply(batch); count += batch.length; } return count; }
const started = performance.now(); let held = false, connected = false;
try {
  await maintenance.connect(); held = (await maintenance.query("SELECT pg_try_advisory_lock(806006::bigint) held")).rows[0].held;
  if (!held) throw new Error("REGRESSION_RESOURCE_BUSY");
  await db.connect(); connected = true; await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const actual = (await query("SELECT d.oid::text,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run') nonce,current_user FROM pg_database d WHERE d.datname=current_database()")).rows[0];
  if (actual.oid !== registration.oid || actual.nonce !== registration.nonce || actual.marker !== registration.marker || actual.current_user !== credential.migration.name) throw new Error("LIVE_RESOURCE_CHANGED");
  const users = await batched("users", async batch => {
    const actual = new Map((await query(`SELECT u.id,u.name,u."phoneNumber",u."phoneNumberVerified",u.suspended,u.image,
       i.provider,i.provider_reference,i.account_status,i.identity_status,i.age_status,i.verified_at,
       c.password,c."legacyPasswordMd5" md5,c."legacyPasswordSalt" salt,c."legacyPasswordVersion" password_version,
       a.details->>'sourceDigest' source_digest,a.details->>'evidenceDigest' evidence_digest,
       p.current_kind,p.default_preset_id,p.current_preset_id,p.current_asset_id,p.current_version::text avatar_version
       FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state i ON i.user_id=u.id
       LEFT JOIN zzsh_auth_user.account c ON c."userId"=u.id AND c."providerId"='credential'
       LEFT JOIN LATERAL (SELECT details FROM zzsh_iam.audit_event WHERE object_id=u.id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS' ORDER BY occurred_at DESC LIMIT 1) a ON true
       LEFT JOIN zzsh_supply.profile_avatar p ON p.realm='user' AND p.subject_id=u.id
       WHERE u.id=ANY($1::text[])`, [batch.map(row => row.userId)])).rows.map(row => [row.id, row]));
    for (const row of batch) {
      const found = actual.get(row.userId), e = row.input.evidence;
      if (!found) { difference("users", row.sourceId, "TARGET_IDENTITY_MISSING"); continue; }
      const expectedPhone = e.contactProjection ? e.contactProjection.authenticationPhone : "+86" + e.mobile;
      const expectedPhoneVerified = e.contactProjection?.authenticationPhone != null;
      if (found.name !== e.nickname || found.phoneNumber !== expectedPhone || found.phoneNumberVerified !== expectedPhoneVerified || found.suspended !== false || found.provider !== "legacy_mysql_restore" || found.provider_reference !== "la_user:" + row.sourceId || found.account_status !== (e.status.deleted ? "CANCELLED" : e.status.disabled ? "FROZEN" : "ACTIVE") || found.identity_status !== (e.status.realNameBound ? "VERIFIED" : "UNVERIFIED") || found.age_status !== (e.status.ageAdult === true ? "ADULT" : e.status.ageAdult === false ? "MINOR" : "UNKNOWN") || found.verified_at !== null || found.source_digest !== e.sourceDigest || found.evidence_digest !== row.input.evidenceDigest) difference("users", row.sourceId, "SOURCE_STATUS_IDENTITY_OR_AUDIT_DRIFT");
      const password = e.legacyPassword;
      if (password ? found.password !== null || found.md5 !== password.md5 || found.salt !== password.salt || found.password_version !== password.version : found.md5 !== null || found.password !== null) difference("users", row.sourceId, "SOURCE_CREDENTIAL_NOT_PRESERVED");
      if (found.current_kind !== "DEFAULT" || found.default_preset_id !== found.current_preset_id || found.current_asset_id !== null || !mod("profile/profile-avatar-presets").isProfileAvatarPresetId(found.default_preset_id) || found.image !== mod("profile/profile-avatar").avatarImagePath("user", row.userId, found.avatar_version)) difference("users", row.sourceId, "PERSISTED_DEFAULT_AVATAR_NOT_BOUND");
    }
  });
  report.domains.users = { expected: users };
  const accounts = await batched("accounts", async batch => {
    const actual = new Map((await query(`SELECT m.legacy_id,m.account_id,m.source_digest,m.evidence_ref,m.version_id,a.owner_user_id,a.game_id,a.current_version_id,a.legacy_hold,v.origin,v.review_state,
       h.account_id snapshot_account,h.snapshot,h.source_digest snapshot_digest,to_char(h.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') snapshot_updated_at,h.source_status
       FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id JOIN zzsh_supply.listing_version v ON v.id=m.version_id
       LEFT JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id
       WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`, [batch.map(row => row.sourceId)])).rows.map(row => [row.legacy_id, row]));
    for (const row of batch) {
      const found = actual.get(row.sourceId);
      if (!found) { difference("accounts", row.sourceId, "TARGET_ACCOUNT_MAP_MISSING"); continue; }
      if (found.account_id !== accountId("legacy_mysql_restore", "la_rental_accounts", row.sourceId) || found.source_digest !== row.sourceDigest || found.evidence_ref !== row.evidenceRef || found.owner_user_id !== row.ownerUserId || found.game_id !== state.gameBindings[row.gameCode] || found.version_id !== found.current_version_id || found.origin !== "LEGACY_OBSERVATION" || found.review_state !== "IMPORTED_UNVERIFIED" || found.legacy_hold !== "UNRESOLVED") difference("accounts", row.sourceId, "SOURCE_OWNER_GAME_OBSERVATION_OR_HOLD_DRIFT");
      const snapshotExpected = row.snapshot && row.sourceUpdatedAt && [0, 3, 4, 5, 6].includes(Number(row.sourceStatus)) && !row.sourceDeleted;
      if (snapshotExpected ? !found.snapshot_account || canonical(found.snapshot) !== canonical(row.snapshot) || found.snapshot_digest !== row.sourceDigest || found.snapshot_updated_at !== row.sourceUpdatedAt || Number(found.source_status) !== Number(row.sourceStatus) : found.snapshot_account !== null) difference("accounts", row.sourceId, "HISTORICAL_SNAPSHOT_DRIFT_OR_UNPROVED_PUBLIC_FACT");
    }
  });
  report.domains.accounts = { expected: accounts };
  let deleted = 0;
  const orders = await batched("orders", async batch => {
    const actual = new Map((await query(`SELECT legacy_id,id,binding_digest,source_digest,source_snapshot,account_id,game_id,owner_user_id,renter_user_id,due_amount_cents::text due,recorded_paid_amount_cents::text paid,deposit_amount_cents::text deposit FROM zzsh_order.legacy_order_read_snapshot WHERE source_system='legacy_mysql_restore' AND source_entity='la_order' AND legacy_id=ANY($1::text[])`, [batch.map(row => row.sourceId)])).rows.map(row => [row.legacy_id, row]));
    for (const row of batch) {
      const found = actual.get(row.sourceId), bound = { source: row.source, account: { ...row.account, accountId: accountId("legacy_mysql_restore", "la_rental_accounts", row.account.legacyId), gameId: state.gameBindings[row.gameCode] }, owner: row.owner, renter: row.renter }, expected = orderRead.normalizeLegacyOrderReadInput(bound);
      if (row.sourceDeleted) deleted++;
      if (!found) { difference("orders", row.sourceId, "TARGET_ORDER_SNAPSHOT_MISSING"); continue; }
      if (found.id !== expected.id || found.binding_digest !== expected.bindingDigest || found.source_digest !== row.sourceDigest || canonical(found.source_snapshot) !== canonical(row.source.row) || found.account_id !== bound.account.accountId || found.game_id !== bound.account.gameId || found.owner_user_id !== row.owner.userId || found.renter_user_id !== row.renter.userId || found.due !== expected.dueCents || found.paid !== expected.paidCents || found.deposit !== expected.depositCents) difference("orders", row.sourceId, "ORIGINAL_ORDER_RELATION_STATUS_OR_MONEY_DRIFT");
    }
  });
  report.domains.orders = { expected: orders, preservedSourceDeleted: deleted };
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
    await compare("display", rows(await checked(display.directory, dm.file, dm.sha256)), async batch => (await query(`SELECT m.legacy_id key,m.version_id,d.observation_version_id,d.extract_sha256,d.base_source_digest,d.snapshot,to_char(d.source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.legacy_listing_display_snapshot d USING(account_id) WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`, [batch.map(r => r.sourceId)])).rows, (r, a) => a && a.version_id === a.observation_version_id && a.extract_sha256 === dm.extractSha256 && a.base_source_digest === r.baseSourceDigest && a.updated_at === r.sourceUpdatedAt && canonical(a.snapshot) === canonical(r.snapshot), dm.rows);
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
    for(let i=0;i<expected.length;i+=500){
      const batch=expected.slice(i,i+500),actual=new Map((await query(`SELECT o.source_entity,o.source_id,o.user_id,o.legacy_user_id,o.source_digest,o.source_canonical,o.snapshot,to_char(o.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') event_at FROM zzsh_order.personal_finance_observation o JOIN unnest($1::text[],$2::text[]) k(entity,id) ON o.source_entity=k.entity AND o.source_id=k.id WHERE o.source_system='legacy_mysql_restore'`,[batch.map(r=>r.sourceEntity),batch.map(r=>r.sourceId)])).rows.map(r=>[r.source_entity+":"+r.source_id,r]));
      for(const row of batch){const found=actual.get(row.sourceEntity+":"+row.sourceId);counts[row.domain]??={expected:0,readable:0};counts[row.domain].expected++;
        if(!found||found.user_id!==row.userId||found.legacy_user_id!==row.legacyUserId||found.source_digest!==row.sourceDigest||found.source_canonical!==row.sourceCanonical||canonical(found.snapshot)!==canonical(row.snapshot)||found.event_at!==row.sourceEventAt)difference("financeHistory",row.sourceEntity+":"+row.sourceId,"FROZEN_SOURCE_OBSERVATION_DRIFT");else{counts[row.domain].readable++;if(row.domain==='refunds')for(const attempt of found.snapshot.sourceAttempts??[]){readableAttempts++;attemptStatusCounts[attempt.sourceStatus]=(attemptStatusCounts[attempt.sourceStatus]??0)+1;}}
      }
    }
    report.refundAttempts={readable:readableAttempts,actualStatusCounts:attemptStatusCounts,expected:state.fundsSupplement.refundAttemptCoverage?.selected??null,sourceStates:state.fundsSupplement.refundAttemptCoverage?.statusCounts??{},scope:"TYPED_LA_REFUND_LOG_CHILDREN_EXACTLY_COVERED_BY_PARENT_CANONICAL_DIGEST_NOT_NEW_CHANNEL_TRANSACTIONS"};
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
    const phase=state.generatedPhases.financeEmptyCoverage,bytes=readFileSync(join(dirname(checkpoint),"phases","financeEmptyCoverage.json"));if(hash(bytes)!==phase.sha256)throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
    const expected=JSON.parse(bytes).flatMap(chunk=>chunk.rows.map(row=>mod("finance/personal-finance-observation-maintenance").planFinanceObservations(row.input).coverage));let readable=0;
    for(let i=0;i<expected.length;i+=500){
      const batch=expected.slice(i,i+500),actual=new Map((await query(`SELECT c.id,c.user_id,c.source_kind,c.source_count,c.imported_count,c.isolated_count,c.body_digest,c.source_canonical,(SELECT count(*)::text FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_system=c.source_system AND o.source_kind=c.source_kind AND (o.source_event_at IS NULL OR o.source_event_at<=c.source_cutoff)) AS actual_count FROM zzsh_order.personal_finance_observation_coverage c WHERE c.id=ANY($1::text[])`,[batch.map(r=>r.id)])).rows.map(r=>[r.id,r]));
      for(const row of batch){const found=actual.get(row.id);if(!found||found.user_id!==row.userId||found.source_kind!==row.sourceKind||found.source_count!==0||found.imported_count!==0||found.isolated_count!==0||found.actual_count!=='0'||found.body_digest!==row.bodyDigest||found.source_canonical!==row.canonical)difference("financeEmptyCoverage",row.id,"PROVED_EMPTY_COVERAGE_DRIFT");else readable++;}
    }
    report.emptyFinancialCoverage={expected:expected.length,readable,scope:"EXACT_SOURCE_ZERO_PER_SUBJECT_AND_KIND_NOT_A_ZERO_WALLET"};
  }
  if(state.phases.guaranteeHistory?.complete){
    const phase=state.generatedPhases.guaranteeHistory,bytes=readFileSync(join(dirname(checkpoint),"phases","guaranteeHistory.json"));if(hash(bytes)!==phase.sha256)throw new Error("FINANCIAL_PHASE_INPUT_CHANGED");
    const expected=JSON.parse(bytes).flatMap(group=>mod("finance/owner-guarantee-history").planOwnerGuaranteeHistoryBatch(group.input).rows);
    let readable=0;
    for(let i=0;i<expected.length;i+=500){const batch=expected.slice(i,i+500),actual=new Map((await query(`SELECT legacy_account_id,user_id,legacy_user_id,account_id,source_digest,source_canonical FROM zzsh_order.legacy_owner_guarantee_observation WHERE legacy_account_id=ANY($1::text[]) AND source_cutoff=$2::timestamptz`,[batch.map(r=>r.sourceId),manifest.sourceCutoff])).rows.map(r=>[r.legacy_account_id,r]));for(const row of batch){const found=actual.get(row.sourceId);if(!found||found.user_id!==row.userId||found.legacy_user_id!==row.legacyUserId||found.account_id!==row.accountId||found.source_digest!==row.sourceDigest||found.source_canonical!==row.sourceCanonical)difference("guaranteeHistory",row.sourceId,"FROZEN_GUARANTEE_SOURCE_DRIFT");else readable++;}}
    report.ownerGuaranteeHistory={expected:expected.length,readable,financialEffect:"NONE",heldAmount:"UNKNOWN_WITHOUT_CURRENT_LIABILITY_PROOF"};
  }
  if(state.phases.invitationFacts?.complete){
    const module=mod("finance/legacy-invitation-facts");let expectedSubjects=0,matchedSubjects=0,expectedRelations=0,matchedRelations=0,childProofAudits=0;
    const audits = new Map((await query("SELECT object_id,details FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND outcome='SUCCESS'")).rows.map(r => [r.object_id, r.details]));
    await batched("invitation-facts",async packets=>{for(const packet of packets){
      const plan=module.prepareLegacyInvitationFacts(packet.input,packet.bodyDigest),ids=plan.subjects.map(p=>p.userId);
      const audit = audits.get(plan.bodyDigest);
      if (!audit || canonical(audit.facts) !== canonical(packet.input.subjects) || canonical(audit.source) !== canonical(packet.input.source) || audit.financialEffects !== false) difference("invitationFacts", plan.bodyDigest, "ORIGINAL_CHILD_DENOMINATOR_AUDIT_DRIFT");
      else childProofAudits++;
      const subjects=new Map((await query(`SELECT p.*,c.id AS code_id,c.display_code,c.match_code,c.source_type AS code_source_type,c.source_id AS code_source_id,c.source_digest AS code_digest FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_order.distribution_invite_code c ON c.user_id=p.user_id WHERE p.user_id=ANY($1::text[])`,[ids])).rows.map(r=>[r.user_id,r]));
      for(const expected of plan.subjects){expectedSubjects++;const found=subjects.get(expected.userId);if(!found||found.source_type!=='LEGACY_MYSQL'||found.source_ref!==expected.sourceRef||found.source_digest!==expected.sourceDigest||found.eligibility!==expected.eligibility||found.commission_frozen!==expected.commissionFrozen||found.policy_version_id!==null||found.code_id!==expected.codeId||found.display_code!==expected.fact.codeSource.code||found.match_code!==expected.fact.codeSource.code.toUpperCase()||found.code_source_type!=='LEGACY_MYSQL'||found.code_source_id!==expected.fact.legacyId||found.code_digest!==expected.codeDigest)difference("invitationFacts",expected.userId,"IMMUTABLE_INVITATION_FACT_CODE_OR_ELIGIBILITY_DRIFT");else matchedSubjects++;}
      const relations=new Map((await query(`SELECT * FROM zzsh_order.invitation_relation WHERE child_user_id=ANY($1::text[]) AND source_type='LEGACY_MYSQL'`,[ids])).rows.map(r=>[r.id,r]));
      for(const expected of plan.relations){expectedRelations++;const found=relations.get(expected.id);if(!found||found.type!==expected.type||found.child_user_id!==expected.childUserId||found.parent_user_id!==expected.parentUserId||found.policy_version_id!==null||found.source_ref!==expected.sourceRef||found.source_digest!==expected.sourceDigest)difference("invitationFacts",expected.id,"ORIGINAL_PARENT_RELATION_DRIFT");else matchedRelations++;}
    }});report.invitationFacts={expectedSubjects,matchedSubjects,expectedRelations,matchedRelations,childProofAudits,policy:null,childCountClosure:"FULL_SOURCE_PROOF_RETAINED_NOT_FORCED_ON_PARTIAL_TARGET"};
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
  await query("ROLLBACK"); report.rollbackConfirmed = true;
}
catch (error) { report.status = "READBACK_FAILED"; report.error = error.code ?? error.message; process.exitCode = 1; }
finally {
  if (connected && !report.rollbackConfirmed) { try { await query("ROLLBACK"); report.rollbackConfirmed = true; } catch {} }
  await db.end();
  if (held) { try { report.lockReleased = (await maintenance.query("SELECT pg_advisory_unlock(806006::bigint) released")).rows[0].released; } catch {} }
  await maintenance.end(); report.connectionsClosed = true; report.finishedAt = new Date().toISOString(); report.monotonicElapsedMs = performance.now() - started;
  if (!report.rollbackConfirmed || !report.lockReleased || report.differenceCount) process.exitCode = 1;
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, differences: report.differenceCount, queries: report.queries, rollback: report.rollbackConfirmed, unlock: report.lockReleased, closed: report.connectionsClosed }));
}
