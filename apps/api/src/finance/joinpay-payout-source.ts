import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {conflict,invalid,notFound} from "../supply/supply-util";
import {assertNativePayoutResource,assertNativePayoutExecutionReady,lockNativeWithdrawal,nativePayoutBinding,type NativeWithdrawalRow} from "./native-withdrawal-store";
import {assertPayoutProfile,describePayoutProfile,eligiblePayoutTerminal,inspectPayoutProfile,preflightPayoutProfile,readPayoutProfileEvidence,readPayoutScope,PayoutProfileError,
 type BoundPayoutProfile,type PayoutBinding,type PayoutProfileOperation,type PayoutScope} from "./joinpay-payout-profile";
const sha=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex"),ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
export type PayoutSourceOptions={scope:PayoutScope;profileFor:(operation:PayoutProfileOperation,binding:Readonly<PayoutBinding>,pinned?:Readonly<{profileId:string;profileSha256:string;keyVersionRef:string}>)=>BoundPayoutProfile;keyFor:(ref:string)=>string};
export type NativeWithdrawalFact=Readonly<{evidenceId:string;intentId:string;userId:string;merchantIdentityId:string;merchantOrderNo:string;platformSerialNo:string;terminal:"PAID"|"UNPAID_CONFIRMED";
 grossCents:string;netCents:string;feeCents:string;currency:"CNY";targetFingerprint:string;providerFeeRaw:string;providerFeeCents:string;sourceObservationId:string;factsDigest:string}>;
type Body=Omit<NativeWithdrawalFact,"factsDigest">;
type Observation={id:string;intent_id:string;attempt_id:string|null;operation:PayoutProfileOperation;raw_body:Buffer|null;raw_sha256:string|null;response_complete:boolean;http_status:number|null;transport_failure:string|null;evidence_level:string;event:string;
 profile_id:string;profile_canonical:string;profile_sha256:string;key_version_ref:string;lease_version:string|null;lease_owner:string|null};
const proofs=new WeakMap<object,{client:PoolClient;xid:string;database:string;actor:string;value:NativeWithdrawalFact}>();
function mint(c:PoolClient,xid:string,body:Body,digest:string,scope:PayoutScope){const s=readPayoutScope(scope),value=Object.freeze({...body,factsDigest:digest});proofs.set(value,{client:c,xid,database:s.database,actor:s.runtimeUser,value});return value;}
export function payoutTerminalConflicts(a:{terminal:string;platformSerialNo:string;providerFeeRaw:string;providerFeeCents:string},b:{terminal:string;platformSerialNo:string;providerFeeRaw:string;providerFeeCents:string}){
 return a.terminal!==b.terminal||a.platformSerialNo!==b.platformSerialNo||a.providerFeeRaw!==b.providerFeeRaw||a.providerFeeCents!==b.providerFeeCents;
}
async function original(c:PoolClient,o:PayoutSourceOptions,r:NativeWithdrawalRow,id:string){
 const b=nativePayoutBinding(r,o.scope),raw=(await c.query<Observation>(`SELECT id,intent_id,attempt_id,operation,raw_body,raw_sha256,response_complete,http_status,transport_failure,evidence_level,event,
  profile_id,profile_canonical,profile_sha256,key_version_ref,lease_version::text,lease_owner FROM zzsh_order.joinpay_payout_observation WHERE id=$1 AND intent_id=$2`,[id,r.id])).rows[0];
 if(!raw||!["QUERY","NOTIFY"].includes(raw.operation)||raw.evidence_level!=="PROVIDER_RESPONSE"||raw.event==="STALE"||!raw.response_complete||raw.transport_failure!==null||!raw.raw_body||!raw.raw_sha256||sha(raw.raw_body)!==raw.raw_sha256||sha(raw.profile_canonical)!==raw.profile_sha256
  ||(raw.operation==="QUERY"?raw.http_status!==200:raw.http_status!==null))return null;
 if(raw.operation==="QUERY"){
  const a=(await c.query(`SELECT intent_id,operation,lease_version::text,lease_owner,profile_id,profile_sha256,profile_canonical,key_version_ref,request_body,request_sha256 FROM zzsh_order.joinpay_payout_attempt WHERE id=$1`,[raw.attempt_id])).rows[0];
  if(!a||a.intent_id!==r.id||a.operation!=="QUERY"||a.lease_version!==raw.lease_version||a.lease_owner!==raw.lease_owner||a.profile_id!==raw.profile_id||a.profile_sha256!==raw.profile_sha256||a.profile_canonical!==raw.profile_canonical||a.key_version_ref!==raw.key_version_ref||!Buffer.isBuffer(a.request_body)||sha(a.request_body)!==a.request_sha256)return null;
 }else if(raw.attempt_id!==null||raw.lease_version!==null||raw.lease_owner!==null)return null;
 await assertNativePayoutExecutionReady(c);const profile=o.profileFor(raw.operation,Object.freeze({...b}),Object.freeze({profileId:raw.profile_id,profileSha256:raw.profile_sha256,keyVersionRef:raw.key_version_ref})),p=describePayoutProfile(profile,raw.operation);assertPayoutProfile(o.scope,profile,raw.operation);
 if(p.profileId!==raw.profile_id||p.profileSha256!==raw.profile_sha256||p.keyVersionRef!==raw.key_version_ref||readPayoutProfileEvidence(profile)!==raw.profile_canonical)throw conflict("Payout source operation profile differs");
 if(!preflightPayoutProfile(profile,raw.operation,raw.raw_body,b).ok)return null;
 let key:string;try{key=o.keyFor(p.keyVersionRef);}catch{throw new PayoutProfileError("PAYOUT_KEY_UNAVAILABLE");}
 const d=inspectPayoutProfile(profile,raw.operation,raw.raw_body,b,key),terminal=eligiblePayoutTerminal(profile,d);
 if(!terminal||!d.platformSerialNo||d.providerFeeRaw===null||d.providerFeeCents===null)return null;
 return{raw,terminal,platformSerialNo:d.platformSerialNo,providerFeeRaw:d.providerFeeRaw,providerFeeCents:d.providerFeeCents};
}
function bodyFor(r:NativeWithdrawalRow,observationId:string,t:{terminal:"PAID"|"UNPAID_CONFIRMED";platformSerialNo:string;providerFeeRaw:string;providerFeeCents:string}):Body{return{
 evidenceId:`pwe_${sha(JSON.stringify([r.id,observationId,t.terminal])).slice(0,40)}`,intentId:r.id,userId:r.user_id,merchantIdentityId:r.merchant_identity_id,merchantOrderNo:r.merchant_order_no,platformSerialNo:t.platformSerialNo,terminal:t.terminal,
 grossCents:r.gross_cents,netCents:r.net_cents,feeCents:r.fee_cents,currency:"CNY",targetFingerprint:r.target_fingerprint,providerFeeRaw:t.providerFeeRaw,providerFeeCents:t.providerFeeCents,sourceObservationId:observationId};}
/** 原件重验不依赖当前新单KYC/政策；cached verified/终态标签不能单独产事实。 */
export async function readVerifiedPayoutFact(c:PoolClient,o:PayoutSourceOptions,evidenceId:string):Promise<NativeWithdrawalFact>{
 if(!ID.test(evidenceId))throw invalid();const xid=await assertNativePayoutResource(c,o.scope),e=(await c.query(`SELECT id,intent_id,observation_id,operation,terminal,platform_serial_no,provider_fee_raw,provider_fee_cents::text,facts_canonical,facts_digest FROM zzsh_order.joinpay_payout_evidence WHERE id=$1`,[evidenceId])).rows[0];
 if(!e||typeof e.facts_canonical!=="string"||sha(e.facts_canonical)!==e.facts_digest)throw notFound();const{row:r}=await lockNativeWithdrawal(c,o.scope,e.intent_id),t=await original(c,o,r,e.observation_id);if(!t)throw conflict("Original payout source did not verify");
 const b=bodyFor(r,e.observation_id,t),canonical=JSON.stringify(b);if(b.evidenceId!==e.id||canonical!==e.facts_canonical||sha(canonical)!==e.facts_digest||e.operation!==t.raw.operation||e.terminal!==b.terminal||e.platform_serial_no!==b.platformSerialNo||e.provider_fee_raw!==b.providerFeeRaw||e.provider_fee_cents!==b.providerFeeCents)throw conflict("Original payout terminal differs");
 return mint(c,xid,b,e.facts_digest,o.scope);
}
/** capture与账务消费由同一事务调用；没有完整费用或未执行保证时不抢占唯一终态。 */
export async function capturePayoutFact(c:PoolClient,o:PayoutSourceOptions,intentId:string,observationId:string):Promise<NativeWithdrawalFact|null>{
 const xid=await assertNativePayoutResource(c,o.scope),{row:r}=await lockNativeWithdrawal(c,o.scope,intentId);if(r.requires_review)return null;
 const t=await original(c,o,r,observationId);if(!t)return null;
 if(r.terminal_evidence_id){const old=await readVerifiedPayoutFact(c,o,r.terminal_evidence_id);if(payoutTerminalConflicts(old,t)){await c.query(`UPDATE zzsh_order.joinpay_withdrawal_intent SET requires_review=true,operation_version=operation_version+1 WHERE id=$1 AND NOT requires_review`,[intentId]);return null;}return old;}
 const b=bodyFor(r,observationId,t),canonical=JSON.stringify(b),digest=sha(canonical);
 await c.query(`INSERT INTO zzsh_order.joinpay_payout_evidence(id,intent_id,observation_id,operation,terminal,platform_serial_no,provider_fee_raw,provider_fee_cents,facts_canonical,facts_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[b.evidenceId,intentId,observationId,t.raw.operation,b.terminal,b.platformSerialNo,b.providerFeeRaw,b.providerFeeCents,canonical,digest]);
 return mint(c,xid,b,digest,o.scope);
}
export async function assertNativeWithdrawalFact(c:PoolClient,fact:unknown):Promise<NativeWithdrawalFact>{
 const p=fact&&typeof fact==="object"?proofs.get(fact):null;if(!p||p.client!==c)throw invalid("Native payout fact is not verified on this transaction");
 const r=(await c.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid`)).rows[0];if(r?.xid!==p.xid||r.db!==p.database||r.actor!==p.actor)throw invalid("Native payout fact resource or transaction differs");return p.value;
}
