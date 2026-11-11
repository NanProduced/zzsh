import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertGrowthPriorAttempt, digestInlineGrowthLog, executeGrowthEntry, growthFailureStatus, growthQueryCategory, growthRecoveryStatus, inlineGrowthIntent, openGrowthPackageReader, sameGrowthInstance, syncInlineGrowthLog, validateGrowthPackageEntries, validateGrowthPackageLayout, verifyGrowthPackageBytes, verifyInlineGrowthLog, writeGrowthPackagePacks } from './local-growth-packages.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

test('packed growth recovery rejects copied targets and preserves the original key and package', () => {
  const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123456'},target={oid:'42',nonce:'a'.repeat(24),instance};
  const plan={packages:[{executionKey:'original-key',sha256:'b'.repeat(64)}]},manifestSha256='c'.repeat(64);
  const prior={status:'COMMIT_UNKNOWN_STOPPED',actorId:'synthetic-admin',manifestSha256,oid:target.oid,nonce:target.nonce,instance,poolClosed:true,unlockAck:true,lockClosed:true,
    pending:{index:1,executionKey:'original-key',businessPackageSha256:'b'.repeat(64),businessFingerprint:'d'.repeat(64)}};
  const options={mode:'RECOVER',plan,target,actorId:'synthetic-admin',manifestSha256,index:1,packed:true};
  assert.equal(sameGrowthInstance(instance,{...instance}),true);
  assert.doesNotThrow(()=>assertGrowthPriorAttempt(prior,options));
  for(const changed of [undefined,{...instance,port:55432},{...instance,systemIdentifier:'654321'},{...instance,host:'192.0.2.1'}])
    assert.throws(()=>assertGrowthPriorAttempt({...prior,instance:changed},options),/ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED/);
  for(const change of [{executionKey:'new-key'},{businessPackageSha256:'e'.repeat(64)},{businessFingerprint:'bad'}])
    assert.throws(()=>assertGrowthPriorAttempt({...prior,pending:{...prior.pending,...change}},options),/ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED/);
  for(const field of ['poolClosed','unlockAck','lockClosed'])
    assert.throws(()=>assertGrowthPriorAttempt({...prior,[field]:false},options),/ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED/);
  const rollback={...prior,status:'NOT_COMMITTED_STOPPED',error:{rollbackAcknowledged:true},completed:0};
  assert.doesNotThrow(()=>assertGrowthPriorAttempt(rollback,{...options,mode:'CONTINUE'}));
  assert.throws(()=>assertGrowthPriorAttempt({...rollback,instance:{...instance,systemIdentifier:'654321'}},{...options,mode:'CONTINUE'}),/KNOWN_ORIGINAL_ROLLBACK_REQUIRED_TO_CONTINUE/);
  assert.throws(()=>assertGrowthPriorAttempt({...rollback,error:{rollbackAcknowledged:false}},{...options,mode:'CONTINUE'}),/KNOWN_ORIGINAL_ROLLBACK_REQUIRED_TO_CONTINUE/);
  const old=structuredClone(prior);delete old.instance;delete old.pending.businessFingerprint;delete old.pending.businessPackageSha256;
  assert.doesNotThrow(()=>assertGrowthPriorAttempt(old,{...options,packed:false}));
  assert.doesNotThrow(()=>assertGrowthPriorAttempt({...prior,status:'COMMIT_ACK_READBACK_REQUIRED',pending:{...prior.pending,commitAck:true}},options));
  assert.throws(()=>assertGrowthPriorAttempt({...prior,status:'COMMIT_ACK_READBACK_REQUIRED'},options),/ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED/);
  const nextInstance={...instance,port:55435},nextTarget={...target,instance:nextInstance,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};
  const nextPrior={...prior,instance:nextInstance,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'},nextOptions={...options,target:nextTarget};
  assert.doesNotThrow(()=>assertGrowthPriorAttempt(nextPrior,nextOptions));
  assert.throws(()=>assertGrowthPriorAttempt({...nextPrior,migrationProfile:undefined},nextOptions),/ORIGINAL_GROWTH_UNKNOWN_RECEIPT_REQUIRED/);
});

test('growth intent failure prevents a write; failed result persistence retains the original acknowledged key', async () => {
  const pending={index:1,executionKey:'original-key'},events=[];
  const hooks={pending,recovery:false,writeIntent:async()=>events.push('INTENT'),execute:async()=>{events.push('COMMIT_ACK');return {receipt:'synthetic'}},
    writeResult:async()=>{events.push('PERSIST');throw Error('disk unavailable')}};
  await assert.rejects(executeGrowthEntry(hooks),/disk unavailable/);
  assert.deepEqual(events,['INTENT','COMMIT_ACK','PERSIST']);
  assert.deepEqual(pending,{index:1,executionKey:'original-key',commitAck:true});
  assert.equal(growthFailureStatus(Error('disk unavailable'),pending),'COMMIT_ACK_READBACK_REQUIRED');
  const noWrite={index:1,executionKey:'original-key'},blocked=[];
  await assert.rejects(executeGrowthEntry({...hooks,pending:noWrite,writeIntent:async()=>{throw Error('intent unavailable')},execute:async()=>blocked.push('write')}),/intent unavailable/);
  assert.deepEqual(blocked,[]);assert.equal(noWrite.commitAck,undefined);
  assert.equal(growthFailureStatus({outcome:'COMMIT_UNKNOWN'},noWrite),'COMMIT_UNKNOWN_STOPPED');
  assert.equal(growthFailureStatus({outcome:'NOT_COMMITTED'},noWrite),'NOT_COMMITTED_STOPPED');
  assert.equal(growthFailureStatus(Error('log verification failed'),null,true),'ALL_COMMITS_ACK_LOG_REVIEW_REQUIRED');
  for(const state of ['NOT_FOUND','UNKNOWN','FINGERPRINT_MISMATCH',undefined])assert.equal(growthRecoveryStatus(state),'RECOVERY_READBACK_REVIEW_REQUIRED');
  assert.equal(growthRecoveryStatus('FOUND'),'RECOVERED_READ_ONLY');
});

test('inline growth approvals retain original bytes and only a complete matching intent/ACK log verifies', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zzsh-growth-inline-')), file = join(directory, 'events.jsonl');
  t.after(() => { if (existsSync(file)) { assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()); unlinkSync(file); } rmdirSync(directory); });
  const packages = [1, 2].map(n => ({ userId: `synthetic-${n}`, executionKey: `key-${n}`, sha256: String(n).repeat(64),
    coverageFingerprint: String(n + 2).repeat(64), coverageState: n === 1 ? 'COMPLETE' : 'BACKFILL_PENDING', contributionCount: n - 1 }));
  const approvalBytesFor = item => Buffer.from(JSON.stringify({ approvalRef: 'synthetic-approval', attempt: 1, executionKey: item.executionKey }) + '\n');
  const events = packages.flatMap((item, i) => {
    const approvalBytes = approvalBytesFor(item), pending = { index: i + 1, executionKey: item.executionKey,
      businessPackageSha256: item.sha256, approvalSha256: sha(approvalBytes), businessFingerprint: 'f'.repeat(64) };
    const receipt = { subjectUserId: item.userId, executionKey: item.executionKey, businessFingerprint: pending.businessFingerprint,
      businessPackageSha256: item.sha256, coverageFingerprint: item.coverageFingerprint, coverageState: item.coverageState,
      inserted: item.contributionCount, replayed: 0, execution: { approvalRef: 'synthetic-approval', attempt: 1 } };
    return [inlineGrowthIntent(pending, approvalBytes), { event: 'COMMIT_ACK', ...pending, commitAck: true, reply: { replayed: false, receipt } }];
  });
  const store = rows => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  store(events); syncInlineGrowthLog(file);
  const proof = await verifyInlineGrowthLog(file, { packages, startIndex: 0, approvalBytesFor });
  assert.deepEqual([proof.status, proof.completed, proof.lines], ['INLINE_INTENTS_AND_ACKS_VERIFIED', 2, 4]);
  assert.equal(proof.sha256, await digestInlineGrowthLog(file));
  store(events.slice(2)); assert.equal((await verifyInlineGrowthLog(file, { packages, startIndex: 1, approvalBytesFor })).completed, 1);
  const invalid = [events.slice(0, -1), [events[1], events[0], ...events.slice(2)],
    [{ ...events[0], approvalBytesBase64: Buffer.from('different').toString('base64') }, ...events.slice(1)],
    [events[0], { ...events[1], reply: { ...events[1].reply, replayed: true } }, ...events.slice(2)],
    [events[0], { ...events[1], reply: { ...events[1].reply, receipt: { ...events[1].reply.receipt, subjectUserId: 'other' } } }, ...events.slice(2)]];
  for (const rows of invalid) { store(rows); await assert.rejects(verifyInlineGrowthLog(file, { packages, startIndex: 0, approvalBytesFor })); }
  store(events); writeFileSync(file, readFileSync(file).subarray(0, -1));
  await assert.rejects(verifyInlineGrowthLog(file, { packages, startIndex: 0, approvalBytesFor }), /GROWTH_INLINE_LOG_INCOMPLETE/);
  assert.throws(() => inlineGrowthIntent({ approvalSha256: '0'.repeat(64) }, Buffer.from('different')), /GROWTH_INLINE_APPROVAL_CHANGED/);
});

test('growth query counters use bounded categories and never return SQL or parameter values', () => {
  const examples = [
    ['BEGIN READ ONLY','TRANSACTION'], ['SELECT /* credit-init-window */ clock_timestamp()','AUTHORIZATION'],
    ['SELECT * FROM zzsh_auth_admin."user" WHERE id=$1','AUTHORIZATION'],
    ['SELECT * FROM zzsh_supply.idempotency_record WHERE key=$1','IDEMPOTENCY'],
    ['SELECT * FROM zzsh_iam.membership_growth_legacy_coverage','COVERAGE'],
    ['INSERT INTO zzsh_iam.membership_growth_contribution VALUES ($1)','CONTRIBUTION'],
    ['INSERT INTO zzsh_iam.audit_event VALUES ($1)','AUDIT'],
    ['SELECT * FROM pg_control_system()','TARGET_CHECK'], ['SELECT $1','OTHER'],
  ];
  const counts={};
  for (const [sql,expected] of examples) {
    const category=growthQueryCategory({text:sql,values:['synthetic-private-value']});
    assert.equal(category,expected); counts[category]=(counts[category]??0)+1;
  }
  assert.equal(Object.values(counts).reduce((sum,count)=>sum+count,0),examples.length);
  assert(!JSON.stringify(counts).includes('synthetic-private-value'));
});

test('packed growth packages preserve individual bytes and reject layout or content drift', t => {
  const directory = mkdtempSync(join(tmpdir(), 'zzsh-growth-packs-'));
  const paths = ['packages/00001.bin', 'packages/00002.bin'].map(file => join(directory, file));
  t.after(() => {
    for (const path of paths) if (existsSync(path)) {
      assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
      unlinkSync(path);
    }
    if (existsSync(join(directory, 'packages'))) rmdirSync(join(directory, 'packages'));
    rmdirSync(directory);
  });
  const items = Array.from({ length: 1001 }, (_, index) => {
    const bytes = JSON.stringify({ synthetic: index, value: '示例🙂' });
    return { bytes, sha256: sha(bytes), userId: `user-${index}`, executionKey: `key-${index}`,
      prepared: { coverageState: 'COMPLETE', fingerprint: sha(bytes), rows: [] }, projection: null };
  });
  const result = writeGrowthPackagePacks(directory, items);
  const plan = { schema: 'zzsh.local-growth-round-plan.v2', ...result };
  assert.deepEqual(result.packs.map(pack => pack.count), [1000, 1]);
  assert.equal(validateGrowthPackageLayout(plan), true);
  assert.equal(validateGrowthPackageEntries(plan), true);
  const reader = openGrowthPackageReader(plan, file => join(directory, file));
  try {
    verifyGrowthPackageBytes(plan, reader.read);
    for (const index of [0, 1, 999, 1000]) {
      const item = plan.packages[index];
      assert.equal(reader.read(item.file, item.offset, item.length).toString(), items[index].bytes);
      assert.equal(item.executionKey, items[index].executionKey);
    }
    const gap = structuredClone(plan); gap.packages[1].offset++;
    assert.throws(() => validateGrowthPackageLayout(gap), /GROWTH_PACK_LAYOUT_INVALID/);
    const duplicate = structuredClone(plan); duplicate.packages[1000].executionKey=duplicate.packages[0].executionKey;
    assert.throws(() => validateGrowthPackageEntries(duplicate), /GROWTH_PACKAGE_ENTRIES_INVALID/);
    const wrongDigest = structuredClone(plan); wrongDigest.packs[0].sha256 = '0'.repeat(64);
    assert.throws(() => verifyGrowthPackageBytes(wrongDigest, reader.read), /GROWTH_PACK_SHA_MISMATCH/);
    const original = readFileSync(paths[1]);
    const corrupted = Buffer.from(original); corrupted[0] ^= 1; writeFileSync(paths[1], corrupted);
    assert.throws(() => verifyGrowthPackageBytes(plan, reader.read), /ROUND_GROWTH_PACKAGE_SHA_MISMATCH/);
    reader.close();
    writeFileSync(paths[1], original.subarray(0, original.length - 1));
    assert.throws(() => reader.read(plan.packages[1000].file, 0, original.length), /GROWTH_PACK_SIZE_CHANGED/);
  } finally { reader.close(); }
  assert.throws(() => openGrowthPackageReader({ schema: 'unknown' }, () => ''), /GROWTH_PACK_SCHEMA_INVALID/);
});

test('verified v1 growth packages remain readable without packing', () => {
  const bytes = Buffer.from('legacy-package');
  verifyGrowthPackageBytes({ schema: 'zzsh.local-growth-round-plan.v1', packages: [{ file: 'old.json', sha256: sha(bytes) }] }, () => bytes);
  assert.throws(() => verifyGrowthPackageBytes({ schema: 'zzsh.local-growth-round-plan.v1', packages: [{ file: 'old.json', sha256: '0'.repeat(64) }] }, () => bytes), /ROUND_GROWTH_PACKAGE_SHA_MISMATCH/);
});

test('packed bytes preserve the real maintenance parser, execution key and business fingerprint',t=>{
  const require=createRequire(import.meta.url),api=new URL('../../apps/api/dist/src/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
  const {canonicalize}=require(join(api,'supply/content-hash.js')),{readLegacyGrowthMaintenanceRun}=require(join(api,'auth/membership-growth-legacy-cli.js'));
  const directory=mkdtempSync(join(tmpdir(),'zzsh-growth-parser-')),file=join(directory,'packages/00001.bin');
  t.after(()=>{if(existsSync(file)){assert(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());unlinkSync(file)}if(existsSync(join(directory,'packages')))rmdirSync(join(directory,'packages'));rmdirSync(directory)});
  const source={subjectUserId:'synthetic-subject',cutoff:'2026-10-18T00:00:00.000000Z',fromExclusive:null,sourceExtractSha256:'b'.repeat(64),
    sourceSetSha256:sha(canonicalize({subjectUserId:'synthetic-subject',cutoff:'2026-10-18T00:00:00.000000Z',fromExclusive:null,expectedSourceKeys:[]})),
    expectedSourceKeys:[],refundReviewEvidenceRefs:['SYNTHETIC_REFUND_REVIEW_NONE']};
  const business={schema:'legacy-growth-maintenance-package-v1',reason:'Synthetic package only',source:{receipt:source,inputs:[],corrections:[],
    admitted:{receiptDigests:[sha(canonicalize(source))],componentDigests:[],correctionDigests:[]},gameIdBySettlementId:{}}};
  const bytes=JSON.stringify(business),item={bytes,sha256:sha(bytes),userId:'synthetic-subject',executionKey:'legacy-growth:synthetic-cli-0001',
    prepared:{coverageState:'COMPLETE',fingerprint:'c'.repeat(64),rows:[]},projection:null};
  const packed=writeGrowthPackagePacks(directory,[item]),plan={schema:'zzsh.local-growth-round-plan.v2',...packed},reader=openGrowthPackageReader(plan,name=>join(directory,name));
  const resource={databaseName:'zzsh_test_growth_cli',databaseOid:'40000',owner:'fixture_owner',runtimeRole:'fixture_owner',bindingKind:'DATABASE_COMMENT',databaseComment:'synthetic:growth-cli:v1'};
  const approval={schema:'legacy-growth-maintenance-approval-v2',status:'APPROVED',approvalRef:'ROOT-SYNTHETIC-GROWTH-001',attempt:1,mode:'APPLY',businessPackageSha256:item.sha256,
    executionKey:item.executionKey,actor:{adminId:'synthetic-boss',sessionId:'synthetic-session'},windowStartUtc:'2026-10-20T00:00:00Z',windowEndUtc:'2026-10-20T04:00:00Z',resource};
  const approvalBytes=Buffer.from(JSON.stringify(approval)),env={LEGACY_GROWTH_ENABLED:'true',LEGACY_GROWTH_PACKAGE_FILE:'business',LEGACY_GROWTH_PACKAGE_SHA256:item.sha256,
    LEGACY_GROWTH_APPROVAL_FILE:'approval',LEGACY_GROWTH_APPROVAL_SHA256:sha(approvalBytes),LEGACY_GROWTH_MODE:'APPLY'};
  const parse=value=>readLegacyGrowthMaintenanceRun(env,path=>path==='approval'?approvalBytes:value,Date.parse('2026-10-20T01:00:00Z'),{databaseName:resource.databaseName,databaseUser:resource.runtimeRole});
  try{const original=parse(Buffer.from(bytes)),entry=plan.packages[0],repacked=parse(reader.read(entry.file,entry.offset,entry.length));
    assert.equal(repacked.input.executionKey,original.input.executionKey);assert.equal(repacked.input.businessPackageSha256,original.input.businessPackageSha256);
    assert.equal(repacked.input.businessFingerprint,original.input.businessFingerprint);assert.equal(repacked.input.businessPackageBytes,original.input.businessPackageBytes);
    const intent=inlineGrowthIntent({index:1,executionKey:item.executionKey,approvalSha256:sha(approvalBytes)},approvalBytes),originalApproval=Buffer.from(intent.approvalBytesBase64,'base64');
    const restored=readLegacyGrowthMaintenanceRun(env,path=>path==='approval'?originalApproval:Buffer.from(bytes),Date.parse('2026-10-20T01:00:00Z'),{databaseName:resource.databaseName,databaseUser:resource.runtimeRole});
    assert.equal(restored.input.executionKey,original.input.executionKey);assert.equal(restored.input.businessFingerprint,original.input.businessFingerprint);
    assert.equal(restored.input.execution.approvalDigest,original.input.execution.approvalDigest);
  }finally{reader.close()}
});
