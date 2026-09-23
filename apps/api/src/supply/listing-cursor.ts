import { createHmac,timingSafeEqual } from "node:crypto";
import { SecurityApiError } from "../auth/security-core";
import { checkedId,checkedObject } from "./listing-filter-contract";
import { invalid,conflict } from "./supply-util";
import { normalizeTime } from "./content-hash";
import type { ListingPosition } from "./listing-candidates";
export type ListingCursorKey={keyId:string;secret:string};
export type ListingCursorBinding={queryVersion:2;gameId:string;queryHash:string;sort:string;direction:string;coreItemId:string|null;filterRevision:string;catalogRevision:string;ruleReleaseId:string};
export function requireListingCursorKey(key:ListingCursorKey|undefined):asserts key is ListingCursorKey {
  if(!key||typeof key.secret!=="string"||Buffer.byteLength(key.secret)<32||typeof key.keyId!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(key.keyId))throw new SecurityApiError(503,"LISTING_QUERY_UNAVAILABLE","Listing cursor signing is not configured");
}
export function encodeListingCursor(position:ListingPosition,binding:ListingCursorBinding,key:ListingCursorKey|undefined) {
  requireListingCursorKey(key);const body=Buffer.from(JSON.stringify({schema:2,audience:"zzsh:listing-query-v2-publication",keyId:key.keyId,...binding,position})).toString("base64url");return body+"."+createHmac("sha256",key.secret).update(body).digest("base64url");
}
export function decodeListingCursor(token:string,binding:ListingCursorBinding,key:ListingCursorKey|undefined):ListingPosition {
  requireListingCursorKey(key);
  if(token.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw invalid("Invalid cursor","cursor");
  try {
    const [body,sig]=token.split(".") as [string,string],signature=Buffer.from(sig,"base64url"),expected=createHmac("sha256",key.secret).update(body).digest();
    if(signature.length!==expected.length||signature.toString("base64url")!==sig||!timingSafeEqual(signature,expected))throw Error();
    const bytes=Buffer.from(body,"base64url");if(bytes.toString("base64url")!==body)throw Error();
    const c=checkedObject(JSON.parse(bytes.toString()),"cursor",["schema","audience","keyId","queryVersion","gameId","queryHash","sort","direction","coreItemId","filterRevision","catalogRevision","ruleReleaseId","position"]);
    if(c.schema===1||c.audience==="zzsh:listing-query-v2")throw conflict("Listing cursor is stale; refresh from the first page");
    if(Object.keys(c).length!==13||c.schema!==2||c.audience!=="zzsh:listing-query-v2-publication"||c.keyId!==key.keyId||!Number.isSafeInteger(c.queryVersion)||(c.queryVersion as number)<1)throw Error();
    checkedId(c.gameId,"cursor");checkedId(c.ruleReleaseId,"cursor");if(c.coreItemId!==null)checkedId(c.coreItemId,"cursor");
    if(typeof c.queryHash!=="string"||!/^[0-9a-f]{64}$/.test(c.queryHash)||!["latest","resourceTotal","coreQuantity"].includes(c.sort as string)||!["ASC","DESC"].includes(c.direction as string))throw Error();
    for(const k of ["filterRevision","catalogRevision"])if(typeof c[k]!=="string"||!/^[1-9]\d{0,18}$/.test(c[k] as string))throw Error();
    const p=checkedObject(c.position,"cursor.position",["id","key","isNull"]);if(Object.keys(p).length!==3||typeof p.isNull!=="boolean"||p.isNull!==(p.key===null))throw Error();checkedId(p.id,"cursor.position.id");
    if(!p.isNull){if(typeof p.key!=="string")throw Error();if(c.sort==="latest"){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(p.key)||normalizeTime(p.key)!==p.key)throw Error();}else if(!(c.sort==="coreQuantity"?/^(0|[1-9]\d{0,23})$/:/^(0|[1-9]\d{0,63})\.\d{2}$/).test(p.key))throw Error();}
    for(const [name,value] of Object.entries(binding))if(c[name]!==value)throw conflict("Listing cursor binding changed; refresh metadata and query");
    return {id:p.id as string,key:p.key as string|null,isNull:p.isNull};
  }catch(error){if(error instanceof SecurityApiError && error.status===409)throw error;throw invalid("Invalid cursor","cursor");}
}
