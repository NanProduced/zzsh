import type { ContentType } from "../api";
import { Button } from "@/components/ui/button";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { ITEM_NOUN } from "./content-view-tabs";

export function ContentViewDialogs({
  createOpen, setCreateOpen, creating, itemType, createTitle, setCreateTitle, itemCanEdit, itemScope, gameId, createItem,
  tabIntent, setTabIntent, itemTab, writeLockedRef, reportDirty,
}: {
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  creating: boolean;
  itemType: ContentType;
  createTitle: string;
  setCreateTitle: (value: string) => void;
  itemCanEdit: boolean;
  itemScope: string;
  gameId: string;
  createItem: () => void;
  tabIntent: (() => void) | null;
  setTabIntent: (value: (() => void) | null) => void;
  itemTab: boolean;
  writeLockedRef: { current: boolean };
  reportDirty: (dirty: boolean) => void;
}) {
  return (
    <>
      <Dialog open={createOpen} onOpenChange={open => { if (!creating) setCreateOpen(open); }}><DialogContent><DialogTitle>新建{ITEM_NOUN[itemType]}</DialogTitle><DialogDescription>先创建草稿；保存并发布后进入平台动态。</DialogDescription><Field label={`新建${ITEM_NOUN[itemType]}标题（可留空后编辑）`}><Input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} maxLength={200} autoFocus disabled={!itemCanEdit || creating} /></Field><DialogFooter><Button type="button" variant="secondary" disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" loading={creating} disabled={!itemCanEdit || (itemScope === "game" && !gameId)} onClick={() => void createItem()}>创建草稿</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={tabIntent !== null} onOpenChange={open => { if (!open) setTabIntent(null); }}><DialogContent role="alertdialog"><DialogTitle>离开当前内容？</DialogTitle><DialogDescription>{itemTab ? "未保存修改将丢失，可以返回继续编辑。" : "未保存修改将丢失。结果待核对的请求会保留，回到对应内容后继续核对。"}</DialogDescription><DialogFooter><Button type="button" variant="secondary" autoFocus onClick={() => setTabIntent(null)}>继续编辑</Button><Button type="button" variant="danger" onClick={() => { if (writeLockedRef.current) return; const action = tabIntent; setTabIntent(null); reportDirty(false); action?.(); }}>离开当前内容</Button></DialogFooter></DialogContent></Dialog>
    </>
  );
}
