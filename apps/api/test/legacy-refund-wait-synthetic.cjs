// Disposable synthetic PG only: fixture seed bypasses triggers; the tested schedule/guard and lock run normally and roll back.
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const Module = require('node:module');
const {Pool} = require('pg');
const originalLoad = Module._load;
Module._load = function (name, ...args) { if (name === 'sharp') return function () { throw Error('unused synthetic media'); }; return originalLoad.call(this, name, ...args); };
const {readLegacyContinuationHead} = require('../dist/src/order/legacy-continuation-evidence.js');
const env = process.env;
assert.equal(env.LEGACY_REFUND_SYNTH_OPT_IN, '1');
assert.match(env.LEGACY_REFUND_SYNTH_OID ?? '', /^[1-9]\d*$/);
assert.match(env.LEGACY_REFUND_SYNTH_SYSTEM_ID ?? '', /^[1-9]\d*$/);
const db = 'zzsh_test_order_settlement_closure', marker = 'zzsh:synthetic-settlement-test:v1';
const pool = new Pool({host:'127.0.0.1',port:5432,database:db,user:'postgres',max:2,statement_timeout:10000,lock_timeout:5000});
const hash = value => createHash('sha256').update(value).digest('hex'), json = value => JSON.stringify(value), h = 'a'.repeat(64);

async function assertResource(client) {
  const value = (await client.query(`SELECT current_database() AS db,current_user AS role,inet_server_addr()::text AS host,d.oid::text AS oid,
    shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(value,{db,role:'postgres',host:'127.0.0.1/32',oid:env.LEGACY_REFUND_SYNTH_OID,marker,system_id:env.LEGACY_REFUND_SYNTH_SYSTEM_ID});
}
async function seedOrder(c, id, status) {
  await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,
    account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,
    legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
    VALUES($1,'legacy_mysql_restore','la_order','1',$2,'fixture','order-1','account','game','owner','renter','9','la_rental_accounts',$2,'2',$2,'3',$2,$3,1,'{}'::jsonb,1,$2,'staff')`,[id,h,status]);
}

async function frozenDeadline(c) {
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL session_replication_role='replica'");
    await c.query('INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())',['staff','staff@example.invalid']);
    await seedOrder(c,'old-order',8);
    const original=json({evidence:{source:{orderStatus:'8',isSettle:'0'}},amounts:{}});
    await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
      VALUES('source','old-order',1,'SOURCE_IMPORT',now(),'fixture',$1,$1,'PARAMETER_COMPLETE','[]'::jsonb,$2::text::jsonb,$2::text,$3)`,[h,original,hash(original)]);
    await c.query("SET LOCAL session_replication_role='origin'");
    assert.deepEqual((await c.query('SELECT normal_days,early_days FROM zzsh_order.settlement_refund_policy WHERE singleton=true')).rows[0],{normal_days:0,early_days:7});
    await c.query('UPDATE zzsh_order.settlement_refund_policy SET normal_days=3,early_days=9,revision=revision+1 WHERE singleton=true');
    for (const early of [false,true]) {
      await c.query('SAVEPOINT example');
      const actor={realm:'admin',userId:'staff',sessionId:'session',requestId:'request'};
      await c.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,is_advance_set,amounts,commission_revisions,plan_fingerprint)
        VALUES('version','old-order',1,'CONFIRM',$1::jsonb,'source','result',4,0,$2,'{}'::jsonb,'[]'::jsonb,$3)`,[json(actor),early?1:0,h]);
      const facts=json({derivedFromEvidenceId:'source',derivedFromCommandVersionId:'version',amounts:{},evidence:{parameterDigest:h,
        provenance:{profitDot:'ORDER_COLUMN',baseBot:'ACCOUNT_COLUMN_AT_CUTOFF_NOT_ORDER_FROZEN'},source:{legacyOrderId:'1',renterId:'3',ownerId:'2',accountId:'9',orderStatus:'4',isSettle:'0'}}});
      await c.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,derived_from_command_version_id,source_as_of,evidence_ref,source_digest,parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
        VALUES('result','old-order',2,'DERIVED','version',now(),'fixture',$1,$1,'PARAMETER_COMPLETE','[]'::jsonb,$2::text::jsonb,$2::text,$3)`,[h,facts,hash(facts)]);
      await c.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
        VALUES('audit','admin','staff','session','order.legacy.continuation.confirm','rental_order','old-order','SUCCESS','request',now(),$1::jsonb)`,
        [json({versionId:'version',inputEvidenceId:'source',resultEvidenceId:'result',supportReason:'双方情况已核实'})]);
      const read=async()=> (await c.query(`SELECT refund_policy_revision::text AS revision,refund_wait_days,extract(epoch FROM refund_due_at-created_at)::integer AS seconds
        FROM zzsh_order.legacy_continuation_version WHERE id='version'`)).rows[0];
      const before=await read();assert.equal(before.revision,'2');assert.equal(before.refund_wait_days,early?9:3);assert.equal(before.seconds,before.refund_wait_days*86400);
      const head=await readLegacyContinuationHead(c,'old-order',true);assert(head?.refundDueAt && Number.isFinite(Date.parse(head.refundDueAt)));
      await c.query('UPDATE zzsh_order.settlement_refund_policy SET normal_days=4,early_days=10,revision=revision+1 WHERE singleton=true');
      assert.deepEqual(await read(),before);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('ROLLBACK TO SAVEPOINT example');
    }
  } finally { await c.query('ROLLBACK'); }
}

async function dueGuard(c) {
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL session_replication_role='replica'");
    for (const [id,days] of [['future',3],['due',0],['unknown',null]]) {
      await c.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,is_advance_set,amounts,commission_revisions,plan_fingerprint,created_at,refund_policy_revision,refund_wait_days,refund_due_at)
        VALUES($1,$1,1,'CONFIRM','{}'::jsonb,'source-'||$1,'result-'||$1,4,0,0,'{}'::jsonb,'[]'::jsonb,$2,statement_timestamp()-interval '1 hour',
        CASE WHEN $3::int IS NULL THEN NULL ELSE 1 END,$3,CASE WHEN $3::int IS NULL THEN NULL ELSE statement_timestamp()-interval '1 hour'+$3::int*interval '24 hours' END)`,[id,h,days]);
      await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_digest)
        VALUES('duty-'||$1,$1,$1,'RENTER_REFUND',$1,'renter',100,'CNY','PENDING','CONTINUATION',$2)`,[id,h]);
    }
    await c.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,source_digest)
      VALUES('duty-historical','historical','RENTER_REFUND','1','renter',100,'CNY','PENDING','LEGACY_IMPORT','COMPLETED_UNREFUNDED',$1)`,[h]);
    await c.query("SET LOCAL session_replication_role='origin'");
    await c.query('CREATE TEMP TABLE due_probe(kind text,duty_id text) ON COMMIT DROP');
    await c.query('CREATE TRIGGER due_probe_guard BEFORE INSERT ON due_probe FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_due()');
    await c.query("INSERT INTO due_probe VALUES('RENTER_REFUND','duty-due')");
    for (const id of ['future','unknown','historical']) {
      await c.query('SAVEPOINT example');await assert.rejects(c.query("INSERT INTO due_probe VALUES('RENTER_REFUND',$1)",['duty-'+id]),e=>e.code==='23514');await c.query('ROLLBACK TO SAVEPOINT example');
    }
    assert.equal((await c.query('SELECT count(*)::int AS n FROM due_probe')).rows[0].n,1);
  } finally { await c.query('ROLLBACK'); }
}

async function policyLock(a,b) {
  let update;
  await a.query('BEGIN');
  try {
    await a.query("SET LOCAL session_replication_role='replica'");await seedOrder(a,'lock-order',8);await a.query("SET LOCAL session_replication_role='origin'");
    await a.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,is_advance_set,amounts,commission_revisions,plan_fingerprint)
      VALUES('lock-version','lock-order',1,'CONFIRM','{}'::jsonb,'source','result',4,0,1,'{}'::jsonb,'[]'::jsonb,$1)`,[h]);
    await b.query('BEGIN');const aPid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,bPid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    update=b.query('UPDATE zzsh_order.settlement_refund_policy SET normal_days=normal_days+1,revision=revision+1 WHERE singleton=true');
    let blocked=false;for(let i=0;i<50&&!blocked;i++){blocked=(await a.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[aPid,bPid])).rows[0].blocked;if(!blocked)await new Promise(r=>setTimeout(r,20));}
    assert(blocked,'policy update must wait for the actual confirmation trigger');await a.query('ROLLBACK');await update;update=null;await b.query('ROLLBACK');
  } catch (error) { await a.query('ROLLBACK').catch(()=>{});if(update)await update.catch(()=>{});await b.query('ROLLBACK').catch(()=>{});throw error; }
}

(async()=>{
  const a=await pool.connect(),b=await pool.connect();
  try { await assertResource(a);await assertResource(b);await frozenDeadline(a);await dueGuard(a);await policyLock(a,b);
    console.log(json({status:'PASS',scope:'isolated-synthetic-pg',normalAndEarly:true,frozenAfterPolicyChange:true,futureAndUnknownBlocked:true,realLockWait:true}));
  } catch(error) { console.error(json({status:'FAIL',code:error?.code,message:String(error?.message??'').slice(0,250)}));process.exitCode=1; }
  finally { a.release();b.release();await pool.end(); }
})();
