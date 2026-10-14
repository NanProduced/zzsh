"use client";

import { type ReactNode } from "react";
import { CircleHelp, CircleX, Info, CircleCheck } from "lucide-react";
import "./information.css";

/**
 * 六类信息表达组件。结构与语义取自 Owner 已确认的 R2 选型稿（首版 B 的字段/说明/金额/加载
 * ＋ R2 的 Alert/记录状态），承载层使用项目现有设计 token，不复制原型 HTML，也不另建设计系统。
 *
 * 字段组合按原生语义显式绑定 id / aria-describedby / aria-invalid（与 R2 采用稿一致），
 * 不改既有验证时机与表单状态。
 */

/* ------------------------------------------------------------------ 1. Field */

export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  disabled?: boolean;
};

/** 由标签/说明/错误推导控件应带的无障碍属性，保持关联与实际渲染 id 一致。 */
export function fieldControlProps(input: {
  id: string;
  helper?: ReactNode;
  error?: ReactNode;
}): FieldControlProps {
  const describedBy = [input.helper ? `${input.id}-helper` : "", input.error ? `${input.id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    id: input.id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": input.error ? true : undefined,
  };
}

export function FieldGroup({
  id,
  label,
  required = false,
  helper,
  error,
  children,
  className = "",
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  helper?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`info-field ${className}`.trim()} data-invalid={error ? "" : undefined}>
      <label className="info-field-label" htmlFor={id}>
        {label}
        {required ? <span className="info-field-required">必填</span> : null}
      </label>
      {children}
      {helper ? (
        <p className="info-field-helper" id={`${id}-helper`}>
          {helper}
        </p>
      ) : null}
      {error ? (
        <p className="info-field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- 2. Callout */

/**
 * 规则与范围说明。静态说明容器，默认不带 role=alert；普通字段解释仍用 FieldGroup 的 helper。
 */
export function Callout({
  title,
  children,
  tone = "info",
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  tone?: "info" | "neutral";
  className?: string;
}) {
  return (
    <aside className={`info-callout ${className}`.trim()} data-tone={tone}>
      <div className="info-callout-body">
        <strong>{title}</strong>
        <div className="info-callout-copy">{children}</div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------- 3. Alert / Recovery */

export type AlertTone = "error" | "unknown" | "info" | "success";

const alertMark: Record<AlertTone, typeof Info> = {
  error: CircleX,
  unknown: CircleHelp,
  info: Info,
  success: CircleCheck,
};

/**
 * 异常与恢复动作。按「问题 → 影响 → 动作」组织：一项主要操作，次要解释进 details。
 * 读取失败 / 无权 / 业务失败 / 结果未知由调用方分别给出文案与 tone，不由组件猜测。
 * 静态说明不默认 role=alert；只有真正异步到来的错误才传 live。
 */
export function RecoveryAlert({
  tone,
  title,
  problem,
  impact,
  action,
  details,
  live = false,
  className = "",
}: {
  tone: AlertTone;
  title: ReactNode;
  problem: ReactNode;
  impact?: ReactNode;
  action?: ReactNode;
  details?: { summary: ReactNode; body: ReactNode };
  live?: boolean;
  className?: string;
}) {
  const Mark = alertMark[tone];
  return (
    <section
      className={`info-alert ${className}`.trim()}
      data-tone={tone}
      role={live ? "alert" : undefined}
    >
      <div className="info-alert-body">
        <Mark size={20} aria-hidden="true" />
        <div className="info-alert-copy">
          <h3>{title}</h3>
          <p>{problem}</p>
          {impact ? <p className="info-alert-impact">{impact}</p> : null}
        </div>
      </div>
      {action || details ? (
        <div className="info-alert-footer">
          {action}
          {details ? (
            <details>
              <summary>{details.summary}</summary>
              <p>{details.body}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------- 4. Status / Inline status */

export type StatusTone = "success" | "info" | "warning" | "error" | "neutral" | "unknown";

/**
 * 真实记录行内的状态。文字承载语义，颜色只做辅助；不根据金额正负或字符串猜业务状态。
 */
export function RecordStatus({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="info-record-status" data-tone={tone}>
      {children}
    </span>
  );
}

/** 克制状态标记。不强制把所有状态改成同一种胶囊，只在确实需要标签形态时使用。 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="info-status-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/* --------------------------------------------- 5. Amount / Knowledge state */

export type MoneyKnowledge = "KNOWN" | "UNKNOWN" | "FAILED" | "FORBIDDEN";

const knowledgeCopy: Record<MoneyKnowledge, string> = {
  KNOWN: "",
  UNKNOWN: "待确认",
  FAILED: "暂时无法读取",
  FORBIDDEN: "当前身份无权查看",
};

/**
 * 金额与知识状态。数值、单位、口径分层；零 / 未知 / 失败 / 无权分开表达。
 * 金额字符串必须来自现有精确格式化器（walletMoney / creditMoney）的完整输出，不在组件内转浮点重算；
 * 因此默认不再重复渲染货币单位（unit 默认空）。
 */
export function Amount({
  label,
  value,
  knowledge = "KNOWN",
  unit = "",
  note,
  size = "row",
  testId,
  children,
  ...rest
}: {
  label: ReactNode;
  value: string;
  knowledge?: MoneyKnowledge;
  unit?: string;
  note?: ReactNode;
  size?: "hero" | "block" | "row";
  testId?: string;
  children?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const known = knowledge === "KNOWN";
  return (
    <div className="info-amount" {...rest} data-knowledge={knowledge} data-size={size}>
      {label ? <p className="info-amount-label">{label}</p> : null}
      <p className="info-amount-value" data-testid={testId}>
        {known ? (
          <>
            {unit ? <span className="info-amount-unit">{unit}</span> : null}
            {value}
          </>
        ) : (
          knowledgeCopy[knowledge]
        )}
      </p>
      {note ? <p className="info-amount-note">{note}</p> : null}
      {children}
    </div>
  );
}

/* ------------------------------------------ 6. Skeleton / Local retry */

/**
 * 加载占位。保持主要布局稳定，不提前填 0 或成功结果。
 */
export function SkeletonBlock({
  label,
  lines = 3,
  variant = "list",
  className = "",
}: {
  label: string;
  lines?: number;
  variant?: "list" | "amount" | "text";
  className?: string;
}) {
  return (
    <div className={`info-skeleton-wrap ${className}`.trim()} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="info-skeleton" data-variant={variant} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span className="info-skeleton-line" key={index} data-size={index === 0 ? "lead" : "body"} />
        ))}
      </div>
    </div>
  );
}

/**
 * 局部重试。局部失败局部重试，不整页重载；身份或权限变化时由调用方撤下失权数据。
 */
export function LocalRetry({
  message,
  actionLabel = "重新读取",
  onRetry,
  busy = false,
  note,
}: {
  message: ReactNode;
  actionLabel?: string;
  onRetry: () => void;
  busy?: boolean;
  note?: ReactNode;
}) {
  return (
    <div className="info-local-retry">
      <p className="info-local-retry-message">{message}</p>
      {note ? <p className="info-local-retry-note">{note}</p> : null}
      <button type="button" className="button secondary" onClick={onRetry} disabled={busy}>
        {busy ? "正在读取…" : actionLabel}
      </button>
    </div>
  );
}
