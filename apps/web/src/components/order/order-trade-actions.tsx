"use client";

import Link from "next/link";
import { CircleSlash } from "lucide-react";
import type { Order, OrderParty } from "@/lib/order-client";
import type { OrderPaymentFacts } from "@/lib/order-display";
import "./order.css";

// 导出所有类型
export type {
  WriteOutcome,
  OrderStageFacts,
  SettlementFocus,
  PanelError,
} from "./order-trade-types";

// 导出共享工具
export {
  performGuardedWrite,
  panelError,
  writeError,
  partyLabel,
} from "./order-trade-shared";

// 导出沙箱支付组件（[MOCK/DEBUG ONLY] 汇聚支付上线前需删除）
export { LocalSandboxPaymentAction } from "./order-sandbox-action";

// 导出演示收银台组件（[MOCK/DEBUG ONLY] 汇聚支付上线前需删除）
export { DemoCheckoutAction } from "./order-demo-action";

// 导出支付核心组件与渠道事实
export {
  PaymentAction,
  PaymentFactsProbe,
  channelPaymentFacts,
  PAYMENT_FACTS_UNREADABLE,
} from "./order-payment-action";

// 导出结算核心组件、期初计算与服务端阶段事实
export {
  SettlementAction,
  stageFacts,
  activeOpening,
} from "./order-settlement-action";

// 导入主渲染所需的子组件
import { PaymentAction } from "./order-payment-action";
import { SettlementAction } from "./order-settlement-action";
import type { OrderStageFacts } from "./order-trade-types";

export function OrderTradeActions({
  order,
  party,
  onChanged,
  onStageFacts,
  onPaymentFacts,
}: {
  order: Order;
  party: OrderParty;
  onChanged: () => void;
  onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void;
  onPaymentFacts?: (facts: OrderPaymentFacts | null) => void;
}) {
  if (order.status === "PENDING_PAYMENT") {
    return <PaymentAction order={order} party={party} onChanged={onChanged} onPaymentFacts={onPaymentFacts} />;
  }
  if (order.status === "PAID" || order.status === "COMPLETED") {
    return <SettlementAction order={order} party={party} onChanged={onChanged} onStageFacts={onStageFacts} />;
  }
  if (order.status === "CANCELLED") {
    return (
      <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="订单收尾">
        <h2 className="order-section-title">订单收尾</h2>
        <p className="order-muted">
          <CircleSlash size={14} aria-hidden="true" /> 订单已结束，本页不再提供开租、结算或新的支付操作。退款进度、售后记录与客服入口按实际可用性保留；取消或过账都不代表渠道退款已到账，本单账号不会因完单而再次上架。
        </p>
        <div className="order-trade-actions">
          <Link className="button secondary" href={party === "renter" ? "/accounts" : "/account?view=accounts"} scroll={false}>
            {party === "renter" ? "浏览可租账号" : "管理上架账号"}
          </Link>
        </div>
      </section>
    );
  }
  return null;
}
