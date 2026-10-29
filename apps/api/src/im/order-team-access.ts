import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { assertGameScopeUsable, gameScopeSql, noGameScopeError, readAdminGameScope, scopeAllowsGame, scopeIsEmpty } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";
import { decimalToBigInt, formatDecimalExact, formatScaledInteger, parseNonNegativeDecimal } from "../supply/decimal";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";
import { OrderImSdkRouteError, type OrderImSdkRoute, type OrderImSdkRouteBindings } from "../config/config";

export type OrderTeamActor={realm:"user"|"admin";userId:string;sessionId:string};
const denied=()=>new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
const POST_END_SEND_WINDOW_MS=72*60*60*1000;

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
/** Same checks for every JOINED staff member; responsibility is not an exclusive grant. */
export async function readOrderTeamAccess(c:PoolClient,actor:OrderTeamActor,orderId:string,operation:"read"|"send"="read",
  orderImSdkRouteBindings?:OrderImSdkRouteBindings):Promise<Record<string,unknown>>{
  if(actor.realm==="user")await assertUserContextInTransaction(c,actor);else await assertAdminContextInTransaction(c,actor);
  const g=(await c.query(`SELECT g.*,o.renter_user_id,o.owner_user_id,o.game_id,o.display_no,o.status AS order_status,o.cancelled_at AS order_cancelled_at,o.title,o.account_id,o.quote_snapshot AS quote_snapshot,game.name AS game_name,
      o.term_seconds::text AS term_seconds,
      latest_opening.id AS opening_id,latest_opening.status AS opening_status,latest_opening.confirmed_at AS opening_confirmed_at,
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
    LEFT JOIN LATERAL (SELECT op.id,op.status,op.confirmed_at FROM zzsh_order.rental_opening op WHERE op.order_id=o.id
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
  const endedSource=g.order_status==="COMPLETED"?g.settlement_posted_at:g.order_status==="CANCELLED"?g.order_cancelled_at:null;
  const endedMs=endedSource==null?null:new Date(endedSource).getTime();
  const orderEndedMs=endedMs!==null&&Number.isFinite(endedMs)?endedMs:null;
  const sendUntilMs=orderEndedMs===null?null:orderEndedMs+POST_END_SEND_WINDOW_MS;
  const orderEndedAt=orderEndedMs===null?null:new Date(orderEndedMs).toISOString();
  const sendUntil=sendUntilMs===null?null:new Date(sendUntilMs).toISOString();
  if(terminal)canSend=canSend&&sendUntilMs!==null&&Date.now()<sendUntilMs;
  const members=(await c.query(`SELECT mm.party,mm.state,m.platform_subject_id,m.identity_kind,m.realm,m.account_id,m.status,m.identity_marker,
    CASE WHEN m.realm='user' THEN u.name ELSE a.name END AS name,
    CASE WHEN m.realm='user' THEN u.image ELSE a.image END AS avatar
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
    LEFT JOIN zzsh_auth_user."user" u ON m.realm='user' AND u.id=m.platform_subject_id
    LEFT JOIN zzsh_auth_admin."user" a ON m.realm='admin' AND a.id=m.platform_subject_id WHERE mm.order_id=$1 AND mm.app_id=$2`,[orderId,g.app_id])).rows;
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
  if(g.opening_id!=null){
    const acks=(await c.query<{party:string}>(`SELECT party FROM zzsh_order.rental_opening_ack WHERE opening_id=$1 AND party IN ('RENTER','OWNER')`,[g.opening_id])).rows;
    openingAcks.renter=acks.some(a=>a.party==="RENTER");
    openingAcks.owner=acks.some(a=>a.party==="OWNER");
  }
  const fulfillment=projectOrderFulfillment({orderStatus:g.order_status,hasGroup:g.app_id!=null,provisionState:g.provision_state??null,
    teamState:g.team_state??null,openingStatus:g.opening_status??null,openingConfirmedAt:g.opening_confirmed_at??null,
    openingAcked:openingAcks.renter||openingAcks.owner,termSeconds:g.term_seconds,
    intakeOpen:g.intake_open===true,currentSettlement:g.settlement_current===true,posted:g.settlement_posted_at!=null});
  const summary={orderId,displayNo:g.display_no,orderStatus:g.order_status,orderEndedAt,sendUntil,...fulfillment,openingAcks,terms,gameName:g.game_name,account:{id:g.account_id,title:g.title},assignmentState:g.provision_state??null,
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
    viewerAccountId:own.account_id,conversationId,canRead:true,canSend,
    ...(messageRoute?{messageRoute}:{}),
    members:members.filter(m=>m.state==="JOINED").map(m=>({platformId:m.platform_subject_id,accountId:m.account_id,party:m.party,name:m.name,
      avatar:typeof m.avatar==="string"&&/^https?:\/\//.test(m.avatar)?m.avatar:null,
      responsible:m.party==="STAFF"&&m.platform_subject_id===(g.escalation_responsible_admin_id??g.assigned_admin_id),
      ...(actor.realm==="admin"&&m.realm==="user"?{membershipStatus:"UNKNOWN",identityStatus:"UNKNOWN"}:{})}))};
}

/** Member-scoped directory; deliberately independent of the order.read directory. */
export async function listJoinedOrderTeams(c:PoolClient,actor:OrderTeamActor,cursor:string|null,limit:number):Promise<Record<string,unknown>>{
  if(actor.realm!=="admin")throw denied();
  await assertAdminContextInTransaction(c,actor);
  const access=await loadEffectiveAdminAccess(c,actor.userId);
  if(!hasPermission(access,"im.support.read"))throw denied();
  assertGameScopeUsable(await readAdminGameScope(c,actor.userId),access?.isBoss===true);
  const rows=(await c.query(`SELECT o.id,o.display_no AS "displayNo",o.title,o.status,g.team_state AS "teamState",game.name AS "gameName",
      to_jsonb(g)->>'first_response_at' AS "firstResponseAt",
      (to_jsonb(g)->>'remind_due_at') AS "remindDueAt",
      COALESCE((to_jsonb(g)->>'add_round')::int,0) AS "addRound",
      COALESCE(to_jsonb(g)->>'escalation_state','NOT_STARTED') AS "escalationState"
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    JOIN zzsh_order.im_order_group g ON g.order_id=mm.order_id AND g.app_id=mm.app_id
    JOIN zzsh_order.rental_order o ON o.id=g.order_id JOIN zzsh_supply.game game ON game.id=o.game_id
    WHERE mm.party='STAFF' AND mm.state='JOINED' AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.status='READY'
      AND m.platform_subject_id=$1 AND ${gameScopeSql("o.game_id","$1","$2")}
      AND ($3::text IS NULL OR o.id<$3) ORDER BY o.id DESC LIMIT $4`,[actor.userId,access!.isBoss,cursor,limit+1])).rows;
  return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1]!.id:null,limit};
}
