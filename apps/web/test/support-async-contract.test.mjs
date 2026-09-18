import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const webSource = readFileSync(new URL("../src/components/support/customer-support-workspace.tsx", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../../admin/src/views/im-support-view.tsx", import.meta.url), "utf8");
const adminGuardSource = readFileSync(new URL("../../admin/src/views/im-support-guards.ts", import.meta.url), "utf8");

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

test("client readiness precedes user consultation loading and recovery", () => {
  const open = webSource.indexOf("await lifecycle.open");
  const ready = webSource.indexOf("readyIdentityRef.current = identity", open);
  const load = webSource.indexOf("fetchConsultations()", ready);
  assert.ok(open >= 0 && ready > open && load > ready);
});

test("unknown remote scope is visible and cannot be presented as an active chat", () => {
  assert.match(webSource, /messageScopeState === "FAILED"/);
  assert.match(webSource, /客服会话待人工核验/);
  assert.match(webSource, /远端状态待人工核验/);
  assert.match(adminSource, /scopeStateLabel/);
  assert.match(adminSource, /云信远端结果待人工核验/);
  assert.match(adminSource, /selected\?\.messageScopeState !== "FAILED"/);
});
