import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {canonicalize} from '../src/supply/content-hash';
import {legacyOwnerUserId} from '../src/supply/legacy-user-migration';
import {invitationFactHash as hash,planLegacyInvitationFacts,prepareLegacyInvitationFacts,projectInvitationFactParticipant,type LegacyInvitationRawFact,type LegacyInvitationFactSource,type LegacyInvitationFactsInput,type LegacyInvitationFactPolicy} from '../src/finance/legacy-invitation-facts';
import {bindReviewedLegacyInvitationFacts,planReviewedLegacyInvitationFactsTarget,importReviewedLegacyInvitationFacts,closeReviewedLegacyInvitationCounts,recoverReviewedLegacyInvitationFacts,type LegacyInvitationFactsReview} from '../src/finance/legacy-invitation-facts-maintenance';

const actor={userId:'boss',sessionId:'session',requestId:'request'},at='2026-11-02T14:00:00.000Z';
function raw(id:string,parent='0'):LegacyInvitationRawFact{return{legacyId:id,userId:legacyOwnerUserId('legacy_mysql_restore','la_user',id),identitySourceDigest:'a'.repeat(64),userSource:{id,is_delete:'0',is_disable:'0',inviter_id:parent,first_leader:parent,second_leader:'0',third_leader:'0',create_time:'1',update_time:'2'},codeSource:{id,code:'fx'+id},qualificationSource:{id,user_id:id,level_id:'7',is_delete:'0',is_freeze:'0',is_distribution:'1'}};}
function source(facts:LegacyInvitationRawFact[]):LegacyInvitationFactSource{const ids=facts.map(s=>s.legacyId).sort(),m=new Map(facts.map(s=>[s.legacyId,s]));return{schema:'legacy-invitation-source.v2',sourceSystem:'legacy_mysql_restore',cutoff:'2026-09-13T13:31:13.000Z',receiptSha256:'a'.repeat(64),supplementReceiptSha256:'b'.repeat(64),files:{users:{sha256:'c'.repeat(64),rows:facts.length},qualification:{sha256:'d'.repeat(64),rows:facts.filter(s=>s.qualificationSource!==null).length},codes:{sha256:'e'.repeat(64),rows:facts.length}},subjectSetDigest:hash(ids),codeSetDigest:hash(ids.map(id=>[id,m.get(id)!.codeSource.code.toUpperCase(),hash(m.get(id)!.codeSource)]))};}
function planned(facts=[raw('1'),raw('2','1'),raw('3','2')],max=5000,policy:LegacyInvitationFactPolicy|null=null){return planLegacyInvitationFacts(source(facts),facts,policy,max);}
function uniform():LegacyInvitationFactPolicy{const config:LegacyInvitationFactPolicy['config']={schema:'distribution-policy.v2',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:7,rateMode:'UNIFORM',renterPercent:'5',ownerPercent:'5',levels:[]};return{versionId:'published',configDigest:hash(config),scope:'LOCAL_CONTROLLED',config,qualification:'EXACT_LEGACY_FLAGS_V2'};}
function review(input:LegacyInvitationFactsInput,phase:'IMPORT'|'COUNTS'='IMPORT'):LegacyInvitationFactsReview{return{ref:'ROOT_REVIEW',attempt:'facts_01',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{host:'127.0.0.1',port:55432,database:'zzsh_dev_daily',oid:2400547,owner:'zzsh',ownerOid:10,marker:'zzsh:synthetic-target:2400547',role:'daily_m',roleOid:1221849},notBefore:'2026-11-02T13:00:00.000Z',expiresAt:'2026-11-02T15:00:00.000Z',bodyDigest:hash(input),sourceDigest:hash(input.source),phase};}

test('facts-only import preserves real codes, qualification flags and grade without inventing current eligibility or rates',()=>{
 const items=[raw('1'),raw('2'),raw('3')];items[0]!.qualificationSource!.is_freeze='1';items[1]!.qualificationSource=null;items[2]!.qualificationSource!.is_distribution='0';
 const packet=planned(items).packets[0]!,p=prepareLegacyInvitationFacts(packet,hash(packet));assert.equal(p.subjects.find(s=>s.fact.legacyId==='1')!.eligibility,'UNKNOWN');assert.equal(p.subjects.find(s=>s.fact.legacyId==='1')!.commissionFrozen,true);
 assert.equal(p.subjects.find(s=>s.fact.legacyId==='2')!.commissionFrozen,null);assert.equal(p.subjects.find(s=>s.fact.legacyId==='3')!.eligibility,'INELIGIBLE');assert.ok(p.subjects.every(s=>s.levelCode===null&&s.policyVersionId===null));
 assert.equal(packet.subjects.find(s=>s.legacyId==='1')!.qualificationSource!.level_id,'7');assert.equal(packet.subjects.find(s=>s.legacyId==='1')!.codeSource.code,'fx1');assert.equal('renterPercent' in p.subjects[0]!,false);
});
test('the exact existing uniform policy is optional and never fabricates a legacy grade',()=>{const packet=planned([raw('1')],5000,uniform()).packets[0]!,p=prepareLegacyInvitationFacts(packet,hash(packet));assert.equal(p.subjects[0]!.eligibility,'ELIGIBLE');assert.equal(p.subjects[0]!.levelCode,null);const bad=structuredClone(packet);bad.policy!.configDigest='0'.repeat(64);assert.throws(()=>prepareLegacyInvitationFacts(bad,hash(bad)));});
test('both first-level sources stay distinct; second and third leader values are retained but never become extra commission edges',()=>{const items=[raw('1'),raw('2'),raw('3','1')];items[2]!.userSource.first_leader='2';items[2]!.userSource.second_leader='1';items[2]!.userSource.third_leader='2';const p=planned(items),edges=p.packets.flatMap(x=>prepareLegacyInvitationFacts(x,hash(x)).relations);assert.equal(edges.length,2);assert.notEqual(edges[0]!.parentUserId,edges[1]!.parentUserId);assert.equal(p.summary.financialEffects,false);});
test('source missing parent, self or cycles never becomes known-none or an executable bad relation; codes stay reserved',()=>{
 for(const type of ['missing','self','cycle','fact'] as const){const items=[raw('1'),raw('2')];if(type==='missing')items[0]!.userSource.inviter_id='99';if(type==='self')items[0]!.userSource.inviter_id='1';if(type==='cycle'){items[0]!.userSource.inviter_id='2';items[1]!.userSource.inviter_id='1';}if(type==='fact')items[0]!.userSource.inviter_id=null;
  const p=planned(items),facts=p.packets.flatMap(x=>x.subjects);assert.equal(facts.find(s=>s.legacyId==='1')!.parents.INVITER.knowledge,'UNKNOWN');assert.equal(p.summary.codes,2);assert.equal(p.packets.flatMap(x=>prepareLegacyInvitationFacts(x,hash(x)).relations).filter(e=>e.type==='INVITER').length,0);
 }
});
test('global ASCII collisions, crossed qualification identities, source set drift and reviewed packet drift reject',()=>{
 const collision=[raw('1'),raw('2')];collision[1]!.codeSource.code='FX1';assert.throws(()=>planned(collision));const crossed=[raw('1')];crossed[0]!.qualificationSource!.user_id='2';assert.throws(()=>planned(crossed));const items=[raw('1')],s=source(items);s.codeSetDigest='0'.repeat(64);assert.throws(()=>planLegacyInvitationFacts(s,items));const packet=planned().packets[0]!;assert.throws(()=>prepareLegacyInvitationFacts(packet,'0'.repeat(64)));
});
test('bounded packets bind previously imported parents by their original key and body, while early parent totals remain unknown',()=>{
 const p=planned(undefined,2);assert.equal(p.packets.length,2);assert.ok(p.packets.every(x=>x.subjects.length+x.anchors.length<=2));assert.equal(p.packets[1]!.anchors.length,1);
 assert.equal(p.packets[1]!.anchors[0]!.batchKey,prepareLegacyInvitationFacts(p.packets[0]!,hash(p.packets[0])).key);assert.equal(p.packets[1]!.anchors[0]!.batchDigest,hash(p.packets[0]));
 const first=p.packets[0]!.subjects.find(s=>s.legacyId==='1')!;assert.equal(projectInvitationFactParticipant(p.source,first,null).inviteesKnowledge,'UNKNOWN');assert.equal(first.children.INVITER.sourceCount,1);
 const bad=structuredClone(p.packets[1]!);bad.anchors=[];assert.throws(()=>prepareLegacyInvitationFacts(bad,hash(bad)));
});
test('cross-type dependencies may share a packet without conflating the two independent ancestry graphs',()=>{const items=[raw('1'),raw('2')];items[0]!.userSource.inviter_id='2';items[1]!.userSource.first_leader='1';const p=planned(items,2);assert.equal(p.packets.length,1);assert.equal(p.summary.unknownParentFacts,0);assert.equal(p.summary.relations,2);});

function database(){
 const participants=new Map<string,any>(),codes=new Map<string,any>(),edges=new Map<string,any>(),receipts=new Map<string,any>(),audits=new Map<string,any>();
 const state={now:at,mode:'T',identity:true,owner:true,codeConflict:false,failAudit:false,revokeAfterAudit:false,expireAfterAudit:false,actorFrozen:false,policy:uniform(),queries:[] as string[],writes:0};
 const client={connectionParameters:{host:'127.0.0.1',port:55432,database:'zzsh_dev_daily',user:'daily_m'},getTransactionStatus:()=>state.mode,query:async(sql:string,args:any[]=[])=>{
  state.queries.push(sql);const rows=(values:any[]=[])=>({rows:values,rowCount:values.length});
  if(sql.includes('invitation-facts resource'))return rows([{oid:2400547,database:'zzsh_dev_daily',owner:'zzsh',ownerOid:10,marker:'zzsh:synthetic-target:2400547',role:'daily_m',roleOid:1221849,now:state.now,owned:state.owner?3:2,complete:true,read_only:'off'}]);
  if(sql.includes('FROM "zzsh_auth_admin"."session" s JOIN'))return rows([{locked:false,twoFactorEnabled:true,suspended:state.actorFrozen}]);
  if(sql.includes('SELECT "status", "is_boss"'))return rows([{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}]);
  if(sql.startsWith('SELECT suspended'))return rows([{suspended:false}]);
  if(sql.startsWith('SELECT s.id')||sql.startsWith('SET CONSTRAINTS')||sql.includes('pg_advisory_xact_lock'))return rows();
  if(sql.includes('invitation-facts identities'))return rows(JSON.parse(args[0]).map((x:any)=>({...x,proved:state.identity})));
  if(sql.includes('invitation-facts existing policy'))return rows([{scope:state.policy.scope,schema_version:'distribution-policy.v2',canonical_config:canonicalize(state.policy.config),config_digest:state.policy.configDigest,current_version_id:state.policy.versionId}]);
  if(sql.includes('invitation-facts no overwrite'))return rows([{present:state.codeConflict||args[0].some((id:string)=>participants.has(id)||[...codes.values()].some(c=>c.user_id===id))}]);
  if(sql.includes('invitation-facts target conflicts'))return rows([{participants:'0',codes:state.codeConflict?'1':'0',relations:'0'}]);
  if(sql.includes('invitation-facts participants'))return rows(args[0].flatMap((id:string)=>participants.has(id)?[participants.get(id)]:[]));
  if(sql.includes('invitation-facts codes'))return rows([...codes.values()].filter(c=>args[0].includes(c.user_id)));
  if(sql.includes('invitation-facts original edges'))return rows([...edges.values()].filter(e=>args[0].includes(e.child_user_id)));
  if(sql.includes('invitation-facts canonical provenance'))return rows(audits.has(args[0]+':'+args[1])?[{details:audits.get(args[0]+':'+args[1])}]:[]);
  if(sql.includes('invitation-facts parent receipts'))return rows(args[1].flatMap((key:string)=>receipts.has(args[0]+':'+key)?[{key,...receipts.get(args[0]+':'+key)}]:[]));
  if(sql.includes('invitation-facts original receipt'))return rows(receipts.has(args[0]+':'+args[1])?[receipts.get(args[0]+':'+args[1])]:[]);
  if(sql.includes('invitation-facts all original children'))return rows([...edges.values()].filter(e=>args[0].includes(e.parent_user_id)).sort((a,b)=>a.id<b.id?-1:1));
  if(sql.includes('invitation-facts count CAS'))return rows(args[0].flatMap((id:string)=>participants.has(id)?[participants.get(id)]:[]));
  if(sql.startsWith('SELECT user_id,invitees_knowledge'))return rows(args[0].flatMap((id:string)=>participants.has(id)?[participants.get(id)]:[]));
  if(sql.includes('FROM "zzsh_supply"."idempotency_record"')){const r=receipts.get(args[0]+':'+args[1]);return rows(r?[{requestFingerprint:r.request_fingerprint,responseStatus:r.response_status,responseBody:r.response_body,publishRequired:false}]:[]);}
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_participant')){state.writes++;for(const p of JSON.parse(args[0]))participants.set(p.user_id,{...p,revision:'1',source_type:'LEGACY_MYSQL'});return rows();}
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_invite_code')){state.writes++;for(const c of JSON.parse(args[0]))codes.set(c.id,{id:c.id,user_id:c.user_id,display_code:c.code,match_code:c.code.toUpperCase(),source_type:'LEGACY_MYSQL',source_system:'legacy_mysql_restore',source_entity:'la_user',source_id:c.legacy_id,source_digest:c.digest});return rows();}
  if(sql.startsWith('INSERT INTO zzsh_order.invitation_relation')){state.writes++;for(const e of JSON.parse(args[0]))edges.set(e.id,{...e,policy_version_id:args[1],source_type:'LEGACY_MYSQL'});return rows();}
  if(sql.startsWith('UPDATE zzsh_order.distribution_participant')){state.writes++;const updates=JSON.parse(args[0]);for(const x of updates){const p=participants.get(x.user_id);assert.equal(p.revision,x.revision);p.invitees_knowledge=x.knowledge;p.revision=String(BigInt(p.revision)+1n);}return{rows:[],rowCount:updates.length};}
  if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')){if(state.failAudit)throw Error('AUDIT_WRITE_REJECTED');state.writes++;audits.set(args[6]+':'+args[4],JSON.parse(args[10]));if(state.revokeAfterAudit)state.actorFrozen=true;if(state.expireAfterAudit)state.now='2026-11-02T16:00:00.000Z';return rows();}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){state.writes++;receipts.set(args[0]+':'+args[1],{request_fingerprint:args[2],response_status:args[3],response_body:JSON.parse(args[4])});return rows();}
  throw Error('Unexpected actual maintenance query: '+sql.slice(0,100));
 }} as unknown as PoolClient;
 return{client,state,participants,codes,edges,receipts,audits};
}
async function bind(db:ReturnType<typeof database>,packet:LegacyInvitationFactsInput,phase:'IMPORT'|'COUNTS'='IMPORT',mode:'execute'|'recover'='execute'){return bindReviewedLegacyInvitationFacts(db.client,actor,review(packet,phase),mode);}

test('real import/recovery/count entrypoints accept policy-free original facts and reconcile bounded cross-packet parents',async()=>{
 const db=database(),p=planned(undefined,2);for(const packet of p.packets){const cap=await bind(db,packet),r=await importReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),cap);assert.equal(r.replayed,false);assert.equal((r.body as any).financialEffects,false);const replay=await importReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),cap);assert.equal(replay.replayed,true);assert.equal((await recoverReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),cap)).knowledge,'KNOWN');}
 assert.equal(db.codes.size,3);assert.equal(db.edges.size,4);assert.ok([...db.participants.values()].every(p=>p.eligibility==='UNKNOWN'&&p.policy_version_id===null));
 for(const packet of p.packets){const cap=await bind(db,packet,'COUNTS');assert.equal((await closeReviewedLegacyInvitationCounts(db.client,actor,packet,hash(packet),cap)).status,200);assert.equal((await recoverReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),cap,'COUNTS')).knowledge,'KNOWN');}
 assert.ok([...db.participants.values()].every(p=>p.invitees_knowledge==='KNOWN'));assert.ok(!db.state.queries.some(q=>/settlement_|wallet|finance_event|INSERT INTO zzsh_order\.distribution_policy/i.test(q)));assert.ok(!db.state.queries.some(q=>/^(BEGIN|COMMIT|ROLLBACK)/.test(q)));
});
test('missing original receipt stays UNKNOWN and forged/runtime/wrong owner/expired/autocommit authority never writes',async()=>{
 const packet=planned([raw('1')]).packets[0]!,db=database(),cap=await bind(db,packet);assert.deepEqual(await recoverReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),cap),{knowledge:'UNKNOWN',receipt:null});
 await assert.rejects(importReviewedLegacyInvitationFacts(db.client,actor,packet,hash(packet),{kind:'REVIEWED_LEGACY_INVITATION_FACTS'}));assert.equal(db.state.writes,0);
 for(const mutation of [(d:typeof db)=>{d.state.owner=false;},(d:typeof db)=>{d.state.mode='I';},(d:typeof db)=>{d.state.now='2026-11-02T16:00:00.000Z';},(d:typeof db)=>{(d.client as any).connectionParameters.user='runtime';}]){const d=database();mutation(d);await assert.rejects(bind(d,packet));assert.equal(d.state.writes,0);}
 const r=review(packet);r.resource.database='zzsh_test_regression';r.resource.oid=2220718;await assert.rejects(bindReviewedLegacyInvitationFacts(db.client,actor,r));assert.equal(db.state.writes,0);
});
test('original target identity, code collision and missing parent receipt reject before target insertion',async()=>{
 const p=planned(undefined,2);for(const kind of ['identity','code','parent'] as const){const d=database(),packet=kind==='parent'?p.packets[1]!:p.packets[0]!;if(kind==='identity')d.state.identity=false;if(kind==='code')d.state.codeConflict=true;const cap=await bind(d,packet);await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));assert.equal(d.state.writes,0);}
});
test('recovery checks immutable canonical qualification and original edges without overwriting later financial or binding states',async()=>{
 const packet=planned([raw('1'),raw('2','1')]).packets[0]!,d=database(),cap=await bind(d,packet);await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap);const one=[...d.participants.values()][0]!;one.eligibility='INELIGIBLE';one.commission_frozen=true;one.revision='9';assert.equal((await recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap)).knowledge,'KNOWN');
 const firstCode=[...d.codes.values()][0]!;firstCode.display_code='forged';await assert.rejects(recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));firstCode.display_code=packet.subjects.find(s=>s.userId===firstCode.user_id)!.codeSource.code;
 const edge=[...d.edges.values()][0]!,parent=edge.parent_user_id;edge.parent_user_id='crossed-subject';await assert.rejects(recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));edge.parent_user_id=parent;
 const audit=[...d.audits.values()][0]!;audit.facts[0].qualificationSource.level_id='999';await assert.rejects(recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));
});
test('count closure refuses an unimported child set and a replay verifies later foreign original edges',async()=>{
 const p=planned(undefined,2),d=database(),packet=p.packets[0]!,cap=await bind(d,packet);await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap);const counts=await bind(d,packet,'COUNTS');await assert.rejects(closeReviewedLegacyInvitationCounts(d.client,actor,packet,hash(packet),counts));
 const second=p.packets[1]!,secondCap=await bind(d,second);await importReviewedLegacyInvitationFacts(d.client,actor,second,hash(second),secondCap);await closeReviewedLegacyInvitationCounts(d.client,actor,packet,hash(packet),counts);
 d.edges.set('foreign',{id:'foreign',type:'INVITER',parent_user_id:packet.subjects[0]!.userId,child_user_id:'other',source_digest:'f'.repeat(64)});await assert.rejects(closeReviewedLegacyInvitationCounts(d.client,actor,packet,hash(packet),counts));
});
test('an expired execute token cannot write; recovery-only preserves the original key after expiry',async()=>{
 const packet=planned([raw('1')]).packets[0]!,d=database(),cap=await bind(d,packet);await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap);const writes=d.state.writes;d.state.now='2026-11-02T16:00:00.000Z';await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));const recover=await bind(d,packet,'IMPORT','recover');assert.equal((await recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),recover)).knowledge,'KNOWN');await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),recover));assert.equal(d.state.writes,writes);
});
test('target plan uses actual identity/parent/code checks without DML and policy binding checks exact current head',async()=>{
 const packet=planned([raw('1')],5000,uniform()).packets[0]!,d=database();const target=await planReviewedLegacyInvitationFactsTarget(d.client,actor,packet,hash(packet),review(packet));assert.equal(target.executable,false);assert.equal(d.state.writes,0);d.state.policy.versionId='different';const cap=await bind(d,packet);await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));assert.equal(d.state.writes,0);
});
test('batch SQL call count is independent of subject count and audit failure leaves no success receipt or commit',async t=>{
 const calls=[];for(const n of [1,1000]){const packet=planned(Array.from({length:n},(_,i)=>raw(String(i+1)))).packets[0]!,d=database(),cap=await bind(d,packet);await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap);calls.push(d.state.queries.length);assert.equal(d.participants.size,n);assert.equal(d.codes.size,n);}
 assert.equal(calls[0],calls[1]);assert.ok(calls[1]!<50,'one bounded set-based checkpoint, not per-subject SQL');t.diagnostic(JSON.stringify({evidence:'ACTUAL_ENTRYPOINT_SYNTHETIC_CLIENT_NOT_PG',subjects:[1,1000],driverQueryCalls:calls}));
 const packet=planned([raw('1')]).packets[0]!,d=database(),cap=await bind(d,packet);d.state.failAudit=true;await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap),/AUDIT_WRITE_REJECTED/);assert.equal(d.receipts.size,0);assert.ok(!d.state.queries.some(q=>q==='COMMIT'));
});
test('late maintenance revocation or expiry prevents a success receipt after writes and requires caller rollback',async()=>{
 const packet=planned([raw('1')]).packets[0]!;for(const kind of ['revokeAfterAudit','expireAfterAudit'] as const){const d=database(),cap=await bind(d,packet);d.state[kind]=true;await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap));assert.equal(d.receipts.size,0);assert.ok(!d.state.queries.some(q=>q==='COMMIT'));}
});

test('parent anchors reject a damaged original request fingerprint before child writes',async()=>{
 const p=planned(undefined,2),d=database(),first=p.packets[0]!,next=p.packets[1]!;
 await importReviewedLegacyInvitationFacts(d.client,actor,first,hash(first),await bind(d,first));
 for(const r of d.receipts.values())r.request_fingerprint='0'.repeat(64);
 const before=d.state.writes;await assert.rejects(importReviewedLegacyInvitationFacts(d.client,actor,next,hash(next),await bind(d,next)));assert.equal(d.state.writes,before);
});

test('count closure and recovery require the exact original import receipt',async()=>{
 for(const mutation of ['missing','fingerprint','body'] as const){
  const packet=planned([raw('1'),raw('2','1')]).packets[0]!,d=database();await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),await bind(d,packet));
  const original=[...d.receipts.values()][0]!,key=[...d.receipts.keys()][0]!,cap=await bind(d,packet,'COUNTS');
  if(mutation==='missing')d.receipts.delete(key);else if(mutation==='fingerprint')original.request_fingerprint='0'.repeat(64);else original.response_body={...original.response_body,participants:999};
  const before=d.state.writes;await assert.rejects(closeReviewedLegacyInvitationCounts(d.client,actor,packet,hash(packet),cap));assert.equal(d.state.writes,before);assert.equal(d.participants.get(packet.subjects.find(s=>s.legacyId==='1')!.userId).invitees_knowledge,'UNKNOWN');
 }
 const packet=planned([raw('1')]).packets[0]!,d=database();await importReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),await bind(d,packet));const importKey=[...d.receipts.keys()][0]!,cap=await bind(d,packet,'COUNTS');await closeReviewedLegacyInvitationCounts(d.client,actor,packet,hash(packet),cap);
 assert.ok(importKey);d.receipts.delete(importKey);await assert.rejects(recoverReviewedLegacyInvitationFacts(d.client,actor,packet,hash(packet),cap,'COUNTS'));
});
