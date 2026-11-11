import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LISTED_API_MODULES,readListedCompiledProof,assertLegacyAutoPublicationPermitted,assertSameCapturePolicyMigration,isSameCaptureListedPolicy,sameCapturePolicyGuardDigest,validateLegacyListedExecutionPlan,validateListedExecutionCheckpoint,validateListedBatchReadbackSet,readUnexpectedListedTarget,readListedExecutionProof,readVerifiedLegacySkinIds} from './legacy-listed-execution-plan.mjs';
import {NEXT_MIGRATION_PROFILE} from './local-target-registry.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),canonical=x=>JSON.stringify(x);
function fixture(){
 const sourceCanonical='{"id":"1"}',policyCanonical='{"evidence":"fixture"}',sourceDigest=sha(sourceCanonical),proofSha256=sha(policyCanonical),sourceReceiptSha256='a'.repeat(64);
 const authorityCanonical='{"synthetic":"test-only"}',policyAuthoritySha256=sha(authorityCanonical);
 const intake={accountId:'account',isFullPayout:'1',source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',legacyId:'1',sourceDigest},legacyQuoteEvidence:{sourceCanonical,policyCanonical,policyBinding:{proofSha256,sourceReceiptSha256,sourceId:'1',sourceDigest,expectedAccountCount:1,authorityCanonical,authoritySha256:policyAuthoritySha256}}};
 return {schema:'zzsh.legacy-listed-execution-plan.v2',target:{oid:'1'},compiled:{api:'hash'},sourceAccountCount:1,policyBundleSha256:proofSha256,sourceReceiptSha256,policyAuthoritySha256,
  rows:[{sourceId:'1',body:{intake},scope:'scope',key:'key',fingerprint:'fingerprint',sourceQuoteDigest:'b'.repeat(64),policyDigest:'c'.repeat(64)}]};
}
const binding=()=>({scope:'scope',key:'key',fingerprint:'fingerprint'}),check=x=>validateLegacyListedExecutionPlan(x,{oid:'1'},{api:'hash'},canonical,binding);
test('next migration cannot auto-publish old listings; the new gate does not block older profiles',()=>{
 assert.throws(()=>assertLegacyAutoPublicationPermitted({migrationProfile:NEXT_MIGRATION_PROFILE}),/OWNER_CONFIRMATION_REQUIRED/);
 assert.doesNotThrow(()=>assertLegacyAutoPublicationPermitted({migrationProfile:null}));
});
test('all-batch readback defaults to a zero-connection plan and refuses incomplete arguments',()=>{
 const script=fileURLToPath(new URL('./readback-listed-batches.mjs',import.meta.url));
 const plan=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000});assert.equal(plan.status,0,plan.stderr);
 assert.deepEqual([JSON.parse(plan.stdout).status,JSON.parse(plan.stdout).connections,JSON.parse(plan.stdout).targetWrites],['PLAN_ONLY',0,0]);
 const incomplete=spawnSync(process.execPath,[script,'--readback'],{encoding:'utf8',timeout:5000});assert.notEqual(incomplete.status,0);assert.match(incomplete.stderr,/LISTED_ALL_ARGUMENTS_INVALID/);
 const invalidValidation=spawnSync(process.execPath,[script,'--validate'],{encoding:'utf8',timeout:5000});assert.notEqual(invalidValidation.status,0);assert.match(invalidValidation.stderr,/LISTED_ALL_ARGUMENTS_INVALID/);
});
test('execution and complete readback pin the same API modules, scripts and database guards',t=>{
 const root=mkdtempSync(join(tmpdir(),'listed-compiled-proof-')),api=join(root,'api'),dist=join(api,'dist','src'),migrations=join(api,'migrations','business');
 const files=LISTED_API_MODULES.map(name=>join(dist,name+'.js')).concat([join(migrations,'0156_legacy_listed_quote.sql'),join(migrations,'0194_legacy_listed_policy_same_capture.sql'),join(migrations,'meta','_journal.json')]);
 t.after(()=>{for(const file of files)if(existsSync(file)){assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());unlinkSync(file)}
  for(const dir of ['auth','database','order','supply','credit'])if(existsSync(join(dist,dir)))rmdirSync(join(dist,dir));
  for(const dir of [join(dist),join(api,'dist'),join(migrations,'meta'),migrations,join(api,'migrations'),api,root])if(existsSync(dir))rmdirSync(dir);
 });
 for(const name of LISTED_API_MODULES){const file=join(dist,name+'.js');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,name)}
 mkdirSync(join(migrations,'meta'),{recursive:true});writeFileSync(join(migrations,'0156_legacy_listed_quote.sql'),'base');
 const guard='CREATE OR REPLACE FUNCTION zzsh_supply.guard_legacy_listed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN RETURN NEW; END\n$$;';
 writeFileSync(join(migrations,'0194_legacy_listed_policy_same_capture.sql'),guard);
 const journal={entries:[{tag:'0156_legacy_listed_quote',when:1},{tag:'0194_legacy_listed_policy_same_capture',when:2}]};writeFileSync(join(migrations,'meta','_journal.json'),JSON.stringify(journal));
 const proof=readListedCompiledProof(dist,{roundBound:true,sameCapture:true});
 assert.equal(proof.compiled['supply/legacy-listed-policy'],sha('supply/legacy-listed-policy'));assert.equal(proof.compiled.sameCaptureGuard,sameCapturePolicyGuardDigest(guard));
 assert.match(proof.compiled.roundSourceVerifier,/^[a-f0-9]{64}$/);assert.equal(proof.sameCaptureMigrationEntry.when,2);
 assert.equal(Object.hasOwn(readListedCompiledProof(dist,{roundBound:false,sameCapture:false}).compiled,'sameCaptureMigration'),false);
 journal.entries.pop();writeFileSync(join(migrations,'meta','_journal.json'),JSON.stringify(journal));
 assert.throws(()=>readListedCompiledProof(dist,{roundBound:true,sameCapture:true}),/LISTED_SAME_CAPTURE_MIGRATION_JOURNAL_INVALID/);
});
test('same-capture evidence requires an installed matching guard before execution',async()=>{
 assert.equal(isSameCaptureListedPolicy('{"schema":"legacy-listed-policy-evidence-v1"}'),false);
 assert.equal(isSameCaptureListedPolicy('{"schema":"legacy-listed-policy-evidence-v2"}'),true);
 for(const invalid of ['null','{}','not-json',undefined])assert.throws(()=>isSameCaptureListedPolicy(invalid),/SOURCE_POLICY_EVIDENCE_INVALID/);
 const sql='CREATE OR REPLACE FUNCTION zzsh_supply.guard_legacy_listed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN RETURN NEW; END\n$$;';
 const guard=sameCapturePolicyGuardDigest(sql);assert.equal(guard,sameCapturePolicyGuardDigest(sql.replaceAll('\n','\r\n')));
 assert.throws(()=>sameCapturePolicyGuardDigest('not a migration'),/LISTED_SAME_CAPTURE_MIGRATION_INVALID/);
 let calls=0;const client={async query(_sql,args){calls++;assert.deepEqual(args,['a'.repeat(64),'123',guard]);return {rows:[{ready:true}]};}};
 await assertSameCapturePolicyMigration(client,'a'.repeat(64),123,guard);assert.equal(calls,1);
 await assert.rejects(assertSameCapturePolicyMigration(client,'bad',123,guard),/LISTED_SAME_CAPTURE_MIGRATION_NOT_READY/);assert.equal(calls,1);
 await assert.rejects(assertSameCapturePolicyMigration({query:async()=>({rows:[{ready:false}]})},'a'.repeat(64),123,guard),/LISTED_SAME_CAPTURE_MIGRATION_NOT_READY/);
});
test('takeover distinguishes an admitted empty skin set from missing or withheld holdings',async()=>{
 const client={},read=holding=>async(...args)=>{assert.deepEqual(args,[client,'account','observation','game','LEGACY_OBSERVATION']);return holding;};
 const run=holding=>readVerifiedLegacySkinIds(client,'account','observation','game',read(holding));
 assert.deepEqual(await run({state:'ADMITTED',admittedCount:0,withheldCount:0,items:[]}),{skinIds:[]});
 assert.deepEqual(await run({state:'ADMITTED',admittedCount:2,withheldCount:0,items:[{id:'skin-1'},{id:'skin-2'}]}),{skinIds:['skin-1','skin-2']});
 for(const holding of [undefined,{state:'UNKNOWN',admittedCount:null,items:null,withheldCount:null},
  {state:'ADMITTED',admittedCount:1,withheldCount:0,items:[]},{state:'ADMITTED',admittedCount:2,withheldCount:0,items:[{id:'skin-1'},{id:'skin-1'}]}])
   assert.deepEqual(await run(holding),{blocked:'SOURCE_SKIN_HOLDING_UNPROVEN'});
 assert.deepEqual(await run({state:'ADMITTED',admittedCount:2,withheldCount:1,items:[{id:'skin-1'}]}),{blocked:'CURRENT_SKIN_CATALOG_REVIEW_REQUIRED'});
 await assert.rejects(readVerifiedLegacySkinIds(client,'account','observation','game',async()=>{throw Error('database unavailable');}),/database unavailable/);
});
test('actual legacy skin reader distinguishes absent and empty holdings in synthetic PostgreSQL', {skip:!process.env.ZZSH_SYNTH_LISTED_SKIN_PORT},async()=>{
 const port=process.env.ZZSH_SYNTH_LISTED_SKIN_PORT,system=process.env.ZZSH_SYNTH_LISTED_SKIN_SYSTEM;
 assert.match(port??'',/^[1-9][0-9]{3,4}$/);assert.match(system??'',/^[0-9]+$/);
 const require=createRequire(import.meta.url),{Client}=require('pg');
 const {readLegacySkinHolding}=require('../../apps/api/dist/src/supply/legacy-listing-read.js');
 const client=new Client({host:'127.0.0.1',port:Number(port),database:'zzsh_synth_listed_skin',user:'postgres',connectionTimeoutMillis:3000});
 await client.connect();let transaction=false;
 try{
  const identity=(await client.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
    (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
  assert.deepEqual(identity,{database:'zzsh_synth_listed_skin',system,marker:'zzsh:synthetic:listed-skin-v1',schemas:0});
  await client.query('BEGIN');transaction=true;
  await client.query(`CREATE SCHEMA zzsh_supply;
    CREATE TABLE zzsh_supply.rental_account(id text,game_id text);
    CREATE TABLE zzsh_supply.listing_version(id text,account_id text,origin text);
    CREATE TABLE zzsh_supply.legacy_supply_map(account_id text,version_id text,source_system text,source_entity text,legacy_id text,source_digest text);
    CREATE TABLE zzsh_supply.legacy_skin_holding(account_id text,observation_version_id text,source_system text,source_entity text,legacy_id text,source_digest text,skin_ids text[]);
    CREATE TABLE zzsh_supply.listing_skin(version_id text,skin_id text);
    CREATE TABLE zzsh_supply.skin(id text,name text,base_name text,owner_kind text,rarity_code text,rarity_evidence jsonb,is_collectible boolean,default_state text,media_source jsonb,media_id text,game_id text,enabled boolean,form_visible boolean,sort_order integer,firearm_id text,owner_id text);
    CREATE TABLE zzsh_supply.firearm(id text,game_id text,name text);
    CREATE TABLE zzsh_supply.skin_owner(id text,game_id text,kind text,name text);
    CREATE TABLE zzsh_supply.skin_rarity(game_id text,code text,name text);
    CREATE TABLE zzsh_supply.media_asset(id text,game_id text,ownership_kind text,purpose text,review_state text,access_class text,public_storage_key text);
    INSERT INTO zzsh_supply.rental_account VALUES ('account','game');
    INSERT INTO zzsh_supply.listing_version VALUES ('observation','account','LEGACY_OBSERVATION');
    INSERT INTO zzsh_supply.legacy_supply_map VALUES ('account','observation','legacy_mysql_restore','la_rental_accounts','1','source');`);
  const read=()=>readVerifiedLegacySkinIds(client,'account','observation','game',readLegacySkinHolding);
  assert.deepEqual(await read(),{blocked:'SOURCE_SKIN_HOLDING_UNPROVEN'});
  await client.query("INSERT INTO zzsh_supply.legacy_skin_holding VALUES ('account','observation','legacy_mysql_restore','la_rental_accounts','1','source',ARRAY[]::text[])");
  assert.deepEqual(await read(),{skinIds:[]});
  await client.query(`INSERT INTO zzsh_supply.skin(id,name,game_id,enabled,form_visible,sort_order) VALUES
    ('skin-1','fixture one','game',true,true,1),('skin-2','fixture two','game',false,true,2)`);
  await client.query("UPDATE zzsh_supply.legacy_skin_holding SET skin_ids=ARRAY['skin-1']");
  assert.deepEqual(await read(),{skinIds:['skin-1']});
  await client.query("UPDATE zzsh_supply.legacy_skin_holding SET skin_ids=ARRAY['skin-1','skin-2']");
  assert.deepEqual(await read(),{blocked:'CURRENT_SKIN_CATALOG_REVIEW_REQUIRED'});
  await client.query("UPDATE zzsh_supply.legacy_skin_holding SET skin_ids=ARRAY['skin-missing']");
  assert.deepEqual(await read(),{blocked:'CURRENT_SKIN_CATALOG_REVIEW_REQUIRED'});
  await client.query("UPDATE zzsh_supply.legacy_skin_holding SET source_digest='other'");
  assert.deepEqual(await read(),{blocked:'SOURCE_SKIN_HOLDING_UNPROVEN'});
 }finally{
  if(transaction)assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');
  await client.end();
 }
});
test('complete source-bound full-payout batch passes and partial, duplicate or changed evidence stops before execution',()=>{
 const x=fixture();assert.equal(check(x).length,1);
 for(const mutate of [p=>{p.rows[0].blocked='BLOCKED';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.sourceCanonical='{}';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.policyCanonical='{}';},p=>{p.rows[0].body.intake.legacyQuoteEvidence.policyBinding.sourceId='2';},p=>{p.rows[0].body.intake.isFullPayout='2';},p=>{p.rows[0].key='changed';},p=>{p.sourceAccountCount=2;},p=>{p.rows.push(structuredClone(p.rows[0]));p.sourceAccountCount=2;}]){const changed=structuredClone(x);mutate(changed);assert.throws(()=>check(changed));}
});
test('next-round listed plan and checkpoint require target fence cleanup evidence',()=>{
 const plan=fixture(),target={...plan.target,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};plan.target=target;
 assert.throws(()=>validateLegacyListedExecutionPlan(plan,target,{api:'hash'},canonical,binding),/EXECUTION_PLAN_BINDING_CHANGED/);
 Object.assign(plan,{targetFence:'HELD_DURING_OPERATION',targetFenceReleased:true});
 assert.equal(validateLegacyListedExecutionPlan(plan,target,{api:'hash'},canonical,binding).length,1);
 const committed=committedFixture();committed.plan.target=target;committed.checkpoint.target=target;
 assert.throws(()=>validateListedExecutionCheckpoint(committed.checkpoint,'a'.repeat(64),target,committed.plan.rows,canonical),/LISTED_EXECUTION_CHECKPOINT_INCOMPLETE/);
 Object.assign(committed.checkpoint,{targetFence:'HELD_DURING_OPERATION',targetFenceReleased:true});
 assert.equal(validateListedExecutionCheckpoint(committed.checkpoint,'a'.repeat(64),target,committed.plan.rows,canonical).length,1);
});

function committedFixture(){
 const plan=fixture(),row=plan.rows[0];row.releaseId='release';
 Object.assign(row.body.intake.source,{expectedObservationVersionId:'observation',expectedOwnerUserId:'owner',expectedGameId:'game'});
 const publication={accountId:'account',versionId:'version',releaseId:'release',contentHash:'d'.repeat(64),state:'PUBLISHED'};
 const checkpoint={inputSha:'a'.repeat(64),target:plan.target,pending:null,completed:[{sourceId:'1',replayed:false,publication}]};
 const fact={sourceId:'1',sourceMatches:true,currentAccountMatches:true,versionMatches:true,publicationMatches:true,quoteMatches:true,
  requestFingerprint:'fingerprint',responseStatus:200,responseBody:publication};
 return {plan,row,publication,checkpoint,fact};
}
function multiBatchFixture(){
 const target={oid:'1'},compiled={api:'hash'},manifestSha256='f'.repeat(64),roundInputSha256='e'.repeat(64),sourceBindingSha256='d'.repeat(64),sourceReceiptSha256='a'.repeat(64);
 const policies=[],batches=[];
 for(const id of ['1','2']){
  const plan=fixture(),row=plan.rows[0],sourceCanonical=canonical({id}),sourceDigest=sha(sourceCanonical),policy={supplement:{accountSourceDigests:[{id,sha256:sourceDigest}]}};
  const evidence=row.body.intake.legacyQuoteEvidence,source=row.body.intake.source;source.legacyId=id;source.sourceDigest=sourceDigest;
  source.expectedObservationVersionId=`observation-${id}`;source.expectedOwnerUserId=`owner-${id}`;source.expectedGameId='game';
  row.sourceId=id;row.releaseId='release';row.body.intake.accountId=`account-${id}`;row.scope=`scope-${id}`;row.key=`key-${id}`;row.fingerprint=`fingerprint-${id}`;
  evidence.sourceCanonical=sourceCanonical;evidence.policyCanonical=canonical(policy);evidence.policyBinding.proofSha256=sha(evidence.policyCanonical);
  evidence.policyBinding.sourceId=id;evidence.policyBinding.sourceDigest=sourceDigest;
  const auditSha256=sha(`audit-${id}`),sourcePlanSha256=sha(`source-plan-${id}`),executionPlanSha256=sha(`execution-plan-${id}`),checkpointSha256=sha(`checkpoint-${id}`);
  const roundBinding={roundInputSha256,sourceBindingSha256,scopeAuditSha256:auditSha256,batch:{index:Number(id),manifestSha256}};
  const sourcePlan={schema:'zzsh.listed-source-continuity-plan.v2',roundBinding,listings:[{sourceId:id,sourceDigest}]};
  Object.assign(plan,{sourcePlanSha256,sourceReceiptSha256,policyBundleSha256:sha(evidence.policyCanonical),roundBinding});
  const audit={accounts:[{sourceId:id,sourceDigest}],batchManifestSha256:manifestSha256,batchIndex:Number(id),batchAccountSetSha256:sha(canonical(policy.supplement.accountSourceDigests))};
  const publication={accountId:`account-${id}`,versionId:`version-${id}`,releaseId:'release',contentHash:'d'.repeat(64),state:'PUBLISHED'};
  const checkpoint={inputSha:executionPlanSha256,target,pending:null,completed:[{sourceId:id,replayed:false,publication}]};
  const trial={inputSha:executionPlanSha256,target,results:[{sourceId:id,state:'READY'}],rollbackAcknowledged:1};
  const readback={schema:'zzsh.legacy-listed-batch-readback.v1',status:'LISTED_BATCH_READBACK_PASS',inputSha:executionPlanSha256,checkpointSha:checkpointSha256,target,rollbackConfirmed:true,targetWrites:0,expected:1,committed:1,rentable:1,differences:[]};
  policies.push(policy);batches.push({sourcePlan,sourcePlanSha256,audit,auditSha256,executionPlan:plan,executionPlanSha256,trial,checkpoint,checkpointSha256,readback});
 }
 const rows=policies.flatMap(policy=>policy.supplement.accountSourceDigests),manifest={schema:'zzsh.listed-same-capture-batches.v1',sourceReceiptSha256,sourceBindingSha256,listedAccounts:rows.length,accountSetSha256:sha(canonical(rows)),batches:policies.map((policy,index)=>({index:index+1,count:1,accountSetSha256:sha(canonical(policy.supplement.accountSourceDigests)),policyCanonicalSha256:sha(canonical(policy))}))};
 return {manifest,manifestSha256,roundInputSha256,policies,batches,target,compiled,canonicalize:canonical,binding:body=>({scope:`scope-${body.intake.source.legacyId}`,key:`key-${body.intake.source.legacyId}`,fingerprint:`fingerprint-${body.intake.source.legacyId}`})};
}
test('all listed batches require source coverage, trial, committed checkpoint and independent readback',()=>{
 const x=multiBatchFixture();assert.equal(validateListedBatchReadbackSet(x).length,2);
 for(const mutate of [
  x=>x.batches.pop(),x=>x.policies.pop(),x=>x.manifest.listedAccounts=1,x=>x.manifest.accountSetSha256='0'.repeat(64),
  x=>x.batches[0].sourcePlan.roundBinding.batch.index=2,x=>x.batches[1].sourcePlan.roundBinding.roundInputSha256='0'.repeat(64),
  x=>x.batches[0].executionPlan.sourcePlanSha256='0'.repeat(64),x=>x.batches[0].audit.accounts[0].sourceId='wrong',
  x=>x.batches[0].trial.rollbackAcknowledged=0,x=>x.batches[1].checkpoint.pending={key:'unknown'},
  x=>x.batches[1].readback.status='LISTED_BATCH_READBACK_REVIEW_REQUIRED',x=>x.batches[1].readback.rentable=0,
  x=>x.batches[1].readback.checkpointSha='0'.repeat(64),x=>x.batches[1].readback.target={oid:'other'},
 ]){const changed=multiBatchFixture();mutate(changed);assert.throws(()=>validateListedBatchReadbackSet(changed));}
});
test('full target readback rejects unexpected source observations or publications',async()=>{
 const entries=[{row:{sourceId:'1'}},{row:{sourceId:'2'}}],client=row=>({query:async(sql,params)=>{
  assert.match(sql,/legacy_listing_read_snapshot/);assert.match(sql,/listing_publication/);assert.deepEqual(params,[['1','2']]);return {rows:[row]};
 }});
 assert.equal((await readUnexpectedListedTarget(client({observations:'0',publications:'0'}),entries)).status,'NO_UNEXPECTED_LISTED_FACTS');
 assert.equal((await readUnexpectedListedTarget(client({observations:'1',publications:'0'}),entries)).status,'UNEXPECTED_LISTED_FACTS_REVIEW_REQUIRED');
 assert.equal((await readUnexpectedListedTarget(client({observations:'0',publications:'1'}),entries)).status,'UNEXPECTED_LISTED_FACTS_REVIEW_REQUIRED');
 await assert.rejects(readUnexpectedListedTarget(client({observations:null,publications:'0'}),entries),/LISTED_ALL_TARGET_UNAVAILABLE/);
 await assert.rejects(readUnexpectedListedTarget(client({observations:'0',publications:'0'}),[entries[0],entries[0]]),/LISTED_ALL_SOURCE_SET_INVALID/);
});
test('readback accepts only a complete checkpoint for the same plan and target',()=>{
 const {plan,checkpoint}=committedFixture(),verify=value=>validateListedExecutionCheckpoint(value,'a'.repeat(64),plan.target,plan.rows,canonical);
 assert.equal(verify(checkpoint).length,1);
 for(const mutate of [x=>{x.pending={key:'unconfirmed'};},x=>{delete x.pending;},x=>{x.inputSha='b'.repeat(64);},
  x=>{x.target.oid='2';},x=>{x.completed=[];},x=>{x.completed[0].sourceId='2';},x=>{x.completed[0].replayed='false';},
  x=>{x.completed[0].publication.accountId='other';},x=>{x.completed[0].publication.state='OWNER_ACCEPTANCE_REQUIRED';},
  x=>{x.completed[0].publication.releaseId='other';},x=>{x.completed[0].publication.contentHash='bad';}]){
  const changed=structuredClone(checkpoint);mutate(changed);assert.throws(()=>verify(changed),/LISTED_EXECUTION_CHECKPOINT_INCOMPLETE/);
 }
});
test('readback checks published facts, original receipt and current public rental separately',async()=>{
 const {plan,publication,checkpoint,fact}=committedFixture();
 const entries=validateListedExecutionCheckpoint(checkpoint,'a'.repeat(64),plan.target,plan.rows,canonical);
 const gate=()=>{},readPublishingAccount=async(_client,id)=>({id});
 const goodListing=async(_client,account,viewer,actualGate,quoteViewer,publicAccount,strict,mode)=>{
  assert.equal(account.id,'account');assert.equal(viewer,'public');assert.equal(actualGate,gate);assert.equal(quoteViewer,'public');
  assert.equal(publicAccount,account);assert.equal(strict,true);assert.equal(mode,'RENTABLE');
  return {id:'account',versionId:publication.versionId,releaseId:publication.releaseId,availability:{state:'RENTABLE'},canCreateOrder:true};
 };
 const clientFor=records=>({async query(sql,[payload]){
  assert.match(sql,/jsonb_to_recordset/);assert.match(sql,/LEFT JOIN zzsh_supply\.idempotency_record/);
  const requested=JSON.parse(payload);assert.equal(requested.length,1);assert.equal(requested[0].source_id,'1');
  assert.equal(requested[0].quote_digest,'b'.repeat(64));return {rows:records};
 }});
 const run=(records,listingDetail=goodListing)=>readListedExecutionProof(clientFor(records),entries,{readPublishingAccount,listingDetail,gate});
 assert.deepEqual(await run([fact]),{status:'LISTED_BATCH_READBACK_PASS',expected:1,committed:1,rentable:1,differences:[]});
 for(const mutate of [x=>{x.sourceMatches=false;},x=>{x.currentAccountMatches=null;},x=>{x.versionMatches=false;},
  x=>{x.publicationMatches=false;},x=>{x.quoteMatches=false;},x=>{x.requestFingerprint='other';},
  x=>{x.responseStatus=409;},x=>{x.responseBody.versionId='other';},x=>{x.responseBody.unexpected=true;}]){
  const changed=structuredClone(fact);mutate(changed);const result=await run([changed]);
  assert.equal(result.status,'LISTED_BATCH_READBACK_REVIEW_REQUIRED');assert.equal(result.committed,0);assert.equal(result.rentable,0);
 }
 for(const listing of [async()=>{throw Object.assign(new Error('not found'),{status:404});},
  async()=>({id:'account',versionId:'version',releaseId:'release',availability:{state:'RENTABLE'},canCreateOrder:false}),
  async()=>({id:'account',versionId:'other',releaseId:'release',availability:{state:'RENTABLE'},canCreateOrder:true})]){
  const result=await run([fact],listing);assert.equal(result.committed,1);assert.equal(result.rentable,0);
  assert.equal(result.differences[0].reason,'PUBLIC_LISTING_NOT_RENTABLE');
 }
 await assert.rejects(run([fact],async()=>{throw Object.assign(new Error('unavailable'),{status:503});}),/unavailable/);
 await assert.rejects(run([fact,fact]),/LISTED_READBACK_FACT_SET_CHANGED/);
 await assert.rejects(run([]),/LISTED_READBACK_FACT_SET_CHANGED/);
});

test('readback query checks synthetic PostgreSQL publication and receipt facts', {skip:!process.env.ZZSH_SYNTH_LISTED_READBACK_PORT},async()=>{
 const port=process.env.ZZSH_SYNTH_LISTED_READBACK_PORT,system=process.env.ZZSH_SYNTH_LISTED_READBACK_SYSTEM;
 assert.match(port??'',/^[1-9][0-9]{3,4}$/);assert.match(system??'',/^[0-9]+$/);
 const {Client}=createRequire(import.meta.url)('pg'),client=new Client({host:'127.0.0.1',port:Number(port),
  database:'zzsh_synth_listed_readback',user:'postgres',connectionTimeoutMillis:3000});
 await client.connect();let inTransaction=false;
 try{
  const identity=(await client.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
   shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
   (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
  assert.deepEqual(identity,{database:'zzsh_synth_listed_readback',system,marker:'zzsh:synthetic:listed-readback-v1',schemas:0});
  await client.query('BEGIN');inTransaction=true;
  await client.query(`CREATE SCHEMA zzsh_supply;
   CREATE TABLE zzsh_supply.legacy_supply_map(source_system text,source_entity text,legacy_id text,account_id text,version_id text,source_digest text);
   CREATE TABLE zzsh_supply.rental_account(id text,current_version_id text,owner_user_id text,game_id text);
   CREATE TABLE zzsh_supply.listing_version(id text,account_id text,origin text,review_state text,rule_release_id text,content_hash text);
   CREATE TABLE zzsh_supply.listing_publication(version_id text,account_id text,source text,owner_user_id text,game_id text,rule_release_id text,content_hash text);
   CREATE TABLE zzsh_supply.legacy_listed_quote_evidence(listing_version_id text,account_id text,quote_digest text,policy_digest text);
   CREATE TABLE zzsh_supply.idempotency_record(scope_key text,key text,request_fingerprint text,response_status integer,response_body jsonb);
   CREATE TABLE zzsh_supply.legacy_listing_read_snapshot(source_system text,source_entity text,legacy_id text,source_status integer);
   CREATE ROLE zzsh_synth_listed_reader NOLOGIN;GRANT USAGE ON SCHEMA zzsh_supply TO zzsh_synth_listed_reader;
   GRANT SELECT ON ALL TABLES IN SCHEMA zzsh_supply TO zzsh_synth_listed_reader;`);
  const {plan,publication,checkpoint}=committedFixture(),row=plan.rows[0],source=row.body.intake.source;
  await client.query("INSERT INTO zzsh_supply.legacy_supply_map VALUES ('legacy_mysql_restore','la_rental_accounts','1','account','observation',$1)",[source.sourceDigest]);
  await client.query("INSERT INTO zzsh_supply.rental_account VALUES ('account','version','owner','game')");
  await client.query("INSERT INTO zzsh_supply.listing_version VALUES ('version','account','NATIVE','APPROVED','release',$1)",[publication.contentHash]);
  await client.query("INSERT INTO zzsh_supply.listing_publication VALUES ('version','account','LEGACY_APPROVED','owner','game','release',$1)",[publication.contentHash]);
  await client.query("INSERT INTO zzsh_supply.legacy_listed_quote_evidence VALUES ('version','account',$1,$2)",[row.sourceQuoteDigest,row.policyDigest]);
  await client.query("INSERT INTO zzsh_supply.idempotency_record VALUES ('scope','key','fingerprint',200,$1::jsonb)",[JSON.stringify(publication)]);
  await client.query("INSERT INTO zzsh_supply.legacy_listing_read_snapshot VALUES ('legacy_mysql_restore','la_rental_accounts','1',3)");
  const entries=validateListedExecutionCheckpoint(checkpoint,'a'.repeat(64),plan.target,plan.rows,canonical),gate=()=>{};
  const options={readPublishingAccount:async(_client,id)=>({id}),gate,
   listingDetail:async()=>({id:'account',versionId:'version',releaseId:'release',availability:{state:'RENTABLE'},canCreateOrder:true})};
  await client.query('SET LOCAL ROLE zzsh_synth_listed_reader');
  assert.equal((await readListedExecutionProof(client,entries,options)).status,'LISTED_BATCH_READBACK_PASS');
  assert.equal((await readUnexpectedListedTarget(client,entries)).status,'NO_UNEXPECTED_LISTED_FACTS');
  await client.query('RESET ROLE');await client.query("INSERT INTO zzsh_supply.legacy_listing_read_snapshot VALUES ('legacy_mysql_restore','la_rental_accounts','extra',3)");
  await client.query('SET LOCAL ROLE zzsh_synth_listed_reader');
  assert.equal((await readUnexpectedListedTarget(client,entries)).status,'UNEXPECTED_LISTED_FACTS_REVIEW_REQUIRED');
  await client.query('RESET ROLE');await client.query("DELETE FROM zzsh_supply.legacy_listing_read_snapshot WHERE legacy_id='extra'");
  await client.query("INSERT INTO zzsh_supply.legacy_supply_map VALUES ('legacy_mysql_restore','la_rental_accounts','extra','extra-account','observation','source')");
  await client.query("INSERT INTO zzsh_supply.listing_publication VALUES ('extra-version','extra-account','OWNER_DIRECT','owner','game','release',$1)",[publication.contentHash]);
  await client.query('SET LOCAL ROLE zzsh_synth_listed_reader');
  assert.equal((await readUnexpectedListedTarget(client,entries)).status,'UNEXPECTED_LISTED_FACTS_REVIEW_REQUIRED');
  await client.query('RESET ROLE');await client.query("UPDATE zzsh_supply.legacy_listed_quote_evidence SET quote_digest='changed'");
  await client.query('SET LOCAL ROLE zzsh_synth_listed_reader');
  const mismatch=await readListedExecutionProof(client,entries,options);
  assert.equal(mismatch.status,'LISTED_BATCH_READBACK_REVIEW_REQUIRED');assert.equal(mismatch.committed,0);
  await client.query('RESET ROLE');await client.query('DELETE FROM zzsh_supply.idempotency_record');
  await client.query('SET LOCAL ROLE zzsh_synth_listed_reader');
  assert.equal((await readListedExecutionProof(client,entries,options)).status,'LISTED_BATCH_READBACK_REVIEW_REQUIRED');
 }finally{
  if(inTransaction){const rollback=await client.query('ROLLBACK');assert.equal(rollback.command,'ROLLBACK');}
  await client.end();
 }
});
