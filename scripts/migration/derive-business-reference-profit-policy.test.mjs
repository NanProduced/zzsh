import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveProfitPolicy } from './derive-business-reference-profit-policy.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));
const time = '2026-11-05T01:02:03.000Z';
const bootstrap=fileURLToPath(new URL('./bootstrap-local-reference.mjs',import.meta.url));
const bootstrapPlan=JSON.parse(spawnSync(process.execPath,[bootstrap,'--plan'],{encoding:'utf8',timeout:5000}).stdout);
function fixture() {
  const rule={schema:'haff-ratio-v2',compatibility:{ordinary:{spreadDelta:'8',discounts:{STANDARD:'0'}},fast:{spreadDelta:'12',discounts:{STANDARD:'0'}},modes:{ordinary:{enabled:true},custom:{enabled:true},fast:{enabled:true}}}};
  const source={
    game:[JSON.stringify({id:'game-1',code:'delta',current_release_id:'release-2'})],
    rule_release:[JSON.stringify({id:'release-1',game_id:'game-1',price_version_id:'price-old',generation:1,created_at:time,activated_at:time}),JSON.stringify({id:'release-2',game_id:'game-1',price_version_id:'price-current',generation:2,created_at:time,activated_at:time})],
    price_version:[JSON.stringify({id:'price-current',game_id:'game-1',mode:'SPREAD',status:'SEALED',revision:3,haff_rule:rule,funding_policy:{policyVersion:'same'},created_at:time,updated_at:time,sealed_at:time})],
    price_line:[JSON.stringify({id:'line-1',price_version_id:'price-current',item_id:'haff',pricing_kind:'HAFF_RATIO',created_at:time}),'{"id":"line-2","price_version_id":"price-current","item_id":"item-1","pricing_kind":"FIXED_UNIT","buyer_unit_amount":123456789012345.67890123,"created_at":"'+time+'"}'],
  };
  const tableBytes=new Map(), descriptors=[];
  for(const key of bootstrapPlan.businessPackage.tables) {
    const [schema,table]=key.split('.'), rows=source[table]??[];
    const file=`${key}.json`, raw=bytes({schema,table,primaryKey:['id'],columns:[],rows});
    tableBytes.set(file,raw);descriptors.push({schema,table,file,rows:rows.length,sourceRows:String(rows.length),sha256:sha(raw)});
  }
  const manifest=bytes({kind:'BUSINESS_REFERENCE_PACKAGE_V1',gameCode:'delta',sourceRawUnchanged:false,transactionRollback:true,clientClosed:true,
    source:{database:'zzsh_dev_daily',oid:'2400547',read_only:'on'},foreignKeys:[],tables:descriptors});
  const evidence=bytes({schema:'zzsh.r06-pricing-source-comparison.v1',status:'READ_ONLY_COMPARISON_COMPLETE',source:'MYSQL_DUMP_AND_RESTORE_CAPTURE',sourceRuntimeCache:'UNKNOWN',sourceQuoteScope:'ORDINARY_USER',spreads:{ordinary:{source:'6',current:'8'},fast:{source:'12',current:'12'}},targetWrites:0,rollbackAcknowledged:true,clientClosed:true});
  const decision={kind:'ZZSH_BUSINESS_PROFIT_POLICY_DECISION_V1',authorization:'OWNER_DIRECTED_FRESH_INITIALIZATION',gameCode:'delta',expectedOldOrdinary:'8',ordinarySpread:'6',fastSpread:'12',derivedAt:'2026-11-05T02:03:04.000Z',policyEvidenceSha256:sha(evidence),sourceManifestSha256:sha(manifest)};
  return {manifest,tableBytes,decision,evidence,decisionSha:sha(bytes(decision)),source};
}
const run=x=>deriveProfitPolicy(x.manifest,x.tableBytes,x.decision,x.decisionSha,x.evidence);
const rows=(x,name)=>JSON.parse(x.tables.get(`zzsh_supply.${name}.json`)).rows;

test('new release is appended; sealed versions, exact prices, terms and funding stay intact',()=>{
  const x=fixture(), result=run(x), manifest=JSON.parse(result.manifest);
  for(const name of ['price_version','price_line','rule_release']) assert.deepEqual(rows(result,name).slice(0,x.source[name].length),x.source[name]);
  const old=JSON.parse(x.source.price_version[0]), created=JSON.parse(rows(result,'price_version').at(-1));
  assert.equal(created.haff_rule.compatibility.ordinary.spreadDelta,'6');
  assert.equal(created.haff_rule.compatibility.fast.spreadDelta,'12');
  assert.deepEqual(created.funding_policy,old.funding_policy);
  assert.equal(JSON.parse(rows(result,'rule_release').at(-1)).generation,3);
  assert.equal(JSON.parse(rows(result,'game')[0]).current_release_id,result.releaseId);
  assert.match(rows(result,'price_line').at(-1),/123456789012345\.67890123/);
  assert.equal(result.addedLines,2);assert.equal(manifest.sourceRawUnchanged,false);
  assert.equal(manifest.derivationLineage[0].sourceRuntimeCache,'UNKNOWN');
  assert.deepEqual(run(x).manifest,result.manifest);
});

test('source manifest, table, policy evidence and owner decision are independently bound',()=>{
  for(const change of [
    x=>x.manifest=Buffer.concat([x.manifest,Buffer.from(' ')]),
    x=>x.tableBytes.set('zzsh_supply.price_line.json',Buffer.from('{}')),
    x=>x.evidence=Buffer.concat([x.evidence,Buffer.from(' ')]),
    x=>x.decision.authorization='UNKNOWN',
    x=>x.decision.ordinarySpread='7',
    x=>x.decision.fastSpread='13',
  ]) {const x=fixture();change(x);assert.throws(()=>run(x));}
});

test('incorrect old policy, foreign game and duplicate current release stop before generation',()=>{
  for(const modify of [
    t=>{const row=JSON.parse(t.price_version[0]);row.haff_rule.compatibility.ordinary.spreadDelta='7';t.price_version[0]=JSON.stringify(row)},
    t=>{const row=JSON.parse(t.price_version[0]);row.haff_rule.compatibility.fast.spreadDelta='11';t.price_version[0]=JSON.stringify(row)},
    t=>{const row=JSON.parse(t.price_version[0]);row.game_id='other';t.price_version[0]=JSON.stringify(row)},
    t=>{t.rule_release.push(t.rule_release[1])},
  ]){
    const x=fixture();modify(x.source);const manifest=JSON.parse(x.manifest);
    for(const d of manifest.tables){const table=JSON.parse(x.tableBytes.get(d.file));table.rows=x.source[d.table]??[];const raw=bytes(table);x.tableBytes.set(d.file,raw);d.rows=table.rows.length;d.sha256=sha(raw)}
    x.manifest=bytes(manifest);x.decision.sourceManifestSha256=sha(x.manifest);assert.throws(()=>run(x));
  }
});

test('wrong evidence meaning or unconfirmed capture is rejected even with a matching digest',()=>{
  for(const change of [e=>e.sourceRuntimeCache='PROVEN',e=>e.spreads.ordinary.source='8',e=>e.rollbackAcknowledged=false,e=>e.targetWrites=1]){
    const x=fixture(), e=JSON.parse(x.evidence);change(e);x.evidence=bytes(e);x.decision.policyEvidenceSha256=sha(x.evidence);assert.throws(()=>run(x),/POLICY_EVIDENCE_MISMATCH/);
  }
});

test('CLI keeps a verifiable upstream chain and refuses replay into an existing output',t=>{
  const root=mkdtempSync(join(tmpdir(),'zzsh-profit-policy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const x=fixture(),source=join(root,'source'),out=join(root,'out'),out2=join(root,'out2');mkdirSync(source);
  for(const [name,content] of x.tableBytes)writeFileSync(join(source,name),content);
  writeFileSync(join(source,'manifest.json'),x.manifest);writeFileSync(join(source,'media-objects.json'),'{}');
  const parent=bytes({derivedManifestSha256:sha(x.manifest)});writeFileSync(join(source,'derivation-receipt.json'),parent);
  x.decision.parentReceiptSha256=sha(parent);
  const decision=bytes(x.decision),decisionFile=join(root,'decision.json'),evidenceFile=join(root,'evidence.json');
  writeFileSync(decisionFile,decision);writeFileSync(evidenceFile,x.evidence);
  const script=fileURLToPath(new URL('./derive-business-reference-profit-policy.mjs',import.meta.url));
  const runCli=output=>spawnSync(process.execPath,[script,'--private-root',root,'--source',source,'--decision',decisionFile,'--decision-sha',sha(decision),'--evidence',evidenceFile,'--out',output],{encoding:'utf8',timeout:15000});
  const first=runCli(out);assert.equal(first.status,0,first.stderr);
  const receipt=JSON.parse(readFileSync(join(out,'derivation-receipt.json')));
  assert.equal(receipt.sourceRawUnchanged,false);assert.equal(receipt.previousPriceAndReleaseRowsPreserved,true);
  assert.equal(receipt.gameCurrentReleasePointerChanged,true);assert.equal(receipt.sourceFileWrites,0);
  assert.equal(receipt.derivedManifestSha256,sha(readFileSync(join(out,'manifest.json'))));
  assert.deepEqual(readFileSync(join(out,`lineage-${sha(parent)}.json`)),parent);
  assert.deepEqual(readFileSync(join(out,`profit-decision-${sha(decision)}.json`)),decision);
  assert.deepEqual(readFileSync(join(out,`policy-evidence-${sha(x.evidence)}.json`)),x.evidence);
  const verified=spawnSync(process.execPath,[bootstrap,'--verify','--manifest',join(out,'manifest.json'),'--manifest-sha',receipt.derivedManifestSha256],{encoding:'utf8',timeout:5000});
  assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).status,'REFERENCE_FILES_VERIFIED');
  assert.equal(runCli(out).status,1);
  const second=runCli(out2);assert.equal(second.status,0,second.stderr);
  assert.deepEqual(readFileSync(join(out,'manifest.json')),readFileSync(join(out2,'manifest.json')));
  assert.deepEqual(readFileSync(join(source,'manifest.json')),x.manifest);
});
