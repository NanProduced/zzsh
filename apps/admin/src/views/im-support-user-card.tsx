"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy, Info, RefreshCw } from "lucide-react";
import { AdminApiError, type UserDirectoryDetail } from "../api";
import { PERMISSION } from "./user-directory/user-directory-data";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardTitle } from "../components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemSeparator, ItemTitle } from "../components/ui/item";
import { initialOf } from "./im-support-format";
import { BEIJING_TIME_ZONE } from "../workspace/beijing-time";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

/**
 * Who the operator is actually talking to. The consultation context is authorised by the
 * conversation itself; the account profile needs 用户目录读取 and its two summaries need
 * order / resource-account reads on top of that. Every read is bound to the capability set
 * it was issued under: revoking one of them clears the facts it produced instead of leaving
 * a stale count or a stale 来源 on screen. UNKNOWN never collapses into a friendlier default,
 * and a `ready` summary without a number is never rendered as zero.
 */

type ContextView = {
  consultationId: string;
  user: { status: string; publicId?: string; displayName?: string; avatar?: string | null };
  subject: { status: string; reference?: string };
};
type ContextState = "loading" | "ready" | "denied" | "error";
export type UserProfileScope = { profile: boolean; orders: boolean; resources: boolean };

function subjectView(context: ContextView | null, state: ContextState): { label: string; value: string } {
  if (!context) {
    return {
      label: "关联对象",
      value: state === "loading" ? "正在读取关联对象…" : state === "denied" ? "当前账号无权读取关联对象" : "关联对象暂时不可读取",
    };
  }
  if (context.subject.status === "absent") return { label: "关联对象", value: "尚未关联商品或订单" };
  if (context.subject.status === "unresolved") {
    return { label: "关联引用 · 类型待识别", value: context.subject.reference ? `${context.subject.reference}（类型未识别）` : "引用未提供（类型未识别）" };
  }
  return { label: "关联对象", value: "关联对象类型暂未确认" };
}

const ACCOUNT_STATUS: Record<string, { label: string; tone: "secondary" | "destructive" | "outline" }> = {
  ACTIVE: { label: "账号正常", tone: "secondary" },
  RESTRICTED: { label: "账号受限", tone: "destructive" },
  DEACTIVATED: { label: "已停用", tone: "destructive" },
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
function dayLabel(value: string | null): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: BEIJING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : "暂无记录";
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

export function ConsultationUserCard({ consultationId, rowUserId, fallbackName, scope, request, onOpenProfile }: {
  consultationId: string;
  rowUserId: string;
  fallbackName: string;
  scope: UserProfileScope;
  request: <T>(path: string) => Promise<T>;
  onOpenProfile?: (userId: string) => void;
}) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [profile, setProfile] = useState<UserDirectoryDetail | null>(null);
  const [state, setState] = useState<ContextState>("loading");
  const [profileState, setProfileState] = useState<"idle" | "loading" | "ready" | "denied" | "error">("idle");
  const [copied, setCopied] = useState("");
  const [attempt, setAttempt] = useState(0);
  // One generation per (conversation, capability set, subject): a response that arrives
  // after any of them changed is dropped rather than painted back.
  const readScopeKey = `${consultationId}|${scope.profile ? 1 : 0}${scope.orders ? 1 : 0}${scope.resources ? 1 : 0}|${attempt}`;
  const profileGeneration = useRef("");
  const copyScope = useRef("");

  useEffect(() => {
    let active = true;
    setContext(null); setProfile(null); setState("loading"); setProfileState("idle"); setCopied("");
    profileGeneration.current = "";
    void request<ContextView>(`/im/consultations/${encodeURIComponent(consultationId)}/context`)
      .then((value) => { if (active) { setContext(value); setState("ready"); } })
      .catch((error) => { if (active) setState(denied(error) ? "denied" : "error"); });
    return () => { active = false; };
  }, [consultationId, readScopeKey, request]);

  const userId = context?.user.publicId || rowUserId;
  copyScope.current = `${readScopeKey}|${userId}`;
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
  const avatar = context?.user.avatar || facts?.image || null;
  const subject = subjectView(context, state);
  const identityStatus = facts?.identity?.status || facts?.identityStatus || "UNKNOWN";
  const ageStatus = facts?.identity?.ageStatus || facts?.ageStatus || "UNKNOWN";
  const account = facts ? ACCOUNT_STATUS[facts.accountStatus] ?? ACCOUNT_STATUS.UNKNOWN : null;
  const copyUserId = async () => {
    const expectedScope = copyScope.current;
    try {
      await navigator.clipboard.writeText(userId);
      if (copyScope.current === expectedScope) setCopied("已复制用户ID");
    } catch {
      if (copyScope.current === expectedScope) setCopied("复制失败，请选择原文复制");
    }
  };

  return (
    <TooltipProvider delay={250}><Card className="im-wb-card">
      <CardContent className="grid gap-0 p-0">
        <div className="flex items-start gap-3 px-4 py-3">
          <ItemMedia variant="icon" className="im-wb-avatar" aria-hidden="true">
            {avatar ? <img src={avatar} alt="" /> : initialOf(displayName)}
          </ItemMedia>
          <div className="grid min-w-0 flex-1 gap-1">
            <CardTitle className="line-clamp-2 text-sm leading-snug font-medium">{displayName}</CardTitle>
            <CardDescription className="text-xs leading-normal">
              {facts ? SOURCE_KIND[facts.source.kind] ?? SOURCE_KIND.UNKNOWN : state === "loading" ? "正在读取会话对象…" : "平台用户"}
            </CardDescription>
          </div>
          {scope.profile && userId ? <Button variant="link" size="sm" className="shrink-0" onClick={() => onOpenProfile?.(userId)}>完整资料</Button> : null}
        </div>

        {userId ? <>
          <ItemSeparator />
          <Item size="sm" className="im-rail-fact gap-2 px-4 py-2">
            <ItemContent><ItemDescription className="text-xs">用户ID</ItemDescription></ItemContent>
            <ItemActions className="im-rail-value-actions">
              <span className="im-rail-value text-sm font-medium tabular-nums">{userId}</span>
              <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="im-rail-icon" aria-label="复制用户ID" onClick={() => void copyUserId()} />}>
                {copied.startsWith("已复制") ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </TooltipTrigger><TooltipContent>{copied || "复制用户ID"}</TooltipContent></Tooltip>
            </ItemActions>
          </Item>
        </> : null}

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
              <Badge variant={identityStatus === "VERIFIED" ? "secondary" : "outline"}>{IDENTITY_STATUS[identityStatus] ?? IDENTITY_STATUS.UNKNOWN}</Badge>
              <Badge variant={ageStatus === "MINOR" ? "destructive" : "outline"}>{AGE_STATUS[ageStatus] ?? AGE_STATUS.UNKNOWN}</Badge>
            </div>
            <ItemSeparator />
            <Fact label="脱敏手机号" value={facts.maskedPhone ? `${facts.maskedPhone} · ${facts.phoneNumberVerified ? "已验证" : facts.phoneNumberVerified === false ? "未验证" : "验证状态未知"}` : "未绑定"} />
            <Fact label="脱敏邮箱" value={facts.maskedEmail || "未绑定"} />
            <Fact label="进行中订单" value={summaryText(facts.orderSummary, "单", scope.orders, PERMISSION.orders)} permission={!scope.orders || facts.orderSummary?.state === "denied" ? PERMISSION.orders : undefined} />
            <Fact label="名下资源账号" value={summaryText(facts.resourceSummary, "个", scope.resources, PERMISSION.resources)} permission={!scope.resources || facts.resourceSummary?.state === "denied" ? PERMISSION.resources : undefined} />
            <Fact label="注册时间" value={dayLabel(facts.registeredAt)} />
          </> : null}
        </> : <div className="im-rail-permission px-4 py-2">
          <p className="text-xs text-muted-foreground">账号状态、实名与名下账号概况需用户目录读取权限。</p>
          <Popover><PopoverTrigger render={<Button variant="link" size="sm" aria-label="查看用户资料读取权限" />}><Info aria-hidden="true" />权限说明</PopoverTrigger><PopoverContent side="top" aria-label="用户资料读取权限说明" className="w-auto max-w-[260px] text-xs">所需权限：<code>user.directory.read</code></PopoverContent></Popover>
        </div>}
        {state === "error" || profileState === "error" ? <div className="im-rail-retry"><Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}><RefreshCw aria-hidden="true" />重读资料</Button></div> : null}
      </CardContent>
      <CardFooter className="justify-between gap-3 border-t px-4 py-2.5">
        <span className="shrink-0 text-xs text-muted-foreground">{subject.label}</span>
        <span className="im-rail-value min-w-0 text-sm font-medium">{subject.value}</span>
      </CardFooter>
      {copied ? <p className="im-rail-copy-status" data-state={copied.startsWith("已复制") ? "success" : "error"} role="status">{copied}</p> : null}
    </Card></TooltipProvider>
  );
}
