// Opt-in synthetic integration. Uses a synthetic journal and explicit auth stub; never R07/online.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {Client}=require('pg');
const root=path.resolve(__dirname,'../..'),container=process.env.R08_LOADER_SYNTH_CONTAINER,system=process.env.R08_LOADER_SYNTH_SYSTEM,oid=process.env.R08_LOADER_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container||'')&&/^[0-9]+$/.test(system||'')&&/^[0-9]+$/.test(oid||''),'synthetic identity required');
const exec=(cmd,args,options={})=>spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024,...options});
const inspect=exec('docker',['inspect',container,'--format','{{.Id}}|{{index .Config.Labels "zzsh.task"}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}']);
assert.equal(inspect.status,0);assert.equal(inspect.stdout.trim(),`${container}|r08-capture-loader-synth|[]|{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55434"}]}`);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const db=process.env.R08_LOADER_SYNTH_DB,attempt=process.env.R08_LOADER_SYNTH_ATTEMPT;
 assert(/^zzsh_test_capture_loader_synth(?:[2-9])?$/.test(db||'')&&/^[1-9]$/.test(attempt||''),'synthetic DB and attempt required');
 const admin=new Client({host:'127.0.0.1',port:55434,user:'postgres',database:db});await admin.connect();
 const identity=(await admin.query(`SELECT (SELECT system_identifier::text FROM pg_control_system()) AS system,d.oid::text,shobj_description(d.oid,'pg_database') AS marker,
  (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS occupied FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{system,oid,marker:'zzsh:r07-delivery-clone:v1',occupied:0});
 const {canonicalize}=require('../../apps/api/dist/src/supply/content-hash.js'),{configureLegacyCaptureFactPrivileges}=require('../../apps/api/dist/src/database/business-migrations.js');
 const {writePrivate}=await import('../local-auth.mjs');
 const base=`E:/zzsh-local-state/restricted/r08-capture-loader-fixture-20261108-0${attempt}`,src=path.join(base,'source'),datasetDir=path.join(base,'dataset'),reg=path.join(base,'registry');
 assert(!fs.existsSync(base),'synthetic fixture output already exists');writePrivate(path.join(src,'init.json'),{fixture:true});writePrivate(path.join(datasetDir,'init.json'),{fixture:true});writePrivate(path.join(reg,'init.json'),{fixture:true});
 const raws=[{id:'101',base_bot:'56',is_full_payout:'0'},{id:'102',base_bot:'43',is_full_payout:'1'},{id:'103',base_bot:'55',is_full_payout:'0'}],timestamp='2026-11-03T00:00:00.000Z';
 const sourceBytes=Buffer.from(raws.map(x=>JSON.stringify(x)).join('\n')+'\n');fs.writeFileSync(path.join(src,'accounts.jsonl'),sourceBytes,{flag:'wx'});
 const receipt={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{accounts:{file:'accounts.jsonl',sha256:digest(sourceBytes),rows:3}}};
 writePrivate(path.join(src,'receipt.json'),receipt);const receiptSha=digest(fs.readFileSync(path.join(src,'receipt.json')));
 const chosen=raws.slice(0,2).map(x=>({sourceId:x.id,sourceDigest:digest(canonicalize(x)),sourceUpdatedAt:timestamp}));
 const selectedBytes=Buffer.from(chosen.map(x=>JSON.stringify(x)).join('\n')+'\n');fs.writeFileSync(path.join(datasetDir,'accounts.jsonl'),selectedBytes,{flag:'wx'});
 const dataset={schema:'zzsh.local-legacy-dataset.v1',status:'FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN',source:src,sourceReceiptSha256:receiptSha,
  files:{accounts:{file:'accounts.jsonl',sha256:digest(selectedBytes),rows:chosen.length}}};writePrivate(path.join(datasetDir,'manifest.json'),dataset);
 const datasetSha=digest(fs.readFileSync(path.join(datasetDir,'manifest.json'))),nonce='0123456789abcdef01234567';
 const roles=(await admin.query("SELECT rolname,oid::text FROM pg_roles WHERE rolname IN ('r08_loader_migration','r08_loader_runtime')")).rows;
 const role=name=>roles.find(x=>x.rolname===name).oid;
 const resource={database:db,oid,owner:'r08_loader_owner',marker:'zzsh:r07-delivery-clone:v1',nonce,
  instance:{host:'127.0.0.1',port:55434,systemIdentifier:system},roles:{migration:{name:'r08_loader_migration',oid:role('r08_loader_migration')},runtime:{name:'r08_loader_runtime',oid:role('r08_loader_runtime')}},
  lockKey:'806007',protectedDataset:{manifestSha256:datasetSha}};
 writePrivate(path.join(reg,'resource.json'),resource);writePrivate(path.join(reg,'credentials.json'),{migration:{name:'r08_loader_migration',oid:role('r08_loader_migration'),password:'synthetic-only'}});
 const actorPath=path.join(base,'actor.json');writePrivate(actorPath,{realm:'admin',resourceOid:oid,nonce,id:'synthetic-admin',sessionId:'synthetic-session'});
 const input={schema:'zzsh.r07-capture-fact-input.v1',sourceReceipt:{path:path.join(src,'receipt.json'),sha256:receiptSha},
  datasetManifest:{path:path.join(datasetDir,'manifest.json'),sha256:datasetSha},actor:{path:actorPath,sha256:digest(fs.readFileSync(actorPath))},credentialsPath:path.join(reg,'credentials.json')};
 const inputPath=path.join(base,'input.json');writePrivate(inputPath,input);const inputSha=digest(fs.readFileSync(inputPath));
 await admin.query(`SET ROLE r08_loader_migration;CREATE SCHEMA zzsh_auth_admin;CREATE SCHEMA zzsh_supply;CREATE SCHEMA zzsh_iam;CREATE SCHEMA zzsh_business_meta;
  CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY);CREATE TABLE zzsh_supply.rental_account(id text PRIMARY KEY,game_id text);
  CREATE TABLE zzsh_supply.listing_version(id text,account_id text,PRIMARY KEY(id,account_id));
  CREATE TABLE zzsh_supply.legacy_listing_read_snapshot(account_id text PRIMARY KEY,legacy_id text,observation_version_id text,source_digest text,source_updated_at timestamptz);
  CREATE TABLE zzsh_supply.legacy_listing_display_snapshot(account_id text,schema_version int,observation_version_id text,base_source_digest text,source_updated_at timestamptz,display_digest text,snapshot jsonb,PRIMARY KEY(account_id,schema_version));
  CREATE TABLE zzsh_supply.idempotency_record(scope_key text,key text,request_fingerprint text,response_status int,response_body jsonb,publish_required boolean,PRIMARY KEY(scope_key,key));
  CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,object_id text,outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb);
  CREATE TABLE zzsh_business_meta.migrations(id serial PRIMARY KEY,hash text,created_at bigint);
  CREATE FUNCTION zzsh_supply.guard_release_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable';END$$;
  INSERT INTO zzsh_auth_admin."user" VALUES('synthetic-admin');GRANT USAGE ON SCHEMA zzsh_supply TO r08_loader_runtime;`);
 const migration=fs.readFileSync(path.join(root,'apps/api/migrations/business/0175_legacy_account_capture_facts.sql'));
 await admin.query(migration.toString());await configureLegacyCaptureFactPrivileges(admin,'r08_loader_runtime');
 for(const [file,time] of [['0174_business_schema_comments.sql','1793730640495'],['0175_legacy_account_capture_facts.sql','1793730640496']])
  await admin.query('INSERT INTO zzsh_business_meta.migrations(hash,created_at) VALUES($1,$2)',[digest(fs.readFileSync(path.join(root,'apps/api/migrations/business',file))),time]);
 for(const x of chosen){const account='fixture-account-'+x.sourceId,version='fixture-version-'+x.sourceId;
  await admin.query('INSERT INTO zzsh_supply.rental_account VALUES($1,$2)',[account,'fixture-game']);await admin.query('INSERT INTO zzsh_supply.listing_version VALUES($1,$2)',[version,account]);
  await admin.query('INSERT INTO zzsh_supply.legacy_listing_read_snapshot VALUES($1,$2,$3,$4,$5)',[account,x.sourceId,version,x.sourceDigest,timestamp]);
  await admin.query('INSERT INTO zzsh_supply.legacy_listing_display_snapshot VALUES($1,1,$2,$3,$4,$5,$6)',[account,version,x.sourceDigest,timestamp,'b'.repeat(64),'{}']);}
 await admin.end();
 const stubDir=path.join(root,'tmp',`r08-capture-loader-synth-20261108-0${attempt}`);assert(!fs.existsSync(stubDir));fs.mkdirSync(stubDir,{recursive:true});
 const stub=path.join(stubDir,'auth-stub.cjs');fs.writeFileSync(stub,`if(process.env.R08_CAPTURE_SYNTH_AUTH!=='1')throw Error('synthetic only');const a=require(${JSON.stringify(path.join(root,'apps/api/dist/src/auth/admin-authorization.js'))});const u=require(${JSON.stringify(path.join(root,'apps/api/dist/src/supply/supply-util.js'))});a.loadEffectiveAdminAccess=async()=>({isBoss:true,permissions:new Set(['supply.catalog.manage'])});a.requirePermission=()=>{};u.assertGameScope=async()=>{};`,{flag:'wx'});
 const cli=path.join(root,'scripts/migration/complete-r07-account-capture.mjs'),env={...process.env,NODE_OPTIONS:`--require="${stub.replaceAll('\\','/')}"`,R08_CAPTURE_SYNTH_AUTH:'1'};
 const invoke=(args,expect=0)=>{const p=exec(process.execPath,[cli,...args],{cwd:root,env});if(p.status!==expect)throw Error(`synthetic loader unexpected exit ${p.status}: ${p.stderr} ${p.stdout}`);return p;};
 const prepareDir=path.join(base,'prepare');invoke(['--prepare','--input',inputPath,'--input-sha',inputSha,'--out',prepareDir]);
 const planPath=path.join(prepareDir,'plan.json'),plan=JSON.parse(fs.readFileSync(planPath)),planSha=digest(fs.readFileSync(planPath));assert.equal(plan.facts.length,2);
 const now=Date.now(),authority={schema:'zzsh.r07-capture-fact-authority.v1',status:'APPROVED',operation:'APPEND_SOURCE_BOUND_ACCOUNT_CAPTURE',
  planSha256:planSha,target:plan.target,maxAccounts:2,allowFinancialWrites:false,approvalRef:'synthetic-review',attempt:'synthetic-attempt',
  notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+20*60000).toISOString()};
 const authPath=path.join(base,'authority.json');writePrivate(authPath,authority);const authSha=digest(fs.readFileSync(authPath));
 const executeArgs=out=>['--execute','--input',inputPath,'--input-sha',inputSha,'--plan',planPath,'--plan-sha',planSha,'--authority',authPath,'--authority-sha',authSha,'--out',out];
 fs.writeFileSync(path.join(src,'accounts.jsonl'),Buffer.concat([sourceBytes,Buffer.from('{}\n')]));
 const rejected=invoke(executeArgs(path.join(base,'tampered')),1);assert.match(rejected.stderr,/CAPTURE_SOURCE_FILE_CHANGED/);
 const check=new Client({host:'127.0.0.1',port:55434,user:'postgres',database:db});await check.connect();
 assert.equal((await check.query('SELECT count(*)::int AS n FROM zzsh_supply.legacy_listing_capture_fact')).rows[0].n,0);
 fs.writeFileSync(path.join(src,'accounts.jsonl'),sourceBytes);
 const executeDir=path.join(base,'execute');invoke(executeArgs(executeDir));const applyPath=path.join(executeDir,'receipt.json'),apply=JSON.parse(fs.readFileSync(applyPath));assert.equal(apply.status,'COMMIT_ACK_READBACK_REQUIRED');
 const readbackDir=path.join(base,'readback');invoke(['--readback','--input',inputPath,'--input-sha',inputSha,'--plan',planPath,'--plan-sha',planSha,'--apply-receipt',applyPath,'--apply-sha',digest(fs.readFileSync(applyPath)),'--out',readbackDir]);
 const readback=JSON.parse(fs.readFileSync(path.join(readbackDir,'readback.json')));assert.equal(readback.status,'CAPTURE_SOURCE_AND_TARGET_MATCHED');assert.equal(readback.counts.selected,2);
 const persisted=(await check.query('SELECT account_id,base_ratio_wan_per_yuan,full_payout_selected FROM zzsh_supply.legacy_listing_capture_fact ORDER BY account_id')).rows;
 assert.deepEqual(persisted,[{account_id:'fixture-account-101',base_ratio_wan_per_yuan:'56',full_payout_selected:false},
  {account_id:'fixture-account-102',base_ratio_wan_per_yuan:'43',full_payout_selected:true}]);
 assert.equal((await check.query("SELECT count(*)::int AS n FROM zzsh_supply.legacy_listing_display_snapshot WHERE display_digest=repeat('b',64)")).rows[0].n,2);
 // Deliberate synthetic corruption proves readback compares stored values, not just row count/digest.
 await check.query('SET ROLE r08_loader_migration');await check.query('ALTER TABLE zzsh_supply.legacy_listing_capture_fact DISABLE TRIGGER legacy_capture_immutable');
 await check.query("UPDATE zzsh_supply.legacy_listing_capture_fact SET base_ratio_wan_per_yuan='57' WHERE account_id='fixture-account-101'");
 await check.query('ALTER TABLE zzsh_supply.legacy_listing_capture_fact ENABLE TRIGGER legacy_capture_immutable');
 const corrupt=invoke(['--readback','--input',inputPath,'--input-sha',inputSha,'--plan',planPath,'--plan-sha',planSha,'--apply-receipt',applyPath,'--apply-sha',digest(fs.readFileSync(applyPath)),'--out',path.join(base,'corrupt-readback')],1);
 assert.match(corrupt.stdout,/CAPTURE_PRIOR_FACT_DIFFERS/);await check.end();
 fs.unlinkSync(stub);fs.rmdirSync(stubDir);
 console.log('SYNTHETIC_CAPTURE_LOADER_E2E_PASSED');
})().catch(e=>{console.error(e);process.exit(1)});
