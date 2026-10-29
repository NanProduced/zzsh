import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';

import {markdownMediaId, safeMarkdownLink, createHeadingIds, remarkContentHeadings} from './markdown-policy.mjs';
export {markdownMediaId, safeMarkdownLink, createHeadingIds, remarkContentHeadings} from './markdown-policy.mjs';

const parser = unified().use(remarkParse).use(remarkGfm);
const serializer = unified().use(remarkGfm).use(remarkStringify, { bullet: '-', fences: true });
export async function inspectMarkdown(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Markdown必须是文本');
  const tree = parser.parse(source);
  remarkContentHeadings()(tree);
  const issues = [], toc = [], media = new Set();
  const definitions = new Map();
  visit(tree, 'definition', node => { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node); });
  const issue = (node, code, message, hint) => issues.push({ code, severity: 'blocking', message, hint, line: node.position?.start.line ?? 1, column: node.position?.start.column ?? 1 });
  if (!source.trim()) issue(tree, 'empty-body', '正文为空，无法发布。', '请先写入正文，草稿仍可保存。');
  if (options.compact && Array.from(source).length > 1200) issue(tree, 'compact-length', '该位置最多1200字。', '将完整规则放入帮助手册，在这里保留简短说明。');
  visit(tree, (node, _index, parent) => {
    if (node.type === 'heading' && [2, 3].includes(node.depth)) toc.push({ id: node.data.hProperties.id, title: toString(node), depth: node.depth });
    if (node.type === 'html') issue(node, 'raw-html', '原始HTML或JSX不属于支持的正文格式。', '转换为Markdown；示例代码请放入代码块。原文仍保存在草稿中。');
    if (options.compact && ['table', 'image', 'imageReference', 'code'].includes(node.type)) issue(node, 'compact-structure', '该位置只支持简短文字、列表和引用。', '请将图片、表格或代码放入完整手册。');
    if (node.type === 'text' && parent?.type !== 'heading') {
      if (/(?:^|\n)\s*:::[A-Za-z]/.test(node.value)) issue(node, 'unsupported-directive', '暂不支持 ::: 内容指令。', '使用普通标题或引用提示；代码示例请放入代码块。');
      if (/(?:^|\n)\s*(?:import\s+.+\s+from\s+['"]|export\s+(?:default|const|function|\{))/.test(node.value)) issue(node, 'mdx-module', '正文不执行MDX模块。', '删除模块语句或放入代码示例。');
    }
    const image = node.type === 'image' || node.type === 'imageReference';
    if (!image && node.type !== 'link' && node.type !== 'linkReference') return;
    const target = node.type.endsWith('Reference') ? definitions.get(node.identifier) : node;
    if (!target) { issue(node, 'missing-reference', '引用地址不存在。', '补充地址或删除无效引用。'); return; }
    if (!image) {
      if (!safeMarkdownLink(target.url)) issue(node, 'unsafe-link', '链接地址不在支持范围内。', '使用安全站内路径、页内锚点或HTTPS地址。');
      return;
    }
    const id = markdownMediaId(target.url);
    if (!id) { issue(node, 'external-image', '图片必须使用平台素材引用。', '通过素材选择器插入已审核的图片。'); return; }
    media.add(id);
    const availability = options.media?.[id];
    if (!availability?.available) issue(node, 'unavailable-media', `图片当前未获准公开：${availability?.reason ?? '不存在或尚未核验'}。`, '选择已审核且允许公开的素材。');
  });
  const plainText = tree.children.map(node => toString(node)).join('\n');
  if (source.trim() && !plainText.trim() && media.size === 0) issue(tree, 'empty-visible-body', '正文没有读者可见的内容。', '链接定义等辅助结构不能单独作为正文发布，请补充实际说明。');
  return { issues, blocking: issues.length, warnings: 0, toc, mediaIds: [...media].sort(), plainText };
}

const text = value => ({ type: 'text', value });
const paragraph = value => ({ type: 'paragraph', children: value.split('\n').flatMap((line, index) => index ? [{ type: 'break' }, text(line)] : [text(line)]) });
function semanticTree(node) {
  const result = { type: node.type };
  for (const key of ['value', 'depth', 'url', 'alt', 'title', 'ordered', 'start', 'checked']) if (node[key] !== undefined && node[key] !== null) result[key] = node[key];
  if (node.children) result.children = node.children.filter(child => child.type !== 'text' || child.value !== '').map(semanticTree);
  return result;
}

export async function convertLegacyDocument(document) {
  if (!Array.isArray(document?.sections)) throw new TypeError('旧正文缺少章节');
  const children = [], aliases = {}, issues = [], next = createHeadingIds();
  for (const section of document.sections) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(section.id) || ['constructor', 'prototype'].includes(section.id)) issues.push(`章节“${section.title}”的旧锚点无法自动迁移，请人工核对。`);
    children.push({ type: 'heading', depth: 2, children: [text(section.title)] });
    aliases[section.id] = next(section.title);
    for (const block of section.blocks) {
      switch (block.type) {
        case 'paragraph': children.push(paragraph(block.text)); break;
        case 'list': children.push({ type: 'list', ordered: Boolean(block.ordered), ...(block.ordered ? { start: 1 } : {}), children: block.items.map(value => ({ type: 'listItem', children: [paragraph(value)] })) }); break;
        case 'callout': children.push({ type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'strong', children: [text(block.tone === 'warning' ? '注意' : '说明')] }] }, paragraph(block.text)] }); break;
        case 'link': children.push({ type: 'paragraph', children: [{ type: 'link', url: block.href, children: [text(block.text)] }] }); break;
        case 'image':
          children.push({ type: 'paragraph', children: [{ type: 'image', url: `media://${block.mediaId}`, alt: block.alt }] });
          if (block.caption) children.push(paragraph(block.caption));
          break;
        case 'table':
          if (block.caption) children.push({ type: 'paragraph', children: [{ type: 'strong', children: [text(block.caption)] }] });
          children.push({ type: 'table', children: [block.columns, ...block.rows].map(row => ({ type: 'tableRow', children: row.map(value => ({ type: 'tableCell', children: [text(value)] })) })) });
          break;
        default: issues.push(`章节“${section.title}”含不支持的旧内容块。`);
      }
    }
  }
  const tree = { type: 'root', children };
  let markdown = '';
  try {
    markdown = serializer.stringify(tree);
    const roundTrip = parser.parse(markdown);
    if (JSON.stringify(semanticTree(tree)) !== JSON.stringify(semanticTree(roundTrip))) issues.push('转换后的正文结构或文字有差异，请人工处理后再发布。');
  } catch { issues.push('这份旧正文不能自动转换，请保留原格式并人工处理。'); }
  return { markdown, anchorAliases: aliases, issues, lossless: issues.length === 0 };
}
