// SK7-R1-01: the retired red/gold business grouping must not come back on new UI surfaces.
// Real listing-detail.tsx and supply-workspaces.tsx are compiled and rendered to static markup;
// snapshot payloads are deep-frozen and compared byte-for-byte after rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as listingView from '../src/lib/listing-view.ts';
import * as listingFilters from '../src/lib/listing-filters.ts';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(web, 'package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, extra = {}) {
  const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(web);
  const Pass = (p) => React.createElement(React.Fragment, null, p.children), Empty = () => null;
  m.require = (n) => {
    if (Object.hasOwn(extra, n)) return extra[n];
    if (n.endsWith('.css')) return {};
    if (n === 'next/link') return ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children);
    if (n === 'next/image') return { getImageProps: (p) => ({ props: p }) };
    if (n.endsWith('listing-view')) return listingView;
    if (n.endsWith('listing-filters')) return listingFilters;
    if (n.endsWith('supply-games')) return { DELTA_GAME_CODE: 'df' };
    if (n.endsWith('skin-media-thumb')) return load(path.join(web, 'src/components/supply/skin-media-thumb.tsx'));
    if (n.includes('user-session-provider')) return { useUserSession: () => ({ status: 'authenticated', userId: 'SYNTHETIC' }), useUserSessionStore: Empty, publishUserSessionChange: Empty };
    if (n.includes('favorite-button')) return { FavoriteButton: Empty, FavoriteNotice: Empty };
    if (n.includes('rental-confirm-panel')) return { RentalConfirmPanel: Empty };
    if (n.includes('/ui/tooltip')) return { Tooltip: Pass, TooltipContent: Pass, TooltipTrigger: Pass };
    if (n.startsWith('@/') || n.startsWith('./') || n.startsWith('../')) return {};
    return require(n);
  };
  const raw = readFileSync(file, 'utf8').replace('function ReadyDetail(', 'export function ReadyDetail(').replace('function AccountDetail(', 'export function AccountDetail(');
  m._compile(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const card = load(path.join(web, 'src/components/delta/account-card.tsx'));
const detail = load(path.join(web, 'src/components/market/listing-detail.tsx'), { '@/components/delta/account-card': card });
const owner = load(path.join(web, 'src/components/supply-workspaces.tsx'));

const freeze = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const OLD = '干员金皮（旧分组）';
const fixtures = {
  oldNative: { id: 'SKIN_OLD', name: '已核皮肤', categoryCode: 'df_skin_category_agent_gold', categoryName: OLD },
  explicitNull: { id: 'SKIN_NULL', name: '金色传说', ownerKind: null, rarityCode: null, rarityName: null, categoryCode: 'df_skin_category_agent_gold', categoryName: OLD },
  verifiedAgent: { id: 'SKIN_AGENT', name: '露娜-黑·天际线', ownerKind: 'AGENT', rarityCode: null, rarityName: null, categoryCode: 'df_skin_category_agent_gold', categoryName: OLD },
};
function renderDetail(skin) {
  const data = freeze({ id: 'ACCOUNT_SYNTHETIC', gameId: 'GAME_SYNTHETIC', versionId: 'VERSION_SYNTHETIC', releaseId: 'RELEASE_SYNTHETIC', title: '测试账号', publicTitle: '测试账号', displayNo: 'ZZ202610180000002', conditionLines: [], resourceLines: [], skinTags: [structuredClone(skin)], media: [], entitlementNames: [], termLabel: '1天', resourceTotalLabel: '待核定', haffRentLabel: null, itemResourceTotalLabel: null, canCreateOrder: false });
  const bytes = JSON.stringify(data);
  const html = renderToStaticMarkup(React.createElement(detail.ReadyDetail, { data }));
  assert.equal(JSON.stringify(data), bytes, 'detail payload unchanged');
  return html;
}
function renderOwner(skin, versionPatch = {}) {
  const s = structuredClone(skin);
  const value = freeze({ account: { id: 'ACCOUNT_SYNTHETIC', display_no: 'ZZ202610180000002', state: 'ACTIVE', owner_paused: false, staff_restricted: false }, version: { id: 'VERSION_SYNTHETIC', reviewState: 'DRAFT', declaration: { title: '测试账号', attributes: {}, inventory: [], skins: [s.id], entitlements: [], mediaBindings: [] }, presentation: { items: [], skins: [s], entitlements: [] }, quote: null, catalogItems: [], ...structuredClone(versionPatch) }, history: [], decisions: [], blockers: [] });
  const bytes = JSON.stringify(value);
  const html = renderToStaticMarkup(React.createElement(owner.AccountDetail, { detail: value, latest: null, busy: '', identityReady: true, onAction: async () => {}, onRefresh: () => {}, onAdopt: () => {} }));
  assert.equal(JSON.stringify(value), bytes, 'owner payload unchanged');
  return html;
}
const heading = (html) => [...html.matchAll(/<div class="account-skin-group-head"><strong>(.*?)<\/strong>/g)].map((m) => m[1]);
const facet = (html, id) => html.match(new RegExp(`data-skin-id="${id}"[\\s\\S]*?</li>`))?.[0].match(/<small>(.*?)<\/small>/)?.[1] ?? null;

test('SK7-R1-01 detail never groups by the retired red/gold category', () => {
  for (const key of ['oldNative', 'explicitNull']) {
    const html = renderDetail(fixtures[key]);
    assert.equal(html.includes(OLD), false, `${key} must not show the old group`);
    assert.deepEqual(heading(html), ['类型待核'], `${key} falls back to a neutral group`);
    assert.ok(html.includes(fixtures[key].name), `${key} keeps the skin's own name`);
  }
  const known = renderDetail(fixtures.verifiedAgent);
  assert.deepEqual(heading(known), ['干员外观']);
  assert.equal(known.includes(OLD), false);
});

test('SK7-R1-01 owner workspace facet shows only verified type/quality, never the old category', () => {
  for (const key of ['oldNative', 'explicitNull']) {
    const html = renderOwner(fixtures[key]);
    assert.equal(html.includes(OLD), false, `${key} must not show the old group`);
    assert.equal(facet(html, fixtures[key].id), null, `${key} renders no facet`);
    assert.ok(html.includes(fixtures[key].name), `${key} keeps the skin's own name, including 金 in a legitimate name`);
  }
  assert.equal(facet(renderOwner(fixtures.verifiedAgent), 'SKIN_AGENT'), '干员外观');
  assert.equal(facet(renderOwner({ ...fixtures.verifiedAgent, rarityName: '测试品质' }), 'SKIN_AGENT'), '干员外观');
  assert.ok(renderOwner({ ...fixtures.verifiedAgent, rarityName: '测试品质' }).includes('测试品质'));
});

const oldDraftSkin = { ...fixtures.verifiedAgent, id: 'OLD_FROZEN_SKIN', name: '旧冻结外观' };
const currentDraftSkin = { ...fixtures.verifiedAgent, id: 'CURRENT_DRAFT_SKIN', name: '当前草稿外观' };
const draftDeclaration = (ids) => ({ title: '测试账号', attributes: {}, inventory: [], skins: ids, entitlements: [], mediaBindings: [] });
const draftSkinSummary = (items, withheld = 0) => ({ source: 'CURRENT_DRAFT_SELECTION', catalogRevision: '25', items, withheld });

test('owner unconfirmed native draft prefers current skin selection over a stale presentation without rewriting either', () => {
  const html = renderOwner(oldDraftSkin, {
    origin: 'NATIVE', contentHash: null, declaration: draftDeclaration([currentDraftSkin.id]), draftSkinSummary: draftSkinSummary([currentDraftSkin]),
  });
  assert.ok(html.includes('草稿已选皮肤'));
  assert.ok(html.includes('当前草稿外观'));
  assert.equal(html.includes('旧冻结外观'), false);
  assert.ok(html.includes('尚未冻结或公开上架'));
  assert.ok(html.includes('data-skin-summary-source="CURRENT_DRAFT_SELECTION"'));
});

test('owner draft legal empty selection overrides stale skins and withheld selections are counted honestly', () => {
  const empty = renderOwner(oldDraftSkin, { origin: 'NATIVE', contentHash: null, declaration: draftDeclaration([]), draftSkinSummary: draftSkinSummary([]) });
  assert.equal(empty.includes('旧冻结外观'), false);
  assert.ok(empty.includes('0 项已选皮肤'));
  assert.ok(empty.includes('草稿尚未选择皮肤'));
  const partial = renderOwner(oldDraftSkin, { origin: 'NATIVE', contentHash: null, declaration: draftDeclaration([currentDraftSkin.id, 'WITHHELD']), draftSkinSummary: draftSkinSummary([currentDraftSkin], 1) });
  assert.ok(partial.includes('2 项已选皮肤'));
  assert.ok(partial.includes('另有 1 项已选皮肤当前不可展示'));
  assert.ok(partial.includes('当前草稿外观'));
  assert.equal(partial.includes('WITHHELD'), false, 'withheld names/IDs are not fabricated into the visible list');
  const allWithheld = renderOwner(oldDraftSkin, { origin: 'NATIVE', contentHash: null, declaration: draftDeclaration(['WITHHELD']), draftSkinSummary: draftSkinSummary([], 1) });
  assert.ok(allWithheld.includes('1 项已选皮肤'));
  assert.equal(allWithheld.includes('草稿尚未选择皮肤'), false, 'nonpublic selection is not a legal empty set');
});

test('owner older service and frozen/non-native versions keep their original presentation', () => {
  const oldService = renderOwner(oldDraftSkin, { origin: 'NATIVE', contentHash: null });
  assert.ok(oldService.includes('旧冻结外观'));
  assert.ok(oldService.includes('皮肤摘要暂未取得'));
  assert.equal(oldService.includes('草稿已选皮肤'), false);
  for (const patch of [
    { origin: 'NATIVE', reviewState: 'DRAFT', contentHash: 'frozen_hash' },
    { origin: 'NATIVE', reviewState: 'PUBLISHED', contentHash: 'frozen_hash' },
    { origin: 'LEGACY', reviewState: 'DRAFT', contentHash: null },
  ]) {
    const html = renderOwner(oldDraftSkin, { ...patch, draftSkinSummary: draftSkinSummary([currentDraftSkin]) });
    assert.ok(html.includes('旧冻结外观'));
    assert.equal(html.includes('当前草稿外观'), false);
    assert.equal(html.includes('草稿已选皮肤'), false);
  }
});

test('SKIN-ASSETS-UI-9 account card list chip never renders retired category, uses verified type only', () => {
  function renderCard(skin, viewMode = 'list', moreSkins = []) {
    const data = freeze({
      id: 'ACCOUNT_SYNTHETIC',
      gameId: 'GAME_SYNTHETIC',
      versionId: 'VERSION_SYNTHETIC',
      releaseId: 'RELEASE_SYNTHETIC',
      title: '测试账号',
      publicTitle: '测试账号',
      displayNo: 'ZZ202610180000002',
      conditionLines: [],
      resourceLines: [],
      skinTags: [structuredClone(skin), ...structuredClone(moreSkins)],
      skinNames: [skin.name],
      skinLabels: [skin.name],
      media: [],
      entitlementNames: [],
      termLabel: '1天',
      termOptionLabel: null,
      payableTotalLabel: null,
      loginMethod: null,
      resourceTotalLabel: '待核定',
      haffRentLabel: null,
      itemResourceTotalLabel: null,
      depositLabel: null,
      canCreateOrder: false,
      unitAmountsInformational: false,
    });
    const bytes = JSON.stringify(data);
    const html = renderToStaticMarkup(React.createElement(card.AccountCard, { data, viewMode }));
    assert.equal(JSON.stringify(data), bytes, 'card payload unchanged');
    return html;
  }

  for (const key of ['oldNative', 'explicitNull']) {
    const html = renderCard(fixtures[key]);
    assert.equal(html.includes(OLD), false, `${key} list card chip must not show retired category`);
    assert.equal(html.includes('[干员金皮（旧分组）]'), false, `${key} list card must not show bracketed old group`);
    assert.equal(html.includes('skin-chip-cat'), false, `${key} list card chip must omit unknown type badge`);
    assert.ok(html.includes(fixtures[key].name), `${key} keeps skin name`);
  }

  const agentHtml = renderCard(fixtures.verifiedAgent);
  assert.equal(agentHtml.includes(OLD), false);
  assert.ok(agentHtml.includes('[干员外观]'), 'verified agent skin renders verified type label in list card chip');
  for (const viewMode of ['list', 'grid']) {
    const skin = { ...fixtures.verifiedAgent, rarityName: '测试品质', mediaId: 'TEXT_ONLY_MEDIA' };
    const more = Array.from({ length: 5 }, (_, i) => ({ ...skin, id: `SKIN_${i}`, name: `其他外观${i}` }));
    const html = renderCard(skin, viewMode, more);
    assert.equal(html.includes('/api/supply/media/'), false, `${viewMode}: list/home/favorites cards request no skin images`);
    assert.equal(html.includes('TEXT_ONLY_MEDIA'), false);
    assert.ok(html.includes('测试品质'), `${viewMode}: quality remains a text summary`);
    assert.ok(html.includes('+3'), `${viewMode}: the remaining count stays visible`);
  }
});
