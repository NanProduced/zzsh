import { useCallback, useEffect, useRef, useState } from "react";

import { AlertCircle, CheckCircle2, FileImage, Loader2, RefreshCw, Upload, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { SupplyGame } from "../../api";
import { ALLOWED_IMAGE_MIMES, sizeText, UPLOAD_PURPOSES, validateImageFile, type UploadPurpose } from "./model";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

export type UploadStepState = "idle" | "active" | "done" | "failed" | "unknown";

export type UploadDialogState = {
  open: boolean;
  step: "select" | "intent" | "bytes" | "readback" | "done";
  stepState: Record<"intent" | "bytes" | "readback", UploadStepState>;
  message: string | null;
  error: string | null;
};

export const emptyUploadDialog = (): UploadDialogState => ({
  open: false,
  step: "select",
  stepState: { intent: "idle", bytes: "idle", readback: "idle" },
  message: null,
  error: null,
});

const PURPOSE_ITEMS = UPLOAD_PURPOSES.map((value) => ({
  value,
  label: { GAME_COVER: "游戏封面", SKIN_MEDIA: "皮肤图", ITEM_MEDIA: "物品图", FIREARM_MEDIA: "枪械图" }[value],
}));

function StepRow({ label, state }: { label: string; state: UploadStepState }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      {state === "done" ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : state === "failed" ? <AlertCircle className="size-3.5 text-destructive" /> : state === "unknown" ? <AlertCircle className="size-3.5 text-amber-500" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" /> : <span className="size-3.5 rounded-full border border-border" />}
      <span className={state === "idle" ? "text-muted-foreground" : ""}>{label}</span>
    </li>
  );
}

/**
 * 上传平台素材：选择文件→本地校验→建立意图→字节上传→读取上传结果→待审核。
 * 各步状态独立表达；字节重试沿用原意图与原幂等键（onRetry），成功后才清文件。
 * 本地预览只在浏览器内存，不上传到任何第三方。
 */
export function UploadMediaDialog({
  open,
  onOpenChange,
  games,
  gamesState = "ok",
  state,
  onSubmit,
  onRetry,
  onReadback,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  games: SupplyGame[];
  gamesState?: "ok" | "loading" | "failed";
  state: UploadDialogState;
  onSubmit: (input: { gameId: string; purpose: UploadPurpose; file: File }) => void;
  onRetry: () => void;
  onReadback: () => void;
}) {
  const [gameId, setGameId] = useState("");
  const [purpose, setPurpose] = useState<UploadPurpose>("GAME_COVER");
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const effectiveGameId = gameId || games[0]?.id || "";
  const readbackStage = state.step === "readback";
  const busy = state.stepState.intent === "active" || state.stepState.bytes === "active" || state.stepState.readback === "active";
  const unknown = state.stepState.intent === "unknown" || state.stepState.bytes === "unknown";
  // 意图开始后冻结游戏/用途/文件：继续的是原 key 原文件，不能换成新文件冒充原请求重试。
  const frozen = state.step !== "select" || busy;

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // 真正上传成功后才清文件（关闭对话框保留待重试的文件引用）。
  useEffect(() => {
    if (state.step === "done") {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [state.step]);

  const pickFile = useCallback((next: File | null) => {
    setLocalError(null);
    if (!next) {
      setFile(null);
      return;
    }
    const problem = validateImageFile(next);
    if (problem) {
      setLocalError(problem);
      setFile(null);
      return;
    }
    setFile(next);
  }, []);

  const submit = () => {
    if (busy) return;
    if (unknown) {
      onRetry();
      return;
    }
    if (readbackStage) {
      onReadback();
      return;
    }
    if (state.step !== "select") return;
    if (!effectiveGameId) {
      setLocalError("请先创建游戏后再上传平台素材。");
      return;
    }
    if (!file) {
      setLocalError("请先选择图片文件。");
      return;
    }
    const problem = validateImageFile(file);
    if (problem) {
      setLocalError(problem);
      return;
    }
    onSubmit({ gameId: effectiveGameId, purpose, file });
  };

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>上传平台素材</DialogTitle>
          <DialogDescription>
            上传后默认私有并进入待审核；只有审核通过且用途允许的素材才能公开。JPEG/PNG/WebP，≤10 MiB。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="游戏" hint="素材归属该游戏目录；上传不建立任何对象绑定。">
            <Select value={effectiveGameId} items={games.map((game) => ({ value: game.id, label: game.name }))} onValueChange={(value) => setGameId(String(value))} disabled={frozen}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue placeholder={gamesState === "failed" ? "游戏列表读取失败" : gamesState === "loading" ? "游戏读取中…" : games.length ? "选择游戏" : "请先创建游戏"} />
              </SelectTrigger>
              <SelectContent>
                {games.map((game) => (
                  <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="用途">
            <Select value={purpose} items={PURPOSE_ITEMS} onValueChange={(value) => setPurpose(value as UploadPurpose)} disabled={frozen}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PURPOSE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-1 text-xs">
            <span className="text-muted-foreground">图片</span>
            <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={inputRef}
                  type="file"
                  accept={ALLOWED_IMAGE_MIMES.join(",")}
                  className="hidden"
                  aria-label="选择图片文件"
                  onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                  disabled={frozen}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={frozen}>
                  <FileImage /> 选择文件
                </Button>
                {file ? (
                  <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0">{sizeText(file.size)}</span>
                    {!frozen ? (
                      <Button type="button" variant="ghost" size="icon-xs" aria-label="移除已选文件" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }}>
                        <X />
                      </Button>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">未选择文件</span>
                )}
            </div>
            {previewUrl ? <img src={previewUrl} alt="待上传图片本地预览" className="mt-2 max-h-40 rounded border border-border object-contain" /> : null}
            <span className="block text-[11px] text-muted-foreground/80">本地校验只看类型与大小；服务端按真实字节再校验，一种格式通过不代表全部可用。</span>
          </div>

          {state.step !== "select" ? (
            <div className="space-y-2 rounded border border-border p-3">
              <p className="text-xs font-medium">上传进度</p>
              <ul className="space-y-1.5">
                <StepRow label="建立上传意图" state={state.stepState.intent} />
                <StepRow label="字节上传" state={state.stepState.bytes} />
                <StepRow label="读取上传结果" state={state.stepState.readback} />
              </ul>
            </div>
          ) : null}

          {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
          {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
          {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
          {unknown ? <Badge variant="warning">结果未知：按原请求重试不会新建上传意图</Badge> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>关闭</Button>
          <Button type="button" onClick={submit} disabled={busy || state.step === "done" || (state.step === "select" && gamesState !== "ok")}>
            {unknown ? <><RefreshCw /> 按原请求重试</> : readbackStage ? <><RefreshCw /> 重新读取队列</> : <><Upload /> 上传并进入待审</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
