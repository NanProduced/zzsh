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
