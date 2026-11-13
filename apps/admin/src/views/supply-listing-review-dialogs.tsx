import type { Dispatch, RefObject, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import type { ZoomTarget } from "./supply-review/model";

export function ListingVersionChoiceDialog({ versionChoice, setVersionChoice, changeArchiveVersion }: {
  versionChoice: { id: string | null } | undefined;
  setVersionChoice: Dispatch<SetStateAction<{ id: string | null } | undefined>>;
  changeArchiveVersion: (id: string | null) => void;
}) {
  return <>
 {versionChoice && <Dialog open onOpenChange={open => { if (!open) setVersionChoice(undefined); }}><DialogContent closeLabel="关闭窗口"><DialogTitle>切换资料记录？</DialogTitle><DialogDescription>当前未提交的核对说明将丢弃。取消可保留说明。</DialogDescription><DialogFooter><Button variant="outline" size="lg" onClick={() => setVersionChoice(undefined)}>保留说明</Button><Button variant="destructive" size="lg" onClick={() => changeArchiveVersion(versionChoice.id)}>放弃说明并切换</Button></DialogFooter></DialogContent></Dialog>}
  </>;
}

export function ListingZoomDialog({ zoom, zoomClose, closeZoom }: {
  zoom: ZoomTarget | undefined;
  zoomClose: RefObject<HTMLButtonElement | null>;
  closeZoom: () => void;
}) {
  return <>
 {zoom && <Dialog open onOpenChange={open => { if (!open) closeZoom(); }}><DialogContent data-account-image="" showCloseButton={false} initialFocus={zoomClose} finalFocus={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(960px,calc(100vw-4rem))]"><div className="flex items-start justify-between gap-4"><DialogTitle className="min-w-0 break-words text-base">{zoom.caption ?? zoom.alt}</DialogTitle><Button ref={zoomClose} variant="outline" size="sm" className="shrink-0" onClick={closeZoom}>关闭 Esc</Button></div><img src={zoom.src} alt={zoom.alt} className="max-h-[calc(100dvh-10rem)] w-full rounded-lg bg-muted object-contain"/><DialogDescription>只读取已授权的同一张图片；放大查看不会提交审核或改变公开状态。</DialogDescription></DialogContent></Dialog>}
  </>;
}
