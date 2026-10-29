import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
const run=(args)=>spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout:30000});
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const put=(p,value)=>writeFileSync(p,JSON.stringify(value));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function planned(){const dir=temp(),r=run(['plan','--out',dir]);assert.equal(r.status,0,r.stderr);return{dir,plan:load(join(dir,'plan.json')),planFile:join(dir,'plan.json')};}

test("offline plan is zero-network, zero-writer and never rentable", () => {
  const out = temp();
  const run = spawnSync(process.execPath, [CLI, "plan", "--api-dist", API_DIST, "--out", out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  assert.equal(plan.io.networkAttempts, 0);
  assert.equal(plan.io.dbConnects, 0);
  assert.equal(plan.io.writerCalls, 0);
  assert.equal(plan.writerCalls, 0);
  assert.equal(plan.domains.account.items.every((item) => item.rentableGate.rentable === false), true);
  assert.equal(plan.domains.continuation.counts.CONFLICT, 0);
});

test("selftest covers positive/negative reconciliation and fail-closed guards", () => {
  const out = temp();
  const run = spawnSync(process.execPath, [CLI, "selftest", "--api-dist", API_DIST, "--out", out], { encoding: "utf8" });
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
 const p=planned(),target=load(join(HERE,'fixtures/target-readback.positive.json'));change(target);const targetFile=join(p.dir,'target.json');put(targetFile,target);
 const r=run(['reconcile','--plan',p.planFile,'--target',targetFile,'--out',join(p.dir,'compare')]);assert.equal(r.status,2,r.stderr);assert.equal(load(join(p.dir,'compare/reconcile.json')).summary.conserved,false);
});

test('missing duty money remains unknown instead of becoming a conserved zero',()=>{
 const p=planned(),target=load(join(HERE,'fixtures/target-readback.positive.json'));p.plan.domains.finance.duties[0].amountCents=null;target.duties[0].amountCents=null;put(p.planFile,p.plan);const targetFile=join(p.dir,'target.json');put(targetFile,target);
 const r=run(['reconcile','--plan',p.planFile,'--target',targetFile,'--out',join(p.dir,'compare')]);assert.equal(r.status,2,r.stderr);const result=load(join(p.dir,'compare/reconcile.json'));assert.equal(result.conservation.duties.sourceCents,null);assert.equal(result.conservation.duties.targetCents,null);assert.equal(result.summary.amountConserved,false);
});

test('readiness rejects a conserved report belonging to another plan and labels fixture evidence',()=>{
 const p=planned(),r=run(['reconcile','--plan',p.planFile,'--target',join(HERE,'fixtures/target-readback.positive.json'),'--out',join(p.dir,'compare')]);assert.equal(r.status,0,r.stderr);
 const report=join(p.dir,'compare/reconcile.json');let ready=run(['readiness','--plan',p.planFile,'--reconcile',report,'--out',join(p.dir,'ready')]);assert.equal(ready.status,0,ready.stderr);const result=load(join(p.dir,'ready/rehearsal-readiness.json'));assert.equal(result.domains.sourceTargetConservation,'FIXTURE_PASS');assert.equal(p.plan.domains.account.counts.CONFLICT,0);assert.notEqual(result.domains.accountSource,'BLOCKED_CONFLICT');assert.notEqual(result.domains.skins,'BLOCKED_CONFLICT');
 p.plan.generatedAt='2026-01-01T00:00:00.000Z';put(p.planFile,p.plan);ready=run(['readiness','--plan',p.planFile,'--reconcile',report,'--out',join(p.dir,'wrong')]);assert.equal(ready.status,3);assert.match(ready.stderr,/RECONCILIATION_PLAN_MISMATCH/);
});

test('target export must bind the source manifest and actual PostgreSQL resource',()=>{
 for(const mutation of [t=>{t.sourceManifestSha256='0'.repeat(64);},t=>{t.fixtureOnly=false;}]){
  const p=planned(),target=load(join(HERE,'fixtures/target-readback.positive.json'));mutation(target);const f=join(p.dir,'target.json');put(f,target);const r=run(['reconcile','--plan',p.planFile,'--target',f,'--out',join(p.dir,'compare')]);assert.equal(r.status,3);assert.match(r.stderr,/TARGET_SOURCE_BINDING_MISMATCH|TARGET_RESOURCE_UNBOUND/);
 }
});

test('planner build drift and private input references reject before loading or reading them',()=>{
 const dir=temp(),manifest=load(join(HERE,'fixtures/manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(HERE,'fixtures',spec.path);
 const privateDir=join(dir,'.secrets');mkdirSync(privateDir);const privateFile=join(privateDir,'fixture.json');writeFileSync(privateFile,'{"password":"SYNTHETIC_PRIVATE_PROBE"}');manifest.inputs.identities={path:privateFile,sha256:sha(readFileSync(privateFile))};const mf=join(dir,'manifest.json');put(mf,manifest);let r=run(['plan','--manifest',mf,'--out',join(dir,'private-plan')]);assert.equal(r.status,3);assert.match(r.stderr,/PRIVATE_INPUT_REFUSED/);assert.doesNotMatch(r.stderr,/SYNTHETIC_PRIVATE_PROBE/);
 const original=load(join(HERE,'fixtures/manifest.json')),copy=join(dir,'api');for(const relative of Object.keys(original.plannerBuild.files)){const dest=join(copy,relative);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(API_DIST,relative),dest);}const changed=join(copy,'legacy-load/user-order-offline-plan.js');writeFileSync(changed,readFileSync(changed,'utf8')+'\n// changed fixture module\n');r=run(['plan','--api-dist',copy,'--out',join(dir,'drift-plan')]);assert.equal(r.status,3);assert.match(r.stderr,/PLANNER_BUILD_DRIFT/);
});

test('a skin held only by another account cannot authorize this account media',()=>{
 const dir=temp(),manifest=load(join(HERE,'fixtures/manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(HERE,'fixtures',spec.path);
 const skins=load(manifest.inputs.skins.path);skins.holdings.find(x=>x.accountKey==='10').columns.agent_skin='';const skinFile=join(dir,'skins.json');put(skinFile,skins);manifest.inputs.skins={path:skinFile,sha256:sha(readFileSync(skinFile))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.ok(plan.domains.media.items.find(x=>x.mediaId==='media-2').reasons.includes('SKIN_NOT_IN_HOLDING'));assert.ok(plan.domains.continuation.items.every(x=>!x.command||!('body' in x.command)),'public plan stores command fingerprints and safe binding fields, not raw bodies');
});

test('missing evidence survives without the original manifest argument and blocks a different manifest',()=>{
 const p=planned(),r=run(['missing-evidence','--plan',p.planFile,'--out',join(p.dir,'missing')]);assert.equal(r.status,0,r.stderr);const missing=load(join(p.dir,'missing/missing-evidence.json'));
 assert.ok(missing.rows.some(x=>x.reasons.includes('FIN-01_FAILED_WITHDRAWAL_SOURCE_NOT_READ')));assert.ok(missing.rows.some(x=>x.reasons.includes('FIN-02_MANUAL_ADJUSTMENT_OR_DEPOSIT_COMP_SOURCE_NOT_READ')));assert.ok(missing.rows.some(x=>x.domain==='finance'&&x.reasons.includes('IDENTITY_ISOLATED')));
 const wrong=join(p.dir,'wrong.json');put(wrong,{missingEvidenceSeeds:[]});const bad=run(['missing-evidence','--plan',p.planFile,'--manifest',wrong,'--out',join(p.dir,'bad')]);assert.equal(bad.status,3);assert.match(bad.stderr,/MANIFEST_PLAN_MISMATCH/);
});

test('an unconfirmed opening does not claim a commission root already covered',()=>{
 const dir=temp(),manifest=load(join(HERE,'fixtures/manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(HERE,'fixtures',spec.path);
 const finance=load(manifest.inputs.finance.path),unconfirmed=finance.storedOpenings.find(x=>x.label==='missing-proof'||x.subject?.identityState==='ISOLATED')??finance.storedOpenings.at(-1);
 unconfirmed.covered[0].sourceEntity='la_distribution_order';unconfirmed.covered[0].sourceId='91';const source=join(dir,'finance.json');put(source,finance);manifest.inputs.finance={path:source,sha256:sha(readFileSync(source))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.equal(plan.domains.finance.openingDutyOverlap.length,0);assert.ok(plan.domains.finance.openings.some(x=>x.status==='MISSING_FACT'));
});

test('one legacy wallet cannot contain two independently labelled opening candidates',()=>{
 const dir=temp(),manifest=load(join(HERE,'fixtures/manifest.json'));for(const spec of Object.values(manifest.inputs))spec.path=join(HERE,'fixtures',spec.path);
 const finance=load(manifest.inputs.finance.path),duplicate=structuredClone(finance.storedOpenings[0]);duplicate.openingId='another_case_label';finance.storedOpenings.push(duplicate);const source=join(dir,'finance.json');put(source,finance);manifest.inputs.finance={path:source,sha256:sha(readFileSync(source))};const mf=join(dir,'manifest.json');put(mf,manifest);
 const r=run(['plan','--manifest',mf,'--out',join(dir,'plan')]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan/plan.json'));assert.equal(plan.domains.finance.status,'BLOCKED');assert.ok(plan.domains.finance.duplicateOpeningSubjects.includes('fixture-user'));assert.equal(plan.domains.finance.openings.filter(x=>x.status==='READY').length,0);
});

test('FIN-02 is an alternative original-balance scenario, not a second opening for the same user',()=>{
 const dir=temp(),r=run(['plan','--manifest',join(HERE,'fixtures/manifest-fin02.json'),'--out',dir]);assert.equal(r.status,0,r.stderr);const plan=load(join(dir,'plan.json')),ready=plan.domains.finance.openings.filter(x=>x.status==='READY');assert.equal(ready.length,1);assert.equal(ready[0].availableCents,'110');assert.equal(ready[0].coveredCount,1);assert.equal(ready[0].flowSum,'NOT_COMPUTED');assert.equal(ready[0].openingIdMeaning,'SCENARIO_LABEL_NOT_DATABASE_ID');
});
