import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { readAdminGameScope, scopeAllowsGame } from "../auth/admin-scope";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { lockSupportMutation } from "./support-dispatch";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";
import { readOrderTeamAccess, readOrderTeamMemberRows, projectOrderTeamMembers, type OrderTeamActor } from "./order-team-access";
import { supportManagerIdentityKey } from "./consultation";
import { legacyOrderReadState, LEGACY_CONTINUATION_CANCELLED_AT_SQL, LEGACY_ORDER_STATUS_SQL } from "../order/legacy-order-read";
import { OrderImSdkRouteError, type OrderImSdkRouteBindings } from "../config/config";
import { legacyTeamSendWindow } from "./legacy-order-team-window";

type Actor = { userId:string; sessionId:string };
type LegacyParties = { game_id:string; renter_user_id:string; owner_user_id:string };

export async function assertLegacyOrderTeamRequest(c:PoolClient,actor:Actor,orderId:string):Promise<LegacyParties>{
  await assertAdminContextInTransaction(c,actor);
  const access=await loadEffectiveAdminAccess(c,actor.userId);
  if(!hasPermission(access,ADMIN_PERMISSION.orderRead)||!hasPermission(access,ADMIN_PERMISSION.imSupportRead)||!hasPermission(access,ADMIN_PERMISSION.imSupportAccept))
    throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
  const order=(await c.query<LegacyParties>(`SELECT game_id,renter_user_id,owner_user_id FROM zzsh_order.legacy_order_read_snapshot
    WHERE id=$1 AND COALESCE(source_snapshot->>'is_delete','0')='0'`,[orderId])).rows[0];
  if(!order||!scopeAllowsGame(await readAdminGameScope(c,actor.userId),access?.isBoss===true,order.game_id))
    throw new SecurityApiError(404,"NOT_FOUND","Order not found");
  if(order.renter_user_id===order.owner_user_id)throw new SecurityApiError(409,"CONFLICT","订单双方身份相同，请核对后联系客服处理");
  return order;
}

/** Creates one durable intent; the existing Team worker owns provider creation and reconciliation. */
export async function requestLegacyOrderTeam(c:PoolClient,actor:Actor,appId:string,orderId:string,requestId:string){
  const observed=await assertLegacyOrderTeamRequest(c,actor,orderId);
  await lockSupportMutation(c,appId,[observed.renter_user_id,observed.owner_user_id],[actor.userId]);
  await assertLegacyOrderTeamRequest(c,actor,orderId);
  const inserted=await c.query(`INSERT INTO zzsh_order.im_order_group(order_id,legacy_order_id,payment_confirmation_id,app_id)
    VALUES($1,$1,NULL,$2) ON CONFLICT(order_id) DO NOTHING RETURNING order_id`,[orderId,appId]);
  if(inserted.rowCount){
    await c.query(`UPDATE zzsh_order.im_order_group SET provision_state='ASSIGNED',assigned_admin_id=$2,assigned_at=clock_timestamp(),version=version+1
      WHERE order_id=$1 AND app_id=$3 AND legacy_order_id=$1`,[orderId,actor.userId,appId]);
    await recordAudit(c,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,requestId,
      action:"im.order.legacy_team.requested",objectType:"rental_order",objectId:orderId,outcome:"SUCCESS",details:{origin:"LEGACY",appId}});
  }
  const group=(await c.query<{legacy_order_id:string|null;app_id:string;assigned_admin_id:string|null;team_state:string}>(
    `SELECT legacy_order_id,app_id,assigned_admin_id,team_state FROM zzsh_order.im_order_group WHERE order_id=$1`,[orderId])).rows[0];
  if(!group||group.legacy_order_id!==orderId||group.app_id!==appId)throw new SecurityApiError(409,"CONFLICT","订单群绑定冲突，需要客服核对");
  return { created:Boolean(inserted.rowCount), teamState:group.team_state, assignedToCurrentOperator:group.assigned_admin_id===actor.userId };
}

export async function readLegacyOrderTeamAccess(c:PoolClient,actor:OrderTeamActor,orderId:string,operation:"read"|"send"="read",bindings?:OrderImSdkRouteBindings):Promise<Record<string,unknown>>{
  if(actor.realm==="user")await assertUserContextInTransaction(c,actor);else await assertAdminContextInTransaction(c,actor);
  const row=(await c.query(`SELECT l.id,l.original_order_no,l.renter_user_id,l.owner_user_id,l.game_id,l.account_id,
    l.source_order_status,l.source_pay_status,${LEGACY_CONTINUATION_CANCELLED_AT_SQL} AS source_cancelled_at,l.source_completed_at,h.stage AS continuation_stage,
    (SELECT v.created_at FROM zzsh_order.legacy_continuation_version v WHERE v.order_id=l.id AND v.command='CONFIRM' ORDER BY v.revision DESC LIMIT 1) AS continuation_completed_at,game.name AS game_name,
    g.app_id,g.assigned_admin_id,g.provision_state,g.team_state,g.team_id,g.team_name,g.team_ready_at
    FROM zzsh_order.legacy_order_read_snapshot l JOIN zzsh_supply.game game ON game.id=l.game_id
    LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL
    LEFT JOIN zzsh_order.im_order_group g ON g.order_id=l.id AND g.legacy_order_id=l.id
    WHERE l.id=$1 AND COALESCE(l.source_snapshot->>'is_delete','0')='0'`,[orderId])).rows[0];
  if(!row)throw new SecurityApiError(404,"NOT_FOUND","Order Team unavailable");
  if(actor.realm==="user"&&actor.userId!==row.renter_user_id&&actor.userId!==row.owner_user_id)
    throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
  let canSend=true;
  if(actor.realm==="admin"){
    const access=await loadEffectiveAdminAccess(c,actor.userId);
    if(!hasPermission(access,ADMIN_PERMISSION.orderRead)||!hasPermission(access,ADMIN_PERMISSION.imSupportRead)
      ||!scopeAllowsGame(await readAdminGameScope(c,actor.userId),access?.isBoss===true,row.game_id))
      throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
    canSend=hasPermission(access,ADMIN_PERMISSION.imSupportAccept);
  }
  const status=legacyOrderReadState(row.continuation_stage??row.source_order_status,row.source_pay_status);
  const window=legacyTeamSendWindow(status.status,row.team_ready_at??null,status.status==="CANCELLED"?row.source_cancelled_at??null:row.continuation_completed_at??row.source_completed_at??null);
  canSend=canSend&&window.terminalSendAllowed;
  const base={origin:"LEGACY",...(actor.realm==="user"?{subjectId:actor.userId}:{}),orderId,displayNo:row.original_order_no,orderStatus:status.status,legacyStatusLabel:status.statusLabel,
    gameName:row.game_name,account:{id:row.account_id,title:"迁入账号"},assignmentState:row.provision_state??null,
    teamState:row.team_state??null,serverNow:new Date().toISOString(),...window,
    supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:"NOT_STARTED",needsManualReview:false,noEligibleStaff:false}};
  if(!row.app_id||row.team_state!=="READY"){
    if(operation==="send")throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
    return {...base,teamId:null,members:[],canRead:false,canSend:false};
  }
  const members=await readOrderTeamMemberRows(c,orderId,row.app_id),own=members.find(m=>m.platform_subject_id===actor.userId&&m.realm===actor.realm);
  const expected={provider:"yunxin" as const,appId:row.app_id as string,realm:actor.realm,kind:actor.realm==="user"?"USER" as const:"ADMIN" as const,platformSubjectId:actor.userId};
  const partyMatches=own&&(actor.realm==="admin"?own.party==="STAFF":actor.userId===row.renter_user_id?own.party==="BUYER":own.party==="OWNER");
  const joined=own&&partyMatches&&own.state==="JOINED"&&own.status==="READY"&&own.identity_kind===expected.kind
    &&own.account_id===deriveYunxinAccountId(expected)&&own.identity_marker===buildYunxinIdentityMarker(expected);
  if(!joined){if(operation==="send")throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");return {...base,teamId:null,members:[],canRead:false,canSend:false};}
  if(operation==="send"&&!canSend)throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
  const conversationId=`${own.account_id}|2|${row.team_id}`;
  let messageRoute;
  try{messageRoute=operation==="send"?bindings?.forScope({appId:row.app_id,orderId,teamId:String(row.team_id),conversationId}):undefined;}
  catch(error){if(error instanceof OrderImSdkRouteError)throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");throw error;}
  return {...base,appId:row.app_id,teamId:row.team_id,name:row.team_name,viewerAccountId:own.account_id,
    botAccountId:deriveYunxinAccountId(supportManagerIdentityKey(row.app_id)),conversationId,canRead:true,canSend,
    ...(messageRoute?{messageRoute}:{}),members:projectOrderTeamMembers(members,row.assigned_admin_id,actor.realm)};
}

export function readAnyOrderTeamAccess(c:PoolClient,actor:OrderTeamActor,orderId:string,operation:"read"|"send"="read",bindings?:OrderImSdkRouteBindings){
  return orderId.startsWith("legacy_order_")?readLegacyOrderTeamAccess(c,actor,orderId,operation,bindings):readOrderTeamAccess(c,actor,orderId,operation,bindings);
}

export async function listJoinedLegacyOrderTeams(c:PoolClient,actor:OrderTeamActor,appId:string,party:"renter"|"owner",cursor:string|null,limit:number){
  if(actor.realm!=="user")throw new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
  await assertUserContextInTransaction(c,actor);
  const rows=(await c.query<Record<string,unknown>>(`SELECT l.id,l.original_order_no AS "displayNo",'迁入账号'::text AS title,
    ${LEGACY_ORDER_STATUS_SQL} AS status,'LEGACY'::text AS origin,g.team_ready_at AS "createdAt",
    act.last_message_at AS "lastMessageAt",act.last_message_preview AS "lastMessagePreview",COALESCE(unread.unread_count,0) AS "unreadCount",
    g.provision_state AS "assignmentState",g.team_state AS "teamState"
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    JOIN zzsh_order.im_order_group g ON g.order_id=mm.order_id AND g.app_id=mm.app_id AND g.team_state='READY'
    JOIN zzsh_order.legacy_order_read_snapshot l ON l.id=g.legacy_order_id
    LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL
    LEFT JOIN zzsh_order.im_order_activity act ON act.order_id=l.id
    LEFT JOIN zzsh_order.im_order_unread unread ON unread.order_id=l.id AND unread.identity_id=m.id
    WHERE m.app_id=$1 AND m.realm='user' AND m.identity_kind='USER' AND m.status='READY' AND m.platform_subject_id=$2
      AND mm.state='JOINED' AND mm.party=$3 AND ${party==="renter"?"l.renter_user_id":"l.owner_user_id"}=$2
      AND COALESCE(l.source_snapshot->>'is_delete','0')='0' AND ($4::text IS NULL OR l.id<$4)
    ORDER BY l.id DESC LIMIT $5`,[appId,actor.userId,party==="renter"?"BUYER":"OWNER",cursor,limit+1])).rows;
  const items=rows.slice(0,limit).map(({assignmentState,teamState,...row})=>({...row,fulfillmentAssignment:{state:assignmentState,teamState}}));
  return {subjectId:actor.userId,items,nextCursor:rows.length>limit?String(rows[limit-1]!.id):null,limit};
}
