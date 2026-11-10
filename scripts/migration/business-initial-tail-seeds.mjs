import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { INITIAL_SEED_TABLES, assertCanonicalSeedProof } from './business-initial-seeds.mjs';

export const {matchesKnown0155LineEndings}=createRequire(import.meta.url)('../../apps/api/src/database/business-migration-compat.ts');
const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// The 0174 proof remains immutable. Changes to later seed content require review.
export const POST_TAIL_SEED_TABLES=new Set([...INITIAL_SEED_TABLES,'zzsh_order.opening_auto_confirm_policy']);

/** Check the independently established seed state against its frozen source prefix. */
export function assertInitialTailSeedProof(baseline,baselineProofBytes,journalBytes,migrationHashes,proof,readMigration){
  const baselineProof=JSON.parse(baselineProofBytes.toString('utf8')),journal=JSON.parse(journalBytes.toString('utf8'));
  assertCanonicalSeedProof(baselineProof,baseline.sourceChain);
  const baselineDocument=baseline.documents?.find(item=>item.file==='CANONICAL-SEED-PROOF.json');
  assert(baselineDocument?.sha256===sha(baselineProofBytes),'INITIAL_BASELINE_SEED_PROOF_CHANGED');
  assert(Array.isArray(journal.entries)&&journal.entries.length>=baseline.sourceCount,'INITIAL_TAIL_JOURNAL_INVALID');
  const chain=journal.entries.map((entry,index)=>{
    assert(entry.idx===index&&Number.isSafeInteger(entry.when)&&entry.when>0&&(index===0||entry.when>journal.entries[index-1].when)
      &&typeof entry.tag==='string'&&new RegExp('^'+String(index).padStart(4,'0')+'_[a-z0-9_]+$').test(entry.tag),'INITIAL_TAIL_JOURNAL_INVALID');
    let hash=migrationHashes[`business/${entry.tag}.sql`];assert(digest(hash),'INITIAL_TAIL_MIGRATION_MISSING');
    const source=baseline.sourceChain[index];
    if(source&&source.sha256!==hash&&typeof readMigration==='function'){
      const bytes=readMigration(entry.tag);
      if(Buffer.isBuffer(bytes)&&sha(bytes)===hash&&matchesKnown0155LineEndings(entry.tag,String(entry.when),bytes,source.sha256))hash=source.sha256;
    }
    return {tag:entry.tag,when:entry.when,sha256:hash};
  });
  assert.deepEqual(chain.slice(0,baseline.sourceCount),baseline.sourceChain,'INITIAL_TAIL_BASELINE_CHANGED');
  assert(proof?.schema==='zzsh.initial-seed-contract.v1'&&proof.baseline===baseline.baseline&&proof.baselineMigrationHash===baseline.migrationHash
    &&proof.baselineSeedProofSha256===sha(baselineProofBytes),'INITIAL_TAIL_PROOF_MISMATCH');
  const reference=proof.reference;
  assert(reference?.method==='INDEPENDENT_CANONICAL_REPLAY'&&Number.isSafeInteger(reference.sourceCount)
    &&reference.sourceCount>=baseline.sourceCount&&reference.sourceCount<=chain.length
    &&reference.sourceChainSha256===sha(JSON.stringify(chain.slice(0,reference.sourceCount)))
    &&reference.through===chain[reference.sourceCount-1]?.tag,'INITIAL_TAIL_REFERENCE_MISMATCH');
  const names=Object.keys(proof.tables??{}).sort(),expected=[...POST_TAIL_SEED_TABLES].sort();
  assert.deepEqual(names,expected,'INITIAL_TAIL_SEED_TABLES_MISMATCH');
  for(const name of names){const row=proof.tables[name];assert(Number.isSafeInteger(row?.count)&&row.count>=0&&digest(row.sha256),'INITIAL_TAIL_SEED_PROOF_INVALID');}
  return proof.tables;
}

/** The stable seed contract is part of the approved release and sealed inputs. */
export function loadInitialTailSeedProof(migrationRoot,baseline,baselineProofBytes,journalBytes,migrationHashes){
  assert(typeof baseline?.baseline==='string'&&/^release_[a-zA-Z0-9_]{1,60}$/.test(baseline.baseline),'INITIAL_TAIL_BASELINE_INVALID');
  const name=`${baseline.baseline}.json`,key=`initial/seed-contracts/${name}`;
  assert(digest(migrationHashes?.[key]),'INITIAL_TAIL_PROOF_REQUIRED');
  const bytes=readFileSync(join(migrationRoot,'initial/seed-contracts',name));
  assert.equal(sha(bytes),migrationHashes[key],'INITIAL_TAIL_PROOF_CHANGED');
  const proof=JSON.parse(bytes.toString('utf8'));
  const tables=assertInitialTailSeedProof(baseline,baselineProofBytes,journalBytes,migrationHashes,proof,
    tag=>readFileSync(join(migrationRoot,'business',tag+'.sql')));
  return {tables,sha256:sha(bytes)};
}
