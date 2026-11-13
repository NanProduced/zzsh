import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertInitialTailSeedProof, loadInitialTailSeedProof, POST_TAIL_SEED_TABLES } from './business-initial-tail-seeds.mjs';
import { initialSeedRowsDigest } from './business-initial-seeds.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'../../apps/api/migrations');
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=path=>readFileSync(join(root,path));
const baseline=JSON.parse(read('initial/release_production_0174/manifest.json'));
const baselineProof=read('initial/release_production_0174/CANONICAL-SEED-PROOF.json');
const journalBytes=read('business/meta/_journal.json'),journal=JSON.parse(journalBytes);
const proofKey=`initial/seed-contracts/${baseline.baseline}.json`;
const proof=JSON.parse(read(proofKey));
const hashes=Object.fromEntries(journal.entries.map(row=>[`business/${row.tag}.sql`,sha(read(`business/${row.tag}.sql`))]));
hashes[proofKey]=sha(read(proofKey));

test('stable seed contract binds the independent reference and immutable 0174 baseline',()=>{
 const tables=assertInitialTailSeedProof(baseline,baselineProof,journalBytes,hashes,proof);
 assert.deepEqual(Object.keys(tables).sort(),[...POST_TAIL_SEED_TABLES].sort());
 assert.deepEqual(loadInitialTailSeedProof(root,baseline,baselineProof,journalBytes,hashes).tables,tables);
 assert.equal(proof.reference.through,'0188_poststart_support_cancel');
 const opening={singleton:true,wait_minutes:40,revision:1,updated_by_admin_id:null};
 assert.equal(tables['zzsh_order.opening_auto_confirm_policy'].sha256,initialSeedRowsDigest([opening]));
});

test('any added tail requires a reviewed target proof before initialization',()=>{
 const entry={idx:journal.entries.length,version:'7',when:journal.entries.at(-1).when+1,tag:String(journal.entries.length).padStart(4,'0')+'_unrelated_shape',breakpoints:true};
 const extended=Buffer.from(JSON.stringify({...journal,entries:[...journal.entries,entry]}));
 const next={...hashes,[`business/${entry.tag}.sql`]:'f'.repeat(64)};
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,extended,next,proof),/INITIAL_TAIL_TARGET_REVIEW_REQUIRED/);
 assert.throws(()=>loadInitialTailSeedProof(root,baseline,baselineProof,extended,next),/INITIAL_TAIL_TARGET_REVIEW_REQUIRED/);
 const chain=[...journal.entries,entry].map(item=>({tag:item.tag,when:item.when,sha256:next[`business/${item.tag}.sql`]}));
 const reviewed={...proof,reviewedTarget:{method:'INITIAL_PLUS_TAIL_READBACK',sourceCount:chain.length,
   through:entry.tag,sourceChainSha256:sha(JSON.stringify(chain))}};
 assert.deepEqual(assertInitialTailSeedProof(baseline,baselineProof,extended,next,reviewed),proof.tables);
});

test('missing files, changed reference or baseline and malformed journal fail closed',()=>{
 const missing={...hashes};delete missing[`business/${journal.entries.at(-1).tag}.sql`];
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,journalBytes,missing,proof),/INITIAL_TAIL_MIGRATION_MISSING/);
 const changed={...hashes,[`business/${proof.reference.through}.sql`]:'0'.repeat(64)};
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,journalBytes,changed,proof),/INITIAL_TAIL_REFERENCE_MISMATCH/);
 const changedTail={...hashes,[`business/${journal.entries.at(-1).tag}.sql`]:'0'.repeat(64)};
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,journalBytes,changedTail,proof),/INITIAL_TAIL_TARGET_REVIEW_REQUIRED/);
 for(const changedTarget of [null,{...proof.reviewedTarget,sourceCount:proof.reviewedTarget.sourceCount-1},
  {...proof.reviewedTarget,sourceChainSha256:'0'.repeat(64)},{...proof.reviewedTarget,through:proof.reference.through}])
  assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,journalBytes,hashes,{...proof,reviewedTarget:changedTarget}),/INITIAL_TAIL_TARGET_REVIEW_REQUIRED/);
 const reordered=structuredClone(journal);[reordered.entries[178],reordered.entries[179]]=[reordered.entries[179],reordered.entries[178]];
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,Buffer.from(JSON.stringify(reordered)),hashes,proof),/INITIAL_TAIL_JOURNAL_INVALID/);
 assert.throws(()=>assertInitialTailSeedProof(baseline,Buffer.concat([baselineProof,Buffer.from(' ')]),journalBytes,hashes,proof),/INITIAL_BASELINE_SEED_PROOF_CHANGED/);
 const unsealed={...hashes};delete unsealed[proofKey];
 assert.throws(()=>loadInitialTailSeedProof(root,baseline,baselineProof,journalBytes,unsealed),/INITIAL_TAIL_PROOF_REQUIRED/);
});

test('only the runner-approved 0155 LF/CRLF pair matches the baseline reference',()=>{
 const tag='0155_legacy_rental_distribution_policy',lf=read(`business/${tag}.sql`).toString('utf8').replace(/\r\n/g,'\n');
 const crlf=Buffer.from(lf.replace(/\n/g,'\r\n')),alternate={...hashes,[`business/${tag}.sql`]:sha(crlf)};
 assert.deepEqual(assertInitialTailSeedProof(baseline,baselineProof,journalBytes,alternate,proof,name=>name===tag?crlf:read(`business/${name}.sql`)),proof.tables);
 const changed=Buffer.concat([crlf,Buffer.from('-- changed')]),altered={...hashes,[`business/${tag}.sql`]:sha(changed)};
 assert.throws(()=>assertInitialTailSeedProof(baseline,baselineProof,journalBytes,altered,proof,name=>name===tag?changed:read(`business/${name}.sql`)),/INITIAL_TAIL_BASELINE_CHANGED/);
});
