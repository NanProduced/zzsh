import {createHash,randomBytes} from 'node:crypto';import type {PoolClient} from 'pg';import {canonicalize} from '../supply/content-hash';import {invalid,conflict} from '../supply/supply-util';import {recordAudit} from '../auth/security-core';import {readRegistrationDistributionPolicyInTransaction,type LocalDistributionScope} from './distribution-policy-store';
import {readDistributionParentInTransaction} from './invitation-store';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Candidate only. Caller must be the new-user INSERT branch, on its existing transaction.
 * Existing-user OTP/login must never call this or overwrite registration provenance. */
export async function initializeNewDistributionRegistration(c:PoolClient,input:{userId:string;inviteCode?:string;requestId:string},binding?:LocalDistributionScope){
 if(input.inviteCode!==undefined&&!/^[A-Za-z0-9_-]{1,30}$/.test(input.inviteCode))throw invalid('Registration invitation code format invalid');
 const installed=(await c.query(`SELECT to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.distribution_invite_code') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AND to_regclass('zzsh_order.distribution_policy_head') IS NOT NULL AS complete,to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS protected_proof`)).rows[0];
 if(!installed?.complete&&binding!==undefined)throw conflict('Bound distribution registration schema unavailable');
 if(!installed?.complete)return{knowledge:'UNKNOWN' as const,reason:'DISTRIBUTION_REGISTRATION_NOT_INSTALLED'};
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");const previous=(await c.query('SELECT user_id FROM zzsh_order.distribution_participant WHERE user_id=$1',[input.userId])).rows[0];if(previous)throw conflict('Registration provenance already initialized; use original registration receipt');
 const birthProof=installed.protected_proof===true?"EXISTS(SELECT 1 FROM zzsh_order.native_user_insert_proof p WHERE p.user_id=u.id AND p.insert_xid=pg_current_xact_id())":"u.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text";
 const user=(await c.query(`SELECT u.id,u.suspended,s.account_status,
  ${birthProof} AS inserted_in_transaction
  FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=$1`,[input.userId])).rows[0];
 if(!user||user.suspended||user.account_status!=='ACTIVE'||!user.inserted_in_transaction)throw conflict('Only the new registration transaction may initialize provenance');
 const policy=await readRegistrationDistributionPolicyInTransaction(c,binding),defaultLevel=policy.policy?.config.levels.find(l=>l.default),eligible=policy.knowledge==='KNOWN'?policy.policy.config.enabled?'ELIGIBLE':'INELIGIBLE':'UNKNOWN';
 let inviter:any=null;if(input.inviteCode)inviter=(await c.query('SELECT * FROM zzsh_order.distribution_invite_code WHERE match_code=$1',[input.inviteCode.toUpperCase()])).rows[0];
 if(inviter?.user_id&&inviter.user_id!==input.userId)await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE',[inviter.user_id]);
 const parentFacts=inviter?.user_id?await readDistributionParentInTransaction(c,inviter.user_id):null,parent=parentFacts?.parent;
 const mappedInviter=Boolean(inviter?.user_id&&inviter.user_id!==input.userId),unknownInput=Boolean(input.inviteCode&&!mappedInviter),sourceRef='registration:'+input.userId,sourceDigest=sha(canonicalize({sourceRef,policyVersion:policy.policy?.versionId??null,inviteCodeId:inviter?.id??null}));
 await c.query(`INSERT INTO zzsh_order.distribution_participant(user_id,eligibility,commission_frozen,level_code,policy_version_id,revision,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,source_ref,source_digest) VALUES($1,$2,false,$3,$4,1,$5,$6,'KNOWN','NATIVE_REGISTRATION',$7,$8)`,[input.userId,eligible,defaultLevel?.code??null,policy.policy?.versionId??null,mappedInviter?'KNOWN_PARENT':unknownInput?'UNKNOWN':'KNOWN_NONE',unknownInput?'UNKNOWN':'KNOWN_NONE',sourceRef,sourceDigest]);
 let codeCreated=false;for(let attempt=0;attempt<3&&!codeCreated;attempt++){
  const displayCode='FX'+randomBytes(8).toString('hex').toUpperCase();
  codeCreated=(await c.query(`INSERT INTO zzsh_order.distribution_invite_code(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest) VALUES($1,$2,$3,'NATIVE_REGISTRATION','zzsh','auth_user',$2,$4) ON CONFLICT(match_code) DO NOTHING RETURNING id`,['invite_code_'+sha(input.userId).slice(0,40),input.userId,displayCode,sourceDigest])).rowCount===1;
 }if(!codeCreated)throw conflict('Invitation code collision; registration was not completed');
 if(mappedInviter){await c.query(`INSERT INTO zzsh_order.invitation_relation(id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest) VALUES($1,'INVITER',$2,$3,$4,'NATIVE_REGISTRATION',$5,$6)`,['inviter_'+sha(input.userId).slice(0,40),input.userId,inviter.user_id,policy.policy?.versionId??null,sourceRef,sourceDigest]);
  // Old registration still succeeds when leader conditions are absent. Unclosed sources remain UNKNOWN.
  if(parent?.eligibility==='ELIGIBLE'&&parentFacts?.ownerActive===true&&parentFacts.graphComplete&&policy.policy?.config.enabled){await c.query(`INSERT INTO zzsh_order.invitation_relation(id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest) VALUES($1,'DISTRIBUTION_LEADER',$2,$3,$4,'NATIVE_REGISTRATION',$5,$6)`,['leader_'+sha(input.userId).slice(0,40),input.userId,inviter.user_id,policy.policy.versionId,sourceRef,sourceDigest]);await c.query("UPDATE zzsh_order.distribution_participant SET leader_knowledge='KNOWN_PARENT',revision=revision+1 WHERE user_id=$1",[input.userId]);}
  else if(!parent||parent.eligibility==='UNKNOWN'||parentFacts?.ownerActive===null||!parentFacts?.graphComplete)await c.query("UPDATE zzsh_order.distribution_participant SET leader_knowledge='UNKNOWN',revision=revision+1 WHERE user_id=$1",[input.userId]);
 }
 await recordAudit(c,{actorType:'system',requestId:input.requestId,action:'distribution.registration.initialized',objectType:'distribution_participant',objectId:input.userId,outcome:'SUCCESS',details:{sourceDigest,policyVersion:policy.policy?.versionId??null,inviterMapped:mappedInviter}});
 return{knowledge:'KNOWN' as const,eligibility:eligible,policyVersion:policy.policy?.versionId??null,inviterKnowledge:mappedInviter?'KNOWN_PARENT':unknownInput?'UNKNOWN':'KNOWN_NONE'};
}


