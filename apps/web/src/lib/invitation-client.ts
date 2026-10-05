import {WalletRequestError} from './personal-wallet-client.ts';
export type InvitationRelation={id:string;type:'DISTRIBUTION_LEADER';childUserId:string;parentUserId:string;policyVersion:string};
export type InvitationRead={scope:'LOCAL_CONTROLLED';subjectId:string;policyKnowledge:'KNOWN'|'UNKNOWN';policyVersion:string|null;policyEnabled:boolean|null;participant:{knowledge:'KNOWN'|'UNKNOWN';eligibility:'ELIGIBLE'|'INELIGIBLE'|'UNKNOWN';levelCode:string|null;revision:string|null};ownCode:{knowledge:'KNOWN'|'UNKNOWN';code:string|null};inviter:ParentRead;leader:ParentRead};
export type InviteesPage={knowledge:'KNOWN'|'UNKNOWN';type:'ALL'|'INVITER'|'DISTRIBUTION_LEADER';snapshotVersion:string|null;count:string|null;mappedRelationCount:string|null;nextCursor:string|null;items:{id:string;type:'INVITER'|'DISTRIBUTION_LEADER';nickname:string;boundAt:string|null;boundAtKnowledge:'KNOWN'|'UNKNOWN';sourceType:string}[]};
type ParentRead={knowledge:'KNOWN_NONE'|'KNOWN_PARENT'|'UNKNOWN';relation:{id:string;parentUserId:string;sourceType:string;boundAt:string|null;boundAtKnowledge:'KNOWN'|'UNKNOWN'}|null};
export type LeaderBindingBody={code:string;policyVersion:string;expectedParticipantRevision:string};
type Pending={version:1;userId:string;key:string;body:LeaderBindingBody};
const bad=()=>new WalletRequestError(502,'INVITATION_CONTRACT_REQUIRED');
function object(v:any){if(!v||typeof v!=='object'||Array.isArray(v))throw bad();return v;}
function text(v:any,max=128):string{if(typeof v!=='string'||!v||v.length>max)throw bad();return v;}
function subject(body:any,userId:string){if(body.subjectId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');}
function parent(value:any):ParentRead{const p=object(value);if(!['KNOWN_NONE','KNOWN_PARENT','UNKNOWN'].includes(p.knowledge)||(p.knowledge==='KNOWN_PARENT')!==(p.relation!==null))throw bad();const r=p.relation===null?null:object(p.relation),unknown=r?.sourceType==='LEGACY_MYSQL'||r?.boundAtKnowledge==='UNKNOWN';return{knowledge:p.knowledge,relation:r?{id:text(r.id),parentUserId:text(r.parentUserId),sourceType:text(r.sourceType),boundAt:unknown?null:text(r.boundAt,40),boundAtKnowledge:unknown?'UNKNOWN':'KNOWN'}:null};}
export function invitationRead(value:unknown,userId:string):InvitationRead{
 const b=object(value);subject(b,userId);const p=object(b.participant),code=object(b.ownCode);
 if(b.scope!=='LOCAL_CONTROLLED'||!['KNOWN','UNKNOWN'].includes(b.policyKnowledge)||(b.policyKnowledge==='KNOWN')!==(b.policyVersion!==null)||!['KNOWN','UNKNOWN'].includes(p.knowledge)||!['ELIGIBLE','INELIGIBLE','UNKNOWN'].includes(p.eligibility)||!['KNOWN','UNKNOWN'].includes(code.knowledge)||(code.knowledge==='KNOWN')!==(code.code!==null))throw bad();
 if((b.policyKnowledge==='KNOWN')!==(typeof b.policyEnabled==='boolean')||b.policyKnowledge==='UNKNOWN'&&b.policyEnabled!==null)throw bad();
 if(code.code!==null&&(typeof code.code!=='string'||!/^[A-Za-z0-9_-]{1,30}$/.test(code.code)))throw bad();if(p.revision!==null&&(typeof p.revision!=='string'||!/^[1-9]\d{0,18}$/.test(p.revision)))throw bad();if((p.knowledge==='KNOWN')!==(p.revision!==null)||p.knowledge==='UNKNOWN'&&(p.eligibility!=='UNKNOWN'||p.levelCode!==null))throw bad();
 return{scope:b.scope,subjectId:userId,policyKnowledge:b.policyKnowledge,policyVersion:b.policyVersion===null?null:text(b.policyVersion),policyEnabled:b.policyEnabled,participant:{knowledge:p.knowledge,eligibility:p.eligibility,levelCode:p.levelCode===null?null:text(p.levelCode),revision:p.revision},ownCode:{knowledge:code.knowledge,code:code.code},inviter:parent(b.inviter),leader:parent(b.leader)};
}
function binding(value:any,userId:string):InvitationRelation{const r=object(value);if(r.childUserId!==userId)throw new WalletRequestError(401,'IDENTITY_CHANGED');if(r.type!=='DISTRIBUTION_LEADER'||r.parentUserId===userId)throw bad();return{id:text(r.id),type:r.type,childUserId:userId,parentUserId:text(r.parentUserId),policyVersion:text(r.policyVersion)};}
async function request(path:string,body?:LeaderBindingBody,key?:string,signal?:AbortSignal){let r:Response;try{r=await fetch('/api/account/distribution'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal,...(body?{headers:{'content-type':'application/json','idempotency-key':key!},body:JSON.stringify(body)}:{})});}catch{throw new WalletRequestError(0,'NETWORK_ERROR');}const b=await r.json().catch(()=>null);if(!r.ok)throw new WalletRequestError(r.status,typeof b?.error?.code==='string'?b.error.code:'INTERNAL_ERROR');return object(b);}
export async function readMyInvitation(userId:string,signal?:AbortSignal){return invitationRead(await request('',undefined,undefined,signal),userId);}
export function inviteesPage(value:unknown,userId:string,type:InviteesPage['type']):InviteesPage{
 const b=object(value);subject(b,userId);
 if(!['KNOWN','UNKNOWN'].includes(b.knowledge)||!Array.isArray(b.items)||(b.knowledge==='KNOWN')!==(b.count!==null)||b.type!==undefined&&b.type!==type)throw bad();
 const count=(v:any):string|null=>{if(v===null)return null;if(typeof v!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v))throw bad();return v;};
 const total=count(b.count),mapped=count(b.mappedRelationCount===undefined?total:b.mappedRelationCount),snapshot=b.snapshotVersion==null?null:text(b.snapshotVersion,128),nextCursor=b.nextCursor===null?null:text(b.nextCursor,4096);
 if(b.knowledge==='KNOWN'&&mapped!==total||mapped!==null&&BigInt(mapped)<BigInt(b.items.length))throw bad();
 if(b.knowledge==='UNKNOWN'&&(b.items.length||nextCursor)&&(mapped===null||snapshot===null||b.type!==type))throw bad();
 if(nextCursor&&!b.items.length)throw bad();
 const items=b.items.map((i:any)=>{object(i);if(!['INVITER','DISTRIBUTION_LEADER'].includes(i.type)||type!=='ALL'&&i.type!==type)throw bad();const sourceType=text(i.sourceType),unknown=sourceType==='LEGACY_MYSQL'||i.boundAtKnowledge==='UNKNOWN';return{id:text(i.id),type:i.type as 'INVITER'|'DISTRIBUTION_LEADER',nickname:text(i.nickname,256),boundAt:unknown?null:text(i.boundAt,40),boundAtKnowledge:unknown?'UNKNOWN' as const:'KNOWN' as const,sourceType};});
 if(new Set(items.map((i:InviteesPage['items'][number])=>i.id)).size!==items.length)throw bad();
 return{knowledge:b.knowledge,type,snapshotVersion:snapshot,count:total,mappedRelationCount:mapped,nextCursor,items};
}
export async function readMyInvitees(userId:string,type:'ALL'|'INVITER'|'DISTRIBUTION_LEADER',cursor?:string,signal?:AbortSignal):Promise<InviteesPage>{
 const q=new URLSearchParams({type,limit:'20'});if(cursor)q.set('cursor',cursor);return inviteesPage(await request('/invitees?'+q,undefined,undefined,signal),userId,type);
}
const markerKey=(userId:string)=>'zzsh.invitation.binding.pending.v1:'+userId;
export function pendingLeaderBinding(userId:string):Pending|null{const raw=localStorage.getItem(markerKey(userId));if(raw===null)return null;try{const p=object(JSON.parse(raw)),b=object(p.body);if(p.version!==1||p.userId!==userId||!/^[A-Za-z0-9._:-]{1,128}$/.test(p.key)||!/^[A-Za-z0-9_-]{1,30}$/.test(b.code)||!/^[1-9]\d{0,18}$/.test(b.expectedParticipantRevision))throw Error();text(b.policyVersion);return p;}catch{throw new WalletRequestError(409,'PENDING_MARKER_UNREADABLE');}}
export async function bindLeader(userId:string,body:LeaderBindingBody,canAct:()=>boolean){
 if(!navigator.locks)throw new WalletRequestError(409,'WRITE_LOCK_UNAVAILABLE');return navigator.locks.request(markerKey(userId),{ifAvailable:true},async lock=>{
  if(!lock||pendingLeaderBinding(userId))throw new WalletRequestError(409,'BINDING_UNRESOLVED');if(!canAct())throw new WalletRequestError(401,'IDENTITY_CHANGED');
  const p:Pending={version:1,userId,key:'leader-bind-'+crypto.randomUUID().replaceAll('-',''),body};localStorage.setItem(markerKey(userId),JSON.stringify(p));if(pendingLeaderBinding(userId)?.key!==p.key)throw new WalletRequestError(409,'WRITE_MARKER_UNAVAILABLE');
  let accepted=false;try{const result=binding((await request('/bind',body,p.key)).relation,userId);accepted=true;if(!canAct())throw new WalletRequestError(401,'IDENTITY_CHANGED');const read=await readMyInvitation(userId);if(read.leader.relation?.id!==result.id)throw bad();if(!canAct())throw new WalletRequestError(401,'IDENTITY_CHANGED');localStorage.removeItem(markerKey(userId));return read;}
  catch(e){if(!accepted&&e instanceof WalletRequestError&&[400,403,404,409,413,422].includes(e.status))localStorage.removeItem(markerKey(userId));throw e;}
 });
}
/** An unresolved write never repeats POST: original receipt, then original relation read. */
export async function recoverLeaderBinding(userId:string,canAct:()=>boolean){const p=pendingLeaderBinding(userId);if(!p||!canAct())return null;const b=await request('/bind/receipt?key='+encodeURIComponent(p.key));subject(b,userId);if(!['KNOWN','UNKNOWN'].includes(b.knowledge)||(b.knowledge==='KNOWN')!==(b.receipt!==null))throw bad();if(b.knowledge==='UNKNOWN')return null;const original=binding(object(b.receipt).relation,userId),read=await readMyInvitation(userId);if(read.leader.relation?.id!==original.id)throw bad();if(!canAct())throw new WalletRequestError(401,'IDENTITY_CHANGED');if(pendingLeaderBinding(userId)?.key!==p.key)throw new WalletRequestError(409,'WRITE_MARKER_CHANGED');localStorage.removeItem(markerKey(userId));return read;}
