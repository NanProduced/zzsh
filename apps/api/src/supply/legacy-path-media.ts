/** Legacy source references are paths, not new-platform media asset IDs. */
export function isLegacyImagePath(value: unknown): value is string {
  return typeof value === "string" && /^accountsImage\/\d{8}\/[A-Za-z0-9][A-Za-z0-9._-]{0,195}$/.test(value) && /\.(?:png|jpe?g|webp|gif|bmp|ico)$/i.test(value);
}

export function parseLegacyImagePaths(value: unknown): string[] {
  if (value == null || value === "") return [];
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list)) throw new Error("LEGACY_IMAGE_PATHS_INVALID");
  const paths: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new Error("LEGACY_IMAGE_PATHS_INVALID");
    const path = item.trim();
    if (!path || paths.includes(path)) continue;
    if (!isLegacyImagePath(path)) throw new Error("LEGACY_IMAGE_PATHS_INVALID");
    paths.push(path);
  }
  return paths;
}

export function legacyImageObjectKey(prefix: string, sourcePath: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*\/$/.test(prefix) || prefix.split("/").some(part => part === "." || part === "..") || !isLegacyImagePath(sourcePath)) throw new Error("LEGACY_IMAGE_PATH_INVALID");
  return `${prefix}legacy/${sourcePath}`;
}

export type LegacyMediaRecord = {
  accountId: string; ownerUserId: string; observationVersionId: string; currentVersionId: string | null;
  sourceDigest: string; currentSourceDigest: string; displayPaths: readonly string[]; penaltyPaths: readonly string[];
};
export type LegacyMediaViewer =
  | { realm: "public"; admitted: boolean; versionId: string }
  | { realm: "user"; userId: string }
  | { realm: "admin"; canReview: boolean; inGameScope: boolean };

/** Viewer permissions and the public admission are server-derived, never request values. */
export function selectLegacyImagePath(row: LegacyMediaRecord | null, accountId: string, field: "display" | "penalty", index: number, viewer: LegacyMediaViewer): string | null {
  if (!row || row.accountId !== accountId || !row.ownerUserId || !row.observationVersionId || !/^[a-f0-9]{64}$/.test(row.sourceDigest) || row.sourceDigest !== row.currentSourceDigest || !Number.isSafeInteger(index) || index < 0 || !["display", "penalty"].includes(field) || !viewer || !["public", "user", "admin"].includes(viewer.realm)) return null;
  const allowed = viewer.realm === "public" ? field === "display" && viewer.admitted && viewer.versionId === row.observationVersionId
    : viewer.realm === "user" ? viewer.userId === row.ownerUserId
    : viewer.canReview && viewer.inGameScope;
  if (!allowed) return null;
  const paths = field === "display" ? row.displayPaths : row.penaltyPaths;
  if (!Array.isArray(paths)) return null;
  const path = paths[index];
  return isLegacyImagePath(path) ? path : null;
}

export function legacyImageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/bmp" | "image/x-icon" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  return null;
}

type LegacyObjectReader = { get: (key: string) => Promise<{ content: Buffer }>; head: (key: string) => Promise<unknown> };
export type LegacyImageResult = { state: "FOUND"; bytes: Buffer; mime: string } | { state: "PRESENT" | "MIGRATING" | "UNAVAILABLE" | "NOT_FOUND" };

/** Only a confirmed OSS NoSuchKey for an authorized stored reference means missing. */
export async function readLegacyImage(reader: LegacyObjectReader, prefix: string, row: LegacyMediaRecord | null, accountId: string, field: "display" | "penalty", index: number, viewer: LegacyMediaViewer, head = false): Promise<LegacyImageResult> {
  const path = selectLegacyImagePath(row, accountId, field, index, viewer);
  if (!path) return { state: "NOT_FOUND" };
  const key = legacyImageObjectKey(prefix, path);
  try {
    if (head) { await reader.head(key); return { state: "PRESENT" }; }
    const { content } = await reader.get(key);
    if (!Buffer.isBuffer(content)) return { state: "UNAVAILABLE" };
    const mime = legacyImageMime(content);
    return mime ? { state: "FOUND", bytes: content, mime } : { state: "UNAVAILABLE" };
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    return e.code === "NoSuchKey" && (e.status === 404 || e.status === undefined) ? { state: "MIGRATING" } : { state: "UNAVAILABLE" };
  }
}

export function legacyImageHttpResult(result: LegacyImageResult): { status: number; headers: Record<string, string>; body?: Buffer } {
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (result.state === "MIGRATING") return { status: 404, headers: { ...headers, "x-zzsh-legacy-missing": "1" } };
  if (result.state === "NOT_FOUND") return { status: 404, headers };
  if (result.state === "UNAVAILABLE") return { status: 503, headers };
  if (result.state === "PRESENT") return { status: 200, headers };
  if (result.state === "FOUND") return { status: 200, headers: { ...headers, "content-type": result.mime, "content-length": String(result.bytes.length) }, body: result.bytes };
  return { status: 503, headers };
}
