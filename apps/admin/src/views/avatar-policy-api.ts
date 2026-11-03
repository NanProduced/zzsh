import { adminRequest, AdminApiError } from "../api";
export type AvatarPolicy = { requiresReview: boolean; revision: string; available: boolean };
export type PolicyCommand = { actorId: string; sessionId: string; key: string; requiresReview: boolean; expectedRevision: string };
const revision = /^(?:0|[1-9]\d{0,18})$/;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("头像审核策略返回格式不正确"); return value as Record<string,unknown>; }
export function parseAvatarPolicy(value: unknown): AvatarPolicy {
  const row=object(value);
  if(typeof row.requiresReview!=="boolean" || typeof row.available!=="boolean" || typeof row.revision!=="string" || !revision.test(row.revision) || (row.available ? row.revision==="0" : row.requiresReview!==true || row.revision!=="0")) throw new Error("头像审核策略返回格式不正确");
  return {requiresReview:row.requiresReview,revision:row.revision,available:row.available};
}
export async function readAvatarPolicy(signal?: AbortSignal) {
  const row=object(await adminRequest("/profile-avatars/policy",undefined,"GET",{},signal));
  if(typeof row.canManage!=="boolean") throw new Error("头像审核策略权限返回格式不正确");
  return {policy:parseAvatarPolicy(row.policy),canManage:row.canManage};
}
export async function writeAvatarPolicy(command: PolicyCommand,signal?:AbortSignal) {
  const row=object(await adminRequest("/profile-avatars/policy",{requiresReview:command.requiresReview,expectedRevision:command.expectedRevision},"POST",{"idempotency-key":command.key},signal));
  const policy=parseAvatarPolicy(row.policy);
  if(!policy.available || policy.requiresReview!==command.requiresReview || typeof row.changed!=="boolean" || BigInt(policy.revision)!==BigInt(command.expectedRevision)+(row.changed?1n:0n)) throw new Error("头像审核策略保存回执不一致，请读取原结果");
  return policy;
}
export async function recoverAvatarPolicy(command:PolicyCommand,signal?:AbortSignal) {
  const query=new URLSearchParams({requiresReview:String(command.requiresReview),expectedRevision:command.expectedRevision});
  const row=object(await adminRequest("/profile-avatars/policy/operation-result?"+query,undefined,"GET",{"idempotency-key":command.key},signal));
  if(row.receipt==="UNRESOLVED") return {receipt:"UNRESOLVED" as const};
  if(row.receipt!=="RECORDED" || !Number.isInteger(row.responseStatus) || Number(row.responseStatus)<100 || Number(row.responseStatus)>599) throw new Error("原策略操作回执尚未确认");
  if(Number(row.responseStatus)<300){
    const result=object(row.result),policy=parseAvatarPolicy(result.policy);
    if(policy.requiresReview!==command.requiresReview || typeof result.changed!=="boolean" || BigInt(policy.revision)!==BigInt(command.expectedRevision)+(result.changed?1n:0n))throw new Error("原策略保存回执不一致，暂不能解除待确认记录");
  }
  return {receipt:"RECORDED" as const,responseStatus:Number(row.responseStatus)};
}
// Reauthentication must not discard the same actor's unresolved command.
function storageKey(actorId:string){return "zzsh.admin.avatar-policy:"+actorId;}
export function readPolicyCommand(actorId:string):PolicyCommand|null {
  const raw=window.sessionStorage.getItem(storageKey(actorId)); if(raw===null)return null;
  const value=JSON.parse(raw) as PolicyCommand;
  if(value.actorId!==actorId || typeof value.sessionId!=="string" || !value.sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.key) || typeof value.requiresReview!=="boolean" || !/^[1-9]\d{0,18}$/.test(value.expectedRevision))throw new Error("原策略操作记录不可读，暂不能重新提交");
  return value;
}
export function savePolicyCommand(command:PolicyCommand){window.sessionStorage.setItem(storageKey(command.actorId),JSON.stringify(command));}
export function clearPolicyCommand(command:PolicyCommand){window.sessionStorage.removeItem(storageKey(command.actorId));}
export function isPolicyRejection(error:unknown){return error instanceof AdminApiError && [400,401,403,404,409,413,415,422,429].includes(error.status);}
