import sharp from "sharp";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

// A PNG with a valid header but a destroyed IDAT payload: 94 bytes, 4x3, whose
// filename is the correct SHA-256 of those actual corrupt bytes. Mirrors the
// reviewer probe (media-corrupt-body-probe.json); metadata reads fine, pixels
// do not decode.
async function makeCorruptBodyPng(): Promise<Buffer> {
  const good = await makeImage("png", 4, 3);
  const idat = good.indexOf(Buffer.from("IDAT"));
  assert.ok(idat > 0, "fixture png must contain IDAT");
  const body = Buffer.from(good);
  for (let index = idat + 4; index < body.length - 12; index++) body[index] = (body[index]! + 0x5a) & 0xff;
  return body;
}

test("clean inventory lists decoded mime, dimensions, size and hash without issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const png = await makeImage("png", 8, 6);
    const jpeg = await makeImage("jpeg", 16, 12);
    const webp = await makeImage("webp", 4, 4);
    const keys = [await seedFile(root, png), await seedFile(root, jpeg), await seedFile(root, webp)];
    const { entries, failures, rootMissing } = await scanLocalMediaInventory(root, {
      referencedStorageKeys: new Set(keys),
      declaredMimeByStorageKey: new Map([[keys[0]!, "image/png"], [keys[1]!, "image/jpeg"], [keys[2]!, "image/webp"]]),
    });
    assert.deepEqual(failures, []);
    assert.equal(rootMissing, false);
    assert.equal(entries.length, 3);
    const byKey = new Map(entries.map((entry) => [entry.storageKey, entry]));
    const pngEntry = byKey.get(keys[0]!)!;
    assert.equal(pngEntry.mime, "image/png");
    assert.equal(pngEntry.width, 8);
    assert.equal(pngEntry.height, 6);
    assert.equal(pngEntry.byteSize, png.length);
    assert.equal(pngEntry.sha256, createHash("sha256").update(png).digest("hex"));
    assert.deepEqual(pngEntry.issues, []);
    assert.equal(byKey.get(keys[1]!)!.mime, "image/jpeg");
    assert.equal(byKey.get(keys[2]!)!.mime, "image/webp");
    assert.deepEqual(entries.map((entry) => entry.storageKey), [...keys].sort());
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
    const { entries } = await scanLocalMediaInventory(root);
    const byKey = new Map(entries.map((entry) => [entry.storageKey, entry]));
    for (const key of [garbageKey, truncatedKey]) {
      const entry = byKey.get(key)!;
      assert.ok(entry.issues.some((issue) => issue.kind === "CORRUPT_BYTES"));
      assert.equal(entry.mime, null);
      assert.equal(entry.width, null);
      assert.equal(entry.height, null);
      assert.equal(entry.sha256, createHash("sha256").update(key === garbageKey ? garbage : truncated).digest("hex"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid header with a destroyed pixel body is still CORRUPT_BYTES (X-API-03)", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const broken = await makeCorruptBodyPng();
    const key = await seedFile(root, broken);
    const { entries, failures } = await scanLocalMediaInventory(root);
    assert.deepEqual(failures, []);
    const entry = entries.find((item) => item.storageKey === key)!;
    // Hash still matches the real bytes; the header may still decode; the pixel
    // body must not be accepted.
    assert.equal(entry.sha256, key);
    assert.ok(entry.issues.some((issue) => issue.kind === "CORRUPT_BYTES"), JSON.stringify(entry.issues));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a root that is a regular file throws instead of reading as an empty inventory (X-API-01)", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const fileRoot = join(root, "not-a-directory");
    await writeFile(fileRoot, "bytes");
    await assert.rejects(() => scanLocalMediaInventory(fileRoot), /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing root is the single explicitly accepted empty case and is marked rootMissing", async () => {
  const missing = await scanLocalMediaInventory(join(tmpdir(), "zzsh-media-inventory-missing"));
  assert.deepEqual(missing, { entries: [], failures: [], rootMissing: true });
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    assert.deepEqual(await scanLocalMediaInventory(root), { entries: [], failures: [], rootMissing: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a shard junction outside the root is recorded as a failure and never followed (X-API-02)", async () => {
  const base = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  const outside = join(base, "outside");
  const root = join(base, "root");
  try {
    await mkdir(join(outside, "38"), { recursive: true });
    const escaped = await makeImage("png", 5, 5);
    const escapedKey = createHash("sha256").update(escaped).digest("hex");
    await writeFile(join(outside, "38", escapedKey), escaped);
    await mkdir(root, { recursive: true });
    const kept = await seedFile(root, await makeImage("png", 6, 6));
    await symlink(outside, join(root, "38"), "junction");

    const { entries, failures } = await scanLocalMediaInventory(root);
    assert.deepEqual(entries.map((entry) => entry.storageKey), [kept], "only the real in-root shard is scanned");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.kind, "SHARD_LINK_NOT_FOLLOWED");
    assert.ok(failures[0]!.path.endsWith(join(root, "38")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a linked root is rejected; a file-level junction is flagged, not followed", async () => {
  const base = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const realRoot = join(base, "real");
    await mkdir(realRoot, { recursive: true });
    const linkedRoot = join(base, "linked");
    await symlink(realRoot, linkedRoot, "junction");
    await assert.rejects(() => scanLocalMediaInventory(linkedRoot), /never followed|link/i);

    const root = join(base, "root");
    const shardDir = join(root, "cd");
    await mkdir(shardDir, { recursive: true });
    const outsideDir = join(base, "elsewhere");
    await mkdir(outsideDir, { recursive: true });
    const fakeKey = "c".repeat(63) + "d";
    await symlink(outsideDir, join(shardDir, fakeKey), "junction");
    const { entries, failures } = await scanLocalMediaInventory(root);
    assert.deepEqual(failures, []);
    const entry = entries.find((item) => item.storageKey === fakeKey)!;
    assert.ok(entry.issues.some((issue) => issue.kind === "LINK_NOT_FOLLOWED"));
    assert.equal(entry.sha256, null, "linked bytes are never read");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a shard entry that is a plain file is a preserved failure, not a silent skip", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const kept = await seedFile(root, await makeImage("png", 6, 6));
    await writeFile(join(root, "ab"), "not a directory");
    const { entries, failures } = await scanLocalMediaInventory(root);
    assert.deepEqual(entries.map((entry) => entry.storageKey), [kept]);
    assert.deepEqual(failures.map((failure) => failure.kind), ["SHARD_NOT_DIRECTORY"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files outside the injected referenced set are reported as orphans only", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-inventory-"));
  try {
    const referenced = await seedFile(root, await makeImage("png", 5, 5));
    const orphan = await seedFile(root, await makeImage("png", 6, 6));
    const { entries } = await scanLocalMediaInventory(root, { referencedStorageKeys: new Set([referenced]) });
    const byKey = new Map(entries.map((entry) => [entry.storageKey, entry]));
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
    const { entries } = await scanLocalMediaInventory(root);
    const flagged = entries.filter((entry) => entry.issues.some((issue) => issue.kind === "INVALID_STORAGE_KEY"));
    assert.equal(flagged.length, 2);
    assert.ok(entries.some((entry) => entry.storageKey === key && entry.issues.length === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
