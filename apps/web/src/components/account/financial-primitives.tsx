"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { Eye, EyeOff, RefreshCw, CreditCard, ChevronRight } from "lucide-react";
import { StatusBadge, type StatusTone } from "@/components/ui/information";
import "./financial-primitives.css";

/* --------------------------------------------------------------------------
   1. FinancialPageHeader: 统一页面标题栏与刷新操作
   -------------------------------------------------------------------------- */
export function FinancialPageHeader({
  title,
  description,
  onRefresh,
  busy = false,
  icon,
  refreshLabel = "刷新",
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onRefresh?: () => void;
  busy?: boolean;
  icon?: ReactNode;
  refreshLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="fin-header">
      <div className="fin-header-copy">
        <h2 className="fin-header-title">
          {icon ? <span className="fin-header-icon" aria-hidden="true">{icon}</span> : null}
          {title}
        </h2>
        {description ? <p className="fin-header-desc">{description}</p> : null}
      </div>
      <div className="fin-header-actions">
        {children}
        {onRefresh ? (
          <button
            type="button"
            className="button secondary fin-refresh-btn"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onRefresh}
          >
            <RefreshCw size={15} className={busy ? "is-spinning" : ""} aria-hidden="true" />
            <span>{busy ? "正在刷新…" : refreshLabel}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------------
   2. FinancialSubTabs: 统一子导航组件（支持 Next Link 与内部按键切换）
   -------------------------------------------------------------------------- */
export type FinancialTabItem = {
  key: string;
  label: string;
  href?: string;
  badge?: string | number;
};

export function FinancialSubTabs({
  items,
  activeKey,
  onSelect,
  className = "",
}: {
  items: FinancialTabItem[];
  activeKey: string;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  return (
    <nav className={`fin-subtabs ${className}`.trim()} aria-label="子视图导航">
      {items.map((item) => {
        const isActive = item.key === activeKey;
        if (item.href) {
          return (
            <Link
              key={item.key}
              href={item.href}
              scroll={false}
              className={`fin-tab-item${isActive ? " is-active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <span>{item.label}</span>
              {item.badge !== undefined ? <span className="fin-tab-badge">{item.badge}</span> : null}
              {isActive ? <span className="fin-tab-indicator" aria-hidden="true" /> : null}
            </Link>
          );
        }
        return (
          <button
            key={item.key}
            type="button"
            className={`fin-tab-item${isActive ? " is-active" : ""}`}
            aria-pressed={isActive}
            onClick={() => onSelect?.(item.key)}
          >
            <span>{item.label}</span>
            {item.badge !== undefined ? <span className="fin-tab-badge">{item.badge}</span> : null}
            {isActive ? <span className="fin-tab-indicator" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

/* --------------------------------------------------------------------------
   3. FinancialFilterPills: 统一筛选胶囊（二级过滤，不破坏一级 Tab 视觉）
   -------------------------------------------------------------------------- */
export type FilterPillOption<T extends string = string> = {
  value: T;
  label: string;
  badge?: string | number;
};

export function FinancialFilterPills<T extends string = string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel = "筛选",
}: {
  options: FilterPillOption<T>[];
  value: T;
  onChange: (val: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="fin-filter-pills" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`fin-filter-pill${selected ? " is-active" : ""}`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
          >
            <span>{opt.label}</span>
            {opt.badge !== undefined ? <span className="fin-tab-badge">{opt.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
   4. FinancialBalanceCard: 现代金融钱包余额看板
   -------------------------------------------------------------------------- */
export function FinancialBalanceCard({
  title = "账户可用余额",
  amount,
  subhint,
  actions,
  privacyToggle = true,
}: {
  title?: string;
  amount: string;
  subhint?: ReactNode;
  actions?: ReactNode;
  privacyToggle?: boolean;
}) {
  const [masked, setMasked] = useState(false);

  return (
    <div className="fin-balance-hero">
      <div className="fin-balance-top">
        <span className="fin-balance-label">
          <CreditCard size={17} aria-hidden="true" />
          {title}
        </span>
        {privacyToggle ? (
          <button
            type="button"
            className="fin-privacy-btn"
            aria-label={masked ? "显示金额" : "隐藏金额"}
            onClick={() => setMasked((prev) => !prev)}
          >
            {masked ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      <div className="fin-balance-value-row">
        <strong className="fin-balance-amount" data-testid="wallet-summary-amount">
          {masked ? "••••••" : amount}
        </strong>
      </div>

      {subhint ? <div className="fin-balance-subhint">{subhint}</div> : null}

      {actions ? <div className="fin-balance-actions">{actions}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------------------
   5. FinancialBankCard: 实体/虚拟银行卡视觉组件
   -------------------------------------------------------------------------- */
export function FinancialBankCard({
  cardNumber,
  holderName,
  status = "资料已保存",
  statusTone = "info",
  manageHref,
  onManage,
  manageText = "管理卡片",
}: {
  cardNumber?: string | null;
  holderName?: string | null;
  status?: string;
  statusTone?: StatusTone;
  manageHref?: string;
  onManage?: () => void;
  manageText?: string;
}) {
  return (
    <div className="fin-bank-card">
      <div className="fin-bank-card-top">
        <div className="fin-chip-emblem" aria-hidden="true" />
        <StatusBadge tone={statusTone}>{status}</StatusBadge>
      </div>

      <div className="fin-card-number">
        {cardNumber ? cardNumber : "•••• •••• •••• ••••"}
      </div>

      <div className="fin-bank-card-bottom">
        <div className="fin-cardholder-info">
          <span className="fin-cardholder-label">持卡人</span>
          <span className="fin-cardholder-name">{holderName ? holderName : "尚未绑定收款资料"}</span>
        </div>

        {manageHref ? (
          <Link href={manageHref} scroll={false} className="button secondary button--xs">
            {manageText}
          </Link>
        ) : onManage ? (
          <button type="button" onClick={onManage} className="button secondary button--xs">
            {manageText}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   6. FinancialRecordRow: 资金流水 / 交易明细统一列表项
   -------------------------------------------------------------------------- */
export function FinancialRecordRow({
  icon,
  title,
  subtitle,
  amount,
  direction = "neutral",
  status,
  statusTone = "neutral",
  href,
  onClick,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  amount?: ReactNode;
  direction?: "in" | "out" | "neutral";
  status?: ReactNode;
  statusTone?: StatusTone;
  href?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="fin-record-leading">
        {icon ? <span className="fin-record-icon" aria-hidden="true">{icon}</span> : null}
        <div className="fin-record-texts">
          <span className="fin-record-title">{title}</span>
          {subtitle ? <span className="fin-record-sub">{subtitle}</span> : null}
        </div>
      </div>

      {amount !== undefined ? (
        <div className="fin-record-money-col">
          <strong className="fin-record-amount" data-direction={direction}>
            {amount}
          </strong>
        </div>
      ) : null}

      <div className="fin-record-status-col">
        {status ? <StatusBadge tone={statusTone}>{status}</StatusBadge> : null}
        {href || onClick ? <ChevronRight size={16} className="text-muted-foreground" aria-hidden="true" /> : null}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} scroll={false} className="fin-record-row">
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="fin-record-row w-full text-left bg-transparent border-0 cursor-pointer">
        {content}
      </button>
    );
  }

  return <div className="fin-record-row">{content}</div>;
}

/* --------------------------------------------------------------------------
   7. FinancialEmptyState: 统一资金空状态卡片
   -------------------------------------------------------------------------- */
export function FinancialEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="fin-empty-state" role="status">
      {icon ? <div className="fin-empty-icon" aria-hidden="true">{icon}</div> : null}
      <strong className="fin-empty-title">{title}</strong>
      {description ? <p className="fin-empty-desc">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
