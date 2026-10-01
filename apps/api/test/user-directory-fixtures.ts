// Offline SQL-boundary fixture. It records queries; it is not PostgreSQL execution evidence.
import type { AuthSecurityOptions } from '../src/auth/auth-security';
import { ADMIN_PERMISSION_CODES } from '../src/auth/admin-authorization';

const date='2026-09-24T04:00:00.000000Z';
export const fixtureUserRows = [
  {id:'user_normal',name:'林舟',phoneNumber:'+8618800001101',accountStatus:'ACTIVE',provider:'none'},
  {id:'user_dual',name:'沈禾',phoneNumber:null,accountStatus:'ACTIVE',provider:'none'},
  {id:'user_legacy',name:'周岚',phoneNumber:null,accountStatus:'ACTIVE',provider:'legacy_mysql_restore',migrationLegacyId:'88001',migrationSourceCreatedAt:'2019-01-01T00:00:00.000000Z'},
  {id:'user_unknown',name:'来源待核',phoneNumber:null,accountStatus:null,provider:null},
  {id:'user_restore',name:'顾远',phoneNumber:null,accountStatus:'DEACTIVATED',provider:'none',suspended:true},
  {id:'user_cancelled',name:'程野',phoneNumber:null,accountStatus:'CANCELLED',provider:'none',suspended:true},
  {id:'user_restricted',name:'陆青',phoneNumber:null,accountStatus:'ACTIVE',provider:'none',suspended:true},
  {id:'user_long',name:'长昵称样本_'+ 'Unicode用户'.repeat(14),phoneNumber:null,accountStatus:'ACTIVE',provider:'none'},
].map(row=>({image:null,username:`login_${row.id}`,displayUsername:`显示_${row.name}`,suspended:false,localCreatedAt:date,localUpdatedAt:date,identityStatus:'UNKNOWN',ageStatus:'UNKNOWN',providerReference:row.id==='user_legacy'?'la_user:88001':null,migrationLegacyId:null,migrationSourceCreatedAt:null,resourceAccountCount:1,currentOrderCount:1,email:null,phoneNumberVerified:false,identityVerifiedAt:null,migrationSourceUpdatedAt:null,migrationSourceSystem:'zzsh_restore',migrationSourceEntity:'la_user',migrationSourceDigest:'fixture-digest',migrationEvidenceRef:'fixture-only',migratedAt:date,...row}));

export const fixtureOrderRows=[
  {id:'order_paid',displayNo:'TEST-1001',status:'PAID',role:'renter',paidAt:null},
  {id:'order_complete',displayNo:'TEST-1002',status:'COMPLETED',role:'owner',paidAt:null},
  {id:'order_cancel',displayNo:'TEST-1003',status:'CANCELLED',role:'renter',paidAt:'2026-09-19T02:05:00.000000Z'},
].map(row=>({accountId:'account_fixture',accountDisplayNo:'资源账号01',title:'三角洲行动 · 隔离测试账号',gameId:'delta',rentalAmountCents:'6000',depositAmountCents:'10000',currency:'CNY',counterpartyName:'另一方样本',createdAt:date,holdUntil:date,cancelledAt:row.status==='CANCELLED'?date:null,cancelReason:row.status==='CANCELLED'?'支付后取消（测试）':null,expiredAwaitingCancel:false,...row}));

export class DirectorySqlFixture {
  actorId='admin-fixture';isBoss=false;
  permissions=[...ADMIN_PERMISSION_CODES] as string[];
  gameIds=['delta'];queries:{sql:string;values:unknown[]}[]=[];
  users=fixtureUserRows.map(row=>({...row}));
  scenario='normal';fault='';
  async connect(){return this;} release(){}
  async query(sql:string,values:unknown[]=[]):Promise<any> {
    this.queries.push({sql,values});
    const result=(rows:unknown[])=>({rows,rowCount:rows.length});
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return result([]);
    if(sql.includes('"zzsh_iam"."admin_security"'))return result([{status:'ACTIVE',isBoss:this.isBoss,passwordChangeRequired:false}]);
    if(sql.includes('"zzsh_auth_admin"."session"'))return result([{locked:false,twoFactorEnabled:true,pinConfigured:true,createdAt:date,expiresAt:'2027-01-01T00:00:00Z'}]);
    if(sql.includes('WITH role_permissions'))return result(this.permissions.map(permissionCode=>({permissionCode})));
    if(sql.startsWith('SELECT game_id AS'))return result(this.gameIds.map(gameId=>({gameId})));
    if(sql.includes('SELECT 1 FROM zzsh_auth_user'))return result(this.users.some(row=>row.id===values[0])?[{exists:1}]:[]);
    if(sql.includes('FROM zzsh_auth_user."user" u')) {
      if(sql.includes('WHERE u.id = $1')) {
        if(this.fault==='detail')throw new Error('Injected detail failure');
        return result(this.users.filter(row=>row.id===values[0]));
      }
      if(this.fault==='list')throw new Error('Injected list failure');
      let rows=this.scenario==='empty'?[]:[...this.users];
      if(this.scenario==='long')for(let index=1;index<=30;index++)rows.push({...this.users[0]!,id:`user_page_${String(index).padStart(2,'0')}`,name:`分页样本${index}`,phoneNumber:null});
      const like=values.find(value=>typeof value==='string'&&value.startsWith('%')) as string|undefined;
      if(like){const needle=like.slice(1,-1).replace(/\\([%_\\])/g,'$1').toLowerCase();rows=rows.filter(row=>[row.id,row.name,row.username,row.displayUsername,row.migrationLegacyId].some(value=>value?.toLowerCase().includes(needle)));}
      const parameter=(pattern:RegExp)=>{const match=sql.match(pattern);return match?values[Number(match[1])-1]:undefined;};
      const source=parameter(/\(CASE WHEN s.provider='[^']+'[\s\S]*?END\)=\$(\d+)/);
      if(source)rows=rows.filter(row=>(row.provider==='legacy_mysql_restore'?'MIGRATED':row.provider==='none'&&!row.migrationLegacyId?'LOCAL':'UNKNOWN')===source);
      const status=parameter(/\(CASE WHEN s.user_id IS NULL[\s\S]*?END\)=\$(\d+)/);
      if(status)rows=rows.filter(row=>(row.accountStatus===null?'UNKNOWN':['CANCELLED','DEACTIVATED'].includes(row.accountStatus)?row.accountStatus:row.suspended?'RESTRICTED':row.accountStatus)==status);
      const identity=parameter(/COALESCE\(s.identity_status,'UNKNOWN'\)=\$(\d+)/);if(identity)rows=rows.filter(row=>row.identityStatus===identity);
      const age=parameter(/COALESCE\(s.age_status,'UNKNOWN'\)=\$(\d+)/);if(age)rows=rows.filter(row=>row.ageStatus===age);
      const phone=parameter(/u\."phoneNumber" = \$(\d+)/);if(phone)rows=rows.filter(row=>row.phoneNumber===phone);
      const from=parameter(/u\."createdAt" >= \$(\d+)/);if(from)rows=rows.filter(row=>Date.parse(row.localCreatedAt)>=Date.parse(String(from)));
      const to=parameter(/u\."createdAt" <= \$(\d+)/);if(to)rows=rows.filter(row=>Date.parse(row.localCreatedAt)<=Date.parse(String(to)));
      const lastTime=values.at(-3);const lastId=values.at(-2);
      rows.sort((a,b)=>b.localCreatedAt.localeCompare(a.localCreatedAt)||b.id.localeCompare(a.id));
      if(lastTime)rows=rows.filter(row=>row.localCreatedAt<String(lastTime)||row.localCreatedAt===lastTime&&row.id<String(lastId));
      return result(rows.slice(0,Number(values.at(-1))).map(row=>({...row,resourceAccountCount:!this.isBoss&&!this.gameIds.includes('delta')?0:row.resourceAccountCount,currentOrderCount:!this.isBoss&&!this.gameIds.includes('delta')?0:row.currentOrderCount})));
    }
    if(sql.includes('FROM zzsh_supply.rental_account a')) {
      if(this.fault==='resources')throw new Error('Injected resource failure');
      if(this.scenario==='empty'||!this.gameIds.includes('delta')&&!this.isBoss)return result([]);
      return result([{id:'account_fixture',displayNo:'资源账号01',lifecycle:'ACTIVE',ownerPaused:false,staffRestricted:false,restrictionReason:null,legacyHold:'NONE',currentVersionId:'version_fixture',createdAt:date,gameId:'delta',gameCode:'delta',gameName:'三角洲行动',versionState:'PUBLISHED',publicationSource:'OWNER_DIRECT'}]);
    }
    if(sql.includes('FROM zzsh_order.rental_order o')) {
      if(this.fault==='orders')throw new Error('Injected order failure');
      if(this.scenario==='empty'||!this.gameIds.includes('delta')&&!this.isBoss)return result([]);
      let rows=[...fixtureOrderRows];
      if(sql.includes('AND o.renter_user_id = $1'))rows=rows.filter(row=>row.role==='renter');
      if(sql.includes('AND o.owner_user_id = $1'))rows=rows.filter(row=>row.role==='owner');
      const status=values.find(value=>['PAID','COMPLETED','CANCELLED','PENDING_PAYMENT'].includes(String(value)));if(status)rows=rows.filter(row=>row.status===status);
      return result(rows);
    }
    if(sql.includes('FROM zzsh_iam.audit_event e')) {
      if(this.fault==='audit')throw new Error('Injected audit failure');
      return result([{id:'audit_fixture',actorType:'admin',actorAdminUsername:'ZZ00001',actorAdminDisplayUsername:'ZZ00001',actorAdminName:'测试管理员',actorUserName:null,action:'user.account.restored',objectType:'user',objectId:values[0],outcome:'SUCCESS',reason:'测试原因',requestId:'fixture-request',occurredAt:date,details:{phoneNumber:'18800001101',sourceDigest:'fixture'}}]);
    }
    throw new Error('Unhandled fixture query');
  }
}

export function directorySecurityFixture(pool:DirectorySqlFixture):AuthSecurityOptions {
  const auth={api:{getSession:async()=>({user:{id:pool.actorId,name:'隔离测试管理员',username:'ZZ00001',displayUsername:'ZZ00001',twoFactorEnabled:true},session:{id:`session-${pool.actorId}`,userId:pool.actorId,locked:false}})}};
  return {pool,adminAuth:auth,userAuth:auth,apiOrigin:'http://127.0.0.1:4292',adminOrigin:'http://127.0.0.1:4291',userOrigin:'http://127.0.0.1:4290',rateLimitState:new Map(),securityVerificationBudget:{inFlight:0},testOperationsEnabled:false} as unknown as AuthSecurityOptions;
}
