import sharp from "sharp";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanLocalMediaInventory, type LocalMediaInventoryEntry } from "../src/supply/media-inventory";

async function seedFile(root: string, bytes: Buffer, name?: string): Promise<string> {
  const key = name ?? createHash("sha256").update(bytes).digest("hex");
  const shardDir = join(root, key.slice(0, 2));
  await mkdir(shardDir, { recursive: true });
  await writeFile(join(shardDir, key), bytes);
  return key;
}

const makeImage = (format: "png" | "jpeg" | "webp", width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "red" } }).toFormat(format).toBuffer();

test("clean inventory lists decoded mime, dimensions, size and hash without issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const png = await makeImage("png", 8, 6);
    const jpeg = await makeImage("jpeg", 16, 12);
    const webp = await makeImage("webp", 4, 4);
    const keys = [await seedFile(root, png), await seedFile(root, jpeg), await seedFile(root, webp)];
    const inventory = await scanLocalMediaInventory(root, {
      referencedStorageKeys: new Set(keys),
      declaredMimeByStorageKey: new Map([[keys[0]!, "image/png"], [keys[1]!, "image/jpeg"], [keys[2]!, "image/webp"]]),
    });
    assert.equal(inventory.length, 3);
    const byKey = new Map(inventory.map((entry) => [entry.storageKey, entry]));
    const pngEntry = byKey.get(keys[0]!)!;
    assert.equal(pngEntry.mime, "image/png");
    assert.equal(pngEntry.width, 8);
    assert.equal(pngEntry.height, 6);
    assert.equal(pngEntry.byteSize, png.length);
    assert.equal(pngEntry.sha256, createHash("sha256").update(png).digest("hex"));
    assert.deepEqual(pngEntry.issues, []);
    assert.equal(byKey.get(keys[1]!)!.mime, "image/jpeg");
    assert.equal(byKey.get(keys[2]!)!.mime, "image/webp");
    assert.deepEqual(inventory.map((entry) => entry.storageKey), [...keys].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt bytes are detected even under a valid content-addressed name", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const garbage = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("not a real png body")]);
    const truncated = (await makeImage("png", 10, 10)).subarray(0, 12);
    const garbageKey = await seedFile(root, garbage);
    const truncatedKey = await seedFile(root, truncated);
    const inventory = await scanLocalMediaInventory(root);
    const byKey = new Map(inventory.map((entry) => [entry.storageKey, entry]));
    for (const key of [garbageKey, truncatedKey]) {
      const entry = byKey.get(key)!;
      assert.deepEqual(entry.issues.map((issue) => issue.kind), ["CORRUPT_BYTES"]);
      assert.equal(entry.mime, null);
      assert.equal(entry.width, null);
      assert.equal(entry.height, null);
      assert.equal(entry.sha256, createHash("sha256").update(key === garbageKey ? garbage : truncated).digest("hex"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declared mime from file extension or injected record is checked against actual bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const jpeg = await makeImage("jpeg", 9, 9);
    const jpegKey = createHash("sha256").update(jpeg).digest("hex");
    const spoofedKey = await seedFile(root, jpeg, `${jpegKey}.png`);
    const png = await makeImage("png", 9, 9);
    const pngKey = await seedFile(root, png);
    const inventory = await scanLocalMediaInventory(root, {
      declaredMimeByStorageKey: new Map([[pngKey, "image/webp"]]),
    });
    const byKey = new Map(inventory.map((entry) => [entry.storageKey, entry]));
    const spoofed = byKey.get(spoofedKey.slice(0, 64))!;
    assert.equal(spoofed.mime, "image/jpeg");
    assert.deepEqual(spoofed.issues, [{ kind: "DECLARED_MIME_MISMATCH", source: "extension", declared: "image/png", actual: "image/jpeg" }]);
    const recorded = byKey.get(pngKey)!;
    assert.deepEqual(recorded.issues, [{ kind: "DECLARED_MIME_MISMATCH", source: "record", declared: "image/webp", actual: "image/png" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files outside the injected referenced set are reported as orphans only", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const referenced = await seedFile(root, await makeImage("png", 5, 5));
    const orphan = await seedFile(root, await makeImage("png", 6, 6));
    const inventory = await scanLocalMediaInventory(root, { referencedStorageKeys: new Set([referenced]) });
    const byKey = new Map(inventory.map((entry) => [entry.storageKey, entry]));
    assert.deepEqual(byKey.get(referenced)!.issues, []);
    assert.deepEqual(byKey.get(orphan)!.issues, [{ kind: "ORPHAN", detail: "storage key is not in the referenced asset set" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leftover temp files and wrong-shard placement are flagged without stopping the scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const image = await makeImage("png", 4, 4);
    const key = await seedFile(root, image);
    const wrongKey = createHash("sha256").update(Buffer.from("other bytes")).digest("hex");
    const wrongShard = join(root, wrongKey.slice(0, 2));
    await mkdir(wrongShard, { recursive: true });
    await writeFile(join(wrongShard, key), image);
    await writeFile(join(join(root, key.slice(0, 2)), `${key}.tmp-5f3a`), image);
    const inventory = await scanLocalMediaInventory(root);
    const flagged = inventory.filter((entry) => entry.issues.some((issue) => issue.kind === "INVALID_STORAGE_KEY"));
    assert.equal(flagged.length, 2);
    assert.ok(inventory.some((entry) => entry.storageKey === key && entry.issues.length === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty and missing root directories are valid empty inventories", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    assert.deepEqual(await scanLocalMediaInventory(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await scanLocalMediaInventory(join(tmpdir(), "zzsh-media-inventory-missing")), []);
});
