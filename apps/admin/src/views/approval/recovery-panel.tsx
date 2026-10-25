import { CircleCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui-elements";
import { formatDate } from "../../api";
import { ACTION_LABELS, executionView, reasonLabel, statusView, type RecoveryResult } from "./contract";
import { Fact, FactGrid } from "./atoms";

export type RecoveryLookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "known"; result: RecoveryResult }
  | { state: "not_found"; result: RecoveryResult }
  | { state: "denied"; message: string }
  | { state: "error"; message: string };

const RECEIPT_FIELDS: Array<[string, (receipt: NonNullable<RecoveryResult["receipt"]>) => string | null]> = [
  ["申请编号", (receipt) => receipt.approvalRequestId ?? null],
  ["审批状态", (receipt) => (receipt.status ? statusView(receipt.status).label : null)],
  ["决定", (receipt) => (receipt.decision === "APPROVED" ? "批准" : receipt.decision === "REJECTED" ? "驳回" : receipt.decision ?? null)],
  ["执行状态", (receipt) => (receipt.executionStatus ? executionView(receipt.executionStatus).label : null)],
  ["结果码", (receipt) => receipt.resultCode ?? null],
  ["业务结果引用", (receipt) => receipt.businessResultRef ?? null],
  ["模板版本", (receipt) => (receipt.templateVersion ? `v${receipt.templateVersion}` : null)],
  ["候选人数", (receipt) => (typeof receipt.candidateCount === "number" ? String(receipt.candidateCount) : null)],
  ["追加的候选人", (receipt) => receipt.candidateUsername ?? null],
  ["有效期至", (receipt) => (receipt.expiresAt ? formatDate(receipt.expiresAt) : null)],
];

function Receipt({ result }: { result: RecoveryResult }) {
  const receipt = result.receipt;
  const rejection = receipt?.rejection;
  return (
    <div className="space-y-3">
      <FactGrid>
        <Fact label="原请求提交时间" value={formatDate(result.committedAt ?? null)} />
        <Fact label="原响应" value={result.originalResponseStatus ? `${result.originalResponseStatus} · ${result.outcome === "ACCEPTED" ? "已受理" : result.outcome === "REJECTED" ? "被拒绝" : result.outcome}` : null} />
        <Fact label="操作" value={ACTION_LABELS[operationAction(result.operation)] ?? result.operation} mono />
        <Fact label="原请求标识" value={result.key} mono />
      </FactGrid>
      {rejection ? (
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>原请求当时被拒绝</AlertTitle>
          <AlertDescription className="break-words">
            <span className="font-mono">{rejection.code}</span> · {rejection.message}
            {rejection.reasons?.length ? ` · ${rejection.reasons.map(reasonLabel).join("；")}` : ""}
            。这是原回执，不是新的失败；同一标识重放会得到同一个拒绝。
          </AlertDescription>
        </Alert>
      ) : receipt ? (
        <FactGrid>
          {RECEIPT_FIELDS.map(([label, read]) => {
            const value = read(receipt);
            return value === null ? null : <Fact key={label} label={label} value={value} mono={label === "申请编号" || label === "结果码" || label === "业务结果引用"} />;
          })}
        </FactGrid>
      ) : (
        <p className="text-xs text-muted-foreground">回执没有可投影的业务字段。</p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        以上只是「这把请求标识 → 原回执」的映射，不代表业务已落地；业务是否生效以领域结果与来源业务为准。
        {result.fingerprint ? <> 回执指纹 <span className="font-mono break-all">{result.fingerprint}</span> 可用于区分「同一意图重放」与「这把标识被用在了别的命令上」。</> : null}
      </p>
    </div>
  );
}

function operationAction(operation: string): string {
  if (operation === "approval.request.decide") return "approve";
  if (operation === "approval.request.execute") return "execute";
  if (operation === "approval.request.add_candidate") return "addCandidate";
  return operation;
}

/**
 * 未核清责任的恢复面。四种结果分开表达：
 * 已知回执 / 未找到回执（读不到≠没执行）/ 恢复被拒（≠原操作失败）/ 查询本身失败。
 */
export function RecoveryPanel({
  kind, lookup, busy, lookupBusy = false, persisted = true, others = 0, onRetryWrite, onRetryReadback, onLookup, onDiscard,
}: {
  kind: "unknown" | "readback" | "resolved";
  lookup: RecoveryLookup;
  /** 写或读回在途。 */
  busy: boolean;
  /** 恢复查询在途：其余出口禁用但不换文案。 */
  lookupBusy?: boolean;
  /** 责任记录是否已落浏览器存储；否则关闭页面后无法自动恢复。 */
  persisted?: boolean;
  /** 同身份下其他对象的未核清笔数。 */
  others?: number;
  onRetryWrite: () => void;
  onRetryReadback: () => void;
  onLookup: () => void;
  onDiscard: () => void;
}) {
  if (kind === "resolved") {
    // 终态证据已到达：不再给出与结果矛盾的 UNKNOWN 重放出口。
    return (
      <section className="space-y-3 rounded-md border border-border bg-foreground/[0.02] p-3">
        <Alert variant="success" role="status">
          <CircleCheck aria-hidden="true" />
          <AlertTitle>原结果已核清</AlertTitle>
          <AlertDescription>
            已拿到与这把请求标识一致的回执，这笔责任不再未决。下面是原回执内容；业务是否落地仍以领域结果为准。
          </AlertDescription>
        </Alert>
        {lookup.state === "known" ? <Receipt result={lookup.result} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={onRetryReadback}>刷新最新状态</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-border bg-foreground/[0.02] p-3">
      <Alert variant="warning" role="status">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>
          {kind === "unknown" ? "审批请求 · 结果未知" : "已受理，但最新状态未确认"}
        </AlertTitle>
        <AlertDescription>
          {kind === "unknown"
            ? "服务端可能已经处理这次请求。责任尚未核清前不要换新标识重试，也不要把它当作失败；下面两个入口都不会产生第二次业务写入以外的效果。"
            : "请求已被受理，但回读最新状态失败。原申请上下文与请求标识已保留，先确认状态再决定是否继续。"}
        </AlertDescription>
      </Alert>

      {lookup.state === "known" ? <Receipt result={lookup.result} /> : null}
      {lookup.state === "not_found" ? (
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>没有找到这把请求标识对应的回执</AlertTitle>
          <AlertDescription>
            {reasonLabel(lookup.result.explanationCode)}；{reasonLabel(lookup.result.resolution)}。
            没有回执不能证明原操作没有发生（例如写入已提交但回执读取路径不可达），因此不自动允许换新标识重试。
          </AlertDescription>
        </Alert>
      ) : null}
      {lookup.state === "denied" ? (
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>恢复读取被拒</AlertTitle>
          <AlertDescription className="break-words">
            {lookup.message}。这是恢复被拒，不是原操作失败：服务端没有回任何回执字段，也没有产生第二次写入。
            常见原因是授权或业务范围在提交后发生变化，或这张申请已不在你的可读范围内。
          </AlertDescription>
        </Alert>
      ) : null}
      {lookup.state === "error" ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>查询原结果失败</AlertTitle>
          <AlertDescription className="break-words">{lookup.message}。原责任仍未核清，可重新查询或用原请求重试。</AlertDescription>
        </Alert>
      ) : null}
      {lookup.state === "loading" ? <p className="text-xs text-muted-foreground">正在查询原结果…</p> : null}

      <div className="flex flex-wrap gap-2">
        {kind === "unknown" ? (
          <Button type="button" size="sm" variant="secondary" loading={busy} disabled={busy || lookupBusy} onClick={onRetryWrite}>用原请求重试</Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" loading={busy} disabled={busy || lookupBusy} onClick={onRetryReadback}>重试读取最新状态</Button>
        )}
        <Button type="button" size="sm" variant="secondary" loading={lookupBusy} disabled={busy || lookupBusy} onClick={onLookup}>
          {lookup.state === "idle" ? "查询原结果" : "重新查询原结果"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || lookupBusy} onClick={onDiscard}>暂时收起</Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        收起只隐藏面板：原请求标识与请求内容仍保留在当前身份与会话的责任记录里，回到原对象时会重新出现。
        只有读回核实、查到已知回执、或首次提交被服务端明确拒绝，才会解除这笔责任；重放被拒、查不到回执或恢复读取被拒都不解除。
        {others > 0 ? ` 另有 ${others} 笔其他对象的未核清请求。` : ""}
        {!persisted ? " 浏览器存储不可用：本记录仅在当前页面实例内有效，关闭页面后无法自动恢复。" : ""}
      </p>
    </section>
  );
}
