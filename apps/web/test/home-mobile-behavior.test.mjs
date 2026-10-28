import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isHomeFastAccount } from '../src/lib/home-fast-accounts.ts';
import { canonicalResourceCode } from '../src/lib/listing-filters.ts';

const require = createRequire(import.meta.url);
const link = { default: props => React.createElement('a', props) };
const hooks = { ...React, useState: initial => [initial, () => {}], useEffect() {}, useCallback: fn => fn };
const node = (tag, props) => React.createElement(tag, props);
function load(relative, mocks = {}, extra = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', 'window', code)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), exports, extra.window);
  return exports;
}
const title = load('../src/lib/account-title.ts', { './listing-filters': { canonicalResourceCode } });
const empty = load('../src/components/delta/account-card-empty.tsx');
const account = {
  id: 'account /1', displayNo: 'AC202610260000001', title: '合成布局测试账号', rentalMode: 'fast', canCreateOrder: true,
  historicalReadOnly: false, resourceLines: [], conditionLines: [], media: [], skinTags: [],
  resourceTotalLabel: '¥123.45', depositLabel: '¥50.00', payableTotalLabel: '¥173.45', termLabel: '3天',
  loginMethod: { displayName: '扫码上号' },
};
const remember = [];
const delta = load('../src/components/delta/delta-section.tsx', {
  react: hooks, 'next/link': link, 'embla-carousel-react': { default: () => [() => {}, null] },
  './account-card': { AccountCard: ({ data }) => node('div', { 'data-desktop-account': data.id }), accountHref: id => '/accounts/' + encodeURIComponent(id), authoritativeRatioLabel: () => null },
  './account-card-skeleton': { AccountCardSkeleton: () => node('div', {}) },
  './account-card-empty': empty, './game-identity': { GameIdentity: ({ children }) => node('div', { children }) },
  '@/lib/account-title': title, '@/lib/account-return': { rememberAccountReturn: (...args) => remember.push(args) },
  '../favorites/favorite-button': { FavoriteButton: ({ title }) => node('button', { 'aria-label': `收藏${title}` }) },
}, { window: { location: { pathname: '/' } } });

test('homepage never combines historical, ordinary or ineligible accounts into its fast shelf', () => {
  let displayed;
  const mocks = {
    react: hooks, 'next/navigation': { useRouter: () => ({ push() {} }) },
    './delta/delta-section': { DeltaSection: props => { displayed = props.accounts; return null; } },
    './favorites/favorites-context': { FavoritesProvider: ({ children }) => children },
    '@/lib/account-search': { accountSearchHref: value => '/accounts?q=' + value },
    '@/lib/home-fast-accounts': { isHomeFastAccount }, './home/home-mobile.css': {},
  };
  for (const [path, name] of [['./layout/portal-header', 'PortalHeader'], ['./hero/service-benefits', 'ServiceBenefits'], ['./hero/hero-section', 'HeroSection'], ['./notice/platform-stats', 'PlatformStats'], ['./layout/portal-footer', 'PortalFooter'], ['./delta/game-identity', 'UpcomingGames']]) mocks[path] = { [name]: () => null };
  const { PortalHome } = load('../src/components/portal-home.tsx', mocks);
  renderToStaticMarkup(node(PortalHome, { accounts: [account, { ...account, id: 'ordinary', rentalMode: 'ordinary' }, { ...account, id: 'unavailable', canCreateOrder: false }, { ...account, id: 'unknown', canCreateOrder: undefined }], historicalAccounts: [{ ...account, id: 'history', historicalReadOnly: true }], supplyState: 'ready' }));
  assert.deepEqual(displayed.map(item => item.id), [account.id]);
});

test('empty and unavailable fast shelves separate no stock, closed fast and read failure', () => {
  const empty = renderToStaticMarkup(node(delta.DeltaSection, { accounts: [], supplyState: 'ready', fastEnabled: true }));
  assert.match(empty, /暂无特惠账号/);
  assert.match(empty, /href="\/accounts"[^>]*>浏览全部账号/);
  assert.doesNotMatch(empty, /home-fast-row"/);
  const closed = renderToStaticMarkup(node(delta.DeltaSection, { accounts: [], supplyState: 'ready', fastEnabled: false }));
  assert.match(closed, /极速出租暂未开放/);
  assert.doesNotMatch(closed, /暂无特惠账号/);
  assert.doesNotMatch(closed, /冒充特惠|验收/);
  const unknown = renderToStaticMarkup(node(delta.DeltaSection, { accounts: [], supplyState: 'ready', fastEnabled: null }));
  assert.match(unknown, /特惠状态暂时无法确认/);
  const unavailable = renderToStaticMarkup(node(delta.DeltaSection, { accounts: [], supplyState: 'unavailable' }));
  assert.match(unavailable, /特惠号源暂不可用/);
  assert.doesNotMatch(unavailable, /暂无特惠账号/);
  const error = renderToStaticMarkup(node(delta.DeltaSection, { supplyState: 'error', onRetry() {} }));
  assert.match(error, /账号列表加载失败/);
  assert.match(error, /重试/);
});

test('mobile comparison rows preserve basic fees, account destinations, unknowns and the desktop card', () => {
  const html = renderToStaticMarkup(node(delta.DeltaSection, { accounts: [account], supplyState: 'ready' }));
  for (const text of ['资源费用', '¥123.45', '押金', '¥50.00', '基础预付', '¥173.45', '扫码上号', '3天', '查看账号', 'AC202610260000001']) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/accounts\/account%20%2F1"/);
  assert.match(html, /data-desktop-account="account \/1"/);
  const unknown = renderToStaticMarkup(node(delta.HomeFastAccountRow, { data: { ...account, depositLabel: null, payableTotalLabel: null, termLabel: '', loginMethod: null } }));
  assert.match(unknown, /详情核定/);
  assert.match(unknown, /租期详情核定/);
  assert.match(unknown, /上号方式待确认/);
  assert.doesNotMatch(unknown, /¥0/);
});

test('mobile row detail links preserve the homepage return origin for ordinary clicks', () => {
  const tree = delta.HomeFastAccountRow({ data: account });
  const links = [];
  function walk(node) { if (!node || typeof node !== 'object') return; if (node.props?.onClick) links.push(node); React.Children.forEach(node.props?.children, walk); }
  walk(tree);
  assert.equal(links.length, 2);
  remember.length = 0;
  links[0].props.onClick({ button: 0, ctrlKey: true });
  assert.equal(remember.length, 0);
  links[0].props.onClick({ button: 0 });
  assert.equal(remember.length, 1);
  assert.equal(remember[0][0], account.id);
  assert.equal(remember[0][1].pathname, '/');
});
