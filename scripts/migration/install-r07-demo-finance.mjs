// Local R07 demo copy only. Preparation/readback are read-only; execution is one bounded transaction.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,openSync,closeSync,writeFileSync,fsyncSync,readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';
import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {advisoryLockSql,assertLiveTarget,loadRegisteredTarget,maintenanceConnection,targetConnection,targetIdentityQuery} from './local-target-registry.mjs';
import {isolatedDistributionBuild} from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),privateRoot=resolve('E:/zzsh-local-state/restricted');
const hash=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const FIXED={database:'zzsh_test_r07_delivery_20261108',oid:'16391',marker:'zzsh:r07-delivery-clone:v1',systemIdentifier:'7705473419326033954',
 owner:'zzsh',ownerOid:'16388',migration:'zzsh_regression_migration',migrationOid:'16389',runtime:'zzsh_regression_runtime',runtimeOid:'16390',lockKey:'806007'};
const BASELINE='d99d63862d968f5b90aa0a9b044f65c61e0af6319a1fdb9eb9a41b3dcb2f2730';
const INSTALLED_GUARDS=Object.freeze({
 'zzsh_order.ecs_test_demo_finance_matches(text)':'a297b7b8abf8159d9790b4c80fb6ba981196b2a23aa8864280c8a52117b676f4',
 'zzsh_order.guard_ecs_demo_order_admission()':'e86ced76df89baa3abbb39a25917735a7a74f0c31af0ea9944d95ea27de318aa',
 'zzsh_order.guard_ecs_demo_payment_confirmation()':'5c78e4bf973709a02c06329833dd890fe46cb6b4c336c73d4ad54e8cac09471f',
 'zzsh_order.guard_ecs_demo_payment_declaration()':'a1885b48516b50bbe5b72a0cb9f38d28a6b8c71328e72dbb1653f9dd7a5fdf5e',
 'zzsh_order.guard_ecs_test_demo_finance_registration()':'9a79cd90b7b0897db16702b831fc4cd2861ec88736113255272bc6d60dd891b5',
 'zzsh_order.local_controlled_refund_liability_complete(text)':'5258a935ea192497c8a6197df2c00a968bc435968281d631d3112bea174084b3',
 'zzsh_order.local_controlled_refund_terminal_complete(text)':'98d04031fa22a15efc943ece3b605f0827bee313d32047ed0a5d900d5981569e',
 'zzsh_order.support_cancel_payment_basis_valid(jsonb)':'a1cc472b56eb0b2f2f1007b47ce64134c0c23884f7abe69c3118dfbc449e2c28',
 'zzsh_order.withdrawal_expected_lines(text)':'1daf74b74ff768ab23ab949a814dd46168297fbe1ca4caf1c73fdcdd4f3ea50f',
});
const SQL=Object.freeze({
 'registration.sql':'00e59868b77e0799896a486d294800b1f83fd7f76fc95668ab0e3563d9da0ddf',
 'controlled-payment-schema.sql':'d7ad439ba08042b58916d364cfe5fc42968ed92fb5cc1e70c71fed623dea20ee',
 'new-order-payment.sql':'89bafeb87854eff17e3e6719c8cdc39a46c66b07eff2e3e82aaa9ce2211b5cb6',
 'demo-refund.sql':'cedc9d3231e138c2bd00c42b4883bbc48502a2124c840c2c722a1024e94077ca',
 'demo-withdrawal.sql':'5642e0214588cb557b208c95d233d78ed98fcd534fbd5e9cb0823701585665fc',
 'demo-legacy-refund.sql':'3836722e40fef968b31c077df4cb4fab96c90deef2fb85d6e7292a92d80ff6a2',
 'demo-prestart-refund.sql':'eb10804efee5b155205acceef405de36d02ad42284ecb37efd711fca0ae29891',
 'demo-support-cancel.sql':'559b94e541b7b023906360c7f4369cbcde0c4182de9801ca1cf883c5f8669b5a',
 'grant-runtime.sql':'e8a58e3d4cfbc122a5dc3be5615d91d48f156758316e557828e0374ee700707c',
 'enroll-native-wallet.sql':'14f77bf3c5f5d9a51b9c268106beb4a064a316ed030f244e10021db2e1f1c47c',
});
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'DEMO_INSTALL_PRIVATE_PATH_REQUIRED');const p=resolve(value),rel=relative(privateRoot,p);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'DEMO_INSTALL_PRIVATE_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'DEMO_INSTALL_LINK_REFUSED');return p;
}
function pinned(ref){const p=privatePath(ref?.path),bytes=readFileSync(p);assert(hex(ref.sha256)&&hash(bytes)===ref.sha256,'DEMO_INSTALL_PIN_CHANGED');
 let value;try{value=JSON.parse(bytes);}catch{throw Error('DEMO_INSTALL_JSON_INVALID');}return {value,bytes,sha256:ref.sha256};}
function files(dir){const out={};function visit(base,prefix=''){for(const e of readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 assert(!e.isSymbolicLink(),'DEMO_INSTALL_BUILD_LINK_REFUSED');const path=join(base,e.name),name=prefix+e.name;
 if(e.isDirectory())visit(path,name+'/');else if(e.isFile()&&name.endsWith('.js'))out[name]=hash(readFileSync(path));
 }}visit(dir);return out;}
function canonical(x){return JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);}
function same(a,b){return canonical(a)===canonical(b);}
function binding(t,ownerOid){return {host:t.host,port:t.port,database:t.database,oid:t.oid,marker:t.marker,nonce:t.nonce,
 systemIdentifier:t.instance?.systemIdentifier,owner:t.owner,ownerOid,migrationRole:t.migrationRole,migrationRoleOid:t.migrationRoleOid,
 runtimeRole:t.runtimeRole,runtimeRoleOid:t.runtimeRoleOid,lockKey:t.lockKey};}

/** No CLI option overrides the concrete registered 55434 resource. */
export function validateLocalDemoTarget(t,credentials,restore,seal){
 assert(t.host==='127.0.0.1'&&t.port===55434&&t.database===FIXED.database&&t.oid===FIXED.oid&&t.marker===FIXED.marker
  &&t.instance?.systemIdentifier===FIXED.systemIdentifier&&t.owner===FIXED.owner&&t.migrationRole===FIXED.migration
  &&t.migrationRoleOid===FIXED.migrationOid&&t.runtimeRole===FIXED.runtime&&t.runtimeRoleOid===FIXED.runtimeOid&&t.lockKey===FIXED.lockKey&&!t.pendingReset
  &&credentials?.migration?.name===t.migrationRole&&credentials.migration.oid===t.migrationRoleOid
  &&credentials?.runtime?.name===t.runtimeRole&&credentials.runtime.oid===t.runtimeRoleOid,'DEMO_INSTALL_TARGET_CHANGED');
 assert(restore?.schema==='zzsh.r07-demo-clone-restored.v1'&&restore.status==='RESTORED_AND_VERIFIED'
  &&restore.target?.host===t.host&&restore.target.port===t.port&&restore.target.database===t.database&&restore.target.oid===t.oid
  &&restore.target.systemIdentifier===t.instance.systemIdentifier&&restore.target.marker===t.marker&&restore.target.nonce===t.nonce
  &&restore.target.owner?.name===t.owner&&restore.target.owner.oid===FIXED.ownerOid&&restore.target.migration?.name===t.migrationRole
  &&restore.target.migration.oid===t.migrationRoleOid&&restore.target.runtime?.name===t.runtimeRole&&restore.target.runtime.oid===t.runtimeRoleOid
  &&['sameExportedSnapshot','dataSummaryMatched','keySetsMatched','objectAclMatched','roleSecurityMatchedWithDeclaredExceptions','rlsAndDefinerMatched','runtimeAccessTested'].every(k=>restore.verification?.[k]===true)
  &&restore.verification?.sourceWrites===0,'DEMO_INSTALL_RESTORE_PROOF_INVALID');
 assert(seal?.schema==='zzsh.r07-delivery-clean-export.v1'&&seal.status==='CLEAN_EXPORT_COMPLETE_WITH_KNOWN_LIMITATIONS'&&seal.sourceWrites===0
  &&seal.rollbackAck===true&&seal.connectionClosed===true&&seal.snapshot?.preflightStateMatched===true&&seal.snapshot.mockTablesPresent===0
  &&seal.source?.database===t.database&&seal.source.oid===t.oid&&seal.source.systemIdentifier===t.instance.systemIdentifier
  &&seal.source.marker===t.marker&&seal.source.owner===t.owner&&String(seal.source.ownerOid)===FIXED.ownerOid
  &&seal.source.migrationRole===t.migrationRole&&String(seal.source.migrationRoleOid)===t.migrationRoleOid
  &&seal.source.runtimeRole===t.runtimeRole&&String(seal.source.runtimeRoleOid)===t.runtimeRoleOid
  &&seal.dump?.sha256==='6300b631507364517b43ec73bc88b87be514661700ce4266d21397c86148f75f'
  &&seal.acl?.sha256==='670c242af9927f671614bb80917b5f5033ea3a7e2fc0fbf6b00553d330523c17','DEMO_INSTALL_SEAL_PROOF_INVALID');
 return binding(t,FIXED.ownerOid);
}
export function validateLocalDemoProofs(target,sealRef,cloneRestore,boss,cloneRestoreSha){
 assert(cloneRestore?.schema==='zzsh.r07-clean-clone-restore-verification.v1'&&cloneRestore.status==='CLEAN_CLONE_RESTORE_VERIFIED'
  &&cloneRestore.sourceExportReceiptSha256===sealRef.sha256
  &&cloneRestore.sourceArchiveSha256==='6300b631507364517b43ec73bc88b87be514661700ce4266d21397c86148f75f'
  &&cloneRestore.source?.database===target.database&&cloneRestore.source.oid===target.oid
  &&cloneRestore.source.systemIdentifier===target.systemIdentifier&&cloneRestore.source.marker===target.marker
  &&cloneRestore.aclMatched===true&&cloneRestore.criticalRowsMatched===true&&cloneRestore.readOnlyRollbackAck===true&&cloneRestore.sourceWrites===0
  &&/^[0-9]+$/.test(cloneRestore.isolatedRestore?.systemIdentifier??'')&&cloneRestore.isolatedRestore.systemIdentifier!==target.systemIdentifier,
 'DEMO_INSTALL_CLONE_RESTORE_PROOF_INVALID');
 assert(boss?.schema==='zzsh.r07-local-demo-boss.v1'&&boss.status==='ACTIVE_AND_VERIFIED'
  &&/^admin_[a-f0-9]{32}$/.test(boss.administratorId??'')&&boss.exportReceiptSha256===sealRef.sha256&&boss.cloneRestoreVerificationSha256===cloneRestoreSha
  &&boss.target?.host===target.host&&boss.target.port===target.port&&boss.target.database===target.database&&boss.target.oid===target.oid
  &&boss.target.systemIdentifier===target.systemIdentifier&&boss.target.marker===target.marker&&boss.target.nonce===target.nonce
  &&boss.target.runtimeRole===target.runtimeRole&&boss.target.runtimeRoleOid===target.runtimeRoleOid
  &&['auditVerified','enrollmentVerified','readbackRollbackAck','unlockAck','connectionsClosed','existingIdentityPreserved','userAccountsUnchanged','financialFactsUnchanged','businessFactsUnchanged'].every(k=>boss[k]===true)
  &&boss.financialWrites===0&&boss.providerCalls===0,'DEMO_INSTALL_BOSS_PROOF_INVALID');
 return boss.administratorId;
}
export function validateLocalDemoAuthority(a,planSha,target,registrationDigest,now=Date.now()){
 const start=Date.parse(a?.notBefore),end=Date.parse(a?.expiresAt),iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
 assert(a?.schema==='zzsh.r07-demo-finance-install-authority.v1'&&a.status==='APPROVED'&&a.operation==='INSTALL_LOCAL_DEMO_FINANCE'
  &&a.planSha256===planSha&&same(a.target,target)&&a.registrationDigest===registrationDigest&&a.providerCalls===false
  &&/^[A-Za-z0-9._:-]{1,128}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,128}$/.test(a.attempt??'')
  &&iso.test(a.notBefore??'')&&iso.test(a.expiresAt??'')&&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end
  &&end>start&&end-start<=30*60_000,'DEMO_INSTALL_AUTHORITY_INVALID');
}
export function validateLocalDemoEnvironment(env,target,reference,administratorId,restoreRef,apiWorkingDirectory){
 assert(env.APP_PROFILE==='dev'&&env.NODE_ENV==='development'&&env.PROVIDER_MODE==='fake'&&env.LOCAL_DEMO_CLONE_FINANCE_ENABLED==='true'
  &&env.ECS_TEST_DEMO_FINANCE_ENABLED!=='true'&&env.ENABLE_TEST_OPERATIONS!=='true'
  &&['JOINPAY_COLLECTION_ENABLED','JOINPAY_REFUND_ENABLED','JOINPAY_PAYOUT_ENABLED','JOINPAY_ACCOUNTS_ENABLED'].every(k=>env[k]==='false')
  &&env.HOST==='127.0.0.1'&&env.PORT==='4232'&&env.DB_TARGET==='local-compose'&&env.DB_HOST===target.host&&env.DB_PORT===String(target.port)
  &&env.DB_NAME===target.database&&env.DB_USER===target.runtimeRole&&(!env.DB_TLS_MODE||env.DB_TLS_MODE==='disable')
  &&env.AUTH_API_ORIGIN==='http://127.0.0.1:4232'&&env.AUTH_USER_ORIGIN==='http://127.0.0.1:4230'
  &&env.AUTH_ADMIN_ORIGIN==='http://127.0.0.1:4231'&&env.AUTH_SECURE_COOKIES!=='true'
  &&env.LOCAL_DEMO_FINANCE_REFERENCE===reference&&env.LOCAL_DEMO_FINANCE_ADMIN_ID===administratorId
  &&env.LOCAL_DEMO_CLONE_RECEIPT_SHA256===restoreRef.sha256&&typeof env.LOCAL_DEMO_CLONE_RECEIPT_FILE==='string'
  &&resolve(apiWorkingDirectory,env.LOCAL_DEMO_CLONE_RECEIPT_FILE)===resolve(restoreRef.path)
  &&env.YUNXIN_ENABLED==='true'&&/^[^\s\x00-\x1f]{1,128}$/.test(env.YUNXIN_APP_KEY??''),'DEMO_INSTALL_ENVIRONMENT_INVALID');
 return {appKeySha256:hash(env.YUNXIN_APP_KEY),apiOrigin:env.AUTH_API_ORIGIN,userOrigin:env.AUTH_USER_ORIGIN,adminOrigin:env.AUTH_ADMIN_ORIGIN};
}
export function validateInstallClaim(claim,applied,planSha,target,registrationDigest){
 assert(claim?.schema==='zzsh.r07-demo-finance-install-claim.v1'&&claim.planSha256===planSha&&same(claim.target,target)
  &&claim.registrationDigest===registrationDigest&&claim.attempt===applied.attempt&&claim.approvalRef===applied.approvalRef,
 'DEMO_INSTALL_ORIGINAL_CLAIM_MISMATCH');
}

function sqlFiles(){const dir=join(root,'apps/api/migrations/candidates/ecs-test-demo-finance'),values={};
 for(const [name,expected] of Object.entries(SQL)){const path=join(dir,name);assert(!lstatSync(path).isSymbolicLink(),'DEMO_INSTALL_SQL_LINK_REFUSED');const bytes=readFileSync(path);
  assert.equal(hash(bytes),expected,'DEMO_INSTALL_SQL_CHANGED:'+name);values[name]=bytes.toString('utf8');}return values;}
function buildFiles(dir){const f=files(dir);assert(Object.keys(f).length>0&&f['finance/ecs-test-demo-resource.js']&&f['finance/ecs-test-demo-runtime.js'],'DEMO_INSTALL_BUILD_INVALID');return f;}
function checkedBuild(value){const api=isolatedDistributionBuild(root,value);for(let p=api;p!==dirname(p);p=dirname(p))assert(!lstatSync(p).isSymbolicLink(),'DEMO_INSTALL_BUILD_LINK_REFUSED');return api;}
function inputFiles(input,inputRef){return [inputRef,input.restoreReceipt,input.sealReceipt,input.cloneRestoreReceipt,input.bossReceipt];}
function fingerprint(){const names=['scripts/migration/install-r07-demo-finance.mjs','scripts/migration/local-target-registry.mjs',
 'scripts/migration/local-distribution-qualification-plan.mjs','scripts/migration/local-load-checkpoint.mjs','scripts/local-auth.mjs','package-lock.json','node_modules/.package-lock.json'];
 return Object.fromEntries(names.map(name=>[name,hash(readFileSync(join(root,name)))]));}
function loadedProof(require){return Object.fromEntries(Object.keys(require.cache).sort().map(path=>{const rel=relative(root,path);
 assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'DEMO_INSTALL_DEPENDENCY_OUTSIDE_BUILD');return [rel.replaceAll('\\','/'),hash(readFileSync(path))];}));}
const isErrorCode=e=>/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:(e?.code??e?.name??'DEMO_INSTALL_FAILED');

/** Actual target preimage: existing source data is not scanned or printed. */
export async function readDemoInstallPreimage(c,bossId){
 const row=(await c.query(`SELECT
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.pid<>pg_backend_pid()) AS other_connections,
  current_setting('server_version_num')::int/10000 AS server_major,
  (SELECT count(*)::int FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id
    WHERE u.id=$1 AND NOT u.suspended AND u."twoFactorEnabled" AND a.is_boss AND a.status='ACTIVE') AS boss,
  (SELECT count(*)::int FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security a ON a.admin_user_id=u.id
    WHERE NOT u.suspended AND a.is_boss AND a.status='ACTIVE') AS active_bosses,
  encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)')),'UTF8')),'hex') AS support_sha,
  pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)'))) AS support_owner,
  pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='zzsh_order')) AS schema_owner,
  (SELECT count(*)::int FROM pg_roles r JOIN pg_auth_members m ON m.member=r.oid WHERE r.rolname IN('zzsh','zzsh_regression_migration','zzsh_regression_runtime')) AS role_memberships,
  (SELECT count(*)=3 AND bool_and(NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND (CASE WHEN rolname='zzsh' THEN NOT rolcanlogin ELSE rolcanlogin AND NOT rolinherit END))
   FROM pg_roles WHERE rolname IN('zzsh','zzsh_regression_migration','zzsh_regression_runtime')) AS role_attributes_ok,
  NOT has_database_privilege('zzsh_regression_runtime',current_database(),'CREATE')
   AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')
    AND (pg_get_userbyid(n.nspowner)='zzsh_regression_runtime' OR has_schema_privilege('zzsh_regression_runtime',n.oid,'CREATE')))
   AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')
    AND pg_get_userbyid(c.relowner)='zzsh_regression_runtime')
   AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')
    AND pg_get_userbyid(p.proowner)='zzsh_regression_runtime') AS runtime_is_nonowner,
  has_function_privilege('zzsh_regression_runtime','pg_catalog.pg_control_system()','EXECUTE') AS runtime_can_read_system_id,
  (SELECT count(*)::int FROM unnest(ARRAY['ecs_test_demo_finance_registration','controlled_payment_declaration','local_controlled_refund_operation',
    'local_controlled_refund_evidence','withdrawal_admission','withdrawal_destination','withdrawal_intent','withdrawal_provider_fact','controlled_payout_operation','ecs_demo_legacy_refund']) n
    WHERE to_regclass('zzsh_order.'||n) IS NOT NULL) AS existing_demo_tables,
  to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL AS demo_match_absent,
  (SELECT count(*)::int FROM pg_constraint WHERE convalidated AND (conrelid,conname) IN (
   ('zzsh_order.payment_confirmation'::regclass,'production_real_payment_source'),('zzsh_order.distribution_order_admission'::regclass,'production_native_order_admission'),
   ('zzsh_order.finance_economic_root'::regclass,'production_no_local_controlled_root'),('zzsh_order.finance_event'::regclass,'production_no_controlled_withdrawal_event'),
   ('zzsh_order.payment_channel_observation'::regclass,'production_real_payment_observation'),('zzsh_order.payment_channel_transaction'::regclass,'production_real_payment_transaction'),
   ('zzsh_order.payment_request'::regclass,'production_real_payment_request'),('zzsh_order.rental_referral_reversal_source'::regclass,'production_native_referral_reversal'),
   ('zzsh_order.settlement_ledger_entry'::regclass,'production_no_controlled_withdrawal_entry'),('zzsh_order.channel_refund_intent'::regclass,'production_real_refund_source'))) AS production_constraints`,[bossId])).rows[0];
 assert(row?.other_connections===0&&row.server_major===16&&row.boss===1&&row.active_bosses===1&&row.support_sha===BASELINE&&row.support_owner===FIXED.migration
  &&row.schema_owner===FIXED.migration&&row.role_memberships===0&&row.role_attributes_ok===true&&row.runtime_is_nonowner===true&&row.runtime_can_read_system_id===true
  &&row.existing_demo_tables===0&&row.demo_match_absent===true&&row.production_constraints===10,
 'DEMO_INSTALL_PREIMAGE_CHANGED');return row;
}

/** Read back the actual installed guard definitions and owners; no stored success is inferred. */
export async function verifyDemoInstallGuardReadback(client){
 const rows=(await client.query(`SELECT x.signature,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS digest,
  pg_get_userbyid(p.proowner) AS owner FROM unnest($1::text[]) AS x(signature)
  JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)`,[Object.keys(INSTALLED_GUARDS)])).rows;
 assert(rows.length===Object.keys(INSTALLED_GUARDS).length&&rows.every(r=>r.owner===FIXED.migration&&INSTALLED_GUARDS[r.signature]===r.digest),
  'DEMO_INSTALL_GUARD_READBACK_MISMATCH');return rows.length;
}

/** Always run as one transaction after caller has pinned plan, authority and live resource. */
export async function applyDemoInstallTransaction(client,assembly,sql,meta,checkWindow){
 const {readEcsTestDemoRegistration}=meta.modules,proof=readEcsTestDemoRegistration(assembly.demo);
 const verifyWindow=async()=>{checkWindow();const clock=(await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS milliseconds')).rows[0];
  assert(clock&&/^[0-9]+$/.test(clock.milliseconds),'DEMO_INSTALL_DATABASE_CLOCK_INVALID');checkWindow(Number(clock.milliseconds));};
 await client.query('BEGIN');
  await meta.checkIdentity(client);await readDemoInstallPreimage(client,meta.administratorId);await verifyWindow();
  for(const name of Object.keys(SQL).slice(0,8))await client.query(sql[name]);
  await client.query(`INSERT INTO zzsh_order.ecs_test_demo_finance_registration(reference,canonical_registration,registration_digest) VALUES($1,$2,$3)`,
   [proof.registration.reference,proof.canonical,proof.digest]);
  await client.query(sql['grant-runtime.sql']);await client.query(sql['enroll-native-wallet.sql']);
  await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
   VALUES($1,'system',current_user,'demo.finance.installed','demo_finance_registration',$2,'SUCCESS',$3,clock_timestamp(),$4::jsonb)`,
   ['audit_demo_install_'+hash(meta.attempt).slice(0,40),proof.registration.reference,meta.attempt,
    JSON.stringify({planSha256:meta.planSha,approvalRef:meta.approvalRef,registrationDigest:proof.digest,source:'LOCAL_DEMO_CLONE',bankArrival:'UNKNOWN'})]);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');await meta.checkIdentity(client);await meta.verifyInputs();await verifyWindow();
  await meta.beforeCommit();const result=await client.query('COMMIT');assert.equal(result.command,'COMMIT','DEMO_INSTALL_COMMIT_ACK_INVALID');return {commitAck:true,registrationDigest:proof.digest};
}

async function main(){
 const args=process.argv.slice(2),get=name=>{const n=args.indexOf(name);return n<0?undefined:args[n+1];},modes=['--prepare','--execute','--readback'].filter(x=>args.includes(x));
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'DEMO_INSTALL_MODE_INVALID');
 const allowed=new Set(['--prepare','--execute','--readback','--out','--input','--input-sha','--plan','--plan-sha','--authority','--authority-sha','--apply-receipt','--apply-sha']);
 for(let i=0;i<args.length;i++){const name=args[i];assert(allowed.has(name)&&args.indexOf(name)===i,'DEMO_INSTALL_ARGUMENT_INVALID');if(!modes.includes(name)){assert(args[i+1]&&!args[i+1].startsWith('--'),'DEMO_INSTALL_ARGUMENT_INVALID');i++;}}
 assert.equal(process.version,'v24.20.0','DEMO_INSTALL_NODE_INVALID');const mode=modes[0],out=privatePath(get('--out'),true);assert(!existsSync(out),'DEMO_INSTALL_OUTPUT_EXISTS');
 const inputRef={path:privatePath(get('--input')),sha256:get('--input-sha')},input=pinned(inputRef).value;
 assert(input.schema==='zzsh.r07-demo-finance-install-input.v1'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.reference??''),'DEMO_INSTALL_INPUT_INVALID');
 const credentialsPath=privatePath(input.credentialsPath),credentialsBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialsBytes),target=loadRegisteredTarget(credentialsPath);
 const registrySha=hash(readFileSync(privatePath(target.sourceFile))),credentialSha=hash(credentialsBytes),restore=pinned(input.restoreReceipt),seal=pinned(input.sealReceipt),cloneRestore=pinned(input.cloneRestoreReceipt),boss=pinned(input.bossReceipt);
 const targetRef=validateLocalDemoTarget(target,credentials,restore.value,seal.value),administratorId=validateLocalDemoProofs(targetRef,input.sealReceipt,cloneRestore.value,boss.value,input.cloneRestoreReceipt.sha256);
 const api=checkedBuild(input.apiDist),build=buildFiles(api),sourceProof=fingerprint(),sql=sqlFiles();
 const require=createRequire(join(root,'apps/api/package.json')),{Client,Pool}=require('pg'),modules=require(join(api,'finance/ecs-test-demo-resource.js')),
  runtime=require(join(api,'finance/ecs-test-demo-runtime.js'));
 const proof=modules.verifyLocalDemoCloneProof(restore.bytes,restore.sha256),origins={apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false};
 const env=process.env,environment=validateLocalDemoEnvironment(env,targetRef,input.reference,administratorId,input.restoreReceipt,join(root,'apps/api'));
 const config={profile:'dev',provider:'fake',testOperationsEnabled:false,host:'127.0.0.1',port:4232,database:{target:'local-compose',targetProfile:'dev',host:target.host,port:target.port,
  name:target.database,user:target.runtimeRole,runtimeUser:target.runtimeRole}};
 const assembly=runtime.createLocalDemoCloneRuntime({config,origins,env,proof,reference:input.reference,administratorId,appId:env.YUNXIN_APP_KEY}),registration=modules.readEcsTestDemoRegistration(assembly.demo);
 const loaded=loadedProof(require);
 const planRef=mode==='--prepare'?null:{path:get('--plan'),sha256:get('--plan-sha')},plan=planRef?pinned(planRef).value:null;
 const authorityRef=mode==='--execute'?{path:get('--authority'),sha256:get('--authority-sha')}:null,authority=authorityRef?pinned(authorityRef).value:null;
 const applyRef=mode==='--readback'?{path:get('--apply-receipt'),sha256:get('--apply-sha')}:null,applied=applyRef?pinned(applyRef).value:null;
 const expected={schema:'zzsh.r07-demo-finance-install-plan.v1',inputSha256:inputRef.sha256,target:targetRef,credentialSha,registrySha,build,sourceProof,loaded,
  sqlHashes:SQL,restoreReceiptSha256:restore.sha256,sealReceiptSha256:seal.sha256,cloneRestoreReceiptSha256:cloneRestore.sha256,bossReceiptSha256:boss.sha256,
  administratorId,reference:input.reference,registrationDigest:registration.digest,environment};
 if(plan)assert(plan.status==='PREPARED_READ_ONLY'&&plan.rollbackAck===true&&plan.unlockAck===true&&plan.connectionsClosed===true
  &&same(Object.fromEntries(Object.keys(expected).map(k=>[k,plan[k]])),expected),'DEMO_INSTALL_PLAN_CHANGED');
 if(authority)validateLocalDemoAuthority(authority,planRef.sha256,targetRef,registration.digest);
 if(applied)assert(applied.schema==='zzsh.r07-demo-finance-install-receipt.v1'
  &&(applied.status==='COMMIT_ACK_READBACK_REQUIRED'&&applied.commitAck===true||applied.status==='COMMIT_UNKNOWN'&&applied.commitAck===false
   ||applied.status==='COMMIT_REQUESTED'&&applied.commitAck===undefined)
  &&applied.commitSent===true&&applied.planSha256===planRef.sha256&&same(applied.target,targetRef)&&applied.registrationDigest===registration.digest
  &&/^[A-Za-z0-9._:-]{1,128}$/.test(applied.attempt??'')&&/^[A-Za-z0-9._:-]{1,128}$/.test(applied.approvalRef??'')
  &&Number.isFinite(Date.parse(applied.notBefore))&&Number.isFinite(Date.parse(applied.expiresAt))&&Date.parse(applied.expiresAt)>Date.parse(applied.notBefore)
  &&Date.parse(applied.expiresAt)-Date.parse(applied.notBefore)<=30*60_000&&hex(applied.claimSha256),'DEMO_INSTALL_APPLY_RECEIPT_INVALID');
 const claimPath=privatePath(join(dirname(credentialsPath),'r07-demo-finance-install.claim'),mode!=='--readback');let claimSha=applied?.claimSha256;
 if(applied){const bytes=readFileSync(claimPath);assert.equal(hash(bytes),applied.claimSha256,'DEMO_INSTALL_ORIGINAL_CLAIM_CHANGED');
  validateInstallClaim(JSON.parse(bytes),applied,planRef.sha256,targetRef,registration.digest);}
 const verifyInputs=()=>{for(const ref of inputFiles(input,inputRef))pinned(ref);if(planRef)pinned(planRef);if(authorityRef)pinned(authorityRef);if(applyRef)pinned(applyRef);
  assert(hash(readFileSync(credentialsPath))===credentialSha&&hash(readFileSync(target.sourceFile))===registrySha&&same(buildFiles(api),build)&&same(fingerprint(),sourceProof)&&same(loadedProof(require),loaded)
   &&same(validateLocalDemoEnvironment(env,targetRef,input.reference,administratorId,input.restoreReceipt,join(root,'apps/api')),environment),'DEMO_INSTALL_BOUND_FILES_CHANGED');
  if(claimSha)assert.equal(hash(readFileSync(privatePath(claimPath))),claimSha,'DEMO_INSTALL_ORIGINAL_CLAIM_CHANGED');sqlFiles();};
 const common={connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000};
 const lock=new Client(maintenanceConnection(target,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-demo-install-lock'}));
 const client=new Client(targetConnection(target,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-demo-install'}));
 let lockOpen=false,clientOpen=false,held=false,begun=false,commitSent=false,commitAck=false,rollbackAck=false,unlockAck=false,connectionsClosed=false;
 let receipt={schema:'zzsh.r07-demo-finance-install-receipt.v1',status:'STARTED',target:targetRef,startedAt:new Date().toISOString(),providerCalls:0,financialWrites:0};
 const receiptPath=join(out,'receipt.json'),save=()=>writeLoadCheckpoint(receiptPath,receipt);
 if(mode==='--execute'){
  assert(!existsSync(claimPath),'DEMO_INSTALL_ATTEMPT_ALREADY_CLAIMED');
  const claimBytes=Buffer.from(JSON.stringify({schema:'zzsh.r07-demo-finance-install-claim.v1',planSha256:planRef.sha256,target:targetRef,
   registrationDigest:registration.digest,approvalRef:authority.approvalRef,attempt:authority.attempt}));
  const fd=openSync(claimPath,'wx',0o600);try{writeFileSync(fd,claimBytes);fsyncSync(fd);}finally{closeSync(fd);}
  claimSha=hash(claimBytes);receipt={...receipt,claimSha256:claimSha,planSha256:planRef.sha256,registrationDigest:registration.digest,approvalRef:authority.approvalRef,
   attempt:authority.attempt,notBefore:authority.notBefore,expiresAt:authority.expiresAt};writePrivate(receiptPath,receipt);
 }
 try{
  await lock.connect();lockOpen=true;held=(await lock.query(advisoryLockSql(target,'try'))).rows[0]?.ok===true;assert(held,'DEMO_INSTALL_RESOURCE_BUSY');
  await client.connect();clientOpen=true;await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const live=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,live,'migration');assert.equal(String(live.owner_oid),FIXED.ownerOid,'DEMO_INSTALL_OWNER_CHANGED');
  if(mode!=='--readback')await readDemoInstallPreimage(client,administratorId);
  else{
   if(applied.commitAck!==true){const others=(await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()`)).rows[0];
    assert.equal(others?.n,0,'DEMO_INSTALL_UNKNOWN_TARGET_BUSY');}
   const row=(await client.query(`SELECT canonical_registration,registration_digest,active FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=$1`,[input.reference])).rows;
   assert(row.length===1&&row[0].canonical_registration===registration.canonical&&row[0].registration_digest===registration.digest&&row[0].active===true,'DEMO_INSTALL_REGISTRATION_MISMATCH');
   const major=(await client.query("SELECT current_setting('server_version_num')::int/10000 AS major")).rows[0];assert.equal(major?.major,16,'DEMO_INSTALL_POSTGRES_VERSION_CHANGED');
   await verifyDemoInstallGuardReadback(client);
   const audit=(await client.query(`SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE id=$1 AND action='demo.finance.installed' AND outcome='SUCCESS'
    AND object_id=$2 AND request_id=$3 AND details->>'planSha256'=$4 AND details->>'registrationDigest'=$5`,
    ['audit_demo_install_'+hash(applied.attempt).slice(0,40),input.reference,applied.attempt,planRef.sha256,registration.digest])).rows[0];assert.equal(audit?.n,1,'DEMO_INSTALL_AUDIT_MISSING');
  }
  assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;verifyInputs();
  if(mode==='--prepare')receipt={...expected,status:'PREPARED_READ_ONLY',rollbackAck:true};
  else if(mode==='--execute'){
   validateLocalDemoAuthority(authority,planRef.sha256,targetRef,registration.digest);receipt.status='TRANSACTION_INTENT';save();begun=true;
   const result=await applyDemoInstallTransaction(client,assembly,sql,{modules,administratorId,attempt:authority.attempt,approvalRef:authority.approvalRef,planSha:planRef.sha256,
    verifyInputs:async()=>verifyInputs(),checkIdentity:async c=>{const id=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,id,'migration');assert.equal(String(id.owner_oid),FIXED.ownerOid,'DEMO_INSTALL_OWNER_CHANGED');
     const sessions=(await c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()`)).rows[0];
     assert.equal(sessions?.n,0,'DEMO_INSTALL_TARGET_BUSY');},
    beforeCommit:async()=>{receipt.status='COMMIT_REQUESTED';receipt.commitSent=true;save();commitSent=true;}},now=>validateLocalDemoAuthority(authority,planRef.sha256,targetRef,registration.digest,now));
   begun=false;commitAck=result.commitAck;receipt.status='COMMIT_ACK_READBACK_REQUIRED';receipt.commitAck=true;save();
  }else{
   const runtimePool=new Pool(targetConnection(target,{...common,user:credentials.runtime.name,password:credentials.runtime.password,max:1,applicationName:'r07-demo-install-readback'}));
   try{await runtime.preflightEcsTestDemoRuntime(runtimePool,assembly);}finally{await runtimePool.end();}
   receipt={schema:'zzsh.r07-demo-finance-install-readback.v1',status:'DEMO_INSTALL_VERIFIED',target:targetRef,planSha256:planRef.sha256,
    registrationDigest:registration.digest,commitOutcome:applied.commitAck?'ACKNOWLEDGED':'CONFIRMED_BY_ORIGINAL_AUDIT',providerCalls:0,financialWrites:0,rollbackAck:true};
  }
 }catch(e){receipt.status=mode==='--readback'&&applied?.commitAck!==true?'COMMIT_UNKNOWN_UNRESOLVED':commitSent&&!commitAck?'COMMIT_UNKNOWN':commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';receipt.error=isErrorCode(e);if(commitSent)receipt.commitAck=commitAck;
  if(begun&&!commitSent){try{rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';begun=false;}catch{rollbackAck=false;}}receipt.rollbackAck=rollbackAck;process.exitCode=1;
 }finally{
  if(begun&&!commitSent)await client.query('ROLLBACK').catch(()=>{});let clientClosed=!clientOpen,lockClosed=!lockOpen;
  try{if(clientOpen){await client.end();clientClosed=true;}}catch{}try{if(held)unlockAck=(await lock.query(advisoryLockSql(target,'unlock'))).rows[0]?.ok===true;}catch{}
  try{if(lockOpen){await lock.end();lockClosed=true;}}catch{}connectionsClosed=clientClosed&&lockClosed;Object.assign(receipt,{unlockAck,connectionsClosed,finishedAt:new Date().toISOString()});
 }
 if(mode==='--execute')save();else if(!process.exitCode&&rollbackAck&&unlockAck&&connectionsClosed){const path=join(out,mode==='--prepare'?'plan.json':'readback.json');writePrivate(path,receipt);console.log(JSON.stringify({status:receipt.status,sha256:hash(readFileSync(path)),providerCalls:0,financialWrites:0}));return;}
 console.log(JSON.stringify({status:receipt.status,error:receipt.error,commitAck,rollbackAck,unlockAck,connectionsClosed,providerCalls:0,financialWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(e=>{console.error(JSON.stringify({status:'DEMO_INSTALL_STOPPED',code:isErrorCode(e)}));process.exitCode=1;});
