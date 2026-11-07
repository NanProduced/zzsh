import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalSession, totp, validateProfile, writePrivate } from '../local-auth.mjs';
import { loadRegisteredTarget } from './local-target-registry.mjs';

const restricted=resolve('E:/zzsh-local-state/restricted'),runtime=resolve('E:/zzsh-local-state/runtime');
const sha=x=>createHash('sha256').update(x).digest('hex');
function inside(base,value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_BOSS_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_BOSS_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_BOSS_LINK_REFUSED');return p;}
function pin(ref,base=restricted){const p=inside(base,ref?.path),bytes=readFileSync(p);assert(/^[a-f0-9]{64}$/.test(ref.sha256??'')&&sha(bytes)===ref.sha256,'R07_BOSS_INPUT_CHANGED');return JSON.parse(bytes);}
export function assertR07BossBinding(binding,registered,actor){
 const a=binding?.resource,b=binding?.actualResource,i=registered?.instance;
 assert(binding?.status==='R07_BOOTSTRAP_API_LISTENING'&&binding.port===4242&&binding.origins?.apiOrigin==='http://127.0.0.1:4242'
  &&binding.origins?.adminOrigin==='http://127.0.0.1:4241'&&binding.NoIM===true&&binding.financialCommandCapabilities===false&&binding.workersEnabled===false
  &&a?.oid===registered.oid&&a.nonce===registered.nonce&&a.database===registered.database&&JSON.stringify(a.instance)===JSON.stringify(i)
  &&b?.oid===registered.oid&&b.nonce===registered.nonce&&JSON.stringify(b.instance)===JSON.stringify(i)&&b.read_only==='on'
  &&actor?.realm==='admin'&&actor.origin===binding.origins.adminOrigin&&actor.username==='zz00001'&&actor.userId&&actor.password&&actor.totp,
 'R07_BOSS_BINDING_CHANGED');
}
function listener(binding){
 const script="$c=@(Get-NetTCPConnection -State Listen -LocalPort 4242 -ErrorAction SilentlyContinue);if($c.Count -ne 1){throw 'listener'};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c[0].OwningProcess);if(!$p){throw 'process'};[pscustomobject]@{pid=[int]$p.ProcessId;address=$c[0].LocalAddress;started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress";
 const current=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));
 assert(current.pid===binding.pid&&current.address==='127.0.0.1'&&Date.parse(current.started)<=Date.parse(binding.at)&&!existsSync(binding.stopFile),'R07_BOSS_LISTENER_CHANGED');
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--login')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--login','--input','--input-sha','--out'],connections:0,targetWrites:0}));return;}
 const input=pin({path:option('--input'),sha256:option('--input-sha')}),out=inside(restricted,option('--out'),true);assert(!existsSync(out)&&input.schema==='zzsh.round07-boss-session-input.v1','R07_BOSS_INPUT_INVALID');
 const profile=validateProfile(pin(input.profile)),binding=pin(input.runtimeBinding,runtime),credentialPath=inside(restricted,input.credentials?.path),credentialBytes=readFileSync(credentialPath);
 assert(sha(credentialBytes)===input.credentials.sha256,'R07_BOSS_CREDENTIAL_CHANGED');const registered=loadRegisteredTarget(credentialPath),actor=profile.actors['boss-one'];assertR07BossBinding(binding,registered,actor);
 const session=new LocalSession(binding.origins.apiOrigin,'admin'),receipt={schema:'zzsh.round07-boss-session-receipt.v1',status:'STARTED',inputSha256:option('--input-sha'),runtimeBindingSha256:input.runtimeBinding.sha256,profileSha256:input.profile.sha256,steps:[],realChannelsCalled:false};
 const save=()=>writePrivate(join(out,'receipt.json'),receipt);
 async function call(name,path,body){listener(binding);const step={name,status:'INTENT'};receipt.steps.push(step);save();const response=await session.request(path,body);assert.equal(response.status,200,'R07_BOSS_HTTP_REJECTED');step.status='ACK';save();return response.body;}
 try{
  const signedIn=await call('sign-in','/api/auth/admin/sign-in/username',{username:actor.username,password:actor.password});
  if(signedIn.twoFactorRedirect)await call('totp','/api/auth/admin/two-factor/verify-totp',{code:totp(actor.totp)});
  const current=await call('get-session','/api/auth/admin/get-session');assert(current?.user?.id===actor.userId&&current.user.suspended!==true&&current.user.twoFactorEnabled===true&&typeof current.session?.id==='string'&&current.session.id.length>0,'R07_BOSS_SESSION_CHANGED');
  writePrivate(join(out,'actor.json'),{id:actor.userId,actorId:actor.userId,sessionId:current.session.id,realm:'admin',resourceOid:registered.oid,nonce:registered.nonce});
  writePrivate(join(out,'storage-state.json'),session.state());receipt.status='BOUND_BOSS_SESSION_VERIFIED';receipt.actorFile=join(out,'actor.json');receipt.storageFile=join(out,'storage-state.json');
 }catch(e){receipt.status='STOPPED_PRESERVE_SESSION_ATTEMPT';receipt.failure=/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name;process.exitCode=1;}
 finally{receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:receipt.status,actorFile:receipt.actorFile??null,storageFile:receipt.storageFile??null,receipt:join(out,'receipt.json'),failure:receipt.failure??null}));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_BOSS_SESSION_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
