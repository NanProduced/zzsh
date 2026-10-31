// Owner-only full-reversal declaration. PLAN is the default and is provably offline:
// it reads only the sealed authorization file, never a credential, and opens zero connections.
// EXECUTE consumes a SUCCEEDED authorization execution receipt of an EXECUTED
// distribution.earning.reverse request and records the durable approval link in the same transaction.
// Runtime never receives declaration privileges; the database guard requires the table owner.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const execute = args.includes('--execute');
const configPath = option('--config'), expectedSha = option('--sha256');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha = (text) => createHash('sha256').update(text).digest('hex');
export const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
export const sha256 = sha;
const REVERSAL_OPERATION = 'distribution.earning.reverse';
const RECEIPT_CODE = 'DISTRIBUTION_REVERSAL_AUTHORIZED';

export function sealedAuthorization(bytes) {
  const config = JSON.parse(bytes.toString('utf8'));
  if (config.schema !== 'distribution-full-reversal-authorization.v1' || typeof config.database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(config.database)
    || typeof config.ownerUser !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(config.ownerUser) || !Number.isSafeInteger(config.resourceOid)
    || typeof config.earningId !== 'string' || typeof config.orderId !== 'string' || !/^[1-9]\d{0,23}$/.test(String(config.amountCents))
    || typeof config.approvalRequestId !== 'string' || typeof config.approvedByAdminId !== 'string'
    || typeof config.admissionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(config.admissionDigest)
    || typeof config.reason !== 'string' || config.reason.trim().length < 3 || config.reason.length > 500) fail('AUTHORIZATION_SHAPE_INVALID');
  return config;
}
/** The exact source the declaration would write; identical inputs must produce the identical digest. */
export function reversalSource(earning, admissionMode, earningId) {
  const scope = admissionMode === 'NATIVE' ? 'NATIVE' : 'LOCAL_CONTROLLED';
  const canonicalSource = canonical({ schema: 'rental-referral-reversal.v1', scope, earningId, basisDigest: earning.basis_digest, amountCents: String(earning.amount_cents) });
  return { scope, canonicalSource, sourceId: 'reversal_' + sha(canonical([scope, earningId])).slice(0, 40), sourceDigest: sha(canonicalSource) };
}
/**
 * Consumes the approved authorization for one full reversal. Every read locks what it validates, so a
 * decision or execution receipt that changed under us cannot be re-used. Returns the declaration plan or
 * performs the single INSERT plus its durable audit link when execute is set.
 */
export async function declareReversal(client, config, { execute: write = false, requestId } = {}) {
  const began = { value: false };
  await client.query('BEGIN'); began.value = true;
  await client.query("SET LOCAL lock_timeout='2s'");
  try {
    // Admin security precedes earning locks, as it does in the approval write path.
    const decider = (await client.query('SELECT status,is_boss FROM zzsh_iam.admin_security WHERE admin_user_id=$1 FOR SHARE', [config.approvedByAdminId])).rows[0];
    if (!decider || decider.status !== 'ACTIVE' || decider.is_boss !== true) fail('REVERSAL_APPROVER_NO_LONGER_VALID');
    const earning = (await client.query(`SELECT e.id,e.order_id,e.payment_confirmation_id,e.amount_cents::text,e.basis_digest,e.state,e.beneficiary_role,e.beneficiary_user_id,e.posting_id,e.policy_version
      FROM zzsh_order.rental_referral_earning e WHERE e.id=$1 AND e.order_id=$2 FOR UPDATE`, [config.earningId, config.orderId])).rows[0];
    if (!earning || String(earning.amount_cents) !== String(config.amountCents)) fail('ORIGINAL_EARNING_MISMATCH');
    // Read the original declaration first: a lost commit ACK must return the original receipt, not a new failure.
    const declared = (await client.query('SELECT id,canonical_source,source_digest,approval_digest FROM zzsh_order.rental_referral_reversal_source WHERE earning_id=$1 FOR UPDATE', [config.earningId])).rows[0];
    const request = (await client.query(`SELECT id,status,operation_code,operation_payload,operation_payload_hash,requested_by,decided_by,expires_at>clock_timestamp() AS live
      FROM zzsh_iam.approval_request WHERE id=$1 FOR UPDATE`, [config.approvalRequestId])).rows[0];
    if (!request || request.operation_code !== REVERSAL_OPERATION) fail('APPROVED_REVERSAL_EVIDENCE_MISMATCH');
    const payload = typeof request.operation_payload === 'string' ? JSON.parse(request.operation_payload) : request.operation_payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('APPROVED_REVERSAL_PAYLOAD_MISMATCH');
    if (request.status !== 'EXECUTED' || request.requested_by === request.decided_by || sha(canonical(payload)) !== request.operation_payload_hash) fail('APPROVED_REVERSAL_EVIDENCE_MISMATCH');
    if (payload.schema !== 'distribution-reversal-request.v1' || payload.earningId !== config.earningId || payload.orderId !== config.orderId
      || String(payload.amountCents) !== String(config.amountCents) || payload.full !== true || payload.reason !== config.reason.trim()) fail('APPROVED_REVERSAL_PAYLOAD_MISMATCH');
    // A consumed authorization must exist, must have succeeded, and must name this exact earning.
    const receipt = (await client.query(`SELECT id,status,result_code,result_detail,executed_by,completed_at FROM zzsh_iam.approval_execution
      WHERE request_id=$1 FOR UPDATE`, [config.approvalRequestId])).rows[0];
    if (!receipt || receipt.status !== 'SUCCEEDED' || receipt.result_code !== RECEIPT_CODE || receipt.result_detail !== config.earningId) fail('REVERSAL_EXECUTION_RECEIPT_MISSING');
    // The decision itself has to remain valid at declaration time; an APPROVED row alone is not authority.
    if (request.decided_by !== config.approvedByAdminId) fail('REVERSAL_APPROVER_NO_LONGER_VALID');
    const admission = (await client.query(`SELECT mode,approval_digest,source_admission_ref FROM zzsh_order.distribution_order_admission WHERE order_id=$1`, [config.orderId])).rows[0];
    if (!admission || admission.approval_digest !== config.admissionDigest || admission.mode !== 'NATIVE') fail('ORIGINAL_NATIVE_ADMISSION_MISMATCH');
    const source = reversalSource(earning, admission.mode, config.earningId);
    if (declared) {
      if (declared.id !== source.sourceId || declared.canonical_source !== source.canonicalSource || declared.source_digest !== source.sourceDigest || declared.approval_digest !== admission.approval_digest) fail('EXISTING_REVERSAL_SOURCE_DIFFERS');
      const links = await client.query('SELECT details FROM "zzsh_iam"."audit_event" WHERE object_type=$1 AND object_id=$2 AND action=$3 AND outcome=$4',
        ['rental_referral_reversal_source', source.sourceId, 'distribution.reversal.source.declared', 'SUCCESS']);
      const details = links.rows[0]?.details;
      const original = { reversalSourceId: source.sourceId, earningId: config.earningId, orderId: config.orderId, amountCents: String(earning.amount_cents),
        basisDigest: earning.basis_digest, postingId: earning.posting_id, beneficiaryRole: earning.beneficiary_role,
        approvalRequestId: config.approvalRequestId, approvalPayloadHash: request.operation_payload_hash,
        executionReceiptId: receipt.id, executionResultCode: receipt.result_code, admissionDigest: admission.approval_digest };
      if (links.rows.length !== 1 || !details || Object.entries(original).some(([key, value]) => details[key] !== value)) fail('EXISTING_REVERSAL_APPROVAL_DIFFERS');
      await client.query('ROLLBACK'); began.value = false;
      return { replayed: true, writing: false, earning, source, approval: { requestId: config.approvalRequestId, executionReceiptId: receipt.id, payloadHash: request.operation_payload_hash, executedBy: receipt.executed_by } };
    }
    if (!['PENDING', 'SETTLED', 'RECOVERY_REQUIRED'].includes(earning.state)) fail('ORIGINAL_EARNING_MISMATCH');
    const started = (await client.query("SELECT 1 FROM zzsh_order.rental_referral_transition WHERE earning_id=$1 AND action IN('REVOKE','RECOVER') LIMIT 1", [config.earningId])).rowCount;
    if (started) fail('ORIGINAL_REVERSAL_ALREADY_STARTED');
    if (!write) { await client.query('ROLLBACK'); began.value = false; return { replayed: false, writing: false, earning, source, approval: { requestId: config.approvalRequestId, executionReceiptId: receipt.id, payloadHash: request.operation_payload_hash, executedBy: receipt.executed_by } }; }
    await client.query(`INSERT INTO zzsh_order.rental_referral_reversal_source(id,earning_id,scope,basis_digest,amount_cents,canonical_source,source_digest,approval_digest,created_by_admin_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [source.sourceId, config.earningId, source.scope, earning.basis_digest, String(earning.amount_cents), source.canonicalSource, source.sourceDigest, admission.approval_digest, config.approvedByAdminId, config.reason.trim()]);
    // Durable link from the money-facing source back to the exact authorization it consumed.
    await client.query(`INSERT INTO "zzsh_iam"."audit_event"(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
      VALUES($1,'admin',$2,'distribution.reversal.source.declared','rental_referral_reversal_source',$3,'SUCCESS',$4,'Full reversal declared from a consumed authorization receipt',clock_timestamp(),$5::jsonb)`,
      ['audit_' + sha(canonical([source.sourceId, config.approvalRequestId, receipt.id])).slice(0, 40), config.approvedByAdminId, source.sourceId, requestId ?? config.approvalRequestId,
        JSON.stringify({ reversalSourceId: source.sourceId, earningId: config.earningId, orderId: config.orderId, amountCents: String(earning.amount_cents), basisDigest: earning.basis_digest,
          postingId: earning.posting_id, beneficiaryRole: earning.beneficiary_role, approvalRequestId: config.approvalRequestId, approvalPayloadHash: request.operation_payload_hash,
          executionReceiptId: receipt.id, executionResultCode: receipt.result_code, admittedBy: config.approvedByAdminId, admissionDigest: admission.approval_digest })]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('COMMIT'); began.value = false;
    return { replayed: false, writing: true, earning, source, approval: { requestId: config.approvalRequestId, executionReceiptId: receipt.id, payloadHash: request.operation_payload_hash, executedBy: receipt.executed_by } };
  } catch (error) {
    if (began.value) { try { await client.query('ROLLBACK'); } catch { throw Object.assign(new Error('declaration rolled back unknown'), { code: 'DECLARATION_ROLLBACK_UNKNOWN', cause: error.code }); } }
    throw error;
  }
}

async function main() {
  if (!configPath || !expectedSha) fail('CONFIG_AND_INDEPENDENT_SHA_REQUIRED');
  const bytes = readFileSync(resolve(configPath));
  const configSha = sha(bytes);
  if (configSha !== expectedSha) fail('AUTHORIZATION_SHA_MISMATCH');
  const config = sealedAuthorization(bytes);
  const summary = { database: config.database, earningId: config.earningId, orderId: config.orderId, amountCents: String(config.amountCents),
    approvalRequestId: config.approvalRequestId, approvedBy: config.approvedByAdminId, admissionDigest: config.admissionDigest, authorizationSha256: configSha };
  if (!execute) { console.log(JSON.stringify({ mode: 'PLAN', pass: true, readsSecrets: false, connections: 0, requiresExecutionReceipt: true, ...summary })); return; }
  const host = process.env.DISTRIBUTION_OWNER_DB_HOST ?? '127.0.0.1', port = Number(process.env.DISTRIBUTION_OWNER_DB_PORT ?? 55432);
  if (host !== '127.0.0.1' || port !== 55432) fail('OWNER_TARGET_MUST_BE_LOCAL_REGISTRATION_SERVER');
  const passwordFile = process.env.DISTRIBUTION_OWNER_PASSWORD_FILE?.trim();
  if (!passwordFile) fail('DISTRIBUTION_OWNER_PASSWORD_FILE_REQUIRED');
  const password = readFileSync(resolve(passwordFile), 'utf8').trim();
  const client = new Client({ host, port, database: config.database, user: config.ownerUser, password, connectionTimeoutMillis: 4000, statement_timeout: 15000, application_name: 'zzsh-distribution-reversal-declare' });
  let locked = false, unlocked = false, ended = false, success = null;
  await client.connect();
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(806008) AS acquired')).rows[0]?.acquired === true;
    if (!locked) fail('REVERSAL_DECLARATION_LOCK_BUSY');
    const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS oid,pg_get_userbyid(d.datdba) AS owner,d.datallowconn AS allow
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    if (!identity || identity.database !== config.database || identity.role !== config.ownerUser || identity.oid !== String(config.resourceOid)
      || identity.owner !== config.ownerUser || identity.allow !== true) fail('OWNER_RESOURCE_IDENTITY_MISMATCH');
    if (!(await client.query("SELECT to_regclass('zzsh_order.rental_referral_reversal_source') IS NOT NULL AS ready")).rows[0]?.ready) fail('REVERSAL_SCHEMA_NOT_INSTALLED');
    const outcome = await declareReversal(client, config, { execute: true });
    success = { mode: 'EXECUTE', pass: true, identity: { database: identity.database, oid: identity.oid, owner: identity.role },
      writing: outcome.writing, replayed: outcome.replayed, sourceId: outcome.source.sourceId, sourceDigest: outcome.source.sourceDigest,
      scope: outcome.source.scope, basisDigest: outcome.earning.basis_digest, ...outcome.approval, ...summary };
  } catch (error) {
    console.error(JSON.stringify({ pass: false, code: error.code ?? 'FAILED', message: error.message }));
    process.exitCode = 1;
  } finally {
    if (locked) { try { unlocked = (await client.query('SELECT pg_advisory_unlock(806008) AS released')).rows[0]?.released === true; } catch { unlocked = false; } }
    try { await client.end(); ended = true; } catch { ended = false; }
    if (!unlocked || !ended) console.error(JSON.stringify({ pass: false, code: 'CLEANUP_UNKNOWN', unlocked, ended }));
    if (!process.exitCode && (!unlocked || !ended)) process.exitCode = 1;
    if (!process.exitCode && success) console.log(JSON.stringify(success));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
