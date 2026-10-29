import {visit} from 'unist-util-visit';
import {toString} from 'mdast-util-to-string';
import {safeContentLink} from './index.cjs';

const mediaPattern = /^media:\/\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
export function markdownMediaId(url) { return typeof url === 'string' ? url.match(mediaPattern)?.[1] ?? null : null; }

export function safeMarkdownLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
  if (value.startsWith('#')) return value;
  if (value.startsWith('/')) { try { return safeContentLink(value); } catch { return null; } }
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : null; } catch { return null; }
}

export function createHeadingIds() {
  const used = new Set();
  return (text) => {
    const slug = text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
    const base = `content-${slug}`;
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return id;
  };
}

export function remarkContentHeadings() {
  return (tree) => {
    const next = createHeadingIds();
    visit(tree, 'heading', (node) => {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: next(toString(node)) } };
    });
  };
}
