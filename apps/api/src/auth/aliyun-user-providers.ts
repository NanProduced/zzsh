import DysmsClient, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import CloudauthClient, { Id2MetaVerifyRequest } from "@alicloud/cloudauth20190307";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";
import type { AgeStatus, RealNameProvider } from "./user-identity";
import { normalizeMainlandPhone } from "./phone-number";
import { normalizeIdentityDocument } from "./identity-subject";
import { ConfigurationError } from "../config/config";

export type UserSmsSender = (phoneNumber: string, code: string) => Promise<void>;
export type AliyunUserCredentials = { accessKeyId: string; accessKeySecret: string; securityToken?: string };
export class UserSmsDeliveryError extends Error {
  constructor(readonly outcome: "REJECTED" | "UNKNOWN") { super("SMS_DELIVERY_UNAVAILABLE"); }
}

function clientConfig(credentials: AliyunUserCredentials, endpoint: string) {
  if (!credentials || typeof credentials.accessKeyId !== "string" || credentials.accessKeyId.length < 6
    || typeof credentials.accessKeySecret !== "string" || credentials.accessKeySecret.length < 16
    || [credentials.accessKeyId,credentials.accessKeySecret,credentials.securityToken ?? ""].some(value => /[\r\n]/.test(value))) {
    throw new ConfigurationError("Independent user-channel credentials are required");
  }
  return new $OpenApiUtil.Config({ ...credentials,endpoint,protocol:"https",regionId:"cn-hangzhou",
    type:credentials.securityToken ? "sts" : "access_key" });
}
const noRetry = () => new RuntimeOptions({ autoretry:false,maxAttempts:1,connectTimeout:3000,readTimeout:8000 });

/** A configured client is a capability, never evidence that a message reached a phone. */
export function createAliyunUserSmsSender(input: { credentials: AliyunUserCredentials; signName: string; templateCode: string },
  client?: Pick<DysmsClient,"sendSmsWithOptions">): UserSmsSender {
  const signName=input.signName?.trim(),templateCode=input.templateCode?.trim();
  if (!signName || signName.length>64 || /[\p{Cc}\p{Cs}]/u.test(signName) || !/^SMS_[A-Za-z0-9]+$/.test(templateCode)) {
    throw new ConfigurationError("Approved SMS sign and OTP template are required");
  }
  const sdk = client ?? new DysmsClient(clientConfig(input.credentials,"dysmsapi.aliyuncs.com"));
  return async(phoneNumber,code) => {
    const phone = normalizeMainlandPhone(phoneNumber);
    if (!phone || !/^\d{6}$/.test(code)) throw new UserSmsDeliveryError("REJECTED");
    try {
      const response=await sdk.sendSmsWithOptions(new SendSmsRequest({ phoneNumbers:phone,signName,
        templateCode,templateParam:JSON.stringify({code}) }),noRetry());
      if(response.body?.code!=="OK")throw new UserSmsDeliveryError("REJECTED");
    } catch(error) {
      if(error instanceof UserSmsDeliveryError)throw error;
      // SDK errors may contain the signed request, OTP, credentials or PII.
      throw new UserSmsDeliveryError("UNKNOWN");
    }
  };
}

export function verifiedMainlandAgeStatus(documentNumber: string,asOf:Date):AgeStatus {
  const document=normalizeIdentityDocument(documentNumber);
  if(!/^\d{17}[0-9X]$/.test(document)||!Number.isFinite(asOf.getTime()))return "UNKNOWN";
  const year=Number(document.slice(6,10)),month=Number(document.slice(10,12)),day=Number(document.slice(12,14));
  const birth=new Date(Date.UTC(year,month-1,day)),today=new Date(asOf.getTime()+8*3600_000);
  if(year<1900||birth.getUTCFullYear()!==year||birth.getUTCMonth()!==month-1||birth.getUTCDate()!==day)return "UNKNOWN";
  const current=[today.getUTCFullYear(),today.getUTCMonth()+1,today.getUTCDate()];
  if(year>current[0]!||year===current[0]&&(month>current[1]!||month===current[1]&&day>current[2]!))return "UNKNOWN";
  const age=current[0]!-year-(current[1]!<month||current[1]===month&&current[2]!<day?1:0);
  return age>=18?"ADULT":"MINOR";
}

/** Code=200 and BizCode=1 are both required; this factory does not perform a verification. */
export function createAliyunRealNameProvider(credentials: AliyunUserCredentials,
  client?:Pick<CloudauthClient,"id2MetaVerifyWithOptions">,clock:()=>Date=()=>new Date()):RealNameProvider {
  const sdk=client??new CloudauthClient(clientConfig(credentials,"cloudauth.aliyuncs.com"));
  return { provider:"aliyun-id2meta",available:true,async verify(input) {
    const document=normalizeIdentityDocument(input.documentNumber);
    if(!/^\d{17}[0-9X]$/.test(document)||!input.fullName.trim()||input.fullName.length>64) {
      return {status:"REJECTED",ageStatus:"UNKNOWN",provider:"aliyun-id2meta",providerReference:null,reasonCode:"provider_rejected"};
    }
    try {
      const response=await sdk.id2MetaVerifyWithOptions(new Id2MetaVerifyRequest({paramType:"normal",identifyNum:document,userName:input.fullName.trim()}),noRetry());
      const body=response.body,reference=body?.requestId;
      if(body?.code!=="200"||typeof reference!=="string"||!/^[A-Za-z0-9._:-]{1,256}$/.test(reference))throw Error();
      const biz=body.resultObject?.bizCode;
      if(biz==="1")return {status:"VERIFIED",ageStatus:verifiedMainlandAgeStatus(document,clock()),provider:"aliyun-id2meta",providerReference:reference};
      if(biz==="2")return {status:"REJECTED",ageStatus:"UNKNOWN",provider:"aliyun-id2meta",providerReference:reference,reasonCode:"provider_rejected"};
      if(biz==="3")return {status:"UNKNOWN",ageStatus:"UNKNOWN",provider:"aliyun-id2meta",providerReference:reference,reasonCode:"provider_unknown"};
      throw Error();
    } catch { throw new Error("REAL_NAME_DEPENDENCY_UNAVAILABLE"); }
  } };
}
