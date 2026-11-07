import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';import {dirname,isAbsolute,join,relative,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {loadRegisteredTarget,targetConnection,maintenanceConnection,targetIdentityQuery,assertLiveTarget} from './local-target-registry.mjs';
import {assertCaptureRestoreBinding} from './complete-r07-account-capture.mjs';
const require=createRequire(import.meta.url),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'SCHEMA_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'SCHEMA_PRIVATE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'SCHEMA_LINK_REFUSED');return p;}
function pinned(ref){const p=privatePath(ref?.path),b=readFileSync(p);assert(hex(ref.sha256)&&sha(b)===ref.sha256,'SCHEMA_INPUT_CHANGED');return JSON.parse(b);}
function code(e){const first=String(e?.message??'').split(/\r?\n/,1)[0].trim();return /^[A-Z][A-Z0-9_]+$/.test(first)?first:e?.code??e?.name??'SCHEMA_FAILED';}
function targetBinding(t,ownerOid){return{instance:t.instance,database:t.database,oid:t.oid,nonce:t.nonce,marker:t.marker,owner:t.owner,ownerOid,migrationRole:t.migrationRole,migrationRoleOid:t.migrationRoleOid,runtimeRole:t.runtimeRole,runtimeRoleOid:t.runtimeRoleOid,lockKey:t.lockKey};}
export function assertSchemaAuthority(a,plan,planSha,now=Date.now()){
 const start=Date.parse(a?.notBefore),end=Date.parse(a?.expiresAt);assert(a?.schema==='zzsh.r07-capture-schema-authority.v1'&&a.status==='APPROVED'
  &&a.operation==='INSTALL_0174_0175_CAPTURE_SCHEMA'&&a.planSha256===planSha&&JSON.stringify(a.target)===JSON.stringify(plan.target)
  &&a.migrations===2&&a.allowFinancialWrites===false&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.attempt??'')
  &&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end>start&&end-start<=30*60_000,'SCHEMA_AUTHORITY_CHANGED');}
export function assertSchemaApplyReceipt(a,planSha,target){const ack=a?.status==='COMMIT_ACK_READBACK_REQUIRED'&&a.commitAck===true,unknown=a?.status==='COMMIT_UNKNOWN'&&a.commitAck===false;
 assert(a?.schema==='zzsh.r07-capture-schema-receipt.v1'&&(ack||unknown)&&a.commitSent===true&&a.planSha256===planSha&&JSON.stringify(a.target)===JSON.stringify(target)
  &&a.unlockAck===true&&a.connectionsClosed===true&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.attempt??'')
  &&Number.isFinite(Date.parse(a.notBefore))&&Number.isFinite(Date.parse(a.expiresAt))&&Date.parse(a.expiresAt)>Date.parse(a.notBefore)
  &&Date.parse(a.expiresAt)-Date.parse(a.notBefore)<=30*60_000,'SCHEMA_APPLY_UNCONFIRMED');}
function toolProof(){const files=['scripts/migration/install-r07-capture-schema.mjs','scripts/migration/complete-r07-account-capture.mjs','scripts/migration/local-target-registry.mjs',
 'scripts/migration/local-load-checkpoint.mjs','scripts/local-auth.mjs','apps/api/migrations/business/0174_business_schema_comments.sql',
 'apps/api/migrations/business/0175_legacy_account_capture_facts.sql','apps/api/migrations/business/meta/_journal.json','package-lock.json','node_modules/.package-lock.json'];
 for(const p of Object.keys(require.cache)){assert(p.toLowerCase().startsWith(root.toLowerCase()+'\\')||p.startsWith(root+'/'),'SCHEMA_DEPENDENCY_OUTSIDE_BUILD');files.push(relative(root,p));
  if(p.toLowerCase().includes('node_modules')){let d=dirname(p);while(d.toLowerCase().startsWith(root.toLowerCase())){const f=join(d,'package.json');if(existsSync(f)){files.push(relative(root,f));break;}const next=dirname(d);if(next===d)break;d=next;}}}
 return Object.fromEntries([...new Set(files)].sort().map(p=>[p.replaceAll('\\','/'),sha(readFileSync(join(root,p)))]));}
async function oldObjectProof(c,canonicalize){const snapshot={schemas:(await c.query("SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl::text acl FROM pg_namespace WHERE nspname LIKE 'zzsh_%' ORDER BY 1")).rows,
 relations:(await c.query("SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'zzsh_%' AND (n.nspname<>'zzsh_supply' OR c.relname<>'legacy_listing_capture_fact') AND c.relkind IN ('r','p','S','v','m','f') ORDER BY 1,2,3")).rows,
 columns:(await c.query("SELECT n.nspname,c.relname,a.attname,a.attacl::text acl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'zzsh_%' AND (n.nspname<>'zzsh_supply' OR c.relname<>'legacy_listing_capture_fact') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL ORDER BY 1,2,3")).rows,
 functions:(await c.query("SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,p.prosecdef,pg_get_functiondef(p.oid) def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'zzsh_%' AND (n.nspname<>'zzsh_supply' OR p.proname<>'guard_legacy_listing_capture_fact') AND p.prokind IN ('f','p') ORDER BY 1,2,3")).rows,
 defaults:(await c.query("SELECT pg_get_userbyid(d.defaclrole) role,n.nspname,d.defaclobjtype,d.defaclacl::text acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY 1,2,3")).rows,
 policies:(await c.query("SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid) qual,pg_get_expr(p.polwithcheck,p.polrelid) check_expr FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'zzsh_%' ORDER BY 1,2,3")).rows};
 return{sha256:sha(canonicalize(snapshot)),objects:snapshot.relations.length+snapshot.functions.length};}
function expectedComments(){const sql=readFileSync(join(root,'apps/api/migrations/business/0174_business_schema_comments.sql'),'utf8');
 const all=sql.match(/^COMMENT ON /gm)??[],found=[...sql.matchAll(/^COMMENT ON (TABLE|COLUMN) ([a-z0-9_]+)\.([a-z0-9_]+)(?:\.([a-z0-9_]+))? IS '((?:[^']|'')*)';\s*$/gm)];
 assert(all.length===205&&found.length===all.length,'SCHEMA_COMMENT_SOURCE_CHANGED');return found.map(m=>({kind:m[1],schema:m[2],table:m[3],column:m[4]??null,comment:m[5].replaceAll("''","'")}));}
async function inspectSchema(c,target,comments){const q=(await c.query(`WITH wanted AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,schema text,"table" text,"column" text,comment text))
 SELECT count(*)::int total,count(*) FILTER(WHERE CASE WHEN w.kind='TABLE' THEN obj_description(r.oid,'pg_class') ELSE col_description(r.oid,a.attnum) END IS NOT DISTINCT FROM w.comment)::int matched
 FROM wanted w LEFT JOIN pg_namespace n ON n.nspname=w.schema LEFT JOIN pg_class r ON r.relnamespace=n.oid AND r.relname=w."table"
 LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname=w."column" AND a.attnum>0 AND NOT a.attisdropped`,[JSON.stringify(comments)])).rows[0];
 const s=(await c.query(`SELECT to_regclass('zzsh_supply.legacy_listing_capture_fact') IS NOT NULL AS ready,
  (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgname IN ('legacy_capture_insert','legacy_capture_immutable')) guards,
  (SELECT count(*)::int FROM pg_constraint WHERE conrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND convalidated AND conname IN ('legacy_capture_ratio_check','legacy_capture_payout_check','legacy_capture_observation_fk')) constraints,
  has_table_privilege($1,'zzsh_supply.legacy_listing_capture_fact','SELECT') runtime_read,
  has_table_privilege($1,'zzsh_supply.legacy_listing_capture_fact','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') runtime_write,
  has_any_column_privilege($1,'zzsh_supply.legacy_listing_capture_fact','INSERT,UPDATE,REFERENCES') runtime_column_write,
  has_function_privilege($1,'zzsh_supply.guard_legacy_listing_capture_fact()','EXECUTE') runtime_function,
  EXISTS(SELECT 1 FROM pg_class r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) x WHERE r.oid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND x.grantee=0) public_table,
  EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND x.grantee=0) public_column,
  EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid=to_regprocedure('zzsh_supply.guard_legacy_listing_capture_fact()') AND x.grantee=0) public_function,
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_supply.legacy_listing_capture_fact')) owner,
  obj_description(to_regclass('zzsh_supply.legacy_listing_capture_fact'),'pg_class') IS NOT NULL table_comment,
  (SELECT count(*)::int FROM pg_attribute WHERE attrelid=to_regclass('zzsh_supply.legacy_listing_capture_fact') AND attnum>0 AND NOT attisdropped AND col_description(attrelid,attnum) IS NOT NULL) comments`,[target.runtimeRole])).rows[0];
 assert(q.total===205&&q.matched===205&&s.ready===true&&s.guards===2&&s.constraints===3&&s.runtime_read===true&&!s.runtime_write&&!s.runtime_column_write
  &&!s.runtime_function&&!s.public_table&&!s.public_column&&!s.public_function&&s.owner===target.migrationRole&&s.table_comment&&s.comments===13,'SCHEMA_CONTRACT_MISMATCH');
 assert.equal((await c.query('SELECT count(*)::int n FROM zzsh_supply.legacy_listing_capture_fact')).rows[0].n,0,'SCHEMA_CAPTURE_PREIMAGE_CHANGED');return{comments:q.matched,guards:s.guards,constraints:s.constraints,runtimeReadOnly:true};}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];},modes=['--prepare','--execute','--readback'].filter(x=>args.includes(x));
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'SCHEMA_MODE_INVALID');assert.equal(process.version,'v24.20.0','SCHEMA_NODE_CHANGED');
 const mode=modes[0],out=privatePath(option('--out'),true);assert(!existsSync(out),'SCHEMA_OUTPUT_EXISTS');
 const inputRef={path:privatePath(option('--input')),sha256:option('--input-sha')},input=pinned(inputRef);assert(input.schema==='zzsh.r07-capture-schema-input.v1','SCHEMA_INPUT_INVALID');
 const restore=pinned(input.restoreReceipt),counts=pinned(input.countsReadback),credentialsPath=privatePath(input.credentialsPath),credentialsBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialsBytes);
 const resourcePath=privatePath(join(dirname(credentialsPath),'resource.json')),resourceSha=sha(readFileSync(resourcePath)),credentialSha=sha(credentialsBytes),target=loadRegisteredTarget(credentialsPath),binding=targetBinding(target,restore.target?.owner?.oid);
 assert(target.database==='zzsh_test_r07_delivery_20261108'&&target.marker==='zzsh:r07-delivery-clone:v1'&&target.host==='127.0.0.1'&&target.port===55434
  &&target.instance?.systemIdentifier!=='7704972584346443810'&&target.owner==='zzsh'&&target.migrationRole==='zzsh_regression_migration'&&target.runtimeRole==='zzsh_regression_runtime'
  &&credentials.migration?.name===target.migrationRole&&credentials.migration?.oid===target.migrationRoleOid&&!target.pendingReset,'SCHEMA_TARGET_REQUIRED');
 assertCaptureRestoreBinding(restore,target);
 assert(counts.schema==='zzsh.r07-clone-invitation-counts-readback.v1'&&counts.status==='INVITATION_COUNTS_CLOSED_AND_VERIFIED'
  &&counts.target?.instance?.systemIdentifier===target.instance.systemIdentifier&&counts.target.oid===target.oid&&counts.target.nonce===target.nonce
  &&counts.target.marker===target.marker&&counts.packets>0&&counts.known===counts.subjects&&counts.unknown===0&&counts.financialWrites===0
  &&counts.rollbackAck===true&&counts.unlockAck===true&&counts.connectionsClosed===true,'SCHEMA_COUNTS_PROOF_REQUIRED');
 const {Client}=require('pg'),{readMigrationFiles}=require('drizzle-orm/migrator'),{assertBusinessMigrationPrefix,configureLegacyCaptureFactPrivileges,BUSINESS_MIGRATION_CONFIG}=require(join(root,'apps/api/dist/src/database/business-migrations.js')),
  {canonicalize}=require(join(root,'apps/api/dist/src/supply/content-hash.js')),comments=expectedComments();
 const files=readMigrationFiles(BUSINESS_MIGRATION_CONFIG),pending=files.filter(x=>x.folderMillis>1793730640494);
 assert.deepEqual(pending.map(x=>x.folderMillis),[1793730640495,1793730640496],'SCHEMA_MIGRATION_TAIL_CHANGED');
 const migrationProof=pending.map((x,i)=>({when:String(x.folderMillis),sha256:x.hash,file:i?'0175_legacy_account_capture_facts.sql':'0174_business_schema_comments.sql'}));
 for(const p of migrationProof)assert.equal(p.sha256,sha(readFileSync(join(root,'apps/api/migrations/business',p.file))),'SCHEMA_MIGRATION_BYTES_CHANGED');
 const planRef=mode==='--prepare'?null:{path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=planRef?pinned(planRef):null;
 const authorityRef=mode==='--execute'?{path:option('--authority'),sha256:option('--authority-sha')}:null,authority=authorityRef?pinned(authorityRef):null;
 const appliedRef=mode==='--readback'?{path:option('--apply-receipt'),sha256:option('--apply-sha')}:null,applied=appliedRef?pinned(appliedRef):null;
 if(applied)assertSchemaApplyReceipt(applied,planRef.sha256,binding);
 const lock=new Client(maintenanceConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-schema-lock'}));
 const c=new Client(targetConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-capture-schema',statement_timeout:30000,lock_timeout:1000}));
 let held=false,lockOpen=false,clientOpen=false,begun=false,commitSent=false,commitAck=false,rollbackAck=false,unlockAck=false,closed=false;
 let result={schema:'zzsh.r07-capture-schema-receipt.v1',status:'STARTED',mode,target:binding,startedAt:new Date().toISOString(),financialWrites:0};
 if(mode==='--execute')writePrivate(join(out,'receipt.json'),result);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
 try{
  await lock.connect();lockOpen=true;held=(await lock.query('SELECT pg_try_advisory_lock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;assert(held,'SCHEMA_LOCK_BUSY');
  await c.connect();clientOpen=true;await c.query(mode==='--execute'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const identity=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,identity,'migration');assert.equal(String(identity.owner_oid),binding.ownerOid,'SCHEMA_OWNER_CHANGED');
  await assertBusinessMigrationPrefix(c);const proof=toolProof(),verifyFiles=()=>{pinned(inputRef);pinned(input.restoreReceipt);pinned(input.countsReadback);if(planRef)pinned(planRef);if(authorityRef)pinned(authorityRef);if(appliedRef)pinned(appliedRef);
   assert(sha(readFileSync(credentialsPath))===credentialSha&&sha(readFileSync(resourcePath))===resourceSha,'SCHEMA_RESOURCE_CHANGED');assert.deepEqual(toolProof(),proof,'SCHEMA_TOOL_CHANGED');};
  const journal=(await c.query('SELECT hash,created_at::text at FROM zzsh_business_meta.migrations ORDER BY id')).rows,prior=mode==='--readback'?journal.slice(0,-2):journal;
  assert(prior.length>0&&prior.at(-1).at==='1793730640494','SCHEMA_PREIMAGE_JOURNAL_CHANGED');
  if(mode==='--readback')assert(journal.length===prior.length+2&&pending.every((x,i)=>journal[prior.length+i]?.hash===x.hash&&journal[prior.length+i]?.at===String(x.folderMillis)),'SCHEMA_JOURNAL_READBACK_CHANGED');
  else assert.equal((await c.query("SELECT to_regclass('zzsh_supply.legacy_listing_capture_fact') IS NULL AND to_regprocedure('zzsh_supply.guard_legacy_listing_capture_fact()') IS NULL ok")).rows[0].ok,true,'SCHEMA_CAPTURE_OBJECT_EXISTS');
  const coverage=(await c.query("SELECT count(*)::int total,count(*) FILTER(WHERE invitees_knowledge='KNOWN')::int known,count(*) FILTER(WHERE invitees_knowledge='UNKNOWN')::int unknown FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL'")).rows[0];
  assert(coverage.total===counts.subjects&&coverage.known===counts.known&&coverage.unknown===0,'SCHEMA_COUNTS_STATE_CHANGED');
  const names=[...new Set(comments.map(x=>x.schema+'.'+x.table))],owners=(await c.query("SELECT n.nspname||'.'||r.relname name,pg_get_userbyid(r.relowner) owner FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname||'.'||r.relname=ANY($1::text[])",[names])).rows;
  const privileges=(await c.query("SELECT has_schema_privilege(current_user,'zzsh_supply','CREATE') schema_create,has_table_privilege(current_user,'zzsh_business_meta.migrations','INSERT') journal_insert")).rows[0];
  assert(owners.length===names.length&&owners.every(x=>x.owner===target.migrationRole)&&privileges.schema_create&&privileges.journal_insert,'SCHEMA_MIGRATION_OWNER_CHANGED');
  const objectProof=await oldObjectProof(c,canonicalize),expected={schema:'zzsh.r07-capture-schema-plan.v1',status:'PREPARED_READ_ONLY',inputSha256:inputRef.sha256,target:binding,
   credentialSha,resourceSha,toolFiles:proof,restoreSha256:input.restoreReceipt.sha256,countsReadbackSha256:input.countsReadback.sha256,
   priorJournalSha256:sha(canonicalize(prior)),priorJournalRows:prior.length,oldObjectProof:objectProof,migrations:migrationProof,coverage,commentTargetTables:names.length};
  if(plan)assert(plan.schema===expected.schema&&plan.status===expected.status&&plan.rollbackAck===true&&plan.unlockAck===true&&plan.connectionsClosed===true
   &&plan.inputSha256===expected.inputSha256&&canonicalize(plan.target)===canonicalize(expected.target)&&plan.credentialSha===credentialSha&&plan.resourceSha===resourceSha
   &&canonicalize(plan.toolFiles)===canonicalize(proof)&&plan.priorJournalSha256===expected.priorJournalSha256&&canonicalize(plan.oldObjectProof)===canonicalize(objectProof)
   &&canonicalize(plan.migrations)===canonicalize(migrationProof),'SCHEMA_PLAN_CHANGED');
  if(mode==='--prepare')result=expected;
  else if(mode==='--execute'){
   assertSchemaAuthority(authority,plan,planRef.sha256);Object.assign(result,{planSha256:planRef.sha256,approvalRef:authority.approvalRef,attempt:authority.attempt,notBefore:authority.notBefore,expiresAt:authority.expiresAt,status:'TRANSACTION_INTENT'});save();
   for(const m of pending){for(const sql of m.sql)await c.query(sql);await c.query('INSERT INTO zzsh_business_meta.migrations(hash,created_at) VALUES($1,$2)',[m.hash,m.folderMillis]);}
   await configureLegacyCaptureFactPrivileges(c,target.runtimeRole);await assertBusinessMigrationPrefix(c);assert.deepEqual(await oldObjectProof(c,canonicalize),plan.oldObjectProof,'SCHEMA_EXISTING_ACL_CHANGED');
   result.contract=await inspectSchema(c,target,comments);verifyFiles();assertSchemaAuthority(authority,plan,planRef.sha256);const final=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,final,'migration');assert.equal(String(final.owner_oid),binding.ownerOid,'SCHEMA_OWNER_CHANGED');
   result.status='COMMIT_REQUESTED';result.commitSent=true;save();commitSent=true;assert.equal((await c.query('COMMIT')).command,'COMMIT');begun=false;commitAck=true;result.status='COMMIT_ACK_READBACK_REQUIRED';result.commitAck=true;save();
  }else{result={schema:'zzsh.r07-capture-schema-readback.v1',status:'SCHEMA_INSTALLED_AND_VERIFIED',target:binding,planSha256:planRef.sha256,
   commitOutcome:applied.commitAck?'ACKNOWLEDGED':'CONFIRMED_BY_JOURNAL_AND_SCHEMA',contract:await inspectSchema(c,target,comments),financialWrites:0};}
  if(begun){verifyFiles();assert.equal((await c.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;}
 }catch(e){result.status=mode==='--readback'&&applied?.status==='COMMIT_UNKNOWN'?'COMMIT_UNKNOWN_UNRESOLVED':commitSent&&!commitAck?'COMMIT_UNKNOWN':commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';result.error=code(e);if(commitSent)result.commitAck=commitAck;
  if(begun&&!commitSent){try{rollbackAck=(await c.query('ROLLBACK')).command==='ROLLBACK';begun=false;}catch{rollbackAck=false;}}result.rollbackAck=rollbackAck;process.exitCode=1;
 }finally{if(begun&&!commitSent)try{await c.query('ROLLBACK');}catch{}let cClosed=!clientOpen,lClosed=!lockOpen;try{if(clientOpen){await c.end();cClosed=true;}}catch{}
  try{if(held)unlockAck=(await lock.query('SELECT pg_advisory_unlock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;}catch{}try{if(lockOpen){await lock.end();lClosed=true;}}catch{}closed=cClosed&&lClosed;
  Object.assign(result,{unlockAck,connectionsClosed:closed,finishedAt:new Date().toISOString()});}
 if(mode==='--execute')save();else if(rollbackAck&&unlockAck&&closed){result.rollbackAck=true;const file=join(out,mode==='--prepare'?'plan.json':'readback.json');writePrivate(file,result);
  console.log(JSON.stringify({status:result.status,error:result.error,sha256:sha(readFileSync(file)),oldObjectProof:result.oldObjectProof,contract:result.contract,financialWrites:0}));return;}
 console.log(JSON.stringify({status:result.status,error:result.error,commitAck,rollbackAck,unlockAck,connectionsClosed:closed,financialWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(e=>{console.error(JSON.stringify({status:'SCHEMA_STOPPED',code:code(e)}));process.exitCode=1;});
