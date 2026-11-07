import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeLoadCheckpoint } from "./local-load-checkpoint.mjs";
import { readSourceRows } from "./local-source-adapter.mjs";
import { verifyLegacyListedPolicyDump } from "./verify-legacy-listed-policy-dump.mjs";
import { validateLegacyListedExecutionPlan } from "./legacy-listed-execution-plan.mjs";
import { inspectDeferredLegacyCredit, lockDeferredLegacyCreditTables, deferredCreditGateForRow, requiresFullRollbackTrial, rejectUnmarkedObservation } from "./legacy-listed-provisional-credit.mjs";
import { verifyRoundBoundSourcePlan, validateRoundTrialReceipt } from "./legacy-listed-round-source.mjs";
import { advisoryLockSql, assertLiveTarget, loadRegisteredTarget, maintenanceConnection, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const mode = ["--prepare", "--trial", "--execute", "--recover"].filter(flag => args.includes(flag));
if (mode.length === 0) {
  console.log(JSON.stringify({ action: "PLAN", target: "zzsh_test_regression",
    prepare: ["--prepare", "--input", "--input-sha", "--out", "--actor-file", "--credentials", "--oid", "--nonce", "--api-dist", "--source-dir", "--source-receipt-sha", "--source-binding", "--policy-bundle", "--policy-bundle-sha", "--policy-authority", "--policy-authority-sha"],
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
const registered = loadRegisteredTarget(credentialsFile);
const roleKind = action === "--execute" || action === "--trial" ? "migration" : "runtime";
const role = credentials[roleKind];
if (resource.database !== "zzsh_test_regression" || registered.database !== resource.database || credentials.database !== resource.database || registered.oid !== oid || registered.nonce !== nonce || resource.oid !== oid || resource.nonce !== nonce || resource.pendingReset
  || role?.name !== resource.roles?.[roleKind]?.name || role?.oid !== resource.roles?.[roleKind]?.oid
  || role?.name !== (roleKind === "migration" ? registered.migrationRole : registered.runtimeRole)
  || role?.oid !== (roleKind === "migration" ? registered.migrationRoleOid : registered.runtimeRoleOid)) throw new Error("TARGET_BINDING_INVALID");
const moduleNames = ["auth/auth-security", "auth/security-core", "database/business-migrations", "order/order", "order/legacy-continuation-model", "supply/content-hash", "supply/funding-authority",
  "supply/legacy-display-snapshot", "supply/legacy-listing-read", "supply/legacy-published-reference", "supply/legacy-trade-takeover", "supply/publishing", "supply/supply-util",
  "supply/legacy-listed-source-quote", "supply/legacy-listed-policy", "supply/legacy-listed-source", "supply/legacy-listed-pricing", "supply/legacy-listed-quote",
  "supply/pricing", "supply/delta-rental", "supply/decimal", "supply/legacy-observation", "supply/funding-policy", "supply/full-payout-terms", "credit/credit-guarantee"];
const moduleFile = name => join(apiDist, name + ".js");
const compiled = Object.fromEntries(moduleNames.map(name => [name, sha(readFileSync(moduleFile(name)))]));
compiled.policyDumpVerifier = sha(readFileSync(new URL('./verify-legacy-listed-policy-dump.mjs', import.meta.url)));
compiled.sourceAdapter = sha(readFileSync(new URL('./local-source-adapter.mjs', import.meta.url)));
compiled.planValidator = sha(readFileSync(new URL('./legacy-listed-execution-plan.mjs', import.meta.url)));
compiled.loader = sha(readFileSync(fileURLToPath(import.meta.url)));
compiled.targetRegistry = sha(readFileSync(new URL('./local-target-registry.mjs', import.meta.url)));
compiled.provisionalCreditVerifier = sha(readFileSync(new URL('./legacy-listed-provisional-credit.mjs', import.meta.url)));
if (input.roundBinding) compiled.roundSourceVerifier = sha(readFileSync(new URL('./legacy-listed-round-source.mjs', import.meta.url)));
const migrationsFolder=resolve(apiDist,'../../migrations/business');
const migrationTag='0156_legacy_listed_quote',migrationBytes=readFileSync(join(migrationsFolder,`${migrationTag}.sql`));
const migrationJournal=JSON.parse(readFileSync(join(migrationsFolder,'meta/_journal.json'),'utf8'));
const migrationEntry=migrationJournal.entries.find(entry=>entry.tag===migrationTag);
if(!migrationEntry || !Number.isSafeInteger(migrationEntry.when))throw new Error('LISTED_MIGRATION_JOURNAL_INVALID');
compiled.listedMigration = sha(migrationBytes);
compiled.migrationJournal = sha(readFileSync(join(migrationsFolder,'meta/_journal.json')));
const mod = name => require(moduleFile(name));
const { canonicalize } = mod("supply/content-hash");
const { readLegacyPublishedReference } = mod("supply/legacy-published-reference");
const { prepareLegacyTradeIntake, takeoverLegacyTrade } = mod("supply/legacy-trade-takeover");
const { readPublishingAccount, readDeclaration, readCurrentVersion } = mod("supply/publishing");
const { readLegacyDeclaredSkins } = mod("supply/legacy-listing-read");
const { legacyDisplayDigest } = mod("supply/legacy-display-snapshot");
const { createProductionSupplyGateReader } = mod("supply/funding-authority");
const { readGuaranteeContext, CREDIT_GUARANTEE_THRESHOLD } = mod("credit/credit-guarantee");
const { composeSupplyGateWithOrderOccupancy } = mod("order/order");
const { assertAdminContextInTransaction } = mod("auth/auth-security");
const { setAuditContext } = mod("auth/security-core");
const { fingerprintRequest } = mod("supply/supply-util");
const { readLegacyListedPolicy } = mod("supply/legacy-listed-policy");
const { buildLegacyListedSourceQuote } = mod("supply/legacy-listed-source-quote");
const { readFundingPolicyForRelease } = mod("supply/funding-authority");
const { readFullPayoutTerms } = mod("supply/full-payout-terms");
const { validateOwnerDepositAmount } = mod("supply/funding-policy");
const { legacyPlanYuanToCents } = mod("order/legacy-continuation-model");
const { assertBusinessMigrationPrefix } = mod("database/business-migrations");
const operation = "supply.legacy.trade_takeover";
const { Client } = require("pg");
const target = { database: resource.database, oid, nonce, actorId: actor.id, instance: registered.instance, lockKey: registered.lockKey,
  migrationRoleOid: registered.migrationRoleOid, runtimeRoleOid: registered.runtimeRoleOid };
const client = new Client(targetConnection(registered, { user: role.name, password: role.password,
  applicationName: "legacy-listed-accounts-" + action.slice(2), connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 1000 }));
const creditGuaranteeEnabled = action === "--prepare" ? args.includes("--credit-guarantee") : input.creditGuaranteeEnabled === true;
if (input.schema === 'zzsh.listed-source-continuity-plan.v2' || input.sourcePlanSchema === 'zzsh.listed-source-continuity-plan.v2' || input.roundBinding) {
  verifyRoundBoundSourcePlan(input, { oid, nonce, instance:registered.instance, credentials: credentialsFile, actorFile: option('--actor-file'), apiDist,
    sourceDir: option('--source-dir'), sourceReceiptSha: option('--source-receipt-sha'), sourceBinding: option('--source-binding'),
    policyBundle: option('--policy-bundle'), policyBundleSha: option('--policy-bundle-sha'),
    policyAuthority: option('--policy-authority'), policyAuthoritySha: option('--policy-authority-sha'), creditGuaranteeEnabled,
    allowExpiredReadOnly: action === '--recover', compiled }, canonicalize);
}
const gate = composeSupplyGateWithOrderOccupancy(createProductionSupplyGateReader({ creditGuaranteeEnabled }));
const phase = join(out, "checkpoint.json");
let transaction = false, commitSent = false, maintenance;
async function readReviewedSource() {
  const directory=privatePath(option('--source-dir')), receiptBytes=readFileSync(join(directory,'receipt.json'));
  const receipt=JSON.parse(receiptBytes), receiptSha=sha(receiptBytes);
  if(receiptSha!==option('--source-receipt-sha') || receipt.status!=='CAPTURED_READ_ONLY' || !receipt.rollbackConfirmed || !receipt.clientClosed
    || receipt.files?.accounts?.file!=='accounts.jsonl' || receipt.files?.tradePolicy?.file!=='tradePolicy.jsonl') throw new Error('SOURCE_CAPTURE_NOT_CONFIRMED');
  const policyPath=privatePath(option('--policy-bundle')),policy=JSON.parse(readFileSync(policyPath,'utf8')),policyCanonical=canonicalize(policy),policySha=sha(policyCanonical);
  if(policySha!==option('--policy-bundle-sha'))throw new Error('REVIEWED_POLICY_DIGEST_CHANGED');
  const authority=JSON.parse(readFileSync(privatePath(option('--policy-authority')),'utf8')),authorityCanonical=canonicalize(authority),authoritySha=sha(authorityCanonical);
  if(authoritySha!==option('--policy-authority-sha'))throw new Error('OWNER_POLICY_DECISION_DIGEST_CHANGED');
  const sourceBindingPath=option('--source-binding');if(!isAbsolute(sourceBindingPath??''))throw new Error('SOURCE_BINDING_REQUIRED');
  const sourceBindingBytes=readFileSync(sourceBindingPath),sourceBinding=JSON.parse(sourceBindingBytes),sourceBindingSha=sha(sourceBindingBytes);
  if(sourceBindingSha!==policy.supplement?.sourceBindingSha256 || sourceBinding.container?.id!==receipt.containerId
    || sourceBinding.source?.database!==receipt.database || policy.supplement?.sourceReceiptSha256!==receiptSha
    || sourceBinding.restoreRecord?.dumpSha256!==policy.supplement?.dumpSha256)throw new Error('SOURCE_PACKAGE_BINDING_CHANGED');
  const accountPath=join(directory,'accounts.jsonl'),tradePath=join(directory,'tradePolicy.jsonl');
  if(sha(readFileSync(accountPath))!==receipt.files.accounts.sha256 || sha(readFileSync(tradePath))!==receipt.files.tradePolicy.sha256)throw new Error('SOURCE_CAPTURE_FILE_CHANGED');
  const original=[];for await(const row of readSourceRows(tradePath))if(row.type==='expendConfig')original.push(row);
  const observed=(policy.supplement.settingRows??[]).filter(row=>row.type==='expendConfig');
  const sortRows=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
  if(original.length!==14 || canonicalize(sortRows(original))!==canonicalize(sortRows(observed)))throw new Error('SOURCE_MATERIAL_POLICY_CHANGED');
  const gameIds=policy.supplement.gameRows?.map(row=>row.id);
  if(!Array.isArray(gameIds)||gameIds.length!==1)throw new Error('SOURCE_GAME_POLICY_INVALID');
  const dump=await verifyLegacyListedPolicyDump(sourceBinding.restoreRecord,gameIds[0]);
  if(canonicalize(dump)!==canonicalize(policy.dumpVerification))throw new Error('SOURCE_DUMP_POLICY_CHANGED');
  const requested=new Set(input.listings.map(row=>row.sourceId)),accounts=new Map();
  for await(const row of readSourceRows(accountPath))if(requested.has(row.id)){
    if(accounts.has(row.id))throw new Error('SOURCE_ACCOUNT_DUPLICATE');
    const canonical=canonicalize(row),sourceDigest=sha(canonical),entry=policy.supplement.accountSourceDigests?.find(x=>x.id===row.id);
    if(!entry || entry.sha256!==sourceDigest)throw new Error('SOURCE_ACCOUNT_DIGEST_CHANGED');
    const policyBinding={proofSha256:policySha,sourceReceiptSha256:receiptSha,sourceBindingSha256:sourceBindingSha,dumpSha256:sourceBinding.restoreRecord.dumpSha256,
      dumpVerifierSha256:policy.verifierSha256,sourceId:row.id,sourceDigest,legacyGameId:row.game_id,expectedAccountCount:requested.size,authorityCanonical,authoritySha256:authoritySha};
    readLegacyListedPolicy(policyCanonical,policyBinding);
    accounts.set(row.id,{raw:row,canonical,sourceDigest,policyBinding});
  }
  if(accounts.size!==requested.size || requested.size!==input.listings.length)throw new Error('SOURCE_ACCOUNT_POPULATION_MISMATCH');
  return {accounts,policyCanonical,receiptSha,policySha,authoritySha,accountsFileSha256:receipt.files.accounts.sha256};
}
const actionBody = (row, intake, receiptSha) => ({ batchId: `legacy-listed-${receiptSha}`, intake, reviewedDeclaration: {
  title: row.titleBasis, reason: "原在架账号继续经营，按已核游戏与资源数量生成标题",
} });
function binding(body) {
  const { intake } = body, accountId = intake.accountId;
  return { scope: JSON.stringify(["admin", actor.id, operation, accountId]),
    key: sha(JSON.stringify([accountId, intake.source.expectedObservationVersionId, sha(canonicalize(intake))])),
    fingerprint: fingerprintRequest(operation, accountId, body) };
}
async function prepareRow(row, reviewed) {
  const sourceRow=reviewed.accounts.get(row.sourceId), raw=sourceRow?.raw;
  if(!sourceRow || !raw || raw.id!==row.sourceId || !/^[1-3]$/.test(raw.default_consume_type??'') || !/^[1-9]\d{0,17}$/.test(raw.haff??'')
    || !['0','1'].includes(raw.is_full_payout) || !['default','custom','fast'].includes(raw.ratio_type))return {sourceId:row.sourceId,blocked:'SOURCE_ROW_NOT_COMPLETE'};
  const sourceDigest=sourceRow.sourceDigest,fullPayout=raw.is_full_payout,ownerRatioB=raw.ratio_type==='default'?null:raw.base_bot;
  if(row.sourceDigest && row.sourceDigest!==sourceDigest || row.fullPayout!==fullPayout
    || row.depositYuan!=null && row.depositYuan!==raw.deposit_amount || row.ownerRatioB!=null && row.ownerRatioB!==ownerRatioB)
    return {sourceId:row.sourceId,blocked:'SOURCE_PLAN_FACT_CHANGED'};
  const record = (await client.query(`SELECT m.account_id,m.version_id,m.source_digest,d.snapshot,d.extract_sha256,d.evidence_ref,d.source_updated_at,d.display_digest
    FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id
      AND h.observation_version_id=m.version_id AND h.source_system=m.source_system AND h.source_entity=m.source_entity
      AND h.legacy_id=m.legacy_id AND h.source_digest=m.source_digest AND h.source_status=3
    JOIN zzsh_supply.legacy_listing_display_snapshot d ON d.account_id=m.account_id AND d.observation_version_id=m.version_id
      AND d.base_source_digest=m.source_digest AND d.schema_version=1
    WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=$1`, [row.sourceId])).rows;
  if (record.length !== 1 || record[0].source_digest !== sourceDigest || record[0].extract_sha256!==reviewed.accountsFileSha256) return { sourceId: row.sourceId, blocked: "SOURCE_TARGET_BINDING_REQUIRED" };
  const r = record[0], account = await readPublishingAccount(client, r.account_id);
  const version = await readCurrentVersion(client, account);
  const original=version?.id===r.version_id && version.origin==='LEGACY_OBSERVATION' && version.review_state==='IMPORTED_UNVERIFIED';
  const previouslyPublished=version?.origin==='NATIVE' && version.review_state==='APPROVED' && (await client.query(`SELECT 1 FROM zzsh_supply.listing_publication p
    JOIN zzsh_iam.audit_event e ON e.object_id=p.account_id WHERE p.account_id=$1 AND p.version_id=$2 AND p.owner_user_id=$3 AND p.content_hash=$4
      AND p.source='LEGACY_APPROVED' AND e.action='supply.legacy.trade_takeover' AND e.outcome='SUCCESS' AND e.details->>'versionId'=p.version_id
      AND e.details#>>'{source,sourceSystem}'='legacy_mysql_restore' AND e.details#>>'{source,sourceEntity}'='la_rental_accounts'
      AND e.details#>>'{source,legacyId}'=$5 AND e.details#>>'{source,sourceDigest}'=$6 AND e.details#>>'{source,expectedObservationVersionId}'=$7 LIMIT 1`,
    [account.id,version.id,account.owner_user_id,version.content_hash,row.sourceId,sourceDigest,r.version_id])).rowCount===1;
  if ((!original && !previouslyPublished) || account.lifecycle !== "ACTIVE" || account.owner_paused || account.staff_restricted) return { sourceId: row.sourceId, blocked: "CURRENT_ACCOUNT_NOT_ELIGIBLE" };
  const owner = (await client.query(`SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
    WHERE u.id=$1 AND NOT u.suspended AND s.account_status='ACTIVE' AND s.identity_status='VERIFIED' AND s.age_status='ADULT'`,
  [account.owner_user_id])).rowCount === 1;
  if (!owner) return { sourceId: row.sourceId, blocked: "CURRENT_OWNER_IDENTITY_NOT_ELIGIBLE" };
  if (!(r.source_updated_at instanceof Date) || legacyDisplayDigest(account.id, { observationVersionId: r.version_id, baseSourceDigest: sourceDigest,
    extractSha256: r.extract_sha256, sourceUpdatedAt: r.source_updated_at.toISOString(), evidenceRef: r.evidence_ref, snapshot: r.snapshot }) !== r.display_digest)
    return { sourceId: row.sourceId, blocked: "DISPLAY_SOURCE_BINDING_MISMATCH" };
  const reference = await readLegacyPublishedReference(client, account.id);
  if (!reference || reference.sourceDigest !== sourceDigest || reference.observationVersionId !== r.version_id || reference.legacyId!==row.sourceId)
    return { sourceId: row.sourceId, blocked: "LEGACY_PUBLISHED_REFERENCE_REQUIRED" };
  const currentGate = await gate(client, account, "READ");
  if (currentGate.occupancy !== "FREE" || currentGate.rentalCompleted)
    return { sourceId: row.sourceId, blocked: "CURRENT_OCCUPANCY_OR_FUNDING_GATE" };
  let deferredCredit=null;
  if (!["SATISFIED", "NOT_REQUIRED"].includes(currentGate.publisherBail)) {
    if (original && creditGuaranteeEnabled) {
      try { deferredCredit=await inspectDeferredLegacyCredit(client,{account,version,raw,gate:currentGate,readGuaranteeContext,threshold:CREDIT_GUARANTEE_THRESHOLD}); }
      catch { deferredCredit=null; }
    }
    if(!deferredCredit)return { sourceId: row.sourceId, blocked: "CURRENT_OCCUPANCY_OR_FUNDING_GATE" };
  }
  const terms = (await client.query(`SELECT t.code,t.daily_consumption::text AS "dailyConsumption",t.duration_rounding AS "durationRounding",r.id release_id,r.price_version_id FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id
      JOIN zzsh_supply.term_option t ON t.version_id=r.term_version_id WHERE g.id=$1 AND g.enabled AND t.daily_consumption=$2::numeric`,
  [account.game_id, (BigInt(raw.default_consume_type)*10000000n).toString()])).rows;
  if (terms.length !== 1) return { sourceId: row.sourceId, blocked: "CURRENT_TERM_NOT_UNIQUE" };
  const observation=(await client.query(`SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2 AND origin='LEGACY_OBSERVATION'`,[r.version_id,account.id])).rows[0];
  if(!observation)return {sourceId:row.sourceId,blocked:'SOURCE_OBSERVATION_MISSING'};
  const declaration = await readDeclaration(client, observation);
  const skins = await readLegacyDeclaredSkins(client, r.version_id, account.game_id);
  if (skins.some(skin => !skin.isPublic)) return { sourceId: row.sourceId, blocked: "CURRENT_SKIN_CATALOG_REVIEW_REQUIRED" };
  const source = { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.sourceId,
    sourceDigest, expectedObservationVersionId: r.version_id, expectedOwnerUserId: account.owner_user_id, expectedGameId: account.game_id };
  const canonical = canonicalize({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: row.sourceId,
    baseSourceDigest: sourceDigest, deposit_amount: raw.deposit_amount, is_full_payout: fullPayout, ownerRatioB,
    sourceStatus: "3", sourceDeleted: "0", processing_time_start: raw.processing_time_start, processing_time_end: raw.processing_time_end });
  if (row.sourceFieldEvidenceDigest && sha(canonical) !== row.sourceFieldEvidenceDigest) throw new Error("SOURCE_FIELD_DIGEST_CHANGED");
  const intake = { accountId: account.id, source, display: r.snapshot, title: declaration.title, description: declaration.description,
    depositYuan: raw.deposit_amount, isFullPayout: fullPayout, ownerRatioB, termOptionCode: terms[0].code,
    pricingOptionCode: "", skins: skins.map(skin => skin.id), entitlements: declaration.entitlements, media: [],
    sourceFieldEvidence: { canonical, digest: sha(canonical), extractSha256: r.extract_sha256, evidenceRef: r.evidence_ref },
    legacyQuoteEvidence:{sourceCanonical:sourceRow.canonical,policyCanonical:reviewed.policyCanonical,policyBinding:sourceRow.policyBinding} };
  const titleBasis=row.titleBasis??`三角洲行动 · ${raw.haff}M哈夫币`;
  const catalog = (await client.query(`SELECT id,code,unit,quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled ORDER BY id`, [account.game_id])).rows;
  const draft = prepareLegacyTradeIntake({ ...intake, title: titleBasis }, catalog, reference.digest);
  if (draft.admission !== "TRADE_CANDIDATE") return { sourceId: row.sourceId, blocked: draft.reasons };
  const funding = await readFundingPolicyForRelease(client,terms[0].release_id);
  if(!funding)return {sourceId:row.sourceId,blocked:'FUNDING_POLICY_UNAVAILABLE'};
  if(deferredCredit && funding.guaranteeRequirement.mode!=='NOT_REQUIRED')return {sourceId:row.sourceId,blocked:'DEFERRED_FUNDING_POLICY_CHANGED'};
  try { validateOwnerDepositAmount(funding,legacyPlanYuanToCents(raw.deposit_amount),fullPayout==='1'); }
  catch { return {sourceId:row.sourceId,blocked:'FUNDING_DECLARATION_NOT_ACCEPTED'}; }
  let payoutTermsAvailable=null;
  if(fullPayout==='1'){
    try { const t=await readFullPayoutTerms(client,account.game_id,funding,terms[0].price_version_id);payoutTermsAvailable={versionId:t.termsVersionId,digest:t.termsDigest,disclosureVersion:t.disclosureVersion}; }
    catch { return {sourceId:row.sourceId,blocked:'SEALED_FULL_PAYOUT_TERMS_UNAVAILABLE'}; }
  }
  if(declaration.entitlements.length) return {sourceId:row.sourceId,blocked:'ENTITLEMENT_DISCLOSURE_REQUIRES_REVIEW'};
  let sourceQuote;
  try { sourceQuote=buildLegacyListedSourceQuote({sourceCanonical:sourceRow.canonical,
    source:{sourceSystem:source.sourceSystem,sourceEntity:source.sourceEntity,legacyId:source.legacyId,sourceDigest:source.sourceDigest,observationVersionId:source.expectedObservationVersionId},
    policyCanonical:reviewed.policyCanonical,policyBinding:sourceRow.policyBinding,display:r.snapshot,catalog,declaredInventory:draft.draft.inventory,
    termOption:{dailyConsumption:terms[0].dailyConsumption,durationRounding:terms[0].durationRounding},priceVersionId:terms[0].price_version_id,ruleReleaseId:terms[0].release_id,
    publisherBailRequirementCents:funding.guaranteeRequirement.mode==='NOT_REQUIRED'?'0':funding.guaranteeRequirement.requiredCents,expiryDisclosures:[]}); }
  catch { return {sourceId:row.sourceId,blocked:'SOURCE_QUOTE_OR_TERM_UNAVAILABLE'}; }
  if(deferredCredit && BigInt(legacyPlanYuanToCents(sourceQuote.quote.resourceTotal.amount))<=0n)return {sourceId:row.sourceId,blocked:'SOURCE_QUOTE_NOT_POSITIVE'};
  const body = actionBody({ ...row,titleBasis }, intake,reviewed.receiptSha);
  return { sourceId: row.sourceId, releaseId: terms[0].release_id, referenceDigest: reference.digest,
    priorVersion:previouslyPublished?{versionId:version.id,contentHash:version.content_hash}:null,
    sourceQuoteDigest:sha(canonicalize(sourceQuote.quote)),policyDigest:sourceQuote.provenance.sourcePolicyDigest,payoutTermsAvailable,...(deferredCredit?{deferredCredit}:{}),body, ...binding(body) };
}

async function runPublication(row) {
  const requestId = `listed_takeover_${row.sourceId}`;
  await setAuditContext(client, "admin", actor.id, actor.sessionId, requestId);
  const release = (await client.query("SELECT current_release_id FROM zzsh_supply.game WHERE id=$1", [row.body.intake.source.expectedGameId])).rows[0];
  if (release?.current_release_id !== row.releaseId || !await readLegacyPublishedReference(client, row.body.intake.accountId, row.referenceDigest))
    throw new Error("REVIEWED_RELEASE_OR_REFERENCE_CHANGED");
  if(row.body.intake.isFullPayout==='1'){
    const funding=await readFundingPolicyForRelease(client,row.releaseId);
    if(!funding)throw new Error('FUNDING_POLICY_CHANGED');
    const policy=(await client.query(`SELECT price_version_id FROM zzsh_supply.rule_release WHERE id=$1`,[row.releaseId])).rows[0];
    if(!policy)throw new Error('REVIEWED_RELEASE_OR_REFERENCE_CHANGED');
    const t=await readFullPayoutTerms(client,row.body.intake.source.expectedGameId,funding,policy.price_version_id);
    if(canonicalize({versionId:t.termsVersionId,digest:t.termsDigest,disclosureVersion:t.disclosureVersion})!==canonicalize(row.payoutTermsAvailable))
      throw new Error('REVIEWED_FULL_PAYOUT_TERMS_CHANGED');
  }
  const deferred=row.deferredCredit?deferredCreditGateForRow(row,{gate,readCurrentVersion,readPublishingAccount,readGuaranteeContext,threshold:CREDIT_GUARANTEE_THRESHOLD}):null;
  const takeoverGate=deferred?.gate??(creditGuaranteeEnabled?rejectUnmarkedObservation(row,gate):gate);
  const result = await takeoverLegacyTrade(client, { id: actor.id, sessionId: actor.sessionId, requestId }, row.body, takeoverGate);
  if(deferred)await deferred.assertReady(client,result.replayed);
  if (result.status !== 200 || result.body?.state !== "PUBLISHED") throw new Error("FORMAL_PUBLICATION_NOT_READY");
  const quote=(await client.query(`SELECT e.quote_digest,e.policy_digest FROM zzsh_supply.legacy_listed_quote_evidence e
    JOIN zzsh_supply.listing_version v ON v.id=e.listing_version_id AND v.account_id=e.account_id
    WHERE e.listing_version_id=$1 AND e.account_id=$2 AND v.content_hash=$3`,[result.body.versionId,row.body.intake.accountId,result.body.contentHash])).rows[0];
  if(quote?.quote_digest!==row.sourceQuoteDigest || quote.policy_digest!==row.policyDigest)throw new Error('SOURCE_QUOTE_READBACK_MISMATCH');
  if(row.priorVersion && !(await client.query(`SELECT 1 FROM zzsh_supply.listing_version v JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=v.account_id
      WHERE v.id=$1 AND v.account_id=$2 AND v.content_hash=$3 AND p.content_hash=$3 AND p.source='LEGACY_APPROVED'`,
    [row.priorVersion.versionId,row.body.intake.accountId,row.priorVersion.contentHash])).rowCount)throw new Error('PRIOR_PUBLICATION_CHANGED');
  return result;
}

try {
  if (action === "--execute" || action === "--trial") {
    const passwordFile = option("--maintenance-password-file");
    if (!isAbsolute(passwordFile ?? "")) throw new Error("MAINTENANCE_LOCK_CREDENTIAL_REQUIRED");
    maintenance = new Client(maintenanceConnection(registered, { user: "zzsh",
      password: readFileSync(passwordFile, "utf8").trim(), connectionTimeoutMillis: 3000, statement_timeout: 5000,
      applicationName: "legacy-listed-maintenance-lock" }));
    await maintenance.connect();
    if (!(await maintenance.query(advisoryLockSql(registered, "try"))).rows[0]?.ok) throw new Error("RESOURCE_MAINTENANCE_BUSY");
  }
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
  const live = (await client.query(targetIdentityQuery())).rows[0];
  assertLiveTarget(registered, live, roleKind);
  if (live.oid !== oid || live.nonce !== nonce || live.marker !== "zzsh:regression-test:v1" || live.role !== role.name
    || live.role_oid !== role.oid) throw new Error("LIVE_TARGET_CHANGED");
  await assertAdminContextInTransaction(client, { userId: actor.id, sessionId: actor.sessionId });
  if(action==='--execute'||action==='--trial'){
    await assertBusinessMigrationPrefix(client,migrationsFolder);
    const witness=(await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_business_meta.migrations WHERE hash=$1 AND created_at=$2) AS installed,
      to_regclass('zzsh_supply.legacy_listed_policy_evidence') IS NOT NULL AND to_regclass('zzsh_supply.legacy_listed_quote_evidence') IS NOT NULL AS evidence_ready,
      has_table_privilege($3,'zzsh_supply.legacy_listed_policy_evidence','SELECT') AND has_table_privilege($3,'zzsh_supply.legacy_listed_quote_evidence','SELECT') AS runtime_reads,
      has_table_privilege($3,'zzsh_supply.legacy_listed_policy_evidence','INSERT,UPDATE,DELETE,TRUNCATE') OR has_table_privilege($3,'zzsh_supply.legacy_listed_quote_evidence','INSERT,UPDATE,DELETE,TRUNCATE') AS runtime_writes`,
      [compiled.listedMigration,String(migrationEntry.when),credentials.runtime.name])).rows[0];
    if(!witness?.installed || !witness.evidence_ready || !witness.runtime_reads || witness.runtime_writes)throw new Error('LISTED_MIGRATION_OR_RUNTIME_ACL_NOT_READY');
  }
  if (action === "--prepare") {
    if (!["zzsh.listed-source-continuity-plan.v1", "zzsh.listed-source-continuity-plan.v2"].includes(input.schema) || !Array.isArray(input.listings) || input.listings.length<1 || input.listings.length>10000
      || new Set(input.listings.map(row => row.sourceId)).size !== input.listings.length) throw new Error("LISTED_SOURCE_POPULATION_REQUIRED");
    const reviewed=await readReviewedSource();
    const rows = [];
    for (const row of input.listings) rows.push(await prepareRow(row,reviewed));
    await client.query("ROLLBACK"); transaction = false;
    newPrivateDirectory(out);
    const bytes = JSON.stringify({ schema: "zzsh.legacy-listed-execution-plan.v2", target, compiled, sourcePlanSha256: inputSha,
      sourceReceiptSha256:reviewed.receiptSha,policyBundleSha256:reviewed.policySha,policyAuthoritySha256:reviewed.authoritySha,sourceAccountCount:input.listings.length,creditGuaranteeEnabled, ...(input.roundBinding ? {sourcePlanSchema:input.schema,roundBinding:input.roundBinding} : {}), rows }, null, 2) + "\n";
    writeFileSync(join(out, "plan.json"), bytes, { flag: "wx" });
    console.log(JSON.stringify({ status: "PREPARED_TARGET_READ_ONLY", ready: rows.filter(row => row.body).length,
      blocked: rows.filter(row => row.blocked), planSha256: sha(bytes) }));
  } else {
    const rows = validateLegacyListedExecutionPlan(input,target,compiled,canonicalize,binding);
    for(const row of rows)if(row.deferredCredit && (row.deferredCredit.kind!=='FROZEN_QUOTE_REQUIRED'||!/^[1-9]\d*$/.test(row.deferredCredit.creditRevision??'')||!input.creditGuaranteeEnabled||row.priorVersion))throw new Error('DEFERRED_CREDIT_PLAN_INVALID');
    if(input.creditGuaranteeEnabled&&rows.some(row=>row.priorVersion===null&&!row.deferredCredit))throw new Error('DEFERRED_CREDIT_PLAN_REQUIRED');
    if (requiresFullRollbackTrial(action,input,rows)) {
      const trialBytes=readFileSync(privatePath(option('--trial-receipt')));
      if (sha(trialBytes)!==option('--trial-receipt-sha')) throw new Error('LISTED_TRIAL_RECEIPT_SHA_CHANGED');
      validateRoundTrialReceipt(JSON.parse(trialBytes),inputSha,target,rows,canonicalize);
    }
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
        if(row.deferredCredit){await lockDeferredLegacyCreditTables(client);const others=(await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()")).rows[0];if(others?.n!==0)throw new Error('DEFERRED_REQUIRES_EXCLUSIVE_MAINTENANCE');}
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
        if(row.deferredCredit){await lockDeferredLegacyCreditTables(client);const others=(await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()")).rows[0];if(others?.n!==0)throw new Error('DEFERRED_REQUIRES_EXCLUSIVE_MAINTENANCE');}
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
