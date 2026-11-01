import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, type EffectiveAdminAccess } from "../auth/admin-authorization";
import { assertAdminContextInTransaction, type AdminContext } from "../auth/auth-security";
import { assertUserContextInTransaction, assertActiveInTransaction, type UserContext } from "../auth/user-identity";
import { SecurityApiError, recordAudit, withTransaction } from "../auth/security-core";
import { readSettlementStages } from "../order/settlement-record";
import type { ConsultationRouteOptions } from "./consultation";
import { lockSupportMutation } from "./support-dispatch";

export type AftersaleState = "PENDING" | "RESOLVED";
type Actor = ({realm:"user"}&UserContext)|({realm:"admin"}&AdminContext);
type Row = {
  id:string; app_id:string; order_source:"NATIVE"; order_id:string; requester_user_id:string; requester_party:"RENTER"|"OWNER";
  description:string; state:AftersaleState; handler_admin_id:string|null; result:string|null; resolved_by_admin_id:string|null;
  resolved_at:Date|null; operation_id:string; resolve_operation_id:string|null; version:number; created_at:Date; updated_at:Date;
  display_no:string|null; live_admin_id:string|null; effective_admin_id:string|null; handler_name:string|null; cursor_time:string;
};
export type AftersaleView = {
  id:string; orderSource:"NATIVE"; orderId:string; orderDisplayNo:string|null; requesterParty:"RENTER"|"OWNER";
  description:string; state:AftersaleState; result:string|null; version:number;
  handler:{id:string;name:string}|null; createdAt:string; updatedAt:string; resolvedAt:string|null;
};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const invalid=(message:string)=>new SecurityApiError(400,"INVALID_ARGUMENT",message);
const conflict=(message:string)=>new SecurityApiError(409,"CONFLICT",message);
const notFound=()=>new SecurityApiError(404,"NOT_FOUND","Aftersale record not found");
export async function assertAftersaleUserActive(client:PoolClient,userId:string):Promise<void>{
  try{await assertActiveInTransaction(client,userId,"READ");}
  catch(error){if(error instanceof SecurityApiError&&error.status===401)throw Object.assign(conflict("对方账号当前不可联系，请保留售后记录并人工跟进。"),{reason:"AFTERSALE_USER_UNAVAILABLE"});throw error;}
}
const effective=`a.handler_admin_id`;
const fields=`a.*,o.display_no,live.assigned_admin_id AS live_admin_id,
  ${effective} AS effective_admin_id,
  au.name AS handler_name,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
const from=`FROM zzsh_iam.im_aftersale_record a JOIN zzsh_order.rental_order o ON o.id=a.order_id
  LEFT JOIN LATERAL (SELECT c.assigned_admin_id FROM zzsh_iam.im_support_thread t
    JOIN zzsh_iam.im_consultation c ON c.thread_id=t.id AND c.app_id=t.app_id
    WHERE t.app_id=a.app_id AND t.user_id=a.requester_user_id AND t.kind='SERVICE' AND c.state='ACTIVE'
    ORDER BY c.created_at DESC,c.id DESC LIMIT 1) live ON true
  LEFT JOIN zzsh_auth_admin."user" au ON au.id=(${effective})`;
function view(row:Row):AftersaleView {
  return {id:row.id,orderSource:row.order_source,orderId:row.order_id,orderDisplayNo:row.display_no,requesterParty:row.requester_party,
    description:row.description,state:row.state,result:row.result,version:row.version,
    handler:row.effective_admin_id?{id:row.effective_admin_id,name:row.handler_name?.trim()||"客服"}:null,
    createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),resolvedAt:row.resolved_at?new Date(row.resolved_at).toISOString():null};
}
function object(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid("Invalid aftersale input");
  return value as Record<string,unknown>;
}
export function aftersaleId(value:unknown):string {
  if(typeof value!=="string"||!ID.test(value))throw invalid("Invalid aftersale reference");return value;
}
function text(value:unknown):string {
  if(typeof value!=="string"||!value.trim()||value.length>1000||Buffer.byteLength(value,"utf8")>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw invalid("请填写1–1000字的问题或处理说明。");
  return value.replaceAll("\r\n","\n").trim();
}
function operation(value:unknown):string {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{16,80}$/.test(value))throw invalid("Invalid operation identity");return value;}
export function parseAftersaleCreate(value:unknown) {
  const b=object(value,["orderSource","orderId","description","operationId"]);
  if(b.orderSource!=="NATIVE")throw invalid("Order source is not available for aftersale records");
  return {orderSource:"NATIVE" as const,orderId:aftersaleId(b.orderId),description:text(b.description),operationId:operation(b.operationId)};
}
export function parseAftersaleResolve(value:unknown) {
  const b=object(value,["version","result","operationId"]);
  if(!Number.isSafeInteger(b.version)||(b.version as number)<1)throw invalid("Invalid record version");
  return {version:b.version as number,result:text(b.result),operationId:operation(b.operationId)};
}
export function parseAftersaleClaim(value:unknown) {
  const b=object(value,["version"]);if(!Number.isSafeInteger(b.version)||(b.version as number)<1)throw invalid("Invalid record version");return b.version as number;
}
async function adminAccess(client:PoolClient,context:AdminContext,write=false):Promise<EffectiveAdminAccess> {
  await assertAdminContextInTransaction(client,context);const access=await loadEffectiveAdminAccess(client,context.userId);
  if(!access||!hasPermission(access,ADMIN_PERMISSION.imSupportRead)||write&&!hasPermission(access,ADMIN_PERMISSION.imSupportAccept))throw new SecurityApiError(403,"FORBIDDEN","Permission required");
  return access;
}
function management(access:EffectiveAdminAccess) {return access.isBoss||hasPermission(access,ADMIN_PERMISSION.imSupportManagementRead);}
function canRead(row:Row,actor:Actor,access?:EffectiveAdminAccess) {
  if(actor.realm==="user")return row.requester_user_id===actor.userId;
  return Boolean(access&&(management(access)||row.effective_admin_id===actor.userId||row.state==="PENDING"&&row.effective_admin_id===null&&hasPermission(access,ADMIN_PERMISSION.imSupportAccept)));
}
async function rowById(client:PoolClient,appId:string,id:string,lock=false):Promise<Row> {
  const row=(await client.query<Row>(`SELECT ${fields} ${from} WHERE a.app_id=$1 AND a.id=$2${lock?" FOR UPDATE OF a":""}`,[appId,id])).rows[0];
  if(!row)throw notFound();return row;
}
export async function readAftersaleForAdmin(options:ConsultationRouteOptions,context:AdminContext,id:string,write=false) {
  return withTransaction(options.pool,async client=>{const access=await adminAccess(client,context,write),row=await rowById(client,options.appId,id);
    if(!canRead(row,{...context,realm:"admin"},access))throw notFound();return {requesterUserId:row.requester_user_id,record:view(row),liveAdminId:row.live_admin_id};});
}
export async function createAftersale(options:ConsultationRouteOptions,context:UserContext,value:unknown,requestId:string) {
  const input=parseAftersaleCreate(value);
  return withTransaction(options.pool,async client=>{
    await lockSupportMutation(client,options.appId,[context.userId]);
    await assertUserContextInTransaction(client,context);
    const owned=(await client.query<{party:"RENTER"|"OWNER"}>(`SELECT CASE WHEN renter_user_id=$2 THEN 'RENTER' ELSE 'OWNER' END AS party
      FROM zzsh_order.rental_order WHERE id=$1 AND (renter_user_id=$2 OR owner_user_id=$2)`,[input.orderId,context.userId])).rows[0];
    if(!owned)throw new SecurityApiError(404,"NOT_FOUND","Order not found");
    const replay=(await client.query<{id:string;order_id:string;description:string}>(`SELECT id,order_id,description FROM zzsh_iam.im_aftersale_record WHERE app_id=$1 AND requester_user_id=$2 AND operation_id=$3`,[options.appId,context.userId,input.operationId])).rows[0];
    if(replay){if(replay.order_id!==input.orderId||replay.description!==input.description)throw conflict("Operation identity was reused with different input");return {record:view(await rowById(client,options.appId,replay.id)),created:false,replayed:true};}
    const pending=(await client.query<{id:string}>(`SELECT id FROM zzsh_iam.im_aftersale_record WHERE app_id=$1 AND requester_user_id=$2 AND order_id=$3 AND order_source='NATIVE' AND state='PENDING'`,[options.appId,context.userId,input.orderId])).rows[0];
    if(pending)return {record:view(await rowById(client,options.appId,pending.id)),created:false,replayed:false};
    if((await readSettlementStages(client,[input.orderId],context.userId)).get(input.orderId)?.code!=="POSTED")throw conflict("只有已确认结算的订单可以提交售后记录。");
    const id="AS"+randomUUID().replaceAll("-","").toUpperCase();
    await client.query(`INSERT INTO zzsh_iam.im_aftersale_record(id,app_id,order_source,order_id,requester_user_id,requester_party,description,operation_id,handler_admin_id)
      VALUES($1,$2,'NATIVE',$3,$4,$5,$6,$7,(SELECT c.assigned_admin_id FROM zzsh_iam.im_support_thread t JOIN zzsh_iam.im_consultation c ON c.thread_id=t.id AND c.app_id=t.app_id
        WHERE t.app_id=$2 AND t.user_id=$4 AND t.kind='SERVICE' AND c.state='ACTIVE' ORDER BY c.created_at DESC,c.id DESC LIMIT 1))`,[id,options.appId,input.orderId,context.userId,owned.party,input.description,input.operationId]);
    await recordAudit(client,{actorType:"user",actorId:context.userId,sessionId:context.sessionId,action:"im.aftersale.created",objectType:"im_aftersale_record",objectId:id,outcome:"SUCCESS",requestId,details:{orderSource:"NATIVE",orderId:input.orderId,settlementStage:"POSTED",operationId:input.operationId}});
    return {record:view(await rowById(client,options.appId,id)),created:true,replayed:false};
  });
}
export async function listAftersales(options:ConsultationRouteOptions,actor:Actor,input:{orderId?:string;orderSource?:string;state?:string;cursor?:string}) {
  if(input.orderId)aftersaleId(input.orderId);
  const filter=actor.realm==="user"?"ALL":input.state??"PENDING";
  if(!["ALL","PENDING","RESOLVED"].includes(filter))throw invalid("Invalid aftersale state");
  if(actor.realm==="user"&&(!input.orderId||input.orderSource!=="NATIVE"))throw invalid("Order reference and source required");
  const scope=JSON.stringify([options.appId,actor.realm,actor.userId,input.orderId??null,filter]);
  let before:{time:string;id:string}|null=null;
  if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,"base64url").toString());if(input.cursor.length>2048||!Array.isArray(c)||c.length!==3||c[0]!==scope||typeof c[1]!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,6}Z$/.test(c[1])||!Number.isFinite(Date.parse(c[1]))||typeof c[2]!=="string"||!ID.test(c[2]))throw Error();before={time:c[1],id:c[2]};}catch{throw invalid("Invalid aftersale cursor");}}
  return withTransaction(options.pool,async client=>{
    const access=actor.realm==="admin"?await adminAccess(client,actor):null;
    if(actor.realm==="user")await assertUserContextInTransaction(client,actor,"READ");
    let canSubmit=false;
    if(actor.realm==="user"){
      const owned=await client.query(`SELECT 1 FROM zzsh_order.rental_order WHERE id=$1 AND (renter_user_id=$2 OR owner_user_id=$2)`,[input.orderId,actor.userId]);if(!owned.rowCount)throw new SecurityApiError(404,"NOT_FOUND","Order not found");
      canSubmit=(await readSettlementStages(client,[input.orderId!],actor.userId)).get(input.orderId!)?.code==="POSTED";
    }
    const rows=(await client.query<Row>(`SELECT ${fields} ${from} WHERE a.app_id=$1 AND ($2::text IS NULL OR a.order_id=$2)
      AND ($3='ALL' OR a.state=$3) AND ($4::boolean OR ($5='user' AND a.requester_user_id=$6) OR ($5='admin' AND
        ((${effective})=$6 OR a.state='PENDING' AND (${effective}) IS NULL AND $9::boolean)))
      AND ($7::timestamptz IS NULL OR (a.created_at,a.id)<($7::timestamptz,$8::text)) ORDER BY a.created_at DESC,a.id DESC LIMIT 51`,
      [options.appId,input.orderId??null,filter,Boolean(access&&management(access)),actor.realm,actor.userId,before?.time??null,before?.id??null,Boolean(access&&hasPermission(access,ADMIN_PERMISSION.imSupportAccept))])).rows;
    const page=rows.slice(0,50),last=page.at(-1);
    return {items:page.map(view),canSubmit,nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify([scope,last.cursor_time,last.id])).toString("base64url"):null};
  });
}
export async function claimAftersale(options:ConsultationRouteOptions,context:AdminContext,id:string,version:number,requestId:string) {
  return withTransaction(options.pool,async client=>{
    await lockSupportMutation(client,options.appId,[],[context.userId]);
    const access=await adminAccess(client,context,true),row=await rowById(client,options.appId,id,true);
    if(!canRead(row,{...context,realm:"admin"},access))throw notFound();
    if(row.state!=="PENDING")throw conflict("该售后记录已处理。");
    if(row.effective_admin_id===context.userId&&row.handler_admin_id===context.userId)return {record:view(row)};
    if(row.live_admin_id&&row.live_admin_id!==context.userId)throw conflict("当前已有客服接待，请先在咨询中完成转交或接管。");
    if(row.handler_admin_id&&row.handler_admin_id!==context.userId&&!hasPermission(access,ADMIN_PERMISSION.imSupportAuditTakeover))throw new SecurityApiError(403,"FORBIDDEN","Record is assigned to another agent");
    if(row.version!==version)throw conflict("售后记录已变化，请刷新后重试。");
    await client.query(`UPDATE zzsh_iam.im_aftersale_record SET handler_admin_id=$3,version=version+1,updated_at=clock_timestamp() WHERE app_id=$1 AND id=$2`,[options.appId,id,context.userId]);
    await recordAudit(client,{actorType:"admin",actorId:context.userId,sessionId:context.sessionId,action:"im.aftersale.claimed",objectType:"im_aftersale_record",objectId:id,outcome:"SUCCESS",requestId,details:{previousHandler:row.effective_admin_id}});
    return {record:view(await rowById(client,options.appId,id))};
  });
}
export async function resolveAftersale(options:ConsultationRouteOptions,context:AdminContext,id:string,value:unknown,requestId:string) {
  const input=parseAftersaleResolve(value);
  return withTransaction(options.pool,async client=>{
    await lockSupportMutation(client,options.appId,[],[context.userId]);
    const access=await adminAccess(client,context,true),row=await rowById(client,options.appId,id,true);
    if(!canRead(row,{...context,realm:"admin"},access))throw notFound();
    if(row.state==="RESOLVED"){
      if(row.resolved_by_admin_id===context.userId&&row.resolve_operation_id===input.operationId&&row.result===input.result)return {record:view(row),replayed:true};
      throw conflict("该售后记录已处理，请刷新核对。");
    }
    if(row.effective_admin_id!==context.userId)throw new SecurityApiError(403,"FORBIDDEN","请先领取或通过咨询接管此记录。");
    if(row.version!==input.version)throw conflict("售后记录已变化，请刷新后重试。");
    await client.query(`UPDATE zzsh_iam.im_aftersale_record SET state='RESOLVED',handler_admin_id=$3,result=$4,resolved_by_admin_id=$3,resolved_at=clock_timestamp(),resolve_operation_id=$5,version=version+1,updated_at=clock_timestamp() WHERE app_id=$1 AND id=$2`,[options.appId,id,context.userId,input.result,input.operationId]);
    await recordAudit(client,{actorType:"admin",actorId:context.userId,sessionId:context.sessionId,action:"im.aftersale.resolved",objectType:"im_aftersale_record",objectId:id,outcome:"SUCCESS",requestId,details:{operationId:input.operationId,orderId:row.order_id,consultationHandler:row.live_admin_id}});
    return {record:view(await rowById(client,options.appId,id)),replayed:false};
  });
}
