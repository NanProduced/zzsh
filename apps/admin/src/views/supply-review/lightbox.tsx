import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * 页内图片放大：现有 shadcn Dialog（Base UI）。关闭区在对话框内可达（手机可点），
 * Escape 只关闭放大层并回母面板，焦点回到触发按钮由 Base UI 处理。
 * 仅放大已授权的同一 content 地址，不新增下载能力。
 */
export function Lightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Escape 仅关本层，不冒泡关掉母级 Sheet/Dialog。 */}
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl"
        closeLabel="关闭放大图"
        onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      >
        <DialogHeader className="min-w-0 pr-12">
          <DialogTitle className="min-w-0 break-all text-sm">{alt}</DialogTitle>
          <DialogDescription className="break-words">{caption ?? "放大核对只读取已授权图片，不新增下载能力。"}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <img src={src} alt={alt} className="max-h-[70dvh] w-full rounded-lg bg-surface-raised object-contain" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
