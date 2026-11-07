import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertBundleLineage, topLevelPackage } from './stage-round07-dependencies.mjs';
test('package closure keeps packages inside the chosen node_modules boundary',()=>{
 const base=resolve('C:/fixture/node_modules');assert.equal(topLevelPackage(resolve(base,'pg/lib/client.js'),base),'pg');
 assert.match(topLevelPackage(resolve(base,'@scope/pkg/dist/index.js'),base),/^@scope[\\/]pkg$/);
 assert.equal(topLevelPackage(resolve('C:/other/outside.js'),base),null);
});
test('bundle and source manifest must bind the exact build',()=>{
 const build='a'.repeat(64),source='b'.repeat(64),manifest={schema:'zzsh.round07-preview-build.v1',sourceSnapshotManifestSha256:source};
 const bundle={finalBuildManifestSha256:build,finalSourceManifestSha256:source,entries:[]};assert.doesNotThrow(()=>assertBundleLineage(bundle,manifest,build,source));
 assert.throws(()=>assertBundleLineage({...bundle,finalSourceManifestSha256:'c'.repeat(64)},manifest,build,source));
});
test('dependency staging defaults to a zero-connection plan',()=>{
 const p=spawnSync(process.execPath,[fileURLToPath(new URL('./stage-round07-dependencies.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(p.status,0);const x=JSON.parse(p.stdout);assert.equal(x.connections,0);assert.equal(x.targetWrites,0);
});
