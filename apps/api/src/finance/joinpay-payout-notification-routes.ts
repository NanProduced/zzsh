import type {INestApplication} from "@nestjs/common";
import {randomUUID} from "node:crypto";
import {withTransaction} from "../auth/security-core";
import type {SupplyNodeRequest} from "../supply/supply-util";
import type {SupplyResponse} from "../supply/supply-routes";
import {decodeJoinpayJson} from "../order/joinpay-protocol";
import {assertNativePayoutResource} from "./native-withdrawal-store";
import {receiveJoinpayPayoutNotification,type PayoutExecution} from "./joinpay-payout-attempt";
export const JOINPAY_PAYOUT_NOTIFICATION_PATH="/api/v1/withdrawals/joinpay/notifications";
type RawRequest=SupplyNodeRequest&{rawBody?:Uint8Array};
function reply(response:SupplyResponse,body:string,status=200){if(typeof response.send!=="function")throw Error("JOINPAY_JSON_RESPONSE_ADAPTER_REQUIRED");response.status(status);response.setHeader("Content-Type","application/json; charset=utf-8");response.setHeader("Cache-Control","no-store");response.send(body);}
const fail=(r:SupplyResponse,status=200)=>reply(r,'{"statusCode":"2002","message":"not accepted"}',status);
/** 缺实际rawBody就拒绝；普通JSON对象不能重编码后当原签名输入。 */
export async function handleJoinpayPayoutNotification(request:RawRequest,response:SupplyResponse,options:PayoutExecution):Promise<boolean>{
 const uri=request.originalUrl??request.url??"",pathname=uri.split("?",1)[0];if(pathname!==JOINPAY_PAYOUT_NOTIFICATION_PATH)return false;
 if((request.method??"GET").toUpperCase()!=="POST"){fail(response,405);return true;}
 const body=request.rawBody;if(!(body instanceof Uint8Array)||!body.length||body.length>65536){fail(response);return true;}const raw=new Uint8Array(body),decoded=decodeJoinpayJson(raw);
 if(!decoded.ok){fail(response);return true;}const merchant=decoded.raw.get("userNo"),number=decoded.raw.get("merchantOrderNo");
 if(merchant?.numberToken!==false||number?.numberToken!==false||typeof merchant.value!=="string"||typeof number.value!=="string"||!/^\d{1,32}$/.test(merchant.value)||!/^[A-Za-z0-9]{12,25}$/.test(number.value)){fail(response);return true;}
 try{
  const id=await withTransaction(options.pool,async c=>{await assertNativePayoutResource(c,options.scope);const rows=(await c.query(`SELECT id FROM zzsh_order.joinpay_withdrawal_intent WHERE user_no=$1 AND merchant_order_no=$2`,[merchant.value,number.value])).rows;return rows.length===1?rows[0].id as string:null;});
  if(!id){fail(response);return true;}const result=await receiveJoinpayPayoutNotification(options,id,raw,`payout_notify_${randomUUID().replaceAll("-","")}`);reply(response,result.ackBody);
 }catch{fail(response);}return true;
}
/** 仅共享装配者显式挂载；导入不建池/取钥/开放渠道。 */
export function mountJoinpayPayoutNotifications(app:INestApplication,options:PayoutExecution):void{app.getHttpAdapter().getInstance().use(JOINPAY_PAYOUT_NOTIFICATION_PATH,(req:RawRequest,res:SupplyResponse,next:()=>void)=>handleJoinpayPayoutNotification(req,res,options).then(handled=>{if(!handled)next();}));}
