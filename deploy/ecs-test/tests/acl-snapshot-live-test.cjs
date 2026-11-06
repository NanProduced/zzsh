'use strict';
// Synthetic fixture only. The parent holds this transaction open until pg_dump ACK.
const fs = require('node:fs');
const { Client } = require('/workspace/node_modules/pg');
const { captureAclInExportedSnapshot } = require('/fixture/acl_snapshot_capture.cjs');

async function main() {
  const client = new Client({host:'postgres',port:5432,database:'zzsh_ecs_test',user:'zzsh_ecs_migration',
    password:fs.readFileSync('/workspace/apps/api/.secrets/migration_db_password','utf8').trim(),
    ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/workspace/apps/api/.secrets/internal-ca.crt','utf8')}});
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row=(await client.query(`SELECT d.oid::text AS "databaseOid",pg_get_userbyid(d.datdba) AS "databaseOwner",
      shobj_description(d.oid,'pg_database') AS marker,current_user AS actor,
      (SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_runtime') AS "runtimeRoleOid",
      (SELECT oid::text FROM pg_roles WHERE rolname='zzsh_ecs_migration') AS "migrationRoleOid"
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    const result=await captureAclInExportedSnapshot(client,{...row,database:'zzsh_ecs_test',
      runtimeRole:'zzsh_ecs_runtime',migrationRole:'zzsh_ecs_migration'});
    const catalog=JSON.parse(result.catalogBytes);
    const v4=catalog.objects.filter(x=>x.kind==='routine'&&x.identity.name==='assert_personal_growth_order_v4');
    if(v4.length!==1||v4[0].acl.some(g=>g.grantee==='PUBLIC')) throw new Error('SYNTHETIC_ACL_CAPTURE_INVALID');
    process.stdout.write(JSON.stringify({snapshotToken:result.snapshotToken,catalogSha256:result.catalogSha256})+'\n');
    await new Promise((resolve,reject)=>{process.stdin.once('data',resolve);process.stdin.once('error',reject);process.stdin.resume();});
    await client.query('ROLLBACK');
    process.stdout.write('{"status":"ROLLBACK_ACK"}\n');
  } finally { await client.end(); }
}
main().catch(()=>{process.stderr.write('SYNTHETIC_ACL_CAPTURE_FAILED\n');process.exitCode=1;});
