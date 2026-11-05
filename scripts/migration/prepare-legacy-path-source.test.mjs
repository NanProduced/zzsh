import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planLegacyPathSourceRow,prepareLegacyPathSource} from './prepare-legacy-path-source.mjs';
import {legacyImageObjectKey} from '../../apps/api/src/supply/legacy-path-media.ts';
const sha=x=>createHash('sha256').update(x).digest('hex'),root=fileURLToPath(new URL('../..',import.meta.url)),node=process.execPath;
function temp(base=tmpdir()){return mkdtempSync(join(base,'zzsh-legacy-path-source-'))}
function clean(dir,base=tmpdir()){
 const target=realpathSync(dir),parent=realpathSync(base);
 assert.equal(dirname(target).toLowerCase(),parent.toLowerCase());assert(basename(target).startsWith('zzsh-legacy-path-source-'));
 rmSync(target,{recursive:true});
}
function source(root,rows){
 const dir=join(root,'source');mkdirSync(dir);const bytes=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';writeFileSync(join(dir,'accounts.jsonl'),bytes);
 const receipt={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{accounts:{file:'accounts.jsonl',sha256:sha(bytes),rows:rows.length,fields:['id','user_id','img_paths','punishment_img_url']}}};
 const encoded=JSON.stringify(receipt)+'\n';writeFileSync(join(dir,'receipt.json'),encoded);return {dir,receiptSha256:sha(encoded)};
}
const valid={id:'101',user_id:'201',img_paths:' accountsImage/20261103/a.png,accountsImage/20261103/b.jpg,accountsImage/20261103/a.png ',punishment_img_url:'accountsImage/20261104/evidence.webp'};
test('source paths preserve order/dedup and use the existing filePath to OSS key contract',()=>{
 const result=planLegacyPathSourceRow(valid,'a'.repeat(64));
 assert.deepEqual(result.references.map(x=>x.sourceToken),['accountsImage/20261103/a.png','accountsImage/20261103/b.jpg','accountsImage/20261104/evidence.webp']);
 assert.equal(result.fields.img_paths.observation,'PRESENT');assert.equal(result.fields.punishment_img_url.observation,'PRESENT');
 assert.equal(legacyImageObjectKey('test/prefix/',result.references[0].sourceToken),'test/prefix/legacy/accountsImage/20261103/a.png');
 assert(!JSON.stringify(result).includes('assetId'));assert(!JSON.stringify(result).includes('READY'));
});
test('null, empty, absent and invalid paths remain distinct; missing objects are not inspected',()=>{
 const x=planLegacyPathSourceRow({id:'1',user_id:'2',img_paths:null,punishment_img_url:''},'b'.repeat(64));assert.equal(x.fields.img_paths.observation,'NULL');assert.equal(x.fields.punishment_img_url.observation,'EMPTY');
 const y=planLegacyPathSourceRow({id:'1',user_id:'2',img_paths:'../bad.png'},'b'.repeat(64));assert.equal(y.fields.img_paths.observation,'INVALID');assert.equal(y.fields.punishment_img_url.observation,'ABSENT');assert.equal(y.references.length,0);
 assert.throws(()=>planLegacyPathSourceRow({id:1,user_id:'2'},'b'.repeat(64)),/SOURCE_IDENTITY_REQUIRED/);
});
test('sealed capture replays identically in a fresh directory and never overwrites',async()=>{
 const dir=temp();try{const capture=source(dir,[valid,{id:'102',user_id:'202',img_paths:'',punishment_img_url:null}]);
  const a=await prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'out1')});
  const b=await prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'out2')});
  assert.equal(a.referencesSha256,b.referencesSha256);assert.equal(a.quarantineSha256,b.quarantineSha256);assert.equal(a.plannedRows,2);assert.equal(a.displayPaths,2);assert.equal(a.penaltyPaths,1);assert.equal(a.storageWrites,0);assert.equal(a.dbConnections,0);
  await assert.rejects(prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'out1')}),/NEW_OUTPUT_REQUIRED/);
  await assert.rejects(prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(capture.dir,'must-not-write')}),/SOURCE_OUTPUT_OVERLAP/);
 }finally{clean(dir)}
});
test('tampered capture/receipt and duplicate identities do not produce a sealed output',async()=>{
 const dir=temp();try{const capture=source(dir,[valid]);
  await assert.rejects(prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:'0'.repeat(64),out:join(dir,'bad-receipt')}),/SOURCE_RECEIPT_SHA_MISMATCH/);
  writeFileSync(join(capture.dir,'accounts.jsonl'),'{}\n');
  await assert.rejects(prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'bad-file')}),/SOURCE_FILE_SHA_MISMATCH/);
  assert(!existsSync(join(dir,'bad-file')));
 }finally{clean(dir)}
 const duplicate=temp();try{const capture=source(duplicate,[valid,valid]);await assert.rejects(prepareLegacyPathSource({privateRoot:duplicate,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(duplicate,'out')}),/SOURCE_ACCOUNT_DUPLICATE/);assert(!existsSync(join(duplicate,'out/receipt.json')))}finally{clean(duplicate)}
});

test('generated source references feed the existing path prepare/verify pipeline', {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')},async()=>{
 const base=realpathSync('E:/zzsh-local-state/restricted'),dir=temp(base);
 try{
  const rows=[valid,{id:'102',user_id:'202',img_paths:'',punishment_img_url:null}],capture=source(dir,rows);
  const refs=await prepareLegacyPathSource({privateRoot:base,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'refs')});
  const req=createRequire(import.meta.url),api=join(root,'apps/api/dist/src'),writer=req(join(api,'legacy-load/legacy-path-records.js'));
  const accounts=rows.map(r=>{const x=writer.prepareLegacyPathRecord(r);return {ready:true,sourceId:r.id,ownerLegacyId:r.user_id,ownerUserId:x.ownerUserId,sourceDigest:x.sourceDigest}});
  const dataset=join(dir,'dataset');mkdirSync(dataset);const accountText=accounts.map(JSON.stringify).join('\n')+'\n';writeFileSync(join(dataset,'accounts.jsonl'),accountText);
  const manifest={status:'FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN',sourceReceiptSha256:capture.receiptSha256,files:{accounts:{rows:accounts.length,sha256:sha(accountText)}}};const mb=JSON.stringify(manifest)+'\n';writeFileSync(join(dataset,'manifest.json'),mb);
  const prep=spawnSync(node,[join(root,'scripts/migration/prepare-legacy-path-accounts.mjs'),'--prepare','--dataset-dir',dataset,'--dataset-sha',sha(mb),'--source-plan-dir',join(dir,'refs'),'--source-plan-receipt-sha',refs.receiptSha256,'--out',join(dir,'paths')],{cwd:root,encoding:'utf8'});
  assert.equal(prep.status,0,prep.stderr);const pathReceipt=readFileSync(join(dir,'paths/receipt.json'));
  const verify=spawnSync(node,[join(root,'scripts/migration/load-legacy-path-accounts.mjs'),'--verify','--plan-dir',join(dir,'paths'),'--plan-receipt-sha',sha(pathReceipt),'--source-plan-dir',join(dir,'refs'),'--source-dir',capture.dir,'--source-receipt-sha',capture.receiptSha256,'--api-dist',api],{cwd:root,encoding:'utf8'});
  assert.equal(verify.status,0,verify.stderr);const result=JSON.parse(verify.stdout.trim());assert.equal(result.status,'SOURCE_PLAN_VERIFIED_TARGET_NOT_RUN');assert.equal(result.accounts,2);assert.equal(result.displayPaths,2);assert.equal(result.penaltyPaths,1);assert.equal(result.dbConnections,0);assert.equal(result.targetWrites,0);
  writeFileSync(join(dir,'refs/references.jsonl'),readFileSync(join(dir,'refs/references.jsonl'),'utf8')+'\n');
  const tampered=spawnSync(node,[join(root,'scripts/migration/prepare-legacy-path-accounts.mjs'),'--prepare','--dataset-dir',dataset,'--dataset-sha',sha(mb),'--source-plan-dir',join(dir,'refs'),'--source-plan-receipt-sha',refs.receiptSha256,'--out',join(dir,'paths-tampered')],{cwd:root,encoding:'utf8'});
  assert.notEqual(tampered.status,0);assert.match(tampered.stderr,/SOURCE_FILE_SHA_MISMATCH/);assert(!existsSync(join(dir,'paths-tampered/receipt.json')));

 }finally{clean(dir,base)}
});

test('an invalid source path remains explicit and the downstream plan fails closed', {skip:process.platform!=='win32'||!existsSync('E:/zzsh-local-state/restricted')},async()=>{
 const base=realpathSync('E:/zzsh-local-state/restricted'),dir=temp(base);
 try{
  const row={id:'101',user_id:'201',img_paths:'../bad.png',punishment_img_url:null},capture=source(dir,[row]);
  const refs=await prepareLegacyPathSource({privateRoot:base,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out:join(dir,'refs')});assert.equal(refs.invalidFields,1);
  const dataset=join(dir,'dataset');mkdirSync(dataset);const accountText=JSON.stringify({ready:true,sourceId:row.id,ownerLegacyId:row.user_id,ownerUserId:'synthetic-owner',sourceDigest:'a'.repeat(64)})+'\n';writeFileSync(join(dataset,'accounts.jsonl'),accountText);
  const manifest={status:'FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN',sourceReceiptSha256:capture.receiptSha256,files:{accounts:{rows:1,sha256:sha(accountText)}}};const mb=JSON.stringify(manifest)+'\n';writeFileSync(join(dataset,'manifest.json'),mb);
  const result=spawnSync(node,[join(root,'scripts/migration/prepare-legacy-path-accounts.mjs'),'--prepare','--dataset-dir',dataset,'--dataset-sha',sha(mb),'--source-plan-dir',join(dir,'refs'),'--source-plan-receipt-sha',refs.receiptSha256,'--out',join(dir,'paths')],{cwd:root,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/SOURCE_ACCOUNT_MISMATCH/);assert(!existsSync(join(dir,'paths/receipt.json')));
 }finally{clean(dir,base)}
});

test('POSIX output is owned by the process and inaccessible to group and others', {skip:process.platform==='win32'},async()=>{
 const dir=temp();try{const capture=source(dir,[valid]),out=join(dir,'out');await prepareLegacyPathSource({privateRoot:dir,sourceDir:capture.dir,receiptSha256:capture.receiptSha256,out});
  const info=statSync(out);assert.equal(info.mode&0o777,0o700);if(typeof process.getuid==='function')assert.equal(info.uid,process.getuid());
  for(const file of ['references.jsonl','quarantine.jsonl','receipt.json'])assert.equal(statSync(join(out,file)).mode&0o077,0);
 }finally{clean(dir)}
});
test('POSIX symbolic-link input is rejected before creating output', {skip:process.platform==='win32'},async()=>{
 const dir=temp();try{const capture=source(dir,[valid]),alias=join(dir,'source-link');symlinkSync(capture.dir,alias,'dir');
  await assert.rejects(prepareLegacyPathSource({privateRoot:dir,sourceDir:alias,receiptSha256:capture.receiptSha256,out:join(dir,'out')}),/REPARSE_POINT_REFUSED/);assert(!existsSync(join(dir,'out')));
 }finally{clean(dir)}
});
