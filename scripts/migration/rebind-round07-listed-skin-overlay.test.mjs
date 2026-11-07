import assert from 'node:assert/strict';import { spawnSync } from 'node:child_process';import { fileURLToPath } from 'node:url';import test from 'node:test';
import { rebindOverlay } from './rebind-round07-listed-skin-overlay.mjs';
test('overlay rebind preserves reviewed mapping while replacing only source and catalog binding',()=>{
 const original={schema:'legacy-skin-exact-mapping.v2',version:'v',reviewRef:'review',sourceReceiptSha256:'old',sourceExtractSha256:'old',sourceDictionarySha256:'old',gameId:'g',catalogRevision:'1',mappings:[{field:'knife_skin',token:'fixture'}]};
 const before=structuredClone(original),next=rebindOverlay(original,{sourceReceiptSha256:'new',sourceExtractSha256:'new-extract',sourceDictionarySha256:'new-dict',gameId:'g',catalogRevision:'2'});
 assert.deepEqual(original,before);assert.deepEqual(next.mappings,before.mappings);assert.equal(next.reviewRef,before.reviewRef);assert.equal(next.sourceReceiptSha256,'new');assert.equal(next.catalogRevision,'2');
});
test('overlay rebind defaults to a no-write plan',()=>{const r=spawnSync(process.execPath,[fileURLToPath(new URL('./rebind-round07-listed-skin-overlay.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,0);const x=JSON.parse(r.stdout);assert.equal(x.targetWrites,0);});
