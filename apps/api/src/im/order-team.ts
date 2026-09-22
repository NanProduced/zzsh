import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { lockDispatchGate, lockSupportMutation, readEligibleSupport, reserveSupportCandidate } from "./support-dispatch";
import { createImScopeLease, lockTeamBinding, onLeaseConnection } from "./scope-lease";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey, type ImIdentityProvisioner } from "./identity-lifecycle";
import { orderImSdkRouteFor, type OrderImSdkRouteConfig } from "../config/config";
import { ORDER_TEAM_CONFIGURATION, YunxinApiError, validateOrderTeamInput, type YunxinMessageRouteConfig, type YunxinOrderTeamApi, type YunxinOrderTeamInput, type YunxinOrderTeamState } from "./yunxin-provider";

export type OrderTeamOptions = { pool: Pool; appId: string; provider: YunxinOrderTeamApi;
  identities: Pick<ImIdentityProvisioner,"ensure">; membersLimit: number; leaseMs?: number;
  /** Activates first-response tracking for newly READY groups; historical groups stay NOT_STARTED. */
  firstResponseEnabled?: boolean;
  /** Explicit opt-in; requires this App's first-response ingress to be enabled as well. */
  escalationEnabled?: boolean;
  orderImSdkRouteConfig?: OrderImSdkRouteConfig };
type Db = Pool | PoolClient;
type Member = { identity_id:string; party:"BUYER"|"OWNER"|"STAFF"; state:string; account_id:string; platform_subject_id:string; realm:string; identity_kind:"USER"|"ADMIN"; status:string; identity_marker:string };
type Plan = { order_id:string; app_id:string; assigned_admin_id:string; provision_state:string; team_state:string; team_name:string|null;
  members_limit:number|null; team_id:string|null; system_identity_id:string|null; version:string;
  renter_user_id:string; owner_user_id:string; account_id:string; game_id:string; display_no:string; game_name:string; order_status:string;
  system_account:string|null; system_status:string|null; system_marker:string|null; system_subject:string|null; members:Member[] };
type Operation = { id:string;order_id:string;app_id:string;state:string;version:string;candidate_team_id:string|null;sent_at:Date|null;failure_class:string|null;next_retry_at:Date };
type EscalationOperation = Operation & { kind:"ADD_MEMBER"|"BOT_NOTICE"; round:number; target_admin_id:string|null; lease_until:Date|null; lease_token_hash:string|null };
type EscalationMember = Member;
type EscalationPlan = { order_id:string;app_id:string;assigned_admin_id:string|null;responsible_admin_id:string|null;
  provision_state:string;team_state:string;team_id:string|null;team_name:string|null;members_limit:number|null;
  remind_due_at:Date|null;next_add_due_at:Date|null;add_round:number;escalation_state:string;first_response_state:string;
  system_identity_id:string|null;system_account:string|null;system_status:string|null;system_marker:string|null;system_subject:string|null;
  renter_user_id:string;owner_user_id:string;account_id:string;game_id:string;display_no:string;game_name:string;order_status:string;
  members:EscalationMember[] };
type Claim = Operation & { token:string; readonlyMode:boolean };
export class OrderTeamError extends Error { constructor(readonly code:string){super(code);} }
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const key=(appId:string,kind:"USER"|"ADMIN"|"SYSTEM",subject:string):ImIdentityKey=>({provider:"yunxin",appId,realm:kind.toLowerCase(),kind,platformSubjectId:subject});

async function plan(db:Db,appId:string,id:string):Promise<Plan|null> {
  const row=(await db.query<Omit<Plan,"members">>(`SELECT g.*,o.renter_user_id,o.owner_user_id,o.account_id,o.game_id,o.display_no,o.status AS order_status,game.name AS game_name,
    m.account_id AS system_account,m.status AS system_status,m.identity_marker AS system_marker,m.platform_subject_id AS system_subject
    FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id JOIN zzsh_supply.game game ON game.id=o.game_id
    LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id=g.system_identity_id WHERE g.order_id=$1 AND g.app_id=$2`,[id,appId])).rows[0];
  if(!row)return null;
  const members=(await db.query<Member>(`SELECT mm.*,m.account_id,m.platform_subject_id,m.realm,m.identity_kind,m.status,m.identity_marker
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id WHERE mm.order_id=$1 ORDER BY mm.party,mm.identity_id`,[id])).rows;
  return {...row,members};
}
function inputFor(p:Plan):YunxinOrderTeamInput {
  if(p.provision_state!=="ASSIGNED"||p.order_status!=="PAID"||!p.team_name||!p.members_limit||!p.system_account||p.system_status!=="READY"
    ||p.system_subject!=="support-manager"||p.system_account!==deriveYunxinAccountId(key(p.app_id,"SYSTEM","support-manager"))
    ||p.system_marker!==buildYunxinIdentityMarker(key(p.app_id,"SYSTEM","support-manager"))||p.members.length!==3)throw new OrderTeamError("IDENTITY_PENDING");
  for(const party of ["BUYER","OWNER","STAFF"] as const){
    const members=p.members.filter(m=>m.party===party),m=members[0];
    const kind=party==="STAFF"?"ADMIN":"USER",subject=party==="BUYER"?p.renter_user_id:party==="OWNER"?p.owner_user_id:p.assigned_admin_id;
    if(members.length!==1||!m||m.status!=="READY"||m.identity_kind!==kind||m.realm!==kind.toLowerCase()||m.platform_subject_id!==subject
      ||m.account_id!==deriveYunxinAccountId(key(p.app_id,kind,subject))||m.identity_marker!==buildYunxinIdentityMarker(key(p.app_id,kind,subject)))throw new OrderTeamError("IDENTITY_PENDING");
  }
  const input={appId:p.app_id,orderId:p.order_id,name:p.team_name,ownerAccountId:p.system_account,memberAccountIds:p.members.map(m=>m.account_id),membersLimit:p.members_limit};
  validateOrderTeamInput(input);return input;
}
async function lockGroup(client:PoolClient,p:Pick<Plan,"game_id"|"account_id"|"order_id">):Promise<void>{
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE`,[p.game_id]);
  await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,[p.account_id]);
  await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE`,[p.order_id]);
  await client.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[p.order_id]);
}
async function assertBuildParticipants(c:PoolClient,p:Plan):Promise<void>{
  try { await assertActiveInTransaction(c,p.renter_user_id);await assertActiveInTransaction(c,p.owner_user_id); }
  catch { throw new OrderTeamError("IDENTITY_PENDING"); }
  const access=await loadEffectiveAdminAccess(c,p.assigned_admin_id);
  const user=(await c.query(`SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1`,[p.assigned_admin_id])).rows[0];
  if(!user||user.suspended||!hasPermission(access,"im.support.read")||!hasPermission(access,"im.support.accept")
    ||(!access!.isBoss&&!(await c.query(`SELECT 1 FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`,[p.assigned_admin_id,p.game_id])).rowCount))throw new OrderTeamError("IDENTITY_PENDING");
}
async function markWaiting(options:OrderTeamOptions,id:string,code:string):Promise<void>{
  await withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);
    await c.query(`UPDATE zzsh_order.im_order_group SET team_state=$3,team_failure=$4,team_retry_at=clock_timestamp()+interval '5 seconds',version=version+1
      WHERE order_id=$1 AND app_id=$2 AND team_name IS NULL AND team_state<>'READY'`,[id,options.appId,code==="IDENTITY_PENDING"?"IDENTITY_PENDING":"NEEDS_REVIEW",code]);
  });
}

/** Account provisioning owns its own transactions; it is never run under a Team mutex. */
export async function prepareOrderTeam(options:OrderTeamOptions,id:string):Promise<string|null>{
  const discovered=await plan(options.pool,options.appId,id);
  if(!discovered||discovered.provision_state!=="ASSIGNED"||discovered.order_status!=="PAID")return null;
  const existing=(await options.pool.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND kind='CREATE'`,[id])).rows[0];
  if(existing)return existing.id;
  const name=`${discovered.game_name}|订单:${discovered.display_no}`;
  if([...name].length>64||/[\u0000-\u001f\u007f]/.test(name)){await markWaiting(options,id,"INVALID_NAME");return null;}
  if(!Number.isInteger(options.membersLimit)||options.membersLimit<4||options.membersLimit>5000)throw new OrderTeamError("INVALID_CONFIGURATION");
  const keys=[key(options.appId,"SYSTEM","support-manager"),key(options.appId,"USER",discovered.renter_user_id),key(options.appId,"USER",discovered.owner_user_id),key(options.appId,"ADMIN",discovered.assigned_admin_id)];
  for(const k of keys){const result=await options.identities.ensure({key:k});if(result.outcome!=="READY"){await markWaiting(options,id,"IDENTITY_PENDING");return null;}}
  return withTransaction(options.pool,async(c)=>{
    await lockSupportMutation(c,options.appId,[discovered.renter_user_id,discovered.owner_user_id],[discovered.assigned_admin_id]);
    await lockGroup(c,discovered);
    await assertBuildParticipants(c,discovered);
    const old=(await c.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND kind='CREATE'`,[id])).rows[0];if(old)return old.id;
    const mappings=[];
    for(const k of keys){
      const row=(await c.query<{id:string;account_id:string;identity_marker:string;status:string}>(`SELECT id,account_id,identity_marker,status FROM zzsh_iam.im_identity_mapping
        WHERE provider='yunxin' AND app_id=$1 AND realm=$2 AND identity_kind=$3 AND platform_subject_id=$4 FOR SHARE`,[k.appId,k.realm,k.kind,k.platformSubjectId])).rows[0];
      if(!row||row.status!=="READY"||row.account_id!==deriveYunxinAccountId(k)||row.identity_marker!==buildYunxinIdentityMarker(k))throw new OrderTeamError("IDENTITY_PENDING");mappings.push(row);
    }
    const current=await plan(c,options.appId,id);
    if(!current||current.provision_state!=="ASSIGNED"||current.order_status!=="PAID"||current.assigned_admin_id!==discovered.assigned_admin_id)throw new OrderTeamError("STALE_OPERATION");
    await c.query(`UPDATE zzsh_order.im_order_group SET team_state='CREATING',system_identity_id=$2,team_name=$3,members_limit=$4,team_failure=NULL,version=version+1 WHERE order_id=$1`,[id,mappings[0]!.id,name,options.membersLimit]);
    for(let i=1;i<4;i++)await c.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party) VALUES($1,$2,$3,$4)`,[id,options.appId,mappings[i]!.id,["BUYER","OWNER","STAFF"][i-1]]);
    const opId=`im_order_op_${randomUUID().replaceAll("-","")}`;
    await c.query(`INSERT INTO zzsh_order.im_order_operation(id,order_id,app_id) VALUES($1,$2,$3)`,[opId,id,options.appId]);
    await recordAudit(c,{actorType:"system",action:"im.order.team.planned",objectType:"rental_order",objectId:id,outcome:"SUCCESS",requestId:opId});
    return opId;
  });
}

async function claim(options:OrderTeamOptions,id:string,expected?:{operationId:string;version:string;teamId:string}):Promise<Claim|null>{
  return withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);
    const op=(await c.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND app_id=$2 AND kind='CREATE' FOR UPDATE`,[id,options.appId])).rows[0];
    if(!op){if(expected)throw new OrderTeamError("BINDING_MISMATCH");return null;}
    if(expected&&(op.id!==expected.operationId||op.candidate_team_id!==expected.teamId))throw new OrderTeamError("BINDING_MISMATCH");
    if(op.state==="SUCCEEDED")return null;
    if(expected&&(op.version!==expected.version||op.state!=="NEEDS_REVIEW"||!op.candidate_team_id))throw new OrderTeamError("STALE_OPERATION");
    if(!expected&&op.state!=="PENDING")return null;
    const token=randomBytes(32).toString("hex");
    const next=(await c.query<Operation>(`UPDATE zzsh_order.im_order_operation SET state='RUNNING',version=version+1,attempt_count=attempt_count+1,
      failure_class=NULL,lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond'),lease_token_hash=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND kind='CREATE' AND version=$2 AND ($5::boolean OR next_retry_at<=clock_timestamp()) RETURNING *`,[op.id,op.version,hash(token),options.leaseMs??30000,Boolean(expected)])).rows[0];
    if(!next)return null;
    await recordAudit(c,{actorType:"system",action:"im.order.team.claimed",objectType:"im_order_operation",objectId:op.id,outcome:"SUCCESS",requestId:`${op.id}_${next.version}`,details:{readOnly:Boolean(expected),previousFailure:op.failure_class}});
    return {...next,token,readonlyMode:Boolean(expected)};
  });
}

function validateTeam(p:Plan,team:YunxinOrderTeamState|null,id:string):void{
  const input=inputFor(p),expected=[input.ownerAccountId,...input.memberAccountIds];
  let marker:unknown;try{marker=JSON.parse(team?.serverExtension??"null");}catch{throw new OrderTeamError("REMOTE_MISMATCH");}
  const m=marker as {schema?:unknown;appId?:unknown;orderId?:unknown}|null;
  if(!team||team.teamId!==id||team.ownerAccountId!==input.ownerAccountId||team.teamType!==1||team.name!==input.name||team.membersLimit!==input.membersLimit
    ||m?.schema!=="zzsh.im-order.v1"||m.appId!==p.app_id||m.orderId!==p.order_id
    ||Object.entries(ORDER_TEAM_CONFIGURATION).some(([k,v])=>team.configuration[k as keyof typeof ORDER_TEAM_CONFIGURATION]!==v)
    ||team.members.length!==4||new Set(team.members.map(x=>x.accountId)).size!==4
    ||team.members.some(x=>!expected.includes(x.accountId)||x.chatBanned!==false||x.role!==(x.accountId===input.ownerAccountId?1:0)))throw new OrderTeamError("REMOTE_MISMATCH");
}

async function rememberCandidate(c:PoolClient,op:Claim,teamId:string):Promise<void>{
  if(!/^[0-9]{1,19}$/.test(teamId))throw new OrderTeamError("REMOTE_MISMATCH");
  // Monotonic evidence on the original CREATE: a late response may record its ID,
  // but cannot change the current lease, state or business binding.
  await c.query(`UPDATE zzsh_order.im_order_operation SET candidate_team_id=$2,updated_at=clock_timestamp()
    WHERE id=$1 AND kind='CREATE' AND sent_at IS NOT NULL AND candidate_team_id IS NULL AND state<>'SUCCEEDED'`,[op.id,teamId]);
  const stored=(await c.query(`SELECT candidate_team_id FROM zzsh_order.im_order_operation WHERE id=$1 AND kind='CREATE'`,[op.id])).rows[0];
  if(stored?.candidate_team_id!==teamId)throw new OrderTeamError("REMOTE_MISMATCH");
}
async function finish(options:OrderTeamOptions,op:Claim,team:YunxinOrderTeamState):Promise<void>{
  await withTransaction(options.pool,async(c)=>{
    const before=await plan(c,options.appId,op.order_id);if(!before)throw new OrderTeamError("STALE_OPERATION");
    await lockSupportMutation(c,options.appId,[before.renter_user_id,before.owner_user_id],[before.assigned_admin_id]);
    await lockTeamBinding(c,options.appId,team.teamId);
    if((await c.query(`SELECT 1 FROM zzsh_iam.im_consultation WHERE app_id=$1 AND message_scope_id=$2`,[options.appId,team.teamId])).rowCount)throw new OrderTeamError("TEAM_ALREADY_BOUND");
    const current=await plan(c,options.appId,op.order_id);if(!current)throw new OrderTeamError("STALE_OPERATION");
    await lockGroup(c,current);await assertBuildParticipants(c,current);validateTeam(current,team,team.teamId);
    const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state='SUCCEEDED',lease_until=NULL,lease_token_hash=NULL,failure_class=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND kind='CREATE' AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 AND lease_until>clock_timestamp() AND candidate_team_id=$4`,[op.id,op.version,hash(op.token),team.teamId]);
    if(changed.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
    await c.query(`UPDATE zzsh_order.im_order_member SET state='JOINED',joined_at=clock_timestamp() WHERE order_id=$1 AND state='PLANNED'`,[op.order_id]);
    // The new fields are only referenced when explicitly enabled; this preserves the
    // staged 0043/0044 CREATE acceptance path before migration 0045 is applied.
    const firstResponseActivation=options.firstResponseEnabled?",first_response_state='RUNNING'":"";
    const escalationActivation=options.escalationEnabled
      ? ",remind_due_at=statement_timestamp()+interval '2 minutes',next_add_due_at=statement_timestamp()+interval '4 minutes',escalation_state='RUNNING'"
      : "";
    await c.query(`UPDATE zzsh_order.im_order_group SET team_state='READY',team_id=$2,team_ready_at=statement_timestamp(),team_failure=NULL${firstResponseActivation}${escalationActivation},version=version+1 WHERE order_id=$1`,[op.order_id,team.teamId]);
    await recordAudit(c,{actorType:"system",action:"im.order.team.ready",objectType:"rental_order",objectId:op.order_id,outcome:"SUCCESS",requestId:op.id,details:{operationId:op.id,teamId:team.teamId,readOnlyReconciliation:op.readonlyMode}});
  });
}
async function fail(options:OrderTeamOptions,op:Claim,code:string):Promise<void>{
  await withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);
    await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[op.order_id]);
    const row=(await c.query(`UPDATE zzsh_order.im_order_operation SET state=CASE WHEN sent_at IS NULL AND $4='IDENTITY_PENDING' THEN 'PENDING' ELSE 'NEEDS_REVIEW' END,
      lease_until=NULL,lease_token_hash=NULL,failure_class=$4,next_retry_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND kind='CREATE' AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 RETURNING state`,[op.id,op.version,hash(op.token),code])).rows[0];
    if(row)await c.query(`UPDATE zzsh_order.im_order_group SET team_state=$2,team_failure=$3,version=version+1 WHERE order_id=$1 AND team_state<>'READY'`,[op.order_id,row.state==="PENDING"?"IDENTITY_PENDING":"NEEDS_REVIEW",code]);
  });
}
async function execute(options:OrderTeamOptions,op:Claim):Promise<void>{
  const lease=createImScopeLease(options.pool,options.appId,async(db)=>(await db.query(`UPDATE zzsh_order.im_order_operation SET lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond')
    WHERE id=$1 AND kind='CREATE' AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 AND lease_until>clock_timestamp() RETURNING id`,[op.id,op.version,hash(op.token),options.leaseMs??30000])).rowCount===1,()=>new OrderTeamError("STALE_OPERATION"));
  let phase="PROVIDER_UNKNOWN",observedCandidate:string|undefined;
  try{
    const p=await plan(options.pool,options.appId,op.order_id);if(!p)throw new OrderTeamError("STALE_OPERATION");
    const input=inputFor(p);
    let id=op.candidate_team_id;
    if(!op.readonlyMode){
      if(op.sent_at||id)throw new OrderTeamError("CREATE_ALREADY_SENT");
      const created=await lease.mutate(`order:${op.order_id}`,async(c)=>{
        await onLeaseConnection(c,async(db)=>{
          await lockSupportMutation(db,options.appId,[p.renter_user_id,p.owner_user_id],[p.assigned_admin_id]);
          await assertBuildParticipants(db,p);
          const fresh=await plan(db,options.appId,op.order_id);if(!fresh)throw new OrderTeamError("STALE_OPERATION");inputFor(fresh);
    const sent=await db.query(`UPDATE zzsh_order.im_order_operation SET sent_at=clock_timestamp() WHERE id=$1 AND kind='CREATE' AND version=$2 AND lease_token_hash=$3 AND state='RUNNING' AND lease_until>clock_timestamp() AND sent_at IS NULL`,[op.id,op.version,hash(op.token)]);
          if(sent.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
        });
        const result=await options.provider.createOrderTeam(input);
        observedCandidate=result.teamId;phase="DB_WRITEBACK_UNKNOWN";
        await rememberCandidate(c,op,result.teamId);return result;
      });
      id=created.teamId;if(created.partial)throw new OrderTeamError("PARTIAL_CREATE");
    }
    if(!id)throw new OrderTeamError("CANDIDATE_UNKNOWN");
    phase="PROVIDER_UNKNOWN";
    const team=await lease.mutate(`team:${id}`,()=>options.provider.readOrderTeam(id!));validateTeam(p,team,id);
    await lease.assertValid();await lease.stop();phase="DB_WRITEBACK_UNKNOWN";
    await finish(options,op,team!);
  }catch(error){
    await lease.stop();
    if(observedCandidate&&/^[0-9]{1,19}$/.test(observedCandidate)){
      const c=await options.pool.connect();try{await rememberCandidate(c,op,observedCandidate);}catch{
        new Logger("OrderTeamCreate").error(JSON.stringify({event:"im.order.team.candidate_unpersisted",orderId:op.order_id,operationId:op.id,teamId:observedCandidate}));
      }finally{c.release();}
    }
    await fail(options,op,error instanceof OrderTeamError?error.code:error instanceof YunxinApiError&&[108305,108435,108437].includes(error.providerCode??0)?"PROVIDER_QUOTA":phase);
  }finally{await lease.stop();}
}

export async function reconcileOrderTeam(options:OrderTeamOptions,id:string,expected:{operationId:string;version:string;teamId:string}):Promise<void>{
  const op=await claim(options,id,expected);if(op)await execute(options,op);
}
export async function advanceOrderTeam(options:OrderTeamOptions,id:string):Promise<void>{
  let opId:string|null;
  try{opId=await prepareOrderTeam(options,id);}catch(error){if(error instanceof OrderTeamError&&error.code==="IDENTITY_PENDING"){await markWaiting(options,id,error.code);return;}throw error;}
  if(!opId)return;
  const op=await claim(options,id);if(op)await execute(options,op);
}
type ScanPhase="expired"|"due"|"recoverable";
// ponytail: three in-memory positions per pool/App. Restart begins a new cycle;
// durable operation CAS, not this cursor, owns safety and duplicate prevention.
const scanPositions=new WeakMap<Pool,Map<string,Partial<Record<ScanPhase,string>>>>();
const scanLogger=new Logger("OrderTeamScan");
export async function scanOrderTeams(options:OrderTeamOptions,limit=10):Promise<void>{
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new OrderTeamError("INVALID_CONFIGURATION");
  let apps=scanPositions.get(options.pool);if(!apps){apps=new Map();scanPositions.set(options.pool,apps);}
  let position=apps.get(options.appId);if(!position){position={};apps.set(options.appId,position);}
  const attempt=async(phase:ScanPhase,row:{order_id:string;id?:string|null},action:()=>Promise<void>)=>{
    position[phase]=row.order_id;
    try{await action();}catch(error){
      const code=(error as {code?:unknown}|null)?.code;
      const failure=code==="55P03"?"LOCK_BUSY":code==="40001"?"CONCURRENT_CHANGE":code==="40P01"?"DEADLOCK"
        :["23503","23505","23514"].includes(String(code))?"OBJECT_CONSTRAINT"
        :error instanceof OrderTeamError&&error.code!=="INVALID_CONFIGURATION"?"ORDER_STATE_CONFLICT":null;
      // Unknown, connection/pool, schema and privilege failures stop the round.
      if(!failure)throw error;
      scanLogger.warn(JSON.stringify({event:"im.order.team.item_deferred",appId:options.appId,phase,orderId:row.order_id,operationId:row.id,failureClass:failure}));
    }
  };
  // Immutable IDs give each phase a bounded circular window, even if every item
  // in the first window stays locked. No retry write into the locked row is needed.
  const expired=(await options.pool.query<{order_id:string;id:string}>(`SELECT order_id,id FROM zzsh_order.im_order_operation WHERE app_id=$1 AND kind='CREATE' AND state='RUNNING' AND lease_until<=clock_timestamp()
    ORDER BY (order_id>$3) DESC,order_id LIMIT $2`,[options.appId,limit,position.expired??""])).rows;
  for(const row of expired)await attempt("expired",row,()=>withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[row.order_id]);
    const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',version=version+1,lease_until=NULL,lease_token_hash=NULL,failure_class='STALE_OPERATION',updated_at=clock_timestamp()
      WHERE order_id=$1 AND kind='CREATE' AND state='RUNNING' AND lease_until<=clock_timestamp()`,[row.order_id]);
    if(changed.rowCount)await c.query(`UPDATE zzsh_order.im_order_group SET team_state='NEEDS_REVIEW',team_failure='STALE_OPERATION',version=version+1 WHERE order_id=$1 AND team_state<>'READY'`,[row.order_id]);
  }));
  const due=(await options.pool.query<{order_id:string;id:string|null}>(`SELECT g.order_id,op.id FROM zzsh_order.im_order_group g LEFT JOIN zzsh_order.im_order_operation op ON op.order_id=g.order_id AND op.kind='CREATE'
    WHERE g.app_id=$1 AND g.provision_state='ASSIGNED' AND ((op.id IS NULL AND g.team_state IN ('PENDING','IDENTITY_PENDING') AND g.team_retry_at<=clock_timestamp())
      OR(op.state='PENDING' AND op.next_retry_at<=clock_timestamp())) ORDER BY (g.order_id>$3) DESC,g.order_id LIMIT $2`,[options.appId,limit,position.due??""])).rows;
  for(const row of due)await attempt("due",row,()=>advanceOrderTeam(options,row.order_id));
  // Restart recovery is read-only, bound to an already persisted candidate.
  // Unknown CREATE without an ID and semantic mismatches remain quarantined.
  const recoverable=(await options.pool.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE app_id=$1 AND kind='CREATE' AND state='NEEDS_REVIEW'
    AND candidate_team_id IS NOT NULL AND failure_class IN ('DB_WRITEBACK_UNKNOWN','STALE_OPERATION') AND next_retry_at<=clock_timestamp()
    ORDER BY (order_id>$3) DESC,order_id LIMIT $2`,[options.appId,limit,position.recoverable??""])).rows;
  for(const op of recoverable)await attempt("recoverable",op,()=>reconcileOrderTeam(options,op.order_id,{operationId:op.id,version:op.version,teamId:op.candidate_team_id!}));
}

type OperationalEventType="first_response_reminder"|"add_member"|"bot_notice"|"staff_exhausted"|"verify_required";

async function escalationPlan(db:Db,appId:string,id:string):Promise<EscalationPlan|null>{
  const row=(await db.query<Omit<EscalationPlan,"members">>(`SELECT g.order_id,g.app_id,g.assigned_admin_id,g.responsible_admin_id,
      g.provision_state,g.team_state,g.team_id,g.team_name,g.members_limit,g.remind_due_at,g.next_add_due_at,g.add_round,
      g.escalation_state,g.first_response_state,g.system_identity_id,
      o.renter_user_id,o.owner_user_id,o.account_id,o.game_id,o.display_no,o.status AS order_status,game.name AS game_name,
      sm.account_id AS system_account,sm.status AS system_status,sm.identity_marker AS system_marker,sm.platform_subject_id AS system_subject
    FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
    JOIN zzsh_supply.game game ON game.id=o.game_id
    LEFT JOIN zzsh_iam.im_identity_mapping sm ON sm.id=g.system_identity_id AND sm.app_id=g.app_id
    WHERE g.order_id=$1 AND g.app_id=$2`,[id,appId])).rows[0];
  if(!row)return null;
  const members=(await db.query<EscalationMember>(`SELECT mm.identity_id,mm.party,mm.state,m.account_id,m.platform_subject_id,
      m.realm,m.identity_kind,m.status,m.identity_marker
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    WHERE mm.order_id=$1 AND mm.app_id=$2 ORDER BY mm.identity_id`,[id,appId])).rows;
  return {...row,members};
}

function assertSystemOwner(p:EscalationPlan):string{
  const expected=key(p.app_id,"SYSTEM","support-manager");
  if(!p.system_account||p.system_status!=="READY"||p.system_subject!=="support-manager"
    ||p.system_account!==deriveYunxinAccountId(expected)||p.system_marker!==buildYunxinIdentityMarker(expected))
    throw new OrderTeamError("IDENTITY_PENDING");
  return p.system_account;
}

function validateEscalationTeam(p:EscalationPlan,team:YunxinOrderTeamState|null,targetAdminId?:string):void{
  const systemAccount=assertSystemOwner(p);
  let marker:unknown;try{marker=JSON.parse(team?.serverExtension??"null");}catch{throw new OrderTeamError("REMOTE_MISMATCH");}
  const expected=[systemAccount,...p.members.filter(m=>m.state==="JOINED").map(m=>m.account_id)];
  if(targetAdminId){
    const target=p.members.find(m=>m.party==="STAFF"&&m.platform_subject_id===targetAdminId&&m.state==="PLANNED");
    if(!target)throw new OrderTeamError("BINDING_MISMATCH");
    expected.push(target.account_id);
  }
  const m=marker as {schema?:unknown;appId?:unknown;orderId?:unknown}|null;
  if(!team||team.teamId!==p.team_id||team.ownerAccountId!==systemAccount||team.teamType!==1||team.name!==p.team_name
    ||team.membersLimit!==p.members_limit||m?.schema!=="zzsh.im-order.v1"||m.appId!==p.app_id||m.orderId!==p.order_id
    ||Object.entries(ORDER_TEAM_CONFIGURATION).some(([k,v])=>team.configuration[k as keyof typeof ORDER_TEAM_CONFIGURATION]!==v)
    ||team.members.length!==expected.length||new Set(team.members.map(x=>x.accountId)).size!==expected.length
    ||team.members.some(x=>!expected.includes(x.accountId)||x.chatBanned!==false||x.role!==(x.accountId===systemAccount?1:0)))
    throw new OrderTeamError("REMOTE_MISMATCH");
}

async function insertOperationalEvent(c:PoolClient,p:EscalationPlan,input:{type:OperationalEventType;key:string;status:string;
  operationId?:string;metadata?:Record<string,unknown>}):Promise<boolean>{
  const systemAccount=assertSystemOwner(p);
  const id=`im_order_evt_${randomUUID().replaceAll("-","")}`;
  const result=await c.query(`INSERT INTO zzsh_order.im_order_event
    (id,order_id,app_id,team_id,event_key,type,status,actor,sender_account_id,occurred_at,metadata,related_operation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,statement_timestamp(),$9::jsonb,$10)
    ON CONFLICT(order_id,event_key) DO NOTHING RETURNING id`,[
    id,p.order_id,p.app_id,p.team_id,input.key,input.type,input.status,systemAccount,JSON.stringify(input.metadata??{}),input.operationId??null]);
  return result.rowCount===1;
}

async function recordDueReminder(c:PoolClient,p:EscalationPlan):Promise<boolean>{
  if(!p.remind_due_at||p.escalation_state!=="RUNNING"||p.team_state!=="READY"||p.first_response_state!=="RUNNING")return false;
  const due=(await c.query(`SELECT $1::timestamptz<=clock_timestamp() AS due`,[p.remind_due_at])).rows[0]?.due;
  if(!due)return false;
  const inserted=await insertOperationalEvent(c,p,{type:"first_response_reminder",key:`first_response_reminder:${p.team_id}`,
    status:"RECORDED",metadata:{dueAt:new Date(p.remind_due_at).toISOString()}});
  await c.query(`UPDATE zzsh_order.im_order_group SET remind_due_at=NULL,version=version+1
    WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING' AND remind_due_at IS NOT NULL`,[p.order_id,p.app_id]);
  if(inserted)await recordAudit(c,{actorType:"system",action:"im.order.first_response.reminder_due",objectType:"rental_order",
    objectId:p.order_id,outcome:"SUCCESS",requestId:`reminder_${p.order_id}`,details:{appId:p.app_id,teamId:p.team_id}});
  return inserted;
}

async function recordReminder(options:OrderTeamOptions,id:string):Promise<void>{
  await withTransaction(options.pool,async(c)=>{
    const group=(await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE app_id=$1 AND order_id=$2 FOR UPDATE`,[options.appId,id])).rows[0];
    if(!group)return;
    const p=await escalationPlan(c,options.appId,id);if(p)await recordDueReminder(c,p);
  });
}

async function escalationAudit(c:PoolClient,p:EscalationPlan,action:string,requestId:string,details:Record<string,unknown>):Promise<void>{
  await recordAudit(c,{actorType:"system",action,objectType:"rental_order",objectId:p.order_id,outcome:"SUCCESS",requestId,details:{appId:p.app_id,teamId:p.team_id,...details}});
}

async function cancelOrderUnsent(c:PoolClient,p:EscalationPlan,reason:string):Promise<void>{
  const ops=(await c.query<EscalationOperation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND app_id=$2
    AND kind IN ('ADD_MEMBER','BOT_NOTICE') AND state IN ('PENDING','RUNNING') AND sent_at IS NULL ORDER BY id FOR UPDATE`,
    [p.order_id,p.app_id])).rows;
  for(const op of ops)await cancelUnsentOperation(c,op,reason);
}

async function stopForReview(c:PoolClient,p:EscalationPlan,reason:string,opId?:string):Promise<void>{
  const changed=await c.query(`UPDATE zzsh_order.im_order_group SET escalation_state='VERIFY_REQUIRED',remind_due_at=NULL,
    next_add_due_at=NULL,version=version+1 WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[p.order_id,p.app_id]);
  if(changed.rowCount){
    await cancelOrderUnsent(c,p,"ESCALATION_STOPPED");
    await insertOperationalEvent(c,p,{type:"verify_required",key:`escalation_verify:${p.team_id}:${reason}`,status:"VERIFY_REQUIRED",
      ...(opId?{operationId:opId}:{}),metadata:{reason}});
    await escalationAudit(c,p,"im.order.escalation.verify_required",`verify_${p.order_id}`,{reason,operationId:opId??null});
  }
}

async function exhaustSupport(c:PoolClient,p:EscalationPlan):Promise<void>{
  const changed=await c.query(`UPDATE zzsh_order.im_order_group SET escalation_state='EXHAUSTED',remind_due_at=NULL,
    next_add_due_at=NULL,version=version+1 WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[p.order_id,p.app_id]);
  if(changed.rowCount){
    await cancelOrderUnsent(c,p,"ESCALATION_STOPPED");
    await insertOperationalEvent(c,p,{type:"staff_exhausted",key:"staff_exhausted",status:"EXHAUSTED",metadata:{reason:"NO_ELIGIBLE_STAFF"}});
    await escalationAudit(c,p,"im.order.escalation.exhausted",`exhausted_${p.order_id}`,{reason:"NO_ELIGIBLE_STAFF",round:p.add_round});
  }
}

async function planNextAdd(options:OrderTeamOptions,id:string):Promise<void>{
  const discovered=await escalationPlan(options.pool,options.appId,id);
  if(!discovered||!discovered.team_id||!discovered.assigned_admin_id||!discovered.responsible_admin_id)return;
  await withTransaction(options.pool,async(c)=>{
    const roster=await lockSupportMutation(c,options.appId,[discovered.renter_user_id,discovered.owner_user_id],[discovered.responsible_admin_id!,discovered.assigned_admin_id!]);
    await lockTeamBinding(c,options.appId,discovered.team_id!);
    await lockGroup(c,discovered);
    let p=await escalationPlan(c,options.appId,id);if(!p||!p.team_id)return;
    await c.query(`SELECT id FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id FOR UPDATE`,[id]);
    if(p.escalation_state!=="RUNNING"||p.team_state!=="READY")return;
    if(p.first_response_state!=="RUNNING"){
      const state=p.first_response_state==="STOPPED"?"STOPPED":"VERIFY_REQUIRED";
      await c.query(`UPDATE zzsh_order.im_order_group SET escalation_state=$3,remind_due_at=NULL,next_add_due_at=NULL,version=version+1
        WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[id,options.appId,state]);
      return;
    }
    await recordDueReminder(c,p);
    p=await escalationPlan(c,options.appId,id);if(!p||p.escalation_state!=="RUNNING"||!p.next_add_due_at)return;
    if(!(await c.query(`SELECT $1::timestamptz<=clock_timestamp() AS due`,[p.next_add_due_at])).rows[0]?.due)return;
    const unresolved=(await c.query(`SELECT 1 FROM zzsh_order.im_order_operation WHERE order_id=$1 AND kind='ADD_MEMBER'
      AND state IN ('PENDING','RUNNING','NEEDS_REVIEW') LIMIT 1`,[id])).rowCount;
    if(unresolved)return;
    const occupied=1+p.members.filter(m=>m.state==="JOINED").length;
    if(!p.members_limit||occupied>=p.members_limit){await stopForReview(c,p,"TEAM_CAPACITY_FULL");return;}
    const joined=new Set(p.members.filter(m=>m.state==="JOINED").map(m=>m.platform_subject_id));
    const candidates=(await readEligibleSupport(c,options.appId,roster)).filter(candidate=>(candidate.allGames||candidate.gameIds.includes(p!.game_id))&&!joined.has(candidate.adminUserId));
    const target=await reserveSupportCandidate(c,options.appId,"ORDER",candidates);
    if(!target){await exhaustSupport(c,p);return;}
    const identity=(await c.query(`SELECT id FROM zzsh_iam.im_identity_mapping WHERE provider='yunxin' AND app_id=$1 AND realm='admin'
      AND identity_kind='ADMIN' AND platform_subject_id=$2 AND status='READY' FOR SHARE`,[options.appId,target.adminUserId])).rows[0];
    if(!identity)throw new OrderTeamError("IDENTITY_PENDING");
    const round=Number(p.add_round)+1,addId=`im_order_op_${randomUUID().replaceAll("-","")}`,botId=`im_order_op_${randomUUID().replaceAll("-","")}`;
    // A cancelled unsent ADD retains its PLANNED member row; a later round reuses that binding.
    await c.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party) VALUES($1,$2,$3,'STAFF')
      ON CONFLICT(order_id,identity_id) DO NOTHING`,[id,options.appId,identity.id]);
    await c.query(`INSERT INTO zzsh_order.im_order_operation(id,order_id,app_id,kind,round,target_admin_id) VALUES($1,$2,$3,'ADD_MEMBER',$4,$5)`,[addId,id,options.appId,round,target.adminUserId]);
    await c.query(`INSERT INTO zzsh_order.im_order_operation(id,order_id,app_id,kind,round) VALUES($1,$2,$3,'BOT_NOTICE',$4)`,[botId,id,options.appId,round]);
    await c.query(`UPDATE zzsh_order.im_order_group SET add_round=$3,next_add_due_at=NULL,version=version+1
      WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[id,options.appId,round]);
    p=await escalationPlan(c,options.appId,id);if(!p)throw new OrderTeamError("STALE_OPERATION");
    await insertOperationalEvent(c,p,{type:"add_member",key:`add_member:${round}`,status:"PLANNED",operationId:addId,metadata:{round}});
    await insertOperationalEvent(c,p,{type:"bot_notice",key:`bot_notice:${round}`,status:"PLANNED",operationId:botId,metadata:{round}});
    await escalationAudit(c,p,"im.order.escalation.add_planned",addId,{round,targetAdminId:target.adminUserId});
  });
}

async function cancelUnsentOperation(c:PoolClient,op:EscalationOperation,reason:string):Promise<boolean>{
  if(op.sent_at)return false;
  const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state='CANCELLED',version=version+1,lease_until=NULL,
      lease_token_hash=NULL,failure_class=$3,updated_at=clock_timestamp()
    WHERE id=$1 AND app_id=$2 AND kind IN ('ADD_MEMBER','BOT_NOTICE') AND state IN ('PENDING','RUNNING') AND sent_at IS NULL`,
  [op.id,op.app_id,reason]);
  return changed.rowCount===1;
}

type EscalationClaim=EscalationOperation & {token:string;readonlyMode:boolean};
async function lockOrderOperations(c:PoolClient,orderId:string):Promise<void>{
  await c.query(`SELECT id FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id FOR UPDATE`,[orderId]);
}
async function escalationOperation(c:PoolClient,id:string,appId:string):Promise<EscalationOperation|null>{
  return (await c.query<EscalationOperation>(`SELECT * FROM zzsh_order.im_order_operation WHERE id=$1 AND app_id=$2
    AND kind IN ('ADD_MEMBER','BOT_NOTICE') FOR UPDATE`,[id,appId])).rows[0]??null;
}

async function claimEscalation(options:OrderTeamOptions,id:string,expectedVersion?:string):Promise<EscalationClaim|null>{
  return withTransaction(options.pool,async(c)=>{
    const row=(await c.query<EscalationOperation>(`SELECT * FROM zzsh_order.im_order_operation WHERE id=$1 AND app_id=$2
      AND kind IN ('ADD_MEMBER','BOT_NOTICE') FOR UPDATE`,[id,options.appId])).rows[0];
    if(!row)return null;
    const readonlyMode=expectedVersion!==undefined;
    if(readonlyMode&&(row.kind!=="ADD_MEMBER"||row.state!=="NEEDS_REVIEW"||!row.sent_at||row.version!==expectedVersion))return null;
    if(!readonlyMode&&row.state!=="PENDING")return null;
    const token=randomBytes(32).toString("hex");
    const next=(await c.query<EscalationOperation>(`UPDATE zzsh_order.im_order_operation SET state='RUNNING',version=version+1,
      attempt_count=attempt_count+1,failure_class=NULL,lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond'),
      lease_token_hash=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND app_id=$2 AND kind IN ('ADD_MEMBER','BOT_NOTICE') AND version=$5 AND state=$6
        AND ($7::boolean OR next_retry_at<=clock_timestamp()) RETURNING *`,
      [id,options.appId,hash(token),options.leaseMs??30000,row.version,readonlyMode?"NEEDS_REVIEW":"PENDING",readonlyMode])).rows[0];
    if(!next)return null;
    await recordAudit(c,{actorType:"system",action:`im.order.escalation.${row.kind.toLowerCase()}.claimed`,objectType:"im_order_operation",
      objectId:row.id,outcome:"SUCCESS",requestId:`${row.id}_${next.version}`,details:{round:row.round,readOnly:readonlyMode}});
    return {...next,token,readonlyMode};
  });
}

function rosterEligibleForGame(candidates:Awaited<ReturnType<typeof readEligibleSupport>>,gameId:string):typeof candidates{
  return candidates.filter(candidate=>candidate.allGames||candidate.gameIds.includes(gameId));
}

async function cancelRoundBot(c:PoolClient,op:EscalationOperation,reason:string):Promise<boolean>{
  const bot=(await c.query<EscalationOperation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND kind='BOT_NOTICE'
    AND round=$2 FOR UPDATE`,[op.order_id,op.round])).rows[0];
  return bot?cancelUnsentOperation(c,bot,reason):false;
}

async function lockEscalationMutation(c:PoolClient,p:EscalationPlan,teamId:string):Promise<Awaited<ReturnType<typeof lockSupportMutation>>>{
  const roster=await lockSupportMutation(c,p.app_id,[p.renter_user_id,p.owner_user_id],
    [p.assigned_admin_id,p.responsible_admin_id].filter((id):id is string=>Boolean(id)));
  await lockTeamBinding(c,p.app_id,teamId);
  await lockGroup(c,p);
  await lockOrderOperations(c,p.order_id);
  return roster;
}

async function markAddSent(c:PoolClient,options:OrderTeamOptions,op:EscalationClaim,p:EscalationPlan):Promise<"SEND"|"STOP">{
  const roster=await lockEscalationMutation(c,p,p.team_id!);
  const current=await escalationOperation(c,op.id,options.appId);
  if(!current||current.state==="CANCELLED")return "STOP";
  if(current.version!==op.version||current.state!=="RUNNING"||current.lease_token_hash!==hash(op.token)||current.sent_at)return "STOP";
  let fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)return "STOP";
  if(fresh.escalation_state!=="RUNNING"||fresh.first_response_state!=="RUNNING"){
    await cancelUnsentOperation(c,current,fresh.first_response_state==="STOPPED"?"FIRST_RESPONSE":"ESCALATION_STOPPED");
    await cancelRoundBot(c,current,"ADD_NOT_SENT");
    if(fresh.escalation_state==="RUNNING"){
      const state=fresh.first_response_state==="STOPPED"?"STOPPED":"VERIFY_REQUIRED";
      await c.query(`UPDATE zzsh_order.im_order_group SET escalation_state=$3,remind_due_at=NULL,next_add_due_at=NULL,version=version+1
        WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[fresh.order_id,fresh.app_id,state]);
    }
    return "STOP";
  }
  const eligible=rosterEligibleForGame(await readEligibleSupport(c,options.appId,roster),fresh.game_id);
  const occupied=1+fresh.members.filter(m=>m.state==="JOINED").length;
  if(!fresh.members_limit||occupied>=fresh.members_limit){
    await cancelUnsentOperation(c,current,"TEAM_CAPACITY_FULL");await cancelRoundBot(c,current,"ADD_NOT_SENT");
    await stopForReview(c,fresh,"TEAM_CAPACITY_FULL",current.id);
    return "STOP";
  }
  if(!eligible.some(candidate=>candidate.adminUserId===current.target_admin_id)){
    await cancelUnsentOperation(c,current,"CANDIDATE_UNAVAILABLE");
    await cancelRoundBot(c,current,"ADD_NOT_SENT");
    await c.query(`UPDATE zzsh_order.im_order_group SET next_add_due_at=statement_timestamp(),version=version+1
      WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[fresh.order_id,fresh.app_id]);
    await escalationAudit(c,fresh,"im.order.escalation.add_cancelled",current.id,{round:current.round,reason:"CANDIDATE_UNAVAILABLE"});
    return "STOP";
  }
  const sent=await c.query(`UPDATE zzsh_order.im_order_operation SET sent_at=clock_timestamp(),failure_class=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND app_id=$2 AND kind='ADD_MEMBER' AND version=$3 AND state='RUNNING' AND lease_token_hash=$4
      AND lease_until>clock_timestamp() AND sent_at IS NULL`,[op.id,options.appId,op.version,hash(op.token)]);
  if(sent.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
  await escalationAudit(c,fresh,"im.order.escalation.add_sent",op.id,{round:op.round,targetAdminId:op.target_admin_id});
  return "SEND";
}

async function markUnsentAddReview(c:PoolClient,options:OrderTeamOptions,op:EscalationClaim,p:EscalationPlan,reason:string):Promise<void>{
  const roster=await lockEscalationMutation(c,p,p.team_id!);
  const current=await escalationOperation(c,op.id,options.appId);
  if(!current||current.version!==op.version||current.state!=="RUNNING"||current.sent_at||current.lease_token_hash!==hash(op.token))return;
  await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',lease_until=NULL,lease_token_hash=NULL,
      failure_class=$3,next_retry_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND version=$2 AND state='RUNNING'`,
    [op.id,op.version,reason]);
  await cancelRoundBot(c,current,"ADD_NOT_SENT");
  const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)return;
  await stopForReview(c,fresh,reason,op.id);
}

async function returnUnsentAddToPending(c:PoolClient,options:OrderTeamOptions,op:EscalationClaim,p:EscalationPlan):Promise<void>{
  await lockEscalationMutation(c,p,p.team_id!);
  const current=await escalationOperation(c,op.id,options.appId);
  if(!current||current.version!==op.version||current.state!=="RUNNING"||current.sent_at||current.lease_token_hash!==hash(op.token))return;
  const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)return;
  if(fresh.escalation_state!=="RUNNING"||fresh.first_response_state!=="RUNNING"){
    await cancelUnsentOperation(c,current,"ESCALATION_STOPPED");
    await cancelRoundBot(c,current,"ADD_NOT_SENT");
    return;
  }
  await c.query(`UPDATE zzsh_order.im_order_operation SET state='PENDING',lease_until=NULL,lease_token_hash=NULL,
      failure_class='TEAM_READ_UNAVAILABLE',next_retry_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp()
    WHERE id=$1 AND version=$2 AND state='RUNNING' AND sent_at IS NULL`,[op.id,op.version]);
  await escalationAudit(c,fresh,"im.order.escalation.add_deferred",op.id,{round:op.round,reason:"TEAM_READ_UNAVAILABLE"});
}

async function markAddOutcomeUnknown(c:PoolClient,options:OrderTeamOptions,op:EscalationClaim,p:EscalationPlan,reason:string,retryMs=300000):Promise<void>{
  await lockEscalationMutation(c,p,p.team_id!);
  const current=await escalationOperation(c,op.id,options.appId);
  if(!current||current.version!==op.version||current.state!=="RUNNING"||!current.sent_at||current.lease_token_hash!==hash(op.token))return;
  const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',lease_until=NULL,lease_token_hash=NULL,
      failure_class=$3,next_retry_at=clock_timestamp()+($4::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
    WHERE id=$1 AND version=$2 AND kind='ADD_MEMBER' AND state='RUNNING' AND sent_at IS NOT NULL`,[op.id,op.version,reason,retryMs]);
  if(!changed.rowCount)return;
  const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)return;
  await stopForReview(c,fresh,reason,op.id);
  await escalationAudit(c,fresh,"im.order.escalation.add_unknown",op.id,{round:op.round,reason});
}

function targetMember(p:EscalationPlan,op:EscalationOperation):EscalationMember{
  if(!op.target_admin_id)throw new OrderTeamError("BINDING_MISMATCH");
  const member=p.members.find(m=>m.party==="STAFF"&&m.platform_subject_id===op.target_admin_id);
  const identityKey=key(p.app_id,"ADMIN",op.target_admin_id);
  if(!member||!(["PLANNED","JOINED"].includes(member.state))||member.status!=="READY"||member.realm!=="admin"||member.identity_kind!=="ADMIN"
    ||member.account_id!==deriveYunxinAccountId(identityKey)||member.identity_marker!==buildYunxinIdentityMarker(identityKey))throw new OrderTeamError("IDENTITY_PENDING");
  return member;
}

async function finishAdd(options:OrderTeamOptions,op:EscalationClaim,team:YunxinOrderTeamState):Promise<void>{
  const before=await escalationPlan(options.pool,options.appId,op.order_id);
  if(!before?.team_id||!op.target_admin_id)throw new OrderTeamError("STALE_OPERATION");
  await withTransaction(options.pool,async(c)=>{
    const roster=await lockSupportMutation(c,options.appId,[before.renter_user_id,before.owner_user_id],
      [before.assigned_admin_id,before.responsible_admin_id,op.target_admin_id].filter((id):id is string=>Boolean(id)));
    await lockTeamBinding(c,options.appId,before.team_id!);
    await lockGroup(c,before);
    await lockOrderOperations(c,op.order_id);
    const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)throw new OrderTeamError("STALE_OPERATION");
    const current=await escalationOperation(c,op.id,options.appId);
    if(!current||current.version!==op.version||current.state!=="RUNNING"||current.lease_token_hash!==hash(op.token)
      ||!current.sent_at||!current.lease_until)throw new OrderTeamError("STALE_OPERATION");
    validateEscalationTeam(fresh,team,op.target_admin_id??undefined);
    const member=targetMember(fresh,current);
    if(member.state==="PLANNED"){
      const joined=await c.query(`UPDATE zzsh_order.im_order_member SET state='JOINED',joined_at=clock_timestamp()
        WHERE order_id=$1 AND app_id=$2 AND identity_id=$3 AND party='STAFF' AND state='PLANNED'`,[op.order_id,options.appId,member.identity_id]);
      if(joined.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
    }
    const eligible=rosterEligibleForGame(await readEligibleSupport(c,options.appId,roster),fresh.game_id)
      .some(candidate=>candidate.adminUserId===op.target_admin_id);
    const succeeded=await c.query(`UPDATE zzsh_order.im_order_operation SET state='SUCCEEDED',candidate_team_id=$3,lease_until=NULL,
        lease_token_hash=NULL,failure_class=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND app_id=$2 AND kind='ADD_MEMBER' AND version=$4 AND state='RUNNING' AND sent_at IS NOT NULL
        AND lease_token_hash=$5 AND lease_until>clock_timestamp()`,[op.id,options.appId,fresh.team_id,op.version,hash(op.token)]);
    if(succeeded.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
    if(fresh.escalation_state==="RUNNING"){
      if(fresh.first_response_state==="STOPPED"){
        await c.query(`UPDATE zzsh_order.im_order_group SET escalation_state='STOPPED',remind_due_at=NULL,next_add_due_at=NULL,version=version+1
          WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[op.order_id,options.appId]);
      }else if(fresh.first_response_state!=="RUNNING"||!eligible){
        await stopForReview(c,fresh,fresh.first_response_state!=="RUNNING"?"FIRST_RESPONSE_REVIEW":"RESPONSIBLE_NO_LONGER_ELIGIBLE",op.id);
      }else{
        await c.query(`UPDATE zzsh_order.im_order_group SET responsible_admin_id=$3,remind_due_at=NULL,
            next_add_due_at=statement_timestamp()+interval '4 minutes',version=version+1
          WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING' AND first_response_state='RUNNING'`,
          [op.order_id,options.appId,op.target_admin_id]);
      }
    }
    await escalationAudit(c,fresh,"im.order.escalation.add_joined",op.id,{round:op.round,targetAdminId:op.target_admin_id,
      responsibleChanged:fresh.escalation_state==="RUNNING"&&fresh.first_response_state==="RUNNING"&&eligible});
  });
}

function escalationLease(options:OrderTeamOptions,op:EscalationClaim):ReturnType<typeof createImScopeLease>{
  return createImScopeLease(options.pool,options.appId,async(db)=>(await db.query(`UPDATE zzsh_order.im_order_operation
    SET lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
    WHERE id=$1 AND app_id=$2 AND kind IN ('ADD_MEMBER','BOT_NOTICE') AND version=$5 AND state='RUNNING'
      AND lease_token_hash=$3 AND lease_until>clock_timestamp() RETURNING id`,
    [op.id,options.appId,hash(op.token),options.leaseMs??30000,op.version])).rowCount===1,()=>new OrderTeamError("STALE_OPERATION"));
}

async function executeAdd(options:OrderTeamOptions,op:EscalationClaim):Promise<void>{
  const lease=escalationLease(options,op);
  let p:EscalationPlan|null=null,sent=Boolean(op.sent_at),observed:YunxinOrderTeamState|null=null;
  try{
    p=await escalationPlan(options.pool,options.appId,op.order_id);
    if(!p?.team_id)throw new OrderTeamError("STALE_OPERATION");
    const member=targetMember(p,op),teamId=p.team_id;
    if(op.readonlyMode){
      observed=await lease.mutate(`team:${teamId}`,()=>options.provider.readOrderTeam(teamId));
      if(!observed)throw new OrderTeamError("REMOTE_MISMATCH");
      validateEscalationTeam(p,observed,op.target_admin_id!);
      await lease.stop();
      await finishAdd(options,op,observed);
      return;
    }
    observed=await lease.mutate(`team:${teamId}`,async(c)=>{
      const fresh=await escalationPlan(c,options.appId,op.order_id);
      if(!fresh?.team_id)throw new OrderTeamError("STALE_OPERATION");
      const currentMember=targetMember(fresh,op);
      const existing=await options.provider.readOrderTeam(teamId);
      validateEscalationTeam(fresh,existing);
      const decision=await onLeaseConnection(c,db=>markAddSent(db,options,op,fresh));
      if(decision!=="SEND")return null;
      sent=true;
      let providerError:unknown;
      try{await options.provider.addSupportTeamMember(teamId,assertSystemOwner(fresh),currentMember.account_id);}
      catch(error){providerError=error;}
      const confirmed=await options.provider.readOrderTeam(teamId);
      observed=confirmed;
      validateEscalationTeam(fresh,confirmed,op.target_admin_id!);
      if(providerError)throw providerError;
      return confirmed;
    });
    if(!sent)return;
    if(!observed)throw new OrderTeamError("REMOTE_MISMATCH");
    validateEscalationTeam(p,observed,op.target_admin_id!);
    await lease.stop();
    await finishAdd(options,op,observed);
  }catch(error){
    await lease.stop();
    if(!sent){
      if(p&&["REMOTE_MISMATCH","IDENTITY_PENDING","BINDING_MISMATCH","TEAM_ALREADY_BOUND"].includes(error instanceof OrderTeamError?error.code:"")){
        await withTransaction(options.pool,c=>markUnsentAddReview(c,options,op,p!,error instanceof OrderTeamError?error.code:"REMOTE_MISMATCH"));
      }else if(p){
        await withTransaction(options.pool,c=>returnUnsentAddToPending(c,options,op,p!));
      }
      return;
    }
    if(observed&&p){
      try{validateEscalationTeam(p,observed,op.target_admin_id!);await finishAdd(options,op,observed);return;}catch{/* The readback is retained for the read-only recovery pass. */}
    }
    if(p)await withTransaction(options.pool,c=>markAddOutcomeUnknown(c,options,op,p!,"ADD_OUTCOME_UNKNOWN"));
  }
}

async function markBotSent(c:PoolClient,options:OrderTeamOptions,op:EscalationClaim,p:EscalationPlan):Promise<boolean>{
  await lockDispatchGate(c,options.appId);await lockTeamBinding(c,options.appId,p.team_id!);await lockGroup(c,p);await lockOrderOperations(c,p.order_id);
  const current=await escalationOperation(c,op.id,options.appId);
  if(!current||current.version!==op.version||current.state!=="RUNNING"||current.sent_at||current.lease_token_hash!==hash(op.token))return false;
  const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh)return false;
  if(fresh.escalation_state!=="RUNNING"||fresh.first_response_state!=="RUNNING"){
    await cancelUnsentOperation(c,current,"ESCALATION_STOPPED");return false;
  }
  assertSystemOwner(fresh);
  const sent=await c.query(`UPDATE zzsh_order.im_order_operation SET sent_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=$1 AND app_id=$2 AND kind='BOT_NOTICE' AND version=$3 AND state='RUNNING' AND lease_token_hash=$4
      AND lease_until>clock_timestamp() AND sent_at IS NULL`,[op.id,options.appId,op.version,hash(op.token)]);
  if(sent.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
  await escalationAudit(c,fresh,"im.order.escalation.bot_notice_sent",op.id,{round:op.round});
  return true;
}

async function settleBot(options:OrderTeamOptions,op:EscalationClaim,state:"PENDING"|"SUCCEEDED"|"NEEDS_REVIEW",reason:string|null):Promise<void>{
  const p=await escalationPlan(options.pool,options.appId,op.order_id);if(!p?.team_id)return;
  await withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);await lockTeamBinding(c,options.appId,p.team_id!);await lockGroup(c,p);await lockOrderOperations(c,p.order_id);
    const current=await escalationOperation(c,op.id,options.appId);
    if(!current||current.version!==op.version||current.state!=="RUNNING"||current.lease_token_hash!==hash(op.token))return;
    if(state==="PENDING"&&current.sent_at)return;
    const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state=$3,lease_until=NULL,lease_token_hash=NULL,
        failure_class=$4,next_retry_at=CASE WHEN $3 IN ('PENDING','NEEDS_REVIEW') THEN clock_timestamp()+interval '5 minutes' ELSE next_retry_at END,
        updated_at=clock_timestamp()
      WHERE id=$1 AND app_id=$2 AND kind='BOT_NOTICE' AND version=$5 AND state='RUNNING' AND lease_token_hash=$6
        AND (($3='PENDING' AND sent_at IS NULL) OR ($3='SUCCEEDED' AND sent_at IS NOT NULL) OR ($3='NEEDS_REVIEW' AND sent_at IS NOT NULL))`,
      [op.id,options.appId,state,reason,op.version,hash(op.token)]);
    if(changed.rowCount){
      const fresh=await escalationPlan(c,options.appId,op.order_id);
      if(fresh)await escalationAudit(c,fresh,state==="SUCCEEDED"?"im.order.escalation.bot_notice_sent":"im.order.escalation.bot_notice_review",op.id,
        {round:op.round,reason});
    }
  });
}

async function executeBot(options:OrderTeamOptions,op:EscalationClaim):Promise<void>{
  const lease=escalationLease(options,op);let sent=Boolean(op.sent_at),p:EscalationPlan|null=null;
  try{
    p=await escalationPlan(options.pool,options.appId,op.order_id);if(!p?.team_id)throw new OrderTeamError("STALE_OPERATION");
    const system=assertSystemOwner(p);
    const send=await lease.mutate(`team:${p.team_id}`,async(c)=>{
      const fresh=await escalationPlan(c,options.appId,op.order_id);if(!fresh?.team_id)throw new OrderTeamError("STALE_OPERATION");
      const freshSystem=assertSystemOwner(fresh);
      if(freshSystem!==system)throw new OrderTeamError("STALE_OPERATION");
      const shouldSend=await onLeaseConnection(c,db=>markBotSent(db,options,op,fresh));
      if(!shouldSend)return false;
      sent=true;
      const routeScope=orderImSdkRouteFor(options.orderImSdkRouteConfig,{
        appId:fresh.app_id,orderId:fresh.order_id,teamId:fresh.team_id,conversationId:`${freshSystem}|2|${fresh.team_id}`,
      });
      const routeConfig:YunxinMessageRouteConfig|undefined=routeScope
        ?{routeEnabled:true,routeEnvironment:routeScope.routeEnvironment}:undefined;
      await options.provider.sendOrderTeamNotice(fresh.team_id,freshSystem,routeConfig);
      return true;
    });
    await lease.stop();
    if(send)await settleBot(options,op,"SUCCEEDED",null);
  }catch{
    await lease.stop();
    if(sent)await settleBot(options,op,"NEEDS_REVIEW","BOT_NOTICE_UNKNOWN");
    else if(p)await settleBot(options,op,"PENDING","BOT_NOTICE_RETRYABLE");
  }
}

async function expireEscalation(options:OrderTeamOptions,id:string):Promise<void>{
  const initial=(await options.pool.query<EscalationOperation>(`SELECT * FROM zzsh_order.im_order_operation WHERE id=$1 AND app_id=$2
    AND kind IN ('ADD_MEMBER','BOT_NOTICE')`,[id,options.appId])).rows[0];
  if(!initial)return;
  const before=await escalationPlan(options.pool,options.appId,initial.order_id);if(!before?.team_id)return;
  await withTransaction(options.pool,async(c)=>{
    await lockEscalationMutation(c,before,before.team_id!);
    const current=await escalationOperation(c,id,options.appId);
    if(!current||current.state!=="RUNNING"||!current.lease_until)return;
    const expired=(await c.query(`SELECT $1::timestamptz<=clock_timestamp() AS due`,[current.lease_until])).rows[0]?.due;
    if(!expired)return;
    if(current.kind==="ADD_MEMBER"&&!current.sent_at){
      await cancelUnsentOperation(c,current,"LEASE_EXPIRED");await cancelRoundBot(c,current,"ADD_NOT_SENT");
      const fresh=await escalationPlan(c,options.appId,current.order_id);
      if(fresh?.escalation_state==="RUNNING"&&fresh.first_response_state==="RUNNING"){
        await c.query(`UPDATE zzsh_order.im_order_group SET next_add_due_at=statement_timestamp(),version=version+1
          WHERE order_id=$1 AND app_id=$2 AND escalation_state='RUNNING'`,[current.order_id,options.appId]);
        await escalationAudit(c,fresh,"im.order.escalation.add_expired_unsent",current.id,{round:current.round});
      }
      return;
    }
    if(current.kind==="ADD_MEMBER"){
      await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',version=version+1,lease_until=NULL,
          lease_token_hash=NULL,failure_class='STALE_OPERATION',next_retry_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
        WHERE id=$1 AND state='RUNNING' AND sent_at IS NOT NULL`,[current.id]);
      const fresh=await escalationPlan(c,options.appId,current.order_id);if(!fresh)return;
      await stopForReview(c,fresh,"STALE_OPERATION",current.id);
      await escalationAudit(c,fresh,"im.order.escalation.add_expired_sent",current.id,{round:current.round});
      return;
    }
    if(!current.sent_at){await cancelUnsentOperation(c,current,"LEASE_EXPIRED");return;}
    await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',version=version+1,lease_until=NULL,
        lease_token_hash=NULL,failure_class='BOT_NOTICE_UNKNOWN',next_retry_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
      WHERE id=$1 AND state='RUNNING' AND sent_at IS NOT NULL`,[current.id]);
    const fresh=await escalationPlan(c,options.appId,current.order_id);
    if(fresh)await escalationAudit(c,fresh,"im.order.escalation.bot_notice_review",current.id,{round:current.round,reason:"LEASE_EXPIRED"});
  });
}

type EscalationPhase="expired"|"reminder"|"due"|"pending"|"recoverable";
type EscalationCursor={orderId:string;id:string};
type EscalationPosition=Partial<Record<EscalationPhase,EscalationCursor>>&{nextPhase:number};
const escalationPositions=new WeakMap<Pool,Map<string,EscalationPosition>>();
const escalationLogger=new Logger("OrderTeamEscalationScan");

export async function scanOrderEscalations(options:OrderTeamOptions,limit=10):Promise<void>{
  if(options.escalationEnabled!==true||options.firstResponseEnabled!==true||!Number.isInteger(limit)||limit<1||limit>100)
    throw new OrderTeamError("INVALID_CONFIGURATION");
  let apps=escalationPositions.get(options.pool);if(!apps){apps=new Map();escalationPositions.set(options.pool,apps);}
  let position=apps.get(options.appId);if(!position){position={nextPhase:0};apps.set(options.appId,position);}
  const phases:EscalationPhase[]=["expired","reminder","due","pending","recoverable"];
  const extra=limit%phases.length,start=position.nextPhase;
  const caps=phases.map((_,i)=>Math.floor(limit/phases.length)+((i-start+phases.length)%phases.length<extra?1:0));
  position.nextPhase=(start+extra)%phases.length;
  const attempt=async(phase:EscalationPhase,row:{order_id:string;id:string},action:()=>Promise<void>)=>{
    position![phase]={orderId:row.order_id,id:row.id};
    try{await action();}catch(error){
      const code=(error as {code?:unknown}|null)?.code;
      const failure=code==="55P03"?"LOCK_BUSY":code==="40001"?"CONCURRENT_CHANGE":code==="40P01"?"DEADLOCK"
        :["23503","23505","23514"].includes(String(code))?"OBJECT_CONSTRAINT"
        :error instanceof OrderTeamError&&error.code!=="INVALID_CONFIGURATION"?"ORDER_STATE_CONFLICT":null;
      if(!failure)throw error;
      escalationLogger.warn(JSON.stringify({event:"im.order.escalation.item_deferred",appId:options.appId,phase,orderId:row.order_id,operationId:row.id,failureClass:failure}));
    }
  };
  const cursor=(phase:EscalationPhase)=>position![phase]??{orderId:"",id:""};
  const takeOps=async(phase:EscalationPhase,where:string,action:(row:EscalationOperation)=>Promise<void>)=>{
    const cap=caps[phases.indexOf(phase)]!;if(!cap)return;
    const cur=cursor(phase);
    const rows=(await options.pool.query<EscalationOperation>(`SELECT op.* FROM zzsh_order.im_order_operation op
      WHERE op.app_id=$1 AND ${where} ORDER BY ((op.order_id,op.id)>($3::text,$4::text)) DESC,op.order_id,op.id LIMIT $2`,
      [options.appId,cap,cur.orderId,cur.id])).rows;
    for(const row of rows)await attempt(phase,row,()=>action(row));
  };
  await takeOps("expired","op.kind IN ('ADD_MEMBER','BOT_NOTICE') AND op.state='RUNNING' AND op.lease_until<=clock_timestamp()",
    row=>expireEscalation(options,row.id));
  const reminderCap=caps[phases.indexOf("reminder")]!;
  if(reminderCap){
    const cur=cursor("reminder");
    const rows=(await options.pool.query<{order_id:string}>(`SELECT g.order_id FROM zzsh_order.im_order_group g
      WHERE g.app_id=$1 AND g.team_state='READY' AND g.escalation_state='RUNNING' AND g.first_response_state='RUNNING'
        AND g.remind_due_at<=clock_timestamp() ORDER BY (g.order_id>$3) DESC,g.order_id LIMIT $2`,
      [options.appId,reminderCap,cur.orderId])).rows;
    for(const row of rows)await attempt("reminder",{order_id:row.order_id,id:row.order_id},()=>recordReminder(options,row.order_id));
  }
  const dueCap=caps[phases.indexOf("due")]!;
  if(dueCap){
    const cur=cursor("due");
    const rows=(await options.pool.query<{order_id:string}>(`SELECT g.order_id FROM zzsh_order.im_order_group g
      WHERE g.app_id=$1 AND g.team_state='READY' AND g.escalation_state='RUNNING' AND g.first_response_state='RUNNING'
        AND g.next_add_due_at<=clock_timestamp() ORDER BY (g.order_id>$3) DESC,g.order_id LIMIT $2`,
      [options.appId,dueCap,cur.orderId])).rows;
    for(const row of rows)await attempt("due",{order_id:row.order_id,id:row.order_id},()=>planNextAdd(options,row.order_id));
  }
  await takeOps("pending","op.kind IN ('ADD_MEMBER','BOT_NOTICE') AND op.state='PENDING' AND op.next_retry_at<=clock_timestamp()",
    async row=>{const claim=await claimEscalation(options,row.id);if(claim){if(claim.kind==="ADD_MEMBER")await executeAdd(options,claim);else await executeBot(options,claim);}});
  await takeOps("recoverable",`op.kind='ADD_MEMBER' AND op.state='NEEDS_REVIEW' AND op.sent_at IS NOT NULL
      AND op.failure_class IN ('ADD_OUTCOME_UNKNOWN','STALE_OPERATION') AND op.next_retry_at<=clock_timestamp()`,
    async row=>{const claim=await claimEscalation(options,row.id,row.version);if(claim)await executeAdd(options,claim);});
}

@Injectable()
export class OrderTeamLifecycle implements BeforeApplicationShutdown {
  private readonly logger=new Logger(OrderTeamLifecycle.name);
  private options?:OrderTeamOptions;private timer?:NodeJS.Timeout;private flight?:Promise<void>;private limit=10;
  start(options:OrderTeamOptions,intervalMs:number,limit:number):void{
    if(this.options||!Number.isSafeInteger(intervalMs)||intervalMs<1||!Number.isInteger(limit)||limit<1||limit>100||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.appId)
      ||!Number.isInteger(options.membersLimit)||options.membersLimit<4||options.membersLimit>5000
      ||!options.provider?.createOrderTeam||!options.provider.readOrderTeam||!options.identities?.ensure
      ||(options.escalationEnabled===true&&(options.firstResponseEnabled!==true||!options.provider.addSupportTeamMember||!options.provider.sendOrderTeamNotice))
      ||(options.leaseMs!==undefined&&(!Number.isInteger(options.leaseMs)||options.leaseMs<1000||options.leaseMs>300000)))throw new OrderTeamError("INVALID_CONFIGURATION");
    this.options=options;this.limit=limit;this.timer=setInterval(()=>this.wake(),intervalMs);this.timer.unref?.();this.wake();
  }
  wake():void{
    if(!this.options||this.flight)return;
    const options=this.options;
    const work=(async()=>{await scanOrderTeams(options,this.limit);if(options.escalationEnabled)await scanOrderEscalations(options,this.limit);})()
      .catch(()=>{this.logger.error(JSON.stringify({event:"im.order.team.scan_failed"}));});
    const clear=()=>{if(this.flight===settled)this.flight=undefined;};const settled=work.then(clear,clear);this.flight=settled;
  }
  async beforeApplicationShutdown():Promise<void>{this.options=undefined;if(this.timer)clearInterval(this.timer);await this.flight;}
}
