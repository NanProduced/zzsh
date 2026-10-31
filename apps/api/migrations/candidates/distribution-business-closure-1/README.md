# Distribution v2 / NATIVE candidates

UNNUMBERED. Root owns numbering, journal, ACL and rollback. NOT APPLIED to any database.
Apply 01, 02 and 03 together inside the existing Drizzle migration transaction; none of the files
contains BEGIN/COMMIT. Order:
1. `01_uniform_policy_and_payment_basis.sql` — policy v2 shape/guard, per-scope head lock, UNIFORM basis derivation.
2. `02_native_earning_and_reversal_scope.sql` — NATIVE ledger/reversal scope and original-admission guard.
3. `03_v2_registration_and_contract.sql` — participant v1/v2 check+trigger, NATIVE self-bind source, contract version 2.

After the schema transaction, the existing `configureDistributionFinancialPrivileges` path must grant
runtime EXECUTE on `zzsh_order.distribution_policy_contract_version()`; it already does so when the
function exists. Do not publish the marker before all three files and ACL readback succeed.
