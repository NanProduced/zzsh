// A separately registered, empty, synthetic DB only; no R07 or external connections.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve}=require('node:path');
const container=process.env.R08_CAPTURE_SYNTH_CONTAINER,system=process.env.R08_CAPTURE_SYNTH_SYSTEM,oid=process.env.R08_CAPTURE_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container||'')&&/^[0-9]+$/.test(system||'')&&/^[0-9]+$/.test(oid||''),'synthetic identity required');
const run=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
const inspect=run(['inspect',container,'--format','{{.Id}}|{{index .Config.Labels "zzsh.task"}}|{{.HostConfig.NetworkMode}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}']);
assert.equal(inspect.status,0);assert.equal(inspect.stdout.trim(),`${container}|r08-account-capture-synth|none|[]|{}`);
const check=run(['exec','-i','-u','postgres',container,'psql','-p','55432','-U','postgres','-d','zzsh_test_capture_synth4','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
  "SELECT system_identifier FROM pg_control_system(); SELECT oid||'|'||shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database(); SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'zzsh_%';");
assert.equal(check.status,0);assert.equal(check.stdout.trim(),`${system}\n${oid}|zzsh:account-capture-synthetic:v1\n0`);
const code=String.raw`
const assert=require('node:assert/strict'),{Pool}=require('/work/node_modules/pg');
const {runBusinessMigrations,assertBusinessMigrationPrefix}=require('/work/apps/api/dist/src/database/business-migrations.js');
(async()=>{const p=new Pool({host:'127.0.0.1',port:55432,user:'postgres',database:'zzsh_test_capture_synth4'});
 await runBusinessMigrations(p,{runtimeUser:'r08_capture_runtime',initialInstall:true,initialBaseline:'release_production_0174'});
 await assertBusinessMigrationPrefix(p);await runBusinessMigrations(p,{runtimeUser:'r08_capture_runtime'});await assertBusinessMigrationPrefix(p);
 const rows=(await p.query('SELECT created_at::text AS at FROM zzsh_business_meta.migrations ORDER BY id')).rows;assert.deepEqual(rows.map(r=>r.at),['1793730640495','1793730640496']);
 const r=(await p.query("SELECT has_table_privilege('r08_capture_runtime','zzsh_supply.legacy_listing_capture_fact','SELECT') AS can_read,has_any_column_privilege('r08_capture_runtime','zzsh_supply.legacy_listing_capture_fact','INSERT,UPDATE,REFERENCES') AS can_write,(SELECT count(*)::int FROM pg_attribute WHERE attrelid='zzsh_supply.legacy_listing_capture_fact'::regclass AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NOT NULL) AS commented,col_description('zzsh_supply.legacy_listing_capture_fact'::regclass,1) AS first_comment,obj_description('zzsh_supply.legacy_listing_capture_fact'::regclass) AS table_comment")).rows[0];
 assert.equal(r.can_read,true);assert.equal(r.can_write,false);assert.equal(r.commented,13);assert(r.first_comment&&r.table_comment);await p.end();
})().catch(e=>{console.error(e);process.exit(1)});`;
const out=run(['run','--rm','--network',`container:${container}`,'--mount',`type=bind,source=${resolve(__dirname,'../../..')},target=/work,readonly`,'node:24.20.0-bookworm-slim','node','-e',code]);
if(out.status!==0)throw Error(`synthetic migration failed: ${out.stderr}`);
console.log('SYNTHETIC_CAPTURE_CHAIN_PASSED');
