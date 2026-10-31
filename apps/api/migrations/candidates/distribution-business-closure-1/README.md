# Distribution v2 / NATIVE candidates

Root has registered this forward package as canonical business migrations 0121–0123. Source registration is not database application or funds acceptance. The former candidate SQL files have moved to migrations/business; this directory retains the verification contract.
Apply 0121, 0122 and 0123 together inside the existing Drizzle migration transaction; none of the files
contains BEGIN/COMMIT. Order:
1. `../../business/0121_distribution_uniform_policy_basis.sql` — policy v2 shape/guard, per-scope head lock, UNIFORM basis derivation.
2. `../../business/0122_distribution_native_earning_scope.sql` — NATIVE ledger/reversal scope and original-admission guard.
3. `../../business/0123_distribution_participant_contract.sql` — participant v1/v2 check+trigger, NATIVE self-bind source, contract version 2.

The runtime EXECUTE grant for `zzsh_order.distribution_policy_contract_version()` lives in the shared
`applyRuntimePrivileges` step (`apps/api/src/database/business-migrations.ts`, granted only when the
function exists), before `configureDistributionFinancialPrivileges` narrows the financial tables.
Do not publish the marker before all three files and the ACL readback succeed.

Acceptance host: `scripts/distribution-pg-native-acceptance.mjs` (rollback-only assembly). Its sealed config must carry
`schema: distribution-pg-acceptance.v3`, the three registered role names plus their central-registry OIDs, `statePath`,
`candidateDir` (a sealed input folder containing the three canonical filenames) and `expectedSqlSha256` for each file — verified before any credential read or connection. The
`native` block must supply: `file`/`expectedSha256` (sealed synthetic fixture SQL), `collectionDocument`/
`expectedCollectionSha256` (the sealed JoinPay document that brands the NATIVE admission), `adminFixtureId` (an ACTIVE
administrator already in the registered resource), `declarerUserId` (table-owner administrator for the declaration stage),
`journalPath`, and `expectations` covering every required stage: fixture, policy, accrue, accrue-replay, settle-not-due,
settle, revoke-sufficient, revoke-insufficient, recover. Missing or partial input is reported field-by-field and exits 2
before credentials or sockets; the marker grant for runtime comes only from the shared `applyRuntimePrivileges` step, which
the host invokes from the built API inside the same transaction. Financial evidence is never deleted: residue is referred to
the registered controlled reset (`npm run test:db:reset -w @zzsh/api`).

Root execution contract additions:
- The fixture is plain DML on the explicit runtime role, in the same transaction as native proofs. Transaction control and DDL are rejected; this is not an arbitrary-SQL sandbox.
- recover must bind the newly insufficient earning and its just-created reversal source. Its sealed expectation includes fundingSql: legitimate synthetic balanced-ledger funding DML, which cannot alter the debt or its receipts. A no-op/insufficient fund cannot pass the actual store.
- accrue.earningIds must name the expected original roots. Restore checks exactly the plan cohort and cannot substitute an empty caller list.
- journalPath resolves under this repository tmp, without reparse ancestors. Every stage append is flushed and errors stop/rollback; a failed error journal cannot replace the original exception.
- Collection document bytes are SHA-checked once and passed inline to the application loader. No absolute secret-file path or supplier key loading is required to brand the admission.
- Each On body restores INITIALLY DEFERRED semantics and validates its own closure before the next one; SQL errors recover to savepoint before RESET ROLE.
- Future and matured samples must be separate valid economic roots/orders with frozen original due dates. Do not update due_at or canonical_seed to make a test mature.
- identity uses an actual READ ONLY role-switch probe and never loads application assembly or runs candidate DDL. Runtime must satisfy the original native no-membership contract; missing migration SET ROLE capability is an external registered-resource precondition, not permission to grant membership automatically.
