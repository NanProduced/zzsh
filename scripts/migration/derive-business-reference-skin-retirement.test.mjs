import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildSkinRetirementPackage,deriveSkinRetirement,verifySkinRetirementPackage} from './derive-business-reference-skin-retirement.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(change=()=>{}){
 const values={game:[{id:'g1',code:'delta'}],skin_category:[{id:'c1',game_id:'g1',parent_id:null,name:'Old agent'},{id:'c2',game_id:'g1',parent_id:'c1',name:'Old subtype'}],
  skin_owner:[{id:'o1',game_id:'g1',kind:'AGENT',enabled:true},{id:'o2',game_id:'g1',kind:'MELEE_TYPE',enabled:false}],
  skin:[{id:'s1',game_id:'g1',category_id:'c1',owner_kind:'AGENT',owner_id:'o1'},
        {id:'s2',game_id:'g1',category_id:'c2',owner_kind:null,owner_id:null}]};change(values);
 const files=new Map(),tables=[];
 for(const [name,rows] of Object.entries(values)){
  const data={schema:'zzsh_supply',table:name,columns:(name==='skin'?['id','game_id','category_id','owner_kind','owner_id']:['id']).map(name=>({name})),
   primaryKey:['id'],rows:rows.map(x=>JSON.stringify(x))};
  if(name==='skin')data.rows[0]=data.rows[0].replace(/}$/ ,',"unsafeCounter":9007199254740993}');
  const file='zzsh_supply.'+name+'.json',bytes=Buffer.from(JSON.stringify(data)+'\n');files.set(file,bytes);tables.push({schema:'zzsh_supply',table:name,file,rows:rows.length,sourceRows:String(rows.length),sha256:sha(bytes)});
 }
 const manifest=Buffer.from(JSON.stringify({kind:'BUSINESS_REFERENCE_PACKAGE_V1',gameCode:'delta',sourceRawUnchanged:false,transactionRollback:true,clientClosed:true,tables,
  foreignKeys:[{child:'zzsh_supply.skin_category',parent:'zzsh_supply.game',columns:['game_id'],parentColumns:['id']},
   {child:'zzsh_supply.skin_category',parent:'zzsh_supply.skin_category',columns:['parent_id'],parentColumns:['id']},
   {child:'zzsh_supply.skin',parent:'zzsh_supply.skin_category',columns:['category_id'],parentColumns:['id']}]})+'\n');
 return{manifest,files,run(){return deriveSkinRetirement(manifest,files,sha(manifest));}};
}
test('preserves exact category/owner evidence, removes the unused table and only its skin field',()=>{
 const f=fixture(),original=Buffer.from(f.files.get('zzsh_supply.skin.json')),r=f.run(),m=JSON.parse(r.manifest),s=JSON.parse(r.skinBytes),o=JSON.parse(r.ownerBytes),e=JSON.parse(r.evidenceBytes);
 assert.deepEqual(r.counts,{categories:2,skins:2,removedMeleeOwners:1,retainedOwners:1});assert.equal(m.catalogModel,'OWNER_KIND_V2');assert.equal(m.sourceRawUnchanged,false);
 assert(!m.tables.some(x=>x.table==='skin_category'));assert(!m.foreignKeys.some(x=>x.child==='zzsh_supply.skin_category'||x.parent==='zzsh_supply.skin_category'));
 assert(s.rows.every(raw=>!Object.hasOwn(JSON.parse(raw),'category_id')));assert(s.rows[0].includes('9007199254740993'));assert.equal(JSON.parse(s.rows[1]).owner_kind,null);
 assert.deepEqual(o.rows.map(JSON.parse).map(x=>x.kind),['AGENT']);assert.equal(e.categories.length,2);assert.equal(e.memberships.length,2);
 assert.equal(e.memberships[0].categoryId,'c1');assert.equal(e.memberships[0].sourceRowSha256,sha(e.memberships[0].sourceRow));assert.equal(e.sourceManifestSha256,sha(f.manifest));assert.equal(m.catalogRetirementEvidenceSha256,sha(r.evidenceBytes));
 assert.equal(e.status,'SEALED_SOURCE_EVIDENCE');assert.equal(m.catalogRetirementSourceManifestSha256,e.sourceManifestSha256);assert.deepEqual(e.counts,r.counts);
 assert.equal(m.catalogRetirementEvidenceFile,'lineage-'+m.catalogRetirementEvidenceSha256+'.json');
 assert.deepEqual(f.files.get('zzsh_supply.skin.json'),original);
});
test('refuses tampered input and unknown category dependencies',()=>{
 const f=fixture();assert.throws(()=>deriveSkinRetirement(f.manifest,f.files,'0'.repeat(64)),/SOURCE_MANIFEST_SHA_MISMATCH/);
 f.files.set('zzsh_supply.skin.json',Buffer.from('bad'));assert.throws(()=>f.run(),/SOURCE_TABLE_SHA_MISMATCH/);
 const g=fixture(),m=JSON.parse(g.manifest);m.foreignKeys.push({child:'zzsh_order.unknown',parent:'zzsh_supply.skin_category',columns:['category_id'],parentColumns:['id']});const b=Buffer.from(JSON.stringify(m));
 assert.throws(()=>deriveSkinRetirement(b,g.files,sha(b)),/UNKNOWN_CATEGORY_DEPENDENCY/);
});
test('refuses cross-game, dangling or cyclic source data rather than inventing a mapping',()=>{
 for(const change of [x=>x.skin[0].game_id='g2',x=>x.skin[0].category_id='missing',x=>x.skin_category[0].parent_id='c2',x=>x.skin[1].id='s1'])
  assert.throws(()=>fixture(change).run());
});
test('refuses an active or still referenced melee parent and retains unknown skin identity',()=>{
 for(const change of [x=>x.skin_owner[1].enabled=true,x=>x.skin[0].owner_id='o2'])assert.throws(()=>fixture(change).run(),/MELEE_OWNER_STILL_ACTIVE_OR_REFERENCED/);
 assert.equal(JSON.parse(JSON.parse(fixture().run().skinBytes).rows[1]).owner_kind,null);
});

test('refuses a retired melee owner referenced by another packaged table',()=>{
 const f=fixture(v=>v.game[0].owner_ref='o2'),manifest=JSON.parse(f.manifest);
 manifest.foreignKeys.push({child:'zzsh_supply.game',parent:'zzsh_supply.skin_owner',columns:['owner_ref'],parentColumns:['id']});
 const bytes=Buffer.from(JSON.stringify(manifest));
 assert.throws(()=>deriveSkinRetirement(bytes,f.files,sha(bytes)),/MELEE_OWNER_STILL_REFERENCED/);
});

test('the derived package retains and independently recomputes its source lineage',()=>{
 const f=fixture(),original=new Map(f.files);original.set('profit-decision-'+sha('policy')+'.json',Buffer.from('policy'));
 const {derived,files}=buildSkinRetirementPackage(f.manifest,original,sha(f.manifest));
 assert.deepEqual(verifySkinRetirementPackage(derived.manifest,name=>files.get(name)),derived.counts);
 assert(files.get('lineage-'+sha(f.manifest)+'.json').equals(f.manifest));
 assert(files.get('profit-decision-'+sha('policy')+'.json').equals(Buffer.from('policy')));
 for(const name of [JSON.parse(derived.manifest).catalogRetirementEvidenceFile,'lineage-'+sha(f.manifest)+'.json','zzsh_supply.skin.json']){
  const broken=new Map(files);broken.set(name,Buffer.from('{}'));
  assert.throws(()=>verifySkinRetirementPackage(derived.manifest,n=>broken.get(n)));
 }
 const changed=JSON.parse(derived.manifest);changed.gameCode='other';
 assert.throws(()=>verifySkinRetirementPackage(Buffer.from(JSON.stringify(changed)+'\n'),name=>files.get(name)),/SKIN_DERIVED_MANIFEST_MISMATCH/);
});
