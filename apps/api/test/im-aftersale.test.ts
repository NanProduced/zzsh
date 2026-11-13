import assert from "node:assert/strict";
import { test } from "node:test";
import { createAftersale,listAftersales,claimAftersale,resolveAftersale,readAftersaleForAdmin,parseAftersaleCreate,parseAftersaleResolve } from "../src/im/aftersale";

function fixture(){
  const records=new Map<string,any>(),audits:any[]=[];
  const rights:Record<string,string[]>={a:["im.support.read","im.support.accept"],b:["im.support.read","im.support.accept"],reader:["im.support.read"],manager:["im.support.read","im.support.management.read","im.support.accept","im.support.audit.takeover"]};
  const state={status:"COMPLETED",posted:true,live:null as string|null};
  const result=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
  const project=(r:any)=>({...r,display_no:"DD-TEST",live_admin_id:state.live,effective_admin_id:r.handler_admin_id,handler_name:r.handler_admin_id?"回归客服":null,cursor_time:new Date(r.created_at).toISOString().replace("Z","000Z")});
  const query=async(sql:string,v:any[]=[])=>{
    if(sql.includes("pg_try_advisory_xact_lock"))return result([{locked:true}]);
    if(sql.includes('FROM "zzsh_auth_admin"."session"'))return result([{locked:false,twoFactorEnabled:true,suspended:false}]);
    if(sql.includes('FROM "zzsh_iam"."admin_security"'))return result([{status:"ACTIVE",isBoss:false,passwordChangeRequired:false}]);
    if(sql.includes("WITH role_permissions"))return result((rights[v[0]]??[]).map(permissionCode=>({permissionCode})));
    if(sql.startsWith('SELECT "suspended" FROM'))return result([{suspended:false}]);
    if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return result([{accountStatus:"ACTIVE"}]);
    if(sql.includes('FROM "zzsh_auth_user"."session"'))return result([{}]);
    if(sql.includes("user-settlement-stage-batch"))return result([{id:"order",orderStatus:state.status,posted:state.posted,currentVersionNo:1,viewerParty:v[1]==="renter"?"RENTER":"OWNER",intakeOpen:false,renterAction:null,ownerAction:null}]);
    if(sql.includes("FROM zzsh_order.rental_order WHERE id=$1"))return result(v[0]==="order"&&["renter","owner"].includes(v[1])?[{party:v[1]==="renter"?"RENTER":"OWNER"}]:[]);
    if(sql.includes("SELECT id,order_id,description FROM"))return result([...records.values()].filter(r=>r.app_id===v[0]&&r.requester_user_id===v[1]&&r.operation_id===v[2]));
    if(sql.includes("SELECT id FROM zzsh_iam.im_aftersale_record"))return result([...records.values()].filter(r=>r.app_id===v[0]&&r.requester_user_id===v[1]&&r.order_id===v[2]&&r.state==="PENDING"));
    if(sql.startsWith("INSERT INTO zzsh_iam.im_aftersale_record")){
      records.set(v[0],{id:v[0],app_id:v[1],order_source:"NATIVE",order_id:v[2],requester_user_id:v[3],requester_party:v[4],description:v[5],operation_id:v[6],state:"PENDING",handler_admin_id:state.live,result:null,resolved_by_admin_id:null,resolved_at:null,resolve_operation_id:null,version:1,created_at:new Date(1000+records.size),updated_at:new Date(1000+records.size)});return result([],1);
    }
    if(sql.startsWith("UPDATE zzsh_iam.im_aftersale_record")){
      const r=records.get(v[1]);r.handler_admin_id=v[2];r.version++;r.updated_at=new Date(3000+r.version);
      if(sql.includes("state='RESOLVED'")){r.state="RESOLVED";r.result=v[3];r.resolved_by_admin_id=v[2];r.resolved_at=new Date(4000);r.resolve_operation_id=v[4];}
      return result([],1);
    }
    if(sql.includes("a.*,o.display_no")){
      if(sql.includes("a.id=$2"))return result(records.has(v[1])&&records.get(v[1]).app_id===v[0]?[project(records.get(v[1]))]:[]);
      let rows=[...records.values()].filter(r=>r.app_id===v[0]&&(!v[1]||r.order_id===v[1])&&(v[2]==="ALL"||r.state===v[2])&&(v[3]||v[4]==="user"&&r.requester_user_id===v[5]||v[4]==="admin"&&(r.handler_admin_id===v[5]||r.state==="PENDING"&&!r.handler_admin_id&&v[8]))).map(project);
      if(v[6])rows=rows.filter(r=>r.cursor_time<v[6]||r.cursor_time===v[6]&&r.id<v[7]);
      return result(rows.sort((a,b)=>b.cursor_time.localeCompare(a.cursor_time)||b.id.localeCompare(a.id)).slice(0,51));
    }
    if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')){audits.push({action:v[4],details:JSON.parse(v[10])});return result([],1);}
    return result();
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const options={pool,appId:"app"} as never;
  const user=(userId="renter")=>({userId,sessionId:"user-session"});
  const admin=(userId="a")=>({userId,sessionId:"admin-session"}) as never;
  const body=(operationId="operation_renter_0001",description="请核对已结算订单问题")=>({orderSource:"NATIVE",orderId:"order",description,operationId});
  return {options,user,admin,body,records,audits,rights,state};
}

test("aftersale admission uses posted settlement and ownership, not a COMPLETED label or client assignee",async()=>{
  const f=fixture();
  for(const [status,posted] of [["COMPLETED",false],["CANCELLED",true],["PENDING_PAYMENT",false]] as const){f.state.status=status;f.state.posted=posted;await assert.rejects(createAftersale(f.options,f.user(),f.body(),"request"),{status:409});}
  f.state.status="COMPLETED";f.state.posted=true;
  await assert.rejects(createAftersale(f.options,f.user("stranger"),f.body(),"request"),{status:404});
  assert.throws(()=>parseAftersaleCreate({...f.body(),handlerAdminId:"a"}));
  assert.throws(()=>parseAftersaleCreate({...f.body(),orderSource:"LEGACY"}));
  for(const description of [""," ","x".repeat(1001),"\u0000"])assert.throws(()=>parseAftersaleCreate(f.body("operation_renter_0001",description)));
  assert.equal(f.records.size,0);
});
test("duplicate/replayed submissions keep one pending record per requester; the other party stays private",async()=>{
  const f=fixture(),first=await createAftersale(f.options,f.user(),f.body(),"new");
  assert.equal(first.created,true);
  assert.equal((await createAftersale(f.options,f.user(),f.body(),"retry")).record.id,first.record.id);
  const different=await createAftersale(f.options,f.user(),f.body("operation_renter_0002","另一问题"),"again");
  assert.equal(different.created,false);assert.equal(different.record.description,f.body().description);
  await assert.rejects(createAftersale(f.options,f.user(),f.body("operation_renter_0001","换了内容"),"conflict"),{status:409});
  const owner=await createAftersale(f.options,f.user("owner"),f.body("operation_owner_0001","号主的问题"),"owner");
  assert.notEqual(owner.record.id,first.record.id);
  for(const [who,id] of [["renter",first.record.id],["owner",owner.record.id]]){
    const page=await listAftersales(f.options,{...f.user(who),realm:"user"},{orderSource:"NATIVE",orderId:"order"});
    assert.deepEqual(page.items.map(r=>r.id),[id]);assert.equal("requesterUserId" in page.items[0]!,false);
  }
  await assert.rejects(listAftersales(f.options,{...f.user("stranger"),realm:"user"},{orderSource:"NATIVE",orderId:"order"}),{status:404});
  assert.equal(f.records.size,2);assert.ok(f.audits.every(a=>!JSON.stringify(a.details).includes("的问题")));
});
test("read-only agents cannot read unassigned aftersale requests or claim; handlers retain read after accept revocation",async()=>{
  const f=fixture(),created=await createAftersale(f.options,f.user(),f.body(),"new"),id=created.record.id;
  assert.equal((await listAftersales(f.options,{userId:"reader",sessionId:"s",realm:"admin"} as never,{})).items.length,0);
  await assert.rejects(readAftersaleForAdmin(f.options,f.admin("reader"),id),{status:404});
  await assert.rejects(claimAftersale(f.options,f.admin("reader"),id,1,"claim"),{status:403});
  const claimed=await claimAftersale(f.options,f.admin(),id,1,"claim");assert.equal(claimed.record.handler?.id,"a");
  await assert.rejects(readAftersaleForAdmin(f.options,f.admin("b"),id),{status:404});
  f.rights.a=["im.support.read"];assert.equal((await readAftersaleForAdmin(f.options,f.admin(),id)).record.id,id);
  await assert.rejects(resolveAftersale(f.options,f.admin(),id,{version:claimed.record.version,result:"已说明",operationId:"resolve_operation_001"},"resolve"),{status:403});
});
test("claim/resolve enforce version and handler; a lost resolve ACK replays without changing the result",async()=>{
  const f=fixture(),created=await createAftersale(f.options,f.user(),f.body(),"new"),id=created.record.id;
  const claimed=await claimAftersale(f.options,f.admin(),id,1,"claim");
  assert.equal((await claimAftersale(f.options,f.admin(),id,1,"claim-again")).record.version,claimed.record.version);
  await assert.rejects(resolveAftersale(f.options,f.admin(),id,{version:1,result:"说明",operationId:"resolve_operation_001"},"stale"),{status:409});
  const input={version:claimed.record.version,result:"已核对并说明，未变更资金",operationId:"resolve_operation_001"};
  const done=await resolveAftersale(f.options,f.admin(),id,input,"done");assert.equal(done.record.state,"RESOLVED");
  assert.equal((await resolveAftersale(f.options,f.admin(),id,input,"ack-lost")).replayed,true);
  await assert.rejects(resolveAftersale(f.options,f.admin(),id,{...input,result:"覆盖结果"},"bad"),{status:409});
  assert.equal(f.records.get(id).result,input.result);
  const next=await createAftersale(f.options,f.user(),f.body("operation_renter_0002","后续新问题"),"next");assert.equal(next.created,true);assert.notEqual(next.record.id,id);
  assert.throws(()=>parseAftersaleResolve({...input,result:""}));
});
test("aftersale cursor is scoped to actor/order; pagination has no duplicate rows",async()=>{
  const f=fixture(),first=await createAftersale(f.options,f.user(),f.body(),"new"),base=f.records.get(first.record.id);
  for(let i=0;i<53;i++)f.records.set("AS"+String(i).padStart(32,"0"),{...base,id:"AS"+String(i).padStart(32,"0"),created_at:new Date(2000+i),state:"RESOLVED",handler_admin_id:"a",result:"done",resolved_at:new Date(3000),resolved_by_admin_id:"a",resolve_operation_id:"resolve"+i});
  const actor={...f.user(),realm:"user" as const},query={orderSource:"NATIVE",orderId:"order"};
  const one=await listAftersales(f.options,actor,query);assert.equal(one.items.length,50);assert.ok(one.nextCursor);
  const two=await listAftersales(f.options,actor,{...query,cursor:one.nextCursor!});assert.equal(two.items.length,4);assert.equal(two.nextCursor,null);
  assert.equal(new Set([...one.items,...two.items].map(r=>r.id)).size,54);
  await assert.rejects(listAftersales(f.options,{...f.user("owner"),realm:"user"},{...query,cursor:one.nextCursor!}),{status:400});
});
