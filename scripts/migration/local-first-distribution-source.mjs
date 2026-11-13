import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {assertRoundSourceOrigin} from './local-round-contract.mjs';
import {assertNextSourceTools,NEXT_SOURCE_SCRIPTS} from './local-round-dependencies.mjs';
import {loadLegacyDistributionPrerequisite} from './local-distribution-qualification-plan.mjs';
import {NEXT_MIGRATION_PROFILE} from './local-target-registry.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** Reconstruct the first policy only from the exact source and dataset bound to this target. */
export async function readFirstDistributionSource({request,workflowRef,privatePath,canonicalize,parsePolicy,scriptsDir}) {
  assert(request?.target?.migrationProfile===NEXT_MIGRATION_PROFILE&&hex(request.datasetSha256)
    &&typeof privatePath==='function'&&hex(workflowRef?.sha256),'FIRST_DISTRIBUTION_SOURCE_BINDING_REQUIRED');
  const pinned=ref=>{
    assert(hex(ref?.sha256),'FIRST_DISTRIBUTION_SOURCE_BINDING_REQUIRED');
    const bytes=readFileSync(privatePath(ref.path));
    assert.equal(sha(bytes),ref.sha256,'FIRST_DISTRIBUTION_SOURCE_CHANGED');
    return JSON.parse(bytes);
  };
  const workflow=pinned(workflowRef),spec=pinned(workflow.input);
  const {source,funds,refundAttempts,sourceBinding}=workflow.result??{};
  const receipt=ref=>pinned({path:join(privatePath(ref?.path),'receipt.json'),sha256:ref?.sha256});
  const sourceReceipt=receipt(source),fundsReceipt=receipt(funds),refundReceipt=receipt(refundAttempts),binding=pinned(sourceBinding);
  const dataset=pinned({path:join(privatePath(request.datasetPath),'manifest.json'),sha256:request.datasetSha256});
  const input={target:request.target,source,funds,refundAttempts,sourceBinding,sourceWorkflow:workflowRef};
  assertRoundSourceOrigin(input,sourceReceipt,dataset,binding,fundsReceipt,refundReceipt,workflow,spec);
  const scriptFiles=Object.fromEntries([...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs']
    .map(name=>[name,sha(readFileSync(resolve(scriptsDir,name)))]));
  assertNextSourceTools(input,binding,[sourceReceipt,fundsReceipt,refundReceipt],scriptFiles,workflow);
  const result=await loadLegacyDistributionPrerequisite({sourceDir:privatePath(source.path),receipt:sourceReceipt,
    sourceSha256:source.sha256,canonicalize,parsePolicy,safePath:privatePath});
  return {payload:result.payload,summary:result.summary,sourceReceiptSha256:source.sha256,
    workflowSha256:workflowRef.sha256,datasetSha256:request.datasetSha256};
}
