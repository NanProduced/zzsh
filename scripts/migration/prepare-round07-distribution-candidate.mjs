import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { readSourceRows } from './local-source-adapter.mjs';
import { legacyDistributionPolicy } from './local-distribution-qualification-plan.mjs';
const restricted=resolve('E:/zzsh-local-state/restricted'),sha=x=>createHash('sha256').update(x).digest('hex');
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_DISTRIBUTION_SOURCE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_DISTRIBUTION_SOURCE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_DISTRIBUTION_SOURCE_LINK_REFUSED');return p;}
export function makeR07DistributionCandidate(source,configuration,rawLevels){
 const payload=legacyDistributionPolicy({scope:'NATIVE',...source,configuration,rawLevels});
 return {schema:'zzsh.round07-distribution-candidate.v1',source,configuration,rawLevels,approvalPayloads:[payload]};
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--prepare')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--prepare','--source','--source-sha','--out'],connections:0,targetWrites:0}));return;}
 const source=privatePath(option('--source')),out=privatePath(option('--out'),true),receiptBytes=readFileSync(join(source,'receipt.json')),sourceSha=option('--source-sha');
 assert(!existsSync(out)&&/^[a-f0-9]{64}$/.test(sourceSha??'')&&sha(receiptBytes)===sourceSha,'R07_DISTRIBUTION_SOURCE_CHANGED');
 const receipt=JSON.parse(receiptBytes);assert(receipt.status==='CAPTURED_READ_ONLY'&&receipt.rollbackConfirmed===true&&receipt.clientClosed===true,'R07_DISTRIBUTION_SOURCE_UNCONFIRMED');
 const loaded={};for(const domain of ['distributionConfig','distributionLevels']){
  const entry=receipt.files?.[domain];assert(entry&&entry.file===basename(entry.file)&&/^[a-f0-9]{64}$/.test(entry.sha256??''),'R07_DISTRIBUTION_SOURCE_FILE_INVALID');
  const file=join(source,entry.file),digest=createHash('sha256');for await(const b of createReadStream(file))digest.update(b);assert.equal(digest.digest('hex'),entry.sha256,'R07_DISTRIBUTION_SOURCE_FILE_CHANGED');
  const rows=[];for await(const row of readSourceRows(file))rows.push(row);assert.equal(rows.length,entry.rows,'R07_DISTRIBUTION_SOURCE_COUNT_CHANGED');loaded[domain]=rows;
 }
 const sourceRef={receiptSha256:sourceSha,configurationSha256:receipt.files.distributionConfig.sha256,levelsSha256:receipt.files.distributionLevels.sha256};
 const candidate=makeR07DistributionCandidate(sourceRef,loaded.distributionConfig,loaded.distributionLevels);
 writePrivate(join(out,'candidate.json'),candidate);console.log(JSON.stringify({status:'R07_DISTRIBUTION_CANDIDATE_PREPARED',candidate:join(out,'candidate.json'),sha256:sha(readFileSync(join(out,'candidate.json'))),levels:candidate.approvalPayloads[0].config.levels.length,connections:0,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_DISTRIBUTION_CANDIDATE_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
