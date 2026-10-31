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

Acceptance host: `scripts/distribution-pg-native-acceptance.mjs` (rollback-only assembly). Its sealed config must carry
`schema: distribution-pg-acceptance.v3`, the three registered role names plus their central-registry OIDs, `statePath`,
`candidateDir` and `expectedSqlSha256` for each candidate file — verified before any credential read or connection. The
`native` block must supply: `file`/`expectedSha256` (sealed synthetic fixture SQL), `collectionDocument`/
`expectedCollectionSha256` (the sealed JoinPay document that brands the NATIVE admission), `adminFixtureId` (an ACTIVE
administrator already in the registered resource), `declarerUserId` (table-owner administrator for the declaration stage),
`journalPath`, and `expectations` covering every required stage: fixture, policy, accrue, accrue-replay, settle-not-due,
settle, revoke-sufficient, revoke-insufficient, recover. Missing or partial input is reported field-by-field and exits 2
before credentials or sockets; the marker grant for runtime comes only from the shared `applyRuntimePrivileges` step, which
the host invokes from the built API inside the same transaction. Financial evidence is never deleted: residue is referred to
the registered controlled reset (`npm run test:db:reset -w @zzsh/api`).
