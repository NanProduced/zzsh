import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const script=resolve('scripts/migration/prepare-local-distribution.mjs');
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
