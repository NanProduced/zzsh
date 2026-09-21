import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { SecurityApiError } from "../auth/security-core";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";

export type OrderTeamActor={realm:"user"|"admin";userId:string;sessionId:string};
const denied=()=>new SecurityApiError(403,"FORBIDDEN","Order Team access denied");
/** Same checks for every JOINED staff member; responsibility is not an exclusive grant. */
export async function readOrderTeamAccess(c:PoolClient,actor:OrderTeamActor,orderId:string,operation:"read"|"send"="read"):Promise<Record<string,unknown>>{
  if(actor.realm==="user")await assertUserContextInTransaction(c,actor);else await assertAdminContextInTransaction(c,actor);
  const g=(await c.query(`SELECT g.*,o.renter_user_id,o.owner_user_id,o.game_id,o.display_no,o.status AS order_status,o.title,o.account_id,game.name AS game_name,
      to_jsonb(g)->>'responsible_admin_id' AS escalation_responsible_admin_id,
      to_jsonb(g)->>'first_response_at' AS escalation_first_response_at,
      to_jsonb(g)->>'remind_due_at' AS escalation_remind_due_at,
      to_jsonb(g)->>'add_round' AS escalation_add_round,
      to_jsonb(g)->>'escalation_state' AS escalation_state_projection
    FROM zzsh_order.rental_order o JOIN zzsh_supply.game game ON game.id=o.game_id
    LEFT JOIN zzsh_order.im_order_group g ON g.order_id=o.id WHERE o.id=$1`,[orderId])).rows[0];
  if(!g)throw new SecurityApiError(404,"NOT_FOUND","Order Team unavailable");
  if(actor.realm==="user"&&g.renter_user_id!==actor.userId&&g.owner_user_id!==actor.userId)throw denied();
  let canSend=true;
  if(actor.realm==="admin"){
    const access=await loadEffectiveAdminAccess(c,actor.userId);
    if(!hasPermission(access,"im.support.read"))throw denied();
    canSend=hasPermission(access,"im.support.accept");
    if(!access!.isBoss&&!(await c.query(`SELECT 1 FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`,[actor.userId,g.game_id])).rowCount)throw denied();
  }
  const members=(await c.query(`SELECT mm.party,mm.state,m.platform_subject_id,m.identity_kind,m.realm,m.account_id,m.status,m.identity_marker,
    CASE WHEN m.realm='user' THEN u.name ELSE a.name END AS name,
    CASE WHEN m.realm='user' THEN u.image ELSE a.image END AS avatar
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
    LEFT JOIN zzsh_auth_user."user" u ON m.realm='user' AND u.id=m.platform_subject_id
    LEFT JOIN zzsh_auth_admin."user" a ON m.realm='admin' AND a.id=m.platform_subject_id WHERE mm.order_id=$1 AND mm.app_id=$2`,[orderId,g.app_id])).rows;
  const own=members.find(m=>m.platform_subject_id===actor.userId&&m.realm===actor.realm&&m.identity_kind===(actor.realm==="user"?"USER":"ADMIN"));
  if(actor.realm==="admin"&&(!own||own.party!=="STAFF"||own.state!=="JOINED"))throw denied();
  const escalationState=g.escalation_state_projection??"NOT_STARTED";
  const summary={orderId,displayNo:g.display_no,orderStatus:g.order_status,gameName:g.game_name,account:{id:g.account_id,title:g.title},assignmentState:g.provision_state??null,
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
  return {...summary,appId:g.app_id,teamState:"READY",teamId:g.team_id,name:g.team_name,
    viewerAccountId:own.account_id,conversationId:`${own.account_id}|2|${g.team_id}`,canRead:true,canSend,
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
  const rows=(await c.query(`SELECT o.id,o.display_no AS "displayNo",o.title,o.status,g.team_state AS "teamState",game.name AS "gameName",
      (to_jsonb(g)->>'remind_due_at') AS "remindDueAt",
      COALESCE((to_jsonb(g)->>'add_round')::int,0) AS "addRound",
      COALESCE(to_jsonb(g)->>'escalation_state','NOT_STARTED') AS "escalationState"
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    JOIN zzsh_order.im_order_group g ON g.order_id=mm.order_id AND g.app_id=mm.app_id
    JOIN zzsh_order.rental_order o ON o.id=g.order_id JOIN zzsh_supply.game game ON game.id=o.game_id
    WHERE mm.party='STAFF' AND mm.state='JOINED' AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.status='READY'
      AND m.platform_subject_id=$1 AND ($2::boolean OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$1 AND s.game_id=o.game_id))
      AND ($3::text IS NULL OR o.id<$3) ORDER BY o.id DESC LIMIT $4`,[actor.userId,access!.isBoss,cursor,limit+1])).rows;
  return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1]!.id:null,limit};
}
