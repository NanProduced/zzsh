import { useEffect, useState } from "react";
import { CrownIcon } from "lucide-react";

import { adminRequest } from "../api";

// Boss 专属的克制细节：深墨 + 香槟金，不做动效，只给 Boss 账号渲染。

export function bossGreetingWord(date: Date = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(date));
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function BossCrest({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`boss-crest ${className}`} aria-hidden>
      <CrownIcon size={size} strokeWidth={1.75} />
    </span>
  );
}

/** 一句业务脉搏：只用已有的待审批接口；读不到就不显示。 */
function useBossPulse(canApprove: boolean, refreshNonce: number): string | undefined {
  const [pulse, setPulse] = useState<string>();
  useEffect(() => {
    if (!canApprove) return;
    let alive = true;
    adminRequest<{ requests?: unknown[] }>("/security/approvals/requests/pending?limit=50")
      .then((result) => {
        if (!alive || !Array.isArray(result.requests)) return;
        const n = result.requests.length;
        setPulse(n === 0 ? "待您定夺的申请已清空，一切如常。" : `有 ${n >= 50 ? "50+" : n} 件申请等您定夺。`);
      })
      .catch(() => { if (alive) setPulse(undefined); });
    return () => { alive = false; };
  }, [canApprove, refreshNonce]);
  return pulse;
}

export function BossGreeting({ name, canApprove, refreshNonce }: { name: string; canApprove: boolean; refreshNonce: number }) {
  const pulse = useBossPulse(canApprove, refreshNonce);
  return (
    <div className="boss-greeting">
      <h2 className="flex items-center gap-2.5 text-2xl font-semibold">
        <BossCrest size={18} />
        <span>{bossGreetingWord()}，{name}</span>
      </h2>
      <p className="boss-greeting-pulse mt-2 text-sm">{pulse ?? "工作台已为您备好。"}</p>
    </div>
  );
}
