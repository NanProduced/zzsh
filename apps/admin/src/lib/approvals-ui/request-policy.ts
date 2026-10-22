import {
  businessProgress, executionModeLabel, executionProgress, personLabel, reasonLabel, statusView,
  type RequestDetail,
} from "../../views/approval/contract.ts";
import type { ApprovalPolicy, StepStatus } from "./policy.ts";

/** Projects the existing request; this does not evaluate or execute an approval policy. */
export function requestPolicy(detail: RequestDetail): ApprovalPolicy {
  const decision = detail.decision?.decision;
  const decided = decision === "APPROVED" || decision === "REJECTED";
  const pending = detail.status === "PENDING" && !detail.decision;
  const closed = detail.status === "EXPIRED" || detail.status === "CANCELLED";
  const reviewStatus: StepStatus = decided ? "complete" : pending ? "pending" : closed ? "inactive" : "unknown";
  const availability = detail.candidateAvailability;
  const execution = executionProgress(detail);
  const business = businessProgress(detail.business);
  const executionStatus: StepStatus = detail.execution?.status === "SUCCEEDED" ? "complete"
    : detail.execution?.status === "FAILED" ? "failed"
      : detail.execution ? "unknown" : decision === "APPROVED" ? "pending" : "inactive";
  const outcomeStatus = (value: string): StepStatus => decision === value ? "complete"
    : decided || closed || pending ? "inactive" : "unknown";

  return {
    name: "申请审批流程",
    roots: ["request"],
    steps: [
      {
        id: "request", kind: "approval", label: "提交申请", status: "complete", statusLabel: "已提交",
        description: detail.business?.changeSummary || detail.summary || "申请摘要未提供",
        approvers: [], next: ["review"],
        facts: [
          { label: "申请人", value: personLabel(detail.requester) },
          { label: "申请时间", value: detail.createdAt ?? "未提供" },
          { label: "规则快照", value: `模板 v${detail.template.version}` },
          { label: "发起条件", value: detail.operation.triggerCondition },
        ],
      },
      {
        id: "review", kind: "approval", label: "候选审批组", status: reviewStatus,
        statusLabel: decided ? "已有有效决定" : pending ? "待审批" : closed ? statusView(detail.status).label : "决定记录未读到",
        description: "组内任一合格人的首个有效批准或拒绝生效；申请人不能自批。",
        approvers: detail.candidates.map(candidate => ({ name: personLabel(candidate), title: candidate.eligible === true ? "通用资格合格" : candidate.eligible === false ? "通用资格不满足" : "通用资格未提供" })),
        next: ["approved", "rejected"],
        facts: [
          { label: "申请状态", value: statusView(detail.status).label },
          { label: "候选快照", value: `${availability?.total ?? detail.candidates.length} 人` },
          { label: "本单可处理", value: availability ? `${availability.eligible} 人` : "未提供" },
          ...(availability?.blockingReasonCode ? [{ label: "当前限制", value: reasonLabel(availability.blockingReasonCode) }] : []),
          ...(detail.decision ? [
            { label: "决定人", value: personLabel(detail.decision.approver) },
            { label: "决定时间", value: detail.decision.createdAt ?? "未提供" },
            { label: "处理说明", value: detail.decision.reason || "未填写" },
          ] : []),
        ],
      },
      {
        id: "approved", kind: "terminal", outcome: "approved", label: "批准", status: outcomeStatus("APPROVED"),
        statusLabel: decision === "APPROVED" ? "已批准" : decision === "REJECTED" || closed ? "未走此分支" : "尚无批准决定",
        description: "批准后进入业务执行；批准不代表权益已生效或资金已到账。",
        facts: [], next: ["execution"],
      },
      {
        id: "rejected", kind: "terminal", outcome: "rejected", label: "拒绝", status: outcomeStatus("REJECTED"),
        statusLabel: decision === "REJECTED" ? "已拒绝" : decision === "APPROVED" || closed ? "未走此分支" : "尚无拒绝决定",
        description: "拒绝后不进入本次业务执行。", facts: [], next: [],
      },
      {
        id: "execution", kind: "approval", label: "业务执行", status: executionStatus, statusLabel: execution.label,
        description: business.label, approvers: [], next: [],
        facts: [
          { label: "执行方式", value: executionModeLabel(detail.operation.executionMode ?? detail.business?.executionMode) },
          { label: "执行结果", value: execution.label },
          { label: "业务进度", value: business.label },
          ...(execution.detail ? [{ label: "执行说明", value: execution.detail }] : []),
          ...(business.detail ? [{ label: "业务说明", value: business.detail }] : []),
        ],
      },
    ],
  };
}
