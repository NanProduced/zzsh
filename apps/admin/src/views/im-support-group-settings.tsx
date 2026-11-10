"use client";
import { ProfileImage } from "@zzsh/ui/profile-image";


import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CircleAlert, EyeOff, Eye, RefreshCw, Search, UserPlus, X } from "lucide-react";
import { EntityPreviewTrigger, PreviewCardShell } from "../components/admin-preview";
import { orderTeamMemberRole, type OrderTeamAccess, type OrderTeamMember } from "@zzsh/ui/order-team-panel";
import type { NimWebClientLike } from "@zzsh/im-client/nim-web-client";
import { formatDateTime, initialOf } from "./im-support-format";
import "./im-support-group-settings.css";

/**
 * Admin order-group settings. The drawer is presented over the existing order
 * detail rail; it only rearranges facts the IM slot already returned. Member
 * identifiers stay out of the DOM, no group nickname is editable, and local
 * conversation preferences never write to the order or to NIM.
 */

const PREF_STORAGE_PREFIX = "zzsh.im-support.order-group-prefs";
const ADMIN_PICKER_LIMIT = 8;
const ADMIN_CANDIDATE_POOL = 50;

export type OrderGroupPreference = { pinned: boolean; muted: boolean; hidden: boolean };
export type OrderGroupPreferenceMap = Record<string, OrderGroupPreference>;
/** Bridge the unified directory's row menu to the order workbench's local prefs/settings. */
export const ORDER_GROUP_PREF_EVENT = "zzsh:im-order-group-preference";
export const ORDER_GROUP_SETTINGS_EVENT = "zzsh:im-order-group-settings";
export type InviteOrderGroupMember = (orderId: string, adminUserId: string) => Promise<void>;

type StoredPreference = Partial<Record<keyof OrderGroupPreference, unknown>>;
type AdminInviteTarget = { adminUserId: string; displayName: string; avatar?: string | null };
type AdminInviteTargetRead = { targets?: AdminInviteTarget[] };
type ReadState = "idle" | "loading" | "ready" | "denied" | "unavailable" | "error";
type InvitePhase = { key: string; name: string; state: "SENDING" | "SENT" | "FAILED" | "UNAVAILABLE" };

function storageKey(adminUserId: string): string {
  return `${PREF_STORAGE_PREFIX}.${adminUserId}`;
}

function preferenceOf(value: unknown): OrderGroupPreference {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as StoredPreference : {};
  return { pinned: record.pinned === true, muted: record.muted === true, hidden: record.hidden === true };
}

/** Preferences are scoped to one administrator and one browser; unreadable storage is empty. */
export function readOrderGroupPreferences(adminUserId: string): OrderGroupPreferenceMap {
  if (!adminUserId || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(adminUserId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([orderId]) => orderId.trim()).map(([orderId, value]) => [orderId, preferenceOf(value)]));
  } catch {
    return {};
  }
}

export function storeOrderGroupPreferences(adminUserId: string, preferences: OrderGroupPreferenceMap): void {
  if (!adminUserId || typeof window === "undefined") return;
  try { window.localStorage.setItem(storageKey(adminUserId), JSON.stringify(preferences)); } catch { /* local-only preference; storage failure stays in memory */ }
}

export function groupPreferenceOf(preferences: OrderGroupPreferenceMap, orderId: string): OrderGroupPreference {
  return preferences[orderId] ?? { pinned: false, muted: false, hidden: false };
}

export function withGroupPreference(preferences: OrderGroupPreferenceMap, orderId: string, patch: Partial<OrderGroupPreference>): OrderGroupPreferenceMap {
  return { ...preferences, [orderId]: { ...groupPreferenceOf(preferences, orderId), ...patch } };
}

/**
 * Pin is owned by NIM cloud per account. The hook exposes only numeric team
 * ids; local preferences remain the fallback when the client cannot reach
 * cloud conversations (local test transport or a disabled deployment).
 */
export type OrderGroupCloudPins = {
  status: "LOADING" | "CLOUD" | "LOCAL";
  teamIds: ReadonlySet<string>;
  error: string | null;
  toggle: (teamId: string, pinned: boolean) => Promise<void>;
};

const ORDER_TEAM_ID = /^[0-9]{1,19}$/;

function pinnedTeamIds(conversationIds: readonly string[], accountId: string): Set<string> {
  const prefix = `${accountId}|2|`;
  return new Set(conversationIds
    .filter((value) => typeof value === "string" && value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
    .filter((value) => ORDER_TEAM_ID.test(value)));
}

function withTeamPin(current: ReadonlySet<string>, teamId: string, pinned: boolean): Set<string> {
  const next = new Set(current);
  if (pinned) next.add(teamId);
  else next.delete(teamId);
  return next;
}

export function useOrderGroupCloudPins(client: NimWebClientLike | null | undefined): OrderGroupCloudPins {
  const [state, setState] = useState<{ status: "LOADING" | "CLOUD" | "LOCAL"; teamIds: Set<string>; error: string | null }>({ status: "LOADING", teamIds: new Set(), error: null });
  const clientRef = useRef(client);
  clientRef.current = client;
  useEffect(() => {
    if (!client || typeof client.getStickTopConversationIds !== "function" || typeof client.setConversationStickTop !== "function") {
      setState({ status: "LOCAL", teamIds: new Set(), error: null });
      return;
    }
    let active = true;
    setState({ status: "LOADING", teamIds: new Set(), error: null });
    void client.getStickTopConversationIds().then((conversationIds) => {
      if (!active) return;
      setState({ status: "CLOUD", teamIds: pinnedTeamIds(conversationIds, client.accountId), error: null });
    }).catch(() => {
      if (!active) return;
      setState({ status: "LOCAL", teamIds: new Set(), error: "云信置顶暂不可用，当前保留本机置顶。" });
    });
    return () => { active = false; };
  }, [client]);
  const toggle = useCallback(async (teamId: string, pinned: boolean) => {
    const current = clientRef.current;
    if (!current?.setConversationStickTop || state.status !== "CLOUD") throw new Error("云信置顶不可用");
    if (!ORDER_TEAM_ID.test(teamId)) throw new Error("订单群标识无效");
    setState((previous) => ({ ...previous, teamIds: withTeamPin(previous.teamIds, teamId, pinned), error: null }));
    try {
      await current.setConversationStickTop(`${current.accountId}|2|${teamId}`, pinned);
    } catch (cause) {
      const forbidden = (cause as { code?: unknown } | null)?.code === 403;
      setState((previous) => ({
        ...previous,
        status: forbidden ? "LOCAL" : previous.status,
        teamIds: withTeamPin(previous.teamIds, teamId, !pinned),
        error: forbidden
          ? "云信拒绝云端置顶（403）：当前 App/账号未开通该能力，已回退本机置顶。"
          : "云信置顶更新失败，未改变置顶状态。",
      }));
      throw cause;
    }
  }, [state.status]);
  return { ...state, toggle };
}

type StaffAvailability = "AVAILABLE" | "PAUSED" | "OFF_DUTY";
type MemberView = OrderTeamMember & { availability?: StaffAvailability | null };
const AVAILABILITY_LABEL: Record<StaffAvailability, string> = { AVAILABLE: "可接待", PAUSED: "已暂停", OFF_DUTY: "未上线" };

function availabilityOf(member: Pick<MemberView, "availability">): string | null {
  const value = member.availability;
  return value && value in AVAILABILITY_LABEL ? AVAILABILITY_LABEL[value] : null;
}

function relationOf(member: Pick<OrderTeamMember, "responsible">): string {
  return member.responsible ? "负责客服" : "协作客服";
}

function MemberAvatar({ member, name }: { member: Pick<OrderTeamMember, "avatar">; name: string }) {
  const avatar = typeof member.avatar === "string" && member.avatar.trim() ? member.avatar : null;
  return <span className="im-og-avatar" aria-hidden="true">
    <ProfileImage src={avatar} fallback={initialOf(name)} loading="lazy" />
  </span>;
}

/** Admin-only lightweight card: platform-support role and relation, never user profile facts. */
export function AdminMemberPreviewCard({ member, name, displayUsername, orderContext = true }: { member: Pick<MemberView, "avatar" | "availability" | "responsible">; name: string; displayUsername?: string; orderContext?: boolean }) {
  const availability = availabilityOf(member);
  return <PreviewCardShell ariaLabel={`平台客服预览：${name}`} header={<>
    <MemberAvatar member={member} name={name} />
    <div className="im-og-card-identity">
      <strong>{name}</strong>
      <span>平台客服</span>
    </div>
  </>}>
    {orderContext || availability || displayUsername ? <dl className="im-og-card-facts">
      {displayUsername ? <div><dt>管理员账号</dt><dd>{displayUsername}</dd></div> : null}
      {orderContext ? <><div><dt>本单角色</dt><dd>平台客服</dd></div>
      <div><dt>本单关系</dt><dd>{relationOf(member)}</dd></div></> : null}
      {availability ? <div><dt>接待状态</dt><dd>{availability}</dd></div> : null}
    </dl> : null}
  </PreviewCardShell>;
}

function UserMemberRow({ member }: { member: OrderTeamMember }) {
  const name = member.name?.trim() || orderTeamMemberRole(member);
  return <li className="im-og-member" data-member="user">
    <MemberAvatar member={member} name={name} />
    <span className="im-og-member-copy">
      <b>{name}</b>
      <small>{orderTeamMemberRole(member)} · 只读</small>
    </span>
  </li>;
}

function StaffMemberRow({ member }: { member: MemberView }) {
  const name = member.name?.trim() || orderTeamMemberRole(member);
  return <li className="im-og-member" data-member="staff">
    <EntityPreviewTrigger side="left" align="start" touchLabel={`预览客服信息 ${name}`} className="im-og-member-trigger"
      trigger={<button type="button" className="im-og-member-hit">
        <MemberAvatar member={member} name={name} />
        <span className="im-og-member-copy">
          <b>{name}</b>
          <small>{relationOf(member)}</small>
        </span>
      </button>}
      content={<AdminMemberPreviewCard member={member} name={name} />} />
    <span className="im-og-relation" data-relation={member.responsible ? "responsible" : "collaborating"}>{relationOf(member)}</span>
  </li>;
}

function PreferenceSwitch({ pref, label, hint, active, onClick }: { pref: string; label: string; hint: string; active: boolean; onClick: () => void }) {
  return <button type="button" role="switch" aria-checked={active} data-pref={pref} className="im-og-pref" onClick={onClick}>
    <span className="im-og-pref-copy"><b>{label}</b><small>{hint}</small></span>
    <span className="im-og-switch" data-on={active ? "true" : undefined} aria-hidden="true"><i /></span>
  </button>;
}

export function AdminOrderGroupSettingsDrawer({ info, request, preferences, onPreferenceChange, onHide, onClose, inviteMember, pinCloud = false }: {
  info: OrderTeamAccess;
  request: <T>(path: string) => Promise<T>;
  preferences: OrderGroupPreference;
  onPreferenceChange: (patch: Partial<OrderGroupPreference>) => void;
  onHide: () => void;
  onClose: () => void;
  inviteMember?: InviteOrderGroupMember;
  pinCloud?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [directory, setDirectory] = useState<AdminInviteTarget[]>([]);
  const [directoryState, setDirectoryState] = useState<ReadState>("idle");
  const [query, setQuery] = useState("");
  const [invitePhase, setInvitePhase] = useState<InvitePhase | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    closeRef.current?.focus();
    return () => { mountedRef.current = false; };
  }, []);

  const loadDirectory = useCallback(async () => {
    setDirectoryState("loading");
    try {
      const value = await requestRef.current<AdminInviteTargetRead>(`/orders/${encodeURIComponent(info.orderId)}/member-candidates?limit=${ADMIN_CANDIDATE_POOL}`);
      if (!mountedRef.current) return;
      setDirectory(Array.isArray(value?.targets) ? value.targets.filter((target) => typeof target?.adminUserId === "string" && target.adminUserId) : []);
      setDirectoryState("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      const status = (error as { status?: number } | null)?.status;
      setDirectory([]);
      setDirectoryState(status === 401 || status === 403 ? "denied" : status === 404 || status === 503 ? "unavailable" : "error");
    }
  }, [info.orderId]);

  useEffect(() => {
    if (pickerOpen && directoryState === "idle") void loadDirectory();
  }, [directoryState, loadDirectory, pickerOpen]);

  const users = info.members.filter((member) => member.party === "BUYER" || member.party === "OWNER");
  const staff = info.members.filter((member) => member.party === "STAFF") as MemberView[];
  const others = info.members.filter((member) => member.party !== "BUYER" && member.party !== "OWNER" && member.party !== "STAFF");
  const ended = info.orderStatus === "COMPLETED" || info.orderStatus === "CANCELLED";
  const viewerJoined = Boolean(info.viewerAccountId
    && info.members.some((member) => member.party === "STAFF" && member.accountId === info.viewerAccountId));
  const sendUntil = info.sendUntil ? Date.parse(info.sendUntil) : Number.NaN;
  const serverNow = info.serverNow ? Date.parse(info.serverNow) : Date.now();
  const sendWindowExpired = Number.isFinite(sendUntil) && Number.isFinite(serverNow) && serverNow >= sendUntil;
  const terminalWindowOpen = info.terminalSendAllowed === true && !sendWindowExpired;
  const inviteAvailable = viewerJoined && (!ended || terminalWindowOpen);
  const inviteBlockedReason = viewerJoined && ended
    ? "订单已结束，沟通窗口已关闭，无法邀请。"
    : null;

  const memberIds = new Set(info.members.map((member) => member.platformId));
  const text = query.trim().toLowerCase();
  const matchedAdmins = directory.filter((candidate) =>
    !memberIds.has(candidate.adminUserId)
    && (!text || (candidate.displayName ?? "").toLowerCase().includes(text)));
  const candidates = matchedAdmins.slice(0, ADMIN_PICKER_LIMIT);

  const invite = async (candidate: AdminInviteTarget) => {
    if (!inviteMember || !inviteAvailable || invitePhase?.state === "SENDING") return;
    const name = candidate.displayName?.trim() || "该管理员";
    setInvitePhase({ key: candidate.adminUserId, name, state: "SENDING" });
    try {
      await inviteMember(info.orderId, candidate.adminUserId);
      if (mountedRef.current) setInvitePhase({ key: candidate.adminUserId, name, state: "SENT" });
    } catch (error) {
      if (!mountedRef.current) return;
      const status = (error as { status?: number } | null)?.status;
      setInvitePhase({ key: candidate.adminUserId, name, state: status === 404 || status === 503 ? "UNAVAILABLE" : "FAILED" });
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return <div className="im-og-drawer" role="dialog" aria-label="订单群设置" data-settings-drawer="true" onKeyDown={keyDown}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="im-og-sheet" onClick={(event) => event.stopPropagation()}>
      <header className="im-og-head">
        <div className="im-og-head-title"><strong>群设置</strong><span>{info.displayNo}</span></div>
        <button ref={closeRef} type="button" className="im-og-icon-btn" data-action="close-group-settings" aria-label="关闭群设置" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="im-og-body">
        <section className="im-og-group" aria-label="群信息">
          <b>{info.gameName} · 订单 {info.displayNo}</b>
          <span>{info.account.title?.trim() || "账号"} · 群成员 {info.members.length} · 用户 {users.length} · 客服 {staff.length}</span>
        </section>

        <section className="im-og-section" aria-label="群成员">
          <div className="im-og-section-head"><h3>用户成员</h3><span className="im-og-readonly">只读</span></div>
          {users.length ? <ul className="im-og-members" data-member-group="USER" aria-label="用户成员">
            {users.map((member) => <UserMemberRow key={member.accountId} member={member} />)}
          </ul> : <p className="im-og-empty">服务端未返回用户成员。</p>}
          <p className="im-og-note">用户成员由订单决定，只读。</p>

          <div className="im-og-section-head im-og-staff-head">
            <h3>客服成员</h3>
            {inviteAvailable
              ? <button type="button" className="im-og-invite-btn" data-action="open-admin-invite" onClick={() => setPickerOpen((open) => !open)}><UserPlus size={13} />邀请管理员</button>
              : <span className="im-og-readonly" data-action={ended ? "invite-ended-readonly" : "invite-member-readonly"}>{viewerJoined ? "本单已结束" : "仅群内客服可邀请"}</span>}
          </div>
          {ended ? <p className="im-og-note" data-action="invite-window-note">
            {terminalWindowOpen
              ? `订单已结束，仍可在沟通窗口内邀请${info.sendUntil ? `（至 ${formatDateTime(info.sendUntil)}）` : ""}。`
              : inviteBlockedReason ?? "订单已结束，当前不可邀请。"}
          </p> : null}
          {!viewerJoined ? <p className="im-og-note">仅本群客服成员可邀请管理员。</p> : null}
          {staff.length ? <ul className="im-og-members" data-member-group="STAFF" aria-label="客服成员">
            {staff.map((member) => <StaffMemberRow key={member.accountId} member={member} />)}
          </ul> : <p className="im-og-empty">服务端未返回客服成员。</p>}
          {others.length ? <ul className="im-og-members" data-member-group="OTHER" aria-label="未分组成员">
            {others.map((member) => <li className="im-og-member" key={member.accountId}><MemberAvatar member={member} name={member.name?.trim() || "未分组成员"} /><span className="im-og-member-copy"><b>{member.name?.trim() || "未分组成员"}</b><small>成员类型待确认</small></span></li>)}
          </ul> : null}

          {pickerOpen && inviteAvailable ? <div className="im-og-picker" aria-label="邀请管理员">
            <label className="im-og-search"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索管理员姓名" aria-label="搜索管理员姓名" /></label>
            <p className="im-og-note">可邀请现有管理员。</p>
            {!inviteMember ? <p className="im-og-status" data-tone="warn" role="status">暂不可用：当前暂不支持直接发送邀请。</p> : null}
            {directoryState === "loading" ? <p className="im-og-empty">正在读取可邀请管理员…</p> : null}
            {directoryState === "denied" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />当前账号无权读取可邀请成员。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "unavailable" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />服务端未就绪：成员邀请暂不可用，当前无法发送邀请。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "error" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />可邀请成员暂时读不到。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "ready" ? <>
              {candidates.length ? <ul className="im-og-candidates">
                {candidates.map((candidate) => {
                  const name = candidate.displayName?.trim() || "管理员";
                  const sending = invitePhase?.state === "SENDING" && invitePhase.key === candidate.adminUserId;
                  const invited = invitePhase?.state === "SENT" && invitePhase.key === candidate.adminUserId;
                  return <li className="im-og-candidate" key={candidate.adminUserId}>
                    <span className="im-og-avatar" aria-hidden="true"><ProfileImage src={candidate.avatar} fallback={initialOf(name)} /></span>
                    <span className="im-og-candidate-copy"><b>{name}</b><small>平台管理员</small></span>
                    <button type="button" className="im-og-candidate-invite" data-action="invite-admin-candidate" disabled={!inviteMember || sending || invited}
                      title={!inviteMember ? "邀请功能暂不可用" : undefined} onClick={() => void invite(candidate)}>{sending ? "邀请中…" : invited ? "已邀请" : inviteMember ? "邀请" : "暂不可用"}</button>
                  </li>;
                })}
              </ul> : <p className="im-og-empty">没有符合条件的可邀请管理员。</p>}
              {matchedAdmins.length > candidates.length ? <p className="im-og-note">匹配 {matchedAdmins.length} 位，仅显示前 {ADMIN_PICKER_LIMIT} 位，可继续搜索。</p> : null}
            </> : null}
            {invitePhase?.state === "SENT" ? <p className="im-og-status" data-tone="good" role="status">已邀请 {invitePhase.name}；成员列表会在服务端刷新后更新。</p> : null}
            {invitePhase?.state === "UNAVAILABLE" ? <p className="im-og-status" data-tone="warn" role="status">服务端未就绪：邀请未发送，当前不会伪造成功。</p> : null}
            {invitePhase?.state === "FAILED" ? <p className="im-og-status" data-tone="warn" role="alert">邀请失败，未加入成员；请核对权限或稍后重试。</p> : null}
          </div> : null}
        </section>

        <section className="im-og-section" aria-label="会话偏好">
          <h3>会话偏好</h3>
          <div className="im-og-prefs">
            <PreferenceSwitch pref="pin" label="置顶会话" hint={pinCloud ? "云信账号同步，跨设备生效" : "本机列表排到最前"} active={preferences.pinned} onClick={() => onPreferenceChange({ pinned: !preferences.pinned })} />
            <PreferenceSwitch pref="mute" label="消息免打扰" hint="只在本机标记" active={preferences.muted} onClick={() => onPreferenceChange({ muted: !preferences.muted })} />
            <div className="im-og-hide-row">
              <span className="im-og-pref-copy"><b>{preferences.hidden ? "已在本机隐藏" : "不显示会话"}</b><small>只隐藏本机列表，不影响群聊。</small></span>
              <button type="button" className="im-og-hide-btn" data-pref={preferences.hidden ? "restore" : "hide"} onClick={() => { if (preferences.hidden) onPreferenceChange({ hidden: false }); else onHide(); }}>
                {preferences.hidden ? <><Eye size={13} />恢复显示</> : <><EyeOff size={13} />不显示会话</>}
              </button>
            </div>
          </div>
          <p className="im-og-note">{pinCloud ? "置顶保存在云信账号，换浏览器或环境后仍会同步；免打扰和隐藏只在本机。若云信未开通该能力，会自动回退本机并提示。" : "偏好只保存在本机；免打扰不拦截平台通知。"}</p>
        </section>
      </div>
    </section>
  </div>;
}
