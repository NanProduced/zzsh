import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectMarkdown, convertLegacyDocument, createHeadingIds } from '../markdown.mjs';
import { validateResource, resourceMediaIds } from '../index.cjs';
import { inspectContentMarkdown } from '../api-markdown.cjs';

test('reference links and images obey the same publication policy; unknown media fail closed', async () => {
  for (const source of ['[领取][x]\n\n[x]: javascript:alert(1)', '![旧码][q]\n\n[q]: media://revoked', '![未知](media://missing)']) {
    const result = await inspectMarkdown(source, { media: { revoked: { available: false } } });
    assert.ok(result.blocking > 0, source);
  }
  const result = await inspectContentMarkdown('![图][image]\n\n[image]: media://asset_1', { media: { asset_1: { available: true } } });
  assert.equal(result.blocking, 0);
  assert.deepEqual(result.mediaIds, ['asset_1']);
  assert.equal((await inspectMarkdown('```\n![code](media://private)\n```')).blocking, 0);
});

test('legal indented and differently sized fenced examples never become directives', async () => {
  for (const source of ['    :::note', '````md\n```\n:::note\n````', '`:::note`', '1 < 2，<https://example.com>']) assert.equal((await inspectMarkdown(source)).blocking, 0, source);
  assert.ok((await inspectMarkdown(':::note\n规则\n:::')).blocking > 0);
  assert.ok((await inspectMarkdown('<div>规则</div>')).blocking > 0);
});

test('heading suffixes cannot collide with existing explicit suffixes or host IDs', async () => {
  const next = createHeadingIds();
  assert.deepEqual(['a', 'a-2', 'a', 'main', '中文', '中文'].map(next), ['content-a', 'content-a-2', 'content-a-3', 'content-main', 'content-中文', 'content-中文-2']);
  const result = await inspectMarkdown('## a\n\n## a-2\n\n## a');
  assert.equal(new Set(result.toc.map(row => row.id)).size, 3);
});

test('table conversion escapes headers and cells and preserves meaningful structure', async () => {
  const source = { sections: [{ id: 'rules', title: '规则 * 标题', blocks: [{ type: 'table', columns: ['前|后', '规则'], rows: [['a|b', '注意 *不是强调*']] }] }] };
  const before = structuredClone(source);
  const result = await convertLegacyDocument(source);
  assert.equal(result.lossless, true, JSON.stringify(result.issues));
  assert.match(result.markdown, /前\\\|后/);
  assert.deepEqual(source, before);
  assert.equal(result.anchorAliases.rules, 'content-规则-标题');
  const unsupported = await convertLegacyDocument({ sections: [{ id: 'r', title: '规则', blocks: [{ type: 'unknown-embed', text: '必须处理' }] }] });
  assert.equal(unsupported.lossless, false);
});

test('all 24 original articles convert without loss and keep exact stable addresses', async () => {
  const file = new URL('./fixtures/legacy-guides.json', import.meta.url);
  const original = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : new URL('../default-guides.json', import.meta.url), 'utf8'));
  assert.equal(original.length, 24);
  for (const guide of original) {
    const converted = await convertLegacyDocument(guide);
    assert.equal(converted.lossless, true, guide.slug + ': ' + converted.issues.join('; '));
    const { sections: _sections, ...metadata } = guide;
    const value = validateResource(`guide:${guide.slug}`, { ...metadata, kind: 'guide', format: 'markdown', schemaVersion: 1, markdown: converted.markdown, mediaIds: [], anchorAliases: converted.anchorAliases });
    assert.equal(value.slug, guide.slug);
    assert.equal((await inspectMarkdown(value.markdown)).blocking, 0, guide.slug);
    assert.deepEqual(resourceMediaIds(value), []);
  }
});

test('raw unsupported Markdown can be saved while compact publication remains blocked', async () => {
  const raw = '<div>必须保留的原文</div>';
  const draft = validateResource('placement:PUBLISH_SAFE_BOX', { kind: 'notice', title: '说明', format: 'markdown', schemaVersion: 1, markdown: raw, mediaIds: [] });
  assert.equal(draft.markdown, raw);
  assert.ok((await inspectMarkdown(raw, { compact: true })).blocking > 0);
  const long = '字'.repeat(1201);
  assert.equal(validateResource('placement:PUBLISH_SAFE_BOX', { ...draft, markdown: long }).markdown, long);
  assert.ok((await inspectMarkdown(long, { compact: true })).blocking > 0);
});

test('non-rendered definitions alone cannot publish an empty document', async () => {
  assert.ok((await inspectMarkdown('[x]: https://example.org')).blocking > 0);
  assert.equal((await inspectMarkdown('![图](media://asset_1)', {media:{asset_1:{available:true}}})).blocking, 0);
});

test('legacy reserved anchors cannot falsely claim a lossless conversion', async () => {
  const result = await convertLegacyDocument({sections:[{id:'constructor',title:'旧规则',blocks:[{type:'paragraph',text:'必须保留的规则'}]}]});
  assert.equal(result.lossless,false);
  assert.match(result.issues.join(''),/锚点/);
});
