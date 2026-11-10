import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSealedTools, readEmptyListedTarget, scanEmptyListedSource } from './readback-empty-legacy-listed.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function sourceFixture(rows){
  const dir=mkdtempSync(join(tmpdir(),'zzsh-empty-listed-')),file=join(dir,'accounts.jsonl');
  const bytes=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';writeFileSync(file,bytes);
  return {file,entry:{file:'accounts.jsonl',rows:rows.length,sha256:sha(bytes)},cleanup:()=>{unlinkSync(file);rmdirSync(dir);}};
}

test('empty listed tools must each be bound to the source manifest',()=>{
  const path='scripts/migration/readback-empty-legacy-listed.mjs',digest='a'.repeat(64);
  const manifest={schema:'zzsh.round07-source-snapshot.v1',files:[{path,sha256:digest}]};
  assert.doesNotThrow(()=>assertSealedTools(manifest,{[path]:digest}));
  for(const files of [[],[{path,sha256:'b'.repeat(64)}],[manifest.files[0],manifest.files[0]]])
    assert.throws(()=>assertSealedTools({...manifest,files},{[path]:digest}),/EMPTY_LISTED_TOOL_NOT_SEALED/);
  assert.throws(()=>assertSealedTools({files:manifest.files},{[path]:digest}),/EMPTY_LISTED_SOURCE_MANIFEST_INVALID/);
});

test('empty listed source is proven from the entire captured and hashed stream',async()=>{
  const fixture=sourceFixture([{id:'1',status:'4',is_delete:'0'},{id:'2',status:'3',is_delete:'1'}]);
  try{
    assert.deepEqual(await scanEmptyListedSource(fixture.file,fixture.entry),{capturedAccounts:2,listedAccounts:0});
    await assert.rejects(scanEmptyListedSource(fixture.file,{...fixture.entry,sha256:'0'.repeat(64)}),/EMPTY_LISTED_SOURCE_CHANGED/);
    await assert.rejects(scanEmptyListedSource(fixture.file,{...fixture.entry,rows:1}),/EMPTY_LISTED_SOURCE_CHANGED/);
    await assert.rejects(scanEmptyListedSource(fixture.file,{...fixture.entry,file:'other'}),/EMPTY_LISTED_SOURCE_ENTRY_INVALID/);
  }finally{fixture.cleanup();}
  for(const rows of [[{id:'1',status:'3',is_delete:'0'}],[{id:'1',status:'?',is_delete:'0'}],
    [{id:'1',status:'4',is_delete:'0'},{id:'1',status:'4',is_delete:'0'}]]){
    const invalid=sourceFixture(rows);
    try{await assert.rejects(scanEmptyListedSource(invalid.file,invalid.entry));}finally{invalid.cleanup();}
  }
});

test('empty source still requires both target observations and publications to be empty',async()=>{
  const client=rows=>({query:async sql=>{assert.match(sql,/legacy_listing_read_snapshot/);assert.match(sql,/listing_publication/);return {rows};}});
  assert.deepEqual(await readEmptyListedTarget(client([{observations:'0',publications:'0'}])),
    {status:'EMPTY_LISTED_TARGET_READBACK_PASSED',listedObservations:'0',mappedAccountPublications:'0'});
  for(const row of [{observations:'1',publications:'0'},{observations:'0',publications:'1'}])
    assert.equal((await readEmptyListedTarget(client([row]))).status,'EMPTY_LISTED_TARGET_REVIEW_REQUIRED');
  for(const rows of [[],[{observations:null,publications:'0'}],[{observations:0,publications:'0'}],[{},{}]])
    await assert.rejects(readEmptyListedTarget(client(rows)),/EMPTY_LISTED_TARGET_UNAVAILABLE/);
});

test('empty listed command is read-only plan by default and refuses unbound execution',()=>{
  const script=fileURLToPath(new URL('./readback-empty-legacy-listed.mjs',import.meta.url));
  const plan=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000});assert.equal(plan.status,0,plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).status,'PLAN_ONLY');
  const unbound=spawnSync(process.execPath,[script,'--readback'],{encoding:'utf8',timeout:5000});
  assert.notEqual(unbound.status,0);assert.match(unbound.stderr,/EMPTY_LISTED_ARGUMENTS_INVALID/);
  const duplicate=spawnSync(process.execPath,[script,'--readback','--input','a','--input','b','--maintenance-password-file','c','--out','d'],{encoding:'utf8',timeout:5000});
  assert.notEqual(duplicate.status,0);assert.match(duplicate.stderr,/EMPTY_LISTED_ARGUMENTS_INVALID/);
});

test('empty listed query fails closed for hidden target rows in synthetic PostgreSQL', {skip:!process.env.ZZSH_SYNTH_EMPTY_LISTED_PORT},async()=>{
  const port=process.env.ZZSH_SYNTH_EMPTY_LISTED_PORT,system=process.env.ZZSH_SYNTH_EMPTY_LISTED_SYSTEM;
  assert.match(port??'',/^[1-9][0-9]{3,4}$/);assert.match(system??'',/^[0-9]+$/);
  const {Client}=createRequire(import.meta.url)('pg'),client=new Client({host:'127.0.0.1',port:Number(port),
    database:'zzsh_synth_empty_listed',user:'postgres',connectionTimeoutMillis:3000});
  await client.connect();let transaction=false;
  try{
    const identity=(await client.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
      shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
    assert.deepEqual(identity,{database:'zzsh_synth_empty_listed',system,marker:'zzsh:synthetic:empty-listed-v1',schemas:0});
    await client.query('BEGIN');transaction=true;
    await client.query(`CREATE SCHEMA zzsh_supply;
      CREATE TABLE zzsh_supply.legacy_listing_read_snapshot(source_system text,source_entity text,source_status integer);
      CREATE TABLE zzsh_supply.legacy_supply_map(source_system text,source_entity text,account_id text);
      CREATE TABLE zzsh_supply.listing_publication(account_id text,source text);
      CREATE ROLE zzsh_synth_empty_reader NOLOGIN;GRANT USAGE ON SCHEMA zzsh_supply TO zzsh_synth_empty_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA zzsh_supply TO zzsh_synth_empty_reader;`);
    await client.query('SET LOCAL ROLE zzsh_synth_empty_reader');await client.query('SET LOCAL row_security=off');
    assert.equal((await readEmptyListedTarget(client)).status,'EMPTY_LISTED_TARGET_READBACK_PASSED');
    await client.query('RESET ROLE');
    await client.query("INSERT INTO zzsh_supply.legacy_listing_read_snapshot VALUES ('legacy_mysql_restore','la_rental_accounts',3)");
    await client.query('SET LOCAL ROLE zzsh_synth_empty_reader');
    assert.equal((await readEmptyListedTarget(client)).status,'EMPTY_LISTED_TARGET_REVIEW_REQUIRED');
    await client.query('RESET ROLE');await client.query('DELETE FROM zzsh_supply.legacy_listing_read_snapshot');
    await client.query("INSERT INTO zzsh_supply.legacy_supply_map VALUES ('legacy_mysql_restore','la_rental_accounts','account')");
    await client.query("INSERT INTO zzsh_supply.listing_publication VALUES ('account','OWNER_DIRECT')");
    await client.query('SET LOCAL ROLE zzsh_synth_empty_reader');
    assert.equal((await readEmptyListedTarget(client)).status,'EMPTY_LISTED_TARGET_REVIEW_REQUIRED');
    await client.query('RESET ROLE');await client.query('ALTER TABLE zzsh_supply.legacy_listing_read_snapshot ENABLE ROW LEVEL SECURITY');
    await client.query('SET LOCAL ROLE zzsh_synth_empty_reader');await client.query('SAVEPOINT rls_check');
    await assert.rejects(readEmptyListedTarget(client),error=>error.code==='42501');
    await client.query('ROLLBACK TO SAVEPOINT rls_check');
  }finally{
    if(transaction)assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');
    await client.end();
  }
});
