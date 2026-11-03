import assert from "node:assert/strict";
import {test} from "node:test";
import type {PoolClient} from "pg";
import {readAvatarUploadPolicy,updateAvatarUploadPolicy} from "../src/profile/avatar-policy";
import {finalizeAvatarSubmission} from "../src/profile/avatar-submission";
import {applyAvatarReview,lastReviewView,listAvatarReviews} from "../src/profile/profile-avatar";

function fixture(realm:"user"|"admin"="user"){
 const subject=realm==="user"?"user_1":"admin_1";
 let available=true,policy={requiresReview:true,revision:"1"};const queries:Array<{sql:string;values:any[]}>=[],audits:any[]=[];
 const profile:any={realm,subjectId:subject,defaultPresetId:"avatar-strike",currentKind:"DEFAULT",currentPresetId:"avatar-strike",currentAssetId:null,pendingAssetId:"old_pending",latestUploadIntentId:"intent_1",revision:"2",currentVersion:"1",lastReviewAssetId:null,lastReviewState:null,lastReviewReason:null,lastReviewedAt:null,lastReviewApplied:false,updatedAt:new Date()};
 const asset:any={id:"asset_1",purpose:"AVATAR",ownershipKind:realm==="user"?"USER_AVATAR":"ADMIN_AVATAR",ownerUserId:realm==="user"?subject:null,uploadedByAdminId:realm==="admin"?subject:null,reviewState:"PENDING",accessClass:"PRIVATE_REVIEW",technicalState:"READY",publicStorageKey:"a".repeat(64),revision:"1",reviewedByAdminId:null,avatarPolicyRevision:null};
 const oldAsset={id:"old_pending",reviewState:"PENDING"};let image:string|null=null,failAudit=false;
 const client={async query(sql:string,values:any[]=[]){queries.push({sql,values});
   if(sql.includes("to_regclass"))return {rows:[{available}]};
   if(sql.includes("FROM zzsh_supply.profile_avatar_policy"))return {rows:[{...policy}]};
   if(sql.startsWith("UPDATE zzsh_supply.profile_avatar_policy")){policy={requiresReview:values[0],revision:String(BigInt(policy.revision)+1n)};return {rows:[{...policy}]};}
   if(sql.includes('FROM "zzsh_supply"."media_asset"'))return {rows:values[0]===asset.id?[{...asset}]:[]};
   if(sql.includes('FROM "zzsh_supply"."profile_avatar"'))return {rows:[{...profile}]};
   if(sql.startsWith('UPDATE "zzsh_supply"."profile_avatar"')){
    if(sql.includes("\"current_kind\" = 'CUSTOM'")){Object.assign(profile,{currentKind:"CUSTOM",currentPresetId:null,currentAssetId:values[2],pendingAssetId:null,currentVersion:values[3],revision:values[4],lastReviewAssetId:values[2],lastReviewState:"APPROVED",lastReviewReason:values[5],lastReviewedAt:new Date(),lastReviewApplied:true});}
    else if(sql.includes('"pending_asset_id" = $3')){profile.pendingAssetId=values[2];profile.latestUploadIntentId=null;profile.revision=String(BigInt(profile.revision)+1n);}
    else throw new Error("unhandled profile write");return {rows:[],rowCount:1};
   }
   if(sql.startsWith("UPDATE zzsh_supply.media_asset")){Object.assign(asset,{reviewState:"APPROVED",accessClass:"PUBLIC_DISPLAY",avatarPolicyRevision:values[1],reviewedByAdminId:null,revision:"2"});return {rows:[],rowCount:1};}
   if(sql.startsWith('UPDATE "zzsh_auth_')){image=values[1];return {rows:[],rowCount:1};}
   if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')){if(failAudit)throw new Error("audit unavailable");audits.push({actor:values[1],actorId:values[2],action:values[4],details:JSON.parse(values.at(-1))});return {rows:[],rowCount:1};}
   throw new Error("unexpected fixture SQL: "+sql.slice(0,100));
 }} as unknown as PoolClient;
 const input:any={assetId:"asset_1",purpose:"AVATAR",reviewState:"PENDING",accessClass:"PRIVATE_REVIEW",gameId:null,accountId:null};
 const submit=()=>finalizeAvatarSubmission(client,realm,subject,input,"intent_1",{realm,id:subject},"request_policy_1");
 return {client,profile,asset,oldAsset,queries,audits,submit,subject,setAvailable:(v:boolean)=>available=v,setPolicy:(v:typeof policy)=>policy=v,setAuditFailure:()=>failAudit=true,get image(){return image;}};
}
test("missing policy installation fails safe to required review and cannot be updated",async()=>{const f=fixture();f.setAvailable(false);assert.deepEqual(await readAvatarUploadPolicy(f.client,true),{requiresReview:true,revision:"0",available:false});await assert.rejects(updateAvatarUploadPolicy(f.client,{id:"admin_1",sessionId:"session_1"},{requiresReview:false,expectedRevision:"1"},"r"),{status:503});assert.equal(f.queries.some(q=>q.sql.startsWith("UPDATE")),false);});
test("policy CAS/noop do not touch pending assets or active selections",async()=>{const f=fixture();const before=structuredClone(f.profile);await assert.rejects(updateAvatarUploadPolicy(f.client,{id:"admin_1",sessionId:"s"},{requiresReview:false,expectedRevision:"9"},"r"),{status:409});assert.equal((await updateAvatarUploadPolicy(f.client,{id:"admin_1",sessionId:"s"},{requiresReview:true,expectedRevision:"1"},"r")).changed,false);const saved=await updateAvatarUploadPolicy(f.client,{id:"admin_1",sessionId:"s"},{requiresReview:false,expectedRevision:"1"},"r");assert.equal(saved.policy.revision,"2");assert.deepEqual(f.profile,before);assert.equal(f.oldAsset.reviewState,"PENDING");assert.equal(f.queries.filter(q=>q.sql.startsWith("UPDATE")).length,1);});
test("review-required finalize binds pending and records the exact locked policy version",async()=>{const f=fixture();f.setPolicy({requiresReview:true,revision:"4"});const result=await f.submit();assert.equal(f.profile.pendingAssetId,"asset_1");assert.equal(f.asset.reviewState,"PENDING");assert.equal(f.image,null);assert.deepEqual(result.avatarSubmission,{disposition:"PENDING_REVIEW",requiresReview:true,policyRevision:"4",approvalSource:"MANUAL_REVIEW_REQUIRED"});assert(f.queries.some(q=>q.sql.includes("profile_avatar_policy")&&q.sql.endsWith("FOR SHARE")));});
for(const realm of ["user","admin"] as const)test(realm+" disabled review approves only new eligible submit with system provenance",async()=>{const f=fixture(realm);f.setPolicy({requiresReview:false,revision:"5"});const result=await f.submit();assert.equal(result.avatarSubmission.disposition,"APPLIED_BY_POLICY");assert.equal(f.asset.reviewedByAdminId,null);assert.equal(f.asset.avatarPolicyRevision,"5");assert.equal(f.profile.currentAssetId,"asset_1");assert.equal(f.profile.pendingAssetId,null);assert.equal(f.image,"/api/v1/profile/avatars/"+realm+"/"+f.subject+"/2");assert.equal(f.oldAsset.reviewState,"PENDING");assert(f.audits.some(a=>a.actor==="system"&&a.actorId===null&&a.action==="profile.avatar.policy.applied"&&a.details.policyRevision==="5"));assert.equal(lastReviewView(f.profile,f.asset)?.source,"SYSTEM_POLICY");});
test("late intent or default selection cannot be bypassed by the no-review policy",async()=>{for(const latest of [null,"newer_intent"]){const f=fixture();f.setPolicy({requiresReview:false,revision:"2"});f.profile.latestUploadIntentId=latest;await assert.rejects(f.submit(),{status:409});assert.equal(f.asset.reviewState,"PENDING");assert.equal(f.image,null);assert.equal(f.queries.filter(q=>q.sql.startsWith("UPDATE zzsh_supply.media_asset")).length,0);}});
test("policy does not waive subject/technical/public derivative eligibility",async()=>{for(const change of [{ownerUserId:"other_user"},{purpose:"ACCOUNT_DISPLAY"},{technicalState:"FAILED"},{publicStorageKey:null}]){const f=fixture();f.setPolicy({requiresReview:false,revision:"2"});Object.assign(f.asset,change);await assert.rejects(f.submit());assert.equal(f.queries.some(q=>q.sql.startsWith("UPDATE zzsh_supply.media_asset")),false);assert.equal(f.image,null);}});
test("system activation cannot borrow a human approval or a different policy version",async()=>{for(const patch of [{avatarPolicyRevision:null},{avatarPolicyRevision:"8"},{avatarPolicyRevision:"2",reviewedByAdminId:"human_admin"}]){const f=fixture();Object.assign(f.asset,{reviewState:"APPROVED",accessClass:"PUBLIC_DISPLAY",...patch});f.profile.pendingAssetId="asset_1";await assert.rejects(applyAvatarReview(f.client,"user","user_1","asset_1","APPROVE",null,{realm:"system",policyRevision:"2"},"r"),{status:409});assert.equal(f.image,null);}});
test("audit failure aborts auto-finalization rather than claiming successful activation",async()=>{const f=fixture();f.setPolicy({requiresReview:false,revision:"2"});f.setAuditFailure();await assert.rejects(f.submit(),/audit unavailable/);assert.equal(f.image,null);});

test("review list distinguishes system policy approval from subsequent human disposition in one bounded query",async()=>{
 const statements:string[]=[];const base={assetId:"asset_1",realm:"user",subjectId:"user_1",subjectName:"fixture",createdAt:new Date(),width:256,height:256,byteSize:"32",mime:"image/webp",reviewState:"APPROVED",accessClass:"PUBLIC_DISPLAY",reviewReason:null,revision:"2"};
 const client={query:async(sql:string)=>{statements.push(sql);assert.match(sql,/"avatar_policy_revision"::text AS "policyRevision"/);assert.match(sql,/"reviewed_by_admin_id" AS "reviewedByAdminId"/);return {rows:[{...base,policyRevision:"2",reviewedByAdminId:null},{...base,assetId:"asset_human",policyRevision:"2",reviewedByAdminId:"human"}]};}} as unknown as PoolClient;
 const result=await listAvatarReviews(client,{state:"APPROVED",cursor:null,limit:20});assert.equal(statements.length,1);assert.deepEqual(result.items.map(r=>r.approvalSource),["SYSTEM_POLICY","HUMAN_REVIEW"]);
});
