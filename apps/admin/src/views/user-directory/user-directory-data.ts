import { adminRequest, AdminApiError, type SessionSnapshot, type UserDirectoryItem, type UserDirectoryDetail, type UserOrderItem, type UserRentalAccountItem, type UserAuditEventItem } from '../../api';
import { financeRead, defaultFinanceFilters, type FinanceResponse } from '../admin-finance-api';

export const PERMISSION = {
  orders: 'order.read',
  resources: 'supply.rental_account.read',
  support: 'im.support.read',
  audit: 'admin.audit.read',
  credit: 'credit.read',
  creditDecide: 'credit.decide',
  growthSummary: 'membership.growth.read.summary',
  growthDetail: 'membership.growth.read.detail',
  finance: 'finance.read',
} as const;
export const CREDIT_GUARANTEE_PERMISSION = { read: 'credit.guarantee.read', manage: 'credit.guarantee.manage' } as const;
export type Domain = keyof typeof PERMISSION;
export type Part<T> = { state: 'ready'; data: T; count?: number; publishedCount?: number; current?: number; nextCursor?: string | null } | { state: 'denied'; permission: string; reason?: string };
/** The age filter is no longer offered: the server gate and the DTO stay, the operator surface drops it. */
export type Filters = { q: string; status: string; from: string; to: string; identity: string; source: string; sort: string };
export const EMPTY_FILTERS: Filters = { q: '', status: '', from: '', to: '', identity: '', source: '', sort: 'registered_desc' };
/** The directory always reads the server-declared original registration time; the local filing date is a different fact. */
export const REGISTRATION_TIME_ORIGINAL = 'ORIGINAL';
export const REGISTRATION_SORT = { desc: 'registered_desc', asc: 'registered_asc' } as const;
/** The registration sort the directory supports; the old `created` sort normalises into the default. */
export const normalizeRegistrationSort = (value: string | undefined) => value === REGISTRATION_SORT.asc ? REGISTRATION_SORT.asc : REGISTRATION_SORT.desc;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day. UTC midnight arithmetic on a date-only string keeps it free of browser timezone drift. */
const isCalendarDay = (value: string) => {
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
/** The day after the given calendar day, in the same plain YYYY-MM-DD shape. */
const nextCalendarDay = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
};
export const PHONE_LIKE = /(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/;
export const STATUS_LABEL: Record<string,string> = { ACTIVE: '正常', RESTRICTED: '受限', DEACTIVATED: '已停用', CANCELLED: '已注销', UNKNOWN: '未知' };
export const FILTER_VALUE_LABEL:Record<string,string>={VERIFIED:'已实名',UNVERIFIED:'未实名',REJECTED:'未通过',MIGRATED:'旧平台用户',LOCAL:'未关联旧平台来源'};
export const safeFilters = (filters: Filters) => Object.fromEntries(Object.entries(filters).filter(([key,value])=>value && !(key==='q' && PHONE_LIKE.test(value))));
export const sourceLabel = (provider?: string) => provider==='legacy_mysql_restore' ? '旧平台用户' : provider==='none' ? '未关联旧平台来源' : '来源未知';
export const identityLabel = (value: string) => ({ VERIFIED:'已实名',UNVERIFIED:'未实名',REJECTED:'未通过',UNKNOWN:'未知' }[value] ?? '未知');
export const ageLabel = (value: string) => ({ ADULT:'成年',MINOR:'未成年',UNKNOWN:'未知' }[value] ?? '未知');
export type Order = UserOrderItem;
export type Resource = UserRentalAccountItem;
export type Audit = UserAuditEventItem;
/** A count the server actually sent: only a non-negative safe integer is a known quantity. */
export const knownCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** Where the displayed registration time came from. A LOCAL alias is the local filing date, not the real registration date. */
export type RegisteredSource = 'LEGACY' | 'LOCAL' | 'UNKNOWN';
export type User = {
  id: string;
  name: string;
  username: string;
  displayUsername: string;
  phoneMasked: string;
  emailMasked: string | null;
  image: string | null;
  legacyId?: string;
  provider?: string;
  status: string;
  suspended: boolean;
  /** Raw server enum, so the semantic tone never depends on re-parsing a label. */
  identityStatus: string;
  identity: string;
  age: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Server-declared registration projection; the source decides whether it is a real registration date. */
  registeredAt: string | null;
  registeredAtSource: RegisteredSource;
  trace?: UserDirectoryDetail['source'];
  orders: Part<Order[]> & { current?: number; renterCurrent?: number; ownerCurrent?: number; reason?: string };
  resources: Part<Resource[]> & { count?: number; publishedCount?: number; reason?: string };
  membershipSummary?: UserDirectoryItem['membershipSummary'];
  creditSummary?: UserDirectoryItem['creditSummary'];
  match?: string;
};

function project(row: UserDirectoryItem | UserDirectoryDetail, has:(permission:string)=>boolean): User {
  const detail = 'identity' in row ? row : null;
  const orderSum = row.orderSummary;
  const resourceSum = row.resourceSummary;

  let ordersPart: User['orders'];
  if (!has(PERMISSION.orders)) {
    ordersPart = { state: 'denied', permission: PERMISSION.orders };
  } else if (orderSum?.state === 'denied') {
    ordersPart = { state: 'denied', permission: orderSum.permission, ...(orderSum.reason ? { reason: orderSum.reason } : {}) };
  } else {
    // Permitted but not (yet) served: ready with unknown quantities, never denied and never 0.
    ordersPart = {
      state: 'ready',
      data: [],
      current: knownCount(orderSum?.currentCount),
      renterCurrent: knownCount(orderSum?.renterCurrentCount),
      ownerCurrent: knownCount(orderSum?.ownerCurrentCount),
    };
  }

  let resourcesPart: User['resources'];
  if (!has(PERMISSION.resources)) {
    resourcesPart = { state: 'denied', permission: PERMISSION.resources };
  } else if (resourceSum?.state === 'denied') {
    resourcesPart = { state: 'denied', permission: resourceSum.permission, ...(resourceSum.reason ? { reason: resourceSum.reason } : {}) };
  } else {
    resourcesPart = {
      state: 'ready',
      data: [],
      count: knownCount(resourceSum?.count),
      publishedCount: knownCount(resourceSum?.publishedCount),
    };
  }

  return {
    id: row.userId,
    name: row.name,
    username: row.username ?? '',
    displayUsername: row.displayUsername ?? '',
    phoneMasked: row.maskedPhone ?? '未绑定手机号',
    emailMasked: detail?.maskedEmail ?? null,
    image: row.image ?? null,
    legacyId: row.source.legacyId,
    provider: row.source.kind === 'MIGRATED' ? 'legacy_mysql_restore' : row.source.kind === 'LOCAL' ? 'none' : undefined,
    status: row.accountStatus,
    suspended: row.suspended,
    identity: identityLabel(detail?.identity.status ?? row.identityStatus),
    identityStatus: detail?.identity.status ?? row.identityStatus,
    age: ageLabel(detail?.identity.ageStatus ?? row.ageStatus),
    verifiedAt: detail?.identity.verifiedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    registeredAt: row.registeredAt ?? null,
    registeredAtSource: row.registeredAtSource === 'LEGACY' ? 'LEGACY' : row.registeredAtSource === 'LOCAL' ? 'LOCAL' : 'UNKNOWN',
    trace: detail?.source,
    orders: ordersPart,
    resources: resourcesPart,
    membershipSummary: row.membershipSummary,
    creditSummary: row.creditSummary,
  };
}

export type UserListQueryOptions = {
  page?: number;
  pageSize?: number;
  cursor?: string;
  contextKey?: string;
};

export type UserDirectoryPageResult = {
  mode: 'page';
  rows: User[];
  page: number;
  pageSize: number;
  total: number;
  contextKey: string;
  capabilityNotice?: string;
};

export type UserDirectoryCursorResult = {
  mode: 'cursor';
  rows: User[];
  pageSize: number;
  loadedCount: number;
  total?: number;
  next?: string;
  previous?: string | null;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
  capabilityNotice?: string;
};

export type UserDirectoryListResult = UserDirectoryPageResult | UserDirectoryCursorResult;

/** Entitlement lifecycle states the server may report; only ACTIVE counts as currently in force. */
export type EntitlementStatus = 'ACTIVE' | 'PENDING' | 'APPROVED_PENDING_EXECUTION' | 'EXECUTED_PENDING_START' | 'EXPIRED' | 'REPLACED' | 'REVOKED';
export type MembershipGrowthEntitlement = {
  id: string;
  kind: 'FRIEND' | 'PRESTIGE';
  scopeKey: string;
  startsAtUtc: string;
  endsAtUtc: string;
  status: EntitlementStatus;
  label: string;
  depositWaived: boolean;
};
export type MembershipGrowthRead = {
  subjectId: string;
  /** DETAIL_ONLY means the read scope is limited to scoped contributions, not a summary of the whole subject. */
  authorizationState?: 'SUMMARY_AUTHORIZED' | 'DETAIL_ONLY' | string;
  growth?: {
    knowledge: 'KNOWN' | 'UNKNOWN';
    sourceState?: string;
    benefitsState?: string;
    normalTier?: string | null;
    effectiveTier?: string | null;
    blackGold?: string | null;
    grace?: { state: string; fromTier: string | null; droppedAt: string | null; until: string | null; gapPoints: string | null } | null;
    rollingPoints?: string | null;
    lifetimePoints?: string | null;
  };
  /** Absent means "not read"; an empty array means "read, and there are none". */
  entitlements?: MembershipGrowthEntitlement[];
  sourceSummary?: { contributionCount: number; pendingCount: number; excludedCount: number };
};

type Page<T> = { items: T[]; total?: number; nextCursor: string | null; limit: number };
type Snapshot = Extract<SessionSnapshot,{authenticated:true}>;
export class UserDirectoryBff {
  readonly scroll = new Map<string,number>();
  private readonly cursors = new Map<string,{ previous?:string;offset:number }>();
  private readonly users = new Map<string,User>();
  constructor(readonly snapshot: Snapshot) {}
  has(permission: string) { return this.snapshot.permissions.includes(permission); }
  private async request<T>(path:string, signal:AbortSignal, body?:Record<string,unknown>, extraHeaders:Record<string,string>={}) {
    try { const result=await adminRequest<T>(path,body,undefined,extraHeaders,signal); if(signal.aborted) throw new DOMException('Request cancelled','AbortError'); return result; }
    catch(error) { if(signal.aborted) throw new DOMException('Request cancelled','AbortError'); throw error; }
  }
  async list(filters:Filters,options:UserListQueryOptions|string|undefined,signal:AbortSignal): Promise<UserDirectoryListResult> {
    const opts: UserListQueryOptions = typeof options === 'string' ? { cursor: options } : options ?? { page: 1, pageSize: 20 };
    const phone = PHONE_LIKE.test(filters.q);
    if (phone && !this.has('user.phone.lookup')) throw new AdminApiError(403, 'FORBIDDEN');

    const isPageMode = opts.page !== undefined && opts.cursor === undefined;
    const pageNum = isPageMode ? opts.page : undefined;
    const pageSizeNum = opts.pageSize ?? 20;

    const buildFilterParams = () => {
      const p = new URLSearchParams();
      // R1: the directory always asks for the server-declared original registration time.
      p.set('registrationTime', REGISTRATION_TIME_ORIGINAL);
      p.set('sort', normalizeRegistrationSort(filters.sort));
      if (filters.q) p.set(phone ? 'phone' : 'q', filters.q);
      for (const [key, value] of Object.entries({
        accountStatus: filters.status,
        identityStatus: filters.identity,
        source: filters.source,
      })) {
        if (value) p.set(key, value);
      }
      // The range is inclusive of the end day; the server bound is exclusive, so the upper bound is the next day's zero hour.
      if (filters.from) {
        if (!isCalendarDay(filters.from)) throw new Error('注册日期无效');
        p.set('registeredFrom', `${filters.from}T00:00:00+08:00`);
      }
      if (filters.to) {
        if (!isCalendarDay(filters.to)) throw new Error('注册日期无效');
        p.set('registeredBefore', `${nextCalendarDay(filters.to)}T00:00:00+08:00`);
      }
      if (filters.from && filters.to && filters.from > filters.to)
        throw new Error('注册起始日期不能晚于结束日期');
      return p;
    };

    const projectRows = (items: UserDirectoryItem[]) => {
      const rows = items.map((row) => {
        const user = project(row, (permission) => this.has(permission));
        const q = filters.q.toLowerCase();
        return {
          ...user,
          ...(q
            ? {
                match: phone
                  ? '手机号精确匹配'
                  : user.id.toLowerCase() === q
                  ? '用户 ID'
                  : user.legacyId === q
                  ? '旧平台 ID'
                  : user.name.toLowerCase().includes(q)
                  ? '用户昵称'
                  : '用户名 / 展示用户名',
              }
            : {}),
        };
      });
      rows.forEach((user) => this.users.set(user.id, user));
      return rows;
    };

    const doRequest = async (currentContextKey?: string, overridePage?: number) => {
      const baseParams = buildFilterParams();
      if (isPageMode) {
        const targetPage = overridePage ?? pageNum!;
        baseParams.set('page', String(targetPage));
        baseParams.set('pageSize', String(pageSizeNum));
        if (currentContextKey) baseParams.set('contextKey', currentContextKey);
      } else {
        baseParams.set('limit', String(pageSizeNum));
        if (opts.cursor) baseParams.set('cursor', opts.cursor);
      }

      if (phone) {
        return this.request<any>('/users/lookup', signal, Object.fromEntries(baseParams));
      } else {
        return this.request<any>(`/users?${baseParams.toString()}`, signal);
      }
    };

    let data = await doRequest(opts.contextKey);
    const validCapacity = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100;
    if (data?.paginationMode !== undefined) {
      if (data.paginationMode !== 'page' || !Array.isArray(data.items) ||
          !Number.isSafeInteger(data.page) || data.page < 1 || data.page > 1_000_000 ||
          !validCapacity(data.pageSize) || data.items.length > data.pageSize ||
          knownCount(data.total) === undefined ||
          data.items.length > Math.max(0, data.total - (data.page - 1) * data.pageSize) ||
          typeof data.contextKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.contextKey) ||
          data.nextCursor !== null || data.limit !== data.pageSize) {
        throw new Error('用户目录响应格式无效');
      }
      return { mode: 'page', rows: projectRows(data.items), page: data.page, pageSize: data.pageSize, total: data.total, contextKey: data.contextKey };
    }

    const validateCursor = (value: any) => {
      if (!value || value.paginationMode !== undefined || !Array.isArray(value.items) ||
          !validCapacity(value.limit) || value.items.length > value.limit ||
          !(value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0))) {
        throw new Error('用户目录响应格式无效');
      }
    };
    validateCursor(data);
    // Old services can ignore page/pageSize and return their default first page.
    if (isPageMode && (pageNum !== 1 || data.limit !== pageSizeNum)) {
      const params = buildFilterParams();
      params.set('limit', String(pageSizeNum));
      data = await this.request<any>(phone ? '/users/lookup' : '/users?' + params.toString(), signal, phone ? Object.fromEntries(params) : undefined);
      validateCursor(data);
    }
    const rows = projectRows(data.items);
    const previous = opts.cursor ? this.cursors.get(opts.cursor) : undefined;
    if (data.nextCursor) {
      this.cursors.set(data.nextCursor, { previous: opts.cursor, offset: (previous?.offset ?? 0) + rows.length });
    }
    return {
      mode: 'cursor', rows, offset: previous?.offset ?? 0, loadedCount: rows.length,
      next: data.nextCursor ?? undefined,
      previous: opts.cursor ? previous?.previous ?? null : undefined,
      hasPrevious: opts.cursor !== undefined, hasNext: Boolean(data.nextCursor),
      total: knownCount(data.total), pageSize: data.limit,
      capabilityNotice: '当前服务暂未提供跳页能力',
    };
  }

  async detail(id:string,signal:AbortSignal,_drawer=false) {
    const data=await this.request<{user:UserDirectoryDetail}>(`/users/${encodeURIComponent(id)}?registrationTime=${REGISTRATION_TIME_ORIGINAL}`,signal);
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
  async credit(id:string,signal:AbortSignal) {
    if(!this.has(PERMISSION.credit)) throw new AdminApiError(403,'FORBIDDEN');
    return this.request<{credit:any;recoveryRequests:any[];guarantees:any[];transactions:any[]}>(`/credit/users/${encodeURIComponent(id)}`,signal);
  }
  hasCreditGuaranteeRead() { return this.has(CREDIT_GUARANTEE_PERMISSION.read); }
  hasCreditGuaranteeManage() { return this.has(CREDIT_GUARANTEE_PERMISSION.manage); }
  async creditDecide(path:string,body:Record<string,unknown>,signal:AbortSignal,idempotencyKey?:string) {
    if(!this.has(PERMISSION.creditDecide) && !(path.startsWith('guarantees/') && this.hasCreditGuaranteeManage())) throw new AdminApiError(403,'FORBIDDEN');
    return this.request<Record<string,unknown>>(`/credit/${path}`,signal,body,idempotencyKey?{'idempotency-key':idempotencyKey}:{});
  }
  async membershipGrowth(id:string,signal:AbortSignal) {
    if(!this.has(PERMISSION.growthSummary) && !this.has(PERMISSION.growthDetail) && !this.snapshot.security.isBoss) throw new AdminApiError(403,'FORBIDDEN');
    return this.request<MembershipGrowthRead>(`/users/${encodeURIComponent(id)}/membership-growth`,signal);
  }
  async finance(id:string,signal:AbortSignal) {
    if(!this.has(PERMISSION.finance) && !this.snapshot.security.isBoss) throw new AdminApiError(403,'FORBIDDEN');
    return financeRead(`subjects/${encodeURIComponent(id)}`, defaultFinanceFilters(false), signal);
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
