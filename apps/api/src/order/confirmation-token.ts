import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SecurityApiError } from "../auth/security-core";

export type ConfirmationKey = {keyId:string;secret:string};
export type ConfirmationBinding = {userId:string;sessionId:string;accountId:string;versionId:string;releaseId:string;listingHash:string;quoteDigest:string};
export type ConfirmationClaims = ConfirmationBinding & {schema:"order-confirmation-v1";audience:"zzsh:rental-confirmation";keyId:string;confirmationId:string;issuedAt:number;expiresAt:number};
const fields=["schema","audience","keyId","confirmationId","issuedAt","expiresAt","userId","sessionId","accountId","versionId","releaseId","listingHash","quoteDigest"].sort();
export function requireConfirmationKey(key:ConfirmationKey|undefined): asserts key is ConfirmationKey {
  if(!key || typeof key.keyId!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(key.keyId) || typeof key.secret!=="string" || Buffer.byteLength(key.secret)<32) throw new SecurityApiError(503,"CONFIRMATION_SIGNING_UNAVAILABLE","Confirmation signing is not configured");
}
function invalidToken(): never {throw new SecurityApiError(400,"CONFIRMATION_INVALID","Invalid confirmation credential");}
export function signConfirmation(binding:ConfirmationBinding,now:number,key:ConfirmationKey|undefined) {
  requireConfirmationKey(key);
  const claims:ConfirmationClaims={schema:"order-confirmation-v1",audience:"zzsh:rental-confirmation",keyId:key.keyId,confirmationId:randomUUID(),userId:binding.userId,sessionId:binding.sessionId,accountId:binding.accountId,versionId:binding.versionId,releaseId:binding.releaseId,listingHash:binding.listingHash,quoteDigest:binding.quoteDigest,issuedAt:now,expiresAt:now+300};
  const encoded=Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {claims,token:encoded+"."+createHmac("sha256",key.secret).update(encoded).digest("base64url")};
}
/** Signature/subject authentication only. Expiry and current facts must still be checked before creating an order. */
export function authenticateConfirmation(token:unknown,expected:Pick<ConfirmationBinding,"userId"|"sessionId">,now:number,key:ConfirmationKey|undefined):ConfirmationClaims {
  requireConfirmationKey(key);
  if(typeof token!=="string" || token.length>4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return invalidToken();
  const [encoded,signature]=token.split(".") as [string,string];
  const actual=Buffer.from(signature,"base64url"),mac=createHmac("sha256",key.secret).update(encoded).digest();
  if(actual.length!==mac.length || actual.toString("base64url")!==signature || !timingSafeEqual(actual,mac)) return invalidToken();
  let c:ConfirmationClaims;
  try {const bytes=Buffer.from(encoded,"base64url");if(bytes.toString("base64url")!==encoded)return invalidToken();c=JSON.parse(bytes.toString("utf8"));} catch {return invalidToken();}
  if(!c || Array.isArray(c) || typeof c!=="object" || JSON.stringify(Object.keys(c).sort())!==JSON.stringify(fields)) return invalidToken();
  if(c.schema!=="order-confirmation-v1" || c.audience!=="zzsh:rental-confirmation" || c.keyId!==key.keyId || typeof c.confirmationId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.confirmationId))return invalidToken();
  for(const name of ["userId","sessionId","accountId","versionId","releaseId"] as const) if(typeof c[name]!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(c[name]))return invalidToken();
  for(const name of ["listingHash","quoteDigest"] as const)if(typeof c[name]!=="string" || !/^[0-9a-f]{64}$/.test(c[name]))return invalidToken();
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(c.issuedAt)||!Number.isSafeInteger(c.expiresAt)||c.expiresAt-c.issuedAt!==300||c.issuedAt>now)return invalidToken();
  if(c.userId!==expected.userId||c.sessionId!==expected.sessionId) return invalidToken();
  return c;
}
export function verifyConfirmation(token:unknown,expected:ConfirmationBinding,now:number,key:ConfirmationKey|undefined):ConfirmationClaims {
  const c=authenticateConfirmation(token,expected,now,key);
  if(c.expiresAt<=now)throw new SecurityApiError(409,"CONFIRMATION_EXPIRED","Confirmation expired; confirm again");
  for(const name of ["accountId","versionId","releaseId","listingHash","quoteDigest"] as const)if(c[name]!==expected[name])throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Confirmation changed; confirm again");
  return c;
}
