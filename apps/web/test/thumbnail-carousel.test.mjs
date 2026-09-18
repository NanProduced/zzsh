import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/ui/thumbnail-carousel.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
}).outputText;

function setup({ index = 1, itemCount = 3, width = 100 } = {}) {
  const effects = [];
  const xUpdates = [];
  const selected = [];
  const viewport = { offsetWidth: width };
  const thumbnails = { querySelector: () => ({ scrollIntoView() {} }) };
  const observers = [];
  const state = [false];
  let stateSlot = 0;
  let refSlot = 0;
  const x = { set: (value) => xUpdates.push(value) };
  const exports = {};
  const previousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  try {
    new Function('require', 'exports', 'React', code)(name => {
      if (name === 'react') {
        return {
          useEffect: callback => effects.push(callback),
          useRef: initial => ({ current: initial === null ? (refSlot++ === 0 ? viewport : thumbnails) : initial }),
          useState: initial => {
            const slot = stateSlot++;
            return [state[slot] ?? initial, value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
          },
        };
      }
      if (name === 'motion/react') {
        return {
          animate: () => ({ stop() {} }),
          motion: { div: 'div', button: 'button' },
          useMotionValue: () => x,
        };
      }
      if (name === 'lucide-react') {
        return { ChevronLeft: 'span', ChevronRight: 'span', ImageOff: 'span' };
      }
      if (name === 'react/jsx-runtime') return require('react/jsx-runtime');
      return require(name);
    }, exports, React);
    const tree = exports.ThumbnailCarousel({
      items: Array.from({ length: itemCount }, (_, itemIndex) => ({ id: `item-${itemIndex}`, src: `/item-${itemIndex}`, alt: `item ${itemIndex}` })),
      index,
      onIndexChange: value => selected.push(value),
    });
    effects.forEach(effect => effect());
    return { tree, effects, xUpdates, selected, observers, viewport, restore: () => { globalThis.ResizeObserver = previousResizeObserver; } };
  } catch (error) {
    globalThis.ResizeObserver = previousResizeObserver;
    throw error;
  }
}

test('thumbnail carousel resynchronizes the active slide after viewport resize', () => {
  const state = setup();
  assert.equal(state.observers.length, 1);
  state.xUpdates.length = 0;
  state.viewport.offsetWidth = 160;
  state.observers[0].callback();
  assert.deepEqual(state.xUpdates, [-160]);
  state.restore();
});

test('thumbnail carousel clamps a stale index when media list shrinks', () => {
  const state = setup({ index: 5, itemCount: 2 });
  assert.deepEqual(state.selected, [1]);
  state.restore();
});
