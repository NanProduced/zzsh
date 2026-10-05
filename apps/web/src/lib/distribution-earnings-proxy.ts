import {randomUUID} from 'node:crypto';
import {isHttpOrigin,userCookies,readBoundedBody} from './user-proxy.ts';
import {earningStates,earningsPage,earningsDetail,type EarningFilter} from './distribution-earnings-client.ts';
const api=process.env.ZZSH_API_ORIGIN??'',web=process.env.ZZSH_WEB_ORIGIN??'';
const fail=(status:number,code:string,id:string)=>Response.json({error:{code,message:'收益记录暂时无法读取。',requestId:id}},{status,headers:{'cache-control':'no-store','x-request-id':id}});
export async function GET(request:Request,{params}:{params:Promise<{path?:string[]}>}){
 const requestId='req_earnings_'+randomUUID().replaceAll('-','');if(!isHttpOrigin(api)||!isHttpOrigin(web))return fail(503,'EVIDENCE_UNAVAILABLE',requestId);
 if(request.headers.has('authorization')||request.headers.get('origin')&&request.headers.get('origin')!==web)return fail(403,'FORBIDDEN',requestId);
 const paths=(await params).path??[],q=new URL(request.url).searchParams,state=q.get('state')??'ALL',limit=q.get('limit')??'20';
 if(paths.length>1||paths.length===1&&(!/^(native|history):[A-Za-z0-9_-]{1,180}$/.test(paths[0]!)||q.size))return fail(404,'NOT_FOUND',requestId);
 if([...q.keys()].some(k=>!['state','limit','cursor'].includes(k)||q.getAll(k).length!==1)||!earningStates.includes(state as EarningFilter)||!/^[1-9]\d?$/.test(limit)||Number(limit)>50||q.has('cursor')&&(!q.get('cursor')||q.get('cursor')!.length>4096))return fail(400,'INVALID_ARGUMENT',requestId);
 const url=new URL('/api/v1/users/me/distribution/earnings'+(paths.length?'/'+encodeURIComponent(paths[0]!):''),api);url.search=q.toString();const headers=new Headers({origin:web,'x-request-id':requestId}),cookies=userCookies(request.headers.get('cookie'));if(cookies)headers.set('cookie',cookies);
 try{const deadline=AbortSignal.timeout(15000),response=await fetch(url,{method:'GET',headers,cache:'no-store',redirect:'error',signal:deadline}),body=JSON.parse(new TextDecoder().decode(await readBoundedBody(response,128*1024,deadline)));if(!response.ok)return fail(response.status,typeof body.error?.code==='string'?body.error.code:'EVIDENCE_UNAVAILABLE',requestId);
  if(typeof body.subjectId!=='string'||!body.subjectId||body.subjectId.length>128)throw Error();const projected=paths.length?earningsDetail(body,body.subjectId,paths[0]!):earningsPage(body,body.subjectId,state as EarningFilter);return Response.json(projected,{headers:{'cache-control':'no-store','x-request-id':requestId,'x-content-type-options':'nosniff'}});
 }catch{return fail(502,'EVIDENCE_UNAVAILABLE',requestId);}
}
