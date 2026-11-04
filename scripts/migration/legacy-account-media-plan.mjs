// SUPERSEDED: retained only to reproduce the original source-reference evidence.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import sharp from "sharp";

const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(Buffer.from(JSON.stringify(value)));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const fields = { img_paths: "ACCOUNT_DISPLAY", punishment_img_url: "ACCOUNT_EVIDENCE" };

function validBasename(value) {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    !/[\\/:*?"<>|\u0000-\u001f]/u.test(value) && !/[. ]$/u.test(value);
}

function sourcePath(token) {
  if (validBasename(token)) return { basename: token, relativePath: null };
  const normalized = token.startsWith("accountsImage/") ? token.slice("accountsImage/".length) : token;
  const parts = normalized.split("/");
  return parts.length === 2 && /^\d{8}$/.test(parts[0]) && validBasename(parts[1])
    ? { basename: parts[1], relativePath: parts.join("/") } : null;
}

/** Contains original source values and must be stored as restricted data. */
export function planAccountMediaReferences({ sourceSnapshotSha256, accountId, ownerUserId, row }) {
  if (!digestPattern.test(sourceSnapshotSha256 ?? "") || !row || !/^[1-9][0-9]*$/.test(row.id ?? "") || !/^[1-9][0-9]*$/.test(row.user_id ?? "") || (accountId != null && !idPattern.test(accountId)) || (ownerUserId != null && !idPattern.test(ownerUserId)) || ((accountId == null) !== (ownerUserId == null))) throw new Error("SOURCE_IDENTITY_REQUIRED");
  const result = { schema: "legacy-account-media-reference-v1", sourceSnapshotSha256, legacyAccountId: row.id, legacyOwnerId: row.user_id, accountId: accountId ?? null, ownerUserId: ownerUserId ?? null, bindingState: accountId == null ? "UNBOUND" : "TARGET_MAPPING_REQUIRES_VERIFICATION", fields: {}, references: [] };
  for (const [field, purpose] of Object.entries(fields)) {
    if (!Object.hasOwn(row, field)) { result.fields[field] = { observation: "ABSENT" }; continue; }
    const raw = row[field];
    if (raw === null) { result.fields[field] = { observation: "NULL", raw }; continue; }
    if (typeof raw !== "string") { result.fields[field] = { observation: "INVALID" }; continue; }
    const tokens = raw.split(",");
    const seen = new Set(); let position = 0;
    for (const [ordinal, value] of tokens.entries()) {
      const token = value.trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      const path = sourcePath(token);
      const state = path ? "PENDING_IMPORT" : "ISOLATED";
      result.references.push({
        referenceId: digest({ sourceSnapshotSha256, legacyAccountId: row.id, field, ordinal, token }),
        field, purpose, ordinal, position: position++, sourceToken: token, sourceBasename: path?.basename ?? null, sourceRelativePath: path?.relativePath ?? null, state,
        reason: state === "ISOLATED" ? "SOURCE_PATH_UNSAFE_OR_EXTERNAL" : "BYTES_NOT_IMPORTED",
        assetId: null,
      });
    }
    result.fields[field] = { observation: position ? "PRESENT" : "EMPTY", raw };
  }
  return result;
}

async function assertNoLinks(path) {
  let current = resolve(path);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("REPARSE_POINT_REFUSED");
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return;
    current = parent;
  }
}

async function inspectImage(path) {
  const size = (await lstat(path)).size;
  if (size <= 0 || size > 10 * 1024 * 1024) throw new Error("IMAGE_SIZE_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== size) throw new Error("IMAGE_CHANGED_WHILE_READING");
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 }).timeout({ seconds: 10 });
  const metadata = await decoder.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) throw new Error("IMAGE_FORMAT_INVALID");
  const { data: publicBytes, info } = await decoder.autoOrient().toFormat(metadata.format).toBuffer({ resolveWithObject: true });
  if (publicBytes.length > 10 * 1024 * 1024 || info.width > 8192 || info.height > 8192) throw new Error("DERIVATIVE_INVALID");
  const publicMeta = await sharp(publicBytes).metadata();
  if (publicMeta.exif || publicMeta.format !== metadata.format) throw new Error("DERIVATIVE_METADATA_INVALID");
  return { sha256: hash(bytes), byteSize: bytes.length, mime: `image/${metadata.format}`, width: info.width, height: info.height,
    publicDerivative: { sha256: hash(publicBytes), byteSize: publicBytes.length, mime: `image/${metadata.format}` } };
}

/** Scans supplied date directories only. Results remain restricted; no assets or bindings are written. */
export async function scanAccountMediaBatch(manifests, directory) {
  if (!Array.isArray(manifests) || manifests.some(manifest => manifest?.schema !== "legacy-account-media-reference-v1" || !Array.isArray(manifest.references))) throw new Error("REFERENCE_MANIFEST_INVALID");
  const root = resolve(directory);
  await assertNoLinks(root);
  if (!(await lstat(root)).isDirectory()) throw new Error("SAMPLE_DIRECTORY_REQUIRED");
  const wanted = new Set(manifests.flatMap(manifest => manifest.references.filter(ref => ref.state === "PENDING_IMPORT" && sourcePath(ref.sourceToken)).map(ref => sourcePath(ref.sourceToken).basename)));
  const matches = new Map([...wanted].map(name => [name, []]));
  let linkedDirectories = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { linkedDirectories++; continue; }
    if (!entry.isDirectory()) continue;
    const folder = join(root, entry.name);
    if ((await lstat(folder)).isSymbolicLink()) { linkedDirectories++; continue; }
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (!wanted.has(file.name)) continue;
      const path = join(folder, file.name), rel = relative(root, path).replaceAll("\\", "/");
      if (isAbsolute(rel) || rel.startsWith("..") || basename(path) !== file.name) throw new Error("SAMPLE_PATH_INVALID");
      if (!file.isFile() || file.isSymbolicLink() || (await lstat(path)).isSymbolicLink()) {
        matches.get(file.name).push({ path: rel, error: "UNSAFE_OR_NONFILE" }); continue;
      }
      try { matches.get(file.name).push({ path: rel, ...await inspectImage(path) }); }
      catch { matches.get(file.name).push({ path: rel, error: "INVALID_OR_UNREADABLE_IMAGE" }); }
    }
  }
  return manifests.map(manifest => ({ ...manifest, references: manifest.references.map(ref => {
    if (ref.state !== "PENDING_IMPORT") return { ...ref };
    const source = sourcePath(ref.sourceToken);
    if (!source || fields[ref.field] !== ref.purpose || source.basename !== ref.sourceBasename || source.relativePath !== ref.sourceRelativePath) return { ...ref, state: "ISOLATED", reason: "SOURCE_REFERENCE_DRIFT" };
    const found = (matches.get(source.basename) ?? []).filter(item => !source.relativePath || item.path === source.relativePath).sort((a, b) => a.path.localeCompare(b.path));
    if (!found.length) return { ...ref, reason: "BYTES_NOT_FOUND" };
    if (found.some(item => item.error)) return { ...ref, state: "ISOLATED", reason: "SAMPLE_INVALID_OR_UNSAFE", candidates: found };
    if (new Set(found.map(item => item.sha256)).size > 1) return { ...ref, state: "ISOLATED", reason: "AMBIGUOUS_BASENAME", candidates: found };
    return { ...ref, reason: source.relativePath ? "FOUND_EXACT_SOURCE_PATH" : "FOUND_BASENAME_INDEX_REQUIRED", candidates: found };
  }), scan: { linkedDirectoriesIgnored: linkedDirectories, storageWrites: 0, databaseWrites: 0, sampleCoverage: "NOT_ASSERTED" } }));
}

export async function scanAccountMediaReferences(manifest, directory) {
  return (await scanAccountMediaBatch([manifest], directory))[0];
}

/** Only opaque status/position leave the restricted boundary; evidence never enters a public gallery. */
export function projectAccountMediaSlots(manifest, { publicEligible = false, verifiedPublicAssetIds = new Set() } = {}) {
  if (manifest?.schema !== "legacy-account-media-reference-v1" || !Array.isArray(manifest.references)) throw new Error("REFERENCE_MANIFEST_INVALID");
  if (!publicEligible) return [];
  return manifest.references.filter(ref => ref.field === "img_paths" && ref.purpose === "ACCOUNT_DISPLAY").map(ref => ({ position: ref.position,
    state: ref.state === "PENDING_IMPORT" ? "PENDING_IMPORT" : ref.state === "READY" && idPattern.test(ref.assetId ?? "") && verifiedPublicAssetIds.has(ref.assetId) ? "READY" : "UNAVAILABLE",
    ...(ref.state === "READY" && idPattern.test(ref.assetId ?? "") && verifiedPublicAssetIds.has(ref.assetId) ? { assetId: ref.assetId } : {}),
  }));
}

/** A reviewed source association prepares operations; it is not an upload or a READY receipt. */
export function planAccountMediaImport(reference, association = {}) {
  if (reference?.state !== "PENDING_IMPORT" || !Array.isArray(reference.candidates)) throw new Error("REVIEWED_SOURCE_ASSOCIATION_REQUIRED");
  const source = sourcePath(reference.sourceToken);
  if (!source || source.basename !== reference.sourceBasename || source.relativePath !== reference.sourceRelativePath) throw new Error("SOURCE_REFERENCE_DRIFT");
  if (source.relativePath) {
    association = { kind: "EXACT_SOURCE_PATH", referenceId: reference.referenceId, path: source.relativePath };
  } else {
    if (association.kind !== "UNIQUE_PATH_INDEX" || association.referenceId !== reference.referenceId || !digestPattern.test(association.evidenceSha256 ?? "") || !Array.isArray(association.paths)) throw new Error("REVIEWED_SOURCE_ASSOCIATION_REQUIRED");
    if (association.paths.some(path => typeof path !== "string" || !sourcePath(path)?.relativePath) || digest([...association.paths].sort()) !== association.evidenceSha256) throw new Error("SOURCE_INDEX_DIGEST_MISMATCH");
    const indexed = association.paths.filter(path => sourcePath(path).basename === source.basename);
    if (!indexed.length || indexed.some(path => !sourcePath(path)?.relativePath) || new Set(indexed).size !== indexed.length || indexed.length !== reference.candidates.length || indexed.some(path => !reference.candidates.some(item => item.path === sourcePath(path).relativePath))) throw new Error("SOURCE_INDEX_OR_BYTES_INCOMPLETE");
    association = { kind: association.kind, referenceId: association.referenceId, path: sourcePath(indexed[0]).relativePath, evidenceSha256: association.evidenceSha256 };
  }
  const candidate = reference.candidates.find(item => item.path === association.path);
  if (!candidate || candidate.error || reference.candidates.some(item => item.error || item.sha256 !== candidate.sha256)) throw new Error("UNIQUE_BYTE_IDENTITY_REQUIRED");
  return { schema: "legacy-account-media-import-plan-v1", status: "READY_FOR_REVIEWED_UPLOAD", referenceId: reference.referenceId,
    purpose: reference.purpose, path: candidate.path, sourceSha256: candidate.sha256, publicSha256: candidate.publicDerivative.sha256,
    mime: candidate.mime, sourceAssociation: association, storageWrites: 0, databaseWrites: 0 };
}
