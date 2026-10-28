import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {INestApplication} from '@nestjs/common';
import type {AppConfig} from '../src/config/config';
import {createLocalDistributionScope,createLocalDistributionReadScope,assertLocalDistributionAssembly,assertReviewedDistributionMaintenanceResource,readDistributionPolicy,readActiveDistributionPolicyInTransaction,readRegistrationDistributionPolicyInTransaction,configureDistributionPolicy,type LocalDistributionScope} from '../src/finance/distribution-policy-store';
import {initializeNewDistributionRegistration} from '../src/finance/distribution-registration';
import {readMyInvitations,bindMyDistributionLeader} from '../src/finance/invitation-store';
import {mountDistributionPolicyRoutes} from '../src/finance/distribution-policy-routes';
import {mountInvitationRoutes} from '../src/finance/invitation-routes';
import type {AuthSecurityOptions} from '../src/auth/auth-security';
import {mountAuthHandlers} from '../src/auth/auth-runtime';
import {canonicalize} from '../src/supply/content-hash';
// Synthetic creation receipt only. This test never opens a connection or claims a live OID.
const receipt={database:'zzsh_test_order_credit_admin_batch2',resourceOid:123456789,owner:'zzsh',marker:'zzsh:order-reservation-test:v1',migrationRole:'zzsh_order_credit_admin_batch2_m',runtimeRole:'zzsh_order_credit_admin_batch2_r'};
const config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:receipt.database,user:receipt.runtimeRole}} as AppConfig;
const assembly={testOperationsEnabled:true,secureCookies:false,apiOrigin:'http://127.0.0.1:4282',userOrigin:'http://127.0.0.1:4280',adminOrigin:'http://127.0.0.1:4281'};
const policyConfig={schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:0,levels:[{code:'BATCH2',rank:1,default:true,renterPercent:'0',ownerPercent:'10',upgrade:null}]};
const actor={userId:'self',sessionId:'test-session',requestId:'req_scope_test'};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function probe(options:{identity?:Record<string,unknown>;shape?:Record<string,unknown>;permissions?:string[];policy?:boolean;previous?:boolean}={}){
 const seen:{sql:string;args:any[]}[]=[],participants=new Map<string,any>();let row:any=options.policy===false?null:{id:'policy_test',revision:'1',canonical_config:canonicalize(policyConfig),config_digest:sha(canonicalize(policyConfig)),created_at:'2026-10-08T00:00:00Z'};
 const c={release(){},async query(sql:string,args:any[]=[]):Promise<any>{
  seen.push({sql,args});const result=(data:any[]=[])=>({rows:data,rowCount:data.length});
  if(sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')return result();
  if(['BEGIN','COMMIT','ROLLBACK','SET CONSTRAINTS ALL IMMEDIATE'].includes(sql)||sql.startsWith('SELECT pg_advisory'))return result();
  if(sql.startsWith('SELECT d.oid'))return result([{oid:receipt.resourceOid,name:receipt.database,role:receipt.runtimeRole,marker:receipt.marker,complete:true,...options.identity}]);
  if(sql.startsWith('SELECT pg_get_userbyid'))return result([{owner:'zzsh',rolsuper:false,rolbypassrls:false,complete:true,...options.shape}]);
  if(sql.startsWith('SELECT to_regclass'))return result([{complete:true,protected_proof:true}]);
  if(sql.startsWith('SELECT s.'))return result([{locked:false,twoFactorEnabled:true}]);
  if(sql.includes('FROM "zzsh_iam"."admin_security"'))return result([{status:'ACTIVE',isBoss:options.permissions===undefined,passwordChangeRequired:false}]);
  if(sql.startsWith('WITH role_permissions'))return result((options.permissions??[]).map(permissionCode=>({permissionCode})));
  if(sql.startsWith('SELECT suspended')||sql.startsWith('SELECT "suspended"')||sql.startsWith('SELECT u."suspended"'))return result([{suspended:false,accountStatus:'ACTIVE'}]);
  if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return result([{accountStatus:'ACTIVE',identityStatus:'UNVERIFIED',ageStatus:'UNKNOWN'}]);
  if(sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'))return result([{}]);
  if(sql.includes('FROM "zzsh_supply"."idempotency_record"'))return result();
  if(sql.startsWith('SELECT v.'))return result(row?[row]:[]);
  if(sql.startsWith('SELECT revision::text'))return result(row?[{revision:row.revision}]:[]);
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_policy_version')){row={id:args[0],revision:args[1],canonical_config:args[3],config_digest:args[4],created_at:'2026-10-08T00:00:00Z'};return result([{}]);}
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_policy_head')||sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')||sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"'))return result([{}]);
  if(sql.startsWith('SELECT user_id FROM zzsh_order.distribution_participant'))return result(options.previous?[{user_id:args[0]}]:[]);
  if(sql.startsWith('SELECT u.id,u.suspended'))return result([{id:args[0],suspended:false,account_status:'ACTIVE',inserted_in_transaction:true}]);
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_participant')){participants.set(args[0],{user_id:args[0],eligibility:args[1],level_code:args[2],policy_version_id:args[3],revision:'1',inviter_knowledge:args[4],leader_knowledge:args[5]});return result([{}]);}
  if(sql.startsWith('INSERT INTO zzsh_order.distribution_invite_code'))return result([{id:args[0]}]);
  if(sql.startsWith('SELECT * FROM zzsh_order.distribution_participant'))return result([participants.get(args[0])??{user_id:'self',eligibility:'ELIGIBLE',level_code:'BATCH2',revision:'1',leader_knowledge:'KNOWN_NONE',inviter_knowledge:'KNOWN_NONE'}]);
  if(sql.startsWith('SELECT eligibility,level_code'))return result([{eligibility:'ELIGIBLE',level_code:'BATCH2',commission_frozen:false,policy_version_id:'policy_test'}]);
  if(sql.startsWith('SELECT display_code'))return result([{display_code:'FX_SELF',source_type:'NATIVE_REGISTRATION'}]);
  if(sql.startsWith('SELECT * FROM zzsh_order.invitation_relation')||sql.startsWith('SELECT id,child_user_id'))return result();
  if(sql.startsWith('SELECT * FROM zzsh_order.distribution_invite_code'))return result([{id:'code_parent',user_id:'parent',display_code:'FX_PARENT',source_type:'NATIVE_REGISTRATION'}]);
  if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return result((Array.isArray(args[0])?args[0]:[args[0]]).map(id=>({id})));
  if(sql.startsWith('SELECT p.'))return result([{user_id:'parent',eligibility:'ELIGIBLE',level_code:'BATCH2',suspended:false,account_status:'ACTIVE',leader_knowledge:'KNOWN_NONE'}]);
  if(sql.startsWith('WITH RECURSIVE'))return result([{user_id:'parent',cyclic:false,leader_knowledge:'KNOWN_NONE',parent_user_id:null}]);
  if(sql.startsWith('INSERT INTO zzsh_order.invitation_relation')||sql.startsWith('UPDATE zzsh_order.distribution_participant'))return result([{}]);
  throw Error('Unexpected SQL in isolated test: '+sql);
 }} as unknown as PoolClient;
 return{c,pool:{connect:async()=>c,query:c.query.bind(c)} as unknown as Pool,seen,participants};
}
const binding=()=>createLocalDistributionScope(config,receipt);
// Expected local rehearsal identity in a fake client; no real resource is contacted by these tests.
const milestoneReceipt={database:'zzsh_test_order_milestone_real_1',resourceOid:952624,owner:'zzsh',ownerOid:10,marker:'zzsh:order-reservation-test:v1',migrationRole:'zzsh_order_milestone_real_1_m',migrationRoleOid:952625,runtimeRole:'zzsh_order_milestone_real_1_r',runtimeRoleOid:952626};
const milestoneConfig={...config,database:{...config.database,name:milestoneReceipt.database,user:milestoneReceipt.runtimeRole}} as AppConfig;
const milestoneAssembly={...assembly,apiOrigin:'http://127.0.0.1:4222',userOrigin:'http://127.0.0.1:4220',adminOrigin:'http://127.0.0.1:4221'};
const milestoneBinding=()=>createLocalDistributionScope(milestoneConfig,milestoneReceipt);
const milestoneReadBinding=()=>createLocalDistributionReadScope({...milestoneConfig,testOperationsEnabled:false},milestoneReceipt);

test('milestone read scope works with test writes off and admits no other resource or assembly',()=>{
 assertLocalDistributionAssembly(milestoneReadBinding(),{...milestoneAssembly,testOperationsEnabled:false});
 assert.throws(()=>createLocalDistributionScope({...milestoneConfig,testOperationsEnabled:false},milestoneReceipt));
 assert.throws(()=>createLocalDistributionReadScope({...config,testOperationsEnabled:false},receipt));
 for(const patch of [{resourceOid:952623},{ownerOid:11},{runtimeRoleOid:952625},{migrationRoleOid:952626},{runtimeRole:'zzsh'},{marker:'other'}])assert.throws(()=>createLocalDistributionReadScope({...milestoneConfig,testOperationsEnabled:false},{...milestoneReceipt,...patch}));
 for(const patch of [{profile:'production'},{provider:'real'}])assert.throws(()=>createLocalDistributionReadScope({...milestoneConfig,testOperationsEnabled:false,...patch} as AppConfig,milestoneReceipt));
 for(const patch of [{secureCookies:true},{apiOrigin:'http://127.0.0.1:3102'},{userOrigin:'http://127.0.0.1:3100'},{adminOrigin:'http://127.0.0.1:3101'}])assert.throws(()=>assertLocalDistributionAssembly(milestoneReadBinding(),{...milestoneAssembly,testOperationsEnabled:false,...patch}));
 assert.throws(()=>assertLocalDistributionAssembly({kind:'LOCAL_CONTROLLED_DISTRIBUTION'},{...milestoneAssembly,testOperationsEnabled:false}));
});

test('read capability returns existing policy and participant facts but cannot bind or configure',async()=>{
 const options={identity:{name:milestoneReceipt.database,oid:952624,role:milestoneReceipt.runtimeRole},shape:{ownerOid:10,roleOid:952626}},scope=milestoneReadBinding(),p=probe(options);
 assert.equal((await readDistributionPolicy(p.pool,actor,scope)).knowledge,'KNOWN');const self=await readMyInvitations(p.pool,actor,scope);assert.equal(self.policyKnowledge,'KNOWN');assert.equal(self.participant.eligibility,'ELIGIBLE');assert.equal(self.canBindLeader,false);
 const absent=await readDistributionPolicy(probe({...options,policy:false}).pool,actor,scope);assert.equal(absent.knowledge,'UNKNOWN');assert.equal(absent.policy,null);assert(!p.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 for(const run of [()=>configureDistributionPolicy(p.pool,actor,{expectedRevision:'1',config:policyConfig,reason:'Read scope cannot write'},'read_scope_policy',scope),()=>bindMyDistributionLeader(p.pool,actor,{code:'FX_PARENT',policyVersion:'policy_test',expectedParticipantRevision:'1'},'read_scope_bind',scope),()=>initializeNewDistributionRegistration(p.c,{userId:'self',requestId:'req_read_registration'},scope),()=>readActiveDistributionPolicyInTransaction(p.c,false,scope),()=>readRegistrationDistributionPolicyInTransaction(p.c,scope),()=>assertReviewedDistributionMaintenanceResource(p.c,scope)])await assert.rejects(run(),e=>(e as {status:number}).status===503);
 assert(!p.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('read capability still verifies actual owner, runtime role, schema and caller permissions',async()=>{
 const options={identity:{name:milestoneReceipt.database,oid:952624,role:milestoneReceipt.runtimeRole},shape:{ownerOid:10,roleOid:952626}},scope=milestoneReadBinding();
 for(const identity of [{name:'other'},{oid:931888},{role:milestoneReceipt.migrationRole},{role:'zzsh'},{marker:'other'},{complete:false}])await assert.rejects(readDistributionPolicy(probe({...options,identity:{...options.identity,...identity}}).pool,actor,scope));
 for(const shape of [{ownerOid:11},{roleOid:952625},{rolsuper:true},{rolbypassrls:true},{complete:false}])await assert.rejects(readDistributionPolicy(probe({...options,shape:{...options.shape,...shape}}).pool,actor,scope));
 await assert.rejects(readDistributionPolicy(probe({...options,permissions:[]}).pool,actor,scope),e=>(e as {status:number}).status===403);
 await assert.rejects(readDistributionPolicy(probe(options).pool,actor,{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}));
});

test('GET-only route assembly keeps PUT and bind on their original unadmitted scope',async()=>{
 const p=probe({identity:{name:milestoneReceipt.database,oid:952624,role:milestoneReceipt.runtimeRole},shape:{ownerOid:10,roleOid:952626}}),handlers=new Map<string,Function>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(path:string,fn:Function)=>handlers.set(path,fn)})})} as unknown as INestApplication;
 const session=async()=>({user:{id:'self',twoFactorEnabled:true},session:{id:'test-session'}}),options={...milestoneAssembly,testOperationsEnabled:false,pool:p.pool,adminAuth:{api:{getSession:session}},userAuth:{api:{getSession:session}},distributionReadScope:milestoneReadBinding()} as unknown as AuthSecurityOptions&{distributionReadScope:LocalDistributionScope};mountDistributionPolicyRoutes(app,options);mountInvitationRoutes(app,options);
 const call=async(prefix:string,method:string,url:string,origin:string,body?:unknown)=>{let status=0,result:any;const response:any={setHeader(){return this;},status(n:number){status=n;return this;},json(b:unknown){result=b;}};await handlers.get(prefix)!({method,originalUrl:url,headers:{origin,'x-request-id':'req_route_read_scope','idempotency-key':'read_route_key'},body},response);return{status,result};};
 for(const [prefix,url,origin]of [['/api/v1/admin/distribution/policy','/api/v1/admin/distribution/policy',milestoneAssembly.adminOrigin],['/api/v1/users/me/distribution','/api/v1/users/me/distribution',milestoneAssembly.userOrigin],['/api/v1/users/me/distribution','/api/v1/users/me/distribution/terms',milestoneAssembly.userOrigin]])assert.equal((await call(prefix!,'GET',url!,origin!)).status,200);
 assert.equal((await call('/api/v1/admin/distribution/policy','PUT','/api/v1/admin/distribution/policy',milestoneAssembly.adminOrigin,{expectedRevision:'1',config:policyConfig,reason:'Write not admitted'})).status,403);
 assert.equal((await call('/api/v1/users/me/distribution','POST','/api/v1/users/me/distribution/bind',milestoneAssembly.userOrigin,{code:'FX_PARENT',policyVersion:'policy_test',expectedParticipantRevision:'1'})).status,503);assert(!p.seen.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('the milestone copy requires its exact source receipt and fixed assembly, never any local test database',()=>{
 assertLocalDistributionAssembly(milestoneBinding(),milestoneAssembly);
 for(const patch of [{resourceOid:952623},{ownerOid:11},{runtimeRoleOid:952625},{migrationRoleOid:952626},{runtimeRole:'zzsh'},{marker:'other'}])assert.throws(()=>createLocalDistributionScope(milestoneConfig,{...milestoneReceipt,...patch}));
 assert.throws(()=>createLocalDistributionScope({...milestoneConfig,provider:'real'} as AppConfig,milestoneReceipt));
 assert.throws(()=>createLocalDistributionScope({...milestoneConfig,database:{...milestoneConfig.database,user:milestoneReceipt.migrationRole}} as AppConfig,milestoneReceipt));
 assert.throws(()=>assertLocalDistributionAssembly(milestoneBinding(),assembly));assert.throws(()=>assertLocalDistributionAssembly(binding(),milestoneAssembly));
});

test('the milestone runtime read requires matching role and owner OIDs as well as resource names',async()=>{
 const options={identity:{name:milestoneReceipt.database,oid:952624,role:milestoneReceipt.runtimeRole},shape:{ownerOid:10,roleOid:952626}};
 assert.equal((await readActiveDistributionPolicyInTransaction(probe(options).c,false,milestoneBinding())).knowledge,'KNOWN');
 for(const shape of [{ownerOid:11},{roleOid:952625},{rolsuper:true},{rolbypassrls:true}])await assert.rejects(readActiveDistributionPolicyInTransaction(probe({...options,shape:{...options.shape,...shape}}).c,false,milestoneBinding()));
 await assert.rejects(readActiveDistributionPolicyInTransaction(probe({...options,identity:{...options.identity,role:'zzsh'}}).c,false,milestoneBinding()));
 assert.equal((await readRegistrationDistributionPolicyInTransaction(probe(options).c)).reason,'DISTRIBUTION_RESOURCE_NOT_ADMITTED');
});

test('owner-only legacy maintenance uses the same opaque receipt while runtime and forged receipts cannot import',async()=>{
 const options={identity:{name:milestoneReceipt.database,oid:952624,role:'zzsh'},shape:{ownerOid:10,roleOid:10,rolsuper:true,rolbypassrls:true}};
 assert.equal(await assertReviewedDistributionMaintenanceResource(probe(options).c,milestoneBinding()),true);
 for(const patch of [{role:milestoneReceipt.runtimeRole},{oid:931888},{name:'zzsh_test_order_other'}])await assert.rejects(assertReviewedDistributionMaintenanceResource(probe({...options,identity:{...options.identity,...patch}}).c,milestoneBinding()));
 await assert.rejects(assertReviewedDistributionMaintenanceResource(probe({...options,shape:{...options.shape,roleOid:952626}}).c,milestoneBinding()));
 await assert.rejects(assertReviewedDistributionMaintenanceResource(probe(options).c,{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}));
 await assert.rejects(assertReviewedDistributionMaintenanceResource(probe().c,binding()));
});
test('exact creation capability rejects foreign configuration, receipt, remote and real provider',()=>{
 assertLocalDistributionAssembly(binding(),assembly);
 for(const patch of [{profile:'production'},{provider:'real'},{testOperationsEnabled:false}])assert.throws(()=>createLocalDistributionScope({...config,...patch} as AppConfig,receipt));
 for(const patch of [{host:'localhost'},{host:'10.0.0.1'},{port:5432},{name:'zzsh_test_order_other'},{user:receipt.migrationRole},{target:'remote'}])assert.throws(()=>createLocalDistributionScope({...config,database:{...config.database,...patch}} as AppConfig,receipt));
 for(const patch of [{database:'zzsh_test_order_other'},{resourceOid:0},{resourceOid:893390},{resourceOid:1.5},{owner:'other'},{marker:'other'},{runtimeRole:'zzsh'},{migrationRole:'zzsh'}])assert.throws(()=>createLocalDistributionScope(config,{...receipt,...patch}));
 for(const patch of [{testOperationsEnabled:false},{secureCookies:true},{apiOrigin:'https://api.example.com'},{userOrigin:'http://127.0.0.1:3100'},{adminOrigin:'http://127.0.0.1:4301'}])assert.throws(()=>assertLocalDistributionAssembly(binding(),{...assembly,...patch}));
 assert.throws(()=>assertLocalDistributionAssembly({kind:'LOCAL_CONTROLLED_DISTRIBUTION'},assembly));
});
test('default old exact tuples remain admitted; new missing binding stays UNKNOWN or rejects',async()=>{
 for(const [name,oid,prefix,marker] of [['zzsh_test_m2_auth_auth_compat',820148,'zzsh_m2_auth_compat_','zzsh:m2-auth-test:v1'],['zzsh_test_m2_auth_auth_compat_ui',833000,'zzsh_m2_auth_compat_ui_','zzsh:m2-auth-test:v1'],['zzsh_test_order_personal_finance',869754,'zzsh_order_personal_finance_','zzsh:order-reservation-test:v1']] as const){for(const suffix of ['m','r'])assert.equal((await readActiveDistributionPolicyInTransaction(probe({identity:{name,oid,role:prefix+suffix,marker}}).c)).knowledge,'KNOWN');}
 const p=probe();assert.equal((await readRegistrationDistributionPolicyInTransaction(p.c)).reason,'DISTRIBUTION_RESOURCE_NOT_ADMITTED');await assert.rejects(readActiveDistributionPolicyInTransaction(p.c));
});
test('bound live identity and schema fail closed without fallback to old resource list',async()=>{
 for(const identity of [{name:'other'},{oid:999},{role:'zzsh'},{marker:'other'},{complete:false}])await assert.rejects(readRegistrationDistributionPolicyInTransaction(probe({identity}).c,binding()));
 for(const shape of [{owner:'other'},{rolsuper:true},{rolbypassrls:true},{complete:false}])await assert.rejects(readRegistrationDistributionPolicyInTransaction(probe({shape}).c,binding()));
 await assert.rejects(readActiveDistributionPolicyInTransaction(probe().c,false,{kind:'LOCAL_CONTROLLED_DISTRIBUTION'}));
 for(const role of [receipt.runtimeRole,receipt.migrationRole])assert.equal((await readActiveDistributionPolicyInTransaction(probe({identity:{role}}).c,true,binding())).knowledge,'KNOWN');
});
test('formal configure precedes registration; participant is ELIGIBLE and bound to the resulting policy',async()=>{
 const p=probe({policy:false}),scope=binding();const configured=await configureDistributionPolicy(p.pool,actor,{expectedRevision:'0',config:policyConfig,reason:'Local controlled acceptance'},'policy_once',scope);
 assert.equal(configured.status,200);const created=await initializeNewDistributionRegistration(p.c,{userId:'self',requestId:'req_registration'},scope);assert.equal(created.eligibility,'ELIGIBLE');assert.ok(created.policyVersion?.startsWith('distribution_policy_'));assert.equal(p.participants.get('self').policy_version_id,created.policyVersion);
 const read=await readMyInvitations(p.pool,actor,scope);assert.equal(read.policyVersion,created.policyVersion);assert.equal(read.participant.eligibility,'ELIGIBLE');
 const bound=await bindMyDistributionLeader(p.pool,actor,{code:'FX_PARENT',policyVersion:created.policyVersion,expectedParticipantRevision:'1'},'leader_once',scope);assert.equal(bound.status,200);
 assert(p.seen.some(x=>x.sql.startsWith('INSERT INTO zzsh_order.invitation_relation')));
});
test('configuration absent never promotes UNKNOWN, and previous registration cannot be repaired by replay',async()=>{
 const p=probe({policy:false});const r=await initializeNewDistributionRegistration(p.c,{userId:'self',requestId:'req_unknown'},binding());assert.equal(r.knowledge,'KNOWN');assert.equal(r.eligibility,'UNKNOWN');assert.equal(r.policyVersion,null);
 await assert.rejects(initializeNewDistributionRegistration(probe({previous:true}).c,{userId:'self',requestId:'req_replay'},binding()));
});
test('scope adds no permissions and does not accept policy or invitation subject overrides',async()=>{
 const denied=probe({permissions:[]});await assert.rejects(configureDistributionPolicy(denied.pool,actor,{expectedRevision:'0',config:policyConfig,reason:'Local controlled acceptance'},'policy_denied',binding()),e=>(e as {status:number}).status===403);assert(!denied.seen.some(x=>/^INSERT|^UPDATE|^DELETE/.test(x.sql)));
 await assert.rejects(configureDistributionPolicy(probe().pool,actor,{expectedRevision:'0',config:{...policyConfig,scope:'PRODUCTION'},reason:'Bad policy'},'policy_bad',binding()));
 await assert.rejects(bindMyDistributionLeader(probe().pool,actor,{code:'FX_PARENT',policyVersion:'policy_test',expectedParticipantRevision:'1',userId:'other'},'wrong_subject',binding()));
});
test('real auth assembly rejects wrong origins before initialization or any pool query',async()=>{
 let queries=0;await assert.rejects(mountAuthHandlers({} as INestApplication,{...assembly,apiOrigin:'http://127.0.0.1:3102',userSecret:'x'.repeat(40),adminSecret:'y'.repeat(40),pool:{query:async()=>{queries++;throw Error('must not query');}} as unknown as Pool,distributionScope:binding()}));assert.equal(queries,0);
});
test('actual policy/invitation route mounts pass the same explicit scope and retain Origin refusal',async()=>{
 const p=probe(),handlers=new Map<string,Function>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(path:string,fn:Function)=>handlers.set(path,fn)})})} as unknown as INestApplication;
 const session=async()=>({user:{id:'self',twoFactorEnabled:true},session:{id:'test-session'}}),options={...assembly,pool:p.pool,adminAuth:{api:{getSession:session}},userAuth:{api:{getSession:session}},distributionScope:binding()} as unknown as AuthSecurityOptions&{distributionScope:LocalDistributionScope};
 mountDistributionPolicyRoutes(app,options);mountInvitationRoutes(app,options);
 for(const [path,origin] of [['/api/v1/admin/distribution/policy',assembly.adminOrigin],['/api/v1/users/me/distribution',assembly.userOrigin]]){
  for(const denied of [false,true]){let status=0,body:any;const response:any={setHeader(){return this;},status(n:number){status=n;return this;},json(b:unknown){body=b;}};
   await handlers.get(path!)!({method:'GET',originalUrl:path,headers:{origin:denied?'http://127.0.0.1:4999':origin,'x-request-id':'req_route_scope'}},response);assert.equal(status,denied?403:200);if(!denied)assert.equal(body.policyKnowledge??body.knowledge,'KNOWN');
  }
 }
});
