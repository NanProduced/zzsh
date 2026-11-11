import assert from 'node:assert/strict';

/** All batches are prepared and rolled back in trial before the first publication. */
export async function runListedBatchWorkflow({batchCount,steps,record}) {
  assert(Number.isSafeInteger(batchCount)&&batchCount>=0&&typeof record==='function','LISTED_WORKFLOW_INVALID');
  const required=batchCount?['prepareSource','prepareTarget','trial','execute','readback','finalize']:['emptyReadback'];
  assert(steps&&required.every(name=>typeof steps[name]==='function'),'LISTED_WORKFLOW_INVALID');
  async function run(stage,index,action,...args){
    await record({stage,index,status:'INTENT'});
    const value=await action(...args);
    await record({stage,index,status:'ACK',result:value});
    return value;
  }
  if(!batchCount)return run('empty-readback',null,steps.emptyReadback);
  const batches=Array.from({length:batchCount},(_,i)=>({index:i+1}));
  for(const batch of batches)batch.source=await run('prepare-source',batch.index,steps.prepareSource,batch.index);
  for(const batch of batches)batch.target=await run('prepare-target',batch.index,steps.prepareTarget,batch);
  for(const batch of batches)batch.trial=await run('trial',batch.index,steps.trial,batch);
  for(const batch of batches){
    batch.execution=await run('execute',batch.index,steps.execute,batch);
    batch.readback=await run('batch-readback',batch.index,steps.readback,batch);
  }
  return run('all-batch-readback',null,steps.finalize,batches);
}
