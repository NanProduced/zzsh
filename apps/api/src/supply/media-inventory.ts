import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

// Byte-layer inventory of the local content-addressed media store
// (<rootDir>/<two-hex shard>/<64-hex storage key>). The scan is observational:
// it never writes, deletes or moves objects, and it never opens a database
// connection. Asset references and recorded MIME types are injected by the
// caller, so the same code audits a restored uploads directory offline.
export const LOCAL_MEDIA_SHARD_PATTERN = /^[0-9a-f]{2}$/;
export const LOCAL_MEDIA_KEY_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_MEDIA_KEY_FILE_PATTERN = /^([0-9a-f]{64})(?:\.([A-Za-z0-9]{1,8}))?$/;

const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type LocalMediaInventoryIssue =
  | { kind: "UNREADABLE_FILE"; detail: string }
  | { kind: "INVALID_STORAGE_KEY"; detail: string }
  | { kind: "KEY_HASH_MISMATCH"; declaredKey: string; actualHash: string }
  | { kind: "CORRUPT_BYTES"; detail: string }
  | { kind: "DECLARED_MIME_MISMATCH"; source: "extension" | "record"; declared: string; actual: string }
  | { kind: "ORPHAN"; detail: string };

export type LocalMediaInventoryEntry = {
  storageKey: string;
  byteSize: number | null;
  sha256: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  issues: LocalMediaInventoryIssue[];
};

export type ScanLocalMediaInventoryOptions = {
  // Storage keys currently referenced by media_asset rows (storage_key or
  // public_storage_key). Keys outside this set are reported as ORPHAN.
  referencedStorageKeys?: ReadonlySet<string>;
  // MIME recorded in media_asset for a storage key, used to detect records
  // whose declared type disagrees with the actual bytes.
  declaredMimeByStorageKey?: ReadonlyMap<string, string>;
};

async function inspectLocalMediaFile(
  shardDir: string,
  shard: string,
  name: string,
  options: ScanLocalMediaInventoryOptions,
): Promise<LocalMediaInventoryEntry> {
  const issues: LocalMediaInventoryIssue[] = [];
  const match = LOCAL_MEDIA_KEY_FILE_PATTERN.exec(name);
  const keyPart = match?.[1];
  const storageKey = keyPart ?? name;
  const filePath = join(shardDir, name);
  let byteSize: number | null = null;
  let sha256: string | null = null;
  let mime: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (keyPart === undefined) {
    issues.push({ kind: "INVALID_STORAGE_KEY", detail: `file name "${name}" is not a 64-hex storage key (possible interrupted-write leftover)` });
  } else if (keyPart.slice(0, 2) !== shard) {
    issues.push({ kind: "INVALID_STORAGE_KEY", detail: `storage key ${keyPart} does not belong in shard directory "${shard}"` });
  }

  let bytes: Buffer | null = null;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      issues.push({ kind: "INVALID_STORAGE_KEY", detail: `"${name}" is not a regular file` });
    } else {
      byteSize = info.size;
      bytes = await readFile(filePath);
    }
  } catch (error) {
    issues.push({ kind: "UNREADABLE_FILE", detail: error instanceof Error ? error.message : "file could not be read" });
  }

  if (bytes) {
    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (keyPart !== undefined && sha256 !== keyPart) {
      issues.push({ kind: "KEY_HASH_MISMATCH", declaredKey: keyPart, actualHash: sha256 });
    }
    try {
      const metadata = await sharp(bytes).metadata();
      if (metadata.format) mime = `image/${metadata.format}`;
      width = metadata.width ?? null;
      height = metadata.height ?? null;
      if (mime) {
        const extension = match?.[2]?.toLowerCase();
        if (extension) {
          const declared = EXTENSION_MIME[extension];
          if (declared && declared !== mime) {
            issues.push({ kind: "DECLARED_MIME_MISMATCH", source: "extension", declared, actual: mime });
          }
        }
        const recorded = options.declaredMimeByStorageKey?.get(storageKey);
        if (recorded && recorded !== mime) {
          issues.push({ kind: "DECLARED_MIME_MISMATCH", source: "record", declared: recorded, actual: mime });
        }
      }
    } catch {
      issues.push({ kind: "CORRUPT_BYTES", detail: "image bytes could not be decoded" });
    }
  }

  if (options.referencedStorageKeys && !options.referencedStorageKeys.has(storageKey)) {
    issues.push({ kind: "ORPHAN", detail: "storage key is not in the referenced asset set" });
  }

  return { storageKey, byteSize, sha256, mime, width, height, issues };
}

// Returns one entry per file found in shard directories, sorted by storage
// key. A missing root directory is a valid empty inventory.
export async function scanLocalMediaInventory(rootDir: string, options: ScanLocalMediaInventoryOptions = {}): Promise<LocalMediaInventoryEntry[]> {
  const entries: LocalMediaInventoryEntry[] = [];
  let shardNames: string[] = [];
  try {
    shardNames = await readdir(rootDir);
  } catch {
    return entries;
  }
  for (const shard of shardNames.sort()) {
    if (!LOCAL_MEDIA_SHARD_PATTERN.test(shard)) continue;
    const shardDir = join(rootDir, shard);
    let fileNames: string[] = [];
    try {
      fileNames = await readdir(shardDir);
    } catch {
      continue;
    }
    for (const name of fileNames.sort()) {
      entries.push(await inspectLocalMediaFile(shardDir, shard, name, options));
    }
  }
  return entries.sort((left, right) => (left.storageKey < right.storageKey ? -1 : left.storageKey > right.storageKey ? 1 : 0));
}
