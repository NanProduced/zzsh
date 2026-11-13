import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function DocsMoveDialog({
  moveId, setMoveId, moveParent, setMoveParent, moveAfter, setMoveAfter, moveParentOptions, movePositionOptions, onMove,
}: {
  moveId: string | null;
  setMoveId: (id: string | null) => void;
  moveParent: string;
  setMoveParent: (value: string) => void;
  moveAfter: string;
  setMoveAfter: (value: string) => void;
  moveParentOptions: readonly { value: string; label: string }[];
  movePositionOptions: readonly { value: string; label: string }[];
  onMove: (id: string, parentId: string | null, afterId: string | null) => void;
}) {
  return (
      <Dialog open={moveId !== null} onOpenChange={(open) => { if (!open) setMoveId(null); }}>
        <DialogContent className="docs-overlay">
          <DialogTitle>移动到…</DialogTitle>
          <DialogDescription>拖拽排序的键盘替代：选择新父目录与插入位置。最多三层，服务端会再次校验。</DialogDescription>
          <div className="docs-move-fields">
            <label className="docs-move-field">
              <span>目标目录</span>
              <Select value={moveParent} items={moveParentOptions} onValueChange={(value) => { setMoveParent(value === null ? "" : String(value)); setMoveAfter(""); }}>
                <SelectTrigger aria-label="目标目录"><SelectValue /></SelectTrigger>
                <SelectContent className="docs-overlay">{moveParentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
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
            <Button type="button" onClick={() => { if (!moveId) return; onMove(moveId, moveParent || null, moveAfter || null); setMoveId(null); }}>移动</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
}
