import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEDIA_BYTES, mediaUploadFailureHint } from '../src/lib/media-upload.ts';

test('normal business images pass the client mirror check', () => {
  assert.equal(mediaUploadFailureHint({ type: 'image/png', size: 2_885_976 }), null);
  assert.equal(mediaUploadFailureHint({ type: 'image/jpeg', size: MAX_MEDIA_BYTES }), null);
});

test('oversize images get an explicit size hint and stay removable', () => {
  const hint = mediaUploadFailureHint({ type: 'image/png', size: 14_547_995 });
  assert.match(hint, /13\.9 MiB/);
  assert.match(hint, /10 MiB/);
});

test('unsupported formats and empty files are rejected before upload', () => {
  assert.match(mediaUploadFailureHint({ type: 'image/gif', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: '', size: 1024 }), /PNG、JPEG 或 WebP/);
  assert.match(mediaUploadFailureHint({ type: 'image/png', size: 0 }), /为空或无法读取/);
});
