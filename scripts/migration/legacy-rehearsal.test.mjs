import { test, after } from "node:test";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "legacy-rehearsal.mjs");

function findRepoRoot(start) {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "apps", "api"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Repo root not found; run from the zzsh checkout");
}
const API_DIST = join(findRepoRoot(HERE), "apps", "api", "dist", "src");
const temporary=[];
const temp=()=>{const dir=mkdtempSync(join(tmpdir(),'zzsh-rehearsal-root-'));temporary.push(dir);return dir;};
after(()=>{for(const dir of temporary){assert.equal(dirname(dir),tmpdir());assert.ok(dir.split(/[\\/]/).at(-1).startsWith('zzsh-rehearsal-root-'));rmSync(dir,{recursive:true});}});
const run=(args)=>{const forwarded=[...args];if(['plan','selftest'].includes(forwarded[0])&&!forwarded.includes('--manifest'))forwarded.push('--manifest',join(FIXTURE_PATH,'manifest.json'));if(forwarded[0]==='selftest')forwarded.push('--fixture-dir',FIXTURE_PATH);return spawnSync(process.execPath,[CLI,...forwarded],{encoding:'utf8',timeout:30000});};
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const put=(p,value)=>writeFileSync(p,JSON.stringify(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// The immutable historical examples remain untouched. Tests seal a CURRENT-CODE fixture-only copy.
const FIXTURE_PATH=join(temp(),'fixtures');mkdirSync(FIXTURE_PATH);
for(const name of ['identities.json','chains.json','continuation.json','finance.json','finance-fin02.json','skins.json','media.json','target-readback.positive.json','target-readback.negative.json'])copyFileSync(join(HERE,'fixtures',name),join(FIXTURE_PATH,name));
const fixtureRequire=createRequire(CLI);
for(const file of ['legacy-load/user-order-offline-plan.js','legacy-load/legacy-skin-holdings.js','order/legacy-continuation-source-preparation.js','finance/legacy-finance-source-preparation.js','finance/legacy-duty-funding.js'])fixtureRequire(join(API_DIST,file));
for(const name of ['manifest.json','manifest-fin02.json']){const manifest=JSON.parse(readFileSync(join(HERE,'fixtures',name),'utf8'));const files={},sources={};for(const file of Object.keys(fixtureRequire.cache)){if(!file.startsWith(API_DIST+'\\')&&!file.startsWith(API_DIST+'/'))continue;const relative=file.slice(API_DIST.length+1).replaceAll('\\','/');files[relative]=sha(readFileSync(file));sources[relative]=sha(readFileSync(join(findRepoRoot(HERE),'apps/api/src',relative.replace(/\.js$/,'.ts'))));}manifest.plannerBuild.files=files;manifest.plannerBuild.sources=sources;manifest.plannerBuild.nodeVersion=process.version;manifest.plannerBuild.packageLockSha256=sha(readFileSync(join(findRepoRoot(HERE),'package-lock.json')));for(const key of Object.keys(manifest.plannerBuild.sharedFiles??{}))manifest.plannerBuild.sharedFiles[key]=sha(readFileSync(join(findRepoRoot(HERE),key)));manifest.plannerBuild.fixtureBinding='CURRENT_SOURCE_BYTES_NOT_HISTORICAL_EXECUTION';writeFileSync(join(FIXTURE_PATH,name),JSON.stringify(manifest));}
for(const name of ['target-readback.positive.json','target-readback.negative.json']){const target=JSON.parse(readFileSync(join(FIXTURE_PATH,name),'utf8'));target.sourceManifestSha256=sha(readFileSync(join(FIXTURE_PATH,'manifest.json')));writeFileSync(join(FIXTURE_PATH,name),JSON.stringify(target));}
function planned(){const dir=temp(),r=run(['plan','--out',dir]);assert.equal(r.status,0,r.stderr);return{dir,plan:load(join(dir,'plan.json')),planFile:join(dir,'plan.json')};}

test('source-only plan omits continuation without inventing a target',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 delete manifest.inputs.continuation;manifest.target={databaseOid:null,bound:false};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));
 assert.equal(plan.domains.continuation.status,'NOT_RUN');assert.equal(plan.domains.continuation.reason,'CONTINUATION_INPUT_NOT_PROVIDED');assert.deepEqual(plan.domains.continuation.items,[]);assert.equal(plan.totals.writeAllowed,false);assert.equal(plan.io.dbConnects,0);
});

test('provided continuation with an invalid target still fails closed',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 const packet=load(manifest.inputs.continuation.path);packet.targetDatabaseOid=0;const input=join(dir,'continuation.json');put(input,packet);manifest.inputs.continuation={path:input,sha256:sha(readFileSync(input))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,3);assert.match(r.stderr,/BATCH_BINDING_INVALID/);
});

test("offline plan is zero-network, zero-writer and never rentable", () => {
  const out = temp();
  const run = spawnSync(process.execPath, [CLI, "plan", "--manifest",join(FIXTURE_PATH,"manifest.json"),"--api-dist", API_DIST, "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  assert.equal(plan.io.networkAttempts, 0);
  assert.equal(plan.io.dbConnects, 0);
  assert.equal(plan.io.writerCalls, 0);
  assert.equal(plan.writerCalls, 0);
  assert.equal(plan.domains.account.items.every((item) => item.rentableGate.rentable === false), true);
  assert.equal(plan.domains.continuation.counts.CONFLICT, 0);
});

test("offline reports never expose identity source fields", () => {
  const dir = temp(), manifest = load(join(FIXTURE_PATH, "manifest.json"));
  for (const spec of Object.values(manifest.inputs)) spec.path = join(FIXTURE_PATH, spec.path);
  const identities = load(manifest.inputs.identities.path);
  const probes = ["SYNTHETIC_PRIVATE_NAME_719", "SYNTHETIC_PRIVATE_ID_719"];
  Object.assign(identities.users[0], { real_name: probes[0], id_card: probes[1] });
  const input = join(dir, "identity-fixture.json"); put(input, identities);
  manifest.inputs.identities = { ...manifest.inputs.identities, path: input, sha256: sha(readFileSync(input)) };
  const manifestFile = join(dir, "manifest.json"); put(manifestFile, manifest);
  const out = join(dir, "plan"), result = run(["plan", "--manifest", manifestFile, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr + readFileSync(join(out, "plan.json"), "utf8");
  for (const probe of probes) assert.equal(output.includes(probe), false);
});

test("selftest covers positive/negative reconciliation and fail-closed guards", () => {
  const out = temp();
  const run = spawnSync(process.execPath, [CLI, "selftest", "--manifest",join(FIXTURE_PATH,"manifest.json"),"--fixture-dir",FIXTURE_PATH,"--api-dist", API_DIST, "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(readFileSync(join(out, "selftest.json"), "utf8"));
  assert.equal(result.passed, true);
  assert.ok(result.checks.some((check) => check.name === "network-guard-denied" && check.passed));
  assert.ok(result.checks.some((check) => check.name === "apply-rejected" && check.passed));
  assert.ok(result.checks.some((check) => check.name === "reconcile-negative-exit-2" && check.passed));
});

for(const [name,change]of [
 ['duty order',t=>{t.duties[0].orderId='another_order';}],
 ['opening beneficiary',t=>{t.openings[0].userId='another_user';}],
 ['currency unit',t=>{t.duties[0].currency='USD';}],
 ['media account',t=>{t.media[0].accountKey='another_account';}],
 ['media source reference',t=>{t.media[0].sourceRef='another_reference';}],
 ['media review',t=>{t.media[0].reviewState='REJECTED';}],
 ['order status',t=>{t.orders[0].sourceStatus=999;}],
 ['order original number',t=>{t.orders[0].originalOrderNo='another_number';}],
 ['holding set',t=>{t.holdings[0].mappedSkinIds=['another_skin'];}],
 ['continuation original fingerprint',t=>{t.continuations[0].fingerprint='f'.repeat(64);}],
 ['unproved rentable claim with empty quote',t=>{Object.assign(t.accounts[0],{rentable:true,quote:{},ownerAcceptance:'ACCEPTED',occupancy:'FREE'});}],
])test('reconcile rejects changed '+name,()=>{
 const p=planned(),target=load(join(FIXTURE_PATH,'target-readback.positive.json'));change(target);const targetFile=join(p.dir,'target.json');put(targetFile,target);
 const r=run(['reconcile','--plan',p.planFile,'--target',targetFile,'--out',join(p.dir,'compare')]);assert.equal(r.status,2,r.stderr);assert.equal(load(join(p.dir,'compare/reconcile.json')).summary.conserved,false);
});

test('missing duty money remains unknown instead of becoming a conserved zero',()=>{
 const p=planned(),target=load(join(FIXTURE_PATH,'target-readback.positive.json'));p.plan.domains.finance.duties[0].amountCents=null;target.duties[0].amountCents=null;put(p.planFile,p.plan);const targetFile=join(p.dir,'target.json');put(targetFile,target);
 const r=run(['reconcile','--plan',p.planFile,'--target',targetFile,'--out',join(p.dir,'compare')]);assert.equal(r.status,2,r.stderr);const result=load(join(p.dir,'compare/reconcile.json'));assert.equal(result.conservation.duties.sourceCents,null);assert.equal(result.conservation.duties.targetCents,null);assert.equal(result.summary.amountConserved,false);
});

test('readiness rejects a conserved report belonging to another plan and labels fixture evidence',()=>{
 const p=planned(),r=run(['reconcile','--plan',p.planFile,'--target',join(FIXTURE_PATH,'target-readback.positive.json'),'--out',join(p.dir,'compare')]);assert.equal(r.status,0,r.stderr);
 const report=join(p.dir,'compare/reconcile.json');let ready=run(['readiness','--plan',p.planFile,'--reconcile',report,'--out',join(p.dir,'ready')]);assert.equal(ready.status,0,ready.stderr);const result=load(join(p.dir,'ready/rehearsal-readiness.json'));assert.equal(result.domains.sourceTargetConservation,'FIXTURE_PASS');assert.equal(p.plan.domains.account.counts.CONFLICT,0);assert.notEqual(result.domains.accountSource,'BLOCKED_CONFLICT');assert.notEqual(result.domains.skins,'BLOCKED_CONFLICT');
 p.plan.generatedAt='2026-01-01T00:00:00.000Z';put(p.planFile,p.plan);ready=run(['readiness','--plan',p.planFile,'--reconcile',report,'--out',join(p.dir,'wrong')]);assert.equal(ready.status,3);assert.match(ready.stderr,/RECONCILIATION_PLAN_MISMATCH/);
});

test('target export must bind the source manifest and actual PostgreSQL resource',()=>{
 for(const mutation of [t=>{t.sourceManifestSha256='0'.repeat(64);},t=>{t.fixtureOnly=false;}]){
  const p=planned(),target=load(join(FIXTURE_PATH,'target-readback.positive.json'));mutation(target);const f=join(p.dir,'target.json');put(f,target);const r=run(['reconcile','--plan',p.planFile,'--target',f,'--out',join(p.dir,'compare')]);assert.equal(r.status,3);assert.match(r.stderr,/TARGET_SOURCE_BINDING_MISMATCH|TARGET_RESOURCE_UNBOUND/);
 }
});

test('planner build drift and private input references reject before loading or reading them',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 const privateDir=join(dir,'.secrets');mkdirSync(privateDir);const privateFile=join(privateDir,'fixture.json');writeFileSync(privateFile,'{"password":"SYNTHETIC_PRIVATE_PROBE"}');manifest.inputs.identities={path:privateFile,sha256:sha(readFileSync(privateFile))};const mf=join(dir,'manifest.json');put(mf,manifest);let r=run(['plan','--manifest',mf,'--out',join(dir,'private-plan')]);assert.equal(r.status,3);assert.match(r.stderr,/PRIVATE_INPUT_REFUSED/);assert.doesNotMatch(r.stderr,/SYNTHETIC_PRIVATE_PROBE/);
 const original=load(join(FIXTURE_PATH,'manifest.json')),copy=join(dir,'api');for(const relative of Object.keys(original.plannerBuild.files)){const dest=join(copy,relative);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(API_DIST,relative),dest);}const changed=join(copy,'legacy-load/user-order-offline-plan.js');writeFileSync(changed,readFileSync(changed,'utf8')+'\n// changed fixture module\n');r=run(['plan','--api-dist',copy,'--out',join(dir,'drift-plan')]);assert.equal(r.status,3);assert.match(r.stderr,/PLANNER_BUILD_DRIFT/);
});

test('a skin held only by another account cannot authorize this account media',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 const skins=load(manifest.inputs.skins.path);skins.holdings.find(x=>x.accountKey==='10').columns.agent_skin='';const skinFile=join(dir,'skins.json');put(skinFile,skins);manifest.inputs.skins={path:skinFile,sha256:sha(readFileSync(skinFile))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.ok(plan.domains.media.items.find(x=>x.mediaId==='media-2').reasons.includes('SKIN_NOT_IN_HOLDING'));assert.ok(plan.domains.continuation.items.every(x=>!x.command||!('body' in x.command)),'public plan stores command fingerprints and safe binding fields, not raw bodies');
});

test('missing evidence survives without the original manifest argument and blocks a different manifest',()=>{
 const p=planned(),r=run(['missing-evidence','--plan',p.planFile,'--out',join(p.dir,'missing')]);assert.equal(r.status,0,r.stderr);const missing=load(join(p.dir,'missing/missing-evidence.json'));
 assert.ok(missing.rows.some(x=>x.reasons.includes('FIN-01_FAILED_WITHDRAWAL_SOURCE_NOT_READ')));assert.ok(missing.rows.some(x=>x.reasons.includes('FIN-02_MANUAL_ADJUSTMENT_OR_DEPOSIT_COMP_SOURCE_NOT_READ')));assert.ok(missing.rows.some(x=>x.domain==='finance'&&x.reasons.includes('IDENTITY_ISOLATED')));
 const wrong=join(p.dir,'wrong.json');put(wrong,{missingEvidenceSeeds:[]});const bad=run(['missing-evidence','--plan',p.planFile,'--manifest',wrong,'--out',join(p.dir,'bad')]);assert.equal(bad.status,3);assert.match(bad.stderr,/MANIFEST_PLAN_MISMATCH/);
});

test('an unconfirmed opening does not claim a commission root already covered',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 const finance=load(manifest.inputs.finance.path),unconfirmed=finance.storedOpenings.find(x=>x.label==='missing-proof'||x.subject?.identityState==='ISOLATED')??finance.storedOpenings.at(-1);
 unconfirmed.covered[0].sourceEntity='la_distribution_order';unconfirmed.covered[0].sourceId='91';const source=join(dir,'finance.json');put(source,finance);manifest.inputs.finance={path:source,sha256:sha(readFileSync(source))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.equal(plan.domains.finance.openingDutyOverlap.length,0);assert.ok(plan.domains.finance.openings.some(x=>x.status==='MISSING_FACT'));
});

test('one legacy wallet cannot contain two independently labelled opening candidates',()=>{
 const dir=temp(),manifest=load(join(FIXTURE_PATH,'manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(FIXTURE_PATH,spec.path);
 const finance=load(manifest.inputs.finance.path),duplicate=structuredClone(finance.storedOpenings[0]);duplicate.openingId='another_case_label';finance.storedOpenings.push(duplicate);const source=join(dir,'finance.json');put(source,finance);manifest.inputs.finance={path:source,sha256:sha(readFileSync(source))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.equal(plan.domains.finance.status,'BLOCKED');assert.ok(plan.domains.finance.duplicateOpeningSubjects.includes('fixture-user'));assert.equal(plan.domains.finance.openings.filter(x=>x.status==='READY').length,0);
});

test('FIN-02 is an alternative original-balance scenario, not a second opening for the same user',()=>{
 const dir=temp(),r=run(['plan','--manifest',join(FIXTURE_PATH,'manifest-fin02.json'),'--out',dir]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan.json')),ready=plan.domains.finance.openings.filter(x=>x.status==='READY');assert.equal(ready.length,1);assert.equal(ready[0].availableCents,'110');assert.equal(ready[0].coveredCount,1);assert.equal(ready[0].flowSum,'NOT_COMPUTED');assert.equal(ready[0].openingIdMeaning,'SCENARIO_LABEL_NOT_DATABASE_ID');
});

import { classifyLegacyRegistrationTime, compareLegacyRegistrationFact, sourceAdultEvidence, sourceAccountPlan, sourceOrderPlan, sourceFinanceObservation, sourceContinuation, summarizeLegacyDashboardSources, matchesLegacyAccountMetricAudit, legacyAccountCaptureProof, matchesLegacyAccountCapture, matchesCapturedAccountBaseRatio, matchesCapturedAccountFullPayout, legacyOrderCaptureProof, matchesLegacyOrderCapture, assertSourceSupplementFields } from "./local-source-adapter.mjs";

test("registration source and independent target fact distinguish missing, invalid and mismatched time", () => {
  const epoch = value => new Date(Number(value) * 1000).toISOString();
  for (const value of [null,undefined,0,"0"]) assert.equal(classifyLegacyRegistrationTime(value,epoch),"MISSING");
  for (const value of ["", "-1", "2026-02-30T00:00:00Z", "9999999999999999999999999999"]) assert.equal(classifyLegacyRegistrationTime(value,epoch),"INVALID");
  assert.equal(classifyLegacyRegistrationTime("1700000000",epoch),"VALID");
  assert.equal(classifyLegacyRegistrationTime("2026-11-06T00:00:00.000Z",epoch),"VALID");
  const fact={userId:"user-1",legacyId:"1",registeredAt:new Date("2026-11-06T00:00:00.000Z")};
  assert.equal(compareLegacyRegistrationFact("2026-11-06T00:00:00.000Z","1",fact),"MATCH");
  assert.equal(compareLegacyRegistrationFact(null,"1",{...fact,registeredAt:null}),"MATCH");
  assert.equal(compareLegacyRegistrationFact(null,"1",fact),"TARGET_TIME_MISMATCH");
  assert.equal(compareLegacyRegistrationFact("2026-11-06T00:00:00.000Z","2",fact),"TARGET_LEGACY_ID_MISMATCH");
  assert.equal(compareLegacyRegistrationFact(null,"1",null),"TARGET_FACT_MISSING");
});

test("source adapter: a display supplement must preserve exact base fields, nulls and decimal strings", () => {
  const base={id:"1",amount:"100000000.00000001",nullable:null,updated_at:"100"};
  assert.doesNotThrow(()=>assertSourceSupplementFields(base,{...base,skin:"KNOWN"}));
  for(const mutation of [r=>{r.id="2";},r=>{r.amount="100000000.00000002";},r=>{delete r.nullable;},r=>{r.nullable="";},r=>{r.updated_at="101";}]) {
    const changed={...base,skin:"KNOWN"};mutation(changed);assert.throws(()=>assertSourceSupplementFields(base,changed),/SUPPLEMENT_(SOURCE_ID_CHANGED|COMMON_FIELD_DRIFT)/);
  }
});

test("source adapter: absent, malformed, future or timezone-conflicting age stays unknown", () => {
  const at = String(Date.parse("2026-01-01T00:00:00Z") / 1000);
  assert.equal(sourceAdultEvidence(null, at), null);
  assert.equal(sourceAdultEvidence("99000020080230123X", at), null);
  assert.equal(sourceAdultEvidence("99000020900101123X", at), null);
  assert.equal(sourceAdultEvidence("99000019900101123X", "0"), null);
  const boundary = String(Date.parse("2025-12-31T17:00:00Z") / 1000);
  assert.equal(sourceAdultEvidence("99000020080101123X", boundary), null);
});

test("source adapter: source-proven adult and minor remain different facts", () => {
  const at = String(Date.parse("2026-01-01T00:00:00Z") / 1000);
  assert.equal(sourceAdultEvidence("99000019900101123X", at), true);
  assert.equal(sourceAdultEvidence("99000020100101123X", at), false);
});

test("source adapter: deleted historical orders keep the flag without becoming a new transaction", () => {
  const users = new Map([["1",{userId:"owner",sourceDigest:"a".repeat(64)}],["2",{userId:"renter",sourceDigest:"b".repeat(64)}]]);
  const accounts = new Map([["3",{sourceDigest:"c".repeat(64),businessNo:null,gameCode:"delta"}]]);
  const modules = {orderRead:{LEGACY_ORDER_READ_SOURCE_FIELDS:["id","is_delete","pay_money","detain_money","compensation"]},contentHash:{canonicalize:JSON.stringify}};
  const raw = {id:"4",is_delete:"1",sale_user_id:"1",user_id:"2",accounts_id:"3",pay_money:"87.00",detain_money:"5.00",compensation:"12.30",team_id:"PRIVATE_OLD_TEAM"};
  const plan = sourceOrderPlan(raw,users,accounts,modules,"source-proof");
  assert.equal(plan.ready,true);assert.equal(plan.sourceDeleted,true);
  assert.equal(plan.source.row.pay_money,"87.00");assert.equal(plan.source.row.detain_money,"5.00");
  assert.equal(plan.source.row.compensation,"12.30");
  assert.equal(Object.hasOwn(plan.source.row,"team_id"),false);assert.equal(raw.team_id,"PRIVATE_OLD_TEAM");
  assert.equal(Object.hasOwn(plan,"paymentConfirmed"),false);
});

test("account metric flag remains a bound capture fact and is not invented when missing", () => {
  const users = new Map([["1",{userId:"owner",sourceDigest:"a".repeat(64)}],["2",{userId:"renter",sourceDigest:"b".repeat(64)}]]);
  const games = new Map([["1","delta"]]), modules={contentHash:{canonicalize:JSON.stringify},planner:{listingSnapshot:()=>({snapshot:null,sourceUpdatedAt:null,missing:[]})},orderRead:{LEGACY_ORDER_READ_SOURCE_FIELDS:["id","is_delete","share_money","commission_money","pay_time"]}};
  const account={id:"3",user_id:"1",game_id:"1",status:"4",is_delete:"0",no:"A",is_full_payout:"1"};
  const order={id:"4",is_delete:"0",sale_user_id:"1",user_id:"2",accounts_id:"3",share_money:"12.34",commission_money:"5.67",pay_time:"1779469800"};
  const accountPlan=sourceAccountPlan(account,users,modules,"capture",games), plan=sourceOrderPlan(order,users,new Map([["3",accountPlan]]),modules,"capture");
  assert.deepEqual(plan.account.metricSourceFields,{is_full_payout:"1"});assert.equal(plan.account.sourceDigest,accountPlan.sourceDigest);
  assert.deepEqual(plan.source.row,{id:"4",is_delete:"0",share_money:"12.34",commission_money:"5.67",pay_time:"1779469800"});
  const accountProof=legacyAccountCaptureProof(account,JSON.stringify),orderProof=legacyOrderCaptureProof(order,modules.orderRead.LEGACY_ORDER_READ_SOURCE_FIELDS,JSON.stringify);
  assert.equal(matchesLegacyAccountCapture(accountProof,accountPlan,JSON.stringify),true);assert.equal(matchesLegacyOrderCapture(orderProof,plan,JSON.stringify),true);
  assert.equal(matchesLegacyAccountCapture(accountProof,{...accountPlan,metricSourceFields:{is_full_payout:"0"}},JSON.stringify),false);
  assert.equal(matchesLegacyOrderCapture(orderProof,{...plan,source:{...plan.source,row:{...plan.source.row,share_money:"0.00"}}},JSON.stringify),false);
  const missing=sourceAccountPlan(Object.fromEntries(Object.entries(account).filter(([key])=>key!=="is_full_payout")),users,modules,"capture",games);
  assert.deepEqual(missing.metricSourceFields,{});
  const nullFact=sourceAccountPlan({...account,is_full_payout:null},users,modules,"capture",games);assert.deepEqual(nullFact.metricSourceFields,{is_full_payout:null});
});

test("account base ratio readback binds raw source and keeps unknown distinct",()=>{
  const source={id:"3",base_bot:"56"},proof=legacyAccountCaptureProof(source,JSON.stringify);
  const snapshot={sourceAccountBaseRatioWanPerYuan:"56",issues:[]};
  assert.equal(matchesCapturedAccountBaseRatio(proof,snapshot,proof.sourceDigest),true);
  assert.equal(matchesCapturedAccountBaseRatio(proof,{...snapshot,sourceAccountBaseRatioWanPerYuan:"57"},proof.sourceDigest),false);
  assert.equal(matchesCapturedAccountBaseRatio(proof,snapshot,"a".repeat(64)),false);
  assert.equal(matchesCapturedAccountBaseRatio(proof,{issues:[]},proof.sourceDigest),false);
  for(const [value,issue] of [[null,"base_bot:MISSING"],["0","base_bot:NON_POSITIVE"],["-1","base_bot:INVALID"]]) {
    const p=legacyAccountCaptureProof({...source,base_bot:value},JSON.stringify);
    assert.equal(matchesCapturedAccountBaseRatio(p,{sourceAccountBaseRatioWanPerYuan:null,issues:[issue]},p.sourceDigest),true);
    assert.equal(matchesCapturedAccountBaseRatio(p,{sourceAccountBaseRatioWanPerYuan:null,issues:[]},p.sourceDigest),false);
  }
});
test("account payout readback preserves explicit source zero and rejects forged selection",()=>{
  for(const [raw,selected,issues] of [["1",true,[]],["0",false,[]],[null,null,["is_full_payout:UNKNOWN"]]]){
    const proof=legacyAccountCaptureProof({id:"3",is_full_payout:raw},JSON.stringify),snapshot={sourceAccountFullPayoutSelected:selected,issues};
    assert.equal(matchesCapturedAccountFullPayout(proof,snapshot,proof.sourceDigest),true);
    assert.equal(matchesCapturedAccountFullPayout(proof,{...snapshot,sourceAccountFullPayoutSelected:selected===true?false:true},proof.sourceDigest),false);
    assert.equal(matchesCapturedAccountFullPayout(proof,snapshot,"a".repeat(64)),false);
  }
});

test("dashboard capture report distinguishes null and uncaptured facts; readback rejects changed or duplicate audit",()=>{
  const receipt={files:{orders:{fields:["pay_time","commission_money"]},accounts:{fields:["is_full_payout"]}},physicalColumns:{la_order:["share_money","commission_money","pay_time"],la_rental_accounts:["is_full_payout"]}};
  const report=summarizeLegacyDashboardSources([{commission_money:"0.00",pay_time:"0"},{commission_money:null,pay_time:null}],[{is_full_payout:"1"},{}],receipt);
  assert.deepEqual(report.shareMoney,{captured:false,physical:true,present:0,null:0,missing:2});
  assert.equal(report.commissionMoney.null,1);assert.equal(report.accountFullPayoutAtCapture.missing,1);
  assert.equal(report.accountFlagMeaning,"ACCOUNT_STATE_AT_SOURCE_CAPTURE_NOT_PROVEN_AT_ORDER_PAYMENT");
  const drift=summarizeLegacyDashboardSources([],[],{files:{distributionOrders:{fields:["id","new_unmapped"]}},physicalColumns:{la_distribution_order:["id","new_unmapped","new_uncaptured"]}},[{id:"1"}]);
  assert.deepEqual(drift.distributionColumns.physicalNotCaptured,["new_uncaptured"]);assert.deepEqual(drift.distributionColumns.capturedNotProjected,["new_unmapped"]);
  const expected={schema:"legacy-account-metric-source-v1",fields:{is_full_payout:"1"}},audit={bindingDigest:"digest",accountMetricSource:expected};
  assert.equal(matchesLegacyAccountMetricAudit([audit],expected,"digest",JSON.stringify),true);
  for(const list of [[],[audit,audit],[{bindingDigest:"wrong",accountMetricSource:expected}],[{bindingDigest:"digest"}],[{bindingDigest:"digest",accountMetricSource:{...expected,fields:{is_full_payout:"0"}}}]])
    assert.equal(matchesLegacyAccountMetricAudit(list,expected,"digest",JSON.stringify),false);
});

test("distribution source adapter preserves all captured original columns without computing earnings",()=>{
 const raw={id:"1",sn:"dist",user_id:"2",order_type:"1",order_id:"3",order_goods_id:"4",goods_id:"5",sku_id:"6",earnings:"7.50",level_id:"8",level:"1",ratio:"9.5",status:"3",settle_time:"0",is_delete:"1",create_time:"10",update_time:"11",delete_time:"12"};
 const observed=sourceFinanceObservation("distributionOrders",raw);
 assert.deepEqual(observed.row,raw);assert.equal(observed.kind,"HISTORICAL_DISTRIBUTION");
});

test("source adapter: missing parties are isolated rather than manufactured", () => {
  const plan = sourceOrderPlan({id:"4",is_delete:"0",sale_user_id:"1",user_id:"2",accounts_id:"3"},new Map(),new Map(),{},"source");
  assert.deepEqual(plan,{ready:false,reason:"ORDER_OWNER_NOT_MAPPED"});
});

test("source adapter: financial source IDs cannot lose integer precision", () => {
  assert.throws(()=>sourceFinanceObservation("earnings",{id:"9007199254740993"}),/SOURCE_INTEGER_INVALID/);
});

test("source adapter: missing original amount is never filled with zero", () => {
  const row = sourceFinanceObservation("earnings",{id:"1",user_id:"2",action:"1",source_id:"3",create_time:"100",change_type:"1001",sn:"LOG"});
  assert.equal(row.row.amount,undefined);assert.equal(row.row.leftAmount,undefined);
});

test("source adapter: zero prices, unknown prices and original payment numbers are preserved", () => {
  const raw={id:"1",order_status:"3",is_settle:"0",user_id:"2",sale_user_id:"3",profit_dot:"12",awm_bullet_price:"0.00"};
  const source=sourceContinuation(raw,{id:"4",base_bot:"60",awm_bullet_price:null},[{id:"5",order_id:"1",pay_order_sn:"ORIGINAL",pay_money:"87.00"}],[],{advanceOrderSetRatio:"70",expend:{}});
  assert.equal(source.orderPrices.awm,"0.00");assert.equal(source.accountPrices.awm,null);
  assert.equal(source.paidPay[0].payOrderSn,"ORIGINAL");assert.equal(source.commissions.length,0);
});

test("source adapter: all local tool default plans refuse network, child processes and secret reads", () => {
  const dir=temp(),guard=join(dir,"no-external.cjs");
  writeFileSync(guard,`const fs=require('node:fs'),net=require('node:net'),tls=require('node:tls'),cp=require('node:child_process'),m=require('node:module');const read=fs.readFileSync;fs.readFileSync=function(file,...rest){if(typeof file==='string'&&/(?:^|[\\\\/])(?:\\.secrets|\\.env)(?:[\\\\/.]|$)/.test(file))throw Error('SECRET_READ_FORBIDDEN');return read.call(this,file,...rest)};net.Socket.prototype.connect=function(){throw Error('NETWORK_FORBIDDEN')};tls.connect=function(){throw Error('NETWORK_FORBIDDEN')};cp.spawn=cp.spawnSync=function(){throw Error('CHILD_PROCESS_FORBIDDEN')};m.syncBuiltinESMExports();`);
  for(const name of ["capture-local-source.mjs","prepare-local-dataset.mjs","prepare-local-display.mjs","load-local-dataset.mjs","readback-local-dataset.mjs","build-business-initial.mjs","bootstrap-local-reference.mjs"]){
    const result=spawnSync(process.execPath,["--require",guard,join(HERE,name),"--plan"],{encoding:"utf8",timeout:5000});
    assert.equal(result.status,0,name+":"+result.stderr);const plan=JSON.parse(result.stdout.trim());assert.equal(plan.action,"PLAN");
    assert.equal(plan.dbConnections??plan.connections??plan.pgConnections,0);
  }
});

test("source capture plans include invitation codes and current seasonal facts without treating the old boss as current", () => {
  const capture=join(HERE,"capture-local-source.mjs");
  const run=(flags=[])=>{const result=spawnSync(process.execPath,[capture,"--plan",...flags],{encoding:"utf8",timeout:5000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  const base=run();assert.ok(base.fieldsByDomain.users.includes("code"));assert.equal(base.dbConnections,0);
  for(const field of ["share_money","commission_money","pay_time"])assert.ok(base.fieldsByDomain.orders.includes(field));
  assert.ok(base.fieldsByDomain.accounts.includes("is_full_payout"));
  assert.deepEqual(base.fieldsByDomain.accounts,base.fieldsByDomain.accountDisplay);
  for(const field of ["agent_skin","is_demulan","is_sayyid","awm_number","helmet","armor","is_next_season_pass","price_per","price_vip","ratio_type","create_time"])assert.ok(base.fieldsByDomain.accounts.includes(field));
  assert.ok(base.fieldsByDomain.skinDictionaryData.includes("type_id"));assert.ok(base.fieldsByDomain.orderAfter.includes("order_id"));
  const display=run(["--account-display-only"]);assert.ok(display.fieldsByDomain.accountDisplay.includes("is_demulan"));
  for(const field of ["is_sayyid","awm_number","helmet","armor","is_next_season_pass"])assert.ok(display.fieldsByDomain.accountDisplay.includes(field));
  assert.equal(display.dbConnections,0);assert.equal(display.credentialReads,0);
});

test("invitation scenario packets validate all source codes, preserve omitted child proofs, and keep policy absent", async () => {
  const {sourceInvitationPlan}=await import("./local-source-adapter.mjs");
  const modules={invitation:fixtureRequire(join(API_DIST,"finance/legacy-invitation-facts.js")),migration:fixtureRequire(join(API_DIST,"supply/legacy-user-migration.js")),contentHash:fixtureRequire(join(API_DIST,"supply/content-hash.js"))};
  const raw=["1","2","3"].map(id=>({id,code:"Code"+id,is_delete:"0",is_disable:"0",inviter_id:id==="1"?"0":"1",first_leader:"0",second_leader:"0",third_leader:"0",create_time:"1",update_time:"1"}));
  const receipt={files:{users:{sha256:"a".repeat(64)},distribution:{sha256:"b".repeat(64)}}};
  const plan=sourceInvitationPlan(raw,[],modules,receipt,"c".repeat(64),"2026-11-03T07:47:05.000Z",new Set(["1","2"]));
  assert.equal(plan.summary.subjects,3);assert.equal(plan.summary.selectedSubjects,2);assert.equal(plan.summary.automaticEligibilityEnabled,false);
  assert.equal(plan.packets[0].input.policy,null);assert.equal(plan.packets.flatMap(p=>p.input.subjects).find(s=>s.legacyId==="1").children.INVITER.sourceCount,2);
  assert.throws(()=>sourceInvitationPlan([...raw.slice(0,2),{...raw[2],code:"cODE2"}],[],modules,receipt,"c".repeat(64),"2026-11-03T07:47:05.000Z",new Set(["1","2"])),/Global original identity\/code collision/);
});

test("source adapter: reference bootstrap rejects business tables before credentials or a DB connection", () => {
  const dir=temp(),manifest=join(dir,"manifest.json");
  const doc={kind:"REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION",transactionRollback:true,tables:[{schema:"zzsh_order",table:"rental_order",file:"forbidden.json",rows:0,sha256:"0".repeat(64)}]};
  const bytes=JSON.stringify(doc);writeFileSync(manifest,bytes);
  const result=spawnSync(process.execPath,[join(HERE,"bootstrap-local-reference.mjs"),"--execute","--manifest",manifest,"--manifest-sha",createHash("sha256").update(bytes).digest("hex")],{encoding:"utf8",timeout:5000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/REFERENCE_TABLE_NOT_ALLOWED/);
});

test("source adapter: reference bootstrap cannot call an empty identity package complete", () => {
  const dir=temp(),manifest=join(dir,"manifest.json");
  const bytes=JSON.stringify({kind:"REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION",transactionRollback:true,tables:[]});writeFileSync(manifest,bytes);
  const result=spawnSync(process.execPath,[join(HERE,"bootstrap-local-reference.mjs"),"--execute","--manifest",manifest,"--manifest-sha",createHash("sha256").update(bytes).digest("hex")],{encoding:"utf8",timeout:5000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/REVIEWED_FIVE_ADMIN_IDENTITY_CLOSURE_REQUIRED/);
});

test("source adapter: reference numeric rows must remain raw PostgreSQL JSON text", () => {
  const dir=temp(),file=join(dir,"users.json"),manifest=join(dir,"manifest.json");
  const payload=JSON.stringify({schema:"zzsh_auth_admin",table:"user",columns:[],rows:[{id:"test",numeric:10000000000000001}]});writeFileSync(file,payload);
  const bytes=JSON.stringify({kind:"REVIEWED_REFERENCE_SNAPSHOT_NOT_BUSINESS_MIGRATION",transactionRollback:true,tables:[{schema:"zzsh_auth_admin",table:"user",file:"users.json",rows:1,sha256:createHash("sha256").update(payload).digest("hex")}]});writeFileSync(manifest,bytes);
  const result=spawnSync(process.execPath,[join(HERE,"bootstrap-local-reference.mjs"),"--execute","--manifest",manifest,"--manifest-sha",createHash("sha256").update(bytes).digest("hex")],{encoding:"utf8",timeout:5000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/LOSSLESS_REFERENCE_ROWS_REQUIRED/);
});

test("source adapter: ordinary regression reset rejects a protected rehearsal dataset before secret reads or DROP", () => {
  const dir=temp(),resource=join(dir,".secrets/local-postgresql/regression_test");mkdirSync(resource,{recursive:true});
  writeFileSync(join(resource,"resource.json"),JSON.stringify({database:"zzsh_test_regression",protectedDataset:{manifestSha256:"a".repeat(64),epoch:{oid:"1",nonce:"a".repeat(24)},reason:"REHEARSAL_REVIEW"}}));
  const env={...process.env,DB_HOST:"127.0.0.1",DB_PORT:"55432",DB_USER:"zzsh",DB_PASSWORD_FILE:join(dir,"must-not-be-read"),REGRESSION_TEST_ALLOW_NEW_RESOURCE:"1"};delete env.DB_PASSWORD;delete env.REGRESSION_TASK_AUTHORIZATION;delete env.REGRESSION_TASK_AUTHORIZATION_SHA256;
  const result=spawnSync(process.execPath,[join(findRepoRoot(HERE),"apps/api/scripts/regression-reset.mjs")],{cwd:dir,env,encoding:"utf8",timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/protected for rehearsal review/);assert.doesNotMatch(result.stderr,/ENOENT|connect ECONN/);
});

test("source adapter: initial generation cannot replace an installed baseline or escape its new directory", () => {
  for (const [baseline, expected] of [["release_0141", /INITIAL_OUTPUT_ALREADY_EXISTS/], ["../outside", /NEW_BASELINE_NAME_REQUIRED/]]) {
    const result=spawnSync(process.execPath,[join(HERE,"build-business-initial.mjs"),"--execute","--oid","1","--baseline",baseline,"--source-count","142"],{env:{...process.env,DB_PASSWORD_FILE:join(temp(),"must-not-be-read")},encoding:"utf8",timeout:5000});
    assert.notEqual(result.status,0);assert.match(result.stderr,expected);assert.doesNotMatch(result.stderr,/ENOENT|connect ECONN/);
  }
});

test('load checkpoint: no lock/identity ownership means no checkpoint or event writes; cleanup belongs to this run', () => {
 const source=readFileSync(join(HERE,'load-local-dataset.mjs'),'utf8');
 const functions=['resetRunCleanup','save','event'].map(name=>{
  const line=source.split('\n').find(line=>line.startsWith('function '+name+'('));assert.ok(line,name);return line;
 }).join('\n');
 const state={poolClosed:true,unlock:true,maintenanceClosed:true,rollbackConfirmed:true,phases:{users:{nextIndex:10}}};
 const writes=[],sandbox={state,statePath:'checkpoint.json',eventsPath:'events.jsonl',writeLoadCheckpoint:(...args)=>writes.push(['checkpoint',...args]),appendFileSync:(...args)=>writes.push(['event',...args])};
 runInNewContext('let checkpointOwned=false;'+functions+';globalThis.reset=resetRunCleanup;globalThis.save=save;globalThis.event=event;globalThis.own=()=>{checkpointOwned=true;};',sandbox);
 sandbox.reset();assert.equal(state.poolClosed,false);assert.equal(state.unlock,false);assert.equal(state.maintenanceClosed,false);assert.equal(state.rollbackConfirmed,false);
 assert.equal(state.phases.users.nextIndex,10);sandbox.save();sandbox.event({event:'should-not-write'});assert.equal(writes.length,0);
 sandbox.own();sandbox.save();sandbox.event({event:'owned'});assert.deepEqual(writes.map(write=>write[0]),['checkpoint','event']);
});
