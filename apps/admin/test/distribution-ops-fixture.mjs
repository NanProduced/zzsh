import { Window } from 'happy-dom';
import { act,createElement } from 'react';
import { createOfflineAdminSource } from './offline-admin-source.mjs';
import { fileURLToPath } from 'node:url';
export const rootPath=fileURLToPath(new URL('..',import.meta.url));
export const config={schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:false,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:7,levels:[{code:'OLD_BASE',rank:1,default:true,renterPercent:'1.5',ownerPercent:'0.5',upgrade:null}]};
export const known={knowledge:'KNOWN',policy:{versionId:'policy_1',revision:'3',digest:'d'.repeat(64),config,createdAt:'2026-10-01T00:00:00.000Z'}};
export const context={schema:'distribution-policy-change-context.v1',state:'EMPTY',request:null,contractReady:true,writeAssemblyReady:true,reasonCodes:[]};
export const flat={...known,policy:{...known.policy,config:{...config,schema:'distribution-policy.v2',rateMode:'UNIFORM',levels:[],renterPercent:'3',ownerPercent:'2'}},semanticsVersion:'distribution-policy.lifecycle.v2',changeContext:context};
export const operations={operations:[{operationCode:'distribution.policy.publish',businessType:'distribution',title:'调整分销政策',executionMode:'GENERIC_TRANSACTION',testOnly:false,initiation:{allowed:true,reasonCode:'ALLOWED',requiredPermission:'personal.distribution.policy.manage'},triggers:[{triggerCondition:'distribution.policy.publish.requested',templateVersion:1}]}]};
export const snap=(permissions=[],who='ops_1',session='session_1',boss=false)=>({authenticated:true,adminUserId:who,session:{id:session,locked:false,pinConfigured:true,createdAt:null,expiresAt:null},security:{isBoss:boss,status:'ACTIVE'},permissions,permissionCodes:permissions});
export const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
export const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,12));});
export async function setup(){
 const browser=new Window({url:'http://127.0.0.1:4396/'});
 Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,MouseEvent:browser.MouseEvent,sessionStorage:browser.sessionStorage,getComputedStyle:browser.getComputedStyle.bind(browser),requestAnimationFrame:cb=>setTimeout(()=>cb(Date.now()),0),cancelAnimationFrame:id=>clearTimeout(id),IS_REACT_ACT_ENVIRONMENT:true});
 const {createRoot}=await import('react-dom/client');const loader=await createOfflineAdminSource({root:rootPath});const roots=[];
 return{browser,loader,async mount(component,props){const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);roots.push(root);await act(async()=>root.render(createElement(component,props)));await settle();return{host,root};},async close(){for(const r of roots)await act(async()=>r.unmount());await loader.close();browser.happyDOM.cancelAsync();}};
}
export async function input(browser,element,value){const proto=element.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:browser.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new browser.Event('input',{bubbles:true}));element.dispatchEvent(new browser.Event('change',{bubbles:true}));});}
export async function click(element){await act(async()=>element.click());await settle();}
export const manager=['personal.distribution.policy.manage','approval.request.create'];
