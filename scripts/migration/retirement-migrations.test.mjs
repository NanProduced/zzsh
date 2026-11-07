import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const file = name => readFileSync(new URL('../../apps/api/migrations/business/'+name,import.meta.url),'utf8');

test('R07 forward migrations are registered after the existing distribution migration',()=>{
  const journal=JSON.parse(file('meta/_journal.json')),tail=journal.entries.filter(row=>row.idx>=158&&row.idx<=161);
  assert.deepEqual(tail.map(row=>row.tag),['0158_distribution_admin_management','0159_retire_skin_categories','0160_remove_legacy_listing_deposit','0161_distribution_relation_guard_indexed']);
  assert.deepEqual(tail.map(row=>row.idx),[158,159,160,161]);
  assert(tail.every((row,i)=>i===0||tail[i-1].when<row.when));
  for(const row of tail)assert(file(row.tag+'.sql').length>0);
  const settlement=journal.entries.filter(row=>row.idx>=162&&row.idx<=172);
  assert.equal(settlement.length,11);
  assert(settlement.every((row,i)=>row.idx===162+i&&row.tag.startsWith(String(row.idx).padStart(4,'0')+'_')&&row.when>(i?settlement[i-1].when:tail.at(-1).when)));
  for(const row of settlement)assert(file(row.tag+'.sql').length>0);
});

test('R07 retirements fail closed on populated evidence and preserve new guarantee tables',()=>{
  const skin=file('0159_retire_skin_categories.sql'),deposit=file('0160_remove_legacy_listing_deposit.sql');
  for(const sql of [skin,deposit])assert.doesNotMatch(sql.replace(/--[^\r\n]*/g,''),/\bCASCADE\b/i);
  assert.match(skin,/SKIN_CATEGORY_NONEMPTY_REQUIRES_ARCHIVE_PLAN/);
  assert.match(skin,/SKIN_CATEGORY_SCHEMA_INCOMPLETE/);
  assert.doesNotMatch(skin,/skin_category_archive_sha256/);
  assert.match(deposit,/LEGACY_LISTING_DEPOSIT_NONEMPTY_REQUIRES_ARCHIVE_PLAN/);
  for(const name of ['legacy_owner_guarantee_observation','legacy_owner_guarantee_coverage'])assert.match(deposit,new RegExp(`SELECT 1 FROM zzsh_order\\.${name}`));
  for(const name of ['owner_guarantee_requirement','owner_guarantee_payment','owner_guarantee_refund','account_guarantee_proof'])assert.match(deposit,new RegExp(`to_regclass\\('zzsh_(?:order|supply)\\.${name}'\\)`));
});
