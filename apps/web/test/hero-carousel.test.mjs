import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/hero/hero-carousel.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(overrides={}){
 let index=0;const state=[false,true,0,false,false,false,true];Object.assign(state,overrides);
 const effects=[],updates=[],calls=[],timers=[];const api={on(){},off(){},selectedScrollSnap:()=>0,scrollNext:()=>calls.push('next'),scrollPrev:()=>calls.push('prev'),scrollTo:i=>calls.push(i)};
 const exports={};
 new Function('require','exports','matchMedia','document','setInterval','clearInterval',code)(name=>{
  if(name==='react')return {...React,useEffect:fn=>effects.push(fn),useState:()=>{const slot=index++;return[state[slot],v=>updates.push([slot,v])];},useRef:v=>({current:v})};
  if(name==='embla-carousel-react')return {default:()=>[()=>{},api]};return require(name);
 },exports,()=>({matches:state[0],addEventListener(){},removeEventListener(){}}),{hidden:false,addEventListener(){},removeEventListener(){}},(fn,delay)=>{timers.push({fn,delay});return 1;},()=>{});
 const tree=exports.HeroCarousel();return {tree,effects,updates,calls,timers};
}
test('carousel keeps automatic rotation and manual controls without play/pause button',()=>{
 const p=setup();const html=renderToStaticMarkup(p.tree);assert.ok(!html.includes('data-autoplay-control'));assert.ok(html.includes('data-autoplay="true"'));assert.equal((html.match(/class="slide-index"/g)||[]).length,5);
 p.effects.forEach(fn=>fn());assert.equal(p.timers.length,1);assert.equal(p.timers[0].delay,5500);p.timers[0].fn();assert.deepEqual(p.calls,['next']);
 p.tree.props.onFocusCapture({});assert.ok(p.updates.some(([slot,v])=>slot===1&&v===false));
 const buttons=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);React.Children.forEach(node.props?.children,walk);}walk(p.tree);
 buttons.find(b=>b.props['aria-label']==='下一张幻灯片').props.onClick();assert.equal(p.calls.at(-1),'next');
 buttons.find(b=>b.props['aria-label']==='切换到幻灯片 3').props.onClick();assert.equal(p.calls.at(-1),2);
 for(const state of [{0:true},{4:true},{5:true},{6:false},{1:false}]){const q=setup(state);q.effects.forEach(fn=>fn());assert.equal(q.timers.length,0);}
});

test("five complete posters keep correct copy and remove legacy foregrounds",()=>{ const html=renderToStaticMarkup(setup().tree); assert.equal((html.match(/class="poster-sheet"/g)||[]).length,5); assert.ok(!html.includes("hero-character")); assert.ok(html.includes("洲洲商行 · 游戏账号服务")); assert.ok(html.includes("5 / 5")); });

// X-R1-01: when the public carousel API arrives after manual navigation, the
// rebuilt engine and the React projection must agree (reviewer probe used the
// same index-preserving Embla fixture; installed Embla 8.6.0 reActivate keeps
// selectedScrollSnap as startIndex).
import {Module,createRequire as createRequire2}from 'node:module';
import path from 'node:path';
import {fileURLToPath as furl} from 'node:url';
function loadTs(file,overrides={}){const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const native=createRequire(file);m.require=name=>Object.hasOwn(overrides,name)?overrides[name]:native(name);m._compile(ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
function emblaFixture(){let selected=0;const listeners=new Set();const api={selected:()=>selected,on:(name,fn)=>{if(name==='select')listeners.add(fn);},off:(_n,fn)=>listeners.delete(fn),selectedScrollSnap:()=>selected,scrollNext(){selected++;for(const fn of listeners)fn();},scrollPrev(){selected--;for(const fn of listeners)fn();},scrollTo(i){selected=i;for(const fn of listeners)fn();},reInit(){for(const fn of listeners)fn();}};return{api,get selected(){return selected;}};}
async function mountHero(t,{fetchImpl,initialIndex=0}){
  const {Window}=createRequire(import.meta.url)('happy-dom');
  const browser=new Window({url:'http://127.0.0.1:3100/'});
  const cleanups=[];
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
  browser.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});globalThis.matchMedia=browser.matchMedia;
  const oldFetch=globalThis.fetch;globalThis.fetch=fetchImpl;cleanups.push(()=>{globalThis.fetch=oldFetch;});
  const fixture=emblaFixture();fixture.api.scrollTo(initialIndex);
  const hero=loadTs(furl(new URL('../src/components/hero/hero-carousel.tsx',import.meta.url)),{'embla-carousel-react':Object.assign(()=>[()=>{},fixture.api],{__esModule:true,default:()=>[()=>{},fixture.api]})});
  const {createRoot}=createRequire(import.meta.url)('react-dom/client');
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
  await React.act(async()=>root.render(React.createElement(hero.HeroCarousel)));
  t.after(async()=>{await React.act(async()=>root.unmount());host.remove();cleanups.forEach(fn=>fn());await browser.happyDOM.abort();});
  return{browser,host,fixture};
}
const apiSlides=n=>({items:Array.from({length:n},(_,i)=>({id:`api-${i}`,title:`API slide ${i+1}`,mediaUrl:`/api/content/media/m${i}/content`,linkUrl:'/help'}))});
test('X-R1-01: late API slides rebuild to a consistent engine/React index after manual navigation',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {host,fixture}=await mountHero(t,{fetchImpl:async()=>gate.then(()=>Response.json(apiSlides(2)))});
  assert.equal(host.querySelectorAll('.hero-slide').length,5);
  await React.act(async()=>host.querySelector('[aria-label="下一张幻灯片"]').click());
  assert.equal(fixture.selected,1);assert.equal(host.querySelector('.hero-carousel').getAttribute('data-current-slide'),'2');
  await React.act(async()=>{release();await gate;await new Promise(r=>setTimeout(r,0));});
  const carousel=host.querySelector('.hero-carousel');
  assert.equal(host.querySelectorAll('.hero-slide').length,2);
  assert.equal(fixture.selected,0,'engine actually moved to the first API slide');
  assert.equal(carousel.getAttribute('data-current-slide'),'1','React mirrors the engine');
  assert.equal(carousel.getAttribute('data-source'),'api');
  const slides=[...host.querySelectorAll('.hero-slide')];
  assert.equal(slides[0].getAttribute('aria-hidden'),'false');assert.equal(slides[0].hasAttribute('inert'),false);
  assert.equal(slides[1].getAttribute('aria-hidden'),'true');assert.equal(slides[1].hasAttribute('inert'),true);
  assert.equal(host.querySelector('[aria-label="切换到幻灯片 1"]').getAttribute('aria-current'),'true');
});
test('X-R1-01: an out-of-range manual index cannot survive an API rebuild',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {host,fixture}=await mountHero(t,{fetchImpl:async()=>gate.then(()=>Response.json(apiSlides(2)))});
  for(let i=0;i<4;i++)await React.act(async()=>host.querySelector('[aria-label="下一张幻灯片"]').click());
  assert.equal(fixture.selected,4);
  await React.act(async()=>{release();await gate;await new Promise(r=>setTimeout(r,0));});
  assert.equal(fixture.selected,0);assert.equal(host.querySelector('.hero-carousel').getAttribute('data-current-slide'),'1');
});
test('X-R1-01: missing, empty or failed carousel API keeps the brand default group',async t=>{
  for(const impl of [async()=>{throw new Error('offline');},async()=>Response.json({items:[]}),async()=>new Response('x',{status:503})]){
    const {host}=await mountHero(t,{fetchImpl:impl});
    await React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
    const carousel=host.querySelector('.hero-carousel');
    assert.equal(carousel.getAttribute('data-source'),'default');
    assert.equal(host.querySelectorAll('.hero-slide').length,5);
    assert.equal(carousel.getAttribute('data-current-slide'),'1');
  }
});
