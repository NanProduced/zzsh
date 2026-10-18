import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire,Module} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toListingCard} from '../src/lib/listing-view.ts';
import {SupplyRequestError} from '../src/lib/supply-client.ts';
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),rq=createRequire(tree+'/package.json'),React=rq('react'),ts=rq('typescript'),{Window}=rq('happy-dom');
const fixture=(id='account-a',state='OFFLINE')=>({id,versionId:'version-a',displayNo:'AC0000000001',title:'公开标题',description:null,attributes:{},presentation:{items:[],skins:[],entitlements:[]},media:[],canCreateOrder:false,availability:{state},quote:{schemaVersion:1,currency:'CNY',ruleReleaseId:'release',lines:[],resourceTotal:{currency:'CNY',unit:'yuan',amount:'10.00',scale:2},tenantDeposit:null,tenantPayableTotal:null,termSeconds:'86400',expiryDisclosures:[],unitAmountsInformational:true}});
const tick=()=>new Promise(setImmediate);
async function probe(read){
 const window=new Window({url:'http://127.0.0.1:3100/accounts'});Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,Event:window.Event,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
 const file=tree+'/apps/web/src/components/market/exact-account-lookup.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);
 m.require=name=>name==='@/components/delta/account-card'?{AccountCard:({data})=>React.createElement('a',{'data-account-id':data.id,href:'/accounts/'+data.id},data.displayNo+' '+data.availabilityLabel)}:name==='@/lib/listing-view'?{toListingCard}:name==='@/lib/supply-client'?{supplyApi:{lookupListing:read},SupplyRequestError}:rq(name);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=rq('react-dom/client').createRoot(host);let game='game-a';
 const render=()=>React.act(async()=>root.render(React.createElement(m.exports.ExactAccountLookup,{gameId:game,initialNumber:'AC0000000001'})));
 await render();return{host,window,async submit(){await React.act(async()=>{host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await tick();});},async game(value){game=value;await render();},async settle(){await React.act(async()=>{await tick();});},async close(){await React.act(async()=>root.unmount());await window.happyDOM.abort();}};
}
test('exact lookup sends the full text and shows an identifiable read-only detail link',async()=>{
 let seen;const p=await probe(async(...args)=>{seen=args;return fixture();});try{await p.submit();assert.equal(seen[0],'AC0000000001');assert.equal(seen[1],'game-a');assert.equal(p.host.querySelector('a').getAttribute('href'),'/accounts/account-a');assert.match(p.host.textContent,/已下架/);assert.ok(!p.host.textContent.includes('立即下单'));}finally{await p.close();}
});
test('game/scope change cancels old requests and never commits their late result',async()=>{
 const resolvers=[];const p=await probe((number,game,signal)=>new Promise(resolve=>resolvers.push({resolve,signal})));try{await p.submit();await p.game('game-b');assert.equal(resolvers[0].signal.aborted,true);await p.submit();resolvers[1].resolve(fixture('new-account','RENTED'));await p.settle();resolvers[0].resolve(fixture('old-account'));await p.settle();assert.equal(p.host.querySelector('[data-account-id]').dataset.accountId,'new-account');assert.equal(p.host.querySelector('[data-account-id="old-account"]'),null);}finally{await p.close();}
});
test('revoked/ambiguous/error results clear the previous card and keep distinct recovery text',async()=>{
 for(const [status,text] of [[400,'编号格式未被接受'],[404,'未找到可公开查看'],[409,'无法唯一核定'],[503,'查找未完成']]){const p=await probe(async()=>{throw new SupplyRequestError(status,{error:{code:'CONFLICT',message:'fixture'}});});try{await p.submit();assert.equal(p.host.querySelector('[data-account-id]'),null);assert.match(p.host.textContent,new RegExp(text));}finally{await p.close();}}
});
