import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({status:'PLAN_ONLY',required:['--execute','SKIN_RETIRE_SYNTH_CONTAINER','SKIN_RETIRE_SYNTH_OID'],connections:0}));process.exit(0);
}
const container=process.env.SKIN_RETIRE_SYNTH_CONTAINER,oid=process.env.SKIN_RETIRE_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container??'')&&/^[1-9]\d*$/.test(oid??''),'SYNTHETIC_RESOURCE_REQUIRED');
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});return r;}
const inspect=docker(['inspect','--format','{{.Id}} {{index .Config.Labels "zzsh.task"}} {{.HostConfig.NetworkMode}} {{json .NetworkSettings.Ports}}',container]);
assert.equal(inspect.status,0);assert.equal(inspect.stdout.trim(),`${container} skin-retirement-0159-synthetic none {}`,'SYNTHETIC_CONTAINER_MISMATCH');
function sql(text){return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','skin_retirement_synth'],text);}
const identity=sql("SELECT oid::text||'|'||shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database();");
assert.equal(identity.status,0);assert.equal(identity.stdout.trim(),`${oid}|zzsh:skin-retirement-0159-synthetic:v1`,'SYNTHETIC_DATABASE_MISMATCH');
const migration=readFileSync(resolve('apps/api/migrations/business/0159_retire_skin_categories.sql'),'utf8');
assert(!/\bCASCADE\b/i.test(migration),'CASCADE_REFUSED');
const require=createRequire(resolve('apps/api/package.json'));
const {configureSkinIdentityPrivileges}=require(resolve('apps/api/dist/src/database/business-migrations.js'));
async function acl(categoryPresent){const writes=[];const fake={query:async(sql,args=[])=>{
 if(sql.includes('count(*)'))return {rows:[{count:args[0].includes('owner_kind')?7:4}]};
 if(sql.includes("attname='category_id'"))return {rows:[{present:categoryPresent}]};
 if(sql.includes('AS present'))return {rows:[{present:true}]};writes.push(sql);return {rows:[]};}};
 await configureSkinIdentityPrivileges(fake,'skin_synthetic_runtime');assert.equal(writes.length,1);return writes[0];}
const afterAcl=await acl(false),beforeAcl=await acl(true);assert(!afterAcl.includes('category_id')&&beforeAcl.includes('category_id'),'SKIN_ACL_SCHEMA_BRANCH_INVALID');
const fixture=`
INSERT INTO zzsh_supply.game(id,code,name) VALUES ('game_delta','delta','Synthetic delta');
INSERT INTO zzsh_supply.skin_category(id,game_id,code,name) VALUES ('cat_a','game_delta','legacy_agent','Legacy agent');
INSERT INTO zzsh_supply.skin_owner(id,game_id,kind,code,name,enabled) VALUES
 ('owner_a','game_delta','AGENT','agent_a','Synthetic agent',true),('owner_m','game_delta','MELEE_TYPE','melee_m','Synthetic melee',false);
INSERT INTO zzsh_supply.skin(id,game_id,code,name,category_id) VALUES
 ('skin_a','game_delta','skin_a','Synthetic agent-A','cat_a'),('skin_u','game_delta','skin_u','Synthetic unknown','cat_a');
UPDATE zzsh_supply.skin SET owner_kind='AGENT',owner_id='owner_a',base_name='A' WHERE id='skin_a';
INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES('owner_u','Synthetic','u@example.invalid',now(),now());
INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('account_a','owner_u','game_delta');
INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,presentation) VALUES
 ('version_a','account_a',1,'{"skins":[{"id":"skin_a","categoryCode":"legacy_agent","categoryName":"Legacy agent","categoryModel":"RETIRED"}]}'::jsonb);
`;
const cases=[
 {name:'populated_catalogue_blocked',input:fixture,expect:'SKIN_CATEGORY_NONEMPTY_REQUIRES_ARCHIVE_PLAN'},
 {name:'fabricated_archive_blocked',input:fixture+"SET LOCAL zzsh.skin_category_archive_sha256='"+'a'.repeat(64)+"';\n",expect:'SKIN_CATEGORY_NONEMPTY_REQUIRES_ARCHIVE_PLAN'},
 {name:'partial_schema_blocked',input:'ALTER TABLE zzsh_supply.skin DROP COLUMN category_id;',expect:'SKIN_CATEGORY_SCHEMA_INCOMPLETE'},
 {name:'saved_legacy_filter_blocked',input:`INSERT INTO zzsh_supply.game(id,code,name) VALUES('game_delta','delta','Synthetic delta');
   INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES('admin_a','Synthetic','a@example.invalid',now(),now());
   INSERT INTO zzsh_supply.listing_filter_config(game_id,revision,config,created_by_admin_id) VALUES('game_delta',1,'{"schemaVersion":1,"fields":[{"key":"skinGroups","categoryIds":["cat_a"]}],"sorts":[]}'::jsonb,'admin_a');\n`,expect:'SKIN_CATEGORY_FILTER_CONFIG_REQUIRES_MIGRATION_PLAN'},
 {name:'unknown_dependency_blocked',input:'CREATE VIEW zzsh_supply.synthetic_category_dependency AS SELECT id FROM zzsh_supply.skin_category;',expect:'depend'},
 {name:'empty_install_and_replay',input:'',success:`${migration}
 CREATE ROLE skin_synthetic_runtime NOLOGIN;
 ${afterAcl}
 DO $$ BEGIN
   IF has_table_privilege('skin_synthetic_runtime','zzsh_supply.skin','INSERT') OR NOT has_column_privilege('skin_synthetic_runtime','zzsh_supply.skin','name','INSERT')
      OR has_column_privilege('skin_synthetic_runtime','zzsh_supply.skin','owner_kind','INSERT') OR has_column_privilege('skin_synthetic_runtime','zzsh_supply.skin','id','UPDATE')
      OR NOT has_column_privilege('skin_synthetic_runtime','zzsh_supply.skin','owner_kind','UPDATE') THEN RAISE EXCEPTION 'SKIN_RUNTIME_PRIVILEGES_INVALID'; END IF;
 END $$;
 INSERT INTO zzsh_supply.game(id,code,name) VALUES('game_new','delta','New game');
 INSERT INTO zzsh_supply.skin(id,game_id,code,name) VALUES('skin_new','game_new','skin_new','New draft');`},
];
for(const entry of cases){const result=sql(`BEGIN;\n${entry.input}\n${migration}\n${entry.success??''}\nROLLBACK;\n`);
 if(entry.expect){assert.notEqual(result.status,0,entry.name);assert((result.stderr??'').toLowerCase().includes(entry.expect.toLowerCase()),entry.name);}
 else assert.equal(result.status,0,entry.name+':'+result.stderr);
 const unchanged=sql("SELECT to_regclass('zzsh_supply.skin_category') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='zzsh_supply.skin'::regclass AND attname='category_id' AND NOT attisdropped) AND NOT EXISTS(SELECT 1 FROM zzsh_supply.game WHERE id IN ('game_delta','game_new','game_other'));");
 assert.equal(unchanged.status,0);assert.equal(unchanged.stdout.trim(),'t',entry.name+':ROLLBACK_NOT_CONFIRMED');
}
console.log(JSON.stringify({status:'SYNTHETIC_SKIN_RETIREMENT_DDL_PASSED',cases:cases.map(x=>x.name),target:'skin_retirement_synth',realData:false,sourceConnections:0}));
