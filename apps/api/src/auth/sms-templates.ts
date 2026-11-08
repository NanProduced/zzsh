import { ConfigurationError } from "../config/config";

// TODO(sms-notices): 正式上线前接入到期和出号提醒，先完成幂等及失败恢复；测试服不自动发送。
export const SMS_CONFIGURATION_V1_SCENES = ["IDENTITY", "REGISTER", "LOGIN", "BIND", "RENTAL_EXPIRY", "OWNER_ORDER_PAID"] as const;
export const SMS_ADDITIONAL_SCENES = ["CHANGE_MOBILE", "FORGOT_PASSWORD"] as const;
export const SMS_TEMPLATE_SCENES = [...SMS_CONFIGURATION_V1_SCENES, ...SMS_ADDITIONAL_SCENES] as const;
export const SMS_VERIFICATION_SCENES = ["IDENTITY", "REGISTER", "LOGIN", "BIND", ...SMS_ADDITIONAL_SCENES] as const;
export type SmsTemplateScene = typeof SMS_TEMPLATE_SCENES[number];
export type SmsVerificationScene = typeof SMS_VERIFICATION_SCENES[number];
export type SmsTemplateConfiguration = Readonly<{signName:string;scenes:Readonly<Record<SmsTemplateScene,Readonly<{templateCode:string|null;source:"SCENE"|"RELATED"|"SHARED"|"NOT_CONFIGURED"}>>>}>;

/** A shared OTP template preserves existing deployments; business notices never use that fallback. */
export function resolveSmsTemplates(input:{signName:string;templateCode?:string;templates?:Partial<Record<SmsTemplateScene,string>>}):SmsTemplateConfiguration{
  const signName=input.signName?.trim(),shared=input.templateCode?.trim()||null;
  const valid=(value:string)=>value.length<=128&&/^SMS_[A-Za-z0-9]+$/.test(value);
  if(!signName||signName.length>64||/[\p{Cc}\p{Cs}]/u.test(signName)||shared!==null&&!valid(shared))throw new ConfigurationError("Approved SMS sign and OTP template are required");
  const scenes={} as Record<SmsTemplateScene,{templateCode:string|null;source:"SCENE"|"RELATED"|"SHARED"|"NOT_CONFIGURED"}>;
  for(const scene of SMS_TEMPLATE_SCENES){
    const explicit=input.templates?.[scene]?.trim()||null;
    if(explicit!==null&&!valid(explicit))throw new ConfigurationError(`Invalid SMS template for ${scene}`);
    const otp=scene!=="RENTAL_EXPIRY"&&scene!=="OWNER_ORDER_PAID";
    const related=scene==="CHANGE_MOBILE"?scenes.BIND?.templateCode:scene==="FORGOT_PASSWORD"?scenes.IDENTITY?.templateCode:null;
    const relatedExplicit=scene==="CHANGE_MOBILE"?input.templates?.BIND?.trim():scene==="FORGOT_PASSWORD"?input.templates?.IDENTITY?.trim():null;
    const templateCode=explicit??(relatedExplicit?related:null)??(otp?shared:null);
    if(otp&&!templateCode)throw new ConfigurationError(`Missing SMS template for ${scene}`);
    scenes[scene]=Object.freeze({templateCode,source:explicit?"SCENE":relatedExplicit&&related?"RELATED":templateCode?"SHARED":"NOT_CONFIGURED"});
  }
  return Object.freeze({signName,scenes:Object.freeze(scenes)});
}
