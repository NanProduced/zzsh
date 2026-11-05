import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDistributionCoreReadback, assertDistributionPolicyReceipt, assertDistributionSourceBindings, assertHistoricalFinancePopulation, assertHistoricalFinanceUnchanged, assertNewDistributionTarget, assertQualificationAuthority, assertQualificationBatches, assertQualificationPlanBinding, assertQualificationPolicy, assertQualificationReadback, assertRegisteredDistributionTarget, buildLegacyQualificationPlan, isolatedDistributionBuild, legacyDistributionPolicy, privateDistributionPath, reviewedDistributionActor } from "./local-distribution-qualification-plan.mjs";
import { resolve } from "node:path";

const digest = "a".repeat(64);
const canonicalize = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const flags = { open: "1", level: "1", openCondition: "1", isSelfRebate: "0", settlementTiming: "1", settlementTime: "7.0" };
const policy = () => legacyDistributionPolicy({ scope: "LOCAL_CONTROLLED", receiptSha256: digest, configurationSha256: digest, levelsSha256: digest,
  configuration: Object.entries(flags).map(([name, value]) => ({ name, value, is_delete: "0" })),
  rawLevels: [{ id: "1", weights: "1", is_default: "1", first_ratio: "20.00", second_ratio: "20.00", name: "青铜", is_delete: "0" }] });
const source = { receiptSha256: digest };
const fact = (userId, eligibility = "ELIGIBLE") => ({ userId, eligibility, commissionFrozen: false, levelId: "1", digest });
const project = (s, f, d) => { assert.equal(s.receiptSha256, digest); assert.equal(f.digest, d); return f; };
const row = (id, eligibility = "UNKNOWN") => ({ user_id: id, source_digest: digest, revision: "1", eligibility, commission_frozen: false, level_code: null, policy_version_id: null });
const plan = (participants, facts, extra = {}) => buildLegacyQualificationPlan({ participants, packets: [{ source, facts }], payload: policy(), sourceDigest: digest, canonicalize, projectQualification: project, expectedParticipants: participants.length, ...extra });

test("API build must be isolated under this worktree rather than the served dist", () => {
  const root = resolve("."), build = resolve(root, "tmp/r05-local-review-20261105/api/dist/src");
  assert.equal(isolatedDistributionBuild(root, build), build);
  assert.throws(() => isolatedDistributionBuild(root, resolve(root, "apps/api/dist/src")), /DISTRIBUTION_ISOLATED_BUILD_REQUIRED/);
  assert.throws(() => isolatedDistributionBuild(root, resolve(root, "tmp/../apps/api/dist/src")), /DISTRIBUTION_ISOLATED_BUILD_REQUIRED/);
});

test("sealed inputs must remain below the designated private root", () => {
 const root=resolve('synthetic-private-root');assert.equal(privateDistributionPath(root,resolve(root,'plan.json')),resolve(root,'plan.json'));
 assert.throws(()=>privateDistributionPath(root,resolve(root,'../outside.json')),/DISTRIBUTION_PRIVATE_PATH_REQUIRED/);
 assert.throws(()=>privateDistributionPath(root,'relative.json'),/DISTRIBUTION_PRIVATE_PATH_REQUIRED/);
});

test("R05 preview OID is refused even when other target fields are valid", () => {
  const target={oid:'3179610',nonce:'a'.repeat(24),migrationRoleOid:'42',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'};
  assert.throws(()=>assertNewDistributionTarget(target),/R05_PREVIEW_TARGET_PROTECTED/);
  assert.doesNotThrow(()=>assertNewDistributionTarget({...target,oid:'3179611'}));
  assert.throws(()=>assertNewDistributionTarget({...target,oid:'3179611',bootstrapReservation:'ROUND04_BOOTSTRAP_RESERVED'}),/R06_BOOTSTRAP_RESERVATION_REQUIRED/);
});

test("registration, source and scene must all bind to this R06 target", () => {
 const target={oid:'42',nonce:'a'.repeat(24),migrationRoleOid:'77',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'};
 const registry={database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:target.oid,nonce:target.nonce,roles:{migration:{oid:'77'}},protectedDataset:{bootstrapReservation:target.bootstrapReservation,manifestSha256:digest,epoch:{oid:target.oid,nonce:target.nonce}}};
 assert.doesNotThrow(()=>assertRegisteredDistributionTarget(target,digest,registry));
 assert.throws(()=>assertRegisteredDistributionTarget({...target,oid:'43'},digest,registry),/DISTRIBUTION_REGISTERED_TARGET_CHANGED/);
 assert.throws(()=>assertRegisteredDistributionTarget(target,'b'.repeat(64),registry),/DISTRIBUTION_REGISTERED_TARGET_CHANGED/);
 const capture={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{distributionConfig:{sha256:digest},distributionLevels:{sha256:digest}}};
 const scene={sourceReceiptSha256:digest,domains:{users:{ready:1}}},candidate={source:{receiptSha256:digest,configurationSha256:digest,levelsSha256:digest}};
 assert.doesNotThrow(()=>assertDistributionSourceBindings(digest,capture,scene,candidate));
 assert.throws(()=>assertDistributionSourceBindings(digest,capture,{...scene,sourceReceiptSha256:'other'},candidate),/DISTRIBUTION_SOURCE_CAPTURE_REQUIRED/);
 assert.throws(()=>assertDistributionSourceBindings(digest,capture,scene,{source:{...candidate.source,levelsSha256:'other'}}),/DISTRIBUTION_CANDIDATE_SOURCE_CHANGED/);
});

test("financial baseline requires the completed round and its exact independent readback", () => {
 const target={oid:'42',nonce:'a'.repeat(24)},binding={roundInputSha256:digest,readbackSha256:digest,datasetSha256:digest,sourceSha256:digest,target};
 const round={schema:'zzsh.local-round-receipt.v1',inputSha256:digest,datasetSha256:digest,sourceReceiptSha256:digest,target,status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',completion:{status:'COMPLETE',dataset:'PASS'},finishedAt:'2026-11-05T00:00:00Z',stages:[{name:'readback',status:'ACK',code:0,signal:null,metrics:{evidenceSha256:digest}}]};
 const readback={schema:'zzsh.local-dataset-readback.v1',status:'CORE_SOURCE_TARGET_EXACT_READBACK_PASSED',sourceDatasetSha256:digest,resource:{database:'zzsh_test_regression',...target},differenceCount:0,targetWrites:0,rollbackConfirmed:true,lockReleased:true,connectionsClosed:true,financialHistory:{walletEffectsFromObservation:false,arrivalVerified:false,counts:{orders:{expected:3,readable:3},refunds:{expected:2,readable:2}}}};
 assert.equal(assertDistributionCoreReadback(round,readback,binding),5);
 for(const changed of [{...round,status:'RUNNING'},{...round,completion:{status:'INCOMPLETE',dataset:'PASS'}},{...round,target:{...target,oid:'43'}},{...round,stages:[{...round.stages[0],metrics:{evidenceSha256:'b'.repeat(64)}}]}])
   assert.throws(()=>assertDistributionCoreReadback(changed,readback,binding),/DISTRIBUTION_COMPLETED_ROUND_REQUIRED/);
 for(const changed of [{...readback,resource:{...readback.resource,nonce:'b'.repeat(24)}},{...readback,differenceCount:1},{...readback,lockReleased:false}])
   assert.throws(()=>assertDistributionCoreReadback(round,changed,binding),/DISTRIBUTION_CORE_READBACK_REQUIRED/);
 assert.throws(()=>assertDistributionCoreReadback(round,{...readback,financialHistory:undefined},binding),/DISTRIBUTION_FINANCIAL_READBACK_REQUIRED/);
 assert.throws(()=>assertDistributionCoreReadback(round,{...readback,financialHistory:{...readback.financialHistory,counts:{orders:{expected:3,readable:2}}}},binding),/DISTRIBUTION_FINANCIAL_READBACK_REQUIRED/);
 const empty={...readback,financialHistory:{...readback.financialHistory,counts:{}}};
 assert.equal(assertDistributionCoreReadback(round,empty,binding),0);
 assert.doesNotThrow(()=>assertHistoricalFinancePopulation([],0));
 assert.doesNotThrow(()=>assertHistoricalFinancePopulation([{count:'3'},{count:'2'}],5));
 assert.throws(()=>assertHistoricalFinancePopulation([],5),/DISTRIBUTION_FINANCIAL_POPULATION_CHANGED/);
 assert.throws(()=>assertHistoricalFinancePopulation([{count:'5x'}],5),/DISTRIBUTION_FINANCIAL_POPULATION_CHANGED/);
});

test("policy is reconstructed from old settings and refuses missing or duplicate critical settings", () => {
  assert.equal(policy().config.levels[0].renterPercent, "20.00");
  const input = { scope: "NATIVE", receiptSha256: digest, configurationSha256: digest, levelsSha256: digest, configuration: [], rawLevels: [] };
  assert.throws(() => legacyDistributionPolicy(input), /LEGACY_DISTRIBUTION_SETTING_CHANGED/);
  const original = Object.entries(flags).map(([name, value]) => ({ name, value, is_delete: "0" }));
  assert.throws(() => legacyDistributionPolicy({ ...input, configuration: [...original, original[0]] }), /DUPLICATE_LEGACY_DISTRIBUTION_SETTING/);
});

test("planning distinguishes eligible, already admitted, ineligible and unverifiable subjects", () => {
  const initial = plan([row("a"), row("b", "INELIGIBLE"), row("c")], [fact("a"), fact("b", "INELIGIBLE"), { ...fact("c"), digest: "b".repeat(64) }]);
  assert.equal(initial.accepted.length, 1); assert.equal(initial.ineligible.length, 1);
  assert.deepEqual(initial.exceptions.map(x => x.reason), ["ORIGINAL_FACT_DIGEST_DIFFERS"]);
  const done = row("a", "ELIGIBLE"); done.level_code = "legacy_1"; done.policy_version_id = initial.policyId;
  assert.equal(plan([done], [fact("a")]).existing.length, 1);
  done.commission_frozen = true;
  assert.equal(plan([done], [fact("a")]).exceptions[0].reason, "CURRENT_PARTICIPANT_FACT_DIFFERS");
});

test("planning binds entire source population and uses bounded deterministic batches", () => {
  const participants = Array.from({ length: 2001 }, (_, i) => row(`u${i}`));
  const facts = participants.map(r => fact(r.user_id));
  const result = plan(participants, facts);
  assert.deepEqual(result.batches.map(b => b.body.subjects.length), [1000, 1000, 1]);
  assert.equal(new Set(result.batches.map(b => b.bodyDigest)).size, 3);
  assert.doesNotThrow(() => assertQualificationBatches(result, canonicalize));
  result.batches[1].body.subjects.pop();
  assert.throws(() => assertQualificationBatches(result, canonicalize), /DISTRIBUTION_BATCH_CHANGED/);
  assert.throws(() => plan(participants, [...facts, facts[0]]), /LEGACY_AUDIT_SUBJECT_DUPLICATE/);
  assert.throws(() => plan(participants, facts, { expectedParticipants: 2002 }), /LEGACY_PARTICIPANT_POPULATION_CHANGED/);
  assert.equal(plan([row("a")], [fact("a"), fact("extra")]).exceptions[0].reason, "TARGET_PARTICIPANT_MISSING");
});

test("independent readback requires exact source, status, revision and unchanged ineligible records", () => {
  const before = plan([row("a"), row("b", "INELIGIBLE")], [fact("a"), fact("b", "INELIGIBLE")]);
  const admitted = row("a", "ELIGIBLE"); admitted.level_code = "legacy_1"; admitted.policy_version_id = before.policyId; admitted.revision = "2";
  const after = plan([admitted, row("b", "INELIGIBLE")], [fact("a"), fact("b", "INELIGIBLE")]);
  assert.doesNotThrow(() => assertQualificationReadback(before, after));
  after.existing[0].revision = "3";
  assert.throws(() => assertQualificationReadback(before, after), /QUALIFICATION_READBACK_SUBJECT_CHANGED/);
});

test("plans and execution windows reject another target, changed build, or broadened authority", () => {
  const base = plan([row("a")], [fact("a")]);
  const target = { oid: "12", nonce: "c".repeat(24), database: "zzsh_test_regression", marker: "marker", migrationRoleOid: "13" };
  const binding = { inputSha256: digest, datasetSha256: digest, sourceDigest: digest, candidateSha256: digest, scope: "LOCAL_CONTROLLED", target, expectedParticipants: 1, buildDigest: digest, toolFiles: { tool: digest } };
  const signed = { ...base, schema: "zzsh.local-distribution-qualification-plan.v1", ...binding, readOnlyRollbackAck: true, clientClosed: true, headCompatible: true };
  assert.doesNotThrow(() => assertQualificationPlanBinding(signed, binding, canonicalize));
  assert.throws(() => assertQualificationPlanBinding(signed, { ...binding, target: { ...target, oid: "14" } }, canonicalize), /DISTRIBUTION_PLAN_BINDING_CHANGED/);
  assert.throws(() => assertQualificationPlanBinding(signed, { ...binding, buildDigest: "b".repeat(64) }, canonicalize), /DISTRIBUTION_PLAN_BINDING_CHANGED/);
  assert.throws(() => assertQualificationPlanBinding(signed, { ...binding, expectedParticipants: 2 }, canonicalize), /DISTRIBUTION_PLAN_POPULATION_CHANGED/);
  assert.throws(() => assertQualificationPlanBinding({ ...signed, existing: [{ userId:'previous' }] }, { ...binding, expectedParticipants: 2 }, canonicalize), /ORIGINAL_QUALIFICATION_PLAN_REQUIRED/);
  const changed = structuredClone(signed); changed.approvalBody.payload.config.levels[0].renterPercent = "99.00";
  assert.throws(() => assertQualificationPolicy(changed, signed, canonicalize), /DISTRIBUTION_PLAN_POLICY_CHANGED/);
  const now = Date.parse("2026-11-05T00:15:00.000Z"), window = { notBefore: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T00:30:00.000Z" };
  const bound = { ...binding, policyId: signed.policyId, policyDigest: signed.policyDigest, planSha256: digest, window };
  const authority = { schema: "root-reviewed-legacy-distribution-qualification.v2", approvedBy: "Root", status: "APPROVED", ...bound, lock: 806006, allowFinancialWrites: false, ...window };
  assert.doesNotThrow(() => assertQualificationAuthority(authority, bound, now));
  assert.throws(() => assertQualificationAuthority({ ...authority, target: { ...target, nonce: "d".repeat(24) } }, bound, now), /DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED/);
  assert.throws(() => assertQualificationAuthority({ ...authority, allowFinancialWrites: true }, bound, now), /DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED/);
  assert.throws(() => assertQualificationAuthority(authority, bound, Date.parse("2026-11-05T00:31:00.000Z")), /DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED/);
});

test("qualification actor is bound to the same database epoch and approved session", () => {
  const target = { oid: "12", nonce: "a".repeat(24) }, file = { realm: "admin", resourceOid: "12", nonce: target.nonce, actorId: "boss", sessionId: "session" }, approved = { userId: "boss", sessionId: "session", requestId: "local-request" };
  assert.deepEqual(reviewedDistributionActor(file, target, approved), { userId: "boss", sessionId: "session", requestId: "local-request" });
  assert.throws(() => reviewedDistributionActor({ ...file, resourceOid: "13" }, target, approved), /DISTRIBUTION_ACTOR_CHANGED/);
  assert.throws(() => reviewedDistributionActor(file, target, { ...approved, sessionId: "other" }), /DISTRIBUTION_ACTOR_CHANGED/);
});

test("historical finance baselines must be unchanged and cannot be omitted", () => {
 const before=[{source_kind:'HISTORICAL_DISTRIBUTION',count:'12',digest:'a'.repeat(64)}];
 assert.doesNotThrow(()=>assertHistoricalFinanceUnchanged(before,structuredClone(before),canonicalize));
 assert.throws(()=>assertHistoricalFinanceUnchanged(before,[{...before[0],digest:'b'.repeat(64)}],canonicalize),/HISTORICAL_FINANCE_CHANGED/);
 assert.throws(()=>assertHistoricalFinanceUnchanged(undefined,[],canonicalize),/HISTORICAL_FINANCE_CHANGED/);
});

test("qualification requires the same target's successful two-Boss policy receipt", () => {
 const history=[{source_kind:'HISTORICAL_DISTRIBUTION',count:'1',digest:'a'.repeat(64)}], target={oid:'42',nonce:'b'.repeat(24)};
 const binding={policyId:'policy',inputSha256:digest,datasetSha256:digest,sourceDigest:digest,target,historicalFinance:history};
 const receipt={status:'NATIVE_POLICY_APPROVED_READBACK_PASSED',policyId:'policy',policyActive:true,inputSha256:digest,datasetSha256:digest,sourceDigest:digest,target,financialWrites:0,lockReleased:true,lockClientClosed:true,clientsClosed:true,historicalFinanceBaseline:history,historicalFinanceReadback:history,steps:['decision','execute','approval-readback'].map(step=>({step,status:200}))};
 assert.doesNotThrow(()=>assertDistributionPolicyReceipt(receipt,binding,canonicalize));
 assert.throws(()=>assertDistributionPolicyReceipt({...receipt,target:{...target,oid:'43'}},binding,canonicalize),/DISTRIBUTION_APPROVAL_RECEIPT_REQUIRED/);
 assert.throws(()=>assertDistributionPolicyReceipt({...receipt,steps:receipt.steps.slice(0,2)},binding,canonicalize),/DISTRIBUTION_APPROVAL_RECEIPT_REQUIRED/);
 assert.throws(()=>assertDistributionPolicyReceipt({...receipt,historicalFinanceReadback:[]},binding,canonicalize),/HISTORICAL_FINANCE_CHANGED/);
});
