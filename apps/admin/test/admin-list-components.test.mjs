import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement, StrictMode, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = new Window({ url: 'http://127.0.0.1:4291/list-test' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent']) {
  globalThis[name] = name === 'window' ? browser : browser[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  root: rootPath,
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(rootPath, 'src'),
      '@brand': path.resolve(rootPath, '../../assets/brand'),
    },
  },
  server: { middlewareMode: true, hmr: false },
});

const {
  ListTable,
  ListToolbar,
  ListToolbarSearch,
  ListToolbarEnumSelect,
  ListToolbarApplied,
  ListToolbarActions,
  ListPagination,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} = await vite.ssrLoadModule('/src/components/admin-list/index.ts');

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function mountComponent(t, element) {
  const container = browser.document.createElement('div');
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    await settle();
  });
  act(() => root.render(createElement(StrictMode, null, element)));
  return { container };
}

test('ListPagination page mode: 0 items shows 暂无分页 with controls disabled', async (t) => {
  let pageChanged = 0;
  const { container } = mountComponent(
    t,
    createElement(ListPagination, {
      mode: 'page',
      page: 1,
      pageSize: 20,
      total: 0,
      loading: false,
      pageSizeOptions: [10, 20, 50],
      onPageChange: (p) => { pageChanged = p; },
      onPageSizeChange: () => {},
    })
  );
  await settle();

  const text = container.textContent;
  assert.ok(text.includes('共 0 位用户 · 暂无分页'), 'renders total 0 clean text');
  assert.equal(container.querySelector('[aria-label="页码列表"]'), null, 'no page navigation when total 0');
  assert.equal(pageChanged, 0);
});

test('ListPagination page mode: renders page window, ellipsis and boundary buttons', async (t) => {
  let page = 5;
  let size = 20;
  const changes = [];

  function ControlledPagination() {
    const [p, setP] = useState(page);
    return createElement(ListPagination, {
      mode: 'page',
      page: p,
      pageSize: size,
      total: 200, // 10 pages
      loading: false,
      pageSizeOptions: [10, 20, 50],
      loadedCount: 20,
      onPageChange: (next) => {
        changes.push(next);
        setP(next);
      },
      onPageSizeChange: () => {},
    });
  }

  const { container } = mountComponent(t, createElement(ControlledPagination));
  await settle();

  assert.ok(container.textContent.includes('第 5 / 10 页'));
  const page5Btn = container.querySelector('[aria-label="第 5 页"]');
  assert.ok(page5Btn);
  assert.equal(page5Btn.getAttribute('aria-current'), 'page');

  // Navigate to next
  const nextBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('下一页'));
  assert.ok(nextBtn);
  await act(async () => nextBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  await settle();
  assert.equal(changes.at(-1), 6);
  assert.ok(container.textContent.includes('第 6 / 10 页'));
});

test('ListPagination page mode: jump input rejects invalid inputs and accepts valid target', async (t) => {
  let page = 1;
  const changes = [];

  function ControlledPagination() {
    const [p, setP] = useState(page);
    return createElement(ListPagination, {
      mode: 'page',
      page: p,
      pageSize: 20,
      total: 60, // 3 pages
      loading: false,
      pageSizeOptions: [10, 20, 50],
      onPageChange: (next) => {
        changes.push(next);
        setP(next);
      },
      onPageSizeChange: () => {},
    });
  }

  const { container } = mountComponent(t, createElement(ControlledPagination));
  await settle();

  const jumpInput = container.querySelector('[aria-label="跳转页码"]');
  const jumpBtn = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === '跳转');
  assert.ok(jumpInput && jumpBtn);

  // Out of bounds jump: 5
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(jumpInput, '5');
    jumpInput.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await act(async () => jumpBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  await settle();
  assert.equal(changes.length, 0, 'no request fired on out of bounds jump');
  assert.ok(container.querySelector('.admin-list-pagination-error')?.textContent.includes('请输入 1 到 3 之间的页码'));

  // Valid jump: 3
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(jumpInput, '3');
    jumpInput.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await act(async () => jumpBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  await settle();
  assert.equal(changes.at(-1), 3);
  assert.equal(container.querySelector('.admin-list-pagination-error'), null);
});

test('ListPagination cursor mode: displays notice and handles prev/next cursor events', async (t) => {
  let prevCount = 0;
  let nextCount = 0;

  const { container } = mountComponent(
    t,
    createElement(ListPagination, {
      mode: 'cursor',
      pageSize: 20,
      loadedCount: 15,
      total: undefined,
      loading: false,
      pageSizeOptions: [10, 20, 50],
      hasPrevious: true,
      hasNext: true,
      onPrevious: () => { prevCount++; },
      onNext: () => { nextCount++; },
      onPageSizeChange: () => {},
    })
  );
  await settle();

  assert.ok(container.textContent.includes('当前服务暂未提供跳页能力'));
  assert.ok(container.textContent.includes('已加载 15 条 · 总数待更新'));
  assert.equal(container.querySelector('[aria-label="跳转页码"]'), null, 'no jump input in cursor mode');

  const prevBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('上一页'));
  const nextBtn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('下一页'));
  assert.equal(prevBtn.disabled, false);
  assert.equal(nextBtn.disabled, false);

  await act(async () => prevBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  assert.equal(prevCount, 1);

  await act(async () => nextBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  assert.equal(nextCount, 1);
});

test('MASTER: range uses received rows and navigation respects the API maximum',async t=>{
  const changes=[];
  const {container}=mountComponent(t,createElement(ListPagination,{mode:'page',page:2,pageSize:20,total:20_000_001,loadedCount:3,loading:false,pageSizeOptions:[10,20,50],onPageChange:p=>changes.push(p),onPageSizeChange:()=>{}}));
  await settle();
  assert.equal(container.querySelector('.admin-list-pagination-left span')?.getAttribute('title'),'第 21–23 位','received row range');
  const last=container.querySelector('[aria-label="末页"]');
  await act(async()=>last.dispatchEvent(new browser.MouseEvent('click',{bubbles:true})));
  assert.equal(changes.at(-1),1_000_000);
});

test('ListToolbar: handles search, reset and enum item mappings', async (t) => {
  let submitted = false;
  let reset = false;

  const { container } = mountComponent(
    t,
    createElement(
      ListToolbar,
      {
        onSubmit: () => { submitted = true; },
        onReset: () => { reset = true; },
      },
      createElement(ListToolbarSearch, {
        value: 'test',
        onChange: () => {},
        ariaLabel: '搜索测试',
      }),
      createElement(ListToolbarEnumSelect, {
        label: '测试状态',
        value: 'ACTIVE',
        onChange: () => {},
        options: [['ACTIVE', '正常状态'], ['RESTRICTED', '受限状态']],
      }),
      createElement(
        ListToolbarActions,
        null,
        createElement('button', { type: 'submit' }, '查询'),
        createElement('button', { type: 'button', onClick: () => reset = true }, '重置')
      )
    )
  );
  await settle();

  assert.ok(container.textContent.includes('正常状态'), 'Enum select renders Chinese label immediately');
  const queryBtn = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === '查询');
  const resetBtn = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === '重置');

  await act(async () => queryBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  assert.equal(submitted, true);

  await act(async () => resetBtn.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  assert.equal(reset, true);
});

test('ListTable: renders table wrap and re-exports table structure', async (t) => {
  const { container } = mountComponent(
    t,
    createElement(
      ListTable,
      { className: 'custom-table-wrap' },
      createElement(
        Table,
        null,
        createElement(
          TableHeader,
          null,
          createElement(TableRow, null, createElement(TableHead, null, '列A'))
        ),
        createElement(
          TableBody,
          null,
          createElement(TableRow, null, createElement(TableCell, null, '值1'))
        )
      )
    )
  );
  await settle();

  assert.ok(container.querySelector('.custom-table-wrap'));
  assert.ok(container.querySelector('[data-slot="admin-list-table-container"]'));
  assert.equal(container.querySelector('th').textContent, '列A');
  assert.equal(container.querySelector('td').textContent, '值1');
});
