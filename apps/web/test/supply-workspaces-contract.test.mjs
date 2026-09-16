import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/components/supply-workspaces.tsx', import.meta.url), 'utf8');

test('publish writes and queued media stay bound to identity, object and request context', () => {
  assert.match(source, /sharedSession\.subscribe/);
  assert.match(source, /new IdentityPauseGate\(\)/);
  assert.match(source, /waitForIdentity = useCallback/);
  assert.match(source, /identityPauseGate\.current\.cancelWaiters\(\)/);
  assert.match(source, /if \(identityState === "checking"\) return/);
  assert.match(source, /identityPauseGate\.current\.markFailed\(\)/);
  assert.match(source, /currentContext = useCallback[\s\S]*identityRef\.current === context\.identity[\s\S]*gameRef\.current === context\.gameId/);
  assert.match(source, /pendingKeys\.current\.clear\(\)/);
  assert.match(source, /uploadQueue\.current = Promise\.resolve\(\)/);
  assert.match(source, /const context = captureContext\(accountRef\.current, gameId\)/);
  assert.match(source, /upload\(entry, context\)/);
  assert.match(source, /beforeBytesUpload: \(\) => waitForIdentity\(context\)/);
  assert.match(source, /cancelledMedia\.current\.has\(entry\.id\)/);
  assert.match(source, /if \(currentContext\(context, controller\.signal\)\) setBusy\(""\)/);
});

test('publish retries replay the frozen step and preserve input/media review boundaries', () => {
  assert.match(source, /body: DraftInput & \{ expectedRevision: string \}/);
  assert.match(source, /retryAfterReady\?: \(\) => Promise<void>/);
  assert.match(source, /const saveWithContext = async/);
  assert.match(source, /const quoteWithContext = async/);
  assert.match(source, /ensureReady\(context, controller\.signal, "upload", \(\) => upload\(entry, context\)\)/);
  assert.match(source, /saveDraft\(request\.accountId, request\.body, request\.key, controller\.signal\)/);
  assert.match(source, /retryAfterUnknown/);
  assert.match(source, /sendQuoteRequest\(context, saved, retryBusy\)/);
  assert.match(source, /sendConfirmRequest/);
  assert.match(source, /bindingSaved: false/);
  assert.match(source, /已保存.*已上传，待保存/);
  assert.match(source, /function unitText/);
  assert.doesNotMatch(source, /<td>\{item\.unit\}<\/td>/);
  assert.match(source, /beforeunload/);
  assert.match(source, /function nextMediaPosition/);
  assert.match(source, /remaining\.map\(\(binding, position\) => \(\{ \.\.\.binding, position \}\)\)/);
});

test('publish summary reports observed state without claiming submission readiness', () => {
  assert.match(source, /协议已确认/);
  assert.doesNotMatch(source, /可继续提交/);
  assert.match(source, /status === "uploading"/);
  assert.match(source, /status === "failed"/);
  assert.match(source, /bindingSaved/);
  assert.match(source, /quoteStale/);
  assert.match(source, /readOnly/);
  assert.match(source, /busyText/);
  assert.match(source, /有 \{new Set\(blockers\)\.size\} 项规则限制/);
  assert.match(source, /金额来自本次服务端报价/);
});

test('my accounts rejects stale detail and supports cursor pagination', () => {
  assert.match(source, /nextCursorRef/);
  assert.match(source, /isCurrentQuery\(request, listRequestRef\.current, request\.key\)/);
  assert.match(source, /setDetail\(null\)/);
  assert.match(source, /setNextCursor\(page\.nextCursor\)/);
  assert.match(source, /加载更多账号/);
  assert.match(source, /visibleDetail = detail &&/);
});
