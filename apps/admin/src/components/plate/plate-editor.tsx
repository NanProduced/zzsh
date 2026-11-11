import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  Plate,
  PlateLeaf,
  ParagraphPlugin,
  usePlateEditor,
  useEditorRef,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";
import { NodeIdPlugin, KEYS, type Value } from "platejs";
import { AutoformatPlugin } from "@platejs/autoformat";
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
import { LinkFloatingToolbar } from "./shell/link-toolbar";
import { BlockDraggable } from "./shell/block-draggable";
import { BlockSelection } from "./shell/block-selection";
import { SlashInputElement } from "./shell/slash-node";
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
import { ImageElement } from "./nodes/media-image-node";
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
  mediaUrls?: Record<string, string>;
  imageUrls?: Record<string, string>;
};

const COLOR_TOKENS = new Set(PALETTE);
const TOGGLE_MARKS = ["bold", "italic", "strikethrough", "underline", "code"];

function presetMarks(preset: PlatePreset): Set<string> {
  return new Set(marksFor(preset).filter((m) => TOGGLE_MARKS.includes(m)));
}

type Attributes = { className?: string; style?: React.CSSProperties; [key: string]: unknown };

function splitAttrs(attributes: Attributes): { className?: string; rest: Attributes } {
  const { className, ...rest } = attributes;
  return { className, rest };
}

function injectUrls(value: PlateNode[], mediaUrls: Record<string, string>, imageUrls: Record<string, string>): PlateNode[] {
  const urls = { ...mediaUrls, ...imageUrls };
  const walk = (node: PlateNode): PlateNode => {
    if (typeof node.text === "string") return node;
    const children = (node.children ?? []).map(walk);
    if (node.type === "img") {
      const key = typeof node.imageId === "string" ? node.imageId : typeof node.mediaId === "string" ? node.mediaId : "";
      const url = key ? urls[key] : undefined;
      return { ...node, children, ...(url ? { url } : {}) };
    }
    return { ...node, children };
  };
  return value.map(walk);
}

function colorStyle(token: unknown, prop: "color" | "backgroundColor"): React.CSSProperties | undefined {
  return typeof token === "string" && COLOR_TOKENS.has(token) ? { [prop]: `var(--plate-${token})` } : undefined;
}

function ColorLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="span" style={colorStyle(props.leaf.color, "color")} />;
}

function BackgroundColorLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="span" style={colorStyle(props.leaf.backgroundColor, "backgroundColor")} />;
}

function CommentLeaf(props: PlateLeafProps) {
  const { attributes, children, leaf } = props;
  const { className, rest } = splitAttrs(attributes as Attributes);
  const commented = Object.keys(leaf).some((k) => k.startsWith("comment_"));
  if (!commented) return <PlateLeaf {...props} as="span" />;
  return (
    <mark {...rest} className={cn("plate-comment", className)}>
      {children}
    </mark>
  );
}

const UNSELECTABLE_TYPES: string[] = [KEYS.column, KEYS.codeLine, KEYS.td, KEYS.tr];

function buildPlugins(preset: PlatePreset, readOnly: boolean) {
  const blocks = new Set(BLOCK_TYPES[preset]);
  const marks = presetMarks(preset);
  const plugins: unknown[] = [
    ParagraphPlugin.configure({ render: { node: ParagraphElement } }),
    NodeIdPlugin,
    AutoformatPlugin,
    ListPlugin.configure({ render: { belowNodes: BlockList } }),
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
  if (blocks.has("h2")) plugins.push(H2Plugin.configure({ render: { node: H2Element } }));
  if (blocks.has("h3")) plugins.push(H3Plugin.configure({ render: { node: H3Element } }));
  if (blocks.has("h4")) plugins.push(H4Plugin.configure({ render: { node: H4Element } }));
  if (blocks.has("blockquote")) plugins.push(BlockquotePlugin.configure({ render: { node: BlockquoteElement } }));
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
      FontColorPlugin.configure({ render: { leaf: ColorLeaf } }),
      FontBackgroundColorPlugin.configure({ render: { leaf: BackgroundColorLeaf } }),
    );
  }
  if (preset === "internal") plugins.push(CommentPlugin.configure({ render: { leaf: CommentLeaf } }));
  return plugins;
}

function EditorSurface({ preset, readOnly }: { preset: PlatePreset; readOnly: boolean }) {
  const editor = useEditorRef();
  const containerRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const onPaste = useCallback((event: ClipboardEvent) => {
    if (readOnly) return;
    const data = event.clipboardData;
    if (!data) return;
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
  }, [readOnly, editor, showNotice]);

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
    <div className={cn("plate-document", "plate-editor")} data-readonly={readOnly ? "true" : undefined} ref={containerRef}>
      <EditorContainer variant="none">
        <Editor
          variant="none"
          className="plate-editor-content"
          readOnly={readOnly}
          placeholder="输入正文，空行输入 / 唤起插入菜单…"
          aria-label="内容编辑器"
        />
      </EditorContainer>
      {!readOnly && (
        <FloatingToolbar>
          <FloatingToolbarButtons preset={preset} marks={presetMarks(preset)} />
        </FloatingToolbar>
      )}
      {!readOnly && <LinkFloatingToolbar />}
      {notice && <div className="plate-editor-notice" role="status">{notice}</div>}
    </div>
  );
}

export default function PlateEditor({ preset, value, onChange, readOnly = false, mediaUrls, imageUrls }: PlateEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const initialValue = useMemo(
    () => injectUrls(value ?? [], mediaUrls ?? {}, imageUrls ?? {}) as Value,
    // 仅在挂载/preset 切换时注入预览 URL，编辑期间由编辑器持有值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset],
  );

  const plugins = useMemo(() => buildPlugins(preset, readOnly), [preset, readOnly]);
  const editor = usePlateEditor({ plugins: plugins as never, value: initialValue }, [preset, readOnly]);

  const handleChange = useCallback(({ value: next }: { value: Value }) => {
    onChangeRef.current(toPlateEnvelope(next, preset));
  }, [preset]);

  return (
    <Plate editor={editor} onChange={handleChange} readOnly={readOnly}>
      <TooltipProvider delayDuration={300}>
        <EditorSurface preset={preset} readOnly={readOnly} />
      </TooltipProvider>
    </Plate>
  );
}