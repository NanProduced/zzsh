import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";
import { PRESETS, validatePlateDocument } from "@zzsh/content/plate";

const GLOBAL_KEYS = [
  "Window", "Document", "ShadowRoot", "DocumentFragment", "DocumentType", "CharacterData", "ProcessingInstruction",
  "Attr", "DOMImplementation", "XMLSerializer", "DOMParser", "Element", "SVGElement", "HTMLElement", "Node",
  "Text", "Comment", "Range", "Selection", "StaticRange", "AbstractRange", "Event", "EventTarget", "CustomEvent",
  "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "ClipboardEvent", "DragEvent",
  "CompositionEvent", "WheelEvent", "PointerEvent", "TouchEvent", "MutationObserver", "MutationRecord",
  "ResizeObserver", "ResizeObserverEntry", "IntersectionObserver", "Image", "DOMRect", "DOMRectReadOnly",
  "DOMRectList", "DOMPoint", "DOMMatrix", "DataTransfer", "DataTransferItem", "DataTransferItemList",
  "NodeList", "HTMLCollection", "NamedNodeMap", "DOMTokenList", "DOMStringMap", "CSSStyleSheet", "CSSRule",
  "CSSStyleDeclaration", "MediaList", "CSS", "StyleSheet", "FileList", "FileReader",
  "matchMedia", "MediaQueryList", "screen", "history", "location", "getComputedStyle",
];

function exposeBrowserGlobals(browser) {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of GLOBAL_KEYS) {
    if (browser[key] !== undefined) globalThis[key] = browser[key];
  }
  for (const key of Object.getOwnPropertyNames(browser)) {
    if (key.startsWith("HTML") && browser[key] !== undefined) globalThis[key] = browser[key];
  }
  globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
  globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
  // slate-react scrolls the selection via scroll-into-view-if-needed, whose
  // compute-scroll-into-view ponyfill reads bare innerWidth/innerHeight.
  globalThis.innerWidth = browser.innerWidth;
  globalThis.innerHeight = browser.innerHeight;
  // happy-dom's Node lacks the document-position constants slate-dom's isBefore
  // reads when the DOM selection moves into the floating link inputs.
  if (globalThis.Node && globalThis.Node.prototype.DOCUMENT_POSITION_PRECEDING === undefined) {
    Object.assign(globalThis.Node.prototype, {
      DOCUMENT_POSITION_DISCONNECTED: 1,
      DOCUMENT_POSITION_PRECEDING: 2,
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_CONTAINS: 8,
      DOCUMENT_POSITION_CONTAINED_BY: 16,
      DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
    });
  }
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
}

const bootstrap = new Window({ url: "http://127.0.0.1:3101/" });
exposeBrowserGlobals(bootstrap);
const [{ createRoot }, { indent, outdent }, { submitFloatingLink, triggerFloatingLink }] = await Promise.all([
  import("react-dom/client"),
  import("@platejs/indent"),
  import("@platejs/link/react"),
]);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { default: PlateEditor } = await source.ssrLoadModule("/apps/admin/src/components/plate/plate-editor.tsx");
after(async () => { await source.close(); await bootstrap.happyDOM.abort(); });

async function mount(t, props) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  browser.Element.prototype.scrollIntoView = function () {};
  exposeBrowserGlobals(browser);

  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const envelopes = [];
  const onChange = (envelope) => envelopes.push(envelope);

  await act(async () => {
    reactRoot.render(createElement(PlateEditor, { ...props, onChange }));
  });
  const settle = async (ms = 30) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  };
  await settle();

  const contentEditable = () => el.querySelector("[contenteditable]");
  const paste = async (html, plain = "") => {
    const target = contentEditable();
    assert.ok(target, "contenteditable present for paste");
    const dt = new browser.DataTransfer();
    dt.setData("text/html", html);
    if (plain) dt.setData("text/plain", plain);
    await act(async () => {
      target.dispatchEvent(new browser.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    });
    await settle();
  };

  t.after(async () => {
    await act(async () => reactRoot.unmount());
    await settle(10);
    await browser.happyDOM.abort();
  });

  return { browser, el, envelopes, contentEditable, paste, settle };
}

const seed = (preset) => [{ type: "p", children: [{ text: `${preset} 初始段落` }] }];

// The Plate provider holds the editor instance; walk the React fiber tree from
// the editable DOM node to reach it without exporting test hooks from product code.
function editorOf(el) {
  const node = el.querySelector("[data-slate-editor]");
  assert.ok(node, "editable DOM node present");
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  let fiber = node[key];
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props?.editor?.tf) return props.editor;
    fiber = fiber.return;
  }
  throw new Error("Plate editor instance not found via fiber");
}

// Type "/" into an empty top-level paragraph and let the slash combobox settle.
async function openSlash(h, path = [0, 0]) {
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.select({ anchor: { path, offset: 0 }, focus: { path, offset: 0 } });
    editor.tf.insertText("/");
  });
  await h.settle();
  return editor;
}

// 选项行含标签 + 描述 + 快捷键（Notion 式斜杠菜单）：只取标签 span 做精确匹配。
const slashOptionLabel = (o) => o.querySelector(".plate-slash-label")?.textContent ?? o.textContent;
const slashOptionTexts = (browser) =>
  [...browser.document.querySelectorAll('[role="option"]')].map(slashOptionLabel);

for (const preset of PRESETS) {
  test(`preset ${preset} 挂载不抛错，容器带 plate-document，粘贴后 onChange 输出合法 envelope`, async (t) => {
    const h = await mount(t, { preset, value: seed(preset) });
    const container = h.el.querySelector(".plate-document");
    assert.ok(container, "编辑器容器带 plate-document class");
    assert.ok(h.el.querySelector(".plate-editor"), "编辑器外壳渲染");
    const editable = h.contentEditable();
    assert.ok(editable, "渲染可编辑区");
    assert.equal(editable.getAttribute("contenteditable"), "true");
    assert.ok(h.el.textContent.includes(`${preset} 初始段落`), "初始内容渲染");

    await h.paste('<div style="color:red" class="x">粘贴正文</div>', "粘贴正文");
    assert.ok(h.envelopes.length > 0, "粘贴触发 onChange");
    const envelope = h.envelopes.at(-1);
    assert.equal(envelope.format, "plate");
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.preset, preset);
    const result = validatePlateDocument(envelope, { preset });
    assert.equal(result.ok, true, `envelope 合法: ${JSON.stringify(result.errors)}`);
    assert.ok(JSON.stringify(envelope.value).includes("粘贴正文"), "粘贴文本进入 envelope");
  });
}

test("粘贴 div(style/class) 与 mso/Word html 后 envelope 不含 style/class/mso 残留", async (t) => {
  const h = await mount(t, { preset: "help", value: seed("help") });
  await h.paste('<div style="x" class="y">普通 div</div>', "普通 div");
  const mso = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style><!-- p.MsoNormal {mso-style-name:"Normal"; mso-margin-top-alt:auto;} --></style></head><body><p class="MsoNormal" style="mso-margin-top-alt:auto">Word 文本</p></body></html>';
  await h.paste(mso, "Word 文本");
  assert.ok(h.envelopes.length > 0);
  const envelope = h.envelopes.at(-1);
  const json = JSON.stringify(envelope);
  assert.equal(validatePlateDocument(envelope, { preset: "help" }).ok, true);
  assert.ok(!json.includes('"style"'), "envelope 不含 style 键");
  assert.ok(!json.includes('"class"'), "envelope 不含 class 键");
  assert.ok(!json.includes("mso-"), "envelope 不含 mso- 残留");
  assert.ok(!json.includes("MsoNormal"), "envelope 不含 MsoNormal 残留");
  assert.ok(!json.includes("urn:schemas-microsoft-com"), "envelope 不含 office 命名空间");
  assert.ok(json.includes("普通 div") && json.includes("Word 文本"), "两段粘贴文本均保留");
});

test("粘贴外链图片被丢弃并给出一行提示，envelope 不保留外链 img", async (t) => {
  const h = await mount(t, { preset: "help", value: seed("help") });
  await h.paste('<p>前</p><img src="https://evil.example/x.png" alt="外链"><p>后</p>', "前后");
  const envelope = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(envelope, { preset: "help" }).ok, true);
  const imgs = envelope.value.filter((n) => n.type === "img");
  assert.equal(imgs.length, 0, "外链图片不进入 envelope");
  assert.ok(h.el.textContent.includes("已忽略粘贴内容中的外链图片"), "显示外链图片提示");
});

test("readOnly 不渲染浮动工具栏与拖拽把手，内容只读", async (t) => {
  const h = await mount(t, { preset: "internal", value: seed("internal"), readOnly: true });
  const editable = h.contentEditable();
  assert.ok(editable, "只读仍渲染内容区");
  assert.equal(editable.getAttribute("contenteditable"), "false");
  assert.equal(h.el.querySelector(".plate-selection-toolbar"), null, "只读不渲染选区工具栏");
  assert.equal(h.el.querySelector(".slate-blockToolbarWrapper"), null, "只读不渲染拖拽把手");
  assert.equal(h.el.querySelector('[role="toolbar"]'), null, "只读无 toolbar");
  assert.ok(h.el.textContent.includes("internal 初始段落"), "只读内容可见");
});

test("可编辑态为顶层块渲染拖拽把手与块容器，把手带无障碍标签且可拖拽", async (t) => {
  const h = await mount(t, {
    preset: "help",
    value: [
      { type: "h2", id: "h1", children: [{ text: "标题" }] },
      { type: "p", children: [{ text: "正文" }] },
    ],
  });
  const rows = h.el.querySelectorAll(".slate-blockWrapper");
  assert.equal(rows.length, 2, "每个顶层块包一层块容器");
  const handles = h.el.querySelectorAll(".slate-blockToolbarWrapper button");
  assert.equal(handles.length, 2, "每个顶层块渲染拖拽把手");
  assert.equal(handles[0].getAttribute("draggable"), "true", "把手可拖拽");
  const grip = handles[0].querySelector('[role="button"]');
  assert.ok(grip, "把手内含 role=button 的拖动区");
  assert.equal(grip.getAttribute("aria-label"), "拖动以移动此块");
  assert.ok(h.el.textContent.includes("标题") && h.el.textContent.includes("正文"), "块内容可见");
});

test("空行输入 / 唤起 combobox 斜杠菜单，选项按 preset 白名单过滤，选中后输出合法 envelope", async (t) => {
  const h = await mount(t, { preset: "help", value: [{ type: "p", children: [{ text: "" }] }] });
  const editor = await openSlash(h);
  assert.ok(h.browser.document.querySelector('[role="combobox"]'), "斜杠输入渲染 combobox");
  assert.ok(h.browser.document.querySelector('[role="listbox"]'), "斜杠菜单渲染 listbox");
  const options = slashOptionTexts(h.browser);
  for (const label of ["文本", "标题 2", "标题 3", "标题 4", "无序列表", "有序列表", "折叠", "代码块", "表格", "引用", "提示", "分割线"]) {
    assert.ok(options.includes(label), `help 菜单包含 ${label}`);
  }
  assert.ok(!options.includes("待办列表"), "help 无待办列表");
  assert.ok(!options.includes("目录"), "help 无目录");

  const target = [...h.browser.document.querySelectorAll('[role="option"]')].find((o) => slashOptionLabel(o) === "标题 2");
  await act(async () => {
    target.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await h.settle();
  const envelope = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(envelope, { preset: "help" }).ok, true, "斜杠插入后 envelope 合法");
  assert.equal(envelope.value[0].type, "h2", "空段落被转换为标题 2");
  assert.equal(editor.api.isEmpty(editor.api.block()[0]), true, "转换后标题为空块");
});

test("notice/legal/internal/update 斜杠菜单各自按白名单裁剪", async (t) => {
  const cases = [
    { preset: "notice", has: ["文本", "引用", "提示", "无序列表"], lacks: ["标题 2", "表格", "代码块", "分割线", "折叠", "待办列表"] },
    { preset: "legal", has: ["文本", "标题 2", "标题 3", "表格", "引用", "无序列表"], lacks: ["有序列表", "代码块", "提示", "折叠", "待办列表", "目录"] },
    { preset: "internal", has: ["文本", "标题 4", "待办列表", "目录", "代码块", "折叠", "表格", "有序列表"], lacks: [] },
    { preset: "update", has: ["文本", "标题 2", "标题 3", "引用", "分割线", "无序列表"], lacks: ["标题 4", "表格", "代码块", "折叠", "提示", "待办列表"] },
  ];
  for (const { preset, has, lacks } of cases) {
    const h = await mount(t, { preset, value: [{ type: "p", children: [{ text: "" }] }] });
    await openSlash(h);
    const options = slashOptionTexts(h.browser);
    for (const label of has) assert.ok(options.includes(label), `${preset} 菜单包含 ${label}`);
    for (const label of lacks) assert.ok(!options.includes(label), `${preset} 菜单不含 ${label}`);
  }
});

test("内部编辑器用 Plate 输入规则转换标题、无序及有序列表", async (t) => {
  const h = await mount(t, { preset: "internal", value: Array.from({ length: 3 }, () => ({ type: "p", children: [{ text: "" }] })) });
  const editor = editorOf(h.el);
  await act(async () => {
    for (const [index, prefix] of ["##", "-", "1."].entries()) {
      editor.tf.select(editor.api.start([index]));
      editor.tf.insertText(prefix);
      editor.tf.insertText(" ");
      editor.tf.insertText("正文");
    }
  });
  const value = h.envelopes.at(-1).value;
  assert.deepEqual(value.map((node) => [node.type, node.listStyleType, node.children[0].text]), [
    ["h2", undefined, "正文"], ["p", "disc", "正文"], ["p", "decimal", "正文"],
  ]);
});

test("跨块评论只在首块计数，后块高亮可打开同一线程，重叠的独立线程保留入口", async (t) => {
  const clicked = [];
  const leaf = (text, ...ids) => ({ text, ...Object.fromEntries(ids.map((id) => [`comment_${id}`, true])) });
  const h = await mount(t, {
    preset: "internal", canvas: true,
    value: [
      { type: "p", id: "first", children: [leaf("跨块开始", "dsc_cross")] },
      { type: "p", id: "second", children: [leaf("交叠区", "dsc_cross", "dsc_local")] },
      { type: "p", id: "third", children: [leaf("跨块结尾", "dsc_cross")] },
    ],
    pageBlocks: { activeId: null, hoverId: null, openIds: ["dsc_cross", "dsc_local"], onCommentClick: (target) => clicked.push(target) },
  });
  const buttons = [...h.el.querySelectorAll(".plate-block-comments")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["1", "1"]);
  await act(async () => {
    buttons[1].click();
    h.el.querySelector('[data-plate-block-id="third"] mark').click();
  });
  assert.deepEqual(clicked.map(({ blockId, ids }) => [blockId, ids]), [["second", ["dsc_local"]], ["third", ["dsc_cross"]]]);
});

test("选区展开时渲染 role=toolbar 浮动工具栏，mark 按钮随 preset 裁剪", async (t) => {
  const h = await mount(t, { preset: "help", value: [{ type: "p", children: [{ text: "选中这段文字" }] }] });
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.focus();
    editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 4 } });
  });
  await h.settle(60);
  const toolbar = h.browser.document.querySelector('[role="toolbar"]');
  assert.ok(toolbar, "展开选区渲染浮动工具栏");
  const labels = [...toolbar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
  for (const label of ["加粗", "斜体", "下划线", "删除线", "行内代码", "链接", "无序列表", "有序列表"]) {
    assert.ok(labels.includes(label), `help 工具栏包含 ${label}`);
  }
  assert.ok(!labels.includes("待办列表"), "help 工具栏无待办列表");
  assert.ok(!labels.includes("更多"), "help 无颜色权限，不渲染更多菜单");

  const legal = await mount(t, { preset: "legal", value: [{ type: "p", children: [{ text: "法律文本" }] }] });
  const legalEditor = editorOf(legal.el);
  await act(async () => {
    legalEditor.tf.focus();
    legalEditor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 2 } });
  });
  await legal.settle(60);
  const legalToolbar = legal.browser.document.querySelector('[role="toolbar"]');
  assert.ok(legalToolbar, "legal 展开选区渲染浮动工具栏");
  const legalLabels = [...legalToolbar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
  assert.ok(!legalLabels.includes("有序列表"), "legal 工具栏无有序列表");
  assert.ok(legalLabels.includes("更多"), "legal 有颜色权限，渲染更多菜单");
  assert.ok(legalLabels.includes("行内代码"), "legal 含行内代码");
});

test("列表缩进经 IndentPlugin 存储且被 indentMax 钳制在 whitelist 1..3", async (t) => {
  const h = await mount(t, {
    preset: "internal",
    value: [{ type: "p", listStyleType: "decimal", indent: 1, listStart: 1, children: [{ text: "列表项" }] }],
  });
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } });
    indent(editor);
    indent(editor);
    indent(editor);
    indent(editor);
  });
  await h.settle();
  const envelope = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(envelope, { preset: "internal" }).ok, true, "缩进后 envelope 合法");
  const item = envelope.value.find((n) => n.listStyleType === "decimal");
  assert.ok(item, "列表项保留");
  assert.equal(item.indent, 3, "indent 被钳制到 3");
  await act(async () => {
    outdent(editor);
  });
  await h.settle();
  const mid = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(mid, { preset: "internal" }).ok, true, "减少缩进后 envelope 合法");
  assert.equal(mid.value.find((n) => n.listStyleType === "decimal").indent, 2, "缩进回到 2");
  // Plate 列表规范化：一级列表项继续 outdent 会退化为普通段落（Notion 行为）。
  await act(async () => {
    outdent(editor);
    outdent(editor);
  });
  await h.settle();
  const out = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(out, { preset: "internal" }).ok, true, "退化为段落后 envelope 合法");
  assert.equal(out.value.find((n) => n.listStyleType === "decimal"), undefined, "低于一级缩进不再保留列表");
  assert.ok(out.value.some((n) => n.type === "p" && n.children?.some((c) => c.text === "列表项")), "文本保留为普通段落");
});

test("浮动链接工具栏插入白名单 https 链接，envelope 保留 a 节点与选中文本", async (t) => {
  const h = await mount(t, { preset: "help", value: [{ type: "p", children: [{ text: "链接文本" }] }] });
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.focus();
    editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 4 } });
    triggerFloatingLink(editor, { focused: true });
  });
  await h.settle();
  assert.ok(h.browser.document.querySelector('[aria-label="链接地址"]'), "链接地址输入渲染");
  assert.ok(h.browser.document.querySelector('[aria-label="链接显示文本"]'), "显示文本输入渲染");
  await act(async () => {
    editor.setOption({ key: "a" }, "url", "https://example.com/docs");
    submitFloatingLink(editor);
  });
  await h.settle();
  const envelope = h.envelopes.at(-1);
  assert.equal(validatePlateDocument(envelope, { preset: "help" }).ok, true, "插入链接后 envelope 合法");
  const link = envelope.value[0].children.find((c) => c.type === "a");
  assert.ok(link, "a 节点进入 envelope");
  assert.equal(link.url, "https://example.com/docs");
  assert.equal(link.children[0].text, "链接文本", "选中文本成为链接文字");
});
