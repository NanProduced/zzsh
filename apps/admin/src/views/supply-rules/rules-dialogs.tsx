import type { Dispatch, SetStateAction } from "react";

import { friendlyError, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { RULES_SECTION_LABEL, type RulesSection } from "./rules-nav";
import { draftCommand, type useRulesWrite } from "./rules-write";

type Command = ReturnType<typeof useRulesWrite>;
type SealAsk = { kind: "term"; id: string; revision: string; label: string };
type SwitchAsk = { kind: "term"; id: string };

export function RulesDialogs({
  rules,
  command,
  gameId,
  isBoss,
  guard,
  sealAsk,
  setSealAsk,
  leaveAsk,
  stayInSection,
  leaveSection,
  switchAsk,
  setSwitchAsk,
  applyTerm,
  setDirty,
  setError,
  setSuccess,
  setLoading,
}: {
  rules: RulesResponse | null;
  command: Command;
  gameId: string;
  isBoss: boolean;
  guard: (action: () => Promise<void>) => Promise<void>;
  sealAsk: SealAsk | null;
  setSealAsk: Dispatch<SetStateAction<SealAsk | null>>;
  leaveAsk: RulesSection | null;
  stayInSection: () => void;
  leaveSection: () => void;
  switchAsk: SwitchAsk | null;
  setSwitchAsk: Dispatch<SetStateAction<SwitchAsk | null>>;
  applyTerm: (recordId: string, options: RulesResponse["termOptions"]) => void;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}) {
  const seal = async (kind: "price" | "term", id: string, revision: string) => {
    setError(undefined);
    setLoading(true);
    try {
      const result = await command.write(draftCommand(gameId, kind, "seal", { expectedRevision: revision }, id));
      if (!result) return;
      setSuccess(isBoss ? "已提交。核对后安排生效。" : "已提交，等 Boss 排期。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };
  const commitSwitch = () => {
    if (!switchAsk || !rules) return;
    applyTerm(switchAsk.id, rules.termOptions);
    setDirty(false);
    setSwitchAsk(null);
  };
  return (
    <>
      <Dialog open={sealAsk !== null} onOpenChange={(open) => { if (!open) setSealAsk(null); }}><DialogContent closeLabel="取消"><DialogHeader><DialogTitle>提交这个版本？</DialogTitle><DialogDescription>{sealAsk ? `${sealAsk.label}。提交后锁定，Boss 确认生效后才替换线上。` : ""}</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setSealAsk(null)}>取消</Button><Button type="button" onClick={() => { const ask = sealAsk; setSealAsk(null); if (ask) void guard(() => seal(ask.kind, ask.id, ask.revision)); }}>确认提交</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={leaveAsk !== null} onOpenChange={(open) => { if (!open) stayInSection(); }}><DialogContent closeLabel="继续编辑"><DialogHeader><DialogTitle>价格草稿还有未保存的输入</DialogTitle><DialogDescription>切换到「{leaveAsk ? RULES_SECTION_LABEL[leaveAsk] : ""}」会丢掉这些输入；已保存到草稿的内容不受影响。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={stayInSection}>继续编辑</Button><Button type="button" onClick={leaveSection}>放弃并切换</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={switchAsk !== null} onOpenChange={(open) => { if (!open) setSwitchAsk(null); }}><DialogContent closeLabel="继续编辑"><DialogHeader><DialogTitle>放弃未保存的内容并切换版本？</DialogTitle><DialogDescription>当前标题、正文或租期档位还没保存。切换后这些输入会丢掉。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setSwitchAsk(null)}>继续编辑</Button><Button type="button" onClick={commitSwitch}>放弃并切换</Button></DialogFooter></DialogContent></Dialog>
    </>
  );
}
