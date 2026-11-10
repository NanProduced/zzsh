import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRoundDependencyProof, assertBoundRunnerScripts, assertListedRunnerScripts, assertNextSourceTools, optionalRoundSourceScripts, NEXT_SOURCE_SCRIPTS, distributionDependencyRequirements, inspectRoundDependencyLayout, probeRoundDependencies, listedDependencyRequirements, DISTRIBUTION_ROUND_SCRIPTS, DISTRIBUTION_EXTRA_MODULES, LISTED_ROUND_SCRIPTS, LISTED_EXTRA_MODULES, ROUND_MODULES, ROUND_SCRIPTS } from "./local-round-dependencies.mjs";
import { NEXT_MIGRATION_PROFILE } from "./local-target-registry.mjs";
const ROUND_MODULE_COUNT = ROUND_MODULES.length;
test('new restored source seals all capture tools and rejects changed code without altering old manifests',()=>{
 assert.deepEqual(optionalRoundSourceScripts({files:[]}),[]);
 const hash='a'.repeat(64),files=NEXT_SOURCE_SCRIPTS.map(name=>({path:'scripts/migration/'+name,sha256:hash}));
 assert.deepEqual(optionalRoundSourceScripts({files}),NEXT_SOURCE_SCRIPTS);
 assert.throws(()=>optionalRoundSourceScripts({files:files.slice(0,-1)}),/ROUND_DEPENDENCY_SOURCE_RESTORE_TOOLS_REQUIRED/);
 assert.throws(()=>optionalRoundSourceScripts({files:[...files,files[0]]}),/ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID/);
 const scripts=Object.fromEntries([...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs'].map(name=>[name,hash]));
 const input={target:{migrationProfile:NEXT_MIGRATION_PROFILE}},binding={toolSha256:hash,checkpointToolSha256:hash},receipt={toolSha256:hash,supportToolSha256:hash,accountExtraToolSha256:hash},workflow={toolFiles:scripts};
 assert.doesNotThrow(()=>assertNextSourceTools(input,binding,[receipt,receipt,receipt],scripts,workflow));
 assert.doesNotThrow(()=>assertNextSourceTools({target:{}},null,[],{}));
 assert.throws(()=>assertNextSourceTools(input,{...binding,toolSha256:'0'.repeat(64)},[receipt],scripts,workflow),/ROUND_SOURCE_RESTORE_TOOL_CHANGED/);
 assert.throws(()=>assertNextSourceTools(input,{...binding,checkpointToolSha256:'0'.repeat(64)},[receipt],scripts,workflow),/ROUND_SOURCE_CHECKPOINT_TOOL_CHANGED/);
 assert.throws(()=>assertNextSourceTools(input,binding,[{...receipt,toolSha256:'0'.repeat(64)}],scripts,workflow),/ROUND_SOURCE_CAPTURE_TOOL_CHANGED/);
 const incomplete={...scripts};delete incomplete[NEXT_SOURCE_SCRIPTS[2]];assert.throws(()=>assertNextSourceTools(input,binding,[receipt],incomplete,workflow),/ROUND_DEPENDENCY_SOURCE_RESTORE_TOOLS_REQUIRED/);
 assert.throws(()=>assertNextSourceTools(input,binding,[receipt],scripts,{toolFiles:{...scripts,'../local-auth.mjs':'0'.repeat(64)}}),/ROUND_DEPENDENCY_SOURCE_RESTORE_TOOLS_REQUIRED/);
});
test('new distribution workflow seals every tool and required API entrypoint',()=>{
 assert.deepEqual(distributionDependencyRequirements({files:[]}),{scripts:[],modules:[]});
 const files=DISTRIBUTION_ROUND_SCRIPTS.map(name=>({path:'scripts/migration/'+name,sha256:'a'.repeat(64)}));
 const result=distributionDependencyRequirements({files});assert.deepEqual(result.scripts,DISTRIBUTION_ROUND_SCRIPTS);
 assert.deepEqual(result.modules,DISTRIBUTION_EXTRA_MODULES.filter(name=>!ROUND_MODULES.includes(name)));
 assert.throws(()=>distributionDependencyRequirements({files:files.filter(row=>!row.path.endsWith('local-distribution-policy-runtime.mjs'))}),/ROUND_DEPENDENCY_DISTRIBUTION_TOOLS_REQUIRED/);
 assert.throws(()=>distributionDependencyRequirements({files:[...files,files[0]]}),/ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID/);
});

test("dependency probe validates the actual module count and rejects incomplete results", () => {
  const layout = { apiDist:"api", sourceRoot:"source", moduleDirs:["a","b"] };
  const spawn = (_bin,_args) => ({status:0,signal:null,stdout:JSON.stringify({files:[["node_modules/pkg/index.js","a".repeat(64)]],entrypoints:ROUND_MODULE_COUNT})});
  assert.equal(probeRoundDependencies(layout,spawn).entrypoints,ROUND_MODULE_COUNT);
  assert.throws(() => probeRoundDependencies(layout,()=>({status:0,signal:null,stdout:JSON.stringify({files:[["x","a"]],entrypoints:0})})),/ROUND_DEPENDENCY_PROBE_INVALID/);
  const extra={...layout,extraEntrypoints:['supply/publishing']};
  const spawnExtra=(_bin,args)=>({status:0,signal:null,stdout:JSON.stringify({files:[["node_modules/pkg/index.js","a".repeat(64)]],entrypoints:JSON.parse(args.at(-1)).length})});
  assert.equal(probeRoundDependencies(extra,spawnExtra).entrypoints,ROUND_MODULE_COUNT+1);
});

test('new listed tools and API entrypoints are required together without changing historical manifests',()=>{
 assert.deepEqual(listedDependencyRequirements({files:[]}),{scripts:[],modules:[]});
 const files=LISTED_ROUND_SCRIPTS.map(name=>({path:'scripts/migration/'+name,sha256:'a'.repeat(64)}));
 const result=listedDependencyRequirements({files});assert.deepEqual(result.scripts,LISTED_ROUND_SCRIPTS);
 assert.deepEqual(result.modules,LISTED_EXTRA_MODULES.filter(name=>!ROUND_MODULES.includes(name)));
 assert.throws(()=>listedDependencyRequirements({files:files.filter(row=>!row.path.endsWith('legacy-listed-round-source.mjs'))}),/ROUND_DEPENDENCY_LISTED_TOOLS_REQUIRED/);
 assert.throws(()=>listedDependencyRequirements({files:[...files,files[0]]}),/ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID/);
});

test("the invoking runner and its direct imports match the sealed scripts", t => {
  const root = mkdtempSync(join(tmpdir(),"round-runner-")), dir=join(root,"migration");t.after(()=>rmSync(root,{recursive:true}));mkdirSync(dir);
  const files=["run-local-round.mjs","local-round-contract.mjs","local-round-dependencies.mjs","local-load-checkpoint.mjs","full-source-scope.mjs","selected-business-scope.mjs","verify-full-source-population.mjs","local-source-adapter.mjs","local-target-registry.mjs","../local-auth.mjs"];
  const digest={};for(const file of files){writeFileSync(join(dir,file),file);digest[file]=createHash("sha256").update(file).digest("hex");}
  assert.doesNotThrow(()=>assertBoundRunnerScripts(dir,digest));writeFileSync(join(dir,"local-target-registry.mjs"),"changed");
  assert.throws(()=>assertBoundRunnerScripts(dir,digest),/ROUND_DEPENDENCY_RUNNER_CHANGED/);
  writeFileSync(join(dir,"local-target-registry.mjs"),"local-target-registry.mjs");
  writeFileSync(join(dir,"verify-full-source-population.mjs"),"changed");
  assert.throws(()=>assertBoundRunnerScripts(dir,digest),/ROUND_DEPENDENCY_RUNNER_CHANGED:verify-full-source-population.mjs/);
});

test("new rental reference validator is sealed without changing older manifest requirements", t => {
  const root=mkdtempSync(join(tmpdir(),"round-source-seal-"));t.after(()=>rmSync(root,{recursive:true}));
  const sourceRoot=join(root,"source"),scriptDir=join(sourceRoot,"scripts/migration"),snapshot=join(root,"snapshot"),snapshotScripts=join(snapshot,"scripts/migration");
  for(const dir of [scriptDir,snapshotScripts,join(sourceRoot,"apps/api/node_modules"),join(sourceRoot,"node_modules")])mkdirSync(dir,{recursive:true});
  const hash=value=>createHash("sha256").update(value).digest("hex");
  for(const name of ROUND_SCRIPTS){writeFileSync(join(scriptDir,name),name);writeFileSync(join(snapshotScripts,name),name);}
  const lock=Buffer.from("lock");writeFileSync(join(sourceRoot,"package-lock.json"),lock);writeFileSync(join(sourceRoot,"node_modules/.package-lock.json"),lock);
  const manifestPath=join(root,"source-manifest.json"),buildPath=join(root,"build-manifest.json"),bundlePath=join(root,"bundle.json"),apiDist=join(root,"api-dist");
  const seal=files=>{
    const sourceBytes=Buffer.from(JSON.stringify({schema:"zzsh.round07-source-snapshot.v1",files}));writeFileSync(manifestPath,sourceBytes);
    const sourceSha=hash(sourceBytes),buildBytes=Buffer.from(JSON.stringify({schema:"zzsh.round07-preview-build.v1",sourceSnapshotManifestSha256:sourceSha,
      layout:{apiDistDir:"apps/api/dist/src"},components:{api:[{path:"package-lock.json",sha256:hash(lock)},{path:"node_modules/.package-lock.json",sha256:hash(lock)}]}}));
    writeFileSync(buildPath,buildBytes);const buildSha=hash(buildBytes),bundleBytes=Buffer.from(JSON.stringify({finalBuildManifestSha256:buildSha,finalSourceManifestSha256:sourceSha,entries:[]}));
    writeFileSync(bundlePath,bundleBytes);
    return {apiDist,bundlePath,bundleSha256:hash(bundleBytes),buildManifestPath:buildPath,buildManifestSha256:buildSha,sourceSnapshot:snapshot,sourceManifestPath:manifestPath,sourceManifestSha256:sourceSha};
  };
  const old=inspectRoundDependencyLayout(seal([]));assert.equal(Object.hasOwn(old.scriptFiles,"business-reference-readiness.mjs"),false);
  const name="business-reference-readiness.mjs",content="fixture validator",path="scripts/migration/"+name;
  writeFileSync(join(scriptDir,name),content);writeFileSync(join(snapshotScripts,name),content);
  const entry={path,sha256:hash(content)},binding=seal([entry]),current=inspectRoundDependencyLayout(binding);
  assert.equal(current.scriptFiles[name],entry.sha256);assert.doesNotThrow(()=>assertBoundRunnerScripts(scriptDir,current.scriptFiles));
  writeFileSync(join(scriptDir,name),"changed");writeFileSync(join(snapshotScripts,name),"changed");
  assert.throws(()=>inspectRoundDependencyLayout(binding),/ROUND_DEPENDENCY_SOURCE_MANIFEST_CHANGED/);
  writeFileSync(join(scriptDir,name),content);writeFileSync(join(snapshotScripts,name),content);
  assert.throws(()=>inspectRoundDependencyLayout(seal([entry,entry])),/ROUND_DEPENDENCY_SOURCE_MANIFEST_INVALID/);
  const growthName='local-growth-packages.mjs',growthContent='fixture growth packager',growthEntry={path:'scripts/migration/'+growthName,sha256:hash(growthContent)};
  writeFileSync(join(scriptDir,growthName),growthContent);writeFileSync(join(snapshotScripts,growthName),growthContent);
  const withGrowth=inspectRoundDependencyLayout(seal([entry,growthEntry]));assert.equal(withGrowth.scriptFiles[growthName],growthEntry.sha256);
  assert.doesNotThrow(()=>assertBoundRunnerScripts(scriptDir,withGrowth.scriptFiles));
  writeFileSync(join(scriptDir,growthName),'changed');writeFileSync(join(snapshotScripts,growthName),'changed');
  assert.throws(()=>inspectRoundDependencyLayout(seal([entry,growthEntry])),/ROUND_DEPENDENCY_SOURCE_MANIFEST_CHANGED/);
  writeFileSync(join(scriptDir,growthName),growthContent);writeFileSync(join(snapshotScripts,growthName),growthContent);
  const listed=LISTED_ROUND_SCRIPTS.map(file=>{writeFileSync(join(scriptDir,file),file);writeFileSync(join(snapshotScripts,file),file);return {path:'scripts/migration/'+file,sha256:hash(file)}});
  const listedBinding=seal([entry,...listed]),withListed=inspectRoundDependencyLayout(listedBinding);
  assert.deepEqual(withListed.extraEntrypoints,LISTED_EXTRA_MODULES.filter(file=>!ROUND_MODULES.includes(file)));
  assert.doesNotThrow(()=>assertListedRunnerScripts(scriptDir,withListed.scriptFiles));
  const distribution=DISTRIBUTION_ROUND_SCRIPTS.filter(file=>!LISTED_ROUND_SCRIPTS.includes(file)).map(file=>{
    writeFileSync(join(scriptDir,file),file);writeFileSync(join(snapshotScripts,file),file);return {path:'scripts/migration/'+file,sha256:hash(file)};
  });
  const combined=inspectRoundDependencyLayout(seal([entry,...listed,...distribution]));
  assert.deepEqual(combined.extraEntrypoints,[...new Set([...LISTED_EXTRA_MODULES,...DISTRIBUTION_EXTRA_MODULES].filter(file=>!ROUND_MODULES.includes(file)))]);
  assert.equal(combined.scriptFiles['run-local-distribution-workflow.mjs'],hash('run-local-distribution-workflow.mjs'));
  seal([entry,...listed]);
  writeFileSync(join(scriptDir,LISTED_ROUND_SCRIPTS[1]),'changed');writeFileSync(join(snapshotScripts,LISTED_ROUND_SCRIPTS[1]),'changed');
  assert.throws(()=>assertListedRunnerScripts(scriptDir,withListed.scriptFiles),/ROUND_DEPENDENCY_RUNNER_CHANGED/);
  assert.throws(()=>inspectRoundDependencyLayout(listedBinding),/ROUND_DEPENDENCY_SOURCE_MANIFEST_CHANGED/);
});

test("dependency proof rejects changed bytes, changed script lineage and path escape", t => {
  const root = mkdtempSync(join(tmpdir(), "round-deps-")); t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true }); const file = join(root, "node_modules/pkg/index.js"); writeFileSync(file, "module.exports=1;\n");
  const hash = value => createHash("sha256").update(value).digest("hex"), files = [["node_modules/pkg/index.js", hash("module.exports=1;\n")]];
  const expected = { apiDist: "api", sourceRoot: root, sourceSnapshot: "snapshot", sourceManifestSha256: "source", scriptDir: "scripts", moduleDirs: ["modules"], bundleSha256: "bundle", buildManifestSha256: "manifest", scriptFiles: { "loader.mjs": "digest" } };
  const proof = { ...expected, status: "ROUND_DEPENDENCY_CLOSURE_VERIFIED", nodeVersion: process.version, closureFiles: files, closureSha256: hash(JSON.stringify(files)), entrypoints: ROUND_MODULE_COUNT };
  assert.doesNotThrow(() => assertRoundDependencyProof(proof, expected));
  assert.throws(() => assertRoundDependencyProof({ ...proof, scriptFiles: {} }, expected), /ROUND_DEPENDENCY_PROOF_CHANGED/);
  const escape = [["../outside", hash("anything")]];
  assert.throws(() => assertRoundDependencyProof({ ...proof, closureFiles: escape, closureSha256: hash(JSON.stringify(escape)) }, expected), /ROUND_DEPENDENCY_FILE_INVALID/);
  writeFileSync(file, "module.exports=2;\n"); assert.throws(() => assertRoundDependencyProof(proof, expected), /ROUND_DEPENDENCY_FILE_CHANGED/);
});
