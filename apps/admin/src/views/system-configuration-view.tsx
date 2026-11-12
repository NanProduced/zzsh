import { useCallback, useEffect, useRef, useState } from "react";
import { HardDrive, RefreshCw, ShieldCheck } from "lucide-react";
import { adminRequest, AdminApiError, friendlyError, type SessionSnapshot } from "../api";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
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
      <div><h1 id="system-configuration-title" className="text-xl font-semibold tracking-tight">系统配置</h1><p className="mt-1 text-sm text-muted-foreground">查看当前部署配置与运行检查结果。</p></div>
      <Button type="button" variant="outline" disabled={current.busy} onClick={() => void load()}><RefreshCw aria-hidden="true" />刷新配置</Button>
    </header>
    <section className="mt-6 grid max-w-5xl gap-4 border-b border-border pb-5" aria-labelledby="settlement-refund-settings-title">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 id="settlement-refund-settings-title" className="text-base font-semibold">订单结算</h2><p className="mt-1 text-sm text-muted-foreground">分别设置正常和提前结算的退款等待期，以及新开租清单的自动确认等待期。</p></div>
        <div className="flex flex-wrap gap-2">
          <OpeningAutoConfirmPolicyPanel actorId={snapshot.adminUserId} sessionId={snapshot.session.id} />
          <SettlementRefundPolicyPanel actorId={snapshot.adminUserId} sessionId={snapshot.session.id} />
        </div>
      </div>
    </section>
    <SystemSmsConfigurationPanel key={owner} refreshNonce={refreshNonce}/>
    <AccountImageWatermarkPanel key={`watermark:${owner}`} />
    <div className="mt-5"><StatusMessage error={current.error} /></div>
    {current.busy ? <p className="mt-4 text-sm text-muted-foreground" role="status">正在读取存储配置…</p> : null}
    {data ? <div className="mt-6 max-w-5xl space-y-8">
      <section aria-labelledby="system-media-title">
        <div className="flex flex-wrap items-center gap-2"><HardDrive className="size-4 text-muted-foreground" aria-hidden="true" /><h2 id="system-media-title" className="text-base font-semibold">媒体存储</h2><Badge variant="secondary">{BACKEND_LABEL[data.backend]}</Badge><Badge variant={data.configured ? "info" : "warning"}>{data.configured ? "已装配" : "未装配"}</Badge></div>
        <p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">用于账号图片、游戏目录和运营素材。配置由部署端维护，切换目标前需完成历史图片迁移。</p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span>存储节点：<strong className="text-foreground font-medium">{data.target?.region ?? "本地存储"}</strong></span>
          <span>目标空间：<strong className="text-foreground font-medium">{data.target?.bucket ?? "local"}</strong></span>
          <span>支持格式：<strong className="text-foreground font-medium">{data.limits.allowedMimes.map(mime => mime.replace("image/", "").toUpperCase()).join("/")}</strong> (≤{Number((data.limits.maxBytes / 1024 / 1024).toFixed(0))}MB)</span>
        </div>
        <details className="mt-4 rounded-lg border border-border/70 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground select-none">展开底层连接与技术参数</summary>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {data.target ? Object.entries({ "Bucket": data.target.bucket, "地域": data.target.region, "Endpoint": data.target.endpoint, "对象前缀": data.target.objectPrefix }).map(([label, value]) => <div className="min-w-0" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 break-all font-mono text-[11px]">{value}</dd></div>) : <div><dt className="text-muted-foreground">存储位置</dt><dd className="mt-0.5 text-xs">{data.backend === "local" ? "应用服务器本地目录" : "尚未装配存储适配器"}</dd></div>}
            <div><dt className="text-muted-foreground">凭据方式</dt><dd className="mt-0.5 text-xs">{credentialLabel}</dd></div>
          </dl>
        </details>
        {data.credentialMode === "STS" && data.automaticCredentialRefresh === false ? <div className="mt-4"><StatusMessage tone="warning" error="当前临时凭据不会自动续期，请在部署端安排凭据更新，避免到期后图片无法读写。" /></div> : null}
      </section>
      <section aria-labelledby="system-storage-check-title">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="system-storage-check-title" className="text-base font-semibold">存储读取检查</h2><p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">读取一张已审核公开的运营素材衍生图，并核对内容哈希。检查不会上传或删除对象。</p></div><Button type="button" variant="secondary" disabled={current.busy || !data.configured} onClick={() => void load(true)}><ShieldCheck aria-hidden="true" />检查读取</Button></div>
        <div className="mt-4 flex flex-wrap items-center gap-3" role="status" aria-label="读取检查结果"><Badge variant={readTone}>{READ_LABEL[data.check.state]}</Badge>{data.check.checkedAt ? <span className="text-xs text-muted-foreground">检查于 {contentTime(data.check.checkedAt)}（北京时间）</span> : null}{data.check.integrity === "PASS" ? <span className="text-sm">内容哈希一致</span> : data.check.integrity === "FAILED" ? <span className="text-sm text-destructive">内容哈希不一致</span> : null}</div>
        {data.check.state === "NO_PUBLIC_SAMPLE" ? <p className="mt-3 text-sm text-muted-foreground">尚无可用于检查的公开运营素材，当前结果不能判断存储是否可用。</p> : null}
        {data.check.state === "FAILED" ? <p className="mt-3 text-sm text-destructive">请核对部署端的存储目标、访问权限和对象完整性后重新检查。</p> : null}
        <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">本项仅验证单张公开素材；上传、私有图片权限和历史图片覆盖仍需分别验证。</p>
        <a className="mt-3 inline-flex text-sm underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href="/content?tab=media">前往运营素材验证上传</a>
      </section>
    </div> : null}
  </section>;
}
