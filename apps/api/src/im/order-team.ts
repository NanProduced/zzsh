import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import { hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { lockDispatchGate, lockSupportMutation } from "./support-dispatch";
import { createImScopeLease, lockTeamBinding, onLeaseConnection } from "./scope-lease";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey, type ImIdentityProvisioner } from "./identity-lifecycle";
import { ORDER_TEAM_CONFIGURATION, YunxinApiError, validateOrderTeamInput, type YunxinOrderTeamApi, type YunxinOrderTeamInput, type YunxinOrderTeamState } from "./yunxin-provider";

export type OrderTeamOptions = { pool: Pool; appId: string; provider: YunxinOrderTeamApi;
  identities: Pick<ImIdentityProvisioner,"ensure">; membersLimit: number; leaseMs?: number;
  /** Activates first-response tracking for newly READY groups; historical groups stay NOT_STARTED. */
  firstResponseEnabled?: boolean };
type Db = Pool | PoolClient;
type Member = { identity_id:string; party:"BUYER"|"OWNER"|"STAFF"; state:string; account_id:string; platform_subject_id:string; realm:string; identity_kind:"USER"|"ADMIN"; status:string; identity_marker:string };
type Plan = { order_id:string; app_id:string; assigned_admin_id:string; provision_state:string; team_state:string; team_name:string|null;
  members_limit:number|null; team_id:string|null; system_identity_id:string|null; version:string;
  renter_user_id:string; owner_user_id:string; account_id:string; game_id:string; display_no:string; game_name:string; order_status:string;
  system_account:string|null; system_status:string|null; system_marker:string|null; system_subject:string|null; members:Member[] };
type Operation = { id:string;order_id:string;app_id:string;state:string;version:string;candidate_team_id:string|null;sent_at:Date|null;failure_class:string|null };
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
async function lockGroup(client:PoolClient,p:Plan):Promise<void>{
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
  const existing=(await options.pool.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1`,[id])).rows[0];
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
    const old=(await c.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1`,[id])).rows[0];if(old)return old.id;
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
    const op=(await c.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 AND app_id=$2 FOR UPDATE`,[id,options.appId])).rows[0];
    if(!op){if(expected)throw new OrderTeamError("BINDING_MISMATCH");return null;}
    if(expected&&(op.id!==expected.operationId||op.candidate_team_id!==expected.teamId))throw new OrderTeamError("BINDING_MISMATCH");
    if(op.state==="SUCCEEDED")return null;
    if(expected&&(op.version!==expected.version||op.state!=="NEEDS_REVIEW"||!op.candidate_team_id))throw new OrderTeamError("STALE_OPERATION");
    if(!expected&&op.state!=="PENDING")return null;
    const token=randomBytes(32).toString("hex");
    const next=(await c.query<Operation>(`UPDATE zzsh_order.im_order_operation SET state='RUNNING',version=version+1,attempt_count=attempt_count+1,
      failure_class=NULL,lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond'),lease_token_hash=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND version=$2 AND ($5::boolean OR next_retry_at<=clock_timestamp()) RETURNING *`,[op.id,op.version,hash(token),options.leaseMs??30000,Boolean(expected)])).rows[0];
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
    WHERE id=$1 AND sent_at IS NOT NULL AND candidate_team_id IS NULL AND state<>'SUCCEEDED'`,[op.id,teamId]);
  const stored=(await c.query(`SELECT candidate_team_id FROM zzsh_order.im_order_operation WHERE id=$1`,[op.id])).rows[0];
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
      WHERE id=$1 AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 AND lease_until>clock_timestamp() AND candidate_team_id=$4`,[op.id,op.version,hash(op.token),team.teamId]);
    if(changed.rowCount!==1)throw new OrderTeamError("STALE_OPERATION");
    await c.query(`UPDATE zzsh_order.im_order_member SET state='JOINED',joined_at=clock_timestamp() WHERE order_id=$1 AND state='PLANNED'`,[op.order_id]);
    // The activation column is referenced only when first-response tracking is enabled,
    // so the same code path stays valid on a schema that predates 0043.
    const firstResponseActivation=options.firstResponseEnabled?",first_response_state='RUNNING'":"";
    await c.query(`UPDATE zzsh_order.im_order_group SET team_state='READY',team_id=$2,team_ready_at=clock_timestamp(),team_failure=NULL${firstResponseActivation},version=version+1 WHERE order_id=$1`,[op.order_id,team.teamId]);
    await recordAudit(c,{actorType:"system",action:"im.order.team.ready",objectType:"rental_order",objectId:op.order_id,outcome:"SUCCESS",requestId:op.id,details:{operationId:op.id,teamId:team.teamId,readOnlyReconciliation:op.readonlyMode}});
  });
}
async function fail(options:OrderTeamOptions,op:Claim,code:string):Promise<void>{
  await withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);
    await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[op.order_id]);
    const row=(await c.query(`UPDATE zzsh_order.im_order_operation SET state=CASE WHEN sent_at IS NULL AND $4='IDENTITY_PENDING' THEN 'PENDING' ELSE 'NEEDS_REVIEW' END,
      lease_until=NULL,lease_token_hash=NULL,failure_class=$4,next_retry_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 RETURNING state`,[op.id,op.version,hash(op.token),code])).rows[0];
    if(row)await c.query(`UPDATE zzsh_order.im_order_group SET team_state=$2,team_failure=$3,version=version+1 WHERE order_id=$1 AND team_state<>'READY'`,[op.order_id,row.state==="PENDING"?"IDENTITY_PENDING":"NEEDS_REVIEW",code]);
  });
}
async function execute(options:OrderTeamOptions,op:Claim):Promise<void>{
  const lease=createImScopeLease(options.pool,options.appId,async(db)=>(await db.query(`UPDATE zzsh_order.im_order_operation SET lease_until=clock_timestamp()+($4::bigint*interval '1 millisecond')
    WHERE id=$1 AND version=$2 AND state='RUNNING' AND lease_token_hash=$3 AND lease_until>clock_timestamp() RETURNING id`,[op.id,op.version,hash(op.token),options.leaseMs??30000])).rowCount===1,()=>new OrderTeamError("STALE_OPERATION"));
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
          const sent=await db.query(`UPDATE zzsh_order.im_order_operation SET sent_at=clock_timestamp() WHERE id=$1 AND version=$2 AND lease_token_hash=$3 AND state='RUNNING' AND lease_until>clock_timestamp() AND sent_at IS NULL`,[op.id,op.version,hash(op.token)]);
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
  const expired=(await options.pool.query<{order_id:string;id:string}>(`SELECT order_id,id FROM zzsh_order.im_order_operation WHERE app_id=$1 AND state='RUNNING' AND lease_until<=clock_timestamp()
    ORDER BY (order_id>$3) DESC,order_id LIMIT $2`,[options.appId,limit,position.expired??""])).rows;
  for(const row of expired)await attempt("expired",row,()=>withTransaction(options.pool,async(c)=>{
    await lockDispatchGate(c,options.appId);await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[row.order_id]);
    const changed=await c.query(`UPDATE zzsh_order.im_order_operation SET state='NEEDS_REVIEW',version=version+1,lease_until=NULL,lease_token_hash=NULL,failure_class='STALE_OPERATION',updated_at=clock_timestamp()
      WHERE order_id=$1 AND state='RUNNING' AND lease_until<=clock_timestamp()`,[row.order_id]);
    if(changed.rowCount)await c.query(`UPDATE zzsh_order.im_order_group SET team_state='NEEDS_REVIEW',team_failure='STALE_OPERATION',version=version+1 WHERE order_id=$1 AND team_state<>'READY'`,[row.order_id]);
  }));
  const due=(await options.pool.query<{order_id:string;id:string|null}>(`SELECT g.order_id,op.id FROM zzsh_order.im_order_group g LEFT JOIN zzsh_order.im_order_operation op ON op.order_id=g.order_id
    WHERE g.app_id=$1 AND g.provision_state='ASSIGNED' AND ((op.id IS NULL AND g.team_state IN ('PENDING','IDENTITY_PENDING') AND g.team_retry_at<=clock_timestamp())
      OR(op.state='PENDING' AND op.next_retry_at<=clock_timestamp())) ORDER BY (g.order_id>$3) DESC,g.order_id LIMIT $2`,[options.appId,limit,position.due??""])).rows;
  for(const row of due)await attempt("due",row,()=>advanceOrderTeam(options,row.order_id));
  // Restart recovery is read-only, bound to an already persisted candidate.
  // Unknown CREATE without an ID and semantic mismatches remain quarantined.
  const recoverable=(await options.pool.query<Operation>(`SELECT * FROM zzsh_order.im_order_operation WHERE app_id=$1 AND state='NEEDS_REVIEW'
    AND candidate_team_id IS NOT NULL AND failure_class IN ('DB_WRITEBACK_UNKNOWN','STALE_OPERATION') AND next_retry_at<=clock_timestamp()
    ORDER BY (order_id>$3) DESC,order_id LIMIT $2`,[options.appId,limit,position.recoverable??""])).rows;
  for(const op of recoverable)await attempt("recoverable",op,()=>reconcileOrderTeam(options,op.order_id,{operationId:op.id,version:op.version,teamId:op.candidate_team_id!}));
}

@Injectable()
export class OrderTeamLifecycle implements BeforeApplicationShutdown {
  private readonly logger=new Logger(OrderTeamLifecycle.name);
  private options?:OrderTeamOptions;private timer?:NodeJS.Timeout;private flight?:Promise<void>;private limit=10;
  start(options:OrderTeamOptions,intervalMs:number,limit:number):void{
    if(this.options||!Number.isSafeInteger(intervalMs)||intervalMs<1||!Number.isInteger(limit)||limit<1||limit>100||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.appId)
      ||!Number.isInteger(options.membersLimit)||options.membersLimit<4||options.membersLimit>5000
      ||!options.provider?.createOrderTeam||!options.provider.readOrderTeam||!options.identities?.ensure
      ||(options.leaseMs!==undefined&&(!Number.isInteger(options.leaseMs)||options.leaseMs<1000||options.leaseMs>300000)))throw new OrderTeamError("INVALID_CONFIGURATION");
    this.options=options;this.limit=limit;this.timer=setInterval(()=>this.wake(),intervalMs);this.timer.unref?.();this.wake();
  }
  wake():void{
    if(!this.options||this.flight)return;
    const work=scanOrderTeams(this.options,this.limit).catch(()=>{this.logger.error(JSON.stringify({event:"im.order.team.scan_failed"}));});
    const clear=()=>{if(this.flight===settled)this.flight=undefined;};const settled=work.then(clear,clear);this.flight=settled;
  }
  async beforeApplicationShutdown():Promise<void>{this.options=undefined;if(this.timer)clearInterval(this.timer);await this.flight;}
}
