'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { captureAclInExportedSnapshot } = require('./acl_snapshot_capture.cjs');

const expected = {database:'synthetic',databaseOid:'101',databaseOwner:'owner',marker:'fixture',actor:'reader',
  runtimeRole:'runtime',runtimeRoleOid:'102',migrationRole:'migration',migrationRoleOid:'103'};
const identity = {database:'synthetic',databaseOid:'101',databaseOwner:'owner',marker:'fixture',actor:'reader',
  runtimeRoleOid:'102',migrationRoleOid:'103',readOnly:'on',isolation:'repeatable read'};
const catalog = {schema:'zzsh.acl-snapshot-catalog.v1',database:'synthetic',transactionReadOnly:'on',
  transactionIsolation:'repeatable read',transactionSnapshot:'synthetic-snapshot',objects:[],roles:[],memberships:[],roleSettings:[],policies:[]};
function reader({row=identity, tx='T', catalogRow=catalog}={}) {
  const calls=[];
  return {calls,getTransactionStatus:()=>tx,query:async (sql,params)=>{
    calls.push({sql,params});
    if (calls.length===1) return {rows:[row]};
    if (calls.length===2) return {rows:[{snapshot:'00000003-0000001A-1'}]};
    return {rows:[{acl_snapshot:JSON.stringify(catalogRow)}]};
  }};
}

test('capture exports and reads the same open source transaction, returning bytes and digest only',async()=>{
  const client=reader();const result=await captureAclInExportedSnapshot(client,expected);
  assert.equal(client.calls.length,3);assert.match(client.calls[1].sql,/pg_export_snapshot/);
  assert.match(client.calls[2].sql,/pg_default_acl/);assert.equal(result.snapshotToken,'00000003-0000001A-1');
  assert.equal(createHash('sha256').update(result.catalogBytes).digest('hex'),result.catalogSha256);
  assert.equal(JSON.parse(result.catalogBytes).transactionReadOnly,'on');
});

test('rejects nontransactional, wrong identity, wrong role, and mismatched catalog without writing',async()=>{
  await assert.rejects(captureAclInExportedSnapshot(reader({tx:'I'}),expected),/ACL_SOURCE_TRANSACTION_REQUIRED/);
  const wrong=reader({row:{...identity,databaseOid:'999'}});
  await assert.rejects(captureAclInExportedSnapshot(wrong,expected),/ACL_SOURCE_IDENTITY_MISMATCH/);assert.equal(wrong.calls.length,1);
  await assert.rejects(captureAclInExportedSnapshot(reader(),{...expected,runtimeRoleOid:'103'}),/ACL_SOURCE_IDENTITY_REQUIRED/);
  await assert.rejects(captureAclInExportedSnapshot(reader({catalogRow:{...catalog,database:'other'}}),expected),/ACL_CAPTURE_INCOMPLETE/);
});
