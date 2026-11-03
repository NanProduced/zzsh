import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {legacyOwnerUserId} from '../supply/legacy-user-migration';
import {ensureOnlyFields,invalid,conflict} from '../supply/supply-util';
import {validateDistributionPolicy,type DistributionPolicyConfig} from './distribution-policy';

const digest=/^[a-f0-9]{64}$/;
export const invitationFactHash=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
export const invitationFactTypes=['INVITER','DISTRIBUTION_LEADER'] as const;
export type InvitationFactType=typeof invitationFactTypes[number];
type ParentKnowledge={knowledge:'KNOWN_NONE'|'KNOWN_PARENT'|'UNKNOWN';reason:string|null};
type ChildProof={sourceCount:number;knownCount:number;setDigest:string};
export type LegacyInvitationFactSource={schema:'legacy-invitation-source.v2';sourceSystem:'legacy_mysql_restore';cutoff:string;receiptSha256:string;supplementReceiptSha256:string;
 files:{users:{sha256:string;rows:number};qualification:{sha256:string;rows:number};codes:{sha256:string;rows:number}};subjectSetDigest:string;codeSetDigest:string};
export type LegacyInvitationRawFact={legacyId:string;userId:string;identitySourceDigest:string;userSource:Record<string,unknown>;codeSource:{id:string;code:string};qualificationSource:Record<string,unknown>|null};
export type LegacyInvitationFact=LegacyInvitationRawFact&{parents:Record<InvitationFactType,ParentKnowledge>;children:Record<InvitationFactType,ChildProof>};
export type LegacyInvitationFactPolicy={versionId:string;configDigest:string;scope:'LOCAL_CONTROLLED'|'NATIVE';config:DistributionPolicyConfig;qualification:'EXACT_LEGACY_FLAGS_V2'};
export type LegacyInvitationFactAnchor={fact:LegacyInvitationFact;batchKey:string;batchDigest:string};
export type LegacyInvitationFactsInput={schema:'legacy-invitation-facts.v2';source:LegacyInvitationFactSource;policy:LegacyInvitationFactPolicy|null;subjects:LegacyInvitationFact[];anchors:LegacyInvitationFactAnchor[]};
export const legacyInvitationFactsOperation='distribution.legacy-facts.v2.import';
export const legacyInvitationCountsOperation='distribution.legacy-facts.v2.counts';
const parentField={INVITER:'inviter_id',DISTRIBUTION_LEADER:'first_leader'} as const;
export function invitationSourceId(value:unknown){if(typeof value!=='string'||!/^[1-9]\d{0,23}$/.test(value))throw invalid('Exact legacy invitation source ID required');return value;}
export function invitationSourceFlag(value:unknown):boolean|null{if(value===0||value==='0')return false;if(value===1||value==='1')return true;if(value===null)return null;throw invalid('Exact original invitation flag required');}
function parentId(value:unknown){return value===null?undefined:value===0||value==='0'?null:invitationSourceId(value);}
function sourceShape(source:LegacyInvitationFactSource){
 ensureOnlyFields(source,['schema','sourceSystem','cutoff','receiptSha256','supplementReceiptSha256','files','subjectSetDigest','codeSetDigest']);
 if(source.schema!=='legacy-invitation-source.v2'||source.sourceSystem!=='legacy_mysql_restore'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.cutoff)||!Number.isFinite(Date.parse(source.cutoff))
  ||![source.receiptSha256,source.supplementReceiptSha256,source.subjectSetDigest,source.codeSetDigest].every(v=>typeof v==='string'&&digest.test(v)))throw invalid('Frozen invitation source binding required');
 ensureOnlyFields(source.files,['users','qualification','codes']);for(const f of Object.values(source.files)){ensureOnlyFields(f,['sha256','rows']);if(!digest.test(f.sha256)||!Number.isSafeInteger(f.rows)||f.rows<0||f.rows>300000)throw invalid('Bounded invitation source files required');}
 if(source.files.users.rows!==source.files.codes.rows)throw conflict('Original code/user source sets differ');
}
function rawFactShape(s:LegacyInvitationRawFact){
 const id=invitationSourceId(s.legacyId);if(s.userId!==legacyOwnerUserId('legacy_mysql_restore','la_user',id)||!digest.test(s.identitySourceDigest))throw conflict('Original invitation identity tuple differs');
 ensureOnlyFields(s.userSource,['id','is_delete','is_disable','inviter_id','first_leader','second_leader','third_leader','create_time','update_time']);
 if(s.userSource.id!==id)throw conflict('Original invitation user differs');
 invitationSourceFlag(s.userSource.is_delete);invitationSourceFlag(s.userSource.is_disable);
 for(const f of ['inviter_id','first_leader','second_leader','third_leader'])parentId(s.userSource[f]);
 for(const f of ['create_time','update_time'])if(s.userSource[f]!==null&&(typeof s.userSource[f]!=='string'||!/^(0|[1-9]\d{0,11})$/.test(s.userSource[f] as string)))throw invalid('Original invitation time must remain exact');
 ensureOnlyFields(s.codeSource,['id','code']);if(s.codeSource.id!==id||typeof s.codeSource.code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(s.codeSource.code))throw conflict('Original stored invitation code required');
 if(s.qualificationSource!==null){const q=s.qualificationSource;ensureOnlyFields(q,['id','user_id','level_id','is_delete','is_freeze','is_distribution']);invitationSourceId(q.id);if(q.user_id!==id)throw conflict('Qualification belongs to another source subject');
  if(q.level_id!==null&&(typeof q.level_id!=='string'||!/^(0|[1-9]\d{0,23})$/.test(q.level_id)))throw invalid('Original grade must remain exact');for(const f of ['is_delete','is_freeze','is_distribution'])invitationSourceFlag(q[f]);}
}
function policyShape(p:LegacyInvitationFactPolicy|null){if(p===null)return;ensureOnlyFields(p,['versionId','configDigest','scope','config','qualification']);
 if(typeof p.versionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(p.versionId)||!digest.test(p.configDigest)||p.qualification!=='EXACT_LEGACY_FLAGS_V2')throw invalid('Exact existing uniform policy binding required');
 const config=validateDistributionPolicy(p.config as unknown as Record<string,unknown>,p.scope);if(config.schema!=='distribution-policy.v2'||canonicalize(config)!==canonicalize(p.config)||invitationFactHash(config)!==p.configDigest)throw conflict('Current immutable uniform policy differs');
}
export function invitationFactSourceDigest(source:LegacyInvitationFactSource,fact:LegacyInvitationRawFact){return invitationFactHash({schema:'legacy-invitation.fact.v2',source,fact:{legacyId:fact.legacyId,userId:fact.userId,identitySourceDigest:fact.identitySourceDigest,userSource:fact.userSource,codeSource:fact.codeSource,qualificationSource:fact.qualificationSource}});}
export function invitationFactCodeId(id:string){return'legacy_code_'+invitationFactHash(['legacy_mysql_restore','la_user',id]).slice(0,40);}
export function invitationFactRelation(source:LegacyInvitationFactSource,fact:LegacyInvitationRawFact,type:InvitationFactType){
 const parent=parentId(fact.userSource[parentField[type]]);if(!parent)throw invalid('Known original parent required');
 return{id:'legacy_relation_'+invitationFactHash([source.sourceSystem,fact.legacyId,type]).slice(0,40),type,childUserId:fact.userId,parentUserId:legacyOwnerUserId(source.sourceSystem,'la_user',parent),sourceRef:source.sourceSystem+':la_user:'+fact.legacyId+':'+parentField[type],sourceDigest:invitationFactSourceDigest(source,fact)};
}
function factShape(s:LegacyInvitationFact){
 ensureOnlyFields(s,['legacyId','userId','identitySourceDigest','userSource','codeSource','qualificationSource','parents','children']);rawFactShape(s);ensureOnlyFields(s.parents,[...invitationFactTypes]);ensureOnlyFields(s.children,[...invitationFactTypes]);
 for(const type of invitationFactTypes){const p=s.parents[type],c=s.children[type],raw=parentId(s.userSource[parentField[type]]);ensureOnlyFields(p,['knowledge','reason']);ensureOnlyFields(c,['sourceCount','knownCount','setDigest']);
  if(!['KNOWN_NONE','KNOWN_PARENT','UNKNOWN'].includes(p.knowledge)||(p.knowledge==='UNKNOWN'?!['MISSING_PARENT_FACT','MISSING_PARENT_SOURCE','SOURCE_SELF','SOURCE_CYCLE','SOURCE_ANCESTRY_NOT_CLOSED'].includes(p.reason??''):p.reason!==null)
   ||p.knowledge==='KNOWN_NONE'&&raw!==null||p.knowledge==='KNOWN_PARENT'&&(!raw||raw===s.legacyId)||p.knowledge==='UNKNOWN'&&raw===null)throw conflict('Original parent knowledge contradicts source');
  if(!Number.isSafeInteger(c.sourceCount)||!Number.isSafeInteger(c.knownCount)||c.knownCount<0||c.sourceCount<c.knownCount||!digest.test(c.setDigest))throw invalid('Original child count proof required');
 }
}
export function projectInvitationFactParticipant(source:LegacyInvitationFactSource,s:LegacyInvitationFact,policy:LegacyInvitationFactPolicy|null){
 const q=s.qualificationSource,deleted=invitationSourceFlag(s.userSource.is_delete),qDeleted=q?invitationSourceFlag(q.is_delete):null,qualified=q?invitationSourceFlag(q.is_distribution):null,frozen=q?invitationSourceFlag(q.is_freeze):null;
 const eligibility=deleted===true||qDeleted===true||qualified===false?'INELIGIBLE':policy!==null&&deleted===false&&qDeleted===false&&qualified===true&&frozen!==null?'ELIGIBLE':'UNKNOWN';
 return{userId:s.userId,eligibility,commissionFrozen:frozen,levelCode:null,policyVersionId:policy?.versionId??null,inviterKnowledge:s.parents.INVITER.knowledge,leaderKnowledge:s.parents.DISTRIBUTION_LEADER.knowledge,
  inviteesKnowledge:invitationFactTypes.every(t=>s.children[t].sourceCount===0)?'KNOWN':'UNKNOWN',sourceRef:source.sourceSystem+':la_user:'+s.legacyId+':invitation-facts:v2',sourceDigest:invitationFactSourceDigest(source,s),codeId:invitationFactCodeId(s.legacyId),codeDigest:invitationFactHash(s.codeSource)};
}
/** A new explicit contract leaves the v1 input/key and old receipts untouched. */
export function prepareLegacyInvitationFacts(input:LegacyInvitationFactsInput,reviewedDigest:string){
 ensureOnlyFields(input,['schema','source','policy','subjects','anchors']);if(input.schema!=='legacy-invitation-facts.v2'||!Array.isArray(input.subjects)||!input.subjects.length||!Array.isArray(input.anchors)||input.subjects.length+input.anchors.length>5000)throw invalid('At most 5000 original subjects and parent anchors required');
 sourceShape(input.source);policyShape(input.policy);const bodyDigest=invitationFactHash(input);if(bodyDigest!==reviewedDigest||!digest.test(reviewedDigest))throw conflict('Reviewed invitation fact body differs');
 const byId=new Map<string,LegacyInvitationFact>(),codes=new Set<string>();for(const s of [...input.subjects,...input.anchors.map(a=>a.fact)]){factShape(s);if(byId.has(s.legacyId)||codes.has(s.codeSource.code.toUpperCase()))throw conflict('Duplicate original subject or ASCII code');byId.set(s.legacyId,s);codes.add(s.codeSource.code.toUpperCase());}
 for(const a of input.anchors){ensureOnlyFields(a,['fact','batchKey','batchDigest']);if(!/^legacy-invitation-facts-v2-[a-f0-9]{40}$/.test(a.batchKey)||!digest.test(a.batchDigest))throw invalid('Original imported parent receipt required');}
 const relations=[];for(const s of input.subjects)for(const type of invitationFactTypes)if(s.parents[type].knowledge==='KNOWN_PARENT'){
  const parent=byId.get(parentId(s.userSource[parentField[type]])!);if(!parent||parent.parents[type].knowledge==='UNKNOWN')throw conflict('Complete original parent closure required');relations.push(invitationFactRelation(input.source,s,type));
 }
 for(const type of invitationFactTypes){const done=new Set<string>();for(const s of input.subjects){if(done.has(s.legacyId))continue;const seen=new Set<string>();let at:LegacyInvitationFact|undefined=s;while(at&&!done.has(at.legacyId)&&at.parents[type].knowledge==='KNOWN_PARENT'){if(seen.has(at.legacyId))throw conflict('Original invitation ancestry is cyclic');seen.add(at.legacyId);at=byId.get(parentId(at.userSource[parentField[type]])!);}for(const id of seen)done.add(id);}}
 const subjects=input.subjects.map(s=>({...projectInvitationFactParticipant(input.source,s,input.policy),fact:s}));
 const key='legacy-invitation-facts-v2-'+invitationFactHash([input.source,[...input.subjects.map(s=>s.legacyId)].sort()]).slice(0,40);
 return{key,bodyDigest,subjects,relations:relations.sort((a,b)=>a.id<b.id?-1:1)};
}

/** Iterative SCC ordering keeps both distinct parent graphs closed without a call-stack limit. */
function parentComponents(ids:string[],parents:Map<string,string[]>){
 const done=new Set<string>(),order:string[]=[],children=new Map<string,string[]>();for(const id of ids)for(const p of parents.get(id)??[]){const list=children.get(p)??[];list.push(id);children.set(p,list);}
 for(const id of ids){if(done.has(id))continue;done.add(id);const stack:Array<[string,number]>=[[id,0]];while(stack.length){const frame=stack[stack.length-1]!,next=(parents.get(frame[0])??[])[frame[1]++];if(next!==undefined){if(!done.has(next)){done.add(next);stack.push([next,0]);}}else{order.push(frame[0]);stack.pop();}}}
 const assigned=new Set<string>(),groups:string[][]=[];for(let i=order.length-1;i>=0;i--){const id=order[i]!;if(assigned.has(id))continue;const group:string[]=[],stack=[id];assigned.add(id);while(stack.length){const at=stack.pop()!;group.push(at);for(const c of children.get(at)??[])if(!assigned.has(c)){assigned.add(c);stack.push(c);}}groups.push(group.sort());}
 const component=new Map<string,number>();groups.forEach((g,i)=>g.forEach(id=>component.set(id,i)));const deps=groups.map(()=>new Set<number>()),reverse=groups.map(()=>new Set<number>());
 for(const id of ids)for(const p of parents.get(id)??[]){const a=component.get(id)!,b=component.get(p)!;if(a!==b){deps[a]!.add(b);reverse[b]!.add(a);}}
 const ready=groups.flatMap((_,i)=>deps[i]!.size?[]:[i]),result:string[][]=[];for(let i=0;i<ready.length;i++){const n=ready[i]!;result.push(groups[n]!);for(const child of reverse[n]!){deps[child]!.delete(n);if(!deps[child]!.size)ready.push(child);}}if(result.length!==groups.length)throw conflict('Original parent component closure failed');return result;
}

/** Whole frozen population only; Map indexes and color walks are O(subjects + edges), never per-subject full filters. */
export function planLegacyInvitationFacts(source:LegacyInvitationFactSource,raw:LegacyInvitationRawFact[],policy:LegacyInvitationFactPolicy|null=null,maxPacketFacts=5000){
 sourceShape(source);policyShape(policy);if(!Number.isInteger(maxPacketFacts)||maxPacketFacts<2||maxPacketFacts>5000||raw.length!==source.files.users.rows||raw.length>300000)throw invalid('Complete bounded frozen invitation population required');
 const byId=new Map<string,LegacyInvitationRawFact>(),codes=new Set<string>();for(const s of raw){rawFactShape(s);if(byId.has(s.legacyId)||codes.has(s.codeSource.code.toUpperCase()))throw conflict('Global original identity/code collision');byId.set(s.legacyId,s);codes.add(s.codeSource.code.toUpperCase());}
 const ids=[...byId.keys()].sort();if(source.subjectSetDigest!==invitationFactHash(ids)||source.codeSetDigest!==invitationFactHash(ids.map(id=>[id,byId.get(id)!.codeSource.code.toUpperCase(),invitationFactHash(byId.get(id)!.codeSource)])))throw conflict('Global source user/code set proof differs');
 if(raw.filter(s=>s.qualificationSource!==null).length!==source.files.qualification.rows)throw conflict('Qualification source population differs');
 const states={INVITER:new Map<string,ParentKnowledge>(),DISTRIBUTION_LEADER:new Map<string,ParentKnowledge>()};
 for(const type of invitationFactTypes)for(const id of ids){if(states[type].has(id))continue;const path:string[]=[],positions=new Map<string,number>();let at:string|undefined=id,bad:string|null=null;
  while(at!==undefined&&!states[type].has(at)){if(positions.has(at)){bad='SOURCE_CYCLE';break;}const s=byId.get(at);if(!s){bad='MISSING_PARENT_SOURCE';break;}positions.set(at,path.length);path.push(at);const p=parentId(s.userSource[parentField[type]]);if(p===undefined){bad='MISSING_PARENT_FACT';break;}if(p===null)break;if(p===at){bad='SOURCE_SELF';break;}at=p;}
  if(at!==undefined&&states[type].get(at)?.knowledge==='UNKNOWN')bad='SOURCE_ANCESTRY_NOT_CLOSED';
  for(let i=path.length-1;i>=0;i--){const current=path[i]!,p=parentId(byId.get(current)!.userSource[parentField[type]]);states[type].set(current,bad?{knowledge:'UNKNOWN',reason:i===path.length-1?bad:'SOURCE_ANCESTRY_NOT_CLOSED'}:{knowledge:p===null?'KNOWN_NONE':'KNOWN_PARENT',reason:null});}
 }
 const proofs=new Map(ids.map(id=>[id,{INVITER:{sourceCount:0,edges:[] as Array<[string,string]>},DISTRIBUTION_LEADER:{sourceCount:0,edges:[] as Array<[string,string]>}}]));
 for(const s of raw)for(const type of invitationFactTypes){const p=parentId(s.userSource[parentField[type]]);if(p&&proofs.has(p)){const group=proofs.get(p)![type];group.sourceCount++;if(states[type].get(s.legacyId)!.knowledge==='KNOWN_PARENT'){const e=invitationFactRelation(source,s,type);group.edges.push([e.id,e.sourceDigest]);}}}
 const facts=new Map<string,LegacyInvitationFact>();for(const id of ids){const p=proofs.get(id)!;facts.set(id,{...byId.get(id)!,parents:{INVITER:states.INVITER.get(id)!,DISTRIBUTION_LEADER:states.DISTRIBUTION_LEADER.get(id)!},children:Object.fromEntries(invitationFactTypes.map(t=>[t,{sourceCount:p[t].sourceCount,knownCount:p[t].edges.length,setDigest:invitationFactHash(p[t].edges.sort((a,b)=>a[0]<b[0]?-1:1))}])) as LegacyInvitationFact['children']});}
 const dependencies=new Map(ids.map(id=>[id,invitationFactTypes.flatMap(t=>facts.get(id)!.parents[t].knowledge==='KNOWN_PARENT'?[parentId(facts.get(id)!.userSource[parentField[t]])!]:[])]));
 const packets:LegacyInvitationFactsInput[]=[],prior=new Map<string,{key:string;bodyDigest:string}>();let pending:string[]=[],pendingSet=new Set<string>(),anchors=new Set<string>();
 const flush=()=>{if(!pending.length)return;const packet:LegacyInvitationFactsInput={schema:'legacy-invitation-facts.v2',source,policy,subjects:pending.map(id=>facts.get(id)!),anchors:[...anchors].sort().map(id=>({fact:facts.get(id)!,batchKey:prior.get(id)!.key,batchDigest:prior.get(id)!.bodyDigest}))};const p=prepareLegacyInvitationFacts(packet,invitationFactHash(packet));for(const id of pending)prior.set(id,{key:p.key,bodyDigest:p.bodyDigest});packets.push(packet);pending=[];pendingSet=new Set();anchors=new Set();};
 for(const group of parentComponents(ids,dependencies)){
  if(group.length>maxPacketFacts)throw conflict('Original cross-type closure component exceeds one bounded packet');
  const g=new Set(group),additional=()=>new Set(group.flatMap(id=>dependencies.get(id)!).filter(p=>!g.has(p)&&!pendingSet.has(p)));
  let extra=additional();if(pending.length+group.length+new Set([...anchors,...extra]).size>maxPacketFacts){flush();extra=additional();}
  if(group.length+extra.size>maxPacketFacts)throw conflict('Original parent anchors exceed one bounded packet');
  for(const id of group){pending.push(id);pendingSet.add(id);anchors.delete(id);}for(const id of extra){if(!prior.has(id))throw conflict('Parent import receipt must precede this packet');anchors.add(id);}
 }flush();
 const reasons:Record<string,number>={};for(const s of facts.values())for(const t of invitationFactTypes)if(s.parents[t].reason)reasons[s.parents[t].reason!]=(reasons[s.parents[t].reason!]??0)+1;
 return{source,packets,summary:{subjects:raw.length,codes:codes.size,qualificationMissing:raw.filter(s=>s.qualificationSource===null).length,packets:packets.length,relations:invitationFactTypes.reduce((n,t)=>n+[...states[t].values()].filter(p=>p.knowledge==='KNOWN_PARENT').length,0),unknownParentFacts:invitationFactTypes.reduce((n,t)=>n+[...states[t].values()].filter(p=>p.knowledge==='UNKNOWN').length,0),parentReasons:reasons,financialEffects:false}};
}
