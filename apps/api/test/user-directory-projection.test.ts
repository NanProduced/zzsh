import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { listUserDirectory,readUserDirectoryDetail,listUserRentalAccounts,listUserOrders,listUserAuditEvents,projectUserAccountStatus,type AdminDirectoryViewer } from '../src/auth/user-directory';
import { handleUserDirectoryAdmin } from '../src/auth/user-directory-routes';
import { handleAdminBff, type AdminBffOptions } from '../src/bff/admin-bff';
import { sanitizeDetail } from '../src/auth/admin-audit';
import { DirectorySqlFixture,directorySecurityFixture } from './user-directory-fixtures';

const viewer:AdminDirectoryViewer={adminId:'admin-fixture',isBoss:false,phoneLookup:true,resourceRead:true,orderRead:true,auditRead:true,authorizationKey:'scope-one'};
const client=(pool:DirectorySqlFixture)=>pool as unknown as PoolClient;
function capture(){let status=200;let body:any;const headers:Record<string,unknown>={};const response={setHeader(name:string,value:unknown){headers[name]=value;return response;},status(value:number){status=value;return response;},json(value:unknown){body=value;}};return {response,result:()=>({status,body,headers})};}
async function route(path:string,pool:DirectorySqlFixture,method='GET',body?:unknown,bff=false,origin='http://127.0.0.1:4291'){
  const options=directorySecurityFixture(pool);const output=capture();
  const request={method,url:path,originalUrl:path,body,headers:{origin}};
  if(bff)await handleAdminBff(request,output.response,{adminOrigin:options.adminOrigin,apiOrigin:options.apiOrigin,adminSecurityOptions:options} as AdminBffOptions);
  else await handleUserDirectoryAdmin(request,output.response,options);
  return output.result();
}

test('management UNKNOWN and status priority preserve cancelled/deactivated before restriction',()=>{
  assert.equal(projectUserAccountStatus(null,true),'UNKNOWN');
  assert.equal(projectUserAccountStatus('CANCELLED',true),'CANCELLED');
  assert.equal(projectUserAccountStatus('DEACTIVATED',true),'DEACTIVATED');
  assert.equal(projectUserAccountStatus('ACTIVE',true),'RESTRICTED');
  assert.equal(projectUserAccountStatus('ACTIVE',false),'ACTIVE');
  assert.equal(projectUserAccountStatus('UNMAPPED',false),'UNKNOWN');
});

test('name and all identifiers use bound/escaped predicates; canonical creation drives range and cursor',async()=>{
  const pool=new DirectorySqlFixture();
  const data:any=await listUserDirectory(client(pool),viewer,{search:'林舟',registeredFrom:'2026-01-01T00:00:00Z',registeredTo:'2026-12-31T23:59:59Z',limit:20});
  assert.equal(data.items[0].name,'林舟');
  const query=pool.queries.at(-1)!;
  for(const field of ['u.name ILIKE','u.username ILIKE','u."displayUsername" ILIKE','u.id=','mig.legacy_id='])assert.ok(query.sql.includes(field));
  assert.ok(query.sql.includes('u."createdAt" >=')&&query.sql.includes('u."createdAt" <='));
  assert.equal(query.sql.includes('COALESCE(mig.source_created_at'),false);
  assert.ok(query.sql.includes('ORDER BY u."createdAt" DESC, u.id DESC'));
  await listUserDirectory(client(pool),viewer,{identifier:'%_\\',limit:20});
  assert.ok(pool.queries.at(-1)!.values.includes('%\\%\\_\\\\%'));
});

test('list has one unified subject and strict source three states; activities explicitly not connected',async()=>{
  const pool=new DirectorySqlFixture();const data:any=await listUserDirectory(client(pool),viewer,{limit:20});
  const legacy=data.items.find((row:any)=>row.userId==='user_legacy');
  assert.equal(legacy.createdAt,legacy.registeredAt);assert.equal(legacy.registeredAtSource,'LOCAL');assert.ok(legacy.createdAt.startsWith('2026-'));
  assert.equal(legacy.source.kind,'MIGRATED');assert.equal(legacy.source.legacyId,'88001');
  assert.equal(data.items.find((row:any)=>row.userId==='user_normal').source.kind,'LOCAL');
  assert.equal(data.items.find((row:any)=>row.userId==='user_unknown').source.kind,'UNKNOWN');
  assert.equal(new Set(data.items.map((row:any)=>row.userId)).size,data.items.length);
  assert.equal(data.items.some((row:any)=>'customerRole' in row||'roles' in row||'relation' in row),false);
  assert.equal(legacy.lastBusinessActivity.state,'not_connected');
});

test('resource/order metadata is omitted when each domain permission is absent',async()=>{
  const pool=new DirectorySqlFixture();const data:any=await listUserDirectory(client(pool),{...viewer,resourceRead:false,orderRead:false},{limit:20});
  for(const row of data.items){assert.deepEqual(row.resourceSummary,{state:'denied',permission:'supply.rental_account.read'});assert.deepEqual(row.orderSummary,{state:'denied',permission:'order.read'});assert.equal('resourceAccountCount' in row,false);}
  assert.equal(JSON.stringify(data).includes('account_fixture'),false);
  assert.equal(pool.queries.at(-1)!.values[2],false);assert.equal(pool.queries.at(-1)!.values[3],false);
  const denied=new DirectorySqlFixture();await assert.rejects(listUserRentalAccounts(client(denied),{...viewer,resourceRead:false},'user_normal',{limit:20}),{status:403});assert.equal(denied.queries.length,0);
  await assert.rejects(listUserOrders(client(denied),{...viewer,orderRead:false},'user_normal',{limit:20}),{status:403});assert.equal(denied.queries.length,0);
});

test('cursor binds effective permission/game signature, identity, filters and canonical keyset',async()=>{
  const pool=new DirectorySqlFixture();const first:any=await listUserDirectory(client(pool),viewer,{limit:1});assert.ok(first.nextCursor);
  const token=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());assert.deepEqual(Object.keys(token).sort(),['c','f','i']);
  assert.ok(String(token.c).startsWith('2026-'));
  for(const changed of [{...viewer,adminId:'other'},{...viewer,authorizationKey:'scope-two'},{...viewer,resourceRead:false},{...viewer,phoneLookup:false}])await assert.rejects(listUserDirectory(client(pool),changed,{limit:1,cursor:first.nextCursor}),{status:409});
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:1,identifier:'other',cursor:first.nextCursor}),{status:409});
  await listUserDirectory(client(pool),viewer,{limit:1,cursor:first.nextCursor});
});

test('technical trace is audit-authorized and does not change canonical dates or expose membership',async()=>{
  const pool=new DirectorySqlFixture();const denied:any=await readUserDirectoryDetail(client(pool),{...viewer,auditRead:false},'user_legacy');
  assert.equal(denied.source.sourceDigest,undefined);assert.equal(denied.source.sourceCreatedAt,undefined);assert.equal(denied.membership,undefined);
  const allowed:any=await readUserDirectoryDetail(client(pool),{...viewer,isBoss:true},'user_legacy');assert.ok(allowed.createdAt.startsWith('2026-'));assert.ok(allowed.source.sourceCreatedAt.startsWith('2019-'));
  assert.ok(pool.queries.at(-1)!.sql.includes("e.actor_type='admin' AND e.actor_id=$3"));
  assert.equal(allowed.updatedAt,allowed.localUpdatedAt);
});

test('resources reuse effective publication facts and scope; no invented publication state',async()=>{
  const pool=new DirectorySqlFixture();const data:any=await listUserRentalAccounts(client(pool),viewer,'user_normal',{limit:20});
  assert.equal(data.items[0].publication.versionPublished,true);assert.equal(data.items[0].publication.source,'OWNER_DIRECT');
  const sql=pool.queries.at(-1)!.sql;for(const predicate of ['admin_supply_scope','sc.game_id = a.game_id','p.content_hash=v.content_hash','p.rule_release_id=v.rule_release_id','p.owner_user_id=a.owner_user_id'])assert.ok(sql.includes(predicate));
  pool.gameIds=[];const empty:any=await listUserRentalAccounts(client(pool),viewer,'user_normal',{limit:20});assert.deepEqual(empty.items,[]);
});

test('order snapshots retain paid cancellation and missing paid timestamps; internal resource IDs are independently protected',async()=>{
  const pool=new DirectorySqlFixture();const data:any=await listUserOrders(client(pool),{...viewer,resourceRead:false},'user_dual',{limit:20});
  assert.ok(data.items.find((row:any)=>row.status==='CANCELLED').paidAt);
  for(const status of ['PAID','COMPLETED'])assert.equal(data.items.find((row:any)=>row.status===status).paidAt,null);
  assert.equal(data.items.some((row:any)=>'accountId' in row||'accountDisplayNo' in row),false);
  assert.equal(data.items[0].amounts.totalDue.amount,'160.00');assert.equal(data.items[0].amounts.totalDue.unit,'yuan');
  assert.deepEqual(new Set(data.items.map((row:any)=>row.role)),new Set(['renter','owner']));
  assert.ok(pool.queries.at(-1)!.sql.includes('(o.renter_user_id = $1 OR o.owner_user_id = $1)'));
  assert.ok(pool.queries.at(-1)!.sql.includes('sc.game_id = o.game_id'));
});

test('audit retains existing Boss/self object scope and sensitive detail sanitation',async()=>{
  const pool=new DirectorySqlFixture();const self:any=await listUserAuditEvents(client(pool),viewer,'user_normal',{limit:20},sanitizeDetail);
  assert.equal(self.scope,undefined);assert.equal(self.items[0].details.phoneNumber,undefined);
  assert.ok(pool.queries.at(-1)!.sql.includes("e.actor_type = 'admin' AND e.actor_id"));
  const boss:any=await listUserAuditEvents(client(pool),{...viewer,isBoss:true},'user_normal',{limit:20},sanitizeDetail);assert.equal(boss.scope,undefined);assert.equal(pool.queries.at(-1)!.sql.includes("e.actor_type = 'admin' AND e.actor_id"),false);
});

test('routes fail before domain queries; directory permission never grants supply or order',async()=>{
  const pool=new DirectorySqlFixture();pool.permissions=['user.directory.read','supply.review.read'];
  for(const section of ['rental-accounts','orders','audit-events']) {const response=await route(`/api/v1/admin/users/user_normal/${section}`,pool);assert.equal(response.status,403);}
  assert.equal(pool.queries.some(row=>row.sql.includes('SELECT 1 FROM zzsh_auth_user')),false);
  const list=await route('/api/v1/admin/users',pool);assert.equal(list.status,200);assert.equal(list.body.items[0].resourceSummary.state,'denied');
});

test('phone lookup is read-only POST/body, independently authorized, mirrored by same-origin BFF',async()=>{
  const pool=new DirectorySqlFixture();
  const leaked=await route('/api/v1/admin/users?phone=18800001101',pool);assert.equal(leaked.status,400);
  pool.permissions=['user.directory.read'];assert.equal((await route('/api/v1/admin/users/lookup',pool,'POST',{phone:'18800001101'})).status,403);
  pool.permissions.push('user.phone.lookup');const response=await route('/api/bff/admin/users/lookup',pool,'POST',{phone:'18800001101'},true);assert.equal(response.status,200);assert.equal(response.body.items[0].userId,'user_normal');
  assert.equal(JSON.stringify(response.body).includes('18800001101'),false);
  assert.equal((await route('/api/bff/admin/users',pool,'POST',{},true)).status,404);
  assert.equal((await route('/api/v1/admin/users/lookup',pool,'POST',{phone:'18800001101',password:'invalid-field'})).status,400);
});

test('canonical range, enum and unsupported activity sort are rejected without fake results',async()=>{
  const pool=new DirectorySqlFixture();
  for(const query of ['registeredFrom=2026-10-02T00:00:00Z&registeredTo=2026-10-01T00:00:00Z','registeredFrom=2026-02-30T00:00:00Z','accountStatus=SUSPENDED','sort=activity','ageStatus=GUESSED'])assert.equal((await route(`/api/v1/admin/users?${query}`,pool)).status,400);
  assert.equal((await route('/api/v1/admin/users?q=%E6%9E%97%E8%88%9F',pool)).body.items[0].name,'林舟');
});

test('actual route cursor changes with current game grants and effective permissions',async()=>{
  const pool=new DirectorySqlFixture();const first=await route('/api/v1/admin/users?limit=1',pool);assert.equal(first.status,200);assert.ok(first.body.nextCursor);
  pool.gameIds=['delta','other'];assert.equal((await route(`/api/v1/admin/users?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,pool)).status,409);
  pool.gameIds=['delta'];pool.permissions=pool.permissions.filter(code=>code!=='admin.audit.read');assert.equal((await route(`/api/v1/admin/users?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,pool)).status,409);
});

test('anonymous and foreign-origin requests cannot obtain directory facts',async()=>{
  const pool=new DirectorySqlFixture();const options=directorySecurityFixture(pool);options.adminAuth.api.getSession=async()=>null;
  const output=capture();await handleUserDirectoryAdmin({method:'GET',url:'/api/v1/admin/users',headers:{}},output.response,options);
  assert.equal(output.result().status,401);assert.equal(pool.queries.length,0);
  assert.equal((await route('/api/bff/admin/users',pool,'GET',undefined,true,'https://untrusted.invalid')).status,403);
});
