import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { ActivityIcon, MonitorIcon, PaletteIcon, ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { SettingsView } from "../views/settings-view";
import { SecuritySelfView } from "../views/security-self/security-self-view";
import { securityCommands } from "../views/security-self/security-commands-api";
import { RecoveryView } from "../views/recovery-view";
import { ProfileView } from "../views/self-settings/profile-view";
import { SessionsView } from "../views/self-settings/sessions-view";
import { ActivityView } from "../views/self-settings/activity-view";
import { readProfile, readSessions, readSecurityActivity, revokeOtherSessions, revokeSession } from "../views/self-settings/self-settings-api";
import type { SessionSnapshot } from "../api";
import { isLocalSettingsPreview } from "./settings-preview";
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
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onRecoveryCompleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onQueryChange: (query: Record<string, string>) => void;
};

// 本人资料改名尚未开放：精确说明只读范围，不宣称读取未接通。
const WRITE_DISABLED = "个人资料仅供查看。";

export function SettingsWorkspace(props: Props) {
  const { query, snapshot, onOpenPath, onDirtyChange, onQueryChange } = props;
  const section: Section = SECTIONS.find((item) => item.id === (query.section ?? "appearance"))?.id ?? "appearance";
  const hasDataPage = section === "profile" || section === "sessions" || section === "activity";
  // 让生产构建直接移除示例界面，而不只依赖运行时端口判断。
  const allowExamples = import.meta.env.DEV && isLocalSettingsPreview();
  const preview = allowExamples && hasDataPage && query.preview === "1";
  const [previewFactory, setPreviewFactory] = useState<typeof settingsPreviewData>();
  const [recoveryOpen, setRecoveryOpen] = useState(false);
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
    commands={securityCommands}
    refreshSession={async () => {
      const next = await props.onRefresh();
      return next.authenticated ? { accountStatus: next.security.status, twoFactorEnabled: next.user.twoFactorEnabled, session: next.session } : null;
    }}
    onIdleMinutesChange={props.onIdleMinutes} onLockSession={props.onLock} onOpenRecovery={() => setRecoveryOpen(true)}
    onDirtyChange={onDirtyChange}
  />;
  else if (preview && !examples) content = <p className="p-6 text-sm text-muted-foreground" role="status">正在打开示例布局…</p>;
  else if (section === "profile") content = <ProfileView {...common}
    load={preview ? examples!.readProfile : readProfile} writeDisabledReason={WRITE_DISABLED} />;
  else if (section === "sessions") content = <SessionsView {...common}
    load={preview ? examples!.readSessions : readSessions}
    {...(preview ? { writeDisabledReason: "示例布局不会注销任何真实会话。" } : { revokeSession, revokeOtherSessions })} />;
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
      {hasDataPage && (preview || allowExamples) ? <div className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
        {preview ? <p role="status">示例布局预览：资料、会话与活动为演示数据，不代表当前账号；不会保存或注销任何真实会话。</p> : null}
        {allowExamples ? <Button size="sm" variant="secondary" onClick={() => onOpenPath(pathFor(section, !preview))}>
          {preview ? "返回真实读取" : "查看示例布局"}
        </Button> : null}
      </div> : null}
      <div key={`${section}:${preview}`}>{content}</div>
    </div>
    <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogTitle>管理员恢复</DialogTitle>
        <RecoveryView snapshot={snapshot} onCompleted={() => { setRecoveryOpen(false); props.onRecoveryCompleted(); }} />
      </DialogContent>
    </Dialog>
  </div>;
}
