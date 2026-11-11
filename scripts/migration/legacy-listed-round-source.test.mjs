import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSameCaptureListedPolicy,buildSameCaptureListedPolicyBatches,collectListedAccounts,collectVerifiedListedAccounts,readBoundListedAccounts,verifySameCaptureListedPolicySource,validateSameCaptureListedPolicyBatches,selectSameCaptureListedBatch,auditSameCaptureListedInputs,readRoundListedBatch,validateRoundSourceProof,validateRoundTrialReceipt,validateRoundAccountSet} from './legacy-listed-round-source.mjs';
const canonical=x=>JSON.stringify(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
test('same-capture policy command defaults to a no-connection plan and refuses missing bound inputs',()=>{
 const script=new URL('./prepare-listed-same-capture-policy.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
 const plan=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000});assert.equal(plan.status,0,plan.stderr);
 const info=JSON.parse(plan.stdout);assert.deepEqual([info.status,info.connections,info.targetWrites],['PLAN_ONLY',0,0]);
 const unbound=spawnSync(process.execPath,[script,'--prepare'],{encoding:'utf8',timeout:5000});assert.notEqual(unbound.status,0);
 assert.match(unbound.stderr,/LISTED_CAPTURE_PRIVATE_PATH_REQUIRED/);
});
test('listed set is derived from all captured rows without a previous fixed-size list',async()=>{
 const listed=[{id:'1',status:'3',is_delete:'0'},{id:'3',status:'3',is_delete:'0'}];
 const result=await collectListedAccounts([{id:'2',status:'4',is_delete:'0'},...listed],canonical);
 assert.equal(result.captured,3);
 assert.deepEqual([...result.digests],[...listed.map(row=>[row.id,sha(canonical(row))])]);
 assert.equal((await collectListedAccounts([],canonical)).digests.size,0);
 await assert.rejects(collectListedAccounts([listed[0],listed[0]],canonical),/LISTED_SOURCE_ACCOUNT_DUPLICATE/);
 await assert.rejects(collectListedAccounts([{id:'4',status:'?',is_delete:'0'}],canonical),/LISTED_SOURCE_ACCOUNT_INVALID/);
});
async function capturedPolicyFixture(count=2){
 const accounts=Array.from({length:count},(_,i)=>({id:String(i+1),status:'3',is_delete:'0',game_id:'1'}));
 const scan=await collectListedAccounts(accounts,canonical);
 const names=['barrettBullet','bullet','awm','armor','helmet','coffee','experienceCard','barrettBulletSale','bulletSale','awmSale','armorSale','helmetSale','coffeeSale','experienceCardSale'];
 const settings=names.map((name,i)=>({id:String(i+1),type:'expendConfig',name,value:'1'}));
 settings.push({id:'99',type:'game',name:'profitFirstDot',value:'12'});
 const games=[{id:'1',is_delete:'0',profit_dot:'6'}];
 const receipt={schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,containerId:'d'.repeat(64),database:'sg_zzsh_restore',
  startedAt:'2026-11-03T08:00:00Z',finishedAt:'2026-11-03T08:01:00Z',identity:{database:'sg_zzsh_restore',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE'},
  listedPricingCapture:{schema:'zzsh.legacy-listed-pricing-capture.v1',gameDomain:'games',gameProfitField:'profit_dot',fastConfigDomain:'tradePolicy',fastConfigType:'game',fastConfigName:'profitFirstDot',runtimeRedis:'NOT_CAPTURED'},
  files:{accounts:{rows:count},games:{rows:1,fields:['id','profit_dot']},tradePolicy:{rows:15,fields:['id','type','name','value']}}};
 const dump={schema:'zzsh.legacy-listing-dump-policy-check.v1',sourceDumpSha256:'c'.repeat(64),sourceCutoff:'2026-11-03T07:59:00Z',
  sourceCutoffMeaning:'OWNER_LOCAL_DUMP_EXPORT_COMPLETED_NOT_PROVEN_PRODUCTION_STOP_WRITE_CUTOFF',gameId:'1',ordinaryProfitDot:'6',fastProfitFirstDot:'12',matchCounts:{game:1,fastConfig:1}};
 return {receipt,sourceReceiptSha256:'a'.repeat(64),sourceBindingSha256:'b'.repeat(64),dumpSha256:'c'.repeat(64),verifierSha256:'f'.repeat(64),dump,scan,games,settings,canonicalize:canonical,
  parseInteger:value=>{if(!/^(0|[1-9]\d*)$/.test(value))throw new Error('INVALID');return BigInt(value);}};
}
test('same-capture policy binds the complete current listed set and independently checked MySQL values',async()=>{
 const fixture=await capturedPolicyFixture(),result=buildSameCaptureListedPolicy(fixture);
 assert.equal(result.status,'SAME_CAPTURE_POLICY_PREPARED_NO_TARGET');assert.equal(result.listedAccounts,2);
 assert.equal(result.policy.temporalLimit,'SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED');
 assert.deepEqual(result.policy.supplement.accountSourceDigests.map(x=>x.id),['1','2']);
 assert.equal(verifySameCaptureListedPolicySource(result.policy,fixture.receipt,fixture.games,fixture.settings,canonical,fixture.parseInteger),true);
 for(const mutate of [
  x=>{x.receipt.clientClosed=false;},x=>{x.receipt.identity.accessMode='READ WRITE';},
  x=>{x.receipt.listedPricingCapture.runtimeRedis='CAPTURED';},x=>{x.receipt.files.accounts.rows++;},
  x=>{x.dump.ordinaryProfitDot='7';},x=>{x.dump.sourceCutoff='2026-11-04T00:00:00Z';},
  x=>{x.settings[0].name=x.settings[1].name;},x=>{x.scan.accounts.get('1').status='4';},
 ]){const changed=await capturedPolicyFixture();mutate(changed);assert.throws(()=>buildSameCaptureListedPolicy(changed));}
 const changed=structuredClone(result.policy);changed.supplement.settingRows[0].value='9';
 assert.throws(()=>verifySameCaptureListedPolicySource(changed,fixture.receipt,fixture.games,fixture.settings,canonical,fixture.parseInteger),/CAPTURE_VALUES_CHANGED/);
 const empty=buildSameCaptureListedPolicy(await capturedPolicyFixture(0));assert.equal(empty.status,'NO_LISTED_SOURCE_ACCOUNTS');assert.equal(empty.policy,null);
 const large=await capturedPolicyFixture(400);assert.throws(()=>buildSameCaptureListedPolicy(large),/LISTED_POLICY_BATCHING_REQUIRED/);
});
test('same-capture output is accepted by the actual API policy reader and retains source limits',async()=>{
 const require=createRequire(import.meta.url),api=relative=>require(new URL(`../../apps/api/dist/src/supply/${relative}.js`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 const {canonicalize}=api('content-hash'),{readLegacyListedPolicy}=api('legacy-listed-policy'),{legacyPriceInteger}=api('legacy-listed-pricing');
 const x=await capturedPolicyFixture();x.canonicalize=canonicalize;x.parseInteger=legacyPriceInteger;
 x.scan=await collectListedAccounts([...x.scan.accounts.values()],canonicalize);
 const result=buildSameCaptureListedPolicy(x),text=canonicalize(result.policy),policySha=sha(text);
 const authority=canonicalize({schema:'legacy-listed-policy-authority-v1',decision:'OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY',scope:'LOCAL_AND_TEST_SERVER',
  runtimeCacheKnowledge:'UNKNOWN',productionCutover:'REVERIFY_SOURCE_RUNTIME_POLICY',sourceReceiptSha256:x.sourceReceiptSha256,sourceBindingSha256:x.sourceBindingSha256,
  dumpSha256:x.dumpSha256,policyBundleSha256:policySha,authorityRef:'synthetic',instruction:'Synthetic test only'});
 const binding={proofSha256:policySha,sourceReceiptSha256:x.sourceReceiptSha256,sourceBindingSha256:x.sourceBindingSha256,dumpSha256:x.dumpSha256,
  dumpVerifierSha256:x.verifierSha256,sourceId:'1',sourceDigest:x.scan.digests.get('1'),legacyGameId:'1',expectedAccountCount:2,
  authorityCanonical:authority,authoritySha256:sha(authority)};
 const verified=readLegacyListedPolicy(text,binding);
 assert.equal(verified.ordinarySpread,'6');assert.equal(verified.fastSpread,'12');
 assert.equal(JSON.parse(verified.policyCanonical).schema,'legacy-listed-policy-frozen-v2');
 assert.equal(verified.temporalLimit,'SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED');
 assert.throws(()=>readLegacyListedPolicy(text,{...binding,sourceDigest:'0'.repeat(64)}),/LEGACY_POLICY_PROOF_INVALID/);
});
test('bounded same-capture batches cover every listed account exactly once in deterministic order',async()=>{
 for(const count of [0,1,200,201,401]){
  const x=await capturedPolicyFixture(count),result=buildSameCaptureListedPolicyBatches(x);
  assert.equal(result.manifest.listedAccounts,count);assert.equal(result.policies.length,Math.ceil(count/200));
  assert.equal(validateSameCaptureListedPolicyBatches(result.manifest,result.policies,x),true);
  assert.equal(result.policies.flatMap(p=>p.supplement.accountSourceDigests).length,count);
  const reversed={...x,scan:{...x.scan,accounts:new Map([...x.scan.accounts].reverse()),digests:new Map([...x.scan.digests].reverse())}};
  assert.deepEqual(buildSameCaptureListedPolicyBatches(reversed).manifest,result.manifest);
 }
 const x=await capturedPolicyFixture(401),result=buildSameCaptureListedPolicyBatches(x);
 for(const mutate of [
  y=>{y.policies.pop();},y=>{y.manifest.batches.pop();},y=>{y.manifest.batches[1].index=1;},
  y=>{y.policies[1].supplement.accountSourceDigests[0]=y.policies[0].supplement.accountSourceDigests[0];},
  y=>{y.policies[0].supplement.sourceReceiptSha256='0'.repeat(64);},y=>{y.manifest.accountSetSha256='0'.repeat(64);},
 ]){const changed=structuredClone(result);mutate(changed);assert.throws(()=>validateSameCaptureListedPolicyBatches(changed.manifest,changed.policies,x),/LISTED_BATCH_CLOSURE_INVALID/);}
 const changedSource=await capturedPolicyFixture(401);changedSource.scan.digests.set('1','0'.repeat(64));
 assert.throws(()=>validateSameCaptureListedPolicyBatches(result.manifest,result.policies,changedSource),/LISTED_BATCH_CLOSURE_INVALID/);
 const changedRaw=await capturedPolicyFixture(401);changedRaw.scan.accounts.get('1').status='4';
 assert.throws(()=>validateSameCaptureListedPolicyBatches(result.manifest,result.policies,changedRaw),/LISTED_BATCH_CLOSURE_INVALID/);
 const changedDump=await capturedPolicyFixture(401),forged=structuredClone(result);
 changedDump.dump.sourceCutoff='2026-11-04T00:00:00Z';
 for(let i=0;i<forged.policies.length;i++){
  forged.policies[i].dumpVerification=changedDump.dump;
  forged.manifest.batches[i].policyCanonicalSha256=sha(canonical(forged.policies[i]));
 }
 assert.throws(()=>validateSameCaptureListedPolicyBatches(forged.manifest,forged.policies,changedDump),/LISTED_BATCH_CLOSURE_INVALID/);
 const empty=await capturedPolicyFixture(0),emptyResult=buildSameCaptureListedPolicyBatches(empty);
 empty.dump.ordinaryProfitDot='7';
 assert.throws(()=>validateSameCaptureListedPolicyBatches(emptyResult.manifest,emptyResult.policies,empty),/LISTED_BATCH_CLOSURE_INVALID/);
 const large=await capturedPolicyFixture(200);large.settings[0].value='1'.repeat(14000);
 assert.ok(buildSameCaptureListedPolicyBatches(large).policies.length>1,'oversized chunks split instead of exceeding the existing limit');
 const impossible=await capturedPolicyFixture(1);impossible.settings[0].value='1'.repeat(33000);
 assert.throws(()=>buildSameCaptureListedPolicyBatches(impossible),/LISTED_POLICY_BATCHING_REQUIRED/);
});

test('each generated batch can be verified by the actual API policy reader',async()=>{
 const require=createRequire(import.meta.url),api=relative=>require(new URL(`../../apps/api/dist/src/supply/${relative}.js`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 const {canonicalize}=api('content-hash'),{readLegacyListedPolicy}=api('legacy-listed-policy'),{legacyPriceInteger}=api('legacy-listed-pricing');
 const x=await capturedPolicyFixture(401);x.canonicalize=canonicalize;x.parseInteger=legacyPriceInteger;x.scan=await collectListedAccounts([...x.scan.accounts.values()],canonicalize);
 const result=buildSameCaptureListedPolicyBatches(x);assert.equal(result.policies.length,3);
 for(const policy of result.policies){const text=canonicalize(policy),policySha=sha(text),rows=policy.supplement.accountSourceDigests;
  const authority=canonicalize({schema:'legacy-listed-policy-authority-v1',decision:'OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY',scope:'LOCAL_AND_TEST_SERVER',
   runtimeCacheKnowledge:'UNKNOWN',productionCutover:'REVERIFY_SOURCE_RUNTIME_POLICY',sourceReceiptSha256:x.sourceReceiptSha256,sourceBindingSha256:x.sourceBindingSha256,
   dumpSha256:x.dumpSha256,policyBundleSha256:policySha,authorityRef:'synthetic',instruction:'Synthetic test only'});
  for(const row of [rows[0],rows.at(-1)])assert.equal(readLegacyListedPolicy(text,{proofSha256:policySha,sourceReceiptSha256:x.sourceReceiptSha256,
   sourceBindingSha256:x.sourceBindingSha256,dumpSha256:x.dumpSha256,dumpVerifierSha256:x.verifierSha256,sourceId:row.id,sourceDigest:row.sha256,
   legacyGameId:'1',expectedAccountCount:rows.length,authorityCanonical:authority,authoritySha256:sha(authority)}).ordinarySpread,'6');
 }
});
test('a selected batch remains bound to the entire source set and exact policy',async()=>{
 const input=await capturedPolicyFixture(401),built=buildSameCaptureListedPolicyBatches(input);
 const selected=selectSameCaptureListedBatch(built.manifest,built.policies,input,2,built.policies[1]);
 assert.equal(selected.accounts.size,200);assert.equal(selected.captured,401);
 assert.deepEqual([...selected.accounts.keys()],built.policies[1].supplement.accountSourceDigests.map(row=>row.id));
 assert.throws(()=>selectSameCaptureListedBatch(built.manifest,built.policies,input,2,built.policies[0]),/LISTED_BATCH_SELECTION_CHANGED/);
 assert.throws(()=>selectSameCaptureListedBatch(built.manifest,built.policies,input,4,built.policies[0]),/LISTED_BATCH_SELECTION_CHANGED/);
 const omitted=structuredClone(built);omitted.policies.pop();omitted.manifest.batches.pop();
 assert.throws(()=>selectSameCaptureListedBatch(omitted.manifest,omitted.policies,input,1,omitted.policies[0]),/LISTED_BATCH_CLOSURE_INVALID/);
 const changed=await capturedPolicyFixture(401);changed.scan.digests.set('1','0'.repeat(64));
 assert.throws(()=>selectSameCaptureListedBatch(built.manifest,built.policies,changed,2,built.policies[1]),/LISTED_BATCH_CLOSURE_INVALID/);
});
test('batch input audit checks prepared owner, frozen source display and path records without asserting target state',async()=>{
 const rows=[1,2].map(n=>({id:String(n),status:'3',is_delete:'0',user_id:`owner-${n}`,img_paths:`img-${n}`,punishment_img_url:''}));
 const scan=await collectListedAccounts(rows,canonical),accounts=new Map(),users=new Map(),displays=new Map(),paths=new Map();
 const listingSnapshot=row=>({snapshot:{id:row.id},sourceUpdatedAt:'2026-01-01T00:00:00.000Z'});
 const legacyDisplayMatchesSource=(row,snapshot)=>snapshot.id===row.id;
 const parseLegacyImagePaths=value=>value?[value]:[];
 for(const row of rows){const digest=scan.digests.get(row.id),user={userId:`u-${row.id}`,sourceDigest:'a'.repeat(64)};users.set(row.user_id,user);
  accounts.set(row.id,{ready:true,sourceDigest:digest,ownerLegacyId:row.user_id,ownerUserId:user.userId,ownerSourceDigest:user.sourceDigest,...listingSnapshot(row)});
  displays.set(row.id,{baseSourceDigest:digest,sourceUpdatedAt:listingSnapshot(row).sourceUpdatedAt,snapshot:{id:row.id,sourceAccountBaseRatioWanPerYuan:'42',sourceAccountFullPayoutSelected:false}});
  paths.set(row.id,{sourceDigest:digest,legacyOwnerId:row.user_id,ownerUserId:user.userId,displayPaths:[row.img_paths],penaltyPaths:[]});
 }
 const policies=rows.map(row=>({supplement:{accountSourceDigests:[{id:row.id,sha256:scan.digests.get(row.id)}]}}));
 const input={scan,policies,accounts,users,displays,paths,canonicalize:canonical,listingSnapshot,legacyDisplayMatchesSource,parseLegacyImagePaths,requireCaptureFacts:true};
 assert.deepEqual(auditSameCaptureListedInputs(input).map(batch=>batch.length),[1,1]);
 for(const [field,mutate,code] of [
  ['accounts',x=>x.get('1').ownerUserId='other','LISTED_BATCH_ACCOUNT_INPUT_MISMATCH'],
  ['users',x=>x.delete('owner-1'),'LISTED_BATCH_ACCOUNT_INPUT_MISMATCH'],
  ['displays',x=>x.get('1').snapshot.id='other','LISTED_BATCH_DISPLAY_INPUT_MISMATCH'],
  ['displays',x=>delete x.get('1').snapshot.sourceAccountFullPayoutSelected,'DISPLAY_CAPTURE_FACTS_REQUIRED'],
  ['paths',x=>x.get('1').displayPaths=[],'LISTED_BATCH_PATH_INPUT_MISMATCH'],
 ]){const changed={...input,[field]:structuredClone(input[field])};mutate(changed[field]);assert.throws(()=>auditSameCaptureListedInputs(changed),new RegExp(code));}
 assert.throws(()=>auditSameCaptureListedInputs({...input,policies:[policies[0]]}),/LISTED_BATCH_AUDIT_SET_CHANGED/);
});
test('batch preparation rereads all captured files and rejects drift before target access',
 {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')},async t=>{
 const root=mkdtempSync('E:/zzsh-local-state/restricted/listed-batch-synthetic-');
 const names=['accounts.jsonl','games.jsonl','tradePolicy.jsonl','receipt.json','source-binding.json','batches.json',
  'policy-0001.json','policy-0002.json','policy-0003.json'];
 t.after(()=>{for(const name of names){const file=join(root,name);if(existsSync(file)){assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());unlinkSync(file)}}rmdirSync(root)});
 const input=await capturedPolicyFixture(401);
 const writeRows=(key,name,rows)=>{const bytes=Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');writeFileSync(join(root,name),bytes);
  input.receipt.files[key]={...input.receipt.files[key],file:name,rows:rows.length,sha256:sha(bytes)};};
 writeRows('accounts','accounts.jsonl',[...input.scan.accounts.values()]);writeRows('games','games.jsonl',input.games);
 writeRows('tradePolicy','tradePolicy.jsonl',input.settings);
 const receiptBytes=Buffer.from(JSON.stringify(input.receipt));writeFileSync(join(root,'receipt.json'),receiptBytes);input.sourceReceiptSha256=sha(receiptBytes);
 const sourceBytes=Buffer.from(JSON.stringify({restoreRecord:{dumpSha256:input.dumpSha256}}));writeFileSync(join(root,'source-binding.json'),sourceBytes);input.sourceBindingSha256=sha(sourceBytes);
 input.verifierSha256=sha(readFileSync(new URL('./verify-legacy-listed-policy-dump.mjs',import.meta.url)));
 const built=buildSameCaptureListedPolicyBatches(input),manifestBytes=Buffer.from(JSON.stringify(built.manifest));writeFileSync(join(root,'batches.json'),manifestBytes);
 const policyFiles=built.policies.map((policy,index)=>{const file=`policy-${String(index+1).padStart(4,'0')}.json`,bytes=Buffer.from(JSON.stringify(policy));writeFileSync(join(root,file),bytes);return {file,sha256:sha(bytes)}});
 const binding={sourceBindingFile:join(root,'source-binding.json'),sourceBindingSha256:input.sourceBindingSha256,expectedAccountCount:200,
  batch:{schema:'zzsh.listed-same-capture-batch-binding.v1',index:2,manifestFile:join(root,'batches.json'),manifestSha256:sha(manifestBytes),policyFiles}};
 const round={source:{sha256:input.sourceReceiptSha256}},read=()=>readRoundListedBatch(binding,round,built.policies[1],root,canonical,input.parseInteger);
 assert.equal((await read()).accounts.size,200);
 await assert.rejects(readRoundListedBatch(binding,round,built.policies[0],root,canonical,input.parseInteger),/LISTED_BATCH_SELECTION_CHANGED/);
 const accountFile=join(root,'accounts.jsonl'),original=readFileSync(accountFile);writeFileSync(accountFile,Buffer.concat([original,Buffer.from('\n')]));
 await assert.rejects(read(),/LISTED_SOURCE_FILE_CHANGED/);writeFileSync(accountFile,original);
 const policyFile=join(root,'policy-0001.json'),policyBytes=readFileSync(policyFile);writeFileSync(policyFile,Buffer.concat([policyBytes,Buffer.from(' ')]));
 await assert.rejects(read(),/LISTED_BOUND_FILE_CHANGED/);writeFileSync(policyFile,policyBytes);
 const gamesFile=join(root,'games.jsonl'),gamesBytes=readFileSync(gamesFile);writeFileSync(gamesFile,Buffer.concat([gamesBytes,Buffer.from('\n')]));
 await assert.rejects(read(),/SOURCE_STREAM_CHANGED/);
});
test('complete source scan accepts every listed account, including zero or more than the old ten',async()=>{
 for(const count of [0,1,11]){
  const listed=Array.from({length:count},(_,i)=>({id:String(i+1),status:'3',is_delete:'0',owner:'fixture'}));
  const other=[{id:'off',status:'4',is_delete:'0'},{id:'deleted',status:'3',is_delete:'1'}];
  const expected=new Map(listed.map(row=>[row.id,sha(canonical(row))]));
  const result=await collectVerifiedListedAccounts([...listed,...other],expected,canonical);
  assert.equal(result.captured,listed.length+other.length);assert.deepEqual([...result.accounts.keys()],[...expected.keys()]);
 }
});

test('listed source scan binds the parsed bytes and full row count to the capture receipt',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'listed-bound-source-')),file=join(directory,'accounts.jsonl');
 const listed={id:'1',status:'3',is_delete:'0',note:'inside\u2028text'},other={id:'2',status:'4',is_delete:'0'};
 const bytes=Buffer.from([listed,other].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const entry={rows:2,sha256:sha(bytes)},expected=new Map([['1',sha(canonical(listed))]]);
 try{
  writeFileSync(file,bytes);
  const scan=await readBoundListedAccounts(file,entry,expected,canonical);
  assert.equal(scan.captured,2);assert.deepEqual([...scan.accounts.keys()],['1']);
  const all=await readBoundListedAccounts(file,entry,null,canonical);
  assert.equal(all.captured,2);assert.deepEqual([...all.accounts.keys()],['1']);
  await assert.rejects(readBoundListedAccounts(file,{...entry,sha256:'0'.repeat(64)},expected,canonical),/LISTED_SOURCE_FILE_CHANGED/);
  await assert.rejects(readBoundListedAccounts(file,{...entry,sha256:'0'.repeat(64)},null,canonical),/LISTED_SOURCE_FILE_CHANGED/);
  await assert.rejects(readBoundListedAccounts(file,{...entry,rows:1},expected,canonical),/LISTED_SOURCE_FILE_CHANGED/);
  writeFileSync(file,Buffer.concat([bytes,Buffer.from('\n')]));
  await assert.rejects(readBoundListedAccounts(file,entry,expected,canonical),/LISTED_SOURCE_FILE_CHANGED/);
 }finally{unlinkSync(file);rmdirSync(directory);}
});
test('complete source scan rejects missing, extra, changed, duplicate and unknown account facts',async()=>{
 const a={id:'a',status:'3',is_delete:'0',owner:'fixture'},b={id:'b',status:'3',is_delete:'0',owner:'fixture'};
 const expected=new Map([[a.id,sha(canonical(a))],[b.id,sha(canonical(b))]]);
 for(const [rows,plan,code] of [
  [[a],expected,'LISTED_SOURCE_ACCOUNT_MISSING'],
  [[a,b],new Map([[a.id,sha(canonical(a))]]),'LISTED_SOURCE_ACCOUNT_OMITTED'],
  [[a,{...b,owner:'changed'}],expected,'LISTED_SOURCE_ACCOUNT_DIGEST_CHANGED'],
  [[a,{...b,status:'4'}],expected,'LISTED_SOURCE_ACCOUNT_NOT_LISTED'],
  [[a,b,a],expected,'LISTED_SOURCE_ACCOUNT_DUPLICATE'],
  [[a,b,{id:'c',status:'unknown',is_delete:'0'}],expected,'LISTED_SOURCE_ACCOUNT_INVALID'],
  [[a,b,{id:'c',status:'3',is_delete:null}],expected,'LISTED_SOURCE_ACCOUNT_INVALID'],
 ])await assert.rejects(collectVerifiedListedAccounts(rows,plan,canonical),new RegExp(code));
});
function fixture(){
 const target={oid:'123',nonce:'a'.repeat(24),migrationRoleOid:'77',bootstrapReservation:'ROUND06_BOOTSTRAP_RESERVED'};
 const round={schema:'zzsh.local-round.v1',target,source:{path:'E:/zzsh-local-state/restricted/source',sha256:'src'},dataset:{sha256:'data'},display:{sha256:'display'},paths:{sha256:'paths'},holdingOverlay:{sha256:'overlay'},actor:{path:'E:/zzsh-local-state/restricted/actor.json',sha256:'actor'},credentials:'E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/regression_test/credentials.json',apiDist:'E:/zzsh/runtime/api/dist/src',buildFiles:{'supply/content-hash.js':'built'}};
 const core={status:'DATASET_AND_GROWTH_ACK_READBACK_PASS',completion:{status:'COMPLETE'},inputSha256:'round',datasetSha256:'data',target};
 const audit={status:'OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN',dbConnections:0,targetWrites:0,sourceReceiptSha256:'src',r06DatasetManifestSha256:'data',sourceBindingSha256:'origin',policyBundleCanonicalSha256:'policy',policyAuthorityCanonicalSha256:'authority',r06AccountsSha256:'accounts',r06DisplayFileSha256:'display-file',r06PathsFileSha256:'paths-file',skinOverlaySha256:'overlay',accounts:[{}]};
 const binding={schema:'zzsh.legacy-listed-round-binding.v1',roundInputSha256:'round',sourceBindingSha256:'origin',policyBundleSha256:'policy',policyAuthoritySha256:'authority',sourceDir:round.source.path,loaderSha256:'loader',helperSha256:'helper',creditGuaranteeEnabled:false,expectedAccountCount:1,window:{notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z'}};
 const observed={oid:'123',nonce:target.nonce,credentials:round.credentials,actorFile:round.actor.path,apiDist:round.apiDist,actorSha256:'actor',resource:{database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',oid:'123',nonce:target.nonce,roles:{migration:{oid:'77'}}},sourceReceiptSha256:'src',datasetManifestSha256:'data',displayManifestSha256:'display',pathsReceiptSha256:'paths',accountFileSha256:'accounts',datasetAccountSha256:'accounts',userFileSha256:'users',datasetUserSha256:'users',displayFileSha256:'display-file',pathsFileSha256:'paths-file',holdingOverlaySha256:'overlay',sourceBindingSha256:'origin',policyBundleSha256:'policy',policyAuthoritySha256:'authority',loaderSha256:'loader',helperSha256:'helper',creditGuaranteeEnabled:false,compiled:{'supply/content-hash':'built'},now:Date.parse('2026-11-05T00:00:00.000Z')};
 return {binding,round,core,audit,observed};
}
const check=x=>validateRoundSourceProof(x.binding,x.round,x.core,x.audit,x.observed,canonical);
test('accepts a complete round/source/build/actor binding',()=>assert.equal(check(fixture()),true));
test('R07 may omit an overlay only when both the round and audit report it absent',()=>{
 const x=fixture(),instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'};
 x.round.target.bootstrapReservation='ROUND07_BOOTSTRAP_RESERVED';x.round.target.instance=instance;x.observed.instance=instance;x.observed.resource.instance=instance;
 delete x.round.holdingOverlay;delete x.observed.holdingOverlaySha256;delete x.audit.skinOverlaySha256;
 assert.equal(check(x),true);x.audit.skinOverlaySha256='an-unmatched-overlay';assert.throws(()=>check(x),/LISTED_ROUND_BINDING_CHANGED/);
});
test('next-round listed source binds the same target profile through registry and caller',()=>{
 const x=fixture(),instance={host:'127.0.0.1',port:55435,systemIdentifier:'12345'},migrationProfile='LOCAL_MIGRATION_NEXT_V1';
 Object.assign(x.round.target,{bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',instance,migrationProfile});
 Object.assign(x.observed,{instance,migrationProfile});Object.assign(x.observed.resource,{instance,migrationProfile});
 assert.equal(check(x),true);
 delete x.observed.resource.migrationProfile;assert.throws(()=>check(x),/LISTED_ROUND_BINDING_CHANGED/);
});
test('rejects altered target, role, actor, source, build, policy or guarantee mode',()=>{
 const mutations=[x=>x.observed.oid='999',x=>x.observed.nonce='b'.repeat(24),x=>x.observed.resource.roles.migration.oid='78',x=>x.observed.actorSha256='other',x=>x.observed.sourceReceiptSha256='other',x=>x.observed.accountFileSha256='other',x=>x.observed.userFileSha256='other',x=>x.observed.displayFileSha256='other',x=>x.observed.pathsFileSha256='other',x=>x.observed.holdingOverlaySha256='other',x=>x.observed.compiled['supply/content-hash']='other',x=>x.observed.policyBundleSha256='other',x=>x.observed.policyAuthoritySha256='other',x=>x.observed.helperSha256='other',x=>x.observed.loaderSha256='other',x=>x.observed.creditGuaranteeEnabled=true];
 for(const mutate of mutations){const x=fixture();mutate(x);assert.throws(()=>check(x),/LISTED_ROUND_(BINDING|BUILD)_CHANGED/)}
});
test('requires successful core receipt and independent offline audit',()=>{
 for(const mutate of [x=>x.core.status='STOPPED',x=>x.core.completion.status='INCOMPLETE',x=>x.core.inputSha256='other',x=>x.audit.dbConnections=1,x=>x.audit.targetWrites=1,x=>x.audit.accounts=[]]){const x=fixture();mutate(x);assert.throws(()=>check(x),/LISTED_ROUND_BINDING_CHANGED/)}
});
test('expired window refuses writes but permits read-only recovery',()=>{
 const x=fixture();x.observed.now=Date.parse('2027-01-02T00:00:00.000Z');assert.throws(()=>check(x),/WINDOW_INACTIVE/);x.observed.allowExpiredReadOnly=true;assert.equal(check(x),true);
});
test('trial must match exact target, plan, order, complete results and rollbacks',()=>{
 const target={oid:'123'},rows=[{sourceId:'a'},{sourceId:'b'}],receipt={inputSha:'plan',target,results:[{sourceId:'a',state:'READY'},{sourceId:'b',state:'ALREADY_PUBLISHED'}],rollbackAcknowledged:2};
 assert.equal(validateRoundTrialReceipt(receipt,'plan',target,rows,canonical),true);
 const nextTarget={...target,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'},nextReceipt={...receipt,target:nextTarget};
 assert.throws(()=>validateRoundTrialReceipt(nextReceipt,'plan',nextTarget,rows,canonical),/TRIAL_RECEIPT_NOT_COMPLETE/);
 assert.equal(validateRoundTrialReceipt({...nextReceipt,targetFence:'HELD_DURING_OPERATION',targetFenceReleased:true},'plan',nextTarget,rows,canonical),true);
 for(const mutate of [x=>x.inputSha='other',x=>x.target.oid='other',x=>x.rollbackAcknowledged=1,x=>x.results[1].state='REJECTED',x=>x.results.reverse(),x=>x.results.pop()]){const x=structuredClone(receipt);mutate(x);assert.throws(()=>validateRoundTrialReceipt(x,'plan',target,rows,canonical),/TRIAL_RECEIPT_NOT_COMPLETE/)}
});

test('plan, audited scope and policy must contain exactly the same unique accounts and digests',()=>{
 const d='a'.repeat(64),plan={listings:[{sourceId:'1',sourceDigest:d}]},audit={accounts:[{sourceId:'1',sourceDigest:d}]},policy={supplement:{accountSourceDigests:[{id:'1',sha256:d}]}};
 assert.equal(validateRoundAccountSet(plan,audit,policy,1),true);
 for(const mutate of [x=>x.plan.listings=[],x=>x.plan.listings[0].sourceDigest='b'.repeat(64),x=>x.audit.accounts[0].sourceId='2',x=>x.policy.supplement.accountSourceDigests[0].id='2']){
  const x=structuredClone({plan,audit,policy});mutate(x);assert.throws(()=>validateRoundAccountSet(x.plan,x.audit,x.policy,1),/ACCOUNT_SET_CHANGED/);
 }
 const execution={rows:[{sourceId:'1',body:{intake:{source:{sourceDigest:d}}}}]};assert.equal(validateRoundAccountSet(execution,audit,policy,1),true);
});
