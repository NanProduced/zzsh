import { useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import type { ApprovalPolicy } from "../lib/approvals-ui/policy";
import { formatDate } from "../api";
import type { AdminApproval, AdminGrowthPolicy, MembershipGrowthAdminState } from "./membership-growth-policy-model";

export function GrowthSelect({ label, value, onChange, options, className = "", disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; className?: string; disabled?: boolean }) {
  return (
    <label className={`membership-admin-control ${className}`}>
      <span>{label}</span>
      <Select value={value || null} disabled={disabled || !options.length} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger aria-label={label} className="membership-admin-select-trigger">
          <SelectValue placeholder="请选择">{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

export function buildPolicyApprovalPolicy(policy: AdminGrowthPolicy, approval: AdminApproval): ApprovalPolicy {
  const isApplied = approval.status === "APPLIED" || policy.status === "APPROVED";
  const isRequested = approval.status === "REQUESTED";
  return {
    name: `会员政策 v${policy.version} 审批流`,
    roots: ["draft"],
    steps: [
      {
        id: "draft",
        kind: "approval",
        label: "政策草稿",
        description: "运营填写统一等级折扣与两类礼遇范围",
        status: "complete",
        statusLabel: "已保存草稿",
        facts: [
          { label: "政策版本", value: `v${policy.version}` },
          { label: "适用范围", value: "全部已启用租赁方式" },
        ],
        approvers: [{ name: "运营", title: "草稿起草" }],
        next: ["boss_review"],
      },
      {
        id: "boss_review",
        kind: "approval",
        label: "Boss 审批",
        description: "由 Boss 审批；维持禁止自审与候选/权限守卫",
        status: isRequested ? "pending" : isApplied ? "complete" : "inactive",
        statusLabel: isRequested ? "待 Boss 审批" : isApplied ? "审批已通过" : "待提交审批",
        facts: [
          { label: "审批单号", value: approval.requestId ?? "尚未生成" },
          { label: "审批要求", value: "Boss 审批；提交人不能审批自己的申请" },
        ],
        approvers: [{ name: "Boss", title: "平台负责人" }],
        next: ["execution"],
      },
      {
        id: "execution",
        kind: "terminal",
        label: "批准待执行",
        description: "审批通过后由运营执行发布，到达计划生效时间正式生效",
        status: isApplied ? "complete" : "inactive",
        statusLabel: isApplied
          ? (policy.effectiveAt && new Date(policy.effectiveAt).getTime() > Date.now() ? "已发布 · 待达到生效时间" : "当前有效")
          : "未执行",
        outcome: "approved",
        facts: [
          { label: "计划生效", value: policy.effectiveAt ? formatDate(policy.effectiveAt) : "发布前确认" },
          { label: "执行状态", value: isApplied ? "已执行发布" : "待批准后执行" },
        ],
        next: [],
      },
    ],
  };
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "已复制" : "复制单号"}
    </Button>
  );
}

export function stateMessage(state: Exclude<MembershipGrowthAdminState, { status: "ready" }>, refresh?: () => void, requestId?: string | null, open?: (path: string, title?: string) => void) {
  const loading = state.status === "loading", denied = state.status === "permission";
  const title = loading ? "正在读取会员政策" : denied ? "没有会员政策查看权限" : "会员政策暂不可用";
  return <section className="membership-admin-view" data-state={state.status}>
    <Alert variant={loading ? "default" : denied ? "warning" : "destructive"} role={loading || denied ? "status" : "alert"}>
      {loading ? <RefreshCw aria-hidden className="animate-spin" /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{loading ? "请稍候。" : denied ? "请联系有权限的管理员。" : state.message}</AlertDescription>
      <AlertAction>
        {!loading && refresh ? <Button size="sm" variant="outline" onClick={refresh}>刷新状态</Button> : null}
        {requestId && open ? <Button size="sm" variant="ghost" onClick={() => open(`/approvals/${encodeURIComponent(requestId)}?from=membership-growth&fromTab=policy`, "审批详情")}>查看原申请</Button> : null}
      </AlertAction>
    </Alert>
    {loading ? <div className="space-y-3" aria-hidden><Skeleton className="h-8 w-full" /><Skeleton className="h-36 w-full" /></div> : null}
  </section>;
}
