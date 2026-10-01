import { adminRequest, AdminApiError, type SessionSnapshot, type UserDirectoryItem, type UserDirectoryDetail, type UserOrderItem, type UserRentalAccountItem, type UserAuditEventItem } from '../../api';

export const PERMISSION = { orders: 'order.read', resources: 'supply.rental_account.read', support: 'im.support.read', audit: 'admin.audit.read' } as const;
export type Domain = keyof typeof PERMISSION;
export type Part<T> = { state: 'ready'; data: T; count?: number; current?: number; nextCursor?: string | null } | { state: 'denied'; permission: string };
export type Filters = { q: string; status: string; from: string; to: string; identity: string; age: string; source: string; sort: string };
export const EMPTY_FILTERS: Filters = { q: '', status: '', from: '', to: '', identity: '', age: '', source: '', sort: 'created' };
export const PHONE_LIKE = /(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/;
export const STATUS_LABEL: Record<string,string> = { ACTIVE: '正常', RESTRICTED: '受限', DEACTIVATED: '已停用', CANCELLED: '已注销', UNKNOWN: '未知' };
export const FILTER_VALUE_LABEL:Record<string,string>={VERIFIED:'已实名',UNVERIFIED:'未实名',REJECTED:'未通过',ADULT:'成年',MINOR:'未成年',UNKNOWN:'未知',MIGRATED:'旧平台用户',LOCAL:'未关联旧平台来源'};
export const safeFilters = (filters: Filters) => Object.fromEntries(Object.entries(filters).filter(([key,value])=>value && !(key==='q' && PHONE_LIKE.test(value))));
export const sourceLabel = (provider?: string) => provider==='legacy_mysql_restore' ? '旧平台用户' : provider==='none' ? '未关联旧平台来源' : '来源未知';
export const identityLabel = (value: string) => ({ VERIFIED:'已实名',UNVERIFIED:'未实名',REJECTED:'未通过',UNKNOWN:'未知' }[value] ?? '未知');
export const ageLabel = (value: string) => ({ ADULT:'成年',MINOR:'未成年',UNKNOWN:'未知' }[value] ?? '未知');
export type Order = UserOrderItem;
export type Resource = UserRentalAccountItem;
export type Audit = UserAuditEventItem;
export type User = { id: string; name: string; username: string; displayUsername: string; phoneMasked: string; emailMasked: string | null; legacyId?: string; provider?: string; status: string; identity: string; age: string; verifiedAt: string | null; createdAt: string; updatedAt: string; trace?: UserDirectoryDetail['source']; orders: Part<Order[]>; resources: Part<Resource[]>; match?:string };

function project(row: UserDirectoryItem | UserDirectoryDetail, has:(permission:string)=>boolean): User {
  const detail = 'identity' in row ? row : null;
  return { id:row.userId,name:row.name,username:row.username??'',displayUsername:row.displayUsername??'',phoneMasked:row.maskedPhone??'未绑定手机号',emailMasked:detail?.maskedEmail??null,
    legacyId:row.source.legacyId,provider:row.source.kind==='MIGRATED'?'legacy_mysql_restore':row.source.kind==='LOCAL'?'none':undefined,status:row.accountStatus,
    identity:identityLabel(detail?.identity.status??row.identityStatus),age:ageLabel(detail?.identity.ageStatus??row.ageStatus),verifiedAt:detail?.identity.verifiedAt??null,createdAt:row.createdAt,updatedAt:row.updatedAt,trace:detail?.source,
    orders:has(PERMISSION.orders)&&row.orderSummary?.state==='ready'?{state:'ready',data:[],current:row.orderSummary.currentCount}:{state:'denied',permission:PERMISSION.orders},
    resources:has(PERMISSION.resources)&&row.resourceSummary.state==='ready'?{state:'ready',data:[],count:row.resourceSummary.count}:{state:'denied',permission:PERMISSION.resources} };
}

type Page<T> = { items: T[]; nextCursor: string | null; limit: number };
type Snapshot = Extract<SessionSnapshot,{authenticated:true}>;
export class UserDirectoryBff {
  readonly scroll = new Map<string,number>();
  private readonly cursors = new Map<string,{ previous?:string;offset:number }>();
  private readonly users = new Map<string,User>();
  constructor(readonly snapshot: Snapshot) {}
  has(permission: string) { return this.snapshot.permissions.includes(permission); }
  private async request<T>(path:string, signal:AbortSignal, body?:Record<string,unknown>) {
    try { const result=await adminRequest<T>(path,body,undefined,{},signal); if(signal.aborted) throw new DOMException('Request cancelled','AbortError'); return result; }
    catch(error) { if(signal.aborted) throw new DOMException('Request cancelled','AbortError'); throw error; }
  }
  async list(filters:Filters,cursor:string|undefined,signal:AbortSignal) {
    const params=new URLSearchParams({limit:'20'});
    const phone=PHONE_LIKE.test(filters.q);
    if(filters.q) params.set(phone?'phone':'q',filters.q);
    if(phone&&!this.has('user.phone.lookup')) throw new AdminApiError(403,'FORBIDDEN');
    for(const [key,value] of Object.entries({accountStatus:filters.status,identityStatus:filters.identity,ageStatus:filters.age,source:filters.source})) if(value) params.set(key,value);
    for(const [key,value,end] of [['registeredFrom',filters.from,false],['registeredTo',filters.to,true]] as const) if(value) {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('注册日期无效');
      const calendar=new Date(`${value}T00:00:00Z`);
      if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==value) throw new Error('注册日期无效');
      const date=new Date(`${value}T${end?'23:59:59.999':'00:00:00'}+08:00`);
      if(!Number.isFinite(date.getTime())) throw new Error('注册日期无效'); params.set(key,date.toISOString());
    }
    if(filters.from&&filters.to&&filters.from>filters.to) throw new Error('注册起始日期不能晚于结束日期');
    if(cursor) params.set('cursor',cursor);
    const data=await this.request<Page<UserDirectoryItem>>(phone?'/users/lookup':`/users?${params}`,signal,phone?Object.fromEntries(params):undefined);
    if(!Array.isArray(data.items)) throw new Error('用户目录响应格式无效');
    const rows=data.items.map(row=>{const user=project(row,permission=>this.has(permission));const q=filters.q.toLowerCase();return {...user,...(q?{match:phone?'手机号精确匹配':user.id.toLowerCase()===q?'用户 ID':user.legacyId===q?'旧平台 ID':user.name.toLowerCase().includes(q)?'用户昵称':'用户名 / 展示用户名'}:{})};}); rows.forEach(user=>this.users.set(user.id,user));
    const previous=cursor?this.cursors.get(cursor):undefined;
    if(data.nextCursor&&!phone) this.cursors.set(data.nextCursor,{previous:cursor,offset:(previous?.offset??0)+data.items.length});
    return { rows,offset:previous?.offset??0,next:data.nextCursor??undefined,previous:cursor?(previous?.previous??null):undefined };
  }
  async detail(id:string,signal:AbortSignal,_drawer=false) {
    const data=await this.request<{user:UserDirectoryDetail}>(`/users/${encodeURIComponent(id)}`,signal);
    if(!data.user||data.user.userId!==id) throw new Error('用户详情响应格式无效');
    const user=project(data.user,permission=>this.has(permission)); this.users.set(id,user); return user;
  }
  async section(id:string,domain:Domain,signal:AbortSignal,cursor?:string,filters:Record<string,string>={}):Promise<Part<Order[]|Resource[]|Audit[]|string[]>> {
    if(!this.has(PERMISSION[domain])) return {state:'denied',permission:PERMISSION[domain]};
    if(domain==='support') return {state:'ready',data:[]};
    const segment=domain==='resources'?'rental-accounts':domain==='audit'?'audit-events':'orders';
    const params=new URLSearchParams({...filters,limit:'20'}); if(cursor)params.set('cursor',cursor);
    let data:Page<Order|Resource|Audit>;
    try {data=await this.request<Page<Order|Resource|Audit>>(`/users/${encodeURIComponent(id)}/${segment}?${params}`,signal);}
    catch(failure){if(failure instanceof AdminApiError&&failure.status===403)return {state:'denied',permission:PERMISSION[domain]};throw failure;}
    if(!Array.isArray(data.items))throw new Error('关联业务响应格式无效');
    return {state:'ready',data:data.items as Order[]|Resource[]|Audit[],nextCursor:data.nextCursor};
  }
  async restore(id:string,reason:string,password:string,totpCode:string,signal:AbortSignal) {
    await this.request('/security/users/restore',signal,{targetUserId:id,reason,password,totpCode});
  }
  user(id:string) { const user=this.users.get(id); if(!user)throw new Error('用户尚未读取');return user; }
}

// Preserve non-sensitive navigation context only while the same authenticated session owns it.
let current:{key:string;adapter:UserDirectoryBff}|undefined;
export function directoryAdapter(snapshot:Snapshot) {
  const key=JSON.stringify([snapshot.adminUserId,snapshot.session.id,snapshot.security.isBoss,[...snapshot.permissions].sort()]);
  if(current?.key!==key) current={key,adapter:new UserDirectoryBff(snapshot)};
  return {key,adapter:current.adapter};
}
