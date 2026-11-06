/* Runs only after distribution-management-synthetic.cjs in the same isolated synthetic DB. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Pool,Client}=require('pg');
const {createProvisionedDistributionManagementResource}=require('../src/finance/distribution-management-resource.ts');
const {readManagementParticipants,rotateParticipantInviteCode}=require('../src/finance/admin-distribution-management.ts');
const {authorizeDistributionDashboard}=require('../src/finance/admin-distribution-dashboard.ts');
const {loadEffectiveAdminAccess}=require('../src/auth/admin-authorization.ts');
const {claim}=require('./distribution-management-synthetic-resource.cjs');
const e=process.env;assert.equal(e.DISTRIBUTION_SYNTH_OPT_IN,'1');assert.equal(e.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
for(const key of ['DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(e[key]??'',/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(e[key]);
const opts={host:e.DISTRIBUTION_SYNTH_HOST,port:5432,database:e.DISTRIBUTION_SYNTH_DB,statement_timeout:10000,lock_timeout:1000};
const owner=new Client({...opts,user:e.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-minimal-owner'}),pool=new Pool({...opts,user:e.DISTRIBUTION_SYNTH_RUNTIME,max:2,application_name:'distribution-minimal-runtime'});
const resource=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:opts.database,user:e.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:e.DISTRIBUTION_SYNTH_RUNTIME}});
const actor={userId:'minimal_synth',sessionId:'minimal_session',requestId:'minimal_request'};
let releaseLock;
(async()=>{try{
 await owner.connect();const id=(await owner.query(`SELECT d.oid::text oid,current_database() name,current_user owner,shobj_description(d.oid,'pg_database') marker,(pg_control_system()).system_identifier::text system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) others FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(id,{oid:e.DISTRIBUTION_SYNTH_DB_OID,name:e.DISTRIBUTION_SYNTH_DB,owner:e.DISTRIBUTION_SYNTH_OWNER,marker:e.DISTRIBUTION_SYNTH_MARKER,system_id:e.DISTRIBUTION_SYNTH_SYSTEM_ID,others:0});
 releaseLock=await claim(owner,e);
 assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_auth_admin.\"user\" WHERE id='minimal_synth'")).rows[0].n,0);
 await owner.query('BEGIN');try{await owner.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt","twoFactorEnabled") VALUES('minimal_synth','Minimal','minimal@example.invalid',now(),now(),true);
  INSERT INTO zzsh_iam.admin_security(admin_user_id,status,game_scope_mode) VALUES('minimal_synth','PENDING_ENROLLMENT','SELECTED_GAMES');
  UPDATE zzsh_iam.admin_security SET status='ACTIVE',first_activated_at=now() WHERE admin_user_id='minimal_synth';
  INSERT INTO zzsh_auth_admin."session"(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES('minimal_session',now()+interval '1 day','minimal_token',now(),now(),'minimal_synth');
  INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES
   ('minimal_synth','distribution.participant.read','ALLOW'),('minimal_synth','distribution.participant.manage','ALLOW'),('minimal_synth','distribution.level.manage','ALLOW');`);await owner.query('COMMIT');}catch(err){await owner.query('ROLLBACK');throw err;}
 const access=await loadEffectiveAdminAccess(pool,actor.userId);assert(access);assert.equal(access.isBoss,false);
 for(const code of ['distribution.dashboard.read','finance.read','personal.distribution.policy.manage','user.directory.read'])assert.equal(access.permissions.has(code),false);
 const participant=await readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource);assert.equal(participant.items.length,1);assert.equal(participant.items[0].name,null);
 const client=await pool.connect();try{await client.query('BEGIN READ ONLY');await assert.rejects(()=>authorizeDistributionDashboard(client,actor),err=>err.status===403);await client.query('ROLLBACK');}finally{client.release();}
 const oldCodeId=participant.items[0].inviteCodeId;assert(oldCodeId);
 const changed=await rotateParticipantInviteCode(pool,actor,'owner_synth',{expectedCodeId:oldCodeId,code:'MINIMAL_CODE',reason:'最小权限合成验证'},'idem_minimal',resource);assert.equal(changed.body.code,'MINIMAL_CODE');
 assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_order.invitation_relation WHERE id='relation_synth' AND parent_user_id='owner_synth'")).rows[0].n,1);
 await owner.query("UPDATE zzsh_iam.admin_security SET password_change_required=true WHERE admin_user_id='minimal_synth'");
 await assert.rejects(()=>readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource),err=>err.status===403);
 console.log(JSON.stringify({status:'PASS',checks:['minimal_permissions_without_finance_or_directory','selected_games_read_and_write','dashboard_forbidden','name_redacted','password_change_required_denied']}));
 }finally{await pool.end();try{if(releaseLock)await releaseLock();}finally{await owner.end();}}})().catch(err=>{console.error(err);process.exitCode=1;});
