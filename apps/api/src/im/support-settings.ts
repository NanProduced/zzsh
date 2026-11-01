import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { assertAdminContextInTransaction, type AdminContext } from "../auth/auth-security";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import type { ConsultationRouteOptions, ConsultationEntryIntent } from "./consultation";

export const DEFAULT_SUPPORT_WELCOME = {
  SERVICE: ["您好，欢迎光临洲洲商行，很高兴为您服务～", "账号、订单或售后问题都可以直接发在这里，客服会尽快为您处理。"],
  COMPLAINT: ["抱歉给您带来不好的体验，您的反馈已记录。", "请把具体情况发在这里，客服会尽快跟进处理。"],
} as const;
type Settings = { version: number; serviceMessage: string; complaintMessage: string; updatedAt: string | null };
type Row = Settings & { operationId: string; updatedBy: string };
const columns = `version,service_message AS "serviceMessage",complaint_message AS "complaintMessage",updated_at AS "updatedAt",operation_id AS "operationId",updated_by AS "updatedBy"`;
export function parseSupportSettings(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid assistant settings");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["version","serviceMessage","complaintMessage","operationId"].includes(k)) || !Number.isSafeInteger(b.version) || (b.version as number)<0 || typeof b.operationId!=="string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(b.operationId)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid assistant settings version or operation");
  const text = (value: unknown) => {
    if (typeof value!=="string" || !value.trim() || value.length>1000 || Buffer.byteLength(value,"utf8")>3000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]|\$\{/.test(value)) throw new SecurityApiError(400,"INVALID_ARGUMENT","欢迎消息须为 1–1000 字的纯文本，暂不支持变量。");
    return value.replaceAll("\r\n","\n").trim();
  };
  return {version:b.version as number,operationId:b.operationId,serviceMessage:text(b.serviceMessage),complaintMessage:text(b.complaintMessage)};
}
async function readRow(client:PoolClient,appId:string) {
  return (await client.query<Row>(`SELECT ${columns} FROM zzsh_iam.im_support_settings WHERE app_id=$1`,[appId])).rows[0];
}
function view(row?:Row):Settings {
  return row ? {version:row.version,serviceMessage:row.serviceMessage,complaintMessage:row.complaintMessage,updatedAt:new Date(row.updatedAt!).toISOString()} : {version:0,serviceMessage:DEFAULT_SUPPORT_WELCOME.SERVICE.join("\n"),complaintMessage:DEFAULT_SUPPORT_WELCOME.COMPLAINT.join("\n"),updatedAt:null};
}
export async function readSupportWelcome(client:PoolClient,appId:string,intent:ConsultationEntryIntent):Promise<readonly string[]> {
  const row=await readRow(client,appId);
  return row ? [intent==="COMPLAINT"?row.complaintMessage:row.serviceMessage] : DEFAULT_SUPPORT_WELCOME[intent];
}
export async function supportSettings(options:ConsultationRouteOptions,context:AdminContext,body:unknown,requestId:string) {
  const input=body===undefined?undefined:parseSupportSettings(body);
  return withTransaction(options.pool,async client=>{
    await assertAdminContextInTransaction(client,context);
    const access=await loadEffectiveAdminAccess(client,context.userId);
    requirePermission(access,ADMIN_PERMISSION.imSupportManagementRead);
    if(input)requirePermission(access,ADMIN_PERMISSION.imSupportConfigure);
    if(input && !(await client.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked`,["im_support_settings:"+options.appId])).rows[0]?.locked)throw new SecurityApiError(503,"IM_UNAVAILABLE","Assistant settings are busy");
    const current=await readRow(client,options.appId);
    if(!input)return view(current);
    if(current?.operationId===input.operationId){
      if(current.updatedBy!==context.userId || current.serviceMessage!==input.serviceMessage || current.complaintMessage!==input.complaintMessage)throw new SecurityApiError(409,"CONFLICT","Settings operation identity conflict");
      return view(current);
    }
    if((current?.version??0)!==input.version)throw new SecurityApiError(409,"CONFLICT","设置已被其他管理员修改，请重新加载后再保存。");
    const row=(await client.query<Row>(`INSERT INTO zzsh_iam.im_support_settings(app_id,version,service_message,complaint_message,updated_by,operation_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(app_id) DO UPDATE SET version=EXCLUDED.version,service_message=EXCLUDED.service_message,complaint_message=EXCLUDED.complaint_message,updated_by=EXCLUDED.updated_by,operation_id=EXCLUDED.operation_id,updated_at=clock_timestamp() RETURNING ${columns}`,[options.appId,input.version+1,input.serviceMessage,input.complaintMessage,context.userId,input.operationId])).rows[0]!;
    await recordAudit(client,{actorType:"admin",actorId:context.userId,sessionId:context.sessionId,action:"im.support.settings.updated",objectType:"im_support_settings",objectId:options.appId,outcome:"SUCCESS",requestId,details:{version:row.version,operationId:input.operationId}});
    return view(row);
  });
}
