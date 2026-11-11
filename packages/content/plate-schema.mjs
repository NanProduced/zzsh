// Plate document envelope contract shared by API, Web, Admin and tests.
// Pure JS: no Plate runtime, no node builtins, no DOM.

const byteLength = (s) => new TextEncoder().encode(s).length;

export const PRESETS = ["help", "update", "notice", "legal", "internal"];

const MAX_ENVELOPE_BYTES = 200000;
const MAX_DEPTH = 8;
const MAX_MEDIA = 300;
const MAX_TABLE_COLS = 12;
const MAX_TABLE_ROWS = 100;
const NOTICE_TEXT_CHARS = 1200;
const PROJECTION_BYTES = 20000;
const CANON_MAX_DEPTH = 24;
export const PALETTE = ["red", "orange", "green", "blue", "gray"];

export const BLOCK_TYPES = {
  help: ["p", "h2", "h3", "h4", "blockquote", "hr", "table", "tr", "td", "th", "img", "code_block", "code_line", "callout", "toggle"],
  update: ["p", "h2", "h3", "blockquote", "hr", "img"],
  notice: ["p", "blockquote", "callout"],
  legal: ["p", "h2", "h3", "blockquote", "hr", "table", "tr", "td", "th"],
  internal: ["p", "h2", "h3", "h4", "blockquote", "hr", "table", "tr", "td", "th", "img", "code_block", "code_line", "callout", "toggle", "toc"],
};
const LIST_PRESETS = PRESETS;
const MARKS = {
  base: ["bold", "italic", "strikethrough"],
  extended: ["underline", "code"],
};
const CONTAINERS = new Set(["blockquote", "table", "tr", "td", "th", "code_block", "callout", "toggle"]);
const LEAF_BLOCKS = new Set(["p", "h2", "h3", "h4", "hr", "img", "code_line", "toc"]);

const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isText = (v) => typeof v === "string";

export function marksFor(preset) {
  const marks = [...MARKS.base];
  if (preset === "help" || preset === "legal" || preset === "internal") marks.push(...MARKS.extended);
  if (preset === "legal" || preset === "internal") marks.push("color", "backgroundColor");
  if (preset === "internal") marks.push("comment");
  return marks;
}

function linkOk(url, preset) {
  if (!isText(url)) return false;
  if (url.startsWith("https://")) return true;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  return preset === "internal" && /^doc:[A-Za-z0-9_-]+$/.test(url);
}

function placeholderHit(text) {
  return /【[^】]*】|\bUNKNOWN\b|待确认|\bTODO\b|\bTBD\b/.test(text);
}

export function validatePlateDocument(doc, { preset, mode = "draft" } = {}) {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });
  if (!PRESETS.includes(preset)) return { ok: false, errors: [{ path: "$", code: "ATTR_NOT_ALLOWED", message: "unknown preset" }] };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: [{ path: "$", code: "UNKNOWN_NODE", message: "envelope must be an object" }] };
  if (doc.format !== "plate") add("$.format", "ATTR_NOT_ALLOWED", "format must be plate");
  if (doc.schemaVersion !== 1) add("$.schemaVersion", "ATTR_NOT_ALLOWED", "schemaVersion must be 1");
  if (doc.preset !== preset) add("$.preset", "ATTR_NOT_ALLOWED", "preset mismatch");
  if (!Array.isArray(doc.value)) add("$.value", "UNKNOWN_NODE", "value must be an array");
  const bytes = byteLength(JSON.stringify(doc ?? null));
  if (bytes > MAX_ENVELOPE_BYTES) add("$", "TOO_LARGE", `envelope ${bytes} bytes exceeds ${MAX_ENVELOPE_BYTES}`);
  if (!Array.isArray(doc.value)) return { ok: errors.length === 0, errors };

  const allowedTypes = new Set(BLOCK_TYPES[preset]);
  const allowedMarks = marksFor(preset);
  const stats = { media: 0, chars: 0, projection: "" };
  const publish = mode === "publish";

  const walkText = (leaf, path) => {
    if (!leaf || typeof leaf !== "object" || typeof leaf.text !== "string") {
      add(path, "UNKNOWN_NODE", "text leaf must carry a string text");
      return "";
    }
    for (const key of Object.keys(leaf)) {
      if (key === "text") continue;
      if (key.startsWith("comment_")) {
        if (preset !== "internal") add(`${path}.${key}`, "MARK_NOT_ALLOWED", "comment marks are internal-only");
        continue;
      }
      if (!allowedMarks.includes(key)) {
        add(`${path}.${key}`, "MARK_NOT_ALLOWED", `mark ${key} not allowed in ${preset}`);
        continue;
      }
      if (key === "color" || key === "backgroundColor") {
        const ok = preset === "legal" ? leaf[key] === "red" : PALETTE.includes(leaf[key]);
        if (!ok) add(`${path}.${key}`, "MARK_NOT_ALLOWED", `color token ${leaf[key]} not allowed`);
        continue;
      }
      if (leaf[key] !== true) add(`${path}.${key}`, "MARK_NOT_ALLOWED", "marks must be boolean true");
    }
    if (publish && preset !== "internal" && placeholderHit(leaf.text)) add(path, "PLACEHOLDER_FOUND", "placeholder text in publish mode");
    return leaf.text;
  };

  const walk = (node, path, depth) => {
    if (depth > MAX_DEPTH) {
      add(path, "DEPTH_EXCEEDED", `nesting deeper than ${MAX_DEPTH}`);
      return "";
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      add(path, "UNKNOWN_NODE", "node must be an object");
      return "";
    }
    const type = node.type;
    if (type === "a") {
      if (!linkOk(node.url, preset)) add(`${path}.url`, "LINK_PROTOCOL", `url ${node.url} not allowed`);
      for (const key of Object.keys(node)) {
        if (key !== "type" && key !== "url" && key !== "children" && key !== "id") add(`${path}.${key}`, "ATTR_NOT_ALLOWED", `attribute ${key} not allowed on a`);
      }
      return (node.children ?? []).map((c, i) => walkText(c, `${path}.children[${i}]`)).join("");
    }
    if (!allowedTypes.has(type)) {
      add(path, "UNKNOWN_NODE", `node type ${type} not allowed in ${preset}`);
      return "";
    }
    if ((type === "hr" || type === "toc" || type === "img") && !Array.isArray(node.children)) {
      add(`${path}.children`, "ATTR_NOT_ALLOWED", "void nodes must carry a children array");
    }
    const listType = node.listStyleType;
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "children") continue;
      if (key === "id") {
        if (!isText(node.id) || node.id.length === 0 || node.id.length > 64) add(`${path}.id`, "ATTR_NOT_ALLOWED", "id must be a non-empty string <= 64");
        continue;
      }
      if (key === "indent") {
        if (!isInt(node.indent, 0, 3)) add(`${path}.indent`, "ATTR_NOT_ALLOWED", "indent must be integer 0..3");
        continue;
      }
      if (key === "listStyleType") {
        const ok = LIST_PRESETS.includes(preset) && (node.listStyleType === "disc" || node.listStyleType === "decimal" || (preset === "internal" && node.listStyleType === "todo"));
        if (!ok) add(`${path}.listStyleType`, "ATTR_NOT_ALLOWED", `listStyleType ${node.listStyleType} not allowed in ${preset}`);
        if (preset === "legal" && node.listStyleType === "decimal") add(`${path}.listStyleType`, "ATTR_NOT_ALLOWED", "legal keeps source numbering as text");
        continue;
      }
      if (key === "listStart") {
        if (listType !== "decimal" || !isInt(node.listStart, 1, Number.MAX_SAFE_INTEGER)) add(`${path}.listStart`, "ATTR_NOT_ALLOWED", "listStart only on decimal lists, integer >= 1");
        continue;
      }
      if (key === "checked") {
        if (listType !== "todo" || typeof node.checked !== "boolean") add(`${path}.checked`, "ATTR_NOT_ALLOWED", "checked only on todo lists, boolean");
        continue;
      }
      if (key === "variant") {
        if (type !== "callout" || !["info", "warning"].includes(node.variant)) add(`${path}.variant`, "ATTR_NOT_ALLOWED", "variant info|warning only on callout");
        continue;
      }
      if (key === "mediaId" || key === "imageId") {
        const want = preset === "internal" ? "imageId" : "mediaId";
        if (type !== "img" || key !== want || !isText(node[key]) || node[key].length === 0 || node[key].length > 128) {
          add(`${path}.${key}`, "MEDIA_NOT_ALLOWED", `${preset} images must carry ${want}`);
        }
        continue;
      }
      if (key === "alt") {
        if (type !== "img" || !isText(node.alt) || node.alt.length > 500) add(`${path}.alt`, "ATTR_NOT_ALLOWED", "alt only on img, string <= 500");
        continue;
      }
      add(`${path}.${key}`, "ATTR_NOT_ALLOWED", `attribute ${key} not allowed on ${type}`);
    }
    if (type === "img") {
      stats.media += 1;
      if (stats.media > MAX_MEDIA) add(path, "MEDIA_NOT_ALLOWED", `more than ${MAX_MEDIA} images`);
      const alt = isText(node.alt) ? node.alt : "";
      stats.chars += alt.length;
      stats.projection += alt;
      return alt;
    }
    if (listType !== undefined && !isInt(node.indent ?? 1, 1, 3)) add(`${path}.indent`, "ATTR_NOT_ALLOWED", "list indent must be 1..3");
    if (type === "hr" || type === "toc") return "";
    if (type === "code_block") {
      const kids = node.children ?? [];
      for (const [i, c] of kids.entries()) if (c?.type !== "code_line") add(`${path}.children[${i}]`, "UNKNOWN_NODE", "code_block children must be code_line");
      return kids.map((c, i) => walk(c, `${path}.children[${i}]`, depth + 1)).join("\n");
    }
    if (type === "table") {
      const rows = (node.children ?? []).filter((c) => c?.type === "tr");
      if (rows.length > MAX_TABLE_ROWS) add(path, "TOO_LARGE", `table rows ${rows.length} exceed ${MAX_TABLE_ROWS}`);
      for (const [i, r] of rows.entries()) {
        const cells = (r.children ?? []).filter((c) => c?.type === "td" || c?.type === "th");
        if (cells.length > MAX_TABLE_COLS) add(`${path}.children[${i}]`, "TOO_LARGE", `table cols ${cells.length} exceed ${MAX_TABLE_COLS}`);
      }
    }
    if (CONTAINERS.has(type) || LEAF_BLOCKS.has(type)) {
      const kids = node.children ?? [];
      if (LEAF_BLOCKS.has(type) && type !== "hr" && type !== "toc") {
        for (const [i, c] of kids.entries()) {
          if (c && typeof c === "object" && "text" in c) continue;
          if (c?.type === "a") continue;
          add(`${path}.children[${i}]`, "UNKNOWN_NODE", `${type} children must be text or a`);
        }
      }
      const parts = kids.map((c, i) => (c && typeof c === "object" && "text" in c ? walkText(c, `${path}.children[${i}]`) : walk(c, `${path}.children[${i}]`, depth + 1)));
      const joined = type === "tr" ? parts.join("\t") : parts.join(type === "p" || type === "h2" || type === "h3" || type === "h4" || type === "code_line" ? "" : "\n");
      if (LEAF_BLOCKS.has(type) || type === "tr") {
        stats.chars += joined.length;
        stats.projection += joined + "\n";
      }
      return joined;
    }
    return "";
  };

  for (const [i, node] of doc.value.entries()) walk(node, `$.value[${i}]`, 1);
  if (preset === "notice" && stats.chars > NOTICE_TEXT_CHARS) add("$", "TEXT_TOO_LONG", `notice visible text ${stats.chars} chars exceeds ${NOTICE_TEXT_CHARS}`);
  if (preset === "update" || preset === "legal") {
    const n = byteLength(stats.projection);
    if (n > PROJECTION_BYTES) add("$", "TEXT_TOO_LONG", `${preset} plain text ${n} bytes exceeds ${PROJECTION_BYTES}`);
  }
  return { ok: errors.length === 0, errors };
}

export function extractPlate(doc) {
  const plain = [];
  const toc = [];
  const mediaIds = [];
  const imageIds = [];
  const commentIds = [];
  const links = [];
  const textOf = (node) => {
    if (typeof node?.text === "string") {
      for (const key of Object.keys(node)) {
        if (key.startsWith("comment_")) commentIds.push(key.slice("comment_".length));
      }
      return node.text;
    }
    if (node?.type === "a") {
      links.push(node.url);
      return (node.children ?? []).map(textOf).join("");
    }
    if (node?.type === "img") {
      if (node.mediaId) mediaIds.push(node.mediaId);
      if (node.imageId) imageIds.push(node.imageId);
      return node.alt ?? "";
    }
    if (node?.type === "hr" || node?.type === "toc") return "";
    const kids = (node?.children ?? []).map(textOf);
    if (node?.type === "tr") return kids.join("\t");
    if (node?.type === "code_block") return kids.join("\n");
    if (node?.type === "p" || node?.type === "h2" || node?.type === "h3" || node?.type === "h4" || node?.type === "code_line") return kids.join("");
    return kids.join("\n");
  };
  for (const node of doc?.value ?? []) {
    if (node?.type === "h2" || node?.type === "h3") toc.push({ id: `content-${node.id}`, text: textOf(node), level: node.type === "h2" ? 2 : 3 });
    plain.push(textOf(node));
  }
  const uniq = (a) => [...new Set(a)];
  return { plainText: plain.join("\n"), toc, mediaIds: uniq(mediaIds), imageIds: uniq(imageIds), commentIds: uniq(commentIds), links: uniq(links) };
}

export function canonicalize(value, depth = 0) {
  if (depth > CANON_MAX_DEPTH) throw new Error("payload nesting is too deep");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("payload numbers must be safe integers");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const parts = [];
    for (const [key, child] of entries) {
      if (key === "contentHash") throw new Error("payload must not contain contentHash");
      parts.push(`${JSON.stringify(key.normalize("NFC"))}:${canonicalize(child, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("payload contains an unsupported value");
}

export async function plateDigest(doc) {
  const bytes = new TextEncoder().encode(canonicalize({ format: doc.format, schemaVersion: doc.schemaVersion, preset: doc.preset, value: doc.value }));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Editor-side seam: Plate runtime value -> storable envelope. Drops everything
// the whitelist forbids instead of throwing, so paste can never persist it.
export function toPlateEnvelope(value, preset) {
  const allowedTypes = new Set(BLOCK_TYPES[preset]);
  const allowedMarks = marksFor(preset);
  const cleanLeaf = (leaf) => {
    if (!leaf || typeof leaf.text !== "string") return null;
    const out = { text: leaf.text };
    for (const key of Object.keys(leaf)) {
      if (key === "text") continue;
      if (key.startsWith("comment_")) {
        if (preset === "internal") out[key] = true;
        continue;
      }
      if (!allowedMarks.includes(key)) continue;
      if (key === "color" || key === "backgroundColor") {
        const ok = preset === "legal" ? leaf[key] === "red" : PALETTE.includes(leaf[key]);
        if (ok) out[key] = leaf[key];
        continue;
      }
      if (leaf[key] !== true) continue;
      out[key] = true;
    }
    return out;
  };
  const clean = (node) => {
    if (!node || typeof node !== "object") return [];
    if (typeof node.text === "string") {
      const leaf = cleanLeaf(node);
      return leaf ? [leaf] : [];
    }
    const kids = (node.children ?? []).flatMap(clean);
    if (node.type === "a") {
      return linkOk(node.url, preset) ? [{ type: "a", url: node.url, children: kids }] : kids;
    }
    if (!allowedTypes.has(node.type)) return kids;
    const out = { type: node.type };
    if (typeof node.id === "string" && node.id) out.id = node.id;
    else if (node.type === "h2" || node.type === "h3" || node.type === "h4") out.id = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const lt = node.listStyleType;
    const listOk = lt === "disc" || lt === "decimal" || (preset === "internal" && lt === "todo");
    if (listOk && !(preset === "legal" && lt === "decimal")) {
      out.listStyleType = lt;
      out.indent = isInt(node.indent, 1, 3) ? node.indent : 1;
      if (lt === "decimal" && isInt(node.listStart, 1, Number.MAX_SAFE_INTEGER)) out.listStart = node.listStart;
      if (lt === "todo") out.checked = node.checked === true;
    } else if (isInt(node.indent, 0, 3) && node.indent > 0) out.indent = node.indent;
    if (node.type === "callout") out.variant = node.variant === "warning" ? "warning" : "info";
    if (node.type === "img") {
      const key = preset === "internal" ? "imageId" : "mediaId";
      if (typeof node[key] === "string" && node[key]) out[key] = node[key];
      else return [];
      if (typeof node.alt === "string") out.alt = node.alt.slice(0, 500);
      out.children = [{ text: "" }];
      return [out];
    }
    if (node.type === "hr" || node.type === "toc") return [{ ...out, children: [{ text: "" }] }];
    if (node.type === "code_block") return [{ ...out, children: kids.filter((k) => k.type === "code_line") }];
    if (node.type === "table") return [{ ...out, children: kids.filter((k) => k.type === "tr") }];
    if (node.type === "tr") return [{ ...out, children: kids.filter((k) => k.type === "td" || k.type === "th") }];
    if (LEAF_BLOCKS.has(node.type)) return [{ ...out, children: kids.filter((k) => typeof k.text === "string" || k.type === "a") }];
    return [{ ...out, children: kids }];
  };
  return { format: "plate", schemaVersion: 1, preset, value: (Array.isArray(value) ? value : []).flatMap(clean) };
}