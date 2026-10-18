import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Window} from 'happy-dom';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/notice/platform-stats.tsx',import.meta.url),'utf8');
const exports={};
new Function('require','exports',ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{
 if(name==='../effects/counter')return {default:()=>null};
 if(name==='../../lib/public-activity')return {isPublicCount:v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0};
 if(name.includes('components/ui/tooltip'))return {Tooltip:({children})=>React.createElement(React.Fragment,null,children),TooltipTrigger:({children})=>React.createElement(React.Fragment,null,children),TooltipContent:()=>null};
 return require(name);
},exports);
const render=props=>renderToStaticMarkup(React.createElement(exports.PlatformStats,props));
test('activity ribbon preserves zero/missing values, uses listing label and exposes demo disclosure only for demo data',()=>{
 const demo=render({data:{visits:0,transactions:150967,listings:3086},isDemo:true});
 assert.ok(demo.includes('当前上架账号'));assert.ok(!demo.includes('当前在售账号'));assert.ok(demo.includes('150,967'));assert.ok(demo.includes('3,086'));assert.match(demo,/>0<\/span>/);
 assert.ok(demo.includes('统计数据说明'));assert.ok(!demo.includes('stats-demo-label'));assert.ok(demo.includes('暂无可展示的成交信息'));
 const missing=render({});assert.ok(!missing.includes('统计数据说明'));assert.equal((missing.match(/数据暂未提供/g)||[]).length,3);
 const deal=render({deals:[{id:'1',game:'三角洲行动',title:'示例资源',priceLabel:'¥120'}]});assert.ok(deal.includes('示例资源'));assert.ok(deal.includes('¥120'));assert.ok(!deal.includes('暂无可展示的成交信息'));
});

test('transaction announcer has its own illustration rather than the assistance CTA asset',()=>{ const markup=render({}); assert.ok(markup.includes('/art/zhouzhou/deal-announcer.webp')); assert.ok(!markup.includes('/art/zhouzhou/cta-service.webp')); });

test('animated counts expose the formatted value as real text while rolling digits stay decorative',async()=>{
 const browser=new Window();
 try {
  for(const value of [0,14789,Number.MAX_SAFE_INTEGER]) {
   browser.document.body.innerHTML=renderToStaticMarkup(React.createElement(exports.RollingNumber,{value,reduced:false}));
   const number=browser.document.querySelector('.rolling-number');
   const readable=number.querySelector('.sr-only');
   assert.ok(readable,'animated counts need a readable text node, not a name on a generic span');
   assert.equal(readable.textContent,value.toLocaleString('en-US'));
   assert.equal(readable.closest('[aria-hidden="true"]'),null);
   assert.equal(number.querySelectorAll('.sr-only').length,1,'the value is exposed once');
   assert.equal(number.querySelector('.counter-groups').getAttribute('aria-hidden'),'true');
   assert.equal(number.hasAttribute('aria-label'),false);
   assert.equal(number.querySelector('[role="meter"],meter'),null,'counts are not bounded meters');
  }
 } finally { await browser.happyDOM.abort(); }
});

test('reduced-motion counts keep their plain value and invalid counts stay absent',()=>{
 for(const value of [0,14789]) {
  assert.equal(renderToStaticMarkup(React.createElement(exports.RollingNumber,{value,reduced:true})),`<span class="rolling-number" style="font-size:24px">${value.toLocaleString('en-US')}</span>`);
 }
 for(const value of [null,-1,0.5,Number.NaN,Number.MAX_SAFE_INTEGER+1]) {
  assert.equal(renderToStaticMarkup(React.createElement(exports.RollingNumber,{value,reduced:false})), '');
 }
});
