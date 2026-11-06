'use strict';

// Caller owns the already-open source transaction and must keep it open until
// pg_dump has ACKed using the returned snapshotToken. Nothing is written here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const catalogSql = fs.readFileSync(path.join(__dirname, 'acl-snapshot-catalog.sql'), 'utf8');
const identitySql = `SELECT current_database() AS database,d.oid::text AS "databaseOid",
  pg_get_userbyid(d.datdba) AS "databaseOwner",shobj_description(d.oid,'pg_database') AS marker,
  current_user AS actor,current_setting('transaction_read_only') AS "readOnly",
  current_setting('transaction_isolation') AS isolation,
  (SELECT oid::text FROM pg_roles WHERE rolname=$1) AS "runtimeRoleOid",
  (SELECT oid::text FROM pg_roles WHERE rolname=$2) AS "migrationRoleOid"
 FROM pg_database d WHERE d.datname=current_database()`;

function fail(condition, code) { if (!condition) throw new Error(code); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

async function captureAclInExportedSnapshot(reader, expected) {
  const fields = ['database','databaseOid','databaseOwner','marker','actor','runtimeRole','runtimeRoleOid','migrationRole','migrationRoleOid'];
  fail(expected && fields.every(key => typeof expected[key] === 'string' && expected[key].length > 0)
    && ['databaseOid','runtimeRoleOid','migrationRoleOid'].every(key => /^[1-9][0-9]*$/.test(expected[key]))
    && expected.runtimeRole !== expected.migrationRole && expected.runtimeRoleOid !== expected.migrationRoleOid, 'ACL_SOURCE_IDENTITY_REQUIRED');
  fail(typeof reader?.query === 'function' && typeof reader.getTransactionStatus === 'function' && reader.getTransactionStatus() === 'T',
    'ACL_SOURCE_TRANSACTION_REQUIRED');
  const identity = (await reader.query(identitySql, [expected.runtimeRole, expected.migrationRole])).rows;
  fail(identity.length === 1 && identity[0].readOnly === 'on' && identity[0].isolation === 'repeatable read'
    && fields.filter(key => !['runtimeRole','migrationRole'].includes(key)).every(key => identity[0][key] === expected[key]), 'ACL_SOURCE_IDENTITY_MISMATCH');
  const exported = (await reader.query('SELECT pg_export_snapshot() AS snapshot')).rows;
  fail(exported.length === 1 && typeof exported[0].snapshot === 'string' && /^[0-9A-Fa-f-]+$/.test(exported[0].snapshot),
    'ACL_EXPORT_SNAPSHOT_UNAVAILABLE');
  const rows = (await reader.query(catalogSql)).rows;
  fail(reader.getTransactionStatus() === 'T' && rows.length === 1 && typeof rows[0].acl_snapshot === 'string', 'ACL_CAPTURE_INCOMPLETE');
  const catalog = JSON.parse(rows[0].acl_snapshot);
  fail(catalog.schema === 'zzsh.acl-snapshot-catalog.v1' && catalog.database === expected.database
    && catalog.transactionReadOnly === 'on' && catalog.transactionIsolation === 'repeatable read'
    && typeof catalog.transactionSnapshot === 'string' && catalog.transactionSnapshot.length > 0, 'ACL_CAPTURE_INCOMPLETE');
  const bytes = Buffer.from(JSON.stringify(canonical(catalog)) + '\n', 'utf8');
  return { snapshotToken: exported[0].snapshot, sourceIdentity: {...expected}, catalogBytes: bytes,
    catalogSha256: createHash('sha256').update(bytes).digest('hex'),
    catalogSqlSha256: createHash('sha256').update(catalogSql, 'utf8').digest('hex') };
}

module.exports = { captureAclInExportedSnapshot };
