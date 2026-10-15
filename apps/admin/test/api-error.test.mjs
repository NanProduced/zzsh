import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const { AdminApiError, adminRequest, friendlyError }=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

test('business errors name the actual failure and retain the request reference', () => {
  for (const [status, pattern] of [[400,/输入有误/],[401,/会话已失效/],[403,/没有访问/],[404,/未找到.*无权/],[500,/服务暂时/],[503,/服务暂时/]]) {
    const text = friendlyError(new AdminApiError(status,'INTERNAL_ERROR','read-123','/supply/reviews'));
    assert.match(text, pattern); assert.match(text,/read-123/); assert.doesNotMatch(text,/密码错误|云信.*关闭|检查 API/);
  }
  assert.match(friendlyError(new AdminApiError(0,'NETWORK_ERROR',undefined,'/supply/reviews')),/网络连接失败/);
  assert.equal(friendlyError(new AdminApiError(401,'UNAUTHENTICATED',undefined,'/auth/login')),'账号或密码错误，请检查凭据后重试。');
  assert.equal(friendlyError(new AdminApiError(400,'INVALID_CREDENTIALS',undefined,'/auth/two-factor')),'验证码或凭据无效，请重新输入。');
});
test('request adapter passes business context, header reference and the auth failure event', async t => {
  const events=[];
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{code:'UNAUTHENTICATED'}}),{status:401,headers:{'x-request-id':'header-read-401'}}));
  const beforeWindow=globalThis.window, beforeEvent=globalThis.CustomEvent;
  globalThis.window={dispatchEvent:e=>events.push(e)};
  globalThis.CustomEvent=class {constructor(type,init){this.type=type;this.detail=init.detail;}};
  t.after(()=>{globalThis.window=beforeWindow;globalThis.CustomEvent=beforeEvent;});
  await assert.rejects(adminRequest('/supply/reviews'),e=>{assert.match(friendlyError(e),/会话已失效.*header-read-401/);return true;});
  assert.equal(events.length,1);
});

test('result recovery GET forwards the original key without generating a new key or body', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,init)=>{ calls.push({url,init}); return Response.json({receipt:'UNRESOLVED'}); });
  const controller=new AbortController();
  await adminRequest('/supply/operation-result?operation=supply.release.activate',undefined,'GET',{'idempotency-key':'original-command-key'},controller.signal);
  assert.equal(calls[0].init.method,'GET');
  assert.deepEqual(calls[0].init.headers,{'idempotency-key':'original-command-key'});
  assert.equal(calls[0].init.body,undefined);
  assert.equal(calls[0].init.credentials,'include');
  assert.equal(calls[0].init.signal,controller.signal);
  await adminRequest('/supply/games');
  assert.equal(calls[1].init.headers,undefined);
  await adminRequest('/supply/games',{},'POST',{'idempotency-key':'explicit-write-key'});
  assert.equal(calls[2].init.headers['idempotency-key'],'explicit-write-key');
});
