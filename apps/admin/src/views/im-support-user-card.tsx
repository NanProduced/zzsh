"use client";
import { ProfileImage, managedProfileImage } from "@zzsh/ui/profile-image";


import { useEffect, useRef, useState } from "react";
import { CircleAlert, Info, RefreshCw } from "lucide-react";
import { AdminApiError, type UserDirectoryDetail } from "../api";
import { PERMISSION } from "./user-directory/user-directory-data";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardTitle } from "../components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemSeparator } from "../components/ui/item";
import { EntityPreviewTrigger, UserPreviewCard, hasUsefulUserPreview } from "../components/admin-preview";
import { initialOf } from "./im-support-format";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

/**
 * Who the operator is actually talking to. The consultation context is authorised by the
 * conversation itself; the account profile needs 用户目录读取 and its two summaries need
 * order / resource-account reads on top of that. Every read is bound to the capability set
 * it was issued under: revoking one of them clears the facts it produced instead of leaving
 * a stale count or a stale 来源 on screen. UNKNOWN never collapses into a friendlier default,
 * and a `ready` summary without a number is never rendered as zero.
 *
 * 第一屏是用户与风险摘要：账号状态、实名/年龄、冻结/限制/高危、名下账号与进行中订单、
 * 脱敏联系方式。用户 UUID 只用于受权读取与资料入口，不渲染、不复制；昵称/头像接管理端
 * 现有用户 hoverCard，且只在资料读取仍然持有时出现，卡内不出现 UUID。
 */

/**
 * 服务端关联对象投影。resolved 才带业务展示号与跳转事实；unresolved / absent
 * 不带任何可以反推单号的字段，前端也不从 rawRef 里猜。
 */
type SubjectProjection = {
  status?: unknown;
  kind?: unknown;
  displayNo?: unknown;
  title?: unknown;
  target?: unknown;
  rawRef?: unknown;
  party?: unknown;
};
type ContextView = {
  consultationId: string;
  user: { status: string; publicId?: string; displayName?: string; avatar?: string | null };
  subject: SubjectProjection;
};
type ContextState = "loading" | "ready" | "denied" | "error";
export type SubjectTargetKind = "ORDER" | "ACCOUNT";
/** 已解析的关联对象：displayNo 是业务号，id 只用于跳转、不上屏。 */
export type UserCardSubject = { kind: SubjectTargetKind; id: string; displayNo: string; title: string | null };
export type UserProfileScope = { profile: boolean; orders: boolean; resources: boolean };

type SubjectView = {
  label: string;
  value: string;
  party?: string | null;
  /** 只有服务端给出业务展示号（且类型可识别）时才出现；其余分支不渲染任何跳转入口。 */
  resolved?: UserCardSubject;
};

const SUBJECT_KIND_LABEL: Record<SubjectTargetKind, string> = { ORDER: "订单", ACCOUNT: "资源账号" };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function subjectTargetOf(value: unknown): { kind: SubjectTargetKind; id: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: unknown; id?: unknown };
  const kind = row.kind === "ORDER" ? "ORDER" : row.kind === "ACCOUNT" ? "ACCOUNT" : null;
  const id = typeof row.id === "string" && SAFE_ID.test(row.id) ? row.id : "";
  return kind && id ? { kind, id } : null;
}

function subjectView(context: ContextView | null, state: ContextState): SubjectView {
  if (!context) {
    return {
      label: "关联对象",
      value: state === "loading" ? "正在读取关联对象…" : state === "denied" ? "当前账号无权读取关联对象" : "关联对象暂时不可读取",
    };
  }
  const subject = context.subject ?? {};
  if (subject.status === "absent") return { label: "关联对象", value: "尚未关联商品或订单" };
  if (subject.status === "unresolved") {
    // rawRef 没有持久化类型，也没有业务单号；裸引用（可能是 UUID）不直接上屏。
    return { label: "关联对象", value: "关联对象暂未识别" };
  }
  if (subject.status === "resolved") {
    const kind = subject.kind === "ORDER" ? "ORDER" : subject.kind === "ACCOUNT" ? "ACCOUNT" : null;
    const displayNo = typeof subject.displayNo === "string" ? subject.displayNo.trim() : "";
    // 没有类型或没有业务展示号就不是可展示的 resolved：不拿内部 id 冒充单号。
    if (!kind || !displayNo) return { label: "关联对象", value: "关联对象类型暂未确认" };
    const target = subjectTargetOf(subject.target);
    const title = typeof subject.title === "string" && subject.title.trim() ? subject.title.trim() : null;
    const party = "party" in subject && typeof subject.party === "string"
      ? (subject.party === "RENTER" ? "租客" : subject.party === "OWNER" ? "号主" : null)
      : null;
    return {
      label: `关联对象 · ${SUBJECT_KIND_LABEL[kind]}`,
      value: displayNo,
      party,
      resolved: { kind, id: target?.kind === kind ? target.id : "", displayNo, title },
    };
  }
  return { label: "关联对象", value: "关联对象类型暂未确认" };
}

const ACCOUNT_STATUS: Record<string, { label: string; tone: "secondary" | "destructive" | "outline" }> = {
  ACTIVE: { label: "账号正常", tone: "secondary" },
  RESTRICTED: { label: "账号受限", tone: "destructive" },
  FROZEN: { label: "已冻结", tone: "destructive" },
  CANCELLED: { label: "已注销", tone: "destructive" },
  UNKNOWN: { label: "账号状态未知", tone: "outline" },
};
const IDENTITY_STATUS: Record<string, string> = { VERIFIED: "已实名", UNVERIFIED: "未实名", REJECTED: "实名未通过", UNKNOWN: "实名状态未知" };
const AGE_STATUS: Record<string, string> = { ADULT: "成人", MINOR: "未成年", UNKNOWN: "年龄状态未知" };
const SOURCE_KIND: Record<string, string> = { LOCAL: "本平台注册", MIGRATED: "旧平台迁移", UNKNOWN: "来源未知" };
const READ_LABELS: Record<string, string> = { [PERMISSION.orders]: "订单读取", [PERMISSION.resources]: "资源账号读取" };

function denied(error: unknown): boolean {
  const status = error instanceof AdminApiError ? error.status : undefined;
  return status === 401 || status === 403;
}
/** Current capability and server state both have to agree; a missing count is not zero. */
function summaryText(summary: UserDirectoryDetail["orderSummary"] | UserDirectoryDetail["resourceSummary"], unit: string, permitted: boolean, permission: string): string {
  if (!permitted || summary?.state === "denied") return `需「${READ_LABELS[permission] ?? "相应读取"}」权限`;
  if (!summary) return "暂未提供";
  const count = "count" in summary ? summary.count : "currentCount" in summary ? summary.currentCount : undefined;
  return typeof count === "number" ? `${count} ${unit}` : "暂无数据";
}

function Fact({ label, value, permission }: { label: string; value: string; permission?: string }) {
  return (
    <Item size="sm" className="im-rail-fact gap-2 px-4 py-2">
      <ItemContent><ItemDescription className="text-xs">{label}</ItemDescription></ItemContent>
      <ItemActions className="im-rail-value-actions"><span className="im-rail-value text-sm font-medium">{value}</span>
        {permission ? <Popover><PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="im-rail-icon" aria-label={`查看${label}读取权限`} />}><Info aria-hidden="true" /></PopoverTrigger><PopoverContent side="top" align="end" aria-label="读取权限说明" className="w-auto max-w-[260px] text-xs">所需权限：<code>{permission}</code></PopoverContent></Popover> : null}
      </ItemActions>
    </Item>
  );
}

export function ConsultationUserCard({ consultationId, rowUserId, fallbackName, scope, request, onOpenProfile, onOpenSubject, showSubject = true }: {
  consultationId: string;
  rowUserId: string;
  fallbackName: string;
  scope: UserProfileScope;
  request: <T>(path: string) => Promise<T>;
  onOpenProfile?: (userId: string) => void;
  /** 关联对象可跳转时由调用方决定路由；缺省只展示业务号，不给假入口。 */
  onOpenSubject?: (target: { kind: SubjectTargetKind; id: string }, label: string) => void;
  /** 投诉摘要自己陈述关联订单/账号，卡片不再重复。 */
  showSubject?: boolean;
}) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [profile, setProfile] = useState<UserDirectoryDetail | null>(null);
  const [state, setState] = useState<ContextState>("loading");
  const [profileState, setProfileState] = useState<"idle" | "loading" | "ready" | "denied" | "error">("idle");
  const [attempt, setAttempt] = useState(0);
  // One generation per (conversation, capability set, subject): a response that arrives
  // after any of them changed is dropped rather than painted back.
  const readScopeKey = `${consultationId}|${scope.profile ? 1 : 0}${scope.orders ? 1 : 0}${scope.resources ? 1 : 0}|${attempt}`;
  const profileGeneration = useRef("");

  useEffect(() => {
    let active = true;
    setContext(null); setProfile(null); setState("loading"); setProfileState("idle");
    profileGeneration.current = "";
    void request<ContextView>(`/im/consultations/${encodeURIComponent(consultationId)}/context`)
      .then((value) => { if (active) { setContext(value); setState("ready"); } })
      .catch((error) => { if (active) setState(denied(error) ? "denied" : "error"); });
    return () => { active = false; };
  }, [consultationId, readScopeKey, request]);

  const userId = context?.user.publicId || rowUserId;
  useEffect(() => {
    if (!scope.profile || !userId) { profileGeneration.current = ""; setProfile(null); setProfileState("idle"); return; }
    const generation = `${readScopeKey}|${userId}`;
    profileGeneration.current = generation;
    let active = true;
    setProfile(null); setProfileState("loading");
    void request<{ user: UserDirectoryDetail }>(`/users/${encodeURIComponent(userId)}`)
      .then((value) => { if (!active || profileGeneration.current !== generation) return; setProfile(value.user ?? null); setProfileState("ready"); })
      .catch((error) => { if (!active || profileGeneration.current !== generation) return; setProfileState(denied(error) ? "denied" : "error"); });
    return () => { active = false; };
  }, [readScopeKey, request, scope.profile, userId]);

  // Facts from a read the operator no longer holds are not displayable. The effect nulls
  // profile whenever the capability set or subject changes, so a non-null profile is current.
  const facts = scope.profile ? profile : null;
  const displayName = context?.user.displayName || fallbackName;
  const avatar = managedProfileImage(context?.user.avatar) || managedProfileImage(facts?.image);
  const subject = subjectView(context, state);
  const identityStatus = facts?.identity?.status || facts?.identityStatus || "UNKNOWN";
  const ageStatus = facts?.identity?.ageStatus || facts?.ageStatus || "UNKNOWN";
  const account = facts ? ACCOUNT_STATUS[facts.accountStatus] ?? ACCOUNT_STATUS.UNKNOWN : null;
  const sourceText = facts ? SOURCE_KIND[facts.source.kind] ?? SOURCE_KIND.UNKNOWN : state === "loading" ? "正在读取会话对象…" : "平台用户";
  const canPreview = Boolean(facts && scope.profile && userId && hasUsefulUserPreview(facts, displayName));

  const identityBody = <>
    <ItemMedia variant="icon" className="im-wb-avatar" aria-hidden="true">
      <ProfileImage src={avatar} fallback={initialOf(displayName)} />
    </ItemMedia>
    <div className="im-wb-user-copy grid min-w-0 flex-1 gap-1 text-left">
      <CardTitle className="im-wb-user-identity-name line-clamp-2 text-sm leading-snug font-medium">{displayName}</CardTitle>
      <CardDescription className="text-xs leading-normal">{sourceText}</CardDescription>
    </div>
  </>;
  const identity = canPreview ? (
    <EntityPreviewTrigger
      className="min-w-0 flex-1"
      touchLabel={`预览用户 ${displayName}`}
      trigger={
        <button type="button" className="im-wb-user-identity" onClick={() => onOpenProfile?.(userId)}>
          {identityBody}
        </button>
      }
      content={
        <UserPreviewCard
          name={displayName}
          currentName={facts?.name && facts.name !== displayName ? facts.name : undefined}
          image={avatar}
          maskedPhone={facts?.maskedPhone}
          accountStatus={account?.label}
          realNameStatus={IDENTITY_STATUS[identityStatus] ?? IDENTITY_STATUS.UNKNOWN}
          membershipSummary={facts?.membershipSummary}
          creditSummary={facts?.creditSummary}
          riskFlag={facts?.riskFlag}
          canOpen={Boolean(onOpenProfile)}
          onOpen={() => onOpenProfile?.(userId)}
          openLabel="查看用户资料"
          deniedReason="无查看用户资料权限"
        />
      }
    />
  ) : <div className="im-wb-user-identity" data-preview="unavailable">{identityBody}</div>;

  return (
    <Card className="im-wb-card">
      <CardContent className="grid gap-0 p-0">
        <div className="flex items-start gap-3 px-4 py-3">
          {identity}
          {scope.profile && userId ? <Button variant="link" size="sm" className="shrink-0" onClick={() => onOpenProfile?.(userId)}>完整资料</Button> : null}
        </div>

        {state === "denied" ? <p className="flex items-start gap-1.5 px-4 py-2 text-xs text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />当前账号无权查看该会话的对象资料。</p> : null}
        {state === "error" ? <p className="flex items-start gap-1.5 px-4 py-2 text-xs text-muted-foreground"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />部分会话资料暂未读到。</p> : null}

        {scope.profile ? <>
          <ItemSeparator />
          {profileState === "loading" ? <p className="px-4 py-2 text-xs text-muted-foreground">正在读取账号资料…</p> : null}
          {profileState === "denied" ? <p className="px-4 py-2 text-xs text-muted-foreground">该账号的资料当前不可见。</p> : null}
          {profileState === "error" ? <p className="flex items-start gap-1.5 px-4 py-2 text-xs text-muted-foreground"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />账号资料暂时读不到。</p> : null}
          {facts ? <>
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              <Badge variant={account?.tone ?? "outline"}>{account?.label ?? "账号状态未知"}</Badge>
              {facts.suspended && facts.accountStatus !== "FROZEN" ? <Badge variant="destructive">已冻结</Badge> : null}
              <Badge variant={identityStatus === "VERIFIED" ? "secondary" : "outline"}>{IDENTITY_STATUS[identityStatus] ?? IDENTITY_STATUS.UNKNOWN}</Badge>
              {ageStatus === "MINOR" ? <Badge variant="destructive">未成年</Badge> : ageStatus === "UNKNOWN" ? <Badge variant="outline">年龄状态未知</Badge> : null}
              {facts.riskFlag === true ? <Badge variant="destructive">高风险账号</Badge> : null}
            </div>
            <ItemSeparator />
            <Fact label="手机号" value={facts.maskedPhone ? `${facts.maskedPhone} · ${facts.phoneNumberVerified ? "已验证" : facts.phoneNumberVerified === false ? "未验证" : "验证状态未知"}` : "未绑定"} />
            <Fact label="进行中订单" value={summaryText(facts.orderSummary, "单", scope.orders, PERMISSION.orders)} permission={!scope.orders || facts.orderSummary?.state === "denied" ? PERMISSION.orders : undefined} />
            <Fact label="名下资源账号" value={summaryText(facts.resourceSummary, "个", scope.resources, PERMISSION.resources)} permission={!scope.resources || facts.resourceSummary?.state === "denied" ? PERMISSION.resources : undefined} />
          </> : null}
        </> : <div className="im-rail-permission px-4 py-2">
          <p className="text-xs text-muted-foreground">账号状态、实名与名下账号概况需用户目录读取权限。</p>
          <Popover><PopoverTrigger render={<Button variant="link" size="sm" aria-label="查看用户资料读取权限" />}><Info aria-hidden="true" />权限说明</PopoverTrigger><PopoverContent side="top" aria-label="用户资料读取权限说明" className="w-auto max-w-[260px] text-xs">所需权限：<code>user.directory.read</code></PopoverContent></Popover>
        </div>}
        {state === "error" || profileState === "error" ? <div className="im-rail-retry"><Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}><RefreshCw aria-hidden="true" />重读资料</Button></div> : null}
      </CardContent>
      {showSubject ? <CardFooter className="justify-between gap-3 border-t px-4 py-2.5">
        <span className="shrink-0 text-xs text-muted-foreground">{subject.label}{subject.party ? `（${subject.party}）` : ""}</span>
        <span className="grid min-w-0 justify-items-end gap-0.5 text-right" data-subject-status={subject.resolved ? "resolved" : undefined} data-subject-kind={subject.resolved?.kind}>
          {subject.resolved && subject.resolved.id && onOpenSubject
            ? <Button variant="link" size="sm" className="h-auto max-w-full px-0 text-sm font-medium" data-action="open-subject"
              onClick={() => { const target = subject.resolved; if (target) onOpenSubject({ kind: target.kind, id: target.id }, target.displayNo); }}>{subject.resolved.displayNo}</Button>
            : <span className="im-rail-value min-w-0 max-w-full truncate text-sm font-medium" data-subject-display-no={subject.resolved ? subject.resolved.displayNo : undefined}>{subject.value}</span>}
          {subject.resolved?.title ? <span className="max-w-full truncate text-[11px] text-muted-foreground" title={subject.resolved.title} data-subject-title>{subject.resolved.title}</span> : null}
        </span>
      </CardFooter> : null}
    </Card>
  );
}
