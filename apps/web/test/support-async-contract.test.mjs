import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const webSource = readFileSync(new URL("../src/components/support/customer-support-workspace.tsx", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../../admin/src/views/im-support-view.tsx", import.meta.url), "utf8");
const adminGuardSource = readFileSync(new URL("../../admin/src/views/im-support-guards.ts", import.meta.url), "utf8");

test('a delayed authorization denial cannot clear another identity or another consultation', async()=>{
  const ast=ts.createSourceFile('workspace.tsx',webSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback;
  function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='messageAuthorization')callback=node.initializer.getText(ast);ts.forEachChild(node,visit);}
  visit(ast);assert.ok(callback);
  const code=ts.transpileModule('const authorize='+callback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for(const switchIdentity of [true,false]){
    let release,error,clears=0,messages={a:['old'],b:['current']};
    const generation={current:1},identity={current:'A'},active={current:'a'};
    const readHidden={current:{}};
    const authorize=new Function('fetch','cancelled','generation','identityGenerationRef','identity','identityRef','consultationsRef','activeIdRef','setMessages','setError','readJson','readHiddenRef',code+';return authorize;')(
      ()=>new Promise(resolve=>release=resolve),false,1,generation,'A',identity,{current:[{id:'a',conversationId:'team-a'},{id:'b',conversationId:'team-b'}]},active,
      fn=>{messages=fn(messages);clears++;},value=>error=value,async()=>{throw Error('denied');},readHidden);
    const pending=authorize({conversationId:'team-a',operation:'read'});
    active.current='b';if(switchIdentity){generation.current=2;identity.current='B';}
    release({status:403});await pending.catch(()=>{});
    assert.deepEqual(messages.b,['current']);assert.equal(error,undefined);
    assert.equal(clears,switchIdentity?0:1);
    assert.equal(Boolean(readHidden.current['team-a']),!switchIdentity,'a denied read hides that conversation only for the current identity');
    if(!switchIdentity)assert.deepEqual(messages.a,[]);
  }
});

test("user support responses are bound to identity, consultation, and client generations", () => {
  assert.match(webSource, /identityGenerationRef/);
  assert.match(webSource, /generation !== identityGenerationRef\.current/);
  assert.match(webSource, /activeIdRef\.current !== conversation\.id/);
  assert.match(webSource, /clientRef\.current !== client/);
  assert.match(webSource, /mergeImMessages\(current\[conversation\.id\] \?\? \[\], rows\)/);
  assert.match(webSource, /readSupportIntent/);
  assert.match(webSource, /error\.status = response\.status/);
  assert.match(webSource, /revalidateAfterUnauthorized/);
  assert.match(webSource, /void session\.confirm\(\)/);
  assert.doesNotMatch(webSource, /consumeSupportIntent/);
});

test("closed support history requires an explicit new-consultation state", () => {
  assert.match(webSource, /const \[isStartingNew, setIsStartingNew\]/);
  assert.match(webSource, /if \(preview \|\| isStartingNew \|\| activeId \|\| consultations\.length === 0\)/);
  assert.match(webSource, /data-action="start-new-consultation"/);
  assert.match(webSource, /setIsStartingNew\(true\)/);
  assert.match(webSource, /data-action=\{isStartingNew \? "submit-new-consultation" : "start-consultation"\}/);
  assert.match(webSource, /setIsStartingNew\(false\)/);
});

test("admin support responses are bound to operator and selected consultation, with presence renewal", () => {
  assert.match(adminSource, /operatorGenerationRef/);
  assert.match(adminSource, /selectedIdRef\.current !== consultation\.id/);
  assert.match(adminSource, /clientRef\.current !== client/);
  assert.match(adminSource, /setInterval\(\(\) => \{[\s\S]*?writePresence\(availabilityRef\.current, connectionForPresence\(connection\)\)/);
  assert.match(adminSource, /writePresence\(availabilityRef\.current, connectionForPresence\(state\)\)/);
  assert.match(adminSource, /snapshot\.session\.locked/);
  assert.match(adminSource, /blockedConsultations/);
  assert.match(adminSource, /blockCurrentConsultationOnForbidden/);
  assert.match(adminSource, /const consultationId = selectedIdRef\.current/);
  assert.match(adminSource, /queueRef\.current\.find\(\(item\) => item\.id === consultationId\)/);
  assert.match(adminSource, /conversationId: consultation\.conversationId/);
  assert.match(adminSource, /refreshConsultationAccess/);
  assert.match(adminSource, /data-action="refresh-consultation-access"/);
  assert.match(adminSource, /isCurrentImRequest/);
  assert.doesNotMatch(adminSource, /blockedTypes/);
  assert.doesNotMatch(adminSource, /writePresence\([^\n]*"CONNECTED"/);
});

test("formal NIM clients preauthorize history and send through the same-origin BFF", () => {
  assert.match(webSource, /api\/im\/message-access\?conversationId=/);
  assert.match(adminSource, /messageAccessPath\(conversationId, operation\)/);
  assert.match(adminGuardSource, /\/im\/message-access\?conversationId=/);
});

// Directory independence from SDK availability is covered by support-workspace-behavior.test.mjs.

test("unknown remote scope is visible and cannot be presented as an active chat", () => {
  assert.match(webSource, /messageScopeState === "FAILED"/);
  assert.match(webSource, /客服会话待人工核验/);
  assert.match(webSource, /远端状态待人工核验/);
  assert.match(adminSource, /scopeStateLabel/);
  assert.match(adminSource, /云信远端结果待人工核验/);
  assert.match(adminSource, /messageScopeState !== "FAILED"/);
});
