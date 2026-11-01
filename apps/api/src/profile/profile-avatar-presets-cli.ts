import { createHash } from "node:crypto";

import { decodeImage, MediaStorageError } from "../supply/media";
import { resolveMediaStorage } from "../supply/media-oss";
import { loadPresetBytes, PROFILE_AVATAR_PRESETS } from "./profile-avatar-presets";

function safeFailureCode(error: unknown): string {
  if (error instanceof MediaStorageError) return error.code;
  const code = error instanceof Error ? error.message : "";
  return ["AVATAR_PRESET_MANIFEST_MISMATCH", "AVATAR_PRESET_OBJECT_CONFLICT"].includes(code)
    ? code : "AVATAR_PRESET_OPERATION_FAILED";
}

/** Checks object bytes only; stored Content-Type, private ACL and live API access need separate verification. */
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if ((mode !== "check" && mode !== "upload") || process.argv.length > 3) throw new Error("AVATAR_PRESET_USAGE_INVALID");
  const storage = resolveMediaStorage(process.env, process.cwd());
  if (!storage.available) throw new Error("AVATAR_PRESET_STORAGE_UNAVAILABLE");
  let failed = 0;
  let uploaded = 0;
  let reused = 0;
  let attempted = 0;
  let unknown = 0;
  for (const preset of PROFILE_AVATAR_PRESETS) {
    attempted += 1;
    let writeAttempted = false;
    let writeAcknowledged = false;
    try {
      const bytes = await loadPresetBytes(preset);
      const info = await decodeImage(bytes);
      if (info.info.mime !== preset.mime || info.info.width !== preset.width || info.info.height !== preset.height
        || createHash("sha256").update(bytes).digest("hex") !== preset.contentHash) {
        throw new Error("AVATAR_PRESET_MANIFEST_MISMATCH");
      }
      let existing: Buffer | null = null;
      try {
        existing = await storage.read(preset.contentHash);
      } catch (error) {
        // Only the adapters' confirmed missing-object result permits a write.
        if (mode !== "upload" || !(error instanceof MediaStorageError) || error.code !== "MEDIA_OBJECT_NOT_FOUND") throw error;
      }
      let status = "PRESENT";
      if (existing !== null) {
        if (!existing.equals(bytes)) throw new Error("AVATAR_PRESET_OBJECT_CONFLICT");
        reused += 1;
      } else {
        writeAttempted = true;
        await storage.write(bytes, preset.contentHash, preset.mime);
        writeAcknowledged = true;
        const readBack = await storage.read(preset.contentHash);
        if (!readBack.equals(bytes)) throw new Error("AVATAR_PRESET_OBJECT_CONFLICT");
        status = "UPLOADED";
        uploaded += 1;
      }
      console.log(JSON.stringify({ presetId: preset.presetId, version: preset.version, storageKey: preset.contentHash,
        mime: preset.mime, mimeOrigin: "DECODED_SOURCE", storedMetadataVerification: "NOT_OBSERVED",
        width: preset.width, height: preset.height, bytes: preset.byteSize, originalSha256: preset.originalSha256,
        backend: storage.kind, status }));
    } catch (error) {
      failed += 1;
      const errorCode = safeFailureCode(error);
      const status = errorCode === "AVATAR_PRESET_OBJECT_CONFLICT" ? "CONFLICT" : writeAttempted ? "UNKNOWN" : "FAILED";
      if (status === "UNKNOWN") unknown += 1;
      console.error(JSON.stringify({ presetId: preset.presetId, storageKey: preset.contentHash, backend: storage.kind,
        status, errorCode, writeAttempted, writeAcknowledged }));
      if (mode === "upload") break;
    }
  }
  const notAttempted = PROFILE_AVATAR_PRESETS.length - attempted;
  for (const preset of PROFILE_AVATAR_PRESETS.slice(attempted)) {
    console.log(JSON.stringify({ presetId: preset.presetId, storageKey: preset.contentHash, backend: storage.kind, status: "NOT_ATTEMPTED" }));
  }
  console.log(JSON.stringify({ event: "profile_avatar_presets", mode, backend: storage.kind,
    total: PROFILE_AVATAR_PRESETS.length, attempted, notAttempted, uploaded, reused, failed, unknown,
    storedMetadataVerification: "NOT_OBSERVED", result: failed ? "OBJECT_BYTES_NOT_VERIFIED" : "OBJECT_BYTES_VERIFIED" }));
  if (failed > 0) process.exitCode = 1;
}

void main().catch(() => {
  console.error(JSON.stringify({ event: "profile_avatar_presets", status: "FAILED", errorCode: "AVATAR_PRESET_INITIALIZATION_FAILED" }));
  process.exitCode = 1;
});
