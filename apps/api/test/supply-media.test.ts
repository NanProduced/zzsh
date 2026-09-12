import sharp from "sharp";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertImageWithinBounds,
  createLocalMediaStorage,
  createUnavailableMediaStorage,
  inspectImage,
  decodeImage,
  MediaValidationError,
} from "../src/supply/media";

test("full decoder accepts real formats and rejects fake headers, truncation and metadata in derivatives", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } }).withExif({ IFD0: { Artist: "private evidence marker" } }).toFormat(format).toBuffer();
    assert.deepEqual(await inspectImage(bytes), { mime: "image/" + format, width: 64, height: 32 });
    await assert.rejects(() => inspectImage(bytes.subarray(0, Math.floor(bytes.length / 2))), MediaValidationError);
    const derivative = await decodeImage(bytes);
    assert.equal((await sharp(derivative.publicBytes).metadata()).exif, undefined);
    assert.ok((await sharp(bytes).metadata()).exif, "original evidence still has its metadata");
  }
  const fake = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(fake); fake.write("IHDR",12); fake.writeUInt32BE(1,16); fake.writeUInt32BE(1,20);
  for (const bytes of [fake, Buffer.from("<svg></svg>"), Buffer.from("GIF89a"), Buffer.alloc(11 * 1024 * 1024)]) await assert.rejects(() => inspectImage(bytes), MediaValidationError);
  const tooWide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(() => inspectImage(tooWide), MediaValidationError);
});

test("pixel and size bounds reject oversized images", () => {
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 9000, height: 100 }, 1000), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 8000, height: 8000 }, 1000), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 100, height: 100 }, 0), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 100, height: 100 }, 11 * 1024 * 1024), MediaValidationError);
  assert.doesNotThrow(() => assertImageWithinBounds({ mime: "image/png", width: 1920, height: 1080 }, 1024));
});

test("local storage is content addressed, repeatable, and rejects invalid keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-"));
  try {
    const storage = createLocalMediaStorage(root);
    assert.equal(storage.available, true);
    const bytes = Buffer.from("storage fixture");
    const hash = "a".repeat(64);
    await storage.write(bytes, hash);
    await storage.write(bytes, hash);
    assert.deepEqual(await storage.read(hash), bytes);
    await assert.rejects(() => storage.read("../../escape"), /storage key is invalid/);
    await assert.rejects(() => storage.read("f".repeat(64)), /unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfigured storage reports itself unavailable instead of pretending to work", async () => {
  const storage = createUnavailableMediaStorage();
  assert.equal(storage.available, false);
  await assert.rejects(() => storage.write(Buffer.from("x"), "a".repeat(64)));
});
