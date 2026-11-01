import { createHash, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The four Owner-supplied first-party avatars are pre-reviewed immutable
 * resources. `contentHash` is the storage key of the sanitized 256x256 WebP
 * derivative; `originalSha256` keeps the source image traceable without
 * shipping it or exposing it through the public read route.
 */
export const PROFILE_AVATAR_PRESETS = [
  { presetId: "avatar-strike", version: 1, assetFile: "avatar-strike.webp", mime: "image/webp", width: 256, height: 256, byteSize: 15002, contentHash: "ba84c8b6fe5d50fe6420d2cc82bc29d0d4d2bb354e43985b057e9d3abd7d9b5e", originalSha256: "7a00f7366ada819c09b5112f06bab7a42f9f99880b8f64201caa79ffae3e18a4" },
  { presetId: "avatar-night", version: 1, assetFile: "avatar-night.webp", mime: "image/webp", width: 256, height: 256, byteSize: 14888, contentHash: "729e1d422f3ade04ae135751fe7e7209e99d3323331fbf2a69e6cd2ce86d7a3c", originalSha256: "7099e06d7463e29b3d5a68c60db6c30cf49eab3e989d3fcd578c9e56a7704a0b" },
  { presetId: "avatar-frost", version: 1, assetFile: "avatar-frost.webp", mime: "image/webp", width: 256, height: 256, byteSize: 18706, contentHash: "76af969bba98b6bbcf6212abfc7fa9e581c314636fe9180d0c564888466125a3", originalSha256: "ac807b3065c904f789c87ba931e5fc4f5af790e6afcadd712fbde3318606f107" },
  { presetId: "avatar-aurora", version: 1, assetFile: "avatar-aurora.webp", mime: "image/webp", width: 256, height: 256, byteSize: 16622, contentHash: "bb22975e2a6c9fd3c83649ddc73fa52255a3b52bf1d3c018e1a23e6f6af3aaa0", originalSha256: "7d7dded5216d2bf9dfad739766e43e2d12fe475f2498773811d33b89b154ccd5" },
] as const;

export type ProfileAvatarPreset = (typeof PROFILE_AVATAR_PRESETS)[number];
export type ProfileAvatarPresetId = ProfileAvatarPreset["presetId"];
export type ProfileAvatarRealm = "user" | "admin";

export const PROFILE_AVATAR_PRESET_IDS = PROFILE_AVATAR_PRESETS.map((preset) => preset.presetId);
const presetById = new Map<string, ProfileAvatarPreset>(PROFILE_AVATAR_PRESETS.map((preset) => [preset.presetId, preset]));

export function isProfileAvatarPresetId(value: unknown): value is ProfileAvatarPresetId {
  return typeof value === "string" && presetById.has(value);
}

export function profileAvatarPreset(presetId: string): ProfileAvatarPreset {
  const preset = presetById.get(presetId);
  if (!preset) throw new Error("avatar preset is not registered");
  return preset;
}

/** Stable per-subject default used before a profile row is persisted (old accounts without backfill). */
export function deterministicPresetId(realm: ProfileAvatarRealm, subjectId: string): ProfileAvatarPresetId {
  const digest = createHash("sha256").update(`${realm}:${subjectId}`, "utf8").digest();
  return PROFILE_AVATAR_PRESETS[digest.readUInt32BE(0) % PROFILE_AVATAR_PRESETS.length]!.presetId;
}

/** A new subject gets one random default; the result is persisted by the caller. */
export function randomPresetId(): ProfileAvatarPresetId {
  return PROFILE_AVATAR_PRESETS[randomInt(0, PROFILE_AVATAR_PRESETS.length)]!.presetId;
}

export function presetContentPath(preset: Pick<ProfileAvatarPreset, "presetId" | "version">): string {
  return `/api/v1/profile/avatars/presets/${preset.presetId}/${preset.version}/content`;
}

export function profileAvatarAssetRoot(): string {
  return resolve(__dirname, "../../../assets/profile-avatars");
}

export async function loadPresetBytes(preset: ProfileAvatarPreset): Promise<Buffer> {
  const bytes = await readFile(resolve(profileAvatarAssetRoot(), preset.assetFile));
  if (bytes.length !== preset.byteSize) throw new Error(`avatar preset ${preset.presetId} size mismatch`);
  if (createHash("sha256").update(bytes).digest("hex") !== preset.contentHash) throw new Error(`avatar preset ${preset.presetId} hash mismatch`);
  return bytes;
}
