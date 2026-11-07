import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openingReviewResource } from './local-target-opening.mjs';
import { compareOpeningConnection } from './probe-round07-opening-guard.mjs';
test('opening review uses registered port and exact driver fields',()=>{
 const resource=openingReviewResource({targetPort:55433,state:{binding:{oid:'16390'},resource:{owner:'zzsh',marker:'zzsh:regression-test:v1',role:'zzsh_regression_migration',role_oid:'16388'}}});
 const connection={host:'127.0.0.1',port:55433,database:'zzsh_test_regression',user:'zzsh_regression_migration'};
 assert.equal(compareOpeningConnection(resource,connection),true);
 for(const x of [{...connection,port:55432},{...connection,host:'localhost'},{...connection,database:'other'},{...connection,user:'other'}])assert.equal(compareOpeningConnection(resource,x),false);
});
test('opening guard probe defaults to no connection or write',()=>{
 const p=spawnSync(process.execPath,[fileURLToPath(new URL('./probe-round07-opening-guard.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(p.status,0);
 const x=JSON.parse(p.stdout);assert.equal(x.connections,0);assert.equal(x.targetWrites,0);
});
