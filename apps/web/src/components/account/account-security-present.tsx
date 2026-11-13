"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Laptop, Monitor, MoreHorizontal, Smartphone, Tablet, X, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { browserTimezone } from "@/components/account/network-info";

export type Overview = { userId: string; nickname: string; phoneNumber: string | null; email: string | null; passwordState: "set" | "not-set" | "unavailable" };
export type Session = { id: string; isCurrent: boolean; createdAt: string; expiresAt: string; userAgent: string | null };
export type Action = "password" | "email" | "phone";
export type Scope = "one" | "others" | "all";

const beijing = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
/** 设计稿采用 2026.10.13 09:12 的点分紧凑式；用 formatToParts 组装，避免随 locale 漂回年月日。 */
export const sessionTime = (value: string) => {
  const parts = Object.fromEntries(beijing.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
};

/**
 * 设备名称只是浏览器自报 UA 的保守展示派生，不是可信设备证明。
 * missing: 登录时没有 UA 记录
 * unrecognized: 有 UA 但认不出
 * known: 保守派生成功
 */
export type ClientInfo = {
  record: "missing" | "unrecognized" | "known";
  label: string;
  kind: string;
  os: string | null;
  browser: string | null;
  device: "desktop" | "mobile" | "tablet" | "unknown";
};

export function describeClient(userAgent: string | null | undefined): ClientInfo {
  const ua = userAgent?.trim() ?? "";
  if (!ua) return { record: "missing", label: "设备信息未知", kind: "无法确认", os: null, browser: null, device: "unknown" };
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPod/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Mac OS X/i.test(ua) ? "macOS" : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : null;
  const browser = /CriOS\//.test(ua) ? "Chrome" : /FxiOS\//.test(ua) ? "Firefox" : /EdgiOS\//.test(ua) ? "Edge" : /OPiOS\//.test(ua) ? "Opera" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  if (!os && !browser) return { record: "unrecognized", label: "客户端未识别", kind: "无法确认", os: null, browser: null, device: "unknown" };
  return {
    record: "known",
    label: os && browser ? `${os} · ${browser}` : os ?? browser ?? "客户端未识别",
    kind: /Mobile|Android|iPhone|iPad|Windows Phone|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "移动端网页" : "桌面端网页",
    os: os ?? null,
    browser: browser ?? null,
    device: os === "iPad" ? "tablet" : /Mobile|Android|iPhone|iPad|Windows Phone|CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua) ? "mobile" : "desktop",
  };
}

export const clientIcon = (client: ClientInfo): LucideIcon =>
  client.record !== "known" ? Monitor : client.device === "tablet" ? Tablet : client.device === "mobile" ? Smartphone : Laptop;

export function WorkflowSubtitle({
  action,
  stage,
  ready,
  target,
  overview,
}: {
  action: Action;
  stage: "current" | "target";
  ready: boolean;
  target: string;
  overview: Overview;
}) {
  if (action === "password") {
    if (!ready) {
      return (
        <p className="sec-dialog-sub">
          为保障账号安全，请先完成当前账号的身份核验。
        </p>
      );
    }
    return (
      <p className="sec-dialog-sub">
        请设置 12–128 位的新登录密码，建议使用密码管理器生成。
      </p>
    );
  }
  if (action === "phone") {
    if (ready) {
      return (
        <p className="sec-dialog-sub">
          新手机号已通过验证，点击下方按钮即可完成换绑。
        </p>
      );
    }
    if (stage === "target") {
      return (
        <p className="sec-dialog-sub">
          验证码已发送至新手机号 <strong>+86 {target}</strong>，请输入以完成绑定。
        </p>
      );
    }
    return (
      <p className="sec-dialog-sub">
        为保障账号安全，请填写新手机号并验证当前手机。
      </p>
    );
  }
  return null;
}

export function StepList({ action, proof, targetProof }: { action: Action; proof: string; targetProof: string }) {
  const steps = action === "password" ? ["验证身份", "设置新密码"] : ["验证现有身份", "验证新联系方式", "完成换绑"];
  const index = action === "password" ? proof ? 1 : 0 : targetProof ? 2 : proof ? 1 : 0;
  return (
    <ol className="sec-steps" aria-label="操作步骤">
      {steps.map((label, position) => {
        const isDone = position < index;
        const isCurrent = position === index;
        return (
          <li
            key={label}
            aria-current={isCurrent ? "step" : undefined}
            data-state={isDone ? "done" : isCurrent ? "current" : "todo"}
            className={`sec-step-item${isDone ? " is-done" : isCurrent ? " is-current" : ""}`}
          >
            <div className="sec-step-indicator">
              <span className="sec-step-badge">
                {isDone ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : position + 1}
              </span>
              {position < steps.length - 1 ? <span className="sec-step-line" aria-hidden="true" /> : null}
            </div>
            <span className="sec-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function RevokeCopy({ scope, count }: { scope: Scope; count: number }) {
  if (scope === "all") return <p>将退出该账号下的全部有效会话，<strong>包括当前会话</strong>，确认后需要重新登录。</p>;
  if (scope === "others") return <p>将退出除当前会话以外的全部有效会话（本次读取到 {count} 个），当前会话继续保留。</p>;
  return <p>只退出下面这一个会话，其他会话与当前会话不受影响。</p>;
}

function LoginRecordBody({ client }: { client: ClientInfo }) {
  return <>
    {client.record === "known" ? <dl className="sec-record-grid">
      <div><dt>系统</dt><dd>{client.os}</dd></div>
      <div><dt>浏览器</dt><dd>{client.browser}</dd></div>
      <div><dt>客户端类型</dt><dd>{client.kind}</dd></div>
    </dl> : <p className="sec-record-missing">{client.record === "missing" ? "登录时未记录客户端信息。" : "登录时记录的客户端信息无法识别，未推断设备名称。"}</p>}
    <p className="sec-record-footnote">客户端信息由登录时浏览器自行提供的 User-Agent 派生，仅供辨认，不构成可信设备证明。</p>
  </>;
}

/** 当前会话卡片 */
export function CurrentSessionSummary({ item }: { item: Session }) {
  const local = describeClient(typeof navigator === "undefined" ? null : navigator.userAgent);
  const Icon = clientIcon(local);

  return (
    <div className="sec-current-card">
      <div className="sec-current-hero">
        <div className="sec-current-icon-cell">
          <Icon className="sec-current-icon" size={26} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <div className="sec-current-identity">
          <div className="sec-current-title-row">
            <strong className="sec-current-title" id="sec-current-session-heading">
              {local.record === "known" ? local.label : local.record === "missing" ? "当前浏览器信息未知" : "客户端未识别"}
            </strong>
            <span className="sec-badge sec-badge--current">当前会话</span>
            <span className="sec-card-note sec-note-inline">这是您正在使用的这个浏览器的信息，不会更新到其他会话。</span>
          </div>
          <span className="sec-current-sub">
            当前浏览器 · {local.record === "known" ? local.kind : "设备类型未知"}
          </span>
        </div>
        <dl className="sec-current-timezone">
          <div><dt>浏览器时区</dt><dd>{browserTimezone()}</dd></div>
        </dl>
      </div>

      <div className="sec-divider" />

      <div className="sec-current-bottom">
        <dl className="sec-current-meta">
          <div><dt>登录时间</dt><dd>{sessionTime(item.createdAt)}</dd></div>
          <div><dt>到期时间</dt><dd>{sessionTime(item.expiresAt)}</dd></div>
        </dl>
      </div>
    </div>
  );
}

export function SessionRow({ item, locked, onAsk }: { item: Session; locked: boolean; onAsk: (scope: Scope, item: Session) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const detailId = useId();
  const client = describeClient(item.userAgent);
  const Icon = clientIcon(client);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="sec-session" data-record={client.record} data-session-id={item.id}>
      <div className="sec-session-client">
        <Icon className="sec-session-icon" size={18} strokeWidth={1.5} aria-hidden="true" />
        <div className="sec-session-title">
          <strong>{client.label}</strong>
          <span className="sec-session-sub">登录于 {sessionTime(item.createdAt)}</span>
        </div>
      </div>

      <div className="sec-session-when">
        <span className="sec-session-when-label">到期时间</span>
        <time className="sec-session-when-time">{sessionTime(item.expiresAt)}</time>
      </div>

      <div className="sec-session-action">
        <div className="sec-row-menu-wrapper" ref={menuRef}>
          <button
            type="button"
            className="button outline sec-tool-icon-btn sec-row-more-btn"
            aria-label={`操作会话: ${client.label}`}
            aria-expanded={menuOpen}
            disabled={locked}
            onClick={() => setMenuOpen(v => !v)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
          <div className="sec-dropdown-menu" hidden={!menuOpen}>
            <button
              type="button"
              className="sec-dropdown-item sec-session-expand"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={expanded ? "收起" : "详情"}
              onClick={() => {
                setMenuOpen(false);
                setExpanded(v => !v);
              }}
            >
              {expanded ? "收起" : "查看详情"}
            </button>
            <button
              type="button"
              className="sec-dropdown-item is-danger"
              disabled={locked}
              onClick={() => {
                setMenuOpen(false);
                onAsk("one", item);
              }}
            >
              退出此会话
            </button>
          </div>
        </div>
      </div>

      <div className="sec-session-detail" id={detailId} hidden={!expanded}>
        <LoginRecordBody client={client} />
      </div>
    </div>
  );
}

export function SecurityInfoTip() {
  const [open, setOpen] = useState(false);
  const origin = useRef<string>("");
  const wrapper = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open || origin.current !== "touch") return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (wrapper.current?.contains(target as Node)) return;
      if (target?.closest?.(".app-tooltip-content")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <span className="sec-info" ref={wrapper}>
      <TooltipProvider delayDuration={180} skipDelayDuration={100}>
        <Tooltip open={open} onOpenChange={setOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="sec-info-trigger"
              aria-label="修改安全设置会影响哪些会话？"
              onPointerDown={event => { origin.current = event.pointerType; if (event.pointerType === "touch") setOpen(value => !value); }}
              onClick={event => { if (origin.current === "touch") event.preventDefault(); }}
            >
              <span aria-hidden="true">?</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="sec-info-content">
            <strong>修改安全设置会影响哪些会话？</strong>
            <p>修改成功后，其他会话将退出；当前会话更新，到期时间不变。</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

export function SecurityDialog({ open, onClose, title, description, steps, children, onConfirm, confirmLabel, cancelLabel, handFocus = false, onOpened }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; steps?: ReactNode; children: ReactNode; onConfirm?: () => void; confirmLabel?: string; cancelLabel?: string; handFocus?: boolean; onOpened?: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="sec-dialog" onOpenAutoFocus={event => { if (!onOpened) return; event.preventDefault(); onOpened(); }} onCloseAutoFocus={event => { if (handFocus) event.preventDefault(); }}>
          <Dialog.Title>{title}</Dialog.Title>
          {steps ? <Dialog.Description asChild><div>{steps}</div></Dialog.Description> : null}
          {description ? <Dialog.Description asChild><div>{description}</div></Dialog.Description> : null}
          {children}
          {onConfirm ? <div className="sec-dialog-actions"><button type="button" className="button quiet" onClick={onClose}>{cancelLabel}</button><button type="button" className="button secondary sec-danger" onClick={onConfirm}>{confirmLabel}</button></div> : null}
          <Dialog.Close className="icon-button dialog-close" aria-label="关闭对话框"><X size={18} aria-hidden="true" /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
