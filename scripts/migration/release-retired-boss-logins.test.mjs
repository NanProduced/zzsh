import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { releaseRetiredBossLogins } from './release-retired-boss-logins.mjs';

const ids = ['admin_' + 'a'.repeat(32), 'admin_' + 'b'.repeat(32)];
const active = 'admin_' + 'c'.repeat(32);
const target = { database:'zzsh_test_r07_delivery_20261108', oid:'16391', marker:'zzsh:r07-delivery-clone:v1',
  systemIdentifier:'7705473419326033954', role:'zzsh_regression_migration',roleOid:'16389',owner:'zzsh',ownerOid:'16388' };
const plan = (mode = 'ROLLBACK_TEST') => ({ mode, target, retiredIds:ids, activeBossId:active, requestId:'r07-boss-fix-test' });

function fixture(changes = {}) {
  const calls = [];
  const actualTarget=changes.target??target;
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') {
      if (sql === 'COMMIT' && changes.commitUnknown) throw new Error('connection lost');
      return { command:sql, rows:[] };
    }
    if (sql.startsWith('SET LOCAL')) return { rows:[] };
    if (sql.includes('AS schema_owner')) return { rows:[{ database:actualTarget.database,oid:actualTarget.oid,marker:actualTarget.marker,
      system_identifier:changes.wrongSystem?'999':actualTarget.systemIdentifier,role:actualTarget.role,role_oid:actualTarget.roleOid,
      owner:actualTarget.owner,owner_oid:actualTarget.ownerOid,schema_owner:actualTarget.role,rolsuper:false,rolbypassrls:false,
      rolcreatedb:false,rolcreaterole:false,rolreplication:false,ssl:changes.ssl??false }] };
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows:[{ok:true}] };
    if (sql.startsWith('SELECT 1 FROM zzsh_iam.audit_event')) return { rows:changes.priorAudit?[{}]:[] };
    if (sql.includes('retirement_proven')) return { rows:ids.map((id,i)=>({ id,username:`zz0000${i+1}`,email:`zz0000${i+1}@admin.zzsh.invalid`,
      suspended:true,factor:false,security:false,credentials:false,factors:false,sessions:false,retirement_proven:!changes.unproven })) };
    if (sql.includes('WHERE s.is_boss=true')) return { rows:changes.noBoss?[]:[{id:active,username:'zz00005',email:'zz00005@admin.zzsh.invalid',suspended:false,factor:true,credentials:true,status:'ACTIVE'}] };
    if (sql.startsWith('SELECT 1 FROM zzsh_auth_admin."user"')) return { rows:changes.aliasOccupied?[{}]:[] };
    if (sql.startsWith('UPDATE zzsh_auth_admin."user"')) return { rowCount:1,rows:[] };
    if (sql.startsWith('INSERT INTO zzsh_iam.audit_event')) return { rowCount:1,rows:[] };
    throw new Error('UNEXPECTED_SQL');
  } };
}

test('rehearses only the two proven retired logins and the specified active Boss, then rolls back', async () => {
  const db=fixture();
  assert.equal((await releaseRetiredBossLogins(db,plan())).status,'ROLLBACK_TEST_PASSED');
  assert.equal(db.calls.filter(sql=>sql.startsWith('UPDATE zzsh_auth_admin."user"')).length,3);
  assert.equal(db.calls.at(-1),'ROLLBACK');
});

test('wrong target, unknown retirement, occupied alias and prior receipt refuse before user updates', async () => {
  for (const change of [{wrongSystem:true},{unproven:true},{aliasOccupied:true},{priorAudit:true}]) {
    const db=fixture(change);
    await assert.rejects(releaseRetiredBossLogins(db,plan()));
    assert.equal(db.calls.some(sql=>sql.startsWith('UPDATE zzsh_auth_admin."user"')),false);
    assert.equal(db.calls.at(-1),'ROLLBACK');
  }
});

test('a lost commit acknowledgement is retained as unknown and never automatically rolled back or retried', async () => {
  const db=fixture({commitUnknown:true});
  await assert.rejects(releaseRetiredBossLogins(db,plan('APPLY')),/BOSS_RELEASE_COMMIT_UNKNOWN/);
  assert.equal(db.calls.at(-1),'COMMIT');
});

test('ECS release requires the exact registered target, no active Boss, and a TLS database session', async () => {
  const ecs={database:'zzsh_ecs_test',oid:'51',marker:'zzsh:ecs-test:v1',systemIdentifier:'12345',
    role:'zzsh_ecs_migration',roleOid:'52',owner:'zzsh_ecs_owner',ownerOid:'53'};
  const request={...plan(),target:ecs,activeBossId:null};
  const allowed=fixture({target:ecs,noBoss:true,ssl:true});
  assert.equal((await releaseRetiredBossLogins(allowed,request)).status,'ROLLBACK_TEST_PASSED');
  const denied=fixture({target:ecs,noBoss:true,ssl:false});
  await assert.rejects(releaseRetiredBossLogins(denied,request),/BOSS_RELEASE_TARGET_CHANGED/);
  assert.equal(denied.calls.some(sql=>sql.startsWith('UPDATE zzsh_auth_admin."user"')),false);
});
