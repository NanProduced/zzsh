import { createHash } from 'node:crypto';

// The generator must refuse user, operational and transaction rows; changing an
// operator's live configuration into a default is never a valid initialization.
export const INITIAL_SEED_TABLES = new Set([
  'zzsh_iam.admin_permission', 'zzsh_iam.admin_role', 'zzsh_iam.admin_role_permission',
  'zzsh_iam.approval_template', 'zzsh_supply.profile_avatar_policy',
  'zzsh_order.settlement_refund_policy', 'zzsh_order.legacy_duty_finance_contract',
]);

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
