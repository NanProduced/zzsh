import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire, Module} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const file=fileURLToPath(new URL('../src/components/hero/hero-carousel.tsx',import.meta.url));
const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(overrides={},resource=null){
 let index=0;const state=[false,true,0,{}, {},false,false,true,null,false];Object.assign(state,overrides);
 const effects=[],updates=[],calls=[],timers=[];const api={on(){},off(){},selectedScrollSnap:()=>0,scrollNext:()=>calls.push('next'),scrollPrev:()=>calls.push('prev'),scrollTo:i=>calls.push(i)};
 const exports={};
 new Function('require','exports','matchMedia','document','setInterval','clearInterval',code)(name=>{
  if(name==='react')return {...React,useEffect:fn=>effects.push(fn),useState:()=>{const slot=index++;return[state[slot],v=>updates.push([slot,v])];},useRef:v=>({current:v})};
  if(name==='../content/public-content-provider')return {usePublicContent:()=>({resource})};
  if(name==='embla-carousel-react')return {default:()=>[()=>{},api]};return require(name);
 },exports,()=>({matches:state[0],addEventListener(){},removeEventListener(){}}),{hidden:false,addEventListener(){},removeEventListener(){}},(fn,delay)=>{timers.push({fn,delay});return 1;},()=>{});
 const tree=exports.HeroCarousel();return {tree,effects,updates,calls,timers};
}
test('carousel keeps automatic rotation and manual controls without play/pause button',()=>{
 const p=setup();const html=renderToStaticMarkup(p.tree);assert.ok(!html.includes('data-autoplay-control'));assert.ok(html.includes('data-autoplay="true"'));assert.equal((html.match(/class="slide-index"/g)||[]).length,3);
 p.effects.forEach(fn=>fn());assert.equal(p.timers.length,1);assert.equal(p.timers[0].delay,5500);p.timers[0].fn();assert.deepEqual(p.calls,['next']);
 p.tree.props.onFocusCapture({});assert.ok(p.updates.some(([slot,v])=>slot===1&&v===false));
 const buttons=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);React.Children.forEach(node.props?.children,walk);}walk(p.tree);
 buttons.find(b=>b.props['aria-label']==='下一张幻灯片').props.onClick();assert.equal(p.calls.at(-1),'next');
 buttons.find(b=>b.props['aria-label']==='切换到幻灯片 3').props.onClick();assert.equal(p.calls.at(-1),2);
 for(const state of [{0:true},{5:true},{6:true},{7:false},{1:false}]){const q=setup(state);q.effects.forEach(fn=>fn());assert.equal(q.timers.length,0);}
});
test('fixed neutral posters preserve responsive images and code-owned links',()=>{
 const html=renderToStaticMarkup(setup().tree);assert.equal((html.match(/class="poster-sheet"/g)||[]).length,3);assert.ok(html.includes('洲洲商行 · 游戏账号服务'));assert.ok(html.includes('3 / 3'));assert.ok(!html.includes('交易返现'));assert.ok(html.includes('sizes="(max-width: 599px) 92vw, (max-width: 1023px) 476px, 804px"'));assert.ok(html.includes('/help#protection'));
});
const resource={payload:{kind:'carousel',slides:[{id:'delta',mediaId:'m1',mobileMediaId:'m2',title:'篡改标题',description:'篡改说明',imageAlt:'篡改alt',linkUrl:'/evil',enabled:false},{id:'unknown-old-id',mediaId:'m3'}]},media:[{id:'m1',url:'/api/content/media/m1/content'},{id:'m2',url:'/api/content/media/m2/content'},{id:'m3',url:'/api/content/media/m3/content'}]};
test('only images bind to fixed slot IDs; remote text, links and unknown legacy IDs cannot change the page',()=>{
 const p=setup({},resource);p.effects.forEach(fn=>fn());const slides=p.updates.find(([slot])=>slot===8)?.[1];assert.equal(slides.length,3);assert.deepEqual(slides.map(s=>s.id),['delta','protection','accounts']);assert.equal(slides[0].mediaUrl,'/api/content/media/m1/content');assert.equal(slides[1].kind,'default');
 const html=renderToStaticMarkup(setup({8:slides,9:true}).tree);assert.ok(html.includes('三角洲资源账号租赁，1 / 3'));assert.ok(html.includes('media="(max-width: 599px)"'));assert.ok(!html.includes('篡改'));assert.ok(!html.includes('/evil'));assert.ok(!html.includes('m3/content'));assert.ok(html.includes('href="#delta-section"'));
 const fallback=renderToStaticMarkup(setup({4:{delta:true},8:slides,9:true}).tree);assert.ok(!fallback.includes('<source'));
 const failedDesktop=renderToStaticMarkup(setup({3:{'/api/content/media/m1/content':true},8:slides}).tree);assert.ok(failedDesktop.includes('/art/zhouzhou/poster-delta.webp'));
});
test('replacing a picture preserves the users selected slide and fixed group',async t=>{
 const {Window}=require('happy-dom');const browser=new Window({url:'http://127.0.0.1:3100/'});Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
 browser.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});globalThis.matchMedia=browser.matchMedia;
 let selected=0,binding=null;const listeners=new Set();const api={on(n,fn){if(n==='select')listeners.add(fn)},off(n,fn){listeners.delete(fn)},selectedScrollSnap:()=>selected,scrollNext(){selected++;for(const fn of listeners)fn()},scrollPrev(){selected--;for(const fn of listeners)fn()},scrollTo(i){selected=i;for(const fn of listeners)fn()}};
 const native=createRequire(file),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m.require=name=>name==='../content/public-content-provider'?{usePublicContent:()=>({resource:binding})}:name==='embla-carousel-react'?{__esModule:true,default:()=>[()=>{},api]}:native(name);m._compile(code,file);
 const {createRoot}=require('react-dom/client');const host=document.createElement('div');document.body.append(host);const root=createRoot(host);t.after(async()=>{await React.act(async()=>root.unmount());await browser.happyDOM.abort()});
 const render=()=>root.render(React.createElement(m.exports.HeroCarousel));await React.act(async()=>render());await React.act(async()=>host.querySelector('[aria-label="下一张幻灯片"]').click());assert.equal(selected,1);
 binding=resource;await React.act(async()=>render());assert.equal(selected,1);assert.equal(host.querySelector('.hero-carousel').getAttribute('data-current-slide'),'2');assert.equal(host.querySelectorAll('.hero-slide').length,3);assert.equal(host.querySelector('.poster-sheet').getAttribute('src'),'/api/content/media/m1/content');
 binding={...resource,media:resource.media.map(row=>({...row,url:null}))};await React.act(async()=>render());assert.equal(host.querySelector('.hero-carousel').getAttribute('data-source'),'default');assert.equal(host.querySelectorAll('.hero-slide').length,3);
});
