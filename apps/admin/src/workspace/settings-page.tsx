import { isLocalSettingsPreview } from "./settings-preview";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { ActivityIcon, MonitorIcon, PaletteIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { SettingsView } from "../views/settings-view";
import { SecuritySelfView } from "../views/security-self/security-self-view";
import type { SecurityCommands } from "../views/security-self/model";
import { ProfileView } from "../views/self-settings/profile-view";
import { SessionsView } from "../views/self-settings/sessions-view";
import { ActivityView } from "../views/self-settings/activity-view";
import { readProfile, readSessions, readSecurityActivity } from "../views/self-settings/self-settings-api";
import type { SessionSnapshot } from "../api";
import type { settingsPreviewData } from "./settings-preview-data";

const SECTIONS = [
  { id: "appearance", label: "外观与偏好", icon: PaletteIcon },
  { id: "profile", label: "个人资料", icon: UserRoundIcon },
  { id: "security", label: "登录与安全", icon: ShieldCheckIcon },
  { id: "sessions", label: "设备与会话", icon: MonitorIcon },
  { id: "activity", label: "安全活动", icon: ActivityIcon },
] as const;
type Section = typeof SECTIONS[number]["id"];
type Props = ComponentProps<typeof SettingsView> & {
  query: Record<string, string>;
  legacyAccount?: boolean;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onDirtyChange: (dirty: boolean) => void;
  onQueryChange: (query: Record<string, string>) => void;
};

// 当前4382尚未准入新安全写；没有真实写适配器，DOM/快捷键绕过禁用也不会发POST。
const WRITE_DISABLED = "本轮仅验收页面，真实修改暂未开放。表单可查看，提交已禁用。";
const SECURITY_DISABLED = "本轮仅验收界面，请勿输入真实密码或 PIN；提交、锁定和恢复操作暂未开放。";
const unavailable = async (): Promise<never> => { throw new Error("安全操作暂未开放"); };
const blockedCommands: SecurityCommands = {
  changePassword: unavailable, setPin: unavailable, changePin: unavailable,
  generateBackupCodes: unavailable, readOperation: unavailable,
};

export function SettingsWorkspace(props: Props) {
  const { query, legacyAccount, snapshot, onOpenPath, onDirtyChange, onQueryChange } = props;
  const requested = legacyAccount ? "security" : query.section ?? "appearance";
  const section: Section = SECTIONS.find((item) => item.id === requested)?.id ?? "appearance";
  const hasDataPage = section === "profile" || section === "sessions" || section === "activity";
  const allowExamples = isLocalSettingsPreview();
  const preview = allowExamples && hasDataPage && query.preview === "1";
  const [previewFactory, setPreviewFactory] = useState<typeof settingsPreviewData>();
  useEffect(() => {
    if (!preview || !import.meta.env.DEV) return;
    let cancelled = false;
    void import("./settings-preview-data").then((module) => {
      if (!cancelled) setPreviewFactory(() => module.settingsPreviewData);
    });
    return () => { cancelled = true; };
  }, [preview]);
  const examples = useMemo(() => previewFactory?.(snapshot.adminUserId, snapshot.session.id),
    [previewFactory, snapshot.adminUserId, snapshot.session.id]);
  const pathFor = (next: Section, example = query.preview === "1") => {
    const params = new URLSearchParams({ section: next });
    if (allowExamples && example) params.set("preview", "1");
    return `/settings?${params}`;
  };
  const common = {
    adminUserId: snapshot.adminUserId, sessionId: snapshot.session.id,
    accountStatus: snapshot.security.status, locked: snapshot.session.locked,
    onDirtyChange, onSessionRefresh: props.onRefresh,
  };
  let content;
  if (section === "appearance") content = <SettingsView {...props} onOpenPath={(path, title) => onOpenPath(path === "/account" ? pathFor("security") : path, title)} />;
  else if (section === "security") content = <SecuritySelfView
    adminUserId={snapshot.adminUserId}
    accountLabel={[snapshot.user.displayUsername ?? snapshot.user.username, snapshot.user.name].filter(Boolean).join(" · ")}
    accountStatus={snapshot.security.status} twoFactorEnabled={snapshot.user.twoFactorEnabled}
    session={snapshot.session} idleMinutes={props.idleMinutes}
    commands={blockedCommands} commandsUnavailableReason={SECURITY_DISABLED}
    refreshSession={async () => {
      const next = await props.onRefresh();
      return next.authenticated ? { accountStatus: next.security.status, twoFactorEnabled: next.user.twoFactorEnabled, session: next.session } : null;
    }}
    onIdleMinutesChange={props.onIdleMinutes} onLockSession={() => undefined} onOpenRecovery={() => undefined}
    onDirtyChange={onDirtyChange}
  />;
  else if (preview && !examples) content = <p className="p-6 text-sm text-muted-foreground" role="status">正在打开示例布局…</p>;
  else if (section === "profile") content = <ProfileView {...common}
    load={preview ? examples!.readProfile : readProfile} writeDisabledReason={WRITE_DISABLED} />;
  else if (section === "sessions") content = <SessionsView {...common}
    load={preview ? examples!.readSessions : readSessions} writeDisabledReason={WRITE_DISABLED} />;
  else content = <ActivityView {...common}
    load={preview ? examples!.readActivity : readSecurityActivity}
    initialQuery={query} onQueryChange={(values) => onQueryChange({ ...query, ...values })} />;

  return <div className="mx-auto grid w-full max-w-7xl min-w-0 gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
    <nav aria-label="个人设置分区" className="flex flex-wrap gap-1 border-b border-border pb-3 md:sticky md:top-4 md:flex-col md:flex-nowrap md:self-start md:border-b-0 md:pb-0">
      {SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={pathFor(id)}
        aria-current={section === id ? "page" : undefined}
        onClick={(event) => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenPath(pathFor(id)); }}
        className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${section === id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}>
        <Icon className="size-4 shrink-0" aria-hidden />{label}
      </a>)}
    </nav>
    <div className="min-w-0">
      {section === "security" ? <p className="mx-4 mb-2 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground" role="status">
        当前账号与会话状态来自真实登录；{SECURITY_DISABLED}
      </p> : null}
      {hasDataPage ? <div className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
        <p role="status">{preview ? "示例布局预览：资料、会话与活动为演示数据，不代表当前账号；不会保存或注销任何真实会话。" : "当前环境尚未接入本人设置数据，真实修改暂未开放。可切换示例布局查看页面效果。"}</p>
        {allowExamples ? <Button size="sm" variant="secondary" onClick={() => onOpenPath(pathFor(section, !preview))}>
          {preview ? "返回真实读取" : "查看示例布局"}
        </Button> : null}
      </div> : null}
      <div key={`${section}:${preview}`}>{content}</div>
    </div>
  </div>;
}
