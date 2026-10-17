import assert from "node:assert/strict";
import test from "node:test";
import { mountCreditGuaranteeRoutes } from "../src/credit/credit-guarantee-routes";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { handleMembershipGrowthUser, handleMembershipGrowthPolicyAdmin, handleMembershipGrowthAdmin } from "../src/auth/membership-growth-routes";
import { readGrowthSourceCompleteness, readMembershipGrowth } from "../src/auth/membership-growth-integration";

function response() { return { statusCode: 0, body: null as any, status(n: number) { this.statusCode=n;return this; },setHeader(){return this;},json(body:unknown){this.body=body;return this;} }; }
function fixture({ initialized=false,migrated=false,authenticated=true,active=true,validSession=true,auditFails=false }={}) {
  const queries:Array<{sql:string;args:unknown[]}> = [];
  const state=Object.freeze({userId:"synthetic-user",score:70,revision:"1",initializedAt:"2026-01-01T00:00:00.000Z"});
  const query=async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});assert.match(sql.trimStart(),/^(SELECT|BEGIN|COMMIT|ROLLBACK)\b/,"a read must not initialize business facts");
    const rows=(values:unknown[])=>({rows:values,rowCount:values.length});
    if(sql.includes("legacy-growth-schema"))return rows([{coverage:false,sources:false}]);
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return rows([]);
    if(sql.includes('COALESCE(s."account_status"'))return rows([{suspended:!active,accountStatus:active?"ACTIVE":"FROZEN"}]);
    if(sql.includes('SELECT "suspended"'))return rows([{suspended:!active}]);
    if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return rows([{accountStatus:active?"ACTIVE":"FROZEN"}]);
    if(sql.includes('FROM "zzsh_auth_user"."session"')||sql.includes('FROM zzsh_auth_user."session"')){assert.deepEqual(args,["synthetic-session","synthetic-user"]);return rows(validSession?[{}]:[]);}
    if(sql.includes("FROM zzsh_credit.user_credit_state")){assert.equal(args[0],"synthetic-user");return rows(initialized?[state]:[]);}
    if(sql.includes("FROM zzsh_credit.credit_event e"))return rows([{id:"synthetic-event",userId:"synthetic-user",scoreBefore:100,scoreAfter:70,eventType:"BREACH_CONFIRMED",internalBasis:"PRIVATE_BASIS",actorAdminId:"PRIVATE_ADMIN",payloadHash:"PRIVATE_HASH"}]);
    if(sql.includes("FROM zzsh_credit.credit_recovery_request")||sql.includes("FROM zzsh_supply.rental_account")||sql.includes("FROM zzsh_order.owner_guarantee_requirement"))return rows([]);
    if(sql.includes('SELECT id FROM zzsh_auth_user."user"'))return rows([{id:"synthetic-user"}]);
    if(sql.includes("FROM zzsh_iam.membership_growth_contribution")||sql.includes("FROM zzsh_iam.membership_growth_state")||sql.includes("FROM zzsh_iam.membership_growth_policy")||sql.includes("FROM zzsh_iam.membership_entitlement")||sql.includes("FROM zzsh_order.rental_order"))return rows([]);
    if(sql.includes("FROM zzsh_iam.user_rental_membership"))return rows([{sourceRef:"registration:v1"}]);
    if(sql.includes("user.legacy_owner.migrated")){assert.equal(args[0],"synthetic-user");assert.match(sql,/outcome='SUCCESS'/);if(auditFails)throw Error("synthetic provenance unavailable");return rows([{migrated}]);}
    throw Error(`Unexpected read SQL: ${sql}`);
  };
  const client={query,release(){}},pool={query,connect:async()=>client};
  const options={pool,apiOrigin:"http://127.0.0.1:4202",userOrigin:"http://127.0.0.1:4200",adminOrigin:"http://127.0.0.1:4201",userAuth:{api:{getSession:async()=>authenticated?{user:{id:"synthetic-user"},session:{id:"synthetic-session"}}:null}}};
  return {queries,state,client,pool,options};
}
function creditHandlers(options:unknown,commandsEnabled=false){const handlers=new Map<string,Function>();mountCreditGuaranteeRoutes({getHttpAdapter:()=>({getInstance:()=>({use:(prefix:string,handler:Function)=>handlers.set(prefix,handler)})})} as never,options as never,commandsEnabled);return handlers;}
const request=(path:string,method="GET")=>({method,originalUrl:path,headers:{origin:"http://127.0.0.1:4200"}});

test("formal credit GET works with commands off, preserves missing state and never writes INITIALIZED",async()=>{
  for(const prefix of ["/api/v1/users/me/credit","/api/bff/user/credit"]){
    const f=fixture(),res=response();await creditHandlers(f.options).get(prefix)!(request(prefix+"/overview"),res);
    assert.equal(res.statusCode,200);assert.equal(res.body.creditState,"NOT_INITIALIZED");assert.equal(res.body.credit,null);assert.deepEqual(res.body.recoveryRequests,[]);assert.deepEqual(res.body.guarantees,[]);assert.deepEqual(res.body.transactions,[]);
    assert.ok(f.queries.some(q=>q.sql.includes("user_credit_state")));assert.ok(f.queries.every(q=>!q.sql.includes("INSERT")&&!q.sql.includes("INITIALIZED")));
    assert.equal(f.queries.at(-1)?.sql,"COMMIT");
  }
});
test("formal credit GET preserves existing authoritative score and strips internal event fields",async()=>{
  const f=fixture({initialized:true}),res=response();await creditHandlers(f.options).get("/api/bff/user/credit")!(request("/api/bff/user/credit/overview"),res);
  assert.equal(res.statusCode,200);assert.equal(res.body.creditState,"INITIALIZED");assert.equal(res.body.credit.score,70);
  assert.equal(res.body.credit.events[0].internalBasis,undefined);assert.equal(res.body.credit.events[0].actorAdminId,undefined);assert.equal(res.body.credit.events[0].payloadHash,undefined);assert.equal(f.state.score,70);
});
test("credit read keeps authentication, active identity, session and origin boundaries",async()=>{
  for(const mode of [{authenticated:false},{active:false},{validSession:false}]){
    const f=fixture(mode),res=response();await creditHandlers(f.options).get("/api/bff/user/credit")!(request("/api/bff/user/credit/overview"),res);assert.equal(res.statusCode,401);assert.equal(res.body.credit,undefined);assert.ok(!f.queries.some(q=>q.sql.includes("zzsh_credit")));
  }
  const f=fixture(),res=response();await creditHandlers(f.options).get("/api/bff/user/credit")!({...request("/api/bff/user/credit/overview"),headers:{origin:"http://foreign.invalid"}},res);assert.equal(res.statusCode,403);assert.equal(f.queries.length,0);
});
test("credit query parameters cannot replace the authenticated subject",async()=>{
  const f=fixture(),res=response();await creditHandlers(f.options).get("/api/bff/user/credit")!(request("/api/bff/user/credit/overview?userId=synthetic-other"),res);assert.equal(res.statusCode,404);assert.ok(!f.queries.some(q=>q.args.includes("synthetic-other")));assert.ok(!f.queries.some(q=>q.sql.includes("zzsh_credit")));
});
test("mounting credit reads does not open any user or admin command when the existing capability is off",async()=>{
  for(const [prefix,path] of [["/api/bff/user/credit","/recovery-requests"],["/api/bff/user/credit","/accounts/synthetic-account/payment-intents"],["/api/bff/user/credit","/guarantees/synthetic-requirement/refund-requests"],["/api/bff/admin/credit","/breaches"],["/api/bff/admin/credit","/events/synthetic-event/reverse"],["/api/bff/admin/credit","/recovery-requests/synthetic-request/decision"],["/api/bff/admin/credit","/guarantees/synthetic-refund/release-decision"]] as const){
    const f=fixture(),res=response();await creditHandlers(f.options).get(prefix!)!({...request(prefix+path,"POST"),headers:{origin:prefix!.includes("admin")?f.options.adminOrigin:f.options.userOrigin}},res);assert.equal(res.statusCode,404);assert.equal(f.queries.length,0);
  }
});

test("CU-4 registration:v1 cannot prove zero growth for an imported subject",async()=>{
  const f=fixture({migrated:true});const value=await readGrowthSourceCompleteness(f.client as never,"synthetic-user",[],"registration:v1");assert.equal(value.state,"BACKFILL_PENDING");assert.ok(value.reasons?.includes("MIGRATED_SOURCE_NOT_PROVED"));
  const view=await readMembershipGrowth(f.client as never,"synthetic-user");assert.equal(view?.growth.knowledge,"UNKNOWN");assert.equal(view?.growth.rollingPoints,null);assert.equal(view?.growth.effectiveTier,null);assert.equal(view?.growth.benefitsState,"NOT_CONFIGURED");
});
test("CU-4 true native registration keeps complete zero growth without creating a projection or benefit",async()=>{
  const f=fixture();const value=await readGrowthSourceCompleteness(f.client as never,"synthetic-user",[],"registration:v1");assert.equal(value.state,"COMPLETE");
  const view=await readMembershipGrowth(f.client as never,"synthetic-user");assert.equal(view?.growth.knowledge,"KNOWN");assert.equal(view?.growth.rollingPoints,"0");assert.equal(view?.growth.benefitsState,"NOT_CONFIGURED");assert.deepEqual(view?.entitlements,[]);
  assert.equal((await readGrowthSourceCompleteness(f.client as never,"synthetic-user",[],null)).state,"BACKFILL_PENDING");
});
test("missing or unreadable migration evidence fails closed without becoming native zero",async()=>{
  const f=fixture({auditFails:true});await assert.rejects(()=>readGrowthSourceCompleteness(f.client as never,"synthetic-user",[],"registration:v1"),/provenance unavailable/);
  const view=await readMembershipGrowth(f.client as never,"synthetic-user");assert.equal(view?.growth.sourceState,"READ_FAILED");assert.equal(view?.growth.knowledge,"UNKNOWN");
  await assert.rejects(()=>readGrowthSourceCompleteness({query:async()=>({rows:[]})} as never,"synthetic-user",[],"registration:v1"),/proof is unavailable/);
});
test("formal growth GET remains reachable with the old command flag off, with original subject/session checks",async()=>{
  const previous=process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;
  try{
    for(const migrated of [true,false]){const f=fixture({migrated}),res=response();await handleMembershipGrowthUser(request("/api/v1/users/me/membership-growth"),res as never,f.options as never);assert.equal(res.statusCode,200);assert.equal(res.body.subjectId,"synthetic-user");assert.equal(res.body.growth.knowledge,migrated?"UNKNOWN":"KNOWN");assert.ok(f.queries.some(q=>q.sql.includes('FOR UPDATE')),"existing identity lock remains");}
    for(const mode of [{authenticated:false},{active:false},{validSession:false}]){const f=fixture(mode),res=response();await handleMembershipGrowthUser(request("/api/v1/users/me/membership-growth"),res as never,f.options as never);assert.equal(res.statusCode,401);assert.ok(!f.queries.some(q=>q.sql.includes("membership_growth_contribution")));}
    const f=fixture(),res=response();await handleMembershipGrowthUser(request("/api/v1/users/other/membership-growth"),res as never,f.options as never);assert.equal(res.statusCode,404);assert.equal(f.queries.length,0);
    for(const path of ["/api/v1/admin/membership-growth/backfill","/api/v1/admin/membership-growth/policy-drafts"]){const out=response();await handleMembershipGrowthPolicyAdmin({...request(path,"POST"),headers:{origin:f.options.adminOrigin}},out as never,f.options as never);assert.equal(out.statusCode,404);assert.equal(f.queries.length,0);}
  }finally{if(previous===undefined)delete process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED;else process.env.ZZSH_MEMBERSHIP_GROWTH_ENABLED=previous;}
});
test("opening the existing admin growth read does not bypass its original permission boundary",async t=>{
  const auth=require("../src/auth/auth-security"),authorization=require("../src/auth/admin-authorization");
  t.mock.method(auth,"readAdminContext",async()=>({userId:"synthetic-admin",sessionId:"synthetic-admin-session"}));t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(authorization,"loadEffectiveAdminAccess",async()=>({isBoss:false,permissions:new Set()}));
  const f=fixture(),res=response();await handleMembershipGrowthAdmin({...request("/api/v1/admin/users/synthetic-other/membership-growth"),headers:{origin:f.options.adminOrigin}},res as never,f.options as never);assert.equal(res.statusCode,403);assert.ok(!f.queries.some(q=>q.sql.includes("membership_growth")));
});
test("order reads degrade before 0074 instead of failing on the missing continuation table",async()=>{
  const { orderReadRelation }=require("../src/order/admin-order-read");
  const { legacyUserOrderFields,legacyUserOrderFrom }=require("../src/order/legacy-user-order-read");
  const { legacyContinuationReady }=require("../src/order/legacy-order-read");
  assert.doesNotMatch(orderReadRelation(false),/legacy_continuation_version/,"74-chain relation must not reference 0074 tables");
  assert.match(orderReadRelation(false),/NULL::int AS stage/);
  assert.match(orderReadRelation(true),/LEFT JOIN zzsh_order\.legacy_continuation_version h/);
  const fieldsOff=legacyUserOrderFields(false),fromOff=legacyUserOrderFrom(false);
  assert.doesNotMatch(fieldsOff+fromOff,/legacy_continuation_version/);
  assert.match(fieldsOff,/h\.stage AS "continuationStage"/);
  assert.match(fromOff,/NULL::int AS stage/);
  assert.match(legacyUserOrderFields(true)+legacyUserOrderFrom(true),/legacy_continuation_version/);
  for(const ready of [true,false]){
    const client={query:async(sql:string)=>({rows:[/to_regclass\('zzsh_order\.legacy_continuation_version'\)/.test(sql)?{ready}:{}]})};
    assert.equal(await legacyContinuationReady(client as never),ready);
  }
});

function adminBffCapture(){const state={statusCode:0,body:null as any,requestId:null as string|null,headersSent:false};const response={setHeader(name:string,value:unknown){if(String(name).toLowerCase()==="x-request-id")state.requestId=String(value);return response;},status(status:number){state.statusCode=status;return response;},json(body:unknown){state.body=body;state.headersSent=true;return response;},send(body:unknown){state.body=body;state.headersSent=true;return response;}};return{response,state};}
function adminBffOptions():AdminBffOptions{return{adminOrigin:"http://127.0.0.1:4201",apiOrigin:"http://127.0.0.1:4202",adminSecurityOptions:{pool:{}} as never,adminAuthHandler:(async()=>new Response(null,{status:404})) as never,supply:{} as never,order:{} as never}as unknown as AdminBffOptions;}
test("admin BFF forwards subject growth before the generic /users/:id directory branch",async t=>{
  const auth=require("../src/auth/auth-security"),authorization=require("../src/auth/admin-authorization"),growth=require("../src/auth/membership-growth-routes");
  t.mock.method(auth,"readAdminContext",async()=>({userId:"synthetic-admin",sessionId:"synthetic-admin-session"}));
  t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});
  t.mock.method(authorization,"loadEffectiveAdminAccess",async()=>({isBoss:true,permissions:new Set()}));
  let called=false;
  const growthAdminMock=function(_request:any,response:any){called=true;response.status(200).json({subjectId:"synthetic-other"});};
  t.mock.method(growth,"handleMembershipGrowthAdmin",growthAdminMock as any);
  const ok=adminBffCapture();
  await handleAdminBff({method:"GET",url:"/api/bff/admin/users/synthetic-other/membership-growth",originalUrl:"/api/bff/admin/users/synthetic-other/membership-growth",headers:{origin:"http://127.0.0.1:4201","x-request-id":"req_ok"}} as never,ok.response as never,adminBffOptions());
  assert.equal(called,true,"the growth handler must own the route");
  assert.equal(ok.state.statusCode,200);assert.deepEqual(ok.state.body,{subjectId:"synthetic-other"});
  assert.equal(ok.state.requestId,"req_ok","the own handler must pass requestId instead of the outer BFF send");
  const rejected=adminBffCapture();called=false;
  await handleAdminBff({method:"POST",url:"/api/bff/admin/users/synthetic-other/membership-growth",originalUrl:"/api/bff/admin/users/synthetic-other/membership-growth",headers:{origin:"http://127.0.0.1:4201","x-request-id":"req_rejected"}} as never,rejected.response as never,adminBffOptions());
  assert.equal(rejected.state.statusCode,404);assert.equal(called,false,"growth stays GET-only through the BFF");
  assert.equal(rejected.state.requestId,"req_rejected","the outer BFF owns x-request-id on the rejected path");
});

test("credit and policy admin GETs still reject an authenticated admin without the original read permission",async t=>{
  const auth=require("../src/auth/auth-security"),authorization=require("../src/auth/admin-authorization");
  t.mock.method(auth,"readAdminContext",async()=>({userId:"synthetic-admin",sessionId:"synthetic-admin-session"}));t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(authorization,"loadEffectiveAdminAccess",async()=>({isBoss:false,permissions:new Set()}));
  const f=fixture(),credit=response();await creditHandlers(f.options).get("/api/bff/admin/credit")!({...request("/api/bff/admin/credit/users/synthetic-other"),headers:{origin:f.options.adminOrigin}},credit);assert.equal(credit.statusCode,403);assert.ok(!f.queries.some(q=>q.sql.includes("zzsh_credit")));
  const policy=response();await handleMembershipGrowthPolicyAdmin({...request("/api/v1/admin/membership-growth/policy"),headers:{origin:f.options.adminOrigin}},policy as never,f.options as never);assert.equal(policy.statusCode,403);assert.ok(!f.queries.some(q=>q.sql.includes("membership_growth_policy")));
});
