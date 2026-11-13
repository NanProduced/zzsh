import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSkinRetirementPackage } from "./derive-business-reference-skin-retirement.mjs";

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
    tables.find(table => table.table === "skin").columns.push({ name: "category_id", generated: "" });
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

function fixtureV2(t, change = () => {}) {
    const pkg = fixture(t, (tables, manifest) => {
        manifest.sourceRawUnchanged = true;
        const put = (name, rows) => { tables.find(table => table.table === name).rows = rows.map(row => JSON.stringify(row)); };
        tables.find(table => table.table === "game").rows = ['{"id":"game-1","code":"delta","catalog_revision":9007199254740993,"enabled":true,"current_release_id":"release-1"}'];
        put("game_service_operation", [{ id: "service-1", game_id: "game-1", service_code: "ACCOUNT_RENTAL", enabled: true }]);
        put("rule_release", [{ id: "release-1", game_id: "game-1", price_version_id: "price-1", term_version_id: "term-1", agreement_version_id: "agreement-1" }]);
        put("price_version", [{ id: "price-1", game_id: "game-1", status: "SEALED", mode: "SPREAD", rounding_policy: "HALF_UP_CENT_V1", funding_policy: null,
          haff_rule: { schema: "haff-ratio-v2", dailyDeltaByTermOption: { "daily-10m": "0" } } }]);
        put("term_version", [{ id: "term-1", game_id: "game-1", status: "SEALED" }]);
        put("agreement_version", [{ id: "agreement-1", game_id: "game-1", status: "SEALED", title: "合成协议", body: "合成条款", digest: hash("合成条款") }]);
        put("term_option", [{ id: "option-1", version_id: "term-1", code: "daily-10m", daily_consumption: 10000000, duration_rounding: "CEIL_DAY" }]);
        put("billable_item", [{ id: "haff-1", game_id: "game-1", enabled: true, unit: "HAFF_BASE" }, { id: "item-1", game_id: "game-1", enabled: true, unit: "PIECE" }]);
        put("price_line", [{ id: "line-1", price_version_id: "price-1", item_id: "haff-1", customer_tier: "STANDARD", pricing_kind: "HAFF_RATIO" },
          { id: "line-2", price_version_id: "price-1", item_id: "item-1", customer_tier: "STANDARD", pricing_kind: "FIXED_UNIT", unit_quantity: 1, buyer_unit_amount: 2, owner_unit_amount: 1 }]);
        tables.find(table => table.table === "skin_category").rows = ['{"id":"cat-1","game_id":"game-1","parent_id":null}'];
        tables.find(table => table.table === "skin_owner").rows = ['{"id":"owner-1","game_id":"game-1","kind":"MELEE_TYPE","enabled":false}'];
        const skin = tables.find(table => table.table === "skin");
        skin.rows = ['{"id":"skin-1","game_id":"game-1","category_id":"cat-1","owner_kind":"MELEE_TYPE","owner_id":null}'];
        change(tables, manifest);
    });
    const source = readFileSync(join(pkg.root, "manifest.json"));
    const originals = new Map(pkg.manifest.tables.map(d => [d.file, readFileSync(join(pkg.root, d.file))]));
    const {derived,files} = buildSkinRetirementPackage(source, originals, hash(source));
    for (const [name, value] of files) writeFileSync(join(pkg.root, name), value);
    return { ...pkg, derived, files, args: ["--manifest", join(pkg.root, "manifest.json"), "--manifest-sha", hash(derived.manifest)] };
}

test("OWNER_KIND_V2 verification recomputes source lineage without credentials", t => {
    const pkg = fixtureV2(t), result = run(["--verify", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).tables, 18);
    assert.equal(JSON.parse(result.stdout).connections, 0);
    assert.equal(JSON.parse(result.stdout).rentalReference.status, "SOURCE_RENTAL_REFERENCE_CHECKED");
});

for (const [name, mutate, code] of [
    ["disabled game", rows => { rows("game")[0].enabled = false; }, "GAME_UNAVAILABLE"],
    ["disabled rental service", rows => { rows("game_service_operation")[0].enabled = false; }, "SERVICE_UNAVAILABLE"],
    ["missing active release", rows => { rows("game")[0].current_release_id = null; }, "RELEASE_MISSING"],
    ["unsealed active price", rows => { rows("price_version")[0].status = "DRAFT"; }, "VERSION_MISSING:price_version"],
    ["missing funding declaration", rows => { delete rows("price_version")[0].funding_policy; }, "PRICE_RULE_MISSING"],
    ["changed agreement", rows => { rows("agreement_version")[0].body = "已改变"; }, "AGREEMENT_INVALID"],
    ["unmapped term", rows => { rows("term_option")[0].code = "not-mapped"; }, "TERM_OPTIONS_INCOMPLETE"],
    ["zero daily consumption", rows => { rows("term_option")[0].daily_consumption = 0; }, "TERM_OPTIONS_INCOMPLETE"],
    ["missing haff resource", rows => { rows("billable_item")[0].enabled = false; }, "HAFF_ITEM_MISSING"],
    ["unknown item state", rows => { delete rows("billable_item")[1].enabled; }, "ITEM_STATE_UNKNOWN"],
    ["missing price line", rows => { rows("price_line").pop(); }, "STANDARD_PRICE_MISSING"],
    ["wrong price kind", rows => { rows("price_line")[1].pricing_kind = "HAFF_RATIO"; }, "STANDARD_PRICE_INCOMPLETE"],
    ["zero price unit", rows => { rows("price_line")[1].unit_quantity = 0; }, "STANDARD_PRICE_INCOMPLETE"],
    ["negative buyer price", rows => { rows("price_line")[1].buyer_unit_amount = -1; }, "STANDARD_PRICE_INCOMPLETE"],
    ["unbound full payout terms", rows => { rows("price_version")[0].funding_policy = {}; }, "FULL_PAYOUT_TERMS_MISSING"],
]) test("OWNER_KIND_V2 refuses " + name + " before credentials", t => {
    const pkg = fixtureV2(t, tables => {
        const byName = new Map(tables.map(table => [table.table, table.rows.map(raw => JSON.parse(raw))]));
        mutate(name => byName.get(name));
        for (const table of tables) table.rows = byName.get(table.table).map(row => JSON.stringify(row));
    });
    const result = run(["--verify", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0); assert.ok(result.stderr.includes("BUSINESS_RENTAL_REFERENCE_" + code));
    assert.doesNotMatch(result.stderr, /ECONN|must-not-be-read/);
});

test("full payout reference must bind the sealed terms and their actual content", t => {
    const make = changed => fixtureV2(t, tables => {
        const priceTable = tables.find(table => table.table === "price_version"), price = JSON.parse(priceTable.rows[0]);
        const body = "合成包赔条款", digest = hash(body);
        price.funding_policy = { fullPayoutPolicyRef: "policy", fullPayoutPolicyVersion: "v1", disclosureVersion: "d1" };
        price.full_payout_terms_version_id = "terms-1"; price.full_payout_terms_digest = digest; price.full_payout_disclosure_version = "d1";
        const terms = { id: "terms-1", game_id: "game-1", status: "SEALED", policy_ref: "policy", policy_version: "v1", disclosure_version: "d1", title: "合成包赔", body, digest };
        if (changed) terms.body = "已改变";
        priceTable.rows = [JSON.stringify(price)]; tables.find(table => table.table === "full_payout_terms_version").rows = [JSON.stringify(terms)];
    });
    const good = run(["--verify", ...make(false).args]); assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).rentalReference.fullPayout, "REFERENCE_CHECKED");
    const bad = run(["--verify", ...make(true).args]); assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /BUSINESS_RENTAL_REFERENCE_FULL_PAYOUT_TERMS_MISMATCH/);
});

test("a retired V1 catalog remains readable for review but cannot initialize a new database", t => {
    const pkg = fixture(t);
    assert.equal(run(["--verify", ...pkg.args]).status, 0);
    const result = run(["--execute", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BUSINESS_CATALOG_PROFILE_RETIRED/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN|must-not-be-read/);
});

test("OWNER_KIND_V2 rejects forged evidence before credentials", t => {
    const pkg = fixtureV2(t), manifest = JSON.parse(pkg.derived.manifest);
    const evidence = join(pkg.root, manifest.catalogRetirementEvidenceFile);
    writeFileSync(evidence, '{}');
    const result = run(["--verify", ...pkg.args, "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SKIN_EVIDENCE_MISMATCH/);
    assert.doesNotMatch(result.stderr, /ECONN|must-not-be-read/);
});

test("OWNER_KIND_V2 rejects a changed target row even when its descriptor is rehashed", t => {
    const pkg = fixtureV2(t), manifest = JSON.parse(pkg.derived.manifest);
    const skin = manifest.tables.find(d => d.schema === "zzsh_supply" && d.table === "skin"), file = join(pkg.root, skin.file);
    const table = JSON.parse(readFileSync(file)); table.rows[0] = table.rows[0].replace('"MELEE_TYPE"', '"AGENT"');
    const changed = Buffer.from(JSON.stringify(table) + "\n"); writeFileSync(file, changed); skin.sha256 = hash(changed);
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n"); writeFileSync(join(pkg.root, "manifest.json"), manifestBytes);
    const result = run(["--verify", "--manifest", join(pkg.root, "manifest.json"), "--manifest-sha", hash(manifestBytes), "--credentials", "must-not-be-read"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SKIN_DERIVED_MANIFEST_MISMATCH/);
    assert.doesNotMatch(result.stderr, /ECONN|must-not-be-read/);
});

for (const [name, change, error] of [
    ["no identities", tables => tables.push({ schema: "zzsh_auth_admin", table: "session", columns: [], primaryKey: ["id"], rows: [] }), /REFERENCE_TABLE_NOT_ALLOWED/],
    ["all tables required", tables => tables.pop(), /BUSINESS_PACKAGE_SOURCE_OR_CLOSURE_REQUIRED/],
    ["V1 without category column", tables => { tables.find(table => table.table === "skin").columns = [{name:"id",generated:""}]; }, /BUSINESS_CATALOG_PROFILE_INVALID/],
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
    const pkg = fixtureV2(t), result = run(["--execute", ...pkg.args, "--credentials", "must-not-be-read"]);
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

for (const stage of ["bosses", "staff"]) test("next target refuses legacy admin enrollment before credentials: " + stage, { skip: process.platform !== "win32" }, t => {
    const pkg = fixture(t), root = pkg.root;
    const instance = { host: "127.0.0.1", port: 55439, systemIdentifier: "123456" };
    const target = { database: "zzsh_test_regression", oid: "123", nonce: "a1b2c3d4e5f60718293a4b5c", instance, migrationProfile: "LOCAL_MIGRATION_NEXT_V1" };
    const binding = { resource: { database: target.database, resourceOid: target.oid }, initialization: { nonce: target.nonce, imProvisioner: false, imIdentityRepository: false, imAppId: null }, origins: { apiOrigin: "http://127.0.0.1:4292", adminOrigin: "http://127.0.0.1:4291" } };
    const bindingBytes = JSON.stringify(binding), bindingFile = join(root, "binding.json");
    writeFileSync(bindingFile, bindingBytes);
    const input = { kind: "FORMAL_LOCAL_ADMIN_INITIALIZATION_V1", numberingDigits: 5, target, resource: "scene_test", names: { "boss-one": "Boss1", "boss-two": "Boss2", operations: "运营", support: "客服" }, serverBinding: { file: bindingFile, sha256: hash(bindingBytes) } };
    const inputBytes = JSON.stringify(input), inputFile = join(root, "input.json");
    writeFileSync(inputFile, inputBytes);
    writeFileSync(join(root, "resource.json"), JSON.stringify({ ...target, marker: "zzsh:regression-test:v1", roles: { migration: { name: "fixture_m", oid: "456" }, runtime: { name: "fixture_r", oid: "457" } } }));
    const out = join("E:/zzsh-local-state/restricted", "data-first-bootstrap-next-" + root.split(/[\\/]/).at(-1).toLowerCase());
    const result = run(["--execute", "--initialize-admins", "--stage", stage, "--input", inputFile, "--input-sha", hash(inputBytes), "--credentials", join(root, "missing-credentials.json"), "--out", out]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NEXT_MIGRATION_ADMISSION_INCOMPLETE/);
    assert.doesNotMatch(result.stderr, /ENOENT|ECONN/);
    assert.equal(existsSync(out), false);
});

test("business initialization refuses missing or changed legal input before reading credentials", t => {
    const pkg = fixtureV2(t), missing = run(["--execute", ...pkg.args, "--maintenance-admin-id", "existing-boss", "--credentials", "must-not-be-read"]);
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /BUSINESS_LEGAL_INPUT_REQUIRED/);
    assert.doesNotMatch(missing.stderr, /ENOENT|ECONN/);
    const input = join(pkg.root, "legal-input.json"); writeFileSync(input, "{}");
    const changed = run(["--execute", ...pkg.args, "--maintenance-admin-id", "existing-boss", "--maintenance-session-id", "existing-session",
      "--legal-input", input, "--legal-input-sha", "a".repeat(64), "--credentials", "must-not-be-read"]);
    assert.notEqual(changed.status, 0); assert.match(changed.stderr, /BUSINESS_LEGAL_INPUT_CHANGED/);
    assert.doesNotMatch(changed.stderr, /ECONN/);
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

for (const mode of ["commit", "replay", "rollback", "unknown", "commit-rollback-tag", "rollback-wrong-tag", "postcommit", "next-fence", "next-fence-lost", "skin-time", "skin-created", "skin-field", "v2-schema-old", "v2-schema-current", "session-expired", "target-rule-drift", "target-extra-price"]) test("business execution host: " + mode, { skip: process.platform !== "win32" }, t => {
    const pkg = fixtureV2(t, (tables, manifest) => {
        if (mode.startsWith("v2-")) return;
        tables.find(table => table.table === "firearm_classification").rows = ['{"id":"class-1","created_by_admin_id":"original-admin","updated_by_admin_id":null,"revision":9007199254740993}'];
        tables.find(table => table.table === "skin").rows = mode.startsWith("skin-") ? ['{"id":"skin-1","game_id":"game-1","category_id":"cat-1","owner_kind":"MELEE_TYPE","owner_id":null,"name":"original","created_at":"2026-01-01","updated_at":"2026-01-01"}'] : [];
        manifest.foreignKeys.push({ child: "zzsh_supply.firearm_classification", parent: "zzsh_auth_admin.user", columns: ["created_by_admin_id"], parentColumns: ["id"] });
    }), preload = join(pkg.root, "fake-pg.cjs"), calls = join(pkg.root, "calls.json"), receipt = join(pkg.root, "receipt.json"), parameters = join(pkg.root, "parameters.json");
    const requestedReceipt = "E:/zzsh-local-state/restricted/bootstrap-host-test.json";
    const registered = { database: "zzsh_test_regression", marker: "zzsh:regression-test:v1", oid: "123", nonce: "a1b2c3d4e5f60718293a4b5c", roles: { migration: { name: "fixture_m", oid: "456" }, runtime: { name: "fixture_r", oid: "457" } },
      ...(mode.startsWith('next-')?{instance:{host:'127.0.0.1',port:55435,systemIdentifier:'12345'},migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}:{}) };
    writeFileSync(join(pkg.root, "resource.json"), JSON.stringify(registered));
    writeFileSync(join(pkg.root, "credentials.json"), JSON.stringify({ migration: { name: "fixture_m", oid: "456", password: "fixture-only" } }));
    writeFileSync(join(pkg.root, "password.txt"), "fixture-only");
    const legalTerms = join(pkg.root, "terms.txt"), legalPrivacy = join(pkg.root, "privacy.txt"), legalInput = join(pkg.root, "legal-input.json");
    writeFileSync(legalTerms, "合成服务协议"); writeFileSync(legalPrivacy, "合成隐私政策");
    const apiDist = fileURLToPath(new URL("../../apps/api/dist/src/", import.meta.url));
    const build = Object.fromEntries(["legal/legal-documents.js", "auth/security-core.js", "supply/content-hash.js", "supply/supply-util.js"]
      .map(name => [name, hash(readFileSync(join(apiDist, name)))]));
    const legalManifest = { schema: "zzsh.legal-initial-source.v1", effectiveAt: "2026-01-01T00:00:00.000Z", build,
      terms: { path: legalTerms, sha256: hash(readFileSync(legalTerms)) }, privacy: { path: legalPrivacy, sha256: hash(readFileSync(legalPrivacy)) } };
    writeFileSync(legalInput, JSON.stringify(legalManifest));
    const referenceManifest = JSON.parse(readFileSync(join(pkg.root, "manifest.json")));
    const rentalSnapshot = Object.fromEntries(referenceManifest.tables.filter(row => row.schema === "zzsh_supply").map(row => [row.table,
      JSON.parse(readFileSync(join(pkg.root, row.file))).rows.map(raw => JSON.parse(raw))]));
    if (mode === "target-rule-drift") rentalSnapshot.game[0].enabled = false;
    if (mode === "target-extra-price") rentalSnapshot.price_line.push({ id: "extra", price_version_id: "price-1", item_id: "item-1", customer_tier: "VIP" });
    writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path'),mod=require('node:module'),net=require('node:net');
const mode=${JSON.stringify(mode)},receipt=${JSON.stringify(receipt)},callsFile=${JSON.stringify(calls)},paramsFile=${JSON.stringify(parameters)},requested=path.resolve(${JSON.stringify(requestedReceipt)});
const crypto=require('node:crypto'),legalInput=${JSON.stringify(legalManifest)},rentalSnapshot=${JSON.stringify(JSON.stringify(rentalSnapshot))};
const makeDoc=(key,type,title)=>{const body=fs.readFileSync(legalInput[key].path,'utf8').normalize('NFC').replace(/\\r\\n?/g,'\\n').trim();return{id:'fixture_'+key,docType:type,title,body,digest:crypto.createHash('sha256').update(body).digest('hex'),status:'SEALED',effectiveAt:legalInput.effectiveAt}};
const legalStub={normalizeLegalDocumentBody:value=>value.normalize('NFC').replace(/\\r\\n?/g,'\\n').trim(),legalDigest:value=>crypto.createHash('sha256').update(value).digest('hex'),readCurrentPlatformDocuments:async()=>({terms:makeDoc('terms','PLATFORM_TERMS','平台服务协议'),privacy:makeDoc('privacy','PLATFORM_PRIVACY','用户隐私政策')})};
const calls=[],rows=new Map(),writes=[],write=fs.writeFileSync,exists=fs.existsSync,originalLoad=mod._load;let inTx=false;
net.Socket.prototype.connect=function(){throw Error('REAL_NETWORK_FORBIDDEN')};
fs.existsSync=function(file){return path.resolve(String(file))===requested?false:exists.call(this,file)};
fs.writeFileSync=function(file,...rest){return write.call(this,path.resolve(String(file))===requested?receipt:file,...rest)};
mod.syncBuiltinESMExports();
async function query(sql,params=[]){calls.push(sql);
if(sql.includes('pg_try_advisory_lock($1::integer')||sql.includes('pg_try_advisory_xact_lock'))return {rows:[{acquired:true}]};
if(sql.includes('pg_locks l WHERE'))return {rows:[{database:'zzsh_test_regression',oid:'123',nonce:'a1b2c3d4e5f60718293a4b5c',system_identifier:'12345',held:mode!=='next-fence-lost'}]};
if(sql.includes('pg_locks WHERE'))return {rows:[{database:'postgres',system_identifier:'12345',held:true}]};
if(sql==='SELECT pg_backend_pid() AS pid')return {rows:[{pid:111}]};
if(sql.includes('pg_try_advisory_lock')||sql.includes('pg_advisory_unlock'))return {rows:[{ok:true}]};
if(sql.startsWith('SELECT current_database()'))return {rows:[{database:'zzsh_test_regression',oid:'123',nonce:'a1b2c3d4e5f60718293a4b5c',owner:'zzsh',marker:'zzsh:regression-test:v1',role:'fixture_m',role_oid:'456',is_super:'false',can_create_db:'false',can_create_role:'false',can_inherit:'false',can_bypass_rls:'false',system_identifier:mode.startsWith('next-')?'12345':null}]};
if(sql.includes('FOR SHARE OF a,u,s'))return {rows:mode==='session-expired'?[]:[{is_boss:true,status:'ACTIVE',suspended:false,password_change_required:false,two_factor:true,locked:false}]};
if(sql.includes('FOR SHARE OF a,u'))return {rows:[{is_boss:true,status:'ACTIVE',suspended:false}]};
if(sql.includes('AS "categoryTableAbsent"'))return {rows:[{categoryTableAbsent:mode!=='v2-schema-old',categoryColumnAbsent:mode!=='v2-schema-old'}]};
if(sql.includes('WITH target_game AS'))return {rows:[{snapshot:rentalSnapshot}]};
if(sql.includes('SELECT attname AS name'))return {rows:[{name:'id'},{name:'code'},{name:'catalog_revision'},{name:'category_id'}]};
if(sql.includes('FROM pg_constraint k CROSS'))return {rows:[{name:'id'}]};
if(sql.includes('SELECT sn.nspname'))return {rows:[]};
if(sql.startsWith('SELECT to_jsonb(t)=')){const key=sql.match(/FROM ("[^\"]+"\."[^\"]+")/)[1];
 if(key==='"zzsh_supply"."skin"'&&mode.startsWith('skin-')){const source=JSON.parse(params[0]),target={...source};target.updated_at='2026-02-01';if(mode==='skin-created')target.created_at='2026-02-01';if(mode==='skin-field')target.name='changed';
 const equal=(ignore)=>{const a={...source},b={...target};for(const field of ignore){delete a[field];delete b[field]}return JSON.stringify(a)===JSON.stringify(b)};
 return {rows:[{exact:equal([]),semantic:equal(['created_at','updated_at']),restore_time_only:equal(['updated_at'])}]};}
 return {rows:rows.has(key+':'+JSON.parse(params[0]).id)||mode==='replay'?[{exact:true,semantic:true,restore_time_only:true}]:[]};}
if(sql.startsWith('INSERT INTO')){if(mode==='rollback'||mode==='rollback-wrong-tag')throw Error('FIXTURE_INSERT_FAILURE');rows.set(sql.match(/^INSERT INTO ("[^\"]+"\."[^\"]+")/)[1]+':'+JSON.parse(params[0]).id,params[0]);writes.push(params[0]);}
if(sql==='COMMIT'&&mode==='unknown')throw Error('FIXTURE_COMMIT_TRANSPORT_UNKNOWN');
if(sql==='BEGIN'){inTx=true;return {rows:[],command:'BEGIN'};}
if(sql==='COMMIT'){inTx=false;return {rows:[],command:mode==='commit-rollback-tag'?'ROLLBACK':'COMMIT'};}
if(sql==='ROLLBACK'){inTx=false;return {rows:[],command:mode==='rollback-wrong-tag'?'UNKNOWN':'ROLLBACK'};}
if(sql.startsWith('SELECT u.id,s.id AS session_id')&&mode==='postcommit')throw Error('FIXTURE_POSTCOMMIT_FAILURE');
return {rows:[]};}
class Client{async connect(){calls.push('maintenance.connect')}query(...args){return query(...args)}async end(){calls.push('maintenance.end');write(callsFile,JSON.stringify(calls));write(paramsFile,JSON.stringify(writes))}}
class Pool{async connect(){calls.push('pool.connect');return {query,getTransactionStatus(){return inTx?'T':'I'},release(){calls.push('client.release')}}}async end(){calls.push('pool.end')}}
mod._load=function(name,...rest){return name==='pg'?{Client,Pool}:String(name).replaceAll(String.fromCharCode(92),'/').endsWith('/legal/legal-documents.js')?legalStub:originalLoad.call(this,name,...rest)};
`);
    const result = spawnSync(process.execPath, ["--require", preload, script, "--execute", ...pkg.args, "--maintenance-admin-id", "existing-boss", "--maintenance-session-id", "existing-session", "--legal-input", legalInput, "--legal-input-sha", hash(readFileSync(legalInput)), "--oid", "123", "--nonce", "a1b2c3d4e5f60718293a4b5c", "--credentials", join(pkg.root, "credentials.json"), "--receipt", requestedReceipt], { encoding: "utf8", timeout: 5000, env: { ...process.env, DB_PASSWORD_FILE: join(pkg.root, "password.txt") } });
    assert.ok(existsSync(receipt), (result.stderr||"") + (result.stdout||"") + " STATUS=" + result.status);
    const observed = JSON.parse(readFileSync(receipt)), sql = JSON.parse(readFileSync(calls));
    assert.equal(observed.database, "zzsh_test_regression");
    assert.equal(observed.catalogModel, "OWNER_KIND_V2");
    assert.ok(Number.isFinite(Date.parse(observed.startedAt)) && Number.isFinite(Date.parse(observed.finishedAt)) && observed.wallMs >= 0);
    assert.equal(observed.poolClosed, true);
    assert.equal(observed.maintenanceClosed, true);
    assert.equal(observed.unlock, true);
    if (mode === "commit" || mode === "replay" || mode === "skin-time" || mode === "v2-schema-current" || mode === 'next-fence') {
        assert.equal(result.status, 0, JSON.stringify({ error: observed.error, status: observed.status, step: observed.step }));
        assert.equal(observed.status, "REFERENCE_BOOTSTRAP_COMMITTED");
        assert.equal(observed.commitAck, true);
        if(mode==='next-fence'){assert.equal(observed.migrationProfile,'LOCAL_MIGRATION_NEXT_V1');assert.equal(observed.targetFence,'HELD_UNTIL_TRANSACTION_END');}
        assert.equal(observed.rentalReference.status, "SOURCE_RENTAL_REFERENCE_CHECKED");
        assert.equal(observed.legal.status, "EXACT_PRESENT"); assert.equal(observed.legal.inputSha256, hash(readFileSync(legalInput)));
        assert.equal(sql.filter(query => query.startsWith("INSERT INTO")).length, mode === "replay" ? 0 : 12);
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
    } else if (mode === "v2-schema-old") {
        assert.equal(result.status, 1);
        assert.equal(observed.status, "FAILED_STOPPED");
        assert.match(observed.error.message, /BUSINESS_CATALOG_PROFILE_SCHEMA_MISMATCH/);
        assert.equal(sql.includes("BEGIN"), false);
        assert.equal(sql.some(query => /^(INSERT INTO|UPDATE) /.test(query)), false);
    } else if (mode === "rollback" || mode === "skin-created" || mode === "skin-field" || mode === "session-expired" || mode === "target-rule-drift" || mode === "target-extra-price") {
        assert.equal(result.status, 1);
        assert.equal(observed.status, "FAILED_STOPPED");
        assert.equal(observed.rollbackAck, true);
        assert.equal(sql.filter(query => query === "ROLLBACK").length, 1);
        assert.equal(sql.includes("COMMIT"), false);
        if (mode === "session-expired") { assert.match(observed.error.message, /ACTIVE_EXISTING_MAINTENANCE_ADMIN_REQUIRED/); assert.equal(sql.some(query => query.startsWith('INSERT INTO')), false); }
        if (mode === "target-rule-drift") assert.match(observed.error.message, /BUSINESS_RENTAL_REFERENCE_GAME_UNAVAILABLE/);
        if (mode === "target-extra-price") assert.match(observed.error.message, /BUSINESS_RENTAL_TARGET_SOURCE_MISMATCH/);
        if (mode.startsWith("skin-")) {
            assert.match(observed.error.message, /REFERENCE_EXISTING_ROW_DIFFERS:zzsh_supply.skin/);
            assert.equal(sql.some(query => /^(INSERT INTO|UPDATE) "zzsh_supply"\."skin"/.test(query)), false);
        }
    } else if (mode === 'next-fence-lost') {
        assert.equal(result.status,1);assert.equal(observed.status,'FAILED_STOPPED');assert.equal(observed.rollbackAck,true);
        assert.equal(sql.some(query => /^(INSERT INTO|UPDATE) /.test(query)),false);assert.equal(sql.includes('COMMIT'),false);
    } else if (mode === 'rollback-wrong-tag') {
        assert.equal(result.status,1);assert.equal(observed.status,'REFERENCE_ROLLBACK_UNKNOWN');assert.equal(observed.rollbackAck,false);
        assert.equal(sql.includes('COMMIT'),false);
    } else if (mode === 'postcommit') {
        assert.equal(result.status,1);assert.equal(observed.status,'REFERENCE_COMMITTED_READBACK_REQUIRED');assert.equal(observed.commitAck,true);
        assert.equal(sql.includes('ROLLBACK'),false);
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
    const target = { database: "zzsh_test_regression", oid: "123", nonce: "a1b2c3d4e5f60718293a4b5c" };
    const binding = { resource: { database: target.database, resourceOid: target.oid }, initialization: { nonce: target.nonce, imProvisioner: false, imIdentityRepository: false, imAppId: null }, origins: { apiOrigin: "http://127.0.0.1:4292", adminOrigin: "http://127.0.0.1:4291" } };
    const bindingFile = join(root, "binding.json"), bindingBytes = JSON.stringify(binding);
    writeFileSync(bindingFile, bindingBytes);
    const bossProfile = { version: 1, localTest: true, resource: "scene_test", actors: Object.fromEntries(["boss-one", "boss-two"].map((alias, index) => [alias, { realm: "admin", origin: binding.origins.adminOrigin, userId: "new-admin-" + (index + 1), username: "zz0000" + (index + 1), password: "fixture-final-password", totp: { encoding: "base32", secret: "JBSWY3DPEHPK3PXP" } }])) };
    writeFileSync(join(root, "boss-profile.json"), JSON.stringify(bossProfile));
    const input = { kind: "FORMAL_LOCAL_ADMIN_INITIALIZATION_V1", numberingDigits: 5, target, resource: "scene_test", names: { "boss-one": "第一Boss", "boss-two": "第二Boss", operations: "运营", support: "客服" }, serverBinding: { file: bindingFile, sha256: hash(bindingBytes) }, bootstrapSecretFile: join(root, "bootstrap-secret"), bossProfileFile: join(root, "boss-profile.json") };
    writeFileSync(join(root, "input.json"), JSON.stringify(input));
    writeFileSync(join(root, "resource.json"), JSON.stringify({ ...target, marker: "zzsh:regression-test:v1", roles: { migration: { name: "fixture_m", oid: "456" }, runtime: { name: "fixture_r", oid: "457" } } }));
    writeFileSync(join(root, "credentials.json"), JSON.stringify({ migration: { name: "fixture_m", oid: "456", password: "fixture-only" } }));
    writeFileSync(join(root, "bootstrap-secret"), "fixture-only"); writeFileSync(join(root, "password"), "fixture-only");
    const preload = join(root, "formal-host.cjs");
    writeFileSync(preload, `const fs=require('node:fs'),mod=require('node:module'),net=require('node:net');
const stage=${JSON.stringify(stage)},callsFile=${JSON.stringify(callsFile)},calls=[],actors=stage==='staff'?[1,2].map(n=>({id:'new-admin-'+n,username:'zz0000'+n,is_boss:true,status:'ACTIVE',suspended:false,two_factor:true,password_change_required:false,game_scope_mode:'ALL_GAMES'})):[];
const originalLoad=mod._load;net.Socket.prototype.connect=function(){throw Error('REAL_NETWORK_FORBIDDEN')};
async function query(sql,params=[]){calls.push({kind:'sql',sql});if(sql.includes('pg_try_advisory_lock')||sql.includes('pg_advisory_unlock'))return {rows:[{ok:true}]};
if(sql.startsWith('SELECT current_database()'))return {rows:[{database:'zzsh_test_regression',oid:'123',owner:'zzsh',marker:'zzsh:regression-test:v1',nonce:'a1b2c3d4e5f60718293a4b5c',role:'fixture_m',role_oid:'456',is_super:'false',can_create_db:'false',can_create_role:'false',can_inherit:'false',can_bypass_rls:'false',system_identifier:null}]};
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
