import { contentFixtureDependency } from "./content-fixture.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),rq=createRequire(tree+'/package.json'),React=rq('react'),ts=rq('typescript'),{Window}=rq('happy-dom');
function accountTitleHelpers(){const file=tree+'/apps/web/src/lib/account-title.ts',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='./listing-filters'||n==='./listing-filters.ts'||n==='@/lib/listing-filters'?{canonicalResourceCode:c=>({level6_armor:'df_billable_level6_armor',level6_helmet:'df_billable_level6_helmet',level6_round:'df_billable_level6_bullet',awm_round:'df_billable_awm_bullet',coffee:'df_billable_coffee'})[c]??c}:rq(n);m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
const accountTitle=accountTitleHelpers();
function cardHelpers(){const file=tree+'/apps/web/src/components/delta/account-card.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n==='@/lib/account-title'||n==='./account-title'?accountTitle:n.startsWith('@/')||n.startsWith('./')?{}:n==='next/link'?()=>null:rq(n);m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);return m.exports;}
// Radix selects its layout effect on the first account-card or HeroUI import.
const radixBootstrap=new Window();
Object.assign(globalThis,{window:radixBootstrap,document:radixBootstrap.document});
const card=cardHelpers();
const heroToast=await import('@heroui/react/toast');
await radixBootstrap.happyDOM.abort();
const Pass=props=>React.createElement(React.Fragment,null,props.children);
const tooltip={Tooltip:Pass,TooltipTrigger:Pass,TooltipContent:()=>null};
async function gallery(media){const window=new Window({url:'http://127.0.0.1:3100/accounts/example'});Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,DocumentFragment:window.DocumentFragment,MutationObserver:window.MutationObserver,ResizeObserver:window.ResizeObserver,requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window),CustomEvent:window.CustomEvent,NodeFilter:window.NodeFilter,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:window.getComputedStyle.bind(window)});Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:n==='next/link'?()=>null:rq(n);
 const source=fs.readFileSync(file,'utf8').replace('function DetailGallery(','export function DetailGallery(').replace('function entitlementExpiryLabel(','export function entitlementExpiryLabel(');m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=rq('react-dom/client').createRoot(host);await React.act(async()=>root.render(React.createElement(m.exports.DetailGallery,{title:'公开样本',media})));
 return{host,window,expiryLabel:m.exports.entitlementExpiryLabel,async click(label){const b=host.querySelector(`[aria-label="${label}"]`);assert.ok(b);await React.act(async()=>b.click());},async close(){await React.act(async()=>root.unmount());await window.happyDOM.abort();}};
}
test('mixed showcase/penalty uses one gallery collection and correct count/selection',async()=>{const p=await gallery([{assetId:'A',url:'/A.png',category:'SHOWCASE'},{assetId:'P',url:'/P.png',category:'PENALTY'},{assetId:'B',url:'/B.png',category:'SHOWCASE'}]);try{assert.equal(p.host.querySelectorAll('.detail-gallery-thumb').length,2);assert.match(p.host.querySelector('.detail-gallery-count').textContent,/1 \/ 2/);await p.click('选择第 2 张公开展示图');assert.equal(p.host.querySelector('.detail-gallery-main img').getAttribute('src'),'/B.png');assert.match(p.host.querySelector('.detail-gallery-count').textContent,/2 \/ 2/);assert.equal(p.host.querySelector('img[src="/P.png"]'),null);await React.act(async()=>p.host.querySelector('.detail-gallery-main img').dispatchEvent(new p.window.Event('error')));assert.match(p.host.textContent,/图片暂不可用/);await p.click('选择第 1 张公开展示图');assert.equal(p.host.querySelector('.detail-gallery-main img').getAttribute('src'),'/A.png');}finally{await p.close();}});
test('all-penalty and empty inputs have no misleading main gallery or thumbnails',async()=>{for(const media of [[],[{assetId:'P',url:'/P.png',category:'PENALTY'}]]){const p=await gallery(media);try{assert.equal(p.host.querySelector('.detail-gallery-main'),null);assert.equal(p.host.querySelectorAll('.detail-gallery-thumb').length,0);assert.match(p.host.textContent,/暂无可展示的图片/);}finally{await p.close();}}});

test('gallery arrows and keyboard select only showcase images; single image remains discoverable',async()=>{
 const p=await gallery([{assetId:'A',url:'/A.png',category:'SHOWCASE'},{assetId:'P',url:'/P.png',category:'PENALTY'},{assetId:'B',url:'/B.png',category:'SHOWCASE'}]);
 try{assert.equal(p.host.querySelector('[aria-label="上一张公开展示图"]').disabled,true);await p.click('下一张公开展示图');assert.equal(p.host.querySelector('.detail-gallery-main img').getAttribute('src'),'/B.png');assert.equal(p.host.querySelector('[aria-label="下一张公开展示图"]').disabled,true);await React.act(async()=>p.host.querySelector('.detail-gallery-main').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})));assert.equal(p.host.querySelector('.detail-gallery-main img').getAttribute('src'),'/A.png');assert.equal(p.host.querySelector('img[src="/P.png"]'),null);}finally{await p.close();}
 const single=await gallery([{assetId:'one',url:'/one.png',category:'SHOWCASE'}]);try{assert.equal(single.host.querySelectorAll('.detail-gallery-thumb').length,1);assert.equal(single.host.querySelector('.detail-gallery-thumb').getAttribute('aria-pressed'),'true');assert.ok(single.host.querySelector('.detail-gallery-thumbs'));assert.match(single.host.querySelector('.detail-gallery-count').textContent,/1 \/ 1/);assert.equal(single.host.querySelector('.detail-gallery-nav'),null);}finally{await single.close();}
});

test('entitlement expiry states do not turn missing disclosure into permanent',async()=>{
 const p=await gallery([]);try{const now=Date.parse('2026-10-09T12:00:00Z');assert.match(p.expiryLabel({expiresAt:null,expiryState:'MISSING'},now),/期限未提供/);assert.match(p.expiryLabel({expiresAt:null,expiryState:'PERMANENT'},now),/长期权益/);assert.match(p.expiryLabel({expiresAt:'2026-10-10T12:00:00Z',expiryState:'TIMED'},now),/到期/);assert.match(p.expiryLabel({expiresAt:'2026-10-08T12:00:00Z',expiryState:'TIMED'},now),/已到期/);}finally{await p.close();}
});

test('combined detail keeps rental version binding and remounts confirmation on identity change',async()=>{
 const window=new Window({url:'http://127.0.0.1:3100/accounts/example'});Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,DocumentFragment:window.DocumentFragment,MutationObserver:window.MutationObserver,ResizeObserver:window.ResizeObserver,requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window),CustomEvent:window.CustomEvent,NodeFilter:window.NodeFilter,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:window.getComputedStyle.bind(window)});Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
 let session={status:'authenticated',userId:'A'},mounts=0,lastProps;
 function Panel(props){lastProps=props;const [instance]=React.useState(()=>++mounts);return React.createElement('div',{'data-confirmation-instance':instance});}
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='@/components/order/rental-confirm-panel'?{RentalConfirmPanel:Panel}:n==='@/components/session/user-session-provider'?{useUserSession:()=>session}:n==='@/components/favorites/favorite-button'?{FavoriteButton:()=>null,FavoriteNotice:()=>null}:n==='@/components/ui/tooltip'?tooltip:n==='@/components/delta/login-method-icon'?{LoginMethodIcon:()=>null}:n==='@/components/delta/account-card'?{accountHref:card.accountHref,composeGridTitle:card.composeGridTitle,isHaff:()=>false,orderedQuoteResources:()=>[],skinChipTone:()=>'',moneyValue:(v,f)=>v??f}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:n==='next/link'?()=>null:rq(n);
 m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8').replace('function ReadyDetail(','export function ReadyDetail('),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=rq('react-dom/client').createRoot(host),data={id:'account',gameId:'game',versionId:'version',releaseId:'release',title:'combined',displayNo:'TEST',conditionLines:[],resourceLines:[],skinTags:[],media:[],entitlementNames:[],termLabel:'1天',resourceTotalLabel:'¥295.91',haffRentLabel:'¥256.41',itemResourceTotalLabel:'¥39.50'};
 const render=async()=>React.act(async()=>root.render(React.createElement(m.exports.ReadyDetail,{data,back:{href:'/',label:'返回'},activeAnchor:'detail-info'})));
  try{await render();assert.deepEqual(lastProps,{accountId:'account',gameId:'game',versionId:'version',releaseId:'release',fullPayoutSelected:false,reference:{total:'¥295.91',haff:'¥256.41',items:'¥39.50',lines:[],unitAmountsInformational:undefined}});assert.equal(mounts,1);await render();assert.equal(mounts,1);session={status:'authenticated',userId:'B'};await render();assert.equal(mounts,2);
   for(const label of ['已出租','待付款 · 暂不可租','已下架','暂不可租']){data.canCreateOrder=false;data.availabilityLabel=label;await render();assert.equal(host.querySelector('[data-confirmation-instance]'),null);assert.match(host.textContent,new RegExp(label));assert.match(host.textContent,/不是本人最终报价/);}
   delete data.canCreateOrder;delete data.availabilityLabel;data.historicalReadOnly=true;await render();assert.equal(host.querySelector('[data-confirmation-instance]'),null);assert.match(host.textContent,/暂不可租/);}finally{await React.act(async()=>root.unmount());await window.happyDOM.abort();}
});

test('detail presentation keeps fields unique, copy bound to public number, and unknown money honest', async () => {
 const window=new Window({url:'http://127.0.0.1:4220/accounts/a'});Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,DocumentFragment:window.DocumentFragment,MutationObserver:window.MutationObserver,ResizeObserver:window.ResizeObserver,requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window),CustomEvent:window.CustomEvent,NodeFilter:window.NodeFilter,IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:window.getComputedStyle.bind(window)});Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
 let copied=null;Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value=>{copied=value;}},configurable:true});
 const view=await import('../src/lib/listing-view.ts'), filters=await import('../src/lib/listing-filters.ts');
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);
 m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='next/link'?props=>React.createElement('a',props):n==='@/components/order/rental-confirm-panel'?{RentalConfirmPanel:props=>React.createElement('div',null,React.createElement('p',{className:'account-reference-price'},props.reference.total),React.createElement('button',null,'本人报价'))}:n==='@/components/session/user-session-provider'?{useUserSession:()=>({status:'guest'})}:n==='@/components/favorites/favorite-button'?{FavoriteButton:()=>null,FavoriteNotice:()=>null}:n==='@/lib/listing-view'?view:n==='@/lib/listing-filters'?filters:n==='@/components/ui/tooltip'?tooltip:n==='@/components/delta/login-method-icon'?{LoginMethodIcon:()=>null}:n==='@/components/delta/account-card'?{accountHref:card.accountHref,composeGridTitle:card.composeGridTitle,isHaff:l=>l.unitLabel==='哈夫币',orderedQuoteResources:d=>d.resourceLines.filter(l=>l.unitLabel!=='哈夫币'),skinChipTone:()=>'',moneyValue:v=>v??'待确认'}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:rq(n);
 const source=fs.readFileSync(file,'utf8').replace('function ReadyDetail(','export function ReadyDetail(');m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=rq('react-dom/client').createRoot(host);
 const line={itemId:'six',code:'level6_round',name:'六级子弹',quantity:'60',quantityLabel:'1组（60发）',unitLabel:'发',costAmount:'10.00',costLabel:'¥10.00',unitPriceLabel:'¥10.00000000 / 60 发'};
 const data={id:'a',title:'100M derived title',gameName:'三角洲行动',publicTitle:null,displayNo:null,publishedAt:'2026-10-08T07:33:16Z',resourceLines:[{...line,itemId:'haff',unitLabel:'哈夫币',quantity:'100000000',quantityLabel:'100 M',costAmount:'256.41'},line],conditionLines:[{key:'vit_level',value:'7级'},{key:'service_window',value:'00:00–24:00'},{key:'safe_box_code',value:'顶级安全箱(3*3)'},{key:'grading_code',value:'钻石'},{key:'character_level',value:'60级'}],skinTags:[],media:[],entitlementNames:[],resourceTotalLabel:'¥295.91',haffRentLabel:'¥256.41',itemResourceTotalLabel:'¥39.50',depositLabel:null,payableTotalLabel:null,termLabel:'10天',description:'Original public remark'};
 const render=()=>React.act(async()=>root.render(React.createElement(m.exports.ReadyDetail,{data,back:{href:'/accounts?game=g',label:'返回列表'}})));
 try {
  await render();
  assert.match(host.querySelector('.account-title-primary').textContent, /100M.*哈夫币/);
  assert.match(host.querySelector('.account-title-primary').textContent, /3×3安全箱/);
  assert.match(host.querySelector('.account-title-primary').textContent, /钻石/);
  assert.match(host.querySelector('.account-title-primary').textContent, /60级/);
  assert.match(host.querySelector('.account-title-primary').textContent, /体力7级/);
  assert.match(host.querySelector('.account-title-secondary').textContent, /1组六级弹/);
  assert.equal(host.querySelector('h1').classList.contains('sr-only'),false);
  assert.equal(host.querySelector('.account-identity time').textContent,'发布时间 2026-10-08 15:33');
  assert.equal(host.querySelector('.account-detail-info .account-number-row')!==null,true);
  assert.equal(host.querySelector('[aria-label="复制账号编号"]').disabled,true);
  assert.match(host.querySelector('.account-number-row').textContent,/待分配/);
  assert.equal(host.querySelectorAll('nav,[role="tablist"]').length,0);
  assert.equal(host.querySelectorAll('.account-summary-conditions > div').length,4);
  for(const label of ['上号方式','每日消耗','推算租期','配合上号','安全箱','体力','负重','游戏段位','角色等级'])assert.equal([...host.querySelectorAll('dt')].filter(n=>n.textContent.includes(label)).length,1);
  assert.equal(host.querySelectorAll('.account-reference-price').length,1);
  assert.equal(host.querySelectorAll('.account-stock-grid .account-stock-card').length,1);
  assert.equal(host.querySelector('.account-reference-price').textContent,'¥295.91');
  assert.ok(!host.textContent.includes('无需押金'));
  assert.ok(!host.textContent.includes('支付与订单功能尚未开放'));
  assert.match(host.textContent,/Original public remark/);
  assert.ok(!host.textContent.includes('100M derived title'));
  const overview=host.querySelector('.account-overview'),conditions=host.querySelector('.account-detail-conditions'),quote=host.querySelector('.account-quote');
  assert.ok(overview.compareDocumentPosition(conditions)&window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(conditions.compareDocumentPosition(quote)&window.Node.DOCUMENT_POSITION_FOLLOWING,'resource and usage facts precede quote in DOM order');
  assert.match(host.querySelector('.account-capabilities').textContent,/(?:3×3.*顶级安全箱|顶级安全箱.*3×3).*7级.*未提供/);
  assert.equal(host.querySelectorAll('.account-detail-gallery--empty .detail-gallery--empty').length,1);
  assert.equal(host.querySelector('.account-detail-gallery .detail-image-fallback'),null,'missing media has no large failed-image frame');
  assert.equal(host.querySelector('.account-detail-gallery .account-media-caption'),null,'missing image message is not duplicated');
  assert.equal(m.exports.unitPriceText(line),'¥10 / 组');assert.equal(m.exports.unitPriceText({...line,code:'df_billable_top_insure_card',unitPriceLabel:'¥5.00000000 / 1 天'}),'¥5 / 天');assert.equal(m.exports.unitPriceText({...line,code:'df_billable_barrett_bullet',unitPriceLabel:'¥0.50000000 / 1 发'}),'¥0.5 / 发');assert.equal(m.exports.unitPriceText({...line,unitPriceLabel:null}),'未确认');
  assert.equal(host.querySelector('.account-detail-deal'),null);data.rentalMode='fast';await render();assert.match(host.querySelector('.account-detail-deal').textContent,/特惠.*极速出租/);data.rentalMode='ordinary';await render();assert.equal(host.querySelector('.account-detail-deal'),null);
  assert.ok(!host.textContent.includes('7×24'));assert.ok(!host.textContent.includes('已审核'));assert.ok(!host.textContent.includes('资金安全'));
  await React.act(async()=>host.querySelector('.account-share').click());assert.equal(copied,'http://127.0.0.1:4220/accounts/a');assert.equal(host.querySelector('.account-link-notice'),null);assert.match(window.document.querySelector('.account-copy-feedback').textContent,/链接已复制/);
  data.id='other';await render();assert.equal(host.querySelector('.account-link-notice'),null);data.id='a';data.resourceTotalLabel=null;await render();assert.equal(host.querySelector('.account-reference-price').textContent,'待确认');data.resourceTotalLabel='¥295.91';
  data.displayNo='202610080194';await render();assert.equal(host.querySelector('[aria-label="复制账号编号"]').disabled,false);await React.act(async()=>host.querySelector('[aria-label="复制账号编号"]').click());assert.equal(copied,'202610080194');assert.match(window.document.querySelector('.account-copy-feedback').textContent,/账号编号已复制/);
  data.id='b';data.displayNo=null;await render();assert.equal(host.querySelector('[aria-label="复制账号编号"]').disabled,true);assert.equal(host.querySelector('.account-copy-note'),null);
  data.historicalReadOnly=true;data.rentalMode='fast';data.sourceUpdatedAt='2026-09-13T13:31:22.000Z';data.depositLabel='¥50.00';await render();
  assert.ok(host.textContent.includes('暂不可租'));
  assert.ok(host.textContent.includes('押金记录'));assert.ok(host.textContent.includes('¥50.00'));
  assert.ok(host.textContent.includes('来源更新时间 2026-09-13 21:31'));
  assert.equal(host.querySelector('.account-detail-deal'),null);
  assert.ok(![...host.querySelectorAll('button')].some(b=>b.textContent==='本人报价'));
  assert.equal(host.querySelector('.account-detail-status').textContent,'资料暂不可租');
  const zero={...line,itemId:'zero',name:'零库存',quantity:'0',quantityLabel:'0发',costLabel:null,unitPriceLabel:null};
  const unknown={...line,itemId:'unknown',name:'未知库存',quantity:null,quantityLabel:'未提供',costLabel:null,unitPriceLabel:null};
  data.resourceLines.push(zero,unknown);await render();
  assert.equal(host.querySelector('[data-resource-id="zero"] dd').textContent,'0组（0发）');
  assert.equal(host.querySelector('[data-resource-id="unknown"] dd').textContent,'未提供');
  assert.equal(host.querySelectorAll('.account-resource-quantities > div').length,3);
  assert.equal(host.querySelector('.account-reference-price').textContent,'¥295.91','summary never recomputes price from inventory');
  data.resourceLines=[];data.conditionLines=[];data.publicTitle='原公开标题';await render();assert.equal(host.querySelector('h1').textContent,'原公开标题');
  assert.match(host.querySelector('.account-stock').textContent,/尚未申报可展示的物资库存/);
  assert.ok(!host.textContent.includes('号主本人脸'), 'face recognition must not default to owner when undeclared');
  assert.ok(!host.textContent.includes('无处罚记录'), 'penalty must not default to no-record when undeclared');
  assert.ok(host.textContent.includes('未提供'));
 } finally {await React.act(async()=>root.unmount());await window.happyDOM.abort();}
});

test('SK6-R1-04 withheld skin note states a count without claiming a reason',()=>{
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',source=fs.readFileSync(file,'utf8'),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:n==='next/link'?()=>null:rq(n);
 m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const note=m.exports.withheldSkinsNote;assert.equal(typeof note,'function');
 assert.equal(note(2),'另有 2 项已申报皮肤当前未公开展示。');
 for(const bad of [0,-1,1.5,undefined,null,'2'])assert.equal(note(bad),null);
 assert.doesNotMatch(source,/待平台核实名称/,'a disabled or category-hidden verified skin is not an unverified name');
});

test('rank parser handles peak and known subranks without guessing for unknown', async () => {
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',source=fs.readFileSync(file,'utf8'),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:n==='next/link'?()=>null:rq(n);
 m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const { parseRank } = m.exports;
 assert.deepEqual(parseRank('巅峰'), { text: '巅峰', iconSrc: '/art/delta/ranks/peak.webp' });
 assert.deepEqual(parseRank('黄金4'), { text: '黄金IV', iconSrc: '/art/delta/ranks/gold-4.webp' });
 assert.deepEqual(parseRank('钻石V'), { text: '钻石V', iconSrc: '/art/delta/ranks/diamond-5.webp' });
 assert.deepEqual(parseRank('黑鹰1'), { text: '黑鹰I', iconSrc: '/art/delta/ranks/blackhawk-1.webp' });
 assert.deepEqual(parseRank('黄金'), { text: '黄金 · 小段位未提供' });
 assert.equal(parseRank('黄金').iconSrc, undefined, 'unknown subrank does not default to division 1 or 3');
 assert.deepEqual(parseRank(''), { text: '未提供' });
 assert.deepEqual(parseRank(null), { text: '未提供' });
});

test('supply item formatting distinguishes real 0 from null/unknown', async () => {
 const filters=await import('../src/lib/listing-filters.ts'), view=await import('../src/lib/listing-view.ts');
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',source=fs.readFileSync(file,'utf8'),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='@/lib/listing-filters'?filters:n==='@/lib/listing-view'?view:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:n==='next/link'?()=>null:rq(n);
 m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const { formatSupplyItem } = m.exports;
 const sixBullet = { itemId: '1', code: 'df_billable_level6_bullet', name: '六级子弹', quantity: '120', quantityLabel: '2组（120发）', unitLabel: '发', costAmount: '20', costLabel: '¥20' };
 assert.equal(formatSupplyItem(sixBullet).quantityText, '2组（120发）');
 assert.equal(formatSupplyItem(sixBullet).imageSrc, '/art/delta/items/level6-ammo.png');
 assert.equal(formatSupplyItem({ ...sixBullet, quantity: '0' }).quantityText, '0组（0发）');
 assert.equal(formatSupplyItem({ ...sixBullet, quantity: '0' }).isZero, true);
 assert.equal(formatSupplyItem({ ...sixBullet, quantity: null }).quantityText, '未提供');
 assert.equal(formatSupplyItem({ ...sixBullet, quantity: null }).isUnknown, true);

 const awm = { itemId: '2', code: 'df_billable_awm_bullet', name: 'AWM子弹', quantity: '10', quantityLabel: '10发', unitLabel: '发', costAmount: '5', costLabel: '¥5' };
 assert.equal(formatSupplyItem(awm).quantityText, '10发');
 assert.equal(formatSupplyItem(awm).imageSrc, '/art/delta/items/awm-ammo.png');
 assert.equal(formatSupplyItem({ ...awm, quantity: '0' }).quantityText, '0发');
 assert.equal(formatSupplyItem({ ...awm, quantity: null }).quantityText, '未提供');

 const card = { itemId: '3', code: 'df_billable_top_insure_card', name: '九格保险体验卡', quantity: '2', quantityLabel: '2天', unitLabel: '天', costAmount: '8', costLabel: '¥8' };
 assert.equal(formatSupplyItem(card).quantityText, '2天');
 assert.equal(formatSupplyItem(card).imageSrc, '/art/delta/items/insurance-experience-card-thumb.png');

 const pieceCard = { itemId: '3b', code: 'top_insure_card_piece', name: '九格保险体验卡', quantity: '2', quantityLabel: '2张', unitLabel: '张', costAmount: '8', costLabel: '¥8' };
 assert.equal(formatSupplyItem(pieceCard).quantityText, '2张');
 assert.equal(formatSupplyItem(pieceCard).imageSrc, '/art/delta/items/insurance-experience-card-thumb.png');

 const pack = { itemId: '4', code: 'df_billable_turtle_backpack_45', name: '45格乌龟包', quantity: '3', quantityLabel: '3个', unitLabel: '个', costAmount: '30', costLabel: '¥30' };
 assert.equal(formatSupplyItem(pack).quantityText, '3个');
 assert.equal(formatSupplyItem(pack).imageSrc, '/art/delta/items/turtle-backpack-45.png');
});

const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function pendingResult(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function feedbackFixture(writeText){
 const window=new Window({url:'http://127.0.0.1:4220/accounts/feedback-a'});
 Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,DocumentFragment:window.DocumentFragment,MutationObserver:window.MutationObserver,ResizeObserver:window.ResizeObserver,CustomEvent:window.CustomEvent,Event:window.Event,MouseEvent:window.MouseEvent,NodeFilter:window.NodeFilter,requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window),IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:window.getComputedStyle.bind(window)});
 Object.defineProperty(globalThis,'navigator',{value:window.navigator,configurable:true});
 Object.defineProperty(window.navigator,'clipboard',{value:writeText===undefined?undefined:{writeText},configurable:true});
 const view=await import('../src/lib/listing-view.ts'),filters=await import('../src/lib/listing-filters.ts');
 const file=tree+'/apps/web/src/components/market/listing-detail.tsx',m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(tree);
 m.require=n=>n==='@heroui/react/toast'?heroToast:n.endsWith('.css')?{}:n==='next/link'?props=>React.createElement('a',props):n==='@/components/order/rental-confirm-panel'?{RentalConfirmPanel:()=>null}:n==='@/components/session/user-session-provider'?{useUserSession:()=>({status:'guest'})}:n==='@/components/favorites/favorite-button'?{FavoriteButton:()=>null,FavoriteNotice:()=>null}:n==='@/lib/listing-view'?view:n==='@/lib/listing-filters'?filters:n==='@/components/ui/tooltip'?tooltip:n==='@/components/delta/account-card'?{accountHref:card.accountHref,isHaff:()=>false,orderedQuoteResources:d=>d.resourceLines,moneyValue:v=>v??'待确认'}:n==='@/lib/account-title'?accountTitle:n.startsWith('@/')?{}:rq(n);
 const source=fs.readFileSync(file,'utf8').replace('function ReadyDetail(','export function ReadyDetail(');m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 const host=window.document.createElement('div');window.document.body.append(host);const root=rq('react-dom/client').createRoot(host);
 let data={id:'feedback-a',displayNo:'ZZ_TEST_A',publicTitle:'公开测试账号',gameName:'三角洲行动',publishedAt:'2026-10-25T00:00:00Z',resourceLines:[],conditionLines:[],skinTags:[],media:[],entitlementNames:[],resourceTotalLabel:null,haffRentLabel:null,itemResourceTotalLabel:null,depositLabel:null,payableTotalLabel:null,description:null},mounted=true;
 const render=async(patch={})=>{data={...data,...patch};await React.act(async()=>{root.render(React.createElement(m.exports.ReadyDetail,{data}));await nextTurn();});};
 const button=action=>host.querySelector(action==='number'?'[aria-label="复制账号编号"]':'.account-share');
 const click=async action=>{await React.act(async()=>{button(action).click();await nextTurn();});};
 const settle=async action=>{await React.act(async()=>{action();await nextTurn();});};
 const text=()=>window.document.querySelector('.account-copy-feedback')?.textContent??'';
 const unmount=async()=>{if(mounted){await React.act(async()=>root.unmount());mounted=false;}};
 const close=async()=>{await unmount();await window.happyDOM.abort();};
 await render();
 return{window,host,button,click,settle,render,text,unmount,close};
}

test('B1 copy feedback waits for success, expires after two seconds and restores the icon without moving focus',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const gate=pendingResult(),calls=[];const p=await feedbackFixture(text=>{calls.push(text);return gate.promise;});
 try{
  p.button('number').focus();await p.click('number');
  assert.deepEqual(calls,['ZZ_TEST_A']);assert.equal(p.text(),'');assert.equal(p.button('number').querySelector('.lucide-check'),null);
  await p.settle(()=>gate.resolve());
  assert.match(p.text(),/账号编号已复制/);assert.ok(p.button('number').querySelector('.lucide-check'));
  assert.equal(p.button('number').textContent,'复制');assert.equal(p.window.document.activeElement,p.button('number'));
  assert.equal(p.host.querySelector('.account-copy-feedback'),null,'the real Toast region is portalled outside the page layout');
  assert.equal(p.host.querySelector('.account-copy-note,.account-link-notice'),null);
  await p.settle(()=>context.mock.timers.tick(1000));assert.match(p.text(),/账号编号已复制/);
  await p.settle(()=>context.mock.timers.tick(1100));assert.equal(p.text(),'');assert.ok(p.button('number').querySelector('.lucide-copy'));assert.equal(p.button('number').querySelector('.lucide-check'),null);
  assert.equal(p.window.document.activeElement,p.button('number'));
 }finally{await p.close();context.mock.timers.reset();}
});

test('B1 alternating copy and share replaces one feedback and the old deadline cannot dismiss the new one',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const calls=[],p=await feedbackFixture(async text=>{calls.push(text);});
 try{
  await p.click('number');await p.settle(()=>context.mock.timers.tick(1000));
  await p.click('link');assert.deepEqual(calls,['ZZ_TEST_A','http://127.0.0.1:4220/accounts/feedback-a']);
  assert.match(p.text(),/链接已复制/);assert.ok(!p.text().includes('账号编号已复制'));
  assert.equal(p.button('link').textContent.trim(),'分享');assert.ok(p.button('link').querySelector('.lucide-check'));assert.ok(p.button('number').querySelector('.lucide-copy'));
  await p.settle(()=>context.mock.timers.tick(1100));assert.match(p.text(),/链接已复制/,'the first copy deadline has elapsed but the latest feedback remains');
  await p.settle(()=>context.mock.timers.tick(1000));assert.equal(p.text(),'');assert.ok(p.button('link').querySelector('.lucide-share-2'));
 }finally{await p.close();context.mock.timers.reset();}
});

test('B1 duplicate pending writes are deduplicated and a late older action does not replace the latest feedback',async()=>{
 const number=pendingResult(),link=pendingResult(),calls=[];
 const p=await feedbackFixture(text=>{calls.push(text);return text.startsWith('http')?link.promise:number.promise;});
 try{
  await p.click('number');await p.click('number');assert.equal(calls.length,1,'same pending action must not write twice');
  await p.click('link');await p.click('link');assert.equal(calls.length,2);
  await p.settle(()=>link.resolve());assert.match(p.text(),/链接已复制/);
  await p.settle(()=>number.resolve());assert.match(p.text(),/链接已复制/);assert.ok(!p.text().includes('账号编号已复制'));assert.ok(p.button('number').querySelector('.lucide-copy'));
 }finally{await p.close();}
});

test('B1 target switch discards a late result and lets the new target start its own copy',async()=>{
 const gates=[pendingResult(),pendingResult()],calls=[];
 const p=await feedbackFixture(text=>{calls.push(text);return gates[calls.length-1].promise;});
 try{
  await p.click('number');await p.render({id:'feedback-b',displayNo:'ZZ_TEST_B'});assert.equal(p.text(),'');
  await p.click('number');assert.deepEqual(calls,['ZZ_TEST_A','ZZ_TEST_B']);
  await p.settle(()=>gates[0].resolve());assert.equal(p.text(),'');
  await p.settle(()=>gates[1].resolve());assert.match(p.text(),/账号编号已复制/);assert.ok(p.button('number').querySelector('.lucide-check'));
 }finally{await p.close();}
});

test('B1 unmount clears current feedback and ignores a pending completion',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const gate=pendingResult(),p=await feedbackFixture(()=>gate.promise);
 try{
  await p.click('link');await p.unmount();await p.settle(()=>gate.resolve());
  await p.settle(()=>context.mock.timers.tick(3000));assert.equal(p.window.document.querySelector('.account-copy-feedback'),null);
 }finally{await p.close();context.mock.timers.reset();}
});

for(const [name,writeText] of [['denied',async()=>{throw new Error('OFFLINE_CLIPBOARD_DENIED');}],['unavailable',undefined]]){
 test(`B1 ${name} clipboard gives honest feedback and never sets the copied icon`,async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});const p=await feedbackFixture(writeText);
  try{
   await p.click('number');assert.match(p.text(),/未成功.*编号.*手动复制/);assert.equal(p.button('number').querySelector('.lucide-check'),null);
   await p.click('link');assert.match(p.text(),/未成功.*地址栏/);assert.ok(!p.text().includes('账号编号已复制'));assert.equal(p.button('link').querySelector('.lucide-check'),null);
   await p.settle(()=>context.mock.timers.tick(2100));assert.equal(p.text(),'');
  }finally{await p.close();context.mock.timers.reset();}
 });
}

test('B2 deriveDetailTitle builds primary segments (haff, safebox, rank, level) and secondary segments', async () => {
  const view = await import('../src/lib/listing-view.ts'), filters = await import('../src/lib/listing-filters.ts');
  const file = tree + '/apps/web/src/components/market/listing-detail.tsx';
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(tree);
  m.require = n => n === '@heroui/react/toast' ? heroToast : n.endsWith('.css') ? {} : n === '@/lib/listing-view' ? view : n === '@/lib/listing-filters' ? filters : n === '@/lib/account-title' ? accountTitle : n === '@/components/delta/account-card' ? { accountHref: card.accountHref, composeGridTitle: card.composeGridTitle, isHaff: l => l.unitLabel === '哈夫币', orderedQuoteResources: d => d.resourceLines.filter(l => l.unitLabel !== '哈夫币'), skinChipTone: () => '', moneyValue: v => v ?? '待确认' } : n.startsWith('@/') ? {} : n === 'next/link' ? () => null : rq(n);
  const source = fs.readFileSync(file, 'utf8');
  m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  const { deriveDetailTitle, parseSafeBox } = m.exports;

  // 1. Real 90M sample account
  const sampleData = {
    id: 'sample-90m',
    publicTitle: '三角洲行动高配号',
    resourceLines: [
      { itemId: 'h1', code: 'haff_coin', name: '哈夫币', quantity: '90000000', quantityLabel: '90M', unitLabel: '哈夫币' },
      { itemId: 'r1', code: 'df_billable_level6_armor', name: '六级护甲', quantity: '5', quantityLabel: '5件', unitLabel: '件' },
      { itemId: 'r2', code: 'df_billable_level6_helmet', name: '六级头盔', quantity: '6', quantityLabel: '6件', unitLabel: '件' },
      { itemId: 'r3', code: 'df_billable_awm_bullet', name: 'AWM子弹', quantity: '11', quantityLabel: '11发', unitLabel: '发' },
    ],
    conditionLines: [
      { key: 'safe_box_code', value: '1*2 2格安全箱' },
      { key: 'grading_code', value: '黄金' },
      { key: 'character_level', value: '60级' },
      { key: 'vit_level', value: '4级' },
      { key: 'bear_level', value: '4级' },
    ],
    skinTags: [],
    media: [],
  };

  const title1 = deriveDetailTitle(sampleData);
  assert.equal(title1.primary, '90M 哈夫币 · 1×2安全箱 · 黄金 · 60级 · 体力4级 · 负重4级');
  assert.equal(title1.secondary, '5六甲 · 6六头 · 11发AWM');

  // 2. Peak rank without subrank
  const peakData = {
    id: 'sample-peak',
    resourceLines: [{ itemId: 'h1', code: 'haff_coin', name: '哈夫币', quantity: '50000000', quantityLabel: '50M', unitLabel: '哈夫币' }],
    conditionLines: [{ key: 'grading_code', value: '巅峰' }],
    skinTags: [],
    media: [],
  };
  const title2 = deriveDetailTitle(peakData);
  assert.equal(title2.primary, '50M 哈夫币 · 巅峰');

  // 3. Known subrank with Roman numeral (e.g. 黄金4 -> 黄金IV)
  const subrankData = {
    id: 'sample-subrank',
    resourceLines: [],
    conditionLines: [{ key: 'grading_code', value: '黄金4' }, { key: 'safe_box_code', value: '3*3 顶级安全箱' }],
    skinTags: [],
    media: [],
  };
  const title3 = deriveDetailTitle(subrankData);
  assert.equal(title3.primary, '3×3安全箱 · 黄金IV');

  // 4. Fallback when all attributes missing
  const fallbackData = {
    id: 'sample-empty',
    publicTitle: '备用公开标题',
    resourceLines: [],
    conditionLines: [],
    skinTags: [],
    media: [],
  };
  const title4 = deriveDetailTitle(fallbackData);
  assert.equal(title4.primary, '备用公开标题');
  assert.equal(title4.secondary, '');

  // 5. parseSafeBox tests
  assert.deepEqual(parseSafeBox('1*2 2格安全箱'), { size: '1×2', name: '2格安全箱', full: '1×2 2格安全箱' });
  assert.deepEqual(parseSafeBox('3*3安全箱'), { size: '3×3', name: null, full: '3×3安全箱' });
  assert.deepEqual(parseSafeBox('顶级安全箱(3*3)'), { size: '3×3', name: '顶级安全箱', full: '顶级安全箱(3×3)' });
  assert.deepEqual(parseSafeBox('未提供'), { size: null, name: null, full: '未提供' });
  assert.deepEqual(parseSafeBox(null), { size: null, name: null, full: '未提供' });
});

test('B2 hero attributes retain label-on-top values, safebox prominence and the separate account declarations', async () => {
  const window = new Window({ url: 'http://127.0.0.1:4220/accounts/b2-test' });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), CustomEvent: window.CustomEvent, NodeFilter: window.NodeFilter, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: window.getComputedStyle.bind(window) });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

  const view = await import('../src/lib/listing-view.ts'), filters = await import('../src/lib/listing-filters.ts');
  const file = tree + '/apps/web/src/components/market/listing-detail.tsx';
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(tree);
  m.require = n => n === '@heroui/react/toast' ? heroToast : n.endsWith('.css') ? {} : n === 'next/link' ? props => React.createElement('a', props) : n === '@/components/order/rental-confirm-panel' ? { RentalConfirmPanel: () => null } : n === '@/components/session/user-session-provider' ? { useUserSession: () => ({ status: 'guest' }) } : n === '@/components/favorites/favorite-button' ? { FavoriteButton: () => null, FavoriteNotice: () => null } : n === '@/lib/listing-view' ? view : n === '@/lib/listing-filters' ? filters : n === '@/lib/account-title' ? accountTitle : n === '@/components/ui/tooltip' ? tooltip : n === '@/components/delta/login-method-icon' ? { LoginMethodIcon: () => null } : n === '@/components/delta/account-card' ? { accountHref: card.accountHref, composeGridTitle: card.composeGridTitle, isHaff: l => l.unitLabel === '哈夫币', orderedQuoteResources: d => d.resourceLines.filter(l => l.unitLabel !== '哈夫币'), skinChipTone: () => '', moneyValue: v => v ?? '待确认' } : n.startsWith('@/') ? {} : rq(n);
  const source = fs.readFileSync(file, 'utf8').replace('function ReadyDetail(', 'export function ReadyDetail(');
  m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);

  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = rq('react-dom/client').createRoot(host);

  const data = {
    id: 'b2-account',
    title: '90M test',
    gameName: '三角洲行动',
    resourceLines: [
      { itemId: 'haff', code: 'haff_coin', name: '哈夫币', quantity: '90000000', quantityLabel: '90M', unitLabel: '哈夫币' },
    ],
    conditionLines: [
      { key: 'safe_box_code', value: '1*2 2格安全箱' },
      { key: 'grading_code', value: '黄金' },
      { key: 'character_level', value: '60级' },
      { key: 'vit_level', value: '4级' },
      { key: 'bear_level', value: '4级' },
      { key: 'region_province', value: '广东省' },
      { key: 'region_city', value: '深圳市' },
      { key: 'secret_kd', value: '1.20' },
      { key: 'dive_level', value: '4级' },
    ],
    skinTags: [],
    media: [{ assetId: 'showcase1', url: '/showcase1.png', category: 'SHOWCASE' }],
    entitlementNames: [],
    faceIsSelf: true,
    banRecord: false,
  };

  try {
    await React.act(async () => root.render(React.createElement(m.exports.ReadyDetail, { data, back: { href: '/accounts', label: '返回' } })));

    // 1. Verify gallery preview rail has 1 thumbnail and aria-pressed="true"
    const thumbs = host.querySelectorAll('.detail-gallery-thumb');
    assert.equal(thumbs.length, 1);
    assert.equal(thumbs[0].getAttribute('aria-pressed'), 'true');
    assert.equal(host.querySelector('.detail-gallery-nav'), null);

    // 2. Verify hero attributes structure
    const attrItems = host.querySelectorAll('.account-attr-item');
    assert.ok(attrItems.length >= 8);
    for (const item of attrItems) {
      assert.ok(item.querySelector('.account-attr-label'));
      assert.ok(item.querySelector('.account-attr-value'));
    }

    // 3. Verify safebox prominence: size and secondary name
    const safeboxSize = host.querySelector('.account-safebox-size');
    const safeboxName = host.querySelector('.account-safebox-name');
    assert.equal(safeboxSize.textContent, '1×2');
    assert.equal(safeboxName.textContent, '2格安全箱');

    // 4. Account declarations stay below the narrow configuration column.
    const declarations = host.querySelector('.account-hero-declarations');
    assert.ok(declarations);
    assert.equal(declarations.parentElement.classList.contains('account-hero-section'), true);
    const regionItem = [...declarations.querySelectorAll('.account-attr-item')].find((item) => item.textContent.includes('游戏地区'));
    assert.ok(regionItem);
    assert.match(regionItem.textContent, /游戏地区/);
    assert.match(regionItem.textContent, /广东省.*深圳市/);

    // 5. Verify face recognition declaration
    assert.match(host.textContent, /号主声明本人脸/);
    assert.match(host.textContent, /号主声明无封禁记录/);
  } finally {
    await React.act(async () => root.unmount());
    await window.happyDOM.abort();
  }
});

async function round2DetailHelpers() {
  const view = await import('../src/lib/listing-view.ts'), filters = await import('../src/lib/listing-filters.ts');
  const file = tree + '/apps/web/src/components/market/listing-detail.tsx', m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(tree);
  m.require = name => name === '@heroui/react/toast' ? heroToast : name.endsWith('.css') ? {} : name === '@/lib/listing-view' ? view : name === '@/lib/listing-filters' ? filters : name === '@/lib/account-title' ? accountTitle : name === '@/components/delta/account-card' ? card : name.startsWith('@/') ? {} : name === 'next/link' ? () => null : rq(name);
  m.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(m.require.bind(m));
 m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return { ...m.exports, conditionLines: view.conditionLines };
}

test('B2 unresolved grading codes from the real listing projection do not become a known title rank', async () => {
  const { conditionLines, deriveDetailTitle } = await round2DetailHelpers();
  const conditions = conditionLines({ grading_code: 'gold4', safe_box_code: '3*3' });
  assert.equal(conditions.find(line => line.key === 'grading_code').value, '未确认（代码 gold4）');
  assert.equal(conditions.find(line => line.key === 'safe_box_code').value, '未确认（代码 3*3）');
  const title = deriveDetailTitle({ publicTitle: '备用公开标题', resourceLines: [], conditionLines: conditions });
  assert.equal(title.primary, '备用公开标题');
  assert.doesNotMatch(title.primary, /黄金|IV|3×3|gold4/);
});

test('B2 six-level ammunition preserves exact whole and remainder quantities in inventory and compact titles', async () => {
  const { formatSupplyItem, deriveDetailTitle } = await round2DetailHelpers();
  for (const [quantity, full, compact] of [
    ['59', '59发', '59发六级弹'],
    ['60', '1组（60发）', '1组六级弹'],
    ['61', '1组零1发（共61发）', '1组零1发六级弹'],
    ['119', '1组零59发（共119发）', '1组零59发六级弹'],
    ['9007199254740993', '150119987579016组零33发（共9007199254740993发）', '150119987579016组零33发六级弹'],
    ['0', '0组（0发）', ''],
  ]) {
    const line = { itemId: 'six-round2', code: 'df_billable_level6_bullet', name: '六级子弹', quantity, quantityLabel: quantity, unitLabel: '发' };
    const inventory = formatSupplyItem(line);
    assert.equal(inventory.quantityText, full, quantity);
    assert.equal(inventory.isUnknown, false, quantity);
    assert.equal(inventory.isZero, quantity === '0', quantity);
    assert.equal(deriveDetailTitle({ resourceLines: [line], conditionLines: [] }).secondary, compact, quantity);
  }
  for (const quantity of ['61.5', '0.5', '60foo']) {
    const line = { itemId: 'invalid-six-round2', code: 'df_billable_level6_bullet', name: '六级子弹', quantity, quantityLabel: quantity, unitLabel: '发' };
    assert.equal(formatSupplyItem(line).isUnknown, true, quantity);
    assert.equal(formatSupplyItem(line).quantityText, '数量待确认', quantity);
    assert.equal(deriveDetailTitle({ resourceLines: [line], conditionLines: [] }).secondary, '', quantity);
  }
});

test('B2 penalty images preserve declared true, false and unknown states in the real dialog and restore the clicked trigger', async () => {
  const p = await feedbackFixture(async () => {});
  for (const name of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'KeyboardEvent', 'PointerEvent', 'FocusEvent']) globalThis[name] = p.window[name];
  const settleDialog = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  try {
    for (const [banRecord, summary, declaration] of [
      [false, '号主声明无封禁记录', '号主声明无封禁记录。'],
      [null, '未提供', '号主未提供封禁记录声明。'],
      [true, '号主声明有封禁记录 · 公示图 1 张', '号主声明有封禁记录。'],
    ]) {
      await p.render({ banRecord, media: [
        { assetId: 'public-round2', url: '/public-round2.png', category: 'SHOWCASE' },
        { assetId: 'penalty-round2', url: '/penalty-round2.png', category: 'PENALTY' },
      ] });
      const field = [...p.host.querySelectorAll('.account-attr-item')].find(item => item.querySelector('dt')?.textContent === '处罚记录');
      assert.equal(field.querySelector('dd > span').textContent, summary);
      assert.equal(p.host.querySelector('.detail-gallery-main img').getAttribute('src'), '/public-round2.png');
      assert.equal(p.host.querySelector('img[src="/penalty-round2.png"]'), null);
      const trigger = field.querySelector('[aria-label="查看处罚记录公示图"]');
      for (const closeMethod of ['button', 'escape']) {
        trigger.focus();
        await p.settle(() => trigger.click());
        await settleDialog();
        const dialog = p.window.document.querySelector('.account-penalty-dialog[role="dialog"]');
        assert.ok(dialog, 'the real Radix dialog must open');
        assert.equal(p.host.querySelector('.account-penalty-dialog'), null, 'the dialog is portalled');
        assert.equal(dialog.querySelector('.account-note-source').textContent, declaration + '以下为号主上传的公开截图，不代表平台核验承诺。');
        assert.equal(dialog.querySelectorAll('img').length, 1);
        assert.equal(dialog.querySelector('img').getAttribute('src'), '/penalty-round2.png');
        await p.settle(() => closeMethod === 'button'
          ? dialog.querySelector('[aria-label="关闭处罚截图"]').click()
          : dialog.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
        await settleDialog();
        assert.equal(p.window.document.querySelector('.account-penalty-dialog'), null, closeMethod);
        assert.equal(p.window.document.activeElement === trigger, true, `${banRecord}/${closeMethod} must restore the actual trigger`);
      }
    }
  } finally {
    await p.close();
  }
});

test('inventory keeps real item art, backpack pieces and failed-image fallback inside its own frame', async () => {
  const p = await feedbackFixture(async () => {});
  const backpack = { itemId: 'item_ddc2cdca19f8414a896ea149a7e21d2a', code: 'df_billable_turtle_backpack_45', name: '45格乌龟包', quantity: '3', quantityLabel: '3', unitLabel: '件' };
  const zero = { itemId: 'barrett-zero', code: 'df_billable_barrett_bullet', name: '巴雷特子弹', quantity: '0', unitLabel: '发' };
  const unknown = { itemId: 'armor-unknown', code: 'df_billable_level6_armor', name: '6级护甲', quantity: null, unitLabel: '件' };
  try {
    const style = p.window.document.createElement('style');
    const marketCss = fs.readFileSync(tree + '/apps/web/src/components/market/market.css', 'utf8');
    style.textContent = marketCss.match(/^\.detail-image-fallback \{[^}]+\}/m)[0] + '\n' + fs.readFileSync(tree + '/apps/web/src/components/market/account-detail.css', 'utf8');
    p.window.document.head.append(style);
    await p.render({ resourceLines: [backpack, zero, unknown] });
    const card = p.host.querySelector(`[data-resource-id="${backpack.itemId}"]`);
    assert.equal(card.querySelector('dd').textContent, '3个');
    assert.equal(card.querySelector('img').getAttribute('src'), '/art/delta/items/turtle-backpack-45.png');
    assert.equal(p.host.querySelector('[data-resource-id="barrett-zero"] dd').textContent, '0发');
    assert.equal(p.host.querySelector('[data-resource-id="barrett-zero"]').getAttribute('data-zero'), 'true');
    assert.equal(p.host.querySelector('[data-resource-id="armor-unknown"] dd').textContent, '未提供');
    assert.equal(p.host.querySelector('[data-resource-id="armor-unknown"]').hasAttribute('data-zero'), false);

    await p.settle(() => card.querySelector('img').dispatchEvent(new p.window.Event('error')));
    const fallback = card.querySelector('.detail-image-fallback');
    assert.ok(fallback, 'the existing image error handler must render a fallback');
    assert.match(p.window.getComputedStyle(fallback).minHeight, /^0(?:px)?$/, 'gallery fallback min-height must not stretch inventory art');
    assert.equal(p.window.getComputedStyle(fallback).fontSize, '0px', 'the small frame shows the failure icon without a vertical text strip');
    assert.match(fallback.textContent, /图片暂不可用/, 'failure text remains available to assistive technology');
    assert.equal(card.querySelector('dd').textContent, '3个', 'image failure must not change declared inventory');

    await p.render({ resourceLines: [zero, unknown] });
    assert.equal(p.host.querySelector(`[data-resource-id="${backpack.itemId}"]`), null, 'missing backpack inventory must not be filled with zero');
  } finally {
    await p.close();
  }
});
