import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HelpTreeNode } from "./docs/docs-help-api";
import { displayTitle, HelpIconSelect } from "./content-help-icons";
import { HelpTrashPanel } from "./content-help-trash";

type CreateState = { kind: "FOLDER" | "ARTICLE"; parentId: string | null };
type MoveConfirm = { id: string; parentId: string | null; afterId: string | null };
type Option = { value: string; label: string };

export function HelpWorkspaceDialogs({
  pendingNavigation, setPendingNavigation, locked, flowRef, navigate,
  trashOpen, setTrashOpen, canViewHistory, canPublish, refreshNonce, loadTree,
  create, setCreate, busy, createTitle, setCreateTitle, createSlug, setCreateSlug, submitCreate,
  createParentOptions, createIcon, setCreateIcon, createError,
  rename, setRename, renameTitle, setRenameTitle, submitRename, renameIcon, setRenameIcon, renameError,
  moveId, setMoveId, byId, affectsOnline, moveParent, setMoveParent, moveParentOptions,
  moveAfter, setMoveAfter, movePositionOptions, moveNode,
  confirmMove, setConfirmMove, deleteTarget, setDeleteTarget, confirmDelete,
}: {
  pendingNavigation: { key: string | null } | null;
  setPendingNavigation: (value: { key: string | null } | null) => void;
  locked: boolean;
  flowRef: { current: number | null };
  navigate: (key: string | null) => void;
  trashOpen: boolean;
  setTrashOpen: (open: boolean) => void;
  canViewHistory: boolean;
  canPublish: boolean;
  refreshNonce: number;
  loadTree: () => void;
  create: CreateState | null;
  setCreate: Dispatch<SetStateAction<CreateState | null>>;
  busy: boolean;
  createTitle: string;
  setCreateTitle: (value: string) => void;
  createSlug: string;
  setCreateSlug: (value: string) => void;
  submitCreate: () => void;
  createParentOptions: readonly Option[];
  createIcon: string;
  setCreateIcon: (value: string) => void;
  createError: string | null;
  rename: HelpTreeNode | null;
  setRename: (value: HelpTreeNode | null) => void;
  renameTitle: string;
  setRenameTitle: (value: string) => void;
  submitRename: () => void;
  renameIcon: string;
  setRenameIcon: (value: string) => void;
  renameError: string | null;
  moveId: string | null;
  setMoveId: (value: string | null) => void;
  byId: ReadonlyMap<string, HelpTreeNode>;
  affectsOnline: (id: string) => boolean;
  moveParent: string;
  setMoveParent: (value: string) => void;
  moveParentOptions: readonly Option[];
  moveAfter: string;
  setMoveAfter: (value: string) => void;
  movePositionOptions: readonly Option[];
  moveNode: (id: string, parentId: string | null, afterId: string | null) => void;
  confirmMove: MoveConfirm | null;
  setConfirmMove: (value: MoveConfirm | null) => void;
  deleteTarget: HelpTreeNode | null;
  setDeleteTarget: (value: HelpTreeNode | null) => void;
  confirmDelete: () => void;
}) {
  return (
    <>
      <Dialog open={pendingNavigation !== null} onOpenChange={open => { if (!open) setPendingNavigation(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>放弃未保存的修改？</DialogTitle>
          <DialogDescription>继续后，当前文章中尚未保存的修改会丢失。</DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus onClick={() => setPendingNavigation(null)}>继续编辑</Button>
            <Button type="button" variant="danger" disabled={locked} onClick={() => {
              if (!pendingNavigation || locked || flowRef.current) return;
              navigate(pendingNavigation.key);
              setPendingNavigation(null);
            }}>放弃修改并继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent className="max-w-3xl max-h-[85dvh] overflow-y-auto">
          <DialogTitle>帮助回收站</DialogTitle>
          <DialogDescription>条目保留 30 天，恢复后回到删除前的状态。</DialogDescription>
          {trashOpen && canViewHistory ? <HelpTrashPanel canRestore={canPublish} refreshNonce={refreshNonce} onRestored={() => void loadTree()} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={create !== null} onOpenChange={(open) => { if (!open && !busy) setCreate(null); }}>
        <DialogContent>
          <DialogTitle>{create?.kind === "ARTICLE" ? "新建帮助文章" : "新建帮助分组"}</DialogTitle>
          <DialogDescription>{create?.kind === "ARTICLE" ? "文章先保存为草稿，发布后对用户可见。" : "目录最多三层，含有已发布文章的分组会显示在用户侧。"}</DialogDescription>
          <Field label="标题">
            <Input value={createTitle} maxLength={create?.kind === "FOLDER" ? 40 : 200} autoFocus disabled={busy} onChange={(event) => setCreateTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitCreate(); } }} />
          </Field>
          {create?.kind === "ARTICLE" ? <Field label="文章地址（可选）" hint="留空自动生成。发布后可使用此地址打开文章。">
            <Input value={createSlug} maxLength={120} disabled={busy} placeholder="例如 rental-getting-started" onChange={(event) => setCreateSlug(event.target.value)} />
          </Field> : null}
          <label className="docs-move-field">
            <span>父目录</span>
            <Select value={create?.parentId ?? ""} items={createParentOptions} onValueChange={(value) => setCreate((current) => current ? { ...current, parentId: value === null || value === "" ? null : String(value) } : current)} disabled={busy}>
              <SelectTrigger aria-label="父目录"><SelectValue /></SelectTrigger>
              <SelectContent>{createParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {create?.kind === "FOLDER" && create.parentId === null ? <HelpIconSelect value={createIcon} onChange={setCreateIcon} disabled={busy} /> : null}
          {createError ? <p className="docs-inline-error" role="alert">{createError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setCreate(null)}>取消</Button>
            <Button type="button" loading={busy} onClick={() => void submitCreate()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rename !== null} onOpenChange={(open) => { if (!open && !busy) setRename(null); }}>
        <DialogContent>
          <DialogTitle>编辑分组</DialogTitle>
          <DialogDescription>分组设置保存后即时生效。</DialogDescription>
          <Field label="标题">
            <Input value={renameTitle} maxLength={rename?.kind === "FOLDER" ? 40 : 200} autoFocus disabled={busy} onChange={(event) => setRenameTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitRename(); } }} />
          </Field>
          {rename?.parentId === null ? <HelpIconSelect value={renameIcon} onChange={setRenameIcon} disabled={busy} /> : null}
          {renameError ? <p className="docs-inline-error" role="alert">{renameError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRename(null)}>取消</Button>
            <Button type="button" loading={busy} onClick={() => void submitRename()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveId !== null} onOpenChange={(open) => { if (!open) setMoveId(null); }}>
        <DialogContent>
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription>将「{moveId && byId.get(moveId) ? displayTitle(byId.get(moveId)!) : "该条目"}」移动到指定分组和位置。{moveId && affectsOnline(moveId) ? "线上目录立即更新，文章地址保持不变。" : ""}</DialogDescription>
          <div className="docs-move-fields">
            <label className="docs-move-field">
              <span>目标目录</span>
              <Select value={moveParent} items={moveParentOptions} onValueChange={(value) => { setMoveParent(value === null ? "" : String(value)); setMoveAfter(""); }}>
                <SelectTrigger aria-label="目标目录"><SelectValue /></SelectTrigger>
                <SelectContent>{moveParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="docs-move-field">
              <span>插入位置</span>
              <Select value={moveAfter} items={movePositionOptions} onValueChange={(value) => setMoveAfter(value === null ? "" : String(value))}>
                <SelectTrigger aria-label="插入位置"><SelectValue /></SelectTrigger>
                <SelectContent>{movePositionOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setMoveId(null)}>取消</Button>
            <Button type="button" disabled={!moveId || !byId.has(moveId) || Boolean(moveParent && !byId.has(moveParent)) || Boolean(moveAfter && !byId.has(moveAfter))} onClick={() => { if (!moveId) return; void moveNode(moveId, moveParent || null, moveAfter || null); setMoveId(null); }}>移动</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmMove !== null} onOpenChange={open => { if (!open) setConfirmMove(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>确认调整目录位置？</DialogTitle>
          <DialogDescription>将「{confirmMove && byId.get(confirmMove.id) ? displayTitle(byId.get(confirmMove.id)!) : "该条目"}」放到「{confirmMove?.parentId ? byId.get(confirmMove.parentId) ? displayTitle(byId.get(confirmMove.parentId)!) : "目标分组已变化" : "帮助目录顶层"}」{confirmMove?.afterId ? `中「${byId.get(confirmMove.afterId) ? displayTitle(byId.get(confirmMove.afterId)!) : "目标位置已变化"}」之后` : "最前面"}。线上目录立即更新，文章地址保持不变。</DialogDescription>
          <DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setConfirmMove(null)}>取消</Button><Button type="button" disabled={!confirmMove || !byId.has(confirmMove.id) || Boolean(confirmMove.parentId && !byId.has(confirmMove.parentId)) || Boolean(confirmMove.afterId && !byId.has(confirmMove.afterId))} onClick={() => { if (confirmMove) void moveNode(confirmMove.id, confirmMove.parentId, confirmMove.afterId); setConfirmMove(null); }}>确认移动</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
        <DialogContent role="alertdialog">
          <DialogTitle>删除「{deleteTarget ? displayTitle(deleteTarget) : ""}」？</DialogTitle>
          <DialogDescription>
            {deleteTarget?.kind === "ARTICLE" ? "文章将下线并移到回收站，保留 30 天。" : "分组及其中的文章会移到回收站，保留 30 天。已发布的文章会同时下线。"}
            {typeof deleteTarget?.referenceCount === "number" && deleteTarget.referenceCount > 0 ? ` 有 ${deleteTarget.referenceCount} 处引用（其他文章关联、正文链接、页脚或动态），删除后这些链接会失效。` : ""}
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus disabled={busy} onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button type="button" variant="danger" loading={busy} onClick={() => void confirmDelete()}>删除进回收站</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
