import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountAuthComponent,deferred} from '../../web/test/react-auth-harness.mjs';
import * as api from '../src/views/self-settings/avatar-api.ts';
const presets=['strike','night','frost','aurora'].map(name=>({presetId:'avatar-'+name,version:1,url:'/api/v1/profile/avatars/presets/avatar-'+name+'/1/content',width:256,height:256}));
const state=(id='admin_A',preset='avatar-strike',version='1')=>({revision:version,updatedAt:null,current:{kind:'DEFAULT',assetId:null,presetId:preset,url:'/api/v1/profile/avatars/admin/'+id+'/'+version,currentVersion:version},defaultPresetId:'avatar-strike',presets,pending:null,lastReview:null});
const item=(id,name=id)=>({assetId:id,realm:'user',subjectId:'user_fixture',subjectName:name,submittedAt:'2026-11-01T00:00:00Z',width:256,height:256,byteSize:'3',mime:'image/webp',reviewState:'PENDING',accessClass:'PRIVATE_REVIEW',reviewReason:null,revision:'1'});
const snapshot=id=>({adminUserId:id,session:{id:'session_'+id,locked:false},security:{isBoss:true,status:'ACTIVE'},permissions:[]});
const primitives={Button:({children,...props})=>{const R=globalThis.__avatarReact;return R.createElement('button',props,children);},Avatar:({children,...props})=>globalThis.__avatarReact.createElement('div',props,children),AvatarImage:props=>globalThis.__avatarReact.createElement('img',props),AvatarFallback:({children})=>globalThis.__avatarReact.createElement('span',null,children),SettingsNotice:({children,...props})=>globalThis.__avatarReact.createElement('div',props,children),Input:props=>globalThis.__avatarReact.createElement('input',props),Dialog:({open,children})=>open?children:null,DialogContent:({children})=>globalThis.__avatarReact.createElement('div',{role:'dialog'},children),DialogTitle:({children})=>globalThis.__avatarReact.createElement('h2',null,children)};
const stubMap=boundary=>({'./avatar-api':{...api,...boundary},'./self-settings/avatar-api':{...api,...boundary},'../../components/ui/button':primitives,'../../components/ui/avatar':primitives,'./settings-shell':primitives,'../components/ui/button':primitives,'../components/ui/input':primitives,'../components/ui/dialog':primitives,'./self-settings/settings-shell':primitives});
async function mount(path,name,props,boundary){const{createRequire}=await import('node:module');const require=createRequire(import.meta.url);globalThis.__avatarReact=require('react');return mountAuthComponent(path,name,props,{stubModules:stubMap(boundary)});}
const clickElement=async(p,el)=>{assert(el);await p.React.act(async()=>el.click());await p.settle();};
const choose=async p=>clickElement(p,p.host.querySelectorAll('fieldset button')[1]);

test('Root: admin default UNKNOWN keeps its key and cold remount recovers without another POST',async()=>{
 let writes=0,key,readKey;const p=await mount('apps/admin/src/views/self-settings/avatar-editor.tsx','AdminAvatarEditor',{adminUserId:'admin_A',sessionId:'session_A',fallbackInitial:'A'},{readAdminAvatarState:async()=>state(),selectAdminDefaultAvatar:async(_preset,_revision,k)=>{key=k;writes++;throw new api.AdminAvatarError('unknown',0,'NETWORK');},readAdminAvatarOperationResult:async command=>{readKey=command.key;return{receipt:'RECORDED',responseStatus:200};}});
 try{await p.settle();await choose(p);assert.match(p.host.textContent,/上次头像选择结果待确认/);await p.render({key:'cold'});await p.settle();await p.click('读取原头像结果');assert.equal(writes,1);assert.equal(key,readKey);assert.equal(api.readPendingAdminAvatar('admin_A','default'),null);}finally{await p.close();}
});
test('Root: admin identity switch discards an old write and resets the next editor',async()=>{
 const pending=deferred();let actor='admin_A',refreshes=0;const p=await mount('apps/admin/src/views/self-settings/avatar-editor.tsx','AdminAvatarEditor',{adminUserId:actor,sessionId:'session_A',fallbackInitial:'A',onSessionRefresh:()=>refreshes++},{readAdminAvatarState:async()=>state(actor),selectAdminDefaultAvatar:()=>pending.promise});
 try{await p.settle();await choose(p);actor='admin_B';await p.render({adminUserId:actor,sessionId:'session_B'});await p.settle();await p.React.act(async()=>pending.resolve(state('admin_A','avatar-night','2')));await p.settle();assert.equal(refreshes,0);assert.equal(p.host.querySelector('fieldset').disabled,false);assert.equal(p.host.querySelector('img').getAttribute('src'),state(actor).current.url);}finally{await p.close();}
});
test('Root: a slow old review-filter result cannot replace the selected filter',async()=>{
 const old=deferred();const p=await mount('apps/admin/src/views/avatar-review-view.tsx','AvatarReviewView',{snapshot:snapshot('admin_A'),refreshNonce:0},{readAdminAvatarReviews:filter=>filter==='PENDING'?old.promise:Promise.resolve({items:[{...item('asset_new','新结果'),reviewState:'APPROVED',accessClass:'PUBLIC_DISPLAY'}],nextCursor:null})});
 try{await p.click('已通过');await p.React.act(async()=>old.resolve({items:[item('asset_old','旧结果')],nextCursor:null}));await p.settle();assert.match(p.host.textContent,/新结果/);assert.doesNotMatch(p.host.textContent,/旧结果/);}finally{await p.close();}
});
test('Root: review actor switch clears old rows and rejects late old response',async()=>{
 const old=deferred();let reads=0;const p=await mount('apps/admin/src/views/avatar-review-view.tsx','AvatarReviewView',{snapshot:snapshot('admin_A'),refreshNonce:0},{readAdminAvatarReviews:()=>++reads===1?old.promise:Promise.resolve({items:[item('asset_new','新身份')],nextCursor:null})});
 try{await p.render({snapshot:snapshot('admin_B')});await p.settle();await p.React.act(async()=>old.resolve({items:[item('asset_old','旧身份')],nextCursor:null}));await p.settle();assert.match(p.host.textContent,/新身份/);assert.doesNotMatch(p.host.textContent,/旧身份/);}finally{await p.close();}
});
test('Root: review CAS is fixed and UNKNOWN recovers by original result without a second command',async()=>{
 let writes=0,key,readKey;const p=await mount('apps/admin/src/views/avatar-review-view.tsx','AvatarReviewView',{snapshot:snapshot('admin_A'),refreshNonce:0},{readAdminAvatarReviews:async()=>({items:[item('asset_1')],nextCursor:null}),reviewAdminAvatar:async(_id,_decision,_reason,revision,k)=>{assert.equal(revision,'1');key=k;writes++;throw new api.AdminAvatarError('unknown',0,'NETWORK');},readAdminAvatarOperationResult:async command=>{readKey=command.key;return{receipt:'RECORDED',responseStatus:200};}});
 try{await p.settle();await p.click('通过');const cas=p.host.querySelector('input[aria-label="原审核版本"]');assert(cas);assert.equal(cas.readOnly,true);await p.click('确认');assert.match(p.host.textContent,/原审核操作结果待确认/);await p.click('读取原审核结果');assert.equal(writes,1);assert.equal(readKey,key);assert.equal(api.readPendingAdminAvatar('admin_A','review'),null);}finally{await p.close();}
});
test('Root: malformed 2xx review receipt preserves the original command',async()=>{
 const p=await mount('apps/admin/src/views/avatar-review-view.tsx','AvatarReviewView',{snapshot:snapshot('admin_A'),refreshNonce:0},{readAdminAvatarReviews:async()=>({items:[item('asset_1')],nextCursor:null}),reviewAdminAvatar:async()=>({asset:{id:'another_asset'},review:{applied:true}})});
 try{await p.settle();await p.click('通过');await p.click('确认');assert.match(p.host.textContent,/审核回执与原头像不一致/);assert(api.readPendingAdminAvatar('admin_A','review'));assert.doesNotMatch(p.host.textContent,/审核已通过；/);}finally{await p.close();}
});
