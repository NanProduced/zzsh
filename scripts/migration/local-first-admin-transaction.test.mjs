import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FirstAdminTransactionError,readFirstAdministratorsSnapshot,writeFirstAdministrators} from './local-first-admin-transaction.mjs';

function fixture({fail='', readResult={knowledge:'KNOWN',accounts:[]}}={}) {
  const sql=[],states=[],client={async query(text){sql.push(text);
    if(fail==='begin'&&text==='BEGIN'||fail==='commit'&&text==='COMMIT'||fail==='rollback'&&text==='ROLLBACK')throw Error('private database detail');
    return {command:text.startsWith('BEGIN')?'BEGIN':text};}};
  const args={client,input:{private:'secret'},requestId:'same-request',hashPassword:async()=>'',verifyPassword:async()=>true,
    initialize:async()=>{if(fail==='initialize'||fail==='rollback')throw Error('private input');return[{username:'ZZ00001',role:'BOSS',id:'private-id'}];},
    read:async()=>readResult,acquireFence:async()=>{if(fail==='fence')throw Error('fence');},
    checkBinding:async()=>{if(fail==='binding')throw Error('binding');},
    record:async value=>{states.push(value.status);if(fail==='intent'&&value.status==='COMMIT_INTENT'||fail==='ack-receipt'&&value.status==='COMMIT_ACK_READBACK_REQUIRED')throw Error('private output');}};
  return{args,sql,states};
}

test('first administrators are returned only after the durable commit intent and commit acknowledgement',async()=>{
  const f=fixture(),accounts=await writeFirstAdministrators(f.args);
  assert.deepEqual(f.states,['WRITE_INTENT','COMMIT_INTENT','COMMIT_ACK_READBACK_REQUIRED']);
  assert.deepEqual(f.sql,['BEGIN','COMMIT']);assert.deepEqual(accounts,[{username:'ZZ00001',role:'BOSS'}]);
});

test('pre-commit failures roll back and never issue COMMIT',async()=>{
  for(const fail of ['begin','fence','initialize','binding','intent']){
    const f=fixture({fail});
    await assert.rejects(writeFirstAdministrators(f.args),e=>e instanceof FirstAdminTransactionError&&e.outcome==='NOT_COMMITTED'&&e.rollbackAcknowledged);
    assert(!f.sql.includes('COMMIT'));assert.equal(f.sql.at(-1),'ROLLBACK');
  }
});

test('unknown commit and failed acknowledgement do not rollback or change the original attempt',async()=>{
  for(const [fail,outcome] of [['commit','COMMIT_UNKNOWN'],['ack-receipt','COMMITTED_READBACK_REQUIRED']]){
    const f=fixture({fail});
    await assert.rejects(writeFirstAdministrators(f.args),e=>e instanceof FirstAdminTransactionError&&e.outcome===outcome&&!e.rollbackAcknowledged);
    assert.deepEqual(f.sql,['BEGIN','COMMIT']);assert(f.states.includes('COMMIT_INTENT'));assert.equal(f.states.at(-1),outcome);
  }
  const f=fixture({fail:'rollback'});
  await assert.rejects(writeFirstAdministrators(f.args),e=>e instanceof FirstAdminTransactionError&&e.outcome==='ROLLBACK_UNKNOWN'&&!e.rollbackAcknowledged);
  assert.deepEqual(f.sql,['BEGIN','ROLLBACK']);
});

test('readback is a separate read-only snapshot and preserves UNKNOWN',async()=>{
  const f=fixture({readResult:{knowledge:'UNKNOWN',accounts:null}});
  assert.deepEqual(await readFirstAdministratorsSnapshot(f.args),{knowledge:'UNKNOWN',accounts:null});
  assert.deepEqual(f.sql,['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','ROLLBACK']);
  const bad=fixture({fail:'binding'});
  await assert.rejects(readFirstAdministratorsSnapshot(bad.args),e=>e instanceof FirstAdminTransactionError&&e.outcome==='READBACK_UNCONFIRMED');
  assert(!bad.sql.includes('COMMIT'));
});
