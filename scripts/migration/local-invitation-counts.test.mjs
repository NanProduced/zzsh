import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyInvitationDomains } from "./local-target-finance.mjs";
import { assessInvitationChildSet, assertInvitationCountPackets, compareSystemInvitationPacketEvidence, preflightInvitationFile, readBoundInvitationPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(mode="SELECTED_BUSINESS_SCOPE") {
  const ids=["1","2"],facts=ids.map(id=>({legacyId:id,userId:`user_${id}`,codeSource:{id,code:`fx${id}`},qualificationSource:null}));
  const source={receiptSha256:"a".repeat(64),files:{users:{rows:2},qualification:{rows:0}},subjectSetDigest:hash(ids),
    codeSetDigest:hash(facts.map(f=>[f.legacyId,f.codeSource.code.toUpperCase(),hash(f.codeSource)]))};
  const packets=facts.map(fact=>{const id=fact.legacyId,input={source,policy:null,subjects:[fact],anchors:[]};
    return {input,bodyDigest:hash(input),key:`key_${id}`,relations:0};});
  const manifest={population:{mode},sourceReceiptSha256:source.receiptSha256,domains:{users:{source:2,ready:2,isolated:0}},
    invitationFacts:{subjects:2,codes:2,selectedSubjects:2,packets:2,selectedPackets:2,policy:null,financialEffects:false},
    files:{"invitation-facts":{rows:2}}};
  const invitation={invitationFactHash:hash,prepareLegacyInvitationFacts(input,digest){
    if(hash(input)!==digest)throw Error("PACKET_DIGEST_DIFFERS");return {key:`key_${input.subjects[0].legacyId}`,relations:[]};}};
  return {manifest,packets,invitation};
}

test("whole-user count closure requires every original subject and packet before writes",()=>{
  const {manifest,packets,invitation}=fixture();
  assert.equal(assertInvitationCountPackets(manifest,packets,invitation),true);
  const duplicate=structuredClone(packets);duplicate[1].input.subjects[0]=structuredClone(duplicate[0].input.subjects[0]);
  duplicate[1].bodyDigest=hash(duplicate[1].input);duplicate[1].key="key_1";
  assert.throws(()=>assertInvitationCountPackets(manifest,duplicate,invitation),/INVITATION_DUPLICATE_SUBJECT/);
  const duplicateCode=structuredClone(packets);duplicateCode[1].input.subjects[0].codeSource.code="FX1";duplicateCode[1].bodyDigest=hash(duplicateCode[1].input);
  assert.throws(()=>assertInvitationCountPackets(manifest,duplicateCode,invitation),/INVITATION_DUPLICATE_CODE/);
  assert.throws(()=>assertInvitationCountPackets(manifest,packets.slice(0,1),invitation),/INVITATION_PACKET_POPULATION_UNPROVEN/);
  const wrongReceipt=structuredClone(packets);wrongReceipt[1].input.source={...wrongReceipt[1].input.source,receiptSha256:"b".repeat(64)};wrongReceipt[1].bodyDigest=hash(wrongReceipt[1].input);
  assert.throws(()=>assertInvitationCountPackets(manifest,wrongReceipt,invitation),/INVITATION_PACKET_BINDING_INVALID/);
  const missingUser=structuredClone(manifest);missingUser.domains.users.ready=1;missingUser.domains.users.isolated=1;
  assert.throws(()=>requiresInvitationCountClosure(missingUser),/INVITATION_FULL_USER_SCOPE_UNPROVEN/);
  assert.equal(requiresInvitationCountClosure(fixture("SCENARIO_SELECTION").manifest),false);
});

test("streamed packets reject replacement, reordering, truncation and a changed file before accepting its changed packet",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"zzsh-invitation-stream-"));t.after(()=>rmSync(dir,{recursive:true}));
  const {manifest,packets,invitation}=fixture(),path=join(dir,"packets.jsonl");
  packets[0].note="合成昵称\u2028保留\u2029原样";
  const bytes=Buffer.from(packets.map(p=>JSON.stringify(p)).join("\n")+"\n");
  const sha=createHash("sha256").update(bytes).digest("hex");writeFileSync(path,bytes);
  const hashes=await preflightInvitationFile(path,sha,manifest,invitation), accepted=[];
  for await(const packet of readBoundInvitationPackets(path,sha,hashes))accepted.push(packet);
  assert.deepEqual(accepted,packets);
  const consume=async()=>{const seen=[];try{for await(const packet of readBoundInvitationPackets(path,sha,hashes))seen.push(packet);return {seen,error:null};}catch(error){return {seen,error}}};
  const changed=structuredClone(packets);changed[1].input.subjects[0].userId="user_tampered";changed[1].bodyDigest=hash(changed[1].input);
  for(const [content,expected,acceptedCount] of [
    [changed,/INVITATION_PACKET_CHANGED/,1],[[...packets].reverse(),/INVITATION_PACKET_CHANGED/,0],[[packets[0]],/INVITATION_PACKET_COUNT_CHANGED/,1],
  ]){
    writeFileSync(path,content.map(p=>JSON.stringify(p)).join("\n")+"\n");const result=await consume();assert.match(result.error?.message??"",expected);assert.equal(result.seen.length,acceptedCount);
  }
  writeFileSync(path,bytes);const iterator=readBoundInvitationPackets(path,sha,hashes);assert.deepEqual((await iterator.next()).value,packets[0]);
  writeFileSync(path,Buffer.concat([readFileSync(path),Buffer.from("\n")]));
  await assert.rejects(async()=>{for await(const _ of iterator){}},/INVITATION_FILE_SHA_MISMATCH/);
});

test("child-set comparison preserves UNKNOWN and rejects missing or changed relations",()=>{
  const child=(a,b)=>({INVITER:{sourceCount:a,knownCount:a,setDigest:hash([["a","x"]])},
    DISTRIBUTION_LEADER:{sourceCount:b,knownCount:b,setDigest:hash([])}});
  const actual={INVITER:[["a","x"]],DISTRIBUTION_LEADER:[]};
  assert.deepEqual(assessInvitationChildSet({children:child(1,0)},actual,hash),{knowledge:"KNOWN",matches:true});
  const incomplete=child(1,0);incomplete.INVITER.sourceCount=2;
  assert.deepEqual(assessInvitationChildSet({children:incomplete},actual,hash),{knowledge:"UNKNOWN",matches:true});
  assert.deepEqual(assessInvitationChildSet({children:child(1,0)},{...actual,INVITER:[["a","changed"]]},hash),{knowledge:"KNOWN",matches:false});
  assert.deepEqual(assessInvitationChildSet({children:child(1,0)},{...actual,INVITER:[]},hash),{knowledge:"KNOWN",matches:false});
});

test('system invitation readback binds original import and count receipts to system audits',()=>{
  const packet=fixture().packets[0],plan={key:packet.key,bodyDigest:packet.bodyDigest,subjects:[{userId:'user_1',sourceDigest:'a'.repeat(64)}],relations:[]};
  const actor={id:'legacy-invitation-migration:'+'b'.repeat(64),sourceDatasetSha256:'c'.repeat(64),requestId:'system-request'};
  const imported={bodyDigest:plan.bodyDigest,sourceDigest:hash(packet.input.source),policyVersionId:null,participants:1,codes:1,relations:0,financialEffects:false,subjectProofs:[{userId:'user_1',sourceDigest:'a'.repeat(64)}]};
  const count={bodyDigest:plan.bodyDigest,sourceDigest:hash(packet.input.source),subjects:1,known:1,unknown:0,financialEffects:false};
  const make=(operation,action,body,details)=>({receipt:{scope_key:JSON.stringify(['system',actor.id,operation,null]),key:plan.key,request_fingerprint:hash([operation,null,{bodyDigest:plan.bodyDigest}]),response_status:200,response_body:body,publish_required:false},
    audit:{object_id:plan.bodyDigest,action,object_type:'legacy_invitation_batch',outcome:'SUCCESS',actor_type:'system',actor_id:actor.id,session_id:null,request_id:actor.requestId,source_manifest:actor.sourceDatasetSha256,details}});
  const one=make('distribution.legacy-facts.v2.import','distribution.legacy_facts.imported',imported,{bodyDigest:plan.bodyDigest,source:packet.input.source,facts:packet.input.subjects,financialEffects:false});
  const two=make('distribution.legacy-facts.v2.counts','distribution.legacy_facts.counts_closed',count,count);
  const read=(receipts,audits)=>compareSystemInvitationPacketEvidence({packet,plan,actor,receipts,audits,countBody:count,canonical:JSON.stringify,sourceHash:hash});
  assert.deepEqual(read([one.receipt,two.receipt],[one.audit,two.audit]),{importMatched:true,countMatched:true});
  assert.equal(read([one.receipt],[one.audit,two.audit]).countMatched,false);
  assert.equal(read([one.receipt,two.receipt],[{...one.audit,actor_type:'admin'},two.audit]).importMatched,false);
  assert.equal(read([one.receipt,two.receipt],[one.audit,one.audit,two.audit]).importMatched,false);
  assert.equal(read([{...one.receipt,request_fingerprint:'0'.repeat(64)},two.receipt],[one.audit,two.audit]).importMatched,false);
});

function harness({mode="SELECTED_BUSINESS_SCOPE",importQuarantine=false,failCount=false}={}) {
  const {manifest,packets}=fixture(mode),events=[],state={resource:{owner_oid:"10"},phases:{}};
  const backend={async bindReviewedLegacyInvitationFacts(_c,_a,review){events.push(`bind:${review.phase}`);return review;},
    async importReviewedLegacyInvitationFacts(_c,_a,input,digest,scope){assert.equal(scope.phase,"IMPORT");assert.equal(digest,hash(input));events.push(`import:${input.subjects[0].legacyId}`);return {replayed:false};},
    async closeReviewedLegacyInvitationCounts(_c,_a,input,digest,scope){assert.equal(scope.phase,"COUNTS");assert.equal(digest,hash(input));events.push(`count:${input.subjects[0].legacyId}`);if(failCount)throw Object.assign(Error("source set differs"),{status:409});return {replayed:false};}};
  const ctx={client:{},actor:{userId:"operator"},manifest,state,invitationPackets:packets,mod:()=>backend,
    systemInvitation:{async import(packet){events.push(`system-import:${packet.input.subjects[0].legacyId}`);return {replayed:false};},
      async closeCounts(packet){events.push(`system-count:${packet.input.subjects[0].legacyId}`);return {replayed:false};}},
    async runItems(domain,rows,fn){let count=0;for await(const row of rows){await fn(row);count++;}state.phases[domain]={complete:true,nextIndex:count,quarantined:domain==="invitationFacts"&&importQuarantine?1:0};}};
  return {ctx,events,review:{ref:"test",attempt:"once",actor:{userId:"operator",sessionId:"session"},notBefore:"start",expiresAt:"end"},resource:{port:55433}};
}

test("count closure begins only after all original invitation batches imported",async()=>{
  const h=harness();await applyInvitationDomains(h.ctx,h.review,h.resource,JSON.stringify);
  assert.deepEqual(h.events,["bind:IMPORT","import:1","bind:IMPORT","import:2","bind:COUNTS","count:1","bind:COUNTS","count:2"]);
  assert.equal(h.ctx.state.phases.invitationCounts.complete,true);
  const streamed=harness();let opened=0;streamed.ctx.invitationSource=async function*(){opened++;for(const row of streamed.ctx.invitationPackets)yield row};streamed.ctx.invitationPacketCount=streamed.ctx.invitationPackets.length;
  await applyInvitationDomains(streamed.ctx,streamed.review,streamed.resource,JSON.stringify);assert.equal(opened,2);assert.deepEqual(streamed.events,h.events);
  const partial=harness({mode:"SCENARIO_SELECTION"});await applyInvitationDomains(partial.ctx,partial.review,partial.resource,JSON.stringify);
  assert.equal(partial.ctx.state.phases.invitationCounts,undefined);
});

test("next-profile financial source is verified before any imported record is written",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"zzsh-finance-source-"));t.after(()=>rmSync(dir,{recursive:true}));
  const file=join(dir,"invitation-facts.jsonl"),h=harness(),packets=h.ctx.invitationPackets;
  const bytes=Buffer.from(packets.map(row=>JSON.stringify(row)).join("\n")+"\n");
  writeFileSync(file,bytes);delete h.ctx.invitationPackets;h.ctx.isNextMigration=true;
  h.ctx.domainFile=()=>file;h.ctx.readRows=()=>{throw Error("UNBOUND_READ")};
  h.ctx.manifest.files["invitation-facts"]={rows:packets.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  await applyInvitationDomains(h.ctx,h.review,h.resource,JSON.stringify);assert.deepEqual(h.events,['system-import:1','system-import:2','system-count:1','system-count:2']);
  const changed=harness();delete changed.ctx.invitationPackets;changed.ctx.isNextMigration=true;
  changed.ctx.domainFile=()=>file;changed.ctx.readRows=h.ctx.readRows;changed.ctx.manifest.files["invitation-facts"]=h.ctx.manifest.files["invitation-facts"];
  writeFileSync(file,Buffer.concat([bytes,Buffer.from("\n")]));
  await assert.rejects(applyInvitationDomains(changed.ctx,changed.review,changed.resource,JSON.stringify),/SOURCE_STREAM_CHANGED/);
  assert.deepEqual(changed.events,[]);
  const missing=harness();missing.ctx.isNextMigration=true;delete missing.ctx.systemInvitation;
  await assert.rejects(applyInvitationDomains(missing.ctx,missing.review,missing.resource,JSON.stringify),/NEXT_SYSTEM_INVITATION_ADAPTER_REQUIRED/);assert.deepEqual(missing.events,[]);
});

test("failed or incomplete import and count conflicts stop without closing later batches",async()=>{
  const quarantined=harness({importQuarantine:true});await assert.rejects(applyInvitationDomains(quarantined.ctx,quarantined.review,quarantined.resource,JSON.stringify),/INVITATION_IMPORT_NOT_COMPLETE/);
  assert(!quarantined.events.includes("bind:COUNTS"));
  const conflict=harness({failCount:true});await assert.rejects(applyInvitationDomains(conflict.ctx,conflict.review,conflict.resource,JSON.stringify),/source set differs/);
  assert(conflict.events.includes("count:1"));assert(!conflict.events.includes("count:2"));
  assert.equal(conflict.ctx.state.phases.invitationCounts,undefined);
});
