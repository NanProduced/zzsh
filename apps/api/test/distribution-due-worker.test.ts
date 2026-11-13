import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Pool, PoolClient } from 'pg';
import { DistributionDueService, loadDistributionDueRuntime } from '../src/finance/distribution-due.module';
import { assertDistributionAccrualTask, DistributionAccrualSessionLost, runDistributionAccrualTasks } from '../src/finance/distribution-accrual-tasks';
const legacy:typeof import('../src/finance/legacy-commission-due-worker')=require('../src/finance/legacy-commission-due-worker');

type Drive = { kind: 'new' | 'resume' | 'find'; requestId?: string; limit?: number; client: string | null; operatorUserId?:string; allSystemWorkers?:boolean };
let sessionSequence = 0;

/** One fake server shared by both instances: exactly one session may hold advisory key 806007. */
function harness(options: { batchLimit?: number; workerId?: string; server?: { holder: string | null }; legacyDue?:boolean } = { batchLimit: 20 }) {
  const locks = options.server ?? { holder: null as string | null };
  const driven: Drive[] = [];
  const control = { unfinished: null as null | { requestId: string; operatorUserId?:string }, state: 'COMPLETE' as 'COMPLETE' | 'UNKNOWN', failNew: false, failResume: false };
  let sequence = sessionSequence;
  sessionSequence += 100;
  const clients: Array<PoolClient & { id: string; alive: boolean; dropped: boolean }> = [];
  const makeClient = () => {
    const id = 'sess_' + (sequence++);
    const listeners = new Map<string, () => void>();
    const entry = { id, alive: true, dropped: false, once(event: string, listener: () => void) { listeners.set(event, listener); }, removeListener(event: string, listener: () => void) { if (listeners.get(event) === listener) listeners.delete(event); }, emit(event: string) { const listener = listeners.get(event); listeners.delete(event); listener?.(); }, release() { if (!entry.alive) return; entry.alive = false; if (locks.holder === id) locks.holder = null; clients.splice(clients.indexOf(entry as any), 1); },
      async query(sql: string, args: any[] = []) {
        if (!entry.alive || entry.dropped) throw Object.assign(new Error('CONNECTION_CLOSED'), { code: '57P01' });
        if (sql.includes('pg_try_advisory_lock')) {
          if (String(args[0]) !== '806007') return { rows: [{ acquired: true }], rowCount: 1 };
          if (locks.holder !== null && locks.holder !== id) return { rows: [{ acquired: false }], rowCount: 1 };
          locks.holder = id; return { rows: [{ acquired: true }], rowCount: 1 };
        }
        if (sql.includes('pg_advisory_unlock')) { if (String(args[0]) === '806007' && locks.holder === id) locks.holder = null; return { rows: [{ released: true }], rowCount: 1 }; }
        if (sql.includes('FROM pg_locks')) {
          assert.doesNotMatch(sql, /objobjid/);
          assert.match(sql, /\bobjid\s*=/);
          assert.match(sql, /objsubid=1/);
          assert.match(sql, /\bgranted\b/);
          return { rows: [{ held: locks.holder === id ? 1 : 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      } } as unknown as PoolClient & { id: string; alive: boolean; dropped: boolean };
    clients.push(entry);
    return entry;
  };
  const pool = { async connect() { return makeClient(); } } as unknown as Pool;
  let newKey: string | null = null;
  const store = {
    async pendingAccrualTasks() { return { available:true,items:[] }; },
    async findUnfinishedBatch(_p: Pool, input: { client?: PoolClient; operator:{userId:string}; allSystemWorkers?:boolean }) { driven.push({ kind: 'find', client: (input.client as any)?.id ?? null,operatorUserId:input.operator.userId,allSystemWorkers:input.allSystemWorkers }); return control.unfinished; },
    async resumeBatch(_p: Pool, input: { requestId: string; client?: PoolClient; operator:{userId:string} }) {
      driven.push({ kind: 'resume', requestId: input.requestId, client: (input.client as any)?.id ?? null,operatorUserId:input.operator.userId });
      if (control.failResume) throw new Error('original receipt read failed');
      control.unfinished = null;
      return { httpStatus: 200, batch: { state: control.state, requestId: input.requestId, results: [{ id: 'earning_a' }], notAttempted: 0 }, replayed: true };
    },
    async runDueBatch(_p: Pool, input: { requestId: string; limit: number; client?: PoolClient }) {
      driven.push({ kind: 'new', requestId: input.requestId, limit: input.limit, client: (input.client as any)?.id ?? null });
      newKey = input.requestId;
      if (control.failNew) throw new Error('progress receipt commit unknown');
      control.unfinished = control.state === 'UNKNOWN' ? { requestId: input.requestId } : null;
      return { httpStatus: control.state === 'UNKNOWN' ? 503 : 200, batch: { state: control.state, requestId: input.requestId, results: [{ id: 'earning_a' }], notAttempted: 0 }, replayed: false };
    },
  };
  const service = new DistributionDueService({ pool, store: store as any, intervalMs: 60000, batchLimit: options.batchLimit ?? 20, workerId: options.workerId ?? 'main', legacyDue:options.legacyDue });
  return { service, driven, control, locks, clients, keys: () => driven.filter(d => d.kind !== 'find').map(d => d.requestId), newKey: () => newKey };
}

test('legacy dues reuse the live worker session and continue from the previous cursor',async t=>{
 const calls:Array<{client:string;cursor:unknown;limit:number}>=[];
 t.mock.method(legacy,'runLegacyCommissionDuePage',async(...[client,cursor,limit]:Parameters<typeof legacy.runLegacyCommissionDuePage>)=>{calls.push({client:(client as any).id,cursor,limit});return {available:true,cursor:{at:'2026-11-01T00:00:00.000000Z',id:'duty_1'},posted:1,deferred:0,scanned:1};});
 const h=harness({legacyDue:true,batchLimit:5});await h.service.tick();await h.service.tick();
 assert.equal(calls.length,2);assert.equal(calls[0]!.client,h.driven[1]!.client);assert.deepEqual(calls[1]!.cursor,{at:'2026-11-01T00:00:00.000000Z',id:'duty_1'});assert.equal(calls[1]!.limit,5);
 await h.service.onApplicationShutdown();
});
test('an unknown legacy commit releases the worker session before recovery',async t=>{
 t.mock.method(legacy,'runLegacyCommissionDuePage',async()=>{throw new legacy.LegacyCommissionCommitUnknown();});
 const h=harness({legacyDue:true});await h.service.tick();assert.equal(h.locks.holder,null);assert.equal(h.clients.filter(c=>c.alive).length,0);
 await h.service.onApplicationShutdown();
});

test('the driver only runs while its own session still holds the due lock', async () => {
  const h = harness();
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1);
  assert.equal(h.locks.holder, h.driven[1]!.client);
  assert.equal(h.clients.filter(c => c.alive).length, 1);
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 2);
  assert.equal(h.clients.filter(c => c.alive).length, 1, 'the same session keeps driving');
  await h.service.onApplicationShutdown();
  assert.equal(h.locks.holder, null);
  assert.equal(h.clients.filter(c => c.alive).length, 0);
});

test('an exception after planning keeps the original key and the next cycle resumes it', async () => {
  const h = harness();
  h.control.failNew = true;
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1);
  const original = h.newKey()!;
  h.control.failNew = false;
  h.control.unfinished = { requestId: original };
  await h.service.tick();
  assert.deepEqual(h.keys(), [original, original]);
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1, 'no new key after an unknown commit');
});

test('an UNKNOWN batch is resumed under its original key instead of selecting the next roots', async () => {
  const h = harness();
  h.control.state = 'UNKNOWN';
  await h.service.tick();
  const original = h.newKey()!;
  h.control.state = 'COMPLETE';
  await h.service.tick();
  assert.deepEqual(h.keys(), [original, original]);
  assert.equal(h.driven.filter(d => d.kind === 'resume').length, 1);
});

test('an unresolved original batch is retried while a separate due batch may proceed',async()=>{
  const h=harness();
  h.control.unfinished={requestId:'due_original',operatorUserId:'distribution-due-original'};
  h.control.state='UNKNOWN';
  await h.service.tick();
  assert.equal(h.driven.find(item=>item.kind==='resume')?.requestId,'due_original');
  const independent=h.driven.find(item=>item.kind==='new');
  assert.ok(independent);assert.notEqual(independent.requestId,'due_original');
  assert.equal(independent.client,h.driven.find(item=>item.kind==='resume')?.client);
  await h.service.onApplicationShutdown();
});

test('a restarted driver resumes the persisted original batch before planning a new one', async () => {
  const first = harness();
  await first.service.tick();
  const original = first.newKey()!;
  first.control.unfinished = { requestId: original };
  // Simulate a process rebuild that loses every in-memory flag but keeps the persisted batch.
  const second = harness();
  second.control.unfinished = { requestId: original };
  await second.service.tick();
  assert.equal(second.driven.filter(d => d.kind === 'resume').length, 1);
  assert.equal(second.driven.filter(d => d.kind === 'new').length, 0, 'a rebuilt worker must not pick the next batch');
  assert.equal(second.driven.find(d => d.kind === 'resume')!.requestId, original);
});

test('posting gate preserves an absent legacy schema and rejects partial or missing task contracts', async () => {
  let schema:'ABSENT'|'PARTIAL'|'READY'='ABSENT',taskExists=true;
  const client={async query(sql:string){
    if(sql.includes('distribution_accrual_task_schema_v1'))return{rows:[{absent:schema==='ABSENT',ready:schema==='READY'}]};
    if(sql.startsWith('SELECT 1 FROM zzsh_order.distribution_accrual_task'))return{rows:[],rowCount:taskExists?1:0};
    throw Error('unexpected query');
  }} as unknown as PoolClient;
  await assertDistributionAccrualTask(client,'posting',false);
  await assert.rejects(assertDistributionAccrualTask(client,'posting',true),/contract is unavailable/);
  schema='PARTIAL';
  await assert.rejects(assertDistributionAccrualTask(client,'posting',false),/contract is unavailable/);
  schema='READY';await assertDistributionAccrualTask(client,'posting',true);
  taskExists=false;await assert.rejects(assertDistributionAccrualTask(client,'posting',false),/task is unavailable/);
});

test('a different worker resumes the original system actor and batch key', async () => {
  const h = harness({ workerId: 'replacement' });
  h.control.unfinished = { requestId: 'due_original', operatorUserId: 'distribution-due-original' };
  await h.service.tick();
  assert.equal(h.driven.find(d => d.kind === 'find')?.allSystemWorkers, true);
  const resumed = h.driven.find(d => d.kind === 'resume');
  assert.equal(resumed?.requestId, 'due_original');
  assert.equal(resumed?.operatorUserId, 'distribution-due-original');
  assert.equal(h.driven.some(d => d.kind === 'new'), false);
  await h.service.onApplicationShutdown();
});

test('accrual tasks keep unknowns for review and delay failures without starving other postings', async () => {
  const tasks = ['ok','skip','unknown','evidence','retry','later'].map(id => ({ postingId:`posting_${id}`,orderId:`order_${id}` }));
  const states = new Map(tasks.map(task => [task.postingId, { state:'PENDING', reason:null as string|null }]));
  const attempts:string[] = [], requests = new Map<string,string[]>();
  let retry = true;
  const client = { async query(sql:string,args:any[] = []) {
    if(sql.startsWith('UPDATE zzsh_order.distribution_accrual_task')) {
      const state=states.get(args[0]); if(!state || state.state!=='PENDING') return {rowCount:0,rows:[]};
      if(sql.includes('SET state=$2')) {state.state=args[1];state.reason=args[2];}
      else if(sql.includes("state='REVIEW_REQUIRED'")) {state.state='REVIEW_REQUIRED';state.reason=args[1];}
      else state.reason=args[1];
      return {rowCount:1,rows:[]};
    }
    return {rowCount:0,rows:[]};
  }} as unknown as PoolClient;
  const store = {
    async pendingAccrualTasks() {return {available:true,items:tasks.filter(t=>states.get(t.postingId)!.state==='PENDING')};},
    async accrueOn(_c:PoolClient,orderId:string,key:string) {
      attempts.push(orderId);requests.set(orderId,[...(requests.get(orderId)??[]),key]);
      if(orderId==='order_retry'&&retry) throw Object.assign(new Error('network unavailable'),{code:'ECONNRESET'});
      if(orderId==='order_evidence') throw Object.assign(new Error('source evidence unavailable'),{status:503,code:'EVIDENCE_UNAVAILABLE'});
      if(orderId==='order_unknown') return {knowledge:'UNKNOWN',reason:'MISSING_ORIGINAL_BASIS',items:[]};
      if(orderId==='order_skip') return {knowledge:'KNOWN',skipReason:'NO_PAYABLE_COMMISSION',items:[]};
      return {knowledge:'KNOWN',items:[{replayed:false}]};
    },
  } as any;
  const operator = {userId:'distribution-due-main',sessionId:'system',system:true,authorize:async()=>{}};
  const first=await runDistributionAccrualTasks(client,store,operator,10,()=>true);
  assert.deepEqual(first,{available:true,examined:6,completed:3,review:2});
  assert.equal(states.get('posting_unknown')?.state,'REVIEW_REQUIRED');
  assert.equal(states.get('posting_unknown')?.reason,'MISSING_ORIGINAL_BASIS');
  assert.equal(states.get('posting_skip')?.state,'SKIPPED');
  assert.equal(states.get('posting_evidence')?.state,'REVIEW_REQUIRED');
  assert.equal(states.get('posting_retry')?.state,'PENDING');
  assert.equal(states.get('posting_retry')?.reason,'ECONNRESET');
  assert.equal(states.get('posting_later')?.state,'DONE');
  retry=false;
  await runDistributionAccrualTasks(client,store,operator,10,()=>true);
  assert.equal(states.get('posting_retry')?.state,'DONE');
  assert.equal(new Set(requests.get('order_retry')).size,1,'the original posting keeps one recovery key');
  assert.equal(attempts.filter(id=>id==='order_unknown').length,1,'unknown evidence is not silently retried');
});

test('loss of the driving session rolls back and stops accrual tasks', async () => {
  let held=true;const wire:string[]=[];
  const client={async query(sql:string){wire.push(sql);return{rowCount:1,rows:[]};}} as unknown as PoolClient;
  const store={async pendingAccrualTasks(){return{available:true,items:[{postingId:'posting_1',orderId:'order_1'},{postingId:'posting_2',orderId:'order_2'}]};},
    async accrueOn(){held=false;return{knowledge:'KNOWN',items:[{}]};}} as any;
  await assert.rejects(runDistributionAccrualTasks(client,store,{userId:'distribution-due-main',sessionId:'system',system:true,authorize:async()=>{}},2,()=>held),DistributionAccrualSessionLost);
  assert.equal(wire.filter(sql=>sql==='ROLLBACK').length,1);
  assert.equal(wire.filter(sql=>sql==='COMMIT').length,1,'only discovery commits');
  assert.equal(wire.filter(sql=>sql==='BEGIN').length,2);
});

test('an unknown accrual COMMIT never rolls back or writes a retry state on the same session', async () => {
  const wire:string[]=[];let commits=0;
  const client={async query(sql:string){wire.push(sql);if(sql==='COMMIT'&&++commits===2)throw Error('COMMIT_ACK_UNKNOWN');return{rowCount:1,rows:[]};}} as unknown as PoolClient;
  const store={async pendingAccrualTasks(){return{available:true,items:[{postingId:'posting_1',orderId:'order_1'}]};},
    async accrueOn(){return{knowledge:'KNOWN',items:[{}]};}} as any;
  await assert.rejects(runDistributionAccrualTasks(client,store,{userId:'distribution-due-main',sessionId:'system',system:true,authorize:async()=>{}},1,()=>true),DistributionAccrualSessionLost);
  assert.equal(wire.at(-1),'COMMIT');
  assert.equal(wire.filter(sql=>sql==='ROLLBACK').length,0);
  assert.equal(wire.filter(sql=>sql.startsWith('UPDATE zzsh_order.distribution_accrual_task')).length,1);
});

test('changing the interval or batch limit cannot change the original batch input', async () => {
  const small = harness({ batchLimit: 5 });
  await small.service.tick();
  const original = small.newKey()!;
  const later = harness({ batchLimit: 100 });
  later.control.unfinished = { requestId: original };
  await later.service.tick();
  const resumed = later.driven.find(d => d.kind === 'resume')!;
  assert.equal(resumed.requestId, original);
  assert.equal((resumed as any).limit, undefined, 'resume carries the original key only, never the current limit');
});

test('a session that lost its lock stops driving and a waiting instance takes over', async () => {
  const server = { holder: null as string | null };
  const a = harness({ workerId: 'a', server }), b = harness({ workerId: 'b', server });
  await a.service.tick();
  const held = a.driven.find(d => d.kind === 'new')!.client;
  assert.equal(server.holder, held);
  await b.service.tick();
  assert.equal(b.driven.length, 0, 'a lock-starved instance performs no money work');
  assert.equal(server.holder, held, 'a waiting instance cannot steal a live lock');
  // A's database session dies: PG drops the lock and A must notice before starting more work.
  a.clients.forEach(client => { client.dropped = true; });
  const drivenBefore = a.driven.length;
  await a.service.tick();
  assert.equal(a.driven.length, drivenBefore, 'the stale instance stops before touching money');
  assert.equal(server.holder, null, 'a dead session cannot keep the execution right');
  await b.service.tick();
  assert.equal(b.driven.filter(d => d.kind === 'new').length, 1, 'the waiting instance takes over without a restart');
});

test('the worker runtime stays opt-in and refuses an assembly without an earning store', () => {
  assert.equal(loadDistributionDueRuntime(undefined, undefined, { DISTRIBUTION_DUE_WORKER_ENABLED: 'false' }), undefined);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, undefined, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true' }), /requires explicit NATIVE distribution assembly/);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, {} as any, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true', DISTRIBUTION_DUE_INTERVAL_MS: '1000' }), /60000-3600000/);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, {} as any, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true', DISTRIBUTION_DUE_BATCH_LIMIT: '500' }), /BATCH_LIMIT must be 1-100/);
});


test('Root: session error/end releases the checked-out pool client exactly once', async () => {
  for (const event of ['error', 'end']) {
    const h = harness();
    await h.service.tick();
    const client = h.clients[0] as any;
    client.dropped = true;
    client.emit(event);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.clients.length, 0, event + ' must return the broken pool lease');
    await h.service.tick();
    assert.equal(h.driven.filter(d => d.kind === 'new').length, 2);
    await h.service.onApplicationShutdown();
    assert.equal(h.clients.length, 0);
  }
});
