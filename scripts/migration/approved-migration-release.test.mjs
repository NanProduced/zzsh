import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertApprovedMigrationRelease, assertCommittedApiBuild, committedApiBuild } from './install-round07-schema.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const parent=join(dirname(fileURLToPath(import.meta.url)),'../../tmp');
const tools=['install-round07-schema.mjs','business-initial-seeds.mjs','business-initial-tail-seeds.mjs',
  'local-target-registry.mjs','local-distribution-qualification-plan.mjs','local-load-checkpoint.mjs'];
function put(root,name,value){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,value);}
function git(root,args){const p=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(p.status,0,p.stderr);return p.stdout.trim();}
function hashes(dir,prefix=''){const out={};for(const e of readdirSync(dir,{withFileTypes:true})){
 const name=prefix+e.name,path=join(dir,e.name);assert(!e.isSymbolicLink());if(e.isDirectory())Object.assign(out,hashes(path,name+'/'));else if(e.isFile())out[name]=sha(readFileSync(path));
}return out;}
function clearFixture(root){const actual=realpathSync(root),base=realpathSync(parent);
 assert.equal(dirname(actual),base);assert.match(basename(actual),/^approved-release-test-/);
 const noLinks=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){assert(!e.isSymbolicLink());if(e.isDirectory())noLinks(join(dir,e.name));}};noLinks(actual);
 assert(!relative(base,actual).startsWith('..'));rmSync(actual,{recursive:true});
}

test('reviewed commit detects missing, changed, extra migration and mismatched installer',()=>{
 mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'approved-release-test-'));
 try{
  git(root,['init','-q']);git(root,['config','core.autocrlf','false']);
  put(root,'apps/api/migrations/business/0000_fixture.sql','SELECT 1;\n');
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 2;\n');
  const journal='{"entries":[{"tag":"0155_legacy_rental_distribution_policy","when":1793730640476}]}\n';
  put(root,'apps/api/migrations/business/meta/_journal.json',journal);
  const canonical0155=readFileSync(new URL('../../apps/api/migrations/business/0155_legacy_rental_distribution_policy.sql',import.meta.url)).toString('utf8').replace(/\r\n/g,'\n');
  put(root,'apps/api/migrations/business/0155_legacy_rental_distribution_policy.sql',canonical0155);
  for(const name of tools)put(root,'scripts/migration/'+name,'// fixture\n');
  put(root,'scripts/local-auth.mjs','// fixture\n');
  put(root,'apps/api/src/database/business-migration-compat.ts','// fixture\n');
  git(root,['add','.']);git(root,['-c','user.name=ZZSH fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=disabled-hooks','commit','--no-gpg-sign','-qm','fixture']);
  const commit=git(root,['rev-parse','HEAD']),dir=join(root,'apps/api/migrations');
  const check=()=>assertApprovedMigrationRelease(root,commit,hashes(dir));
  assert.doesNotThrow(check);
  put(root,'apps/api/migrations/business/0155_legacy_rental_distribution_policy.sql',canonical0155.replace(/\n/g,'\r\n'));
  assert.doesNotThrow(check);
  put(root,'apps/api/migrations/business/0155_legacy_rental_distribution_policy.sql',canonical0155.replace(/\n/g,'\r\n')+'-- changed');
  assert.throws(check,/SCHEMA_RELEASE_FILES_CHANGED/);
  put(root,'apps/api/migrations/business/0155_legacy_rental_distribution_policy.sql',canonical0155);
  const emptyBin=join(root,'empty-bin');mkdirSync(emptyBin);
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];env.Path=emptyBin;
  const moduleUrl=pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),'install-round07-schema.mjs')).href;
  const code=`import {assertApprovedMigrationRelease as check} from ${JSON.stringify(moduleUrl)};try{check(process.argv[1],process.argv[2],JSON.parse(process.argv[3]));process.exitCode=99}catch(e){console.log(e.message)}`;
  const noGit=spawnSync(process.execPath,['--input-type=module','-e',code,root,commit,JSON.stringify(hashes(dir))],{cwd:root,env,encoding:'utf8',windowsHide:true});
  assert.equal(noGit.status,0,noGit.stderr);assert.match(noGit.stdout,/SCHEMA_RELEASE_COMMIT_INVALID/);
  rmSync(join(dir,'business/0001_fixture.sql'));put(root,'apps/api/migrations/business/meta/_journal.json','{"entries":[0]}\n');
  assert.throws(check,/SCHEMA_RELEASE_FILES_CHANGED/);
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 2;\n');put(root,'apps/api/migrations/business/meta/_journal.json',journal);
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 2;\r\n');
  assert.throws(check,/SCHEMA_RELEASE_FILES_CHANGED/);
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 2;\n');
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 99;\n');
  assert.throws(check,/SCHEMA_RELEASE_FILES_CHANGED/);
  put(root,'apps/api/migrations/business/0001_fixture.sql','SELECT 2;\n');put(root,'apps/api/migrations/business/0002_extra.sql','SELECT 3;\n');
  assert.throws(check,/SCHEMA_RELEASE_FILES_CHANGED/);rmSync(join(dir,'business/0002_extra.sql'));
  put(root,'scripts/migration/business-initial-tail-seeds.mjs','// changed\n');
  assert.throws(check,/SCHEMA_RELEASE_TOOLS_CHANGED/);
  assert.throws(()=>assertApprovedMigrationRelease(root,'HEAD',hashes(dir)),/SCHEMA_RELEASE_COMMIT_REQUIRED/);
 }finally{clearFixture(root);}
});

test('schema installer rejects stale builds and API source outside the approved commit',()=>{
 mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'approved-release-test-'));
 try{
  git(root,['init','-q']);git(root,['config','core.autocrlf','false']);
  put(root,'package.json','{"private":true}\n');put(root,'package-lock.json','{}\n');
  put(root,'tsconfig.base.json','{"compilerOptions":{"target":"ES2022","module":"CommonJS","types":[],"sourceMap":true}}\n');
  put(root,'apps/api/tsconfig.json','{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":".","outDir":"dist"},"include":["src/**/*.ts"]}\n');
  const source='export const value = 42;\n';put(root,'apps/api/src/example.ts',source);
  git(root,['add','.']);git(root,['-c','user.name=ZZSH fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=disabled-hooks','commit','--no-gpg-sign','-qm','fixture']);
  const commit=git(root,['rev-parse','HEAD']),build=committedApiBuild(root,commit);
  assert.deepEqual(Object.keys(build),['example.js']);
  assert.doesNotThrow(()=>assertCommittedApiBuild(root,commit,build));
  assert.throws(()=>assertCommittedApiBuild(root,commit,{'example.js':'a'.repeat(64)}),/SCHEMA_RELEASE_API_BUILD_CHANGED/);
  put(root,'apps/api/src/example.ts','export const value = 43;\n');
  assert.throws(()=>committedApiBuild(root,commit),/SCHEMA_RELEASE_API_SOURCE_CHANGED/);
  put(root,'apps/api/src/example.ts',source);put(root,'apps/api/src/extra.ts','export const extra = true;\n');
  assert.throws(()=>committedApiBuild(root,commit),/SCHEMA_RELEASE_API_SOURCE_UNTRACKED/);
 }finally{clearFixture(root);}
});
