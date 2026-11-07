import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeR07DistributionCandidate } from './prepare-round07-distribution-candidate.mjs';
import { legacyDistributionPolicy } from './local-distribution-qualification-plan.mjs';

test('candidate retains exact source rows required by the read-only qualification planner',()=>{
 const digest='a'.repeat(64),source={receiptSha256:digest,configurationSha256:digest,levelsSha256:digest};
 const values={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'7.0'};
 const configuration=Object.entries(values).map(([name,value])=>({name,value,is_delete:'0'}));
 const rawLevels=[{id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'青铜',is_delete:'0'}];
 const result=makeR07DistributionCandidate(source,configuration,rawLevels);
 assert.deepEqual(result.configuration,configuration);assert.deepEqual(result.rawLevels,rawLevels);
 assert.deepEqual(result.approvalPayloads,[legacyDistributionPolicy({scope:'NATIVE',...source,configuration,rawLevels})]);
 assert.throws(()=>makeR07DistributionCandidate(source,undefined,rawLevels));
 assert.throws(()=>makeR07DistributionCandidate(source,configuration,undefined));
});
