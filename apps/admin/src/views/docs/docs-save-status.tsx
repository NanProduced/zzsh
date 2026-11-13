import { AlertCircle, Check, CircleDot, Loader2, TriangleAlert } from "lucide-react";
import { saveClock } from "./docs-model";
import type { DocSavePhase } from "./use-doc-autosave";

export function SaveStatus({ phase, savedAt, message }: { phase: DocSavePhase; savedAt: string | null; message: string | null }) {
  const clock = saveClock(savedAt);
  const icon = phase === "saving" ? <Loader2 size={13} aria-hidden="true" className="docs-spin motion-reduce:animate-none" />
    : phase === "saved" ? <Check size={13} aria-hidden="true" />
    : phase === "conflict" ? <TriangleAlert size={13} aria-hidden="true" />
    : phase === "failed" ? <AlertCircle size={13} aria-hidden="true" />
    : <CircleDot size={13} aria-hidden="true" />;
  const text = phase === "saving" ? (message ?? "保存中")
    : phase === "saved" ? `已保存${clock ? ` ${clock}` : ""}`
    : phase === "conflict" ? "冲突"
    : phase === "failed" ? "未保存"
    : phase === "dirty" ? "未保存"
    : "";
  if (!text) return null;
  return (
    <span className="docs-save-status" data-phase={phase} role="status" aria-live="polite">
      {icon}<span>{text}</span>
      {phase === "failed" && message ? <span className="docs-save-detail">{message}</span> : null}
    </span>
  );
}
