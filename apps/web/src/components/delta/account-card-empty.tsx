import type { ReactNode } from "react";
import { SearchX, RotateCw } from "lucide-react";

export function AccountCardEmpty({
  message = "暂时没有符合条件的账号",
  description = "当前条件下没有找到匹配的号源，建议放宽部分筛选条件，或一键清除全部筛选：",
  onReset,
  onRetry,
  resetLabel = "清除筛选条件",
  children,
}: {
  message?: string;
  description?: string;
  onReset?: () => void;
  onRetry?: () => void;
  resetLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="account-empty" role="status">
      <div className="account-empty-icon-wrap" aria-hidden="true">
        <SearchX size={32} />
      </div>
      <h3>{message}</h3>
      <p>{description}</p>
      {children}
      <div className="account-empty-actions">
        {onReset ? (
          <button type="button" className="button secondary account-empty-reset-btn" onClick={onReset}>
            {resetLabel}
          </button>
        ) : onRetry ? (
          <button type="button" className="button secondary" onClick={onRetry}>
            <RotateCw size={15} />
            重试读取
          </button>
        ) : (
          <a href="/help#rental-guide" className="account-empty-link">先了解租号流程</a>
        )}
      </div>
    </div>
  );
}
