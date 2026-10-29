"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BellOff, CircleAlert, EyeOff, Eye, Pin, RefreshCw, Search, UserPlus, X } from "lucide-react";
import { EntityPreviewTrigger, PreviewCardShell } from "../components/admin-preview";
import { orderTeamMemberRole, type OrderTeamAccess, type OrderTeamMember } from "@zzsh/ui/order-team-panel";
import { initialOf } from "./im-support-format";

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
export type InviteOrderGroupMember = (orderId: string, adminUserId: string) => Promise<void>;

type StoredPreference = Partial<Record<keyof OrderGroupPreference, unknown>>;
type AdminInviteTarget = { adminUserId: string; displayName: string };
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

type StaffAvailability = "AVAILABLE" | "PAUSED" | "OFF_DUTY";
type MemberView = OrderTeamMember & { availability?: StaffAvailability | null };
const AVAILABILITY_LABEL: Record<StaffAvailability, string> = { AVAILABLE: "可接待", PAUSED: "已暂停", OFF_DUTY: "未上线" };

function availabilityOf(member: MemberView): string | null {
  const value = member.availability;
  return value && value in AVAILABILITY_LABEL ? AVAILABILITY_LABEL[value] : null;
}

function relationOf(member: OrderTeamMember): string {
  return member.responsible ? "负责客服" : "协作客服";
}

function MemberAvatar({ member, name }: { member: OrderTeamMember; name: string }) {
  const avatar = typeof member.avatar === "string" && member.avatar.trim() ? member.avatar : null;
  return <span className="im-og-avatar" aria-hidden="true">
    {avatar ? <img src={avatar} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : initialOf(name)}
  </span>;
}

/** Admin-only lightweight card: platform-support role and relation, never user profile facts. */
function AdminMemberPreviewCard({ member, name }: { member: MemberView; name: string }) {
  const availability = availabilityOf(member);
  return <PreviewCardShell ariaLabel={`平台客服预览：${name}`} header={<>
    <MemberAvatar member={member} name={name} />
    <div className="im-og-card-identity">
      <strong>{name}</strong>
      <span>平台客服</span>
    </div>
  </>}>
    <dl className="im-og-card-facts">
      <div><dt>本单角色</dt><dd>平台客服</dd></div>
      <div><dt>本单关系</dt><dd>{relationOf(member)}</dd></div>
      {availability ? <div><dt>接待状态</dt><dd>{availability}</dd></div> : null}
    </dl>
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

export function AdminOrderGroupSettingsDrawer({ info, request, preferences, onPreferenceChange, onHide, onClose, inviteMember }: {
  info: OrderTeamAccess;
  request: <T>(path: string) => Promise<T>;
  preferences: OrderGroupPreference;
  onPreferenceChange: (patch: Partial<OrderGroupPreference>) => void;
  onHide: () => void;
  onClose: () => void;
  inviteMember?: InviteOrderGroupMember;
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
  const groupName = info.name?.trim() || `${info.account.title} · 订单群`;
  const memberIds = new Set(info.members.map((member) => member.platformId));
  const text = query.trim().toLowerCase();
  const matchedAdmins = directory.filter((candidate) =>
    !memberIds.has(candidate.adminUserId)
    && (!text || (candidate.displayName ?? "").toLowerCase().includes(text)));
  const candidates = matchedAdmins.slice(0, ADMIN_PICKER_LIMIT);

  const invite = async (candidate: AdminInviteTarget) => {
    if (!inviteMember || invitePhase?.state === "SENDING") return;
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
        <div><strong>群设置</strong><span>{info.displayNo}</span></div>
        <button ref={closeRef} type="button" className="im-og-icon-btn" data-action="close-group-settings" aria-label="关闭群设置" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="im-og-body">
        <section className="im-og-group" aria-label="群信息">
          <b>{groupName}</b>
          <span>群成员 {info.members.length} · 用户 {users.length} · 客服 {staff.length}</span>
        </section>

        <section className="im-og-section" aria-label="群成员">
          <div className="im-og-section-head"><h3>用户成员</h3><span className="im-og-readonly">只读</span></div>
          {users.length ? <ul className="im-og-members" data-member-group="USER" aria-label="用户成员">
            {users.map((member) => <UserMemberRow key={member.accountId} member={member} />)}
          </ul> : <p className="im-og-empty">服务端未返回用户成员。</p>}
          <p className="im-og-note">号主与租客由订单参与方决定，这里只读，不能添加、移除或改昵称。</p>

          <div className="im-og-section-head im-og-staff-head">
            <h3>客服成员</h3>
            {ended
              ? <span className="im-og-readonly" data-action="invite-ended-readonly">本单已结束</span>
              : <button type="button" className="im-og-invite-btn" data-action="open-admin-invite" onClick={() => setPickerOpen((open) => !open)}><UserPlus size={13} />邀请管理员</button>}
          </div>
          {staff.length ? <ul className="im-og-members" data-member-group="STAFF" aria-label="客服成员">
            {staff.map((member) => <StaffMemberRow key={member.accountId} member={member} />)}
          </ul> : <p className="im-og-empty">服务端未返回客服成员。</p>}
          {others.length ? <ul className="im-og-members" data-member-group="OTHER" aria-label="未分组成员">
            {others.map((member) => <li className="im-og-member" key={member.accountId}><MemberAvatar member={member} name={member.name?.trim() || "未分组成员"} /><span className="im-og-member-copy"><b>{member.name?.trim() || "未分组成员"}</b><small>成员类型待确认</small></span></li>)}
          </ul> : null}

          {pickerOpen && !ended ? <div className="im-og-picker" aria-label="邀请管理员">
            <label className="im-og-search"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索管理员姓名" aria-label="搜索管理员姓名" /></label>
            <p className="im-og-note">任意管理端管理员可邀请现有管理员；普通用户与站外账号不可邀请。仅列出状态正常的现有管理员。</p>
            {!inviteMember ? <p className="im-og-status" data-tone="warn" role="status">服务端未就绪：邀请接口尚未提供，当前不会发送邀请。</p> : null}
            {directoryState === "loading" ? <p className="im-og-empty">正在读取可邀请管理员…</p> : null}
            {directoryState === "denied" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />当前账号无权读取可邀请成员。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "unavailable" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />服务端未就绪：成员邀请暂不可用，当前不会发送邀请。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "error" ? <div className="im-og-status" data-tone="warn" role="status"><CircleAlert size={13} />可邀请成员暂时读不到。<button type="button" data-action="retry-invite-candidates" onClick={() => void loadDirectory()}><RefreshCw size={12} />重试</button></div> : null}
            {directoryState === "ready" ? <>
              {candidates.length ? <ul className="im-og-candidates">
                {candidates.map((candidate) => {
                  const name = candidate.displayName?.trim() || "管理员";
                  const sending = invitePhase?.state === "SENDING" && invitePhase.key === candidate.adminUserId;
                  const invited = invitePhase?.state === "SENT" && invitePhase.key === candidate.adminUserId;
                  return <li className="im-og-candidate" key={candidate.adminUserId}>
                    <span className="im-og-avatar" aria-hidden="true">{initialOf(name)}</span>
                    <span className="im-og-candidate-copy"><b>{name}</b><small>平台管理员</small></span>
                    <button type="button" className="im-og-candidate-invite" data-action="invite-admin-candidate" disabled={!inviteMember || sending || invited}
                      title={!inviteMember ? "邀请接口服务端未就绪" : undefined} onClick={() => void invite(candidate)}>{sending ? "邀请中…" : invited ? "已邀请" : inviteMember ? "邀请" : "服务端未就绪"}</button>
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

        <section className="im-og-section" aria-label="本机会话偏好">
          <h3>本机会话偏好</h3>
          <div className="im-og-prefs">
            <PreferenceSwitch pref="pin" label="置顶会话" hint="仅让本机订单列表把该群排在最前" active={preferences.pinned} onClick={() => onPreferenceChange({ pinned: !preferences.pinned })} />
            <PreferenceSwitch pref="mute" label="消息免打扰" hint="仅在本机标记，不改变消息接收" active={preferences.muted} onClick={() => onPreferenceChange({ muted: !preferences.muted })} />
            <div className="im-og-hide-row">
              <span className="im-og-pref-copy"><b>{preferences.hidden ? "已在本机隐藏" : "不显示会话"}</b><small>仅隐藏本机列表中的这一行；不会退出群聊，也不删除任何人的聊天记录。</small></span>
              <button type="button" className="im-og-hide-btn" data-pref={preferences.hidden ? "restore" : "hide"} onClick={() => { if (preferences.hidden) onPreferenceChange({ hidden: false }); else onHide(); }}>
                {preferences.hidden ? <><Eye size={13} />恢复显示</> : <><EyeOff size={13} />不显示会话</>}
              </button>
            </div>
          </div>
          <p className="im-og-note"><Pin size={11} aria-hidden="true" />偏好按当前管理员保存在本机浏览器，不改变订单、群成员或他人的会话。<BellOff size={11} aria-hidden="true" />免打扰不会拦截平台通知。</p>
        </section>
      </div>
    </section>
  </div>;
}
