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
  const type=async value=>act(async()=>{const input=node.querySelector('textarea');assert.ok(input);Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>root.render(createElement(OrderTeamPanel,props)));await until(()=>node.textContent.includes('ZZ-a'));
  assert.match(node.textContent,/待客服回应/);assert.match(node.textContent,/提醒节点/);assert.match(node.textContent,/接待跟踪未启用/);
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
  escalationB={firstResponseAt:null,remindDueAt:null,addRound:0,state:'EXHAUSTED',needsManualReview:true,noEligibleStaff:true};
  await click('ZZ-b');await until(()=>node.textContent.includes('历史b'));await click('重新确认授权');await until(()=>node.querySelector('.order-team-escalation')?.textContent.includes('当前没有符合条件的客服'));
  assert.match(node.querySelector('.order-team-escalation').textContent,/待人工处理/);
  escalationA={firstResponseAt:'2026-09-21T09:41:00.000Z',remindDueAt:null,addRound:1,state:'STOPPED',needsManualReview:false,noEligibleStaff:false};
  await click('ZZ-a');await until(()=>node.textContent.includes('历史a'));await click('重新确认授权');await until(()=>node.querySelector('.order-team-escalation')?.textContent.includes('首响时间'));
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
