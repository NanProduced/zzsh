import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountAuthComponent,deferred} from './react-auth-harness.mjs';
import {createElement} from 'react';
import {UserSessionStore} from '../src/lib/user-session-store.ts';
import * as api from '../src/lib/profile-avatar-client.ts';
const presets=['strike','night','frost','aurora'].map(name=>({presetId:'avatar-'+name,version:1,url:'/api/v1/profile/avatars/presets/avatar-'+name+'/1/content',width:256,height:256}));
const state=(id='user_A',preset='avatar-strike',version='1')=>({revision:version,updatedAt:null,current:{kind:'DEFAULT',assetId:null,presetId:preset,url:'/api/v1/profile/avatars/user/'+id+'/'+version,currentVersion:version},defaultPresetId:'avatar-strike',presets,pending:null,lastReview:null});
const clickElement=async(p,el)=>{assert(el);await p.React.act(async()=>el.click());await p.settle();};
const choose=async(p,index=1)=>{await clickElement(p,p.host.querySelectorAll('.avatar-preset')[index]);await p.click('使用此头像');};
async function file(p){await p.click('上传图片');const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=()=> 'blob:avatar-test';URL.revokeObjectURL=()=>{};const input=p.host.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[new p.window.File([new Uint8Array([1,2,3])],'avatar.png',{type:'image/png'})]});await p.React.act(async()=>input.dispatchEvent(new p.window.Event('change',{bubbles:true})));await p.settle();await p.click('完成裁剪');return()=>{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;};}
// Crop bytes are a boundary fixture here; actual canvas/zoom/pixel output is checked in Chromium.
const cropBoundary={AvatarCropper:({file,onConfirm,onCancel})=>createElement('div',{'aria-label':'裁剪头像'},createElement('button',{type:'button',onClick:()=>onConfirm(file)},'完成裁剪'),createElement('button',{type:'button',onClick:onCancel},'返回选择'))};
const mount=(overrides,props={})=>mountAuthComponent('apps/web/src/components/account/avatar-edit.tsx','AvatarEditEntry',{userId:'user_A',...props},{initialStatus:'authenticated',stubModules:{'@zzsh/ui/avatar-crop':cropBoundary,'@/lib/profile-avatar-client':{...api,readAvatarState:async()=>state(),...overrides}}});

test('avatar picture itself is the named edit control, without a second text action',async()=>{
 const p=await mount({}, {children:createElement('span',{'data-hero-avatar':true},'头像画面')});
 try{const trigger=p.findButton('更换头像');assert(trigger.querySelector('[data-hero-avatar]'));assert.equal(trigger.textContent,'头像画面');await p.click('更换头像');assert(p.host.querySelector('[role=dialog]'));assert.equal(p.host.querySelectorAll('.avatar-selection-preview img').length,1);assert.equal(p.host.querySelector('.avatar-current'),null)}finally{await p.close()}
});

test('preset selection is only a preview; cancel makes no command and explicit confirm shows success',async()=>{
 let writes=0;const p=await mount({selectDefaultAvatar:async preset=>{writes++;return state('user_A',preset,'2')}});
 try{await p.click('更换头像');assert.equal(p.findButton('使用此头像').disabled,true);await clickElement(p,p.host.querySelectorAll('.avatar-preset')[1]);assert.equal(writes,0);assert.equal(p.profileNotices.length,0);assert.equal(p.host.querySelector('.avatar-selection-preview img').getAttribute('src'),presets[1].url);await p.click('取消');assert.equal(writes,0);assert.equal(p.host.querySelector('[role=dialog]'),null);await p.click('更换头像');await choose(p);assert.equal(writes,1);assert.equal(p.host.querySelector('[role=dialog]'),null);assert.deepEqual(p.profileNotices,[{userId:'user_A',kind:'avatar'}])}finally{await p.close()}
});

test('profile success notice survives child unmount and refresh loading, then clears on a confirmed identity switch or logout',async()=>{
 const pending=deferred();let reads=0;const store=new UserSessionStore({session:async()=>++reads===1?{userId:'user_A'}:reads===2?pending.promise:{userId:null},signOut:async()=>true});
 const provider='apps/web/src/components/session/user-session-provider.tsx',p=await mountAuthComponent(provider,'UserSessionProvider',{children:createElement('div',{'data-editor':true},'编辑器')},{stubModules:{'@/lib/user-session-client':{USER_SESSION_CHANNEL:'profile-notice-test',createBrowserUserSessionStore:()=>store,performSignOut:async()=>{},publishUserSessionChange(){}}}});
 try{await p.settle();const publish=p.loadSource(provider).publishProfileUpdateNotice;await p.React.act(async()=>publish('foreign','avatar'));assert.equal(p.host.querySelector('.profile-change-toast'),null);await p.React.act(async()=>publish('user_A','avatar'));assert.match(p.host.textContent,/头像已更新/);let refresh;await p.React.act(async()=>{refresh=store.confirm();await Promise.resolve()});await p.render({children:null});assert.equal(store.getSnapshot().status,'loading');assert.match(p.host.textContent,/头像已更新/);await p.React.act(async()=>{pending.resolve({userId:'user_B'});await refresh});assert.equal(p.host.querySelector('.profile-change-toast'),null);await p.React.act(async()=>publish('user_B','nickname'));assert.match(p.host.textContent,/昵称已更新/);await p.React.act(async()=>store.confirm());assert.equal(p.host.querySelector('.profile-change-toast'),null)}finally{await p.close()}
});

test('profile success notice has a six-second expiry and can be dismissed without changing session authority',async()=>{
 const store=new UserSessionStore({session:async()=>({userId:'user_A'}),signOut:async()=>true}),provider='apps/web/src/components/session/user-session-provider.tsx',oldTimer=globalThis.setTimeout;let expiry;
 globalThis.setTimeout=(fn,ms,...args)=>{if(ms===6000)expiry=fn;return oldTimer(fn,ms,...args)};
 const p=await mountAuthComponent(provider,'UserSessionProvider',{}, {stubModules:{'@/lib/user-session-client':{USER_SESSION_CHANNEL:'profile-notice-ttl-test',createBrowserUserSessionStore:()=>store,performSignOut:async()=>{},publishUserSessionChange(){}}}});
 try{await p.settle();const publish=p.loadSource(provider).publishProfileUpdateNotice;await p.React.act(async()=>publish('user_A','nickname'));assert.equal(typeof expiry,'function');await p.React.act(async()=>expiry());assert.equal(p.host.querySelector('.profile-change-toast'),null);await p.React.act(async()=>publish('user_A','avatar'));await p.click('关闭资料更新提示');assert.equal(p.host.querySelector('.profile-change-toast'),null);assert.equal(store.getSnapshot().userId,'user_A');assert.equal(store.getSnapshot().status,'authenticated')}finally{await p.close();globalThis.setTimeout=oldTimer}
});

test('closing an uncertain upload preserves its original preparation key for a later explicit retry',async()=>{
 const first=deferred();let keys=[],uploads=0;const p=await mount({createAvatarUploadIntent:async(_file,key)=>{keys.push(key);if(keys.length===1)return first.promise;return{intentId:'intent_same',uploadToken:'same_token'}},uploadAvatar:async()=>uploads++});let restore=()=>{};
 try{await p.click('更换头像');restore=await file(p);await p.click('上传并提交审核');await p.click('关闭头像设置');await p.React.act(async()=>first.resolve({intentId:'intent_same',uploadToken:'same_token'}));await p.settle();assert.equal(uploads,0);await p.click('更换头像');await p.click('上传并提交审核');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(uploads,1)}finally{await p.close();restore()}
});

test('Root: unknown default selection survives remount and recovers by original GET only',async()=>{
 let writes=0,originalKey,readKey;const p=await mount({selectDefaultAvatar:async(_preset,_rev,key)=>{writes++;originalKey=key;throw new api.ProfileAvatarError('network',0,'NETWORK');},readAvatarOperationResult:async key=>{readKey=key;return{receipt:'RECORDED',responseStatus:200,result:state('user_A','avatar-night','2')};}});
 try{await p.click('更换头像');await choose(p);assert.equal(writes,1);assert.match(p.host.textContent,/上次头像选择结果待确认/);assert(!JSON.stringify([...Array(p.window.sessionStorage.length)].map((_,i)=>p.window.sessionStorage.getItem(p.window.sessionStorage.key(i)))).includes('uploadToken'));
 await p.render({key:'cold'});await p.click('更换头像');await p.click('读取原头像结果');assert.equal(writes,1);assert.equal(readKey,originalKey);assert.equal(api.readPendingAvatarDefault('user_A'),null);
 }finally{await p.close();}
});
test('Root: an old identity write cannot leave the next identity busy or refresh its session',async()=>{
 const write=deferred();const p=await mount({readAvatarState:async()=>state(p?.identity.userId??'user_A'),selectDefaultAvatar:()=>write.promise});
 try{await p.click('更换头像');await choose(p);p.identity.userId='user_B';p.identity.identityVersion++;await p.render({userId:'user_B'});await p.click('更换头像');await p.React.act(async()=>write.resolve(state('user_A','avatar-night','2')));await p.settle();assert.equal(p.confirmations,0);assert.equal(p.host.querySelector('.avatar-selection-preview img').getAttribute('src'),state('user_B').current.url);assert.equal(p.host.querySelector('fieldset').disabled,false);
 }finally{await p.close();}
});
test('Root: removing the file preview does not abort the post-upload state read',async()=>{
 const after=deferred();let reads=0,signal;const p=await mount({readAvatarState:async nextSignal=>{reads++;if(reads===1)return state();signal=nextSignal;return after.promise;},createAvatarUploadIntent:async()=>({intentId:'intent_fixture',uploadToken:'synthetic_token'}),uploadAvatar:async()=>{}});let restore=()=>{};
 try{await p.click('更换头像');restore=await file(p);await p.click('上传并提交审核');assert(signal);assert.equal(signal.aborted,false);await p.React.act(async()=>after.resolve({...state(),pending:{assetId:'asset_pending',submittedAt:null,reviewState:'PENDING',width:256,height:256,byteSize:'3'}}));await p.settle();assert.match(p.host.textContent,/新头像审核中/);
 }finally{await p.close();restore();}
});
test('Root: closing during intent creation cannot dispatch a hidden byte upload',async()=>{
 const intent=deferred();let uploads=0;const p=await mount({createAvatarUploadIntent:()=>intent.promise,uploadAvatar:async()=>uploads++});let restore=()=>{};
 try{await p.click('更换头像');restore=await file(p);await p.click('上传并提交审核');await p.click('关闭头像设置');await p.React.act(async()=>intent.resolve({intentId:'intent_fixture',uploadToken:'synthetic_token'}));await p.settle();assert.equal(uploads,0);
 }finally{await p.close();restore();}
});
test('Root: retrying an uncertain intent keeps the original creation key',async()=>{
 const keys=[];let writes=0;const p=await mount({createAvatarUploadIntent:async(_file,key)=>{keys.push(key);if(keys.length===1)throw new api.ProfileAvatarError('unknown',0,'NETWORK');return{intentId:'intent_fixture',uploadToken:'synthetic_token'};},uploadAvatar:async()=>writes++});let restore=()=>{};
 try{await p.click('更换头像');restore=await file(p);await p.click('上传并提交审核');await p.click('上传并提交审核');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(writes,1);
 }finally{await p.close();restore();}
});
