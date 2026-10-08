import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const publishSource = await readFile(new URL('../src/components/supply/publish-form.tsx', import.meta.url), 'utf8');
const accountSource = await readFile(new URL('../src/components/supply-workspaces.tsx', import.meta.url), 'utf8');

test('publish writes and queued media stay bound to identity, object and request context', () => {
  assert.match(publishSource, /sharedSession\.subscribe/);
  assert.match(publishSource, /new IdentityPauseGate\(\)/);
  assert.match(publishSource, /waitForIdentity = useCallback/);
  assert.match(publishSource, /identityPauseGate\.current\.cancelWaiters\(\)/);
  assert.match(publishSource, /if \(identityState === "checking"\) return/);
  assert.match(publishSource, /identityPauseGate\.current\.markFailed\(\)/);
  assert.match(publishSource, /currentContext = useCallback[\s\S]*identityRef\.current === context\.identity[\s\S]*gameRef\.current === context\.gameId/);
  assert.match(publishSource, /pendingKeys\.current\.clear\(\)/);
  assert.match(publishSource, /uploadQueue\.current = Promise\.resolve\(\)/);
  assert.match(publishSource, /const context = captureContext\(accountRef\.current, gameId\)/);
  assert.match(publishSource, /upload\(entry, context\)/);
  assert.match(publishSource, /beforeBytesUpload: \(\) => waitForIdentity\(context\)/);
  assert.match(publishSource, /cancelledMedia\.current\.has\(entry\.id\)/);
  assert.match(publishSource, /if \(currentContext\(context, controller\.signal\)\) setBusy\(""\)/);
});

test('publish retries replay the frozen step and preserve input/media review boundaries', () => {
  assert.match(publishSource, /body: DraftInput & \{ expectedRevision: string \}/);
  assert.match(publishSource, /retryAfterReady\?: \(\) => Promise<void>/);
  assert.match(publishSource, /const saveWithContext = async/);
  assert.match(publishSource, /const quoteWithContext = async/);
  assert.match(publishSource, /ensureReady\(context, controller\.signal, "upload", \(\) => upload\(entry, context\)\)/);
  assert.match(publishSource, /saveDraft\(request\.accountId, request\.body, request\.key, controller\.signal\)/);
  assert.match(publishSource, /retryAfterUnknown/);
  assert.match(publishSource, /sendQuoteRequest\(context, saved, retryBusy\)/);
  assert.match(publishSource, /sendConfirmRequest/);
  assert.match(publishSource, /bindingSaved: false/);
  assert.match(publishSource, /已保存.*已上传，待保存/);
  assert.doesNotMatch(publishSource, /<td>\{item\.unit\}<\/td>/);
  assert.match(publishSource, /beforeunload/);
  assert.match(publishSource, /function nextMediaPosition/);
  assert.match(publishSource, /remaining\.map\(\(binding, position\) => \(\{ \.\.\.binding, position \}\)\)/);
});

test('publish shows a server quote, separates owner income from deposits and requires an explicit agreement', () => {
  assert.match(publishSource, /哈夫币预计收入/);
  assert.match(publishSource, /物品预计收入/);
  assert.match(publishSource, /预计收入（扣费前）/);
  assert.match(publishSource, /租客押金/);
  assert.match(publishSource, /发布保证金/);
  assert.match(publishSource, /ownerQuoteBreakdown/);
  assert.match(publishSource, /我已阅读并同意本次出租条款与条件/);
  assert.match(publishSource, /条款已按当前版本确认/);
  assert.match(publishSource, /核对报价/);
  assert.match(publishSource, /确认上架/);
  assert.match(publishSource, /尚未核价/);
  assert.doesNotMatch(publishSource, /可继续提交/);
  assert.doesNotMatch(publishSource, /服务端报价/);
});

test('publish keeps v2 pricing selection, fast lock and config-missing split states', () => {
  assert.match(publishSource, /optionsAvailability === "unavailable"/);
  assert.match(publishSource, /pricingSchema === "haff-ratio-v2"/);
  assert.match(publishSource, /rentalPricing/);
  assert.match(publishSource, /buildRentalPricing/);
  assert.match(publishSource, /supply-ratio-locked/);
  assert.match(publishSource, /fastLocked/);
  assert.match(publishSource, /rentalModes\?\.\[rentalMode\]|rentalModes\?\.\[entry\]/);
  assert.match(publishSource, /service_window_cross_midnight/);
  assert.match(publishSource, /depositRecommendation/);
  assert.match(publishSource, /data-publish-group/);
  assert.doesNotMatch(publishSource, /openGroups|setOpenGroups/);
  assert.match(publishSource, /FormRadioGroup name="rental_mode"/);
  assert.match(publishSource, /delta-section/);
});

test('my accounts rejects stale detail and supports cursor pagination', () => {
  assert.match(accountSource, /nextCursorRef/);
  assert.match(accountSource, /isCurrentQuery\(request, listRequestRef\.current, request\.key\)/);
  assert.match(accountSource, /setDetail\(null\)/);
  assert.match(accountSource, /setNextCursor\(page\.nextCursor\)/);
  assert.match(accountSource, /加载更多账号/);
  assert.match(accountSource, /visibleDetail = detail &&/);
  assert.match(publishSource, /export function PublishForm/);
});
