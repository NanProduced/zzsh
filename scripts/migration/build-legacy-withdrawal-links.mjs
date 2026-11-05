import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// This is a local, target-bound maintenance stage, not a runtime/background job.
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
if(!args.includes('--execute')){
  console.log(JSON.stringify({action:'PLAN',required:['--execute','--credentials','--expected-oid','--expected-nonce'],connections:0,credentialReads:0,financialEffect:'NONE'}));
  process.exit(0);
}
const credentialPath=option('--credentials'),expectedOid=option('--expected-oid'),expectedNonce=option('--expected-nonce');
assert(isAbsolute(credentialPath??''),'CREDENTIAL_PATH_REQUIRED');
const allowed=resolve('E:/zzsh/zzsh/apps/api/.secrets/local-postgresql').toLowerCase()+'\\';
assert(resolve(credentialPath).toLowerCase().startsWith(allowed),'CREDENTIAL_PATH_OUTSIDE_LOCAL_RESOURCES');
for(let cursor=resolve(credentialPath);cursor.toLowerCase()!==allowed.slice(0,-1);cursor=dirname(cursor)){
  assert(!lstatSync(cursor).isSymbolicLink(),'CREDENTIAL_REPARSE_POINT_REFUSED');
  assert(dirname(cursor)!==cursor,'CREDENTIAL_PATH_OUTSIDE_LOCAL_RESOURCES');
}
assert(/^[1-9]\d*$/.test(expectedOid??'')&&expectedOid!=='3179610','TARGET_OID_NOT_ALLOWED');
assert(/^[a-z0-9_]{12,40}$/.test(expectedNonce??''),'TARGET_NONCE_REQUIRED');
const credentials=JSON.parse(readFileSync(credentialPath,'utf8'));
const resource=JSON.parse(readFileSync(join(dirname(credentialPath),'resource.json'),'utf8'));
assert(['zzsh_test_regression','zzsh_test_round06_stage'].includes(resource.database),'TARGET_DATABASE_NOT_ALLOWED');
assert(['zzsh:regression-test:v1','zzsh:round06-schema-build:v1'].includes(resource.marker),'TARGET_MARKER_NOT_ALLOWED');
assert(resource.oid===expectedOid&&resource.nonce===expectedNonce&&!resource.pendingReset,'TARGET_REGISTRY_CHANGED');
assert(credentials.database===resource.database&&credentials.marker===resource.marker,'TARGET_CREDENTIALS_CHANGED');
assert(credentials.migration?.name===resource.roles?.migration?.name&&credentials.migration?.oid===resource.roles?.migration?.oid,'TARGET_ROLE_CHANGED');
const require=createRequire(import.meta.url),{Client}=require('pg');
const common={host:'127.0.0.1',port:55432,user:credentials.migration.name,password:credentials.migration.password,connectionTimeoutMillis:3000,statement_timeout:15000,lock_timeout:1000};
const maintenance=new Client({...common,database:'postgres',application_name:'withdrawal-link-maintenance-lock'});
const target=new Client({...common,database:resource.database,application_name:'withdrawal-link-certification'});
let locked=false,transaction=false,connected=false;
const started=performance.now(),counts={CREATED:0,REPLAY:0,UNRESOLVED:0},batchSize=200;
try{
  await maintenance.connect();
  locked=(await maintenance.query('SELECT pg_try_advisory_lock(806006) AS locked')).rows[0].locked===true;
  assert(locked,'TARGET_MAINTENANCE_LOCK_BUSY');
  await target.connect();connected=true;
  const identity=(await target.query(`SELECT d.oid::text oid,shobj_description(d.oid,'pg_database') marker,
    current_setting('zzsh.regression_run',true) nonce,current_user role,
    (SELECT oid::text FROM pg_roles WHERE rolname=current_user) role_oid,
    (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname=current_user) privileged
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert(identity?.oid===expectedOid&&identity.marker===resource.marker&&identity.nonce===expectedNonce,'TARGET_DATABASE_IDENTITY_CHANGED');
  assert(identity.role===credentials.migration.name&&identity.role_oid===credentials.migration.oid&&identity.privileged===false,'TARGET_ROLE_IDENTITY_CHANGED');
  const installed=(await target.query("SELECT to_regprocedure('zzsh_order.certify_legacy_withdrawal_link(text)') IS NOT NULL AS ready")).rows[0].ready;
  assert(installed,'WITHDRAWAL_LINK_MIGRATION_NOT_INSTALLED');
  let after='';
  for(;;){
    await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ');transaction=true;
    const parents=(await target.query(`SELECT id FROM zzsh_order.personal_finance_observation
      WHERE source_type='LEGACY_MYSQL' AND source_system='legacy_mysql_restore' AND source_entity='la_withdraw_apply'
       AND id COLLATE "C">$1 COLLATE "C" ORDER BY id COLLATE "C" LIMIT $2`,[after,batchSize])).rows.map(row=>row.id);
    if(!parents.length){await target.query('COMMIT');transaction=false;break;}
    const batch=(await target.query(`SELECT outcome,count(*)::int n FROM (
      SELECT zzsh_order.certify_legacy_withdrawal_link(id) AS outcome FROM unnest($1::text[]) AS parent(id)
      ) outcomes GROUP BY outcome`,[parents])).rows;
    for(const row of batch){assert(Object.hasOwn(counts,row.outcome),'CERTIFICATION_OUTCOME_INVALID');counts[row.outcome]+=row.n;}
    await target.query('COMMIT');transaction=false;after=parents.at(-1);
  }
  const summary=(await target.query(`SELECT count(*)::int total,
    count(*) FILTER(WHERE v.revision=e.revision)::int current,
    count(*) FILTER(WHERE v.revision IS DISTINCT FROM e.revision)::int stale,
    count(*) FILTER(WHERE v.revision=e.revision AND e.return_id IS NOT NULL)::int current_returns,
    count(*) FILTER(WHERE v.revision=e.revision AND (p.source_digest=e.parent_digest AND d.source_digest=e.debit_digest
      AND zzsh_order.legacy_withdrawal_row_fingerprint(p)=e.parent_fingerprint
      AND zzsh_order.legacy_withdrawal_row_fingerprint(d)=e.debit_fingerprint
      AND (e.return_id IS NULL OR r.source_digest=e.return_digest AND zzsh_order.legacy_withdrawal_row_fingerprint(r)=e.return_fingerprint)) IS NOT TRUE)::int invalid_current
    FROM zzsh_order.legacy_withdrawal_link_evidence e
    LEFT JOIN zzsh_order.legacy_withdrawal_subject_revision v ON v.source_system=e.source_system AND v.user_id=e.user_id
    LEFT JOIN zzsh_order.personal_finance_observation p ON p.id=e.parent_id
    LEFT JOIN zzsh_order.personal_finance_observation d ON d.id=e.debit_id
    LEFT JOIN zzsh_order.personal_finance_observation r ON r.id=e.return_id`)).rows[0];
  assert.equal(summary.invalid_current,0,'CERTIFICATE_READBACK_MISMATCH');
  const observed=(await target.query(`SELECT
    count(*) FILTER(WHERE source_entity='la_withdraw_apply')::int parents,
    count(*) FILTER(WHERE source_entity='la_log_earnings' AND snapshot->>'legacyChangeType' IN('1002','1003','1004','1005'))::int children
    FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system='legacy_mysql_restore'`)).rows[0];
  assert.equal(observed.parents,counts.CREATED+counts.REPLAY+counts.UNRESOLVED,'WITHDRAWAL_SOURCE_CHANGED_DURING_CERTIFICATION');
  const linkedChildren=summary.current+summary.current_returns;
  assert(linkedChildren<=observed.children,'CERTIFICATE_CHILD_COUNT_INVALID');
  console.log(JSON.stringify({status:'COMPLETED',targetOid:expectedOid,counts,evidence:summary,
    observations:{parents:observed.parents,children:observed.children,linkedChildren,independentChildren:observed.children-linkedChildren},
    elapsedMs:Math.round(performance.now()-started),financialEffect:'NONE'}));
}catch(error){
  if(transaction)await target.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({status:'FAILED',code:error.code??'CERTIFICATION_FAILED',completed:counts,elapsedMs:Math.round(performance.now()-started)}));
  process.exitCode=1;
}finally{
  if(connected)await target.end().catch(()=>{});
  if(locked)await maintenance.query('SELECT pg_advisory_unlock(806006)').catch(()=>{});
  await maintenance.end().catch(()=>{});
}
