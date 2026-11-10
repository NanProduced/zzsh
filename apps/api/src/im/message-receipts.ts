import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";

export type ImSendIntent = { messageClientId: string; messageType: number };
export type ImReceiptMessage = ImSendIntent & { messageServerId: string; conversationId: string; senderId: string; createTime: number };
export type ImReceiptActor = { realm: "user" | "admin"; userId: string; sessionId: string };
export type ImStoredSendIntent = ImSendIntent & { appId: string; threadId: string; roundId: string; conversationId: string; accountId: string; actorId: string; realm: "user" | "admin" };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function imFactId(kind: string, appId: string, accountId: string, messageId: string): string {
  return `im_${kind}_${createHash("sha256").update(JSON.stringify([appId,accountId,messageId])).digest("hex")}`;
}
export function parseImSendIntent(id: unknown, type: unknown): ImSendIntent | undefined {
  if (id === undefined && type === undefined) return undefined;
  if (typeof id !== "string" || !ID.test(id) || typeof type !== "number" || ![0,1,2,3,6].includes(type)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid message intent");
  return {messageClientId:id,messageType:type};
}
export function parseImReceipt(value: unknown): {action:"sent"|"hidden";message:ImReceiptMessage} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid message receipt");
  const body=value as Record<string,unknown>,m=body.message as Record<string,unknown>|undefined;
  if(body.kind!=="receipt"||!["sent","hidden"].includes(String(body.action))||!m||typeof m!=="object"||Array.isArray(m))throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid message receipt");
  if(Object.keys(body).some(k=>!["kind","action","message"].includes(k))||Object.keys(m).some(k=>!["messageClientId","messageServerId","conversationId","senderId","createTime","messageType"].includes(k)))throw new SecurityApiError(400,"INVALID_ARGUMENT","Unexpected receipt fields");
  const intent=body.action==="hidden"&&typeof m.messageClientId==="string"&&ID.test(m.messageClientId)&&typeof m.messageType==="number"&&Number.isInteger(m.messageType)&&m.messageType>=0&&m.messageType<=100?{messageClientId:m.messageClientId,messageType:m.messageType}:parseImSendIntent(m.messageClientId,m.messageType);
  if(!intent||typeof m.messageServerId!=="string"||!/^[1-9][0-9]{0,19}$/.test(m.messageServerId)||typeof m.conversationId!=="string"||!/^[-A-Za-z0-9_@.]{1,32}\|2\|[0-9]{1,19}$/.test(m.conversationId)||typeof m.senderId!=="string"||!/^[-A-Za-z0-9_@.]{1,32}$/.test(m.senderId)||typeof m.createTime!=="number"||!Number.isSafeInteger(m.createTime)||m.createTime<=0)throw new SecurityApiError(400,"INVALID_ARGUMENT","Invalid message receipt");
  return {action:body.action as "sent"|"hidden",message:{...intent,messageServerId:m.messageServerId,conversationId:m.conversationId,senderId:m.senderId,createTime:m.createTime}};
}

/** Existing append-only audit storage supplies a durable unique key; no new business migration. */
export async function storeImSendIntent(client:PoolClient,intent:ImStoredSendIntent,actor:ImReceiptActor):Promise<void>{
  const id=imFactId("send_intent",intent.appId,intent.accountId,intent.messageClientId);
  await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,'im.message.send_authorized','im_consultation',$5,'SUCCESS',$6,clock_timestamp(),$7::jsonb) ON CONFLICT(id) DO NOTHING`,
    [id,actor.realm,actor.userId,actor.sessionId,intent.roundId,id,JSON.stringify(intent)]);
  const stored=(await client.query<{details:ImStoredSendIntent}>(`SELECT details FROM zzsh_iam.audit_event WHERE id=$1`,[id])).rows[0]?.details;
  if(!stored||stored.actorId!==intent.actorId||stored.realm!==intent.realm||stored.conversationId!==intent.conversationId||stored.threadId!==intent.threadId||stored.messageType!==intent.messageType)throw new SecurityApiError(409,"CONFLICT","Message identity was already used in another scope");
}
export async function readImSendIntent(client:PoolClient,appId:string,accountId:string,id:string):Promise<ImStoredSendIntent|null>{
  return (await client.query<{details:ImStoredSendIntent}>(`SELECT details FROM zzsh_iam.audit_event WHERE id=$1`,[imFactId("send_intent",appId,accountId,id)])).rows[0]?.details??null;
}
export async function insertImSentFact(client:PoolClient,appId:string,accountId:string,actor:ImReceiptActor,message:ImReceiptMessage,objectId:string):Promise<boolean>{
  const id=imFactId("sent",appId,accountId,message.messageClientId),details={appId,...message};
  const inserted=await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,'im.message.sent','im_message',$5,'SUCCESS',$1,clock_timestamp(),$6::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [id,actor.realm,actor.userId,actor.sessionId,objectId,JSON.stringify(details)]);
  if(inserted.rowCount)return true;
  const prior=(await client.query<{details:typeof details}>(`SELECT details FROM zzsh_iam.audit_event WHERE id=$1`,[id])).rows[0]?.details;
  if(!prior||prior.appId!==appId||prior.messageServerId!==message.messageServerId||prior.conversationId!==message.conversationId||prior.senderId!==message.senderId||prior.messageType!==message.messageType)throw new SecurityApiError(409,"CONFLICT","Conflicting message receipt");
  return false;
}
export async function storeImHiddenFact(client:PoolClient,appId:string,accountId:string,actor:ImReceiptActor,message:ImReceiptMessage):Promise<void>{
  const id=imFactId("hidden",appId,accountId,message.messageServerId);
  await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,'im.message.hidden','im_message',$5,'SUCCESS',$1,clock_timestamp(),$6::jsonb) ON CONFLICT(id) DO NOTHING`,
    [id,actor.realm,actor.userId,actor.sessionId,message.messageServerId,JSON.stringify({appId,conversationId:message.conversationId})]);
}
export async function readImHistoryFilters(client:PoolClient,appId:string,accountId:string,ids:string[]):Promise<{hidden:Set<string>;revoked:Set<string>}>{
  if(!ids.length)return {hidden:new Set(),revoked:new Set()};
  const guards=ids.map(id=>imFactId("revoke_guard",appId,"system",id));
  const operations=(await client.query<{object_id:string;action:string}>(`SELECT DISTINCT ON(object_id) object_id,action FROM zzsh_iam.audit_event WHERE object_type='im_message_revoke' AND object_id=ANY($1::text[]) ORDER BY object_id,occurred_at DESC,id DESC`,[guards])).rows;
  // An unresolved revoke hides only that message; the rest of the page stays readable.
  const guardToMessage=new Map(guards.map((guard,index)=>[guard,ids[index]!]));
  const uncertain=new Set(operations.filter(r=>r.action==="im.message.revoke.started").map(r=>guardToMessage.get(r.object_id)).filter((id):id is string=>Boolean(id)));
  const keys=ids.flatMap(id=>[imFactId("hidden",appId,accountId,id),imFactId("revoked",appId,"system",id)]);
  const rows=(await client.query<{id:string;object_id:string}>(`SELECT id,object_id FROM zzsh_iam.audit_event WHERE id=ANY($1::text[])`,[keys])).rows;
  return {hidden:new Set(rows.filter(r=>r.id.startsWith("im_hidden_")).map(r=>r.object_id)),revoked:new Set([...rows.filter(r=>r.id.startsWith("im_revoked_")).map(r=>r.object_id),...uncertain])};
}

export async function planImRevoke(client:PoolClient,appId:string,accountId:string,actor:ImReceiptActor,message:ImReceiptMessage,requestId:string):Promise<"STARTED"|"SUCCEEDED"|"UNKNOWN">{
  const guard=imFactId("revoke_guard",appId,"system",message.messageServerId);
  const lock=BigInt("0x"+guard.slice(-15)).toString();
  if(!(await client.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock($1::bigint) AS locked`,[lock])).rows[0]?.locked)throw new SecurityApiError(503,"IM_UNAVAILABLE","Message operation busy");
  const last=(await client.query<{action:string}>(`SELECT action FROM zzsh_iam.audit_event WHERE object_type='im_message_revoke' AND object_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,[guard])).rows[0];
  if(last?.action==="im.message.revoke.completed")return "SUCCEEDED";
  if(last?.action==="im.message.revoke.started")return "UNKNOWN";
  await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,'im.message.revoke.started','im_message_revoke',$5,'SUCCESS',$6,clock_timestamp(),$7::jsonb)`,
    [imFactId("revoke_attempt",appId,accountId,requestId),actor.realm,actor.userId,actor.sessionId,guard,requestId,JSON.stringify({appId,accountId,messageServerId:message.messageServerId,conversationId:message.conversationId})]);
  return "STARTED";
}
export async function finishImRevoke(client:PoolClient,appId:string,accountId:string,actor:ImReceiptActor,message:ImReceiptMessage,requestId:string,success:boolean):Promise<void>{
  const guard=imFactId("revoke_guard",appId,"system",message.messageServerId);
  if(!(await client.query<{locked:boolean}>(`SELECT pg_try_advisory_xact_lock($1::bigint) AS locked`,[BigInt("0x"+guard.slice(-15)).toString()])).rows[0]?.locked)throw new SecurityApiError(503,"IM_UNAVAILABLE","Message operation busy");
  const last=(await client.query<{action:string;request_id:string}>(`SELECT action,request_id FROM zzsh_iam.audit_event WHERE object_type='im_message_revoke' AND object_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1`,[guard])).rows[0];
  if(last?.action!=="im.message.revoke.started"||last.request_id!==requestId)throw new SecurityApiError(409,"CONFLICT","Stale message revoke result");
  await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,$5,'im_message_revoke',$6,$7,$8,clock_timestamp(),$9::jsonb)`,
    [imFactId("revoke_result",appId,accountId,requestId),actor.realm,actor.userId,actor.sessionId,success?"im.message.revoke.completed":"im.message.revoke.rejected",guard,success?"SUCCESS":"FAILURE",requestId,JSON.stringify({appId,messageServerId:message.messageServerId})]);
  if(success)await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
    VALUES($1,$2,$3,$4,'im.message.revoked','im_message',$5,'SUCCESS',$6,clock_timestamp(),$7::jsonb) ON CONFLICT(id) DO NOTHING`,
    [imFactId("revoked",appId,"system",message.messageServerId),actor.realm,actor.userId,actor.sessionId,message.messageServerId,requestId,JSON.stringify({appId,conversationId:message.conversationId})]);
  if(success)await client.query(`UPDATE zzsh_iam.im_consultation c SET last_message_preview='[消息已撤回]'
    FROM zzsh_iam.im_support_thread t WHERE c.thread_id=t.id AND c.app_id=$1 AND t.app_id=$1 AND t.message_scope_id=$2
      AND c.last_message_at=to_timestamp($3::double precision/1000)`,[appId,message.conversationId.split("|")[2],message.createTime]);
}
