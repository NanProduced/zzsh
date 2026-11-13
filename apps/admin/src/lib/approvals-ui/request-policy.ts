import {
  businessProgress, executionModeLabel, executionProgress, personLabel, statusView,
  type RequestDetail,
} from "../../views/approval/contract.ts";
import type { ApprovalPolicy, StepStatus } from "./policy.ts";

function shortText(value: string | null | undefined, max = 90): string {
  if (!value) return "申请摘要未提供";
  const text = value.replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max).join("")}…` : text;
}

function executionCopy(detail: RequestDetail): {
  label: string;
  description: string;
  status: StepStatus;
  statusLabel: string;
  facts: { label: string; value: string }[];
} {
  const code = detail.operation.code;
  const business = detail.business;
  const execution = executionProgress(detail);
  const progress = businessProgress(business);
  if (code === "order.settlement.adjust") {
    const result = business?.settlementResult;
    return {
      label: "订单确认与过账",
      description: "审批只给出结算依据；还需回订单完成双方确认、客服复核和过账。",
      status: result?.posted ? "complete" : result ? "pending" : "unknown",
      statusLabel: result ? (result.posted ? "已过账" : "待订单确认/过账") : "结算版本未读到",
      facts: [
        ...(result ? [
          { label: "结算版本", value: `v${result.versionNo}${result.currentVersion ? "" : "（已被后续版本替代）"}` },
          { label: "已确认方", value: result.confirmedParties.length ? result.confirmedParties.join("、") : "尚无" },
          { label: "过账", value: result.posted ? "已过账" : "未过账" },
        ] : []),
        { label: "业务进度", value: progress.label },
      ],
    };
  }
  if (code === "order.compensation.grant") {
    return {
      label: "赔偿入账",
      description: "批准后赔偿计入号主余额；以本次执行回执和订单记录为准。",
      status: business?.resultAvailability === "KNOWN" ? "complete" : business?.resultAvailability === "UNRESOLVED" ? "unknown" : "pending",
      statusLabel: business?.resultAvailability === "KNOWN" ? "已核实入账" : business?.resultAvailability === "UNRESOLVED" ? "入账结果待核对" : "待赔偿入账",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  if (code === "content.fixed_document.publish") {
    return {
      label: "发布生效",
      description: "批准即发布并生效；已封存正文和用户接受记录不会被改写。",
      status: business?.resultAvailability === "KNOWN" ? "complete" : business?.resultAvailability === "UNRESOLVED" ? "unknown" : "pending",
      statusLabel: business?.resultAvailability === "KNOWN" ? "已发布生效" : business?.resultAvailability === "UNRESOLVED" ? "发布结果待核对" : "待发布生效",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  if (code === "distribution.policy.publish") {
    const known = business?.result?.knowledge === "KNOWN";
    return {
      label: "生成政策版本",
      description: "批准后生成新政策版本；不回溯已冻结订单。",
      status: known ? "complete" : "pending",
      statusLabel: known ? "新版本已生成" : "待生成政策版本",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  if (code === "distribution.earning.reverse") {
    const authorization = business?.reversal?.authorization.knowledge;
    return {
      label: "冲回授权",
      description: "批准只授权冲回；实际佣金和钱包变动以执行回执为准。",
      status: authorization === "KNOWN" ? "complete" : authorization ? "unknown" : "pending",
      statusLabel: authorization === "KNOWN" ? "已授权冲回" : authorization === "REJECTED" ? "授权被拒" : "待授权冲回",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  if (code === "membership.entitlement.grant" || code === "membership.entitlement.replace" || code === "membership.entitlement.revoke") {
    const label = code === "membership.entitlement.revoke" ? "权益撤销" : code === "membership.entitlement.replace" ? "原权益替换" : "权益生效";
    const executed = detail.execution;
    const executionStatus: StepStatus = executed?.status === "SUCCEEDED" ? "complete" : executed?.status === "FAILED" ? "failed" : executed ? "unknown" : "inactive";
    if (executed) {
      return {
        label,
        description: progress.detail ?? (code === "membership.entitlement.revoke" ? "本次执行记录已读到；权益撤销结果以权益记录为准。" : "本次执行记录已读到；权益状态以权益记录为准。"),
        status: executionStatus,
        statusLabel: executed.status === "SUCCEEDED" ? "执行成功" : executed.status === "FAILED" ? "执行失败" : "执行结果待核对",
        facts: [{ label: "业务进度", value: progress.label }],
      };
    }
    const inactive = detail.status === "REJECTED" || detail.status === "EXPIRED" || detail.status === "CANCELLED";
    return {
      label,
      description: code === "membership.entitlement.revoke" ? "批准后目标权益撤销，历史订单不追溯改写。" : "批准后按申请结果生成或替换权益，以权益记录为准。",
      status: inactive ? "inactive" : business?.resultAvailability === "KNOWN" ? "complete" : business?.resultAvailability === "UNRESOLVED" ? "unknown" : "pending",
      statusLabel: inactive ? "未进入执行" : business?.resultAvailability === "KNOWN" ? progress.label : business?.resultAvailability === "UNRESOLVED" ? "权益结果待核对" : "待权益生效",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  if (code === "membership.benefit.policy.publish") {
    const policy = business?.publishedPolicy;
    return {
      label: "发布政策版本",
      description: "批准后发布新政策版本；已冻结订单不重算。",
      status: policy ? "complete" : "pending",
      statusLabel: policy ? `政策 v${policy.version} 已发布` : "待发布政策版本",
      facts: [{ label: "业务进度", value: progress.label }],
    };
  }
  return {
    label: "业务执行",
    description: execution.detail ?? execution.label,
    status: detail.execution?.status === "SUCCEEDED" ? "complete" : detail.execution?.status === "FAILED" ? "failed" : detail.execution ? "unknown" : detail.status === "APPROVED" ? "pending" : "inactive",
    statusLabel: execution.label,
    facts: [{ label: "执行方式", value: executionModeLabel(detail.operation.executionMode ?? business?.executionMode) }],
  };
}

function reviewDescription(code: string): string {
  if (code === "membership.benefit.policy.publish" || code === "order.compensation.grant") {
    return "由 Boss 作出首个有效批准或驳回决定；批准后进入业务执行。";
  }
  if (code === "order.settlement.adjust") {
    return "由运营或 Boss 作出决定；批准后还需回订单完成确认和过账。";
  }
  if (code === "content.fixed_document.publish") {
    return "由运营或 Boss 作出决定；批准即发布生效。";
  }
  if (code === "distribution.earning.reverse") {
    return "由运营或 Boss 作出决定；批准只授权冲回，不直接改余额。";
  }
  if (code === "distribution.policy.publish") {
    return "由运营或 Boss 作出决定；批准后生成新政策版本。";
  }
  return "由具备审批权限的人作出首个有效批准或驳回决定。";
}

function outcomeDescription(detail: RequestDetail): string {
  const code = detail.operation.code;
  if (code === "order.settlement.adjust") return "批准后进入订单确认、客服复核和过账；未过账前不算完成。";
  if (code === "order.compensation.grant") return "批准后赔偿计入号主余额；不代表渠道退款到账。";
  if (code === "content.fixed_document.publish") return "批准后本次文书发布并生效。";
  if (code === "distribution.earning.reverse") return "批准后仅授权冲回，实际变动以执行回执为准。";
  if (code === "distribution.policy.publish") return "批准后生成新政策版本，不回溯已冻结订单。";
  if (code === "membership.benefit.policy.publish") return "批准后发布新政策版本，不重算已冻结订单。";
  if (code.startsWith("membership.entitlement.")) return "批准后按申请结果生成、替换或撤销权益。";
  return "批准后进入业务执行；批准不代表资金已到账。";
}

/** Projects the existing request; this does not evaluate or execute an approval policy. */
export function requestPolicy(detail: RequestDetail): ApprovalPolicy {
  const decision = detail.decision?.decision;
  const decided = decision === "APPROVED" || decision === "REJECTED";
  const pending = detail.status === "PENDING" && !detail.decision;
  const closed = detail.status === "EXPIRED" || detail.status === "CANCELLED";
  const reviewStatus: StepStatus = decided ? "complete" : pending ? "pending" : closed ? "inactive" : "unknown";
  const execution = executionCopy(detail);
  const outcomeStatus = (value: string): StepStatus => decision === value ? "complete"
    : decided || closed || pending ? "inactive" : "unknown";

  return {
    name: detail.business?.businessTitle ?? "申请审批流程",
    roots: ["request"],
    steps: [
      {
        id: "request", kind: "approval", label: "提交申请", status: "complete", statusLabel: "已提交",
        description: shortText(detail.business?.changeSummary || detail.summary),
        approvers: [], next: ["review"],
        facts: [
          { label: "申请人", value: personLabel(detail.requester) },
          { label: "申请时间", value: detail.createdAt ?? "未提供" },
        ],
      },
      {
        id: "review", kind: "approval", label: "审批", status: reviewStatus,
        statusLabel: decided ? "已有有效决定" : pending ? "待审批" : closed ? statusView(detail.status).label : "决定记录未读到",
        description: reviewDescription(detail.operation.code),
        approvers: detail.candidates.map(candidate => ({ name: personLabel(candidate), title: candidate.eligible === true ? "可审批" : "暂不可审批" })),
        next: ["approved", "rejected"],
        facts: [
          { label: "申请状态", value: statusView(detail.status).label },
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
        description: outcomeDescription(detail),
        facts: [], next: ["execution"],
      },
      {
        id: "rejected", kind: "terminal", outcome: "rejected", label: "驳回", status: outcomeStatus("REJECTED"),
        statusLabel: decision === "REJECTED" ? "已驳回" : decision === "APPROVED" || closed ? "未走此分支" : "尚无驳回决定",
        description: "驳回后不进入本次业务执行。", facts: [], next: [],
      },
      {
        id: "execution", kind: "approval", label: execution.label, status: execution.status, statusLabel: execution.statusLabel,
        description: execution.description, approvers: [], next: [],
        facts: [
          { label: "执行方式", value: executionModeLabel(detail.operation.executionMode ?? detail.business?.executionMode) },
          ...execution.facts,
        ],
      },
    ],
  };
}
