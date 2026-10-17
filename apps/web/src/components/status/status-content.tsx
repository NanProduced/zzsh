"use client";

import { useId } from "react";
import { ArrowRight, Headphones, RotateCw } from "lucide-react";
import styles from "./status-page.module.css";
import { SupportContactButton } from "@/components/support/support-contact-button";

export type StatusKind = "not-found" | "unavailable" | "forbidden";

const states = {
  "not-found": {
    title: "没有找到这个页面",
    description: "页面可能已移走，或链接有误。",
    suggestion: "换个入口，继续发现心仪账号。",
    image: "/art/status/not-found-r1.webp",
  },
  unavailable: {
    title: "暂时无法加载页面",
    description: "页面加载遇到了问题，请稍后重试。",
    suggestion: "你也可以先返回首页。",
    image: "/art/status/unavailable-r1.webp",
  },
  forbidden: {
    title: "此内容暂不可访问",
    description: "你暂时无法查看此内容。",
    suggestion: "可以返回个人中心，或联系平台客服。",
    image: "/art/status/forbidden-r1.webp",
  },
} as const;

export function StatusContent({ kind, onRetry }: { kind: StatusKind; onRetry?: () => void }) {
  const headingId = useId();
  const state = states[kind];
  return <section className={styles.content} aria-labelledby={headingId}>
    <div className={styles.visual} aria-hidden="true">
      <img key={state.image} src={state.image} alt="" width={960} height={960} fetchPriority="high"
        ref={image => { if (image?.complete && image.naturalWidth === 0) image.style.visibility = "hidden"; }}
        onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
    </div>
    <div className={styles.copy}>
      {kind === "not-found" ? <p className={styles.code}>404</p> : null}
      <h1 id={headingId}>{state.title}</h1>
      <p className={styles.description}>{state.description}<br />{state.suggestion}</p>
      <div className={styles.actions}>
        {kind === "not-found" ? <a className={styles.primary} href="/accounts">浏览账号</a>
          : kind === "forbidden" ? <a className={styles.primary} href="/account">返回个人中心</a>
            : onRetry ? <button type="button" className={styles.primary} onClick={onRetry}><RotateCw size={18} aria-hidden="true" />重新加载</button> : null}
        {kind === "forbidden"
          ? <SupportContactButton className={styles.secondary}><Headphones size={17} aria-hidden="true" />联系客服</SupportContactButton>
          : <a className={styles.secondary} href="/">返回首页</a>}
      </div>
      <a className={styles.help} href="/help">{kind === "not-found" ? "前往帮助中心" : "查看帮助"}<ArrowRight size={17} aria-hidden="true" /></a>
    </div>
  </section>;
}
