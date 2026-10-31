# Distribution v2 / NATIVE candidates

UNNUMBERED. Root owns numbering, journal, ACL and rollback. NOT APPLIED to any database.
Apply 01, 02 and 03 together inside the existing Drizzle migration transaction; none of the files
contains BEGIN/COMMIT. Order:
1. `01_uniform_policy_and_payment_basis.sql` — policy v2 shape/guard, per-scope head lock, UNIFORM basis derivation.
2. `02_native_earning_and_reversal_scope.sql` — NATIVE ledger/reversal scope and original-admission guard.
3. `03_v2_registration_and_contract.sql` — participant v1/v2 check+trigger, NATIVE self-bind source, contract version 2.

The runtime EXECUTE grant for `zzsh_order.distribution_policy_contract_version()` lives in the shared
`applyRuntimePrivileges` step (`apps/api/src/database/business-migrations.ts`, granted only when the
function exists), before `configureDistributionFinancialPrivileges` narrows the financial tables.
Do not publish the marker before all three files and the ACL readback succeed.

Acceptance host: `scripts/distribution-pg-native-acceptance.mjs`. Its sealed config must carry
`schema: distribution-pg-acceptance.v2`, the three registered role names plus their central-registry
OIDs, `statePath`, `candidateDir`, and `expectedSqlSha256` for each candidate file — the host verifies
the candidate bytes before it reads any credential. `--full-native` additionally needs
`native.file/expectedSha256` (synthetic NATIVE fixture SQL plus the reviewed per-case expectations)
and `native.collectionDocument/expectedCollectionSha256` (the sealed JoinPay collection document that
brands the admission). Missing input exits 2 as INCOMPLETE; it is never reported as a pass.
