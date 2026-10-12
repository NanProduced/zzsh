import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Real component + controlled SDK: receipts may arrive after switching orders or permissions.
async function mountOrderSender(t, methods={}) {
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false,ws:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const errors=await vite.ssrLoadModule('/packages/im-client/src/nim-web-client.ts');
  const {ImLifecycleSupersededError}=await vite.ssrLoadModule('/packages/im-client/src/im-client-lifecycle.ts');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldImage=globalThis.Image;
  let imageNo=0;URL.createObjectURL=()=>`blob:sender-${++imageNo}`;URL.revokeObjectURL=()=>{};
  class DecodedImage {naturalWidth=640;naturalHeight=360;set src(_url){queueMicrotask(()=>this.onload?.());}}
  globalThis.Image=DecodedImage;
  let canRead=true;
  const access=id=>({orderId:id,displayNo:`ZZ-${id}`,orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:id==='a'?'1':'2',name:`订单${id}`,gameName:'三角洲行动',account:{id:`account-${id}`,title:`账号${id}`},viewerAccountId:'viewer',conversationId:`viewer|2|${id==='a'?'1':'2'}`,canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[]});
  const request=async url=>{
    if(url.includes('/im?')){if(!canRead)throw Object.assign(new Error('forbidden'),{status:403});return access(url.includes('/a/')?'a':'b');}
    return {items:['a','b'].map(id=>({id,title:`账号${id}`,displayNo:`ZZ-${id}`,status:'PAID',teamState:'READY'})),nextCursor:null};
  };
  const sent=(cid,text,id)=>({messageClientId:id,messageServerId:`server-${id}`,conversationId:cid,senderId:'viewer',createTime:10,text,messageType:0});
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},...methods};
  const props={identity:'sender-review',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('sender review condition timed out');};
  const render=async extra=>act(async()=>root.render(createElement(OrderTeamPanel,{...props,...extra})));
  const click=async text=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(button,text);await act(async()=>button.click());};
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  const submit=()=>act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  const stage=async count=>{
    const input=node.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:Array.from({length:count},(_,n)=>new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],`sender-${n}.png`,{type:'image/png'}))});
    await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));await settle();
  };
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;globalThis.Image=oldImage;await vite.close();browser.happyDOM.abort();});
  await render();await until(()=>node.textContent.includes('ZZ-a'));await click('ZZ-a');await until(()=>node.querySelector('textarea'));
  return {node,client,errors,ImLifecycleSupersededError,sent,render,settle,until,click,type,submit,stage,setRead:value=>{canRead=value;}};
}

test('image authorization cancelled by an order switch leaves a removable undispatched draft',async t=>{
  let release,entered=false,dispatched=0;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){entered=true;await new Promise(resolve=>{release=resolve;});await options.authorize({conversationId:cid,operation:'send'});dispatched++;return {...h.sent(cid,'','image'),messageType:1};}});
  await h.stage(1);await h.submit();await h.until(()=>entered);await h.click('ZZ-b');await h.until(()=>h.node.querySelector('h3')?.textContent==='订单b');
  await act(async()=>release());await h.settle();await h.click('ZZ-a');await h.until(()=>h.node.querySelector('.order-team-image-draft'));
  const card=h.node.querySelector('.order-team-image-draft');assert.equal(dispatched,0);assert.equal(card.getAttribute('data-state'),'FAILED');
  const remove=[...card.querySelectorAll('button')].find(button=>button.textContent==='移除');assert.equal(remove.disabled,false);
  await act(async()=>remove.click());assert.equal(h.node.querySelector('.order-team-image-draft'),null);assert.equal(dispatched,0);
});

for(const reason of ['authorization denied','original id missing','SDK replaced'])test(`original image UNKNOWN survives retry rejection: ${reason}`,async t=>{
  let sends=0,retries=0,retriedId,rejectRetry;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){await options.authorize({conversationId:cid,operation:'send'});sends++;throw new h.errors.NimImageSendError('UNKNOWN','lost receipt',{messageClientId:'original-image'});},async retryImage(_cid,id){retries++;retriedId=id;if(reason==='SDK replaced')return new Promise((_resolve,reject)=>{rejectRetry=reject;});if(reason==='authorization denied')throw Object.assign(new Error('send authorization denied'),{status:403});throw new h.errors.NimImageSendError('FAILED','待重试的图片消息已不可用',{messageClientId:id});}});
  await h.stage(1);await h.submit();await h.until(()=>h.node.querySelector('.order-team-image-draft[data-state=UNKNOWN]'));
  await act(async()=>h.node.querySelector('.order-team-image-draft button').click());await h.until(()=>retries===1);
  if(reason==='SDK replaced'){await h.render({client:{...h.client}});await act(async()=>rejectRetry(new h.ImLifecycleSupersededError()));}
  await h.settle();const card=h.node.querySelector('.order-team-image-draft');assert.equal(card?.getAttribute('data-state'),'UNKNOWN');assert.equal(retriedId,'original-image');
  assert.equal([...card.querySelectorAll('button')].find(button=>button.textContent==='移除').disabled,true);await h.submit();assert.equal(sends,1);assert.equal(retries,1,'ordinary submit cannot start another attempt');
});

for(const replaceClient of [false,true])test(`post-authorization image expiry stays UNKNOWN without an id: SDK replaced=${replaceClient}`,async t=>{
  let rejectSend,dispatched=0;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){await options.authorize({conversationId:cid,operation:'send'});dispatched++;return new Promise((_resolve,reject)=>{rejectSend=reject;});}});
  await h.stage(1);await h.submit();await h.until(()=>dispatched===1);
  if(replaceClient)await h.render({client:{...h.client}});else {await h.click('ZZ-b');await h.until(()=>h.node.querySelector('h3')?.textContent==='订单b');}
  await act(async()=>rejectSend(replaceClient?new Error('old SDK is disposed'):new h.ImLifecycleSupersededError()));await h.settle();
  if(!replaceClient){await h.click('ZZ-a');await h.until(()=>h.node.querySelector('.order-team-image-draft'));}
  const card=h.node.querySelector('.order-team-image-draft');assert.equal(card?.getAttribute('data-state'),'UNKNOWN','missing id never proves lack of dispatch');
  await act(async()=>card.querySelector('button').click());await h.submit();assert.equal(dispatched,1);assert.equal([...card.querySelectorAll('button')].find(button=>button.textContent==='移除').disabled,true);
});

test('pre-send cancellation cannot declare an old SDK attempt resolved after client replacement',async t=>{
  let release,entered=false,dispatched=0;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){entered=true;await new Promise(resolve=>{release=resolve;});await options.authorize({conversationId:cid,operation:'send'});dispatched++;return {...h.sent(cid,'','image'),messageType:1};}});
  await h.stage(1);await h.submit();await h.until(()=>entered);await h.render({client:{...h.client}});
  await act(async()=>release());await h.until(()=>h.node.querySelector('.order-team-image-draft[data-state=UNKNOWN]'));
  assert.equal(dispatched,0);await h.submit();assert.equal(dispatched,0,'the UI cannot create a new message under the replacement SDK');
});

test('order sender keeps typing added while the original text is in flight',async t=>{
  let release,calls=0;
  const h=await mountOrderSender(t,{async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return new Promise(resolve=>{release=()=>resolve(h.sent(cid,text,'typing'));});}});
  await h.type('A');await h.submit();await h.until(()=>calls===1);await h.type('AB');
  await act(async()=>release());await h.settle();
  assert.equal(h.node.querySelector('textarea').value,'AB','edited draft survives the original receipt');
});

test('order sender text in flight remains locked after A to B to A and settles UNKNOWN with its original id',async t=>{
  let reject,calls=0,retried;
  const h=await mountOrderSender(t,{async sendText(cid,_text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return new Promise((_resolve,r)=>{reject=r;});},async retryText(cid,id,authorize){await authorize({conversationId:cid,operation:'send'});retried=id;return h.sent(cid,'A','original');}});
  await h.type('A');await h.submit();await h.until(()=>calls===1);
  await h.click('ZZ-b');await h.until(()=>h.node.querySelector('textarea')?.value==='');await h.click('ZZ-a');await h.until(()=>h.node.querySelector('textarea')?.value==='A');
  assert.equal(h.node.querySelector('form button[type=submit]').disabled,true,'parent owns the original in-flight text');
  await h.submit();assert.equal(calls,1);
  await act(async()=>reject(new h.errors.NimTextSendError('UNKNOWN','未决',{messageClientId:'original'})));
  await h.until(()=>h.node.textContent.includes('原消息重试'));await h.click('原消息重试');await h.until(()=>retried==='original');assert.equal(calls,1);
});

test('order sender preserves text UNKNOWN when its receipt arrives while another order is selected',async t=>{
  let reject,calls=0,retried;
  const h=await mountOrderSender(t,{async sendText(cid,_text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return new Promise((_resolve,r)=>{reject=r;});},async retryText(cid,id,authorize){await authorize({conversationId:cid,operation:'send'});retried=id;return h.sent(cid,'A','original-late');}});
  await h.type('A');await h.submit();await h.until(()=>calls===1);await h.click('ZZ-b');await h.until(()=>h.node.querySelector('textarea')?.value==='');
  await act(async()=>reject(new h.errors.NimTextSendError('UNKNOWN','未决',{messageClientId:'original-late'})));
  await h.click('ZZ-a');await h.until(()=>h.node.querySelector('textarea')?.value==='A');
  assert.match(h.node.textContent,/原消息重试/,'original UNKNOWN remains owned by A');await h.click('原消息重试');await h.until(()=>retried==='original-late');assert.equal(calls,1);
});

test('order sender without an UNKNOWN text id rejects a second text and image-only submit',async t=>{
  let texts=0,images=0;
  const h=await mountOrderSender(t,{async sendText(cid,_text,authorize){await authorize({conversationId:cid,operation:'send'});texts++;throw new h.errors.NimTextSendError('UNKNOWN','missing id');},async sendImage(){images++;return{};}});
  await h.type('A');await h.submit();await h.until(()=>h.node.textContent.includes('未确认'));await h.submit();await h.settle();
  assert.equal(texts,1,'missing original id cannot mint another message');
  await h.stage(1);await h.type('');await h.submit();await h.settle();assert.equal(images,0,'UNKNOWN text blocks image-only submit');
});

test('order sender definite text rejection lets a new draft start without replaying the rejected text',async t=>{
  const texts=[];let retries=0;
  const h=await mountOrderSender(t,{async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});texts.push(text);if(texts.length===1)throw new h.errors.NimTextSendError('FAILED','rejected',{messageClientId:'rejected-A'});return h.sent(cid,text,'accepted-B');},async retryText(cid,_id,authorize){await authorize({conversationId:cid,operation:'send'});retries++;return h.sent(cid,'A','rejected-A');}});
  await h.type('A');await h.submit();await h.until(()=>h.node.textContent.includes('发送失败'));await h.type('B');await h.submit();await h.settle();
  assert.deepEqual(texts,['A','B'],'only UNKNOWN owns an unresolved ordinary submit');assert.equal(retries,0);
});

test('order sender owns its synchronous submit lock before React commits sending',async t=>{
  let calls=0;
  const h=await mountOrderSender(t,{async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return h.sent(cid,text,`same-frame-${calls}`);}});
  await h.type('A');await act(async()=>{const form=h.node.querySelector('form');for(let n=0;n<2;n++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await h.settle();
  assert.equal(calls,1,'same-frame submit cannot create two messages');
});

test('order sender pauses new images when only sendAllowed changes while preserving the first receipt',async t=>{
  let release,calls=0;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){await options.authorize({conversationId:cid,operation:'send'});calls++;if(calls===1)return new Promise(resolve=>{release=()=>resolve({...h.sent(cid,'','image-1'),messageType:1});});return {...h.sent(cid,'','image-2'),messageType:1};}});
  await h.stage(2);await h.submit();await h.until(()=>calls===1);await h.render({sendAllowed:false});
  await act(async()=>release());await h.settle();assert.equal(calls,1,'each new image rechecks current send capability');
  assert.match(h.node.textContent,/sender-1.png/,'unsent image stays staged');
});

test('order sender image retry cannot bypass an UNKNOWN text and repeated text failures keep the original draft',async t=>{
  let sends=0,retries=0,imageRetries=0;
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){await options.authorize({conversationId:cid,operation:'send'});throw new h.errors.NimImageSendError('FAILED','image failed',{messageClientId:'failed-image'});},async retryImage(){imageRetries++;return{};},async sendText(cid,_text,authorize){await authorize({conversationId:cid,operation:'send'});sends++;throw new h.errors.NimTextSendError('UNKNOWN','text unknown',{messageClientId:'original-text'});},async retryText(cid,_id,authorize){await authorize({conversationId:cid,operation:'send'});retries++;if(retries===1)throw new h.errors.NimTextSendError('UNKNOWN','still unknown',{messageClientId:'original-text'});return h.sent(cid,'A','original-text');}});
  await h.stage(1);await h.submit();await h.until(()=>h.node.querySelector('.order-team-image-draft[data-state=FAILED]'));
  await h.type('A');await h.submit();await h.until(()=>sends===1&&h.node.textContent.includes('未确认'));
  await act(async()=>h.node.querySelector('.order-team-image-draft button').click());assert.equal(imageRetries,0,'image retry shares the text UNKNOWN gate');
  await h.type('B');await h.submit();await h.until(()=>retries===1);await h.click('原消息重试');await h.until(()=>retries===2);
  assert.equal(sends,1);assert.equal(h.node.querySelector('textarea').value,'B','retry failure must not adopt later typing as its original text');
});

test('order sender does not refill revoked read state with a late text receipt',async t=>{
  let release,calls=0;
  const h=await mountOrderSender(t,{async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return new Promise(resolve=>{release=()=>resolve(h.sent(cid,text,'revoked-read'));});}});
  await h.type('PRIVATE');await h.submit();await h.until(()=>calls===1);h.setRead(false);await h.click('刷新');await h.until(()=>!h.node.querySelector('textarea'));
  await act(async()=>release());await h.settle();assert.doesNotMatch(h.node.textContent,/PRIVATE/);
  h.setRead(true);await h.click('重新确认授权');await h.until(()=>h.node.querySelector('textarea'));assert.equal(h.node.querySelector('textarea').value,'','private draft is not restored after read revocation');
});

test('order sender retains the original image UNKNOWN across object read revocation without exposing its preview',async t=>{
  let reject,sends=0,retries=0,retried;const revoked=[];
  const h=await mountOrderSender(t,{async sendImage(cid,_file,options){await options.authorize({conversationId:cid,operation:'send'});sends++;return new Promise((_resolve,r)=>{reject=r;});},async retryImage(cid,id,options){await options.authorize({conversationId:cid,operation:'send'});retries++;retried=id;return {...h.sent(cid,'','original-image'),messageType:1};}});
  URL.revokeObjectURL=url=>revoked.push(url);
  await h.stage(1);await h.submit();await h.until(()=>sends===1);
  const preview=h.node.querySelector('.order-team-image-draft img').getAttribute('src');
  h.setRead(false);await h.click('刷新');await h.until(()=>!h.node.querySelector('textarea'));
  assert.equal(h.node.querySelector('.order-team-image-draft'),null,'read denial hides private image and composer');assert.doesNotMatch(h.node.textContent,/sender-0.png/);
  await act(async()=>reject(new h.errors.NimImageSendError('UNKNOWN','image unknown',{messageClientId:'original-image'})));
  await h.settle();assert.equal(h.node.querySelector('.order-team-image-draft'),null);
  h.setRead(true);await h.click('重新确认授权');await h.until(()=>h.node.querySelector('textarea'));
  assert.ok(h.node.querySelector('.order-team-image-draft[data-state=UNKNOWN]'),'restored authorized view retains the original UNKNOWN image');assert.equal(revoked.includes(preview),false,'pending ownership survives denial and UNKNOWN');
  await act(async()=>h.node.querySelector('.order-team-image-draft button').click());await h.until(()=>retries===1);
  assert.equal(retried,'original-image');assert.equal(sends,1,'restoring read cannot create another sendImage');await h.until(()=>!h.node.querySelector('.order-team-image-draft'));assert.equal(revoked.filter(url=>url===preview).length,1,'successful original retry releases its preview once');
});

test('order sender settles the original text receipt after replacing the SDK client within the same identity',async t=>{
  let release,calls=0;
  const h=await mountOrderSender(t,{async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});calls++;return new Promise(resolve=>{release=()=>resolve(h.sent(cid,text,'reconnected'));});}});
  await h.type('A');await h.submit();await h.until(()=>calls===1);await h.render({client:{...h.client}});
  await act(async()=>release());await h.until(()=>h.node.querySelector('textarea')?.value==='');
  assert.doesNotMatch(h.node.textContent,/发送中|原消息重试/,'known original receipt must release its responsibility');
});

test('parent image attempt lock rejects reentry and ignores stale receipts for the next image',()=>{
  const source=readFileSync(new URL('../../../packages/ui/src/order-team-panel.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('panel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const callbacks={};
  function visit(node){if(ts.isVariableDeclaration(node)&&['beginPendingImage','settlePendingImage'].includes(node.name.getText(ast)))callbacks[node.name.getText(ast)]=node.initializer.getText(ast);ts.forEachChild(node,visit);}
  visit(ast);
  const imageAttempts={current:new Map()},textAttempts={current:new Map()},pendingTextByOrderRef={current:{}},identityRef={current:'user'},sendingClientRef={current:{}};let state={};const revoked=[];
  const build=name=>new Function('useCallback','imageAttempts','textAttempts','pendingTextByOrderRef','identityRef','sendingClientRef','setPendingByOrder','URL','superseded','NimImageSendError',ts.transpileModule('const run='+callbacks[name],{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';return run;')(
    fn=>fn,imageAttempts,textAttempts,pendingTextByOrderRef,identityRef,sendingClientRef,fn=>state=fn(state),{revokeObjectURL:url=>revoked.push(url)},()=>false,Error);
  const begin=build('beginPendingImage'),settle=build('settlePendingImage'),key=JSON.stringify(['user','app','order','team']);
  const a={file:{name:'same.png'},previewUrl:'blob:a'},b={file:{name:'same.png'},previewUrl:'blob:b'};
  const first=begin(key,a);assert.ok(first);assert.equal(begin(key,b),null,'lock is synchronous');
  settle(key,first,{success:true});assert.equal(state[key],null);
  const second=begin(key,b);settle(key,first,{success:true});settle(key,first,{success:false,error:new Error('late')});
  assert.equal(state[key].file,b.file);assert.equal(imageAttempts.current.get(key).draft,second);assert.deepEqual(revoked,['blob:a']);
  settle(key,second,{success:true});assert.equal(state[key],null);assert.deepEqual(revoked,['blob:a','blob:b']);
  identityRef.current='other';assert.equal(begin(key,a),null,'old identity cannot acquire an attempt');
});

test('order chat routes the normal send to the original message after an unknown text result',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const {NimTextSendError}=await vite.ssrLoadModule('/packages/im-client/src/nim-web-client.ts');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;await vite.close();browser.happyDOM.abort();});
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]};
  const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  let sendCalls=0,retryCalls=0,retriedId=null;
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},
    async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});sendCalls++;throw new NimTextSendError('UNKNOWN','未确认',{messageClientId:'text-client-1'});},
    async retryText(cid,messageClientId,authorize){await authorize({conversationId:cid,operation:'send'});retryCalls++;retriedId=messageClientId;return{messageClientId,messageServerId:'server-1',conversationId:cid,senderId:'viewer',receiverId:'1',createTime:2,text:'first',messageType:0};}};
  const props={identity:'identity-text-unknown',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('text unknown condition timed out');};
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());await until(()=>node.querySelector('textarea')&&!node.querySelector('textarea').disabled);
  await type('first');await act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await until(()=>node.textContent.includes('原消息重试'));
  assert.equal(sendCalls,1);
  await type('second');
  await act(async()=>node.querySelector('form button[type=submit]').click());await until(()=>retryCalls===1);
  assert.equal(sendCalls,1,'normal submit must not create a second message');
  assert.equal(retriedId,'text-client-1','retry keeps the original messageClientId');
  assert.equal(node.querySelector('textarea').value,'second','newer typing survives the original retry');
  await until(()=>!node.textContent.includes('原消息重试'));
});

test('order chat text UNKNOWN with staged images keeps text retry, does not fail images or lose clientId',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const {NimTextSendError}=await vite.ssrLoadModule('/packages/im-client/src/nim-web-client.ts');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  const oldCreate=globalThis.URL?.createObjectURL,oldRevoke=globalThis.URL?.revokeObjectURL;
  let objectUrlsCreated=0;
  globalThis.URL=globalThis.URL||{};
  globalThis.URL.createObjectURL=()=>`blob:mock-${++objectUrlsCreated}`;
  globalThis.URL.revokeObjectURL=()=>{};
  const pendingImages=[];
  class ControlledImage{naturalWidth=0;naturalHeight=0;onload=()=>{};onerror=()=>{};set src(value){this.value=value;pendingImages.push(this);}}
  Object.defineProperty(globalThis,'Image',{value:ControlledImage,configurable:true});
  Object.defineProperty(browser,'Image',{value:ControlledImage,configurable:true});
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;if(oldCreate)globalThis.URL.createObjectURL=oldCreate;if(oldRevoke)globalThis.URL.revokeObjectURL=oldRevoke;await vite.close();browser.happyDOM.abort();});
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]};
  const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  let sendTextCalls=0,sendImageCalls=0,retryTextCalls=0,retriedClientId=null;
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},
    async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});sendTextCalls++;throw new NimTextSendError('UNKNOWN','文字发送未决',{messageClientId:'order-text-unknown-1'});},
    async retryText(cid,messageClientId,authorize){await authorize({conversationId:cid,operation:'send'});retryTextCalls++;retriedClientId=messageClientId;return{messageClientId,messageServerId:'srv-t1',conversationId:cid,senderId:'viewer',receiverId:'1',createTime:10,text:'msg',messageType:0};},
    async sendImage(cid,file,options){await options.authorize({conversationId:cid,operation:'send'});sendImageCalls++;return{messageClientId:`img-${sendImageCalls}`,messageServerId:`srv-img-${sendImageCalls}`,conversationId:cid,senderId:'viewer',receiverId:'1',createTime:11,messageType:1};}
  };
  const props={identity:'identity-text-img-order',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('order text-img unknown condition timed out');};
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());await until(()=>node.querySelector('textarea')&&!node.querySelector('textarea').disabled);
  await type('hello with image');
  const input=node.querySelector('input[type=file]');
  const file=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'order-proof.png',{type:'image/png'});
  Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await until(()=>pendingImages.length===1);
  const decoder=pendingImages.shift();decoder.naturalWidth=640;decoder.naturalHeight=360;
  await act(async()=>decoder.onload());
  await until(()=>node.textContent.includes('order-proof.png'));
  assert.equal(sendTextCalls,0);
  assert.equal(sendImageCalls,0);
  // Submit: text will fail with UNKNOWN
  await act(async()=>node.querySelector('form button[type=submit]').click());
  await until(()=>node.textContent.includes('原消息重试'));
  assert.equal(sendTextCalls,1);
  assert.equal(sendImageCalls,0,'image must not be sent when text is UNKNOWN');
  assert.equal(node.textContent.includes('发送失败'),false,'image must not be labeled failed when text was unknown');
  assert.ok(node.textContent.includes('待发送')||node.textContent.includes('order-proof.png'),'staged image remains staged');
  // Click submit again: will retry text with original clientId, then proceed to send image
  await act(async()=>node.querySelector('form button[type=submit]').click());
  await until(()=>retryTextCalls===1&&sendImageCalls===1);
  assert.equal(sendTextCalls,1,'did not start new text send');
  assert.equal(retriedClientId,'order-text-unknown-1','retried exact messageClientId');
  await until(()=>!node.textContent.includes('原消息重试'));
});

test('formal order panel isolates orders, authorization, drafts, late SDK work and identity',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const timers=[];const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{if(ms===5000){timers.push(fn);return {fake:true};}return interval(fn,ms);};
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;await vite.close();browser.happyDOM.abort();});
  let responsible='viewer';
  let escalationA={firstResponseAt:null,remindDueAt:'2026-09-21T09:30:00.000Z',addRound:1,state:'RUNNING',needsManualReview:false,noEligibleStaff:false};
  let escalationB={firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false};
  const access=id=>({orderId:id,displayNo:`ZZ-${id}`,orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:id==='a'?'1':'2',name:`订单${id}`,gameName:'三角洲行动',account:{id:`account-${id}`,title:`账号${id}`},viewerAccountId:'viewer',conversationId:`viewer|2|${id==='a'?'1':'2'}`,canRead:true,canSend:true,
    supportEscalation:{...(id==='a'?escalationA:escalationB)},members:[{platformId:'buyer',accountId:'buyer-account',party:'BUYER',name:'买家甲',avatar:null},{platformId:'owner',accountId:'owner-account',party:'OWNER',name:'号主乙',avatar:null},
      {platformId:'viewer',accountId:'viewer',party:'STAFF',name:'原客服',avatar:null,responsible:responsible==='viewer'},{platformId:'new-staff',accountId:'new-staff-account',party:'STAFF',name:'补派客服',avatar:null,responsible:responsible==='new-staff'}]});
  const message=id=>({messageClientId:id,conversationId:access(id).conversationId,senderId:'viewer',receiverId:access(id).teamId,createTime:1,text:`历史${id}`,messageType:0});
  let policy='ok',release,waiting=false,historyCalls=0,sendCalls=0,subscribes=0;const authErrors=[];
  const request=async url=>{
    if(!url.includes('/im?'))return {items:['a','b'].map(id=>{const escalation=id==='a'?escalationA:escalationB;return {id,title:`账号${id}`,displayNo:`ZZ-${id}`,status:'PAID',teamState:'READY',firstResponseAt:escalation.firstResponseAt,remindDueAt:escalation.remindDueAt,addRound:escalation.addRound,escalationState:escalation.state};}),nextCursor:null};
    const id=url.includes('/a/')?'a':'b';
    if(policy==='delay'&&id==='a'&&url.endsWith('send')){waiting=true;return new Promise(r=>{release=()=>r(access('a'));});}
    if(policy==='read-denied'||policy==='401'||policy==='423')throw Object.assign(new Error('private detail'),{status:policy==='read-denied'?403:Number(policy)});
    if(policy==='send-denied'&&url.endsWith('send'))throw Object.assign(new Error('private detail'),{status:403});
    if(policy==='network')throw new Error('private network detail');
    return {...access(id),canSend:policy!=='send-denied'};
  };
  const listeners=new Set();
  const client={accountId:'viewer',transport:'local-fake',onMessages(fn){subscribes++;listeners.add(fn);return()=>listeners.delete(fn);},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});historyCalls++;return [message(cid.endsWith('|1')?'a':'b')];},
    async sendText(cid,text,authorize){await authorize({conversationId:cid,operation:'send'});sendCalls++;return {...message(cid.endsWith('|1')?'a':'b'),messageClientId:`sent-${sendCalls}`,text};}};
  const props={identity:'identity-a',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:status=>authErrors.push(status)};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('order component condition timed out');};
  const click=async text=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(button,text);await act(async()=>button.click());};
  // 工具栏的重新读取按钮正常时叫「刷新」，只有在真的 401/403/423 失权后才是「重新确认授权」。
  // 这里按契约取当前标签，并把标签本身当断言，避免"刷新"被当成授权动作。
  const refreshControl=()=>[...node.querySelectorAll('.order-team-toolbar button')].find(b=>/^(刷新|重新确认授权)$/.test(b.textContent.trim()));
  const clickRefresh=async expected=>{const button=refreshControl();assert.ok(button,'order panel refresh control');if(expected)assert.equal(button.textContent.trim(),expected);await act(async()=>button.click());};
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  assert.match(node.textContent,/待客服回应/);assert.match(node.textContent,/提醒节点/);assert.match(node.textContent,/接待跟踪未启用/);
  // 正常读取下工具栏只有"刷新"，不能把日常重读说成需要用户重新授权。
  assert.equal(refreshControl().textContent.trim(),'刷新','normal list refresh is not an authorization action');
  await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));assert.equal(subscribes,1);
  assert.match(node.querySelector('.order-team-escalation').textContent,/待客服回应/);assert.match(node.querySelector('.order-team-escalation').textContent,/补派轮次\s*1/);
  const original=()=>[...node.querySelectorAll('.order-team-members li')].find(item=>item.textContent.includes('原客服'));
  const added=()=>[...node.querySelectorAll('.order-team-members li')].find(item=>item.textContent.includes('补派客服'));
  assert.match(original().textContent,/负责客服/);assert.match(added().textContent,/协作客服/);
  responsible='new-staff';await act(async()=>timers.at(-1)());await until(()=>original()?.textContent.includes('协作客服'));
  assert.match(added().textContent,/负责客服/);assert.equal(node.querySelector('textarea').disabled,false);
  await type('A草稿');assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='delay';await act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await until(()=>waiting);
  await click('ZZ-b');await until(()=>node.textContent.includes('历史b'));assert.equal(node.querySelector('textarea').value,'');
  assert.match(node.querySelector('.order-team-escalation').textContent,/接待跟踪未启用/);assert.doesNotMatch(node.querySelector('.order-team-escalation').textContent,/提醒节点|待人工/);
  await act(async()=>release());await settle();assert.equal(sendCalls,0);assert.doesNotMatch(node.textContent,/历史a|A草稿/);
  policy='ok';await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'A草稿');
  assert.doesNotMatch(node.textContent,/原消息重试/,'superseded pre-send authorization is not an UNKNOWN message');
  assert.equal(node.querySelector('form button[type=submit]').disabled,false,'no SDK dispatch means no unresolved send responsibility');
  await act(async()=>root.render(createElement(OrderTeamPanel,{...props,active:false})));
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));
  await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='send-denied';await clickRefresh();await until(()=>[...node.querySelectorAll('button')].some(b=>b.textContent==='发送文字'&&b.disabled));
  assert.match(node.textContent,/历史a/);assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='network';await clickRefresh();await until(()=>node.textContent.includes('检查网络'));assert.match(node.textContent,/历史a/);
  policy='read-denied';const before=historyCalls;await clickRefresh();await until(()=>!node.querySelector('textarea'));assert.doesNotMatch(node.textContent,/历史a|A草稿/);assert.equal(historyCalls,before);
  // 真的被拒之后才升级成"重新确认授权"这个授权语义。
  assert.equal(refreshControl().textContent.trim(),'重新确认授权','denied access surfaces an authorization action');
  policy='ok';await clickRefresh();await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'');
  assert.equal(refreshControl().textContent.trim(),'刷新','recovered access drops the authorization wording');
  await type('身份草稿');await act(async()=>root.render(createElement(OrderTeamPanel,{...props,key:'identity-b',identity:'identity-b'})));await until(()=>node.textContent.includes('ZZ-a'));assert.equal(node.querySelector('textarea'),null);
  for(const code of ['401','423']){policy=code;await click('ZZ-a');await until(()=>authErrors.includes(Number(code)));assert.equal(node.querySelector('textarea'),null);policy='ok';await clickRefresh();await until(()=>node.textContent.includes('ZZ-a'));await click('返回订单列表');}
  escalationB={firstResponseAt:null,remindDueAt:null,addRound:0,state:'EXHAUSTED',needsManualReview:true,noEligibleStaff:true};
  await click('ZZ-b');await until(()=>node.textContent.includes('历史b'));await clickRefresh();await until(()=>node.querySelector('.order-team-escalation')?.textContent.includes('当前没有符合条件的客服'));
  assert.match(node.querySelector('.order-team-escalation').textContent,/待人工处理/);
  escalationA={firstResponseAt:'2026-09-21T09:41:00.000Z',remindDueAt:null,addRound:1,state:'STOPPED',needsManualReview:false,noEligibleStaff:false};
  await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));await clickRefresh();await until(()=>node.querySelector('.order-team-escalation')?.textContent.includes('首响时间'));
  assert.match(node.querySelector('.order-team-escalation').textContent,/已收到客服回应/);assert.doesNotMatch(node.querySelector('.order-team-escalation').textContent,/提醒节点/);
  assert.doesNotMatch(node.querySelector('.order-team-escalation').textContent,/退款|结算确认/);
  assert.doesNotMatch(node.textContent,/private/);
});

test('order list refresh reconciles status, membership, pagination, identity and lifecycle for user/admin',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const activeTimers=new Map();let timerId=0;const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,5000);const id=++timerId;activeTimers.set(id,fn);return id;};
  globalThis.clearInterval=id=>activeTimers.delete(id);
  const mounts=[];
  const mount=()=>{const node=document.createElement('div');document.body.append(node);const root=createRoot(node);const item={node,root,mounted:true};mounts.push(item);return item;};
  const unmount=async item=>{if(item.mounted){await act(async()=>item.root.unmount());item.mounted=false;item.node.remove();}};
  t.after(async()=>{for(const item of mounts)await unmount(item);globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;await vite.close();browser.happyDOM.abort();});
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async(predicate)=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('order list refresh condition timed out');};
  const click=async(node,text)=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(button,text);await act(async()=>button.click());};
  const tick=async()=>act(async()=>{for(const fn of [...activeTimers.values()])fn();await Promise.resolve();});
  const order=(id,title=id)=>({id,title:`账号${title}`,displayNo:`ZZ-${id}`,status:'PAID',teamState:'READY',firstResponseAt:null,remindDueAt:'2026-09-22T09:00:00.000Z',addRound:0,escalationState:'RUNNING'});
  const escalation=state=>({state,firstResponseAt:state==='STOPPED'?'2026-09-22T09:01:00.000Z':null,remindDueAt:state==='RUNNING'?'2026-09-22T09:00:00.000Z':null,addRound:0,needsManualReview:false,noEligibleStaff:false});
  const adminRows=[order('a')];let adminListState='RUNNING',adminDetailState='RUNNING',revokedA=false,adminListCalls=0,adminDetailCalls=0,adminWrites=0;
  let activeLists=0,maxActiveLists=0,nextHeldList=null;
  const access=(id,state)=>({orderId:id,displayNo:`ZZ-${id}`,orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'team-a',name:`订单${id}`,gameName:'三角洲行动',account:{id:`account-${id}`,title:`账号${id}`},viewerAccountId:'staff-a',conversationId:'staff-a|2|team-a',canRead:true,canSend:true,supportEscalation:escalation(state),members:[]});
  let realm='admin',userIdentity='user-a',userRowsA=[order('user-a')],userRowsB=[order('user-b')],userListCalls=0;
  const paths=[];
  const request=async url=>{
    paths.push(url);
    if(url.includes('/im?operation=')){
      if(realm==='admin')adminDetailCalls++;
      if(revokedA&&url.includes('/a/im?'))throw Object.assign(new Error('revoked'),{status:403});
      return access('a',adminDetailState);
    }
    if(url.includes('im-groups')||url.startsWith('/api/orders/?')){
      if(realm==='admin'){
        adminListCalls++;activeLists++;maxActiveLists=Math.max(maxActiveLists,activeLists);
        const held=nextHeldList&&!url.includes('cursor=');if(held){const slot=nextHeldList;nextHeldList=null;slot.entered=true;await new Promise(resolve=>{slot.release=resolve;});}
        const cursor=url.includes('cursor=page2');const items=cursor?[order('c')]:adminRows.map(item=>({...item,escalationState:adminListState,firstResponseAt:adminListState==='STOPPED'?'2026-09-22T09:01:00.000Z':null}));
        activeLists--;return{items,nextCursor:cursor?null:'page2'};
      }
      userListCalls++;const identityAtRequest=userIdentity;const snapshot=(identityAtRequest==='user-a'?userRowsA:userRowsB).map(item=>({...item}));
      const held=nextHeldList&&!url.includes('cursor=');if(held){const slot=nextHeldList;nextHeldList=null;slot.entered=true;await new Promise(resolve=>{slot.release=resolve;});}
      return{items:snapshot,nextCursor:null};
    }
    adminWrites++;throw new Error(`unexpected write or route ${url}`);
  };
  let subscriptions=0;const client={accountId:'staff-a',transport:'local-fake',onMessages(){subscriptions++;return()=>{};},async getMessageHistory(_cid,_limit,_before,authorize){await authorize({conversationId:'staff-a|2|team-a',operation:'read'});return[];},async sendText(){adminWrites++;throw new Error('unexpected send');}};
  const admin=mount();const adminProps={identity:'admin-a',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  await act(async()=>admin.root.render(createElement(OrderTeamPanel,adminProps)));await until(()=>admin.node.textContent.includes('ZZ-a'));
  assert.equal(activeTimers.size,1,'the visible list has one existing five-second timer');
  assert.ok(paths.some(url=>url.startsWith('/orders/im-groups?')),'Admin uses its existing authorized group-list route');
  await click(admin.node,'ZZ-a');await until(()=>admin.node.querySelector('.order-team-escalation'));
  assert.equal(subscriptions,1);
  adminDetailState='STOPPED'; // list intentionally returns the older RUNNING snapshot.
  await tick();await until(()=>[...admin.node.querySelectorAll('.order-team-list-escalation')].some(row=>row.textContent.includes('已收到客服回应')));
  const selectedRow=[...admin.node.querySelectorAll('.order-team-list button')].find(button=>button.textContent.includes('ZZ-a'));
  assert.match(selectedRow.textContent,/已收到客服回应/);
  assert.match(admin.node.querySelector('.order-team-escalation').textContent,/已收到客服回应/);
  assert.equal(subscriptions,1,'fresh state does not remount the conversation');
  await click(admin.node,'更多订单');await until(()=>admin.node.textContent.includes('ZZ-c'));
  adminRows.push(order('b','补入客服可见群'));
  await tick();await until(()=>admin.node.textContent.includes('ZZ-b'));
  assert.ok(admin.node.textContent.includes('ZZ-c'),'refresh preserves the already loaded later page');
  const beforeList=adminListCalls,beforeDetail=adminDetailCalls,heldAdmin={entered:false,release:null};nextHeldList=heldAdmin;
  await tick();await until(()=>heldAdmin.entered===true);
  await tick();await tick();assert.equal(adminListCalls,beforeList+1,'poll ticks do not overlap or queue duplicate list reads');
  assert.equal(adminDetailCalls,beforeDetail,'selected detail waits for the single-flight list refresh');
  heldAdmin.release?.();await until(()=>adminListCalls===beforeList+2&&adminDetailCalls===beforeDetail+1);
  assert.equal(maxActiveLists,1);assert.equal(subscriptions,1);
  revokedA=true;adminRows.splice(0,adminRows.length,order('b','补入客服可见群'));
  await tick();await until(()=>!admin.node.textContent.includes('ZZ-a')&&admin.node.textContent.includes('ZZ-b'));
  assert.ok(admin.node.textContent.includes('ZZ-c'),'revocation reconciliation keeps the loaded page');
  assert.equal(adminWrites,0,'list refresh never creates/adds/notifies or sends');
  await unmount(admin);assert.equal(activeTimers.size,0,'unmount stops the panel timer');

  realm='user';userIdentity='user-a';const user=mount();
  const userProps={identity:'user-a',realm:'user',client:null,connection:'idle',active:true,request,onAuthError:()=>{}};
  await act(async()=>user.root.render(createElement(OrderTeamPanel,userProps)));await until(()=>user.node.textContent.includes('ZZ-user-a'));
  assert.ok(paths.some(url=>url.startsWith('/api/orders/?party=renter&limit=20')),'User uses its existing renter-authorized list route');
  userRowsA=[order('user-a'),order('user-added')];await tick();await until(()=>user.node.textContent.includes('ZZ-user-added'));
  const heldUser={entered:false,release:null};nextHeldList=heldUser;await tick();await until(()=>heldUser.entered===true);
  userIdentity='user-b';await act(async()=>user.root.render(createElement(OrderTeamPanel,{...userProps,key:'user-b',identity:'user-b'})));
  await until(()=>user.node.textContent.includes('ZZ-user-b'));
  heldUser.release?.();await settle();assert.ok(user.node.textContent.includes('ZZ-user-b'));assert.doesNotMatch(user.node.textContent,/ZZ-user-a|ZZ-user-added/,'late prior-user data cannot enter the new identity');
  const callsBeforeInactive=userListCalls;
  await act(async()=>user.root.render(createElement(OrderTeamPanel,{...userProps,key:'user-b',identity:'user-b',active:false})));
  assert.equal(activeTimers.size,0,'leaving the active section clears its timer');
  await settle();assert.equal(userListCalls,callsBeforeInactive,'inactive section performs no background list polling');
  assert.ok(paths.some(url=>url.startsWith('/api/orders/?party=renter&limit=20')));
});

test('order list refresh rebases a loaded 20+5 cursor window and advances bounded tail scans',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const timers=new Map();let timerId=0;const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,5000);timers.set(++timerId,fn);return timerId;};globalThis.clearInterval=id=>timers.delete(id);
  const node=document.createElement('div'),root=createRoot(node);document.body.append(node);
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;await vite.close();browser.happyDOM.abort();});
  const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
  const until=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await settle();}throw Error('pagination refresh condition timed out');};
  const ids=()=>[...node.querySelectorAll('.order-team-list > button > small:first-child')].map(el=>el.textContent.replace('ZZ-',''));
  const clickMore=async()=>{const button=[...node.querySelectorAll('.order-team-list button')].find(item=>item.textContent.includes('更多订单'));assert.ok(button,'next page cursor is available');await act(async()=>button.click());};
  let rows=Array.from({length:25},(_,i)=>40-i),stopped=new Set(),calls=[],active=0,maxActive=0;
  const order=id=>({id:String(id),displayNo:`ZZ-${id}`,title:`账号${id}`,status:'PAID',teamState:'READY',firstResponseAt:stopped.has(String(id))?'2026-09-22T09:01:00.000Z':null,remindDueAt:null,addRound:0,escalationState:stopped.has(String(id))?'STOPPED':'RUNNING'});
  const request=async path=>{
    const url=new URL(path,'http://127.0.0.1:4311'),cursor=url.searchParams.get('cursor');calls.push(cursor);
    active++;maxActive=Math.max(maxActive,active);
    try{const offset=cursor===null?0:rows.findIndex(id=>String(id)===cursor)+1;assert.ok(offset>=0,'server cursor still resolves');const page=rows.slice(offset,offset+20),end=offset+page.length;
      return{items:page.map(order),nextCursor:end<rows.length?(page.at(-1)??null)?.toString()??null:null};
    }finally{active--;}
  };
  const tick=async()=>act(async()=>{for(const fn of [...timers.values()])fn();await Promise.resolve();});
  await act(async()=>root.render(createElement(OrderTeamPanel,{identity:'admin-pagination',realm:'admin',client:null,connection:'idle',active:true,request,onAuthError:()=>{}})));
  await until(()=>ids().length===20);await clickMore();await until(()=>ids().length===25);
  assert.deepEqual(ids(),Array.from({length:25},(_,i)=>String(40-i)));

  rows=Array.from({length:26},(_,i)=>41-i);
  await tick();await until(()=>ids().length===26);
  assert.deepEqual(ids(),rows.map(String),'new head must not push a still-authorized old head row out of the loaded window');
  assert.equal(new Set(ids()).size,ids().length,'rebased pages contain no duplicate orders');
  assert.deepEqual(calls.slice(-2),[null,'22'],'the tail fetch uses the refreshed page-one cursor');

  rows=rows.filter(id=>id!==18);stopped.add('16');
  await tick();await until(()=>ids().length===25&&ids().at(-1)==='16');
  assert.deepEqual(ids(),rows.map(String),'a revoked tail order is removed instead of retained from an old snapshot');
  assert.match([...node.querySelectorAll('.order-team-list button')].find(button=>button.textContent.includes('ZZ-16')).textContent,/已收到客服回应/,'tail status is refreshed');
  assert.equal(maxActive,1,'page refreshes never overlap');

  rows=Array.from({length:90},(_,i)=>90-i);
  await tick();await until(()=>ids().length===40);await clickMore();await until(()=>ids().length===60);await clickMore();await until(()=>ids().length===80);
  rows=Array.from({length:91},(_,i)=>91-i);stopped.add('12');
  const beforeScan=calls.length;await tick();await until(()=>calls.length===beforeScan+2);
  assert.equal(node.querySelector('.order-team-list').getAttribute('aria-busy'),'true','a loaded prefix beyond the per-round budget remains visibly refreshing');
  assert.equal(calls.length-beforeScan,2,'one timer round reads at most two pages');
  await tick();await until(()=>node.querySelector('.order-team-list').getAttribute('aria-busy')==='false');
  assert.deepEqual(ids(),rows.slice(0,80).map(String),'continuation follows the refreshed cursor and atomically replaces the loaded prefix');
  assert.match([...node.querySelectorAll('.order-team-list button')].find(button=>button.textContent.includes('ZZ-12')).textContent,/已收到客服回应/);
  assert.equal(calls.length-beforeScan,4,'the next timer round resumes with only the remaining loaded pages');
});

test('load-more and scheduled refresh serialize and recompute the page cursor',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const timers=new Map();let timerId=0;const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,5000);timers.set(++timerId,fn);return timerId;};globalThis.clearInterval=id=>timers.delete(id);
  const node=document.createElement('div'),root=createRoot(node);document.body.append(node);
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;await vite.close();browser.happyDOM.abort();});
  const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
  const until=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await settle();}throw Error('load-more/refresh race timed out');};
  const ids=()=>[...node.querySelectorAll('.order-team-list > button > small:first-child')].map(el=>el.textContent.replace('ZZ-',''));
  let rows=Array.from({length:50},(_,i)=>50-i),hold=null,calls=[],active=0,maxActive=0;
  const request=async path=>{const url=new URL(path,'http://127.0.0.1:4311'),cursor=url.searchParams.get('cursor');calls.push(cursor);active++;maxActive=Math.max(maxActive,active);
    try{if(cursor&&hold){const current=hold;hold=null;current.entered=true;await new Promise(resolve=>{current.release=resolve;});}
      const offset=cursor===null?0:rows.findIndex(id=>String(id)===cursor)+1;assert.ok(offset>=0);const page=rows.slice(offset,offset+20),end=offset+page.length;
      return{items:page.map(id=>({id:String(id),displayNo:`ZZ-${id}`,title:`账号${id}`,status:'PAID',teamState:'READY',escalationState:'RUNNING',addRound:0})),nextCursor:end<rows.length?String(page.at(-1)):null};
    }finally{active--;}};
  const tick=async()=>act(async()=>{for(const fn of [...timers.values()])fn();await Promise.resolve();});
  await act(async()=>root.render(createElement(OrderTeamPanel,{identity:'admin-race',realm:'admin',client:null,connection:'idle',active:true,request,onAuthError:()=>{}})));
  await until(()=>ids().length===20);
  const slot={entered:false,release:null};hold=slot;
  const more=[...node.querySelectorAll('.order-team-list button')].find(button=>button.textContent.includes('更多订单'));assert.ok(more);
  await act(async()=>more.click());await until(()=>slot.entered);
  rows=Array.from({length:51},(_,i)=>51-i);const beforeRefresh=calls.length;
  await tick();await settle();assert.equal(calls.length,beforeRefresh,'refresh waits for the in-flight load-more instead of racing it');assert.equal(maxActive,1);
  slot.release?.();await until(()=>ids().length===40);
  assert.deepEqual(ids(),rows.slice(0,40).map(String),'queued refresh uses the new head and its matching cursor chain');
  assert.deepEqual(calls.slice(-3),['31',null,'32'],'the next-page request finishes before refresh recomputes its cursor');
  assert.equal(new Set(ids()).size,ids().length);assert.equal(maxActive,1);
});

test('pending paginated refresh cannot continue or queue more orders after true unmount',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const timers=new Map();let timerId=0,unmounted=false,hold=false,release=null;
  const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,5000);timers.set(++timerId,fn);return timerId;};globalThis.clearInterval=id=>timers.delete(id);
  const node=document.createElement('div'),root=createRoot(node);document.body.append(node);
  t.after(async()=>{if(!unmounted)await act(async()=>root.unmount());globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;await vite.close();browser.happyDOM.abort();});
  const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
  const until=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await settle();}throw Error('unmount isolation condition timed out');};
  const calls=[];
  const row=id=>({id:String(id),displayNo:`ZZ-${id}`,title:`账号${id}`,status:'PAID',teamState:'READY',escalationState:'RUNNING',addRound:0});
  const request=async path=>{const cursor=new URL(path,'http://127.0.0.1:4311').searchParams.get('cursor');calls.push({cursor,afterUnmount:unmounted});
    if(hold&&cursor===null){hold=false;await new Promise(resolve=>{release=resolve;});}
    return cursor?{items:[row(20)],nextCursor:'19'}:{items:Array.from({length:20},(_,i)=>row(40-i)),nextCursor:'21'};};
  await act(async()=>root.render(createElement(OrderTeamPanel,{identity:'admin-unmount',realm:'admin',client:null,connection:'idle',active:true,request,onAuthError:()=>{}})));
  await until(()=>node.textContent.includes('ZZ-40'));
  const firstMore=[...node.querySelectorAll('button')].find(el=>el.textContent==='更多订单');assert.ok(firstMore);await act(async()=>firstMore.click());
  await until(()=>node.textContent.includes('ZZ-20'));
  hold=true;await act(async()=>{for(const fn of timers.values())fn();});await until(()=>release!==null);
  const queuedMore=[...node.querySelectorAll('button')].find(el=>el.textContent==='更多订单');assert.ok(queuedMore);
  queuedMore.disabled=false;await act(async()=>queuedMore.click());
  await act(async()=>root.unmount());unmounted=true;assert.equal(timers.size,0);
  await act(async()=>release());await settle();await settle();
  assert.deepEqual(calls.map(({cursor})=>cursor),[null,'21',null],'the response is held on the first page of a two-page refresh');
  assert.deepEqual(calls.filter(call=>call.afterUnmount),[],'unmounted response cannot start a continuation page or queued load-more');
  assert.equal(timers.size,0);
});

test('a refresh queued behind in-flight load-more cannot start after true unmount',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const timers=new Map();let timerId=0,unmounted=false,hold=false,release=null;
  const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{assert.equal(ms,5000);timers.set(++timerId,fn);return timerId;};globalThis.clearInterval=id=>timers.delete(id);
  const node=document.createElement('div'),root=createRoot(node);document.body.append(node);
  t.after(async()=>{if(!unmounted)await act(async()=>root.unmount());globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;await vite.close();browser.happyDOM.abort();});
  const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
  const until=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await settle();}throw Error('queued refresh unmount condition timed out');};
  const calls=[];const row=id=>({id:String(id),displayNo:`ZZ-${id}`,title:`账号${id}`,status:'PAID',teamState:'READY',escalationState:'RUNNING',addRound:0});
  const request=async path=>{const cursor=new URL(path,'http://127.0.0.1:4311').searchParams.get('cursor');calls.push({cursor,afterUnmount:unmounted});
    if(hold&&cursor==='21'){hold=false;await new Promise(resolve=>{release=resolve;});}
    return cursor?{items:Array.from({length:20},(_,i)=>row(20-i)),nextCursor:'1'}:{items:Array.from({length:20},(_,i)=>row(40-i)),nextCursor:'21'};};
  await act(async()=>root.render(createElement(OrderTeamPanel,{identity:'admin-queued-unmount',realm:'admin',client:null,connection:'idle',active:true,request,onAuthError:()=>{}})));
  await until(()=>node.textContent.includes('ZZ-40'));
  const more=[...node.querySelectorAll('button')].find(el=>el.textContent==='更多订单');assert.ok(more);hold=true;await act(async()=>more.click());await until(()=>release!==null);
  await act(async()=>{for(const fn of timers.values())fn();});
  await act(async()=>root.unmount());unmounted=true;assert.equal(timers.size,0);
  await act(async()=>release());await settle();await settle();
  assert.deepEqual(calls.map(({cursor})=>cursor),[null,'21'],'queued refresh is not issued after its load-more request settles');
  assert.deepEqual(calls.filter(call=>call.afterUnmount),[]);assert.equal(timers.size,0);
});

test('order panel gates image decoding and rejects blob history URLs',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,KeyboardEvent:browser.KeyboardEvent,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const pendingImages=[];
  class ControlledImage{naturalWidth=0;naturalHeight=0;onload=()=>{};onerror=()=>{};set src(value){this.value=value;pendingImages.push(this);}}
  Object.defineProperty(globalThis,'Image',{value:ControlledImage,configurable:true});
  Object.defineProperty(browser,'Image',{value:ControlledImage,configurable:true});
  const oldCreate=globalThis.URL.createObjectURL,oldRevoke=globalThis.URL.revokeObjectURL;let previewId=0;
  const showModal=browser.HTMLDialogElement.prototype.showModal;let modalCalls=0;
  browser.HTMLDialogElement.prototype.showModal=function(){modalCalls++;return showModal.call(this);};
  globalThis.URL.createObjectURL=()=>`blob:preview-${++previewId}`;globalThis.URL.revokeObjectURL=()=>{};
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const timers=[];const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>{if(ms===5000){timers.push(fn);return {fake:true};}return interval(fn,ms);};
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;globalThis.URL.createObjectURL=oldCreate;globalThis.URL.revokeObjectURL=oldRevoke;await vite.close();browser.happyDOM.abort();});
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:'2026-09-21T09:30:00.000Z',addRound:1,state:'RUNNING',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'buyer',accountId:'viewer',party:'BUYER',name:'买家甲',avatar:null}]};
  const history=[
    {messageClientId:'blob-history',messageServerId:'blob-history',conversationId:'viewer|2|1',senderId:'viewer',receiverId:'1',createTime:1,messageType:1,attachment:{imageId:'blob',url:'blob:http://127.0.0.1:4311/unsafe',name:'不可信图片',mimeType:'image/png',size:3}},
    {messageClientId:'safe-history',messageServerId:'safe-history',conversationId:'viewer|2|1',senderId:'viewer',receiverId:'1',createTime:2,messageType:1,attachment:{imageId:'safe',url:'/api/im/images/safe',name:'安全图片',mimeType:'image/png',size:3}},
  ];
  let sendCalls=0,lastDimensions;const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return history;},async sendText(){throw new Error('text should not be used');},async sendImage(cid,file,options){await options.authorize({conversationId:cid,operation:'send'});sendCalls+=1;lastDimensions={width:options.width,height:options.height,name:file.name};return {...history[1],messageClientId:`sent-${sendCalls}`,messageServerId:`sent-${sendCalls}`};}};
  const props={identity:'identity-image',realm:'user',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('image component condition timed out');};
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());await until(()=>node.textContent.includes('图片暂不可预览'));
  assert.equal(node.querySelector('img[src^="blob:"]'),null);
  const imageButton=node.querySelector('.order-team-image');assert.ok(imageButton);
  await act(async()=>{imageButton.focus();imageButton.click();});
  assert.equal(modalCalls,1,'preview must enter the native modal stack for Escape and focus containment');
  const dialog=node.querySelector('dialog');assert.ok(dialog?.open);
  const closeButton=dialog.querySelector('button');assert.ok(closeButton);
  for(const shiftKey of [false,true]){let tab;await act(async()=>{tab=new browser.KeyboardEvent('keydown',{key:'Tab',shiftKey,bubbles:true,cancelable:true});closeButton.dispatchEvent(tab);});assert.equal(tab.defaultPrevented,true);assert.equal(document.activeElement,closeButton);}
  let escapeBubbled=false;const watchEscape=event=>{if(event.key==='Escape')escapeBubbled=true;};document.addEventListener('keydown',watchEscape);
  let escape;await act(async()=>{escape=new browser.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});closeButton.dispatchEvent(escape);});document.removeEventListener('keydown',watchEscape);
  assert.equal(escape.defaultPrevented,true);assert.equal(escapeBubbled,false,'Escape must not reach the order panel');
  await until(()=>node.querySelector('dialog')===null&&document.activeElement===imageButton);
  await act(async()=>{imageButton.focus();imageButton.click();});await until(()=>node.querySelector('dialog')?.open);assert.equal(modalCalls,2);
  const cancelDialog=node.querySelector('dialog');
  await act(async()=>cancelDialog.dispatchEvent(new browser.Event('cancel',{bubbles:true,cancelable:true})));
  await until(()=>node.querySelector('dialog')===null&&document.activeElement===imageButton);
  const input=node.querySelector('input[type=file]');const file=new browser.File([new Uint8Array([0xff,0xd8,0xff])],'proof.png',{type:'image/png'});Object.defineProperty(input,'files',{configurable:true,value:[file]});await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));await until(()=>pendingImages.length===1);
  const submit=node.querySelector('form button[type=submit]');assert.equal(submit.disabled,true);await act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(sendCalls,0);
  const decoder=pendingImages.shift();decoder.naturalWidth=640;decoder.naturalHeight=360;decoder.onload();await until(()=>!submit.disabled);await act(async()=>submit.click());await until(()=>sendCalls===1);assert.deepEqual(lastDimensions,{width:640,height:360,name:'proof.png'});
});

test('admin fulfillment slot receives the frozen order inventory projection',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4312'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;await vite.close();browser.happyDOM.abort();});
  const frozenInventory=[{itemId:'item_a',quantity:'10',unit:'PIECE',pricingKind:'PER_UNIT',name:'物资A'}];
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,frozenInventory,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]};
  const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},async sendText(){throw new Error('text should not be used');}};
  const seen=[];
  const props={identity:'identity-slot',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{},renderFulfillment:context=>{seen.push(context);return createElement('div',null,'履约槽');}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('slot condition timed out');};
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());await until(()=>node.textContent.includes('履约槽'));
  assert.deepEqual(seen.at(-1).frozenInventory,frozenInventory,'the admin slot carries the frozen inventory projection, never a fabricated settlement field');
});

async function checkReturningDuringImageSend(t, outcome){
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const {NimImageSendError}=await vite.ssrLoadModule('/packages/im-client/src/nim-web-client.ts');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  const oldCreate=globalThis.URL?.createObjectURL,oldRevoke=globalThis.URL?.revokeObjectURL;
  let objectUrlsCreated=0;
  globalThis.URL=globalThis.URL||{};
  globalThis.URL.createObjectURL=()=>`blob:mock-${++objectUrlsCreated}`;
  globalThis.URL.revokeObjectURL=()=>{};
  const pendingImages=[];
  class ControlledImage{naturalWidth=0;naturalHeight=0;onload=()=>{};onerror=()=>{};set src(value){this.value=value;pendingImages.push(this);}}
  Object.defineProperty(globalThis,'Image',{value:ControlledImage,configurable:true});
  Object.defineProperty(browser,'Image',{value:ControlledImage,configurable:true});
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;if(oldCreate)globalThis.URL.createObjectURL=oldCreate;if(oldRevoke)globalThis.URL.revokeObjectURL=oldRevoke;await vite.close();browser.happyDOM.abort();});
  const accessMap={
    a:{orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]},
    b:{orderId:'b',displayNo:'ZZ-b',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'2',name:'订单b',gameName:'三角洲行动',account:{id:'account-b',title:'账号b'},viewerAccountId:'viewer',conversationId:'viewer|2|2',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服乙',avatar:null,responsible:true}]},
  };
  const request=async url=>{
    if(url.includes('/a/im?'))return accessMap.a;
    if(url.includes('/b/im?'))return accessMap.b;
    return {items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'},{id:'b',title:'账号b',displayNo:'ZZ-b',status:'PAID',teamState:'READY'}],nextCursor:null};
  };
  let sendImageCalls=0,retryImageCalls=0,retriedClientId=null,textCalls=0;
  let inFlightReject=null,inFlightResolve=null;
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},
    async sendText(){textCalls++;throw new Error('text must wait for image');},
    async sendImage(cid,file,options){
      await options.authorize({conversationId:cid,operation:'send'});
      sendImageCalls++;
      return new Promise((resolve,reject)=>{inFlightReject=reject;inFlightResolve=resolve;});
    },
    async retryImage(cid,messageClientId,options){
      await options.authorize({conversationId:cid,operation:'send'});
      retryImageCalls++;
      retriedClientId=messageClientId;
      return {messageClientId,messageServerId:'srv-retry-1',conversationId:cid,senderId:'viewer',receiverId:'1',createTime:20,messageType:1};
    }
  };
  const props={identity:'identity-switch-order',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('switch order condition timed out');};
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));
  await until(()=>node.textContent.includes('ZZ-a')&&node.textContent.includes('ZZ-b'));
  // Select order a
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());
  await until(()=>node.querySelector('input[type=file]')&&!node.querySelector('input[type=file]').disabled);
  // Stage an image
  const input=node.querySelector('input[type=file]');
  const file=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'order-a-proof.png',{type:'image/png'});
  Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await until(()=>pendingImages.length===1);
  const decoder=pendingImages.shift();decoder.naturalWidth=640;decoder.naturalHeight=360;
  await act(async()=>decoder.onload());
  await until(()=>node.textContent.includes('order-a-proof.png'));
  // Click send image
  await act(async()=>node.querySelector('form button[type=submit]').click());
  await until(()=>sendImageCalls===1&&inFlightReject!==null);
  // Switch to order b while image send is in-flight
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-b')).click());
  await until(()=>node.textContent.includes('账号b')||node.textContent.includes('ZZ-b'));
  // Return BEFORE the first result: the new child must respect the parent flight.
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());
  await until(()=>node.querySelector('.order-team-image-draft[data-state="SENDING"]'));
  const card=node.querySelector('.order-team-image-draft[data-state="SENDING"]');
  for(const button of card.querySelectorAll('button'))assert.equal(button.disabled,true,'in-flight retry and removal stay disabled after remount');
  assert.equal(node.querySelector('form button[type=submit]').disabled,true);
  const inputText=node.querySelector('textarea');
  await act(async()=>{Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(inputText,'new text');inputText.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(textCalls,0,'forced submit cannot bypass the parent flight');
  assert.equal(sendImageCalls,1,'returning early cannot mint another image message');
  if(outcome==='success'){
    await act(async()=>inFlightResolve({messageClientId:'original-success',messageServerId:'srv-success',conversationId:'viewer|2|1',senderId:'viewer',createTime:20,messageType:1}));
    await until(()=>!node.querySelector('.order-team-image-draft'));
    assert.equal(retryImageCalls,0);
    return;
  }
  // Now in-flight request settles with UNKNOWN
  await act(async()=>inFlightReject(new NimImageSendError('UNKNOWN','结果未确认',{messageClientId:'img-client-unknown-1'})));
  await settle();
  await until(()=>node.textContent.includes('原消息重试'));
  assert.equal(sendImageCalls,1,'must not have made additional sendImage calls');
  assert.equal(node.textContent.includes('结果未确认'),true,'retained UNKNOWN status');
  // Click retry
  const retryBtn=[...node.querySelectorAll('button')].find(b=>b.textContent.includes('原消息重试'));
  assert.ok(retryBtn);
  await act(async()=>retryBtn.click());
  await until(()=>retryImageCalls===1);
  assert.equal(retriedClientId,'img-client-unknown-1','retried using original messageClientId rather than sending a new message');
  await until(()=>!node.textContent.includes('原消息重试'));
}

test('returning to an order before image UNKNOWN cannot retry, remove or submit; receipt retains original id', t=>checkReturningDuringImageSend(t,'unknown'));
test('returning to an order before image success keeps parent lock until its original receipt', t=>checkReturningDuringImageSend(t,'success'));

test('closing window with visible=false pauses sequential image queue without dropping staged images',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  const oldCreate=globalThis.URL?.createObjectURL,oldRevoke=globalThis.URL?.revokeObjectURL;
  let objectUrlsCreated=0;
  globalThis.URL=globalThis.URL||{};
  globalThis.URL.createObjectURL=()=>`blob:mock-${++objectUrlsCreated}`;
  globalThis.URL.revokeObjectURL=()=>{};
  const pendingImages=[];
  class ControlledImage{naturalWidth=0;naturalHeight=0;onload=()=>{};onerror=()=>{};set src(value){this.value=value;pendingImages.push(this);}}
  Object.defineProperty(globalThis,'Image',{value:ControlledImage,configurable:true});
  Object.defineProperty(browser,'Image',{value:ControlledImage,configurable:true});
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;if(oldCreate)globalThis.URL.createObjectURL=oldCreate;if(oldRevoke)globalThis.URL.revokeObjectURL=oldRevoke;await vite.close();browser.happyDOM.abort();});
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]};
  const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  let sendImageCalls=0;
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},
    async sendText(){throw new Error('text not used');},
    async sendImage(cid,file,options){
      await options.authorize({conversationId:cid,operation:'send'});
      sendImageCalls++;
      return {messageClientId:`sent-${sendImageCalls}`,messageServerId:`srv-${sendImageCalls}`,conversationId:cid,senderId:'viewer',receiverId:'1',createTime:sendImageCalls,messageType:1};
    }
  };
  const renderPanel=v=>root.render(createElement(OrderTeamPanel,{identity:'identity-visible-pause',realm:'admin',client,connection:'CONNECTED',active:true,visible:v,request,onAuthError:()=>{}}));
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('visible pause condition timed out');};
  await act(async()=>renderPanel(true));
  await until(()=>node.textContent.includes('ZZ-a'));
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());
  await until(()=>node.querySelector('input[type=file]')&&!node.querySelector('input[type=file]').disabled);
  // Stage 2 images
  const input=node.querySelector('input[type=file]');
  const file1=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'p1.png',{type:'image/png'});
  const file2=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'p2.png',{type:'image/png'});
  Object.defineProperty(input,'files',{configurable:true,value:[file1,file2]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await until(()=>pendingImages.length===2);
  const d1=pendingImages.shift();d1.naturalWidth=640;d1.naturalHeight=360;await act(async()=>d1.onload());
  const d2=pendingImages.shift();d2.naturalWidth=640;d2.naturalHeight=360;await act(async()=>d2.onload());
  await until(()=>node.textContent.includes('p1.png')&&node.textContent.includes('p2.png'));
  // Hide window
  await act(async()=>renderPanel(false));
  // Submit attempt: send loop should immediately break
  await act(async()=>node.querySelector('form button[type=submit]').click());
  await settle();
  assert.equal(sendImageCalls,0,'nothing dispatched while visible is false');
  // Re-open window
  await act(async()=>renderPanel(true));
  await until(()=>node.textContent.includes('p1.png')&&node.textContent.includes('p2.png'));
  // Submit now: both should send sequentially
  await act(async()=>node.querySelector('form button[type=submit]').click());
  await until(()=>sendImageCalls===2);
  assert.equal(sendImageCalls,2,'both images successfully dispatched after reopening');
});

test('async image decoding interleaving: selecting or removing during in-flight decode does not block remaining images',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  const oldCreate=globalThis.URL?.createObjectURL,oldRevoke=globalThis.URL?.revokeObjectURL;
  let objectUrlsCreated=0;
  globalThis.URL=globalThis.URL||{};
  globalThis.URL.createObjectURL=()=>`blob:mock-${++objectUrlsCreated}`;
  globalThis.URL.revokeObjectURL=()=>{};
  const pendingImages=[];
  class ControlledImage{naturalWidth=0;naturalHeight=0;onload=()=>{};onerror=()=>{};set src(value){this.value=value;pendingImages.push(this);}}
  Object.defineProperty(globalThis,'Image',{value:ControlledImage,configurable:true});
  Object.defineProperty(browser,'Image',{value:ControlledImage,configurable:true});
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;if(oldCreate)globalThis.URL.createObjectURL=oldCreate;if(oldRevoke)globalThis.URL.revokeObjectURL=oldRevoke;await vite.close();browser.happyDOM.abort();});
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,supportEscalation:{firstResponseAt:null,remindDueAt:null,addRound:0,state:'NOT_STARTED',needsManualReview:false,noEligibleStaff:false},members:[{platformId:'viewer',accountId:'viewer',party:'STAFF',name:'客服甲',avatar:null,responsible:true}]};
  const request=async url=>url.includes('/im?')?access:{items:[{id:'a',title:'账号a',displayNo:'ZZ-a',status:'PAID',teamState:'READY'}],nextCursor:null};
  let sendImageCalls=0;
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},
    async getMessageHistory(cid,_limit,_anchor,authorize){await authorize({conversationId:cid,operation:'read'});return[];},
    async sendText(){throw new Error('text not used');},
    async sendImage(cid,file,options){
      await options.authorize({conversationId:cid,operation:'send'});
      sendImageCalls++;
      return {messageClientId:`sent-${sendImageCalls}`,messageServerId:`srv-${sendImageCalls}`,conversationId:cid,senderId:'viewer',receiverId:'1',createTime:sendImageCalls,messageType:1};
    }
  };
  const props={identity:'identity-decode-interleave',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('decode interleave condition timed out');};
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));
  await until(()=>node.textContent.includes('ZZ-a'));
  await act(async()=>[...node.querySelectorAll('button')].find(b=>b.textContent.includes('ZZ-a')).click());
  await until(()=>node.querySelector('input[type=file]')&&!node.querySelector('input[type=file]').disabled);
  // Pick first batch of 2 images: a1 and a2
  const input=node.querySelector('input[type=file]');
  const a1=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'a1.png',{type:'image/png'});
  const a2=new browser.File([new Uint8Array([0x89,0x50,0x4e,0x47])],'a2.png',{type:'image/png'});
  Object.defineProperty(input,'files',{configurable:true,value:[a1,a2]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await until(()=>pendingImages.length===2);
  const decA2=pendingImages[1];
  // While decA1 and decA2 are in flight, remove a1
  const removeButtons=[...node.querySelectorAll('.order-team-image-draft button')].filter(b=>b.textContent==='移除');
  assert.equal(removeButtons.length,2);
  await act(async()=>removeButtons[0].click());
  // Now decA2 completes decoding
  decA2.naturalWidth=640;decA2.naturalHeight=360;
  await act(async()=>decA2.onload());
  await until(()=>!node.textContent.includes('正在检查')&&node.textContent.includes('a2.png'));
  // Button should not be disabled due to decoding
  const submit=node.querySelector('form button[type=submit]');
  assert.equal(submit.disabled,false,'a2 is READY and submit is not blocked by removal of a1');
  await act(async()=>submit.click());
  await until(()=>sendImageCalls===1);
  assert.equal(sendImageCalls,1,'a2 sent successfully');
});

test('zero accessible orders render one whole-area state and never a dead split, and the refresh control is not an authorization action',async(t)=>{
  const browser=new Window({url:'http://127.0.0.1:4311'});
  Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,requestAnimationFrame:browser.requestAnimationFrame.bind(browser),IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const {createRoot}=await import('react-dom/client');
  const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],server:{middlewareMode:true,hmr:false}});
  const {OrderTeamPanel}=await vite.ssrLoadModule('/packages/ui/src/order-team-panel.tsx');
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  globalThis.setInterval=(fn,ms)=>ms===5000?{fake:true}:interval(fn,ms);
  globalThis.clearInterval=id=>{if(!id?.fake)clear(id);};
  let mode='empty';
  const listPaths=[];
  const request=async url=>{
    if(url.includes('/im?'))throw new Error('no order is selected in this scenario');
    listPaths.push(url);
    if(mode==='empty')return{items:[],nextCursor:null};
    if(mode==='network')throw new TypeError('Failed to fetch');
    throw Object.assign(new Error('forbidden'),{status:403});
  };
  const client={accountId:'viewer',transport:'local-fake',onMessages:()=>()=>{},getMessageHistory:async()=>[],sendText:async()=>{}};
  const props={identity:'identity-empty',realm:'admin',client,connection:'CONNECTED',active:true,request,onAuthError:()=>{}};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('order empty-state condition timed out');};
  t.after(async()=>{await act(async()=>root.unmount());globalThis.setInterval=interval;globalThis.clearInterval=clear;await vite.close();browser.happyDOM.abort();});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));
  await until(()=>node.querySelector('.order-team-empty'));
  // 成功的零条只留一个整区空态；不能再同时出现"暂无订单"和"请选择订单"两半。
  assert.equal(node.querySelector('.order-team-grid'),null,'zero orders do not render the two-column grid');
  assert.equal(node.querySelectorAll('.order-team-empty').length,1,'exactly one empty state');
  assert.match(node.querySelector('.order-team-empty').textContent,/暂无可访问的订单/);
  assert.doesNotMatch(node.textContent,/选择订单查看群状态和沟通记录|暂无订单/);
  assert.equal(node.querySelector('.order-team-empty').getAttribute('role'),'status','a successful empty list is not an error');
  // 正常读取下工具栏不是授权语义。
  const refresh=()=>[...node.querySelectorAll('.order-team-toolbar button')].find(b=>/^(刷新|重新确认授权)$/.test(b.textContent.trim()));
  assert.equal(refresh().textContent.trim(),'刷新');

  // 读取失败与失权分开表达，只有真的失权才出现"重新确认授权"。
  mode='network';
  await act(async()=>refresh().click());
  await until(()=>node.querySelector('.order-team-empty[role=alert]'));
  assert.match(node.querySelector('.order-team-empty').textContent,/订单列表读取失败/);
  assert.equal(refresh().textContent.trim(),'刷新','a read failure is not an authorization problem');
  assert.ok(node.querySelector('.order-team-empty button'),'a read failure offers a plain retry');

  mode='forbidden';
  await act(async()=>[...node.querySelectorAll('.order-team-empty button')][0].click());
  await until(()=>refresh().textContent.trim()==='重新确认授权');
  assert.match(node.querySelector('.order-team-empty').textContent,/暂时无法访问订单群/);

  mode='empty';
  await act(async()=>refresh().click());
  await until(()=>node.querySelector('.order-team-empty')&&refresh().textContent.trim()==='刷新');
  assert.match(node.querySelector('.order-team-empty').textContent,/暂无可访问的订单/);
});
