import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import sharp from "sharp";

// Byte-layer inventory of the local content-addressed media store
// (<rootDir>/<two-hex shard>/<64-hex storage key>). The scan is observational:
// it never writes, deletes or moves objects, and it never opens a database
// connection. Asset references and recorded MIME types are injected by the
// caller, so the same code audits a restored uploads directory offline.
//
// Failure honesty (X-API-01/02/03):
// - A genuinely absent root (ENOENT) is the one explicitly accepted empty case
//   and is reported as rootMissing, distinguishable from a present-but-empty
//   root. Any other root failure (file instead of directory, EACCES, …) throws;
//   it is never silently reported as an empty inventory.
// - A shard that cannot be read, or is a link, or resolves outside the approved
//   root is recorded in `failures` (partial scan) and never followed; the caller
//   must preserve those failures.
// - Root, shard and file entries are checked with lstat and realpath
//   containment: junctions/symlinks are never followed.
// - metadata() alone does not prove the pixel body decodes; every image within
//   the byte/pixel budgets is fully decoded once, and a decode failure maps to
//   CORRUPT_BYTES even when the header reads fine.
export const LOCAL_MEDIA_SHARD_PATTERN = /^[0-9a-f]{2}$/;
export const LOCAL_MEDIA_KEY_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_MEDIA_KEY_FILE_PATTERN = /^([0-9a-f]{64})(?:\.([A-Za-z0-9]{1,8}))?$/;

// Same bounds as the upload pipeline: 10 MiB upload ceiling (16 MiB scan budget
// leaves room for legacy bytes) and the 40-megapixel decode budget.
const SCAN_BYTE_BUDGET = 16 * 1024 * 1024;
const SCAN_PIXEL_BUDGET = 40_000_000;

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
  | { kind: "SIZE_BUDGET_EXCEEDED"; detail: string }
  | { kind: "PIXEL_BUDGET_EXCEEDED"; detail: string }
  | { kind: "LINK_NOT_FOLLOWED"; detail: string }
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

export type LocalMediaScanFailure = {
  path: string;
  kind: "SHARD_NOT_DIRECTORY" | "SHARD_LINK_NOT_FOLLOWED" | "SHARD_OUTSIDE_ROOT" | "SHARD_READ_FAILED";
  detail: string;
};

export type LocalMediaInventory = {
  entries: LocalMediaInventoryEntry[];
  failures: LocalMediaScanFailure[];
  // true only for the explicitly accepted ENOENT case: the declared root does
  // not exist at all. Never upgrade this into source-coverage proof.
  rootMissing: boolean;
};

export type ScanLocalMediaInventoryOptions = {
  // Storage keys currently referenced by media_asset rows (storage_key or
  // public_storage_key). Keys outside this set are reported as ORPHAN.
  referencedStorageKeys?: ReadonlySet<string>;
  // MIME recorded in media_asset for a storage key, used to detect records
  // whose declared type disagrees with the actual bytes.
  declaredMimeByStorageKey?: ReadonlyMap<string, string>;
};

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

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
  let link = false;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      link = true;
      issues.push({ kind: "LINK_NOT_FOLLOWED", detail: `"${name}" is a link; links are never followed during an inventory scan` });
    } else if (!info.isFile()) {
      issues.push({ kind: "INVALID_STORAGE_KEY", detail: `"${name}" is not a regular file` });
    } else {
      byteSize = info.size;
      if (info.size > SCAN_BYTE_BUDGET) {
        issues.push({ kind: "SIZE_BUDGET_EXCEEDED", detail: `"${name}" is ${info.size} bytes, above the ${SCAN_BYTE_BUDGET}-byte scan budget; image decode skipped` });
        bytes = await readFile(filePath);
        sha256 = createHash("sha256").update(bytes).digest("hex");
        bytes = null;
      } else {
        bytes = await readFile(filePath);
      }
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
      const image = sharp(bytes, { limitInputPixels: SCAN_PIXEL_BUDGET });
      const metadata = await image.metadata();
      if (metadata.format) mime = `image/${metadata.format}`;
      width = metadata.width ?? null;
      height = metadata.height ?? null;
      // The header being readable does not prove the pixel body is intact;
      // decode it once within the pixel budget before calling the file clean.
      try {
        await image.stats();
      } catch (decodeError) {
        const detail = decodeError instanceof Error ? decodeError.message : "image pixels could not be decoded";
        if (/pixel limit/i.test(detail)) {
          issues.push({ kind: "PIXEL_BUDGET_EXCEEDED", detail });
        } else {
          issues.push({ kind: "CORRUPT_BYTES", detail });
        }
      }
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

  if (!link && options.referencedStorageKeys && !options.referencedStorageKeys.has(storageKey)) {
    issues.push({ kind: "ORPHAN", detail: "storage key is not in the referenced asset set" });
  }

  return { storageKey, byteSize, sha256, mime, width, height, issues };
}

// Returns one entry per file found in shard directories, sorted by storage key.
// The explicitly accepted empty case is a missing root (ENOENT), reported as
// rootMissing; every other root failure throws, and shard failures are
// preserved in `failures` for the caller.
export async function scanLocalMediaInventory(rootDir: string, options: ScanLocalMediaInventoryOptions = {}): Promise<LocalMediaInventory> {
  let rootInfo;
  try {
    rootInfo = await lstat(rootDir);
  } catch (error) {
    if (isEnoent(error)) return { entries: [], failures: [], rootMissing: true };
    throw error;
  }
  if (rootInfo.isSymbolicLink()) throw invalidScanRoot(rootDir, "scan root is a link; links are never followed");
  if (!rootInfo.isDirectory()) throw invalidScanRoot(rootDir, "scan root is not a directory");
  const realRoot = await realpath(rootDir);

  let shardNames: string[];
  try {
    shardNames = await readdir(rootDir);
  } catch (error) {
    if (isEnoent(error)) return { entries: [], failures: [], rootMissing: true };
    throw error;
  }

  const entries: LocalMediaInventoryEntry[] = [];
  const failures: LocalMediaScanFailure[] = [];
  for (const shard of shardNames.sort()) {
    if (!LOCAL_MEDIA_SHARD_PATTERN.test(shard)) continue;
    const shardDir = join(rootDir, shard);
    let shardInfo;
    try {
      shardInfo = await lstat(shardDir);
    } catch (error) {
      failures.push({ path: shardDir, kind: "SHARD_READ_FAILED", detail: error instanceof Error ? error.message : "shard could not be inspected" });
      continue;
    }
    if (shardInfo.isSymbolicLink()) {
      failures.push({ path: shardDir, kind: "SHARD_LINK_NOT_FOLLOWED", detail: "shard is a link; links are never followed during an inventory scan" });
      continue;
    }
    if (!shardInfo.isDirectory()) {
      failures.push({ path: shardDir, kind: "SHARD_NOT_DIRECTORY", detail: "shard entry is not a directory" });
      continue;
    }
    try {
      const realShard = await realpath(shardDir);
      if (realShard !== realRoot && !realShard.startsWith(realRoot + sep)) {
        failures.push({ path: shardDir, kind: "SHARD_OUTSIDE_ROOT", detail: `shard resolves to ${realShard}, outside the approved scan root` });
        continue;
      }
    } catch (error) {
      failures.push({ path: shardDir, kind: "SHARD_READ_FAILED", detail: error instanceof Error ? error.message : "shard could not be resolved" });
      continue;
    }
    let fileNames: string[];
    try {
      fileNames = await readdir(shardDir);
    } catch (error) {
      failures.push({ path: shardDir, kind: "SHARD_READ_FAILED", detail: error instanceof Error ? error.message : "shard could not be read" });
      continue;
    }
    for (const name of fileNames.sort()) {
      entries.push(await inspectLocalMediaFile(shardDir, shard, name, options));
    }
  }
  entries.sort((left, right) => (left.storageKey < right.storageKey ? -1 : left.storageKey > right.storageKey ? 1 : 0));
  return { entries, failures, rootMissing: false };
}

function invalidScanRoot(rootDir: string, detail: string): Error {
  const error = new Error(`Invalid media inventory root "${rootDir}": ${detail}`);
  (error as { code?: string }).code = "INVALID_SCAN_ROOT";
  return error;
}
