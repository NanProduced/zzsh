import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = x => createHash('sha256').update(x).digest('hex');
const fail = (condition, error) => { if (!condition) throw new Error(error); };
function replaceOnce(text, before, after, error) {
  const index = text.indexOf(before);
  fail(index >= 0 && text.indexOf(before, index + before.length) < 0, error);
  return text.slice(0, index) + after + text.slice(index + before.length);
}

// Pure transformation: expected bindings are explicit to permit independent synthetic tests.
export function deriveBuffers(manifestBytes, itemBytes, assetBytes, mediaBytes, expected) {
  fail(sha(manifestBytes) === expected.manifestSha256, 'SOURCE_MANIFEST_SHA_MISMATCH');
  fail(sha(itemBytes) === expected.itemFileSha256, 'SOURCE_ITEM_FILE_SHA_MISMATCH');
  fail(sha(mediaBytes) === expected.mediaObjectsSha256, 'SOURCE_MEDIA_OBJECTS_SHA_MISMATCH');
  const m = JSON.parse(manifestBytes), items = JSON.parse(itemBytes), assets = JSON.parse(assetBytes), media = JSON.parse(mediaBytes);
  fail(m.kind === 'BUSINESS_REFERENCE_PACKAGE_V1' && m.sourceRawUnchanged === true, 'UNEXPECTED_SOURCE_PACKAGE');
  fail(media.sourceManifestSha256 === expected.manifestSha256, 'MEDIA_OBJECT_SOURCE_MISMATCH');
  const descriptors = m.tables.filter(x => x.schema === 'zzsh_supply' && x.table === 'billable_item');
  const assetDescriptors = m.tables.filter(x => x.schema === 'zzsh_supply' && x.table === 'media_asset');
  fail(descriptors.length === 1 && descriptors[0].sha256 === expected.itemFileSha256 && descriptors[0].rows === items.rows.length, 'ITEM_DESCRIPTOR_MISMATCH');
  fail(assetDescriptors.length === 1 && assetDescriptors[0].sha256 === sha(assetBytes) && assetDescriptors[0].rows === assets.rows.length, 'ASSET_DESCRIPTOR_MISMATCH');
  const rows = items.rows.filter(x => JSON.parse(x).code === expected.itemCode);
  fail(rows.length === 1 && sha(rows[0]) === expected.itemRowSha256, 'ITEM_ROW_MISMATCH');
  const item = JSON.parse(rows[0]);
  fail(item.id === expected.itemId && item.media_id === expected.assetId, 'TEST_BINDING_MISMATCH');
  const assetRows = assets.rows.filter(x => JSON.parse(x).id === expected.assetId);
  fail(assetRows.length === 1 && sha(assetRows[0]) === expected.assetRowSha256, 'ASSET_ROW_MISMATCH');
  const asset = JSON.parse(assetRows[0]);
  const manifestMedia = m.media.filter(x => x.id === expected.assetId);
  fail(asset.content_hash === expected.assetContentSha256 && manifestMedia.length === 1 && manifestMedia[0].content_hash === expected.assetContentSha256, 'ASSET_CONTENT_MISMATCH');
  const oldField = `"media_id": "${expected.assetId}"`;
  const newRow = replaceOnce(rows[0], oldField, '"media_id": null', 'MEDIA_FIELD_NOT_EXACT');
  const parsedNewRow = JSON.parse(newRow);
  fail(parsedNewRow.media_id === null, 'MEDIA_NOT_REMOVED');
  delete parsedNewRow.media_id;
  delete item.media_id;
  fail(JSON.stringify(parsedNewRow) === JSON.stringify(item), 'UNEXPECTED_ITEM_CHANGE');
  const oldEncoded = JSON.stringify(rows[0]), newEncoded = JSON.stringify(newRow);
  const derivedItem = replaceOnce(itemBytes.toString('utf8'), oldEncoded, newEncoded, 'ENCODED_ITEM_NOT_UNIQUE');
  fail(replaceOnce(derivedItem, newEncoded, oldEncoded, 'ITEM_REVERSE_FAILED') === itemBytes.toString('utf8'), 'ITEM_BYTE_SCOPE_FAILED');
  const derivedSha = sha(derivedItem);
  let derivedManifest = replaceOnce(manifestBytes.toString('utf8'), expected.itemFileSha256, derivedSha, 'MANIFEST_ITEM_SHA_NOT_UNIQUE');
  derivedManifest = replaceOnce(derivedManifest, '"sourceRawUnchanged": true', '"sourceRawUnchanged": false', 'SOURCE_FLAG_NOT_UNIQUE');
  const reverseFlag = replaceOnce(derivedManifest, '"sourceRawUnchanged": false', '"sourceRawUnchanged": true', 'SOURCE_FLAG_REVERSE_FAILED');
  fail(replaceOnce(reverseFlag, derivedSha, expected.itemFileSha256, 'MANIFEST_SHA_REVERSE_FAILED') === manifestBytes.toString('utf8'), 'MANIFEST_BYTE_SCOPE_FAILED');
  return { derivedManifest: Buffer.from(derivedManifest), derivedItem: Buffer.from(derivedItem), derivedItemRowSha256: sha(newRow), itemCount: items.rows.length };
}

function main() {
  const args = process.argv.slice(2);
  fail(args.length === 6 && args[0] === '--decision' && args[2] === '--decision-sha' && args[4] === '--out', 'USAGE: --decision RESTRICTED_JSON --decision-sha SHA256 --out NEW_RESTRICTED_DIRECTORY');
  const root = realpathSync('E:/zzsh-local-state/restricted'), decisionFile = resolve(args[1]), out = resolve(args[5]);
  fail(dirname(decisionFile).toLowerCase() === root.toLowerCase() && lstatSync(decisionFile).isFile() && !lstatSync(decisionFile).isSymbolicLink(), 'RESTRICTED_DECISION_FILE_REQUIRED');
  const decisionBytes = readFileSync(decisionFile), decisionSha256 = sha(decisionBytes);
  fail(/^[a-f0-9]{64}$/.test(args[3]) && decisionSha256 === args[3], 'DECISION_SHA_MISMATCH');
  const decision = JSON.parse(decisionBytes), expected = decision.expected;
  fail(decision.kind === 'BUSINESS_REFERENCE_MEDIA_UNBIND_DECISION_V1' && typeof decision.ownerDecision === 'string' && decision.ownerDecision.length > 0 && Number.isInteger(decision.sourceTableCount) && expected && typeof decision.sourceDirectory === 'string', 'INVALID_DECISION');
  for (const key of ['manifestSha256', 'itemFileSha256', 'itemRowSha256', 'assetRowSha256', 'mediaObjectsSha256', 'assetContentSha256']) fail(/^[a-f0-9]{64}$/.test(expected[key] ?? ''), 'INVALID_EXPECTED_DIGEST');
  for (const key of ['itemId', 'itemCode', 'assetId']) fail(typeof expected[key] === 'string' && /^[A-Za-z0-9_-]+$/.test(expected[key]), 'INVALID_EXPECTED_IDENTIFIER');
  fail(dirname(out).toLowerCase() === root.toLowerCase() && /^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(out)) && !existsSync(out), 'NEW_RESTRICTED_BOOTSTRAP_DIRECTORY_REQUIRED');
  const source = resolve(decision.sourceDirectory);
  fail(dirname(source).toLowerCase() === root.toLowerCase() && /^data-first-bootstrap-[a-z0-9-]+$/i.test(basename(source)) && !lstatSync(source).isSymbolicLink(), 'SOURCE_LOCATION_MISMATCH');
  const input = realpathSync(source);
  fail(input.toLowerCase() === source.toLowerCase(), 'SOURCE_LOCATION_MISMATCH');
  const sourceManifest = readFileSync(join(input, 'manifest.json'));
  fail(sha(sourceManifest) === expected.manifestSha256, 'SOURCE_MANIFEST_SHA_MISMATCH');
  const manifest = JSON.parse(sourceManifest);
  fail(Array.isArray(manifest.tables) && manifest.tables.length === decision.sourceTableCount, 'SOURCE_TABLE_COUNT_MISMATCH');
  const allowed = new Set(['manifest.json', 'media-objects.json']);
  for (const d of manifest.tables) {
    fail(d.file === basename(d.file) && !allowed.has(d.file), 'DUPLICATE_OR_UNSAFE_FILE');
    allowed.add(d.file);
  }
  const names = readdirSync(input).sort();
  fail(JSON.stringify(names) === JSON.stringify([...allowed].sort()), 'SOURCE_FILE_SET_MISMATCH');
  const original = new Map();
  for (const name of names) {
    const path = join(input, name), info = lstatSync(path);
    fail(info.isFile() && !info.isSymbolicLink(), 'UNSAFE_SOURCE_FILE');
    original.set(name, readFileSync(path));
  }
  for (const d of manifest.tables) {
    const raw = original.get(d.file), table = JSON.parse(raw);
    fail(sha(raw) === d.sha256 && table.schema === d.schema && table.table === d.table && table.rows.length === d.rows, 'SOURCE_TABLE_MISMATCH:' + d.table);
  }
  const built = deriveBuffers(original.get('manifest.json'), original.get('zzsh_supply.billable_item.json'), original.get('zzsh_supply.media_asset.json'), original.get('media-objects.json'), expected);
  const derived = new Map(original);
  derived.set('manifest.json', built.derivedManifest);
  derived.set('zzsh_supply.billable_item.json', built.derivedItem);
  const files = names.map(name => ({ file: name, sourceSha256: sha(original.get(name)), derivedSha256: sha(derived.get(name)) }));
  fail(files.filter(x => x.sourceSha256 !== x.derivedSha256).map(x => x.file).sort().join('|') === 'manifest.json|zzsh_supply.billable_item.json', 'UNEXPECTED_FILES_CHANGED');
  const tableCounts = manifest.tables.map(d => ({ table: d.schema + '.' + d.table, sourceRows: d.rows, derivedRows: JSON.parse(derived.get(d.file)).rows.length }));
  fail(tableCounts.every(d => d.sourceRows === d.derivedRows), 'ROW_COUNT_CHANGED');
  const receipt = {
    kind: 'BUSINESS_REFERENCE_MEDIA_UNBIND_DERIVATION_V1', decision: decision.ownerDecision, decisionSha256,
    sourceManifestSha256: expected.manifestSha256, derivedManifestSha256: sha(built.derivedManifest),
    changedBusinessData: { table: 'zzsh_supply.billable_item', itemId: expected.itemId, code: expected.itemCode, column: 'media_id', sourceAssetId: expected.assetId, derivedValue: null, sourceItemRowSha256: expected.itemRowSha256, derivedItemRowSha256: built.derivedItemRowSha256, assetContentSha256: expected.assetContentSha256 },
    manifestMetadataChanges: ['billable_item sha256 updated', 'sourceRawUnchanged true -> false'],
    retained: 'All media rows and objects retained. media-objects.json is unchanged and its sourceManifestSha256 continues to identify the original capture, not the derived manifest. No media bytes checked.',
    sourceTableCount: manifest.tables.length, derivedTableCount: tableCounts.length,
    sourceRows: tableCounts.reduce((s, x) => s + x.sourceRows, 0), derivedRows: tableCounts.reduce((s, x) => s + x.derivedRows, 0), tableCounts, files,
    connections: 0, credentialReads: 0, ossReads: 0,
  };
  mkdirSync(out);
  const sid = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).trim();
  fail(/^S-1-5-\d+(?:-\d+)+$/.test(sid), 'LOCAL_IDENTITY_REQUIRED');
  execFileSync('icacls', [out, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'pipe' });
  for (const [name, contents] of derived) writeFileSync(join(out, name), contents, { flag: 'wx' });
  writeFileSync(join(out, 'derivation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  for (const [name, contents] of original) fail(sha(readFileSync(join(input, name))) === sha(contents), 'SOURCE_CHANGED_DURING_DERIVATION');
  for (const [name, contents] of derived) fail(sha(readFileSync(join(out, name))) === sha(contents), 'DERIVED_READBACK_MISMATCH');
  console.log(JSON.stringify({ status: 'DERIVED_READBACK_VERIFIED', output: out, manifestSha256: receipt.derivedManifestSha256, tables: receipt.derivedTableCount, rows: receipt.derivedRows, changedBusinessRows: 1, connections: 0, credentialReads: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
