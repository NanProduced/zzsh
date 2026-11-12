import { useCallback, useEffect, useRef, useState } from "react";
import { HardDrive, RefreshCw, ShieldCheck } from "lucide-react";
import { adminRequest, AdminApiError, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { InfoTip } from "../components/ui/tooltip";
import { StatusMessage } from "../components/ui-elements";
import { contentTime } from "./content-resources-model";
import { SettlementRefundPolicyPanel } from "./settlement-refund-policy-panel";
import { OpeningAutoConfirmPolicyPanel } from "./opening-auto-confirm-policy-panel";
import { SystemSmsConfigurationPanel } from "./system-sms-configuration-panel";
import { AccountImageWatermarkPanel } from "./account-image-watermark-panel";

export type SystemStorageConfiguration = {
  backend: "local" | "oss" | "unavailable";
  configured: boolean;
  configurationSource: "DEPLOYMENT_ENVIRONMENT";
  target: { bucket: string; region: string; endpoint: string; objectPrefix: string } | null;
  credentialMode: "NOT_APPLICABLE" | "ACCESS_KEY" | "STS";
  automaticCredentialRefresh: boolean | null;
  limits: { maxBytes: number; allowedMimes: string[] };
  check: {
    state: "NOT_RUN" | "NO_PUBLIC_SAMPLE" | "PASS" | "FAILED";
    checkedAt: string | null;
    scope: "PUBLIC_CONTENT_DERIVATIVE";
    integrity: "NOT_RUN" | "PASS" | "FAILED";
  };
};

export function parseSystemStorageConfiguration(value: unknown): SystemStorageConfiguration {
  const v = value as SystemStorageConfiguration;
  const text = (item: unknown): item is string => typeof item === "string" && item.length > 0 && item.length <= 1024;
  if (!v || !["local", "oss", "unavailable"].includes(v.backend) || typeof v.configured !== "boolean"
    || v.configurationSource !== "DEPLOYMENT_ENVIRONMENT" || !["NOT_APPLICABLE", "ACCESS_KEY", "STS"].includes(v.credentialMode)
    || v.automaticCredentialRefresh !== null && typeof v.automaticCredentialRefresh !== "boolean"
    || !v.limits || !Number.isSafeInteger(v.limits.maxBytes) || v.limits.maxBytes <= 0 || !Array.isArray(v.limits.allowedMimes)
    || v.limits.allowedMimes.length > 16 || !v.limits.allowedMimes.every(text)
    || !v.check || !["NOT_RUN", "NO_PUBLIC_SAMPLE", "PASS", "FAILED"].includes(v.check.state)
    || v.check.scope !== "PUBLIC_CONTENT_DERIVATIVE" || !["NOT_RUN", "PASS", "FAILED"].includes(v.check.integrity)
    || v.check.checkedAt !== null && (!text(v.check.checkedAt) || Number.isNaN(Date.parse(v.check.checkedAt)))
    || v.target !== null && (!v.target || ![v.target.bucket, v.target.region, v.target.endpoint, v.target.objectPrefix].every(text))
    || v.backend === "oss" && v.target === null) throw new AdminApiError(502, "SYSTEM_STORAGE_CONTRACT_REQUIRED");
  return v;
}

const BACKEND_LABEL = { local: "本地存储", oss: "阿里云 OSS", unavailable: "未装配" } as const;
const READ_LABEL = { NOT_RUN: "尚未检查", NO_PUBLIC_SAMPLE: "无公开样本", PASS: "样本读取通过", FAILED: "样本读取失败" } as const;

export function SystemConfigurationView({ snapshot, refreshNonce = 0 }: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  refreshNonce?: number;
}) {
  const allowed = snapshot.security.isBoss && snapshot.security.status === "ACTIVE"
    && !snapshot.session.locked && !snapshot.security.passwordChangeRequired;
  const owner = `${snapshot.adminUserId}:${snapshot.session.id}:${allowed}`;
  const liveOwner = useRef(owner); liveOwner.current = owner;
  const sequence = useRef(0), active = useRef<AbortController | null>(null);
  const technicalTrigger = useRef<HTMLButtonElement>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [state, setState] = useState<{ owner: string; data: SystemStorageConfiguration | null; busy: boolean; error: string }>({ owner, data: null, busy: false, error: "" });
  const current = state.owner === owner ? state : { owner, data: null, busy: false, error: "" };
  const load = useCallback(async (check = false) => {
    if (!allowed) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const request = ++sequence.current;
    const isCurrent = () => liveOwner.current === owner && sequence.current === request && !controller.signal.aborted;
    setState({ owner, data: null, busy: true, error: "" });
    try {
      const data = parseSystemStorageConfiguration(await adminRequest<unknown>(check ? "/system/storage/check" : "/system/storage", undefined, "GET", {}, controller.signal));
      if (isCurrent()) setState({ owner, data, busy: false, error: "" });
    } catch (error) {
      if (isCurrent()) setState({ owner, data: null, busy: false, error: friendlyError(error) });
    }
  }, [allowed, owner]);
  useEffect(() => {
    void load();
    return () => { ++sequence.current; active.current?.abort(); };
  }, [load, refreshNonce]);

  if (!allowed) return <section className="p-4 sm:p-6"><h1 className="text-xl font-semibold">系统配置</h1><div className="mt-5"><StatusMessage error={snapshot.session.locked ? "当前会话已锁定，请解锁后查看。" : snapshot.security.status !== "ACTIVE" || snapshot.security.passwordChangeRequired ? "当前管理身份需完成安全验证后查看。" : "仅 Boss 可查看部署配置。"} /></div></section>;
  const data = current.data;
  const credentialLabel = data?.credentialMode === "STS" ? "STS 临时凭据" : data?.credentialMode === "ACCESS_KEY" ? "服务端访问密钥" : "不适用";
  const readTone = data?.check.state === "PASS" ? "success" : data?.check.state === "FAILED" ? "destructive" : data?.check.state === "NO_PUBLIC_SAMPLE" ? "warning" : "unknown";
  return <section className="min-w-0 p-4 sm:p-6" aria-labelledby="system-configuration-title">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <h1 id="system-configuration-title" className="text-xl font-semibold tracking-tight">系统配置</h1>
      <Button type="button" variant="outline" disabled={current.busy} onClick={() => void load()}><RefreshCw aria-hidden="true" />刷新配置</Button>
    </header>
    <section className="mt-6 max-w-5xl border-b border-border pb-5" aria-labelledby="settlement-refund-settings-title">
      <h2 id="settlement-refund-settings-title" className="text-base font-semibold">订单结算</h2>
      <div className="mt-1 divide-y divide-border/60">
        <OpeningAutoConfirmPolicyPanel actorId={snapshot.adminUserId} sessionId={snapshot.session.id} />
        <SettlementRefundPolicyPanel actorId={snapshot.adminUserId} sessionId={snapshot.session.id} />
      </div>
    </section>
    <SystemSmsConfigurationPanel key={owner} refreshNonce={refreshNonce}/>
    <AccountImageWatermarkPanel key={`watermark:${owner}`} canReadMedia={hasPermission(snapshot, "content.platform.read")}
      canUploadMedia={hasPermission(snapshot, "content.platform.edit")} canReviewMedia={hasPermission(snapshot, "content.platform.publish")} />
    <div className="mt-5"><StatusMessage error={current.error} /></div>
    {current.busy ? <p className="mt-4 text-sm text-muted-foreground" role="status">正在读取存储配置…</p> : null}
    {data ? <div className="mt-6 max-w-5xl space-y-8">
      <section aria-labelledby="system-media-title">
        <div className="flex flex-wrap items-center gap-2">
          <HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 id="system-media-title" className="text-base font-semibold">媒体存储</h2>
          <Badge variant="secondary">{BACKEND_LABEL[data.backend]}</Badge>
          <Badge variant={data.configured ? "info" : "warning"}>{data.configured ? "已装配" : "未装配"}</Badge>
          <InfoTip label="媒体存储配置说明" title="配置由部署端维护" body="切换存储目标前需完成历史图片迁移。" />
          <Button ref={technicalTrigger} type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setTechnicalOpen(true)}>技术参数</Button>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0"><dt className="text-muted-foreground">存储节点</dt><dd className="mt-0.5 break-all font-medium text-foreground">{data.target?.region ?? "本地存储"}</dd></div>
          <div className="min-w-0"><dt className="text-muted-foreground">目标空间</dt><dd className="mt-0.5 break-all font-medium text-foreground">{data.target?.bucket ?? "local"}</dd></div>
          <div className="min-w-0"><dt className="text-muted-foreground">支持格式</dt><dd className="mt-0.5 break-all font-medium text-foreground">{data.limits.allowedMimes.map(mime => mime.replace("image/", "").toUpperCase()).join("/")} · ≤{Number((data.limits.maxBytes / 1024 / 1024).toFixed(0))}MB</dd></div>
          <div className="min-w-0"><dt className="text-muted-foreground">凭据方式</dt><dd className="mt-0.5 break-all font-medium text-foreground">{credentialLabel}</dd></div>
        </dl>
        <Dialog open={technicalOpen} onOpenChange={setTechnicalOpen}><DialogContent size="md" finalFocus={technicalTrigger} className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
          <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12">
            <DialogTitle>技术参数</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">部署端维护的存储连接信息；通常无需在管理端修改。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <dl className="divide-y divide-border/60 text-[13px]">
              {data.target ? Object.entries({ "存储空间": data.target.bucket, "地域": data.target.region, "接入地址": data.target.endpoint, "对象前缀": data.target.objectPrefix }).map(([label, value]) => <div key={label} className="grid gap-1 py-2.5 first:pt-0 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:items-start sm:gap-4">
                <dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono text-xs leading-relaxed text-foreground">{value}</dd>
              </div>) : <div className="grid gap-1 py-2.5 first:pt-0 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:items-start sm:gap-4">
                <dt className="text-muted-foreground">存储位置</dt><dd className="text-[13px]">{data.backend === "local" ? "应用服务器本地目录" : "尚未装配存储适配器"}</dd>
              </div>}
              <div className="grid gap-1 py-2.5 last:pb-0 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:items-start sm:gap-4">
                <dt className="text-muted-foreground">凭据方式</dt><dd className="text-[13px] font-medium">{credentialLabel}</dd>
              </div>
            </dl>
          </div>
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setTechnicalOpen(false)}>关闭</Button>
          </div>
        </DialogContent></Dialog>
        {data.credentialMode === "STS" && data.automaticCredentialRefresh === false ? <div className="mt-4"><StatusMessage tone="warning" error="临时凭据不会自动续期，到期后图片无法读写；请在部署端更新凭据。" /></div> : null}
      </section>
      <section aria-labelledby="system-storage-check-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="system-storage-check-title" className="text-base font-semibold">存储读取检查</h2>
            <InfoTip label="存储读取检查说明" title="检查范围" body="只读取一张已审核公开的运营素材衍生图并核对内容哈希；不会上传或删除对象。" />
          </div>
          <Button type="button" variant="secondary" disabled={current.busy || !data.configured} onClick={() => void load(true)}><ShieldCheck aria-hidden="true" />检查读取</Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3" role="status" aria-label="读取检查结果"><Badge variant={readTone}>{READ_LABEL[data.check.state]}</Badge>{data.check.checkedAt ? <span className="text-xs text-muted-foreground">检查于 {contentTime(data.check.checkedAt)}（北京时间）</span> : null}{data.check.integrity === "PASS" ? <span className="text-sm">内容哈希一致</span> : data.check.integrity === "FAILED" ? <span className="text-sm text-destructive">内容哈希不一致</span> : null}</div>
        {data.check.state === "NO_PUBLIC_SAMPLE" ? <p className="mt-3 text-sm text-muted-foreground">暂无公开样本，不能判断存储是否可用。</p> : null}
        {data.check.state === "FAILED" ? <p className="mt-3 text-sm text-destructive">核对存储目标、权限与对象完整性后重试。</p> : null}
        <a className="mt-3 inline-flex text-sm underline underline-offset-4" href="/content?tab=media">前往运营素材验证上传</a>
      </section>
    </div> : null}
  </section>;
}
