const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Client}=require('pg');

// Installs only a synthetic fixture into the pre-registered, empty test database.
// It deliberately refuses an existing schema, rather than resetting anything.
const oid=process.env.LW_CERT_TEST_OID,passwordFile=process.env.LW_CERT_TEST_PASSWORD_FILE;
assert.equal(process.env.LW_CERT_TEST_DATABASE,'zzsh_test_lwcert');
assert.match(oid??'',/^[1-9]\d*$/);assert.ok(passwordFile);
const client=new Client({host:'127.0.0.1',port:55432,user:'zzsh',password:fs.readFileSync(passwordFile,'utf8').trim(),database:'zzsh_test_lwcert',statement_timeout:10000,lock_timeout:500,application_name:'withdrawal-link-fixture-install'});
(async()=>{
  let transaction=false;
  try{
    await client.connect();
    const identity=(await client.query(`SELECT oid::text oid,pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker,
      (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) other_connections
      FROM pg_database d WHERE datname=current_database()`)).rows[0];
    assert.equal(identity.oid,oid);assert.equal(identity.owner,'zzsh_lwcert_m');
    assert.equal(identity.marker,'zzsh:legacy-withdrawal-link-test:v1');assert.equal(identity.other_connections,0);
    const roles=(await client.query("SELECT rolname,rolcanlogin,shobj_description(oid,'pg_authid') marker FROM pg_roles WHERE rolname IN ('zzsh_lwcert_m','zzsh_lwcert_r')")).rows;
    assert.equal(roles.length,2);assert(roles.every(r=>!r.rolcanlogin&&r.marker==='zzsh:legacy-withdrawal-link-test:v1'));
    const empty=(await client.query("SELECT to_regnamespace('zzsh_order') IS NULL AND to_regnamespace('zzsh_auth_user') IS NULL AS empty")).rows[0].empty;
    assert.equal(empty,true,'SYNTHETIC_SCHEMA_ALREADY_EXISTS');
    await client.query('BEGIN');transaction=true;await client.query('SET LOCAL ROLE zzsh_lwcert_m');
    await client.query(`CREATE SCHEMA zzsh_order; CREATE SCHEMA zzsh_auth_user;
      CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY);
      CREATE TABLE zzsh_order.personal_finance_observation(
       id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),basis_id text,
       source_kind text NOT NULL,source_type text NOT NULL,source_system text NOT NULL,legacy_user_id text NOT NULL,
       source_entity text NOT NULL,source_id text NOT NULL,source_digest text NOT NULL,source_canonical text NOT NULL,
       source_event_at timestamptz,imported_at timestamptz NOT NULL DEFAULT now(),included_in_opening boolean NOT NULL DEFAULT false,snapshot jsonb NOT NULL,
       UNIQUE(source_type,source_system,source_entity,source_id));
      CREATE FUNCTION zzsh_order.finance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'financial evidence immutable'; END $$;
      CREATE TRIGGER finance_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.personal_finance_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
      ALTER DEFAULT PRIVILEGES IN SCHEMA zzsh_order GRANT INSERT ON TABLES TO zzsh_lwcert_r;
      ALTER DEFAULT PRIVILEGES IN SCHEMA zzsh_order GRANT EXECUTE ON FUNCTIONS TO zzsh_lwcert_r;`);
    const migrationDir=path.resolve(__dirname,'../migrations/business');
    const canonical=fs.readFileSync(path.join(migrationDir,'0063_distribution_payment_and_earnings.sql'),'utf8');
    const start=canonical.indexOf('CREATE FUNCTION zzsh_order.canonical_finance_json('),end=canonical.indexOf('REVOKE ALL ON FUNCTION zzsh_order.canonical_finance_json',start);
    assert(start>=0&&end>start);await client.query(canonical.slice(start,end));
    // Inject explicit column grants immediately before the migration's own ACL cleanup.
    const original=fs.readFileSync(path.join(migrationDir,'0157_legacy_withdrawal_link_evidence.sql'),'utf8');
    assert(original.includes('DO $withdrawal_link_initial_acl$'));
    const sql=original.replace('DO $withdrawal_link_initial_acl$',`GRANT INSERT(parent_id) ON zzsh_order.legacy_withdrawal_link_evidence TO zzsh_lwcert_r;
      GRANT UPDATE(revision) ON zzsh_order.legacy_withdrawal_subject_revision TO zzsh_lwcert_r;\nDO $withdrawal_link_initial_acl$`);
    await client.query(sql);
    const closed=(await client.query(`SELECT has_table_privilege('zzsh_lwcert_r','zzsh_order.legacy_withdrawal_link_evidence','INSERT') table_write,
      has_column_privilege('zzsh_lwcert_r','zzsh_order.legacy_withdrawal_link_evidence','parent_id','INSERT') column_insert,
      has_column_privilege('zzsh_lwcert_r','zzsh_order.legacy_withdrawal_subject_revision','revision','UPDATE') column_update,
      has_function_privilege('zzsh_lwcert_r','zzsh_order.certify_legacy_withdrawal_link(text)','EXECUTE') certify_execute,
      has_function_privilege('zzsh_lwcert_r','zzsh_order.legacy_withdrawal_row_fingerprint(zzsh_order.personal_finance_observation)','EXECUTE') fingerprint_execute`)).rows[0];
    assert(Object.values(closed).every(value=>value===false),'SYNTHETIC_DEFAULT_ACL_NOT_CLOSED');
    await client.query(`GRANT USAGE ON SCHEMA zzsh_order,zzsh_auth_user TO zzsh_lwcert_r;
      GRANT SELECT ON zzsh_order.personal_finance_observation,zzsh_order.legacy_withdrawal_subject_revision,zzsh_order.legacy_withdrawal_link_evidence TO zzsh_lwcert_r;
      GRANT EXECUTE ON FUNCTION zzsh_order.legacy_withdrawal_row_fingerprint(zzsh_order.personal_finance_observation) TO zzsh_lwcert_r`);
    await client.query('COMMIT');transaction=false;
    console.log(JSON.stringify({status:'SYNTHETIC_SCHEMA_READY',oid}));
  }catch(error){
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    console.error(JSON.stringify({status:'FAILED',code:error.code??'FIXTURE_REFUSED'}));process.exitCode=1;
  }finally{await client.end().catch(()=>{});}
})();
