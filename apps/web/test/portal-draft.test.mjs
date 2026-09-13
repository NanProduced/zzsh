import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSavedTheme } from '../src/lib/theme.ts';
import { isPublicCount } from '../src/lib/public-activity.ts';
test('public counts accept zero and hide missing, invalid or unsafe values',()=>{
  for(const v of [0,12580]) assert.equal(isPublicCount(v),true);
  for(const v of [null,undefined,-1,NaN,Infinity,1.2,'20',Number.MAX_SAFE_INTEGER+1]) assert.equal(isPublicCount(v),false);
});

test('saved system preference and invalid values fall back to dark',()=>{
  for(const value of [null,'system','invalid','dark']) assert.equal(resolveSavedTheme(value),'dark');
  assert.equal(resolveSavedTheme('light'),'light');
});
