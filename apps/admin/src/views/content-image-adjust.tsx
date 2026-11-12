import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { ResourceDefinition } from "@zzsh/content";
import { Button } from "@/components/ui/button";
import { Input } from "../components/ui/input";
import { MAX_CONTENT_IMAGE_BYTES } from "./content-media-upload";

export type ContentImageSource = File | { url: string };
const MAX_SIDE = 8192;
const MAX_PIXELS = 40_000_000;
const allowedRatios = [
  { value: "original", label: "原图比例" },
  { value: "1.7777777777777777", label: "横图 16:9" },
  { value: "1", label: "方图 1:1" },
  { value: "0.75", label: "竖图 3:4" },
] as const;
type CropRect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function contentCropRect(width: number, height: number, ratio: number, zoom: number, x: number, y: number): CropRect {
  const cropWidth = Math.min(width, height * ratio) / clamp(zoom, 1, 3);
  const cropHeight = cropWidth / ratio;
  return { x: (width - cropWidth) * (clamp(x, -1, 1) + 1) / 2, y: (height - cropHeight) * (clamp(y, -1, 1) + 1) / 2, width: cropWidth, height: cropHeight };
}

function drawImage(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: CropRect, contain: boolean, white: boolean) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error();
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (white) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); }
  ctx.imageSmoothingQuality = "high";
  if (contain) {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  } else ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
}

export function ContentImageAdjust({ source, definition, onApply, onCancel, outputMime }: {
  source: ContentImageSource; definition?: ResourceDefinition | null; outputMime?: "image/png"; onApply: (file: File) => void; onCancel: () => void;
}) {
  const preview = useRef<HTMLCanvasElement>(null), heading = useRef<HTMLHeadingElement>(null), sequence = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [ratioChoice, setRatioChoice] = useState("original"), [output, setOutput] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const qr = definition?.kind === "contact" || definition?.kind === "footer";
  const [contain, setContain] = useState(qr);
  useEffect(() => {
    const id = ++sequence.current, local = source instanceof File;
    const url = local ? URL.createObjectURL(source) : source.url;
    const next = new Image();
    heading.current?.focus();
    next.onload = () => {
      if (sequence.current !== id) return;
      const { naturalWidth: w, naturalHeight: h } = next;
      if (!w || !h || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) setError("请选择单边不超过 8192 像素、总像素不超过 4000 万的图片。");
      else setImage(next);
    };
    next.onerror = () => { if (sequence.current === id) setError("这张图无法读取，请换一张图片重试。"); };
    next.src = url;
    return () => { ++sequence.current; next.onload = null; next.onerror = null; if (local) URL.revokeObjectURL(url); };
  }, [source]);

  const originalRatio = image ? image.naturalWidth / image.naturalHeight : 1;
  const ratio = definition?.aspectRatio ?? (ratioChoice === "original" ? originalRatio : Number(ratioChoice));
  const crop = image ? contentCropRect(image.naturalWidth, image.naturalHeight, ratio, zoom, pan.x, pan.y) : null;
  const canPan = !contain && image && crop && (image.naturalWidth - crop.width > 1 || image.naturalHeight - crop.height > 1);
  const maxWidth = Math.min(MAX_SIDE, Math.floor(MAX_SIDE * ratio), Math.floor(Math.sqrt(MAX_PIXELS * ratio)));
  const minWidth = Math.max(definition?.minWidth ?? 1, Math.ceil((definition?.minHeight ?? 1) * ratio), Math.ceil(ratio));
  const targetWidth = Number.parseInt(definition?.recommendedSize ?? "", 10);
  const originalCropWidth = image ? Math.min(image.naturalWidth, image.naturalHeight * ratio) : minWidth;
  const defaultWidth = clamp(qr && targetWidth ? targetWidth : Math.floor(Math.min(targetWidth || 1920, originalCropWidth)), minWidth, maxWidth);
  const width = output === null ? defaultWidth : Number(output), height = Math.round(width / ratio);
  const valid = Number.isInteger(width) && width >= minWidth && width <= maxWidth && height >= 1 && height <= MAX_SIDE && width * height <= MAX_PIXELS;
  const previewWidth = Math.max(1, Math.round(Math.min(640, 480 * ratio))), previewHeight = clamp(Math.round(previewWidth / ratio), 1, 480);
  useEffect(() => {
    if (!image || !crop || !preview.current) return;
    try { drawImage(preview.current, image, crop, contain, qr); }
    catch { setError("无法预览裁剪，请换一张图片重试。"); }
  }, [image, ratio, zoom, pan, contain, qr]);
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); setOutput(null); setError(""); };
  const apply = () => {
    if (!image || !crop || !valid || busy) return;
    const id = sequence.current;
    setBusy(true); setError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      drawImage(canvas, image, crop, contain, qr);
      canvas.toBlob(blob => {
        if (sequence.current !== id) return;
        setBusy(false);
        if (!blob?.size || blob.size > MAX_CONTENT_IMAGE_BYTES) { setError("调整后的图片超过上传限制，请缩小输出尺寸后再试。"); return; }
        onApply(new File([blob], `调整后的图片.${blob.type === "image/webp" ? "webp" : "png"}`, { type: blob.type }));
      }, outputMime ?? (qr ? "image/png" : "image/webp"), .92);
    } catch {
      setBusy(false); setError("无法生成调整后的图片，请改用本地原图重试。");
    }
  };

  return <section className="content-image-adjust" aria-label="调整图片">
    <div>
      <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">裁剪或调整尺寸</h3>
      <p className="mt-1 text-xs text-muted-foreground">{qr ? "默认保留整张二维码，请确认图案与白边都完整。" : "拖动预览调整取景。应用后会生成副本，原图仍保留。"}</p>
    </div>
    {definition?.aspectRatio ? <p className="text-xs text-muted-foreground">该位置使用约 {definition.aspectRatio}:1 的图片。</p>
      : <div className="flex flex-wrap gap-1" role="group" aria-label="裁剪比例">{allowedRatios.map(option =>
        <Button type="button" size="xs" key={option.value} variant={ratioChoice === option.value ? "secondary" : "ghost"} aria-pressed={ratioChoice === option.value}
          disabled={!image || busy} onClick={() => { setRatioChoice(option.value); reset(); }}>{option.label}</Button>
      )}</div>}
    {image ? <canvas ref={preview} className="content-adjust-preview" data-pan={Boolean(canPan)} width={previewWidth} height={previewHeight} tabIndex={canPan ? 0 : -1}
      style={{ width: `min(100%, ${Math.max(1, Math.round(248 * previewWidth / previewHeight))}px)` }} role="img" aria-label={contain ? "保留整图预览" : canPan ? "裁剪预览，可拖动或用方向键移动" : "裁剪预览"}
      onPointerDown={event => {
        if (!canPan || busy || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId || !crop || contain || busy) return;
        const box = event.currentTarget.getBoundingClientRect();
        setPan({
          x: clamp(start.panX - (event.clientX - start.x) / box.width * crop.width * 2 / Math.max(1, image.naturalWidth - crop.width), -1, 1),
          y: clamp(start.panY - (event.clientY - start.y) / box.height * crop.height * 2 / Math.max(1, image.naturalHeight - crop.height), -1, 1),
        });
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        if (!canPan || busy || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") reset();
        else setPan(current => ({ x: clamp(current.x + (event.key === "ArrowLeft" ? .06 : event.key === "ArrowRight" ? -.06 : 0), -1, 1),
          y: clamp(current.y + (event.key === "ArrowUp" ? .06 : event.key === "ArrowDown" ? -.06 : 0), -1, 1) }));
      }} /> : !error ? <p role="status" className="text-sm text-muted-foreground">正在读取图片…</p> : null}
    {qr ? <div className="flex flex-wrap gap-1" role="group" aria-label="二维码处理方式">
      <Button type="button" size="xs" variant={contain ? "secondary" : "ghost"} aria-pressed={contain} disabled={busy} onClick={() => { setContain(true); reset(); }}>保留整张</Button>
      <Button type="button" size="xs" variant={contain ? "ghost" : "secondary"} aria-pressed={!contain} disabled={busy} onClick={() => { setContain(false); reset(); }}>裁剪取景</Button>
    </div> : null}
    {!contain ? <label className="content-adjust-zoom"><span>缩放</span>
      <input type="range" min={1} max={3} step={.01} value={zoom} disabled={!image || busy} onChange={event => setZoom(Number(event.currentTarget.value))} />
      <span className="tabular-nums text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
    </label> : null}
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs"><span>输出宽度</span><Input type="number" min={minWidth} max={maxWidth} value={output ?? defaultWidth}
        disabled={!image || busy} onChange={event => setOutput(event.currentTarget.value)} className="w-28 tabular-nums" /></label>
      <span className="pb-2 text-sm tabular-nums text-muted-foreground">{valid ? `× ${height} 像素` : `宽度需为 ${minWidth}–${maxWidth} 像素`}</span>
      <Button type="button" size="sm" variant="ghost" disabled={!image || busy} onClick={reset}><RotateCcw size={14} aria-hidden="true" />重置</Button>
    </div>
    {image && valid && (contain ? width > image.naturalWidth && height > image.naturalHeight : crop && width > crop.width + 1)
      ? <p className="text-xs text-muted-foreground">输出大于原图取景，放大后可能模糊。</p> : null}
    {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>返回选图</Button>
      <Button type="button" disabled={!image || !valid} loading={busy} onClick={apply}>应用调整</Button>
    </div>
  </section>;
}
