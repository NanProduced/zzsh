"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircle,
  ArrowRight,
  Bean,
  Box,
  Check,
  CircleHelp,
  Crosshair,
  HardHat,
  Info,
  LogIn,
  Shield,
  ShieldCheck,
  Ticket,
  TriangleAlert,
  X,
} from "lucide-react";
import { ManagedNoticeSections } from "@/components/content/managed-notice";
import { usePublicContent } from "@/components/content/public-content-provider";
import { type SupplyRequestError } from "../../lib/supply-client";
import { canonicalResourceCode } from "../../lib/listing-filters";
import type { PublishingOptions } from "../../lib/supply-types";
import {
  INVENTORY_ITEM_ART,
  INSURANCE_EXPERIENCE_CARD,
  inferNoticeKind,
  localizedErrorMessage,
} from "./publish-form-helpers";
import type { PublishGroupId } from "./publish-form-types";

export function FieldError({ text, id }: { text?: string; id?: string }) {
  return text ? <span id={id} className="supply-field-error" role="alert">{text}</span> : null;
}

export function Notice({ error, text, onDismiss }: { error?: SupplyRequestError | null; text?: string; onDismiss?: () => void }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    // Keep error alerts visible until dismissed or cleared; auto-dismiss status notices only.
    if (error || !text) return;
    const timer = setTimeout(() => {
      setDismissed(true);
      onDismiss?.();
    }, 5000);
    return () => clearTimeout(timer);
  }, [text, error, onDismiss]);

  if (dismissed || (!error && !text)) return null;

  const kind = error ? "error" : inferNoticeKind(text ?? "");
  const Icon = kind === "error" ? AlertCircle : kind === "warning" ? TriangleAlert : kind === "info" ? Info : Check;

  return (
    <div
      className={`supply-notice supply-floating-notice ${error ? "is-error" : ""}`}
      data-kind={kind}
      role={error ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="supply-notice-content">
        <Icon size={18} aria-hidden="true" />
        <span>{error ? (error.status === 0 || error.status >= 500 ? "系统问题，请联系客服。" : localizedErrorMessage(error.message)) : text}</span>
      </div>
      <button
        type="button"
        className="supply-notice-close"
        onClick={() => {
          setDismissed(true);
          onDismiss?.();
        }}
        aria-label="关闭提示"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export function AgreementBody({ body }: { body: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!/<\/?[a-z][^>]*>/i.test(body)) { setText(body); return; }
    // Legacy agreements contain HTML. Parse inertly and render text only;
    // the original body remains unchanged in the signed server version.
    const doc = new DOMParser().parseFromString(body, "text/html");
    doc.querySelectorAll("script,style,iframe,object,template").forEach((node) => node.remove());
    doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    doc.querySelectorAll("p,h1,h2,h3,h4,li,tr").forEach((node) => node.append("\n"));
    doc.querySelectorAll("td,th").forEach((node) => node.append("\t"));
    setText(doc.body.textContent ?? "");
  }, [body]);
  return <div className="publish-terms-body">{text ?? "正在读取条款正文…"}</div>;
}

export function SectionCard({ id, title, hasError, headerMeta, children, actions }: { id: PublishGroupId; title: string; hasError: boolean; headerMeta?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section id={`publish-group-${id}`} data-publish-group={id} aria-labelledby={`publish-heading-${id}`} className={`publish-section-card${hasError ? " is-error" : ""}`}>
    <header className="publish-section-header">
      <h2 id={`publish-heading-${id}`} className="publish-section-title publish-group-title">{title}</h2>
      {headerMeta}
    </header>
    <div id={`publish-panel-${id}`} className="publish-section-body">{children}</div>
    {actions}
  </section>;
}

export function PublishVisualBanner() {
  return <section className="publish-visual-banner" aria-labelledby="publish-banner-title">
    <h1 id="publish-banner-title" className="sr-only">上架出租</h1>
    <picture>
      <source media="(max-width:600px)" srcSet="/art/zhouzhou/publish-banner-approved-mobile-v1.png" width={1050} height={378} />
      <img className="publish-visual-banner-image" src="/art/zhouzhou/publish-banner-approved-v1.png" width={2141} height={251} alt="填写资料，核对报价后确认上架。流程：填写资料、核对报价、确认上架。" fetchPriority="high" decoding="async" />
    </picture>
  </section>;
}

export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <TooltipPrimitive.Provider delayDuration={180}>
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild><button type="button" className="publish-field-help" aria-label={`${label}说明`} onClick={event => { event.preventDefault(); setOpen(previous => !previous); }}><CircleHelp size={17} aria-hidden="true" /></button></TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal><TooltipPrimitive.Content className="app-tooltip-content publish-field-help-popup" sideOffset={7}>{children}</TooltipPrimitive.Content></TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>;
}

export function PendingValue({ label = "待填" }: { label?: string }) {
  return <span className="publish-pending-value"><span aria-hidden="true">—</span><span className="sr-only">{label}</span></span>;
}

export const NOTICE_READ_KEY = "zzsh_supply_notice_read:v1";

// Same shadcn/Base UI composition and theme tokens as the existing form controls.
export function PublishingNotice({
  open,
  onClose,
  agreement,
  returnFocus,
  manual = false,
}: {
  open: boolean;
  onClose: () => void;
  agreement: PublishingOptions["agreement"] | null;
  returnFocus?: () => HTMLElement | null;
  manual?: boolean;
}) {
  const notice = usePublicContent("placement:PUBLISH_NOTICE");
  const noticeTitle = notice.resource?.payload?.kind === "notice" ? notice.resource.payload.title : "出租上架须知";
  const isReadStored = useCallback(() => {
    if (manual) return true;
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(NOTICE_READ_KEY) === "1";
    } catch {
      return false;
    }
  }, [manual]);

  const [seconds, setSeconds] = useState(() => (isReadStored() ? 0 : 5));
  const [agreementOpen, setAgreementOpen] = useState(false);
  const read = useRef(isReadStored());
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    if (isReadStored() || read.current) {
      setSeconds(0);
      return;
    }
    const deadline = window.performance.now() + 5000;
    setSeconds(5);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - window.performance.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) {
        read.current = true;
        window.clearInterval(timer);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [open, isReadStored]);

  const handleConfirmClose = () => {
    try {
      window.sessionStorage.setItem(NOTICE_READ_KEY, "1");
    } catch {}
    read.current = true;
    onClose();
  };

  return <Dialog.Root open={open} disablePointerDismissal onOpenChange={(next, event) => {
    if (!next && seconds > 0) event.cancel();
    else if (!next) handleConfirmClose();
  }}>
    <Dialog.Portal><Dialog.Backdrop className="modal-overlay publish-dialog-backdrop" />
      <Dialog.Popup className="publish-dialog publish-reading-dialog" data-slot="dialog-content" initialFocus={titleRef} finalFocus={returnFocus ?? (() => document.querySelector<HTMLElement>(".publish-outline a"))}>
        <header className="publish-reading-header">
          <ShieldCheck size={26} aria-hidden="true" />
          <div>
            <Dialog.Title ref={titleRef} tabIndex={-1}>{noticeTitle}</Dialog.Title>
            <Dialog.Description>保障账号权益，先了解以下规则。</Dialog.Description>
          </div>
          <Dialog.Close className="publish-reading-close" aria-label="关闭上架须知" disabled={seconds > 0} onClick={handleConfirmClose}><X size={20} aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="publish-reading-body">
          <ManagedNoticeSections contentKey="placement:PUBLISH_NOTICE" />
          <div className="publish-notice-specs-card">
            <div className="publish-specs-card-title">
              <Box size={16} aria-hidden="true" />
              <h4>物资申报与计量口径</h4>
            </div>
            <div className="publish-specs-grid">
              <div className="publish-spec-item">
                <span className="publish-spec-label">安全箱与保险</span>
                <span className="publish-spec-desc">安全箱填写赛季永久容量 · {INSURANCE_EXPERIENCE_CARD}另填可用天数</span>
              </div>
              <div className="publish-spec-item">
                <span className="publish-spec-label">计量单位换算</span>
                <span className="publish-spec-desc">六级子弹 <strong>1 组 = 60 发</strong> · AWM/巴雷特<strong>按发</strong> · {INSURANCE_EXPERIENCE_CARD}<strong>按天</strong></span>
              </div>
              <div className="publish-spec-item">
                <span className="publish-spec-label">物资数量默认按 0 申报</span>
                <span className="publish-spec-desc">
                  所有可填物资默认初始化为 <span className="publish-spec-pill publish-spec-pill--zero">0</span>，请将账号实际拥有的物资修改为真实整数数量
                </span>
              </div>
            </div>
          </div>
          <div className="publish-reading-tip">
            <Info size={15} aria-hidden="true" />
            <span>备注向租客公开展示，请勿填写密码、验证码等敏感信息。</span>
          </div>
        </div>
        <footer className="publish-reading-footer">
          <Dialog.Root open={agreementOpen} onOpenChange={setAgreementOpen}>
            <div className="publish-reading-agreement-row"><span>交易规则与协议</span><Dialog.Trigger className="publish-reading-agreement-link" disabled={!agreement}>查看《出租交易须知》<ArrowRight size={16} aria-hidden="true" /></Dialog.Trigger></div>
            {!agreement ? <p>交易协议暂未读取，核价前请确认当前规则已加载。</p> : null}
            <Dialog.Portal><Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" /><Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
              <header><Dialog.Title>{agreement?.title ?? "出租交易须知"}</Dialog.Title><Dialog.Close className="publish-reading-close" aria-label="关闭交易须知"><X size={20} aria-hidden="true" /></Dialog.Close></header>
              <Dialog.Description>当前读取的协议正文；阅读不会自动同意条款，上架前仍需确认本次报价对应的协议。</Dialog.Description>
              {agreement ? <AgreementBody body={agreement.body} /> : <p>暂未取得协议正文。</p>}
              <Dialog.Close className="button secondary">返回上架须知</Dialog.Close>
            </Dialog.Popup></Dialog.Portal>
          </Dialog.Root>
          <p>阅读须知不代表接受本次报价，上架前仍需单独确认。</p><Dialog.Close className="button primary" disabled={seconds > 0} onClick={handleConfirmClose}>{seconds > 0 ? `请阅读须知（${seconds} 秒）` : notice.status === "error" ? "返回填写" : "我已了解，开始填写"}</Dialog.Close>
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function LoginPlatformIcon({ code }: { code: string }) {
  const platform = ({
    legacy_login_qq: "tencentqq",
    login_qq_qr: "tencentqq",
    legacy_login_wechat: "wechat",
    legacy_login_steam_cn: "steam",
    legacy_login_steam_global: "steam",
  } as Record<string, string>)[code] ?? (code.includes("qq") ? "tencentqq" : undefined);
  return platform ? <img className="publish-login-platform-icon" src={`/images/login-platforms/${platform}.svg`} width={20} height={20} alt="" /> : <LogIn size={20} />;
}

export function InventoryIcon({ code }: { code: string | null }) {
  const canonical = canonicalResourceCode(code);
  const art = INVENTORY_ITEM_ART[canonical ?? ""] ?? (code ? INVENTORY_ITEM_ART[code] : undefined);
  if(art)return <img src={art} width={48} height={48} alt="" decoding="async" />;
  const Icon = canonical === "df_billable_coffee" ? Bean
    : canonical === "df_billable_level6_armor" ? Shield
    : canonical === "df_billable_level6_helmet" ? HardHat
    : canonical === "df_billable_level6_bullet" || canonical === "df_billable_awm_bullet" || code === "barrett_round" || code === "df_billable_barrett_bullet" ? Crosshair
    : code === "df_billable_top_insure_card" || code === "top_insure_card_piece" || code === "df_billable_top_insure_card_piece" ? Ticket : Box;
  return <Icon size={22} aria-hidden="true" />;
}
