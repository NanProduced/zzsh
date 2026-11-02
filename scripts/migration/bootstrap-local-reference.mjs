import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), { Client, Pool } = require("pg");
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--execute")) {
    console.log(JSON.stringify({ action: "PLAN", required: ["--execute", "--manifest", "--manifest-sha", "--oid", "--nonce", "--credentials", "--receipt"], target: "registered regression only", connections: 0, credentialReads: 0, identityPolicy: "restore existing five admins; no new Boss/auth secret" }));
    process.exit(0);
}
if (process.version !== "v24.20.0")
    throw new Error("NODE_BASELINE_MISMATCH");
const sha = value => createHash("sha256").update(value).digest("hex");
const manifestFile = resolve(option("--manifest") ?? ""), root = dirname(manifestFile);
const bytes = readFileSync(manifestFile);
if (sha(bytes) !== option("--manifest-sha"))
    throw new Error("REFERENCE_MANIFEST_SHA_MISMATCH");
const source = JSON.parse(bytes);
if (source.kind !== "REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION" || source.transactionRollback !== true)
    throw new Error("REFERENCE_SNAPSHOT_NOT_REVIEWED");
const allowed = new Set(["zzsh_auth_admin.user", "zzsh_auth_admin.account", "zzsh_auth_admin.session", "zzsh_auth_admin.twoFactor", "zzsh_iam.admin_security", "zzsh_iam.admin_role", "zzsh_iam.admin_permission", "zzsh_iam.admin_role_permission", "zzsh_iam.admin_user_role", "zzsh_iam.admin_user_permission", "zzsh_iam.approval_template", "zzsh_iam.approval_template_candidate", "zzsh_iam.approval_request", "zzsh_iam.approval_request_candidate", "zzsh_iam.approval_decision", "zzsh_iam.approval_execution", "zzsh_iam.membership_growth_policy", "zzsh_iam.im_identity_mapping", "zzsh_iam.im_support_settings", "zzsh_supply.profile_avatar", "zzsh_supply.game", "zzsh_supply.game_service_operation", "zzsh_supply.skin_category", "zzsh_supply.firearm_classification", "zzsh_supply.firearm_alias", "zzsh_supply.full_payout_terms_version", "zzsh_supply.billable_item", "zzsh_supply.skin_rarity", "zzsh_supply.skin_owner", "zzsh_supply.firearm", "zzsh_supply.skin", "zzsh_supply.admin_supply_scope", "zzsh_supply.price_version", "zzsh_supply.price_line", "zzsh_supply.term_version", "zzsh_supply.term_option", "zzsh_supply.agreement_version", "zzsh_supply.rule_release", "zzsh_supply.media_upload_intent", "zzsh_supply.media_asset", "zzsh_content.legal_document_version"]);
const q = name => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("UNSAFE_REFERENCE_IDENTIFIER"); return '"' + name + '"'; };
const tables = new Map();
for (const descriptor of source.tables) {
    const key = descriptor.schema + "." + descriptor.table;
    if (tables.has(key) || !allowed.has(key) || descriptor.file !== basename(descriptor.file))
        throw new Error("REFERENCE_TABLE_NOT_ALLOWED");
    const raw = readFileSync(join(root, descriptor.file));
    if (sha(raw) !== descriptor.sha256)
        throw new Error("REFERENCE_TABLE_SHA_CHANGED:" + key);
    const table = JSON.parse(raw);
    if (table.schema !== descriptor.schema || table.table !== descriptor.table || table.rows.length !== descriptor.rows || table.rows.some(row => typeof row !== "string"))
        throw new Error("LOSSLESS_REFERENCE_ROWS_REQUIRED");
    if (args.includes("--admins-only") && !(key.startsWith("zzsh_auth_admin.") || ["zzsh_iam.admin_security", "zzsh_iam.admin_role", "zzsh_iam.admin_permission", "zzsh_iam.admin_role_permission", "zzsh_iam.admin_user_role", "zzsh_iam.admin_user_permission"].includes(key)))
        continue;
    tables.set(key, { ...table, key, sql: q(descriptor.schema) + "." + q(descriptor.table) });
}
if (tables.get("zzsh_auth_admin.user")?.rows.length !== 5 || tables.get("zzsh_iam.admin_security")?.rows.length !== 5) throw new Error("REVIEWED_FIVE_ADMIN_IDENTITY_CLOSURE_REQUIRED");
const expectedOid = option("--oid"), expectedNonce = option("--nonce"), credentialFile = option("--credentials");
if (!expectedOid || !expectedNonce || !credentialFile)
    throw new Error("EXACT_TARGET_BINDING_REQUIRED");
const registered = JSON.parse(readFileSync(join(dirname(resolve(credentialFile)), "resource.json")));
const credentials = JSON.parse(readFileSync(credentialFile));
if (registered.database !== "zzsh_test_regression" || registered.oid !== expectedOid || registered.nonce !== expectedNonce || registered.pendingReset || credentials.migration?.name !== registered.roles?.migration?.name || credentials.migration?.oid !== registered.roles?.migration?.oid)
    throw new Error("REGISTERED_RESOURCE_CHANGED");
const receiptFile = resolve(option("--receipt") ?? "");
if (!receiptFile.toLowerCase().startsWith("e:\\zzsh-local-state\\restricted\\") || existsSync(receiptFile))
    throw new Error("NEW_PRIVATE_RECEIPT_REQUIRED");
const result = { status: "STARTED", manifestSha256: sha(bytes), oid: expectedOid, nonce: expectedNonce, startedAt: new Date().toISOString(), tables: [], expectedDifferences: [], pending: [], sourceIdsPreserved: true, sourceRawUnchanged: true };
const cfg = { host: "127.0.0.1", port: 55432, connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 500 };
const maintenance = new Client({ ...cfg, database: "postgres", user: "zzsh", password: readFileSync(process.env.DB_PASSWORD_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/postgres_password", "utf8").trim(), application_name: "core-reference-bootstrap-lock" });
const pool = new Pool({ ...cfg, database: "zzsh_test_regression", user: credentials.migration.name, password: credentials.migration.password, max: 1, application_name: "core-reference-bootstrap" });
let client, held = false, begun = false, commitSent = false;
const STATIC = new Set(["zzsh_iam.admin_permission", "zzsh_iam.admin_role", "zzsh_iam.admin_role_permission", "zzsh_iam.approval_template"]);
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
async function existing(table, row) { const pk = await keyCondition(table); return (await client.query(`SELECT to_jsonb(t)=$1::jsonb AS exact,to_jsonb(t)-ARRAY['created_at','updated_at']::text[]=($1::jsonb)-ARRAY['created_at','updated_at']::text[] AS semantic,(to_jsonb(t)-'updated_at')=($1::jsonb-'updated_at') AS restore_time_only FROM ${table.sql} t CROSS JOIN jsonb_populate_record(NULL::${table.sql},$1::jsonb) s WHERE ${pk.map(k => `t.${q(k)} IS NOT DISTINCT FROM s.${q(k)}`).join(" AND ")}`, [row])).rows[0]; }
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
        if (STATIC.has(table.key) && found.semantic) {
            result.expectedDifferences.push({ table: table.key, fields: ["created_at", "updated_at"], basis: "baseline seed provenance timestamps retained; all other fields equal" });
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
    held = (await maintenance.query("SELECT pg_try_advisory_lock(806006::bigint) ok")).rows[0].ok;
    if (!held)
        throw new Error("REGRESSION_RESOURCE_BUSY");
    client = await pool.connect();
    const identity = (await client.query("SELECT d.oid::text,pg_get_userbyid(d.datdba) owner,shobj_description(d.oid,'pg_database') marker,current_user role,r.oid::text role_oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolbypassrls,current_setting('zzsh.regression_run') nonce FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()")).rows[0];
    if (identity.oid !== expectedOid || identity.nonce !== expectedNonce || identity.owner !== "zzsh" || identity.marker !== "zzsh:regression-test:v1" || identity.role !== credentials.migration.name || identity.role_oid !== credentials.migration.oid || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolinherit || identity.rolbypassrls)
        throw new Error("REFERENCE_TARGET_IDENTITY_CHANGED");
    const admin = tables.get("zzsh_auth_admin.user");
    if (admin) {
        const ids = admin.rows.map(row => JSON.parse(row).id);
        const alien = (await client.query('SELECT count(*)::int n FROM zzsh_auth_admin."user" WHERE id<>ALL($1::text[])', [ids])).rows[0].n;
        if (alien !== 0)
            throw new Error("TARGET_HAS_NONREFERENCE_ADMIN");
    }
    for (const table of tables.values()) { const columns=(await client.query("SELECT attname AS name FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped",[table.sql])).rows.map(row=>row.name);if(!columns.length||table.columns.some(column=>!columns.includes(column.name)))throw new Error("REFERENCE_TARGET_COLUMNS_MISMATCH:"+table.key);}
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
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
    for (const table of tables.values()) {
        let exact = 0, semantic = 0;
        for (const row of table.rows) {
            const found = await existing(table, row);
            if (found?.exact)
                exact++;
            else if (STATIC.has(table.key) && found?.semantic || table.key==="zzsh_supply.skin"&&found?.restore_time_only) {
                semantic++;if(table.key==="zzsh_supply.skin")result.expectedDifferences.push({table:table.key,fields:["updated_at"],basis:"legal PENDING→derived VERIFIED restore; database touch timestamp, source timestamp remains in sealed source file"});
            }
            else
                throw new Error("REFERENCE_FINAL_ROW_DIFFERS:" + table.key);
        }
        const entry = result.tables.find(t => t.table === table.key);
        entry.exact = exact;
        entry.baselineTimestampOnly = semantic;
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    commitSent = true;
    await client.query("COMMIT");
    begun = false;
    result.commitAck = true;
    result.status = "REFERENCE_BOOTSTRAP_COMMITTED";
    const actors = (await client.query(`SELECT u.id,s.id AS session_id,s."expiresAt" expires_at FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id JOIN zzsh_auth_admin.session s ON s."userId"=u.id WHERE a.is_boss AND a.status='ACTIVE' AND NOT u.suspended AND NOT a.password_change_required AND s."expiresAt">clock_timestamp() AND NOT s.locked ORDER BY s."expiresAt" DESC LIMIT 1`)).rows;
    result.maintenanceActor = actors[0] ?? null;
}
catch (error) {
    result.status = commitSent && !result.commitAck ? "REFERENCE_COMMIT_UNKNOWN" : "FAILED_STOPPED";
    result.error = { code: error.code ?? null, message: String(error.message).slice(0, 300), constraint: error.constraint ?? null };
    if (begun && !commitSent)
        try {
            await client.query("ROLLBACK");
            result.rollbackAck = true;
        }
        catch {
            result.rollbackAck = false;
        }
    process.exitCode = 1;
}
finally {
    client?.release();
    await pool.end();
    result.poolClosed = true;
    if (held)
        try {
            result.unlock = (await maintenance.query("SELECT pg_advisory_unlock(806006::bigint) ok")).rows[0].ok;
        }
        catch {
            result.unlock = false;
        }
    await maintenance.end();
    result.maintenanceClosed = true;
    result.finishedAt = new Date().toISOString();
    writeFileSync(receiptFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: result.status, tables: result.tables.length, commitAck: result.commitAck, rollbackAck: result.rollbackAck, unlock: result.unlock, error: result.error }));
}
