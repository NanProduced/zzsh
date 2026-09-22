import type { ReactNode } from "react";
import { SearchX, RotateCw } from "lucide-react";
export function AccountCardEmpty({ message = "暂时无法展示账号列表", description = "当前没有可供展示的账号信息，请稍后再来。", onReset, onRetry, children }: { message?: string; description?: string; onReset?: () => void; onRetry?: () => void; children?: ReactNode }) {
  return <div className="account-empty" role="status"><SearchX size={28} /><h3>{message}</h3><p>{description}</p>
    {children}
    {onReset ? <button className="button secondary" onClick={onReset}>重置所有条件</button> : onRetry ? <button className="button secondary" onClick={onRetry}><RotateCw size={15} />重试</button> : <a href="/help#rental-guide">先了解租号流程</a>}
  </div>;
}
