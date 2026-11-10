import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

const enabled=Boolean(process.env.ZZSH_SYNTH_GROWTH_LOOKUP_SYSTEM),require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');

test('combined growth coverage lookup preserves exact priority and concurrent conflicts in PostgreSQL', {skip:!enabled,timeout:30000}, async t=>{
 const {Pool}=require('pg'),pool=new Pool({host:'127.0.0.1',port:61684,database:'zzsh_synth_growth_lookup',user:'postgres',password:'synthetic-only-password',max:3});
 t.after(async()=>pool.end());
 const identity=(await pool.query("SELECT current_database() AS database,shobj_description(d.oid,'pg_database') AS marker,(SELECT system_identifier::text FROM pg_control_system()) AS system FROM pg_database d WHERE d.datname=current_database()")).rows[0];
 assert.deepEqual(identity,{database:'zzsh_synth_growth_lookup',marker:'zzsh:synthetic:growth-lookup-v1',system:process.env.ZZSH_SYNTH_GROWTH_LOOKUP_SYSTEM});
 await pool.query(`ALTER TABLE zzsh_iam.membership_growth_legacy_coverage ADD COLUMN IF NOT EXISTS id text,ADD COLUMN IF NOT EXISTS receipt_digest text,
  ADD COLUMN IF NOT EXISTS cutoff timestamptz,ADD COLUMN IF NOT EXISTS from_exclusive timestamptz,ADD COLUMN IF NOT EXISTS coverage_state text,ADD COLUMN IF NOT EXISTS record jsonb`);
 const {prepareLegacyGrowthBackfill,writePreparedLegacyGrowth,LegacyGrowthConflictError}=require('../../apps/api/dist/src/auth/membership-growth-legacy.js');
 const {createLegacyGrowthCoveragePort}=require('../../apps/api/dist/src/auth/membership-growth-legacy-store.js');
 const {canonicalize}=require('../../apps/api/dist/src/supply/content-hash.js'),port=createLegacyGrowthCoveragePort(),run=randomUUID().replaceAll('-','');
 const prepare=(subject,packageDigest)=>{const cutoff='2026-10-18T00:00:00.000000Z',receipt={subjectUserId:subject,cutoff,fromExclusive:null,
   sourceExtractSha256:'b'.repeat(64),sourceSetSha256:sha(canonicalize({subjectUserId:subject,cutoff,fromExclusive:null,expectedSourceKeys:[]})),
   expectedSourceKeys:[],refundReviewEvidenceRefs:['SYNTHETIC_NONE']};
  const p=prepareLegacyGrowthBackfill({receipt,inputs:[],corrections:[],admitted:{receiptDigests:[sha(canonicalize(receipt))],componentDigests:[],correctionDigests:[]},gameIdBySettlementId:{},packageDigest});assert.equal(p.ok,true);return p;};
 const subject='lookup_'+run,a=prepare(subject,'a'.repeat(64)),b=prepare(subject,'c'.repeat(64)),keyA='lookup-key-a-'+run,keyB='lookup-key-b-'+run;
 const fixture=await pool.connect();try{await fixture.query('BEGIN');await port.persist(fixture,{...a.record,executionKey:keyA});await port.persist(fixture,{...b.record,executionKey:keyB});await fixture.query('COMMIT');}
 catch(e){await fixture.query('ROLLBACK');throw e;}finally{fixture.release();}
 const combined=await port.readForWrite(pool,subject,keyA,b.fingerprint),oldKey=await port.readByExecutionKey(pool,subject,keyA);
 assert.equal(combined.matchedByKey,true);assert.deepEqual(combined.record,oldKey);
 await assert.rejects(writePreparedLegacyGrowth(pool,b,port,keyA),LegacyGrowthConflictError);
 const alias=await writePreparedLegacyGrowth(pool,b,port,'lookup-key-c-'+run);assert.equal(alias.coverage,'REPLAYED');assert.equal(alias.executionKey,keyB);
 assert.equal(await port.readForWrite(pool,'foreign_'+run,keyA,b.fingerprint),null);
 const invalid='invalid_'+run;await pool.query(`INSERT INTO zzsh_iam.membership_growth_legacy_coverage(subject_user_id,execution_key,fingerprint,record_canonical,record_digest)
  VALUES($1,$2,$3,'{}',$4)`,[invalid,'invalid-key-'+run,'f'.repeat(64),'0'.repeat(64)]);
 await assert.rejects(port.readForWrite(pool,invalid,'invalid-key-'+run,'f'.repeat(64)),error=>error?.code==='EVIDENCE_UNAVAILABLE');

 const racing='race_'+run,first=prepare(racing,'d'.repeat(64)),second=prepare(racing,'e'.repeat(64)),raceKey='race-key-'+run;
 const writer=await pool.connect(),contender=await pool.connect(),observer=await pool.connect();let writerOpen=false,contenderOpen=false;
 try{
  await writer.query('BEGIN');writerOpen=true;await port.persist(writer,{...first.record,executionKey:raceKey});
  await contender.query('BEGIN');contenderOpen=true;
  const attempt=writePreparedLegacyGrowth(contender,second,port,raceKey).then(value=>({value}),error=>({error}));
  let blocked=false;for(let i=0;i<100;i++){
    const row=(await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[contender.processID])).rows[0];
    if(row?.wait_event_type==='Lock'){blocked=true;break;}await sleep(20);
  }
  assert(blocked,'RACE_WAIT_NOT_OBSERVED');await writer.query('COMMIT');writerOpen=false;
  const result=await attempt;assert(result.error instanceof LegacyGrowthConflictError);
  await contender.query('ROLLBACK');contenderOpen=false;
  const stored=await port.readByExecutionKey(observer,racing,raceKey);assert.equal(stored.fingerprint,first.fingerprint);
 }finally{
  if(writerOpen)await writer.query('ROLLBACK');if(contenderOpen)await contender.query('ROLLBACK');
  writer.release();contender.release();observer.release();
 }
});
