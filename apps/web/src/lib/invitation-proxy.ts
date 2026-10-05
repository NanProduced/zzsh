import {randomUUID} from 'node:crypto';
import {isHttpOrigin,userCookies,readBoundedBody,BodyTooLargeError} from './user-proxy.ts';
import {invitationRead,inviteesPage,type InviteesPage} from './invitation-client.ts';
const api=process.env.ZZSH_API_ORIGIN??'',web=process.env.ZZSH_WEB_ORIGIN??'';
const fail=(status:number,code:string,id:string)=>Response.json({error:{code,message:'邀请状态暂不可用。未确认的绑定请查询原记录。',requestId:id}},{status,headers:{'cache-control':'no-store','x-request-id':id}});
function object(v:any){if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}
function text(v:any,max=128){if(typeof v!=='string'||!v||v.length>max)throw Error();return v;}
function relation(v:any){const r=object(v);if(r.type!=='DISTRIBUTION_LEADER'||r.childUserId===r.parentUserId)throw Error();return{id:text(r.id),type:r.type,childUserId:text(r.childUserId),parentUserId:text(r.parentUserId),policyVersion:text(r.policyVersion)};}
function project(path:string,body:any,type:InviteesPage['type']){const b=object(body);
 if(path==='')return invitationRead(b,text(b.subjectId));
 if(path==='/bind')return{relation:relation(b.relation),replayed:b.replayed===true};
 if(path==='/bind/receipt'){if(!['KNOWN','UNKNOWN'].includes(b.knowledge)||(b.knowledge==='KNOWN')!==(b.receipt!==null))throw Error();return{subjectId:text(b.subjectId),knowledge:b.knowledge,receipt:b.receipt?{relation:relation(b.receipt.relation),replayed:b.receipt.replayed===true}:null};}
 return{subjectId:text(b.subjectId),...inviteesPage(b,b.subjectId,type),countMeaning:'RELATIONS_NOT_UNIQUE_PEOPLE'};
}
async function proxy(request:Request,{params}:{params:Promise<{path?:string[]}>}){
 const id='req_invitation_'+randomUUID().replaceAll('-','');if(!isHttpOrigin(api)||!isHttpOrigin(web))return fail(503,'EVIDENCE_UNAVAILABLE',id);
 if(request.headers.has('authorization'))return fail(403,'FORBIDDEN',id);const origin=request.headers.get('origin');if(origin&&origin!==web)return fail(403,'FORBIDDEN',id);
 const parts=(await params).path??[],path=parts.length?'/'+parts.join('/'):'',method=request.method,q=new URL(request.url).searchParams;
 if(!(method==='GET'&&['','/invitees','/bind/receipt'].includes(path)||method==='POST'&&path==='/bind'))return fail(404,'NOT_FOUND',id);
 const allowed=path==='/invitees'?['limit','cursor','type']:path==='/bind/receipt'?['key']:[];if([...q.keys()].some(k=>!allowed.includes(k)||q.getAll(k).length!==1)||path==='/bind/receipt'&&(!q.get('key')||!/^[A-Za-z0-9._:-]{1,128}$/.test(q.get('key')!)))return fail(400,'INVALID_ARGUMENT',id);
 const headers=new Headers({origin:web,'x-request-id':id}),cookie=userCookies(request.headers.get('cookie'));if(cookie)headers.set('cookie',cookie);let bytes:string|undefined;
 if(method==='POST'){
  if(origin!==web||request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')return fail(403,'FORBIDDEN',id);
  const key=request.headers.get('idempotency-key');if(!key||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))return fail(400,'INVALID_ARGUMENT',id);
  try{const b=object(JSON.parse(new TextDecoder().decode(await readBoundedBody(request,4096))));if(Object.keys(b).length!==3||Object.keys(b).some(k=>!['code','policyVersion','expectedParticipantRevision'].includes(k))||!/^[A-Za-z0-9_-]{1,30}$/.test(b.code)||!/^[1-9]\d{0,18}$/.test(b.expectedParticipantRevision))throw Error();text(b.policyVersion);bytes=JSON.stringify(b);}catch(e){return fail(e instanceof BodyTooLargeError?413:400,'INVALID_ARGUMENT',id);}
  headers.set('content-type','application/json');headers.set('idempotency-key',key);
 }
 const type=q.get('type')??'ALL';if(!['ALL','INVITER','DISTRIBUTION_LEADER'].includes(type))return fail(400,'INVALID_ARGUMENT',id);
 const url=new URL('/api/v1/users/me/distribution'+path,api);url.search=q.toString();
 try{const deadline=AbortSignal.timeout(15000),upstream=await fetch(url,{method,headers,body:bytes,cache:'no-store',redirect:'error',signal:deadline}),b=JSON.parse(new TextDecoder().decode(await readBoundedBody(upstream,128*1024,deadline)));if(!upstream.ok)return fail(upstream.status,typeof b.error?.code==='string'?b.error.code:'INTERNAL_ERROR',id);return Response.json(project(path,b,type as InviteesPage['type']),{headers:{'cache-control':'no-store','x-request-id':id,'x-content-type-options':'nosniff'}});}catch{return fail(502,method==='POST'?'WRITE_OUTCOME_UNKNOWN':'EVIDENCE_UNAVAILABLE',id);}
}
export const GET=proxy;export const POST=proxy;
