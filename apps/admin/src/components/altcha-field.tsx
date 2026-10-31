import { createElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { stepUpCaptcha } from "../api";

/** 自托管 ALTCHA 挑战（API 侧 HMAC 签发，无第三方请求）。 */
export const ALTCHA_CHALLENGE_URL = "/api/bff/admin/security/captcha/challenge";

let widgetModule: Promise<unknown> | undefined;
function loadWidget(): Promise<unknown> {
  // SSR/测试环境只渲染占位元素，不加载 Web Component。
  if (import.meta.env.SSR || typeof customElements === "undefined") return Promise.resolve();
  widgetModule ??= import("altcha").then(() => import("altcha/i18n/zh-cn")).catch((error) => { widgetModule = undefined; throw error; });
  return widgetModule;
}

type AltchaFieldProps = {
  onPayload: (payload: string | undefined) => void;
  hint?: string;
};

/** 人机验证：自动完成工作量证明，verified 时回传 payload，其他状态回传 undefined。 */
export function AltchaField({ onPayload, hint = "为保护账号安全，请先完成人机验证。" }: AltchaFieldProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  const callback = useRef(onPayload);
  callback.current = onPayload;

  useEffect(() => {
    let alive = true;
    loadWidget().catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: string; payload?: string }>).detail;
      callback.current(detail?.state === "verified" && typeof detail.payload === "string" ? detail.payload : undefined);
    };
    element.addEventListener("statechange", handle);
    return () => element.removeEventListener("statechange", handle);
  }, []);

  return (
    <div data-testid="altcha-field" className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{hint}</span>
      {failed
        ? <span role="alert" className="text-xs text-destructive">人机验证组件加载失败，请刷新页面后重试。</span>
        : createElement("altcha-widget", { ref, challenge: ALTCHA_CHALLENGE_URL, name: "altcha", auto: "onload", language: "zh-cn" })}
    </div>
  );
}

/** 敏感操作复核表单内的人机验证：仅在服务端要求后出现，每次提交消费一次 payload 后重新求解。 */
export function StepUpCaptcha() {
  const state = useSyncExternalStore(stepUpCaptcha.subscribe, stepUpCaptcha.snapshot, stepUpCaptcha.snapshot);
  if (!state.required) return null;
  return <AltchaField key={state.round} onPayload={stepUpCaptcha.setPayload} hint="复核失败次数较多，请先完成人机验证再提交。" />;
}
