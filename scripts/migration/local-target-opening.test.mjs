import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyOpeningDomain, openingReviewResource } from "./local-target-opening.mjs";
import { capturedOpeningUser, assertOpeningUserSource, verifyPreparedOpeningUsers, verifyOpeningCapture } from "./local-opening-proof.mjs";

const source = readFileSync(new URL("./local-target-opening.mjs", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("prepared openings must match the captured user, stored amount and mapped subject", async () => {
  const require=createRequire(import.meta.url),api=process.env.ZZSH_TEST_API_DIST??path.resolve('apps/api/dist/src'),modules={canonical:require(path.join(api,'supply/content-hash.js')).canonicalize,
    legacyOwnerUserId:require(path.join(api,'supply/legacy-user-migration.js')).legacyOwnerUserId,financeRead:require(path.join(api,'finance/personal-finance-read.js'))};
  const raw={id:'101',earnings:'7.50',money:'-1.25',is_delete:'0'},capture=capturedOpeningUser(raw,modules);
  const planned={sourceId:'101',userId:capture.userId,sourceDigest:capture.sourceDigest},balance={...planned,source:{id:'101',earnings:'7.50',money:'-1.25'},amounts:{earnings:'750',money:'-125'}};
  assert.doesNotThrow(()=>assertOpeningUserSource(balance,capture,planned,modules));
  for(const change of [x=>x.source.earnings='0.00',x=>x.source.money='0.00',x=>x.amounts.earnings='0',x=>x.userId='user_102',x=>x.sourceDigest='0'.repeat(64)]){
    const altered=structuredClone(balance);change(altered);assert.throws(()=>assertOpeningUserSource(altered,capture,planned,modules),/OPENING_CAPTURED_BALANCE_MISMATCH/);
  }
  for(const change of [{userId:'user_102'},{sourceDigest:'0'.repeat(64)}])
    assert.throws(()=>assertOpeningUserSource({...balance,...change},capture,{...planned,...change},modules),/OPENING_CAPTURED_BALANCE_MISMATCH/);
  const changedCapture=capturedOpeningUser({...raw,is_delete:'1'},modules);assert.throws(()=>assertOpeningUserSource(balance,changedCapture,planned,modules),/OPENING_CAPTURED_BALANCE_MISMATCH/);
  const cutoff='2026-09-13T13:31:22.000Z',inputSha256='a'.repeat(64),row={sourceId:'101',userId:capture.userId,state:'CANDIDATE',input:{inputSha256,cutoff,sourceCanonical:modules.canonical(balance.source),proof:{userId:capture.userId,source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',sourceId:'101',identityDigest:capture.sourceDigest},sourceDigest:sha(JSON.stringify({id:'101',earnings:'7.50',money:'-1.25'})),availableCents:'750'}}};
  const values=async function*(items){yield* items;},verify=items=>verifyPreparedOpeningUsers({balances:values([balance]),openings:values(items),capturedUsers:new Map([['101',capture]]),plannedUsers:new Map([['101',planned]]),modules,inputSha256,cutoff});
  assert.equal((await verify([row])).candidateAvailableCents,'750');
  const changed=structuredClone(row);changed.input.proof.availableCents='751';await assert.rejects(verify([changed]),/OPENING_PREPARED_SOURCE_MISMATCH/);
  await assert.rejects(verify([row,row]),/OPENING_PREPARED_SUBJECT_MISMATCH/);
});

test("opening preparation checks stored balance against captured source before emitting a candidate", {skip:process.platform!=="win32"||process.version!=="v24.20.0"||!existsSync("E:/zzsh-local-state/restricted")}, async t=>{
  const require=createRequire(import.meta.url),api=process.env.ZZSH_TEST_API_DIST??path.resolve('apps/api/dist/src'),canonical=require(path.join(api,'supply/content-hash.js')).canonicalize,
    userId=require(path.join(api,'supply/legacy-user-migration.js')).legacyOwnerUserId('legacy_mysql_restore','la_user','101');
  const root=mkdtempSync('E:/zzsh-local-state/restricted/opening-capture-synthetic-'),dirs=['source','funds','dataset','out-good','out-bad'].map(x=>path.join(root,x));
  const [sourceDir,fundsDir,datasetDir,goodDir,badDir]=dirs;for(const dir of dirs.slice(0,3))mkdirSync(dir);
  const paths=[];const put=(dir,name,value)=>{const file=path.join(dir,name),bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));writeFileSync(file,bytes);paths.push(file);return{file:name,rows:0,sha256:sha(bytes)};};
  t.after(()=>{for(const dir of [goodDir,badDir])for(const name of ['openings.jsonl','manifest.json']){const file=path.join(dir,name);if(existsSync(file))paths.push(file);}
    assert(path.resolve(root).toLowerCase().startsWith(path.resolve('E:/zzsh-local-state/restricted').toLowerCase()+'\\'));assert(!lstatSync(root).isSymbolicLink());
    for(const file of paths)if(existsSync(file)){assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());unlinkSync(file);}for(const dir of [...dirs].reverse())if(existsSync(dir))rmdirSync(dir);rmdirSync(root);});
  const raw={id:'101',earnings:'7.50',money:'-1.25',is_delete:'0'},digest=sha(canonical(raw));
  const line=(dir,name,rows)=>{const meta=put(dir,name,rows.map(row=>JSON.stringify(row)+'\n').join(''));meta.rows=rows.length;return meta;};
  const sourceFiles={users:line(sourceDir,'users.jsonl',[raw]),orders:line(sourceDir,'orders.jsonl',[]),distributionOrders:line(sourceDir,'distribution.jsonl',[])};
  const base={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,containerId:'synthetic',database:'synthetic',files:sourceFiles};
  const log={id:'501',user_id:'101',sn:'SYNTHETIC-LOG',action:'1',change_amount:'1.00',source_id:'0',create_time:'1779469800',change_type:'1006',left_amount:'2.50',source_sn:'',remark:'Synthetic adjustment',extra:null};
  const baseReceipt=put(sourceDir,'receipt.json',base),fundsFiles={earnings:line(fundsDir,'earnings.jsonl',[log]),withdraws:line(fundsDir,'withdraws.jsonl',[])};
  const funds={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,containerId:'synthetic',database:'synthetic',sourceSupplement:{baseReceiptSha256:baseReceipt.sha256,fullSourcePopulation:true},files:fundsFiles},fundsReceipt=put(fundsDir,'receipt.json',funds);
  const planned={sourceId:'101',userId,sourceDigest:digest},balance={...planned,source:{id:'101',earnings:'7.50',money:'-1.25'},amounts:{earnings:'750',money:'-125'}};
  const users=line(datasetDir,'users.jsonl',[planned]);let balances=line(datasetDir,'balances.jsonl',[balance]);
  const dataset=()=>({status:'FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN',source:sourceDir,sourceReceiptSha256:baseReceipt.sha256,sourceCutoff:'2026-09-13T13:31:22.000Z',files:{users,'stored-balances':balances},domains:{users:{ready:1}},storedBalanceTotals:{mappedEarningsCents:'750'}});
  const manifestFile=path.join(datasetDir,'manifest.json');writeFileSync(manifestFile,JSON.stringify(dataset()));paths.push(manifestFile);
  const run=out=>spawnSync(process.execPath,['scripts/migration/prepare-local-openings.mjs','--prepare','--dataset',datasetDir,'--dataset-sha',sha(readFileSync(manifestFile)),
    '--funds-source',fundsDir,'--funds-source-sha',fundsReceipt.sha256,'--api-dist',api,'--out',out],{encoding:'utf8',windowsHide:true});
  const good=run(goodDir);assert.equal(good.status,0,good.stderr);const report=JSON.parse(readFileSync(path.join(goodDir,'manifest.json'),'utf8'));
  assert.equal(report.sourceUsers.status,'SOURCE_VALUE_AND_SUBJECT_VERIFIED');assert.equal(report.sourceUsers.matched,1);assert.equal(report.stats.candidateAvailableCents,'750');
  const modules={canonical,legacyOwnerUserId:require(path.join(api,'supply/legacy-user-migration.js')).legacyOwnerUserId,financeRead:require(path.join(api,'finance/personal-finance-read.js')),
    preparation:require(path.join(api,'finance/legacy-finance-source-preparation.js')),proof:require(path.join(api,'finance/legacy-finance-source-evidence.js'))};
  const privatePath=file=>{assert(path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase()+'\\'));assert(!lstatSync(file).isSymbolicLink());return file;};
  const verify=opening=>verifyOpeningCapture({datasetDir,sourceDir,fundsDir,openingDir:goodDir,dataset:dataset(),source:base,funds,opening,datasetSha256:sha(readFileSync(manifestFile)),sourceReceiptSha256:baseReceipt.sha256,fundsReceiptSha256:fundsReceipt.sha256,modules,privatePath});
  const verified=await verify(report);assert.equal(verified.status,'SOURCE_FINANCIAL_FACTS_VERIFIED');assert.equal(verified.candidateAvailableCents,'750');
  const planFile=path.join(goodDir,'openings.jsonl'),tampered=JSON.parse(readFileSync(planFile,'utf8'));tampered.input.observations[0].amount='9.00';writeFileSync(planFile,JSON.stringify(tampered)+'\n');
  await assert.rejects(verify({...report,sha256:sha(readFileSync(planFile))}),/OPENING_FINANCIAL_SOURCE_MISMATCH/);
  writeFileSync(path.join(datasetDir,'balances.jsonl'),JSON.stringify({...balance,source:{...balance.source,money:'0.00'},amounts:{...balance.amounts,money:'0'}})+'\n');
  balances={...balances,sha256:sha(readFileSync(path.join(datasetDir,'balances.jsonl')))};writeFileSync(manifestFile,JSON.stringify(dataset()));
  const bad=run(badDir);assert.notEqual(bad.status,0);assert.match(bad.stderr,/OPENING_CAPTURED_BALANCE_MISMATCH/);
});

test("next-round finance review carries the pinned cluster and epoch without changing old resource shapes", () => {
  const ctx = { targetPort: 55435, state: { binding: { oid: "42", nonce: "a".repeat(24), migrationProfile: "LOCAL_MIGRATION_NEXT_V1",
    instance: { host: "127.0.0.1", port: 55435, systemIdentifier: "12345" } }, resource: { owner: "zzsh", marker: "marker", role: "role", role_oid: "43" } } };
  const resource = openingReviewResource(ctx);
  assert.deepEqual([resource.port, resource.migrationProfile, resource.systemIdentifier, resource.nonce], [55435, "LOCAL_MIGRATION_NEXT_V1", "12345", "a".repeat(24)]);
  const old = structuredClone(ctx); delete old.state.binding.migrationProfile; old.targetPort = 55433;
  assert.equal(Object.hasOwn(openingReviewResource(old), "systemIdentifier"), false);
});

async function rejectOpening(cause) {
  const data = Buffer.from("fixture source\n");
  const manifest = Buffer.from(JSON.stringify({ status: "REVIEWED_CANDIDATES_TARGET_NOT_RUN", datasetSha256: "dataset", file: "openings.jsonl", sha256: sha(data), stats: { candidate: 1, reviewRequired: 0 } }));
  const row = { state: "CANDIDATE", input: { inputSha256: "input", cutoff: "cutoff", proof: { userId: "user", source: { sourceId: "id", identityDigest: "identity" }, sourceDigest: "source", availableCents: "0", coveredDigest: "covered", coveredCount: 0 }, observations: [], admissions: [] } };
  const finance = { async bindReviewedStoredOpeningAdmissionBatch() { throw cause; } };
  const ctx = {
    targetPort: 55433, actor: { userId: "actor", sessionId: "session" },
    state: { binding: { oid: "42", datasetSha256: "dataset" }, resource: { owner: "owner", marker: "marker", role: "role", role_oid: "43" } },
    mod: name => name === "finance/personal-finance-maintenance" ? finance : { canonicalize: JSON.stringify },
    save() {}, async *readRows() { yield row; },
    async runBatches(_phase, candidates, run) { const batch = []; for await (const item of candidates) batch.push(item); await run(batch); },
  };
  const make = new AsyncFunction("createHash", "createReadStream", "readFileSync", "join", "resolve", "basename", source + "\nreturn { applyOpeningDomain };");
  const { applyOpeningDomain } = await make(createHash, () => Readable.from([data]), () => manifest, path.join, path.resolve, path.basename);
  try { await applyOpeningDomain(ctx, "E:/zzsh-local-state/restricted/fixture-openings", sha(manifest)); }
  catch (error) { return error; }
  assert.fail("expected rejection");
}

test("opening rejection preserves a safe code without exposing sensitive cause details", async () => {
  const original = Object.assign(new Error("secret-token-or-personal-data"), { code: "23505", detail: "private detail" });
  const error = await rejectOpening(original);
  assert.equal(error.message, "TARGET_REVIEWED_OPENING_REJECTED");
  assert.equal(error.code, "23505");
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /secret-token-or-personal-data|private detail/);
});

test("unsafe or absent cause codes never enter the migration receipt", async () => {
  for (const cause of [null, { code: "secret token", message: "private" }, { code: "x".repeat(200) }]) {
    const error = await rejectOpening(cause);
    assert.equal(error.message, "TARGET_REVIEWED_OPENING_REJECTED");
    assert.equal(error.code, "TARGET_REVIEWED_OPENING_REJECTED");
    assert.equal(error.cause, undefined);
  }
});

test("NEXT opening maps each system batch result to its own subject, including mixed replay",async()=>{
  const inputs=['user-b','user-a'].map((userId,index)=>({sourceId:String(index+1),state:'CANDIDATE',input:{inputSha256:'a'.repeat(64),cutoff:'2026-01-01T00:00:00.000Z',
    proof:{userId,source:{sourceId:String(index+1),identityDigest:'b'.repeat(64)},sourceDigest:'c'.repeat(64),availableCents:'0',coveredDigest:'d'.repeat(64),coveredCount:0},observations:[],admissions:[]}}));
  const plan={status:'REVIEWED_CANDIDATES_TARGET_NOT_RUN',datasetSha256:'dataset',file:'openings.jsonl',sha256:'f'.repeat(64),stats:{subjects:2,candidate:2,reviewRequired:0}},manifest=Buffer.from(JSON.stringify(plan));
  let applied;
  const ctx={isNextMigration:true,targetPort:55435,actor:{userId:'unused',sessionId:'unused'},manifest:{sourceCutoff:'2026-01-01T00:00:00.000Z'},
    systemOpening:{receiptMode:'SYSTEM_OPENING_V1',fenceEpochSha256:'a'.repeat(64),async importBatch(batch,window){assert.equal(batch.length,2);assert.match(window.ref,/CORE_FULL_STORED_OPENING/);return{outcomes:[{subjectId:'user-a',replayed:false},{subjectId:'user-b',replayed:true}]};}},
    state:{binding:{oid:'42',datasetSha256:'dataset'},resource:{owner:'owner',marker:'marker',role:'role',role_oid:'43'},openingSourcePreflight:{status:'SOURCE_FINANCIAL_FACTS_VERIFIED'},phases:{storedOpening:{quarantined:0}}},
    mod:name=>name==='finance/personal-finance-maintenance'?{assertOpeningConservation:async()=>({basisCents:'0',entryRows:0})}:{canonicalize:JSON.stringify},
    client:{query:async()=>({rows:[{subjects:2,positive:0,zero:2,amount:'0'}]})},save(){},
    async runBatches(_phase,rows,writer){const batch=[];for await(const row of rows)batch.push(row);applied=await writer(batch);}};
  const make=new AsyncFunction('createHash','createReadStream','readFileSync','join','resolve','basename','preflightBoundSourceBatches','readBoundSourceBatches',source+'\nreturn {applyOpeningDomain};');
  const fakeRows=async function*(){yield* inputs;};
  const {applyOpeningDomain}=await make(createHash,()=>Readable.from([]),()=>manifest,path.join,path.resolve,path.basename,async()=>({verified:true}),fakeRows);
  await applyOpeningDomain(ctx,'E:/zzsh-local-state/restricted/fixture-openings',sha(manifest));
  assert.deepEqual(applied,[{replayed:true},{replayed:false}]);assert.equal(ctx.state.additiveInputs.opening.receiptMode,'SYSTEM_OPENING_V1');
});

test("NEXT opening recovery reads the exact original batch and preserves UNKNOWN",async()=>{
  const inputs=[{sourceId:'1',state:'CANDIDATE',input:{proof:{userId:'first'}}},{sourceId:'skip',state:'REVIEW_REQUIRED',reason:'SOURCE_UNKNOWN'},
    {sourceId:'2',state:'CANDIDATE',input:{proof:{userId:'second'}}}],plan={status:'REVIEWED_CANDIDATES_TARGET_NOT_RUN',datasetSha256:'dataset',file:'openings.jsonl',sha256:'f'.repeat(64),stats:{subjects:3}},manifest=Buffer.from(JSON.stringify(plan));
  const pending={domain:'storedOpening',receiptMode:'SYSTEM_OPENING_V1',start:1,end:2,sourceIds:['2'],phaseBodyDigest:sha(JSON.stringify([inputs[2]])),fenceEpochSha256:'a'.repeat(64),stage:'COMMIT_UNKNOWN'};
  const state={binding:{oid:'42',datasetSha256:'dataset'},pending,additiveInputs:{opening:{directory:'E:/zzsh-local-state/restricted/fixture-openings',manifestSha256:sha(manifest),sourceFileSha256:plan.sha256,receiptMode:'SYSTEM_OPENING_V1',fenceEpochs:['a'.repeat(64)],notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z'}}};
  let calls=0;const ctx={state,mod:name=>name==='finance/personal-finance-maintenance'?{openingPlanCore:input=>({key:'key-'+input.proof.userId})}:{canonicalize:JSON.stringify},systemOpening:{receiptMode:'SYSTEM_OPENING_V1',async recoverBatch(batch){calls++;assert.deepEqual(batch,[inputs[2].input]);return{knowledge:'UNKNOWN',results:[{knowledge:'UNKNOWN',subjectId:'second',key:'key-second',receipt:null}]};}}};
  const make=new AsyncFunction('createHash','createReadStream','readFileSync','join','resolve','basename','preflightBoundSourceBatches','readBoundSourceBatches',source+'\nreturn {recoverSystemOpeningDomain};');
  const {recoverSystemOpeningDomain}=await make(createHash,()=>Readable.from([]),()=>manifest,path.join,path.resolve,path.basename,async()=>({verified:true}),async function*(){yield* inputs;});
  const before=JSON.stringify(state),result=await recoverSystemOpeningDomain(ctx);assert.deepEqual(result,{knowledge:'UNKNOWN',subjects:1,known:0,unknown:1,originalKeysPreserved:true});assert.equal(JSON.stringify(state),before);
  const original=ctx.systemOpening.recoverBatch;ctx.systemOpening.recoverBatch=async()=>({knowledge:'KNOWN',results:[{knowledge:'KNOWN',subjectId:'second',key:'different',originalOpeningVerified:true}]});
  await assert.rejects(recoverSystemOpeningDomain(ctx),/ORIGINAL_OPENING_RECOVERY_INVALID/);ctx.systemOpening.recoverBatch=original;
  state.additiveInputs.opening.fenceEpochs=[];await assert.rejects(recoverSystemOpeningDomain(ctx),/ORIGINAL_OPENING_PENDING_REQUIRED/);state.additiveInputs.opening.fenceEpochs=['a'.repeat(64)];
  state.pending.phaseBodyDigest='0'.repeat(64);await assert.rejects(recoverSystemOpeningDomain(ctx),/ORIGINAL_OPENING_PENDING_CHANGED/);assert.equal(calls,1);
});

test("next-round opening stops if the source changes after preflight", {skip:process.platform!=="win32"||!existsSync("E:/zzsh-local-state/restricted")}, async t=>{
  const dir=mkdtempSync("E:/zzsh-local-state/restricted/opening-source-synthetic-"),file=path.join(dir,"openings.jsonl"),manifestFile=path.join(dir,"manifest.json");
  t.after(()=>{for(const f of [file,manifestFile])if(existsSync(f)){assert(lstatSync(f).isFile()&&!lstatSync(f).isSymbolicLink());unlinkSync(f)}rmdirSync(dir)});
  const row={sourceId:"1",state:"CANDIDATE",input:{proof:{availableCents:"0"}}},bytes=Buffer.from(JSON.stringify(row)+"\n");writeFileSync(file,bytes);
  const manifest=Buffer.from(JSON.stringify({status:"REVIEWED_CANDIDATES_TARGET_NOT_RUN",datasetSha256:"dataset",file:"openings.jsonl",
    sha256:sha(bytes),stats:{subjects:1,candidate:1,reviewRequired:0}}));writeFileSync(manifestFile,manifest);
  let writes=0;
  const ctx={isNextMigration:true,targetPort:55433,actor:{userId:"actor",sessionId:"session"},
    systemOpening:{receiptMode:'SYSTEM_OPENING_V1',fenceEpochSha256:'a'.repeat(64),async importBatch(){throw Error('MUST_NOT_WRITE');}},
    state:{binding:{oid:"42",datasetSha256:"dataset"},resource:{owner:"owner",marker:"marker",role:"role",role_oid:"43"},openingSourcePreflight:{status:'SOURCE_FINANCIAL_FACTS_VERIFIED'},phases:{}},
    mod:()=>({canonicalize:JSON.stringify}),save(){},async runBatches(_phase,candidates){
      writeFileSync(file,JSON.stringify({...row,input:{proof:{availableCents:"100"}}})+"\n");
      for await(const _ of candidates)writes++;
    }};
  await assert.rejects(applyOpeningDomain(ctx,dir,sha(manifest)),/SOURCE_(?:BATCH|STREAM)_CHANGED/);assert.equal(writes,0);
});
