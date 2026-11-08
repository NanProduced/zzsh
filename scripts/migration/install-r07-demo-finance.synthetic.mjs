// Calls only the exported transaction core with an independently registered synthetic PG.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import net from 'node:net';import Module,{createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {resolve,join} from 'node:path';
const load=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.DEMO_INSTALL_SYNTH_OPT_IN,'1','SYNTHETIC_OPT_IN_REQUIRED');
const syntheticOid=process.env.DEMO_INSTALL_SYNTH_OID,syntheticSystem=process.env.DEMO_INSTALL_SYNTH_SYSTEM_ID;
assert(/^[0-9]+$/.test(syntheticOid??'')&&/^[0-9]+$/.test(syntheticSystem??'')
 &&!['7704972584346443810','7705473419326033954'].includes(syntheticSystem),'SYNTHETIC_IDENTITY_REQUIRED');
const {applyDemoInstallTransaction,readDemoInstallPreimage,verifyDemoInstallGuardReadback}=await import('./install-r07-demo-finance.mjs');
const {assertLiveTarget,targetIdentityQuery}=await import('./local-target-registry.mjs');
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),require=createRequire(join(root,'apps/api/package.json')),{Pool}=require('pg');
const modules=require(join(root,'apps/api/dist/src/finance/ecs-test-demo-resource')),runtime=require(join(root,'apps/api/dist/src/finance/ecs-test-demo-runtime'));
const id='admin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',nonce='a11111111111111111111111',db='zzsh_test_r07_delivery_20261108';
const opts={host:'127.0.0.1',port:55434,database:db,max:1},superPool=new Pool({...opts,user:'postgres'}),migration=new Pool({...opts,user:'zzsh_regression_migration'}),runtimePool=new Pool({...opts,user:'zzsh_regression_runtime'});
const names=['registration.sql','controlled-payment-schema.sql','new-order-payment.sql','demo-refund.sql','demo-withdrawal.sql','demo-legacy-refund.sql','demo-prestart-refund.sql','demo-support-cancel.sql','grant-runtime.sql','enroll-native-wallet.sql','common-payment-request.sql','immediate-payout.sql'];
const sql=Object.fromEntries(names.map(n=>[n,readFileSync(join(root,'apps/api/migrations/candidates/ecs-test-demo-finance',n),'utf8')]));
const sha=x=>createHash('sha256').update(x).digest('hex');
async function test(){const proxy=net.createServer(s=>{const t=net.connect(5432,'127.0.0.1');s.pipe(t);t.pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy())});await new Promise((ok,fail)=>{proxy.once('error',fail);proxy.listen(55434,'127.0.0.1',ok)});
 try{
  const superClient=await superPool.connect();const identity=(await superClient.query(`SELECT d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system,
   d.datdba::text AS owner_oid,(SELECT oid::text FROM pg_roles WHERE rolname='zzsh_regression_migration') AS migration_oid,
   (SELECT oid::text FROM pg_roles WHERE rolname='zzsh_regression_runtime') AS runtime_oid FROM pg_database d WHERE d.datname=current_database()`)).rows[0];superClient.release();
  assert.equal(identity.oid,syntheticOid);assert.equal(identity.system,syntheticSystem);assert.equal(identity.marker,'zzsh:r07-delivery-clone:v1');await superPool.end();
  const target={database:db,oid:identity.oid,marker:identity.marker,nonce,owner:'zzsh',host:'127.0.0.1',port:55434,instance:{host:'127.0.0.1',port:55434,systemIdentifier:identity.system},
   migrationRole:'zzsh_regression_migration',migrationRoleOid:identity.migration_oid,runtimeRole:'zzsh_regression_runtime',runtimeRoleOid:identity.runtime_oid,lockKey:'806007',maintenanceDatabase:'postgres'};
  const receipt={schema:'zzsh.r07-demo-clone-restored.v1',status:'RESTORED_AND_VERIFIED',verification:{sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0,intentionalExceptions:[{code:'OWNER_DEPRIVILEGED',role:'zzsh'},{code:'DATABASE_EPOCH_CHANGED'}]},
   source:{database:'zzsh_test_regression',oid:'16390',marker:'zzsh:regression-test:v1',systemIdentifier:'7704972584346443810',archiveSha256:'a'.repeat(64),aclSha256:'b'.repeat(64)},
   target:{database:db,oid:identity.oid,marker:identity.marker,systemIdentifier:identity.system,host:target.host,port:target.port,nonce,
    owner:{name:'zzsh',oid:identity.owner_oid},migration:{name:target.migrationRole,oid:target.migrationRoleOid},runtime:{name:target.runtimeRole,oid:target.runtimeRoleOid}}};
  const bytes=Buffer.from(JSON.stringify(receipt)),proof=modules.verifyLocalDemoCloneProof(bytes,sha(bytes));
  const env={APP_PROFILE:'dev',NODE_ENV:'development',LOCAL_DEMO_CLONE_FINANCE_ENABLED:'true',JOINPAY_COLLECTION_ENABLED:'false',JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
  const config={profile:'dev',provider:'fake',testOperationsEnabled:false,host:'127.0.0.1',port:4232,database:{target:'local-compose',targetProfile:'dev',host:target.host,port:target.port,name:db,user:target.runtimeRole,runtimeUser:target.runtimeRole}};
  const assembly=runtime.createLocalDemoCloneRuntime({config,env,proof,reference:'synthetic_install',administratorId:id,appId:'demo-install-preflight',origins:{apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false}});
  const c=await migration.connect();try{
   async function checkIdentity(client){const row=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,row,'migration');assert.equal(String(row.owner_oid),identity.owner_oid);}
   const registration=modules.readEcsTestDemoRegistration(assembly.demo),base={modules,administratorId:id,attempt:'synthetic_attempt',approvalRef:'synthetic_approval',planSha:'d'.repeat(64),
    checkIdentity,verifyInputs:async()=>{},beforeCommit:async()=>{}};
   async function run(meta,window){try{return await applyDemoInstallTransaction(c,assembly,sql,{...base,...meta},window)}catch(e){await c.query('ROLLBACK');throw e;}}
   async function original(){await c.query('BEGIN READ ONLY');const p=await readDemoInstallPreimage(c,id);assert.equal(p.existing_demo_tables,0);await c.query('ROLLBACK');}
   await original();await assert.rejects(run({checkIdentity:async()=>{throw Error('SYNTHETIC_WRONG_TARGET')}},()=>{}),/SYNTHETIC_WRONG_TARGET/);await original();
   let checks=0;await assert.rejects(run({},()=>{if(++checks>2)throw Error('SYNTHETIC_WINDOW_EXPIRED')}),/SYNTHETIC_WINDOW_EXPIRED/);await original();
   const changed={...sql,'demo-prestart-refund.sql':sql['demo-prestart-refund.sql']+'\nSELECT 1/0;'};
   try{await assert.rejects(applyDemoInstallTransaction(c,assembly,changed,base,()=>{}));}finally{await c.query('ROLLBACK');}await original();
   let commitSent=false;const originalQuery=c.query.bind(c);c.query=async(...args)=>{const result=await originalQuery(...args);if(args[0]==='COMMIT'&&commitSent)throw Error('SYNTHETIC_COMMIT_ACK_LOST');return result;};
   try{await assert.rejects(applyDemoInstallTransaction(c,assembly,sql,{...base,beforeCommit:async()=>{commitSent=true;}},()=>{}),/SYNTHETIC_COMMIT_ACK_LOST/);}finally{c.query=originalQuery;}
   assert.equal(commitSent,true); // Do not retry or issue ROLLBACK after an unknown commit.
   const row=(await c.query(`SELECT registration_digest,active FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference='synthetic_install'`)).rows;assert.deepEqual(row,[{registration_digest:registration.digest,active:true}]);
   const audit=(await c.query(`SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='demo.finance.installed' AND request_id='synthetic_attempt'`)).rows[0];assert.equal(audit.n,1);
   // The historical installer stays unchanged; the cashier upgrade is a separate atomic step.
   await c.query('BEGIN');await c.query(sql['common-payment-request.sql']);await c.query('COMMIT');
   await c.query('BEGIN');await c.query(sql['immediate-payout.sql']);await c.query('COMMIT');
   await runtime.preflightEcsTestDemoRuntime(runtimePool,assembly);
   await c.query('BEGIN READ ONLY');assert.equal(await verifyDemoInstallGuardReadback(c),9);await c.query('ROLLBACK');
   await c.query('BEGIN');await c.query(`CREATE OR REPLACE FUNCTION zzsh_order.support_cancel_payment_basis_valid(b jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$`);
   await assert.rejects(verifyDemoInstallGuardReadback(c),/DEMO_INSTALL_GUARD_READBACK_MISMATCH/);await c.query('ROLLBACK');
   await c.query('BEGIN READ ONLY');assert.equal(await verifyDemoInstallGuardReadback(c),9);await c.query('ROLLBACK');
   await c.query('BEGIN READ ONLY');await assert.rejects(readDemoInstallPreimage(c,id),/DEMO_INSTALL_PREIMAGE_CHANGED/);await c.query('ROLLBACK');
   console.log(JSON.stringify({status:'PASS',scope:'independent synthetic PG16 with fictitious Boss',assertions:['exact synthetic resource','wrong identity no write','expired window rollback','DDL failure rollback','eight DDL registration/ACL single transaction','commit ACK intentionally lost','same original registration and one audit verified','common cashier and immediate payout upgrade transactions','nine guard hashes and tamper refusal','runtime preflight','second install refused'],notRun:['CLI restricted files','real 55434','ECS','real providers']}));
  }finally{c.release();}
 }finally{await Promise.all([migration.end(),runtimePool.end()]);await new Promise(ok=>proxy.close(ok));}}
test().catch(e=>{console.error(e);process.exitCode=1});
