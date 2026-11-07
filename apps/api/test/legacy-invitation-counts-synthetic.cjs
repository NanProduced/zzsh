// Explicit isolated synthetic PostgreSQL only; never accepts a real migration resource.
const assert=require('node:assert/strict'),{Pool}=require('pg'),{createHash}=require('node:crypto'),{mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{tmpdir}=require('node:os'),{join}=require('node:path');
const Module=require('node:module'),load=Module._load;
Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return load.call(this,name,...args)};
assert.equal(process.env.R08_INVITATION_SYNTH_OPT_IN,'1');
const root=require('../dist/src/finance/legacy-invitation-facts.js');
const writer=require('../dist/src/finance/legacy-invitation-facts-maintenance.js');
const {legacyOwnerUserId}=require('../dist/src/supply/legacy-user-migration.js');
const {canonicalize}=require('../dist/src/supply/content-hash.js');
const hash=root.invitationFactHash,sha=value=>createHash('sha256').update(value).digest('hex');
const db='zzsh_test_r08_invitation',marker='zzsh:r08-invitation-synthetic:v1';
const admin=new Pool({host:'127.0.0.1',port:55432,database:db,user:'postgres',max:1});
const runtime=new Pool({host:'127.0.0.1',port:55432,database:db,user:'r08_migration',max:1});
const actor={userId:'synthetic-boss',sessionId:'synthetic-session',requestId:'synthetic-request'};
const raw=(id,parent)=>({legacyId:id,userId:legacyOwnerUserId('legacy_mysql_restore','la_user',id),identitySourceDigest:'a'.repeat(64),
  userSource:{id,is_delete:'0',is_disable:'0',inviter_id:parent,first_leader:parent,second_leader:'0',third_leader:'0',create_time:'1',update_time:'2'},
  codeSource:{id,code:'fx'+id},qualificationSource:{id,user_id:id,level_id:'7',is_delete:'0',is_freeze:'0',is_distribution:'1'}});
const facts=[raw('1','0'),raw('2','1'),raw('3','2'),raw('4','99'),raw('5','4')];
const byId=new Map(facts.map(x=>[x.legacyId,x])),ids=[...byId.keys()].sort();
const source={schema:'legacy-invitation-source.v2',sourceSystem:'legacy_mysql_restore',cutoff:'2026-09-13T13:31:13.000Z',
  receiptSha256:'a'.repeat(64),supplementReceiptSha256:'a'.repeat(64),files:{users:{sha256:'c'.repeat(64),rows:facts.length},
  qualification:{sha256:'d'.repeat(64),rows:facts.length},codes:{sha256:'c'.repeat(64),rows:facts.length}},subjectSetDigest:hash(ids),
  codeSetDigest:hash(ids.map(id=>[id,byId.get(id).codeSource.code.toUpperCase(),hash(byId.get(id).codeSource)]))};
const planned=root.planLegacyInvitationFacts(source,facts,null,2);

async function setup(c){
  const actual=(await c.query(`SELECT d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,
    shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(actual,{oid:process.env.R08_INVITATION_SYNTH_OID,owner:'r08_owner',marker,system_id:process.env.R08_INVITATION_SYNTH_SYSTEM_ID});
  assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN('zzsh_order','zzsh_supply','zzsh_iam','zzsh_auth_admin','zzsh_auth_user')")).rows[0].n,0);
  await c.query('BEGIN');
  for(const schema of ['zzsh_order','zzsh_supply','zzsh_iam','zzsh_auth_admin','zzsh_auth_user'])await c.query(`CREATE SCHEMA ${schema} AUTHORIZATION r08_migration`);
  await c.query('SET LOCAL ROLE r08_migration');
  await c.query(`CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY);
    CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY,"twoFactorEnabled" boolean NOT NULL,suspended boolean NOT NULL);
    CREATE TABLE zzsh_auth_admin.session(id text PRIMARY KEY,"userId" text NOT NULL,locked boolean NOT NULL,"expiresAt" timestamptz NOT NULL);
    CREATE TABLE zzsh_iam.admin_security(admin_user_id text PRIMARY KEY,status text NOT NULL,is_boss boolean NOT NULL,password_change_required boolean NOT NULL);
    CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text NOT NULL,object_type text,
      object_id text,outcome text NOT NULL,request_id text,reason text,occurred_at timestamptz,details jsonb NOT NULL);
    CREATE TABLE zzsh_supply.idempotency_record(scope_key text NOT NULL,key text NOT NULL,request_fingerprint text NOT NULL,response_status integer NOT NULL,
      response_body jsonb NOT NULL,publish_required boolean NOT NULL,PRIMARY KEY(scope_key,key));
    CREATE TABLE zzsh_order.distribution_participant(user_id text PRIMARY KEY,eligibility text,commission_frozen boolean,level_code text,policy_version_id text,
      revision bigint NOT NULL,inviter_knowledge text,leader_knowledge text,invitees_knowledge text,source_type text,source_ref text,source_digest text);
    CREATE TABLE zzsh_order.distribution_invite_code(id text PRIMARY KEY,user_id text UNIQUE,display_code text,
      match_code text GENERATED ALWAYS AS (upper(display_code)) STORED,source_type text,source_system text,source_entity text,source_id text,source_digest text);
    CREATE TABLE zzsh_order.invitation_relation(id text PRIMARY KEY,type text,child_user_id text,parent_user_id text,policy_version_id text,
      source_type text,source_ref text,source_digest text,UNIQUE(type,child_user_id));
    CREATE FUNCTION zzsh_order.distribution_policy_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2'`);
  await c.query(`INSERT INTO zzsh_auth_admin."user" VALUES($1,true,false)`,[actor.userId]);
  await c.query(`INSERT INTO zzsh_auth_admin.session VALUES($1,$2,false,clock_timestamp()+interval '2 hours')`,[actor.sessionId,actor.userId]);
  await c.query(`INSERT INTO zzsh_iam.admin_security VALUES($1,'ACTIVE',true,false)`,[actor.userId]);
  for(const f of facts){
    await c.query('INSERT INTO zzsh_auth_user."user" VALUES($1)',[f.userId]);
    await c.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,action,object_type,object_id,outcome,occurred_at,details)
      VALUES($1,'system','user.legacy_owner.migrated','user',$2,'SUCCESS',now(),$3::jsonb)`,['identity-'+f.legacyId,f.userId,
      JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId:f.legacyId,sourceDigest:f.identitySourceDigest})]);
  }
  await c.query('COMMIT');
  const role=(await c.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='r08_migration'")).rows[0].oid;
  const owner=(await c.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='r08_owner'")).rows[0].oid;
  return {host:'127.0.0.1',port:55432,database:db,oid:Number(actual.oid),owner:'r08_owner',ownerOid:owner,marker,role:'r08_migration',roleOid:role};
}

(async()=>{
  const setupClient=await admin.connect();let c,setupReleased=false;
  try{
    const resource=await setup(setupClient);setupClient.release();setupReleased=true;
    c=await runtime.connect();
    const binding={ref:'R08_SYNTHETIC',attempt:'synthetic-once',actor:{userId:actor.userId,sessionId:actor.sessionId},resource,
      notBefore:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
    const review=(packet,phase)=>({...binding,sourceDigest:hash(packet.source),bodyDigest:hash(packet),phase});
    const execute=async(packet,phase)=>{
      await c.query('BEGIN');try{const scope=await writer.bindReviewedLegacyInvitationFacts(c,actor,review(packet,phase));
        const result=phase==='IMPORT'?await writer.importReviewedLegacyInvitationFacts(c,actor,packet,hash(packet),scope):await writer.closeReviewedLegacyInvitationCounts(c,actor,packet,hash(packet),scope);
        await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}
    };
    const premature=planned.packets.findIndex(packet=>packet.subjects.some(f=>f.legacyId==='2'));
    assert(premature>=0 && premature<planned.packets.length-1);
    for(const packet of planned.packets.slice(0,premature+1))await execute(packet,'IMPORT');
    await assert.rejects(execute(planned.packets[premature],'COUNTS'));
    assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed'")).rows[0].n,0);
    const {applyInvitationDomains}=await import('../../../scripts/migration/local-target-finance.mjs');
    const {preflightInvitationFile,readBoundInvitationPackets}=await import('../../../scripts/migration/local-round-contract.mjs');
    const packets=planned.packets.map(packet=>{const p=root.prepareLegacyInvitationFacts(packet,hash(packet));return {input:packet,bodyDigest:hash(packet),key:p.key,relations:p.relations.length}});
    const manifest={population:{mode:'SELECTED_BUSINESS_SCOPE'},sourceReceiptSha256:source.receiptSha256,domains:{users:{source:5,ready:5,isolated:0}},
      invitationFacts:{subjects:5,codes:5,selectedSubjects:5,packets:packets.length,selectedPackets:packets.length,policy:null,financialEffects:false},files:{'invitation-facts':{rows:packets.length}}};
    const dir=mkdtempSync(join(tmpdir(),'r08-invitation-stream-')),file=join(dir,'packets.jsonl'),bytes=Buffer.from(packets.map(p=>JSON.stringify(p)).join('\n')+'\n'),fileHash=sha(bytes);
    writeFileSync(file,bytes);const packetHashes=await preflightInvitationFile(file,fileHash,manifest,root);
    const state={resource:{owner_oid:resource.ownerOid},phases:{}};
    const ctx={client:c,actor,manifest,state,invitationSource:()=>readBoundInvitationPackets(file,fileHash,packetHashes),invitationPacketCount:packetHashes.length,mod:()=>writer,
      async runItems(domain,items,fn){const phase=state.phases[domain]??={nextIndex:0,created:0,replayed:0,quarantined:0};
        let index=0;for await(const item of items){if(index++<phase.nextIndex)continue;await c.query('BEGIN');try{const result=await fn(item);await c.query('COMMIT');phase.nextIndex++;if(result.replayed)phase.replayed++;else phase.created++;}catch(e){await c.query('ROLLBACK');throw e;}}
        phase.complete=true;}};
    const changed=structuredClone(packets);changed[1].input.subjects[0].userId='synthetic-tampered';writeFileSync(file,changed.map(p=>JSON.stringify(p)).join('\n')+'\n');
    await assert.rejects(()=>applyInvitationDomains(ctx,binding,resource,canonicalize),/INVITATION_PACKET_CHANGED/);
    assert.equal(state.phases.invitationFacts.nextIndex,1);assert.notEqual(state.phases.invitationFacts.complete,true);assert.equal(state.phases.invitationCounts,undefined);
    writeFileSync(file,bytes);
    await applyInvitationDomains(ctx,binding,resource,canonicalize);
    assert.equal(state.phases.invitationFacts.replayed,premature+1);assert.equal(state.phases.invitationCounts.nextIndex,packets.length);
    const participants=(await c.query('SELECT user_id,invitees_knowledge FROM zzsh_order.distribution_participant')).rows;
    for(const packet of planned.packets)for(const fact of packet.subjects){
      const expected=['INVITER','DISTRIBUTION_LEADER'].every(t=>fact.children[t].sourceCount===fact.children[t].knownCount)?'KNOWN':'UNKNOWN';
      assert.equal(participants.find(x=>x.user_id===fact.userId)?.invitees_knowledge,expected);
    }
    assert.equal(participants.find(x=>x.user_id===byId.get('4').userId).invitees_knowledge,'UNKNOWN');
    const replay=await execute(planned.packets[0],'COUNTS');assert.equal(replay.replayed,true);
    assert.equal((await c.query("SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed'")).rows[0].n,packets.length);
    await c.query('BEGIN');try{
      const candidate=(await c.query("SELECT id FROM zzsh_order.invitation_relation LIMIT 1")).rows[0].id;
      await c.query("UPDATE zzsh_order.invitation_relation SET source_digest=$1 WHERE id=$2",['f'.repeat(64),candidate]);
      let detected=false;for(const packet of planned.packets){try{const scope=await writer.bindReviewedLegacyInvitationFacts(c,actor,review(packet,'COUNTS'),'recover');
        await writer.recoverReviewedLegacyInvitationFacts(c,actor,packet,hash(packet),scope,'COUNTS');}catch{detected=true;break;}}
      assert.equal(detected,true,'changed relation digest must prevent a known recovery');
    }finally{await c.query('ROLLBACK');}
    rmSync(dir,{recursive:true});
    console.log(JSON.stringify({status:'SYNTHETIC_PG_COUNTS_PASSED',subjects:facts.length,packets:packets.length,importReplayed:state.phases.invitationFacts.replayed,
      prematureClosure:'REJECTED',unresolvedSource:'UNKNOWN',sameKeyReplay:'PASSED',tamperedRelation:'REJECTED',changedPacket:'STOPPED_WITH_ORIGINAL_CHECKPOINT',realProviderCalls:0}));
  }finally{if(c)c.release();if(!setupReleased)setupClient.release();await runtime.end();await admin.end();}
})().catch(e=>{console.error('SYNTHETIC_PG_COUNTS_FAILED',e.stack);process.exitCode=1});
