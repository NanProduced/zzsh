import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {AppConfig} from '../src/config/config';
import {createApp} from '../src/app';
import {createRegisteredLocalNativeDistributionReadScope,assertLocalNativeDistributionWriteUnavailable,type RegisteredLocalNativeDistributionBinding} from '../src/finance/distribution-policy-store';
import {assertDistributionManagementAssembly,assertDistributionManagementResource,createProvisionedDistributionManagementResource,createRegisteredR06DistributionManagementPreview} from '../src/finance/distribution-management-resource';

// Synthetic identity: no connection or actual R06 value is read by this test.
const binding:RegisteredLocalNativeDistributionBinding={database:'zzsh_test_regression',resourceOid:210001,owner:'zzsh',ownerOid:210002,marker:'zzsh:regression-test:v1',
 migrationRole:'zzsh_regression_migration',migrationRoleOid:210003,runtimeRole:'zzsh_regression_runtime',runtimeRoleOid:210004,nonce:'a'.repeat(24)};
const origins={apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false,testOperationsEnabled:false};
const config={profile:'test',provider:'fake',host:'127.0.0.1',port:4232,testOperationsEnabled:false,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port:55432,name:binding.database,user:binding.runtimeRole,runtimeUser:binding.runtimeRole}} as AppConfig;
const swap={status:'COMMIT_ACK',commitAck:true,registrationAck:true,unlockAck:true,maintenanceClosed:true,stageOid:binding.resourceOid,targetIdentity:{database:binding.database,oid:binding.resourceOid,marker:binding.marker,nonce:binding.nonce,owner:binding.owner,ownerOid:binding.ownerOid,migrationRole:binding.migrationRole,migrationRoleOid:binding.migrationRoleOid,runtimeRole:binding.runtimeRole,runtimeRoleOid:binding.runtimeRoleOid,read_only:'on',rollbackAck:true,clientClosed:true}};
const swapProof=(value:unknown=swap)=>{const bytes=Buffer.from(JSON.stringify(value));return{bytes,sha256:createHash('sha256').update(bytes).digest('hex')};};
const read=()=>createRegisteredLocalNativeDistributionReadScope(config,binding,origins);
const preview=(scope=read())=>createRegisteredR06DistributionManagementPreview({enabled:true,config,binding,readScope:scope,origins,swapProof:swapProof()})!;

test('preview is off by default and cannot accept a different profile, R07 port, epoch or forged read scope',()=>{
 const scope=read();assert.equal(createRegisteredR06DistributionManagementPreview({config,binding,readScope:scope,origins,swapProof:swapProof()}),undefined);
 assert.equal(createRegisteredR06DistributionManagementPreview({enabled:false,config,binding,readScope:scope,origins,swapProof:swapProof()}),undefined);
 for(const patch of [{profile:'production'},{profile:'dev'},{provider:'real'},{testOperationsEnabled:true},{host:'0.0.0.0'},{port:4242}])
  assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config:{...config,...patch} as AppConfig,binding,readScope:scope,origins,swapProof:swapProof()}));
 for(const patch of [{target:'ecs-test'},{targetProfile:'production'},{host:'localhost'},{port:55433},{name:'r07'},{user:'other'},{runtimeUser:'other'}])
  assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config:{...config,database:{...config.database,...patch}} as AppConfig,binding,readScope:scope,origins,swapProof:swapProof()}));
 for(const patch of [{resourceOid:210099},{nonce:'b'.repeat(24)},{runtimeRoleOid:210099},{migrationRoleOid:210099},{ownerOid:210099},{runtimeRole:'other'},{marker:'other'}])
  assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config,binding:{...binding,...patch},readScope:scope,origins,swapProof:swapProof()}));
 assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config,binding,readScope:{...scope},origins,swapProof:swapProof()}));
 assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config,binding,readScope:scope,origins:{...origins,adminOrigin:'http://127.0.0.1:4241'},swapProof:swapProof()}));
 for(const proof of [{...swapProof(),sha256:'0'.repeat(64)},swapProof({...swap,commitAck:false}),swapProof({...swap,stageOid:210099}),swapProof({...swap,targetIdentity:{...swap.targetIdentity,oid:210099}})])
  assert.throws(()=>createRegisteredR06DistributionManagementPreview({enabled:true,config,binding,readScope:scope,origins,swapProof:proof}));
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{assert.throws(()=>preview(scope));}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

test('R06 preview is separate from original read capability and refuses real channels or test-operation assembly',()=>{
 const scope=read(),resource=preview(scope);assertDistributionManagementAssembly(resource,scope,origins);
 assert.throws(()=>assertLocalNativeDistributionWriteUnavailable(scope),/read only/);
 assert.throws(()=>assertDistributionManagementAssembly(resource,{...scope},origins));
 for(const key of ['distributionScope','distributionEarnings','joinpayCollection','joinpayRefund','joinpayWithdrawal','joinpayAccountRead','joinpayAccountObservation','localControlledPayments','localFinancialSandbox','nativeWithdrawalScope','distributionDue'])
  assert.throws(()=>assertDistributionManagementAssembly(resource,scope,{...origins,[key]:{}}),/READ_ONLY|PREVIEW/);
 for(const key of ['testOperationsEnabled','settlementRecordingEnabled'])assert.throws(()=>assertDistributionManagementAssembly(resource,scope,{...origins,[key]:true}),/READ_ONLY/);
 assert.throws(()=>assertDistributionManagementAssembly({...resource},scope,origins));
 const provisioned=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:'zzsh_dev_preview',user:'zzsh_dev_runtime',runtimeUser:'zzsh_dev_runtime'}} as AppConfig);
 assert.throws(()=>assertDistributionManagementAssembly(provisioned,scope,origins),/PREVIEW_REQUIRED/);
});

test('app refuses preview mixed with a real channel before opening a database or starting a listener',async()=>{
 const scope=read(),resource=preview(scope);let queries=0;
 await assert.rejects(createApp({auth:{...origins,distributionReadScope:scope,distributionManagement:resource,joinpayCollection:{},
  pool:{query:async()=>{queries++;throw Error('unexpected query');}}} as never} as never),/READ_ONLY/);
 assert.equal(queries,0);
});

function client(patch:{connection?:Record<string,unknown>;transaction?:string;identity?:Record<string,unknown>;shape?:Record<string,unknown>;unsafe?:string;installed?:boolean;version?:number;missingGrant?:string}={}){
 const calls:string[]=[];
 const safe={databaseName:binding.database,currentUser:binding.runtimeRole,owner:binding.owner,...Object.fromEntries(['isSuperuser','canCreateRole','canCreateDb','canReplicate','canBypassRls','canCreateDatabase','canCreateIamSchema','canCreateUserSchema','canCreateAdminSchema','canCreateSupplySchema','canCreateContentSchema','canCreateOrderSchema','canUpdateAudit','canDeleteAudit','canTruncateAudit'].map(key=>[key,key===patch.unsafe]))};
 const c={getTransactionStatus:()=>patch.transaction??'T',connectionParameters:{host:'127.0.0.1',port:55432,database:binding.database,user:binding.runtimeRole,...patch.connection},async query(sql:string){calls.push(sql);
  if(sql.startsWith('SELECT d.oid'))return{rows:[{oid:binding.resourceOid,name:binding.database,role:binding.runtimeRole,marker:binding.marker,nonce:binding.nonce,complete:true,...patch.identity}]};
  if(sql.includes('pg_get_userbyid(d.datdba) AS owner,d.datdba'))return{rows:[{owner:binding.owner,ownerOid:binding.ownerOid,roleOid:binding.runtimeRoleOid,migrationRoleOid:binding.migrationRoleOid,rolsuper:false,rolbypassrls:false,migrationSuper:false,migrationBypass:false,complete:true,...patch.shape}]};
  if(sql.includes('AS "databaseName"'))return{rows:[safe]};
  if(sql.includes('AS "ownsBusinessSchema"'))return{rows:[{ownsBusinessSchema:false,ownsBusinessRelation:false,hasPrivilegedMembership:false}]};
  if(sql.startsWith("SELECT to_regprocedure('zzsh_order.distribution_management_contract_version()')"))return{rows:[{ready:patch.installed!==false}]};
  if(sql==='SELECT zzsh_order.distribution_management_contract_version() AS version')return{rows:[{version:patch.version??1}]};
  if(sql.includes('AS audit_insert'))return{rows:[Object.fromEntries(['audit_insert','idempotency','policy_insert','head_update','participant_update','code_insert','code_update'].map(key=>[key,key!==patch.missingGrant]))]};
  throw Error('Unexpected synthetic query');
 }} as unknown as PoolClient;
 return{c,calls};
}

test('each preview transaction rechecks exact connection, epoch, roles, schema and runtime privileges',async()=>{
 const scope=read(),resource=preview(scope),ok=client();await assertDistributionManagementResource(ok.c,resource);
 assert.ok(ok.calls.every(sql=>!/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql)));
 const patches=[{connection:{host:'localhost'}},{connection:{port:55433}},{connection:{database:'other'}},{connection:{user:'other'}},{transaction:'I'},
  {identity:{oid:210099}},{identity:{nonce:'b'.repeat(24)}},{identity:{marker:'other'}},{identity:{name:'other'}},{identity:{role:'other'}},
  {shape:{ownerOid:210099}},{shape:{roleOid:210099}},{shape:{migrationRoleOid:210099}},{shape:{rolsuper:true}},{unsafe:'canDeleteAudit'},
  {installed:false},{version:2},{missingGrant:'code_update'}];
 for(const patch of patches)await assert.rejects(assertDistributionManagementResource(client(patch).c,resource),error=>(error as {status?:number}).status===503,JSON.stringify(patch));
 await assert.rejects(assertDistributionManagementResource(client().c,{...resource}),error=>(error as {status?:number}).status===503);
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{await assert.rejects(assertDistributionManagementResource(client().c,resource));}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});
