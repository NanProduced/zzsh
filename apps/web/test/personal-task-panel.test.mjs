import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/hero/personal-task-panel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
function render(session) {
  const exports = {};
  new Function('require', 'exports', compiled)(name => {
    if (name === '../session/user-session-provider') return { useUserSession: () => session };
    if (name === '@/components/auth/auth-overlay-provider') return { useAuthOverlay: () => ({ open() {} }) };
    if (name === 'next/link') return { default: props => React.createElement('a', props) };
    return require(name);
  }, exports);
  return renderToStaticMarkup(React.createElement(exports.PersonalTaskPanel));
}

test('personal panel offers login without disclosing unconfirmed identity and preserves all action destinations', () => {
  for (const status of ['guest', 'loading', 'error']) {
    const html = render({ status, displayName: '不得泄露的旧身份' });
    assert.ok(html.includes('Hi~欢迎来到洲洲'));
    assert.match(html, /<button[^>]*class="b1-account-link"[^>]*>登录\/注册/);
    assert.ok(!html.includes('不得泄露的旧身份'));
    assert.ok(html.includes('我要租')); assert.ok(html.includes('我要上架')); assert.ok(!html.includes('b1-action-primary')); assert.ok(html.includes('rent-pass.webp')); assert.ok(html.includes('publish-stand.webp'));
    assert.ok(!html.includes('查看租赁任务与账号收藏'));
    for (const href of ['/accounts', '/publish', '/account?view=rentals', '/account?view=leased', '/account?view=accounts', '/account?view=favorites', '/help#rental-guide', '/help#publish-guide']) assert.ok(html.includes(`href="${href}"`));
  }
  const member = render({ status: 'authenticated', displayName: '测试用户' });
  assert.ok(member.includes('你好，测试用户'));
  assert.match(member, /href="\/account\?view=accounts"[^>]*>账户/);
  assert.ok(!member.includes('登录/注册'));
});

