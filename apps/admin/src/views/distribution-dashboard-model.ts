import { AdminApiError, adminRequest, type SessionSnapshot } from '../api';
import { beijingCalendarDate } from '../workspace/beijing-time';
import { UNRECOGNIZED_STATE_LABEL, commissionRoleLabel, commissionStateLabel } from '@zzsh/ui/display-distribution';

export type DashboardSource = 'ALL' | 'NATIVE' | 'LEGACY';
export type DashboardState = 'ALL' | 'PENDING' | 'SETTLED' | 'REVOKED' | 'RECOVERY_REQUIRED' | 'EXPIRED';
export type DashboardRole = 'ALL' | 'RENTER_REFERRAL' | 'OWNER_REFERRAL' | 'TASK_REFERRAL';
export type DashboardMetric = { knowledge: 'KNOWN' | 'UNKNOWN'; cents: string | null; count: string | null; reasonCodes: string[] };
export type DashboardScope = { isBoss: boolean; games: 'ALL_GAMES' | 'SELECTED_GAMES' | 'NO_SCOPE'; gameIds: string[]; network: 'AVAILABLE' | 'UNAVAILABLE'; reasonCodes: string[] };
export type DashboardFilters = { from: string; to: string; source: DashboardSource; state: DashboardState; role: DashboardRole; q: string; page: number; pageSize: number; rankingBasis: 'CURRENT_SETTLED_STOCK' | 'PERIOD_SETTLED_FLOW'; rankingLimit: number };
export type DashboardEarning = { id: string; source: 'NATIVE' | 'LEGACY'; beneficiaryId: string | null; beneficiaryName: string | null; role: string; orderId: string | null; orderNumber: string | null; amountCents: string; recoveryRequiredCents: string | null; state: string; occurredAt: string | null; settledAt: string | null; dueAt: string | null; recordedAt: string | null; gameId: string | null };
export type DashboardRanking = { rank: number; userId: string | null; name: string | null; cents: string; roles: string[]; count: string | null };
export type DashboardOverview = {
  contractVersion: string; asOf: string; timezone: string; snapshotVersion: string; applied: DashboardFilters; scope: DashboardScope;
  native: { settled: DashboardMetric; pending: DashboardMetric; recovery: DashboardMetric; revoked: DashboardMetric; orders: DashboardMetric };
  legacy: { settled: DashboardMetric; pending: DashboardMetric; expired: DashboardMetric; orders: DashboardMetric; coverage: string };
  flow: { accrued: DashboardMetric; settled: DashboardMetric; reversed: DashboardMetric; recovered: DashboardMetric };
  trend: { date: string; cents: string; knowledge: 'KNOWN' | 'UNKNOWN' }[];
  participants: { participants: DashboardMetric; eligible: DashboardMetric; frozen: DashboardMetric; inviter: DashboardMetric; leader: DashboardMetric };
  rankings: { nativeEarnings: DashboardRanking[]; legacyEarnings: DashboardRanking[]; directInvites: { items: DashboardRanking[]; knowledge: 'KNOWN' | 'UNKNOWN'; reasonCodes: string[] } };
  recent: DashboardEarning[];
  reasonCodes: string[];
};
export type DashboardParticipant = { userId: string; name: string | null; eligibility: string; frozen: boolean; levelCode: string | null; inviter: string; leader: string; sourceType: string; revision: string; leaderChildren: number; inviterChildren: number; settledCents: string; pendingCents: string; recoveryCents: string };
export type DashboardParticipantDetail = { participant: DashboardParticipant; relations: { type: string; parentUserId: string | null; parentName: string | null; sourceType: string | null; policyVersion: string | null }[] };

const dateShift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
export function defaultDashboardFilters(): DashboardFilters {
  const to = beijingCalendarDate();
  return { from: dateShift(to, -29), to, source: 'ALL', state: 'ALL', role: 'ALL', q: '', page: 1, pageSize: 20, rankingBasis: 'CURRENT_SETTLED_STOCK', rankingLimit: 10 };
}
export function dashboardContextIdentity(snapshot: Extract<SessionSnapshot, { authenticated: true }>) {
  return JSON.stringify([snapshot.adminUserId, snapshot.session.id, snapshot.session.locked, snapshot.security.status, snapshot.security.passwordChangeRequired, snapshot.security.isBoss, [...snapshot.permissions].sort()]);
}
export function dashboardFiltersFromQuery(query: Record<string, string> = {}): DashboardFilters {
  const defaults = defaultDashboardFilters();
  return { ...defaults, from: query.from ?? defaults.from, to: query.to ?? defaults.to, q: query.q ?? '',
    source: ['ALL','NATIVE','LEGACY'].includes(query.source ?? '') ? query.source as DashboardSource : defaults.source,
    state: ['ALL','PENDING','SETTLED','REVOKED','RECOVERY_REQUIRED','EXPIRED'].includes(query.state ?? '') ? query.state as DashboardState : defaults.state,
    role: ['ALL','RENTER_REFERRAL','OWNER_REFERRAL','TASK_REFERRAL'].includes(query.role ?? '') ? query.role as DashboardRole : defaults.role,
    page: /^[1-9]\d{0,5}$/.test(query.page ?? '') ? Number(query.page) : defaults.page,
    pageSize: /^([1-9]|[1-9]\d|100)$/.test(query.pageSize ?? '') ? Number(query.pageSize) : defaults.pageSize,
    rankingBasis: query.rankingBasis === 'PERIOD_SETTLED_FLOW' ? query.rankingBasis : defaults.rankingBasis,
    rankingLimit: /^(?:[1-9]\d|100)$/.test(query.rankingLimit ?? '') ? Number(query.rankingLimit) : defaults.rankingLimit };
}
export function dashboardQuery(filters: DashboardFilters, extra: Record<string, string> = {}) {
  return new URLSearchParams({ ...filters, page: String(filters.page), pageSize: String(filters.pageSize), rankingLimit: String(filters.rankingLimit), ...extra });
}
export function dashboardMoney(metric: DashboardMetric | null | undefined) {
  if (!metric || metric.knowledge !== 'KNOWN' || metric.cents === null) return '未核定';
  return money(metric.cents);
}
export function money(cents: string | null | undefined) {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(cents)) return '未核定';
  const value = BigInt(cents), abs = value < 0n ? -value : value;
  return `${value < 0n ? '−' : ''}¥${(abs / 100n).toLocaleString('zh-CN')}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function metricReason(metric: DashboardMetric | null | undefined) {
  if (!metric) return '';
  return metric.knowledge === 'KNOWN' ? '' : metric.reasonCodes.map(reasonLabel).join('；');
}
export function reasonLabel(reason: string) {
  return ({
    LEGACY_SOURCE_NOT_INSTALLED: '旧平台分销记录还没接入',
    GLOBAL_RELATION_SCOPE_UNAVAILABLE: '当前游戏范围无法读取全平台关系网络',
    LEGACY_RELATION_NOT_ADMITTED: '旧平台关系还没转入，不能当成没有',
    SOURCE_COVERAGE_NOT_ADMITTED: '来源覆盖还没核对，不能按 0 处理',
  } as Record<string, string>)[reason] ?? UNRECOGNIZED_STATE_LABEL;
}
export function sourceLabel(source: string) { return source === 'NATIVE' ? '本平台' : source === 'LEGACY' ? '历史观察' : '全部来源'; }
export function roleLabel(role: string) { return commissionRoleLabel(role); }
export function stateLabel(state: string) { return state === 'ALL' ? '全部状态' : commissionStateLabel(state); }
export function eligibilityLabel(value: string) { return value === 'ELIGIBLE' ? '参与中' : value === 'INELIGIBLE' ? '不参与' : '资格待核'; }

async function read<T>(path: string, query: URLSearchParams, signal?: AbortSignal): Promise<T> {
  try { return await adminRequest<T>(`/distribution/${path}?${query}`, undefined, 'GET', {}, signal); }
  catch (error) { if (error instanceof AdminApiError) throw error; throw new AdminApiError(0, 'NETWORK_ERROR'); }
}
export const readDashboardOverview = (filters: DashboardFilters, signal?: AbortSignal) => read<DashboardOverview>('overview', dashboardQuery(filters), signal);
export const readDashboardEarnings = (filters: DashboardFilters, snapshot: string | null, signal?: AbortSignal) => read<{ items: DashboardEarning[]; total: string; page: number; pageSize: number; hasMore: boolean; snapshot: string | null; asOf: string; snapshotVersion: string; scope: DashboardScope }>('earnings', dashboardQuery(filters, snapshot ? { snapshot } : {}), signal);
export const readDashboardParticipants = (filters: DashboardFilters, snapshot: string | null, signal?: AbortSignal) => read<{ items: DashboardParticipant[]; scope: DashboardScope; total: string; page: number; pageSize: number; hasMore: boolean; snapshot: string | null; asOf: string; snapshotVersion: string }>('participants', dashboardQuery(filters, snapshot ? { snapshot } : {}), signal);
export const readDashboardParticipant = (userId: string, signal?: AbortSignal) => read<DashboardParticipantDetail>('participants/' + encodeURIComponent(userId), new URLSearchParams(), signal);
export const readDistributionRelations = (userId: string, signal?: AbortSignal) => adminRequest<{ subjectId: string; participant: { knowledge: string; eligibility: string; commissionFrozen: boolean | null; legacyLevelCode: string | null }; relations: { type: string; knowledge: string; parentUserId: string | null; parentName: string | null; sourceType: string | null; policyVersion: string | null }[]; reasonCodes: string[] }>(`/distribution/relations/${encodeURIComponent(userId)}`, undefined, 'GET', {}, signal);
