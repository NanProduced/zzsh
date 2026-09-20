import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {act,createElement} from 'react';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

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
  const access=id=>({orderId:id,displayNo:`ZZ-${id}`,orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:id==='a'?'1':'2',name:`订单${id}`,gameName:'三角洲行动',account:{id:`account-${id}`,title:`账号${id}`},viewerAccountId:'viewer',conversationId:`viewer|2|${id==='a'?'1':'2'}`,canRead:true,canSend:true,members:[{platformId:'buyer',accountId:'viewer',party:'BUYER',name:'买家甲',avatar:null}]});
  const message=id=>({messageClientId:id,conversationId:access(id).conversationId,senderId:'viewer',receiverId:access(id).teamId,createTime:1,text:`历史${id}`,messageType:0});
  let policy='ok',release,waiting=false,historyCalls=0,sendCalls=0,subscribes=0;const authErrors=[];
  const request=async url=>{
    if(!url.includes('/im?'))return {items:['a','b'].map(id=>({id,title:`账号${id}`,displayNo:`ZZ-${id}`,status:'PAID',teamState:'READY'})),nextCursor:null};
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
  const props={identity:'identity-a',realm:'user',client,connection:'CONNECTED',active:true,request,onAuthError:status=>authErrors.push(status)};
  const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,5));});
  const until=async predicate=>{for(let n=0;n<150;n++){if(predicate())return;await settle();}throw new Error('order component condition timed out');};
  const click=async text=>{const button=[...node.querySelectorAll('button')].find(b=>b.textContent.includes(text));assert.ok(button,text);await act(async()=>button.click());};
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));assert.equal(subscribes,1);
  await type('A草稿');assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='delay';await act(async()=>node.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await until(()=>waiting);
  await click('ZZ-b');await until(()=>node.textContent.includes('历史b'));assert.equal(node.querySelector('textarea').value,'');
  await act(async()=>release());await settle();assert.equal(sendCalls,0);assert.doesNotMatch(node.textContent,/历史a|A草稿/);
  policy='ok';await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'A草稿');
  await act(async()=>root.render(createElement(OrderTeamPanel,{...props,active:false})));
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));
  await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='send-denied';await click('重新确认授权');await until(()=>[...node.querySelectorAll('button')].some(b=>b.textContent==='发送文字'&&b.disabled));
  assert.match(node.textContent,/历史a/);assert.equal(node.querySelector('textarea').value,'A草稿');
  policy='network';await click('重新确认授权');await until(()=>node.textContent.includes('检查网络'));assert.match(node.textContent,/历史a/);
  policy='read-denied';const before=historyCalls;await click('重新确认授权');await until(()=>!node.querySelector('textarea'));assert.doesNotMatch(node.textContent,/历史a|A草稿/);assert.equal(historyCalls,before);
  policy='ok';await click('重新确认授权');await until(()=>node.textContent.includes('历史a'));assert.equal(node.querySelector('textarea').value,'');
  await type('身份草稿');await act(async()=>root.render(createElement(OrderTeamPanel,{...props,key:'identity-b',identity:'identity-b'})));await until(()=>node.textContent.includes('ZZ-a'));assert.equal(node.querySelector('textarea'),null);
  for(const code of ['401','423']){policy=code;await click('ZZ-a');await until(()=>authErrors.includes(Number(code)));assert.equal(node.querySelector('textarea'),null);policy='ok';await click('重新确认授权');await until(()=>node.textContent.includes('ZZ-a'));await click('返回订单列表');}
  assert.doesNotMatch(node.textContent,/private/);
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
  const access={orderId:'a',displayNo:'ZZ-a',orderStatus:'PAID',assignmentState:'ASSIGNED',teamState:'READY',appId:'app',teamId:'1',name:'订单a',gameName:'三角洲行动',account:{id:'account-a',title:'账号a'},viewerAccountId:'viewer',conversationId:'viewer|2|1',canRead:true,canSend:true,members:[{platformId:'buyer',accountId:'viewer',party:'BUYER',name:'买家甲',avatar:null}]};
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
