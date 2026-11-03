import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { prepareLegacyGrowthBackfill } from "../src/auth/membership-growth-legacy";
import { prepareLegacyGrowthMaintenanceInput, LEGACY_GROWTH_MAINTENANCE_OPERATION, type LegacyGrowthMaintenanceReceipt } from "../src/auth/membership-growth-legacy-maintenance";
import { LEGACY_ZERO_ELIGIBLE_SQL, LEGACY_ZERO_READ_CONTRACT, readLegacyZeroReadAdmission, hasLegacyZeroReadAdmission, closeLegacyZeroReadAdmission, legacyZeroReadSubjectIds } from "../src/auth/membership-growth-read-admission";
import { prepareLegacyZeroReadAdmission, insertLegacyZeroReadAdmissionBatch, recoverLegacyZeroReadAdmissionBatch } from "../src/auth/membership-growth-read-admission-maintenance";
import { readLegacyGrowthCoverageAssessments } from "../src/auth/membership-growth-legacy-store";
import { projectAdmittedEmptyGrowthTier, readMembershipGrowthBatch } from "../src/auth/membership-growth-integration";

const H = "a".repeat(64), ASOF = "2026-11-03T00:00:00.000000Z", CUTOFF = "2026-09-13T13:31:13.000000Z";
function original() {
  const sourceReceipt = { subjectUserId: "legacy_fixture", cutoff: CUTOFF, fromExclusive: null, sourceExtractSha256: H, sourceSetSha256: sha256Hex(canonicalize({ subjectUserId: "legacy_fixture", cutoff: CUTOFF, fromExclusive: null, expectedSourceKeys: [] })), expectedSourceKeys: [], refundReviewEvidenceRefs: ["SYNTHETIC_FULL_NO_ORDER_SOURCE"] };
  const business = { schema: "legacy-growth-maintenance-package-v1", reason: "Synthetic admitted full zero source", source: { receipt: sourceReceipt, inputs: [], corrections: [], admitted: { receiptDigests: [sha256Hex(canonicalize(sourceReceipt))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {} } };
  const bytes = JSON.stringify(business), digest = sha256Hex(bytes);
  const input = prepareLegacyGrowthMaintenanceInput(bytes, digest, { executionKey: "fixture-zero-original-1", requestId: "fixture-request", execution: { actorAdminId: "admin-original", actorSessionId: "offline-not-a-real-session", approvalRef: "OFFLINE_SOURCE_ONLY", attempt: 1, approvalDigest: H, windowStartUtc: "2026-10-01T00:00:00.000000Z", windowEndUtc: "2026-10-01T00:10:00.000000Z", resource: { databaseName: "zzsh_dev_daily", databaseOid: "2400547", bindingKind: "DATABASE_COMMENT", databaseComment: "zzsh:local-daily:v1", owner: "zzsh", runtimeRole: "zzsh_daily_m" } } });
  const prepared = prepareLegacyGrowthBackfill({ ...business.source, packageDigest: digest }); assert(prepared.ok);
  const receipt: LegacyGrowthMaintenanceReceipt = { schema: "legacy-growth-maintenance-receipt-v1", operation: LEGACY_GROWTH_MAINTENANCE_OPERATION, executionKey: input.executionKey, subjectUserId: input.subjectUserId, businessFingerprint: input.businessFingerprint, businessPackageSha256: digest, coverageFingerprint: prepared.fingerprint, coverageExecutionKey: input.executionKey, sourceReceiptDigest: prepared.record.receiptDigest, coverageState: "COMPLETE", inserted: 0, replayed: 0, execution: { approvalRef: "ORIGINAL_APPROVAL", attempt: 1 } };
  const entry = prepareLegacyZeroReadAdmission(input, receipt);
  return { input, prepared, receipt, entry };
}

/** Executes the actual selection predicate, adapting the PG timestamp cast. Not PG/ACL evidence. */
function fixture() {
  const base = original(), e = base.entry, db = new DatabaseSync(":memory:");
  for (const schema of ["zzsh_iam", "zzsh_supply", "zzsh_order"]) db.exec(`ATTACH DATABASE ':memory:' AS ${schema}`);
  db.exec(`CREATE TABLE zzsh_iam.membership_growth_legacy_coverage(id TEXT,subject_user_id TEXT,record_digest TEXT,fingerprint TEXT,receipt_digest TEXT,cutoff TEXT,from_exclusive TEXT,coverage_state TEXT,execution_key TEXT);
    CREATE TABLE zzsh_iam.membership_growth_legacy_read_admission(coverage_id TEXT,subject_user_id TEXT,record_digest TEXT,coverage_fingerprint TEXT,source_receipt_digest TEXT,cutoff TEXT,validation_contract TEXT,scope_key TEXT,execution_key TEXT,business_fingerprint TEXT,business_package_sha256 TEXT,success_audit_id TEXT,actor_admin_id TEXT,approval_ref TEXT,approval_attempt INTEGER);
    CREATE TABLE zzsh_supply.idempotency_record(scope_key TEXT,key TEXT,request_fingerprint TEXT,response_status INTEGER,publish_required INTEGER,response_body TEXT);
    CREATE TABLE zzsh_iam.audit_event(id TEXT,actor_type TEXT,actor_id TEXT,action TEXT,object_type TEXT,object_id TEXT,outcome TEXT,details TEXT);
    CREATE TABLE zzsh_iam.membership_growth_contribution(user_id TEXT);CREATE TABLE zzsh_iam.membership_growth_state(user_id TEXT);CREATE TABLE zzsh_order.rental_order(renter_user_id TEXT);CREATE TABLE zzsh_order.legacy_order_read_snapshot(renter_user_id TEXT);`);
  db.prepare("INSERT INTO zzsh_iam.membership_growth_legacy_coverage VALUES(?,?,?,?,?,?,?,?,?)").run(e.coverageId, e.subjectUserId, e.recordDigest, e.coverageFingerprint, e.sourceReceiptDigest, e.cutoff, null, "COMPLETE", base.receipt.coverageExecutionKey);
  db.prepare("INSERT INTO zzsh_iam.membership_growth_legacy_read_admission VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(e.coverageId, e.subjectUserId, e.recordDigest, e.coverageFingerprint, e.sourceReceiptDigest, e.cutoff, LEGACY_ZERO_READ_CONTRACT, e.scopeKey, e.executionKey, e.businessFingerprint, e.businessPackageSha256, "audit-original", e.actorAdminId, e.approvalRef, e.approvalAttempt);
  db.prepare("INSERT INTO zzsh_supply.idempotency_record VALUES(?,?,?,?,?,?)").run(e.scopeKey, e.executionKey, e.businessFingerprint, 200, 0, JSON.stringify(base.receipt));
  const details = { ...base.receipt, coverageExecutionKey: base.receipt.coverageExecutionKey, approvalRef: e.approvalRef, attempt: e.approvalAttempt, approvalDigest: H };
  db.prepare("INSERT INTO zzsh_iam.audit_event VALUES(?,?,?,?,?,?,?,?)").run("audit-original", "admin", e.actorAdminId, LEGACY_GROWTH_MAINTENANCE_OPERATION, "legacy_growth_maintenance", e.subjectUserId, "SUCCESS", JSON.stringify(details));
  const sql = LEGACY_ZERO_ELIGIBLE_SQL.replaceAll("$1::timestamptz", "$1");
  const eligible = (asOf = ASOF) => db.prepare(sql).all({ $1: asOf }) as Array<{ userId: string }>;
  const client = { getTransactionStatus: () => "T", async query(text: string, values: unknown[] = []) { if (text.includes("legacy-growth-zero-read-schema")) return { rows: [{ present: true, readOnly: "on", isolation: "repeatable read" }] }; if (text.includes("legacy-growth-zero-read-admissions")) return { rows: eligible(String(values[0])) }; throw Error("UNEXPECTED_ADMISSION_FIXTURE_SQL"); } } as unknown as PoolClient;
  return { ...base, db, eligible, client };
}

test("an immutable owner admission must match the exact coverage digest, subject, contract and cutoff", () => {
  const mutations = [
    "DELETE FROM zzsh_iam.membership_growth_legacy_read_admission",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET record_digest='wrong'",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET subject_user_id='foreign'",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET validation_contract='unverified'",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET coverage_fingerprint='wrong'",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET source_receipt_digest='wrong'",
    "UPDATE zzsh_iam.membership_growth_legacy_read_admission SET cutoff='2026-09-12T13:31:13.000000Z'",
    "UPDATE zzsh_iam.membership_growth_legacy_coverage SET coverage_state='BACKFILL_PENDING'",
    "UPDATE zzsh_iam.membership_growth_legacy_coverage SET from_exclusive='2026-01-01T00:00:00.000000Z'",
  ];
  for (const mutation of mutations) { const f=fixture(); assert.deepEqual(f.eligible().map(x=>x.userId),[f.entry.subjectUserId]); f.db.exec(mutation); assert.equal(f.eligible().length,0,mutation); f.db.close(); }
  const time=fixture();assert.equal(time.eligible("2026-09-12T00:00:00.000000Z").length,0);assert.equal(time.eligible(CUTOFF).length,1);time.db.close();
});

test("a receipt must be valid when owner admission is prepared, but later mutable response content does not rewrite admitted history", () => {
  const f=fixture();assert.throws(()=>prepareLegacyZeroReadAdmission(f.input,{...f.receipt,sourceReceiptDigest:H}));assert.throws(()=>prepareLegacyZeroReadAdmission(f.input,{...f.receipt,inserted:1}));
  assert.equal(f.eligible().length,1);
  f.db.exec("UPDATE zzsh_supply.idempotency_record SET response_body=json_set(response_body,'$.coverageFingerprint','changed-after-admission','$.inserted',99),request_fingerprint='later-mutable-value'");
  assert.equal(f.eligible().length,1,"the M-only immutable admission records the completed verification, not a live cache of an updatable response");
  f.db.exec("INSERT INTO zzsh_iam.membership_growth_contribution VALUES('legacy_fixture')");assert.equal(f.eligible().length,0,"new current facts still require full source verification");f.db.close();
});

test("new contributions, native or legacy orders and other visible coverage immediately remove the fast path", () => {
  for (const table of ["zzsh_iam.membership_growth_contribution", "zzsh_iam.membership_growth_state", "zzsh_order.rental_order", "zzsh_order.legacy_order_read_snapshot"]) { const f = fixture(); f.db.prepare(`INSERT INTO ${table} VALUES(?)`).run(f.entry.subjectUserId); assert.equal(f.eligible().length, 0, table); f.db.close(); }
  const f = fixture(); f.db.prepare("INSERT INTO zzsh_iam.membership_growth_legacy_coverage VALUES(?,?,?,?,?,?,?,?,?)").run("new-partial", f.entry.subjectUserId, H, H, H, "2026-10-01T00:00:00.000000Z", null, "BACKFILL_PENDING", "another-key"); assert.equal(f.eligible().length, 0); f.db.exec("UPDATE zzsh_iam.membership_growth_legacy_coverage SET cutoff='2027-01-01T00:00:00.000000Z' WHERE id='new-partial'"); assert.equal(f.eligible().length, 1, "future coverage follows the original asOf predicate"); f.db.close();
  const nullable=fixture();nullable.db.prepare('INSERT INTO zzsh_order.legacy_order_read_snapshot VALUES(?)').run(null);assert.equal(nullable.eligible().length,1,'an unmapped nullable legacy party does not block unrelated subjects');nullable.db.close();
});

test("only the same RR client and asOf can use the opaque authority; copies, forged flags and closed authority cannot", async () => {
  const f = fixture(), admission = await readLegacyZeroReadAdmission(f.client, ASOF); assert(admission);
  assert.equal(hasLegacyZeroReadAdmission(admission, f.client, ASOF, f.entry.subjectUserId), true);
  assert.equal(hasLegacyZeroReadAdmission({ ...admission }, f.client, ASOF, f.entry.subjectUserId), false);
  assert.equal(hasLegacyZeroReadAdmission(admission, {} as PoolClient, ASOF, f.entry.subjectUserId), false);
  assert.equal(hasLegacyZeroReadAdmission(admission, f.client, CUTOFF, f.entry.subjectUserId), false);
  assert.deepEqual(legacyZeroReadSubjectIds(admission, f.client, ASOF), [f.entry.subjectUserId]);
  const contributions = new Map([[f.entry.subjectUserId, []]]);
  const snapshot = { installed: { coverage: true, sources: true }, versions: [], sources: [], zeroReadAdmission: admission };
  assert.equal((await readLegacyGrowthCoverageAssessments(f.client, contributions, ASOF, snapshot)).get(f.entry.subjectUserId)?.state, "COMPLETE");
  const forged = { ...snapshot, zeroReadAdmission: { kind: LEGACY_ZERO_READ_CONTRACT } as const };
  assert.equal((await readLegacyGrowthCoverageAssessments(f.client, contributions, ASOF, forged)).get(f.entry.subjectUserId)?.state, "BACKFILL_PENDING");
  const increment = new Map([[f.entry.subjectUserId, [{ sourceKey: "new", revision: 0, status: "SETTLED" } as never]]]);
  assert.equal((await readLegacyGrowthCoverageAssessments(f.client, increment, ASOF, snapshot)).get(f.entry.subjectUserId)?.state, "BACKFILL_PENDING");
  closeLegacyZeroReadAdmission(admission); assert.equal(hasLegacyZeroReadAdmission(admission, f.client, ASOF, f.entry.subjectUserId), false); f.db.close();
});

test("missing schema preserves the full codec path and a present schema outside RR read-only cannot create authority", async () => {
  let queries=0;const absent={async query(){queries++;return {rows:[{present:false}]};}} as unknown as PoolClient;
  assert.equal(await readLegacyZeroReadAdmission(absent,ASOF),null);assert.equal(queries,1);
  const wrong={getTransactionStatus:()=>"T",async query(){return {rows:[{present:true,readOnly:"off",isolation:"read committed"}]};}} as unknown as PoolClient;
  await assert.rejects(readLegacyZeroReadAdmission(wrong,ASOF),{status:503});
});

test("owner declaration preparation reproduces the full original package and rejects changed receipts or source closure", () => {
  const f = original(); assert.equal(f.entry.businessFingerprint, f.input.businessFingerprint);
  assert.throws(() => prepareLegacyZeroReadAdmission(f.input, { ...f.receipt, sourceReceiptDigest: H }));
  assert.throws(() => prepareLegacyZeroReadAdmission(f.input, { ...f.receipt, inserted: 1 }));
  const altered = { ...f.input, businessPackageBytes: f.input.businessPackageBytes.replace("SYNTHETIC_FULL_NO_ORDER_SOURCE", "changed") }; assert.throws(() => prepareLegacyZeroReadAdmission(altered, f.receipt));
});

test("runtime cannot declare and exact primary-key readback never adopts another batch or mismatched metadata", async () => {
  const f = original(); let calls = 0;
  const runtime = { async query() { calls++; return { rows: [{ currentRole: "runtime", owner: "migration", coverageOwner: "migration" }] }; } } as unknown as PoolClient;
  await assert.rejects(insertLegacyZeroReadAdmissionBatch(runtime, [f.entry], H), { status: 403 }); assert.equal(calls, 1);
  const client = { async query() { return { rows: [{ ...f.entry, batchDigest: H }] }; } } as unknown as PoolClient;
  assert.deepEqual(await recoverLegacyZeroReadAdmissionBatch(client, [f.entry], H), { found: 1, missing: [] });
  await assert.rejects(recoverLegacyZeroReadAdmissionBatch(client, [f.entry], "b".repeat(64)), { status: 503 });
  await assert.rejects(recoverLegacyZeroReadAdmissionBatch(client, [{ ...f.entry, recordDigest: "b".repeat(64) }], H), { status: 503 });
});

test("the shared empty replay equals the complete reader at real asOf regardless of identity lifecycle, registration reference, policy and gifts",async()=>{
  const f=original(),canonical=canonicalize({...f.prepared.record,executionKey:f.receipt.coverageExecutionKey});
  for(const asOf of [CUTOFF,ASOF,'2027-01-01T12:34:56.123456Z'])for(const lifecycle of ['ACTIVE','FROZEN','CANCELLED'])for(const sourceRef of [null,'registration:v1']){
    const queries:string[]=[];const c={async query(sql:string){queries.push(sql);if(sql.includes('directory-growth-subjects'))return {rows:[{userId:f.input.subjectUserId,sourceRef,migrated:true,normalTier:null,effectiveTier:null,blackGoldState:null,lastTierDropAt:null,accountStatus:lifecycle}]};
      if(sql.includes('directory-growth-policy'))return {rows:[{id:'policy',version:lifecycle==='ACTIVE'?'1':'2',policyPayload:{tiers:{STANDARD:{tenantDeposit:'ACCOUNT_BASE',depositAllowanceCents:'0'}}},haffRule:{}}]};
      if(sql.includes('directory-growth-entitlements'))return {rows:[{userId:f.input.subjectUserId,id:'gift',kind:'FRIEND',scopeKey:'game:fixture',gameId:'fixture',startsAt:'2026-01-01T00:00:00.000000Z',endsAt:lifecycle==='ACTIVE'?new Date(Date.parse(asOf)+86400000).toISOString():asOf,status:'ACTIVE',depositWaived:true,depositAllowanceCents:'0'}]};
      if(sql.includes('legacy-growth-schema'))return {rows:[{coverage:true,sources:true}]};
      if(sql.includes('legacy-growth-batch-versions'))return {rows:[{userId:f.input.subjectUserId,canonical,digest:sha256Hex(canonical)}]};
      if(/directory-growth-(contributions|sources)|legacy-growth-batch-live-sources/.test(sql))return {rows:[]};throw Error('UNEXPECTED_EMPTY_REPLAY_FIXTURE');}} as unknown as PoolClient;
    const full=(await readMembershipGrowthBatch(c,[f.input.subjectUserId],asOf)).get(f.input.subjectUserId)!,shared=projectAdmittedEmptyGrowthTier(f.input.subjectUserId,asOf);
    assert.deepEqual(shared.growth,{knowledge:full.growth.knowledge,asOfUtc:full.growth.asOfUtc,effectiveTier:full.growth.effectiveTier});assert.equal(full.entitlements[0]!.status,lifecycle==='ACTIVE'?'ACTIVE':'EXPIRED');
    assert.equal(queries.some(sql=>sql.includes('user_identity_state')),false,'lifecycle is a transaction/auth gate, not a growth-tier factor');
  }
});

test("even future or VOID events and an empty growth-state row prevent sharing an empty replay",()=>{
  const f=fixture();f.db.exec('ALTER TABLE zzsh_iam.membership_growth_contribution ADD COLUMN state TEXT;ALTER TABLE zzsh_iam.membership_growth_contribution ADD COLUMN effective_at TEXT;');
  f.db.prepare('INSERT INTO zzsh_iam.membership_growth_contribution VALUES(?,?,?)').run(f.entry.subjectUserId,'VOID','2028-01-01T00:00:00.000000Z');assert.equal(f.eligible().length,0);f.db.exec('DELETE FROM zzsh_iam.membership_growth_contribution');
  f.db.prepare('INSERT INTO zzsh_iam.membership_growth_state VALUES(?)').run(f.entry.subjectUserId);assert.equal(f.eligible().length,0);f.db.close();
});
