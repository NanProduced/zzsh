import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {applyDisplayDomain} from './local-target-display.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
test('fresh display import refuses an omitted captured fact before invoking its writer',
 {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')},async t=>{
 const directory=mkdtempSync('E:/zzsh-local-state/restricted/display-capture-synthetic-'),files=['display.jsonl','manifest.json','source.jsonl','accounts.jsonl','receipt.json'].map(name=>join(directory,name));
 t.after(()=>{for(const file of files)if(existsSync(file)){assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());unlinkSync(file)}rmdirSync(directory)});
 const raws=[{id:'1',status:'3',is_delete:'0',base_bot:null,is_full_payout:'0'},{id:'2',status:'3',is_delete:'0',base_bot:'42',is_full_payout:'1'}];
 const digests=raws.map(raw=>sha(JSON.stringify(raw))),datasetSha='b'.repeat(64),extractSha='c'.repeat(64),at='2026-01-01T00:00:00.000Z';
 const sourceBytes=Buffer.from(raws.map(JSON.stringify).join('\n')+'\n');writeFileSync(files[2],sourceBytes);
 const source={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{accounts:{file:'source.jsonl',sha256:sha(sourceBytes),rows:2,fields:['base_bot','is_full_payout']}}};
 const sourceReceipt=Buffer.from(JSON.stringify(source));writeFileSync(files[4],sourceReceipt);
 const accounts=raws.map((raw,i)=>({sourceId:raw.id,sourceDigest:digests[i],sourceStatus:'3',sourceDeleted:false,snapshot:{schema:'fixture'},sourceUpdatedAt:at}));
 const accountBytes=Buffer.from(accounts.map(JSON.stringify).join('\n')+'\n');writeFileSync(files[3],accountBytes);
 const rows=[{sourceId:'1',baseSourceDigest:digests[0],sourceUpdatedAt:at,snapshot:{sourceAccountBaseRatioWanPerYuan:null,sourceAccountFullPayoutSelected:false,issues:['base_bot:MISSING']}},
  {sourceId:'2',baseSourceDigest:digests[1],sourceUpdatedAt:at,snapshot:{sourceAccountBaseRatioWanPerYuan:'42',issues:[]}}];
 const scope='ACCOUNT_AT_CAPTURE_NOT_ORDER_SNAPSHOT',manifest={status:'DISPLAY_SUPPLEMENT_PREPARED_TARGET_NOT_RUN',datasetSha256:datasetSha,commonFieldDifferences:0,file:'display.jsonl',extractSha256:extractSha,rows:2,notDisplayable:0,
  accountBaseRatio:{scope,known:1,unknown:1},accountFullPayout:{scope,selected:1,unselected:1,unknown:0}};
 const write=()=>{const bytes=Buffer.from(rows.map(JSON.stringify).join('\n')+'\n');writeFileSync(files[0],bytes);manifest.sha256=sha(bytes);const m=Buffer.from(JSON.stringify(manifest));writeFileSync(files[1],m);return sha(m)};
 let writes=0;
 const context=()=>({manifest:{identityProfiles:{schema:'zzsh.legacy-identity-profile-source.v1'},source:directory,sourceReceiptSha256:sha(sourceReceipt),
  files:{accounts:{file:'accounts.jsonl',sha256:sha(accountBytes),rows:2}}},state:{binding:{datasetSha256:datasetSha},phases:{accountDisplay:{created:2,replayed:0,quarantined:0}}},
  actor:{id:'fixture'},save(){},domainFile:()=>files[3],mod(name){if(name==='supply/content-hash')return {canonicalize:JSON.stringify};return name==='legacy-load/legacy-account-seam'?{legacyAccountId:(_s,_e,id)=>'account-'+id}:{recordLegacyDisplaySnapshot:async()=>{writes++}}},
  client:{query:async sql=>sql.startsWith('SELECT account_id')?{rows:raws.map((raw,i)=>({account_id:'account-'+raw.id,observation_version_id:'observation',source_digest:digests[i],source_updated_at:at}))}:{rows:[{n:2}]}},
  readRows:async function*(){for(const row of rows)yield structuredClone(row)},runItems:async(_name,items,write,_size,prepare)=>{const data=[];for await(const item of items)data.push(item);await prepare(data);for(const item of data)await write(item)}});
 await assert.rejects(applyDisplayDomain(context(),directory,write()),/DISPLAY_CAPTURE_FACTS_REQUIRED/);assert.equal(writes,0);
 rows[1].snapshot.sourceAccountFullPayoutSelected=true;const ctx=context();await applyDisplayDomain(ctx,directory,write());
 assert.equal(writes,2);assert.equal(ctx.state.displayReconciliation.targetRows,2);
 let systemWrites=0;const next=context();next.isNextMigration=true;next.systemDisplay=async entries=>{systemWrites+=entries.length;assert.deepEqual(entries.map(entry=>entry.legacyId),['1','2']);return entries.map(()=>({replayed:false}));};
 next.runBatches=async(_name,items,run)=>{const batch=[];for await(const item of items)batch.push(item);return run(batch);};
 await applyDisplayDomain(next,directory,write());assert.equal(systemWrites,2);assert.equal(writes,2);assert.equal(next.state.additiveInputs.display.receiptMode,'SYSTEM_ACCOUNT_V1');
 const changed=context();changed.isNextMigration=true;changed.systemDisplay=next.systemDisplay;changed.runBatches=async(_name,items)=>{
  writeFileSync(files[0],JSON.stringify({...rows[0],baseSourceDigest:'f'.repeat(64)})+'\n'+JSON.stringify(rows[1])+'\n');
  for await(const _ of items)systemWrites++;
 };
 await assert.rejects(applyDisplayDomain(changed,directory,write()),/SOURCE_(?:BATCH|STREAM)_CHANGED/);assert.equal(systemWrites,2);
});
