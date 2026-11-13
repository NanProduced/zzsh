import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";

export type DiffBlock = { status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED"; before: string | null; after: string | null };
const CHANGE_LABELS: Record<DiffBlock["status"], string> = { ADDED: "新增", REMOVED: "删除", CHANGED: "修改", UNCHANGED: "未变" };

function changedText(before: string, after: string) {
  const left = Array.from(before);
  const right = Array.from(after);
  const common = Math.min(left.length, right.length);
  let start = 0;
  let end = 0;
  while (start < common && left[start] === right[start]) start += 1;
  while (end < common - start && left[left.length - end - 1] === right[right.length - end - 1]) end += 1;
  return {
    prefix: left.slice(0, start).join(""),
    removed: left.slice(start, left.length - end).join(""),
    added: right.slice(start, right.length - end).join(""),
    suffix: left.slice(left.length - end).join(""),
  };
}

export function DiffBlocks({ blocks, emptyText, beforeLabel = "当前生效", afterLabel = "提交版本" }: {
  blocks: DiffBlock[]; emptyText: string; beforeLabel?: string; afterLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const changed = blocks.filter(block => block.status !== "UNCHANGED");
  const visible = showAll ? blocks : changed;
  if (!blocks.length) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return <div aria-label="与线上差异" className="fixed-doc-diff">
    <div className="fixed-doc-diff-header">
      <p role="status">{changed.length} 处正文变更</p>
      {changed.length < blocks.length ? <label className="flex items-center gap-2 text-sm">
        显示全文 <Switch aria-label="显示全文" checked={showAll} onCheckedChange={setShowAll} />
      </label> : null}
    </div>
    {visible.length ? <ul className="fixed-doc-diff-list">
      {visible.map((block, index) => {
        if (block.status === "UNCHANGED") return <li key={index} className="fixed-doc-diff-context">{block.before ?? block.after}</li>;
        const change = changedText(block.before ?? "", block.after ?? "");
        return <li key={index} className="fixed-doc-change" data-change={block.status}>
          <Badge variant={block.status === "ADDED" ? "success" : block.status === "REMOVED" ? "destructive" : "warning"}>{CHANGE_LABELS[block.status]}</Badge>
          <div className="fixed-doc-change-grid">
            <div><p className="fixed-doc-change-label">{beforeLabel}</p><p>{block.before === null ? "无此段落" : <>
              {change.prefix}{change.removed ? <del>{change.removed}</del> : null}{change.suffix}
            </>}</p></div>
            <div><p className="fixed-doc-change-label">{afterLabel}</p><p>{block.after === null ? "已删除" : <>
              {change.prefix}{change.added ? <ins>{change.added}</ins> : null}{change.suffix}
            </>}</p></div>
          </div>
        </li>;
      })}
    </ul> : <p className="text-sm text-muted-foreground">两个版本的正文文字一致。</p>}
  </div>;
}
