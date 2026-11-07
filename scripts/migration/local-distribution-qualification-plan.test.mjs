import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDistributionCoreReadback, assertDistributionPolicyReceipt, assertDistributionSourceBindings, assertDistributionRepairBuild, assertDistributionOptimizedBuild, assertDistributionRepairGuard, assertQualificationRecoveryEvidence, assertQualificationRenewalEvidence, assertQualificationConstraintRetryEvidence, assertHistoricalFinancePopulation, assertHistoricalFinanceUnchanged, assertNewDistributionTarget, assertQualificationAuthority, assertQualificationBatches, assertQualificationPlanBinding, assertQualificationPolicy, assertQualificationReadback, assertRegisteredDistributionTarget, buildLegacyQualificationPlan, isolatedDistributionBuild, legacyDistributionPolicy, privateDistributionPath, reviewedDistributionActor } from "./local-distribution-qualification-plan.mjs";
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

test('recovery build may change only the reviewed distribution policy guard',()=>{
 const base={'finance/distribution-policy-store.js':digest,'auth/auth-security.js':digest},repair={...base,'finance/distribution-policy-store.js':'b'.repeat(64)};
 assert.doesNotThrow(()=>assertDistributionRepairBuild(base,repair));
 assert.throws(()=>assertDistributionRepairBuild(base,base),/DISTRIBUTION_REPAIR_BUILD_SCOPE_CHANGED/);
 assert.throws(()=>assertDistributionRepairBuild(base,{...repair,'auth/auth-security.js':'c'.repeat(64)}),/DISTRIBUTION_REPAIR_BUILD_SCOPE_CHANGED/);
 assert.throws(()=>assertDistributionRepairBuild(base,{'finance/distribution-policy-store.js':'b'.repeat(64)}),/DISTRIBUTION_REPAIR_BUILD_FILE_SET_CHANGED/);
});

test('renewed build changes only the original policy guard and qualification index',()=>{
 const base={'finance/distribution-policy-store.js':digest,'finance/legacy-invitation-facts-maintenance.js':digest,'auth/auth-security.js':digest},optimized={...base,'finance/distribution-policy-store.js':'b'.repeat(64),'finance/legacy-invitation-facts-maintenance.js':'c'.repeat(64)};
 assert.doesNotThrow(()=>assertDistributionOptimizedBuild(base,optimized));
 for(const value of [base,{...optimized,'auth/auth-security.js':'d'.repeat(64)},{...optimized,'finance/legacy-invitation-facts-maintenance.js':digest}])assert.throws(()=>assertDistributionOptimizedBuild(base,value));
});

test('recovery guard proof binds the exact cluster, owner and both database roles',()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'},target={oid:'42',nonce:'b'.repeat(24),instance},registry={database:'zzsh_test_regression',owner:'zzsh',ownerOid:'10',marker:'marker',migrationRole:'migration',migrationRoleOid:'11',runtimeRole:'runtime',runtimeRoleOid:'12'};
 const checks=Object.fromEntries(['exact','wrongPort','wrongCluster','wrongOid','wrongRoleOid','wrongNonce','wrongOwnerOid','missingInstance'].map(k=>[k,true]));
 const probe={schema:'zzsh.round07-distribution-repair-guard.v2',status:'EXACT_TARGET_ACCEPTED_AND_DRIFT_REJECTED',target:{...target,...registry},moduleSha256:digest,checks,rollbackAck:true,unlockAck:true,connectionsClosed:true,targetWrites:0};
 const args={target,registry,moduleSha256:digest};assert.doesNotThrow(()=>assertDistributionRepairGuard(probe,args));
 for(const changed of [{...probe,target:{...probe.target,instance:{...instance,systemIdentifier:'9'}}},{...probe,target:{...probe.target,ownerOid:'20'}},{...probe,checks:{...checks,wrongPort:false}},{...probe,targetWrites:1}])assert.throws(()=>assertDistributionRepairGuard(changed,args),/DISTRIBUTION_REPAIR_GUARD_UNCONFIRMED/);
});

test('qualification recovery requires the exact rolled-back first attempt and unchanged preimage',()=>{
 const target={oid:'42',nonce:'b'.repeat(24),instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}},refs=Object.fromEntries(['failure','inspection','guard','previousPlan','previousInput','previousAuthority'].map(k=>[k,{sha256:digest}]));
 const historicalFinance=[{source_kind:'HISTORICAL_PAYMENT',count:'1',digest}],oldPlan={inputSha256:digest,policyId:'p',policyDigest:digest,accepted:[{userId:'u'}],existing:[],ineligible:[],unresolved:[],exceptions:[],batches:[{bodyDigest:digest}],historicalFinance},plan={...oldPlan,toolFiles:{'local-distribution-qualification-runner.mjs':digest}};
 const previousInput={dataset:{sha256:digest},source:{sha256:digest},target,buildFiles:{a:digest}},input={...previousInput,window:{notBefore:'2026-01-01T00:01:00.000Z',expiresAt:'2026-01-01T00:10:00.000Z'}};
 const previousAuthority={inputSha256:digest,planSha256:digest,notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-01T00:15:00.000Z'};
 const failure={status:'STOPPED',mode:'--execute',inputSha256:digest,transaction:{status:'ROLLBACK_ACKNOWLEDGED'},rollbackAck:true,lockReleased:true,clientsClosed:true,lockClientClosed:true,financialWrites:0,pending:null,batches:[],failedBatch:{bodyDigest:digest},error:{code:'FORBIDDEN'}};
 const inspection={schema:'zzsh.round07-distribution-qualification-rollback-inspection.v1',status:'READ_ONLY_POST_ROLLBACK_INSPECTED',failureSha256:digest,planSha256:digest,target,batchCount:0,firstFailed:true,guard:{code:'FORBIDDEN'},mismatch:{accepted:0,ineligible:0,unresolved:0},counts:{participants:1,receipts:0,audits:0,policy_heads:1},rollbackAck:true,unlockAck:true,connectionsClosed:true,targetWrites:0};
 const checks=Object.fromEntries(['exact','wrongPort','wrongCluster','wrongOid','wrongRole','wrongRoleOid','wrongOwner','wrongMarker','wrongReadOnly'].map(k=>[k,true]));
 const guard={schema:'zzsh.round07-qualification-repair-guard.v2',status:'EXACT_READ_ONLY_TARGET_ACCEPTED_AND_DRIFT_REJECTED',sourcePlanSha256:digest,runnerSha256:digest,target,checks,actualTransaction:'READ_ONLY',admissionMode:'recover',notAWriteOrCommitProof:true,rollbackAck:true,unlockAck:true,connectionsClosed:true,targetWrites:0};
 const args={failure,inspection,guard,previousPlan:oldPlan,previousInput,previousAuthority,plan,input,refs,canonicalize};assert.equal(assertQualificationRecoveryEvidence(args).status,'ROLLED_BACK_QUALIFICATION_ATTEMPT_BOUND');
 for(const bad of [{...args,failure:{...failure,rollbackAck:false}},{...args,inspection:{...inspection,counts:{...inspection.counts,receipts:1}}},{...args,guard:{...guard,checks:{...checks,wrongPort:false}}},{...args,plan:{...plan,accepted:[]}},{...args,input:{...input,window:{...input.window,expiresAt:'2026-01-01T00:20:00.000Z'}}}])assert.throws(()=>assertQualificationRecoveryEvidence(bad));
});

test('a renewed window binds every uncommitted batch, acknowledged rollback, preimage and exact optimized build',()=>{
 const target={oid:'42',nonce:'b'.repeat(24),migrationRoleOid:'11',instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}},refs=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority'].map(k=>[k,{sha256:digest}]));
 const historicalFinance=[{source_kind:'HISTORICAL_PAYMENT',count:'1',digest}],batches=[{bodyDigest:'1',body:{subjects:[{userId:'u'}]}},{bodyDigest:'2',body:{subjects:[{userId:'v'}]}}];
 const previousPlan={inputSha256:digest,target:{...target,database:'zzsh_test_regression',marker:'m'},policyId:'p',policyDigest:digest,accepted:[{userId:'u'},{userId:'v'}],existing:[],ineligible:[],unresolved:[],exceptions:[],batches,historicalFinance},plan={...previousPlan};
 const previousInput={dataset:{sha256:digest},source:{sha256:digest},actor:{sha256:digest},target,buildFiles:{'finance/distribution-policy-store.js':'b'.repeat(64),'finance/legacy-invitation-facts-maintenance.js':digest}};
 const input={...previousInput,apiDist:'build',buildFiles:{...previousInput.buildFiles,'finance/legacy-invitation-facts-maintenance.js':'c'.repeat(64)},window:{notBefore:'2026-01-01T00:20:00.000Z'}};
 const previousAuthority={inputSha256:digest,planSha256:digest,expiresAt:'2026-01-01T00:15:00.000Z'};
 const failure={status:'STOPPED',mode:'--execute',inputSha256:digest,target,transaction:{status:'ROLLBACK_ACKNOWLEDGED',plannedBatches:2},recoveryPreflight:{status:'ORIGINAL_QUALIFICATION_PREIMAGE_RECHECKED'},rollbackAck:true,lockReleased:true,clientsClosed:true,lockClientClosed:true,financialWrites:0,batches:[{status:'ACK_IN_OPEN_TRANSACTION',bodyDigest:'1',participants:1}],failedBatch:{bodyDigest:'2'},error:{code:'FORBIDDEN'},finishedAt:'2026-01-01T00:15:01.000Z'};
 const inspection={schema:'zzsh.r07-qualification-renewal-preimage.v1',status:'ALL_QUALIFICATION_PREIMAGE_UNCHANGED',previous:{plan:digest,input:digest,authority:digest,failure:digest},target:{...target,database:'zzsh_test_regression',marker:'m',roleOid:'11'},counts:{participants:2,receipts:0,audits:0,policy_heads:1},mismatches:{accepted:0,ineligible:0,unresolved:0},rollbackAck:true,clientClosed:true,targetWrites:0};
 const buildManifest={status:'REVIEW_ONLY_BUILD_SEALED',build:'build',buildFiles:input.buildFiles,changedFromPrevious:['finance/legacy-invitation-facts-maintenance.js'],targetWrites:0,authorityCreated:false};
 const args={failure,inspection,previousPlan,previousInput,previousAuthority,buildManifest,plan,input,refs,canonicalize};assert.equal(assertQualificationRenewalEvidence(args).rolledBackBatches,1);
 for(const bad of [{...args,failure:{...failure,rollbackAck:false}},{...args,failure:{...failure,batches:[{...failure.batches[0],status:'COMMIT_ACKNOWLEDGED'}]}},{...args,inspection:{...inspection,counts:{...inspection.counts,receipts:1}}},{...args,inspection:{...inspection,target:{...inspection.target,nonce:'other'}}},{...args,plan:{...plan,accepted:[]}},{...args,input:{...input,window:{notBefore:'2026-01-01T00:10:00.000Z'}}},{...args,buildManifest:{...buildManifest,targetWrites:1}}])assert.throws(()=>assertQualificationRenewalEvidence(bad));
});

test('constraint timeout retry requires all rolled-back keys, 0161 commit and independent unchanged preimage',()=>{
 const target={oid:'42',nonce:'b'.repeat(24),instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}},refs=Object.fromEntries(['failure','inspection','previousPlan','previousInput','previousAuthority','priorRecoveryInput','upgradePlan','upgradeExecution','upgradeReadback','buildManifest'].map(k=>[k,{sha256:digest}]));
 const history=[{source_kind:'HISTORICAL_PAYMENT',count:'1',digest}],batches=Array.from({length:175},(_,i)=>({bodyDigest:'b'+i,body:{subjects:[{userId:'u'+i}]}}));
 const previousPlan={inputSha256:digest,target,policyId:'p',policyDigest:digest,accepted:[{userId:'u'}],existing:[],ineligible:[],unresolved:[],exceptions:[],batches,historicalFinance:history},plan={...previousPlan};
 const previousInput={target,dataset:{sha256:digest},source:{sha256:digest},actor:{sha256:digest},buildFiles:{x:digest},distribution:{qualificationRenewal:{previousInput:{sha256:digest}}}},input={...previousInput,apiDist:'build',window:{notBefore:'2026-01-01T00:20:00.000Z'}};
 const previousAuthority={inputSha256:digest,planSha256:digest,expiresAt:'2026-01-01T00:15:00.000Z'},priorRecoveryInput={distribution:{qualificationRecovery:{previousInput:{sha256:digest}}}};
 const failure={status:'STOPPED',mode:'--execute',inputSha256:digest,error:{code:'57014'},target,transaction:{status:'ROLLBACK_ACKNOWLEDGED'},rollbackAck:true,lockReleased:true,clientsClosed:true,financialWrites:0,batches:batches.map(x=>({bodyDigest:x.bodyDigest,participants:1,status:'ACK_IN_OPEN_TRANSACTION'}))};
 const counts={participants:174846,receipts:0,audits:0,policy_heads:1},mismatches={accepted:0,ineligible:0,unresolved:0},inspection={schema:'zzsh.r07-qualification-constraint-analysis.v1',status:'READ_ONLY_CONSTRAINT_ANALYSIS_COMPLETE',previous:{plan:digest,input:digest,authority:digest,failure:digest},target,settings:{statement_timeout:'30s'},preimage:{counts,mismatches},rollbackAck:true,clientClosed:true,targetWrites:0};
 const upgradePlan={status:'READ_ONLY_PREPARED',target,migrationSha256:digest,expectedFunctionSha256:digest},upgradeExecution={status:'UPGRADE_READBACK_PASSED',commitAck:true,readbackRollbackAck:true,unlockAck:true,clientClosed:true,financialWrites:0};
 const upgradeReadback={status:'EXACT_0161_AND_PREIMAGE_READBACK_PASSED',inputs:{plan:digest,execution:digest,qualificationPlan:digest,qualificationInput:digest},target,lastMigrationSha256:digest,functionSha256:digest,preimage:{counts,mismatches},readOnlyRollbackAck:true,clientClosed:true,targetWrites:0};
 const buildManifest={status:'REVIEW_ONLY_BUILD_SEALED',build:'build',buildFiles:input.buildFiles,targetWrites:0,authorityCreated:false},args={failure,inspection,previousPlan,previousInput,previousAuthority,priorRecoveryInput,upgradePlan,upgradeExecution,upgradeReadback,buildManifest,plan,input,refs,canonicalize};
 assert.equal(assertQualificationConstraintRetryEvidence(args).rolledBackBatches,175);
 for(const bad of [{...args,failure:{...failure,rollbackAck:false}},{...args,failure:{...failure,batches:failure.batches.slice(1)}},{...args,upgradeExecution:{...upgradeExecution,commitAck:false}},{...args,upgradeReadback:{...upgradeReadback,preimage:{counts:{...counts,receipts:1},mismatches}}},{...args,plan:{...plan,accepted:[]}},{...args,input:{...input,window:{notBefore:'2026-01-01T00:10:00.000Z'}}}])assert.throws(()=>assertQualificationConstraintRetryEvidence(bad));
});

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
  assert.throws(()=>assertNewDistributionTarget({...target,oid:'3179611',bootstrapReservation:'ROUND04_BOOTSTRAP_RESERVED'}),/LOCAL_BOOTSTRAP_RESERVATION_REQUIRED/);
  assert.doesNotThrow(()=>assertNewDistributionTarget({...target,oid:'3179611',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'}));
});

test("registration, source and scene must all bind to this R06 target", () => {
 const target={oid:'42',nonce:'a'.repeat(24),migrationRoleOid:'77',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'};
 const registry={database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:target.oid,nonce:target.nonce,roles:{migration:{oid:'77'}},protectedDataset:{bootstrapReservation:target.bootstrapReservation,manifestSha256:digest,epoch:{oid:target.oid,nonce:target.nonce}}};
 assert.doesNotThrow(()=>assertRegisteredDistributionTarget(target,digest,registry));
 assert.throws(()=>assertRegisteredDistributionTarget({...target,oid:'43'},digest,registry),/DISTRIBUTION_REGISTERED_TARGET_CHANGED/);
 assert.throws(()=>assertRegisteredDistributionTarget(target,'b'.repeat(64),registry),/DISTRIBUTION_REGISTERED_TARGET_CHANGED/);
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'};
 assert.doesNotThrow(()=>assertRegisteredDistributionTarget({...target,instance},digest,{...registry,instance}));
 assert.throws(()=>assertRegisteredDistributionTarget({...target,instance},digest,{...registry,instance:{...instance,systemIdentifier:'456'}}),/DISTRIBUTION_REGISTERED_TARGET_CHANGED/);
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
 assert.throws(()=>assertDistributionCoreReadback(round,readback,{...binding,target:{...target,instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}}}),/DISTRIBUTION_CORE_READBACK_REQUIRED/);
 for(const changed of [{...round,status:'RUNNING'},{...round,completion:{status:'INCOMPLETE',dataset:'PASS'}},{...round,target:{...target,oid:'43'}},{...round,stages:[{...round.stages[0],metrics:{evidenceSha256:'b'.repeat(64)}}]}])
   assert.throws(()=>assertDistributionCoreReadback(changed,readback,binding),/DISTRIBUTION_COMPLETED_ROUND_REQUIRED/);
 for(const changed of [{...readback,resource:{...readback.resource,nonce:'b'.repeat(24)}},{...readback,differenceCount:1},{...readback,lockReleased:false}])
   assert.throws(()=>assertDistributionCoreReadback(round,changed,binding),/DISTRIBUTION_CORE_READBACK_REQUIRED/);
 assert.throws(()=>assertDistributionCoreReadback(round,{...readback,financialHistory:undefined},binding),/DISTRIBUTION_FINANCIAL_READBACK_REQUIRED/);
 assert.throws(()=>assertDistributionCoreReadback(round,{...readback,financialHistory:{...readback.financialHistory,counts:{orders:{expected:3,readable:2}}}},binding),/DISTRIBUTION_FINANCIAL_READBACK_REQUIRED/);
 const resumedNames=['schema-preflight','readback','growth-prepare','growth-attempt-reservation','growth-apply','growth-readback','readback-final'];
 const resumed={...round,status:'DATASET_AND_GROWTH_REVALIDATED_PASS',mode:'RESUME_GROWTH',prior:{proof:{status:'ORIGINAL_COMPLETE_CHECKPOINT_BOUND'},previousInput:{sha256:digest},previousReceipt:{sha256:digest},checkpoint:{sha256:digest}},stages:resumedNames.map(name=>({name,status:'ACK',code:0,signal:null,metrics:{evidenceSha256:digest}}))};
 assert.equal(assertDistributionCoreReadback(resumed,readback,binding),5);
 const broken=structuredClone(resumed);broken.stages[4].status='INTENT';assert.throws(()=>assertDistributionCoreReadback(broken,readback,binding),/DISTRIBUTION_COMPLETED_ROUND_REQUIRED/);
 const wrongFinal=structuredClone(resumed);wrongFinal.stages[6].metrics.evidenceSha256='c'.repeat(64);assert.throws(()=>assertDistributionCoreReadback(wrongFinal,readback,binding),/DISTRIBUTION_COMPLETED_ROUND_REQUIRED/);
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

test("missing source qualification stays UNKNOWN without blocking verified subjects or entering write batches", () => {
  const missingFact = { ...fact("missing", "UNKNOWN"), qualificationSource: null, commissionFrozen: null, levelId: null };
  const missingRow = { ...row("missing"), commission_frozen: null };
  const before = plan([row("a"), missingRow], [fact("a"), missingFact]);
  assert.equal(before.exceptions.length, 0);
  assert.deepEqual(before.unresolved, [{ userId: "missing", sourceDigest: digest, revision: "1", frozen: null, reason: "ORIGINAL_QUALIFICATION_MISSING" }]);
  assert.deepEqual(before.batches.flatMap(batch => batch.body.subjects.map(subject => subject.userId)), ["a"]);
  const admitted = { ...row("a", "ELIGIBLE"), level_code: "legacy_1", policy_version_id: before.policyId, revision: "2" };
  const after = plan([admitted, missingRow], [fact("a"), missingFact]);
  assert.doesNotThrow(() => assertQualificationReadback(before, after));
  const changed = structuredClone(after); changed.unresolved[0].revision = "2";
  assert.throws(() => assertQualificationReadback(before, changed), /QUALIFICATION_READBACK_UNRESOLVED_CHANGED/);
  for (const changedRow of [{ ...missingRow, eligibility: "ELIGIBLE" }, { ...missingRow, level_code: "legacy_1" }, { ...missingRow, policy_version_id: before.policyId }])
    assert.equal(plan([changedRow], [missingFact]).exceptions[0].reason, "ORIGINAL_QUALIFICATION_UNKNOWN");
  assert.equal(plan([missingRow], [{ ...missingFact, qualificationSource: { id: "1" } }]).exceptions[0].reason, "ORIGINAL_QUALIFICATION_UNKNOWN");
  assert.equal(plan([missingRow], [{ ...missingFact, digest: "b".repeat(64) }]).exceptions[0].reason, "ORIGINAL_FACT_DIGEST_DIFFERS");
});

test("missing-source participants remain in the sealed population and cannot appear twice", () => {
  const missingFact = { ...fact("missing", "UNKNOWN"), qualificationSource: null, commissionFrozen: null, levelId: null };
  const base = plan([row("a"), { ...row("missing"), commission_frozen: null }], [fact("a"), missingFact]);
  const target = { oid: "12", nonce: "c".repeat(24), database: "zzsh_test_regression", marker: "marker", migrationRoleOid: "13" };
  const binding = { inputSha256: digest, datasetSha256: digest, sourceDigest: digest, candidateSha256: digest, scope: "LOCAL_CONTROLLED", target, expectedParticipants: 2, buildDigest: digest, toolFiles: { tool: digest } };
  const signed = { ...base, schema: "zzsh.local-distribution-qualification-plan.v1", ...binding, readOnlyRollbackAck: true, clientClosed: true, headCompatible: true };
  assert.doesNotThrow(() => assertQualificationPlanBinding(signed, binding, canonicalize));
  assert.throws(() => assertQualificationPlanBinding({ ...signed, unresolved: [] }, binding, canonicalize), /DISTRIBUTION_PLAN_POPULATION_CHANGED/);
  assert.throws(() => assertQualificationPlanBinding({ ...signed, unresolved: [{ ...signed.unresolved[0], userId: "a" }] }, binding, canonicalize), /DISTRIBUTION_PLAN_POPULATION_CHANGED/);
  assert.throws(() => assertQualificationPlanBinding({ ...signed, unresolved: [{ ...signed.unresolved[0], reason: "DEFAULT" }] }, binding, canonicalize), /DISTRIBUTION_UNRESOLVED_INVALID/);
});

test("plans and execution windows reject another target, changed build, or broadened authority", () => {
  const base = plan([row("a")], [fact("a")]);
  const target = { oid: "12", nonce: "c".repeat(24), database: "zzsh_test_regression", marker: "marker", migrationRoleOid: "13" };
  const binding = { inputSha256: digest, datasetSha256: digest, sourceDigest: digest, candidateSha256: digest, scope: "LOCAL_CONTROLLED", target, expectedParticipants: 1, buildDigest: digest, toolFiles: { tool: digest } };
  const signed = { ...base, schema: "zzsh.local-distribution-qualification-plan.v1", ...binding, readOnlyRollbackAck: true, clientClosed: true, headCompatible: true };
  assert.doesNotThrow(() => assertQualificationPlanBinding(signed, binding, canonicalize));
  const isolated = { host: '127.0.0.1', port: 55433, systemIdentifier: '12345' };
  assert.throws(() => assertQualificationPlanBinding(signed, { ...binding, target: { ...target, instance: isolated } }, canonicalize), /DISTRIBUTION_PLAN_BINDING_CHANGED/);
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
  assert.throws(() => assertQualificationAuthority(authority, { ...bound, target: { ...target, instance: isolated } }, now), /DISTRIBUTION_AUTHORITY_CHANGED_OR_EXPIRED/);
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
