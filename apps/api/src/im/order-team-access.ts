import type { PoolClient } from "pg";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { assertGameScopeUsable, gameScopeSql, noGameScopeError, readAdminGameScope, scopeAllowsGame, scopeIsEmpty } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";
import { decimalToBigInt, formatDecimalExact, formatScaledInteger, parseNonNegativeDecimal } from "../supply/decimal";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";
import { supportManagerIdentityKey } from "./consultation";
import { OrderImSdkRouteError, type OrderImSdkRoute, type OrderImSdkRouteBindings } from "../config/config";
import { readPrestartRefundProgress } from "../order/prestart-refund-store";
import type { PrestartPaymentBasis } from "../order/prestart-termination";
import type { StageCardKind } from "./order-stage-cards";

export type OrderTeamActor={realm:"user"|"admin";userId:string;sessionId:string};
const denied=()=>new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
const POST_END_SEND_WINDOW_MS=72*60*60*1000;

export type TerminalSendWindow={orderEndedAt:string|null;sendUntil:string|null;refundPending:boolean;refundCompletedAt:string|null;terminalSendAllowed:boolean};
/** A prestart termination is not an archive until the full refund is written off. */
export function terminalSendWindow(input:{orderStatus:string;cancelReason:string|null;cancelledAt:string|null;
  settlementPostedAt:string|null;refundCompletedAt:string|null;now?:number}):TerminalSendWindow{
  const now=input.now??Date.now();
  if(input.orderStatus!=="COMPLETED"&&input.orderStatus!=="CANCELLED")return {orderEndedAt:null,sendUntil:null,refundPending:false,refundCompletedAt:null,terminalSendAllowed:true};
  if(input.orderStatus==="CANCELLED"&&(input.cancelReason==="PRESTART_TERMINATED"||input.cancelReason==="SUPPORT_CANCELLED_REFUND")){
    const completed=input.refundCompletedAt??null;
    if(completed===null)return {orderEndedAt:input.cancelledAt,sendUntil:null,refundPending:true,refundCompletedAt:null,terminalSendAllowed:true};
    const completedMs=new Date(completed).getTime();
    if(!Number.isFinite(completedMs))return {orderEndedAt:input.cancelledAt,sendUntil:null,refundPending:true,refundCompletedAt:null,terminalSendAllowed:true};
    const until=completedMs+POST_END_SEND_WINDOW_MS;
    return {orderEndedAt:input.cancelledAt,sendUntil:new Date(until).toISOString(),refundPending:false,refundCompletedAt:completed,terminalSendAllowed:now<until};
  }
  const source=input.orderStatus==="COMPLETED"?input.settlementPostedAt:input.cancelledAt;
  const sourceMs=source===null?null:new Date(source).getTime();
  if(sourceMs===null||!Number.isFinite(sourceMs))return {orderEndedAt:null,sendUntil:null,refundPending:false,refundCompletedAt:null,terminalSendAllowed:false};
  const until=sourceMs+POST_END_SEND_WINDOW_MS;
  return {orderEndedAt:new Date(sourceMs).toISOString(),sendUntil:new Date(until).toISOString(),refundPending:false,refundCompletedAt:null,terminalSendAllowed:now<until};
}

/**
 * Frozen order inventory projection for the first opening recording. Reads the
 * order snapshot only (never the account's current stock) and whitelists the
 * quantity/unit facts plus a catalog display name; buyer/owner amounts are not
 * projected here.
 */
export function projectFrozenInventory(snapshot: unknown, itemNames: ReadonlyMap<string, string>): Array<{itemId:string;quantity:string;unit:string;pricingKind:string;name:string|null}> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const lines = (snapshot as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  const result: Array<{itemId:string;quantity:string;unit:string;pricingKind:string;name:string|null}> = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const line = raw as { itemId?: unknown; quantity?: unknown; unit?: unknown; pricingKind?: unknown };
    if (typeof line.itemId !== "string" || typeof line.quantity !== "string" || typeof line.unit !== "string" || typeof line.pricingKind !== "string") continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(line.itemId) || !/^(0|[1-9]\d{0,18})$/.test(line.quantity)) continue;
    result.push({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind, name: itemNames.get(line.itemId) ?? null });
  }
  return result;
}
export type OrderTermsViewerParty="RENTER"|"OWNER"|"STAFF";
export type OrderTermsLine={itemId:string;name:string|null;quantity:string;unitPrice:string|null;amount:string|null;
  buyerUnitPrice?:string|null;ownerUnitPrice?:string|null;buyerAmount?:string|null;ownerAmount?:string|null;platformContribution?:string|null};
export type OrderTermsStaff={buyerRentalAmount:string|null;ownerRentalAmount:string|null;buyerTotal:string|null;ownerTotal:string|null;platformContribution:string|null};
export type OrderTerms={viewerParty:OrderTermsViewerParty;basis:"QUOTE"|"UNKNOWN";currency:"CNY";scale:2;version:string|null;
  rentalAmount:string|null;depositAmount:string|null;paidTotal:string|null;lines:OrderTermsLine[];staff?:OrderTermsStaff};
const TERMS_ITEM_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMS_QUANTITY=/^(0|[1-9]\d{0,18})$/;
type TermsParsedLine={itemId:string;name:string|null;quantity:string;buyerUnitPrice:string|null;ownerUnitPrice:string|null;
  buyerAmount:string|null;ownerAmount:string|null;platformContribution:string|null;
  buyerCents:bigint|null;ownerCents:bigint|null;platformCents:bigint|null};
function termsRecord(value:unknown):Record<string,unknown>|null{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null}
/** Frozen quote amounts are CNY yuan objects; terms expose exact cents strings (no float math). */
function termsAmount(value:unknown):{text:string;cents:bigint}|null{
  const item=termsRecord(value);
  if(!item||item.currency!=="CNY"||item.unit!=="yuan"||item.scale!==2||typeof item.amount!=="string")return null;
  try{const parsed=parseNonNegativeDecimal(item.amount,2,"terms amount");const cents=decimalToBigInt(parsed,2);return{text:cents.toString(),cents}}catch{return null}
}
/** Unit amounts carry up to 8 yuan decimals; cents text may therefore be fractional but stays exact. */
function termsUnitPrice(value:unknown):string|null{
  const item=termsRecord(value);
  if(!item||item.currency!=="CNY"||item.unit!=="yuan"||item.scale!==8||typeof item.amount!=="string")return null;
  try{
    const parsed=parseNonNegativeDecimal(item.amount,8,"terms unit amount");
    return parsed.scale>=2?formatDecimalExact({value:parsed.value,scale:parsed.scale-2})
      :formatScaledInteger(parsed.value*10n**BigInt(2-parsed.scale),0);
  }catch{return null}
}
function parseTermsLine(raw:unknown,itemNames:ReadonlyMap<string,string>):TermsParsedLine|null{
  const line=termsRecord(raw);
  if(!line||typeof line.itemId!=="string"||!TERMS_ITEM_ID.test(line.itemId)||typeof line.quantity!=="string"||!TERMS_QUANTITY.test(line.quantity))return null;
  const buyerUnitPrice=termsUnitPrice(line.buyerUnitAmount),ownerUnitPrice=termsUnitPrice(line.ownerUnitAmount);
  const buyer=termsAmount(line.buyerAmount),owner=termsAmount(line.ownerAmount),platform=termsAmount(line.platformAmount);
  const usable=buyerUnitPrice!==null&&ownerUnitPrice!==null&&buyer!==null&&owner!==null&&platform!==null
    &&buyer.cents-owner.cents===platform.cents;
  return {itemId:line.itemId,name:itemNames.get(line.itemId)??null,quantity:line.quantity,
    buyerUnitPrice:usable?buyerUnitPrice:null,ownerUnitPrice:usable?ownerUnitPrice:null,
    buyerAmount:usable?buyer!.text:null,ownerAmount:usable?owner!.text:null,platformContribution:usable?platform!.text:null,
    buyerCents:usable?buyer!.cents:null,ownerCents:usable?owner!.cents:null,platformCents:usable?platform!.cents:null};
}
/**
 * Role-projected terms for the order card. The frozen quote is the only price
 * source: a viewer sees just their own side, staff sees both sides plus the
 * platform spread. Anything that cannot be split exactly stays UNKNOWN/null.
 */
export function projectOrderTerms(snapshot:unknown,itemNames:ReadonlyMap<string,string>,viewerParty:OrderTermsViewerParty):OrderTerms{
  const base=(basis:"QUOTE"|"UNKNOWN",version:string|null,lines:OrderTermsLine[]):OrderTerms=>({viewerParty,basis,currency:"CNY",scale:2,version,
    rentalAmount:null,depositAmount:null,paidTotal:null,lines,
    ...(viewerParty==="STAFF"?{staff:{buyerRentalAmount:null,ownerRentalAmount:null,buyerTotal:null,ownerTotal:null,platformContribution:null}}:{})});
  const quote=termsRecord(snapshot);
  if(!quote)return base("UNKNOWN",null,[]);
  const hash=quote.contentHash,digest=quote.confirmationDigest;
  const version=typeof hash==="string"&&hash.length>0&&hash.length<=256?hash
    :typeof digest==="string"&&digest.length>0&&digest.length<=256?digest:null;
  const rawLines=Array.isArray(quote.lines)?quote.lines:[];
  const parsed=rawLines.map(line=>parseTermsLine(line,itemNames));
  const known=parsed.filter((line):line is TermsParsedLine=>line!==null);
  const lines=known.map((line):OrderTermsLine=>viewerParty==="STAFF"
    ?{itemId:line.itemId,name:line.name,quantity:line.quantity,unitPrice:null,amount:null,
      buyerUnitPrice:line.buyerUnitPrice,ownerUnitPrice:line.ownerUnitPrice,buyerAmount:line.buyerAmount,ownerAmount:line.ownerAmount,platformContribution:line.platformContribution}
    :viewerParty==="OWNER"
      ?{itemId:line.itemId,name:line.name,quantity:line.quantity,unitPrice:line.ownerUnitPrice,amount:line.ownerAmount}
      :{itemId:line.itemId,name:line.name,quantity:line.quantity,unitPrice:line.buyerUnitPrice,amount:line.buyerAmount});
  const resource=termsAmount(quote.resourceTotal),ownerRental=termsAmount(quote.ownerTotal),platformTotal=termsAmount(quote.platformFullProfit);
  const tenantDeposit=quote.tenantDeposit==null?null:termsAmount(quote.tenantDeposit);
  const publisherBail=quote.publisherBailRequirement==null?null:termsAmount(quote.publisherBailRequirement);
  const complete=rawLines.length>0&&known.length===rawLines.length
    &&known.every(line=>line.buyerCents!==null&&line.ownerCents!==null&&line.platformCents!==null)
    &&(quote.schemaVersion===1||quote.schemaVersion===2)&&quote.currency==="CNY";
  const depositsReadable=(quote.tenantDeposit==null||tenantDeposit!==null)&&(quote.publisherBailRequirement==null||publisherBail!==null);
  if(!complete||!resource||!ownerRental||!platformTotal||!depositsReadable)return base("UNKNOWN",version,lines);
  let buyerSum=0n,ownerSum=0n;
  for(const line of known){buyerSum+=line.buyerCents!;ownerSum+=line.ownerCents!}
  if(buyerSum!==resource.cents||ownerSum!==ownerRental.cents||resource.cents-ownerRental.cents!==platformTotal.cents)return base("UNKNOWN",version,lines);
  if(viewerParty==="RENTER")return{...base("QUOTE",version,lines),
    rentalAmount:resource.text,depositAmount:tenantDeposit?.text??null,
    paidTotal:tenantDeposit===null?null:(resource.cents+tenantDeposit.cents).toString()};
  if(viewerParty==="OWNER")return{...base("QUOTE",version,lines),
    rentalAmount:ownerRental.text,depositAmount:publisherBail?.text??null,
    paidTotal:publisherBail===null?null:(ownerRental.cents+publisherBail.cents).toString()};
  return{...base("QUOTE",version,lines),staff:{
    buyerRentalAmount:resource.text,ownerRentalAmount:ownerRental.text,
    buyerTotal:tenantDeposit===null?null:(resource.cents+tenantDeposit.cents).toString(),
    ownerTotal:publisherBail===null?null:(ownerRental.cents+publisherBail.cents).toString(),
    platformContribution:platformTotal.text}};
}
export type OrderFulfillmentStage="PENDING_PAYMENT"|"WAITING_STAFF"|"TEAM_PENDING"|"OPENING_CONFIRM"|"RENTING"|"ENDING"|"SETTLED"|"CANCELLED";
type OpeningState="NONE"|"DRAFT"|"PARTIAL"|"CONFIRMED";
type EndState="NONE"|"REQUESTED"|"POSTED";
export interface OrderFulfillment {
  stage:OrderFulfillmentStage;rentalStartedAt:string|null;dueAt:string|null;
  openingState:OpeningState;endState:EndState;
}
/**
 * Server-authoritative six-step projection. Reads only the facts fetched by the
 * caller; nothing here grants access or influences canSend.
 */
export function projectOrderFulfillment(f:{orderStatus:string;hasGroup:boolean;provisionState:string|null;teamState:string|null;
  openingStatus:string|null;openingConfirmedAt:Date|string|null;openingAcked:boolean;termSeconds:string|number|null;
  intakeOpen:boolean;currentSettlement:boolean;posted:boolean}):OrderFulfillment{
  const startedMs=f.openingStatus==="CONFIRMED"&&f.openingConfirmedAt!=null?new Date(f.openingConfirmedAt).getTime():null;
  const rentalStartedAt=startedMs!==null&&Number.isFinite(startedMs)?new Date(startedMs).toISOString():null;
  const termMs=Number(f.termSeconds);
  const dueMs=startedMs!==null&&Number.isFinite(startedMs)&&Number.isFinite(termMs)&&termMs>0?startedMs+termMs*1000:null;
  const dueAt=dueMs===null?null:new Date(dueMs).toISOString();
  const openingState:OpeningState=f.openingStatus==="CONFIRMED"?"CONFIRMED":f.openingStatus==="DRAFT"?(f.openingAcked?"PARTIAL":"DRAFT"):"NONE";
  const endState:EndState=f.posted?"POSTED":f.intakeOpen||f.currentSettlement?"REQUESTED":"NONE";
  const stage:OrderFulfillmentStage=f.orderStatus==="PENDING_PAYMENT"?"PENDING_PAYMENT"
    :f.orderStatus==="CANCELLED"?"CANCELLED"
    :f.orderStatus==="COMPLETED"?"SETTLED"
    :!f.hasGroup||f.provisionState==="WAITING"?"WAITING_STAFF"
    :f.teamState!=="READY"?"TEAM_PENDING"
    :openingState!=="CONFIRMED"?"OPENING_CONFIRM"
    :endState==="REQUESTED"?"ENDING":"RENTING";
  return {stage,rentalStartedAt,dueAt,openingState,endState};
}
export type OrderTeamMemberRow={party:"BUYER"|"OWNER"|"STAFF";state:"PLANNED"|"JOINED";platform_subject_id:string;
  identity_kind:"USER"|"ADMIN";realm:"user"|"admin";account_id:string;status:string;identity_marker:string;name:string|null;avatar:string|null;availability?:"AVAILABLE"|"PAUSED"|"OFF_DUTY"|null};
export type OrderTeamMemberView={platformId:string;accountId:string;party:OrderTeamMemberRow["party"];name:string|null;avatar:string|null;
  responsible:boolean;availability?:"AVAILABLE"|"PAUSED"|"OFF_DUTY";membershipStatus?:"UNKNOWN";identityStatus?:"UNKNOWN"};
/** One member query and one projection shape for every order Team reader. */
export async function readOrderTeamMemberRows(c:Pick<PoolClient,"query">,orderId:string,appId:string):Promise<OrderTeamMemberRow[]>{
  return (await c.query<OrderTeamMemberRow>(`SELECT mm.party,mm.state,m.platform_subject_id,m.identity_kind,m.realm,m.account_id,m.status,m.identity_marker,
    CASE WHEN m.realm='user' THEN u.name ELSE a.name END AS name,
    CASE WHEN m.realm='user' THEN u.image ELSE a.image END AS avatar,
    CASE WHEN m.realm='admin' THEN presence.availability END AS availability
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
    LEFT JOIN zzsh_auth_user."user" u ON m.realm='user' AND u.id=m.platform_subject_id
    LEFT JOIN zzsh_auth_admin."user" a ON m.realm='admin' AND a.id=m.platform_subject_id
    LEFT JOIN zzsh_iam.im_support_presence presence ON m.realm='admin' AND presence.admin_user_id=m.platform_subject_id AND presence.app_id=mm.app_id
    WHERE mm.order_id=$1 AND mm.app_id=$2`,[orderId,appId])).rows;
}
export function projectOrderTeamMembers(members:OrderTeamMemberRow[],responsibleAdminId:string|null|undefined,viewerRealm:"user"|"admin"):OrderTeamMemberView[]{
  return members.filter(m=>m.state==="JOINED").map(m=>({platformId:m.platform_subject_id,accountId:m.account_id,party:m.party,name:m.name,
    avatar:managedProfileImagePath(m.avatar),
    responsible:m.party==="STAFF"&&m.platform_subject_id===responsibleAdminId,
    ...(viewerRealm==="admin"&&m.party==="STAFF"&&m.availability?{availability:m.availability}:{}),
    ...(viewerRealm==="admin"&&m.realm==="user"?{membershipStatus:"UNKNOWN" as const,identityStatus:"UNKNOWN" as const}:{})}));
}
/** Same checks for every JOINED staff member; responsibility is not an exclusive grant. */
export async function readOrderTeamAccess(c:PoolClient,actor:OrderTeamActor,orderId:string,operation:"read"|"send"="read",
  orderImSdkRouteBindings?:OrderImSdkRouteBindings):Promise<Record<string,unknown>>{
  if(actor.realm==="user")await assertUserContextInTransaction(c,actor);else await assertAdminContextInTransaction(c,actor);
  const g=(await c.query(`SELECT g.*,o.renter_user_id,o.owner_user_id,o.game_id,o.display_no,o.status AS order_status,o.cancel_reason AS order_cancel_reason,o.cancelled_at AS order_cancelled_at,o.title,o.account_id,o.quote_snapshot AS quote_snapshot,game.name AS game_name,
      o.term_seconds::text AS term_seconds,
      latest_opening.id AS opening_id,latest_opening.status AS opening_status,latest_opening.confirmed_at AS opening_confirmed_at,
      latest_opening.version_no AS opening_version_no,latest_opening.confirm_source AS opening_confirm_source,
      CASE WHEN latest_opening.status='DRAFT' THEN latest_opening.auto_confirm_due_at END AS opening_confirm_due_at,
      EXISTS(SELECT 1 FROM zzsh_order.settlement_intake si WHERE si.order_id=o.id AND si.status='OPEN') AS intake_open,
      EXISTS(SELECT 1 FROM zzsh_order.settlement_version sv WHERE sv.order_id=o.id AND sv.superseded_at IS NULL) AS settlement_current,
      posting.posted_at AS settlement_posted_at,
      to_jsonb(g)->>'responsible_admin_id' AS escalation_responsible_admin_id,
      to_jsonb(g)->>'first_response_at' AS escalation_first_response_at,
      to_jsonb(g)->>'remind_due_at' AS escalation_remind_due_at,
      to_jsonb(g)->>'add_round' AS escalation_add_round,
      to_jsonb(g)->>'escalation_state' AS escalation_state_projection
    FROM zzsh_order.rental_order o JOIN zzsh_supply.game game ON game.id=o.game_id
    LEFT JOIN zzsh_order.im_order_group g ON g.order_id=o.id
    LEFT JOIN LATERAL (SELECT op.id,op.status,op.confirmed_at,op.version_no,op.confirm_source,op.auto_confirm_due_at
      FROM zzsh_order.rental_opening op WHERE op.order_id=o.id
      ORDER BY op.version_no DESC LIMIT 1) latest_opening ON TRUE
    LEFT JOIN LATERAL (SELECT p.posted_at FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id
      ORDER BY p.posted_at DESC,p.id DESC LIMIT 1) posting ON TRUE WHERE o.id=$1`,[orderId])).rows[0];
  if(!g)throw new SecurityApiError(404,"NOT_FOUND","Order Team unavailable");
  if(actor.realm==="user"&&g.renter_user_id!==actor.userId&&g.owner_user_id!==actor.userId)throw denied();
  let canSend=true;
  if(actor.realm==="admin"){
    const access=await loadEffectiveAdminAccess(c,actor.userId);
    if(!hasPermission(access,"im.support.read"))throw denied();
    canSend=hasPermission(access,"im.support.accept");
    if(!access!.isBoss){
      const scope=await readAdminGameScope(c,actor.userId);
      if(scopeIsEmpty(scope,false))throw noGameScopeError();
      if(!scopeAllowsGame(scope,false,g.game_id))throw denied();
    }
  }
  const terminal=g.order_status==="COMPLETED"||g.order_status==="CANCELLED";
  let refundCompletedAt:string|null=null;
  if(g.order_status==="CANCELLED"&&(g.order_cancel_reason==="PRESTART_TERMINATED"||g.order_cancel_reason==="SUPPORT_CANCELLED_REFUND")){
    const termination=(await c.query<{id:string;payment_basis:PrestartPaymentBasis}>(`SELECT id,payment_basis FROM zzsh_order.prestart_termination
      WHERE order_id=$1 AND state='APPROVED' ORDER BY approved_at DESC NULLS LAST,id DESC LIMIT 1`,[orderId])).rows[0];
    if(termination)refundCompletedAt=(await readPrestartRefundProgress(c,termination.id,termination.payment_basis,false)).completedLocallyAt??null;
  }
  const serverNow = Date.now();
  const window=terminalSendWindow({now:serverNow,orderStatus:g.order_status,cancelReason:g.order_cancel_reason??null,cancelledAt:g.order_cancelled_at??null,
    settlementPostedAt:g.settlement_posted_at??null,refundCompletedAt});
  const orderEndedAt=window.orderEndedAt;
  const sendUntil=window.sendUntil;
  if(terminal)canSend=canSend&&window.terminalSendAllowed;
  const stageCards=g.app_id ? (await readStageCardsByOrderIds(c,String(g.app_id),[orderId])).get(orderId)??[] : [];
  const members=await readOrderTeamMemberRows(c,orderId,g.app_id);
  const own=members.find(m=>m.platform_subject_id===actor.userId&&m.realm===actor.realm&&m.identity_kind===(actor.realm==="user"?"USER":"ADMIN"));
  if(actor.realm==="admin"&&(!own||own.party!=="STAFF"||own.state!=="JOINED"))throw denied();
  const escalationState=g.escalation_state_projection??"NOT_STARTED";
  const snapshotLines=(g.quote_snapshot as {lines?:Array<{itemId?:unknown}>}|null)?.lines;
  const itemIds=Array.isArray(snapshotLines)?[...new Set(snapshotLines.map(line=>line&&typeof line.itemId==="string"?line.itemId:"").filter(Boolean))]:[];
  const names=new Map<string,string>();
  if(itemIds.length>0){
    const rows=(await c.query<{id:string;name:string}>(`SELECT id,name FROM zzsh_supply.billable_item WHERE id=ANY($1::text[])`,[itemIds])).rows;
    for(const row of rows)names.set(row.id,row.name);
  }
  const viewerParty:OrderTermsViewerParty=actor.realm==="admin"?"STAFF":g.renter_user_id===actor.userId?"RENTER":"OWNER";
  const terms=projectOrderTerms(g.quote_snapshot,names,viewerParty);
  let frozenInventory:ReturnType<typeof projectFrozenInventory>|undefined;
  if(actor.realm==="admin"){
    const projected=projectFrozenInventory(g.quote_snapshot,names);
    if(projected.length>0)frozenInventory=projected;
  }
  const openingAcks={renter:false,owner:false};
  const openingAckSources:{renter:"PARTY"|"ON_BEHALF"|"AUTO"|null;owner:"PARTY"|"ON_BEHALF"|"AUTO"|null}={renter:null,owner:null};
  if(g.opening_id!=null){
    const acks=(await c.query<{party:string;source:string}>(`SELECT party,source FROM zzsh_order.rental_opening_ack WHERE opening_id=$1 AND party IN ('RENTER','OWNER')`,[g.opening_id])).rows;
    const renter=acks.find(a=>a.party==="RENTER"),owner=acks.find(a=>a.party==="OWNER");
    openingAcks.renter=Boolean(renter);
    openingAcks.owner=Boolean(owner);
    openingAckSources.renter=renter?.source==="ON_BEHALF"||renter?.source==="AUTO"?renter.source:renter?"PARTY":null;
    openingAckSources.owner=owner?.source==="ON_BEHALF"||owner?.source==="AUTO"?owner.source:owner?"PARTY":null;
  }
  const openingConfirmSource=g.opening_confirm_source==="PARTY"||g.opening_confirm_source==="ON_BEHALF"||g.opening_confirm_source==="AUTO"?g.opening_confirm_source:null;
  const fulfillment=projectOrderFulfillment({orderStatus:g.order_status,hasGroup:g.app_id!=null,provisionState:g.provision_state??null,
    teamState:g.team_state??null,openingStatus:g.opening_status??null,openingConfirmedAt:g.opening_confirmed_at??null,
    openingAcked:openingAcks.renter||openingAcks.owner,termSeconds:g.term_seconds,
    intakeOpen:g.intake_open===true,currentSettlement:g.settlement_current===true,posted:g.settlement_posted_at!=null});
  const summary={serverNow:new Date(serverNow).toISOString(),terminalSendAllowed:window.terminalSendAllowed,orderId,displayNo:g.display_no,orderStatus:g.order_status,stageCards,cancelReason:g.order_cancel_reason??null,orderEndedAt,sendUntil,refundPending:window.refundPending,refundCompletedAt:window.refundCompletedAt,...fulfillment,openingAcks,openingAckSources,
    openingId:g.opening_id??null,openingVersion:Number.isInteger(g.opening_version_no)?Number(g.opening_version_no):null,
    openingConfirmDueAt:g.opening_confirm_due_at?new Date(g.opening_confirm_due_at).toISOString():null,
    openingConfirmSource,terms,gameName:g.game_name,account:{id:g.account_id,title:g.title},assignmentState:g.provision_state??null,
    ...(frozenInventory?{frozenInventory}:{}),
    supportEscalation:{firstResponseAt:g.escalation_first_response_at??null,remindDueAt:g.escalation_remind_due_at??null,
      addRound:Number(g.escalation_add_round??0),state:escalationState,needsManualReview:escalationState==="VERIFY_REQUIRED"||escalationState==="EXHAUSTED",
      noEligibleStaff:escalationState==="EXHAUSTED"}};
  if(g.team_state!=="READY"){
    if(operation==="send")throw denied();
    return {...summary,teamState:g.team_state??null,teamId:null,members:[],canRead:false,canSend:false};
  }
  const expected={provider:"yunxin" as const,appId:g.app_id as string,realm:actor.realm,kind:actor.realm==="user"?"USER" as const:"ADMIN" as const,platformSubjectId:actor.userId};
  if(!own||own.state!=="JOINED"||own.status!=="READY"||own.account_id!==deriveYunxinAccountId(expected)||own.identity_marker!==buildYunxinIdentityMarker(expected))throw denied();
  if(operation==="send"&&!canSend)throw denied();
  const conversationId=`${own.account_id}|2|${g.team_id}`;
  let messageRoute:OrderImSdkRoute|undefined;
  try {
    messageRoute=operation==="send"?orderImSdkRouteBindings?.forScope({
      appId:g.app_id,orderId,teamId:String(g.team_id),conversationId,
    }):undefined;
  } catch(error) {
    if(error instanceof OrderImSdkRouteError)throw denied();
    throw error;
  }
  return {...summary,appId:g.app_id,teamState:"READY",teamId:g.team_id,name:g.team_name,
    viewerAccountId:own.account_id,botAccountId:deriveYunxinAccountId(supportManagerIdentityKey(g.app_id)),conversationId,canRead:true,canSend,
    ...(messageRoute?{messageRoute}:{}),
    members:projectOrderTeamMembers(members,g.escalation_responsible_admin_id??g.assigned_admin_id,actor.realm)};
}

/**
 * 阶段卡读模型。
 *
 * 账本（zzsh_order.im_order_stage_card）里的 state / failure_class / next_attempt_at 原本只有
 * worker 自己读写，管理端完全看不到“这张卡为什么没发出去”。这里只做只读投影，不改变任何投递规则：
 * - 中文标签只覆盖 worker 自己会写的 code；未知 code 原样回传（failureLabel === failureClass），
 *   排障时不会把“没见过的失败”折叠成一句“发送失败”。
 * - retryable 只表示 worker 还会自己重试；终态跳过不谎称可重试。
 */
export const STAGE_CARD_KIND_LABEL: Record<StageCardKind, string> = {
  ORDER_WELCOME: "订单群建立",
  ORDER_OPENING: "开租确认",
  ORDER_ENDING: "结束确认",
  ORDER_SETTLED: "结算完成",
};

const STAGE_CARD_FAILURE_LABEL: Record<string, string> = {
  IDENTITY_PENDING: "系统账号未就绪（云信账号仍在创建或校验）",
  SEND_FAILED: "通道发送失败（云信返回失败或超时）",
  LEASE_EXPIRED: "发送中断（租约过期，等待重新领取）",
  TEXT_TRANSPORT_UNAVAILABLE: "文本通道不可用（本 App 未配置发送通道）",
  INVALID_STAGE_KIND: "卡片类型非法（数据异常，需人工核查）",
  ORDER_ENDED: "订单已离开付款状态，卡片不再发送",
  ORDER_CANCELLED: "订单已取消，卡片不再发送",
  ORDER_NOT_PAID: "订单未付款，卡片不再发送",
  SEND_WINDOW_CLOSED: "超出结算后 72 小时沟通窗口，卡片不再发送",
  STAGE_SUPERSEDED: "订单已结束，前序阶段卡不再补发",
  STAGE_NOT_REACHED: "订单尚未结算，结算完成卡不发送",
  WELCOME_SUPERSEDED: "群内已有更早的消息，欢迎语不再补发",
};
/** Worker 会自己重试的失败；其余都是终态事实。 */
const STAGE_CARD_RETRYABLE: ReadonlySet<string> = new Set(["IDENTITY_PENDING", "SEND_FAILED", "LEASE_EXPIRED", "TEXT_TRANSPORT_UNAVAILABLE"]);

export type StageCardAttention = {
  kind: string;
  kindLabel: string;
  state: string;
  attemptCount: number;
  failureClass: string | null;
  failureLabel: string | null;
  retryable: boolean;
  needsAttention: boolean;
  nextAttemptAt: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  orderId?: string;
  displayNo?: string | null;
  orderStatus?: string | null;
};
export type StageCardQueueSummary = { pending: number; failed: number; skipped: number; attention: StageCardAttention | null };

type StageCardRow = {
  id?: string; orderId?: string | null; displayNo?: string | null; orderStatus?: string | null;
  kind: string; state: string; attemptCount?: number | string | null;
  failureClass?: string | null; nextAttemptAt?: Date | string | null;
  sentAt?: Date | string | null; updatedAt?: Date | string | null;
};

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function stageCardCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/** One card row → the admin projection. Unknown kind/failure codes keep their raw value. */
export function projectStageCardAttention(row: StageCardRow): StageCardAttention {
  const failureClass = typeof row.failureClass === "string" && row.failureClass.length > 0 ? row.failureClass : null;
  const kindLabel = Object.hasOwn(STAGE_CARD_KIND_LABEL, row.kind) ? STAGE_CARD_KIND_LABEL[row.kind as StageCardKind] : row.kind;
  const failureLabel = failureClass === null ? null : STAGE_CARD_FAILURE_LABEL[failureClass] ?? failureClass;
  return {
    kind: row.kind,
    kindLabel,
    state: row.state,
    attemptCount: stageCardCount(row.attemptCount),
    failureClass,
    failureLabel,
    retryable: row.state === "PENDING" && failureClass !== null && STAGE_CARD_RETRYABLE.has(failureClass),
    needsAttention: row.state !== "SENT" && failureClass !== null,
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
    sentAt: isoOrNull(row.sentAt),
    updatedAt: isoOrNull(row.updatedAt),
    ...(row.orderId ? { orderId: row.orderId } : {}),
    ...(row.displayNo === undefined ? {} : { displayNo: row.displayNo }),
    ...(row.orderStatus === undefined ? {} : { orderStatus: row.orderStatus }),
  };
}

/** The queue badge for one order: counts plus the single card an operator should look at first. */
export function projectStageCardQueue(card: unknown, counts: unknown): StageCardQueueSummary {
  const source = (counts ?? {}) as { pending?: unknown; failed?: unknown; skipped?: unknown };
  const row = card !== null && typeof card === "object" && !Array.isArray(card) && typeof (card as { kind?: unknown }).kind === "string"
    ? projectStageCardAttention(card as StageCardRow)
    : null;
  return { pending: stageCardCount(source.pending), failed: stageCardCount(source.failed), skipped: stageCardCount(source.skipped), attention: row };
}

const STAGE_CARD_COLUMNS = `sc.id,sc.order_id AS "orderId",sc.kind,sc.state,sc.attempt_count AS "attemptCount",
  sc.failure_class AS "failureClass",sc.next_attempt_at AS "nextAttemptAt",sc.sent_at AS "sentAt",sc.updated_at AS "updatedAt",
  o.display_no AS "displayNo",o.status AS "orderStatus"`;

/** Detail read: every card of the order, SENT included. One batched query per read. */
export async function readStageCardsByOrderIds(c:Pick<PoolClient,"query">,appId:string,orderIds:string[]):Promise<Map<string,StageCardAttention[]>>{
  const wanted=[...new Set(orderIds.filter((id)=>typeof id==="string"&&id.length>0))];
  if(wanted.length===0)return new Map();
  const rows=(await c.query<StageCardRow & {orderId:string}>(`SELECT ${STAGE_CARD_COLUMNS}
      FROM zzsh_order.im_order_stage_card sc JOIN zzsh_order.rental_order o ON o.id=sc.order_id
     WHERE sc.app_id=$1 AND sc.order_id=ANY($2::text[]) ORDER BY sc.order_id,sc.created_at,sc.id`,[appId,wanted])).rows;
  const result=new Map<string,StageCardAttention[]>();
  for(const row of rows){const list=result.get(row.orderId)??[];list.push(projectStageCardAttention(row));result.set(row.orderId,list);}
  return result;
}

const STAGE_CARD_CURSOR=/^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\|([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

export type StageCardFailurePage = {
  items: StageCardAttention[];
  nextCursor: string | null;
  limit: number;
  summary: { total: number; pending: number; sending: number; skipped: number; sent: number; failed: number };
};

/**
 * 跨订单的失败清单：只读、按 App 隔离、按 updated_at 倒序分页。
 * items 只列“没发出去/被跳过”的卡；SENT 只进 summary，避免运营翻历史噪音。
 */
export async function readStageCardFailures(c:Pick<PoolClient,"query">,input:{appId:string;limit?:number;cursor?:string|null}):Promise<StageCardFailurePage>{
  const limit=input.limit===undefined?20:input.limit;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError("INVALID_LIMIT");
  const cursor=input.cursor??null;
  const parsed=cursor===null?null:STAGE_CARD_CURSOR.exec(cursor);
  if(cursor!==null&&!parsed)throw new RangeError("INVALID_CURSOR");
  const rows=(await c.query<StageCardRow>(`SELECT ${STAGE_CARD_COLUMNS}
      FROM zzsh_order.im_order_stage_card sc JOIN zzsh_order.rental_order o ON o.id=sc.order_id
     WHERE sc.app_id=$1 AND sc.state<>'SENT'
       AND ($3::timestamptz IS NULL OR (sc.updated_at,sc.id)<($3::timestamptz,$4::text))
     ORDER BY sc.updated_at DESC,sc.id DESC LIMIT $2`,[input.appId,limit+1,parsed?parsed[1]:null,parsed?parsed[2]:null])).rows;
  const page=rows.slice(0,limit);
  const counts=(await c.query<Record<string,string>>(`SELECT count(*) AS total,count(*) FILTER (WHERE state='PENDING') AS pending,
        count(*) FILTER (WHERE state='SENDING') AS sending,count(*) FILTER (WHERE state='SKIPPED') AS skipped,
        count(*) FILTER (WHERE state='SENT') AS sent,count(*) FILTER (WHERE state<>'SENT' AND failure_class IS NOT NULL) AS failed
       FROM zzsh_order.im_order_stage_card WHERE app_id=$1`,[input.appId])).rows[0];
  const last=page.at(-1);
  const nextCursor=rows.length>limit&&last&&last.updatedAt&&last.id
    ? `${new Date(last.updatedAt).toISOString()}|${last.id}` : null;
  return {
    items:page.map(projectStageCardAttention),
    nextCursor,
    limit,
    summary:{total:stageCardCount(counts?.total),pending:stageCardCount(counts?.pending),sending:stageCardCount(counts?.sending),
      skipped:stageCardCount(counts?.skipped),sent:stageCardCount(counts?.sent),failed:stageCardCount(counts?.failed)},
  };
}

export type StageCardRequeueOutcome="RETRY_SCHEDULED"|"ALREADY_SENT"|"SKIPPED_TERMINAL"|"ALREADY_PENDING"|"NOT_FOUND";

/**
 * 人工“立即重试”：只对 worker 还会重试的卡生效（把退避拉到当前，保留 attempt_count）。
 * 已发送/已跳过的卡不重发——跳过是订单事实，补发会把过期话术塞回群里；那类交客服在群里说明。
 */
export async function requeueStageCard(c:Pick<PoolClient,"query">,input:{appId:string;orderId:string;kind:string}):Promise<{requeued:boolean;outcome:StageCardRequeueOutcome}>{
  const rescheduled=await c.query(`UPDATE zzsh_order.im_order_stage_card
      SET next_attempt_at=clock_timestamp(),failure_class=NULL,updated_at=clock_timestamp()
    WHERE app_id=$1 AND order_id=$2 AND kind=$3 AND state='PENDING' AND failure_class IS NOT NULL`,[input.appId,input.orderId,input.kind]);
  if((rescheduled.rowCount??0)>0)return {requeued:true,outcome:"RETRY_SCHEDULED"};
  const reclaimed=await c.query(`UPDATE zzsh_order.im_order_stage_card
      SET state='PENDING',lease_until=NULL,lease_token_hash=NULL,next_attempt_at=clock_timestamp(),
          failure_class='LEASE_EXPIRED',updated_at=clock_timestamp()
    WHERE app_id=$1 AND order_id=$2 AND kind=$3 AND state='SENDING' AND lease_until<=clock_timestamp()`,[input.appId,input.orderId,input.kind]);
  if((reclaimed.rowCount??0)>0)return {requeued:true,outcome:"RETRY_SCHEDULED"};
  const row=(await c.query<{state:string}>(`SELECT state FROM zzsh_order.im_order_stage_card WHERE app_id=$1 AND order_id=$2 AND kind=$3`,[input.appId,input.orderId,input.kind])).rows[0];
  if(!row)return {requeued:false,outcome:"NOT_FOUND"};
  if(row.state==="SENT")return {requeued:false,outcome:"ALREADY_SENT"};
  if(row.state==="SKIPPED")return {requeued:false,outcome:"SKIPPED_TERMINAL"};
  return {requeued:false,outcome:"ALREADY_PENDING"};
}
/** Short queue todo derived from the same stage facts; it never replaces the detail projection. */
function queueTodo(f: OrderFulfillment, now = Date.now()): string | null {
  switch (f.stage) {
    case "PENDING_PAYMENT": return "未付款";
    case "WAITING_STAFF": return "待客服接入";
    case "TEAM_PENDING": return "待建群";
    case "OPENING_CONFIRM": return "待开租确认";
    case "RENTING": {
      const due = f.dueAt ? new Date(f.dueAt).getTime() : Number.NaN;
      if (Number.isFinite(due)) return due <= now ? "已到期 · 待处理" : due - now <= 24 * 60 * 60 * 1_000 ? "即将到期" : "租用中";
      return "租用中";
    }
    case "ENDING": return "待结束确认";
    case "SETTLED": return "已完成";
    case "CANCELLED": return "已取消";
    default: return null;
  }
}

/** Member-scoped directory; deliberately independent of the order.read directory. */
export async function listJoinedOrderTeams(c:PoolClient,actor:OrderTeamActor,cursor:string|null,limit:number,appId?:string):Promise<Record<string,unknown>>{
  if(actor.realm!=="admin")throw denied();

  await assertAdminContextInTransaction(c,actor);
  const access=await loadEffectiveAdminAccess(c,actor.userId);
  if(!hasPermission(access,"im.support.read"))throw denied();
  assertGameScopeUsable(await readAdminGameScope(c,actor.userId),access?.isBoss===true);
  const rows=(await c.query<Record<string,any>>(`SELECT o.id,o.display_no AS "displayNo",o.title,o.status,o.created_at AS "createdAt",
      g.team_state AS "teamState",g.provision_state AS "provisionState",
      latest_opening.status AS "openingStatus",latest_opening.confirmed_at AS "openingConfirmedAt",
      EXISTS(SELECT 1 FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=latest_opening.id) AS "openingAcked",
      o.term_seconds::text AS "termSeconds",
      EXISTS(SELECT 1 FROM zzsh_order.settlement_intake si WHERE si.order_id=o.id AND si.status='OPEN') AS "intakeOpen",
      EXISTS(SELECT 1 FROM zzsh_order.settlement_version sv WHERE sv.order_id=o.id AND sv.superseded_at IS NULL) AS "settlementCurrent",
      posting.posted_at AS "postedAt",
      g.first_response_at AS "firstResponseAt",g.remind_due_at AS "remindDueAt",
      COALESCE(g.add_round,0) AS "addRound",COALESCE(g.escalation_state,'NOT_STARTED') AS "escalationState",
      (g.first_response_state='RUNNING' AND g.first_response_at IS NULL AND g.remind_due_at IS NOT NULL
        AND g.remind_due_at<=clock_timestamp()) AS "firstResponseOverdue",
      act.last_message_at AS "lastMessageAt",
      act.last_message_preview AS "lastMessagePreview",
      COALESCE(unread.unread_count,0) AS "unreadCount",
      game.name AS "gameName",to_jsonb(stage_card) AS "stageCard",to_jsonb(stage_count) AS "stageCardCounts"
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    JOIN zzsh_order.im_order_group g ON g.order_id=mm.order_id AND g.app_id=mm.app_id
    JOIN zzsh_order.rental_order o ON o.id=g.order_id JOIN zzsh_supply.game game ON game.id=o.game_id
    LEFT JOIN zzsh_order.im_order_activity act ON act.order_id=o.id
    LEFT JOIN LATERAL (
      SELECT u.unread_count FROM zzsh_order.im_order_unread u
        JOIN zzsh_iam.im_identity_mapping um ON um.id=u.identity_id AND um.app_id=g.app_id
       WHERE u.order_id=o.id AND um.platform_subject_id=$1 AND um.realm='admin' AND um.identity_kind='ADMIN' AND um.status='READY'
       LIMIT 1
    ) unread ON TRUE
    LEFT JOIN LATERAL (SELECT op.id,op.status,op.confirmed_at FROM zzsh_order.rental_opening op WHERE op.order_id=o.id
      ORDER BY op.version_no DESC LIMIT 1) latest_opening ON TRUE
    LEFT JOIN LATERAL (SELECT p.posted_at FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id
      ORDER BY p.posted_at DESC,p.id DESC LIMIT 1) posting ON TRUE
    LEFT JOIN LATERAL (
      SELECT sc.kind,sc.state,sc.failure_class AS "failureClass",sc.attempt_count AS "attemptCount",
             sc.next_attempt_at AS "nextAttemptAt",sc.sent_at AS "sentAt",sc.updated_at AS "updatedAt"
        FROM zzsh_order.im_order_stage_card sc
       WHERE sc.order_id=g.order_id AND sc.app_id=g.app_id AND sc.state<>'SENT'
       ORDER BY CASE sc.state WHEN 'SENDING' THEN 0 WHEN 'SKIPPED' THEN 1 ELSE 2 END,sc.updated_at DESC
       LIMIT 1
    ) stage_card ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE sc.state='SKIPPED') AS "skipped",
             count(*) FILTER (WHERE sc.state IN ('PENDING','SENDING')) AS "pending",
             count(*) FILTER (WHERE sc.failure_class IS NOT NULL AND sc.state<>'SENT') AS "failed"
        FROM zzsh_order.im_order_stage_card sc
       WHERE sc.order_id=g.order_id AND sc.app_id=g.app_id
    ) stage_count ON TRUE
    WHERE mm.party='STAFF' AND mm.state='JOINED' AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.status='READY'
      AND m.platform_subject_id=$1 AND m.app_id=$5 AND g.app_id=$5 AND ${gameScopeSql("o.game_id","$1","$2")}
      AND ($3::text IS NULL OR o.id<$3) ORDER BY o.id DESC LIMIT $4`,[actor.userId,access!.isBoss,cursor,limit+1,appId??null])).rows;
  const items=rows.slice(0,limit).map(({openingStatus,openingConfirmedAt,openingAcked,termSeconds,intakeOpen,settlementCurrent,postedAt,provisionState,stageCard,stageCardCounts,...row})=>{
    const fulfillment=projectOrderFulfillment({orderStatus:row.status,hasGroup:true,provisionState,teamState:row.teamState,
      openingStatus,openingConfirmedAt,openingAcked:openingAcked===true,termSeconds,intakeOpen:Boolean(intakeOpen),
      currentSettlement:Boolean(settlementCurrent),posted:postedAt!==null});
    return {...row,stage:fulfillment.stage,dueAt:fulfillment.dueAt,todo:queueTodo(fulfillment),stageCards:projectStageCardQueue(stageCard,stageCardCounts)};
  });
  return {items,nextCursor:rows.length>limit?rows[limit-1]!.id:null,limit};
}

const ORDER_TEAM_CONVERSATION=/^([A-Za-z0-9][A-Za-z0-9_@.-]{0,31})\|2\|([0-9]{1,19})$/;

/**
 * 订单群没有客服轮次：记录真实最后活动，并按 JOINED 成员身份递增未读。
 * 发送成功后 best-effort 调用；活动/未读失败不能把已发送改判为失败。
 */
export async function recordOrderGroupMessage(c:{query:PoolClient["query"]},appId:string,conversationId:string,preview:string|null):Promise<boolean>{
  const match=ORDER_TEAM_CONVERSATION.exec(conversationId);
  const senderAccountId=match?.[1];
  const teamId=match?.[2];
  if(!teamId||!senderAccountId)return false;
  const text=preview===null?null:[...preview.replace(/\s+/g," ").trim()].slice(0,80).join("")||null;
  const activity=await c.query(
    `INSERT INTO zzsh_order.im_order_activity(order_id,app_id,last_message_at,last_message_preview)
     SELECT g.order_id,g.app_id,clock_timestamp(),$3
       FROM zzsh_order.im_order_group g
      WHERE g.app_id=$1 AND g.team_id=$2
     ON CONFLICT(order_id) DO UPDATE
       SET last_message_at=EXCLUDED.last_message_at,last_message_preview=EXCLUDED.last_message_preview`,
    [appId,teamId,text],
  );
  if((activity.rowCount??activity.rows.length)===0)return false;
  await c.query(
    `INSERT INTO zzsh_order.im_order_unread(order_id,identity_id,unread_count)
     SELECT mm.order_id,mm.identity_id,1
       FROM zzsh_order.im_order_group g
       JOIN zzsh_order.im_order_member mm ON mm.order_id=g.order_id AND mm.app_id=g.app_id AND mm.state='JOINED'
       JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
      WHERE g.app_id=$1 AND g.team_id=$2 AND m.account_id<>$3
     ON CONFLICT(order_id,identity_id) DO UPDATE
       SET unread_count=LEAST(zzsh_order.im_order_unread.unread_count+1,999)`,
    [appId,teamId,senderAccountId],
  );
  return true;
}

/** 打开订单群时只清当前成员自己的未读；成员关系由服务端复核。 */
export async function markOrderGroupRead(c:{query:PoolClient["query"]},appId:string,orderId:string,actor:OrderTeamActor):Promise<{orderId:string;unreadCount:number}>{
  const kind=actor.realm==="user"?"USER":"ADMIN";
  const identity=(await c.query<{id:string}>(
    `SELECT m.id
       FROM zzsh_iam.im_identity_mapping m
       JOIN zzsh_order.im_order_member mm ON mm.identity_id=m.id AND mm.app_id=m.app_id
      WHERE m.app_id=$1 AND m.platform_subject_id=$2 AND m.realm=$3 AND m.identity_kind=$4
        AND mm.order_id=$5 AND mm.state='JOINED' AND m.status='READY'
      LIMIT 1`,
    [appId,actor.userId,actor.realm,kind,orderId],
  )).rows[0];
  if(!identity)throw denied();
  await c.query(
    `INSERT INTO zzsh_order.im_order_unread(order_id,identity_id,unread_count,last_read_at)
     VALUES($1,$2,0,clock_timestamp())
     ON CONFLICT(order_id,identity_id) DO UPDATE
       SET unread_count=0,last_read_at=clock_timestamp()`,
    [orderId,identity.id],
  );
  return {orderId,unreadCount:0};
}
