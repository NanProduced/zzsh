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

/**
 * 「待我处理」数量：与审批列表用同一个统一接口，跟随 refreshNonce 刷新。
 * 读不到、无权限或没有待办时返回 undefined，由调用方决定不显示角标。
 */
export function useApprovalPendingCount(enabled: boolean, refreshNonce: number): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled) { setCount(undefined); return; }
    let alive = true;
    adminRequest<{ pendingCount?: number }>("/security/approvals/requests?scope=pending&limit=1")
      .then((result) => {
        if (!alive) return;
        const n = result.pendingCount;
        setCount(typeof n === "number" && n > 0 ? n : undefined);
      })
      .catch(() => { if (alive) setCount(undefined); });
    return () => { alive = false; };
  }, [enabled, refreshNonce]);
  return count;
}

/** 一句业务脉搏：复用统一的待我处理数量；读不到就不显示。 */
function useBossPulse(canApprove: boolean, refreshNonce: number): string | undefined {
  const count = useApprovalPendingCount(canApprove, refreshNonce);
  if (count === undefined) return undefined;
  return `有 ${count} 件申请等您定夺。`;
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
