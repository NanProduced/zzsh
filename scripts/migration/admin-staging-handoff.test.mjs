import test from 'node:test';
import assert from 'node:assert/strict';
import { retireStagingMigrationAdmins, recoverDeliveryHandoff } from './admin-staging-handoff.mjs';

const actor={id:'admin_'+'a'.repeat(32),creationAuditId:'audit_'+'b'.repeat(32),kind:'BOOTSTRAP'};
const fixture=()=>({schema:'zzsh.admin-staging-handoff.v1',target:{database:'zzsh_test_r08_auth_handoff',oid:'42',marker:'zzsh:r08-auth-handoff:v1',role:'fixture_owner',systemIdentifier:'123'},sourceDatasetSha256:'c'.repeat(64),approvalRef:'synthetic-fixture',actors:[actor]});
const untouched={query:async()=>{throw new Error('UNEXPECTED_DATABASE_CALL')}};

test('admin retirement candidate rejects live and unbound targets before any SQL',async()=>{
  for(const change of [
    x=>x.target.marker='zzsh:regression-test:v1',x=>x.target.marker='zzsh:deployment-staging-clone:v1',x=>x.target.marker='zzsh:r07-delivery-clone:v1',
    x=>x.target.database='zzsh_dev_daily',x=>x.target.database='zzsh_test_regression',x=>x.target.oid='',
    x=>x.target.systemIdentifier='unknown',x=>x.sourceDatasetSha256='unknown',x=>x.approvalRef='',
  ]){const input=fixture();change(input);await assert.rejects(()=>retireStagingMigrationAdmins(untouched,input),/ADMIN_HANDOFF_INPUT_INVALID/)}
});

test('read-only recovery rejects an unbound clone before querying',async()=>{
 const input=fixture();input.target.marker='zzsh:r07-delivery-clone:v1';
 await assert.rejects(()=>recoverDeliveryHandoff(untouched,input),/ADMIN_HANDOFF_RECOVERY_INPUT_INVALID/);
});

test('admin retirement candidate rejects an ambiguous actor roster before any SQL',async()=>{
  for(const change of [
    x=>x.actors=[],x=>x.actors=[actor,actor],x=>x.actors=[{...actor,id:'user_1'}],
    x=>x.actors=[{...actor,kind:'HUMAN'}],x=>x.actors=[{...actor,extra:true}],
  ]){const input=fixture();change(input);await assert.rejects(()=>retireStagingMigrationAdmins(untouched,input),/ADMIN_HANDOFF_(INPUT|ACTORS)_INVALID/)}
});
