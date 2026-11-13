import type { PoolClient } from 'pg';
import { recordAudit } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { conflict, invalid, sha256Hex } from '../supply/supply-util';
import { initialDistributionPolicyConfig, parseDistributionPolicyChange } from './distribution-policy-change';
import { readDistributionPolicyRowInTransaction } from './distribution-policy-store';

type Input = { sourceReceiptSha256: string; requestId: string; change: Record<string, unknown> };

function initialPolicy(input: Input) {
  if (!input || typeof input.sourceReceiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceReceiptSha256)
    || typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)
    || !input.change || typeof input.change !== 'object' || Array.isArray(input.change))
    throw invalid('Initial distribution source and request are required');
  const change = parseDistributionPolicyChange(input.change);
  if (change.schema !== 'distribution-policy-initialize.v2' || change.config.scope !== 'NATIVE'
    || change.config.legacySource.receiptSha256 !== input.sourceReceiptSha256) throw invalid('Same-source legacy distribution policy is required');
  const config = initialDistributionPolicyConfig(change, 'NATIVE'), canonical = canonicalize(config), digest = sha256Hex(canonical);
  return { config, canonical, digest, id: 'distribution_policy_' + sha256Hex(canonicalize(['NATIVE', '1', digest])).slice(0, 40) };
}

/** The caller binds the new target and source and owns the maintenance fence and transaction. */
export async function initializeFirstDistributionPolicy(client: PoolClient, input: Input) {
  if (client.getTransactionStatus() !== 'T') throw invalid('Initial distribution transaction is required');
  const policy = initialPolicy(input);
  const role = (await client.query(`SELECT current_user AS role,session_user AS session_role,
      pg_get_userbyid(c.relowner) AS owner,r.rolsuper,r.rolbypassrls
    FROM pg_class c JOIN pg_roles r ON r.rolname=current_user
    WHERE c.oid='zzsh_order.distribution_policy_version'::regclass`)).rows[0];
  if (!role || role.role !== role.owner || role.session_role !== role.role || role.rolsuper || role.rolbypassrls)
    throw conflict('Initial distribution requires the migration owner');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:NATIVE',0))");
  await client.query('LOCK TABLE zzsh_auth_user."user",zzsh_order.rental_order,zzsh_order.legacy_order_read_snapshot,zzsh_order.distribution_participant,zzsh_order.invitation_relation IN SHARE MODE');
  const state = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM zzsh_auth_user."user") OR EXISTS(SELECT 1 FROM zzsh_order.rental_order)
      OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot) OR EXISTS(SELECT 1 FROM zzsh_order.distribution_participant)
      OR EXISTS(SELECT 1 FROM zzsh_order.invitation_relation) AS occupied,
    EXISTS(SELECT 1 FROM zzsh_order.distribution_policy_version WHERE scope='NATIVE')
      OR EXISTS(SELECT 1 FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE') AS policy_exists`)).rows[0];
  if (!state || state.occupied || state.policy_exists) throw conflict('Initial distribution target is not empty');
  await client.query(`INSERT INTO zzsh_order.distribution_policy_version
      (id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id,initial_source_receipt_sha256)
    VALUES($1,1,'NATIVE',$2,$3,$4,NULL,$5)`,
  [policy.id,policy.config.schema,policy.canonical,policy.digest,input.sourceReceiptSha256]);
  await client.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,$1)",[policy.id]);
  await recordAudit(client, {actorType:'system',actorId:'migration.first-deployment',requestId:input.requestId,
    action:'distribution.policy.system_initialized',objectType:'distribution_policy_version',objectId:policy.id,outcome:'SUCCESS',
    details:{sourceReceiptSha256:input.sourceReceiptSha256,policyDigest:policy.digest,scope:'NATIVE'}});
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const read = await readDistributionPolicyRowInTransaction(client, false, 'NATIVE');
  if (read.knowledge !== 'KNOWN' || read.policy.versionId !== policy.id || read.policy.digest !== policy.digest)
    throw conflict('Initial distribution readback differs');
  return { policyId:policy.id,policyDigest:policy.digest,sourceReceiptSha256:input.sourceReceiptSha256 };
}

/** Missing evidence stays unknown; this never creates or modifies a policy. */
export async function readFirstDistributionPolicy(client: PoolClient, input: Input) {
  if (client.getTransactionStatus() !== 'T') throw invalid('Initial distribution read transaction is required');
  const tx = (await client.query("SELECT current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0];
  if (tx?.read_only !== 'on' || !['repeatable read','serializable'].includes(tx.isolation)) throw invalid('Initial distribution requires a read-only snapshot');
  const policy = initialPolicy(input);
  const row = (await client.query(`SELECT id,canonical_config,config_digest,created_by_admin_id,initial_source_receipt_sha256
    FROM zzsh_order.distribution_policy_version WHERE scope='NATIVE' AND revision=1`)).rows[0];
  const head = (await client.query("SELECT current_version_id FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0];
  const audits = (await client.query(`SELECT actor_type,actor_id,session_id,object_id,outcome,details
    FROM zzsh_iam.audit_event WHERE action='distribution.policy.system_initialized' AND request_id=$1`,[input.requestId])).rows;
  if (!row && !head && audits.length === 0) return { knowledge:'UNKNOWN' as const };
  if (!row || row.id !== policy.id || row.canonical_config !== policy.canonical || row.config_digest !== policy.digest
    || row.created_by_admin_id !== null || row.initial_source_receipt_sha256 !== input.sourceReceiptSha256
    || audits.length !== 1 || audits[0]?.actor_type !== 'system' || audits[0]?.actor_id !== 'migration.first-deployment'
    || audits[0]?.session_id !== null || audits[0]?.object_id !== policy.id || audits[0]?.outcome !== 'SUCCESS'
    || audits[0]?.details?.sourceReceiptSha256 !== input.sourceReceiptSha256 || audits[0]?.details?.policyDigest !== policy.digest)
    throw conflict('Initial distribution evidence differs');
  const active = await readDistributionPolicyRowInTransaction(client, false, 'NATIVE');
  if (active.knowledge !== 'KNOWN' || active.policy.versionId !== policy.id || active.policy.digest !== policy.digest)
    throw conflict('Initial distribution is no longer the active policy');
  return { knowledge:'KNOWN' as const,policyId:policy.id,policyDigest:policy.digest,sourceReceiptSha256:input.sourceReceiptSha256 };
}
