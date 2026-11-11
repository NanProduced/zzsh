import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { acquireMigrationTransactionFence, advisoryLockSql, assertLiveTarget, assertMigrationFenceHeld, assertNextMigrationWriteReady, captureMaintenanceLockEpoch, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, targetConnection, targetIdentityQuery } from "./local-target-registry.mjs";
import { execFileSync } from "node:child_process";
import { LocalSession, localOrigin, totp, validateProfile, writePrivate } from "../local-auth.mjs";
import { verifySkinRetirementPackage } from "./derive-business-reference-skin-retirement.mjs";
import { initializeLegalPair, prepareLegalPair, readPinnedRegularFile } from "./local-legal-pair.mjs";
import { assertRentalReferenceReady, BUSINESS_REFERENCE_TABLES, readTargetRentalReference } from "./business-reference-readiness.mjs";
const processStarted = performance.now(), processStartedAt = new Date().toISOString();
const require = createRequire(import.meta.url), { Client, Pool } = require("pg");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const BUSINESS_KIND = "BUSINESS_REFERENCE_PACKAGE_V1";
const businessTables = new Set([...BUSINESS_REFERENCE_TABLES, "zzsh_supply.skin_category"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const q = name => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("UNSAFE_REFERENCE_IDENTIFIER"); return '"' + name + '"'; };
if (!args.includes("--execute") && !args.includes("--verify")) {
    console.log(JSON.stringify({ action: "PLAN", required: ["--execute", "--manifest", "--manifest-sha", "--oid", "--nonce", "--credentials", "--receipt"], formalAdminInitialization: { required: ["--execute", "--initialize-admins", "--stage", "--input", "--credentials", "--out"], stages: ["bosses", "staff"], serverAssignedFirstLogins: ["zz00001", "zz00002"], sequenceMinimumDigits: 5, noImRuntimeBindingRequired: true, sequence: "formal Boss bootstrap/enrollment -> business package -> formal ops/support create/enrollment", oldAdminRestore: "SUPERSEDED_NOT_FOR_APPLICATION" }, businessPackage: { capture: ["--execute", "--capture-business", "--credentials", "--source-oid", "--game-code", "--out"], applyAdditional: ["--maintenance-admin-id", "--maintenance-session-id", "--legal-input", "--legal-input-sha"], verify: ["--verify", "--manifest", "--manifest-sha"], tables: [...businessTables], identityPolicy: "business package contains no identities, sessions, upload tokens, approvals or transactions; bind newly initialized maintenance Boss" }, target: "registered regression only", connections: 0, credentialReads: 0, identityPolicy: "old admin restore SUPERSEDED_NOT_FOR_APPLICATION; initialize two Bosses and one ops/support using formal routes" }));
    process.exit(0);
}
if (process.version !== "v24.20.0")
    throw new Error("NODE_BASELINE_MISMATCH");
if (args.includes("--initialize-admins")) {
    if (!args.includes("--execute")) throw new Error("INITIALIZATION_EXECUTE_REQUIRED");
    await initializeFormalAdmins();
    process.exit(process.exitCode ?? 0);
}
if (args.includes("--capture-business")) {
    if (!args.includes("--execute")) throw new Error("CAPTURE_EXECUTE_REQUIRED");
    await captureBusinessPackage();
    process.exit(0);
}
const manifestFile = resolve(option("--manifest") ?? ""), root = dirname(manifestFile);
const bytes = readFileSync(manifestFile);
if (sha(bytes) !== option("--manifest-sha"))
    throw new Error("REFERENCE_MANIFEST_SHA_MISMATCH");
const source = JSON.parse(bytes);
const business = source.kind === BUSINESS_KIND;
if ((!business && source.kind !== "REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION") || source.transactionRollback !== true)
    throw new Error("REFERENCE_SNAPSHOT_NOT_REVIEWED");
if (business && source.catalogModel !== undefined && source.catalogModel !== "OWNER_KIND_V2") throw new Error("BUSINESS_CATALOG_PROFILE_UNSUPPORTED");
const skinV2 = business && source.catalogModel === "OWNER_KIND_V2";
const expectedBusinessTables = skinV2 ? new Set([...businessTables].filter(key => key !== "zzsh_supply.skin_category")) : businessTables;
const allowed = new Set(["zzsh_auth_admin.user", "zzsh_auth_admin.account", "zzsh_auth_admin.session", "zzsh_auth_admin.twoFactor", "zzsh_iam.admin_security", "zzsh_iam.admin_role", "zzsh_iam.admin_permission", "zzsh_iam.admin_role_permission", "zzsh_iam.admin_user_role", "zzsh_iam.admin_user_permission", "zzsh_iam.approval_template", "zzsh_iam.approval_template_candidate", "zzsh_iam.approval_request", "zzsh_iam.approval_request_candidate", "zzsh_iam.approval_decision", "zzsh_iam.approval_execution", "zzsh_iam.membership_growth_policy", "zzsh_iam.im_identity_mapping", "zzsh_iam.im_support_settings", "zzsh_supply.profile_avatar", "zzsh_supply.game", "zzsh_supply.game_service_operation", "zzsh_supply.skin_category", "zzsh_supply.firearm_classification", "zzsh_supply.firearm_alias", "zzsh_supply.full_payout_terms_version", "zzsh_supply.billable_item", "zzsh_supply.skin_rarity", "zzsh_supply.skin_owner", "zzsh_supply.firearm", "zzsh_supply.skin", "zzsh_supply.admin_supply_scope", "zzsh_supply.price_version", "zzsh_supply.price_line", "zzsh_supply.term_version", "zzsh_supply.term_option", "zzsh_supply.agreement_version", "zzsh_supply.rule_release", "zzsh_supply.media_upload_intent", "zzsh_supply.media_asset", "zzsh_content.legal_document_version"]);
const tables = new Map();
for (const descriptor of source.tables) {
    const key = descriptor.schema + "." + descriptor.table;
    if (tables.has(key) || !(business ? expectedBusinessTables : allowed).has(key) || descriptor.file !== basename(descriptor.file))
        throw new Error("REFERENCE_TABLE_NOT_ALLOWED");
    const raw = readFileSync(join(root, descriptor.file));
    if (sha(raw) !== descriptor.sha256)
        throw new Error("REFERENCE_TABLE_SHA_CHANGED:" + key);
    const table = JSON.parse(raw);
    if (table.schema !== descriptor.schema || table.table !== descriptor.table || table.rows.length !== descriptor.rows || table.rows.some(row => typeof row !== "string"))
        throw new Error("LOSSLESS_REFERENCE_ROWS_REQUIRED");
    if (business && args.includes("--admins-only")) throw new Error("BUSINESS_PACKAGE_HAS_NO_IDENTITIES");
    if (!business && args.includes("--admins-only") && !(key.startsWith("zzsh_auth_admin.") || ["zzsh_iam.admin_security", "zzsh_iam.admin_role", "zzsh_iam.admin_permission", "zzsh_iam.admin_role_permission", "zzsh_iam.admin_user_role", "zzsh_iam.admin_user_permission"].includes(key)))
        continue;
    tables.set(key, { ...table, key, sql: q(descriptor.schema) + "." + q(descriptor.table) });
}
if (skinV2) verifySkinRetirementPackage(bytes, name => {
    if (typeof name !== "string" || name !== basename(name)) throw new Error("UNSAFE_REFERENCE_IDENTIFIER");
    const file = join(root, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("UNSAFE_SKIN_LINEAGE_FILE");
    return readFileSync(file);
});
if (business && !skinV2 && tables.get("zzsh_supply.skin")?.columns?.filter(column => column.name === "category_id").length !== 1)
    throw new Error("BUSINESS_CATALOG_PROFILE_INVALID");
const parsedBusinessTables = business ? validateBusinessPackage(tables, source, expectedBusinessTables) : null;
const rentalReference = skinV2 ? { ...assertRentalReferenceReady(parsedBusinessTables, source.gameCode),
    validatorSha256: sha(readFileSync(new URL('./business-reference-readiness.mjs', import.meta.url))) } : undefined;
if (!business && (tables.get("zzsh_auth_admin.user")?.rows.length !== 5 || tables.get("zzsh_iam.admin_security")?.rows.length !== 5)) throw new Error("REVIEWED_FIVE_ADMIN_IDENTITY_CLOSURE_REQUIRED");
if (args.includes("--verify")) {
    console.log(JSON.stringify({ status: "REFERENCE_FILES_VERIFIED", kind: source.kind, tables: tables.size, rows: [...tables.values()].reduce((sum, table) => sum + table.rows.length, 0), connections: 0, credentialReads: 0, mediaBytesVerified: false, ...(rentalReference ? { rentalReference } : {}), ...(!business ? { applicationStatus: "SUPERSEDED_NOT_FOR_APPLICATION" } : {}) }));
    process.exit(0);
}
if (!business) throw new Error("ADMIN_REFERENCE_RESTORE_SUPERSEDED_NOT_FOR_APPLICATION");
if (!skinV2) throw new Error("BUSINESS_CATALOG_PROFILE_RETIRED");
const maintenanceAdminId = option("--maintenance-admin-id");
if (business && !maintenanceAdminId) throw new Error("EXISTING_MAINTENANCE_ADMIN_BINDING_REQUIRED");
const maintenanceSessionId = option("--maintenance-session-id"), legalInputFile = option("--legal-input"), legalInputSha = option("--legal-input-sha");
if (![maintenanceSessionId, legalInputFile, legalInputSha].every(value => typeof value === "string" && value.length > 0)
    || !isAbsolute(legalInputFile) || !/^[a-f0-9]{64}$/.test(legalInputSha)) throw new Error("BUSINESS_LEGAL_INPUT_REQUIRED");
const legalInputBytes = readPinnedRegularFile(legalInputFile);
if (sha(legalInputBytes) !== legalInputSha) throw new Error("BUSINESS_LEGAL_INPUT_CHANGED");
const legalInput = JSON.parse(legalInputBytes), apiDist = resolve(option("--api-dist") ?? join(ROOT, "apps/api/dist/src"));
const apiRelative = relative(ROOT, apiDist);
if (!apiRelative || apiRelative.startsWith("..") || isAbsolute(apiRelative)) throw new Error("BUSINESS_LEGAL_BUILD_OUTSIDE_WORKTREE");
function verifyLegalBuild() {
    for (const name of ["legal/legal-documents.js", "auth/security-core.js", "supply/content-hash.js", "supply/supply-util.js"]) {
        const expected = legalInput.build?.[name], path = join(apiDist, name);
        if (!/^[a-f0-9]{64}$/.test(expected ?? "") || sha(readPinnedRegularFile(path, 1_000_000)) !== expected) throw new Error("BUSINESS_LEGAL_BUILD_CHANGED");
    }
}
verifyLegalBuild();
const legalService = require(join(apiDist, "legal/legal-documents.js")), legalAudit = require(join(apiDist, "auth/security-core.js")).recordAudit;
const legalReadBytes = path => readPinnedRegularFile(path);
const preparedLegal = prepareLegalPair(legalInput, legalReadBytes, legalService);
if (business) for (const table of tables.values()) {
    const fields = source.foreignKeys.filter(fk => fk.child === table.key && fk.parent === "zzsh_auth_admin.user").flatMap(fk => fk.columns);
    // Preserve sealed source bytes; replace only existing non-null attribution IDs in the target input.
    table.rows = table.rows.map(raw => fields.reduce((row, field) => row.replace(new RegExp('("' + field + '"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"'), (_, prefix) => prefix + JSON.stringify(maintenanceAdminId)), raw));
}
const expectedOid = option("--oid"), expectedNonce = option("--nonce"), credentialFile = option("--credentials");
if (!expectedOid || !expectedNonce || !credentialFile)
    throw new Error("EXACT_TARGET_BINDING_REQUIRED");
const registered = loadRegisteredTarget(credentialFile);
const credentials = JSON.parse(readFileSync(credentialFile));
if (registered.database !== "zzsh_test_regression" || registered.oid !== expectedOid || registered.nonce !== expectedNonce || registered.pendingReset || credentials.migration?.name !== registered.migrationRole || (registered.migrationRoleOid !== null && credentials.migration?.oid !== registered.migrationRoleOid))
    throw new Error("REGISTERED_RESOURCE_CHANGED");
const receiptFile = resolve(option("--receipt") ?? "");
if (!receiptFile.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || existsSync(receiptFile))
    throw new Error("NEW_PRIVATE_RECEIPT_REQUIRED");
const result = { status: "STARTED", kind: source.kind, catalogModel: source.catalogModel, manifestSha256: sha(bytes), database: registered.database, oid: expectedOid, nonce: expectedNonce, ...(registered.instance ? {instance:registered.instance} : {}), ...(registered.migrationProfile ? {migrationProfile:registered.migrationProfile} : {}), startedAt: processStartedAt, tables: [], expectedDifferences: [], pending: [], sourceIdsPreserved: true, sourceRawUnchanged: true, ...(business ? { maintenanceAdminId, attributionPolicy: "non-null source admin FKs rebound; original attribution remains in sealed source", mediaBytesVerified: false, rentalReference } : {}) };
const cfg = { connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 };
const maintenance = new Client(maintenanceConnection(registered, { ...cfg, user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? join(ROOT, "apps/api/.secrets/postgres_password"), "utf8").trim(), applicationName: "core-reference-bootstrap-lock" }));
const pool = new Pool(targetConnection(registered, { ...cfg, user: credentials.migration.name, password: credentials.migration.password, max: 1, applicationName: "core-reference-bootstrap" }));
let client, held = false, begun = false, commitSent = false, fenceEpoch, connectionError;
maintenance.on?.("error", error => { connectionError ??= error; });
const STATIC = new Set(["zzsh_iam.admin_permission", "zzsh_iam.admin_role", "zzsh_iam.admin_role_permission", "zzsh_iam.approval_template"]);
// A package captured in one environment carries that environment's provenance timestamps. A target's
// own triggers rewrite created_at/updated_at on insert, so those two columns can never match across
// environments. Only these tables may differ on those two columns and only while every other field
// is byte-identical; the difference is recorded, never ignored silently.
const CROSS_ENVIRONMENT_TIMESTAMP_TABLES = new Set(["zzsh_supply.price_version", "zzsh_supply.rule_release", "zzsh_supply.price_line"]);
const timestampDifference = (table, result) => result.expectedDifferences.push({ table: table.key, fields: ["created_at", "updated_at", "sealed_at", "activated_at"], basis: "cross-environment import: target triggers own these provenance timestamps; every other field is byte-identical" });
const versions = new Set(["zzsh_supply.price_version", "zzsh_supply.term_version", "zzsh_supply.agreement_version", "zzsh_supply.full_payout_terms_version"]);
const fixedJson = (base, field, value) => `jsonb_set(${base},'{${field}}',${value},true)`;
function stageExpression(table) { let body = "$1::jsonb"; if (table.key === "zzsh_supply.game") {
    body = fixedJson(body, "current_release_id", "'null'::jsonb");
    body = fixedJson(body, "cover_media_id", "'null'::jsonb");
} if (table.key === "zzsh_supply.skin") {
    for (const field of ["media_id","media_source","owner_kind","owner_id","firearm_id","base_name"]) body=fixedJson(body,field,"'null'::jsonb");
    body=fixedJson(body,"naming_state","to_jsonb('PENDING'::text)");body=fixedJson(body,"enabled","'false'::jsonb");body=fixedJson(body,"form_visible","'false'::jsonb");
} if (table.key === "zzsh_supply.media_upload_intent") {
    body = fixedJson(body, "consumed_asset_id", "'null'::jsonb");
    body = fixedJson(body, "consumed_at", "'null'::jsonb");
} if (table.key === "zzsh_iam.admin_security") {
    body = fixedJson(body, "status", "'\"PENDING_ENROLLMENT\"'::jsonb");
    body = fixedJson(body, "first_activated_at", "'null'::jsonb");
} if (versions.has(table.key)) {
    body = fixedJson(body, "status", "'\"DRAFT\"'::jsonb");
    body = fixedJson(body, "sealed_by_admin_id", "'null'::jsonb");
    body = fixedJson(body, "sealed_at", "'null'::jsonb");
    if (table.key === "zzsh_supply.full_payout_terms_version")
        body = fixedJson(body, "revision", "to_jsonb(CASE WHEN ($1::jsonb)->>'status'='SEALED' THEN GREATEST((($1::jsonb)->>'revision')::bigint-1,0) ELSE (($1::jsonb)->>'revision')::bigint END)");
} return body; }
async function keyCondition(table) { if (table.pk)
    return table.pk; table.pk = (await client.query(`SELECT a.attname name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY keys(attnum,n) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=keys.attnum WHERE k.conrelid=$1::regclass AND k.contype='p' ORDER BY keys.n`, [table.sql])).rows.map(r => r.name); if (!table.pk.length)
    throw new Error("REFERENCE_PRIMARY_KEY_REQUIRED:" + table.key); return table.pk; }
async function existing(table, row) { const pk = await keyCondition(table); return (await client.query(`SELECT to_jsonb(t)=$1::jsonb AS exact,to_jsonb(t)-ARRAY['created_at','updated_at']::text[]=($1::jsonb)-ARRAY['created_at','updated_at']::text[] AS semantic,(to_jsonb(t)-'updated_at')=($1::jsonb-'updated_at') AS restore_time_only,(to_jsonb(t)-ARRAY['created_at','updated_at','sealed_at','activated_at']::text[])=(($1::jsonb)-ARRAY['created_at','updated_at','sealed_at','activated_at']::text[]) AS version_time_only FROM ${table.sql} t CROSS JOIN jsonb_populate_record(NULL::${table.sql},$1::jsonb) s WHERE ${pk.map(k => `t.${q(k)} IS NOT DISTINCT FROM s.${q(k)}`).join(" AND ")}`, [row])).rows[0]; }
async function insertTable(table) { const fields = table.columns.filter(c => !c.generated).map(c => c.name); for (const row of table.rows) {
    let found = await existing(table, row);
    if (!found && table.key === "zzsh_iam.approval_template") {
        const natural=(await client.query("SELECT t.id,(to_jsonb(t)-ARRAY['id','created_at','updated_at']::text[])=($1::jsonb-ARRAY['id','created_at','updated_at']::text[]) AS same FROM zzsh_iam.approval_template t CROSS JOIN jsonb_populate_record(NULL::zzsh_iam.approval_template,$1::jsonb) s WHERE t.operation_code=s.operation_code AND t.trigger_condition=s.trigger_condition",[row])).rows[0];
        if (natural) {
            const uses=(await client.query("SELECT (SELECT count(*) FROM zzsh_iam.approval_request WHERE template_id=$1)+(SELECT count(*) FROM zzsh_iam.approval_template_candidate WHERE template_id=$1) AS n",[natural.id])).rows[0].n;
            if (!natural.same || String(uses)!=="0") throw new Error("REFERENCED_OR_DIFFERENT_DEFAULT_TEMPLATE");
            await client.query("UPDATE zzsh_iam.approval_template t SET id=s.id FROM jsonb_populate_record(NULL::zzsh_iam.approval_template,$1::jsonb) s WHERE t.id=$2",[row,natural.id]);
            result.expectedDifferences.push({table:table.key,oldId:natural.id,adoptedSourceId:JSON.parse(row).id,basis:"identical natural-key semantics; unused default seed identity aligned before source FK restoration"});
            found=await existing(table,row);
        }
    }
    if (found) {
        if (found.exact)
            continue;
        // The legal skin restore touches updated_at; retain that target timestamp on replay.
        // The same single-field comparison is used by restoreTable and the final readback.
        if (table.key === "zzsh_supply.skin" && found.restore_time_only)
            continue;
        if (STATIC.has(table.key) && found.semantic) {
            result.expectedDifferences.push({ table: table.key, fields: ["created_at", "updated_at"], basis: "baseline seed provenance timestamps retained; all other fields equal" });
            continue;
        }
        if (CROSS_ENVIRONMENT_TIMESTAMP_TABLES.has(table.key) && found.version_time_only) {
            timestampDifference(table, result);
            continue;
        }
        throw new Error("REFERENCE_EXISTING_ROW_DIFFERS:" + table.key);
    }
    await client.query(`INSERT INTO ${table.sql} (${fields.map(q).join(",")}) SELECT ${fields.map(c => `s.${q(c)}`).join(",")} FROM jsonb_populate_record(NULL::${table.sql},${stageExpression(table)}) s`, [row]);
} result.tables.push({ table: table.key, rows: table.rows.length, inserted: true }); }
async function restoreTable(table, filter = () => true, override) { const fields = table.columns.filter(c => !c.generated).map(c => c.name), pk = await keyCondition(table); for (const row of table.rows) {
    const parsed = JSON.parse(row);
    if (!filter(parsed))
        continue;
    const observed=await existing(table,row);
    if (observed?.exact || table.key==="zzsh_supply.skin"&&observed?.restore_time_only) continue;
    const body = override ? override : "$1::jsonb";
    await client.query(`UPDATE ${table.sql} t SET ${fields.filter(c => !pk.includes(c)).map(c => `${q(c)}=${table.key==="zzsh_supply.skin"&&c==="naming_state"?"t":"s"}.${q(c)}`).join(",")} FROM jsonb_populate_record(NULL::${table.sql},${body}) s WHERE ${pk.map(k => `t.${q(k)} IS NOT DISTINCT FROM s.${q(k)}`).join(" AND ")}`, [row]);
} }
async function sealVersions() { for (const key of versions) {
    const table = tables.get(key);
    if (table)
        await restoreTable(table, row => row.status === "SEALED");
} }
try {
    await maintenance.connect();
    held = (await maintenance.query(advisoryLockSql(registered, "try"))).rows[0].ok;
    if (!held)
        throw new Error("REGRESSION_RESOURCE_BUSY");
    if (registered.migrationProfile === NEXT_MIGRATION_PROFILE) fenceEpoch = await captureMaintenanceLockEpoch(maintenance, registered);
    client = await pool.connect();
    client.on?.("error", error => { connectionError ??= error; });
    const identity = (await client.query(targetIdentityQuery())).rows[0];
    assertLiveTarget(registered, identity);
    if (identity.oid !== expectedOid || identity.nonce !== expectedNonce || identity.owner !== "zzsh" || identity.marker !== "zzsh:regression-test:v1" || identity.role !== credentials.migration.name || identity.role_oid !== credentials.migration.oid)
        throw new Error("REFERENCE_TARGET_IDENTITY_CHANGED");
    if (fenceEpoch) {
        await client.query("BEGIN"); begun = true;
        await acquireMigrationTransactionFence(client, registered, fenceEpoch); result.targetFence = "HELD_UNTIL_TRANSACTION_END";
    }
    if (skinV2) {
        const schema = (await client.query(`SELECT to_regclass('zzsh_supply.skin_category') IS NULL AS "categoryTableAbsent",
            NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_supply.skin') AND attname='category_id' AND attnum>0 AND NOT attisdropped) AS "categoryColumnAbsent"`)).rows[0];
        if (schema?.categoryTableAbsent !== true || schema?.categoryColumnAbsent !== true) throw new Error("BUSINESS_CATALOG_PROFILE_SCHEMA_MISMATCH");
    }
    const admin = tables.get("zzsh_auth_admin.user");
    if (admin) {
        const ids = admin.rows.map(row => JSON.parse(row).id);
        const alien = (await client.query('SELECT count(*)::int n FROM zzsh_auth_admin."user" WHERE id<>ALL($1::text[])', [ids])).rows[0].n;
        if (alien !== 0)
            throw new Error("TARGET_HAS_NONREFERENCE_ADMIN");
    }
    for (const table of tables.values()) { const columns=(await client.query("SELECT attname AS name FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped",[table.sql])).rows.map(row=>row.name);if(!columns.length||table.columns.some(column=>!columns.includes(column.name)))throw new Error("REFERENCE_TARGET_COLUMNS_MISMATCH:"+table.key);}
    if (!begun) { await client.query("BEGIN"); begun = true; }
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    if (business) {
        const actor = (await client.query(`SELECT a.is_boss,a.status,a.password_change_required,u.suspended,u."twoFactorEnabled" AS two_factor,s.locked
          FROM zzsh_iam.admin_security a JOIN zzsh_auth_admin."user" u ON u.id=a.admin_user_id
          JOIN zzsh_auth_admin.session s ON s."userId"=u.id AND s.id=$2 AND s."expiresAt">clock_timestamp()
          WHERE a.admin_user_id=$1 FOR SHARE OF a,u,s`, [maintenanceAdminId,maintenanceSessionId])).rows[0];
        if (!actor?.is_boss || actor.status !== "ACTIVE" || actor.suspended || actor.password_change_required || actor.two_factor !== true || actor.locked)
            throw new Error("ACTIVE_EXISTING_MAINTENANCE_ADMIN_REQUIRED");
    }
    await client.query("SELECT set_config('zzsh.actor_type','system',true),set_config('zzsh.request_id','reference-bootstrap',true)");
    const constraints = (await client.query("SELECT sn.nspname||'.'||sc.relname child,pn.nspname||'.'||pc.relname parent,a.attname column_name FROM pg_constraint k JOIN pg_class sc ON sc.oid=k.conrelid JOIN pg_namespace sn ON sn.oid=sc.relnamespace JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace CROSS JOIN LATERAL unnest(k.conkey) att JOIN pg_attribute a ON a.attrelid=sc.oid AND a.attnum=att WHERE k.contype='f'")).rows;
    const skip = new Set(["zzsh_supply.game:current_release_id", "zzsh_supply.game:cover_media_id", "zzsh_supply.skin:media_id", "zzsh_supply.media_upload_intent:consumed_asset_id"]);
    const dependencies = new Map([...tables.keys()].map(key => [key, new Set(constraints.filter(c => c.child === key && c.parent !== key && tables.has(c.parent) && !skip.has(key + ":" + c.column_name)).map(c => c.parent))]));
    const priority = key => key === "zzsh_supply.rule_release" ? 900 : key === "zzsh_iam.membership_growth_policy" ? 1000 : key === "zzsh_iam.admin_security" ? 5 : key.startsWith("zzsh_auth_admin.") ? 0 : key === "zzsh_supply.price_line" || key === "zzsh_supply.term_option" ? 50 : 10;
    const remaining = new Set(tables.keys()), done = new Set();
    let sealed = false;
    while (remaining.size) {
        const available = [...remaining].filter(key => [...dependencies.get(key)].every(dep => done.has(dep))).sort((a, b) => priority(a) - priority(b));
        if (!available.length)
            throw new Error("REFERENCE_FK_CYCLE:" + [...remaining].join(","));
        const key = available[0], table = tables.get(key);
        if (key === "zzsh_supply.rule_release" && !sealed) {
            await sealVersions();
            sealed = true;
        }
        if (key === "zzsh_supply.skin_category") {
            const pending = [...table.rows], ordered = [], known = new Set();
            while (pending.length) {
                const index = pending.findIndex(raw => { const r = JSON.parse(raw); return r.parent_id === null || known.has(r.parent_id); });
                if (index < 0)
                    throw new Error("SKIN_CATEGORY_SOURCE_CYCLE");
                const [row] = pending.splice(index, 1);
                ordered.push(row);
                known.add(JSON.parse(row).id);
            }
            table.rows = ordered;
        }
        if (key === "zzsh_supply.rule_release")
            table.rows.sort((a, b) => { const x = JSON.parse(a), y = JSON.parse(b); if (x.game_id !== y.game_id)
                return x.game_id < y.game_id ? -1 : 1; const left = BigInt(/"generation"\s*:\s*([0-9]+)/.exec(a)?.[1] ?? 'INVALID'), right = BigInt(/"generation"\s*:\s*([0-9]+)/.exec(b)?.[1] ?? 'INVALID'); return left < right ? -1 : left > right ? 1 : 0; });
        await insertTable(table);
        if (key === "zzsh_iam.admin_security") {
            await restoreTable(table, row => row.first_activated_at !== null, fixedJson("$1::jsonb", "status", "'\"ACTIVE\"'::jsonb"));
            await restoreTable(table);
        }
        if (key === "zzsh_supply.full_payout_terms_version")
            await restoreTable(table, row => row.status === "SEALED");
        remaining.delete(key);
        done.add(key);
    }
    if (!sealed)
        await sealVersions();
    for (const key of ["zzsh_supply.skin", "zzsh_supply.media_upload_intent", "zzsh_supply.game"]) {
        const table = tables.get(key);
        if (table)
            await restoreTable(table);
    }
    result.legal = { ...(await initializeLegalPair(client, { id: maintenanceAdminId, sessionId: maintenanceSessionId,
        requestId: "reference-legal-" + sha(legalInputBytes).slice(0, 24) }, preparedLegal, legalService, legalAudit)), inputSha256: legalInputSha };
    if (sha(readPinnedRegularFile(legalInputFile)) !== legalInputSha) throw new Error("BUSINESS_LEGAL_INPUT_CHANGED");
    verifyLegalBuild();
    prepareLegalPair(legalInput, legalReadBytes, legalService);
    if (sha(readFileSync(new URL('./business-reference-readiness.mjs', import.meta.url))) !== rentalReference.validatorSha256) throw new Error("BUSINESS_RENTAL_REFERENCE_VALIDATOR_CHANGED");
    for (const table of tables.values()) {
        let exact = 0, semantic = 0;
        for (const row of table.rows) {
            const found = await existing(table, row);
            if (found?.exact)
                exact++;
        else if (STATIC.has(table.key) && found?.semantic || CROSS_ENVIRONMENT_TIMESTAMP_TABLES.has(table.key) && found?.version_time_only || table.key==="zzsh_supply.skin"&&found?.restore_time_only) {
            semantic++;if(table.key==="zzsh_supply.skin")result.expectedDifferences.push({table:table.key,fields:["updated_at"],basis:"legal PENDING→derived VERIFIED restore; database touch timestamp, source timestamp remains in sealed source file"});else if(CROSS_ENVIRONMENT_TIMESTAMP_TABLES.has(table.key))timestampDifference(table,result);
            }
            else
                throw new Error("REFERENCE_FINAL_ROW_DIFFERS:" + table.key);
        }
        const entry = result.tables.find(t => t.table === table.key);
        entry.exact = exact;
        entry.baselineTimestampOnly = semantic;
    }
    const targetReference = await readTargetRentalReference(client, source.gameCode);
    for (const field of ['gameCode', 'termOptions', 'enabledItems', 'fullPayout'])
        if (targetReference[field] !== rentalReference[field]) throw new Error('BUSINESS_RENTAL_TARGET_SOURCE_MISMATCH');
    if (JSON.stringify(targetReference.tableCounts) !== JSON.stringify(rentalReference.tableCounts)) throw new Error('BUSINESS_RENTAL_TARGET_SOURCE_MISMATCH');
    result.rentalReference.targetDigest = targetReference.targetDigest;
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    if (fenceEpoch) {
        if (connectionError) throw new Error("REFERENCE_FENCE_CONNECTION_LOST");
        await assertMigrationFenceHeld(client, registered, fenceEpoch);
        if (connectionError) throw new Error("REFERENCE_FENCE_CONNECTION_LOST");
    }
    commitSent = true;
    if ((await client.query("COMMIT")).command !== "COMMIT") throw new Error("REFERENCE_COMMIT_ACK_UNCONFIRMED");
    begun = false;
    result.commitAck = true;
    result.status = "REFERENCE_BOOTSTRAP_COMMITTED";
    const actors = (await client.query(`SELECT u.id,s.id AS session_id,s."expiresAt" expires_at FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id JOIN zzsh_auth_admin.session s ON s."userId"=u.id WHERE a.is_boss AND a.status='ACTIVE' AND NOT u.suspended AND NOT a.password_change_required AND s."expiresAt">clock_timestamp() AND NOT s.locked ORDER BY s."expiresAt" DESC LIMIT 1`)).rows;
    result.maintenanceActor = actors[0] ?? null;
}
catch (error) {
    result.status = commitSent ? result.commitAck ? "REFERENCE_COMMITTED_READBACK_REQUIRED" : "REFERENCE_COMMIT_UNKNOWN" : "FAILED_STOPPED";
    result.error = { code: typeof error.code === "string" && /^[A-Za-z0-9_]{1,30}$/.test(error.code) ? error.code : null,
        message: /^[A-Za-z0-9_:.-]{1,160}$/.test(error.message ?? "") ? error.message : "REFERENCE_OPERATION_FAILED",
        constraint: typeof error.constraint === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(error.constraint) ? error.constraint : null };
    if (begun && !commitSent)
        try {
            result.rollbackAck = (await client.query("ROLLBACK")).command === "ROLLBACK";
            if (!result.rollbackAck) result.status = "REFERENCE_ROLLBACK_UNKNOWN";
        }
        catch {
            result.rollbackAck = false;
            result.status = "REFERENCE_ROLLBACK_UNKNOWN";
        }
    process.exitCode = 1;
}
finally {
    try { client?.release(commitSent && !result.commitAck || result.rollbackAck === false ? true : undefined); }
    catch { result.clientReleaseFailed = true; }
    try { await pool.end(); result.poolClosed = true; } catch { result.poolClosed = false; }
    if (held)
        try {
            result.unlock = (await maintenance.query(advisoryLockSql(registered, "unlock"))).rows[0].ok;
        }
        catch {
            result.unlock = false;
        }
    try { await maintenance.end(); result.maintenanceClosed = true; } catch { result.maintenanceClosed = false; }
    if (!result.poolClosed || !result.unlock || !result.maintenanceClosed || result.clientReleaseFailed) {
        if (result.status === "REFERENCE_BOOTSTRAP_COMMITTED") result.status = "REFERENCE_COMMITTED_CLEANUP_UNCONFIRMED";
        process.exitCode = 1;
    }
    result.finishedAt = new Date().toISOString();
    result.wallMs = performance.now() - processStarted;
    writeFileSync(receiptFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: result.status, tables: result.tables.length, commitAck: result.commitAck, rollbackAck: result.rollbackAck, unlock: result.unlock, error: result.error }));
}

function validateBusinessPackage(tables, manifest, expectedTables = businessTables) {
    if (manifest.source?.database !== "zzsh_dev_daily" || manifest.source?.oid !== "2400547" || manifest.source?.read_only !== "on" || manifest.clientClosed !== true || !Array.isArray(manifest.foreignKeys) || tables.size !== expectedTables.size)
        throw new Error("BUSINESS_PACKAGE_SOURCE_OR_CLOSURE_REQUIRED");
    const rows = new Map();
    for (const table of tables.values()) {
        if (!Array.isArray(table.primaryKey) || !table.primaryKey.length) throw new Error("BUSINESS_PRIMARY_KEY_REQUIRED:" + table.key);
        const parsed = table.rows.map(raw => JSON.parse(raw)), seen = new Set();
        for (const row of parsed) {
            const values = table.primaryKey.map(column => row[column]);
            if (values.some(value => value == null) || seen.has(JSON.stringify(values))) throw new Error("BUSINESS_DUPLICATE_OR_MISSING_PRIMARY_KEY:" + table.key);
            seen.add(JSON.stringify(values));
            if (table.key === "zzsh_supply.media_asset" && (row.ownership_kind !== "PLATFORM_CATALOG" || row.owner_user_id !== null || row.uploaded_by_user_id !== null || row.account_id !== null)) throw new Error("BUSINESS_MEDIA_OWNERSHIP_REQUIRED");
        }
        rows.set(table.key, parsed);
    }
    if (rows.get("zzsh_supply.game").length !== 1 || rows.get("zzsh_supply.game")[0].code !== manifest.gameCode) throw new Error("EXPLICIT_SINGLE_GAME_REQUIRED");
    for (const fk of manifest.foreignKeys) {
        if (!tables.has(fk.child) || !Array.isArray(fk.columns) || !fk.columns.length || !Array.isArray(fk.parentColumns) || fk.columns.length !== fk.parentColumns.length) throw new Error("BUSINESS_FOREIGN_KEY_SHAPE");
        if (fk.parent === "zzsh_auth_admin.user" && JSON.stringify(fk.parentColumns) === '["id"]') continue;
        const parents = rows.get(fk.parent) ?? [];
        const keys = new Set(parents.map(row => JSON.stringify(fk.parentColumns.map(column => row[column]))));
        for (const row of rows.get(fk.child)) {
            const values = fk.columns.map(column => row[column]);
            if (values.some(value => value === undefined)) throw new Error("BUSINESS_FOREIGN_KEY_COLUMN_MISSING");
            if (values.every(value => value !== null) && !keys.has(JSON.stringify(values))) throw new Error("BUSINESS_FOREIGN_KEY_NOT_CLOSED:" + fk.child + ":" + fk.name);
        }
    }
    return rows;
}

async function captureBusinessPackage() {
    const credentialFile = option("--credentials"), output = option("--out"), gameCode = option("--game-code");
    if (!credentialFile || !output || !gameCode || option("--source-oid") !== "2400547") throw new Error("EXACT_READ_ONLY_SOURCE_BINDING_REQUIRED");
    const privateRoot = realpathSync("E:/zzsh-local-state/restricted"), out = resolve(output);
    if (dirname(out).toLowerCase() !== privateRoot.toLowerCase() || !/^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out)) || existsSync(out)) throw new Error("NEW_RESTRICTED_BOOTSTRAP_DIRECTORY_REQUIRED");
    const credentials = JSON.parse(readFileSync(credentialFile, "utf8"));
    if (credentials.database !== "zzsh_dev_daily" || credentials.host !== "127.0.0.1" || Number(credentials.port) !== 55432 || credentials.runtime?.user !== "zzsh_daily_r" || !credentials.runtime.password) throw new Error("EXACT_DAILY_RUNTIME_CREDENTIALS_REQUIRED");
    mkdirSync(out);
    const sid = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8" }).trim();
    if (!/^S-1-5-\d+(?:-\d+)+$/.test(sid)) throw new Error("LOCAL_IDENTITY_REQUIRED");
    execFileSync("icacls", [out, "/inheritance:r", "/grant:r", "*" + sid + ":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { stdio: "pipe" });
    const db = new Client({ host: credentials.host, port: credentials.port, database: credentials.database, user: credentials.runtime.user, password: credentials.runtime.password, connectionTimeoutMillis: 3000, statement_timeout: 15000, application_name: "data-first-business-reference-capture" });
    const manifest = { kind: BUSINESS_KIND, capturedAt: new Date().toISOString(), gameCode, tables: [], foreignKeys: [], sourceRawUnchanged: true, identityLayerIncluded: false, sourceMigrationDenominatorIncluded: false, perUserDerivationsIncluded: false, mediaBytesVerified: false, canonicalStaticSeeds: "initial responsibility; excluded", excluded: ["other games", "unreleased pricing/terms/agreements", "upload intents and tokens", "users/admins/sessions", "approvals", "growth/credit/deposit/distribution policies", "orders/payments/ledgers", "per-user avatar/growth/credit/deposit derivations"] };
    let begun = false, failure;
    try {
        await db.connect();
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
        await db.query("SET LOCAL TIME ZONE 'UTC'");
        manifest.source = (await db.query("SELECT current_database() database,d.oid::text,current_user role,r.oid::text role_oid,r.rolsuper,r.rolbypassrls,current_setting('transaction_read_only') read_only,transaction_timestamp()::text snapshot,shobj_description(d.oid,'pg_database') marker FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()")).rows[0];
        if (manifest.source.oid !== "2400547" || manifest.source.database !== credentials.database || manifest.source.role !== credentials.runtime.user || manifest.source.read_only !== "on" || manifest.source.rolsuper || manifest.source.rolbypassrls || manifest.source.marker !== "zzsh:local-daily:v1") throw new Error("BUSINESS_REFERENCE_SOURCE_IDENTITY_CHANGED");
        const games = (await db.query("SELECT id FROM zzsh_supply.game WHERE code=$1", [gameCode])).rows;
        if (games.length !== 1) throw new Error("EXPLICIT_SINGLE_GAME_REQUIRED");
        const gameId = games[0].id;
        const releases = "SELECT * FROM zzsh_supply.rule_release WHERE game_id=$1";
        const prices = `SELECT price_version_id FROM (${releases}) r`;
        for (const key of businessTables) {
            const [schema, table] = key.split("."), sql = q(schema) + "." + q(table);
            const columns = (await db.query("SELECT attname name,format_type(atttypid,atttypmod) type,attgenerated generated,attidentity identity FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum", [sql])).rows;
            const primaryKey = (await db.query("SELECT a.attname name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY keys(attnum,n) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=keys.attnum WHERE k.conrelid=$1::regclass AND k.contype='p' ORDER BY keys.n", [sql])).rows.map(row => row.name);
            let where = "game_id=$1", params = [gameId];
            if (table === "game") where = "id=$1";
            if (table === "price_version") where = `id IN (${prices})`;
            if (table === "price_line") where = `price_version_id IN (${prices})`;
            if (table === "term_version") where = `id IN (SELECT term_version_id FROM (${releases}) r)`;
            if (table === "term_option") where = `version_id IN (SELECT term_version_id FROM (${releases}) r)`;
            if (table === "agreement_version") where = `id IN (SELECT agreement_version_id FROM (${releases}) r)`;
            if (table === "full_payout_terms_version") where = `id IN (SELECT full_payout_terms_version_id FROM zzsh_supply.price_version WHERE id IN (${prices}))`;
            if (table === "legal_document_version") { where = "status='SEALED'"; params = []; }
            if (table === "media_asset") where = "id IN (SELECT media_id FROM zzsh_supply.skin WHERE game_id=$1 UNION SELECT media_id FROM zzsh_supply.billable_item WHERE game_id=$1 UNION SELECT media_id FROM zzsh_supply.firearm WHERE game_id=$1 UNION SELECT cover_media_id FROM zzsh_supply.game WHERE id=$1)";
            const rows = (await db.query(`SELECT to_jsonb(t)::text raw FROM ${sql} t WHERE ${where} ORDER BY to_jsonb(t)::text`, params)).rows.map(row => row.raw);
            const value = { schema, table, columns, primaryKey, rows }, raw = JSON.stringify(value) + "\n", file = key + ".json";
            writeFileSync(join(out, file), raw, { flag: "wx" });
            const sourceRows = (await db.query(`SELECT count(*)::text n FROM ${sql}`)).rows[0].n;
            manifest.tables.push({ schema, table, file, rows: rows.length, sourceRows, sha256: sha(raw) });
        }
        manifest.foreignKeys = (await db.query("SELECT sn.nspname||'.'||sc.relname child,pn.nspname||'.'||pc.relname parent,k.conname name,array_agg(sa.attname::text ORDER BY keys.n) columns,array_agg(pa.attname::text ORDER BY keys.n) AS \"parentColumns\" FROM pg_constraint k JOIN pg_class sc ON sc.oid=k.conrelid JOIN pg_namespace sn ON sn.oid=sc.relnamespace JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace CROSS JOIN LATERAL unnest(k.conkey,k.confkey) WITH ORDINALITY keys(child_num,parent_num,n) JOIN pg_attribute sa ON sa.attrelid=sc.oid AND sa.attnum=keys.child_num JOIN pg_attribute pa ON pa.attrelid=pc.oid AND pa.attnum=keys.parent_num WHERE k.contype='f' AND sn.nspname||'.'||sc.relname=ANY($1::text[]) GROUP BY sn.nspname,sc.relname,pn.nspname,pc.relname,k.conname ORDER BY child,name", [[...businessTables]])).rows;
        const tables = new Map(manifest.tables.map(descriptor => { const table = JSON.parse(readFileSync(join(out, descriptor.file))); return [descriptor.schema + "." + descriptor.table, { ...table, key: descriptor.schema + "." + descriptor.table }]; }));
        manifest.media = tables.get("zzsh_supply.media_asset").rows.map(raw => { const row = JSON.parse(raw); return Object.fromEntries(["id", "storage_key", "public_storage_key", "content_hash", "mime", "byte_size", "width", "height", "review_state", "technical_state"].map(field => [field, row[field]])); });
        await db.query("ROLLBACK"); begun = false; manifest.transactionRollback = true;
        // The connection must close before the manifest can represent a completed read.
        await db.end(); manifest.clientClosed = true;
        validateBusinessPackage(tables, manifest);
    } catch (error) { failure = error; }
    finally {
        if (begun) { try { await db.query("ROLLBACK"); manifest.transactionRollback = true; } catch { manifest.transactionRollback = false; } }
        if (!manifest.clientClosed) { await db.end(); manifest.clientClosed = true; }
    }
    if (failure) {
        writeFileSync(join(out, "capture-failed.json"), JSON.stringify({ ...manifest, error: { code: failure.code, message: failure.message } }, null, 2) + "\n", { flag: "wx" });
        throw failure;
    }
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    writeFileSync(join(out, "manifest.json"), bytes, { flag: "wx" });
    console.log(JSON.stringify({ status: "BUSINESS_REFERENCE_CAPTURED", output: out, manifestSha256: sha(bytes), tables: manifest.tables.map(table => ({ table: table.schema + "." + table.table, rows: table.rows })), mediaAssets: manifest.media.length, rollbackAck: manifest.transactionRollback, clientClosed: manifest.clientClosed, mediaBytesVerified: false }));
}

async function initializeFormalAdmins() {
    const stage = option("--stage"), inputFile = option("--input"), credentialFile = option("--credentials"), output = option("--out");
    if (!["bosses", "staff"].includes(stage) || !inputFile || !credentialFile || !output) throw new Error("FORMAL_INITIALIZATION_INPUT_REQUIRED");
    const inputBytes = readFileSync(inputFile), input = JSON.parse(inputBytes);
    if (input.target?.instance && (!/^[a-f0-9]{64}$/.test(option("--input-sha") ?? "") || sha(inputBytes) !== option("--input-sha"))) throw new Error("FORMAL_INITIALIZATION_INPUT_SHA_CHANGED");
    if (input.kind !== "FORMAL_LOCAL_ADMIN_INITIALIZATION_V1" || input.numberingDigits !== 5 || input.target?.database !== "zzsh_test_regression" || !input.target.oid || !input.target.nonce || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.resource ?? "")) throw new Error("FORMAL_INITIALIZATION_CONTRACT_REQUIRED");
    const aliases = ["boss-one", "boss-two", "operations", "support"];
    if (Object.keys(input.names ?? {}).sort().join() !== [...aliases].sort().join() || aliases.some(alias => typeof input.names[alias] !== "string" || !input.names[alias].trim() || input.names[alias].length > 120 || input.names[alias].startsWith("ROOT_REQUIRED_"))) throw new Error("EXACT_FOUR_ADMIN_NAMES_REQUIRED");
    const bindingBytes = readFileSync(input.serverBinding.file), binding = JSON.parse(bindingBytes);
    if (sha(bindingBytes) !== input.serverBinding.sha256 || binding.resource?.database !== input.target.database || String(binding.resource.resourceOid) !== String(input.target.oid) || binding.initialization?.nonce !== input.target.nonce || binding.initialization?.imProvisioner !== false || binding.initialization?.imIdentityRepository !== false || binding.initialization?.imAppId !== null) throw new Error("EXACT_NO_IM_TARGET_BINDING_REQUIRED");
    const apiOrigin = localOrigin(binding.origins?.apiOrigin), adminOrigin = localOrigin(binding.origins?.adminOrigin);
    if (["3100", "3101", "3102", "4220", "4221", "4222"].includes(new URL(apiOrigin).port)) throw new Error("ISOLATED_INITIALIZATION_API_REQUIRED");
    const out = resolve(output), restricted = realpathSync("E:/zzsh-local-state/restricted");
    if (dirname(out).toLowerCase() !== restricted.toLowerCase() || !/^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out)) || existsSync(out)) throw new Error("NEW_RESTRICTED_BOOTSTRAP_DIRECTORY_REQUIRED");
    const registered = loadRegisteredTarget(credentialFile);
    assertNextMigrationWriteReady(registered);
    const credentialBytes = readFileSync(credentialFile), credentials = JSON.parse(credentialBytes);
    if (registered.instance && (input.stage !== stage || !/^[a-f0-9]{64}$/.test(input.credentialsSha256 ?? "") || sha(credentialBytes) !== input.credentialsSha256)) throw new Error("FORMAL_INITIALIZATION_STAGE_OR_CREDENTIAL_CHANGED");
    if (registered.database !== input.target.database || registered.oid !== input.target.oid || registered.nonce !== input.target.nonce || registered.pendingReset || credentials.migration?.name !== registered.migrationRole || (registered.migrationRoleOid !== null && credentials.migration?.oid !== registered.migrationRoleOid)) throw new Error("REGISTERED_RESOURCE_CHANGED");
    if (JSON.stringify(input.target.instance ?? null) !== JSON.stringify(registered.instance)
      || JSON.stringify(binding.resource?.instance ?? null) !== JSON.stringify(registered.instance)
      || [input.target,binding.resource,binding.actualResource].some(value => (value?.migrationProfile ?? null) !== registered.migrationProfile)) throw new Error("FORMAL_INITIALIZATION_INSTANCE_CHANGED");
    if (registered.instance && (binding.status !== "R07_BOOTSTRAP_API_LISTENING" || binding.port !== 4242
      || JSON.stringify(binding.actualResource?.instance ?? null) !== JSON.stringify(registered.instance) || binding.actualResource?.read_only !== "on"
      || String(binding.actualResource?.migration_role_oid) !== registered.migrationRoleOid || binding.financialCommandCapabilities !== false
      || binding.workersEnabled !== false || binding.formalAppMounted !== true || binding.maintenanceLockReleased !== true || binding.maintenanceClosed !== true)) throw new Error("FORMAL_INITIALIZATION_RUNTIME_CHANGED");
    if (registered.instance && stage === "bosses" && (!/^[a-f0-9]{64}$/.test(input.bootstrapSecretSha256 ?? "") || sha(readFileSync(input.bootstrapSecretFile)) !== input.bootstrapSecretSha256)) throw new Error("FORMAL_INITIALIZATION_SECRET_CHANGED");
    const profileBytes = stage === "staff" ? readFileSync(input.bossProfileFile) : null;
    if (registered.instance && stage === "staff" && (!/^[a-f0-9]{64}$/.test(input.bossProfileSha256 ?? "") || sha(profileBytes) !== input.bossProfileSha256)) throw new Error("FORMAL_INITIALIZATION_PROFILE_CHANGED");
    const profile = stage === "bosses" ? { version: 1, localTest: true, resource: input.resource, actors: {} } : validateProfile(JSON.parse(profileBytes));
    if (stage === "staff" && (profile.resource !== input.resource || Object.keys(profile.actors).sort().join() !== "boss-one,boss-two" || Object.values(profile.actors).some(actor => actor.realm !== "admin" || actor.origin !== adminOrigin))) throw new Error("EXACT_NEW_BOSS_PROFILE_REQUIRED");
    const receipt = { status: "STARTED", stage, target: input.target, serverBindingSha256: sha(bindingBytes), startedAt: processStartedAt, steps: [], credentialsOutput: join(out, "profile.json"), credentialsPrinted: false, oldAdminRowsImported: false, imProvisionerConfigured: false };
    const responses = [];
    writePrivate(join(out, "receipt.json"), receipt);
    writePrivate(join(out, "profile.json"), profile);
    const cfg = { connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 };
    const maintenance = new Client(maintenanceConnection(registered, { ...cfg, user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? join(ROOT, "apps/api/.secrets/postgres_password"), "utf8").trim(), applicationName: "formal-admin-initialization-lock" }));
    const db = new Client(targetConnection(registered, { ...cfg, user: credentials.migration.name, password: credentials.migration.password, applicationName: "formal-admin-initialization-readonly" }));
    let held = false, begun = false, activeStep;
    const save = () => { writePrivate(join(out, "profile.json"), profile); writePrivate(join(out, "receipt.json"), receipt); };
    const call = async (session, path, body) => {
        activeStep = path;
        const started = performance.now(), step = { path, startedAt: new Date().toISOString() };
        receipt.pendingStep = path; receipt.pendingStepTiming = step; save();
        try {
            const result = await session.request(path, body);
            responses.push({ path, status: result.status, body: result.body, storageState: session.state() });
            writePrivate(join(out, "http-responses.json"), responses);
            step.httpStatus = result.status; receipt.steps.push(step); delete receipt.pendingStep; delete receipt.pendingStepTiming; save();
            if (result.status !== 200) throw new Error("FORMAL_INITIALIZATION_HTTP_" + result.status);
            return result.body;
        } finally {
            step.finishedAt = new Date().toISOString(); step.wallMs = performance.now() - started; save();
        }
    };
    async function enroll(alias, userId, username, temporaryPassword) {
        const password = randomBytes(24).toString("base64url");
        profile.actors[alias] = { realm: "admin", origin: adminOrigin, userId, username: username.toLowerCase(), password };
        writePrivate(join(out, alias + ".enrollment.json"), { userId, username, temporaryPassword, password }); save();
        let session = new LocalSession(apiOrigin, "admin");
        await call(session, "/api/auth/admin/sign-in/username", { username, password: temporaryPassword });
        await call(session, "/api/auth/admin/change-password", { currentPassword: temporaryPassword, newPassword: password, revokeOtherSessions: true });
        session = new LocalSession(apiOrigin, "admin");
        await call(session, "/api/auth/admin/sign-in/username", { username, password });
        const enabled = await call(session, "/api/auth/admin/two-factor/enable", { password });
        const secret = new URL(enabled.totpURI).searchParams.get("secret");
        if (!secret) throw new Error("FORMAL_TOTP_ENROLLMENT_SECRET_REQUIRED");
        profile.actors[alias].totp = { encoding: "base32", secret }; save();
        await call(session, "/api/auth/admin/two-factor/verify-totp", { code: totp(profile.actors[alias].totp) });
        await call(session, "/api/v1/admin/security/enrollment/activate", {});
        const current = await call(session, "/api/auth/admin/get-session");
        if (current?.user?.id !== userId || current.user.suspended || current.user.twoFactorEnabled !== true) throw new Error("FORMAL_ADMIN_SESSION_IDENTITY_MISMATCH");
        writePrivate(join(out, alias + ".storage-state.json"), session.state());
        writePrivate(join(out, alias + ".binding.json"), { origin: adminOrigin, realm: "admin", userId });
        return session;
    }
    try {
        await maintenance.connect();
        held = (await maintenance.query(advisoryLockSql(registered, "try"))).rows[0].ok;
        if (!held) throw new Error("REGRESSION_RESOURCE_BUSY");
        await db.connect();
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
        const identity = (await db.query(targetIdentityQuery())).rows[0];
        assertLiveTarget(registered, identity);
        if (identity.database !== input.target.database || identity.oid !== input.target.oid || identity.nonce !== input.target.nonce || identity.marker !== "zzsh:regression-test:v1" || identity.role !== credentials.migration.name || identity.role_oid !== credentials.migration.oid) throw new Error("FORMAL_INITIALIZATION_TARGET_CHANGED");
        const admins = (await db.query('SELECT u.id,u.username,s.is_boss,s.status FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id ORDER BY u.username')).rows;
        if (stage === "bosses" && admins.length !== 0 || stage === "staff" && (admins.length !== 2 || admins.some(row => !row.is_boss || row.status !== "ACTIVE" || !Object.values(profile.actors).some(actor => actor.userId === row.id)))) throw new Error("FORMAL_INITIALIZATION_EXPECTED_ADMIN_STATE_REQUIRED");
        const sequence = (await db.query("SELECT last_value::text,is_called FROM zzsh_iam.admin_login_number_seq")).rows[0];
        if (stage === "bosses" && (sequence.last_value !== "1" || sequence.is_called) || stage === "staff" && !((sequence.last_value === "1" && !sequence.is_called) || (sequence.last_value === "2" && sequence.is_called))) throw new Error("FORMAL_INITIALIZATION_LOGIN_SEQUENCE_NOT_FRESH");
        let deltaId;
        if (stage === "staff") {
            deltaId = (await db.query("SELECT id FROM zzsh_supply.game WHERE code='delta'")).rows[0]?.id;
            const roles = (await db.query("SELECT id FROM zzsh_iam.admin_role WHERE id=ANY($1::text[]) AND status='ACTIVE'", [["role_preset_ops", "role_preset_support"]])).rows;
            if (!deltaId || roles.length !== 2) throw new Error("CANONICAL_PRESET_ROLES_AND_DELTA_REQUIRED");
        }
        await db.query("ROLLBACK"); begun = false; receipt.preflightRollbackAck = true;
        if (stage === "bosses") {
            const bootstrapSecret = readFileSync(input.bootstrapSecretFile, "utf8").trim();
            for (const [index, alias] of ["boss-one", "boss-two"].entries()) {
                const temporaryPassword = randomBytes(24).toString("base64url");
                writePrivate(join(out, alias + ".bootstrap-input.json"), { name: input.names[alias], temporaryPassword });
                const created = await call(new LocalSession(apiOrigin, "admin"), "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: input.names[alias], password: temporaryPassword });
                if (created.username !== "zz" + String(index + 1).padStart(5, "0") || created.isBoss !== true || !created.adminUserId) throw new Error("FORMAL_BOOTSTRAP_NUMBER_CONTRACT_CHANGED");
                await enroll(alias, created.adminUserId, created.username, temporaryPassword);
            }
        } else {
            const actor = profile.actors["boss-one"], boss = new LocalSession(apiOrigin, "admin");
            const signedIn = await call(boss, "/api/auth/admin/sign-in/username", { username: actor.username, password: actor.password });
            if (signedIn.twoFactorRedirect) await call(boss, "/api/auth/admin/two-factor/verify-totp", { code: totp(actor.totp) });
            for (const [alias, role] of [["operations", "role_preset_ops"], ["support", "role_preset_support"]]) {
                const created = await call(boss, "/api/v1/admin/security/admins/create", { name: input.names[alias], roleIds: [role], allowPermissions: [], denyPermissions: [], mode: "SELECTED_GAMES", gameIds: [deltaId] });
                if (!created.id || !created.temporaryPassword || created.isBoss !== false || created.imIdentity !== undefined) throw new Error("FORMAL_STAFF_NO_IM_CREATION_REQUIRED");
                await enroll(alias, created.id, created.username, created.temporaryPassword);
            }
        }
        validateProfile(profile);
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
        const finalAdmins = (await db.query('SELECT u.id,u.username,u.suspended,u."twoFactorEnabled" two_factor,s.is_boss,s.status,s.password_change_required,s.game_scope_mode FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id ORDER BY u.username')).rows;
        if (finalAdmins.length !== (stage === "bosses" ? 2 : 4) || finalAdmins.filter(row => row.is_boss).length !== 2 || finalAdmins.some(row => row.status !== "ACTIVE" || row.password_change_required || row.suspended || row.two_factor !== true || !Object.values(profile.actors).some(actor => actor.userId === row.id && actor.username === row.username))) throw new Error("FORMAL_INITIALIZATION_FINAL_ADMIN_STATE_DIFFERS");
        const avatarCount = (await db.query("SELECT count(*)::int n FROM zzsh_supply.profile_avatar WHERE realm='admin' AND subject_id=ANY($1::text[]) AND current_kind='DEFAULT' AND current_asset_id IS NULL AND pending_asset_id IS NULL", [finalAdmins.map(row => row.id)])).rows[0].n;
        if (avatarCount !== finalAdmins.length) throw new Error("FORMAL_INITIALIZATION_DEFAULT_AVATAR_MISSING");
        if (stage === "staff") for (const [alias, role] of [["operations", "role_preset_ops"], ["support", "role_preset_support"]]) {
            const id = profile.actors[alias].userId;
            const roles = (await db.query("SELECT role_id FROM zzsh_iam.admin_user_role WHERE admin_user_id=$1", [id])).rows;
            const scopes = (await db.query("SELECT game_id FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1", [id])).rows;
            if (roles.length !== 1 || roles[0].role_id !== role || scopes.length !== 1 || scopes[0].game_id !== deltaId || finalAdmins.find(row => row.id === id)?.game_scope_mode !== "SELECTED_GAMES") throw new Error("FORMAL_INITIALIZATION_STAFF_ROLE_OR_SCOPE_DIFFERS");
        }
        await db.query("ROLLBACK"); begun = false; receipt.finalReadbackRollbackAck = true;
        receipt.verified = { administrators: finalAdmins.length, bosses: 2, defaultAvatars: avatarCount, ...(stage === "staff" ? { operationsPreset: 1, supportPreset: 1, selectedGame: "delta" } : {}) };
        receipt.status = "FORMAL_INITIALIZATION_COMPLETED"; save();
    } catch (error) {
        receipt.status = "STOPPED_POSSIBLE_PARTIAL_APPLICATION";
        receipt.error = { code: error.code ?? null, message: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "FORMAL_INITIALIZATION_FAILED", step: activeStep ?? null };
        receipt.retryPolicy = "no automatic retry or reset; inspect original target state and restricted checkpoint";
        save(); process.exitCode = 1;
    } finally {
        if (begun) { await db.query("ROLLBACK"); receipt.preflightRollbackAck = true; }
        await db.end(); receipt.preflightClientClosed = true;
        if (held) receipt.unlock = (await maintenance.query(advisoryLockSql(registered, "unlock"))).rows[0].ok;
        await maintenance.end(); receipt.maintenanceClosed = true;
        receipt.finishedAt = new Date().toISOString(); receipt.wallMs = performance.now() - processStarted; save();
    }
    console.log(JSON.stringify({ status: receipt.status, stage, profile: receipt.credentialsOutput, receipt: join(out, "receipt.json"), credentialsPrinted: false, oldAdminRowsImported: false, externalImCalls: 0, error: receipt.error }));
}
