import {createHmac} from "node:crypto";
import type {PoolClient} from "pg";
import {adminSecurityCommandId} from "./admin-security-commands";
import {SecurityApiError} from "./security-core";
import type {RealNameVerificationResult} from "./user-identity";
import {legalDigest,parseLegalAcceptanceRef,readCurrentPlatformDocuments} from "../legal/legal-documents";

export type RealNameVerificationPolicy={dailyLimit:number;minIntervalSeconds:number};
export type IdentityVerificationReceipt={status:"VERIFIED"|"REJECTED"|"UNKNOWN";ageStatus:"ADULT"|"MINOR"|"UNKNOWN";version:number;
  message:string;previousIdentityPreserved?:true;currentIdentity?:{status:"VERIFIED";ageStatus:"ADULT"|"MINOR"|"UNKNOWN"}};
export const IDENTITY_PROVIDER_DISCLOSURE={versionId:"identity-provider-transfer-v1" as const,
  body:"为完成本次实名认证，您同意将本次填写的姓名、身份证号码提交至阿里云二要素核验服务。结果用于实名认证与交易资格判断，平台仅保存受保护的摘要和脱敏展示记录。"};
export const MARKET_IDENTITY_PROVIDER_DISCLOSURE={versionId:"identity-provider-transfer-market-v1" as const,
  body:"为完成本次实名认证，您同意将本次填写的姓名、身份证号码提交至阿里云云市场实名认证服务商杭州优必信科技有限公司进行二要素核验。结果用于实名认证与交易资格判断，平台仅保存受保护的摘要和脱敏展示记录。"};
type IdentityProviderDisclosure=typeof IDENTITY_PROVIDER_DISCLOSURE|typeof MARKET_IDENTITY_PROVIDER_DISCLOSURE;
export type IdentityVerificationConsent={accepted:true;versionId:string;digest:string;disclosureVersion:IdentityProviderDisclosure["versionId"]};
export type IdentityVerificationAttempt={userId:string;keyDigest:string;requestDigest:string;consent?:IdentityVerificationConsent};

export function identityProviderDisclosure(provider:unknown):IdentityProviderDisclosure{
  return provider==="aliyun-market-id2"?MARKET_IDENTITY_PROVIDER_DISCLOSURE:IDENTITY_PROVIDER_DISCLOSURE;
}

export function parseIdentityVerificationConsent(value:unknown,disclosure:IdentityProviderDisclosure=IDENTITY_PROVIDER_DISCLOSURE):IdentityVerificationConsent{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new SecurityApiError(400,"INVALID_ARGUMENT","请阅读隐私政策并明确同意本次实名资料核验");
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!["accepted","versionId","digest","disclosureVersion"].includes(key))||input.accepted!==true||input.disclosureVersion!==disclosure.versionId)
    throw new SecurityApiError(400,"INVALID_ARGUMENT","请明确同意当前版本的本次实名资料核验说明");
  const ref=parseLegalAcceptanceRef({versionId:input.versionId,digest:input.digest},"privacyAcceptance");
  return{...ref,accepted:true,disclosureVersion:disclosure.versionId};
}

export async function readIdentityVerificationPrivacy(client:PoolClient){
  const privacy=(await readCurrentPlatformDocuments(client)).privacy;
  return privacy?{versionId:privacy.id,digest:privacy.digest,title:privacy.title,bodyPath:`/api/v1/legal-documents/privacy?version=${encodeURIComponent(privacy.id)}`} :null;
}
type AttemptRow={requestDigest:string;state:"PENDING"|"UNKNOWN"|"COMPLETED";result:IdentityVerificationReceipt|null};
export type AttemptRead={fresh:false;state:AttemptRow["state"];result:IdentityVerificationReceipt|null};
const unavailable=()=>new SecurityApiError(503,"IDENTITY_DEPENDENCY_UNAVAILABLE","实名请求状态暂时无法确认，请保留原请求键查询，不要重新提交");

export class IdentityVerificationRateError extends SecurityApiError{
  constructor(readonly retryAfter:number){super(429,"RATE_LIMITED","实名校验次数或间隔已达到配置限制，请稍后重试");}
}

export function identityVerificationKey(headers:Record<string,string|string[]|undefined>):string{
  const key=adminSecurityCommandId(headers);
  if(!key)throw new SecurityApiError(400,"INVALID_ARGUMENT","实名校验必须提供 Idempotency-Key");
  return key;
}

function digest(key:Buffer|undefined,purpose:string,input:unknown):string{
  if(!key||key.length<32)throw unavailable();
  return createHmac("sha256",key).update(`zzsh:identity-verification:${purpose}:v1\0`).update(JSON.stringify(input)).digest("hex");
}

export function identityVerificationAttempt(userId:string,commandKey:string,fullName:string,documentNumber:string,key:Buffer|undefined,consent?:IdentityVerificationConsent):IdentityVerificationAttempt{
  return{userId,keyDigest:digest(key,"key",[userId,commandKey]),requestDigest:digest(key,"request",[userId,fullName.trim().normalize("NFC"),documentNumber,consent??null]),...(consent?{consent}:{})};
}

/** The caller holds the user row lock. Existing keys are always resolved before new-cost admission. */
export async function beginIdentityVerification(client:PoolClient,attempt:IdentityVerificationAttempt,policy:RealNameVerificationPolicy|undefined,
  preflight:()=>Promise<void>):Promise<AttemptRead|{fresh:true}>{
  try{
    const previous=(await client.query<AttemptRow>(`/* identity-verification-attempt-read */ SELECT request_digest AS "requestDigest",state,result
      FROM zzsh_iam.user_identity_verification_attempt WHERE user_id=$1 AND key_digest=$2`,[attempt.userId,attempt.keyDigest])).rows[0];
    if(previous){
      if(previous.requestDigest!==attempt.requestDigest)throw new SecurityApiError(409,"CONFLICT","同一实名请求键不能更改资料");
      return{fresh:false,state:previous.state,result:previous.state==="COMPLETED"?previous.result:null};
    }
    const unresolved=await client.query(`SELECT 1 FROM zzsh_iam.user_identity_verification_attempt WHERE user_id=$1 AND state IN('PENDING','UNKNOWN') LIMIT 1`,[attempt.userId]);
    if(unresolved.rowCount)throw new SecurityApiError(409,"CONFLICT","已有实名请求尚未确认，请在原页面恢复查询或联系客服核实，勿更换请求键重新提交");
    if(!attempt.consent)throw new SecurityApiError(400,"INVALID_ARGUMENT","请明确同意本次实名资料核验");
    if(!policy||!Number.isSafeInteger(policy.dailyLimit)||policy.dailyLimit<1||!Number.isSafeInteger(policy.minIntervalSeconds)||policy.minIntervalSeconds<1)throw unavailable();
    const rate=(await client.query<{dailyCount:string;elapsed:string|null;dayRemaining:string}>(`/* identity-verification-rate */ SELECT
      count(*) FILTER(WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS "dailyCount",
      extract(epoch FROM clock_timestamp()-max(created_at))::text AS elapsed,
      extract(epoch FROM ((date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC')-clock_timestamp())::text AS "dayRemaining"
      FROM zzsh_iam.user_identity_verification_attempt WHERE user_id=$1`,[attempt.userId])).rows[0];
    if(!rate||!/^\d+$/.test(rate.dailyCount)||!Number.isFinite(Number(rate.dayRemaining))||rate.elapsed!==null&&!Number.isFinite(Number(rate.elapsed)))throw unavailable();
    if(Number(rate.dailyCount)>=policy.dailyLimit)throw new IdentityVerificationRateError(Math.max(1,Math.ceil(Number(rate.dayRemaining))));
    if(rate.elapsed!==null&&Number(rate.elapsed)<policy.minIntervalSeconds)throw new IdentityVerificationRateError(Math.max(1,Math.ceil(policy.minIntervalSeconds-Number(rate.elapsed))));
    await preflight();
    const privacy=await readIdentityVerificationPrivacy(client);
    if(!privacy)throw new SecurityApiError(503,"IDENTITY_DEPENDENCY_UNAVAILABLE","平台隐私政策尚未发布，实名资料核验暂未开放");
    if(privacy.versionId!==attempt.consent.versionId||privacy.digest!==attempt.consent.digest)throw new SecurityApiError(409,"CONFLICT","隐私政策已更新，请重新阅读并确认本次核验");
    const disclosure=attempt.consent.disclosureVersion===MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId?MARKET_IDENTITY_PROVIDER_DISCLOSURE:IDENTITY_PROVIDER_DISCLOSURE;
    await client.query(`INSERT INTO zzsh_iam.user_identity_verification_attempt(user_id,key_digest,request_digest,state,
      privacy_version_id,privacy_digest,disclosure_version,disclosure_digest,consented_at)
      VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,clock_timestamp())`,[attempt.userId,attempt.keyDigest,attempt.requestDigest,
      privacy.versionId,privacy.digest,disclosure.versionId,legalDigest(disclosure.body)]);
    return{fresh:true};
  }catch(error){if(error instanceof SecurityApiError)throw error;throw unavailable();}
}

/** Self-scoped read only: a pending/unknown request is never a permission to call the provider again. */
export async function readIdentityVerification(client:Pick<PoolClient,"query">,userId:string,commandKey:string,key:Buffer|undefined):Promise<AttemptRead>{
  const row=(await client.query<AttemptRow>(`/* identity-verification-attempt-recover */ SELECT state,result,request_digest AS "requestDigest"
    FROM zzsh_iam.user_identity_verification_attempt WHERE user_id=$1 AND key_digest=$2`,[userId,digest(key,"key",[userId,commandKey])])).rows[0];
  if(!row)throw new SecurityApiError(404,"NOT_FOUND","实名请求记录不存在");
  return{fresh:false,state:row.state,result:row.state==="COMPLETED"?row.result:null};
}

/** Save the external observation before changing eligibility. Any later failure remains recoverable without another paid call. */
export async function observeIdentityVerification(client:PoolClient,attempt:IdentityVerificationAttempt,result:RealNameVerificationResult|null):Promise<void>{
  const saved=await client.query(`UPDATE zzsh_iam.user_identity_verification_attempt SET state='UNKNOWN',provider_result=$4::jsonb,updated_at=clock_timestamp()
    WHERE user_id=$1 AND key_digest=$2 AND request_digest=$3 AND state='PENDING'`,[attempt.userId,attempt.keyDigest,attempt.requestDigest,
    result?JSON.stringify({status:result.status,ageStatus:result.ageStatus,provider:result.provider,providerReference:result.providerReference}):null]);
  if(saved.rowCount!==1)throw unavailable();
}

/** The identity, current subject/profile and this completed receipt commit together. */
export async function completeIdentityVerification(client:PoolClient,attempt:IdentityVerificationAttempt,result:IdentityVerificationReceipt):Promise<void>{
  const saved=await client.query(`UPDATE zzsh_iam.user_identity_verification_attempt SET state='COMPLETED',result=$4::jsonb,updated_at=clock_timestamp()
    WHERE user_id=$1 AND key_digest=$2 AND request_digest=$3 AND state='UNKNOWN' AND provider_result IS NOT NULL`,
    [attempt.userId,attempt.keyDigest,attempt.requestDigest,JSON.stringify(result)]);
  if(saved.rowCount!==1)throw unavailable();
}
