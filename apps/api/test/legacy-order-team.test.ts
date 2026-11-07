import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PoolClient } from "pg";
import * as auth from "../src/auth/auth-security";
import * as userAuth from "../src/auth/user-identity";
import * as authorization from "../src/auth/admin-authorization";
import * as scope from "../src/auth/admin-scope";
import * as audit from "../src/auth/security-core";
import * as dispatch from "../src/im/support-dispatch";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { assertLegacyOrderTeamRequest, readLegacyOrderTeamAccess, requestLegacyOrderTeam } from "../src/im/legacy-order-team";

const app="fixture",id="legacy_order_"+"a".repeat(40),actor={userId:"staff",sessionId:"session"};
const parties={game_id:"game",renter_user_id:"renter",owner_user_id:"owner"};
function setup(t:TestContext,permissions=["order.read","im.support.read","im.support.accept"],gameIds=["game"]){
  t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});
  t.mock.method(userAuth,"assertUserContextInTransaction",async()=>{});
  t.mock.method(authorization,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(permissions)}));
  t.mock.method(scope,"readAdminGameScope",async()=>({mode:"SELECTED_GAMES",gameIds}));
}
function member(party:"BUYER"|"OWNER"|"STAFF",realm:"user"|"admin",subject:string){
  const kind: "USER"|"ADMIN"=realm==="user"?"USER":"ADMIN",key={provider:"yunxin" as const,appId:app,realm,kind,platformSubjectId:subject};
  return {party,state:"JOINED",realm,identity_kind:kind,platform_subject_id:subject,account_id:deriveYunxinAccountId(key),identity_marker:buildYunxinIdentityMarker(key),status:"READY",name:subject,avatar:null};
}

test("manual intent is bound to the current staff and repeated requests cannot create a second group",async t=>{
  setup(t);t.mock.method(dispatch,"lockSupportMutation",async()=>({} as never));
  const audits:unknown[]=[];t.mock.method(audit,"recordAudit",async(_c:unknown,event:unknown)=>{audits.push(event);});
  let group:{legacy_order_id:string;app_id:string;assigned_admin_id:string|null;team_state:string}|null=null;
  const client={async query(sql:string,values:unknown[]){
    if(sql.includes("SELECT game_id,renter_user_id"))return {rows:[parties]};
    if(sql.includes("INSERT INTO zzsh_order.im_order_group")){if(group)return {rows:[],rowCount:0};group={legacy_order_id:id,app_id:app,assigned_admin_id:null,team_state:"PENDING"};return {rows:[{order_id:id}],rowCount:1};}
    if(sql.includes("UPDATE zzsh_order.im_order_group")){group!.assigned_admin_id=String(values[1]);return {rows:[],rowCount:1};}
    if(sql.includes("SELECT legacy_order_id,app_id"))return {rows:group?[group]:[]};
    throw Error("unexpected query");
  }} as unknown as PoolClient;
  assert.deepEqual(await requestLegacyOrderTeam(client,actor,app,id,"request"),{created:true,teamState:"PENDING",assignedToCurrentOperator:true});
  assert.deepEqual(await requestLegacyOrderTeam(client,actor,app,id,"request-again"),{created:false,teamState:"PENDING",assignedToCurrentOperator:true});
  assert.equal(audits.length,1);assert.equal((audits[0] as {actorId:string}).actorId,"staff");
});

test("a missing support permission prevents an intent",async t=>{
  setup(t,["order.read","im.support.read"]);
  let calls=0;const client={async query(){calls++;return {rows:[parties]};}} as unknown as PoolClient;
  await assert.rejects(assertLegacyOrderTeamRequest(client,actor,id),(e:unknown)=>(e as {status:number}).status===403);assert.equal(calls,0);
});

test("an operator outside the order's game scope cannot request a group",async t=>{
  setup(t,["order.read","im.support.read","im.support.accept"],["other-game"]);
  const client={async query(){return {rows:[parties]};}} as unknown as PoolClient;
  await assert.rejects(assertLegacyOrderTeamRequest(client,actor,id),(e:unknown)=>(e as {status:number}).status===404);
});

test("only the actual joined parties can read the new group; an old completed order has the fresh 72-hour window",async t=>{
  setup(t);const now=Date.now();
  const row={...parties,id,original_order_no:"fixture-order",account_id:"account",source_order_status:4,source_pay_status:1,continuation_stage:null,
    source_completed_at:new Date(now-30*24*3600000),source_cancelled_at:null,continuation_completed_at:null,game_name:"game",app_id:app,
    assigned_admin_id:"staff",provision_state:"ASSIGNED",team_state:"READY",team_id:"123",team_name:"fixture",team_ready_at:new Date(now-1000)};
  const members=[member("BUYER","user","renter"),member("OWNER","user","owner"),member("STAFF","admin","staff")];
  const client={async query(sql:string){if(sql.includes("FROM zzsh_order.legacy_order_read_snapshot l"))return {rows:[row]};if(sql.includes("FROM zzsh_order.im_order_member mm"))return {rows:members};throw Error("unexpected query");}} as unknown as PoolClient;
  for(const userId of ["renter","owner"]){const view=await readLegacyOrderTeamAccess(client,{realm:"user",userId,sessionId:"session"},id,"send");assert.equal(view.canRead,true);assert.equal(view.canSend,true);assert.equal(view.origin,"LEGACY");}
  await assert.rejects(readLegacyOrderTeamAccess(client,{realm:"user",userId:"outsider",sessionId:"session"},id),(e:unknown)=>(e as {status:number}).status===403);
  row.team_ready_at=new Date(now-73*3600000);
  const old=await readLegacyOrderTeamAccess(client,{realm:"user",userId:"renter",sessionId:"session"},id);
  assert.equal(old.canRead,true);assert.equal(old.canSend,false);
  await assert.rejects(readLegacyOrderTeamAccess(client,{realm:"user",userId:"renter",sessionId:"session"},id,"send"),(e:unknown)=>(e as {status:number}).status===403);
});
