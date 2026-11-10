import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LISTED_EXTRA_MODULES, LISTED_ROUND_SCRIPTS, ROUND_MODULES, verifyRoundDistributionSource } from './local-round-dependencies.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),root=fileURLToPath(new URL('../..',import.meta.url));
test('round preflight rejects source, compiled parser and dependency drift',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'zzsh-distribution-preflight-')),configFile=join(dir,'config.jsonl'),levelsFile=join(dir,'levels.jsonl');
 const sourceRoot=join(dir,'source'),api=join(dir,'build','src'),pkg=join(sourceRoot,'apps/api/package.json'),dependency=join(sourceRoot,'node_modules/fixture-policy/index.js'),
  content=join(api,'supply/content-hash.js'),parser=join(api,'finance/distribution-policy-change.js'),growth=join(api,'auth/membership-growth-legacy-cli.js');
 for(const path of [join(sourceRoot,'apps/api'),join(sourceRoot,'node_modules/fixture-policy'),join(api,'supply'),join(api,'finance'),join(api,'auth')])mkdirSync(path,{recursive:true});
 t.after(()=>{for(const file of [configFile,levelsFile,pkg,dependency,content,parser,growth])if(existsSync(file))unlinkSync(file);
  for(const path of [join(sourceRoot,'apps/api'),join(sourceRoot,'apps'),join(sourceRoot,'node_modules/fixture-policy'),join(sourceRoot,'node_modules'),sourceRoot,
   join(api,'supply'),join(api,'finance'),join(api,'auth'),api,join(dir,'build'),dir])if(existsSync(path))rmdirSync(path)});
 writeFileSync(pkg,'{}');writeFileSync(dependency,"exports.normalize = value => value.replace(/\\.0+$/, '');\n");
 writeFileSync(content,'exports.canonicalize = value => JSON.stringify(value);\n');
 writeFileSync(parser,"const {normalize} = require('fixture-policy'); exports.parseDistributionPolicyChange = value => ({...value,config:{...value.config,levels:value.config.levels.map(row=>({...row,renterPercent:normalize(row.renterPercent),ownerPercent:normalize(row.ownerPercent)}))}});\n");
 const settings={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'5.0'};
 const config=Buffer.from(Object.entries(settings).map(([name,value])=>JSON.stringify({name,value,is_delete:'0'})).join('\n')+'\n');
 const levels=Buffer.from(JSON.stringify({id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'合成',is_delete:'0'})+'\n');
 writeFileSync(configFile,config);writeFileSync(levelsFile,levels);
 const source={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{distributionConfig:{file:'config.jsonl',sha256:sha(config),rows:6},
  distributionLevels:{file:'levels.jsonl',sha256:sha(levels),rows:1}}};
 const scriptDir=join(root,'scripts/migration'),scriptFiles=Object.fromEntries(LISTED_ROUND_SCRIPTS.map(name=>[name,sha(readFileSync(join(scriptDir,name)))]));
 const buildFiles={'supply/content-hash.js':sha(readFileSync(content)),'finance/distribution-policy-change.js':sha(readFileSync(parser))};
 const layout={apiDist:api,sourceRoot,moduleDirs:[join(sourceRoot,'apps/api/node_modules'),join(sourceRoot,'node_modules')],scriptFiles,
  extraEntrypoints:LISTED_EXTRA_MODULES.filter(name=>!ROUND_MODULES.includes(name))};
 const proof={closureFiles:[['node_modules/fixture-policy/index.js',sha(readFileSync(dependency))]]},input={apiDist:api,buildFiles,source:{path:dir,sha256:'a'.repeat(64)}};
 const args={input,source,layout,proof,runnerDir:scriptDir,privatePath:value=>value},oldNodePath=process.env.NODE_PATH;
 const evidence=await verifyRoundDistributionSource(args);
 assert.equal(evidence.status,'DISTRIBUTION_SOURCE_PRECHECK_PASSED_TARGET_NOT_RUN');assert.equal(evidence.settlementDelayDays,5);
 assert.equal(evidence.targetWrites,0);assert.equal(process.env.NODE_PATH,oldNodePath);
 await assert.rejects(verifyRoundDistributionSource({...args,layout:{...layout,extraEntrypoints:[]}}),/ROUND_DISTRIBUTION_DEPENDENCY_REQUIRED/);
 const changed={...layout,scriptFiles:{...scriptFiles,'local-distribution-qualification-plan.mjs':'0'.repeat(64)}};
 await assert.rejects(verifyRoundDistributionSource({...args,layout:changed}),/ROUND_DEPENDENCY_RUNNER_CHANGED/);
 await assert.rejects(verifyRoundDistributionSource({...args,proof:{closureFiles:[]}}),/ROUND_DISTRIBUTION_DEPENDENCY_CHANGED/);
 writeFileSync(levelsFile,Buffer.concat([levels,Buffer.from('\n')]));
 await assert.rejects(verifyRoundDistributionSource(args),/SOURCE_STREAM_CHANGED/);
 writeFileSync(levelsFile,levels);writeFileSync(growth,"exports.LEGACY_GROWTH_PRECOMMIT_GUARD_VERSION = 'v1';\n");
 const inline={...input,growth:{approvalLayout:'INLINE_INTENT_V1'},buildFiles:{...buildFiles,'auth/membership-growth-legacy-cli.js':sha(readFileSync(growth))}};
 const checked=await verifyRoundDistributionSource({...args,input:inline});assert.equal(checked.growthCommitGuardSha256,inline.buildFiles['auth/membership-growth-legacy-cli.js']);
 const next={...inline,target:{migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}};
 await assert.rejects(verifyRoundDistributionSource({...args,input:next}),/ROUND_GROWTH_TARGET_FENCE_GUARD_REQUIRED/);
 writeFileSync(growth,"exports.LEGACY_GROWTH_PRECOMMIT_GUARD_VERSION = 'v1'; exports.LEGACY_GROWTH_TARGET_FENCE_GUARD_VERSION = 'v1';\n");
 next.buildFiles={...next.buildFiles,'auth/membership-growth-legacy-cli.js':sha(readFileSync(growth))};
 assert.equal((await verifyRoundDistributionSource({...args,input:next})).growthFenceGuardVersion,'v1');
 writeFileSync(growth,"exports.LEGACY_GROWTH_PRECOMMIT_GUARD_VERSION = 'old';\n");
 const old={...inline,buildFiles:{...inline.buildFiles,'auth/membership-growth-legacy-cli.js':sha(readFileSync(growth))}};
 await assert.rejects(verifyRoundDistributionSource({...args,input:old}),/ROUND_GROWTH_PRECOMMIT_GUARD_REQUIRED/);
});
