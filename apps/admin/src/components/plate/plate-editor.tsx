import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  Plate,
  PlateLeaf,
  ParagraphPlugin,
  usePlateEditor,
  useEditorRef,
  createPlatePlugin,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";
import { NodeIdPlugin, KEYS, RangeApi, TextApi, type RangeRef, type TRange, type TCommentText, type Value } from "platejs";
import { getCommentCount, getDraftCommentKey, getTransientCommentKey } from "@platejs/comment";
import { BlockquoteRules, HeadingRules } from "@platejs/basic-nodes";
import { BulletedListRules, OrderedListRules } from "@platejs/list";
import {
  H2Plugin,
  H3Plugin,
  H4Plugin,
  BlockquotePlugin,
  HorizontalRulePlugin,
  BoldPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
  CodePlugin,
} from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { TablePlugin, TableRowPlugin, TableCellPlugin, TableCellHeaderPlugin } from "@platejs/table/react";
import { LinkPlugin } from "@platejs/link/react";
import { ImagePlugin } from "@platejs/media/react";
import { CalloutPlugin } from "@platejs/callout/react";
import { TogglePlugin } from "@platejs/toggle/react";
import { TocPlugin } from "@platejs/toc/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { CommentPlugin } from "@platejs/comment/react";
import { FontColorPlugin, FontBackgroundColorPlugin } from "@platejs/basic-styles/react";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { DndPlugin } from "@platejs/dnd";
import { IndentPlugin } from "@platejs/indent/react";
import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";
import { cleanDocx } from "@platejs/docx";
import {
  BLOCK_TYPES,
  PALETTE,
  marksFor,
  toPlateEnvelope,
  type PlateDocumentEnvelope,
  type PlateNode,
  type PlatePreset,
} from "@zzsh/content/plate";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "./ui/tooltip";
import { Editor, EditorContainer } from "./shell/editor";
import { FloatingToolbar } from "./shell/floating-toolbar";
import { FloatingToolbarButtons } from "./shell/floating-toolbar-buttons";
import { projectedCommentText, type PlateCommentAnchor } from "./shell/comment-toolbar-button";
import { LinkFloatingToolbar } from "./shell/link-toolbar";
import { BlockDraggable } from "./shell/block-draggable";
import { BlockSelection } from "./shell/block-selection";
import { PlateImagePicker, SlashInputElement } from "./shell/slash-node";
import { commentIds, PageBlock, PlatePageBlocksProvider, usePlatePageBlocks, type PlatePageBlocks } from "./shell/page-block";
import { ParagraphElement } from "./nodes/paragraph-node";
import { H2Element, H3Element, H4Element } from "./nodes/heading-node";
import { BlockquoteElement } from "./nodes/blockquote-node";
import { HrElement } from "./nodes/hr-node";
import { CodeLeaf } from "./nodes/code-node";
import { CodeBlockElement, CodeLineElement } from "./nodes/code-block-node";
import { CalloutElement } from "./nodes/callout-node";
import { ToggleElement } from "./nodes/toggle-node";
import { TableElement, TableRowElement, TableCellElement, TableCellHeaderElement } from "./nodes/table-node";
import { LinkElement } from "./nodes/link-node";
import { ImageElement, PlateImageUrls } from "./nodes/media-image-node";
import { FloatingStatusMessage } from "../ui-elements";
import { TocElement } from "./nodes/toc-node";
import { BlockList } from "./nodes/block-list";
import "@zzsh/ui/plate-document.css";
import "./ui/plate-ui-tokens.css";
import "./plate-editor.css";

export type PlateEditorProps = {
  preset: PlatePreset;
  value: PlateNode[];
  onChange: (envelope: PlateDocumentEnvelope) => void;
  readOnly?: boolean;
  canvas?: boolean;
  mediaUrls?: Record<string, string>;
  imageUrls?: Record<string, string>;
  onCommentRequest?: (anchor: PlateCommentAnchor) => void;
  commentAnchorMax?: number;
  pageBlocks?: PlatePageBlocks;
  onPickImages?: (blockId: string) => void;
  onPasteImages?: (files: File[], blockId: string) => void;
};

type EditorImage = ({ imageId: string } | { mediaId: string }) & { alt: string };

export type PlateEditorHandle = {
  focusStart: () => void;
  currentDraftAnchor: () => { text: string; offset: number } | null;
  clearDraftComment: () => void;
  applyDiscussionMark: (id: string, text?: string) => PlateDocumentEnvelope;
  selectedBlockId: () => string | undefined;
  focusBlock: (blockId: string) => boolean;
  hasBlock: (id: string) => boolean;
  insertImagesAfter: (blockId: string | undefined, images: readonly EditorImage[]) => string | undefined;
};

const PageBlocksPlugin = createPlatePlugin({ key: "pageBlocks", render: { aboveNodes: PageBlock } });
const editorBlockId = (blocks: Value, index: number | undefined) =>
  index !== undefined && typeof blocks[index]?.id === "string" ? blocks[index].id : undefined;

const COLOR_TOKENS = new Set(PALETTE);
const TOGGLE_MARKS = ["bold", "italic", "strikethrough", "underline", "code"];

function presetMarks(preset: PlatePreset): Set<string> {
  return new Set(marksFor(preset).filter((m) => TOGGLE_MARKS.includes(m)));
}

type Attributes = { className?: string; style?: React.CSSProperties; [key: string]: unknown };

function toEditorValue(value: PlateNode[]): PlateNode[] {
  const walk = (node: PlateNode): PlateNode => {
    // Stored comments carry their ids; Plate needs its runtime leaf flag to render them.
    if (typeof node.text === "string") return getCommentCount(node as TCommentText) ? { ...node, [KEYS.comment]: true } : node;
    return node.children ? { ...node, children: node.children.map(walk) } : node;
  };
  return value.map(walk);
}

const paletteNodeProps = {
  validNodeValues: [...COLOR_TOKENS],
  transformNodeValue: ({ nodeValue }: { nodeValue?: unknown }) =>
    typeof nodeValue === "string" ? `var(--plate-${nodeValue})` : undefined,
};

// Source: https://platejs.org/r/comment-node.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted to the server's thread ids and the local block discussion trigger.
function CommentLeaf(props: PlateLeafProps<TCommentText>) {
  const { children, leaf, attributes } = props;
  const surface = usePlatePageBlocks();
  const ids = commentIds(leaf).filter((id) => !surface.openIds || surface.openIds.includes(id));
  const isDraft = getDraftCommentKey() in leaf;
  const isActive = surface.activeId !== null && ids.includes(surface.activeId);
  const isHover = surface.hoverId !== null && ids.includes(surface.hoverId);
  const currentId = isActive ? surface.activeId : ids[0];
  if (ids.length === 0 && !isDraft) return <PlateLeaf {...props} as="span" />;
  return (
    <PlateLeaf
      {...props}
      as="mark"
      className={cn(
        "plate-comment",
        (isActive || isHover) && "plate-comment--active",
        ids.length > 1 && "plate-comment--overlap",
      )}
      attributes={{
        ...(attributes as Attributes),
        "data-comment-id": currentId ?? undefined,
        "data-comment-ids": ids.length ? ids.join(" ") : undefined,
        tabIndex: currentId && surface.onCommentClick ? -1 : undefined,
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          if (!currentId || !surface.onCommentClick || window.getSelection()?.isCollapsed === false) return;
          const trigger = event.currentTarget;
          const blockId = trigger.closest<HTMLElement>("[data-plate-block-id]")?.dataset.plateBlockId;
          if (!blockId) return;
          event.preventDefault();
          surface.onCommentClick({ blockId, ids: surface.idsByBlock.get(blockId) ?? ids, trigger, selectedId: currentId });
        },
        onMouseEnter: () => { if (currentId) surface.onCommentHover?.(currentId); },
        onMouseLeave: () => surface.onCommentHover?.(null),
      }}
    >
      {children}
    </PlateLeaf>
  );
}

/** 去掉草稿/瞬态评论标记与裸 comment 旗标：它们只是本地 UI 态，不入存储白名单语义。 */
function stripCommentArtifacts(value: Value): Value {
  const draftKey = getDraftCommentKey();
  const transientKey = getTransientCommentKey();
  const walk = (node: Value[number]): Value[number] => {
    if (typeof (node as { text?: unknown }).text === "string") {
      const leaf = node as Record<string, unknown>;
      if (!(draftKey in leaf) && !(transientKey in leaf) && !(KEYS.comment in leaf)) return node;
      const out = { ...leaf };
      delete out[draftKey];
      delete out[transientKey];
      delete out[KEYS.comment];
      return out as Value[number];
    }
    const children = (node as { children?: Value }).children;
    if (!children) return node;
    return { ...(node as object), children: children.map(walk) } as Value[number];
  };
  return value.map(walk);
}

const UNSELECTABLE_TYPES: string[] = [KEYS.column, KEYS.codeLine, KEYS.td, KEYS.tr];

function buildPlugins(preset: PlatePreset, pageBlocks: boolean, draftRange: () => TRange | null) {
  const blocks = new Set(BLOCK_TYPES[preset]);
  const marks = presetMarks(preset);
  const internal = preset === "internal";
  const plugins: unknown[] = [
    ParagraphPlugin.configure({ render: { node: ParagraphElement } }),
    NodeIdPlugin,
    ListPlugin.configure({
      render: { belowNodes: BlockList },
      inputRules: internal ? [BulletedListRules.markdown(), OrderedListRules.markdown()] : [],
    }),
    LinkPlugin.configure({ render: { node: LinkElement } }),
    BoldPlugin,
    ItalicPlugin,
    StrikethroughPlugin,
    DndPlugin.configure({
      options: { enableScroller: true },
      render: {
        aboveNodes: BlockDraggable,
        aboveSlate: ({ children }) => <DndProvider backend={HTML5Backend}>{children}</DndProvider>,
      },
    }),
    BlockSelectionPlugin.configure({
      options: {
        enableContextMenu: true,
        isSelectable: (element) => !UNSELECTABLE_TYPES.includes(element.type as string),
      },
      render: {
        belowRootNodes: (props) => {
          const className = [props.className, props.attributes?.className].filter(Boolean).join(" ");
          if (!className.includes("slate-selectable")) return null;
          return <BlockSelection {...(props as unknown as PlateElementProps)} />;
        },
      },
    }),
    // BlockList owns list margins and the kept nodes/read surface do not render
    // indent on plain blocks, so inject no visual offset (offset: 0); the
    // transforms still store the whitelisted indent 1..3 (indentMax clamps).
    IndentPlugin.configure({ options: { offset: 0, unit: "px", indentMax: 3 } }),
    SlashPlugin.configure({
      options: {
        triggerQuery: (editor) =>
          !editor.api.some({ match: { type: editor.getType(KEYS.codeBlock) } }),
      },
    }),
    SlashInputPlugin.configure({ options: { preset } }).withComponent(SlashInputElement),
  ];
  if (pageBlocks) plugins.push(PageBlocksPlugin);
  const headingRules = internal ? [HeadingRules.markdown()] : [];
  if (blocks.has("h2")) plugins.push(H2Plugin.configure({ render: { node: H2Element }, inputRules: headingRules }));
  if (blocks.has("h3")) plugins.push(H3Plugin.configure({ render: { node: H3Element }, inputRules: headingRules }));
  if (blocks.has("h4")) plugins.push(H4Plugin.configure({ render: { node: H4Element }, inputRules: headingRules }));
  if (blocks.has("blockquote")) plugins.push(BlockquotePlugin.configure({
    render: { node: BlockquoteElement },
    inputRules: internal ? [BlockquoteRules.markdown()] : [],
  }));
  if (blocks.has("hr")) plugins.push(HorizontalRulePlugin.configure({ render: { node: HrElement } }));
  if (blocks.has("code_block")) {
    plugins.push(
      CodeBlockPlugin.configure({ options: { lowlight: null }, render: { node: CodeBlockElement } }),
      CodeLinePlugin.configure({ render: { node: CodeLineElement } }),
    );
  }
  if (blocks.has("table")) {
    plugins.push(
      TablePlugin.configure({ render: { node: TableElement } }),
      TableRowPlugin.configure({ render: { node: TableRowElement } }),
      TableCellPlugin.configure({ render: { node: TableCellElement } }),
      TableCellHeaderPlugin.configure({ render: { node: TableCellHeaderElement } }),
    );
  }
  if (blocks.has("callout")) plugins.push(CalloutPlugin.configure({ render: { node: CalloutElement } }));
  if (blocks.has("toggle")) plugins.push(TogglePlugin.configure({ render: { node: ToggleElement } }));
  if (blocks.has("img")) plugins.push(ImagePlugin.configure({ render: { node: ImageElement } }));
  if (blocks.has("toc")) plugins.push(TocPlugin.configure({ render: { node: TocElement } }));
  if (marks.has("underline")) plugins.push(UnderlinePlugin);
  if (marks.has("code")) plugins.push(CodePlugin.configure({ render: { leaf: CodeLeaf } }));
  if (preset === "legal" || preset === "internal") {
    plugins.push(
      FontColorPlugin.configure({ inject: { nodeProps: paletteNodeProps } }),
      FontBackgroundColorPlugin.configure({ inject: { nodeProps: paletteNodeProps } }),
    );
  }
  if (internal) plugins.push(CommentPlugin.configure({
    render: { leaf: CommentLeaf },
    decorate: ({ entry: [node, path] }) => {
      const range = draftRange();
      if (!range || !TextApi.isText(node)) return;
      const intersection = RangeApi.intersection(range, { anchor: { path, offset: 0 }, focus: { path, offset: node.text.length } });
      return intersection && RangeApi.isExpanded(intersection)
        ? [{ ...intersection, [KEYS.comment]: true, [getDraftCommentKey()]: true }]
        : undefined;
    },
  }));
  return plugins;
}

function EditorSurface({ preset, readOnly, canvas, onCommentRequest, commentAnchorMax, onPasteImages, pageBlocks }: Pick<PlateEditorProps,
  "preset" | "canvas" | "onCommentRequest" | "commentAnchorMax" | "onPasteImages" | "pageBlocks"> & { readOnly: boolean }) {
  const editor = useEditorRef();
  const containerRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<{ message: string; count: number } | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice(current => ({ message, count: (current?.count ?? 0) + 1 }));
  }, []);

  const onPaste = useCallback((event: ClipboardEvent) => {
    if (readOnly) return;
    const data = event.clipboardData;
    if (!data) return;
    const files = [...(data.files ?? [])].filter((file) => file.type.startsWith("image/"));
    const blockId = editorBlockId(editor.children, editor.selection?.focus.path[0]);
    if (onPasteImages && files.length && blockId) {
      event.preventDefault();
      event.stopPropagation();
      onPasteImages(files, blockId);
      return;
    }
    const html = data.getData("text/html");
    if (!html) return;
    event.preventDefault();
    const rtf = data.getData("text/rtf");
    const source = /mso-|urn:schemas-microsoft-com/i.test(html) ? cleanDocx(html, rtf) : html;
    let fragment: Value;
    try {
      fragment = editor.api.html.deserialize({ element: source }) as Value;
    } catch {
      const plain = data.getData("text/plain");
      if (plain) editor.tf.insertText(plain);
      return;
    }
    let droppedImage = false;
    const stripExternalImages = (nodes: Value): Value =>
      nodes.flatMap((node) => {
        if (node.type === "img") {
          const url = typeof node.url === "string" ? node.url : "";
          if (/^https?:\/\//i.test(url) || (!node.mediaId && !node.imageId)) {
            droppedImage = true;
            return [];
          }
          return [node];
        }
        if (node.children) return [{ ...node, children: stripExternalImages(node.children as Value) }];
        return [node];
      });
    const cleaned = stripExternalImages(fragment);
    if (!editor.selection) editor.tf.select(editor.api.end([]));
    editor.tf.insertFragment(cleaned);
    if (droppedImage) showNotice("已忽略粘贴内容中的外链图片，请改用素材库图片。");
  }, [readOnly, editor, onPasteImages, showNotice]);

  // PlateContent does not forward onPaste; capture on the container so our
  // handler runs before Slate's own editable listeners.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("paste", onPaste, true);
    return () => {
      el.removeEventListener("paste", onPaste, true);
    };
  }, [onPaste]);

  return (
    <div className={cn("plate-document", "plate-editor", canvas && "plate-editor--page", pageBlocks && "plate-editor--block-gutters")} data-readonly={readOnly ? "true" : undefined} ref={containerRef}>
      <EditorContainer variant="none" className={pageBlocks ? "plate-editor-container" : undefined}>
        <Editor
          variant="none"
          className="plate-editor-content"
          readOnly={readOnly}
          placeholder={readOnly ? undefined : "输入正文，或键入 / 插入内容"}
          aria-label={readOnly ? "文档正文" : "内容编辑器"}
          tabIndex={readOnly && onCommentRequest ? 0 : undefined}
        />
      </EditorContainer>
      {(!readOnly || onCommentRequest) && (
        <FloatingToolbar state={readOnly ? { showWhenReadOnly: true } : undefined}>
          <FloatingToolbarButtons preset={preset} marks={presetMarks(preset)} onRequestComment={onCommentRequest} commentAnchorMax={commentAnchorMax} />
        </FloatingToolbar>
      )}
      {!readOnly && <LinkFloatingToolbar />}
      {notice ? <FloatingStatusMessage key={notice.count} tone="warning" success={notice.message} /> : null}
    </div>
  );
}

const PlateEditor = forwardRef<PlateEditorHandle, PlateEditorProps>(function PlateEditor(
  { preset, value, onChange, readOnly = false, canvas = false, mediaUrls, imageUrls, onCommentRequest, commentAnchorMax, pageBlocks, onPickImages, onPasteImages },
  ref,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const viewUrls = useMemo(() => ({ ...mediaUrls, ...imageUrls }), [mediaUrls, imageUrls]);
  const annotationValue = useRef<Value | null>(null);
  const draft = useRef<RangeRef | null>(null);

  const initialValue = useMemo(
    () => toEditorValue(value ?? []) as Value,
    // 编辑期间由编辑器持有正文，预览 URL 由渲染上下文即时更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset],
  );

  const hasPageBlocks = Boolean(pageBlocks);
  const plugins = useMemo(() => buildPlugins(preset, hasPageBlocks, () => draft.current?.current ?? null), [preset, hasPageBlocks]);
  const editor = usePlateEditor({ plugins: plugins as never, value: initialValue }, [preset, readOnly]);
  const clearDraftComment = useCallback(() => {
    draft.current?.unref();
    draft.current = null;
    editor.api.redecorate();
  }, [editor]);
  useEffect(() => () => { draft.current?.unref(); draft.current = null; }, [editor]);

  useImperativeHandle(ref, () => ({
    focusStart: () => editor.tf.focus({ at: editor.api.start([]) }),
    currentDraftAnchor: () => draft.current?.current ? projectedCommentText(editor.children as PlateNode[], draft.current.current) : null,
    clearDraftComment,
    applyDiscussionMark: (id, text) => {
      const key = `comment_${id}`;
      const range = draft.current?.current;
      if (text === undefined) {
        editor.tf.withNewBatch(() => editor.tf.withoutNormalizing(() => {
          editor.tf.unsetNodes(key, { at: [], mode: "lowest", match: (node) => TextApi.isText(node) && key in node });
          editor.tf.unsetNodes(KEYS.comment, {
            at: [], mode: "lowest",
            match: (node) => TextApi.isText(node) && KEYS.comment in node && commentIds(node).length === 0,
          });
        }));
      } else if (range && projectedCommentText(editor.children as PlateNode[], range).text === text) {
        editor.tf.withNewBatch(() => editor.tf.setNodes({ [key]: true, [KEYS.comment]: true }, {
          at: range, match: TextApi.isText, split: true,
        }));
      }
      annotationValue.current = editor.children;
      return toPlateEnvelope(stripCommentArtifacts(editor.children), preset);
    },
    selectedBlockId: () => editorBlockId(editor.children, editor.selection?.focus.path[0]),
    focusBlock: (blockId) => {
      const index = editor.children.findIndex((node) => node.id === blockId);
      if (index < 0) return false;
      const block = editor.children[index]!;
      const target = editor.api.toDOMNode(block);
      if (!target) return false;
      editor.tf.focus({ at: editor.api.start([index]) });
      target.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    },
    hasBlock: (id) => editor.children.some((node) => node.id === id),
    insertImagesAfter: (blockId, images) => {
      if (readOnly || !images.length) return;
      const index = blockId === undefined ? editor.children.length - 1 : editor.children.findIndex((node) => node.id === blockId);
      if (blockId !== undefined && index < 0) return;
      editor.tf.withNewBatch(() => editor.tf.insertNodes(
        images.map(({ alt, ...reference }) => ({ type: KEYS.img, ...reference, alt: alt.slice(0, 500), children: [{ text: "" }] })),
        { at: [index + 1] },
      ));
      return editorBlockId(editor.children, index + images.length);
    },
  }), [clearDraftComment, editor, preset, readOnly]);

  const handleChange = useCallback(({ value: next }: { value: Value }) => {
    const isAnnotation = annotationValue.current === next;
    annotationValue.current = null;
    if (isAnnotation) return;
    if (!readOnly) onChangeRef.current(toPlateEnvelope(stripCommentArtifacts(next), preset));
  }, [preset, readOnly]);

  const requestComment = useCallback((anchor: PlateCommentAnchor) => {
    draft.current?.unref();
    draft.current = editor.api.rangeRef(anchor.range, { affinity: "inward" });
    editor.api.redecorate();
    onCommentRequest?.(anchor);
  }, [editor, onCommentRequest]);

  const surface = (
    <PlateImageUrls.Provider value={viewUrls}>
      <PlateImagePicker.Provider value={readOnly ? undefined : onPickImages}>
        <EditorSurface preset={preset} readOnly={readOnly} canvas={canvas} pageBlocks={pageBlocks} commentAnchorMax={commentAnchorMax}
          onCommentRequest={onCommentRequest ? requestComment : undefined} onPasteImages={onPasteImages} />
      </PlateImagePicker.Provider>
    </PlateImageUrls.Provider>
  );

  return (
    <Plate editor={editor} onValueChange={handleChange} readOnly={readOnly}>
      <TooltipProvider delayDuration={300}>
        {pageBlocks ? <PlatePageBlocksProvider {...pageBlocks}>{surface}</PlatePageBlocksProvider> : surface}
      </TooltipProvider>
    </Plate>
  );
});

export default PlateEditor;
