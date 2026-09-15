import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/auth/auth-form.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function harness(query='',newUser=false,gate){
 const states=[],refs=[],calls=[],effects=[];let si=0,ri=0,confirmations=0;const exports={};
 new Function('require','exports','window','fetch',code)(name=>{
  if(name==='react')return {...React,useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef(initial){return refs[ri++]??(refs[ri-1]={current:initial});},useEffect(fn){effects.push(fn);}};
  if(name.includes('session/user-session-provider'))return {useUserSession:()=>({confirm:async()=> { confirmations++; return 'authenticated'; }}),publishUserSessionChange(){}};
  return require(name);
 },exports,{location:{search:query},setInterval(){return 1},clearInterval(){}},async(url,init)=>{if(gate && url.endsWith("/sign-in/identifier")) await gate;calls.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({status:true,requiresPassword:newUser && url.endsWith("/complete") && !JSON.parse(init.body).password})};});
 const render=()=>{si=ri=0;return exports.AuthForm({});};
 const find=(predicate)=>{let found;function walk(n){if(!n||typeof n!=='object')return;if(predicate(n))found=n;React.Children.forEach(n.props?.children,walk);}walk(render());assert.ok(found);return found;};
 const input=(id,value)=>find(n=>n.props?.id===id).props.onChange({target:{value,checked:value}});
 const button=async text=>{find(n=>n.type==='button'&&n.props.children===text).props.onClick(); await new Promise(resolve=>setImmediate(resolve));};
 const submit=()=>find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 return {calls,states,effects,render,input,button,submit,find,get confirmations(){return confirmations;}};
}
test('consent gates SMS send and both login methods; SMS verification uses existing endpoint',async()=>{
 const h=harness();h.input('auth-identifier','13800138000');await h.button('获取验证码');assert.equal(h.calls.length,0);
 h.input('auth-terms',true);await h.button('获取验证码');assert.equal(h.calls[0].url,'/api/auth/user/phone-registration/send-otp');
 h.input('phone-registration-code','123456');await h.submit();assert.equal(h.calls[1].url,'/api/auth/user/phone-registration/complete');assert.equal(h.calls[1].body.password,undefined);
 await h.button('密码登录');h.input('auth-password','oldpass');h.input('auth-terms',false);await h.submit();assert.equal(h.calls.length,2);h.input('auth-terms',true);await h.submit();assert.equal(h.calls[2].url,'/api/auth/user/sign-in/identifier');
});

test('new phone continues inside same form without resending OTP; invitation stays UI-only',async()=>{
 const h=harness('?inviteCode=FRIEND_12',true);h.render();h.effects[0]();h.input('auth-identifier','13800138000');h.input('auth-terms',true);await h.button('获取验证码');h.input('phone-registration-code','123456');await h.submit();
 assert.equal(h.find(n=>n.props?.id==='auth-invite').props.value,'FRIEND_12');h.input('auth-password','long-password-12');await h.submit();assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.code,'123456');assert.equal(h.calls[2].body.loginOrRegister,true);assert.equal(h.calls[2].body.inviteCode,undefined);
});
test('switching tabs clears the old code and changing phones cannot reuse it',async()=>{
 const h=harness();h.input('auth-identifier','13800138000');h.input('auth-terms',true);await h.button('获取验证码');h.input('auth-identifier','13900139000');h.input('phone-registration-code','123456');await h.submit();assert.equal(h.calls.length,1);await h.button('密码登录');await h.button('验证码登录');assert.equal(h.find(n=>n.props?.id==='phone-registration-code').props.value,'');
});

test('late password response after unmount cannot confirm session',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=harness('',false,gate);h.render();const unmount=h.effects[1]();await h.button('密码登录');h.input('auth-identifier','13800138000');h.input('auth-password','oldpass');h.input('auth-terms',true);const pending=h.submit();unmount();release();await pending;assert.equal(h.confirmations,0);
});
