import { CircleAlert, TriangleAlert } from "lucide-react";

import type { RulesResponse } from "../../api";
import { StatusMessage } from "../../components/ui-elements";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { isPricingScheduleOperation, RULES_RELEASE_OPERATION, type useRulesWrite } from "./rules-write";
import { RULES_SECTION_LABEL, type RulesSection } from "./rules-nav";

type Command = ReturnType<typeof useRulesWrite>;

export function RulesPageHeader({
  section,
  rules,
  showSchedules,
  deltaSection,
  error,
  success,
  command,
  gameId,
  onRecover,
}: {
  section: RulesSection;
  rules: RulesResponse | null;
  showSchedules: boolean;
  deltaSection: boolean;
  error?: string;
  success?: string;
  command: Command;
  gameId: string;
  onRecover: () => Promise<void>;
}) {
  return (
    <section className="section-panel">
      <div className="min-w-0 max-w-3xl">
        <h2 className="flex flex-wrap items-center gap-2 text-2xl leading-9 font-semibold">{RULES_SECTION_LABEL[section]}{rules ? <span className="rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted-foreground">{rules.game.name}</span> : null}</h2>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{section === "overview" ? "线上正在运行的规则与版本历史。" : section === "settlement" ? "全额包赔承担方及提前结束时的补足规则。" : section === "agreement" ? "租客下单时查阅的标准出租协议。" : showSchedules ? "" : deltaSection ? "线上运行与草稿修改相互隔离：保存改动进入草稿，封存后由 Boss 绑定公告并安排生效。" : ""}</p>
      </div>
      <StatusMessage themeAware error={error} success={success} className="mt-3" />
      {command.locked ? (
        <Alert variant="warning" role="status" className="mt-3">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{command.state.kind === "blocked" ? "规则写入已暂停" : command.pending?.receipt ? "已收到原写入回执，回读尚未完成" : command.state.kind === "busy" ? "规则请求正在提交" : "原规则写入结果尚未核清"}</AlertTitle>
          <AlertDescription>
            <p>{command.state.kind === "blocked" ? command.state.message : command.pending?.receipt ? command.state.message ?? "已收到原写入回执，规则回读尚未完成；不能再次提交。" : command.state.kind === "busy" ? "正在提交规则请求，原 key 与版本已保留。" : command.state.message ?? "原规则写入结果尚未核清，已保留原 key 与输入，暂停新的写入。"}</p>
            {command.pending && command.pending.gameId !== gameId ? <p>原请求属于游戏 {command.pending.gameId}，请切回该游戏核对。</p> : null}
          </AlertDescription>
          <AlertAction><Button type="button" variant="outline" size="sm" disabled={!command.pending || command.pending.gameId !== gameId || ["busy", "recovering"].includes(command.state.kind)} onClick={() => void onRecover()}>核对原写入回执</Button></AlertAction>
        </Alert>
      ) : null}
      {command.state.kind === "conflict" ? (
        <Alert variant="warning" role="alert" className="mt-3">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>版本已变化（409）</AlertTitle>
          <AlertDescription><p>{command.state.message ?? "输入已保留。请核对当前版本后再操作。"}</p></AlertDescription>
        </Alert>
      ) : command.state.kind === "error" ? (
        <Alert variant="destructive" className="mt-3">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>请求被明确拒绝</AlertTitle>
          <AlertDescription><p>{command.state.message}</p></AlertDescription>
        </Alert>
      ) : null}
      {command.state.kind === "not_sent" ? <p role="status" className="mt-3 text-sm text-muted-foreground">{command.state.message}</p> : null}
      {command.state.kind === "done" && command.state.operation !== RULES_RELEASE_OPERATION ? <p role="status" className="mt-3 text-sm text-muted-foreground">{isPricingScheduleOperation(command.state.operation) ? "排期已保存并核对。" : "已保存到草稿。"}</p> : null}
    </section>
  );
}
