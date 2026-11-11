import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';
import { ROUND_MODULES, ROUND_SCRIPTS, distributionDependencyRequirements, listedDependencyRequirements, optionalRoundSourceScripts } from './local-round-dependencies.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>/^[a-f0-9]{64}$/.test(x??'');
function inside(base,value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_DEPENDENCY_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_DEPENDENCY_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_DEPENDENCY_LINK_REFUSED');return p;}
function checked(path,expected,base){const file=inside(base,path),bytes=readFileSync(file);assert(hex(expected)&&sha(bytes)===expected,'R07_DEPENDENCY_INPUT_CHANGED');return JSON.parse(bytes);}
function tree(directory,prefix=''){const result={};for(const e of readdirSync(directory,{withFileTypes:true})){
 assert(!e.isSymbolicLink(),'R07_DEPENDENCY_PACKAGE_LINK_REFUSED');const p=join(directory,e.name),name=prefix+e.name;
 if(e.isDirectory())Object.assign(result,tree(p,name+'/'));else if(e.isFile())result[name]=sha(readFileSync(p));
}return result;}
const sorted=x=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)));
export function topLevelPackage(file,base){
 const r=relative(base,file);if(!r||r.startsWith('..')||isAbsolute(r))return null;const parts=r.split(/[\\/]/);
 if(!parts[0]||parts[0].startsWith('.'))return null;return parts[0].startsWith('@')?parts.length>=2?join(parts[0],parts[1]):null:parts[0];
}
export function assertBundleLineage(bundle,manifest,buildSha,sourceSha){
 assert(bundle?.finalBuildManifestSha256===buildSha&&bundle.finalSourceManifestSha256===sourceSha&&manifest?.sourceSnapshotManifestSha256===sourceSha
  &&['zzsh.round06-preview-build.v1','zzsh.round07-preview-build.v1'].includes(manifest.schema)&&Array.isArray(bundle.entries),'R07_DEPENDENCY_LINEAGE_CHANGED');
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--stage')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--stage','--api-dist','--build-manifest','--build-sha','--source-manifest','--source-sha','--source-snapshot','--bundle','--bundle-sha','--out'],connections:0,targetWrites:0,automaticCleanup:false}));return;}
 const api=isolatedDistributionBuild(root,option('--api-dist')),buildRoot=resolve(api,'../../..'),sourceRoot=join(buildRoot,'source'),snapshot=inside(resolve(root,'tmp'),option('--source-snapshot')),
  buildFile=inside(resolve(root,'tmp'),option('--build-manifest')),sourceFile=inside(resolve(root,'tmp'),option('--source-manifest')),bundleFile=inside(restricted,option('--bundle')),out=inside(restricted,option('--out'),true);
 assert(!existsSync(out)&&dirname(buildFile).toLowerCase()===buildRoot.toLowerCase()&&!existsSync(join(buildRoot,'node_modules')),'R07_DEPENDENCY_OUTPUT_EXISTS');
 const manifest=checked(buildFile,option('--build-sha'),resolve(root,'tmp')),sourceManifest=checked(sourceFile,option('--source-sha'),resolve(root,'tmp')),bundle=checked(bundleFile,option('--bundle-sha'),restricted);
 assert(sourceManifest?.schema==='zzsh.round07-source-snapshot.v1'&&resolve(sourceManifest.sourceSnapshot).toLowerCase()===resolve(snapshot).toLowerCase(),'R07_DEPENDENCY_SOURCE_CHANGED');
 assertBundleLineage(bundle,manifest,option('--build-sha'),option('--source-sha'));
 const listedDependencies=listedDependencyRequirements(sourceManifest),distributionDependencies=distributionDependencyRequirements(sourceManifest),optionalScripts=optionalRoundSourceScripts(sourceManifest);
 for(const name of new Set([...ROUND_SCRIPTS,...optionalScripts,...listedDependencies.scripts,...distributionDependencies.scripts])){const source=join(sourceRoot,'scripts/migration',name),original=join(snapshot,'scripts/migration',name);
  assert(lstatSync(source).isFile()&&!lstatSync(source).isSymbolicLink()&&lstatSync(original).isFile()&&!lstatSync(original).isSymbolicLink()&&sha(readFileSync(source))===sha(readFileSync(original)),'R07_DEPENDENCY_SCRIPT_CHANGED:'+name);
  if([...optionalScripts,...listedDependencies.scripts,...distributionDependencies.scripts].includes(name))assert(sourceManifest.files.find(row=>row.path==='scripts/migration/'+name).sha256===sha(readFileSync(source)),'R07_DEPENDENCY_SCRIPT_CHANGED:'+name);}
 const prefix=manifest.layout.apiDistDir.replaceAll('\\','/')+'/',listed=Object.fromEntries(manifest.components.api.filter(x=>x.path?.startsWith(prefix)&&x.path.endsWith('.js')).map(x=>[x.path.slice(prefix.length),x.sha256]));
 const actual=tree(api);const actualJs=Object.fromEntries(Object.entries(actual).filter(([name])=>name.endsWith('.js')));
 assert(sorted(listed)===sorted(actualJs),'R07_DEPENDENCY_API_CHANGED');
 for(const name of ['package-lock.json','node_modules/.package-lock.json']){const e=manifest.components.api.find(x=>x.path===name);assert(e&&sha(readFileSync(join(sourceRoot,name)))===e.sha256&&sha(readFileSync(join(root,name)))===e.sha256,'R07_DEPENDENCY_LOCK_CHANGED');}
 const bases=[join(root,'apps/api/node_modules'),join(root,'node_modules')],targets=[join(sourceRoot,'apps/api/node_modules'),join(sourceRoot,'node_modules')];
 process.env.NODE_PATH=bases.join(';');Module._initPaths();const require=createRequire(join(root,'apps/api/package.json'));
 for(const name of ['pg','@nestjs/common','@nestjs/core','drizzle-orm','reflect-metadata'])require(name);for(const name of new Set([...ROUND_MODULES,...listedDependencies.modules,...distributionDependencies.modules]))require(join(api,name+'.js'));
 const packages=new Map();for(const file of Object.keys(require.cache)){
  if(!file.toLowerCase().includes('node_modules'))continue;const index=bases.findIndex(base=>topLevelPackage(file,base)!==null);assert(index>=0,'R07_DEPENDENCY_OUTSIDE_WORKTREE');
  const name=topLevelPackage(file,bases[index]),key=index+':'+name;packages.set(key,{name,index,source:join(bases[index],name),target:join(targets[index],name)});
 }
 assert(packages.size>0,'R07_DEPENDENCY_PACKAGES_EMPTY');mkdirSync(targets[0],{recursive:true});mkdirSync(targets[1],{recursive:true});
 let receipt={schema:'zzsh.round07-staged-dependencies.v1',status:'STARTED',buildSha256:option('--build-sha'),sourceSha256:option('--source-sha'),bundleSha256:option('--bundle-sha'),packages:[],pending:null,connections:0,targetWrites:0};
 const save=()=>writePrivate(join(out,'receipt.json'),receipt);save();
 try{
  for(const p of packages.values()){
   assert(!existsSync(p.target),'R07_DEPENDENCY_PACKAGE_EXISTS');const actualSource=realpathSync(p.source),r=relative(root,actualSource);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_DEPENDENCY_PACKAGE_OUTSIDE_WORKTREE');
   const before=tree(actualSource);receipt.pending={path:relative(root,p.source),sourceDigest:sha(sorted(before))};save();
   mkdirSync(dirname(p.target),{recursive:true});cpSync(actualSource,p.target,{recursive:true,errorOnExist:true,force:false});
   assert(sorted(before)===sorted(tree(p.target))&&sorted(before)===sorted(tree(actualSource)),'R07_DEPENDENCY_PACKAGE_CHANGED');
   receipt.packages.push({...receipt.pending,files:Object.keys(before).length});receipt.pending=null;save();
  }
  const link=join(buildRoot,'node_modules');receipt.pending={path:link,kind:'INTERNAL_JUNCTION'};save();symlinkSync(targets[1],link,'junction');
  assert(lstatSync(link).isSymbolicLink()&&realpathSync(link).toLowerCase()===realpathSync(targets[1]).toLowerCase(),'R07_DEPENDENCY_JUNCTION_INVALID');
  receipt.pending=null;receipt.junction={path:link,target:targets[1],kind:'INTERNAL_JUNCTION'};receipt.status='PACKAGES_COPIED_CLOSURE_PROBE_REQUIRED';save();
 }catch(e){receipt.status='STOPPED_PRESERVE_PARTIAL_COPY';receipt.error=/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name;save();process.exitCode=1;}
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),sha256:sha(readFileSync(join(out,'receipt.json'))),packages:receipt.packages.length,pending:receipt.pending??null,automaticCleanup:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_DEPENDENCY_STAGE_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
