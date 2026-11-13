import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import { friendlyError, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { versionTime } from "./publish-flow";
import { statusLabel, type TermOptionDraft } from "./rules-nav";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { BusyButton, EmptyHint, inputClass, RulesSelect } from "./rules-widgets";

type Command = ReturnType<typeof useRulesWrite>;

export function TermOptionsPanel({
  rules,
  command,
  gameId,
  loading,
  guard,
  termId,
  termOptions,
  setTermOptions,
  dirty,
  setDirty,
  applyTerm,
  setSwitchAsk,
  setSealAsk,
  setError,
  setSuccess,
  setLoading,
}: {
  rules: RulesResponse;
  command: Command;
  gameId: string;
  loading: boolean;
  guard: (action: () => Promise<void>) => Promise<void>;
  termId: string;
  termOptions: TermOptionDraft[];
  setTermOptions: Dispatch<SetStateAction<TermOptionDraft[]>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  applyTerm: (recordId: string, options: RulesResponse["termOptions"]) => void;
  setSwitchAsk: Dispatch<SetStateAction<{ kind: "term"; id: string } | null>>;
  setSealAsk: Dispatch<SetStateAction<{ kind: "term"; id: string; revision: string; label: string } | null>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}) {
  const selectedTerm = rules.termVersions.find((version) => version.id === termId);
  const saveTerm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTerm) return;
    if (termOptions.some((option) => !/^[a-z][a-z0-9_:-]{1,63}$/.test(option.code) || !/^[1-9]\d*$/.test(option.dailyConsumption) || !option.name.trim())) {
      setError("租期选项需要合法 code、名称与正整数日消耗哈夫币。");
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, "term", "update", {
        expectedRevision: selectedTerm.revision,
        options: termOptions.map((option) => ({ code: option.code, name: option.name, dailyConsumption: option.dailyConsumption, durationRounding: "CEIL_DAY" })),
      }, selectedTerm.id));
      if (!result) return;
      setSuccess("租期草稿已保存；日消耗只用于推算预计租期，不表示每天必须消费。");
      setDirty(false);
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };
  const createTerm = async () => {
    try {
      const result = await command.write(draftCommand(gameId, "term", "create", { gameId }));
      if (!result) return;
      applyTerm(result.receipt.id!, result.fresh.termOptions);
    } catch (failure) {
      setError(friendlyError(failure));
    }
  };
  return (
    <section className="section-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">租期版本</h3>
        <BusyButton type="button" busy={loading} disabled={command.locked} onClick={() => void guard(createTerm)}>新建租期草稿</BusyButton>
      </div>
      {rules.termVersions.length === 0 ? (
        <div className="mt-3"><EmptyHint>还没有租期版本。点击「新建租期草稿」，再添加租期档位。</EmptyHint></div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <div className="w-full sm:w-80"><RulesSelect label="租期版本" value={termId} onChange={(value) => { if (dirty && value !== termId) { setSwitchAsk({ kind: "term", id: value }); return; } applyTerm(value, rules.termOptions); }} options={rules.termVersions.map((version) => ({ value: version.id, label: `${version.id === rules.release?.termVersionId ? "当前生效" : statusLabel(version.status)}${versionTime(version) ? " · " + versionTime(version) : ""}` }))} /></div>
          {selectedTerm?.status === "DRAFT" ? <BusyButton type="button" variant="secondary" busy={loading} disabled={command.locked} title="封存后可由 Boss 绑定公告安排生效" busyText="提交中…" onClick={() => setSealAsk({ kind: "term", id: selectedTerm.id, revision: selectedTerm.revision, label: `租期 · 第 ${selectedTerm.revision} 次修改 · #${selectedTerm.id.slice(-6)}` })}>封存版本</BusyButton> : null}
        </div>
      )}
      {selectedTerm ? (
        <form onSubmit={(event) => { event.preventDefault(); void guard(() => saveTerm(event)); }} className="mt-4 space-y-3">
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader><TableRow><TableHead>选项编码</TableHead><TableHead>名称</TableHead><TableHead>日消耗（基础哈夫币）</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
              <TableBody>
                {termOptions.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="text-xs text-muted-foreground">还没有租期档位。{selectedTerm.status === "DRAFT" ? "点击「添加档位」后保存草稿。" : ""}</TableCell></TableRow>
                ) : termOptions.map((option, index) => (
                  <TableRow key={index}>
                    <TableCell><Input aria-label="选项编码" value={option.code} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, code: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                    <TableCell><Input aria-label="名称" value={option.name} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                    <TableCell><Input aria-label="日消耗" value={option.dailyConsumption} disabled={selectedTerm.status === "SEALED" || command.locked} onChange={(event) => { setTermOptions(termOptions.map((item, itemIndex) => itemIndex === index ? { ...item, dailyConsumption: event.target.value } : item)); setDirty(true); }} className={inputClass} /></TableCell>
                    <TableCell className="w-20">{selectedTerm.status === "DRAFT" ? <Button type="button" size="sm" variant="ghost" onClick={() => { setTermOptions(termOptions.filter((_, itemIndex) => itemIndex !== index)); setDirty(true); }}>删除</Button> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {selectedTerm.status === "DRAFT" ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => { setTermOptions([...termOptions, { code: `daily-${termOptions.length + 1}`, name: "新档位", dailyConsumption: "10000000" }]); setDirty(true); }}>添加档位</Button>
              <BusyButton type="submit" busy={loading} disabled={command.locked} busyText="保存中…">保存租期草稿</BusyButton>
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
