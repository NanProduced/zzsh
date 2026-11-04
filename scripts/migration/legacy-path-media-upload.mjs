import { createHash } from "node:crypto";
import { legacyImageMime, legacyImageObjectKey, isLegacyImagePath } from "../../apps/api/src/supply/legacy-path-media.ts";

function isMissing(error) { return error?.code === "NoSuchKey" && (error.status === 404 || error.status === undefined); }
function contentType(result) { return String(result?.res?.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase(); }

/** Compare bytes, not a filename or ETag; it does not modify an existing object. */
async function compareExisting(client, key, bytes, mime) {
  const result = await client.get(key);
  if (!Buffer.isBuffer(result.content)) throw new Error("OSS_RESPONSE_INVALID");
  return result.content.equals(bytes) && contentType(result) === mime ? "SKIPPED_IDENTICAL" : "CONFLICT";
}

export async function assertNoOverwriteSupport(client, bucket) {
  const result = await client.getBucketVersioning(bucket);
  if (result?.status !== 200 || (result.versionStatus !== undefined && result.versionStatus !== "")) throw new Error("BUCKET_VERSIONING_NOT_UNVERSIONED");
}

/** Single object transfer. Existing different bytes or MIME are never overwritten. */
export async function transferLegacyObject(client, prefix, sourcePath, bytes, { sample = false, onEvent = () => {} } = {}) {
  if (!isLegacyImagePath(sourcePath) || !Buffer.isBuffer(bytes)) throw new Error("LEGACY_IMAGE_PATH_OR_BYTES_INVALID");
  const mime = legacyImageMime(bytes);
  if (!mime) return { status: "INVALID_IMAGE", mime: null, bytes: bytes.length };
  const md5 = createHash("md5").update(bytes).digest();
  const key = legacyImageObjectKey(prefix, sourcePath);
  try {
    return { status: await compareExisting(client, key, bytes, mime), mime, bytes: bytes.length };
  } catch (error) {
    if (!isMissing(error)) return { status: "UNKNOWN", mime, bytes: bytes.length };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    let put;
    try {
      put = await client.put(key, bytes, { mime, headers: { "x-oss-forbid-overwrite": "true", "Content-MD5": md5.toString("base64") } });
    } catch (error) {
      onEvent({ status: error?.code === "FileAlreadyExists" ? "PUT_COLLISION" : "PUT_UNKNOWN", attempt });
      try {
        const status = await compareExisting(client, key, bytes, mime);
        return { status: status === "SKIPPED_IDENTICAL" ? "CONFIRMED_AFTER_PUT_ERROR" : status, mime, bytes: bytes.length };
      } catch (readError) {
        if (!isMissing(readError) || error?.code === "FileAlreadyExists" || attempt === 2) return { status: "UNKNOWN", mime, bytes: bytes.length };
        onEvent({ status: "RETRY_SAME_KEY_AFTER_MISSING", attempt });
      }
      continue;
    }
    const headers = put?.res?.headers ?? {};
    onEvent({ status: "PUT_ACK", attempt, receipt: { status: put?.res?.status ?? null, requestId: headers["x-oss-request-id"] ?? null, etag: headers.etag ?? null } });
    break;
  }
  try {
    const head = await client.head(key, { headers: { "Accept-Encoding": "identity" } });
    const headers = head?.res?.headers ?? {};
    onEvent({ status: "HEAD_ACK", receipt: { status: head?.status ?? null, requestId: headers["x-oss-request-id"] ?? null, contentLength: headers["content-length"] ?? null, mime: contentType(head), etag: headers.etag ?? null, encrypted: Boolean(headers["x-oss-server-side-encryption"]) } });
    if (head?.status !== 200 || Number(headers["content-length"]) !== bytes.length || contentType(head) !== mime) return { status: "READBACK_MISMATCH", mime, bytes: bytes.length };
    const etag = String(headers.etag ?? "").replace(/^"|"$/g, "").toLowerCase();
    const etagVerified = !headers["x-oss-server-side-encryption"] && /^[0-9a-f]{32}$/.test(etag) && etag === md5.toString("hex");
    const fullReadback = sample || !etagVerified;
    if (fullReadback && (await compareExisting(client, key, bytes, mime)) !== "SKIPPED_IDENTICAL") return { status: "READBACK_MISMATCH", mime, bytes: bytes.length };
    return { status: "UPLOADED", mime, bytes: bytes.length, headVerified: true, etagVerified, fullReadback, sampleVerified: sample };
  } catch { return { status: "UNKNOWN", mime, bytes: bytes.length }; }
}

/** Process a sealed manifest with at most four in-flight objects; log contains restricted paths. */
export async function uploadLegacyManifestBatch({ records, client, prefix, readBytes, log, onProgress = () => {} }) {
  const summary = { status: "STARTED", total: records.length, seen: 0, completed: 0, uploaded: 0, uploadedBytes: 0, identical: 0, confirmedAfterUnknown: 0, conflict: 0, invalid: 0, failed: 0, unknown: 0, headVerified: 0, etagVerified: 0, fullReadback: 0, sampleVerified: 0 };
  const started = performance.now(), firstByDate = new Set(), maxSize = records.reduce((max, record) => Math.max(max, record.size), 0);
  const samples = records.map(record => { const day = record.sourcePath.split("/")[1]; const sample = record.size === maxSize || createHash("sha256").update(record.sourcePath).digest()[0] < 3 || !firstByDate.has(day); firstByDate.add(day); return sample; });
  let stop = false, next = 0;
  const completed = () => { summary.completed++; if (summary.completed % 100 === 0) onProgress({ ...summary }); };
  async function worker() {
    try {
      while (!stop && next < records.length) {
        const i = next++, record = records[i], sourcePath = record.sourcePath;
        summary.seen++;
        if (record.status !== "EXTRACTED") { summary.invalid++; log({ sourcePath, status: record.status }); completed(); continue; }
        let bytes;
        try {
          bytes = await readBytes(record);
          if (!Buffer.isBuffer(bytes) || bytes.length !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256 || legacyImageMime(bytes) !== record.mime) throw new Error("SOURCE_CHANGED");
        } catch { summary.failed++; log({ sourcePath, status: "LOCAL_READ_OR_SHA_FAILED" }); completed(); continue; }
        const key = legacyImageObjectKey(prefix, sourcePath);
        const result = await transferLegacyObject(client, prefix, sourcePath, bytes, { sample: samples[i], onEvent: event => log({ sourcePath, key, ...event }) });
        log({ sourcePath, key, sha256: record.sha256, ...result });
        if (result.status === "UPLOADED") { summary.uploaded++; summary.uploadedBytes += result.bytes; if (result.headVerified) summary.headVerified++; if (result.etagVerified) summary.etagVerified++; if (result.fullReadback) summary.fullReadback++; if (result.sampleVerified) summary.sampleVerified++; }
        else if (result.status === "SKIPPED_IDENTICAL") summary.identical++;
        else if (result.status === "CONFIRMED_AFTER_PUT_ERROR") summary.confirmedAfterUnknown++;
        else if (result.status === "CONFLICT") summary.conflict++;
        else if (result.status === "INVALID_IMAGE") summary.invalid++;
        else { summary.unknown++; stop = true; }
        completed();
      }
    } catch (error) { stop = true; throw error; }
  }
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => worker()));
  if (settled.some(result => result.status === "rejected")) throw new Error("WORKER_FAILED");
  summary.status = summary.unknown ? "STOPPED_UNKNOWN" : summary.conflict || summary.invalid || summary.failed ? "PARTIAL" : summary.seen ? "COMPLETE" : "NO_FILES";
  summary.elapsedSeconds = Math.round((performance.now() - started) / 100) / 10;
  return summary;
}
