import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFastAccounts, isHomeFastAccount } from '../src/lib/home-fast-accounts.ts';

const project = listing => ({ id: listing.id, rentalMode: listing.rentalMode, canCreateOrder: listing.canCreateOrder });
const page = (items, nextCursor = null) => ({ items, nextCursor });
const listing = (id, rentalMode = 'ordinary') => ({ id, rentalMode, canCreateOrder: true });

test('the homepage only accepts native fast accounts with current order eligibility', async () => {
  const valid = listing('native-fast', 'fast');
  for (const account of [listing('ordinary'), { ...valid, historicalReadOnly: true }, { ...valid, canCreateOrder: false }, { ...valid, canCreateOrder: undefined }, { ...valid, rentalMode: null }]) {
    assert.equal(isHomeFastAccount(account), false);
  }
  assert.equal(isHomeFastAccount(valid), true);
  const result = await collectFastAccounts(async () => page([valid, { ...listing('not-rentable', 'fast'), canCreateOrder: false }, listing('ordinary')]), project);
  assert.deepEqual(result.accounts.map(account => account.id), ['native-fast']);
  const inferred = await collectFastAccounts(async () => page([{ id: 'missing-server-eligibility', rentalMode: 'fast' }]), value => ({ ...value, canCreateOrder: true }));
  assert.deepEqual(inferred.accounts, [], 'a projection must not invent current server order eligibility');
});

test('home fast shelf follows cursor pages until a fast account is found', async () => {
  const seen = [];
  const result = await collectFastAccounts(async cursor => {
    seen.push(cursor);
    if (cursor === null) return page([listing('ordinary-1')], 'cursor-2');
    if (cursor === 'cursor-2') return page([listing('ordinary-2')], 'cursor-3');
    return page([listing('fast-3', 'fast')]);
  }, project);
  assert.deepEqual(seen, [null, 'cursor-2', 'cursor-3']);
  assert.deepEqual(result.accounts.map(item => item.id), ['fast-3']);
  assert.equal(result.hasMore, false);
});

test('home fast shelf does not claim exhaustion when the bounded read limit is reached', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async cursor => {
    reads += 1;
    return page([listing(`ordinary-${reads}`)], `cursor-${reads + 1}`);
  }, project, 2);
  assert.equal(reads, 2);
  assert.deepEqual(result.accounts, []);
  assert.equal(result.hasMore, true);
});

test('home stops when both shelves are full without reading an unnecessary page', async () => {
  let reads = 0;
  const result = await collectFastAccounts(async () => {
    reads += 1;
    return page(Array.from({ length: 8 }, (_, index) => ({...listing(`shelf-${reads}-${index}`, 'fast'),historicalReadOnly:reads===2})), `next-${reads}`);
  }, value=>value);
  assert.equal(reads, 2);
  assert.equal(result.accounts.length, 8);
  assert.equal(result.historicalAccounts.length, 8);
  assert.equal(result.hasMore, true);
});

test('a full historical shelf does not hide native fast accounts on the next page', async () => {
  const cursors=[];
  const result=await collectFastAccounts(async cursor=>{
    cursors.push(cursor);
    return cursor===null
      ? page(Array.from({length:8},(_,i)=>({id:`history-${i}`,historicalReadOnly:true,rentalMode:null})), 'page-2')
      : page([listing('native-fast','fast')]);
  }, value=>value);
  assert.deepEqual(cursors,[null,'page-2']);
  assert.equal(result.historicalAccounts.length,8);
  assert.deepEqual(result.accounts.map(value=>value.id),['native-fast']);
  assert.equal(result.hasMore,false);
});

test('a full native fast shelf does not hide historical accounts on the next page', async () => {
  const cursors=[];
  const result=await collectFastAccounts(async cursor=>{
    cursors.push(cursor);
    return cursor===null
      ? page(Array.from({length:8},(_,i)=>listing(`fast-${i}`,'fast')), 'page-2')
      : page([{id:'history',historicalReadOnly:true,rentalMode:'fast'}]);
  }, value=>value);
  assert.deepEqual(cursors,[null,'page-2']);
  assert.equal(result.accounts.length,8);
  assert.deepEqual(result.historicalAccounts.map(value=>value.id),['history']);
  assert.equal(result.hasMore,false);
});

test('one full shelf still respects the page budget while the other remains empty', async () => {
  let reads=0;
  const result=await collectFastAccounts(async()=>{
    reads++;
    return page(Array.from({length:8},(_,i)=>listing(`fast-${reads}-${i}`,'fast')), `next-${reads}`);
  },project,3);
  assert.equal(reads,3);
  assert.equal(result.accounts.length,8);
  assert.equal(result.historicalAccounts.length,0);
  assert.equal(result.hasMore,true);
});

test('one server cursor stream supplies read-only history and native fast shelves without a guessed mode or duplicate ids',async()=>{
  const calls=[];
  const projectHistory=l=>({id:l.id,rentalMode:l.rentalMode??null,canCreateOrder:l.canCreateOrder,historicalReadOnly:l.source==='LEGACY_READ_ONLY'});
  const result=await collectFastAccounts(async cursor=>{
    calls.push(cursor);
    if(cursor===null) return page([{id:'legacy-unknown',source:'LEGACY_READ_ONLY'},listing('ordinary'),listing('fast','fast')],'p2');
    return page([{id:'legacy-unknown',source:'LEGACY_READ_ONLY'},{id:'legacy-fast',source:'LEGACY_READ_ONLY',rentalMode:'fast'}]);
  },projectHistory);
  assert.deepEqual(calls,[null,'p2']);
  assert.deepEqual(result.accounts.map(r=>r.id),['fast']);
  assert.deepEqual(result.historicalAccounts.map(r=>r.id),['legacy-unknown','legacy-fast']);
  assert.equal(result.historicalAccounts[0].rentalMode,null);
  assert.equal(result.historicalAccounts[1].rentalMode,'fast');
});

test('home does not claim exhaustion after clipping the last page or seeing a repeated server cursor',async()=>{
  const clipped=await collectFastAccounts(async()=>page(Array.from({length:10},(_,i)=>listing(String(i),'fast'))),project,4,8);
  assert.equal(clipped.accounts.length,8); assert.equal(clipped.hasMore,true);
  const loop=await collectFastAccounts(async()=>page([], 'same'),project);
  assert.equal(loop.pages,2); assert.equal(loop.hasMore,true);
});

test("FAST-REPAIR F2 LiveHome turns only explicit booleans into open/closed", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const require = createRequire(path.join(tree, "package.json"));
  const ts = require("typescript");
  const source = readFileSync(path.join(tree, "apps/web/src/components/home/live-home.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;

  async function loadFast(value, errorStatus) {
    let run;
    const values = [];
    class SupplyRequestError extends Error { constructor(status) { super("synthetic"); this.status = status; } }
    const mocks = {
      react: { useState: initial => [initial, next => values.push(next)], useEffect() {}, useCallback: fn => (run = fn) },
      "@/components/portal-home": { PortalHome: () => null },
      "@/components/content/home-announcement": { HomeAnnouncement: () => null },
      "@/lib/supply-client": { supplyApi: {
        games: async () => ({ games: [{ id: "synthetic" }] }),
        listingFilters: async () => ({ available: true }),
        publishingOptions: async () => { if (errorStatus) throw new SupplyRequestError(errorStatus); return value; },
      } },
      "@/lib/home-fast-accounts": { collectFastAccounts: async () => ({ accounts: [], historicalAccounts: [], hasMore: false }), HOME_FAST_MAX_PAGES: 3, HOME_FAST_DISPLAY_LIMIT: 4, HOME_FAST_PAGE_LIMIT: 50 },
      "@/lib/listing-filters": { listingQuery: () => ({}) },
      "@/lib/supply-games": { selectDeltaGame: games => games[0] },
    };
    const mod = { exports: {} };
    new Function("require", "module", "exports", code)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), mod, mod.exports);
    mod.exports.LiveHome();
    await run();
    return values.findLast(item => item && typeof item === "object" && "fastEnabled" in item)?.fastEnabled;
  }

  assert.equal(await loadFast({ rentalModes: { fast: { enabled: true } } }), true);
  assert.equal(await loadFast({ rentalModes: { fast: { enabled: false } } }), false);
  assert.equal(await loadFast({ pricingSchema: "haff-ratio-v2", rentalModes: {} }), null);
  assert.equal(await loadFast({ rentalModes: { fast: { enabled: "false" } } }), null);
  assert.equal(await loadFast(undefined, 404), null);
  assert.equal(await loadFast(undefined, 500), null);
});





/* --- Home Fast Mobile Behavior Tests --- */

import { canonicalResourceCode } from '../src/lib/listing-filters.ts';

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
