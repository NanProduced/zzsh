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

test('published summary is separate from archives and shared by list and detail without per-user requests',async()=>{
  const pool=new DirectorySqlFixture();Object.assign(pool.users[0]!,{resourceAccountCount:5,resourcePublishedCount:2});
  const list:any=await listUserDirectory(client(pool),viewer,{search:'林舟',limit:20});
  const detail:any=await readUserDirectoryDetail(client(pool),viewer,'user_normal');
  assert.deepEqual(list.items[0].resourceSummary,{state:'ready',count:5,publishedCount:2});
  assert.deepEqual(detail.resourceSummary,list.items[0].resourceSummary);
  for(const query of pool.queries.filter(q=>q.sql.includes('AS "resourcePublishedCount"'))){
    assert.match(query.sql,/count\(\*\) FILTER \(WHERE ra\.lifecycle='ACTIVE' AND EXISTS/);
    assert.match(query.sql,/pv\.id=ra\.current_version_id AND pv\.account_id=ra\.id/);
    assert.match(query.sql,/pp\.content_hash=pv\.content_hash/);
    assert.match(query.sql,/pv\.review_state='APPROVED' AND pp\.source='LEGACY_APPROVED'/);
    assert.doesNotMatch(query.sql,/ra\.owner_paused|ra\.staff_restricted|ra\.occupied/);
  }
  assert.equal(pool.queries.filter(q=>q.sql.includes('AS "resourcePublishedCount"')).length,2);
});

test('published drilldown uses the same effective publication tuple and preserves permission gates',async()=>{
  const pool=new DirectorySqlFixture();
  const result=await route('/api/v1/admin/users/user_normal/rental-accounts?publication=published',pool);
  assert.equal(result.status,200);assert.equal(result.body.items[0].publication.currentlyPublished,true);
  const sql=pool.queries.find(q=>q.sql.includes('FROM zzsh_supply.rental_account a'))!.sql;
  assert.match(sql,/AND a\.lifecycle='ACTIVE' AND EXISTS/);
  assert.match(sql,/pv\.id=a\.current_version_id AND pv\.account_id=a\.id/);
  assert.match(sql,/pp\.owner_user_id=a\.owner_user_id AND pp\.game_id=a\.game_id/);
  assert.equal((await route('/api/v1/admin/users/user_normal/rental-accounts?publication=rentable',pool)).status,400);
  pool.permissions=['user.directory.read'];
  assert.equal((await route('/api/v1/admin/users/user_normal/rental-accounts?publication=published',pool)).status,403);
});

test('published drilldown cursors cannot be reused for the full archive collection',async()=>{
  const pool=new DirectorySqlFixture(),query=pool.query.bind(pool);
  pool.query=async(sql,values=[])=>{
    const result=await query(sql,values);
    if(sql.includes('FROM zzsh_supply.rental_account a')&&result.rows.length)result.rows.push({...result.rows[0],id:'account_fixture_tail'});
    return result;
  };
  const first:any=await listUserRentalAccounts(client(pool),viewer,'user_normal',{limit:1,publication:'published'});
  assert.ok(first.nextCursor);
  await assert.rejects(listUserRentalAccounts(client(pool),viewer,'user_normal',{limit:1,cursor:first.nextCursor}),error=>(error as any).status===409);
});

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
  const sql=pool.queries.find(query=>query.sql.includes('FROM zzsh_supply.rental_account a'))!.sql;for(const predicate of ['admin_supply_scope','sgame."game_id" = a.game_id','p.content_hash=v.content_hash','p.rule_release_id=v.rule_release_id','p.owner_user_id=a.owner_user_id'])assert.ok(sql.includes(predicate));
  const history=pool.queries.filter(query=>query.sql.includes('FROM zzsh_supply.legacy_listing_read_snapshot h'));
  assert.equal(history.length,1);assert.deepEqual(history[0]!.values,[['account_fixture']]);
  assert.equal(data.items[0].historicalRead,null);
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
  assert.ok(pool.queries.at(-1)!.sql.includes('sgame."game_id" = o.game_id'));
});

test('audit retains existing Boss/self object scope and sensitive detail sanitation',async()=>{
  const pool=new DirectorySqlFixture();const self:any=await listUserAuditEvents(client(pool),viewer,'user_normal',{limit:20},sanitizeDetail);
  assert.equal(self.scope,undefined);assert.equal(self.items[0].details.phoneNumber,undefined);
  assert.ok(pool.queries.at(-1)!.sql.includes("e.actor_type = 'admin' AND e.actor_id"));
  const boss:any=await listUserAuditEvents(client(pool),{...viewer,isBoss:true},'user_normal',{limit:20},sanitizeDetail);assert.equal(boss.scope,undefined);assert.equal(pool.queries.at(-1)!.sql.includes("e.actor_type = 'admin' AND e.actor_id"),false);
});

test('directory permission does not grant supply/audit, while order core read is baseline',async()=>{
  const pool=new DirectorySqlFixture();pool.permissions=['user.directory.read','supply.review.read'];
  for(const section of ['rental-accounts','audit-events']) {const response=await route(`/api/v1/admin/users/user_normal/${section}`,pool);assert.equal(response.status,403);}
  assert.equal((await route('/api/v1/admin/users/user_normal/orders',pool)).status,200);
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

// PERF-READINESS-1: the migration-audit lateral used to sit below the LIMIT, so every page paid one
// audit lookup per stored user. These cases pin the bounded shape and the filters that must stay
// membership-deciding before the LIMIT.
test('default page bounds narrow keys before one batched latest-audit relation',async()=>{
  const pool=new DirectorySqlFixture();
  const data:any=await listUserDirectory(client(pool),viewer,{limit:20});
  assert.equal(pool.queries.length,2);
  const sql=pool.queries[1]!.sql;
  assert.ok(/WITH page AS MATERIALIZED/i.test(sql));
  assert.ok(sql.includes('LIMIT $'),'page query must carry the bound LIMIT');
  const pageEnd=sql.indexOf("migration AS MATERIALIZED");
  assert.notEqual(pageEnd,-1,'deferred shape must have an outer projection query');
  assert.equal(sql.slice(0,pageEnd).includes('zzsh_iam.audit_event'),false,'the page query must not consult the audit table');
  assert.ok(sql.slice(pageEnd).includes("e.details->>'legacyId'"),'the audit expansion stays available for the returned page');
  assert.equal(sql.slice(pageEnd).includes("outcome='SUCCESS'"),false,'default audit selection stays latest-fact regardless of outcome');
  assert.ok(sql.includes('ORDER BY u."createdAt" DESC, u.id DESC'));
  assert.equal(sql.includes('source_created_at'),false,'the default list does not compute an unused source date');
  const count=pool.queries[0]!.sql;
  assert.equal(count.includes('user_identity_state'),false,'the unfiltered total needs no identity join');
  assert.equal(sql.slice(0,pageEnd).includes('user_identity_state'),false,'identity state is joined only after the bound page');
  assert.equal(data.items.length,pool.users.length);
  assert.equal(new Set(data.items.map((row:any)=>row.userId)).size,data.items.length);
  assert.equal(data.items.find((row:any)=>row.userId==='user_legacy').source.legacyId,'88001');
  assert.equal(data.items.find((row:any)=>row.userId==='user_legacy').source.kind,'MIGRATED');
  assert.equal(data.items.find((row:any)=>row.userId==='user_normal').source.kind,'LOCAL');
  assert.equal(data.items.find((row:any)=>row.userId==='user_unknown').source.kind,'UNKNOWN');
  const short:any=await listUserDirectory(client(pool),viewer,{limit:1});
  assert.equal(short.items.length,1);assert.ok(short.nextCursor);
});

test('keyword, legacy-id and source filters keep migration-audit membership before the LIMIT',async()=>{
  const pool=new DirectorySqlFixture();
  for(const filter of [{search:'88001'},{legacyId:'88001'},{source:'LOCAL'},{source:'UNKNOWN'}] as const){
    await listUserDirectory(client(pool),viewer,{...filter,limit:20});
    const sql=pool.queries.at(-1)!.sql;
    assert.equal(/WITH page AS MATERIALIZED/i.test(sql),false,`${JSON.stringify(filter)} must decide membership before the page is bounded`);
    assert.ok(sql.includes('ORDER BY u."createdAt" DESC, u.id DESC'));
  }
  await listUserDirectory(client(pool),viewer,{legacyId:'88001',limit:20});
  assert.ok(pool.queries.at(-1)!.sql.includes('mig.legacy_id'),'the audit-derived legacy id stays a membership predicate');
  await listUserDirectory(client(pool),viewer,{search:'88001',limit:20});
  assert.ok(pool.queries.at(-1)!.sql.includes('mig.legacy_id'),'the keyword predicate still consults the audit-derived legacy id');
  const found:any=await listUserDirectory(client(pool),viewer,{legacyId:'88001',limit:20});
  assert.equal(found.items.length,pool.users.length);
});

test('migrated source decides membership from identity state and bounds audit display to the page',async()=>{
  const pool=new DirectorySqlFixture();
  const data:any=await listUserDirectory(client(pool),viewer,{source:'MIGRATED',limit:20});
  assert.deepEqual(data.items.map((row:any)=>row.userId),['user_legacy']);
  assert.equal(data.total,1);
  assert.equal(data.items[0].source.kind,'MIGRATED');
  assert.equal(data.items[0].source.legacyId,'88001','the page-bounded latest fact still supplies the displayed legacy id');
  const [count,page]=pool.queries;
  assert.ok(count!.sql.includes("s.provider='legacy_mysql_restore'"));
  assert.equal(count!.sql.includes('zzsh_iam.audit_event'),false,'provider-only membership needs no audit scan for the total');
  assert.match(page!.sql,/WITH page AS MATERIALIZED/i);
  assert.ok(page!.sql.indexOf('zzsh_iam.audit_event')>page!.sql.indexOf('migration AS MATERIALIZED'),'the audit read stays page-bounded');
  assert.ok(page!.sql.includes('JOIN page candidate ON candidate.id = e.object_id'));
  assert.ok(page!.sql.slice(0,page!.sql.indexOf('migration AS MATERIALIZED')).includes("s.provider='legacy_mysql_restore'"));
  pool.users.find(row=>row.id==='user_legacy')!.migrationLegacyId=null;
  const fallback:any=await listUserDirectory(client(pool),viewer,{source:'MIGRATED',limit:20});
  assert.equal(fallback.items[0].source.kind,'MIGRATED');
  assert.equal(fallback.items[0].source.legacyId,'88001','a newest fact without a legacy id still falls back to the bound provider reference');
});

test('source filter keeps the NULL test on the newest migration fact instead of an existence test',async()=>{
  const pool=new DirectorySqlFixture();
  await listUserDirectory(client(pool),viewer,{source:'LOCAL',limit:20});
  const sql=pool.queries.at(-1)!.sql;
  assert.ok(sql.includes('ORDER BY u."createdAt" DESC, u.id DESC'));
  // The three-state classification reads the latest migration fact through the batch relation and tests
  // its legacy id for NULL; an `EXISTS(...) IS NULL` form is always false and must never come back.
  assert.ok(sql.includes('SELECT DISTINCT ON (e.object_id)'),'the source filter reads one latest fact per user');
  assert.ok(sql.includes("s.user_id IS NOT NULL AND s.provider='none' AND mig.legacy_id IS NULL"),'LOCAL still means "newest migration fact carries no legacy id"');
  assert.equal(/EXISTS\s*\([\s\S]*?\)\s*IS NULL/i.test(sql),false,'no existence test may stand in for the nullable newest value');
  const local:any=await listUserDirectory(client(pool),viewer,{source:'LOCAL',limit:20});
  assert.deepEqual([...local.items.map((row:any)=>row.userId)].sort(),
    ['user_cancelled','user_dual','user_long','user_normal','user_restore','user_restricted']);
});

test('second page keeps the keyset bound inside the page query and does not repeat the first page',async()=>{
  const pool=new DirectorySqlFixture();
  const first:any=await listUserDirectory(client(pool),viewer,{limit:2});
  const second:any=await listUserDirectory(client(pool),viewer,{limit:2,cursor:first.nextCursor});
  assert.equal(pool.queries.length,4);
  const sql=pool.queries[3]!.sql;
  assert.ok(/WITH page AS MATERIALIZED/i.test(sql));
  const ids=[...first.items,...second.items].map((row:any)=>row.userId);
  assert.equal(new Set(ids).size,ids.length,'paging must not repeat a user');
  assert.deepEqual(second.items.map((row:any)=>row.userId),['user_restore','user_normal']);
});

test('filtered total covers every matching user before cursor and remains zero for legitimate empty results',async()=>{
  const pool=new DirectorySqlFixture();
  const first:any=await listUserDirectory(client(pool),viewer,{accountStatus:'ACTIVE',limit:1});
  const second:any=await listUserDirectory(client(pool),viewer,{accountStatus:'ACTIVE',limit:1,cursor:first.nextCursor});
  assert.equal(first.total,4);assert.equal(second.total,4);assert.equal(first.items.length,1);assert.equal(second.items.length,1);
  assert.notEqual(first.items[0].userId,second.items[0].userId);
  const counts=pool.queries.filter(query=>query.sql.includes('SELECT count(*)::int AS total FROM'));
  assert.equal(counts.length,2);assert.deepEqual(counts[0]!.values,['ACTIVE']);assert.deepEqual(counts[1]!.values,['ACTIVE']);
  assert.equal(counts.some(query=>query.sql.includes('LIMIT')||query.sql.includes('u.id <')||query.sql.includes('zzsh_iam.audit_event')),false);
  assert.ok(counts[0]!.sql.includes('user_identity_state'),'status membership still reads identity state before counting');
  const searched:any=await listUserDirectory(client(pool),viewer,{search:'林舟',limit:1});assert.equal(searched.total,1);
  assert.ok(pool.queries.at(-2)!.sql.includes('migration AS MATERIALIZED'));
  assert.deepEqual(pool.queries.at(-2)!.values,['林舟','%林舟%']);
  const empty:any=await listUserDirectory(client(pool),viewer,{accountStatus:'ACTIVE',registeredFrom:'2027-01-01T00:00:00Z',limit:20});
  assert.equal(empty.total,0);assert.deepEqual(empty.items,[]);assert.equal(empty.nextCursor,null);
});

test('relationship summaries split renter/owner while retaining aggregate and distinguish empty scope from zero',async()=>{
  const pool=new DirectorySqlFixture();pool.users[0]!.currentOrderCount=3;pool.users[0]!.renterCurrentOrderCount=1;pool.users[0]!.ownerCurrentOrderCount=2;
  const list:any=await listUserDirectory(client(pool),viewer,{search:'林舟',limit:20});
  assert.deepEqual(list.items[0].orderSummary,{state:'ready',currentCount:3,renterCurrentCount:1,ownerCurrentCount:2});
  const detail:any=await readUserDirectoryDetail(client(pool),viewer,'user_normal');assert.deepEqual(detail.orderSummary,list.items[0].orderSummary);
  const listSql=pool.queries.find(query=>query.sql.includes('current_orders.current_count'))!.sql;
  assert.ok(listSql.includes('count(*) FILTER (WHERE o.renter_user_id=u.id)'));assert.ok(listSql.includes('count(*) FILTER (WHERE o.owner_user_id=u.id)'));
  assert.ok(listSql.includes("o.status IN ('PENDING_PAYMENT','PAID')"));assert.ok(listSql.includes('sgame."game_id" = o.game_id'));
  const noScope:any=await listUserDirectory(client(pool),{...viewer,businessScopeUsable:false},{limit:20});
  assert.ok(noScope.total>0);for(const item of noScope.items){assert.deepEqual(item.orderSummary,{state:'denied',permission:'order.read',reason:'NO_GAME_SCOPE'});assert.deepEqual(item.resourceSummary,{state:'denied',permission:'supply.rental_account.read',reason:'NO_GAME_SCOPE'});}
  const noScopeDetail:any=await readUserDirectoryDetail(client(pool),{...viewer,businessScopeUsable:false},'user_normal');assert.equal(noScopeDetail.orderSummary.reason,'NO_GAME_SCOPE');
  const denied:any=await listUserDirectory(client(pool),{...viewer,orderRead:false,businessScopeUsable:false},{limit:20});assert.deepEqual(denied.items[0].orderSummary,{state:'denied',permission:'order.read'});
  pool.users[0]!.currentOrderCount=0;pool.users[0]!.renterCurrentOrderCount=0;pool.users[0]!.ownerCurrentOrderCount=0;
  const zero:any=await readUserDirectoryDetail(client(pool),viewer,'user_normal');assert.deepEqual(zero.orderSummary,{state:'ready',currentCount:0,renterCurrentCount:0,ownerCurrentCount:0});
});

test('route keeps directory visible without game grants while all-games remains usable and sections reject no scope',async()=>{
  const pool=new DirectorySqlFixture();pool.gameIds=[];
  const result=await route('/api/bff/admin/users',pool,'GET',undefined,true);
  assert.equal(result.status,200);assert.equal(result.body.total,pool.users.length);assert.equal(result.body.items[0].orderSummary.reason,'NO_GAME_SCOPE');
  assert.equal((await route('/api/v1/admin/users/user_normal/orders',pool)).status,403);
  assert.equal((await route('/api/v1/admin/users/user_normal/rental-accounts',pool)).status,403);
  pool.gameScopeMode='ALL_GAMES';const all=await route('/api/v1/admin/users',pool);assert.equal(all.status,200);assert.equal(all.body.items[0].orderSummary.state,'ready');assert.equal(all.body.items[0].orderSummary.reason,undefined);
});

test('current order filter covers pending and paid before pagination, binds role and rejects other values',async()=>{
  const pool=new DirectorySqlFixture();
  const first:any=await listUserOrders(client(pool),viewer,'user_dual',{status:'current',role:'renter',limit:1});
  assert.equal(first.items.length,1);assert.equal(first.items[0].status,'PAID');
  const allCurrent:any=await listUserOrders(client(pool),viewer,'user_dual',{status:'current',role:'renter',limit:20});
  assert.deepEqual(new Set(allCurrent.items.map((item:any)=>item.status)),new Set(['PENDING_PAYMENT','PAID']));
  const sql=pool.queries.at(-1)!.sql;assert.ok(sql.includes("o.status IN ('PENDING_PAYMENT','PAID')"));assert.ok(sql.includes('o.renter_user_id = $1'));
  assert.ok(sql.indexOf("o.status IN")<sql.indexOf('LIMIT $'));
  assert.equal((await route('/api/bff/admin/users/user_dual/orders?status=current&role=renter',pool,'GET',undefined,true)).status,200);
  assert.equal((await route('/api/v1/admin/users/user_dual/orders?status=working',pool)).status,400);
});

test('legacy current drilldown and role counters share the unified source without relaxing cursor or account privacy',async()=>{
  const pool=new DirectorySqlFixture(),baseQuery=pool.query.bind(pool);
  pool.query=async(sql:string,values:unknown[]=[])=>{
    if(sql.includes("to_regclass('zzsh_order.legacy_continuation_version')"))return {rows:[{ready:false}],rowCount:1};
    if(sql.startsWith('WITH all_orders AS')){
      pool.queries.push({sql,values});
      const rows=[3,1].map((status,index)=>{
        const id=`legacy_current_${index}`;
        return {id,sortAt:'2026-09-24T04:00:00.000000Z',origin:'LEGACY',role:'owner',record:{id,original_order_no:`OLD-${index}`,source_order_status:status,source_pay_status:status===1?0:1,due_amount_cents:'600',recorded_paid_amount_cents:status===1?'0':'600',deposit_amount_cents:'0',source_snapshot:{goods_money:'6.00',expend_pay_money:'0.00'},source_created_at:null,source_paid_at:null,source_cancelled_at:null,source_completed_at:null,owner_user_id:'user_normal',renter_user_id:'user_dual',owner_name:'Owner',renter_name:'Renter',account_id:'account_private',game_id:'delta',legacy_account_no:'A-PRIVATE'}};
      });
      return {rows,rowCount:rows.length};
    }
    return baseQuery(sql,values);
  };
  const scoped={...viewer,legacyRead:true,resourceRead:false};
  await listUserDirectory(client(pool),scoped,{limit:20});
  const summarySql=pool.queries.find(query=>query.sql.includes('current_orders.current_count'))!.sql;
  assert.ok(summarySql.includes('UNION ALL')&&summarySql.includes('zzsh_order.legacy_order_read_snapshot'));
  const page:any=await listUserOrders(client(pool),scoped,'user_normal',{role:'owner',status:'current',limit:1});
  assert.equal(page.items[0].status,'PAID');assert.equal(page.items[0].source.origin,'LEGACY');assert.equal('accountId' in page.items[0],false);assert.ok(page.nextCursor);
  const query=pool.queries.at(-1)!;assert.ok(query.sql.includes("x.status IN ('PENDING_PAYMENT','PAID')"));assert.ok(query.sql.includes('x.owner_user_id=$1'));assert.ok(query.sql.includes('sgame."game_id" = x.game_id'));
  const all:any=await listUserOrders(client(pool),scoped,'user_normal',{role:'owner',status:'current',limit:20});assert.deepEqual(all.items.map((item:any)=>item.status),['PAID','PENDING_PAYMENT']);
  for(const changed of [{role:'renter',status:'current'},{role:'owner',status:'PAID'}] as const)await assert.rejects(listUserOrders(client(pool),scoped,'user_normal',{...changed,limit:1,cursor:page.nextCursor}),{status:409});
});

test('numbered directory pages jump directly with complete metadata and expand only the selected keys',async()=>{
  const pool=new DirectorySqlFixture();
  const first=await route('/api/bff/admin/users?page=1&pageSize=3',pool,'GET',undefined,true);
  assert.equal(first.status,200);assert.equal(first.body.paginationMode,'page');assert.equal(first.body.page,1);assert.equal(first.body.pageSize,3);assert.equal(first.body.limit,3);
  assert.equal(first.body.total,pool.users.length);assert.equal(first.body.items.length,3);assert.equal(first.body.nextCursor,null);assert.match(first.body.contextKey,/^[0-9a-f]{64}$/);
  const jumped=await route(`/api/bff/admin/users?page=3&pageSize=3&contextKey=${first.body.contextKey}`,pool,'GET',undefined,true);
  assert.equal(jumped.status,200);assert.equal(jumped.body.page,3);assert.equal(jumped.body.total,pool.users.length);assert.equal(jumped.body.items.length,2);assert.equal(jumped.body.contextKey,first.body.contextKey);
  const expected=[...pool.users].sort((a,b)=>b.localCreatedAt.localeCompare(a.localCreatedAt)||b.id.localeCompare(a.id)).slice(6,9).map(row=>row.id);
  assert.deepEqual(jumped.body.items.map((row:any)=>row.userId),expected);
  const pages=pool.queries.filter(query=>query.sql.includes('FROM page selected'));
  assert.equal(pages.length,2,'jumping does not fetch intermediate pages');
  const query=pages[1]!;const offset=query.sql.match(/OFFSET \$(\d+)/),limit=query.sql.match(/LIMIT \$(\d+)/);
  assert.ok(offset&&limit);assert.equal(query.values[Number(offset[1])-1],6);assert.equal(query.values[Number(limit[1])-1],3);
  assert.ok(query.sql.indexOf('OFFSET $')<query.sql.indexOf('FROM page selected'),'offset stays in the narrow-key page before domain projections');
  assert.ok(query.sql.includes('ORDER BY u."createdAt" DESC, u.id DESC'));
  assert.equal(pool.queries.filter(query=>query.sql.includes('SELECT count(*)::int AS total FROM')).some(query=>query.sql.includes('OFFSET')||query.sql.includes('LIMIT')),false);
  assert.ok(pool.queries.some(query=>query.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});

test('numbered directory totals keep the same filters, defaults and original projection semantics',async()=>{
  const pool=new DirectorySqlFixture();pool.scenario='long';
  const normal=await route('/api/v1/admin/users?page=1',pool);assert.equal(normal.status,200);assert.equal(normal.body.pageSize,20);assert.equal(normal.body.items.length,20);assert.equal(normal.body.total,38);
  const large=await route('/api/v1/admin/users?page=1&pageSize=100',pool);assert.equal(large.status,200);assert.equal(large.body.items.length,38);
  pool.scenario='normal';
  const first=await route('/api/v1/admin/users?page=1&pageSize=1&accountStatus=ACTIVE',pool);assert.equal(first.body.total,4);
  const second=await route(`/api/v1/admin/users?page=2&pageSize=1&accountStatus=ACTIVE&contextKey=${first.body.contextKey}`,pool);assert.equal(second.status,200);assert.equal(second.body.total,4);assert.notEqual(first.body.items[0].userId,second.body.items[0].userId);
  const found=await route('/api/v1/admin/users?page=1&pageSize=10&q=%E6%9E%97%E8%88%9F',pool);assert.equal(found.status,200);assert.equal(found.body.total,1);assert.equal(found.body.items[0].name,'林舟');
  assert.ok(found.body.items[0].orderSummary);assert.ok(found.body.items[0].resourceSummary);assert.ok(found.body.items[0].membershipSummary);assert.ok(found.body.items[0].creditSummary);
  const count=pool.queries.filter(query=>query.sql.includes('SELECT count(*)::int AS total FROM')).at(-1)!;assert.deepEqual(count.values,['林舟','%林舟%']);
});

test('numbered query context binds filters, capacity, principal and effective authorisation, but not page number',async()=>{
  const pool=new DirectorySqlFixture();const query={limit:2,page:1};
  const first:any=await listUserDirectory(client(pool),viewer,query);assert.match(first.contextKey,/^[0-9a-f]{64}$/);
  const next={limit:2,page:2,contextKey:first.contextKey};
  const page:any=await listUserDirectory(client(pool),viewer,next);assert.equal(page.contextKey,first.contextKey);assert.equal(page.page,2);
  for(const changed of [{...viewer,adminId:'other'},{...viewer,authorizationKey:'scope-two'},{...viewer,resourceRead:false},{...viewer,phoneLookup:false}]){
    const before=pool.queries.length;await assert.rejects(listUserDirectory(client(pool),changed,next),{status:409});assert.equal(pool.queries.length,before,'stale contexts fail before directory SQL');
  }
  for(const changed of [{...next,limit:3},{...next,search:'other'}])await assert.rejects(listUserDirectory(client(pool),viewer,changed),{status:409});
  const routed=await route('/api/v1/admin/users?page=1&pageSize=2',pool);
  pool.gameIds=['delta','other'];assert.equal((await route(`/api/v1/admin/users?page=2&pageSize=2&contextKey=${routed.body.contextKey}`,pool)).status,409);
  pool.gameIds=['delta'];pool.permissions=pool.permissions.filter(code=>code!=='admin.audit.read');assert.equal((await route(`/api/v1/admin/users?page=2&pageSize=2&contextKey=${routed.body.contextKey}`,pool)).status,409);
});

test('numbered empty and out-of-range pages retain truthful counts without moving the request to another page',async()=>{
  const pool=new DirectorySqlFixture();
  const beyond=await route('/api/v1/admin/users?page=99&pageSize=10',pool);assert.equal(beyond.status,200);assert.equal(beyond.body.page,99);assert.equal(beyond.body.total,8);assert.deepEqual(beyond.body.items,[]);assert.equal(beyond.body.nextCursor,null);
  pool.scenario='empty';const empty=await route('/api/v1/admin/users?page=1&pageSize=10',pool);assert.equal(empty.status,200);assert.equal(empty.body.total,0);assert.deepEqual(empty.body.items,[]);assert.equal(empty.body.page,1);
  pool.fault='list';const failed=await route('/api/v1/admin/users?page=1&pageSize=10',pool);assert.equal(failed.status,500);assert.equal(failed.body.total,undefined);assert.equal(failed.body.items,undefined);
});

test('numbered pagination rejects invalid, repeated and mixed parameters rather than silently using the legacy first page',async()=>{
  const invalid=['page=0','page=-1','page=1.5','page=1e2','page=NaN','page=','page=%202','page=1000001','page=1&page=2','page=1&pageSize=0','page=1&pageSize=101','page=1&pageSize=1.5','page=1&pageSize=','page=1&pageSize=1e1','page=1&pageSize=10&pageSize=20','pageSize=20','contextKey='+'a'.repeat(64),'page=1&contextKey=invalid','page=1&contextKey='+'a'.repeat(64)+'&contextKey='+'a'.repeat(64),'page=1&limit=20','page=1&cursor=invalid','page=1&unexpected=value'];
  for(const query of invalid){const pool=new DirectorySqlFixture();const result=await route('/api/v1/admin/users?'+query,pool);assert.equal(result.status,400,query);assert.equal(result.body.error.code,'INVALID_ARGUMENT',query);assert.equal(pool.queries.some(item=>item.sql.includes('FROM zzsh_auth_user."user" u')),false,query);}
  for(const path of ['/api/v1/admin/users/user_normal/orders?page=1','/api/v1/admin/users/user_normal?page=1','/api/v1/admin/users/resource-accounts/account_fixture?page=1'])assert.equal((await route(path,new DirectorySqlFixture())).status,400,path);
});

test('numbered phone lookup stays POST/body-only and separately authorised through the BFF',async()=>{
  const pool=new DirectorySqlFixture();pool.permissions=['user.directory.read'];
  const body={phone:'18800001101',page:'1',pageSize:'10'};
  assert.equal((await route('/api/bff/admin/users/lookup',pool,'POST',body,true)).status,403);
  pool.permissions.push('user.phone.lookup');const result=await route('/api/bff/admin/users/lookup',pool,'POST',body,true);
  assert.equal(result.status,200);assert.equal(result.body.paginationMode,'page');assert.equal(result.body.total,1);assert.equal(result.body.items[0].userId,'user_normal');assert.equal(JSON.stringify(result.body).includes(body.phone),false);
  assert.equal((await route('/api/v1/admin/users?phone=18800001101&page=1',pool)).status,400);
  assert.equal((await route('/api/v1/admin/users/lookup?page=1',pool,'POST',body)).status,400,'body/query pagination cannot overwrite each other');
  assert.equal((await route('/api/v1/admin/users/lookup',pool,'POST',{...body,page:1})).status,400,'lookup fields keep their documented string shape');
  pool.permissions=[];assert.equal((await route('/api/bff/admin/users?page=1&pageSize=10',pool,'GET',undefined,true)).status,403);
  assert.equal((await route('/api/bff/admin/users?page=1&pageSize=10',pool,'GET',undefined,true,'https://untrusted.invalid')).status,403);
});

test('existing cursor clients retain their response shape and cannot mix page contexts into cursor navigation',async()=>{
  const pool=new DirectorySqlFixture();const first=await route('/api/v1/admin/users?limit=2',pool);
  assert.equal(first.status,200);assert.equal(first.body.paginationMode,undefined);assert.equal(first.body.page,undefined);assert.equal(first.body.contextKey,undefined);assert.ok(first.body.nextCursor);
  const next=await route('/api/v1/admin/users?limit=2&cursor='+encodeURIComponent(first.body.nextCursor),pool);assert.equal(next.status,200);assert.notEqual(next.body.items[0].userId,first.body.items[0].userId);
  const numbered=await route('/api/v1/admin/users?page=1&pageSize=2',pool);
  assert.equal((await route('/api/v1/admin/users?limit=2&contextKey='+numbered.body.contextKey,pool)).status,400);
});

test('original registration projection uses the SQL fact while old clients retain local creation semantics',async()=>{
  const pool=new DirectorySqlFixture();
  for(const row of pool.users)Object.assign(row,{originalRegisteredAt:row.id==='user_legacy'?'2019-01-01T00:00:00.000000Z':row.provider==='none'?row.localCreatedAt:null});
  const data:any=await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',limit:20});
  const legacy=data.items.find((row:any)=>row.userId==='user_legacy');
  assert.equal(legacy.registeredAt,'2019-01-01T00:00:00.000000Z');assert.equal(legacy.registeredAtSource,'LEGACY');
  assert.notEqual(legacy.registeredAt,legacy.localCreatedAt);
  const unknown=data.items.find((row:any)=>row.userId==='user_unknown');assert.equal(unknown.registeredAt,null);assert.equal(unknown.registeredAtSource,'UNKNOWN');
  const detail:any=await readUserDirectoryDetail(client(pool),{...viewer,auditRead:false},'user_legacy','ORIGINAL');
  assert.equal(detail.registeredAt,legacy.registeredAt);assert.equal(detail.source.sourceDigest,undefined);assert.equal(detail.source.sourceCreatedAt,undefined);
  const old:any=await listUserDirectory(client(pool),viewer,{limit:20});
  assert.equal(old.items.find((row:any)=>row.userId==='user_legacy').registeredAtSource,'LOCAL');
});

test('original registration filters and sort precede pagination and count uses identical validated fact relation',async()=>{
  const pool=new DirectorySqlFixture();
  await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',sort:'registered_asc',registeredFrom:'2019-01-01T00:00:00Z',registeredBefore:'2020-01-01T00:00:00Z',page:1,limit:20});
  const queries=pool.queries.filter(q=>q.sql.includes('FROM zzsh_auth_user."user" u'));
  assert.equal(queries.length,1);
  for(const {sql} of queries){
    assert.match(sql,/e\.outcome='SUCCESS'/);assert.match(sql,/pg_input_is_valid\(mig\.source_created_at,'timestamp with time zone'\)/);
    assert.match(sql,/s\.provider_reference='la_user:' \|\| mig\.legacy_id/);
    assert.match(sql,/registration\.registered_at >= \$\d+::timestamptz/);assert.match(sql,/registration\.registered_at < \$\d+::timestamptz/);
    assert.doesNotMatch(sql,/COALESCE\(mig\.source_created_at|COALESCE\(registration\.registered_at/);
  }
  assert.match(queries[0]!.sql,/ORDER BY registration\.registered_at ASC NULLS LAST, registration\.id COLLATE "C" DESC[\s\S]*?LIMIT/);
});

test('original bounded count and page share one validated date materialisation with explicit aggregate order',async()=>{
  const pool=new DirectorySqlFixture();
  await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',registeredFrom:'2019-01-01T00:00:00Z',page:1,limit:20});
  const queries=pool.queries.filter(q=>q.sql.includes('FROM zzsh_auth_user."user" u'));
  assert.equal(queries.length,1);
  const sql=queries[0]!.sql;
  assert.equal(sql.split('registration_dates AS MATERIALIZED').length,2);
  assert.match(sql,/SELECT count\(\*\)::int AS total FROM registration_dates registration/);
  assert.match(sql,/registration\.created_at AS "createdAt"/);
  assert.match(sql,/registration\.migration_legacy_id/);
  assert.match(sql,/json_agg\(to_jsonb\(p\)-'__directory_sort_at' ORDER BY p\.__directory_sort_at DESC NULLS LAST,p\.id COLLATE "C" DESC\)/);
  assert.equal(sql.includes('migration_source_created_at'),false,'the list never returned this unused column');
});

test('original time mode and direction bind both page context and nullable keyset cursors',async()=>{
  const pool=new DirectorySqlFixture();for(const row of pool.users)Object.assign(row,{originalRegisteredAt:null});
  const page:any=await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',limit:1,page:1});
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:1,page:2,contextKey:page.contextKey}),error=>(error as any).status===409);
  await assert.rejects(listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',sort:'registered_asc',limit:1,page:2,contextKey:page.contextKey}),error=>(error as any).status===409);
  const first:any=await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',limit:1});
  assert.equal(JSON.parse(Buffer.from(first.nextCursor,'base64url').toString()).c,null);
  await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',limit:1,cursor:first.nextCursor});
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:1,cursor:first.nextCursor}),error=>(error as any).status===409);
});

test('original registration route rejects ambiguous modes, ranges and duplicates',async()=>{
  for(const query of ['registrationTime=LOCAL','registrationTime=ORIGINAL&registrationTime=ORIGINAL','sort=registered_desc','registrationTime=ORIGINAL&sort=created','registeredBefore=2020-01-01T00:00:00Z','registrationTime=ORIGINAL&registeredTo=2020-01-01T00:00:00Z&registeredBefore=2020-01-02T00:00:00Z','registrationTime=ORIGINAL&registeredFrom=2020-01-02T00:00:00Z&registeredBefore=2020-01-01T00:00:00Z','registrationTime=ORIGINAL&registeredBefore=2020-02-31T00:00:00Z']){
    const pool=new DirectorySqlFixture();const result=await route('/api/v1/admin/users?'+query,pool);assert.equal(result.status,400,query);
    assert.equal(pool.queries.some(q=>q.sql.includes('FROM zzsh_auth_user."user" u')),false,query);
  }
});

test('original registration uses the same body-only phone lookup projection through BFF',async()=>{
  const pool=new DirectorySqlFixture();Object.assign(pool.users[0]!,{originalRegisteredAt:pool.users[0]!.localCreatedAt});
  const body={phone:'18800001101',registrationTime:'ORIGINAL',sort:'registered_desc',page:'1',pageSize:'10'};
  const lookup=await route('/api/bff/admin/users/lookup',pool,'POST',body,true);assert.equal(lookup.status,200);
  const detail=await route('/api/bff/admin/users/user_normal?registrationTime=ORIGINAL',pool,'GET',undefined,true);assert.equal(detail.status,200);
  assert.equal(lookup.body.items[0].registeredAt,detail.body.user.registeredAt);assert.equal(lookup.body.items[0].registeredAtSource,detail.body.user.registeredAtSource);
  assert.equal((await route('/api/v1/admin/users/lookup?registrationTime=ORIGINAL',pool,'POST',body)).status,400);
  pool.permissions=['user.directory.read'];assert.equal((await route('/api/bff/admin/users/lookup',pool,'POST',body,true)).status,403);
});

test('original sort total reuses date facts without reloading provenance after the page',async()=>{
  const pool=new DirectorySqlFixture();await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',page:1,limit:20});
  const queries=pool.queries.filter(q=>q.sql.includes('FROM zzsh_auth_user."user" u'));
  assert.equal(queries.length,1);
  assert.match(queries[0]!.sql,/migration AS NOT MATERIALIZED/);
  assert.match(queries[0]!.sql,/registration_dates AS MATERIALIZED/);
  assert.doesNotMatch(queries[0]!.sql.split('FROM page selected')[1]!,/JOIN migration/);
  assert.match(queries[0]!.sql,/selected\.migration_legacy_id AS "migrationLegacyId"/);
});

test('original numbered tail retains total when the selected page is empty',async()=>{
  const pool=new DirectorySqlFixture(),data:any=await listUserDirectory(client(pool),viewer,{registrationTime:'ORIGINAL',page:100,limit:20});
  assert.equal(data.total,pool.users.length);assert.deepEqual(data.items,[]);assert.equal(data.nextCursor,null);
  assert.equal(pool.queries.filter(q=>q.sql.includes('AS directory_rows')).length,1);
});

test('original registration disables JIT only inside its bounded read transaction',async()=>{
  const original=new DirectorySqlFixture(),retired:(boolean|undefined)[]=[];original.release=(destroy?:boolean)=>{retired.push(destroy);};assert.equal((await route('/api/v1/admin/users?registrationTime=ORIGINAL&page=1&pageSize=10',original)).status,200);
  assert(original.queries.some(q=>q.sql==="SELECT set_config('jit','off',true)"));
  assert(original.queries.some(q=>q.sql==='ROLLBACK'));
  assert.deepEqual(retired,[true]);
  const old=new DirectorySqlFixture(),reused:(boolean|undefined)[]=[];old.release=(destroy?:boolean)=>{reused.push(destroy);};assert.equal((await route('/api/v1/admin/users?page=1&pageSize=10',old)).status,200);
  assert(!old.queries.some(q=>q.sql.includes("set_config('jit'")));
  assert.deepEqual(reused,[false]);
});

test('directory projection uses its assigned pool while authentication stays on the shared pool',async()=>{
  const shared=new DirectorySqlFixture(),directory=new DirectorySqlFixture(),options=directorySecurityFixture(shared),output=capture();
  options.directoryReadPool=directory as unknown as import('pg').Pool;
  await handleUserDirectoryAdmin({method:'GET',url:'/api/v1/admin/users?page=1&pageSize=20',headers:{origin:'http://127.0.0.1:4291'}},output.response,options);
  assert.equal(output.result().status,200);
  assert(directory.queries.some(q=>q.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert(directory.queries.some(q=>q.sql.includes('FROM page selected')));
  assert(!shared.queries.some(q=>q.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});

test('the internal risk flag and the wallet summary travel with their own permissions',async()=>{
  const pool=new DirectorySqlFixture();
  const plain:any=await listUserDirectory(client(pool),viewer,{limit:20});
  assert.equal(plain.items[0].riskFlag,false,'a user without a flag is not flagged');
  assert.deepEqual(plain.items[0].walletSummary,{state:'denied',permission:'user.wallet.read'},'no wallet capability means no amount at all');

  Object.assign(pool.users[0]!,{riskFlag:true});
  pool.walletCoverage=[{userId:'user_normal',origin:'LEGACY_MYSQL',sourceKind:'LEGACY_MYSQL',openingAmount:'0',coveredCount:0}];
  pool.walletLedger=[{userId:'user_normal',availableCents:'12345'}];
  const granted:any=await listUserDirectory(client(pool),{...viewer,walletRead:true} as AdminDirectoryViewer,{limit:20});
  const flaggedRow=granted.items.find((item:any)=>item.userId==='user_normal');
  assert.equal(flaggedRow.riskFlag,true);
  assert.equal(flaggedRow.walletSummary.state,'ready');
  assert.equal(flaggedRow.walletSummary.amountCents,'12345','the exact integer cents are carried, not a float');
  const unknown=granted.items.find((item:any)=>item.userId!=='user_normal');
  assert.equal(unknown.walletSummary.state,'unknown','a user without admitted coverage is unknown, not zero');

  // 精确大整数：金额是整分字符串，不经过浮点。
  pool.walletLedger=[{userId:'user_normal',availableCents:'9007199254740993'}];
  const exact:any=await listUserDirectory(client(pool),{...viewer,walletRead:true} as AdminDirectoryViewer,{limit:20});
  const exactRow=exact.items.find((item:any)=>item.userId==='user_normal');
  assert.equal(exactRow.walletSummary.amountCents,'9007199254740993','a large exact amount is carried as an exact integer string');
});

test('a balance sort needs the wallet capability and aggregates the whole candidate set before paging',async()=>{
  const pool=new DirectorySqlFixture();
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,registrationTime:'ORIGINAL',sort:'balance_desc'}),error=>(error as any).status===403);
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,registrationTime:'ORIGINAL',sort:'balance_asc'}),error=>(error as any).status===403);
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,sort:'balance_desc'}),error=>(error as any).status===400,'a sort without the original registration time is invalid');
  pool.walletCoverage=[];pool.walletLedger=[];
  await listUserDirectory(client(pool),{...viewer,walletRead:true} as AdminDirectoryViewer,{limit:20,sort:'balance_desc',registrationTime:'ORIGINAL'});
  const sql=pool.queries.map(query=>query.sql).join('\n');
  assert.match(sql,/wallet_ledger/,'the balance aggregate is part of the candidate set');
  assert.match(sql,/wallet_coverage/,'an unadmitted coverage is not a zero balance');
  assert.match(sql,/ORDER BY registration\.sort_value DESC NULLS LAST/,'the sort is applied to the candidate set, not to one page');
});

test('the risk filter narrows the directory and the numeric sorts need their own capability',async()=>{
  const pool=new DirectorySqlFixture();
  Object.assign(pool.users[0]!,{riskFlag:true});
  const flagged:any=await listUserDirectory(client(pool),viewer,{limit:20,riskState:'FLAGGED'});
  assert.equal(flagged.items.length,1,'only the flagged user stays');
  const unflagged:any=await listUserDirectory(client(pool),viewer,{limit:20,riskState:'NOT_FLAGGED'});
  assert.equal(unflagged.items.some((item:any)=>item.userId==='user_normal'),false);
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,creditState:'KNOWN'}),error=>(error as any).status===403);
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,membershipTier:'GOLD'}),error=>(error as any).status===403);
  await assert.rejects(listUserDirectory(client(pool),viewer,{limit:20,entitlement:'FRIEND'}),error=>(error as any).status===403);
});

test('the new directory filters and sorts are validated by the route and reach the query',async()=>{
  const pool=new DirectorySqlFixture();
  for(const query of ['creditState=NOPE','riskState=NOPE','entitlement=NOPE','membershipTier=NOPE','sort=balance_sideways']){
    const result=await route(`/api/v1/admin/users?${query}`,pool);
    assert.equal(result.status,400,`${query} must be rejected instead of ignored`);
  }
  pool.walletCoverage=[];pool.walletLedger=[];
  pool.permissions=[...pool.permissions,'membership.growth.read.summary','credit.read'];
  const ok=await route('/api/v1/admin/users?registrationTime=ORIGINAL&sort=balance_desc&riskState=FLAGGED&creditState=KNOWN&entitlement=ANY&membershipTier=PENDING',pool);
  assert.equal(ok.status,200);
  const sql=pool.queries.map(query=>query.sql).join('\n');
  assert.match(sql,/user_risk_flag/);
  assert.match(sql,/zzsh_credit\.user_credit_state/);
  assert.match(sql,/zzsh_iam\.membership_entitlement/);
});
