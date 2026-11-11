import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertFinalLegacyBankSchema, assertLegacyBankKeyringProof, assertLegacyBankSourceProof, makeLegacyBankAuthority, makeR07BankSchemaEvidence, makeR07UpgradedBankSchemaEvidence, relativeBankSecretPath, requireFinalR06ApiDist, requireFinalR07ApiDist } from "./prepare-local-legacy-bank-input.mjs";

const input = { schema: "zzsh.local-legacy-bank-input.v1", target: { round: 6, databaseOid: 123 }, source: { sourceReceiptSha256: "a".repeat(64) },
  dataset: { sha256: "b".repeat(64) }, buildSha256: "c".repeat(64), schemaJournalSha256: "d".repeat(64), schemaHistorySha256: "e".repeat(64) };
const inputSha = "1".repeat(64), planSha = "2".repeat(64), window = { notBefore: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-05T01:00:00.000Z" };
const plan = { schema: "zzsh.local-legacy-bank-plan.v1", inputSha256: inputSha, datasetSha256: input.dataset.sha256, buildSha256: input.buildSha256,
  schemaJournalSha256: input.schemaJournalSha256, schemaHistorySha256: input.schemaHistorySha256, binding: { target: input.target, source: input.source },
  commitment: "3".repeat(64), counts: { ready: 7 } };

test("保护钥引用只转换为工作目录内 .secrets 相对路径，最终构建限定同根且拒绝链接", () => {
  const api = resolve("E:/zzsh/zzsh/apps/api"), key = join(api, ".secrets", "synthetic", "key.v1");
  assert.equal(relativeBankSecretPath(api, key), ".secrets/synthetic/key.v1");
  assert.throws(() => relativeBankSecretPath(api, resolve("E:/zzsh/zzsh/outside-key")));
  assert.throws(() => relativeBankSecretPath(api, join(api, ".secrets", "..unsafe", "key.v1")));
  assert.throws(() => relativeBankSecretPath(api, ".secrets/key.v1"));
  const root = resolve("D:/synthetic-r06/source"), expected = join(root, "apps/api/dist-r06-v3/src"), plain = () => ({ isSymbolicLink: () => false });
  assert.equal(requireFinalR06ApiDist(root, expected, plain), expected);
  assert.throws(() => requireFinalR06ApiDist(root, join(root, "apps/api/dist/src"), plain));
  assert.throws(() => requireFinalR06ApiDist(root, resolve("D:/another-source/apps/api/dist-r06-v3/src"), plain));
  assert.throws(() => requireFinalR06ApiDist(root, expected, p => ({ isSymbolicLink: () => p === join(root, "apps/api/dist-r06-v3") })));
  const r07=join(root,'tmp/r07-check/api/dist/src');
  assert.equal(requireFinalR07ApiDist(root,r07,plain),r07);
  assert.throws(()=>requireFinalR07ApiDist(root,join(root,'apps/api/dist/src'),plain));
});

test("R07 schema proof refuses another cluster, role, incomplete readback or stale journal",()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'}, target={round:7,host:instance.host,port:instance.port,instance,
  database:'zzsh_test_regression',databaseOid:123,marker:'zzsh:regression-test:v1',nonce:'a'.repeat(24),owner:'zzsh',ownerOid:456,
  runtimeUser:'zzsh_regression_runtime',runtimeRoleOid:789,migrationUser:'zzsh_regression_migration',migrationRoleOid:790};
 const ref=n=>({path:'evidence-'+n,sha256:String(n).repeat(64)});
 const proof={schema:'zzsh.round07-bank-schema-proof.v1',status:'FINAL_SCHEMA_READBACK_ACK',finalOrdinal:160,target,journalSha256:'d'.repeat(64),historySha256:'e'.repeat(64),readOnlyRollbackAck:true,clientClosed:true,roundInput:ref(1),roundReceipt:ref(2),coreReadback:ref(3),finalReceipt:ref(4)};
 const final={schema:'zzsh.round07-final-schema.v1',status:'FINAL_SCHEMA_VERIFIED',operation:'BOOTSTRAP_AND_CORE_READBACK',actualMigrationPerformed:false,finalOrdinal:160,journalSha256:proof.journalSha256,historySha256:proof.historySha256,readOnlyRollbackAck:true,clientClosed:true,unlockAck:true,maintenanceClosed:true,roundInputSha256:proof.roundInput.sha256,roundReceiptSha256:proof.roundReceipt.sha256,coreReadbackSha256:proof.coreReadback.sha256,target};
 const registry={database:target.database,oid:String(target.databaseOid),marker:target.marker,nonce:target.nonce,owner:target.owner,instance,roles:{migration:{name:target.migrationUser,oid:String(target.migrationRoleOid)},runtime:{name:target.runtimeUser,oid:String(target.runtimeRoleOid)}}};
 assert.deepEqual(assertFinalLegacyBankSchema(proof,final,registry),target);
 assert.throws(()=>assertFinalLegacyBankSchema(proof,final,{...registry,instance:{...instance,systemIdentifier:'999'}}));
 assert.throws(()=>assertFinalLegacyBankSchema(proof,{...final,clientClosed:false},registry));
 assert.throws(()=>assertFinalLegacyBankSchema(proof,{...final,historySha256:'f'.repeat(64)},registry));
 assert.throws(()=>assertFinalLegacyBankSchema({...proof,finalOrdinal:159},final,registry));
 assert.throws(()=>assertFinalLegacyBankSchema(proof,final,{...registry,roles:{...registry.roles,runtime:{...registry.roles.runtime,oid:'790'}}}));
});

test('R07 bank schema upgrade binds the old prefix, 0161 commit, independent readback and both role privileges',()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},target={round:7,host:instance.host,port:instance.port,instance,database:'zzsh_test_regression',databaseOid:123,marker:'zzsh:regression-test:v1',nonce:'a'.repeat(24),owner:'zzsh',ownerOid:456,runtimeUser:'zzsh_regression_runtime',runtimeRoleOid:789,migrationUser:'zzsh_regression_migration',migrationRoleOid:790};
 const ref=n=>({path:'evidence-'+n,sha256:String(n).repeat(64)}),oldProof={schema:'zzsh.round07-bank-schema-proof.v1',status:'FINAL_SCHEMA_READBACK_ACK',finalOrdinal:160,target,journalSha256:'d'.repeat(64),historySha256:'e'.repeat(64),readOnlyRollbackAck:true,clientClosed:true,roundInput:ref(1),roundReceipt:ref(2),coreReadback:ref(3),finalReceipt:ref(4)};
 const oldFinal={schema:'zzsh.round07-final-schema.v1',status:'FINAL_SCHEMA_VERIFIED',operation:'BOOTSTRAP_AND_CORE_READBACK',actualMigrationPerformed:false,finalOrdinal:160,journalSha256:oldProof.journalSha256,historySha256:oldProof.historySha256,readOnlyRollbackAck:true,clientClosed:true,unlockAck:true,maintenanceClosed:true,roundInputSha256:oldProof.roundInput.sha256,roundReceiptSha256:oldProof.roundReceipt.sha256,coreReadbackSha256:oldProof.coreReadback.sha256,target};
 const registry={database:target.database,oid:String(target.databaseOid),marker:target.marker,nonce:target.nonce,owner:target.owner,instance,roles:{migration:{name:target.migrationUser,oid:'790'},runtime:{name:target.runtimeUser,oid:'789'}}};
 const refs={oldProof:ref(5),oldFinal:ref(4),upgradePlan:ref(6),upgradeExecution:ref(7),upgradeReadback:ref(8),liveReadback:ref(9)},resource={oid:'123',nonce:target.nonce,instance},next='f'.repeat(64);
 const upgradePlan={status:'READ_ONLY_PREPARED',target:resource,before:{historySha256:oldProof.historySha256},journalSha256:next,migrationSha256:next,expectedFunctionSha256:next};
 const upgradeExecution={status:'UPGRADE_READBACK_PASSED',target:resource,commitAck:true,readbackRollbackAck:true,unlockAck:true,clientClosed:true,lockClosed:true,financialWrites:0,after:{historySha256:next}};
 const upgradeReadback={status:'EXACT_0161_AND_PREIMAGE_READBACK_PASSED',target:resource,inputs:{plan:refs.upgradePlan.sha256,execution:refs.upgradeExecution.sha256},lastMigrationSha256:next,functionSha256:next,readOnlyRollbackAck:true,clientClosed:true,targetWrites:0};
 const liveReadback={schema:'zzsh.r07-bank-upgraded-schema-readback.v1',status:'UPGRADED_SCHEMA_AND_BOTH_ROLES_READBACK_PASSED',target,finalOrdinal:161,journalSha256:next,historySha256:next,prefixSha256:oldProof.historySha256,lastMigrationSha256:next,bankAcl:{bank_table:true,can_select:true,can_insert:true,can_update:true},migrationRollbackAck:true,runtimeRollbackAck:true,unlockAck:true,clientsClosed:true,targetWrites:0};
 const args={oldProof,oldFinal,upgradePlan,upgradeExecution,upgradeReadback,liveReadback,registry,refs,finalPath:'final2.json'},result=makeR07UpgradedBankSchemaEvidence(args);
 assert.equal(result.proof.finalOrdinal,161);assert.equal(assertFinalLegacyBankSchema(result.proof,result.final,registry).round,7);
 for(const bad of [{...args,upgradeExecution:{...upgradeExecution,commitAck:false}},{...args,upgradeReadback:{...upgradeReadback,functionSha256:'0'.repeat(64)}},{...args,liveReadback:{...liveReadback,bankAcl:{...liveReadback.bankAcl,can_insert:false}}},{...args,liveReadback:{...liveReadback,prefixSha256:'0'.repeat(64)}},{...args,registry:{...registry,instance:{...instance,port:55432}}}])assert.throws(()=>makeR07UpgradedBankSchemaEvidence(bad));
});

test("R07 keyring evidence is target-specific and cannot reuse an R06 receipt",()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},target={round:7,database:'zzsh_test_regression',databaseOid:123,nonce:'a'.repeat(24),runtimeUser:'zzsh_regression_runtime',instance};
 const proof={schema:'zzsh.r07-bank-keyring-receipt.v1',status:'KEYRING_READY',aclVerified:true,backupMatches:true,database:target.database,runtimeUser:target.runtimeUser,version:'v1',files:{v1:{}},target:{oid:'123',nonce:target.nonce,instance}};
 assert.doesNotThrow(()=>assertLegacyBankKeyringProof(proof,target));
 assert.throws(()=>assertLegacyBankKeyringProof({...proof,schema:'zzsh.r06-bank-keyring-receipt.v1'},target));
 assert.throws(()=>assertLegacyBankKeyringProof({...proof,target:{...proof.target,instance:{...instance,systemIdentifier:'999'}}},target));
 assert.throws(()=>assertLegacyBankKeyringProof({...proof,backupMatches:false},target));
 const next={...target,round:'next',migrationProfile:'LOCAL_MIGRATION_NEXT_V1',instance:{...instance,port:55435}};
 const nextProof={...proof,schema:'zzsh.local-bank-keyring-receipt.v1',target:{...proof.target,instance:next.instance,migrationProfile:next.migrationProfile}};
 assert.doesNotThrow(()=>assertLegacyBankKeyringProof(nextProof,next));
 assert.throws(()=>assertLegacyBankKeyringProof(proof,next));
 assert.throws(()=>assertLegacyBankKeyringProof({...nextProof,target:{...nextProof.target,migrationProfile:undefined}},next));
});

test("R07 bank source proof binds the current dump snapshot and never claims a database write",()=>{
 const proof={schema:'zzsh.r07-bank-source-validation.v1',status:'SOURCE_VERIFIED_READ_ONLY',restoreMatchesDump:true,sourceAccess:'MYSQL_REPEATABLE_READ_READ_ONLY_ROLLBACK',plaintextRowsPersisted:false,postgresConnections:0,writes:0,sourceReceiptSha256:'a'.repeat(64),sourceBindingSha256:'b'.repeat(64)};
 assert.doesNotThrow(()=>assertLegacyBankSourceProof(proof,7,proof.sourceReceiptSha256,proof.sourceBindingSha256));
 assert.throws(()=>assertLegacyBankSourceProof({...proof,schema:'zzsh.r06-bank-source-validation.v1'},7,proof.sourceReceiptSha256,proof.sourceBindingSha256));
 assert.throws(()=>assertLegacyBankSourceProof(proof,7,'c'.repeat(64),proof.sourceBindingSha256));
 assert.throws(()=>assertLegacyBankSourceProof({...proof,plaintextRowsPersisted:true},7,proof.sourceReceiptSha256,proof.sourceBindingSha256));
 assert.doesNotThrow(()=>assertLegacyBankSourceProof({...proof,schema:'zzsh.local-bank-source-validation.v1'},'next',proof.sourceReceiptSha256,proof.sourceBindingSha256));
 assert.throws(()=>assertLegacyBankSourceProof(proof,'next',proof.sourceReceiptSha256,proof.sourceBindingSha256));
});

test("R07 bank schema evidence comes from fresh schema and exact independent core readback",()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},nonce='a'.repeat(24),dataset='b'.repeat(64),source='c'.repeat(64),journal='d'.repeat(64),history='e'.repeat(64);
 const ref=n=>({path:'evidence-'+n,sha256:String(n).repeat(64)}),roundInput=ref(1),roundReceiptRef=ref(2),readbackRef=ref(3);
 const target={oid:'123',nonce,instance,migrationRoleOid:'790',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',schemaHashes:['f'.repeat(64)]};
 const round={schema:'zzsh.local-round.v1',target,dataset:{sha256:dataset},source:{sha256:source}};
 const roundReceipt={schema:'zzsh.local-round-receipt.v1',status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',inputSha256:roundInput.sha256,datasetSha256:dataset,sourceReceiptSha256:source,target,completion:{status:'COMPLETE',dataset:'PASS',growth:'PASS'},finishedAt:'2026-11-06T00:00:00Z',stages:[{name:'readback',status:'ACK',code:0,signal:null,metrics:{evidenceSha256:readbackRef.sha256}}]};
 const readback={schema:'zzsh.local-dataset-readback.v1',status:'CORE_SOURCE_TARGET_EXACT_READBACK_PASSED',sourceDatasetSha256:dataset,resource:{database:'zzsh_test_regression',oid:'123',nonce,instance},differenceCount:0,targetWrites:0,rollbackConfirmed:true,lockReleased:true,connectionsClosed:true,financialHistory:{walletEffectsFromObservation:false,arrivalVerified:false,counts:{}}};
 const schema={status:'CLEAN_SCHEMA_INSTALLED',oid:'123',nonce,instance,finalOrdinal:160,journalSha256:journal,historySha256:history,hashes:target.schemaHashes,commitAck:true,migrationAck:true,readbackRollbackAck:true,readbackClientClosed:true,unlockAck:true,maintenanceClosed:true};
 const base={database:'zzsh_test_regression',oid:'123',nonce,instance,marker:'zzsh:regression-test:v1'};
 const runtime={formalAppMounted:true,resource:base,actualResource:{...base,owner:'zzsh',owner_oid:456,migration_role_oid:790,runtime_role:'zzsh_regression_runtime',runtime_role_oid:789,read_only:'on'}};
 const registry={...base,owner:'zzsh',roles:{migration:{name:'zzsh_regression_migration',oid:'790'},runtime:{name:'zzsh_regression_runtime',oid:'789'}},protectedDataset:{bootstrapReservation:target.bootstrapReservation,manifestSha256:dataset,epoch:{oid:'123',nonce}}};
 const options={round,roundInput,roundReceipt,roundReceiptRef,readback,readbackRef,schema,runtime,registry,journalSha256:journal,finalPath:'final.json'};
 assert.equal(makeR07BankSchemaEvidence(options).proof.target.round,7);
 assert.throws(()=>makeR07BankSchemaEvidence({...options,schema:{...schema,unlockAck:false}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...options,readback:{...readback,differenceCount:1}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...options,runtime:{...runtime,actualResource:{...runtime.actualResource,instance:{...instance,systemIdentifier:'999'}}}}));
 const i={...instance,port:55435},migrationProfile='LOCAL_MIGRATION_NEXT_V1',t={...target,instance:i,migrationProfile};
 const nextOptions={...options,round:{...round,target:t,bootstrapEvidence:{schema:ref(4)}},roundReceipt:{...roundReceipt,target:t},readback:{...readback,targetFence:'HELD_UNTIL_ROLLBACK',resource:{...readback.resource,instance:i,migrationProfile}},
  schema:{...schema,instance:i,migrationProfile,runtimeAclReadback:true,targetFence:'HELD_ACROSS_SCHEMA_AND_ACL',targetFenceReleased:true,initialBaseline:'release_production_0174',initialSeedReadback:{status:'INITIAL_SEEDS_AND_COMMENTS_VERIFIED'},initialBaselineManifestSha256:'a'.repeat(64),initialTailSeedProofSha256:'a'.repeat(64),releaseCommit:'a'.repeat(40)},runtime:{...runtime,resource:{...runtime.resource,instance:i,migrationProfile},actualResource:{...runtime.actualResource,instance:i,migrationProfile}},
  registry:{...registry,instance:i,migrationProfile}};
 const next=makeR07BankSchemaEvidence(nextOptions);assert.equal(next.proof.schema,'zzsh.local-bank-schema-proof.v1');assert.equal(next.proof.target.round,'next');
 assert.throws(()=>assertFinalLegacyBankSchema(next.proof,next.final,nextOptions.registry));
 assert.doesNotThrow(()=>assertFinalLegacyBankSchema(next.proof,next.final,nextOptions.registry,undefined,undefined,{round:nextOptions.round,schema:nextOptions.schema}));
 assert.throws(()=>assertFinalLegacyBankSchema(next.proof,next.final,nextOptions.registry,undefined,undefined,{round:nextOptions.round,schema:{...nextOptions.schema,releaseCommit:undefined}}));
 for(const change of [{status:'SCHEMA_STOPPED'},{runtimeAclReadback:false},{targetFenceReleased:false},{commitAck:false},{unlockAck:false}])
  assert.throws(()=>assertFinalLegacyBankSchema(next.proof,next.final,nextOptions.registry,undefined,undefined,{round:nextOptions.round,schema:{...nextOptions.schema,...change}}));
 assert.throws(()=>assertFinalLegacyBankSchema(next.proof,next.final,nextOptions.registry,undefined,undefined,{round:{...nextOptions.round,bootstrapEvidence:{schema:ref(5)}},schema:nextOptions.schema}));
 assert.throws(()=>makeR07BankSchemaEvidence({...nextOptions,schema:{...nextOptions.schema,initialSeedReadback:undefined}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...nextOptions,readback:{...nextOptions.readback,targetFence:undefined}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...nextOptions,readback:{...nextOptions.readback,resource:{...nextOptions.readback.resource,migrationProfile:undefined}}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...nextOptions,registry:{...nextOptions.registry,migrationProfile:undefined}}));
 assert.throws(()=>makeR07BankSchemaEvidence({...nextOptions,runtime:{...nextOptions.runtime,actualResource:{...nextOptions.runtime.actualResource,migrationProfile:undefined}}}));
});

test("只接受完整 ACK 的 0157 之后最终 schema；中间 0156 或目标漂移拒绝", () => {
  const target = { round: 6, host: "127.0.0.1", port: 55432, database: "zzsh_test_regression", databaseOid: 123, marker: "zzsh:regression-test:v1",
    nonce: "a".repeat(24), owner: "zzsh", ownerOid: 456, runtimeUser: "zzsh_regression_runtime", runtimeRoleOid: 789 };
  const proof = { schema: "zzsh.round06-bank-schema-proof.v1", status: "FINAL_SCHEMA_READBACK_ACK", finalOrdinal: 157, target,
    journalSha256: "d".repeat(64), historySha256: "e".repeat(64), readOnlyRollbackAck: true, clientClosed: true };
  const final = { schema: "zzsh.round06-final-schema.v1", status: "FINAL_SCHEMA_VERIFIED", finalOrdinal: 157, journalSha256: proof.journalSha256,
    operation: "POST_SWAP_READ_ONLY_REVALIDATION", actualMigrationPerformed: false, stageReceipt: { path: "stage", sha256: "1".repeat(64) },
    swapReceipt: { path: "swap", sha256: "2".repeat(64) }, stageHashes: Array(5).fill("3".repeat(64)),
    historySha256: proof.historySha256, readOnlyRollbackAck: true, clientClosed: true, unlockAck: true, maintenanceClosed: true,
    target: { database: target.database, oid: target.databaseOid, nonce: target.nonce, marker: target.marker, owner: target.owner, ownerOid: target.ownerOid,
      runtimeUser: target.runtimeUser, runtimeRoleOid: target.runtimeRoleOid } };
  const registry = { database: target.database, oid: target.databaseOid, marker: target.marker, nonce: target.nonce, pendingReset: false,
    roles: { runtime: { name: target.runtimeUser, oid: target.runtimeRoleOid } } };
  const stage = { status: "FINAL_SCHEMA_0157_VERIFIED", target: { database: "zzsh_test_round06_stage", marker: "zzsh:round06-schema-build:v1", oid: target.databaseOid, nonce: target.nonce },
    hashes: final.stageHashes, commitAck: true, unlockAck: true, maintenanceClosed: true };
  const swap = { status: "COMMIT_ACK", oid: target.databaseOid, nonce: target.nonce, schemaReceiptSha256: final.stageReceipt.sha256, unlockAck: true, maintenanceClosed: true,
    targetIdentity: { ...final.target, runtimeRole: target.runtimeUser, rollbackAck: true, clientClosed: true } };
  assert.deepEqual(assertFinalLegacyBankSchema(proof, final, registry, stage, swap), target);
  for (const changed of [{ ...final, status: "INTERMEDIATE_0156_INSTALLED_FINAL_0157_REQUIRED" }, { ...final, finalOrdinal: 156 },
    { ...final, readOnlyRollbackAck: "true" }, { ...final, actualMigrationPerformed: true }, { ...final, target: { ...final.target, oid: 3179610 } }])
    assert.throws(() => assertFinalLegacyBankSchema(proof, changed, registry, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema({ ...proof, finalOrdinal: 156 }, final, registry, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, { ...registry, nonce: "b".repeat(24) }, stage, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, registry, { ...stage, target: { ...stage.target, database: target.database } }, swap));
  assert.throws(() => assertFinalLegacyBankSchema(proof, final, registry, stage, { ...swap, schemaReceiptSha256: "f".repeat(64) }));
});

test("审批只绑定目标、来源、schema、构建、计划摘要与窗口，不包含用户或卡资料", () => {
  const result = makeLegacyBankAuthority(input, inputSha, plan, planSha, window, "r06-bank-review");
  assert.equal(result.maxWrites, 7); assert.equal(result.purpose, "ROUND_06_BANK_IMPORT");
  assert(!JSON.stringify(result).includes("synthetic-name")); assert(!JSON.stringify(result).includes("0000000000000015"));
  const r07={...input,target:{round:7,databaseOid:123}},r07Plan={...plan,binding:{...plan.binding,target:r07.target}};
  assert.equal(makeLegacyBankAuthority(r07,inputSha,r07Plan,planSha,window,"r07-bank-review").purpose,"ROUND_07_BANK_IMPORT");
  const next={...input,target:{round:'next',databaseOid:123}},nextPlan={...plan,binding:{...plan.binding,target:next.target}};
  assert.equal(makeLegacyBankAuthority(next,inputSha,nextPlan,planSha,window,"next-bank-review").purpose,"LOCAL_MIGRATION_BANK_IMPORT");
});
test("目标、源、schema、构建或原计划不一致以及无效窗口均拒绝生成", () => {
  for (const altered of [{ ...plan, inputSha256: "f".repeat(64) }, { ...plan, schemaHistorySha256: "f".repeat(64) },
    { ...plan, binding: { ...plan.binding, target: { ...input.target, databaseOid: 124 } } },
    { ...plan, binding: { ...plan.binding, source: { sourceReceiptSha256: "f".repeat(64) } } }, { ...plan, counts: { ready: 0 } }])
    assert.throws(() => makeLegacyBankAuthority(input, inputSha, altered, planSha, window, "review"));
  assert.throws(() => makeLegacyBankAuthority(input, inputSha, plan, planSha, { ...window, expiresAt: window.notBefore }, "review"));
  assert.throws(() => makeLegacyBankAuthority(input, inputSha, plan, planSha, window, "bad approval ref"));
});
test("无参数默认只输出计划，不读 key、不连数据库", () => {
  const result = spawnSync(process.execPath, [new URL("./prepare-local-legacy-bank-input.mjs", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1")], { encoding: "utf8" });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout);
  assert.equal(output.status, "PLAN_ONLY"); assert.equal(output.dbConnections, 0); assert.equal(output.keyReads, 0); assert.equal(output.keysGenerated, 0);
});
