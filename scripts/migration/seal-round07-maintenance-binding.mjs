import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';

const restricted=resolve('E:/zzsh-local-state/restricted'),runtime=resolve('E:/zzsh-local-state/runtime');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>/^[a-f0-9]{64}$/.test(x??'');
function pathIn(base,value,output=false,stat=lstatSync){
 assert(typeof value==='string'&&isAbsolute(value),'R07_BINDING_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_BINDING_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!stat(x).isSymbolicLink(),'R07_BINDING_LINK_REFUSED');return p;
}
export function maintenanceBindingOutput(value,{runtimeRoot=runtime,stat=lstatSync}={}){return pathIn(runtimeRoot,value,true,stat);}
function read(ref,base){const bytes=readFileSync(pathIn(base,ref?.path));assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'R07_BINDING_INPUT_CHANGED');return JSON.parse(bytes);}
function equalInstance(a,b){return a?.host===b?.host&&a?.port===b?.port&&a?.systemIdentifier===b?.systemIdentifier;}
const normalPath=x=>typeof x==='string'?x.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase():'';

export function makeR07MaintenanceBinding({round,receipt,binding,roundSha,receiptSha,buildSha,runtimeSha}){
 const t=round?.target,i=t?.instance,r=binding?.resource,a=binding?.actualResource;
 assert([roundSha,receiptSha,buildSha,runtimeSha].every(hex)&&round?.schema==='zzsh.local-round.v1'
   &&t?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&i?.host==='127.0.0.1'&&i.port===55433&&/^[0-9]+$/.test(i.systemIdentifier??'')
   &&receipt?.inputSha256===roundSha&&receipt.datasetSha256===round.dataset?.sha256
   &&['DATASET_AND_GROWTH_ACK_READBACK_PASS','DATASET_AND_GROWTH_REVALIDATED_PASS'].includes(receipt.status)&&receipt.completion?.status==='COMPLETE'
   &&String(receipt.target?.oid)===t.oid&&receipt.target?.nonce===t.nonce&&equalInstance(receipt.target?.instance,i)
   &&binding?.status==='R07_BOOTSTRAP_API_LISTENING'&&binding.port===4242&&binding.origins?.apiOrigin==='http://127.0.0.1:4242'
   &&Number.isSafeInteger(binding.pid)&&binding.pid>0&&typeof binding.stopFile==='string'&&Number.isFinite(Date.parse(binding.at))
   &&binding.NoIM===true&&binding.financialCommandCapabilities===false&&binding.workersEnabled===false&&binding.formalAppMounted===true
   &&binding.maintenanceLockReleased===true&&binding.maintenanceClosed===true
   &&[r,a].every(x=>x?.database==='zzsh_test_regression'&&String(x.oid??x.resourceOid)===t.oid&&x.nonce===t.nonce&&x.marker==='zzsh:regression-test:v1'&&equalInstance(x.instance,i))
   &&a.read_only==='on'&&String(a.migration_role_oid)===String(t.migrationRoleOid)
   &&round.bootstrapEvidence?.runtime?.sha256===runtimeSha&&round.bootstrapEvidence?.bundle?.sha256===binding.copyManifestSha256
   &&round.dependencyBinding?.buildManifest?.sha256===buildSha&&normalPath(round.apiDist)&&normalPath(round.apiDist)===normalPath(binding.compiledRoot),
 'R07_MAINTENANCE_EVIDENCE_CHANGED');
 return {...binding,status:'R07_MAINTENANCE_API_LISTENING',bundleSha256:binding.copyManifestSha256,roundInputSha256:roundSha,
  roundReceiptSha256:receiptSha,finalBuildManifestSha256:buildSha,bootstrapRuntimeSha256:runtimeSha};
}

async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--seal')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--seal','--request','--request-sha','--out'],connections:0,targetWrites:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 // The consumer verifies the live listener from the runtime directory; the signed request and
 // underlying bootstrap evidence remain in the restricted directory.
 const request=read({path:option('--request'),sha256:option('--request-sha')},restricted),out=maintenanceBindingOutput(option('--out'));
 assert(request.schema==='zzsh.round07-maintenance-binding-request.v1'&&!existsSync(out),'R07_BINDING_REQUEST_INVALID');
 const round=read(request.round,restricted),receipt=read(request.receipt,restricted),binding=read(request.runtime,runtime);read(request.build,restricted);
 const sealed=makeR07MaintenanceBinding({round,receipt,binding,roundSha:request.round.sha256,receiptSha:request.receipt.sha256,buildSha:request.build.sha256,runtimeSha:request.runtime.sha256});
 assert(!existsSync(pathIn(runtime,binding.stopFile,true)),'R07_MAINTENANCE_STOP_REQUESTED');
 const script="$c=@(Get-NetTCPConnection -State Listen -LocalPort 4242 -ErrorAction SilentlyContinue);if($c.Count -ne 1){throw 'listener'};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c[0].OwningProcess);if(!$p){throw 'process'};[pscustomobject]@{pid=[int]$p.ProcessId;address=$c[0].LocalAddress;started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress";
 const live=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
 assert(live.pid===binding.pid&&live.address==='127.0.0.1'&&Date.parse(live.started)<=Date.parse(binding.at),'R07_MAINTENANCE_LISTENER_CHANGED');
 for(const [ref,base] of [[request.round,restricted],[request.receipt,restricted],[request.runtime,runtime],[request.build,restricted]])read(ref,base);
 writePrivate(join(out,'binding.json'),sealed);console.log(JSON.stringify({status:sealed.status,binding:join(out,'binding.json'),sha256:sha(readFileSync(join(out,'binding.json'))),connections:0,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_MAINTENANCE_BINDING_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
