import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(root, "scripts/migration/catalog-item-media-manifest.json");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedUnits = {
  df_billable_level6_bullet: "ROUND", df_billable_level6_armor: "PIECE", df_billable_level6_helmet: "PIECE",
  df_billable_awm_bullet: "ROUND", df_billable_barrett_bullet: "ROUND", df_billable_top_insure_card: "DAY",
  df_billable_coffee: "PIECE", df_billable_turtle_backpack_45: "PIECE",
};

export async function inspectItemImage(bytes, item) {
  if (bytes.length !== item.byteSize || bytes.length > 10 * 1024 * 1024 || sha256(bytes) !== item.sha256) throw new Error(`SOURCE_BYTES_MISMATCH:${item.code}`);
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 }).timeout({ seconds: 10 });
  const metadata = await decoder.metadata();
  if (metadata.format !== "png" || item.mime !== "image/png" || (metadata.pages ?? 1) !== 1 || metadata.width !== item.width || metadata.height !== item.height || metadata.width > 8192 || metadata.height > 8192) throw new Error(`IMAGE_METADATA_MISMATCH:${item.code}`);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let first;
  let varied = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const rgb = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    if (first === undefined) first = rgb;
    else if (first !== rgb) { varied = true; break; }
  }
  if (!varied) throw new Error(`UNIFORM_OR_EMPTY_IMAGE:${item.code}`);
  const { data: publicBytes, info } = await decoder.autoOrient().toFormat("png").toBuffer({ resolveWithObject: true });
  if (info.width !== item.width || info.height !== item.height || publicBytes.length > 10 * 1024 * 1024) throw new Error(`PUBLIC_DERIVATIVE_MISMATCH:${item.code}`);
  return { ...item, publicDerivative: { sha256: sha256(publicBytes), byteSize: publicBytes.length, mime: item.mime } };
}

export async function checkCatalogItemMedia(manifest, repoRoot = root) {
  if (manifest.schema !== "catalog-item-media-v1" || manifest.gameCode !== "delta" || manifest.purpose !== "ITEM_MEDIA" || manifest.ownershipKind !== "PLATFORM_CATALOG" || !Array.isArray(manifest.items) || manifest.items.length !== Object.keys(expectedUnits).length) throw new Error("MANIFEST_INVALID");
  const assetRoot = await realpath(resolve(repoRoot, "apps/web/public/art/delta/items"));
  const codes = new Set(), files = new Set(), results = [];
  for (const item of manifest.items) {
    if (!Object.hasOwn(expectedUnits, item.code) || codes.has(item.code) || item.unit !== expectedUnits[item.code] || item.quantityScale !== 0 || typeof item.file !== "string") throw new Error(`ITEM_INVALID:${item.code}`);
    const file = await realpath(resolve(repoRoot, item.file));
    const subpath = relative(assetRoot, file);
    if (!subpath || subpath.startsWith("..") || isAbsolute(subpath) || files.has(file)) throw new Error(`SOURCE_PATH_INVALID:${item.code}`);
    codes.add(item.code); files.add(file);
    results.push(await inspectItemImage(await readFile(file), item));
  }
  return { status: "SOURCE_ASSETS_VERIFIED", schema: manifest.schema, gameCode: manifest.gameCode, purpose: manifest.purpose, ownershipKind: manifest.ownershipKind, items: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    console.log(JSON.stringify(await checkCatalogItemMedia(manifest), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
