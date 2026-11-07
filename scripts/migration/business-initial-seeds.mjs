import { createHash } from 'node:crypto';

// The generator must refuse user, operational and transaction rows; changing an
// operator's live configuration into a default is never a valid initialization.
export const INITIAL_SEED_TABLES = new Set([
  'zzsh_iam.admin_permission', 'zzsh_iam.admin_role', 'zzsh_iam.admin_role_permission',
  'zzsh_iam.approval_template', 'zzsh_supply.profile_avatar_policy',
  'zzsh_order.settlement_refund_policy', 'zzsh_order.legacy_duty_finance_contract',
]);
export const CANONICAL_AUTHORIZATION_TABLES = [
  'zzsh_iam.admin_permission', 'zzsh_iam.admin_role', 'zzsh_iam.admin_role_permission', 'zzsh_iam.approval_template',
];
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export function initialSeedRowsDigest(rows) {
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)
    || Object.hasOwn(row,'created_at') || Object.hasOwn(row,'updated_at'))) throw new Error('INITIAL_CANONICAL_SEED_SHAPE_INVALID');
  return createHash('sha256').update(JSON.stringify(rows.map(canonical).sort())).digest('hex');
}
export function assertCanonicalSeedProof(proof, sourceChain) {
  const digest = createHash('sha256').update(JSON.stringify(sourceChain)).digest('hex');
  if (!proof || proof.schema!=='zzsh.initial-canonical-seed-proof.v1' || proof.sourceCount!==sourceChain.length || proof.sourceChainSha256!==digest
    || JSON.stringify(proof.ignoredGeneratedColumns)!==JSON.stringify(['created_at','updated_at'])
    || !proof.tables || Object.keys(proof.tables).sort().join(',')!==[...CANONICAL_AUTHORIZATION_TABLES].sort().join(',')
    || CANONICAL_AUTHORIZATION_TABLES.some(name=>!Number.isSafeInteger(proof.tables[name]?.count) || proof.tables[name].count<0 || !/^[a-f0-9]{64}$/.test(proof.tables[name].sha256??'')))
    throw new Error('INITIAL_CANONICAL_SEED_PROOF_INVALID');
}
export function assertCanonicalSeedRows(proof, name, rows) {
  const expected=proof?.tables?.[name];
  if (!CANONICAL_AUTHORIZATION_TABLES.includes(name) || !expected || rows.length!==expected.count || initialSeedRowsDigest(rows)!==expected.sha256)
    throw new Error('INITIAL_CANONICAL_SEED_ROWS_DRIFT:'+name);
}

export function assertInitialMigrationHistory(applied, expected) {
  if (!Array.isArray(applied) || !Array.isArray(expected) || applied.length !== expected.length ||
    applied.some((row, index) => row.hash !== expected[index].hash || row.createdAt !== String(expected[index].createdAt)))
    throw new Error('SOURCE_DATABASE_NOT_EXACT_CANONICAL_CHAIN');
}

export function assertInitialSingleton(name, rows, runtimeDutyContractInstalled) {
  if (!Array.isArray(rows)) throw new Error('INITIAL_SEED_ROWS_REQUIRED');
  const row = rows[0];
  if (name === 'zzsh_supply.profile_avatar_policy') {
    if (rows.length !== 1 || row.singleton !== true || row.requires_review !== true || row.revision !== '1' || row.updated_by_admin_id !== null)
      throw new Error('AVATAR_POLICY_MUST_BE_CANONICAL_DEFAULT');
  } else if (name === 'zzsh_order.settlement_refund_policy') {
    if (rows.length !== 1 || row.singleton !== true || row.normal_days !== 0 || row.early_days !== 7 || row.revision !== '1' || row.updated_by_admin_id !== null)
      throw new Error('REFUND_POLICY_MUST_BE_CANONICAL_DEFAULT');
  } else if (name === 'zzsh_order.legacy_duty_finance_contract') {
    const ref = 'runtime:legacy-finance-duty:v1';
    const digest = createHash('sha256').update(ref).digest('hex');
    if ((!runtimeDutyContractInstalled && rows.length !== 0) || (runtimeDutyContractInstalled &&
      (rows.length !== 1 || row.singleton !== true || row.contract_version !== 'legacy-duty-finance.v1' || row.enabled !== true
        || row.approval_ref !== ref || row.approval_digest !== digest))) throw new Error('LEGACY_DUTY_CONTRACT_MUST_BE_CANONICAL_DEFAULT');
  } else throw new Error('INITIAL_SINGLETON_NOT_REGISTERED');
}
