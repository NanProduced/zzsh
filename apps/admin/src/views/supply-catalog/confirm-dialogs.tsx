import type { Dispatch, SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { OBJECT_LABEL, type CatalogKind, type CatalogRow } from "./model";
import type { EditorState, WritePhase } from "./editor-fields";

export function CatalogConfirmDialogs({
  toggleDraft, setToggleDraft, toggleLabel, writePhase, storageBlocked, confirmToggle, closeAsked, setCloseAsked,
  editor, detailFocusTarget, changeEditor, pendingSwitch, setPendingSwitch, applySwitch,
}: {
  toggleDraft: { kind: CatalogKind; row: CatalogRow; field: "enabled" | "formVisible"; revision: string } | null;
  setToggleDraft: Dispatch<SetStateAction<{ kind: CatalogKind; row: CatalogRow; field: "enabled" | "formVisible"; revision: string } | null>>;
  toggleLabel: string;
  writePhase: WritePhase;
  storageBlocked: boolean;
  confirmToggle: () => void;
  closeAsked: boolean;
  setCloseAsked: Dispatch<SetStateAction<boolean>>;
  editor: EditorState | null;
  detailFocusTarget: () => HTMLElement | undefined;
  changeEditor: (next: EditorState | null) => void;
  pendingSwitch: { type: "tab" | "game"; value: string } | null;
  setPendingSwitch: Dispatch<SetStateAction<{ type: "tab" | "game"; value: string } | null>>;
  applySwitch: (type: "tab" | "game", value: string) => void;
}) {
  const skinEditing = editor?.kind === "skins";
  return (
    <>
    <Dialog open={Boolean(toggleDraft)} onOpenChange={(open) => { if (!open) setToggleDraft(null); }}>
      <DialogContent className="sm:max-w-md" closeLabel="关闭状态确认">
        <DialogHeader>
          <DialogTitle>{toggleDraft ? `${toggleLabel}${OBJECT_LABEL[toggleDraft.kind]}？` : "确认状态修改"}</DialogTitle>
          <DialogDescription>{toggleDraft?.row.name ? `「${String(toggleDraft.row.name)}」的稳定身份与历史引用会保留。` : "历史引用会保留。"}引用影响范围尚未提供。{toggleDraft?.kind === "skins" ? "皮肤身份核实、启用与表单展示分别处理。" : ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter><Button type="button" variant="outline" className="h-9" onClick={() => setToggleDraft(null)}>取消</Button><Button type="button" className="h-9" variant={toggleDraft?.row[toggleDraft.field] ? "destructive" : "default"} disabled={writePhase !== "idle" || storageBlocked} onClick={confirmToggle}>确认{toggleLabel}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={closeAsked} onOpenChange={setCloseAsked}>
      <DialogContent className="sm:max-w-md" closeLabel="继续编辑" finalFocus={() => editor ? true : detailFocusTarget()}>
        <DialogHeader><DialogTitle>放弃未保存修改？</DialogTitle><DialogDescription>{skinEditing ? "取消编辑将放弃尚未保存的词条修改；已提交的原请求仍会保留。" : "行内输入和详细信息属于同一次修改。取消编辑会一并丢弃；返回编辑可继续保存。"}</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setCloseAsked(false)}>继续编辑</Button><Button type="button" variant="destructive" onClick={() => changeEditor(null)}>放弃修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pendingSwitch)} onOpenChange={(open) => { if (!open) setPendingSwitch(null); }}>
      <DialogContent className="sm:max-w-md" closeLabel="保留编辑">
        <DialogHeader>
          <DialogTitle>切换将放弃未保存修改</DialogTitle>
          <DialogDescription>当前编辑内容尚未保存；切换对象或游戏会丢弃这些输入。已提交但结果未知的操作不受影响，仍可在页首核对原提交。</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPendingSwitch(null)}>保留编辑</Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => pendingSwitch && applySwitch(pendingSwitch.type, pendingSwitch.value)}>放弃修改并切换</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
