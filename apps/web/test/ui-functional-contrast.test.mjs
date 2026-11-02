import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
const light = css.match(/html\[data-theme="light"\],\s*html:not\(\.dark\)\s*\{([\s\S]*?)\}/)[1];
const value = name => light.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))[1];
const luminance = color => {
  const [r, g, b] = color.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722;
};
const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

test('light functional text inks meet normal-text contrast without replacing brand or status fills', () => {
  for (const name of ['color-accent-brand-ink', 'color-status-success-ink', 'color-status-warning-ink', 'color-status-error-ink', 'color-status-info-ink']) {
    assert.ok(ratio(value(name), '#ffffff') >= 4.5, name);
    assert.ok(ratio(value(name), value('color-bg-canvas')) >= 4.5, `${name} on canvas`);
  }
  assert.match(css, /\.primary\s*\{\s*background:\s*var\(--color-accent-brand\);\s*color:\s*var\(--color-accent-brand-text\)/);
  assert.match(css, /--color-status-warning:\s*#f59e0b/);
  assert.ok(ratio(value('color-focus-ring'), '#ffffff') >= 3);
});

test('shared focus and actual error/payment text consume foreground tokens rather than bright fills', () => {
  const order = readFileSync(new URL('../src/components/order/order.css', import.meta.url), 'utf8');
  assert.match(order, /\.order-more-error\s*\{[^}]*color:\s*var\(--color-status-warning-ink\)/);
  assert.match(order, /\.order-stage-label\.is-action\s*\{[^}]*color:\s*var\(--color-accent-brand-ink\)/);
  assert.match(css, /button:focus-visible,[\s\S]*?outline:\s*2px solid var\(--color-focus-ring\)/);
});
