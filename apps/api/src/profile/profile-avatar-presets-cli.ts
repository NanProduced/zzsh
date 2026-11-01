import { createHash } from "node:crypto";

import { decodeImage } from "../supply/media";
import { resolveMediaStorage } from "../supply/media-oss";
import { loadPresetBytes, PROFILE_AVATAR_PRESETS } from "./profile-avatar-presets";

/**
 * Replayable first-party avatar object initialization and check.
 * `check` never writes; `upload` only writes missing content-addressed objects.
 * Exit code 1 means at least one preset is missing or failed verification.
 */
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "check";
  if (mode !== "check" && mode !== "upload") throw new Error("usage: profile-avatar-presets [check|upload]");
  const storage = resolveMediaStorage(process.env, process.cwd());
  if (!storage.available) throw new Error("media storage is not configured");
  let failed = 0;
  let uploaded = 0;
  let reused = 0;
  for (const preset of PROFILE_AVATAR_PRESETS) {
    try {
      const bytes = await loadPresetBytes(preset);
      const info = await decodeImage(bytes);
      if (info.info.mime !== preset.mime || info.info.width !== preset.width || info.info.height !== preset.height) {
        throw new Error("decoded image does not match the manifest");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== preset.contentHash) throw new Error("content hash does not match");
      let status = "PRESENT";
      try {
        const existing = await storage.read(preset.contentHash);
        if (!existing.equals(bytes)) throw new Error("stored object bytes do not match");
        reused += 1;
      } catch (error) {
        if (mode !== "upload") throw error;
        await storage.write(bytes, preset.contentHash, preset.mime);
        const readBack = await storage.read(preset.contentHash);
        if (!readBack.equals(bytes)) throw new Error("read-back does not match the uploaded bytes");
        status = "UPLOADED";
        uploaded += 1;
      }
      console.log(JSON.stringify({
        presetId: preset.presetId,
        version: preset.version,
        storageKey: preset.contentHash,
        mime: preset.mime,
        width: preset.width,
        height: preset.height,
        bytes: preset.byteSize,
        originalSha256: preset.originalSha256,
        backend: storage.kind,
        status,
      }));
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        presetId: preset.presetId,
        storageKey: preset.contentHash,
        backend: storage.kind,
        status: "FAILED",
        error: error instanceof Error ? error.message : "unknown failure",
      }));
    }
  }
  console.log(JSON.stringify({ event: "profile_avatar_presets", mode, backend: storage.kind, total: PROFILE_AVATAR_PRESETS.length, uploaded, reused, failed }));
  if (failed > 0) {
    console.error("profile avatar presets are not ready; do not treat avatars as live until every preset reports PRESENT or UPLOADED");
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "profile avatar preset command failed");
  process.exitCode = 1;
});
