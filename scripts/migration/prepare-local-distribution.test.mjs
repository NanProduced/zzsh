import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {distributionInputWindow} from './prepare-local-distribution.mjs';

const script=resolve('scripts/migration/prepare-local-distribution.mjs');
test('workflow window can only narrow the original active round window',()=>{
 const now=Date.parse('2026-11-10T01:00:00.000Z'),parent={notBefore:'2026-11-10T00:00:00.000Z',expiresAt:'2026-11-10T02:00:00.000Z'};
 const requested={notBefore:'2026-11-10T00:59:59.000Z',expiresAt:'2026-11-10T01:20:00.000Z'};
 assert.deepEqual(distributionInputWindow(parent,requested,now),requested);
 assert.deepEqual(distributionInputWindow(null,{},now),{notBefore:'2026-11-10T00:59:57.000Z',expiresAt:'2026-11-10T01:25:00.000Z'});
 for(const bad of [{...requested,notBefore:'2026-11-09T23:59:59.000Z'},{...requested,expiresAt:'2026-11-10T02:00:01.000Z'},
  {...requested,expiresAt:'2026-11-10T00:59:59.500Z'},{...requested,expiresAt:'2026-11-10T01:31:00.000Z'},
  {...requested,notBefore:'2026-02-30T00:00:00.000Z'},{notBefore:requested.notBefore}])
  assert.throws(()=>distributionInputWindow(parent,bad,now),/DISTRIBUTION_WORKFLOW_WINDOW_INVALID/);
});
test('distribution seal entry defaults to a no-credential, no-connection plan',()=>{
 const result=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(result.status,0);
 assert.deepEqual(JSON.parse(result.stdout),{status:'PLAN_ONLY',phases:['input','authority'],connections:0,credentialReads:0,financialWrites:0});
});
test('an unrecognized seal phase stops without connecting or returning private values',()=>{
 const result=spawnSync(process.execPath,[script,'other'],{encoding:'utf8'});assert.notEqual(result.status,0);
 assert.match(result.stderr,/DISTRIBUTION_SEAL_PHASE_REQUIRED/);assert.doesNotMatch(result.stderr,/password|secret|token/i);
});
test('input sealing must explicitly state whether the source is reused',()=>{
 const result=spawnSync(process.execPath,[script,'input'],{encoding:'utf8'});assert.notEqual(result.status,0);
 assert.match(result.stderr,/SOURCE_MODE_REQUIRED/);assert.doesNotMatch(result.stderr,/password|secret|token/i);
});
