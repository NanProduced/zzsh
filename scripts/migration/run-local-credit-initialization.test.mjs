import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { creditMaintenanceSecretLocation } from './run-local-credit-initialization.mjs';

const secrets=resolve('E:/zzsh/zzsh/apps/api/.secrets');
const restricted=resolve('E:/zzsh-local-state/restricted');
const target={bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',instance:{host:'127.0.0.1',port:55433,systemIdentifier:'7704972584346443810'}};

test('accepts the existing R06 secret and a restricted secret',()=>{
 for(const path of [join(secrets,'postgres_password'),join(restricted,'credential-set','postgres_password')])
  assert.equal(creditMaintenanceSecretLocation(path,secrets,{},restricted),path);
});

test('accepts the dedicated R07 PostgreSQL secret only for a bound loopback instance',()=>{
 const path=join(secrets,'round07-postgres-20261106-01','postgres_password');
 assert.equal(creditMaintenanceSecretLocation(path,secrets,target,restricted),path);
 for(const changed of [null,{}, {...target,bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'},
  {...target,instance:{...target.instance,host:'192.0.2.1'}}, {...target,instance:{...target.instance,port:0}},
  {...target,instance:{...target.instance,systemIdentifier:''}}])
  assert.throws(()=>creditMaintenanceSecretLocation(path,secrets,changed,restricted),/CREDIT_MAINTENANCE_SECRET_PATH_INVALID/);
});

test('next-round secret is bound to its separate profile and cannot reuse an R07 secret path',()=>{
 const path=join(secrets,'migration-postgres-fixture-01','postgres_password'),next={...target,migrationProfile:'LOCAL_MIGRATION_NEXT_V1',instance:{...target.instance,port:55435}};
 assert.equal(creditMaintenanceSecretLocation(path,secrets,next,restricted),path);
 assert.throws(()=>creditMaintenanceSecretLocation(path,secrets,target,restricted),/CREDIT_MAINTENANCE_SECRET_PATH_INVALID/);
 assert.throws(()=>creditMaintenanceSecretLocation(join(secrets,'round07-postgres-fixture-01','postgres_password'),secrets,next,restricted),/CREDIT_MAINTENANCE_SECRET_PATH_INVALID/);
 assert.throws(()=>creditMaintenanceSecretLocation(path,secrets,{...next,instance:{...next.instance,port:55433}},restricted),/CREDIT_MAINTENANCE_SECRET_PATH_INVALID/);
});

test('rejects sibling, traversal, other secret names, and non-absolute paths',()=>{
 for(const path of [join(secrets,'round07-postgres-20261106-01','other'),join(secrets,'other','postgres_password'),
  join(secrets,'round07-postgres-20261106-01','..','postgres_password-extra'),join(restricted+'-other','postgres_password'),
  'postgres_password'])
  assert.throws(()=>creditMaintenanceSecretLocation(path,secrets,target,restricted),/CREDIT_MAINTENANCE_SECRET_PATH_INVALID/);
});
