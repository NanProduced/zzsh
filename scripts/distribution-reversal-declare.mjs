// Owner-only full-reversal declaration. Default is PLAN. Writes only with --execute.
// Requires a sealed authorization file, an exact owner connection and an APPROVED/EXECUTED
// distribution.earning.reverse request. Runtime never receives declaration privileges.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const execute = args.includes('--execute');
const configPath = option('--config'), expectedSha = option('--sha256');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
if (!configPath || !expectedSha) fail('CONFIG_AND_INDEPENDENT_SHA_REQUIRED');
const bytes = readFileSync(resolve(configPath));
if (createHash('sha256').update(bytes).digest('hex') !== expectedSha) fail('AUTHORIZATION_SHA_MISMATCH');
const config = JSON.parse(bytes.toString('utf8'));
if (config.schema !== 'distribution-full-reversal-authorization.v1' || typeof config.database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(config.database)
  || typeof config.ownerUser !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(config.ownerUser) || !Number.isSafeInteger(config.resourceOid)
  || typeof config.earningId !== 'string' || typeof config.orderId !== 'string' || !/^[1-9]\d{0,23}$/.test(String(config.amountCents))
  || typeof config.approvalRequestId !== 'string' || typeof config.approvedByAdminId !== 'string'
  || typeof config.admissionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(config.admissionDigest)
  || typeof config.reason !== 'string' || config.reason.trim().length < 3 || config.reason.length > 500) fail('AUTHORIZATION_SHAPE_INVALID');
// A successful authorization receipt and durable approval link are required before this tool may write.
if (execute) fail('REVERSAL_EXECUTION_RECEIPT_CONTRACT_UNAVAILABLE');
const host = process.env.DISTRIBUTION_OWNER_DB_HOST ?? '127.0.0.1', port = Number(process.env.DISTRIBUTION_OWNER_DB_PORT ?? 55432);
if (host !== '127.0.0.1' || port !== 55432) fail('OWNER_TARGET_MUST_BE_LOCAL_REGRESSION_SERVER');
const passwordFile = process.env.DISTRIBUTION_OWNER_PASSWORD_FILE?.trim();
if (!passwordFile) fail('DISTRIBUTION_OWNER_PASSWORD_FILE_REQUIRED');
const password = readFileSync(resolve(passwordFile), 'utf8').trim();
const client = new Client({ host, port, database: config.database, user: config.ownerUser, password, connectionTimeoutMillis: 4000, application_name: 'zzsh-distribution-reversal-declare' });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
await client.connect();
let locked = false, began = false;
try {
  locked = (await client.query('SELECT pg_try_advisory_lock(806008) AS acquired')).rows[0]?.acquired === true;
  if (!locked) fail('REVERSAL_DECLARATION_LOCK_BUSY');
  const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,d.datallowconn AS allow
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if (!identity || identity.database !== config.database || identity.role !== config.ownerUser || identity.oid !== String(config.resourceOid)
    || identity.owner !== config.ownerUser || identity.allow !== true) fail('OWNER_RESOURCE_IDENTITY_MISMATCH');
  if (!(await client.query("SELECT to_regclass('zzsh_order.rental_referral_reversal_source') IS NOT NULL AS ready")).rows[0]?.ready) fail('REVERSAL_SCHEMA_NOT_INSTALLED');
  began = true; await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='2s'");
  const earning = (await client.query(`SELECT e.id,e.order_id,e.payment_confirmation_id,e.amount_cents::text,e.basis_digest,e.state,e.beneficiary_role
    FROM zzsh_order.rental_referral_earning e WHERE e.id=$1 AND e.order_id=$2 FOR UPDATE`, [config.earningId, config.orderId])).rows[0];
  if (!earning || String(earning.amount_cents) !== String(config.amountCents) || !['PENDING','SETTLED','RECOVERY_REQUIRED'].includes(earning.state)) fail('ORIGINAL_EARNING_MISMATCH');
  const admission = (await client.query(`SELECT mode,approval_digest,source_admission_ref FROM zzsh_order.distribution_order_admission WHERE order_id=$1`, [config.orderId])).rows[0];
  if (!admission || admission.approval_digest !== config.admissionDigest || admission.mode !== 'NATIVE') fail('ORIGINAL_NATIVE_ADMISSION_MISMATCH');
  const approval = (await client.query(`SELECT status,operation_code,operation_payload,operation_payload_hash,requested_by,decided_by,expires_at>clock_timestamp() AS live
    FROM zzsh_iam.approval_request WHERE id=$1`, [config.approvalRequestId])).rows[0];
  const payload = typeof approval?.operation_payload === 'string' ? JSON.parse(approval.operation_payload) : approval?.operation_payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('APPROVED_REVERSAL_PAYLOAD_MISMATCH');
  if (!approval || approval.operation_code !== 'distribution.earning.reverse' || !['APPROVED','EXECUTED'].includes(approval.status)
    || approval.status === 'APPROVED' && approval.live !== true
    || approval.requested_by === approval.decided_by || approval.decided_by !== config.approvedByAdminId
    || sha(canonical(payload)) !== approval.operation_payload_hash) fail('APPROVED_REVERSAL_EVIDENCE_MISMATCH');
  if (payload.schema !== 'distribution-reversal-request.v1' || payload.earningId !== config.earningId || payload.orderId !== config.orderId
    || String(payload.amountCents) !== String(config.amountCents) || payload.full !== true) fail('APPROVED_REVERSAL_PAYLOAD_MISMATCH');
  const transition = (await client.query("SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=$1 AND action IN('REVOKE','RECOVER') LIMIT 1", [config.earningId])).rowCount;
  if (transition) fail('ORIGINAL_REVERSAL_ALREADY_STARTED');
  const scope = admission.mode === 'NATIVE' ? 'NATIVE' : 'LOCAL_CONTROLLED';
  const canonicalSource = canonical({ schema: 'rental-referral-reversal.v1', scope, earningId: config.earningId, basisDigest: earning.basis_digest, amountCents: String(earning.amount_cents) });
  const sourceId = 'reversal_' + sha(canonical([scope, config.earningId])).slice(0, 40);
  const summary = { database: config.database, oid: identity.oid, owner: identity.role, earningId: config.earningId, orderId: config.orderId,
    amountCents: String(earning.amount_cents), scope, basisDigest: earning.basis_digest, admissionDigest: admission.approval_digest,
    approvalRequestId: config.approvalRequestId, approvedBy: config.approvedByAdminId, sourceId, canonicalSource, sourceDigest: sha(canonicalSource) };
  if (!execute) { await client.query('ROLLBACK'); began = false; console.log(JSON.stringify({ mode: 'PLAN', pass: true, ...summary })); }
  else {
    const existing = (await client.query('SELECT id,canonical_source,source_digest,approval_digest FROM zzsh_order.rental_referral_reversal_source WHERE earning_id=$1', [config.earningId])).rows[0];
    if (existing) {
      if (existing.id !== sourceId || existing.canonical_source !== canonicalSource || existing.source_digest !== sha(canonicalSource) || existing.approval_digest !== admission.approval_digest) fail('EXISTING_REVERSAL_SOURCE_DIFFERS');
      await client.query('ROLLBACK'); began = false; console.log(JSON.stringify({ mode: 'EXECUTE', replayed: true, ...summary }));
    } else {
      await client.query(`INSERT INTO zzsh_order.rental_referral_reversal_source(id,earning_id,scope,basis_digest,amount_cents,canonical_source,source_digest,approval_digest,created_by_admin_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [sourceId, config.earningId, scope, earning.basis_digest, String(earning.amount_cents), canonicalSource, sha(canonicalSource), admission.approval_digest, config.approvedByAdminId, config.reason.trim()]);
      await client.query('COMMIT'); began = false; console.log(JSON.stringify({ mode: 'EXECUTE', replayed: false, ...summary }));
    }
  }
} catch (error) {
  if (began) await client.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ pass: false, code: error.code ?? 'FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock(806008)').catch(() => {});
  await client.end().catch(() => {});
}
