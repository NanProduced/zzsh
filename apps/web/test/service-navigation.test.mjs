import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishMode, serviceLinks, publicContacts } from '../src/lib/service-navigation.ts';
test('rental discovery and two publishing modes have distinct destinations',()=>{
  assert.deepEqual(serviceLinks.map(s=>s.href),['/accounts','/publish','/publish?mode=fast']);
  assert.equal(publishMode('fast'),'fast');
  for(const v of [undefined,null,'other',['fast'],'FAST'])assert.equal(publishMode(v),'standard');
});
test('unconfigured contact panels cannot show invented identities or QR assets',()=>{
  for(const channel of Object.values(publicContacts)){assert.equal(channel.qrSrc,undefined);assert.equal(channel.handle,undefined);}
});


test('mobile sign-in waits for the sheet to release focus and returns to its trigger', async () => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const React = require('react'), ts = require('typescript');
  const code = ts.transpileModule(readFileSync(new URL('../src/components/layout/mobile-nav.tsx', import.meta.url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const refs = [], events = [], exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === 'react') return { ...React, useState: () => [true, () => {}], useEffect: () => {}, useRef: value => { const ref = { current: value }; refs.push(ref); return ref; } };
    if (name === '@radix-ui/react-dialog') return Object.fromEntries(['Root', 'Trigger', 'Portal', 'Overlay', 'Content', 'Close', 'Title', 'Description'].map(key => [key, key]));
    if (name.includes('auth-overlay-provider')) return { useAuthOverlay: () => ({ open: () => events.push('auth-open') }) };
    if (name.includes('user-session-provider')) return { useUserSession: () => ({ status: 'guest' }) };
    if (name.includes('service-navigation')) return { serviceLinks };
    if (name.includes('membership-growth-client')) return { readMyMembershipGrowth: () => Promise.resolve({ status: 'unknown' }) };
    if (name.includes('brand-logo')) return { BrandLogo: () => null };
    if (name === 'next/link') return { default: () => null };
    return require(name);
  }, exports);
  const root = exports.MobileNav();
  const content = root.props.children[1].props.children[1];
  const entry = content.props.children.find(child => typeof child.type === 'function' && child.props.onSignIn);
  const trigger = refs.find(ref => ref.current === null);
  trigger.current = { focus: () => events.push('trigger-focus') };
  const closeEvent = { preventDefault: () => events.push('prevent-default') };
  content.props.onCloseAutoFocus(closeEvent);
  assert.deepEqual(events, [], 'ordinary menu dismissal uses Radix default restoration');
  entry.type(entry.props).props.children.props.onClick();
  assert.deepEqual(events, [], 'sign-in cannot open alongside the closing sheet');
  content.props.onCloseAutoFocus(closeEvent);
  assert.deepEqual(events, ['prevent-default', 'trigger-focus', 'auth-open']);
  content.props.onCloseAutoFocus(closeEvent);
  assert.equal(events.filter(event => event === 'auth-open').length, 1, 'one handoff only');
});
