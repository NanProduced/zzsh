import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),require=createRequire(tree+'/package.json');
const React=require('react'),ts=require('typescript'),{Window}=require('happy-dom');
const file=tree+'/apps/web/src/components/order/order-account-dossier.tsx';
const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const listing=(id,faceIsSelf,banRecord)=>({id,displayNo:id,faceIsSelf,banRecord,conditionLines:[],media:[],skinTags:[]});
const deferred=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve};};

async function probe(read, initial) {
 const window=new Window({url:'http://127.0.0.1:4200/account'});
 Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,Event:window.Event,DOMException:window.DOMException,IS_REACT_ACT_ENVIRONMENT:true});
 const calls=[],m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);
 m.require=name=>{
  if(name==='next/link')return({children,scroll:_scroll,...props})=>React.createElement('a',props,children);
  if(name==='@zzsh/ui/legacy-account-image')return{LegacyAccountImage:props=>React.createElement('img',props)};
   if(name==='@zzsh/ui/account-media-placeholder')return{AccountMediaPlaceholder:props=>React.createElement('div',{'data-state':props.state})};
  if(name==='@/lib/supply-client')return{supplyApi:{listing:(id,signal)=>{calls.push(id);return read(id,signal);},lookupListing:()=>{throw Error('unlinked display number must not be looked up');}}};
  if(name==='@/lib/listing-view')return{toListingDetail:value=>value,haffMillionsLabel:require(tree+'/apps/web/src/lib/listing-view.ts').haffMillionsLabel};
  return require(name);
 };
 m._compile(compiled,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=require('react-dom/client').createRoot(host),commits=[];
 let props=initial;function Frame(){React.useLayoutEffect(()=>{commits.push({accountId:props.accountId,text:host.textContent});});return React.createElement(m.exports.OrderAccountDossier,props);}
 const settle=async()=>{for(let i=0;i<3;i++)await React.act(async()=>{await new Promise(setImmediate);});};
 return{host,calls,commits,async render(next=props){props=next;await React.act(async()=>root.render(React.createElement(Frame)));await settle();},async close(){await React.act(async()=>root.unmount());await window.happyDOM.abort();}};
}

test('current public account facts preserve declarations and unknown values',async()=>{
 for(const [face,ban,faceText,banText] of [[true,true,'号主声明本人脸','号主声明有封禁记录'],[false,false,'号主声明非本人脸','号主声明无封禁记录'],[null,null,'人脸声明未提供','封禁记录声明未提供']]){
  const p=await probe(async()=>listing('A',face,ban),{accountId:'A',party:'renter',listingFacts:{source:'ORDER_VERSION',attributeDisplay:{safeBox:'旧快照箱'}}});
  try{await p.render();assert.match(p.host.textContent,new RegExp(faceText));assert.match(p.host.textContent,new RegExp(banText));assert.match(p.host.textContent,/当前公开资料，不代表下单时快照/);assert.doesNotMatch(p.host.textContent,/人脸认证已审核|旧快照箱/);}finally{await p.close();}
 }
});

test('unlinked legacy order uses only its own snapshot and never searches a display number',async()=>{
 const p=await probe(async()=>{throw Error('unexpected listing read');},{accountId:null,accountDisplayNo:'123',party:'renter',listingFacts:{source:'LEGACY_ACCOUNT_SNAPSHOT',attributeDisplay:{safeBox:'旧箱'}}});
 try{await p.render();assert.equal(p.calls.length,0);assert.match(p.host.textContent,/旧箱/);assert.match(p.host.textContent,/当前账号资料（迁入时记录）/);}finally{await p.close();}
});

test('historical snapshot retains fractional million haff quantity',async()=>{
 const p=await probe(async()=>{throw Error('unexpected listing read');},{accountId:null,party:'renter',listingFacts:{source:'LEGACY_ACCOUNT_SNAPSHOT',attributeDisplay:{},resourceLines:[{code:'df_billable_haff',name:'哈夫币',unit:'HAFF_BASE',quantity:'1550000'}]}});
 try{await p.render();assert.match(p.host.textContent,/1\.55 M 哈夫币/);assert.doesNotMatch(p.host.textContent,/2 M 哈夫币/);}finally{await p.close();}
});

test('current public dossier displays current public resources rather than old order resources',async()=>{
 const current={...listing('A',null,null),resourceLines:[{itemId:'h',code:'df_billable_haff',name:'哈夫币',quantity:'3000000',quantityLabel:'3 M',unitLabel:'哈夫币'}]};
 const p=await probe(async()=>current,{accountId:'A',party:'renter',orderResources:[{code:'haff',name:'哈夫币',value:'90 M 哈夫币'}]});
 try{await p.render();assert.match(p.host.textContent,/当前公开账号资源/);assert.match(p.host.textContent,/3 M 哈夫币/);assert.doesNotMatch(p.host.textContent,/90 M 哈夫币/);}finally{await p.close();}
});

test('a different listing response cannot replace the order account',async()=>{
 const p=await probe(async()=>listing('OTHER',true,false),{accountId:'A',party:'renter',listingFacts:{source:'ORDER_VERSION',attributeDisplay:{safeBox:'原订单箱'}}});
 try{await p.render();assert.match(p.host.textContent,/原订单箱/);assert.doesNotMatch(p.host.textContent,/账号 OTHER|号主声明本人脸/);assert.equal(p.host.querySelector('.order-dossier-public-link'),null);}finally{await p.close();}
});

test('order participation alone links both actors to the public account view',async()=>{
 for(const party of ['owner','renter']){const p=await probe(async()=>listing('A',null,null),{accountId:'A',party});
  try{await p.render();assert.equal(p.host.querySelector('.order-dossier-public-link').getAttribute('href'),'/accounts/A');assert.doesNotMatch(p.host.textContent,/管理本人账号/);}finally{await p.close();}
 }
});

test('changing the linked account clears the previous dossier before the next read',async()=>{
 const gate=deferred(),p=await probe(id=>id==='A'?Promise.resolve(listing('A',true,false)):gate.promise,{accountId:'A',party:'renter'});
 try{await p.render();assert.match(p.host.textContent,/账号 A/);const mark=p.commits.length;await p.render({accountId:'B',party:'owner'});const first=p.commits.slice(mark).find(x=>x.accountId==='B');assert(first);assert.doesNotMatch(first.text,/账号 A/);assert.doesNotMatch(p.host.textContent,/账号 A/);}finally{gate.resolve(listing('B',null,null));await p.close();}
});
