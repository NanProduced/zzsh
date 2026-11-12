import { AlertCircle, Check, CircleDot, Loader2, TriangleAlert } from "lucide-react";
import { extractPlate, type PlateDocumentEnvelope, type PlateNode, type PlatePreset } from "@zzsh/content/plate";

/**
 * P2 内容管理 plate 合同（requirements「P2 格式合同」）：
 * guide / notice payload 与公告资讯正文只接受
 * { format: "plate", schemaVersion: 1, document, mediaIds, anchorAliases? }。
 * document 为 PlateDocumentEnvelope（含 preset）；mediaIds 由客户端从 document 派生，
 * 服务端发布时重算。不读取、不转换任何 markdown / sections / plain 旧格式（裁定 13）。
 */
export type PlatePayload = {
  format: "plate";
  schemaVersion: 1;
  document: PlateDocumentEnvelope;
  mediaIds: string[];
  anchorAliases?: Record<string, string>;
};

export const resourcePreset = (kind: "guide" | "notice"): PlatePreset => (kind === "guide" ? "help" : "notice");

export const emptyPlateDocument = (preset: PlatePreset): PlateDocumentEnvelope => ({
  format: "plate",
  schemaVersion: 1,
  preset,
  value: [{ type: "p", children: [{ text: "" }] }],
});

export function isPlateEnvelope(value: unknown): value is PlateDocumentEnvelope {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PlateDocumentEnvelope>;
  return row.format === "plate" && row.schemaVersion === 1 && Array.isArray(row.value) && typeof row.preset === "string";
}

/** 从资源 payload / 动态版本 payload 读取 plate 文档；缺失时给空文档，不回退旧格式。 */
export function readPlateDocument(payload: unknown, preset: PlatePreset): { document: PlateDocumentEnvelope; anchorAliases: Record<string, string> } {
  const row = payload && typeof payload === "object" ? (payload as { document?: unknown; anchorAliases?: unknown }) : {};
  const document = isPlateEnvelope(row.document) && row.document.preset === preset ? row.document : emptyPlateDocument(preset);
  const aliases = row.anchorAliases && typeof row.anchorAliases === "object" && !Array.isArray(row.anchorAliases) ? (row.anchorAliases as Record<string, unknown>) : {};
  const anchorAliases = Object.fromEntries(Object.entries(aliases).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { document, anchorAliases };
}

export function buildPlatePayload(document: PlateDocumentEnvelope, anchorAliases?: Record<string, string>): PlatePayload {
  const aliases = anchorAliases && Object.keys(anchorAliases).length ? { anchorAliases } : {};
  return { format: "plate", schemaVersion: 1, document, mediaIds: extractPlate(document).mediaIds, ...aliases };
}

export type ContentSavePhase = "idle" | "dirty" | "saving" | "saved" | "conflict" | "failed";

/** 保存状态：文字 + 图标，aria-live 播报（与内部文档库同一口径）。 */
export function ContentSaveStatus({ phase, savedAt, message }: { phase: ContentSavePhase; savedAt: string | null; message?: string | null }) {
  const clock = savedAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(savedAt)) : "";
  const icon = phase === "saving" ? <Loader2 size={13} aria-hidden="true" className="content-save-spin" />
    : phase === "saved" ? <Check size={13} aria-hidden="true" />
    : phase === "conflict" ? <TriangleAlert size={13} aria-hidden="true" />
    : phase === "failed" ? <AlertCircle size={13} aria-hidden="true" />
    : <CircleDot size={13} aria-hidden="true" />;
  const text = phase === "saving" ? "保存中…"
    : phase === "saved" ? `草稿已保存${clock ? ` ${clock}` : ""}`
    : phase === "conflict" ? "别人刚改过，刷新后再改"
    : phase === "failed" ? (message ?? "未保存，请复制内容后刷新")
    : phase === "dirty" ? "有未保存修改，停顿 2 秒自动保存"
    : "";
  if (!text) return null;
  return (
    <span className="content-save-status" data-phase={phase} role="status" aria-live="polite">
      {icon}<span>{text}</span>
    </span>
  );
}

/** 媒体选择器注入 PlateEditor 的预览 URL（管理端 BFF 读取）。 */
export const adminMediaUrl = (mediaId: string) => `/api/bff/admin/content/media/${encodeURIComponent(mediaId)}/content`;

export type PlateSeed = { key: number; value: PlateNode[] };