/** Display-only adaptation of approvals-ui (MIT), see components/approvals-ui/LICENSE. */
export type StepStatus = "complete" | "pending" | "inactive" | "unknown" | "failed";

type Step = {
  id: string;
  label: string;
  description: string;
  status: StepStatus;
  statusLabel: string;
  facts: { label: string; value: string }[];
  next: string[];
};

export type ApprovalStep = Step & {
  kind: "approval";
  approvers: { name: string; title: string }[];
};

export type TerminalStep = Step & { kind: "terminal"; outcome: "approved" | "rejected" };
export type ApprovalPolicy = { name: string; roots: string[]; steps: (ApprovalStep | TerminalStep)[] };
