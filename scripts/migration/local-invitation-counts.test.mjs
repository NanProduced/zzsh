import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyInvitationDomains } from "./local-target-finance.mjs";
import { assessInvitationChildSet, assertInvitationCountPackets, requiresInvitationCountClosure } from "./local-round-contract.mjs";

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

function harness({mode="SELECTED_BUSINESS_SCOPE",importQuarantine=false,failCount=false}={}) {
  const {manifest,packets}=fixture(mode),events=[],state={resource:{owner_oid:"10"},phases:{}};
  const backend={async bindReviewedLegacyInvitationFacts(_c,_a,review){events.push(`bind:${review.phase}`);return review;},
    async importReviewedLegacyInvitationFacts(_c,_a,input,digest,scope){assert.equal(scope.phase,"IMPORT");assert.equal(digest,hash(input));events.push(`import:${input.subjects[0].legacyId}`);return {replayed:false};},
    async closeReviewedLegacyInvitationCounts(_c,_a,input,digest,scope){assert.equal(scope.phase,"COUNTS");assert.equal(digest,hash(input));events.push(`count:${input.subjects[0].legacyId}`);if(failCount)throw Object.assign(Error("source set differs"),{status:409});return {replayed:false};}};
  const ctx={client:{},actor:{userId:"operator"},manifest,state,invitationPackets:packets,mod:()=>backend,
    async runItems(domain,rows,fn){for(const row of rows)await fn(row);state.phases[domain]={complete:true,nextIndex:rows.length,quarantined:domain==="invitationFacts"&&importQuarantine?1:0};}};
  return {ctx,events,review:{ref:"test",attempt:"once",actor:{userId:"operator",sessionId:"session"},notBefore:"start",expiresAt:"end"},resource:{port:55433}};
}

test("count closure begins only after all original invitation batches imported",async()=>{
  const h=harness();await applyInvitationDomains(h.ctx,h.review,h.resource,JSON.stringify);
  assert.deepEqual(h.events,["bind:IMPORT","import:1","bind:IMPORT","import:2","bind:COUNTS","count:1","bind:COUNTS","count:2"]);
  assert.equal(h.ctx.state.phases.invitationCounts.complete,true);
  const partial=harness({mode:"SCENARIO_SELECTION"});await applyInvitationDomains(partial.ctx,partial.review,partial.resource,JSON.stringify);
  assert.equal(partial.ctx.state.phases.invitationCounts,undefined);
});

test("failed or incomplete import and count conflicts stop without closing later batches",async()=>{
  const quarantined=harness({importQuarantine:true});await assert.rejects(applyInvitationDomains(quarantined.ctx,quarantined.review,quarantined.resource,JSON.stringify),/INVITATION_IMPORT_NOT_COMPLETE/);
  assert(!quarantined.events.includes("bind:COUNTS"));
  const conflict=harness({failCount:true});await assert.rejects(applyInvitationDomains(conflict.ctx,conflict.review,conflict.resource,JSON.stringify),/source set differs/);
  assert(conflict.events.includes("count:1"));assert(!conflict.events.includes("count:2"));
  assert.equal(conflict.ctx.state.phases.invitationCounts,undefined);
});
