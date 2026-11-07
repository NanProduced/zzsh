import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=value=>createHash('sha256').update(value).digest('hex');
const key=table=>`zzsh_supply.${table}`;
function tableBytes(manifest,files,name){
 const descriptors=manifest.tables.filter(d=>d.schema==='zzsh_supply'&&d.table===name);assert.equal(descriptors.length,1,'SOURCE_TABLE_REQUIRED');
 const d=descriptors[0],bytes=files.get(d.file);assert(Buffer.isBuffer(bytes)&&sha(bytes)===d.sha256,'SOURCE_TABLE_SHA_MISMATCH');
 const table=JSON.parse(bytes);assert(table.schema===d.schema&&table.table===d.table&&Array.isArray(table.columns)&&Array.isArray(table.rows)
  &&table.rows.length===d.rows&&table.rows.every(x=>typeof x==='string'),'SOURCE_TABLE_SHAPE_INVALID');return {descriptor:d,table};
}
export function removeCategoryField(raw){
 const parsed=JSON.parse(raw),pattern=/"category_id"\s*:\s*(?:"(?:[^"\\]|\\.)*"|null)/g,matches=[...raw.matchAll(pattern)];
 assert(Object.hasOwn(parsed,'category_id')&&matches.length===1,'SKIN_CATEGORY_SOURCE_FIELD_INVALID');
 const m=matches[0],start=m.index,end=start+m[0].length;let left=start-1;while(left>=0&&/\s/.test(raw[left]))left--;
 let removedStart=start,removedEnd=end;
 if(raw[left]===',')removedStart=left;
 else{let right=end;while(right<raw.length&&/\s/.test(raw[right]))right++;assert(raw[right]===',','SKIN_CATEGORY_FIELD_POSITION_INVALID');removedEnd=right+1;}
 const derived=raw.slice(0,removedStart)+raw.slice(removedEnd),roundtrip=derived.slice(0,removedStart)+raw.slice(removedStart,removedEnd)+derived.slice(removedStart);
 assert.equal(roundtrip,raw,'SKIN_ROW_BYTE_SCOPE_CHANGED');delete parsed.category_id;assert(isDeepStrictEqual(JSON.parse(derived),parsed),'SKIN_ROW_SEMANTIC_SCOPE_CHANGED');
 return derived;
}

/** Offline candidate only: source files stay unchanged; retained evidence preserves exact legacy membership. */
export function deriveSkinRetirement(manifestBytes,files,expectedManifestSha256){
 assert(Buffer.isBuffer(manifestBytes)&&sha(manifestBytes)===expectedManifestSha256,'SOURCE_MANIFEST_SHA_MISMATCH');
 const manifest=JSON.parse(manifestBytes);assert(manifest.kind==='BUSINESS_REFERENCE_PACKAGE_V1'&&manifest.gameCode==='delta'
  &&typeof manifest.sourceRawUnchanged==='boolean'&&manifest.transactionRollback===true&&manifest.clientClosed===true
  &&Array.isArray(manifest.tables)&&Array.isArray(manifest.foreignKeys),'SOURCE_PACKAGE_INVALID');
 const seenFiles=new Set(),seenTables=new Set();for(const d of manifest.tables){
  const name=`${d.schema}.${d.table}`;assert(typeof d.file==='string'&&!d.file.includes('/')&&!d.file.includes('\\')&&!seenFiles.has(d.file)&&!seenTables.has(name),'SOURCE_DESCRIPTOR_DUPLICATE');
  seenFiles.add(d.file);seenTables.add(name);const bytes=files.get(d.file);assert(Buffer.isBuffer(bytes)&&sha(bytes)===d.sha256,'SOURCE_TABLE_SHA_MISMATCH');
  const table=JSON.parse(bytes);assert(table.schema===d.schema&&table.table===d.table&&Array.isArray(table.rows)&&table.rows.length===d.rows,'SOURCE_TABLE_SHAPE_INVALID');
 }
 const game=tableBytes(manifest,files,'game'),categories=tableBytes(manifest,files,'skin_category'),owners=tableBytes(manifest,files,'skin_owner'),skins=tableBytes(manifest,files,'skin');
 const games=game.table.rows.map(JSON.parse);assert(games.length===1&&games[0].code==='delta'&&typeof games[0].id==='string','SINGLE_DELTA_GAME_REQUIRED');const gameId=games[0].id;
 const cats=categories.table.rows.map(JSON.parse),ownerRows=owners.table.rows.map(JSON.parse),skinRows=skins.table.rows.map(JSON.parse);
 assert(cats.every(c=>c.game_id===gameId)&&ownerRows.every(o=>o.game_id===gameId)&&skinRows.every(s=>s.game_id===gameId),'FOREIGN_GAME_REQUIRES_REVIEW');
 const catIds=new Set(cats.map(c=>c.id));assert(catIds.size===cats.length&&cats.every(c=>typeof c.id==='string'&&(c.parent_id===null||catIds.has(c.parent_id))),'CATEGORY_TREE_INVALID');
 for(const c of cats){const seen=new Set();let current=c;while(current){assert(!seen.has(current.id),'CATEGORY_TREE_CYCLE');seen.add(current.id);current=current.parent_id===null?null:cats.find(x=>x.id===current.parent_id);}}
 assert(skinRows.every(s=>typeof s.id==='string'&&typeof s.category_id==='string'&&catIds.has(s.category_id)),'SKIN_CATEGORY_MEMBERSHIP_INVALID');
 assert(new Set(skinRows.map(s=>s.id)).size===skinRows.length,'SKIN_ID_DUPLICATE');
 const badOwners=ownerRows.filter(o=>o.kind==='MELEE_TYPE');
 assert(badOwners.every(o=>o.enabled===false&&!skinRows.some(s=>s.owner_id===o.id)),'MELEE_OWNER_STILL_ACTIVE_OR_REFERENCED');
 const removed=new Set(badOwners.map(o=>o.id));assert(removed.size===badOwners.length,'MELEE_OWNER_ID_DUPLICATE');
 for(const fk of manifest.foreignKeys.filter(f=>f.parent===key('skin_owner'))){
  assert(Array.isArray(fk.columns)&&Array.isArray(fk.parentColumns)&&fk.columns.length>0&&fk.columns.length===fk.parentColumns.length,'OWNER_FOREIGN_KEY_INVALID');
  const descriptor=manifest.tables.find(d=>`${d.schema}.${d.table}`===fk.child);assert(descriptor,'OWNER_FOREIGN_KEY_SOURCE_MISSING');
  const rows=JSON.parse(files.get(descriptor.file)).rows.map(JSON.parse),removedKeys=new Set(badOwners.map(o=>JSON.stringify(fk.parentColumns.map(c=>o[c]))));
  assert(rows.every(row=>{const values=fk.columns.map(c=>row[c]);assert(values.every(v=>v!==undefined),'OWNER_FOREIGN_KEY_COLUMN_MISSING');return values.some(v=>v===null)||!removedKeys.has(JSON.stringify(values));}),'MELEE_OWNER_STILL_REFERENCED');
 }
 const relevant=manifest.foreignKeys.filter(f=>f.child===key('skin_category')||f.parent===key('skin_category'));
 assert(relevant.every(f=>(f.child===key('skin_category')&&(f.parent===key('game')||f.parent===key('skin_category')))
  ||(f.child===key('skin')&&f.parent===key('skin_category')&&JSON.stringify(f.columns)==='["category_id"]')),'UNKNOWN_CATEGORY_DEPENDENCY');
 const evidence={schema:'zzsh.skin-category-retirement-evidence.v1',status:'SEALED_SOURCE_EVIDENCE',sourceManifestSha256:expectedManifestSha256,gameId,
  counts:{categories:cats.length,skins:skinRows.length,removedMeleeOwners:badOwners.length,retainedOwners:owners.table.rows.length-badOwners.length},
  categories:categories.table.rows,removedMeleeOwners:owners.table.rows.filter((_,i)=>removed.has(ownerRows[i].id)),
  memberships:skinRows.map((s,i)=>({skinId:s.id,categoryId:s.category_id,sourceRow:skins.table.rows[i],sourceRowSha256:sha(skins.table.rows[i])}))};
 const evidenceBytes=Buffer.from(JSON.stringify(evidence)+'\n');
 assert.equal(skins.table.columns.filter(c=>c.name==='category_id').length,1,'CATEGORY_COLUMN_DESCRIPTOR_INVALID');
 const newSkin={...skins.table,columns:skins.table.columns.filter(c=>c.name!=='category_id'),rows:skins.table.rows.map(removeCategoryField)};
 const newOwners={...owners.table,rows:owners.table.rows.filter((_,i)=>!removed.has(ownerRows[i].id))};
 const skinBytes=Buffer.from(JSON.stringify(newSkin)+'\n'),ownerBytes=Buffer.from(JSON.stringify(newOwners)+'\n');
 const derived={...manifest,sourceRawUnchanged:false,catalogModel:'OWNER_KIND_V2',catalogRetirementSourceManifestSha256:expectedManifestSha256,catalogRetirementEvidenceSha256:sha(evidenceBytes),
  catalogRetirementEvidenceFile:'lineage-'+sha(evidenceBytes)+'.json',
  tables:manifest.tables.filter(d=>!(d.schema==='zzsh_supply'&&d.table==='skin_category')).map(d=>
   d===skins.descriptor?{...d,sha256:sha(skinBytes)}:d===owners.descriptor?{...d,sha256:sha(ownerBytes),rows:newOwners.rows.length}:d),
  foreignKeys:manifest.foreignKeys.filter(f=>f.child!==key('skin_category')&&f.parent!==key('skin_category'))};
 return {manifest:Buffer.from(JSON.stringify(derived)+'\n'),skinBytes,ownerBytes,evidenceBytes,
  counts:{categories:cats.length,skins:skinRows.length,removedMeleeOwners:badOwners.length,retainedOwners:newOwners.rows.length}};
}

function retainByDigest(files,bytes){
 const name='lineage-'+sha(bytes)+'.json',existing=files.get(name);
 assert(!existing||existing.equals(bytes),'LINEAGE_COLLISION');files.set(name,bytes);
}

/** Preserve the original inputs needed to independently recompute the derived package. */
export function buildSkinRetirementPackage(manifestBytes,original,expected){
 const manifest=JSON.parse(manifestBytes),derived=deriveSkinRetirement(manifestBytes,original,expected);
 const skin=manifest.tables.find(d=>d.schema==='zzsh_supply'&&d.table==='skin'),
  owner=manifest.tables.find(d=>d.schema==='zzsh_supply'&&d.table==='skin_owner'),category=manifest.tables.find(d=>d.schema==='zzsh_supply'&&d.table==='skin_category');
 const files=new Map(original);files.delete(category.file);files.delete('derivation-receipt.json');files.set('manifest.json',derived.manifest);
 for(const bytes of [manifestBytes,original.get(skin.file),original.get(owner.file),original.get(category.file),derived.evidenceBytes])retainByDigest(files,bytes);
 if(original.has('derivation-receipt.json'))retainByDigest(files,original.get('derivation-receipt.json'));
 files.set(skin.file,derived.skinBytes);files.set(owner.file,derived.ownerBytes);
 return {derived,files};
}

/** Recompute every retired category/owner/skin byte from the sealed source before credentials are read. */
export function verifySkinRetirementPackage(manifestBytes,read){
 const manifest=JSON.parse(manifestBytes),sourceSha=manifest.catalogRetirementSourceManifestSha256;
 assert(manifest.catalogModel==='OWNER_KIND_V2'&&/^[a-f0-9]{64}$/.test(sourceSha??''),'SKIN_PROFILE_INVALID');
 const sourceBytes=read('lineage-'+sourceSha+'.json');
 assert(Buffer.isBuffer(sourceBytes)&&sha(sourceBytes)===sourceSha,'SKIN_SOURCE_MANIFEST_MISMATCH');
 const source=JSON.parse(sourceBytes),original=new Map();
 assert(Array.isArray(source.tables),'SKIN_SOURCE_DESCRIPTOR_INVALID');
 for(const d of source.tables){
  assert(typeof d.file==='string'&&d.file===basename(d.file)&&/^[a-f0-9]{64}$/.test(d.sha256??''),'SKIN_SOURCE_DESCRIPTOR_INVALID');
  const retired=d.schema==='zzsh_supply'&&['skin','skin_owner','skin_category'].includes(d.table);
  const bytes=read(retired?'lineage-'+d.sha256+'.json':d.file);
  assert(Buffer.isBuffer(bytes)&&sha(bytes)===d.sha256,'SKIN_SOURCE_TABLE_MISMATCH');original.set(d.file,bytes);
 }
 const expected=deriveSkinRetirement(sourceBytes,original,sourceSha);
 assert(expected.manifest.equals(manifestBytes),'SKIN_DERIVED_MANIFEST_MISMATCH');
 for(const [name,bytes] of [['skin',expected.skinBytes],['skin_owner',expected.ownerBytes]]){
  const d=manifest.tables.find(d=>d.schema==='zzsh_supply'&&d.table===name);
  const actual=d&&read(d.file);assert(Buffer.isBuffer(actual)&&bytes.equals(actual),'SKIN_DERIVED_TABLE_MISMATCH');
 }
 const evidence=read(manifest.catalogRetirementEvidenceFile);
 assert(manifest.catalogRetirementEvidenceFile==='lineage-'+sha(expected.evidenceBytes)+'.json'
  &&manifest.catalogRetirementEvidenceSha256===sha(expected.evidenceBytes)
  &&Buffer.isBuffer(evidence)&&expected.evidenceBytes.equals(evidence),'SKIN_EVIDENCE_MISMATCH');
 return expected.counts;
}

function main(){
 const args=process.argv.slice(2);if(!args.includes('--derive')){
  console.log(JSON.stringify({status:'PLAN_ONLY',candidate:'OWNER_KIND_V2',required:['--derive','--manifest','--manifest-sha','--out'],sourceWrites:0,connections:0,realMigrationStarted:false}));return;
 }
 assert(args.length===7&&args[0]==='--derive'&&args[1]==='--manifest'&&args[3]==='--manifest-sha'&&args[5]==='--out','DERIVATION_ARGUMENTS_INVALID');
 const restricted=realpathSync('E:/zzsh-local-state/restricted'),source=resolve(args[2]),input=dirname(source),out=resolve(args[6]);
 assert(basename(source)==='manifest.json'&&dirname(input).toLowerCase()===restricted.toLowerCase()&&!lstatSync(input).isSymbolicLink()
  &&realpathSync(input).toLowerCase()===input.toLowerCase(),'RESTRICTED_SOURCE_REQUIRED');
 assert(dirname(out).toLowerCase()===restricted.toLowerCase()&&/^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out))&&!existsSync(out),'NEW_RESTRICTED_OUTPUT_REQUIRED');
 const manifestBytes=readFileSync(source),expected=args[4];assert(/^[a-f0-9]{64}$/.test(expected??'')&&sha(manifestBytes)===expected,'SOURCE_MANIFEST_SHA_MISMATCH');
 const manifest=JSON.parse(manifestBytes),allowed=new Set(['manifest.json','media-objects.json','derivation-receipt.json']);
 for(const d of manifest.tables){assert(d.file===basename(d.file)&&!allowed.has(d.file),'SOURCE_DESCRIPTOR_DUPLICATE');allowed.add(d.file);}
 const names=readdirSync(input).sort();for(const name of names)assert(allowed.has(name)||/^(?:lineage|profit-decision|policy-evidence)-[a-f0-9]{64}\.json$/.test(name),'UNEXPECTED_SOURCE_FILE');
 const original=new Map();for(const name of names){const file=join(input,name),s=lstatSync(file);assert(s.isFile()&&!s.isSymbolicLink(),'UNSAFE_SOURCE_FILE');
  const bytes=readFileSync(file),digest=/^(?:lineage|profit-decision|policy-evidence)-([a-f0-9]{64})\.json$/.exec(name)?.[1];if(digest)assert.equal(sha(bytes),digest,'SOURCE_LINEAGE_SHA_MISMATCH');original.set(name,bytes);}
 assert(original.has('media-objects.json'),'SOURCE_MEDIA_MANIFEST_REQUIRED');
 if(manifest.sourceRawUnchanged===false){assert(original.has('derivation-receipt.json'),'SOURCE_DERIVATION_RECEIPT_REQUIRED');
  const previous=JSON.parse(original.get('derivation-receipt.json'));assert.equal(previous.derivedManifestSha256,expected,'SOURCE_DERIVATION_RECEIPT_MISMATCH');}
 const {derived,files}=buildSkinRetirementPackage(manifestBytes,original,expected);
 verifySkinRetirementPackage(derived.manifest,name=>files.get(name));
 const evidenceName='lineage-'+sha(derived.evidenceBytes)+'.json';
 const receipt={schema:'zzsh.skin-reference-derivation.v1',status:'DERIVED_CANDIDATE_ONLY',sourceManifestSha256:expected,derivedManifestSha256:sha(derived.manifest),
  catalogRetirementEvidenceSha256:sha(derived.evidenceBytes),catalogRetirementEvidenceFile:evidenceName,counts:derived.counts,
  preserved:'Original sealed package and prior lineage remain unchanged; legacy category data is evidence, not a current catalog.',
  sourceRawUnchanged:false,connections:0,credentialReads:0,realMigrationStarted:false};
 mkdirSync(out);const sid=execFileSync('powershell.exe',['-NoProfile','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true}).trim();
 assert(/^S-1-5-\d+(?:-\d+)+$/.test(sid),'LOCAL_SID_REQUIRED');
 execFileSync('icacls',[out,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
 for(const [name,bytes] of files)writeFileSync(join(out,name),bytes,{flag:'wx'});
 writeFileSync(join(out,'derivation-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
 for(const [name,bytes] of original)assert.equal(sha(readFileSync(join(input,name))),sha(bytes),'SOURCE_CHANGED_DURING_DERIVATION');
 for(const [name,bytes] of files)assert.equal(sha(readFileSync(join(out,name))),sha(bytes),'DERIVED_READBACK_MISMATCH');
 console.log(JSON.stringify({status:receipt.status,output:out,manifestSha256:receipt.derivedManifestSha256,evidenceSha256:receipt.catalogRetirementEvidenceSha256,counts:receipt.counts,connections:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main();
