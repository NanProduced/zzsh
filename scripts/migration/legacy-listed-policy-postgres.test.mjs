import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSameCaptureListedPolicyBatches, collectListedAccounts } from './legacy-listed-round-source.mjs';
import { assertSameCapturePolicyMigration, sameCapturePolicyGuardDigest } from './legacy-listed-execution-plan.mjs';

const require=createRequire(import.meta.url),{ Pool }=require('pg');
const { runBusinessMigrations }=require('../../apps/api/dist/src/database/business-migrations.js');
const { canonicalize }=require('../../apps/api/dist/src/supply/content-hash.js');
const { legacyPriceInteger }=require('../../apps/api/dist/src/supply/legacy-listed-pricing.js');
const { readLegacyListedPolicy }=require('../../apps/api/dist/src/supply/legacy-listed-policy.js');
const sha=value=>createHash('sha256').update(value).digest('hex');
const sql=name=>readFileSync(fileURLToPath(new URL(`../../apps/api/migrations/business/${name}.sql`,import.meta.url)),'utf8');
const quoteGuard=text=>text.slice(text.indexOf(' ELSIF NOT EXISTS('),text.indexOf(' RETURN NEW;')).replace(/\s+/g,' ');

test('same-capture migration preserves the original quote and immutable guards',()=>{
 const original=sql('0156_legacy_listed_quote'),upgrade=sql('0194_legacy_listed_policy_same_capture');
 assert.notEqual(quoteGuard(original),'');assert.equal(quoteGuard(upgrade),quoteGuard(original));
 for(const guard of ["TG_OP<>'INSERT'", "current_setting('zzsh.actor_type',true)", "current_setting('zzsh.actor_id',true)"])
  assert.ok(upgrade.includes(guard));
});

async function policies(){
 const rows=[{id:'1',status:'3',is_delete:'0',game_id:'1'}],scan=await collectListedAccounts(rows,canonicalize);
 const names=['barrettBullet','bullet','awm','armor','helmet','coffee','experienceCard','barrettBulletSale','bulletSale','awmSale','armorSale','helmetSale','coffeeSale','experienceCardSale'];
 const settings=names.map((name,i)=>({id:String(i+1),type:'expendConfig',name,value:'1'}));settings.push({id:'99',type:'game',name:'profitFirstDot',value:'12'});
 const games=[{id:'1',is_delete:'0',profit_dot:'6'}],receipt={schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,
  containerId:'d'.repeat(64),database:'sg_zzsh_restore',startedAt:'2026-11-03T08:00:00Z',finishedAt:'2026-11-03T08:01:00Z',
  identity:{database:'sg_zzsh_restore',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE'},
  listedPricingCapture:{schema:'zzsh.legacy-listed-pricing-capture.v1',gameDomain:'games',gameProfitField:'profit_dot',fastConfigDomain:'tradePolicy',fastConfigType:'game',fastConfigName:'profitFirstDot',runtimeRedis:'NOT_CAPTURED'},
  files:{accounts:{rows:1},games:{rows:1,fields:['id','profit_dot']},tradePolicy:{rows:15,fields:['id','type','name','value']}}};
 const sourceReceiptSha256='a'.repeat(64),sourceBindingSha256='b'.repeat(64),dumpSha256='c'.repeat(64),verifierSha256='f'.repeat(64);
 const dump={schema:'zzsh.legacy-listing-dump-policy-check.v1',sourceDumpSha256:dumpSha256,sourceCutoff:'2026-11-03T07:59:00Z',
  sourceCutoffMeaning:'OWNER_LOCAL_DUMP_EXPORT_COMPLETED_NOT_PROVEN_PRODUCTION_STOP_WRITE_CUTOFF',gameId:'1',ordinaryProfitDot:'6',fastProfitFirstDot:'12',matchCounts:{game:1,fastConfig:1}};
 const v2=buildSameCaptureListedPolicyBatches({receipt,sourceReceiptSha256,sourceBindingSha256,dumpSha256,verifierSha256,dump,scan,games,settings,canonicalize,parseInteger:legacyPriceInteger}).policies[0];
 const v1=structuredClone(v2);v1.schema='legacy-listed-policy-evidence-v1';v1.temporalLimit='DUMP_AND_LATER_RESTORE_AGREE_CAPTURE_OMITTED_SPREADS_NO_PROOF_OF_INTERMEDIATE_UNCHANGED';
 Object.assign(v1.supplement,{schema:'legacy-listed-policy-supplement-v1',comparison:'EXACT_LISTED_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL',temporalLimit:'TWO_SPREAD_FIELDS_WERE_NOT_IN_BASE_CAPTURE',startedAt:'2026-11-04T08:00:00Z',finishedAt:'2026-11-04T08:01:00Z'});
 delete v1.supplement.clientClosed;v1.supplementSha256=sha(canonicalize(v1.supplement));
 const freeze=policy=>{
  const text=canonicalize(policy),proofSha256=sha(text),authorityCanonical=canonicalize({schema:'legacy-listed-policy-authority-v1',decision:'OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY',
   scope:'LOCAL_AND_TEST_SERVER',runtimeCacheKnowledge:'UNKNOWN',productionCutover:'REVERIFY_SOURCE_RUNTIME_POLICY',sourceReceiptSha256,sourceBindingSha256,dumpSha256,
   policyBundleSha256:proofSha256,authorityRef:'synthetic',instruction:'Synthetic fixture only'});
  return readLegacyListedPolicy(text,{proofSha256,sourceReceiptSha256,sourceBindingSha256,dumpSha256,dumpVerifierSha256:verifierSha256,
   sourceId:'1',sourceDigest:scan.digests.get('1'),legacyGameId:'1',expectedAccountCount:1,authorityCanonical,authoritySha256:sha(authorityCanonical)});
 };
 return {v1:freeze(v1),v2:freeze(v2)};
}

test('initial and upgraded PostgreSQL accept only correctly bound V1/V2 listed policy evidence', {skip:!process.env.ZZSH_SYNTH_LISTED_PORT}, async()=>{
 const port=process.env.ZZSH_SYNTH_LISTED_PORT,system=process.env.ZZSH_SYNTH_LISTED_SYSTEM;
 assert.match(port??'',/^[1-9][0-9]{3,4}$/);assert.match(system??'',/^[0-9]+$/);
 const pool=new Pool({host:'127.0.0.1',port:Number(port),database:'zzsh_synth_listed_policy',user:'postgres',max:1,connectionTimeoutMillis:3000});
 try {
  const identity=(await pool.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
   shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
   (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
  assert.deepEqual(identity,{database:'zzsh_synth_listed_policy',system,marker:'zzsh:synthetic:listed-policy-v2',schemas:0});
  const options={runtimeUser:'zzsh_synth_listed_runtime',initialInstall:true,initialBaseline:'release_production_0174'};
  await runBusinessMigrations(pool,options);await runBusinessMigrations(pool,options);
  const role=(await pool.query(`SELECT has_table_privilege('zzsh_synth_listed_runtime','zzsh_supply.legacy_listed_policy_evidence','SELECT') AS can_read,
   has_table_privilege('zzsh_synth_listed_runtime','zzsh_supply.legacy_listed_policy_evidence','INSERT') AS can_insert`)).rows[0];
  assert.deepEqual(role,{can_read:true,can_insert:false});
  await pool.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES ('synth-admin','Synthetic','listed@example.invalid',now(),now())`);
  const {v1,v2}=await policies();
  assert.equal(JSON.parse(v1.policyCanonical).schema,'legacy-listed-policy-frozen-v1');
  assert.equal(JSON.parse(v2.policyCanonical).schema,'legacy-listed-policy-frozen-v2');
  const client=await pool.connect();
  try {
   const migration=sql('0194_legacy_listed_policy_same_capture');
   const journal=JSON.parse(readFileSync(fileURLToPath(new URL('../../apps/api/migrations/business/meta/_journal.json',import.meta.url))));
   const entry=journal.entries.find(row=>row.tag==='0194_legacy_listed_policy_same_capture');assert.ok(entry);
   const migrationWitness=()=>assertSameCapturePolicyMigration(client,sha(migration),entry.when,sameCapturePolicyGuardDigest(migration));
   await assert.doesNotReject(migrationWitness());
   const insert=policy=>{const canonical=typeof policy==='string'?policy:canonicalize(policy);return client.query(`INSERT INTO zzsh_supply.legacy_listed_policy_evidence
    (policy_digest,policy_canonical,policy,created_by_admin_id) VALUES ($1,$2::text,$2::text::jsonb,'synth-admin')`,[sha(canonical),canonical]);};
   const rejected=async(policy,code='23514')=>{await client.query('SAVEPOINT rejected');await assert.rejects(insert(policy),error=>error.code===code);
    await client.query('ROLLBACK TO SAVEPOINT rejected');await client.query('RELEASE SAVEPOINT rejected');};
   const old=sql('0156_legacy_listed_quote').match(/CREATE FUNCTION zzsh_supply\.guard_legacy_listed_evidence\(\) RETURNS trigger[\s\S]*?\nEND \$\$;/)?.[0];
   assert.ok(old);await client.query(old.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
   await assert.rejects(migrationWitness(),/LISTED_SAME_CAPTURE_MIGRATION_NOT_READY/);
   await client.query('BEGIN');await client.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','synth-admin',true)");
   await insert(v1.policyCanonical);await rejected(v2.policyCanonical);await client.query('ROLLBACK');
   await client.query(migration);await assert.doesNotReject(migrationWitness());
   const changedGuard=migration.replace("IF TG_OP<>'INSERT'","IF TG_OP<>'UPDATE'");assert.notEqual(changedGuard,migration);
   await client.query(changedGuard);await assert.rejects(migrationWitness(),/LISTED_SAME_CAPTURE_MIGRATION_NOT_READY/);
   await client.query(migration);await client.query('ALTER TABLE zzsh_supply.legacy_listed_policy_evidence DISABLE TRIGGER legacy_listed_policy_evidence_guard');
   await assert.rejects(migrationWitness(),/LISTED_SAME_CAPTURE_MIGRATION_NOT_READY/);
   await client.query('ALTER TABLE zzsh_supply.legacy_listed_policy_evidence ENABLE TRIGGER legacy_listed_policy_evidence_guard');await assert.doesNotReject(migrationWitness());
   await client.query('BEGIN');await client.query("SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','synth-admin',true)");
   await insert(v1.policyCanonical);await insert(v2.policyCanonical);
   const source=JSON.parse(v2.policyCanonical);
   for(const mutate of [
    p=>{p.temporalLimit='REDIS_CONFIRMED';},p=>{delete p.temporalLimit;},p=>{p.supplementStartedAt='2026-11-04T00:00:00Z';},
    p=>{delete p.baseCaptureStartedAt;},p=>{p.sourceBindingSha256='';},p=>{p.verifierSha256='';},p=>{p.accountSourceDigests[0].sha256='bad';},
    p=>{p.sourceAccountCount=2;},p=>{p.policyAuthority.runtimeCacheKnowledge='KNOWN';},p=>{p.sourceSystem='other';},p=>{p.schema='unknown';},
   ]) {const changed=structuredClone(source);mutate(changed);await rejected(changed);}
   await client.query("SELECT set_config('zzsh.actor_id','other',true)");
   const other=structuredClone(source);other.evidenceBundleSha256='9'.repeat(64);await rejected(other);
   await client.query("SELECT set_config('zzsh.actor_id','synth-admin',true)");
   await client.query('SAVEPOINT immutable');await assert.rejects(client.query(`UPDATE zzsh_supply.legacy_listed_policy_evidence SET policy=policy WHERE policy_digest=$1`,[v2.policyDigest]),error=>error.code==='40001');
   await client.query('ROLLBACK TO SAVEPOINT immutable');await client.query('RELEASE SAVEPOINT immutable');
   await client.query('SAVEPOINT immutable');await assert.rejects(client.query(`DELETE FROM zzsh_supply.legacy_listed_policy_evidence WHERE policy_digest=$1`,[v2.policyDigest]),error=>error.code==='40001');
   await client.query('ROLLBACK TO SAVEPOINT immutable');await client.query('RELEASE SAVEPOINT immutable');
   await client.query('ROLLBACK');
  } finally { client.release(); }
 } finally { await pool.end(); }
});
