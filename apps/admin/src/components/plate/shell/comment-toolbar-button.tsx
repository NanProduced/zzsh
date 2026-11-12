// Source: https://platejs.org/r/comment-toolbar-button.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted to the document API's plain-text offsets and local composer.
import { MessageSquareTextIcon } from 'lucide-react';
import { extractPlate, type PlateNode } from '@zzsh/content/plate';
import { RangeApi, TextApi, type Point, type TRange } from 'platejs';
import { useEditorRef, type PlateEditor } from 'platejs/react';

import { ToolbarButton } from './toolbar';

export type PlateCommentAnchor = { text: string; offset: number; blockId: string; range: TRange };

const plainText = (value: PlateNode[]) =>
  extractPlate({ format: 'plate', schemaVersion: 1, preset: 'internal', value }).plainText;

// Use the same block separators as the server. A Slate string joins text
// leaves directly, which drops the newlines and table separators in a range.
function textBefore(nodes: PlateNode[], point: Point, depth = 0): PlateNode[] {
  const index = point.path[depth]!;
  const node = nodes[index]!;
  const partial = typeof node.text === 'string'
    ? { ...node, text: node.text.slice(0, point.offset) }
    : { ...node, children: textBefore(node.children ?? [], point, depth + 1) };
  return [...nodes.slice(0, index), partial];
}

export function projectedCommentText(value: PlateNode[], range: TRange) {
  const [start, end] = RangeApi.edges(range);
  const offset = plainText(textBefore(value, start)).length;
  return { offset, text: plainText(value).slice(offset, plainText(textBefore(value, end)).length) };
}

function selectAnchor(editor: PlateEditor, maxLength: number): PlateCommentAnchor | undefined {
  const selection = editor.selection;
  if (!selection || !editor.api.isExpanded()) return;
  const value = editor.children as PlateNode[];
  const selected = projectedCommentText(value, selection);
  const text = selected.text.trim().slice(0, maxLength).trimEnd();
  if (!text) return;
  const offset = selected.offset + selected.text.length - selected.text.trimStart().length;
  const end = offset + text.length;
  let anchor: Point | undefined;
  let focus: Point | undefined;
  for (const [leaf, path] of editor.api.nodes({ at: selection, match: TextApi.isText })) {
    if (!TextApi.isText(leaf) || !leaf.text) continue;
    const start = plainText(textBefore(value, { path, offset: 0 })).length;
    if (start + leaf.text.length <= offset) continue;
    if (start >= end) break;
    anchor ??= { path, offset: Math.max(0, offset - start) };
    focus = { path, offset: Math.min(leaf.text.length, end - start) };
    if (start + leaf.text.length >= end) break;
  }
  const blockId = anchor && value[anchor.path[0]!]?.id;
  if (typeof blockId === 'string' && anchor && focus) return { text, offset, blockId, range: { anchor, focus } };
}

export function CommentToolbarButton({
  onRequest,
  maxLength,
}: {
  onRequest?: (anchor: PlateCommentAnchor) => void;
  maxLength: number;
}) {
  const editor = useEditorRef();

  return (
    <ToolbarButton
      aria-label="评论"
      tooltip="评论"
      data-plate-prevent-overlay
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const anchor = selectAnchor(editor, maxLength);
        if (anchor) onRequest?.(anchor);
      }}
    >
      <MessageSquareTextIcon />
    </ToolbarButton>
  );
}
