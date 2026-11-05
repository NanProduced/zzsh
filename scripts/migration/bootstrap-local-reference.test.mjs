import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./bootstrap-local-reference.mjs", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
const plan = JSON.parse(run(["--plan"]).stdout);
function fixture(t, change = () => {}) {
    const root = mkdtempSync(join(tmpdir(), "zzsh-business-reference-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tables = plan.businessPackage.tables.map(key => {
        const [schema, table] = key.split(".");
        return { schema, table, columns: [{ name: "id", generated: "" }], primaryKey: ["id"], rows: table === "game" ? ['{"id":"game-1","code":"delta","catalog_revision":9007199254740993}'] : [] };
    });
    const manifest = { kind: "BUSINESS_REFERENCE_PACKAGE_V1", gameCode: "delta", source: { database: "zzsh_dev_daily", oid: "2400547", read_only: "on" }, transactionRollback: true, clientClosed: true, foreignKeys: [] };
    change(tables, manifest);
    manifest.tables = tables.map(table => {
        const file = table.schema + "." + table.table + ".json", bytes = JSON.stringify(table);
        writeFileSync(join(root, file), bytes);
        return { schema: table.schema, table: table.table, file, rows: table.rows.length, sha256: hash(bytes) };
    });
    const bytes = JSON.stringify(manifest), file = join(root, "manifest.json");
    writeFileSync(file, bytes);
    return { root, manifest, args: ["--manifest", file, "--manifest-sha", hash(bytes)] };
}

test("business verification is offline and keeps exact source row bytes", t => {
    const pkg = fixture(t), before = readFileSync(join(pkg.root, "zzsh_supply.game.json"));
    const result = run(["--verify", ...pkg.args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: "REFERENCE_FILES_VERIFIED", kind: "BUSINESS_REFERENCE_PACKAGE_V1", tables: 19, rows: 1, connections: 0, credentialReads: 0, mediaBytesVerified: false });
    assert.deepEqual(readFileSync(join(pkg.root, "zzsh_supply.game.json")), before);
});

for (const [name, change, error] of [
    ["no identities", tables => tables.push({ schema: "zzsh_auth_admin", table: "session", columns: [], primaryKey: ["id"], rows: [] }), /REFERENCE_TABLE_NOT_ALLOWED/],
    ["all tables required", tables => tables.pop(), /BUSINESS_PACKAGE_SOURCE_OR_CLOSURE_REQUIRED/],
    ["duplicate PK", tables => tables[0].rows.push(tables[0].rows[0]), /BUSINESS_DUPLICATE_OR_MISSING_PRIMARY_KEY/],
    ["PK required", tables => tables[0].primaryKey = [], /BUSINESS_PRIMARY_KEY_REQUIRED/],
    ["FK closure", (tables, manifest) => { tables[0].rows = ['{"id":"game-1","code":"delta","current_release_id":"missing"}']; manifest.foreignKeys.push({ child: "zzsh_supply.game", parent: "zzsh_supply.rule_release", name: "release_fk", columns: ["current_release_id"], parentColumns: ["id"] }); }, /BUSINESS_FOREIGN_KEY_NOT_CLOSED/],
    ["only platform media", tables => { tables.find(table => table.table === "media_asset").rows = ['{"id":"media-1","ownership_kind":"USER_SUPPLY","owner_user_id":"user-1","uploaded_by_user_id":"user-1","account_id":"account-1"}']; }, /BUSINESS_MEDIA_OWNERSHIP_REQUIRED/],
]) test("business package rejects " + name + " before credentials", t => {
    const pkg = fixture(t, change), result = run(["--verify", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
});

test("business apply requires an existing maintenance admin before credentials", t => {
    const pkg = fixture(t), result = run(["--execute", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EXISTING_MAINTENANCE_ADMIN_BINDING_REQUIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
});

test("verification cannot trigger capture", () => {
    const result = run(["--verify", "--capture-business"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPTURE_EXECUTE_REQUIRED/);
});

test("historical five-admin package is superseded before credentials", t => {
    const pkg = fixture(t, (tables, manifest) => {
        manifest.kind = "REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION";
        tables.splice(0, tables.length, ...[["zzsh_auth_admin", "user"], ["zzsh_iam", "admin_security"]].map(([schema, table]) => ({ schema, table, columns: [], rows: Array.from({ length: 5 }, (_, id) => JSON.stringify({ id: "old-" + id })) })));
    });
    const result = run(["--execute", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ADMIN_REFERENCE_RESTORE_SUPERSEDED_NOT_FOR_APPLICATION/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
});

test("formal initialization plan preserves the current five-digit number contract", () => {
    assert.deepEqual(plan.formalAdminInitialization.serverAssignedFirstLogins, ["zz00001", "zz00002"]);
    const result = run(["--execute", "--initialize-admins"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FORMAL_INITIALIZATION_INPUT_REQUIRED/);
});

for (const invalid of ["six-digit", "im-enabled"]) test("formal initialization rejects " + invalid + " before secrets or connection", t => {
    const pkg = fixture(t), binding = { resource: { database: "zzsh_test_regression", resourceOid: "123" }, initialization: { nonce: "fixture", imProvisioner: invalid === "im-enabled", imIdentityRepository: false, imAppId: null } };
    const bytes = JSON.stringify(binding), bindingFile = join(pkg.root, "binding.json"); writeFileSync(bindingFile, bytes);
    const input = { kind: "FORMAL_LOCAL_ADMIN_INITIALIZATION_V1", numberingDigits: invalid === "six-digit" ? 6 : 5, resource: "scene_test", target: { database: "zzsh_test_regression", oid: "123", nonce: "fixture" }, names: { "boss-one": "Boss1", "boss-two": "Boss2", operations: "运营", support: "客服" }, serverBinding: { file: bindingFile, sha256: hash(bytes) } };
    const inputFile = join(pkg.root, "input.json"); writeFileSync(inputFile, JSON.stringify(input));
    const result = run(["--execute", "--initialize-admins", "--stage", "bosses", "--input", inputFile, "--credentials", "must-not-be-read", "--out", "must-not-be-written"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, invalid === "six-digit" ? /FORMAL_INITIALIZATION_CONTRACT_REQUIRED/ : /EXACT_NO_IM_TARGET_BINDING_REQUIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
});

for (const mode of ["commit", "replay", "rollback", "unknown", "skin-time", "skin-created", "skin-field"]) test("business execution host: " + mode, { skip: process.platform !== "win32" }, t => {
    const pkg = fixture(t, (tables, manifest) => {
        tables.find(table => table.table === "firearm_classification").rows = ['{"id":"class-1","created_by_admin_id":"original-admin","updated_by_admin_id":null,"revision":9007199254740993}'];
        if (mode.startsWith("skin-")) tables.find(table => table.table === "skin").rows = ['{"id":"skin-1","name":"original","created_at":"2026-01-01","updated_at":"2026-01-01"}'];
        manifest.foreignKeys.push({ child: "zzsh_supply.firearm_classification", parent: "zzsh_auth_admin.user", columns: ["created_by_admin_id"], parentColumns: ["id"] });
    }), preload = join(pkg.root, "fake-pg.cjs"), calls = join(pkg.root, "calls.json"), receipt = join(pkg.root, "receipt.json"), parameters = join(pkg.root, "parameters.json");
    const requestedReceipt = "E:/zzsh-local-state/restricted/bootstrap-host-test.json";
    const registered = { database: "zzsh_test_regression", oid: "123", nonce: "fixture-nonce", roles: { migration: { name: "fixture_m", oid: "456" } } };
    writeFileSync(join(pkg.root, "resource.json"), JSON.stringify(registered));
    writeFileSync(join(pkg.root, "credentials.json"), JSON.stringify({ migration: { name: "fixture_m", oid: "456", password: "fixture-only" } }));
    writeFileSync(join(pkg.root, "password.txt"), "fixture-only");
    writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path'),mod=require('node:module'),net=require('node:net');
const mode=${JSON.stringify(mode)},receipt=${JSON.stringify(receipt)},callsFile=${JSON.stringify(calls)},paramsFile=${JSON.stringify(parameters)},requested=path.resolve(${JSON.stringify(requestedReceipt)});
const calls=[],rows=new Map(),writes=[],write=fs.writeFileSync,exists=fs.existsSync,originalLoad=mod._load;
net.Socket.prototype.connect=function(){throw Error('REAL_NETWORK_FORBIDDEN')};
fs.existsSync=function(file){return path.resolve(String(file))===requested?false:exists.call(this,file)};
fs.writeFileSync=function(file,...rest){return write.call(this,path.resolve(String(file))===requested?receipt:file,...rest)};
mod.syncBuiltinESMExports();
async function query(sql,params=[]){calls.push(sql);if(sql.includes('pg_try_advisory_lock')||sql.includes('pg_advisory_unlock'))return {rows:[{ok:true}]};
if(sql.includes("current_setting('zzsh.regression_run')"))return {rows:[{oid:'123',nonce:'fixture-nonce',owner:'zzsh',marker:'zzsh:regression-test:v1',role:'fixture_m',role_oid:'456',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolbypassrls:false}]};
if(sql.includes('FOR SHARE OF a,u'))return {rows:[{is_boss:true,status:'ACTIVE',suspended:false}]};
if(sql.includes('SELECT attname AS name'))return {rows:[{name:'id'},{name:'code'},{name:'catalog_revision'}]};
if(sql.includes('FROM pg_constraint k CROSS'))return {rows:[{name:'id'}]};
if(sql.includes('SELECT sn.nspname'))return {rows:[]};
if(sql.startsWith('SELECT to_jsonb(t)=')){const key=sql.match(/FROM ("[^\"]+"\."[^\"]+")/)[1];
 if(key==='"zzsh_supply"."skin"'&&mode.startsWith('skin-')){const source=JSON.parse(params[0]),target={...source};target.updated_at='2026-02-01';if(mode==='skin-created')target.created_at='2026-02-01';if(mode==='skin-field')target.name='changed';
 const equal=(ignore)=>{const a={...source},b={...target};for(const field of ignore){delete a[field];delete b[field]}return JSON.stringify(a)===JSON.stringify(b)};
 return {rows:[{exact:equal([]),semantic:equal(['created_at','updated_at']),restore_time_only:equal(['updated_at'])}]};}
 return {rows:rows.has(key)||mode==='replay'?[{exact:true,semantic:true,restore_time_only:true}]:[]};}
if(sql.startsWith('INSERT INTO')){if(mode==='rollback')throw Error('FIXTURE_INSERT_FAILURE');rows.set(sql.match(/^INSERT INTO ("[^\"]+"\."[^\"]+")/)[1],params[0]);writes.push(params[0]);}
if(sql==='COMMIT'&&mode==='unknown')throw Error('FIXTURE_COMMIT_TRANSPORT_UNKNOWN');
return {rows:[]};}
class Client{async connect(){calls.push('maintenance.connect')}query(...args){return query(...args)}async end(){calls.push('maintenance.end');write(callsFile,JSON.stringify(calls));write(paramsFile,JSON.stringify(writes))}}
class Pool{async connect(){calls.push('pool.connect');return {query,release(){calls.push('client.release')}}}async end(){calls.push('pool.end')}}
mod._load=function(name,...rest){return name==='pg'?{Client,Pool}:originalLoad.call(this,name,...rest)};
`);
    const result = spawnSync(process.execPath, ["--require", preload, script, "--execute", ...pkg.args, "--maintenance-admin-id", "existing-boss", "--oid", "123", "--nonce", "fixture-nonce", "--credentials", join(pkg.root, "credentials.json"), "--receipt", requestedReceipt], { encoding: "utf8", timeout: 5000, env: { ...process.env, DB_PASSWORD_FILE: join(pkg.root, "password.txt") } });
    assert.ok(existsSync(receipt), result.stderr + result.stdout);
    const observed = JSON.parse(readFileSync(receipt)), sql = JSON.parse(readFileSync(calls));
    assert.equal(observed.database, "zzsh_test_regression");
    assert.ok(Number.isFinite(Date.parse(observed.startedAt)) && Number.isFinite(Date.parse(observed.finishedAt)) && observed.wallMs >= 0);
    assert.equal(observed.poolClosed, true);
    assert.equal(observed.maintenanceClosed, true);
    assert.equal(observed.unlock, true);
    if (mode === "commit" || mode === "replay" || mode === "skin-time") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(observed.status, "REFERENCE_BOOTSTRAP_COMMITTED");
        assert.equal(observed.commitAck, true);
        assert.equal(sql.filter(query => query.startsWith("INSERT INTO")).length, mode === "replay" ? 0 : 2);
        if (mode === "skin-time") {
            assert.equal(sql.some(query => /^(INSERT INTO|UPDATE) "zzsh_supply"\."skin"/.test(query)), false);
            assert.equal(observed.tables.find(row => row.table === "zzsh_supply.skin").baselineTimestampOnly, 1);
            assert.deepEqual(observed.expectedDifferences.filter(row => row.table === "zzsh_supply.skin").map(row => row.fields), [["updated_at"]]);
        }
        if (mode === "commit") {
            const raw = JSON.parse(readFileSync(parameters)).find(row => row.includes("class-1"));
            assert.match(raw, /"created_by_admin_id":"existing-boss"/);
            assert.match(raw, /"updated_by_admin_id":null/);
            assert.match(raw, /"revision":9007199254740993/);
        }
    } else if (mode === "rollback" || mode === "skin-created" || mode === "skin-field") {
        assert.equal(result.status, 1);
        assert.equal(observed.status, "FAILED_STOPPED");
        assert.equal(observed.rollbackAck, true);
        assert.equal(sql.filter(query => query === "ROLLBACK").length, 1);
        assert.equal(sql.includes("COMMIT"), false);
        if (mode.startsWith("skin-")) {
            assert.match(observed.error.message, /REFERENCE_EXISTING_ROW_DIFFERS:zzsh_supply.skin/);
            assert.equal(sql.some(query => /^(INSERT INTO|UPDATE) "zzsh_supply"\."skin"/.test(query)), false);
        }
    } else {
        assert.equal(result.status, 1);
        assert.equal(observed.status, "REFERENCE_COMMIT_UNKNOWN");
        assert.equal(observed.commitAck, undefined);
        assert.equal(sql.includes("ROLLBACK"), false);
        assert.equal(sql.filter(query => query === "COMMIT").length, 1);
    }
});

for (const stage of ["bosses", "staff", "partial-failure"]) test("formal admin HTTP host: " + stage, { skip: process.platform !== "win32" }, t => {
    const pkg = fixture(t), root = pkg.root, callsFile = join(root, "formal-calls.json");
    const out = join("E:/zzsh-local-state/restricted", "data-first-bootstrap-host-" + root.split(/[\\/]/).at(-1).toLowerCase());
    assert.match(out.replaceAll("\\", "/"), /^E:\/zzsh-local-state\/restricted\/data-first-bootstrap-host-/);
    t.after(() => { if (existsSync(out)) rmSync(out, { recursive: true }); });
    const target = { database: "zzsh_test_regression", oid: "123", nonce: "fixture-nonce" };
    const binding = { resource: { database: target.database, resourceOid: target.oid }, initialization: { nonce: target.nonce, imProvisioner: false, imIdentityRepository: false, imAppId: null }, origins: { apiOrigin: "http://127.0.0.1:4292", adminOrigin: "http://127.0.0.1:4291" } };
    const bindingFile = join(root, "binding.json"), bindingBytes = JSON.stringify(binding);
    writeFileSync(bindingFile, bindingBytes);
    const bossProfile = { version: 1, localTest: true, resource: "scene_test", actors: Object.fromEntries(["boss-one", "boss-two"].map((alias, index) => [alias, { realm: "admin", origin: binding.origins.adminOrigin, userId: "new-admin-" + (index + 1), username: "zz0000" + (index + 1), password: "fixture-final-password", totp: { encoding: "base32", secret: "JBSWY3DPEHPK3PXP" } }])) };
    writeFileSync(join(root, "boss-profile.json"), JSON.stringify(bossProfile));
    const input = { kind: "FORMAL_LOCAL_ADMIN_INITIALIZATION_V1", numberingDigits: 5, target, resource: "scene_test", names: { "boss-one": "第一Boss", "boss-two": "第二Boss", operations: "运营", support: "客服" }, serverBinding: { file: bindingFile, sha256: hash(bindingBytes) }, bootstrapSecretFile: join(root, "bootstrap-secret"), bossProfileFile: join(root, "boss-profile.json") };
    writeFileSync(join(root, "input.json"), JSON.stringify(input));
    writeFileSync(join(root, "resource.json"), JSON.stringify({ ...target, roles: { migration: { name: "fixture_m", oid: "456" } } }));
    writeFileSync(join(root, "credentials.json"), JSON.stringify({ migration: { name: "fixture_m", oid: "456", password: "fixture-only" } }));
    writeFileSync(join(root, "bootstrap-secret"), "fixture-only"); writeFileSync(join(root, "password"), "fixture-only");
    const preload = join(root, "formal-host.cjs");
    writeFileSync(preload, `const fs=require('node:fs'),mod=require('node:module'),net=require('node:net');
const stage=${JSON.stringify(stage)},callsFile=${JSON.stringify(callsFile)},calls=[],actors=stage==='staff'?[1,2].map(n=>({id:'new-admin-'+n,username:'zz0000'+n,is_boss:true,status:'ACTIVE',suspended:false,two_factor:true,password_change_required:false,game_scope_mode:'ALL_GAMES'})):[];
const originalLoad=mod._load;net.Socket.prototype.connect=function(){throw Error('REAL_NETWORK_FORBIDDEN')};
async function query(sql,params=[]){calls.push({kind:'sql',sql});if(sql.includes('pg_try_advisory_lock')||sql.includes('pg_advisory_unlock'))return {rows:[{ok:true}]};
if(sql.includes('current_database() database'))return {rows:[{database:'zzsh_test_regression',oid:'123',marker:'zzsh:regression-test:v1',nonce:'fixture-nonce',role:'fixture_m',role_oid:'456'}]};
if(sql.includes('FROM zzsh_auth_admin."user"'))return {rows:actors};
if(sql.includes('FROM zzsh_iam.admin_login_number_seq'))return {rows:[{last_value:stage==='staff'?'2':'1',is_called:stage==='staff'}]};
if(sql.includes('FROM zzsh_supply.profile_avatar'))return {rows:[{n:actors.length}]};
if(sql.includes("code='delta'"))return {rows:[{id:'delta-id'}]};
if(sql.includes('FROM zzsh_iam.admin_role'))return {rows:[{id:'role_preset_ops'},{id:'role_preset_support'}]};
if(sql.includes('FROM zzsh_iam.admin_user_role'))return {rows:[{role_id:actors.find(a=>a.id===params[0]).role}]};
if(sql.includes('FROM zzsh_supply.admin_supply_scope'))return {rows:[{game_id:'delta-id'}]};return {rows:[]};}
class Client{async connect(){}query(...args){return query(...args)}async end(){fs.writeFileSync(callsFile,JSON.stringify(calls))}}
mod._load=function(name,...rest){return name==='pg'?{Client,Pool:class{}}:originalLoad.call(this,name,...rest)};
globalThis.fetch=async function(url,options){const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):undefined;calls.push({kind:'http',path,body});let result={},headers={};
const match=/zzsh_admin.session_token=fake-(\\d+)/.exec(options.headers.Cookie??'');let current=match?actors[Number(match[1])-1]:null;
if(path.endsWith('/bootstrap')){const n=actors.length+1;const actor={id:'new-admin-'+n,username:'zz0000'+n,is_boss:true,status:'PENDING_ENROLLMENT',suspended:false,two_factor:false,password_change_required:true,game_scope_mode:'ALL_GAMES'};actors.push(actor);result={adminUserId:actor.id,username:actor.username,isBoss:true};}
else if(path.endsWith('/admins/create')){const n=actors.length+1,actor={id:'new-admin-'+n,username:'zz0000'+n,is_boss:false,status:'PENDING_ENROLLMENT',suspended:false,two_factor:false,password_change_required:true,game_scope_mode:body.mode,role:body.roleIds[0]};actors.push(actor);result={id:actor.id,username:actor.username.toUpperCase(),isBoss:false,temporaryPassword:'fixture-temporary-password'};}
else if(path.endsWith('/sign-in/username')){current=actors.find(a=>a.username===body.username.toLowerCase());headers['set-cookie']='zzsh_admin.session_token=fake-'+(actors.indexOf(current)+1)+'; Path=/; HttpOnly';result={twoFactorRedirect:false};}
else if(path.endsWith('/change-password'))current.password_change_required=false;
else if(path.endsWith('/two-factor/enable')){if(stage==='partial-failure')throw Error('FIXTURE_HTTP_RESPONSE_LOST');result={totpURI:'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP'};}
else if(path.endsWith('/verify-totp'))current.two_factor=true;
else if(path.endsWith('/enrollment/activate'))current.status='ACTIVE';
else if(path.endsWith('/get-session'))result={user:{id:current.id,suspended:false,twoFactorEnabled:current.two_factor},session:{id:'fixture-session'}};
return new Response(JSON.stringify(result),{status:200,headers});};
`);
    const result = spawnSync(process.execPath, ["--require", preload, script, "--execute", "--initialize-admins", "--stage", stage === "staff" ? "staff" : "bosses", "--input", join(root, "input.json"), "--credentials", join(root, "credentials.json"), "--out", out], { encoding: "utf8", timeout: 20000, env: { ...process.env, DB_PASSWORD_FILE: join(root, "password") } });
    assert.ok(existsSync(join(out, "receipt.json")), result.stderr + result.stdout);
    const receipt = JSON.parse(readFileSync(join(out, "receipt.json"))), calls = JSON.parse(readFileSync(callsFile)), posts = calls.filter(call => call.kind === "http");
    assert.ok(Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.finishedAt)) && receipt.wallMs >= 0);
    assert.ok(receipt.steps.every(step => Number.isFinite(Date.parse(step.startedAt)) && Number.isFinite(Date.parse(step.finishedAt)) && step.wallMs >= 0));
    assert.equal(receipt.preflightRollbackAck, true);
    assert.equal(receipt.preflightClientClosed, true);
    assert.equal(receipt.unlock, true);
    assert.equal(receipt.maintenanceClosed, true);
    assert.doesNotMatch(result.stdout, /fixture-final-password|JBSWY3DPEHPK3PXP/);
    if (stage === "partial-failure") {
        assert.equal(result.status, 1);
        assert.equal(receipt.status, "STOPPED_POSSIBLE_PARTIAL_APPLICATION");
        assert.ok(receipt.pendingStepTiming?.wallMs >= 0 && Number.isFinite(Date.parse(receipt.pendingStepTiming.finishedAt)));
        assert.equal(posts.filter(call => call.path.endsWith("/bootstrap")).length, 1);
        assert.equal(receipt.steps.some(step => step.path.endsWith("/enrollment/activate")), false);
    } else {
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(receipt.status, "FORMAL_INITIALIZATION_COMPLETED");
        assert.equal(receipt.finalReadbackRollbackAck, true);
        assert.equal(receipt.verified.administrators, stage === "bosses" ? 2 : 4);
        if (stage === "staff") for (const post of posts.filter(call => call.path.endsWith("/admins/create"))) {
            assert.equal(post.body.mode, "SELECTED_GAMES");
            assert.deepEqual(post.body.gameIds, ["delta-id"]);
            assert.deepEqual(post.body.allowPermissions, []);
        }
    }
});
