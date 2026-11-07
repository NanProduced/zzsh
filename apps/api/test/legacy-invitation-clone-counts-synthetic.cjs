// Explicit isolated synthetic PostgreSQL only; clone COUNTS capability, never R07 or actual clone.
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{resolve}=require('node:path');
const container=process.env.R08_INVITE_CLONE_SYNTH_CONTAINER,system=process.env.R08_INVITE_CLONE_SYNTH_SYSTEM,oid=process.env.R08_INVITE_CLONE_SYNTH_OID;
assert(/^[a-f0-9]{64}$/.test(container||'')&&/^[0-9]+$/.test(system||'')&&/^[0-9]+$/.test(oid||''),'synthetic identity required');
const run=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
const inspect=run(['inspect',container,'--format','{{.Id}}|{{index .Config.Labels "zzsh.task"}}|{{.HostConfig.NetworkMode}}|{{json .Mounts}}|{{json .NetworkSettings.Ports}}']);
assert.equal(inspect.status,0);assert.equal(inspect.stdout.trim(),`${container}|r07-invitation-clone-synth|none|[]|{}`);
const check=run(['exec','-i','-u','postgres',container,'psql','-p','55434','-U','postgres','-d','zzsh_test_r07_delivery_20261108','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],
 "SELECT system_identifier FROM pg_control_system(); SELECT oid||'|'||shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database(); SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'zzsh_%';");
assert.equal(check.status,0);assert.equal(check.stdout.trim(),`${system}\n${oid}|zzsh:r07-delivery-clone:v1\n0`);
const code=String.raw`
const assert=require('node:assert/strict'),{Client}=require('/work/node_modules/pg');
const Module=require('node:module'),load=Module._load;Module._load=function(name,...args){if(name==='sharp')return()=>{throw Error('unused synthetic image')};return load.call(this,name,...args)};
const facts=require('/work/apps/api/dist/src/finance/legacy-invitation-facts.js'),writer=require('/work/apps/api/dist/src/finance/legacy-invitation-facts-maintenance.js');
const {legacyOwnerUserId}=require('/work/apps/api/dist/src/supply/legacy-user-migration.js'),{fingerprintRequest}=require('/work/apps/api/dist/src/supply/supply-util.js');
const hash=facts.invitationFactHash,actor={userId:'synthetic-boss',sessionId:'synthetic-session',requestId:'synthetic-request'},nonce='a'.repeat(24);
const raw=(id,parent)=>({legacyId:id,userId:legacyOwnerUserId('legacy_mysql_restore','la_user',id),identitySourceDigest:'a'.repeat(64),
 userSource:{id,is_delete:'0',is_disable:'0',inviter_id:parent,first_leader:parent,second_leader:'0',third_leader:'0',create_time:'1',update_time:'2'},
 codeSource:{id,code:'fx'+id},qualificationSource:{id,user_id:id,level_id:'7',is_delete:'0',is_freeze:'0',is_distribution:'1'}});
const rawFacts=[raw('1','0'),raw('2','1')],byId=new Map(rawFacts.map(f=>[f.legacyId,f])),ids=[...byId.keys()].sort();
const source={schema:'legacy-invitation-source.v2',sourceSystem:'legacy_mysql_restore',cutoff:'2026-09-13T13:31:13.000Z',receiptSha256:'b'.repeat(64),supplementReceiptSha256:'b'.repeat(64),
 files:{users:{sha256:'c'.repeat(64),rows:2},qualification:{sha256:'d'.repeat(64),rows:2},codes:{sha256:'c'.repeat(64),rows:2}},subjectSetDigest:hash(ids),codeSetDigest:hash(ids.map(id=>[id,byId.get(id).codeSource.code.toUpperCase(),hash(byId.get(id).codeSource)]))};
const packet=facts.planLegacyInvitationFacts(source,rawFacts,null,5000).packets[0],prepared=facts.prepareLegacyInvitationFacts(packet,hash(packet));
(async()=>{const a=new Client({host:'127.0.0.1',port:55434,user:'postgres',database:'zzsh_test_r07_delivery_20261108'});await a.connect();
 await a.query('BEGIN');for(const schema of ['zzsh_order','zzsh_supply','zzsh_iam','zzsh_auth_admin','zzsh_auth_user'])await a.query('CREATE SCHEMA '+schema+' AUTHORIZATION zzsh_regression_migration');
 await a.query('SET LOCAL ROLE zzsh_regression_migration');await a.query([
  'CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY)',
  'CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY,"twoFactorEnabled" boolean NOT NULL,suspended boolean NOT NULL)',
  'CREATE TABLE zzsh_auth_admin.session(id text PRIMARY KEY,"userId" text NOT NULL,locked boolean NOT NULL,"expiresAt" timestamptz NOT NULL)',
  'CREATE TABLE zzsh_iam.admin_security(admin_user_id text PRIMARY KEY,status text NOT NULL,is_boss boolean NOT NULL,password_change_required boolean NOT NULL)',
  'CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text NOT NULL,object_type text,object_id text,outcome text NOT NULL,request_id text,reason text,occurred_at timestamptz,details jsonb NOT NULL)',
  'CREATE TABLE zzsh_supply.idempotency_record(scope_key text NOT NULL,key text NOT NULL,request_fingerprint text NOT NULL,response_status integer NOT NULL,response_body jsonb NOT NULL,publish_required boolean NOT NULL,PRIMARY KEY(scope_key,key))',
  'CREATE TABLE zzsh_order.distribution_participant(user_id text PRIMARY KEY,eligibility text,commission_frozen boolean,level_code text,policy_version_id text,revision bigint NOT NULL,inviter_knowledge text,leader_knowledge text,invitees_knowledge text,source_type text,source_ref text,source_digest text)',
  'CREATE TABLE zzsh_order.distribution_invite_code(id text PRIMARY KEY,user_id text UNIQUE,display_code text,match_code text GENERATED ALWAYS AS (upper(display_code)) STORED,source_type text,source_system text,source_entity text,source_id text,source_digest text)',
  'CREATE TABLE zzsh_order.invitation_relation(id text PRIMARY KEY,type text,child_user_id text,parent_user_id text,policy_version_id text,source_type text,source_ref text,source_digest text,UNIQUE(type,child_user_id))',
  "CREATE FUNCTION zzsh_order.distribution_policy_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2'"
 ].join(';'));
 await a.query('INSERT INTO zzsh_auth_admin."user" VALUES($1,true,false)',[actor.userId]);await a.query("INSERT INTO zzsh_auth_admin.session VALUES($1,$2,false,clock_timestamp()+interval '2 hours')",[actor.sessionId,actor.userId]);
 await a.query("INSERT INTO zzsh_iam.admin_security VALUES($1,'ACTIVE',true,false)",[actor.userId]);
 for(const s of prepared.subjects){await a.query('INSERT INTO zzsh_auth_user."user" VALUES($1)',[s.userId]);
  await a.query("INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,occurred_at,details) VALUES($1,'system','user.legacy_owner.migrated','user',$2,'SUCCESS',now(),$3::jsonb)",['id-'+s.fact.legacyId,s.userId,JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId:s.fact.legacyId,sourceDigest:s.fact.identitySourceDigest})]);
  await a.query("INSERT INTO zzsh_order.distribution_participant VALUES($1,$2,$3,NULL,NULL,1,$4,$5,$6,'LEGACY_MYSQL',$7,$8)",[s.userId,s.eligibility,s.commissionFrozen,s.inviterKnowledge,s.leaderKnowledge,s.inviteesKnowledge,s.sourceRef,s.sourceDigest]);
  await a.query("INSERT INTO zzsh_order.distribution_invite_code(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest) VALUES($1,$2,$3,'LEGACY_MYSQL','legacy_mysql_restore','la_user',$4,$5)",[s.codeId,s.userId,s.fact.codeSource.code,s.fact.legacyId,s.codeDigest]);}
 for(const r of prepared.relations)await a.query("INSERT INTO zzsh_order.invitation_relation VALUES($1,$2,$3,$4,NULL,'LEGACY_MYSQL',$5,$6)",[r.id,r.type,r.childUserId,r.parentUserId,r.sourceRef,r.sourceDigest]);
 const originalBody={bodyDigest:prepared.bodyDigest,sourceDigest:hash(source),policyVersionId:null,participants:prepared.subjects.length,codes:prepared.subjects.length,relations:prepared.relations.length,financialEffects:false,subjectProofs:prepared.subjects.map(s=>({userId:s.userId,sourceDigest:s.sourceDigest}))};
 const originalScope=JSON.stringify(['admin',actor.userId,facts.legacyInvitationFactsOperation,null]);
 await a.query('INSERT INTO zzsh_supply.idempotency_record VALUES($1,$2,$3,200,$4::jsonb,false)',[originalScope,prepared.key,fingerprintRequest(facts.legacyInvitationFactsOperation,undefined,{bodyDigest:prepared.bodyDigest}),JSON.stringify(originalBody)]);
 await a.query("INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details) VALUES('source-audit','admin',$1,$2,'distribution.legacy_facts.imported','legacy_invitation_batch',$3,'SUCCESS','synthetic',now(),$4::jsonb)",[actor.userId,actor.sessionId,prepared.bodyDigest,JSON.stringify({bodyDigest:prepared.bodyDigest,source,facts:packet.subjects,financialEffects:false})]);
 await a.query('COMMIT');const db=(await a.query("SELECT oid::int AS oid,datdba::int AS owner FROM pg_database WHERE datname=current_database()")).rows[0],role=(await a.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='zzsh_regression_migration'")).rows[0].oid;await a.end();
 const c=new Client({host:'127.0.0.1',port:55434,user:'zzsh_regression_migration',database:'zzsh_test_r07_delivery_20261108'});await c.connect();
 const review={ref:'SYNTHETIC',attempt:'synthetic-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{host:'127.0.0.1',port:55434,database:'zzsh_test_r07_delivery_20261108',oid:db.oid,owner:'zzsh',ownerOid:db.owner,marker:'zzsh:r07-delivery-clone:v1',role:'zzsh_regression_migration',roleOid:role},
  notBefore:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),sourceDigest:hash(source),bodyDigest:hash(packet),phase:'COUNTS',nonce,systemIdentifier:${JSON.stringify(system)}};
 async function rejected(change,mutate){await c.query('BEGIN');try{if(mutate)await mutate();await assert.rejects(async()=>{const cap=await writer.bindReviewedLegacyInvitationFacts(c,actor,{...review,...change});await writer.closeReviewedLegacyInvitationCounts(c,actor,packet,hash(packet),cap)});}
  finally{await c.query('ROLLBACK');}}
 await rejected({phase:'IMPORT'});await rejected({phase:'QUALIFY'});await rejected({systemIdentifier:'7704972584346443810'});await rejected({systemIdentifier:'9999999999999999999'});
 await rejected({nonce:'b'.repeat(24)});await rejected({resource:{...review.resource,marker:'zzsh:regression-test:v1'}});
 await rejected({},()=>c.query('DELETE FROM zzsh_order.invitation_relation WHERE id=$1',[prepared.relations[0].id]));
 await rejected({},()=>c.query('DELETE FROM zzsh_supply.idempotency_record WHERE scope_key=$1',[originalScope]));
 await c.query('BEGIN');let cap=await writer.bindReviewedLegacyInvitationFacts(c,actor,review),first=await writer.closeReviewedLegacyInvitationCounts(c,actor,packet,hash(packet),cap);await c.query('COMMIT');assert.equal(first.replayed,false);
 await c.query('BEGIN');cap=await writer.bindReviewedLegacyInvitationFacts(c,actor,review);const replay=await writer.closeReviewedLegacyInvitationCounts(c,actor,packet,hash(packet),cap);await c.query('COMMIT');assert.equal(replay.replayed,true);
 const p=(await c.query('SELECT count(*)::int AS n FROM zzsh_order.distribution_participant WHERE invitees_knowledge=\'KNOWN\'')).rows[0].n;assert.equal(p,2);
 assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed'")).rows[0].n,1);await c.end();
})().catch(e=>{console.error(e);process.exit(1)});`;
const out=run(['run','--rm','--network',`container:${container}`,'--mount',`type=bind,source=${resolve(__dirname,'../../..')},target=/work,readonly`,'node:24.20.0-bookworm-slim','node','-e',code]);
if(out.status!==0)throw Error(`synthetic clone invitation closure failed: ${out.stderr}`);
console.log('SYNTHETIC_CLONE_INVITATION_COUNTS_PASSED');
