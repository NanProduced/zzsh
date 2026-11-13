import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import type { DocTreeNode } from "./docs-model";

export function DocsDetailDialogs({
  reloadOpen, setReloadOpen, load, deleteOpen, setDeleteOpen, deleting, node, subtreeCount, confirmDelete,
}: {
  reloadOpen: boolean;
  setReloadOpen: (open: boolean) => void;
  load: () => void;
  deleteOpen: boolean;
  setDeleteOpen: (open: boolean) => void;
  deleting: boolean;
  node: DocTreeNode;
  subtreeCount: number;
  confirmDelete: () => void;
}) {
  return (
    <>
      <Dialog open={reloadOpen} onOpenChange={setReloadOpen}>
        <DialogContent role="alertdialog" className="docs-overlay">
          <DialogTitle>读取最新正文？</DialogTitle>
          <DialogDescription>读取服务端正文会放弃当前未保存的输入。</DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus onClick={() => setReloadOpen(false)}>继续保留输入</Button>
            <Button type="button" variant="danger" onClick={() => { setReloadOpen(false); void load(); }}>放弃并读取</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}>
        <DialogContent role="alertdialog" className="docs-overlay">
          <DialogTitle>删除「{node.title}」？</DialogTitle>
          <DialogDescription>
            将删除该文档及其子文档（共 {Math.max(1, subtreeCount)} 篇），进入回收站保留 30 天，到期永久清理。恢复需要管理权限。
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="secondary" autoFocus disabled={deleting} onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button type="button" variant="danger" loading={deleting} onClick={() => void confirmDelete()}>删除整棵子树</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
