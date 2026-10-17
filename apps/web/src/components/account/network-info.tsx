"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SkeletonBlock } from "@/components/ui/information";
import { NetworkInfoError, readNetworkInfo, type NetworkInfo, type NetworkInfoFailure } from "@/lib/network-info-client";

/** 浏览器时区只读自本机 Intl，与公网 IP 分开呈现；它是本机设置，不是 IP 定位结果。 */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "暂无法确认";
  } catch {
    return "暂无法确认";
  }
}

/**
 * 「当前会话」内的当前网络模块：
 * - 默认查询第三方网络出口信息（公网 IP、近似地区、运营商、网络归属等）。
 * - 位置仅供参考，不写入后端，不用于授权或安全判断。
 * - 额度耗尽 (429) 或降级：仅展示公网 IP 与查询时间；若无 IP 则整块隐藏，不留空白卡片或长期 Skeleton。
 */
export function CurrentNetworkFields() {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; info?: NetworkInfo; reason?: NetworkInfoFailure }>({ status: "loading" });
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  const copyTimer = useRef<number | null>(null);

  const load = async () => {
    const id = ++sequence.current;
    setState({ status: "loading" });
    try {
      const info = await readNetworkInfo();
      if (sequence.current === id) {
        setState({ status: "ready", info });
      }
    } catch (error) {
      if (sequence.current !== id) return;
      setState({ status: "error", reason: error instanceof NetworkInfoError ? error.reason : "unreachable" });
    }
  };

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = async (text: string) => {
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  const { status, info, reason } = state;

  // 429 额度耗尽且无 IP，或彻底失败：整块隐藏，不留失效 ARIA 或空白卡片
  if (status === "error" && (!info || !info.ip)) {
    return null;
  }

  if (status === "loading") {
    return (
      <div className="sec-network" role="status" aria-label="正在查询当前网络">
        <div className="sec-network-head">
          <h4 className="sec-network-title">当前网络</h4>
          <p className="sec-network-desc">基于当前网络出口查询，位置仅供参考。</p>
        </div>
        <div className="sec-network-grid">
          <div className="sec-network-item">
            <span className="sec-network-k"><span className="sr-only">当前</span>公网 IP</span>
            <span className="sec-network-v sec-network-value">
              <SkeletonBlock label="正在查询当前网络出口" lines={1} variant="text" />
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (!info || !info.ip) {
    return null;
  }

  const hasDetails = Boolean(info.details && !info.isRateLimited);
  const details = info.details;
  const affiliation = details?.org && details?.asn
    ? `${details.org} / ${details.asn}`
    : (details?.org || details?.asn || null);

  return (
    <div className="sec-network" data-rate-limited={info.isRateLimited ? "true" : undefined}>
      <div className="sec-network-head">
        <h4 className="sec-network-title">当前网络</h4>
        <p className="sec-network-desc">基于当前网络出口查询，位置仅供参考。</p>
      </div>

      <div className="sec-network-grid">
        <div className="sec-network-item">
          <span className="sec-network-k"><span className="sr-only">当前</span>公网 IP</span>
          <span className="sec-network-v">
            <span className="sec-network-ip-val">{info.ip}</span>
            <button
              type="button"
              className="sec-network-copy-btn"
              aria-label="复制当前公网 IP"
              title="复制公网 IP"
              onClick={() => void handleCopy(info.ip)}
            >
              {copied ? <Check size={13} className="text-emerald-600" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            </button>
            {copied ? <span className="sec-copy-feedback" role="status">已复制</span> : null}
          </span>
        </div>

        {hasDetails && affiliation ? (
          <div className="sec-network-item">
            <span className="sec-network-k">网络归属</span>
            <span className="sec-network-v">{affiliation}</span>
          </div>
        ) : null}

        {hasDetails && details?.location ? (
          <div className="sec-network-item">
            <span className="sec-network-k">近似地区</span>
            <span className="sec-network-v">{details.location}</span>
          </div>
        ) : null}

        {hasDetails && details?.type ? (
          <div className="sec-network-item">
            <span className="sec-network-k">IP 类型</span>
            <span className="sec-network-v">{details.type}</span>
          </div>
        ) : null}

        {hasDetails && details?.isp ? (
          <div className="sec-network-item">
            <span className="sec-network-k">运营商</span>
            <span className="sec-network-v">{details.isp}</span>
          </div>
        ) : null}

        {info.queryTime ? (
          <div className="sec-network-item">
            <span className="sec-network-k">查询时间</span>
            <span className="sec-network-v">{info.queryTime}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
