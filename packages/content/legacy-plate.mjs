import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";
import { safeContentLink } from "./index.cjs";
import { extractPlate } from "./plate-schema.mjs";

const parser = unified().use(remarkParse).use(remarkGfm);
const paragraph = (text, props = {}) => ({ type: "p", ...props, children: [{ text }] });
const mediaPattern = /^media:\/\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const marks = { strong: "bold", emphasis: "italic", delete: "strikethrough" };

function safeLink(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
  if (/^#[\p{L}\p{N}_.:%-]+$/u.test(value)) return value;
  try {
    if (value.startsWith("/")) return safeContentLink(value);
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function documentProjection(preset) {
  const used = new Set();
  const heading = (title, depth, children = [{ text: title }]) => {
    const base = title.normalize("NFC").trim().toLowerCase().replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "section";
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    return { type: preset === "notice" ? "p" : `h${Math.min(Math.max(depth, 2), preset === "help" ? 4 : 3)}`, id, children };
  };
  const table = rows => ({ type: "table", children: rows.map((row, index) => ({
    type: "tr", children: row.map(children => ({ type: index ? "td" : "th", children: [{ type: "p", children }] })),
  })) });
  const image = (mediaId, alt = "", caption) => ({
    type: "img", mediaId, alt: alt.slice(0, 500), ...(caption ? { caption: caption.slice(0, 500) } : {}), children: [{ text: "" }],
  });
  const callout = (tone, value) => ({
    type: "callout", variant: tone === "warning" ? "warning" : "info", children: [
      paragraph(tone === "warning" ? "注意" : "说明"), paragraph(value),
    ],
  });
  const link = (url, children) => safeLink(url) ? [{ type: "a", url, children }] : children;
  const listProps = (ordered, position, indent) => ({ listStyleType: ordered ? "decimal" : "disc", indent: Math.min(indent, 3),
    ...(ordered ? { listStart: Math.max(1, position) } : {}) });
  const markdown = (source) => {
    const tree = parser.parse(source);
    const definitions = new Map(tree.children.filter(node => node.type === "definition").reverse().map(node => [node.identifier, node]));
    const target = node => node.type.endsWith("Reference") ? definitions.get(node.identifier) : node;
    function inline(nodes, active = {}) {
      return nodes.flatMap(node => {
        if (Object.hasOwn(marks, node.type)) return inline(node.children, { ...active, [marks[node.type]]: true });
        if (node.type === "link" || node.type === "linkReference") return link(target(node)?.url, inline(node.children, active));
        if (node.type === "break") return [{ text: "\n", ...active }];
        if (node.type === "image" || node.type === "imageReference") return [{ text: node.alt ?? "", ...active }];
        return [{ text: node.value ?? toString(node), ...active, ...(node.type === "inlineCode" && preset === "help" ? { code: true } : {}) }];
      });
    }
    function blocks(nodes, indent = 1) {
      return nodes.flatMap(node => {
        switch (node.type) {
          case "definition": return [];
          case "heading": return [heading(toString(node), node.depth, inline(node.children))];
          case "paragraph": {
            const value = [];
            let children = [];
            for (const part of node.children) {
              const id = (part.type === "image" || part.type === "imageReference") && target(part)?.url?.match(mediaPattern)?.[1];
              if (!id) { children.push(...inline([part])); continue; }
              if (children.length) value.push({ type: "p", children });
              children = [];
              value.push(image(id, part.alt));
            }
            if (children.length) value.push({ type: "p", children });
            return value;
          }
          case "list": return node.children.flatMap((item, index) => {
            const props = listProps(node.ordered, (node.start ?? 1) + index, indent);
            const first = item.children[0];
            const checked = typeof item.checked === "boolean" ? [{ text: item.checked ? "☑ " : "☐ " }] : [];
            const rows = first?.type === "paragraph" ? blocks([first], indent) : [];
            if (!rows.length || rows[0].type !== "p") rows.unshift(paragraph(""));
            rows[0] = { ...rows[0], ...props, children: [...checked, ...rows[0].children] };
            return [...rows, ...blocks(first?.type === "paragraph" ? item.children.slice(1) : item.children, indent + 1)];
          });
          case "blockquote": return [{ type: "blockquote", children: blocks(node.children, indent) }];
          case "thematicBreak": return [{ type: "hr", children: [{ text: "" }] }];
          case "table": return [table(node.children.map(row => row.children.map(cell => inline(cell.children))))];
          case "code": return preset === "help"
            ? [{ type: "code_block", children: node.value.split("\n").map(text => ({ type: "code_line", children: [{ text }] })) }]
            : [paragraph(node.value)];
          default: return [paragraph(node.value ?? toString(node))];
        }
      });
    }
    return blocks(tree.children);
  };
  const sectionBlock = block => {
    switch (block.type) {
      case "paragraph": return [paragraph(block.text)];
      case "list": return block.items.map((text, index) => paragraph(text, listProps(block.ordered, index + 1, 1)));
      case "callout": return [callout(block.tone, block.text)];
      case "link": return [{ type: "p", children: link(block.href, [{ text: block.text }]) }];
      case "image": return [image(block.mediaId, block.alt, block.caption)];
      case "table": return [
        ...(block.caption ? [paragraph(block.caption)] : []),
        table([block.columns, ...block.rows].map(row => row.map(text => [{ text }]))),
      ];
      default: return [];
    }
  };
  return { heading, sectionBlock, markdown };
}

function envelope(preset, value) {
  return { format: "plate", schemaVersion: 1, preset, value: value.length ? value : [paragraph("")] };
}

/** Existing DB snapshots are projected for display/editing without changing their version or bytes. */
export function projectLegacyResource(payload) {
  if (!payload || !["guide", "notice"].includes(payload.kind) || payload.format === "plate") return null;
  const { format, schemaVersion, sections, markdown, mediaIds, anchorAliases, ...metadata } = payload;
  if (format !== "markdown" && !Array.isArray(sections)) return null;
  const preset = payload.kind === "guide" ? "help" : "notice";
  const projection = documentProjection(preset);
  const aliases = { ...anchorAliases };
  const value = format === "markdown" ? projection.markdown(markdown) : sections.flatMap(section => {
    const head = projection.heading(section.title, 2);
    Object.defineProperty(aliases, section.id, { value: `content-${head.id}`, enumerable: true, configurable: true });
    return [head, ...section.blocks.flatMap(projection.sectionBlock)];
  });
  const document = envelope(preset, value);
  return { ...metadata, format: "plate", schemaVersion: 1, document, mediaIds: extractPlate(document).mediaIds.sort(),
    ...(Object.keys(aliases).length ? { anchorAliases: aliases } : {}) };
}

export function projectLegacyUpdate(body, format) {
  return envelope("update", format === "markdown" ? documentProjection("update").markdown(body) : body.split("\n").map(text => paragraph(text)));
}
