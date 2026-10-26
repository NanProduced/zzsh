import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act,createElement } from 'react';
import { setup,snap,known,flat,operations,json,settle,click,manager } from './distribution-ops-fixture.mjs';

test('policy permissions and strict contract remain; direct policy PUT is not an approval substitute',async()=>{
 const h=await setup();const calls=[];
 globalThis.fetch=h.browser.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET'});return json(String(url).endsWith('/operations')?operations:known);};
 try{
  const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx');
  assert.throws(()=>m.parseDistributionPolicyRead({knowledge:'KNOWN',policy:{...known.policy,config:{...known.policy.config,scope:'GLOBAL'}}}));
  assert.throws(()=>m.parseDistributionPolicyRead({knowledge:'KNOWN',policy:{...known.policy,config:{...known.policy.config,levels:[]}}}));
  assert.throws(()=>m.parseDistributionPolicyRead([]));
  assert.equal(m.parseDistributionPolicyRead({knowledge:'UNKNOWN',policy:null,reason:'POLICY_NOT_CONFIGURED'}).knowledge,'UNKNOWN');
  let v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap([])});assert.match(v.host.textContent,/没有分销政策权限/);assert.equal(calls.length,0);
  await act(async()=>v.root.unmount());
  v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(['personal.distribution.policy.read'])});assert.equal(calls.at(-1).method,'GET');assert.match(v.host.textContent,/当前分销政策/);assert.equal(v.host.querySelector('textarea'),null);assert.equal(v.host.querySelector("[aria-label='切换分销政策开关']"),null);
  await click([...v.host.querySelectorAll('button')].find(b=>b.textContent.includes('当前记录为历史分级方案')));assert.match(v.host.textContent,/1\.5%/);
  await act(async()=>v.root.unmount());
  v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager)});assert.equal(v.host.querySelector("[aria-label='切换分销政策开关']"),null);assert.equal([...v.host.querySelectorAll('button')].find(b=>b.textContent.includes('申请调整政策')).disabled,true);assert(calls.every(c=>c.method==='GET'));
  await act(async()=>v.root.unmount());
  globalThis.fetch=h.browser.fetch=async()=>json({},503);
  v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap([], 'boss_1','boss_session',true)});assert.match(v.host.textContent,/未就绪/);assert.doesNotMatch(v.host.textContent,/%/);
 }finally{await h.close();}
});

test('permission revocation and A-B-A generation cannot revive an earlier policy GET',async()=>{
 const h=await setup(),pending=[];
 globalThis.fetch=h.browser.fetch=(url,init={})=>new Promise(resolve=>pending.push({url:String(url),init,resolve}));
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(['personal.distribution.policy.read'])});assert.equal(pending.length,1);
  await act(async()=>v.root.render(createElement(m.DistributionPolicyPanel,{snapshot:snap([])})));
  await act(async()=>v.root.render(createElement(m.DistributionPolicyPanel,{snapshot:snap(['personal.distribution.policy.read'])})));assert.equal(pending.length,2);
  await act(async()=>pending[0].resolve(json(known)));await settle();assert.doesNotMatch(v.host.textContent,/历史分级方案|1\.5%/);
  await act(async()=>pending[1].resolve(json(flat)));await settle();assert.match(v.host.textContent,/3%/);assert.doesNotMatch(v.host.textContent,/1\.5%/);
  assert(pending.every(p=>(p.init.method??'GET')==='GET'));
 }finally{await h.close();}
});
