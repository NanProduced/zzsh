// Opt-in synthetic database only. Never points to R07 or an external service.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const container = process.env.R08_CAPTURE_SYNTH_CONTAINER;
const system = process.env.R08_CAPTURE_SYNTH_SYSTEM;
const oid = process.env.R08_CAPTURE_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container || '') && /^[0-9]+$/.test(system || '') && /^[0-9]+$/.test(oid || ''), 'synthetic identity required');
const name = process.env.R08_CAPTURE_SYNTH_DB;
assert(/^zzsh_test_capture_synth(?:[2-9])?$/.test(name || ''), 'synthetic database required');
function docker(args, input) { return spawnSync('docker', args, { input, encoding:'utf8', windowsHide:true, maxBuffer:4*1024*1024 }); }
const inspection=docker(['inspect',container,'--format','{{.Id}}|{{index .Config.Labels "zzsh.task"}}|{{.HostConfig.NetworkMode}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}']);
assert.equal(inspection.status,0); assert.equal(inspection.stdout.trim(),`${container}|r08-account-capture-synth|none|[]|{}`);
function sql(code, expectOk=true) {
  const out=docker(['exec','-i','-u','postgres',container,'psql','-p','55432','-U','postgres','-d',name,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],code);
  if(expectOk && out.status!==0)throw Error(`synthetic SQL failed: ${out.stderr}`);
  if(!expectOk)assert.notEqual(out.status,0,'expected SQL rejection');
  return out.stdout.trim();
}
const identity=sql(`SELECT system_identifier FROM pg_control_system(); SELECT oid||'|'||shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database();`);
assert.equal(identity,`${system}\n${oid}|zzsh:account-capture-synthetic:v1`);
sql(`SET ROLE r08_capture_owner;
CREATE SCHEMA zzsh_auth_admin; CREATE SCHEMA zzsh_supply; CREATE SCHEMA zzsh_iam;
CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY);
CREATE TABLE zzsh_supply.rental_account(id text PRIMARY KEY,game_id text);
CREATE TABLE zzsh_supply.idempotency_record(scope_key text,key text,request_fingerprint text,response_status int,response_body jsonb,publish_required boolean,PRIMARY KEY(scope_key,key));
CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,object_id text,outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb);
CREATE TABLE zzsh_supply.listing_version(id text,account_id text,PRIMARY KEY(id,account_id));
CREATE TABLE zzsh_supply.legacy_listing_read_snapshot(account_id text PRIMARY KEY,legacy_id text,observation_version_id text,source_digest text,source_updated_at timestamptz);
CREATE TABLE zzsh_supply.legacy_listing_display_snapshot(account_id text,schema_version int,observation_version_id text,base_source_digest text,source_updated_at timestamptz,display_digest text,snapshot jsonb,PRIMARY KEY(account_id,schema_version));
CREATE FUNCTION zzsh_supply.guard_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;
INSERT INTO zzsh_auth_admin."user" VALUES('admin');
INSERT INTO zzsh_supply.rental_account SELECT 'a'||n,'game1' FROM generate_series(1,7)n;
INSERT INTO zzsh_supply.listing_version SELECT 'v'||n,'a'||n FROM generate_series(1,7)n;
INSERT INTO zzsh_supply.legacy_listing_read_snapshot SELECT 'a'||n,n::text,'v'||n,repeat('a',64),'2026-11-03T00:00:00Z' FROM generate_series(1,7)n;
INSERT INTO zzsh_supply.legacy_listing_display_snapshot SELECT 'a'||n,1,'v'||n,repeat('a',64),'2026-11-03T00:00:00Z',repeat('b',64),CASE WHEN n=7 THEN '{"sourceAccountFullPayoutSelected":false}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1,7)n;`);
const migration=readFileSync(join(__dirname,'../migrations/business/0175_legacy_account_capture_facts.sql'),'utf8');
sql('SET ROLE r08_capture_owner;\n'+migration);
const values=(n,ratio,ratioIssue,payout,payoutIssue,source="repeat('a',64)")=>`('a${n}','v${n}',${source},repeat('b',64),repeat('c',64),'2026-11-03T00:00:00Z',${ratio},${ratioIssue},${payout},${payoutIssue},repeat('d',64),'admin')`;
const insert=values=>`SET ROLE r08_capture_owner; INSERT INTO zzsh_supply.legacy_listing_capture_fact(account_id,observation_version_id,base_source_digest,display_digest,capture_sha256,source_updated_at,base_ratio_wan_per_yuan,ratio_issue,full_payout_selected,payout_issue,evidence_digest,created_by_admin_id) VALUES ${values};`;
sql(insert(values(1,"'56'",'NULL','false','NULL')));
sql(insert(values(2,'NULL',"'base_bot:MISSING'",'NULL',"'is_full_payout:UNKNOWN'")));
sql(insert(values(3,'NULL','NULL','NULL',"'is_full_payout:UNKNOWN'")),false);
sql(insert(values(4,"'invalid'",'NULL','true','NULL')),false);
sql(insert(values(5,"'56'",'NULL','true','NULL',"repeat('f',64)")),false);
sql(insert(values(6,"'0'",'NULL','false','NULL')),false);
sql(insert(values(7,"'56'",'NULL','true','NULL')),false);
sql("SET ROLE r08_capture_owner; UPDATE zzsh_supply.legacy_listing_capture_fact SET base_ratio_wan_per_yuan='57' WHERE account_id='a1';",false);
sql("SET ROLE r08_capture_owner; DELETE FROM zzsh_supply.legacy_listing_capture_fact WHERE account_id='a1';",false);
sql("SET ROLE r08_capture_owner; GRANT USAGE ON SCHEMA zzsh_supply TO r08_capture_runtime; GRANT INSERT(account_id) ON zzsh_supply.legacy_listing_capture_fact TO r08_capture_runtime; GRANT SELECT(account_id) ON zzsh_supply.legacy_listing_capture_fact TO PUBLIC;");

// Run the actual TypeScript-compiled ACL setup against this namespace-only synthetic server.
const root=resolve(__dirname,'../../..');
const code=`const {Client}=require('/work/node_modules/pg');const {configureLegacyCaptureFactPrivileges}=require('/work/apps/api/dist/src/database/business-migrations.js');(async()=>{const c=new Client({host:'127.0.0.1',port:55432,user:'postgres',database:'${name}'});await c.connect();await configureLegacyCaptureFactPrivileges(c,'r08_capture_runtime');await c.end();})().catch(e=>{console.error(e);process.exit(1)});`;
const acl=docker(['run','--rm','--network',`container:${container}`,'--mount',`type=bind,source=${root},target=/work,readonly`,'node:24.20.0-bookworm-slim','node','-e',code]);
if(acl.status!==0)throw Error(`synthetic ACL setup failed: ${acl.stderr}`);
assert.equal(sql(`SELECT has_table_privilege('r08_capture_runtime','zzsh_supply.legacy_listing_capture_fact','SELECT')||'|'||has_table_privilege('r08_capture_runtime','zzsh_supply.legacy_listing_capture_fact','INSERT')||'|'||has_any_column_privilege('r08_capture_runtime','zzsh_supply.legacy_listing_capture_fact','INSERT')||'|'||EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x WHERE c.oid='zzsh_supply.legacy_listing_capture_fact'::regclass AND x.grantee=0)||'|'||EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='zzsh_supply.legacy_listing_capture_fact'::regclass AND x.grantee=0);`),'true|false|false|false|false');
sql(insert(values(3,"'56'",'NULL','false','NULL')).replace('SET ROLE r08_capture_owner','SET ROLE r08_capture_runtime'),false);
assert.equal(sql(`SELECT count(*) FROM zzsh_supply.legacy_listing_capture_fact;`),'2');

// Real transaction, audit and idempotency SQL; authorization is a documented synthetic stub.
const batchCode=String.raw`
const assert=require('node:assert/strict'),{Client}=require('/work/node_modules/pg');
const Module=require('node:module'),originalLoad=Module._load;Module._load=function(name,...rest){if(name==='sharp')return()=>{throw Error('sharp is not part of this synthetic test')};return originalLoad.call(this,name,...rest)};
const a=require('/work/apps/api/dist/src/auth/admin-authorization.js'),u=require('/work/apps/api/dist/src/supply/supply-util.js');
a.loadEffectiveAdminAccess=async()=>({isBoss:true,permissions:new Set(['supply.catalog.manage'])});a.requirePermission=()=>{};u.assertGameScope=async()=>{};
const {canonicalize}=require('/work/apps/api/dist/src/supply/content-hash.js'),{recordLegacyAccountCaptureFactsBatch}=require('/work/apps/api/dist/src/supply/legacy-account-capture-maintenance.js');
(async()=>{const c=new Client({host:'127.0.0.1',port:55432,user:'postgres',database:'${name}'});await c.connect();await c.query('SET ROLE r08_capture_owner');
 const inputs=[];for(const n of [8,9]){const source={id:String(n),base_bot:n===8?'56':null,is_full_payout:n===8?'0':'1'},digest=u.sha256Hex(canonicalize(source));
  await c.query('INSERT INTO zzsh_supply.rental_account VALUES($1,$2)', ['a'+n,'game1']);await c.query('INSERT INTO zzsh_supply.listing_version VALUES($1,$2)',['v'+n,'a'+n]);
  await c.query('INSERT INTO zzsh_supply.legacy_listing_read_snapshot VALUES($1,$2,$3,$4,$5)',['a'+n,String(n),'v'+n,digest,'2026-11-03T00:00:00.000Z']);
  await c.query('INSERT INTO zzsh_supply.legacy_listing_display_snapshot VALUES($1,1,$2,$3,$4,$5,$6)',['a'+n,'v'+n,digest,'2026-11-03T00:00:00.000Z','b'.repeat(64),'{}']);
  inputs.push({binding:{accountId:'a'+n,legacyId:String(n),observationVersionId:'v'+n,baseSourceDigest:digest,displayDigest:'b'.repeat(64),captureSha256:'c'.repeat(64),sourceUpdatedAt:'2026-11-03T00:00:00.000Z'},source});}
 const actor={id:'admin',sessionId:'session',requestId:'attempt',reviewRef:'review',attempt:'attempt'};
 await c.query('BEGIN');const first=await recordLegacyAccountCaptureFactsBatch(c,inputs,actor);await c.query('COMMIT');assert.equal(first.count,2);assert.equal(first.created,2);assert.equal(first.replayed,false);
 await c.query('BEGIN');const replay=await recordLegacyAccountCaptureFactsBatch(c,inputs,actor);await c.query('COMMIT');assert.equal(replay.replayed,true);
 assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_iam.audit_event')).rows[0].n,1);assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_supply.idempotency_record')).rows[0].n,1);
 await assert.rejects(()=>recordLegacyAccountCaptureFactsBatch(c,[{...inputs[0],source:{...inputs[0].source,base_bot:'57'}}],actor));
 await c.query('BEGIN');await c.query('ALTER TABLE zzsh_supply.legacy_listing_capture_fact DISABLE TRIGGER legacy_capture_immutable');await c.query("DELETE FROM zzsh_supply.legacy_listing_capture_fact WHERE account_id='a8'");
 await c.query('ALTER TABLE zzsh_supply.legacy_listing_capture_fact ENABLE TRIGGER legacy_capture_immutable');await assert.rejects(()=>recordLegacyAccountCaptureFactsBatch(c,inputs,actor));await c.query('ROLLBACK');
 assert.equal((await c.query("SELECT count(*)::int AS n FROM zzsh_supply.legacy_listing_capture_fact WHERE account_id IN ('a8','a9')")).rows[0].n,2);await c.end();
})().catch(e=>{console.error(e);process.exit(1)});`;
const batch=docker(['run','--rm','--network',`container:${container}`,'--mount',`type=bind,source=${root},target=/work,readonly`,'node:24.20.0-bookworm-slim','node','-e',batchCode]);
if(batch.status!==0)throw Error(`synthetic batch failed: ${batch.stderr}`);
console.log('SYNTHETIC_CAPTURE_FACT_DB_PASSED');
