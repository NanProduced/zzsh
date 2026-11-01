import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountAuthComponent,deferred} from './react-auth-harness.mjs';
import * as api from '../src/lib/profile-avatar-client.ts';
const presets=['strike','night','frost','aurora'].map(name=>({presetId:'avatar-'+name,version:1,url:'/api/v1/profile/avatars/presets/avatar-'+name+'/1/content',width:256,height:256}));
const state=(id='user_A',preset='avatar-strike',version='1')=>({revision:version,updatedAt:null,current:{kind:'DEFAULT',assetId:null,presetId:preset,url:'/api/v1/profile/avatars/user/'+id+'/'+version,currentVersion:version},defaultPresetId:'avatar-strike',presets,pending:null,lastReview:null});
const clickElement=async(p,el)=>{assert(el);await p.React.act(async()=>el.click());await p.settle();};
const choose=async(p,index=1)=>clickElement(p,p.host.querySelectorAll('.avatar-preset')[index]);
async function file(p){const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;URL.createObjectURL=()=> 'blob:avatar-test';URL.revokeObjectURL=()=>{};const input=p.host.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[new p.window.File([new Uint8Array([1,2,3])],'avatar.png',{type:'image/png'})]});await p.React.act(async()=>input.dispatchEvent(new p.window.Event('change',{bubbles:true})));await p.settle();return()=>{URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;};}
const mount=overrides=>mountAuthComponent('apps/web/src/components/account/avatar-edit.tsx','AvatarEditEntry',{userId:'user_A'},{initialStatus:'authenticated',stubModules:{'@/lib/profile-avatar-client':{...api,readAvatarState:async()=>state(),...overrides}}});

test('Root: unknown default selection survives remount and recovers by original GET only',async()=>{
 let writes=0,originalKey,readKey;const p=await mount({selectDefaultAvatar:async(_preset,_rev,key)=>{writes++;originalKey=key;throw new api.ProfileAvatarError('network',0,'NETWORK');},readAvatarOperationResult:async key=>{readKey=key;return{receipt:'RECORDED',responseStatus:200,result:state('user_A','avatar-night','2')};}});
 try{await p.click('更换头像');await choose(p);assert.equal(writes,1);assert.match(p.host.textContent,/上次头像选择结果待确认/);assert(!JSON.stringify([...Array(p.window.sessionStorage.length)].map((_,i)=>p.window.sessionStorage.getItem(p.window.sessionStorage.key(i)))).includes('uploadToken'));
 await p.render({key:'cold'});await p.click('更换头像');await p.click('读取原头像结果');assert.equal(writes,1);assert.equal(readKey,originalKey);assert.equal(api.readPendingAvatarDefault('user_A'),null);
 }finally{await p.close();}
});
test('Root: an old identity write cannot leave the next identity busy or refresh its session',async()=>{
 const write=deferred();const p=await mount({readAvatarState:async()=>state(p?.identity.userId??'user_A'),selectDefaultAvatar:()=>write.promise});
 try{await p.click('更换头像');await choose(p);p.identity.userId='user_B';p.identity.identityVersion++;await p.render({userId:'user_B'});await p.click('更换头像');await p.React.act(async()=>write.resolve(state('user_A','avatar-night','2')));await p.settle();assert.equal(p.confirmations,0);assert.equal(p.host.querySelector('.avatar-current img').getAttribute('src'),state('user_B').current.url);assert.equal(p.host.querySelector('fieldset').disabled,false);
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
