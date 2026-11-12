import { createContext, useContext, useMemo, type ReactNode } from "react";
import { getCommentKeys, getCommentKeyId, getDraftCommentKey, getTransientCommentKey } from "@platejs/comment";
import { MessageSquareText } from "lucide-react";
import { TextApi, type TCommentText, type Value } from "platejs";
import { useEditorSelector, type RenderNodeWrapper } from "platejs/react";
import type { PlatePreset } from "@zzsh/content/plate";
import { Button } from "../ui/button";

export type PlateCommentTarget = { blockId: string; ids: string[]; trigger: HTMLElement; selectedId?: string };

export type PlatePageBlocks = {
  activeId: string | null;
  activeBlockId?: string;
  hoverId: string | null;
  openIds?: readonly string[];
  blockActions?: PlatePreset;
  onCommentClick?: (target: PlateCommentTarget) => void;
  onCommentHover?: (id: string | null) => void;
  afterBlock?: (blockId: string) => ReactNode;
};

export function commentIds(leaf: TCommentText) {
  return getCommentKeys(leaf)
    .filter((key) => key !== getDraftCommentKey() && key !== getTransientCommentKey())
    .map(getCommentKeyId);
}

const PageBlocksContext = createContext<PlatePageBlocks & { idsByBlock: Map<string, string[]>; primaryBlocks: Map<string, string> }>({
  activeId: null, hoverId: null, idsByBlock: new Map(), primaryBlocks: new Map(),
});

export const usePlatePageBlocks = () => useContext(PageBlocksContext);

export function PlatePageBlocksProvider({ children, ...surface }: PlatePageBlocks & { children: ReactNode }) {
  const blocks = useEditorSelector((editor) => editor.children, []);
  const { idsByBlock, primaryBlocks } = useMemo(() => {
    const idsByBlock = new Map<string, string[]>();
    const primaryBlocks = new Map<string, string>();
    if (surface.onCommentClick) {
      const allowed = surface.openIds && new Set(surface.openIds);
      const collect = (nodes: Value, ids: Set<string>) => {
        for (const node of nodes) {
          if (TextApi.isText(node)) {
            for (const id of commentIds(node)) if (!allowed || allowed.has(id)) ids.add(id);
          } else if (node.children) collect(node.children as Value, ids);
        }
      };
      for (const block of blocks) {
        if (typeof block.id !== "string") continue;
        const ids = new Set<string>();
        collect(block.children as Value, ids);
        if (ids.size) idsByBlock.set(block.id, [...ids]);
        for (const id of ids) if (!primaryBlocks.has(id)) primaryBlocks.set(id, block.id);
      }
    }
    return { idsByBlock, primaryBlocks };
  }, [blocks, surface.onCommentClick, surface.openIds]);

  return <PageBlocksContext.Provider value={{ ...surface, idsByBlock, primaryBlocks }}>{children}</PageBlocksContext.Provider>;
}

export const PageBlock: RenderNodeWrapper = ({ path }) => path.length === 1
  ? ({ children, element }) => <PageBlockContent blockId={String(element.id ?? "")}>{children}</PageBlockContent>
  : undefined;

function PageBlockContent({ blockId, children }: { blockId: string; children: ReactNode }) {
  const { activeBlockId, idsByBlock, primaryBlocks, onCommentClick, afterBlock } = usePlatePageBlocks();
  const ids = idsByBlock.get(blockId) ?? [];
  const primaryIds = ids.filter((id) => primaryBlocks.get(id) === blockId);
  const count = primaryIds.length;
  return (
    <div className="plate-page-block" data-plate-block-id={blockId} tabIndex={-1}>
      {children}
      {count > 0 && onCommentClick ? (
        <Button
          type="button"
          variant="ghost"
          className="plate-block-comments"
          contentEditable={false}
          aria-label={`此处 ${count} 条未解决评论`}
          aria-haspopup="dialog"
          aria-expanded={activeBlockId === blockId}
          aria-controls={activeBlockId === blockId ? "internal-doc-comments" : undefined}
          data-plate-prevent-deselect
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => onCommentClick({ blockId, ids: primaryIds, trigger: event.currentTarget })}
        >
          <MessageSquareText size={14} aria-hidden="true" />{count}
        </Button>
      ) : null}
      {afterBlock?.(blockId)}
    </div>
  );
}
