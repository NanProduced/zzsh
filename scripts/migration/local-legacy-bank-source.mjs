import { createHash, randomBytes } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { mysqlDumpTuples } from "./verify-legacy-listed-policy-dump.mjs";
import { readSourceRows } from "./local-source-adapter.mjs";

const sources = new WeakMap();
const selections = new WeakMap();
const sha = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw Error("LEGACY_BANK_SOURCE_VERIFICATION_FAILED"); };

function checkedPath(value, root) {
  if (typeof value !== "string" || !isAbsolute(value)) fail();
  const file = resolve(value), rel = relative(resolve(root), file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail();
  for (let p = file; p !== dirname(p); p = dirname(p)) if (lstatSync(p).isSymbolicLink()) fail();
  return file;
}
function document(path, expected) {
  if (!hex(expected)) fail();
  const bytes = readFileSync(path); if (sha(bytes) !== expected) fail();
  try { return JSON.parse(bytes); } catch { return fail(); }
}
async function fileHash(file) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
function rowDigest(row, salt) {
  const [userId, name, card, created, updated] = row, pad = (value, width) => String(value).padStart(width, "0");
  if (!/^[1-9][0-9]{0,23}$/.test(userId) || !/^[0-9]{1,12}$/.test(created) || !/^[0-9]{1,12}$/.test(updated)) fail();
  return sha(salt + pad(userId, 24) + pad(Buffer.byteLength(name), 6) + name + pad(Buffer.byteLength(card), 6) + card + pad(created, 16) + pad(updated, 16));
}
/** The salted aggregate is only a transient equality check; it is not stored as a public source fingerprint. */
export function legacyBankPrivateComparisonDigest(rows, salt) {
  if (!Array.isArray(rows) || !rows.length || !/^[a-f0-9]{64}$/.test(salt ?? "")) fail();
  const hashes = rows.map(row => ({ id: row.user_id, digest: rowDigest([row.user_id, row.name, row.card_no, row.create_time, row.update_time], salt) }));
  hashes.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
  if (hashes.some((row, i) => i > 0 && hashes[i - 1].id === row.id)) fail();
  return sha(hashes.map(row => row.digest).join(""));
}

/** Read and compare the exact bound dump with one read-only restore snapshot. Private values remain in memory only. */
export async function captureBoundLegacyBankSource(input, canonicalize) {
  try {
    if (!input || typeof canonicalize !== "function") fail();
    const sourceRoot = "E:/zzsh-local-state/restricted", sourceDir = checkedPath(input.sourceDir, sourceRoot);
    const receiptFile = checkedPath(resolve(sourceDir, "receipt.json"), sourceRoot), receipt = document(receiptFile, input.sourceReceiptSha256);
    const bindingPath = checkedPath(input.sourceBinding, "D:/CodexWorktrees"), binding = document(bindingPath, input.sourceBindingSha256);
    if (receipt.status !== "CAPTURED_READ_ONLY" || !receipt.rollbackConfirmed || !receipt.clientClosed || receipt.database !== "sg_zzsh_restore"
      || !/^[a-f0-9]{64}$/.test(receipt.containerId ?? "") || binding.container?.id !== receipt.containerId
      || !hex(binding.restoreRecord?.dumpSha256) || !Number.isFinite(Date.parse(binding.restoreRecord?.cutoff ?? ""))) fail();
    const dump = checkedPath(binding.restoreRecord.dumpPath, "E:/zzsh/.archive");
    if (await fileHash(dump) !== binding.restoreRecord.dumpSha256) fail();
    const userFile = receipt.files?.users;
    if (!userFile || userFile.file !== basename(userFile.file) || !hex(userFile.sha256)) fail();
    const usersPath = checkedPath(resolve(sourceDir, userFile.file), sourceRoot);
    if (await fileHash(usersPath) !== userFile.sha256) fail();
    const userDigests = new Map();
    for await (const row of readSourceRows(usersPath)) {
      if (!/^[1-9][0-9]{0,23}$/.test(row.id ?? "") || userDigests.has(row.id)) fail();
      userDigests.set(row.id, sha(canonicalize(row)));
    }
    if (userDigests.size !== userFile.rows) fail();
    const inspected = spawnSync("docker", ["inspect", "--format", "{{.Id}}", "zzsh-mysql-restore"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (inspected.status !== 0 || inspected.stdout.trim() !== receipt.containerId) fail();
    const salt = randomBytes(32).toString("hex"), rows = [];
    const stream = createReadStream(dump, { encoding: "utf8" }), lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line.startsWith("INSERT INTO `la_user_bank` ")) for (const row of mysqlDumpTuples(line)) {
        if (row.length !== 5) fail();
        rows.push({ user_id: row[0], name: row[1], card_no: row[2], create_time: row[3], update_time: row[4] });
      }
    } finally { lines.close(); stream.destroy(); }
    const expected = legacyBankPrivateComparisonDigest(rows, salt);
    const sql = `SET SESSION transaction_read_only=1; SET SESSION transaction_isolation='REPEATABLE-READ'; SET SESSION max_execution_time=60000; SET SESSION group_concat_max_len=2000000; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;
SELECT JSON_OBJECT('phase','identity','database',DATABASE(),'principal',CURRENT_USER(),'readOnly',@@transaction_read_only,'isolation',@@transaction_isolation,'accessMode',(SELECT ACCESS_MODE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID()),'txState',(SELECT STATE FROM performance_schema.events_transactions_current t JOIN performance_schema.threads p ON p.THREAD_ID=t.THREAD_ID WHERE p.PROCESSLIST_ID=CONNECTION_ID()));
SELECT JSON_OBJECT('phase','bank','count',COUNT(*),'digest',SHA2(GROUP_CONCAT(SHA2(CONCAT('${salt}',LPAD(CAST(user_id AS CHAR),24,'0'),LPAD(OCTET_LENGTH(name),6,'0'),name,LPAD(OCTET_LENGTH(card_no),6,'0'),card_no,LPAD(CAST(create_time AS CHAR),16,'0'),LPAD(CAST(update_time AS CHAR),16,'0')),256) ORDER BY user_id SEPARATOR ''),256)) FROM la_user_bank;
ROLLBACK; SELECT JSON_OBJECT('phase','rollback');`;
    const result = spawnSync("docker", ["exec", "-i", receipt.containerId, "mysql", "--defaults-extra-file=/root/.my.cnf", "--user=root", "--protocol=SOCKET",
      "--skip-reconnect", "--local-infile=0", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names", "sg_zzsh_restore"],
    { input: sql, encoding: "utf8", windowsHide: true, timeout: 70000, maxBuffer: 100000 });
    if (result.status !== 0) fail();
    let values; try { values = result.stdout.trim().split("\n").map(JSON.parse); } catch { return fail(); }
    const identity = values.find(row => row.phase === "identity"), bank = values.find(row => row.phase === "bank");
    if (identity?.database !== "sg_zzsh_restore" || identity.principal !== "root@localhost" || identity.readOnly !== 1 || identity.isolation !== "REPEATABLE-READ"
      || identity.accessMode !== "READ ONLY" || identity.txState !== "ACTIVE" || !values.some(row => row.phase === "rollback")
      || bank?.count !== rows.length || bank.digest !== expected) fail();
    const token = Object.freeze({ kind: "BOUND_LEGACY_BANK_SOURCE" });
    sources.set(token, { rows, userDigests, source: { sourceReceiptSha256: input.sourceReceiptSha256,
      sourceDumpSha256: binding.restoreRecord.dumpSha256, sourceCutoff: binding.restoreRecord.cutoff } });
    return token;
  } catch { return fail(); }
}

/** Internal transfer only; never serialize this value or include it in receipts. */
export function useBoundLegacyBankSource(token) { const value = sources.get(token); if (!value) fail(); return value; }
export function releaseBoundLegacyBankSource(token) { sources.delete(token); }

/** Only users in the sealed R06 dataset are eligible, even if other legacy users exist at the target. */
export async function captureBoundLegacyBankSelection(manifestPath, manifestSha256) {
  try {
    const root = "E:/zzsh-local-state/restricted", path = checkedPath(manifestPath, root), manifest = document(path, manifestSha256), users = manifest.files?.users;
    if (manifest.status !== "FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN" || !hex(manifest.sourceReceiptSha256)
      || !users || users.file !== basename(users.file) || !hex(users.sha256) || !Number.isSafeInteger(users.rows)
      || users.rows !== manifest.domains?.users?.ready) fail();
    const userPath = checkedPath(resolve(dirname(path), users.file), root); if (await fileHash(userPath) !== users.sha256) fail();
    const selected = new Map();
    for await (const row of readSourceRows(userPath)) {
      if (!/^[1-9][0-9]{0,23}$/.test(row.sourceId ?? "") || !hex(row.sourceDigest) || selected.has(row.sourceId)
        || row.userId !== `user_${sha(JSON.stringify(["legacy-owner", "legacy_mysql_restore", "la_user", row.sourceId])).slice(0, 40)}`) fail();
      selected.set(row.sourceId, row.sourceDigest);
    }
    if (selected.size !== users.rows) fail();
    const token = Object.freeze({ kind: "BOUND_LEGACY_BANK_SELECTION" });
    selections.set(token, { selected, sourceReceiptSha256: manifest.sourceReceiptSha256, datasetSha256: manifestSha256 });
    return token;
  } catch { return fail(); }
}
export function useBoundLegacyBankSelection(token) { const value = selections.get(token); if (!value) fail(); return value; }
export function releaseBoundLegacyBankSelection(token) { selections.delete(token); }
