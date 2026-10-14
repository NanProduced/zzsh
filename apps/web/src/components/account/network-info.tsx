"use client";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { SkeletonBlock } from "@/components/ui/information";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NetworkInfoError, networkFailureCopy, readNetworkInfo, type NetworkInfo, type NetworkInfoFailure } from "@/lib/network-info-client";

/** 浏览器时区只读自本机 Intl，与公网 IP 分开呈现；它是本机设置，不是 IP 定位结果。 */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "暂无法确认";
  } catch {
    return "暂无法确认";
  }
}

/**
 * 「当前会话」内的当前公网 IP：打开本区域时向第三方查询一次，表示此刻的网络出口，
 * 不是登录时记录的 IP，不写回后端，也不用于认证、授权或安全判断。
 * 查询失败只降级本行，不触碰会话事实与本机浏览器字段，也不阻塞页面其余操作。
 */
export function CurrentNetworkFields() {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; info?: NetworkInfo; reason?: NetworkInfoFailure }>({ status: "loading" });
  // 每次读取领一个序号；卸载时序号自增，在途的迟到结果因此自我作废，不会写回已卸载的组件。
  const sequence = useRef(0);
  // StrictMode 重放 effect 时复用本组件在途读取，不跨组件或会话缓存 IP。
  const pending = useRef<Promise<NetworkInfo> | null>(null);

  const load = async () => {
    const id = ++sequence.current;
    setState({ status: "loading" });
    const request = pending.current ??= readNetworkInfo();
    try {
      const info = await request;
      if (sequence.current === id) setState({ status: "ready", info });
    } catch (error) {
      if (sequence.current !== id) return;
      setState({ status: "error", reason: error instanceof NetworkInfoError ? error.reason : "unreachable" });
    } finally {
      if (pending.current === request) pending.current = null;
    }
  };

  useEffect(() => {
    void load();
    return () => { sequence.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { status, info, reason } = state;
  const note = status === "error"
    ? networkFailureCopy[reason ?? "unreachable"]
    : status === "ready"
      ? "这是打开本区域时查询到的当前网络出口，不是登录时的 IP，也不用于安全校验。"
      : null;
  return (
    <div className="sec-network">
      <div className="sec-network-row">
        <span className="sec-network-label">当前公网 IP</span>
        {status === "loading" ? (
          <span className="sec-network-value"><SkeletonBlock label="正在读取当前公网 IP" lines={1} variant="text" /></span>
        ) : (
          <span className={"sec-network-value" + (status === "error" ? " is-pending" : "")}>{status === "ready" ? info?.ip : "暂不可用"}</span>
        )}
        <NetworkSourceTip />
      </div>
      {note ? <p className="sec-network-note">{note}</p> : null}
      {status === "error" ? <button type="button" className="button quiet button--xs network-retry" onClick={() => void load()}>重试</button> : null}
    </div>
  );
}

/** 「信息来源」：只解释这一行数据从哪来、不是什么，不写工程口径。 */
function NetworkSourceTip() {
  const [open, setOpen] = useState(false);
  return <span className="sec-info">
    <TooltipProvider delayDuration={180} skipDelayDuration={100}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button type="button" className="sec-info-trigger" aria-label="信息来源" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
            <Info size={13} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="sec-info-content">
          <strong>信息来源</strong>
          <p>当前公网 IP 由第三方查询服务在您打开本区域时返回，只表示此刻的网络出口，不会保存到平台账号，也不作为安全凭据。该服务只提供 IP，不提供地区与运营商。浏览器时区来自您当前的浏览器设置。</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </span>;
}
